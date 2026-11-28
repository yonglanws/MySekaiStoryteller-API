import type { RagRetrieveResult } from '../../rag/types'
import type { CatalogModel } from '../../resources/resourceCatalog'
import * as corpusExamplesMod from '../corpusExamples'
import * as personasMod from '../personas'
import {
  extractPairwiseAddressBook,
  inferUnitFromText,
  normalizePjskTerminology,
  normalizeUnit,
  personaFor,
  planningPersonaPrompt,
  type PersonaEntry,
  type PersonaLookupOptions
} from '../personas'
import {
  isBackViewModel,
  isExplicitDarkVoidContext,
  isSolidOrCurtainBackground,
  type CatalogView
} from '../prompt'
import { isVirtualSingerModel } from '../scenarioCues'
import { normalizeDialogueLineBreaks } from '../validate'
import type {
  CanonGroundingBriefOptions,
  JsonRecord,
  StagedCastMember,
  StagedCastPlan,
  StagedCharacterGoal,
  StagedDialogue,
  StagedDirection,
  StagedPairwiseAddress,
  StagedStaging,
  StagedTransitionKind
} from './types'

export const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback

export const num = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

export const oneLine = (value: unknown, limit: number): string =>
  normalizePjskTerminology(str(value).replace(/\s+/g, ' ').trim()).slice(0, limit)

export const displayWidth = (text: string): number =>
  Array.from(text).reduce((sum, char) => sum + (char.codePointAt(0)! >= 0x2e80 ? 1 : 0.5), 0)

export const formatDialogueLineForPrompt = (text: string): string =>
  text.replace(/\r\n?/g, '\n').replace(/\n/g, '\\n')

export const cleanText = (value: unknown): string => {
  const text = normalizePjskTerminology(
    normalizeDialogueLineBreaks(str(value))
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

interface PersonasStagedExt {
  characterActingProfile?: (
    nameOrPath: string,
    roleHint?: string
  ) => { restrained: boolean; temperament: string; actingNote: string }
}

interface CorpusExamplesStagedExt {
  getOfficialActingGuidelines?: (options?: {
    castCount?: number
    isSekai?: boolean
    isFlashback?: boolean
  }) => string
}

export const personasStagedApi = personasMod as unknown as PersonasStagedExt

export const corpusStagedApi = corpusExamplesMod as unknown as CorpusExamplesStagedExt

export const FOOD_DRINK_CUE_RE =
  /吃|喝|美味|好吃|甜品|蛋糕|面包|拉面|茶|咖啡|点心|便当|饮料|食物|品尝|味道|饿|嘴馋|delicious|eat|drink/i

export const SLEEP_CUE_RE = /困|睡|熬夜|累|疲惫|打哈欠|睡着|午睡|晚安|想睡|sleep|tired|yawn/i

/** 把模型写出的角色标识（modelId / cloudId / 名称 / 路径 / 服装描述 / 人设别名）收束到目录里的角色。 */
export function resolveModel(
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
  const exactCloudOrPath = view.models.find((model) => {
    const p = model.path.toLowerCase()
    const base = p.split('/').pop() ?? p
    return (model.cloudId ?? '').toLowerCase() === lower || p === lower || base === lower
  })
  if (exactCloudOrPath) return exactCloudOrPath

  // 按正面模型与默认服装优先匹配角色全名/简称
  const directByName = view.models
    .filter(
      (model) =>
        model.name.toLowerCase() === lower || (model.shortName ?? '').toLowerCase() === lower
    )
    .sort(
      (a, b) =>
        Number(isBackViewModel(a)) - Number(isBackViewModel(b)) ||
        Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)) ||
        a.id - b.id
    )
  if (directByName.length > 0) return directByName[0]

  // 支持「角色名 服装」（如「星乃一歌 校服」「瑞希 私服」）
  for (const primary of view.primaryModels()) {
    const shortName = view.shortName(primary)
    if ((primary.name && text.includes(primary.name)) || (shortName && text.includes(shortName))) {
      const rest = text.replace(primary.name, '').replace(shortName, '').trim()
      if (rest) {
        const outfitHit = view.resolveOutfitVariant(primary, rest)
        if (outfitHit) return outfitHit
      }
    }
  }

  const aliasHits = view.models
    .filter((model) => {
      const persona = personaFor(personas, model)
      return persona
        ? [persona.name, ...persona.aliases].some((alias) => alias.toLowerCase() === lower)
        : false
    })
    .sort(
      (a, b) =>
        Number(isBackViewModel(a)) - Number(isBackViewModel(b)) ||
        Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)) ||
        a.id - b.id
    )
  if (aliasHits.length > 0) return aliasHits[0]
  return null
}

