//! `mss-export-rs`: Standalone native Rust CLI binary (with NAPI parity for all subcommands).

use std::env;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use mss_audio::{
    AudioMixPlan, MixTrack, build_lip_sync_envelope, decode_audio_file, mix_audio_plan,
    mix_tracks_to_wav,
};
use mss_core::{
    MIN_SEGMENT_FRAMES, StoryPlanInput, StoryPlanWithSpans, analyze_static_spans, bake_story_plan,
    split_segments,
};
use mss_encode::{
    Codec, PipeEncodeOptions, PipeFormat, RemuxOptions, available_hardware_detailed,
    concat_segments, run_pipe_encode, run_remux,
};

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn next_arg(args: &[String], idx: &mut usize, flag: &str) -> Result<String, String> {
    *idx += 1;
    args.get(*idx)
        .cloned()
        .ok_or_else(|| format!("missing value for {flag}"))
}

fn parse_u32(val: &str, flag: &str) -> Result<u32, String> {
    val.parse::<u32>()
        .map_err(|_| format!("invalid integer for {flag}: {val}"))
}

fn parse_f64(val: &str, flag: &str) -> Result<f64, String> {
    val.parse::<f64>()
        .map_err(|_| format!("invalid number for {flag}: {val}"))
}

fn cmd_probe_encoders(args: &[String]) -> Result<(), String> {
    let mut ffmpeg = PathBuf::from("ffmpeg");
    let mut codec = Codec::Hevc;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--ffmpeg" => ffmpeg = PathBuf::from(next_arg(args, &mut i, "--ffmpeg")?),
            "--codec" => {
                let raw = next_arg(args, &mut i, "--codec")?;
                codec = Codec::from_name(&raw).ok_or_else(|| format!("unknown codec: {raw}"))?;
            }
            other => return Err(format!("unknown option for probe-encoders: {other}")),
        }
        i += 1;
    }
    let found = available_hardware_detailed(&ffmpeg, codec);
    println!(
        "{}",
        serde_json::json!({
            "ok": true,
            "codec": codec.name(),
            "hardware": found,
        })
    );
    Ok(())
}

fn cmd_remux(args: &[String]) -> Result<(), String> {
    let mut opts = RemuxOptions {
        ffmpeg: PathBuf::from("ffmpeg"),
        video: PathBuf::new(),
        audio: None,
        output: PathBuf::new(),
        audio_bitrate: "128k".to_owned(),
        frame_count: None,
        fps: 60,
        start_frame: 0,
        transcode: false,
        codec: Codec::H264,
        input_codec: None,
        encoder_choice: "auto".to_owned(),
        crf: 23,
        preset: None,
        width: 1920,
        height: 1080,
        input_width: 1920,
        input_height: 1080,
        gop: None,
        max_mbps: 0.0,
        low_power: true,
    };

    let mut has_input_size = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--ffmpeg" => opts.ffmpeg = PathBuf::from(next_arg(args, &mut i, "--ffmpeg")?),
            "--video" => opts.video = PathBuf::from(next_arg(args, &mut i, "--video")?),
            "--audio" => opts.audio = Some(PathBuf::from(next_arg(args, &mut i, "--audio")?)),
            "--output" => opts.output = PathBuf::from(next_arg(args, &mut i, "--output")?),
            "--audio-bitrate" => opts.audio_bitrate = next_arg(args, &mut i, "--audio-bitrate")?,
            "--frames" => {
                opts.frame_count = Some(parse_u32(&next_arg(args, &mut i, "--frames")?, "--frames")?)
            }
            "--fps" => opts.fps = parse_u32(&next_arg(args, &mut i, "--fps")?, "--fps")?,
            "--start-frame" => {
                opts.start_frame =
                    parse_u32(&next_arg(args, &mut i, "--start-frame")?, "--start-frame")?;
            }
            "--transcode" => opts.transcode = true,
            "--no-low-power" => opts.low_power = false,
            "--low-power" => opts.low_power = true,
            "--codec" => {
                let raw = next_arg(args, &mut i, "--codec")?;
                opts.codec =
                    Codec::from_name(&raw).ok_or_else(|| format!("unknown codec: {raw}"))?;
            }
            "--input-codec" => {
                let raw = next_arg(args, &mut i, "--input-codec")?;
                opts.input_codec = Some(
                    Codec::from_name(&raw)
                        .ok_or_else(|| format!("unknown input codec: {raw}"))?,
                );
            }
            "--encoder" => opts.encoder_choice = next_arg(args, &mut i, "--encoder")?,
            "--crf" | "--quality" => {
                opts.crf = parse_u32(&next_arg(args, &mut i, "--crf")?, "--crf")?
            }
            "--preset" => opts.preset = Some(next_arg(args, &mut i, "--preset")?),
            "--width" => opts.width = parse_u32(&next_arg(args, &mut i, "--width")?, "--width")?,
            "--height" => {
                opts.height = parse_u32(&next_arg(args, &mut i, "--height")?, "--height")?
            }
            "--input-width" => {
                has_input_size = true;
                opts.input_width =
                    parse_u32(&next_arg(args, &mut i, "--input-width")?, "--input-width")?;
            }
            "--input-height" => {
                has_input_size = true;
                opts.input_height =
                    parse_u32(&next_arg(args, &mut i, "--input-height")?, "--input-height")?;
            }
            "--gop" => opts.gop = Some(parse_u32(&next_arg(args, &mut i, "--gop")?, "--gop")?),
            "--max-mbps" => {
                opts.max_mbps = parse_f64(&next_arg(args, &mut i, "--max-mbps")?, "--max-mbps")?
            }
            other => return Err(format!("unknown option for remux: {other}")),
        }
        i += 1;
    }
    if opts.video.as_os_str().is_empty() || opts.output.as_os_str().is_empty() {
        return Err("remux requires --video and --output".into());
    }
    if !has_input_size {
        opts.input_width = opts.width;
        opts.input_height = opts.height;
    }

    let res = run_remux(&opts)?;
    println!(
        "{}",
        serde_json::to_string(&res).map_err(|e| e.to_string())?
    );
    Ok(())
}

