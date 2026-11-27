//! Audio decoding via fast-path WAV (PCM 16/24/32f + `smpl` loop chunk) and `symphonia`
//! (MP3, WAV, OGG/Vorbis, AAC/MP4), plus linear resampling matching `AudioMuxer.ts`.

use std::io::Cursor;
use std::path::Path;

use serde::{Deserialize, Serialize};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{CODEC_TYPE_NULL, DecoderOptions};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopMetadata {
    pub loop_start_ms: Option<f64>,
    pub loop_end_ms: Option<f64>,
    pub loop_start_sample: Option<usize>,
    pub loop_end_sample: Option<usize>,
    pub sample_rate: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct DecodedAudio {
    pub sample_rate: u32,
    pub channels: u16,
    /// Interleaved f32 samples in [-1.0, 1.0].
    pub samples: Vec<f32>,
    pub loop_meta: Option<LoopMetadata>,
}

impl DecodedAudio {
    /// Deinterleave and resample to stereo `(ch0, ch1)` at `target_rate`.
    pub fn to_stereo_at_rate(&self, target_rate: u32) -> (Vec<f32>, Vec<f32>) {
        let ch = usize::from(self.channels.max(1));
        let frames = self.samples.len() / ch;
        if frames == 0 {
            return (Vec::new(), Vec::new());
        }
        let mut raw0 = Vec::with_capacity(frames);
        let mut raw1 = if ch > 1 {
            Vec::with_capacity(frames)
        } else {
            Vec::new()
        };
        for f in 0..frames {
            let base = f * ch;
            raw0.push(self.samples[base]);
            if ch > 1 {
                raw1.push(self.samples[base + 1]);
            }
        }
        let ch0 = resample_channel_linear(&raw0, self.sample_rate, target_rate);
        let ch1 = if ch > 1 {
            resample_channel_linear(&raw1, self.sample_rate, target_rate)
        } else {
            ch0.clone()
        };
        (ch0, ch1)
    }

    /// Split into separate per-channel planar vectors (without resampling).
    pub fn to_planar_channels(&self) -> Vec<Vec<f32>> {
        let ch = usize::from(self.channels.max(1));
        let frames = self.samples.len() / ch;
        let mut out = vec![Vec::with_capacity(frames); ch];
        for f in 0..frames {
            let base = f * ch;
            for c in 0..ch {
                out[c].push(self.samples[base + c]);
            }
        }
        out
    }
}

/// Exact linear resampler matching `AudioMuxer.ts::resampleChannelLinear`.
pub fn resample_channel_linear(input: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    if input.is_empty() || source_rate == 0 || target_rate == 0 || source_rate == target_rate {
        return input.to_vec();
    }
    let out_len = (((input.len() as f64) * f64::from(target_rate)) / f64::from(source_rate))
        .round()
        .max(1.0) as usize;
    let mut output = Vec::with_capacity(out_len);
    let step = f64::from(source_rate) / f64::from(target_rate);
    let last_index = input.len() - 1;
    for i in 0..out_len {
        let pos = (i as f64) * step;
        let idx = pos.floor() as usize;
        if idx >= last_index {
            output.push(input[last_index]);
        } else {
            let frac = (pos - (idx as f64)) as f32;
            output.push(input[idx] + (input[idx + 1] - input[idx]) * frac);
        }
    }
    output
}

/// Fast-path uncompressed RIFF WAVE parser (16-bit, 24-bit PCM, 32-bit IEEE float) + `smpl` loop chunk.
pub fn parse_wav_bytes(bytes: &[u8]) -> Result<DecodedAudio, String> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a valid RIFF WAVE file".into());
    }
    let mut offset = 12usize;
    let mut audio_format: u16 = 0;
    let mut channels: u16 = 0;
    let mut sample_rate: u32 = 0;
    let mut bits_per_sample: u16 = 0;
    let mut data_slice: Option<&[u8]> = None;
    let mut smpl_loop: Option<(u32, u32)> = None;

    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let body_start = offset + 8;
        let body_end = body_start.saturating_add(size).min(bytes.len());
        let body = &bytes[body_start..body_end];

        if id == b"fmt " && body.len() >= 16 {
            audio_format = u16::from_le_bytes(body[0..2].try_into().unwrap());
            channels = u16::from_le_bytes(body[2..4].try_into().unwrap());
            sample_rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
            bits_per_sample = u16::from_le_bytes(body[14..16].try_into().unwrap());
        } else if id == b"data" {
            data_slice = Some(body);
        } else if id == b"smpl" && body.len() >= 52 {
            let loop_count = u32::from_le_bytes(body[28..32].try_into().unwrap());
            if loop_count >= 1 {
                let ls = u32::from_le_bytes(body[44..48].try_into().unwrap());
                let le = u32::from_le_bytes(body[48..52].try_into().unwrap());
                if le > ls {
                    smpl_loop = Some((ls, le));
                }
            }
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

    let loop_meta = smpl_loop.map(|(ls, le)| LoopMetadata {
        loop_start_ms: Some((f64::from(ls) / f64::from(sample_rate)) * 1000.0),
        loop_end_ms: Some((f64::from(le) / f64::from(sample_rate)) * 1000.0),
        loop_start_sample: Some(ls as usize),
        loop_end_sample: Some(le as usize),
        sample_rate: Some(sample_rate),
    });

    Ok(DecodedAudio {
        sample_rate,
        channels,
        samples,
        loop_meta,
    })
}

