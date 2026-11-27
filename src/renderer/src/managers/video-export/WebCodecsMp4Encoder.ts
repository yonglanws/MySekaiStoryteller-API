import { Muxer, StreamTarget } from 'mp4-muxer'
import { ExportLogger } from './ExportLogger'
import { GpuYuv420Converter } from './GpuYuv420Converter'

const DEFAULT_MAX_PROBE_MS = 150
const PROBE_WARMUP_FRAMES = 2
const PROBE_FRAME_COUNT = 5
const BINARY_WS_HIGH_WATER_BYTES = 32 * 1024 * 1024
const BINARY_WS_LOW_WATER_BYTES = 16 * 1024 * 1024
const VALID_COLOR_PRIMARIES = new Set<VideoColorPrimaries>(['bt709', 'bt470bg', 'smpte170m'])
const VALID_COLOR_TRANSFER = new Set<VideoTransferCharacteristics>([
  'bt709',
  'smpte170m',
  'iec61966-2-1'
])
const VALID_COLOR_MATRIX = new Set<VideoMatrixCoefficients>(['bt709', 'bt470bg', 'smpte170m'])

export interface WebCodecsProbeOptions {
  width: number
  height: number
  fps: number
  bitrate: number
  codec?: 'h264' | 'hevc'
  mode?: 'auto' | 'webcodecs'
  canvas?: HTMLCanvasElement | null
  glRenderer?: string
  isLinux?: boolean
  hasGpu?: boolean
  gpuRenderer?: 'auto' | 'nvidia' | 'amd' | 'intel' | 'cpu'
  /** 是否执行 5 帧真实编码测速探测（默认仅 auto 开启） */
  benchmark?: boolean
  maxProbeMs?: number
}

export interface WebCodecsProbeResult {
  config: VideoEncoderConfig
  glRenderer: string
  elapsedMs: number
}

/**
 * 统一将解码器上报的 colorSpace 归一化为 mp4-muxer `colr(nclx)` 支持的字段，
 * 缺省或出现未定义/`rgb` 时回落为标准 BT.709，确保 MP4 色彩元数据一致。
 */
export function normalizeDecoderColorSpace(
  colorSpace?: VideoColorSpaceInit | null
): VideoColorSpaceInit {
  const cs = colorSpace ?? {}
  return {
    primaries: cs.primaries && VALID_COLOR_PRIMARIES.has(cs.primaries) ? cs.primaries : 'bt709',
    transfer: cs.transfer && VALID_COLOR_TRANSFER.has(cs.transfer) ? cs.transfer : 'bt709',
    matrix: cs.matrix && VALID_COLOR_MATRIX.has(cs.matrix) ? cs.matrix : 'bt709',
    fullRange: typeof cs.fullRange === 'boolean' ? cs.fullRange : false
  }
}

/**
 * fast 导出模式的页内视频编码器。
 *
 * 用 WebCodecs VideoEncoder 把虚拟时钟帧泵送来的画布帧直接编码为 H.264，
 * 经 mp4-muxer 的 StreamTarget 以「定位写」方式流式落盘为 MP4
 * （通过 bridge 通道 electron:write-file-at 写到宿主临时文件）。
 */
export class WebCodecsMp4Encoder {
  private readonly logger = new ExportLogger('WebCodecsMp4Encoder')
  /** 编码（=画布）尺寸；VideoFrame(canvas) 直接构造时帧尺寸即画布尺寸 */
  private readonly width: number
  private readonly height: number
  private readonly fps: number
  private readonly bitrate: number
  private readonly keyframeIntervalFrames: number
  private preProbedConfig: VideoEncoderConfig | null

