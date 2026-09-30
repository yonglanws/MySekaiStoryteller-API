import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ffmpegPath, type VideoEncoderChoice } from '../../shared/ffmpeg'

export interface RecordEncodingConfig {
  directory: string
  inputWidth: number
  inputHeight: number
  width: number
  height: number
  fps: number
  crf: number
  encoder: VideoEncoderChoice
}

export interface RecordEncodingResult {
  videoPath: string
  frameCount: number
  /** Final MP4 presentation duration (includes B-frame reorder, unlike progress DTS). */
  durationMs: number
}

type ProcessResult = { error?: Error; frameCount: number; durationMs: number }
const STDERR_LIMIT = 16 * 1024
const IDLE_TIMEOUT_MS = 120_000
const WRITE_TIMEOUT_MS = 30_000
const KILL_TIMEOUT_MS = 5_000
const MAX_RECORDING_MS = 6 * 60 * 60 * 1000

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** Owns all process timers and streams. Its completion never rejects in the background. */
class EncodingProcess {
  readonly child: ChildProcessWithoutNullStreams
  readonly done: Promise<ProcessResult>
  result?: ProcessResult
  private resolve!: (result: ProcessResult) => void
  private stderr = ''
  private progressLine = ''
  private frameCount = 0
  private durationMs = 0
  private error?: Error
  private deadline?: NodeJS.Timeout
  private idle?: NodeJS.Timeout
  private killTimer?: NodeJS.Timeout
  private eofSent = false

  constructor(binary: string, args: string[], timeoutMs: number) {
    this.done = new Promise((resolve) => {
      this.resolve = resolve
    })
    this.child = spawn(binary, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdin.on('error', (error) => {
      this.error ??= error
    })
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_LIMIT)
    })
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.touch()
      const lines = (this.progressLine + chunk.toString()).split('\n')
      this.progressLine = (lines.pop() ?? '').slice(-1024)
      for (const line of lines) {
        if (!line.includes('=')) continue
        const [key, value] = line.trim().split('=')
        const number = Number(value)
        if (!Number.isFinite(number)) continue
        if (key === 'frame') this.frameCount = Math.max(this.frameCount, number)
        if (key === 'out_time_us') this.durationMs = Math.max(this.durationMs, number / 1000)
      }
      // Keep only a possible partial final line, never unbounded process output.
      this.progressLine = this.progressLine.slice(-1024)
    })
    this.child.once('error', (error) => {
      this.error ??= error
    })
    this.child.once('close', (code, signal) => {
      if (code !== 0) {
        this.error ??= new Error(`FFmpeg exited with code ${code} (${signal ?? 'no signal'})`)
      } else if (!this.eofSent) {
        this.error ??= new Error('FFmpeg closed before capture EOF')
      }
      this.complete()
    })
    this.setDeadline(timeoutMs)
    this.touch()
  }

  private complete(): void {
    if (this.result) return
    clearTimeout(this.deadline)
    clearTimeout(this.idle)
    clearTimeout(this.killTimer)
    this.result = {
      ...(this.error ? { error: new Error(`${this.error.message}\n${this.stderr}`) } : {}),
      frameCount: this.frameCount,
      durationMs: this.durationMs
    }
    this.resolve(this.result)
  }

  touch(): void {
    if (this.result || this.killTimer) return
    clearTimeout(this.idle)
    this.idle = setTimeout(
      () => this.stop(new Error('FFmpeg record encoder idle timeout')),
      IDLE_TIMEOUT_MS
    )
  }

  setDeadline(timeoutMs: number): void {
    if (this.result) return
    clearTimeout(this.deadline)
    this.deadline = setTimeout(
      () => this.stop(new Error('FFmpeg record encoder timed out')),
      timeoutMs
    )
  }

  stop(error: Error): Promise<ProcessResult> {
    if (!this.result && !this.killTimer) {
      this.error ??= error
      this.child.stdin.destroy()
      this.child.kill('SIGKILL')
      // Bound teardown even if a platform never emits close after a failed spawn/kill.
      this.killTimer = setTimeout(() => {
        this.child.stdout.destroy()
        this.child.stderr.destroy()
        this.complete()
      }, KILL_TIMEOUT_MS)
    }
    return this.done
  }

  async write(chunk: Buffer): Promise<void> {
    if (this.result) throw this.result.error ?? new Error('FFmpeg closed before capture finished')
    if (this.error) throw this.error
    this.touch()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error('FFmpeg stdin backpressure timeout')
        void this.stop(error)
        reject(error)
      }, WRITE_TIMEOUT_MS)
      this.child.stdin.write(chunk, (error) => {
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      })
    })
  }

  finish(timeoutMs: number): Promise<ProcessResult> {
    this.setDeadline(timeoutMs)
    if (!this.result) {
      this.eofSent = true
      this.child.stdin.end()
    }
    return this.done
  }
}

