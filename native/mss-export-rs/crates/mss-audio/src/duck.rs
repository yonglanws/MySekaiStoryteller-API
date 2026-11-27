//! CRI `ProjectSekai.acf` category gains, `SquareReverse(0.5)` voice ducking,
//! SE ducking, `BgmVolume` tween curves, and HCA loop index wrapping.
//! 1:1 parity with `src/renderer/src/managers/video-export/AudioMuxer.ts`.

use serde::{Deserialize, Serialize};

pub const ACF_GAIN_BGM: f32 = 0.75;
pub const ACF_GAIN_SE: f32 = 0.80;
pub const ACF_GAIN_VOICE: f32 = 0.90;
pub const MONO_PAN_GAIN: f32 = std::f32::consts::FRAC_1_SQRT_2;

pub const VOICE_DUCK_LEVEL: f64 = 0.65;
pub const VOICE_DUCK_RELEASE_SEC: f64 = 0.5;
pub const VOICE_DUCK_CURVE_STRENGTH: f64 = 0.5;

pub const SE_DUCK_LEVEL: f64 = 0.80;
pub const SE_DUCK_RELEASE_SEC: f64 = 0.5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DuckKind {
    Voice,
    Se,
}

#[derive(Debug, Clone, Copy)]
pub struct DuckSpan {
    pub start_sample: usize,
    pub end_sample: Option<usize>,
    pub kind: DuckKind,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BgmVolumeTweenPoint {
    pub time_ms: f64,
    pub volume: f64,
    pub duration_ms: f64,
}

/// CRI `SquareReverse(s)`: `1 - (1 - x)^(1 + s)` (`AudioMuxer.ts::evaluateDuckReleaseCurve`).
pub fn evaluate_duck_release_curve(kind: DuckKind, x: f64) -> f64 {
    let clamped = x.clamp(0.0, 1.0);
    match kind {
        DuckKind::Voice => 1.0 - (1.0 - clamped).powf(1.0 + VOICE_DUCK_CURVE_STRENGTH),
        DuckKind::Se => clamped,
    }
}

pub fn compute_bgm_duck_gain_buffer(
    total_samples: usize,
    sample_rate: u32,
    spans: &[DuckSpan],
) -> Vec<f32> {
    let mut gains = vec![1.0_f32; total_samples];
    if total_samples == 0 || spans.is_empty() {
        return gains;
    }

    let sr = f64::from(sample_rate);
    for span in spans {
        let level = match span.kind {
            DuckKind::Voice => VOICE_DUCK_LEVEL,
            DuckKind::Se => SE_DUCK_LEVEL,
        };
        let release_sec = match span.kind {
            DuckKind::Voice => VOICE_DUCK_RELEASE_SEC,
            DuckKind::Se => SE_DUCK_RELEASE_SEC,
        };
        let level_f32 = level as f32;
        let start = span.start_sample.min(total_samples);
        let end = match span.end_sample {
            None => total_samples,
            Some(e) => e.max(start).min(total_samples),
        };

        for g in &mut gains[start..end] {
            if level_f32 < *g {
                *g = level_f32;
            }
        }

        if let Some(end_sample) = span.end_sample {
            let release_start = end_sample;
            let release_samples = (release_sec * sr).round().max(1.0) as usize;
            let release_end = total_samples.min(release_start.saturating_add(release_samples));
            for (i, g) in gains[release_start..release_end].iter_mut().enumerate() {
                let x = (i as f64) / (release_samples as f64);
                let v = (level + (1.0 - level) * evaluate_duck_release_curve(span.kind, x)) as f32;
                if v < *g {
                    *g = v;
                }
            }
        }
    }
    gains
}

pub fn compute_bgm_volume_tween_buffer(
    total_samples: usize,
    sample_rate: u32,
    tweens: &[BgmVolumeTweenPoint],
    initial_volume: f32,
) -> Vec<f32> {
    let mut gains = vec![initial_volume; total_samples];
    if total_samples == 0 || tweens.is_empty() {
        return gains;
    }

    let mut sorted = tweens.to_vec();
    sorted.sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));
    let sr = f64::from(sample_rate);
    let mut current_vol = initial_volume;
    let mut cursor: usize = 0;

    for tw in &sorted {
        let start = ((tw.time_ms / 1000.0) * sr)
            .round()
            .max(0.0)
            .min(total_samples as f64) as usize;
        let start = start.max(cursor);
        for g in &mut gains[cursor..start] {
            *g = current_vol;
        }
        let dur_samples = ((tw.duration_ms / 1000.0) * sr).round().max(0.0) as usize;
        let target = tw.volume.max(0.0) as f32;
        let end = total_samples.min(start.saturating_add(dur_samples));
        if end > start && dur_samples > 0 {
            for (offset, g) in gains[start..end].iter_mut().enumerate() {
                let p = (offset as f32) / (dur_samples as f32);
                *g = current_vol + (target - current_vol) * p;
            }
        }
        current_vol = target;
        cursor = end;
    }
    for g in &mut gains[cursor..total_samples] {
        *g = current_vol;
    }
    gains
}

