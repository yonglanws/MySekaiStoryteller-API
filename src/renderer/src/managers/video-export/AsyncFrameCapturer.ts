import type { ExportLogger } from './ExportLogger'

/**
 * 真实 setTimeout（模块加载时捕获），供内部等待使用。
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
  /** 最大流水线在途帧数（默认 3）：防止内存膨胀同时与下一帧渲染重叠 */
  maxInFlight?: number
  /** 若提供则按帧号严格顺序流式推送 JPEG 字节（image2pipe），不再落盘单帧文件 */
  onFrame?: (frameIndex: number, data: Uint8Array) => Promise<void>
}

interface FrameBuffer {
  index: number
  data: Uint8Array
  path: string
}

type StagingCanvas = {
  canvas: OffscreenCanvas | HTMLCanvasElement
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
}

/**
 * 高性能异步帧捕获器（双缓冲快照 + 有界异步流水线）
 *
 * 1. 双缓冲快照防撕裂：同步 blit 到离屏 StagingCanvas 后立刻返回，允许虚拟时钟/Pixi 渲染下一帧；
 * 2. 异步 JPEG 编码（OffscreenCanvas.convertToBlob + blob.arrayBuffer()，免 FileReader 开销）；
 * 3. 严格按帧序发送：支持 image2pipe 直推宿主，也兼容批量写盘回退路径；
 * 4. 有界背压（maxInFlight）：避免帧队列无限增长。
 */
export class AsyncFrameCapturer {
  private readonly logger: ExportLogger
  private readonly width: number
  private readonly height: number
  private readonly batchSize: number
  private readonly maxInFlight: number
  private isDisposed = false
  private totalCaptured = 0
  private totalWritten = 0

  private writeQueue: FrameBuffer[] = []
  private collectQueue: FrameBuffer[] = []
  private isWriting = false

  private frameCounter = 0
  private inFlight = 0
  private nextOrderIndex = 0
  private isDelivering = false
  private pipelineError: Error | null = null

  private readonly framesDir: string
  private readonly quality: number
  private readonly maxQueueSize: number
  private onFrame?: (frameIndex: number, data: Uint8Array) => Promise<void>

  private readonly stagingPool: StagingCanvas[] = []
  private readonly completedFrames = new Map<number, Uint8Array>()
  private readonly activeTasks = new Set<Promise<void>>()
  private readonly slotWaiters: Array<() => void> = []

  constructor(logger: ExportLogger, options: AsyncFrameCapturerOptions) {
    this.logger = logger
    this.width = Math.max(1, options.width)
    this.height = Math.max(1, options.height)
    this.batchSize = Math.max(30, Math.min(100, options.batchSize))
    this.framesDir = options.framesDir
    this.quality = options.quality
    this.maxQueueSize = options.maxQueueSize
    this.maxInFlight = Math.max(1, options.maxInFlight ?? 3)
    this.onFrame = options.onFrame
  }

  setFrameHandler(
    handler: ((frameIndex: number, data: Uint8Array) => Promise<void>) | undefined
  ): void {
    this.onFrame = handler
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

  private acquireStagingCanvas(): StagingCanvas | null {
    const pooled = this.stagingPool.pop()
    if (pooled) return pooled

    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(this.width, this.height)
      const ctx = canvas.getContext('2d', { alpha: false })
      if (ctx) return { canvas, ctx }
    }

    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas')
      canvas.width = this.width
      canvas.height = this.height
      const ctx = canvas.getContext('2d', { alpha: false })
      if (ctx) return { canvas, ctx }
    }

