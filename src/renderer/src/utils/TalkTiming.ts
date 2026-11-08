import {
  AUTO_NEXT_PAGE_DELAY_FRAMES,
  AUTO_WAIT_AFTER_VOICE_FRAMES,
  FRAME_MS,
  TALK_DISPLAY_MS_PER_CHAR,
  VOICE_END_LATENCY_SECONDS,
  WORD_INTERVAL_FRAMES,
  framesForSeconds,
  framesToMs
} from '../../../common/official/timing'
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
   * Talk 内所有身体动作 cue 的最晚结束时间（相对 Talk 开始）。
   * 官方自动模式在语音结束后还要等动作收尾，再停留 0.5s。
   */
  motionSettleMs?: number
  /**
   * 对话框从关闭到打开的时间（通常 0.2s）。官方 TalkWindow.Play 会先打开窗口，
   * `OnCompleteOpen` 才开始打字；语音和动作仍在 Talk 开始帧启动。
   */
  windowOpenMs?: number
}

/** 打字机时长：官方每字 4 帧（两个 WaitForSeconds(0.03)），只数可见字符。 */
export function talkTypingDurationMs(content: string): number {
  return framesToMs(visibleTextLength(content) * WORD_INTERVAL_FRAMES)
}

/**
 * Talk 片段 body 的时长（不含 BaseSnippet 的 delay）。
 *
 * 官方 `TalkWindow` 自动模式：
 * - 有语音：`max(窗口打开 + 打字结束, 语音结束 + 0.05s, 动作收尾)` 之后再等 0.5s；
 * - 无语音：打字结束后等 2.0s，不检查动作。
 *
 * 窗口打开只推迟打字，不推迟语音；语音足够长时不会额外增加时长。
 */
export function calculateTalkDurationMs(
  content: string,
  ttsDurationMs = 0,
  ttsText = '',
  options: TalkDurationOptions = {}
): number {
  const length = visibleTextLength(content)
  const windowFrames = framesForSeconds((options.windowOpenMs ?? 0) / 1000)
  const typingFrames = windowFrames + length * WORD_INTERVAL_FRAMES
  const speechMs =
    Number.isFinite(ttsDurationMs) && ttsDurationMs > 0
      ? ttsDurationMs
      : options.hasVoice
        ? Math.max(0, (ttsText || content).length) * TALK_ESTIMATED_SPEECH_MS_PER_CHAR
        : 0

  if (speechMs <= 0) {
    return framesToMs(typingFrames + AUTO_NEXT_PAGE_DELAY_FRAMES)
  }

  const voiceFrames = framesForSeconds(speechMs / 1000 + VOICE_END_LATENCY_SECONDS)
  const settleFrames =
    Number.isFinite(options.motionSettleMs) && (options.motionSettleMs ?? 0) > 0
      ? framesForSeconds((options.motionSettleMs as number) / 1000)
      : 0
  const doneFrames = Math.max(typingFrames, voiceFrames, settleFrames)
  return framesToMs(doneFrames + AUTO_WAIT_AFTER_VOICE_FRAMES)
}

/** 诊断/测试用：把 Talk 拆成官方自动模式的四个阶段（毫秒，已帧量化）。 */
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
  const length = visibleTextLength(content)
  const windowFrames = framesForSeconds((options.windowOpenMs ?? 0) / 1000)
  const typingFrames = windowFrames + length * WORD_INTERVAL_FRAMES
  const speechMs =
    Number.isFinite(ttsDurationMs) && ttsDurationMs > 0
      ? ttsDurationMs
      : options.hasVoice
        ? Math.max(0, (ttsText || content).length) * TALK_ESTIMATED_SPEECH_MS_PER_CHAR
        : 0
  const typingMs = framesToMs(typingFrames)
  if (speechMs <= 0) {
    return {
      typingMs,
      voiceEndMs: null,
      gateEndMs: typingMs,
      totalMs: framesToMs(typingFrames + AUTO_NEXT_PAGE_DELAY_FRAMES)
    }
  }
  const voiceFrames = framesForSeconds(speechMs / 1000 + VOICE_END_LATENCY_SECONDS)
  const settleFrames =
    Number.isFinite(options.motionSettleMs) && (options.motionSettleMs ?? 0) > 0
      ? framesForSeconds((options.motionSettleMs as number) / 1000)
      : 0
  const gateFrames = Math.max(typingFrames, voiceFrames, settleFrames)
  return {
    typingMs,
    voiceEndMs: framesToMs(voiceFrames),
    gateEndMs: framesToMs(gateFrames),
    totalMs: framesToMs(gateFrames + AUTO_WAIT_AFTER_VOICE_FRAMES)
  }
}

/** 帧常量再导出，测试和计划层可以直接引用。 */
export { FRAME_MS }
