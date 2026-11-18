import type {
  CatalogBgm,
  CatalogImage,
  CatalogModel,
  ResourceCatalogData
} from '../resources/resourceCatalog'
import { normalizeBgmFile } from '../../common/audio/bgm'
import { GENERIC_PROFILE, dialoguePersonaPrompt, personaFor, type PersonaEntry } from './personas'
import { CURATED_SCENARIO_SES, resolveScenarioSe, sePromptList } from './scenarioCues'

// 单个角色的动作/表情提示词上限。云端角色普遍有 240+ 动作、50~140 表情，
// 全量清单会占掉提示词绝大部分，而且长编号列表会诱导模型拼出不存在的名称。
// 这里按语义挑出覆盖常见情绪的完整名称：既小又准，模型不必猜编号。
const MOTION_PROMPT_LIMIT = 34
const FACIAL_PROMPT_LIMIT = 28
const MOTION_PROMPT_KINDS: Array<[string, number]> = [
  ['nod', 2],
  ['tilthead', 2],
  ['glad', 2],
  ['sad', 2],
  ['trouble', 2],
  ['shakehead', 1],
  ['surprise', 1],
  ['shy', 1],
  ['blushed', 1],
  ['sigh', 1],
  ['relief', 1],
  ['think', 1],
  ['lookaway', 1],
  ['lookdown', 1],
  ['lookup', 1],
  ['angry', 1],
  ['forward', 1],
  ['fidget', 1],
  ['greeting', 1],
  ['smug', 1],
  ['wink', 1],
  ['scared', 1],
  ['serious', 1],
  ['sleep', 1],
  ['delicious', 1],
  ['pose', 1],
  ['default', 1]
]
const FACIAL_PROMPT_KINDS: Array<[string, number]> = [
  ['face_normal', 1],
  ['face_smile', 2],
  ['face_sad', 2],
  ['face_trouble', 2],
  ['face_angry', 2],
  ['face_surprise', 1],
  ['face_shy', 1],
  ['face_closeeye', 1],
  ['face_cry', 1],
  ['face_serious', 1],
  ['face_sleepy', 1],
  ['face_sparkling', 1],
  ['face_disgust', 1],
  ['face_scared', 1],
  ['face_smug', 1],
  ['face_wink', 1],
  ['face_shock', 1],
  ['face_worry', 1],
  ['face_tired', 1],
  ['face_lookaway', 1],
  ['face_blushed', 1],
  ['face_smallmouth', 1],
  ['face_play', 1],
  ['face_sing', 1],
  ['face_baffling', 1]
]

function motionKind(name: string): string {
  const segment = name.split('-').pop() ?? name
  return segment
    .replace(/\d+[a-z]?$/i, '')
    .replace(/[A-Z]$/, '')
    .toLowerCase()
}

function facialKind(name: string): string {
  return name.replace(/_\d+$/, '').toLowerCase()
}

function motionStyle(name: string): string {
  const parts = name.split('-')
  return parts.length > 2 ? parts[1].toLowerCase() : ''
}

function comparePromptNames(a: string, b: string): number {
  const rank = (name: string): [number, number, number, number, string] => {
    const style = motionStyle(name)
    const styleRank = style.startsWith('normal')
      ? 0
      : style.startsWith('cute') || style.startsWith('happy')
        ? 1
        : 2
    const mirrored = /\d+[a-zA-Z]$/.test(name) ? 1 : 0
    const numberMatch = /(\d+)[a-z]?$/.exec(name)
    const number = numberMatch ? Number(numberMatch[1]) : 99
    return [styleRank, mirrored, number === 1 ? 0 : 1, name.length, name]
  }
  const left = rank(a)
  const right = rank(b)
  for (let index = 0; index < left.length; index++) {
    if (left[index] < right[index]) return -1
    if (left[index] > right[index]) return 1
  }
  return 0
}

function curateNames(
  names: string[],
  kindOf: (name: string) => string,
  priorities: Array<[string, number]>,
  limit: number,
  defaultName = ''
): string[] {
  if (names.length === 0) return []
  const groups = new Map<string, string[]>()
  for (const name of names) {
    const kind = kindOf(name)
    const list = groups.get(kind)
    if (list) list.push(name)
    else groups.set(kind, [name])
  }

  const picked: string[] = []
  for (const [kind, wanted] of priorities) {
    const candidates = (groups.get(kind) ?? []).slice().sort(comparePromptNames)
    if (candidates.length === 0) continue
    // 同一语义的多个变体只在同一套动作风格里取，避免 normal 服装配 happy 套的动作
    const style = motionStyle(candidates[0])
    let count = 0
    for (const name of candidates) {
      if (count >= wanted) break
      if (motionStyle(name) !== style) continue
      if (!picked.includes(name)) {
        picked.push(name)
        count += 1
      }
    }
  }
  if (defaultName && names.includes(defaultName) && !picked.includes(defaultName)) {
    picked.push(defaultName)
  }
  return limit > 0 ? picked.slice(0, limit) : picked
}

/** 背景引用清洗：统一分隔符、去掉多余空白；空值返回空串。 */
function cleanPath(value: unknown): string {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/\s*\.\s*/g, '.')
    .replace(/\s*\/\s*/g, '/')
    .trim()
}

function fillTemplate(template: string, mapping: Record<string, string>): string {
  const keys = Object.keys(mapping).sort((a, b) => b.length - a.length)
  const pattern = new RegExp(
    keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'g'
  )
  return template.replace(pattern, (match) => mapping[match] ?? match)
}

export interface CatalogSe {
  file: string
  id?: string
  name: string
  category?: string
  description: string
  tags?: string[]
}

const OUTFIT_QUERY_KEYWORDS: Array<[RegExp, string[]]> = [
  [/校服|制服|学园|学校|上课|教室|放学/, ['校服']],
  [/私服|便服|逛街|约会|出门|周末/, ['私服']],
  [/队服|演出服|舞台|Live|演唱会/, ['队服', '演出服']],
  [/运动服|体操服|社团|练习|排练/, ['运动服']],
  [/泳装|海边|沙滩|游泳/, ['泳装']],
  [/睡衣|熬夜|睡前|卧室/, ['私服', '睡衣']],
  [/浴衣|和服|夏日祭|花火|新年|神社/, ['和服']],
  [/文化祭|女仆|执事|活动/, ['活动']],
  [/打工|咖啡店|店员/, ['打工服']],
  [/礼服|婚礼|正式/, ['礼服']]
]

const UNIT_QUERY_KEYWORDS: Array<[RegExp, string]> = [
  [/一歌|咲希|穗波|志步|leo\/need|l\/n|神山|天台/i, 'Leo/need'],
  [/实乃理|遥|爱莉|雫|mmj|more more|偶像/i, 'MORE MORE JUMP!'],
  [/心羽|杏|彰人|冬弥|vbs|vivid|街头|咖啡/i, 'Vivid BAD SQUAD'],
  [/司|笑梦|宁宁|类|wxs|wonderlands|奇幻|乐园|剧团/i, 'Wonderlands×Showtime'],
  [/奏|真冬|绘名|瑞希|25时|nightcord|无人|深夜/i, '25时，Nightcord de.']
]

function extractQueryTimeHint(query: string): string | null {
  if (/深夜|25点|凌晨|半夜|熬夜/.test(query)) return '深夜'
  if (/黄昏|傍晚|夕阳|晚霞|放学后/.test(query)) return '黄昏'
  if (/夜晚|晚上|今晚|夜里|夜景|夜空/.test(query)) return '夜晚'
  if (/白天|上午|清晨|早上|中午|午休/.test(query)) return '白天'
  return null
}

function extractQueryIndoorHint(query: string): string | null {
  if (/教室|房间|卧室|客厅|厨房|医院|病房|排练室|休息室|咖啡厅|餐厅|室内|家里|家中|语音|通话|电脑/.test(query)) {
    return '室内'
  }
  if (/天台|屋顶|屋上|街头|十字路口|街道|中庭|校门|公园|游乐园|乐园|海边|沙滩|广场|室外|户外|山上/.test(query)) {
    return '室外'
  }
  return null
}

