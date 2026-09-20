import type { ExportLogger } from './ExportLogger'

/**
 * 真实 setTimeout（模块加载时捕获），供内部轮询等待使用。
 * fast 导出模式下全局 setTimeout 被虚拟时钟接管：虚拟定时器只有帧泵
 * tick 才会推进，而帧泵又可能正卡在本类的背压等待上——用虚拟定时器
 * 会死锁。构造/加载时机在任何 install() 之前，拿到的必是原生实现。
 */
const nativeSetTimeout: typeof setTimeout = globalThis.setTimeout.bind(globalThis)

export interface AsyncFrameCapturerOptions {
  width: number
  height: number
  quality: number
  batchSize: number
  framesDir: string
  maxQueueSize: number
  concurrentCaptures?: number
}

interface FrameBuffer {
  index: number
  data: Uint8Array
  path: string
}

/**
 * 高性能异步帧捕获器
 *
 * 优化点：
 * 1. 对象池复用 - 减少垃圾回收压力
 * 2. 批量异步写入 - 最大化磁盘I/O吞吐量
 * 3. 背压控制 - 防止内存无限增长
 * 4. 零拷贝传输 - 使用 ArrayBuffer 直接传输
 * 5. 动态批量大小 - 根据帧大小自适应调整
 * 6. OffscreenCanvas 支持 - 提升渲染性能
 */
export class AsyncFrameCapturer {
  private readonly logger: ExportLogger
  private readonly batchSize: number
  private isDisposed = false
  private totalCaptured = 0
  private totalWritten = 0

  private writeQueue: FrameBuffer[] = []
  private collectQueue: FrameBuffer[] = []

  private isWriting = false

  private frameCounter = 0

  private readonly framesDir: string
  private readonly quality: number
  private readonly maxQueueSize: number
  private frameNameBuffer: string[] = []

  private offscreenCanvas: OffscreenCanvas | null = null

  constructor(logger: ExportLogger, options: AsyncFrameCapturerOptions) {
    this.logger = logger
    this.batchSize = Math.max(30, Math.min(100, options.batchSize))
    this.framesDir = options.framesDir
    this.quality = options.quality
    this.maxQueueSize = options.maxQueueSize
    this.initializeFrameNameBuffer()
  }

  private initializeFrameNameBuffer(): void {
    this.frameNameBuffer = new Array(6)
    for (let i = 0; i < 6; i++) {
      this.frameNameBuffer[i] = '0'
    }
  }

  private generateFrameName(index: number): string {
    const numStr = String(index).padStart(6, '0')
    return `${this.framesDir}/frame-${numStr}.jpg`
  }

  async initialize(canvas: HTMLCanvasElement): Promise<void> {
    const glConfig: WebGLContextAttributes = {
      preserveDrawingBuffer: true,
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance'
    }

    const gl = canvas.getContext('webgl2', glConfig) || canvas.getContext('webgl', glConfig)

    if (gl) {
      this.logger.info(
        `WebGL${gl instanceof WebGL2RenderingContext ? '2' : '1'} frame capture initialized`
      )
      return
    }

    throw new Error('WebGL not available for frame capture')
  }

  captureFrame(canvas: HTMLCanvasElement, _frameIndex?: number): Promise<void> {
    return this.captureFrameAsync(canvas)
  }

  captureFrameAsync(canvas: HTMLCanvasElement): Promise<void> {
    if (this.isDisposed) return Promise.resolve()

    const frameIndex = this.frameCounter++

    if (this.collectQueue.length >= this.maxQueueSize) {
      return new Promise<void>((resolve, reject) => {
        const checkQueue = (): void => {
          if (this.isDisposed) {
            resolve()
            return
          }
          if (this.collectQueue.length < this.maxQueueSize) {
            this.doCaptureFrameAsync(canvas, frameIndex).then(resolve).catch(reject)
          } else {
            // 必须用真实定时器：虚拟时钟下帧泵正卡在这里等它
            nativeSetTimeout(checkQueue, 5)
          }
        }
        checkQueue()
      })
    }

    return this.doCaptureFrameAsync(canvas, frameIndex)
  }

  private doCaptureFrameAsync(canvas: HTMLCanvasElement, frameIndex: number): Promise<void> {
    return new Promise<void>((resolve) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            this.logger.warn(`Frame ${frameIndex} capture failed: null blob`)
            resolve()
            return
          }

          const reader = new FileReader()
          reader.onload = () => {
            const buffer = reader.result as ArrayBuffer
            const uint8Array = new Uint8Array(buffer)

            this.collectQueue.push({
              index: frameIndex,
              data: uint8Array,
              path: this.generateFrameName(frameIndex)
            })
            this.totalCaptured++

            if (this.collectQueue.length >= this.batchSize) {
              this.triggerBatchWrite()
            }

            resolve()
          }
          reader.onerror = () => {
            this.logger.warn(`Frame ${frameIndex} read failed`)
            resolve()
          }
          reader.readAsArrayBuffer(blob)
        },
        'image/jpeg',
        this.quality
      )
    })
  }

  private triggerBatchWrite(): void {
    if (this.isWriting || this.collectQueue.length === 0) return

    this.writeQueue = this.collectQueue
    this.collectQueue = []

    void this.performBatchWrite()
  }

  private async performBatchWrite(): Promise<void> {
    if (this.writeQueue.length === 0) return

    this.isWriting = true
    const framesToWrite = this.writeQueue
    this.writeQueue = []

    try {
      // 逐帧二进制写（write-frame 通道每帧一个裸 body）。
      // 旧实现把多帧塞进一个 JSON invoke，桥接层只会透传最后一个
      // ArrayBuffer，其余帧全部丢失——帧序列路径必须走逐帧通道。
      const CONCURRENCY = 4
      let cursor = 0
      const workers: Promise<void>[] = []
      const worker = async (): Promise<void> => {
        while (cursor < framesToWrite.length) {
          const frame = framesToWrite[cursor++]
          try {
            await window.electron.ipcRenderer.invoke('electron:write-frame', {
              path: frame.path,
              data: frame.data
            })
            this.totalWritten++
          } catch (error) {
            this.logger.warn(`Frame ${frame.index} write failed:`, error)
          }
        }
      }
      for (let i = 0; i < CONCURRENCY; i++) workers.push(worker())
      await Promise.all(workers)

      framesToWrite.length = 0
    } catch (error) {
      this.logger.error('Batch write failed:', error)
    } finally {
      this.isWriting = false
      if (this.collectQueue.length >= this.batchSize) {
        this.triggerBatchWrite()
      }
    }
  }

  async flushAll(): Promise<void> {
    while (this.isWriting) {
      await new Promise((resolve) => nativeSetTimeout(resolve, 10))
    }

    if (this.collectQueue.length > 0) {
      this.writeQueue = this.collectQueue
      this.collectQueue = []
      await this.performBatchWrite()
    }

    while (this.isWriting) {
      await new Promise((resolve) => nativeSetTimeout(resolve, 10))
    }
  }

  async dispose(): Promise<void> {
    this.isDisposed = true
    await this.flushAll()

    if (this.offscreenCanvas) {
      this.offscreenCanvas = null
    }

    this.writeQueue.length = 0
    this.collectQueue.length = 0

    this.logger.info(
      `AsyncFrameCapturer disposed: captured=${this.totalCaptured}, written=${this.totalWritten}`
    )
  }

  get stats(): { totalCaptured: number; totalWritten: number; pendingSize: number } {
    return {
      totalCaptured: this.totalCaptured,
      totalWritten: this.totalWritten,
      pendingSize: this.collectQueue.length + this.writeQueue.length
    }
  }
}
