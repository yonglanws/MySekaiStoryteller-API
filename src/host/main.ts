import fs from 'node:fs'
import path from 'node:path'
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
import { LlmClient } from './ai/llm'
import { StoryWriter, StoryGenerationError, type GenerateStoryResult } from './ai/storyWriter'
import { fetchModels, loadMoesekaiIndex, selectModels } from './assets/moesekai'
import { fetchMedia, listMedia, type MediaKind } from './assets/media'
import { loadSoundtrackIndex } from './assets/soundtracks'
import { collectEmotionLabels } from '../common/tts/irodori'
import { needsJapaneseTtsPreflight } from '../common/tts/speechText'
import type { StoryData } from '../common/types/Story'

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

  // 宿主内置 AI 剧本生成：LLM 客户端 + 资源目录提示词/校验
  const llmClient = new LlmClient(config.llm, logger)
  const emotionLabels = collectEmotionLabels(
    config.tts.irodori.emotionLabels,
    config.tts.characters
  )
  const storyWriter = new StoryWriter(llmClient, config.llm, resourceCatalog, logger, emotionLabels)
  let aiActive = 0
  const AI_MAX_CONCURRENT = Math.max(1, Math.min(4, config.render.workers))
  let assetFetchTask: Promise<unknown> | null = null

  // GSV 的权重是服务端全局状态：所有渲染 worker 的「切权重 + 合成」必须串行
  const ttsLease = new TtsLeaseManager(logger)

  const pool = new RenderPool(logger, config, hub, resourceCatalog)

  const apiServer = new VideoApiServer(logger, {
    port: config.server.port,
    host: config.server.host,
    outputDir: config.paths.output,
    video: config.video,
    maxConcurrentExports: config.render.workers,
    // IrodoriTTS 只接受日文：导出前把空/中文 ttsText 补成日文，补不齐直接 400。
    // TTS 关闭时 ttsText 不进入音轨，不应为了合成约束阻断纯画面导出。
    prepareStory: needsJapaneseTtsPreflight(config.tts)
      ? async (story) => {
          const translated = await storyWriter.ensureJapaneseTtsText(story)
          if (translated > 0) {
            logger.info(`[TTS] Export preflight translated ${translated} lines to Japanese`)
          }
        }
      : undefined,
    registerExtraRoutes: (app) => {
      app.use('/bridge', createBridgeRouter({ logger, config }))
      // 资源目录：供 AstrBot 插件动态构建提示词与校验白名单
      app.get('/api/v1/resources', (_req, res) => {
        res.json({ success: true, ...resourceCatalog.get() })
      })

      // ---- 云端资源（moesekai / pjsk.moe） ------------------------------------------------------------
      app.get('/api/v1/assets/moesekai/models', async (req, res) => {
        const region = String(
          req.query.region ?? config.assets.region
        ) as typeof config.assets.region
        if (!['jp', 'cn', 'tw', 'kr', 'en'].includes(region)) {
          res.status(400).json({ success: false, error: 'region must be jp/cn/tw/kr/en' })
          return
        }
        try {
          const { index, indexUrl } = await loadMoesekaiIndex(config.assets, region)
          const characters = String(req.query.characters ?? '')
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
          const models = String(req.query.models ?? '')
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
          const selected =
            characters.length === 0 && models.length === 0
              ? index.models
              : selectModels(index, {
                  characters: characters.length > 0 ? characters : undefined,
                  models: models.length > 0 ? models : undefined
                })
          res.json({
            success: true,
            region,
            indexUrl,
            generatedAt: index.generatedAt,
            assetVersion: index.assetVersion,
            total: index.models.length,
            models: selected.map((model) => ({
              id: model.id,
              kind: model.kind ?? null,
              characterId: model.characterId ?? null,
              bundle: model.bundle,
              motionBundles: model.motions ?? (model.motion ? [model.motion] : []),
              bytes: model.bytes ?? 0
            }))
          })
        } catch (error) {
          res.status(502).json({
            success: false,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      })

      // 背景/BGM 浏览（不下载）；kind=backgrounds|bgm|all
      app.get('/api/v1/assets/moesekai/media', async (req, res) => {
        const region = String(req.query.region ?? config.assets.region)
        if (!['jp', 'cn', 'tw', 'kr', 'en'].includes(region)) {
          res.status(400).json({ success: false, error: 'region must be jp/cn/tw/kr/en' })
          return
        }
        const rawKind = String(req.query.kind ?? 'all').toLowerCase()
        const kinds: MediaKind[] | null =
          rawKind === 'all'
            ? ['background', 'bgm']
            : rawKind === 'backgrounds' || rawKind === 'background'
              ? ['background']
              : rawKind === 'bgm'
                ? ['bgm']
                : null
        if (!kinds) {
          res.status(400).json({ success: false, error: 'kind must be backgrounds/bgm/all' })
          return
        }
        const names = String(req.query.names ?? '')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
        const rawLimit = req.query.limit
        let limit: number | undefined
        if (rawLimit !== undefined) {
          limit = Number(rawLimit)
          if (!Number.isInteger(limit) || limit < 0) {
            res.status(400).json({ success: false, error: 'limit must be an integer >= 0' })
            return
          }
        }
        try {
          const result = await listMedia({
            region: region as typeof config.assets.region,
            kinds,
            assetBase: config.assets.assetBase || undefined,
            limit,
            names: names.length > 0 ? names : undefined,
            includeAreaBgm: req.query.includeArea === '1' || req.query.includeArea === 'true',
            timeoutMs: config.assets.timeoutMs,
            retries: config.assets.retries
          })
          res.json({ success: true, ...result })
        } catch (error) {
          res.status(502).json({
            success: false,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      })

      app.post('/api/v1/assets/fetch', async (req, res) => {
        if (assetFetchTask) {
          res.status(409).json({ success: false, error: 'another asset fetch is already running' })
          return
        }
        const body = (req.body ?? {}) as {
          kind?: unknown
          characters?: unknown
          models?: unknown
          names?: unknown
          limit?: unknown
          region?: unknown
          force?: unknown
          dryRun?: unknown
          includeArea?: unknown
        }
        const toList = (value: unknown, label: string): string[] | undefined => {
          if (value === undefined) return undefined
          if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
            throw new Error(`${label} must be a string array`)
          }
          return value as string[]
        }
        const region = String(body.region ?? config.assets.region)
        if (!['jp', 'cn', 'tw', 'kr', 'en'].includes(region)) {
          res.status(400).json({ success: false, error: 'region must be jp/cn/tw/kr/en' })
          return
        }

        let characters: string[] | undefined
        let models: string[] | undefined
        let names: string[] | undefined
        let limit: number | undefined
        let kind: 'backgrounds' | 'bgm' | 'all' | undefined
        try {
          characters = toList(body.characters, 'characters')
          models = toList(body.models, 'models')
          names = toList(body.names, 'names')
          if (body.limit !== undefined) {
            if (typeof body.limit !== 'number' || !Number.isInteger(body.limit) || body.limit < 0) {
              throw new Error('limit must be an integer >= 0')
            }
            limit = body.limit
          }
          if (body.kind !== undefined) {
            const raw = String(body.kind).toLowerCase()
            if (raw === 'backgrounds' || raw === 'background') kind = 'backgrounds'
            else if (raw === 'bgm') kind = 'bgm'
            else if (raw === 'all') kind = 'all'
            else throw new Error('kind must be backgrounds/bgm/all')
          }
        } catch (error) {
          res.status(400).json({
            success: false,
            error: error instanceof Error ? error.message : String(error)
          })
          return
        }

        if (!kind && !characters?.length && !models?.length) {
          res.status(400).json({
            success: false,
            error: 'kind (backgrounds/bgm/all) or characters/models is required'
          })
          return
        }

        const fetchKinds: MediaKind[] =
          kind === 'all' ? ['background', 'bgm'] : [kind === 'backgrounds' ? 'background' : 'bgm']

        assetFetchTask = kind
          ? (async () => {
              // 官方曲名索引只影响新登记的 BGM；dry-run 不写清单，无需多拉一次网络。
              const soundtrackIndex =
                fetchKinds.includes('bgm') && body.dryRun !== true
                  ? await loadSoundtrackIndex({
                      cacheFile: path.join(
                        config.paths.resources,
                        'audio',
                        'bgm',
                        'soundtracks.json'
                      ),
                      baseUrl: config.assets.soundtrackBase,
                      timeoutMs: Math.min(config.assets.timeoutMs, 60_000),
                      retries: Math.min(config.assets.retries, 1),
                      onProgress: (message) => logger.info(`[Assets] ${message}`)
                    })
                  : null
              return fetchMedia({
                outDir: config.paths.resources,
                region: region as typeof config.assets.region,
                kinds: fetchKinds,
                assetBase: config.assets.assetBase || undefined,
                names,
                limit,
                includeAreaBgm: body.includeArea === true,
                force: body.force === true,
                dryRun: body.dryRun === true,
                timeoutMs: config.assets.timeoutMs,
                retries: config.assets.retries,
                soundtrackIndex,
                onProgress: (message) => logger.info(`[Assets] ${message}`)
              })
            })()
          : fetchModels(config.assets, {
              outDir: config.paths.resources,
              region: region as typeof config.assets.region,
              characters,
              models,
              force: body.force === true,
              dryRun: body.dryRun === true,
              onProgress: (message) => logger.info(`[Assets] ${message}`)
            })
        try {
          const result = await assetFetchTask
          res.json({ success: true, ...(result as object) })
        } catch (error) {
          res.status(502).json({
            success: false,
            error: error instanceof Error ? error.message : String(error)
          })
        } finally {
          assetFetchTask = null
        }
      })

      // ---- 宿主内置 AI 剧本生成 ----------------------------------------------------------------------
      const runGenerate = async (
        body: {
          prompt?: unknown
          mode?: unknown
          cast?: unknown
          targetMinutes?: unknown
          history?: unknown
          translateForTts?: unknown
          pipeline?: unknown
        },
        signal: AbortSignal
      ): Promise<GenerateStoryResult> => {
        if (!llmClient.enabled) {
          throw new StoryGenerationError('宿主未启用 LLM（llm.enabled=false）', [])
        }
        if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
          throw new StoryGenerationError('prompt 必须是非空字符串', [])
        }
        const mode = body.mode === 'chat' ? 'chat' : 'story'
        let cast: string[] | undefined
        if (body.cast !== undefined) {
          if (!Array.isArray(body.cast) || body.cast.some((item) => typeof item !== 'string')) {
            throw new StoryGenerationError('cast 必须是字符串数组', [])
          }
          cast = body.cast as string[]
        }
        let history: Array<{ role: string; content: string }> | undefined
        if (body.history !== undefined) {
          if (
            !Array.isArray(body.history) ||
            body.history.some(
              (item) =>
                !item ||
                typeof item !== 'object' ||
                typeof (item as { role?: unknown }).role !== 'string' ||
                typeof (item as { content?: unknown }).content !== 'string'
            )
          ) {
            throw new StoryGenerationError('history 必须是 {role, content} 数组', [])
          }
          history = body.history as Array<{ role: string; content: string }>
        }
        const targetMinutes =
          typeof body.targetMinutes === 'number' && body.targetMinutes > 0
            ? body.targetMinutes
            : config.llm.targetMinutes
        let pipeline: 'single' | 'staged' | undefined
        if (body.pipeline !== undefined) {
          if (body.pipeline !== 'single' && body.pipeline !== 'staged') {
            throw new StoryGenerationError('pipeline 必须是 "single" 或 "staged"', [])
          }
          pipeline = body.pipeline
        }
        return storyWriter.generate({
          prompt: body.prompt,
          mode,
          cast,
          targetMinutes,
          history,
          translateForTts:
            typeof body.translateForTts === 'boolean' ? body.translateForTts : undefined,
          pipeline,
          signal
        })
      }

      const errorResponse = (res: import('express').Response, error: unknown): void => {
        if (error instanceof StoryGenerationError) {
          res.status(422).json({
            success: false,
            message: error.message,
            details: error.details
          })
          return
        }
        if (error instanceof Error && error.name === 'AbortError') {
          res.status(504).json({ success: false, message: 'AI script generation timed out' })
          return
        }
        res.status(502).json({
          success: false,
          message: error instanceof Error ? error.message : String(error)
        })
      }

      const writeScript = (story: StoryData): string => {
        const suffix = Math.random().toString(36).slice(2, 8)
        const file = path.join(config.paths.output, `script-${Date.now()}-${suffix}.json`)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, JSON.stringify(story, null, 2), 'utf-8')
        return file
      }

      const acquireAiSlot = (res: import('express').Response): boolean => {
        if (aiActive >= AI_MAX_CONCURRENT) {
          res.status(429).json({
            success: false,
            message: `Too many concurrent AI generations (max ${AI_MAX_CONCURRENT})`
          })
          return false
        }
        aiActive += 1
        return true
      }

      app.post('/api/v1/script/generate', async (req, res) => {
        if (!acquireAiSlot(res)) return
        const body = (req.body ?? {}) as Parameters<typeof runGenerate>[0] & { timeout?: unknown }
        const timeoutMs =
          typeof body.timeout === 'number' && Number.isFinite(body.timeout)
            ? Math.min(Math.max(1, body.timeout), 1_800_000)
            : 600_000
        const controller = new AbortController()
        const timer = setTimeout(
          () => controller.abort(new Error(`AI timeout after ${timeoutMs}ms`)),
          timeoutMs
        )
        const onClose = (): void => {
          if (!res.writableEnded) controller.abort(new Error('client disconnected'))
        }
        res.on('close', onClose)
        try {
          const result = await runGenerate(body, controller.signal)
          const scriptPath = writeScript(result.story)
          res.json({ success: true, story: result.story, meta: result.meta, scriptPath })
        } catch (error) {
          if (controller.signal.aborted && !res.writableEnded) {
            res.status(504).json({ success: false, message: 'AI script generation timed out' })
          } else {
            errorResponse(res, error)
          }
        } finally {
          clearTimeout(timer)
          res.off('close', onClose)
          aiActive -= 1
        }
      })

      app.post('/api/v1/generate', async (req, res) => {
        if (!acquireAiSlot(res)) return
        const body = (req.body ?? {}) as Parameters<typeof runGenerate>[0] & {
          scriptTimeout?: unknown
          exportTimeout?: unknown
        }
        const scriptTimeoutMs =
          typeof body.scriptTimeout === 'number' && Number.isFinite(body.scriptTimeout)
            ? Math.min(Math.max(1, body.scriptTimeout), 1_800_000)
            : 600_000
        const exportTimeoutMs =
          typeof body.exportTimeout === 'number' && Number.isFinite(body.exportTimeout)
            ? Math.min(Math.max(1, body.exportTimeout), 2_147_483_647)
            : 1_800_000

        const controller = new AbortController()
        const timer = setTimeout(
          () => controller.abort(new Error(`AI timeout after ${scriptTimeoutMs}ms`)),
          scriptTimeoutMs
        )
        const onClose = (): void => {
          if (!res.writableEnded) controller.abort(new Error('client disconnected'))
        }
        res.on('close', onClose)

        let generated: GenerateStoryResult | null = null
        try {
          generated = await runGenerate(body, controller.signal)
          // 生成阶段结束：脚本超时闸不再适用于渲染阶段
          clearTimeout(timer)
          const scriptPath = writeScript(generated.story)
          const exported = await apiServer.exportStory(
            generated.story,
            exportTimeoutMs,
            controller.signal
          )
          res.json({
            ...exported,
            success: true,
            message: 'Story generated and video exported successfully',
            story: generated.story,
            meta: generated.meta,
            scriptPath
          })
        } catch (error) {
          if (generated) {
            res.status(500).json({
              success: false,
              message: error instanceof Error ? error.message : String(error),
              story: generated.story,
              meta: generated.meta
            })
          } else if (controller.signal.aborted && !res.writableEnded) {
            res.status(504).json({ success: false, message: 'AI script generation timed out' })
          } else {
            errorResponse(res, error)
          }
        } finally {
          clearTimeout(timer)
          res.off('close', onClose)
          aiActive -= 1
        }
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
        timings: result.timings,
        diagnostics: result.diagnostics
      })
    } else {
      apiServer.rejectExport(taskId, new Error(result.error || 'Export failed'))
    }
  }

  apiServer.setExtraHealthProvider(() => ({
    renderPool: pool.stats(),
    ttsLease: ttsLease.stats(),
    tts: {
      enabled: config.tts.enabled,
      provider: config.tts.provider,
      apiBaseUrl: config.tts.apiBaseUrl,
      emotionLabels,
      characters: config.tts.characters.length
    },
    llm: {
      enabled: llmClient.enabled,
      model: config.llm.model,
      baseUrl: config.llm.baseUrl,
      pipeline: config.llm.pipeline,
      apiKeyConfigured: Boolean(llmClient.apiKey),
      activeGenerations: aiActive,
      maxConcurrent: AI_MAX_CONCURRENT
    },
    assets: {
      source: config.assets.source,
      region: config.assets.region,
      indexBase: config.assets.indexBase,
      libraryBase: config.assets.libraryBase,
      fetching: assetFetchTask !== null
    },
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
