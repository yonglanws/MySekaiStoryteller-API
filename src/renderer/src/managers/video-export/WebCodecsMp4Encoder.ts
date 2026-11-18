import { Muxer, StreamTarget } from 'mp4-muxer'
import { ExportLogger } from './ExportLogger'

const DEFAULT_MAX_PROBE_MS = 150
const PROBE_FRAME_COUNT = 5
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
  /** 画布尺寸 ≠ 编码尺寸时的 GPU 缩放中间画布 */
  private scaleCanvas: OffscreenCanvas | null = null
  private scaleCtx: OffscreenCanvasRenderingContext2D | null = null
  private dequeueWaiter: (() => void) | null = null

  constructor(opts: {
    width: number
    height: number
    fps: number
    bitrate: number
    encoderConfig?: VideoEncoderConfig | null
  }) {
    this.width = opts.width
    this.height = opts.height
    this.fps = opts.fps
    this.bitrate = opts.bitrate
    this.preProbedConfig = opts.encoderConfig ?? null
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
      const t0 = performance.now()
      for (let i = 0; i < PROBE_FRAME_COUNT; i++) {
        if (surface.ctx) {
          surface.ctx.fillStyle = `rgb(${i * 40}, 64, 128)`
          surface.ctx.fillRect(0, 0, width, height)
        }
        const vf = new VideoFrame(surface.canvas, {
          timestamp: Math.round((i * 1_000_000) / fps)
        })
        try {
          encoder.encode(vf, { keyFrame: i === 0 })
        } finally {
          vf.close()
        }
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

    const codecs = ['avc1.640028', 'avc1.4d4028', 'avc1.42e028', 'avc1.42001f']
    const hwModes: HardwareAcceleration[] =
      mode === 'webcodecs' ? ['prefer-hardware', 'no-preference'] : ['prefer-hardware']
    const shouldBenchmark = opts.benchmark ?? mode === 'auto'
    const maxProbeMs = opts.maxProbeMs ?? DEFAULT_MAX_PROBE_MS

    for (const hw of hwModes) {
      for (const codec of codecs) {
        const config: VideoEncoderConfig = {
          codec,
          width: opts.width,
          height: opts.height,
          bitrate: opts.bitrate,
          framerate: opts.fps,
          hardwareAcceleration: hw,
          latencyMode: hw === 'prefer-hardware' ? 'quality' : 'realtime',
          avc: { format: 'avc' }
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

    const config =
      this.preProbedConfig ??
      (await WebCodecsMp4Encoder.resolveConfig(this.width, this.height, this.fps, this.bitrate))
    if (!config) {
      throw new Error('WebCodecs H.264 encoding not supported in this browser')
    }
    this.logger.info(
      `WebCodecs encoder config: codec=${config.codec}, hw=${config.hardwareAcceleration}, bitrate=${this.bitrate}`
    )

    // 先建空文件（append-to-file 不存在时自动创建），
    // positioned write 需要 r+ 打开已存在的文件
    await window.electron.ipcRenderer.invoke('electron:append-to-file', {
      filePath: this.filePath,
      data: new Uint8Array(0)
    })

    this.muxer = new Muxer({
      target: new StreamTarget({
        onData: (data: Uint8Array, position: number) => {
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
        codec: 'avc',
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
  }

  private wakeDequeueWaiter(): void {
    const waiter = this.dequeueWaiter
    if (waiter) {
      this.dequeueWaiter = null
      waiter()
    }
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

    // 背压：编码队列积压时等待 dequeue，出错或 dispose 时立即唤醒以免帧泵卡死
    while (this.encoder && !this.isDisposed && this.encoder.encodeQueueSize > 8) {
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
      duration: durationUs
    })
    try {
      this.encoder.encode(frame, { keyFrame })
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

    await this.encoder.flush()
    if (this.encodeError) throw this.encodeError
    this.encoder.close()
    this.encoder = null

    this.muxer.finalize()
    this.muxer = null

    await this.writeChain
    if (this.encodeError) throw this.encodeError
    if (this.filePath) {
      await window.electron.ipcRenderer
        .invoke('electron:close-file-handle', { filePath: this.filePath })
        .catch(() => {})
    }

    this.logger.info(`WebCodecs encode finished: ${this.frameCount} frames → ${this.filePath}`)
    return this.filePath
  }

  get frames(): number {
    return this.frameCount
  }

  dispose(): void {
    this.isDisposed = true
    this.wakeDequeueWaiter()
    try {
      this.encoder?.close()
    } catch {
      /* already closed */
    }
    this.encoder = null
    this.muxer = null
    if (this.filePath) {
      void window.electron?.ipcRenderer
        ?.invoke?.('electron:close-file-handle', { filePath: this.filePath })
        ?.catch?.(() => {})
    }
  }
}
