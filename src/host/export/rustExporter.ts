import { ChildProcess, execFile, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  ExportValidationError,
  checkEncodeSize,
  checkFrameRange,
  ffmpegPath,
  normalizeVideoCodec,
  type FramePipeFormat,
  type FramesPipeSessionOptions,
  type VideoCodec,
  type VideoEncoderChoice
} from '../../shared/ffmpeg'

const execFileAsync = promisify(execFile)

export interface RustExporterInfo {
  available: boolean
  enabled: boolean
  binaryPath: string | null
  version: string | null
}

export interface RustRemuxOptions {
  videoPath: string
  audioPath?: string
  outputPath: string
  audioBitrate: string
  frameCount?: number
  fps: number
  startFrame?: number
  transcode?: boolean
  codec?: VideoCodec
  encoder?: VideoEncoderChoice
  crf?: number
  preset?: string
  width: number
  height: number
  inputWidth?: number
  inputHeight?: number
  gop?: number
  maxOutputMbps?: number
}

export interface RustRemuxResult {
  ok: boolean
  outputPath: string
  fileSize: number
  transcoded: boolean
  encoder: string
  elapsedMs: number
}

export interface RustSegmentEntry {
  videoPath: string
  frameCount: number
}

export interface RustMixTrack {
  path: string
  startMs: number
  endMs?: number
  volume: number
  looping?: boolean
  fadeInMs?: number
  fadeOutMs?: number
}

let cachedBinaryPath: string | null | undefined
let cachedVersion: string | null | undefined

function isRustExporterEnabledByEnv(): boolean {
  const raw = process.env.MSS_USE_RUST_EXPORTER
  if (raw === undefined) return true
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase())
}

function resolveRepoRoot(): string {
  const fromCompiled = path.resolve(__dirname, '..', '..', '..')
  if (fs.existsSync(path.join(fromCompiled, 'package.json'))) {
    return fromCompiled
  }
  const fromSrc = path.resolve(__dirname, '..', '..', '..')
  if (fs.existsSync(path.join(fromSrc, 'package.json'))) {
    return fromSrc
  }
  return process.cwd()
}

export function resetRustExporterCache(): void {
  cachedBinaryPath = undefined
  cachedVersion = undefined
}

/**
 * Resolves the native `mss-export-rs` binary path:
 * 1. `MSS_RUST_EXPORTER_PATH` env var
 * 2. `<repo>/native/mss-export-rs/target/release/mss-export-rs[.exe]`
 * 3. `<repo>/native/mss-export-rs/target/debug/mss-export-rs[.exe]`
 */
export function resolveRustExporterBinary(): string | null {
  if (cachedBinaryPath !== undefined) return cachedBinaryPath
  const exe = process.platform === 'win32' ? 'mss-export-rs.exe' : 'mss-export-rs'
  const rootDir = resolveRepoRoot()
  const candidates: string[] = []
  if (process.env.MSS_RUST_EXPORTER_PATH) {
    candidates.push(process.env.MSS_RUST_EXPORTER_PATH)
  }
  candidates.push(
    path.join(rootDir, 'native', 'mss-export-rs', 'target', 'release', exe),
    path.join(rootDir, 'native', 'mss-export-rs', 'target', 'debug', exe)
  )

  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate)
      const executable =
        process.platform === 'win32' ? stat.isFile() : stat.isFile() && (stat.mode & 0o111) !== 0
      if (executable) {
        cachedBinaryPath = candidate
        return candidate
      }
    } catch {
      // candidate absent
    }
  }
  cachedBinaryPath = null
  return null
}

export function isRustExporterAvailable(configEnabled = true): boolean {
  return configEnabled && isRustExporterEnabledByEnv() && resolveRustExporterBinary() !== null
}

