import { ILogObj, Logger } from 'tslog'
import type { LlmSettings } from '../config'
import type { CatalogModel, ResourceCatalog } from '../resources/resourceCatalog'
import type { StoryData } from '../../common/types/Story'
import { extractJson, LlmClient, type ChatMessage, type ChatResult, type ChatUsage } from './llm'
import { loadPersonas, type PersonaEntry } from './personas'
import { buildChatPrompt, buildStoryPrompt, CatalogView } from './prompt'
import {
  applyDialoguePolish,
  applyDirectorReviewPatches,
  applyVoiceDirectionPlan,
  buildCastPrompt,
  buildDialoguePrompt,
  buildDialoguePolishPrompt,
  buildDialogueRepairPrompt,
  buildDialogueLengthPrompt,
  buildDirectionPrompt,
  buildDirectionRepairPrompt,
  buildDirectorReviewPrompt,
  buildEmotionPrompt,
  buildEmotionRepairPrompt,
  buildQuickCastPrompt,
  buildStagingPrompt,
  composeStory,
  condenseDialogue,
  countDialogueChars,
  countEmotionRuns,
  fallbackCastPlan,
  fallbackDirection,
  fallbackStaging,
  normalizeCastPlan,
  normalizeDialogue,
  normalizeDirection,
  normalizeDirectorReviewResult,
  normalizeVoiceDirectionPlan,
  normalizeStaging,
  softenPunctuation,
  type LlmPipeline,
  type StagedCastPlan,
  type StagedDialogue,
  type StagedDirection,
  type StagedMessages,
  type StagedPairwiseAddress,
  type StagedPromptOptions,
  type StagedStaging,
  type StagedVoiceDirectionLine
} from './staged'
import { validateAndFixStory, type ValidationResult } from './validate'
import { lintDialogueFidelity, repairSpokenStageDirections } from './dialogueLinter'
import { runAgenticStoryGeneration, type DirectorReviewRecord } from './agentTools'
import {
  sanitizeIrodoriCaption
} from '../../common/tts/irodori'
import {
  alignStoryTtsEmotionsAndCaptions,
  ensureJapaneseTtsText,
  type TtsBatchTranslator,
  type TtsTranslationItem
} from './ttsText'
import { EmbeddingClient, resolveEmbeddingConfig } from '../rag/embeddingClient'
import { RerankClient, resolveRerankConfig } from '../rag/rerankClient'
import { AdaptiveRagRetriever } from '../rag/retriever'
import { loadStoryCorpus } from '../rag/storyCorpus'
import type { RagMetaSummary, RagRetrieveResult } from '../rag/types'

export type StoryMode = 'story' | 'chat'

export interface StoryHistoryMessage {
  role: string
  content: string
}

export interface GenerateStoryOptions {
  prompt: string
  mode?: StoryMode
  /** 限定可选角色：角色名、简称、id 或模型 id 片段 */
  cast?: string[]
  targetMinutes?: number
  history?: StoryHistoryMessage[]
  translateForTts?: boolean
  /** 覆盖 llm.pipeline；chat 模式始终 single */
  pipeline?: LlmPipeline
  /** 启用工具调用 Agentic Harness（不设时仅在 pipeline === 'agent' 启用） */
  agentic?: boolean
  /** Agentic 模式最大工具调用/迭代轮次（默认沿用 llm.agentMaxSteps） */
  maxToolTurns?: number
  /** 是否在 staged 流水线成稿后执行导演终审（缺省时仅在 polishDialogue=true 且台词>=12句时自动启用） */
  directorReview?: boolean
  signal?: AbortSignal
}

export interface StoryStageMeta {
  stage: string
  model: string
  latencyMs: number
  usage: ChatUsage | null
  ok: boolean
  note?: string
}

export interface GenerateStoryMeta {
  mode: StoryMode
  pipeline: LlmPipeline
  title?: string
  model: string
  /** 单段：实际生成轮数；三段：LLM 调用次数（含修复） */
  rounds: number
  warnings: string[]
  usage: ChatUsage | null
  /** 各次 LLM 调用耗时之和；情绪/表演/翻译并行时会大于墙钟 */
  latencyMs: number
  /** 生成墙钟耗时（含翻译），毫秒 */
  durationMs: number
  ttsTranslated: number
  cast: string[]
  stages?: StoryStageMeta[]
  /** 自适应语义 RAG 检索诊断摘要（仅启用 RAG 时出现） */
  rag?: RagMetaSummary
  /** Agentic 模式下调用的工具名称与运行模式（native / react-json / staged-fallback） */
  toolCalls?: string[]
  agentMode?: 'native' | 'react-json' | 'staged-fallback'
  agentSteps?: number
  /** 导演终审评估与修补摘要（agent 或 staged 启用导演终审时产出） */
  directorReview?: DirectorReviewRecord
}

export interface GenerateStoryResult {
  story: StoryData
  meta: GenerateStoryMeta
}

export class StoryGenerationError extends Error {
  readonly details: string[]
  readonly raw: string | null

  constructor(message: string, details: string[], raw: string | null = null) {
    super(message)
    this.name = 'StoryGenerationError'
    this.details = details
    this.raw = raw
  }
}

const REPAIR_HINT = `上一次输出无法使用：{error}

请只输出修复后的完整 JSON（仅含 models、images、snippets），保留原有剧情、台词与表演，不要解释，不要 markdown。
注意：角色必须在 LayoutAppear 之后才能说话/表演；Normal 模式同屏最多 2 人（Left/Right），Three 模式同屏最多 3 人（Left/Center/Right），同槽位不能重叠两人。`

function filterByCast(view: CatalogView, cast: string[] | undefined): CatalogView {
  if (!cast || cast.length === 0) return view
  const tokens = cast.map((token) => token.trim().toLowerCase()).filter(Boolean)
  const matched = view.models.filter((model) =>
    tokens.some((token) => {
      const name = model.name.toLowerCase()
      const shortName = (model.shortName ?? '').toLowerCase()
      const cloudId = (model.cloudId ?? '').toLowerCase()
      const numeric = /^\d+$/.test(token)
      return (
        String(model.id) === token ||
        name === token ||
        shortName === token ||
        (cloudId !== '' && cloudId === token) ||
        // 数字 token 只做精确 id 匹配；否则 cast ["1"] 会把 10~19 也一起选中
        (!numeric &&
          (String(model.id).toLowerCase().includes(token) ||
            model.path.toLowerCase().includes(token) ||
            (cloudId !== '' && cloudId.includes(token))))
      )
    })
  )
  if (matched.length === 0) {
    throw new StoryGenerationError(`cast 无法匹配任何角色：${cast.join(', ')}`, [
      `可用角色：${view
        .primaryModels()
        .map((model) => `${model.name}(${model.id})`)
        .join('、')}`
    ])
  }
  return view.withModels(matched)
}