function extractQueryKeywords(query: string): string[] {
  const tokens = new Set<string>()
  const stopWords = new Set(['一个', '一起', '之后', '时候', '大家', '他们', '她们', '我们', '自己', '什么', '怎么', '因为', '所以'])
  for (const part of query.split(/[\s,，。！？!?、：:；;（）()「」""'']+/).filter(Boolean)) {
    const clean = part.trim().toLowerCase()
    if (clean.length >= 2 && !stopWords.has(clean)) tokens.add(clean)
  }
  return [...tokens]
}

function stripImageTimeHint(text: string): string {
  return text
    .replace(/[·\s（(【[]*(白天|黄昏|傍晚|夜晚|夜间|深夜|通用|室内|室外)[）)】\]]*$/g, '')
    .trim()
}

export function formatImagePromptLine(detail: CatalogImage): string {
  const name = detail.name || detail.file
  const ref = detail.id ?? detail.file
  const metaBits = [detail.category, detail.timeOfDay, detail.indoor].filter(Boolean)
  const metaTag = metaBits.length > 0 ? `[${metaBits.join('/')}]` : ''
  const aliasNote =
    detail.aliases?.length && detail.aliases.length > 0
      ? ` 别名:${detail.aliases.slice(0, 2).join('/')}`
      : ''
  if (metaTag) {
    return `- ${name}（${ref}）${metaTag}${aliasNote}`
  }
  return detail.description ? `- ${name}（${ref}）：${detail.description}` : `- ${name}（${ref}）`
}

export function formatBgmPromptLine(detail: CatalogBgm): string {
  const name = detail.name || detail.file
  const ref = detail.id ?? detail.file
  const moodTag = [detail.mood, detail.tempo].filter(Boolean).join('·')
  if (moodTag) {
    return detail.description
      ? `- ${name}（${ref}）[${moodTag}]：${detail.description}`
      : `- ${name}（${ref}）[${moodTag}]`
  }
  return detail.description ? `- ${name}（${ref}）：${detail.description}` : `- ${name}（${ref}）`
}

/** 判断动作名是否为默认站姿（入场/后续连招会优先避开这类静态名）。 */
export function isStandingMotion(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.includes('default') || lower.includes('stand')
}

/** 判断模型是否为背影专用立绘（`_back`），默认对话选角应避开。 */
export const isBackViewModel = (model: CatalogModel): boolean =>
  /(?:^|[_-])back(?:\d*)$/i.test(model.cloudId ?? '') ||
  /(?:^|[_/-])back(?:\d*)(?:[_/-]|\.)/i.test(model.path ?? '')

const BACK_VIEW_QUERY_RE = /背影|背面|背对|back\s*view|\bback\b/i

/**
 * 资源目录的提示词视图：把 ResourceCatalog 的原始数据整理成模型/动作/表情/背景/BGM/SE 文本，
 * 并提供校验所需的精确名称与模糊修复。
 */
export class CatalogView {
  readonly models: CatalogModel[]
  readonly images: string[]
  readonly imageDetails: CatalogImage[]
  readonly bgmDetails: CatalogBgm[]
  readonly seDetails: CatalogSe[]

  constructor(data: ResourceCatalogData & { seDetails?: CatalogSe[] }) {
    this.models = data.models.filter((model) => Boolean(model.path))
    this.images = data.images ?? []
    this.imageDetails = (data.imageDetails ?? []).filter((item) => Boolean(item.file))
    this.bgmDetails = (data.bgmDetails ?? []).filter((item) => Boolean(item.file))
    this.seDetails = (data.seDetails ?? []).filter((item) => Boolean(item.file))
  }

  withModels(models: CatalogModel[]): CatalogView {
    return Object.assign(Object.create(CatalogView.prototype), this, { models }) as CatalogView
  }

  modelById(id: number): CatalogModel | null {
    return this.models.find((model) => model.id === id) ?? null
  }

  defaultModel(): CatalogModel | null {
    return (
      this.models.find((model) => !isBackViewModel(model) && model.isDefault !== false) ??
      this.models.find((model) => !isBackViewModel(model)) ??
      this.models.find((model) => model.isDefault !== false) ??
      this.models[0] ??
      null
    )
  }

  /**
   * 按角色去重的代表模型清单（26 主角 + 可选配角）：
   * 提示词展示台词人设、动作/表情清单时使用，避免同一角色 18 套服装把提示词刷屏。
   */
  primaryModels(): CatalogModel[] {
    const byChar = new Map<string, CatalogModel>()
    const rankOf = (m: CatalogModel): number =>
      (isBackViewModel(m) ? 100 : 0) +
      (m.source === 'local' ? 0 : 1) * 10 +
      (m.isDefault !== false ? 0 : 1)
    for (const model of this.models) {
      const key =
        typeof model.characterId === 'number'
          ? `char:${model.characterId}`
          : `name:${model.name.toLowerCase()}`
      const existing = byChar.get(key)
      if (!existing) {
        byChar.set(key, model)
        continue
      }
      if (rankOf(model) < rankOf(existing)) {
        byChar.set(key, model)
      }
    }
    return [...byChar.values()]
  }

