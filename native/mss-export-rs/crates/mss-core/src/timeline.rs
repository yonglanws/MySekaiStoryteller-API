//! Native Rust port of `src/common/export/storyPlan.ts` (`bakeStoryPlan`)
//! plus deterministic static-frame span analyzer for frame-skip / dedup.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::timing::{
    PLAYCORE_WARMUP_FRAMES, STORY_FPS, TalkAutoInput, appear_shown_move_frames,
    character_fade_in_place_ms, character_fade_ms, frames_for_seconds, frames_to_ms,
    full_screen_text_frames, full_screen_text_slots, has_speakable_speech_text,
    hide_delay_in_place_smooth_ms, is_seconds_duration_snippet_type, move_speed_duration_ms,
    ms_to_frame_count, ms_to_frames, normalize_effect_duration_ms,
    silent_punctuation_hold_frames, story_end_frame, talk_auto_frame_timing,
    talk_window_open_close_frames, visible_text_length,
};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryPlanTimelineEntry {
    pub snippet_index: usize,
    #[serde(default)]
    pub start_time_ms: f64,
    #[serde(default)]
    pub duration_ms: f64,
    #[serde(default)]
    pub end_time_ms: f64,
    #[serde(default)]
    pub tts_duration_ms: Option<f64>,
    #[serde(default)]
    pub has_tts: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StoryPlanOptions {
    #[serde(default)]
    pub window_open_ms: Option<HashMap<usize, f64>>,
    #[serde(default)]
    pub motion_settle_ms: Option<HashMap<usize, f64>>,
    #[serde(default)]
    pub motion_settle_frames: Option<HashMap<usize, u32>>,
    #[serde(default)]
    pub motion_clip_frames: Option<HashMap<String, u32>>,
    #[serde(default)]
    pub export_fps: Option<u32>,
    #[serde(default)]
    pub tts_enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StoryPlanInput {
    #[serde(default)]
    pub snippets: Vec<Value>,
    #[serde(default)]
    pub timeline: Vec<StoryPlanTimelineEntry>,
    #[serde(default)]
    pub options: StoryPlanOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoryPlanActionCue {
    pub frame: u32,
    pub at: f64,
    pub model_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub motion: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub facial: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoryPlanTalk {
    pub window_open_frames: u32,
    pub typing_start_frame: u32,
    pub typing_end_frame: u32,
    pub voice_end_frame: Option<u32>,
    pub layout_gate_frame: u32,
    pub settle_frames: u32,
    pub gate_end_frame: u32,
    pub computed_end_frame: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoryPlanLayout {
    pub kind: String,
    pub fade_start_frame: Option<u32>,
    pub fade_end_frame: Option<u32>,
    pub move_end_frame: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoryPlanFullScreenText {
    pub first: bool,
    pub last: bool,
    pub slots: u32,
    pub text_start_frame: u32,
    pub text_end_frame: u32,
    pub hold_frames: u32,
    pub fade_frames: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoryPlanEntry {
    pub index: usize,
    #[serde(rename = "type")]
    pub snippet_type: String,
    pub delay_start_frame: u32,
    pub start_frame: u32,
    pub end_frame: u32,
    pub duration_frames: u32,
    pub blocking: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub talk: Option<StoryPlanTalk>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout: Option<StoryPlanLayout>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fst: Option<StoryPlanFullScreenText>,
    pub actions: Vec<StoryPlanActionCue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryPlan {
    pub schema_version: u32,
    pub fps: u32,
    pub total_frames: u32,
    pub total_ms: f64,
    pub entries: Vec<StoryPlanEntry>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StaticSpanKind {
    BlackoutCovered,
    IdleHold,
    Wait,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StaticSpan {
    pub start_frame: u32,
    pub end_frame: u32,
    pub kind: StaticSpanKind,
    /// True when the canvas is guaranteed pixel-identical (e.g. opaque blackout cover with no text/dialogs).
    pub hard_static: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryPlanWithSpans {
    #[serde(flatten)]
    pub plan: StoryPlan,
    pub static_spans: Vec<StaticSpan>,
}

fn snippet_blocks_timeline(snippet: &Value) -> bool {
    match snippet.get("progressBehavior").and_then(Value::as_str) {
        Some("WaitFinished") => return true,
        Some("Now") => return false,
        _ => {}
    }
    snippet.get("wait").and_then(Value::as_bool) == Some(true)
}

fn snippet_type_of(snippet: &Value) -> &str {
    snippet.get("type").and_then(Value::as_str).unwrap_or("")
}

fn snippet_delay_of(snippet: &Value) -> f64 {
    snippet
        .get("delay")
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .unwrap_or(0.0)
}

fn snippet_data_of(snippet: &Value) -> &Value {
    snippet.get("data").unwrap_or(&Value::Null)
}

fn get_str<'a>(obj: &'a Value, key: &str) -> &'a str {
    obj.get(key).and_then(Value::as_str).unwrap_or("")
}

fn get_opt_f64(obj: &Value, key: &str) -> Option<f64> {
    obj.get(key).and_then(|v| match v {
        Value::Number(n) => n.as_f64().filter(|x| x.is_finite()),
        _ => None,
    })
}

fn resolve_action_model_id(raw: Option<&Value>) -> i64 {
    match raw {
        Some(Value::Number(n)) => n
            .as_i64()
            .or_else(|| n.as_f64().filter(|x| x.is_finite()).map(|x| x as i64))
            .unwrap_or(-1),
        Some(Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                -1
            } else {
                trimmed
                    .parse::<f64>()
                    .ok()
                    .filter(|x| x.is_finite())
                    .map(|x| x as i64)
                    .unwrap_or(-1)
            }
        }
        _ => -1,
    }
}

fn plan_duration_frames(ms: f64) -> u32 {
    if ms > 0.0 && ms < crate::timing::FRAME_MS {
        return 0;
    }
    ms_to_frame_count(ms)
}

fn layout_moved(data: &Value) -> bool {
    let Some(from) = data.get("from").filter(|v| v.is_object()) else {
        return false;
    };
    let Some(to) = data.get("to").filter(|v| v.is_object()) else {
        return false;
    };
    let from_side = from.get("side").and_then(Value::as_str).unwrap_or("Center");
    let to_side = to.get("side").and_then(Value::as_str).unwrap_or("Center");
    let from_off = get_opt_f64(from, "offset").unwrap_or(0.0);
    let to_off = get_opt_f64(to, "offset").unwrap_or(0.0);
    let from_under = from.get("under").and_then(Value::as_bool).unwrap_or(false);
    let to_under = to.get("under").and_then(Value::as_bool).unwrap_or(false);
    from_side != to_side || (from_off - to_off).abs() > f64::EPSILON || from_under != to_under
}

fn move_frames_for(data: &Value) -> u32 {
    let speed = data.get("moveSpeed").and_then(Value::as_str);
    ms_to_frame_count(move_speed_duration_ms(speed))
}

pub fn bake_story_plan(
    snippets: &[Value],
    timeline: &[StoryPlanTimelineEntry],
    options: &StoryPlanOptions,
) -> StoryPlan {
    let is_export = options.export_fps.is_some();
    let slide_fade_frames = ms_to_frame_count(character_fade_ms());
    let in_place_fade_frames = ms_to_frame_count(character_fade_in_place_ms());
    let appear_slide_frames = 1 + slide_fade_frames;
    let appear_in_place_frames = 1 + in_place_fade_frames;

    let mut talk_window_open = false;
    let mut talk_window_closes_at_frame: Option<u32> = None;
    let mut running_fence_end_frame: u32 = 0;
    let timeline_by_index: HashMap<usize, &StoryPlanTimelineEntry> =
        timeline.iter().map(|e| (e.snippet_index, e)).collect();

    let mut entries = Vec::with_capacity(snippets.len());
    let mut visible_models: HashSet<i64> = HashSet::new();
    let mut body_end_by_model: HashMap<i64, u32> = HashMap::new();
    let mut cursor_frame: u32 = PLAYCORE_WARMUP_FRAMES;
    let mut active_layout_end_frame: u32 = 0;
    let mut last_end_frame: u32 = 0;
    let mut fst_slots: u32 = 0;
    let mut fst_dialog_open = false;

    for (i, snippet) in snippets.iter().enumerate() {
        let data = snippet_data_of(snippet);
        let stype = snippet_type_of(snippet);
        let timing = timeline_by_index.get(&i).copied();
        let blocking = snippet_blocks_timeline(snippet);
        let next_type = snippets.get(i + 1).map(snippet_type_of).unwrap_or("");

        if blocking {
            cursor_frame = cursor_frame.max(running_fence_end_frame);
        }

        let delay_start_frame = cursor_frame;
        let delay_frames = frames_for_seconds(snippet_delay_of(snippet));
        let start_frame = delay_start_frame + delay_frames;

        if let Some(close_at) = talk_window_closes_at_frame
            && close_at <= start_frame
        {
            talk_window_open = false;
            talk_window_closes_at_frame = None;
        }

        let mut window_open_frames: u32 = 0;
        if stype == "Talk" {
            let provided = options.window_open_ms.as_ref().and_then(|m| m.get(&i).copied());
            window_open_frames = match provided {
                Some(ms) => ms_to_frames(ms),
                None => {
                    if talk_window_open {
                        0
                    } else {
                        talk_window_open_close_frames()
                    }
                }
            };
            talk_window_open = true;
        } else if stype == "HideTalk" {
            talk_window_open = false;
            talk_window_closes_at_frame = None;
        }

        let mut actions: Vec<StoryPlanActionCue> = Vec::new();
        let top_motion = get_str(data, "motion").trim().to_owned();
        let top_facial = get_str(data, "facial").trim().to_owned();
        if !top_motion.is_empty() || !top_facial.is_empty() {
            actions.push(StoryPlanActionCue {
                frame: start_frame,
                at: 0.0,
                model_id: resolve_action_model_id(data.get("modelId")),
                motion: (!top_motion.is_empty()).then_some(top_motion),
                facial: (!top_facial.is_empty()).then_some(top_facial),
            });
        }

        let mut action_window_frames = timing
            .map(|t| t.duration_ms)
            .filter(|&d| d > 0.0)
            .map(plan_duration_frames)
            .unwrap_or(0);
        if action_window_frames == 0 {
            if stype == "Motion" {
                let dur = get_opt_f64(data, "duration").filter(|&d| d != 0.0).unwrap_or(2.0);
                action_window_frames = plan_duration_frames(dur * 1000.0);
            } else if stype == "Talk" {
                let content = get_str(data, "content");
                let typing_text = get_str(data, "typingText");
                let tts_text = get_str(data, "ttsText");
                let voice = get_str(data, "voice");
                let tts_ms = timing
                    .and_then(|t| t.tts_duration_ms)
                    .filter(|&d| d > 0.0)
                    .unwrap_or(0.0);
                let official_voice_ms = get_opt_f64(data, "voiceDurationMs")
                    .filter(|&d| d > 0.0)
                    .unwrap_or(0.0);
                let timing_voice_ms = if official_voice_ms > 0.0 {
                    official_voice_ms
                } else {
                    tts_ms
                };
                let fallback_silent_beat = is_export
                    && options.tts_enabled != Some(false)
                    && timing_voice_ms <= 0.0
                    && voice.is_empty()
                    && !has_speakable_speech_text(content)
                    && !has_speakable_speech_text(tts_text);
                let text_for_len = if !typing_text.is_empty() {
                    typing_text
                } else {
                    content
                };
                let base_timing = talk_auto_frame_timing(&TalkAutoInput {
                    start_frame,
                    window_frames: window_open_frames,
                    length: visible_text_length(text_for_len) as u32,
                    voice_seconds: timing_voice_ms / 1000.0,
                    layout_end_frame: if active_layout_end_frame > start_frame {
                        active_layout_end_frame
                    } else {
                        0
                    },
                    settle_frames: 0,
                    silent_hold_frames: fallback_silent_beat
                        .then_some(silent_punctuation_hold_frames()),
                });
                action_window_frames = base_timing.end_frame.saturating_sub(start_frame);
            }
        }

        if let Some(arr) = data.get("actions").and_then(Value::as_array) {
            for action in arr {
                let am = get_str(action, "motion").trim().to_owned();
                let af = get_str(action, "facial").trim().to_owned();
                if am.is_empty() && af.is_empty() {
                    continue;
                }
                let at = get_opt_f64(action, "at").unwrap_or(0.0).clamp(0.0, 1.0);
                let frame = start_frame + (at * f64::from(action_window_frames)).round() as u32;
                let mid = resolve_action_model_id(action.get("modelId").or_else(|| data.get("modelId")));
                actions.push(StoryPlanActionCue {
                    frame,
                    at,
                    model_id: mid,
                    motion: (!am.is_empty()).then_some(am),
                    facial: (!af.is_empty()).then_some(af),
                });
            }
        }

        let mut talk: Option<StoryPlanTalk> = None;
        if stype == "Talk" {
            let content = get_str(data, "content");
            let tts_text = get_str(data, "ttsText");
            let typing_text = get_str(data, "typingText");
            let voice = get_str(data, "voice");
            let tts_ms = timing
                .and_then(|t| t.tts_duration_ms)
                .filter(|&d| d > 0.0)
                .unwrap_or(0.0);
            let official_voice_ms = get_opt_f64(data, "voiceDurationMs")
                .filter(|&d| d > 0.0)
                .unwrap_or(0.0);
            let timing_voice_ms = if official_voice_ms > 0.0 {
                official_voice_ms
            } else {
                tts_ms
            };
            let is_silent_punctuation_beat = is_export
                && options.tts_enabled != Some(false)
                && timing_voice_ms <= 0.0
                && voice.is_empty()
                && !has_speakable_speech_text(content)
                && !has_speakable_speech_text(tts_text);
            let layout_gate_frame = if active_layout_end_frame > start_frame {
                active_layout_end_frame
            } else {
                0
            };

            let settle_frames: u32 = if let Some(clip_frames) = options.motion_clip_frames.as_ref() {
                let mut planned: u32 = 0;
                for (&mid, &end_f) in &body_end_by_model {
                    if visible_models.contains(&mid) && end_f > start_frame {
                        planned = planned.max(end_f - start_frame);
                    }
                }
                for action in &actions {
                    if let Some(m) = action.motion.as_deref()
                        && visible_models.contains(&action.model_id)
                    {
                        let key = format!("{}|{}", action.model_id, m);
                        if let Some(&clip) = clip_frames.get(&key)
                            && clip > 0
                        {
                            planned = planned.max(action.frame.saturating_sub(start_frame) + clip);
                        }
                    }
                }
                for next in &snippets[i + 1..] {
                    if snippet_blocks_timeline(next) {
                        break;
                    }
                    let next_data = snippet_data_of(next);
                    let start_rel = frames_for_seconds(snippet_delay_of(next))
                        .saturating_sub(delay_frames);
                    let next_dur_frames = plan_duration_frames(
                        get_opt_f64(next_data, "duration")
                            .filter(|&d| d != 0.0)
                            .unwrap_or(2.0)
                            * 1000.0,
                    );
                    let mut consider = |model_raw: Option<&Value>, motion_raw: &str, at_raw: f64| {
                        let motion_name = motion_raw.trim();
                        if motion_name.is_empty() {
                            return;
                        }
                        let mid = resolve_action_model_id(model_raw);
                        if !visible_models.contains(&mid) {
                            return;
                        }
                        let key = format!("{mid}|{motion_name}");
                        let clip = clip_frames.get(&key).copied().unwrap_or(0);
                        if clip == 0 {
                            return;
                        }
                        let at = at_raw.clamp(0.0, 1.0);
                        let at_frames = if at > 0.0 {
                            (at * f64::from(next_dur_frames)).round() as u32
                        } else {
                            0
                        };
                        planned = planned.max(start_rel + at_frames + clip);
                    };
                    consider(
                        next_data.get("modelId"),
                        get_str(next_data, "motion"),
                        0.0,
                    );
                    if let Some(arr) = next_data.get("actions").and_then(Value::as_array) {
                        for action in arr {
                            consider(
                                action.get("modelId").or_else(|| next_data.get("modelId")),
                                get_str(action, "motion"),
                                get_opt_f64(action, "at").unwrap_or(0.0),
                            );
                        }
                    }
                }
                planned
            } else {
                options
                    .motion_settle_frames
                    .as_ref()
                    .and_then(|m| m.get(&i).copied())
                    .unwrap_or_else(|| {
                        let ms = options
                            .motion_settle_ms
                            .as_ref()
                            .and_then(|m| m.get(&i).copied())
                            .unwrap_or(0.0);
                        frames_for_seconds(ms / 1000.0)
                    })
            };

            let text_for_len = if !typing_text.is_empty() {
                typing_text
            } else {
                content
            };
            let timing_frames = talk_auto_frame_timing(&TalkAutoInput {
                start_frame,
                window_frames: window_open_frames,
                length: visible_text_length(text_for_len) as u32,
                voice_seconds: timing_voice_ms / 1000.0,
                layout_end_frame: layout_gate_frame,
                settle_frames,
                silent_hold_frames: is_silent_punctuation_beat
                    .then_some(silent_punctuation_hold_frames()),
            });
            if data.get("closeWindowOnFinish").and_then(Value::as_bool) == Some(true) {
                talk_window_closes_at_frame =
                    Some(timing_frames.end_frame + talk_window_open_close_frames());
            }
            talk = Some(StoryPlanTalk {
                window_open_frames: timing_frames.window_open_frames,
                typing_start_frame: timing_frames.typing_start_frame,
                typing_end_frame: timing_frames.typing_end_frame,
                voice_end_frame: timing_frames.voice_end_frame,
                layout_gate_frame,
                settle_frames,
                gate_end_frame: timing_frames.gate_end_frame,
                computed_end_frame: timing_frames.end_frame,
            });
        }

        let mut layout: Option<StoryPlanLayout> = None;
        if stype == "LayoutAppear" || stype == "LayoutClear" || stype == "Move" {
            let move_frames = move_frames_for(data);
            let moved = layout_moved(data);
            let model_id = resolve_action_model_id(data.get("modelId"));
            if stype == "LayoutAppear" {
                let shown = visible_models.contains(&model_id);
                let has_motion = !get_str(data, "motion").trim().is_empty();
                let layout_at = start_frame + u32::from(!shown && has_motion);
                let fade_end = layout_at
                    + if moved {
                        appear_slide_frames
                    } else {
                        appear_in_place_frames
                    };
                if shown {
                    let mv_end = start_frame + appear_shown_move_frames();
                    layout = Some(StoryPlanLayout {
                        kind: "appear".to_owned(),
                        fade_start_frame: None,
                        fade_end_frame: None,
                        move_end_frame: mv_end,
                    });
                    active_layout_end_frame = active_layout_end_frame.max(mv_end);
                } else {
                    layout = Some(StoryPlanLayout {
                        kind: "appear".to_owned(),
                        fade_start_frame: Some(layout_at + 1),
                        fade_end_frame: Some(fade_end),
                        move_end_frame: layout_at + move_frames,
                    });
                    active_layout_end_frame = active_layout_end_frame.max(fade_end);
                }
                visible_models.insert(model_id);
            } else if stype == "LayoutClear" {
                let shown = visible_models.contains(&model_id);
                if !shown {
                    layout = Some(StoryPlanLayout {
                        kind: "clear".to_owned(),
                        fade_start_frame: None,
                        fade_end_frame: None,
                        move_end_frame: start_frame,
                    });
                } else if moved {
                    let fs = start_frame + move_frames.saturating_sub(slide_fade_frames);
                    let fe = start_frame + slide_fade_frames.max(move_frames);
                    layout = Some(StoryPlanLayout {
                        kind: "clear".to_owned(),
                        fade_start_frame: Some(fs),
                        fade_end_frame: Some(fe),
                        move_end_frame: start_frame + move_frames,
                    });
                    active_layout_end_frame = active_layout_end_frame.max(fe);
                } else {
                    let hide_delay_frames = ms_to_frame_count(hide_delay_in_place_smooth_ms());
                    let fs = start_frame + hide_delay_frames;
                    let fe = fs + in_place_fade_frames.max(1);
                    layout = Some(StoryPlanLayout {
                        kind: "clear".to_owned(),
                        fade_start_frame: Some(fs),
                        fade_end_frame: Some(fe),
                        move_end_frame: start_frame,
                    });
                    active_layout_end_frame = active_layout_end_frame.max(fe);
                }
                visible_models.remove(&model_id);
            } else {
                let mv_end = start_frame + move_frames;
                layout = Some(StoryPlanLayout {
                    kind: "move".to_owned(),
                    fade_start_frame: None,
                    fade_end_frame: None,
                    move_end_frame: mv_end,
                });
                active_layout_end_frame = active_layout_end_frame.max(mv_end);
            }
        }

        let mut fst: Option<StoryPlanFullScreenText> = None;
        if stype == "FullScreenText" {
            let first = !fst_dialog_open;
            let last = next_type != "FullScreenText"
                && data.get("keepBars").and_then(Value::as_bool) != Some(true);
            if first {
                fst_slots = 0;
            }
            fst_dialog_open = !last;
            let text = get_str(data, "text");
            let slots = full_screen_text_slots(fst_slots, text);
            fst_slots = slots;
            let frames = full_screen_text_frames(first, last, slots);
            fst = Some(StoryPlanFullScreenText {
                first,
                last,
                slots,
                text_start_frame: start_frame + frames.text_start_frame,
                text_end_frame: start_frame + frames.text_end_frame,
                hold_frames: frames.hold_frames,
                fade_frames: frames.fade_frames,
            });
        }

        let wait_frames: u32 = if let Some(ref t) = talk {
            t.computed_end_frame.saturating_sub(start_frame)
        } else if let Some(ref f) = fst {
            (f.text_end_frame + f.hold_frames + f.fade_frames).saturating_sub(start_frame)
        } else if let Some(ref l) = layout {
            if stype == "LayoutAppear" {
                l.fade_end_frame
                    .map(|fe| fe.saturating_sub(start_frame))
                    .unwrap_or_else(appear_shown_move_frames)
            } else if stype == "LayoutClear" {
                l.fade_end_frame
                    .unwrap_or(l.move_end_frame)
                    .saturating_sub(start_frame)
            } else {
                l.move_end_frame.saturating_sub(start_frame)
            }
        } else if is_seconds_duration_snippet_type(stype) {
            let raw_dur = get_opt_f64(data, "duration");
            let dur_ms = normalize_effect_duration_ms(raw_dur, 0.0);
            frames_for_seconds(dur_ms / 1000.0)
        } else {
            plan_duration_frames(timing.map(|t| t.duration_ms).unwrap_or(0.0))
        };

        let task_ran = delay_frames > 0 || wait_frames > 0;
        let has_fence = task_ran && i + 1 < snippets.len();
        let finish_frame = start_frame + wait_frames;
        let end_frame = finish_frame + u32::from(i + 1 < snippets.len());

        if let Some(clip_frames) = options.motion_clip_frames.as_ref() {
            for action in &actions {
                if let Some(m) = action.motion.as_deref() {
                    let key = format!("{}|{}", action.model_id, m);
                    if let Some(&clip) = clip_frames.get(&key)
                        && clip > 0
                    {
                        let entry = body_end_by_model.entry(action.model_id).or_insert(0);
                        *entry = (*entry).max(action.frame + clip);
                    }
                }
            }
        }

        entries.push(StoryPlanEntry {
            index: i,
            snippet_type: stype.to_owned(),
            delay_start_frame,
            start_frame,
            end_frame,
            duration_frames: wait_frames,
            blocking,
            talk,
            layout,
            fst,
            actions,
        });

        running_fence_end_frame =
            running_fence_end_frame.max(finish_frame + u32::from(has_fence));
        last_end_frame = last_end_frame.max(finish_frame);
    }

    let total_frames = story_end_frame(last_end_frame);
    StoryPlan {
        schema_version: 1,
        fps: STORY_FPS,
        total_frames,
        total_ms: frames_to_ms(total_frames),
        entries,
    }
}

/// Identifies contiguous `[start_frame, end_frame)` spans where script/UI/layout/effect/voice
/// animations are inactive, separating `blackout_covered` (`hardStatic: true`) from `wait`/`idle_hold`
/// (`hardStatic: false`, where ambient Live2D breath/blink may still run).
pub fn analyze_static_spans(plan: &StoryPlan) -> Vec<StaticSpan> {
    let total = plan.total_frames as usize;
    if total == 0 {
        return Vec::new();
    }

    // State per frame: 0 = idle, 1 = active animation, 2 = wait, 3 = blackout_covered (hard static)
    let mut active = vec![false; total];
    let mut is_wait = vec![false; total];
    let mut blackout_cover = vec![false; total];

    fn mark_active_range(active: &mut [bool], s: u32, e: u32) {
        let total = active.len();
        let s = (s as usize).min(total);
        let e = (e as usize).min(total);
        for slot in &mut active[s..e] {
            *slot = true;
        }
    }

    let mut black_ranges: Vec<(u32, bool)> = Vec::new();

    for entry in &plan.entries {
        for action in &entry.actions {
            let f = (action.frame as usize).min(total.saturating_sub(1));
            active[f] = true;
        }
        if let Some(ref talk) = entry.talk {
            let typing_or_voice_end = talk
                .typing_end_frame
                .max(talk.voice_end_frame.unwrap_or(0))
                .max(talk.start_frame_or_zero(entry.start_frame));
            mark_active_range(&mut active, entry.start_frame, typing_or_voice_end);
        } else if let Some(ref layout) = entry.layout {
            let end_f = layout
                .fade_end_frame
                .unwrap_or(layout.move_end_frame)
                .max(layout.move_end_frame);
            mark_active_range(&mut active, entry.start_frame, end_f);
        } else if let Some(ref fst) = entry.fst {
            let end_f = fst.text_end_frame + fst.hold_frames + fst.fade_frames;
            mark_active_range(&mut active, entry.start_frame, end_f);
        } else if entry.snippet_type == "Wait" {
            let s = (entry.start_frame as usize).min(total);
            let e = ((entry.start_frame + entry.duration_frames) as usize).min(total);
            for slot in &mut is_wait[s..e] {
                *slot = true;
            }
        } else if entry.snippet_type == "BlackOut" {
            let fade_end = entry.start_frame + entry.duration_frames;
            mark_active_range(&mut active, entry.start_frame, fade_end);
            black_ranges.push((fade_end, true));
        } else if entry.snippet_type == "BlackIn" {
            let fade_end = entry.start_frame + entry.duration_frames;
            mark_active_range(&mut active, entry.start_frame, fade_end);
            black_ranges.push((entry.start_frame, false));
        } else if entry.duration_frames > 0
            && (is_seconds_duration_snippet_type(&entry.snippet_type)
                || matches!(
                    entry.snippet_type.as_str(),
                    "CharacterShake"
                        | "SekaiIn"
                        | "SekaiOut"
                        | "SepiaIn"
                        | "SepiaOut"
                        | "Wipe"
                        | "Telop"
                        | "SimpleSelectable"
                        | "Movie"
                        | "DoParam"
                ))
        {
            mark_active_range(&mut active, entry.start_frame, entry.start_frame + entry.duration_frames);
        }
    }

    // Track opaque blackout spans
    black_ranges.sort_by_key(|&(f, _)| f);
    let mut covered = false;
    let mut b_idx = 0;
    for (frame, slot) in blackout_cover.iter_mut().enumerate() {
        while b_idx < black_ranges.len() && black_ranges[b_idx].0 as usize <= frame {
            covered = black_ranges[b_idx].1;
            b_idx += 1;
        }
        if covered && !active[frame] {
            *slot = true;
        }
    }

    let mut spans = Vec::new();
    let mut cur_start: usize = 0;
    let mut cur_kind: Option<(StaticSpanKind, bool)> = None;

    let classify = |frame: usize| -> Option<(StaticSpanKind, bool)> {
        if active[frame] {
            None
        } else if blackout_cover[frame] {
            Some((StaticSpanKind::BlackoutCovered, true))
        } else if is_wait[frame] {
            Some((StaticSpanKind::Wait, false))
        } else {
            Some((StaticSpanKind::IdleHold, false))
        }
    };

    for f in 0..total {
        let next = classify(f);
        if next != cur_kind {
            if let Some((kind, hard_static)) = cur_kind
                && f > cur_start
            {
                spans.push(StaticSpan {
                    start_frame: cur_start as u32,
                    end_frame: f as u32,
                    kind,
                    hard_static,
                });
            }
            cur_start = f;
            cur_kind = next;
        }
    }
    if let Some((kind, hard_static)) = cur_kind
        && total > cur_start
    {
        spans.push(StaticSpan {
            start_frame: cur_start as u32,
            end_frame: total as u32,
            kind,
            hard_static,
        });
    }
    spans
}

trait TalkStartExt {
    fn start_frame_or_zero(&self, entry_start: u32) -> u32;
}

impl TalkStartExt for StoryPlanTalk {
    fn start_frame_or_zero(&self, entry_start: u32) -> u32 {
        entry_start + self.window_open_frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bake_story_plan_matches_ts_reference() {
        let snippets = vec![
            json!({
                "type": "LayoutAppear",
                "wait": true,
                "delay": 0,
                "data": { "modelId": 1, "from": { "side": "Left" }, "to": { "side": "Left" }, "moveSpeed": "Normal" }
            }),
            json!({
                "type": "Talk",
                "wait": true,
                "delay": 0.5,
                "data": { "speaker": "miku", "content": "Hello", "modelId": 1 }
            }),
            json!({
                "type": "Wait",
                "wait": true,
                "delay": 0,
                "data": { "duration": 1.0 }
            }),
        ];
        let plan = bake_story_plan(
            &snippets,
            &[],
            &StoryPlanOptions {
                export_fps: Some(60),
                tts_enabled: Some(false),
                ..Default::default()
            },
        );
        assert_eq!(plan.fps, 60);
        assert_eq!(plan.entries.len(), 3);
        // LayoutAppear starts at PLAYCORE_WARMUP_FRAMES (10), in-place fade = 22f -> finish=32, end=33
        assert_eq!(plan.entries[0].start_frame, 10);
        assert_eq!(plan.entries[0].duration_frames, 22);
        // Talk starts after fence (33) + delay 0.5s (30) = 63
        assert_eq!(plan.entries[1].delay_start_frame, 33);
        assert_eq!(plan.entries[1].start_frame, 63);
        let talk = plan.entries[1].talk.as_ref().unwrap();
        assert_eq!(talk.window_open_frames, 12);
        assert_eq!(talk.typing_start_frame, 75);
        assert_eq!(talk.typing_end_frame, 75 + 5 * 4);
        assert_eq!(talk.computed_end_frame, 95 + 121);
        // Wait snippet starts after Talk fence (216 + 1 = 217), duration 1.0s -> 61 frames
        assert_eq!(plan.entries[2].start_frame, 217);
        assert_eq!(plan.entries[2].duration_frames, 61);
        // Total frames = story_end_frame(278) = 278 + 15 + 1 + 15 = 309
        assert_eq!(plan.total_frames, 309);

        let spans = analyze_static_spans(&plan);
        assert!(spans.iter().any(|s| s.kind == StaticSpanKind::Wait && s.start_frame == 217 && s.end_frame == 278));
        assert!(spans.iter().any(|s| s.kind == StaticSpanKind::IdleHold && s.start_frame == 95 && s.end_frame == 217));
    }

    #[test]
    fn blackout_cover_marks_hard_static_spans() {
        let snippets = vec![
            json!({ "type": "BlackOut", "wait": true, "delay": 0, "data": { "duration": 0.5 } }),
            json!({ "type": "Wait", "wait": true, "delay": 0, "data": { "duration": 1.0 } }),
            json!({ "type": "BlackIn", "wait": true, "delay": 0, "data": { "duration": 0.5 } }),
        ];
        let plan = bake_story_plan(&snippets, &[], &StoryPlanOptions::default());
        let spans = analyze_static_spans(&plan);
        assert!(spans.iter().any(|s| s.kind == StaticSpanKind::BlackoutCovered && s.hard_static));
    }
}
