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
 */
export function ffmpegPath(): string {
  if (process.env.MSS_FFMPEG_PATH) {
    return process.env.MSS_FFMPEG_PATH
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffmpegStatic = require('ffmpeg-static') as string | null
    if (ffmpegStatic) {
      return ffmpegStatic
    }
  } catch {
    // ffmpeg-static 未安装，回退到 PATH
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
    execFile(ffmpegPath(), ['-version'], { timeout: 5000 }, (error, stdout) => {
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

export async function detectAvailableGpuEncoder(): Promise<'nvidia' | 'amd' | 'intel' | 'cpu'> {
  const gpuEncoders = [
    { name: 'nvidia', codec: 'h264_nvenc' },
    { name: 'amd', codec: 'h264_amf' },
    { name: 'intel', codec: 'h264_qsv' }
  ] as const

  for (const encoder of gpuEncoders) {
    try {
      const result = await new Promise<boolean>((resolve) => {
        const testProcess = spawn(ffmpegPath(), ['-hide_banner', '-encoders'])
        let outputData = ''

        testProcess.stdout?.on('data', (data) => {
          outputData += data.toString()
        })

        testProcess.stderr?.on('data', (data) => {
          outputData += data.toString()
        })

        testProcess.on('close', (code) => {
          if (code === 0 && outputData.includes(encoder.codec)) {
            resolve(true)
          } else {
            resolve(false)
          }
        })

        testProcess.on('error', () => resolve(false))
      })

      if (result) {
        logger.info(`Detected GPU encoder: ${encoder.codec} (${encoder.name})`)
        return encoder.name
      }
    } catch {
      continue
    }
  }

  logger.info('No GPU encoder detected, falling back to CPU encoding')
  return 'cpu'
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
      return {
        codec: 'h264_qsv',
        preset: 'medium',
        pixFmt: 'nv12',
        args: ['-global_quality', String(crf)],
        needsQsvInit: true
      }
    case 'cpu':
      return {
        codec: 'libx264',
        preset: 'fast',
        pixFmt: 'yuv420p',
        args: ['-crf', String(crf)],
        needsQsvInit: false
      }
    case 'auto':
    default:
      return {
        codec: 'libx264',
        preset: 'fast',
        pixFmt: 'yuv420p',
        args: ['-crf', String(crf)],
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
      args: ['-crf', String(crf)],
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
    const ffmpegProcess: ChildProcess = spawn(ffmpegPath(), ffmpegArgs)

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
      stderrData += data.toString()
      const progressMatch = data.toString().match(/time=(\d{2}):(\d{2}):(\d{2})/)
      if (progressMatch) {
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
 * API 导出收尾：视频（无音轨）转码压缩为 MP4。
 * 与旧版 IpcHandler 行为一致（1280x720 pad、-r fps），仅编码器改为可选。
 */
export async function apiConvertVideoWithCompression(
  inputPath: string,
  outputPath: string,
  crf: number = 23,
  fps: number = 30,
  encoder: VideoEncoderChoice = 'libx264',
  width: number = 1280,
  height: number = 720
): Promise<void> {
  const stat = await fs.promises.stat(inputPath)
  const estimatedDuration = Math.max(stat.size / (8000000 / 8), 10)

  const scale = outputScaleFilter(width, height)

  const encoderArgs = await resolveVideoEncoderArgs(encoder, crf)
  logger.info(`API video conversion using encoder: ${encoderArgs.codec} (${encoder}), CRF=${crf}`)

  const qsvInitArgs = encoderArgs.needsQsvInit
    ? ['-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw']
    : []
  const qsvVfPrefix = encoderArgs.needsQsvInit ? 'hw_upload,' : ''

  const ffmpegArgs = [
    ...qsvInitArgs,
    '-i',
    inputPath,
    '-vf',
    `${qsvVfPrefix}${scale}`,
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
        '-vf',
        scale,
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        String(crf),
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
      logger.warn(
        `API video conversion failed with ${encoderArgs.codec}, falling back to CPU:`,
        error
      )
      await apiConvertVideoWithCompression(inputPath, outputPath, crf, fps, 'libx264', width, height)
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
  width: number = 1280,
  height: number = 720
): Promise<void> {
  const videoStat = await fs.promises.stat(videoPath)
  const estimatedDuration = Math.max(videoStat.size / (8000000 / 8), 10)

  const scale = outputScaleFilter(width, height)

  const encoderArgs = await resolveVideoEncoderArgs(encoder, crf)
  logger.info(`API video-audio merge using encoder: ${encoderArgs.codec} (${encoder}), CRF=${crf}`)

  const qsvInitArgs = encoderArgs.needsQsvInit
    ? ['-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw']
    : []
  const qsvVfPrefix = encoderArgs.needsQsvInit ? 'hw_upload,' : ''

  const ffmpegArgs = [
    ...qsvInitArgs,
    '-i',
    videoPath,
    '-i',
    audioPath,
    '-vf',
    `${qsvVfPrefix}${scale}`,
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
        '-vf',
        scale,
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        String(crf),
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
        height
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

/**
 * 帧序列合成 MP4（fast 导出 JPEG 帧路径使用）。
 * 画布可能大于目标分辨率（renderScale 超采样），统一等比缩放 + pad。
 */
export async function encodeFramesToVideo(
  fps: number,
  framesDir: string,
  outputPath: string,
  encoder: VideoEncoderChoice = 'auto',
  width: number = 1280,
  height: number = 720
): Promise<void> {
  let framePattern = 'frame-%06d.png'
  const sampleFiles = fs.readdirSync(framesDir).filter((f) => f.startsWith('frame-'))
  if (sampleFiles.some((f) => f.endsWith('.jpg') || f.endsWith('.jpeg'))) {
    framePattern = 'frame-%06d.jpg'
  }

  const encoderArgs = await resolveVideoEncoderArgs(encoder, 18)
  const qsvInitArgs = encoderArgs.needsQsvInit
    ? ['-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw']
    : []
  const qsvVfPrefix = encoderArgs.needsQsvInit ? 'hw_upload,' : ''

  const ffmpegArgs = [
    ...qsvInitArgs,
    '-framerate',
    String(fps),
    '-i',
    framesDir + '/' + framePattern,
    '-vf',
    `${qsvVfPrefix}${outputScaleFilter(width, height)}`,
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

  // 帧数未知，用保守估计值驱动进度/超时
  await runFfmpegWithProgress(ffmpegArgs, 60)
}
