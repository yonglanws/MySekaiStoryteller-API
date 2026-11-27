import { ChildProcess, execFile, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
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
const localRequire = createRequire(__filename)

export interface RustExporterInfo {
  available: boolean
  enabled: boolean
  binaryPath: string | null
  napiPath: string | null
  mode: 'napi' | 'cli' | 'unavailable'
  version: string | null
}

export interface RustProbedEncoder {
  backend: string
  hostAlias: string
  encoder: string
  lowPower?: boolean
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
  inputCodec?: VideoCodec
  encoder?: VideoEncoderChoice
  crf?: number
  quality?: number
  preset?: string
  width: number
  height: number
  inputWidth?: number
  inputHeight?: number
  gop?: number
  maxOutputMbps?: number
  lowPower?: boolean
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

export interface RustLoopMetadata {
  loopStartMs?: number
  loopEndMs?: number
  loopStartSample?: number
  loopEndSample?: number
  sampleRate?: number
}

export interface RustBgmCue {
  timeMs: number
  fadeMs?: number
  stop?: boolean
  path?: string
  volume?: number
  loopStartMs?: number
  loopEndMs?: number
  loopStartSample?: number
  loopEndSample?: number
  sourceSampleRate?: number
}

export interface RustBgmVolumeTween {
  timeMs: number
  volume: number
  durationMs: number
}

export interface RustSeCue {
  timeMs: number
  file: string
  path?: string
  stop?: boolean
  volume?: number
  loop?: boolean
  fadeMs?: number
}

export interface RustVoiceTrack {
  path?: string
  audioBytes?: Uint8Array
  startMs: number
  endMs?: number
  snippetIndex?: number
  computeLipSync?: boolean
  targetValueScale?: number
}

export interface RustAudioMixPlan {
  durationMs: number
  outputPath: string
  outputFormat?: 'wav' | 'aac'
  audioBitrate?: string
  ffmpegPath?: string
  bgm?: {
    enabled: boolean
    volume: number
    globalPath?: string
    globalLoop?: RustLoopMetadata
    cues?: RustBgmCue[]
    volumeTweens?: RustBgmVolumeTween[]
  }
  se?: {
    cues: RustSeCue[]
  }
  voices?: RustVoiceTrack[]
}

export interface RustLipSyncResult {
  values: Float32Array
  frameMs: number
  durationMs: number
  audioDurationMs: number
  releaseStep: number
  targetValueScale: number
  powK: number
}

export interface RustAudioMixResult {
  ok: boolean
  outputPath: string
  frames: number
  fileSize: number
  elapsedMs: number
  lipSyncs?: Array<RustLipSyncResult & { snippetIndex?: number }>
}

export interface RustStaticSpan {
  startFrame: number
  endFrame: number
  kind: 'blackout_covered' | 'idle_hold' | 'wait'
  hardStatic: boolean
}

export interface RustStoryPlanInput {
  snippets: unknown[]
  timeline?: Array<{
    snippetIndex: number
    startTimeMs: number
    durationMs: number
    endTimeMs: number
    ttsDurationMs?: number
    hasTTS?: boolean
  }>
  options?: {
    exportFps?: number
    ttsEnabled?: boolean
    windowOpenMs?: Record<number, number>
    motionSettleMs?: Record<number, number>
    motionSettleFrames?: Record<number, number>
    motionClipFrames?: Record<string, number>
  }
}

export interface RustStoryPlanResult {
  schemaVersion: number
  fps: number
  totalFrames: number
  totalMs: number
  entries: unknown[]
  staticSpans: RustStaticSpan[]
}

export interface RustBridgeServerOptions {
  allowedOutputDirs: string[]
  bridgeToken?: string
  host?: string
  port?: number
  ffmpegPath?: string
}

export interface RustBridgeServerInfo {
  running: boolean
  port: number
  wsUrl: string
  token: string
}

interface NativeNapiBindings {
  version(): string
  probeEncoders(ffmpegPath: string, codec?: string): string
  planSegments(startFrame: number, endFrame: number, jobs: number): string
  bakeStoryPlan(inputJson: string): string
  analyzeStaticSpansJson(planJson: string): string
  computeLipSyncFromPcm(
    samples: Float32Array,
    sampleRate: number,
    channels: number,
    targetValueScale?: number
  ): {
    values: Float32Array
    frameMs: number
    durationMs: number
    audioDurationMs: number
    releaseStep: number
    targetValueScale: number
    powK: number
  }
  computeLipSyncFromFile(
    filePath: string,
    targetValueScale?: number
  ): {
    values: Float32Array
    frameMs: number
    durationMs: number
    audioDurationMs: number
    releaseStep: number
    targetValueScale: number
    powK: number
  }
  computeLipSyncFromBytes(
    bytes: Buffer,
    targetValueScale?: number
  ): {
    values: Float32Array
    frameMs: number
    durationMs: number
    audioDurationMs: number
    releaseStep: number
    targetValueScale: number
    powK: number
  }
  mixAudioPlanAsync(planJson: string): Promise<string>
  mixWavAsync(durationMs: number, outputPath: string, tracksJson: string): Promise<string>
  runRemuxAsync(optionsJson: string): Promise<string>
  concatSegmentsAsync(optionsJson: string): Promise<string>
  openPipeSession(optionsJson: string): number
  writePipeFrameAsync(
    sessionId: number,
    chunk: Buffer,
    framesInChunk?: number,
    repeatCount?: number,
    dedup?: boolean
  ): Promise<number>
  repeatPipeFrameAsync(sessionId: number, count: number): Promise<number>
  finishPipeSessionAsync(sessionId: number): Promise<string>
  abortPipeSession(sessionId: number): void
  startBridgeServer(optionsJson: string): string
  getBridgeServerInfo(): string | null
  stopBridgeServer(): void
}

let cachedBinaryPath: string | null | undefined
let cachedNapiPath: string | null | undefined
let cachedNapiModule: NativeNapiBindings | null | undefined
let cachedVersion: string | null | undefined

function isTruthyEnvDisabled(raw: string | undefined): boolean {
  if (raw === undefined) return false
  return ['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase())
}

function isRustExporterEnabledByEnv(): boolean {
  return !isTruthyEnvDisabled(process.env.MSS_USE_RUST_EXPORTER)
}

function isRustNapiEnabledByEnv(): boolean {
  return isRustExporterEnabledByEnv() && !isTruthyEnvDisabled(process.env.MSS_USE_RUST_NAPI)
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
  cachedNapiPath = undefined
  cachedNapiModule = undefined
  cachedVersion = undefined
}

export function resolveRustNapiAddon(): string | null {
  if (cachedNapiPath !== undefined) return cachedNapiPath
  const rootDir = resolveRepoRoot()
  const candidates: string[] = []
  if (process.env.MSS_RUST_NAPI_PATH) {
    candidates.push(process.env.MSS_RUST_NAPI_PATH)
  }
  candidates.push(
    path.join(rootDir, 'native', 'mss-export-rs', 'target', 'release', 'mss-export-napi.node'),
    path.join(rootDir, 'native', 'mss-export-rs', 'target', 'debug', 'mss-export-napi.node'),
    path.join(rootDir, 'native', 'mss-export-rs', 'mss-export-napi.node')
  )
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        cachedNapiPath = candidate
        return candidate
      }
    } catch {
      // candidate absent
    }
  }
  cachedNapiPath = null
  return null
}

