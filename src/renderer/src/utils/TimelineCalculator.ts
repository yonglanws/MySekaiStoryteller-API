import type { SnippetData } from '../../../common/types/Story'

export interface TimelineEntry {
  snippetIndex: number
  snippetType: string
  startTimeMs: number
  durationMs: number
  endTimeMs: number
  ttsDurationMs: number
  hasTTS: boolean
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

const TTS_PADDING_MS = 300
const CHAR_READ_SPEED_MS = 80
const CHAR_TELOP_SPEED_MS = 90
const MIN_DURATION_MS = 500
const MAX_DURATION_MS = 30000
// 无 TTS 时 Talk 时长的校准参数：
// 正常日语台词约 7 字/秒（≈143ms/字），用它折算"这句话如果配音会念多久"，
// 再叠加阅读停留，避免无配音时估算明显短于真实说话节奏
const SPEECH_EQUIVALENT_MS_PER_CHAR = 143
const TALK_READING_LINGER_MS = 1200
const MIN_TALK_DURATION_MS = 1800
const CROSS_VALIDATION_TOLERANCE_MS = 500
const EMERGENCY_FALLBACK_MS = 600

const SNIPPET_TYPE_DEFAULTS: Record<string, number> = {
  BlackOut: 600,
  BlackIn: 600,
  ChangeBackgroundImage: 800,
  ChangeLayoutMode: 400,
  LayoutAppear: 800,
  LayoutClear: 600,
  Move: 600,
  Motion: 100,
  HideTalk: 200,
  DoParam: 400
}

const MOVE_SPEED_DURATION_MAP: Record<string, number> = {
  Slow: 1200,
  Normal: 800,
  Fast: 400,
  Immediate: 100
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
    case 'Talk': {
      const content = getSnippetDataField(snippet, 'content') || ''
      const charCount = content.length
      // 无 TTS 时的台词时长拆三段，向真实语音节奏对齐：
      //   1) 打字机时间（逐字出现）
      //   2) 等效语音时长——按正常日语语速 ~7 字/秒 折算，避免估算远短于
      //      真人说话的时长，否则整段对话会显得"没说完就跳"
      //   3) 阅读停留，给观众读完句子的余量
      const typewriterMs = charCount * CHAR_READ_SPEED_MS
      const speechEquivalentMs = charCount * SPEECH_EQUIVALENT_MS_PER_CHAR
      const readingLingerMs = TALK_READING_LINGER_MS
      const estimated = Math.max(
        typewriterMs + speechEquivalentMs * 0.5 + readingLingerMs,
        MIN_TALK_DURATION_MS
      )
      return {
        durationMs: estimated,
        source: 'content_estimation',
        detail: `Talk: ${charCount} chars, typewriter ${typewriterMs} + speech~${Math.round(speechEquivalentMs)} + linger ${readingLingerMs} = ${estimated}ms`
      }
    }
    case 'Telop': {
      const content = getSnippetDataField(snippet, 'content') || ''
      const charCount = content.length
      const estimated = Math.max(charCount * CHAR_TELOP_SPEED_MS, 800)
      return {
        durationMs: estimated,
        source: 'content_estimation',
        detail: `Telop: ${charCount} chars × ${CHAR_TELOP_SPEED_MS}ms = ${estimated}ms`
      }
    }
    case 'BlackOut':
    case 'BlackIn': {
      const dataDur = getSnippetDataField(snippet, 'duration')
      if (dataDur && dataDur > 0) {
        const ms = dataDur > 100 ? dataDur : dataDur * 1000
        return {
          durationMs: ms,
          source: 'data_duration',
          detail: `${snippet.type}: data.duration=${dataDur} → ${ms}ms`
        }
      }
      const def = SNIPPET_TYPE_DEFAULTS[snippet.type]
      return {
        durationMs: def,
        source: 'type_default',
        detail: `${snippet.type}: no data.duration, type default=${def}ms`
      }
    }
    case 'Move':
    case 'LayoutAppear':
    case 'LayoutClear': {
      const speed = getSnippetDataField(snippet, 'moveSpeed')
      if (speed && MOVE_SPEED_DURATION_MAP[speed]) {
        const ms = MOVE_SPEED_DURATION_MAP[speed]
        return {
          durationMs: ms,
          source: 'content_estimation',
          detail: `${snippet.type}: moveSpeed=${speed} → ${ms}ms`
        }
      }
      const def = SNIPPET_TYPE_DEFAULTS[snippet.type]
      return {
        durationMs: def,
        source: 'type_default',
        detail: `${snippet.type}: no moveSpeed, type default=${def}ms`
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
      const def = SNIPPET_TYPE_DEFAULTS[snippet.type]
      if (def) {
        return {
          durationMs: def,
          source: 'type_default',
          detail: `${snippet.type}: type default=${def}ms`
        }
      }
      return {
        durationMs: EMERGENCY_FALLBACK_MS,
        source: 'emergency_fallback',
        detail: `${snippet.type}: unknown type, emergency=${EMERGENCY_FALLBACK_MS}ms`
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
  ttsMapping: TTSMapping | undefined
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

  const isTalk = snippet.type === 'Talk'
  const hasTTS = isTalk && !!ttsMapping && ttsMapping.durationMs > 0

  if (hasTTS) {
    const ttsDur = ttsMapping!.durationMs
    // 优化: TTS时长优先，但不超过内容估算的1.5倍，避免过长
    const ttsWithPadding = ttsDur + TTS_PADDING_MS
    const contentEstimated = pathA.durationMs
    // 取TTS时长和内容估算的较小值，但不少于TTS时长
    finalDurationMs = Math.min(
      Math.max(ttsWithPadding, contentEstimated * 0.8),
      Math.max(ttsWithPadding, contentEstimated * 1.3)
    )
    selectedSource = 'tts_audio'
    decisionReason = `TTS audio=${ttsDur}ms + padding=${TTS_PADDING_MS}ms, balanced with content estimation(${contentEstimated}ms)`
  } else {
    const diff = Math.abs(pathA.durationMs - pathB.durationMs)

    if (pathA.source === 'data_duration') {
      // data_duration 是精确值，优先使用
      finalDurationMs = pathA.durationMs
      selectedSource = pathA.source
      decisionReason = `PathA has data_duration(${pathA.durationMs}ms), using exact value`
    } else if (pathA.source === 'content_estimation') {
      // 内容估算 = 打字机时长 + 阅读停留，是台词的完整预期时长。
      // 只有剧本显式给了足够大的 delay（delay_fallback）才允许拉长；
      // delay 过小时 pathB 是 600ms 的 emergency 兜底值，绝不能参与平均——
      // 否则估算被稀释到低于打字机时间，句间停留会归零（对话背靠背）。
      if (
        pathB.source === 'delay_fallback' &&
        pathB.durationMs >= 200 &&
        pathB.durationMs < pathA.durationMs * 1.5
      ) {
        finalDurationMs = Math.round((pathA.durationMs + pathB.durationMs) / 2)
        selectedSource = pathA.source
        decisionReason = `PathA content(${pathA.durationMs}ms) averaged with explicit delay(${pathB.durationMs}ms)`
      } else {
        finalDurationMs = pathA.durationMs
        selectedSource = pathA.source
        decisionReason = `Using PathA content estimation(${pathA.durationMs}ms)`
      }
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

  finalDurationMs = clampDuration(finalDurationMs)

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
    const hasTTS = isTalk && !!ttsMapping && ttsMapping.durationMs > 0

    const pathA = calculatePathA_ContentBased(snippet)
    const pathB = calculatePathB_DelayBased(snippet)

    const crossResult = crossValidate(pathA, pathB, snippet, ttsMapping)

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

    const entry: TimelineEntry = {
      snippetIndex: i,
      snippetType: snippet.type,
      startTimeMs: currentTimeMs,
      durationMs: crossResult.finalDurationMs,
      endTimeMs: currentTimeMs + crossResult.finalDurationMs,
      ttsDurationMs,
      hasTTS,
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
      finalDurationMs: crossResult.finalDurationMs,
      selectedSource: crossResult.selectedSource,
      pathADetail: pathA.detail,
      pathBDetail: pathB.detail,
      decisionReason: crossResult.decisionReason,
      timestamp: Date.now()
    })

    currentTimeMs += crossResult.finalDurationMs
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
  const pathA = calculatePathA_ContentBased(snippet)
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

    if (curr.durationMs <= 0) {
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
