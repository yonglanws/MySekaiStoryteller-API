import type { SnippetData } from '../../../common/types/Story'
import { snippetBlocksTimeline } from '../../../common/export/snippetSemantics'
import { calculateTalkDurationMs } from './TalkTiming'
import {
  APPEAR_FADE_TOTAL_MS,
  APPEAR_SHOWN_MOVE_MS,
  CHARACTER_FADE_MS,
  HIDE_IN_PLACE_TOTAL_MS,
  MOVE_DURATION_FAST_MS,
  MOVE_DURATION_NORMAL_MS,
  MOVE_DURATION_SLOW_MS,
  TALK_WINDOW_OPEN_CLOSE_MS,
  TELOP_TOTAL_MS,
  quantizeMsToFrame
} from '../../../common/official/timing'

export interface TimelineEntry {
  snippetIndex: number
  snippetType: string
  startTimeMs: number
  durationMs: number
  endTimeMs: number
  ttsDurationMs: number
  hasTTS: boolean
  /** 官方 ProgressBehavior=1：调度器等它结束；false 时片段在后台跑、时间线 0ms。 */
  blocking: boolean
  speaker?: string
  content?: string
  delay: number
  durationSource: DurationSource
  validationStatus: ValidationStatus
  validationDetails: string[]
}

export type DurationSource =
  | 'tts_audio'
  | 'content_estimation'
  | 'type_default'
  | 'data_duration'
  | 'delay_fallback'
  | 'emergency_fallback'

export type ValidationStatus = 'valid' | 'warning' | 'error'

export interface TimelineCalculationResult {
  entries: TimelineEntry[]
  totalDurationMs: number
  talkSnippetCount: number
  ttsSnippetCount: number
  totalTtsDurationMs: number
  validationSummary: TimelineValidationSummary
  traceLog: TimelineTraceRecord[]
}

export interface TimelineValidationSummary {
  totalEntries: number
  validCount: number
  warningCount: number
  errorCount: number
  crossValidationPassed: boolean
  anomaliesDetected: string[]
}

export interface TimelineTraceRecord {
  snippetIndex: number
  snippetType: string
  pathADurationMs: number
  pathBDurationMs: number
  finalDurationMs: number
  selectedSource: DurationSource
  pathADetail: string
  pathBDetail: string
  decisionReason: string
  timestamp: number
}

export interface TTSMapping {
  snippetIndex: number
  durationMs: number
  audioBuffer?: ArrayBuffer
  audioPath?: string
}

const MIN_DURATION_MS = 500
const MAX_DURATION_MS = 30000
const CROSS_VALIDATION_TOLERANCE_MS = 500
const EMERGENCY_FALLBACK_MS = 600

const SNIPPET_TYPE_DEFAULTS: Record<string, number> = {
  BlackOut: 600,
  BlackIn: 600,
  // 这些片段本身不做动画：实际 handleSnippet 只改状态/淡入淡出，时间线不能再按
  // 600~800ms 预算，否则每条都会累积几百毫秒的 planned/actual 漂移。
  ChangeBackgroundImage: 1,
  ChangeLayoutMode: 1,
  LayoutAppear: APPEAR_FADE_TOTAL_MS,
  LayoutClear: HIDE_IN_PLACE_TOTAL_MS,
  Move: MOVE_DURATION_NORMAL_MS,
  Motion: 100,
  HideTalk: 1,
  DoParam: 400,
  PlaySe: 0,
  StopSe: 0,
  ShakeScreen: 500,
  FlashbackIn: 100,
  FlashbackOut: 100,
  Wipe: 500,
  CameraMove: 0,
  CameraZoom: 0,
  AmbientColor: 1
}

/** 这些片段不走 MIN_DURATION_MS 的 500ms 下限：它们的真实耗时由转场/语音决定。 */
const FAST_DURATION_TYPES = new Set([
  'Talk',
  'ChangeBackgroundImage',
  'ChangeLayoutMode',
  'LayoutAppear',
  'LayoutClear',
  'Move',
  'HideTalk',
  'AmbientColor'
])

