import type { ILogObj, Logger } from 'tslog'
import type { CatalogModel } from '../resources/resourceCatalog'
import type { StoryData } from '../../common/types/Story'
import type { AdaptiveRagRetriever } from '../rag/retriever'
import { selectUnitFewShotExcerpts } from './corpusExamples'
import {
  hasSpokenStageDirectionLeak,
  lintDialogueFidelity,
  repairSpokenStageDirections
} from './dialogueLinter'
import { annotateFacialName, inspectModelFacial } from './facialSemantics'
import {
  extractJson,
  LlmClient,
  LlmError,
  type ChatMessage,
  type ChatUsage,
  type LlmToolCall,
  type LlmToolDefinition
} from './llm'
import { lintOfficialStory } from './officialLinter'
import { dialoguePersonaPrompt, personaFor, type PersonaEntry } from './personas'
import { buildActingExample, type CatalogView } from './prompt'
import { CURATED_SCENARIO_SES } from './scenarioCues'
import { validateAndFixStory } from './validate'

export interface StoryAgentToolkitDeps {
  view: CatalogView
  personas: PersonaEntry[]
  emotionLabels?: string[]
  ragRetriever?: AdaptiveRagRetriever | null
  logger: Logger<ILogObj>
}

export interface StoryAgentToolkit {
  definitions: LlmToolDefinition[]
  execute: (name: string, rawArgs: unknown, signal?: AbortSignal) => Promise<string>
}

function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return {}
    }
  }
  return {}
}

function addUsage(acc: ChatUsage, delta: ChatUsage | null): void {
  if (!delta) return
  if (delta.promptTokens !== undefined) acc.promptTokens = (acc.promptTokens ?? 0) + delta.promptTokens
  if (delta.completionTokens !== undefined) {
    acc.completionTokens = (acc.completionTokens ?? 0) + delta.completionTokens
  }
  if (delta.totalTokens !== undefined) acc.totalTokens = (acc.totalTokens ?? 0) + delta.totalTokens
}

function findModel(view: CatalogView, modelId?: unknown, character?: unknown): CatalogModel | null {
  if (typeof modelId === 'number' && Number.isFinite(modelId)) {
    const byId = view.modelById(modelId)
    if (byId) return byId
  }
  const q = typeof character === 'string' ? character.trim().toLowerCase() : ''
  if (!q) return null
  return (
    view.models.find(
      (m) =>
        m.name.toLowerCase() === q ||
        (m.shortName ?? '').toLowerCase() === q ||
        m.name.toLowerCase().includes(q) ||
        q.includes((m.shortName ?? '').toLowerCase())
    ) ?? null
  )
}

function countBodyMotionsByModel(story: StoryData): Record<string, number> {
  const counts = new Map<number, number>()
  for (const m of story.models) {
    counts.set(m.id, 0)
  }
  for (const snippet of story.snippets) {
    const data = ('data' in snippet && snippet.data ? snippet.data : {}) as Record<string, unknown>
    if (snippet.type === 'Talk') {
      const actions = Array.isArray(data.actions) ? data.actions : []
      for (const act of actions) {
        if (!act || typeof act !== 'object') continue
        const rec = act as Record<string, unknown>
        if (typeof rec.motion === 'string' && rec.motion.trim()) {
          const mid = Number(rec.modelId ?? data.modelId)
          counts.set(mid, (counts.get(mid) ?? 0) + 1)
        }
      }
      if (typeof data.motion === 'string' && data.motion.trim()) {
        const mid = Number(data.modelId)
        counts.set(mid, (counts.get(mid) ?? 0) + 1)
      }
    } else if (snippet.type === 'Motion' || snippet.type === 'Move') {
      if (typeof data.motion === 'string' && data.motion.trim()) {
        const mid = Number(data.modelId)
        counts.set(mid, (counts.get(mid) ?? 0) + 1)
      }
    }
  }
  const out: Record<string, number> = {}
  for (const m of story.models) {
    out[`${m.id}`] = counts.get(m.id) ?? 0
  }
  return out
}

/**
 * 构建供 Agentic Loop 使用的工具集：角色人设查询、motion3 表情语义、资源检索、官方语料检索、对白与成片双重校验。
 */
