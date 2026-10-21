import { ILogObj, Logger } from 'tslog'
import { loadHostConfig } from './config'
import { VideoApiServer } from './servers/VideoApiServer'
import { createBridgeRouter } from './bridge/bridgeRoutes'
import { WsHub } from './bridge/wsHub'
import { RenderPool } from './pool/renderPool'
import { createStaticRouter } from './static/staticRoutes'
import { ResourceCatalog } from './resources/resourceCatalog'
import { TtsLeaseManager, type TtsWeights } from './tts/TtsLeaseManager'
import { detectAvailableGpuEncoder, getCachedGpuEncoder } from '../shared/ffmpeg'

/**
 * MySekaiStoryteller-API 纯 API 渲染宿主。
 *
 * 组成（单端口 9881）：
 * - VideoApiServer  视频导出 API（与旧版端点契约一致）
 * - 静态托管         webrenderer 页面 / resources 资源 / apifile 产物
 * - 桥接层 /bridge/* invoke、二进制写盘、TTS/翻译代理、WebSocket
 * - RenderPool      无头浏览器渲染工作进程池
 *
 * 配置来源：config.yaml（样例 config.example.yaml），MSS_* 环境变量可覆盖。
 */
/** 关停时等待在途导出完成的上限（毫秒） */
const SHUTDOWN_DRAIN_MS = 120_000

/**
 * 宿主级异常兜底：渲染宿主是长驻服务，任何单点异常（Playwright CDP 管道
 * 溢出、段渲染偶发错误、未处理的 Promise 拒绝）都不应该让整个进程退出——
 * 那会同时打死所有在途导出。这里记录后继续运行，任务级失败由各管线的
 * 重试/回退链负责。
 */
function installProcessGuards(logger: Logger<ILogObj>): void {
  process.on('uncaughtException', (err) => {
    logger.error('[Host] Uncaught exception (kept alive):', err)
  })
  process.on('unhandledRejection', (reason) => {
    logger.error('[Host] Unhandled rejection (kept alive):', reason)
  })
}

