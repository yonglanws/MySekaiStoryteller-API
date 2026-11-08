import { ILogObj, Logger } from 'tslog'
import type { LlmSettings } from '../config'
import type { ResourceCatalog } from '../resources/resourceCatalog'
import type { StoryData } from '../../common/types/Story'
import { extractJson, LlmClient, type ChatMessage, type ChatResult, type ChatUsage } from './llm'
import { loadPersonas, type PersonaEntry } from './personas'
import { buildChatPrompt, buildStoryPrompt, CatalogView } from './prompt'
import {
  applyEmotionPlan,
  buildCastPrompt,
  buildDialoguePrompt,
  buildDialogueRepairPrompt,
  buildDialogueLengthPrompt,
  buildDirectionPrompt,
  buildDirectionRepairPrompt,
  buildEmotionPrompt,
  buildEmotionRepairPrompt,
  composeStory,
  condenseDialogue,
  countDialogueChars,
  countEmotionRuns,
  fallbackCastPlan,
  fallbackDirection,
  normalizeCastPlan,
  normalizeDialogue,
  normalizeDirection,
  normalizeEmotionPlan,
  softenPunctuation,
  stabilizeEmotions,
  type LlmPipeline,
  type StagedCastPlan,
  type StagedDialogue,
  type StagedDirection,
  type StagedMessages,
  type StagedPromptOptions
} from './staged'
import { validateAndFixStory, type ValidationResult } from './validate'
import { ensureJapaneseTtsText, type TtsBatchTranslator } from './ttsText'

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
  latencyMs: number
  ttsTranslated: number
  cast: string[]
  stages?: StoryStageMeta[]
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
注意：角色必须在 LayoutAppear 之后才能说话/表演；双人必须占用不同的 Left/Right 槽位；任意时刻最多两人在场。`

function filterByCast(view: CatalogView, cast: string[] | undefined): CatalogView {
  if (!cast || cast.length === 0) return view
  const tokens = cast.map((token) => token.trim().toLowerCase()).filter(Boolean)
  const matched = view.models.filter((model) =>
    tokens.some((token) => {
      const name = model.name.toLowerCase()
      const shortName = (model.shortName ?? '').toLowerCase()
      return (
        String(model.id) === token ||
        name === token ||
        shortName === token ||
        String(model.id).toLowerCase().includes(token) ||
        model.path.toLowerCase().includes(token)
      )
    })
  )
  if (matched.length === 0) {
    throw new StoryGenerationError(`cast 无法匹配任何角色：${cast.join(', ')}`, [
      `可用角色：${view.models.map((model) => `${model.name}(${model.id})`).join('、')}`
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

  constructor(
    llm: LlmClient,
    settings: LlmSettings,
    catalog: ResourceCatalog,
    logger: Logger<ILogObj>,
    emotionLabels: string[] = []
  ) {
    this.llm = llm
    this.settings = settings
    this.catalog = catalog
    this.logger = logger
    this.emotionLabels = emotionLabels.map((label) => label.trim()).filter(Boolean)
  }

  private getPersonas(): PersonaEntry[] {
    if (!this.personas) this.personas = loadPersonas(this.settings)
    return this.personas
  }

  async generate(options: GenerateStoryOptions): Promise<GenerateStoryResult> {
    const prompt = options.prompt?.trim()
    if (!prompt) throw new StoryGenerationError('场景描述不能为空', [])

    const mode = options.mode ?? 'story'
    const data = this.catalog.get()
    const view = filterByCast(new CatalogView(data), options.cast)
    const personas = this.getPersonas()
    const targetMinutes = options.targetMinutes ?? this.settings.targetMinutes
    const pipeline: LlmPipeline =
      mode === 'chat' ? 'single' : (options.pipeline ?? this.settings.pipeline ?? 'single')

    if (pipeline === 'staged') {
      return this.generateStaged({ prompt, view, personas, targetMinutes, options })
    }
    return this.generateSingle({ mode, prompt, view, personas, targetMinutes, options })
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
    const built =
      mode === 'chat'
        ? buildChatPrompt(view, {
            scene: prompt,
            personas,
            targetMinutes,
            systemPrompt: this.settings.systemPrompt,
            history: options.history,
            emotionLabels: this.emotionLabels
          })
        : buildStoryPrompt(view, {
            scene: prompt,
            personas,
            targetMinutes,
            systemPrompt: this.settings.systemPrompt,
            emotionLabels: this.emotionLabels
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
        parsed = extractJson(result.content)
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
        const validated = validateAndFixStory(parsed, view, this.logger, {
          emotionLabels: this.emotionLabels
        })
        let ttsTranslated = 0
        if (options.translateForTts ?? this.settings.translateForTts) {
          ttsTranslated = await this.translateTtsText(validated.story, options.signal)
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
            ttsTranslated,
            cast: view.models.map((entry) => entry.name)
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
      latencyMs += result.latencyMs
      usage = mergeUsage(usage, result.usage)
      model = result.model
      return result
    }

    const markStageFailed = (note: string): void => {
      const last = stages[stages.length - 1]
      if (last) {
        last.ok = false
        last.note = note
      }
    }

    // ---- 1. 选角与微事件 -----------------------------------------------------------------------------------
    let plan: StagedCastPlan | null = null
    try {
      const result = await runStage('cast', buildCastPrompt(view, promptOptions))
      plan = normalizeCastPlan(extractJson(result.content), view, promptOptions)
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

    // ---- 2. 只写台词 ---------------------------------------------------------------------------------------
    let dialogue: StagedDialogue | null = null
    let dialogueRaw = ''
    try {
      const result = await runStage('dialogue', buildDialoguePrompt(view, plan, promptOptions))
      dialogueRaw = result.content
      dialogue = normalizeDialogue(
        extractJson(result.content),
        plan,
        Math.round(targetMinutes * 16),
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
          extractJson(repair.content),
          plan,
          Math.round(targetMinutes * 16),
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
    // 官方 3 分钟约 746 字、40 句；下限按 250 字/分钟给，避免补写到 4 分钟。
    const minDialogueChars = Math.max(10, Math.round(targetMinutes * 250))
    const actualDialogueChars = countDialogueChars(dialogue)
    if (
      enforceDialogueLength &&
      (dialogue.lines.length < minDialogueLines || actualDialogueChars < minDialogueChars)
    ) {
      const requiredLines = Math.max(minDialogueLines, Math.ceil(minDialogueChars / 18))
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
          extractJson(expanded.content),
          plan,
          Math.round(targetMinutes * 16),
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

    // ---- 2.5 情绪分段（独立低温标注，避免台词轮逐句换情绪） ------------------------------------------------
    if (this.emotionLabels.length > 0) {
      let emotionPlan: Map<string, string> | null = null
      let emotionRaw = ''
      try {
        const result = await runStage(
          'emotion',
          buildEmotionPrompt(plan, dialogue, promptOptions),
          { temperature: 0.2 }
        )
        emotionRaw = result.content
        emotionPlan = normalizeEmotionPlan(
          extractJson(result.content),
          dialogue,
          this.emotionLabels
        )
        if (!emotionPlan) {
          markStageFailed('没有返回可用的情绪段')
          warnings.push('情绪标注不可用，整场使用默认情绪')
        }
      } catch (error) {
        if (options.signal?.aborted) throw error
        const message = errorMessage(error)
        details.push(`情绪标注：${message}`)
        warnings.push(`情绪标注失败，整场使用默认情绪：${message}`)
      }

      // 只有 2~3 段会让整场听起来没有起伏；低温重标一次，仍不行就接受。
      if (emotionPlan && this.emotionLabels.length > 1) {
        const runs = countEmotionRuns(emotionPlan, dialogue)
        const minEmotionRuns = dialogue.lines.length >= 30 ? 4 : 3
        if (runs < minEmotionRuns) {
          markStageFailed(`情绪分段太少（${runs} 段）`)
          warnings.push(`情绪只有 ${runs} 段，已请求重标（至少 ${minEmotionRuns} 段）`)
          try {
            const repaired = await runStage(
              'emotion-repair',
              buildEmotionRepairPrompt(plan, dialogue, promptOptions, emotionRaw, runs),
              { temperature: 0.2 }
            )
            const repairedPlan = normalizeEmotionPlan(
              extractJson(repaired.content),
              dialogue,
              this.emotionLabels
            )
            if (repairedPlan && countEmotionRuns(repairedPlan, dialogue) > runs) {
              emotionPlan = repairedPlan
            }
          } catch (error) {
            if (options.signal?.aborted) throw error
            details.push(`情绪重标：${errorMessage(error)}`)
          }
        }
      }

      const stabilized = stabilizeEmotions(dialogue, emotionPlan, this.emotionLabels)
      dialogue = applyEmotionPlan(dialogue, stabilized, this.emotionLabels)
    } else {
      dialogue = applyEmotionPlan(dialogue, null, [])
    }
    // 只改标点：把一部分句号收尾改成省略号，接近官方中文化台词的停顿密度。
    if (enforceDialogueLength) dialogue = softenPunctuation(dialogue)

    // ---- 3. 表演设计 ---------------------------------------------------------------------------------------
    let direction: StagedDirection = fallbackDirection(view, plan)
    let directionRaw = ''
    try {
      const result = await runStage(
        'direction',
        buildDirectionPrompt(view, plan, dialogue, promptOptions)
      )
      directionRaw = result.content
      direction = normalizeDirection(extractJson(result.content), view, plan, dialogue)
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
          buildDirectionRepairPrompt(view, plan, dialogue, promptOptions, directionRaw)
        )
        direction = normalizeDirection(extractJson(repair.content), view, plan, dialogue)
      } catch (error) {
        if (options.signal?.aborted) throw error
        details.push(`表演设计重写：${errorMessage(error)}`)
      }
    }
    if (direction.lines.length === 0) {
      warnings.push('表演设计不可用，已使用默认走位与无动作台词')
      direction = fallbackDirection(view, plan)
    }

    // ---- 4. 合成与校验 -------------------------------------------------------------------------------------
    let validated: ValidationResult
    try {
      validated = validateAndFixStory(
        composeStory(view, plan, dialogue, direction),
        view,
        this.logger,
        { emotionLabels: this.emotionLabels }
      )
    } catch (error) {
      const message = errorMessage(error)
      this.logger.warn(`[AI] staged 合成校验失败，退回无动作版本：${message}`)
      details.push(`合成：${message}`)
      try {
        validated = validateAndFixStory(
          composeStory(view, plan, dialogue, fallbackDirection(view, plan)),
          view,
          this.logger,
          { emotionLabels: this.emotionLabels }
        )
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

    let ttsTranslated = 0
    if (options.translateForTts ?? this.settings.translateForTts) {
      ttsTranslated = await this.translateTtsText(validated.story, options.signal)
    }

    const activeIds = new Set(validated.story.models.map((entry) => entry.id))
    const cast = view.models.filter((entry) => activeIds.has(entry.id)).map((entry) => entry.name)

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
        ttsTranslated,
        cast,
        stages
      }
    }
  }

  private ttsTranslator(signal?: AbortSignal): TtsBatchTranslator {
    const system =
      '你是中日翻译。只输出 JSON 字符串数组，不要解释、不要 markdown。把每条中文台词翻译成自然、口语化的日语，适合角色配音；保留原文换行位置和语气。'
    return async (texts) => {
      const { data } = await this.llm.chatJson<string[]>(
        [
          { role: 'system', content: system },
          {
            role: 'user',
            content: `把下面 ${texts.length} 条台词翻译成日语，只输出长度相同的 JSON 字符串数组：\n${JSON.stringify(texts)}`
          }
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
  private async translateTtsText(story: StoryData, signal?: AbortSignal): Promise<number> {
    const { translated } = await ensureJapaneseTtsText(
      story,
      this.ttsTranslator(signal),
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