fn cmd_pipe_encode(args: &[String]) -> Result<(), String> {
    let mut opts = PipeEncodeOptions {
        ffmpeg: PathBuf::from("ffmpeg"),
        output: PathBuf::new(),
        width: 1920,
        height: 1080,
        fps: 60,
        format: PipeFormat::Yuv420p,
        codec: Codec::H264,
        encoder_choice: "auto".to_owned(),
        crf: 23,
        preset: None,
        gop: None,
        faststart: false,
        rust_yuv_convert: true,
        low_power: true,
        dedup: false,
    };

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--ffmpeg" => opts.ffmpeg = PathBuf::from(next_arg(args, &mut i, "--ffmpeg")?),
            "--output" => opts.output = PathBuf::from(next_arg(args, &mut i, "--output")?),
            "--width" => opts.width = parse_u32(&next_arg(args, &mut i, "--width")?, "--width")?,
            "--height" => {
                opts.height = parse_u32(&next_arg(args, &mut i, "--height")?, "--height")?
            }
            "--fps" => opts.fps = parse_u32(&next_arg(args, &mut i, "--fps")?, "--fps")?,
            "--format" => {
                let raw = next_arg(args, &mut i, "--format")?;
                opts.format =
                    PipeFormat::from_name(&raw).ok_or_else(|| format!("unknown format: {raw}"))?;
            }
            "--codec" => {
                let raw = next_arg(args, &mut i, "--codec")?;
                opts.codec =
                    Codec::from_name(&raw).ok_or_else(|| format!("unknown codec: {raw}"))?;
            }
            "--encoder" => opts.encoder_choice = next_arg(args, &mut i, "--encoder")?,
            "--crf" | "--quality" => {
                opts.crf = parse_u32(&next_arg(args, &mut i, "--crf")?, "--crf")?
            }
            "--preset" => opts.preset = Some(next_arg(args, &mut i, "--preset")?),
            "--gop" => opts.gop = Some(parse_u32(&next_arg(args, &mut i, "--gop")?, "--gop")?),
            "--faststart" => opts.faststart = true,
            "--ffmpeg-yuv" => opts.rust_yuv_convert = false,
            "--no-low-power" => opts.low_power = false,
            "--low-power" => opts.low_power = true,
            "--dedup" => opts.dedup = true,
            other => return Err(format!("unknown option for pipe-encode: {other}")),
        }
        i += 1;
    }
    if opts.output.as_os_str().is_empty() {
        return Err("pipe-encode requires --output".into());
    }

    let res = run_pipe_encode(&opts)?;
    println!(
        "{}",
        serde_json::to_string(&res).map_err(|e| e.to_string())?
    );
    Ok(())
}