export function resolveFirstModel(
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

export function entriesOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!isRecord(value)) return []
  return Object.entries(value).map(([id, item]) => {
    if (isRecord(item)) return { ...item, id }
    if (typeof item === 'string') return { id, content: item, motion: item }
    return { id }
  })
}

export function unwrapRecord(raw: unknown, keys: string[]): unknown {
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

export function personaSummary(persona: PersonaEntry | null, maxChars = 320): string {
  if (!persona) return ''
  const distilled = planningPersonaPrompt(persona, maxChars)
  if (distilled) return distilled
  const text = persona.prompt.replace(/\s+/g, ' ').trim()
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

export function resolveMemberPersona(
  personas: PersonaEntry[],
  member: Pick<StagedCastMember, 'modelId' | 'name' | 'fullName' | 'path'>,
  view?: CatalogView,
  contextText = ''
): PersonaEntry | null {
  if (personas.length === 0) return null
  const model: CatalogModel = view?.modelById(member.modelId) ?? {
    id: member.modelId,
    name: member.fullName || member.name,
    shortName: member.name,
    path: member.path,
    motions: [],
    facials: [],
    defaultMotion: '',
    defaultFacial: ''
  }
  const unitHint = normalizeUnit(model.unit) ?? inferUnitFromText(contextText)
  return personaFor(personas, model, {
    ...(unitHint ? { unitHint } : {}),
    ...(contextText ? { contextText } : {})
  })
}

export function resolveCastPersonas(
  personas: PersonaEntry[],
  cast: ReadonlyArray<Pick<StagedCastMember, 'modelId' | 'name' | 'fullName' | 'path'>>,
  view?: CatalogView,
  contextText = ''
): PersonaEntry[] {
  if (personas.length === 0) return []
  const out: PersonaEntry[] = []
  const seen = new Set<PersonaEntry>()
  for (const member of cast) {
    const resolved = resolveMemberPersona(personas, member, view, contextText)
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved)
      out.push(resolved)
    }
  }
  return out
}

export function mergePairwiseAddresses(
  personas: PersonaEntry[] | undefined,
  castNames: string[],
  existing?: StagedPairwiseAddress[],
  lookupOptions?: PersonaLookupOptions
): StagedPairwiseAddress[] | undefined {
  const merged = new Map<string, StagedPairwiseAddress>()
  const safePersonas = Array.isArray(personas) ? personas : []
  for (const rule of extractPairwiseAddressBook(safePersonas, castNames, lookupOptions)) {
    const key = `${rule.from}::${rule.to}`
    merged.set(key, { from: rule.from, to: rule.to, zh: rule.zh })
  }
  for (const entry of existing ?? []) {
    const key = `${entry.from}::${entry.to}`
    const prev = merged.get(key)
    merged.set(key, {
      from: entry.from,
      to: entry.to,
      zh: entry.zh || prev?.zh || entry.to,
      ...(entry.ja ? { ja: entry.ja } : {})
    })
  }
  return merged.size > 0 ? [...merged.values()] : undefined
}

