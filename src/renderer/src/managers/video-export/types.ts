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
  /**
   * 导出管线模式：
   * - `'fast'`（默认）：虚拟时钟逐帧渲染（WebCodecs / frames 管道）
   * - `'frames'`：直接走帧序列编码
   * - `'record'` / `'stream'`：@deprecated 已废弃，自动委托为 `'fast'`
   */
  exportMode?: 'fast' | 'frames' | 'record' | 'stream'
  /** fast 模式视频码率（bps），缺省 12Mbps */
  exportBitrate?: number
  /** fast 模式的编码帧率上限（默认 30）；仍不超过 video.fps */
  fastFps?: number
  /**
   * fast 模式页内编码路径：auto（默认，按 GPU/平台探测）| webcodecs | frames（JPEG 帧序列交 ffmpeg）
   */
  exportFastEncoder?: 'auto' | 'webcodecs' | 'frames'
  /**
   * TTS 与渲染调度：concurrent（默认）= 边渲染边并发合成，端到端耗时最短；
   * serial = 先合成完全部语音再开始渲染，避免与 WebGL/编码争抢 CPU/GPU
   */
  ttsMode?: 'concurrent' | 'serial'
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
  /** 逐句/逐动作/TTS/日志的完整导出诊断，由宿主写成 <video>.log.json */
  diagnostics?: import('./ExportDiagnostics').ExportDiagnostics
  error?: string
  performanceMetrics?: ExportPerformanceMetrics
}

export type ProgressCallback = (progress: ExportProgress) => void