type Encoder = 'nvidia' | 'amd' | 'intel' | 'cpu'
const smokeCache = new Map<string, Promise<boolean>>()

function codecArgs(encoder: Encoder, crf: number): string[] {
  const common = ['-profile:v', 'high', '-pix_fmt', encoder === 'intel' ? 'nv12' : 'yuv420p']
  switch (encoder) {
    case 'nvidia':
      return [
        '-c:v',
        'h264_nvenc',
        '-preset',
        'p4',
        '-tune',
        'hq',
        '-rc',
        'vbr',
        '-cq',
        String(crf),
        '-b:v',
        '0',
        '-bf',
        '3',
        '-spatial-aq',
        '1',
        '-temporal-aq',
        '1',
        ...common
      ]
    case 'amd':
      return [
        '-c:v',
        'h264_amf',
        '-quality',
        'quality',
        '-rc',
        'cqp',
        '-qp_i',
        String(crf),
        '-qp_p',
        String(crf),
        '-qp_b',
        String(crf),
        ...common
      ]
    case 'intel':
      // Software decode/scale with system-memory input: QSV initializes its own encoder device.
      // No global hw_upload filter or hardware decoder is needed for MediaRecorder input.
      return ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', String(crf), ...common]
    default:
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), ...common]
  }
}

function smokeTest(binary: string, encoder: Encoder): Promise<boolean> {
  const key = `${binary}\0${encoder}`
  let test = smokeCache.get(key)
  if (!test) {
    test = (async () => {
      try {
        const process = new EncodingProcess(
          binary,
          [
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
            '12',
            ...codecArgs(encoder, 23),
            '-progress',
            'pipe:1',
            '-f',
            'null',
            '-'
          ],
          10_000
        )
        const result = await process.finish(10_000)
        return !result.error && result.frameCount === 12
      } catch {
        return false
      }
    })()
    smokeCache.set(key, test)
  }
  return test
}

async function resolveEncoder(binary: string, choice: VideoEncoderChoice): Promise<Encoder> {
  if (choice === 'cpu' || choice === 'libx264') return 'cpu'
  const candidates: Encoder[] = choice === 'auto' ? ['nvidia', 'amd', 'intel'] : [choice]
  for (const encoder of candidates) {
    if (await smokeTest(binary, encoder)) return encoder
  }
  console.warn(
    `[record-encoder] ${choice} unavailable after real smoke encode; falling back to CPU libx264`
  )
  return 'cpu'
}

function validateConfig(config: RecordEncodingConfig): void {
  for (const key of ['inputWidth', 'inputHeight', 'width', 'height'] as const) {
    if (!Number.isInteger(config[key]) || config[key] <= 0)
      throw new Error(`Invalid positive integer ${key}`)
  }
  if (config.width % 2 || config.height % 2)
    throw new Error('Output width and height must be even for H264 yuv420p')
  if (!Number.isFinite(config.fps) || config.fps <= 0) throw new Error('Invalid positive fps')
  if (!Number.isFinite(config.crf) || config.crf < 0 || config.crf > 51)
    throw new Error('Invalid CRF: expected 0..51')
  if (!['auto', 'cpu', 'libx264', 'nvidia', 'amd', 'intel'].includes(config.encoder))
    throw new Error('Invalid video encoder')
  if (!config.directory) throw new Error('Invalid record directory')
}

function videoArgs(config: RecordEncodingConfig, encoder: Encoder): string[] {
  const filter =
    config.inputWidth === config.width && config.inputHeight === config.height
      ? []
      : [
          '-vf',
          `scale=${config.width}:${config.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${config.width}:${config.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`
        ]
  return [
    ...filter,
    ...codecArgs(encoder, config.crf),
    // A guessed FPS time base rounds irregular MediaRecorder timestamps and corrupts DTS.
    // -1 is the demux time base, including on older FFmpeg builds without the demux alias.
    '-fps_mode',
    'passthrough',
    '-enc_time_base',
    '-1'
  ]
}