// 必须与 StageUtils.move_speed_to_num 完全一致，否则 LayoutAppear/LayoutClear/Move
// 的计划时长会比实际滑入多 400~500ms，日志里出现固定漂移。
const MOVE_SPEED_DURATION_MAP: Record<string, number> = {
  Slow: MOVE_DURATION_SLOW_MS,
  Normal: MOVE_DURATION_NORMAL_MS,
  Fast: MOVE_DURATION_FAST_MS,
  Immediate: 0
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getSnippetDataField(snippet: SnippetData, field: string): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (snippet as any).data?.[field]
}

function clampDuration(ms: number): number {
  return Math.min(Math.max(ms, MIN_DURATION_MS), MAX_DURATION_MS)
}

function calculatePathA_ContentBased(snippet: SnippetData): {
  durationMs: number
  source: DurationSource
  detail: string
} {
  switch (snippet.type) {
    case 'ChangeBgm':
    case 'PlaySe':
    case 'StopSe': {
      return {
        durationMs: 0,
        source: 'data_duration',
        detail: `${snippet.type}: zero-duration cue`
      }
    }
    case 'Talk': {
      const { content, ttsText, voice } = snippet.data
      const estimated = calculateTalkDurationMs(content, 0, ttsText, {
        hasVoice: Boolean(voice)
      })
      return {
        durationMs: estimated,
        source: 'content_estimation',
        detail: `Talk: ${content.length} display chars, ${(ttsText || content).length} speech chars = ${estimated}ms`
      }
    }
    case 'Telop': {
      // ScenarioTelopPlayer：in 0.333s + AUTO 停留 2s + out 0.333s，与文字长度无关。
      return {
        durationMs: TELOP_TOTAL_MS,
        source: 'data_duration',
        detail: `Telop: in/out 0.333s + auto hold 2s = ${TELOP_TOTAL_MS}ms`
      }
    }
    case 'BlackOut':
    case 'BlackIn':
    case 'ShakeScreen':
    case 'FlashbackIn':
    case 'FlashbackOut':
    case 'Wipe':
    case 'SideFade':
    case 'CameraMove':
    case 'CameraZoom': {
      const dataDur = getSnippetDataField(snippet, 'duration')
      if (dataDur && dataDur > 0) {
        // 官方 scenario 的 Duration 是秒（0.1/0.5/2），本项目 Story 用毫秒（100/500/2000）。
        // 以 10 为界：>=10 视为毫秒，<10 视为秒。旧阈值为 100，会把官方 0.1s
        // 转成的 100ms 再乘 1000 变成 100 秒。
        const ms = dataDur > 10 ? dataDur : dataDur * 1000
        return {
          durationMs: ms,
          source: 'data_duration',
          detail: `${snippet.type}: data.duration=${dataDur} → ${ms}ms`
        }
      }
      if (snippet.type === 'CameraMove' || snippet.type === 'CameraZoom') {
        return {
          durationMs: 0,
          source: 'data_duration',
          detail: `${snippet.type}: instant camera change`
        }
      }
      const def = SNIPPET_TYPE_DEFAULTS[snippet.type] ?? 600
      return {
        durationMs: def,
        source: 'type_default',
        detail: `${snippet.type}: no data.duration, type default=${def}ms`
      }
    }
    case 'ChangeLayoutMode':
    case 'ChangeBackgroundImage':
    case 'BackgroundBlur':
    case 'StopShake':
    case 'AmbientColor': {
      // 只改状态，不做过渡；实际耗时约 0ms（保留 1ms 让时间线完整性校验通过）。
      return {
        durationMs: 1,
        source: 'data_duration',
        detail: `${snippet.type}: state-only cue`
      }
    }
    case 'HideTalk': {
      return {
        durationMs: SNIPPET_TYPE_DEFAULTS.HideTalk,
        source: 'type_default',
        detail: `HideTalk: type default=${SNIPPET_TYPE_DEFAULTS.HideTalk}ms`
      }
    }
    case 'Move':
    case 'LayoutAppear':
    case 'LayoutClear': {
      const speed = getSnippetDataField(snippet, 'moveSpeed')
      const from = getSnippetDataField(snippet, 'from') as
        | { side?: string; offset?: number }
        | undefined
      const to = getSnippetDataField(snippet, 'to') as
        | { side?: string; offset?: number }
        | undefined
      const moved = Boolean(
        from &&
        to &&
        (from.side !== to.side || (Number(from.offset) || 0) !== (Number(to.offset) || 0))
      )
      const moveMs = speed && MOVE_SPEED_DURATION_MAP[speed] ? MOVE_SPEED_DURATION_MAP[speed] : 0
      if (snippet.type === 'LayoutAppear') {
        // 官方 Appear 在 1 帧 alpha=0 + 0.1s 淡入后就算完成；CharacterMoveTo 的滑入
        // 继续在后台播放，不阻塞下一条 Talk。
        return {
          durationMs: APPEAR_FADE_TOTAL_MS,
          source: 'content_estimation',
          detail: `LayoutAppear: fade ${APPEAR_FADE_TOTAL_MS}ms; move=${moveMs}ms continues`
        }
      }
      if (snippet.type === 'LayoutClear') {
        const ms = moved ? Math.max(CHARACTER_FADE_MS, moveMs) : HIDE_IN_PLACE_TOTAL_MS
        return {
          durationMs: ms,
          source: 'content_estimation',
          detail: moved
            ? `LayoutClear: slide ${moveMs}ms, fade starts at ${Math.max(0, moveMs - CHARACTER_FADE_MS)}ms`
            : `LayoutClear: in place, delay 150ms + fade 100ms = ${ms}ms`
        }
      }
      if (speed === 'Immediate') {
        return {
          durationMs: 0,
          source: 'data_duration',
          detail: 'Move: Immediate, no transition'
        }
      }
      if (!moved && !speed) {
        const def = SNIPPET_TYPE_DEFAULTS.Move
        return {
          durationMs: def,
          source: 'type_default',
          detail: `Move: no moveSpeed, type default=${def}ms`
        }
      }
      if (moveMs > 0) {
        return {
          durationMs: moveMs,
          source: 'content_estimation',
          detail: `Move: moveSpeed=${speed} → ${moveMs}ms`
        }
      }
      return {
        durationMs: 0,
        source: 'content_estimation',
        detail: 'Move: zero-length transition'
      }
    }
    case 'Motion': {
      if (getSnippetDataField(snippet, 'actions') !== undefined) {
        const duration = getSnippetDataField(snippet, 'duration') ?? 2
        return {
          durationMs: duration * 1000,
          source: 'data_duration',
          detail: `Motion sequence: duration=${duration}s`
        }
      }
      return {
        durationMs: SNIPPET_TYPE_DEFAULTS.Motion,
        source: 'type_default',
        detail: `Motion: type default=${SNIPPET_TYPE_DEFAULTS.Motion}ms`
      }
    }
    case 'DoParam': {
      const params = getSnippetDataField(snippet, 'params')
      if (Array.isArray(params) && params.length > 0) {
        const maxDur = Math.max(...params.map((p: { duration?: number }) => p.duration || 0))
        if (maxDur > 0) {
          const ms = maxDur * 1000
          return {
            durationMs: ms,
            source: 'data_duration',
            detail: `DoParam: max param duration=${maxDur}s → ${ms}ms`
          }
        }
      }
      const def = SNIPPET_TYPE_DEFAULTS[snippet.type] || EMERGENCY_FALLBACK_MS
      return {
        durationMs: def,
        source: 'type_default',
        detail: `DoParam: no param duration, type default=${def}ms`
      }
    }
    default: {
      const type = String((snippet as { type?: unknown }).type ?? 'unknown')
      const def = SNIPPET_TYPE_DEFAULTS[type]
      if (def) {
        return {
          durationMs: def,
          source: 'type_default',
          detail: `${type}: type default=${def}ms`
        }
      }
      return {
        durationMs: EMERGENCY_FALLBACK_MS,
        source: 'emergency_fallback',
        detail: `${type}: unknown type, emergency=${EMERGENCY_FALLBACK_MS}ms`
      }
    }
  }
}

