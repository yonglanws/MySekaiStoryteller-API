import type { StoryData } from '../../common/types/Story'
import backgroundNameData from '../assets/background-names.json'
import bgmSemanticsData from '../assets/bgm-semantics.json'
import type { CatalogBgm, CatalogImage } from '../resources/resourceCatalog'
import type { CatalogView } from './prompt'

export type SekaiUnitId =
  | 'empty'
  | 'classroom'
  | 'stage'
  | 'street'
  | 'wonderland'
  | 'generic'
  | 'collab'

export interface SekaiBgmClassification {
  /** 是否受世界线/特别活动限制（现实常规场景不可随意使用） */
  isRestricted: boolean
  /** 是否为 SEKAI 专属曲（仅限对应 SEKAI 内使用） */
  isSekaiExclusive: boolean
  /** 是否为联动/愚人节特别活动专属曲 */
  isSpecialEventOnly: boolean
  sekaiUnit: SekaiUnitId | null
  label: string
  reason: string
}

export interface SceneSekaiContext {
  isSekai: boolean
  sekaiUnit: SekaiUnitId | null
  isSpecialEvent: boolean
  reason: string
}

export interface SceneContextInput {
  isSekaiFlag?: boolean
  transitionIn?: string
  background?: string
  backgroundDetail?: CatalogImage | null
  placeInfo?: string
  telop?: string
  summary?: string
  promptText?: string
  dialogueText?: string
  sekaiTransitionActive?: boolean
}

export interface BgmGuardDecision {
  allowed: boolean
  originalFile: string
  finalFile: string
  replaced: boolean
  reason: string
  classification: SekaiBgmClassification
  sceneContext: SceneSekaiContext
}

export interface SekaiBgmReplacement {
  snippetIndex: number
  originalFile: string
  replacementFile: string
  reason: string
  bgmLabel: string
  sceneReason: string
}

export interface SanitizeStoryBgmResult {
  replaced: SekaiBgmReplacement[]
  warnings: string[]
}

interface BgmSemanticRecord {
  name?: string
  category?: string
  mood?: string
  tempo?: string
  unit?: string
  scenes?: string[]
  description?: string
  bundlePrefix?: string
  tags?: string[]
}

interface BackgroundSemanticRecord {
  name?: string
  aliases?: string[]
  category?: string
  timeOfDay?: string
  indoor?: string
  tags?: string[]
}

const BGM_SEMANTICS =
  (bgmSemanticsData as { tracks?: Record<string, BgmSemanticRecord> }).tracks ?? {}
const BG_SEMANTICS =
  (backgroundNameData as { backgrounds?: Record<string, BackgroundSemanticRecord> }).backgrounds ??
  {}

const SEKAI_UNIT_LABELS: Record<SekaiUnitId, string> = {
  empty: '无人SEKAI',
  classroom: '教室SEKAI',
  stage: '舞台SEKAI',
  street: '街头SEKAI',
  wonderland: '奇幻SEKAI',
  generic: 'SEKAI空间',
  collab: '联动/特别活动'
}

/** 明确登记为 SEKAI 专属 / 特别活动专属的曲目 ID 表（含 5 团 area_bgm、untitled 主题曲、异世界氛围曲与联动曲） */
const EXPLICIT_RESTRICTED_BGM_UNITS: Readonly<Record<string, SekaiUnitId>> = {
  // 5 团 SEKAI 区域主题曲（bgm_area00001..00005）
  bgm_area00001: 'classroom',
  bgm_area00002: 'stage',
  bgm_area00003: 'street',
  bgm_area00004: 'wonderland',
  bgm_area00005: 'empty',

  // 5 团「世界」untitled 主题曲（含区域版）
  leoneed_untitled: 'classroom',
  leoneed_untitled_2: 'classroom',
  bgm_area_leoneed_untitled: 'classroom',
  bgm_area_leoneed_untitled_2: 'classroom',

  moremore_untitled: 'stage',
  moremore_untitled_2: 'stage',
  bgm_area_moremore_untitled: 'stage',
  bgm_area_moremore_untitled_2: 'stage',

  vividbad_untitled: 'street',
  vividbad_untitled_2: 'street',
  bgm_area_vividbad_untitled: 'street',
  bgm_area_vividbad_untitled_2: 'street',

  wonderlands_untitled: 'wonderland',
  wonderlands_untitled_2: 'wonderland',
  bgm_area_wonderlands_untitled: 'wonderland',
  bgm_area_wonderlands_untitled_2: 'wonderland',

  nightcode_untitled: 'empty',
  nightcode_untitled_2: 'empty',
  bgm_area_nightcode_untitled: 'empty',
  bgm_area_nightcode_untitled_2: 'empty',

  // 通用 / 虚拟歌手 / WorldLink / 剧场版 SEKAI 专属曲
  bgm_area_bigtree: 'generic',
  bgm_area_wishtree: 'generic',
  bgm_area_movie_2025: 'generic',
  bgm00036: 'generic',
  bgm00168: 'generic',
  bgm00238: 'classroom',
  bgm00290: 'generic',
  bgm00307: 'street',
  bgm00316: 'street',
  bgm00336: 'generic',
  bgm10001: 'generic',
  bgm10002: 'generic',
  bgm10003: 'generic',
  bgm10004: 'generic',
  bgm10005: 'generic',

  // 联动 / 愚人节特别区域主题曲
  bgm_area_aprilfool_2022: 'collab',
  bgm_april_fool_2026: 'collab',
  bgm_area_e_collabo: 'collab',
  collaboration_akuno: 'collab',
  collaboration_sanrio: 'collab'
}

