//! Hardware & software FFmpeg video encoder selection and smoke-probing.
//! Modeled directly on SekaiStoryExporter `sse-export/src/hardware.rs` (ADR-0018),
//! extended with visual-novel GOP spacing and dark-fade AQ tuning.

use std::path::Path;
use std::process::{Command, Stdio};

use crate::color;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Codec {
    #[default]
    Hevc,
    H264,
}

impl Codec {
    pub fn from_name(name: &str) -> Option<Self> {
        match name.to_ascii_lowercase().as_str() {
            "hevc" | "h265" | "x265" => Some(Self::Hevc),
            "h264" | "avc" | "x264" => Some(Self::H264),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Hevc => "hevc",
            Self::H264 => "h264",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    VideoToolbox,
    Nvenc,
    Qsv,
    Amf,
    Vaapi,
}

const VAAPI_DEVICE: &str = "/dev/dri/renderD128";

impl Backend {
    #[allow(dead_code)]
    pub const ALL: [Self; 5] = [
        Self::VideoToolbox,
        Self::Nvenc,
        Self::Qsv,
        Self::Amf,
        Self::Vaapi,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::VideoToolbox => "videotoolbox",
            Self::Nvenc => "nvenc",
            Self::Qsv => "qsv",
            Self::Amf => "amf",
            Self::Vaapi => "vaapi",
        }
    }

    pub fn host_alias(self) -> &'static str {
        match self {
            Self::Nvenc => "nvidia",
            Self::Qsv => "intel",
            Self::Amf => "amd",
            Self::VideoToolbox => "videotoolbox",
            Self::Vaapi => "vaapi",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name.to_ascii_lowercase().as_str() {
            "videotoolbox" | "vt" => Some(Self::VideoToolbox),
            "nvenc" | "nvidia" => Some(Self::Nvenc),
            "qsv" | "intel" => Some(Self::Qsv),
            "amf" | "amd" => Some(Self::Amf),
            "vaapi" => Some(Self::Vaapi),
            _ => None,
        }
    }

    pub fn candidates() -> &'static [Self] {
        if cfg!(target_os = "macos") {
            &[Self::VideoToolbox]
        } else if cfg!(windows) {
            &[Self::Nvenc, Self::Qsv, Self::Amf]
        } else {
            &[Self::Nvenc, Self::Vaapi, Self::Qsv]
        }
    }

    pub fn encoder_name(self, codec: Codec) -> String {
        format!("{}_{}", codec.name(), self.name())
    }

    pub fn global_args(self) -> Vec<String> {
        match self {
            Self::Vaapi => vec!["-vaapi_device".into(), VAAPI_DEVICE.into()],
            _ => Vec::new(),
        }
    }

