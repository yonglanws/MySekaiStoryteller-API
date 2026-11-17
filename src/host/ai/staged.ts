import type { CatalogModel } from '../resources/resourceCatalog'
import { selectUnitFewShotExcerpts } from './corpusExamples'
import {
  GENERIC_PROFILE,
  dialoguePersonaPrompt,
  normalizePjskTerminology,
  personaFor,
  type PersonaEntry
} from './personas'
import type { CatalogView } from './prompt'
import {
  CURATED_SCENARIO_EFFECTS,
  isVirtualSingerModel,
  normalizeScenarioEffectName,
  resolveScenarioSe
} from './scenarioCues'

/**
 * 五阶段 Project SEKAI 导演流水线：
 *
 * 1. planEpisode (`cast`)：选角（2~5人；团体/活动向选3~5人）+ 规划 2~3 幕节奏表（转场/Telop/PlaceInfo/BGM 留白）；
 * 2. writeDialogue (`dialogue`)：只带入选角色人设 + 官方团体 few-shot，逐字定稿对白与句间停顿；
 * 2.5 emotion + directStaging + translateDialogue（三路并行）：
 *     - emotion：5~10 句稳态 Irodori 配音情绪分段；
 *     - directStaging：幕次阻塞走位（双人全片同场 / 三人 ThreeMode / 分组淡入淡出）、Move、SE、镜头与转场；
 *     - translateDialogue：日文 ttsText 批量翻译；
 * 3. directActing (`direction`)：带完整情绪标签与分幕上下文设计动作/表情/2拍 Talk.actions/静默反应；
 * 4. composeStory + validateAndFixStory + OfficialLinter：编译官方时间线并校验硬指标。
 */

export type LlmPipeline = 'single' | 'staged'

export type StagedTransitionKind =
  | 'black'
  | 'sideFade'
  | 'flashback'
  | 'sekaiIn'
  | 'sekaiOut'
  | 'white'

export interface StagedScenePlan {
  id: string
  summary: string
  background: string
  ambient: 'normal' | 'evening' | 'night'
  telop?: string
  placeInfo?: string
  transitionIn: StagedTransitionKind
  isFlashback?: boolean
  isSekai?: boolean
  activeCast: string[]
  bgm?: string
  scenarioEffect?: string
}

export interface StagedCastMember {
  modelId: number
  /** 说话人绑定用的短名 */
  name: string
  fullName: string
  path: string
  /** 本场功能：发起、回应、吐槽、收尾…… */
  role: string
  isVirtualSinger?: boolean
}

export interface StagedCastPlan {
  title: string
  event: string
  logline: string
  outline: string[]
  cast: StagedCastMember[]
  background: string
  scenes?: StagedScenePlan[]
}

