//! High-throughput local Rust binary WebSocket server (`/bridge/rs-stream`)
//! allowing renderer pages to stream MP4 muxer chunks (`WRITE_FILE_AT`) or raw/MJPEG frames
//! (`PIPE_FRAME` / `REPEAT_FRAME`) directly into Rust without Express/Node Buffer overhead.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;

use mss_encode::{Codec, PipeEncodeOptions, PipeFormat, PipeSession};
use serde::{Deserialize, Serialize};
use tungstenite::Message;
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::http::StatusCode;

const KIND_WRITE_FILE_AT: u8 = 1;
const KIND_PIPE_FRAME: u8 = 2;
const KIND_REPEAT_FRAME: u8 = 3;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStartOptions {
    #[serde(default = "default_host")]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub allowed_output_dirs: Vec<String>,
    pub bridge_token: Option<String>,
    pub ffmpeg_path: Option<String>,
}

fn default_host() -> String {
    "127.0.0.1".to_owned()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeServerInfo {
    pub running: bool,
    pub port: u16,
    pub ws_url: String,
    pub token: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
enum ControlCmd {
    Ping,
    OpenFile {
        #[serde(rename = "streamId")]
        stream_id: u32,
        path: String,
        #[serde(default)]
        truncate: bool,
    },
    OpenPipe {
        #[serde(rename = "streamId")]
        stream_id: u32,
        #[serde(rename = "outputPath")]
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
        #[serde(default = "default_true", rename = "lowPower")]
        low_power: bool,
        #[serde(default = "default_true")]
        dedup: bool,
        #[serde(rename = "ffmpegPath")]
        ffmpeg_path: Option<String>,
    },
    RepeatFrame {
        #[serde(rename = "streamId")]
        stream_id: u32,
        #[serde(default = "default_one")]
        count: u32,
    },
    Close {
        #[serde(rename = "streamId")]
        stream_id: u32,
    },
    Abort {
        #[serde(rename = "streamId")]
        stream_id: u32,
    },
}

fn default_fps() -> u32 {
    60
}
fn default_format() -> String {
    "yuv420p".to_owned()
}
fn default_codec() -> String {
    "hevc".to_owned()
}
fn default_encoder() -> String {
    "auto".to_owned()
}
fn default_crf() -> u32 {
    27
}
fn default_true() -> bool {
    true
}
fn default_one() -> u32 {
    1
}

struct FileSink {
    path: PathBuf,
    file: BufWriter<File>,
    cursor: u64,
    max_len: u64,
}

impl FileSink {
    fn open(path: PathBuf, truncate: bool) -> Result<Self, String> {
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create dir for file sink: {e}"))?;
        }
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(truncate)
            .open(&path)
            .map_err(|e| format!("failed to open {}: {e}", path.display()))?;
        let max_len = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Self {
            path,
            file: BufWriter::with_capacity(256 * 1024, file),
            cursor: if truncate { 0 } else { max_len },
            max_len,
        })
    }

    fn write_at(&mut self, offset: u64, data: &[u8]) -> Result<(), String> {
        if offset != u64::MAX && offset != self.cursor {
            self.file
                .flush()
                .map_err(|e| format!("file flush error: {e}"))?;
            self.file
                .seek(SeekFrom::Start(offset))
                .map_err(|e| format!("file seek error: {e}"))?;
            self.cursor = offset;
        }
        self.file
            .write_all(data)
            .map_err(|e| format!("file write error: {e}"))?;
        self.cursor = self.cursor.saturating_add(data.len() as u64);
        self.max_len = self.max_len.max(self.cursor);
        Ok(())
    }

    fn close(mut self) -> Result<u64, String> {
        self.file
            .flush()
            .map_err(|e| format!("file flush error: {e}"))?;
        let file = self
            .file
            .into_inner()
            .map_err(|e| format!("file unwrap error: {e}"))?;
        file.sync_data()
            .map_err(|e| format!("file sync error: {e}"))?;
        Ok(std::fs::metadata(&self.path).map(|m| m.len()).unwrap_or(self.max_len))
    }
}

enum StreamTarget {
    File(FileSink),
    Pipe(PipeSession),
}

pub struct BridgeServer {
    pub port: u16,
    pub ws_url: String,
    pub token: String,
    shutdown: Arc<AtomicBool>,
    accept_thread: Option<JoinHandle<()>>,
}