function encodingArgs(
  config: RecordEncodingConfig,
  encoder: Encoder,
  input: string,
  output: string
): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'warning',
    '-nostats',
    '-y',
    '-probesize',
    '32768',
    '-analyzeduration',
    '0',
    '-i',
    input,
    '-map',
    '0:v:0',
    '-an',
    ...videoArgs(config, encoder),
    '-stats_period',
    '0.25',
    '-progress',
    'pipe:1',
    '-movflags',
    '+faststart',
    output
  ]
}

/** Read only box headers and mvhd, never mdat or a whole moov (which grows with frame count). */
async function movieDurationMs(path: string): Promise<number> {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    let headers = 0
    const read = async (position: number, length: number): Promise<Buffer> => {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await file.read(buffer, 0, length, position)
      if (bytesRead !== length) throw new Error('Truncated encoded MP4 header')
      return buffer
    }
    const find = async (
      start: number,
      end: number,
      name: string
    ): Promise<{ start: number; end: number } | undefined> => {
      for (let offset = start; offset + 8 <= end; ) {
        if (++headers > 1024) throw new Error('Too many encoded MP4 headers')
        const header = await read(offset, 8)
        let length = header.readUInt32BE(0)
        let headerSize = 8
        if (length === 1) {
          length = Number((await read(offset + 8, 8)).readBigUInt64BE())
          headerSize = 16
        } else if (length === 0) length = end - offset
        if (!Number.isSafeInteger(length) || length < headerSize || offset + length > end) {
          throw new Error('Invalid encoded MP4 box length')
        }
        if (header.toString('ascii', 4, 8) === name)
          return { start: offset + headerSize, end: offset + length }
        offset += length
      }
      return undefined
    }
    const moov = await find(0, size, 'moov')
    const mvhd = moov && (await find(moov.start, moov.end, 'mvhd'))
    if (!mvhd) throw new Error('Encoded MP4 has no movie duration')
    const version = (await read(mvhd.start, 1))[0]
    const length = version === 1 ? 32 : 20
    if ((version !== 0 && version !== 1) || mvhd.end - mvhd.start < length)
      throw new Error('Invalid MP4 movie header')
    const data = await read(mvhd.start, length)
    const timescale = data.readUInt32BE(version === 1 ? 20 : 12)
    const duration = version === 1 ? Number(data.readBigUInt64BE(24)) : data.readUInt32BE(16)
    if (!timescale || !Number.isSafeInteger(duration) || duration <= 0)
      throw new Error('Invalid MP4 movie duration')
    return (duration * 1000) / timescale
  } finally {
    await file.close()
  }
}

/**
 * Record-only streaming encoder. Await append() for disk + pipe backpressure; concurrent calls
 * are serialized. finish() drains every accepted append and leaves the capture and MP4 intact.
 * The bridge owns the unique directory: mux first, then await cancel() before removing it.
 * cancel() is idempotent, reaps all processes and removes only this session's two files.
 */
export class RecordEncoderSession {
  readonly id: string
  readonly inputPath: string
  readonly outputPath: string
  private readonly startedAt = Date.now()
  private process: EncodingProcess
  private state: 'open' | 'finishing' | 'finished' | 'cancelled' = 'open'
  private queue: Promise<void> = Promise.resolve()
  private failure?: Error
  private finishPromise?: Promise<RecordEncodingResult>
  private cancelPromise?: Promise<void>
  private bytes = 0

  private constructor(
    private readonly config: RecordEncodingConfig,
    private readonly binary: string,
    private readonly encoder: Encoder,
    id: string
  ) {
    this.id = id
    this.inputPath = join(config.directory, `record-capture-${id}`)
    this.outputPath = join(config.directory, `record-encoded-${id}.mp4`)
    this.process = new EncodingProcess(
      binary,
      encodingArgs(config, encoder, 'pipe:0', this.outputPath),
      MAX_RECORDING_MS
    )
  }