fn cmd_concat_segments(args: &[String]) -> Result<(), String> {
    let mut ffmpeg = PathBuf::from("ffmpeg");
    let mut output = PathBuf::new();
    let mut fps = 60u32;
    let mut codec = Codec::H264;
    let mut audio: Option<PathBuf> = None;
    let mut audio_bitrate = "128k".to_owned();
    let mut entries: Vec<(PathBuf, u32)> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--ffmpeg" => ffmpeg = PathBuf::from(next_arg(args, &mut i, "--ffmpeg")?),
            "--output" => output = PathBuf::from(next_arg(args, &mut i, "--output")?),
            "--fps" => fps = parse_u32(&next_arg(args, &mut i, "--fps")?, "--fps")?,
            "--codec" => {
                let raw = next_arg(args, &mut i, "--codec")?;
                codec = Codec::from_name(&raw).ok_or_else(|| format!("unknown codec: {raw}"))?;
            }
            "--audio" => audio = Some(PathBuf::from(next_arg(args, &mut i, "--audio")?)),
            "--audio-bitrate" => audio_bitrate = next_arg(args, &mut i, "--audio-bitrate")?,
            "--segment" => {
                let raw = next_arg(args, &mut i, "--segment")?;
                let (file, frames_s) = raw
                    .rsplit_once(':')
                    .ok_or_else(|| format!("--segment expects <path>:<frames>, got {raw}"))?;
                let frames = parse_u32(frames_s, "--segment")?;
                entries.push((PathBuf::from(file), frames));
            }
            other => return Err(format!("unknown option for concat-segments: {other}")),
        }
        i += 1;
    }
    if output.as_os_str().is_empty() {
        return Err("concat-segments requires --output".into());
    }
    let res = concat_segments(
        &ffmpeg,
        &output,
        fps,
        codec,
        audio.as_deref(),
        &audio_bitrate,
        &entries,
    )?;
    println!(
        "{}",
        serde_json::to_string(&res).map_err(|e| e.to_string())?
    );
    Ok(())
}

fn cmd_mix_wav(args: &[String]) -> Result<(), String> {
    let mut output = PathBuf::new();
    let mut duration_ms: f64 = 0.0;
    let mut tracks: Vec<MixTrack> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--output" => output = PathBuf::from(next_arg(args, &mut i, "--output")?),
            "--duration-ms" => {
                duration_ms = parse_f64(&next_arg(args, &mut i, "--duration-ms")?, "--duration-ms")?;
            }
            "--track" => {
                let raw = next_arg(args, &mut i, "--track")?;
                let parts: Vec<&str> = raw.split('|').collect();
                if parts.len() < 4 {
                    return Err(format!("invalid --track spec: {raw}"));
                }
                let start_ms = parse_f64(parts[1], "track.startMs")?;
                let end_ms = if parts[2].is_empty() {
                    None
                } else {
                    Some(parse_f64(parts[2], "track.endMs")?)
                };
                let volume = parse_f64(parts[3], "track.volume")? as f32;
                let looping = parts.get(4).is_some_and(|v| *v == "1" || *v == "true");
                let fade_in_ms = parts
                    .get(5)
                    .filter(|v| !v.is_empty())
                    .map(|v| parse_f64(v, "track.fadeInMs"))
                    .transpose()?
                    .unwrap_or(0.0);
                let fade_out_ms = parts
                    .get(6)
                    .filter(|v| !v.is_empty())
                    .map(|v| parse_f64(v, "track.fadeOutMs"))
                    .transpose()?
                    .unwrap_or(0.0);
                tracks.push(MixTrack {
                    path: PathBuf::from(parts[0]),
                    start_ms,
                    end_ms,
                    volume,
                    looping,
                    fade_in_ms,
                    fade_out_ms,
                });
            }
            other => return Err(format!("unknown option for mix-wav: {other}")),
        }
        i += 1;
    }
    if output.as_os_str().is_empty() {
        return Err("mix-wav requires --output".into());
    }
    let (frames, file_size) = mix_tracks_to_wav(duration_ms, &tracks, &output)?;
    println!(
        "{}",
        serde_json::json!({
            "ok": true,
            "outputPath": output.to_string_lossy(),
            "frames": frames,
            "fileSize": file_size,
        })
    );
    Ok(())
}

fn cmd_mix_plan(args: &[String]) -> Result<(), String> {
    let mut plan_path = PathBuf::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--plan" => plan_path = PathBuf::from(next_arg(args, &mut i, "--plan")?),
            other => return Err(format!("unknown option for mix-plan: {other}")),
        }
        i += 1;
    }
    let raw = if plan_path.as_os_str().is_empty() {
        std::io::read_to_string(std::io::stdin()).map_err(|e| format!("stdin read failed: {e}"))?
    } else {
        std::fs::read_to_string(&plan_path).map_err(|e| format!("read plan failed: {e}"))?
    };
    let plan: AudioMixPlan =
        serde_json::from_str(&raw).map_err(|e| format!("invalid mix-plan json: {e}"))?;
    let res = mix_audio_plan(&plan)?;
    println!(
        "{}",
        serde_json::to_string(&res).map_err(|e| e.to_string())?
    );
    Ok(())
}