/** 明确属于现实世界常规区域/剧情的 BGM（白名单，永不误拦） */
const EXPLICIT_REAL_WORLD_BGMS = new Set<string>(['normal_area'])

/** 属于 SEKAI 内部但 background-names.json 分类未标为 SEKAI世界 的特殊背景 ID */
const SPECIAL_SEKAI_BG_UNITS: Readonly<Record<string, SekaiUnitId>> = {
  bg_c000501: 'street', // Crase Cafe（街头「世界」内咖啡店）
  bg_b003101: 'stage', // 舞台「世界」花田
  bg_d002501: 'wonderland', // 奇幻乐园「世界」港口
  bg_f001503: 'classroom' // 教室「世界」车站
}

const REAL_WORLD_BG_CATEGORIES = new Set<string>([
  '校园',
  '涩谷街景',
  '住宅与房间',
  '商业与餐饮',
  '游乐园与休闲',
  '演出与排练',
  '自然与旅行',
  '医院与公共',
  '线上通话'
])

/** 现实世界高频可靠情绪锚点曲（用于替换 SEKAI 曲时微幅加权，确保曲风自然不跳戏） */
const RELIABLE_REAL_WORLD_BGMS = new Set<string>([
  'bgm00003',
  'bgm00006',
  'bgm00016',
  'bgm00017',
  'bgm00018',
  'bgm00020',
  'bgm00021',
  'bgm00022',
  'bgm00024',
  'bgm00029',
  'bgm00034',
  'bgm00038',
  'bgm00039',
  'bgm00048',
  'bgm00055',
  'bgm00065',
  'bgm00082',
  'bgm00169',
  'bgm00170',
  'bgm00171',
  'bgm00173',
  'bgm00175',
  'bgm00180',
  'bgm00215',
  'bgm00217',
  'bgm00272'
])

const COMPATIBLE_MOOD_SCORES: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  宁静深夜: { 宁静深夜: 26, 感伤忧郁: 14, 温暖治愈: 8, 轻松日常: 5 },
  感伤忧郁: { 感伤忧郁: 26, 宁静深夜: 15, 温暖治愈: 9, 紧张悬疑: 4 },
  温暖治愈: { 温暖治愈: 26, 轻松日常: 14, 宁静深夜: 8, 感伤忧郁: 6 },
  轻松日常: { 轻松日常: 26, 温暖治愈: 14, 元气欢快: 10, 宁静深夜: 4 },
  元气欢快: { 元气欢快: 26, 奇幻活泼: 14, 轻松日常: 10, 律动街头: 8 },
  奇幻活泼: { 奇幻活泼: 26, 元气欢快: 16, 轻松日常: 8 },
  律动街头: { 律动街头: 26, 元气欢快: 12, 轻松日常: 9, 热血激昂: 8 },
  紧张悬疑: { 紧张悬疑: 26, 感伤忧郁: 10, 宁静深夜: 8 },
  热血激昂: { 热血激昂: 26, 元气欢快: 12, 律动街头: 10, 温暖治愈: 6 },
  神秘空灵: { 宁静深夜: 20, 感伤忧郁: 14, 温暖治愈: 10, 轻松日常: 6 }
}

const SPECIAL_EVENT_RE = /愚人节|april\s*fool|联动|collab(?:oration)?|恶之大罪|三丽鸥|sanrio|akuno/i

const REAL_WORLD_PLACE_RE =
  /东云家|宵崎家|朝比奈家|晓山家|星乃家|天马家|望月家|日野森家|白石家|小豆泽家|青柳家|神代家|凤家|草薙家|花里家|桐谷家|桃井家|客厅|卧室|房间|厨房|家里|家中|家庭餐厅|餐厅|便利店|书店|神山高校|宫益坂|女子学园|校门|天台|操场|走廊|涩谷|十字路口|医院|病房|凤凰仙境|weekend\s*garage|live\s*house|nightcord|语音通话|在线通话|连线|现实世界/i

const REAL_WORLD_FILENAME_RE =
  /(?:^|[_/-])(room|bedroom|living|kitchen|home|house|school|classroom|rooftop|corridor|restaurant|shibuya|hospital|station|nightcord|call)(?:$|[_/-])/i

