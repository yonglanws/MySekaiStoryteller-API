import { spawn, execFile, ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import path from 'node:path'
import { ILogObj, Logger } from 'tslog'

const logger: Logger<ILogObj> = new Logger({
  name: 'ffmpeg',
  type: 'pretty',
  prettyLogTemplate:
    '[{{yyyy}}-{{mm}}-{{dd}} {{hh}}:{{MM}}:{{ss}}:{{ms}}][{{logLevelName}}][{{name}}]: ',
  prettyLogTimeZone: 'local'
})

/**
 * ffmpeg 可执行文件解析顺序：
 * 1. MSS_FFMPEG_PATH 环境变量
 * 2. ffmpeg-static npm 包（如已安装）
 * 3. PATH 上的 ffmpeg / ffmpeg.exe
 *
 * 候选二进制必须真实存在且有执行位——ffmpeg-static 下载中断/被杀时
 * 会留下一个无执行位的半截文件（还被打开写入时 spawn 直接 ETXTBSY），
 * 此时必须回退系统 ffmpeg，而不是让整个宿主的导出全挂。
 */
export function ffmpegPath(): string {
  const candidates: string[] = []
  if (process.env.MSS_FFMPEG_PATH) {
    candidates.push(process.env.MSS_FFMPEG_PATH)
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffmpegStatic = require('ffmpeg-static') as string | null
    if (ffmpegStatic) {
      candidates.push(ffmpegStatic)
    }
  } catch {
    // ffmpeg-static 未安装，回退到 PATH
  }

  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate)
      // Windows 上 Node 的 stat 不反映 POSIX 执行位（mode 恒为 666/444），
      // 存在即可用；POSIX 上必须显式检查执行位——root 下 access(X_OK)
      // 对任何存在的文件都成功，而截断的 ffmpeg-static 下载正是 644 且会段错误
      const executable =
        process.platform === 'win32' ? stat.isFile() : stat.isFile() && (stat.mode & 0o111) !== 0
      if (executable) {
        return candidate
      }
      logger.warn(
        `ffmpeg candidate not usable (missing or not executable): ${candidate}, trying next`
      )
    } catch {
      logger.warn(
        `ffmpeg candidate not usable (missing or not executable): ${candidate}, trying next`
      )
    }
  }

  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
}

export async function checkFFmpegAvailable(): Promise<boolean> {
  const result = await checkFFmpegAvailableWithVersion()
  return result.available
}

export async function checkFFmpegAvailableWithVersion(): Promise<{
  available: boolean
  version?: string
}> {
  return new Promise((resolve) => {
    execFile(ffmpegPath(), ['-version'], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve({ available: false })
      } else {
        const versionMatch = stdout.match(/ffmpeg version ([\d.]+)/)
        resolve({
          available: true,
          version: versionMatch ? versionMatch[1] : 'unknown'
        })
      }
    })
  })
}

/**
 * 导出视频的色彩标准（对齐 sse-export/src/color.rs）：BT.709 矩阵、BT.709 原色与传递函数、
 * 有限范围（limited/tv）。ffmpeg 默认按 BT.601 把 RGBA 转成 YUV 且不写色彩标签，
 * 播放器对未标记的 HD 视频按 BT.709 解释，于是颜色整体偏移；这里把所有出帧路径
 * 显式钉到同一标准。
 */
const BT709_STANDARD = 'bt709'
const BT709_RANGE = 'tv'

/** RGB→YUV 转换滤镜；带尺寸时缩放与转换合成一个滤镜（Lanczos），恒等尺寸只转换（bicubic）。 */
export function colorScaleFilter(size?: { width: number; height: number }): string {
  const scaling = size ? `${size.width}:${size.height}:flags=lanczos` : 'flags=bicubic'
  return `scale=${scaling}:out_color_matrix=${BT709_STANDARD}:out_range=${BT709_RANGE}`
}

/** 标记帧的色彩参数；ffmpeg 9 从原色/传递函数推导，早版本靠输出选项。 */
export function colorTagFilter(): string {
  return (
    `setparams=range=${BT709_RANGE}:colorspace=${BT709_STANDARD}` +
    `:color_primaries=${BT709_STANDARD}:color_trc=${BT709_STANDARD}`
  )
}

/** 与 tag_filter 等价的输出选项，老版本 ffmpeg 只认这一组。 */
export function colorTagArgs(): string[] {
  return [
    '-colorspace',
    BT709_STANDARD,
    '-color_primaries',
    BT709_STANDARD,
    '-color_trc',
    BT709_STANDARD,
    '-color_range',
    BT709_RANGE
  ]
}

export type VideoCodec = 'hevc' | 'h264'

export function normalizeVideoCodec(value: string | null | undefined): VideoCodec {
  return value === 'h264' ? 'h264' : 'hevc'
}

/** 导出前置校验失败：在加载模型、合成 TTS 之前以可读消息拒绝。 */
export class ExportValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExportValidationError'
  }
}

/**
 * 4:2:0 视频要求宽高均为偶数；在交给 ffmpeg 之前拒绝，避免编码半程才失败
 * （对齐 sse-export/src/lib.rs check_encode_size / sse-render yuv::check_size）。
 */
export function checkEncodeSize(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new ExportValidationError(
      `Invalid encode size: ${width}x${height}; width and height must be positive integers.`
    )
  }
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new ExportValidationError(
      `Invalid encode size: ${width}x${height}; yuv420p requires even width and height.`
    )
  }
}

/**
 * 导出帧区间至少包含一帧（对齐 check_range）：from 必须小于 to。
 */
export function checkFrameRange(from: number, to: number): void {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0) {
    throw new ExportValidationError(
      `Invalid frame range: from=${from}, to=${to}; both must be non-negative integers.`
    )
  }
  if (from >= to) {
    throw new ExportValidationError(
      `Empty frame range: from=${from}, to=${to}; from must be less than to.`
    )
  }
}