export async function getRustExporterInfo(configEnabled = true): Promise<RustExporterInfo> {
  const enabled = configEnabled && isRustExporterEnabledByEnv()
  const binaryPath = resolveRustExporterBinary()
  if (!enabled || !binaryPath) {
    return { available: false, enabled, binaryPath, version: null }
  }
  if (cachedVersion === undefined) {
    try {
      const { stdout } = await execFileAsync(binaryPath, ['version'], {
        timeout: 5_000,
        windowsHide: true
      })
      const parsed = JSON.parse(stdout.trim()) as { version?: string }
      cachedVersion = parsed.version ?? 'unknown'
    } catch {
      cachedVersion = null
    }
  }
  return {
    available: cachedVersion !== null,
    enabled,
    binaryPath,
    version: cachedVersion
  }
}

export function getRustExporterInfoSync(configEnabled = true): RustExporterInfo {
  const enabled = configEnabled && isRustExporterEnabledByEnv()
  const binaryPath = resolveRustExporterBinary()
  return {
    available: enabled && binaryPath !== null,
    enabled,
    binaryPath,
    version: cachedVersion ?? null
  }
}

export async function probeRustHardwareEncoders(
  codec: VideoCodec = 'hevc'
): Promise<Array<{ backend: string; hostAlias: string; encoder: string }> | null> {
  const binary = resolveRustExporterBinary()
  if (!binary || !isRustExporterEnabledByEnv()) return null
  try {
    const { stdout } = await execFileAsync(
      binary,
      ['probe-encoders', '--ffmpeg', ffmpegPath(), '--codec', codec],
      { timeout: 15_000, windowsHide: true }
    )
    const parsed = JSON.parse(stdout.trim()) as {
      ok?: boolean
      hardware?: Array<{ backend: string; hostAlias: string; encoder: string }>
    }
    return parsed.ok && Array.isArray(parsed.hardware) ? parsed.hardware : null
  } catch {
    return null
  }
}

export async function planRustSegments(
  startFrame: number,
  endFrame: number,
  jobs: number
): Promise<Array<{ start: number; end: number }> | null> {
  const binary = resolveRustExporterBinary()
  if (!binary || !isRustExporterEnabledByEnv()) return null
  try {
    const { stdout } = await execFileAsync(
      binary,
      [
        'plan-segments',
        '--start',
        String(Math.max(0, Math.floor(startFrame))),
        '--end',
        String(Math.max(0, Math.floor(endFrame))),
        '--jobs',
        String(Math.max(1, Math.floor(jobs)))
      ],
      { timeout: 5_000, windowsHide: true }
    )
    const parsed = JSON.parse(stdout.trim()) as {
      ok?: boolean
      segments?: Array<{ start: number; end: number }>
    }
    return parsed.ok && Array.isArray(parsed.segments) ? parsed.segments : null
  } catch {
    return null
  }
}

export async function runRustRemux(options: RustRemuxOptions): Promise<RustRemuxResult> {
  const binary = resolveRustExporterBinary()
  if (!binary) {
    throw new Error('mss-export-rs binary not found')
  }
  const args = [
    'remux',
    '--ffmpeg',
    ffmpegPath(),
    '--video',
    options.videoPath,
    '--output',
    options.outputPath,
    '--audio-bitrate',
    options.audioBitrate || '128k',
    '--fps',
    String(Math.max(1, Math.round(options.fps))),
    '--codec',
    normalizeVideoCodec(options.codec),
    '--encoder',
    options.encoder || 'auto',
    '--crf',
    String(options.crf ?? 23),
    '--width',
    String(options.width),
    '--height',
    String(options.height),
    '--input-width',
    String(options.inputWidth ?? options.width),
    '--input-height',
    String(options.inputHeight ?? options.height)
  ]
  if (options.audioPath) {
    args.push('--audio', options.audioPath)
  }
  if (options.frameCount && options.frameCount > 0) {
    args.push('--frames', String(Math.round(options.frameCount)))
  }
  if (options.startFrame && options.startFrame > 0) {
    args.push('--start-frame', String(Math.round(options.startFrame)))
  }
  if (options.transcode) {
    args.push('--transcode')
  }
  if (options.preset) {
    args.push('--preset', options.preset)
  }
  if (options.gop && options.gop > 0) {
    args.push('--gop', String(Math.round(options.gop)))
  }
  if (options.maxOutputMbps && options.maxOutputMbps > 0) {
    args.push('--max-mbps', String(options.maxOutputMbps))
  }

  const durationSec =
    options.frameCount && options.fps > 0 ? options.frameCount / options.fps : 120
  const timeoutMs = Math.max(durationSec * 3, 180) * 1000

  const { stdout } = await execFileAsync(binary, args, {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  })
  return JSON.parse(stdout.trim()) as RustRemuxResult
}

