import express, { Router, Request, Response, NextFunction } from 'express'
import crypto from 'node:crypto'
import * as fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { ILogObj, Logger } from 'tslog'
import type { HostConfig } from '../config'
import {
  apiConvertVideoWithCompression,
  apiMergeVideoAudioWithCompression,
  apiMuxVideoAudioCopy,
  apiCopyVideo,
  encodeFramesToVideo,
  createFramesPipeSession,
  type FramesPipeSession,
  VideoEncoderChoice
} from '../../shared/ffmpeg'

export interface BridgeController {
  cleanupWorker(workerId: string): Promise<void>
  disposeAll(): Promise<void>
  activePipeSessionCount(): number
}

interface BridgeDeps {
  logger: Logger<ILogObj>
  config: HostConfig
  /** Internal session token authenticating RenderPool worker pages & bridge calls. */
  bridgeToken?: string
  /** Optional additional writable output directories (for tests / custom roots). */
  allowedOutputDirs?: string[]
  /** Optional idle timeout (ms) for cached write-file-at FileHandles. */
  fileHandleIdleMs?: number
  /** Optional idle timeout (ms) for active FramesPipeSessions. */
  framesPipeIdleMs?: number
  /** Optional factory override for FramesPipeSession (used in tests). */
  createFramesPipe?: typeof createFramesPipeSession
  /** Callback receiving lifecycle controller for worker-recycle and shutdown cleanup. */
  onController?: (controller: BridgeController) => void
}

const DEFAULT_FILE_HANDLE_IDLE_MS = 30_000
const DEFAULT_FRAMES_PIPE_IDLE_MS = 125_000
const ALLOWED_PROXY_METHODS = new Set(['GET', 'HEAD', 'POST'])
const SAFE_TEMP_PREFIX_RE = /^[a-zA-Z0-9_-]{1,64}$/
const SAFE_TEMP_EXT_RE = /^[a-zA-Z0-9]{1,16}$/

const activeBridgeControllers = new Set<BridgeController>()
let processBeforeExitHooked = false

function ensureBeforeExitCleanup(): void {
  if (processBeforeExitHooked) return
  processBeforeExitHooked = true
  process.on('beforeExit', () => {
    for (const ctrl of Array.from(activeBridgeControllers)) {
      void ctrl.disposeAll().catch(() => {})
    }
  })
}

function extractWorkerId(req: Request, payload?: unknown): string | null {
  const fromPayload = (payload as { workerId?: unknown } | undefined)?.workerId
  if (typeof fromPayload === 'string' && fromPayload.trim()) {
    return fromPayload.trim()
  }
  const fromHeader = req.headers['x-mss-worker-id']
  if (typeof fromHeader === 'string' && fromHeader.trim()) {
    return fromHeader.trim()
  }
  const referer = req.headers.referer
  if (typeof referer === 'string' && referer) {
    try {
      const worker = new URL(referer).searchParams.get('worker')
      if (worker && worker.trim()) return worker.trim()
    } catch {
      // ignore invalid referer
    }
  }
  return null
}

export class BridgeSecurityError extends Error {
  readonly statusCode: number
  constructor(message: string, statusCode = 403) {
    super(message)
    this.name = 'BridgeSecurityError'
    this.statusCode = statusCode
  }
}

function timingSafeTokenEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function normalizePathForCompare(target: string): string {
  return process.platform === 'win32' ? target.toLowerCase() : target
}

function resolveWithExistingRealpath(targetPath: string): string {
  const resolved = path.resolve(targetPath)
  const parts: string[] = []
  let current = resolved
  while (true) {
    try {
      const real = fs.realpathSync(current)
      return parts.length ? path.join(real, ...parts.reverse()) : real
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return resolved
      parts.push(path.basename(current))
      current = parent
    }
  }
}