/** 帧数/fps 的介质时长，六位小数（与参考 audio_args 的 `{:.6}` 一致）。 */
export function frameDurationSeconds(frames: number, fps: number): string {
  if (!Number.isFinite(frames) || !Number.isFinite(fps) || frames <= 0 || fps <= 0) {
    throw new ExportValidationError(`Invalid frame duration: frames=${frames}, fps=${fps}`)
  }
  return (frames / fps).toFixed(6)
}

/**
 * 目标路径旁的写盘临时文件：`ep.mp4` → `ep.partial.mp4`（扩展名保留，ffmpeg 据此选容器）。
 * 对齐 sse-export/src/lib.rs partial_path。
 */
export function partialOutputPath(outputPath: string): string {
  const ext = path.extname(outputPath)
  return ext ? `${outputPath.slice(0, -ext.length)}.partial${ext}` : `${outputPath}.partial`
}

/** 读取 WAV 头的 data 块时长（秒）；不是 WAV 或块不完整时返回 null。 */
export async function readWavDurationSeconds(wavPath: string): Promise<number | null> {
  try {
    const handle = await fs.promises.open(wavPath, 'r')
    try {
      const buf = Buffer.alloc(4096)
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
      if (bytesRead < 44) return null
      if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
        return null
      }
      let offset = 12
      let byteRate = 0
      while (offset + 8 <= bytesRead) {
        const id = buf.toString('ascii', offset, offset + 4)
        const size = buf.readUInt32LE(offset + 4)
        if (id === 'fmt ' && offset + 20 <= bytesRead) {
          byteRate = buf.readUInt32LE(offset + 16)
        } else if (id === 'data') {
          if (!byteRate) return null
          return size / byteRate
        }
        offset += 8 + size + (size % 2)
      }
      return null
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

export type GpuRenderer = 'auto' | 'nvidia' | 'amd' | 'intel' | 'cpu'

/**
 * 视频编码器选择：
 * - 'auto'：探测 nvenc/amf/qsv，均不可用则回退 libx264
 * - 'libx264'：强制 CPU 编码（与旧版 API 导出行为一致）
 * - 指定名称：强制使用对应硬件编码器，失败自动回退 CPU
 */
export type VideoEncoderChoice = GpuRenderer | 'libx264'

const STDERR_LIMIT = 16 * 1024
const SMOKE_PROBE_TIMEOUT_MS = 10_000
/** 探测用尺寸/帧数：真编 3 帧，和正式导出走同一套滤镜、标记与 pix_fmt。 */
const SMOKE_PROBE_SIZE = { width: 256, height: 256 }
const SMOKE_PROBE_FRAMES = 3

type GpuBackend = 'nvidia' | 'amd' | 'intel'
type DetectedEncoder = GpuBackend | 'cpu'

/**
 * 编码器探测缓存：按 (binary, codec, 后端, 尺寸) 缓存真实冒烟编码结果。
 * 同一次进程内 HEVC 与 H.264 各自探测、互不覆盖。
 */
const gpuSmokeCache = new Map<string, Promise<boolean>>()
const detectedEncoderByCodec = new Map<VideoCodec, DetectedEncoder>()
let cachedEncoderChoice: DetectedEncoder | null = null
let cachedEncoderBinary: string | null = null

/** 已缓存探测结果时同步返回（health 上报用）；未探测过返回 null */
export function getCachedGpuEncoder(): DetectedEncoder | null {
  return cachedEncoderChoice
}

/** 测试或运行时回退时清空/失效失败的 GPU 编码器缓存（两种 codec 一起失效）。 */
export function invalidateGpuEncoder(encoder: GpuBackend, binary: string = ffmpegPath()): void {
  for (const key of Array.from(gpuSmokeCache.keys())) {
    const parts = key.split('\0')
    if (parts[0] === binary && parts[2] === encoder) {
      gpuSmokeCache.delete(key)
    }
  }
  for (const [codec, choice] of detectedEncoderByCodec) {
    if (choice === encoder) detectedEncoderByCodec.delete(codec)
  }
  if (cachedEncoderChoice === encoder) {
    cachedEncoderChoice = null
  }
}

export function resetGpuEncoderCache(): void {
  gpuSmokeCache.clear()
  detectedEncoderByCodec.clear()
  cachedEncoderChoice = null
  cachedEncoderBinary = null
}

function gpuNameFromCodec(codec: string): GpuBackend | null {
  if (codec === 'h264_nvenc' || codec === 'hevc_nvenc') return 'nvidia'
  if (codec === 'h264_amf' || codec === 'hevc_amf') return 'amd'
  if (codec === 'h264_qsv' || codec === 'hevc_qsv') return 'intel'
  return null
}

function runSmokeProbe(binary: string, encoder: GpuBackend, codec: VideoCodec): Promise<boolean> {
  const size = SMOKE_PROBE_SIZE
  const key = `${binary}\0${codec}\0${encoder}\0${size.width}x${size.height}`
  const existing = gpuSmokeCache.get(key)
  if (existing) return existing

  const encArgs = getGpuEncoderArgs(encoder, 23, codec)
  // 与正式导出一致的滤镜链：BT.709 转换（恒等尺寸 bicubic）+ 标记 + format=pix_fmt
  const filters = buildVideoFilterChain({
    inputWidth: size.width,
    inputHeight: size.height,
    outputWidth: size.width,
    outputHeight: size.height,
    pixFmt: encArgs.pixFmt
  })
  const startedAt = Date.now()
  const probeArgs = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-nostats',
    '-f',
    'lavfi',
    '-i',
    `color=black:s=${size.width}x${size.height}:r=30`,
    '-frames:v',
    String(SMOKE_PROBE_FRAMES),
    ...videoEncoderOutputArgs(encArgs, filters),
    '-f',
    'null',
    '-'
  ]

  const promise = new Promise<boolean>((resolve) => {
    let settled = false
    const child = spawn(binary, probeArgs, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGKILL')
        resolve(false)
      }
    }, SMOKE_PROBE_TIMEOUT_MS)
    timer.unref?.()

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_LIMIT)
    })

    child.once('close', (code) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      const elapsed = Date.now() - startedAt
      if (code === 0) {
        logger.info(`GPU smoke probe OK: ${encArgs.codec} in ${elapsed}ms`)
        resolve(true)
      } else {
        if (stderr.trim()) {
          logger.debug(`GPU smoke probe failed for ${encArgs.codec}: ${stderr.trim()}`)
        }
        resolve(false)
      }
    })

    child.once('error', () => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        resolve(false)
      }
    })
  })

  gpuSmokeCache.set(key, promise)
  return promise
}

