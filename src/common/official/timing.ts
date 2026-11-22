/**
 * 官方剧情演出的时序常量与帧换算。
 *
 * 数值来自 SekaiStoryExporter 已核对过的客户端常量
 * （crates/sse-core/src/consts.rs，CN 6.4.0 / JP 6.8.1），不是按本项目观感调的近似值。
 * 剧情固定 60 fps；Unity 的 `while (elapsed < duration) { elapsed += dt; yield; }`
 * 等价于 `ceil(duration × fps)` 帧，所以本文件统一先换算成帧，再换算回毫秒。
 *
 * 所有新代码只从这里取常量；旧模块保留自己的导出名作为兼容别名。
 */

export const STORY_FPS = 60
export const FRAME_MS = 1000 / STORY_FPS

/** Unity `WaitForSeconds` 的帧数：duration <= 0 等 0 帧，否则向上取整。 */
export function framesForSeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0
  const frames = seconds * STORY_FPS
  // 已经是整帧（例如 0.1s×60=6、7 帧=116.667ms）时不要因为浮点误差多等一帧。
  const nearest = Math.round(frames)
  if (Math.abs(frames - nearest) < 1e-3) return nearest
  return Math.ceil(frames)
}

export function framesToMs(frames: number): number {
  if (!Number.isFinite(frames)) return 0
  return Math.round(frames * FRAME_MS * 1000) / 1000
}

export function secondsToFrames(seconds: number): number {
  return framesForSeconds(seconds)
}

export function msToFrames(ms: number): number {
  return framesForSeconds(ms / 1000)
}

export function quantizeMsToFrame(ms: number): number {
  return framesToMs(msToFrames(ms))
}

export function quantizeSecondsToFrame(seconds: number): number {
  return framesForSeconds(seconds) / STORY_FPS
}

// ---- talk window ---------------------------------------------------------------------

/** talk.word_interval = 0.06s；一个半字 2 帧，一个字 4 帧。 */
export const WORD_INTERVAL_SECONDS = 0.06
export const WORD_INTERVAL_HALF_FRAMES = framesForSeconds(WORD_INTERVAL_SECONDS * 0.5)
export const WORD_INTERVAL_FRAMES = WORD_INTERVAL_HALF_FRAMES * 2
export const TALK_DISPLAY_MS_PER_CHAR = framesToMs(WORD_INTERVAL_FRAMES)

/** talk.auto_next_page_delay = 2.0s（无语音时，打字结束后的停留）。 */
export const AUTO_NEXT_PAGE_DELAY_SECONDS = 2
export const AUTO_NEXT_PAGE_DELAY_FRAMES = framesForSeconds(AUTO_NEXT_PAGE_DELAY_SECONDS)
export const AUTO_NEXT_PAGE_DELAY_MS = framesToMs(AUTO_NEXT_PAGE_DELAY_FRAMES)

/** talk.auto_wait_after_voice = 0.5s（语音结束、动作收尾后的停留）。 */
export const AUTO_WAIT_AFTER_VOICE_SECONDS = 0.5
export const AUTO_WAIT_AFTER_VOICE_FRAMES = framesForSeconds(AUTO_WAIT_AFTER_VOICE_SECONDS)
export const AUTO_WAIT_AFTER_VOICE_MS = framesToMs(AUTO_WAIT_AFTER_VOICE_FRAMES)

/** sound.voice_end_latency = 0.05s：CRI 的 Removed 状态比最后一个采样晚约 50ms。 */
export const VOICE_END_LATENCY_SECONDS = 0.05
export const VOICE_END_LATENCY_FRAMES = framesForSeconds(VOICE_END_LATENCY_SECONDS)
export const VOICE_END_LATENCY_MS = framesToMs(VOICE_END_LATENCY_FRAMES)

/** talk.auto_voice_timeout = 30s。 */
export const AUTO_VOICE_TIMEOUT_SECONDS = 30

