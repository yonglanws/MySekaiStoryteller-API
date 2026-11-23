import {
  AUTO_NEXT_PAGE_DELAY_FRAMES,
  AUTO_WAIT_AFTER_VOICE_FRAMES,
  VOICE_END_LATENCY_SECONDS,
  WORD_INTERVAL_FRAMES,
  framesForSeconds
} from './timing'

/**
 * TalkWindow 自动模式的逐帧推进（`sse-timeline/src/lib.rs:1089-1176` 的移植）。
 *
 * - 打字从 `typing_start` 起每字 4 帧（两个半字各 2 帧）；
 * - 打字结束那一帧进入 AUTO：无语音 → 直接停 `auto_next_page_delay`（121 帧）；
 * - 有语音且语音已在打字结束前结束 → 同样停 121 帧；
 * - 有语音且尚未结束 → 等到 `min(voice_end, typing_end + frames_for(30) − 1)`，
 *   再 Gate `auto_wait_after_voice`（30 帧）；
 * - 布局/动作收尾期间 Gate 继续阻塞，收尾后的等待仍是上面那个值。
 *
 * 返回所有帧号都是绝对的（相对片段 act）。
 */

/** `talk.auto_voice_timeout = 30s` 的帧数（1801；超时判断用 −1）。 */
export const AUTO_VOICE_TIMEOUT_FRAMES = framesForSeconds(30)

export interface TalkAutoInput {
  /** 片段 act 帧。 */
  startFrame: number
  /** 对话框打开动画占用的帧数（首句/关闭后第一句 12 帧）。 */
  windowFrames: number
  /** 官方正文的 UTF-16 长度（含官方换行）。 */
  length: number
  /** 语音秒数；0 表示无语音。 */
  voiceSeconds: number
  /** 仍在跑的布局结束帧（绝对），0/undefined 表示没有。 */
  layoutEndFrame?: number
  /** Talk 内身体动作收尾帧数（相对 act）。 */
  settleFrames?: number
  /** MSST 导出专用：纯标点静默句的短停顿（不传则按官方 121 帧）。 */
  silentHoldFrames?: number
}

export interface TalkAutoFrameTiming {
  windowOpenFrames: number
  typingStartFrame: number
  typingEndFrame: number
  voiceEndFrame: number | null
  gateEndFrame: number
  endFrame: number
}

export function talkAutoFrameTiming(input: TalkAutoInput): TalkAutoFrameTiming {
  const { startFrame } = input
  const typingStartFrame = startFrame + Math.max(0, input.windowFrames)
  const typingEndFrame = typingStartFrame + Math.max(0, input.length) * WORD_INTERVAL_FRAMES
  const silentHold = input.silentHoldFrames ?? 0
  let pauseUntil = typingEndFrame
  let tailFrames =
    silentHold > 0 && input.voiceSeconds <= 0
      ? Math.max(0, Math.round(silentHold))
      : AUTO_NEXT_PAGE_DELAY_FRAMES
  let voiceEndFrame: number | null = null
  if (Number.isFinite(input.voiceSeconds) && input.voiceSeconds > 0) {
    voiceEndFrame = startFrame + framesForSeconds(input.voiceSeconds + VOICE_END_LATENCY_SECONDS)
    if (voiceEndFrame <= typingEndFrame) {
      // 语音已在打字结束前结束：OnFinishVoice 已经过去，盖 Gate 后停 2.0s。
      pauseUntil = typingEndFrame
      tailFrames = AUTO_NEXT_PAGE_DELAY_FRAMES
    } else {
      // 超时判定在进入等待的那一帧：typing_end + frames_for(30) − 1。
      pauseUntil = Math.min(voiceEndFrame, typingEndFrame + AUTO_VOICE_TIMEOUT_FRAMES - 1)
      tailFrames = AUTO_WAIT_AFTER_VOICE_FRAMES
    }
  }
  const gateEndFrame = Math.max(
    pauseUntil,
    input.layoutEndFrame ?? 0,
    startFrame + Math.max(0, input.settleFrames ?? 0)
  )
  return {
    windowOpenFrames: Math.max(0, input.windowFrames),
    typingStartFrame,
    typingEndFrame,
    voiceEndFrame,
    gateEndFrame,
    endFrame: gateEndFrame + tailFrames
  }
}