async function bootstrap(): Promise<void> {
  const config = loadHostConfig()

  const LOG_LEVEL_IDS: Record<string, number> = {
    silly: 0,
    trace: 1,
    debug: 2,
    info: 3,
    warn: 4,
    error: 5,
    fatal: 6
  }

  const logger: Logger<ILogObj> = new Logger({
    name: 'host',
    type: 'pretty',
    minLevel: LOG_LEVEL_IDS[config.logLevel] ?? 3,
    prettyLogTemplate:
      '[{{yyyy}}-{{mm}}-{{dd}} {{hh}}:{{MM}}:{{ss}}:{{ms}}][{{logLevelName}}][{{name}}]: ',
    prettyLogTimeZone: 'local'
  })

  installProcessGuards(logger)

  // 启动时探测一次硬件编码器并缓存：避免每次导出都 spawn ffmpeg -encoders，
  // health 也能上报真实使用的编码器（此前只报配置值）
  const detectedEncoder = await detectAvailableGpuEncoder()

  logger.info(
    `Starting MySekaiStoryteller-API host: root=${config.rootDir}, port=${config.server.port}, workers=${config.render.workers}, encoder=${config.video.encoder} (detected: ${detectedEncoder})`
  )

  const hub = new WsHub(logger, {
    onWorkerReady: (workerId) => pool.handleWorkerReady(workerId),
    onWorkerMessage: (workerId, message) => pool.handleWorkerMessage(workerId, message),
    onWorkerDisconnected: (workerId) => pool.handleWorkerDisconnected(workerId)
  })

  const resourceCatalog = new ResourceCatalog(logger, config)

  // GSV 的权重是服务端全局状态：所有渲染 worker 的「切权重 + 合成」必须串行
  const ttsLease = new TtsLeaseManager(logger)

  const pool = new RenderPool(logger, config, hub, resourceCatalog)

  const apiServer = new VideoApiServer(logger, {
    port: config.server.port,
    host: config.server.host,
    outputDir: config.paths.output,
    video: config.video,
    maxConcurrentExports: config.render.workers,
    registerExtraRoutes: (app) => {
      app.use('/bridge', createBridgeRouter({ logger, config }))
      // 资源目录：供 AstrBot 插件动态构建提示词与校验白名单
      app.get('/api/v1/resources', (_req, res) => {
        res.json({ success: true, ...resourceCatalog.get() })
      })

      // TTS 权重租约：同一时刻只允许一个渲染 worker 切权重并合成，
      // 避免多个导出并发时 GSV 的全局权重被互相覆盖。
      app.post('/api/v1/tts/lease', async (req, res) => {
        const controller = new AbortController()
        let settled = false
        const onClose = (): void => {
          if (!settled) controller.abort()
        }
        req.on('close', onClose)
        try {
          const grant = await ttsLease.acquire(controller.signal)
          settled = true
          res.json({ success: true, ...grant })
        } catch (error) {
          settled = true
          if (!res.headersSent) {
            res.status(503).json({
              success: false,
              error: error instanceof Error ? error.message : String(error)
            })
          }
        } finally {
          req.off('close', onClose)
        }
      })

      app.post('/api/v1/tts/lease/release', (req, res) => {
        const body = req.body as { leaseId?: unknown; weights?: unknown } | undefined
        if (typeof body?.leaseId !== 'string' || body.leaseId.length === 0) {
          res.status(400).json({ success: false, error: 'leaseId is required' })
          return
        }

        let weights: TtsWeights | null | undefined
        if (body.weights === null) {
          weights = null
        } else if (typeof body.weights === 'object' && body.weights !== null) {
          const raw = body.weights as {
            gptWeightsPath?: unknown
            sovitsWeightsPath?: unknown
          }
          if (typeof raw.gptWeightsPath !== 'string' || typeof raw.sovitsWeightsPath !== 'string') {
            res.status(400).json({ success: false, error: 'weights paths must be strings' })
            return
          }
          weights = {
            gptWeightsPath: raw.gptWeightsPath,
            sovitsWeightsPath: raw.sovitsWeightsPath
          }
        }

        const previous = ttsLease.stats().currentWeights
        const changed =
          weights !== undefined &&
          (weights === null ||
            previous === null ||
            previous.gptWeightsPath !== weights.gptWeightsPath ||
            previous.sovitsWeightsPath !== weights.sovitsWeightsPath)

        if (changed && weights !== undefined) {
          if (weights === null) {
            logger.warn(
              `[TTS] Lease ${body.leaseId} released without confirmed weights; next request will switch`
            )
          } else {
            const gpt = weights.gptWeightsPath.split(/[\\/]/).pop() || weights.gptWeightsPath
            const sovits =
              weights.sovitsWeightsPath.split(/[\\/]/).pop() || weights.sovitsWeightsPath
            logger.info(`[TTS] Weights active: ${gpt} + ${sovits}`)
          }
        }

        ttsLease.release(body.leaseId, weights)
        res.json({ success: true })
      })

      app.use(createStaticRouter(config))
      logger.info('[Host] Bridge, resource catalog and static routes mounted')
    }
  })

  apiServer.setDispatcher(pool)

  pool.onExportResult = (taskId, result) => {
    if (result.success) {
      apiServer.resolveExport(taskId, {
        success: true,
        videoPath: result.videoPath,
        duration: result.duration,
        frameCount: result.frameCount,
        outputSize: result.outputSize,
        timings: result.timings
      })
    } else {
      apiServer.rejectExport(taskId, new Error(result.error || 'Export failed'))
    }
  }

  apiServer.setExtraHealthProvider(() => ({
    renderPool: pool.stats(),
    ttsLease: ttsLease.stats(),
    host: {
      platform: process.platform,
      node: process.version,
      ffmpegEncoder: config.video.encoder,
      ffmpegEncoderDetected: getCachedGpuEncoder()
    }
  }))

  try {
    await apiServer.start()
  } catch (error) {
    logger.error('Failed to start Video API server', error)
    process.exit(1)
  }

  // WS 升级挂在 API 服务的 HTTP server 上（同端口）
  const httpServer = apiServer.getHttpServer()
  if (!httpServer) {
    logger.error('HTTP server not available for WebSocket attachment')
    process.exit(1)
  }
  hub.attach(httpServer)

  await pool.start()

  logger.info(
    `BGM: enabled=${config.bgm.enabled}, volume=${config.bgm.volume}, path=${config.bgm.path}`
  )
  logger.info(`Host ready: API http://${config.server.host}:${config.server.port}/api/v1/health`)

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(`Received ${signal}, shutting down...`)
    // 排空在途导出：直接关浏览器会把半渲染的任务静默丢弃
    const drainDeadline = Date.now() + SHUTDOWN_DRAIN_MS
    while (apiServer.hasActiveExports() && Date.now() < drainDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    if (apiServer.hasActiveExports()) {
      logger.warn('Shutdown drain timeout, in-flight exports will be dropped')
    }
    try {
      await pool.stop()
    } catch (err) {
      logger.warn('Pool stop failed', err)
    }
    ttsLease.dispose()
    apiServer.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

void bootstrap().catch((error) => {
  console.error('Fatal: host bootstrap failed', error)
  process.exit(1)
})
