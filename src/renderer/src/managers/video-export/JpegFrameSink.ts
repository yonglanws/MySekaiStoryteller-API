import { ExportLogger } from './ExportLogger'
import { AsyncFrameCapturer } from './AsyncFrameCapturer'
import { GpuYuv420Converter } from './GpuYuv420Converter'
import {
  BINARY_WS_HEADER_BYTES,
  BINARY_WS_KIND_PIPE_FRAME,
  BINARY_WS_KIND_REPEAT_FRAME,
  BinaryWsClient,
  fetchBinaryStreamEndpoint,
  writeBinaryHeader
} from './BinaryWsClient'

const RAW_CHUNK_TARGET_BYTES = 8 * 1024 * 1024
const RAW_MAX_BATCH_FRAMES = 4
const RAW_MAX_IN_FLIGHT_SENDS = 2
const RAW_REPEAT_FLUSH_THRESHOLD = 60
const RUST_WS_PACKET_POOL_MAX = 4
const RUST_WS_PIPE_CLOSE_TIMEOUT_MS = 300_000

/**
 * fast 导出模式的宿主管道帧接收器：当 WebCodecs 不可用时使用。
 *
 * 1. 优先用 WebGL2 GPU 将画布直转为 BT.709 limited-range `yuv420p` 并通过 3-slot PBO 环异步读回；
 * 2. 若宿主提供 Rust `/bridge/rs-stream` 二进制 WebSocket，则以零批拷贝单帧包（`KIND_PIPE_FRAME=2`）
 *    与 16B 静止帧复用包（`KIND_REPEAT_FRAME=3`）直推原生管道；
 * 3. 否则回退 HTTP `frames-stream-*` 多帧拼批管道，或进一步回落 `image2pipe` MJPEG / 临时帧目录。
 */
export class JpegFrameSink {
  private readonly logger = new ExportLogger('JpegFrameSink')
  private readonly opts: {
    width: number
    height: number
    quality: number
    fps: number
    crf: number
  }
  private readonly explicitCrf: number | undefined
  private capturer: AsyncFrameCapturer
  private yuvConverter: GpuYuv420Converter | null = null
  private rawMode = false
  private rawBatchFrames = 2
  private rawPendingFrames: Uint8Array[] = []
  private rawBufferPool: Uint8Array[] = []
  private rawBatchBufferPool: Uint8Array[] = []
  private readonly rawInFlightSends = new Set<Promise<void>>()
  private rawPipelineError: Error | null = null
  private pendingRepeatCount = 0
  private disposed = false

  private rustWsClient: BinaryWsClient | null = null
  private readonly rustWsStreamId = 1
  private rustWsVideoPath: string | null = null
  private rustWsTempDir: string | null = null
  private rustPacketPool: Uint8Array[] = []
  private readonly repeatHeaderBuf = new Uint8Array(BINARY_WS_HEADER_BYTES)
  private lastWsBackpressureWarnAtMs = 0

  private framesDir: string
  private frameCount = 0
  private pipeSessionId: string | null = null
  private pipeVideoPath: string | null = null
  private finishedPipeVideoPath: string | null = null

  constructor(opts: {
    width: number
    height: number
    quality: number
    framesDir?: string
    fps?: number
    crf?: number
  }) {
    this.framesDir = opts.framesDir ?? ''
    this.explicitCrf = opts.crf
    this.opts = {
      width: opts.width,
      height: opts.height,
      quality: opts.quality,
      fps: opts.fps ?? 30,
      crf: opts.crf ?? 23
    }
    this.capturer = new AsyncFrameCapturer(this.logger, {
      width: this.opts.width,
      height: this.opts.height,
      quality: this.opts.quality,
      batchSize: 60,
      framesDir: this.framesDir,
      maxQueueSize: 120,
      maxInFlight: 6
    })
  }

  get isPipeMode(): boolean {
    return Boolean(this.pipeSessionId || this.rustWsClient || this.finishedPipeVideoPath)
  }

