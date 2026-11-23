import {
  AUTO_WAIT_AFTER_VOICE_FRAMES,
  FRAME_MS,
  TALK_DISPLAY_MS_PER_CHAR,
  WORD_INTERVAL_FRAMES,
  framesForSeconds,
  framesToMs,
  msToFrameCount
} from '../../../common/official/timing'
import { talkAutoFrameTiming } from '../../../common/official/talkAuto'
import { sliceVisibleText, visibleTextLength } from '../../../common/official/text'

export { sliceVisibleText, visibleTextLength }
export { TALK_DISPLAY_MS_PER_CHAR }

/** 仅用于没有真实语音文件、但剧本标了 voice 的旧数据；AI 剧本有 TTS 时长时不走这里。 */
export const TALK_ESTIMATED_SPEECH_MS_PER_CHAR = 143

/** 兼容旧名字：官方语音后的自动停留是 0.5s，不再是固定 600ms。 */
export const TALK_TAIL_MS = framesToMs(AUTO_WAIT_AFTER_VOICE_FRAMES)

/** 官方自动模式没有 1.8s 下限；保留导出名避免旧调用点编译失败。 */
export const MIN_TALK_DURATION_MS = 0

export interface TalkDurationOptions {
  /** 剧本有 voice 文件但没有可用的音频时长时，按文本估算语音长度。 */
  hasVoice?: boolean
  /**
   * Talk 内所有身体动作 cue（或仍未收尾的舞台动作）的最晚结束时间（相对 Talk 开始）。
   * 官方自动模式在语音结束后还要等动作收尾，再停留。
   */
  motionSettleMs?: number
  /**
   * 仍在后台滑动/退场的 Layout 任务的剩余结束时间（相对 Talk 开始）。
   * 官方 Talk Gate：`while (layoutRunning || !motionsSettled) wait`。
   */
  layoutRunningMs?: number
  /**
   * 对话框从关闭到打开的时间（通常 0.2s）。官方 TalkWindow.Play 会先打开窗口，
   * `OnCompleteOpen` 才开始打字；语音和动作仍在 Talk 开始帧启动。
   */
  windowOpenMs?: number
  /**
   * 可选：无语音的纯标点静默句在打字结束后的停顿时长（默认使用官方 2.0s）。
   */
  silentHoldMs?: number
}

/** 打字机时长：官方每字 4 帧（两个 WaitForSeconds(0.03)），只数可见字符。 */
export function talkTypingDurationMs(content: string): number {
  return framesToMs(visibleTextLength(content) * WORD_INTERVAL_FRAMES)
}

/**
 * Talk 片段 body 的时长（不含 BaseSnippet 的 delay）。
 *
 * 官方 `TalkWindow` 自动模式：
 * - 有语音：`max(窗口打开 + 打字结束, 语音结束 + 0.05s, 布局结束, 动作收尾)` 之后停留：
 *   若语音在打字结束前就已经播完，按 `2.0s`（`AUTO_NEXT_PAGE_DELAY`）停留，否则 `0.5s`；
 * - 无语音：打字结束后等 `2.0s`，不检查动作/布局。
 *
 * 窗口打开只推迟打字，不推迟语音；语音足够长时不会额外增加时长。
 */
export function calculateTalkDurationMs(
  content: string,
  ttsDurationMs = 0,
  ttsText = '',
  options: TalkDurationOptions = {}
): number {
  return framesToMs(talkAutoTiming(content, ttsDurationMs, ttsText, options).endFrame)
}

function resolveSpeechSeconds(
  content: string,
  ttsDurationMs: number,
  ttsText: string,
  hasVoice: boolean
): number {
  if (Number.isFinite(ttsDurationMs) && ttsDurationMs > 0) return ttsDurationMs / 1000
  if (!hasVoice) return 0
  return (Math.max(0, (ttsText || content).length) * TALK_ESTIMATED_SPEECH_MS_PER_CHAR) / 1000
}

function talkAutoTiming(
  content: string,
  ttsDurationMs: number,
  ttsText: string,
  options: TalkDurationOptions
): ReturnType<typeof talkAutoFrameTiming> {
  // 这些毫秒通常已经由 framesToMs 量化（例如 7 帧 = 116.667ms）：
  // 不能再走 f32 累加，否则 116.667ms 会被算成 8 帧。
  const silentHoldFrames =
    Number.isFinite(options.silentHoldMs) && (options.silentHoldMs as number) > 0
      ? msToFrameCount(options.silentHoldMs as number)
      : undefined
  return talkAutoFrameTiming({
    startFrame: 0,
    windowFrames: msToFrameCount(options.windowOpenMs ?? 0),
    length: visibleTextLength(content),
    voiceSeconds: resolveSpeechSeconds(content, ttsDurationMs, ttsText, Boolean(options.hasVoice)),
    layoutEndFrame:
      Number.isFinite(options.layoutRunningMs) && (options.layoutRunningMs ?? 0) > 0
        ? msToFrameCount(options.layoutRunningMs as number)
        : 0,
    settleFrames:
      Number.isFinite(options.motionSettleMs) && (options.motionSettleMs ?? 0) > 0
        ? framesForSeconds((options.motionSettleMs as number) / 1000)
        : 0,
    silentHoldFrames
  })
}

/** 诊断/测试用：把 Talk 拆成官方自动模式的阶段（毫秒，已帧量化）。 */
export function describeTalkTiming(
  content: string,
  ttsDurationMs = 0,
  ttsText = '',
  options: TalkDurationOptions = {}
): {
  typingMs: number
  voiceEndMs: number | null
  gateEndMs: number
  totalMs: number
} {
  const timing = talkAutoTiming(content, ttsDurationMs, ttsText, options)
  return {
    typingMs: framesToMs(timing.typingEndFrame),
    voiceEndMs: timing.voiceEndFrame === null ? null : framesToMs(timing.voiceEndFrame),
    gateEndMs: framesToMs(timing.gateEndFrame),
    totalMs: framesToMs(timing.endFrame)
  }
}

/** 帧常量再导出，测试和计划层可以直接引用。 */
export { FRAME_MS }
