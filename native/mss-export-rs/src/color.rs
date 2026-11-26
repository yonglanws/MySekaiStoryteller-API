//! BT.709 limited-range color standard & fixed-point RGBA -> YUV420p converter.
//! Modeled directly on SekaiStoryExporter `sse-export/src/color.rs` (ADR-0022)
//! and `sse-render/src/yuv.rs` (ADR-0023).

pub const STANDARD: &str = "bt709";
pub const RANGE: &str = "tv";

/// RGB -> BT.709 limited-range conversion filter (with optional Lanczos scaling).
pub fn scale_filter(size: Option<(u32, u32)>) -> String {
    let scaling = match size {
        Some((w, h)) => format!("{w}:{h}:flags=lanczos"),
        None => "flags=bicubic".to_owned(),
    };
    format!("scale={scaling}:out_color_matrix={STANDARD}:out_range={RANGE}")
}

/// Tag filter for ffmpeg 9+ (which reads primaries/trc from frame side-data).
pub fn tag_filter() -> String {
    format!(
        "setparams=range={RANGE}:colorspace={STANDARD}:color_primaries={STANDARD}:color_trc={STANDARD}"
    )
}

/// Output / rawvideo input color tags for all ffmpeg versions.
pub fn tag_args() -> [&'static str; 8] {
    [
        "-colorspace",
        STANDARD,
        "-color_primaries",
        STANDARD,
        "-color_trc",
        STANDARD,
        "-color_range",
        RANGE,
    ]
}

/// Validates even encode dimensions required by 4:2:0 (`yuv420p` / `nv12`).
pub fn check_encode_size(width: u32, height: u32) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err(format!(
            "Invalid encode size: {width}x{height}; width and height must be positive."
        ));
    }
    if width % 2 != 0 || height % 2 != 0 {
        return Err(format!(
            "Invalid encode size: {width}x{height}; yuv420p requires even width and height."
        ));
    }
    Ok(())
}

/// Exact ADR-0023 fixed-point BT.709 limited-range RGBA -> YUV420p (I420) conversion.
/// Left-sited chroma (6-tap horizontal 1:2:1 across two rows, weights sum to 8).
/// Produces bit-exact output matching SekaiStoryExporter's `sse_render::yuv::frame`.
pub fn rgba_to_yuv420p_bt709_tv(rgba: &[u8], width: u32, height: u32, out: &mut Vec<u8>) -> Result<(), String> {
    check_encode_size(width, height)?;
    let w = width as usize;
    let h = height as usize;
    let expected_in = w * h * 4;
    if rgba.len() != expected_in {
        return Err(format!(
            "RGBA buffer length mismatch: got {}, expected {} for {}x{}",
            rgba.len(),
            expected_in,
            width,
            height
        ));
    }

    let cw = w / 2;
    let ch = h / 2;
    let y_len = w * h;
    let uv_len = cw * ch;
    out.resize(y_len + uv_len * 2, 0);

    let (y_plane, uv_planes) = out.split_at_mut(y_len);
    let (u_plane, v_plane) = uv_planes.split_at_mut(uv_len);

    // Luma plane: Y' = (11966*R + 40254*G + 4064*B + 16*2^16 + 2^15) >> 16
    const Y_BIAS: i32 = (16 << 16) + (1 << 15);
    for (dst, px) in y_plane.iter_mut().zip(rgba.chunks_exact(4)) {
        let r = i32::from(px[0]);
        let g = i32::from(px[1]);
        let b = i32::from(px[2]);
        let y = (11966 * r + 40254 * g + 4064 * b + Y_BIAS) >> 16;
        *dst = y.clamp(16, 235) as u8;
    }

    // Chroma planes: left-sited 6-tap filter (weights 1, 2, 1 horizontally x 2 rows = 8)
    const UV_BIAS: i32 = (128 << 19) + (1 << 18);
    let row_stride = w * 4;
    for cy in 0..ch {
        let r0 = (cy * 2) * row_stride;
        let r1 = (cy * 2 + 1) * row_stride;
        let u_row = &mut u_plane[cy * cw..(cy + 1) * cw];
        let v_row = &mut v_plane[cy * cw..(cy + 1) * cw];
        for cx in 0..cw {
            let x_mid = cx * 2;
            let x_left = x_mid.saturating_sub(1);
            let x_right = (x_mid + 1).min(w - 1);

            let o0_l = r0 + x_left * 4;
            let o0_m = r0 + x_mid * 4;
            let o0_r = r0 + x_right * 4;
            let o1_l = r1 + x_left * 4;
            let o1_m = r1 + x_mid * 4;
            let o1_r = r1 + x_right * 4;

            let sr = i32::from(rgba[o0_l])
                + 2 * i32::from(rgba[o0_m])
                + i32::from(rgba[o0_r])
                + i32::from(rgba[o1_l])
                + 2 * i32::from(rgba[o1_m])
                + i32::from(rgba[o1_r]);
            let sg = i32::from(rgba[o0_l + 1])
                + 2 * i32::from(rgba[o0_m + 1])
                + i32::from(rgba[o0_r + 1])
                + i32::from(rgba[o1_l + 1])
                + 2 * i32::from(rgba[o1_m + 1])
                + i32::from(rgba[o1_r + 1]);
            let sb = i32::from(rgba[o0_l + 2])
                + 2 * i32::from(rgba[o0_m + 2])
                + i32::from(rgba[o0_r + 2])
                + i32::from(rgba[o1_l + 2])
                + 2 * i32::from(rgba[o1_m + 2])
                + i32::from(rgba[o1_r + 2]);

            let cb = (-6596 * sr - 22188 * sg + 28784 * sb + UV_BIAS) >> 19;
            let cr = (28784 * sr - 26145 * sg - 2639 * sb + UV_BIAS) >> 19;
            u_row[cx] = cb.clamp(16, 240) as u8;
            v_row[cx] = cr.clamp(16, 240) as u8;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_and_tags_match_sse_export() {
        assert_eq!(
            scale_filter(None),
            "scale=flags=bicubic:out_color_matrix=bt709:out_range=tv"
        );
        assert_eq!(
            scale_filter(Some((1920, 1080))),
            "scale=1920:1080:flags=lanczos:out_color_matrix=bt709:out_range=tv"
        );
        assert_eq!(
            tag_filter(),
            "setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709"
        );
        assert_eq!(
            tag_args().join(" "),
            "-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv"
        );
    }

    #[test]
    fn six_solid_patches_match_bt709_tv_exact() {
        let cases: [([u8; 3], [u8; 3]); 6] = [
            ([255, 0, 0], [63, 102, 240]),
            ([0, 255, 0], [173, 42, 26]),
            ([0, 0, 255], [32, 240, 118]),
            ([255, 255, 255], [235, 128, 128]),
            ([0, 0, 0], [16, 128, 128]),
            ([128, 128, 128], [126, 128, 128]),
        ];
        let mut out = Vec::new();
        for (rgb, want) in cases {
            let mut rgba = Vec::with_capacity(4 * 4 * 4);
            for _ in 0..16 {
                rgba.extend_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
            }
            rgba_to_yuv420p_bt709_tv(&rgba, 4, 4, &mut out).unwrap();
            assert_eq!(out.len(), 4 * 4 + 2 * 2 * 2);
            assert_eq!([out[0], out[16], out[20]], want, "rgb={rgb:?}");
        }
    }
}
