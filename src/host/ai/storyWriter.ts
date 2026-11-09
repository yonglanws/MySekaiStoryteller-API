import { ILogObj, Logger } from 'tslog'
import type { LlmSettings } from '../config'
import type { CatalogModel, ResourceCatalog } from '../resources/resourceCatalog'
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
  buildQuickCastPrompt,
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
  /** 各次 LLM 调用耗时之和；情绪/表演/翻译并行时会大于墙钟 */
  latencyMs: number
  /** 生成墙钟耗时（含翻译），毫秒 */
  durationMs: number
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
      const numeric = /^\d+$/.test(token)
      return (
        String(model.id) === token ||
        name === token ||
        shortName === token ||
        // 数字 token 只做精确 id 匹配；否则 cast ["1"] 会把 10~19 也一起选中
        (!numeric &&
          (String(model.id).toLowerCase().includes(token) ||
            model.path.toLowerCase().includes(token)))
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

  /**
   * single/chat 的前置快速选角：把 26 人缩到 1~2 人。
   *
   * 顺序：场景点名 → 沿用上一轮角色 → 一次很短的选角调用；失败保留全目录。
   * 这样主提示词只带入选角色的紧凑人设，而不是 26 份完整人设。
   */
  private async resolveFastCast(
    view: CatalogView,
    prompt: string,
    options: GenerateStoryOptions
  ): Promise<CatalogView> {
    if (view.models.length <= 2) return view

    const mentioned = view.models.filter((model) => {
      const fullName = model.name
      const shortName = model.shortName ?? ''
      return (
        (fullName.length > 0 && prompt.includes(fullName)) ||
        (shortName.length >= 2 && prompt.includes(shortName))
      )
    })
    if (mentioned.length > 0) {
      this.logger.info(
        `[AI] 场景点名角色：${mentioned
          .slice(0, 2)
          .map((model) => view.shortName(model))
          .join('、')}`
      )
      return view.withModels(mentioned.slice(0, 2))
    }

    const history = options.history ?? []
    for (let index = history.length - 1; index >= 0; index--) {
      const role = history[index]?.role ?? ''
      if (!role || ['user', 'assistant', 'system', '用户', '助手'].includes(role)) continue
      const model = view.models.find(
        (item) => item.name === role || (item.shortName ?? '') === role
      )
      if (model) {
        this.logger.info(`[AI] 沿用上一轮角色：${view.shortName(model)}`)
        return view.withModels([model])
      }
    }

    if (!this.llm.enabled) return view
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
          : (view.models.find((entry) => entry.name === text || (entry.shortName ?? '') === text) ??
            null)
        if (model && !cast.includes(model)) cast.push(model)
      }
      if (cast.length > 0) {
        this.logger.info(`[AI] 快速选角：${cast.map((model) => view.shortName(model)).join('、')}`)
        return view.withModels(cast.slice(0, 2))
      }
    } catch (error) {
      if (options.signal?.aborted) throw error
      this.logger.warn(`[AI] 快速选角失败，保留完整角色池：${errorMessage(error)}`)
    }
    return view
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
      mode === 'chat' ? 'single' : (options.pipeline ?? this.settings.pipeline ?? 'single')

    // staged 自带选角段；single/chat 先做一次很短的选角，避免主提示词装入全部人设。
    if (mode === 'chat' || pipeline === 'single') {
      view = await this.resolveFastCast(view, prompt, options)
    }

    const result =
      pipeline === 'staged'
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
            durationMs: 0,
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

    // ---- 2.5 情绪分段与日文翻译（与表演设计并行） ------------------------------------------------------------
    // 情绪标签只影响 TTS 音色，表演设计按台词文本自行判断语气；两段 LLM 调用并行，
    // 合成前再把情绪标签回填。翻译只依赖台词文本，也在同一时间启动。
    const finalDialogue = enforceDialogueLength ? softenPunctuation(dialogue) : dialogue
    const translateForTts = options.translateForTts ?? this.settings.translateForTts
    let dialogueTts: Promise<Map<string, string> | null> | null = null
    if (translateForTts) {
      dialogueTts = this.translateDialogue(finalDialogue, options.signal).catch((error) => {
        if (options.signal?.aborted) return null
        this.logger.warn(`[AI] 台词日文翻译失败，合成后再补：${errorMessage(error)}`)
        return null
      })
    }
    const emotionTask: Promise<Map<string, string> | null> = (async () => {
      if (this.emotionLabels.length === 0) return null
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
          markStageFailed('没有返回可用的情绪段', 'emotion')
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
          markStageFailed(`情绪分段太少（${runs} 段）`, 'emotion')
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
      return emotionPlan
    })()
    // 表演段报错/取消时可能不再等待情绪任务；挂一个空 catch，避免未处理的 Promise 拒绝。
    void emotionTask.catch(() => undefined)

    // ---- 3. 表演设计（与情绪标注并行） ---------------------------------------------------------------------
    // 情绪标签尚未回填，direction 直接按台词文本判断语气；提示词会切换成对应写法。
    const directionDialogue: StagedDialogue =
      this.emotionLabels.length > 0
        ? {
            ...finalDialogue,
            lines: finalDialogue.lines.map((line) => ({ ...line, emotion: '' }))
          }
        : finalDialogue
    let direction: StagedDirection = fallbackDirection(view, plan)
    let directionRaw = ''
    try {
      const result = await runStage(
        'direction',
        buildDirectionPrompt(view, plan, directionDialogue, promptOptions)
      )
      directionRaw = result.content
      direction = normalizeDirection(extractJson(result.content), view, plan, directionDialogue)
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
          buildDirectionRepairPrompt(view, plan, directionDialogue, promptOptions, directionRaw)
        )
        direction = normalizeDirection(extractJson(repair.content), view, plan, directionDialogue)
      } catch (error) {
        if (options.signal?.aborted) throw error
        details.push(`表演设计重写：${errorMessage(error)}`)
      }
    }
    if (direction.lines.length === 0) {
      warnings.push('表演设计不可用，已使用默认走位与无动作台词')
      direction = fallbackDirection(view, plan)
    }

    // ---- 3.4 回填情绪 ---------------------------------------------------------------------------------------
    const emotionPlan = await emotionTask
    dialogue = applyEmotionPlan(
      finalDialogue,
      emotionPlan ? stabilizeEmotions(dialogue, emotionPlan, this.emotionLabels) : null,
      this.emotionLabels
    )

    // ---- 3.5 收取并行翻译结果 ------------------------------------------------------------------------------
    // 背景翻译在情绪段之前已经启动，通常在表演设计期间就已完成；这里只做等待与写入。
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

    if (translateForTts) {
      ttsTranslated += await this.translateTtsText(validated.story, options.signal)
    }

    const activeIds = new Set(validated.story.models.map((entry) => entry.id))
    const cast = view.models.filter((entry) => activeIds.has(entry.id)).map((entry) => entry.name)

    // 情绪与表演并行后完成顺序不固定；按流水线顺序输出，便于日志与客户端展示。
    const stageOrder = [
      'cast',
      'dialogue',
      'dialogue-repair',
      'dialogue-expand',
      'dialogue-expand-2',
      'emotion',
      'emotion-repair',
      'direction',
      'direction-repair'
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
        stages
      }
    }
  }

  /**
   * 提前批量翻译一段台词稿，返回 lineId → 日文 ttsText。
   *
   * 只翻译、不校验；合成后还会走一次 ensureJapaneseTtsText 兜底（正常情况没有待翻条目）。
   * 在情绪/表演段之前启动，让翻译和两段 LLM 调用并行，不占串行尾时间。
   */
  private async translateDialogue(
    dialogue: StagedDialogue,
    signal?: AbortSignal
  ): Promise<Map<string, string>> {
    const slots = dialogue.lines.map((line) => ({
      line,
      data: { content: line.content, ttsText: '' }
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
      this.ttsTranslator(signal),
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

  private ttsTranslator(signal?: AbortSignal): TtsBatchTranslator {
    const system =
      '你是中日翻译。只输出 JSON 字符串数组，不要解释、不要 markdown。把每条中文台词翻译成自然、口语化的日语，适合角色配音；保留原文换行位置和语气。每条译文都必须含假名，不要输出纯汉字（例如「了解」要写成「了解です」）；标点和符号可以保留。'
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
