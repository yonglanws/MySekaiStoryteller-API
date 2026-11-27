//! In-process NAPI-RS native addon (`mss-export-napi.node`) exposing:
//! - `version`, `probeEncoders`, `planSegments`, `bakeStoryPlan`, `analyzeStaticSpans`
//! - `computeLipSyncFromPcm`, `computeLipSyncFromFile`, `computeLipSyncFromBytes`
//! - Async libuv worker tasks: `mixAudioPlan`, `mixWav`, `runRemux`, `concatSegments`
//! - Streaming pipe session: `openPipeSession`, `writePipeFrame`, `repeatPipeFrame`, `finishPipeSession`, `abortPipeSession`
//! - Local Rust binary WebSocket bridge: `startBridgeServer`, `getBridgeServerInfo`, `stopBridgeServer`

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use mss_audio::{
    AudioMixPlan, LipSyncEnvelope, MixTrack, build_lip_sync_envelope, decode_audio_bytes,
    decode_audio_file, mix_audio_plan, mix_tracks_to_wav,
};
use mss_bridge::{BridgeServer, BridgeStartOptions, start_bridge_server as start_bridge};
use mss_core::{
    StoryPlan, StoryPlanInput, StoryPlanWithSpans, analyze_static_spans,
    bake_story_plan as core_bake_story_plan, split_segments,
};
use mss_encode::pipe::PipeAbortHandle;
use mss_encode::{
    Codec, PipeEncodeOptions, PipeFormat, PipeSession, RemuxOptions, available_hardware_detailed,
    concat_segments as encode_concat_segments, run_remux as encode_run_remux,
};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::Deserialize;

const VERSION: &str = env!("CARGO_PKG_VERSION");

static NEXT_SESSION_ID: AtomicU32 = AtomicU32::new(1);

struct PipeSessionEntry {
    session: Mutex<Option<PipeSession>>,
    abort: PipeAbortHandle,
}

fn pipe_sessions() -> &'static Mutex<HashMap<u32, Arc<PipeSessionEntry>>> {
    static MAP: OnceLock<Mutex<HashMap<u32, Arc<PipeSessionEntry>>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn bridge_slot() -> &'static Mutex<Option<BridgeServer>> {
    static SLOT: OnceLock<Mutex<Option<BridgeServer>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn to_napi_err(msg: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(msg.to_string())
}

#[napi(object)]
pub struct LipSyncJsResult {
    pub values: Float32Array,
    pub frame_ms: f64,
    pub duration_ms: f64,
    pub audio_duration_ms: f64,
    pub release_step: i32,
    pub target_value_scale: f64,
    pub pow_k: f64,
}

impl From<LipSyncEnvelope> for LipSyncJsResult {
    fn from(env: LipSyncEnvelope) -> Self {
        Self {
            values: Float32Array::new(env.values),
            frame_ms: env.frame_ms,
            duration_ms: env.duration_ms,
            audio_duration_ms: env.audio_duration_ms,
            release_step: env.release_step,
            target_value_scale: env.target_value_scale,
            pow_k: env.pow_k,
        }
    }
}

#[napi]
pub fn version() -> String {
    VERSION.to_owned()
}

#[napi]
pub fn probe_encoders(ffmpeg_path: String, codec: Option<String>) -> Result<String> {
    let c = match codec.as_deref() {
        Some(raw) => Codec::from_name(raw).ok_or_else(|| to_napi_err(format!("unknown codec: {raw}")))?,
        None => Codec::Hevc,
    };
    let found = available_hardware_detailed(Path::new(&ffmpeg_path), c);
    serde_json::to_string(&found).map_err(to_napi_err)
}

#[napi]
pub fn plan_segments(start_frame: u32, end_frame: u32, jobs: u32) -> Result<String> {
    let parts = split_segments(start_frame..end_frame, jobs.max(1));
    let segs: Vec<_> = parts
        .into_iter()
        .map(|r| serde_json::json!({ "start": r.start, "end": r.end }))
        .collect();
    serde_json::to_string(&segs).map_err(to_napi_err)
}

#[napi]
pub fn bake_story_plan(input_json: String) -> Result<String> {
    let input: StoryPlanInput = serde_json::from_str(&input_json).map_err(to_napi_err)?;
    let plan = core_bake_story_plan(&input.snippets, &input.timeline, &input.options);
    let static_spans = analyze_static_spans(&plan);
    serde_json::to_string(&StoryPlanWithSpans { plan, static_spans }).map_err(to_napi_err)
}

