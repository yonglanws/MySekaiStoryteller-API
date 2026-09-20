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
  /**
   * fast 模式页内编码路径：auto（默认，按 GPU/平台探测）| webcodecs | frames（JPEG 帧序列交 ffmpeg）
   */
  exportFastEncoder?: 'auto' | 'webcodecs' | 'frames'
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