function calculatePathB_DelayBased(snippet: SnippetData): {
  durationMs: number
  source: DurationSource
  detail: string
} {
  const delayMs = (snippet.delay || 0) * 1000
  if (delayMs >= MIN_DURATION_MS) {
    return {
      durationMs: delayMs,
      source: 'delay_fallback',
      detail: `delay=${snippet.delay}s → ${delayMs}ms`
    }
  }
  return {
    durationMs: EMERGENCY_FALLBACK_MS,
    source: 'emergency_fallback',
    detail: `delay=${snippet.delay}s too small, emergency=${EMERGENCY_FALLBACK_MS}ms`
  }
}

function crossValidate(
  pathA: { durationMs: number; source: DurationSource; detail: string },
  pathB: { durationMs: number; source: DurationSource; detail: string },
  snippet: SnippetData,
  ttsMapping: TTSMapping | undefined,
  windowOpenMs = 0
): {
  finalDurationMs: number
  selectedSource: DurationSource
  decisionReason: string
  warnings: string[]
} {
  const warnings: string[] = []
  let finalDurationMs: number
  let selectedSource: DurationSource
  let decisionReason: string

  if (snippet.type === 'ChangeBgm') {
    return {
      finalDurationMs: 0,
      selectedSource: 'data_duration',
      decisionReason: 'ChangeBgm is a zero-duration audio cue',
      warnings
    }
  }

  if (snippet.type === 'Talk') {
    const ttsDurationMs = ttsMapping?.durationMs ?? 0
    const hasTTS = Number.isFinite(ttsDurationMs) && ttsDurationMs > 0
    const { content, ttsText, voice } = snippet.data
    return {
      finalDurationMs: calculateTalkDurationMs(content, ttsDurationMs, ttsText, {
        hasVoice: Boolean(voice),
        windowOpenMs
      }),
      selectedSource: hasTTS ? 'tts_audio' : 'content_estimation',
      decisionReason: 'Shared dialogue body timing; pre-dialogue delay is handled separately',
      warnings
    }
  } else {
    const diff = Math.abs(pathA.durationMs - pathB.durationMs)

    if (pathA.source === 'data_duration') {
      // data_duration 是精确值，优先使用
      finalDurationMs = pathA.durationMs
      selectedSource = pathA.source
      decisionReason = `PathA has data_duration(${pathA.durationMs}ms), using exact value`
    } else if (pathA.source === 'content_estimation') {
      // 布局/转场的 content_estimation 已经是按官方常量算出的精确 body 时长；
      // snippet.delay 是 BaseSnippet 在 body 之前的独立等待，不能拿来平均，
      // 否则 Clear 750ms + delay 500ms 会被折成 633ms，淡出帧还会越过 endFrame。
      finalDurationMs = pathA.durationMs
      selectedSource = pathA.source
      decisionReason = `Using PathA content estimation(${pathA.durationMs}ms)`
    } else if (pathA.source === 'type_default') {
      // type_default 时，如果delay合理则使用delay
      if (pathB.durationMs >= 200 && pathB.durationMs < pathA.durationMs * 2) {
        finalDurationMs = pathB.durationMs
        selectedSource = pathB.source
        decisionReason = `PathB delay(${pathB.durationMs}ms) used over type_default(${pathA.durationMs}ms)`
      } else {
        finalDurationMs = pathA.durationMs
        selectedSource = pathA.source
        decisionReason = `Using PathA type_default(${pathA.durationMs}ms)`
      }
    } else if (pathB.source === 'delay_fallback' && pathB.durationMs > pathA.durationMs) {
      finalDurationMs = pathB.durationMs
      selectedSource = pathB.source
      decisionReason = `PathB delay(${pathB.durationMs}ms) > PathA(${pathA.durationMs}ms), delay takes precedence`
    } else {
      finalDurationMs = pathA.durationMs
      selectedSource = pathA.source
      decisionReason = `Using PathA(${pathA.source}=${pathA.durationMs}ms)`
    }

    if (diff > CROSS_VALIDATION_TOLERANCE_MS) {
      warnings.push(
        `Large discrepancy: pathA=${pathA.durationMs}ms vs pathB=${pathB.durationMs}ms (diff=${diff}ms)`
      )
    }
  }

  // data_duration 是官方精确值：WhiteIn/WhiteOut 常见 0.1s，Wipe 0.4s，CameraMove/Zoom
  // 甚至 0s。旧逻辑把它们统一钳到 500ms，画面已经结束但时间线还在等，逐句累积漂移。
  if (pathA.source === 'data_duration') {
    finalDurationMs = Math.max(0, finalDurationMs)
  } else if (
    !(snippet.type === 'Motion' && snippet.data.actions !== undefined) &&
    !FAST_DURATION_TYPES.has(snippet.type)
  ) {
    finalDurationMs = clampDuration(finalDurationMs)
  } else if (FAST_DURATION_TYPES.has(snippet.type)) {
    finalDurationMs = Math.max(1, finalDurationMs)
  }

  return { finalDurationMs, selectedSource, decisionReason, warnings }
}

