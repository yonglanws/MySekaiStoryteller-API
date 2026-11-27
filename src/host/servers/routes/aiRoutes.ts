import fs from 'node:fs'
import path from 'node:path'
import type express from 'express'
import type { HostConfig } from '../../config'
import type { LlmClient } from '../../ai/llm'
import {
  StoryGenerationError,
  type GenerateStoryResult,
  type StoryWriter
} from '../../ai/storyWriter'
import type { CloudCatalogService } from '../../assets/cloudCatalog'
import type { StoryData } from '../../../common/types/Story'
import type { VideoApiServer } from '../VideoApiServer'

export interface AiRoutesDeps {
  config: HostConfig
  llmClient: LlmClient
  storyWriter: StoryWriter
  useCloudCatalog: boolean
  cloudCatalog: CloudCatalogService
  maxConcurrent?: number
}

export interface AiRoutesHandle {
  getActiveCount: () => number
  getMaxConcurrent: () => number
  abortAndDrain: (timeoutMs?: number) => Promise<void>
}

interface GenerateRequestBody {
  prompt?: unknown
  mode?: unknown
  cast?: unknown
  targetMinutes?: unknown
  history?: unknown
  translateForTts?: unknown
  pipeline?: unknown
  agentic?: unknown
  directorReview?: unknown
  maxToolTurns?: unknown
  agentMaxSteps?: unknown
}

