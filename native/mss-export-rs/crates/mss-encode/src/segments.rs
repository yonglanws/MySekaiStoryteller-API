//! Lossless ffconcat segment joining with BT.709 VUI tagging and optional AAC audio mux.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Instant;

use mss_core::segments::build_concat_list;
use serde::{Deserialize, Serialize};

use crate::hardware::Codec;
use crate::pipe::{
    audio_truncation_args, bt709_vui_bsf, detect_video_codec, partial_output_path,
    write_output_atomically,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConcatResult {
    pub ok: bool,
    pub output_path: String,
    pub file_size: u64,
    pub segments: usize,
    pub elapsed_ms: u128,
}

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
            return Err(format!(
                "ffmpeg concat exited with {}: {}",
                out.status,
                err.trim()
            ));
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
        ok: true,
        output_path: output.to_string_lossy().into_owned(),
        file_size,
        segments: entries.len(),
        elapsed_ms: started.elapsed().as_millis(),
    })
}
