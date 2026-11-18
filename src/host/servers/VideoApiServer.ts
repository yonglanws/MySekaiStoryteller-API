import express, { Request, Response, NextFunction } from 'express'
import crypto from 'node:crypto'
import { ILogObj, Logger } from 'tslog'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { StorySchema, StoryData } from '../../common/types/Story'
import type { ExportDiagnostics } from '../../common/types/ExportDiagnostics'
import type { VideoSettings } from '../config'
import { writeExportDiagnostics } from '../exportDiagnostics'

export interface ApiExportRequest {
  story: StoryData
  timeout?: number
  wait?: boolean
}

export interface ApiExportResponse {
  success: boolean
  message: string
  videoPath?: string
  fileSize?: number
  duration?: number
  frameCount?: number
  timings?: Record<string, number>
  /** 导出诊断 JSON、可读日志与报告路径（与视频同目录） */
  logPath?: string
  logJsonPath?: string
  reportPath?: string
  diagnostics?: ExportDiagnostics
}

export interface VideoConfig {
  width: number
  height: number
  renderScale: number
  fps: number
  codec: string
  crf: number
  audioBitrate: string
  watermark: boolean
  watermarkText?: string
  exportMode: 'record' | 'fast'
  exportBitrate: number
  exportFastEncoder: 'auto' | 'webcodecs' | 'frames'
  fastFps: number
  /** 表演续演间隔（秒）；0 = 关闭续演，动作播完回落默认待机 */
  idleChainGapSec: number
  /** TTS 与渲染调度：serial = 先合成再渲染，concurrent = 边渲染边合成 */
  ttsMode: 'serial' | 'concurrent'
}

export interface ExportTask {
  taskId: string
  story: StoryData
  outputPath: string
  videoConfig: VideoConfig
  addedAt: number
  /** 本任务的超时上限（毫秒），渲染池看门狗以此推导强制回收 deadline */
  timeoutMs: number
}

/**
 * 导出任务分发器：把队列中的任务交给渲染池（无头浏览器页面）。
 */
export interface ExportDispatcher {
  dispatch(task: ExportTask): void
  cancel(taskId: string): void
}

interface PendingExport {
  resolve: (result: ApiExportResponse) => void
  reject: (error: Error) => void
  outputPath: string
  startTime: number
  timeoutMs: number
}

const DEFAULT_EXPORT_TIMEOUT_MS = 1_800_000
// Node timers overflow to 1 ms above the signed 32-bit limit.
const MAX_EXPORT_TIMEOUT_MS = 2_147_483_647
const DEFAULT_MAX_CONCURRENT_EXPORTS = 2
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const DEFAULT_FILE_RETENTION_MS = 24 * 60 * 60 * 1000
const RATE_LIMIT_WINDOW_MS = 60 * 1000
const RATE_LIMIT_MAX_REQUESTS = 10
const RATE_LIMIT_MAX_ENTRIES_DEFAULT = 10_000
const TASK_RECORD_RETENTION_MS = 60 * 60 * 1000
const TASK_RECORD_MAX_ENTRIES = 200
const FILES_PAGE_SIZE_DEFAULT = 20
const FILES_PAGE_SIZE_MAX = 100

const CLEANUP_EXTENSIONS = new Set(['.mp4', '.json', '.log', '.txt'])
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const ORPHAN_FRAMES_VIDEO_RE = /^\.mss-frames-video-.*\.mp4$/

/** 导出临时文件（帧目录 / 帧管道 / 混音 WAV）前缀，超过保留期后由宿主清扫 */
const TEMP_SWEEP_PREFIXES = [
  'mss-fpipe-',
  'mss-hf-',
  'mss-export-',
  'mss-api-audio-',
  'mss-audio-',
  'mss-fast-'
]
const TEMP_FILE_MAX_AGE_MS = 6 * 60 * 60 * 1000

interface TaskStatusRecord {
  status: 'completed' | 'failed' | 'cancelled'
  elapsedSeconds: number
  finishedAt: number
  result?: ApiExportResponse & {
    videoPath?: string
    fileSize?: number
    downloadUrl?: string
  }
  error?: { message: string }
}

