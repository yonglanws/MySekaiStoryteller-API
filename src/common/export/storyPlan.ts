import type { SnippetData } from '../types/Story'
import { snippetBlocksTimeline } from './snippetSemantics'
import { visibleTextLength } from '../official/text'
import { hasSpeakableSpeechText } from '../tts/speechText'
import {
  APPEAR_FADE_TOTAL_FRAMES,
  APPEAR_SHOWN_MOVE_FRAMES,
  CHARACTER_FADE_MS,
  HIDE_DELAY_IN_PLACE_MS,
  MOVE_SPEED_DURATION_MS,
  SILENT_PUNCTUATION_HOLD_FRAMES,
  TALK_WINDOW_OPEN_CLOSE_MS,
  VOICE_END_LATENCY_SECONDS,
  WORD_INTERVAL_FRAMES,
  framesForSeconds,
  framesToMs,
  msToFrames,
  resolveCharacterFadeMs
} from '../official/timing'

/**
 * Pass 1 的轻量版本：把剧本 + 时间线烘焙成逐帧计划。
 *
 * 本项目 Pass 2 仍由 Pixi 实时渲染，但计划层提供与 SekaiStoryExporter 相同的可观测性：
 * 每句的 typing/voice/gate 帧、每个动作 cue 的帧、每次布局淡入/滑动/淡出的帧。
 * 导出日志里的 planned 与实际时间戳可以直接对照这些帧。
 */

export interface StoryPlanTimelineEntry {
  snippetIndex: number
  startTimeMs: number
  durationMs: number
  endTimeMs: number
  ttsDurationMs?: number
  hasTTS?: boolean
}

export interface StoryPlanActionCue {
  frame: number
  at: number
  modelId: number
  motion?: string
  facial?: string
}

export interface StoryPlanTalk {
  windowOpenFrames: number
  typingStartFrame: number
  typingEndFrame: number
  voiceEndFrame: number | null
  gateEndFrame: number
  computedEndFrame: number
}

export interface StoryPlanLayout {
  kind: 'appear' | 'clear' | 'move'
  fadeStartFrame: number | null
  fadeEndFrame: number | null
  moveEndFrame: number
}

export interface StoryPlanEntry {
  index: number
  type: string
  delayStartFrame: number
  startFrame: number
  endFrame: number
  durationFrames: number
  /** 官方 ProgressBehavior=1（或 Talk）：在启动与 delay 前触发前置栅栏。 */
  blocking: boolean
  talk?: StoryPlanTalk
  layout?: StoryPlanLayout
  actions: StoryPlanActionCue[]
}

export interface StoryPlan {
  schemaVersion: 1
  fps: number
  totalFrames: number
  totalMs: number
  entries: StoryPlanEntry[]
}

export interface StoryPlanOptions {
  /** 首句/关闭后第一句打开窗口的额外毫秒；不传则按剧本顺序推导。 */
  windowOpenMs?: ReadonlyMap<number, number>
  /** Talk 内身体动作的最晚结束时间（相对 Talk 开始），用于官方 gate。 */
  motionSettleMs?: ReadonlyMap<number, number>
  /** 导出编码帧率（传入时与 30fps 导出淡入/静默节拍时长对齐）。 */
  exportFps?: number
  ttsEnabled?: boolean
}

interface TalkLike {
  content?: string
  ttsText?: string
  voice?: string
  modelId?: number
  motion?: string
  facial?: string
  closeWindowOnFinish?: boolean
  actions?: Array<{ at?: number; modelId?: number; motion?: string; facial?: string }>
}

interface LayoutLike {
  modelId?: number
  from?: { side?: string; offset?: number; under?: boolean }
  to?: { side?: string; offset?: number; under?: boolean }
  moveSpeed?: string
}

function snippetData(snippet: SnippetData): Record<string, unknown> {
  return ((snippet as { data?: unknown }).data ?? {}) as Record<string, unknown>
}

function deriveWindowOpen(snippets: SnippetData[]): Map<number, number> {
  const map = new Map<number, number>()
  let open = false
  for (let i = 0; i < snippets.length; i++) {
    if (snippets[i].type === 'Talk') {
      if (!open) {
        map.set(i, TALK_WINDOW_OPEN_CLOSE_MS)
        open = true
      }
      const data = snippetData(snippets[i])
      if (data.closeWindowOnFinish === true) {
        open = false
      }
    } else if (snippets[i].type === 'HideTalk') {
      open = false
    }
  }
  return map
}