/** TalkWindow.Open/Close 的 `PlayActive(?, 0.2)`。 */
export const TALK_WINDOW_OPEN_CLOSE_SECONDS = 0.2
export const TALK_WINDOW_OPEN_CLOSE_FRAMES = framesForSeconds(TALK_WINDOW_OPEN_CLOSE_SECONDS)
export const TALK_WINDOW_OPEN_CLOSE_MS = framesToMs(TALK_WINDOW_OPEN_CLOSE_FRAMES)

// ---- layout --------------------------------------------------------------------------

/** layout.move_duration_normal / _fast / _slow。 */
export const MOVE_DURATION_NORMAL_SECONDS = 0.5
export const MOVE_DURATION_FAST_SECONDS = 0.33
export const MOVE_DURATION_SLOW_SECONDS = 0.75
export const MOVE_DURATION_NORMAL_MS = framesToMs(framesForSeconds(MOVE_DURATION_NORMAL_SECONDS))
export const MOVE_DURATION_FAST_MS = framesToMs(framesForSeconds(MOVE_DURATION_FAST_SECONDS))
export const MOVE_DURATION_SLOW_MS = framesToMs(framesForSeconds(MOVE_DURATION_SLOW_SECONDS))

/** MoveSpeed 枚举名 -> 官方 move 时长（毫秒）。 */
export const MOVE_SPEED_DURATION_MS = {
  Slow: MOVE_DURATION_SLOW_MS,
  Normal: MOVE_DURATION_NORMAL_MS,
  Fast: MOVE_DURATION_FAST_MS,
  Immediate: 0
} as const

/** 已在场的角色再次 Appear：CharacterMoveToCoroutine(side, 0.2)，不淡入。 */
export const APPEAR_SHOWN_MOVE_SECONDS = 0.2
export const APPEAR_SHOWN_MOVE_FRAMES = framesForSeconds(APPEAR_SHOWN_MOVE_SECONDS)
export const APPEAR_SHOWN_MOVE_MS = framesToMs(APPEAR_SHOWN_MOVE_FRAMES)

/** layout.character_fade_duration = 0.1s。 */
export const CHARACTER_FADE_SECONDS = 0.1
export const CHARACTER_FADE_MS = framesToMs(framesForSeconds(CHARACTER_FADE_SECONDS))

/** 30fps 导出模式下角色淡入/淡出平滑时长（6 帧 @ 30fps = 200ms，避免 100ms 仅 3 帧的突兀闪现）。 */
export const EXPORT_30FPS_CHARACTER_FADE_MS = 200

export function resolveCharacterFadeMs(isExporting: boolean, encodeFps = STORY_FPS): number {
  if (isExporting && Number.isFinite(encodeFps) && encodeFps <= 35) {
    return EXPORT_30FPS_CHARACTER_FADE_MS
  }
  return CHARACTER_FADE_MS
}

/** 30fps 导出模式下纯标点静默句（如「…………」）打字结束后的短停顿（0.8s = 48 帧）。 */
export const SILENT_PUNCTUATION_HOLD_SECONDS = 0.8
export const SILENT_PUNCTUATION_HOLD_FRAMES = framesForSeconds(SILENT_PUNCTUATION_HOLD_SECONDS)
export const SILENT_PUNCTUATION_HOLD_MS = framesToMs(SILENT_PUNCTUATION_HOLD_FRAMES)

/** 原地 HideCharacter 的 delay = 0.15s。 */
export const HIDE_DELAY_IN_PLACE_SECONDS = 0.15
export const HIDE_DELAY_IN_PLACE_MS = framesToMs(framesForSeconds(HIDE_DELAY_IN_PLACE_SECONDS))

/** 滑动 HideCharacter：delay = move_duration - 0.1s。 */
export const HIDE_SLIDE_FADE_OFFSET_SECONDS = -0.1

