import type { SnippetData } from '../../../common/types/Story'
import { snippetBlocksTimeline } from '../../../common/export/snippetSemantics'
import { calculateTalkDurationMs } from './TalkTiming'
import { visibleTextLength } from '../../../common/official/text'
import { hasSpeakableSpeechText } from '../../../common/tts/speechText'
import {
  APPEAR_FADE_TOTAL_MS,
  APPEAR_SHOWN_MOVE_MS,
  CHARACTER_FADE_MS,
  CHARACTER_SHAKE_MS,
  FLASHBACK_DEFAULT_MS,
  FRAME_MS,
  FULLSCREEN_BARS_MS,
  FULLSCREEN_CHAR_FADE_MS,
  FULLSCREEN_TEXT_HOLD_MS,
  FULLSCREEN_TEXT_PRE_DELAY_MS,
  HIDE_DELAY_IN_PLACE_MS,
  HIDE_IN_PLACE_TOTAL_MS,
  MOVE_DURATION_FAST_MS,
  MOVE_DURATION_NORMAL_MS,
  MOVE_DURATION_SLOW_MS,
  PLACE_INFO_TRANSITION_MS,
  SEKAI_IN_PRE_DELAY_MS,
  SEKAI_OUT_PRE_DELAY_MS,
  SEPIA_DEFAULT_MS,
  SILENT_PUNCTUATION_HOLD_MS,
  SIMPLE_SELECTABLE_TOTAL_MS,
  TALK_WINDOW_OPEN_CLOSE_MS,
  TELOP_TOTAL_MS,
  framesForSeconds,
  framesToMs,
  normalizeEffectDurationMs,
  quantizeMsToFrame,
  resolveCharacterFadeMs
} from '../../../common/official/timing'

