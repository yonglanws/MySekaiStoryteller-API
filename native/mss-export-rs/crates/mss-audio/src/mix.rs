//! Parallel native Rust audio mixer (BGM + SE + TTS Voices + CRI REACT Ducking + Tweens + LipSync)
//! writing 48kHz stereo 16-bit WAV or direct AAC via FFmpeg stdin.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Instant;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::decode::{DecodedAudio, LoopMetadata, decode_audio_bytes, decode_audio_file};
use crate::duck::{
    ACF_GAIN_BGM, ACF_GAIN_SE, ACF_GAIN_VOICE, BgmVolumeTweenPoint, DuckKind, DuckSpan,
    MONO_PAN_GAIN, compute_bgm_duck_gain_buffer, compute_bgm_volume_tween_buffer,
    resolve_loop_sample_index,
};
use crate::lipsync::{LipSyncEnvelope, build_lip_sync_envelope};

pub const MIX_RATE: u32 = 48_000;
const MIX_CHANNELS: usize = 2;

#[derive(Debug, Clone)]
pub struct MixTrack {
    pub path: PathBuf,
    pub start_ms: f64,
    pub end_ms: Option<f64>,
    pub volume: f32,
    pub looping: bool,
    pub fade_in_ms: f64,
    pub fade_out_ms: f64,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BgmCueInput {
    pub time_ms: f64,
    #[serde(default)]
    pub fade_ms: f64,
    #[serde(default)]
    pub stop: bool,
    pub path: Option<String>,
    pub volume: Option<f32>,
    pub loop_start_ms: Option<f64>,
    pub loop_end_ms: Option<f64>,
    pub loop_start_sample: Option<usize>,
    pub loop_end_sample: Option<usize>,
    pub source_sample_rate: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BgmPlanInput {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_bgm_volume")]
    pub volume: f32,
    pub global_path: Option<String>,
    pub global_loop: Option<LoopMetadata>,
    #[serde(default)]
    pub cues: Vec<BgmCueInput>,
    #[serde(default)]
    pub volume_tweens: Vec<BgmVolumeTweenPoint>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SeCueInput {
    pub time_ms: f64,
    #[serde(default)]
    pub file: String,
    pub path: Option<String>,
    #[serde(default)]
    pub stop: bool,
    #[serde(default = "default_one")]
    pub volume: f32,
    #[serde(default)]
    pub loop_flag: bool,
    #[serde(default)]
    pub fade_ms: f64,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SeCueRawInput {
    pub time_ms: f64,
    #[serde(default)]
    pub file: String,
    pub path: Option<String>,
    #[serde(default)]
    pub stop: bool,
    #[serde(default = "default_one")]
    pub volume: f32,
    #[serde(default, rename = "loop")]
    pub is_loop: bool,
    #[serde(default)]
    pub fade_ms: f64,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SePlanInput {
    #[serde(default)]
    pub cues: Vec<SeCueRawInput>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTrackInput {
    pub path: Option<String>,
    /// Optional raw encoded file bytes (WAV/MP3/OGG) when supplied in-memory.
    #[serde(default)]
    pub audio_bytes: Option<Vec<u8>>,
    pub start_ms: f64,
    pub end_ms: Option<f64>,
    pub snippet_index: Option<usize>,
    #[serde(default)]
    pub compute_lip_sync: bool,
    pub target_value_scale: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AudioMixPlan {
    pub duration_ms: f64,
    pub output_path: String,
    pub output_format: Option<String>,
    pub audio_bitrate: Option<String>,
    pub ffmpeg_path: Option<String>,
    pub bgm: Option<BgmPlanInput>,
    pub se: Option<SePlanInput>,
    #[serde(default)]
    pub voices: Vec<VoiceTrackInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LipSyncPlanOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet_index: Option<usize>,
    #[serde(flatten)]
    pub envelope: LipSyncEnvelope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMixResult {
    pub ok: bool,
    pub output_path: String,
    pub frames: usize,
    pub file_size: u64,
    pub elapsed_ms: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lip_syncs: Option<Vec<LipSyncPlanOutput>>,
}

pub const DEFAULT_BGM_VOLUME: f32 = 0.35;

fn default_true() -> bool {
    true
}
fn default_one() -> f32 {
    1.0
}
fn default_bgm_volume() -> f32 {
    DEFAULT_BGM_VOLUME
}

/// Legacy simple `mix-wav` entry point (parallel decode + parallel block mix).
pub fn mix_tracks_to_wav(
    duration_ms: f64,
    tracks: &[MixTrack],
    output: &Path,
) -> Result<(usize, u64), String> {
    let total_frames = ((duration_ms.max(0.0) / 1000.0) * f64::from(MIX_RATE)).round() as usize;

    let decoded: Vec<Result<Arc<DecodedAudio>, String>> = tracks
        .par_iter()
        .map(|t| decode_audio_file(&t.path).map(Arc::new))
        .collect();

    let mut loaded: Vec<(&MixTrack, Arc<DecodedAudio>)> = Vec::with_capacity(tracks.len());
    for (track, res) in tracks.iter().zip(decoded) {
        loaded.push((track, res?));
    }

    let threads = rayon::current_num_threads().max(1);
    let block_frames = total_frames.div_ceil(threads).max(1);
    let blocks: Vec<Vec<f32>> = (0..total_frames)
        .step_by(block_frames)
        .collect::<Vec<_>>()
        .into_par_iter()
        .map(|start_frame| {
            let end_frame = (start_frame + block_frames).min(total_frames);
            mix_simple_block(&loaded, start_frame, end_frame)
        })
        .collect();

    let mut left = vec![0.0_f32; total_frames];
    let mut right = vec![0.0_f32; total_frames];
    let mut cursor = 0usize;
    for block in blocks {
        for pair in block.chunks_exact(2) {
            left[cursor] = pair[0];
            right[cursor] = pair[1];
            cursor += 1;
        }
    }

    let file_size = write_stereo_wav(output, &left, &right)?;
    Ok((total_frames, file_size))
}

fn mix_simple_block(
    tracks: &[(&MixTrack, Arc<DecodedAudio>)],
    block_start: usize,
    block_end: usize,
) -> Vec<f32> {
    let len = block_end - block_start;
    let mut out = vec![0.0f32; len * MIX_CHANNELS];
    for (track, wav) in tracks {
        let src_ch = usize::from(wav.channels.max(1));
        let src_frames = wav.samples.len() / src_ch;
        if src_frames == 0 {
            continue;
        }
        let ratio = f64::from(wav.sample_rate) / f64::from(MIX_RATE);
        let t_start = ((track.start_ms.max(0.0) / 1000.0) * f64::from(MIX_RATE)).round() as usize;
        let t_end = match track.end_ms {
            Some(ms) => ((ms.max(0.0) / 1000.0) * f64::from(MIX_RATE)).round() as usize,
            None if track.looping => usize::MAX,
            None => t_start + ((src_frames as f64) / ratio).ceil() as usize,
        };
        if t_end <= block_start || t_start >= block_end {
            continue;
        }
        let s0 = t_start.max(block_start);
        let s1 = t_end.min(block_end);
        let fade_in_frames = (track.fade_in_ms.max(0.0) / 1000.0) * f64::from(MIX_RATE);
        let fade_out_frames = (track.fade_out_ms.max(0.0) / 1000.0) * f64::from(MIX_RATE);

        for frame in s0..s1 {
            let rel = frame - t_start;
            let mut gain = track.volume;
            if fade_in_frames > 0.0 && (rel as f64) < fade_in_frames {
                gain *= (rel as f64 / fade_in_frames) as f32;
            }
            if fade_out_frames > 0.0 && t_end < usize::MAX {
                let rem = t_end.saturating_sub(frame) as f64;
                if rem < fade_out_frames {
                    gain *= (rem / fade_out_frames) as f32;
                }
            }
            let src_pos = (rel as f64) * ratio;
            let idx_f = if track.looping {
                src_pos % (src_frames as f64)
            } else {
                if src_pos >= src_frames as f64 {
                    break;
                }
                src_pos
            };
            let i0 = (idx_f.floor() as usize).min(src_frames - 1);
            let i1 = if track.looping {
                (i0 + 1) % src_frames
            } else {
                (i0 + 1).min(src_frames - 1)
            };
            let frac = (idx_f - idx_f.floor()) as f32;

            let l0 = wav.samples[i0 * src_ch];
            let l1 = wav.samples[i1 * src_ch];
            let r0 = wav.samples[i0 * src_ch + (src_ch - 1).min(1)];
            let r1 = wav.samples[i1 * src_ch + (src_ch - 1).min(1)];
            let l = (l0 + (l1 - l0) * frac) * gain;
            let r = (r0 + (r1 - r0) * frac) * gain;

            let dst = (frame - block_start) * MIX_CHANNELS;
            out[dst] += l;
            out[dst + 1] += r;
        }
    }
    out
}

struct PreparedAudio {
    ch0: Vec<f32>,
    ch1: Vec<f32>,
    is_mono: bool,
    loop_meta: Option<LoopMetadata>,
}

fn prepare_from_decoded(decoded: DecodedAudio) -> PreparedAudio {
    let is_mono = decoded.channels <= 1;
    let (ch0, ch1) = decoded.to_stereo_at_rate(MIX_RATE);
    PreparedAudio {
        ch0,
        ch1,
        is_mono,
        loop_meta: decoded.loop_meta,
    }
}

/// Full native Rust story audio pipeline:
/// - Parallel decoding of voices, SE, and BGM via `symphonia` + fast WAV parser
/// - Optional 60Hz RMS `LipSyncEnvelope` computation per voice track
/// - ACF category gains (`0.75 / 0.80 / 0.90` + mono `-3.01dB` pan)
/// - CRI REACT `SquareReverse(0.5)` voice ducking + linear SE ducking
/// - `BgmVolume` tween curves, BGM crossfades, HCA/`smpl` loop points, and SE loop fade ramps
/// - Writes 48kHz stereo 16-bit WAV or direct AAC via FFmpeg
pub fn mix_audio_plan(plan: &AudioMixPlan) -> Result<AudioMixResult, String> {
    let started = Instant::now();
    let clamped_ms = if plan.duration_ms.is_finite() {
        plan.duration_ms.max(0.0)
    } else {
        0.0
    };
    let total_samples = ((clamped_ms / 1000.0) * f64::from(MIX_RATE)).ceil() as usize;

    // 1. Decode voices in parallel (+ optional LipSync in the same worker pass)
    let voice_results: Vec<Result<(Option<PreparedAudio>, Option<LipSyncPlanOutput>), String>> =
        plan.voices
            .par_iter()
            .map(|v| {
                let decoded_opt = if let Some(ref bytes) = v.audio_bytes
                    && !bytes.is_empty()
                {
                    Some(decode_audio_bytes(bytes, None)?)
                } else if let Some(ref p) = v.path
                    && !p.is_empty()
                {
                    let path = Path::new(p);
                    if path.exists() {
                        Some(decode_audio_file(path)?)
                    } else {
                        None
                    }
                } else {
                    None
                };

                let Some(decoded) = decoded_opt else {
                    return Ok((None, None));
                };

                let lip = if v.compute_lip_sync {
                    let planar = decoded.to_planar_channels();
                    let refs: Vec<&[f32]> = planar.iter().map(Vec::as_slice).collect();
                    let env = build_lip_sync_envelope(&refs, decoded.sample_rate, v.target_value_scale);
                    Some(LipSyncPlanOutput {
                        snippet_index: v.snippet_index,
                        envelope: env,
                    })
                } else {
                    None
                };

                Ok((Some(prepare_from_decoded(decoded)), lip))
            })
            .collect();

    let mut prepared_voices: Vec<(&VoiceTrackInput, PreparedAudio)> = Vec::new();
    let mut lip_syncs: Vec<LipSyncPlanOutput> = Vec::new();
    let want_lip_sync = plan.voices.iter().any(|v| v.compute_lip_sync);
    for (v, res) in plan.voices.iter().zip(voice_results) {
        let (audio, lip) = res?;
        if let Some(a) = audio {
            prepared_voices.push((v, a));
        }
        if let Some(l) = lip {
            lip_syncs.push(l);
        }
    }

    // 2. Collect unique SE and BGM file paths and decode in parallel
    let mut unique_paths: Vec<String> = Vec::new();
    if let Some(ref se) = plan.se {
        for cue in &se.cues {
            if !cue.stop
                && let Some(ref p) = cue.path
                && !p.is_empty()
                && !unique_paths.contains(p)
            {
                unique_paths.push(p.clone());
            }
        }
    }
    if let Some(ref bgm) = plan.bgm
        && bgm.enabled
    {
        if let Some(ref gp) = bgm.global_path
            && !gp.is_empty()
            && !unique_paths.contains(gp)
        {
            unique_paths.push(gp.clone());
        }
        for cue in &bgm.cues {
            if !cue.stop
                && let Some(ref p) = cue.path
                && !p.is_empty()
                && !unique_paths.contains(p)
            {
                unique_paths.push(p.clone());
            }
        }
    }

    let decoded_media_vec: Vec<(String, Option<PreparedAudio>)> = unique_paths
        .par_iter()
        .map(|p| {
            let path = Path::new(p);
            if !path.exists() {
                return (p.clone(), None);
            }
            match decode_audio_file(path) {
                Ok(d) => (p.clone(), Some(prepare_from_decoded(d))),
                Err(err) => {
                    eprintln!("[mss-audio] failed to decode audio file '{p}': {err}");
                    (p.clone(), None)
                }
            }
        })
        .collect();
    let media_cache: HashMap<String, PreparedAudio> = decoded_media_vec
        .into_iter()
        .filter_map(|(k, v)| v.map(|a| (k, a)))
        .collect();

    // 3. Mix voices, SE, and BGM into 48kHz stereo buffers
    let mut left = vec![0.0_f32; total_samples];
    let mut right = vec![0.0_f32; total_samples];
    let mut duck_spans: Vec<DuckSpan> = Vec::new();

    for (v, audio) in &prepared_voices {
        if audio.ch0.is_empty() {
            continue;
        }
        let start_sample = ((v.start_ms.max(0.0) / 1000.0) * f64::from(MIX_RATE)).floor() as usize;
        if start_sample >= total_samples {
            continue;
        }
        let end_by_track = v
            .end_ms
            .filter(|&e| e > v.start_ms)
            .map(|e| ((e / 1000.0) * f64::from(MIX_RATE)).round() as usize)
            .unwrap_or(usize::MAX);
        let end_sample = total_samples
            .min(start_sample + audio.ch0.len())
            .min(end_by_track);
        if end_sample <= start_sample {
            continue;
        }
        duck_spans.push(DuckSpan {
            start_sample,
            end_sample: Some(end_sample),
            kind: DuckKind::Voice,
        });
        let scale = ACF_GAIN_VOICE * if audio.is_mono { MONO_PAN_GAIN } else { 1.0 };
        for i in start_sample..end_sample {
            let s = i - start_sample;
            left[i] += audio.ch0[s] * scale;
            right[i] += audio.ch1[s] * scale;
        }
    }

    if let Some(ref se) = plan.se
        && !se.cues.is_empty()
    {
        mix_se_cues(&se.cues, &media_cache, &mut left, &mut right, &mut duck_spans);
    }

    if let Some(ref bgm) = plan.bgm
        && bgm.enabled
    {
        let duck_gains = compute_bgm_duck_gain_buffer(total_samples, MIX_RATE, &duck_spans);
        let tween_gains =
            compute_bgm_volume_tween_buffer(total_samples, MIX_RATE, &bgm.volume_tweens, 1.0);
        mix_bgm_plan(
            bgm,
            &media_cache,
            &mut left,
            &mut right,
            &duck_gains,
            &tween_gains,
        );
    }

    // 4. Write WAV or direct AAC via FFmpeg
    let output_path = Path::new(&plan.output_path);
    let wants_aac = plan
        .output_format
        .as_deref()
        .is_some_and(|f| f.eq_ignore_ascii_case("aac") || f.eq_ignore_ascii_case("m4a"))
        || output_path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("m4a") || e.eq_ignore_ascii_case("aac"));

    let file_size = if wants_aac {
        let ffmpeg = plan.ffmpeg_path.as_deref().unwrap_or("ffmpeg");
        let bitrate = plan.audio_bitrate.as_deref().unwrap_or("128k");
        write_stereo_aac(Path::new(ffmpeg), output_path, bitrate, &left, &right)?
    } else {
        write_stereo_wav(output_path, &left, &right)?
    };

    Ok(AudioMixResult {
        ok: true,
        output_path: plan.output_path.clone(),
        frames: total_samples,
        file_size,
        elapsed_ms: started.elapsed().as_millis(),
        lip_syncs: want_lip_sync.then_some(lip_syncs),
    })
}

fn mix_se_cues(
    cues: &[SeCueRawInput],
    cache: &HashMap<String, PreparedAudio>,
    left: &mut [f32],
    right: &mut [f32],
    duck_spans: &mut Vec<DuckSpan>,
) {
    let total_samples = left.len().min(right.len());
    let mut sorted = cues.to_vec();
    sorted.sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));

    #[derive(Clone, Copy)]
    struct LoopVol {
        sample: usize,
        volume: f32,
        fade_samples: usize,
        is_stop: bool,
    }
    struct LoopInst<'a> {
        audio: &'a PreparedAudio,
        start: usize,
        end: usize,
        volumes: Vec<LoopVol>,
    }

    let mut active_loop_start: HashMap<String, usize> = HashMap::new();
    let mut loops: HashMap<String, LoopInst<'_>> = HashMap::new();
    let mut closed_loops: Vec<LoopInst<'_>> = Vec::new();

    fn close_loop<'a>(
        file: &str,
        at_sample: usize,
        fade_samples: usize,
        total_samples: usize,
        loops: &mut HashMap<String, LoopInst<'a>>,
        closed: &mut Vec<LoopInst<'a>>,
    ) {
        if let Some(mut inst) = loops.remove(file) {
            inst.end = total_samples.min(inst.start.max(at_sample));
            if fade_samples > 0 {
                let fade = fade_samples.min(inst.end.saturating_sub(inst.start));
                let fade_start = inst.start.max(inst.end.saturating_sub(fade));
                let first_vol = inst.volumes.first().copied();
                inst.volumes.retain(|v| v.sample <= fade_start);
                if inst.volumes.is_empty()
                    && let Some(fv) = first_vol
                {
                    inst.volumes.push(fv);
                }
                inst.volumes.push(LoopVol {
                    sample: fade_start,
                    volume: 0.0,
                    fade_samples: fade,
                    is_stop: true,
                });
            }
            closed.push(inst);
        }
    }

    for cue in &sorted {
        let span_start = ((cue.time_ms / 1000.0) * f64::from(MIX_RATE))
            .round()
            .max(0.0) as usize;
        let at = ((cue.time_ms / 1000.0) * f64::from(MIX_RATE))
            .floor()
            .clamp(0.0, total_samples as f64) as usize;
        let key = if !cue.file.is_empty() {
            cue.file.clone()
        } else {
            cue.path.clone().unwrap_or_else(|| "loop".to_owned())
        };

        if cue.stop {
            let fade_samples = ((cue.fade_ms / 1000.0) * f64::from(MIX_RATE)).round() as usize;
            close_loop(
                &key,
                at,
                fade_samples,
                total_samples,
                &mut loops,
                &mut closed_loops,
            );

            let keys: Vec<String> = active_loop_start.keys().cloned().collect();
            for k in keys {
                if cue.file.is_empty() || k == key {
                    if let Some(s_start) = active_loop_start.remove(&k) {
                        duck_spans.push(DuckSpan {
                            start_sample: s_start,
                            end_sample: Some(total_samples.min(s_start.max(span_start))),
                            kind: DuckKind::Se,
                        });
                    }
                }
            }
            continue;
        }

        let Some(audio) = cue.path.as_ref().and_then(|p| cache.get(p)) else {
            continue;
        };
        if audio.ch0.is_empty() {
            continue;
        }

        let pan = if audio.is_mono { MONO_PAN_GAIN } else { 1.0 };
        let vol = cue.volume.max(0.0) * pan;

        if cue.is_loop {
            active_loop_start.entry(key.clone()).or_insert(span_start);
            let fade_samples = ((cue.fade_ms / 1000.0) * f64::from(MIX_RATE)).round() as usize;
            if let Some(existing) = loops.get_mut(&key) {
                existing.volumes.push(LoopVol {
                    sample: at,
                    volume: vol,
                    fade_samples,
                    is_stop: false,
                });
            } else {
                loops.insert(
                    key,
                    LoopInst {
                        audio,
                        start: at,
                        end: total_samples,
                        volumes: vec![LoopVol {
                            sample: at,
                            volume: vol,
                            fade_samples,
                            is_stop: false,
                        }],
                    },
                );
            }
            continue;
        }

        duck_spans.push(DuckSpan {
            start_sample: span_start,
            end_sample: Some(total_samples.min(span_start + audio.ch0.len())),
            kind: DuckKind::Se,
        });

        let end = total_samples.min(at + audio.ch0.len());
        let fade = (((cue.fade_ms / 1000.0) * f64::from(MIX_RATE)).round() as usize)
            .min(end.saturating_sub(at));
        for sample in at..end {
            let local = sample - at;
            let gain = if fade > 0 && local < fade {
                (local as f32) / (fade as f32)
            } else {
                1.0
            };
            left[sample] += audio.ch0[local] * vol * ACF_GAIN_SE * gain;
            right[sample] += audio.ch1[local] * vol * ACF_GAIN_SE * gain;
        }
    }

    for (_, s_start) in active_loop_start {
        duck_spans.push(DuckSpan {
            start_sample: s_start,
            end_sample: None,
            kind: DuckKind::Se,
        });
    }
    let open_keys: Vec<String> = loops.keys().cloned().collect();
    for k in open_keys {
        close_loop(&k, total_samples, 0, total_samples, &mut loops, &mut closed_loops);
    }

    for mut inst in closed_loops {
        if inst.end <= inst.start || inst.audio.ch0.is_empty() {
            continue;
        }
        let src_len = inst.audio.ch0.len();
        for v in &mut inst.volumes {
            v.sample = v.sample.clamp(inst.start, inst.end);
        }
        inst.volumes
            .sort_by(|a, b| a.sample.cmp(&b.sample).then(a.is_stop.cmp(&b.is_stop)));
        let mut vol_idx = 0usize;
        let mut current_vol = inst.volumes.first().map(|v| v.volume).unwrap_or(0.0);
        let mut fade_start = inst.start;
        let mut fade_from = 0.0_f32;
        let mut fade_to = current_vol;
        let mut fade_samples = inst.volumes.first().map(|v| v.fade_samples).unwrap_or(0);

        let gain_at = |s: usize, fs: usize, f_samples: usize, ff: f32, ft: f32, cv: f32| -> f32 {
            if f_samples > 0 && s.saturating_sub(fs) < f_samples {
                ff + (ft - ff) * ((s - fs) as f32 / f_samples as f32)
            } else {
                cv
            }
        };

        for sample in inst.start..inst.end {
            while vol_idx + 1 < inst.volumes.len() && sample >= inst.volumes[vol_idx + 1].sample {
                let cg = gain_at(
                    sample,
                    fade_start,
                    fade_samples,
                    fade_from,
                    fade_to,
                    current_vol,
                );
                vol_idx += 1;
                fade_from = cg;
                fade_to = inst.volumes[vol_idx].volume;
                fade_start = sample;
                fade_samples = inst.volumes[vol_idx].fade_samples;
                current_vol = fade_to;
            }
            let gain = gain_at(
                sample,
                fade_start,
                fade_samples,
                fade_from,
                fade_to,
                current_vol,
            );
            let s_idx = (sample - inst.start) % src_len;
            left[sample] += inst.audio.ch0[s_idx] * gain * ACF_GAIN_SE;
            right[sample] += inst.audio.ch1[s_idx] * gain * ACF_GAIN_SE;
        }
    }
}

fn resolve_cue_loop_samples(
    cue: &BgmCueInput,
    audio: &PreparedAudio,
) -> (Option<usize>, Option<usize>) {
    let source_len = audio.ch0.len();
    let ls_sample = cue
        .loop_start_sample
        .or_else(|| audio.loop_meta.as_ref().and_then(|m| m.loop_start_sample));
    let le_sample = cue
        .loop_end_sample
        .or_else(|| audio.loop_meta.as_ref().and_then(|m| m.loop_end_sample));
    let src_sr = cue
        .source_sample_rate
        .or_else(|| audio.loop_meta.as_ref().and_then(|m| m.sample_rate));

    if let (Some(ls), Some(le)) = (ls_sample, le_sample)
        && le > ls
    {
        let ratio = src_sr
            .filter(|&r| r > 0)
            .map(|r| f64::from(MIX_RATE) / f64::from(r))
            .unwrap_or(1.0);
        let s = ((ls as f64) * ratio).round().max(0.0) as usize;
        let e = source_len.min(((le as f64) * ratio).round() as usize);
        if e > s {
            return (Some(s), Some(e));
        }
    }

    let ls_ms = cue
        .loop_start_ms
        .or_else(|| audio.loop_meta.as_ref().and_then(|m| m.loop_start_ms));
    let le_ms = cue
        .loop_end_ms
        .or_else(|| audio.loop_meta.as_ref().and_then(|m| m.loop_end_ms));
    if let (Some(ls), Some(le)) = (ls_ms, le_ms)
        && le > ls
    {
        let s = ((ls / 1000.0) * f64::from(MIX_RATE)).round().max(0.0) as usize;
        let e = source_len.min(((le / 1000.0) * f64::from(MIX_RATE)).round() as usize);
        if e > s {
            return (Some(s), Some(e));
        }
    }
    (None, None)
}

fn mix_bgm_plan(
    bgm: &BgmPlanInput,
    cache: &HashMap<String, PreparedAudio>,
    left: &mut [f32],
    right: &mut [f32],
    duck_gains: &[f32],
    tween_gains: &[f32],
) {
    let total_samples = left.len().min(right.len());
    if total_samples == 0 {
        return;
    }

    let has_story_files = bgm.cues.iter().any(|c| !c.stop && c.path.is_some());
    let mut cues = bgm.cues.clone();
    if !has_story_files
        && let Some(ref gp) = bgm.global_path
        && cache.contains_key(gp)
    {
        cues.insert(
            0,
            BgmCueInput {
                time_ms: 0.0,
                fade_ms: 0.0,
                stop: false,
                path: Some(gp.clone()),
                volume: Some(1.0),
                loop_start_ms: bgm.global_loop.as_ref().and_then(|l| l.loop_start_ms),
                loop_end_ms: bgm.global_loop.as_ref().and_then(|l| l.loop_end_ms),
                loop_start_sample: bgm.global_loop.as_ref().and_then(|l| l.loop_start_sample),
                loop_end_sample: bgm.global_loop.as_ref().and_then(|l| l.loop_end_sample),
                source_sample_rate: bgm.global_loop.as_ref().and_then(|l| l.sample_rate),
            },
        );
    }
    if cues.is_empty() {
        return;
    }

    cues.sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));
    let starts: Vec<usize> = cues
        .iter()
        .map(|c| {
            ((c.time_ms / 1000.0) * f64::from(MIX_RATE))
                .floor()
                .clamp(0.0, total_samples as f64) as usize
        })
        .collect();
    let master_gain = bgm.volume.max(0.0) * ACF_GAIN_BGM;

    for (idx, cue) in cues.iter().enumerate() {
        if cue.stop {
            continue;
        }
        let Some(audio) = cue.path.as_ref().and_then(|p| cache.get(p)) else {
            continue;
        };
        if audio.ch0.is_empty() {
            continue;
        }
        let start = starts[idx];
        let next = cues.get(idx + 1);
        let raw_fade_out = next
            .map(|n| {
                ((n.fade_ms.max(0.0) / 1000.0) * f64::from(MIX_RATE))
                    .round()
                    .min((total_samples - start) as f64) as usize
            })
            .unwrap_or(0);
        let end = total_samples.min(next.map(|_| starts[idx + 1]).unwrap_or(total_samples) + raw_fade_out);
        if end <= start {
            continue;
        }

        let duration = end - start;
        let fade_in = if cue.fade_ms > 0.0 {
            duration.min(((cue.fade_ms / 1000.0) * f64::from(MIX_RATE)).round() as usize)
        } else {
            0
        };
        let fade_out = raw_fade_out.min(duration);
        let pan = if audio.is_mono { MONO_PAN_GAIN } else { 1.0 };
        let cue_vol = cue.volume.unwrap_or(1.0).max(0.0) * pan * master_gain;
        let (loop_start, loop_end) = resolve_cue_loop_samples(cue, audio);

        let mut played = 0usize;
        for sample in start..end {
            let mut fade_gain = 1.0_f32;
            let local = sample - start;
            if fade_in > 0 && local < fade_in {
                fade_gain = (local as f32) / (fade_in as f32);
            }
            if fade_out > 0 {
                let remaining = end - sample;
                if remaining <= fade_out {
                    fade_gain = fade_gain.min((remaining as f32) / (fade_out as f32));
                }
            }
            let s_idx = resolve_loop_sample_index(played, audio.ch0.len(), loop_start, loop_end);
            let m = cue_vol * fade_gain * duck_gains[sample] * tween_gains[sample];
            left[sample] += audio.ch0[s_idx] * m;
            right[sample] += audio.ch1[s_idx] * m;
            played += 1;
        }
    }
}

fn float_to_i16_sample(sample: f32) -> i16 {
    let clamped = sample.clamp(-1.0, 1.0);
    if clamped < 0.0 {
        (clamped * 32768.0) as i16
    } else {
        (clamped * 32767.0) as i16
    }
}

pub fn write_stereo_wav(output: &Path, left: &[f32], right: &[f32]) -> Result<u64, String> {
    let total_frames = left.len().min(right.len());
    let total_samples = total_frames * MIX_CHANNELS;
    let data_bytes = (total_samples * 2) as u32;
    let riff_size = 36u32.saturating_add(data_bytes);

    if let Some(parent) = output.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }
    let file = File::create(output).map_err(|e| format!("create wav failed: {e}"))?;
    let mut w = BufWriter::with_capacity(256 * 1024, file);
    w.write_all(b"RIFF").map_err(|e| e.to_string())?;
    w.write_all(&riff_size.to_le_bytes())
        .map_err(|e| e.to_string())?;
    w.write_all(b"WAVEfmt ").map_err(|e| e.to_string())?;
    w.write_all(&16u32.to_le_bytes())
        .map_err(|e| e.to_string())?;
    w.write_all(&1u16.to_le_bytes()).map_err(|e| e.to_string())?;
    w.write_all(&(MIX_CHANNELS as u16).to_le_bytes())
        .map_err(|e| e.to_string())?;
    w.write_all(&MIX_RATE.to_le_bytes())
        .map_err(|e| e.to_string())?;
    let byte_rate = MIX_RATE * (MIX_CHANNELS as u32) * 2;
    w.write_all(&byte_rate.to_le_bytes())
        .map_err(|e| e.to_string())?;
    w.write_all(&((MIX_CHANNELS * 2) as u16).to_le_bytes())
        .map_err(|e| e.to_string())?;
    w.write_all(&16u16.to_le_bytes())
        .map_err(|e| e.to_string())?;
    w.write_all(b"data").map_err(|e| e.to_string())?;
    w.write_all(&data_bytes.to_le_bytes())
        .map_err(|e| e.to_string())?;