function moveFramesFor(data: LayoutLike): number {
  const ms =
    MOVE_SPEED_DURATION_MS[(data.moveSpeed as keyof typeof MOVE_SPEED_DURATION_MS) ?? 'Normal']
  return framesForSeconds((ms ?? MOVE_SPEED_DURATION_MS.Normal) / 1000)
}

function layoutMoved(data: LayoutLike): boolean {
  const from = data.from
  const to = data.to
  if (!from || !to) return false
  return (
    (from.side ?? 'Center') !== (to.side ?? 'Center') ||
    (Number(from.offset) || 0) !== (Number(to.offset) || 0) ||
    Boolean(from.under) !== Boolean(to.under)
  )
}

export function bakeStoryPlan(
  snippets: SnippetData[],
  timeline: StoryPlanTimelineEntry[],
  options: StoryPlanOptions = {}
): StoryPlan {
  const isExport = options.exportFps !== undefined
  const fadeMs = isExport ? resolveCharacterFadeMs(true, options.exportFps) : CHARACTER_FADE_MS
  const fadeFrames = framesForSeconds(fadeMs / 1000)
  const appearFadeFrames = isExport ? 1 + fadeFrames : APPEAR_FADE_TOTAL_FRAMES
  const windowOpen = options.windowOpenMs ?? deriveWindowOpen(snippets)
  const timelineByIndex = new Map(timeline.map((entry) => [entry.snippetIndex, entry]))
  const entries: StoryPlanEntry[] = []
  const visibleModels = new Set<number>()
  let cursorFrame = 0
  let runningEndFrame = 0
  let activeLayoutEndFrame = 0
  let lastEndFrame = 0

  for (let i = 0; i < snippets.length; i++) {
    const snippet = snippets[i]
    const data = snippetData(snippet)
    const timing = timelineByIndex.get(i)
    const blocking = snippetBlocksTimeline(snippet)

    // PlayCore 前置栅栏：WaitFinished 在 delay 开始前先等所有在跑任务完成。
    if (blocking) {
      cursorFrame = Math.max(cursorFrame, runningEndFrame)
    }

    const delayStartFrame = cursorFrame
    const delayFrames = framesForSeconds(snippet.delay)
    const startFrame = delayStartFrame + delayFrames
    const durationFrames = framesForSeconds((timing?.durationMs ?? 0) / 1000)
    const endFrame = startFrame + durationFrames
    const actions: StoryPlanActionCue[] = []

    const topMotion = typeof data.motion === 'string' ? data.motion.trim() : ''
    const topFacial = typeof data.facial === 'string' ? data.facial.trim() : ''
    const resolveActionModelId = (raw: unknown): number => {
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw
      if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
        const parsed = Number(raw)
        if (Number.isFinite(parsed)) return parsed
      }
      return -1
    }
    if (topMotion || topFacial) {
      actions.push({
        frame: startFrame,
        at: 0,
        modelId: resolveActionModelId(data.modelId),
        ...(topMotion ? { motion: topMotion } : {}),
        ...(topFacial ? { facial: topFacial } : {})
      })
    }
    for (const action of (data.actions as TalkLike['actions']) ?? []) {
      const actionMotion = typeof action.motion === 'string' ? action.motion.trim() : ''
      const actionFacial = typeof action.facial === 'string' ? action.facial.trim() : ''
      if (!actionMotion && !actionFacial) continue
      const at = Math.max(0, Math.min(1, Number(action.at) || 0))
      actions.push({
        frame: startFrame + Math.round(at * durationFrames),
        at,
        modelId: resolveActionModelId(action.modelId),
        ...(actionMotion ? { motion: actionMotion } : {}),
        ...(actionFacial ? { facial: actionFacial } : {})
      })
    }

    let talk: StoryPlanTalk | undefined
    if (snippet.type === 'Talk') {
      const talkData = data as TalkLike
      const content = typeof talkData.content === 'string' ? talkData.content : ''
      const windowFrames = msToFrames(windowOpen.get(i) ?? 0)
      const typingStartFrame = startFrame + windowFrames
      const typingEndFrame = typingStartFrame + visibleTextLength(content) * WORD_INTERVAL_FRAMES
      const ttsMs = timing?.ttsDurationMs && timing.ttsDurationMs > 0 ? timing.ttsDurationMs : 0
      const voiceEndFrame =
        ttsMs > 0 ? startFrame + framesForSeconds(ttsMs / 1000 + VOICE_END_LATENCY_SECONDS) : null
      const settleFrames = framesForSeconds((options.motionSettleMs?.get(i) ?? 0) / 1000)
      const layoutGateFrame = activeLayoutEndFrame > startFrame ? activeLayoutEndFrame : 0
      const doneFrame =
        voiceEndFrame !== null
          ? Math.max(typingEndFrame, voiceEndFrame, layoutGateFrame, startFrame + settleFrames)
          : typingEndFrame
      const voiceFinishedBeforeTyping = voiceEndFrame !== null && voiceEndFrame < typingEndFrame
      const ttsText = typeof talkData.ttsText === 'string' ? talkData.ttsText : ''
      const isSilentPunctuationBeat =
        isExport &&
        options.ttsEnabled !== false &&
        voiceEndFrame === null &&
        !talkData.voice &&
        !hasSpeakableSpeechText(content) &&
        !hasSpeakableSpeechText(ttsText)
      const tailFrames =
        voiceEndFrame !== null
          ? voiceFinishedBeforeTyping
            ? framesForSeconds(2)
            : framesForSeconds(0.5)
          : isSilentPunctuationBeat
            ? SILENT_PUNCTUATION_HOLD_FRAMES
            : framesForSeconds(2)
      const computedEndFrame = doneFrame + tailFrames
      talk = {
        windowOpenFrames: windowFrames,
        typingStartFrame,
        typingEndFrame,
        voiceEndFrame,
        gateEndFrame: doneFrame,
        computedEndFrame
      }
    }

    let layout: StoryPlanLayout | undefined
    if (
      snippet.type === 'LayoutAppear' ||
      snippet.type === 'LayoutClear' ||
      snippet.type === 'Move'
    ) {
      const layoutData = data as LayoutLike
      const moveFrames = moveFramesFor(layoutData)
      const moved = layoutMoved(layoutData)
      const modelId = Number(layoutData.modelId) || -1
      if (snippet.type === 'LayoutAppear') {
        const shown = visibleModels.has(modelId)
        const moveEndFrame = startFrame + (shown ? APPEAR_SHOWN_MOVE_FRAMES : moveFrames)
        layout = {
          kind: 'appear',
          fadeStartFrame: shown ? null : startFrame + 1,
          fadeEndFrame: shown ? null : startFrame + appearFadeFrames,
          // 已在场 Appear 是 CharacterMoveTo(side, 0.2)，与 moveSpeed 无关。
          moveEndFrame
        }
        const activeSlideEnd = shown
          ? moveEndFrame
          : Math.max(startFrame + appearFadeFrames, moved ? moveEndFrame : 0)
        activeLayoutEndFrame = Math.max(activeLayoutEndFrame, activeSlideEnd)
        visibleModels.add(modelId)
      } else if (snippet.type === 'LayoutClear') {
        const shown = visibleModels.has(modelId)
        if (!shown) {
          layout = {
            kind: 'clear',
            fadeStartFrame: null,
            fadeEndFrame: null,
            moveEndFrame: startFrame
          }
        } else if (moved) {
          layout = {
            kind: 'clear',
            fadeStartFrame: startFrame + Math.max(0, moveFrames - fadeFrames),
            fadeEndFrame: startFrame + Math.max(fadeFrames, moveFrames),
            moveEndFrame: startFrame + moveFrames
          }
          activeLayoutEndFrame = Math.max(activeLayoutEndFrame, layout.fadeEndFrame ?? startFrame)
        } else {
          const hideDelayFrames = framesForSeconds(HIDE_DELAY_IN_PLACE_MS / 1000)
          layout = {
            kind: 'clear',
            fadeStartFrame: startFrame + hideDelayFrames,
            fadeEndFrame: startFrame + hideDelayFrames + Math.max(1, fadeFrames),
            moveEndFrame: startFrame
          }
          activeLayoutEndFrame = Math.max(activeLayoutEndFrame, layout.fadeEndFrame ?? startFrame)
        }
        visibleModels.delete(modelId)
      } else {
        layout = {
          kind: 'move',
          fadeStartFrame: null,
          fadeEndFrame: null,
          moveEndFrame: startFrame + moveFrames
        }
        activeLayoutEndFrame = Math.max(activeLayoutEndFrame, layout.moveEndFrame)
      }
    }

    entries.push({
      index: i,
      type: snippet.type,
      delayStartFrame,
      startFrame,
      endFrame,
      durationFrames,
      blocking,
      ...(talk ? { talk } : {}),
      ...(layout ? { layout } : {}),
      actions
    })

    runningEndFrame = Math.max(runningEndFrame, endFrame)
    lastEndFrame = Math.max(lastEndFrame, endFrame)
  }

  return {
    schemaVersion: 1,
    fps: 60,
    totalFrames: lastEndFrame,
    totalMs: framesToMs(lastEndFrame),
    entries
  }
}