    return null
  }

  private releaseStagingCanvas(staging: StagingCanvas): void {
    if (!this.isDisposed && this.stagingPool.length < this.maxInFlight + 1) {
      this.stagingPool.push(staging)
    }
  }

  private async blobToBytes(blob: Blob): Promise<Uint8Array> {
    if (typeof blob.arrayBuffer === 'function') {
      return new Uint8Array(await blob.arrayBuffer())
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
      reader.onerror = () => reject(new Error('Failed to read frame blob'))
      reader.readAsArrayBuffer(blob)
    })
  }

  private async encodeStagingToJpeg(staging: StagingCanvas): Promise<Uint8Array> {
    if (
      typeof OffscreenCanvas !== 'undefined' &&
      staging.canvas instanceof OffscreenCanvas &&
      typeof staging.canvas.convertToBlob === 'function'
    ) {
      const blob = await staging.canvas.convertToBlob({
        type: 'image/jpeg',
        quality: this.quality
      })
      return this.blobToBytes(blob)
    }

    const htmlCanvas = staging.canvas as HTMLCanvasElement
    const blob = await new Promise<Blob | null>((resolve) => {
      htmlCanvas.toBlob(resolve, 'image/jpeg', this.quality)
    })
    if (!blob) throw new Error('Staging canvas toBlob returned null')
    return this.blobToBytes(blob)
  }

  private async waitForSlot(): Promise<void> {
    while (
      !this.isDisposed &&
      !this.pipelineError &&
      (this.inFlight >= this.maxInFlight ||
        (!this.onFrame && this.collectQueue.length >= this.maxQueueSize))
    ) {
      await new Promise<void>((resolve) => {
        this.slotWaiters.push(resolve)
      })
    }
  }

  private notifySlotWaiters(): void {
    while (
      this.slotWaiters.length > 0 &&
      (this.isDisposed ||
        this.pipelineError ||
        (this.inFlight < this.maxInFlight &&
          (Boolean(this.onFrame) || this.collectQueue.length < this.maxQueueSize)))
    ) {
      const wake = this.slotWaiters.shift()
      wake?.()
    }
  }

  private async pumpOrderedDelivery(): Promise<void> {
    if (this.isDelivering) return
    this.isDelivering = true
    try {
      while (!this.pipelineError && this.completedFrames.has(this.nextOrderIndex)) {
        const index = this.nextOrderIndex
        const data = this.completedFrames.get(index)!
        this.completedFrames.delete(index)
        this.nextOrderIndex++

        if (this.onFrame) {
          await this.onFrame(index, data)
          this.totalWritten++
        } else {
          this.collectQueue.push({
            index,
            data,
            path: this.generateFrameName(index)
          })
          if (this.collectQueue.length >= this.batchSize) {
            this.triggerBatchWrite()
          }
        }
      }
    } catch (error) {
      this.pipelineError ??= error instanceof Error ? error : new Error(String(error))
      this.notifySlotWaiters()
    } finally {
      this.isDelivering = false
      // 防止交付期间刚推进的下一帧已就绪而未重新进入循环
      if (!this.pipelineError && this.completedFrames.has(this.nextOrderIndex)) {
        void this.pumpOrderedDelivery()
      }
    }
  }

  captureFrame(canvas: HTMLCanvasElement, _frameIndex?: number): Promise<void> {
    return this.captureFrameAsync(canvas)
  }

  async captureFrameAsync(canvas: HTMLCanvasElement): Promise<void> {
    if (this.pipelineError) throw this.pipelineError
    if (this.isDisposed) return

    await this.waitForSlot()
    if (this.pipelineError) throw this.pipelineError
    if (this.isDisposed) return

    const frameIndex = this.frameCounter++
    const staging = this.acquireStagingCanvas()

    if (staging) {
      // 同步 GPU blit 到独立离屏画布，确保下一帧渲染绝不会撕裂当前帧内容
      staging.ctx.drawImage(canvas, 0, 0, this.width, this.height)
      this.totalCaptured++
      this.inFlight++

      const task = (async () => {
        try {
          const bytes = await this.encodeStagingToJpeg(staging)
          this.releaseStagingCanvas(staging)
          this.completedFrames.set(frameIndex, bytes)
          await this.pumpOrderedDelivery()
        } catch (error) {
          this.releaseStagingCanvas(staging)
          this.pipelineError ??= error instanceof Error ? error : new Error(String(error))
        } finally {
          this.inFlight--
          this.notifySlotWaiters()
        }
      })()

      this.activeTasks.add(task)
      void task.finally(() => {
        this.activeTasks.delete(task)
      })
      return
    }

    // 无 OffscreenCanvas/document 时的测试兜底路径：直接从传入画布编码
    await this.doDirectCaptureFallback(canvas, frameIndex)
  }

  private async doDirectCaptureFallback(
    canvas: HTMLCanvasElement,
    frameIndex: number
  ): Promise<void> {
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', this.quality)
    })
    if (!blob) {
      this.logger.warn(`Frame ${frameIndex} capture failed: null blob`)
      return
    }
    const bytes = await this.blobToBytes(blob)
    this.totalCaptured++
    this.completedFrames.set(frameIndex, bytes)
    await this.pumpOrderedDelivery()
  }

  private triggerBatchWrite(): void {
    if (this.isWriting || this.collectQueue.length === 0) return

    this.writeQueue = this.collectQueue
    this.collectQueue = []
    this.notifySlotWaiters()

    void this.performBatchWrite()
  }

  private async performBatchWrite(): Promise<void> {
    if (this.writeQueue.length === 0) return

    this.isWriting = true
    const framesToWrite = this.writeQueue
    this.writeQueue = []

    try {
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
      this.notifySlotWaiters()
      if (this.collectQueue.length >= this.batchSize) {
        this.triggerBatchWrite()
      }
    }
  }

  async flushAll(): Promise<void> {
    while (this.activeTasks.size > 0) {
      await Promise.all([...this.activeTasks])
    }

    if (this.completedFrames.size > 0 && !this.pipelineError) {
      await this.pumpOrderedDelivery()
    }

    while (this.isWriting) {
      await new Promise((resolve) => nativeSetTimeout(resolve, 10))
    }

    if (this.collectQueue.length > 0 && !this.pipelineError) {
      this.writeQueue = this.collectQueue
      this.collectQueue = []
      await this.performBatchWrite()
    }

    while (this.isWriting) {
      await new Promise((resolve) => nativeSetTimeout(resolve, 10))
    }

    if (this.pipelineError) {
      throw this.pipelineError
    }
  }

  async dispose(): Promise<void> {
    this.isDisposed = true
    this.notifySlotWaiters()
    await this.flushAll().catch(() => {})

    this.stagingPool.length = 0
    this.completedFrames.clear()
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
      pendingSize: this.inFlight + this.collectQueue.length + this.writeQueue.length
    }
  }
}