export async function detectAvailableGpuEncoder(
  codec: VideoCodec = 'hevc'
): Promise<DetectedEncoder> {
  const binary = ffmpegPath()
  const cached = detectedEncoderByCodec.get(codec)
  if (cached && cachedEncoderBinary === binary) {
    return cached
  }

  // Windows 上按 NVENC → QSV → AMF 顺序（同 sse-export hardware::Backend::candidates）
  const gpuEncoders = [
    { name: 'nvidia', codec: 'nvenc' },
    { name: 'intel', codec: 'qsv' },
    { name: 'amd', codec: 'amf' }
  ] as const

  const detectedCodec = codec === 'hevc' ? 'hevc' : 'h264'
  for (const encoder of gpuEncoders) {
    try {
      const ok = await runSmokeProbe(binary, encoder.name, codec)
      if (ok) {
        const name = `${detectedCodec}_${encoder.codec}`
        logger.info(`Detected GPU encoder (smoke probe OK): ${name} (${encoder.name})`)
        detectedEncoderByCodec.set(codec, encoder.name)
        cachedEncoderChoice = encoder.name
        cachedEncoderBinary = binary
        return encoder.name
      }
    } catch {
      continue
    }
  }

  logger.info(`No working ${detectedCodec} GPU encoder detected, falling back to CPU encoding`)
  detectedEncoderByCodec.set(codec, 'cpu')
  cachedEncoderChoice = 'cpu'
  cachedEncoderBinary = binary
  return 'cpu'
}

/**
 * libx264 暗部渐变：默认 AQ 在淡出至黑时会把近黑色块量化成可见方块。
 * aq-mode=3（auto-variance with bias to dark）把码率让给暗部，不改 CRF。
 *
 * 参考实现（sse-export Codec::H264）用 -threads 4 与 rc-lookahead=20 限制 x264
 * 的帧线程和前瞻队列（2560×1600 下默认值会占数 GB）；这里把两组参数合并进同一份
 * -x264-params，不能为了 rc-lookahead 覆盖掉暗部去块参数。
 */
function libx264Args(crf: number): string[] {
  return [
    '-crf',
    String(crf),
    '-threads',
    '4',
    '-x264-params',
    'aq-mode=3:deblock=2,2:rc-lookahead=20'
  ]
}

/** libx265 默认 medium 已前瞻 20 帧；压掉它每帧的日志（参考 X265_PARAMS）。 */
function libx265Args(crf: number): string[] {
  return ['-crf', String(crf), '-x265-params', 'log-level=error']
}

export interface VideoEncoderArgs {
  codec: string
  preset: string
  pixFmt: string
  args: string[]
  needsQsvInit: boolean
}

/** 软件编码：配置 codec 决定 libx265 / libx264，均用 medium preset（参考 Codec::args）。 */
function softwareEncoderArgs(codec: VideoCodec, crf: number, preset = 'medium'): VideoEncoderArgs {
  if (codec === 'hevc') {
    return {
      codec: 'libx265',
      preset,
      pixFmt: 'yuv420p',
      // -tag:v hvc1 让 Apple 播放器按 HEVC 打开（参考 Codec::Hevc）
      args: [...libx265Args(crf), '-tag:v', 'hvc1'],
      needsQsvInit: false
    }
  }
  return {
    codec: 'libx264',
    preset,
    pixFmt: 'yuv420p',
    args: libx264Args(crf),
    needsQsvInit: false
  }
}

export function getGpuEncoderArgs(
  gpuRenderer: 'auto' | 'nvidia' | 'amd' | 'intel' | 'cpu' = 'auto',
  crf: number = 18,
  codec: VideoCodec = 'hevc'
): VideoEncoderArgs {
  const videoCodec = normalizeVideoCodec(codec)
  const hevc = videoCodec === 'hevc'
  switch (gpuRenderer) {
    case 'nvidia':
      return {
        codec: hevc ? 'hevc_nvenc' : 'h264_nvenc',
        preset: 'p4',
        pixFmt: 'yuv420p',
        args: ['-cq', String(crf), '-b:v', '0', ...(hevc ? ['-tag:v', 'hvc1'] : [])],
        needsQsvInit: false
      }
    case 'amd':
      return {
        codec: hevc ? 'hevc_amf' : 'h264_amf',
        preset: 'quality',
        pixFmt: 'yuv420p',
        args: [
          '-qp_i',
          String(crf),
          '-qp_p',
          String(crf),
          '-qp_b',
          String(crf),
          ...(hevc ? ['-tag:v', 'hvc1'] : [])
        ],
        needsQsvInit: false
      }
    case 'intel':
      // 系统内存输入下 QSV 自行初始化编码设备，无需 hw_upload / -init_hw_device
      return {
        codec: hevc ? 'hevc_qsv' : 'h264_qsv',
        preset: 'medium',
        pixFmt: 'nv12',
        args: ['-global_quality', String(crf), ...(hevc ? ['-tag:v', 'hvc1'] : [])],
        needsQsvInit: false
      }
    case 'cpu':
      return softwareEncoderArgs(videoCodec, crf)
    case 'auto':
    default:
      return softwareEncoderArgs(videoCodec, crf)
  }
}

/**
 * 解析 VideoEncoderChoice 为具体编码器参数。
 * - `libx264` 是旧版显式 CPU 选项，保持不变：强制 H.264。
 * - `cpu` / `auto` / 具体 GPU 后端跟随 video.codec（默认 HEVC）。
 */
export async function resolveVideoEncoderArgs(
  choice: VideoEncoderChoice,
  crf: number,
  codec: VideoCodec = 'hevc'
): Promise<VideoEncoderArgs> {
  if (choice === 'libx264') {
    return softwareEncoderArgs('h264', crf)
  }
  if (choice === 'cpu') {
    return softwareEncoderArgs(normalizeVideoCodec(codec), crf)
  }

  const detected = choice === 'auto' ? await detectAvailableGpuEncoder(codec) : choice
  return getGpuEncoderArgs(detected, crf, codec)
}