function parseCorsOrigins(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function isLoopbackRemoteAddress(addr: string | undefined): boolean {
  if (!addr) return false
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function sha256Equal(provided: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(provided).digest()
  const b = crypto.createHash('sha256').update(expected).digest()
  return crypto.timingSafeEqual(a, b)
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

interface RateLimitEntry {
  count: number
  windowStart: number
}

export class VideoApiServer {
  private readonly logger: Logger<ILogObj>
  private readonly app: express.Application
  private server: ReturnType<typeof import('http').createServer> | null = null
  private dispatcher: ExportDispatcher | null = null
  private pendingExports: Map<string, PendingExport> = new Map()
  private exportQueue: ExportTask[] = []
  private activeExports: Set<string> = new Set()
  private exportTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private taskRecords: Map<string, TaskStatusRecord> = new Map()
  private readonly port: number
  private readonly host: string
  private readonly outputDir: string
  private readonly video: VideoSettings
  private readonly maxConcurrentExports: number
  private readonly fileRetentionMs: number
  private readonly apiKey: string
  private readonly bridgeToken: string
  private readonly corsEnabled: boolean
  private readonly corsOrigins: string[]
  private readonly rateLimitMaxEntries: number
  private readonly tempFileMaxAgeMs: number
  /** 导出前预处理（Irodori 日语 ttsText 预检等）；失败直接拒绝任务。 */
  private readonly storyPreparer: ((story: StoryData) => Promise<void>) | null
  private cleanupInterval: ReturnType<typeof setInterval> | null = null
  private lastCleanup: number | null = null
  private totalFilesCleaned: number = 0
  private rateLimitMap: Map<string, RateLimitEntry> = new Map()
  private extraHealthProvider: ((authed: boolean) => Record<string, unknown>) | null = null
  /** 最近完成的导出（滚动窗口，供 /api/v1/status 观测并行负载） */
  private recentExports: Array<{
    taskId: string
    durationMs: number
    success: boolean
    finishedAt: number
  }> = []
  constructor(
    logger: Logger<ILogObj>,
    options: {
      port: number
      host: string
      outputDir: string
      video: VideoSettings
      /** 同时渲染的导出任务上限，应与 render.workers 对齐 */
      maxConcurrentExports?: number
      /** 在 API 路由之后挂载额外路由（静态资源、桥接层等），共享同一端口 */
      registerExtraRoutes?: (app: express.Application) => void
      /** 导出前预处理；抛错时 HTTP 返回 400，不进入渲染队列 */
      prepareStory?: (story: StoryData) => Promise<void>
      /** 可选 Bearer API key（未传时读取 MSST_API_KEY / MSS_API_KEY 环境变量） */
      apiKey?: string
      /** 内部 RenderPool worker 令牌，用于授权同一宿主的 /api/v1/tts/lease* 请求 */
      bridgeToken?: string
      /** 是否启用 CORS（默认 true） */
      cors?: boolean
      /** 允许的 CORS Origin 列表；留空时仅允许 localhost / 127.0.0.1 / [::1] */
      corsOrigins?: string[]
      /** rateLimitMap 上限（默认 10000） */
      rateLimitMaxEntries?: number
      /** 临时文件清扫保留时长（默认 6 小时） */
      tempFileMaxAgeMs?: number
    }
  ) {
    this.logger = logger
    this.port = options.port
    this.host = options.host
    this.outputDir = options.outputDir
    this.video = options.video
    this.maxConcurrentExports = Math.max(
      1,
      options.maxConcurrentExports ?? DEFAULT_MAX_CONCURRENT_EXPORTS
    )
    this.fileRetentionMs = DEFAULT_FILE_RETENTION_MS
    const envApiKey = process.env.MSST_API_KEY ?? process.env.MSS_API_KEY ?? ''
    this.apiKey = (options.apiKey !== undefined ? options.apiKey : envApiKey).trim()
    this.bridgeToken = (options.bridgeToken ?? '').trim()
    this.corsEnabled = options.cors !== false
    this.corsOrigins =
      options.corsOrigins !== undefined
        ? options.corsOrigins.map((origin) => origin.trim()).filter(Boolean)
        : parseCorsOrigins(process.env.MSST_CORS_ORIGINS ?? process.env.MSS_CORS_ORIGINS)
    this.rateLimitMaxEntries = Math.max(
      1,
      options.rateLimitMaxEntries ?? RATE_LIMIT_MAX_ENTRIES_DEFAULT
    )
    this.tempFileMaxAgeMs = Math.max(0, options.tempFileMaxAgeMs ?? TEMP_FILE_MAX_AGE_MS)
    this.storyPreparer = options.prepareStory ?? null
    this.ensureOutputDir()
    this.app = express()
    this.setupMiddleware()
    this.setupRoutes()
    options.registerExtraRoutes?.(this.app)
    this.setupErrorHandler()
    this.startCleanupInterval()
  }

  getHttpServer(): ReturnType<typeof import('http').createServer> | null {
    return this.server
  }

  setDispatcher(dispatcher: ExportDispatcher): void {
    this.dispatcher = dispatcher
    this.logger.info('[API] Export dispatcher set')
  }

  setExtraHealthProvider(provider: (authed: boolean) => Record<string, unknown>): void {
    this.extraHealthProvider = provider
  }

  /** 是否仍有在途导出（关停排空用） */
  hasActiveExports(): boolean {
    return this.activeExports.size > 0 || this.exportQueue.length > 0
  }

  /** 校验外部 Bearer API Key（配置后生效，使用 SHA-256 + timingSafeEqual）。 */
  isAuthorized(req: Request): boolean {
    if (!this.apiKey) return true
    const raw = String(req.headers.authorization || '')
    const normalized = /^bearer /i.test(raw) ? `Bearer ${raw.slice(7)}` : raw
    return sha256Equal(normalized, `Bearer ${this.apiKey}`)
  }

  private isBridgeRequestAuthorized(req: Request): boolean {
    if (this.isAuthorized(req)) return true
    if (!this.bridgeToken) return false

    const headerToken =
      typeof req.headers['x-mss-bridge-token'] === 'string' ? req.headers['x-mss-bridge-token'] : ''
    if (headerToken && sha256Equal(headerToken, this.bridgeToken)) {
      return true
    }

    if (
      isLoopbackRemoteAddress(req.socket?.remoteAddress) &&
      typeof req.headers.referer === 'string'
    ) {
      try {
        const refUrl = new URL(req.headers.referer)
        const refToken = refUrl.searchParams.get('token') || ''
        if (refToken && sha256Equal(refToken, this.bridgeToken)) {
          return true
        }
      } catch {
        // invalid referer
      }
    }
    return false
  }

  /** 可复用 Bearer 鉴权中间件（用于 /apifile 等受保护静态资源）。 */
  createAuthMiddleware(): (req: Request, res: Response, next: NextFunction) => void {
    return (req: Request, res: Response, next: NextFunction) => {
      if (req.method === 'OPTIONS' || this.isAuthorized(req)) {
        next()
        return
      }
      res.status(401).json({ success: false, message: 'Unauthorized' })
    }
  }

  /** 将本地输出目录或临时目录路径从对外错误消息中脱敏。 */
  redactPaths(message: string): string {
    if (!message) return message
    const candidates = new Set<string>([
      this.outputDir,
      path.resolve(this.outputDir),
      tmpdir(),
      path.resolve(tmpdir())
    ])
    for (const dir of [this.outputDir, tmpdir()]) {
      try {
        candidates.add(fs.realpathSync(dir))
      } catch {
        // ignore missing dir
      }
    }
    let sanitized = message
    for (const root of Array.from(candidates).sort((a, b) => b.length - a.length)) {
      if (!root) continue
      sanitized = sanitized.split(root).join('[path]')
    }
    return sanitized
  }

  private isAllowedCorsOrigin(origin: string): boolean {
    if (!this.corsEnabled) return false
    if (this.corsOrigins.length > 0) {
      return this.corsOrigins.includes(origin)
    }
    try {
      const parsed = new URL(origin)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
      if (parsed.username || parsed.password) return false
      return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
    } catch {
      return false
    }
  }

  private ensureOutputDir(): void {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true })
    }
  }

  private startCleanupInterval(): void {
    const ONE_HOUR = 60 * 60 * 1000
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldExports()
      this.cleanupStaleTempFiles()
      this.cleanupRateLimitMap()
      this.cleanupTaskRecords()
    }, ONE_HOUR)
    this.cleanupInterval.unref?.()
  }

  /** 对外触发临时文件清扫（启动兜底与定时巡检共用）。 */
  runTempSweep(): { filesCleaned: number } {
    return this.cleanupStaleTempFiles()
  }

  /**
   * 清扫 tmpdir 下与输出目录下泄漏的导出临时文件（帧目录、帧管道、中间 MP4、混音 WAV）。
   * 正常路径由桥接层 finally 删除；取消/崩溃/重试遗留的靠这里兜底。
   * 在途文件被持续追加，mtime 不会超过保留期，不会被误删。
   */
  private cleanupStaleTempFiles(): { filesCleaned: number } {
    const now = Date.now()
    let cleaned = 0
    let cleanedBytes = 0

    const sweepDir = (dir: string, matcher: (name: string) => boolean): void => {
      let entries: string[]
      try {
        entries = fs.readdirSync(dir)
      } catch {
        return
      }
      for (const name of entries) {
        if (!matcher(name)) continue
        const fullPath = path.join(dir, name)
        try {
          const stats = fs.statSync(fullPath)
          if (!stats.isFile() && !stats.isDirectory()) continue
          if (now - stats.mtimeMs < this.tempFileMaxAgeMs) continue
          if (stats.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true })
          } else {
            fs.unlinkSync(fullPath)
          }
          cleaned++
          cleanedBytes += stats.size
        } catch {
          /* 并发删除或权限问题：忽略单项失败 */
        }
      }
    }

    sweepDir(
      tmpdir(),
      (name) =>
        TEMP_SWEEP_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
        ORPHAN_FRAMES_VIDEO_RE.test(name)
    )
    sweepDir(this.outputDir, (name) => ORPHAN_FRAMES_VIDEO_RE.test(name))

    if (cleaned > 0) {
      this.logger.info(
        `[API] Temp sweep: removed ${cleaned} stale mss-* entries ` +
          `(${(cleanedBytes / 1024 / 1024).toFixed(2)} MB)`
      )
    }
    return { filesCleaned: cleaned }
  }

  private cleanupOldExports(): void {
    const now = Date.now()
    this.lastCleanup = now

    try {
      const files = fs.readdirSync(this.outputDir)
      let cleaned = 0
      let cleanedBytes = 0
      let skipped = 0

      for (const file of files) {
        const ext = path.extname(file).toLowerCase()
        if (!CLEANUP_EXTENSIONS.has(ext)) continue

        const taskId = file.replace(/\..+$/, '')
        if (this.activeExports.has(taskId)) {
          skipped++
          continue
        }

        const filePath = path.join(this.outputDir, file)
        try {
          const stats = fs.statSync(filePath)
          if (!stats.isFile()) continue

          const age = now - stats.mtimeMs
          if (age > this.fileRetentionMs) {
            fs.unlinkSync(filePath)
            cleaned++
            cleanedBytes += stats.size
          }
        } catch (error) {
          this.logger.warn(`[API] Failed to stat/delete file: ${filePath}`, error)
        }
      }

      if (cleaned > 0) {
        this.totalFilesCleaned += cleaned
        const freedMB = (cleanedBytes / (1024 * 1024)).toFixed(2)
        this.logger.info(
          `[API] Cleanup complete: removed ${cleaned} files (${freedMB} MB), skipped ${skipped} active, total cleaned: ${this.totalFilesCleaned}`
        )
      } else if (skipped > 0) {
        this.logger.debug(`[API] Cleanup: no files to remove, skipped ${skipped} active exports`)
      }
    } catch (error) {
      this.logger.error('[API] Failed to cleanup old exports', error)
    }
  }

  private checkRateLimit(ip: string): boolean {
    const now = Date.now()
    const entry = this.rateLimitMap.get(ip)

    if (entry && now - entry.windowStart <= RATE_LIMIT_WINDOW_MS) {
      if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
        return false
      }
      entry.count++
      return true
    }

    if (entry) {
      this.rateLimitMap.delete(ip)
    }

    if (this.rateLimitMap.size >= this.rateLimitMaxEntries) {
      this.cleanupRateLimitMap(now)
      while (this.rateLimitMap.size >= this.rateLimitMaxEntries) {
        const oldestKey = this.rateLimitMap.keys().next().value
        if (oldestKey === undefined) break
        this.rateLimitMap.delete(oldestKey)
      }
    }

    this.rateLimitMap.set(ip, { count: 1, windowStart: now })
    return true
  }

  /** 对外限流入口：超限时直接写入 HTTP 429 并返回 false。 */
  enforceRateLimit(req: Request, res: Response): boolean {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown'
    if (!this.checkRateLimit(clientIp)) {
      res.status(429).json({
        success: false,
        message: 'Too many requests. Please try again later.',
        retryAfterSeconds: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)
      })
      return false
    }
    return true
  }

  private cleanupRateLimitMap(now = Date.now()): void {
    for (const [ip, entry] of this.rateLimitMap.entries()) {
      if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
        this.rateLimitMap.delete(ip)
      }
    }
  }

  private cleanupTaskRecords(now = Date.now()): void {
    for (const [taskId, record] of this.taskRecords.entries()) {
      if (now - record.finishedAt > TASK_RECORD_RETENTION_MS) {
        this.taskRecords.delete(taskId)
      }
    }
    while (this.taskRecords.size > TASK_RECORD_MAX_ENTRIES) {
      const oldest = this.taskRecords.keys().next().value
      if (oldest === undefined) break
      this.taskRecords.delete(oldest)
    }
  }

  private saveTaskRecord(taskId: string, record: TaskStatusRecord): void {
    this.taskRecords.delete(taskId)
    this.taskRecords.set(taskId, record)
    this.cleanupTaskRecords(record.finishedAt)
  }

  private setupMiddleware(): void {
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.url !== '/api/v1/health' && req.url !== '/api/v1/status') {
        this.logger.info(`[API] ${req.method} ${req.url}`)
      }
      res.setHeader('Vary', 'Origin')
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : ''
      if (origin && this.isAllowedCorsOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        res.setHeader('Access-Control-Max-Age', '86400')
      }
      if (req.method === 'OPTIONS') {
        res.sendStatus(204)
        return
      }
      next()
    })

    this.app.use('/api/v1', (req: Request, res: Response, next: NextFunction) => {
      if (req.method === 'OPTIONS') {
        next()
        return
      }
      const reqPath = req.path.replace(/\/+$/, '') || '/'
      if (reqPath === '/health') {
        next()
        return
      }
      if (reqPath === '/tts/lease' || reqPath === '/tts/lease/release') {
        if (this.isBridgeRequestAuthorized(req)) {
          next()
          return
        }
        res.status(401).json({ success: false, message: 'Unauthorized' })
        return
      }
      if (!this.isAuthorized(req)) {
        res.status(401).json({ success: false, message: 'Unauthorized' })
        return
      }
      next()
    })

    this.app.use(express.json({ limit: '50mb' }))
  }

  private setupErrorHandler(): void {
    this.app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      if (
        err instanceof SyntaxError &&
        'status' in err &&
        (err as { status?: unknown }).status === 400
      ) {
        res.status(400).json({
          success: false,
          message: 'Invalid JSON request body'
        })
        return
      }
      this.logger.error('[API] Unhandled error', err)
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: 'Internal server error'
        })
      }
    })
  }

  private getCleanupStats(): {
    intervalMinutes: number
    retentionHours: number
    lastCleanupTimestamp: number | null
    totalFilesCleaned: number
  } {
    return {
      intervalMinutes: CLEANUP_INTERVAL_MS / 60000,
      retentionHours: this.fileRetentionMs / (60 * 60 * 1000),
      lastCleanupTimestamp: this.lastCleanup,
      totalFilesCleaned: this.totalFilesCleaned
    }
  }

  private setupRoutes(): void {
    this.app.get('/api/v1/health', (req: Request, res: Response) => {
      const authed = this.isAuthorized(req)
      res.json({
        status: 'ok',
        version: '2.0.0',
        activeExports: this.activeExports.size,
        queuedExports: this.exportQueue.length,
        pendingExports: this.pendingExports.size,
        cleanup: this.getCleanupStats(),
        videoConfig: {
          width: this.video.width,
          height: this.video.height,
          renderScale: this.video.renderScale,
          fps: this.video.fps,
          codec: 'h264',
          crf: this.video.crf,
          audioBitrate: this.video.audioBitrate,
          watermark: this.video.watermark,
          watermarkText: this.video.watermarkText,
          exportMode: this.video.exportMode,
          fastFps: this.video.fastFps,
          exportFastEncoder: this.video.exportFastEncoder,
          idleChainGapSec: this.video.idleChainGapSec,
          ttsMode: this.video.ttsMode
        },
        ...(this.extraHealthProvider ? this.extraHealthProvider(authed) : {})
      })
    })

    this.app.get('/api/v1/status', (_req: Request, res: Response) => {
      res.json({
        activeExports: this.activeExports.size,
        queuedExports: this.exportQueue.length,
        pendingExports: this.pendingExports.size,
        maxConcurrent: this.maxConcurrentExports,
        activeTaskIds: Array.from(this.activeExports),
        queuedTaskIds: this.exportQueue.map((t) => t.taskId),
        recentExports: this.recentExports
      })
    })

    this.app.post('/api/v1/export', async (req: Request, res: Response) => {
      if (!this.enforceRateLimit(req, res)) {
        return
      }
      await this.handleExportRequest(req, res)
    })

    this.app.get('/api/v1/export/:taskId/status', (req: Request, res: Response) => {
      const taskId = req.params.taskId as string
      const pending = this.pendingExports.get(taskId)
      if (pending) {
        const elapsed = (Date.now() - pending.startTime) / 1000
        const isActive = this.activeExports.has(taskId)
        const isQueued = this.exportQueue.some((t) => t.taskId === taskId)
        res.json({
          success: true,
          taskId,
          status: isActive ? 'processing' : isQueued ? 'queued' : 'pending',
          elapsedSeconds: elapsed,
          queuePosition: isQueued
            ? this.exportQueue.findIndex((t) => t.taskId === taskId) + 1
            : null
        })
        return
      }
      const recorded = this.taskRecords.get(taskId)
      if (recorded) {
        res.json({
          success: true,
          taskId,
          status: recorded.status,
          elapsedSeconds: recorded.elapsedSeconds,
          ...(recorded.result ? { result: recorded.result } : {}),
          ...(recorded.error ? { error: recorded.error } : {})
        })
        return
      }
      res.json({ taskId, status: 'unknown' })
    })

    this.app.post('/api/v1/export/:taskId/cancel', (req: Request, res: Response) => {
      const taskId = req.params.taskId as string
      const cancelled = this.cancelExport(taskId)
      res.json({ taskId, cancelled })
    })

    this.app.post('/api/v1/cleanup', (_req: Request, res: Response) => {
      const before = this.totalFilesCleaned
      this.cleanupOldExports()
      const tempSweep = this.cleanupStaleTempFiles()
      this.cleanupTaskRecords()
      const cleaned = this.totalFilesCleaned - before
      res.json({
        success: true,
        filesCleaned: cleaned,
        tempEntriesCleaned: tempSweep.filesCleaned,
        totalFilesCleaned: this.totalFilesCleaned,
        retentionHours: this.fileRetentionMs / (60 * 60 * 1000)
      })
    })

    this.app.get('/api/v1/cleanup/stats', (_req: Request, res: Response) => {
      res.json(this.getCleanupStats())
    })

    this.app.get('/api/v1/files', (req: Request, res: Response) => {
      const page = Math.max(1, parseInt(req.query.page as string) || 1)
      const limit = Math.min(
        FILES_PAGE_SIZE_MAX,
        Math.max(1, parseInt(req.query.limit as string) || FILES_PAGE_SIZE_DEFAULT)
      )
      const sort = (req.query.sort as string) === 'asc' ? 'asc' : 'desc'

      try {
        const allFiles = fs
          .readdirSync(this.outputDir)
          .filter((f) => CLEANUP_EXTENSIONS.has(path.extname(f).toLowerCase()))
          .map((f) => {
            const filePath = path.join(this.outputDir, f)
            const stats = fs.statSync(filePath)
            return {
              filename: f,
              size: stats.size,
              createdAt: stats.birthtimeMs,
              modifiedAt: stats.mtimeMs
            }
          })
          .sort((a, b) =>
            sort === 'desc' ? b.modifiedAt - a.modifiedAt : a.modifiedAt - b.modifiedAt
          )

        const total = allFiles.length
        const totalPages = Math.ceil(total / limit)
        const start = (page - 1) * limit
        const pageFiles = allFiles.slice(start, start + limit)

        res.json({
          success: true,
          data: pageFiles.map((f) => ({
            filename: f.filename,
            size: f.size,
            sizeHuman: formatFileSize(f.size),
            createdAt: new Date(f.createdAt).toISOString(),
            modifiedAt: new Date(f.modifiedAt).toISOString(),
            downloadUrl: `/api/v1/download/${f.filename}`
          })),
          pagination: {
            page,
            limit,
            total,
            totalPages
          }
        })
      } catch (error) {
        this.logger.error('[API] Failed to list files', error)
        res.status(500).json({ success: false, message: 'Failed to list files' })
      }
    })

    this.app.get('/api/v1/download/:filename', (req: Request, res: Response) => {
      const filename = req.params.filename as string

      if (
        !filename ||
        filename.includes('..') ||
        filename.includes('/') ||
        filename.includes('\\') ||
        filename.includes('\0') ||
        path.basename(filename) !== filename
      ) {
        res.status(400).json({ error: 'Invalid filename' })
        return
      }

      const resolvedOutputDir = path.resolve(this.outputDir)
      const filePath = path.resolve(resolvedOutputDir, filename)
      if (!filePath.startsWith(resolvedOutputDir + path.sep)) {
        res.status(400).json({ error: 'Invalid filename' })
        return
      }

      let stats: fs.Stats
      let realFilePath: string
      try {
        const realOutputDir = fs.realpathSync(resolvedOutputDir)
        realFilePath = fs.realpathSync(filePath)
        if (!realFilePath.startsWith(realOutputDir + path.sep)) {
          res.status(404).json({ error: 'File not found' })
          return
        }
        stats = fs.statSync(realFilePath)
      } catch {
        this.logger.error(`[API] Download requested but file not found: ${filePath}`)
        res.status(404).json({ error: 'File not found' })
        return
      }
      if (!stats.isFile()) {
        res.status(404).json({ error: 'File not found' })
        return
      }

      const ext = path.extname(filename).toLowerCase()
      const contentType =
        ext === '.mp4'
          ? 'video/mp4'
          : ext === '.json'
            ? 'application/json; charset=utf-8'
            : ext === '.log' || ext === '.txt'
              ? 'text/plain; charset=utf-8'
              : ext === '.webm'
                ? 'video/webm'
                : 'application/octet-stream'

      this.logger.info(`[API] Downloading file: ${realFilePath}, size=${stats.size} bytes`)

      res.setHeader('Content-Type', contentType)
      res.setHeader('Content-Length', stats.size)
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
      res.setHeader('Cache-Control', 'no-cache')

      const stream = fs.createReadStream(realFilePath)
      stream.pipe(res)

      stream.on('error', (err) => {
        this.logger.error('[API] File download stream error', err)
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to read file' })
        } else {
          res.destroy()
        }
      })

      stream.on('end', () => {
        this.logger.info(`[API] Download completed: ${filename}`)
      })

      res.on('close', () => {
        stream.destroy()
      })
    })
  }

  private videoConfigFor(): VideoConfig {
    return {
      width: this.video.width,
      height: this.video.height,
      renderScale: this.video.renderScale,
      fps: this.video.fps,
      codec: 'h264',
      crf: this.video.crf,
      audioBitrate: this.video.audioBitrate,
      watermark: this.video.watermark,
      watermarkText: this.video.watermarkText,
      exportMode: this.video.exportMode,
      exportBitrate: this.video.exportBitrate,
      exportFastEncoder: this.video.exportFastEncoder,
      fastFps: this.video.fastFps,
      idleChainGapSec: this.video.idleChainGapSec,
      ttsMode: this.video.ttsMode
    }
  }

  private async prepareStory(story: StoryData): Promise<void> {
    if (!this.storyPreparer) return
    await this.storyPreparer(story)
  }

  /** 登记并排队一个导出任务；HTTP 与 /api/v1/generate 共用同一条队列。 */
  private registerExport(
    story: StoryData,
    timeoutMs: number
  ): { taskId: string; outputPath: string; exportPromise: Promise<ApiExportResponse> } {
    const taskId = `export-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
    const outputPath = path.join(this.outputDir, `${taskId}.mp4`)

    this.logger.info(`[API] Export request received: ${taskId}`)
    this.logger.info(`[API] Output path: ${outputPath}`)
    this.logger.info(
      `[API] Story: ${story.models.length} models, ${story.snippets.length} snippets`
    )

    const exportPromise = new Promise<ApiExportResponse>((resolve, reject) => {
      this.pendingExports.set(taskId, {
        resolve,
        reject,
        outputPath,
        startTime: Date.now(),
        timeoutMs
      })
      this.logger.info(`[API] Pending export registered: ${taskId}`)
    })

    const task: ExportTask = {
      taskId,
      story,
      outputPath,
      videoConfig: this.videoConfigFor(),
      addedAt: Date.now(),
      timeoutMs
    }

    this.exportQueue.push(task)
    this.processQueue()
    return { taskId, outputPath, exportPromise }
  }

  private finalizeExportResult(
    result: ApiExportResponse
  ): ApiExportResponse & { videoPath: string; fileSize: number; downloadUrl: string } {
    if (!result.success || !result.videoPath) {
      throw new Error(result.message || 'Export failed')
    }
    const normalizedPath = path.normalize(result.videoPath)
    if (!fs.existsSync(normalizedPath)) {
      this.logger.error(`[API] File NOT found at: ${normalizedPath}`)
      this.logger.error(`[API] Original videoPath: ${result.videoPath}`)
      this.logger.error(`[API] outputDir: ${this.outputDir}`)
      throw new Error('Exported video file not found')
    }
    const stat = fs.statSync(normalizedPath)
    let logPath: string | undefined
    let logJsonPath: string | undefined
    let reportPath: string | undefined
    if (result.diagnostics) {
      try {
        const written = writeExportDiagnostics(normalizedPath, result.diagnostics)
        logPath = written.textPath
        logJsonPath = written.jsonPath
        reportPath = written.reportPath
        this.logger.info(
          `[API] Export diagnostics written: ${written.textPath} / ${written.jsonPath} / ${written.reportPath}`
        )
      } catch (error) {
        this.logger.warn('[API] Failed to write export diagnostics', error)
      }
    }
    return {
      ...result,
      success: true,
      message: 'Video exported successfully',
      videoPath: normalizedPath,
      fileSize: stat.size,
      logPath,
      logJsonPath,
      reportPath,
      downloadUrl: `/api/v1/download/${path.basename(normalizedPath)}`
    }
  }

  /**
   * 程序内提交导出（供 /api/v1/generate 在剧本生成后直接渲染）。
   *
   * 与 POST /api/v1/export 使用同一条队列、同一个超时语义；失败以异常返回，
   * 成功时带上 videoPath / fileSize / downloadUrl。
   */
  async exportStory(
    story: StoryData,
    timeoutMs = DEFAULT_EXPORT_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<ApiExportResponse & { videoPath?: string; fileSize?: number; downloadUrl?: string }> {
    if (!this.dispatcher) {
      throw new Error('No render worker available. Please ensure the render pool is running.')
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_EXPORT_TIMEOUT_MS) {
      throw new Error(`Invalid timeout: expected an integer between 1 and ${MAX_EXPORT_TIMEOUT_MS}`)
    }

    const parsedStory = StorySchema.parse(story)
    await this.prepareStory(parsedStory)
    const { taskId, exportPromise } = this.registerExport(parsedStory, timeoutMs)
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    const onAbort = (): void => {
      this.logger.warn(`[API] Client disconnected before export ${taskId}, cancelling`)
      this.cancelExport(taskId)
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const result = await Promise.race([
        exportPromise,
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`Export timed out after ${timeoutMs / 1000} seconds`)),
            timeoutMs
          )
        })
      ])

      return this.finalizeExportResult(result)
    } catch (error) {
      this.cancelExport(taskId)
      throw error
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private async handleExportRequest(req: Request, res: Response): Promise<void> {
    if (!this.dispatcher) {
      res.status(503).json({
        success: false,
        message: 'No render worker available. Please ensure the render pool is running.'
      })
      return
    }

    const body = req.body as ApiExportRequest
    if (!body?.story) {
      res.status(400).json({
        success: false,
        message: 'Request body must contain a "story" field with valid story data.'
      })
      return
    }

    if (body.wait !== undefined && typeof body.wait !== 'boolean') {
      res.status(400).json({
        success: false,
        message: 'Invalid wait flag: expected a boolean.'
      })
      return
    }

    if (
      body.timeout !== undefined &&
      (typeof body.timeout !== 'number' ||
        !Number.isInteger(body.timeout) ||
        body.timeout < 1 ||
        body.timeout > MAX_EXPORT_TIMEOUT_MS)
    ) {
      res.status(400).json({
        success: false,
        message: `Invalid timeout: expected an integer between 1 and ${MAX_EXPORT_TIMEOUT_MS} milliseconds.`
      })
      return
    }

    let parsedStory: StoryData
    try {
      parsedStory = StorySchema.parse(body.story)
    } catch (validationError) {
      res.status(400).json({
        success: false,
        message: 'Invalid story data format.',
        details:
          validationError instanceof Error ? validationError.message : String(validationError)
      })
      return
    }

    try {
      await this.prepareStory(parsedStory)
    } catch (error) {
      const message = this.redactPaths(error instanceof Error ? error.message : String(error))
      this.logger.warn(`[API] Export rejected by story preflight: ${message}`)
      res.status(400).json({
        success: false,
        message
      })
      return
    }

    const timeoutMs = body.timeout ?? DEFAULT_EXPORT_TIMEOUT_MS
    const startedAt = Date.now()
    const waitForCompletion = body.wait !== false
    const { taskId, exportPromise } = this.registerExport(parsedStory, timeoutMs)

    if (!waitForCompletion) {
      const timer = setTimeout(() => {
        this.logger.warn(`[API] Async export ${taskId} timed out after ${timeoutMs / 1000} seconds`)
        this.cancelExport(taskId, `Export timed out after ${timeoutMs / 1000} seconds`, 'failed')
      }, timeoutMs)
      this.exportTimers.set(taskId, timer)

      void exportPromise
        .then((result) => {
          const finalized = this.finalizeExportResult(result)
          this.saveTaskRecord(taskId, {
            status: 'completed',
            elapsedSeconds: (Date.now() - startedAt) / 1000,
            finishedAt: Date.now(),
            result: finalized
          })
        })
        .catch((error) => {
          if (!this.taskRecords.has(taskId)) {
            this.logger.error('[API] Async export failed', error)
            const msg = this.redactPaths(error instanceof Error ? error.message : 'Export failed')
            this.saveTaskRecord(taskId, {
              status: 'failed',
              elapsedSeconds: (Date.now() - startedAt) / 1000,
              finishedAt: Date.now(),
              error: { message: msg }
            })
          }
        })
        .finally(() => {
          const activeTimer = this.exportTimers.get(taskId)
          if (activeTimer) {
            clearTimeout(activeTimer)
            this.exportTimers.delete(taskId)
          }
          this.pendingExports.delete(taskId)
          this.activeExports.delete(taskId)
          this.processQueue()
        })

      res.status(202).json({
        success: true,
        taskId,
        status: 'queued',
        statusUrl: `/api/v1/export/${taskId}/status`
      })
      return
    }

    // 客户端断连（插件 httpx 超时普遍早于宿主 30 分钟上限）：任务跑完也没有
    // 接收方，继续渲染只是白占 worker/GPU，直接取消
    res.on('close', () => {
      if (res.writableEnded) return
      this.logger.warn(`[API] Client disconnected before response for task ${taskId}, cancelling`)
      this.cancelExport(taskId)
    })

    let timeoutId: ReturnType<typeof setTimeout> | null = null
    try {
      const result = await Promise.race([
        exportPromise,
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`Export timed out after ${timeoutMs / 1000} seconds`)),
            timeoutMs
          )
        })
      ])

      this.logger.info(`[API] Export promise resolved: taskId=${taskId}, success=${result.success}`)
      const finalized = this.finalizeExportResult(result)
      this.saveTaskRecord(taskId, {
        status: 'completed',
        elapsedSeconds: (Date.now() - startedAt) / 1000,
        finishedAt: Date.now(),
        result: finalized
      })
      res.json(finalized)
    } catch (error) {
      this.logger.error('[API] Export failed', error)
      this.cancelExport(taskId)
      const msg = this.redactPaths(error instanceof Error ? error.message : 'Export failed')
      if (!this.taskRecords.has(taskId)) {
        this.saveTaskRecord(taskId, {
          status: 'failed',
          elapsedSeconds: (Date.now() - startedAt) / 1000,
          finishedAt: Date.now(),
          error: { message: msg }
        })
      }
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: msg
        })
      }
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId)
      this.pendingExports.delete(taskId)
      this.activeExports.delete(taskId)
      this.processQueue()
    }
  }

  private processQueue(): void {
    while (this.activeExports.size < this.maxConcurrentExports && this.exportQueue.length > 0) {
      const task = this.exportQueue.shift()
      if (!task) break

      this.activeExports.add(task.taskId)

      if (!this.dispatcher) {
        const pending = this.pendingExports.get(task.taskId)
        this.activeExports.delete(task.taskId)
        this.pendingExports.delete(task.taskId)
        pending?.reject(new Error('No render worker available'))
        continue
      }

      this.logger.info(`[API] Starting export task: ${task.taskId}`)
      this.dispatcher.dispatch(task)
    }
  }

  private cancelExport(
    taskId: string,
    reason = 'Export cancelled by user',
    recordStatus: 'cancelled' | 'failed' = 'cancelled'
  ): boolean {
    const queueIndex = this.exportQueue.findIndex((t) => t.taskId === taskId)
    if (queueIndex > -1) {
      this.exportQueue.splice(queueIndex, 1)
      // 必须拒绝等待中的 Promise：只删除 pendingExports 会让 HTTP 请求
      // 挂到超时竞赛结束（最长 30 分钟）才收到响应
      const pending = this.pendingExports.get(taskId)
      if (pending) {
        this.saveTaskRecord(taskId, {
          status: recordStatus,
          elapsedSeconds: (Date.now() - pending.startTime) / 1000,
          finishedAt: Date.now(),
          error: { message: reason }
        })
        pending.reject(new Error(reason))
        this.pendingExports.delete(taskId)
      }
      this.dispatcher?.cancel(taskId)
      this.logger.info(`[API] Cancelled queued export: ${taskId}`)
      return true
    }

    if (this.activeExports.has(taskId)) {
      this.activeExports.delete(taskId)
      this.dispatcher?.cancel(taskId)
      const pending = this.pendingExports.get(taskId)
      if (pending) {
        this.saveTaskRecord(taskId, {
          status: recordStatus,
          elapsedSeconds: (Date.now() - pending.startTime) / 1000,
          finishedAt: Date.now(),
          error: { message: reason }
        })
        pending.reject(new Error(reason))
        this.pendingExports.delete(taskId)
      }
      this.logger.info(`[API] Cancelled active export: ${taskId}`)
      return true
    }

    return false
  }

  private recordRecentExport(taskId: string, success: boolean): void {
    const pending = this.pendingExports.get(taskId)
    if (!pending) return
    this.recentExports.unshift({
      taskId,
      durationMs: Date.now() - pending.startTime,
      success,
      finishedAt: Date.now()
    })
    if (this.recentExports.length > 10) {
      this.recentExports.length = 10
    }
  }

  resolveExport(
    taskId: string,
    result: {
      success: boolean
      videoPath?: string
      duration?: number
      frameCount?: number
      outputSize?: number
      timings?: Record<string, number>
      diagnostics?: ExportDiagnostics
    }
  ): void {
    const pending = this.pendingExports.get(taskId)
    if (pending) {
      this.logger.info(
        `[API] Resolving export task: ${taskId}, success=${result.success}, videoPath=${result.videoPath}`
      )
      this.recordRecentExport(taskId, result.success)
      pending.resolve({
        success: result.success,
        message: result.success ? 'Export completed' : 'Export failed',
        videoPath: result.videoPath,
        fileSize: result.outputSize,
        duration: result.duration,
        frameCount: result.frameCount,
        timings: result.timings,
        diagnostics: result.diagnostics
      })
      this.activeExports.delete(taskId)
      this.processQueue()
    } else {
      this.logger.error(`[API] CRITICAL: No pending export found for task: ${taskId}`)
      this.logger.error(
        `[API] pendingExports keys: ${Array.from(this.pendingExports.keys()).join(', ')}`
      )
      this.logger.error(`[API] activeExports: ${Array.from(this.activeExports).join(', ')}`)
      this.logger.error(`[API] queue length: ${this.exportQueue.length}`)
    }
  }

  rejectExport(taskId: string, error: Error): void {
    const pending = this.pendingExports.get(taskId)
    if (pending) {
      this.logger.error(`[API] Rejecting export task: ${taskId}`, error)
      this.recordRecentExport(taskId, false)
      pending.reject(error)
      this.activeExports.delete(taskId)
      this.processQueue()
    } else {
      this.logger.warn(`[API] No pending export found for task: ${taskId}`)
    }
  }

  start(): Promise<void> {
    this.cleanupStaleTempFiles()
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.port, this.host, () => {
          this.logger.info(
            `[API] Video Export API server started on http://${this.host}:${this.port}`
          )
          this.logger.info(
            `[API] Endpoints: POST /api/v1/export, GET /api/v1/health, GET /api/v1/status`
          )
          resolve()
        })
        this.server.on('error', (err: Error) => {
          this.logger.error('[API] Server error', err)
          reject(err)
        })
      } catch (error) {
        reject(error)
      }
    })
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }

    for (const timer of this.exportTimers.values()) {
      clearTimeout(timer)
    }
    this.exportTimers.clear()

    for (const [, pending] of this.pendingExports.entries()) {
      pending.reject(new Error('Server is shutting down'))
    }
    this.pendingExports.clear()
    this.exportQueue = []
    this.activeExports.clear()
    this.taskRecords.clear()

    if (this.server) {
      this.server.close()
      this.server = null
      this.logger.info('[API] Video Export API server stopped')
    }
  }
}
