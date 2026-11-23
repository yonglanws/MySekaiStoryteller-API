import type { SnippetData } from '../types/Story'
import { snippetBlocksTimeline } from './snippetSemantics'
import { visibleTextLength } from '../official/text'
import { hasSpeakableSpeechText } from '../tts/speechText'
import {
  APPEAR_FADE_TOTAL_FRAMES,
  APPEAR_SHOWN_MOVE_FRAMES,
  CHARACTER_FADE_MS,
  FRAME_MS,
  HIDE_DELAY_IN_PLACE_MS,
  MOVE_SPEED_DURATION_MS,
  PLAYCORE_WARMUP_FRAMES,
  SILENT_PUNCTUATION_HOLD_FRAMES,
  TALK_WINDOW_OPEN_CLOSE_MS,
  framesForSeconds,
  framesToMs,
  msToFrameCount,
  msToFrames,
  storyEndFrame
} from '../official/timing'
import { talkAutoFrameTiming } from '../official/talkAuto'

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
  voiceDurationMs?: number
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

/** 片段时长（毫秒）→ 故事帧。子帧状态片段（旧时间线的 1ms 标记）不占帧。 */
function planDurationFrames(ms: number): number {
  if (ms > 0 && ms < FRAME_MS) return 0
  return msToFrameCount(ms)
}

function moveFramesFor(data: LayoutLike): number {
  const ms =
    MOVE_SPEED_DURATION_MS[(data.moveSpeed as keyof typeof MOVE_SPEED_DURATION_MS) ?? 'Normal']
  return msToFrameCount(ms ?? MOVE_SPEED_DURATION_MS.Normal)
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
  // 角色淡入固定 100ms（6 帧），与成片帧率无关。
  const fadeFrames = msToFrameCount(CHARACTER_FADE_MS)
  const appearFadeFrames = 1 + fadeFrames
  const windowOpen = options.windowOpenMs ?? deriveWindowOpen(snippets)
  const timelineByIndex = new Map(timeline.map((entry) => [entry.snippetIndex, entry]))
  const entries: StoryPlanEntry[] = []
  const visibleModels = new Set<number>()
  // `PlayCore` 前 10 帧不放任何 snippet。
  let cursorFrame = PLAYCORE_WARMUP_FRAMES
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
    const durationFrames = planDurationFrames(timing?.durationMs ?? 0)
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
      const ttsMs = timing?.ttsDurationMs && timing.ttsDurationMs > 0 ? timing.ttsDurationMs : 0
      const officialVoiceMs =
        typeof talkData.voiceDurationMs === 'number' &&
        Number.isFinite(talkData.voiceDurationMs) &&
        talkData.voiceDurationMs > 0
          ? talkData.voiceDurationMs
          : 0
      const timingVoiceMs = officialVoiceMs > 0 ? officialVoiceMs : ttsMs
      const ttsText = typeof talkData.ttsText === 'string' ? talkData.ttsText : ''
      const isSilentPunctuationBeat =
        isExport &&
        options.ttsEnabled !== false &&
        timingVoiceMs <= 0 &&
        !talkData.voice &&
        !hasSpeakableSpeechText(content) &&
        !hasSpeakableSpeechText(ttsText)
      const timingFrames = talkAutoFrameTiming({
        startFrame,
        windowFrames: msToFrames(windowOpen.get(i) ?? 0),
        length: visibleTextLength(content),
        voiceSeconds: timingVoiceMs / 1000,
        layoutEndFrame: activeLayoutEndFrame > startFrame ? activeLayoutEndFrame : 0,
        settleFrames: framesForSeconds((options.motionSettleMs?.get(i) ?? 0) / 1000),
        silentHoldFrames: isSilentPunctuationBeat ? SILENT_PUNCTUATION_HOLD_FRAMES : undefined
      })
      talk = {
        windowOpenFrames: timingFrames.windowOpenFrames,
        typingStartFrame: timingFrames.typingStartFrame,
        typingEndFrame: timingFrames.typingEndFrame,
        voiceEndFrame: timingFrames.voiceEndFrame,
        gateEndFrame: timingFrames.gateEndFrame,
        computedEndFrame: timingFrames.endFrame
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
        const hasMotion =
          typeof (layoutData as { motion?: string }).motion === 'string' &&
          (layoutData as { motion?: string }).motion!.trim() !== ''
        // 官方 `at = frame + (hidden && motion)`：类型分支（淡入/滑入）延后一帧；
        // 新角色从 from 滑向 to，片段只等淡入，滑入继续在后台。
        const layoutAt = startFrame + (!shown && hasMotion ? 1 : 0)
        const fadeEnd = layoutAt + appearFadeFrames
        if (shown) {
          layout = {
            kind: 'appear',
            fadeStartFrame: null,
            fadeEndFrame: null,
            // 已在场 Appear 是 CharacterMoveTo(side, 0.2)，与 moveSpeed 无关。
            moveEndFrame: startFrame + APPEAR_SHOWN_MOVE_FRAMES
          }
          activeLayoutEndFrame = Math.max(
            activeLayoutEndFrame,
            startFrame + APPEAR_SHOWN_MOVE_FRAMES
          )
        } else {
          // AppearCharacter(from) 之后紧接 CharacterMoveTo(to, moveSpeed)：
          // 滑入从类型分支帧起跑，片段只等 7/8 帧的淡入。
          layout = {
            kind: 'appear',
            fadeStartFrame: layoutAt + 1,
            fadeEndFrame: fadeEnd,
            moveEndFrame: layoutAt + moveFrames
          }
          activeLayoutEndFrame = Math.max(
            activeLayoutEndFrame,
            Math.max(fadeEnd, moved ? layoutAt + moveFrames : 0)
          )
        }
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
          const hideDelayFrames = msToFrameCount(HIDE_DELAY_IN_PLACE_MS)
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

  // 成片尾：cleanup 之后 + playedWaitTime + 1 + BGM 淡出 = cleanup + 31。
  const totalFrames = storyEndFrame(lastEndFrame)
  return {
    schemaVersion: 1,
    fps: 60,
    totalFrames,
    totalMs: framesToMs(totalFrames),
    entries
  }
}