function mergeUsage(total: ChatUsage | null, next: ChatUsage | null): ChatUsage | null {
  if (!total) return next
  if (!next) return total
  return {
    promptTokens: (total.promptTokens ?? 0) + (next.promptTokens ?? 0),
    completionTokens: (total.completionTokens ?? 0) + (next.completionTokens ?? 0),
    totalTokens: (total.totalTokens ?? 0) + (next.totalTokens ?? 0)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 宿主内置 AI 剧本生成：提示词 → LLM → 校验/修复 → （可选）ttsText 翻译。
 *
 * `pipeline: staged`（默认）分三段：选角与大纲、只写台词、只设计表演；
 * `pipeline: single` 保持一次调用直接产出完整剧本。两条路径共用同一套
 * 资源目录、舞台校验和 TTS 翻译。
 */
export class StoryWriter {
  private readonly llm: LlmClient
  private readonly settings: LlmSettings
  private readonly catalog: ResourceCatalog
  private readonly logger: Logger<ILogObj>
  private readonly emotionLabels: string[]
  private personas: PersonaEntry[] | null = null
  private ragRetriever: AdaptiveRagRetriever | null | undefined

  constructor(
    llm: LlmClient,
    settings: LlmSettings,
    catalog: ResourceCatalog,
    logger: Logger<ILogObj>,
    emotionLabels: string[] = [],
    ragRetriever?: AdaptiveRagRetriever | null
  ) {
    this.llm = llm
    this.settings = settings
    this.catalog = catalog
    this.logger = logger
    this.emotionLabels = emotionLabels.map((label) => label.trim()).filter(Boolean)
    this.ragRetriever = ragRetriever
  }

  private getPersonas(): PersonaEntry[] {
    if (!this.personas) this.personas = loadPersonas(this.settings)
    return this.personas
  }

  private getRagRetriever(): AdaptiveRagRetriever | null {
    if (this.ragRetriever !== undefined) return this.ragRetriever
    const rag = this.settings.rag
    if (!rag?.enabled) {
      this.ragRetriever = null
      return null
    }
    const chunks = loadStoryCorpus({
      localDirs: rag.localDirs,
      personas: rag.includePersonas ? this.getPersonas() : [],
      includePersonas: rag.includePersonas
    })
    if (chunks.length === 0) {
      this.ragRetriever = null
      return null
    }
    const embedConfig = resolveEmbeddingConfig(this.settings)
    const embeddingClient = embedConfig.enabled
      ? new EmbeddingClient(embedConfig, this.logger)
      : null
    const rerankConfig = resolveRerankConfig(this.settings)
    const rerankClient = rerankConfig.enabled ? new RerankClient(rerankConfig, this.logger) : null
    this.ragRetriever = new AdaptiveRagRetriever({
      chunks,
      settings: rag,
      embeddingClient,
      rerankClient,
      logger: this.logger
    })
    return this.ragRetriever
  }

  private summarizeRag(result: RagRetrieveResult | null): RagMetaSummary | undefined {
    if (!result || result.mode === 'disabled') return undefined
    return {
      domain: result.domain ?? 'pjsk',
      mode: result.mode,
      model: result.model,
      rerankMode: result.rerankMode ?? 'disabled',
      rerankModel: result.rerankModel ?? '',
      rerankLatencyMs: result.rerankLatencyMs ?? 0,
      expandedCount: result.expandedCount ?? 0,
      selectedCount: result.selectedCount,
      totalChars: result.totalChars,
      topScore: result.topScore,
      latencyMs: result.latencyMs
    }
  }

  /**
   * single/chat 的前置快速选角：从全角色池缩到与场景相关的子集（chat 最多 2 人，story 最多 4 人）。
   *
   * 顺序：场景点名 → 沿用上一轮角色 → 一次很短的选角调用；失败保留全目录。
   * 这样主提示词只带入选角色的紧凑人设，而不是 26 份完整人设。
   */
  private async resolveFastCast(
    view: CatalogView,
    prompt: string,
    options: GenerateStoryOptions
  ): Promise<CatalogView> {
    const primary = view.primaryModels()
    if (primary.length <= 2) {
      const picked = primary.map((m) => view.resolveOutfitVariant(m, prompt) ?? m)
      return view.withModels(picked)
    }
    const maxFastCast = (options.mode ?? 'story') === 'chat' ? 2 : 4

    const mentioned = primary.filter((model) => {
      const fullName = model.name
      const shortName = model.shortName ?? ''
      return (
        (fullName.length > 0 && prompt.includes(fullName)) ||
        (shortName.length >= 2 && prompt.includes(shortName))
      )
    })
    if (mentioned.length > 0) {
      const picked = mentioned
        .slice(0, maxFastCast)
        .map((m) => view.resolveOutfitVariant(m, prompt) ?? m)
      this.logger.info(
        `[AI] 场景点名角色：${picked.map((model) => view.shortName(model)).join('、')}`
      )
      return view.withModels(picked)
    }

    const history = options.history ?? []
    for (let index = history.length - 1; index >= 0; index--) {
      const role = history[index]?.role ?? ''
      if (!role || ['user', 'assistant', 'system', '用户', '助手'].includes(role)) continue
      const model = primary.find((item) => item.name === role || (item.shortName ?? '') === role)
      if (model) {
        const chosen = view.resolveOutfitVariant(model, prompt) ?? model
        this.logger.info(`[AI] 沿用上一轮角色：${view.shortName(chosen)}`)
        return view.withModels([chosen])
      }
    }

    if (!this.llm.enabled) return view.withModels(primary)
    try {
      const messages = buildQuickCastPrompt(view, {
        scene: prompt,
        personas: this.getPersonas(),
        history
      })
      const { data } = await this.llm.chatJson<Record<string, unknown> | unknown[]>(
        [
          { role: 'system', content: messages.system },
          { role: 'user', content: messages.user }
        ],
        { temperature: 0.2, signal: options.signal }
      )
      const castField = Array.isArray(data) ? undefined : (data as Record<string, unknown>).cast
      const raw = Array.isArray(data)
        ? data
        : Array.isArray(castField)
          ? castField
          : castField != null
            ? [castField]
            : []
      const cast: CatalogModel[] = []
      for (const item of raw) {
        const text = String(item ?? '').trim()
        const model = /^\d+$/.test(text)
          ? view.modelById(Number(text))
          : (primary.find((entry) => entry.name === text || (entry.shortName ?? '') === text) ??
            view.models.find((entry) => (entry.cloudId ?? '') === text) ??
            null)
        if (model) {
          const resolved = /^\d+$/.test(text)
            ? model
            : (view.resolveOutfitVariant(model, prompt) ?? model)
          if (!cast.includes(resolved)) cast.push(resolved)
        }
      }
      if (cast.length > 0) {
        this.logger.info(
          `[AI] 快速选角：${cast
            .slice(0, maxFastCast)
            .map((model) => view.shortName(model))
            .join('、')}`
        )
        return view.withModels(cast.slice(0, maxFastCast))
      }
    } catch (error) {
      if (options.signal?.aborted) throw error
      this.logger.warn(`[AI] 快速选角失败，保留完整角色池：${errorMessage(error)}`)
    }
    return view.withModels(primary)
  }

  async generate(options: GenerateStoryOptions): Promise<GenerateStoryResult> {
    const startedAt = Date.now()
    const prompt = options.prompt?.trim()
    if (!prompt) throw new StoryGenerationError('场景描述不能为空', [])

    const mode = options.mode ?? 'story'
    const data = this.catalog.get()
    let view = filterByCast(new CatalogView(data), options.cast)
    const personas = this.getPersonas()
    const targetMinutes = options.targetMinutes ?? this.settings.targetMinutes
    const pipeline: LlmPipeline =
      mode === 'chat'
        ? 'single'
        : options.agentic === true
          ? 'agent'
          : (options.pipeline ?? this.settings.pipeline ?? 'single')

    // staged 自带选角段；single/chat 先做一次很短的选角，避免主提示词装入全部人设。
    if (mode === 'chat' || pipeline === 'single') {
      view = await this.resolveFastCast(view, prompt, options)
    }

    const result =
      pipeline === 'agent'
        ? await this.generateAgentic({ prompt, view, personas, targetMinutes, options })
        : pipeline === 'staged'
          ? await this.generateStaged({ prompt, view, personas, targetMinutes, options })
          : await this.generateSingle({ mode, prompt, view, personas, targetMinutes, options })
    result.meta.durationMs = Date.now() - startedAt
    return result
  }

  private async generateSingle(args: {
    mode: StoryMode
    prompt: string
    view: CatalogView
    personas: PersonaEntry[]
    targetMinutes: number
    options: GenerateStoryOptions
  }): Promise<GenerateStoryResult> {
    const { mode, prompt, view, personas, targetMinutes, options } = args
    let singleRag: RagRetrieveResult | null = null
    const retriever = this.getRagRetriever()
    if (retriever) {
      try {
        singleRag = await retriever.retrieve({
          prompt,
          stage: 'single',
          cast: view.models.map((m) => ({
            name: view.shortName(m),
            fullName: m.name
          })),
          signal: options.signal
        })
      } catch (error) {
        if (options.signal?.aborted) throw error
        this.logger.warn(`[RAG] single 检索失败，跳过参考注入：${errorMessage(error)}`)
      }
    }
    const built =
      mode === 'chat'
        ? buildChatPrompt(view, {
            scene: prompt,
            personas,
            targetMinutes,
            systemPrompt: this.settings.systemPrompt,
            history: options.history,
            emotionLabels: this.emotionLabels,
            ragContext: singleRag?.promptBlock
          })
        : buildStoryPrompt(view, {
            scene: prompt,
            personas,
            targetMinutes,
            systemPrompt: this.settings.systemPrompt,
            emotionLabels: this.emotionLabels,
            ragContext: singleRag?.promptBlock
          })

    const messages: ChatMessage[] = [
      { role: 'system', content: built.system },
      { role: 'user', content: built.user }
    ]

    const details: string[] = []
    let raw: string | null = null
    let usage: ChatUsage | null = null
    let model = this.llm.model
    let latencyMs = 0
    const rounds = Math.max(0, this.settings.repairRounds)

    for (let round = 0; round <= rounds; round++) {
      this.logger.info(`[AI] 生成剧本（${mode}）round ${round + 1}/${rounds + 1}`)
      const result = await this.llm.chat(messages, {
        json: true,
        signal: options.signal
      })
      raw = result.content
      usage = result.usage
      model = result.model
      latencyMs += result.latencyMs

      let parsed: unknown
      try {
        parsed = extractJson(result.content, {
          finishReason: result.finishReason,
          maxTokens: this.settings.maxTokens
        })
      } catch (error) {
        const message = errorMessage(error)
        details.push(message)
        this.logger.warn(`[AI] 第 ${round + 1} 轮输出不是合法 JSON：${message}`)
        if (round >= rounds) break
        messages.push({ role: 'assistant', content: result.content.slice(0, 20_000) })
        messages.push({
          role: 'user',
          content: REPAIR_HINT.replace('{error}', message)
        })
        continue
      }

      try {
        let validated = validateAndFixStory(parsed, view, this.logger, {
          emotionLabels: this.emotionLabels
        })
        const alignedBefore = alignStoryTtsEmotionsAndCaptions(validated.story, {
          emotionLabels: this.emotionLabels
        })
        let ttsTranslated = 0
        if (options.translateForTts ?? this.settings.translateForTts) {
          ttsTranslated = await this.translateTtsText(validated.story, options.signal)
        }
        const alignedAfter = alignStoryTtsEmotionsAndCaptions(validated.story, {
          emotionLabels: this.emotionLabels
        })
        if (alignedBefore.updatedEmotions > 0 || alignedAfter.updatedEmotions > 0) {
          validated = validateAndFixStory(validated.story, view, this.logger, {
            emotionLabels: this.emotionLabels
          })
          alignStoryTtsEmotionsAndCaptions(validated.story, { emotionLabels: this.emotionLabels })
        }
        return {
          story: validated.story,
          meta: {
            mode,
            pipeline: 'single',
            model,
            rounds: round + 1,
            warnings: validated.warnings,
            usage,
            latencyMs,
            durationMs: 0,
            ttsTranslated,
            cast: view.models.map((entry) => entry.name),
            ...(this.summarizeRag(singleRag) ? { rag: this.summarizeRag(singleRag) } : {})
          }
        }
      } catch (error) {
        const message = errorMessage(error)
        details.push(message)
        this.logger.warn(`[AI] 第 ${round + 1} 轮剧本校验失败：${message}`)
        if (round >= rounds) break
        messages.push({ role: 'assistant', content: result.content.slice(0, 20_000) })
        messages.push({
          role: 'user',
          content: REPAIR_HINT.replace('{error}', message)
        })
      }
    }

    throw new StoryGenerationError(`AI 剧本生成失败（已尝试 ${rounds + 1} 轮）`, details, raw)
  }

  /**
   * Agentic Tool-Calling 模式：允许模型自主调用人设、motion3 表情语义、官方语料与双重校验工具。
   * 当模型/网关不支持原生 tool calling 时自动切至 ReAct JSON 信封；若仍受阻则安全回退 staged 流水线。
   */
  private async generateAgentic(args: {
    prompt: string
    view: CatalogView
    personas: PersonaEntry[]
    targetMinutes: number
    options: GenerateStoryOptions
  }): Promise<GenerateStoryResult> {
    const { prompt, view, personas, targetMinutes, options } = args
    const retriever = this.getRagRetriever()
    try {
      const agentRes = await runAgenticStoryGeneration({
        llm: this.llm,
        view,
        personas,
        scene: prompt,
        targetMinutes,
        emotionLabels: this.emotionLabels,
        systemPrompt: this.settings.systemPrompt,
        maxToolTurns: options.maxToolTurns ?? this.settings.agentMaxSteps,
        ragRetriever: retriever,
        logger: this.logger,
        signal: options.signal
      })
      // 先对齐错标「平静」并补齐 ttsCaption / ttsSpecialScene，让后续翻译器拿到准确的声演上下文
      const alignedBefore = alignStoryTtsEmotionsAndCaptions(agentRes.story, {
        emotionLabels: this.emotionLabels
      })
      let ttsTranslated = 0
      if (options.translateForTts ?? this.settings.translateForTts) {
        ttsTranslated = await this.translateTtsText(agentRes.story, options.signal)
      }
      const alignedAfter = alignStoryTtsEmotionsAndCaptions(agentRes.story, {
        emotionLabels: this.emotionLabels
      })
      const totalEmo = alignedBefore.updatedEmotions + alignedAfter.updatedEmotions
      const totalCap = alignedBefore.updatedCaptions + alignedAfter.updatedCaptions
      const totalSpec = alignedBefore.updatedSpecialScenes + alignedAfter.updatedSpecialScenes
      if (totalEmo > 0 || totalCap > 0 || alignedAfter.updatedEmojis > 0 || totalSpec > 0) {
        this.logger.info(
          `[TTS] 情绪对齐（agent）：emotion=${totalEmo} caption=${totalCap} emoji=${alignedAfter.updatedEmojis} special=${totalSpec}`
        )
      }
      return {
        story: agentRes.story,
        meta: {
          mode: 'story',
          pipeline: 'agent',
          ...(agentRes.title ? { title: agentRes.title } : {}),
          model: agentRes.model,
          rounds: agentRes.rounds,
          warnings: agentRes.warnings,
          usage: agentRes.usage,
          latencyMs: agentRes.latencyMs,
          durationMs: 0,
          ttsTranslated,
          cast: agentRes.story.models.map(
            (m) => view.shortName(view.modelById(m.id) ?? (m as never)) || String(m.id)
          ),
          toolCalls: agentRes.toolCallsUsed,
          agentMode: agentRes.modeUsed,
          agentSteps: agentRes.rounds,
          ...(agentRes.directorReview ? { directorReview: agentRes.directorReview } : {})
        }
      }
    } catch (error) {
      if (options.signal?.aborted) throw error
      const reason = errorMessage(error)
      this.logger.warn(`[AI] Agentic 模式回退至 staged 流水线：${reason}`)
      const fallback = await this.generateStaged({ prompt, view, personas, targetMinutes, options })
      fallback.meta.agentMode = 'staged-fallback'
      fallback.meta.warnings = [
        `[Agentic->staged-fallback] ${reason}`,
        ...(fallback.meta.warnings ?? [])
      ]
      return fallback
    }
  }

  /**
   * 三段式生成：选角 → 台词 → 表演设计。
   *
   * 选角和表演失败都可以降级（按目录顺序选角 / 无动作合成），只有台词稿不可用
   * 才会失败；台词一经生成就逐字进入最终剧本，表演段不能改写它。
   */
  private async generateStaged(args: {
    prompt: string
    view: CatalogView
    personas: PersonaEntry[]
    targetMinutes: number
    options: GenerateStoryOptions
  }): Promise<GenerateStoryResult> {
    const { prompt, view, personas, targetMinutes, options } = args
    const promptOptions: StagedPromptOptions = {
      scene: prompt,
      personas,
      targetMinutes,
      systemPrompt: this.settings.systemPrompt,
      emotionLabels: this.emotionLabels
    }

    const stages: StoryStageMeta[] = []
    const warnings: string[] = []
    const details: string[] = []
    let usage: ChatUsage | null = null
    let model = this.llm.model
    let latencyMs = 0

    const runStage = async (
      stage: string,
      messages: StagedMessages,
      stageOptions: { temperature?: number } = {}
    ): Promise<ChatResult> => {
      this.logger.info(`[AI] staged: ${stage}`)
      const result = await this.llm.chat(
        [
          { role: 'system', content: messages.system },
          { role: 'user', content: messages.user }
        ],
        { json: true, signal: options.signal, temperature: stageOptions.temperature }
      )
      stages.push({
        stage,
        model: result.model,
        latencyMs: result.latencyMs,
        usage: result.usage,
        ok: true
      })
      this.logger.info(`[AI] staged: ${stage} ok in ${result.latencyMs}ms`)
      latencyMs += result.latencyMs
      usage = mergeUsage(usage, result.usage)
      model = result.model
      return result
    }

    const markStageFailed = (note: string, stage?: string): void => {
      const last = stage
        ? [...stages].reverse().find((entry) => entry.stage === stage)
        : stages[stages.length - 1]
      if (last) {
        last.ok = false
        last.note = note
      }
    }

    const parseStageJson = (result: ChatResult): unknown =>
      extractJson(result.content, {
        finishReason: result.finishReason,
        maxTokens: this.settings.maxTokens
      })

    // ---- 0.5 Pass A：选角前快速检索（<= 1500 字符，0 额外 LLM 调用） -----------------------------------------
    const retriever = this.getRagRetriever()
    let preCastRag: RagRetrieveResult | null = null
    if (retriever) {
      try {
        preCastRag = await retriever.retrieve({
          prompt,
          stage: 'cast',
          maxCharBudget: 1500,
          signal: options.signal
        })
      } catch (error) {
        if (options.signal?.aborted) throw error
        this.logger.warn(`[RAG] Pass A 选角前检索失败，继续无参考选角：${errorMessage(error)}`)
      }
    }

    // ---- 1. 选角与微事件（含深度意图理解、称呼表与多面 RAG 查询） ----------------------------------------------
    const castPromptOptions: StagedPromptOptions = { ...promptOptions, ragContext: preCastRag }
    let plan: StagedCastPlan | null = null
    try {
      const result = await runStage('cast', buildCastPrompt(view, castPromptOptions))
      plan = normalizeCastPlan(parseStageJson(result), view, castPromptOptions)
      if (!plan) {
        markStageFailed('没有返回目录中的角色')
        warnings.push('选角结果没有可用角色，已按目录顺序回退')
      }
    } catch (error) {
      if (options.signal?.aborted) throw error
      const message = errorMessage(error)
      details.push(`选角：${message}`)
      warnings.push(`选角失败，已按目录顺序回退：${message}`)
    }
    if (!plan) plan = fallbackCastPlan(view, promptOptions)
    if (plan.cast.length === 0) {
      throw new StoryGenerationError('资源目录没有可用于生成的角色', details)
    }
    if (!plan.understanding) {
      this.logger.warn('[AI] cast 阶段没有返回深度理解，台词阶段将只依赖用户原文与官方参考')
    }

    // ---- 1.5 Pass B：选角后多面自适应检索（结合入选角色、微事件与 Stage 1 retrievalQueries） -------------------
    let postCastRag: RagRetrieveResult | null = preCastRag
    if (retriever) {
      try {
        postCastRag = await retriever.retrieve({
          prompt,
          stage: 'dialogue',
          cast: plan.cast.map((m) => ({
            name: m.name,
            fullName: m.fullName
          })),
          event: plan.event,
          logline: plan.logline,
          outline: plan.outline,
          location: plan.scenes?.[0]?.placeInfo || plan.background,
          retrievalQueries: plan.retrievalQueries,
          signal: options.signal
        })
      } catch (error) {
        if (options.signal?.aborted) throw error
        this.logger.warn(`[RAG] Pass B 多面检索失败，回退 Pass A 结果：${errorMessage(error)}`)
      }
    }
    promptOptions.ragContext = postCastRag

    // ---- 2. 只写台词 ---------------------------------------------------------------------------------------
    let dialogue: StagedDialogue | null = null
    let dialogueRaw = ''
    try {
      const result = await runStage('dialogue', buildDialoguePrompt(view, plan, promptOptions))
      dialogueRaw = result.content
      dialogue = normalizeDialogue(
        parseStageJson(result),
        plan,
        Math.max(12, Math.round(targetMinutes * 18)),
        this.emotionLabels
      )
      if (!dialogue) {
        markStageFailed('没有返回至少 2 条可用台词')
        warnings.push('台词稿为空或不完整，已请求重写一次')
      }
    } catch (error) {
      if (options.signal?.aborted) throw error
      const message = errorMessage(error)
      details.push(`台词：${message}`)
      warnings.push(`台词稿解析失败，已请求重写一次：${message}`)
    }
    if (!dialogue) {
      try {
        const repair = await runStage(
          'dialogue-repair',
          buildDialogueRepairPrompt(view, plan, promptOptions, dialogueRaw)
        )
        dialogue = normalizeDialogue(
          parseStageJson(repair),
          plan,
          Math.max(12, Math.round(targetMinutes * 18)),
          this.emotionLabels
        )
        if (!dialogue) markStageFailed('重写后仍没有至少 2 条可用台词')
      } catch (error) {
        if (options.signal?.aborted) throw error
        details.push(`台词重写：${errorMessage(error)}`)
      }
    }
    if (!dialogue) {
      throw new StoryGenerationError(
        'AI 没有返回可用的台词稿（已请求重写一次）',
        details,
        dialogueRaw || null
      )
    }

    // 台词太短（模型偶尔只写十几句或总字数不够）会让整场不到 2 分钟；补一次长度重写。
    // 测试/调试用极短 targetMinutes 时不启用，避免和合成用例互相干扰。
    const enforceDialogueLength = targetMinutes >= 0.5
    const minDialogueLines = Math.max(2, Math.round(targetMinutes * 10))
    // 按 ~19 字/句的官方均值校准下限（3 分钟 >= 30 句 / 570 字），避免 34~36 句/680~740 字的优质初稿触发无效补写。
    const minDialogueChars = Math.max(10, Math.round(targetMinutes * 190))
    const actualDialogueChars = countDialogueChars(dialogue)
    if (
      enforceDialogueLength &&
      (dialogue.lines.length < minDialogueLines || actualDialogueChars < minDialogueChars)
    ) {
      const requiredLines = Math.max(minDialogueLines, Math.ceil(minDialogueChars / 19))
      const expandDialogue = async (stage: string): Promise<boolean> => {
        const currentDialogue = dialogue as StagedDialogue
        const currentLines = currentDialogue.lines.length
        const currentChars = countDialogueChars(currentDialogue)
        this.logger.info(
          `[AI] ${stage}: ${currentLines} 句 / ${currentChars} 字，目标 ${requiredLines} 句 / ${minDialogueChars} 字`
        )
        const expanded = await runStage(
          stage,
          buildDialogueLengthPrompt(
            view,
            plan,
            promptOptions,
            currentDialogue,
            currentLines,
            requiredLines,
            minDialogueChars
          )
        )
        const expandedDialogue = normalizeDialogue(
          parseStageJson(expanded),
          plan,
          Math.max(12, Math.round(targetMinutes * 18)),
          this.emotionLabels
        )
        if (
          expandedDialogue &&
          (expandedDialogue.lines.length > currentLines ||
            countDialogueChars(expandedDialogue) > currentChars)
        ) {
          dialogue = expandedDialogue
          return true
        }
        return false
      }

      markStageFailed(
        `台词太短（${dialogue.lines.length} 句 / ${actualDialogueChars} 字，至少需要 ${requiredLines} 句 / ${minDialogueChars} 字）`
      )
      warnings.push(
        `台词只有 ${dialogue.lines.length} 句 / ${actualDialogueChars} 字，已请求补写（至少 ${requiredLines} 句 / ${minDialogueChars} 字）`
      )
      try {
        await expandDialogue('dialogue-expand')
      } catch (error) {
        if (options.signal?.aborted) throw error
        details.push(`台词补写：${errorMessage(error)}`)
      }
      // 第一次补写仍明显偏短（不到目标的 3/4）时再补一次，避免成片只有两分多钟。
      if (countDialogueChars(dialogue) < Math.round(minDialogueChars * 0.75)) {
        warnings.push('补写后仍然偏短，已再补写一次')
        try {
          await expandDialogue('dialogue-expand-2')
        } catch (error) {
          if (options.signal?.aborted) throw error
          details.push(`台词二次补写：${errorMessage(error)}`)
        }
      }
    }

    // 模型多写的同角色短句并回一条，拉长平均句长；只合并，不改字。
    // 只有在平均句长明显偏短（<16.5 字）时才合并；句长已经达标时保留原有连续说话段。
    if (enforceDialogueLength) {
      for (let pass = 0; pass < 2; pass++) {
        const totalChars = countDialogueChars(dialogue)
        const meanChars = totalChars / Math.max(1, dialogue.lines.length)
        if (meanChars >= 16.5) break
        const condenseTarget = Math.max(
          Math.max(20, Math.round(targetMinutes * 10)),
          Math.ceil(totalChars / 20)
        )
        if (dialogue.lines.length <= condenseTarget) break
        const condensed = condenseDialogue(dialogue, condenseTarget)
        if (condensed.lines.length === dialogue.lines.length) break
        dialogue = condensed
      }
    }

    // ---- 2.2 反套路对白质检与条件外科润色（零成本确定性 Linter + 仅在问题严格减少时采纳） --------------------
    if (this.settings.polishDialogue === true) {
      const lintBefore = lintDialogueFidelity(dialogue, plan)
      if (lintBefore.shouldPolish) {
        try {
          const polishResult = await runStage(
            'dialogue-polish',
            buildDialoguePolishPrompt(plan, dialogue, lintBefore.issues, {
              scene: prompt,
              view,
              personas,
              ragContext: postCastRag
            }),
            { temperature: 0.35 }
          )
          const polished = applyDialoguePolish(
            dialogue,
            parseStageJson(polishResult),
            new Set(lintBefore.flaggedLineIds)
          )
          const lintAfter = lintDialogueFidelity(polished, plan)
          const beforeChars = countDialogueChars(dialogue)
          const afterChars = countDialogueChars(polished)
          if (
            polished.lines.length === dialogue.lines.length &&
            afterChars >= Math.floor(beforeChars * 0.85) &&
            lintAfter.issues.length < lintBefore.issues.length
          ) {
            this.logger.info(
              `[AI] dialogue-polish 采纳：问题 ${lintBefore.issues.length} -> ${lintAfter.issues.length}`
            )
            dialogue = polished
          } else {
            this.logger.info(
              `[AI] dialogue-polish 未改善（问题 ${lintBefore.issues.length} -> ${lintAfter.issues.length}），保留原稿`
            )
          }
        } catch (error) {
          if (options.signal?.aborted) throw error
          this.logger.warn(`[AI] dialogue-polish 失败，保留原稿：${errorMessage(error)}`)
        }
      }
    }

    // 确定性兜底清理台词中残留的括号动作描写（保留真正的心里话）
    const cleanedDialogue: StagedDialogue = {
      ...dialogue,
      lines: dialogue.lines.map((line) => ({
        ...line,
        content: repairSpokenStageDirections(line.content)
      }))
    }
    dialogue = cleanedDialogue

    // ---- 2.5 语音导演（Voice Direction）与舞台调度并行 -------------------------------------------------------
    const finalDialogue = enforceDialogueLength ? softenPunctuation(dialogue) : dialogue
    const translateForTts = options.translateForTts ?? this.settings.translateForTts
    const emotionTask: Promise<Map<string, StagedVoiceDirectionLine> | null> = (async () => {
      if (this.emotionLabels.length === 0) return null
      let voicePlan: Map<string, StagedVoiceDirectionLine> | null = null
      let emotionRaw = ''
      try {
        const result = await runStage(
          'emotion',
          buildEmotionPrompt(plan, dialogue, promptOptions),
          { temperature: 0.25 }
        )
        emotionRaw = result.content
        voicePlan = normalizeVoiceDirectionPlan(
          parseStageJson(result),
          dialogue,
          this.emotionLabels
        )
        if (!voicePlan) {
          markStageFailed('没有返回可用的语音导演指令', 'emotion')
          warnings.push('语音导演标注不可用，整场使用默认情绪')
        }
      } catch (error) {
        if (options.signal?.aborted) throw error
        const message = errorMessage(error)
        details.push(`语音导演：${message}`)
        warnings.push(`语音导演失败，整场使用默认情绪：${message}`)
      }

      // 只有较长剧本完全锁死单一情绪（只有 1 段）时才低温重标一次；不再机械要求 3~4 段来回切。
      if (voicePlan && this.emotionLabels.length > 1 && dialogue.lines.length >= 16) {
        const runs = countEmotionRuns(voicePlan, dialogue)
        if (runs < 2) {
          markStageFailed(`情绪分段过于单一（仅 ${runs} 段）`, 'emotion')
          warnings.push(`长剧本情绪只有 ${runs} 段，已请求按起承转合重标`)
          try {
            const repaired = await runStage(
              'emotion-repair',
              buildEmotionRepairPrompt(plan, dialogue, promptOptions, emotionRaw, runs),
              { temperature: 0.25 }
            )
            const repairedPlan = normalizeVoiceDirectionPlan(
              parseStageJson(repaired),
              dialogue,
              this.emotionLabels
            )
            if (repairedPlan && countEmotionRuns(repairedPlan, dialogue) > runs) {
              voicePlan = repairedPlan
            }
          } catch (error) {
            if (options.signal?.aborted) throw error
            details.push(`语音导演重标：${errorMessage(error)}`)
          }
        }
      }
      return voicePlan
    })()
    // 舞台调度/摄影策划与语音导演同时启动；等待语音导演回填后，再并行启动精细演技导演（direction）与上下文感知日文翻译（translateDialogue）。
    const stagingTask: Promise<StagedStaging> = (async () => {
      try {
        const result = await runStage(
          'staging',
          buildStagingPrompt(view, plan, finalDialogue, promptOptions)
        )
        return normalizeStaging(parseStageJson(result), view, plan, finalDialogue)
      } catch (error) {
        if (options.signal?.aborted) throw error
        const message = errorMessage(error)
        details.push(`舞台调度：${message}`)
        warnings.push(`舞台调度不可用，已使用默认转场与站位：${message}`)
        return fallbackStaging(view, plan, finalDialogue)
      }
    })()
    // 任一前置并行任务取消/报错时避免未捕获拒绝。
    void emotionTask.catch(() => undefined)
    void stagingTask.catch(() => undefined)

    // ---- 3. 等待语音导演与舞台调度完成，并回填情绪与逐句韵律指令 --------------------------------------------
    const [voiceDirectionPlan, staging] = await Promise.all([emotionTask, stagingTask])
    dialogue = applyVoiceDirectionPlan(finalDialogue, voiceDirectionPlan, this.emotionLabels)

    // 在语音导演完成后启动日文翻译（仍与 Stage 4 演技导演并行），让翻译能看到说话人、人设口吻、称呼表、emotion 与 ttsCaption。
    let dialogueTts: Promise<Map<string, string> | null> | null = null
    if (translateForTts) {
      dialogueTts = this.translateDialogue(
        dialogue,
        personas,
        options.signal,
        plan.pairwiseAddress,
        postCastRag
      ).catch((error) => {
        if (options.signal?.aborted) return null
        this.logger.warn(`[AI] 台词日文翻译失败，合成后再补：${errorMessage(error)}`)
        return null
      })
    }

    // ---- 4. 精细演技导演（带完整情绪段与舞台/分镜上下文） -------------------------------------------------
    let direction: StagedDirection = fallbackDirection(view, plan)
    let directionRaw = ''
    try {
      const result = await runStage(
        'direction',
        buildDirectionPrompt(view, plan, dialogue, promptOptions, staging)
      )
      directionRaw = result.content
      direction = normalizeDirection(parseStageJson(result), view, plan, dialogue)
      if (direction.lines.length === 0) {
        markStageFailed('没有返回可用的表演设计')
        warnings.push('表演设计为空，已请求重写一次')
      }
    } catch (error) {
      if (options.signal?.aborted) throw error
      const message = errorMessage(error)
      details.push(`表演设计：${message}`)
      warnings.push(`表演设计解析失败，已请求重写一次：${message}`)
    }
    if (direction.lines.length === 0) {
      try {
        const repair = await runStage(
          'direction-repair',
          buildDirectionRepairPrompt(view, plan, dialogue, promptOptions, directionRaw, staging)
        )
        direction = normalizeDirection(parseStageJson(repair), view, plan, dialogue)
      } catch (error) {
        if (options.signal?.aborted) throw error
        details.push(`表演设计重写：${errorMessage(error)}`)
      }
    }
    if (direction.lines.length === 0) {
      warnings.push('表演设计不可用，已使用默认走位与无动作台词')
      direction = fallbackDirection(view, plan)
    }

    // ---- 4.5 收取并行翻译结果 ------------------------------------------------------------------------------
    // 背景翻译在情绪与舞台调度之前已经启动，通常在此前就已完成；这里只做等待与写入。
    let ttsTranslated = 0
    if (dialogueTts) {
      const translated = await dialogueTts
      if (translated) {
        for (const line of dialogue.lines) {
          const text = translated.get(line.id)
          if (text) {
            line.ttsText = text
            ttsTranslated += 1
          }
        }
      }
    }

    // ---- 5. 合成与校验 -------------------------------------------------------------------------------------
    let validated: ValidationResult
    try {
      const composed = composeStory(view, plan, dialogue, direction, staging)
      alignStoryTtsEmotionsAndCaptions(composed as unknown as StoryData, {
        emotionLabels: this.emotionLabels
      })
      validated = validateAndFixStory(composed, view, this.logger, {
        emotionLabels: this.emotionLabels
      })
    } catch (error) {
      const message = errorMessage(error)
      this.logger.warn(`[AI] staged 合成校验失败，退回无动作版本：${message}`)
      details.push(`合成：${message}`)
      try {
        const fallbackComposed = composeStory(
          view,
          plan,
          dialogue,
          fallbackDirection(view, plan),
          staging
        )
        alignStoryTtsEmotionsAndCaptions(fallbackComposed as unknown as StoryData, {
          emotionLabels: this.emotionLabels
        })
        validated = validateAndFixStory(fallbackComposed, view, this.logger, {
          emotionLabels: this.emotionLabels
        })
        warnings.push(`表演设计校验失败，已退回无动作版本：${message}`)
      } catch (fallbackError) {
        details.push(`合成回退：${errorMessage(fallbackError)}`)
        throw new StoryGenerationError(
          'AI 剧本合成后校验失败',
          details,
          directionRaw || dialogueRaw || null
        )
      }
    }

    // ---- 5.5 导演终审（可选/生产长篇默认开启；安全外科修补，绝不破坏既有 ttsText 与 Irodori Emoji） ----------
    let stagedDirectorReview: DirectorReviewRecord | undefined
    const shouldRunDirectorReview =
      options.directorReview ??
      (this.settings.polishDialogue === true && dialogue.lines.length >= 12)
    if (shouldRunDirectorReview) {
      try {
        const reviewResult = await runStage(
          'director-review',
          buildDirectorReviewPrompt(
            view,
            plan,
            validated.story as unknown as {
              models: Array<{ id: number }>
              snippets: Array<Record<string, unknown>>
            },
            promptOptions
          ),
          { temperature: 0.3 }
        )
        const parsedReview = normalizeDirectorReviewResult(parseStageJson(reviewResult))
        if (parsedReview) {
          let appliedCount = 0
          if (parsedReview.operations.length > 0) {
            const patched = applyDirectorReviewPatches(
              validated.story as unknown as { snippets: Array<Record<string, unknown>> },
              parsedReview
            )
            if (patched.appliedCount > 0) {
              try {
                const revalidated = validateAndFixStory(patched.story, view, this.logger, {
                  emotionLabels: this.emotionLabels
                })
                validated = revalidated
                appliedCount = patched.appliedCount
                this.logger.info(`[AI] director-review 采纳 ${appliedCount} 项导演修补`)
              } catch (patchErr) {
                this.logger.warn(
                  `[AI] director-review 修补未通过舞台校验，保留原成稿：${errorMessage(patchErr)}`
                )
              }
            }
          }
          stagedDirectorReview = {
            dramaticArc: parsedReview.dramaticArc,
            emotionalContinuityAndVoice: parsedReview.emotionalContinuityAndVoice,
            audioAndSeDesign: parsedReview.audioAndSeDesign,
            stageRhythm: parsedReview.stageRhythm,
            actingNaturalness: parsedReview.actingNaturalness,
            concreteFixes: parsedReview.concreteFixes,
            appliedOperationsCount: appliedCount
          }
        }
      } catch (error) {
        if (options.signal?.aborted) throw error
        this.logger.warn(`[AI] director-review 失败，保留原成稿：${errorMessage(error)}`)
      }
    }

    if (translateForTts) {
      ttsTranslated += await this.translateTtsText(
        validated.story,
        options.signal,
        personas,
        plan.pairwiseAddress,
        postCastRag
      )
    }
    const alignedStaged = alignStoryTtsEmotionsAndCaptions(validated.story, {
      emotionLabels: this.emotionLabels
    })
    if (alignedStaged.updatedEmotions > 0) {
      validated = validateAndFixStory(validated.story, view, this.logger, {
        emotionLabels: this.emotionLabels
      })
      alignStoryTtsEmotionsAndCaptions(validated.story, {
        emotionLabels: this.emotionLabels
      })
    }
    if (
      alignedStaged.updatedEmotions > 0 ||
      alignedStaged.updatedCaptions > 0 ||
      alignedStaged.updatedEmojis > 0 ||
      alignedStaged.updatedSpecialScenes > 0
    ) {
      this.logger.info(
        `[TTS] 情绪对齐（staged）：emotion=${alignedStaged.updatedEmotions} caption=${alignedStaged.updatedCaptions} emoji=${alignedStaged.updatedEmojis} special=${alignedStaged.updatedSpecialScenes}`
      )
    }

    const activeIds = new Set(validated.story.models.map((entry) => entry.id))
    const cast = view.models.filter((entry) => activeIds.has(entry.id)).map((entry) => entry.name)

    // 并行阶段完成顺序不固定；按 5 阶段流水线顺序输出，便于日志与客户端展示。
    const stageOrder = [
      'cast',
      'dialogue',
      'dialogue-repair',
      'dialogue-expand',
      'dialogue-expand-2',
      'dialogue-polish',
      'emotion',
      'emotion-repair',
      'staging',
      'direction',
      'direction-repair',
      'director-review'
    ]
    const stageRank = (stage: string): number => {
      const index = stageOrder.indexOf(stage)
      return index === -1 ? stageOrder.length : index
    }
    stages.sort((a, b) => stageRank(a.stage) - stageRank(b.stage))

    return {
      story: validated.story,
      meta: {
        mode: 'story',
        pipeline: 'staged',
        title: dialogue.title || plan.title || undefined,
        model,
        rounds: stages.length,
        warnings: [...warnings, ...validated.warnings],
        usage,
        latencyMs,
        durationMs: 0,
        ttsTranslated,
        cast,
        stages,
        ...(stagedDirectorReview ? { directorReview: stagedDirectorReview } : {}),
        ...(this.summarizeRag(postCastRag) ? { rag: this.summarizeRag(postCastRag) } : {})
      }
    }
  }

  /**
   * 批量翻译一段台词稿（携带说话人、人设口吻、日文称呼表、emotion、ttsCaption），返回 lineId → 日文 ttsText。
   *
   * 在语音导演完成后启动，与演技导演（direction）并行，不增加串行尾时间。
   */
  private async translateDialogue(
    dialogue: StagedDialogue,
    personas: PersonaEntry[],
    signal?: AbortSignal,
    pairwiseAddress?: StagedPairwiseAddress[],
    ragContext?: RagRetrieveResult | null
  ): Promise<Map<string, string>> {
    const slots = dialogue.lines.map((line) => ({
      line,
      data: {
        speaker: line.speaker,
        content: line.content,
        emotion: line.emotion ?? '',
        ttsCaption: line.ttsCaption ? sanitizeIrodoriCaption(line.ttsCaption, line.emotion) : '',
        ttsText: ''
      }
    }))
    // 走与剧本相同的一套规则：纯标点跳过、非日文结果丢弃、失败留空。
    const story = {
      models: [],
      images: [],
      snippets: slots.map((slot) => ({
        type: 'Talk',
        wait: false,
        delay: 0,
        data: slot.data
      }))
    } as unknown as StoryData
    const startedAt = Date.now()
    const { translated } = await ensureJapaneseTtsText(
      story,
      this.ttsTranslator(signal, personas, pairwiseAddress, ragContext),
      this.logger
    )
    const result = new Map<string, string>()
    for (const slot of slots) {
      const text = slot.data.ttsText.trim()
      if (text) result.set(slot.line.id, text)
    }
    if (translated > 0) {
      this.logger.info(`[AI] 台词日文翻译完成：${translated} 条，${Date.now() - startedAt}ms`)
    }
    return result
  }

  private speakerStyleHint(speaker: string | undefined, personas: PersonaEntry[]): string {
    const name = speaker?.trim()
    if (!name) return ''
    const lower = name.toLowerCase()
    const matched = personas.find(
      (entry) =>
        entry.name.toLowerCase() === lower ||
        entry.aliases.some((alias) => alias.toLowerCase() === lower) ||
        entry.name.includes(name) ||
        name.includes(entry.name)
    )
    if (!matched?.prompt) return ''
    const firstLine = matched.prompt
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, '').trim())
      .find((line) => line.length >= 6)
    return firstLine ? firstLine.slice(0, 60) : ''
  }

  private ttsTranslator(
    signal?: AbortSignal,
    personas: PersonaEntry[] = this.getPersonas(),
    pairwiseAddress?: StagedPairwiseAddress[],
    ragContext?: RagRetrieveResult | null
  ): TtsBatchTranslator {
    const addressLines = (pairwiseAddress ?? [])
      .map((a) => `${a.from}→${a.to}: ${a.ja || a.zh}`)
      .slice(0, 10)
    const jpSamples = [
      ...(ragContext?.sections?.dialogueVoice ?? []),
      ...(ragContext?.sections?.canonPlot ?? [])
    ]
      .map((ex) => ex.jpText?.trim())
      .filter((t): t is string => Boolean(t))
      .slice(0, 2)
      .map((t) => t.slice(0, 280))

    const system = [
      '你是 Project SEKAI 二次元剧情的中日翻译（配音台词专精），为 IrodoriTTS 生成自然、贴合角色人设的日语配音文本。',
      '只输出与输入等长的 JSON 字符串数组，不要解释、不要 markdown。',
      '翻译规则：',
      '1. 严格结合每句提供的说话人、口吻提示、日文称呼约定、情绪标签（emotion）与日语声演指令（ttsCaption），翻出地道、口语化、符合角色人称与敬语习惯的日语。',
      '2. 每条译文都必须含假名，不要输出纯汉字（例如「了解」写成「了解だよ」「了解です」）。保留自然的停顿与语气（……、っ、！、？、——）。',
      '3. 按情绪与声演指令使用 0~1 个（长句最多 2 个）Irodori 官方内联演技表情：🤭(轻笑) 😮‍💨(叹气) 🥺(颤声/委屈/忍泪) 😰(慌张/结巴) 😆(开心) 😊(愉快) 😠(生气) 😭(哭泣/呜咽/撕裂恳求) 😲(惊讶) 🫣(害羞) 😌(安心) 🙄(无语) 😏(调侃) 🫶(温柔) ⏸️(停顿) ⏩(语速加快) 🐢(放慢) 😮(倒吸气) 🌬️(喘气) 👂(耳语)。普通叙述句可以不加；禁止使用 🥵👅💋😴🥤🥴👃 等不安全表情。\n' +
        '   - **哭泣/悲伤/愧疚/告别硬性规则**：当 `emotion` 为「伤心」或 `ttsCaption` 含哭腔/颤抖/悲痛时，**必须把 `😭`（哭泣/呜咽/撕裂呐喊/恳求）或 `🥺`（忍泪/哽咽/含泪道歉）或 `😮‍💨`（无力叹息）放在句首或含正面词的分句之前（严禁只放在整句最末尾！）**——尤其台词表面出现「笑」「冗談」「大丈夫」「バカ」「友達」「一緒」等正面词汇但语境悲伤时，务必从句首第 0 帧就以 `🥺`/`😭` 锚定悲伤声线，防止前半句先读出亮调或笑意！**严禁**在「伤心」「生气」「惊讶」台词中使用 `🤭 😆 😊 😏 🫶 🎵 😌` 等欢快/安心表情。\n' +
        '   - **开心/轻松日常保真规则**：当 `emotion` 为「开心」或轻松打趣、和好欢笑场景时，自然保留 `😊`、`😆`、`🤭` 等欢快内联表情，保持温暖明快的语气，不要把日常喜剧场景压成沉重腔调。',
      '4. 非语言语气句（如「……呜」「……っ」「嗯……」等）请译为自然的日语拟声或副语言提示，不要只输出裸标点或孤立促音「……っ」。',
      '5. 只输出说出口或内心独白的台词正文，严禁插入「(笑)」「（ため息）」等括号动作提示。',
      ...(addressLines.length > 0
        ? [`6. 角色日文称呼表（务必遵守）：${addressLines.join('；')}`]
        : []),
      ...(jpSamples.length > 0
        ? [`7. 官方日文口吻参考（仅学语气与人称，严禁照抄）：\n${jpSamples.join('\n---\n')}`]
        : [])
    ].join('\n')

    return async (texts, items?: TtsTranslationItem[]) => {
      const hasContext = Boolean(
        items?.some((item) => item.speaker || item.emotion || item.ttsCaption)
      )
      const userContent =
        hasContext && items
          ? `把下面 ${items.length} 条台词结合角色与声演指令翻译成日语，只输出长度相同的 JSON 字符串数组：\n${JSON.stringify(
              items.map((item) => {
                const style = this.speakerStyleHint(item.speaker, personas)
                return {
                  text: item.text,
                  ...(item.speaker ? { speaker: item.speaker } : {}),
                  ...(style ? { style } : {}),
                  ...(item.emotion ? { emotion: item.emotion } : {}),
                  ...(item.ttsCaption
                    ? { ttsCaption: sanitizeIrodoriCaption(item.ttsCaption, item.emotion) }
                    : {})
                }
              })
            )}`
          : `把下面 ${texts.length} 条台词翻译成日语，只输出长度相同的 JSON 字符串数组：\n${JSON.stringify(texts)}`

      const { data } = await this.llm.chatJson<string[]>(
        [
          { role: 'system', content: system },
          { role: 'user', content: userContent }
        ],
        { temperature: 0.3, signal }
      )
      return data
    }
  }

  /**
   * 把缺失/非日文的 ttsText 批量翻译成日语。
   * 生成阶段翻译失败只保留空 ttsText，不阻断剧本；导出前会再做一次严格预检。
   */
  private async translateTtsText(
    story: StoryData,
    signal?: AbortSignal,
    personas: PersonaEntry[] = this.getPersonas(),
    pairwiseAddress?: StagedPairwiseAddress[],
    ragContext?: RagRetrieveResult | null
  ): Promise<number> {
    const { translated } = await ensureJapaneseTtsText(
      story,
      this.ttsTranslator(signal, personas, pairwiseAddress, ragContext),
      this.logger
    )
    return translated
  }

  /**
   * 供导出前预检使用：严格补齐日文 ttsText，仍有缺失则抛错。
   * IrodoriTTS 只接受日文，不能把中文 content 直接送去合成。
   */
  async ensureJapaneseTtsText(story: StoryData, signal?: AbortSignal): Promise<number> {
    const { translated } = await ensureJapaneseTtsText(
      story,
      this.ttsTranslator(signal),
      this.logger,
      { strict: true }
    )
    return translated
  }
}
