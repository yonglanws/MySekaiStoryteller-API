//! Official 60Hz timing constants and f32 WaitForSeconds frame conversion
//! matching `src/common/official/timing.ts`, `talkAuto.ts`, and `text.ts`.

pub const STORY_FPS: u32 = 60;
pub const FRAME_MS: f64 = 1000.0 / 60.0;
const FRAME_DELTA_F32: f32 = 1.0_f32 / 60.0_f32;
const LAYOUT_BREAK_MARKER: u16 = 0x200B;

/// Unity `WaitForSeconds` frame count using `f32` accumulation (`elapsed += 1/60` until `>= duration`).
pub fn frames_for_seconds(seconds: f64) -> u32 {
    if seconds.is_nan() || seconds <= 0.0 {
        return 0;
    }
    if !seconds.is_finite() {
        return u32::MAX;
    }
    let duration = seconds as f32;
    let delta = FRAME_DELTA_F32;
    let mut elapsed: f32 = 0.0;
    let mut frames: u32 = 0;
    while elapsed < duration {
        let next = elapsed + delta;
        if next == elapsed {
            let rest = ((duration as f64) - (elapsed as f64)) / (delta as f64);
            let add = rest.ceil().max(0.0);
            return frames.saturating_add(add as u32);
        }
        elapsed = next;
        frames = frames.saturating_add(1);
    }
    frames
}

pub fn frames_to_ms(frames: u32) -> f64 {
    ((f64::from(frames) * FRAME_MS) * 1000.0).round() / 1000.0
}

pub fn ms_to_frames(ms: f64) -> u32 {
    frames_for_seconds(ms / 1000.0)
}

pub fn ms_to_frame_count(ms: f64) -> u32 {
    if !ms.is_finite() || ms <= 0.0 {
        return 0;
    }
    let frames = ms / FRAME_MS;
    let nearest = frames.round();
    if (frames - nearest).abs() < 1e-3 {
        nearest.max(0.0) as u32
    } else {
        frames_for_seconds(ms / 1000.0)
    }
}

pub fn normalize_effect_duration_ms(duration: Option<f64>, fallback_ms: f64) -> f64 {
    match duration {
        Some(d) if d.is_finite() => {
            if d <= 0.0 {
                0.0
            } else if d > 10.0 {
                d
            } else {
                d * 1000.0
            }
        }
        _ => fallback_ms,
    }
}

/// UTF-16 visible text length skipping `\u{200B}` layout break markers and trailing `\n`/`\r`.
pub fn visible_text_length(content: &str) -> usize {
    let mut count = 0usize;
    let mut prev: u16 = 0;
    for unit in content.encode_utf16() {
        if unit == LAYOUT_BREAK_MARKER {
            prev = unit;
            continue;
        }
        if (unit == b'\n' as u16 || unit == b'\r' as u16) && prev == LAYOUT_BREAK_MARKER {
            prev = unit;
            continue;
        }
        count += 1;
        prev = unit;
    }
    count
}

pub fn has_speakable_speech_text(text: &str) -> bool {
    text.chars().any(|c| c.is_alphabetic() || c.is_numeric())
}

pub const PLAYCORE_WARMUP_FRAMES: u32 = 10;

pub fn word_interval_half_frames() -> u32 {
    frames_for_seconds(0.06 * 0.5)
}

pub fn word_interval_frames() -> u32 {
    word_interval_half_frames() * 2
}

pub fn auto_next_page_delay_frames() -> u32 {
    frames_for_seconds(2.0)
}

pub fn auto_wait_after_voice_frames() -> u32 {
    frames_for_seconds(0.5)
}

pub const VOICE_END_LATENCY_SECONDS: f64 = 0.05;

pub fn auto_voice_timeout_frames() -> u32 {
    frames_for_seconds(30.0)
}

pub fn talk_window_open_close_frames() -> u32 {
    frames_for_seconds(0.2)
}

pub fn appear_shown_move_frames() -> u32 {
    frames_for_seconds(0.2)
}

pub fn character_fade_ms() -> f64 {
    frames_to_ms(frames_for_seconds(0.1))
}

pub fn character_fade_in_place_ms() -> f64 {
    frames_to_ms(frames_for_seconds(0.35))
}

pub fn silent_punctuation_hold_frames() -> u32 {
    frames_for_seconds(0.8)
}

pub fn hide_delay_in_place_smooth_ms() -> f64 {
    frames_to_ms(frames_for_seconds(0.0))
}

pub fn move_speed_duration_ms(speed: Option<&str>) -> f64 {
    match speed {
        Some("Slow") => frames_to_ms(frames_for_seconds(0.75)),
        Some("Fast") => frames_to_ms(frames_for_seconds(0.33)),
        Some("Immediate") => 0.0,
        _ => frames_to_ms(frames_for_seconds(0.5)),
    }
}

pub const FST_TMP_CHARACTER_INFO_INITIAL: u32 = 8;