export function castMemberFor(
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

export function matchBackground(
  view: CatalogView,
  value: unknown,
  options: { allowSolidCurtain?: boolean; contextHint?: string } = {}
): string {
  const text = str(value).trim()
  if (!text) return ''
  const entry = view.canonicalImageEntry(text)
  if (!entry) return ''
  const allowSolid =
    Boolean(options.allowSolidCurtain) ||
    isExplicitDarkVoidContext(`${text} ${options.contextHint ?? ''}`)
  if (!allowSolid && isSolidOrCurtainBackground(entry)) {
    return ''
  }
  return entry.file
}

export function normalizeBackground(view: CatalogView, value: unknown, contextHint = ''): string {
  const raw = str(value).trim()
  const allowSolidCurtain = isExplicitDarkVoidContext(`${raw} ${contextHint}`)
  const matched = matchBackground(view, raw, { allowSolidCurtain, contextHint })
  if (matched) return matched
  const combinedHint = [isSolidOrCurtainBackground(raw) ? '' : raw, contextHint.trim()]
    .filter(Boolean)
    .join(' ')
  return view.pickScenicFallbackImage(combinedHint) || view.defaultImage()
}

export function matchBgm(view: CatalogView, value: unknown): string {
  const text = str(value).trim()
  if (!text) return ''
  if (text.toLowerCase() === 'silence' || text.toLowerCase().startsWith('bgm00000')) {
    return 'silence'
  }
  return view.canonicalBgm(text) ?? ''
}

export function normalizeAmbient(value: unknown): 'normal' | 'evening' | 'night' {
  const raw = str(value).trim().toLowerCase()
  return raw === 'evening' ? 'evening' : raw === 'night' ? 'night' : 'normal'
}

export function normalizeTransitionKind(value: unknown): StagedTransitionKind {
  const raw = str(value).trim().toLowerCase()
  if (raw.includes('flashback')) return 'flashback'
  if (raw.includes('sekaiout') || raw === 'sekai_out') return 'sekaiOut'
  if (raw.includes('sekaiin') || raw === 'sekai_in' || raw === 'sekai' || raw.includes('世界'))
    return 'sekaiIn'
  if (raw.includes('side') || raw.includes('wipe')) return 'sideFade'
  if (raw.includes('white')) return 'white'
  return 'black'
}

export const toBool = (value: unknown): boolean =>
  value === true || value === 1 || value === 'true' || value === 'yes'

export function castBlock(plan: StagedCastPlan): string {
  return plan.cast
    .map(
      (member) =>
        `- ${member.name}（say: "${member.name}"，modelId=${member.modelId}${
          member.isVirtualSinger ? '，虚拟歌手' : ''
        }）${member.role ? ` — ${member.role}` : ''}`
    )
    .join('\n')
}

export function lineBudget(targetMinutes: number): number {
  return Math.max(10, Math.min(80, Math.round(targetMinutes * 10)))
}

export function titleOrDefault(value: unknown, fallback: string): string {
  return oneLine(value, 64) || fallback
}

// ---------------------------------------------------------------------------
// 第二段：只写台词（writeDialogue）
// ---------------------------------------------------------------------------

/** 解析 Stage 1 输出的角色表里动机；容忍字符串条目与不同字段别名。 */
export function normalizeCharacterGoals(raw: unknown): StagedCharacterGoal[] {
  if (!Array.isArray(raw)) return []
  const goals: StagedCharacterGoal[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const wants = oneLine(item, 120)
      if (wants) goals.push({ cast: '', wants, hides: '' })
    } else if (isRecord(item)) {
      const cast = oneLine(item.cast ?? item.name ?? item.id ?? item.speaker, 24)
      const wants = oneLine(item.wants ?? item.goal ?? item.desire, 120)
      const hides = oneLine(item.hides ?? item.secret ?? item.conceals, 120)
      if (wants || hides) goals.push({ cast, wants, hides })
    }
    if (goals.length >= 6) break
  }
  return goals
}