  get isRawVideoMode(): boolean {
    return this.rawMode
  }

  get isRustWsPipeMode(): boolean {
    return Boolean(
      this.rustWsClient ||
      (this.rustWsVideoPath && this.finishedPipeVideoPath === this.rustWsVideoPath)
    )
  }

  get canRepeatLastFrame(): boolean {
    return Boolean(
      this.rawMode &&
      this.yuvConverter &&
      (this.pipeSessionId || this.rustWsClient) &&
      this.frameCount > 0
    )
  }

  get framesDirectory(): string {
    return this.framesDir
  }

  private get maxSinglePoolSize(): number {
    return Math.max(4, this.rawBatchFrames + 2)
  }

  private get maxBatchPoolSize(): number {
    return RAW_MAX_IN_FLIGHT_SENDS + 1
  }

  private releaseSingleBuffer(buf: Uint8Array): void {
    if (!this.disposed && this.rawBufferPool.length < this.maxSinglePoolSize) {
      this.rawBufferPool.push(buf)
    }
  }

  private acquireBatchBuffer(minBytes: number, frameBytes: number): Uint8Array {
    const targetBytes = Math.max(minBytes, this.rawBatchFrames * frameBytes)
    const pooled = this.rawBatchBufferPool.pop()
    if (pooled && pooled.byteLength >= minBytes) {
      return pooled
    }
    return new Uint8Array(targetBytes)
  }

  private releaseBatchBuffer(buf: Uint8Array): void {
    if (!this.disposed && this.rawBatchBufferPool.length < this.maxBatchPoolSize) {
      this.rawBatchBufferPool.push(buf)
    }
  }

  private acquireRustPacketPayload(frameBytes: number): Uint8Array {
    const packetLen = BINARY_WS_HEADER_BYTES + frameBytes
    const pooled = this.rustPacketPool.pop()
    const pkt = pooled && pooled.byteLength === packetLen ? pooled : new Uint8Array(packetLen)
    return pkt.subarray(BINARY_WS_HEADER_BYTES)
  }

  private releaseRustPacket(pkt: Uint8Array): void {
    if (!this.disposed && this.rustPacketPool.length < RUST_WS_PACKET_POOL_MAX) {
      this.rustPacketPool.push(pkt)
    }
  }

  private async tryStartRustWsPipe(converter: GpuYuv420Converter): Promise<boolean> {
    const endpoint = await fetchBinaryStreamEndpoint()
    if (!endpoint || endpoint.backend !== 'rust' || !endpoint.wsUrl) {
      return false
    }
    const invoke = window.electron?.ipcRenderer?.invoke
    if (typeof invoke !== 'function') {
      return false
    }

    let baseDir = ''
    let client: BinaryWsClient | null = null
    try {
      baseDir = (await invoke('electron:get-temp-base-dir')) as string
      if (!baseDir) return false
      const sep = baseDir.includes('\\') && !baseDir.includes('/') ? '\\' : '/'
      const normalizedBase = baseDir.replace(/[\\/]+$/, '')
      const outputPath = `${normalizedBase}${sep}video.mp4`

      client = await BinaryWsClient.connect(endpoint.wsUrl, {
        onAsyncError: (err) => {
          if (!this.disposed) {
            this.rawPipelineError ??= err
          }
        }
      })

      const ack = await client.sendControl({
        op: 'open-pipe',
        streamId: this.rustWsStreamId,
        outputPath,
        width: this.opts.width,
        height: this.opts.height,
        fps: this.opts.fps,
        format: 'yuv420p',
        codec: endpoint.videoConfig?.codec || 'hevc',
        encoder: endpoint.videoConfig?.encoder || 'auto',
        crf: this.explicitCrf ?? endpoint.videoConfig?.crf ?? this.opts.crf,
        faststart: false,
        lowPower: true,
        dedup: false
      })

      if (!ack?.ok) {
        throw new Error(ack?.error || 'Rust binary WS open-pipe rejected')
      }

      this.yuvConverter = converter
      this.rawMode = true
      this.rustWsClient = client
      this.rustWsVideoPath = outputPath
      this.rustWsTempDir = baseDir
      this.logger.info(
        `Raw YUV420p Rust WS pipe started: encoder=${endpoint.videoConfig?.encoder || 'auto'}, codec=${endpoint.videoConfig?.codec || 'hevc'} → ${outputPath}`
      )
      return true
    } catch (error) {
      this.logger.warn(
        'Rust binary WS pipe unavailable, falling back to HTTP frames-stream:',
        error
      )
      client?.close()
      if (baseDir) {
        await invoke('electron:delete-temp-file', { filePath: baseDir }).catch(() => {})
      }
      return false
    }
  }