function isStrictlyWithinRoot(targetPath: string, rootDir: string): boolean {
  const rel = path.relative(normalizePathForCompare(rootDir), normalizePathForCompare(targetPath))
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function assertContainedPath(targetPath: unknown, allowedRoots: string[], label: string): string {
  if (typeof targetPath !== 'string' || !targetPath || targetPath.includes('\0')) {
    throw new BridgeSecurityError(`Invalid ${label}`, 400)
  }
  const resolved = resolveWithExistingRealpath(targetPath)
  if (!allowedRoots.some((root) => isStrictlyWithinRoot(resolved, root))) {
    throw new BridgeSecurityError(`Path outside allowed workspace/temp root (${label})`, 403)
  }
  return resolved
}

function parseAllowlistedOrigin(
  rawUrl: string | undefined
): { origin: string; basePath: string } | null {
  if (!rawUrl) return null
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    const basePath = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`
    return { origin: parsed.origin, basePath }
  } catch {
    return null
  }
}

function isAllowedProxyTarget(
  rawUrl: unknown,
  allowlist: Array<{ origin: string; basePath: string }>
): URL | null {
  if (typeof rawUrl !== 'string' || !rawUrl) return null
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password) return null
  for (const entry of allowlist) {
    if (parsed.origin !== entry.origin) continue
    if (
      entry.basePath === '/' ||
      parsed.pathname === entry.basePath.slice(0, -1) ||
      parsed.pathname.startsWith(entry.basePath)
    ) {
      return parsed
    }
  }
  return null
}

/** 临时名随机后缀：避免同毫秒并发导出共用同一路径 */
function randomSuffix(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12)
}

/**
 * 渲染页面 ↔ 宿主的桥接层。
 * 通道语义与原 Electron IpcHandler 对齐：
 * - api-export-video-from-files：ffmpeg 转码/合流后删除输入文件
 * - tts-fetch：受 tts.timeoutMs 控制的代理；translation-fetch：无超时代理
 * 配置（TTS/BGM）由宿主在任务下发时注入 payload，不再走配置文件通道。
 */
export function createBridgeRouter(deps: BridgeDeps): Router {
  const { logger, config } = deps
  const router = Router()

  const allowedTempRoots = Array.from(
    new Set([resolveWithExistingRealpath(tmpdir()), path.resolve(tmpdir())])
  )
  const allowedOutputRoots = Array.from(
    new Set([
      ...allowedTempRoots,
      ...[config.paths?.output, ...(deps.allowedOutputDirs ?? [])]
        .filter((d): d is string => Boolean(d))
        .map((d) => resolveWithExistingRealpath(d))
    ])
  )

  const ttsAllowlist = [
    parseAllowlistedOrigin(config.tts?.apiBaseUrl || 'http://127.0.0.1:9880')
  ].filter((x): x is { origin: string; basePath: string } => x !== null)

  const translationAllowlist = [
    parseAllowlistedOrigin(config.llm?.enabled !== false ? config.llm?.baseUrl : undefined)
  ].filter((x): x is { origin: string; basePath: string } => x !== null)

  const fileHandleIdleMs = deps.fileHandleIdleMs ?? DEFAULT_FILE_HANDLE_IDLE_MS
  interface CachedFileHandleEntry {
    handle: fs.promises.FileHandle | null
    tail: Promise<void>
    idleTimer: ReturnType<typeof setTimeout> | null
    closed: boolean
  }
  const cachedFileHandles = new Map<string, CachedFileHandleEntry>()

  async function closeCachedFileHandle(filePath: string): Promise<void> {
    const key = normalizePathForCompare(path.resolve(filePath))
    const entry = cachedFileHandles.get(key)
    if (!entry) return
    cachedFileHandles.delete(key)
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
    entry.closed = true
    await entry.tail.catch(() => {})
    const handle = entry.handle
    entry.handle = null
    if (handle) {
      try {
        await handle.sync()
      } catch {
        /* ignore sync failure on close */
      }
      await handle.close().catch(() => {})
    }
  }

  async function closeCachedFileHandlesUnder(targetPath: string): Promise<void> {
    const resolvedTarget = path.resolve(targetPath)
    const keysToClose: string[] = []
    for (const key of cachedFileHandles.keys()) {
      if (
        key === normalizePathForCompare(resolvedTarget) ||
        isStrictlyWithinRoot(key, normalizePathForCompare(resolvedTarget))
      ) {
        keysToClose.push(key)
      }
    }
    await Promise.all(keysToClose.map((k) => closeCachedFileHandle(k)))
  }

  async function writeFileAtCached(
    resolvedPath: string,
    position: number,
    body: Buffer
  ): Promise<void> {
    const key = normalizePathForCompare(path.resolve(resolvedPath))
    let entry = cachedFileHandles.get(key)
    if (!entry || entry.closed) {
      entry = {
        handle: null,
        tail: Promise.resolve(),
        idleTimer: null,
        closed: false
      }
      cachedFileHandles.set(key, entry)
    }

    const currentEntry = entry
    const op = currentEntry.tail.then(async () => {
      if (currentEntry.closed) {
        throw new Error('Cached file handle was closed')
      }
      if (!currentEntry.handle) {
        await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true })
        currentEntry.handle = await fs.promises.open(resolvedPath, 'r+')
      }
      if (currentEntry.idleTimer) {
        clearTimeout(currentEntry.idleTimer)
      }
      currentEntry.idleTimer = setTimeout(() => {
        void closeCachedFileHandle(resolvedPath)
      }, fileHandleIdleMs)
      currentEntry.idleTimer.unref?.()

      await currentEntry.handle.write(body, 0, body.length, position)
    })

    currentEntry.tail = op.catch(async () => {
      await closeCachedFileHandle(resolvedPath)
    })

    await op
  }

  interface PipeStreamEntry {
    id: string
    session: FramesPipeSession
    dir: string
    videoPath: string
    workerId: string | null
    idleTimer: ReturnType<typeof setTimeout> | null
    cleaning?: Promise<void>
  }
  const framesPipeSessions = new Map<string, PipeStreamEntry>()
  const framesPipeIdleMs = deps.framesPipeIdleMs ?? DEFAULT_FRAMES_PIPE_IDLE_MS
  const createPipe = deps.createFramesPipe ?? createFramesPipeSession

  async function cleanupPipeSession(id: string, reason?: Error): Promise<void> {
    const entry = framesPipeSessions.get(id)
    if (!entry) return
    if (entry.cleaning) {
      await entry.cleaning
      return
    }
    framesPipeSessions.delete(id)
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
    entry.cleaning = (async () => {
      await entry.session.abort(reason).catch(() => {})
      await fs.promises.rm(entry.dir, { recursive: true, force: true }).catch(() => {})
    })()
    await entry.cleaning
  }

  function touchPipeIdle(entry: PipeStreamEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
    }
    entry.idleTimer = setTimeout(() => {
      void cleanupPipeSession(entry.id, new Error('Frames stream idle timeout'))
    }, framesPipeIdleMs)
    entry.idleTimer.unref?.()
  }

  const controller: BridgeController = {
    async cleanupWorker(workerId: string): Promise<void> {
      const targets = Array.from(framesPipeSessions.values())
        .filter((entry) => entry.workerId === workerId)
        .map((entry) => entry.id)
      if (targets.length === 0) return
      logger.warn(
        `[Bridge] Cleaning up ${targets.length} orphaned framesPipeSessions for worker ${workerId}`
      )
      await Promise.allSettled(
        targets.map((id) =>
          cleanupPipeSession(id, new Error(`Render worker ${workerId} recycled or disconnected`))
        )
      )
    },
    async disposeAll(): Promise<void> {
      activeBridgeControllers.delete(controller)
      const pipeIds = Array.from(framesPipeSessions.keys())
      const fileKeys = Array.from(cachedFileHandles.keys())
      await Promise.allSettled([
        ...pipeIds.map((id) => cleanupPipeSession(id, new Error('Bridge router shutting down'))),
        ...fileKeys.map((key) => closeCachedFileHandle(key))
      ])
    },
    activePipeSessionCount(): number {
      return framesPipeSessions.size
    }
  }
  activeBridgeControllers.add(controller)
  ensureBeforeExitCleanup()
  deps.onController?.(controller)

  // 桥接安全中间件：剥离全局 CORS、限制同源、验证 RenderPool 会话令牌
  router.use((req: Request, res: Response, next: NextFunction) => {
    res.removeHeader('Access-Control-Allow-Origin')
    res.removeHeader('Access-Control-Allow-Methods')
    res.removeHeader('Access-Control-Allow-Headers')

    const origin = req.headers.origin
    if (origin) {
      let originHost = ''
      try {
        originHost = new URL(origin).host
      } catch {
        originHost = ''
      }
      if (!originHost || !req.headers.host || originHost !== req.headers.host) {
        res.status(403).json({ ok: false, error: 'Cross-origin bridge requests are forbidden' })
        return
      }
    }

    if (deps.bridgeToken) {
      const headerToken = req.headers['x-mss-bridge-token']
      const authHeader = req.headers.authorization
      const bearerToken =
        typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
          ? authHeader.slice(7).trim()
          : ''
      const queryToken = typeof req.query.token === 'string' ? req.query.token : ''
      const provided =
        (typeof headerToken === 'string' ? headerToken : '') || bearerToken || queryToken
      if (!provided || !timingSafeTokenEqual(provided, deps.bridgeToken)) {
        res.status(401).json({ ok: false, error: 'Unauthorized bridge request' })
        return
      }
    }

    next()
  })

  // ----- JSON invoke 通道 -----

  router.post('/invoke/:channel', express.json({ limit: '50mb' }), async (req, res) => {
    const channel = String(req.params.channel)
    const args = (Array.isArray(req.body) ? req.body : []) as unknown[]

    const abort = new AbortController()
    let startedPipeId: string | undefined
    const onDisconnect = (): void => {
      if (res.writableFinished) return
      abort.abort()
      const targetId =
        startedPipeId ?? ((args[0] as { id?: unknown } | undefined)?.id as string | undefined)
      if (
        (channel === 'electron:frames-stream-start' ||
          channel === 'electron:frames-stream-finish') &&
        typeof targetId === 'string' &&
        targetId
      ) {
        void cleanupPipeSession(targetId, new Error(`Bridge ${channel} request disconnected`))
      }
    }
    req.once('aborted', onDisconnect)
    res.once('close', onDisconnect)
    const detach = (): void => {
      req.off('aborted', onDisconnect)
      res.off('close', onDisconnect)
    }

    try {
      let result: unknown
      if (channel === 'electron:frames-stream-start') {
        const started = await startFramesPipeSession(args[0], req, abort.signal)
        startedPipeId = started.id
        if (abort.signal.aborted) {
          await cleanupPipeSession(startedPipeId, new Error('Frames stream start aborted'))
          return
        }
        result = started
      } else {
        result = await handleInvoke(channel, args)
      }
      if (!res.destroyed) res.json({ ok: true, result })
    } catch (error) {
      logger.error(`[Bridge] invoke ${channel} failed`, error)
      const status = error instanceof BridgeSecurityError ? error.statusCode : 500
      if (!res.destroyed)
        res.status(status).json({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
    } finally {
      detach()
    }
  })

  async function startFramesPipeSession(
    rawPayload: unknown,
    req: Request,
    signal: AbortSignal
  ): Promise<{ id: string; videoPath: string }> {
    if (signal.aborted) {
      throw new BridgeSecurityError('Frames stream start aborted', 499)
    }
    const payload = (rawPayload ?? {}) as {
      fps?: number
      width?: number
      height?: number
      inputWidth?: number
      inputHeight?: number
      crf?: number
      workerId?: string
    }
    const fps = Number(payload.fps) > 0 ? Number(payload.fps) : config.video.fps
    const width = Number(payload.width) > 0 ? Number(payload.width) : config.video.width
    const height = Number(payload.height) > 0 ? Number(payload.height) : config.video.height
    const dir = path.join(tmpdir(), `mss-fpipe-${Date.now()}-${randomSuffix()}`)
    await fs.promises.mkdir(dir, { recursive: true })
    const videoPath = path.join(dir, 'video.mp4')
    const id = randomSuffix()

    let session: FramesPipeSession
    try {
      session = await createPipe({
        fps,
        width,
        height,
        inputWidth: payload.inputWidth,
        inputHeight: payload.inputHeight,
        crf: payload.crf ?? config.video.crf,
        encoder: config.video.encoder as VideoEncoderChoice,
        outputPath: videoPath
      })
    } catch (error) {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
      throw error
    }

    if (signal.aborted) {
      await session.abort(new Error('Frames stream start aborted')).catch(() => {})
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
      throw new BridgeSecurityError('Frames stream start aborted', 499)
    }

    const entry: PipeStreamEntry = {
      id,
      session,
      dir,
      videoPath,
      workerId: extractWorkerId(req, payload),
      idleTimer: null
    }
    framesPipeSessions.set(id, entry)
    touchPipeIdle(entry)
    return { id, videoPath }
  }

  async function handleInvoke(channel: string, args: unknown[]): Promise<unknown> {
    switch (channel) {
      case 'electron:get-temp-dir': {
        const framesDir = path.join(tmpdir(), `mss-hf-${Date.now()}-${randomSuffix()}`, 'frames')
        await fs.promises.mkdir(framesDir, { recursive: true })
        return framesDir
      }

      case 'electron:get-temp-base-dir': {
        const baseDir = path.join(tmpdir(), `mss-export-${Date.now()}-${randomSuffix()}`)
        await fs.promises.mkdir(baseDir, { recursive: true })
        return baseDir
      }

      case 'electron:close-file-handle': {
        const payload = args[0] as { filePath?: string } | undefined
        if (!payload?.filePath) return null
        const resolved = assertContainedPath(payload.filePath, allowedTempRoots, 'temp file path')
        await closeCachedFileHandle(resolved)
        return null
      }

      case 'electron:delete-temp-file': {
        // 导出失败/取消时的临时文件清理（ENOENT 等错误静默）；仅限 tmpdir 内路径
        const payload = args[0] as { filePath: string }
        if (!payload?.filePath) return null
        const resolved = assertContainedPath(payload.filePath, allowedTempRoots, 'temp file path')
        await closeCachedFileHandlesUnder(resolved)
        await fs.promises.rm(resolved, { recursive: true, force: true })
        return null
      }

      case 'electron:frames-stream-finish': {
        const payload = args[0] as { id?: string } | undefined
        const id = payload?.id
        const entry = id ? framesPipeSessions.get(id) : undefined
        if (!entry || !id) throw new Error('Unknown frames stream session')
        if (entry.idleTimer) {
          clearTimeout(entry.idleTimer)
          entry.idleTimer = null
        }
        try {
          const videoPath = await entry.session.finish()
          framesPipeSessions.delete(id)
          return { videoPath }
        } catch (error) {
          await cleanupPipeSession(id, error instanceof Error ? error : new Error(String(error)))
          throw error
        }
      }

      case 'electron:frames-stream-cancel': {
        const payload = args[0] as { id?: string } | undefined
        if (payload?.id) {
          await cleanupPipeSession(payload.id, new Error('Frames stream cancelled'))
        }
        return null
      }

      case 'electron:api-export-video-from-files': {
        const payload = args[0] as {
          videoPath: string
          audioPath?: string
          outputPath: string
          fps: number
          width: number
          height: number
          crf: number
          audioBitrate: string
          /** 录制文件的实际像素尺寸（画布后备存储）；缺省时按配置分辨率处理（旧渲染端兼容） */
          inputWidth?: number
          inputHeight?: number
          /** 录制时使用的视频码率（bps），用于 ffmpeg 超时/进度估算 */
          recordedBitrate?: number
        }
        const safeVideoPath = assertContainedPath(payload?.videoPath, allowedTempRoots, 'videoPath')
        const safeAudioPath = payload?.audioPath
          ? assertContainedPath(payload.audioPath, allowedTempRoots, 'audioPath')
          : undefined
        const safeOutputPath = assertContainedPath(
          payload?.outputPath,
          allowedOutputRoots,
          'outputPath'
        )
        await closeCachedFileHandle(safeVideoPath)

        logger.info(
          `[Bridge] API: videoPath=${safeVideoPath}, audioPath=${safeAudioPath}, outputPath=${safeOutputPath}`
        )

        try {
          const channelStart = Date.now()
          const outputDir = path.dirname(safeOutputPath)
          if (!fs.existsSync(outputDir)) {
            await fs.promises.mkdir(outputDir, { recursive: true })
          }

          const encoder = config.video.encoder as VideoEncoderChoice
          // 输入尺寸缺省时保守回退配置分辨率：与输出相同时会跳过缩放滤镜，
          // 旧渲染端（renderScale≠1 时画布大于输出）因此保持原有缩放行为
          const inputWidth = payload.inputWidth ?? config.video.width
          const inputHeight = payload.inputHeight ?? config.video.height
          const recordedBitrate = payload.recordedBitrate ?? 8_000_000

          if (safeAudioPath && fs.existsSync(safeAudioPath)) {
            await apiMergeVideoAudioWithCompression(
              safeVideoPath,
              safeAudioPath,
              safeOutputPath,
              payload.crf,
              payload.audioBitrate,
              payload.fps,
              encoder,
              config.video.width,
              config.video.height,
              inputWidth,
              inputHeight,
              recordedBitrate
            )
          } else {
            await apiConvertVideoWithCompression(
              safeVideoPath,
              safeOutputPath,
              payload.crf,
              payload.fps,
              encoder,
              config.video.width,
              config.video.height,
              inputWidth,
              inputHeight,
              recordedBitrate
            )
          }

          if (!fs.existsSync(safeOutputPath)) {
            logger.error(`[Bridge] API: Output file NOT found at: ${safeOutputPath}`)
            return {
              success: false,
              error: 'Video encoding completed but output file not found'
            }
          }

          const outputSize = (await fs.promises.stat(safeOutputPath)).size
          logger.info(
            `[Bridge] API: Video exported successfully: ${safeOutputPath}, ` +
              `size=${(outputSize / 1024 / 1024).toFixed(2)} MB, elapsedMs=${Date.now() - channelStart}`
          )
          return { success: true, outputPath: safeOutputPath, fileSize: outputSize }
        } catch (error) {
          logger.error('[Bridge] API: Failed to export video from files', error)
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
          }
        } finally {
          try {
            await fs.promises.unlink(safeVideoPath)
          } catch {
            /* cleanup */
          }
          try {
            if (safeAudioPath) await fs.promises.unlink(safeAudioPath)
          } catch {
            /* cleanup */
          }
        }
      }

      case 'electron:api-remux-video-from-files': {
        // fast 导出收尾：页内 WebCodecs 已产出 H.264 MP4，仅 remux/合流，不重编码
        const payload = args[0] as {
          videoPath: string
          audioPath?: string
          outputPath: string
          audioBitrate: string
          /** true 时保留输入文件由调用方自行清理（record 会在 finally 中取消 session） */
          keepInputs?: boolean
        }
        const safeVideoPath = assertContainedPath(payload?.videoPath, allowedTempRoots, 'videoPath')
        const safeAudioPath = payload?.audioPath
          ? assertContainedPath(payload.audioPath, allowedTempRoots, 'audioPath')
          : undefined
        const safeOutputPath = assertContainedPath(
          payload?.outputPath,
          allowedOutputRoots,
          'outputPath'
        )
        await closeCachedFileHandle(safeVideoPath)

        logger.info(
          `[Bridge] API remux: videoPath=${safeVideoPath}, audioPath=${safeAudioPath}, outputPath=${safeOutputPath}`
        )

        try {
          const channelStart = Date.now()
          const outputDir = path.dirname(safeOutputPath)
          if (!fs.existsSync(outputDir)) {
            await fs.promises.mkdir(outputDir, { recursive: true })
          }

          const hasAudio = !!safeAudioPath && fs.existsSync(safeAudioPath)
          if (hasAudio) {
            await apiMuxVideoAudioCopy(
              safeVideoPath,
              safeAudioPath!,
              safeOutputPath,
              payload.audioBitrate
            )
          } else {
            await apiCopyVideo(safeVideoPath, safeOutputPath)
          }

          if (!fs.existsSync(safeOutputPath)) {
            logger.error(`[Bridge] API remux: Output file NOT found at: ${safeOutputPath}`)
            return {
              success: false,
              error: 'Video remux completed but output file not found'
            }
          }

          const outputSize = (await fs.promises.stat(safeOutputPath)).size
          logger.info(
            `[Bridge] API remux: Video exported successfully: ${safeOutputPath}, ` +
              `size=${(outputSize / 1024 / 1024).toFixed(2)} MB, elapsedMs=${Date.now() - channelStart}`
          )
          return {
            success: true,
            outputPath: safeOutputPath,
            fileSize: outputSize,
            sizeCapped: false
          }
        } catch (error) {
          logger.error('[Bridge] API remux: Failed to remux video from files', error)
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
          }
        } finally {
          if (payload.keepInputs) {
            // 输入保留给调用方（失败回退或自行清理）
          } else {
            try {
              await fs.promises.unlink(safeVideoPath)
              const parent = path.dirname(safeVideoPath)
              if (path.basename(parent).startsWith('mss-fpipe-')) {
                await fs.promises.rmdir(parent).catch(() => {})
              }
            } catch {
              /* cleanup */
            }
            try {
              if (safeAudioPath) await fs.promises.unlink(safeAudioPath)
            } catch {
              /* cleanup */
            }
          }
        }
      }

      case 'electron:api-encode-frames-video': {
        // fast 导出 JPEG 兜底收尾：帧序列 → ffmpeg 编码 → 可选音频合流
        const payload = args[0] as {
          framesDir: string
          audioPath?: string
          outputPath: string
          fps: number
          audioBitrate: string
          inputWidth?: number
          inputHeight?: number
        }
        const safeFramesDir = assertContainedPath(payload?.framesDir, allowedTempRoots, 'framesDir')
        const safeAudioPath = payload?.audioPath
          ? assertContainedPath(payload.audioPath, allowedTempRoots, 'audioPath')
          : undefined
        const safeOutputPath = assertContainedPath(
          payload?.outputPath,
          allowedOutputRoots,
          'outputPath'
        )
        logger.info(
          `[Bridge] API frames-encode: framesDir=${safeFramesDir}, audioPath=${safeAudioPath}, outputPath=${safeOutputPath}`
        )

        let encoded = false
        let intermediatePath: string | null = null
        try {
          const channelStart = Date.now()
          const outputDir = path.dirname(safeOutputPath)
          if (!fs.existsSync(outputDir)) {
            await fs.promises.mkdir(outputDir, { recursive: true })
          }

          const encoder = config.video.encoder as VideoEncoderChoice
          const hasAudio = Boolean(safeAudioPath && fs.existsSync(safeAudioPath))
          intermediatePath = hasAudio
            ? path.join(outputDir, `.mss-frames-video-${Date.now()}-${randomSuffix()}.mp4`)
            : safeOutputPath

          await encodeFramesToVideo(
            payload.fps,
            safeFramesDir,
            intermediatePath,
            encoder,
            config.video.width,
            config.video.height,
            config.video.crf,
            payload.inputWidth ?? 0,
            payload.inputHeight ?? 0
          )

          if (hasAudio && safeAudioPath) {
            await apiMuxVideoAudioCopy(
              intermediatePath,
              safeAudioPath,
              safeOutputPath,
              payload.audioBitrate
            )
          }

          if (!fs.existsSync(safeOutputPath)) {
            logger.error(`[Bridge] API frames-encode: Output file NOT found at: ${safeOutputPath}`)
            return {
              success: false,
              error: 'Frame encoding completed but output file not found'
            }
          }

          const outputSize = (await fs.promises.stat(safeOutputPath)).size
          logger.info(
            `[Bridge] API frames-encode: Video exported successfully: ${safeOutputPath}, ` +
              `size=${(outputSize / 1024 / 1024).toFixed(2)} MB, elapsedMs=${Date.now() - channelStart}`
          )
          encoded = true
          return { success: true, outputPath: safeOutputPath, fileSize: outputSize }
        } catch (error) {
          logger.error('[Bridge] API frames-encode failed', error)
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
          }
        } finally {
          if (intermediatePath && intermediatePath !== safeOutputPath) {
            try {
              await fs.promises.unlink(intermediatePath)
            } catch {
              /* cleanup */
            }
          }
          try {
            if (safeAudioPath) await fs.promises.unlink(safeAudioPath)
          } catch {
            /* cleanup */
          }
          // 成片已写出，JPEG 帧序列不再需要；每份 50-400MB，放着会把 /tmp 撑满（6 小时的清扫兜底太慢）。
          if (encoded) {
            try {
              await fs.promises.rm(safeFramesDir, { recursive: true, force: true })
              const parent = path.dirname(safeFramesDir)
              if (path.basename(parent).startsWith('mss-hf-')) await fs.promises.rmdir(parent)
            } catch {
              /* 目录可能已被清扫或仍被占用 */
            }
          }
        }
      }

      case 'electron:write-frame-batch': {
        // 帧捕获回退路径：批量 base64 帧写盘
        const batch = args[0] as Array<{ path: string; data: string }>
        const safeBatch = batch.map((item) => ({
          path: assertContainedPath(item?.path, allowedTempRoots, 'frame path'),
          data: item.data
        }))
        await Promise.allSettled(
          safeBatch.map(async (item) => {
            const buffer = Buffer.from(item.data, 'base64')
            await fs.promises.writeFile(item.path, buffer)
          })
        )
        return null
      }

      default:
        throw new Error(`Unsupported bridge invoke channel: ${channel}`)
    }
  }

  // ----- 二进制 invoke 通道（裸 body 传输大块数据，其余参数走 query） -----

  router.post(
    '/bin/:channel',
    express.raw({ type: '*/*', limit: '500mb' }),
    async (req: Request, res: Response, _next: NextFunction) => {
      const channel = String(req.params.channel)
      let args: unknown[] = []
      try {
        const raw = (req.query.args as string) || '[]'
        args = JSON.parse(raw) as unknown[]
      } catch {
        res.status(400).json({ ok: false, error: 'Invalid args query parameter' })
        return
      }

      const onDisconnect = (): void => {
        if (res.writableFinished || channel !== 'electron:frames-stream-chunk') return
        const id = (args[0] as { id?: unknown } | undefined)?.id
        if (typeof id === 'string' && id) {
          void cleanupPipeSession(id, new Error('Frames stream chunk request aborted'))
        }
      }
      req.once('aborted', onDisconnect)
      res.once('close', onDisconnect)
      const detach = (): void => {
        req.off('aborted', onDisconnect)
        res.off('close', onDisconnect)
      }
      try {
        const result = await handleBinaryInvoke(channel, args, req.body as Buffer)
        if (!res.destroyed) res.json({ ok: true, result })
      } catch (error) {
        logger.error(`[Bridge] bin ${channel} failed`, error)
        const status = error instanceof BridgeSecurityError ? error.statusCode : 500
        if (!res.destroyed)
          res.status(status).json({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })
      } finally {
        detach()
      }
    }
  )

  async function handleBinaryInvoke(
    channel: string,
    args: unknown[],
    body: Buffer
  ): Promise<unknown> {
    switch (channel) {
      case 'electron:frames-stream-chunk': {
        const payload = args[0] as { id?: string } | undefined
        const id = payload?.id
        const entry = id ? framesPipeSessions.get(id) : undefined
        if (!entry || !id) throw new Error('Unknown frames stream session')
        touchPipeIdle(entry)
        try {
          await entry.session.write(body)
          if (framesPipeSessions.has(id)) touchPipeIdle(entry)
          return null
        } catch (error) {
          await cleanupPipeSession(id, error instanceof Error ? error : new Error(String(error)))
          throw error
        }
      }

      case 'electron:append-to-file': {
        const payload = args[0] as { filePath: string }
        const safePath = assertContainedPath(payload?.filePath, allowedTempRoots, 'temp file path')
        await fs.promises.mkdir(path.dirname(safePath), { recursive: true })
        await fs.promises.appendFile(safePath, body)
        return null
      }

      case 'electron:write-file-at': {
        // mp4-muxer StreamTarget 的定位写：按活跃导出文件缓存 FileHandle，
        // 避免每块 MP4 数据重复 open/close，结束或空闲超时再 flush/close。
        const payload = args[0] as { filePath: string; position: number }
        const safePath = assertContainedPath(payload?.filePath, allowedTempRoots, 'temp file path')
        if (
          typeof payload.position !== 'number' ||
          !Number.isFinite(payload.position) ||
          payload.position < 0
        ) {
          throw new BridgeSecurityError('Invalid file write position', 400)
        }
        await writeFileAtCached(safePath, payload.position, body)
        return null
      }

      case 'electron:write-frame': {
        const payload = args[0] as { path: string }
        const safePath = assertContainedPath(payload?.path, allowedTempRoots, 'frame path')
        await fs.promises.writeFile(safePath, body)
        return null
      }

      case 'electron:write-temp-file': {
        const payload = args[0] as { prefix: string; extension: string }
        if (
          typeof payload?.prefix !== 'string' ||
          !SAFE_TEMP_PREFIX_RE.test(payload.prefix) ||
          typeof payload?.extension !== 'string' ||
          !SAFE_TEMP_EXT_RE.test(payload.extension)
        ) {
          throw new BridgeSecurityError('Invalid temp file prefix or extension', 400)
        }
        const tempPath = path.join(
          tmpdir(),
          `${payload.prefix}-${Date.now()}-${randomSuffix()}.${payload.extension}`
        )
        await fs.promises.writeFile(tempPath, body)
        logger.info(
          `[Bridge] Temp file written: ${tempPath}, size=${(body.length / 1024 / 1024).toFixed(2)} MB`
        )
        return tempPath
      }

      default:
        throw new Error(`Unsupported bridge binary channel: ${channel}`)
    }
  }

  // ----- 网络代理（与原 tts-fetch / translation-fetch 语义一致，限制目标白名单） -----

  router.post(
    '/proxy/tts-fetch',
    express.json({ limit: '10mb' }),
    async (req: Request, res: Response) => {
      const payload = req.body as {
        url: string
        method: string
        headers: Record<string, string>
        body: string
      }
      const targetUrl = isAllowedProxyTarget(payload?.url, ttsAllowlist)
      if (!targetUrl) {
        logger.warn(`[Bridge] Blocked TTS proxy target: ${payload?.url}`)
        res.status(403)
        res.setHeader('x-mss-status', '0')
        res.setHeader('x-mss-ok', '0')
        res.send(Buffer.alloc(0))
        return
      }
      const method = String(payload?.method || 'GET').toUpperCase()
      if (!ALLOWED_PROXY_METHODS.has(method)) {
        res.status(405)
        res.setHeader('x-mss-status', '0')
        res.setHeader('x-mss-ok', '0')
        res.send(Buffer.alloc(0))
        return
      }

      logger.info(`[Bridge] TTS proxy: ${method} ${targetUrl.href}`)

      try {
        const response = await fetch(targetUrl, {
          method,
          headers: payload.headers,
          redirect: 'manual',
          // GET/HEAD 请求不允许携带 body（Node fetch 会直接抛 TypeError）
          body: method !== 'GET' && method !== 'HEAD' ? payload.body : undefined,
          // Irodori 在聊天高峰会排队数分钟；代理超时必须跟 tts.timeoutMs 一致，
          // 否则会出现“宿主还没超时、桥接先掐断”的静音/重试行。
          signal: AbortSignal.timeout(Math.max(120000, config.tts?.timeoutMs ?? 120000))
        })
        const arrayBuffer = await response.arrayBuffer()
        res.setHeader('x-mss-status', String(response.status))
        res.setHeader('x-mss-ok', response.ok ? '1' : '0')
        res.send(Buffer.from(arrayBuffer))
      } catch (error) {
        logger.error('[Bridge] TTS proxy fetch failed', error)
        res.setHeader('x-mss-status', '0')
        res.setHeader('x-mss-ok', '0')
        res.send(Buffer.alloc(0))
      }
    }
  )

  router.post(
    '/proxy/translation-fetch',
    express.json({ limit: '10mb' }),
    async (req: Request, res: Response) => {
      const payload = req.body as {
        url: string
        method: string
        headers: Record<string, string>
        body: string
      }
      const targetUrl = isAllowedProxyTarget(payload?.url, translationAllowlist)
      if (!targetUrl) {
        logger.warn(`[Bridge] Blocked translation proxy target: ${payload?.url}`)
        res.status(403)
        res.setHeader('x-mss-status', '0')
        res.setHeader('x-mss-ok', '0')
        res.send('{}')
        return
      }
      const method = String(payload?.method || 'POST').toUpperCase()
      if (!ALLOWED_PROXY_METHODS.has(method)) {
        res.status(405)
        res.setHeader('x-mss-status', '0')
        res.setHeader('x-mss-ok', '0')
        res.send('{}')
        return
      }

      logger.info(`[Bridge] Translation proxy: ${method} ${targetUrl.href}`)

      try {
        const response = await fetch(targetUrl, {
          method,
          headers: payload.headers,
          redirect: 'manual',
          // GET/HEAD 请求不允许携带 body（Node fetch 会直接抛 TypeError）
          body: method !== 'GET' && method !== 'HEAD' ? payload.body : undefined,
          signal: AbortSignal.timeout(Math.max(30_000, config.llm?.timeoutMs ?? 120_000))
        })
        const text = await response.text()
        res.setHeader('x-mss-status', String(response.status))
        res.setHeader('x-mss-ok', response.ok ? '1' : '0')
        res.send(text)
      } catch (error) {
        logger.error('[Bridge] Translation proxy fetch failed', error)
        res.setHeader('x-mss-status', '0')
        res.setHeader('x-mss-ok', '0')
        res.send('{}')
      }
    }
  )

  return router
}
