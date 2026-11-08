import type { SnippetData } from '../types/Story'
import { snippetBlocksTimeline } from './snippetSemantics'
import { visibleTextLength } from '../official/text'
import {
  APPEAR_FADE_TOTAL_FRAMES,
  APPEAR_SHOWN_MOVE_FRAMES,
  CHARACTER_FADE_MS,
  HIDE_DELAY_IN_PLACE_MS,
  MOVE_SPEED_DURATION_MS,
  TALK_WINDOW_OPEN_CLOSE_MS,
  VOICE_END_LATENCY_SECONDS,
  WORD_INTERVAL_FRAMES,
  framesForSeconds,
  framesToMs,
  msToFrames
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
  /** 官方 ProgressBehavior=1；false 时该片段在后台运行，不推进下一条的起点。 */
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
  /** 首句/HideTalk 后第一句打开窗口的额外毫秒；不传则按剧本顺序推导。 */
  windowOpenMs?: ReadonlyMap<number, number>
  /** Talk 内身体动作的最晚结束时间（相对 Talk 开始），用于官方 gate。 */
  motionSettleMs?: ReadonlyMap<number, number>
}

interface TalkLike {
  content?: string
  ttsText?: string
  voice?: string
  modelId?: number
  motion?: string
  facial?: string
  actions?: Array<{ at?: number; modelId?: number; motion?: string; facial?: string }>
}

interface LayoutLike {
  modelId?: number
  from?: { side?: string; offset?: number }
  to?: { side?: string; offset?: number }
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
    (Number(from.offset) || 0) !== (Number(to.offset) || 0)
  )
}

export function bakeStoryPlan(
  snippets: SnippetData[],
  timeline: StoryPlanTimelineEntry[],
  options: StoryPlanOptions = {}
): StoryPlan {
  const windowOpen = options.windowOpenMs ?? deriveWindowOpen(snippets)
  const timelineByIndex = new Map(timeline.map((entry) => [entry.snippetIndex, entry]))
  const entries: StoryPlanEntry[] = []
  const visibleModels = new Set<number>()
  let cursorFrame = 0
  let lastEndFrame = 0

  for (let i = 0; i < snippets.length; i++) {
    const snippet = snippets[i]
    const data = snippetData(snippet)
    const timing = timelineByIndex.get(i)
    const delayFrames = framesForSeconds(snippet.delay)
    const startFrame = cursorFrame + delayFrames
    const durationFrames = framesForSeconds((timing?.durationMs ?? 0) / 1000)
    const endFrame = startFrame + durationFrames
    const blocking = snippetBlocksTimeline(snippet)
    const actions: StoryPlanActionCue[] = []

    if (typeof data.motion === 'string' || typeof data.facial === 'string') {
      actions.push({
        frame: startFrame,
        at: 0,
        modelId: Number(data.modelId) || -1,
        ...(typeof data.motion === 'string' ? { motion: data.motion } : {}),
        ...(typeof data.facial === 'string' ? { facial: data.facial } : {})
      })
    }
    for (const action of (data.actions as TalkLike['actions']) ?? []) {
      const at = Math.max(0, Math.min(1, Number(action.at) || 0))
      actions.push({
        frame: startFrame + Math.round(at * durationFrames),
        at,
        modelId: Number(action.modelId) || -1,
        ...(action.motion ? { motion: action.motion } : {}),
        ...(action.facial ? { facial: action.facial } : {})
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
      const doneFrame = Math.max(typingEndFrame, voiceEndFrame ?? 0, startFrame + settleFrames)
      const tailFrames = voiceEndFrame !== null ? framesForSeconds(0.5) : framesForSeconds(2)
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
      const modelId = Number(layoutData.modelId) || -1
      if (snippet.type === 'LayoutAppear') {
        const shown = visibleModels.has(modelId)
        layout = {
          kind: 'appear',
          fadeStartFrame: shown ? null : startFrame + 1,
          fadeEndFrame: shown ? null : startFrame + APPEAR_FADE_TOTAL_FRAMES,
          // 已在场 Appear 是 CharacterMoveTo(side, 0.2)，与 moveSpeed 无关。
          moveEndFrame: startFrame + (shown ? APPEAR_SHOWN_MOVE_FRAMES : moveFrames)
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
        } else if (layoutMoved(layoutData)) {
          const fadeFrames = framesForSeconds(CHARACTER_FADE_MS / 1000)
          layout = {
            kind: 'clear',
            fadeStartFrame: startFrame + Math.max(0, moveFrames - fadeFrames),
            fadeEndFrame: startFrame + Math.max(fadeFrames, moveFrames),
            moveEndFrame: startFrame + moveFrames
          }
        } else {
          layout = {
            kind: 'clear',
            fadeStartFrame: startFrame + framesForSeconds(HIDE_DELAY_IN_PLACE_MS / 1000),
            fadeEndFrame: startFrame + durationFrames,
            moveEndFrame: startFrame
          }
        }
        visibleModels.delete(modelId)
      } else {
        layout = {
          kind: 'move',
          fadeStartFrame: null,
          fadeEndFrame: null,
          moveEndFrame: startFrame + moveFrames
        }
      }
    }

    entries.push({
      index: i,
      type: snippet.type,
      delayStartFrame: cursorFrame,
      startFrame,
      endFrame,
      durationFrames,
      blocking,
      ...(talk ? { talk } : {}),
      ...(layout ? { layout } : {}),
      actions
    })
    // ProgressBehavior=0：协程在后台跑，调度器不推进 cursor；它的 delay/动画仍
    // 计入 totalFrames（官方收尾 WaitAllFinished 会等所有后台协程）。
    if (blocking) cursorFrame = endFrame
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
