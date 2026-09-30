import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRecordEncoding,
  type RecordEncodingConfig,
  type RecordEncodingResult
} from './recordEncoder'
import type { VideoEncoderChoice } from '../../shared/ffmpeg'
import { muxRecordVideo, type RecordMuxResult } from './recordMux'

const MIN_DIMENSION = 1
const MAX_DIMENSION = 16_384
const DEFAULT_IDLE_TIMEOUT_MS = 120_000
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface RecordSessionHostConfig {
  width: number
  height: number
  fps: number
  crf: number
  encoder: VideoEncoderChoice
}

export interface RecordEncodingSession {
  readonly id: string
  readonly inputPath: string
  readonly outputPath: string
  append(chunk: Buffer): Promise<void>
  finish(): Promise<RecordEncodingResult>
  cancel(): Promise<void>
}

export type RecordEncodingFactory = (config: RecordEncodingConfig) => Promise<RecordEncodingSession>

export interface RecordSessionOptions {
  createEncoding?: RecordEncodingFactory
  idleTimeoutMs?: number
}

export class RecordSessionError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 500
  ) {
    super(message)
    this.name = 'RecordSessionError'
  }
}

interface SessionEntry {
  readonly id: string
  readonly directory: string
  state: 'creating' | 'open' | 'finishing' | 'finished' | 'muxing' | 'muxed' | 'cancelling'
  muxAbort?: AbortController
  muxPromise?: Promise<RecordMuxResult>
  muxOutputPath?: string
  muxSucceeded?: boolean
  encoder?: RecordEncodingSession
  creation?: Promise<RecordEncodingSession>
  finishPromise?: Promise<RecordEncodingResult>
  cancelPromise?: Promise<void>
  idleTimer?: ReturnType<typeof setTimeout>
}

function errorMessage(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function invalidSessionId(): RecordSessionError {
  return new RecordSessionError('Invalid record session id', 400)
}

function validateSessionId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw invalidSessionId()
}

function validateDimension(value: unknown, name: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < MIN_DIMENSION ||
    value > MAX_DIMENSION
  ) {
    throw new RecordSessionError(
      `Invalid ${name}: expected an integer from 1 to ${MAX_DIMENSION}`,
      400
    )
  }
  return value
}

function abortError(): RecordSessionError {
  return new RecordSessionError('Record session start aborted', 499)
}

/**
 * Owns the bridge-visible record sessions and their private temporary directories.
 * The registry, rather than renderer input, supplies every encoding setting except capture size.
 */
export class RecordSessionRegistry {
  private readonly sessions = new Map<string, SessionEntry>()
  private readonly create: RecordEncodingFactory
  private readonly idleTimeoutMs: number
  private readonly maxActive: number
  private pendingDirectories = 0

  constructor(
    private readonly hostConfig: RecordSessionHostConfig,
    maxActive: number,
    options: RecordSessionOptions = {}
  ) {
    this.create = options.createEncoding ?? createRecordEncoding
    this.idleTimeoutMs =
      Number.isFinite(options.idleTimeoutMs) && (options.idleTimeoutMs ?? 0) > 0
        ? Math.min(options.idleTimeoutMs!, 2_147_483_647)
        : DEFAULT_IDLE_TIMEOUT_MS
    this.maxActive = Math.max(1, Number.isFinite(maxActive) ? Math.floor(maxActive) : 1)
  }