export function calculateTimeline(
  snippets: SnippetData[],
  ttsMappings: Map<number, TTSMapping> = new Map()
): TimelineCalculationResult {
  const entries: TimelineEntry[] = []
  const traceLog: TimelineTraceRecord[] = []
  const anomalies: string[] = []
  let currentTimeMs = 0
  let talkSnippetCount = 0
  let ttsSnippetCount = 0
  let totalTtsDurationMs = 0
  let validCount = 0
  let warningCount = 0
  let errorCount = 0
  // TalkWindow 初始关闭；HideTalk 关闭；首句/关闭后第一句要等 0.2s 打开动画。
  let windowOpen = false
  // 官方 Appear/Hide 分支依赖角色当前是否在场：已在场 Appear 只滑 0.2s，
  // 未在场 Clear 直接 onFinished。时间线必须和运行时使用同一份在场状态。
  const visibleModels = new Set<number>()

  if (snippets.length === 0) {
    return {
      entries: [],
      totalDurationMs: 0,
      talkSnippetCount: 0,
      ttsSnippetCount: 0,
      totalTtsDurationMs: 0,
      validationSummary: {
        totalEntries: 0,
        validCount: 0,
        warningCount: 0,
        errorCount: 0,
        crossValidationPassed: true,
        anomaliesDetected: []
      },
      traceLog: []
    }
  }

  for (let i = 0; i < snippets.length; i++) {
    const snippet = snippets[i]
    const ttsMapping = ttsMappings.get(i)
    const isTalk = snippet.type === 'Talk'
    const hasTTS =
      isTalk && !!ttsMapping && Number.isFinite(ttsMapping.durationMs) && ttsMapping.durationMs > 0

    const pathA = calculatePathA_ContentBased(snippet)
    const pathB = calculatePathB_DelayBased(snippet)

    let windowOpenMs = 0
    if (isTalk && !windowOpen) {
      // 官方 TalkWindow.Play：窗口关闭时先 PlayActive(1, 0.2)，OnCompleteOpen 才开始打字。
      windowOpenMs = TALK_WINDOW_OPEN_CLOSE_MS
      windowOpen = true
    } else if (snippet.type === 'HideTalk') {
      windowOpen = false
    }

    const crossResult = crossValidate(pathA, pathB, snippet, ttsMapping, windowOpenMs)

    let ttsDurationMs = 0
    if (hasTTS) {
      ttsDurationMs = ttsMapping!.durationMs
      ttsSnippetCount++
      totalTtsDurationMs += ttsDurationMs
    }

    if (isTalk) {
      talkSnippetCount++
    }

    const validationDetails: string[] = [...crossResult.warnings]

    let validationStatus: ValidationStatus = 'valid'
    if (crossResult.warnings.length > 0) {
      validationStatus = 'warning'
      warningCount++
    } else {
      validCount++
    }

    if (crossResult.selectedSource === 'emergency_fallback') {
      validationStatus = 'error'
      errorCount++
      validCount = Math.max(0, validCount - (crossResult.warnings.length > 0 ? 1 : 0))
      warningCount = Math.max(0, warningCount - (crossResult.warnings.length > 0 ? 1 : 0))
      anomalies.push(`Snippet[${i}] ${snippet.type}: emergency fallback used, both paths failed`)
    }

    if (i > 0) {
      const prevEntry = entries[i - 1]
      if (Math.abs(prevEntry.endTimeMs - currentTimeMs) > 1) {
        anomalies.push(
          `Snippet[${i}] time gap: prev endTime=${prevEntry.endTimeMs}ms vs current start=${currentTimeMs}ms`
        )
      }
    }

    // 剧情按 60 fps 运行；非零时长统一量化到帧，计划与实际共用同一时间基。
    // 1ms 的状态 cue 保持 1ms，避免为了对齐帧而制造 16ms 的假转场。
    const blocking = snippetBlocksTimeline(snippet)
    // 官方 Appear/Hide 的在场分支：已在场 Appear 只滑 0.2s；未在场 Clear 立即完成。
    let layoutDurationMs: number | null = null
    let layoutDecision = ''
    if (snippet.type === 'LayoutAppear') {
      const modelId = Number(getSnippetDataField(snippet, 'modelId'))
      const shown = visibleModels.has(modelId)
      layoutDurationMs = shown ? APPEAR_SHOWN_MOVE_MS : APPEAR_FADE_TOTAL_MS
      layoutDecision = shown
        ? 'LayoutAppear: character already shown, CharacterMoveTo 0.2s'
        : 'LayoutAppear: new view, 1 frame alpha=0 + 0.1s fade'
      visibleModels.add(modelId)
    } else if (snippet.type === 'LayoutClear') {
      const modelId = Number(getSnippetDataField(snippet, 'modelId'))
      const shown = visibleModels.has(modelId)
      layoutDurationMs = shown ? null : 0
      layoutDecision = shown ? '' : 'LayoutClear: character not shown, OnFinished immediately'
      visibleModels.delete(modelId)
    }

    const baseDurationMs = layoutDurationMs ?? crossResult.finalDurationMs
    const finalDurationMs = blocking
      ? baseDurationMs >= 30
        ? quantizeMsToFrame(baseDurationMs)
        : baseDurationMs
      : 0

    const entry: TimelineEntry = {
      snippetIndex: i,
      snippetType: snippet.type,
      startTimeMs: currentTimeMs,
      durationMs: finalDurationMs,
      endTimeMs: currentTimeMs + finalDurationMs,
      ttsDurationMs,
      hasTTS,
      blocking,
      speaker: isTalk ? getSnippetDataField(snippet, 'speaker') : undefined,
      content: isTalk ? getSnippetDataField(snippet, 'content') : undefined,
      delay: snippet.delay,
      durationSource: crossResult.selectedSource,
      validationStatus,
      validationDetails
    }

    entries.push(entry)

    traceLog.push({
      snippetIndex: i,
      snippetType: snippet.type,
      pathADurationMs: pathA.durationMs,
      pathBDurationMs: pathB.durationMs,
      finalDurationMs,
      selectedSource: crossResult.selectedSource,
      pathADetail: pathA.detail,
      pathBDetail: pathB.detail,
      decisionReason: layoutDecision
        ? layoutDecision
        : blocking
          ? crossResult.decisionReason
          : 'ProgressBehavior=0: snippet runs in background; scheduler does not wait',
      timestamp: Date.now()
    })

    currentTimeMs += finalDurationMs
  }

  const crossValidationPassed = errorCount === 0

  return {
    entries,
    totalDurationMs: currentTimeMs,
    talkSnippetCount,
    ttsSnippetCount,
    totalTtsDurationMs,
    validationSummary: {
      totalEntries: entries.length,
      validCount,
      warningCount,
      errorCount,
      crossValidationPassed,
      anomaliesDetected: anomalies
    },
    traceLog
  }
}