export function registerAiRoutes(
  app: express.Application,
  server: VideoApiServer,
  deps: AiRoutesDeps
): AiRoutesHandle {
  const { config, llmClient, storyWriter, useCloudCatalog, cloudCatalog } = deps
  const maxConcurrent = Math.max(
    1,
    deps.maxConcurrent ?? Math.min(4, Math.max(1, config.render.workers))
  )
  let aiActive = 0
  const activeControllers = new Set<AbortController>()

  const runGenerate = async (
    body: GenerateRequestBody,
    signal: AbortSignal
  ): Promise<GenerateStoryResult> => {
    if (!llmClient.enabled) {
      throw new StoryGenerationError('宿主未启用 LLM（llm.enabled=false）', [])
    }
    if (useCloudCatalog && !cloudCatalog.get()) {
      await cloudCatalog.waitReady({ coldTimeoutMs: 180_000, staleTimeoutMs: 2_000, signal })
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
    let pipeline: 'single' | 'staged' | 'agent' | 'hybrid' | undefined
    if (body.pipeline !== undefined) {
      if (
        body.pipeline !== 'single' &&
        body.pipeline !== 'staged' &&
        body.pipeline !== 'agent' &&
        body.pipeline !== 'hybrid'
      ) {
        throw new StoryGenerationError(
          'pipeline 必须是 "single"、"staged"、"agent" 或 "hybrid"',
          []
        )
      }
      pipeline = body.pipeline
    }
    const agentic = typeof body.agentic === 'boolean' ? body.agentic : undefined
    const rawSteps = body.maxToolTurns ?? body.agentMaxSteps
    let maxToolTurns: number | undefined
    if (rawSteps !== undefined) {
      if (
        typeof rawSteps !== 'number' ||
        !Number.isInteger(rawSteps) ||
        rawSteps < 2 ||
        rawSteps > 40
      ) {
        throw new StoryGenerationError('agentMaxSteps / maxToolTurns 必须是 2~40 的整数', [])
      }
      maxToolTurns = rawSteps
    }
    return storyWriter.generate({
      prompt: body.prompt,
      mode,
      cast,
      targetMinutes,
      history,
      translateForTts: typeof body.translateForTts === 'boolean' ? body.translateForTts : undefined,
      pipeline,
      agentic,
      directorReview: typeof body.directorReview === 'boolean' ? body.directorReview : undefined,
      maxToolTurns,
      signal
    })
  }

  const errorResponse = (res: express.Response, error: unknown): void => {
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

  const writeScript = async (story: StoryData): Promise<string> => {
    const suffix = Math.random().toString(36).slice(2, 8)
    const file = path.join(config.paths.output, `script-${Date.now()}-${suffix}.json`)
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    await fs.promises.writeFile(file, JSON.stringify(story, null, 2), 'utf-8')
    return file
  }

  const rejectIfDraining = (res: express.Response): boolean => {
    if (!server.isDraining()) return false
    res.setHeader('Retry-After', '5')
    res.status(503).json({
      success: false,
      message: 'Server is shutting down and not accepting new requests'
    })
    return true
  }

  const acquireAiSlot = (res: express.Response): boolean => {
    if (aiActive >= maxConcurrent) {
      res.status(429).json({
        success: false,
        message: `Too many concurrent AI generations (max ${maxConcurrent})`
      })
      return false
    }
    aiActive += 1
    return true
  }

  app.post('/api/v1/script/generate', async (req, res) => {
    if (rejectIfDraining(res)) return
    if (!server.enforceRateLimit(req, res)) return
    if (!acquireAiSlot(res)) return
    const body = (req.body ?? {}) as GenerateRequestBody & { timeout?: unknown }
    const timeoutMs =
      typeof body.timeout === 'number' && Number.isFinite(body.timeout)
        ? Math.min(Math.max(1, body.timeout), 1_800_000)
        : 600_000
    const controller = new AbortController()
    activeControllers.add(controller)
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
      const scriptPath = await writeScript(result.story)
      res.json({ success: true, story: result.story, meta: result.meta, scriptPath })
    } catch (error) {
      if (controller.signal.aborted && !res.writableEnded) {
        if (server.isDraining()) {
          res.status(503).json({
            success: false,
            message: 'Server is shutting down'
          })
        } else {
          res.status(504).json({ success: false, message: 'AI script generation timed out' })
        }
      } else {
        errorResponse(res, error)
      }
    } finally {
      clearTimeout(timer)
      res.off('close', onClose)
      activeControllers.delete(controller)
      aiActive -= 1
    }
  })

  app.post('/api/v1/generate', async (req, res) => {
    if (rejectIfDraining(res)) return
    if (!server.enforceRateLimit(req, res)) return
    const body = (req.body ?? {}) as GenerateRequestBody & {
      scriptTimeout?: unknown
      exportTimeout?: unknown
    }
    if (
      body.exportTimeout !== undefined &&
      (typeof body.exportTimeout !== 'number' ||
        !Number.isInteger(body.exportTimeout) ||
        body.exportTimeout < 1 ||
        body.exportTimeout > 2_147_483_647)
    ) {
      res.status(400).json({
        success: false,
        message: 'Invalid exportTimeout: expected an integer between 1 and 2147483647 milliseconds.'
      })
      return
    }
    if (!acquireAiSlot(res)) return
    const scriptTimeoutMs =
      typeof body.scriptTimeout === 'number' && Number.isFinite(body.scriptTimeout)
        ? Math.min(Math.max(1, body.scriptTimeout), 1_800_000)
        : 600_000
    const exportTimeoutMs = typeof body.exportTimeout === 'number' ? body.exportTimeout : 1_800_000

    const controller = new AbortController()
    activeControllers.add(controller)
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
      const scriptPath = await writeScript(generated.story)
      const exported = await server.exportStory(generated.story, exportTimeoutMs, controller.signal)
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
        if (!res.writableEnded) {
          res.status(500).json({
            success: false,
            message: server.redactPaths(error instanceof Error ? error.message : String(error)),
            story: generated.story,
            meta: generated.meta
          })
        }
      } else if (controller.signal.aborted && !res.writableEnded) {
        if (server.isDraining()) {
          res.status(503).json({
            success: false,
            message: 'Server is shutting down'
          })
        } else {
          res.status(504).json({ success: false, message: 'AI script generation timed out' })
        }
      } else {
        errorResponse(res, error)
      }
    } finally {
      clearTimeout(timer)
      res.off('close', onClose)
      activeControllers.delete(controller)
      aiActive -= 1
    }
  })

  return {
    getActiveCount: () => aiActive,
    getMaxConcurrent: () => maxConcurrent,
    abortAndDrain: async (timeoutMs = 15_000): Promise<void> => {
      for (const controller of activeControllers) {
        if (!controller.signal.aborted) {
          controller.abort(new Error('Server is shutting down'))
        }
      }
      const deadline = Date.now() + Math.max(0, timeoutMs)
      while (aiActive > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  }
}
