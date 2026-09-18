import { ExportLogger } from './ExportLogger'
import { AsyncFrameCapturer } from './AsyncFrameCapturer'

/**
 * fast 导出模式的兜底帧接收器：当 WebCodecs 不可用时，
 * 逐帧把画布编码为 JPEG 写入宿主临时帧目录，
 * 结束后由宿主 ffmpeg（encodeFramesToVideo）合成 MP4。
 *
 * 仍比 record 模式快：虚拟时钟驱动下帧产出不等待真实时间，
 * 瓶颈只剩 toBlob + 磁盘写 + 一次 ffmpeg 编码。
 */
export class JpegFrameSink {
  private readonly logger = new ExportLogger('JpegFrameSink')
  private readonly capturer: AsyncFrameCapturer
  private readonly framesDir: string
  private frameCount = 0

  constructor(opts: { width: number; height: number; quality: number; framesDir: string }) {
    this.framesDir = opts.framesDir
    this.capturer = new AsyncFrameCapturer(this.logger, {
      width: opts.width,
      height: opts.height,
      quality: opts.quality,
      batchSize: 60,
      framesDir: opts.framesDir,
      maxQueueSize: 120,
      concurrentCaptures: 8
    })
  }

  async initialize(canvas: HTMLCanvasElement): Promise<void> {
    await this.capturer.initialize(canvas)
  }

  async captureFrame(canvas: HTMLCanvasElement): Promise<void> {
    await this.capturer.captureFrameAsync(canvas)
    this.frameCount++
  }

  /** 等待全部帧写盘，返回帧目录路径 */
  async finish(): Promise<string> {
    await this.capturer.flushAll()
    this.logger.info(`JPEG frames finished: ${this.frameCount} frames → ${this.framesDir}`)
    return this.framesDir
  }

  get frames(): number {
    return this.frameCount
  }

  async dispose(): Promise<void> {
    await this.capturer.dispose()
  }
}
