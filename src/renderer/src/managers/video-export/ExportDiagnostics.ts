import type { SnippetData } from '../../../../common/types/Story'
import type { SnippetTimelineEntry } from '../TTSManager'
import type { SnippetTimestampRecorder } from './SnippetTimestampRecorder'
import type { MotionTraceEvent } from './MotionTraceCollector'
import type { ExportLogRecord } from './ExportLogBus'
import { isJapaneseSpeechText } from '../../../../common/tts/speechText'
import { snippetBlocksTimeline } from '../../../../common/export/snippetSemantics'
import { bakeStoryPlan } from '../../../../common/export/storyPlan'
import type {
  DiagnosticAction,
  DiagnosticSnippet,
  DiagnosticTtsLine,
  ExportDiagnostics
} from '../../../../common/types/ExportDiagnostics'

export type {
  DiagnosticAction,
  DiagnosticSnippet,
  DiagnosticTtsLine,
  ExportDiagnostics
} from '../../../../common/types/ExportDiagnostics'

export interface ExportDiagnosticsInput {
  snippets: SnippetData[]
  timeline: SnippetTimelineEntry[]
  timestamps: SnippetTimestampRecorder
  ttsResults: Map<number, { durationMs: number; characterName: string; text: string }>
  motion: MotionTraceEvent[]
  logs: ExportLogRecord[]
  exportMeta: ExportDiagnostics['export']
  provider?: string
  ttsEnabled?: boolean
  storyCounts?: { models: number; images: number }
  motionSettleMs?: Map<number, number>
}

function snippetActions(snippet: SnippetData, durationMs: number): DiagnosticAction[] {
  const actions: DiagnosticAction[] = []
  const data = ((snippet as { data?: unknown }).data ?? {}) as {
    motion?: string
    facial?: string
    modelId?: number
    actions?: Array<{ at: number; modelId: number; motion?: string; facial?: string }>
  }
  if (data.motion || data.facial) {
    actions.push({
      at: 0,
      modelId: (data as { modelId?: number }).modelId ?? -1,
      ...(data.motion ? { motion: data.motion } : {}),
      ...(data.facial ? { facial: data.facial } : {}),
      cueAtMs: 0
    })
  }
  for (const action of data.actions ?? []) {
    actions.push({
      ...action,
      cueAtMs: Math.round(Math.max(0, action.at) * Math.max(0, durationMs))
    })
  }
  return actions
}

export {
  sanitizeDiagnostics,
  formatDiagnosticsText
} from '../../../../common/export/diagnosticsFormat'