export interface TimelineEntry {
  snippetIndex: number
  snippetType: string
  delayStartTimeMs?: number
  startTimeMs: number
  durationMs: number
  endTimeMs: number
  ttsDurationMs: number
  hasTTS: boolean
  /** 官方 ProgressBehavior=1（或 Talk）：触发前置栅栏；false 时与前一条同帧并发。 */
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

export interface TimelineOptions {
  exportFps?: number
  ttsEnabled?: boolean
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
  Motion: 0,
  HideTalk: 1,
  DoParam: 400,
  PlaySe: 0,
  StopSe: 0,
  ShakeScreen: 500,
  ShakeWindow: 500,
  StopShakeScreen: 0,
  StopShakeWindow: 0,
  StopShake: 1,
  FlashbackIn: FLASHBACK_DEFAULT_MS,
  FlashbackOut: FLASHBACK_DEFAULT_MS,
  SepiaIn: SEPIA_DEFAULT_MS,
  SepiaOut: SEPIA_DEFAULT_MS,
  Wipe: 500,
  CameraMove: 0,
  CameraZoom: 0,
  DollyZoom: 500,
  AmbientColor: 1,
  CharacterShake: CHARACTER_SHAKE_MS,
  PlaceInfo: PLACE_INFO_TRANSITION_MS,
  SimpleSelectable: SIMPLE_SELECTABLE_TOTAL_MS
}

/** 这些片段不走 MIN_DURATION_MS 的 500ms 下限：它们的真实耗时由转场/语音决定。 */
const FAST_DURATION_TYPES = new Set([
  'Talk',
  'ChangeBackgroundImage',
  'ChangeLayoutMode',
  'LayoutAppear',
  'LayoutClear',
  'LayoutDepth',
  'CharacterShake',
  'CostumeChange',
  'Move',
  'Motion',
  'HideTalk',
  'AmbientColor',
  'PlaceInfo',
  'FullScreenText',
  'SimpleSelectable',
  'SepiaIn',
  'SepiaOut',
  'SekaiIn',
  'SekaiOut',
  'SideFade',
  'AttachCharacterShader',
  'PlayScenarioEffect',
  'StopScenarioEffect',
  'BlurIn',
  'BlurOut',
  'BackgroundBlur',
  'DollyZoom',
  'ShakeWindow',
  'StopShakeWindow',
  'StopShakeScreen',
  'StopShake',
  'BgmVolume',
  'Movie'
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

function estimateFullScreenTextMs(text: string, keepBars?: boolean): number {
  const barMs = keepBars ? 0 : FULLSCREEN_BARS_MS * 2
  const textFadeMs = visibleTextLength(text) * FULLSCREEN_CHAR_FADE_MS
  return barMs + FULLSCREEN_TEXT_PRE_DELAY_MS + textFadeMs + FULLSCREEN_TEXT_HOLD_MS
}

function layoutPositionMoved(
  from: { side?: string; offset?: number; under?: boolean } | undefined,
  to: { side?: string; offset?: number; under?: boolean } | undefined
): boolean {
  if (!from || !to) return false
  return (
    (from.side ?? 'Center') !== (to.side ?? 'Center') ||
    (Number(from.offset) || 0) !== (Number(to.offset) || 0) ||
    Boolean(from.under) !== Boolean(to.under)
  )
}

function calculatePathA_ContentBased(snippet: SnippetData): {
  durationMs: number
  source: DurationSource
  detail: string
} {
  switch (snippet.type) {
    case 'ChangeBgm':
    case 'PlaySe':
    case 'StopSe':
    case 'BgmVolume':
    case 'LayoutDepth':
    case 'CostumeChange':
    case 'AttachCharacterShader':
    case 'PlayScenarioEffect':
    case 'StopScenarioEffect':
    case 'StopShakeScreen':
    case 'StopShakeWindow': {
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
    case 'PlaceInfo': {
      const dataDur = getSnippetDataField(snippet, 'duration')
      const ms =
        dataDur !== undefined && dataDur > 0
          ? normalizeEffectDurationMs(dataDur, PLACE_INFO_TRANSITION_MS)
          : PLACE_INFO_TRANSITION_MS
      return {
        durationMs: ms,
        source: 'data_duration',
        detail: `PlaceInfo: ${ms}ms`
      }
    }
    case 'FullScreenText': {
      const dataDur = getSnippetDataField(snippet, 'duration')
      const ms =
        dataDur !== undefined && dataDur > 0
          ? normalizeEffectDurationMs(dataDur)
          : estimateFullScreenTextMs(
              String(getSnippetDataField(snippet, 'text') ?? ''),
              Boolean(getSnippetDataField(snippet, 'keepBars'))
            )
      return {
        durationMs: ms,
        source: 'data_duration',
        detail: `FullScreenText: ${ms}ms`
      }
    }
    case 'SimpleSelectable': {
      return {
        durationMs: SIMPLE_SELECTABLE_TOTAL_MS,
        source: 'data_duration',
        detail: `SimpleSelectable: ${SIMPLE_SELECTABLE_TOTAL_MS}ms`
      }
    }
    case 'CharacterShake': {
      return {
        durationMs: CHARACTER_SHAKE_MS,
        source: 'data_duration',
        detail: `CharacterShake: ${CHARACTER_SHAKE_MS}ms`
      }
    }
    case 'SekaiIn':
    case 'SekaiOut': {
      const dataDur = getSnippetDataField(snippet, 'duration')
      const fadeMs =
        dataDur !== undefined ? normalizeEffectDurationMs(dataDur, 500) : 500
      const preDelayMs =
        snippet.type === 'SekaiIn' ? SEKAI_IN_PRE_DELAY_MS : SEKAI_OUT_PRE_DELAY_MS
      const ms = preDelayMs + fadeMs
      return {
        durationMs: ms,
        source: 'data_duration',
        detail: `${snippet.type}: preDelay ${preDelayMs}ms + fade ${fadeMs}ms = ${ms}ms`
      }
    }
    case 'SepiaIn':
    case 'SepiaOut':
    case 'BlurIn':
    case 'BlurOut':
    case 'DollyZoom':
    case 'ShakeWindow': {
      const dataDur = getSnippetDataField(snippet, 'duration')
      const def = SNIPPET_TYPE_DEFAULTS[snippet.type] ?? 300
      const ms = dataDur !== undefined ? normalizeEffectDurationMs(dataDur, def) : def
      return {
        durationMs: ms,
        source: 'data_duration',
        detail: `${snippet.type}: ${ms}ms`
      }
    }
    case 'Movie': {
      const dataDur = getSnippetDataField(snippet, 'duration')
      const ms =
        typeof dataDur === 'number' && dataDur > 0
          ? dataDur > 300
            ? dataDur
            : dataDur * 1000
          : 0
      return {
        durationMs: ms,
        source: 'data_duration',
        detail: `Movie: ${ms}ms`
      }
    }
    case 'BackgroundBlur': {
      const dataDur = getSnippetDataField(snippet, 'duration')
      const ms =
        typeof dataDur === 'number' && dataDur > 0 ? normalizeEffectDurationMs(dataDur, 1) : 1
      return {
        durationMs: ms,
        source: 'data_duration',
        detail: `BackgroundBlur: ${ms}ms`
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
      if (dataDur === 0 && (snippet.type === 'BlackOut' || snippet.type === 'BlackIn')) {
        return {
          durationMs: 0,
          source: 'data_duration',
          detail: `${snippet.type}: data.duration=0 → 0ms`
        }
      }
      if (dataDur !== undefined && dataDur > 0) {
        // 官方 scenario 的 Duration 是秒（0.1/0.5/2），本项目 Story 用毫秒（100/500/2000）。
        // 以 10 为界：>=10 视为毫秒，<10 视为秒。
        const ms = normalizeEffectDurationMs(dataDur)
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
    case 'StopShake':
    case 'AmbientColor': {
      // 只改状态/异步切换背景；实际片段不阻塞（保留 1ms 让旧时间线检查通过）。
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
        | { side?: string; offset?: number; under?: boolean }
        | undefined
      const to = getSnippetDataField(snippet, 'to') as
        | { side?: string; offset?: number; under?: boolean }
        | undefined
      const moved = layoutPositionMoved(from, to)
      const moveMs = speed && MOVE_SPEED_DURATION_MAP[speed] ? MOVE_SPEED_DURATION_MAP[speed] : 0
      if (snippet.type === 'LayoutAppear') {
        // 官方 Appear 在 1 帧 alpha=0 + 0.1s 淡入后就算完成；CharacterMoveTo 的滑入
        // 继续在后台播放，不阻塞下一条，但仍在 Talk Gate 里等待。
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
      // 官方 CharacterMotion（Action=4）：触发动作即刻结束（0 帧阻塞）。
      return {
        durationMs: 0,
        source: 'data_duration',
        detail: 'Motion: immediate cue (0ms)'
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
      if (def !== undefined) {
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
  windowOpenMs = 0,
  layoutRunningMs = 0,
  silentHoldMs?: number
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
        windowOpenMs,
        layoutRunningMs,
        silentHoldMs
      }),
      selectedSource: hasTTS ? 'tts_audio' : 'content_estimation',
      decisionReason: 'Shared dialogue body timing; pre-dialogue delay is handled separately',
      warnings
    }
  } else {
    const diff = Math.abs(pathA.durationMs - pathB.durationMs)

    if (pathA.source === 'data_duration') {
      finalDurationMs = pathA.durationMs
      selectedSource = pathA.source
      decisionReason = `PathA has data_duration(${pathA.durationMs}ms), using exact value`
    } else if (pathA.source === 'content_estimation') {
      finalDurationMs = pathA.durationMs
      selectedSource = pathA.source
      decisionReason = `Using PathA content estimation(${pathA.durationMs}ms)`
    } else if (pathA.source === 'type_default') {
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

  if (pathA.source === 'data_duration') {
    finalDurationMs = Math.max(0, finalDurationMs)
  } else if (
    !(snippet.type === 'Motion' && snippet.data.actions !== undefined) &&
    !FAST_DURATION_TYPES.has(snippet.type)
  ) {
    finalDurationMs = clampDuration(finalDurationMs)
  } else if (FAST_DURATION_TYPES.has(snippet.type)) {
    finalDurationMs =
      snippet.type === 'Motion' ||
      snippet.type === 'Move' ||
      snippet.type === 'LayoutClear' ||
      snippet.type === 'LayoutDepth' ||
      snippet.type === 'CostumeChange' ||
      snippet.type === 'AttachCharacterShader' ||
      snippet.type === 'PlayScenarioEffect' ||
      snippet.type === 'StopScenarioEffect' ||
      snippet.type === 'StopShakeWindow' ||
      snippet.type === 'StopShakeScreen' ||
      snippet.type === 'BgmVolume' ||
      snippet.type === 'Movie'
        ? Math.max(0, finalDurationMs)
        : Math.max(1, finalDurationMs)
  }

  return { finalDurationMs, selectedSource, decisionReason, warnings }
}

export function calculateTimeline(
  snippets: SnippetData[],
  ttsMappings: Map<number, TTSMapping> = new Map(),
  options: TimelineOptions = {}
): TimelineCalculationResult {
  const entries: TimelineEntry[] = []
  const traceLog: TimelineTraceRecord[] = []
  const anomalies: string[] = []
  const isExport = options.exportFps !== undefined
  const fadeMs = isExport ? resolveCharacterFadeMs(true, options.exportFps) : CHARACTER_FADE_MS
  let cursorMs = 0
  let runningEndMs = 0
  let activeLayoutEndMs = 0
  let talkSnippetCount = 0
  let ttsSnippetCount = 0
  let totalTtsDurationMs = 0
  let validCount = 0
  let warningCount = 0
  let errorCount = 0
  // TalkWindow 初始关闭；HideTalk / closeWindowOnFinish 关闭；关闭后第一句要等 0.2s 打开动画。
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

    // 官方 PlayCore 前置栅栏：WaitFinished（及 Talk）在启动和 delay 开始前，
    // 先等所有正在运行的后台任务结束；之后立即推进到下一条（Now 同帧并发）。
    const blocking = snippetBlocksTimeline(snippet)
    if (blocking) {
      cursorMs = Math.max(cursorMs, runningEndMs)
    }

    const delaySeconds = Math.max(0, Number(snippet.delay) || 0)
    const delayMs = framesToMs(framesForSeconds(delaySeconds))
    const delayStartTimeMs = cursorMs
    const startTimeMs = delayStartTimeMs + delayMs

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

    const layoutRunningMs = isTalk ? Math.max(0, activeLayoutEndMs - startTimeMs) : 0
    const silentHoldMs =
      isExport &&
      options.ttsEnabled !== false &&
      snippet.type === 'Talk' &&
      !hasTTS &&
      !snippet.data.voice &&
      !hasSpeakableSpeechText(snippet.data.content) &&
      !hasSpeakableSpeechText(snippet.data.ttsText ?? '')
        ? SILENT_PUNCTUATION_HOLD_MS
        : undefined
    const crossResult = crossValidate(
      pathA,
      pathB,
      snippet,
      ttsMapping,
      windowOpenMs,
      layoutRunningMs,
      silentHoldMs
    )

    if (isTalk && snippet.data.closeWindowOnFinish) {
      windowOpen = false
    }

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

    // 官方 Appear/Hide 的在场分支：已在场 Appear 只滑 0.2s；未在场 Clear 立即完成。
    let layoutDurationMs: number | null = null
    let layoutDecision = ''
    if (snippet.type === 'LayoutAppear') {
      const modelId = Number(getSnippetDataField(snippet, 'modelId'))
      const shown = visibleModels.has(modelId)
      const speed = getSnippetDataField(snippet, 'moveSpeed')
      const from = getSnippetDataField(snippet, 'from')
      const to = getSnippetDataField(snippet, 'to')
      const moved = layoutPositionMoved(from, to)
      const moveMs = speed && MOVE_SPEED_DURATION_MAP[speed] ? MOVE_SPEED_DURATION_MAP[speed] : 0
      const appearFadeTotalMs = isExport ? FRAME_MS + fadeMs : APPEAR_FADE_TOTAL_MS
      layoutDurationMs = shown
        ? APPEAR_SHOWN_MOVE_MS
        : isExport
          ? Math.max(appearFadeTotalMs, moved ? moveMs : 0)
          : appearFadeTotalMs
      layoutDecision = shown
        ? 'LayoutAppear: character already shown, CharacterMoveTo 0.2s'
        : isExport
          ? 'LayoutAppear: export synchronized fade + slide'
          : 'LayoutAppear: new view, 1 frame alpha=0 + 0.1s fade'
      const slideMs = shown
        ? APPEAR_SHOWN_MOVE_MS
        : Math.max(appearFadeTotalMs, moved ? moveMs : 0)
      activeLayoutEndMs = Math.max(
        activeLayoutEndMs,
        startTimeMs + (slideMs >= 30 ? quantizeMsToFrame(slideMs) : slideMs)
      )
      visibleModels.add(modelId)
    } else if (snippet.type === 'LayoutClear') {
      const modelId = Number(getSnippetDataField(snippet, 'modelId'))
      const shown = visibleModels.has(modelId)
      const speed = getSnippetDataField(snippet, 'moveSpeed')
      const from = getSnippetDataField(snippet, 'from')
      const to = getSnippetDataField(snippet, 'to')
      const moved = layoutPositionMoved(from, to)
      const moveMs = speed && MOVE_SPEED_DURATION_MAP[speed] ? MOVE_SPEED_DURATION_MAP[speed] : 0
      const clearMs = isExport
        ? moved
          ? Math.max(fadeMs, moveMs)
          : HIDE_DELAY_IN_PLACE_MS + fadeMs
        : crossResult.finalDurationMs
      layoutDurationMs = shown ? (isExport ? clearMs : null) : 0
      layoutDecision = shown ? '' : 'LayoutClear: character not shown, OnFinished immediately'
      if (shown) {
        const quantizedClearMs = clearMs >= 30 ? quantizeMsToFrame(clearMs) : clearMs
        activeLayoutEndMs = Math.max(activeLayoutEndMs, startTimeMs + quantizedClearMs)
      }
      visibleModels.delete(modelId)
    } else if (snippet.type === 'Move') {
      const moveMs =
        crossResult.finalDurationMs >= 30
          ? quantizeMsToFrame(crossResult.finalDurationMs)
          : crossResult.finalDurationMs
      activeLayoutEndMs = Math.max(activeLayoutEndMs, startTimeMs + moveMs)
    }

    const baseDurationMs = layoutDurationMs ?? crossResult.finalDurationMs
    const finalDurationMs =
      baseDurationMs >= 30 ? quantizeMsToFrame(baseDurationMs) : baseDurationMs
    const endTimeMs = startTimeMs + finalDurationMs

    const entry: TimelineEntry = {
      snippetIndex: i,
      snippetType: snippet.type,
      delayStartTimeMs,
      startTimeMs,
      durationMs: finalDurationMs,
      endTimeMs,
      ttsDurationMs,
      hasTTS,
      blocking,
      speaker: isTalk ? getSnippetDataField(snippet, 'speaker') : undefined,
      content: isTalk ? getSnippetDataField(snippet, 'content') : undefined,
      delay: snippet.delay ?? 0,
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
          : 'ProgressBehavior=0: starts immediately alongside active tasks',
      timestamp: Date.now()
    })

    runningEndMs = Math.max(runningEndMs, endTimeMs)
  }

  const crossValidationPassed = errorCount === 0
  const totalDurationMs = Math.max(cursorMs, runningEndMs)

  return {
    entries,
    totalDurationMs,
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

export function calculateTimelineWithoutTTS(
  snippets: SnippetData[],
  options: TimelineOptions = {}
): TimelineCalculationResult {
  return calculateTimeline(snippets, new Map(), options)
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

  const timelineTotalMs = timeline.reduce((max, entry) => Math.max(max, entry.endTimeMs), 0)
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

  if (entries[0].startTimeMs < 0) {
    errors.push(`First entry startTimeMs=${entries[0].startTimeMs}, expected >= 0`)
  }

  for (let i = 0; i < entries.length; i++) {
    const curr = entries[i]

    if (curr.snippetIndex !== i) {
      errors.push(`Entry[${i}] snippetIndex=${curr.snippetIndex}, expected ${i}`)
    }

    if (curr.startTimeMs < 0) {
      errors.push(`Entry[${i}] startTimeMs=${curr.startTimeMs} < 0`)
    }

    if (curr.durationMs < 0) {
      errors.push(`Entry[${i}] durationMs=${curr.durationMs} < 0`)
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
