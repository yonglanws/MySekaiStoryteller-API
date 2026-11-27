import crypto from 'node:crypto'
import fs from 'node:fs'
import { ILogObj, Logger } from 'tslog'
import { loadDotEnv } from './env'
import { loadHostConfig, validateConfigHints } from './config'
import { VideoApiServer } from './servers/VideoApiServer'
import { registerAssetRoutes, type AssetRoutesHandle } from './servers/routes/assetRoutes'
import { registerAiRoutes, type AiRoutesHandle } from './servers/routes/aiRoutes'
import { registerTtsLeaseRoutes } from './servers/routes/ttsLeaseRoutes'
import { createBridgeRouter, type BridgeController } from './bridge/bridgeRoutes'
import { WsHub } from './bridge/wsHub'
import { RenderPool } from './pool/renderPool'
import { createStaticRouter } from './static/staticRoutes'
import { ResourceCatalog } from './resources/resourceCatalog'
import { TtsLeaseManager } from './tts/TtsLeaseManager'
import { detectAvailableGpuEncoder, getCachedGpuEncoder } from '../shared/ffmpeg'
import { LlmClient } from './ai/llm'
import { loadPersonas } from './ai/personas'
import { StoryWriter } from './ai/storyWriter'
import { CloudCatalogService } from './assets/cloudCatalog'
import { resolveGlobalBgm, resolveStoryCloudAssets } from './assets/cloudAssets'
import { collectEmotionLabels } from '../common/tts/irodori'
import { needsJapaneseTtsPreflight } from '../common/tts/speechText'

/**
 * MySekaiStoryteller-API 纯 API 渲染宿主。
 *
 * 组成（单端口 9881）：
 * - VideoApiServer  视频导出 API（与旧版端点契约一致）
 * - 静态托管         webrenderer 页面 / resources 资源 / apifile 产物
 * - 桥接层 /bridge/* invoke、二进制写盘、TTS/翻译代理、WebSocket
 * - RenderPool      无头浏览器渲染工作进程池
 *
 * 配置来源：.env（不覆盖已有环境变量）→ config.yaml（样例 config.example.yaml）→ MSS_* 环境变量覆盖。
 */