  private async tryStartRawVideoPipe(): Promise<boolean> {
    const converter = GpuYuv420Converter.create(this.opts.width, this.opts.height, 3)
    if (!converter) return false

    if (await this.tryStartRustWsPipe(converter)) {
      return true
    }

    try {
      const started = (await window.electron?.ipcRenderer?.invoke?.(
        'electron:frames-stream-start',
        {
          fps: this.opts.fps,
          width: this.opts.width,
          height: this.opts.height,
          inputWidth: this.opts.width,
          inputHeight: this.opts.height,
          crf: this.opts.crf,
          frameFormat: 'rawvideo'
        }
      )) as { id?: string; videoPath?: string } | undefined

      if (started?.id && started.videoPath) {
        this.yuvConverter = converter
        this.rawMode = true
        this.rawBatchFrames = Math.max(
          1,
          Math.min(
            RAW_MAX_BATCH_FRAMES,
            Math.floor(RAW_CHUNK_TARGET_BYTES / converter.frameByteLength)
          )
        )
        this.pipeSessionId = started.id
        this.pipeVideoPath = started.videoPath
        this.logger.info(
          `Raw YUV420p pipe stream started: id=${started.id}, batch=${this.rawBatchFrames} → ${started.videoPath}`
        )
        return true
      }
    } catch (error) {
      this.logger.warn('Raw YUV420p pipe unavailable, trying MJPEG fallback:', error)
    }
    converter.dispose()
    return false
  }

  private async sendRustPipeFrame(yuvFrame: Uint8Array): Promise<void> {
    const client = this.rustWsClient
    if (!client) {
      throw this.rawPipelineError ?? new Error('Rust binary WS pipe closed')
    }
    if (this.rawPipelineError) throw this.rawPipelineError
    await client.waitBufferReady({
      isCancelled: () => this.disposed || Boolean(this.rawPipelineError),
      onHighWater: (buffered) => {
        const now = Date.now()
        if (now - this.lastWsBackpressureWarnAtMs >= 5000) {
          this.lastWsBackpressureWarnAtMs = now
          this.logger.warn(
            `Rust pipe WS bufferedAmount high (${(buffered / (1024 * 1024)).toFixed(1)} MB), pacing capture`
          )
        }
      }
    })
    if (this.rawPipelineError) throw this.rawPipelineError
    if (!client.isOpen) {
      const err =
        this.rawPipelineError ?? new Error('Rust binary WS closed unexpectedly during export')
      this.rawPipelineError ??= err
      throw err
    }

    const frameBytes = yuvFrame.byteLength
    const packetLen = BINARY_WS_HEADER_BYTES + frameBytes
    let pkt: Uint8Array
    if (yuvFrame.byteOffset === BINARY_WS_HEADER_BYTES && yuvFrame.buffer.byteLength >= packetLen) {
      pkt = new Uint8Array(yuvFrame.buffer, 0, packetLen)
    } else {
      const pooled = this.rustPacketPool.pop()
      pkt = pooled && pooled.byteLength === packetLen ? pooled : new Uint8Array(packetLen)
      pkt.set(yuvFrame, BINARY_WS_HEADER_BYTES)
    }
    writeBinaryHeader(pkt, this.rustWsStreamId, BINARY_WS_KIND_PIPE_FRAME, 1)
    client.sendBinary(pkt)
    this.releaseRustPacket(pkt)
  }

