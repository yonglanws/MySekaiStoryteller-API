/**
 * 阶段 B 六色块探针：全范围 H.264 输入经导出收尾的 BT.709/tv 重编码后，
 * 解码回 yuv420p 的 Y/U/V 必须落在参考实现给出的 BT.709 limited-range
 * 常量 ±1 内。
 *
 * 参考完整 export 需要 Live2DCubismCore.dll，本机没有；但参考仓库自带的
 * ignored 测试只走 YUV 转换 + ffmpeg 收尾，不依赖 Cubism，已用
 * `cargo test -p sse-export --lib ffmpeg_encodes_bt709_limited_range -- --ignored`
 * 跑出参考像素（软件 H.264 与 QSV 硬件均为同一组值）。下面的
 * REFERENCE_BT709 就是那次运行的软件 H.264 结果，用于和 MSST 做逐色块 ±1 对比。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const ffmpeg = require('../../out-host/shared/ffmpeg.js')

const PATCH = 128
const PATCHES = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 255],
  [0, 0, 0],
  [128, 128, 128]
]
/** 参考 ffmpeg_encodes_bt709_limited_range 的实测 Y/U/V（顺序同 PATCHES）。 */
const REFERENCE_BT709 = [
  [63, 102, 240],
  [173, 42, 26],
  [32, 240, 118],
  [235, 128, 128],
  [16, 128, 128],
  [126, 128, 128]
]

/** 参考实现：BT.709 矩阵 + 有限范围（Y 16-235，Cb/Cr 16-240）。 */
function expectedBt709(rgb) {
  const [kr, kb] = [0.2126, 0.0722]
  const [r, g, b] = rgb.map((value) => value / 255)
  const y = kr * r + (1 - kr - kb) * g + kb * b
  return [
    16 + 219 * y,
    128 + (224 * (b - y)) / (2 * (1 - kb)),
    128 + (224 * (r - y)) / (2 * (1 - kr))
  ].map(Math.round)
}

function rgbaPatches(width, height) {
  const frame = Buffer.allocUnsafe(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = Math.floor(y / (height / 2)) * 3 + Math.floor(x / (width / 3))
      const [r, g, b] = PATCHES[index]
      const offset = (y * width + x) * 4
      frame[offset] = r
      frame[offset + 1] = g
      frame[offset + 2] = b
      frame[offset + 3] = 255
    }
  }
  return frame
}

test('six solid patches stay within ±1 of BT.709 limited-range through the export transcode path', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'msst-color-blocks-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const inputPath = path.join(dir, 'webcodecs-full-range.mp4')
  const rawPath = path.join(dir, 'patches.rgba')
  const outputPath = path.join(dir, 'bt709-tv.mp4')
  const width = PATCH * 3
  const height = PATCH * 2

  // 模拟 WebCodecs 硬编产物：BT.709 矩阵 + full range（yuvj420p/pc）。
  const frame = rgbaPatches(width, height)
  await writeFile(rawPath, frame)
  await execFileAsync(
    ffmpeg.ffmpegPath(),
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-s',
      `${width}x${height}`,
      '-r',
      '30',
      '-i',
      rawPath,
      '-vf',
      'scale=out_color_matrix=bt709:out_range=pc,format=yuvj420p',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-qp',
      '0',
      '-pix_fmt',
      'yuvj420p',
      '-colorspace',
      'bt709',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'iec61966-2-1',
      '-color_range',
      'pc',
      '-an',
      inputPath
    ],
    { maxBuffer: 8 * 1024 * 1024 }
  )

  // 走正式收尾的同一套滤镜/标记：RGB→BT.709、full→tv、H.264 编码。
  // 默认用确定性的 CPU H.264；MSST_COLOR_BLOCK_HEVC=1 时走生产配置的 auto/HEVC。
  const useHevc = process.env.MSST_COLOR_BLOCK_HEVC === '1'
  await ffmpeg.apiConvertVideoWithCompression(
    inputPath,
    outputPath,
    18,
    30,
    useHevc ? 'auto' : 'cpu',
    width,
    height,
    width,
    height,
    8_000_000,
    useHevc ? 'hevc' : 'h264'
  )

  const probe = await execFileAsync(ffmpeg.ffmpegPath(), ['-hide_banner', '-i', outputPath], {
    maxBuffer: 8 * 1024 * 1024
  }).catch((error) => error)
  const stderr = String(probe.stderr ?? '')
  assert.match(stderr, /yuv420p\(tv, bt709/, stderr)

  const { stdout } = await execFileAsync(
    ffmpeg.ffmpegPath(),
    [
      '-loglevel',
      'error',
      '-i',
      outputPath,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'yuv420p',
      '-'
    ],
    { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 }
  )
  const cw = width / 2
  const ch = height / 2
  assert.equal(stdout.length, width * height + 2 * cw * ch)

  const measured = []
  for (let n = 0; n < PATCHES.length; n++) {
    const x = (n % 3) * (width / 3) + width / 6
    const y = Math.floor(n / 3) * (height / 2) + height / 4
    const chroma = Math.floor(y / 2) * cw + Math.floor(x / 2)
    const [Y, U, V] = [
      stdout[y * width + x],
      stdout[width * height + chroma],
      stdout[width * height + cw * ch + chroma]
    ]
    const want = expectedBt709(PATCHES[n])
    const reference = REFERENCE_BT709[n]
    measured.push({ patch: PATCHES[n], got: [Y, U, V], want, reference })
    assert.ok(
      Math.abs(Y - want[0]) <= 1 && Math.abs(U - want[1]) <= 1 && Math.abs(V - want[2]) <= 1,
      `patch ${n} ${JSON.stringify(PATCHES[n])}: got [${Y},${U},${V}], want [${want}] (±1)`
    )
    assert.ok(
      Math.abs(Y - reference[0]) <= 1 &&
        Math.abs(U - reference[1]) <= 1 &&
        Math.abs(V - reference[2]) <= 1,
      `patch ${n} ${JSON.stringify(PATCHES[n])}: got [${Y},${U},${V}], reference [${reference}] (±1)`
    )
  }
  if (process.env.MSST_COLOR_BLOCK_VERBOSE) {
    console.log(JSON.stringify(measured))
  }
})