pub fn resolve_loop_sample_index(
    played_samples: usize,
    total_length: usize,
    loop_start: Option<usize>,
    loop_end: Option<usize>,
) -> usize {
    if total_length == 0 {
        return 0;
    }
    if let (Some(ls), Some(le)) = (loop_start, loop_end)
        && le > ls
        && le <= total_length
    {
        if played_samples < le {
            return played_samples;
        }
        return ls + ((played_samples - ls) % (le - ls));
    }
    played_samples % total_length
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ducking_curves_match_acf_reference() {
        assert_eq!(evaluate_duck_release_curve(DuckKind::Voice, 0.0), 0.0);
        assert!(
            (evaluate_duck_release_curve(DuckKind::Voice, 0.5) - (1.0 - 0.5_f64.powf(1.5))).abs()
                < 1e-6
        );
        assert_eq!(evaluate_duck_release_curve(DuckKind::Voice, 1.0), 1.0);
        assert_eq!(evaluate_duck_release_curve(DuckKind::Se, 0.5), 0.5);

        let duck = compute_bgm_duck_gain_buffer(
            6000,
            1000,
            &[
                DuckSpan {
                    start_sample: 1000,
                    end_sample: Some(2000),
                    kind: DuckKind::Voice,
                },
                DuckSpan {
                    start_sample: 1500,
                    end_sample: Some(2100),
                    kind: DuckKind::Se,
                },
                DuckSpan {
                    start_sample: 4000,
                    end_sample: Some(4500),
                    kind: DuckKind::Se,
                },
            ],
        );
        assert_eq!(duck[500], 1.0);
        assert!((duck[1200] - 0.65).abs() < 1e-6);
        assert!((duck[1700] - 0.65).abs() < 1e-6);
        assert!(duck[2250] > 0.65 && duck[2250] < 1.0);
        assert_eq!(duck[3000], 1.0);
        assert!((duck[4200] - 0.80).abs() < 1e-6);
        assert!((duck[4750] - 0.90).abs() < 1e-6);
        assert_eq!(duck[5500], 1.0);
    }

    #[test]
    fn bgm_volume_tween_and_loop_wrapping_match_reference() {
        let tween = compute_bgm_volume_tween_buffer(
            3000,
            1000,
            &[BgmVolumeTweenPoint {
                time_ms: 1000.0,
                volume: 0.4,
                duration_ms: 1000.0,
            }],
            1.0,
        );
        assert_eq!(tween[500], 1.0);
        assert!((tween[1500] - 0.7).abs() < 1e-6);
        assert!((tween[2500] - 0.4).abs() < 1e-6);

        assert_eq!(resolve_loop_sample_index(15, 200, Some(50), Some(150)), 15);
        assert_eq!(resolve_loop_sample_index(150, 200, Some(50), Some(150)), 50);
        assert_eq!(resolve_loop_sample_index(265, 200, Some(50), Some(150)), 65);
    }
}
