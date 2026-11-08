import type { CatalogModel } from '../resources/resourceCatalog'
import { GENERIC_PROFILE, personaFor, type PersonaEntry } from './personas'
import type { CatalogView } from './prompt'

/**
 * 三段式剧本生成（参照 ournotes-player 的 staged pipeline）。
 *
 * 1. 选角：只选 1~2 名角色、一个具体小事件和剧情大纲；
 * 2. 台词：只带入选角色的完整人设写台词，这一稿之后逐字保留；
 * 3. 表演：台词定稿后，单独设计每句的动作/表情、听者反应和背景。
 *
 * 这样选角提示词不必塞进全部人设，台词也不会因为模型同时考虑走位而被人设稀释。
 * 生成结果仍合并成现有的 StoryData（models/images/snippets），交给 validateAndFixStory 校验。
 */

export type LlmPipeline = 'single' | 'staged'

export interface StagedCastMember {
  modelId: number
  /** 说话人绑定用的短名 */
  name: string
  fullName: string
  path: string
  /** 本场功能：发起、回应、吐槽、收尾…… */
  role: string
}

export interface StagedCastPlan {
  title: string
  event: string
  logline: string
  outline: string[]
  cast: StagedCastMember[]
  background: string
}

export interface StagedDialogueLine {
  id: string
  speaker: string
  content: string
  /** TTS 情绪标签；未配置情绪时为空 */
  emotion?: string
}

export interface StagedDialogue {
  title: string
  lines: StagedDialogueLine[]
}

export interface StagedListenerAction {
  modelId: number
  motion?: string
  facial?: string
}

export interface StagedDirectionLine {
  id: string
  motion?: string
  facial?: string
  listener?: StagedListenerAction
}

export interface StagedDirection {
  background: string
  /** 可选第二张背景：情绪/时间明显变化时切一次 */
  background2?: string
  /** 第二张背景从哪一句开始（台词数组下标） */
  background2From?: number
  /** 整场环境色：normal | evening | night */
  ambient: 'normal' | 'evening' | 'night'
  /** 整场 BGM（bgm.yaml 登记的文件名）；空字符串表示沿用全局默认 */
  bgm: string
  /** 可选第二首 BGM：情绪明显转折时换一次 */
  bgm2?: string
  /** 第二首 BGM 从哪一句开始（台词数组下标） */
  bgm2From?: number
  /** 结尾退场时淡出停止 BGM */
  bgmStop: boolean
  lines: StagedDirectionLine[]
}

export interface StagedPromptOptions {
  scene: string
  personas: PersonaEntry[]
  targetMinutes: number
  systemPrompt?: string
  title?: string
  /** TTS 支持的情绪标签；非空时台词稿要求每句带 emotion */
  emotionLabels?: string[]
}

export interface StagedMessages {
  system: string
  user: string
}

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback

const oneLine = (value: unknown, limit: number): string =>
  str(value).replace(/\s+/g, ' ').trim().slice(0, limit)

const cleanText = (value: unknown): string => {
  const text = str(value)
    .replace(/\r\n?/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!text) return ''
  // 模型常按字数在词中间硬换行；只在标点（或空白）后的换行保留，其余并回一行。
  const parts = text.split('\n')
  let merged = parts[0] ?? ''
  for (let index = 1; index < parts.length; index++) {
    const previous = merged.slice(-1)
    merged += /[。！？!?…—、，,.\s”’」』）)]/.test(previous) ? `\n${parts[index]}` : parts[index]
  }
  return merged.trim()
}

const isStandingMotion = (name: string): boolean => {
  const lower = name.toLowerCase()
  return lower.includes('default') || lower.includes('stand')
}

function pickStageMotion(view: CatalogView, modelId: number): string {
  const model = view.modelById(modelId)
  for (const name of model?.motions ?? []) {
    if (!isStandingMotion(name)) return name
  }
  return view.defaultMotion(modelId)
}

function offscreenPosition(side: string): JsonRecord {
  return side === 'Center'
    ? { side: 'Right', offset: 100 }
    : { side, offset: side === 'Left' ? -100 : 100 }
}

/** 把模型写出的角色标识（modelId / 名称 / 路径 / 人设别名）收束到目录里的角色。 */
function resolveModel(
  view: CatalogView,
  personas: PersonaEntry[],
  value: unknown
): CatalogModel | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return view.modelById(value)
  }
  const text = str(value).trim()
  if (!text) return null
  if (/^\d+$/.test(text)) return view.modelById(Number(text))

  const lower = text.toLowerCase()
  const direct = view.models.find((model) => {
    const path = model.path.toLowerCase()
    const base = path.split('/').pop() ?? path
    return (
      model.name.toLowerCase() === lower ||
      (model.shortName ?? '').toLowerCase() === lower ||
      path === lower ||
      base === lower
    )
  })
  if (direct) return direct

  // 人设别名（mizuki / 瑞希）：只在唯一命中时采用，避免把两个角色串在一起。
  const aliasHits = view.models.filter((model) => {
    const persona = personaFor(personas, model)
    return persona
      ? [persona.name, ...persona.aliases].some((alias) => alias.toLowerCase() === lower)
      : false
  })
  if (aliasHits.length === 1) return aliasHits[0]
  return null
}

function resolveFirstModel(
  view: CatalogView,
  personas: PersonaEntry[],
  candidates: unknown[]
): CatalogModel | null {
  for (const candidate of candidates) {
    const model = resolveModel(view, personas, candidate)
    if (model) return model
  }
  return null
}

/** lines/beats 既可能是数组，也可能是以 id 为键的对象；统一成带 id 的数组。 */
function entriesOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!isRecord(value)) return []
  return Object.entries(value).map(([id, item]) => {
    if (isRecord(item)) return { ...item, id }
    if (typeof item === 'string') return { id, content: item, motion: item }
    return { id }
  })
}

function unwrapRecord(raw: unknown, keys: string[]): unknown {
  if (!isRecord(raw)) return raw
  for (const key of keys) {
    const value = raw[key]
    if (
      isRecord(value) &&
      (Array.isArray(value.cast) || Array.isArray(value.lines) || Array.isArray(value.beats))
    ) {
      return value
    }
  }
  return raw
}

