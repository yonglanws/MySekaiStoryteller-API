import { ExportLogger } from './ExportLogger'
import { ExportProgress } from './ProgressTracker'

export interface StreamRecorderConfig {
  fps: number
  width: number
  height: number
  bitrate: number
  mimeType?: string
  timeslice?: number
  estimatedDurationMs?: number
  /** 优先尝试 h264/mp4 录制（流拷贝合流路径）；不支持时自动回退 webm */
  preferMp4?: boolean
}

export type StreamRecorderProgressCallback = (progress: ExportProgress) => void

export interface StreamRecorderMetrics {
  totalChunks: number
  totalBytes: number
  averageChunkSize: number
  recordingDurationMs: number
  droppedFrames: number
}

/** 临时文件随机后缀：避免同毫秒并发导出共用同一路径 */
function randomId(): string {
  const cryptoObj = globalThis.crypto
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID().replace(/-/g, '').slice(0, 12)
  }
  return Math.random().toString(36).slice(2, 10)
}

export class StreamRecorder {
  private readonly logger: ExportLogger
  private mediaRecorder: MediaRecorder | null = null
  private recordedChunks: Blob[] = []
  private config: StreamRecorderConfig
  private stream: MediaStream | null = null
  private isRecording: boolean = false
  private recordingStartTime: number = 0
  private metrics: StreamRecorderMetrics | null = null
  private onErrorCallback: ((error: Error) => void) | null = null
  private chunkIndex: number = 0
  private estimatedChunkCount: number = 0
  private hasRecordingError: boolean = false
  private recordingError: Error | null = null
  private streamingToDisk: boolean = false
  private tempFilePath: string | null = null
  private pendingWritePromises: Promise<void>[] = []
  /** 分块写盘串行链：并发 appendFile 的完成顺序不保证，乱序会静默损坏 webm */
  private writeChain: Promise<void> = Promise.resolve()
  private totalBytesWritten: number = 0
  private lastMimeType: string | null = null

  constructor(config: StreamRecorderConfig) {
    this.config = config
    this.logger = new ExportLogger('StreamRecorder')
    const timeslice = config.timeslice || 200
    if (config.estimatedDurationMs) {
      this.estimatedChunkCount = Math.ceil(config.estimatedDurationMs / timeslice)
    }
  }