function loadNapiBindings(): NativeNapiBindings | null {
  if (!isRustNapiEnabledByEnv()) return null
  if (cachedNapiModule !== undefined) return cachedNapiModule
  const addonPath = resolveRustNapiAddon()
  if (!addonPath) {
    cachedNapiModule = null
    return null
  }
  try {
    const loaded = localRequire(addonPath) as NativeNapiBindings
    if (loaded && typeof loaded.version === 'function') {
      cachedNapiModule = loaded
      return loaded
    }
  } catch {
    // Fall back to CLI binary if NAPI load fails (e.g. ABI mismatch)
  }
  cachedNapiModule = null
  return null
}

/**
 * Resolves the native `mss-export-rs` CLI binary path:
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
  if (!configEnabled || !isRustExporterEnabledByEnv()) return false
  return loadNapiBindings() !== null || resolveRustExporterBinary() !== null
}

export async function getRustExporterInfo(configEnabled = true): Promise<RustExporterInfo> {
  const enabled = configEnabled && isRustExporterEnabledByEnv()
  const napiPath = resolveRustNapiAddon()
  const binaryPath = resolveRustExporterBinary()
  if (!enabled) {
    return {
      available: false,
      enabled: false,
      binaryPath,
      napiPath,
      mode: 'unavailable',
      version: null
    }
  }

  const napiMod = loadNapiBindings()
  if (napiMod) {
    try {
      const ver = napiMod.version()
      cachedVersion = ver
      return {
        available: true,
        enabled: true,
        binaryPath,
        napiPath,
        mode: 'napi',
        version: ver
      }
    } catch {
      // fall through to CLI
    }
  }

  if (!binaryPath) {
    return {
      available: false,
      enabled: true,
      binaryPath: null,
      napiPath,
      mode: 'unavailable',
      version: null
    }
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
    enabled: true,
    binaryPath,
    napiPath,
    mode: cachedVersion !== null ? 'cli' : 'unavailable',
    version: cachedVersion
  }
}

export function getRustExporterInfoSync(configEnabled = true): RustExporterInfo {
  const enabled = configEnabled && isRustExporterEnabledByEnv()
  const napiMod = enabled ? loadNapiBindings() : null
  const napiPath = resolveRustNapiAddon()
  const binaryPath = resolveRustExporterBinary()
  const mode: RustExporterInfo['mode'] = !enabled
    ? 'unavailable'
    : napiMod
      ? 'napi'
      : binaryPath
        ? 'cli'
        : 'unavailable'
  return {
    available: mode !== 'unavailable',
    enabled,
    binaryPath,
    napiPath,
    mode,
    version: napiMod ? napiMod.version() : (cachedVersion ?? null)
  }
}

export async function probeRustHardwareEncoders(
  codec: VideoCodec = 'hevc'
): Promise<RustProbedEncoder[] | null> {
  if (!isRustExporterEnabledByEnv()) return null
  const napiMod = loadNapiBindings()
  if (napiMod) {
    try {
      return JSON.parse(napiMod.probeEncoders(ffmpegPath(), codec)) as RustProbedEncoder[]
    } catch {
      // fall through to CLI
    }
  }
  const binary = resolveRustExporterBinary()
  if (!binary) return null
  try {
    const { stdout } = await execFileAsync(
      binary,
      ['probe-encoders', '--ffmpeg', ffmpegPath(), '--codec', codec],
      { timeout: 15_000, windowsHide: true }
    )
    const parsed = JSON.parse(stdout.trim()) as {
      ok?: boolean
      hardware?: RustProbedEncoder[]
    }
    return parsed.ok && Array.isArray(parsed.hardware) ? parsed.hardware : null
  } catch {
    return null
  }
}

export const probeEncoders = probeRustHardwareEncoders

export async function planRustSegments(
  startFrame: number,
  endFrame: number,
  jobs: number,
  fps = 60
): Promise<Array<{ start: number; end: number }> | null> {
  if (!isRustExporterEnabledByEnv()) return null
  const s = Math.max(0, Math.floor(startFrame))
  const e = Math.max(0, Math.floor(endFrame))
  const j = Math.max(1, Math.floor(jobs))
  const napiMod = loadNapiBindings()
  if (napiMod) {
    try {
      return JSON.parse(napiMod.planSegments(s, e, j)) as Array<{ start: number; end: number }>
    } catch {
      // fall through to CLI
    }
  }
  const binary = resolveRustExporterBinary()
  if (!binary) return null
  try {
    const { stdout } = await execFileAsync(
      binary,
      [
        'plan-segments',
        '--start',
        String(s),
        '--end',
        String(e),
        '--fps',
        String(Math.max(1, Math.round(fps))),
        '--jobs',
        String(j)
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

export const planSegments = planRustSegments

export async function bakeStoryPlanRust(
  input: RustStoryPlanInput
): Promise<RustStoryPlanResult | null> {
  if (!isRustExporterEnabledByEnv()) return null
  const payload = JSON.stringify(input)
  const napiMod = loadNapiBindings()
  if (napiMod) {
    return JSON.parse(napiMod.bakeStoryPlan(payload)) as RustStoryPlanResult
  }
  const binary = resolveRustExporterBinary()
  if (!binary) return null
  const stdout = await spawnWithStdin(binary, ['bake-plan'], payload, 15_000)
  return JSON.parse(stdout.trim()) as RustStoryPlanResult
}

export async function analyzeStaticSpansRust(plan: unknown): Promise<RustStaticSpan[] | null> {
  if (!isRustExporterEnabledByEnv()) return null
  const napiMod = loadNapiBindings()
  if (!napiMod) return null
  return JSON.parse(napiMod.analyzeStaticSpansJson(JSON.stringify(plan))) as RustStaticSpan[]
}

export async function mixAudioPlan(plan: RustAudioMixPlan): Promise<RustAudioMixResult> {
  if (!isRustExporterEnabledByEnv()) {
    throw new Error('Rust exporter disabled by environment')
  }
  const serializedPlan = JSON.stringify({
    ...plan,
    ffmpegPath: plan.ffmpegPath ?? ffmpegPath(),
    voices: plan.voices?.map((v) => ({
      ...v,
      audioBytes: v.audioBytes ? Array.from(v.audioBytes) : undefined
    }))
  })

  const napiMod = loadNapiBindings()
  let rawJson: string
  if (napiMod) {
    rawJson = await napiMod.mixAudioPlanAsync(serializedPlan)
  } else {
    const binary = resolveRustExporterBinary()
    if (!binary) throw new Error('mss-export-rs binary not found')
    rawJson = await spawnWithStdin(binary, ['mix-plan'], serializedPlan, 180_000)
  }

  const parsed = JSON.parse(rawJson.trim()) as {
    ok: boolean
    outputPath: string
    frames: number
    fileSize: number
    elapsedMs: number
    lipSyncs?: Array<{
      snippetIndex?: number
      values: number[]
      frameMs: number
      durationMs: number
      audioDurationMs: number
      releaseStep: number
      targetValueScale: number
      powK: number
    }>
  }

  return {
    ...parsed,
    lipSyncs: parsed.lipSyncs?.map((l) => ({
      ...l,
      values: Float32Array.from(l.values)
    }))
  }
}

export async function computeLipSync(input: {
  path?: string
  audioBytes?: Buffer | Uint8Array
  pcm?: Float32Array
  sampleRate?: number
  channels?: number
  targetValueScale?: number
}): Promise<RustLipSyncResult> {
  const napiMod = loadNapiBindings()
  if (napiMod) {
    if (input.pcm) {
      const res = napiMod.computeLipSyncFromPcm(
        input.pcm,
        input.sampleRate ?? 48_000,
        input.channels ?? 1,
        input.targetValueScale
      )
      return {
        ...res,
        values: new Float32Array(res.values)
      }
    }
    if (input.audioBytes) {
      const buf = Buffer.isBuffer(input.audioBytes)
        ? input.audioBytes
        : Buffer.from(
            input.audioBytes.buffer,
            input.audioBytes.byteOffset,
            input.audioBytes.byteLength
          )
      const res = napiMod.computeLipSyncFromBytes(buf, input.targetValueScale)
      return {
        ...res,
        values: new Float32Array(res.values)
      }
    }
    if (input.path) {
      const res = napiMod.computeLipSyncFromFile(input.path, input.targetValueScale)
      return {
        ...res,
        values: new Float32Array(res.values)
      }
    }
    throw new Error('computeLipSync requires path, audioBytes, or pcm')
  }

  const binary = resolveRustExporterBinary()
  if (!binary || !input.path) {
    throw new Error('mss-export-napi.node or CLI --input file path required for computeLipSync')
  }
  const args = ['lip-sync', '--input', input.path]
  if (input.targetValueScale !== undefined) {
    args.push('--scale', String(input.targetValueScale))
  }
  const { stdout } = await execFileAsync(binary, args, { timeout: 30_000, windowsHide: true })
  const parsed = JSON.parse(stdout.trim()) as {
    values: number[]
    frameMs: number
    durationMs: number
    audioDurationMs: number
    releaseStep: number
    targetValueScale: number
    powK: number
  }
  return {
    ...parsed,
    values: Float32Array.from(parsed.values)
  }
}

export async function runRustRemux(options: RustRemuxOptions): Promise<RustRemuxResult> {
  const codec = normalizeVideoCodec(options.codec)
  const crf = options.quality ?? options.crf ?? 23
  const lowPower = options.lowPower ?? true

  const napiMod = loadNapiBindings()
  if (napiMod) {
    const raw = await napiMod.runRemuxAsync(
      JSON.stringify({
        ffmpegPath: ffmpegPath(),
        videoPath: options.videoPath,
        audioPath: options.audioPath,
        outputPath: options.outputPath,
        audioBitrate: options.audioBitrate || '128k',
        frameCount: options.frameCount,
        fps: Math.max(1, Math.round(options.fps)),
        startFrame: options.startFrame ? Math.round(options.startFrame) : 0,
        transcode: Boolean(options.transcode),
        codec,
        inputCodec: options.inputCodec ? normalizeVideoCodec(options.inputCodec) : undefined,
        encoder: options.encoder || 'auto',
        crf,
        preset: options.preset,
        width: options.width,
        height: options.height,
        inputWidth: options.inputWidth ?? options.width,
        inputHeight: options.inputHeight ?? options.height,
        gop: options.gop ? Math.round(options.gop) : undefined,
        maxOutputMbps: options.maxOutputMbps ?? 0,
        lowPower
      })
    )
    return JSON.parse(raw) as RustRemuxResult
  }

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
    codec,
    '--encoder',
    options.encoder || 'auto',
    '--crf',
    String(crf),
    '--width',
    String(options.width),
    '--height',
    String(options.height),
    '--input-width',
    String(options.inputWidth ?? options.width),
    '--input-height',
    String(options.inputHeight ?? options.height),
    lowPower ? '--low-power' : '--no-low-power'
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
  if (options.inputCodec) {
    args.push('--input-codec', normalizeVideoCodec(options.inputCodec))
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

  const durationSec = options.frameCount && options.fps > 0 ? options.frameCount / options.fps : 120
  const timeoutMs = Math.max(durationSec * 3, 180) * 1000

  const { stdout } = await execFileAsync(binary, args, {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  })
  return JSON.parse(stdout.trim()) as RustRemuxResult
}

export const runRemux = runRustRemux

export async function runRustConcatSegments(options: {
  outputPath: string
  fps: number
  codec?: VideoCodec
  audioPath?: string
  audioBitrate?: string
  segments: RustSegmentEntry[]
}): Promise<{
  ok: boolean
  outputPath: string
  fileSize: number
  segments: number
  elapsedMs: number
}> {
  const codec = normalizeVideoCodec(options.codec)
  const napiMod = loadNapiBindings()
  if (napiMod) {
    const raw = await napiMod.concatSegmentsAsync(
      JSON.stringify({
        ffmpegPath: ffmpegPath(),
        outputPath: options.outputPath,
        fps: Math.max(1, Math.round(options.fps)),
        codec,
        audioPath: options.audioPath,
        audioBitrate: options.audioBitrate || '128k',
        segments: options.segments.map((s) => ({
          videoPath: s.videoPath,
          frameCount: Math.round(s.frameCount)
        }))
      })
    )
    return JSON.parse(raw) as {
      ok: boolean
      outputPath: string
      fileSize: number
      segments: number
      elapsedMs: number
    }
  }

  const binary = resolveRustExporterBinary()
  if (!binary) {
    throw new Error('mss-export-rs binary not found')
  }
  const args = [
    'concat-mix',
    '--ffmpeg',
    ffmpegPath(),
    '--output',
    options.outputPath,
    '--fps',
    String(Math.max(1, Math.round(options.fps))),
    '--codec',
    codec,
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
    elapsedMs: number
  }
}

export async function runRustMixWav(options: {
  durationMs: number
  outputPath: string
  tracks: RustMixTrack[]
}): Promise<{ ok: boolean; outputPath: string; frames: number; fileSize: number }> {
  const napiMod = loadNapiBindings()
  if (napiMod) {
    const raw = await napiMod.mixWavAsync(
      Math.max(0, options.durationMs),
      options.outputPath,
      JSON.stringify(options.tracks)
    )
    return JSON.parse(raw) as {
      ok: boolean
      outputPath: string
      frames: number
      fileSize: number
    }
  }

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

export function startRustBridgeServer(options: RustBridgeServerOptions): RustBridgeServerInfo {
  if (options.port === 9881) {
    throw new Error('Port 9881 is reserved for the main API server')
  }
  const napiMod = loadNapiBindings()
  if (!napiMod) {
    throw new Error('mss-export-napi.node is required for in-process Rust binary bridge')
  }
  const raw = napiMod.startBridgeServer(
    JSON.stringify({
      ...options,
      ffmpegPath: options.ffmpegPath ?? ffmpegPath()
    })
  )
  return JSON.parse(raw) as RustBridgeServerInfo
}

export function getRustBridgeServerInfo(): RustBridgeServerInfo | null {
  const napiMod = loadNapiBindings()
  if (!napiMod) return null
  const raw = napiMod.getBridgeServerInfo()
  return raw ? (JSON.parse(raw) as RustBridgeServerInfo) : null
}

export function stopRustBridgeServer(): void {
  const napiMod = loadNapiBindings()
  if (!napiMod) return
  napiMod.stopBridgeServer()
}

function spawnWithStdin(
  binary: string,
  args: string[],
  stdinData: string,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGKILL')
        reject(new Error(`mss-export-rs ${args[0]} timed out`))
      }
    }, timeoutMs)
    timer.unref?.()

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-16 * 1024)
    })
    child.once('error', (err) => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        reject(err)
      }
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      if (code === 0) resolve(stdout)
      else reject(new Error(`mss-export-rs ${args[0]} exited with ${code}: ${stderr.trim()}`))
    })
    child.stdin?.end(stdinData)
  })
}

export type RustPipeSessionOptions = FramesPipeSessionOptions & {
  lowPower?: boolean
  dedup?: boolean
  quality?: number
  inputFormat?: 'yuv420p' | 'rgba' | 'mjpeg'
}

/**
 * High-throughput streaming video pipe session:
 * - Primary: In-process NAPI (`openPipeSession` + libuv async tasks, zero spawn overhead,
 *   rayon BT.709 conversion, bounded ring buffers, duplicate/static-frame repeat)
 * - Fallback: `mss-export-rs.exe pipe-encode` child process
 */