  /** 查找同角色的全部服装变体（正面模型与默认服装优先排序）。 */
  outfitsFor(target: CatalogModel | string | number): CatalogModel[] {
    const refModel =
      typeof target === 'number'
        ? this.modelById(target)
        : typeof target === 'string'
          ? this.models.find(
              (m) =>
                m.name.toLowerCase() === target.toLowerCase() ||
                (m.shortName ?? '').toLowerCase() === target.toLowerCase() ||
                (m.cloudId ?? '').toLowerCase() === target.toLowerCase()
            ) ?? null
          : target
    if (!refModel) return []
    return this.models
      .filter((m) =>
        typeof refModel.characterId === 'number' && typeof m.characterId === 'number'
          ? m.characterId === refModel.characterId
          : m.name === refModel.name
      )
      .sort(
        (a, b) =>
          Number(isBackViewModel(a)) - Number(isBackViewModel(b)) ||
          Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)) ||
          a.id - b.id
      )
  }

  /** 按服装关键词（如「校服」「私服」「队服」「泳装」）或云端 id 解析同角色服装。 */
  resolveOutfitVariant(baseModel: CatalogModel, query: string): CatalogModel | null {
    const q = query.trim().toLowerCase()
    if (!q) return null
    const variants = this.outfitsFor(baseModel)
    if (variants.length === 0) return null
    const exact = variants.find(
      (m) =>
        String(m.id) === q ||
        (m.cloudId ?? '').toLowerCase() === q ||
        m.path.toLowerCase() === q ||
        (m.outfitLabel ?? '').toLowerCase() === q
    )
    if (exact && (!isBackViewModel(exact) || BACK_VIEW_QUERY_RE.test(query))) return exact
    const nonBack = variants.filter((m) => !isBackViewModel(m))
    const pool = BACK_VIEW_QUERY_RE.test(query) || nonBack.length === 0 ? variants : nonBack
    const byCat = pool.find(
      (m) =>
        (m.outfitCategory ?? '').toLowerCase() === q ||
        (m.outfitLabel ?? '').toLowerCase().includes(q) ||
        (m.cloudId ?? '').toLowerCase().includes(q)
    )
    if (byCat) return byCat
    for (const [pattern, cats] of OUTFIT_QUERY_KEYWORDS) {
      if (!pattern.test(query)) continue
      const hit = pool.find((m) => cats.includes(m.outfitCategory ?? ''))
      if (hit) return hit
    }
    if (BACK_VIEW_QUERY_RE.test(query)) {
      const backHit = pool.find((m) => isBackViewModel(m))
      if (backHit) return backHit
    }
    return null
  }

  defaultModelPath(): string {
    return this.defaultModel()?.path ?? ''
  }

  shortName(model: CatalogModel): string {
    return model.shortName || model.name || `model${model.id}`
  }

  nameById(id: number): string {
    const model = this.modelById(id)
    return model ? this.shortName(model) : `model${id}`
  }

  validModelPaths(): Set<string> {
    return new Set(this.models.map((model) => model.path))
  }

  imageDetailsList(): CatalogImage[] {
    if (this.imageDetails.length > 0) return this.imageDetails
    return this.images.map((file) => ({ file, name: file, description: '' }))
  }

  bgmDetailsList(): CatalogBgm[] {
    if (this.bgmDetails.length > 0) return this.bgmDetails
    return []
  }

  /**
   * 语义分桶筛选提示词背景候选：
   * - 保留全部本地背景 + 语义覆盖的云端背景（不含纯色幕布与剧情插画，除非查询明确要求）；
   * - 根据场景里的时段（白天/黄昏/夜晚/深夜）、室内外与地点/组合关键词精准打分，
   *   再按场景分类均衡分桶，确保 AI 一次选出准确时段与地点的背景（~1,400 张全量仍可在校验时精确解析）。
   */
  imagePromptChoices(limit = 120, query = ''): CatalogImage[] {
    const named = this.imageDetailsList().filter(
      (detail) => detail.source !== 'cloud' || (detail.name && detail.name !== detail.id)
    )
    if (limit <= 0 || named.length <= limit) return named

    const wantSpecial = /纯色|黑屏|幕布|插画|cg|回忆画面/i.test(query)
    const pool = wantSpecial
      ? named
      : named.filter((d) => d.category !== '特效与纯色' && d.category !== '剧情插画')
    const effectivePool = pool.length > 0 ? pool : named

    const timeHint = extractQueryTimeHint(query)
    const indoorHint = extractQueryIndoorHint(query)
    const keywords = extractQueryKeywords(query)
    const unitHints = UNIT_QUERY_KEYWORDS.filter(([re]) => re.test(query)).map(([, u]) => u)

    const scoreOf = (detail: CatalogImage): number => {
      let score = detail.source === 'local' ? 6 : 0
      const hay = `${detail.name} ${(detail.aliases ?? []).join(' ')} ${(detail.tags ?? []).join(' ')} ${detail.category ?? ''}`.toLowerCase()
      for (const kw of keywords) {
        if (detail.name.toLowerCase().includes(kw)) score += 12
        else if (hay.includes(kw)) score += 6
      }
      if (timeHint && detail.timeOfDay) {
        if (detail.timeOfDay === timeHint) score += 6
        else if ((timeHint === '夜晚' && detail.timeOfDay === '深夜') || (timeHint === '深夜' && detail.timeOfDay === '夜晚')) {
          score += 3
        } else if (detail.timeOfDay !== '通用') {
          score -= 3
        }
      }
      if (indoorHint && detail.indoor) {
        if (detail.indoor === indoorHint) score += 4
        else score -= 2
      }
      for (const u of unitHints) {
        if ((detail.tags ?? []).some((t) => t.includes(u)) || hay.includes(u.toLowerCase())) score += 4
      }
      if (detail.id && /^bg_[a-f]00\d{2}0[1-4]$/.test(detail.id)) score += 2
      if (!detail.name.includes('#') && !detail.name.includes('衍生场景')) score += 3
      return score
    }

    const scored = effectivePool
      .map((detail) => ({ detail, score: scoreOf(detail) }))
      .sort((a, b) => b.score - a.score || (a.detail.id ?? a.detail.file).localeCompare(b.detail.id ?? b.detail.file))

    // 先拿高匹配度前 40%，再按 category 轮转补齐，兼顾贴题与多样性
    const picked: CatalogImage[] = []
    const pickedKeys = new Set<string>()
    const directQuota = Math.min(limit, Math.max(12, Math.floor(limit * 0.45)))
    for (const item of scored) {
      if (picked.length >= directQuota) break
      const key = item.detail.file.toLowerCase()
      if (!pickedKeys.has(key)) {
        pickedKeys.add(key)
        picked.push(item.detail)
      }
    }

    const buckets = new Map<string, CatalogImage[]>()
    for (const item of scored) {
      if (pickedKeys.has(item.detail.file.toLowerCase())) continue
      const cat = item.detail.category || '其他'
      if (!buckets.has(cat)) buckets.set(cat, [])
      buckets.get(cat)!.push(item.detail)
    }

    const bucketIterators = [...buckets.values()]
    let progressed = true
    while (picked.length < limit && progressed) {
      progressed = false
      for (const list of bucketIterators) {
        if (picked.length >= limit) break
        const next = list.shift()
        if (!next) continue
        progressed = true
        const key = next.file.toLowerCase()
        if (!pickedKeys.has(key)) {
          pickedKeys.add(key)
          picked.push(next)
        }
      }
    }

    return picked
  }

  /**
   * 语义分桶筛选 BGM 候选：
   * 覆盖「轻松日常 / 温暖治愈 / 感伤忧郁 / 紧张悬疑 / 热血激昂 / 元气欢快 / 奇幻活泼 / 律动街头 / 宁静深夜 / 神秘空灵」
   * 全部情绪族，优先贴合当前场景关键词与核心经典曲目；校验用的 canonicalBgm 仍接受全部 ~421 首。
   */
  bgmPromptChoices(limit = 0, query = ''): CatalogBgm[] {
    const choices = this.bgmDetailsList().filter((detail) => detail.description.trim().length > 0)
    if (limit <= 0 || choices.length <= limit) return choices

    const keywords = extractQueryKeywords(query)
    const unitHints = UNIT_QUERY_KEYWORDS.filter(([re]) => re.test(query)).map(([, u]) => u)
    const scoreOf = (detail: CatalogBgm): number => {
      let score = detail.source === 'local' ? 6 : 0
      const hay = `${detail.name} ${detail.mood ?? ''} ${detail.category ?? ''} ${detail.unit ?? ''} ${detail.description} ${(detail.tags ?? []).join(' ')}`.toLowerCase()
      for (const kw of keywords) {
        if (hay.includes(kw)) score += 8
      }
      for (const u of unitHints) {
        if (detail.unit === u) score += 6
      }
      if (/经典|日常|温暖|泪|紧绷|暗涌|普通|平凡|宁静|slapstick|into deep/i.test(detail.name + detail.description)) {
        score += 3
      }
      if (!/\(bgm\d+\)$/.test(detail.name)) score += 4
      return score
    }

    const scored = choices
      .map((detail) => ({ detail, score: scoreOf(detail) }))
      .sort((a, b) => b.score - a.score || (a.detail.id ?? a.detail.file).localeCompare(b.detail.id ?? b.detail.file))

    const buckets = new Map<string, CatalogBgm[]>()
    for (const item of scored) {
      const mood = item.detail.mood || item.detail.category || '其他'
      if (!buckets.has(mood)) buckets.set(mood, [])
      buckets.get(mood)!.push(item.detail)
    }

    const picked: CatalogBgm[] = []
    const seen = new Set<string>()
    const bucketLists = [...buckets.values()]
    let progressed = true
    while (picked.length < limit && progressed) {
      progressed = false
      for (const list of bucketLists) {
        if (picked.length >= limit) break
        const next = list.shift()
        if (!next) continue
        progressed = true
        const key = next.file.toLowerCase()
        if (!seen.has(key)) {
          seen.add(key)
          picked.push(next)
        }
      }
    }
    return picked
  }

  /**
   * 把 AI 写的 BGM 名收束到 bgm.yaml 登记的文件名；未登记返回 null。
   * 只接受 bgmDetails，不把磁盘上碰巧存在的音频暴露成候选。
   *
   * 云端条目可以只写 id（bgm00003）、曲名（Slapstick!!）或
   * `cloud/bgm00003.mp3`，都收束到登记项 file。
   */
  canonicalBgm(value: unknown): string | null {
    const raw = normalizeBgmFile(value)
    if (!raw) return null
    const details = this.bgmDetailsList()
    if (details.length === 0) return null

    const exact = details.find((detail) => detail.file === raw || detail.id === raw)
    if (exact) return exact.file

    const lower = raw.toLowerCase()
    const stem = lower.replace(/\.[^.]+$/, '')
    const byFile = details.find(
      (detail) =>
        detail.file.toLowerCase() === lower ||
        detail.id?.toLowerCase() === lower ||
        detail.id?.toLowerCase() === stem ||
        (detail.file.toLowerCase().split('/').pop() ?? '').replace(/\.[^.]+$/, '') === stem
    )
    if (byFile) return byFile.file

    const base = lower.split('/').pop() ?? lower
    const byBase = details.find(
      (detail) => (detail.file.toLowerCase().split('/').pop() ?? '') === base
    )
    if (byBase) return byBase.file

    const byName = details.filter(
      (detail) => detail.name.toLowerCase() === lower || detail.file.toLowerCase().includes(lower)
    )
    return byName.length === 1 ? byName[0].file : null
  }

  /**
   * 背景选择：本地文件、云端 id（bg_a000301）与可读名（教室）及带时段变体（如「神山高校 天台·黄昏」）都接受。
   * 返回登记项本身，调用方可拿到 file 与展示名。
   */
  canonicalImageEntry(value: unknown): CatalogImage | null {
    const raw = cleanPath(value)
    if (!raw) return null
    const details = this.imageDetailsList()
    if (details.length === 0) return null

    const lower = raw.toLowerCase()
    const base = lower.split('/').pop() ?? lower
    const stem = base.replace(/\.[^.]+$/, '')
    const exactId = details.find(
      (detail) =>
        detail.file.toLowerCase() === lower ||
        detail.id?.toLowerCase() === lower ||
        detail.id?.toLowerCase() === stem ||
        (detail.file.toLowerCase().split('/').pop() ?? '').replace(/\.[^.]+$/, '') === stem
    )
    if (exactId) return exactId

    const timeHint = extractQueryTimeHint(raw)
    const stripped = stripImageTimeHint(raw).toLowerCase()
    const timeRank = (entry: CatalogImage): number => {
      if (timeHint) {
        if (entry.timeOfDay === timeHint) return 0
        if ((timeHint === '夜晚' && entry.timeOfDay === '深夜') || (timeHint === '深夜' && entry.timeOfDay === '夜晚')) return 1
        if (entry.timeOfDay === '通用') return 2
        return 3
      }
      if (!entry.timeOfDay || entry.timeOfDay === '白天') return 0
      if (entry.timeOfDay === '通用') return 1
      if (entry.timeOfDay === '黄昏') return 2
      return 3
    }

    const exactNames = details.filter((detail) => {
      const candidates = [
        detail.name.toLowerCase(),
        detail.timeOfDay ? `${detail.name}·${detail.timeOfDay}`.toLowerCase() : '',
        detail.timeOfDay ? `${detail.name}（${detail.timeOfDay}）`.toLowerCase() : '',
        detail.timeOfDay ? `${detail.name} ${detail.timeOfDay}`.toLowerCase() : '',
        ...(detail.aliases ?? []).map((a) => a.toLowerCase())
      ].filter(Boolean)
      return (
        candidates.includes(lower) ||
        (stripped.length > 0 &&
          (detail.name.toLowerCase() === stripped ||
            (detail.aliases ?? []).some((a) => a.toLowerCase() === stripped)))
      )
    })
    if (exactNames.length > 0) {
      return exactNames.sort(
        (a, b) => timeRank(a) - timeRank(b) || (a.id ?? a.file).localeCompare(b.id ?? b.file)
      )[0]
    }

    const fuzzyQuery = stripped || lower
    const byName = details
      .filter(
        (detail) =>
          detail.name.toLowerCase().includes(fuzzyQuery) ||
          (detail.aliases ?? []).some((alias) => alias.toLowerCase().includes(fuzzyQuery)) ||
          (detail.tags ?? []).some((tag) => tag.toLowerCase() === fuzzyQuery)
      )
      .sort(
        (a, b) =>
          timeRank(a) - timeRank(b) ||
          a.name.length - b.name.length ||
          (a.id ?? a.file).localeCompare(b.id ?? b.file)
      )
    if (byName.length > 0) return byName[0]

    const byFile = details.filter(
      (detail) =>
        detail.file.toLowerCase().includes(lower) || lower.includes(detail.file.toLowerCase())
    )
    return byFile.length === 1 ? byFile[0] : null
  }

  canonicalImage(value: unknown): string | null {
    return this.canonicalImageEntry(value)?.file ?? null
  }

  defaultImage(): string {
    return this.imageDetailsList()[0]?.file ?? this.images[0] ?? ''
  }

  validImages(): Set<string> {
    const files = new Set(this.images)
    for (const detail of this.imageDetails) files.add(detail.file)
    return files
  }

  validMotions(modelId: number): Set<string> {
    return new Set(this.modelById(modelId)?.motions ?? [])
  }

  validFacials(modelId: number): Set<string> {
    return new Set(this.modelById(modelId)?.facials ?? [])
  }

  defaultMotion(modelId: number): string {
    const model = this.modelById(modelId)
    return model?.defaultMotion || 'w-normal-default01'
  }

  defaultFacial(modelId: number): string {
    const model = this.modelById(modelId)
    return model?.defaultFacial || 'face_smile_01'
  }

  animationChoices(modelId: number, field: 'motion' | 'facial'): Set<string> {
    return field === 'motion' ? this.validMotions(modelId) : this.validFacials(modelId)
  }

  /**
   * 把 AI 写的动作/表情名尽量修正成目录里的完整名；修不了返回 null。
   * 顺序：精确 → 忽略大小写 → 忽略空白 → 唯一尾号归一 → 唯一前缀。
   */
  canonicalAnimation(modelId: number, field: 'motion' | 'facial', value: unknown): string | null {
    if (typeof value !== 'string') return null
    const raw = value.trim()
    if (!raw) return null
    const names = this.animationChoices(modelId, field)
    if (names.size === 0) return null
    if (names.has(raw)) return raw

    const uniqueHit = (key: (name: string) => string): string | null => {
      const counts = new Map<string, number>()
      for (const name of names) {
        const k = key(name)
        counts.set(k, (counts.get(k) ?? 0) + 1)
      }
      const hit = [...[...names].sort()].find(
        (name) => counts.get(key(name)) === 1 && key(name) === key(raw)
      )
      return hit ?? null
    }

    const lower = uniqueHit((name) => name.toLowerCase())
    if (lower) return lower
    const noSpace = uniqueHit((name) => name.replace(/\s+/g, '').toLowerCase())
    if (noSpace) return noSpace
    // face smile 01 / face-smile-01 → face_smile_01；只接受唯一命中
    const compact = uniqueHit((name) => name.replace(/[\s_-]+/g, '').toLowerCase())
    if (compact) return compact

    const stripNumber = (name: string): string => name.replace(/\d+$/, '').toLowerCase()
    const stem = stripNumber(raw)
    const stemHits = [...names].sort().filter((name) => stripNumber(name) === stem)
    if (stemHits.length === 1) return stemHits[0]

    const prefixHits = [...names]
      .sort()
      .filter((name) => name.toLowerCase().startsWith(raw.toLowerCase()))
    if (prefixHits.length === 1) return prefixHits[0]
    return null
  }

  private promptScopeModels(): CatalogModel[] {
    if (this.models.length > 35) return this.primaryModels()
    const charsWithFront = new Set(
      this.models
        .filter((m) => !isBackViewModel(m))
        .map((m) => (typeof m.characterId === 'number' ? `char:${m.characterId}` : `name:${m.name.toLowerCase()}`))
    )
    return this.models.filter((m) => {
      if (!isBackViewModel(m)) return true
      const key = typeof m.characterId === 'number' ? `char:${m.characterId}` : `name:${m.name.toLowerCase()}`
      return !charsWithFront.has(key)
    })
  }

  modelTable(): string {
    return this.promptScopeModels()
      .map((model) => {
        const backTag = isBackViewModel(model) ? '[背面视角]' : ''
        const outfitNote = model.outfitLabel ? ` [${model.outfitLabel}${backTag ? '·背面视角' : ''}]` : backTag ? ` ${backTag}` : ''
        return `- ${this.shortName(model)}${outfitNote} → modelId=${model.id}, model路径=${model.path}`
      })
      .join('\n')
  }

  idMapping(): string {
    return this.promptScopeModels()
      .map((model) => `${this.shortName(model)}=${model.id}`)
      .join(', ')
  }

  promptMotions(model: CatalogModel): string[] {
    return curateNames(
      model.motions ?? [],
      motionKind,
      MOTION_PROMPT_KINDS,
      MOTION_PROMPT_LIMIT,
      model.defaultMotion ?? ''
    )
  }

  promptFacials(model: CatalogModel): string[] {
    return curateNames(
      model.facials ?? [],
      facialKind,
      FACIAL_PROMPT_KINDS,
      FACIAL_PROMPT_LIMIT,
      model.defaultFacial ?? ''
    )
  }

  /** 示例/入场兜底动作：优先语义明确的小动作，绝不选 default 站姿。 */
  exampleMotion(modelId: number): string {
    const model = this.modelById(modelId) ?? this.defaultModel()
    if (!model) return ''
    const names = this.promptMotions(model)
    for (const kind of ['nod', 'tilthead', 'glad']) {
      for (const name of names) {
        if (motionKind(name) === kind && !name.toLowerCase().includes('default')) return name
      }
    }
    return (
      names.find((name) => !name.toLowerCase().includes('default')) ?? this.defaultMotion(modelId)
    )
  }

  /** 示例表情：平静或微笑优先，避免示例与示例台词的情绪相反。 */
  exampleFacial(modelId: number): string {
    const model = this.modelById(modelId) ?? this.defaultModel()
    if (!model) return ''
    const names = this.promptFacials(model)
    for (const kind of ['face_normal', 'face_smile']) {
      for (const name of names) {
        if (facialKind(name) === kind) return name
      }
    }
    return names[0] ?? this.defaultFacial(modelId)
  }

  motionList(): string {
    return this.promptScopeModels()
      .map((model) => {
        const names = this.promptMotions(model)
        return `${this.shortName(model)}(${model.id})：${names.length ? names.join('，') : '（目录暂未提供）'}`
      })
      .join('\n')
  }

  facialList(): string {
    return this.promptScopeModels()
      .map((model) => {
        const names = this.promptFacials(model)
        return `${this.shortName(model)}(${model.id})：${names.length ? names.join('，') : '（目录暂未提供）'}`
      })
      .join('\n')
  }

  imageList(limit = 80, query = ''): string {
    const details = this.imagePromptChoices(limit, query)
    if (details.length === 0) return '（目录暂未提供背景）'
    return details.map((detail) => formatImagePromptLine(detail)).join('\n')
  }

  bgmList(limit = 40, query = ''): string {
    const details = this.bgmPromptChoices(limit, query)
    if (details.length === 0) return '（目录暂未提供带描述或官方曲名的 BGM）'
    return details.map((detail) => formatBgmPromptLine(detail)).join('\n')
  }

  seDetailsList(): CatalogSe[] {
    if (this.seDetails.length > 0) return this.seDetails
    return CURATED_SCENARIO_SES.map((cue) => ({
      file: cue.file,
      id: cue.id,
      name: cue.id,
      category: cue.category,
      description: cue.description
    }))
  }

  canonicalSe(value: unknown): string | null {
    const raw = cleanPath(value)
    if (!raw) return null
    const lower = raw.toLowerCase()
    const base = lower.split('/').pop() ?? lower
    const stem = base.replace(/\.[^.]+$/, '')

    for (const entry of this.seDetails) {
      const eFile = entry.file.toLowerCase()
      const eId = (entry.id ?? '').toLowerCase()
      const eStem = (eFile.split('/').pop() ?? eFile).replace(/\.[^.]+$/, '')
      if (eFile === lower || eId === lower || eId === stem || eStem === stem) {
        return entry.file
      }
    }
    const curated = resolveScenarioSe(raw)
    return curated ? curated.file : null
  }

  seList(query = '', limit = 30): string {
    const curatedList = CURATED_SCENARIO_SES.map((cue) => ({
      file: cue.file,
      id: cue.id,
      name: cue.id,
      category: cue.category,
      description: cue.description,
      tags: [...cue.tags]
    }))
    if (this.seDetails.length === 0) {
      return sePromptList()
    }
    const keywords = extractQueryKeywords(query)
    const merged: CatalogSe[] = []
    const seen = new Set<string>()
    for (const item of curatedList) {
      const key = item.id.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        merged.push(item)
      }
    }
    if (keywords.length > 0) {
      const extra = this.seDetails
        .filter((d) => {
          const hay = `${d.id ?? ''} ${d.category ?? ''} ${d.description} ${(d.tags ?? []).join(' ')}`.toLowerCase()
          return keywords.some((kw) => hay.includes(kw))
        })
        .slice(0, Math.max(0, limit - merged.length))
      for (const item of extra) {
        const key = (item.id ?? item.file).toLowerCase()
        if (!seen.has(key)) {
          seen.add(key)
          merged.push(item)
        }
      }
    }
    return merged
      .slice(0, limit)
      .map((detail) => `- ${detail.file}（${detail.category ?? 'se'}）：${detail.description}`)
      .join('\n')
  }

  /**
   * 角色档案。剧本只带核心段落；聊天保留完整人设（共情/交互协议对角色回复有用），
   * 但调用方已先做快速选角，池子里通常只有 1~2 人。
   */
  characterPool(personas: PersonaEntry[], compact = true): string {
    const scope = this.promptScopeModels()
    if (scope.length === 0) return '（资源目录为空，请检查渲染宿主）'
    return scope
      .map((model) => {
        const persona = personaFor(personas, model)
        const prompt = compact ? dialoguePersonaPrompt(persona) : (persona?.prompt?.trim() ?? '')
        const allOutfits = this.outfitsFor(model)
        const frontOutfits = allOutfits.filter((m) => !isBackViewModel(m))
        const shownOutfits = frontOutfits.length > 0 ? frontOutfits : allOutfits
        const outfitSummary = shownOutfits
          .slice(0, 8)
          .map((m) => `${m.outfitLabel || m.outfitCategory || m.cloudId || m.id}=${m.id}`)
          .join('、')
        const outfitLine =
          shownOutfits.length > 1 ? `\n可选服装（直接写对应 modelId）：${outfitSummary}` : ''
        return `**${this.shortName(model)}** — modelId:${model.id}, model:${model.path}${outfitLine}\n${
          prompt || GENERIC_PROFILE
        }`
      })
      .join('\n\n')
  }
}

