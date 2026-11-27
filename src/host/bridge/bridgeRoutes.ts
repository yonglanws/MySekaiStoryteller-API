import express, { Router, Request, Response, NextFunction } from 'express'
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
import {
  ALLOWED_PROXY_METHODS,
  BridgeSecurityError,
  SAFE_TEMP_EXT_RE,
  SAFE_TEMP_PREFIX_RE,
  assertContainedPath,
  createBridgeSecurityMiddleware,
  createOptionalAudioPathResolver,
  defaultAllowedTempRoots,
  isAllowedProxyTarget,
  parseAllowlistedOrigin,
  randomSuffix,
  resolveWithExistingRealpath
} from './bridgeSecurity'
import {
  createBridgeLifecycle,
  extractWorkerId,
  type BridgeController,
  type PipeStreamEntry
} from './bridgeLifecycle'

export { BridgeSecurityError, createOptionalAudioPathResolver }
export type { BridgeController }

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

/**
 * 渲染页面 ↔ 宿主的桥接层。
 * 通道语义与原 Electron IpcHandler 对齐：
 * - api-remux-video-from-files：MP4 合流 / 必要时 BT.709 转码后删除输入文件
 * - tts-fetch：受 tts.timeoutMs 控制的代理；translation-fetch：无超时代理
 * 配置（TTS/BGM）由宿主在任务下发时注入 payload，不再走配置文件通道。
 */