pub fn decode_audio_bytes(bytes: &[u8], ext_hint: Option<&str>) -> Result<DecodedAudio, String> {
    if bytes.len() >= 12
        && &bytes[0..4] == b"RIFF"
        && &bytes[8..12] == b"WAVE"
        && let Ok(wav) = parse_wav_bytes(bytes)
    {
        return Ok(wav);
    }

    let mut hint = Hint::new();
    if let Some(ext) = ext_hint.filter(|s| !s.is_empty()) {
        hint.with_extension(ext);
    }

    let mss = MediaSourceStream::new(Box::new(Cursor::new(bytes.to_vec())), Default::default());
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("symphonia probe failed: {e}"))?;

    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| "no supported audio tracks found".to_owned())?;
    let track_id = track.id;
    let codec_params = track.codec_params.clone();

    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|e| format!("symphonia codec init failed: {e}"))?;

    let mut sample_rate = codec_params.sample_rate.unwrap_or(48_000);
    let mut channels = codec_params.channels.map(|c| c.count() as u16).unwrap_or(2);
    let mut samples: Vec<f32> = Vec::new();
    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    loop {
        let packet = match format.next_packet() {
            Ok(pkt) => pkt,
            Err(SymphoniaError::IoError(ref err))
                if err.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(SymphoniaError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(err) => return Err(format!("audio packet read error: {err}")),
        };

        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                sample_rate = spec.rate;
                channels = spec.channels.count() as u16;
                let buf = sample_buf.get_or_insert_with(|| {
                    SampleBuffer::<f32>::new(decoded.capacity() as u64, spec)
                });
                if buf.capacity() < decoded.frames() * spec.channels.count() {
                    *buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
                }
                buf.copy_interleaved_ref(decoded);
                samples.extend_from_slice(buf.samples());
            }
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(SymphoniaError::IoError(ref err))
                if err.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(SymphoniaError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(err) => return Err(format!("audio decode error: {err}")),
        }
    }

    if channels == 0 || sample_rate == 0 {
        return Err("decoded audio has zero channels or sample rate".into());
    }

    Ok(DecodedAudio {
        sample_rate,
        channels,
        samples,
        loop_meta: None,
    })
}

pub fn decode_audio_file(path: &Path) -> Result<DecodedAudio, String> {
    let bytes =
        std::fs::read(path).map_err(|e| format!("failed to read {}: {e}", path.display()))?;
    let ext = path.extension().and_then(|s| s.to_str());
    let mut decoded = decode_audio_bytes(&bytes, ext)?;

    // Check optional `.loop.json` sidecar next to audio file if no embedded `smpl` loop chunk.
    if decoded.loop_meta.is_none() {
        let sidecar = Path::new(&format!("{}.loop.json", path.to_string_lossy())).to_path_buf();
        if sidecar.exists()
            && let Ok(text) = std::fs::read_to_string(&sidecar)
            && let Ok(meta) = serde_json::from_str::<LoopMetadata>(&text)
        {
            decoded.loop_meta = Some(meta);
        }
    }
    Ok(decoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linear_resample_matches_expected_length_and_values() {
        let input = vec![0.0_f32, 1.0, 0.0];
        let out = resample_channel_linear(&input, 24_000, 48_000);
        assert_eq!(out.len(), 6);
        assert!((out[0] - 0.0).abs() < 1e-6);
        assert!((out[1] - 0.5).abs() < 1e-6);
        assert!((out[2] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn parse_wav_extracts_smpl_loop() {
        let mut buf = Vec::new();
        let data_bytes = 16u32;
        let smpl_len = 60u32;
        let payload_len = 4 + (8 + 16) + (8 + data_bytes) + (8 + smpl_len);
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&payload_len.to_le_bytes());
        buf.extend_from_slice(b"WAVE");
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&16u32.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes());
        buf.extend_from_slice(&2u16.to_le_bytes());
        buf.extend_from_slice(&48_000u32.to_le_bytes());
        buf.extend_from_slice(&(48_000u32 * 4).to_le_bytes());
        buf.extend_from_slice(&4u16.to_le_bytes());
        buf.extend_from_slice(&16u16.to_le_bytes());
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&data_bytes.to_le_bytes());
        buf.extend_from_slice(&vec![0u8; data_bytes as usize]);
        buf.extend_from_slice(b"smpl");
        buf.extend_from_slice(&smpl_len.to_le_bytes());
        let mut smpl = vec![0u8; smpl_len as usize];
        smpl[28..32].copy_from_slice(&1u32.to_le_bytes());
        smpl[44..48].copy_from_slice(&48_000u32.to_le_bytes());
        smpl[48..52].copy_from_slice(&192_000u32.to_le_bytes());
        buf.extend_from_slice(&smpl);

        let decoded = parse_wav_bytes(&buf).unwrap();
        let meta = decoded.loop_meta.unwrap();
        assert_eq!(meta.loop_start_sample, Some(48_000));
        assert_eq!(meta.loop_end_sample, Some(192_000));
        assert!((meta.loop_start_ms.unwrap() - 1000.0).abs() < 1e-6);
        assert!((meta.loop_end_ms.unwrap() - 4000.0).abs() < 1e-6);
    }
}
