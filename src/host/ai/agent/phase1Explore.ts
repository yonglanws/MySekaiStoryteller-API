import type { ILogObj, Logger } from 'tslog'
import type { StoryData } from '../../../common/types/Story'
import type { AdaptiveRagRetriever } from '../../rag/retriever'
import { extractJson, LlmClient, LlmError, type ChatMessage, type ChatUsage } from '../llm'
import * as personasMod from '../personas'
import type { CatalogView } from '../prompt'
import { normalizeCastPlan, type StagedCastPlan } from '../staged'
import { addUsage } from './actingSemantics'
import { createStoryAgentToolkit, type DirectorReviewRecord } from './toolkit'

export interface AgenticGenerationOptions {
  llm: LlmClient
  view: CatalogView
  personas: personasMod.PersonaEntry[]
  scene: string
  targetMinutes: number
  emotionLabels?: string[]
  systemPrompt?: string
  ragRetriever?: AdaptiveRagRetriever | null
  logger: Logger<ILogObj>
  maxToolTurns?: number
  directorReview?: boolean
  signal?: AbortSignal
}

export interface AgenticGenerationResult {
  story: StoryData
  title?: string
  warnings: string[]
  rounds: number
  latencyMs: number
  model: string
  usage: ChatUsage | null
  toolCallsUsed: string[]
  modeUsed: 'native' | 'react-json' | 'staged-fallback'
  directorReview?: DirectorReviewRecord
}

export interface Phase1ExploreOptions {
  llm: LlmClient
  view: CatalogView
  personas: personasMod.PersonaEntry[]
  scene: string
  targetMinutes: number
  emotionLabels?: string[]
  ragRetriever?: AdaptiveRagRetriever | null
  logger: Logger<ILogObj>
  maxToolTurns?: number
  signal?: AbortSignal
}

export interface Phase1ExploreStage {
  stage: string
  model: string
  latencyMs: number
  usage: ChatUsage | null
  ok: boolean
  note?: string
}

export interface Phase1ExploreResult {
  researchBrief: string
  preBuiltPlan: StagedCastPlan | null
  toolCallsUsed: string[]
  modeUsed: 'native' | 'react-json' | 'staged-fallback'
  agentSteps: number
  stages: Phase1ExploreStage[]
  usage: ChatUsage | null
  latencyMs: number
}

const PHASE1_EXPLORE_TOOLS = new Set([
  'lookup_character',
  'search_official_corpus',
  'search_assets'
])

/**
 * 统一三段式流水线 Phase 1：精简只读探索与规划锁定（lookup_character / search_official_corpus / search_assets）。
 * 支持原生 function calling 与 ReAct JSON 信封自动切换，不支持或非中止异常时优雅降级至 staged-fallback。
 * 所有工具对话消息严格局限在本函数作用域内，绝不带入 Phase 2 纯对白上下文。
 */