const STORY_SYSTEM_PROMPT =
  '你是 Project SEKAI 风格视觉小说导演。只输出合法 JSON（仅含 models、images、snippets，可选 bgm），不要 markdown 或解释。写成约 3 分钟的短戏，禁止超长剧情；对话多少按角色人设自行把握。入场/退场默认原地淡入淡出，禁止 ±100px Slow 滑行；93% 台词 delay 为 0。'

const CHAT_SYSTEM_PROMPT =
  '你是 Project SEKAI 风格视觉小说角色扮演导演。只输出合法 JSON（仅含 models、images、snippets，可选 bgm），不要 markdown 或解释。对话多少按角色人设自行把握。表演克制：一句台词一个自然小动作，入场/退场默认原地淡入淡出。'

/** 用当前目录里真实存在的模型/动作/背景生成一段可执行的示例。 */
export function buildActingExample(view: CatalogView): string {
  const models = view.models.slice(0, 2)
  if (models.length === 0) return '{}'
  const ids = models.map((model) => model.id)

  const stageMotion = (modelId: number): string => view.exampleMotion(modelId)

  const facialOnly = (modelId: number, at: number): Record<string, unknown> => ({
    at,
    modelId,
    facial: view.exampleFacial(modelId)
  })

  const paired = (modelId: number, at: number): Record<string, unknown> => ({
    at,
    modelId,
    motion: view.exampleMotion(modelId),
    facial: view.exampleFacial(modelId)
  })

  const talk = (
    modelId: number,
    content: string,
    actions: Array<Record<string, unknown>>,
    options: { delay?: number; closeWindowOnFinish?: boolean } = {}
  ): Record<string, unknown> => ({
    type: 'Talk',
    wait: true,
    progressBehavior: 'WaitFinished',
    delay: options.delay ?? 0,
    data: {
      speaker: view.shortName(view.modelById(modelId) ?? models[0]),
      content,
      modelId,
      ...(options.closeWindowOnFinish ? { closeWindowOnFinish: true } : {}),
      actions
    }
  })

  const snippets: Array<Record<string, unknown>> = [
    { type: 'ChangeLayoutMode', wait: false, progressBehavior: 'Now', delay: 0, data: { mode: 'Normal' } },
    { type: 'BlackOut', wait: true, progressBehavior: 'WaitFinished', delay: 0, data: { duration: 500 } },
    { type: 'ChangeBackgroundImage', wait: false, progressBehavior: 'Now', delay: 0, data: { imageId: 1 } },
    { type: 'BlackIn', wait: true, progressBehavior: 'WaitFinished', delay: 0, data: { duration: 600 } },
    { type: 'PlaceInfo', wait: false, progressBehavior: 'Now', delay: 0, data: { text: '放学后的教室' } }
  ]

  if (ids.length === 1) {
    const id = ids[0]
    snippets.push({
      type: 'LayoutAppear',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: {
        modelId: id,
        from: { side: 'Center', offset: 0 },
        to: { side: 'Center', offset: 0 },
        motion: stageMotion(id),
        facial: view.exampleFacial(id),
        facialFirst: true,
        moveSpeed: 'Normal'
      }
    })
    snippets.push(talk(id, '今天也想和你多聊一会儿。', [facialOnly(id, 0)], { closeWindowOnFinish: true }))
    snippets.push({
      type: 'LayoutClear',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: {
        modelId: id,
        from: { side: 'Center', offset: 0 },
        to: { side: 'Center', offset: 0 },
        motion: '',
        facial: '',
        moveSpeed: 'Normal'
      }
    })
  } else {
    const [first, second] = ids
    snippets.push({
      type: 'LayoutAppear',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: {
        modelId: first,
        from: { side: 'Left', offset: 0 },
        to: { side: 'Left', offset: 0 },
        motion: stageMotion(first),
        facial: view.exampleFacial(first),
        facialFirst: true,
        moveSpeed: 'Normal'
      }
    })
    snippets.push({
      type: 'LayoutAppear',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: {
        modelId: second,
        from: { side: 'Right', offset: 0 },
        to: { side: 'Right', offset: 0 },
        motion: stageMotion(second),
        facial: view.exampleFacial(second),
        facialFirst: true,
        moveSpeed: 'Normal'
      }
    })
    snippets.push(talk(first, '今天也想和你多聊一会儿。', [facialOnly(first, 0)]))
    snippets.push(
      talk(second, '嗯，今天也请多指教。', [paired(second, 0)], { closeWindowOnFinish: true })
    )
    snippets.push({
      type: 'LayoutClear',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: {
        modelId: first,
        from: { side: 'Left', offset: 0 },
        to: { side: 'Left', offset: 0 },
        motion: '',
        facial: '',
        moveSpeed: 'Normal'
      }
    })
    snippets.push({
      type: 'LayoutClear',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: {
        modelId: second,
        from: { side: 'Right', offset: 0 },
        to: { side: 'Right', offset: 0 },
        motion: '',
        facial: '',
        moveSpeed: 'Normal'
      }
    })
  }

  snippets.push({ type: 'BlackOut', wait: true, progressBehavior: 'WaitFinished', delay: 0, data: { duration: 600 } })

  const exampleBgm = view.bgmPromptChoices()[0]?.file
  return JSON.stringify({
    models: models.map((model) => ({
      id: model.id,
      model: model.path,
      normal_scale: 2.1,
      small_scale: 1.8,
      anchor: 0.5
    })),
    images: [{ id: 1, image: view.defaultImage() }],
    ...(exampleBgm ? { bgm: [exampleBgm] } : {}),
    snippets
  })
}

