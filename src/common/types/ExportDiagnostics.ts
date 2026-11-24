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

/**
 * 成片帧与故事帧的对应关系（对齐 `sse-export/src/lib.rs:513-545` 的 `Clock`）。
 *
 * 成片帧 n 显示故事帧 `floor(n×storyFps/videoFps)`；60fps 时就是 n。
 * PlayCore 前 10 个故事帧也在成片里（参考导出默认 `--from 0`）。
 */
export interface ExportFrameMap {
  storyFps: number
  videoFps: number
  /** plan 的故事帧总数（成片应覆盖 0..storyFrames-1）。 */
  storyFrames: number
  /** 成片实际帧数。 */
  videoFrames: number
  /** 成片帧 -> 故事帧的公式；60fps 时为 `n`。 */
  videoFrameToStoryFrame: string
  /** PlayCore 预热故事帧数；它们是成片开头的一部分。 */
  playcoreWarmupStoryFrames: number
  /** 诊断 plannedStartMs/actualStartMs 的 0 点所在故事帧（= 预热帧数）。 */
  timelineOriginStoryFrame: number
}

export interface ExportDiagnostics {
  schemaVersion: 1
  generatedAt: string
  export: {
    mode: string
    width: number
    height: number
    fps: number
    /** 实际编码帧率（fast 模式 = fastFps）；缺省时与 fps 相同。 */
    videoFps?: number
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
  /** 成片帧 n ↔ 故事帧 n 的映射；旧日志没有这一项。 */
  frameMap?: ExportFrameMap
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