export function calculateTimelineWithoutTTS(snippets: SnippetData[]): TimelineCalculationResult {
  return calculateTimeline(snippets, new Map())
}

export function estimateSnippetDuration(snippet: SnippetData): number {
  if (snippet.type === 'ChangeBgm') return 0
  if (snippet.type === 'Talk') {
    return calculateTalkDurationMs(snippet.data.content, 0, snippet.data.ttsText, {
      hasVoice: Boolean(snippet.data.voice)
    })
  }
  const pathA = calculatePathA_ContentBased(snippet)
  if (FAST_DURATION_TYPES.has(snippet.type)) return pathA.durationMs
  const pathB = calculatePathB_DelayBased(snippet)
  return Math.max(pathA.durationMs, pathB.durationMs)
}

export function buildTTSMappingsFromAudioTracks(
  audioTracks: Array<{
    startTime: number
    endTime: number
    characterName: string
    text: string
    audioBuffer: ArrayBuffer
  }>,
  timelineEntries: TimelineEntry[]
): Map<number, TTSMapping> {
  const mappings = new Map<number, TTSMapping>()

  for (const entry of timelineEntries) {
    if (entry.snippetType !== 'Talk') continue

    const matchingTrack = audioTracks.find(
      (track) =>
        Math.abs(track.startTime - entry.startTimeMs) < 1000 &&
        track.characterName === (entry.speaker || '')
    )

    if (matchingTrack) {
      const durationMs = matchingTrack.endTime - matchingTrack.startTime
      if (durationMs > 0) {
        mappings.set(entry.snippetIndex, {
          snippetIndex: entry.snippetIndex,
          durationMs,
          audioBuffer: matchingTrack.audioBuffer
        })
      }
    }
  }

  return mappings
}

