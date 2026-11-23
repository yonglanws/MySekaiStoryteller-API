import type { StoryPlan } from '../export/storyPlan'

/** 与渲染进程无关的导出诊断结构；宿主落盘和测试都复用这份定义。 */
export interface DiagnosticAction {
  at: number
  modelId: number
  motion?: string
  facial?: string
  cueAtMs: number
}

export interface DiagnosticSnippet {
  index: number
  type: string
  wait: boolean
  delayMs: number
  plannedStartMs: number
  plannedDurationMs: number
  actualStartMs: number | null
  actualDurationMs: number | null
  driftMs: number | null
  durationDriftMs: number | null
  durationSource?: string
  speaker?: string
  content?: string
  ttsText?: string
  japaneseTts: boolean | null
  ttsDurationMs: number
  actions: DiagnosticAction[]
}

export interface DiagnosticTtsLine {
  index: number
  speaker: string
  contentChars: number
  ttsTextChars: number
  japanese: boolean
  durationMs: number
  plannedDurationMs: number
  synthesisText: string
}

export interface DiagnosticMotionEvent {
  seq: number
  at: number
  modelId: number
  channel: 0 | 1
  name: string
  event: string
  snippetIndex: number
  loadMs?: number
  playedMs?: number
  clipDurationMs?: number
  fadeMs?: number
  previous?: string
  reason?: string
}

export interface DiagnosticLogRecord {
  seq: number
  timestamp: number
  level: string
  module: string
  message: string
  data?: unknown
}

export interface ExportDiagnostics {
  schemaVersion: 1
  generatedAt: string
  export: {
    mode: string
    width: number
    height: number
    fps: number
    frameCount: number
    durationMs: number
    outputSize?: number
    timings?: Record<string, number>
    /** 视频编码器（webcodecs-h264 / ffmpeg-libx265 / qsv 等） */
    encoder?: string
    /** 并行编码段数；单段为 1 */
    segments?: number
    /** 帧到 YUV 的转换路径：browser（WebCodecs）/ ffmpeg / gpu */
    convert?: string
    /** 输出色彩标准，例如 bt709/tv */
    color?: string
  }
  summary: {
    models: number
    images: number
    snippets: number
    talks: number
    plannedDurationMs: number
    actualDurationMs: number
    avgAbsDriftMs: number
    ttsLines: number
    ttsTotalMs: number
    motionEvents: number
    motionStarts: number
    motionInterrupts: number
    layoutAppears: number
    layoutClears: number
    logEntries: number
    anomalies: number
  }
  snippets: DiagnosticSnippet[]
  tts: DiagnosticTtsLine[]
  motions: DiagnosticMotionEvent[]
  plan?: StoryPlan
  approximations?: string[]
  anomalies: string[]
  logs: DiagnosticLogRecord[]
}