  async start(
    inputWidth: unknown,
    inputHeight: unknown,
    signal?: AbortSignal
  ): Promise<{ id: string }> {
    const width = validateDimension(inputWidth, 'inputWidth')
    const height = validateDimension(inputHeight, 'inputHeight')
    if (this.sessions.size + this.pendingDirectories >= this.maxActive) {
      throw new RecordSessionError('Record session capacity is exhausted', 429)
    }
    if (signal?.aborted) throw abortError()
    this.pendingDirectories++

    const id = randomUUID()
    let directory: string
    try {
      directory = await mkdtemp(join(tmpdir(), 'mss-record-'))
    } catch (error) {
      this.pendingDirectories--
      throw error
    }
    this.pendingDirectories--
    const entry: SessionEntry = { id, directory, state: 'creating' }
    this.sessions.set(id, entry)

    const config: RecordEncodingConfig = {
      directory,
      inputWidth: width,
      inputHeight: height,
      width: this.hostConfig.width,
      height: this.hostConfig.height,
      fps: this.hostConfig.fps,
      crf: this.hostConfig.crf,
      encoder: this.hostConfig.encoder
    }
    const creation = Promise.resolve().then(() => {
      if (signal?.aborted) throw abortError()
      return this.create(config)
    })
    entry.creation = creation

    try {
      entry.encoder = await this.raceAbort(creation, signal)
      if (signal?.aborted) throw abortError()
      entry.state = 'open'
      this.armIdle(entry)
      return { id }
    } catch (error) {
      // A request may disappear while FFmpeg/session creation is still probing hardware. Keep the
      // reservation until the late session has been cancelled, so workers cannot be overcommitted.
      const cleanup = this.cleanupEntry(entry)
      if (signal?.aborted) {
        void cleanup.catch(() => undefined)
        throw abortError()
      }
      await cleanup.catch(() => undefined)
      throw error
    }
  }

  async append(id: unknown, chunk: Buffer): Promise<null> {
    const entry = this.getEntry(id)
    if (entry.state !== 'open' || !entry.encoder) {
      throw new RecordSessionError(
        entry.state === 'cancelling'
          ? 'Record session is being cancelled'
          : 'Record session is finishing or closed',
        409
      )
    }
    if (!Buffer.isBuffer(chunk)) throw new RecordSessionError('Record chunk must be binary', 400)
    this.armIdle(entry)
    try {
      await entry.encoder.append(chunk)
      if (entry.cancelPromise) throw new RecordSessionError('Record session was cancelled', 409)
      this.armIdle(entry)
      return null
    } catch (error) {
      const failure = errorMessage(error)
      await this.cleanupEntry(entry).catch(() => undefined)
      throw failure
    }
  }

  async finish(id: unknown): Promise<RecordEncodingResult> {
    const entry = this.getEntry(id)
    if (entry.state === 'cancelling')
      throw new RecordSessionError('Record session is being cancelled', 409)
    if (entry.state === 'finished') return entry.finishPromise!
    if (entry.state === 'finishing') return entry.finishPromise!
    if (!entry.encoder || entry.state !== 'open') {
      throw new RecordSessionError('Record session is not ready', 409)
    }

    entry.state = 'finishing'
    this.clearIdle(entry)
    const finishPromise = (async () => {
      try {
        const result = await entry.encoder!.finish()
        if (entry.state === 'cancelling')
          throw new RecordSessionError('Record session was cancelled', 409)
        entry.state = 'finished'
        // Finished files are intentionally retained for api-remux; expire leaked finished sessions.
        this.armIdle(entry)
        return result
      } catch (error) {
        const failure = errorMessage(error)
        await this.cleanupEntry(entry).catch(() => undefined)
        throw failure
      }
    })()
    entry.finishPromise = finishPromise
    void finishPromise.catch(() => undefined)
    return finishPromise
  }

