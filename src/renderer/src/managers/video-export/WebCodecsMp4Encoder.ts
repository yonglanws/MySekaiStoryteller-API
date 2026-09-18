import { Muxer, StreamTarget } from 'mp4-muxer'
import { ExportLogger } from './ExportLogger'

/**
 * fast 导出模式的页内视频编码器。
 *
 * 用 WebCodecs VideoEncoder 把虚拟时钟帧泵送来的画布帧直接编码为 H.264，
 * 经 mp4-muxer 的 StreamTarget 以「定位写」方式流式落盘为 MP4
 * （通过 bridge 通道 electron:write-file-at 写到宿主临时文件）。
 *
 * 与 MediaRecorder 录制路径的差异：
 * - 帧由调用方逐帧喂入（VideoFrame），时间戳精确等于虚拟时间轴；
 * - 输出已是最终 H.264 in MP4，宿主只需 -c:v copy remux，不再二次编码。
 *
 * 可用性探测是逐级降级：high → main → baseline profile，
 * 每级先 prefer-hardware 再 no-preference。
 */
export class WebCodecsMp4Encoder {
  private readonly logger = new ExportLogger('WebCodecsMp4Encoder')
  /** 编码（=画布）尺寸；VideoFrame(canvas) 直接构造时帧尺寸即画布尺寸 */
  private readonly width: number
  private readonly height: number
  private readonly fps: number
  private readonly bitrate: number

  private encoder: VideoEncoder | null = null
  private muxer: Muxer<StreamTarget> | null = null
  private filePath: string = ''
  private frameCount = 0
  private encodeError: Error | null = null
  /** 串行化落盘写，保证 positioned write 顺序 */
  private writeChain: Promise<unknown> = Promise.resolve()
  private codecDescription: Uint8Array | null = null
  /** 画布尺寸 ≠ 编码尺寸时的 GPU 缩放中间画布 */
  private scaleCanvas: OffscreenCanvas | null = null
  private scaleCtx: OffscreenCanvasRenderingContext2D | null = null

  constructor(opts: { width: number; height: number; fps: number; bitrate: number }) {
    this.width = opts.width
    this.height = opts.height
    this.fps = opts.fps
    this.bitrate = opts.bitrate
  }

  /** 探测任一可用 H.264 编码配置；返回 null 表示 WebCodecs 不可用 */
  static async resolveConfig(
    width: number,
    height: number,
    fps: number,
    bitrate: number
  ): Promise<VideoEncoderConfig | null> {
    if (typeof VideoEncoder === 'undefined' || !VideoEncoder.isConfigSupported) {
      return null
    }

    const codecs = ['avc1.640028', 'avc1.4d0028', 'avc1.42001f']
    const hwModes: HardwareAcceleration[] = ['prefer-hardware', 'no-preference']

    for (const codec of codecs) {
      for (const hw of hwModes) {
        const config: VideoEncoderConfig = {
          codec,
          width,
          height,
          bitrate,
          framerate: fps,
          hardwareAcceleration: hw,
          // 导出不看延迟，用 throughput 友好的 realtime 档；
          // 逐帧喂入的时间戳与虚拟时钟对齐，编码器只管快慢
          latencyMode: 'realtime',
          avc: { format: 'avc' }
        }
        try {
          const support = await VideoEncoder.isConfigSupported(config)
          if (support.supported) {
            return config
          }
        } catch {
          continue
        }
      }
    }
    return null
  }

  /**
   * 初始化：创建临时输出文件、配置 muxer 与 encoder。
   * @param filePath 宿主侧临时 mp4 路径（由调用方经 electron:get-temp-base-dir 生成）
   */
  async initialize(filePath: string): Promise<void> {
    this.filePath = filePath

    const config = await WebCodecsMp4Encoder.resolveConfig(
      this.width,
      this.height,
      this.fps,
      this.bitrate
    )
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
          this.writeChain = this.writeChain.then(() =>
            window.electron.ipcRenderer.invoke('electron:write-file-at', {
              filePath: this.filePath,
              position,
              data: copy
            })
          )
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
          this.muxer?.addVideoChunk(chunk, metadata ?? undefined)
        } catch (e) {
          this.encodeError = e instanceof Error ? e : new Error(String(e))
        }
      },
      error: (e) => {
        this.encodeError = e instanceof Error ? e : new Error(String(e))
      }
    })
    this.encoder.configure(config)
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
    if (!this.encoder) throw new Error('Encoder not initialized')

    // 背压：编码队列积压时等待 dequeue，避免 VideoFrame/编码缓冲膨胀
    while (this.encoder.encodeQueueSize > 8) {
      await new Promise<void>((resolve) => {
        const onDequeue = (): void => {
          this.encoder!.removeEventListener('dequeue', onDequeue)
          resolve()
        }
        this.encoder!.addEventListener('dequeue', onDequeue)
      })
      if (this.encodeError) throw this.encodeError
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
    this.encoder.close()
    this.encoder = null

    this.muxer.finalize()
    this.muxer = null

    await this.writeChain

    this.logger.info(`WebCodecs encode finished: ${this.frameCount} frames → ${this.filePath}`)
    return this.filePath
  }

  get frames(): number {
    return this.frameCount
  }

  dispose(): void {
    try {
      this.encoder?.close()
    } catch {
      /* already closed */
    }
    this.encoder = null
    this.muxer = null
  }
}