export interface VideoFilterOptions {
  inputWidth: number
  inputHeight: number
  outputWidth: number
  outputHeight: number
  pixFmt: string
  /** false：帧已在 GPU 转成编码尺寸的 BT.709 yuv420p，只需要标记（参考 Convert::Gpu）。 */
  convert?: boolean
}

/**
 * 滤镜链：RGB→BT.709 转换（缩放时 Lanczos 与转换合成一个滤镜）+ 色彩标记 + 编码像素格式。
 * 恒等尺寸也保留 scale 滤镜——它同时负责矩阵转换与 out_range=tv。
 */
export function buildVideoFilterChain(options: VideoFilterOptions): string {
  const parts: string[] = []
  if (options.convert !== false) {
    const identity =
      options.inputWidth === options.outputWidth && options.inputHeight === options.outputHeight
    parts.push(
      identity
        ? colorScaleFilter()
        : colorScaleFilter({ width: options.outputWidth, height: options.outputHeight })
    )
  }
  parts.push(colorTagFilter())
  parts.push(`format=${options.pixFmt}`)
  return parts.join(',')
}

/**
 * 编码器的输出参数（`-vf` 之后到 pixel format 与色彩标记）。
 * 正式导出与硬件探测共用这一份派生，避免探测通过、导出却因参数不同失败。
 */
export function videoEncoderOutputArgs(selection: VideoEncoderArgs, filters: string): string[] {
  return [
    '-vf',
    filters,
    '-c:v',
    selection.codec,
    '-preset',
    selection.preset,
    '-pix_fmt',
    selection.pixFmt,
    ...selection.args,
    ...colorTagArgs()
  ]
}

export async function runFfmpegWithProgress(
  ffmpegArgs: string[],
  totalDuration: number,
  onProgress?: (percent: number, message: string) => void
): Promise<void> {
  logger.info(`FFmpeg args: ${ffmpegArgs.join(' ')}`)

  const timeoutMs = Math.max(totalDuration * 3, 120) * 1000

  // 并发 spawn 同一 ffmpeg 二进制在 Node posix_spawn 下偶发 ETXTBSY/EAGAIN
  // （负载高时更频繁），小间隔重试即可恢复
  const maxAttempts = 3
  let lastError: Error | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await spawnFfmpegOnce(ffmpegArgs, totalDuration, timeoutMs, onProgress)
      return
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      const retriable =
        lastError.message.includes('ETXTBSY') || lastError.message.includes('EAGAIN')
      if (retriable && attempt < maxAttempts) {
        const delay = attempt * 500
        logger.warn(`FFmpeg spawn failed (${lastError.message}), retrying in ${delay}ms`)
        await new Promise((resolve) => setTimeout(resolve, delay))
        continue
      }
      throw lastError
    }
  }
  throw lastError ?? new Error('FFmpeg failed')
}

function spawnFfmpegOnce(
  ffmpegArgs: string[],
  totalDuration: number,
  timeoutMs: number,
  onProgress?: (percent: number, message: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpegProcess: ChildProcess = spawn(ffmpegPath(), ffmpegArgs, {
      windowsHide: true
    })

    let stderrData = ''
    let settled = false

    const timeoutTimer = setTimeout(() => {
      if (!settled) {
        settled = true
        ffmpegProcess.kill('SIGKILL')
        reject(new Error(`FFmpeg timed out after ${timeoutMs / 1000}s`))
      }
    }, timeoutMs)

    ffmpegProcess.stderr?.on('data', (data) => {
      const text = data.toString()
      stderrData = (stderrData + text).slice(-STDERR_LIMIT)
      const progressMatch = text.match(/time=(\d{2}):(\d{2}):(\d{2})/)
      if (progressMatch && totalDuration > 0) {
        const hours = parseInt(progressMatch[1])
        const minutes = parseInt(progressMatch[2])
        const seconds = parseInt(progressMatch[3])
        const currentTime = hours * 3600 + minutes * 60 + seconds
        const progress = Math.min((currentTime / totalDuration) * 100, 100)
        onProgress?.(progress, `编码中... ${progress.toFixed(1)}%`)
      }
    })

    ffmpegProcess.on('close', (code) => {
      clearTimeout(timeoutTimer)
      if (settled) return
      settled = true
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`FFmpeg exited with code ${code}\n${stderrData}`))
      }
    })

    ffmpegProcess.on('error', (err) => {
      clearTimeout(timeoutTimer)
      if (settled) return
      settled = true
      reject(
        new Error(
          `Failed to start FFmpeg: ${err.message}. Please ensure FFmpeg is installed and in your PATH.`
        )
      )
    })
  })
}

/**
 * 解析收尾转码的滤镜链：
 * - 输入与输出完全一致时仍挂 scale 滤镜（无尺寸参数、bicubic），由它完成 RGB→BT.709
 *   与 out_range=tv 的转换——不再返回 null 省略 -vf（参考 color::scale_filter(None)）。
 * - 尺寸不同时用 Lanczos 缩放，缩放与颜色转换合成一个滤镜。
 */
export function resolveOutputScaleFilter(
  inputWidth: number,
  inputHeight: number,
  outputWidth: number,
  outputHeight: number,
  _needsQsvInit = false
): { filter: string; skip: boolean } {
  const identity = inputWidth === outputWidth && inputHeight === outputHeight
  return {
    filter: identity
      ? colorScaleFilter()
      : colorScaleFilter({ width: outputWidth, height: outputHeight }),
    skip: identity
  }
}

/** 输出音轨的截断参数：优先精确的 frames/fps，缺帧数时退回 WAV 头时长。 */
async function audioTruncationArgs(
  frameCount: number | undefined,
  fps: number,
  audioPath: string
): Promise<string[]> {
  if (frameCount && frameCount > 0 && fps > 0) {
    return ['-t', frameDurationSeconds(frameCount, fps)]
  }
  const wavDuration = await readWavDurationSeconds(audioPath)
  return wavDuration && wavDuration > 0 ? ['-t', wavDuration.toFixed(6)] : []
}