export function formatUnderstandingBlock(plan: StagedCastPlan): string {
  const u = plan.understanding
  if (!u) return ''
  const parts: string[] = []
  if (u.explicitRequests.length > 0) parts.push(`- 显性要求：${u.explicitRequests.join('；')}`)
  if (u.implicitSubtext) parts.push(`- 潜台词：${u.implicitSubtext}`)
  if (u.relationshipDynamic) parts.push(`- 关系张力：${u.relationshipDynamic}`)
  if (u.emotionalArc) parts.push(`- 情绪弧光：${u.emotionalArc}`)
  if (u.turningPoint) parts.push(`- 中段转折点：${u.turningPoint}`)
  if (u.openingMotif || u.closingCallback) {
    parts.push(
      `- 意象与收尾回扣：开场「${u.openingMotif || '日常小物件'}」→ 结尾「${u.closingCallback || '轻巧呼应，不作总结'}」`
    )
  }
  const goals = u.characterGoals ?? []
  if (goals.length > 0) {
    const rows = goals.map((goal) => {
      const who = goal.cast || '角色'
      return `${who}（想：${goal.wants || '—'} / 藏：${goal.hides || '—'}）`
    })
    parts.push(`- 角色表里动机：${rows.join('；')}`)
  }
  if (u.canonHooks.length > 0) parts.push(`- 官方呼应点：${u.canonHooks.join('；')}`)
  if (u.avoidList.length > 0) parts.push(`- 避坑禁忌：${u.avoidList.join('；')}`)
  return parts.length > 0
    ? `\n## 导演意图、中段转折与意象呼应（务必落实到对话细节中，不要直白说破）\n${parts.join('\n')}\n`
    : ''
}

export function formatPairwiseAddressBlock(plan: StagedCastPlan): string {
  const list = plan.pairwiseAddress
  if (!list || list.length === 0) return ''
  const rows = list.map(
    (entry) =>
      `- ${entry.from} 称呼 ${entry.to}：中文「${entry.zh}」${entry.ja ? ` / 日文「${entry.ja}」` : ''}`
  )
  return `\n## 角色两两称呼表（严格遵守，禁止随意改称呼）\n${rows.join('\n')}\n`
}

/**
 * 按整段/整行边界装箱 RAG 摘录：宁可少给一条，也不在句子中间硬切，
 * 避免旧实现 `promptBlock.slice(0, 1500)` 把最后一条参考拦腰截断。
 */
export function packExcerptsCleanly(
  items: ReadonlyArray<string | { text?: string }> | undefined,
  budget: number
): string {
  if (!items || items.length === 0 || budget <= 0) return ''
  const kept: string[] = []
  let used = 0
  for (const item of items) {
    const text = (typeof item === 'string' ? item : (item.text ?? '')).trim()
    if (!text) continue
    if (kept.length > 0 && used + text.length + 2 > budget) break
    if (kept.length === 0 && text.length > budget) {
      const lines = text.split('\n')
      const acc: string[] = []
      let length = 0
      for (const line of lines) {
        if (acc.length > 0 && length + line.length + 1 > budget) break
        acc.push(line)
        length += line.length + 1
      }
      if (acc.length > 0) kept.push(acc.join('\n'))
      break
    }
    kept.push(text)
    used += text.length + 2
  }
  return kept.join('\n\n')
}

/**
 * 结构化 Canon & Prompt Grounding Brief：
 * ① 用户原始需求全文 → ② 导演意图/转折/意象（plan.understanding）→ ③ 官方剧情事实与世界观 → ④ 官方对白口吻样本 + 防照抄声明。
 * 全程按分段边界装箱，不做字符级硬截断。
 */