#[napi]
pub fn analyze_static_spans_json(plan_json: String) -> Result<String> {
    let plan: StoryPlan = serde_json::from_str(&plan_json).map_err(to_napi_err)?;
    let spans = analyze_static_spans(&plan);
    serde_json::to_string(&spans).map_err(to_napi_err)
}

#[napi]
pub fn compute_lip_sync_from_pcm(
    samples: Float32Array,
    sample_rate: u32,
    channels: u32,
    target_value_scale: Option<f64>,
) -> Result<LipSyncJsResult> {
    let ch = channels.max(1) as usize;
    let slice = samples.as_ref();
    let frames = slice.len() / ch;
    let mut planar = vec![Vec::with_capacity(frames); ch];
    for f in 0..frames {
        let base = f * ch;
        for c in 0..ch {
            planar[c].push(slice[base + c]);
        }
    }
    let refs: Vec<&[f32]> = planar.iter().map(Vec::as_slice).collect();
    Ok(build_lip_sync_envelope(&refs, sample_rate, target_value_scale).into())
}

#[napi]
pub fn compute_lip_sync_from_file(
    path: String,
    target_value_scale: Option<f64>,
) -> Result<LipSyncJsResult> {
    let decoded = decode_audio_file(Path::new(&path)).map_err(to_napi_err)?;
    let planar = decoded.to_planar_channels();
    let refs: Vec<&[f32]> = planar.iter().map(Vec::as_slice).collect();
    Ok(build_lip_sync_envelope(&refs, decoded.sample_rate, target_value_scale).into())
}

#[napi]
pub fn compute_lip_sync_from_bytes(
    bytes: Buffer,
    target_value_scale: Option<f64>,
) -> Result<LipSyncJsResult> {
    let decoded = decode_audio_bytes(bytes.as_ref(), None).map_err(to_napi_err)?;
    let planar = decoded.to_planar_channels();
    let refs: Vec<&[f32]> = planar.iter().map(Vec::as_slice).collect();
    Ok(build_lip_sync_envelope(&refs, decoded.sample_rate, target_value_scale).into())
}

// ---- Async worker tasks ------------------------------------------------------------------

pub struct MixAudioPlanTask {
    plan_json: String,
}

