//! High-throughput frame pipe (in-process session + CLI stdin) & atomic remux/transcode engine.
//! Features:
//! - Bounded ring-buffer channel with zero-alloc buffer recycling
//! - Rayon BT.709 RGBA -> YUV420p conversion
//! - Duplicate/static-frame skip & explicit `repeat_last_frame(count)` without re-converting RGBA->YUV
//! - Intel QSV `-low_power 1` VDENC fast path with automatic standard-QSV & software fallback

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::JoinHandle;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::color;
use crate::hardware::{Codec, EncoderSpec, resolve_encoder};

const QUEUED_FRAMES: usize = 3;

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

#[derive(Debug, Clone)]
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
    pub low_power: bool,
    pub dedup: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipeEncodeResult {
    pub ok: bool,
    pub output_path: String,
    pub frames: u64,
    pub deduped_frames: u64,
    pub file_size: u64,
    pub encoder: String,
    pub elapsed_ms: u128,
}

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

#[derive(Clone)]
pub struct PipeAbortHandle {
    child: Arc<Mutex<Option<Child>>>,
    aborted: Arc<AtomicBool>,
}

impl PipeAbortHandle {
    pub fn for_test(aborted: Arc<AtomicBool>) -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            aborted,
        }
    }

    pub fn abort_now(&self) {
        self.aborted.store(true, Ordering::Release);
        if let Ok(mut guard) = self.child.lock()
            && let Some(ref mut child) = *guard
        {
            let _ = child.kill();
        }
    }

    pub fn is_aborted(&self) -> bool {
        self.aborted.load(Ordering::Acquire)
    }
}

/// Reusable in-process FFmpeg streaming pipe session with bounded ring-buffer recycling,
/// rayon RGBA->BT.709 conversion, and zero-conversion duplicate/static-frame repeat.
pub struct PipeSession {
    output: PathBuf,
    partial: PathBuf,
    format: PipeFormat,
    width: u32,
    height: u32,
    convert_in_rust: bool,
    dedup_default: bool,
    encoder_label: String,
    started: Instant,
    child: Arc<Mutex<Option<Child>>>,
    aborted: Arc<AtomicBool>,
    tx: Option<mpsc::SyncSender<Vec<u8>>>,
    recycle_rx: mpsc::Receiver<Vec<u8>>,
    spare: Vec<Vec<u8>>,
    writer: Option<JoinHandle<io::Result<u64>>>,
    frames: u64,
    deduped_frames: u64,
    last_in_hash: Option<u64>,
    last_in_frame: Vec<u8>,
    last_out_frame: Vec<u8>,
}

impl PipeSession {
    pub fn open(opts: &PipeEncodeOptions) -> Result<Self, String> {
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
            opts.low_power,
        );

        let convert_in_rust = opts.format == PipeFormat::Rgba && opts.rust_yuv_convert;
        let ffmpeg_receives_yuv = opts.format == PipeFormat::Yuv420p || convert_in_rust;
        let filters = spec.filter_chain(!ffmpeg_receives_yuv, None);