/**
 * API 导出收尾：视频（无音轨）转码压缩为 MP4。
 * 分辨率归一 + BT.709 转换/标记 + 可选编码器。
 */
export async function apiConvertVideoWithCompression(
  inputPath: string,
  outputPath: string,
  crf: number = 23,
  fps: number = 30,
  encoder: VideoEncoderChoice = 'libx264',
  width: number,
  height: number,
  inputWidth: number = width,
  inputHeight: number = height,
  recordedBitrate: number = 8_000_000,
  codec: VideoCodec = 'hevc',
  frameCount?: number
): Promise<void> {
  const stat = await fs.promises.stat(inputPath)
  const estimatedDuration = Math.max(stat.size / (recordedBitrate / 8), 10)

  const encoderArgs = await resolveVideoEncoderArgs(encoder, crf, codec)
  logger.info(`API video conversion using encoder: ${encoderArgs.codec} (${encoder}), CRF=${crf}`)

  const filters = buildVideoFilterChain({
    inputWidth,
    inputHeight,
    outputWidth: width,
    outputHeight: height,
    pixFmt: encoderArgs.pixFmt
  })

  const ffmpegArgs = [
    '-i',
    inputPath,
    ...videoEncoderOutputArgs(encoderArgs, filters),
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-r',
    String(fps),
    ...(frameCount && frameCount > 0 ? ['-t', frameDurationSeconds(frameCount, fps)] : []),
    '-movflags',
    '+faststart',
    '-y',
    outputPath
  ]

  try {
    await runFfmpegWithProgress(ffmpegArgs, estimatedDuration)
  } catch (error) {
    const fallbackCodec: VideoCodec = encoder === 'libx264' ? 'h264' : normalizeVideoCodec(codec)
    const fallback = softwareEncoderArgs(fallbackCodec, crf, 'fast')
    if (encoderArgs.codec === fallback.codec) {
      logger.warn('API video conversion failed, trying with fast preset:', error)
      const fallbackArgs = [
        '-i',
        inputPath,
        ...videoEncoderOutputArgs(
          fallback,
          buildVideoFilterChain({
            inputWidth,
            inputHeight,
            outputWidth: width,
            outputHeight: height,
            pixFmt: fallback.pixFmt
          })
        ),
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-r',
        String(fps),
        '-movflags',
        '+faststart',
        '-y',
        outputPath
      ]
      await runFfmpegWithProgress(fallbackArgs, estimatedDuration)
    } else {
      const failedGpu = gpuNameFromCodec(encoderArgs.codec)
      if (failedGpu) invalidateGpuEncoder(failedGpu)
      logger.warn(
        `API video conversion failed with ${encoderArgs.codec}, falling back to CPU:`,
        error
      )
      await apiConvertVideoWithCompression(
        inputPath,
        outputPath,
        crf,
        fps,
        'cpu',
        width,
        height,
        inputWidth,
        inputHeight,
        recordedBitrate,
        codec
      )
    }
  }
}

/**
 * API 导出收尾：视频 + 音频合流压缩为 MP4。
 * 输出分辨率由 width/height 决定（BT.709 转换 + Lanczos 缩放），音频 AAC 192k 为默认；
 * 用 `-t frames/fps` 精确截断，不再用 -shortest（参考 audio_args）。
 */
export async function apiMergeVideoAudioWithCompression(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  crf: number = 23,
  audioBitrate: string = '192k',
  fps: number = 30,
  encoder: VideoEncoderChoice = 'libx264',
  width: number,
  height: number,
  inputWidth: number = width,
  inputHeight: number = height,
  recordedBitrate: number = 8_000_000,
  codec: VideoCodec = 'hevc',
  frameCount?: number
): Promise<void> {
  const videoStat = await fs.promises.stat(videoPath)
  const estimatedDuration = Math.max(videoStat.size / (recordedBitrate / 8), 10)

  const encoderArgs = await resolveVideoEncoderArgs(encoder, crf, codec)
  logger.info(`API video-audio merge using encoder: ${encoderArgs.codec} (${encoder}), CRF=${crf}`)

  const filters = buildVideoFilterChain({
    inputWidth,
    inputHeight,
    outputWidth: width,
    outputHeight: height,
    pixFmt: encoderArgs.pixFmt
  })
  const truncationArgs = await audioTruncationArgs(frameCount, fps, audioPath)

  const buildArgs = (selection: VideoEncoderArgs, filterChain: string): string[] => [
    '-i',
    videoPath,
    '-i',
    audioPath,
    ...videoEncoderOutputArgs(selection, filterChain),
    '-c:a',
    'aac',
    '-b:a',
    audioBitrate,
    '-r',
    String(fps),
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    ...truncationArgs,
    '-movflags',
    '+faststart',
    '-y',
    outputPath
  ]

  const ffmpegArgs = buildArgs(encoderArgs, filters)
  logger.info(`[API] Merge with compression: ${ffmpegArgs.join(' ')}`)

  try {
    await runFfmpegWithProgress(ffmpegArgs, estimatedDuration)
  } catch (error) {
    const fallbackCodec: VideoCodec = encoder === 'libx264' ? 'h264' : normalizeVideoCodec(codec)
    const fallback = softwareEncoderArgs(fallbackCodec, crf, 'fast')
    if (encoderArgs.codec === fallback.codec) {
      logger.warn('API video-audio merge failed, trying with fast preset:', error)
      await runFfmpegWithProgress(
        buildArgs(
          fallback,
          buildVideoFilterChain({
            inputWidth,
            inputHeight,
            outputWidth: width,
            outputHeight: height,
            pixFmt: fallback.pixFmt
          })
        ),
        estimatedDuration
      )
    } else {
      const failedGpu = gpuNameFromCodec(encoderArgs.codec)
      if (failedGpu) invalidateGpuEncoder(failedGpu)
      logger.warn(`API merge failed with ${encoderArgs.codec}, falling back to CPU:`, error)
      await apiMergeVideoAudioWithCompression(
        videoPath,
        audioPath,
        outputPath,
        crf,
        audioBitrate,
        fps,
        'cpu',
        width,
        height,
        inputWidth,
        inputHeight,
        recordedBitrate,
        codec,
        frameCount
      )
    }
  }
}