export function remapAudioTracksToTimeline(
  audioTracks: Array<{
    startTime: number
    endTime: number
    characterName: string
    text: string
    audioBuffer: ArrayBuffer
  }>,
  timeline: TimelineEntry[]
): Array<{
  startTime: number
  endTime: number
  characterName: string
  text: string
  audioBuffer: ArrayBuffer
}> {
  const lastTrack = audioTracks[audioTracks.length - 1]
  if (!lastTrack) return audioTracks

  const timelineTotalMs = timeline.length > 0 ? timeline[timeline.length - 1].endTimeMs : 0
  const originalTtsEndMs = lastTrack.endTime

  if (originalTtsEndMs <= 0 || timelineTotalMs <= 0) return audioTracks

  const scaleFactor = timelineTotalMs / originalTtsEndMs

  if (Math.abs(scaleFactor - 1.0) < 0.01) return audioTracks

  return audioTracks.map((track) => ({
    ...track,
    startTime: Math.round(track.startTime * scaleFactor),
    endTime: Math.round(track.endTime * scaleFactor)
  }))
}

export function getTransitionSnippets(snippets: SnippetData[]): number[] {
  const indices: number[] = []
  for (let i = 0; i < snippets.length; i++) {
    if ((snippets[i] as { type?: string }).type === 'Transition') {
      indices.push(i)
    }
  }
  return indices
}

