import * as fs from 'node:fs'
import path from 'node:path'
import type { Request } from 'express'
import type { ILogObj, Logger } from 'tslog'
import type { FramesPipeSession } from '../../shared/ffmpeg'
import type { RustFramesPipeSession } from '../export/rustExporter'
import {
  BridgeSecurityError,
  isStrictlyWithinRoot,
  normalizePathForCompare,
  resolveWithExistingRealpath
} from './bridgeSecurity'

export interface BridgeController {
  bindWorkerTask(workerId: string, taskId: string): void
  unbindWorkerTask(workerId: string, taskId?: string): void
  cleanupTask(taskId: string): Promise<void>
  cleanupWorker(workerId: string): Promise<void>
  disposeAll(): Promise<void>
  activePipeSessionCount(): number
}

export interface PipeStreamEntry {
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

export interface PipeFrameInfo {
  frameCount: number
  fps: number
}

interface CachedFileHandleEntry {
  handle: fs.promises.FileHandle | null
  tail: Promise<void>
  idleTimer: ReturnType<typeof setTimeout> | null
  closed: boolean
}

const DEFAULT_FILE_HANDLE_IDLE_MS = 30_000
const DEFAULT_FRAMES_PIPE_IDLE_MS = 125_000
const TEMP_TOMBSTONE_TTL_MS = 5 * 60 * 1000
const TEMP_TOMBSTONE_MAX_ENTRIES = 500
const MAX_PIPE_FRAME_COUNT_ENTRIES = 8

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

export function extractWorkerId(req: Request, payload?: unknown): string | null {
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

export interface BridgeLifecycle {
  readonly controller: BridgeController
  readonly framesPipeSessions: Map<string, PipeStreamEntry>
  extractTaskId(req: Request, payload?: unknown, workerId?: string | null): string | null
  isTaskCancelled(taskId: string): boolean
  isUnderTombstonedPath(targetPath: string): boolean
  registerTempPath(targetPath: string, workerId: string | null, taskId: string | null): void
  unregisterTempPath(targetPath: string): void
  cleanupTempPath(targetPath: string, tombstone: boolean): Promise<void>
  closeCachedFileHandle(filePath: string): Promise<void>
  closeCachedFileHandlesUnder(targetPath: string): Promise<void>
  writeFileAtCached(resolvedPath: string, position: number, body: Buffer): Promise<void>
  cleanupPipeSession(id: string, reason?: Error): Promise<void>
  touchPipeIdle(entry: PipeStreamEntry): void
  rememberPipeFrameCount(videoPath: string, frameCount: number, fps: number): void
  pipeFrameInfoFor(videoPath: string): PipeFrameInfo | undefined
  deletePipeFrameCount(videoPath: string): void
}

export function createBridgeLifecycle(opts: {
  logger: Logger<ILogObj>
  fileHandleIdleMs?: number
  framesPipeIdleMs?: number
  onAllDisposed?: () => void
  onController?: (controller: BridgeController) => void
}): BridgeLifecycle {
  const { logger } = opts
  const fileHandleIdleMs = opts.fileHandleIdleMs ?? DEFAULT_FILE_HANDLE_IDLE_MS
  const framesPipeIdleMs = opts.framesPipeIdleMs ?? DEFAULT_FRAMES_PIPE_IDLE_MS
  const framesPipeTouchThrottleMs = Math.min(5_000, Math.floor(framesPipeIdleMs / 4))

  const cachedFileHandles = new Map<string, CachedFileHandleEntry>()
  const workerToTask = new Map<string, string>()
  const taskToWorker = new Map<string, string>()
  const taskTempPaths = new Map<string, Set<string>>()
  const workerTempPaths = new Map<string, Set<string>>()
  const tombstonedTempPaths = new Map<string, number>()
  const cancelledTaskTimes = new Map<string, number>()
  const inFlightPathCleanups = new Map<string, Promise<void>>()
  const framesPipeSessions = new Map<string, PipeStreamEntry>()
  const pipeVideoFrameCounts = new Map<string, PipeFrameInfo>()

  function canonicalComparePath(targetPath: string): string {
    return normalizePathForCompare(resolveWithExistingRealpath(targetPath))
  }

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

  function deletePipeFrameCount(videoPath: string): void {
    pipeVideoFrameCounts.delete(canonicalComparePath(videoPath))
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
        opts.onAllDisposed?.()
      }
    },
    activePipeSessionCount(): number {
      return framesPipeSessions.size
    }
  }

  activeBridgeControllers.add(controller)
  ensureBeforeExitCleanup()
  opts.onController?.(controller)

  return {
    controller,
    framesPipeSessions,
    extractTaskId,
    isTaskCancelled,
    isUnderTombstonedPath,
    registerTempPath,
    unregisterTempPath,
    cleanupTempPath,
    closeCachedFileHandle,
    closeCachedFileHandlesUnder,
    writeFileAtCached,
    cleanupPipeSession,
    touchPipeIdle,
    rememberPipeFrameCount,
    pipeFrameInfoFor,
    deletePipeFrameCount
  }
}