export interface VideoAudioMuxOptions {
  /** 视频帧数；给出时用 `-t frames/fps` 精确截断（参考 audio_args）。 */
  frameCount?: number
  /** 视频帧率；与 frameCount 一起决定截断时长。 */
  fps?: number
  /** 视频从故事的哪一帧开始（断点续传）；音频输入按该帧的样本位置起播。 */
  startFrame?: number
}

/**
 * fast 导出收尾：已编码的 MP4（WebCodecs 页内编码）与 WAV 音频 remux。
 * 视频流直接 copy 不再二次编码，仅音频转 AAC 192k；用 -t 精确截断而非 -shortest，
 * 混音起点按首个视频帧的样本位置对齐（参考 sse-export export_mix / audio_args）。
 */
export async function apiMuxVideoAudioCopy(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  audioBitrate: string = '192k',
  options: VideoAudioMuxOptions = {}
): Promise<void> {
  const stat = await fs.promises.stat(videoPath)
  const estimatedDuration = Math.max(stat.size / (8000000 / 8), 10)
  const { frameCount, fps, startFrame = 0 } = options

  const audioInputArgs: string[] = []
  if (startFrame > 0 && fps && fps > 0) {
    audioInputArgs.push('-ss', frameDurationSeconds(startFrame, fps))
  }
  const truncationArgs =
    frameCount && frameCount > 0 && fps && fps > 0
      ? ['-t', frameDurationSeconds(frameCount, fps)]
      : await audioTruncationArgs(undefined, fps ?? 0, audioPath)

  const ffmpegArgs = [
    '-i',
    videoPath,
    ...audioInputArgs,
    '-i',
    audioPath,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    audioBitrate,
    ...truncationArgs,
    '-movflags',
    '+faststart',
    '-y',
    outputPath
  ]

  await runFfmpegWithProgress(ffmpegArgs, estimatedDuration)
}

/**
 * fast 导出收尾：无音轨时仅重写容器（加 faststart），视频流 copy。
 */
export async function apiCopyVideo(
  inputPath: string,
  outputPath: string,
  frameCount?: number,
  fps?: number
): Promise<void> {
  const stat = await fs.promises.stat(inputPath)
  const estimatedDuration = Math.max(stat.size / (8000000 / 8), 10)

  const ffmpegArgs = [
    '-i',
    inputPath,
    '-c:v',
    'copy',
    ...(frameCount && frameCount > 0 && fps && fps > 0
      ? ['-t', frameDurationSeconds(frameCount, fps)]
      : []),
    '-movflags',
    '+faststart',
    '-y',
    outputPath
  ]

  await runFfmpegWithProgress(ffmpegArgs, estimatedDuration)
}

/** '128k' / '1.5M' / '96000' → bps；无法解析返回 fallback */
export function parseBitrateToBps(value: string, fallback = 128_000): number {
  const m = /^\s*([\d.]+)\s*([kKmM]?)\s*$/.exec(value)
  if (!m) return fallback
  const n = parseFloat(m[1])
  if (!Number.isFinite(n) || n <= 0) return fallback
  const unit = m[2].toLowerCase()
  return Math.round(unit === 'm' ? n * 1_000_000 : unit === 'k' ? n * 1000 : n)
}

/**
 * 按目标码率编码的视频参数（VBR + 峰值约束）；不支持的硬件编码器按 libx264 处理。
 * peakRatio 为 maxrate 相对 -b:v 的倍数：1 时 VBV 保证长期均值不超过目标码率。
 */
function targetBitrateVideoArgs(
  gpu: 'nvidia' | 'amd' | 'intel' | 'cpu',
  videoBps: number,
  peakRatio: number
): string[] {
  const kbps = Math.max(1, Math.round(videoBps / 1000))
  const rate = [
    '-b:v',
    `${kbps}k`,
    '-maxrate',
    `${Math.round(kbps * peakRatio)}k`,
    '-bufsize',
    `${kbps * 2}k`
  ]
  if (gpu === 'nvidia') {
    return [
      '-c:v',
      'h264_nvenc',
      '-preset',
      'p5',
      '-tune',
      'hq',
      '-profile:v',
      'high',
      '-rc',
      'vbr',
      '-multipass',
      'qres',
      ...rate,
      '-bf',
      '3',
      '-rc-lookahead',
      '32',
      '-spatial-aq',
      '1',
      '-temporal-aq',
      '1',
      '-pix_fmt',
      'yuv420p'
    ]
  }
  if (gpu === 'amd') {
    return [
      '-c:v',
      'h264_amf',
      '-quality',
      'quality',
      '-rc',
      'vbr_peak',
      ...rate,
      '-pix_fmt',
      'yuv420p'
    ]
  }
  return [
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    ...rate,
    '-x264-params',
    'aq-mode=3:deblock=2,2',
    '-pix_fmt',
    'yuv420p'
  ]
}

/**
 * record 流拷贝路径的体积保险：录制产物超出目标体积时，按精确码率重编码视频并合流。
 * 保持录制分辨率与原始时间戳（不缩放、不补帧），与流拷贝产物同形；
 * 硬件编码失败回退 libx264。
 *
 * 编码器的 VBR 均值对 -b:v 并不精确（NVENC 实测 maxrate 2 倍时超出 8%、
 * 1.2 倍时低 9%）：先按 1.2 倍峰值编一遍，成片仍超 maxOutputBytes 时按超出
 * 比例降码率、峰值压到目标码率再编一遍（VBV 约束长期均值不超目标）。
 */