/** 关停时等待在途导出完成的上限（毫秒） */
const SHUTDOWN_DRAIN_MS = 120_000
/** 关停时等待在途 AI 生成取消排空的上限（毫秒） */
const SHUTDOWN_AI_DRAIN_MS = 15_000

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
  // 先加载 .env（绝不覆盖 shell / Docker / systemd 已有环境变量），再读取 config.yaml 与 MSS_* 覆盖。
  const dotEnv = loadDotEnv()
  const config = loadHostConfig()
  const configHints = validateConfigHints(config)

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

  if (dotEnv.loaded && dotEnv.loadedKeys.length > 0) {
    logger.info(`[Env] Loaded ${dotEnv.loadedKeys.length} variable(s) from ${dotEnv.path}`)
  }

  for (const hint of configHints) {
    logger.warn(hint)
  }

  // 启动时并行探测一次硬件编码器：探测要真编 3 帧（QSV/NVENC 初始化可能数百毫秒），
  // 不阻塞 HTTP 服务启动；结果按 codec 缓存，health 与首次导出直接读取。
  const encoderProbe = detectAvailableGpuEncoder(config.video.codec)

  logger.info(
    `Starting MySekaiStoryteller-API host: root=${config.rootDir}, port=${config.server.port}, workers=${config.render.workers}, encoder=${config.video.encoder} (detected: pending)`
  )

  const bridgeToken = crypto.randomBytes(32).toString('hex')

  const hub = new WsHub(
    logger,
    {
      onWorkerReady: (workerId) => pool.handleWorkerReady(workerId),
      onWorkerMessage: (workerId, message) => pool.handleWorkerMessage(workerId, message),
      onWorkerDisconnected: (workerId) => pool.handleWorkerDisconnected(workerId)
    },
    bridgeToken
  )

  const useCloudCatalog = config.assets.cloudCatalog || config.assets.cloudOnly
  const cloudCatalog = new CloudCatalogService(logger, config.assets, {
    ttlMs: Math.max(1, config.assets.cloudCatalogTtlHours) * 60 * 60 * 1000
  })
  let cloudRefreshTimer: ReturnType<typeof setInterval> | null = null
  if (useCloudCatalog) {
    // 先读磁盘缓存，再等在线上限 15 秒：离线/资源站慢时不让宿主启动卡死，
    // 目录刷新会继续在后台跑，导出时再按需物化。
    fs.mkdirSync(config.paths.resources, { recursive: true })
    cloudCatalog.loadFromCache()
    await cloudCatalog.ensure(15_000)
    cloudRefreshTimer = setInterval(
      () => void cloudCatalog.refresh(),
      Math.max(1, config.assets.cloudCatalogTtlHours) * 60 * 60 * 1000
    )
    cloudRefreshTimer.unref?.()
  }

  const resourceCatalog = new ResourceCatalog(
    logger,
    config,
    useCloudCatalog ? () => cloudCatalog.get() : null
  )

  // 宿主内置 AI 剧本生成：LLM 客户端 + 资源目录提示词/校验
  const llmClient = new LlmClient(config.llm, logger)
  const loadedPersonaCount = loadPersonas(config.llm).length
  const emotionLabels = collectEmotionLabels(
    config.tts.irodori.emotionLabels,
    config.tts.characters
  )
  const storyWriter = new StoryWriter(llmClient, config.llm, resourceCatalog, logger, emotionLabels)
  logger.info(
    `[LLM] Personas loaded: ${loadedPersonaCount} (dirs=${config.llm.personaDirs.length}, inline=${config.llm.personas.length})`
  )

  // GSV 的权重是服务端全局状态：所有渲染 worker 的「切权重 + 合成」必须串行
  const ttsLease = new TtsLeaseManager(logger)

  let bridgeController: BridgeController | null = null
  let assetRoutesHandle: AssetRoutesHandle | null = null
  let aiRoutesHandle: AiRoutesHandle | null = null

  const pool = new RenderPool(
    logger,
    config,
    hub,
    resourceCatalog,
    bridgeToken,
    (workerId) => {
      void bridgeController?.cleanupWorker(workerId).catch((err) => {
        logger.warn(`[Bridge] Failed to clean up pipe sessions for worker ${workerId}`, err)
      })
    },
    {
      onTaskStart: (workerId, taskId) => {
        bridgeController?.bindWorkerTask(workerId, taskId)
      },
      onTaskCancel: (taskId) => {
        if (!bridgeController) return
        return bridgeController.cleanupTask(taskId).catch((err) => {
          logger.warn(`[Bridge] Failed to clean up temp dirs for cancelled task ${taskId}`, err)
        })
      }
    }
  )

  const serverExtra = config.server as {
    apiKey?: unknown
    cors?: unknown
    corsOrigins?: unknown
  }
  const apiKey =
    (typeof process.env.MSST_API_KEY === 'string' && process.env.MSST_API_KEY.trim()) ||
    (typeof process.env.MSS_API_KEY === 'string' && process.env.MSS_API_KEY.trim()) ||
    (typeof serverExtra.apiKey === 'string' ? serverExtra.apiKey.trim() : '')
  const corsEnabled = typeof serverExtra.cors === 'boolean' ? serverExtra.cors : undefined
  const corsOrigins = Array.isArray(serverExtra.corsOrigins)
    ? serverExtra.corsOrigins.filter((item): item is string => typeof item === 'string')
    : undefined

  const apiServer = new VideoApiServer(logger, {
    port: config.server.port,
    host: config.server.host,
    outputDir: config.paths.output,
    video: config.video,
    maxConcurrentExports: config.render.maxConcurrentExports || config.render.workers,
    apiKey,
    bridgeToken,
    cors: corsEnabled,
    corsOrigins,
    // 云端资源物化：故事里的背景名/ID、BGM、Live2D 模型在这里变成
    // resources/cloud/ 下的真实文件；cloudOnly=true 时严格忽略非 cloud/ 的旧本地资源。
    prepareStory: async (story) => {
      if (useCloudCatalog) {
        await cloudCatalog.waitReady({ coldTimeoutMs: 180_000, staleTimeoutMs: 5_000 })
        const cloudContext = {
          settings: config.assets,
          resourcesDir: config.paths.resources,
          catalog: cloudCatalog.get(),
          logger,
          cloudOnly: config.assets.cloudOnly
        }
        await resolveGlobalBgm(config.bgm, cloudContext)
        await resolveStoryCloudAssets(story, cloudContext)
      }
      // IrodoriTTS 只接受日文：导出前把空/中文 ttsText 补成日文，补不齐直接 400。
      // TTS 关闭时 ttsText 不进入音轨，不应为了合成约束阻断纯画面导出。
      if (needsJapaneseTtsPreflight(config.tts)) {
        const translated = await storyWriter.ensureJapaneseTtsText(story)
        if (translated > 0) {
          logger.info(`[TTS] Export preflight translated ${translated} lines to Japanese`)
        }
      }
    },
    registerExtraRoutes: (app, server) => {
      app.use(
        '/bridge',
        createBridgeRouter({
          logger,
          config,
          bridgeToken,
          onController: (ctrl) => {
            bridgeController = ctrl
          }
        })
      )
      assetRoutesHandle = registerAssetRoutes(app, {
        logger,
        config,
        useCloudCatalog,
        cloudCatalog,
        resourceCatalog
      })
      aiRoutesHandle = registerAiRoutes(app, server, {
        config,
        llmClient,
        storyWriter,
        useCloudCatalog,
        cloudCatalog
      })
      registerTtsLeaseRoutes(app, { logger, ttsLease })
      app.use('/apifile', server.createAuthMiddleware())
      app.use(createStaticRouter(config))
      logger.info('[Host] Bridge, resource catalog, AI, TTS lease and static routes mounted')
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
        timings: result.timings,
        diagnostics: result.diagnostics
      })
    } else {
      apiServer.rejectExport(taskId, new Error(result.error || 'Export failed'))
    }
  }

  apiServer.setExtraHealthProvider((authed) => {
    const leaseStats = ttsLease.stats()
    return {
      renderPool: pool.stats(),
      ttsLease: authed
        ? leaseStats
        : {
            active: leaseStats.active,
            waiters: leaseStats.waiters,
            hasWeights: leaseStats.currentWeights !== null
          },
      tts: {
        enabled: config.tts.enabled,
        provider: config.tts.provider,
        ...(authed ? { apiBaseUrl: config.tts.apiBaseUrl } : {}),
        emotionLabels,
        characters: config.tts.characters.length
      },
      llm: {
        enabled: llmClient.enabled,
        model: config.llm.model,
        ...(authed ? { baseUrl: config.llm.baseUrl } : {}),
        pipeline: config.llm.pipeline,
        agentMaxSteps: config.llm.agentMaxSteps,
        apiKeyConfigured: Boolean(llmClient.apiKey),
        personas: loadedPersonaCount,
        activeGenerations: aiRoutesHandle?.getActiveCount() ?? 0,
        maxConcurrent:
          aiRoutesHandle?.getMaxConcurrent() ?? Math.max(1, Math.min(4, config.render.workers))
      },
      assets: {
        source: config.assets.source,
        region: config.assets.region,
        cloudCatalog: useCloudCatalog,
        cloudOnly: config.assets.cloudOnly,
        ...(authed
          ? {
              indexBase: config.assets.indexBase,
              libraryBase: config.assets.libraryBase
            }
          : {}),
        fetching: assetRoutesHandle?.isFetching() ?? false
      },
      host: {
        platform: process.platform,
        node: process.version,
        ffmpegEncoder: config.video.encoder,
        ffmpegEncoderDetected: getCachedGpuEncoder()
      }
    }
  })

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

  void encoderProbe.then((detected) => {
    logger.info(`[ffmpeg] Encoder probe ready: ${detected} (codec=${config.video.codec})`)
  })

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(`Received ${signal}, shutting down...`)

    // 1. 立即打开排空闸门：拒绝新的导出与 AI 生成请求（503），并停止云端目录后台定时器
    apiServer.beginDraining()
    if (cloudRefreshTimer) {
      clearInterval(cloudRefreshTimer)
      cloudRefreshTimer = null
    }

    // 2. 终止并等待在途 AI 生成任务释放
    if (aiRoutesHandle && aiRoutesHandle.getActiveCount() > 0) {
      logger.info(
        `Aborting and draining ${aiRoutesHandle.getActiveCount()} in-flight AI generation(s)...`
      )
      await aiRoutesHandle.abortAndDrain(SHUTDOWN_AI_DRAIN_MS)
    }

    // 3. 排空在途导出：直接关浏览器会把半渲染的任务静默丢弃
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
    try {
      await bridgeController?.disposeAll()
    } catch (err) {
      logger.warn('Bridge cleanup failed', err)
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