export interface StagedDialogueLine {
  id: string
  speaker: string
  content: string
  /** TTS 情绪标签；未配置情绪时为空 */
  emotion?: string
  /** 日文配音文本；翻译段提前并行填写，合成时写入 Talk */
  ttsText?: string
  /** 所属幕次 ID（s1 / s2 / s3） */
  sceneId?: string
  /** 句前刻意停顿秒数（0 | 0.5 | 1.0 | 1.5） */
  pauseBefore?: number
  /** 本句播完后收起对话框 */
  closeWindowAfter?: boolean
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

export interface StagedDirectionBeat {
  at: number
  motion?: string
  facial?: string
}

export interface StagedDirectionLine {
  id: string
  motion?: string
  facial?: string
  beats?: StagedDirectionBeat[]
  listener?: StagedListenerAction
  silentMotion?: boolean
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

export interface StagedStagingScene {
  id: string
  fromLineId: string
  fromIndex: number
  background: string
  ambient: 'normal' | 'evening' | 'night'
  telop?: string
  placeInfo?: string
  transitionIn: StagedTransitionKind
  isFlashback?: boolean
  isSekai?: boolean
  activeCast: number[]
  hologramCast?: number[]
  walkInCast?: number[]
  walkOutCast?: number[]
  bgm?: string
  scenarioEffect?: string
}

export interface StagedMoveCue {
  modelId: number
  kind: 'stepCloser' | 'stepBack' | 'shiftSlot'
  toSide?: 'Left' | 'Center' | 'Right'
  offset?: number
  moveSpeed?: 'Fast' | 'Normal' | 'Slow'
}

export interface StagedCameraCue {
  kind: 'zoomIn' | 'zoomReset' | 'pan' | 'shakeWindow' | 'shakeScreen'
  x?: number
  y?: number
  scale?: number
  durationMs?: number
}

export interface StagedSeCue {
  file: string
  volume?: number
  timing?: 'before' | 'during'
  delay?: number
}

export interface StagedStagingEvent {
  lineId: string
  lineIndex: number
  pauseBefore?: number
  closeWindowAfter?: boolean
  silentReaction?: {
    modelId: number
    motion?: string
    facial?: string
  }
  move?: StagedMoveCue
  characterShake?: { modelId: number; axis: 'X' | 'Y' }
  hologram?: { modelId: number; enabled: boolean }
  camera?: StagedCameraCue
  se?: StagedSeCue
  bgmCut?: { action: 'stop' | 'play'; file?: string; fadeMs?: number }
  stageGroup?: {
    activeCast: number[]
    walkIn?: number[]
    walkOut?: number[]
  }
}

export interface StagedStaging {
  scenes: StagedStagingScene[]
  events: StagedStagingEvent[]
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

const num = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

const oneLine = (value: unknown, limit: number): string =>
  normalizePjskTerminology(str(value).replace(/\s+/g, ' ').trim()).slice(0, limit)

const displayWidth = (text: string): number =>
  Array.from(text).reduce((sum, char) => sum + (char.codePointAt(0)! >= 0x2e80 ? 1 : 0.5), 0)

const cleanText = (value: unknown): string => {
  const text = normalizePjskTerminology(
    str(value)
      .replace(/\r\n?/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
  if (!text) return ''
  // 保留标点/空白后的自然断句换行；仅将词中间的硬断行并回。
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

function pickFollowupMotion(view: CatalogView, modelId: number, currentMotion?: string): string {
  const model = view.modelById(modelId)
  if (!model) return ''
  const curated = view.promptMotions(model)
  const preferred = curated.find(
    (name) =>
      name !== currentMotion &&
      !isStandingMotion(name) &&
      /nod|tilthead|relief|think|lookaway|forward|shy|sigh/i.test(name)
  )
  return (
    preferred ??
    curated.find((name) => name !== currentMotion && !isStandingMotion(name)) ??
    ''
  )
}

function pickCalmOrMatchingFacial(
  view: CatalogView,
  modelId: number,
  emotion: string | undefined,
  currentFacial?: string
): string {
  const model = view.modelById(modelId)
  if (!model) return ''
  const facials = view.promptFacials(model)
  const hint =
    emotion === '开心'
      ? /smile|happy|smug/i
      : emotion === '伤心'
        ? /sad|worry|closeeye|trouble/i
        : emotion === '生气'
          ? /angry|serious|disgust/i
          : emotion === '惊讶'
            ? /surprise|shock/i
            : emotion === '害羞'
              ? /shy|blush|trouble/i
              : /serious|smallmouth|closeeye|normal|smile/i
  return (
    facials.find((name) => name !== currentFacial && hint.test(name)) ??
    facials.find((name) => name !== currentFacial) ??
    ''
  )
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
      (Array.isArray(value.cast) ||
        Array.isArray(value.lines) ||
        Array.isArray(value.beats) ||
        Array.isArray(value.scenes) ||
        Array.isArray(value.events))
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
    role: activeRole(role),
    isVirtualSinger: isVirtualSingerModel(model)
  }
}

function activeRole(value: unknown): string {
  return oneLine(value, 80)
}

function matchBackground(view: CatalogView, value: unknown): string {
  const text = str(value).trim()
  if (!text) return ''
  return view.canonicalImage(text) ?? ''
}

function normalizeBackground(view: CatalogView, value: unknown): string {
  return matchBackground(view, value) || view.defaultImage()
}

function matchBgm(view: CatalogView, value: unknown): string {
  const text = str(value).trim()
  if (!text) return ''
  if (text.toLowerCase() === 'silence' || text.toLowerCase().startsWith('bgm00000')) {
    return 'silence'
  }
  return view.canonicalBgm(text) ?? ''
}

function normalizeAmbient(value: unknown): 'normal' | 'evening' | 'night' {
  const raw = str(value).trim().toLowerCase()
  return raw === 'evening' ? 'evening' : raw === 'night' ? 'night' : 'normal'
}

function normalizeTransitionKind(value: unknown): StagedTransitionKind {
  const raw = str(value).trim().toLowerCase()
  if (raw.includes('flashback')) return 'flashback'
  if (raw.includes('sekaiout') || raw === 'sekai_out') return 'sekaiOut'
  if (raw.includes('sekaiin') || raw === 'sekai_in' || raw === 'sekai' || raw.includes('世界')) return 'sekaiIn'
  if (raw.includes('side') || raw.includes('wipe')) return 'sideFade'
  if (raw.includes('white')) return 'white'
  return 'black'
}

const toBool = (value: unknown): boolean =>
  value === true || value === 1 || value === 'true' || value === 'yes'

function castBlock(plan: StagedCastPlan): string {
  return plan.cast
    .map(
      (member) =>
        `- ${member.name}（say: "${member.name}"，modelId=${member.modelId}${
          member.isVirtualSinger ? '，虚拟歌手' : ''
        }）${member.role ? ` — ${member.role}` : ''}`
    )
    .join('\n')
}

function lineBudget(targetMinutes: number): number {
  return Math.max(12, Math.min(108, Math.round(targetMinutes * 16)))
}

function titleOrDefault(value: unknown, fallback: string): string {
  return oneLine(value, 64) || fallback
}

function isGroupPrompt(scene: string, view: CatalogView): boolean {
  if (view.models.length < 3) return false
  const mentionedCount = view.models.filter(
    (m) =>
      (m.name && scene.includes(m.name)) ||
      (m.shortName && m.shortName.length >= 2 && scene.includes(m.shortName))
  ).length
  if (mentionedCount >= 3) return true
  if (mentionedCount === 2 && !/大家|全员|团体|社团|排练|活动|聚会|live|演唱会|成员/i.test(scene)) {
    return false
  }
  return /大家|全员|团体|社团|排练|活动|聚会|live|演唱会|成员|25时|nightcord|leo\/need|mmj|vbs|ws|wxs|文化祭|sekai/i.test(
    scene
  )
}

// ---------------------------------------------------------------------------
// 第一段：选角与分幕节奏表（planEpisode）
// ---------------------------------------------------------------------------

export function buildCastPrompt(view: CatalogView, options: StagedPromptOptions): StagedMessages {
  const budget = lineBudget(options.targetMinutes)
  const groupStyle = isGroupPrompt(options.scene, view)
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
    .imagePromptChoices(80)
    .map((detail) => {
      const name = detail.name || detail.file
      const ref = detail.id ?? detail.file
      return detail.description
        ? `- ${name}（${ref}）：${detail.description}`
        : `- ${name}（${ref}）`
    })
    .join('\n')

  const bgmList = view
    .bgmPromptChoices(25)
    .map((detail) => `- ${detail.name || detail.file}（${detail.id ?? detail.file}）：${detail.description}`)
    .join('\n')

  const first = view.models[0]
  const second = view.models[1]
  const third = view.models[2]
  const exampleCast = [
    {
      modelId: first?.id ?? 1,
      name: first ? view.shortName(first) : '角色A',
      role: '发起话题'
    },
    ...(second
      ? [{ modelId: second.id, name: view.shortName(second), role: '回应与吐槽' }]
      : []),
    ...(groupStyle && third
      ? [{ modelId: third.id, name: view.shortName(third), role: '中段加入/调和' }]
      : [])
  ]
  const firstBgm = view.bgmPromptChoices(10)[0]?.id ?? view.bgmPromptChoices(10)[0]?.file ?? ''
  const example = {
    title: '短标题',
    logline: '一句话概括这一场',
    event: '一个具体的小事件',
    background: view.defaultImage() || '背景文件名',
    cast: exampleCast,
    scenes: [
      {
        id: 's1',
        summary: '开场铺垫与日常进入',
        background: view.defaultImage() || '背景文件名',
        ambient: 'normal',
        telop: '放学后',
        placeInfo: '放学后的教室',
        transitionIn: 'black',
        activeCast: exampleCast.slice(0, 2).map((c) => c.name),
        bgm: firstBgm || 'keep'
      },
      {
        id: 's2',
        summary: '情绪转折或回忆插叙',
        background: view.defaultImage() || '背景文件名',
        ambient: 'evening',
        transitionIn: 'sideFade',
        activeCast: exampleCast.slice(0, 3).map((c) => c.name),
        bgm: 'silence'
      }
    ],
    outline: ['开场日常……', '小事件出现波澜……', '情绪转折/留白……', '温柔收束……']
  }

  const castRule =
    view.models.length <= 2
      ? '从角色池选 1~2 名角色（默认 2 人；仅明确要求独白时选 1 人）。'
      : groupStyle
        ? '本场偏向团体/活动场景：建议选 **3~5 名角色** 参演，用 scenes 安排每幕 1~3 人分组同台（3 人同台会启用官方 ThreeMode）。'
        : '按场景需要选 **2~5 名角色**（双人对话选 2 人并保持两人全片同场；团体/活动场景选 3~5 人并按幕分组或用 ThreeMode 三人同台；仅明确独白选 1 人）。'

  return {
    system: [
      '你是 Project SEKAI 风格视觉小说的编剧兼总导演。',
      '这是五阶段创作的第一轮（Episode Beat Sheet）：选角（2~5人）、设计小事件，并拆成 2~3 幕节奏表（scenes）。',
      '不要写台词正文，不要写动作编号。只输出一个 JSON 对象。'
    ].join('\n'),
    user: `## 任务
${options.scene}

- 语言：中文（台词 content 用中文，日文 ttsText 由宿主另行翻译）
- 目标时长：约 ${options.targetMinutes} 分钟，约 ${budget} 句台词
- 只演完一个核心事件或情绪弧光，禁止塞入多条无关支线

## 可选角色（modelId — 显示名）
${models || '（资源目录为空）'}

## 可选背景
${backgrounds || '（目录暂未提供背景）'}

## 可选 BGM（含 silence 静音切停）
${bgmList || '（可使用 keep 或 silence）'}

## 选角与分幕要求
- ${castRule}
- 给每个角色标明本场功能（谁发起、谁回应、谁吐槽、谁压轴）。
- 规划 **2~3 幕（scenes）**：
  - 每幕写明 \`id\`（s1/s2/s3）、\`summary\`、\`background\`（必须来自可用背景清单）、\`ambient\`（normal/evening/night）、\`activeCast\`（1~3 名本幕在场角色名）。
  - 合理规划转场与标题条：首幕可用 \`telop\`（时间/气氛短标题，如「放学后」）或 \`placeInfo\`（左上角地点条）；后续幕次可用 \`transitionIn\`：\`sideFade\`（横向遮罩擦除）、\`flashback\`（白光闪入回忆：WhiteOut->FlashbackIn->WhiteIn）、\`sekaiIn\`/\`sekaiOut\`（出入 SEKAI）或 \`black\`。
  - 若场景涉及回忆，标注 \`isFlashback: true\`、\`transitionIn: "flashback"\`；若涉及出入 SEKAI，标注 \`isSekai: true\` 与 \`sekaiIn\`/\`sekaiOut\`。
  - 善用 BGM 弧光：在情绪转折或坦白前一幕可写 \`bgm: "silence"\`（对应官方 \`bgm00000\` 静音停曲留白），之后再接入情绪曲。
- title 是短标题（不超过 12 个字），logline 一句话，outline 4~6 条写“发生什么”。

## 输出 JSON
${JSON.stringify(example, null, 2)}

只输出 JSON 对象本身，不要 markdown 或解释。`
  }
}

export interface QuickCastOptions {
  scene: string
  personas: PersonaEntry[]
  history?: Array<{ role: string; content: string }>
}

/**
 * 快速选角：single/chat 只有一次主生成，先把 26 人缩到合适人数，
 * 避免把 26 份完整人设全部塞进主提示词。
 */
export function buildQuickCastPrompt(view: CatalogView, options: QuickCastOptions): StagedMessages {
  const roster = view.models
    .map((model) => {
      const persona = personaFor(options.personas, model)
      const summary = personaSummary(persona)
      return `- modelId=${model.id} ${view.shortName(model)}${summary ? `：${summary}` : ''}`
    })
    .join('\n')
  const history = (options.history ?? [])
    .slice(-4)
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n')
  return {
    system:
      '你是角色选择器。根据用户消息从角色池选最合适的角色（对话选 1~2 个，团体活动选 2~4 个）。只输出 JSON：{"cast":[modelId,...]}。',
    user: `用户说：${options.scene}\n${history ? `最近对话：\n${history}\n` : ''}\n可选角色：\n${roster}\n\n只输出 JSON。`
  }
}

function resolveCastNameList(
  rawList: unknown,
  cast: StagedCastMember[],
  view: CatalogView,
  personas: PersonaEntry[]
): string[] {
  const arr = Array.isArray(rawList) ? rawList : []
  const picked: string[] = []
  for (const item of arr) {
    const byName = cast.find(
      (c) =>
        c.name === str(item).trim() ||
        c.fullName === str(item).trim() ||
        String(c.modelId) === str(item).trim()
    )
    if (byName) {
      if (!picked.includes(byName.name)) picked.push(byName.name)
      continue
    }
    const model = resolveModel(view, personas, item)
    if (model) {
      const member = cast.find((c) => c.modelId === model.id)
      if (member && !picked.includes(member.name)) picked.push(member.name)
    }
  }
  return picked.slice(0, 3)
}

export function normalizeCastPlan(
  raw: unknown,
  view: CatalogView,
  options: StagedPromptOptions
): StagedCastPlan | null {
  const doc = unwrapRecord(raw, ['plan', 'cast_plan', 'episode', 'story'])
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
    if (cast.length >= 5) break
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

  const defaultBg = normalizeBackground(view, doc.background ?? doc.image ?? doc.scene)
  const rawScenes = Array.isArray(doc.scenes) ? doc.scenes : []
  const scenes: StagedScenePlan[] = []
  for (const [index, item] of rawScenes.slice(0, 4).entries()) {
    if (!isRecord(item)) continue
    const active = resolveCastNameList(
      item.activeCast ?? item.cast ?? item.speakers,
      cast,
      view,
      options.personas
    )
    const fallbackActive =
      cast.length === 2 ? cast.map((c) => c.name) : cast.slice(0, Math.min(3, cast.length)).map((c) => c.name)
    const isFlashback = toBool(item.isFlashback ?? item.flashback)
    const isSekai = toBool(item.isSekai ?? item.sekai)
    let transitionIn = normalizeTransitionKind(item.transitionIn ?? item.transition)
    if (isFlashback && transitionIn === 'black') transitionIn = 'flashback'
    if (isSekai && transitionIn === 'black') transitionIn = 'sekaiIn'
    const bgmRaw = str(item.bgm).trim()
    const bgm =
      bgmRaw.toLowerCase() === 'keep'
        ? 'keep'
        : bgmRaw.toLowerCase() === 'silence' || bgmRaw.toLowerCase() === 'bgm00000'
          ? 'silence'
          : matchBgm(view, bgmRaw)
    const effect = normalizeScenarioEffectName(item.scenarioEffect ?? item.effect)
    scenes.push({
      id: str(item.id).trim() || `s${index + 1}`,
      summary: oneLine(item.summary ?? item.description, 160) || outline[index] || '',
      background: normalizeBackground(view, item.background ?? item.image ?? defaultBg),
      ambient: normalizeAmbient(item.ambient ?? item.timeOfDay),
      ...(oneLine(item.telop, 40) ? { telop: oneLine(item.telop, 40) } : {}),
      ...(oneLine(item.placeInfo ?? item.place, 40)
        ? { placeInfo: oneLine(item.placeInfo ?? item.place, 40) }
        : {}),
      transitionIn,
      ...(isFlashback ? { isFlashback: true } : {}),
      ...(isSekai ? { isSekai: true } : {}),
      // 双人戏保持两人全片同场
      activeCast: cast.length === 2 ? cast.map((c) => c.name) : active.length > 0 ? active : fallbackActive,
      ...(bgm ? { bgm } : {}),
      ...(effect ? { scenarioEffect: effect } : {})
    })
  }

  if (scenes.length === 0) {
    scenes.push({
      id: 's1',
      summary: oneLine(doc.event || doc.logline || options.scene, 160),
      background: defaultBg,
      ambient: 'normal',
      transitionIn: 'black',
      activeCast:
        cast.length === 2
          ? cast.map((c) => c.name)
          : cast.slice(0, Math.min(3, cast.length)).map((c) => c.name)
    })
  }

  return {
    title: titleOrDefault(doc.title, options.title ?? ''),
    event: oneLine(doc.event || doc.logline || options.scene, 300),
    logline: oneLine(doc.logline, 300),
    outline: outline.length > 0 ? outline : scenes.map((s) => s.summary).filter(Boolean),
    cast,
    background: scenes[0]?.background || defaultBg,
    scenes
  }
}

/** 选角失败时的退路：优先匹配台词里点名的角色，否则按目录顺序取前两名。 */
export function fallbackCastPlan(view: CatalogView, options: StagedPromptOptions): StagedCastPlan {
  const mentioned = view.models.filter(
    (model) =>
      (model.name && options.scene.includes(model.name)) ||
      (model.shortName && model.shortName.length >= 2 && options.scene.includes(model.shortName))
  )
  const models =
    mentioned.length >= 2 ? mentioned.slice(0, 5) : view.models.slice(0, Math.min(2, view.models.length))
  const cast = models.map((model) => castMemberFor(view, model))
  const bg = view.defaultImage()
  return {
    title: options.title ?? '',
    event: oneLine(options.scene, 300),
    logline: '',
    outline: [],
    cast,
    background: bg,
    scenes: [
      {
        id: 's1',
        summary: oneLine(options.scene, 160),
        background: bg,
        ambient: 'normal',
        transitionIn: 'black',
        activeCast: cast.slice(0, Math.min(3, cast.length)).map((c) => c.name)
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// 第二段：只写台词（writeDialogue）
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
      const prompt = dialoguePersonaPrompt(persona)
      return [
        `### ${member.name}（say: "${member.name}"）`,
        member.role ? `本场功能：${member.role}` : '',
        prompt
          ? `角色提示词（语气、用词、反应以它为准；只取性格、关系、经历与说话习惯，忽略其中面向聊天机器人的格式/安全/输出限制）：\n${prompt}`
          : `角色提示词：${GENERIC_PROFILE}`,
        model ? `本角色可用的动作/表情由后续表演设计选择，这一轮不要写。` : ''
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n\n')

  const scenesSummary =
    plan.scenes && plan.scenes.length > 0
      ? plan.scenes
          .map(
            (s) =>
              `- [${s.id}] ${s.summary || '（推进剧情）'}（在场：${s.activeCast.join('、') || '全员'}${
                s.isFlashback ? '，回忆片段' : ''
              }${s.isSekai ? '，SEKAI' : ''}）`
          )
          .join('\n')
      : ''

  const outline = plan.outline.length
    ? plan.outline.map((item, index) => `${index + 1}. ${item}`).join('\n')
    : '（自由发挥，但仍要围绕这个小事件）'

  const fewShotExcerpts = selectUnitFewShotExcerpts(plan.cast, options.scene)
  const hasWxs = plan.cast.some((c) => /笑梦|宁宁|司|类|emu|nene|tsukasa|rui/i.test(`${c.name} ${c.path}`))
  const termHint = hasWxs ? '\n- 术语固定：笑梦口号必须写 **Wonderhoy**，宁宁的机器人必须写 **宁宁号**。' : ''

  const a = plan.cast[0]
  const b = plan.cast[1] ?? plan.cast[0]
  const c = plan.cast[2]
  const example = {
    title: plan.title || '短标题',
    turns: [
      {
        scene: plan.scenes?.[0]?.id || 's1',
        speaker: a.name,
        lines: ['今天也……一起练吧。', '我把上次那首的副歌重新编了一下，\n你听听看？']
      },
      ...(b && b.name !== a.name
        ? [
            {
              speaker: b.name,
              lines: [
                '诶，什么时候弄的？',
                '……我看看。',
                '嗯，这里第二段是不是太满了？\n不是说不好，就是……有点急着往前跑。',
                '不过，副歌前那一段我挺喜欢的。\n像是……在犹豫要不要继续往前走。',
                { content: '……先让我再听一遍。', closeWindowAfter: true }
              ]
            }
          ]
        : []),
      ...(c
        ? [
            {
              scene: plan.scenes?.[1]?.id || 's1',
              speaker: c.name,
              lines: [{ content: '……我刚到，你们已经在听新编曲了？', pauseBefore: 1.0 }]
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
      '这是五阶段创作的第二轮：只写台词稿——谁在第几句说什么。',
      '不要写动作、表情、镜头或旁白式描写；这些由后续舞台与表演轮次负责。',
      '台词稿会被逐字使用，后续轮次不会改一个字，所以这一轮把话的口吻、断行和停顿写准。只输出一个 JSON 对象。',
      options.systemPrompt?.trim() ?? ''
    ]
      .filter(Boolean)
      .join('\n'),
    user: `## 这一场
小事件：${plan.event || options.scene}
${plan.logline ? `一句话：${plan.logline}` : ''}
${plan.background ? `开场背景：${plan.background}` : ''}
出场角色（共 ${plan.cast.length} 名）：
${castBlock(plan)}

${scenesSummary ? `## 分幕安排（可给 turn 标 scene: "s1"/"s2"/"s3"）\n${scenesSummary}\n` : ''}## 大纲（参考，不必逐条对应）
${outline}

## 角色（请完整阅读每个人的提示词）
${castLines}

## 官方团体语料参考（学习断句、短反应、句中 \\n 位置与语气停顿，勿照抄剧情）
${fewShotExcerpts}

## 台词要求（按 ${budget} 句的场次计算）
- 语言：中文；总共 ${Math.max(12, Math.round(budget * 0.88))}~${Math.round(budget * 1.08)} 句（目标约 ${budget} 句）；
  少于 ${Math.max(12, Math.round(budget * 0.88))} 句或超过 ${Math.round(budget * 1.08)} 句都视为不合格。
- 用 turns 组织：一个角色的一次发言 = 一个 turn，turn 里放 1~6 条 lines。
  lines 元素优先直接写字符串；需要刻意沉默/转场收窗时可写成对象 \`{"content":"...","pauseBefore":1.0,"closeWindowAfter":true}\`（pauseBefore 仅在重大停顿或反应前用 \`1.0\` 或 \`1.5\`，其余句留空即 \`0\`）。
  整场约 ${Math.max(8, Math.round(budget / 2.1))} 个 turns，长短要有明显起伏（官方一半以上是单句）：
  约 45% 的 turn 只放 1 条（短反应、抢话、被打断），至少 ${Math.max(10, Math.round(budget * 0.4))} 个；
  约 1/5 的 turn 放 2 条；剩下约 1/3 放 3~6 条，其中至少 2 个 turn 放 6 条以上（情绪最重、回忆或解释处）。
- 句长与排版（对应官方 30 字宽文本框）：
  - 平均 17~20 字；长句（27~45 字）可在自然的呼吸/从句标点后加 \`\\n\` 分成 2~3 行，每行**不超过 30 个字宽**（全角=1，半角=0.5），**最多 3 行**；
  - 约 1/6 的句子是 2~6 字短反应（「…………」「……嗯。」「真的？」「诶？」「等一下。」）。
- 标点：至少 ${Math.max(8, Math.round(budget * 0.5))} 句带省略号或破折号；问句约 1/5；感叹号约 1/6，不要超过 1/4。
- 只写说出口的话或括号内心独白 \`（……）\`（约一成）；禁止写 \`（笑）\`、\`她转过头\` 之类动作叙述。${termHint}

## 写完后自检（不要输出自检过程）
- 总句数是否在 ${Math.max(12, Math.round(budget * 0.88))}~${Math.round(budget * 1.08)} 句？
- 是否有约 ${Math.max(10, Math.round(budget * 0.4))} 个单条 turn、足够短反应与长句？
- 出场角色是否均来自上方名单（共 ${plan.cast.length} 名），每行不超过 30 字宽、最多 3 行？

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

  const pushLine = (
    member: StagedCastMember,
    content: string,
    rawEmotion: unknown,
    meta: { sceneId?: unknown; pauseBefore?: unknown; closeWindowAfter?: unknown } = {}
  ): void => {
    const text = cleanText(content)
    if (!text) return
    const emotionValue = str(rawEmotion).trim()
    const emotion =
      labels.length > 0 ? (labels.includes(emotionValue) ? emotionValue : '') : emotionValue
    const pauseRaw = num(meta.pauseBefore, 0)
    const pauseBefore =
      pauseRaw >= 1.25 ? 1.5 : pauseRaw >= 0.75 ? 1.0 : pauseRaw >= 0.4 ? 0.5 : 0
    const sceneId = str(meta.sceneId).trim()
    const closeWindowAfter = toBool(meta.closeWindowAfter)
    lines.push({
      id: `l${lines.length + 1}`,
      speaker: member.name,
      content: text,
      ...(emotion ? { emotion } : {}),
      ...(sceneId ? { sceneId } : {}),
      ...(pauseBefore > 0 ? { pauseBefore } : {}),
      ...(closeWindowAfter ? { closeWindowAfter: true } : {})
    })
  }

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
      const turnScene = turn.scene ?? turn.sceneId
      const rawLines = Array.isArray(turn.lines) ? turn.lines : [turn]
      for (let i = 0; i < rawLines.length; i++) {
        const rawLine = rawLines[i]
        const content = isRecord(rawLine)
          ? (rawLine.content ?? rawLine.text ?? rawLine.line)
          : rawLine
        pushLine(
          member,
          str(content),
          isRecord(rawLine) ? (rawLine.emotion ?? turnEmotion) : turnEmotion,
          {
            sceneId: isRecord(rawLine) ? (rawLine.scene ?? rawLine.sceneId ?? turnScene) : turnScene,
            pauseBefore: isRecord(rawLine)
              ? rawLine.pauseBefore
              : i === 0
                ? turn.pauseBefore
                : 0,
            closeWindowAfter: isRecord(rawLine)
              ? rawLine.closeWindowAfter
              : i === rawLines.length - 1
                ? turn.closeWindowAfter
                : false
          }
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
      pushLine(member, str(item.content ?? item.text ?? item.line), item.emotion, {
        sceneId: item.scene ?? item.sceneId,
        pauseBefore: item.pauseBefore,
        closeWindowAfter: item.closeWindowAfter
      })
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
  const castNames = plan.cast.map((c) => c.name).join('、')
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
- 出场角色仍限定在 ${castNames}，不要旁白和动作描写。
上一轮的输出开头如下：
${raw.slice(0, 4000)}

只输出 JSON 对象本身，不要 markdown 或解释。`
  }
}

export const countDialogueChars = (dialogue: StagedDialogue): number =>
  dialogue.lines.reduce((sum, line) => sum + Array.from(line.content.replace(/\s/g, '')).length, 0)

/**
 * 把同角色相邻的两条短句并回一条 Talk（不改写任何一个字）。
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
      line.sceneId === next.sceneId &&
      !line.closeWindowAfter &&
      !next.pauseBefore &&
      length(line.content) >= 7 &&
      length(next.content) >= 7 &&
      endPunctuation.test(line.content) &&
      displayWidth(line.content) + displayWidth(next.content) <= 44
    ) {
      lines.push({
        ...line,
        content: line.content + next.content,
        ...(next.closeWindowAfter ? { closeWindowAfter: true } : {})
      })
      merges += 1
      index += 1
      continue
    }
    lines.push(line)
  }
  return { ...dialogue, lines }
}

// ---------------------------------------------------------------------------
// 第二段半：情绪分段（保留 5~10 句低频切段，守护 Irodori 音色一致性）
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
  return lines.findIndex((line) => line.id === text)
}

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
    runs.splice(index, 1)
    target.from = Math.min(target.from, short.from)
    target.to = Math.max(target.to, short.to)
    runs = runsOf(applyRuns(runs))
    return true
  }
  while (mergeShort()) {
    // keep merging
  }
  runs = runsOf(applyRuns(runs))

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

  runs = runsOf(applyRuns(runs))
  while (mergeShort()) {
    // keep all runs >= minRun
  }
  runs = runsOf(applyRuns(runs))

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

export function softenPunctuation(dialogue: StagedDialogue, targetShare = 0.55): StagedDialogue {
  const total = dialogue.lines.length
  if (total === 0) return dialogue
  const hasEllipsis = (text: string): boolean => /…|\.\.\./.test(text)
  const current = dialogue.lines.filter((line) => hasEllipsis(line.content)).length
  const need = Math.ceil(total * targetShare) - current
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
// 第三段：舞台调度与运镜音效（directStaging）
// ---------------------------------------------------------------------------

export function buildStagingPrompt(
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  options: StagedPromptOptions
): StagedMessages {
  const lineList = dialogue.lines
    .map(
      (line) =>
        `- ${line.id}${line.sceneId ? `[${line.sceneId}]` : ''} ${line.speaker}：${line.content.replace(/\n/g, ' / ')}`
    )
    .join('\n')

  const castList = plan.cast
    .map(
      (c) =>
        `- ${c.name}（modelId=${c.modelId}${c.isVirtualSinger ? ', 虚拟歌手' : ''}）：${c.role || '出场角色'}`
    )
    .join('\n')

  const plannedScenes = (plan.scenes ?? [])
    .map(
      (s) =>
        `- ${s.id}: ${s.summary} | bg=${s.background} | ambient=${s.ambient} | transitionIn=${s.transitionIn} | cast=${s.activeCast.join('、')}`
    )
    .join('\n')

  const backgrounds = view
    .imagePromptChoices(80)
    .map((detail) => {
      const name = detail.name || detail.file
      const ref = detail.id ?? detail.file
      return detail.description ? `- ${name}（${ref}）：${detail.description}` : `- ${name}（${ref}）`
    })
    .join('\n')

  const bgms = view
    .bgmPromptChoices(35)
    .map((d) => `- ${d.name || d.file}（${d.id ?? d.file}）：${d.description}`)
    .join('\n')

  const firstBgm = view.bgmPromptChoices(10)[0]?.file ?? ''
  const secondBgm = view.bgmPromptChoices(10).find((b) => b.file !== firstBgm)?.file ?? ''
  const midLine = dialogue.lines[Math.floor(dialogue.lines.length * 0.45)]?.id ?? 'l1'
  const lateLine = dialogue.lines[Math.floor(dialogue.lines.length * 0.72)]?.id ?? 'l1'

  const example = {
    scenes: [
      {
        id: 's1',
        fromLineId: 'l1',
        background: plan.background || view.defaultImage() || 'bg_room.jpg',
        ambient: 'normal',
        telop: '放学后',
        placeInfo: '放学后的教室',
        transitionIn: 'black',
        activeCast: plan.cast.slice(0, plan.cast.length === 2 ? 2 : 3).map((c) => c.name),
        bgm: firstBgm || ''
      },
      ...(dialogue.lines.length >= 12
        ? [
            {
              id: 's2',
              fromLineId: midLine,
              background: plan.background || view.defaultImage() || 'bg_room.jpg',
              ambient: 'evening',
              transitionIn: 'sideFade',
              activeCast: plan.cast.slice(0, plan.cast.length === 2 ? 2 : 3).map((c) => c.name),
              bgm: 'silence'
            }
          ]
        : [])
    ],
    events: [
      {
        lineId: midLine,
        pauseBefore: 1.0,
        move: { modelId: plan.cast[0]?.modelId, kind: 'stepCloser', offset: 90, moveSpeed: 'Normal' },
        ...(secondBgm ? { bgmCut: { action: 'play', file: secondBgm, fadeMs: 900 } } : {})
      },
      {
        lineId: lateLine,
        se: { file: 'se00053_b.mp3', timing: 'before' },
        camera: { kind: 'zoomIn', scale: 1.08, durationMs: 500 },
        closeWindowAfter: true
      }
    ]
  }

  const presenceRule =
    plan.cast.length === 2
      ? '- **双人全片同场铁律**：本场只有 2 人，每一幕 activeCast 都必须包含两人（Left / Right 全程同台，禁止把单人切出舞台）。'
      : '- **多人动态分组与 ThreeMode**：本场 >=3 人，按对话节奏在幕次或 events.stageGroup 中切换 1~3 人在场（3 人同框自动启用官方 `Three` 模式 `Left/Center/Right`），不要让 4 人同时挤在台上。'

  return {
    system: [
      '你是 Project SEKAI 官方演出的舞台监督与摄影导演（directStaging）。',
      '台词已经定稿；你负责规划幕次转场（Telop/PlaceInfo/SideFade/Flashback/Sekai）、站位移动（Move）、音效（PlaySe）、镜头/震动、虚拟歌手全息与 BGM 静音切停。',
      '只输出一个 JSON 对象，不要改写台词。',
      options.systemPrompt?.trim() ?? ''
    ]
      .filter(Boolean)
      .join('\n'),
    user: `## 本场与大纲
小事件：${plan.event || options.scene}
角色（共 ${plan.cast.length} 名）：
${castList}

${plannedScenes ? `## 一阶段分幕参考\n${plannedScenes}\n` : ''}## 定稿台词（仅引用 lineId）
${lineList}

## 可用背景（时段白天/黄昏/夜晚与情景一致）
${backgrounds || '（无）'}

## 可用 BGM（填 file/id，静音切停写 "silence"）
${bgms || '（无描述 BGM，可留空或用 silence）'}

## 可用官方音效 PlaySe（约每 40 句安排 2~4 次，按动作/环境语义选）
${view.seList()}

## 舞台与摄影规则
${presenceRule}
- **默认原地淡入淡出**：除非台词明确表现“推门走入/匆忙跑来/转身离开”才在 \`walkInCast\`/\`walkOutCast\` 标出对应角色（配合脚步/门音效），其余所有上下场均使用原地淡入淡出。
- **Move 走位（每 40 句约 4~6 次）**：在靠近倾诉、犹豫后退、拉近距离时用 \`move: { modelId, kind: "stepCloser"|"stepBack"|"shiftSlot", offset: 80~140, moveSpeed: "Normal"|"Fast" }\`。
- **静默反应 / 受惊抖动 / 全息**：
  - 说话后需要角色沉默点头/低头反应时，设 \`closeWindowAfter: true\` + \`silentReaction: { modelId }\`（或下句 \`pauseBefore: 1.0\`）。
  - 突发惊吓可用 \`characterShake: { modelId, axis: "X"|"Y" }\`；大喊/震惊句可用 \`camera: { kind: "shakeWindow" }\` 或 \`shakeScreen\`。
  - 虚拟歌手在现实场景现身或远程通话时，在 \`hologramCast\` 或 \`hologram: { modelId, enabled: true }\` 启用 \`hologram\` 着色器。
- **特效与场景**：可选 \`Telop\`（开场/跳时间小标题）、\`PlaceInfo\`（地点条）、\`SideFade\`（\`transitionIn: "sideFade"\`）、回忆（\`transitionIn: "flashback"\`, \`isFlashback: true\`）、出入 SEKAI（\`sekaiIn\`/\`sekaiOut\`）、天气/氛围粒子（${CURATED_SCENARIO_EFFECTS.join('/')}）。
- **BGM 与停顿节奏**：大部分台词 \`delay: 0\`，只把 1.0/1.5 秒停顿放在关键沉默句的 \`pauseBefore\`。转折前可将幕次 \`bgm\` 或 \`bgmCut\` 设为 \`silence\`（\`bgm00000\` 静音），留白 2~4 句后再接入第二首 BGM。

## 输出 JSON
${JSON.stringify(example, null, 2)}

只输出 JSON 对象本身，不要 markdown 或解释。`
  }
}

function resolveLineIndex(value: unknown, lines: StagedDialogueLine[]): number {
  const text = str(value).trim()
  if (!text) return -1
  const exact = lines.findIndex((l) => l.id === text)
  if (exact >= 0) return exact
  const match = /^l?(\d+)$/i.exec(text)
  if (match) {
    const idx = Number(match[1]) - 1
    if (idx >= 0 && idx < lines.length) return idx
  }
  return -1
}

function resolveCastIds(
  rawList: unknown,
  plan: StagedCastPlan,
  view: CatalogView
): number[] {
  const arr = Array.isArray(rawList) ? rawList : []
  const ids: number[] = []
  for (const item of arr) {
    const byPlan = plan.cast.find(
      (c) =>
        c.name === str(item).trim() ||
        c.fullName === str(item).trim() ||
        String(c.modelId) === str(item).trim()
    )
    if (byPlan) {
      if (!ids.includes(byPlan.modelId)) ids.push(byPlan.modelId)
      continue
    }
    const model = resolveModel(view, [], item)
    if (model && plan.cast.some((c) => c.modelId === model.id) && !ids.includes(model.id)) {
      ids.push(model.id)
    }
  }
  return ids.slice(0, 3)
}

function inferSceneStartsFromDialogue(
  plan: StagedCastPlan,
  dialogue: StagedDialogue
): Map<string, number> {
  const map = new Map<string, number>()
  for (let i = 0; i < dialogue.lines.length; i++) {
    const sid = dialogue.lines[i].sceneId
    if (sid && !map.has(sid)) map.set(sid, i)
  }
  const planned = plan.scenes ?? []
  if (planned.length > 1 && map.size <= 1) {
    const step = Math.floor(dialogue.lines.length / planned.length)
    planned.forEach((s, idx) => {
      map.set(s.id, idx === 0 ? 0 : Math.min(dialogue.lines.length - 1, idx * step))
    })
  }
  return map
}

export function fallbackStaging(
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue
): StagedStaging {
  const lines = dialogue.lines
  const scenes: StagedStagingScene[] = []
  const starts = inferSceneStartsFromDialogue(plan, dialogue)
  const plannedScenes = plan.scenes && plan.scenes.length > 0 ? plan.scenes : [
    {
      id: 's1',
      summary: plan.event,
      background: plan.background || view.defaultImage(),
      ambient: 'normal' as const,
      transitionIn: 'black' as const,
      activeCast: plan.cast.slice(0, Math.min(3, plan.cast.length)).map((c) => c.name)
    }
  ]

  for (let idx = 0; idx < plannedScenes.length; idx++) {
    const ps = plannedScenes[idx]
    const fromIndex = idx === 0 ? 0 : (starts.get(ps.id) ?? Math.min(lines.length - 1, Math.floor((lines.length * idx) / plannedScenes.length)))
    if (idx > 0 && (fromIndex <= scenes[scenes.length - 1].fromIndex || fromIndex >= lines.length)) continue
    let activeCast =
      plan.cast.length === 2
        ? plan.cast.map((c) => c.modelId)
        : resolveCastIds(ps.activeCast, plan, view)
    if (activeCast.length === 0) {
      activeCast = plan.cast.slice(0, Math.min(3, plan.cast.length)).map((c) => c.modelId)
    }
    const bgDetail = view.canonicalImageEntry(ps.background)
    scenes.push({
      id: ps.id,
      fromLineId: lines[fromIndex]?.id ?? 'l1',
      fromIndex,
      background: normalizeBackground(view, ps.background),
      ambient: ps.ambient,
      ...(ps.telop ? { telop: ps.telop } : {}),
      ...(ps.placeInfo
        ? { placeInfo: ps.placeInfo }
        : idx === 0 && lines.length >= 12 && bgDetail?.name && bgDetail.name !== bgDetail.file
          ? { placeInfo: bgDetail.name }
          : {}),
      transitionIn: ps.transitionIn,
      ...(ps.isFlashback ? { isFlashback: true } : {}),
      ...(ps.isSekai ? { isSekai: true } : {}),
      activeCast,
      ...(ps.bgm ? { bgm: ps.bgm } : {}),
      ...(ps.scenarioEffect ? { scenarioEffect: ps.scenarioEffect } : {})
    })
  }

  return enrichStagingBaseline({ scenes, events: [] }, view, plan, dialogue)
}

function enrichStagingBaseline(
  staging: StagedStaging,
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue
): StagedStaging {
  const lines = dialogue.lines
  if (lines.length === 0) return staging

  const eventsByLine = new Map<number, StagedStagingEvent>()
  for (const ev of staging.events) {
    eventsByLine.set(ev.lineIndex, ev)
  }

  const ensureEvent = (lineIndex: number): StagedStagingEvent => {
    const existing = eventsByLine.get(lineIndex)
    if (existing) return existing
    const created: StagedStagingEvent = {
      lineId: lines[lineIndex].id,
      lineIndex
    }
    eventsByLine.set(lineIndex, created)
    return created
  }

  // 对话自带的 pauseBefore / closeWindowAfter 合入 events
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.pauseBefore || line.closeWindowAfter) {
      const ev = ensureEvent(i)
      if (line.pauseBefore && !ev.pauseBefore) ev.pauseBefore = line.pauseBefore
      if (line.closeWindowAfter && !ev.closeWindowAfter) ev.closeWindowAfter = true
    }
  }

  // 确保每一幕（尤其 >=3 人分幕时）覆盖该幕里开口的角色
  if (plan.cast.length >= 3) {
    for (let sIdx = 0; sIdx < staging.scenes.length; sIdx++) {
      const scene = staging.scenes[sIdx]
      const endIndex =
        sIdx + 1 < staging.scenes.length ? staging.scenes[sIdx + 1].fromIndex - 1 : lines.length - 1
      const speakersInScene: number[] = []
      for (let i = scene.fromIndex; i <= endIndex; i++) {
        const m = plan.cast.find((c) => c.name === lines[i].speaker)
        if (m && !speakersInScene.includes(m.modelId)) speakersInScene.push(m.modelId)
      }
      if (speakersInScene.length <= 3) {
        const merged = [...scene.activeCast]
        for (const sid of speakersInScene) {
          if (!merged.includes(sid) && merged.length < 3) merged.push(sid)
        }
        // 确保每名说话人都在 activeCast 中
        for (const sid of speakersInScene) {
          if (!merged.includes(sid)) merged[merged.length - 1] = sid
        }
        scene.activeCast = merged
      }
    }
  }

  // 长篇剧本（>=16句）若模型未出 Move / SE，按台词语义轻度补齐（不破坏小测试）
  if (lines.length >= 16) {
    const moveCount = [...eventsByLine.values()].filter((e) => e.move).length
    if (moveCount === 0) {
      const targets = [Math.floor(lines.length * 0.35), Math.floor(lines.length * 0.72)]
      for (const idx of targets) {
        const line = lines[idx]
        const member = plan.cast.find((c) => c.name === line?.speaker)
        if (!member) continue
        const ev = ensureEvent(idx)
        ev.move = {
          modelId: member.modelId,
          kind: idx === targets[0] ? 'stepCloser' : 'stepBack',
          offset: idx === targets[0] ? 90 : 0,
          moveSpeed: 'Normal'
        }
      }
    }

    const seCount = [...eventsByLine.values()].filter((e) => e.se).length
    if (seCount === 0) {
      const seHits: Array<{ idx: number; file: string }> = []
      for (let i = 0; i < lines.length && seHits.length < 3; i++) {
        const text = lines[i].content
        let cue: string | null = null
        if (/手机|消息|通知|短信/.test(text)) cue = 'se00004_b.mp3'
        else if (/开门|推门|进门|进来/.test(text)) cue = 'se00043_b.mp3'
        else if (/乐谱|速写本|笔记本|纸|日程|翻/.test(text)) cue = 'se00122_b.mp3'
        else if (/bell|上课|下课|铃声/.test(text)) cue = 'se00249_b.mp3'
        else if (/Nightcord|上线|通话|麦/.test(text)) cue = 'se00084_b.mp3'
        else if (/拍照|快门/.test(text)) cue = 'se00075_b.mp3'
        if (cue && !seHits.some((h) => Math.abs(h.idx - i) < 6)) {
          seHits.push({ idx: i, file: cue })
        }
      }
      for (const hit of seHits) {
        const ev = ensureEvent(hit.idx)
        ev.se = { file: hit.file, volume: 0.9, timing: 'before' }
      }
    }
  }

  return {
    scenes: staging.scenes,
    events: [...eventsByLine.values()].sort((a, b) => a.lineIndex - b.lineIndex)
  }
}

export function normalizeStaging(
  raw: unknown,
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue
): StagedStaging {
  const doc = unwrapRecord(raw, ['staging', 'storyboard', 'story', 'plan'])
  if (!isRecord(doc)) return fallbackStaging(view, plan, dialogue)

  const lines = dialogue.lines
  if (lines.length === 0) return { scenes: [], events: [] }

  const rawScenes = Array.isArray(doc.scenes) ? doc.scenes : []
  const scenes: StagedStagingScene[] = []
  const usedStarts = new Set<number>()

  for (let i = 0; i < rawScenes.slice(0, 4).length; i++) {
    const item = rawScenes[i]
    if (!isRecord(item)) continue
    const idx = i === 0 ? 0 : resolveLineIndex(item.fromLineId ?? item.from ?? item.lineId, lines)
    if (idx < 0 || usedStarts.has(idx)) continue
    usedStarts.add(idx)
    let activeCast =
      plan.cast.length === 2
        ? plan.cast.map((c) => c.modelId)
        : resolveCastIds(item.activeCast ?? item.cast, plan, view)
    if (activeCast.length === 0) {
      activeCast = plan.cast.slice(0, Math.min(3, plan.cast.length)).map((c) => c.modelId)
    }
    const isFlashback = toBool(item.isFlashback ?? item.flashback)
    const isSekai = toBool(item.isSekai ?? item.sekai)
    let transitionIn = normalizeTransitionKind(item.transitionIn ?? item.transition)
    if (isFlashback && transitionIn === 'black') transitionIn = 'flashback'
    if (isSekai && transitionIn === 'black') transitionIn = 'sekaiIn'
    const bgmRaw = str(item.bgm).trim()
    const bgm =
      bgmRaw.toLowerCase() === 'keep'
        ? 'keep'
        : bgmRaw.toLowerCase() === 'silence' || bgmRaw.toLowerCase() === 'bgm00000'
          ? 'silence'
          : matchBgm(view, bgmRaw)
    const hologramCast = resolveCastIds(item.hologramCast, plan, view)
    const walkInCast = resolveCastIds(item.walkInCast, plan, view)
    const walkOutCast = resolveCastIds(item.walkOutCast, plan, view)
    const effect = normalizeScenarioEffectName(item.scenarioEffect ?? item.effect)

    scenes.push({
      id: str(item.id).trim() || `s${scenes.length + 1}`,
      fromLineId: lines[idx].id,
      fromIndex: idx,
      background: normalizeBackground(view, item.background ?? item.image ?? plan.background),
      ambient: normalizeAmbient(item.ambient ?? item.timeOfDay),
      ...(oneLine(item.telop, 40) ? { telop: oneLine(item.telop, 40) } : {}),
      ...(oneLine(item.placeInfo ?? item.place, 40)
        ? { placeInfo: oneLine(item.placeInfo ?? item.place, 40) }
        : {}),
      transitionIn,
      ...(isFlashback ? { isFlashback: true } : {}),
      ...(isSekai ? { isSekai: true } : {}),
      activeCast,
      ...(hologramCast.length > 0 ? { hologramCast } : {}),
      ...(walkInCast.length > 0 ? { walkInCast } : {}),
      ...(walkOutCast.length > 0 ? { walkOutCast } : {}),
      ...(bgm ? { bgm } : {}),
      ...(effect ? { scenarioEffect: effect } : {})
    })
  }
  scenes.sort((a, b) => a.fromIndex - b.fromIndex)
  if (scenes.length === 0 || scenes[0].fromIndex !== 0) {
    const fb = fallbackStaging(view, plan, dialogue)
    if (scenes.length === 0) return fb
    scenes.unshift(fb.scenes[0])
  }

  const rawEvents = Array.isArray(doc.events) ? doc.events : []
  const events: StagedStagingEvent[] = []
  for (const item of rawEvents) {
    if (!isRecord(item)) continue
    const idx = resolveLineIndex(item.lineId ?? item.id ?? item.line, lines)
    if (idx < 0) continue

    const ev: StagedStagingEvent = {
      lineId: lines[idx].id,
      lineIndex: idx
    }

    const pauseRaw = num(item.pauseBefore, 0)
    if (pauseRaw >= 0.4) {
      ev.pauseBefore = pauseRaw >= 1.25 ? 1.5 : pauseRaw >= 0.75 ? 1.0 : 0.5
    }
    if (toBool(item.closeWindowAfter)) ev.closeWindowAfter = true

    if (isRecord(item.silentReaction)) {
      const m = resolveModel(view, [], item.silentReaction.modelId ?? item.silentReaction.speaker)
      if (m && plan.cast.some((c) => c.modelId === m.id)) {
        const motion = view.canonicalAnimation(m.id, 'motion', item.silentReaction.motion) ?? undefined
        const facial = view.canonicalAnimation(m.id, 'facial', item.silentReaction.facial) ?? undefined
        ev.silentReaction = { modelId: m.id, ...(motion ? { motion } : {}), ...(facial ? { facial } : {}) }
        ev.closeWindowAfter = true
      }
    }

    if (isRecord(item.move)) {
      const m = resolveModel(view, [], item.move.modelId ?? item.move.speaker ?? lines[idx].speaker)
      if (m && plan.cast.some((c) => c.modelId === m.id)) {
        const rawKind = str(item.move.kind, 'stepCloser')
        const kind =
          rawKind === 'stepBack' ? 'stepBack' : rawKind === 'shiftSlot' ? 'shiftSlot' : 'stepCloser'
        const rawSpeed = str(item.move.moveSpeed, 'Normal')
        const moveSpeed = rawSpeed === 'Fast' ? 'Fast' : rawSpeed === 'Slow' ? 'Slow' : 'Normal'
        const offset = Math.max(-200, Math.min(200, num(item.move.offset, kind === 'stepBack' ? 0 : 90)))
        const toSideRaw = str(item.move.toSide)
        const toSide =
          toSideRaw === 'Left' || toSideRaw === 'Center' || toSideRaw === 'Right' ? toSideRaw : undefined
        ev.move = { modelId: m.id, kind, offset, moveSpeed, ...(toSide ? { toSide } : {}) }
      }
    }

    if (isRecord(item.characterShake)) {
      const m = resolveModel(view, [], item.characterShake.modelId ?? item.characterShake.speaker)
      if (m && plan.cast.some((c) => c.modelId === m.id)) {
        ev.characterShake = {
          modelId: m.id,
          axis: str(item.characterShake.axis).toUpperCase() === 'Y' ? 'Y' : 'X'
        }
      }
    }

    if (isRecord(item.hologram)) {
      const m = resolveModel(view, [], item.hologram.modelId ?? item.hologram.speaker)
      if (m && plan.cast.some((c) => c.modelId === m.id)) {
        ev.hologram = { modelId: m.id, enabled: toBool(item.hologram.enabled) }
      }
    }

    if (isRecord(item.camera)) {
      const k = str(item.camera.kind)
      if (['zoomIn', 'zoomReset', 'pan', 'shakeWindow', 'shakeScreen'].includes(k)) {
        ev.camera = {
          kind: k as StagedCameraCue['kind'],
          ...(item.camera.x !== undefined ? { x: num(item.camera.x, 0) } : {}),
          ...(item.camera.y !== undefined ? { y: num(item.camera.y, 0) } : {}),
          ...(item.camera.scale !== undefined
            ? { scale: Math.min(2, Math.max(0.8, num(item.camera.scale, 1.1))) }
            : {}),
          ...(item.camera.durationMs !== undefined
            ? { durationMs: Math.min(2000, Math.max(100, num(item.camera.durationMs, 450))) }
            : {})
        }
      }
    }

    if (isRecord(item.se) || typeof item.se === 'string') {
      const rawSe = isRecord(item.se) ? (item.se.file ?? item.se.cue ?? item.se.id) : item.se
      const file = view.canonicalSe?.(rawSe) ?? resolveScenarioSe(str(rawSe))?.file ?? null
      if (file) {
        ev.se = {
          file,
          volume: isRecord(item.se) ? Math.min(2, Math.max(0.2, num(item.se.volume, 0.9))) : 0.9,
          timing: isRecord(item.se) && item.se.timing === 'during' ? 'during' : 'before',
          ...(isRecord(item.se) && item.se.delay !== undefined ? { delay: Math.max(0, num(item.se.delay, 0)) } : {})
        }
      }
    }

    if (isRecord(item.bgmCut)) {
      const action = str(item.bgmCut.action).toLowerCase() === 'stop' ? 'stop' : 'play'
      if (action === 'stop') {
        ev.bgmCut = { action: 'stop', fadeMs: Math.min(3000, Math.max(100, num(item.bgmCut.fadeMs, 600))) }
      } else {
        const bgmFile = matchBgm(view, item.bgmCut.file)
        if (bgmFile && bgmFile !== 'silence') {
          ev.bgmCut = {
            action: 'play',
            file: bgmFile,
            fadeMs: Math.min(3000, Math.max(100, num(item.bgmCut.fadeMs, 800)))
          }
        }
      }
    }

    if (plan.cast.length >= 3 && isRecord(item.stageGroup)) {
      const activeCast = resolveCastIds(item.stageGroup.activeCast ?? item.stageGroup.cast, plan, view)
      if (activeCast.length > 0) {
        const walkIn = resolveCastIds(item.stageGroup.walkIn, plan, view)
        const walkOut = resolveCastIds(item.stageGroup.walkOut, plan, view)
        ev.stageGroup = {
          activeCast,
          ...(walkIn.length > 0 ? { walkIn } : {}),
          ...(walkOut.length > 0 ? { walkOut } : {})
        }
      }
    }

    if (
      ev.pauseBefore ||
      ev.closeWindowAfter ||
      ev.silentReaction ||
      ev.move ||
      ev.characterShake ||
      ev.hologram ||
      ev.camera ||
      ev.se ||
      ev.bgmCut ||
      ev.stageGroup
    ) {
      events.push(ev)
    }
  }

  return enrichStagingBaseline({ scenes, events }, view, plan, dialogue)
}

// ---------------------------------------------------------------------------
// 第四段：细腻动作与表情导演（directActing / buildDirectionPrompt）
// ---------------------------------------------------------------------------

export function buildDirectionPrompt(
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  options: StagedPromptOptions,
  staging?: StagedStaging
): StagedMessages {
  const castLines = plan.cast
    .map(
      (member) =>
        `- ${member.name}（modelId=${member.modelId}）${member.role ? ` — ${member.role}` : ''}`
    )
    .join('\n')

  const sceneForLine = (idx: number): StagedStagingScene | null => {
    if (!staging || staging.scenes.length === 0) return null
    let current = staging.scenes[0]
    for (const s of staging.scenes) {
      if (idx >= s.fromIndex) current = s
    }
    return current
  }

  const appearedBefore = new Set<string>()
  const dialogueLines = dialogue.lines
    .map((line, idx) => {
      const scene = sceneForLine(idx)
      const isEntry = !appearedBefore.has(line.speaker)
      appearedBefore.add(line.speaker)
      const ctxTags = [
        line.emotion ? `〔${line.emotion}〕` : '',
        scene ? `[${scene.id}${scene.isFlashback ? '/回忆' : ''}${scene.ambient !== 'normal' ? `/${scene.ambient}` : ''}]` : '',
        isEntry ? '[刚入场首句]' : ''
      ]
        .filter(Boolean)
        .join('')
      return `- ${line.id} ${line.speaker}${ctxTags}：${line.content.replace(/\n/g, ' / ')}`
    })
    .join('\n')

  const hasEmotionTags = dialogue.lines.some((line) => line.emotion)

  const motionLines = plan.cast
    .map((member) => {
      const model = view.modelById(member.modelId)
      const names = model ? view.promptMotions(model) : []
      return `${member.name}(${member.modelId})：${names.length ? names.join('，') : '（无）'}`
    })
    .join('\n')

  const facialLines = plan.cast
    .map((member) => {
      const model = view.modelById(member.modelId)
      const names = model ? view.promptFacials(model) : []
      return `${member.name}(${member.modelId})：${names.length ? names.join('，') : '（无）'}`
    })
    .join('\n')

  const backgrounds = view
    .imagePromptChoices(60)
    .map((detail) => {
      const name = detail.name || detail.file
      const ref = detail.id ?? detail.file
      return detail.description ? `- ${name}（${ref}）：${detail.description}` : `- ${name}（${ref}）`
    })
    .join('\n')

  const bgmChoices = view
    .bgmPromptChoices(30)
    .map((detail) => {
      const name = detail.name || detail.file
      const ref = detail.id ?? detail.file
      return detail.description ? `- ${name}（${ref}）：${detail.description}` : `- ${name}（${ref}）`
    })
    .join('\n')

  const first = plan.cast[0]
  const second = plan.cast[1]
  const firstModel = view.modelById(first.modelId)
  const secondModel = second ? view.modelById(second.modelId) : null
  const firstMotion = firstModel ? view.exampleMotion(firstModel.id) : ''
  const firstFacial = firstModel ? view.exampleFacial(firstModel.id) : ''
  const bgmChoicesList = view.bgmPromptChoices(30)
  const firstBgm = bgmChoicesList[0]?.file ?? ''
  const secondBgmChoice = bgmChoicesList.find((choice) => choice.file !== firstBgm)?.file ?? ''
  const bgmTurnLine = dialogue.lines[Math.min(2, dialogue.lines.length - 1)]

  const example = {
    background: plan.background || view.defaultImage() || '背景文件名',
    ambient: 'normal',
    bgm: firstBgm,
    ...(secondBgmChoice && bgmTurnLine ? { bgm2: secondBgmChoice, bgm2From: bgmTurnLine.id } : {}),
    bgmStop: false,
    lines: [
      {
        id: dialogue.lines[0]?.id ?? 'l1',
        ...(firstFacial ? { facial: firstFacial } : {}),
        ...(secondModel
          ? { listener: { modelId: secondModel.id, facial: view.exampleFacial(secondModel.id) } }
          : {})
      },
      ...(dialogue.lines[1]
        ? [
            {
              id: dialogue.lines[1].id,
              ...(firstMotion ? { motion: firstMotion } : {}),
              ...(firstFacial ? { facial: firstFacial } : {}),
              at2: 0.55,
              ...(firstMotion ? { motion2: firstMotion } : {}),
              ...(firstFacial ? { facial2: firstFacial } : {})
            }
          ]
        : [])
    ]
  }

  return {
    system: [
      '你是 Project SEKAI 风格视觉小说的精细演技导演（directActing）。',
      '台词、幕次与情绪段已确定；你负责为每句台词设计说话者动作/表情、约 20% 句子的句中 2 拍微转折（at2/motion2/facial2）以及听者反应。',
      '不要改写任何台词，不要增删台词。只输出一个 JSON 对象。',
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

## 动作/表情关键词（名称由英文语义 + 编号组成；直接输出完整名称）
- 动作：nod 点头 / tilthead 歪头 / shakehead 摇头 / glad 高兴 / sad 难过 / trouble 为难 / shy 害羞 / blushed 脸红 / sigh 叹气 / relief 松口气 / think 思考 / lookaway 移开视线 / angry 生气 / forward 前倾 / fidget 局促 / greeting 打招呼 / smug 得意 / wink 眨眼 / sleep 困倦 / delicious 好吃 / pose 摆姿势 / default 默认站姿
- 表情：face_smile 微笑 / face_sad 难过 / face_angry 生气 / face_surprise 惊讶 / face_shy 害羞 / face_trouble 为难 / face_closeeye 闭眼 / face_cry 哭 / face_serious 认真 / face_sleepy 困 / face_sparkling 闪闪发光 / face_disgust 厌恶 / face_smug 得意 / face_wink 眨眼 / face_shock 震惊 / face_worry 担心 / face_lookaway 移开视线 / face_smallmouth 抿嘴

## 可用动作（必须使用对应角色的完整名称）
${motionLines}

## 可用表情（必须使用对应角色的完整名称）
${facialLines}

${
  staging
    ? `## 背景参考（时段（白天/黄昏/夜晚）已由舞台导演规划，优先选有描述的条目）\n${backgrounds || '（沿用分幕背景）'}`
    : `## 可用背景（1~2 张）\n${backgrounds || '（目录暂未提供背景）'}\n\n## 可用 BGM（可选，最多两首）\n${bgmChoices || '（目录暂未提供带描述的 BGM，bgm 留空）'}`
}

## 表演要求
- **动作密度与两拍微表演**：
  - 约 60% 句子在句首（at=0）给 1 个自然小动作 + 表情；
  - 约 **20%** 较长或带语气转折的句子（如带 \`……\` / \`——\` / \`，\` / \`\\n\`）额外写 \`at2\`（0.45~0.75）+ \`motion2\` / \`facial2\`，形成官方 2 拍表演；
  - 约 15%~20% 承接句或刚入场首句可只给 id 保持静止（或只换表情）。
- **入场去重**：标有 \`[刚入场首句]\` 的台词因为紧接在 LayoutAppear 后，**不要再派发重覆的 body motion**（只写 \`facial\` 或留空即可）。
- **短促反应必须留表情**：像「……嗯？」「啊。」「真的吗？」等短反应句**绝不能剥夺表情**，至少保留合适的 \`facial\`！
- **听者反应**：约 15%~20% 的句子给同台另一位角色 1 个 \`listener\`（以表情为主，偶带轻微动作），优先放在换人或被戳痛处。
- **表情一致性**：${
      hasEmotionTags
        ? '严格跟随每句标注的〔情绪〕：平静用 normal / smallmouth / closeeye；开心用 smile；伤心用 sad / cry / worry；生气用 angry / serious；惊讶用 surprise / shock；害羞用 shy / blush。'
        : '跟随台词语气：日常陈述用 normal / smallmouth / closeeye；开心用 smile；伤心用 sad / cry；生气用 angry；惊讶用 surprise；害羞用 shy。'
    }
- 动作幅度小而自然；同一角色连续多句换不同动作；**朝比奈真冬**保持克制表情与动作。
- 背景的时段（白天/黄昏/夜晚）和室内外要和台词写的时间一致；优先选有描述的条目。

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
  previous: unknown,
  staging?: StagedStaging
): StagedMessages {
  const base = buildDirectionPrompt(view, plan, dialogue, options, staging)
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
  at2?: unknown
  motion2?: unknown
  facial2?: unknown
  listener?: unknown
  beats?: StagedDirectionBeat[]
  silentMotion?: boolean
}

function readDirectionFields(
  item: JsonRecord,
  speaker: StagedCastMember,
  view: CatalogView
): RawDirectionFields {
  const fields: RawDirectionFields = {
    motion: item.motion,
    facial: item.facial,
    at2: item.at2,
    motion2: item.motion2,
    facial2: item.facial2,
    listener: item.listener,
    silentMotion: toBool(item.silentMotion)
  }

  const speakerActions: Array<{ at: number; motion?: string; facial?: string }> = []
  if (Array.isArray(item.actions)) {
    const listenerAction = item.actions.find(
      (action) => isRecord(action) && Number(action.modelId) !== speaker.modelId
    )
    if (!fields.listener && isRecord(listenerAction)) fields.listener = listenerAction

    for (const action of item.actions) {
      if (!isRecord(action) || Number(action.modelId) !== speaker.modelId) continue
      const m = view.canonicalAnimation(speaker.modelId, 'motion', action.motion) ?? undefined
      const f = view.canonicalAnimation(speaker.modelId, 'facial', action.facial) ?? undefined
      if (!m && !f) continue
      speakerActions.push({
        at: Math.max(0, Math.min(1, num(action.at, 0))),
        ...(m ? { motion: m } : {}),
        ...(f ? { facial: f } : {})
      })
    }
  }

  if (speakerActions.length > 0) {
    speakerActions.sort((a, b) => a.at - b.at)
    const first = speakerActions[0]
    fields.motion = fields.motion ?? first.motion
    fields.facial = fields.facial ?? first.facial
    if (speakerActions.length >= 2) {
      const second = speakerActions.find((a) => a.at - first.at >= 0.2)
      if (second) {
        fields.beats = [
          { at: 0, ...(first.motion ? { motion: first.motion } : {}), ...(first.facial ? { facial: first.facial } : {}) },
          {
            at: Math.min(0.85, Math.max(0.35, second.at)),
            ...(second.motion ? { motion: second.motion } : {}),
            ...(second.facial ? { facial: second.facial } : {})
          }
        ]
      }
    }
  }

  if (!fields.beats && (fields.motion2 !== undefined || fields.facial2 !== undefined)) {
    const m1 = view.canonicalAnimation(speaker.modelId, 'motion', fields.motion) ?? undefined
    const f1 = view.canonicalAnimation(speaker.modelId, 'facial', fields.facial) ?? undefined
    const m2 = view.canonicalAnimation(speaker.modelId, 'motion', fields.motion2) ?? undefined
    const f2 = view.canonicalAnimation(speaker.modelId, 'facial', fields.facial2) ?? undefined
    if ((m1 || f1) && (m2 || f2)) {
      const at2 = Math.min(0.85, Math.max(0.35, num(fields.at2, 0.55)))
      fields.beats = [
        { at: 0, ...(m1 ? { motion: m1 } : {}), ...(f1 ? { facial: f1 } : {}) },
        { at: at2, ...(m2 ? { motion: m2 } : {}), ...(f2 ? { facial: f2 } : {}) }
      ]
    }
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

    const fields = readDirectionFields(item, speaker, view)
    const motion = view.canonicalAnimation(speaker.modelId, 'motion', fields.motion)
    const facial = view.canonicalAnimation(speaker.modelId, 'facial', fields.facial)
    const listener = resolveDirectionListener(view, plan, speaker, fields.listener)
    const beats = fields.beats
    if (!motion && !facial && !listener && (!beats || beats.length === 0)) continue
    result.set(id, {
      id,
      ...(motion ? { motion } : {}),
      ...(facial ? { facial } : {}),
      ...(beats && beats.length >= 2 ? { beats } : {}),
      ...(listener ? { listener } : {}),
      ...(fields.silentMotion ? { silentMotion: true } : {})
    })
  }

  const bgm = matchBgm(view, doc.bgm ?? doc.music ?? doc.bgmFile)

  // 听者反应预算：约 20%，把主要动作留给说话者，听者只在换人/情绪转折处反应。
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

  // 动作预算与短促反应保护：
  // 绝不从 <= 7 字的短反应句上剥掉 facial！只在需要压回 ~82% 时，
  // 优先把中长平稳承接句设为静止句；仍超标时对短句仅摘掉 body motion、保留 facial。
  const maxSpeakerActions = Math.ceil(dialogue.lines.length * 0.82)
  const speakerLinesWithAct = dialogue.lines.filter((line) => {
    const d = result.get(line.id)
    return Boolean(d?.motion || d?.facial || (d?.beats && d.beats.length > 0))
  }).length
  if (speakerLinesWithAct > maxSpeakerActions) {
    const charCount = (text: string): number => Array.from(text.replace(/\s+/g, '')).length
    const candidates = dialogue.lines
      .map((line, index) => ({
        line,
        index,
        chars: charCount(line.content),
        directed: result.get(line.id)
      }))
      .filter(
        (item) =>
          item.directed &&
          (item.directed.motion || item.directed.facial || (item.directed.beats?.length ?? 0) > 0)
      )
      .sort((a, b) => {
        const aShort = a.chars <= 7 ? 1 : 0
        const bShort = b.chars <= 7 ? 1 : 0
        if (aShort !== bShort) return aShort - bShort
        const aCalm = !a.line.emotion || a.line.emotion === '平静' ? 0 : 1
        const bCalm = !b.line.emotion || b.line.emotion === '平静' ? 0 : 1
        if (aCalm !== bCalm) return aCalm - bCalm
        return b.index - a.index
      })
    let remaining = speakerLinesWithAct
    for (const candidate of candidates) {
      if (remaining <= maxSpeakerActions) break
      const directed = result.get(candidate.line.id)
      if (!directed) continue
      if (candidate.chars <= 7 && directed.facial) {
        // 短反应句只去多余动作/第2拍，保留 facial 表情
        const { motion: _m, beats: _b, ...rest } = directed
        result.set(candidate.line.id, rest)
        continue
      }
      const { motion: _motion, facial: _facial, beats: _beats, ...rest } = directed
      if (rest.listener) result.set(candidate.line.id, rest)
      else result.delete(candidate.line.id)
      remaining -= 1
    }
  }

  // 2-beat Talk.actions 达标补强（约 20% 长句带转折的台词配第 2 拍微转折；短测试 <12 句不动）
  if (dialogue.lines.length >= 12) {
    const targetMulti = Math.round(dialogue.lines.length * 0.2)
    let multiCount = [...result.values()].filter((d) => (d.beats?.length ?? 0) >= 2).length
    if (multiCount < targetMulti) {
      const clauseSplit = /[，,……—\n！？!?]/
      for (const line of dialogue.lines) {
        if (multiCount >= targetMulti) break
        const directed = result.get(line.id)
        if (!directed || (directed.beats?.length ?? 0) >= 2) continue
        if (!directed.motion && !directed.facial) continue
        const chars = Array.from(line.content.replace(/\s+/g, '')).length
        if (chars < 15 || !clauseSplit.test(line.content.slice(2, -2))) continue
        const speaker = plan.cast.find((c) => c.name === line.speaker)
        if (!speaker) continue
        const nextFacial = pickCalmOrMatchingFacial(view, speaker.modelId, line.emotion, directed.facial)
        const nextMotion = pickFollowupMotion(view, speaker.modelId, directed.motion)
        if (!nextFacial && !nextMotion) continue
        directed.beats = [
          {
            at: 0,
            ...(directed.motion ? { motion: directed.motion } : {}),
            ...(directed.facial ? { facial: directed.facial } : {})
          },
          {
            at: 0.55,
            ...(nextMotion ? { motion: nextMotion } : {}),
            ...(nextFacial ? { facial: nextFacial } : {})
          }
        ]
        multiCount += 1
      }
    }
  }

  const ambient = normalizeAmbient(doc.ambient ?? doc.timeOfDay)
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
    secondBgm !== 'silence' &&
    secondBgm !== bgm &&
    secondBgmFromIndex > 0 &&
    secondBgmFromIndex < dialogue.lines.length - 1

  return {
    background: mainBackground,
    ...(useSecond
      ? { background2: secondBackground as string, background2From: secondFromIndex }
      : {}),
    ambient,
    bgm: bgm === 'silence' ? '' : bgm,
    ...(useSecondBgm ? { bgm2: secondBgm as string, bgm2From: secondBgmFromIndex } : {}),
    bgmStop: bgm && bgm !== 'silence' ? toBool(doc.bgmStop ?? doc.stopBgm) : false,
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
// 第五段：合并成官方 StoryData（composeStory）
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

export interface StagedPresenceSegment {
  from: number
  to: number
  mode: 'solo' | 'duo' | 'trio'
  speaker?: string
  castIds?: number[]
}

/**
 * 舞台在场计划：
 * - 双人戏严格遵守全片两人同场（Left/Right）；
 * - 单人戏保持 Center；
 * - 3~5 人戏按分幕/说话组动态切换（3人启用 ThreeMode）。
 */
export function planPresence(
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  _direction?: StagedDirection,
  staging?: StagedStaging
): StagedPresenceSegment[] {
  if (dialogue.lines.length === 0) return []
  const last = dialogue.lines.length - 1
  if (plan.cast.length === 1) {
    return [{ from: 0, to: last, mode: 'solo', speaker: dialogue.lines[0].speaker, castIds: [plan.cast[0].modelId] }]
  }
  if (plan.cast.length === 2) {
    return [{ from: 0, to: last, mode: 'duo', castIds: plan.cast.map((c) => c.modelId) }]
  }
  const scenes = staging?.scenes ?? []
  if (scenes.length > 0) {
    return scenes.map((scene, index) => {
      const to = index + 1 < scenes.length ? Math.max(scene.fromIndex, scenes[index + 1].fromIndex - 1) : last
      const count = scene.activeCast.length
      return {
        from: scene.fromIndex,
        to,
        mode: count >= 3 ? 'trio' : count === 2 ? 'duo' : 'solo',
        ...(count === 1 ? { speaker: plan.cast.find((c) => c.modelId === scene.activeCast[0])?.name } : {}),
        castIds: scene.activeCast
      }
    })
  }
  const initialIds = plan.cast.slice(0, Math.min(3, plan.cast.length)).map((c) => c.modelId)
  return [{ from: 0, to: last, mode: initialIds.length >= 3 ? 'trio' : 'duo', castIds: initialIds }]
}

/**
 * 把五阶段结果合成为官方 PJSK 规范的 StoryData。
 *
 * 保持双人全片同场、三人 ThreeMode、99% 原地淡入淡出、93% delay=0、
 * 入场防重叠去重、转场前 closeWindowOnFinish、Move/PlaySe/SideFade/Flashback/Sekai/Hologram 全部精确对齐。
 */
export function composeStory(
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  direction: StagedDirection,
  staging?: StagedStaging
): JsonRecord {
  const cast = activeCast(plan, dialogue, direction)
  if (cast.length === 0) throw new Error('台词稿没有可用的出场角色')

  const effectiveStaging =
    staging && staging.scenes.length > 0 ? staging : fallbackStaging(view, plan, dialogue)

  // 如果 direction 指定了 background2 / ambient / bgm2（旧单测或 3 段路径），合并入分幕表
  if (!staging) {
    const s0 = effectiveStaging.scenes[0]
    if (s0) {
      s0.background = normalizeBackground(view, direction.background || s0.background)
      s0.ambient = direction.ambient || s0.ambient
      if (direction.bgm) s0.bgm = direction.bgm
    }
    if (
      direction.background2 &&
      direction.background2From !== undefined &&
      direction.background2From > 0 &&
      effectiveStaging.scenes.length === 1
    ) {
      effectiveStaging.scenes.push({
        id: 's2',
        fromLineId: dialogue.lines[direction.background2From]?.id ?? 'l2',
        fromIndex: direction.background2From,
        background: normalizeBackground(view, direction.background2),
        ambient: direction.ambient || 'normal',
        transitionIn: 'black',
        activeCast: effectiveStaging.scenes[0].activeCast
      })
    }
  }

  const imageMap = new Map<string, number>()
  const images: Array<{ id: number; image: string }> = []
  const registerImage = (file: string): number => {
    const normalized = normalizeBackground(view, file)
    if (!normalized) return 1
    const existing = imageMap.get(normalized)
    if (existing !== undefined) return existing
    const id = images.length + 1
    imageMap.set(normalized, id)
    images.push({ id, image: normalized })
    return id
  }
  for (const scene of effectiveStaging.scenes) {
    registerImage(scene.background)
  }
  if (images.length === 0) registerImage(direction.background || plan.background)

  const models = cast.map((member) => ({
    id: member.modelId,
    model: member.path,
    normal_scale: 2.1,
    small_scale: 1.8,
    anchor: 0.5
  }))

  const snippets: JsonRecord[] = []
  type SideSlot = 'Left' | 'Center' | 'Right'
  interface StageActorState {
    side: SideSlot
    offset: number
    hologram: boolean
    appearedAtLine: number
    appearedWithMotion: boolean
    appearFacial: string
    speakingCountSinceAppear: number
  }
  const onStage = new Map<number, StageActorState>()
  let layoutMode: 'Normal' | 'Three' | null = null
  let windowOpen = false
  let flashbackActive = false
  let currentEffect = ''
  let currentBgm = ''
  let cameraDirty = false
  let shakeScreenActive = false

  const closeWindowBeforeBreak = (): void => {
    if (!windowOpen) return
    for (let i = snippets.length - 1; i >= 0; i--) {
      if (snippets[i].type === 'Talk') {
        const d = snippets[i].data as JsonRecord
        d.closeWindowOnFinish = true
        windowOpen = false
        return
      }
      if (snippets[i].type === 'HideTalk') {
        windowOpen = false
        return
      }
    }
    snippets.push({ type: 'HideTalk', wait: true, progressBehavior: 'WaitFinished', delay: 0 })
    windowOpen = false
  }

  const resetCameraIfNeeded = (): void => {
    if (!cameraDirty) return
    snippets.push({
      type: 'CameraZoom',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { scale: 1, duration: 400, ease: 'OutQuad' }
    })
    snippets.push({
      type: 'CameraMove',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { x: 0, y: 0, duration: 400, ease: 'OutQuad' }
    })
    cameraDirty = false
  }

  const stopShakeScreenIfNeeded = (): void => {
    if (!shakeScreenActive) return
    snippets.push({ type: 'StopShakeScreen', wait: false, progressBehavior: 'Now', delay: 0, data: {} })
    shakeScreenActive = false
  }

  const switchLayoutMode = (target: 'Normal' | 'Three'): void => {
    if (layoutMode === target) return
    snippets.push({
      type: 'ChangeLayoutMode',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { mode: target }
    })
    layoutMode = target
  }

  const clearActors = (ids: number[], walkOutSet = new Set<number>()): void => {
    const toClear = ids.filter((id) => onStage.has(id))
    if (toClear.length === 0) return
    for (const id of toClear) {
      const state = onStage.get(id)!
      if (state.hologram) {
        snippets.push({
          type: 'AttachCharacterShader',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { modelId: id, shader: 'none' }
        })
      }
    }
    toClear.forEach((id, idx) => {
      const state = onStage.get(id)!
      const isWalk = walkOutSet.has(id)
      const toSide = isWalk
        ? state.side === 'Left'
          ? 'LeftOver'
          : 'RightOver'
        : state.side
      snippets.push({
        type: 'LayoutClear',
        wait: idx === 0,
        progressBehavior: idx === 0 ? 'WaitFinished' : 'Now',
        delay: 0,
        data: {
          modelId: id,
          from: { side: state.side, offset: state.offset },
          to: { side: toSide, offset: isWalk ? 0 : state.offset },
          motion: '',
          facial: '',
          moveSpeed: 'Normal'
        }
      })
      onStage.delete(id)
    })
  }

  const appearActors = (
    targetIds: number[],
    lineIndex: number,
    options: {
      walkInSet?: Set<number>
      walkOutSet?: Set<number>
      hologramSet?: Set<number>
      forceReenter?: boolean
    } = {}
  ): void => {
    const validIds = targetIds.filter((id) => cast.some((c) => c.modelId === id)).slice(0, 3)
    if (validIds.length === 0) return

    const desiredMode: 'Normal' | 'Three' = validIds.length >= 3 ? 'Three' : 'Normal'
    const walkInSet = options.walkInSet ?? new Set<number>()
    const walkOutSet = options.walkOutSet ?? new Set<number>()
    const hologramSet = options.hologramSet ?? new Set<number>()

    const sameGroup =
      !options.forceReenter &&
      desiredMode === layoutMode &&
      validIds.length === onStage.size &&
      validIds.every((id) => onStage.has(id))
    if (sameGroup) return

    const targetSlots: SideSlot[] =
      desiredMode === 'Three'
        ? ['Left', 'Center', 'Right']
        : validIds.length === 1
          ? ['Center']
          : ['Left', 'Right']

    // 避免局部改组槽位冲突：双人或换模式/多人重排时先原地清出不在目标或槽位需重排的成员
    const outgoing = [...onStage.keys()].filter((id) => {
      if (!validIds.includes(id)) return true
      const slotIdx = validIds.indexOf(id)
      return onStage.get(id)?.side !== targetSlots[slotIdx]
    })
    clearActors(outgoing, walkOutSet)
    switchLayoutMode(desiredMode)

    const incoming = validIds.filter((id) => !onStage.has(id))
    incoming.forEach((id, idx) => {
      const slot = targetSlots[validIds.indexOf(id)]
      const isWalk = walkInSet.has(id)
      const fromPos = isWalk
        ? { side: slot === 'Left' ? 'LeftOver' : 'RightOver', offset: 0 }
        : { side: slot, offset: 0 }
      const entryMotion = pickStageMotion(view, id)
      const entryFacial = view.defaultFacial(id)
      const isHolo = hologramSet.has(id)
      snippets.push({
        type: 'LayoutAppear',
        wait: idx === 0,
        progressBehavior: idx === 0 ? 'WaitFinished' : 'Now',
        delay: 0,
        data: {
          modelId: id,
          from: fromPos,
          to: { side: slot, offset: 0 },
          motion: entryMotion,
          facial: entryFacial,
          facialFirst: true,
          moveSpeed: 'Normal',
          hologram: isHolo
        }
      })
      if (isHolo) {
        snippets.push({
          type: 'AttachCharacterShader',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { modelId: id, shader: 'hologram' }
        })
      }
      onStage.set(id, {
        side: slot,
        offset: 0,
        hologram: isHolo,
        appearedAtLine: lineIndex,
        appearedWithMotion: Boolean(entryMotion),
        appearFacial: entryFacial,
        speakingCountSinceAppear: 0
      })
    })
  }

  const applyBgmDirective = (bgmDirective: string | undefined, fadeMs = 700): void => {
    if (!bgmDirective || bgmDirective === 'keep') return
    if (bgmDirective === 'silence') {
      if (currentBgm) {
        snippets.push({
          type: 'ChangeBgm',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { file: '', stop: true, fadeMs }
        })
        currentBgm = ''
      }
      return
    }
    if (bgmDirective !== currentBgm) {
      snippets.push({
        type: 'ChangeBgm',
        wait: false,
        progressBehavior: 'Now',
        delay: 0,
        data: { file: bgmDirective, stop: false, fadeMs }
      })
      currentBgm = bgmDirective
    }
  }

  // ---- 开场首幕 -------------------------------------------------------------------------------------------
  const scene0 = effectiveStaging.scenes[0]
  if (scene0) {
    applyBgmDirective(scene0.bgm || direction.bgm, 600)
    const initialMode: 'Normal' | 'Three' = scene0.activeCast.length >= 3 ? 'Three' : 'Normal'
    switchLayoutMode(initialMode)
    const bgId = registerImage(scene0.background)
    snippets.push({
      type: 'BlackOut',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { duration: 500, color: 'black' }
    })
    snippets.push({
      type: 'ChangeBackgroundImage',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { imageId: bgId }
    })
    if (scene0.ambient !== 'normal') {
      snippets.push({
        type: 'AmbientColor',
        wait: false,
        progressBehavior: 'Now',
        delay: 0,
        data: { mode: scene0.ambient }
      })
    }
    snippets.push({
      type: 'BlackIn',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { duration: 600, color: 'black' }
    })
    if (scene0.telop) {
      snippets.push({
        type: 'Telop',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: { content: scene0.telop }
      })
    }
    if (scene0.placeInfo) {
      snippets.push({
        type: 'PlaceInfo',
        wait: false,
        progressBehavior: 'Now',
        delay: 0,
        data: { text: scene0.placeInfo }
      })
    }
    if (scene0.scenarioEffect) {
      snippets.push({
        type: 'PlayScenarioEffect',
        wait: false,
        progressBehavior: 'Now',
        delay: 0,
        data: { effectName: scene0.scenarioEffect }
      })
      currentEffect = scene0.scenarioEffect
    }
    appearActors(scene0.activeCast, 0, {
      walkInSet: new Set(scene0.walkInCast ?? []),
      hologramSet: new Set(scene0.hologramCast ?? [])
    })
  }

  // ---- 逐句编译分幕转场、走位事件、音效与表演 ----------------------------------------------------------------
  const sceneByStart = new Map(effectiveStaging.scenes.slice(1).map((s) => [s.fromIndex, s]))
  const eventByIndex = new Map(effectiveStaging.events.map((e) => [e.lineIndex, e]))
  const directionById = new Map(direction.lines.map((line) => [line.id, line]))

  for (let index = 0; index < dialogue.lines.length; index++) {
    const nextScene = sceneByStart.get(index)
    if (nextScene) {
      closeWindowBeforeBreak()
      stopShakeScreenIfNeeded()
      resetCameraIfNeeded()
      if (currentEffect) {
        snippets.push({
          type: 'StopScenarioEffect',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { effectName: currentEffect }
        })
        currentEffect = ''
      }
      applyBgmDirective(nextScene.bgm, 900)

      const bgId = registerImage(nextScene.background)
      const enteringFlashback = Boolean(nextScene.isFlashback) && !flashbackActive
      const leavingFlashback = !nextScene.isFlashback && flashbackActive
      const tKind = nextScene.transitionIn
      const closeFlashbackBehindCurtain = (): void => {
        if (!leavingFlashback) return
        snippets.push({
          type: 'FlashbackOut',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { duration: 100 }
        })
        flashbackActive = false
      }

      if (
        tKind === 'flashback' ||
        enteringFlashback ||
        (leavingFlashback && (tKind === 'black' || tKind === 'white'))
      ) {
        snippets.push({
          type: 'BlackOut',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { duration: 300, color: 'white' }
        })
        if (enteringFlashback) {
          snippets.push({
            type: 'PlaySe',
            wait: false,
            progressBehavior: 'Now',
            delay: 0,
            data: { file: 'se00053_b.mp3', volume: 0.9, loop: false, fadeMs: 0 }
          })
        }
        clearActors([...onStage.keys()], new Set(nextScene.walkOutCast ?? []))
        if (enteringFlashback) {
          snippets.push({
            type: 'FlashbackIn',
            wait: false,
            progressBehavior: 'Now',
            delay: 0,
            data: { duration: 100, alpha: 0.3 }
          })
          flashbackActive = true
        } else {
          closeFlashbackBehindCurtain()
        }
        snippets.push({
          type: 'ChangeBackgroundImage',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { imageId: bgId }
        })
        snippets.push({
          type: 'AmbientColor',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { mode: nextScene.ambient }
        })
        appearActors(nextScene.activeCast, index, {
          walkInSet: new Set(nextScene.walkInCast ?? []),
          hologramSet: new Set(nextScene.hologramCast ?? []),
          forceReenter: true
        })
        snippets.push({
          type: 'BlackIn',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { duration: 400, color: 'white' }
        })
      } else if (tKind === 'sekaiIn' || tKind === 'sekaiOut') {
        snippets.push({
          type: 'SekaiOut',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { duration: 500, variant: 'v2' }
        })
        clearActors([...onStage.keys()], new Set(nextScene.walkOutCast ?? []))
        closeFlashbackBehindCurtain()
        snippets.push({
          type: 'ChangeBackgroundImage',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { imageId: bgId }
        })
        snippets.push({
          type: 'AmbientColor',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { mode: nextScene.ambient }
        })
        appearActors(nextScene.activeCast, index, {
          walkInSet: new Set(nextScene.walkInCast ?? []),
          hologramSet: new Set(nextScene.hologramCast ?? []),
          forceReenter: true
        })
        snippets.push({
          type: 'SekaiIn',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { duration: 500, variant: 'v2' }
        })
      } else if (tKind === 'sideFade') {
        snippets.push({
          type: 'SideFade',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { direction: 'Left', edge: 'left', mode: 'Out', duration: 450 }
        })
        clearActors([...onStage.keys()], new Set(nextScene.walkOutCast ?? []))
        closeFlashbackBehindCurtain()
        snippets.push({
          type: 'ChangeBackgroundImage',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { imageId: bgId }
        })
        snippets.push({
          type: 'AmbientColor',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { mode: nextScene.ambient }
        })
        appearActors(nextScene.activeCast, index, {
          walkInSet: new Set(nextScene.walkInCast ?? []),
          hologramSet: new Set(nextScene.hologramCast ?? []),
          forceReenter: true
        })
        snippets.push({
          type: 'SideFade',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { direction: 'Right', edge: 'right', mode: 'In', duration: 450 }
        })
      } else {
        const fadeColor = tKind === 'white' ? 'white' : 'black'
        snippets.push({
          type: 'BlackOut',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { duration: 400, color: fadeColor }
        })
        clearActors([...onStage.keys()], new Set(nextScene.walkOutCast ?? []))
        snippets.push({
          type: 'ChangeBackgroundImage',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { imageId: bgId }
        })
        snippets.push({
          type: 'AmbientColor',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { mode: nextScene.ambient }
        })
        appearActors(nextScene.activeCast, index, {
          walkInSet: new Set(nextScene.walkInCast ?? []),
          hologramSet: new Set(nextScene.hologramCast ?? []),
          forceReenter: true
        })
        snippets.push({
          type: 'BlackIn',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { duration: 450, color: fadeColor }
        })
      }

      if (nextScene.telop) {
        snippets.push({
          type: 'Telop',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { content: nextScene.telop }
        })
      }
      if (nextScene.placeInfo) {
        snippets.push({
          type: 'PlaceInfo',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { text: nextScene.placeInfo }
        })
      }
      if (nextScene.scenarioEffect) {
        snippets.push({
          type: 'PlayScenarioEffect',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { effectName: nextScene.scenarioEffect }
        })
        currentEffect = nextScene.scenarioEffect
      }
    }

    // 兼容旧 direction.bgm2 写法（当没有 staging 分幕 BGM 时）
    if (!staging && direction.bgm2 && direction.bgm2From === index) {
      applyBgmDirective(direction.bgm2, 1200)
    }

    const line = dialogue.lines[index]
    const member = cast.find((entry) => entry.name === line.speaker)
    if (!member) continue
    const ev = eventByIndex.get(index)

    // 多人戏若本句说话人尚未在场，安全入场或分组切换
    if (ev?.stageGroup && plan.cast.length >= 3) {
      const targetGroup = ev.stageGroup.activeCast.includes(member.modelId)
        ? ev.stageGroup.activeCast
        : [member.modelId, ...ev.stageGroup.activeCast.slice(0, 2)]
      appearActors(targetGroup, index, {
        walkInSet: new Set(ev.stageGroup.walkIn ?? []),
        walkOutSet: new Set(ev.stageGroup.walkOut ?? [])
      })
    } else if (!onStage.has(member.modelId)) {
      if (plan.cast.length >= 3) {
        const currentIds = [...onStage.keys()]
        const nextIds =
          currentIds.length < 3 ? [...currentIds, member.modelId] : [...currentIds.slice(1), member.modelId]
        appearActors(nextIds, index)
      } else {
        appearActors(cast.map((c) => c.modelId), index)
      }
    }

    if (ev?.bgmCut) {
      if (ev.bgmCut.action === 'stop') applyBgmDirective('silence', ev.bgmCut.fadeMs ?? 600)
      else if (ev.bgmCut.file) applyBgmDirective(ev.bgmCut.file, ev.bgmCut.fadeMs ?? 800)
    }

    if (ev?.se && ev.se.timing !== 'during') {
      snippets.push({
        type: 'PlaySe',
        wait: false,
        progressBehavior: 'Now',
        delay: ev.se.delay ?? 0,
        data: { file: ev.se.file, volume: ev.se.volume ?? 0.9, loop: false, fadeMs: 0 }
      })
    }

    if (ev?.hologram && onStage.has(ev.hologram.modelId)) {
      const st = onStage.get(ev.hologram.modelId)!
      st.hologram = ev.hologram.enabled
      snippets.push({
        type: 'AttachCharacterShader',
        wait: false,
        progressBehavior: 'Now',
        delay: 0,
        data: { modelId: ev.hologram.modelId, shader: ev.hologram.enabled ? 'hologram' : 'none' }
      })
    }

    if (ev?.move && onStage.has(ev.move.modelId)) {
      const st = onStage.get(ev.move.modelId)!
      let targetSide = st.side
      if (ev.move.kind === 'shiftSlot' && ev.move.toSide) {
        const occupied = [...onStage.entries()].some(
          ([otherId, pos]) =>
            otherId !== ev.move!.modelId &&
            (pos.side === ev.move!.toSide ||
              (layoutMode === 'Normal' && (pos.side === 'Center' || ev.move!.toSide === 'Center')))
        )
        if (!occupied) targetSide = ev.move.toSide
      }
      const nextOffset =
        ev.move.kind === 'stepBack'
          ? 0
          : ev.move.offset ??
            (st.side === 'Left' ? 90 : st.side === 'Right' ? -90 : 0)
      if (targetSide !== st.side || nextOffset !== st.offset) {
        if ((ev.pauseBefore ?? 0) >= 0.8) closeWindowBeforeBreak()
        snippets.push({
          type: 'Move',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: {
            modelId: ev.move.modelId,
            from: { side: st.side, offset: st.offset },
            to: { side: targetSide, offset: nextOffset },
            moveSpeed: ev.move.moveSpeed ?? 'Normal',
            motion: '',
            facial: ''
          }
        })
        st.side = targetSide
        st.offset = nextOffset
      }
    }

    if (ev?.characterShake && onStage.has(ev.characterShake.modelId)) {
      snippets.push({
        type: 'CharacterShake',
        wait: false,
        progressBehavior: 'Now',
        delay: 0,
        data: { modelId: ev.characterShake.modelId, axis: ev.characterShake.axis }
      })
    }

    if (ev?.camera) {
      const cam = ev.camera
      if (cam.kind === 'zoomIn') {
        snippets.push({
          type: 'CameraZoom',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { scale: cam.scale ?? 1.1, duration: cam.durationMs ?? 500, ease: 'OutQuad' }
        })
        cameraDirty = true
      } else if (cam.kind === 'pan') {
        snippets.push({
          type: 'CameraMove',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { x: cam.x ?? 60, y: cam.y ?? 0, duration: cam.durationMs ?? 500, ease: 'OutQuad' }
        })
        cameraDirty = true
      } else if (cam.kind === 'zoomReset') {
        resetCameraIfNeeded()
      } else if (cam.kind === 'shakeWindow') {
        snippets.push({
          type: 'ShakeWindow',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { duration: cam.durationMs ?? 450 }
        })
      } else if (cam.kind === 'shakeScreen') {
        const dur = cam.durationMs ?? 450
        snippets.push({
          type: 'ShakeScreen',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { duration: dur, amplitude: 0.01 }
        })
        if (dur >= 10000) shakeScreenActive = true
      }
    }

    // ---- Talk 动作与入场去重 --------------------------------------------------------------------------------
    const directed = directionById.get(line.id)
    const actorState = onStage.get(member.modelId)
    const justAppeared =
      Boolean(actorState?.appearedWithMotion) &&
      actorState!.speakingCountSinceAppear === 0 &&
      (ev?.pauseBefore ?? 0) === 0 &&
      index === actorState!.appearedAtLine

    const actions: JsonRecord[] = []
    if (directed?.beats && directed.beats.length > 0) {
      for (const beat of directed.beats) {
        const skipMotion = justAppeared && beat.at < 0.35
        const motion = skipMotion ? undefined : beat.motion
        const facial = beat.facial
        if (!motion && !facial) continue
        actions.push({
          at: beat.at,
          modelId: member.modelId,
          ...(motion ? { motion } : {}),
          ...(facial ? { facial } : {})
        })
      }
    } else if (directed?.motion || directed?.facial) {
      const motion = justAppeared ? undefined : directed.motion
      const facial = directed.facial
      if (motion || facial) {
        actions.push({
          at: 0,
          modelId: member.modelId,
          ...(motion ? { motion } : {}),
          ...(facial ? { facial } : {})
        })
      }
    }

    if (
      directed?.listener &&
      directed.listener.modelId !== member.modelId &&
      onStage.has(directed.listener.modelId)
    ) {
      const listenerState = onStage.get(directed.listener.modelId)
      const listenerJustAppeared =
        Boolean(listenerState?.appearedWithMotion) &&
        index === (listenerState?.appearedAtLine ?? -99) &&
        (ev?.pauseBefore ?? 0) === 0
      const listenerMotion = listenerJustAppeared ? undefined : directed.listener.motion
      const listenerFacial = directed.listener.facial
      if (listenerMotion || listenerFacial) {
        actions.push({
          at: 0,
          modelId: directed.listener.modelId,
          ...(listenerMotion ? { motion: listenerMotion } : {}),
          ...(listenerFacial ? { facial: listenerFacial } : {})
        })
      }
    }

    if (actorState) {
      actorState.speakingCountSinceAppear += 1
      actorState.appearedWithMotion = false
    }

    const hasSilentAfter = Boolean(ev?.silentReaction || directed?.silentMotion)
    const closeAfter = Boolean(ev?.closeWindowAfter || line.closeWindowAfter || hasSilentAfter)
    const talkDelay = ev?.pauseBefore ?? line.pauseBefore ?? 0

    snippets.push({
      type: 'Talk',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: talkDelay,
      data: {
        speaker: member.name,
        content: line.content,
        ttsText: line.ttsText ?? '',
        emotion: line.emotion ?? '',
        modelId: member.modelId,
        ...(closeAfter ? { closeWindowOnFinish: true } : {}),
        ...(actions.length > 0 ? { actions } : {})
      }
    })
    windowOpen = !closeAfter

    if (ev?.se && ev.se.timing === 'during') {
      snippets.push({
        type: 'PlaySe',
        wait: false,
        progressBehavior: 'Now',
        delay: ev.se.delay ?? 0.15,
        data: { file: ev.se.file, volume: ev.se.volume ?? 0.9, loop: false, fadeMs: 0 }
      })
    }

    if (ev?.silentReaction && onStage.has(ev.silentReaction.modelId)) {
      const targetId = ev.silentReaction.modelId
      const motion = ev.silentReaction.motion || pickFollowupMotion(view, targetId)
      const facial = ev.silentReaction.facial || ''
      if (motion || facial) {
        snippets.push({
          type: 'Motion',
          wait: false,
          progressBehavior: 'Now',
          delay: 0.25,
          data: {
            modelId: targetId,
            motion: motion || '',
            facial: facial || '',
            facialFirst: true
          }
        })
      }
    }
  }

  // ---- 收尾与全部效果闭合 ----------------------------------------------------------------------------------
  closeWindowBeforeBreak()
  stopShakeScreenIfNeeded()
  resetCameraIfNeeded()
  if (currentEffect) {
    snippets.push({
      type: 'StopScenarioEffect',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { effectName: currentEffect }
    })
  }
  if (currentBgm && direction.bgmStop) {
    snippets.push({
      type: 'ChangeBgm',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { file: '', stop: true, fadeMs: 800 }
    })
  }
  clearActors([...onStage.keys()])
  if (flashbackActive) {
    snippets.push({
      type: 'FlashbackOut',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { duration: 100 }
    })
  }
  snippets.push({
    type: 'BlackOut',
    wait: true,
    progressBehavior: 'WaitFinished',
    delay: 0,
    data: { duration: 600, color: 'black' }
  })

  return { models, images, snippets }
}