// 提示词与 AstrBot 插件保持同一套实测规则；{占位符} 用单遍替换，避免人格文本注入。
const STORY_PROMPT = `# 视觉小说剧本生成

你是 Project SEKAI 风格视觉小说导演。根据场景写出一场约 {target_minutes} 分钟的短戏，完整、自然，但不要写成超长剧情。只输出合法 JSON（仅含 models、images、snippets 三个字段，可选顶层 bgm）。
对话多少、每句长短都按角色人设来：话多的角色就多说，话少的角色就少说。不规定条数和字数。一场只演完一件事或一个情绪转折就退场，禁止把整段人生、多条支线或连续多场戏塞进这一次。
表演克制、贴近原作：93% 的台词 delay 为 0，入场/退场默认原地淡入淡出（from == to, offset: 0），禁止 ±100px Slow 滑行。

## 角色池

{character_pool}

> 根据场景从角色池选角：独白用 1 人，双人对话用 2 人，团体/活动场景可选 3~5 人。优先选场景点名的角色；全片保持 Normal 模式（最多 2 人同台：Left/Right 或单人 Center），3~5 人通过 LayoutClear + LayoutAppear 交叠淡出淡入轮换同框。

## modelId 对照表（不可混淆）
{model_table}

Talk.modelId 必须与 speaker 对应：{id_mapping}

## 布局与舞台规则

- ChangeLayoutMode.data.mode：固定为 "Normal"（Left / Right 双人或单人 Center）；严禁 3 人及以上同时在场或槽位冲突。
- **始终维护在场名单与槽位**：models 是整场演员表，不是在场名单。只有 LayoutAppear 完成才在场，LayoutClear 完成才释放槽位；换背景/黑屏不清空名单。
- **双人全片同场与多人轮换原则**：当整场只有 2 名角色时，保持两人在场（Left/Right），不要每句来回切人淡入淡出。当整场 >=3 名角色时，保持每次最多 2 人在场，按幕次或说话人通过 LayoutClear(Now) + LayoutAppear 交叠淡出淡入轮换。
- **入场/退场动画规则（99% 原地淡入淡出）**：
  - 默认原地淡入淡出：LayoutAppear 的 from 与 to 写相同槽位且 offset=0（如 {"side":"Left","offset":0} -> {"side":"Left","offset":0}）；双人同入时第一条 progressBehavior="WaitFinished" (wait:true)，第二条 progressBehavior="Now" (wait:false)。
  - 仅在明确“走入/走离”镜头时，才用 LeftOver/RightOver 作为物理起点/终点（可配脚步 SE），禁止写 ±100px 偏移滑行。
  - LayoutAppear 若已带入场动作（禁止 default 站姿），紧接着 0.4s 内的该角色首句 Talk 不要再重复触发 body motion（可只改 facial）。
  - LayoutClear 默认原地淡出（from == to, offset: 0）；可留空 motion/facial 或使用非 default 收尾动作。
- 可用 Move 做小幅跨步/移近（offset ±80~150 或单人移至 Center），用 CharacterShake（X/Y）演受惊，用 AttachCharacterShader（hologram）演虚拟歌手投影/通话。
- Talk 的说话者和 actions 的目标都必须在场；旁白可用 modelId=-1，但不能给 -1 安排动作。

## 开场与转场序列

ChangeLayoutMode → BlackOut → ChangeBackgroundImage → BlackIn → （可选 Telop / PlaceInfo）→ LayoutAppear...
- 支持 Telop（居中小标题，如时间/地点/回忆提示）、PlaceInfo（左上角地点条，下句说完自动关闭）、SideFade（Out/In 方向擦除转场）、WhiteOut -> FlashbackIn -> WhiteIn（回忆滤镜，结束前必配 FlashbackOut）、SekaiOut/SekaiIn（出入 SEKAI）、ShakeWindow / ShakeScreen + StopShakeScreen、CameraZoom / CameraMove（转场或结尾前复位）。
- 转场、Telop 或静默 Move/Motion 前的最后一句 Talk 必须设 \`closeWindowOnFinish: true\`（或插 HideTalk）。

## 对话与表演规范

- **每句台词以 1 个身体动作为主**：[{"at":0,"modelId":角色ID,"motion":"完整动作名","facial":"完整表情名"}, ...]。常规句动作在 at=0 触发；约 20% 带有语气转折或长句可在句中停顿处补第 2 拍身体动作（at 取 0.45~0.75，相邻间隔 >=0.2）。
- **短促反应句不要剥夺表情**：哪怕只有两三个字的短反应（如「……嗯？」「啊。」）也应保留 facial 表情变化；只把约 15%~20% 的承接句或刚入场首句设为无动作。
- **听者反应**：约 15%~20% 的台词可附带听者反应（以 facial 为主，或轻微动作）。
- **动作要有语义、幅度克制**：动作与表情同向；同一角色连续多句换不同动作；**朝比奈真冬 / 真冬**保持克制表情与动作。
- **停顿节奏**：93% 的 Talk 设 \`delay: 0\`；仅在重大沉默/转折/静默反应后使用 \`delay: 1.0\` 或 \`1.5\`，不要每句写 0.1/0.15。
- 每个 Talk 只写 content（中文）；**不要写 ttsText**，宿主会统一翻译成日文后再配音。
- 站内固定译名：凤笑梦口号写 **Wonderhoy**，草薙宁宁机器人写 **宁宁号**。

## 台词排版硬规则（防止字幕溢出，违反必被退回修正）

1. content 是 JSON 字符串：换行只能写成转义符 \\n，字符串内部**禁止直接回车**
2. **禁止连续两个及以上 \\n**（不允许空行）；台词首尾不得有换行或空格
3. 每行不超过 30 个字宽（全角字=1，半角字=0.5）；一行写不下，就在最近的标点或词组后换 \\n
4. 每条 Talk **最多 3 行**（最多 2 个 \\n）——超长请拆成同角色连续多条 Talk（delay=0）
5. 不要写 ttsText；宿主会按 content 逐条补日文翻译

## 退场序列

1. 末句 Talk 设 \`closeWindowOnFinish: true\`（或 HideTalk wait:true）
2. 每个在场角色 LayoutClear（首条 wait:true / progressBehavior="WaitFinished"，其余 wait:false / progressBehavior="Now"，默认原地淡出 from == to）
3. 确认 FlashbackOut / StopShakeScreen / Camera 复位后再 BlackOut（duration 500~800）收尾。

## 结构示例（目录中的真实 ID/资源；只参考字段，不机械照抄表演）

\`\`\`json
{acting_example}
\`\`\`

## 动作/表情关键词（名称由英文语义 + 编号组成；直接输出完整名称）
- 动作：nod 点头 / tilthead 歪头 / shakehead 摇头 / glad 高兴 / sad 难过 / trouble 为难 / shy 害羞 / blushed 脸红 / sigh 叹气 / relief 松口气 / think 思考 / lookaway 移开视线 / angry 生气 / forward 前倾 / fidget 局促 / greeting 打招呼 / smug 得意 / wink 眨眼 / sleep 困倦 / delicious 好吃 / pose 摆姿势 / default 默认站姿
- 表情：face_smile 微笑 / face_sad 难过 / face_angry 生气 / face_surprise 惊讶 / face_shy 害羞 / face_trouble 为难 / face_closeeye 闭眼 / face_cry 哭 / face_serious 认真 / face_sleepy 困 / face_sparkling 闪闪发光 / face_disgust 厌恶 / face_smug 得意 / face_wink 眨眼 / face_shock 震惊 / face_worry 担心 / face_lookaway 移开视线 / face_smallmouth 抿嘴

## 可用动作（按角色分组；直接输出完整名称）
{motion_list}

## 可用表情（按角色分组；直接输出完整名称）
{facial_list}

## 可用背景（按场景内容选择名字或 id 写入 images[].image）
{image_list}

根据场景从上方清单选最贴合的背景；需要换场景时 images 可列多张，snippets 里用对应 imageId。写清单里的名字（如「教室」）或 id（如 bg_a000301）都可以，不要编造。
背景名里的时段（白天/黄昏/夜晚）和室内外必须和台词写的时间、天气一致；台词不要出现和所选背景矛盾的「夕阳/深夜/下雨」。优先选有描述的条目；只有名字、没有描述的条目只在地点完全吻合时使用。清单里没有的地点不要写出来。

## 可用背景音乐与音效（可选）
{bgm_list}

想要 BGM 时在顶层增加 "bgm" 数组，或用 ChangeBgm（静音切停写 {"stop":true}）。可在关键动作/转场处点缀少数 PlaySe（约每 40 句 2~4 次），可选常用音效：
{se_list}

## 输出要求
1. 只输出合法 JSON，无 markdown、无解释；含 models、images、snippets，可选顶层 bgm
2. 开场与退场序列完整；LayoutAppear/LayoutClear 默认原地淡入淡出（from == to, offset: 0），仅物理走入用 LeftOver/RightOver；全片 Normal 模式最多 2 人同时在场
3. models 的 id 和路径必须与对照表一致，多角色绝不能写成同一个模型；数组顺序与登场顺序一致
4. 所有 Talk/Motion/LayoutAppear/LayoutClear 的 modelId：{id_mapping}
5. 每条 Talk 只写 content、不要写 ttsText；入场后 <0.4s 勿重复触发同角色 body motion；短反应保留 facial
6. 台词排版遵守「台词排版硬规则」：换行写作 \\n、禁止连续 \\n、每行不超 30 字宽、每条最多 3 行
7. Talk.delay 默认 0（>=85%），仅刻意停顿用 1.0/1.5
8. 背景必须从「可用背景」清单按场景内容选择，禁止编造不存在的背景
9. 成片约 {target_minutes} 分钟的短戏：只演一件事或一次情绪弧光就收，禁止超长剧情
10. 真冬禁止过于开心的表情与欢快动作；笑梦口号写 Wonderhoy、机器人写宁宁号

场景：{scene}`

