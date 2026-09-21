import { ILogObj, Logger } from 'tslog'
import { loadHostConfig } from './config'
import { VideoApiServer } from './servers/VideoApiServer'
import { createBridgeRouter } from './bridge/bridgeRoutes'
import { WsHub } from './bridge/wsHub'
import { RenderPool } from './pool/renderPool'
import { createStaticRouter } from './static/staticRoutes'
import { ResourceCatalog } from './resources/resourceCatalog'

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

  logger.info(
    `Starting MySekaiStoryteller-API host: root=${config.rootDir}, port=${config.server.port}, workers=${config.render.workers}, encoder=${config.video.encoder}`
  )

  const hub = new WsHub(logger, {
    onWorkerReady: (workerId) => pool.handleWorkerReady(workerId),
    onWorkerMessage: (workerId, message) => pool.handleWorkerMessage(workerId, message),
    onWorkerDisconnected: (workerId) => pool.handleWorkerDisconnected(workerId)
  })

  const resourceCatalog = new ResourceCatalog(logger, config)

  const pool = new RenderPool(logger, config, hub, resourceCatalog)

  const apiServer = new VideoApiServer(logger, {
    port: config.server.port,
    host: config.server.host,
    outputDir: config.paths.output,
    video: config.video,
    maxConcurrentExports: config.render.workers,
    registerExtraRoutes: (app) => {
      app.use(
        '/bridge',
        createBridgeRouter({
          logger,
          config,
          parallelHooks: {
            startParallelSegments: (taskId, plan) =>
              apiServer.startParallelSegments(taskId, plan),
            completeParallelJob: (taskId) => apiServer.completeParallelJob(taskId)
          }
        })
      )
      // 资源目录：供 AstrBot 插件动态构建提示词与校验白名单
      app.get('/api/v1/resources', (_req, res) => {
        res.json({ success: true, ...resourceCatalog.get() })
      })
      app.use(createStaticRouter(config))
      logger.info('[Host] Bridge, resource catalog and static routes mounted')
    }
  })

  apiServer.setDispatcher(pool)

  // 段 0 直接派给编排页自己渲染（它已加载场景，且不占 worker 名额）
  apiServer.hubSendSegment = (task, workerId) => {
    if (!workerId) return false
    const payload = {
      taskId: task.taskId,
      segmentIndex: task.segment.index,
      fromSnippet: task.segment.fromSnippet,
      toSnippet: task.segment.toSnippet,
      startTimeMs: task.segment.startTimeMs,
      timeline: task.timeline,
      outputPath: task.outputPath,
      story: task.story,
      videoConfig: task.videoConfig,
      tts: { ...config.tts, characters: [] },
      bgm: { ...config.bgm }
    }
    const sent = hub.send(workerId, { type: 'api:render-segment', args: [payload] })
    logger.info(
      `[Host] Segment 0 handed to orchestrator ${workerId} for ${task.taskId} (sent=${sent})`
    )
    return sent
  }

  // 段全部就绪 → 通过 WS 把段结果发回编排页（plan 里带了它的 workerId）
  apiServer.onParallelSegmentsDone = (taskId, payload, orchestratorWorkerId) => {
    if (!orchestratorWorkerId) {
      logger.error(`[Host] No orchestrator worker id for task ${taskId}`)
      apiServer.rejectExport(taskId, new Error('Orchestrator worker not found for parallel plan'))
      return
    }
    const sent = hub.send(orchestratorWorkerId, { type: 'api:parallel-segments-done', args: [payload] })
    if (!sent) {
      logger.error(`[Host] Failed to notify orchestrator ${orchestratorWorkerId} for ${taskId}`)
      apiServer.rejectExport(taskId, new Error('Orchestrator worker unreachable'))
      return
    }
    logger.info(`[Host] Parallel segments done notified to ${orchestratorWorkerId} for ${taskId}`)
  }

  pool.onExportResult = (taskId, result) => {
    // parallel 段结果：taskId = `<parentTaskId>#seg<index>`
    const segMarker = taskId.indexOf('#seg')
    if (segMarker > -1 && result.segmentResult) {
      apiServer.handleSegmentResult(taskId.slice(0, segMarker), result.segmentResult.index, result)
      return
    }
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
    host: {
      platform: process.platform,
      node: process.version,
      ffmpegEncoder: config.video.encoder
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

  logger.info(`Host ready: API http://${config.server.host}:${config.server.port}/api/v1/health`)

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(`Received ${signal}, shutting down...`)
    try {
      await pool.stop()
    } catch (err) {
      logger.warn('Pool stop failed', err)
    }
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