  private encoder: VideoEncoder | null = null
  private muxer: Muxer<StreamTarget> | null = null
  private filePath: string = ''
  private frameCount = 0
  private encodeError: Error | null = null
  private isDisposed = false
  /** 串行化落盘写，保证 positioned write 顺序 */
  private writeChain: Promise<unknown> = Promise.resolve()
  private codecDescription: Uint8Array | null = null
  /** 编码器实际上报的色彩空间（未归一化），决定收尾是否需要重编码到 BT.709/tv */
  private observedColorSpace: VideoColorSpaceInit | null = null
  /** 画布尺寸 ≠ 编码尺寸时的 GPU 缩放中间画布 */
  private scaleCanvas: OffscreenCanvas | null = null
  private scaleCtx: OffscreenCanvasRenderingContext2D | null = null
  private yuvConverter: GpuYuv420Converter | null = null
  private readonly useGpuYuvReadback: boolean
  private pendingPboMeta: Array<{ timestampUs: number; durationUs: number; keyFrame: boolean }> = []
  private pboReusePool: Uint8Array[] = []
  private lastCompletedYuv: Uint8Array | null = null
  private activeMuxerCodec: 'avc' | 'hevc' = 'avc'
  private totalWrittenBytes = 0
  private dequeueWaiter: (() => void) | null = null
  private binWs: WebSocket | null = null
  private usingBinaryWs = false
  private binWsClosingIntentionally = false
  private lastWsBackpressureWarnAtMs = 0
  private binStreamId = 1
  private binCtrlResolvers: Array<(msg: { ok?: boolean; error?: string; op?: string }) => void> = []

  constructor(opts: {
    width: number
    height: number
    fps: number
    bitrate: number
    encoderConfig?: VideoEncoderConfig | null
    /**
     * 默认 true（通过 3-slot 异步 WebGL2 PBO 环在 GPU 上直接转成 BT.709 limited-range I420，
     * 不阻塞渲染管线，并让宿主可直接走 `-c:v copy` + BT.709 VUI 标签收尾，消除 135s 二次重编码）。
     * 传 false 时强制走零拷贝 `new VideoFrame(canvas)`（由宿主重编码修正色彩空间）。
     */
    useGpuYuvReadback?: boolean
  }) {
    this.width = opts.width
    this.height = opts.height
    this.fps = opts.fps
    this.bitrate = opts.bitrate
    this.keyframeIntervalFrames = Math.max(1, Math.round(opts.fps * 2))
    this.preProbedConfig = opts.encoderConfig ?? null
    this.useGpuYuvReadback = opts.useGpuYuvReadback !== false
  }

  /** 读取当前 WebGL 渲染器字符串；读取失败返回空字符串 */
  static detectGlRenderer(canvas?: HTMLCanvasElement | null): string {
    try {
      const target =
        canvas ??
        (typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(1, 1)
          : typeof document !== 'undefined'
            ? Object.assign(document.createElement('canvas'), { width: 1, height: 1 })
            : null)
      if (!target) return ''
      const gl =
        (target.getContext('webgl2', {
          preserveDrawingBuffer: true
        }) as WebGL2RenderingContext | null) ||
        (target.getContext('webgl', {
          preserveDrawingBuffer: true
        }) as WebGLRenderingContext | null)
      if (!gl) return ''
      const dbg = gl.getExtension('WEBGL_debug_renderer_info')
      return dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : ''
    } catch {
      return ''
    }
  }

