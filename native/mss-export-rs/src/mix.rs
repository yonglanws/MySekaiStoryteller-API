//! Multi-threaded native Rust WAV audio mixer and writer.
//! Modeled directly on SekaiStoryExporter `sse-export/src/lib.rs` (`mix_blocks`, `write_wav`).

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const MIX_RATE: u32 = 48_000;
const MIX_CHANNELS: usize = 2;
const MAX_MIX_THREADS: usize = 8;

#[derive(Debug, Clone)]
pub struct DecodedWav {
    pub sample_rate: u32,
    pub channels: u16,
    /// Interleaved f32 samples in [-1.0, 1.0].
    pub samples: Vec<f32>,
}

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

/// Minimal zero-dependency PCM/IEEE-float WAV decoder (16-bit, 24-bit, 32-bit float).
pub fn read_wav(path: &Path) -> Result<DecodedWav, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("failed to read {}: {e}", path.display()))?;
    parse_wav_bytes(&bytes)
}

pub fn parse_wav_bytes(bytes: &[u8]) -> Result<DecodedWav, String> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a valid RIFF WAVE file".into());
    }
    let mut offset = 12usize;
    let mut audio_format: u16 = 0;
    let mut channels: u16 = 0;
    let mut sample_rate: u32 = 0;
    let mut bits_per_sample: u16 = 0;
    let mut data_slice: Option<&[u8]> = None;

    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let body_start = offset + 8;
        let body_end = (body_start + size).min(bytes.len());
        let body = &bytes[body_start..body_end];

        if id == b"fmt " && body.len() >= 16 {
            audio_format = u16::from_le_bytes(body[0..2].try_into().unwrap());
            channels = u16::from_le_bytes(body[2..4].try_into().unwrap());
            sample_rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
            bits_per_sample = u16::from_le_bytes(body[14..16].try_into().unwrap());
        } else if id == b"data" {
            data_slice = Some(body);
        }
        offset = body_start + size + (size % 2);
    }

    let data = data_slice.ok_or_else(|| "WAV missing data chunk".to_owned())?;
    if channels == 0 || sample_rate == 0 {
        return Err("WAV missing valid fmt chunk".into());
    }

    let samples: Vec<f32> = match (audio_format, bits_per_sample) {
        (1, 16) => data
            .chunks_exact(2)
            .map(|c| f32::from(i16::from_le_bytes([c[0], c[1]])) / 32768.0)
            .collect(),
        (1, 24) => data
            .chunks_exact(3)
            .map(|c| {
                let raw = ((c[0] as i32) | ((c[1] as i32) << 8) | ((c[2] as i32) << 16)) << 8 >> 8;
                raw as f32 / 8_388_608.0
            })
            .collect(),
        (3, 32) => data
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
        _ => {
            return Err(format!(
                "unsupported WAV format={audio_format} bits={bits_per_sample}"
            ));
        }
    };

    Ok(DecodedWav {
        sample_rate,
        channels,
        samples,
    })
}

/// Mixes `tracks` in parallel blocks into interleaved 48kHz stereo f32 and writes a 16-bit WAV.
pub fn mix_tracks_to_wav(
    duration_ms: f64,
    tracks: &[MixTrack],
    output: &Path,
) -> Result<(usize, u64), String> {
    let total_frames = ((duration_ms.max(0.0) / 1000.0) * f64::from(MIX_RATE)).round() as usize;
    let threads = std::thread::available_parallelism()
        .map_or(1, usize::from)
        .clamp(1, MAX_MIX_THREADS);

    // Parallel WAV decoding across threads
    let decoded: Vec<Result<Arc<DecodedWav>, String>> = std::thread::scope(|s| {
        let handles: Vec<_> = tracks
            .iter()
            .map(|t| {
                let p = t.path.clone();
                s.spawn(move || read_wav(&p).map(Arc::new))
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or_else(|_| Err("wav decode panicked".into())))
            .collect()
    });

    let mut loaded: Vec<(&MixTrack, Arc<DecodedWav>)> = Vec::with_capacity(tracks.len());
    for (track, res) in tracks.iter().zip(decoded) {
        loaded.push((track, res?));
    }

    let block_frames = total_frames.div_ceil(threads).max(1);
    let blocks: Vec<Vec<f32>> = std::thread::scope(|s| {
        let loaded_ref = &loaded;
        let handles: Vec<_> = (0..total_frames)
            .step_by(block_frames)
            .map(|start_frame| {
                let end_frame = (start_frame + block_frames).min(total_frames);
                s.spawn(move || mix_block(loaded_ref, start_frame, end_frame))
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().expect("mix worker panicked"))
            .collect()
    });

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
    w.write_all(&riff_size.to_le_bytes()).map_err(|e| e.to_string())?;
    w.write_all(b"WAVEfmt ").map_err(|e| e.to_string())?;
    w.write_all(&16u32.to_le_bytes()).map_err(|e| e.to_string())?;
    w.write_all(&1u16.to_le_bytes()).map_err(|e| e.to_string())?; // PCM
    w.write_all(&(MIX_CHANNELS as u16).to_le_bytes()).map_err(|e| e.to_string())?;
    w.write_all(&MIX_RATE.to_le_bytes()).map_err(|e| e.to_string())?;
    let byte_rate = MIX_RATE * (MIX_CHANNELS as u32) * 2;
    w.write_all(&byte_rate.to_le_bytes()).map_err(|e| e.to_string())?;
    w.write_all(&((MIX_CHANNELS * 2) as u16).to_le_bytes()).map_err(|e| e.to_string())?;
    w.write_all(&16u16.to_le_bytes()).map_err(|e| e.to_string())?;
    w.write_all(b"data").map_err(|e| e.to_string())?;
    w.write_all(&data_bytes.to_le_bytes()).map_err(|e| e.to_string())?;

    let mut chunk_bytes = Vec::with_capacity(64 * 1024);
    for block in &blocks {
        chunk_bytes.clear();
        for &s in block {
            let clamped = s.clamp(-1.0, 1.0);
            let i = (clamped * 32767.0).round() as i16;
            chunk_bytes.extend_from_slice(&i.to_le_bytes());
            if chunk_bytes.len() >= 64 * 1024 {
                w.write_all(&chunk_bytes).map_err(|e| e.to_string())?;
                chunk_bytes.clear();
            }
        }
        if !chunk_bytes.is_empty() {
            w.write_all(&chunk_bytes).map_err(|e| e.to_string())?;
        }
    }
    w.flush().map_err(|e| e.to_string())?;
    let file_size = std::fs::metadata(output).map(|m| m.len()).unwrap_or(0);
    Ok((total_frames, file_size))
}

fn mix_block(
    tracks: &[(&MixTrack, Arc<DecodedWav>)],
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_roundtrip_and_parallel_mix() {
        let tmp = std::env::temp_dir().join(format!("mss-mix-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let in_wav = tmp.join("tone.wav");
        let out_wav = tmp.join("mixed.wav");

        // Write a 100ms 48kHz stereo tone at 0.25 amplitude
        let frames = 4800usize;
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
        let s = (0.25f32 * 32767.0).round() as i16;
        for _ in 0..(frames * 2) {
            raw.extend_from_slice(&s.to_le_bytes());
        }
        std::fs::write(&in_wav, &raw).unwrap();

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
        assert_eq!(size, 44 + u64::from(data_bytes));

        let decoded = read_wav(&out_wav).unwrap();
        assert_eq!(decoded.sample_rate, MIX_RATE);
        assert_eq!(decoded.channels, 2);
        assert!((decoded.samples[10] - 0.25).abs() < 0.002);

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