impl BridgeServer {
    pub fn info(&self) -> BridgeServerInfo {
        BridgeServerInfo {
            running: !self.shutdown.load(Ordering::Relaxed),
            port: self.port,
            ws_url: self.ws_url.clone(),
            token: self.token.clone(),
        }
    }

    pub fn stop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        if let Some(h) = self.accept_thread.take() {
            let _ = h.join();
        }
    }
}

impl Drop for BridgeServer {
    fn drop(&mut self) {
        self.stop();
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn normalize_path_lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            c => out.push(c.as_os_str()),
        }
    }
    out
}

fn resolve_with_existing_realpath(target: &Path) -> PathBuf {
    let abs = if target.is_absolute() {
        normalize_path_lexical(target)
    } else {
        normalize_path_lexical(&std::env::current_dir().unwrap_or_default().join(target))
    };
    let mut cur = abs.clone();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if let Ok(real) = std::fs::canonicalize(&cur) {
            let mut full = real;
            for seg in tail.into_iter().rev() {
                full.push(seg);
            }
            return full;
        }
        let Some(name) = cur.file_name().map(|n| n.to_os_string()) else {
            return abs;
        };
        let Some(parent) = cur.parent() else {
            return abs;
        };
        tail.push(name);
        cur = parent.to_path_buf();
    }
}

fn is_within_allowed_roots(target_raw: &str, allowed_roots: &[PathBuf]) -> Result<PathBuf, String> {
    if target_raw.is_empty() || target_raw.contains('\0') {
        return Err("invalid empty or NUL path".into());
    }
    if allowed_roots.is_empty() {
        return Err("no allowed output directories configured".into());
    }
    let resolved = resolve_with_existing_realpath(Path::new(target_raw));
    let resolved_s = if cfg!(windows) {
        resolved.to_string_lossy().to_ascii_lowercase()
    } else {
        resolved.to_string_lossy().into_owned()
    };
    for root in allowed_roots {
        let root_s = if cfg!(windows) {
            root.to_string_lossy().to_ascii_lowercase()
        } else {
            root.to_string_lossy().into_owned()
        };
        let prefix = if root_s.ends_with(std::path::MAIN_SEPARATOR) {
            root_s.clone()
        } else {
            format!("{root_s}{}", std::path::MAIN_SEPARATOR)
        };
        if resolved_s.starts_with(&prefix) && resolved_s.len() > prefix.len() {
            return Ok(resolved);
        }
    }
    Err(format!(
        "path outside allowed output roots: {}",
        resolved.display()
    ))
}

fn extract_query_token(uri: &str) -> Option<String> {
    let (_, query) = uri.split_once('?')?;
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=')
            && k == "token"
        {
            return Some(v.to_owned());
        }
    }
    None
}

pub fn start_bridge_server(opts: &BridgeStartOptions) -> Result<BridgeServer, String> {
    if opts.port == 9881 {
        return Err("port 9881 is reserved for main HTTP server".into());
    }
    let host = if opts.host.trim().is_empty() {
        "127.0.0.1"
    } else {
        opts.host.trim()
    };
    let addr: SocketAddr = format!("{host}:{}", opts.port)
        .parse()
        .map_err(|e| format!("invalid bind address: {e}"))?;
    let listener =
        TcpListener::bind(addr).map_err(|e| format!("failed to bind mss-bridge on {addr}: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("failed to set nonblocking listener: {e}"))?;

    let bound_port = listener
        .local_addr()
        .map_err(|e| format!("local_addr failed: {e}"))?
        .port();

    let mut allowed_roots: Vec<PathBuf> = vec![resolve_with_existing_realpath(&std::env::temp_dir())];
    for dir in &opts.allowed_output_dirs {
        if !dir.trim().is_empty() {
            allowed_roots.push(resolve_with_existing_realpath(Path::new(dir)));
        }
    }
    let allowed_roots = Arc::new(allowed_roots);
    let token = opts
        .bridge_token
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_default();
    let expected_token = Arc::new(token.clone());
    let default_ffmpeg = Arc::new(
        opts.ffmpeg_path
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "ffmpeg".to_owned()),
    );
    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_flag = Arc::clone(&shutdown);

    let accept_thread = std::thread::Builder::new()
        .name("mss-bridge-accept".into())
        .spawn(move || {
            while !shutdown_flag.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _peer)) => {
                        let _ = stream.set_nonblocking(false);
                        let roots = Arc::clone(&allowed_roots);
                        let tok = Arc::clone(&expected_token);
                        let ff = Arc::clone(&default_ffmpeg);
                        let sd = Arc::clone(&shutdown_flag);
                        let _ = std::thread::Builder::new()
                            .name("mss-bridge-conn".into())
                            .spawn(move || handle_connection(stream, roots, tok, ff, sd));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
        })
        .map_err(|e| format!("failed to spawn mss-bridge accept thread: {e}"))?;

    let ws_url = if token.is_empty() {
        format!("ws://{host}:{bound_port}/bridge/rs-stream")
    } else {
        format!("ws://{host}:{bound_port}/bridge/rs-stream?token={token}")
    };

    Ok(BridgeServer {
        port: bound_port,
        ws_url,
        token,
        shutdown,
        accept_thread: Some(accept_thread),
    })
}