  private getSupportedMimeType(): string {
    // 优先使用高性能编码器。mp4/h264 仅在 preferMp4 时前置——
    // Chrome 的 MediaRecorder 对 webm 容器不支持 h264，该类型通常不可用。
    const mp4Types = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1.640028', 'video/mp4']
    const webmTypes = [
      'video/webm;codecs=h264',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm'
    ]
    const types = this.config.preferMp4 ? [...mp4Types, ...webmTypes] : [...webmTypes, ...mp4Types]

    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        this.logger.info(`Using mime type: ${type}`)
        return type
      }
    }

    throw new Error('No supported mime type found for MediaRecorder')
  }

  startRecording(canvas: HTMLCanvasElement): void {
    if (this.isRecording) {
      throw new Error('Recording is already in progress')
    }

    this.hasRecordingError = false
    this.recordingError = null

    try {
      this.stream = canvas.captureStream(this.config.fps)
    } catch (error) {
      throw new Error(
        `Failed to capture stream from canvas: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    const videoTrack = this.stream.getVideoTracks()[0]
    if (videoTrack) {
      try {
        videoTrack.applyConstraints({
          width: { ideal: this.config.width },
          height: { ideal: this.config.height },
          frameRate: { ideal: this.config.fps }
        })
      } catch (e) {
        this.logger.warn('Could not apply video constraints', e)
      }
    }

    this.chunkIndex = 0

    const mimeType = this.config.mimeType || this.getSupportedMimeType()
    const timeslice = this.config.timeslice || 100
    this.lastMimeType = mimeType

    const initialCapacity = this.estimatedChunkCount > 0 ? this.estimatedChunkCount : 300
    this.recordedChunks = new Array<Blob>(initialCapacity)

    try {
      this.mediaRecorder = new MediaRecorder(this.stream, {
        mimeType,
        videoBitsPerSecond: this.config.bitrate,
        audioBitsPerSecond: 128000
      })
    } catch (error) {
      this.stream.getTracks().forEach((track) => track.stop())
      this.stream = null
      throw new Error(
        `Failed to create MediaRecorder: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    let pendingChunks: Blob[] = []
    let lastProcessTime = performance.now()

    this.mediaRecorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) {
        if (this.streamingToDisk) {
          this.writeChunkToDisk(event.data)
        } else {
          pendingChunks.push(event.data)

          const now = performance.now()
          if (pendingChunks.length >= 10 || now - lastProcessTime > 50) {
            this.processPendingChunks(pendingChunks)
            pendingChunks = []
            lastProcessTime = now
          }
        }
      }
    }

    this.mediaRecorder.onerror = (event: Event) => {
      const error = new Error(`MediaRecorder error: ${event.type}`)
      this.logger.error('MediaRecorder error occurred', error)
      this.hasRecordingError = true
      this.recordingError = error
      if (this.onErrorCallback) {
        this.onErrorCallback(error)
      }
    }

    this.mediaRecorder.onpause = () => {
      this.logger.warn('MediaRecorder paused unexpectedly')
    }

    this.mediaRecorder.onresume = () => {
      this.logger.info('MediaRecorder resumed')
    }

    try {
      this.mediaRecorder.start(timeslice)
    } catch (error) {
      this.stream.getTracks().forEach((track) => track.stop())
      this.stream = null
      this.mediaRecorder = null
      throw new Error(
        `Failed to start MediaRecorder: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    this.isRecording = true
    this.recordingStartTime = performance.now()
    this.metrics = {
      totalChunks: 0,
      totalBytes: 0,
      averageChunkSize: 0,
      recordingDurationMs: 0,
      droppedFrames: 0
    }
    this.logger.info('Recording started', {
      fps: this.config.fps,
      timeslice,
      bitrate: this.config.bitrate,
      initialCapacity
    })
  }

  private processPendingChunks(chunks: Blob[]): void {
    for (const chunk of chunks) {
      if (this.chunkIndex >= this.recordedChunks.length) {
        const newCapacity = Math.ceil(this.recordedChunks.length * 1.5)
        this.recordedChunks.length = newCapacity
      }
      this.recordedChunks[this.chunkIndex++] = chunk
    }
  }

  private writeChunkToDisk(chunk: Blob): void {
    const targetPath = this.tempFilePath
    if (!targetPath) return

    // 串行链：分块必须按 ondataavailable 的顺序落盘。并发 appendFile 的完成
    // 顺序不保证（本地磁盘通常有序，但没有机制强制），乱序会静默损坏 webm。
    // 链上永不抛出（失败在 flushChunk 内部消化并标记 recordingError），
    // 因此单块写失败不会中断后续分块。
    const writePromise = this.writeChain.then(() => this.flushChunk(chunk, targetPath))
    this.writeChain = writePromise.then(
      () => undefined,
      () => undefined
    )
    this.pendingWritePromises.push(writePromise)
    const removeFromPending = (): void => {
      const idx = this.pendingWritePromises.indexOf(writePromise)
      if (idx > -1) this.pendingWritePromises.splice(idx, 1)
    }
    writePromise.then(removeFromPending, removeFromPending)
  }

  private async flushChunk(chunk: Blob, targetPath: string): Promise<void> {
    try {
      let buffer: ArrayBuffer
      try {
        buffer = await chunk.arrayBuffer()
      } catch (readError) {
        this.logger.warn('Failed to read chunk for disk write, falling back to reader', readError)
        buffer = await this.readChunkWithFileReader(chunk)
      }

      const data = new Uint8Array(buffer)
      await window.electron.ipcRenderer.invoke('electron:append-to-file', {
        filePath: targetPath,
        data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      })
      this.totalBytesWritten += buffer.byteLength
      this.chunkIndex++
    } catch (error) {
      this.logger.error('Failed to write chunk to disk', error)
      this.hasRecordingError = true
      this.recordingError = new Error(
        `Disk write failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private readChunkWithFileReader(chunk: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        if (reader.result) {
          resolve(reader.result as ArrayBuffer)
        } else {
          reject(new Error('FileReader returned empty result'))
        }
      }
      reader.onerror = () => reject(reader.error ?? new Error('FileReader failed to read chunk'))
      reader.readAsArrayBuffer(chunk)
    })
  }

  async startRecordingToDisk(canvas: HTMLCanvasElement): Promise<string> {
    this.streamingToDisk = true
    this.totalBytesWritten = 0
    this.pendingWritePromises = []
    this.writeChain = Promise.resolve()

    const tempDir = await window.electron.ipcRenderer.invoke('electron:get-temp-base-dir')
    this.tempFilePath = `${tempDir}/mss-stream-${Date.now()}-${randomId()}.webm`
    this.logger.info(`Streaming recording to disk: ${this.tempFilePath}`)

    this.startRecording(canvas)
    return this.tempFilePath
  }

  async stopRecordingToDisk(): Promise<string> {
    if (!this.streamingToDisk || !this.tempFilePath) {
      throw new Error('Not in disk streaming mode')
    }

    const filePath = this.tempFilePath

    if (this.hasRecordingError && this.recordingError) {
      this.logger.warn('Recording had errors, but disk file may have partial data')
    }

    if (this.mediaRecorder && this.isRecording) {
      try {
        await new Promise<void>((resolve) => {
          const timeoutId = setTimeout(() => {
            this.logger.warn('stopRecordingToDisk timeout, forcing stop')
            resolve()
          }, 15000)

          this.mediaRecorder!.onstop = () => {
            clearTimeout(timeoutId)
            this.logger.info('MediaRecorder stopped, waiting for final chunks to write...')
            resolve()
          }

          this.mediaRecorder!.onerror = (event: Event) => {
            clearTimeout(timeoutId)
            this.logger.warn('MediaRecorder error during stop', event)
            resolve()
          }

          try {
            this.mediaRecorder!.stop()
          } catch (e) {
            clearTimeout(timeoutId)
            this.logger.warn('Error calling mediaRecorder.stop()', e)
            resolve()
          }
        })
      } catch (e) {
        this.logger.warn('Error stopping MediaRecorder for disk mode', e)
      }
    }

    this.isRecording = false

    await new Promise((resolve) => setTimeout(resolve, 500))

    if (this.pendingWritePromises.length > 0) {
      this.logger.info(`Waiting for ${this.pendingWritePromises.length} pending chunk writes...`)
      await Promise.allSettled(this.pendingWritePromises)
      this.pendingWritePromises = []
    }

    // 串行链尾部：确保最后一个分块也已落盘
    await this.writeChain

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop())
      this.stream = null
    }

    this.mediaRecorder = null
    this.streamingToDisk = false

    if (this.totalBytesWritten === 0) {
      this.logger.error('No data was written to disk during recording')
      throw new Error('Recording produced no output data')
    }

    this.logger.info(
      `Recording saved to disk: ${filePath}, total bytes: ${(this.totalBytesWritten / 1024 / 1024).toFixed(2)} MB, chunks: ${this.chunkIndex}`
    )

    return filePath
  }

  async stopRecording(): Promise<Blob> {
    if (!this.isRecording || !this.mediaRecorder) {
      throw new Error('No recording in progress')
    }

    if (this.hasRecordingError && this.recordingError) {
      this.logger.warn('Recording had errors, attempting to salvage recorded data')
      try {
        const salvageBlob = await this.salvageRecording()
        if (salvageBlob && salvageBlob.size > 0) {
          this.logger.info(`Salvaged ${salvageBlob.size} bytes from errored recording`)
          return salvageBlob
        }
      } catch (salvageError) {
        this.logger.error('Failed to salvage recording', salvageError)
      }
      throw this.recordingError
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.logger.warn('stopRecording timeout, attempting to salvage')
        try {
          const salvageBlob = this.buildBlobFromChunks()
          if (salvageBlob && salvageBlob.size > 0) {
            resolve(salvageBlob)
          } else {
            reject(new Error('stopRecording timed out and no data could be salvaged'))
          }
        } catch (e) {
          reject(
            new Error(`stopRecording timed out: ${e instanceof Error ? e.message : String(e)}`)
          )
        }
      }, 10000)

      this.mediaRecorder!.onstop = () => {
        clearTimeout(timeoutId)
        this.isRecording = false

        try {
          const finalBlob = this.buildBlobFromChunks()
          const recordingDuration = performance.now() - this.recordingStartTime
          this.updateMetrics(finalBlob, recordingDuration, this.chunkIndex)

          this.recordedChunks.length = 0
          this.chunkIndex = 0

          this.logger.info(
            `Recording stopped, blob size: ${(finalBlob.size / 1024 / 1024).toFixed(2)} MB`
          )
          resolve(finalBlob)
        } catch (e) {
          this.logger.error('Error building blob from recorded chunks', e)
          reject(
            new Error(
              `Failed to build recording blob: ${e instanceof Error ? e.message : String(e)}`
            )
          )
        }
      }

      this.mediaRecorder!.onerror = (event: Event) => {
        clearTimeout(timeoutId)
        this.logger.error('MediaRecorder error during stop', event)
        try {
          const salvageBlob = this.buildBlobFromChunks()
          if (salvageBlob && salvageBlob.size > 0) {
            this.logger.info(`Salvaged ${salvageBlob.size} bytes after stop error`)
            resolve(salvageBlob)
          } else {
            reject(new Error(`MediaRecorder error during stop: ${event.type}`))
          }
        } catch {
          reject(new Error(`MediaRecorder error during stop: ${event.type}`))
        }
      }

      try {
        this.mediaRecorder!.stop()
      } catch (e) {
        clearTimeout(timeoutId)
        this.logger.error('Error calling mediaRecorder.stop()', e)
        try {
          const salvageBlob = this.buildBlobFromChunks()
          if (salvageBlob && salvageBlob.size > 0) {
            resolve(salvageBlob)
          } else {
            reject(e)
          }
        } catch {
          reject(e)
        }
      }
    })
  }

  private buildBlobFromChunks(): Blob {
    const validChunks: Blob[] = []
    for (let i = 0; i < this.chunkIndex; i++) {
      const chunk = this.recordedChunks[i]
      if (chunk && chunk.size > 0) {
        validChunks.push(chunk)
      }
    }

    if (validChunks.length === 0) {
      return new Blob([], { type: this.mediaRecorder?.mimeType || 'video/webm' })
    }

    if (validChunks.length > 100) {
      const mergedChunks: Blob[] = []
      const mergeSize = Math.ceil(validChunks.length / 10)
      for (let i = 0; i < validChunks.length; i += mergeSize) {
        const batch = validChunks.slice(i, i + mergeSize)
        mergedChunks.push(new Blob(batch))
      }
      return new Blob(mergedChunks, { type: this.mediaRecorder!.mimeType })
    }

    return new Blob(validChunks, { type: this.mediaRecorder!.mimeType })
  }

  private async salvageRecording(): Promise<Blob | null> {
    if (!this.mediaRecorder) return null

    try {
      if (this.mediaRecorder.state === 'recording') {
        await new Promise<void>((resolve) => {
          this.mediaRecorder!.onstop = () => resolve()
          try {
            this.mediaRecorder!.stop()
          } catch {
            resolve()
          }
        })
      }
    } catch {
      // ignore
    }

    const blob = this.buildBlobFromChunks()
    this.isRecording = false
    return blob.size > 0 ? blob : null
  }

  private updateMetrics(blob: Blob, recordingDuration: number, chunkCount?: number): void {
    if (!this.metrics) return

    this.metrics.totalChunks = chunkCount ?? this.recordedChunks.length
    this.metrics.totalBytes = blob.size
    this.metrics.averageChunkSize =
      this.metrics.totalChunks > 0 ? this.metrics.totalBytes / this.metrics.totalChunks : 0
    this.metrics.recordingDurationMs = recordingDuration
  }

  /** 最近一次录制实际使用的 MIME 类型（决定宿主收尾能否走流拷贝） */
  getLastMimeType(): string | null {
    return this.lastMimeType
  }

  getMetrics(): StreamRecorderMetrics | null {
    if (!this.metrics || !this.isRecording) return null

    const currentDuration = performance.now() - this.recordingStartTime
    let totalBytes = 0
    for (let i = 0; i < this.chunkIndex; i++) {
      const chunk = this.recordedChunks[i]
      if (chunk && chunk.size) totalBytes += chunk.size
    }
    return {
      ...this.metrics,
      totalChunks: this.chunkIndex,
      totalBytes,
      recordingDurationMs: currentDuration
    }
  }

  setOnErrorCallback(callback: (error: Error) => void): void {
    this.onErrorCallback = callback
  }

  async saveBlobToFile(blob: Blob): Promise<string> {
    let arrayBuffer: ArrayBuffer
    try {
      arrayBuffer = await blob.arrayBuffer()
    } catch (error) {
      throw new Error(
        `Failed to read video blob: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    const result = await window.electron.ipcRenderer.invoke('electron:save-recorded-video', {
      data: arrayBuffer,
      format: blob.type.includes('mp4') ? 'mp4' : 'webm',
      size: arrayBuffer.byteLength
    })

    this.logger.info('Video saved successfully')
    return result
  }

  async recordCanvas(
    canvas: HTMLCanvasElement,
    durationMs: number,
    onProgress: StreamRecorderProgressCallback
  ): Promise<string> {
    this.logger.info('Starting canvas recording', { durationMs, fps: this.config.fps })

    let progressInterval: ReturnType<typeof setInterval> | null = null
    let durationTimeout: ReturnType<typeof setTimeout> | null = null

    try {
      this.startRecording(canvas)

      const startTime = performance.now()
      progressInterval = setInterval(() => {
        const elapsed = performance.now() - startTime
        const progress = Math.min(elapsed / durationMs, 1)
        const percentage = Math.round(progress * 100)

        onProgress({
          stage: 'capturing',
          current: Math.round(elapsed),
          total: durationMs,
          message: `录制中... ${percentage}%`,
          percentage
        })

        if (progress >= 1) {
          if (progressInterval) clearInterval(progressInterval)
          progressInterval = null
        }
      }, 100)

      return await new Promise<string>((resolve, reject) => {
        durationTimeout = setTimeout(async () => {
          if (progressInterval) {
            clearInterval(progressInterval)
            progressInterval = null
          }
          try {
            const blob = await this.stopRecording()
            onProgress({
              stage: 'saving',
              current: 1,
              total: 1,
              message: '正在保存视频...',
              percentage: 100
            })

            const filePath = await this.saveBlobToFile(blob)
            resolve(filePath)
          } catch (error) {
            reject(error)
          }
        }, durationMs)
      })
    } catch (error) {
      if (progressInterval) clearInterval(progressInterval)
      if (durationTimeout) clearTimeout(durationTimeout)
      throw error
    }
  }

  isCurrentlyRecording(): boolean {
    return this.isRecording
  }

  dispose(): void {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop())
      this.stream = null
    }

    if (this.mediaRecorder && this.isRecording) {
      try {
        this.mediaRecorder.stop()
      } catch (error) {
        this.logger.warn('Error stopping MediaRecorder', error)
      }
    }

    this.mediaRecorder = null
    this.recordedChunks = []
    this.isRecording = false
    this.metrics = null
    this.onErrorCallback = null
    this.hasRecordingError = false
    this.recordingError = null
    this.streamingToDisk = false
    this.tempFilePath = null
    this.pendingWritePromises = []
    this.writeChain = Promise.resolve()
    this.totalBytesWritten = 0
  }
}
