import type { SnippetData } from '../types/Story'
import { snippetBlocksTimeline } from './snippetSemantics'
import { visibleTextLength } from '../official/text'
import { hasSpeakableSpeechText } from '../tts/speechText'
import {
  APPEAR_SHOWN_MOVE_FRAMES,
  CHARACTER_FADE_MS,
  FRAME_MS,
  HIDE_DELAY_IN_PLACE_MS,
  MOVE_SPEED_DURATION_MS,
  PLAYCORE_WARMUP_FRAMES,
  SECONDS_DURATION_SNIPPET_TYPES,
  SILENT_PUNCTUATION_HOLD_FRAMES,
  TALK_WINDOW_OPEN_CLOSE_FRAMES,
  framesForSeconds,
  framesToMs,
  fullScreenTextFrames,
  fullScreenTextSlots,
  msToFrameCount,
  normalizeEffectDurationMs,
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
  /** 仍在跑的布局片段结束帧（绝对）；0 表示没有。 */
  layoutGateFrame: number
  /** 本句动作收尾帧数（相对 act）；0 表示没有。 */
  settleFrames: number
  gateEndFrame: number
  computedEndFrame: number
}

export interface StoryPlanLayout {
  kind: 'appear' | 'clear' | 'move'
  fadeStartFrame: number | null
  fadeEndFrame: number | null
  moveEndFrame: number
}

/** `ScenarioFullScreenTextDialog.PlayCore` 的逐槽/停留/淡出帧（槽数跨行只增不减）。 */
export interface StoryPlanFullScreenText {
  first: boolean
  last: boolean
  slots: number
  textStartFrame: number
  textEndFrame: number
  holdFrames: number
  fadeFrames: number
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
  fst?: StoryPlanFullScreenText
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
  /** 同上，但已经是帧数（延迟与 clip 分别 `frames_for` 后相加）。优先于 `motionSettleMs`。 */
  motionSettleFrames?: ReadonlyMap<number, number>
  /**
   * `modelId|motion` -> 非循环 clip 帧数。提供时计划层自己按剧本帧推导 Talk gate
   * （含后续 Now 片段），不再依赖运行时的时间戳 settle（后者会带上 1–3 帧启动漂移）。
   */
  motionClipFrames?: ReadonlyMap<string, number>
  /** 导出编码帧率（传入时与 30fps 导出淡入/静默节拍时长对齐）。 */
  exportFps?: number
  ttsEnabled?: boolean
}

interface TalkLike {
  content?: string
  ttsText?: string
  typingText?: string
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
  let talkWindowOpen = false
  let talkWindowClosesAtFrame: number | null = null
  let runningFenceEndFrame = 0
  const timelineByIndex = new Map(timeline.map((entry) => [entry.snippetIndex, entry]))
  const entries: StoryPlanEntry[] = []
  const visibleModels = new Set<number>()
  // 每个角色当前 body 动作的绝对结束帧（只增；隐藏时 gate 不看它）。
  const bodyEndByModel = new Map<number, number>()
  // `PlayCore` 前 10 帧不放任何 snippet。
  let cursorFrame = PLAYCORE_WARMUP_FRAMES
  let activeLayoutEndFrame = 0
  let lastEndFrame = 0
  // 全屏文字对话框的 TMP characterInfo 槽数：初值 8，跨行只增不减。
  let fstSlots = 0
  // 全屏文字对话框是否仍开着（连续/keepBars 的行共用黑边；关掉后下一行重新播开）。
  let fstDialogOpen = false