impl Task for MixAudioPlanTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let plan: AudioMixPlan = serde_json::from_str(&self.plan_json).map_err(to_napi_err)?;
        let res = mix_audio_plan(&plan).map_err(to_napi_err)?;
        serde_json::to_string(&res).map_err(to_napi_err)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn mix_audio_plan_async(plan_json: String) -> AsyncTask<MixAudioPlanTask> {
    AsyncTask::new(MixAudioPlanTask { plan_json })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MixWavTrackJson {
    path: String,
    start_ms: f64,
    end_ms: Option<f64>,
    volume: f32,
    #[serde(default)]
    looping: bool,
    #[serde(default)]
    fade_in_ms: f64,
    #[serde(default)]
    fade_out_ms: f64,
}

pub struct MixWavTask {
    duration_ms: f64,
    output_path: String,
    tracks_json: String,
}

impl Task for MixWavTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let raw_tracks: Vec<MixWavTrackJson> =
            serde_json::from_str(&self.tracks_json).map_err(to_napi_err)?;
        let tracks: Vec<MixTrack> = raw_tracks
            .into_iter()
            .map(|t| MixTrack {
                path: PathBuf::from(t.path),
                start_ms: t.start_ms,
                end_ms: t.end_ms,
                volume: t.volume,
                looping: t.looping,
                fade_in_ms: t.fade_in_ms,
                fade_out_ms: t.fade_out_ms,
            })
            .collect();
        let (frames, file_size) =
            mix_tracks_to_wav(self.duration_ms, &tracks, Path::new(&self.output_path))
                .map_err(to_napi_err)?;
        Ok(serde_json::json!({
            "ok": true,
            "outputPath": self.output_path,
            "frames": frames,
            "fileSize": file_size,
        })
        .to_string())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn mix_wav_async(
    duration_ms: f64,
    output_path: String,
    tracks_json: String,
) -> AsyncTask<MixWavTask> {
    AsyncTask::new(MixWavTask {
        duration_ms,
        output_path,
        tracks_json,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemuxOptionsJson {
    ffmpeg_path: String,
    video_path: String,
    audio_path: Option<String>,
    output_path: String,
    #[serde(default = "default_audio_bitrate")]
    audio_bitrate: String,
    frame_count: Option<u32>,
    #[serde(default = "default_fps")]
    fps: u32,
    #[serde(default)]
    start_frame: u32,
    #[serde(default)]
    transcode: bool,
    #[serde(default = "default_codec")]
    codec: String,
    input_codec: Option<String>,
    #[serde(default = "default_encoder")]
    encoder: String,
    #[serde(default = "default_crf")]
    crf: u32,
    preset: Option<String>,
    width: u32,
    height: u32,
    input_width: Option<u32>,
    input_height: Option<u32>,
    gop: Option<u32>,
    #[serde(default)]
    max_output_mbps: f64,
    #[serde(default = "default_true")]
    low_power: bool,
}

fn default_audio_bitrate() -> String {
    "128k".to_owned()
}
fn default_fps() -> u32 {
    60
}
fn default_codec() -> String {
    "hevc".to_owned()
}
fn default_encoder() -> String {
    "auto".to_owned()
}
fn default_crf() -> u32 {
    23
}
fn default_true() -> bool {
    true
}

pub struct RemuxTask {
    options_json: String,
}

impl Task for RemuxTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let j: RemuxOptionsJson = serde_json::from_str(&self.options_json).map_err(to_napi_err)?;
        let codec = Codec::from_name(&j.codec)
            .ok_or_else(|| to_napi_err(format!("unknown codec: {}", j.codec)))?;
        let input_codec = j
            .input_codec
            .as_deref()
            .map(|c| {
                Codec::from_name(c)
                    .ok_or_else(|| to_napi_err(format!("unknown input codec: {c}")))
            })
            .transpose()?;
        let res = encode_run_remux(&RemuxOptions {
            ffmpeg: PathBuf::from(j.ffmpeg_path),
            video: PathBuf::from(j.video_path),
            audio: j.audio_path.map(PathBuf::from),
            output: PathBuf::from(j.output_path),
            audio_bitrate: j.audio_bitrate,
            frame_count: j.frame_count,
            fps: j.fps.max(1),
            start_frame: j.start_frame,
            transcode: j.transcode,
            codec,
            input_codec,
            encoder_choice: j.encoder,
            crf: j.crf,
            preset: j.preset,
            width: j.width,
            height: j.height,
            input_width: j.input_width.unwrap_or(j.width),
            input_height: j.input_height.unwrap_or(j.height),
            gop: j.gop,
            max_mbps: j.max_output_mbps,
            low_power: j.low_power,
        })
        .map_err(to_napi_err)?;
        serde_json::to_string(&res).map_err(to_napi_err)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn run_remux_async(options_json: String) -> AsyncTask<RemuxTask> {
    AsyncTask::new(RemuxTask { options_json })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConcatSegmentEntryJson {
    video_path: String,
    frame_count: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConcatOptionsJson {
    ffmpeg_path: String,
    output_path: String,
    #[serde(default = "default_fps")]
    fps: u32,
    #[serde(default = "default_codec")]
    codec: String,
    audio_path: Option<String>,
    #[serde(default = "default_audio_bitrate")]
    audio_bitrate: String,
    segments: Vec<ConcatSegmentEntryJson>,
}

pub struct ConcatTask {
    options_json: String,
}

impl Task for ConcatTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let j: ConcatOptionsJson = serde_json::from_str(&self.options_json).map_err(to_napi_err)?;
        let codec = Codec::from_name(&j.codec)
            .ok_or_else(|| to_napi_err(format!("unknown codec: {}", j.codec)))?;
        let entries: Vec<(PathBuf, u32)> = j
            .segments
            .into_iter()
            .map(|s| (PathBuf::from(s.video_path), s.frame_count))
            .collect();
        let res = encode_concat_segments(
            Path::new(&j.ffmpeg_path),
            Path::new(&j.output_path),
            j.fps.max(1),
            codec,
            j.audio_path.as_deref().map(Path::new),
            &j.audio_bitrate,
            &entries,
        )
        .map_err(to_napi_err)?;
        serde_json::to_string(&res).map_err(to_napi_err)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn concat_segments_async(options_json: String) -> AsyncTask<ConcatTask> {
    AsyncTask::new(ConcatTask { options_json })
}

// ---- Streaming in-process pipe session ---------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PipeOpenOptionsJson {
    ffmpeg_path: String,
    output_path: String,
    width: u32,
    height: u32,
    #[serde(default = "default_fps")]
    fps: u32,
    #[serde(default = "default_format")]
    format: String,
    #[serde(default = "default_codec")]
    codec: String,
    #[serde(default = "default_encoder")]
    encoder: String,
    #[serde(default = "default_crf")]
    crf: u32,
    preset: Option<String>,
    gop: Option<u32>,
    #[serde(default)]
    faststart: bool,
    #[serde(default = "default_true")]
    rust_yuv_convert: bool,
    #[serde(default = "default_true")]
    low_power: bool,
    #[serde(default)]
    dedup: bool,
}

fn default_format() -> String {
    "yuv420p".to_owned()
}

#[napi]
pub fn open_pipe_session(options_json: String) -> Result<u32> {
    let j: PipeOpenOptionsJson = serde_json::from_str(&options_json).map_err(to_napi_err)?;
    let fmt = PipeFormat::from_name(&j.format)
        .ok_or_else(|| to_napi_err(format!("unknown pipe format: {}", j.format)))?;
    let codec = Codec::from_name(&j.codec)
        .ok_or_else(|| to_napi_err(format!("unknown codec: {}", j.codec)))?;
    let session = PipeSession::open(&PipeEncodeOptions {
        ffmpeg: PathBuf::from(j.ffmpeg_path),
        output: PathBuf::from(j.output_path),
        width: j.width,
        height: j.height,
        fps: j.fps.max(1),
        format: fmt,
        codec,
        encoder_choice: j.encoder,
        crf: j.crf,
        preset: j.preset,
        gop: j.gop,
        faststart: j.faststart,
        rust_yuv_convert: j.rust_yuv_convert,
        low_power: j.low_power,
        dedup: j.dedup,
    })
    .map_err(to_napi_err)?;

    let id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
    let abort = session.abort_handle();
    let entry = Arc::new(PipeSessionEntry {
        session: Mutex::new(Some(session)),
        abort,
    });
    let mut map = pipe_sessions().lock().map_err(to_napi_err)?;
    map.insert(id, entry);
    Ok(id)
}

pub struct WritePipeFrameTask {
    session_id: u32,
    data: Vec<u8>,
    frames_in_chunk: Option<u32>,
    repeat_count: u32,
    dedup: Option<bool>,
}

impl Task for WritePipeFrameTask {
    type Output = u64;
    type JsValue = u32;

    fn compute(&mut self) -> Result<Self::Output> {
        let entry = {
            let map = pipe_sessions().lock().map_err(to_napi_err)?;
            map.get(&self.session_id)
                .cloned()
                .ok_or_else(|| to_napi_err("pipe session not found"))?
        };
        if entry.abort.is_aborted() {
            return Err(to_napi_err("pipe session aborted"));
        }
        let mut guard = entry.session.lock().map_err(to_napi_err)?;
        let session = guard
            .as_mut()
            .ok_or_else(|| to_napi_err("pipe session already closed"))?;
        session
            .write_chunk(&self.data, self.frames_in_chunk, self.repeat_count, self.dedup)
            .map_err(to_napi_err)?;
        Ok(session.frame_count())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.min(u64::from(u32::MAX)) as u32)
    }
}

#[napi]
pub fn write_pipe_frame_async(
    session_id: u32,
    chunk: Buffer,
    frames_in_chunk: Option<u32>,
    repeat_count: Option<u32>,
    dedup: Option<bool>,
) -> AsyncTask<WritePipeFrameTask> {
    AsyncTask::new(WritePipeFrameTask {
        session_id,
        data: chunk.as_ref().to_vec(),
        frames_in_chunk,
        repeat_count: repeat_count.unwrap_or(1),
        dedup,
    })
}

pub struct RepeatPipeFrameTask {
    session_id: u32,
    count: u32,
}

impl Task for RepeatPipeFrameTask {
    type Output = u64;
    type JsValue = u32;

    fn compute(&mut self) -> Result<Self::Output> {
        let entry = {
            let map = pipe_sessions().lock().map_err(to_napi_err)?;
            map.get(&self.session_id)
                .cloned()
                .ok_or_else(|| to_napi_err("pipe session not found"))?
        };
        if entry.abort.is_aborted() {
            return Err(to_napi_err("pipe session aborted"));
        }
        let mut guard = entry.session.lock().map_err(to_napi_err)?;
        let session = guard
            .as_mut()
            .ok_or_else(|| to_napi_err("pipe session already closed"))?;
        session.repeat_last_frame(self.count).map_err(to_napi_err)?;
        Ok(session.frame_count())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.min(u64::from(u32::MAX)) as u32)
    }
}

#[napi]
pub fn repeat_pipe_frame_async(session_id: u32, count: u32) -> AsyncTask<RepeatPipeFrameTask> {
    AsyncTask::new(RepeatPipeFrameTask { session_id, count })
}

pub struct FinishPipeSessionTask {
    session_id: u32,
}

impl Task for FinishPipeSessionTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let entry = {
            let mut map = pipe_sessions().lock().map_err(to_napi_err)?;
            map.remove(&self.session_id)
                .ok_or_else(|| to_napi_err("pipe session not found"))?
        };
        let mut guard = entry.session.lock().map_err(to_napi_err)?;
        let session = guard
            .take()
            .ok_or_else(|| to_napi_err("pipe session already closed"))?;
        let res = session.finish().map_err(to_napi_err)?;
        serde_json::to_string(&res).map_err(to_napi_err)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn finish_pipe_session_async(session_id: u32) -> AsyncTask<FinishPipeSessionTask> {
    AsyncTask::new(FinishPipeSessionTask { session_id })
}

#[napi]
pub fn abort_pipe_session(session_id: u32) -> Result<()> {
    let entry = {
        let mut map = pipe_sessions().lock().map_err(to_napi_err)?;
        map.remove(&session_id)
    };
    if let Some(entry) = entry {
        // Kill FFmpeg + mark aborted immediately without blocking on session mutex
        // (WritePipeFrameTask/RepeatPipeFrameTask may be blocked in SyncSender::send).
        entry.abort.abort_now();
        if let Ok(mut guard) = entry.session.try_lock()
            && let Some(session) = guard.take()
        {
            session.abort();
        }
    }
    Ok(())
}

// ---- Local Rust binary WebSocket bridge server -------------------------------------------

#[napi]
pub fn start_bridge_server(options_json: String) -> Result<String> {
    let opts: BridgeStartOptions = serde_json::from_str(&options_json).map_err(to_napi_err)?;
    let mut slot = bridge_slot().lock().map_err(to_napi_err)?;
    if let Some(ref existing) = *slot {
        let info = existing.info();
        if info.running {
            return serde_json::to_string(&info).map_err(to_napi_err);
        }
    }
    let server = start_bridge(&opts).map_err(to_napi_err)?;
    let info = server.info();
    *slot = Some(server);
    serde_json::to_string(&info).map_err(to_napi_err)
}

#[napi]
pub fn get_bridge_server_info() -> Result<Option<String>> {
    let slot = bridge_slot().lock().map_err(to_napi_err)?;
    if let Some(ref srv) = *slot {
        let info = srv.info();
        if info.running {
            return Ok(Some(serde_json::to_string(&info).map_err(to_napi_err)?));
        }
    }
    Ok(None)
}

#[napi]
pub fn stop_bridge_server() -> Result<()> {
    let mut slot = bridge_slot().lock().map_err(to_napi_err)?;
    if let Some(mut srv) = slot.take() {
        srv.stop();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::time::{Duration, Instant};

    #[test]
    fn abort_pipe_session_does_not_deadlock_while_session_mutex_is_held() {
        let id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
        let aborted = Arc::new(AtomicBool::new(false));
        let abort = PipeAbortHandle::for_test(Arc::clone(&aborted));
        let entry = Arc::new(PipeSessionEntry {
            session: Mutex::new(None),
            abort,
        });
        {
            let mut map = pipe_sessions().lock().unwrap();
            map.insert(id, Arc::clone(&entry));
        }

        // Hold entry.session lock on the current thread to simulate blocked WritePipeFrameTask::compute.
        let _held_guard = entry.session.lock().unwrap();
        let started = Instant::now();
        abort_pipe_session(id).unwrap();
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(aborted.load(Ordering::Acquire));
        assert!(!pipe_sessions().lock().unwrap().contains_key(&id));
    }
}
