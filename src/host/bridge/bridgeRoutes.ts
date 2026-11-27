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
  partialOutputPath,
  checkEncodeSize,
  checkFrameRange,
  normalizeVideoCodec,
  type FramePipeFormat,
  type FramesPipeSession,
  type VideoCodec,
  VideoEncoderChoice
} from '../../shared/ffmpeg'
import {
  RustFramesPipeSession,
  computeLipSync,
  getRustBridgeServerInfo,
  isRustExporterAvailable,
  mixAudioPlan,
  runRustRemux,
  startRustBridgeServer,
  stopRustBridgeServer,
  type RustAudioMixPlan,
  type RustBgmCue,
  type RustBridgeServerInfo,
  type RustSeCue,
  type RustVoiceTrack
} from '../export/rustExporter'

export interface BridgeController {
  bindWorkerTask(workerId: string, taskId: string): void
  unbindWorkerTask(workerId: string, taskId?: string): void
  cleanupTask(taskId: string): Promise<void>
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
const TEMP_TOMBSTONE_TTL_MS = 5 * 60 * 1000
const TEMP_TOMBSTONE_MAX_ENTRIES = 500
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

function isAllowedCloudOnlyResourceRelPath(relPosix: string): boolean {
  const clean = relPosix.replace(/^\/+/, '').toLowerCase()
  return (
    clean.startsWith('audio/bgm/cloud/') ||
    clean.startsWith('audio/se/cloud/') ||
    clean.startsWith('cloud/') ||
    clean.startsWith('inapp/')
  )
}

/** 创建 Bridge 音频路径解析器（供路由与单元测试复用）；cloudOnly=true 时拒绝非 cloud/ 的 resources 音频路径。 */
export function createOptionalAudioPathResolver(
  config: Pick<HostConfig, 'paths' | 'bgm' | 'assets'>,
  allowedTempRoots: string[] = [resolveWithExistingRealpath(tmpdir()), path.resolve(tmpdir())]
): (rawPath: unknown) => string | undefined {
  const resourceRoot = config.paths?.resources ? resolveWithExistingRealpath(config.paths.resources) : ''
  const customBgmPath = config.bgm?.path ? resolveWithExistingRealpath(config.bgm.path) : ''
  const allowedResourceRoots = Array.from(
    new Set([...(resourceRoot ? [resourceRoot] : []), ...allowedTempRoots])
  )

  return (rawPath: unknown): string | undefined => {
    if (typeof rawPath !== 'string' || !rawPath.trim() || rawPath.includes('\0')) return undefined
    let candidate = rawPath.trim()
    if (/^https?:\/\//i.test(candidate)) {
      try {
        candidate = new URL(candidate).pathname
      } catch {
        return undefined
      }
    }
    if (candidate.startsWith('/resources/')) {
      if (!resourceRoot) return undefined
      candidate = path.join(resourceRoot, candidate.slice('/resources/'.length))
    } else if (!path.isAbsolute(candidate)) {
      if (!resourceRoot) return undefined
      const stripped = candidate
        .replace(/^\/+/, '')
        .replace(/^resources\/builtin\//, '')
        .replace(/^resources\//, '')
      candidate = path.join(resourceRoot, stripped)
    }
    const resolvedCandidate = resolveWithExistingRealpath(candidate)
    if (config.assets?.cloudOnly && resourceRoot) {
      const relToResource = path.relative(
        normalizePathForCompare(resourceRoot),
        normalizePathForCompare(resolvedCandidate)
      )
      if (
        !relToResource ||
        (!relToResource.startsWith('..') &&
          !path.isAbsolute(relToResource) &&
          !isAllowedCloudOnlyResourceRelPath(relToResource.replace(/\\/g, '/')))
      ) {
        return undefined
      }
    }
    if (
      customBgmPath &&
      normalizePathForCompare(resolvedCandidate) === normalizePathForCompare(customBgmPath)
    ) {
      return fs.existsSync(resolvedCandidate) ? resolvedCandidate : undefined
    }
    try {
      const safe = assertContainedPath(candidate, allowedResourceRoots, 'audio resource path')
      return fs.existsSync(safe) ? safe : undefined
    } catch {
      return undefined
    }
  }
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
  const resourceRoot = config.paths?.resources ? resolveWithExistingRealpath(config.paths.resources) : ''
  const allowedResourceRoots = Array.from(
    new Set([...(resourceRoot ? [resourceRoot] : []), ...allowedTempRoots])
  )

  const resolveOptionalAudioPath = createOptionalAudioPathResolver(config, allowedTempRoots)

  const ensureRustBridgeEndpoint = (): RustBridgeServerInfo | null => {
    if (!isRustExporterAvailable(config.video.useRustExporter !== false)) {
      return null
    }
    try {
      const existing = getRustBridgeServerInfo()
      if (existing?.running) return existing
      return startRustBridgeServer({
        allowedOutputDirs: allowedTempRoots,
        bridgeToken: deps.bridgeToken
      })
    } catch (err) {
      logger.warn('[Bridge] In-process Rust WS bridge unavailable, using Node /bridge/ws-bin:', err)
      return null
    }
  }

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
    if (isUnderTombstonedPath(resolvedPath)) {
      throw new BridgeSecurityError(
        'Temp file directory was cleaned up after task cancellation',
        499
      )
    }
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
      if (currentEntry.closed || isUnderTombstonedPath(resolvedPath)) {
        throw new BridgeSecurityError(
          currentEntry.closed
            ? 'Cached file handle was closed'
            : 'Temp file directory was cleaned up after task cancellation',
          499
        )
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

  const workerToTask = new Map<string, string>()
  const taskToWorker = new Map<string, string>()
  const taskTempPaths = new Map<string, Set<string>>()
  const workerTempPaths = new Map<string, Set<string>>()
  const tombstonedTempPaths = new Map<string, number>()
  const cancelledTaskTimes = new Map<string, number>()
  const inFlightPathCleanups = new Map<string, Promise<void>>()

  function pruneTimestampMap(map: Map<string, number>, now = Date.now()): void {
    for (const [k, ts] of map.entries()) {
      if (now - ts > TEMP_TOMBSTONE_TTL_MS) map.delete(k)
    }
    while (map.size > TEMP_TOMBSTONE_MAX_ENTRIES) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }

  function markTaskCancelled(taskId: string): void {
    const now = Date.now()
    cancelledTaskTimes.delete(taskId)
    cancelledTaskTimes.set(taskId, now)
    pruneTimestampMap(cancelledTaskTimes, now)
  }

  function isTaskCancelled(taskId: string): boolean {
    const ts = cancelledTaskTimes.get(taskId)
    if (ts === undefined) return false
    if (Date.now() - ts > TEMP_TOMBSTONE_TTL_MS) {
      cancelledTaskTimes.delete(taskId)
      return false
    }
    return true
  }

  function canonicalComparePath(targetPath: string): string {
    return normalizePathForCompare(resolveWithExistingRealpath(targetPath))
  }

  function markTombstonedPath(targetPath: string): void {
    const now = Date.now()
    const key = canonicalComparePath(targetPath)
    tombstonedTempPaths.delete(key)
    tombstonedTempPaths.set(key, now)
    pruneTimestampMap(tombstonedTempPaths, now)
  }

  function isUnderTombstonedPath(targetPath: string): boolean {
    if (tombstonedTempPaths.size === 0) return false
    pruneTimestampMap(tombstonedTempPaths)
    const candidate = canonicalComparePath(targetPath)
    for (const key of tombstonedTempPaths.keys()) {
      if (candidate === key || isStrictlyWithinRoot(candidate, key)) {
        return true
      }
    }
    return false
  }

  function extractTaskId(req: Request, payload?: unknown, workerId?: string | null): string | null {
    const fromPayload = (payload as { taskId?: unknown } | undefined)?.taskId
    if (typeof fromPayload === 'string' && fromPayload.trim()) {
      return fromPayload.trim()
    }
    const fromHeader = req.headers['x-mss-task-id']
    if (typeof fromHeader === 'string' && fromHeader.trim()) {
      return fromHeader.trim()
    }
    return workerId ? (workerToTask.get(workerId) ?? null) : null
  }

  function registerTempPath(
    targetPath: string,
    workerId: string | null,
    taskId: string | null
  ): void {
    const resolved = path.resolve(targetPath)
    if (taskId) {
      let set = taskTempPaths.get(taskId)
      if (!set) {
        set = new Set<string>()
        taskTempPaths.set(taskId, set)
      }
      set.add(resolved)
    }
    if (workerId) {
      let set = workerTempPaths.get(workerId)
      if (!set) {
        set = new Set<string>()
        workerTempPaths.set(workerId, set)
      }
      set.add(resolved)
    }
  }

  function unregisterTempPath(targetPath: string): void {
    const normTarget = normalizePathForCompare(path.resolve(targetPath))
    for (const [taskId, set] of taskTempPaths.entries()) {
      for (const entry of set) {
        const normEntry = normalizePathForCompare(entry)
        if (normEntry === normTarget || isStrictlyWithinRoot(normEntry, normTarget)) {
          set.delete(entry)
        }
      }
      if (set.size === 0) taskTempPaths.delete(taskId)
    }
    for (const [workerId, set] of workerTempPaths.entries()) {
      for (const entry of set) {
        const normEntry = normalizePathForCompare(entry)
        if (normEntry === normTarget || isStrictlyWithinRoot(normEntry, normTarget)) {
          set.delete(entry)
        }
      }
      if (set.size === 0) workerTempPaths.delete(workerId)
    }
  }

  async function cleanupTempPath(targetPath: string, tombstone: boolean): Promise<void> {
    const resolved = path.resolve(targetPath)
    if (tombstone) {
      markTombstonedPath(resolved)
    }
    const key = normalizePathForCompare(resolved)
    const existing = inFlightPathCleanups.get(key)
    if (existing) {
      await existing
      return
    }
    const task = (async () => {
      await closeCachedFileHandlesUnder(resolved)
      await fs.promises
        .rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
        .catch(() => {})
    })().finally(() => {
      inFlightPathCleanups.delete(key)
    })
    inFlightPathCleanups.set(key, task)
    await task
  }

  interface PipeStreamEntry {
    id: string
    session: FramesPipeSession | RustFramesPipeSession
    dir: string
    videoPath: string
    fps: number
    rawFrameBytes: number
    lastRawFrame: Buffer | null
    workerId: string | null
    taskId: string | null
    idleTimer: ReturnType<typeof setTimeout> | null
    lastIdleTouchAt: number
    cleaning?: Promise<void>
  }
  const framesPipeSessions = new Map<string, PipeStreamEntry>()
  const framesPipeIdleMs = deps.framesPipeIdleMs ?? DEFAULT_FRAMES_PIPE_IDLE_MS
  const framesPipeTouchThrottleMs = Math.min(5_000, Math.floor(framesPipeIdleMs / 4))
  const createPipe = deps.createFramesPipe ?? createFramesPipeSession

  /**
   * image2pipe 会话写出的实际帧数与编码帧率，按视频路径交接给随后的 remux：
   * 渲染端不必额外传 frameCount/fps，宿主也能用 `-t frames/fps` 精确截断。
   */
  interface PipeFrameInfo {
    frameCount: number
    fps: number
  }
  const pipeVideoFrameCounts = new Map<string, PipeFrameInfo>()
  const MAX_PIPE_FRAME_COUNT_ENTRIES = 8

  function rememberPipeFrameCount(videoPath: string, frameCount: number, fps: number): void {
    if (frameCount <= 0 || !Number.isFinite(fps) || fps <= 0) return
    const key = canonicalComparePath(videoPath)
    pipeVideoFrameCounts.delete(key)
    pipeVideoFrameCounts.set(key, { frameCount, fps })
    while (pipeVideoFrameCounts.size > MAX_PIPE_FRAME_COUNT_ENTRIES) {
      const oldest = pipeVideoFrameCounts.keys().next().value
      if (oldest === undefined) break
      pipeVideoFrameCounts.delete(oldest)
    }
  }

  function pipeFrameInfoFor(videoPath: string): PipeFrameInfo | undefined {
    return pipeVideoFrameCounts.get(canonicalComparePath(videoPath))
  }

  /**
   * 原子写盘（对齐 sse-export export_video）：ffmpeg 只写 `<name>.partial.mp4`，
   * 成功后 rename 到目标名；失败/取消删除 partial，目录里不会出现半截成片。
   */
  async function writeOutputAtomically<T>(
    outputPath: string,
    write: (partialPath: string) => Promise<T>,
    isCancelled?: () => boolean
  ): Promise<T> {
    const partialPath = partialOutputPath(outputPath)
    await fs.promises.rm(partialPath, { force: true }).catch(() => {})
    try {
      const result = await write(partialPath)
      if (isCancelled?.()) {
        throw new Error('Export task was cancelled')
      }
      if (!fs.existsSync(partialPath)) {
        throw new Error(`Encoder reported success but wrote no output: ${partialPath}`)
      }
      await fs.promises.rename(partialPath, outputPath)
      return result
    } catch (error) {
      await fs.promises.rm(partialPath, { force: true }).catch(() => {})
      throw error
    }
  }

  async function cleanupPipeSession(id: string, reason?: Error): Promise<void> {
    const entry = framesPipeSessions.get(id)
    if (!entry) return
    if (entry.cleaning) {
      await entry.cleaning
      return
    }
    framesPipeSessions.delete(id)
    entry.lastRawFrame = null
    pipeVideoFrameCounts.delete(canonicalComparePath(entry.videoPath))
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
    markTombstonedPath(entry.dir)
    unregisterTempPath(entry.dir)
    entry.cleaning = (async () => {
      await entry.session.abort(reason).catch(() => {})
      await cleanupTempPath(entry.dir, true)
    })()
    await entry.cleaning
  }

  function touchPipeIdle(entry: PipeStreamEntry): void {
    const now = Date.now()
    if (entry.idleTimer && now - entry.lastIdleTouchAt < framesPipeTouchThrottleMs) {
      return
    }
    entry.lastIdleTouchAt = now
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
    }
    entry.idleTimer = setTimeout(() => {
      void cleanupPipeSession(entry.id, new Error('Frames stream idle timeout'))
    }, framesPipeIdleMs)
    entry.idleTimer.unref?.()
  }

  function snapshotAndDeleteTempPaths(paths: Iterable<string>, tombstone: boolean): string[] {
    const unique = new Set<string>()
    for (const p of paths) {
      const resolved = path.resolve(p)
      if (tombstone) markTombstonedPath(resolved)
      unique.add(resolved)
    }
    return Array.from(unique)
  }

  const controller: BridgeController = {
    bindWorkerTask(workerId: string, taskId: string): void {
      if (!workerId || !taskId) return
      const previousTaskId = workerToTask.get(workerId)
      if (
        previousTaskId &&
        previousTaskId !== taskId &&
        taskToWorker.get(previousTaskId) === workerId
      ) {
        taskToWorker.delete(previousTaskId)
      }
      cancelledTaskTimes.delete(taskId)
      workerToTask.set(workerId, taskId)
      taskToWorker.set(taskId, workerId)
    },
    unbindWorkerTask(workerId: string, taskId?: string): void {
      if (!workerId) return
      const current = workerToTask.get(workerId)
      if (!current) return
      if (!taskId || current === taskId) {
        workerToTask.delete(workerId)
        if (taskToWorker.get(current) === workerId) {
          taskToWorker.delete(current)
        }
      }
    },
    async cleanupTask(taskId: string): Promise<void> {
      if (!taskId) return
      markTaskCancelled(taskId)
      const boundWorker = taskToWorker.get(taskId)
      const collected: string[] = []
      const taskSet = taskTempPaths.get(taskId)
      if (taskSet) {
        collected.push(...taskSet)
        taskTempPaths.delete(taskId)
      }
      if (boundWorker && workerToTask.get(boundWorker) === taskId) {
        const workerSet = workerTempPaths.get(boundWorker)
        if (workerSet) {
          collected.push(...workerSet)
          workerTempPaths.delete(boundWorker)
        }
      }
      const uniqueDirs = snapshotAndDeleteTempPaths(collected, true)
      const pipeTargets = Array.from(framesPipeSessions.values())
        .filter(
          (entry) => entry.taskId === taskId || (boundWorker && entry.workerId === boundWorker)
        )
        .map((entry) => entry.id)

      await Promise.allSettled([
        ...pipeTargets.map((id) =>
          cleanupPipeSession(id, new Error(`Export task ${taskId} cancelled`))
        ),
        ...uniqueDirs.map((dir) => cleanupTempPath(dir, true))
      ])
    },
    async cleanupWorker(workerId: string): Promise<void> {
      const boundTaskId = workerToTask.get(workerId)
      if (boundTaskId) {
        workerToTask.delete(workerId)
        if (taskToWorker.get(boundTaskId) === workerId) {
          taskToWorker.delete(boundTaskId)
        }
      }
      const collected: string[] = []
      const workerSet = workerTempPaths.get(workerId)
      if (workerSet) {
        collected.push(...workerSet)
        workerTempPaths.delete(workerId)
      }
      const wasCancelled = Boolean(boundTaskId && isTaskCancelled(boundTaskId))
      if (boundTaskId) {
        const taskSet = taskTempPaths.get(boundTaskId)
        if (taskSet) {
          collected.push(...taskSet)
          taskTempPaths.delete(boundTaskId)
        }
      }
      const uniqueDirs = snapshotAndDeleteTempPaths(collected, wasCancelled)
      const targets = Array.from(framesPipeSessions.values())
        .filter((entry) => entry.workerId === workerId)
        .map((entry) => entry.id)
      if (targets.length > 0) {
        logger.warn(
          `[Bridge] Cleaning up ${targets.length} orphaned framesPipeSessions for worker ${workerId}`
        )
      }
      await Promise.allSettled([
        ...targets.map((id) =>
          cleanupPipeSession(id, new Error(`Render worker ${workerId} recycled or disconnected`))
        ),
        ...uniqueDirs.map((dir) => cleanupTempPath(dir, wasCancelled))
      ])
    },
    async disposeAll(): Promise<void> {
      activeBridgeControllers.delete(controller)
      workerToTask.clear()
      taskToWorker.clear()
      const collected: string[] = []
      for (const set of taskTempPaths.values()) collected.push(...set)
      for (const set of workerTempPaths.values()) collected.push(...set)
      taskTempPaths.clear()
      workerTempPaths.clear()
      const uniqueDirs = snapshotAndDeleteTempPaths(collected, true)
      const pipeIds = Array.from(framesPipeSessions.keys())
      const fileKeys = Array.from(cachedFileHandles.keys())
      await Promise.allSettled([
        ...pipeIds.map((id) => cleanupPipeSession(id, new Error('Bridge router shutting down'))),
        ...fileKeys.map((key) => closeCachedFileHandle(key)),
        ...uniqueDirs.map((dir) => cleanupTempPath(dir, true))
      ])
      if (activeBridgeControllers.size === 0) {
        stopRustBridgeServer()
      }
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

  // ----- 共享临时文件读取（多段并行导出读取预合成 TTS WAV） -----

  router.get('/temp-file', async (req: Request, res: Response) => {
    try {
      const safePath = assertContainedPath(req.query.path, allowedTempRoots, 'temp file path')
      if (isUnderTombstonedPath(safePath)) {
        res.status(499).json({ ok: false, error: 'Temp file directory was cleaned up' })
        return
      }
      const data = await fs.promises.readFile(safePath)
      res.setHeader('Content-Type', 'application/octet-stream')
      res.send(data)
    } catch (error) {
      const status = error instanceof BridgeSecurityError ? error.statusCode : 404
      res.status(status).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to read temp file'
      })
    }
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
          channel === 'electron:frames-stream-repeat' ||
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
        result = await handleInvoke(channel, args, req)
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
      codec?: string
      /** 帧输入格式：mjpeg（默认）| rawvideo（GPU 已转 BT.709 yuv420p） */
      frameFormat?: FramePipeFormat | string
      /** 导出帧区间 [fromFrame, toFrame)；入口校验 from < to */
      fromFrame?: number
      toFrame?: number
      workerId?: string
      taskId?: string
    }
    const workerId = extractWorkerId(req, payload)
    const taskId = extractTaskId(req, payload, workerId)
    if (taskId && isTaskCancelled(taskId)) {
      throw new BridgeSecurityError('Export task was cancelled', 499)
    }
    const fps = Number(payload.fps) > 0 ? Number(payload.fps) : config.video.fps
    const width = Number(payload.width) > 0 ? Number(payload.width) : config.video.width
    const height = Number(payload.height) > 0 ? Number(payload.height) : config.video.height
    const codec: VideoCodec = normalizeVideoCodec(payload.codec ?? config.video.codec)
    const frameFormat: FramePipeFormat = payload.frameFormat === 'rawvideo' ? 'rawvideo' : 'mjpeg'
    try {
      checkEncodeSize(width, height)
      if (payload.fromFrame !== undefined || payload.toFrame !== undefined) {
        checkFrameRange(payload.fromFrame ?? 0, payload.toFrame ?? Number.MAX_SAFE_INTEGER)
      }
    } catch (error) {
      throw new BridgeSecurityError(error instanceof Error ? error.message : String(error), 400)
    }
    const dir = path.join(tmpdir(), `mss-fpipe-${Date.now()}-${randomSuffix()}`)
    await fs.promises.mkdir(dir, { recursive: true })
    const videoPath = path.join(dir, 'video.mp4')
    const id = randomSuffix()

    let session: FramesPipeSession | RustFramesPipeSession
    try {
      const pipeOpts = {
        fps,
        width,
        height,
        inputWidth: payload.inputWidth,
        inputHeight: payload.inputHeight,
        crf: payload.crf ?? config.video.crf,
        encoder: config.video.encoder as VideoEncoderChoice,
        codec,
        frameFormat,
        fromFrame: payload.fromFrame,
        toFrame: payload.toFrame,
        outputPath: videoPath
      }
      if (!deps.createFramesPipe && isRustExporterAvailable(config.video.useRustExporter !== false)) {
        session = RustFramesPipeSession.create(pipeOpts)
        logger.info(`[Bridge] Started native Rust pipe-encode session (id=${id}, format=${frameFormat})`)
      } else {
        session = await createPipe(pipeOpts)
      }
    } catch (error) {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
      throw error
    }

    if (signal.aborted || (taskId && isTaskCancelled(taskId))) {
      await session.abort(new Error('Frames stream start aborted')).catch(() => {})
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
      throw new BridgeSecurityError('Frames stream start aborted', 499)
    }

    registerTempPath(dir, workerId, taskId)
    const rawFrameBytes = frameFormat === 'rawvideo' ? (width * height * 3) / 2 : 0
    const entry: PipeStreamEntry = {
      id,
      session,
      dir,
      videoPath,
      fps,
      rawFrameBytes,
      lastRawFrame: null,
      workerId,
      taskId,
      idleTimer: null,
      lastIdleTouchAt: 0
    }
    framesPipeSessions.set(id, entry)
    touchPipeIdle(entry)
    return { id, videoPath }
  }

  async function handleInvoke(channel: string, args: unknown[], req: Request): Promise<unknown> {
    switch (channel) {
      case 'electron:get-temp-dir': {
        const workerId = extractWorkerId(req, args[0])
        const taskId = extractTaskId(req, args[0], workerId)
        if (taskId && isTaskCancelled(taskId)) {
          throw new BridgeSecurityError('Export task was cancelled', 499)
        }
        const rootDir = path.join(tmpdir(), `mss-hf-${Date.now()}-${randomSuffix()}`)
        const framesDir = path.join(rootDir, 'frames')
        await fs.promises.mkdir(framesDir, { recursive: true })
        if (taskId && isTaskCancelled(taskId)) {
          await cleanupTempPath(rootDir, true)
          throw new BridgeSecurityError('Export task was cancelled', 499)
        }
        registerTempPath(rootDir, workerId, taskId)
        return framesDir
      }

      case 'electron:get-temp-base-dir': {
        const workerId = extractWorkerId(req, args[0])
        const taskId = extractTaskId(req, args[0], workerId)
        if (taskId && isTaskCancelled(taskId)) {
          throw new BridgeSecurityError('Export task was cancelled', 499)
        }
        const baseDir = path.join(tmpdir(), `mss-export-${Date.now()}-${randomSuffix()}`)
        await fs.promises.mkdir(baseDir, { recursive: true })
        if (taskId && isTaskCancelled(taskId)) {
          await cleanupTempPath(baseDir, true)
          throw new BridgeSecurityError('Export task was cancelled', 499)
        }
        registerTempPath(baseDir, workerId, taskId)
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
        unregisterTempPath(resolved)
        await closeCachedFileHandlesUnder(resolved)
        await fs.promises.rm(resolved, { recursive: true, force: true })
        return null
      }

      case 'electron:frames-stream-repeat': {
        const payload = args[0] as { id?: string; count?: unknown } | undefined
        const id = payload?.id
        const entry = id ? framesPipeSessions.get(id) : undefined
        if (!entry || !id) throw new Error('Unknown frames stream session')
        const rawCount = payload?.count === undefined ? 1 : payload.count
        if (
          typeof rawCount !== 'number' ||
          !Number.isInteger(rawCount) ||
          rawCount < 0 ||
          rawCount > 3600
        ) {
          throw new BridgeSecurityError('Invalid count in frames-stream-repeat', 400)
        }
        if (rawCount === 0) return { repeated: 0 }
        touchPipeIdle(entry)
        try {
          if (entry.lastRawFrame && entry.lastRawFrame.length > 0) {
            if (entry.session instanceof RustFramesPipeSession) {
              await entry.session.write(entry.lastRawFrame, 1, { repeatCount: rawCount })
            } else {
              for (let i = 0; i < rawCount; i++) {
                await entry.session.write(entry.lastRawFrame, 1)
              }
            }
          } else {
            const repeatable = entry.session as FramesPipeSession & {
              repeatLastFrame?: (count?: number) => Promise<void>
            }
            if (typeof repeatable.repeatLastFrame === 'function') {
              await repeatable.repeatLastFrame(rawCount)
            } else {
              throw new BridgeSecurityError(
                'Cannot repeat frame before any frame was written',
                400
              )
            }
          }
          if (framesPipeSessions.has(id)) touchPipeIdle(entry)
          return { repeated: rawCount }
        } catch (error) {
          if (error instanceof BridgeSecurityError) throw error
          await cleanupPipeSession(id, error instanceof Error ? error : new Error(String(error)))
          throw error
        }
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
          const frameCount = entry.session.frameCount
          if (typeof frameCount === 'number') {
            rememberPipeFrameCount(videoPath, frameCount, entry.fps)
          }
          entry.lastRawFrame = null
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
          /** 视频帧数；用于 `-t frames/fps` 精确截断 */
          frameCount?: number
          /** 视频起点在故事时间轴上的帧号（断点续传）；音频按该位置起播 */
          startFrame?: number
          /** 输出 codec：hevc（默认）| h264 */
          codec?: string
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
        const workerId = extractWorkerId(req, payload)
        const taskId = extractTaskId(req, payload, workerId)
        if (
          (taskId && isTaskCancelled(taskId)) ||
          isUnderTombstonedPath(safeVideoPath) ||
          (safeAudioPath ? isUnderTombstonedPath(safeAudioPath) : false)
        ) {
          return { success: false, error: 'Export task was cancelled' }
        }
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
          const codec = normalizeVideoCodec(payload.codec ?? config.video.codec)
          // 输入尺寸缺省时保守回退配置分辨率：与输出相同时仍挂 scale（BT.709 转换），
          // 旧渲染端（renderScale≠1 时画布大于输出）保持原有缩放行为
          const inputWidth = payload.inputWidth ?? config.video.width
          const inputHeight = payload.inputHeight ?? config.video.height
          const recordedBitrate = payload.recordedBitrate ?? 8_000_000
          const pipeFrameInfo = pipeFrameInfoFor(safeVideoPath)
          const frameCount = payload.frameCount ?? pipeFrameInfo?.frameCount
          const fps = payload.fps ?? pipeFrameInfo?.fps ?? config.video.fps

          await writeOutputAtomically(
            safeOutputPath,
            async (partialPath) => {
              if (safeAudioPath && fs.existsSync(safeAudioPath)) {
                await apiMergeVideoAudioWithCompression(
                  safeVideoPath,
                  safeAudioPath,
                  partialPath,
                  payload.crf,
                  payload.audioBitrate,
                  fps,
                  encoder,
                  config.video.width,
                  config.video.height,
                  inputWidth,
                  inputHeight,
                  recordedBitrate,
                  codec,
                  frameCount
                )
              } else {
                await apiConvertVideoWithCompression(
                  safeVideoPath,
                  partialPath,
                  payload.crf,
                  fps,
                  encoder,
                  config.video.width,
                  config.video.height,
                  inputWidth,
                  inputHeight,
                  recordedBitrate,
                  codec
                )
              }
            },
            () => Boolean(taskId && isTaskCancelled(taskId))
          )

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
          /** 视频帧数；缺省时用 image2pipe 会话记录的实际帧数，再退回 WAV 头时长 */
          frameCount?: number
          /** 视频编码帧率，与 frameCount 一起给出 `-t frames/fps` */
          fps?: number
          /** 视频起点在故事时间轴上的帧号（断点续传）；音频按该位置起播 */
          startFrame?: number
          /**
           * true：输入流不是 BT.709 limited range（典型为 WebCodecs 硬编出来的
           * yuvj420p/full-range），必须经标准滤镜重新编码，不能 `-c:v copy`。
           */
          transcode?: boolean
          /** 输入视频的实际尺寸；缺省按配置分辨率，用于缩放滤镜 */
          inputWidth?: number
          inputHeight?: number
          /** 重编码 CRF；仅在 transcode=true 时使用 */
          crf?: number
          /** 输入视频码率（bps），用于 ffmpeg 超时/进度估算 */
          recordedBitrate?: number
          /** 输出 codec：hevc（默认）| h264；缺省跟随 host config */
          codec?: string
          /** 输入流的实际 codec（如 WebCodecs H.264 传入 h264），用于精准附加 BT.709 VUI 标签 */
          inputCodec?: string
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
        const workerId = extractWorkerId(req, payload)
        const taskId = extractTaskId(req, payload, workerId)
        if (
          (taskId && isTaskCancelled(taskId)) ||
          isUnderTombstonedPath(safeVideoPath) ||
          (safeAudioPath ? isUnderTombstonedPath(safeAudioPath) : false)
        ) {
          return { success: false, error: 'Export task was cancelled' }
        }
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
          const pipeFrameInfo = pipeFrameInfoFor(safeVideoPath)
          const frameCount = payload.frameCount ?? pipeFrameInfo?.frameCount
          const fps = payload.fps ?? pipeFrameInfo?.fps ?? config.video.fps
          const maxOutputMbps = config.video.maxOutputMbps ?? 3.5
          let transcode = payload.transcode === true
          // 体积护栏：即使 WebCodecs 报告无需色彩转换，若码率明显超过视觉小说合理上限
          // （例如旧 config.yaml 配了 12 Mbps），也启用快速 CRF 重编码，避免 5 分钟视频膨胀到 200+ MB。
          if (!transcode && maxOutputMbps > 0 && frameCount && frameCount > 0 && fps > 0) {
            const durationSec = frameCount / fps
            if (durationSec >= 2) {
              const inputSize = (await fs.promises.stat(safeVideoPath)).size
              const actualMbps = (inputSize * 8) / (durationSec * 1_000_000)
              if (actualMbps > maxOutputMbps) {
                logger.info(
                  `[Bridge] API remux: input bitrate ${actualMbps.toFixed(2)} Mbps > cap ${maxOutputMbps} Mbps; enabling CRF compression`
                )
                transcode = true
              }
            }
          }

          let handledByRust = false
          const inputCodec = payload.inputCodec ? normalizeVideoCodec(payload.inputCodec) : undefined
          if (isRustExporterAvailable(config.video.useRustExporter !== false)) {
            try {
              const rustRes = await runRustRemux({
                videoPath: safeVideoPath,
                audioPath: hasAudio ? safeAudioPath : undefined,
                outputPath: safeOutputPath,
                audioBitrate: payload.audioBitrate,
                frameCount,
                fps,
                startFrame: payload.startFrame,
                transcode,
                codec: normalizeVideoCodec(payload.codec ?? config.video.codec),
                inputCodec,
                encoder: config.video.encoder as VideoEncoderChoice,
                crf: payload.crf ?? config.video.crf,
                width: config.video.width,
                height: config.video.height,
                inputWidth: payload.inputWidth ?? config.video.width,
                inputHeight: payload.inputHeight ?? config.video.height,
                gop: Math.max(1, Math.round(fps * 4)),
                maxOutputMbps
              })
              if (taskId && isTaskCancelled(taskId)) {
                await fs.promises.rm(safeOutputPath, { force: true }).catch(() => {})
                throw new Error('Export task was cancelled')
              }
              handledByRust = true
              logger.info(
                `[Bridge] API remux via mss-export-rs (${rustRes.encoder}, transcoded=${rustRes.transcoded}): ` +
                  `${(rustRes.fileSize / 1024 / 1024).toFixed(2)} MB in ${rustRes.elapsedMs}ms`
              )
            } catch (rustErr) {
              if (taskId && isTaskCancelled(taskId)) throw rustErr
              logger.warn(
                '[Bridge] mss-export-rs remux failed, falling back to Node FFmpeg pipeline:',
                rustErr
              )
            }
          }

          if (!handledByRust) {
            await writeOutputAtomically(
              safeOutputPath,
              async (partialPath) => {
                if (transcode) {
                  // WebCodecs 输出通常是 full-range + sRGB TRC，`-c:v copy` 会把
                  // 错误元数据和全范围像素一起带进成片。这里按参考实现的统一
                  // BT.709/tv 滤镜链重编码，音频与视频一次合成。
                  const encoder = config.video.encoder as VideoEncoderChoice
                  const codec = normalizeVideoCodec(payload.codec ?? config.video.codec)
                  const inputWidth = payload.inputWidth ?? config.video.width
                  const inputHeight = payload.inputHeight ?? config.video.height
                  const recordedBitrate = payload.recordedBitrate ?? 8_000_000
                  const crf = payload.crf ?? config.video.crf
                  if (hasAudio) {
                    await apiMergeVideoAudioWithCompression(
                      safeVideoPath,
                      safeAudioPath!,
                      partialPath,
                      crf,
                      payload.audioBitrate,
                      fps,
                      encoder,
                      config.video.width,
                      config.video.height,
                      inputWidth,
                      inputHeight,
                      recordedBitrate,
                      codec,
                      frameCount
                    )
                  } else {
                    await apiConvertVideoWithCompression(
                      safeVideoPath,
                      partialPath,
                      crf,
                      fps,
                      encoder,
                      config.video.width,
                      config.video.height,
                      inputWidth,
                      inputHeight,
                      recordedBitrate,
                      codec,
                      frameCount
                    )
                  }
                } else if (hasAudio) {
                  await apiMuxVideoAudioCopy(
                    safeVideoPath,
                    safeAudioPath!,
                    partialPath,
                    payload.audioBitrate,
                    {
                      frameCount,
                      fps,
                      startFrame: payload.startFrame,
                      ...(inputCodec ? { tagBt709Codec: inputCodec } : {})
                    }
                  )
                } else {
                  await apiCopyVideo(
                    safeVideoPath,
                    partialPath,
                    frameCount,
                    fps,
                    inputCodec
                  )
                }
              },
              () => Boolean(taskId && isTaskCancelled(taskId))
            )
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
              pipeVideoFrameCounts.delete(canonicalComparePath(safeVideoPath))
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
          /** 输出 codec：hevc（默认）| h264 */
          codec?: string
          /** 帧区间 [from, to)；入口校验 from < to */
          from?: number
          to?: number
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
        const workerId = extractWorkerId(req, payload)
        const taskId = extractTaskId(req, payload, workerId)
        if (
          (taskId && isTaskCancelled(taskId)) ||
          isUnderTombstonedPath(safeFramesDir) ||
          (safeAudioPath ? isUnderTombstonedPath(safeAudioPath) : false)
        ) {
          return { success: false, error: 'Export task was cancelled' }
        }
        logger.info(
          `[Bridge] API frames-encode: framesDir=${safeFramesDir}, audioPath=${safeAudioPath}, outputPath=${safeOutputPath}`
        )

        try {
          checkEncodeSize(config.video.width, config.video.height)
          if (payload.from !== undefined || payload.to !== undefined) {
            checkFrameRange(payload.from ?? 0, payload.to ?? Number.MAX_SAFE_INTEGER)
          }
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) }
        }

        let encoded = false
        let intermediatePath: string | null = null
        try {
          const channelStart = Date.now()
          const outputDir = path.dirname(safeOutputPath)
          if (!fs.existsSync(outputDir)) {
            await fs.promises.mkdir(outputDir, { recursive: true })
          }

          const encoder = config.video.encoder as VideoEncoderChoice
          const codec = normalizeVideoCodec(payload.codec ?? config.video.codec)
          const hasAudio = Boolean(safeAudioPath && fs.existsSync(safeAudioPath))
          if (hasAudio) {
            intermediatePath = path.join(
              outputDir,
              `.mss-frames-video-${Date.now()}-${randomSuffix()}.mp4`
            )
          }

          const encodeArgs = (targetPath: string, faststart: boolean): Promise<number> =>
            encodeFramesToVideo(
              payload.fps,
              safeFramesDir,
              targetPath,
              encoder,
              config.video.width,
              config.video.height,
              config.video.crf,
              payload.inputWidth ?? 0,
              payload.inputHeight ?? 0,
              codec,
              faststart
            )
          const isCancelled = (): boolean => Boolean(taskId && isTaskCancelled(taskId))

          if (hasAudio && safeAudioPath && intermediatePath) {
            const frameCount = await encodeArgs(intermediatePath, false)
            await writeOutputAtomically(
              safeOutputPath,
              async (partialPath) => {
                await apiMuxVideoAudioCopy(
                  intermediatePath!,
                  safeAudioPath,
                  partialPath,
                  payload.audioBitrate,
                  { frameCount, fps: payload.fps }
                )
              },
              isCancelled
            )
          } else {
            await writeOutputAtomically(
              safeOutputPath,
              (partialPath) => encodeArgs(partialPath, true),
              isCancelled
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
        const rawBatch = args[0]
        if (!Array.isArray(rawBatch)) {
          throw new BridgeSecurityError('Invalid frame batch: expected an array', 400)
        }
        const safeBatch = rawBatch.map((item) => {
          const entry = item as { path?: unknown; data?: unknown } | null | undefined
          if (!entry || typeof entry.data !== 'string') {
            throw new BridgeSecurityError('Invalid frame batch item: expected string data', 400)
          }
          return {
            path: assertContainedPath(entry.path, allowedTempRoots, 'frame path'),
            data: entry.data
          }
        })
        if (safeBatch.some((item) => isUnderTombstonedPath(item.path))) {
          throw new BridgeSecurityError(
            'Temp frame directory was cleaned up after task cancellation',
            499
          )
        }
        const results = await Promise.allSettled(
          safeBatch.map(async (item) => {
            const buffer = Buffer.from(item.data, 'base64')
            await fs.promises.writeFile(item.path, buffer)
          })
        )
        const failed = results.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected'
        )
        if (failed) {
          throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason))
        }
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
        const result = await handleBinaryInvoke(channel, args, req.body as Buffer, req)
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
    body: Buffer,
    req: Request
  ): Promise<unknown> {
    switch (channel) {
      case 'electron:frames-stream-chunk': {
        const payload = args[0] as { id?: string; frameCount?: unknown } | undefined
        const id = payload?.id
        const entry = id ? framesPipeSessions.get(id) : undefined
        if (!entry || !id) throw new Error('Unknown frames stream session')
        if (
          payload?.frameCount !== undefined &&
          (typeof payload.frameCount !== 'number' ||
            !Number.isInteger(payload.frameCount) ||
            payload.frameCount <= 0)
        ) {
          throw new BridgeSecurityError('Invalid frameCount in frames-stream-chunk', 400)
        }
        const framesInChunk = payload?.frameCount as number | undefined
        touchPipeIdle(entry)
        try {
          await entry.session.write(body, framesInChunk)
          if (
            entry.rawFrameBytes > 0 &&
            body.length >= entry.rawFrameBytes &&
            body.length % entry.rawFrameBytes === 0
          ) {
            if (!entry.lastRawFrame || entry.lastRawFrame.length !== entry.rawFrameBytes) {
              entry.lastRawFrame = Buffer.allocUnsafe(entry.rawFrameBytes)
            }
            body.copy(entry.lastRawFrame, 0, body.length - entry.rawFrameBytes)
          }
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
        if (isUnderTombstonedPath(safePath)) {
          throw new BridgeSecurityError(
            'Temp file directory was cleaned up after task cancellation',
            499
          )
        }
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
        if (isUnderTombstonedPath(safePath)) {
          throw new BridgeSecurityError(
            'Temp frame directory was cleaned up after task cancellation',
            499
          )
        }
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
        const workerId = extractWorkerId(req, payload)
        const taskId = extractTaskId(req, payload, workerId)
        if (taskId && isTaskCancelled(taskId)) {
          throw new BridgeSecurityError('Export task was cancelled', 499)
        }
        const tempPath = path.join(
          tmpdir(),
          `${payload.prefix}-${Date.now()}-${randomSuffix()}.${payload.extension}`
        )
        await fs.promises.writeFile(tempPath, body)
        if (taskId && isTaskCancelled(taskId)) {
          await cleanupTempPath(tempPath, true)
          throw new BridgeSecurityError('Export task was cancelled', 499)
        }
        registerTempPath(tempPath, workerId, taskId)
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

  // ----- 原生 Rust 二进制 WebSocket 与音频/口型加速路由 -----

  router.get('/binary-stream-endpoint', (_req: Request, res: Response) => {
    const rustInfo = ensureRustBridgeEndpoint()
    if (rustInfo?.running && rustInfo.wsUrl) {
      res.json({
        ok: true,
        backend: 'rust',
        wsUrl: rustInfo.wsUrl,
        token: rustInfo.token
      })
      return
    }
    const tokenSuffix = deps.bridgeToken ? `?token=${encodeURIComponent(deps.bridgeToken)}` : ''
    res.json({
      ok: true,
      backend: 'node',
      wsUrl: `/bridge/ws-bin${tokenSuffix}`,
      token: deps.bridgeToken ?? ''
    })
  })

  router.post(
    '/rust/compute-lipsync',
    express.raw({ type: '*/*', limit: '50mb' }),
    async (req: Request, res: Response) => {
      if (!isRustExporterAvailable(config.video.useRustExporter !== false)) {
        res.status(503).json({ ok: false, error: 'Rust exporter unavailable' })
        return
      }
      try {
        const body = req.body as Buffer
        if (!Buffer.isBuffer(body) || body.length === 0) {
          res.status(400).json({ ok: false, error: 'Empty audio payload' })
          return
        }
        const scaleRaw = Number(req.query.targetValueScale)
        const targetValueScale = Number.isFinite(scaleRaw) && scaleRaw > 0 ? scaleRaw : 1
        const env = await computeLipSync({ audioBytes: body, targetValueScale })
        res.json({
          ok: true,
          values: Array.from(env.values),
          frameMs: env.frameMs,
          durationMs: env.durationMs,
          audioDurationMs: env.audioDurationMs,
          releaseStep: env.releaseStep,
          targetValueScale: env.targetValueScale,
          powK: env.powK
        })
      } catch (err) {
        logger.warn('[Bridge] rust compute-lipsync failed:', err)
        res.status(500).json({
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
  )

  router.post(
    '/rust/mix-audio-plan',
    express.json({ limit: '100mb' }),
    async (req: Request, res: Response) => {
      if (!isRustExporterAvailable(config.video.useRustExporter !== false)) {
        res.status(503).json({ ok: false, error: 'Rust exporter unavailable' })
        return
      }
      try {
        const body = req.body as {
          durationMs: number
          outputPath?: string
          prefix?: string
          extension?: string
          bgm?: {
            enabled?: boolean
            volume?: number
            globalPath?: string
            cues?: Array<RustBgmCue & { relPath?: string }>
            volumeTweens?: Array<{ timeMs: number; volume: number; durationMs: number }>
          }
          se?: {
            cues?: Array<RustSeCue & { relPath?: string }>
          }
          voices?: Array<RustVoiceTrack & { audioBase64?: string }>
          workerId?: string
          taskId?: string
        }
        const workerId = extractWorkerId(req, body)
        const taskId = extractTaskId(req, body, workerId)
        if (taskId && isTaskCancelled(taskId)) {
          res.status(499).json({ ok: false, error: 'Export task was cancelled' })
          return
        }

        let safeOutputPath: string
        if (body.outputPath) {
          safeOutputPath = assertContainedPath(body.outputPath, allowedTempRoots, 'audio outputPath')
        } else {
          safeOutputPath = path.join(
            tmpdir(),
            `mss-audio-${Date.now()}-${randomSuffix()}.wav`
          )
          registerTempPath(safeOutputPath, workerId, taskId)
        }
        if (isUnderTombstonedPath(safeOutputPath)) {
          res.status(499).json({ ok: false, error: 'Temp file directory was cleaned up' })
          return
        }
        await fs.promises.mkdir(path.dirname(safeOutputPath), { recursive: true })

        const resolvedGlobalBgm = body.bgm?.globalPath
          ? resolveOptionalAudioPath(body.bgm.globalPath)
          : undefined
        const resolvedBgmCues: RustBgmCue[] = []
        for (const cue of body.bgm?.cues ?? []) {
          const resolved = cue.stop ? undefined : resolveOptionalAudioPath(cue.relPath ?? cue.path)
          if (!cue.stop && !resolved) continue
          resolvedBgmCues.push({
            timeMs: cue.timeMs,
            fadeMs: cue.fadeMs,
            stop: cue.stop,
            path: resolved,
            volume: cue.volume,
            loopStartMs: cue.loopStartMs,
            loopEndMs: cue.loopEndMs,
            loopStartSample: cue.loopStartSample,
            loopEndSample: cue.loopEndSample,
            sourceSampleRate: cue.sourceSampleRate
          })
        }

        const resolvedSeCues: RustSeCue[] = []
        for (const cue of body.se?.cues ?? []) {
          const resolved = cue.stop
            ? undefined
            : resolveOptionalAudioPath(cue.relPath ?? cue.path ?? `audio/se/${cue.file}`)
          if (!cue.stop && !resolved) continue
          resolvedSeCues.push({
            timeMs: cue.timeMs,
            file: cue.file,
            path: resolved,
            stop: cue.stop,
            volume: cue.volume,
            loop: cue.loop,
            fadeMs: cue.fadeMs
          })
        }

        const voices: RustVoiceTrack[] = (body.voices ?? []).map((v) => ({
          startMs: v.startMs,
          endMs: v.endMs,
          snippetIndex: v.snippetIndex,
          computeLipSync: v.computeLipSync,
          targetValueScale: v.targetValueScale,
          ...(v.path ? { path: assertContainedPath(v.path, allowedResourceRoots, 'voice path') } : {}),
          ...(v.audioBase64 ? { audioBytes: Buffer.from(v.audioBase64, 'base64') } : {})
        }))

        const plan: RustAudioMixPlan = {
          durationMs: Math.max(0, Number(body.durationMs) || 0),
          outputPath: safeOutputPath,
          outputFormat: 'wav',
          ...(body.bgm
            ? {
                bgm: {
                  enabled: Boolean(body.bgm.enabled),
                  volume: Number.isFinite(body.bgm.volume) ? Number(body.bgm.volume) : 0.35,
                  ...(resolvedGlobalBgm ? { globalPath: resolvedGlobalBgm } : {}),
                  cues: resolvedBgmCues,
                  volumeTweens: body.bgm.volumeTweens
                }
              }
            : {}),
          ...(resolvedSeCues.length > 0 ? { se: { cues: resolvedSeCues } } : {}),
          ...(voices.length > 0 ? { voices } : {})
        }

        const result = await mixAudioPlan(plan)
        if (taskId && isTaskCancelled(taskId)) {
          await cleanupTempPath(safeOutputPath, true)
          res.status(499).json({ ok: false, error: 'Export task was cancelled' })
          return
        }
        res.json({
          ok: true,
          outputPath: result.outputPath,
          frames: result.frames,
          fileSize: result.fileSize,
          elapsedMs: result.elapsedMs
        })
      } catch (err) {
        logger.warn('[Bridge] rust mix-audio-plan failed:', err)
        const status = err instanceof BridgeSecurityError ? err.statusCode : 500
        res.status(status).json({
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
  )

  return router
}