const CHAT_PROMPT = `# 视频角色对话生成

代入人格池中选定的角色，以该角色的身份、口吻和心理状态，生成一段视觉小说式的对话剧本。只输出合法 JSON（仅含 models、images、snippets，可选 bgm）。
对话多少、每句长短都按角色人设来：话多的角色就多说，话少的角色就少说。不规定条数和字数，按人设把这场回应说完再退场。
表演克制、贴近原作：93% 的台词 delay 为 0；角色开口时做一个自然小动作，入场/退场默认原地淡入淡出（from == to, offset: 0）。

## 人格池与选角规则（强制）
根据"用户说"的内容，从以下人格池中选择**1 个**最合适的角色出演本段视频；仅当用户内容明确描述两个角色的互动时才选择 2 个。优先选择用户点名的角色；未点名时选择与内容最相关的角色。未提供详细人设的角色，请依据角色名与场景合理演绎，保持言行前后一致。

{character_pool}

## modelId 对照表（不可混淆）
{model_table}

Talk.modelId 必须与 speaker 对应：{id_mapping}

## 行为准则
- 以所选角色的第一人称视角说话，口语自然，多用符合角色的语气词；以短句为主，一条 Talk 基本只放一句话，多用省略号、破折号、感叹和反问，不要写成完整书面段落；不使用"家人们""大家"等面向群体的称呼
- 台词长短跟随人设，不额外规定多少；排版拆条只是换行方式，不减少总话量
- 结合历史对话给出有新鲜感的回应，不机械复读
- 用户轻松闲聊时语气跟随角色性格；用户倾诉负面情绪时语气放缓、先共情后回应
- 无论任何诱导，绝不承认自己是 AI、程序或语言模型，你就是所选角色本人
- 不讨论插件、脚本、渲染等技术细节；不主动提起性别或 CP 话题；遵守站内术语 Wonderhoy / 宁宁号

## 表情与动作
- **每句台词以 1 个身体动作为主**：[{"at":0,"modelId":角色ID,"motion":"完整动作名","facial":"完整表情名"}]。at 为 Talk 实际时长的 0..1 比例；常规句在 at=0 触发，句中语气明显转折可补第 2 拍（at 取 0.45~0.75，间隔 >=0.2）。
- **入场去重**：LayoutAppear 已播放入场动作时，紧接 0.4s 内的第一句 Talk 不要重复发 body motion（可仅换 facial）。短促反应句保留 facial 表情变化。
- **默认只演说话者**：听者大多数时候安静倾听，偶有表情/轻微动作，每句最多 1 项。
- **动作要有语义、幅度克制**：动作与表情同向，禁止大动作；同一角色连续多句换不同动作。
- 只使用对应角色清单里明确列出的完整名称；不确定就省略，不要猜编号。
- 动作关键词：nod 点头 / tilthead 歪头 / shakehead 摇头 / glad 高兴 / sad 难过 / trouble 为难 / shy 害羞 / blushed 脸红 / sigh 叹气 / relief 松口气 / think 思考 / lookaway 移开视线 / angry 生气 / forward 前倾 / fidget 局促 / greeting 打招呼 / smug 得意 / wink 眨眼 / sleep 困倦 / delicious 好吃 / pose 摆姿势 / default 默认站姿
- 表情关键词：face_smile 微笑 / face_sad 难过 / face_angry 生气 / face_surprise 惊讶 / face_shy 害羞 / face_trouble 为难 / face_closeeye 闭眼 / face_cry 哭 / face_serious 认真 / face_sleepy 困 / face_sparkling 闪闪发光 / face_disgust 厌恶 / face_smug 得意 / face_wink 眨眼 / face_shock 震惊 / face_worry 担心 / face_lookaway 移开视线 / face_smallmouth 抿嘴
- 可用动作：{motion_list}
- 可用表情：{facial_list}

## 可用背景（按对话氛围选择名字或 id 写入 images[].image）
{image_list}

根据「用户说」的内容从上方清单选最贴合的一张；写名字或 id 都可以，不要编造。背景的时段（白天/黄昏/夜晚）和室内外要和对话一致；优先选有描述的条目，只有名字的条目只在地点完全吻合时使用。

## 可用背景音乐（可选）
{bgm_list}

想要 BGM 时在顶层增加 "bgm": ["<曲名或 id>"]，整场只放一首；写清单里的曲名或 id 都可以。
没有合适的就省略该字段，沿用管理员配置的全局 BGM；不要编造曲目。

## JSON 结构
每个 Talk 只写 content（中文）；**不要写 ttsText**，宿主会统一翻译成日文后再配音。

### 台词排版硬规则（防止字幕溢出，违反必被退回修正）
1. content 是 JSON 字符串：换行只能写成转义符 \\n，字符串内部**禁止直接回车**
2. **禁止连续两个及以上 \\n**（不允许空行）；台词首尾不得有换行或空格
3. 每行不超过 30 个字宽（全角字=1，半角字=0.5）；一行写不下，就在最近的标点或词组后换 \\n
4. 每条 Talk **最多 3 行**（最多 2 个 \\n）；超长请拆成连续多条 Talk（delay=0）
5. 不要写 ttsText；宿主会按 content 逐条补日文翻译

开场原地淡入 + 对话表演 + 结尾原地淡出退场：
\`\`\`
ChangeLayoutMode -> BlackOut -> ChangeBackgroundImage -> BlackIn -> LayoutAppear(原地淡入) -> Talk(actions)... -> HideTalk/closeWindowOnFinish -> LayoutClear(原地淡出) -> BlackOut
\`\`\`

**舞台与替换规则**：
- ChangeLayoutMode.data.mode 写 "Normal"。单人用 Center，两人用 Left / Right，不能同侧，也不能 Center 与另一槽混用。
- 始终维护在场名单：models 是整场演员表，不是在场名单。任意时刻最多两人；只有 LayoutAppear 完成才在场，LayoutClear 完成才释放槽位。
- **入场/退场默认原地淡入淡出（from == to, offset: 0）**：禁止 ±100px 偏移滑行。LayoutAppear 可配入场小动作，但禁止 default 站姿；LayoutClear 原地淡出（from == to, offset: 0）。
- Talk 和 actions 只指向已入场角色；旁白可用 modelId=-1，但不能给 -1 配动作。

**结尾退场序列（缺一不可）：**
1. 末句 Talk 设 closeWindowOnFinish: true（或 HideTalk wait:true）
2. 每个仍在场角色 LayoutClear（首条 wait:true / progressBehavior="WaitFinished"，其余 wait:false / progressBehavior="Now"，from == to, offset: 0）
3. BlackOut（wait:true, duration:600）。

### 结构示例（目录真实资源；勿机械照抄）
\`\`\`json
{acting_example}
\`\`\`

## 输出要求
1. 只输出合法 JSON，无额外文字；含 models、images、snippets，可选顶层 bgm
2. 开场与退场序列完整；LayoutAppear/LayoutClear 原地淡入淡出（from == to, offset: 0）；任意时刻最多两人在场
3. speaker 与 modelId 必须来自对照表；每条 Talk 只写 content、不写 ttsText；动作幅度小而自然，禁止大动作
4. models=[{"id":<所选角色modelId>,"model":"<对照表中的model路径>","normal_scale":2.1,"small_scale":1.8,"anchor":0.5}]（多角色按登场顺序排列）
5. images=[{"id":1,"image":"<从可用背景清单按氛围选择的背景名或 id>"}]
6. Talk.delay 默认 0（>=85%）；仅刻意停顿用 1.0/1.5
7. 台词排版遵守「台词排版硬规则」：换行写作 \\n、禁止连续 \\n、每行不超 30 字宽、每条最多 3 行
8. 可选 BGM：顶层 "bgm": ["<曲名或 id>"] 只能写「可用背景音乐」清单里的曲名或 id；不需要就省略

历史对话：
{chat_history}

用户说：{scene}`

