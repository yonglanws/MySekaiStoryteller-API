pub mod segments;
pub mod timeline;
pub mod timing;

pub use segments::{MIN_SEGMENT_FRAMES, build_concat_list, split_segments};
pub use timeline::{
    StaticSpan, StaticSpanKind, StoryPlan, StoryPlanActionCue, StoryPlanEntry,
    StoryPlanFullScreenText, StoryPlanInput, StoryPlanLayout, StoryPlanOptions, StoryPlanTalk,
    StoryPlanTimelineEntry, StoryPlanWithSpans, analyze_static_spans, bake_story_plan,
};
pub use timing::{
    frames_for_seconds, frames_to_ms, has_speakable_speech_text, ms_to_frame_count, ms_to_frames,
    normalize_effect_duration_ms, story_end_frame, talk_auto_frame_timing, visible_text_length,
};