  private async flushRawBatch(): Promise<void> {
    if (this.rawPendingFrames.length === 0 || !this.pipeSessionId) return
    while (this.rawInFlightSends.size >= RAW_MAX_IN_FLIGHT_SENDS && !this.rawPipelineError) {
      await Promise.race(this.rawInFlightSends)
    }
    if (this.rawPipelineError) throw this.rawPipelineError

    const frames = this.rawPendingFrames.splice(0, this.rawPendingFrames.length)
    const sessionId = this.pipeSessionId
    const frameBytes = this.yuvConverter?.frameByteLength ?? frames[0].byteLength
    let payload: Uint8Array
    let pooledFrame: Uint8Array | null = null
    let pooledBatch: Uint8Array | null = null
    if (frames.length === 1) {
      payload = frames[0]
      pooledFrame = frames[0]
    } else {
      const totalBytes = frames.length * frameBytes
      const batchBuf = this.acquireBatchBuffer(totalBytes, frameBytes)
      for (let i = 0; i < frames.length; i++) {
        batchBuf.set(frames[i], i * frameBytes)
        this.releaseSingleBuffer(frames[i])
      }
      payload = totalBytes === batchBuf.byteLength ? batchBuf : batchBuf.subarray(0, totalBytes)
      pooledBatch = batchBuf
    }

    const sendTask = window.electron.ipcRenderer
      .invoke('electron:frames-stream-chunk', {
        id: sessionId,
        data: payload
      })
      .catch((error) => {
        this.rawPipelineError ??= error instanceof Error ? error : new Error(String(error))
      })
      .finally(() => {
        if (pooledFrame) {
          this.releaseSingleBuffer(pooledFrame)
        }
        if (pooledBatch) {
          this.releaseBatchBuffer(pooledBatch)
        }
        this.rawInFlightSends.delete(sendTask)
      })
    this.rawInFlightSends.add(sendTask)
  }

  private async drainPboToRawPipe(): Promise<void> {
    if (!this.rawMode || !this.yuvConverter) return
    const frameBytes = this.yuvConverter.frameByteLength
    if (this.rustWsClient) {
      const remaining = await this.yuvConverter.drainAllAsync(() =>
        this.acquireRustPacketPayload(frameBytes)
      )
      for (const frame of remaining) {
        await this.sendRustPipeFrame(frame)
      }
      return
    }
    const remaining = await this.yuvConverter.drainAllAsync(
      () => this.rawBufferPool.pop() ?? new Uint8Array(frameBytes)
    )
    for (const frame of remaining) {
      this.rawPendingFrames.push(frame)
      if (this.rawPendingFrames.length >= this.rawBatchFrames) {
        await this.flushRawBatch()
      }
    }
    await this.flushRawBatch()
  }

  private async flushPendingRepeats(): Promise<void> {
    if (this.pendingRepeatCount <= 0) return
    if (this.rawPipelineError) throw this.rawPipelineError
    if (this.rustWsClient) {
      await this.drainPboToRawPipe()
      if (this.rawPipelineError) throw this.rawPipelineError
      const count = this.pendingRepeatCount
      this.pendingRepeatCount = 0
      const client = this.rustWsClient
      if (!client) {
        throw new Error('Rust binary WS pipe closed before repeat')
      }
      await client.waitBufferReady({
        isCancelled: () => this.disposed || Boolean(this.rawPipelineError)
      })
      if (this.rawPipelineError) throw this.rawPipelineError
      writeBinaryHeader(
        this.repeatHeaderBuf,
        this.rustWsStreamId,
        BINARY_WS_KIND_REPEAT_FRAME,
        count
      )
      client.sendBinary(this.repeatHeaderBuf)
      return
    }
    if (!this.pipeSessionId) {
      this.pendingRepeatCount = 0
      return
    }
    await this.drainPboToRawPipe()
    if (this.rawInFlightSends.size > 0) {
      await Promise.all([...this.rawInFlightSends])
    }
    if (this.rawPipelineError) throw this.rawPipelineError
    const count = this.pendingRepeatCount
    this.pendingRepeatCount = 0
    await window.electron.ipcRenderer.invoke('electron:frames-stream-repeat', {
      id: this.pipeSessionId,
      count
    })
  }