export async function apiEncodeVideoAudioToBitrate(
  videoPath: string,
  audioPath: string | undefined,
  outputPath: string,
  audioBitrate: string,
  encoder: VideoEncoderChoice,
  videoBps: number,
  durationSec: number,
  maxOutputBytes = 0
): Promise<void> {
  let gpu: 'nvidia' | 'amd' | 'intel' | 'cpu' =
    encoder === 'libx264' || encoder === 'cpu'
      ? 'cpu'
      : encoder === 'auto'
        ? await detectAvailableGpuEncoder()
        : encoder === 'nvidia' || encoder === 'amd' || encoder === 'intel'
          ? encoder
          : 'cpu'

  const build = (g: 'nvidia' | 'amd' | 'intel' | 'cpu', bps: number, peak: number): string[] => [
    '-i',
    videoPath,
    ...(audioPath ? ['-i', audioPath, '-map', '0:v:0', '-map', '1:a:0'] : ['-map', '0:v:0']),
    ...targetBitrateVideoArgs(g, bps, peak),
    '-fps_mode',
    'passthrough',
    ...(audioPath ? ['-c:a', 'aac', '-b:a', audioBitrate, '-t', durationSec.toFixed(6)] : []),
    '-movflags',
    '+faststart',
    '-y',
    outputPath
  ]

  const encodeOnce = async (bps: number, peak: number): Promise<void> => {
    logger.info(
      `[API] Size-capped re-encode: encoder=${gpu}, videoBitrate=${(bps / 1_000_000).toFixed(2)}Mbps, ` +
        `peak=${peak}x, duration=${durationSec.toFixed(1)}s`
    )
    try {
      await runFfmpegWithProgress(build(gpu, bps, peak), Math.max(durationSec, 10))
    } catch (error) {
      if (gpu === 'cpu') throw error
      invalidateGpuEncoder(gpu)
      logger.warn(`Size-capped re-encode failed with ${gpu}, falling back to libx264:`, error)
      gpu = 'cpu'
      await runFfmpegWithProgress(build(gpu, bps, peak), Math.max(durationSec, 10))
    }
  }

  await encodeOnce(videoBps, 1.2)
  if (maxOutputBytes > 0) {
    const size = (await fs.promises.stat(outputPath)).size
    if (size > maxOutputBytes) {
      await encodeOnce(Math.floor((videoBps * maxOutputBytes * 0.95) / size), 1)
    }
  }
}

/**
 * 帧序列合成 MP4（fast 导出 JPEG 帧路径使用）。
 * 画布可能大于目标分辨率（renderScale 超采样）：Lanczos 缩放与 BT.709 转换合成一个滤镜；
 * 恒等尺寸也保留滤镜以完成矩阵转换与 out_range=tv。
 * 返回实际编码的帧数（可用作 `-t frames/fps` 的帧数来源）。
 */
export async function encodeFramesToVideo(
  fps: number,
  framesDir: string,
  outputPath: string,
  encoder: VideoEncoderChoice = 'auto',
  width: number,
  height: number,
  crf: number = 23,
  inputWidth: number = 0,
  inputHeight: number = 0,
  codec: VideoCodec = 'hevc'
): Promise<number> {
  checkEncodeSize(width, height)
  const entries = await fs.promises.readdir(framesDir)
  const sampleFiles = entries.filter((f) => f.startsWith('frame-'))
  let framePattern = 'frame-%06d.png'
  if (sampleFiles.some((f) => f.endsWith('.jpg') || f.endsWith('.jpeg'))) {
    framePattern = 'frame-%06d.jpg'
  }
  const frameCount = sampleFiles.length
  if (frameCount === 0) {
    throw new ExportValidationError(`No frames to encode in ${framesDir}`)
  }
  const estimatedDuration = Math.max(frameCount / Math.max(1, fps), 10)

  const encoderArgs = await resolveVideoEncoderArgs(encoder, crf, codec)
  const filters = buildVideoFilterChain({
    inputWidth,
    inputHeight,
    outputWidth: width,
    outputHeight: height,
    pixFmt: encoderArgs.pixFmt
  })

  const ffmpegArgs = [
    '-framerate',
    String(fps),
    '-i',
    `${framesDir}/${framePattern}`,
    ...videoEncoderOutputArgs(encoderArgs, filters),
    '-movflags',
    '+faststart',
    '-y',
    outputPath
  ]

  try {
    await runFfmpegWithProgress(ffmpegArgs, estimatedDuration)
  } catch (error) {
    const failedGpu = gpuNameFromCodec(encoderArgs.codec)
    if (failedGpu) {
      invalidateGpuEncoder(failedGpu)
      logger.warn(`Frame encoding failed with ${encoderArgs.codec}, falling back to CPU:`, error)
      return encodeFramesToVideo(
        fps,
        framesDir,
        outputPath,
        'cpu',
        width,
        height,
        crf,
        inputWidth,
        inputHeight,
        codec
      )
    }
    throw error
  }
  return frameCount
}

export type FramePipeFormat = 'mjpeg' | 'rawvideo'

export interface FramesPipeSessionOptions {
  fps: number
  width: number
  height: number
  inputWidth?: number
  inputHeight?: number
  crf?: number
  encoder?: VideoEncoderChoice
  codec?: VideoCodec
  outputPath: string
  /**
   * 帧输入格式：
   * - `mjpeg`（默认）：浏览器 JPEG 帧，宿主 ffmpeg 解码后做 BT.709 转换；
   * - `rawvideo`：渲染端离屏 WebGL2 pass 已转好编码尺寸的 BT.709 yuv420p（每帧 1.5×W×H）。
   */
  frameFormat?: FramePipeFormat
  /** 导出的起始/结束帧（含起始、不含结束）；用于入口校验，from 必须小于 to。 */
  fromFrame?: number
  toFrame?: number
}

/**
 * 流式帧编码会话：
 * - MJPEG image2pipe：把浏览器拍出的 JPEG 帧通过 stdin 喂给 FFmpeg；
 * - rawvideo yuv420p：GPU 端已转换的 4:2:0 帧直接入管道（参考 ADR-0023）。
 */
export class FramesPipeSession {
  readonly outputPath: string
  private readonly child: ChildProcess
  private readonly done: Promise<void>
  private readonly encoderCodec: string
  private readonly frameBytes: number
  private stderr = ''
  private error: Error | null = null
  private settled = false
  private eofSent = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private finishTimer: ReturnType<typeof setTimeout> | null = null
  private queue: Promise<void> = Promise.resolve()
  private frames = 0