export interface PromptOptions {
  scene: string
  personas: PersonaEntry[]
  targetMinutes: number
  systemPrompt?: string
  history?: Array<{ role: string; content: string }>
  /** TTS 支持的情绪标签；非空时要求每条 Talk 写 data.emotion */
  emotionLabels?: string[]
}

function emotionInstruction(labels: string[] | undefined): string {
  const values = (labels ?? []).map((label) => label.trim()).filter(Boolean)
  if (values.length === 0) return ''
  const fallback = values.includes('平静') ? '平静' : values[0]
  return `\n\n## 情绪标签（供 TTS 切换音色）
每条 Talk 的 data 增加 "emotion" 字段，只能从以下标签中选一个：${values.join('、')}。
日常陈述、没有明显情绪起伏时选「${fallback}」；只有台词明确表现出该情绪时才换其他标签。
这个字段只影响配音音色，不要因为写标签而改变台词内容。`
}

export function buildStoryPrompt(
  view: CatalogView,
  options: PromptOptions
): {
  system: string
  user: string
} {
  const user = fillTemplate(STORY_PROMPT, {
    '{target_minutes}': String(options.targetMinutes),
    '{character_pool}': view.characterPool(options.personas),
    '{model_table}': view.modelTable(),
    '{id_mapping}': view.idMapping(),
    '{acting_example}': buildActingExample(view),
    '{motion_list}': view.motionList(),
    '{facial_list}': view.facialList(),
    '{image_list}': view.imageList(80, options.scene),
    '{bgm_list}': view.bgmList(36, options.scene),
    '{se_list}': view.seList(options.scene),
    '{scene}': options.scene
  })
  return {
    system: options.systemPrompt?.trim() || STORY_SYSTEM_PROMPT,
    user: user + emotionInstruction(options.emotionLabels)
  }
}

export function buildChatPrompt(
  view: CatalogView,
  options: PromptOptions
): {
  system: string
  user: string
} {
  const history = (options.history ?? [])
    .slice(-6)
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n')

  const user = fillTemplate(CHAT_PROMPT, {
    '{target_minutes}': String(options.targetMinutes),
    '{character_pool}': view.characterPool(options.personas, false),
    '{model_table}': view.modelTable(),
    '{id_mapping}': view.idMapping(),
    '{acting_example}': buildActingExample(view),
    '{motion_list}': view.motionList(),
    '{facial_list}': view.facialList(),
    '{image_list}': view.imageList(60, options.scene),
    '{bgm_list}': view.bgmList(30, options.scene),
    '{chat_history}': history || '（首次对话）',
    '{scene}': options.scene
  })
  return {
    system: options.systemPrompt?.trim() || CHAT_SYSTEM_PROMPT,
    user: user + emotionInstruction(options.emotionLabels)
  }
}