pub fn full_screen_text_slots(current: u32, text: &str) -> u32 {
    let trimmed = text.trim_start_matches(['\n', '\r']);
    let len = trimmed.chars().count() as u32;
    current.max(FST_TMP_CHARACTER_INFO_INITIAL).max(len)
}

pub struct FullScreenTextFrames {
    pub slots: u32,
    pub text_start_frame: u32,
    pub text_end_frame: u32,
    pub hold_frames: u32,
    pub fade_frames: u32,
}

pub fn full_screen_text_frames(first: bool, last: bool, slots: u32) -> FullScreenTextFrames {
    let slots = slots.max(FST_TMP_CHARACTER_INFO_INITIAL);
    let bars = frames_for_seconds(1.0);
    let open_delay = frames_for_seconds(0.5);
    let slot_frames = frames_for_seconds(0.125);
    let hold_frames = frames_for_seconds(1.0);
    let fade_frames = if last { frames_for_seconds(1.0) } else { 0 };
    let text_start_frame = if first { bars + open_delay } else { 0 };
    let text_end_frame = text_start_frame + slots * slot_frames;
    FullScreenTextFrames {
        slots,
        text_start_frame,
        text_end_frame,
        hold_frames,
        fade_frames,
    }
}

pub fn story_end_frame(cleanup_frame: u32) -> u32 {
    let played_wait = frames_for_seconds(0.25);
    let exit_fade = frames_for_seconds(0.25);
    cleanup_frame + played_wait + 1 + exit_fade
}

pub fn is_seconds_duration_snippet_type(ty: &str) -> bool {
    matches!(
        ty,
        "BlackOut"
            | "BlackIn"
            | "SideFade"
            | "BlurIn"
            | "BlurOut"
            | "BackgroundBlur"
            | "CameraMove"
            | "CameraZoom"
            | "DollyZoom"
            | "ShakeScreen"
            | "ShakeWindow"
            | "FlashbackIn"
            | "FlashbackOut"
            | "Wait"
    )
}

#[derive(Debug, Clone)]
pub struct TalkAutoInput {
    pub start_frame: u32,
    pub window_frames: u32,
    pub length: u32,
    pub voice_seconds: f64,
    pub layout_end_frame: u32,
    pub settle_frames: u32,
    pub silent_hold_frames: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct TalkAutoFrameTiming {
    pub window_open_frames: u32,
    pub typing_start_frame: u32,
    pub typing_end_frame: u32,
    pub voice_end_frame: Option<u32>,
    pub gate_end_frame: u32,
    pub end_frame: u32,
}

pub fn talk_auto_frame_timing(input: &TalkAutoInput) -> TalkAutoFrameTiming {
    let start_frame = input.start_frame;
    let typing_start_frame = start_frame + input.window_frames;
    let typing_end_frame = typing_start_frame + input.length * word_interval_frames();
    let silent_hold = input.silent_hold_frames.unwrap_or(0);
    let mut pause_until = typing_end_frame;
    let mut tail_frames = if silent_hold > 0 && input.voice_seconds <= 0.0 {
        silent_hold
    } else {
        auto_next_page_delay_frames()
    };
    let mut voice_end_frame = None;
    if input.voice_seconds.is_finite() && input.voice_seconds > 0.0 {
        let ve = start_frame + frames_for_seconds(input.voice_seconds + VOICE_END_LATENCY_SECONDS);
        voice_end_frame = Some(ve);
        if ve <= typing_end_frame {
            pause_until = typing_end_frame;
            tail_frames = auto_next_page_delay_frames();
        } else {
            let timeout_bound = typing_end_frame + auto_voice_timeout_frames().saturating_sub(1);
            pause_until = ve.min(timeout_bound);
            tail_frames = auto_wait_after_voice_frames();
        }
    }
    let gate_end_frame = pause_until
        .max(input.layout_end_frame)
        .max(start_frame + input.settle_frames);
    TalkAutoFrameTiming {
        window_open_frames: input.window_frames,
        typing_start_frame,
        typing_end_frame,
        voice_end_frame,
        gate_end_frame,
        end_frame: gate_end_frame + tail_frames,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_for_seconds_matches_unity_f32_stepping() {
        assert_eq!(frames_for_seconds(0.0), 0);
        assert_eq!(frames_for_seconds(-1.0), 0);
        assert_eq!(frames_for_seconds(0.75), 46);
        assert_eq!(frames_for_seconds(2.0), 121);
        assert_eq!(frames_for_seconds(30.0), 1801);
        assert_eq!(frames_for_seconds(0.2), 12);
        assert_eq!(frames_for_seconds(0.5), 30);
    }

    #[test]
    fn visible_text_length_skips_layout_break_markers() {
        assert_eq!(visible_text_length("hello\u{200B}\nworld"), 10);
        assert_eq!(visible_text_length("你好\n世界"), 5);
    }
}