fn handle_connection(
    stream: TcpStream,
    allowed_roots: Arc<Vec<PathBuf>>,
    expected_token: Arc<String>,
    default_ffmpeg: Arc<String>,
    shutdown: Arc<AtomicBool>,
) {
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));

    let token_check = Arc::clone(&expected_token);
    let mut ws = match tungstenite::accept_hdr(
        stream,
        |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
            let path = req.uri().path();
            if path != "/bridge/rs-stream" && path != "/stream" {
                return Err(ErrorResponse::new(Some("Not Found".into())));
            }
            if !token_check.is_empty() {
                let header_tok = req
                    .headers()
                    .get("x-mss-bridge-token")
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_owned);
                let query_tok = req.uri().to_string();
                let provided = header_tok
                    .or_else(|| extract_query_token(&query_tok))
                    .unwrap_or_default();
                if !constant_time_eq(provided.as_bytes(), token_check.as_bytes()) {
                    let mut err = ErrorResponse::new(Some("Unauthorized".into()));
                    *err.status_mut() = StatusCode::UNAUTHORIZED;
                    return Err(err);
                }
            }
            Ok(resp)
        },
    ) {
        Ok(ws) => ws,
        Err(_) => return,
    };

    let mut targets: HashMap<u32, StreamTarget> = HashMap::new();

    while !shutdown.load(Ordering::Relaxed) {
        let msg = match ws.read() {
            Ok(m) => m,
            Err(tungstenite::Error::Io(ref e))
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                continue;
            }
            Err(_) => break,
        };

        match msg {
            Message::Text(text) => {
                let reply = match serde_json::from_str::<ControlCmd>(&text) {
                    Ok(ControlCmd::Ping) => r#"{"ok":true,"op":"pong"}"#.to_owned(),
                    Ok(ControlCmd::OpenFile {
                        stream_id,
                        path,
                        truncate,
                    }) => match is_within_allowed_roots(&path, &allowed_roots)
                        .and_then(|safe| FileSink::open(safe, truncate))
                    {
                        Ok(sink) => {
                            targets.insert(stream_id, StreamTarget::File(sink));
                            format!(r#"{{"ok":true,"op":"ack","streamId":{stream_id}}}"#)
                        }
                        Err(e) => format!(
                            r#"{{"ok":false,"op":"error","streamId":{stream_id},"error":{}}}"#,
                            serde_json::to_string(&e).unwrap_or_else(|_| "\"error\"".into())
                        ),
                    },
                    Ok(ControlCmd::OpenPipe {
                        stream_id,
                        output_path,
                        width,
                        height,
                        fps,
                        format,
                        codec,
                        encoder,
                        crf,
                        preset,
                        gop,
                        faststart,
                        low_power,
                        dedup,
                        ffmpeg_path,
                    }) => {
                        let res = is_within_allowed_roots(&output_path, &allowed_roots).and_then(
                            |safe_out| {
                                let fmt = PipeFormat::from_name(&format)
                                    .ok_or_else(|| format!("unknown pipe format: {format}"))?;
                                let c = Codec::from_name(&codec)
                                    .ok_or_else(|| format!("unknown codec: {codec}"))?;
                                PipeSession::open(&PipeEncodeOptions {
                                    ffmpeg: PathBuf::from(
                                        ffmpeg_path.unwrap_or_else(|| (*default_ffmpeg).clone()),
                                    ),
                                    output: safe_out,
                                    width,
                                    height,
                                    fps: fps.max(1),
                                    format: fmt,
                                    codec: c,
                                    encoder_choice: encoder,
                                    crf,
                                    preset,
                                    gop,
                                    faststart,
                                    rust_yuv_convert: true,
                                    low_power,
                                    dedup,
                                })
                            },
                        );
                        match res {
                            Ok(pipe) => {
                                targets.insert(stream_id, StreamTarget::Pipe(pipe));
                                format!(r#"{{"ok":true,"op":"ack","streamId":{stream_id}}}"#)
                            }
                            Err(e) => format!(
                                r#"{{"ok":false,"op":"error","streamId":{stream_id},"error":{}}}"#,
                                serde_json::to_string(&e).unwrap_or_else(|_| "\"error\"".into())
                            ),
                        }
                    }
                    Ok(ControlCmd::RepeatFrame { stream_id, count }) => {
                        match targets.get_mut(&stream_id) {
                            Some(StreamTarget::Pipe(pipe)) => match pipe.repeat_last_frame(count) {
                                Ok(()) => {
                                    format!(r#"{{"ok":true,"op":"ack","streamId":{stream_id}}}"#)
                                }
                                Err(e) => format!(
                                    r#"{{"ok":false,"op":"error","streamId":{stream_id},"error":{}}}"#,
                                    serde_json::to_string(&e)
                                        .unwrap_or_else(|_| "\"error\"".into())
                                ),
                            },
                            _ => format!(
                                r#"{{"ok":false,"op":"error","streamId":{stream_id},"error":"pipe stream not found"}}"#
                            ),
                        }
                    }
                    Ok(ControlCmd::Close { stream_id }) => match targets.remove(&stream_id) {
                        Some(StreamTarget::File(sink)) => match sink.close() {
                            Ok(size) => format!(
                                r#"{{"ok":true,"op":"closed","streamId":{stream_id},"fileSize":{size}}}"#
                            ),
                            Err(e) => format!(
                                r#"{{"ok":false,"op":"error","streamId":{stream_id},"error":{}}}"#,
                                serde_json::to_string(&e).unwrap_or_else(|_| "\"error\"".into())
                            ),
                        },
                        Some(StreamTarget::Pipe(pipe)) => match pipe.finish() {
                            Ok(res) => format!(
                                r#"{{"ok":true,"op":"closed","streamId":{stream_id},"fileSize":{},"frames":{},"dedupedFrames":{},"encoder":{},"elapsedMs":{}}}"#,
                                res.file_size,
                                res.frames,
                                res.deduped_frames,
                                serde_json::to_string(&res.encoder)
                                    .unwrap_or_else(|_| "\"unknown\"".into()),
                                res.elapsed_ms
                            ),
                            Err(e) => format!(
                                r#"{{"ok":false,"op":"error","streamId":{stream_id},"error":{}}}"#,
                                serde_json::to_string(&e).unwrap_or_else(|_| "\"error\"".into())
                            ),
                        },
                        None => format!(
                            r#"{{"ok":false,"op":"error","streamId":{stream_id},"error":"stream not found"}}"#
                        ),
                    },
                    Ok(ControlCmd::Abort { stream_id }) => {
                        if let Some(StreamTarget::Pipe(pipe)) = targets.remove(&stream_id) {
                            pipe.abort();
                        }
                        format!(r#"{{"ok":true,"op":"aborted","streamId":{stream_id}}}"#)
                    }
                    Err(e) => format!(
                        r#"{{"ok":false,"op":"error","error":{}}}"#,
                        serde_json::to_string(&format!("invalid control json: {e}"))
                            .unwrap_or_else(|_| "\"bad json\"".into())
                    ),
                };
                if ws.send(Message::Text(reply)).is_err() {
                    break;
                }
            }
            Message::Binary(bin) => {
                if bin.len() < 16 {
                    continue;
                }
                let stream_id = u32::from_le_bytes(bin[0..4].try_into().unwrap());
                let kind = bin[4];
                let flags = bin[5];
                let offset_or_count = u64::from_le_bytes(bin[8..16].try_into().unwrap());
                let payload = &bin[16..];

                let op_res = match (kind, targets.get_mut(&stream_id)) {
                    (KIND_WRITE_FILE_AT, Some(StreamTarget::File(sink))) => {
                        sink.write_at(offset_or_count, payload)
                    }
                    (KIND_PIPE_FRAME, Some(StreamTarget::Pipe(pipe))) => {
                        let repeat = (offset_or_count.max(1)).min(u64::from(u32::MAX)) as u32;
                        let dedup = if (flags & 2) != 0 { Some(true) } else { None };
                        pipe.write_chunk(payload, Some(1), repeat, dedup)
                    }
                    (KIND_REPEAT_FRAME, Some(StreamTarget::Pipe(pipe))) => {
                        let repeat = (offset_or_count.max(1)).min(u64::from(u32::MAX)) as u32;
                        pipe.repeat_last_frame(repeat)
                    }
                    _ => Err(format!("invalid binary frame kind={kind} for stream {stream_id}")),
                };
                if let Err(e) = op_res {
                    let err_msg = format!(
                        r#"{{"ok":false,"op":"error","streamId":{stream_id},"error":{}}}"#,
                        serde_json::to_string(&e).unwrap_or_else(|_| "\"error\"".into())
                    );
                    if ws.send(Message::Text(err_msg)).is_err() {
                        break;
                    }
                }
            }
            Message::Close(_) => break,
            Message::Ping(p) => {
                let _ = ws.send(Message::Pong(p));
            }
            Message::Pong(_) | Message::Frame(_) => {}
        }
    }

    for (_, target) in targets {
        if let StreamTarget::Pipe(pipe) = target {
            pipe.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_server_rejects_port_9881_and_validates_paths() {
        let err = start_bridge_server(&BridgeStartOptions {
            host: "127.0.0.1".into(),
            port: 9881,
            allowed_output_dirs: vec![],
            bridge_token: None,
            ffmpeg_path: None,
        })
        .err()
        .unwrap();
        assert!(err.contains("9881"));
    }

    #[test]
    fn bridge_server_streams_binary_file_chunks() {
        let dir = std::env::temp_dir().join(format!("mss-bridge-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let out_file = dir.join("chunked.bin");

        let mut srv = start_bridge_server(&BridgeStartOptions {
            host: "127.0.0.1".into(),
            port: 0,
            allowed_output_dirs: vec![dir.to_string_lossy().into_owned()],
            bridge_token: Some("secret-tok".into()),
            ffmpeg_path: None,
        })
        .unwrap();

        let (mut client, _) = tungstenite::connect(&srv.ws_url).unwrap();
        let open_msg = serde_json::json!({
            "op": "open-file",
            "streamId": 7,
            "path": out_file.to_string_lossy(),
            "truncate": true
        });
        client.send(Message::Text(open_msg.to_string())).unwrap();
        let ack = client.read().unwrap().into_text().unwrap();
        assert!(ack.contains("\"ok\":true"));

        // Write "HELLO" at offset 0 and "WORLD" at offset 5
        let mut frame1 = Vec::new();
        frame1.extend_from_slice(&7u32.to_le_bytes());
        frame1.push(KIND_WRITE_FILE_AT);
        frame1.push(0);
        frame1.extend_from_slice(&0u16.to_le_bytes());
        frame1.extend_from_slice(&0u64.to_le_bytes());
        frame1.extend_from_slice(b"HELLO");
        client.send(Message::Binary(frame1)).unwrap();

        let mut frame2 = Vec::new();
        frame2.extend_from_slice(&7u32.to_le_bytes());
        frame2.push(KIND_WRITE_FILE_AT);
        frame2.push(0);
        frame2.extend_from_slice(&0u16.to_le_bytes());
        frame2.extend_from_slice(&5u64.to_le_bytes());
        frame2.extend_from_slice(b"WORLD");
        client.send(Message::Binary(frame2)).unwrap();

        client
            .send(Message::Text(r#"{"op":"close","streamId":7}"#.into()))
            .unwrap();
        let closed = client.read().unwrap().into_text().unwrap();
        assert!(closed.contains("\"fileSize\":10"));
        assert_eq!(std::fs::read(&out_file).unwrap(), b"HELLOWORLD");

        let _ = client.close(None);
        srv.stop();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
