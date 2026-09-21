export interface VideoExportOptions {
  fps: number
  width: number
  height: number
  quality: 'draft' | 'standard' | 'high'
  format: 'mp4' | 'webm'
  codec?: 'h264' | 'h265' | 'vp9' | 'prores'
  crf?: number
  bitrate?: string
  useGpu?: boolean
  gpuRenderer?: 'auto' | 'nvidia' | 'amd' | 'intel' | 'cpu'
  jpegQuality?: number
  batchSize?: number
  maxRetries?: number
  enableResumable?: boolean
  exportMode?: 'frames' | 'stream' | 'fast'
  /** fast 模式视频码率（bps），缺省 12Mbps */
  exportBitrate?: number
  /** fast 模式的编码帧率上限（默认 30）；仍不超过 video.fps */
  fastFps?: number
  /**
   * fast 模式页内编码路径：auto（默认，按 GPU/平台探测）| webcodecs | frames（JPEG 帧序列交 ffmpeg）
   */
  exportFastEncoder?: 'auto' | 'webcodecs' | 'frames'
  /** record 模式 MediaRecorder 视频码率（bps），缺省 8Mbps */
  recordBitrate?: number
  /** record 模式收尾：off（默认，webm + 全量重编码）| auto/on（h264/mp4 直录 + 流拷贝，失败回退重编码） */
  recordStreamCopy?: 'auto' | 'on' | 'off'
  /** 流拷贝路径的目标成片体积（MB）；>0 时按估算时长反推视频码率，0 = 按 recordBitrate */
  recordTargetSizeMb?: number
  /** record 模式采集帧率上限；0/缺省 = 跟随 fps。调小降低编码负载，输出帧率随之变化 */
  recordCaptureFps?: number
  apiMode?: boolean
  apiOutputPath?: string
  apiCrf?: number
  apiAudioBitrate?: string
}

export interface ExportProgress {
  stage: 'initializing' | 'loading' | 'capturing' | 'encoding' | 'saving' | 'complete' | 'error'
  current: number
  total: number
  message: string
  percentage: number
  eta?: number
  fps?: number
}

export interface ExportPerformanceMetrics {
  frameCapture: {
    totalFrames: number
    droppedFrames: number
    averageCaptureTimeMs: number
    maxCaptureTimeMs: number
    minCaptureTimeMs: number
    frameRateStability: number
  }
  memory: {
    peakHeapUsedMB: number
    averageHeapUsedMB: number
    frameBufferSizeMB: number
  }
  timing: {
    totalExportTimeMs: number
    capturePhaseTimeMs: number
    encodingPhaseTimeMs: number
    savingPhaseTimeMs: number
    frameGenerationLatencyMs: number
  }
  cpu: {
    averageLoadPercentage: number
    peakLoadPercentage: number
  }
}

export interface ExportResult {
  success: boolean
  duration: number
  frameCount: number
  outputSize?: number
  /** 分段时间统计（毫秒）：pump/ttsWait/encode/audio/invoke/avgPumpFps/frames */
  timings?: Record<string, number>
  error?: string
  performanceMetrics?: ExportPerformanceMetrics
}

export type ProgressCallback = (progress: ExportProgress) => void