  /** 创建 5 帧测速用的轻量画布 */
  private static createProbeSurface(
    width: number,
    height: number
  ): {
    canvas: CanvasImageSource
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  } | null {
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      const canvas = Object.assign(document.createElement('canvas'), { width, height })
      return { canvas, ctx: canvas.getContext('2d', { alpha: false }) }
    }
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(width, height)
      return { canvas, ctx: canvas.getContext('2d', { alpha: false }) }
    }
    return null
  }

  private static async benchmarkConfig(
    config: VideoEncoderConfig,
    width: number,
    height: number,
    fps: number
  ): Promise<{ ok: boolean; elapsedMs: number }> {
    const surface = WebCodecsMp4Encoder.createProbeSurface(width, height)
    if (!surface) {
      return { ok: true, elapsedMs: 0 }
    }

    let chunks = 0
    let err: unknown = null
    const encoder = new VideoEncoder({
      output: () => {
        chunks++
      },
      error: (e) => {
        err = e
      }
    })
    try {
      encoder.configure(config)
      const encodeSyntheticFrame = (frameIndex: number, keyFrame: boolean): void => {
        if (surface.ctx) {
          surface.ctx.fillStyle = `rgb(${(frameIndex * 40) % 256}, 64, 128)`
          surface.ctx.fillRect(0, 0, width, height)
        }
        const vf = new VideoFrame(surface.canvas, {
          timestamp: Math.round((frameIndex * 1_000_000) / fps)
        })
        try {
          encoder.encode(vf, { keyFrame })
        } finally {
          vf.close()
        }
      }

      // 预热帧 + flush 吸收 D3D11/QSV 硬件编码器冷启动（约 180–230ms），
      // 仅对稳态 5 帧编码测速，避免将一次性初始化误判为软编而回落 frames-stream。
      for (let i = 0; i < PROBE_WARMUP_FRAMES; i++) {
        encodeSyntheticFrame(i, i === 0)
      }
      await encoder.flush()
      if (err || chunks < PROBE_WARMUP_FRAMES) {
        return { ok: false, elapsedMs: 0 }
      }

      chunks = 0
      const t0 = performance.now()
      for (let i = 0; i < PROBE_FRAME_COUNT; i++) {
        encodeSyntheticFrame(PROBE_WARMUP_FRAMES + i, i === 0)
      }
      await encoder.flush()
      const elapsedMs = performance.now() - t0
      return { ok: !err && chunks >= PROBE_FRAME_COUNT, elapsedMs }
    } finally {
      try {
        encoder.close()
      } catch {
        /* already closed */
      }
    }
  }

  /**
   * 探测并验证可用且满足速度阈值的 WebCodecs H.264 编码配置（对齐 ournotes-player）：
   * - 在 `auto` 模式下拒绝 SwiftShader / llvmpipe / softpipe 等软件 WebGL、CPU 渲染或 Linux+NVIDIA 软编路径；
   * - 优先严格校验 `hardwareAcceleration === 'prefer-hardware'`；
   * - 对候选配置执行 5 帧合成帧编码测速，`auto` 下超过 150ms 自动回落到宿主 frames 管道。
   */
  static async probeConfig(opts: WebCodecsProbeOptions): Promise<WebCodecsProbeResult | null> {
    if (
      typeof VideoEncoder !== 'function' ||
      typeof VideoFrame !== 'function' ||
      !VideoEncoder.isConfigSupported
    ) {
      return null
    }

    const mode = opts.mode ?? 'auto'
    const glRenderer = opts.glRenderer ?? WebCodecsMp4Encoder.detectGlRenderer(opts.canvas)
    const ua =
      typeof navigator !== 'undefined'
        ? `${navigator.platform || ''} ${navigator.userAgent || ''}`
        : ''
    const isLinux = opts.isLinux ?? (/linux/i.test(ua) && !/android/i.test(ua))
    const isSoftwareGl = /swiftshader|llvmpipe|softpipe/i.test(glRenderer)
    const isNvidia = /nvidia|geforce|quadro/i.test(glRenderer)

    if (mode === 'auto') {
      if (opts.gpuRenderer === 'cpu' || isSoftwareGl) {
        return null
      }
      if (isLinux && (opts.hasGpu === false || isNvidia)) {
        return null
      }
    }

    const avcCodecs = ['avc1.640028', 'avc1.4d4028', 'avc1.42e028', 'avc1.42001f']
    const hevcCodecs = [
      'hvc1.1.6.L123.B0',
      'hev1.1.6.L123.B0',
      'hvc1.1.6.L120.90',
      'hev1.1.6.L120.90'
    ]
    const codecs = opts.codec === 'hevc' ? [...hevcCodecs, ...avcCodecs] : avcCodecs
    const hwModes: HardwareAcceleration[] =
      mode === 'webcodecs' ? ['prefer-hardware', 'no-preference'] : ['prefer-hardware']
    const shouldBenchmark = opts.benchmark ?? mode === 'auto'
    const maxProbeMs = opts.maxProbeMs ?? DEFAULT_MAX_PROBE_MS

    for (const hw of hwModes) {
      for (const codec of codecs) {
        const isHevc = codec.startsWith('hvc1') || codec.startsWith('hev1')
        const config: VideoEncoderConfig = {
          codec,
          width: opts.width,
          height: opts.height,
          bitrate: opts.bitrate,
          bitrateMode: 'variable',
          framerate: opts.fps,
          hardwareAcceleration: hw,
          // realtime 模式禁用硬件编码器多帧前瞻/B 帧队列，避免在同卡 D3D11 上阻塞 WebGL 渲染管线
          latencyMode: 'realtime',
          ...(isHevc ? { hevc: { format: 'hevc' } } : { avc: { format: 'avc' } })
        }
        try {
          const support = await VideoEncoder.isConfigSupported(config)
          if (!support?.supported) continue
          if (
            hw === 'prefer-hardware' &&
            support.config?.hardwareAcceleration !== 'prefer-hardware'
          ) {
            continue
          }

          if (shouldBenchmark) {
            const probe = await WebCodecsMp4Encoder.benchmarkConfig(
              config,
              opts.width,
              opts.height,
              opts.fps
            )
            if (!probe.ok) continue
            if (mode === 'auto' && probe.elapsedMs > maxProbeMs) {
              return null
            }
            return { config, glRenderer, elapsedMs: probe.elapsedMs }
          }

          return { config, glRenderer, elapsedMs: 0 }
        } catch {
          continue
        }
      }
    }

    return null
  }

  /** 兼容旧调用的简化探测入口 */
  static async resolveConfig(
    width: number,
    height: number,
    fps: number,
    bitrate: number
  ): Promise<VideoEncoderConfig | null> {
    const res = await WebCodecsMp4Encoder.probeConfig({
      width,
      height,
      fps,
      bitrate,
      mode: 'webcodecs',
      benchmark: false
    })
    return res?.config ?? null
  }

  /**
   * 初始化：创建临时输出文件、配置 muxer 与 encoder。
   * @param filePath 宿主侧临时 mp4 路径（由调用方经 electron:get-temp-base-dir 生成）
   */
  async initialize(filePath: string): Promise<void> {
    this.filePath = filePath
    this.isDisposed = false
    this.encodeError = null
    this.observedColorSpace = null

    const config =
      this.preProbedConfig ??
      (await WebCodecsMp4Encoder.resolveConfig(this.width, this.height, this.fps, this.bitrate))
    if (!config) {
      throw new Error('WebCodecs H.264 encoding not supported in this browser')
    }
    this.logger.info(
      `WebCodecs encoder config: codec=${config.codec}, hw=${config.hardwareAcceleration}, bitrate=${this.bitrate}, keyframeInterval=${this.keyframeIntervalFrames}`
    )
    this.activeMuxerCodec =
      config.codec.startsWith('hvc1') || config.codec.startsWith('hev1') ? 'hevc' : 'avc'
    this.pendingPboMeta = []
    this.pboReusePool = []
    this.lastCompletedYuv = null
    this.totalWrittenBytes = 0

    // 优先连接原生 Rust / Node 二进制 WebSocket 流通道，消除 HTTP positioned write 序列化开销；
    // 在无 HTTP 环境（单元测试或降级时）透明回退到 electron:append-to-file / write-file-at。
    const wsConnected = await this.tryOpenBinaryStream(this.filePath)
    this.usingBinaryWs = wsConnected
    if (!wsConnected) {
      // 先建空文件（append-to-file 不存在时自动创建），
      // positioned write 需要 r+ 打开已存在的文件
      await window.electron.ipcRenderer.invoke('electron:append-to-file', {
        filePath: this.filePath,
        data: new Uint8Array(0)
      })
    }

    this.muxer = new Muxer({
      target: new StreamTarget({
        onData: (data: Uint8Array, position: number) => {
          this.totalWrittenBytes = Math.max(this.totalWrittenBytes, position + data.byteLength)
          if (this.usingBinaryWs) {
            const ws = this.binWs
            if (!ws || ws.readyState !== WebSocket.OPEN) {
              this.encodeError =
                this.encodeError ?? new Error('Binary WS closed unexpectedly during export')
              this.wakeDequeueWaiter()
              return
            }
            try {
              const buffered = typeof ws.bufferedAmount === 'number' ? ws.bufferedAmount : 0
              if (buffered > BINARY_WS_HIGH_WATER_BYTES) {
                const now = Date.now()
                if (now - this.lastWsBackpressureWarnAtMs >= 5000) {
                  this.lastWsBackpressureWarnAtMs = now
                  this.logger.warn(
                    `Binary WS bufferedAmount high (${(buffered / (1024 * 1024)).toFixed(1)} MB), pacing encoder`
                  )
                }
              }
              const pkt = new Uint8Array(16 + data.byteLength)
              const dv = new DataView(pkt.buffer)
              dv.setUint32(0, this.binStreamId, true)
              dv.setUint8(4, 1) // KIND_WRITE_FILE_AT
              dv.setUint8(5, 0)
              dv.setUint16(6, 0, true)
              dv.setBigUint64(8, BigInt(position), true)
              pkt.set(data, 16)
              ws.send(pkt)
              return
            } catch (err) {
              const wrapped = err instanceof Error ? err : new Error(String(err))
              this.encodeError = this.encodeError ?? wrapped
              this.wakeDequeueWaiter()
              return
            }
          }
          const copy = new Uint8Array(data)
          this.writeChain = this.writeChain
            .then(() =>
              window.electron.ipcRenderer.invoke('electron:write-file-at', {
                filePath: this.filePath,
                position,
                data: copy
              })
            )
            .catch((err) => {
              const wrapped = err instanceof Error ? err : new Error(String(err))
              this.encodeError = this.encodeError ?? wrapped
              this.wakeDequeueWaiter()
            })
        },
        chunked: true,
        chunkSize: 16 * 1024 * 1024
      }),
      video: {
        codec: this.activeMuxerCodec,
        width: this.width,
        height: this.height
      },
      // 定位写允许 muxer 回写头部 box，无需整片驻留内存
      fastStart: false,
      firstTimestampBehavior: 'offset'
    })

    this.encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        try {
          if (metadata?.decoderConfig?.colorSpace && !this.observedColorSpace) {
            this.observedColorSpace = { ...metadata.decoderConfig.colorSpace }
          }
          if (metadata?.decoderConfig?.description && !this.codecDescription) {
            const desc = metadata.decoderConfig.description
            this.codecDescription =
              desc instanceof ArrayBuffer
                ? new Uint8Array(desc)
                : new Uint8Array(
                    (desc as ArrayBufferView).buffer,
                    (desc as ArrayBufferView).byteOffset,
                    (desc as ArrayBufferView).byteLength
                  )
          }
          const normalizedMetadata: EncodedVideoChunkMetadata | undefined = metadata
            ? {
                ...metadata,
                ...(metadata.decoderConfig
                  ? {
                      decoderConfig: {
                        ...metadata.decoderConfig,
                        colorSpace: normalizeDecoderColorSpace(metadata.decoderConfig.colorSpace)
                      }
                    }
                  : {})
              }
            : undefined
          this.muxer?.addVideoChunk(chunk, normalizedMetadata)
        } catch (e) {
          this.encodeError = e instanceof Error ? e : new Error(String(e))
          this.wakeDequeueWaiter()
        }
      },
      error: (e) => {
        this.encodeError = e instanceof Error ? e : new Error(String(e))
        this.wakeDequeueWaiter()
      }
    })
    this.encoder.configure(config)
    // 使用 3-slot 异步 PBO 环在 GPU 上完成 RGBA -> BT.709 limited-range I420 转换：
    // 消除同步 gl.readPixels 停顿，且宿主可直接 `-c:v copy` + BT.709 VUI 标签收尾（~1-3s）。
    if (this.useGpuYuvReadback) {
      this.yuvConverter = GpuYuv420Converter.create(this.width, this.height, 3)
    }
  }

  private async tryOpenBinaryStream(filePath: string): Promise<boolean> {
    if (
      typeof window === 'undefined' ||
      typeof WebSocket === 'undefined' ||
      typeof fetch !== 'function' ||
      typeof location === 'undefined' ||
      !location.protocol.startsWith('http')
    ) {
      return false
    }
    try {
      const token = new URLSearchParams(location.search).get('token') || ''
      const headers: Record<string, string> = token ? { 'x-mss-bridge-token': token } : {}
      const infoRes = await fetch('/bridge/binary-stream-endpoint', { headers })
      if (!infoRes.ok) return false
      const info = (await infoRes.json()) as { ok?: boolean; wsUrl?: string }
      if (!info?.ok || !info.wsUrl) return false
      const fullWsUrl = info.wsUrl.startsWith('/')
        ? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${info.wsUrl}`
        : info.wsUrl
      const ws = new WebSocket(fullWsUrl)
      ws.binaryType = 'arraybuffer'
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          ws.removeEventListener('open', onOpen)
          ws.removeEventListener('error', onErr)
          ws.removeEventListener('close', onClose)
        }
        const onOpen = (): void => {
          cleanup()
          resolve()
        }
        const onErr = (): void => {
          cleanup()
          reject(new Error('Binary WS connection error'))
        }
        const onClose = (): void => {
          cleanup()
          reject(new Error('Binary WS closed during handshake'))
        }
        ws.addEventListener('open', onOpen)
        ws.addEventListener('error', onErr)
        ws.addEventListener('close', onClose)
      })

      this.binWsClosingIntentionally = false
      ws.addEventListener('message', (ev) => {
        try {
          const parsed = JSON.parse(String(ev.data)) as {
            ok?: boolean
            error?: string
            op?: string
          }
          if (parsed.op === 'async-error' || (parsed.ok === false && this.binCtrlResolvers.length === 0)) {
            if (!this.isDisposed) {
              this.encodeError =
                this.encodeError ?? new Error(parsed.error || 'Binary WS async write error')
              this.wakeDequeueWaiter()
            }
            return
          }
          const resolver = this.binCtrlResolvers.shift()
          resolver?.(parsed)
        } catch {
          // ignore malformed ctrl reply
        }
      })
      ws.addEventListener('error', () => {
        if (!this.isDisposed) {
          this.encodeError = this.encodeError ?? new Error('Binary WS transport error')
          this.wakeDequeueWaiter()
        }
      })
      ws.addEventListener('close', () => {
        while (this.binCtrlResolvers.length > 0) {
          const resolver = this.binCtrlResolvers.shift()
          resolver?.({ ok: false, error: 'Binary WS closed unexpectedly' })
        }
        if (!this.isDisposed && !this.binWsClosingIntentionally) {
          this.encodeError =
            this.encodeError ?? new Error('Binary WS closed unexpectedly during export')
          this.wakeDequeueWaiter()
        }
      })
      this.binWs = ws
      const ack = await this.sendBinaryControl({
        op: 'open-file',
        streamId: this.binStreamId,
        path: filePath,
        truncate: true
      })
      if (!ack?.ok) {
        this.closeBinaryWs()
        return false
      }
      return true
    } catch {
      this.closeBinaryWs()
      return false
    }
  }

  private sendBinaryControl(
    payload: Record<string, unknown>
  ): Promise<{ ok?: boolean; error?: string; op?: string }> {
    const ws = this.binWs
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ ok: false, error: 'Binary WS not open' })
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.binCtrlResolvers.indexOf(done)
        if (idx >= 0) this.binCtrlResolvers.splice(idx, 1)
        resolve({ ok: false, error: 'Binary WS control ack timeout' })
      }, 15_000)
      const done = (msg: { ok?: boolean; error?: string; op?: string }): void => {
        clearTimeout(timer)
        resolve(msg)
      }
      this.binCtrlResolvers.push(done)
      ws.send(JSON.stringify(payload))
    })
  }

  private closeBinaryWs(): void {
    const ws = this.binWs
    this.binWs = null
    this.binWsClosingIntentionally = true
    while (this.binCtrlResolvers.length > 0) {
      const resolver = this.binCtrlResolvers.shift()
      resolver?.({ ok: false, error: 'Binary WS closed' })
    }
    if (ws) {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  }

  private wakeDequeueWaiter(): void {
    const waiter = this.dequeueWaiter
    if (waiter) {
      this.dequeueWaiter = null
      waiter()
    }
  }

  private async waitEncodeQueueReady(): Promise<void> {
    if (
      this.usingBinaryWs &&
      this.binWs &&
      this.binWs.readyState === WebSocket.OPEN &&
      typeof this.binWs.bufferedAmount === 'number' &&
      this.binWs.bufferedAmount > BINARY_WS_HIGH_WATER_BYTES
    ) {
      while (
        !this.isDisposed &&
        !this.encodeError &&
        this.binWs &&
        this.binWs.readyState === WebSocket.OPEN &&
        this.binWs.bufferedAmount > BINARY_WS_LOW_WATER_BYTES
      ) {
        await new Promise((resolve) => setTimeout(resolve, 8))
      }
      if (this.encodeError) throw this.encodeError
    }
    const queueLimit = this.useGpuYuvReadback ? 8 : 11
    while (this.encoder && !this.isDisposed && this.encoder.encodeQueueSize > queueLimit) {
      const encoder = this.encoder
      await new Promise<void>((resolve) => {
        const cleanup = (): void => {
          if (this.dequeueWaiter === cleanup) {
            this.dequeueWaiter = null
          }
          encoder.removeEventListener('dequeue', cleanup)
          resolve()
        }
        this.dequeueWaiter = cleanup
        encoder.addEventListener('dequeue', cleanup)
      })
      if (this.encodeError) throw this.encodeError
      if (this.isDisposed || !this.encoder)
        throw new Error('Encoder disposed during backpressure wait')
    }
  }

  /** 周期性插入 IDR 关键帧（默认每 2 秒 = fps*2 帧），让硬件编码器在长淡入淡出后及时刷新量化。 */
  private resolveKeyFrame(requestedKeyFrame: boolean): boolean {
    if (requestedKeyFrame || this.frameCount === 0) return true
    return this.frameCount % this.keyframeIntervalFrames === 0
  }

  private async encodeI420Buffer(
    yuvBytes: Uint8Array,
    timestampUs: number,
    durationUs: number,
    keyFrame: boolean
  ): Promise<void> {
    if (this.encodeError) throw this.encodeError
    if (this.isDisposed || !this.encoder) throw new Error('Encoder not initialized')
    await this.waitEncodeQueueReady()
    const frame = new VideoFrame(yuvBytes, {
      format: 'I420',
      codedWidth: this.width,
      codedHeight: this.height,
      timestamp: timestampUs,
      duration: durationUs,
      colorSpace: {
        primaries: 'bt709',
        transfer: 'bt709',
        matrix: 'bt709',
        fullRange: false
      }
    })
    try {
      this.encoder.encode(frame, { keyFrame: this.resolveKeyFrame(keyFrame) })
      this.frameCount++
    } finally {
      frame.close()
    }
    if (this.encodeError) throw this.encodeError
  }

  private retainCompletedYuv(yuvBytes: Uint8Array): void {
    const expectedLen = this.yuvConverter?.frameByteLength ?? 0
    if (expectedLen === 0 || yuvBytes.byteLength !== expectedLen) return
    if (this.lastCompletedYuv && this.lastCompletedYuv !== yuvBytes) {
      this.pboReusePool.push(this.lastCompletedYuv)
    }
    this.lastCompletedYuv = yuvBytes
  }

  private async drainPendingYuv(): Promise<void> {
    if (!this.yuvConverter || typeof this.yuvConverter.drainAllAsync !== 'function') return
    const frameLen = this.yuvConverter.frameByteLength
    const remaining = await this.yuvConverter.drainAllAsync(
      () => this.pboReusePool.pop() ?? new Uint8Array(frameLen)
    )
    for (const yuvBytes of remaining) {
      const meta = this.pendingPboMeta.shift()
      if (meta) {
        await this.encodeI420Buffer(yuvBytes, meta.timestampUs, meta.durationUs, meta.keyFrame)
      }
      this.retainCompletedYuv(yuvBytes)
    }
  }

  /**
   * 重复编码上一帧已转换的 BT.709 I420 缓冲，维持严格的固定帧率（CFR）时间轴
   * 同时跳过 Pixi 渲染与 GPU 回读。无可用缓冲时返回 false 交由调用方常规渲染。
   */
  async repeatLastFrame(
    timestampUs: number,
    durationUs: number,
    keyFrame: boolean
  ): Promise<boolean> {
    if (this.encodeError) throw this.encodeError
    if (this.isDisposed || !this.encoder || !this.yuvConverter) return false
    if (this.pendingPboMeta.length > 0) {
      await this.drainPendingYuv()
    }
    if (!this.lastCompletedYuv) return false
    await this.encodeI420Buffer(this.lastCompletedYuv, timestampUs, durationUs, keyFrame)
    return true
  }

  /**
   * 编码一帧。
   * @param source 画布（HTMLCanvasElement）
   * @param timestampUs 虚拟时间戳（微秒）
   * @param durationUs 帧时长（微秒）
   * @param keyFrame 是否强制关键帧
   */
  async encodeFrame(
    source: CanvasImageSource,
    timestampUs: number,
    durationUs: number,
    keyFrame: boolean
  ): Promise<void> {
    if (this.encodeError) throw this.encodeError
    if (this.isDisposed || !this.encoder) throw new Error('Encoder not initialized')

    if (this.yuvConverter) {
      if (typeof this.yuvConverter.enqueueAsync === 'function') {
        this.pendingPboMeta.push({ timestampUs, durationUs, keyFrame })
        const recycle = this.pboReusePool.pop()
        const completed = await this.yuvConverter.enqueueAsync(source as TexImageSource, recycle)
        if (completed) {
          const meta = this.pendingPboMeta.shift()
          if (meta) {
            await this.encodeI420Buffer(completed, meta.timestampUs, meta.durationUs, meta.keyFrame)
          }
          this.retainCompletedYuv(completed)
        }
        return
      }
      const yuvBytes = this.yuvConverter.convertSync(source as TexImageSource)
      await this.encodeI420Buffer(yuvBytes, timestampUs, durationUs, keyFrame)
      return
    }

    await this.waitEncodeQueueReady()
    // 源尺寸 ≠ 编码尺寸（renderScale 超采样）时，经 OffscreenCanvas
    // 做一次 GPU 缩放；同尺寸则零拷贝直接构造 VideoFrame。
    let frameSource = source as CanvasImageSource
    const srcW = (source as { width?: number }).width ?? this.width
    const srcH = (source as { height?: number }).height ?? this.height
    if (srcW !== this.width || srcH !== this.height) {
      if (!this.scaleCanvas) {
        this.scaleCanvas = new OffscreenCanvas(this.width, this.height)
        this.scaleCtx = this.scaleCanvas.getContext('2d')
      }
      if (this.scaleCtx) {
        this.scaleCtx.drawImage(source as CanvasImageSource, 0, 0, this.width, this.height)
        frameSource = this.scaleCanvas
      }
    }

    const frame = new VideoFrame(frameSource, {
      timestamp: timestampUs,
      duration: durationUs,
      alpha: 'discard'
    })
    try {
      this.encoder.encode(frame, { keyFrame: this.resolveKeyFrame(keyFrame) })
      this.frameCount++
    } finally {
      frame.close()
    }
    if (this.encodeError) throw this.encodeError
  }

  /** 冲刷编码器并 finalize muxer，等待全部落盘写完成，返回文件路径 */
  async finish(): Promise<string> {
    if (this.encodeError) throw this.encodeError
    if (!this.encoder || !this.muxer) throw new Error('Encoder not initialized')

    if (this.yuvConverter) {
      await this.drainPendingYuv()
      this.pendingPboMeta = []
      this.pboReusePool = []
      this.lastCompletedYuv = null
      this.yuvConverter.dispose()
      this.yuvConverter = null
    }

    await this.encoder.flush()
    if (this.encodeError) throw this.encodeError
    this.encoder.close()
    this.encoder = null

    this.muxer.finalize()
    this.muxer = null

    await this.writeChain
    if (this.binWs) {
      const closed = await this.sendBinaryControl({ op: 'close', streamId: this.binStreamId })
      this.closeBinaryWs()
      if (!closed?.ok) {
        throw new Error(closed?.error || 'Binary WS close failed')
      }
    } else if (this.usingBinaryWs) {
      throw this.encodeError ?? new Error('Binary WS closed unexpectedly before finish')
    } else if (this.filePath) {
      await window.electron.ipcRenderer
        .invoke('electron:close-file-handle', { filePath: this.filePath })
        .catch(() => {})
    }
    if (this.encodeError) throw this.encodeError

    this.logger.info(`WebCodecs encode finished: ${this.frameCount} frames → ${this.filePath}`)
    return this.filePath
  }

  get encoderCodecKind(): 'h264' | 'hevc' {
    return this.activeMuxerCodec === 'hevc' ? 'hevc' : 'h264'
  }

  get writtenBytes(): number {
    return this.totalWrittenBytes
  }

  get frames(): number {
    return this.frameCount
  }

  /**
   * 硬编码器输出是否需要收尾重编码到 BT.709 limited range。
   * Chrome 的画布帧通常以 full-range 送入硬件编码器，SPS/VUI 会写 pc + sRGB；
   * 这种流不能用 `-c:v copy` 直接进成片，必须让宿主 ffmpeg 走
   * `scale=out_color_matrix=bt709:out_range=tv` 才能同时修正像素与元数据。
   * 若使用 GpuYuv420Converter 送入 BT.709 limited-range I420，编码器实测保持 tv/bt709，此处返回 false。
   */
  get requiresColorConversion(): boolean {
    const cs = this.observedColorSpace
    if (!cs) return true
    return (
      cs.fullRange !== false ||
      cs.primaries !== 'bt709' ||
      cs.transfer !== 'bt709' ||
      cs.matrix !== 'bt709'
    )
  }

  dispose(): void {
    this.isDisposed = true
    this.wakeDequeueWaiter()
    this.pendingPboMeta = []
    this.pboReusePool = []
    this.lastCompletedYuv = null
    this.yuvConverter?.dispose()
    this.yuvConverter = null
    try {
      this.encoder?.close()
    } catch {
      /* already closed */
    }
    this.encoder = null
    this.muxer = null
    if (this.binWs) {
      if (this.binWs.readyState === WebSocket.OPEN) {
        try {
          this.binWs.send(JSON.stringify({ op: 'abort', streamId: this.binStreamId }))
        } catch {
          /* ignore */
        }
      }
      this.closeBinaryWs()
    } else if (!this.usingBinaryWs && this.filePath) {
      void window.electron?.ipcRenderer
        ?.invoke?.('electron:close-file-handle', { filePath: this.filePath })
        ?.catch?.(() => {})
    }
  }
}
