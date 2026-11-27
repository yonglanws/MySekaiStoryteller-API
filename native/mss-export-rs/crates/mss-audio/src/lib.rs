pub mod decode;
pub mod duck;
pub mod lipsync;
pub mod mix;

pub use decode::{DecodedAudio, LoopMetadata, decode_audio_bytes, decode_audio_file, parse_wav_bytes, resample_channel_linear};
pub use duck::{
    ACF_GAIN_BGM, ACF_GAIN_SE, ACF_GAIN_VOICE, BgmVolumeTweenPoint, DuckKind, DuckSpan,
    MONO_PAN_GAIN, SE_DUCK_LEVEL, SE_DUCK_RELEASE_SEC, VOICE_DUCK_CURVE_STRENGTH,
    VOICE_DUCK_LEVEL, VOICE_DUCK_RELEASE_SEC, compute_bgm_duck_gain_buffer,
    compute_bgm_volume_tween_buffer, evaluate_duck_release_curve, resolve_loop_sample_index,
};
pub use lipsync::{
    LipSyncEnvelope, TextLipSequence, build_lip_sync_envelope, lip_coefficients,
    lip_target_from_rms, smooth_lip_value, text_lip_sequence,
};
pub use mix::{
    AudioMixPlan, AudioMixResult, BgmCueInput, BgmPlanInput, LipSyncPlanOutput, MixTrack,
    SeCueInput, SePlanInput, VoiceTrackInput, mix_audio_plan, mix_tracks_to_wav,
};