export async function runPhase1Exploration(
  options: Phase1ExploreOptions
): Promise<Phase1ExploreResult> {
  const {
    llm,
    view,
    personas,
    scene,
    targetMinutes,
    emotionLabels = [],
    ragRetriever = null,
    logger,
    signal
  } = options

  const toolkit = createStoryAgentToolkit({
    view,
    personas,
    emotionLabels,
    targetMinutes,
    ragRetriever,
    logger
  })
  const definitions = toolkit.definitions.filter((d) => PHASE1_EXPLORE_TOOLS.has(d.function.name))
  const toolCallsUsed: string[] = []
  const stages: Phase1ExploreStage[] = []
  const totalUsage: ChatUsage = {}
  let hasUsage = false
  let latencyMs = 0
  let agentSteps = 0
  const findings: string[] = []
  let synthesizedBrief = ''
  let preBuiltPlan: StagedCastPlan | null = null

  if (!llm.enabled) {
    return {
      researchBrief: '',
      preBuiltPlan: null,
      toolCallsUsed,
      modeUsed: 'staged-fallback',
      agentSteps: 0,
      stages,
      usage: null,
      latencyMs: 0
    }
  }

  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Aborted')
  }

  const castSummary = view
    .primaryModels()
    .slice(0, 28)
    .map((m) => `${view.shortName(m)}(modelId=${m.id}${m.unit ? `,${m.unit}` : ''})`)
    .join('、')
  const maxTurns = Math.min(4, Math.max(2, options.maxToolTurns ?? 4))

  const baseSystemPrompt = [
    '你是 Project SEKAI 剧情前期调研 Agent（hybrid 探索阶段 / 统一只读资料核实，不写台词正文，不写 Live2D 片段）。',
    '请在 1~3 轮内调用 lookup_character、search_official_corpus（含 mode:"search"、"expand" 与 "list_stories"）和 search_assets（核实云端服装/背景/BGM/SE），最后用简洁 JSON 总结研究简报：',
    '{"researchBrief":"角色记忆、关系边界、官方事件与云端素材核实结论","recommendedAssets":{"background":"...","bgm":"...","outfits":{...}},"optionalPlan":{可选 cast/scenes/understanding}}'
  ].join('\n')
  const userContent = `场景要求：${scene}\n可选角色摘要：${castSummary}\n请核实出场角色记忆与人设边界、近期官方事件与精确云端素材 ID，输出研究简报 JSON。`

  const tryParseExploreBrief = (rawContent: string): void => {
    try {
      const parsed = extractJson(rawContent)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      const rec = parsed as Record<string, unknown>
      if (typeof rec.researchBrief === 'string' && rec.researchBrief.trim()) {
        synthesizedBrief = rec.researchBrief.trim()
      } else if (typeof rec.summary === 'string' && rec.summary.trim()) {
        synthesizedBrief = rec.summary.trim()
      }
      const planCandidate = rec.optionalPlan ?? rec.plan ?? (Array.isArray(rec.cast) ? rec : null)
      if (planCandidate && typeof planCandidate === 'object') {
        const normalized = normalizeCastPlan(planCandidate, view, {
          scene,
          personas,
          targetMinutes
        })
        if (normalized && normalized.cast.length > 0) {
          preBuiltPlan = normalized
        }
      }
    } catch {
      // 非 JSON 总结则忽略，回退已收集工具摘要或常规 Stage 1
    }
  }

  const summarizeToolOutput = (toolName: string, output: string): void => {
    try {
      const parsed = JSON.parse(output) as Record<string, unknown>
      if (toolName === 'lookup_character' && Array.isArray(parsed.characters)) {
        const names = parsed.characters
          .map((c) => {
            const r = c as Record<string, unknown>
            return `${String(r.shortName ?? r.name ?? '')}(id=${String(r.modelId ?? '')})`
          })
          .filter(Boolean)
        if (names.length > 0) findings.push(`核实角色：${names.join('、')}`)
      } else if (toolName === 'search_assets') {
        const bgs = Array.isArray(parsed.backgrounds)
          ? parsed.backgrounds
              .slice(0, 3)
              .map((b) => String((b as Record<string, unknown>).name ?? ''))
          : []
        const bgms = Array.isArray(parsed.bgm)
          ? parsed.bgm.slice(0, 3).map((b) => String((b as Record<string, unknown>).name ?? ''))
          : []
        if (bgs.length > 0 || bgms.length > 0) {
          findings.push(`核实云端素材：背景[${bgs.join('/')}] BGM[${bgms.join('/')}]`)
        }
      } else if (toolName === 'search_official_corpus') {
        const stories = Array.isArray(parsed.availableStories)
          ? parsed.availableStories
              .slice(0, 3)
              .map((s) => String((s as Record<string, unknown>).story ?? ''))
          : []
        const expanded =
          parsed.context && typeof parsed.context === 'object'
            ? String((parsed.context as Record<string, unknown>).text ?? '').slice(0, 420)
            : ''
        if (stories.length > 0) findings.push(`官方参考活动：${stories.join('、')}`)
        if (expanded) findings.push(`官方上下文展开：\n${expanded}`)
      }
    } catch {
      // 忽略摘要解析错误
    }
  }

  const tryExtractEnvelopeToolCall = (
    rawContent: string
  ): { name: string; arguments: unknown } | null => {
    try {
      const val = extractJson(rawContent)
      if (!val || typeof val !== 'object' || Array.isArray(val)) return null
      const rec = val as Record<string, unknown>
      if (rec.tool_call && typeof rec.tool_call === 'object') {
        const tc = rec.tool_call as Record<string, unknown>
        const fnName = typeof tc.name === 'string' ? tc.name.trim() : ''
        if (fnName && PHASE1_EXPLORE_TOOLS.has(fnName)) {
          return { name: fnName, arguments: tc.arguments }
        }
      }
    } catch {
      return null
    }
    return null
  }

  const recordUsage = (delta: ChatUsage | null): void => {
    if (!delta) return
    hasUsage = true
    addUsage(totalUsage, delta)
  }

  let modeUsed: Phase1ExploreResult['modeUsed'] = 'native'
  let switchToReact = false

  // ---- Mode 1: 原生 function calling ---------------------------------------------------
  const nativeMessages: ChatMessage[] = [
    { role: 'system', content: baseSystemPrompt },
    { role: 'user', content: userContent }
  ]

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('Aborted')
      }
      const isLast = turn === maxTurns - 1
      const res = await llm.chat(
        isLast
          ? [
              ...nativeMessages,
              {
                role: 'user',
                content:
                  '请立即综合已获取信息输出研究简报 JSON（含 researchBrief 与可选 recommendedAssets / optionalPlan），不要再调用工具。'
              }
            ]
          : nativeMessages,
        isLast
          ? { json: true, temperature: 0.3, signal }
          : { tools: definitions, toolChoice: 'auto', temperature: 0.3, signal }
      )
      agentSteps += 1
      stages.push({
        stage: 'hybrid-explore',
        model: res.model,
        latencyMs: res.latencyMs,
        usage: res.usage,
        ok: true
      })
      latencyMs += res.latencyMs
      recordUsage(res.usage)

      const calls = (res.toolCalls ?? []).filter((c) => PHASE1_EXPLORE_TOOLS.has(c.function.name))
      if (calls.length > 0) {
        nativeMessages.push({
          role: 'assistant',
          content: res.content || null,
          tool_calls: calls
        })
        for (const call of calls) {
          toolCallsUsed.push(call.function.name)
          const out = await toolkit.execute(call.function.name, call.function.arguments, signal)
          summarizeToolOutput(call.function.name, out)
          nativeMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: out
          })
        }
        continue
      }

      if (!isLast) {
        const inlineCall = tryExtractEnvelopeToolCall(res.content)
        if (inlineCall) {
          toolCallsUsed.push(inlineCall.name)
          const out = await toolkit.execute(inlineCall.name, inlineCall.arguments, signal)
          summarizeToolOutput(inlineCall.name, out)
          nativeMessages.push({ role: 'assistant', content: res.content.slice(0, 8000) })
          nativeMessages.push({
            role: 'user',
            content: `工具 ${inlineCall.name} 返回结果：\n${out}\n\n请继续调研或输出研究简报 JSON。`
          })
          continue
        }
      }

      tryParseExploreBrief(res.content)
      break
    }
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof LlmError && error.toolCallingUnsupported) {
      logger.info('[AI] Phase 1 不支持原生 tool calling，切换至 ReAct JSON 工具探索')
      switchToReact = true
    } else {
      const note = `探索预检降级：${error instanceof Error ? error.message : String(error)}`
      logger.warn(`[AI] ${note}`)
      modeUsed = 'staged-fallback'
      stages.push({
        stage: 'hybrid-explore',
        model: llm.model,
        latencyMs: 0,
        usage: null,
        ok: false,
        note
      })
    }
  }

  // ---- Mode 2: ReAct JSON 工具信封回退 -------------------------------------------------
  if (switchToReact) {
    modeUsed = 'react-json'
    const toolCatalogText = definitions
      .map(
        (def) =>
          `- ${def.function.name}: ${def.function.description} 参数: ${JSON.stringify(def.function.parameters)}`
      )
      .join('\n')
    const reactMessages: ChatMessage[] = [
      {
        role: 'system',
        content: [
          baseSystemPrompt,
          '',
          '## 可用只读工具（ReAct JSON 协议）',
          toolCatalogText,
          '每一轮只输出一个合法 JSON 对象：',
          '- 需要调研时输出：{"tool_call":{"name":"工具名","arguments":{...}}}',
          '- 调研完成时输出：{"researchBrief":"...","recommendedAssets":{...},"optionalPlan":{...}}'
        ].join('\n')
      },
      { role: 'user', content: userContent }
    ]

    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new Error('Aborted')
        }
        const isLast = turn === maxTurns - 1
        const res = await llm.chat(
          isLast
            ? [
                ...reactMessages,
                {
                  role: 'user',
                  content:
                    '请立即综合已获取信息输出研究简报 JSON（含 researchBrief 与可选 recommendedAssets / optionalPlan），不要再输出 tool_call。'
                }
              ]
            : reactMessages,
          { json: true, temperature: 0.3, signal }
        )
        agentSteps += 1
        stages.push({
          stage: 'hybrid-explore',
          model: res.model,
          latencyMs: res.latencyMs,
          usage: res.usage,
          ok: true
        })
        latencyMs += res.latencyMs
        recordUsage(res.usage)

        if (!isLast) {
          const inlineCall = tryExtractEnvelopeToolCall(res.content)
          if (inlineCall) {
            toolCallsUsed.push(inlineCall.name)
            const out = await toolkit.execute(inlineCall.name, inlineCall.arguments, signal)
            summarizeToolOutput(inlineCall.name, out)
            reactMessages.push({ role: 'assistant', content: res.content.slice(0, 8000) })
            reactMessages.push({
              role: 'user',
              content: `工具 ${inlineCall.name} 返回结果：\n${out}\n\n请继续调研或输出研究简报 JSON。`
            })
            continue
          }
        }

        tryParseExploreBrief(res.content)
        break
      }
    } catch (error) {
      if (signal?.aborted) throw error
      const note = `ReAct 探索降级至直接工作流：${error instanceof Error ? error.message : String(error)}`
      logger.warn(`[AI] ${note}`)
      modeUsed = 'staged-fallback'
      stages.push({
        stage: 'hybrid-explore',
        model: llm.model,
        latencyMs: 0,
        usage: null,
        ok: false,
        note
      })
    }
  }

  const researchBrief = [synthesizedBrief, ...findings].filter(Boolean).join('\n').slice(0, 2200)

  return {
    researchBrief,
    preBuiltPlan,
    toolCallsUsed,
    modeUsed,
    agentSteps,
    stages,
    usage: hasUsage ? totalUsage : null,
    latencyMs
  }
}

