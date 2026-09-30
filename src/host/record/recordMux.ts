import { spawn } from 'node:child_process'
import { mkdir, open, rm, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { ffmpegPath } from '../../shared/ffmpeg'

export interface RecordMuxOptions {
  videoPath: string
  audioPath?: string
  outputPath: string
  audioBitrate: string
  signal: AbortSignal
  timeoutMs?: number
}

export interface RecordMuxResult {
  success: true
  outputPath: string
  fileSize: number
  /** true = 预估超出体积上限，已按精确码率重编码压回（recordTargetSizeMb 路径） */
  sizeCapped?: boolean
}

export async function muxRecordVideo(options: RecordMuxOptions): Promise<RecordMuxResult> {
  const { videoPath, audioPath, outputPath, audioBitrate, signal } = options
  if (signal.aborted) throw new Error('Record mux cancelled')
  if (
    resolve(outputPath) === resolve(videoPath) ||
    (audioPath && resolve(outputPath) === resolve(audioPath))
  ) {
    throw new Error('Record mux output must differ from its inputs')
  }
  await mkdir(dirname(outputPath), { recursive: true })
  try {
    const existing = await open(outputPath, 'wx')
    await existing.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Record mux output already exists')
    }
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'warning',
    '-nostats',
    '-y',
    '-i',
    videoPath,
    ...(audioPath ? ['-i', audioPath] : []),
    '-map',
    '0:v:0',
    '-c:v',
    'copy',
    ...(audioPath ? ['-map', '1:a:0', '-c:a', 'aac', '-b:a', audioBitrate, '-shortest'] : ['-an']),
    '-movflags',
    '+faststart',
    outputPath
  ]
  try {
    await new Promise<void>((done, reject) => {
      const child = spawn(ffmpegPath(), args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stderr = ''
      let failure: Error | undefined
      let settled = false
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(killTimer)
        signal.removeEventListener('abort', abort)
        if (failure) reject(new Error(`${failure.message}\n${stderr}`))
        else done()
      }
      const stop = (error: Error): void => {
        failure ??= error
        if (killTimer || settled) return
        child.kill('SIGKILL')
        // Keep ownership until close: a kill request alone does not mean files are closed.
        killTimer = setTimeout(() => {
          killTimer = undefined
          if (!settled) stop(error)
        }, 5000)
      }
      const abort = (): void => stop(new Error('Record mux cancelled'))
      const timer = setTimeout(
        () => stop(new Error('Record mux timed out')),
        options.timeoutMs ?? 120_000
      )
      child.stdout.resume()
      child.stderr.on('data', (bytes: Buffer) => {
        stderr = (stderr + bytes.toString()).slice(-16 * 1024)
      })
      child.once('error', (error) => {
        failure ??= error
      })
      child.once('close', (code) => {
        if (code !== 0) failure ??= new Error(`FFmpeg record mux exited with code ${code}`)
        finish()
      })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    if (signal.aborted) throw new Error('Record mux cancelled')
    const fileSize = (await stat(outputPath)).size
    if (!fileSize) throw new Error('Record mux produced an empty output')
    return { success: true, outputPath, fileSize }
  } catch (error) {
    await rm(outputPath, { force: true })
    throw error
  }
}