/** ScenarioTelopPlayer：in/out 动画各 0.333s，AUTO 停留 2s。 */
export const TELOP_ANIM_CLIP_SECONDS = 0.33333334
export const TELOP_AUTO_HOLD_SECONDS = 2
export const TELOP_ANIM_CLIP_MS = framesToMs(framesForSeconds(TELOP_ANIM_CLIP_SECONDS))
export const TELOP_AUTO_HOLD_MS = framesToMs(framesForSeconds(TELOP_AUTO_HOLD_SECONDS))
export const TELOP_TOTAL_MS = framesToMs(
  framesForSeconds(TELOP_ANIM_CLIP_SECONDS) * 2 + framesForSeconds(TELOP_AUTO_HOLD_SECONDS)
)

/**
 * Appear 的 `FadeOpacityCoroutine`：先 `WaitForSeconds(0)`（至少 1 帧，alpha=0），
 * 再 0.1s 淡入。LayoutAppear 片段在这 7 帧后完成，滑入可以继续。
 */
export const APPEAR_FADE_TOTAL_FRAMES = 1 + framesForSeconds(CHARACTER_FADE_SECONDS)
export const APPEAR_FADE_TOTAL_MS = framesToMs(APPEAR_FADE_TOTAL_FRAMES)

/** 原地 Hide 的片段完成帧数：0.15s delay（9 帧）+ 0.1s fade（6 帧）= 250ms。 */
export const HIDE_IN_PLACE_TOTAL_FRAMES =
  framesForSeconds(HIDE_DELAY_IN_PLACE_SECONDS) + framesForSeconds(CHARACTER_FADE_SECONDS)
export const HIDE_IN_PLACE_TOTAL_MS = framesToMs(HIDE_IN_PLACE_TOTAL_FRAMES)

/** layout.transform_map：普通/三人模式的侧位 X（参考像素，舞台宽 1920）。 */
export const SIDE_X_DEFAULT = 350
export const SIDE_X_THREE = 550
export const LAYOUT_REFERENCE_WIDTH = 1920

/** layout.mode_scale。 */
export const MODE_SCALE_DEFAULT = 1
export const MODE_SCALE_THREE = 0.9

// ---- Live2D --------------------------------------------------------------------------

/** live2d.body_motion_fade = 0.5s。 */
export const BODY_MOTION_FADE_SECONDS = 0.5
/** live2d.facial_fade = 0.25s。 */
export const FACIAL_FADE_SECONDS = 0.25
/** live2d.same_category_blend = 0.125s。 */
export const SAME_CATEGORY_BLEND_SECONDS = 0.125

/**
 * live2d.eyeblink（`CubismAutoEyeBlinkInput`）。
 *
 * 官方眨眼不是正弦曲线，而是四段线性相位：闭眼 1.0 / 全闭 0.5 / 睁眼 1.5（游戏单位），
 * `Timescale = 10`，换算成秒即 0.1s / 0.05s / 0.15s，一眨共 0.3s（60fps 18 帧）。
 * 全闭相位保证至少 1 帧完全合眼，正弦近似在 30fps 下永远闭不实。
 */
export const EYEBLINK_MEAN_SECONDS = 3
export const EYEBLINK_MAX_DEVIATION_SECONDS = 2
export const EYEBLINK_TIMESCALE = 10
export const EYEBLINK_CLOSING_SECONDS = 1.0 / EYEBLINK_TIMESCALE
export const EYEBLINK_CLOSED_SECONDS = 0.5 / EYEBLINK_TIMESCALE
export const EYEBLINK_OPENING_SECONDS = 1.5 / EYEBLINK_TIMESCALE

/** live2d.breath：3s 周期，影响 0.5；每帧 breathVector = 360/(3×60) = 2°。 */
export const BREATH_CYCLE_SECONDS = 3
export const BREATH_VECTOR_DEGREES_PER_FRAME = 360 / (BREATH_CYCLE_SECONDS * STORY_FPS)
export const BREATH_INFLUENCE = 0.5
export const DEG2RAD = 0.017453292