  for (let i = 0; i < snippets.length; i++) {
    const snippet = snippets[i]
    const data = snippetData(snippet)
    const timing = timelineByIndex.get(i)
    const blocking = snippetBlocksTimeline(snippet)
    const nextType = i + 1 < snippets.length ? snippets[i + 1].type : ''

    // PlayCore 前置栅栏：WaitFinished 在 delay 开始前先等所有在跑任务完成。
    if (blocking) {
      cursorFrame = Math.max(cursorFrame, runningFenceEndFrame)
    }

    const delayStartFrame = cursorFrame
    const delayFrames = framesForSeconds(snippet.delay)
    const startFrame = delayStartFrame + delayFrames

    // 对话框窗口状态与参考实现一致：closeWindowOnFinish 在台词结束 0.2s 后
    // 才真正关闭；下一句如果在这之前开始，窗口仍算打开。
    if (talkWindowClosesAtFrame !== null && talkWindowClosesAtFrame <= startFrame) {
      talkWindowOpen = false
      talkWindowClosesAtFrame = null
    }
    let windowOpenFrames = 0
    if (snippet.type === 'Talk') {
      const provided = options.windowOpenMs?.get(i)
      windowOpenFrames =
        provided !== undefined
          ? msToFrames(provided)
          : talkWindowOpen
            ? 0
            : TALK_WINDOW_OPEN_CLOSE_FRAMES
      talkWindowOpen = true
    } else if (snippet.type === 'HideTalk') {
      talkWindowOpen = false
      talkWindowClosesAtFrame = null
    }
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
        frame: startFrame + Math.round(at * planDurationFrames(timing?.durationMs ?? 0)),
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
      const typingText = typeof talkData.typingText === 'string' ? talkData.typingText : ''
      const isSilentPunctuationBeat =
        isExport &&
        options.ttsEnabled !== false &&
        timingVoiceMs <= 0 &&
        !talkData.voice &&
        !hasSpeakableSpeechText(content) &&
        !hasSpeakableSpeechText(ttsText)
      const layoutGateFrame = activeLayoutEndFrame > startFrame ? activeLayoutEndFrame : 0
      let settleFrames: number
      if (options.motionClipFrames) {
        const clipFrames = options.motionClipFrames
        let planned = 0
        // 之前片段留下的 body 动作（只算 shown 的角色）。
        for (const [modelId, endFrame] of bodyEndByModel) {
          if (!visibleModels.has(modelId)) continue
          if (endFrame > startFrame) planned = Math.max(planned, endFrame - startFrame)
        }
        // 本句自己的动作：`actions` 的帧已经按计划算好。
        for (const action of actions) {
          if (!action.motion || !visibleModels.has(action.modelId)) continue
          const clip = clipFrames.get(`${action.modelId}|${action.motion}`) ?? 0
          if (clip > 0) planned = Math.max(planned, action.frame - startFrame + clip)
        }
        // 与 Talk 同注册帧的后续 Now 片段也会 `set_body` 并阻塞 gate。
        for (let j = i + 1; j < snippets.length; j++) {
          const next = snippets[j]
          if (snippetBlocksTimeline(next)) break
          const nextData = snippetData(next) as {
            modelId?: number
            motion?: unknown
            duration?: unknown
            actions?: Array<{ at?: unknown; modelId?: unknown; motion?: unknown }>
          }
          const startRel = framesForSeconds(next.delay) - delayFrames
          const consider = (modelRaw: unknown, motionRaw: unknown, atRaw: unknown): void => {
            const motionName = typeof motionRaw === 'string' ? motionRaw.trim() : ''
            if (!motionName) return
            const modelId = resolveActionModelId(modelRaw)
            if (!visibleModels.has(modelId)) return
            const clip = clipFrames.get(`${modelId}|${motionName}`) ?? 0
            if (clip <= 0) return
            const at = Math.max(0, Math.min(1, Number(atRaw) || 0))
            // Motion 片段用 `duration` 做 cue 窗口；其它类型的动作都是 act 帧。
            const atFrames =
              at > 0
                ? Math.round(at * planDurationFrames((Number(nextData.duration) || 2) * 1000))
                : 0
            planned = Math.max(planned, startRel + atFrames + clip)
          }
          consider(nextData.modelId, nextData.motion, 0)
          for (const action of nextData.actions ?? []) {
            consider(action.modelId ?? nextData.modelId, action.motion, action.at)
          }
        }
        settleFrames = Math.max(0, planned)
      } else {
        settleFrames =
          options.motionSettleFrames?.get(i) ??
          framesForSeconds((options.motionSettleMs?.get(i) ?? 0) / 1000)
      }
      const timingFrames = talkAutoFrameTiming({
        startFrame,
        windowFrames: windowOpenFrames,
        length: visibleTextLength(typingText || content),
        voiceSeconds: timingVoiceMs / 1000,
        layoutEndFrame: layoutGateFrame,
        settleFrames,
        silentHoldFrames: isSilentPunctuationBeat ? SILENT_PUNCTUATION_HOLD_FRAMES : undefined
      })
      talk = {
        windowOpenFrames: timingFrames.windowOpenFrames,
        typingStartFrame: timingFrames.typingStartFrame,
        typingEndFrame: timingFrames.typingEndFrame,
        voiceEndFrame: timingFrames.voiceEndFrame,
        layoutGateFrame,
        settleFrames,
        gateEndFrame: timingFrames.gateEndFrame,
        computedEndFrame: timingFrames.endFrame
      }
      if (talkData.closeWindowOnFinish === true) {
        talkWindowClosesAtFrame = timingFrames.endFrame + TALK_WINDOW_OPEN_CLOSE_FRAMES
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
          // Talk 的布局门只等片段本身（淡入结束）；后台滑入不阻塞下一句
          // （参考 `motions_settled` 只看 body motion，`layout_running` 只看片段）。
          activeLayoutEndFrame = Math.max(activeLayoutEndFrame, fadeEnd)
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

    let fst: StoryPlanFullScreenText | undefined
    if (snippet.type === 'FullScreenText') {
      // 参考按相邻 instruction 判定 first/last：连续的全屏文字共用一个对话框，
      // 槽数（TMP characterInfo）跨行只增不减。
      const first = !fstDialogOpen
      const last = nextType !== 'FullScreenText' && data.keepBars !== true
      if (first) fstSlots = 0
      fstDialogOpen = !last
      const text = typeof data.text === 'string' ? data.text : ''
      const slots = fullScreenTextSlots(fstSlots, text)
      fstSlots = slots
      const frames = fullScreenTextFrames({ first, last, slots })
      fst = {
        first,
        last,
        slots,
        textStartFrame: startFrame + frames.textStartFrame,
        textEndFrame: startFrame + frames.textEndFrame,
        holdFrames: frames.holdFrames,
        fadeFrames: frames.fadeFrames
      }
    }

    // 参考实现里各片段的实际等待帧数。Talk/布局/全屏文字用各自的逐帧公式；
    // 剧本秒数驱动的效果与 Wait 用 f32 `frames_for`；其余沿用已量化的时间线值。
    let waitFrames: number
    if (talk) {
      waitFrames = talk.computedEndFrame - startFrame
    } else if (fst) {
      waitFrames = fst.textEndFrame + fst.holdFrames + fst.fadeFrames - startFrame
    } else if (layout && snippet.type === 'LayoutAppear') {
      waitFrames =
        layout.fadeEndFrame !== null ? layout.fadeEndFrame - startFrame : APPEAR_SHOWN_MOVE_FRAMES
    } else if (layout && snippet.type === 'LayoutClear') {
      waitFrames = (layout.fadeEndFrame ?? layout.moveEndFrame) - startFrame
    } else if (layout && snippet.type === 'Move') {
      waitFrames = layout.moveEndFrame - startFrame
    } else if (SECONDS_DURATION_SNIPPET_TYPES.has(snippet.type)) {
      const rawDuration = typeof data.duration === 'number' ? data.duration : 0
      const durationMs = normalizeEffectDurationMs(rawDuration, 0)
      waitFrames = framesForSeconds(durationMs / 1000)
    } else {
      waitFrames = planDurationFrames(timing?.durationMs ?? 0)
    }
    waitFrames = Math.max(0, waitFrames)
    // 参考 PlayCore 在下一帧才启动下一条（非零等待），所以非末条片段的
    // 诊断 endFrame 都包含这一帧栅栏；最后一条片段的 cleanup 就在它结束帧。
    const taskRan = delayFrames > 0 || waitFrames > 0
    const hasFence = taskRan && i < snippets.length - 1
    const finishFrame = startFrame + waitFrames
    const endFrame = finishFrame + (i < snippets.length - 1 ? 1 : 0)
    const durationFrames = waitFrames

    // 记录本片段动作的 body 收尾帧，供后续 Talk 的 `motions_settled` 使用。
    if (options.motionClipFrames) {
      for (const action of actions) {
        if (!action.motion) continue
        const clip = options.motionClipFrames.get(`${action.modelId}|${action.motion}`) ?? 0
        if (clip > 0) {
          bodyEndByModel.set(
            action.modelId,
            Math.max(bodyEndByModel.get(action.modelId) ?? 0, action.frame + clip)
          )
        }
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
      ...(fst ? { fst } : {}),
      actions
    })

    // 前置栅栏等的是所有实际运行任务的结束帧 +1；零等待片段与后续同帧串行。
    runningFenceEndFrame = Math.max(runningFenceEndFrame, finishFrame + (hasFence ? 1 : 0))
    lastEndFrame = Math.max(lastEndFrame, finishFrame)
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
