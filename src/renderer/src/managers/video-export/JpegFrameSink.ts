import { ExportLogger } from './ExportLogger'
import { AsyncFrameCapturer } from './AsyncFrameCapturer'

/**
 * fast 导出模式的兜底帧接收器：当 WebCodecs 不可用时使用。
 *
 * 优先走宿主 `image2pipe`（`electron:frames-stream-start/chunk/finish`）流式编码：
 * 页内双缓冲快照 + 异步 JPEG 编码直接通过管道喂入 FFmpeg，零磁盘帧文件与零二次扫描；
 * 若宿主不支持流式管道，则回退逐帧写入临时帧目录再由 `encodeFramesToVideo` 合成。
 */
export class JpegFrameSink {
  private readonly logger = new ExportLogger('JpegFrameSink')
  private readonly capturer: AsyncFrameCapturer
  private readonly framesDir: string
  private readonly width: number
  private readonly height: number
  private readonly fps: number
  private readonly crf: number
  private frameCount = 0
  private pipeSessionId: string | null = null
  private pipeVideoPath: string | null = null
  private finishedPipeVideoPath: string | null = null

  constructor(opts: {
    width: number
    height: number
    quality: number
    framesDir: string
    fps?: number
    crf?: number
  }) {
    this.framesDir = opts.framesDir
    this.width = opts.width
    this.height = opts.height
    this.fps = opts.fps ?? 30
    this.crf = opts.crf ?? 23
    this.capturer = new AsyncFrameCapturer(this.logger, {
      width: opts.width,
      height: opts.height,
      quality: opts.quality,
      batchSize: 60,
      framesDir: opts.framesDir,
      maxQueueSize: 120,
      maxInFlight: 3
    })
  }

  get isPipeMode(): boolean {
    return Boolean(this.pipeSessionId || this.finishedPipeVideoPath)
  }

  async initialize(canvas: HTMLCanvasElement): Promise<void> {
    await this.capturer.initialize(canvas)

    try {
      const started = (await window.electron?.ipcRenderer?.invoke?.(
        'electron:frames-stream-start',
        {
          fps: this.fps,
          width: this.width,
          height: this.height,
          inputWidth: this.width,
          inputHeight: this.height,
          crf: this.crf
        }
      )) as { id?: string; videoPath?: string } | undefined

      if (started?.id && started.videoPath) {
        const sessionId = started.id
        this.pipeSessionId = sessionId
        this.pipeVideoPath = started.videoPath
        this.capturer.setFrameHandler(async (_index, data) => {
          await window.electron.ipcRenderer.invoke('electron:frames-stream-chunk', {
            id: sessionId,
            data
          })
        })
        this.logger.info(`JPEG pipe stream started: id=${sessionId} → ${started.videoPath}`)
      }
    } catch (error) {
      this.logger.warn('JPEG pipe stream unavailable, falling back to disk frame batches:', error)
      this.pipeSessionId = null
      this.pipeVideoPath = null
    }
  }

  async captureFrame(canvas: HTMLCanvasElement): Promise<void> {
    await this.capturer.captureFrameAsync(canvas)
    this.frameCount++
  }

  /** 等待全部帧发送/写盘，返回管道 MP4 路径（pipe 模式）或帧目录路径（磁盘回退） */
  async finish(): Promise<string> {
    await this.capturer.flushAll()

    if (this.pipeSessionId) {
      const sessionId = this.pipeSessionId
      const result = (await window.electron.ipcRenderer.invoke('electron:frames-stream-finish', {
        id: sessionId
      })) as { videoPath?: string } | undefined
      const videoPath = result?.videoPath || this.pipeVideoPath!
      this.pipeSessionId = null
      this.finishedPipeVideoPath = videoPath
      this.logger.info(`JPEG pipe finished: ${this.frameCount} frames → ${videoPath}`)
      return videoPath
    }

    this.logger.info(`JPEG frames finished: ${this.frameCount} frames → ${this.framesDir}`)
    return this.framesDir
  }

  get frames(): number {
    return this.frameCount
  }

  async dispose(): Promise<void> {
    await this.capturer.dispose()
    if (this.pipeSessionId) {
      const id = this.pipeSessionId
      this.pipeSessionId = null
      await window.electron?.ipcRenderer
        ?.invoke?.('electron:frames-stream-cancel', { id })
        ?.catch(() => {})
    }
  }
}