/** lipsync.lip_levels（38 个值）。 */
export const LIP_LEVELS: readonly number[] = [
  0.12, 0.24, 0.9, 1.0, 0.5, 0.24, 0.1, 0.24, 0.45, 0.8, 0.8, 0.96, 0.8, 0.4, 0.24, 0.1, 0.06, 0.1,
  0.24, 0.24, 0.5, 0.7, 0.96, 0.9, 0.8, 0.24, 0.24, 0.1, 0.06, 0.1, 0.24, 0.4, 0.5, 0.9, 0.8, 0.45,
  0.3, 0.24
]

/** Live2DVoice defaults。 */
export const LIP_TARGET_VALUE_SCALE = 1
export const LIP_POW_K = 1.75
export const LIP_LOUD_TARGET_VALUE_SCALE = 1.25
export const LIP_THRESHOLD = 0.06
export const LIP_MIN_VALUE = 0.2
export const LIP_MAX_VALUE = 1

/** 官方口型平滑：按当前值选择目标/历史权重。 */
export function smoothLipValue(target: number, previous: number): number {
  const [kt, kp] =
    previous < 0.1 ? [0.6, 0.4] : Math.abs(target - previous) < 0.1 ? [0.2, 0.8] : [0.25, 0.75]
  return target * kt + previous * kp
}

/**
 * `AdvLipSyncPolicy` 的 Fallback（CRI Lips）预设，取自 ournotes-player 对游戏
 * `Live2DAnimation.LipSyncPresets` 的逐字段移植；`minSpeech/speechFloor` 按
 * 本项目 RMS 曲线的实际量程下调（官方预设面向 CRI openY，直接套用会把轻声
 * 全部抬到 0.17，嘴型看起来不动）。attack/release/hold 与官方一致。
 */
export const MOUTH_SYNC_FALLBACK_PRESET = {
  attack: 0.032,
  release: 0.1,
  hold: 0.06,
  /** 第一道（细节）平滑时间常数，上行时再乘 0.65。 */
  hfs: 0.022,
  speakingThr: 0.02,
  silenceFloor: 0.01,
  speechFloor: 0.05,
  minSpeech: 0.1,
  /** 每次开口的第一个输出下限（张嘴起势）。 */
  onset: 0.12,
  openScale: 1.03,
  /** 开度压缩：t = t / (comp × t + 1)，0 表示关闭。 */
  comp: 0.07,
  /** 张幅上限。 */
  openCap: 0.92,
  /** 说话时把 ParamMouthForm 按开度向默认值中和的比例。 */
  formOpenSupp: 0.16
} as const

/** RMS 口型包络专用的最小开度：官方 0.2 对 TTS 太高一档，会把轻声与正常音节压成同一档。 */
export const LIP_RMS_MIN_VALUE = 0.08

/** 语音口型目标值：RMS → 官方 pow 曲线、阈值与限幅。 */
export function lipTargetFromRms(
  rms: number,
  targetValueScale = LIP_TARGET_VALUE_SCALE,
  powK = LIP_POW_K,
  minValue = LIP_MIN_VALUE
): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0
  const a = rms * targetValueScale
  const shaped = a * Math.pow(a + 1, powK)
  if (shaped < LIP_THRESHOLD) return 0
  return Math.min(LIP_MAX_VALUE, Math.max(minValue, shaped))
}

// ---- episode -------------------------------------------------------------------------

/** 开场黑幕淡出 0.5s；结束 playedWaitTime 0.25s + BGM 淡出 0.25s。 */
export const OPENING_COVER_FADE_SECONDS = 0.5
export const PLAYED_WAIT_TIME_SECONDS = 0.25
export const SCENARIO_EXIT_BGM_FADE_SECONDS = 0.25
export const OPENING_COVER_FADE_MS = framesToMs(framesForSeconds(OPENING_COVER_FADE_SECONDS))
export const PLAYED_WAIT_TIME_MS = framesToMs(framesForSeconds(PLAYED_WAIT_TIME_SECONDS))
export const SCENARIO_EXIT_BGM_FADE_MS = framesToMs(
  framesForSeconds(SCENARIO_EXIT_BGM_FADE_SECONDS)
)