fn cmd_lip_sync(args: &[String]) -> Result<(), String> {
    let mut path = PathBuf::new();
    let mut tvs: Option<f64> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--input" => path = PathBuf::from(next_arg(args, &mut i, "--input")?),
            "--scale" => tvs = Some(parse_f64(&next_arg(args, &mut i, "--scale")?, "--scale")?),
            other => return Err(format!("unknown option for lip-sync: {other}")),
        }
        i += 1;
    }
    if path.as_os_str().is_empty() {
        return Err("lip-sync requires --input".into());
    }
    let decoded = decode_audio_file(Path::new(&path))?;
    let planar = decoded.to_planar_channels();
    let refs: Vec<&[f32]> = planar.iter().map(Vec::as_slice).collect();
    let env = build_lip_sync_envelope(&refs, decoded.sample_rate, tvs);
    println!(
        "{}",
        serde_json::to_string(&env).map_err(|e| e.to_string())?
    );
    Ok(())
}

fn cmd_bake_plan(args: &[String]) -> Result<(), String> {
    let mut input_path = PathBuf::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--input" => input_path = PathBuf::from(next_arg(args, &mut i, "--input")?),
            other => return Err(format!("unknown option for bake-plan: {other}")),
        }
        i += 1;
    }
    let raw = if input_path.as_os_str().is_empty() {
        std::io::read_to_string(std::io::stdin()).map_err(|e| format!("stdin read failed: {e}"))?
    } else {
        std::fs::read_to_string(&input_path).map_err(|e| format!("read input failed: {e}"))?
    };
    let input: StoryPlanInput =
        serde_json::from_str(&raw).map_err(|e| format!("invalid bake-plan json: {e}"))?;
    let plan = bake_story_plan(&input.snippets, &input.timeline, &input.options);
    let static_spans = analyze_static_spans(&plan);
    let out = StoryPlanWithSpans { plan, static_spans };
    println!(
        "{}",
        serde_json::to_string(&out).map_err(|e| e.to_string())?
    );
    Ok(())
}

fn cmd_plan_segments(args: &[String]) -> Result<(), String> {
    let mut start: u32 = 0;
    let mut end: u32 = 0;
    let mut jobs: u32 = 1;
    let mut fps: u32 = 60;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--start" => start = parse_u32(&next_arg(args, &mut i, "--start")?, "--start")?,
            "--end" => end = parse_u32(&next_arg(args, &mut i, "--end")?, "--end")?,
            "--frames" => {
                start = 0;
                end = parse_u32(&next_arg(args, &mut i, "--frames")?, "--frames")?;
            }
            "--jobs" => jobs = parse_u32(&next_arg(args, &mut i, "--jobs")?, "--jobs")?,
            "--fps" => fps = parse_u32(&next_arg(args, &mut i, "--fps")?, "--fps")?.max(1),
            other => return Err(format!("unknown option for plan-segments: {other}")),
        }
        i += 1;
    }
    let parts = split_segments(start..end, jobs);
    let segs: Vec<_> = parts
        .into_iter()
        .map(|r| serde_json::json!({"start": r.start, "end": r.end}))
        .collect();
    println!(
        "{}",
        serde_json::json!({
            "ok": true,
            "minSegmentFrames": MIN_SEGMENT_FRAMES,
            "fps": fps,
            "segments": segs,
        })
    );
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let Some(sub) = args.first().map(String::as_str) else {
        eprintln!(
            "usage: mss-export-rs <version|probe-encoders|remux|pipe-encode|plan-segments|bake-plan|concat-segments|concat-mix|mix-wav|mix-plan|lip-sync> [options]"
        );
        return ExitCode::from(2);
    };
    let rest = &args[1..];
    let result = match sub {
        "version" | "--version" => {
            println!("{{\"ok\":true,\"name\":\"mss-export-rs\",\"version\":\"{VERSION}\"}}");
            Ok(())
        }
        "probe-encoders" => cmd_probe_encoders(rest),
        "remux" => cmd_remux(rest),
        "pipe-encode" => cmd_pipe_encode(rest),
        "plan-segments" => cmd_plan_segments(rest),
        "bake-plan" => cmd_bake_plan(rest),
        "concat-segments" | "concat-mix" => cmd_concat_segments(rest),
        "mix-wav" => cmd_mix_wav(rest),
        "mix-plan" => cmd_mix_plan(rest),
        "lip-sync" => cmd_lip_sync(rest),
        other => Err(format!("unknown subcommand: {other}")),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(msg) => {
            eprintln!("error: {msg}");
            ExitCode::FAILURE
        }
    }
}