export function formatCanonGroundingBrief(options: CanonGroundingBriefOptions = {}): string {
  const {
    scene = '',
    plan = null,
    ragContext = null,
    stage = 'dialogue',
    maxChars = 2400
  } = options
  const blocks: string[] = []

  const prompt = scene.trim()
  if (stage !== 'cast' && prompt) {
    blocks.push(`## 用户原始需求（逐条核对，不要遗漏具体要求）\n${prompt}`)
  }

  const understanding = plan ? formatUnderstandingBlock(plan).trim() : ''
  if (understanding) blocks.push(understanding)

  const ragParts: string[] = []
  let remaining = maxChars
  if (ragContext) {
    const sections = ragContext.sections
    if (sections) {
      // 均衡分配 3 栏预算（canonPlot / worldviewLore / dialogueVoice），避免单一类别挤占其它栏目
      const plotCap = Math.min(remaining, Math.round(maxChars * 0.4))
      const plotText = packExcerptsCleanly(sections.canonPlot, plotCap)
      if (plotText) {
        ragParts.push(
          `### 相关官方剧情与事件参考（尊重事实与连续性，不要当成背景解说背诵）\n${plotText}`
        )
        remaining -= plotText.length
      }
      const loreCap = Math.min(remaining, Math.round(maxChars * 0.3))
      const loreText = packExcerptsCleanly(sections.worldviewLore, loreCap)
      if (loreText) {
        ragParts.push(`### 世界观、地点与角色补充设定\n${loreText}`)
        remaining -= loreText.length
      }
      if (stage !== 'cast' && remaining > 120) {
        const voiceCap = Math.min(remaining, Math.round(maxChars * 0.35))
        const voiceText = packExcerptsCleanly(sections.dialogueVoice, voiceCap)
        if (voiceText) {
          ragParts.push(
            `### 官方对白口吻样本（只学称呼、断句、停顿与互动节奏，严禁照抄原句或复述原事件）\n${voiceText}`
          )
        }
      }
    } else if (ragContext.promptBlock.trim()) {
      // 兜底：只填了 promptBlock 的旧/测试检索结果
      const legacy = packExcerptsCleanly([ragContext.promptBlock], maxChars)
      if (legacy) ragParts.push(legacy)
    }
  }
  if (ragParts.length > 0) {
    blocks.push(
      `## 官方剧情与设定参考（仅作事实、关系与口吻参考，严禁照抄原句或复述原剧情）\n${ragParts.join('\n\n')}`
    )
  }

  return blocks.length > 0 ? `\n${blocks.join('\n\n')}\n` : ''
}

/**
 * 导演/表演/配音阶段共用的 Stage 1 锚点：中段转折点、开场意象、收尾回扣与用户显性诉求。
 * 让镜头、BGM 停顿、动作与声演峰值精准落在计划转折点上，而不是平均铺满全篇。
 */
export function formatDirectingAnchorBlock(plan: StagedCastPlan): string {
  const u = plan.understanding
  if (!u) return ''
  const lines: string[] = []
  if (u.turningPoint) {
    lines.push(`- 中段转折点（镜头/BGM/停顿/动作与声演峰值优先落在这里）：${u.turningPoint}`)
  }
  if (u.openingMotif) lines.push(`- 开场日常意象（前 1~4 句具体出现）：${u.openingMotif}`)
  if (u.closingCallback) {
    lines.push(`- 收尾回扣（结尾 2~3 句轻巧呼应，不要升华说教）：${u.closingCallback}`)
  }
  if (u.explicitRequests.length > 0) {
    lines.push(`- 用户显性诉求（必须演到位）：${u.explicitRequests.join('；')}`)
  }
  if (u.emotionalArc) lines.push(`- 整体情绪弧光：${u.emotionalArc}`)
  return lines.length > 0 ? `\n## 导演锚点（Stage 1 已规划，务必对齐）\n${lines.join('\n')}\n` : ''
}

export function formatWorldviewCueBlock(ragContext?: RagRetrieveResult | null): string {
  const lore = ragContext?.sections?.worldviewLore ?? []
  if (lore.length === 0) return ''
  const compact = lore
    .slice(0, 3)
    .map((item) => item.text.slice(0, 260).trim())
    .filter(Boolean)
    .join('\n')
  return compact ? `\n## 场景与设定补充线索（仅用于核对环境/道具/氛围）\n${compact}\n` : ''
}

// ---------------------------------------------------------------------------
// 第五段：合并成官方 StoryData（composeStory）
// ---------------------------------------------------------------------------

export function activeCast(
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  direction: StagedDirection,
  staging?: StagedStaging
): StagedCastMember[] {
  const listeners = new Set(
    direction.lines
      .map((line) => line.listener?.modelId)
      .filter((id): id is number => typeof id === 'number')
  )
  // 听者动作被预算裁掉后，人仍按分幕 activeCast 留在台上安静倾听；
  // 出场名单以分幕为准，不能因为少了一个 listener 动作就把同台演员从画面里拿掉。
  const staged = new Set<number>()
  for (const scene of staging?.scenes ?? []) {
    for (const id of scene.activeCast) staged.add(id)
  }
  return plan.cast.filter(
    (member) =>
      staged.has(member.modelId) ||
      listeners.has(member.modelId) ||
      dialogue.lines.some((line) => line.speaker === member.name)
  )
}
