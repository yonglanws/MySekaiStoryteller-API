/**
 * 官方剧情演出的时序常量与帧换算。
 *
 * 数值来自 SekaiStoryExporter 已核对过的客户端常量
 * （crates/sse-core/src/consts.rs，CN 6.4.0 / JP 6.8.1），不是按本项目观感调的近似值。
 * 剧情固定 60 fps；Unity 的 `while (elapsed < duration) { elapsed += dt; yield; }`
 * 用 f32 逐帧累加（`sse-core/src/time.rs:57-76`），所以帧数不等于简单的
 * `ceil(duration × fps)`：0.75s 是 46 帧、2.0s 是 121 帧、30s 是 1801 帧。
 *
 * 所有新代码只从这里取常量；旧模块保留自己的导出名作为兼容别名。
 */

export const STORY_FPS = 60
export const FRAME_MS = 1000 / STORY_FPS

const FRAME_DELTA_F32 = Math.fround(1 / STORY_FPS)

/**
 * Unity `WaitForSeconds` 的帧数：f32 `elapsed` 每帧 += `1/60`，直到 `elapsed >= duration`。
 * `duration <= 0` 等 0 帧；NaN 等 0 帧；Infinity 返回 u32 上限（参考实现饱和）。
 *
 * 逐位移植 `TimeBase::frames_for`：累加在 f32 里做，f32 不再增长时（2^19 s 之后）
 * 用 f64 余量向上取整。
 */