/**
 * 向后兼容导出入口：直接委托至统一三段式上下文隔离 + 工具驱动流水线（pipeline: 'agent'）。
 */
export async function runAgenticStoryGeneration(
  options: AgenticGenerationOptions
): Promise<AgenticGenerationResult> {
  const { StoryWriter } = await import('../storyWriter')
  const catalogData = {
    models: options.view.models,
    images: options.view.images,
    imageDetails: options.view.imageDetails,
    voices: [],
    bgm: [],
    bgmDetails: options.view.bgmDetails,
    seDetails: options.view.seDetails,
    ...(options.view.cloudOnly ? { cloudOnly: true } : {})
  }
  const stubCatalog = {
    get: () => catalogData
  } as unknown as import('../../resources/resourceCatalog').ResourceCatalog
  const settings = {
    enabled: options.llm.enabled,
    baseUrl: '',
    apiKeyEnv: '',
    model: options.llm.model,
    temperature: 0.85,
    maxTokens: 8192,
    timeoutMs: 120_000,
    retries: 0,
    repairRounds: 1,
    pipeline: 'agent' as const,
    agentMaxSteps: options.maxToolTurns ?? 4,
    jsonMode: 'auto' as const,
    translateForTts: false,
    polishDialogue: false,
    targetMinutes: options.targetMinutes,
    systemPrompt: options.systemPrompt ?? '',
    extraBody: {},
    personaDirs: [],
    personas: [],
    rag: {
      enabled: Boolean(options.ragRetriever),
      baseUrl: '',
      apiKeyEnv: '',
      model: '',
      dimensions: 0,
      queryInstruct: '',
      timeoutMs: 30_000,
      batchSize: 32,
      cacheDir: '',
      fallbackLexical: true,
      sekaiStorySearchUrl: '',
      server: 'cn' as const,
      localDirs: [],
      includePersonas: true,
      rerank: {
        enabled: false,
        model: '',
        baseUrl: '',
        apiKeyEnv: '',
        endpointPath: '/rerank',
        candidatePool: 32,
        topN: 32,
        timeoutMs: 30_000,
        instruction: ''
      },
      adaptive: {
        minScore: 0.42,
        highScore: 0.62,
        relativeDropRatio: 0.78,
        elbowDropDelta: 0.065,
        minChunks: 0,
        maxChunks: 12,
        softCharBudget: 1800,
        maxCharBudget: 4800,
        maxPerStory: 2,
        mergeAdjacentGap: 4,
        expandAdjacentContext: true
      }
    }
  }
  const writer = new StoryWriter(
    options.llm,
    settings,
    stubCatalog,
    options.logger,
    options.emotionLabels ?? [],
    options.ragRetriever ?? null
  )
  const result = await writer.generateFromView(
    {
      prompt: options.scene,
      targetMinutes: options.targetMinutes,
      pipeline: 'agent',
      translateForTts: false,
      maxToolTurns: options.maxToolTurns,
      directorReview: options.directorReview,
      signal: options.signal
    },
    options.view,
    options.personas
  )
  return {
    story: result.story,
    ...(result.meta.title ? { title: result.meta.title } : {}),
    warnings: result.meta.warnings,
    rounds: result.meta.rounds,
    latencyMs: result.meta.latencyMs,
    model: result.meta.model,
    usage: result.meta.usage,
    toolCallsUsed: result.meta.toolCalls ?? [],
    modeUsed: result.meta.agentMode ?? 'native',
    ...(result.meta.directorReview ? { directorReview: result.meta.directorReview } : {})
  }
}
