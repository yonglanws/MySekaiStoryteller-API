//! High-throughput frame pipe & atomic remux/transcode engine.
//! Modeled directly on SekaiStoryExporter `sse-export/src/lib.rs` (`pipe_frames`,
//! `write_frames` with dedicated writer thread & buffer recycling, atomic `.partial` rename).

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Instant;

use crate::color;
use crate::hardware::{Codec, EncoderSpec, resolve_encoder};

/// Bounded channel depth between stdin frame reader and FFmpeg stdin writer thread.
const QUEUED_FRAMES: usize = 2;

pub fn partial_output_path(output: &Path) -> PathBuf {
    match output.extension() {
        Some(ext) => output.with_extension(format!("partial.{}", ext.to_string_lossy())),
        None => output.with_extension("partial"),
    }
}

pub fn audio_truncation_args(frame_count: Option<u32>, fps: u32) -> Vec<String> {
    if let Some(frames) = frame_count.filter(|&f| f > 0)
        && fps > 0
    {
        return vec![
            "-t".to_owned(),
            format!("{:.6}", f64::from(frames) / f64::from(fps)),
        ];
    }
    Vec::new()
}

/// Atomic output write: ffmpeg writes to `<name>.partial.<ext>` and renames on success.
pub fn write_output_atomically<T>(
    output: &Path,
    write_fn: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    if let Some(parent) = output.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create output dir: {e}"))?;
    }
    let partial = partial_output_path(output);
    let _ = std::fs::remove_file(&partial);
    match write_fn(&partial) {
        Ok(val) => {
            if !partial.exists() {
                return Err(format!(
                    "encoder reported success but wrote no output: {}",
                    partial.display()
                ));
            }
            if output.exists() {
                let _ = std::fs::remove_file(output);
            }
            std::fs::rename(&partial, output)
                .map_err(|e| format!("failed to rename partial output: {e}"))?;
            Ok(val)
        }
        Err(err) => {
            let _ = std::fs::remove_file(&partial);
            Err(err)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipeFormat {
    Yuv420p,
    Rgba,
    Mjpeg,
}

impl PipeFormat {
    pub fn from_name(name: &str) -> Option<Self> {
        match name.to_ascii_lowercase().as_str() {
            "yuv420p" | "rawvideo" | "i420" => Some(Self::Yuv420p),
            "rgba" => Some(Self::Rgba),
            "mjpeg" | "jpeg" => Some(Self::Mjpeg),
            _ => None,
        }
    }
}

pub struct PipeEncodeOptions {
    pub ffmpeg: PathBuf,
    pub output: PathBuf,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub format: PipeFormat,
    pub codec: Codec,
    pub encoder_choice: String,
    pub crf: u32,
    pub preset: Option<String>,
    pub gop: Option<u32>,
    pub faststart: bool,
    pub rust_yuv_convert: bool,
}

pub struct PipeEncodeResult {
    pub frames: u64,
    pub file_size: u64,
    pub encoder: String,
    pub elapsed_ms: u128,
}

/// Dedicated background frame writer (exact pattern of `sse-export::write_frames`):
/// drains buffers to FFmpeg stdin in order and returns each buffer to the reader for zero-alloc reuse.
fn write_frames_loop(
    mut pipe: impl Write,
    rx: mpsc::Receiver<Vec<u8>>,
    recycle_tx: mpsc::Sender<Vec<u8>>,
) -> io::Result<u64> {
    let mut written_chunks: u64 = 0;
    for buf in rx {
        pipe.write_all(&buf)?;
        written_chunks += 1;
        let _ = recycle_tx.send(buf);
    }
    pipe.flush()?;
    Ok(written_chunks)
}

/// Streams frames from stdin into a background-threaded FFmpeg encoder with buffer recycling.
pub fn run_pipe_encode(opts: &PipeEncodeOptions) -> Result<PipeEncodeResult, String> {
    color::check_encode_size(opts.width, opts.height)?;
    let started = Instant::now();
    let gop = opts.gop.or(Some(opts.fps.saturating_mul(4)));
    let spec = resolve_encoder(
        &opts.ffmpeg,
        &opts.encoder_choice,
        opts.codec,
        opts.crf,
        opts.preset.as_deref(),
        gop,
    );

    let convert_in_rust = opts.format == PipeFormat::Rgba && opts.rust_yuv_convert;
    let ffmpeg_receives_yuv = opts.format == PipeFormat::Yuv420p || convert_in_rust;

    let filters = spec.filter_chain(!ffmpeg_receives_yuv, None);
    let mut cmd = Command::new(&opts.ffmpeg);
    cmd.args(["-hide_banner", "-nostdin", "-loglevel", "error", "-nostats", "-y"])
        .args(spec.global_args());

    match opts.format {
        PipeFormat::Yuv420p => {
            cmd.args([
                "-f",
                "rawvideo",
                "-pix_fmt",
                "yuv420p",
                "-s",
                &format!("{}x{}", opts.width, opts.height),
            ])
            .args(color::tag_args())
            .args(["-r", &opts.fps.to_string(), "-i", "pipe:0"]);
        }
        PipeFormat::Rgba if convert_in_rust => {
            cmd.args([
                "-f",
                "rawvideo",
                "-pix_fmt",
                "yuv420p",
                "-s",
                &format!("{}x{}", opts.width, opts.height),
            ])
            .args(color::tag_args())
            .args(["-r", &opts.fps.to_string(), "-i", "pipe:0"]);
        }
        PipeFormat::Rgba => {
            cmd.args([
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgba",
                "-s",
                &format!("{}x{}", opts.width, opts.height),
                "-r",
                &opts.fps.to_string(),
                "-i",
                "pipe:0",
            ]);
        }
        PipeFormat::Mjpeg => {
            cmd.args([
                "-f",
                "image2pipe",
                "-vcodec",
                "mjpeg",
                "-framerate",
                &opts.fps.to_string(),
                "-i",
                "pipe:0",
            ]);
        }
    }

    cmd.args(spec.output_args(&filters));
    if opts.faststart {
        cmd.args(["-movflags", "+faststart"]);
    }

    let mut frame_count: u64 = 0;
    write_output_atomically(&opts.output, |partial| {
        cmd.arg(partial)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn ffmpeg pipe encoder: {e}"))?;
        let child_stdin = child
            .stdin
            .take()
            .ok_or_else(|| "ffmpeg child stdin unavailable".to_owned())?;

        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(QUEUED_FRAMES);
        let (recycle_tx, recycle_rx) = mpsc::channel::<Vec<u8>>();
        let writer = std::thread::Builder::new()
            .name("mss-export-writer".into())
            .spawn(move || write_frames_loop(child_stdin, rx, recycle_tx))
            .map_err(|e| format!("failed to spawn writer thread: {e}"))?;

        let mut stdin = io::stdin().lock();
        let read_res: Result<(), String> = match opts.format {
            PipeFormat::Yuv420p => {
                let frame_bytes = (opts.width as usize * opts.height as usize * 3) / 2;
                let mut spare: Vec<Vec<u8>> = Vec::new();
                loop {
                    while let Ok(b) = recycle_rx.try_recv() {
                        spare.push(b);
                    }
                    let mut buf = spare.pop().unwrap_or_else(|| vec![0u8; frame_bytes]);
                    if buf.len() != frame_bytes {
                        buf.resize(frame_bytes, 0);
                    }
                    let n = read_exact_or_eof(&mut stdin, &mut buf)
                        .map_err(|e| format!("stdin read error: {e}"))?;
                    if n == 0 {
                        break;
                    }
                    if n != frame_bytes {
                        return Err(format!(
                            "truncated rawvideo yuv420p frame: got {n} bytes, expected {frame_bytes}"
                        ));
                    }
                    frame_count += 1;
                    if tx.send(buf).is_err() {
                        break;
                    }
                }
                Ok(())
            }
            PipeFormat::Rgba => {
                let rgba_bytes = opts.width as usize * opts.height as usize * 4;
                let mut rgba_buf = vec![0u8; rgba_bytes];
                let mut spare: Vec<Vec<u8>> = Vec::new();
                loop {
                    while let Ok(b) = recycle_rx.try_recv() {
                        spare.push(b);
                    }
                    let n = read_exact_or_eof(&mut stdin, &mut rgba_buf)
                        .map_err(|e| format!("stdin read error: {e}"))?;
                    if n == 0 {
                        break;
                    }
                    if n != rgba_bytes {
                        return Err(format!(
                            "truncated rawvideo rgba frame: got {n} bytes, expected {rgba_bytes}"
                        ));
                    }
                    frame_count += 1;
                    let mut out_buf = spare.pop().unwrap_or_default();
                    if convert_in_rust {
                        color::rgba_to_yuv420p_bt709_tv(
                            &rgba_buf,
                            opts.width,
                            opts.height,
                            &mut out_buf,
                        )?;
                    } else {
                        out_buf.clear();
                        out_buf.extend_from_slice(&rgba_buf);
                    }
                    if tx.send(out_buf).is_err() {
                        break;
                    }
                }
                Ok(())
            }
            PipeFormat::Mjpeg => {
                let mut spare: Vec<Vec<u8>> = Vec::new();
                loop {
                    while let Ok(b) = recycle_rx.try_recv() {
                        spare.push(b);
                    }
                    let mut buf = spare.pop().unwrap_or_else(|| vec![0u8; 256 * 1024]);
                    buf.resize(256 * 1024, 0);
                    let n = stdin
                        .read(&mut buf)
                        .map_err(|e| format!("stdin read error: {e}"))?;
                    if n == 0 {
                        break;
                    }
                    buf.truncate(n);
                    frame_count += 1;
                    if tx.send(buf).is_err() {
                        break;
                    }
                }
                Ok(())
            }
        };

        drop(tx);
        let writer_res = writer
            .join()
            .unwrap_or_else(|_| Err(io::Error::other("writer thread panicked")));

        if read_res.is_err() || writer_res.is_err() {
            let _ = child.kill();
        }
        let output = child
            .wait_with_output()
            .map_err(|e| format!("failed to wait on ffmpeg: {e}"))?;

        read_res?;
        writer_res.map_err(|e| format!("ffmpeg stdin write error: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "ffmpeg pipe-encode exited with {}: {}",
                output.status,
                stderr.trim()
            ));
        }
        Ok(())
    })?;

    let file_size = std::fs::metadata(&opts.output)
        .map(|m| m.len())
        .map_err(|e| format!("failed to stat output: {e}"))?;
    Ok(PipeEncodeResult {
        frames: frame_count,
        file_size,
        encoder: spec.label(),
        elapsed_ms: started.elapsed().as_millis(),
    })
}

fn read_exact_or_eof(reader: &mut impl Read, buf: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

pub fn bt709_vui_bsf(codec: Codec) -> &'static str {
    match codec {
        Codec::H264 => {
            "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0"
        }
        Codec::Hevc => {
            "hevc_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0"
        }
    }
}

/// Detect video stream codec (`h264` or `hevc`) via `ffmpeg -hide_banner -i <video>`.
pub fn detect_video_codec(ffmpeg: &Path, video: &Path) -> Option<Codec> {
    let out = Command::new(ffmpeg)
        .args(["-hide_banner", "-i"])
        .arg(video)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .ok()?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    for line in stderr.lines() {
        if let Some(pos) = line.find("Video:") {
            let after = line[pos + 6..].trim_start().to_ascii_lowercase();
            if after.starts_with("hevc") || after.starts_with("h265") {
                return Some(Codec::Hevc);
            }
            if after.starts_with("h264") || after.starts_with("avc") {
                return Some(Codec::H264);
            }
        }
    }
    None
}

pub struct RemuxOptions {
    pub ffmpeg: PathBuf,
    pub video: PathBuf,
    pub audio: Option<PathBuf>,
    pub output: PathBuf,
    pub audio_bitrate: String,
    pub frame_count: Option<u32>,
    pub fps: u32,
    pub start_frame: u32,
    pub transcode: bool,
    pub codec: Codec,
    pub input_codec: Option<Codec>,
    pub encoder_choice: String,
    pub crf: u32,
    pub preset: Option<String>,
    pub width: u32,
    pub height: u32,
    pub input_width: u32,
    pub input_height: u32,
    pub gop: Option<u32>,
    /// If > 0 and input video exceeds this average Mbps, automatically compress with CRF.
    pub max_mbps: f64,
}

pub struct RemuxResult {
    pub file_size: u64,
    pub transcoded: bool,
    pub encoder: String,
    pub elapsed_ms: u128,
}

/// Atomic remux (stream-copy + BT.709 VUI bitstream tagging) or BT.709/tv CRF transcode
/// (with hardware -> software automatic fallback).
pub fn run_remux(opts: &RemuxOptions) -> Result<RemuxResult, String> {
    let started = Instant::now();
    let input_bytes = std::fs::metadata(&opts.video)
        .map(|m| m.len())
        .map_err(|e| format!("input video unreadable: {e}"))?;

    let mut need_transcode = opts.transcode;
    if !need_transcode
        && opts.max_mbps > 0.0
        && let Some(frames) = opts.frame_count.filter(|&f| f > 0)
        && opts.fps > 0
    {
        let duration_sec = f64::from(frames) / f64::from(opts.fps);
        if duration_sec >= 2.0 {
            let actual_mbps = (input_bytes as f64 * 8.0) / (duration_sec * 1_000_000.0);
            if actual_mbps > opts.max_mbps {
                need_transcode = true;
            }
        }
    }

    let has_audio = opts.audio.as_ref().is_some_and(|p| p.exists());
    let truncation = audio_truncation_args(opts.frame_count, opts.fps);
    let mut used_encoder = "copy".to_owned();

    if !need_transcode {
        let detected_codec = opts
            .input_codec
            .or_else(|| detect_video_codec(&opts.ffmpeg, &opts.video));
        let run_copy = |with_bsf: bool, partial: &Path| -> Result<(), String> {
            let mut cmd = Command::new(&opts.ffmpeg);
            cmd.args(["-hide_banner", "-nostdin", "-y", "-loglevel", "error"])
                .arg("-i")
                .arg(&opts.video);
            if let Some(audio_path) = opts.audio.as_ref().filter(|_| has_audio) {
                if opts.start_frame > 0 && opts.fps > 0 {
                    cmd.args([
                        "-ss",
                        &format!("{:.6}", f64::from(opts.start_frame) / f64::from(opts.fps)),
                    ]);
                }
                cmd.arg("-i").arg(audio_path);
                cmd.args(["-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy"]);
                if with_bsf && let Some(stream_codec) = detected_codec {
                    cmd.args(["-bsf:v", bt709_vui_bsf(stream_codec)]);
                    if stream_codec == Codec::Hevc {
                        cmd.args(["-tag:v", "hvc1"]);
                    }
                }
                cmd.args(["-c:a", "aac", "-b:a", &opts.audio_bitrate]);
            } else {
                cmd.args(["-c:v", "copy"]);
                if with_bsf && let Some(stream_codec) = detected_codec {
                    cmd.args(["-bsf:v", bt709_vui_bsf(stream_codec)]);
                    if stream_codec == Codec::Hevc {
                        cmd.args(["-tag:v", "hvc1"]);
                    }
                }
            }
            cmd.args(&truncation)
                .args(["-movflags", "+faststart"])
                .arg(partial);
            let out = cmd
                .stdin(Stdio::null())
                .output()
                .map_err(|e| format!("failed to spawn ffmpeg remux: {e}"))?;
            if !out.status.success() {
                let err = String::from_utf8_lossy(&out.stderr);
                return Err(format!("ffmpeg remux exited with {}: {}", out.status, err.trim()));
            }
            Ok(())
        };

        write_output_atomically(&opts.output, |partial| {
            if detected_codec.is_some() {
                match run_copy(true, partial) {
                    Ok(()) => {
                        used_encoder = "copy+bt709".to_owned();
                        Ok(())
                    }
                    Err(_) => {
                        let _ = std::fs::remove_file(partial);
                        run_copy(false, partial)
                    }
                }
            } else {
                run_copy(false, partial)
            }
        })?;
    } else {
        color::check_encode_size(opts.width, opts.height)?;
        let gop = opts.gop.or(Some(opts.fps.saturating_mul(4)));
        let primary = resolve_encoder(
            &opts.ffmpeg,
            &opts.encoder_choice,
            opts.codec,
            opts.crf,
            opts.preset.as_deref(),
            gop,
        );
        let resize = if opts.input_width != opts.width || opts.input_height != opts.height {
            Some((opts.width, opts.height))
        } else {
            None
        };

        let run_once = |spec: &EncoderSpec, partial: &Path| -> Result<(), String> {
            let filters = spec.filter_chain(true, resize);
            let mut cmd = Command::new(&opts.ffmpeg);
            cmd.args(["-hide_banner", "-nostdin", "-y", "-loglevel", "error"])
                .args(spec.global_args())
                .arg("-i")
                .arg(&opts.video);
            if let Some(audio_path) = opts.audio.as_ref().filter(|_| has_audio) {
                if opts.start_frame > 0 && opts.fps > 0 {
                    cmd.args([
                        "-ss",
                        &format!("{:.6}", f64::from(opts.start_frame) / f64::from(opts.fps)),
                    ]);
                }
                cmd.arg("-i").arg(audio_path);
            }
            cmd.args(spec.output_args(&filters));
            if has_audio {
                cmd.args([
                    "-c:a",
                    "aac",
                    "-b:a",
                    &opts.audio_bitrate,
                    "-map",
                    "0:v:0",
                    "-map",
                    "1:a:0",
                ]);
            }
            cmd.args(["-r", &opts.fps.to_string()])
                .args(&truncation)
                .args(["-movflags", "+faststart"])
                .arg(partial);

            let out = cmd
                .stdin(Stdio::null())
                .output()
                .map_err(|e| format!("failed to spawn ffmpeg transcode: {e}"))?;
            if !out.status.success() {
                let err = String::from_utf8_lossy(&out.stderr);
                return Err(format!(
                    "ffmpeg transcode ({}) exited with {}: {}",
                    spec.label(),
                    out.status,
                    err.trim()
                ));
            }
            Ok(())
        };

        write_output_atomically(&opts.output, |partial| match run_once(&primary, partial) {
            Ok(()) => {
                used_encoder = primary.label();
                Ok(())
            }
            Err(_primary_err) => {
                let fallback = primary.fallback_software();
                run_once(&fallback, partial)?;
                used_encoder = fallback.label();
                Ok(())
            }
        })?;
    }

    let file_size = std::fs::metadata(&opts.output)
        .map(|m| m.len())
        .map_err(|e| format!("failed to stat output: {e}"))?;
    Ok(RemuxResult {
        file_size,
        transcoded: need_transcode,
        encoder: used_encoder,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writer_loop_preserves_order_and_recycles_buffers() {
        let (tx, rx) = mpsc::sync_channel(2);
        let (rtx, rrx) = mpsc::channel();
        tx.send(vec![1u8, 2]).unwrap();
        tx.send(vec![3u8, 4]).unwrap();
        drop(tx);
        let mut sink = Vec::new();
        let count = write_frames_loop(&mut sink, rx, rtx).unwrap();
        assert_eq!(count, 2);
        assert_eq!(sink, vec![1, 2, 3, 4]);
        let recycled: Vec<Vec<u8>> = rrx.iter().collect();
        assert_eq!(recycled, vec![vec![1, 2], vec![3, 4]]);
    }

    #[test]
    fn partial_path_keeps_extension() {
        assert_eq!(
            partial_output_path(Path::new("out/ep.mp4")),
            PathBuf::from("out/ep.partial.mp4")
        );
    }

    #[test]
    fn bt709_vui_bsf_matches_h264_and_hevc() {
        assert_eq!(
            bt709_vui_bsf(Codec::H264),
            "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0"
        );
        assert_eq!(
            bt709_vui_bsf(Codec::Hevc),
            "hevc_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0"
        );
    }
}