export function framesForSeconds(seconds: number): number {
  if (Number.isNaN(seconds) || seconds <= 0) return 0
  if (!Number.isFinite(seconds)) return 0xffffffff
  const duration = Math.fround(seconds)
  const delta = FRAME_DELTA_F32
  let elapsed = 0
  let frames = 0
  while (elapsed < duration) {
    const next = Math.fround(elapsed + delta)
    if (next === elapsed) {
      const rest = (duration - elapsed) / delta
      return Math.min(0xffffffff, frames + Math.ceil(rest))
    }
    elapsed = next
    frames += 1
  }
  return frames
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

/**
 * 把毫秒对齐到整帧。已经是整帧的量（如 116.667ms = 7 帧）原样返回，
 * 不要再经过 f32 累加——否则 116.667ms 会被算成 8 帧，多出幽灵帧。
 */
/** 已帧量化的毫秒 → 帧数（不做 f32 累加）；非整帧时退回 framesForSeconds。 */
export function msToFrameCount(ms: number): number {
  const frames = ms / FRAME_MS
  const nearest = Math.round(frames)
  if (Math.abs(frames - nearest) < 1e-3) return nearest
  return framesForSeconds(ms / 1000)
}

export function quantizeMsToFrame(ms: number): number {
  const frames = ms / FRAME_MS
  const nearest = Math.round(frames)
  if (Math.abs(frames - nearest) < 1e-3) return framesToMs(nearest)
  return framesToMs(framesForSeconds(ms / 1000))
}

export function quantizeSecondsToFrame(seconds: number): number {
  return framesForSeconds(seconds) / STORY_FPS
}

/**
 * 剧本以秒为单位给出 `duration` 的效果类型。参考实现直接对秒数调用 f32
 * `frames_for`（而不是先把秒乘 1000 再按整帧量化），3s/2s/4s/25s 分别是
 * 181/121/241/1501 帧，比 `msToFrameCount` 多 1 帧。
 */
export const SECONDS_DURATION_SNIPPET_TYPES: ReadonlySet<string> = new Set([
  'BlackOut',
  'BlackIn',
  'SideFade',
  'BlurIn',
  'BlurOut',
  'BackgroundBlur',
  'CameraMove',
  'CameraZoom',
  'DollyZoom',
  'ShakeScreen',
  'ShakeWindow',
  'FlashbackIn',
  'FlashbackOut',
  'Wait'
])

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

/**
 * 角色淡入/淡出固定 100ms（6 个故事帧），不再对 30fps 导出放大到 200ms：
 * 官方 `layout.character_fade_duration` 是剧本时间，与成片帧率无关。
 */
export function resolveCharacterFadeMs(_isExporting = false, _encodeFps = STORY_FPS): number {
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

/**
 * ScenarioTelopPlayer：in/out 动画各 0.333s（20 帧），AUTO 停留
 * `frames_for(2.0) - 1` 帧（121-1=120：hold 循环在 "in" 结束那一帧就加了一次 dt），
 * 片段总长 20+120+20 = 160 帧。
 */
export const TELOP_ANIM_CLIP_SECONDS = 0.33333334
export const TELOP_AUTO_HOLD_SECONDS = 2
export const TELOP_ANIM_CLIP_FRAMES = framesForSeconds(TELOP_ANIM_CLIP_SECONDS)
export const TELOP_HOLD_FRAMES = framesForSeconds(TELOP_AUTO_HOLD_SECONDS) - 1
export const TELOP_TOTAL_FRAMES = TELOP_ANIM_CLIP_FRAMES * 2 + TELOP_HOLD_FRAMES
export const TELOP_ANIM_CLIP_MS = framesToMs(TELOP_ANIM_CLIP_FRAMES)
export const TELOP_AUTO_HOLD_MS = framesToMs(TELOP_HOLD_FRAMES)
export const TELOP_TOTAL_MS = framesToMs(TELOP_TOTAL_FRAMES)

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
 * live2d.eyeblink（`Live2DEyeBlinkController`）：均值 3s、偏差 ±2s、`Speed = 10`。
 *
 * 自动眨眼是 |sin| 控制器：Ready 状态的 `untilTime` 减到 <0 时相位从 -π/2 起，
 * 每帧 += speed×dt，`EyeOpening = |sin(radian)|`；|sin| 回到上升沿（本帧值小于
 * 上帧值）时结束并重抽 `3 + Random.Range(-2, 2)`。一眨 π/10 s ≈ 19 步 <1，
 * 第 20 步强制 1.0；30fps 抽取按步号奇偶得到 0.0707 / 0.0957 两个谷值。
 */
export const EYEBLINK_MEAN_SECONDS = 3
export const EYEBLINK_MAX_DEVIATION_SECONDS = 2
export const EYEBLINK_SPEED = 10

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
/** `LIPSYNC_LOUD_CHARACTERS`：这些角色号的模型初值为 1.25（其余 1.0）。 */
export const LIP_LOUD_CHARACTERS: readonly number[] = [1, 4, 8, 12, 17, 18]
export const LIP_THRESHOLD = 0.06
export const LIP_MIN_VALUE = 0.2
export const LIP_MAX_VALUE = 1

/**
 * 官方口型平滑（`Live2DVoice.UpdateParam`）：按当前值选择目标/历史权重。
 * 只有三档：当前值 <0.1 时 0.6/0.4；目标与当前值差 <0.1 时 0.2/0.8；
 * 否则 0.25/0.75。
 */
export function smoothLipValue(target: number, previous: number): number {
  const [kt, kp] =
    previous < 0.1 ? [0.6, 0.4] : Math.abs(target - previous) < 0.1 ? [0.2, 0.8] : [0.25, 0.75]
  return target * kt + previous * kp
}

/**
 * 官方 `SetLipSyncK(TargetValueScale, TargetValueScale × powK)`：
 * 一次 talk 会把说话人的口型系数重设为 `(tvs, tvs × 1.75)`。
 */
export function lipCoefficients(targetValueScale: number): {
  targetValueScale: number
  powK: number
} {
  const tvs =
    Number.isFinite(targetValueScale) && targetValueScale > 0
      ? targetValueScale
      : LIP_TARGET_VALUE_SCALE
  return { targetValueScale: tvs, powK: tvs * LIP_POW_K }
}

/** 语音口型目标值：RMS → 官方 pow 曲线、阈值与限幅。 */
export function lipTargetFromRms(
  rms: number,
  targetValueScale = LIP_TARGET_VALUE_SCALE,
  powK = LIP_POW_K
): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0
  const a = rms * targetValueScale
  const shaped = a * Math.pow(a + 1, powK)
  if (shaped < LIP_THRESHOLD) return 0
  return Math.min(LIP_MAX_VALUE, Math.max(LIP_MIN_VALUE, shaped))
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
/**
 * `SimpleSelectable`：打开动画与 1.5s 作答等待并行，作答后 0.5s 结束 → 91+30 = 121 帧。
 * 关闭缩放（0.125s）在这 0.5s 内完成，不额外占时长。
 */
export const SIMPLE_SELECTABLE_TOTAL_MS = framesToMs(
  framesForSeconds(SIMPLE_SELECTABLE_AUTO_WAIT_SECONDS) +
    framesForSeconds(SIMPLE_SELECTABLE_CLOSE_SECONDS)
)

export const FLASHBACK_DEFAULT_MS = 100
export const SEPIA_DEFAULT_MS = 100

export const SIDE_OVER_OFFSET_X = 819.2
export const SIDE_OVER_X = LAYOUT_REFERENCE_WIDTH / 2 + SIDE_OVER_OFFSET_X
/**
 * `GetScenarioCharacterTransformData` 的 Under y：`-(content_h/2 + outside_fill_offset_x)`
 * = -(1080/2 + 819.2) = -1359.2（y 用的是 x 方向的 margin 819.2）。
 */
export const SIDE_UNDER_Y = -(1080 / 2 + SIDE_OVER_OFFSET_X)

// ---- PlayCore / episode ---------------------------------------------------------------

/** `scenario.playcore_warmup_frames`：前 10 帧不放任何 snippet。 */
export const PLAYCORE_WARMUP_FRAMES = 10
/** 结局帧之后：`played_wait_time` 15 帧 + 1 帧 + 场景退出的 BGM 淡出 15 帧。 */
export const PLAYED_WAIT_TIME_FRAMES = framesForSeconds(PLAYED_WAIT_TIME_SECONDS)
export const SCENARIO_EXIT_BGM_FADE_FRAMES = framesForSeconds(SCENARIO_EXIT_BGM_FADE_SECONDS)

/**
 * 成片最后一帧的下一帧：cleanup + playedWaitTime(15) + 1 + exitBgmFade(15)。
 * `end_frame` 在 `sse-timeline/src/lib.rs:150-170`。
 */
export function storyEndFrame(cleanupFrame: number): number {
  return cleanupFrame + PLAYED_WAIT_TIME_FRAMES + 1 + SCENARIO_EXIT_BGM_FADE_FRAMES
}

/** 片尾最后 15 帧的 BGM 淡出起点（`storyEndFrame` 之前 15 帧）。 */
export function storyExitFrame(cleanupFrame: number): number {
  return cleanupFrame + PLAYED_WAIT_TIME_FRAMES + 1
}

// ---- choice dialog / full screen text / movie ----------------------------------------

/** `AnswerChoiceDialog`：面板缩放 0.125s；作答后 `WaitDelay(0.5)`。 */
export const DIALOG_SCALE_SECONDS = 0.125
export const ANSWER_FINISH_DELAY_SECONDS = 0.5
/** 导出替玩家作答的等待（非游戏数据）。 */
export const EXPORT_CHOICE_WAIT_SECONDS = 1.5
/** 导出手指按压时长（非游戏数据）：`pressed = answered - frames_for(0.1)`。 */
export const EXPORT_CHOICE_PRESS_SECONDS = 0.1
/** 高亮 `ButtonViewInteractionBase.FadeInTime/FadeOutTime`。 */
export const BUTTON_PRESS_FADE_IN_SECONDS = 0.1
export const BUTTON_PRESS_FADE_OUT_SECONDS = 0.4

/** `ScenarioFullScreenTextDialog.playDuration` 与逐槽 0.125s；TMP characterInfo 初值 8。 */
export const FST_PLAY_DURATION_SECONDS = 1
export const FST_TEXT_WAIT_SECONDS = 0.125
export const FST_OPEN_DELAY_SECONDS = 0.5
export const FST_VOICE_TIMEOUT_SECONDS = 10
export const FST_TMP_CHARACTER_INFO_INITIAL = 8

/** `ScenarioPlayer.movieResolution`。 */
export const MOVIE_RESOLUTION = [2338, 1080] as const
export const MOVIE_FADE_SECONDS = 0.5
/** 载入帧（官方录制的中位数）：影片从 act + 0.5s + 1 帧 + 10 帧开始。 */
export const MOVIE_LOAD_FRAMES = 10
export function movieLeadFrames(): number {
  return framesForSeconds(MOVIE_FADE_SECONDS) + 1 + MOVIE_LOAD_FRAMES
}

/** 场景特效 Stop 之后再保留 30s（`EFFECT_TAIL`）= 1801 帧。 */
export const EFFECT_TAIL_FRAMES = framesForSeconds(30)
/** `sekai_transition.lifetime` / `fx_transition_scenario` 的 DestroyAtTime。 */
export const SEKAI_TRANSITION_LIFETIME_SECONDS = 5
export const FX_LIFETIME_SECONDS = 5
/** 无限震屏/抖动时长。 */
export const INFINITY_DURATION_SECONDS = 3600
/** `ScenarioPlayer.shakeWindowBasePosition.y`。 */
export const SHAKE_BASE_Y = -8

/**
 * 统一官方秒与项目毫秒：<= 10 视为秒（乘以 1000），> 10 视为毫秒。
 */
export function normalizeEffectDurationMs(duration: number | undefined, fallbackMs = 0): number {
  if (duration === undefined || !Number.isFinite(duration)) return fallbackMs
  if (duration <= 0) return 0
  return duration > 10 ? duration : duration * 1000
}
