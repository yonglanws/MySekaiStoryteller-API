import { spawn, execFile, ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
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

/** 编码器探测结果缓存：按 binary+encoder 缓存真实 1 帧冒烟编码结果 */
const gpuSmokeCache = new Map<string, Promise<boolean>>()
let cachedEncoderChoice: 'nvidia' | 'amd' | 'intel' | 'cpu' | null = null
let cachedEncoderBinary: string | null = null

/** 已缓存探测结果时同步返回（health 上报用）；未探测过返回 null */
export function getCachedGpuEncoder(): 'nvidia' | 'amd' | 'intel' | 'cpu' | null {
  return cachedEncoderChoice
}

/** 测试或运行时回退时清空/失效失败的 GPU 编码器缓存 */
export function invalidateGpuEncoder(
  encoder: 'nvidia' | 'amd' | 'intel',
  binary: string = ffmpegPath()
): void {
  gpuSmokeCache.set(`${binary}\0${encoder}`, Promise.resolve(false))
  if (cachedEncoderChoice === encoder) {
    cachedEncoderChoice = null
  }
}

export function resetGpuEncoderCache(): void {
  gpuSmokeCache.clear()
  cachedEncoderChoice = null
  cachedEncoderBinary = null
}

function gpuNameFromCodec(codec: string): 'nvidia' | 'amd' | 'intel' | null {
  if (codec === 'h264_nvenc') return 'nvidia'
  if (codec === 'h264_amf') return 'amd'
  if (codec === 'h264_qsv') return 'intel'
  return null
}

function runSmokeProbe(binary: string, encoder: 'nvidia' | 'amd' | 'intel'): Promise<boolean> {
  const key = `${binary}\0${encoder}`
  const existing = gpuSmokeCache.get(key)
  if (existing) return existing

  const encArgs = getGpuEncoderArgs(encoder, 23)
  const probeArgs = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-nostats',
    '-f',
    'lavfi',
    '-i',
    'color=size=640x360:rate=30',
    '-frames:v',
    '1',
    '-c:v',
    encArgs.codec,
    '-preset',
    encArgs.preset,
    '-pix_fmt',
    encArgs.pixFmt,
    ...encArgs.args,
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
      if (code === 0) {
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

export async function detectAvailableGpuEncoder(): Promise<'nvidia' | 'amd' | 'intel' | 'cpu'> {
  const binary = ffmpegPath()
  if (cachedEncoderChoice && cachedEncoderBinary === binary) {
    return cachedEncoderChoice
  }

  const gpuEncoders = [
    { name: 'nvidia', codec: 'h264_nvenc' },
    { name: 'amd', codec: 'h264_amf' },
    { name: 'intel', codec: 'h264_qsv' }
  ] as const

  for (const encoder of gpuEncoders) {
    try {
      const ok = await runSmokeProbe(binary, encoder.name)
      if (ok) {
        logger.info(`Detected GPU encoder (smoke probe OK): ${encoder.codec} (${encoder.name})`)
        cachedEncoderChoice = encoder.name
        cachedEncoderBinary = binary
        return encoder.name
      }
    } catch {
      continue
    }
  }

  logger.info('No working GPU encoder detected, falling back to CPU encoding')
  cachedEncoderChoice = 'cpu'
  cachedEncoderBinary = binary
  return 'cpu'
}

/**
 * libx264 暗部渐变：默认 AQ 在淡出至黑时会把近黑色块量化成可见方块。
 * aq-mode=3（auto-variance with bias to dark）把码率让给暗部，不改 CRF。
 */
function libx264Args(crf: number): string[] {
  // aq-mode=3 把码率让给暗部；deblock 偏强，压淡出至黑时的方块边缘。
  return ['-crf', String(crf), '-x264-params', 'aq-mode=3:deblock=2,2']
}

export function getGpuEncoderArgs(
  gpuRenderer: 'auto' | 'nvidia' | 'amd' | 'intel' | 'cpu' = 'auto',
  crf: number = 18
): {
  codec: string
  preset: string
  pixFmt: string
  args: string[]
  needsQsvInit: boolean
} {
  switch (gpuRenderer) {
    case 'nvidia':
      return {
        codec: 'h264_nvenc',
        preset: 'p4',
        pixFmt: 'yuv420p',
        args: ['-cq', String(crf), '-b:v', '0'],
        needsQsvInit: false
      }
    case 'amd':
      return {
        codec: 'h264_amf',
        preset: 'quality',
        pixFmt: 'yuv420p',
        args: ['-qp_i', String(crf), '-qp_p', String(crf), '-qp_b', String(crf)],
        needsQsvInit: false
      }
    case 'intel':
      // 系统内存输入下 QSV 自行初始化编码设备，无需 hw_upload / -init_hw_device
      return {
        codec: 'h264_qsv',
        preset: 'medium',
        pixFmt: 'nv12',
        args: ['-global_quality', String(crf)],
        needsQsvInit: false
      }
    case 'cpu':
      return {
        codec: 'libx264',
        preset: 'fast',
        pixFmt: 'yuv420p',
        args: libx264Args(crf),
        needsQsvInit: false
      }
    case 'auto':
    default:
      return {
        codec: 'libx264',
        preset: 'fast',
        pixFmt: 'yuv420p',
        args: libx264Args(crf),
        needsQsvInit: false
      }
  }
}

/**
 * 解析 VideoEncoderChoice 为具体编码器参数。
 * 'libx264' 与 'cpu' 均映射为 libx264 + medium preset（旧版 API 导出的固定行为）。
 */
export async function resolveVideoEncoderArgs(
  choice: VideoEncoderChoice,
  crf: number
): Promise<{
  codec: string
  preset: string
  pixFmt: string
  args: string[]
  needsQsvInit: boolean
}> {
  if (choice === 'libx264' || choice === 'cpu') {
    return {
      codec: 'libx264',
      preset: 'medium',
      pixFmt: 'yuv420p',
      args: libx264Args(crf),
      needsQsvInit: false
    }
  }

  const detected = choice === 'auto' ? await detectAvailableGpuEncoder() : choice
  return getGpuEncoderArgs(detected, crf)
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

/** 输出缩放滤镜：按配置分辨率归一，异形输入等比缩放并居中 pad */
function outputScaleFilter(width: number, height: number): string {
  return (
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`
  )
}

/**
 * 解析收尾转码的缩放滤镜：
 * - 输入与输出完全一致（renderScale=1.0 时画布即输出分辨率）→ 返回 null，
 *   连 -vf 都不挂。恒等缩放仍要付出完整一遍 解码→缩放→编码 的成本。
 */
export function resolveOutputScaleFilter(
  inputWidth: number,
  inputHeight: number,
  outputWidth: number,
  outputHeight: number,
  _needsQsvInit = false
): { filter: string | null; skip: boolean } {
  const identity =
    inputWidth === outputWidth &&
    inputHeight === outputHeight &&
    inputWidth % 2 === 0 &&
    inputHeight % 2 === 0

  if (identity) {
    return { filter: null, skip: true }
  }
  return { filter: outputScaleFilter(outputWidth, outputHeight), skip: false }
}

/**
 * API 导出收尾：视频（无音轨）转码压缩为 MP4。
 * 与旧版 IpcHandler 行为一致（等比缩放 + pad、-r fps），仅编码器改为可选。
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
  recordedBitrate: number = 8_000_000
): Promise<void> {
  const stat = await fs.promises.stat(inputPath)
  const estimatedDuration = Math.max(stat.size / (recordedBitrate / 8), 10)

  const encoderArgs = await resolveVideoEncoderArgs(encoder, crf)
  logger.info(`API video conversion using encoder: ${encoderArgs.codec} (${encoder}), CRF=${crf}`)

  const { filter: scale, skip: skipScale } = resolveOutputScaleFilter(
    inputWidth,
    inputHeight,
    width,
    height
  )
  if (skipScale) {
    logger.info(
      `API video conversion: input ${inputWidth}x${inputHeight} matches output, skipping scale filter`
    )
  }

  const vfArgs = scale ? ['-vf', scale] : []

  const ffmpegArgs = [
    '-i',
    inputPath,
    ...vfArgs,
    '-c:v',
    encoderArgs.codec,
    '-preset',
    encoderArgs.preset,
    '-pix_fmt',
    encoderArgs.pixFmt,
    ...encoderArgs.args,
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-r',
    String(fps),
    '-movflags',
    '+faststart',
    '-y',
    outputPath
  ]

  try {
    await runFfmpegWithProgress(ffmpegArgs, estimatedDuration)
  } catch (error) {
    if (encoderArgs.codec === 'libx264') {
      logger.warn('API video conversion failed, trying with fast preset:', error)
      const fallbackArgs = [
        '-i',
        inputPath,
        ...vfArgs,
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-pix_fmt',
        'yuv420p',
        ...libx264Args(crf),
        '-c:a',
        'aac',
        '-b:a',
        '128k',
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
        'libx264',
        width,
        height,
        inputWidth,
        inputHeight,
        recordedBitrate
      )
    }
  }
}

/**
 * API 导出收尾：视频 + 音频合流压缩为 MP4。
 * 输出分辨率由 width/height 决定（等比缩放 + pad），仅编码器可选。
 */
export async function apiMergeVideoAudioWithCompression(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  crf: number = 23,
  audioBitrate: string = '128k',
  fps: number = 30,
  encoder: VideoEncoderChoice = 'libx264',
  width: number,
  height: number,
  inputWidth: number = width,
  inputHeight: number = height,
  recordedBitrate: number = 8_000_000
): Promise<void> {
  const videoStat = await fs.promises.stat(videoPath)
  const estimatedDuration = Math.max(videoStat.size / (recordedBitrate / 8), 10)

  const encoderArgs = await resolveVideoEncoderArgs(encoder, crf)
  logger.info(`API video-audio merge using encoder: ${encoderArgs.codec} (${encoder}), CRF=${crf}`)

  const { filter: scale, skip: skipScale } = resolveOutputScaleFilter(
    inputWidth,
    inputHeight,
    width,
    height
  )
  if (skipScale) {
    logger.info(
      `API video-audio merge: input ${inputWidth}x${inputHeight} matches output, skipping scale filter`
    )
  }

  const vfArgs = scale ? ['-vf', scale] : []

  const ffmpegArgs = [
    '-i',
    videoPath,
    '-i',
    audioPath,
    ...vfArgs,
    '-c:v',
    encoderArgs.codec,
    '-preset',
    encoderArgs.preset,
    '-pix_fmt',
    encoderArgs.pixFmt,
    ...encoderArgs.args,
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
    '-shortest',
    '-movflags',
    '+faststart',
    '-y',
    outputPath
  ]

  logger.info(`[API] Merge with compression: ${ffmpegArgs.join(' ')}`)

  try {
    await runFfmpegWithProgress(ffmpegArgs, estimatedDuration)
  } catch (error) {
    if (encoderArgs.codec === 'libx264') {
      logger.warn('API video-audio merge failed, trying with fast preset:', error)
      const fallbackArgs = [
        '-i',
        videoPath,
        '-i',
        audioPath,
        ...vfArgs,
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-pix_fmt',
        'yuv420p',
        ...libx264Args(crf),
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
        '-shortest',
        '-movflags',
        '+faststart',
        '-y',
        outputPath
      ]
      await runFfmpegWithProgress(fallbackArgs, estimatedDuration)
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
        'libx264',
        width,
        height,
        inputWidth,
        inputHeight,
        recordedBitrate
      )
    }
  }
}

/**
 * fast 导出收尾：已编码的 MP4（WebCodecs 页内编码）与 WAV 音频 remux。
 * 视频流直接 copy 不再二次编码，仅音频转 AAC；耗时为秒级。
 */
export async function apiMuxVideoAudioCopy(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  audioBitrate: string = '128k'
): Promise<void> {
  const stat = await fs.promises.stat(videoPath)
  const estimatedDuration = Math.max(stat.size / (8000000 / 8), 10)

  const ffmpegArgs = [
    '-i',
    videoPath,
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
    '-shortest',
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
export async function apiCopyVideo(inputPath: string, outputPath: string): Promise<void> {
  const stat = await fs.promises.stat(inputPath)
  const estimatedDuration = Math.max(stat.size / (8000000 / 8), 10)

  const ffmpegArgs = ['-i', inputPath, '-c:v', 'copy', '-movflags', '+faststart', '-y', outputPath]

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
    ...(audioPath ? ['-c:a', 'aac', '-b:a', audioBitrate, '-shortest'] : []),
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
 * 画布可能大于目标分辨率（renderScale 超采样），统一等比缩放 + pad。
 * 质量因子与 record 管线共用配置的 video.crf（此前硬编码 18，体积偏大）。
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
  inputHeight: number = 0
): Promise<void> {
  const entries = await fs.promises.readdir(framesDir)
  const sampleFiles = entries.filter((f) => f.startsWith('frame-'))
  let framePattern = 'frame-%06d.png'
  if (sampleFiles.some((f) => f.endsWith('.jpg') || f.endsWith('.jpeg'))) {
    framePattern = 'frame-%06d.jpg'
  }
  const estimatedDuration = Math.max(sampleFiles.length / Math.max(1, fps), 10)

  const encoderArgs = await resolveVideoEncoderArgs(encoder, crf)
  const { filter: scale } = resolveOutputScaleFilter(inputWidth, inputHeight, width, height)
  const vfArgs = scale ? ['-vf', scale] : []

  const ffmpegArgs = [
    '-framerate',
    String(fps),
    '-i',
    `${framesDir}/${framePattern}`,
    ...vfArgs,
    '-c:v',
    encoderArgs.codec,
    '-preset',
    encoderArgs.preset,
    '-pix_fmt',
    encoderArgs.pixFmt,
    ...encoderArgs.args,
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
      logger.warn(
        `Frame encoding failed with ${encoderArgs.codec}, falling back to libx264:`,
        error
      )
      await encodeFramesToVideo(
        fps,
        framesDir,
        outputPath,
        'libx264',
        width,
        height,
        crf,
        inputWidth,
        inputHeight
      )
      return
    }
    throw error
  }
}

export interface FramesPipeSessionOptions {
  fps: number
  width: number
  height: number
  inputWidth?: number
  inputHeight?: number
  crf?: number
  encoder?: VideoEncoderChoice
  outputPath: string
}

/**
 * 流式 MJPEG image2pipe 编码会话：
 * 直接把浏览器拍出的 JPEG 帧通过 stdin 喂给 FFmpeg 编码成 MP4，
 * 省去成千上万个临时 JPEG 写盘与二次扫描。
 */
export class FramesPipeSession {
  readonly outputPath: string
  private readonly child: ChildProcess
  private readonly done: Promise<void>
  private readonly encoderCodec: string
  private stderr = ''
  private error: Error | null = null
  private settled = false
  private eofSent = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private finishTimer: ReturnType<typeof setTimeout> | null = null
  private queue: Promise<void> = Promise.resolve()

  private constructor(child: ChildProcess, outputPath: string, encoderCodec: string) {
    this.child = child
    this.outputPath = outputPath
    this.encoderCodec = encoderCodec
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

  static async create(options: FramesPipeSessionOptions): Promise<FramesPipeSession> {
    const crf = options.crf ?? 23
    const encoderArgs = await resolveVideoEncoderArgs(options.encoder ?? 'auto', crf)
    const inputW = options.inputWidth ?? options.width
    const inputH = options.inputHeight ?? options.height
    const { filter: scale } = resolveOutputScaleFilter(
      inputW,
      inputH,
      options.width,
      options.height
    )

    const args = [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'warning',
      '-nostats',
      '-y',
      '-f',
      'image2pipe',
      '-vcodec',
      'mjpeg',
      '-framerate',
      String(options.fps),
      '-i',
      'pipe:0',
      ...(scale ? ['-vf', scale] : []),
      '-c:v',
      encoderArgs.codec,
      '-preset',
      encoderArgs.preset,
      '-pix_fmt',
      encoderArgs.pixFmt,
      ...encoderArgs.args,
      '-movflags',
      '+faststart',
      options.outputPath
    ]

    const child = spawn(ffmpegPath(), args, {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe']
    })
    return new FramesPipeSession(child, options.outputPath, encoderArgs.codec)
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