export class RustFramesPipeSession {
  readonly outputPath: string
  private readonly napiMod: NativeNapiBindings | null
  private readonly sessionId: number | null
  private readonly child: ChildProcess | null
  private readonly done: Promise<void>
  private readonly frameBytes: number
  private stderr = ''
  private error: Error | null = null
  private settled = false
  private eofSent = false
  private queue: Promise<void> = Promise.resolve()
  private frames = 0
  private lastChunk: Buffer | null = null

  private constructor(params: {
    outputPath: string
    frameBytes: number
    napiMod: NativeNapiBindings | null
    sessionId: number | null
    child: ChildProcess | null
  }) {
    this.outputPath = params.outputPath
    this.frameBytes = params.frameBytes
    this.napiMod = params.napiMod
    this.sessionId = params.sessionId
    this.child = params.child

    if (this.child) {
      this.done = new Promise<void>((resolve, reject) => {
        this.child!.stdin?.on('error', (err) => {
          this.error ??= err
        })
        this.child!.stderr?.on('data', (chunk: Buffer) => {
          this.stderr = (this.stderr + chunk.toString()).slice(-16 * 1024)
        })
        this.child!.once('error', (err) => {
          this.error ??= err
        })
        this.child!.once('close', (code, signal) => {
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
    } else {
      this.done = Promise.resolve()
    }
  }

  get frameCount(): number {
    return this.frames
  }

  static create(options: RustPipeSessionOptions): RustFramesPipeSession {
    checkEncodeSize(options.width, options.height)
    if (options.fromFrame !== undefined || options.toFrame !== undefined) {
      checkFrameRange(options.fromFrame ?? 0, options.toFrame ?? Number.MAX_SAFE_INTEGER)
    }

    const rawFmt = options.inputFormat ?? (options.frameFormat === 'rawvideo' ? 'yuv420p' : 'mjpeg')
    const codec = normalizeVideoCodec(options.codec)
    const crf = options.quality ?? options.crf ?? 23
    const gop = Math.max(1, Math.round(options.fps * 4))
    const lowPower = options.lowPower ?? true
    const dedup = options.dedup ?? false
    const frameBytes =
      rawFmt === 'yuv420p'
        ? (options.width * options.height * 3) / 2
        : rawFmt === 'rgba'
          ? options.width * options.height * 4
          : 0

    const napiMod = loadNapiBindings()
    if (napiMod) {
      const sessionId = napiMod.openPipeSession(
        JSON.stringify({
          ffmpegPath: ffmpegPath(),
          outputPath: options.outputPath,
          width: options.width,
          height: options.height,
          fps: Math.max(1, Math.round(options.fps)),
          format: rawFmt,
          codec,
          encoder: options.encoder ?? 'auto',
          crf,
          gop,
          faststart: Boolean(options.faststart),
          rustYuvConvert: true,
          lowPower,
          dedup
        })
      )
      return new RustFramesPipeSession({
        outputPath: options.outputPath,
        frameBytes,
        napiMod,
        sessionId,
        child: null
      })
    }

    const binary = resolveRustExporterBinary()
    if (!binary) {
      throw new Error('mss-export-rs binary not available')
    }

    const frameFormat: FramePipeFormat = options.frameFormat === 'rawvideo' ? 'rawvideo' : 'mjpeg'
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
      rawFmt === 'rgba' ? 'rgba' : frameFormat === 'rawvideo' ? 'yuv420p' : 'mjpeg',
      '--codec',
      codec,
      '--encoder',
      options.encoder ?? 'auto',
      '--crf',
      String(crf),
      '--gop',
      String(gop),
      lowPower ? '--low-power' : '--no-low-power'
    ]
    if (options.faststart) {
      args.push('--faststart')
    }
    if (dedup) {
      args.push('--dedup')
    }

    const child = spawn(binary, args, {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe']
    })
    return new RustFramesPipeSession({
      outputPath: options.outputPath,
      frameBytes,
      napiMod: null,
      sessionId: null,
      child
    })
  }

  write(
    chunk: Buffer,
    framesInChunk?: number,
    options?: { repeatCount?: number; dedup?: boolean }
  ): Promise<void> {
    if (this.frameBytes > 0 && chunk.length % this.frameBytes !== 0) {
      return Promise.reject(
        new ExportValidationError(
          `Invalid rawvideo chunk: ${chunk.length} bytes is not a multiple of ${this.frameBytes} (frame size)`
        )
      )
    }
    if (framesInChunk !== undefined && (!Number.isInteger(framesInChunk) || framesInChunk <= 0)) {
      return Promise.reject(
        new ExportValidationError(`Invalid frameCount in pipe chunk: ${framesInChunk}`)
      )
    }
    const repeat = Math.max(1, Math.floor(options?.repeatCount ?? 1))
    const task = this.queue.then(async () => {
      if (this.settled) throw this.error ?? new Error('mss-export-rs pipe closed')
      if (this.error) throw this.error
      if (!chunk.length) return

      if (this.napiMod && this.sessionId !== null) {
        const total = await this.napiMod.writePipeFrameAsync(
          this.sessionId,
          chunk,
          framesInChunk,
          repeat,
          options?.dedup
        )
        this.frames = total
        return
      }

      this.lastChunk = chunk
      for (let r = 0; r < repeat; r++) {
        await this.writeChildStdin(chunk)
        this.frames += this.frameBytes > 0 ? chunk.length / this.frameBytes : (framesInChunk ?? 1)
      }
    })
    this.queue = task.catch((err) => {
      this.error ??= err instanceof Error ? err : new Error(String(err))
    })
    return task
  }

  repeatLastFrame(count = 1): Promise<void> {
    const repeat = Math.max(0, Math.floor(count))
    if (repeat === 0) return Promise.resolve()
    const task = this.queue.then(async () => {
      if (this.settled) throw this.error ?? new Error('mss-export-rs pipe closed')
      if (this.error) throw this.error
      if (this.napiMod && this.sessionId !== null) {
        this.frames = await this.napiMod.repeatPipeFrameAsync(this.sessionId, repeat)
        return
      }
      if (!this.lastChunk) {
        throw new Error('Cannot repeatLastFrame before any frame was written')
      }
      for (let r = 0; r < repeat; r++) {
        await this.writeChildStdin(this.lastChunk)
        this.frames += this.frameBytes > 0 ? this.lastChunk.length / this.frameBytes : 1
      }
    })
    this.queue = task.catch((err) => {
      this.error ??= err instanceof Error ? err : new Error(String(err))
    })
    return task
  }

  private writeChildStdin(chunk: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const stdin = this.child?.stdin
      if (!stdin || stdin.destroyed) {
        reject(this.error ?? new Error('mss-export-rs stdin unavailable'))
        return
      }
      stdin.write(chunk, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  async finish(timeoutMs = 300_000): Promise<string> {
    await this.queue
    if (this.error) throw this.error

    if (this.napiMod && this.sessionId !== null) {
      if (!this.settled) {
        this.settled = true
        await this.napiMod.finishPipeSessionAsync(this.sessionId)
      }
      return this.outputPath
    }

    let finishTimer: ReturnType<typeof setTimeout> | null = null
    if (!this.settled) {
      this.eofSent = true
      finishTimer = setTimeout(() => {
        void this.abort(new Error('mss-export-rs pipe finish timeout'))
      }, timeoutMs)
      finishTimer.unref?.()
      this.child?.stdin?.end()
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
    if (this.napiMod && this.sessionId !== null) {
      if (!this.settled) {
        this.settled = true
        try {
          this.napiMod.abortPipeSession(this.sessionId)
        } catch {
          // ignore
        }
      }
      await fs.promises.rm(this.outputPath, { force: true }).catch(() => {})
      return
    }
    if (!this.settled) {
      this.child?.stdin?.destroy()
      this.child?.kill('SIGKILL')
    }
    await this.done.catch(() => {})
    await fs.promises.rm(this.outputPath, { force: true }).catch(() => {})
  }
}