  private constructor(
    child: ChildProcess,
    outputPath: string,
    encoderCodec: string,
    frameBytes: number
  ) {
    this.child = child
    this.outputPath = outputPath
    this.encoderCodec = encoderCodec
    this.frameBytes = frameBytes
    this.done = new Promise<void>((resolve, reject) => {
      this.child.stdin?.on('error', (err) => {
        this.error ??= err
      })
      this.child.stderr?.on('data', (chunk: Buffer) => {
        this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_LIMIT)
      })
      this.child.once('error', (err) => {
        this.error ??= err
      })
      this.child.once('close', (code, signal) => {
        this.clearTimers()
        if (this.settled) return
        this.settled = true
        if (code === 0 && this.eofSent && !this.error) {
          resolve()
          return
        }
        const gpu = gpuNameFromCodec(this.encoderCodec)
        if (gpu) invalidateGpuEncoder(gpu)
        const baseMsg =
          this.error?.message ??
          (code !== 0
            ? `FFmpeg image2pipe exited with code ${code} (${signal ?? 'no signal'})`
            : 'FFmpeg image2pipe closed before EOF')
        reject(new Error(`${baseMsg}\n${this.stderr}`))
      })
    })
    void this.done.catch(() => {})
    this.touchIdle()
  }

  /** 已写入管道的帧数（MJPEG 每次 write 一帧；rawvideo 按帧字节拆分）。 */
  get frameCount(): number {
    return this.frames
  }

  static async create(options: FramesPipeSessionOptions): Promise<FramesPipeSession> {
    checkEncodeSize(options.width, options.height)
    if (options.fromFrame !== undefined || options.toFrame !== undefined) {
      checkFrameRange(options.fromFrame ?? 0, options.toFrame ?? Number.MAX_SAFE_INTEGER)
    }
    const crf = options.crf ?? 23
    const codec = normalizeVideoCodec(options.codec)
    const encoderArgs = await resolveVideoEncoderArgs(options.encoder ?? 'auto', crf, codec)
    const frameFormat: FramePipeFormat = options.frameFormat === 'rawvideo' ? 'rawvideo' : 'mjpeg'
    const inputW =
      frameFormat === 'rawvideo' ? options.width : (options.inputWidth ?? options.width)
    const inputH =
      frameFormat === 'rawvideo' ? options.height : (options.inputHeight ?? options.height)

    const filters = buildVideoFilterChain({
      inputWidth: inputW,
      inputHeight: inputH,
      outputWidth: options.width,
      outputHeight: options.height,
      pixFmt: encoderArgs.pixFmt,
      // rawvideo 已是编码尺寸的 BT.709 yuv420p：只标记，不再缩放/转换
      convert: frameFormat !== 'rawvideo'
    })

    const inputArgs =
      frameFormat === 'rawvideo'
        ? [
            '-f',
            'rawvideo',
            '-pix_fmt',
            'yuv420p',
            '-s',
            `${options.width}x${options.height}`,
            ...colorTagArgs(),
            '-r',
            String(options.fps),
            '-i',
            'pipe:0'
          ]
        : [
            '-f',
            'image2pipe',
            '-vcodec',
            'mjpeg',
            '-framerate',
            String(options.fps),
            '-i',
            'pipe:0'
          ]

    const args = [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'warning',
      '-nostats',
      '-y',
      ...inputArgs,
      ...videoEncoderOutputArgs(encoderArgs, filters),
      '-movflags',
      '+faststart',
      options.outputPath
    ]

    const child = spawn(ffmpegPath(), args, {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe']
    })
    const frameBytes = frameFormat === 'rawvideo' ? (options.width * options.height * 3) / 2 : 0
    return new FramesPipeSession(child, options.outputPath, encoderArgs.codec, frameBytes)
  }

  private clearTimers(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (this.finishTimer) {
      clearTimeout(this.finishTimer)
      this.finishTimer = null
    }
  }

  private touchIdle(): void {
    if (this.settled) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      void this.abort(new Error('FFmpeg image2pipe idle timeout'))
    }, 120_000)
    this.idleTimer.unref?.()
  }

  write(chunk: Buffer): Promise<void> {
    if (this.frameBytes > 0 && chunk.length % this.frameBytes !== 0) {
      return Promise.reject(
        new ExportValidationError(
          `Invalid rawvideo chunk: ${chunk.length} bytes is not a multiple of ${this.frameBytes} ` +
            '(yuv420p frame size)'
        )
      )
    }
    const task = this.queue.then(async () => {
      if (this.settled) throw this.error ?? new Error('FFmpeg image2pipe closed')
      if (this.error) throw this.error
      if (!chunk.length) return
      this.touchIdle()
      await new Promise<void>((resolve, reject) => {
        const stdin = this.child.stdin
        if (!stdin || stdin.destroyed) {
          reject(this.error ?? new Error('FFmpeg image2pipe stdin unavailable'))
          return
        }
        stdin.write(chunk, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
      this.frames += this.frameBytes > 0 ? chunk.length / this.frameBytes : 1
    })
    this.queue = task.catch((err) => {
      this.error ??= err instanceof Error ? err : new Error(String(err))
    })
    return task
  }

  async finish(timeoutMs = 300_000): Promise<string> {
    await this.queue
    if (this.error) throw this.error
    if (!this.settled) {
      this.eofSent = true
      this.finishTimer = setTimeout(() => {
        void this.abort(new Error('FFmpeg image2pipe finish timeout'))
      }, timeoutMs)
      this.finishTimer.unref?.()
      this.child.stdin?.end()
    }
    await this.done
    return this.outputPath
  }

  async abort(reason = new Error('FFmpeg image2pipe cancelled')): Promise<void> {
    this.error ??= reason
    this.clearTimers()
    if (!this.settled) {
      this.child.stdin?.destroy()
      this.child.kill('SIGKILL')
    }
    await this.done.catch(() => {})
    await fs.promises.rm(this.outputPath, { force: true }).catch(() => {})
  }
}

export function createFramesPipeSession(
  options: FramesPipeSessionOptions
): Promise<FramesPipeSession> {
  return FramesPipeSession.create(options)
}