  static async create(config: RecordEncodingConfig): Promise<RecordEncoderSession> {
    validateConfig(config)
    const binary = ffmpegPath()
    const encoder = await resolveEncoder(binary, config.encoder)
    await mkdir(config.directory, { recursive: true })
    const id = randomUUID()
    const handle = await open(join(config.directory, `record-capture-${id}`), 'wx')
    await handle.close()
    return new RecordEncoderSession({ ...config }, binary, encoder, id)
  }

  private checkActive(): void {
    if (this.state === 'cancelled') throw new Error('Record encoding cancelled')
    if (this.failure) throw this.failure
  }

  append(chunk: Buffer): Promise<void> {
    if (this.state !== 'open') {
      const rejection = Promise.reject<void>(
        new Error(
          this.state === 'cancelled'
            ? 'Record encoding cancelled'
            : 'Record encoding is finishing or closed'
        )
      )
      void rejection.catch(() => {})
      return rejection
    }
    const operation = this.queue.then(async () => {
      this.checkActive()
      await appendFile(this.inputPath, chunk)
      this.bytes += chunk.length
      this.checkActive()
      if (chunk.length) {
        try {
          await this.process.write(chunk)
        } catch (error) {
          this.checkActive()
          if (this.encoder === 'cpu') throw error
          // The complete original capture is still durable. Keep accepting capture chunks,
          // but stop feeding failed hardware; finish() will replay it once using CPU.
          await this.process.stop(asError(error))
          this.checkActive()
        }
      }
    })
    // Handle even ignored caller promises and latch disk/pipe errors for finish().
    this.queue = operation.catch((error) => {
      this.failure ??= asError(error)
      void this.process.stop(this.failure)
    })
    return operation
  }

  finish(): Promise<RecordEncodingResult> {
    if (this.state === 'cancelled') {
      const rejection = Promise.reject<RecordEncodingResult>(new Error('Record encoding cancelled'))
      void rejection.catch(() => {})
      return rejection
    }
    if (this.finishPromise) return this.finishPromise
    this.state = 'finishing'
    this.finishPromise = this.finishEncoding()
    void this.finishPromise.catch(() => {})
    return this.finishPromise
  }

  private async finishEncoding(): Promise<RecordEncodingResult> {
    try {
      await this.queue
      this.checkActive()
      if (this.bytes === 0) throw new Error('Empty record capture contains no frames')
      const timeoutMs = Math.min(30 * 60_000, Math.max(120_000, (Date.now() - this.startedAt) * 3))
      let result = await this.process.finish(timeoutMs)
      this.checkActive()
      if ((result.error || result.frameCount <= 0) && this.encoder !== 'cpu') {
        console.warn(
          `[record-encoder] ${this.encoder} streaming failed; replaying retained capture with CPU libx264: ${result.error?.message ?? 'no frames'}`
        )
        // Do not reuse a device that failed under actual recording load in later sessions.
        smokeCache.set(`${this.binary}\0${this.encoder}`, Promise.resolve(false))
        this.process = new EncodingProcess(
          this.binary,
          encodingArgs(this.config, 'cpu', this.inputPath, this.outputPath),
          timeoutMs
        )
        result = await this.process.finish(timeoutMs)
        this.checkActive()
      }
      if (result.error) throw result.error
      if (result.frameCount <= 0 || (await stat(this.outputPath)).size === 0) {
        throw new Error('FFmpeg produced no video frames')
      }
      // -progress out_time_us is DTS on common FFmpeg builds: with B3 it can be 100ms
      // short even at 30fps. Correct final duration from the bounded MP4 header, not FPS.
      const durationMs = await movieDurationMs(this.outputPath)
      this.checkActive()
      this.state = 'finished'
      return { videoPath: this.outputPath, frameCount: result.frameCount, durationMs }
    } catch (error) {
      this.failure ??= asError(error)
      await this.process.stop(this.failure)
      await rm(this.outputPath, { force: true })
      throw this.failure
    }
  }

  cancel(): Promise<void> {
    if (this.cancelPromise) return this.cancelPromise
    this.state = 'cancelled'
    this.cancelPromise = (async () => {
      await this.process.stop(new Error('Record encoding cancelled'))
      await this.queue
      await this.finishPromise?.catch(() => {})
      await Promise.all([this.inputPath, this.outputPath].map((path) => rm(path, { force: true })))
    })()
    return this.cancelPromise
  }
}

export function createRecordEncoding(config: RecordEncodingConfig): Promise<RecordEncoderSession> {
  return RecordEncoderSession.create(config)
}
