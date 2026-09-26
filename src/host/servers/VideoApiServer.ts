import express, { Request, Response, NextFunction } from 'express'
import { ILogObj, Logger } from 'tslog'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { StorySchema, StoryData } from '../../common/types/Story'
import type { VideoSettings } from '../config'

export interface ApiExportRequest {
  story: StoryData
  timeout?: number
}

export interface ApiExportResponse {
  success: boolean
  message: string
  videoPath?: string
  fileSize?: number
  duration?: number
  frameCount?: number
  timings?: Record<string, number>
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
  exportMode: 'record' | 'fast'
  exportBitrate: number
  exportFastEncoder: 'auto' | 'webcodecs' | 'frames'
  fastFps: number
  /** record 模式 MediaRecorder 码率（bps），默认 8Mbps */
  recordBitrate: number
  /** record 模式是否在支持时直录 h264/mp4 并流拷贝合流（默认 off） */
  recordStreamCopy: 'auto' | 'on' | 'off'
  /** 流拷贝路径的目标成片体积（MB）；0 = 按 recordBitrate 固定码率 */
  recordTargetSizeMb: number
  /** record 模式采集帧率上限；0 = 跟随 video.fps */
  recordCaptureFps: number
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
const FILES_PAGE_SIZE_DEFAULT = 20
const FILES_PAGE_SIZE_MAX = 100

const CLEANUP_EXTENSIONS = new Set(['.mp4', '.json'])

/** 导出临时文件（录制 webm / 帧目录 / 混音 WAV）前缀，超过保留期后由宿主清扫 */
const TEMP_SWEEP_PREFIXES = [
  'mss-stream-',
  'mss-export-',
  'mss-api-audio-',
  'mss-audio-',
  'mss-hf-',
  'mss-fast-'
]
const TEMP_FILE_MAX_AGE_MS = 6 * 60 * 60 * 1000

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
  private readonly port: number
  private readonly host: string
  private readonly outputDir: string
  private readonly video: VideoSettings
  private readonly maxConcurrentExports: number
  private readonly fileRetentionMs: number
  private cleanupInterval: ReturnType<typeof setInterval> | null = null
  private lastCleanup: number | null = null
  private totalFilesCleaned: number = 0
  private rateLimitMap: Map<string, RateLimitEntry> = new Map()
  private extraHealthProvider: (() => Record<string, unknown>) | null = null
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
    this.ensureOutputDir()
    this.app = express()
    this.setupMiddleware()
    this.setupRoutes()
    options.registerExtraRoutes?.(this.app)
    this.startCleanupInterval()
  }

  getHttpServer(): ReturnType<typeof import('http').createServer> | null {
    return this.server
  }

  setDispatcher(dispatcher: ExportDispatcher): void {
    this.dispatcher = dispatcher
    this.logger.info('[API] Export dispatcher set')
  }

  setExtraHealthProvider(provider: () => Record<string, unknown>): void {
    this.extraHealthProvider = provider
  }

  /** 是否仍有在途导出（关停排空用） */
  hasActiveExports(): boolean {
    return this.activeExports.size > 0 || this.exportQueue.length > 0
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
    }, ONE_HOUR)
  }

  /**
   * 清扫 tmpdir 下泄漏的导出临时文件（录制 webm、帧目录、混音 WAV）。
   * 正常路径由桥接层 finally 删除；取消/崩溃/重试遗留的靠这里兜底。
   * 在途文件被持续追加，mtime 不会超过保留期，不会被误删。
   */
  private cleanupStaleTempFiles(): void {
    const now = Date.now()
    let entries: string[]
    try {
      entries = fs.readdirSync(tmpdir())
    } catch {
      return
    }

    let cleaned = 0
    let cleanedBytes = 0
    for (const name of entries) {
      if (!TEMP_SWEEP_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
      const fullPath = path.join(tmpdir(), name)
      try {
        const stats = fs.statSync(fullPath)
        if (!stats.isFile() && !stats.isDirectory()) continue
        if (now - stats.mtimeMs < TEMP_FILE_MAX_AGE_MS) continue
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

    if (cleaned > 0) {
      this.logger.info(
        `[API] Temp sweep: removed ${cleaned} stale mss-* entries ` +
          `(${(cleanedBytes / 1024 / 1024).toFixed(2)} MB)`
      )
    }
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

        const taskId = file.replace(/\.[^.]+$/, '')
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

    if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      this.rateLimitMap.set(ip, { count: 1, windowStart: now })
      return true
    }

    if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
      return false
    }

    entry.count++
    return true
  }

  private cleanupRateLimitMap(): void {
    const now = Date.now()
    for (const [ip, entry] of this.rateLimitMap.entries()) {
      if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
        this.rateLimitMap.delete(ip)
      }
    }
  }

  private setupMiddleware(): void {
    this.app.use(express.json({ limit: '50mb' }))

    this.app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.url !== '/api/v1/health' && req.url !== '/api/v1/status') {
        this.logger.info(`[API] ${req.method} ${req.url}`)
      }
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      if (req.method === 'OPTIONS') {
        res.sendStatus(204)
        return
      }
      next()
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
    this.app.get('/api/v1/health', (_req: Request, res: Response) => {
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
          watermark: this.video.watermark
        },
        ...(this.extraHealthProvider ? this.extraHealthProvider() : {})
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
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown'
      if (!this.checkRateLimit(clientIp)) {
        res.status(429).json({
          success: false,
          message: 'Too many requests. Please try again later.',
          retryAfterSeconds: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)
        })
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
          taskId,
          status: isActive ? 'processing' : isQueued ? 'queued' : 'pending',
          elapsedSeconds: elapsed,
          queuePosition: isQueued
            ? this.exportQueue.findIndex((t) => t.taskId === taskId) + 1
            : null
        })
      } else {
        res.json({ taskId, status: 'unknown' })
      }
    })

    this.app.post('/api/v1/export/:taskId/cancel', (req: Request, res: Response) => {
      const taskId = req.params.taskId as string
      const cancelled = this.cancelExport(taskId)
      res.json({ taskId, cancelled })
    })

    this.app.post('/api/v1/cleanup', (_req: Request, res: Response) => {
      const before = this.totalFilesCleaned
      this.cleanupOldExports()
      const cleaned = this.totalFilesCleaned - before
      res.json({
        success: true,
        filesCleaned: cleaned,
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

      if (!filename || filename.includes('..') || filename.includes('/')) {
        res.status(400).json({ error: 'Invalid filename' })
        return
      }

      const filePath = path.join(this.outputDir, filename)
      if (!fs.existsSync(filePath)) {
        this.logger.error(`[API] Download requested but file not found: ${filePath}`)
        res.status(404).json({ error: 'File not found', path: filePath })
        return
      }

      const stats = fs.statSync(filePath)
      this.logger.info(`[API] Downloading file: ${filePath}, size=${stats.size} bytes`)

      res.setHeader('Content-Type', 'video/mp4')
      res.setHeader('Content-Length', stats.size)
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
      res.setHeader('Cache-Control', 'no-cache')

      const stream = fs.createReadStream(filePath)
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

    this.app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      this.logger.error('[API] Unhandled error', err)
      res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    })
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

    const taskId = `export-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
    const outputPath = path.join(this.outputDir, `${taskId}.mp4`)

    this.logger.info(`[API] Export request received: ${taskId}`)
    this.logger.info(`[API] Output path: ${outputPath}`)
    this.logger.info(
      `[API] Story: ${parsedStory.models.length} models, ${parsedStory.snippets.length} snippets`
    )

    const timeoutMs = body.timeout ?? DEFAULT_EXPORT_TIMEOUT_MS

    const videoConfig: VideoConfig = {
      width: this.video.width,
      height: this.video.height,
      renderScale: this.video.renderScale,
      fps: this.video.fps,
      codec: 'h264',
      crf: this.video.crf,
      audioBitrate: this.video.audioBitrate,
      watermark: this.video.watermark,
      exportMode: this.video.exportMode,
      exportBitrate: this.video.exportBitrate,
      exportFastEncoder: this.video.exportFastEncoder,
      fastFps: this.video.fastFps,
      recordBitrate: this.video.recordBitrate,
      recordStreamCopy: this.video.recordStreamCopy,
      recordTargetSizeMb: this.video.recordTargetSizeMb,
      recordCaptureFps: this.video.recordCaptureFps
    }

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
      story: parsedStory,
      outputPath,
      videoConfig,
      addedAt: Date.now(),
      timeoutMs
    }

    this.exportQueue.push(task)
    this.processQueue()

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
      this.logger.info(`[API] videoPath=${result.videoPath}`)

      if (result.success && result.videoPath) {
        const normalizedPath = path.normalize(result.videoPath)
        this.logger.info(`[API] Checking file existence: ${normalizedPath}`)

        if (fs.existsSync(normalizedPath)) {
          const stat = fs.statSync(normalizedPath)
          this.logger.info(`[API] File found: size=${stat.size} bytes`)
          res.json({
            success: true,
            message: 'Video exported successfully',
            videoPath: normalizedPath,
            fileSize: stat.size,
            duration: result.duration,
            frameCount: result.frameCount,
            timings: result.timings,
            downloadUrl: `/api/v1/download/${path.basename(normalizedPath)}`
          })
        } else {
          this.logger.error(`[API] File NOT found at: ${normalizedPath}`)
          this.logger.error(`[API] Original videoPath: ${result.videoPath}`)
          this.logger.error(`[API] outputDir: ${this.outputDir}`)
          try {
            const files = fs.readdirSync(this.outputDir)
            this.logger.info(`[API] Files in outputDir: ${JSON.stringify(files.slice(-10))}`)
          } catch (e) {
            this.logger.error(`[API] Cannot read outputDir: ${e}`)
          }
          res.status(500).json({
            success: false,
            message: `Video file not found at: ${normalizedPath}`
          })
        }
      } else {
        this.logger.error(
          `[API] Export result invalid: success=${result.success}, hasVideoPath=${!!result.videoPath}`
        )
        res.status(500).json(result)
      }
    } catch (error) {
      this.logger.error('[API] Export failed', error)
      this.cancelExport(taskId)
      res.status(500).json({
        success: false,
        message: error instanceof Error ? error.message : 'Export failed'
      })
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

  private cancelExport(taskId: string): boolean {
    const queueIndex = this.exportQueue.findIndex((t) => t.taskId === taskId)
    if (queueIndex > -1) {
      this.exportQueue.splice(queueIndex, 1)
      // 必须拒绝等待中的 Promise：只删除 pendingExports 会让 HTTP 请求
      // 挂到超时竞赛结束（最长 30 分钟）才收到响应
      const pending = this.pendingExports.get(taskId)
      if (pending) {
        pending.reject(new Error('Export cancelled by user'))
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
        pending.reject(new Error('Export cancelled by user'))
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
        timings: result.timings
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

    for (const [, pending] of this.pendingExports.entries()) {
      pending.reject(new Error('Server is shutting down'))
    }
    this.pendingExports.clear()
    this.exportQueue = []
    this.activeExports.clear()

    if (this.server) {
      this.server.close()
      this.server = null
      this.logger.info('[API] Video Export API server stopped')
    }
  }
}