  async mux(
    id: unknown,
    payload: { outputPath?: unknown; audioPath?: unknown; audioBitrate?: unknown }
  ): Promise<RecordMuxResult> {
    const entry = this.getEntry(id)
    if (entry.state !== 'finished' || !entry.encoder) {
      throw new RecordSessionError('Record encoding must finish before muxing', 409)
    }
    if (
      typeof payload.outputPath !== 'string' ||
      !payload.outputPath ||
      (payload.audioPath !== undefined && typeof payload.audioPath !== 'string') ||
      typeof payload.audioBitrate !== 'string' ||
      !/^\d+(?:\.\d+)?[kKmM]?$/.test(payload.audioBitrate)
    ) {
      throw new RecordSessionError('Invalid record mux paths or audio bitrate', 400)
    }
    entry.state = 'muxing'
    this.clearIdle(entry)
    entry.muxAbort = new AbortController()
    entry.muxPromise = (async () => {
      const exists = await stat(payload.outputPath as string).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false
          throw error
        }
      )
      if (exists) throw new RecordSessionError('Record mux output already exists', 409)
      if (entry.muxAbort!.signal.aborted)
        throw new RecordSessionError('Record mux was cancelled', 409)
      entry.muxOutputPath = payload.outputPath as string
      return muxRecordVideo({
        videoPath: entry.encoder!.outputPath,
        audioPath: payload.audioPath as string | undefined,
        outputPath: payload.outputPath as string,
        audioBitrate: payload.audioBitrate as string,
        signal: entry.muxAbort!.signal
      })
    })().then((result) => {
      if (entry.cancelPromise || entry.muxAbort!.signal.aborted) {
        throw new RecordSessionError('Record mux was cancelled', 409)
      }
      entry.muxSucceeded = true
      entry.state = 'muxed'
      this.armIdle(entry)
      return result
    })
    try {
      return await entry.muxPromise
    } catch (error) {
      // cleanup waits for the raw mux promise, not this request's error handler.
      if (!entry.cancelPromise) await this.cleanupEntry(entry).catch(() => undefined)
      throw error
    }
  }

  async cancel(id: unknown): Promise<null> {
    validateSessionId(id)
    const entry = this.sessions.get(id)
    // Cancellation is intentionally idempotent, including after TTL cleanup or a prior cancel.
    if (!entry) return null
    if (entry.cancelPromise) {
      await entry.cancelPromise
      return null
    }

    entry.state = 'cancelling'
    this.clearIdle(entry)
    entry.cancelPromise = (async () => {
      let failure: Error | undefined
      try {
        await this.stopMux(entry)
        if (entry.encoder) await entry.encoder.cancel()
        else if (entry.creation) {
          // Creation is normally handled by start's abort path; this branch is defensive.
          const encoder = await entry.creation
          await encoder.cancel()
        }
      } catch (error) {
        failure = errorMessage(error)
      } finally {
        try {
          await rm(entry.directory, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 100
          })
        } finally {
          this.removeEntry(entry)
        }
      }
      if (failure) throw failure
    })()
    await entry.cancelPromise
    return null
  }

  private getEntry(id: unknown): SessionEntry {
    validateSessionId(id)
    const entry = this.sessions.get(id)
    if (!entry) throw new RecordSessionError('Unknown record session', 404)
    return entry
  }

  private async raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise
    if (signal.aborted) throw abortError()
    let onAbort: (() => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(abortError())
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([promise, aborted])
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }

  private armIdle(entry: SessionEntry): void {
    this.clearIdle(entry)
    if (entry.state !== 'open' && entry.state !== 'finished' && entry.state !== 'muxed') return
    entry.idleTimer = setTimeout(() => {
      void this.cancel(entry.id).catch(() => undefined)
    }, this.idleTimeoutMs)
    entry.idleTimer.unref?.()
  }

  private clearIdle(entry: SessionEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = undefined
  }

  private async stopMux(entry: SessionEntry): Promise<void> {
    if (entry.muxAbort && entry.muxPromise) {
      entry.muxAbort.abort()
      await entry.muxPromise.catch(() => undefined)
      entry.muxAbort = undefined
      entry.muxPromise = undefined
      if (!entry.muxSucceeded && entry.muxOutputPath) {
        await rm(entry.muxOutputPath, { force: true })
      }
    }
  }

  private async cleanupEntry(entry: SessionEntry): Promise<void> {
    if (entry.cancelPromise) {
      await entry.cancelPromise.catch(() => undefined)
      return
    }
    entry.state = 'cancelling'
    this.clearIdle(entry)
    entry.cancelPromise = (async () => {
      try {
        await this.stopMux(entry)
        if (entry.encoder) {
          await entry.encoder.cancel()
        } else if (entry.creation) {
          // A disconnected start may still be probing hardware. Reap the eventual encoder, while
          // treating a failed creation as already cleaned up.
          try {
            const encoder = await entry.creation
            await encoder.cancel()
          } catch {
            /* creation failure is handled by the caller's original promise */
          }
        }
      } finally {
        try {
          await rm(entry.directory, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 100
          })
        } finally {
          this.removeEntry(entry)
        }
      }
    })()
    await entry.cancelPromise
  }

  private removeEntry(entry: SessionEntry): void {
    this.clearIdle(entry)
    if (this.sessions.get(entry.id) === entry) this.sessions.delete(entry.id)
  }
}