export function estimateStoryDuration(snippets: SnippetData[]): number {
  let totalMs = 0
  for (const snippet of snippets) {
    totalMs += estimateSnippetDuration(snippet)
  }
  return totalMs
}

export function getSnippetTypeDistribution(snippets: SnippetData[]): Record<string, number> {
  const distribution: Record<string, number> = {}
  for (const snippet of snippets) {
    distribution[snippet.type] = (distribution[snippet.type] || 0) + 1
  }
  return distribution
}

export function validateTimelineIntegrity(entries: TimelineEntry[]): {
  valid: boolean
  errors: string[]
} {
  const errors: string[] = []

  if (entries.length === 0) {
    return { valid: true, errors: [] }
  }

  if (entries[0].startTimeMs !== 0) {
    errors.push(`First entry startTimeMs=${entries[0].startTimeMs}, expected 0`)
  }

  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1]
    const curr = entries[i]

    if (curr.snippetIndex !== i) {
      errors.push(`Entry[${i}] snippetIndex=${curr.snippetIndex}, expected ${i}`)
    }

    if (Math.abs(curr.startTimeMs - prev.endTimeMs) > 1) {
      errors.push(`Entry[${i}] startTimeMs=${curr.startTimeMs} != prev endTimeMs=${prev.endTimeMs}`)
    }

    if (
      curr.durationMs <= 0 &&
      curr.snippetType !== 'ChangeBgm' &&
      curr.snippetType !== 'LayoutClear' &&
      curr.durationSource !== 'data_duration' &&
      curr.blocking
    ) {
      errors.push(`Entry[${i}] durationMs=${curr.durationMs} <= 0`)
    }

    if (Math.abs(curr.endTimeMs - (curr.startTimeMs + curr.durationMs)) > 1) {
      errors.push(
        `Entry[${i}] endTimeMs=${curr.endTimeMs} != startTimeMs(${curr.startTimeMs}) + durationMs(${curr.durationMs})`
      )
    }

    if (curr.hasTTS && curr.ttsDurationMs <= 0) {
      errors.push(`Entry[${i}] hasTTS=true but ttsDurationMs=${curr.ttsDurationMs}`)
    }

    if (curr.hasTTS && curr.durationMs < curr.ttsDurationMs) {
      errors.push(`Entry[${i}] durationMs=${curr.durationMs} < ttsDurationMs=${curr.ttsDurationMs}`)
    }
  }

  return { valid: errors.length === 0, errors }
}
