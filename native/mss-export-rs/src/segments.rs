//! Parallel segment splitting and lossless ffconcat joining.
//! Modeled directly on SekaiStoryExporter `sse-export/src/segments.rs` (ADR-0024).

use std::ops::Range;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Instant;

use crate::hardware::Codec;
use crate::pipe::{
    audio_truncation_args, bt709_vui_bsf, detect_video_codec, partial_output_path,
    write_output_atomically,
};

/// Minimum frames per parallel segment (longer than 240-frame GOP).
pub const MIN_SEGMENT_FRAMES: u32 = 300;

/// Partition `range` into `min(jobs, frames / MIN_SEGMENT_FRAMES)` contiguous ranges.
pub fn split_segments(range: Range<u32>, jobs: u32) -> Vec<Range<u32>> {
    let frames = range.end.saturating_sub(range.start);
    let n = jobs.clamp(1, (frames / MIN_SEGMENT_FRAMES).max(1));
    let at = |i: u32| range.start + (u64::from(frames) * u64::from(i) / u64::from(n)) as u32;
    (0..n).map(|i| at(i)..at(i + 1)).collect()
}

/// Build an `ffconcat version 1.0` manifest with exact microsecond durations so cumulative
/// drift never exceeds 0.5 µs (exact parity with `sse-export/src/segments.rs::concat_list`).
pub fn build_concat_list(fps: u32, segment_entries: &[(PathBuf, u32)]) -> Vec<u8> {
    let micros = |frame: u64| (frame * 1_000_000 + u64::from(fps) / 2) / u64::from(fps);
    let mut list = b"ffconcat version 1.0\n".to_vec();
    let mut cursor: u64 = 0;
    for (file, frame_count) in segment_entries {
        let next = cursor + u64::from(*frame_count);
        let duration = micros(next).saturating_sub(micros(cursor));
        cursor = next;
        let path_str = file.to_string_lossy().replace('\\', "/");
        list.extend_from_slice(b"file '");
        for byte in path_str.as_bytes() {
            if *byte == b'\'' {
                list.extend_from_slice(b"'\\''");
            } else {
                list.push(*byte);
            }
        }
        list.extend_from_slice(
            format!(
                "'\nduration {}.{:06}\n",
                duration / 1_000_000,
                duration % 1_000_000
            )
            .as_bytes(),
        );
    }
    list
}

pub struct ConcatResult {
    pub file_size: u64,
    pub elapsed_ms: u128,
}

/// Losslessly join MP4 video segments (`-f concat -safe 0 -c:v copy` with BT.709 VUI tagging)
/// and mux optional WAV audio.
pub fn concat_segments(
    ffmpeg: &Path,
    output: &Path,
    fps: u32,
    codec: Codec,
    audio: Option<&Path>,
    audio_bitrate: &str,
    entries: &[(PathBuf, u32)],
) -> Result<ConcatResult, String> {
    let started = Instant::now();
    if entries.is_empty() {
        return Err("concat-segments requires at least one segment".into());
    }
    let total_frames: u32 = entries.iter().map(|(_, f)| *f).sum();
    if total_frames == 0 {
        return Err("concat-segments total frame count must be > 0".into());
    }
    let detected_codec = entries
        .first()
        .and_then(|(first_path, _)| detect_video_codec(ffmpeg, first_path))
        .unwrap_or(codec);

    let list_path = partial_output_path(output).with_extension("segments.txt");
    let list_bytes = build_concat_list(fps, entries);
    std::fs::write(&list_path, &list_bytes)
        .map_err(|e| format!("failed to write concat list: {e}"))?;

    let run_concat = |with_bsf: bool, partial: &Path| -> Result<(), String> {
        let mut cmd = Command::new(ffmpeg);
        cmd.args(["-hide_banner", "-nostdin", "-y", "-loglevel", "error"])
            .args(["-f", "concat", "-safe", "0", "-i"])
            .arg(&list_path);
        if let Some(wav) = audio {
            cmd.arg("-i").arg(wav);
            cmd.args(["-map", "0:v:0", "-map", "1:a:0"]);
        } else {
            cmd.args(["-map", "0:v:0"]);
        }
        cmd.args(["-c:v", "copy"]);
        if with_bsf {
            cmd.args(["-bsf:v", bt709_vui_bsf(detected_codec)]);
        }
        if detected_codec == Codec::Hevc {
            cmd.args(["-tag:v", "hvc1"]);
        }
        if audio.is_some() {
            cmd.args(["-c:a", "aac", "-b:a", audio_bitrate]);
        }
        cmd.args(audio_truncation_args(Some(total_frames), fps));
        cmd.args(["-movflags", "+faststart"]).arg(partial);

        let out = cmd
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("failed to spawn ffmpeg concat: {e}"))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(format!("ffmpeg concat exited with {}: {}", out.status, err.trim()));
        }
        Ok(())
    };

    let result = write_output_atomically(output, |partial| match run_concat(true, partial) {
        Ok(()) => Ok(()),
        Err(_) => {
            let _ = std::fs::remove_file(partial);
            run_concat(false, partial)
        }
    });

    let _ = std::fs::remove_file(&list_path);
    result?;
    let file_size = std::fs::metadata(output)
        .map(|m| m.len())
        .map_err(|e| format!("failed to stat output: {e}"))?;
    Ok(ConcatResult {
        file_size,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_segments_matches_sse_export() {
        assert_eq!(
            split_segments(3000..6600, 4),
            vec![3000..3900, 3900..4800, 4800..5700, 5700..6600]
        );
        assert_eq!(split_segments(0..599, 4), vec![0..599]);
        assert_eq!(split_segments(0..600, 4), vec![0..300, 300..600]);
    }

    #[test]
    fn concat_list_has_exact_microsecond_durations() {
        let entries = vec![
            (PathBuf::from("seg0.mp4"), 100),
            (PathBuf::from("seg1.mp4"), 100),
            (PathBuf::from("seg2.mp4"), 101),
        ];
        let text = String::from_utf8(build_concat_list(60, &entries)).unwrap();
        let durs: Vec<&str> = text
            .lines()
            .filter_map(|l| l.strip_prefix("duration "))
            .collect();
        assert_eq!(durs, vec!["1.666667", "1.666666", "1.683334"]);
    }
}