export function buildExportDiagnostics(input: ExportDiagnosticsInput): ExportDiagnostics {
  const timelineByIndex = new Map(input.timeline.map((entry) => [entry.snippetIndex, entry]))
  const diagnostics: DiagnosticSnippet[] = []
  const tts: DiagnosticTtsLine[] = []
  const anomalies: string[] = []
  let plannedDurationMs = 0
  let actualDurationMs = 0
  let driftSum = 0
  let driftCount = 0
  let ttsTotalMs = 0
  let layoutAppears = 0
  let layoutClears = 0
  // TimelineCalculator 的 startTime 只累计片段 body；BaseSnippet 在 handle 前还会
  // 单独 delay，因此实际墙钟包含 delay。诊断把 delay 累加进 planned，才能与
  // timestampRecorder 的实际起点/时长对齐。
  let cumulativeDelayMs = 0
  let previousDriftMs = 0

  input.snippets.forEach((snippet, index) => {
    const planned = timelineByIndex.get(index)
    const actual = input.timestamps.getSnippetTimestamp(index)
    const blocking = snippetBlocksTimeline(snippet)
    const delayMs = blocking ? Math.round((Number(snippet.delay) || 0) * 1000) : 0
    const plannedStartMs = (planned?.startTimeMs ?? 0) + cumulativeDelayMs
    const plannedDuration = blocking ? (planned?.durationMs ?? 0) + delayMs : 0
    cumulativeDelayMs += delayMs
    const actualStartMs = actual
      ? Math.round(Math.max(0, actual.wallStartMs - input.timestamps.getRenderStartWallMs()))
      : null
    const actualDuration = actual ? Math.round(Math.max(0, actual.wallDurationMs)) : null
    const driftMs = actualStartMs === null ? null : Math.round(actualStartMs - plannedStartMs)
    const durationDriftMs =
      actualDuration === null ? null : Math.round(actualDuration - plannedDuration)
    plannedDurationMs += plannedDuration
    if (actualDuration !== null) actualDurationMs += actualDuration
    if (driftMs !== null) {
      driftSum += Math.abs(driftMs)
      driftCount++
      // 长片里 1~3ms/句的渲染开销会累积成 1~2s 的固定偏移，这不是“某句卡住”。
      // 只报突然新增的漂移，避免 10 分钟剧情在超过 1s 后每句都刷一条假异常。
      const driftJumpMs = Math.abs(driftMs - previousDriftMs)
      if (snippet.type !== 'ChangeBgm' && Math.abs(driftMs) > 250 && driftJumpMs > 100) {
        anomalies.push(
          `snippets[${index}] ${snippet.type} 时间线漂移 ${driftMs}ms（较上一句 +${driftJumpMs}ms，计划 ${plannedStartMs}ms，实际 ${actualStartMs}ms）`
        )
      }
      previousDriftMs = driftMs
    }
    if (
      durationDriftMs !== null &&
      Math.abs(durationDriftMs) > 500 &&
      snippet.type !== 'Talk' &&
      snippet.type !== 'ChangeBgm'
    ) {
      anomalies.push(
        `snippets[${index}] ${snippet.type} 实际时长 ${actualDuration}ms 与计划 ${plannedDuration}ms 相差 ${durationDriftMs}ms`
      )
    }

    const data = ((snippet as { data?: unknown }).data ?? {}) as {
      speaker?: string
      content?: string
      ttsText?: string
      motion?: string
      facial?: string
      modelId?: number
    }
    if (snippet.type === 'LayoutAppear') {
      // 没写 motion/facial 时 LayoutAppear 会走 startEntryMotion 的默认动作兜底，
      // 不是站桩；官方语料里大量 Appear 本来就不带动作，不能逐条报异常。
      layoutAppears++
    }
    if (snippet.type === 'LayoutClear') layoutClears++

    const actions = snippetActions(snippet, actualDuration ?? plannedDuration)
    if (snippet.type === 'Talk') {
      for (const action of actions) {
        if (action.at !== 0) {
          anomalies.push(`snippets[${index}] Talk 动作 at=${action.at}，官方在句首 at=0`)
        }
      }
    }

    const ttsDurationMs =
      snippet.type === 'Talk'
        ? (input.ttsResults.get(index)?.durationMs ?? planned?.ttsDurationMs ?? 0)
        : 0
    if (snippet.type === 'Talk') {
      ttsTotalMs += ttsDurationMs
      const ttsText = typeof data.ttsText === 'string' ? data.ttsText : ''
      const japanese = isJapaneseSpeechText(ttsText)
      const ttsActive = input.ttsEnabled !== false
      if (ttsActive && input.provider === 'irodori' && !japanese) {
        anomalies.push(`snippets[${index}] Talk 缺少日文 ttsText，Irodori 会拒绝合成`)
      }
      if (ttsActive && input.provider === 'irodori' && ttsDurationMs <= 0) {
        anomalies.push(`snippets[${index}] Talk 没有 TTS 时长，Irodori 合成可能失败`)
      }
      tts.push({
        index,
        speaker: typeof data.speaker === 'string' ? data.speaker : '',
        contentChars: (data.content ?? '').length,
        ttsTextChars: ttsText.length,
        japanese,
        durationMs: ttsDurationMs,
        plannedDurationMs: plannedDuration,
        synthesisText: (ttsText || data.content || '').slice(0, 120)
      })
    }

    diagnostics.push({
      index,
      type: snippet.type,
      wait: Boolean(snippet.wait),
      delayMs: Math.round(Math.max(0, snippet.delay) * 1000),
      plannedStartMs,
      plannedDurationMs: plannedDuration,
      actualStartMs,
      actualDurationMs: actualDuration,
      driftMs,
      durationDriftMs,
      durationSource: planned?.durationSource,
      ...(data.speaker ? { speaker: data.speaker } : {}),
      ...(data.content ? { content: data.content.slice(0, 200) } : {}),
      ...(data.ttsText ? { ttsText: data.ttsText.slice(0, 200) } : {}),
      japaneseTts: snippet.type === 'Talk' ? isJapaneseSpeechText(data.ttsText ?? '') : null,
      ttsDurationMs,
      actions
    })
  })

  const plan = bakeStoryPlan(input.snippets, input.timeline, {
    motionSettleMs: input.motionSettleMs
  })
  const approximations = [
    'Pass 2 使用 PixiJS + pixi-live2d-display-advanced，不是 SSE 的原生 wgpu/Cubism Native 渲染器',
    `剧情时钟 60 fps，编码 ${input.exportMeta.fps} fps；导出仍是单浏览器实时录制/虚拟时钟，未实现 --jobs N 分段并行`,
    '未实现 3D MV、完整 UGUI 图集、S3 资产库与硬件编码选择',
    '动作收尾闸门按已预加载的非循环剪辑时长估算；循环动作不参与',
    'ProgressBehavior=0 的片段在后台并发执行；Talk 仍串行以保证 TTS/字幕对位',
    '物理摆动由依赖的 model3.json 驱动，未逐帧复刻 SSE 的确定性物理积分'
  ]

  const motionStarts = input.motion.filter((event) => event.event === 'started').length
  const motionInterrupts = input.motion.filter((event) => event.event === 'interrupted')
  for (const event of motionInterrupts) {
    // 官方动作本来就是一整句一个 cue；短句/入场后第一句可能 500ms 就切换。
    // 只有 <400ms 才算“闪一下”（约 12 帧），值得写进 anomalies。
    // 入场动作被第一句台词接管是官方行为（Appear 只等淡入 7 帧），不算异常。
    const previousSnippet =
      event.snippetIndex > 0 ? input.snippets[event.snippetIndex - 1] : undefined
    if (previousSnippet?.type === 'LayoutAppear') continue
    if (event.playedMs !== undefined && event.playedMs < 400) {
      anomalies.push(
        `snippets[${event.snippetIndex}] 动作 ${event.name} 播放 ${Math.round(event.playedMs)}ms 就被打断（<400ms）`
      )
    }
  }

  const summary = {
    models: input.storyCounts?.models ?? 0,
    images: input.storyCounts?.images ?? 0,
    snippets: input.snippets.length,
    talks: input.snippets.filter((snippet) => snippet.type === 'Talk').length,
    plannedDurationMs: Math.round(plannedDurationMs),
    actualDurationMs: Math.round(actualDurationMs),
    avgAbsDriftMs: driftCount > 0 ? Math.round(driftSum / driftCount) : 0,
    ttsLines: tts.length,
    ttsTotalMs: Math.round(ttsTotalMs),
    motionEvents: input.motion.length,
    motionStarts,
    motionInterrupts: motionInterrupts.length,
    layoutAppears,
    layoutClears,
    logEntries: input.logs.length,
    anomalies: anomalies.length
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    export: input.exportMeta,
    summary,
    snippets: diagnostics,
    tts,
    motions: input.motion,
    plan,
    approximations,
    anomalies,
    logs: input.logs
  }
}