    let mut chunk_bytes = Vec::with_capacity(64 * 1024);
    for i in 0..total_frames {
        chunk_bytes.extend_from_slice(&float_to_i16_sample(left[i]).to_le_bytes());
        chunk_bytes.extend_from_slice(&float_to_i16_sample(right[i]).to_le_bytes());
        if chunk_bytes.len() >= 64 * 1024 {
            w.write_all(&chunk_bytes).map_err(|e| e.to_string())?;
            chunk_bytes.clear();
        }
    }
    if !chunk_bytes.is_empty() {
        w.write_all(&chunk_bytes).map_err(|e| e.to_string())?;
    }
    w.flush().map_err(|e| e.to_string())?;
    Ok(std::fs::metadata(output).map(|m| m.len()).unwrap_or(0))
}

fn write_stereo_aac(
    ffmpeg: &Path,
    output: &Path,
    bitrate: &str,
    left: &[f32],
    right: &[f32],
) -> Result<u64, String> {
    if let Some(parent) = output.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }
    let mut child = Command::new(ffmpeg)
        .args([
            "-hide_banner",
            "-y",
            "-loglevel",
            "error",
            "-f",
            "s16le",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-i",
            "pipe:0",
            "-c:a",
            "aac",
            "-b:a",
            bitrate,
        ])
        .arg(output)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn ffmpeg aac encoder: {e}"))?;

    let write_res: Result<(), String> = if let Some(mut stdin) = child.stdin.take() {
        let total_frames = left.len().min(right.len());
        let mut chunk = Vec::with_capacity(64 * 1024);
        let mut res = Ok(());
        for i in 0..total_frames {
            chunk.extend_from_slice(&float_to_i16_sample(left[i]).to_le_bytes());
            chunk.extend_from_slice(&float_to_i16_sample(right[i]).to_le_bytes());
            if chunk.len() >= 64 * 1024 {
                if let Err(e) = stdin.write_all(&chunk) {
                    res = Err(format!("ffmpeg aac stdin write failed: {e}"));
                    break;
                }
                chunk.clear();
            }
        }
        if res.is_ok()
            && !chunk.is_empty()
            && let Err(e) = stdin.write_all(&chunk)
        {
            res = Err(format!("ffmpeg aac stdin write failed: {e}"));
        }
        if res.is_ok()
            && let Err(e) = stdin.flush()
        {
            res = Err(format!("ffmpeg aac stdin flush failed: {e}"));
        }
        drop(stdin);
        res
    } else {
        Ok(())
    };
    if let Err(write_err) = write_res {
        let _ = child.kill();
        let _ = child.wait_with_output();
        return Err(write_err);
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("ffmpeg aac wait failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "ffmpeg aac failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(std::fs::metadata(output).map(|m| m.len()).unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::decode_audio_file;

    fn make_tone_wav(path: &Path, frames: usize, amp: f32) {
        let data_bytes = (frames * 4) as u32;
        let mut raw = Vec::with_capacity(44 + data_bytes as usize);
        raw.extend_from_slice(b"RIFF");
        raw.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        raw.extend_from_slice(b"WAVEfmt ");
        raw.extend_from_slice(&16u32.to_le_bytes());
        raw.extend_from_slice(&1u16.to_le_bytes());
        raw.extend_from_slice(&2u16.to_le_bytes());
        raw.extend_from_slice(&MIX_RATE.to_le_bytes());
        raw.extend_from_slice(&(MIX_RATE * 4).to_le_bytes());
        raw.extend_from_slice(&4u16.to_le_bytes());
        raw.extend_from_slice(&16u16.to_le_bytes());
        raw.extend_from_slice(b"data");
        raw.extend_from_slice(&data_bytes.to_le_bytes());
        let s = (amp * 32767.0).round() as i16;
        for _ in 0..(frames * 2) {
            raw.extend_from_slice(&s.to_le_bytes());
        }
        std::fs::write(path, &raw).unwrap();
    }

    #[test]
    fn wav_roundtrip_and_parallel_mix() {
        let tmp = std::env::temp_dir().join(format!("mss-mix-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let in_wav = tmp.join("tone.wav");
        let out_wav = tmp.join("mixed.wav");
        make_tone_wav(&in_wav, 4800, 0.25);

        let tracks = vec![MixTrack {
            path: in_wav.clone(),
            start_ms: 0.0,
            end_ms: Some(100.0),
            volume: 1.0,
            looping: false,
            fade_in_ms: 0.0,
            fade_out_ms: 0.0,
        }];
        let (n_frames, size) = mix_tracks_to_wav(100.0, &tracks, &out_wav).unwrap();
        assert_eq!(n_frames, 4800);
        assert_eq!(size, 44 + 4800 * 4);

        let decoded = decode_audio_file(&out_wav).unwrap();
        assert_eq!(decoded.sample_rate, MIX_RATE);
        assert_eq!(decoded.channels, 2);
        assert!((decoded.samples[10] - 0.25).abs() < 0.002);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn mix_audio_plan_applies_ducking_and_lipsync() {
        let tmp = std::env::temp_dir().join(format!("mss-plan-mix-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let bgm_wav = tmp.join("bgm.wav");
        let voice_wav = tmp.join("voice.wav");
        let out_wav = tmp.join("out.wav");

        make_tone_wav(&bgm_wav, 48_000, 0.4);
        make_tone_wav(&voice_wav, 24_000, 0.3);

        let res = mix_audio_plan(&AudioMixPlan {
            duration_ms: 2000.0,
            output_path: out_wav.to_string_lossy().into_owned(),
            output_format: None,
            audio_bitrate: None,
            ffmpeg_path: None,
            bgm: Some(BgmPlanInput {
                enabled: true,
                volume: 1.0,
                global_path: Some(bgm_wav.to_string_lossy().into_owned()),
                global_loop: None,
                cues: Vec::new(),
                volume_tweens: Vec::new(),
            }),
            se: None,
            voices: vec![VoiceTrackInput {
                path: Some(voice_wav.to_string_lossy().into_owned()),
                audio_bytes: None,
                start_ms: 500.0,
                end_ms: None,
                snippet_index: Some(0),
                compute_lip_sync: true,
                target_value_scale: Some(1.0),
            }],
        })
        .unwrap();

        assert!(res.ok);
        assert_eq!(res.frames, 96_000);
        let lips = res.lip_syncs.unwrap();
        assert_eq!(lips.len(), 1);
        assert_eq!(lips[0].snippet_index, Some(0));
        assert!(lips[0].envelope.values.len() > 20);

        let mixed = decode_audio_file(&out_wav).unwrap();
        // Before voice (at 100ms = sample 4800): pure BGM = 0.4 * 0.75 = 0.30
        assert!((mixed.samples[4800 * 2] - 0.30).abs() < 0.005);
        // During voice (at 600ms = sample 28800): 0.4*0.75*0.65 + 0.3*0.9 = 0.195 + 0.27 = 0.465
        assert!((mixed.samples[28800 * 2] - 0.465).abs() < 0.005);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn bgm_plan_input_defaults_volume_to_0_35_and_handles_corrupt_audio_gracefully() {
        let parsed: BgmPlanInput = serde_json::from_str("{}").unwrap();
        assert!((parsed.volume - DEFAULT_BGM_VOLUME).abs() < 1e-6);
        assert!(parsed.enabled);

        let tmp = std::env::temp_dir().join(format!("mss-corrupt-audio-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let corrupt = tmp.join("bad.mp3");
        let out_wav = tmp.join("out.wav");
        std::fs::write(&corrupt, b"NOT_AN_AUDIO_FILE").unwrap();

        let res = mix_audio_plan(&AudioMixPlan {
            duration_ms: 200.0,
            output_path: out_wav.to_string_lossy().into_owned(),
            output_format: None,
            audio_bitrate: None,
            ffmpeg_path: None,
            bgm: Some(BgmPlanInput {
                enabled: true,
                volume: DEFAULT_BGM_VOLUME,
                global_path: Some(corrupt.to_string_lossy().into_owned()),
                global_loop: None,
                cues: Vec::new(),
                volume_tweens: Vec::new(),
            }),
            se: None,
            voices: Vec::new(),
        })
        .unwrap();
        assert!(res.ok);

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