  /**
   * 静止帧复用：跳过 GPU readPixels 与 3.11 MB 帧传输，合并连续重复次数后
   * 通过 Rust `KIND_REPEAT_FRAME` (16B) 或 HTTP `electron:frames-stream-repeat` 复写上一帧。
   */
  async repeatLastFrame(count = 1): Promise<boolean> {
    if (!this.canRepeatLastFrame) return false
    const repeat = Math.max(0, Math.floor(count))
    if (repeat === 0) return true
    if (this.rawPipelineError) throw this.rawPipelineError

    // 首次进入静止区间时先把 PBO 环与待发送批刷进管道，确保宿主“上一帧”是最新渲染帧。
    if (this.pendingRepeatCount === 0) {
      await this.drainPboToRawPipe()
    }
    this.pendingRepeatCount += repeat
    this.frameCount += repeat
    if (this.pendingRepeatCount >= RAW_REPEAT_FLUSH_THRESHOLD) {
      await this.flushPendingRepeats()
    }
    return true
  }

  async initialize(canvas: HTMLCanvasElement): Promise<void> {
    if (await this.tryStartRawVideoPipe()) {
      return
    }

    await this.capturer.initialize(canvas)

    try {
      const started = (await window.electron?.ipcRenderer?.invoke?.(
        'electron:frames-stream-start',
        {
          fps: this.opts.fps,
          width: this.opts.width,
          height: this.opts.height,
          inputWidth: this.opts.width,
          inputHeight: this.opts.height,
          crf: this.opts.crf
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
        return
      }
    } catch (error) {
      this.logger.warn('JPEG pipe stream unavailable, falling back to disk frame batches:', error)
      this.pipeSessionId = null
      this.pipeVideoPath = null
    }

    if (!this.framesDir && window.electron?.ipcRenderer?.invoke) {
      const dir = (await window.electron.ipcRenderer.invoke('electron:get-temp-dir')) as string
      this.framesDir = dir || ''
      if (this.framesDir) {
        await this.capturer.dispose()
        this.capturer = new AsyncFrameCapturer(this.logger, {
          width: this.opts.width,
          height: this.opts.height,
          quality: this.opts.quality,
          batchSize: 60,
          framesDir: this.framesDir,
          maxQueueSize: 120,
          maxInFlight: 6
        })
        await this.capturer.initialize(canvas)
      }
    }
  }

  async captureFrame(canvas: HTMLCanvasElement): Promise<void> {
    if (this.rawMode && this.yuvConverter) {
      if (this.rawPipelineError) throw this.rawPipelineError
      if (this.pendingRepeatCount > 0) {
        await this.flushPendingRepeats()
      }
      if (this.rustWsClient) {
        const willYield = this.yuvConverter.willYieldOnNextEnqueue !== false
        const reuse = willYield
          ? this.acquireRustPacketPayload(this.yuvConverter.frameByteLength)
          : undefined
        const completed = await this.yuvConverter.enqueueAsync(canvas, reuse)
        this.frameCount++
        if (completed) {
          await this.sendRustPipeFrame(completed)
        }
        return
      }
      const willYield = this.yuvConverter.willYieldOnNextEnqueue !== false
      const reuse = willYield ? this.rawBufferPool.pop() : undefined
      const completed = await this.yuvConverter.enqueueAsync(canvas, reuse)
      this.frameCount++
      if (completed) {
        this.rawPendingFrames.push(completed)
        if (this.rawPendingFrames.length >= this.rawBatchFrames) {
          await this.flushRawBatch()
        }
      }
      return
    }
    await this.capturer.captureFrameAsync(canvas)
    this.frameCount++
  }

  /** 等待全部帧发送/写盘，返回管道 MP4 路径（pipe 模式）或帧目录路径（磁盘回退） */
  async finish(): Promise<string> {
    if (this.rawMode && this.yuvConverter) {
      await this.drainPboToRawPipe()
      if (!this.rustWsClient) {
        await Promise.all([...this.rawInFlightSends])
      }
      if (this.pendingRepeatCount > 0) {
        await this.flushPendingRepeats()
      }
      this.yuvConverter.dispose()
      this.yuvConverter = null
      this.rawBufferPool.length = 0
      this.rawBatchBufferPool.length = 0
      this.rawPendingFrames.length = 0
      this.rustPacketPool.length = 0
      if (this.rawPipelineError) throw this.rawPipelineError
    } else {
      await this.capturer.flushAll()
    }

    if (this.rustWsClient) {
      const client = this.rustWsClient
      const videoPath = this.rustWsVideoPath!
      const closed = await client.sendControl(
        { op: 'close', streamId: this.rustWsStreamId },
        RUST_WS_PIPE_CLOSE_TIMEOUT_MS
      )
      client.close()
      this.rustWsClient = null
      if (this.rawPipelineError) throw this.rawPipelineError
      if (!closed?.ok) {
        throw new Error(closed?.error || 'Rust binary WS pipe close failed')
      }
      this.finishedPipeVideoPath = videoPath
      this.logger.info(
        `Raw YUV420p Rust WS pipe finished: ${this.frameCount} frames (${closed.encoder ?? 'unknown'}, deduped=${closed.dedupedFrames ?? 0}) → ${videoPath}`
      )
      return videoPath
    }

    if (this.pipeSessionId) {
      const sessionId = this.pipeSessionId
      const result = (await window.electron.ipcRenderer.invoke('electron:frames-stream-finish', {
        id: sessionId
      })) as { videoPath?: string } | undefined
      const videoPath = result?.videoPath || this.pipeVideoPath!
      this.pipeSessionId = null
      this.finishedPipeVideoPath = videoPath
      this.logger.info(
        `${this.rawMode ? 'Raw YUV420p' : 'JPEG'} pipe finished: ${this.frameCount} frames → ${videoPath}`
      )
      return videoPath
    }

    this.logger.info(`JPEG frames finished: ${this.frameCount} frames → ${this.framesDir}`)
    return this.framesDir
  }

  get frames(): number {
    return this.frameCount
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.pendingRepeatCount = 0
    await this.capturer.dispose()
    this.yuvConverter?.dispose()
    this.yuvConverter = null
    this.rawPendingFrames.length = 0
    this.rawBufferPool.length = 0
    this.rawBatchBufferPool.length = 0
    this.rustPacketPool.length = 0
    await Promise.allSettled([...this.rawInFlightSends])
    if (this.rustWsClient) {
      const client = this.rustWsClient
      this.rustWsClient = null
      client.sendAbort(this.rustWsStreamId)
      client.close()
    }
    if (this.rustWsTempDir && !this.finishedPipeVideoPath) {
      const dir = this.rustWsTempDir
      this.rustWsTempDir = null
      await window.electron?.ipcRenderer
        ?.invoke?.('electron:delete-temp-file', { filePath: dir })
        ?.catch(() => {})
    }
    if (this.pipeSessionId) {
      const id = this.pipeSessionId
      this.pipeSessionId = null
      await window.electron?.ipcRenderer
        ?.invoke?.('electron:frames-stream-cancel', { id })
        ?.catch(() => {})
    }
  }
}