export function normalizeBgmStem(value: unknown): string {
  const raw = String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^resources\//i, '')
    .replace(/^audio\/bgm\//i, '')
    .replace(/^cloud\//i, '')
  if (!raw) return ''
  const base = raw.split('/').pop() ?? raw
  return base.replace(/\.[^.]+$/, '').toLowerCase()
}

function normalizeBackgroundStem(value: unknown): string {
  const raw = String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^resources\//i, '')
    .replace(/^images\//i, '')
    .replace(/^cloud\//i, '')
  if (!raw) return ''
  const base = raw.split('/').pop() ?? raw
  return base.replace(/\.[^.]+$/, '').toLowerCase()
}

function lookupBgmSemanticRecord(stem: string): BgmSemanticRecord | null {
  if (!stem) return null
  return BGM_SEMANTICS[stem] ?? BGM_SEMANTICS[stem.replace(/_\d+$/, '')] ?? null
}

function lookupBackgroundRecord(stem: string): BackgroundSemanticRecord | null {
  if (!stem) return null
  return BG_SEMANTICS[stem] ?? null
}

function unitNameToSekaiUnit(unit: string | undefined): SekaiUnitId | null {
  if (!unit) return null
  const lower = unit.toLowerCase()
  if (/25时|25時|nightcord|ニーゴ|n25/.test(lower)) return 'empty'
  if (/leo\/need|leoneed|l\/n/.test(lower)) return 'classroom'
  if (/more\s*more\s*jump|moremore|mmj/.test(lower)) return 'stage'
  if (/vivid\s*bad|vividbad|vbs/.test(lower)) return 'street'
  if (/wonderlands|showtime|w[×x]s/.test(lower)) return 'wonderland'
  if (/联动|collab/.test(lower)) return 'collab'
  if (/虚拟歌手|virtual\s*singer|vs/.test(lower)) return 'generic'
  return null
}

function inferSekaiUnitFromText(text: string): SekaiUnitId | null {
  if (!text) return null
  if (
    /无人[的]?[「『]?世界[」』]?|无人\s*sekai|誰もいないセカイ|empty\s*sekai|nightcode_untitled/i.test(
      text
    )
  ) {
    return 'empty'
  }
  if (
    /教室[的]?[「『]?世界[」』]?|教室\s*sekai|教室のセカイ|classroom\s*sekai|school\s*sekai|leoneed_untitled/i.test(
      text
    )
  ) {
    return 'classroom'
  }
  if (
    /舞台[的]?[「『]?世界[」』]?|舞台\s*sekai|ステージのセカイ|stage\s*sekai|moremore_untitled/i.test(
      text
    )
  ) {
    return 'stage'
  }
  if (
    /街头[的]?[「『]?世界[」』]?|街头\s*sekai|ストリートのセカイ|street\s*sekai|crase\s*cafe|vividbad_untitled/i.test(
      text
    )
  ) {
    return 'street'
  }
  if (
    /奇幻(?:乐园)?[的]?[「『]?世界[」』]?|奇幻\s*sekai|ワンダーランドのセカイ|wonderland\s*sekai|wonderlands_untitled/i.test(
      text
    )
  ) {
    return 'wonderland'
  }
  if (
    /心愿[之巨]?树|「世界」交汇|心愿[「『]?世界[」』]?|大树[「『]?世界[」』]?|剧场版[「『]?世界[」』]?|セカイの狭間|狭间|sekai交汇/i.test(
      text
    )
  ) {
    return 'generic'
  }
  return null
}

function hasExplicitSekaiMention(text: string): boolean {
  if (!text) return false
  if (inferSekaiUnitFromText(text) !== null) return true
  return /(?:^|[^a-z])sekai(?:[^a-z]|$)|セカイ|[「『]世界[」』]|进入世界|来到世界|去世界|在世界里|异世界空间/i.test(
    text
  )
}

function buildClassification(unit: SekaiUnitId | null, reason: string): SekaiBgmClassification {
  if (!unit) {
    return {
      isRestricted: false,
      isSekaiExclusive: false,
      isSpecialEventOnly: false,
      sekaiUnit: null,
      label: '',
      reason: reason || '常规剧情BGM'
    }
  }
  const isSpecialEventOnly = unit === 'collab'
  return {
    isRestricted: true,
    isSekaiExclusive: !isSpecialEventOnly,
    isSpecialEventOnly,
    sekaiUnit: unit,
    label: SEKAI_UNIT_LABELS[unit],
    reason
  }
}

/**
 * 判定一首 BGM 是否属于 SEKAI 专属（或联动/特别活动专属）曲目，以及所属 SEKAI 分区。
 * 同时检查显式 ID 映射、前缀规律、`CatalogBgm` 元数据及 `bgm-semantics.json`。
 */
export function classifyBgmSekaiScope(
  bgmIdOrFile: unknown,
  detail?: Partial<CatalogBgm> | null
): SekaiBgmClassification {
  const stem = normalizeBgmStem(bgmIdOrFile || detail?.id || detail?.file)
  if (!stem || stem === 'silence' || stem === 'keep' || stem === 'bgm00000') {
    return buildClassification(null, '静音/保持')
  }
  if (EXPLICIT_REAL_WORLD_BGMS.has(stem)) {
    return buildClassification(null, '现实世界区域BGM')
  }

  // 1. 显式映射表（最高优先级，不依赖运行时目录描述是否齐全）
  const explicitUnit = EXPLICIT_RESTRICTED_BGM_UNITS[stem]
  if (explicitUnit) {
    return buildClassification(
      explicitUnit,
      `已登记为${SEKAI_UNIT_LABELS[explicitUnit]}专属BGM(${stem})`
    )
  }

  // 2. 文件名/ID 规律匹配（覆盖未来新增的 *_untitled* / bgm_area_* / collaboration_* / *_sekai*）
  if (/^(?:bgm_area_)?nightcode_untitled(?:_\d+)?$/.test(stem) || /empty_?sekai/.test(stem)) {
    return buildClassification('empty', `ID匹配无人SEKAI主题(${stem})`)
  }
  if (
    /^(?:bgm_area_)?leoneed_untitled(?:_\d+)?$/.test(stem) ||
    /(?:classroom|school)_?sekai/.test(stem)
  ) {
    return buildClassification('classroom', `ID匹配教室SEKAI主题(${stem})`)
  }
  if (/^(?:bgm_area_)?moremore_untitled(?:_\d+)?$/.test(stem) || /stage_?sekai/.test(stem)) {
    return buildClassification('stage', `ID匹配舞台SEKAI主题(${stem})`)
  }
  if (/^(?:bgm_area_)?vividbad_untitled(?:_\d+)?$/.test(stem) || /street_?sekai/.test(stem)) {
    return buildClassification('street', `ID匹配街头SEKAI主题(${stem})`)
  }
  if (
    /^(?:bgm_area_)?wonderlands_untitled(?:_\d+)?$/.test(stem) ||
    /wonderland_?sekai/.test(stem)
  ) {
    return buildClassification('wonderland', `ID匹配奇幻SEKAI主题(${stem})`)
  }
  if (/^(?:collaboration_|bgm_area_e_collabo|bgm_(?:area_)?april_?fool)/.test(stem)) {
    return buildClassification('collab', `ID匹配联动/特别活动主题(${stem})`)
  }
  if (/sekai|untitled/.test(stem) || (/^bgm_area/.test(stem) && stem !== 'normal_area')) {
    const sem = lookupBgmSemanticRecord(stem)
    const unit =
      unitNameToSekaiUnit(detail?.unit ?? sem?.unit) ??
      inferSekaiUnitFromText(`${detail?.name ?? ''} ${sem?.name ?? ''}`) ??
      'generic'
    return buildClassification(unit, `区域/SEKAI曲目ID规律(${stem})`)
  }

  // 3. 元数据与 bgm-semantics.json 语义兜底
  const sem = lookupBgmSemanticRecord(stem)
  const category = `${detail?.category ?? ''} ${sem?.category ?? ''}`.trim()
  const tags = [...(detail?.tags ?? []), ...(sem?.tags ?? [])].join(' ')
  const name = `${detail?.name ?? ''} ${sem?.name ?? ''}`.trim()
  const desc = `${detail?.description ?? ''} ${sem?.description ?? ''}`.trim()
  const unitText = detail?.unit ?? sem?.unit
  const combined = `${category} ${tags} ${name} ${desc}`

  if (/仅限特别活动|特别活动/.test(category) || /仅限(?:愚人节|联动|特别活动)/.test(combined)) {
    return buildClassification('collab', `语义标注为特别活动/联动专属(${stem})`)
  }

  const isSekaiByMeta =
    /SEKAI/i.test(category) ||
    /仅限(?:对应)?(?:无人|教室|舞台|街头|奇幻)?SEKAI/i.test(combined) ||
    /セカイ|誰もいないセカイ|教室のセカイ|ステージのセカイ|ストリートのセカイ|ワンダーランドのセカイ/.test(
      name
    ) ||
    /(?:无人|教室|舞台|街头|奇幻乐园|心愿之树|剧场版)[「『]世界[」』]/.test(name) ||
    /异世界氛围曲/.test(desc)

  if (isSekaiByMeta) {
    const inferredUnit =
      inferSekaiUnitFromText(`${name} ${tags} ${desc}`) ??
      unitNameToSekaiUnit(unitText) ??
      'generic'
    return buildClassification(
      inferredUnit,
      `语义标注为${SEKAI_UNIT_LABELS[inferredUnit]}专属(${stem})`
    )
  }

  return buildClassification(null, '常规剧情BGM')
}

export function isSekaiExclusiveBgm(
  bgmIdOrFile: unknown,
  detail?: Partial<CatalogBgm> | null
): boolean {
  return classifyBgmSekaiScope(bgmIdOrFile, detail).isSekaiExclusive
}

/** 生成用于提示词/工具返回的显眼 SEKAI 限定标注，已有标注时不重复拼接 */
export function formatSekaiBgmBadge(detail: Partial<CatalogBgm>): string {
  const cls = classifyBgmSekaiScope(detail.file || detail.id || '', detail)
  if (!cls.isRestricted) return ''
  const existing = `${detail.name ?? ''} ${detail.description ?? ''}`
  if (/仅限.*使用|仅限.*SEKAI|仅限特别活动/.test(existing)) return ''
  return `[仅限${cls.label}内使用]`
}

/**
 * 判定某个场景（或检索查询）是否位于 SEKAI 内部以及具体属于哪个 SEKAI 分区。
 * 优先级：明确背景分类/ID > 明确地点牌(PlaceInfo) > 显式 isSekai/转场标记 > 文本语义线索。
 */
export function detectSceneSekaiContext(
  input: SceneContextInput,
  view?: Pick<CatalogView, 'canonicalImageEntry'> | null
): SceneSekaiContext {
  const bgRaw = (input.background ?? '').trim()
  const bgDetail =
    input.backgroundDetail ?? (bgRaw && view ? view.canonicalImageEntry(bgRaw) : null)
  const bgStem = normalizeBackgroundStem(bgDetail?.id || bgDetail?.file || bgRaw)
  const bgMeta = lookupBackgroundRecord(bgStem)

  const placeText = [input.placeInfo, input.telop].filter(Boolean).join(' ').trim()
  const contextText = [input.summary, input.promptText, input.dialogueText]
    .filter(Boolean)
    .join(' ')
  const allText = `${placeText} ${contextText}`.trim()
  const isSpecialEvent = SPECIAL_EVENT_RE.test(
    `${allText} ${bgDetail?.name ?? ''} ${bgMeta?.name ?? ''}`
  )

  // 1. 背景是最强的物理空间证据：如果画面本身明确是 SEKAI 背景
  if (bgStem && SPECIAL_SEKAI_BG_UNITS[bgStem]) {
    const unit = SPECIAL_SEKAI_BG_UNITS[bgStem]
    return {
      isSekai: true,
      sekaiUnit: unit,
      isSpecialEvent,
      reason: `背景(${bgStem})属于${SEKAI_UNIT_LABELS[unit]}`
    }
  }

  const bgCategory = bgDetail?.category ?? bgMeta?.category ?? ''
  const bgName = `${bgDetail?.name ?? ''} ${bgMeta?.name ?? ''}`.trim()
  const bgAliases = [...(bgDetail?.aliases ?? []), ...(bgMeta?.aliases ?? [])].join(' ')
  const bgTags = [...(bgDetail?.tags ?? []), ...(bgMeta?.tags ?? [])].join(' ')
  const bgCombined = `${bgStem} ${bgName} ${bgAliases} ${bgTags}`

  if (/^SEKAI/i.test(bgCategory) || bgCategory === 'SEKAI世界') {
    const unit =
      inferSekaiUnitFromText(bgCombined) ??
      unitNameToSekaiUnit(bgTags) ??
      inferSekaiUnitFromText(allText) ??
      'generic'
    return {
      isSekai: true,
      sekaiUnit: unit,
      isSpecialEvent,
      reason: `背景(${bgDetail?.name || bgMeta?.name || bgStem})分类为SEKAI世界`
    }
  }

  // 若未登记在 background-names.json（如本地/测试背景），按文件名/背景名显式判断 SEKAI
  if (bgRaw && inferSekaiUnitFromText(`${bgRaw} ${bgName}`) !== null) {
    const unit = inferSekaiUnitFromText(`${bgRaw} ${bgName}`)!
    return {
      isSekai: true,
      sekaiUnit: unit,
      isSpecialEvent,
      reason: `背景名(${bgName || bgRaw})指向${SEKAI_UNIT_LABELS[unit]}`
    }
  }
  if (bgRaw && /\bsekai\b|「世界」/i.test(`${bgRaw} ${bgName}`)) {
    const unit = inferSekaiUnitFromText(`${bgCombined} ${allText}`) ?? 'generic'
    return {
      isSekai: true,
      sekaiUnit: unit,
      isSpecialEvent,
      reason: `背景名(${bgName || bgRaw})显式包含SEKAI标记`
    }
  }

  // 2. 如果背景明确属于现实世界分类（住宅与房间、校园、商业与餐饮、线上通话等），
  //    即便剧情角色是 25 时成员或提到深夜，也绝不是 SEKAI！
  if (bgCategory && REAL_WORLD_BG_CATEGORIES.has(bgCategory)) {
    // 排除 bg_i* 剧场版特例（aliases 含 过去的「世界」且 placeInfo 显式写 SEKAI）
    const placeIsExplicitSekai = Boolean(placeText && hasExplicitSekaiMention(placeText))
    if (!placeIsExplicitSekai) {
      return {
        isSekai: false,
        sekaiUnit: null,
        isSpecialEvent,
        reason: `背景(${bgDetail?.name || bgMeta?.name || bgStem})属于现实场景[${bgCategory}]`
      }
    }
  }

  if (
    bgRaw &&
    (REAL_WORLD_PLACE_RE.test(`${bgName} ${bgRaw}`) || REAL_WORLD_FILENAME_RE.test(bgStem)) &&
    !(placeText && hasExplicitSekaiMention(placeText))
  ) {
    return {
      isSekai: false,
      sekaiUnit: null,
      isSpecialEvent,
      reason: `背景(${bgName || bgRaw})属于现实地点`
    }
  }

  // 3. 明确转出 SEKAI（sekaiOut）则进入现实世界
  if (input.transitionIn === 'sekaiOut') {
    return {
      isSekai: false,
      sekaiUnit: null,
      isSpecialEvent,
      reason: '转场为sekaiOut（回到现实世界）'
    }
  }

  // 4. PlaceInfo / Telop 明确标注了 SEKAI 或现实地点
  if (placeText) {
    if (hasExplicitSekaiMention(placeText)) {
      const unit =
        inferSekaiUnitFromText(placeText) ??
        inferSekaiUnitFromText(contextText) ??
        unitNameToSekaiUnit(allText) ??
        'generic'
      return {
        isSekai: true,
        sekaiUnit: unit,
        isSpecialEvent,
        reason: `地点标注(${placeText})指向${SEKAI_UNIT_LABELS[unit]}`
      }
    }
    if (REAL_WORLD_PLACE_RE.test(placeText)) {
      return {
        isSekai: false,
        sekaiUnit: null,
        isSpecialEvent,
        reason: `地点标注(${placeText})属于现实世界`
      }
    }
  }

  // 5. 显式 isSekaiFlag / sekaiIn / 处于 SekaiIn 之后（背景为纯色或未识别占位图时）
  if (input.isSekaiFlag || input.transitionIn === 'sekaiIn' || input.sekaiTransitionActive) {
    const unit =
      inferSekaiUnitFromText(`${bgCombined} ${allText}`) ??
      unitNameToSekaiUnit(allText) ??
      'generic'
    return {
      isSekai: true,
      sekaiUnit: unit,
      isSpecialEvent,
      reason: '显式SEKAI转场或标记'
    }
  }

  // 6. 无背景时的纯文本查询（如 search_assets / bgmPromptChoices）
  if (!bgRaw && hasExplicitSekaiMention(allText)) {
    const unit = inferSekaiUnitFromText(allText) ?? unitNameToSekaiUnit(allText) ?? 'generic'
    return {
      isSekai: true,
      sekaiUnit: unit,
      isSpecialEvent,
      reason: `查询文本显式指向${SEKAI_UNIT_LABELS[unit]}`
    }
  }

  return {
    isSekai: false,
    sekaiUnit: null,
    isSpecialEvent,
    reason: bgRaw ? `非SEKAI背景(${bgDetail?.name || bgMeta?.name || bgRaw})` : '常规现实场景'
  }
}

/** 判定给定 BGM 是否允许在指定场景上下文中播放 */
export function isBgmAllowedInScene(
  bgmIdOrFile: unknown,
  sceneContext: SceneSekaiContext,
  detail?: Partial<CatalogBgm> | null
): boolean {
  const cls = classifyBgmSekaiScope(bgmIdOrFile, detail)
  if (!cls.isRestricted) return true

  if (cls.isSpecialEventOnly) {
    return sceneContext.isSpecialEvent
  }

  // SEKAI 专属曲：严禁用于任何非 SEKAI 现实场景
  if (!sceneContext.isSekai) return false

  // 通用 SEKAI 曲（心愿之树 / セカイの狭間 / 异世界星光）允许用于任意 SEKAI 场景
  if (cls.sekaiUnit === 'generic') return true

  // 场景明确为某个组合的 SEKAI 时，只允许同组合 SEKAI 曲（严禁跨团 SEKAI 串台）
  if (sceneContext.sekaiUnit && sceneContext.sekaiUnit !== 'generic') {
    return cls.sekaiUnit === sceneContext.sekaiUnit
  }

  // 场景仅标了泛 SEKAI（如心愿交汇空间）时，禁止特定单团的专属区域主题曲误用
  return false
}

function inferMoodFromSceneText(text: string): string {
  if (/深夜|25点|凌晨|半夜|熬夜|独处|安静|静谧|疲惫|肩膀好酸|画画|孤独|失眠/.test(text)) {
    return '宁静深夜'
  }
  if (/哭|泪|难过|伤心|抱歉|对不起|痛苦|低落|后悔|离别|遗憾/.test(text)) {
    return '感伤忧郁'
  }
  if (/吵|争执|对峙|冲突|危机|焦急|愤怒|生气|紧绷|不安|秘密/.test(text)) {
    return '紧张悬疑'
  }
  if (/加油|梦想|约定|突破|高潮|决心|前进|舞台/.test(text)) {
    return '热血激昂'
  }
  if (/搞笑|玩笑|吐槽|派对|欢快|开心|笑|游乐园|布丁|甜品/.test(text)) {
    return '轻松日常'
  }
  if (/温柔|温暖|安慰|回忆|夕阳|黄昏|放学|感谢/.test(text)) {
    return '温暖治愈'
  }
  return '轻松日常'
}

/**
 * 为被拦截的 BGM 从目录中确定性挑选最契合氛围的合法替代曲：
 * - 现实场景：严格只从非 SEKAI/非特别活动曲目中挑选，尽量保持原曲情绪（如宁静深夜/感伤忧郁/温暖治愈）与节奏；
 * - SEKAI 场景串台（如在无人SEKAI用了奇幻SEKAI曲）：优先挑同分区 SEKAI 曲，其次挑同氛围合法曲。
 */
export function pickSafeReplacementBgm(
  view: CatalogView,
  sceneContext: SceneSekaiContext,
  options: {
    blockedFile?: string
    blockedDetail?: Partial<CatalogBgm> | null
    sceneText?: string
    excludeFiles?: ReadonlySet<string>
  } = {}
): CatalogBgm | null {
  const allDetails = view.bgmDetailsList()
  if (allDetails.length === 0) return null

  const candidates = allDetails.filter((item) => isBgmAllowedInScene(item.file, sceneContext, item))
  if (candidates.length === 0) return null

  const blockedStem = normalizeBgmStem(
    options.blockedFile || options.blockedDetail?.id || options.blockedDetail?.file
  )
  const blockedSem = lookupBgmSemanticRecord(blockedStem)
  const blockedCls = classifyBgmSekaiScope(blockedStem, options.blockedDetail)
  const sceneText = options.sceneText ?? ''

  const isWrongUnitSekaiMismatch = Boolean(
    sceneContext.isSekai &&
    sceneContext.sekaiUnit &&
    sceneContext.sekaiUnit !== 'generic' &&
    blockedCls.isSekaiExclusive &&
    blockedCls.sekaiUnit !== sceneContext.sekaiUnit
  )

  // 跨团 SEKAI 串台（如无人SEKAI误配了奇幻SEKAI曲）时，不继承错误曲目的欢快情绪/组合，而是严格对齐当前目标 SEKAI 分区
  const targetMood = isWrongUnitSekaiMismatch
    ? inferMoodFromSceneText(sceneText)
    : options.blockedDetail?.mood || blockedSem?.mood || inferMoodFromSceneText(sceneText)
  const targetTempo = isWrongUnitSekaiMismatch
    ? ''
    : options.blockedDetail?.tempo || blockedSem?.tempo || ''
  const targetUnit = isWrongUnitSekaiMismatch
    ? ''
    : options.blockedDetail?.unit || blockedSem?.unit || ''

  const moodTable = COMPATIBLE_MOOD_SCORES[targetMood] ?? COMPATIBLE_MOOD_SCORES['轻松日常']
  const excludeLower = new Set(
    [...(options.excludeFiles ?? [])].map((f) => normalizeBgmStem(f)).filter(Boolean)
  )

  let best: CatalogBgm = candidates[0]
  let bestScore = -Infinity

  for (const item of candidates) {
    const stem = normalizeBgmStem(item.id || item.file)
    const sem = lookupBgmSemanticRecord(stem)
    const itemMood = item.mood || sem?.mood || ''
    const itemTempo = item.tempo || sem?.tempo || ''
    const itemUnit = item.unit || sem?.unit || ''
    const itemName = item.name || sem?.name || ''
    const itemDesc = item.description || sem?.description || ''
    const itemCls = classifyBgmSekaiScope(item.file, item)

    let score = 0

    // 1. 若场景本身是特定 SEKAI 且原曲串台，强优先选择该 SEKAI 的专属曲
    if (
      sceneContext.isSekai &&
      sceneContext.sekaiUnit &&
      sceneContext.sekaiUnit !== 'generic' &&
      itemCls.sekaiUnit === sceneContext.sekaiUnit
    ) {
      score += 80
    }

    // 2. 情绪族匹配
    if (itemMood && moodTable[itemMood] !== undefined) {
      score += moodTable[itemMood]
    } else if (itemMood === targetMood) {
      score += 24
    }

    // 3. 节奏匹配
    if (targetTempo && itemTempo === targetTempo) {
      score += 6
    }

    // 4. 组合风格贴合（例如 25 时现实深夜场景优先匹配 25 时现实深夜剧情曲，其次通用曲）
    if (targetUnit && targetUnit !== '通用' && itemUnit === targetUnit) {
      score += 8
    } else if (itemUnit === '通用') {
      score += 4
    }

    // 5. 优先带真实曲名/策展描述的高质量曲目，避开占位名和伴奏曲(song000*)
    if (itemDesc.trim().length > 0) score += 3
    if (itemName && !/\(bgm\d+\)$/.test(itemName) && !/\(song\d+/i.test(itemName)) {
      score += 7
    }
    if (RELIABLE_REAL_WORLD_BGMS.has(stem)) {
      score += 4
    }
    if (/^song\d+/i.test(stem)) {
      score -= 12
    }

    // 6. 场景文本关键词微调
    if (sceneText) {
      const hay = `${itemName} ${itemDesc} ${(item.tags ?? []).join(' ')}`.toLowerCase()
      if (
        /深夜|夜晚|熬夜|疲惫|客厅|卧室|房间/.test(sceneText) &&
        /深夜|夜晚|独处|静谧|沉静/.test(hay)
      ) {
        score += 4
      }
      if (/日常|轻松|客厅|教室|咖啡|餐厅/.test(sceneText) && /日常|舒缓|平稳|客厅/.test(hay)) {
        score += 3
      }
    }

    // 7. 避免重复刚用过的曲目
    if (excludeLower.has(stem)) {
      score -= 4
    }

    const tieBetter =
      score === bestScore && (item.id ?? item.file).localeCompare(best.id ?? best.file) < 0
    if (score > bestScore || tieBetter) {
      bestScore = score
      best = item
    }
  }

  return best
}

/**
 * 守卫单个场景的 BGM 选择：合法则原样放行；违规则替换为最贴合氛围的合法曲目。
 */
export function guardSceneBgmSelection(
  view: CatalogView,
  bgmFile: string,
  sceneInput: SceneContextInput,
  options: { excludeFiles?: ReadonlySet<string> } = {}
): BgmGuardDecision {
  const trimmed = (bgmFile ?? '').trim()
  const sceneContext = detectSceneSekaiContext(sceneInput, view)

  if (!trimmed || trimmed === 'silence' || trimmed === 'keep') {
    return {
      allowed: true,
      originalFile: trimmed,
      finalFile: trimmed,
      replaced: false,
      reason: '静音或沿用上一幕BGM',
      classification: buildClassification(null, '静音/保持'),
      sceneContext
    }
  }

  const canonical = view.canonicalBgm(trimmed) ?? trimmed
  const detail =
    view
      .bgmDetailsList()
      .find(
        (d) =>
          d.file.toLowerCase() === canonical.toLowerCase() ||
          normalizeBgmStem(d.id || d.file) === normalizeBgmStem(canonical)
      ) ?? null

  const classification = classifyBgmSekaiScope(canonical, detail)
  if (isBgmAllowedInScene(canonical, sceneContext, detail)) {
    return {
      allowed: true,
      originalFile: trimmed,
      finalFile: canonical,
      replaced: false,
      reason: 'BGM与场景世界线一致',
      classification,
      sceneContext
    }
  }

  const sceneText = [
    sceneInput.placeInfo,
    sceneInput.telop,
    sceneInput.summary,
    sceneInput.promptText,
    sceneInput.dialogueText
  ]
    .filter(Boolean)
    .join(' ')

  const replacement = pickSafeReplacementBgm(view, sceneContext, {
    blockedFile: canonical,
    blockedDetail: detail,
    sceneText,
    excludeFiles: options.excludeFiles
  })

  const reason = sceneContext.isSekai
    ? `${classification.label}专属曲 ${canonical} 与当前${SEKAI_UNIT_LABELS[sceneContext.sekaiUnit ?? 'generic']}场景不匹配（${sceneContext.reason}）`
    : `${classification.label}专属曲 ${canonical} 禁止用于非SEKAI现实场景（${sceneContext.reason}）`

  return {
    allowed: false,
    originalFile: trimmed,
    finalFile: replacement?.file ?? '',
    replaced: true,
    reason,
    classification,
    sceneContext
  }
}

/**
 * 终稿级确定性守卫：遍历 StoryData 中的全部 ChangeBgm 片段，结合前后背景/PlaceInfo/SekaiIn/SekaiOut 上下文
 * 自动拦截并替换任何误用于现实场景（或跨团串台）的 SEKAI 专属 BGM。
 */
export function sanitizeStorySekaiBgms(
  story: StoryData,
  view: CatalogView,
  options: {
    promptText?: string
    logger?: { info?: (msg: string) => void; warn?: (msg: string) => void }
  } = {}
): SanitizeStoryBgmResult {
  const replaced: SekaiBgmReplacement[] = []
  const warnings: string[] = []
  if (!story || !Array.isArray(story.snippets)) {
    return { replaced, warnings }
  }

  const imageById = new Map<number, string>()
  for (const img of story.images ?? []) {
    if (typeof img.id === 'number' && typeof img.image === 'string') {
      imageById.set(img.id, img.image)
    }
  }

  let currentBg = ''
  let currentPlaceInfo = ''
  let currentTelop = ''
  let sekaiTransitionActive = false
  const usedSafeBgms = new Set<string>()

  const snippets = story.snippets
  for (let i = 0; i < snippets.length; i++) {
    const snippet = snippets[i]
    if (!snippet || typeof snippet !== 'object') continue

    if (snippet.type === 'ChangeBackgroundImage') {
      const imgPath = imageById.get(snippet.data.imageId) ?? ''
      if (imgPath) currentBg = imgPath
      continue
    }
    if (snippet.type === 'PlaceInfo') {
      currentPlaceInfo = snippet.data.text ?? ''
      continue
    }
    if (snippet.type === 'Telop') {
      currentTelop = snippet.data.content ?? ''
      continue
    }
    if (snippet.type === 'SekaiIn') {
      sekaiTransitionActive = true
      continue
    }
    if (snippet.type === 'SekaiOut') {
      sekaiTransitionActive = false
      continue
    }
    if (snippet.type !== 'ChangeBgm') continue

    const data = snippet.data
    if (data.stop || !data.file || !data.file.trim()) continue

    // 关键：开场或换幕时 ChangeBgm 常位于 ChangeBackgroundImage / PlaceInfo / SekaiIn 之前，
    // 向后前瞻直到第一条 Talk（最多 12 个非对话片段）即可准确绑定到它所服务的目标场景。
    let effectiveBg = currentBg
    let effectivePlaceInfo = currentPlaceInfo
    let effectiveTelop = currentTelop
    let effectiveSekaiActive = sekaiTransitionActive
    let effectiveTransitionIn: string | undefined

    let lookaheadBg = ''
    let lookaheadPlace = ''
    let lookaheadTelop = ''
    let lookaheadSekai: boolean | undefined
    const nearbyDialogues: string[] = []

    for (let j = i + 1; j < snippets.length && j <= i + 24; j++) {
      const next = snippets[j]
      if (!next || typeof next !== 'object') continue
      if (next.type === 'ChangeBgm') break
      if (next.type === 'Talk') {
        if (next.data.content) nearbyDialogues.push(next.data.content)
        if (nearbyDialogues.length >= 6) break
        continue
      }
      if (nearbyDialogues.length > 0) continue
      if (next.type === 'ChangeBackgroundImage' && !lookaheadBg) {
        lookaheadBg = imageById.get(next.data.imageId) ?? ''
      } else if (next.type === 'PlaceInfo' && !lookaheadPlace) {
        lookaheadPlace = next.data.text ?? ''
      } else if (next.type === 'Telop' && !lookaheadTelop) {
        lookaheadTelop = next.data.content ?? ''
      } else if (next.type === 'SekaiIn' && lookaheadSekai === undefined) {
        lookaheadSekai = true
        effectiveTransitionIn = 'sekaiIn'
      } else if (next.type === 'SekaiOut' && lookaheadSekai === undefined) {
        lookaheadSekai = false
        effectiveTransitionIn = 'sekaiOut'
      }
    }

    if (lookaheadBg) effectiveBg = lookaheadBg
    if (lookaheadPlace) effectivePlaceInfo = lookaheadPlace
    if (lookaheadTelop) effectiveTelop = lookaheadTelop
    if (lookaheadSekai !== undefined) effectiveSekaiActive = lookaheadSekai

    const decision = guardSceneBgmSelection(
      view,
      data.file,
      {
        background: effectiveBg,
        placeInfo: effectivePlaceInfo,
        telop: effectiveTelop,
        transitionIn: effectiveTransitionIn,
        sekaiTransitionActive: effectiveSekaiActive,
        promptText: options.promptText,
        dialogueText: nearbyDialogues.join(' ')
      },
      { excludeFiles: usedSafeBgms }
    )

    if (decision.allowed) {
      usedSafeBgms.add(decision.finalFile)
      continue
    }

    if (decision.finalFile) {
      data.file = decision.finalFile
      usedSafeBgms.add(decision.finalFile)
    } else {
      data.file = ''
      data.stop = true
    }

    replaced.push({
      snippetIndex: i,
      originalFile: decision.originalFile,
      replacementFile: decision.finalFile,
      reason: decision.reason,
      bgmLabel: decision.classification.label,
      sceneReason: decision.sceneContext.reason
    })

    const msg = decision.finalFile
      ? `snippets[${i}] 拦截越界BGM：${decision.reason}，已自动替换为 ${decision.finalFile}`
      : `snippets[${i}] 拦截越界BGM：${decision.reason}，因无可用替代曲已切换为静音`
    warnings.push(msg)
    options.logger?.warn?.(`[BgmGuard] ${msg}`)
  }

  return { replaced, warnings }
}
