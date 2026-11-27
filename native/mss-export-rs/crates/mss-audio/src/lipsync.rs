//! 60Hz RMS Voice LipSyncEnvelope & TextLipSequence generator.
//! 1:1 parity with `src/renderer/src/utils/LipSyncEnvelope.ts` and `src/common/official/timing.ts`.

use mss_core::timing::{FRAME_MS, word_interval_frames, word_interval_half_frames};
use serde::{Deserialize, Serialize};

pub const LIP_TARGET_VALUE_SCALE: f64 = 1.0;
pub const LIP_POW_K: f64 = 1.75;
pub const LIP_THRESHOLD: f64 = 0.06;
pub const LIP_MIN_VALUE: f64 = 0.2;
pub const LIP_MAX_VALUE: f64 = 1.0;

pub const LIP_LEVELS: [f32; 38] = [
    0.12, 0.24, 0.9, 1.0, 0.5, 0.24, 0.1, 0.24, 0.45, 0.8, 0.8, 0.96, 0.8, 0.4, 0.24, 0.1, 0.06,
    0.1, 0.24, 0.24, 0.5, 0.7, 0.96, 0.9, 0.8, 0.24, 0.24, 0.1, 0.06, 0.1, 0.24, 0.4, 0.5, 0.9,
    0.8, 0.45, 0.3, 0.24,
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LipSyncEnvelope {
    pub values: Vec<f32>,
    pub frame_ms: f64,
    pub duration_ms: f64,
    pub audio_duration_ms: f64,
    pub release_step: i32,
    pub target_value_scale: f64,
    pub pow_k: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextLipSequence {
    pub values: Vec<f32>,
    pub targets: Vec<f32>,
    pub frame_ms: f64,
    pub release_step: i32,
}

pub fn lip_coefficients(target_value_scale: Option<f64>) -> (f64, f64) {
    let tvs = match target_value_scale {
        Some(v) if v.is_finite() && v > 0.0 => v,
        _ => LIP_TARGET_VALUE_SCALE,
    };
    (tvs, tvs * LIP_POW_K)
}

pub fn lip_target_from_rms(rms: f64, tvs: f64, pow_k: f64) -> f64 {
    if !rms.is_finite() || rms <= 0.0 {
        return 0.0;
    }
    let a = rms * tvs;
    let shaped = a * (a + 1.0).powf(pow_k);
    if shaped < LIP_THRESHOLD {
        return 0.0;
    }
    shaped.clamp(LIP_MIN_VALUE, LIP_MAX_VALUE)
}

pub fn smooth_lip_value(target: f64, previous: f64) -> f64 {
    let (kt, kp) = if previous < 0.1 {
        (0.6, 0.4)
    } else if (target - previous).abs() < 0.1 {
        (0.2, 0.8)
    } else {
        (0.25, 0.75)
    };
    target * kt + previous * kp
}

pub fn build_lip_sync_envelope(
    channels: &[&[f32]],
    sample_rate: u32,
    target_value_scale: Option<f64>,
) -> LipSyncEnvelope {
    let (tvs, pow_k) = lip_coefficients(target_value_scale);
    if channels.is_empty() || sample_rate == 0 {
        return LipSyncEnvelope {
            values: Vec::new(),
            frame_ms: FRAME_MS,
            duration_ms: 0.0,
            audio_duration_ms: 0.0,
            release_step: -1,
            target_value_scale: tvs,
            pow_k,
        };
    }
    let samples = channels.iter().map(|c| c.len()).min().unwrap_or(0);
    if samples == 0 {
        return LipSyncEnvelope {
            values: Vec::new(),
            frame_ms: FRAME_MS,
            duration_ms: 0.0,
            audio_duration_ms: 0.0,
            release_step: -1,
            target_value_scale: tvs,
            pow_k,
        };
    }

    let sr = f64::from(sample_rate);
    let audio_duration_ms = ((samples as f64) / sr) * 1000.0;
    let step_samples = (sample_rate / 60) as usize;
    let max_steps = samples.div_ceil(step_samples.max(1)) + 64;
    let mut values = Vec::with_capacity(max_steps);
    let mut prev: f64 = 0.0;
    let mut release_step: i32 = -1;
    let ch_count = channels.len() as f64;

    for step in 0..max_steps {
        let end = (((step as f64) / 60.0) * sr).floor() as usize;
        let begin = end.saturating_sub(step_samples);
        let mut rms = 0.0;
        if begin < samples && end > begin {
            let stop = end.min(samples);
            let mut energy: f64 = 0.0;
            for i in begin..stop {
                let mut mixed: f64 = 0.0;
                for ch in channels {
                    mixed += f64::from(ch[i]);
                }
                mixed /= ch_count;
                energy += mixed * mixed;
            }
            rms = (energy / ((stop - begin).max(1) as f64)).sqrt();
        }
        let target = lip_target_from_rms(rms, tvs, pow_k);
        let mut value = smooth_lip_value(target, prev);
        prev = value;
        if begin >= samples && value < 0.001 {
            value = 0.0;
            values.push(value as f32);
            release_step = step as i32;
            break;
        }
        values.push(value as f32);
    }

    let count = values.len();
    LipSyncEnvelope {
        values,
        frame_ms: FRAME_MS,
        duration_ms: (count as f64) * FRAME_MS,
        audio_duration_ms,
        release_step,
        target_value_scale: tvs,
        pow_k,
    }
}

pub fn text_lip_sequence(
    half_letters: usize,
    slot: Option<(usize, usize)>,
    end_step: Option<usize>,
) -> TextLipSequence {
    if half_letters == 0 {
        return TextLipSequence {
            values: Vec::new(),
            targets: Vec::new(),
            frame_ms: FRAME_MS,
            release_step: -1,
        };
    }
    let frames_per_half = word_interval_half_frames().max(1) as usize;
    let frames_per_char = word_interval_frames() as usize;
    let (step, first) = match slot {
        Some((idx, total)) => (total.max(1), idx + 1),
        None => (1, 0),
    };
    let closes = (half_letters * frames_per_half).saturating_sub(frames_per_char);
    let limit = end_step.unwrap_or(closes).max(closes) + 64;

    let mut values = Vec::with_capacity(limit);
    let mut targets = Vec::with_capacity(limit);
    let mut prev: f64 = 0.0;
    let mut release_step: i32 = -1;

    for frame in 0..limit {
        let closed = end_step.is_some_and(|e| frame >= e) || frame >= closes;
        let target = if closed {
            0.0
        } else {
            let k = frame / frames_per_half;
            f64::from(LIP_LEVELS[(k * step + first) % LIP_LEVELS.len()])
        };
        let value = smooth_lip_value(target, prev);
        prev = value;
        targets.push(target as f32);
        if closed && value < 0.001 {
            values.push(0.0);
            release_step = frame as i32;
            break;
        }
        values.push(value as f32);
    }

    TextLipSequence {
        values,
        targets,
        frame_ms: FRAME_MS,
        release_step,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_lip_sync_envelope_decays_to_release_step() {
        let mut samples = vec![0.0_f32; 48_000];
        for (i, s) in samples.iter_mut().enumerate().take(24_000) {
            *s = ((i as f32) * 0.05).sin() * 0.4;
        }
        let env = build_lip_sync_envelope(&[&samples], 48_000, Some(1.0));
        assert!(env.values.len() > 30);
        assert!(env.release_step > 30);
        assert_eq!(*env.values.last().unwrap(), 0.0);
        assert!(env.values[15] >= 0.2);
    }
}