export function createStoryAgentToolkit(deps: StoryAgentToolkitDeps): StoryAgentToolkit {
  const { view, personas, emotionLabels = [], ragRetriever, logger } = deps

  const definitions: LlmToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'lookup_character',
        description:
          '查询角色的 modelId、模型路径、性格人设、说话口吻、口头禅与称呼习惯。写对白前可查询确认 OOC 细节。',
        parameters: {
          type: 'object',
          properties: {
            character: {
              type: 'string',
              description: '角色全名、简称或关键字（留空则返回当前可选全员摘要）'
            },
            modelId: { type: 'number', description: '可选角色 modelId' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'inspect_character_expressions',
        description:
          '查询指定角色的可用身体动作（motion）与带 motion3 语义注释的表情（facial，区分苦笑/闭眼微笑/阴暗冷脸等），防止表情与剧情情绪错配。',
        parameters: {
          type: 'object',
          properties: {
            modelId: { type: 'number', description: '角色 modelId' },
            character: { type: 'string', description: '角色名或简称（未传 modelId 时使用）' },
            mood: {
              type: 'string',
              description: '按情绪或动作关键词筛选，例如：伤心、苦笑、微笑、生气、点头、思考'
            },
            kind: {
              type: 'string',
              enum: ['all', 'motion', 'facial'],
              description: '只查动作、只查表情或全查（默认 all）'
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_assets',
        description: '检索目录中真实存在的背景（background）、BGM 音乐与官方音效（se），避免编造资源名。',
        parameters: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['background', 'bgm', 'se', 'all'],
              description: '资源类别'
            },
            query: { type: 'string', description: '场景/时段/氛围关键词，如 夜晚、教室、钢琴、脚步' },
            limit: { type: 'number', description: '最多返回条数（默认 12）' }
          },
          required: ['kind']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_official_corpus',
        description: '检索 Project SEKAI 官方剧情语料示例与对白节奏参考，用于把握角色真实口吻与互动断句（严禁照抄原句）。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '剧情事件、关系或地点关键词' },
            stage: {
              type: 'string',
              enum: ['cast', 'dialogue', 'acting'],
              description: '参考阶段（默认 dialogue）'
            }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'validate_dialogue_draft',
        description:
          '用规则质检器检查台词草稿：检测括号动作提示泄露（如 (微笑)/(挠头)）、AI 抒情套话、结尾说教、齐整句长与文本框溢出，同时允许正常括号心里话。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            lines: {
              type: 'array',
              description: '台词数组 [{ id?, speaker, content }]',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  speaker: { type: 'string' },
                  content: { type: 'string' }
                },
                required: ['speaker', 'content']
              }
            }
          },
          required: ['lines']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'validate_story_draft',
        description:
          '运行完整 Schema 校验 + 官方舞台规范检查（入场冲突、双人同瞬动作、动作切换分布、括号动作泄露、背景与资源合法性），返回可直接修复的问题列表。',
        parameters: {
          type: 'object',
          properties: {
            story: {
              type: 'object',
              description: '完整 StoryData JSON 对象（含 models、images、snippets）'
            }
          },
          required: ['story']
        }
      }
    }
  ]

  const execute = async (
    name: string,
    rawArgs: unknown,
    signal?: AbortSignal
  ): Promise<string> => {
    const args = parseToolArgs(rawArgs)
    if (name === 'lookup_character') {
      const target = findModel(view, args.modelId, args.character)
      const list = target ? [target] : view.primaryModels()
      return JSON.stringify({
        characters: list.map((m) => {
          const persona = personaFor(personas, m)
          return {
            modelId: m.id,
            name: m.name,
            shortName: view.shortName(m),
            path: m.path,
            persona: persona ? dialoguePersonaPrompt(persona) : '（按该角色官方设定演绎）'
          }
        })
      })
    }

    if (name === 'inspect_character_expressions') {
      const model = findModel(view, args.modelId, args.character)
      if (!model) {
        return JSON.stringify({
          error: '未找到指定角色',
          available: view.models.map((m) => ({ modelId: m.id, name: view.shortName(m) }))
        })
      }
      const mood = typeof args.mood === 'string' ? args.mood.trim().toLowerCase() : ''
      const kind = typeof args.kind === 'string' ? args.kind : 'all'
      const allMotions = view.promptMotions(model)
      const allFacials = view.promptFacials(model)
      const filterText = (items: string[], extraLabel?: (s: string) => string): string[] => {
        if (!mood) return items
        const hits = items.filter((item) => {
          const text = `${item} ${extraLabel ? extraLabel(item) : ''}`.toLowerCase()
          return mood.split(/[\s,，/]+/).some((tok) => tok && text.includes(tok))
        })
        return hits.length > 0 ? hits : items
      }
      const motions =
        kind === 'facial' ? [] : filterText(allMotions).slice(0, 20)
      const facials =
        kind === 'motion'
          ? []
          : filterText(allFacials, (f) => inspectModelFacial(model.path, f).label)
              .slice(0, 24)
              .map((f) => annotateFacialName(model.path, f))
      return JSON.stringify({
        modelId: model.id,
        name: view.shortName(model),
        ...(motions.length > 0 ? { motions } : {}),
        ...(facials.length > 0 ? { facials } : {})
      })
    }

    if (name === 'search_assets') {
      const kind = typeof args.kind === 'string' ? args.kind : 'all'
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      const limit =
        typeof args.limit === 'number' && Number.isFinite(args.limit)
          ? Math.max(1, Math.min(25, Math.round(args.limit)))
          : 12
      const result: Record<string, unknown> = {}
      if (kind === 'background' || kind === 'all') {
        result.backgrounds = view.imagePromptChoices(limit, query).map((b) => ({
          file: b.file,
          name: b.name,
          timeOfDay: b.timeOfDay,
          description: b.description
        }))
      }
      if (kind === 'bgm' || kind === 'all') {
        result.bgm = view.bgmPromptChoices(limit, query).map((b) => ({
          file: b.file,
          name: b.name,
          mood: b.mood,
          description: b.description
        }))
      }
      if (kind === 'se' || kind === 'all') {
        const seItems = view.seDetailsList().length > 0
          ? view.seDetailsList().map((s) => ({
              file: s.file,
              name: s.name,
              description: s.description
            }))
          : CURATED_SCENARIO_SES.map((s) => ({
              file: s.file,
              name: s.id,
              description: s.description
            }))
        const q = query.toLowerCase()
        const filtered = q
          ? seItems.filter((s) => `${s.file} ${s.name} ${s.description}`.toLowerCase().includes(q))
          : seItems
        result.se = (filtered.length > 0 ? filtered : seItems).slice(0, limit)
      }
      return JSON.stringify(result)
    }

    if (name === 'search_official_corpus') {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      const stage: 'cast' | 'dialogue' =
        args.stage === 'cast' ? 'cast' : 'dialogue'
      const excerpts = selectUnitFewShotExcerpts(
        view.primaryModels().slice(0, 3).map((m) => ({ name: view.shortName(m), path: m.path })),
        query
      )
      let ragText = ''
      if (ragRetriever && query) {
        try {
          const retrieved = await ragRetriever.retrieve({
            prompt: query,
            stage,
            cast: view.primaryModels().slice(0, 4).map((m) => ({
              name: view.shortName(m),
              fullName: m.name
            })),
            signal
          })
          ragText = retrieved?.promptBlock ?? ''
        } catch (error) {
          logger.debug(`[AgentTool] RAG query failed: ${String(error)}`)
        }
      }
      return JSON.stringify({
        note: '仅学习称呼、断句、潜台词与留白节奏，严禁照抄原句',
        excerpts: ragText || excerpts || '（当前查询暂无额外语料，请严格遵循角色口吻）'
      })
    }

    if (name === 'validate_dialogue_draft') {
      const rawLines = Array.isArray(args.lines) ? args.lines : []
      const lines = rawLines
        .filter((l): l is Record<string, unknown> => Boolean(l && typeof l === 'object'))
        .map((l, idx) => ({
          id: typeof l.id === 'string' && l.id.trim() ? l.id.trim() : `l${idx + 1}`,
          speaker: typeof l.speaker === 'string' ? l.speaker.trim() : '',
          content: typeof l.content === 'string' ? l.content : ''
        }))
        .filter((l) => l.content.trim().length > 0)
      const lint = lintDialogueFidelity(
        { title: typeof args.title === 'string' ? args.title : '', lines },
        {
          cast: view.primaryModels().map((m) => ({
            modelId: m.id,
            name: view.shortName(m),
            fullName: m.name,
            path: m.path,
            role: ''
          }))
        }
      )
      const stageDirectionFixes = lines
        .filter((l) => hasSpokenStageDirectionLeak(l.content))
        .map((l) => ({
          id: l.id,
          before: l.content,
          repaired: repairSpokenStageDirections(l.content)
        }))
      return JSON.stringify({
        ok: !lint.shouldPolish && lint.issues.length === 0 && stageDirectionFixes.length === 0,
        lineCount: lines.length,
        issues: lint.issues,
        stageDirectionFixes
      })
    }

    if (name === 'validate_story_draft') {
      const candidate =
        args.story && typeof args.story === 'object' ? args.story : args
      try {
        const { story, warnings } = validateAndFixStory(candidate, view, logger, {
          emotionLabels
        })
        const report = lintOfficialStory(story, view)
        const bodyMotions = countBodyMotionsByModel(story)
        const zeroMotionModels = story.models
          .filter((m) => (bodyMotions[String(m.id)] ?? 0) === 0)
          .map((m) => m.id)
        const stageLeaks = story.snippets
          .map((s, idx) => ({ idx, s }))
          .filter(
            ({ s }) =>
              s.type === 'Talk' &&
              'data' in s &&
              hasSpokenStageDirectionLeak(String((s.data as Record<string, unknown>)?.content ?? ''))
          )
          .map(({ idx }) => idx)

        return JSON.stringify({
          schemaValid: true,
          officialPassed: report.passed && zeroMotionModels.length === 0 && stageLeaks.length === 0,
          warnings: warnings.slice(0, 12),
          officialIssues: report.issues,
          zeroMotionModelIds: zeroMotionModels,
          stageDirectionLeakSnippetIndices: stageLeaks,
          metrics: {
            talkCount: report.metrics.talkCount,
            talkZeroDelayShare: report.metrics.talkZeroDelayShare,
            appearMotionClashCount: report.metrics.appearMotionClashCount,
            inPlaceAppearShare: report.metrics.inPlaceAppearShare,
            bodyMotionsByModel: bodyMotions
          }
        })
      } catch (error) {
        return JSON.stringify({
          schemaValid: false,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    return JSON.stringify({ error: `未知工具：${name}` })
  }

  return { definitions, execute }
}

export interface AgenticGenerationOptions {
  llm: LlmClient
  view: CatalogView
  personas: PersonaEntry[]
  scene: string
  targetMinutes: number
  emotionLabels?: string[]
  ragRetriever?: AdaptiveRagRetriever | null
  logger: Logger<ILogObj>
  maxToolTurns?: number
  signal?: AbortSignal
}

export interface AgenticGenerationResult {
  story: StoryData
  warnings: string[]
  rounds: number
  latencyMs: number
  model: string
  usage: ChatUsage | null
  toolCallsUsed: string[]
  modeUsed: 'native' | 'react-json'
}

/**
 * 运行 Agentic Tool-Calling 剧本生成闭环：
 * 1. 优先使用 OpenAI 原生 tools / function calling 让模型按需查询人设、motion3 表情语义、资源、官方语料，并在定稿前调用校验工具自检修复；
 * 2. 若底层模型或网关不支持原生 tools（返回 400/404/422/501），自动无缝切换至 ReAct JSON 工具信封模式，同样可调用全部工具并自检定稿。
 */
export async function runAgenticStoryGeneration(
  options: AgenticGenerationOptions
): Promise<AgenticGenerationResult> {
  const {
    llm,
    view,
    personas,
    scene,
    targetMinutes,
    emotionLabels = [],
    ragRetriever,
    logger,
    signal
  } = options
  const maxToolTurns = Math.max(2, options.maxToolTurns ?? 8)
  const toolkit = createStoryAgentToolkit({
    view,
    personas,
    emotionLabels,
    ragRetriever,
    logger
  })

  const castSummary = view
    .primaryModels()
    .slice(0, 12)
    .map((m) => `${view.shortName(m)}(modelId=${m.id}, path=${m.path})`)
    .join('；')
  const emotionNote =
    emotionLabels.length > 0
      ? `每条 Talk 填 emotion（可选：${emotionLabels.join('、')}，日常陈述选「${emotionLabels.includes('平静') ? '平静' : emotionLabels[0]}」）。`
      : ''

  const sharedRules = [
    '你是 Project SEKAI 风格视觉小说导演 Agent。请通过工具按需查询角色人设、带 motion3 语义的表情、官方语料及真实背景/BGM，写出贴近原作且表演自然的 StoryData JSON。',
    '创作硬规范（务必遵守）：',
    '1. 表情匹配：先用 inspect_character_expressions 看清括号语义（如苦笑/闭眼微笑/阴暗冷脸），严禁悲伤/生气/道歉时误选真笑脸。',
    '2. 动作平衡与防撞：同一句 Talk 绝不同时触发说话者和听者身体动作，但务必让在场双方各自都有自然的动作开关（可在说话者静止句安排听者动作，或插入独立 Motion 片段），不要让任何在场角色全程 0 动作。',
    '3. 不强制分幕：同一时间地点连续对话保持 1 幕即可；仅在换地点、跳时间、回忆或出入 SEKAI 时才换背景/分幕。',
    '4. 放宽双人同框：日常对话 Left/Right 同框，角色内心独白或沉思时允许用 LayoutClear + LayoutAppear(Center)（或 Move 到 Center）切单人特写，之后再切回 Left/Right。',
    '5. 禁止括号动作提示：台词中只写说出口的话或心理独白（如「（……怎么办才好）」），严禁夹带「（微笑）」「（挠头）」「（叹气）」等舞台动作括号。',
    '6. 排版与定稿：每条 Talk 最多 3 行（每行<=30字宽），不写 ttsText；成稿前可调 validate_story_draft 自检一次，确认官方校验通过后再输出最终 JSON。',
    emotionNote
  ]
    .filter(Boolean)
    .join('\n')

  const exampleSnippet = buildActingExample(view)
  const userPrompt = [
    `场景要求：${scene}`,
    `目标时长：约 ${targetMinutes} 分钟`,
    `可选角色摘要：${castSummary}`,
    `JSON 结构示例：\n\`\`\`json\n${exampleSnippet}\n\`\`\``,
    '请合理使用工具核实关键角色人设、表情、资源或校验结果，最后输出完整合法的 StoryData JSON（仅含 models、images、snippets，可选 bgm）。'
  ].join('\n\n')

  const totalUsage: ChatUsage = {}
  let totalLatency = 0
  let lastModel = llm.model
  const toolCallsUsed: string[] = []
  let rounds = 0

  const tryFinalize = (rawContent: string): { ok: true; story: StoryData; warnings: string[] } | { ok: false; error: string } => {
    try {
      const parsed = extractJson(rawContent)
      const { story, warnings } = validateAndFixStory(parsed, view, logger, { emotionLabels })
      const report = lintOfficialStory(story, view)
      if (!report.passed && report.issues.length > 0) {
        return {
          ok: false,
          error: `官方剧本检查未通过：${report.issues.slice(0, 4).join('；')}`
        }
      }
      return { ok: true, story, warnings }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  // ---- 模式 1：OpenAI 原生 function calling ----
  const nativeMessages: ChatMessage[] = [
    { role: 'system', content: sharedRules },
    { role: 'user', content: userPrompt }
  ]

  let switchToReactFallback = false
  for (let turn = 0; turn < maxToolTurns; turn++) {
    rounds += 1
    const isFinalTurn = turn >= maxToolTurns - 1
    try {
      const res = await llm.chat(
        isFinalTurn
          ? [
              ...nativeMessages,
              {
                role: 'user',
                content:
                  '工具调用轮次已达上限，请立即综合以上已获取信息直接输出最终完整合法的 StoryData JSON（仅含 models、images、snippets）。'
              }
            ]
          : nativeMessages,
        isFinalTurn
          ? { json: true, signal }
          : {
              tools: toolkit.definitions,
              toolChoice: 'auto',
              signal
            }
      )
      totalLatency += res.latencyMs
      lastModel = res.model
      addUsage(totalUsage, res.usage)

      const calls: LlmToolCall[] = res.toolCalls ?? []
      if (calls.length > 0) {
        nativeMessages.push({
          role: 'assistant',
          content: res.content || null,
          tool_calls: calls
        })
        for (const call of calls) {
          toolCallsUsed.push(call.function.name)
          const output = await toolkit.execute(call.function.name, call.function.arguments, signal)
          nativeMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: output
          })
        }
        continue
      }

      const finalized = tryFinalize(res.content)
      if (finalized.ok) {
        return {
          story: finalized.story,
          warnings: finalized.warnings,
          rounds,
          latencyMs: totalLatency,
          model: lastModel,
          usage: Object.keys(totalUsage).length > 0 ? totalUsage : null,
          toolCallsUsed,
          modeUsed: 'native'
        }
      }
      if (turn + 1 < maxToolTurns) {
        nativeMessages.push({ role: 'assistant', content: res.content.slice(0, 20_000) })
        nativeMessages.push({
          role: 'user',
          content: `最终输出未通过校验：${finalized.error}。请修正后只输出合法的 StoryData JSON。`
        })
        continue
      }
      throw new LlmError(`Agentic 输出未通过校验：${finalized.error}`)
    } catch (error) {
      if (error instanceof LlmError && error.toolCallingUnsupported) {
        logger.info('[AI] 当前模型/网关不支持原生 tool calling，自动切换至 ReAct JSON 工具信封回退模式')
        switchToReactFallback = true
        break
      }
      throw error
    }
  }

  if (!switchToReactFallback) {
    throw new LlmError(`Agentic 模式在 ${maxToolTurns} 轮内未输出可通过校验的最终剧本`)
  }

  // ---- 模式 2：无原生 tools 支持时的 ReAct JSON 工具信封回退 ----
  const toolCatalogText = toolkit.definitions
    .map(
      (def) =>
        `- ${def.function.name}: ${def.function.description} 参数: ${JSON.stringify(def.function.parameters)}`
    )
    .join('\n')

  const reactMessages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        sharedRules,
        '',
        '## 可用工具（ReAct JSON 协议）',
        toolCatalogText,
        '每一轮只输出一个合法 JSON 对象：',
        '- 需要调工具时输出：{"tool_call":{"name":"工具名","arguments":{...}}}',
        '- 准备好交卷时输出：{"final":{...完整StoryData...}} 或直接输出 StoryData JSON（含 models、images、snippets）。'
      ].join('\n')
    },
    { role: 'user', content: userPrompt }
  ]

  for (let turn = 0; turn < maxToolTurns; turn++) {
    rounds += 1
    const res = await llm.chat(reactMessages, { json: true, signal })
    totalLatency += res.latencyMs
    lastModel = res.model
    addUsage(totalUsage, res.usage)

    let parsed: Record<string, unknown> | null = null
    try {
      const val = extractJson(res.content)
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        parsed = val as Record<string, unknown>
      }
    } catch (error) {
      if (turn + 1 >= maxToolTurns) throw error
      reactMessages.push({ role: 'assistant', content: res.content.slice(0, 20_000) })
      reactMessages.push({
        role: 'user',
        content: `输出不是合法 JSON（${error instanceof Error ? error.message : String(error)}），请严格输出 {"tool_call":...} 或 {"final":...}。`
      })
      continue
    }

    if (parsed?.tool_call && typeof parsed.tool_call === 'object') {
      const tc = parsed.tool_call as Record<string, unknown>
      const fnName = typeof tc.name === 'string' ? tc.name.trim() : ''
      if (fnName) {
        toolCallsUsed.push(fnName)
        const output = await toolkit.execute(fnName, tc.arguments, signal)
        reactMessages.push({ role: 'assistant', content: res.content.slice(0, 10_000) })
        reactMessages.push({
          role: 'user',
          content: `工具 ${fnName} 返回结果：\n${output}\n\n请继续调用下一个工具或输出 {"final": ...完整StoryData...}。`
        })
        continue
      }
    }

    const candidateObj =
      parsed && 'final' in parsed && parsed.final && typeof parsed.final === 'object'
        ? parsed.final
        : parsed
    const finalized = tryFinalize(JSON.stringify(candidateObj))
    if (finalized.ok) {
      return {
        story: finalized.story,
        warnings: finalized.warnings,
        rounds,
        latencyMs: totalLatency,
        model: lastModel,
        usage: Object.keys(totalUsage).length > 0 ? totalUsage : null,
        toolCallsUsed,
        modeUsed: 'react-json'
      }
    }
    if (turn + 1 < maxToolTurns) {
      reactMessages.push({ role: 'assistant', content: res.content.slice(0, 20_000) })
      reactMessages.push({
        role: 'user',
        content: `最终剧本未通过校验：${finalized.error}。请修正并输出 {"final": ...}。`
      })
      continue
    }
    throw new LlmError(`ReAct 回退模式未通过校验：${finalized.error}`)
  }

  throw new LlmError(`ReAct 回退模式在 ${maxToolTurns} 轮内未完成剧本生成`)
}