        if let Some(parent) = opts.output.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create output dir: {e}"))?;
        }
        let partial = partial_output_path(&opts.output);
        let _ = std::fs::remove_file(&partial);

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
        cmd.arg(&partial)
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

        Ok(Self {
            output: opts.output.clone(),
            partial,
            format: opts.format,
            width: opts.width,
            height: opts.height,
            convert_in_rust,
            dedup_default: opts.dedup,
            encoder_label: spec.label(),
            started,
            child: Arc::new(Mutex::new(Some(child))),
            aborted: Arc::new(AtomicBool::new(false)),
            tx: Some(tx),
            recycle_rx,
            spare: Vec::with_capacity(QUEUED_FRAMES + 1),
            writer: Some(writer),
            frames: 0,
            deduped_frames: 0,
            last_in_hash: None,
            last_in_frame: Vec::new(),
            last_out_frame: Vec::new(),
        })
    }

    pub fn abort_handle(&self) -> PipeAbortHandle {
        PipeAbortHandle {
            child: Arc::clone(&self.child),
            aborted: Arc::clone(&self.aborted),
        }
    }

    pub fn frame_count(&self) -> u64 {
        self.frames
    }

    pub fn deduped_frame_count(&self) -> u64 {
        self.deduped_frames
    }

    fn take_recycled_buf(&mut self) -> Vec<u8> {
        while let Ok(b) = self.recycle_rx.try_recv() {
            self.spare.push(b);
        }
        self.spare.pop().unwrap_or_default()
    }

    fn enqueue_out_buf(&mut self, buf: Vec<u8>) -> Result<(), String> {
        if self.aborted.load(Ordering::Acquire) {
            return Err("pipe session aborted".to_owned());
        }
        let tx = self
            .tx
            .as_ref()
            .ok_or_else(|| "pipe session already finished".to_owned())?;
        tx.send(buf)
            .map_err(|_| "ffmpeg pipe writer closed unexpectedly".to_owned())
    }

    pub fn repeat_last_frame(&mut self, count: u32) -> Result<(), String> {
        if self.aborted.load(Ordering::Acquire) {
            return Err("pipe session aborted".to_owned());
        }
        if count == 0 {
            return Ok(());
        }
        if self.last_out_frame.is_empty() {
            return Err("cannot repeat_last_frame before any frame was written".into());
        }
        for _ in 0..count {
            let mut buf = self.take_recycled_buf();
            buf.clear();
            buf.extend_from_slice(&self.last_out_frame);
            self.enqueue_out_buf(buf)?;
            self.frames += 1;
            self.deduped_frames += 1;
        }
        Ok(())
    }

    /// Push one frame (or chunk of rawvideo frames, or MJPEG frame(s)) with optional duplicate-skip
    /// and repeat count.
    pub fn write_chunk(
        &mut self,
        data: &[u8],
        frames_in_chunk: Option<u32>,
        repeat_count: u32,
        dedup_override: Option<bool>,
    ) -> Result<(), String> {
        if self.aborted.load(Ordering::Acquire) {
            return Err("pipe session aborted".to_owned());
        }
        if data.is_empty() {
            return Ok(());
        }
        let repeat = repeat_count.max(1);
        let dedup = dedup_override.unwrap_or(self.dedup_default);

        match self.format {
            PipeFormat::Yuv420p => {
                let frame_bytes = (self.width as usize * self.height as usize * 3) / 2;
                if data.len() % frame_bytes != 0 {
                    return Err(format!(
                        "Invalid yuv420p chunk: {} bytes is not a multiple of {frame_bytes}",
                        data.len()
                    ));
                }
                let n_frames = (data.len() / frame_bytes) as u64;
                if n_frames == 1 && (dedup || repeat > 1) {
                    self.last_out_frame.clear();
                    self.last_out_frame.extend_from_slice(data);
                }
                for r in 0..repeat {
                    let mut buf = self.take_recycled_buf();
                    buf.clear();
                    buf.extend_from_slice(data);
                    self.enqueue_out_buf(buf)?;
                    self.frames += n_frames;
                    if r > 0 {
                        self.deduped_frames += n_frames;
                    }
                }
                Ok(())
            }
            PipeFormat::Rgba => {
                let rgba_bytes = self.width as usize * self.height as usize * 4;
                if data.len() % rgba_bytes != 0 {
                    return Err(format!(
                        "Invalid rgba chunk: {} bytes is not a multiple of {rgba_bytes}",
                        data.len()
                    ));
                }
                for frame_slice in data.chunks_exact(rgba_bytes) {
                    if self.convert_in_rust {
                        let hash = if dedup {
                            Some(color::fast_frame_hash(frame_slice))
                        } else {
                            None
                        };
                        let is_dup = dedup
                            && hash == self.last_in_hash
                            && !self.last_out_frame.is_empty()
                            && self.last_in_frame == frame_slice;

                        if is_dup {
                            for _ in 0..repeat {
                                let mut buf = self.take_recycled_buf();
                                buf.clear();
                                buf.extend_from_slice(&self.last_out_frame);
                                self.enqueue_out_buf(buf)?;
                                self.frames += 1;
                                self.deduped_frames += 1;
                            }
                            continue;
                        }

                        let mut out_buf = self.take_recycled_buf();
                        color::rgba_to_yuv420p_bt709_tv(
                            frame_slice,
                            self.width,
                            self.height,
                            &mut out_buf,
                        )?;
                        if dedup || repeat > 1 {
                            self.last_in_hash = hash;
                            self.last_in_frame.clear();
                            self.last_in_frame.extend_from_slice(frame_slice);
                            self.last_out_frame.clear();
                            self.last_out_frame.extend_from_slice(&out_buf);
                        }
                        self.enqueue_out_buf(out_buf)?;
                        self.frames += 1;
                        if repeat > 1 {
                            self.repeat_last_frame(repeat - 1)?;
                        }
                    } else {
                        for r in 0..repeat {
                            let mut buf = self.take_recycled_buf();
                            buf.clear();
                            buf.extend_from_slice(frame_slice);
                            self.enqueue_out_buf(buf)?;
                            self.frames += 1;
                            if r > 0 {
                                self.deduped_frames += 1;
                            }
                        }
                    }
                }
                Ok(())
            }
            PipeFormat::Mjpeg => {
                let n = u64::from(frames_in_chunk.unwrap_or(1));
                if repeat > 1 || dedup {
                    self.last_out_frame.clear();
                    self.last_out_frame.extend_from_slice(data);
                }
                for r in 0..repeat {
                    let mut buf = self.take_recycled_buf();
                    buf.clear();
                    buf.extend_from_slice(data);
                    self.enqueue_out_buf(buf)?;
                    self.frames += n;
                    if r > 0 {
                        self.deduped_frames += n;
                    }
                }
                Ok(())
            }
        }
    }

    pub fn finish(mut self) -> Result<PipeEncodeResult, String> {
        self.tx.take();
        let writer_res = self
            .writer
            .take()
            .map(|w| {
                w.join()
                    .unwrap_or_else(|_| Err(io::Error::other("writer thread panicked")))
            })
            .unwrap_or(Ok(0));

        let mut child = self
            .child
            .lock()
            .ok()
            .and_then(|mut g| g.take())
            .ok_or_else(|| "ffmpeg child missing".to_owned())?;
        if self.aborted.load(Ordering::Acquire) || writer_res.is_err() {
            let _ = child.kill();
        }
        let output = child
            .wait_with_output()
            .map_err(|e| format!("failed to wait on ffmpeg: {e}"))?;

        if self.aborted.load(Ordering::Acquire) {
            let _ = std::fs::remove_file(&self.partial);
            return Err("pipe session aborted".to_owned());
        }

        if let Err(e) = writer_res {
            let _ = std::fs::remove_file(&self.partial);
            return Err(format!("ffmpeg stdin write error: {e}"));
        }
        if !output.status.success() {
            let _ = std::fs::remove_file(&self.partial);
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "ffmpeg pipe-encode exited with {}: {}",
                output.status,
                stderr.trim()
            ));
        }
        if !self.partial.exists() {
            return Err(format!(
                "encoder reported success but wrote no output: {}",
                self.partial.display()
            ));
        }
        if self.output.exists() {
            let _ = std::fs::remove_file(&self.output);
        }
        std::fs::rename(&self.partial, &self.output)
            .map_err(|e| format!("failed to rename partial output: {e}"))?;

        let file_size = std::fs::metadata(&self.output)
            .map(|m| m.len())
            .map_err(|e| format!("failed to stat output: {e}"))?;
        Ok(PipeEncodeResult {
            ok: true,
            output_path: self.output.to_string_lossy().into_owned(),
            frames: self.frames,
            deduped_frames: self.deduped_frames,
            file_size,
            encoder: self.encoder_label.clone(),
            elapsed_ms: self.started.elapsed().as_millis(),
        })
    }

    pub fn abort(mut self) {
        self.aborted.store(true, Ordering::Release);
        self.tx.take();
        if let Some(mut child) = self.child.lock().ok().and_then(|mut g| g.take()) {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(w) = self.writer.take() {
            let _ = w.join();
        }
        let _ = std::fs::remove_file(&self.partial);
        let _ = std::fs::remove_file(&self.output);
    }
}