export async function runRustConcatSegments(options: {
  outputPath: string
  fps: number
  codec?: VideoCodec
  audioPath?: string
  audioBitrate?: string
  segments: RustSegmentEntry[]
}): Promise<{ ok: boolean; outputPath: string; fileSize: number; segments: number }> {
  const binary = resolveRustExporterBinary()
  if (!binary) {
    throw new Error('mss-export-rs binary not found')
  }
  const args = [
    'concat-segments',
    '--ffmpeg',
    ffmpegPath(),
    '--output',
    options.outputPath,
    '--fps',
    String(Math.max(1, Math.round(options.fps))),
    '--codec',
    normalizeVideoCodec(options.codec),
    '--audio-bitrate',
    options.audioBitrate || '128k'
  ]
  if (options.audioPath) {
    args.push('--audio', options.audioPath)
  }
  for (const seg of options.segments) {
    args.push('--segment', `${seg.videoPath}:${Math.round(seg.frameCount)}`)
  }
  const { stdout } = await execFileAsync(binary, args, {
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  })
  return JSON.parse(stdout.trim()) as {
    ok: boolean
    outputPath: string
    fileSize: number
    segments: number
  }
}

export async function runRustMixWav(options: {
  durationMs: number
  outputPath: string
  tracks: RustMixTrack[]
}): Promise<{ ok: boolean; outputPath: string; frames: number; fileSize: number }> {
  const binary = resolveRustExporterBinary()
  if (!binary) {
    throw new Error('mss-export-rs binary not found')
  }
  const args = [
    'mix-wav',
    '--output',
    options.outputPath,
    '--duration-ms',
    String(Math.max(0, options.durationMs))
  ]
  for (const t of options.tracks) {
    const spec = [
      t.path,
      String(t.startMs),
      t.endMs !== undefined ? String(t.endMs) : '',
      String(t.volume),
      t.looping ? '1' : '0',
      t.fadeInMs ? String(t.fadeInMs) : '',
      t.fadeOutMs ? String(t.fadeOutMs) : ''
    ].join('|')
    args.push('--track', spec)
  }
  const { stdout } = await execFileAsync(binary, args, {
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  })
  return JSON.parse(stdout.trim()) as {
    ok: boolean
    outputPath: string
    frames: number
    fileSize: number
  }
}

/**
 * Drop-in replacement for `FramesPipeSession` backed by `mss-export-rs pipe-encode`.
 * Offloads FFmpeg stdin piping, buffer recycling, and optional RGBA->BT.709 YUV420p
 * conversion to a dedicated native Rust writer thread.
 */
export class RustFramesPipeSession {
  readonly outputPath: string
  private readonly child: ChildProcess
  private readonly done: Promise<void>
  private readonly frameBytes: number
  private stderr = ''
  private error: Error | null = null
  private settled = false
  private eofSent = false
  private queue: Promise<void> = Promise.resolve()
  private frames = 0

  private constructor(child: ChildProcess, outputPath: string, frameBytes: number) {
    this.child = child
    this.outputPath = outputPath
    this.frameBytes = frameBytes
    this.done = new Promise<void>((resolve, reject) => {
      this.child.stdin?.on('error', (err) => {
        this.error ??= err
      })
      this.child.stderr?.on('data', (chunk: Buffer) => {
        this.stderr = (this.stderr + chunk.toString()).slice(-16 * 1024)
      })
      this.child.once('error', (err) => {
        this.error ??= err
      })
      this.child.once('close', (code, signal) => {
        if (this.settled) return
        this.settled = true
        if (code === 0 && this.eofSent && !this.error) {
          resolve()
          return
        }
        const baseMsg =
          this.error?.message ??
          (code !== 0
            ? `mss-export-rs pipe-encode exited with code ${code} (${signal ?? 'no signal'})`
            : 'mss-export-rs pipe-encode closed before EOF')
        reject(new Error(`${baseMsg}\n${this.stderr}`))
      })
    })
    void this.done.catch(() => {})
  }