export function createBridgeRouter(deps: BridgeDeps): Router {
  const { logger, config } = deps
  const router = Router()

  const allowedTempRoots = defaultAllowedTempRoots()
  const allowedOutputRoots = Array.from(
    new Set([
      ...allowedTempRoots,
      ...[config.paths?.output, ...(deps.allowedOutputDirs ?? [])]
        .filter((d): d is string => Boolean(d))
        .map((d) => resolveWithExistingRealpath(d))
    ])
  )
  const resourceRoot = config.paths?.resources
    ? resolveWithExistingRealpath(config.paths.resources)
    : ''
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

  const lifecycle = createBridgeLifecycle({
    logger,
    fileHandleIdleMs: deps.fileHandleIdleMs,
    framesPipeIdleMs: deps.framesPipeIdleMs,
    onAllDisposed: () => stopRustBridgeServer(),
    onController: deps.onController
  })
  const { framesPipeSessions } = lifecycle
  const createPipe = deps.createFramesPipe ?? createFramesPipeSession

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

  router.use(createBridgeSecurityMiddleware(deps.bridgeToken))

  // ----- 共享临时文件读取（多段并行导出读取预合成 TTS WAV） -----

  router.get('/temp-file', async (req: Request, res: Response) => {
    try {
      const safePath = assertContainedPath(req.query.path, allowedTempRoots, 'temp file path')
      if (lifecycle.isUnderTombstonedPath(safePath)) {
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
        void lifecycle.cleanupPipeSession(
          targetId,
          new Error(`Bridge ${channel} request disconnected`)
        )
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
          await lifecycle.cleanupPipeSession(
            startedPipeId,
            new Error('Frames stream start aborted')
          )
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
    const taskId = lifecycle.extractTaskId(req, payload, workerId)
    if (taskId && lifecycle.isTaskCancelled(taskId)) {
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
      if (
        !deps.createFramesPipe &&
        isRustExporterAvailable(config.video.useRustExporter !== false)
      ) {
        session = RustFramesPipeSession.create(pipeOpts)
        logger.info(
          `[Bridge] Started native Rust pipe-encode session (id=${id}, format=${frameFormat})`
        )
      } else {
        session = await createPipe(pipeOpts)
      }
    } catch (error) {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
      throw error
    }

    if (signal.aborted || (taskId && lifecycle.isTaskCancelled(taskId))) {
      await session.abort(new Error('Frames stream start aborted')).catch(() => {})
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
      throw new BridgeSecurityError('Frames stream start aborted', 499)
    }

    lifecycle.registerTempPath(dir, workerId, taskId)
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
    lifecycle.touchPipeIdle(entry)
    return { id, videoPath }
  }

  async function handleInvoke(channel: string, args: unknown[], req: Request): Promise<unknown> {
    switch (channel) {
      case 'electron:get-temp-dir': {
        const workerId = extractWorkerId(req, args[0])
        const taskId = lifecycle.extractTaskId(req, args[0], workerId)
        if (taskId && lifecycle.isTaskCancelled(taskId)) {
          throw new BridgeSecurityError('Export task was cancelled', 499)
        }
        const rootDir = path.join(tmpdir(), `mss-hf-${Date.now()}-${randomSuffix()}`)
        const framesDir = path.join(rootDir, 'frames')
        await fs.promises.mkdir(framesDir, { recursive: true })
        if (taskId && lifecycle.isTaskCancelled(taskId)) {
          await lifecycle.cleanupTempPath(rootDir, true)
          throw new BridgeSecurityError('Export task was cancelled', 499)
        }
        lifecycle.registerTempPath(rootDir, workerId, taskId)
        return framesDir
      }

      case 'electron:get-temp-base-dir': {
        const workerId = extractWorkerId(req, args[0])
        const taskId = lifecycle.extractTaskId(req, args[0], workerId)
        if (taskId && lifecycle.isTaskCancelled(taskId)) {
          throw new BridgeSecurityError('Export task was cancelled', 499)
        }
        const baseDir = path.join(tmpdir(), `mss-export-${Date.now()}-${randomSuffix()}`)
        await fs.promises.mkdir(baseDir, { recursive: true })
        if (taskId && lifecycle.isTaskCancelled(taskId)) {
          await lifecycle.cleanupTempPath(baseDir, true)
          throw new BridgeSecurityError('Export task was cancelled', 499)
        }
        lifecycle.registerTempPath(baseDir, workerId, taskId)
        return baseDir
      }

      case 'electron:close-file-handle': {
        const payload = args[0] as { filePath?: string } | undefined
        if (!payload?.filePath) return null
        const resolved = assertContainedPath(payload.filePath, allowedTempRoots, 'temp file path')
        await lifecycle.closeCachedFileHandle(resolved)
        return null
      }

      case 'electron:delete-temp-file': {
        // 导出失败/取消时的临时文件清理（ENOENT 等错误静默）；仅限 tmpdir 内路径
        const payload = args[0] as { filePath: string }
        if (!payload?.filePath) return null
        const resolved = assertContainedPath(payload.filePath, allowedTempRoots, 'temp file path')
        lifecycle.unregisterTempPath(resolved)
        await lifecycle.closeCachedFileHandlesUnder(resolved)
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
        lifecycle.touchPipeIdle(entry)
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
              throw new BridgeSecurityError('Cannot repeat frame before any frame was written', 400)
            }
          }
          if (framesPipeSessions.has(id)) lifecycle.touchPipeIdle(entry)
          return { repeated: rawCount }
        } catch (error) {
          if (error instanceof BridgeSecurityError) throw error
          await lifecycle.cleanupPipeSession(
            id,
            error instanceof Error ? error : new Error(String(error))
          )
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
            lifecycle.rememberPipeFrameCount(videoPath, frameCount, entry.fps)
          }
          entry.lastRawFrame = null
          framesPipeSessions.delete(id)
          return { videoPath }
        } catch (error) {
          await lifecycle.cleanupPipeSession(
            id,
            error instanceof Error ? error : new Error(String(error))
          )
          throw error
        }
      }

      case 'electron:frames-stream-cancel': {
        const payload = args[0] as { id?: string } | undefined
        if (payload?.id) {
          await lifecycle.cleanupPipeSession(payload.id, new Error('Frames stream cancelled'))
        }
        return null
      }

      case 'electron:api-remux-video-from-files': {
        // fast 导出收尾：页内 WebCodecs / 管道已产出 MP4，仅 remux/合流，必要时按 BT.709 重编码
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
        const taskId = lifecycle.extractTaskId(req, payload, workerId)
        if (
          (taskId && lifecycle.isTaskCancelled(taskId)) ||
          lifecycle.isUnderTombstonedPath(safeVideoPath) ||
          (safeAudioPath ? lifecycle.isUnderTombstonedPath(safeAudioPath) : false)
        ) {
          return { success: false, error: 'Export task was cancelled' }
        }
        await lifecycle.closeCachedFileHandle(safeVideoPath)

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
          const pipeFrameInfo = lifecycle.pipeFrameInfoFor(safeVideoPath)
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
          const inputCodec = payload.inputCodec
            ? normalizeVideoCodec(payload.inputCodec)
            : undefined
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
              if (taskId && lifecycle.isTaskCancelled(taskId)) {
                await fs.promises.rm(safeOutputPath, { force: true }).catch(() => {})
                throw new Error('Export task was cancelled')
              }
              handledByRust = true
              logger.info(
                `[Bridge] API remux via mss-export-rs (${rustRes.encoder}, transcoded=${rustRes.transcoded}): ` +
                  `${(rustRes.fileSize / 1024 / 1024).toFixed(2)} MB in ${rustRes.elapsedMs}ms`
              )
            } catch (rustErr) {
              if (taskId && lifecycle.isTaskCancelled(taskId)) throw rustErr
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
                  await apiCopyVideo(safeVideoPath, partialPath, frameCount, fps, inputCodec)
                }
              },
              () => Boolean(taskId && lifecycle.isTaskCancelled(taskId))
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
              lifecycle.deletePipeFrameCount(safeVideoPath)
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
        const taskId = lifecycle.extractTaskId(req, payload, workerId)
        if (
          (taskId && lifecycle.isTaskCancelled(taskId)) ||
          lifecycle.isUnderTombstonedPath(safeFramesDir) ||
          (safeAudioPath ? lifecycle.isUnderTombstonedPath(safeAudioPath) : false)
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
          const isCancelled = (): boolean => Boolean(taskId && lifecycle.isTaskCancelled(taskId))

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
        if (safeBatch.some((item) => lifecycle.isUnderTombstonedPath(item.path))) {
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
          void lifecycle.cleanupPipeSession(id, new Error('Frames stream chunk request aborted'))
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
        lifecycle.touchPipeIdle(entry)
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
          if (framesPipeSessions.has(id)) lifecycle.touchPipeIdle(entry)
          return null
        } catch (error) {
          await lifecycle.cleanupPipeSession(
            id,
            error instanceof Error ? error : new Error(String(error))
          )
          throw error
        }
      }

      case 'electron:append-to-file': {
        const payload = args[0] as { filePath: string }
        const safePath = assertContainedPath(payload?.filePath, allowedTempRoots, 'temp file path')
        if (lifecycle.isUnderTombstonedPath(safePath)) {
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
        await lifecycle.writeFileAtCached(safePath, payload.position, body)
        return null
      }

      case 'electron:write-frame': {
        const payload = args[0] as { path: string }
        const safePath = assertContainedPath(payload?.path, allowedTempRoots, 'frame path')
        if (lifecycle.isUnderTombstonedPath(safePath)) {
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
        const taskId = lifecycle.extractTaskId(req, payload, workerId)
        if (taskId && lifecycle.isTaskCancelled(taskId)) {
          throw new BridgeSecurityError('Export task was cancelled', 499)
        }
        const tempPath = path.join(
          tmpdir(),
          `${payload.prefix}-${Date.now()}-${randomSuffix()}.${payload.extension}`
        )
        await fs.promises.writeFile(tempPath, body)
        if (taskId && lifecycle.isTaskCancelled(taskId)) {
          await lifecycle.cleanupTempPath(tempPath, true)
          throw new BridgeSecurityError('Export task was cancelled', 499)
        }
        lifecycle.registerTempPath(tempPath, workerId, taskId)
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
    const videoConfig = {
      encoder: config.video.encoder,
      codec: normalizeVideoCodec(config.video.codec),
      crf: config.video.crf
    }
    const rustInfo = ensureRustBridgeEndpoint()
    if (rustInfo?.running && rustInfo.wsUrl) {
      res.json({
        ok: true,
        backend: 'rust',
        wsUrl: rustInfo.wsUrl,
        token: rustInfo.token,
        videoConfig
      })
      return
    }
    const tokenSuffix = deps.bridgeToken ? `?token=${encodeURIComponent(deps.bridgeToken)}` : ''
    res.json({
      ok: true,
      backend: 'node',
      wsUrl: `/bridge/ws-bin${tokenSuffix}`,
      token: deps.bridgeToken ?? '',
      videoConfig
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
        const taskId = lifecycle.extractTaskId(req, body, workerId)
        if (taskId && lifecycle.isTaskCancelled(taskId)) {
          res.status(499).json({ ok: false, error: 'Export task was cancelled' })
          return
        }

        let safeOutputPath: string
        if (body.outputPath) {
          safeOutputPath = assertContainedPath(
            body.outputPath,
            allowedTempRoots,
            'audio outputPath'
          )
        } else {
          safeOutputPath = path.join(tmpdir(), `mss-audio-${Date.now()}-${randomSuffix()}.wav`)
          lifecycle.registerTempPath(safeOutputPath, workerId, taskId)
        }
        if (lifecycle.isUnderTombstonedPath(safeOutputPath)) {
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
          ...(v.path
            ? { path: assertContainedPath(v.path, allowedResourceRoots, 'voice path') }
            : {}),
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
        if (taskId && lifecycle.isTaskCancelled(taskId)) {
          await lifecycle.cleanupTempPath(safeOutputPath, true)
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