impl Drop for PipeSession {
    fn drop(&mut self) {
        self.tx.take();
        if let Some(mut child) = self.child.lock().ok().and_then(|mut g| g.take()) {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(w) = self.writer.take() {
            let _ = w.join();
        }
        if self.aborted.load(Ordering::Acquire) {
            let _ = std::fs::remove_file(&self.partial);
            let _ = std::fs::remove_file(&self.output);
        }
    }
}

/// CLI stdin pipe encoder backed by `PipeSession`.
pub fn run_pipe_encode(opts: &PipeEncodeOptions) -> Result<PipeEncodeResult, String> {
    let mut session = PipeSession::open(opts)?;
    let mut stdin = io::stdin().lock();

    let read_res: Result<(), String> = match opts.format {
        PipeFormat::Yuv420p => {
            let frame_bytes = (opts.width as usize * opts.height as usize * 3) / 2;
            let mut buf = vec![0u8; frame_bytes];
            loop {
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
                session.write_chunk(&buf, Some(1), 1, None)?;
            }
            Ok(())
        }
        PipeFormat::Rgba => {
            let rgba_bytes = opts.width as usize * opts.height as usize * 4;
            let mut buf = vec![0u8; rgba_bytes];
            loop {
                let n = read_exact_or_eof(&mut stdin, &mut buf)
                    .map_err(|e| format!("stdin read error: {e}"))?;
                if n == 0 {
                    break;
                }
                if n != rgba_bytes {
                    return Err(format!(
                        "truncated rawvideo rgba frame: got {n} bytes, expected {rgba_bytes}"
                    ));
                }
                session.write_chunk(&buf, Some(1), 1, None)?;
            }
            Ok(())
        }
        PipeFormat::Mjpeg => {
            let mut buf = vec![0u8; 256 * 1024];
            loop {
                let n = stdin
                    .read(&mut buf)
                    .map_err(|e| format!("stdin read error: {e}"))?;
                if n == 0 {
                    break;
                }
                session.write_chunk(&buf[..n], Some(1), 1, Some(false))?;
            }
            Ok(())
        }
    };

    if let Err(err) = read_res {
        session.abort();
        return Err(err);
    }
    session.finish()
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

#[derive(Debug, Clone)]
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
    pub max_mbps: f64,
    pub low_power: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemuxResult {
    pub ok: bool,
    pub output_path: String,
    pub file_size: u64,
    pub transcoded: bool,
    pub encoder: String,
    pub elapsed_ms: u128,
}

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
                return Err(format!(
                    "ffmpeg remux exited with {}: {}",
                    out.status,
                    err.trim()
                ));
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
            opts.low_power,
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
            Err(first_err) => {
                let second = primary.fallback_spec();
                let sw = primary.fallback_software();
                if second != primary && second != sw && run_once(&second, partial).is_ok() {
                    used_encoder = second.label();
                    return Ok(());
                }
                if sw != primary {
                    run_once(&sw, partial)?;
                    used_encoder = sw.label();
                    return Ok(());
                }
                Err(first_err)
            }
        })?;
    }

    let file_size = std::fs::metadata(&opts.output)
        .map(|m| m.len())
        .map_err(|e| format!("failed to stat output: {e}"))?;
    Ok(RemuxResult {
        ok: true,
        output_path: opts.output.to_string_lossy().into_owned(),
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

    #[test]
    fn non_qsv_lp_fallback_spec_equals_fallback_software_avoiding_duplicate_pass() {
        use crate::hardware::{Backend, EncoderSpec};
        let nvenc = EncoderSpec::Hardware {
            backend: Backend::Nvenc,
            codec: Codec::H264,
            crf: 23,
            gop: Some(60),
            low_power: true,
        };
        assert_eq!(nvenc.fallback_spec(), nvenc.fallback_software());

        let qsv_lp = EncoderSpec::Hardware {
            backend: Backend::Qsv,
            codec: Codec::Hevc,
            crf: 27,
            gop: Some(120),
            low_power: true,
        };
        assert_ne!(qsv_lp.fallback_spec(), qsv_lp.fallback_software());
    }
}