  get frameCount(): number {
    return this.frames
  }

  static create(options: FramesPipeSessionOptions): RustFramesPipeSession {
    const binary = resolveRustExporterBinary()
    if (!binary) {
      throw new Error('mss-export-rs binary not available')
    }
    checkEncodeSize(options.width, options.height)
    if (options.fromFrame !== undefined || options.toFrame !== undefined) {
      checkFrameRange(options.fromFrame ?? 0, options.toFrame ?? Number.MAX_SAFE_INTEGER)
    }

    const frameFormat: FramePipeFormat = options.frameFormat === 'rawvideo' ? 'rawvideo' : 'mjpeg'
    const codec = normalizeVideoCodec(options.codec)
    const crf = options.crf ?? 23
    const gop = Math.max(1, Math.round(options.fps * 4))

    const args = [
      'pipe-encode',
      '--ffmpeg',
      ffmpegPath(),
      '--output',
      options.outputPath,
      '--width',
      String(options.width),
      '--height',
      String(options.height),
      '--fps',
      String(Math.max(1, Math.round(options.fps))),
      '--format',
      frameFormat === 'rawvideo' ? 'yuv420p' : 'mjpeg',
      '--codec',
      codec,
      '--encoder',
      options.encoder ?? 'auto',
      '--crf',
      String(crf),
      '--gop',
      String(gop)
    ]
    if (options.faststart) {
      args.push('--faststart')
    }

    const child = spawn(binary, args, {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe']
    })
    const frameBytes = frameFormat === 'rawvideo' ? (options.width * options.height * 3) / 2 : 0
    return new RustFramesPipeSession(child, options.outputPath, frameBytes)
  }

  write(chunk: Buffer, framesInChunk?: number): Promise<void> {
    if (this.frameBytes > 0 && chunk.length % this.frameBytes !== 0) {
      return Promise.reject(
        new ExportValidationError(
          `Invalid rawvideo chunk: ${chunk.length} bytes is not a multiple of ${this.frameBytes} (yuv420p frame size)`
        )
      )
    }
    if (
      framesInChunk !== undefined &&
      (!Number.isInteger(framesInChunk) || framesInChunk <= 0)
    ) {
      return Promise.reject(
        new ExportValidationError(`Invalid frameCount in pipe chunk: ${framesInChunk}`)
      )
    }
    const task = this.queue.then(async () => {
      if (this.settled) throw this.error ?? new Error('mss-export-rs pipe closed')
      if (this.error) throw this.error
      if (!chunk.length) return
      await new Promise<void>((resolve, reject) => {
        const stdin = this.child.stdin
        if (!stdin || stdin.destroyed) {
          reject(this.error ?? new Error('mss-export-rs stdin unavailable'))
          return
        }
        stdin.write(chunk, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
      this.frames +=
        this.frameBytes > 0 ? chunk.length / this.frameBytes : (framesInChunk ?? 1)
    })
    this.queue = task.catch((err) => {
      this.error ??= err instanceof Error ? err : new Error(String(err))
    })
    return task
  }

  async finish(timeoutMs = 300_000): Promise<string> {
    await this.queue
    if (this.error) throw this.error
    let finishTimer: ReturnType<typeof setTimeout> | null = null
    if (!this.settled) {
      this.eofSent = true
      finishTimer = setTimeout(() => {
        void this.abort(new Error('mss-export-rs pipe finish timeout'))
      }, timeoutMs)
      finishTimer.unref?.()
      this.child.stdin?.end()
    }
    try {
      await this.done
    } finally {
      if (finishTimer) clearTimeout(finishTimer)
    }
    return this.outputPath
  }

  async abort(reason = new Error('mss-export-rs pipe cancelled')): Promise<void> {
    this.error ??= reason
    if (!this.settled) {
      this.child.stdin?.destroy()
      this.child.kill('SIGKILL')
    }
    await this.done.catch(() => {})
    await fs.promises.rm(this.outputPath, { force: true }).catch(() => {})
  }
}