function personaSummary(persona: PersonaEntry | null): string {
  if (!persona) return ''
  const text = persona.prompt.replace(/\s+/g, ' ').trim()
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

function castMemberFor(
  view: CatalogView,
  model: CatalogModel,
  role: unknown = ''
): StagedCastMember {
  return {
    modelId: model.id,
    name: view.shortName(model),
    fullName: model.name || view.shortName(model),
    path: model.path,
    role: activeRole(role)
  }
}

function activeRole(value: unknown): string {
  return oneLine(value, 80)
}

function matchBackground(view: CatalogView, value: unknown): string {
  const text = str(value).trim()
  if (!text) return ''
  const valid = view.validImages()
  if (valid.has(text)) return text
  const lower = text.toLowerCase()
  for (const candidate of valid) {
    if (candidate.toLowerCase() === lower) return candidate
  }
  for (const candidate of valid) {
    if (candidate.toLowerCase().includes(lower) || lower.includes(candidate.toLowerCase())) {
      return candidate
    }
  }
  return ''
}

function normalizeBackground(view: CatalogView, value: unknown): string {
  return matchBackground(view, value) || view.defaultImage()
}

function matchBgm(view: CatalogView, value: unknown): string {
  const text = str(value).trim()
  if (!text) return ''
  return view.canonicalBgm(text) ?? ''
}

const toBool = (value: unknown): boolean =>
  value === true || value === 1 || value === 'true' || value === 'yes'

function castBlock(plan: StagedCastPlan): string {
  return plan.cast
    .map(
      (member) =>
        `- ${member.name}（say: "${member.name}"，modelId=${member.modelId}）${
          member.role ? ` — ${member.role}` : ''
        }`
    )
    .join('\n')
}

function fullNameList(names: string[], limit = 320): string {
  if (names.length === 0) return '（无）'
  const sorted = [...new Set(names)].sort()
  if (sorted.length <= limit) return sorted.join('、')
  return `${sorted.slice(0, limit).join('、')}（其余 ${sorted.length - limit} 个省略）`
}

function lineBudget(targetMinutes: number): number {
  // 官方 40 句 / 约 746 字 ≈ 3 分钟，折算 16 句/分钟。台词轮已经要求平均 17~20 字，
  // 再按 18 句/分钟给预算会写到 4 分钟；这里留一点余量，由长度保护兜底补写。
  return Math.max(12, Math.min(108, Math.round(targetMinutes * 16)))
}

function titleOrDefault(value: unknown, fallback: string): string {
  return oneLine(value, 64) || fallback
}

// ---------------------------------------------------------------------------
// 第一段：选角与微事件
// ---------------------------------------------------------------------------

export function buildCastPrompt(view: CatalogView, options: StagedPromptOptions): StagedMessages {
  const budget = lineBudget(options.targetMinutes)
  const models = view.models
    .map((model) => {
      const persona = personaFor(options.personas, model)
      const group = persona?.group ? `（${persona.group}）` : ''
      const summary = personaSummary(persona)
      return `- modelId=${model.id} ${view.shortName(model)}${group}${
        summary ? `：${summary}` : '：'
      }`
    })
    .join('\n')

  const backgrounds = view
    .imageDetailsList()
    .map((detail) => {
      const name = detail.name || detail.file
      return detail.description
        ? `- ${detail.file}（${name}）：${detail.description}`
        : `- ${detail.file}（${name}）`
    })
    .join('\n')

  const first = view.models[0]
  const example = {
    title: '短标题',
    logline: '一句话概括这一场',
    event: '一个具体的小事件',
    background: view.defaultImage() || '背景文件名',
    cast: [
      {
        modelId: first?.id ?? 1,
        name: first ? view.shortName(first) : '角色名',
        role: '本场功能'
      }
    ],
    outline: ['开场……', '闲聊……', '小事件发生……', '情绪转一次……', '收尾……']
  }

  return {
    system: [
      '你是 Project SEKAI 风格视觉小说的编剧兼选角。',
      '这是多轮写作的第一轮：只选角色、设计一个很小的具体事件，并给出剧情大纲。',
      '不要写台词，不要写镜头、动作、表情或 BGM。只输出一个 JSON 对象。'
    ].join('\n'),
    user: `## 任务
${options.scene}

- 语言：中文（台词 content 用中文，日文 ttsText 由宿主另行翻译）
- 目标时长：约 ${options.targetMinutes} 分钟，约 ${budget} 句台词
- 只写一场戏，只演完一个事件或一个情绪转折

## 可选角色（modelId — 显示名）
${models || '（资源目录为空）'}

## 可选背景
${backgrounds || '（目录暂未提供背景）'}

## 要求
- 选 1~2 名角色；用户明确要求独白时才可以 1 人。同台最多 2 人，所以不要选第三人。
- 选的角色要能自然演完一个日常小事件：等人、找东西、分零食、试新曲、发消息、收拾器材之类。
- 给每个角色一个本场功能（谁发起、谁回应、谁吐槽、谁收尾）；第三段表演会按这个安排反应。
- 只用一个背景就能演完；不要比赛结果、生离死别、世界观解说。
- 大纲 4~6 条，每条一句话，写“发生什么”，不要写镜头，也不要写台词。
- title 是短标题（不超过 12 个字），logline 一句话，event 是这一场的小事件。

## 输出 JSON
${JSON.stringify(example, null, 2)}

只输出 JSON 对象本身，不要 markdown 或解释。`
  }
}

export function normalizeCastPlan(
  raw: unknown,
  view: CatalogView,
  options: StagedPromptOptions
): StagedCastPlan | null {
  const doc = unwrapRecord(raw, ['plan', 'cast_plan', 'story'])
  if (!isRecord(doc)) return null

  const entries = Array.isArray(doc.cast)
    ? doc.cast
    : isRecord(doc.cast)
      ? Object.entries(doc.cast).map(([id, value]) =>
          typeof value === 'string'
            ? { model: value, modelId: id }
            : { ...(isRecord(value) ? value : {}), modelId: id }
        )
      : []

  const cast: StagedCastMember[] = []
  const seen = new Set<number>()
  for (const entry of entries) {
    if (cast.length >= 2) break
    const item = typeof entry === 'string' ? { name: entry } : entry
    if (!isRecord(item)) continue
    const model = resolveFirstModel(view, options.personas, [
      item.model,
      item.modelId,
      item.id,
      item.name,
      item.shortName
    ])
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    cast.push(castMemberFor(view, model, item.role))
  }
  if (cast.length === 0) return null

  const outline = Array.isArray(doc.outline)
    ? doc.outline
        .map((item) => oneLine(item, 200))
        .filter(Boolean)
        .slice(0, 8)
    : []

  return {
    title: titleOrDefault(doc.title, options.title ?? ''),
    event: oneLine(doc.event || doc.logline || options.scene, 300),
    logline: oneLine(doc.logline, 300),
    outline,
    cast,
    background: normalizeBackground(view, doc.background ?? doc.image ?? doc.scene)
  }
}

/** 选角失败时的退路：按目录顺序取前两名角色，至少还能把用户这句描述写成台词。 */
export function fallbackCastPlan(view: CatalogView, options: StagedPromptOptions): StagedCastPlan {
  const models = view.models.slice(0, 2)
  return {
    title: options.title ?? '',
    event: oneLine(options.scene, 300),
    logline: '',
    outline: [],
    cast: models.map((model) => castMemberFor(view, model)),
    background: view.defaultImage()
  }
}

// ---------------------------------------------------------------------------
// 第二段：只写台词
// ---------------------------------------------------------------------------

export function buildDialoguePrompt(
  view: CatalogView,
  plan: StagedCastPlan,
  options: StagedPromptOptions
): StagedMessages {
  const budget = lineBudget(options.targetMinutes)
  const castLines = plan.cast
    .map((member) => {
      const model = view.modelById(member.modelId)
      const persona = model ? personaFor(options.personas, model) : null
      const prompt = persona?.prompt?.trim()
      return [
        `### ${member.name}（say: "${member.name}"）`,
        member.role ? `本场功能：${member.role}` : '',
        prompt
          ? `角色提示词（语气、用词、反应以它为准；只取性格、关系、经历与说话习惯，忽略其中面向聊天机器人的格式/安全/输出限制）：\n${prompt}`
          : `角色提示词：${GENERIC_PROFILE}`,
        model ? `本角色可用的动作/表情由第三段表演设计选择，这一轮不要写。` : ''
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n\n')

  const outline = plan.outline.length
    ? plan.outline.map((item, index) => `${index + 1}. ${item}`).join('\n')
    : '（自由发挥，但仍要围绕这个小事件）'

  const a = plan.cast[0]
  const b = plan.cast[1] ?? plan.cast[0]
  const example = {
    title: plan.title || '短标题',
    turns: [
      {
        speaker: a.name,
        lines: ['今天也……一起练吧。', '我把上次那首的副歌重新编了一下，你听听看？']
      },
      ...(b && b.name !== a.name
        ? [
            {
              speaker: b.name,
              lines: [
                '诶，什么时候弄的？',
                '……我看看。',
                '嗯，这里第二段是不是太满了？不是说不好，就是……有点急着往前跑。',
                '不过，副歌前那一段我挺喜欢的。像是……在犹豫要不要继续往前走。',
                '所以，你不用急着改。先让我再听一遍。',
                '……当然，要是你坚持现在改，我也可以陪你。'
              ]
            }
          ]
        : []),
      { speaker: a.name, lines: ['啊。'] },
      ...(b && b.name !== a.name
        ? [
            {
              speaker: b.name,
              lines: ['……果然还是被你听出来了。', '不过，我没说不喜欢。']
            }
          ]
        : []),
      { speaker: a.name, lines: ['……嗯。'] }
    ]
  }

  return {
    system: [
      '你是 Project SEKAI 风格视觉小说的编剧。',
      '这是多轮写作的第二轮：只写台词稿——谁在第几句说什么。',
      '不要写动作、表情、镜头、舞台、BGM 或旁白式描写；这些由第三段表演设计决定。',
      '台词稿会被逐字使用，表演设计不会改一个字，所以这一轮只把“话”写对。只输出一个 JSON 对象。',
      options.systemPrompt?.trim() ?? ''
    ]
      .filter(Boolean)
      .join('\n'),
    user: `## 这一场
小事件：${plan.event || options.scene}
${plan.logline ? `一句话：${plan.logline}` : ''}
${plan.background ? `背景：${plan.background}` : ''}
出场角色：
${castBlock(plan)}

## 大纲（参考，不必逐条对应）
${outline}

## 角色（请完整阅读每个人的提示词）
${castLines}

## 台词要求（按 ${budget} 句的场次计算）
- 语言：中文；总共 ${Math.max(12, Math.round(budget * 0.88))}~${Math.round(budget * 1.08)} 句（目标约 ${budget} 句）；
  少于 ${Math.max(12, Math.round(budget * 0.88))} 句或超过 ${Math.round(budget * 1.08)} 句都视为不合格。
- 用 turns 组织：一个角色的一次发言 = 一个 turn，turn 里放 1~6 条 lines。
  整场约 ${Math.max(8, Math.round(budget / 2.1))} 个 turns，长短要有明显起伏（官方一半以上是单句）：
  约 45% 的 turn 只放 1 条（短反应、抢话、被打断），至少 ${Math.max(10, Math.round(budget * 0.4))} 个；
  约 1/5 的 turn 放 2 条；剩下约 1/3 放 3~6 条，其中至少 2 个 turn 放 6 条以上
  （情绪最重、回忆或解释来龙去脉处）。
  单句负责节奏，长段负责情绪，两种都要有；不要每个 turn 都写 2 条，也不要机械一人一句。
- 句长：平均 17~20 字；至少 10 句是 27~40 字的长句（宿主会按显示宽度自动折成两行），
  约 1/6 的句子是 2~6 字；不要每句都是 10~15 字。长句要是完整的想法、解释或回忆，不要为凑长度加废话。
- 一条 line 通常只放一句话；一句话超过 40 字就拆成同一 turn 的两条。
- 换行：不要在词中间手动加 \\n，宿主会自动折行；只有想在句中断开语气时才用 \\n，并且只放在标点之后。
- 连续说话：同一个人一个 turn 说 2~3 句很常见，情绪上来时可以 4~6 句。
  * 把一个人的长回应拆成 2~3 条 lines（每条一句话），而不是写成一条很长的话。
  * 允许「A A B B A A A」的节奏。
- 短反应：至少 ${Math.max(4, Math.round(budget * 0.18))} 句是 2~6 字的短反应（「…………」「……嗯。」「真的？」「诶？」「等一下。」）。
- 标点：至少 ${Math.max(8, Math.round(budget * 0.5))} 句用省略号或破折号收尾（不要每句都用句号），
  允许半截话、重复、欲言又止、被打断；问句约 1/5；感叹号约 1/6，不要超过 1/4。
- 每个角色要有自己的句长和语气，严格按角色提示词；不要所有人都用同一种 12~15 字的书面句。
- 只写说出口的话。不要括号动作（例如「（笑）」）、不要「她转过头」这类叙述，也不要旁白。
- 结尾用一句短话、一个没说完的句子或一句日常收束，不要总结主题，不要写“未完待续”。
- 台词里不要提镜头、分镜、BGM 或“场景”。

## 写完后自检（不要输出自检过程）
- 把 turns 里每条 lines 数一遍：总句数是否在 ${Math.max(12, Math.round(budget * 0.88))}~${Math.round(budget * 1.08)} 句？
- 是否有约 ${Math.max(10, Math.round(budget * 0.4))} 个单条 turn、约 1/5 的两条 turn、其余 3 条以上，且至少 2 个 6 条以上？
- 是否有至少 10 句 27 字以上、至少 ${Math.max(4, Math.round(budget * 0.18))} 句 2~6 字？
- 是否有至少 ${Math.max(8, Math.round(budget * 0.5))} 句带省略号或破折号？
- 是否只有两个角色，且没有旁白、括号动作和镜头词？

## 风格样例（只学句长、停顿、轮次和标点，不要照抄内容）
角色A：那个……其实……我不是不满意……
角色A：再说，我对画也一点也不懂——
角色B：不懂也没关系。我只是想知道，你看到这幅画时的感受。
角色A：我的、感受吗……
角色A：……我……
角色B：——话说，你要是不觉得好，能不能直说啊？
角色B：当然，如果你说完全不行，我也会超级不开心，可是……！
角色B：要是画本身就不行，你却客套地敷衍我，我会更不舒服！
角色B：所以……所以我才想问清楚。
角色B：你真实的想法，到底是什么？

## 输出 JSON
${JSON.stringify(example, null, 2)}

只输出 JSON 对象本身，不要 markdown 或解释。`
  }
}

function resolveDialogueSpeaker(plan: StagedCastPlan, value: unknown): StagedCastMember | null {
  const text = str(value).trim()
  if (!text) return null
  const lower = text.toLowerCase()
  return (
    plan.cast.find(
      (member) =>
        member.name.toLowerCase() === lower ||
        member.fullName.toLowerCase() === lower ||
        String(member.modelId) === text
    ) ?? null
  )
}

export function normalizeDialogue(
  raw: unknown,
  plan: StagedCastPlan,
  maxLines = 120,
  emotionLabels?: string[]
): StagedDialogue | null {
  const doc = unwrapRecord(raw, ['dialogue', 'story', 'plan'])
  if (!isRecord(doc)) return null
  const labels = (emotionLabels ?? []).map((label) => label.trim()).filter(Boolean)
  const lines: StagedDialogueLine[] = []

  const pushLine = (member: StagedCastMember, content: string, rawEmotion: unknown): void => {
    const text = cleanText(content)
    if (!text) return
    const emotionValue = str(rawEmotion).trim()
    const emotion =
      labels.length > 0 ? (labels.includes(emotionValue) ? emotionValue : '') : emotionValue
    lines.push({
      id: `l${lines.length + 1}`,
      speaker: member.name,
      content: text,
      ...(emotion ? { emotion } : {})
    })
  }

  // 首选 turns：一个角色一次发言 = 一个 turn，内部 1~6 条 lines。
  // 这种结构能自然产生官方那种「同一个人连说 2~3 句」，比扁平 lines 更稳。
  const turns = Array.isArray(doc.turns) ? doc.turns : []
  if (turns.length > 0) {
    for (const turn of turns) {
      if (!isRecord(turn)) continue
      const member = resolveDialogueSpeaker(
        plan,
        turn.speaker ?? turn.say ?? turn.cast ?? turn.name
      )
      if (!member) continue
      const turnEmotion = turn.emotion
      const rawLines = Array.isArray(turn.lines) ? turn.lines : [turn]
      for (const rawLine of rawLines) {
        const content = isRecord(rawLine)
          ? (rawLine.content ?? rawLine.text ?? rawLine.line)
          : rawLine
        pushLine(
          member,
          str(content),
          isRecord(rawLine) ? (rawLine.emotion ?? turnEmotion) : turnEmotion
        )
      }
    }
  }

  if (lines.length === 0) {
    const body = entriesOf(doc.lines ?? doc.dialogue ?? doc.beats)
    for (const item of body) {
      if (!isRecord(item)) continue
      const member = resolveDialogueSpeaker(
        plan,
        item.speaker ?? item.say ?? item.cast ?? item.name
      )
      if (!member) continue
      pushLine(member, str(item.content ?? item.text ?? item.line), item.emotion)
    }
  }

  if (lines.length > maxLines) lines.length = maxLines
  if (lines.length < 2) return null
  return { title: titleOrDefault(doc.title, plan.title), lines }
}

export function buildDialogueRepairPrompt(
  view: CatalogView,
  plan: StagedCastPlan,
  options: StagedPromptOptions,
  previous: unknown
): StagedMessages {
  const base = buildDialoguePrompt(view, plan, options)
  const raw = typeof previous === 'string' ? previous : JSON.stringify(previous)
  return {
    system: base.system,
    user: `${base.user}\n\n## 上一轮的问题
上一轮没有给出至少 2 条可用的台词：必须用 turns 数组，每个 turn 同时有 speaker（上面列出的出场角色之一）
和 lines（1~6 条台词字符串）。
上一轮的输出开头如下：
${raw.slice(0, 4000)}

请按上面的角色提示词和格式重写完整台词稿，只输出 JSON 对象。`
  }
}

export function buildDialogueLengthPrompt(
  view: CatalogView,
  plan: StagedCastPlan,
  options: StagedPromptOptions,
  previous: unknown,
  actualLines: number,
  requiredLines: number,
  requiredChars = 0
): StagedMessages {
  const base = buildDialoguePrompt(view, plan, options)
  const raw = typeof previous === 'string' ? previous : JSON.stringify(previous)
  const upper = Math.round(requiredLines * 1.15)
  const actualChars = countDialogueChars(
    (() => {
      try {
        const parsed = typeof previous === 'string' ? JSON.parse(previous) : previous
        return parsed as StagedDialogue
      } catch {
        return { title: '', lines: [] }
      }
    })()
  )
  const charRule = requiredChars
    ? `- 总字数至少 ${requiredChars} 字（上一轮约 ${actualChars} 字），平均每句 17~20 字；`
    : ''
  const actualMean = actualLines > 0 ? (actualChars / actualLines).toFixed(1) : '0'
  const longRule = requiredChars
    ? `- 上一轮平均每句只有 ${actualMean} 字；这一轮至少 ${Math.ceil(requiredLines * 0.6)} 句 15 字以上，
  2~6 字的短反应不超过 1/5，不要用大量短句凑句数。`
    : ''
  return {
    system: base.system,
    user: `${base.user}\n\n## 上一轮的问题
上一轮只写了 ${actualLines} 句台词${requiredChars ? `、约 ${actualChars} 字` : ''}，
少于要求的 ${requiredLines} 句${requiredChars ? ` / ${requiredChars} 字` : ''}。请保留原来的小事件和人物关系，
重写一份完整台词稿：
- 总句数 ${requiredLines}~${upper} 句，仍然用 turns 结构，每个 turn 1~6 条 lines；
${charRule}
${longRule}
- 不要靠重复台词凑数；补足对话的来回、停顿、短反应和情绪铺垫；
- 仍然是两个角色，不要旁白和动作描写。
上一轮的输出开头如下：
${raw.slice(0, 4000)}

只输出 JSON 对象本身，不要 markdown 或解释。`
  }
}

export const countDialogueChars = (dialogue: StagedDialogue): number =>
  dialogue.lines.reduce((sum, line) => sum + Array.from(line.content.replace(/\s/g, '')).length, 0)

const displayWidth = (text: string): number =>
  Array.from(text).reduce((sum, char) => sum + (char.codePointAt(0)! >= 0x2e80 ? 1 : 0.5), 0)

/**
 * 把同角色相邻的两条短句并回一条 Talk。
 *
 * 模型在 turn 结构下常写出 55~65 条 12~14 字的短句，成片会比官方碎。这里只做
 * “合并”，不改写任何一个字：同角色、同情绪、两条都不少于 7 字、合并后不超过 40 字
 * 才并；最多并到目标句数，避免把短反应和停顿吃掉。
 */
export function condenseDialogue(dialogue: StagedDialogue, targetLines: number): StagedDialogue {
  const maxMerges = Math.max(
    0,
    Math.min(
      Math.max(1, Math.floor(dialogue.lines.length * 0.25)),
      dialogue.lines.length - Math.max(2, targetLines)
    )
  )
  if (maxMerges === 0) return dialogue

  const lines: StagedDialogueLine[] = []
  let merges = 0
  const endPunctuation = /[。！？!?…—、，,.\s～♪」』）)]$/
  for (let index = 0; index < dialogue.lines.length; index++) {
    const line = dialogue.lines[index]
    const next = dialogue.lines[index + 1]
    const length = (value: string): number => Array.from(value.replace(/\s/g, '')).length
    if (
      merges < maxMerges &&
      next &&
      line.speaker === next.speaker &&
      line.emotion === next.emotion &&
      length(line.content) >= 7 &&
      length(next.content) >= 7 &&
      endPunctuation.test(line.content) &&
      displayWidth(line.content) + displayWidth(next.content) <= 40
    ) {
      lines.push({ ...line, content: line.content + next.content })
      merges += 1
      index += 1
      continue
    }
    lines.push(line)
  }
  return { ...dialogue, lines }
}

// ---------------------------------------------------------------------------
// 第二段半：情绪分段
//
// 官方表情可以一句一换，但 TTS 换情绪会换参考音频，音色差异明显。所以情绪不跟台词
// 一起写，而是台词定稿后单独标一次：按 5~10 句的段落给标签，段内不切，整场只切几次。
// ---------------------------------------------------------------------------

export interface StagedEmotionSegment {
  from: number
  to: number
  emotion: string
}

export function buildEmotionPrompt(
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  options: StagedPromptOptions
): StagedMessages {
  const labels = (options.emotionLabels ?? []).map((label) => label.trim()).filter(Boolean)
  const defaultEmotion = labels.includes('平静') ? '平静' : labels[0]
  const strongLabels = labels.filter((label) => label !== defaultEmotion)
  const minEmotionSegments = dialogue.lines.length >= 30 ? 4 : 3
  const lineLines = dialogue.lines
    .map((line) => `- ${line.id} ${line.speaker}：${line.content.replace(/\n/g, ' / ')}`)
    .join('\n')

  const cast = plan.cast
    .map((member) => `- ${member.name}：${member.role || '出场角色'}`)
    .join('\n')

  const example = {
    segments: [
      { from: 'l1', to: 'l7', emotion: defaultEmotion },
      { from: 'l8', to: 'l14', emotion: strongLabels[0] ?? defaultEmotion },
      {
        from: 'l15',
        to:
          dialogue.lines.length >= 20
            ? 'l20'
            : `l${Math.max(15, Math.min(dialogue.lines.length, 20))}`,
        emotion: defaultEmotion
      }
    ]
  }

  return {
    system: [
      '你是 Project SEKAI 官方剧情的配音情绪标注员。',
      '台词已经定稿，你只做一件事：把整场台词切成连续的情绪段，每段给一个情绪标签。',
      'TTS 换情绪会换参考音频、音色差异明显，所以同一段内绝对不要来回切换。只输出一个 JSON 对象。',
      options.systemPrompt?.trim() ?? ''
    ]
      .filter(Boolean)
      .join('\n'),
    user: `## 这一场
小事件：${plan.event || options.scene}
${plan.logline ? `一句话：${plan.logline}` : ''}
角色：
${cast}

## 台词稿（逐字，只用来判断情绪）
${lineLines}

## 情绪标签（只能从中选）
${labels.join('、')}

## 标注规则
- 按段落标，不按句标：每段 5~10 句；${dialogue.lines.length} 句至少 ${minEmotionSegments} 段、最多 6 段；
  少于 ${minEmotionSegments} 段整场会显得没有起伏。
- 情绪分布：整场约 1/3 的句子是「${defaultEmotion}」底色，但不要超过一半；
  另外一半以上落在 1~3 个有起伏的段落里。不要整场都用「${defaultEmotion}」，也不要把每一段都标成强情绪。
- 默认「${defaultEmotion}」：日常陈述、普通对话、没有明显起伏的段落都用它。
- 只有文本明显进入另一情绪时才换段：开心用于轻松/玩笑/被逗笑；伤心用于失落、告白、回忆；
  生气用于争执、被戳痛；害羞用于被夸、慌张、不好意思；惊讶只用于突然的揭示或意外，整场最多 1 段。
- 相邻段不能使用同一个标签；不要在一段中间改标签；不要给单独一句开一段。
- 情绪段必须从 ${dialogue.lines[0]?.id ?? 'l1'} 连续覆盖到 ${dialogue.lines[dialogue.lines.length - 1]?.id ?? 'l1'}，不重叠、不遗漏。
- 宁可少切：整场 3~5 次变化就够了。拿不准时用「${defaultEmotion}」。

## 输出 JSON
${JSON.stringify(example, null, 2)}

只输出 JSON 对象本身，不要 markdown 或解释。`
  }
}

const emotionIndex = (value: unknown, lines: StagedDialogueLine[]): number => {
  const text = str(value).trim()
  if (!text) return -1
  const idMatch = /^l?(\d+)$/i.exec(text)
  if (idMatch) return Number(idMatch[1]) - 1
  const byId = lines.findIndex((line) => line.id === text)
  return byId
}

/** 把模型输出的 segments / emotions 解析成逐句标签；无法覆盖时返回 null。 */
export function normalizeEmotionPlan(
  raw: unknown,
  dialogue: StagedDialogue,
  labels: string[]
): Map<string, string> | null {
  const allowed = new Set(labels.map((label) => label.trim()).filter(Boolean))
  if (allowed.size === 0) return null
  const doc = isRecord(raw) ? raw : {}
  const segmentsRaw = Array.isArray(raw)
    ? raw
    : Array.isArray(doc.segments)
      ? doc.segments
      : Array.isArray(doc.emotions)
        ? doc.emotions
        : []

  const result = new Map<string, string>()
  for (const item of segmentsRaw) {
    if (typeof item === 'string') continue
    if (!isRecord(item)) continue
    const emotion = str(item.emotion ?? item.label ?? item.tone).trim()
    if (!allowed.has(emotion)) continue
    if (item.from !== undefined || item.to !== undefined) {
      const from = emotionIndex(item.from, dialogue.lines)
      const to = emotionIndex(item.to, dialogue.lines)
      if (from < 0 || to < 0 || to < from) continue
      for (let index = from; index <= Math.min(to, dialogue.lines.length - 1); index++) {
        result.set(dialogue.lines[index].id, emotion)
      }
      continue
    }
    const id = str(item.id ?? item.lineId ?? item.line).trim()
    const index = emotionIndex(id, dialogue.lines)
    if (index >= 0) result.set(dialogue.lines[index].id, emotion)
  }
  if (result.size < Math.ceil(dialogue.lines.length * 0.6)) return null
  return result
}

export function countEmotionRuns(plan: Map<string, string>, dialogue: StagedDialogue): number {
  let runs = 0
  let previous = ''
  for (const line of dialogue.lines) {
    const emotion = plan.get(line.id) ?? ''
    if (emotion && emotion !== previous) {
      runs += 1
      previous = emotion
    }
  }
  return runs
}

export function buildEmotionRepairPrompt(
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  options: StagedPromptOptions,
  previous: unknown,
  actualSegments: number
): StagedMessages {
  const base = buildEmotionPrompt(plan, dialogue, options)
  const raw = typeof previous === 'string' ? previous : JSON.stringify(previous)
  const minEmotionSegments = dialogue.lines.length >= 30 ? 4 : 3
  return {
    system: base.system,
    user: `${base.user}\n\n## 上一轮的问题
上一轮只标了 ${actualSegments} 段，整场会显得没有起伏。至少需要 ${minEmotionSegments} 段、最多 6 段：
- 每段 5~10 句，段内不要换标签；
- 平静约占 1/3 但不超过一半，其余段落要有明显情绪；
- 仍然要从 ${dialogue.lines[0]?.id ?? 'l1'} 连续覆盖到 ${dialogue.lines[dialogue.lines.length - 1]?.id ?? 'l1'}。
上一轮的输出开头如下：
${raw.slice(0, 3000)}

只输出 JSON 对象本身，不要 markdown 或解释。`
  }
}

/** 把逐句标签压成稳定段落：短段合并、同标签合并、限制总段数与强情绪段数。 */
export function stabilizeEmotions(
  dialogue: StagedDialogue,
  plan: Map<string, string> | null,
  labels: string[],
  minRun = 3
): Map<string, string> {
  const allowed = labels.map((label) => label.trim()).filter(Boolean)
  const fallback = allowed.includes('平静') ? '平静' : (allowed[0] ?? '')
  const emotions = dialogue.lines.map((line) => {
    const value = plan?.get(line.id)?.trim() ?? ''
    return allowed.includes(value) ? value : fallback
  })
  if (emotions.length === 0) return new Map()

  const runsOf = (values: string[]): StagedEmotionSegment[] => {
    const runs: StagedEmotionSegment[] = []
    for (let index = 0; index < values.length; index++) {
      const last = runs[runs.length - 1]
      if (last && last.emotion === values[index]) last.to = index
      else runs.push({ from: index, to: index, emotion: values[index] })
    }
    return runs
  }

  const applyRuns = (runs: StagedEmotionSegment[]): string[] => {
    const values = new Array<string>(emotions.length)
    for (const run of runs) {
      for (let index = run.from; index <= run.to; index++) values[index] = run.emotion
    }
    return values
  }

  // 1) 最短连续段合并到较长的邻居，直到所有段 >= minRun
  let runs = runsOf(emotions)
  const mergeShort = (): boolean => {
    const short = runs.find((run) => run.to - run.from + 1 < minRun)
    if (!short) return false
    const index = runs.indexOf(short)
    const previous = runs[index - 1]
    const next = runs[index + 1]
    const target =
      previous && next
        ? previous.to - previous.from >= next.to - next.from
          ? previous
          : next
        : (previous ?? next)
    if (!target) return false
    // 先移除被并掉的短段，再扩展目标段；否则 applyRuns 会按旧顺序把短段写回来。
    runs.splice(index, 1)
    target.from = Math.min(target.from, short.from)
    target.to = Math.max(target.to, short.to)
    runs = runsOf(applyRuns(runs))
    return true
  }
  while (mergeShort()) {
    // 合并后可能产生同标签相邻段，下一轮 runsOf 会自动并掉
  }
  runs = runsOf(applyRuns(runs))

  // 2) 限制总段数：40 句约 5~6 段
  const maxSegments = Math.max(2, Math.min(8, Math.round(emotions.length / 7)))
  const mergeShortest = (): void => {
    if (runs.length <= maxSegments) return
    let index = 0
    for (let i = 1; i < runs.length; i++) {
      if (runs[i].to - runs[i].from < runs[index].to - runs[index].from) index = i
    }
    const target = runs[index - 1] ?? runs[index + 1]
    if (!target) return
    const short = runs[index]
    runs.splice(index, 1)
    target.from = Math.min(target.from, short.from)
    target.to = Math.max(target.to, short.to)
    runs = runsOf(applyRuns(runs))
    mergeShortest()
  }
  mergeShortest()

  // 3) 同说话人抖动：若某句与前后同角色句的标签都不同，贴回前一句
  const smoothed = applyRuns(runs)
  const previousBySpeaker = new Map<string, number>()
  for (let index = 0; index < dialogue.lines.length; index++) {
    const speaker = dialogue.lines[index].speaker
    const previous = previousBySpeaker.get(speaker)
    if (previous !== undefined) {
      const previousEmotion = smoothed[previous]
      const currentEmotion = smoothed[index]
      if (previousEmotion !== currentEmotion) {
        let nextSame = -1
        for (let scan = index + 1; scan < dialogue.lines.length; scan++) {
          if (dialogue.lines[scan].speaker === speaker) {
            nextSame = scan
            break
          }
        }
        if (nextSame === -1 || smoothed[nextSame] === previousEmotion) {
          smoothed[index] = previousEmotion
        }
      }
    }
    previousBySpeaker.set(speaker, index)
  }
  runs = runsOf(smoothed)

  // 4) 强情绪段配额：惊讶/害羞最多 1 段，生气最多 2 段；超出的降级为平静
  const caps: Record<string, number> = { 惊讶: 1, 害羞: 1, 生气: 2 }
  for (const [label, cap] of Object.entries(caps)) {
    const matching = runs.filter((run) => run.emotion === label)
    if (matching.length <= cap) continue
    matching
      .sort((a, b) => a.to - a.from - (b.to - b.from))
      .slice(0, matching.length - cap)
      .forEach((run) => {
        run.emotion = fallback
      })
    runs = runsOf(applyRuns(runs))
  }

  // 5) 平滑与降级后可能又出现短段，再收一次
  const finalRuns = runsOf(applyRuns(runs))
  runs = finalRuns
  while (mergeShort()) {
    // 保持所有段 >= minRun
  }
  runs = runsOf(applyRuns(runs))

  // 6) 平静底色：官方约 30% 的表情是中性的。全片都是强情绪会让音色一直在换，
  //    这里保证至少 1/4 的句子回到默认标签，优先压缩最短的强情绪段。
  if (fallback && emotions.length >= 12) {
    const calmTarget = Math.ceil(emotions.length * 0.25)
    let calmCount = applyRuns(runs).filter((emotion) => emotion === fallback).length
    while (calmCount < calmTarget) {
      const candidates = runs
        .filter((run) => run.emotion !== fallback)
        .sort((a, b) => a.to - a.from - (b.to - b.from))
      const shortest = candidates[0]
      if (!shortest) break
      shortest.emotion = fallback
      runs = runsOf(applyRuns(runs))
      calmCount = applyRuns(runs).filter((emotion) => emotion === fallback).length
    }
  }

  const result = new Map<string, string>()
  const finalValues = applyRuns(runs)
  dialogue.lines.forEach((line, index) => {
    if (finalValues[index]) result.set(line.id, finalValues[index])
  })
  return result
}

export function applyEmotionPlan(
  dialogue: StagedDialogue,
  plan: Map<string, string> | null,
  labels: string[]
): StagedDialogue {
  const allowed = new Set(labels.map((label) => label.trim()).filter(Boolean))
  return {
    ...dialogue,
    lines: dialogue.lines.map((line) => {
      const emotion = plan?.get(line.id) ?? ''
      return allowed.has(emotion) ? { ...line, emotion } : { ...line, emotion: '' }
    })
  }
}

/**
 * 把一部分句号收尾改成省略号。
 *
 * 官方中文化台词约六成带「……」或「——」，模型稳定在三四成。这里只改标点、不动一个字，
 * 优先改平静/伤心段里较长的陈述句，均匀铺开，避免连续几句都是省略号。
 */
export function softenPunctuation(dialogue: StagedDialogue, targetShare = 0.55): StagedDialogue {
  const total = dialogue.lines.length
  if (total === 0) return dialogue
  // 只把真正的省略号算作已达标；破折号在官方指标里不计入 ellipsisShare。
  const hasEllipsis = (text: string): boolean => /…|\.\.\./.test(text)
  const current = dialogue.lines.filter((line) => hasEllipsis(line.content)).length
  let need = Math.ceil(total * targetShare) - current
  if (need <= 0) return dialogue

  const candidates = dialogue.lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => {
      const text = line.content.trim()
      if (!text.endsWith('。')) return false
      if (/[！？!?]/.test(text)) return false
      return Array.from(text).length >= 8
    })
  if (candidates.length === 0) return dialogue

  const chosen = new Set<number>()
  const step = Math.max(1, Math.floor(candidates.length / need))
  for (let index = 0; index < candidates.length && chosen.size < need; index += step) {
    chosen.add(candidates[index].index)
  }
  if (chosen.size === 0) return dialogue
  return {
    ...dialogue,
    lines: dialogue.lines.map((line, index) =>
      chosen.has(index) ? { ...line, content: line.content.replace(/。$/, '……') } : line
    )
  }
}

// ---------------------------------------------------------------------------
// 第三段：表演设计（动作、表情、听者反应、背景）
// ---------------------------------------------------------------------------

export function buildDirectionPrompt(
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  options: StagedPromptOptions
): StagedMessages {
  const castLines = plan.cast
    .map(
      (member) =>
        `- ${member.name}（modelId=${member.modelId}）${member.role ? ` — ${member.role}` : ''}`
    )
    .join('\n')

  const dialogueLines = dialogue.lines
    .map(
      (line) =>
        `- ${line.id} ${line.speaker}${line.emotion ? `〔${line.emotion}〕` : ''}：${line.content.replace(/\n/g, ' / ')}`
    )
    .join('\n')

  const motionLines = plan.cast
    .map((member) => {
      const model = view.modelById(member.modelId)
      return `${member.name}(${member.modelId})：${fullNameList(model?.motions ?? [])}`
    })
    .join('\n')

  const facialLines = plan.cast
    .map((member) => {
      const model = view.modelById(member.modelId)
      return `${member.name}(${member.modelId})：${fullNameList(model?.facials ?? [])}`
    })
    .join('\n')

  const backgrounds = view
    .imageDetailsList()
    .map((detail) => {
      const name = detail.name || detail.file
      return detail.description
        ? `- ${detail.file}（${name}）：${detail.description}`
        : `- ${detail.file}（${name}）`
    })
    .join('\n')

  const bgmChoices = view
    .bgmPromptChoices(40)
    .map((detail) => {
      const name = detail.name || detail.file
      return detail.description
        ? `- ${detail.file}（${name}）：${detail.description}`
        : `- ${detail.file}（${name}）`
    })
    .join('\n')

  const first = plan.cast[0]
  const second = plan.cast[1]
  const firstModel = view.modelById(first.modelId)
  const secondModel = second ? view.modelById(second.modelId) : null
  const firstMotion = firstModel?.motions.find((name) => !isStandingMotion(name)) ?? ''
  const firstFacial = firstModel?.facials[0] ?? ''
  const bgmChoicesList = view.bgmPromptChoices(40)
  const firstBgm = bgmChoicesList[0]?.file ?? ''
  const secondBgmChoice = bgmChoicesList.find((choice) => choice.file !== firstBgm)?.file ?? ''
  const bgmTurnLine = dialogue.lines[Math.min(2, dialogue.lines.length - 1)]
  const example = {
    background: plan.background || view.defaultImage() || '背景文件名',
    ambient: 'normal',
    bgm: firstBgm,
    // 用一个具体样例告诉模型换曲字段长什么样；没有第二首可选时不写。
    ...(secondBgmChoice && bgmTurnLine ? { bgm2: secondBgmChoice, bgm2From: bgmTurnLine.id } : {}),
    bgmStop: false,
    lines: [
      {
        id: dialogue.lines[0]?.id ?? 'l1',
        ...(firstMotion ? { motion: firstMotion } : {}),
        ...(firstFacial ? { facial: firstFacial } : {}),
        ...(secondModel?.facials[0]
          ? { listener: { modelId: secondModel.id, facial: secondModel.facials[0] } }
          : {})
      }
    ]
  }

  return {
    system: [
      '你是 Project SEKAI 风格视觉小说的导演。',
      '这是多轮写作的第三轮：台词已经定稿，只设计表演——每句的说话者动作/表情、必要的听者反应、整场背景和可选 BGM。',
      '不要改写任何台词，不要增删台词，不要输出旁白。只输出一个 JSON 对象。',
      options.systemPrompt?.trim() ?? ''
    ]
      .filter(Boolean)
      .join('\n'),
    user: `## 这一场
小事件：${plan.event || options.scene}
${plan.logline ? `一句话：${plan.logline}` : ''}
出场角色：
${castLines}

## 台词稿（逐字，只能引用 id，不能改字）
${dialogueLines}

## 可用动作（必须使用对应角色的完整名称）
${motionLines}

## 可用表情（必须使用对应角色的完整名称）
${facialLines}

## 可用背景（1~2 张）
${backgrounds || '（目录暂未提供背景）'}

## 可用 BGM（可选，最多两首）
${bgmChoices || '（目录暂未提供带描述的 BGM，bgm 留空）'}

## 表演要求
- 整场平均每句约 1 个说话者动作：约 3/4 的句子给 1 个动作；
  约 1/5 的句子在 lines 里只写 id，不写 motion、facial 或 listener（完全不动）。
  只有情绪明显转折时才给同一句第 2 个动作，但输出格式只保留 1 个说话者主动作。
- 听者反应：约 1/5 的句子给听者 1 个表情（可带一个轻微动作），优先放在换人说话和情绪转折处；
  其余句子让听者安静倾听，不要每句都反应。
- 表情跟该句的〔情绪〕同向：平静段以 normal / smallmouth / closeeye 为主，不要每句都笑；
  开心段再用 smile；伤心段用 sad / cry；生气段用 angry / sharp；惊讶/害羞只在对应段用。
  同一情绪段内不要频繁换相反表情。
- 动作贴台词语义，幅度小而自然（点头、歪头、抬手、轻叹、垂眼）；禁止大挥臂、夸张甩头、跑跳。
- 同一角色连续多句时换不同动作，不要每句重复同一个起手式；动作与表情同向。
- 动作/表情必须来自对应角色的清单；不确定就省略，不要编造名称。省略动作优于编错。
- 朝比奈真冬 / 真冬：表情克制，避免过于开心的表情与欢快动作。
- 背景从清单选最贴合的一张；大多数场次整场只写这一张，不换背景。
- 只有明确的时间/地点变化（白天→夜晚、室内→室外）才用第二张：顶层写 background2 和
  background2From（从哪一句 id 开始），两张都必须来自清单，最多两张。
- 环境色：按场景时间写顶层 ambient：normal（白天/室内）、evening（黄昏）、night（夜晚）。
- BGM 是可选的：先选一首最贴合开场氛围的写入顶层 bgm；不要给每句台词换曲。
- 官方 3 分钟的一场通常换 1~2 次曲。若中段有明显的情绪/场景转折（日常→认真、轻松→伤感、
  争执→和解），再选一首写顶层 bgm2 和 bgm2From（从哪一句 id 开始）；约一半场次应该换一次。
  两首都必须来自清单、不能是同一首，最多两首，且不要在同一句既换背景又换 BGM。
- 没有合适的 BGM 就写 "bgm": ""，沿用管理员配置的全局 BGM，不要编造文件名。
- 可选 "bgmStop": true，在退场时让 BGM 淡出；不需要就写 false。

## 输出 JSON
${JSON.stringify(example, null, 2)}

只输出 JSON 对象本身，不要 markdown 或解释。`
  }
}

export function buildDirectionRepairPrompt(
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  options: StagedPromptOptions,
  previous: unknown
): StagedMessages {
  const base = buildDirectionPrompt(view, plan, dialogue, options)
  const raw = typeof previous === 'string' ? previous : JSON.stringify(previous)
  return {
    system: base.system,
    user: `${base.user}\n\n## 上一轮的问题
上一轮没有给出任何可用的表演设计：lines 必须逐条引用台词稿里的 id，并且至少给出一项
motion、facial 或 listener。动作/表情必须来自对应角色的清单。
上一轮的输出开头如下：
${raw.slice(0, 4000)}

请按上面的格式重写完整 JSON 对象，不要改台词。`
  }
}

function resolveDirectionListener(
  view: CatalogView,
  plan: StagedCastPlan,
  speaker: StagedCastMember,
  value: unknown
): StagedListenerAction | undefined {
  const item = isRecord(value) ? value : { modelId: value }
  const model = resolveModel(
    view,
    [],
    item.modelId ?? item.model ?? item.id ?? item.name ?? item.speaker
  )
  if (!model || model.id === speaker.modelId) return undefined
  if (!plan.cast.some((member) => member.modelId === model.id)) return undefined

  const motion = view.canonicalAnimation(model.id, 'motion', item.motion)
  const facial = view.canonicalAnimation(model.id, 'facial', item.facial)
  if (!motion && !facial) return undefined
  return { modelId: model.id, ...(motion ? { motion } : {}), ...(facial ? { facial } : {}) }
}

interface RawDirectionFields {
  motion?: unknown
  facial?: unknown
  listener?: unknown
  actions?: unknown
}

function readDirectionFields(item: JsonRecord, speaker: StagedCastMember): RawDirectionFields {
  const fields: RawDirectionFields = {
    motion: item.motion,
    facial: item.facial,
    listener: item.listener
  }
  // 兼容模型直接写 Talk 风格的 actions 数组：说话者动作与听者反应分开取第一条。
  if (Array.isArray(item.actions)) {
    const speakerAction = item.actions.find(
      (action) => isRecord(action) && Number(action.modelId) === speaker.modelId
    )
    const listenerAction = item.actions.find(
      (action) => isRecord(action) && Number(action.modelId) !== speaker.modelId
    )
    if (isRecord(speakerAction)) {
      fields.motion = fields.motion ?? speakerAction.motion
      fields.facial = fields.facial ?? speakerAction.facial
    }
    if (!fields.listener && isRecord(listenerAction)) fields.listener = listenerAction
  }
  return fields
}

export function normalizeDirection(
  raw: unknown,
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue
): StagedDirection {
  const doc = unwrapRecord(raw, ['direction', 'storyboard', 'story', 'plan'])
  if (!isRecord(doc)) return fallbackDirection(view, plan)
  const body = entriesOf(doc.lines ?? doc.beats)
  const byId = new Map(dialogue.lines.map((line) => [line.id, line]))
  const result = new Map<string, StagedDirectionLine>()

  for (const [index, item] of body.entries()) {
    if (!isRecord(item)) continue
    const id = str(item.id ?? item.lineId ?? item.line) || dialogue.lines[index]?.id || ''
    const line = byId.get(id)
    if (!line) continue
    const speaker = plan.cast.find((member) => member.name === line.speaker)
    if (!speaker) continue

    const fields = readDirectionFields(item, speaker)
    const motion = view.canonicalAnimation(speaker.modelId, 'motion', fields.motion)
    const facial = view.canonicalAnimation(speaker.modelId, 'facial', fields.facial)
    const listener = resolveDirectionListener(view, plan, speaker, fields.listener)
    if (!motion && !facial && !listener) continue
    result.set(id, {
      id,
      ...(motion ? { motion } : {}),
      ...(facial ? { facial } : {}),
      ...(listener ? { listener } : {})
    })
  }

  const bgm = matchBgm(view, doc.bgm ?? doc.music ?? doc.bgmFile)

  // 听者反应预算：双人整场同场后，模型很容易每句都给两个角色动作，画面会过满；
  // 硬性压到约 20%，把主要动作留给说话者，听者只在换人/情绪转折处反应。
  const maxListeners = Math.max(1, Math.ceil(dialogue.lines.length * 0.2))
  let listenerCount = 0
  let previousSpeakerForListener = ''
  for (const line of dialogue.lines) {
    const directed = result.get(line.id)
    if (!directed?.listener) {
      previousSpeakerForListener = line.speaker
      continue
    }
    const firstOfRun = previousSpeakerForListener !== line.speaker
    if (
      listenerCount < maxListeners &&
      (firstOfRun || listenerCount < Math.floor(maxListeners * 0.6))
    ) {
      listenerCount += 1
    } else {
      const { listener: _dropped, ...rest } = directed
      result.set(line.id, rest)
    }
    previousSpeakerForListener = line.speaker
  }

  // 动作预算：官方约 20% 的台词完全没有动作。模型（尤其关掉思考时）容易每句都给，
  // 这里从最短的句子开始摘掉说话者动作/表情，保证至少 20% 的“静止句”。
  const maxSpeakerActions = Math.ceil(dialogue.lines.length * 0.8)
  const directedSpeakerActions = dialogue.lines.filter((line) => {
    const directed = result.get(line.id)
    return Boolean(directed?.motion || directed?.facial)
  }).length
  if (directedSpeakerActions > maxSpeakerActions) {
    const candidates = dialogue.lines
      .map((line, index) => ({ line, index, directed: result.get(line.id) }))
      .filter((item) => item.directed && (item.directed.motion || item.directed.facial))
      .sort((a, b) => {
        const aLength = Array.from(a.line.content.replace(/\s/g, '')).length
        const bLength = Array.from(b.line.content.replace(/\s/g, '')).length
        return aLength - bLength || b.index - a.index
      })
    let remaining = directedSpeakerActions
    for (const candidate of candidates) {
      if (remaining <= maxSpeakerActions) break
      const directed = result.get(candidate.line.id)
      if (!directed) continue
      const { motion: _motion, facial: _facial, ...rest } = directed
      if (rest.listener) result.set(candidate.line.id, rest)
      else result.delete(candidate.line.id)
      remaining -= 1
    }
  }

  const ambientRaw = str(doc.ambient ?? doc.timeOfDay)
    .trim()
    .toLowerCase()
  const ambient: 'normal' | 'evening' | 'night' =
    ambientRaw === 'evening' ? 'evening' : ambientRaw === 'night' ? 'night' : 'normal'

  const mainBackground =
    matchBackground(view, doc.background) ||
    normalizeBackground(view, plan.background) ||
    view.defaultImage()
  const secondBackground = matchBackground(view, doc.background2 ?? doc.backgroundAlt)
  const secondFromIndex = dialogue.lines.findIndex(
    (line) => line.id === str(doc.background2From ?? doc.background2FromLine).trim()
  )
  const useSecond =
    Boolean(secondBackground) &&
    secondBackground !== mainBackground &&
    secondFromIndex > 0 &&
    secondFromIndex < dialogue.lines.length - 1

  const secondBgm = matchBgm(view, doc.bgm2 ?? doc.bgmAlt)
  const secondBgmFromIndex = dialogue.lines.findIndex(
    (line) => line.id === str(doc.bgm2From ?? doc.bgm2FromLine).trim()
  )
  const useSecondBgm =
    Boolean(bgm) &&
    Boolean(secondBgm) &&
    secondBgm !== bgm &&
    secondBgmFromIndex > 0 &&
    secondBgmFromIndex < dialogue.lines.length - 1

  return {
    background: mainBackground,
    ...(useSecond
      ? { background2: secondBackground as string, background2From: secondFromIndex }
      : {}),
    ambient,
    bgm,
    ...(useSecondBgm ? { bgm2: secondBgm as string, bgm2From: secondBgmFromIndex } : {}),
    bgmStop: bgm ? toBool(doc.bgmStop ?? doc.stopBgm) : false,
    lines: dialogue.lines
      .map((line) => result.get(line.id))
      .filter((line): line is StagedDirectionLine => Boolean(line))
  }
}

export function fallbackDirection(view: CatalogView, plan: StagedCastPlan): StagedDirection {
  return {
    background: plan.background || view.defaultImage(),
    ambient: 'normal',
    bgm: '',
    bgmStop: false,
    lines: []
  }
}

// ---------------------------------------------------------------------------
// 合并成 StoryData
// ---------------------------------------------------------------------------

function activeCast(
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  direction: StagedDirection
): StagedCastMember[] {
  const listeners = new Set(
    direction.lines
      .map((line) => line.listener?.modelId)
      .filter((id): id is number => typeof id === 'number')
  )
  return plan.cast.filter(
    (member) =>
      listeners.has(member.modelId) || dialogue.lines.some((line) => line.speaker === member.name)
  )
}

/**
 * 舞台调度：双人戏整场两人同场（Left/Right），单人戏整场 Center。
 *
 * 旧实现按“说话人发言段 + 听者反应”在 solo/duo 之间反复切换，48 句会产生
 * 28 次 LayoutAppear + 28 次 LayoutClear；双人动画里人物来回淡出淡入，既不符合
 * 用户要的“两个人物都显示”，也让动作在切人时被反复打断。
 *
 * 这里不额外调用 LLM：cast 已经确定，presence 只需要一个覆盖全篇的段。
 */
export interface StagedPresenceSegment {
  from: number
  to: number
  mode: 'solo' | 'duo'
  speaker?: string
}

export function planPresence(
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  _direction?: StagedDirection
): StagedPresenceSegment[] {
  if (dialogue.lines.length === 0) return []
  const last = dialogue.lines.length - 1
  if (plan.cast.length >= 2) {
    return [{ from: 0, to: last, mode: 'duo' }]
  }
  return [{ from: 0, to: last, mode: 'solo', speaker: dialogue.lines[0].speaker }]
}

/**
 * 把三段结果合成现有剧本格式。
 *
 * 台词逐字取自第二段；第三段只提供动作/表情/听者反应/背景。走位由宿主固定：
 * 单人 Center，双人整场 Left/Right 同场；开场一次入场、结尾一次退场，不再逐段切人。
 */
export function composeStory(
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  direction: StagedDirection
): JsonRecord {
  const cast = activeCast(plan, dialogue, direction)
  if (cast.length === 0) throw new Error('台词稿没有可用的出场角色')

  const background = normalizeBackground(view, direction.background || plan.background)
  const sides = new Map<number, 'Left' | 'Right' | 'Center'>()
  cast.forEach((member, index) => {
    sides.set(member.modelId, cast.length === 1 ? 'Center' : index === 0 ? 'Left' : 'Right')
  })

  const models = cast.map((member) => ({
    id: member.modelId,
    model: member.path,
    normal_scale: 2.1,
    small_scale: 1.8,
    anchor: 0.5
  }))
  const secondBackground =
    direction.background2 && direction.background2 !== background ? direction.background2 : ''
  const images = [
    ...(background ? [{ id: 1, image: background }] : []),
    ...(secondBackground ? [{ id: 2, image: secondBackground }] : [])
  ]
  const snippets: JsonRecord[] = []

  if (direction.bgm) {
    snippets.push({
      type: 'ChangeBgm',
      wait: false,
      delay: 0,
      data: { file: direction.bgm, stop: false, fadeMs: 600 }
    })
  }
  snippets.push({ type: 'ChangeLayoutMode', wait: false, delay: 0, data: { mode: 'Normal' } })

  if (background) {
    snippets.push({ type: 'BlackOut', wait: true, delay: 0, data: { duration: 600 } })
    snippets.push({
      type: 'ChangeBackgroundImage',
      wait: false,
      delay: 0,
      data: { imageId: 1 }
    })
    snippets.push({ type: 'BlackIn', wait: true, delay: 0, data: { duration: 600 } })
  }
  if (direction.ambient && direction.ambient !== 'normal') {
    snippets.push({
      type: 'AmbientColor',
      wait: false,
      delay: 0,
      data: { mode: direction.ambient }
    })
  }

  const presence = planPresence(plan, dialogue, direction)
  const positions = new Map<number, 'Left' | 'Right' | 'Center'>()
  const onStage = new Set<number>()

  const clearAll = (): void => {
    for (const member of [...cast].reverse()) {
      if (!onStage.has(member.modelId)) continue
      const side = positions.get(member.modelId) ?? 'Center'
      snippets.push({
        type: 'LayoutClear',
        wait: true,
        delay: 0,
        data: {
          modelId: member.modelId,
          from: { side, offset: 0 },
          to: { side, offset: 0 },
          fadeOut: true,
          moveSpeed: 'Slow'
        }
      })
    }
    onStage.clear()
  }

  const showMember = (member: StagedCastMember, side: 'Left' | 'Right' | 'Center'): void => {
    snippets.push({
      type: 'LayoutAppear',
      wait: true,
      delay: 0,
      data: {
        modelId: member.modelId,
        from: { side, offset: 0 },
        to: { side, offset: 0 },
        // 双人同场时两人都从开场就在场，每个人都要带入场动作；
        // 旧逻辑只给第一个角色 motion，第二个用 fadeIn，结果第二人必定站桩淡入。
        motion: pickStageMotion(view, member.modelId),
        facial: view.defaultFacial(member.modelId),
        facialFirst: true,
        moveSpeed: 'Slow'
      }
    })
    onStage.add(member.modelId)
    positions.set(member.modelId, side)
  }

  const enterSegment = (segment: StagedPresenceSegment): void => {
    const desiredMembers =
      segment.mode === 'duo'
        ? cast
        : cast.filter((member) => member.name === segment.speaker).slice(0, 1)
    if (desiredMembers.length === 0) return
    const same =
      desiredMembers.length === onStage.size &&
      desiredMembers.every((member) => onStage.has(member.modelId))
    if (same) return
    clearAll()
    for (const member of desiredMembers) {
      const side = segment.mode === 'duo' ? (sides.get(member.modelId) ?? 'Right') : 'Center'
      showMember(member, side)
    }
  }

  const directionById = new Map(direction.lines.map((line) => [line.id, line]))
  let previousSpeaker = ''
  let segmentIndex = 0
  let secondBackgroundShown = false
  for (let index = 0; index < dialogue.lines.length; index++) {
    while (segmentIndex < presence.length - 1 && index > presence[segmentIndex].to) {
      segmentIndex += 1
    }
    const segment = presence[segmentIndex]
    // 第二首 BGM 在指定句之前换一次，长淡入淡出。
    if (direction.bgm2 && direction.bgm2From === index) {
      snippets.push({
        type: 'ChangeBgm',
        wait: false,
        delay: 0,
        data: { file: direction.bgm2, stop: false, fadeMs: 1200 }
      })
    }
    // 第二张背景在指定句之前切一次，用短黑场包住，避免硬切。
    if (!secondBackgroundShown && direction.background2From === index) {
      snippets.push({ type: 'BlackOut', wait: true, delay: 0, data: { duration: 400 } })
      snippets.push({
        type: 'ChangeBackgroundImage',
        wait: false,
        delay: 0,
        data: { imageId: 2 }
      })
      snippets.push({ type: 'BlackIn', wait: true, delay: 0, data: { duration: 400 } })
      secondBackgroundShown = true
    }
    if (segment && index === segment.from) enterSegment(segment)

    const line = dialogue.lines[index]
    const member = cast.find((entry) => entry.name === line.speaker)
    if (!member) continue
    const directed = directionById.get(line.id)
    const actions: JsonRecord[] = []
    // 官方 TalkData.Motions 的 MotionChangeFrom 恒为 1、TimingSyncValue 恒为 0：
    // 动作在台词开始时触发。旧代码写 at:0.1，动作会随 TTS 时长在 0.18~0.6s 间漂移，
    // 短句还没淡入完就被下一句打断，正是“动作切换忽快忽慢”的来源。
    if (directed?.motion || directed?.facial) {
      actions.push({
        at: 0,
        modelId: member.modelId,
        ...(directed.motion ? { motion: directed.motion } : {}),
        ...(directed.facial ? { facial: directed.facial } : {})
      })
    }
    if (
      segment?.mode === 'duo' &&
      directed?.listener &&
      directed.listener.modelId !== member.modelId &&
      onStage.has(directed.listener.modelId)
    ) {
      actions.push({
        at: 0,
        modelId: directed.listener.modelId,
        ...(directed.listener.motion ? { motion: directed.listener.motion } : {}),
        ...(directed.listener.facial ? { facial: directed.listener.facial } : {})
      })
    }

    snippets.push({
      type: 'Talk',
      wait: false,
      delay: previousSpeaker && previousSpeaker === member.name ? 0.15 : 0.1,
      data: {
        speaker: member.name,
        content: line.content,
        ttsText: '',
        emotion: line.emotion ?? '',
        modelId: member.modelId,
        ...(actions.length > 0 ? { actions } : {})
      }
    })
    previousSpeaker = member.name
  }

  snippets.push({ type: 'HideTalk', wait: true, delay: 0.2 })
  if (direction.bgm && direction.bgmStop) {
    snippets.push({
      type: 'ChangeBgm',
      wait: false,
      delay: 0,
      data: { file: '', stop: true, fadeMs: 800 }
    })
  }
  clearAll()
  snippets.push({ type: 'BlackOut', wait: true, delay: 0, data: { duration: 600 } })

  return { models, images, snippets }
}