// ---- official special effects & UI ---------------------------------------------------

export const PLACE_INFO_TRANSITION_SECONDS = 0.2
export const PLACE_INFO_TRANSITION_MS = framesToMs(framesForSeconds(PLACE_INFO_TRANSITION_SECONDS))

export const CHARACTER_SHAKE_SECONDS = 0.3
export const CHARACTER_SHAKE_MS = framesToMs(framesForSeconds(CHARACTER_SHAKE_SECONDS))

export const SEKAI_IN_PRE_DELAY_SECONDS = 0.25
export const SEKAI_OUT_PRE_DELAY_SECONDS = 0.5
export const SEKAI_IN_PRE_DELAY_MS = framesToMs(framesForSeconds(SEKAI_IN_PRE_DELAY_SECONDS))
export const SEKAI_OUT_PRE_DELAY_MS = framesToMs(framesForSeconds(SEKAI_OUT_PRE_DELAY_SECONDS))
export const SEKAI_IN_FADE_DELAY_MS = SEKAI_IN_PRE_DELAY_MS
export const SEKAI_OUT_FADE_DELAY_MS = SEKAI_OUT_PRE_DELAY_MS

/** 官方 Character AmbientColor RGB 线性倍乘。 */
export const MODEL_COLOR_EVENING = [0.99, 0.9, 0.8] as const
export const MODEL_COLOR_NIGHT = [0.83, 0.86, 0.91] as const

export const FULLSCREEN_BARS_SECONDS = 1.0
export const FULLSCREEN_TEXT_PRE_DELAY_SECONDS = 0.5
export const FULLSCREEN_TEXT_HOLD_SECONDS = 1.0
export const FULLSCREEN_CHAR_FADE_SECONDS = 0.125
export const FULLSCREEN_BARS_MS = framesToMs(framesForSeconds(FULLSCREEN_BARS_SECONDS))
export const FULLSCREEN_TEXT_PRE_DELAY_MS = framesToMs(
  framesForSeconds(FULLSCREEN_TEXT_PRE_DELAY_SECONDS)
)
export const FULLSCREEN_TEXT_HOLD_MS = framesToMs(framesForSeconds(FULLSCREEN_TEXT_HOLD_SECONDS))
export const FULLSCREEN_CHAR_FADE_MS = framesToMs(framesForSeconds(FULLSCREEN_CHAR_FADE_SECONDS))

export const SIMPLE_SELECTABLE_OPEN_SECONDS = 0.125
export const SIMPLE_SELECTABLE_AUTO_WAIT_SECONDS = 1.5
export const SIMPLE_SELECTABLE_CLOSE_SECONDS = 0.5
export const SIMPLE_SELECTABLE_TOTAL_MS = framesToMs(
  framesForSeconds(SIMPLE_SELECTABLE_OPEN_SECONDS) +
    framesForSeconds(SIMPLE_SELECTABLE_AUTO_WAIT_SECONDS) +
    framesForSeconds(SIMPLE_SELECTABLE_CLOSE_SECONDS)
)

export const FLASHBACK_DEFAULT_MS = 100
export const SEPIA_DEFAULT_MS = 100

export const SIDE_OVER_OFFSET_X = 819.2
export const SIDE_OVER_X = LAYOUT_REFERENCE_WIDTH / 2 + SIDE_OVER_OFFSET_X
export const SIDE_UNDER_Y = -1123.2

/**
 * 统一官方秒与项目毫秒：<= 10 视为秒（乘以 1000），> 10 视为毫秒。
 */
export function normalizeEffectDurationMs(duration: number | undefined, fallbackMs = 0): number {
  if (duration === undefined || !Number.isFinite(duration)) return fallbackMs
  if (duration <= 0) return 0
  return duration > 10 ? duration : duration * 1000
}