    pub fn upload_filter(self) -> Option<&'static str> {
        match self {
            Self::Vaapi => Some("format=nv12,hwupload"),
            _ => None,
        }
    }

    pub fn pix_fmt(self) -> Option<&'static str> {
        match self {
            Self::VideoToolbox | Self::Nvenc => Some("yuv420p"),
            Self::Qsv | Self::Amf => Some("nv12"),
            Self::Vaapi => None,
        }
    }

    /// Hardware encoder args calibrated to CRF-equivalent quality (`crf` 1..=51, lower is better)
    /// plus GOP keyframe spacing for high-efficiency 2D visual-novel compression.
    pub fn args(self, codec: Codec, crf: u32, gop: Option<u32>) -> Vec<String> {
        let qp = crf.clamp(1, 51);
        let qp_s = qp.to_string();
        let vt_q = ((51.0 - f64::from(qp)) / 0.4).round().clamp(1.0, 100.0) as u32;
        let vt_q_s = vt_q.to_string();

        let mut args = vec!["-c:v".to_owned(), self.encoder_name(codec)];
        match self {
            Self::VideoToolbox => args.extend(["-q:v".into(), vt_q_s]),
            Self::Nvenc => args.extend([
                "-preset".into(),
                "p4".into(),
                "-rc".into(),
                "vbr".into(),
                "-cq".into(),
                qp_s,
                "-b:v".into(),
                "0".into(),
            ]),
            Self::Qsv => args.extend([
                "-preset".into(),
                "faster".into(),
                "-global_quality".into(),
                qp_s,
            ]),
            Self::Amf => args.extend([
                "-rc".into(),
                "cqp".into(),
                "-qp_i".into(),
                qp_s.clone(),
                "-qp_p".into(),
                qp_s,
            ]),
            Self::Vaapi => args.extend(["-rc_mode".into(), "CQP".into(), "-qp".into(), qp_s]),
        }
        if let Some(g) = gop.filter(|&v| v > 0) {
            args.extend(["-g".into(), g.to_string()]);
        }
        if codec == Codec::Hevc {
            args.extend(["-tag:v".into(), "hvc1".into()]);
        }
        args
    }

    /// 3-frame smoke probe using the exact BT.709/tv filter graph and tags.
    pub fn works(self, ffmpeg: &Path, codec: Codec) -> bool {
        let mut filters = vec!["format=yuv420p".to_owned(), color::tag_filter()];
        if let Some(upload) = self.upload_filter() {
            filters.push(upload.to_owned());
        }
        let mut cmd = Command::new(ffmpeg);
        cmd.args(["-hide_banner", "-nostdin", "-v", "error"])
            .args(self.global_args())
            .args(["-f", "lavfi", "-i", "color=black:s=256x256:r=30"])
            .args(["-frames:v", "3", "-vf", &filters.join(",")])
            .args(self.args(codec, 23, None));
        if let Some(pf) = self.pix_fmt() {
            cmd.args(["-pix_fmt", pf]);
        }
        cmd.args(color::tag_args())
            .args(["-f", "null", "-"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        cmd.status().is_ok_and(|s| s.success())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncoderSpec {
    Software {
        codec: Codec,
        crf: u32,
        preset: String,
        gop: Option<u32>,
    },
    Hardware {
        backend: Backend,
        codec: Codec,
        crf: u32,
        gop: Option<u32>,
    },
}

impl EncoderSpec {
    pub fn label(&self) -> String {
        match self {
            Self::Software { codec: Codec::Hevc, .. } => "libx265".to_owned(),
            Self::Software { codec: Codec::H264, .. } => "libx264".to_owned(),
            Self::Hardware { backend, codec, .. } => backend.encoder_name(*codec),
        }
    }

    pub fn global_args(&self) -> Vec<String> {
        match self {
            Self::Software { .. } => Vec::new(),
            Self::Hardware { backend, .. } => backend.global_args(),
        }
    }

    pub fn pix_fmt(&self) -> Option<&'static str> {
        match self {
            Self::Software { .. } => Some("yuv420p"),
            Self::Hardware { backend, .. } => backend.pix_fmt(),
        }
    }

    pub fn upload_filter(&self) -> Option<&'static str> {
        match self {
            Self::Software { .. } => None,
            Self::Hardware { backend, .. } => backend.upload_filter(),
        }
    }

    pub fn filter_chain(&self, convert: bool, output_size: Option<(u32, u32)>) -> String {
        let mut parts = Vec::new();
        if convert {
            parts.push(color::scale_filter(output_size));
        }
        parts.push(color::tag_filter());
        if let Some(pf) = self.pix_fmt() {
            parts.push(format!("format={pf}"));
        }
        if let Some(upload) = self.upload_filter() {
            parts.push(upload.to_owned());
        }
        parts.join(",")
    }

    pub fn output_args(&self, filters: &str) -> Vec<String> {
        let mut args = vec!["-vf".to_owned(), filters.to_owned()];
        match self {
            Self::Software {
                codec: Codec::H264,
                crf,
                preset,
                gop,
            } => {
                args.extend([
                    "-c:v".into(),
                    "libx264".into(),
                    "-preset".into(),
                    preset.clone(),
                    "-crf".into(),
                    crf.to_string(),
                    "-x264-params".into(),
                    "aq-mode=3:deblock=2,2:rc-lookahead=20".into(),
                ]);
                if let Some(g) = gop.filter(|&v| v > 0) {
                    args.extend(["-g".into(), g.to_string()]);
                }
            }
            Self::Software {
                codec: Codec::Hevc,
                crf,
                preset,
                gop,
            } => {
                args.extend([
                    "-c:v".into(),
                    "libx265".into(),
                    "-preset".into(),
                    preset.clone(),
                    "-crf".into(),
                    crf.to_string(),
                    "-x265-params".into(),
                    "log-level=error".into(),
                    "-tag:v".into(),
                    "hvc1".into(),
                ]);
                if let Some(g) = gop.filter(|&v| v > 0) {
                    args.extend(["-g".into(), g.to_string()]);
                }
            }
            Self::Hardware {
                backend,
                codec,
                crf,
                gop,
            } => {
                args.extend(backend.args(*codec, *crf, *gop));
            }
        }
        if let Some(pf) = self.pix_fmt() {
            args.extend(["-pix_fmt".into(), pf.to_owned()]);
        }
        args.extend(color::tag_args().into_iter().map(str::to_owned));
        args
    }

    pub fn fallback_software(&self) -> Self {
        match self {
            Self::Software {
                codec, crf, gop, ..
            } => Self::Software {
                codec: *codec,
                crf: *crf,
                preset: "veryfast".to_owned(),
                gop: *gop,
            },
            Self::Hardware {
                codec, crf, gop, ..
            } => Self::Software {
                codec: *codec,
                crf: *crf,
                preset: if *codec == Codec::H264 {
                    "veryfast".to_owned()
                } else {
                    "medium".to_owned()
                },
                gop: *gop,
            },
        }
    }
}

pub fn available_hardware(ffmpeg: &Path, codec: Codec) -> Vec<Backend> {
    Backend::candidates()
        .iter()
        .copied()
        .filter(|b| b.works(ffmpeg, codec))
        .collect()
}

pub fn resolve_encoder(
    ffmpeg: &Path,
    choice: &str,
    codec: Codec,
    crf: u32,
    preset: Option<&str>,
    gop: Option<u32>,
) -> EncoderSpec {
    let lower = choice.to_ascii_lowercase();
    if lower == "libx264" {
        return EncoderSpec::Software {
            codec: Codec::H264,
            crf,
            preset: preset.unwrap_or("veryfast").to_owned(),
            gop,
        };
    }
    if lower == "libx265" {
        return EncoderSpec::Software {
            codec: Codec::Hevc,
            crf,
            preset: preset.unwrap_or("medium").to_owned(),
            gop,
        };
    }
    if lower == "cpu" || lower == "software" {
        let default_preset = if codec == Codec::H264 { "veryfast" } else { "medium" };
        return EncoderSpec::Software {
            codec,
            crf,
            preset: preset.unwrap_or(default_preset).to_owned(),
            gop,
        };
    }
    if let Some(backend) = Backend::from_name(&lower) {
        return EncoderSpec::Hardware {
            backend,
            codec,
            crf,
            gop,
        };
    }
    // "auto": probe platform hardware encoders in priority order, fallback to software
    for &backend in Backend::candidates() {
        if backend.works(ffmpeg, codec) {
            return EncoderSpec::Hardware {
                backend,
                codec,
                crf,
                gop,
            };
        }
    }
    let default_preset = if codec == Codec::H264 { "veryfast" } else { "medium" };
    EncoderSpec::Software {
        codec,
        crf,
        preset: preset.unwrap_or(default_preset).to_owned(),
        gop,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoder_specs_include_bt709_tags_and_gop() {
        let sw = EncoderSpec::Software {
            codec: Codec::H264,
            crf: 23,
            preset: "veryfast".into(),
            gop: Some(240),
        };
        let filters = sw.filter_chain(true, None);
        assert_eq!(
            filters,
            "scale=flags=bicubic:out_color_matrix=bt709:out_range=tv,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709,format=yuv420p"
        );
        let args = sw.output_args(&filters);
        assert!(args.windows(2).any(|w| w == ["-c:v", "libx264"]));
        assert!(args.windows(2).any(|w| w == ["-g", "240"]));
        assert!(args.windows(2).any(|w| w == ["-colorspace", "bt709"]));

        let qsv = EncoderSpec::Hardware {
            backend: Backend::Qsv,
            codec: Codec::Hevc,
            crf: 25,
            gop: Some(240),
        };
        let qsv_args = qsv.output_args(&qsv.filter_chain(false, None));
        assert!(qsv_args.windows(2).any(|w| w == ["-c:v", "hevc_qsv"]));
        assert!(qsv_args.windows(2).any(|w| w == ["-global_quality", "25"]));
        assert!(qsv_args.windows(2).any(|w| w == ["-tag:v", "hvc1"]));
        assert!(qsv_args.windows(2).any(|w| w == ["-pix_fmt", "nv12"]));
    }
}
