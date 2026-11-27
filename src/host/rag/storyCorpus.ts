import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import type { PersonaEntry } from '../ai/personas'
import type { RagChunk, RagDomain, RagSourceKind } from './types'
import { computeChunkHash } from './vectorIndex'

export const PJSK_DOMAIN: RagDomain = 'pjsk'

const WINDOW_SIZE = 8
const WINDOW_STRIDE = 6
const PERSONA_CHUNK_MAX_CHARS = 1200
const PERSONA_CHUNK_HARD_CHARS = 1450
const FOREIGN_DOMAIN_MARKER = /\b(?:bdon\.moe|ournotes)\b/i

export interface LoadStoryCorpusOptions {
  localDirs?: string[]
  /** 可选直接传入的 sekai-story-search `.jsonl.br` / `.jsonl` 文件路径 */
  jsonlFiles?: string[]
  personas?: PersonaEntry[]
  /** 可选人设目录（支持递归扫描如 `虚拟歌姬/*` 子目录） */
  personaDirs?: string[]
  includePersonas?: boolean
  /** 防止单次加载过大（默认最多 80_000 条） */
  maxChunks?: number
}

interface RawSekaiChunk {
  id?: string | number
  domain?: string
  chunk_hash?: string
  story_id?: string | number
  story?: string
  ep?: string | number
  ep_title?: string
  scenario_id?: string
  type?: string
  unit?: string
  event_num?: number
  event_year?: number
  is_recent?: boolean
  lang?: 'cn' | 'jp'
  tags?: string[]
  chars?: string[]
  char_ids?: number[]
  line_start?: number
  line_end?: number
  text?: string
  jp_text?: string
}

export interface PjskCharacterLexiconEntry {
  key: string
  charIds: number[]
  cnFull: string
  cnShort: string
  jpFull: string
  jpShort: string
  jpKana: string
  romaji: string
  unit: string
  extraAliases: string[]
  /** 单字名仅在独立人称边界出现时匹配，避免中文复合词误召回 */
  singleCharStrict?: boolean
}

export const PJSK_CHARACTER_LEXICON: readonly PjskCharacterLexiconEntry[] = [
  {
    key: 'ichika',
    charIds: [1, 278],
    cnFull: '星乃一歌',
    cnShort: '一歌',
    jpFull: '星乃一歌',
    jpShort: '一歌',
    jpKana: 'いちか',
    romaji: 'ichika',
    unit: 'L/n',
    extraAliases: []
  },
  {
    key: 'saki',
    charIds: [2, 279],
    cnFull: '天马咲希',
    cnShort: '咲希',
    jpFull: '天馬咲希',
    jpShort: '咲希',
    jpKana: 'さき',
    romaji: 'saki',
    unit: 'L/n',
    extraAliases: []
  },
  {
    key: 'honami',
    charIds: [3, 280],
    cnFull: '望月穗波',
    cnShort: '穗波',
    jpFull: '望月穂波',
    jpShort: '穂波',
    jpKana: 'ほなみ',
    romaji: 'honami',
    unit: 'L/n',
    extraAliases: []
  },
  {
    key: 'shiho',
    charIds: [4, 281],
    cnFull: '日野森志步',
    cnShort: '志步',
    jpFull: '日野森志歩',
    jpShort: '志歩',
    jpKana: 'しほ',
    romaji: 'shiho',
    unit: 'L/n',
    extraAliases: []
  },
  {
    key: 'minori',
    charIds: [5, 282],
    cnFull: '花里实乃理',
    cnShort: '实乃理',
    jpFull: '花里みのり',
    jpShort: 'みのり',
    jpKana: 'みのり',
    romaji: 'minori',
    unit: 'MMJ',
    extraAliases: []
  },
  {
    key: 'haruka',
    charIds: [6, 283],
    cnFull: '桐谷遥',
    cnShort: '遥',
    jpFull: '桐谷遥',
    jpShort: '遥',
    jpKana: 'はるか',
    romaji: 'haruka',
    unit: 'MMJ',
    extraAliases: [],
    singleCharStrict: true
  },
  {
    key: 'airi',
    charIds: [7, 284],
    cnFull: '桃井爱莉',
    cnShort: '爱莉',
    jpFull: '桃井愛莉',
    jpShort: '愛莉',
    jpKana: 'あいり',
    romaji: 'airi',
    unit: 'MMJ',
    extraAliases: []
  },
  {
    key: 'shizuku',
    charIds: [8, 285],
    cnFull: '日野森雫',
    cnShort: '雫',
    jpFull: '日野森雫',
    jpShort: '雫',
    jpKana: 'しずく',
    romaji: 'shizuku',
    unit: 'MMJ',
    extraAliases: [],
    singleCharStrict: true
  },
  {
    key: 'kohane',
    charIds: [9, 286],
    cnFull: '小豆泽心羽',
    cnShort: '心羽',
    jpFull: '小豆沢こはね',
    jpShort: 'こはね',
    jpKana: 'こはね',
    romaji: 'kohane',
    unit: 'VBS',
    extraAliases: []
  },
  {
    key: 'an',
    charIds: [10, 287],
    cnFull: '白石杏',
    cnShort: '杏',
    jpFull: '白石杏',
    jpShort: '杏',
    jpKana: 'あん',
    romaji: 'an',
    unit: 'VBS',
    extraAliases: [],
    singleCharStrict: true
  },
  {
    key: 'akito',
    charIds: [11, 288],
    cnFull: '东云彰人',
    cnShort: '彰人',
    jpFull: '東雲彰人',
    jpShort: '彰人',
    jpKana: 'あきと',
    romaji: 'akito',
    unit: 'VBS',
    extraAliases: ['弟弟君']
  },
  {
    key: 'toya',
    charIds: [12, 289],
    cnFull: '青柳冬弥',
    cnShort: '冬弥',
    jpFull: '青柳冬弥',
    jpShort: '冬彌',
    jpKana: 'とうや',
    romaji: 'toya',
    unit: 'VBS',
    extraAliases: ['touya']
  },
  {
    key: 'tsukasa',
    charIds: [13, 290],
    cnFull: '天马司',
    cnShort: '司',
    jpFull: '天馬司',
    jpShort: '司',
    jpKana: 'つかさ',
    romaji: 'tsukasa',
    unit: 'WS',
    extraAliases: ['司前辈'],
    singleCharStrict: true
  },
  {
    key: 'emu',
    charIds: [14, 291],
    cnFull: '凤笑梦',
    cnShort: '笑梦',
    jpFull: '鳳えむ',
    jpShort: 'えむ',
    jpKana: 'えむ',
    romaji: 'emu',
    unit: 'WS',
    extraAliases: ['小梦']
  },
  {
    key: 'nene',
    charIds: [15, 292],
    cnFull: '草薙宁宁',
    cnShort: '宁宁',
    jpFull: '草薙寧々',
    jpShort: '寧々',
    jpKana: 'ねね',
    romaji: 'nene',
    unit: 'WS',
    extraAliases: ['小宁宁', '草薙同学']
  },
  {
    key: 'rui',
    charIds: [16, 293],
    cnFull: '神代类',
    cnShort: '类',
    jpFull: '神代類',
    jpShort: '類',
    jpKana: 'るい',
    romaji: 'rui',
    unit: 'WS',
    extraAliases: [],
    singleCharStrict: true
  },
  {
    key: 'kanade',
    charIds: [17, 294],
    cnFull: '宵崎奏',
    cnShort: '奏',
    jpFull: '宵崎奏',
    jpShort: '奏',
    jpKana: 'かなで',
    romaji: 'kanade',
    unit: '25时',
    extraAliases: [],
    singleCharStrict: true
  },
  {
    key: 'mafuyu',
    charIds: [18, 295],
    cnFull: '朝比奈真冬',
    cnShort: '真冬',
    jpFull: '朝比奈まふゆ',
    jpShort: 'まふゆ',
    jpKana: 'まふゆ',
    romaji: 'mafuyu',
    unit: '25时',
    extraAliases: []
  },
  {
    key: 'ena',
    charIds: [19, 296],
    cnFull: '东云绘名',
    cnShort: '绘名',
    jpFull: '東雲絵名',
    jpShort: '絵名',
    jpKana: 'えな',
    romaji: 'ena',
    unit: '25时',
    extraAliases: ['绘绘', '绘名名', 'えななん']
  },
  {
    key: 'mizuki',
    charIds: [20, 297],
    cnFull: '晓山瑞希',
    cnShort: '瑞希',
    jpFull: '暁山瑞希',
    jpShort: '瑞希',
    jpKana: 'みずき',
    romaji: 'mizuki',
    unit: '25时',
    extraAliases: ['amia']
  },
  {
    key: 'miku',
    charIds: [21, 22, 23, 24, 25, 26, 298, 299, 300, 301, 302, 303],
    cnFull: '初音未来',
    cnShort: '未来',
    jpFull: '初音ミク',
    jpShort: 'ミク',
    jpKana: 'みく',
    romaji: 'miku',
    unit: 'VS',
    extraAliases: ['初音'],
    singleCharStrict: true
  },
  {
    key: 'rin',
    charIds: [27, 304, 305, 306, 307, 308, 309],
    cnFull: '镜音铃',
    cnShort: '铃',
    jpFull: '鏡音リン',
    jpShort: 'リン',
    jpKana: 'りん',
    romaji: 'rin',
    unit: 'VS',
    extraAliases: [],
    singleCharStrict: true
  },
  {
    key: 'len',
    charIds: [28, 310, 311, 312, 313, 314, 315],
    cnFull: '镜音连',
    cnShort: '连',
    jpFull: '鏡音レン',
    jpShort: 'レン',
    jpKana: 'れん',
    romaji: 'len',
    unit: 'VS',
    extraAliases: [],
    singleCharStrict: true
  },
  {
    key: 'luka',
    charIds: [29, 316, 317, 318, 319, 320, 321],
    cnFull: '巡音流歌',
    cnShort: '流歌',
    jpFull: '巡音ルカ',
    jpShort: 'ルカ',
    jpKana: 'るか',
    romaji: 'luka',
    unit: 'VS',
    extraAliases: []
  },
  {
    key: 'meiko',
    charIds: [30, 322, 323, 324, 325, 326, 327],
    cnFull: 'MEIKO',
    cnShort: 'MEIKO',
    jpFull: 'MEIKO',
    jpShort: 'MEIKO',
    jpKana: 'めいこ',
    romaji: 'meiko',
    unit: 'VS',
    extraAliases: []
  },
  {
    key: 'kaito',
    charIds: [31, 328, 329, 330, 331, 332, 333],
    cnFull: 'KAITO',
    cnShort: 'KAITO',
    jpFull: 'KAITO',
    jpShort: 'KAITO',
    jpKana: 'かいと',
    romaji: 'kaito',
    unit: 'VS',
    extraAliases: []
  }
]

export interface PjskUnitLexiconEntry {
  key: string
  label: string
  codes: string[]
  sekaiName: string
  cnAliases: string[]
  jpAliases: string[]
  enAliases: string[]
}

export const PJSK_UNIT_LEXICON: readonly PjskUnitLexiconEntry[] = [
  {
    key: 'n25',
    label: '25时',
    codes: ['school_refusal', 'night', 'nightcode', '25时_nightcord'],
    sekaiName: '无人的世界',
    cnAliases: ['25时', '25点', '无人世界', '无人的世界', '25点，nightcord见'],
    jpAliases: ['25時', 'ニーゴ', '誰もいないセカイ'],
    enAliases: ['nightcord', 'n25']
  },
  {
    key: 'ws',
    label: 'WS',
    codes: ['theme_park', 'wonder', 'wonderlands_showtime'],
    sekaiName: '奇幻的世界',
    cnAliases: ['奇幻乐园', '奇幻的世界', '奇幻舞台', '奇幻乐园「世界」'],
    jpAliases: ['ワンダショ', 'ワンダーランズ', 'ワンダーランドのセカイ'],
    enAliases: ['wxs', 'wonderlands', 'showtime', 'ws']
  },
  {
    key: 'vbs',
    label: 'VBS',
    codes: ['street', 'vivid_bad_squad'],
    sekaiName: '街头的世界',
    cnAliases: ['街头世界', '街头的世界', '街头「世界」'],
    jpAliases: ['ビビバス', 'ストリートのセカイ'],
    enAliases: ['vbs', 'vivid bad squad']
  },
  {
    key: 'mmj',
    label: 'MMJ',
    codes: ['idol', 'more_more_jump'],
    sekaiName: '舞台的世界',
    cnAliases: ['舞台世界', '舞台的世界', '舞台「世界」'],
    jpAliases: ['モモジャン', 'ステージのセカイ'],
    enAliases: ['mmj', 'more more jump']
  },
  {
    key: 'ln',
    label: 'L/n',
    codes: ['light_sound', 'leo', 'leo_need'],
    sekaiName: '教室的世界',
    cnAliases: ['教室世界', '教室的世界', '教室「世界」'],
    jpAliases: ['レオニ', '教室のセカイ'],
    enAliases: ['leo/need', 'leoneed', 'l/n']
  },
  {
    key: 'vs',
    label: 'VS',
    codes: ['piapro'],
    sekaiName: '虚拟歌手',
    cnAliases: ['虚拟歌手', '虚拟歌姬'],
    jpAliases: ['バーチャルシンガー', 'ピアプロ'],
    enAliases: ['virtual singer', 'piapro']
  }
]

const PJSK_DOMAIN_SYNONYMS: ReadonlyArray<{
  token: string
  terms: string[]
  jpBridge: string
}> = [
  {
    token: 'kw:school_festival',
    terms: ['文化祭', '文化节', '学園祭', '学园祭'],
    jpBridge: '学園祭'
  },
  { token: 'kw:rooftop', terms: ['天台', '屋上'], jpBridge: '屋上' },
  { token: 'kw:sekai', terms: ['世界', 'セカイ', 'sekai'], jpBridge: 'セカイ' },
  { token: 'kw:kamiyama', terms: ['神山高校', '神高'], jpBridge: '神山高校' },
  { token: 'kw:miyamasuzaka', terms: ['宫益坂', '宮益坂', '宫女', '宮女'], jpBridge: '宮益坂' },
  {
    token: 'kw:phoenix',
    terms: ['凤凰乐园', 'フェニックスワンダーランド', '奇幻舞台', 'ワンダーステージ'],
    jpBridge: 'フェニックスワンダーランド'
  },
  { token: 'kw:famires', terms: ['家庭餐厅', 'ファミレス'], jpBridge: 'ファミレス' },
  { token: 'kw:stage_live', terms: ['演出', '公演', 'ライブ', '演唱会'], jpBridge: 'ライブ' },
  { token: 'kw:rehearsal', terms: ['排练', '练习', '練習', 'リハーサル'], jpBridge: '練習' },
  { token: 'kw:confession', terms: ['心结', '秘密', '坦白', '打ち明ける'], jpBridge: '秘密' },
  { token: 'kw:memory', terms: ['回忆', '过去', '過去'], jpBridge: '過去' },
  { token: 'kw:fashion', terms: ['服装', '裁缝', '衣装', '衣服'], jpBridge: '衣装' }
]

const CHAR_BY_ID = new Map<number, PjskCharacterLexiconEntry>()
const CHAR_BY_KEY = new Map<string, PjskCharacterLexiconEntry>()
for (const entry of PJSK_CHARACTER_LEXICON) {
  CHAR_BY_KEY.set(entry.key, entry)
  for (const cid of entry.charIds) CHAR_BY_ID.set(cid, entry)
}

/** 21..26 / 298..303 等虚拟歌手分组合 ID -> 组合标签 */
function resolveVsUnitByCharId(charId: number): string {
  if (
    charId === 22 ||
    charId === 299 ||
    charId === 305 ||
    charId === 311 ||
    charId === 317 ||
    charId === 323 ||
    charId === 329
  )
    return 'L/n'
  if (
    charId === 23 ||
    charId === 300 ||
    charId === 306 ||
    charId === 312 ||
    charId === 318 ||
    charId === 324 ||
    charId === 330
  )
    return 'MMJ'
  if (
    charId === 24 ||
    charId === 301 ||
    charId === 307 ||
    charId === 313 ||
    charId === 319 ||
    charId === 325 ||
    charId === 331
  )
    return 'VBS'
  if (
    charId === 25 ||
    charId === 302 ||
    charId === 308 ||
    charId === 314 ||
    charId === 320 ||
    charId === 326 ||
    charId === 332
  )
    return 'WS'
  if (
    charId === 26 ||
    charId === 303 ||
    charId === 309 ||
    charId === 315 ||
    charId === 321 ||
    charId === 327 ||
    charId === 333
  )
    return '25时'
  return ''
}

export function resolveUnitLabel(raw: string): string {
  const clean = raw.trim().toLowerCase()
  if (!clean) return ''
  if (clean === 'none') return '混活'
  for (const unit of PJSK_UNIT_LEXICON) {
    if (unit.codes.some((c) => clean === c || clean.includes(c))) return unit.label
    if (unit.cnAliases.some((a) => clean.includes(a.toLowerCase()))) return unit.label
    if (unit.jpAliases.some((a) => clean.includes(a.toLowerCase()))) return unit.label
    if (unit.enAliases.some((a) => clean === a.toLowerCase())) return unit.label
  }
  return ''
}

export function resolveCharIdToCnName(charId: number): string {
  const entry = CHAR_BY_ID.get(charId)
  if (!entry) return ''
  if (entry.unit === 'VS') {
    const vsUnit = resolveVsUnitByCharId(charId)
    return vsUnit ? `${vsUnit}${entry.cnFull}` : entry.cnFull
  }
  return entry.cnFull
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const SINGLE_CHAR_GUARDS: Record<string, RegExp> = {
  奏: /(?<![演节伴前间尾合独重齐协变弹吹拉])奏(?![响鸣曲乐章折])/u,
  类: /(?<![人分种同此归异品大小各另这那其门细科属族词句肉鸟鱼兽藻菌])类(?![似型别比目聚属群])/u,
  司: /(?<![公上有祭主分总官大法百三都巡土])司(?![法机令仪空徒马库长员])/u,
  杏: /(?<![银青红白黄甜酸苦大山野])杏(?![仁花树子林黄红干酱脯])/u,
  遥: /(?<![逍动路])遥(?![远望想控测感指不相无])/u,
  雫: /雫/u,
  铃: /(?<![风门车电铜银金摇哑杠响闹警])铃(?![声铛兰木薯])/u,
  连: /(?<![相接牵粘勾毗串大一二三])连(?![续接线贯载忙夜日天年带锁同环绵任胜败])/u
}

function hasSingleCharBoundary(lowerText: string, ch: string): boolean {
  const esc = escapeRegExp(ch.toLowerCase())
  const strictRe = new RegExp(
    `(?:^|[\\s:：,，、|/·「」【】\\[\\]()（）和与跟对向叫找问看替陪帮给让被把])${esc}(?:$|前辈|君|小姐|同学|桑|さん|ちゃん|也|都|的|在|说|笑|问|看|吗|呢|吧|啊|[\\s:：,，、|/·「」【】\\[\\]()（）])`,
    'u'
  )
  if (strictRe.test(lowerText)) {
    const guard = SINGLE_CHAR_GUARDS[ch]
    return guard ? guard.test(lowerText) : true
  }
  return false
}

export interface CanonicalEntityExtraction {
  tokens: string[]
  bridgeTerms: string[]
  charKeys: string[]
  unitKeys: string[]
}

/**
 * 跨语种 PJSK 实体归一化：把中文/日文/罗马音角色名、组合名与关键世界观词汇
 * 统一映射为规范 token（`char:mizuki` / `unit:n25` / `kw:school_festival`）及跨语种扩展词。
 */
export function extractCanonicalEntityTokens(text: string): CanonicalEntityExtraction {
  const raw = String(text ?? '')
  const lower = raw.toLowerCase()
  const tokens = new Set<string>()
  const bridgeTerms = new Set<string>()
  const charKeys = new Set<string>()
  const unitKeys = new Set<string>()

  if (!lower.trim()) {
    return { tokens: [], bridgeTerms: [], charKeys: [], unitKeys: [] }
  }

  for (const ch of PJSK_CHARACTER_LEXICON) {
    const multiTerms = [
      ch.cnFull,
      ch.jpFull,
      ch.jpKana,
      ch.romaji,
      ...ch.extraAliases,
      ...(ch.singleCharStrict ? [] : [ch.cnShort, ch.jpShort])
    ].filter((t) => t && t.length >= 2)

    let matched = multiTerms.some((term) => {
      const t = term.toLowerCase()
      if (/^[a-z0-9_]+$/.test(t)) {
        return new RegExp(`(?<![a-z0-9])${escapeRegExp(t)}(?![a-z0-9])`, 'i').test(lower)
      }
      return lower.includes(t)
    })

    if (!matched && ch.singleCharStrict) {
      matched =
        hasSingleCharBoundary(lower, ch.cnShort) ||
        (ch.jpShort !== ch.cnShort && hasSingleCharBoundary(lower, ch.jpShort))
    }

    if (matched) {
      charKeys.add(ch.key)
      tokens.add(`char:${ch.key}`)
      bridgeTerms.add(ch.jpFull)
      if (ch.jpShort && ch.jpShort !== ch.jpFull) bridgeTerms.add(ch.jpShort)
    }
  }

  for (const unit of PJSK_UNIT_LEXICON) {
    const allTerms = [...unit.cnAliases, ...unit.jpAliases, ...unit.enAliases, ...unit.codes]
    const matched = allTerms.some((term) => {
      const t = term.toLowerCase()
      if (/^[a-z0-9/_-]+$/.test(t)) {
        return new RegExp(`(?<![a-z0-9])${escapeRegExp(t)}(?![a-z0-9])`, 'i').test(lower)
      }
      return lower.includes(t)
    })
    if (matched) {
      unitKeys.add(unit.key)
      tokens.add(`unit:${unit.key}`)
      if (unit.jpAliases[0]) bridgeTerms.add(unit.jpAliases[0])
      if (unit.jpAliases[1]) bridgeTerms.add(unit.jpAliases[1])
    }
  }

  for (const syn of PJSK_DOMAIN_SYNONYMS) {
    if (syn.terms.some((term) => lower.includes(term.toLowerCase()))) {
      tokens.add(syn.token)
      bridgeTerms.add(syn.jpBridge)
    }
  }

  return {
    tokens: [...tokens],
    bridgeTerms: [...bridgeTerms],
    charKeys: [...charKeys],
    unitKeys: [...unitKeys]
  }
}

export function resolveCharKeysFromHint(hint: {
  name?: string
  fullName?: string
  aliases?: string[]
  charId?: number
}): string[] {
  const keys = new Set<string>()
  if (typeof hint.charId === 'number') {
    const byId = CHAR_BY_ID.get(hint.charId)
    if (byId) keys.add(byId.key)
  }
  const combined = [hint.name, hint.fullName, ...(hint.aliases ?? [])]
    .filter((s): s is string => Boolean(s && s.trim()))
    .map((s) => s.trim())
  for (const name of combined) {
    const lower = name.toLowerCase()
    for (const entry of PJSK_CHARACTER_LEXICON) {
      const candidates = [
        entry.cnFull,
        entry.cnShort,
        entry.jpFull,
        entry.jpShort,
        entry.jpKana,
        entry.romaji,
        ...entry.extraAliases
      ]
      if (
        candidates.some(
          (c) =>
            c && (lower === c.toLowerCase() || (c.length >= 2 && lower.includes(c.toLowerCase())))
        )
      ) {
        keys.add(entry.key)
      }
    }
  }
  return [...keys]
}

/**
 * 严格 PJSK 领域隔离守卫：拒绝 Ournotes / BanG Dream 语料与 schema。
 * 命中以下任一条件即视为跨领域污染并拒绝加载：
 * - `domain` 字段非空且不为 `'pjsk'`；
 * - 文件路径或内容元数据包含 `bdon.moe` / `ournotes`；
 * - Ournotes `episode.json` 结构（`commands[]` 含 `AdvTextID`/`TargetName`）或站点 manifest（`files['episode.json']`）。
 */
export function isForeignOurnotesPayload(doc: unknown, filePath = ''): boolean {
  if (filePath && FOREIGN_DOMAIN_MARKER.test(filePath)) return true
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false
  const record = doc as Record<string, unknown>

  if (typeof record.domain === 'string' && record.domain.trim()) {
    if (record.domain.trim().toLowerCase() !== PJSK_DOMAIN) return true
  }

  // Ournotes site manifest: { advId, files: { "episode.json": ... } }
  if (record.files && typeof record.files === 'object' && !Array.isArray(record.files)) {
    const files = record.files as Record<string, unknown>
    if ('episode.json' in files) return true
  }

  // Ournotes episode.json: { commands: [{ AdvTextID, TargetName, ... }] }
  if (Array.isArray(record.commands)) {
    const sample = record.commands.slice(0, 20)
    if (
      sample.some(
        (cmd) =>
          cmd &&
          typeof cmd === 'object' &&
          ('AdvTextID' in (cmd as Record<string, unknown>) ||
            'TargetName' in (cmd as Record<string, unknown>))
      )
    ) {
      return true
    }
  }

  if (typeof record.story === 'string' && FOREIGN_DOMAIN_MARKER.test(record.story)) return true
  if (typeof record.scenario_id === 'string' && FOREIGN_DOMAIN_MARKER.test(record.scenario_id)) {
    return true
  }
  return false
}

function sourceKindForType(type: string): RagSourceKind {
  const normalized = type.trim().toLowerCase()
  if (normalized === 'talk' || normalized === 'actionset' || normalized === 'area') {
    return 'dialogue_voice'
  }
  if (normalized === 'persona' || normalized === 'lore' || normalized === 'worldview') {
    return 'worldview_lore'
  }
  return 'canon_story'
}

/** 解析 sekai-story-search 格式的 `.jsonl` 或 `.jsonl.br` 缓冲区（严格执行 PJSK 领域隔离）。 */
export function parseSekaiJsonlBuffer(buf: Buffer, isBrotli = false, filePath = ''): RagChunk[] {
  if (filePath && FOREIGN_DOMAIN_MARKER.test(filePath)) return []
  const rawBuf = isBrotli ? zlib.brotliDecompressSync(buf) : buf
  const content = rawBuf.toString('utf8')
  const chunks: RagChunk[] = []
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed) as RawSekaiChunk
      if (isForeignOurnotesPayload(obj, filePath)) continue
      const text = typeof obj.text === 'string' ? obj.text.trim() : ''
      if (!text) continue
      const type = String(obj.type ?? 'event').trim() || 'event'
      const story = String(obj.story ?? obj.scenario_id ?? 'story').trim()
      const storyId = String(obj.story_id ?? obj.scenario_id ?? story).trim()
      const scenarioId = String(obj.scenario_id ?? storyId).trim()
      const chunkHash =
        typeof obj.chunk_hash === 'string' && obj.chunk_hash.trim()
          ? obj.chunk_hash.trim()
          : computeChunkHash(text)
      const id =
        obj.id !== undefined && obj.id !== null ? String(obj.id) : `${scenarioId}:${chunks.length}`
      const chars = Array.isArray(obj.chars)
        ? obj.chars.map((c) => String(c).trim()).filter(Boolean)
        : []
      const charIds = Array.isArray(obj.char_ids)
        ? obj.char_ids.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
        : undefined
      const eventNum =
        typeof obj.event_num === 'number' && Number.isFinite(obj.event_num)
          ? obj.event_num
          : inferEventNumFromIds(storyId, scenarioId)
      const eventYear =
        typeof obj.event_year === 'number' && Number.isFinite(obj.event_year)
          ? obj.event_year
          : inferYearFromText(storyId, scenarioId)
      const isRecent =
        typeof obj.is_recent === 'boolean'
          ? obj.is_recent
          : isRecentEvent(eventNum, eventYear, filePath)
      const lang: 'cn' | 'jp' =
        obj.lang ??
        (/[\u3040-\u30ff]/.test(text) && !/[\u4e00-\u9fff]{6,}/.test(text) ? 'jp' : 'cn')
      chunks.push({
        id,
        domain: PJSK_DOMAIN,
        chunkHash,
        sourceKind: sourceKindForType(type),
        storyId,
        story,
        ep: obj.ep !== undefined ? String(obj.ep) : undefined,
        ...(typeof obj.ep_title === 'string' && obj.ep_title.trim()
          ? { epTitle: obj.ep_title.trim() }
          : {}),
        scenarioId,
        type,
        ...(typeof obj.unit === 'string' && obj.unit.trim() ? { unit: obj.unit.trim() } : {}),
        ...(eventNum !== undefined ? { eventNum } : {}),
        ...(eventYear !== undefined ? { eventYear } : {}),
        ...(isRecent ? { isRecent2025_2026: true } : {}),
        lang,
        ...(Array.isArray(obj.tags) && obj.tags.length > 0 ? { tags: obj.tags } : {}),
        chars,
        charIds,
        lineStart: typeof obj.line_start === 'number' ? obj.line_start : 0,
        lineEnd: typeof obj.line_end === 'number' ? obj.line_end : 0,
        text,
        ...(typeof obj.jp_text === 'string' && obj.jp_text.trim()
          ? { jpText: obj.jp_text.trim() }
          : {})
      })
    } catch {
      // 跳过损坏行
    }
  }
  return chunks
}

interface TalkLine {
  speaker: string
  cnSpeaker?: string
  body: string
  charId?: number
  cues: string[]
  location?: string
}

function extractTalkLinesFromJson(doc: unknown): TalkLine[] {
  if (!doc || typeof doc !== 'object') return []
  if (isForeignOurnotesPayload(doc)) return []
  const record = doc as Record<string, unknown>
  const lines: TalkLine[] = []

  // 格式 A：PJSK 官方剧情 JSON（Snippets + TalkData + SpecialEffectData + SoundData）
  if (Array.isArray(record.Snippets) && Array.isArray(record.TalkData)) {
    const talkData = record.TalkData as Array<Record<string, unknown>>
    const effects = Array.isArray(record.SpecialEffectData)
      ? (record.SpecialEffectData as Array<Record<string, unknown>>)
      : []
    const sounds = Array.isArray(record.SoundData)
      ? (record.SoundData as Array<Record<string, unknown>>)
      : []

    const pendingCues = new Set<string>()
    let pendingLocation = ''

    for (const snip of record.Snippets as Array<Record<string, unknown>>) {
      const action = Number(snip?.Action)
      const refIdx = typeof snip?.ReferenceIndex === 'number' ? snip.ReferenceIndex : -1
      const delay = typeof snip?.Delay === 'number' ? snip.Delay : 0

      if (action === 6 && refIdx >= 0 && effects[refIdx]) {
        const eff = effects[refIdx]
        const effType = Number(eff.EffectType)
        if (effType === 2 || effType === 4) pendingCues.add('BlackOut')
        else if (effType === 9) pendingCues.add('Flashback')
        else if (effType === 5 || effType === 6) pendingCues.add('Shake')
        else if (effType === 43) pendingCues.add('Zoom')
        else if ((effType === 8 || effType === 18) && typeof eff.StringVal === 'string') {
          const loc = eff.StringVal.trim()
          if (loc) pendingLocation = loc
        }
        if (delay >= 0.8) pendingCues.add('Wait')
        continue
      }

      if (action === 7 && refIdx >= 0 && sounds[refIdx]) {
        const se = typeof sounds[refIdx].Se === 'string' ? sounds[refIdx].Se.trim() : ''
        if (se) pendingCues.add('SE')
        if (delay >= 0.8) pendingCues.add('Wait')
        continue
      }

      if (action !== 1) continue
      const talk = talkData[refIdx]
      if (!talk) continue
      const body = String(talk.Body ?? '')
        .replace(/\r?\n+/g, ' ')
        .trim()
      if (!body) continue
      if (delay >= 0.8) pendingCues.add('Wait')

      const speaker = String(talk.WindowDisplayName ?? '').trim() || '旁白'
      const talkChars = Array.isArray(talk.TalkCharacters)
        ? (talk.TalkCharacters as Array<Record<string, unknown>>)
        : []
      const charId =
        typeof talkChars[0]?.Character2dId === 'number'
          ? (talkChars[0].Character2dId as number)
          : undefined
      const cnSpeaker =
        typeof charId === 'number' && charId > 0 ? resolveCharIdToCnName(charId) : ''

      lines.push({
        speaker,
        ...(cnSpeaker ? { cnSpeaker } : {}),
        body,
        charId,
        cues: [...pendingCues],
        ...(pendingLocation ? { location: pendingLocation } : {})
      })
      pendingCues.clear()
      pendingLocation = ''
    }
    return lines
  }

  // 格式 B：MSST `.sekai-story.json`（snippets[{ type: 'Talk', data: { speaker, content } }]）
  if (Array.isArray(record.snippets)) {
    const pendingCues = new Set<string>()
    let pendingLocation = ''
    for (const snip of record.snippets as Array<Record<string, unknown>>) {
      const stype = String(snip?.type ?? '')
      const data =
        snip?.data && typeof snip.data === 'object' ? (snip.data as Record<string, unknown>) : null
      if (stype === 'BlackOut') {
        pendingCues.add('BlackOut')
        continue
      }
      if (stype === 'FlashbackIn') {
        pendingCues.add('Flashback')
        continue
      }
      if (stype === 'PlaySe') {
        pendingCues.add('SE')
        continue
      }
      if (stype === 'Wait') {
        pendingCues.add('Wait')
        continue
      }
      if ((stype === 'PlaceInfo' || stype === 'Telop') && data) {
        const loc = String(data.text ?? data.content ?? '').trim()
        if (loc) pendingLocation = loc
        continue
      }
      if (stype !== 'Talk' || !data) continue
      const body = String(data.content ?? '')
        .replace(/\r?\n+/g, ' ')
        .trim()
      if (!body) continue
      const speaker = String(data.speaker ?? '').trim() || '旁白'
      lines.push({
        speaker,
        body,
        cues: [...pendingCues],
        ...(pendingLocation ? { location: pendingLocation } : {})
      })
      pendingCues.clear()
      pendingLocation = ''
    }
  }
  return lines
}

export interface ChunkScenarioMeta {
  storyId: string
  story: string
  scenarioId: string
  type: string
  ep?: string
  epTitle?: string
  unit?: string
  eventNum?: number
  eventYear?: number
  isRecent2025_2026?: boolean
  lang?: 'cn' | 'jp'
}

/**
 * 将单份 PJSK 官方剧情 JSON 切分为 8 行滑窗（步长 6，2 行重叠），与 sekai-story-search 对齐，
 * 并注入规范化的活动/章节/组合/年份/角色与轻量演出提示词头。
 */
export function chunkPjskScenario(doc: unknown, meta: ChunkScenarioMeta): RagChunk[] {
  if (isForeignOurnotesPayload(doc)) return []
  const lines = extractTalkLinesFromJson(doc)
  if (lines.length === 0) return []

  const allTextSample = lines
    .slice(0, 12)
    .map((l) => l.body)
    .join(' ')
  const detectedLang: 'cn' | 'jp' =
    meta.lang ??
    (/[\u3040-\u30ff]/.test(allTextSample) && !/[\u4e00-\u9fff]{6,}/.test(allTextSample)
      ? 'jp'
      : 'cn')

  const chunks: RagChunk[] = []
  const sourceKind = sourceKindForType(meta.type)
  for (let start = 0; start < lines.length; start += WINDOW_STRIDE) {
    const end = Math.min(lines.length, start + WINDOW_SIZE)
    const slice = lines.slice(start, end)
    if (slice.length === 0) break

    const charSet = new Set<string>()
    const charIdSet = new Set<number>()
    const cueSet = new Set<string>()
    let windowLocation = ''

    for (const line of slice) {
      if (line.cnSpeaker) charSet.add(line.cnSpeaker)
      if (line.speaker && line.speaker !== '旁白') {
        // 对日文原句或已规范化的角色，补充对应中文名以便跨语种命中
        if (!line.cnSpeaker || line.speaker !== line.cnSpeaker) {
          charSet.add(line.speaker)
        }
      }
      if (typeof line.charId === 'number' && line.charId > 0) charIdSet.add(line.charId)
      for (const c of line.cues) cueSet.add(c)
      if (line.location && !windowLocation) windowLocation = line.location
    }

    const chars = [...charSet]
    const epTag = meta.ep
      ? ` 第${meta.ep}话${meta.epTitle ? `「${meta.epTitle}」` : ''}`
      : meta.epTitle
        ? ` · ${meta.epTitle}`
        : ''
    const typePrefix = meta.type === 'event' ? '活动: ' : meta.type === 'talk' ? '日常对话: ' : ''
    const headerParts = [`${typePrefix}${meta.story}${epTag}`]
    if (meta.unit) headerParts.push(meta.unit)
    if (meta.eventYear) headerParts.push(String(meta.eventYear))
    if (chars.length > 0) headerParts.push(chars.join(', '))
    if (windowLocation) headerParts.push(`场景:${windowLocation}`)
    if (cueSet.size > 0) headerParts.push(`演出:${[...cueSet].map((c) => `[${c}]`).join('')}`)

    const header = `[${headerParts.join(' | ')}]`
    const body = slice.map((l) => `${l.speaker}: ${l.body}`).join('\n')
    const text = `${header}\n${body}`

    const tags = [...cueSet]
    chunks.push({
      id: `${meta.scenarioId}:${start}-${end - 1}`,
      domain: PJSK_DOMAIN,
      chunkHash: computeChunkHash(text),
      sourceKind,
      storyId: meta.storyId,
      story: meta.story,
      ep: meta.ep,
      ...(meta.epTitle ? { epTitle: meta.epTitle } : {}),
      scenarioId: meta.scenarioId,
      type: meta.type,
      ...(meta.unit ? { unit: meta.unit } : {}),
      ...(meta.eventNum !== undefined ? { eventNum: meta.eventNum } : {}),
      ...(meta.eventYear !== undefined ? { eventYear: meta.eventYear } : {}),
      ...(meta.isRecent2025_2026 ? { isRecent2025_2026: true } : {}),
      lang: detectedLang,
      ...(tags.length > 0 ? { tags } : {}),
      chars,
      ...(charIdSet.size > 0 ? { charIds: [...charIdSet] } : {}),
      lineStart: start,
      lineEnd: end - 1,
      text
    })
    if (end >= lines.length) break
  }
  return chunks
}

const SKIP_PERSONA_HEADING = /(?:安全与防御协议|身份防御|注入防御|核心禁忌)/
const SKIP_PERSONA_BULLET =
  /^\s*-\s*(?:特殊输入处理|IF-THEN|等待启动|向真人学习|有来有回|拒绝重复|打字聊天感|长度控制|格式限制|隐私保护|严禁在输出中使用)/i

interface PersonaIdentity {
  canonicalName: string
  displayName: string
  baseName: string
  unit: string
  sekaiName: string
  chars: string[]
}

function resolvePersonaIdentity(persona: PersonaEntry): PersonaIdentity {
  const h1Match = /^#\s+(.+?)\s*$/m.exec(persona.prompt ?? '')
  const h1 = h1Match ? h1Match[1].trim() : ''
  const probe = `${persona.name} ${persona.group} ${persona.source} ${h1}`

  let unit = resolveUnitLabel(persona.group) || resolveUnitLabel(probe)
  let sekaiName = ''
  const sekaiMatch = /[（(]([^（）()]*世界[^（）()]*)[）)]/.exec(h1)
  if (sekaiMatch) {
    sekaiName = sekaiMatch[1].trim()
    if (!unit) unit = resolveUnitLabel(sekaiName)
  }

  // 识别虚拟歌手并按所属世界区分（如 25时初音未来 vs WS初音未来）
  const vsNames = ['初音未来', '镜音铃', '镜音连', '巡音流歌', 'MEIKO', 'KAITO']
  const baseVs = vsNames.find(
    (v) =>
      persona.name.includes(v) ||
      h1.includes(v) ||
      (v === '初音未来' && persona.name.includes('初音'))
  )

  let canonicalName = persona.name.trim()
  let displayName = canonicalName
  let baseName = canonicalName

  if (baseVs) {
    baseName = baseVs
    const cleanUnitPrefix = unit === 'L/n' ? 'LN' : unit
    if (unit && unit !== 'VS') {
      canonicalName =
        canonicalName.startsWith(cleanUnitPrefix) || canonicalName.startsWith(unit)
          ? canonicalName
          : `${cleanUnitPrefix}${baseVs}`
      displayName = sekaiName ? `${canonicalName}（${sekaiName}）` : canonicalName
    } else if (sekaiName) {
      displayName = `${canonicalName}（${sekaiName}）`
    }
  } else {
    const matchedChar = PJSK_CHARACTER_LEXICON.find(
      (c) => c.cnFull === persona.name || c.cnShort === persona.name
    )
    if (matchedChar && !unit && matchedChar.unit !== 'VS') {
      unit = matchedChar.unit
    }
  }

  const charSet = new Set<string>([canonicalName, baseName, ...(persona.aliases ?? [])])
  if (unit && unit !== 'VS') charSet.add(unit)
  if (sekaiName) charSet.add(sekaiName)

  return {
    canonicalName,
    displayName,
    baseName,
    unit,
    sekaiName,
    chars: [...charSet].map((s) => s.trim()).filter(Boolean)
  }
}

/** 清理单节人设文本中的聊天机器人模板/IF-THEN 样板，保留人设、记忆、关系、语气与伙伴困境。 */
function cleanPersonaSectionBody(rawSection: string): string {
  const lines = rawSection.split('\n')
  const kept: string[] = []
  let skippingIndentedSubtree = false
  let baseIndent = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      if (!skippingIndentedSubtree) kept.push('')
      continue
    }
    const indent = line.length - line.trimStart().length

    if (skippingIndentedSubtree) {
      if (indent > baseIndent || /^\s*-\s*IF\s+/i.test(line)) {
        continue
      }
      skippingIndentedSubtree = false
    }

    if (SKIP_PERSONA_BULLET.test(line) || /^\s*-\s*IF\s+/i.test(line)) {
      skippingIndentedSubtree = true
      baseIndent = indent
      continue
    }

    // 剥离单句 AI 扮演免责声明，保留真实人设描述
    const cleanedLine = line
      .replace(/你不是AI，也不是在[“"]扮演[”"]谁——?/g, '')
      .replace(/你不会跳出角色去解释自己，也不会承认这是一场扮演。?/g, '')
      .replace(/严禁在输出中使用任何形式的换行[^。]*。?/g, '')
    if (cleanedLine.trim()) kept.push(cleanedLine)
  }

  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function splitAtSentenceBoundary(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text]
  const parts: string[] = []
  let remaining = text.trim()
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars)
    const cut = Math.max(
      window.lastIndexOf('\n'),
      window.lastIndexOf('。'),
      window.lastIndexOf('！'),
      window.lastIndexOf('？')
    )
    const splitAt = cut > maxChars * 0.45 ? cut + 1 : maxChars
    parts.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trim()
  }
  if (remaining) parts.push(remaining)
  return parts
}

/**
 * 将长段人设节（尤其是「心理模型/重要记忆」「知识与边界/人际关系」）按自然条目边界切分为
 * <= 1200 字的语义完整子块，避免记忆或关系列表在中间被硬截断。
 */
function splitPersonaSectionCoherently(
  sectionText: string,
  maxChars = PERSONA_CHUNK_MAX_CHARS
): Array<{ subLabel: string; body: string }> {
  const cleaned = sectionText.trim()
  if (!cleaned) return []
  if (cleaned.length <= PERSONA_CHUNK_HARD_CHARS) {
    return [{ subLabel: '', body: cleaned }]
  }

  // 去掉开头的 `## 标题` 行，按顶级 `- ` 条目分组
  const lines = cleaned.split('\n')
  const startIdx = /^#{2,3}\s+/.test(lines[0]) ? 1 : 0
  const bodyOnly = lines.slice(startIdx).join('\n').trim()
  if (bodyOnly.length <= PERSONA_CHUNK_HARD_CHARS) {
    return [{ subLabel: '', body: cleaned }]
  }

  const topBlocks = bodyOnly
    .split(/\n(?=- )/)
    .map((b) => b.trim())
    .filter(Boolean)
  const atomicChunks: Array<{ subLabel: string; body: string }> = []

  for (const block of topBlocks) {
    const labelMatch = /^-\s*([^：\n:]+)[：:]/.exec(block)
    const blockLabel = labelMatch ? labelMatch[1].trim() : ''

    if (block.length <= PERSONA_CHUNK_HARD_CHARS) {
      atomicChunks.push({ subLabel: blockLabel, body: block })
      continue
    }

    // 超长嵌套条目（如 `- 重要记忆：\n  - ...` 或 `- 人际关系：\n  - ...`）按缩进子条切分
    const subLines = block.split('\n')
    const headerLine = subLines[0].trim()
    const subBody = subLines.slice(1).join('\n').trim()
    const subItems = subBody
      ? subBody
          .split(/\n(?=\s{2,}-\s+)/)
          .map((s) => s.trimEnd())
          .filter(Boolean)
      : []

    if (subItems.length <= 1) {
      for (const piece of splitAtSentenceBoundary(block, maxChars)) {
        atomicChunks.push({ subLabel: blockLabel, body: piece })
      }
      continue
    }

    let currentItems: string[] = []
    let currentLen = headerLine.length
    let partIdx = 0
    const flushGroup = (): void => {
      if (currentItems.length === 0) return
      const prefix = partIdx === 0 ? headerLine : `${headerLine.replace(/[：:]\s*$/, '')}（续）：`
      atomicChunks.push({
        subLabel: blockLabel,
        body: `${prefix}\n${currentItems.join('\n')}`
      })
      currentItems = []
      currentLen = headerLine.length
      partIdx += 1
    }

    for (const item of subItems) {
      if (currentItems.length > 0 && currentLen + item.length + 1 > maxChars) {
        flushGroup()
      }
      if (item.length > PERSONA_CHUNK_HARD_CHARS) {
        flushGroup()
        for (const piece of splitAtSentenceBoundary(item, maxChars)) {
          const prefix =
            partIdx === 0 ? headerLine : `${headerLine.replace(/[：:]\s*$/, '')}（续）：`
          atomicChunks.push({ subLabel: blockLabel, body: `${prefix}\n${piece}` })
          partIdx += 1
        }
      } else {
        currentItems.push(item)
        currentLen += item.length + 1
      }
    }
    flushGroup()
  }

  // 把相邻短小条合并到 <= maxChars，避免产生大量碎片 chunk
  const packed: Array<{ subLabel: string; body: string }> = []
  let buf = ''
  let labels: string[] = []

  const flushPacked = (): void => {
    if (!buf.trim()) return
    const uniqueLabels = [...new Set(labels.filter(Boolean))]
    packed.push({
      subLabel: uniqueLabels.slice(0, 2).join('/'),
      body: buf.trim()
    })
    buf = ''
    labels = []
  }

  for (const item of atomicChunks) {
    if (buf && buf.length + item.body.length + 2 > maxChars) {
      flushPacked()
    }
    buf = buf ? `${buf}\n${item.body}` : item.body
    if (item.subLabel) labels.push(item.subLabel)
  }
  flushPacked()

  return packed
}

/**
 * 将角色完整人设 Markdown 切分为 `worldview_lore` 块：
 * - 自动过滤聊天机器人防注入/IF-THEN 样板；
 * - 完整保留「重要记忆」「人际关系」「语言与风格」「伙伴困境」并以 ~1200 字符连贯分块；
 * - 区分不同「世界」的虚拟歌手（如 `25时初音未来` vs `WS初音未来`）。
 */
export function chunkPersonasToLore(personas: PersonaEntry[]): RagChunk[] {
  const chunks: RagChunk[] = []
  for (const persona of personas) {
    const prompt = persona.prompt?.trim()
    if (!prompt) continue

    const identity = resolvePersonaIdentity(persona)
    const sections = prompt.split(/\n(?=#{2,3}\s+)/)
    let lineCursor = 0
    let chunkSeq = 0

    for (let i = 0; i < sections.length; i++) {
      const sec = sections[i].trim()
      if (sec.length < 24) continue
      const headingMatch = /^#{2,3}\s+(.+)/.exec(sec)
      if (!headingMatch) continue
      const heading = headingMatch[1].trim()
      if (SKIP_PERSONA_HEADING.test(heading)) continue

      const cleaned = cleanPersonaSectionBody(sec)
      if (cleaned.length < 24) continue

      const subChunks = splitPersonaSectionCoherently(cleaned, PERSONA_CHUNK_MAX_CHARS)
      for (const sub of subChunks) {
        const subSuffix = sub.subLabel && !heading.includes(sub.subLabel) ? `/${sub.subLabel}` : ''
        const unitSuffix = identity.unit && identity.unit !== 'VS' ? ` | ${identity.unit}` : ''
        const text = `[${identity.displayName} · ${heading}${subSuffix}${unitSuffix}]\n${sub.body}`
        const lineCount = sub.body.split('\n').length
        chunks.push({
          id: `persona:${identity.canonicalName}:${chunkSeq++}`,
          domain: PJSK_DOMAIN,
          chunkHash: computeChunkHash(text),
          sourceKind: 'worldview_lore',
          storyId: `persona:${identity.canonicalName}`,
          story: `${identity.displayName} 设定`,
          scenarioId: `persona:${identity.canonicalName}`,
          type: 'persona',
          ...(identity.unit ? { unit: identity.unit } : {}),
          lang: 'cn',
          chars: identity.chars,
          lineStart: lineCursor,
          lineEnd: lineCursor + lineCount - 1,
          text
        })
        lineCursor += lineCount + 1
      }
    }
  }
  return chunks
}

interface EventMetaEntry {
  id: number
  name: string
  jpName?: string
  assetbundleName: string
  unit: string
  unitCode: string
  eventYear?: number
  isRecent2025_2026: boolean
}

interface EventEpisodeMetaEntry {
  eventId: number
  episodeNo: number
  title: string
  scenarioId: string
}

interface EventStoryMetaEntry {
  eventId: number
  outline: string
  bannerCharId?: number
  assetbundleName: string
  episodes: EventEpisodeMetaEntry[]
}

export interface PjskTitleMaps {
  eventById: Map<string, string>
  eventByBundle: Map<string, string>
  eventMetaById: Map<string, EventMetaEntry>
  eventMetaByBundle: Map<string, EventMetaEntry>
  storyByEventId: Map<string, EventStoryMetaEntry>
  episodeByScenarioId: Map<string, EventEpisodeMetaEntry>
  areaById: Map<string, string>
}

function inferEventNumFromIds(...candidates: Array<string | undefined>): number | undefined {
  for (const s of candidates) {
    if (!s) continue
    const m = /event_(\d+)/i.exec(s)
    if (m) return Number(m[1])
  }
  return undefined
}

function inferYearFromText(...candidates: Array<string | undefined>): number | undefined {
  for (const s of candidates) {
    if (!s) continue
    const m = /_(202\d)\b/.exec(s) ?? /(202[0-9])/.exec(s)
    if (m) return Number(m[1])
  }
  return undefined
}

function isRecentEvent(eventNum?: number, eventYear?: number, hintText = ''): boolean {
  if (eventYear !== undefined && eventYear >= 2025) return true
  if (eventNum !== undefined && eventNum >= 154) return true
  if (/jp_new_stories|2025|2026|5th_anniversary|6th_anniversary/i.test(hintText)) return true
  return false
}

/**
 * 从 `cache/semantic-build` 加载 `events_cn.json` / `events_jp.json` / `eventStories_cn.json` / `eventStories_jp.json` / `areas_cn.json`，
 * 为官方剧情与 JP 新剧本建立完整的中文活动名、简介、章节名、组合与时效索引。
 */
export function loadPjskTitleMaps(rootDir: string): PjskTitleMaps {
  const eventById = new Map<string, string>()
  const eventByBundle = new Map<string, string>()
  const eventMetaById = new Map<string, EventMetaEntry>()
  const eventMetaByBundle = new Map<string, EventMetaEntry>()
  const storyByEventId = new Map<string, EventStoryMetaEntry>()
  const episodeByScenarioId = new Map<string, EventEpisodeMetaEntry>()
  const areaById = new Map<string, string>()

  const readJsonArray = (filename: string): Array<Record<string, unknown>> => {
    const full = path.join(rootDir, filename)
    if (!fs.existsSync(full)) return []
    try {
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8')) as unknown
      return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : []
    } catch {
      return []
    }
  }

  // JP 先装（保留真实 JP 开服年份与 201+ 活动），CN 后装以中文标题覆盖
  for (const [evFile, isCn] of [
    ['events_jp.json', false],
    ['events_cn.json', true]
  ] as const) {
    for (const item of readJsonArray(evFile)) {
      const name = typeof item.name === 'string' ? item.name.trim() : ''
      if (!name || item.id === undefined || item.id === null) continue
      const idNum = Number(item.id)
      const idStr = String(idNum)
      const asset = typeof item.assetbundleName === 'string' ? item.assetbundleName.trim() : ''
      const assetLower = asset.toLowerCase()
      const unitCode = typeof item.unit === 'string' ? item.unit.trim() : ''
      const unit = resolveUnitLabel(unitCode) || (unitCode === 'none' ? '混活' : '')
      const prev = eventMetaById.get(idStr)

      let eventYear = prev?.eventYear
      if (!isCn && typeof item.startAt === 'number' && Number.isFinite(item.startAt)) {
        eventYear = new Date(item.startAt).getUTCFullYear()
      } else if (eventYear === undefined) {
        eventYear = inferYearFromText(asset)
      }
      if (
        eventYear === undefined &&
        typeof item.startAt === 'number' &&
        Number.isFinite(item.startAt)
      ) {
        // 无 JP 数据时从 CN startAt 近似推算（CN 通常比 JP 晚约 1 年）
        const cnYear = new Date(item.startAt).getUTCFullYear()
        eventYear = cnYear > 2024 ? cnYear - 1 : cnYear
      }

      const meta: EventMetaEntry = {
        id: idNum,
        name,
        jpName: isCn ? prev?.jpName : name,
        assetbundleName: asset || prev?.assetbundleName || '',
        unit: unit || prev?.unit || '',
        unitCode: unitCode || prev?.unitCode || '',
        eventYear,
        isRecent2025_2026: isRecentEvent(idNum, eventYear, asset)
      }
      eventById.set(idStr, name)
      eventMetaById.set(idStr, meta)
      if (assetLower) {
        eventByBundle.set(assetLower, name)
        eventMetaByBundle.set(assetLower, meta)
      }
    }
  }

  for (const esFile of ['eventStories_jp.json', 'eventStories_cn.json']) {
    for (const item of readJsonArray(esFile)) {
      const eventId = Number(item.eventId ?? item.id)
      if (!Number.isFinite(eventId)) continue
      const idStr = String(eventId)
      const outline =
        typeof item.outline === 'string' ? item.outline.replace(/\s+/g, ' ').trim() : ''
      const assetbundleName =
        typeof item.assetbundleName === 'string' ? item.assetbundleName.trim().toLowerCase() : ''
      const bannerCharId =
        typeof item.bannerGameCharacterUnitId === 'number'
          ? item.bannerGameCharacterUnitId
          : undefined
      const rawEps = Array.isArray(item.eventStoryEpisodes)
        ? (item.eventStoryEpisodes as Array<Record<string, unknown>>)
        : []
      const episodes: EventEpisodeMetaEntry[] = []
      for (const ep of rawEps) {
        const scenarioId = typeof ep.scenarioId === 'string' ? ep.scenarioId.trim() : ''
        const title = typeof ep.title === 'string' ? ep.title.trim() : ''
        const episodeNo = Number(ep.episodeNo ?? 0)
        if (!scenarioId) continue
        const epEntry: EventEpisodeMetaEntry = { eventId, episodeNo, title, scenarioId }
        episodes.push(epEntry)
        episodeByScenarioId.set(scenarioId, epEntry)
      }
      const prev = storyByEventId.get(idStr)
      storyByEventId.set(idStr, {
        eventId,
        outline: outline || prev?.outline || '',
        bannerCharId: bannerCharId ?? prev?.bannerCharId,
        assetbundleName: assetbundleName || prev?.assetbundleName || '',
        episodes: episodes.length > 0 ? episodes : (prev?.episodes ?? [])
      })
    }
  }

  for (const areaFile of ['areas_jp.json', 'areas_cn.json']) {
    for (const item of readJsonArray(areaFile)) {
      const name = typeof item.name === 'string' ? item.name.trim() : ''
      const subName = typeof item.subName === 'string' ? item.subName.trim() : ''
      const label = subName ? `${name} · ${subName}` : name
      if (!label) continue
      if (item.id !== undefined && item.id !== null) {
        areaById.set(String(item.id), label)
      }
    }
  }

  return {
    eventById,
    eventByBundle,
    eventMetaById,
    eventMetaByBundle,
    storyByEventId,
    episodeByScenarioId,
    areaById
  }
}

export function resolvePjskTitle(baseName: string, type: string, titleMaps: PjskTitleMaps): string {
  const lower = baseName.toLowerCase()
  const bundlePrefix = lower.split('__')[0]
  const byBundle = titleMaps.eventByBundle.get(bundlePrefix) ?? titleMaps.eventByBundle.get(lower)
  if (byBundle) return byBundle

  const eventMatch = /event_(\d+)/i.exec(baseName)
  if (eventMatch) {
    const idStr = String(Number(eventMatch[1]))
    const byId = titleMaps.eventById.get(idStr) ?? titleMaps.eventById.get(eventMatch[1])
    if (byId) return byId
  }

  if (type === 'talk') {
    const areaMatch = /(?:area|actionset|areatalk)_?(\d+)/i.exec(baseName)
    if (areaMatch) {
      const idStr = String(Number(areaMatch[1]))
      const byArea = titleMaps.areaById.get(idStr) ?? titleMaps.areaById.get(areaMatch[1])
      if (byArea) return byArea
    }
  }

  return baseName
}

function resolveAreaTalkTitleAndUnit(
  baseName: string,
  titleMaps: PjskTitleMaps,
  doc: Record<string, unknown>
): { story: string; unit?: string; eventYear?: number; isRecent?: boolean } {
  const lower = baseName.toLowerCase()
  const unitTagMap: Array<[RegExp, string, string]> = [
    [/areatalk_ev_night_(\d+)/i, '25时', '25时 活动区域对话'],
    [/areatalk_ev_wonder_(\d+)/i, 'WS', 'WS 活动区域对话'],
    [/areatalk_ev_band_(\d+)/i, 'L/n', 'L/n 活动区域对话'],
    [/areatalk_ev_idol_(\d+)/i, 'MMJ', 'MMJ 活动区域对话'],
    [/areatalk_ev_street_(\d+)/i, 'VBS', 'VBS 活动区域对话'],
    [/areatalk_ev_shuffle_(\d+)/i, '混活', '混活 区域对话']
  ]
  for (const [re, unit, label] of unitTagMap) {
    const m = re.exec(lower)
    if (m) return { story: `${label} #${Number(m[1])}`, unit }
  }

  const aprilMatch = /areatalk_aprilfool(202\d)/i.exec(lower)
  if (aprilMatch) {
    const yr = Number(aprilMatch[1])
    return { story: `愚人节区域对话 ${yr}`, eventYear: yr, isRecent: yr >= 2025 }
  }
  if (/areatalk_monthly(\d{4})/i.test(lower)) {
    const m = /areatalk_monthly(\d{2})(\d{2})/i.exec(lower)!
    return { story: `月度日常对话 20${m[1]}-${m[2]}` }
  }

  // 常规区域对话：先按 areatalkNN 映射 areas_cn.json，再根据出场服装推断组合
  const areaTitle = resolvePjskTitle(baseName, 'talk', titleMaps)
  let inferredUnit = ''
  if (Array.isArray(doc.AppearCharacters)) {
    for (const ac of doc.AppearCharacters as Array<Record<string, unknown>>) {
      const costume = typeof ac?.CostumeType === 'string' ? ac.CostumeType.toLowerCase() : ''
      if (costume.includes('_wonder')) inferredUnit = 'WS'
      else if (costume.includes('_night')) inferredUnit = '25时'
      else if (costume.includes('_street')) inferredUnit = 'VBS'
      else if (costume.includes('_idol')) inferredUnit = 'MMJ'
      else if (costume.includes('_band') || costume.includes('_leo')) inferredUnit = 'L/n'
      if (inferredUnit) break
    }
  }
  return {
    story: areaTitle !== baseName ? areaTitle : '日常区域对话',
    ...(inferredUnit ? { unit: inferredUnit } : {})
  }
}

function resolveUnitAndSpecialStoryMeta(
  baseName: string,
  titleMaps: PjskTitleMaps
): Partial<ChunkScenarioMeta> {
  const lower = baseName.toLowerCase()
  const parts = baseName.split('__')
  const tail = parts[parts.length - 1] ?? baseName

  if (lower.includes('unitstory')) {
    let unit = ''
    let unitName = '主线剧情'
    if (lower.includes('school-refusal') || lower.includes('nightcode')) {
      unit = '25时'
      unitName = '25点，Nightcord见。主线剧情'
    } else if (lower.includes('theme-park') || lower.includes('wonder')) {
      unit = 'WS'
      unitName = 'Wonderlands×Showtime 主线剧情'
    } else if (lower.includes('street')) {
      unit = 'VBS'
      unitName = 'Vivid BAD SQUAD 主线剧情'
    } else if (lower.includes('idol') || lower.includes('mmj')) {
      unit = 'MMJ'
      unitName = 'MORE MORE JUMP! 主线剧情'
    } else if (lower.includes('light-sound') || lower.includes('leo')) {
      unit = 'L/n'
      unitName = 'Leo/need 主线剧情'
    } else if (lower.includes('piapro')) {
      unit = 'VS'
      unitName = '虚拟歌手 主线剧情'
    }
    const epMatch = /_(\d+)$/.exec(tail)
    const ep = epMatch ? String(Number(epMatch[1])) : undefined
    return {
      storyId: tail.replace(/_\d+$/, '') || tail,
      story: unitName,
      scenarioId: tail,
      ep,
      unit,
      type: 'unit'
    }
  }

  if (lower.includes('special')) {
    const year = inferYearFromText(lower)
    let story = '特别剧情'
    if (lower.includes('aprilfool')) story = `愚人节特别剧情${year ? ` ${year}` : ''}`
    else if (lower.includes('6th_anniversary')) story = '6周年纪念剧情'
    else if (lower.includes('5th_anniversary')) story = '5周年纪念剧情'
    else if (lower.includes('3rd_anniversary')) story = '3周年纪念剧情'
    else if (lower.includes('connect_live')) story = 'Connect Live 特别剧情'
    else if (lower.includes('collaboration')) story = '联动特别剧情'
    else if (lower.includes('epilogue')) story = '主线后日谈/序章'
    return {
      storyId: tail.replace(/_\d+$/, '') || tail,
      story,
      scenarioId: tail,
      type: 'special',
      eventYear:
        year ??
        (lower.includes('5th_anniversary')
          ? 2025
          : lower.includes('6th_anniversary')
            ? 2026
            : undefined),
      isRecent2025_2026: isRecentEvent(undefined, year, lower),
      unit: resolveUnitLabel(lower) || undefined
    }
  }

  const eventMeta =
    titleMaps.eventMetaByBundle.get(parts[0]?.toLowerCase() ?? '') ??
    (() => {
      const m = /event_(\d+)/i.exec(baseName)
      return m ? titleMaps.eventMetaById.get(String(Number(m[1]))) : undefined
    })()

  if (eventMeta) {
    const epInfo = titleMaps.episodeByScenarioId.get(tail)
    const epMatch = /_(\d+)$/.exec(tail)
    const ep = epInfo?.episodeNo
      ? String(epInfo.episodeNo)
      : epMatch
        ? String(Number(epMatch[1]))
        : undefined
    return {
      storyId: `event_${eventMeta.id}`,
      story: eventMeta.name,
      scenarioId: tail || baseName,
      type: 'event',
      ep,
      epTitle: epInfo?.title,
      unit: eventMeta.unit || undefined,
      eventNum: eventMeta.id,
      eventYear: eventMeta.eventYear,
      isRecent2025_2026: eventMeta.isRecent2025_2026
    }
  }

  return {}
}

function buildEventSynopsisChunks(
  loadedEventIds: Set<number>,
  titleMaps: PjskTitleMaps
): RagChunk[] {
  const chunks: RagChunk[] = []
  for (const eventId of [...loadedEventIds].sort((a, b) => a - b)) {
    const storyMeta = titleMaps.storyByEventId.get(String(eventId))
    if (!storyMeta || !storyMeta.outline) continue
    const evMeta =
      titleMaps.eventMetaById.get(String(eventId)) ??
      (storyMeta.assetbundleName
        ? titleMaps.eventMetaByBundle.get(storyMeta.assetbundleName)
        : undefined)
    const eventName = evMeta?.name ?? `event_${eventId}`
    const unit = evMeta?.unit || ''
    const eventYear = evMeta?.eventYear
    const isRecent = evMeta?.isRecent2025_2026 ?? isRecentEvent(eventId, eventYear)
    const bannerChar =
      storyMeta.bannerCharId !== undefined ? resolveCharIdToCnName(storyMeta.bannerCharId) : ''

    const epList = storyMeta.episodes
      .slice()
      .sort((a, b) => a.episodeNo - b.episodeNo)
      .map((e) => `第${e.episodeNo}话「${e.title || e.scenarioId}」`)
      .join(' / ')

    const headerParts = [`活动梗概: ${eventName} (event_${eventId})`]
    if (unit) headerParts.push(unit)
    if (eventYear) headerParts.push(String(eventYear))
    if (bannerChar) headerParts.push(`主角: ${bannerChar}`)
    const text = [
      `[${headerParts.join(' | ')}]`,
      `梗概: ${storyMeta.outline}`,
      epList ? `章节: ${epList}` : ''
    ]
      .filter(Boolean)
      .join('\n')

    const chars = bannerChar ? [bannerChar] : []
    const lang: 'cn' | 'jp' =
      /[\u3040-\u30ff]/.test(storyMeta.outline) && !/[\u4e00-\u9fff]{6,}/.test(storyMeta.outline)
        ? 'jp'
        : 'cn'

    chunks.push({
      id: `synopsis:event_${eventId}`,
      domain: PJSK_DOMAIN,
      chunkHash: computeChunkHash(text),
      sourceKind: 'canon_story',
      storyId: `event_${eventId}`,
      story: eventName,
      scenarioId: `synopsis:event_${eventId}`,
      type: 'event_synopsis',
      ...(unit ? { unit } : {}),
      eventNum: eventId,
      ...(eventYear !== undefined ? { eventYear } : {}),
      ...(isRecent ? { isRecent2025_2026: true } : {}),
      lang,
      tags: ['synopsis'],
      chars,
      ...(storyMeta.bannerCharId ? { charIds: [storyMeta.bannerCharId] } : {}),
      lineStart: 0,
      lineEnd: 0,
      text
    })
  }
  return chunks
}

function inferTypeFromDir(dirName: string): string {
  const lower = dirName.toLowerCase()
  if (lower.includes('actionset') || lower.includes('talk')) return 'talk'
  if (lower.includes('event') || lower.includes('jp_new')) return 'event'
  if (lower.includes('card')) return 'card'
  if (lower.includes('stor')) return 'unit'
  return 'event'
}

function scanLocalDir(
  dir: string,
  out: RagChunk[],
  maxChunks: number,
  titleMaps: PjskTitleMaps,
  loadedEventIds: Set<number>
): void {
  if (!fs.existsSync(dir) || out.length >= maxChunks) return
  if (FOREIGN_DOMAIN_MARKER.test(dir)) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (out.length >= maxChunks) break
    const fullPath = path.join(dir, entry.name)
    if (FOREIGN_DOMAIN_MARKER.test(fullPath)) continue
    if (entry.isDirectory()) {
      scanLocalDir(fullPath, out, maxChunks, titleMaps, loadedEventIds)
      continue
    }
    if (entry.name.endsWith('.jsonl.br')) {
      try {
        const loaded = parseSekaiJsonlBuffer(fs.readFileSync(fullPath), true, fullPath)
        for (const chunk of loaded) {
          if (out.length >= maxChunks) break
          out.push(chunk)
        }
      } catch {
        // 忽略无效压缩文件
      }
      continue
    }
    if (entry.name.endsWith('.jsonl')) {
      try {
        const loaded = parseSekaiJsonlBuffer(fs.readFileSync(fullPath), false, fullPath)
        for (const chunk of loaded) {
          if (out.length >= maxChunks) break
          out.push(chunk)
        }
      } catch {
        // 忽略无效 jsonl
      }
      continue
    }
    if (entry.name.endsWith('.json')) {
      // 跳过元信息表（events_cn.json / areas_cn.json 等数组文件）与无意义登录测试文件
      const base = entry.name.replace(/\.json$/i, '')
      if (/^(events|eventStories|areas|musicSoundTracks|manifest)/i.test(base)) continue
      if (/dummy_test_login_story/i.test(base)) continue
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
        if (isForeignOurnotesPayload(parsed, fullPath)) continue
        const parentName = path.basename(dir)
        const dirType = inferTypeFromDir(parentName)
        const isJpDir = /jp_new/i.test(parentName) || /jp_new/i.test(fullPath)
        const rec = parsed as Record<string, unknown>

        let meta: ChunkScenarioMeta
        if (dirType === 'talk') {
          const talkMeta = resolveAreaTalkTitleAndUnit(base, titleMaps, rec)
          const tail = base.split('__').pop() ?? base
          meta = {
            storyId: tail.replace(/_\d+$/, '') || base,
            story: talkMeta.story,
            scenarioId: tail || base,
            type: 'talk',
            unit: talkMeta.unit,
            eventYear: talkMeta.eventYear,
            isRecent2025_2026: talkMeta.isRecent,
            lang: 'cn'
          }
        } else {
          const resolved = resolveUnitAndSpecialStoryMeta(base, titleMaps)
          const story = resolved.story ?? resolvePjskTitle(base, dirType, titleMaps)
          const tail = base.split('__').pop() ?? base
          const eventNum = resolved.eventNum ?? inferEventNumFromIds(base, tail)
          const eventYear = resolved.eventYear ?? inferYearFromText(base)
          meta = {
            storyId: resolved.storyId ?? (base.replace(/_\d+$/, '') || base),
            story,
            scenarioId: resolved.scenarioId ?? (tail || base),
            type: resolved.type ?? dirType,
            ep: resolved.ep,
            epTitle: resolved.epTitle,
            unit: resolved.unit,
            eventNum,
            eventYear,
            isRecent2025_2026:
              resolved.isRecent2025_2026 ?? isRecentEvent(eventNum, eventYear, fullPath),
            ...(isJpDir ? { lang: 'jp' as const } : {})
          }
          if (eventNum !== undefined) loadedEventIds.add(eventNum)
        }

        const chunks = chunkPjskScenario(parsed, meta)
        for (const chunk of chunks) {
          if (out.length >= maxChunks) break
          out.push(chunk)
        }
      } catch {
        // 忽略不可解析的 JSON
      }
    }
  }
}

/** 递归加载目录下的 PJSK 人设 Markdown/TXT（支持 `虚拟歌姬/*` 等嵌套分组）。 */
export function loadPersonaMarkdownDir(dirs: string[]): PersonaEntry[] {
  const entries: PersonaEntry[] = []
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir) || FOREIGN_DOMAIN_MARKER.test(dir)) return
    let items: fs.Dirent[]
    try {
      items = fs
        .readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      return
    }
    for (const item of items) {
      const full = path.join(dir, item.name)
      if (FOREIGN_DOMAIN_MARKER.test(full)) continue
      if (item.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(md|txt)$/i.test(item.name)) continue
      try {
        const raw = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n').trim()
        if (!raw) continue
        const base = path.basename(item.name, path.extname(item.name))
        const group = resolveUnitLabel(path.basename(dir)) || ''
        entries.push({
          name: base,
          prompt: raw,
          aliases: [],
          group,
          source: full
        })
      } catch {
        // 忽略读取失败的文件
      }
    }
  }
  for (const dir of dirs) walk(dir)
  return entries
}

/**
 * 加载本地所有可用 PJSK 语料（sekai-story-search `.jsonl.br`/`.jsonl`、本地 `cache/semantic-build` 剧情 JSON、人设 Lore）。
 * 严格拒绝任何 Ournotes / BanG Dream 跨领域文件。
 */
export function loadStoryCorpus(options: LoadStoryCorpusOptions): RagChunk[] {
  const maxChunks = options.maxChunks ?? 80_000
  const chunks: RagChunk[] = []

  for (const file of options.jsonlFiles ?? []) {
    if (chunks.length >= maxChunks) break
    if (!fs.existsSync(file) || FOREIGN_DOMAIN_MARKER.test(file)) continue
    try {
      const loaded = parseSekaiJsonlBuffer(fs.readFileSync(file), file.endsWith('.br'), file)
      for (const chunk of loaded) {
        if (chunks.length >= maxChunks) break
        chunks.push(chunk)
      }
    } catch {
      // 忽略损坏文件
    }
  }

  for (const dir of options.localDirs ?? []) {
    if (chunks.length >= maxChunks) break
    if (!fs.existsSync(dir) || FOREIGN_DOMAIN_MARKER.test(dir)) continue
    const titleMaps = loadPjskTitleMaps(dir)
    const loadedEventIds = new Set<number>()
    scanLocalDir(dir, chunks, maxChunks, titleMaps, loadedEventIds)
    if (loadedEventIds.size > 0 && titleMaps.storyByEventId.size > 0 && chunks.length < maxChunks) {
      const synopses = buildEventSynopsisChunks(loadedEventIds, titleMaps)
      for (const syn of synopses) {
        if (chunks.length >= maxChunks) break
        chunks.push(syn)
      }
    }
  }

  if (options.includePersonas !== false) {
    const personas =
      options.personas && options.personas.length > 0
        ? options.personas
        : options.personaDirs?.length
          ? loadPersonaMarkdownDir(options.personaDirs)
          : []
    if (personas.length > 0) {
      const lore = chunkPersonasToLore(personas)
      for (const chunk of lore) {
        if (chunks.length >= maxChunks) break
        chunks.push(chunk)
      }
    }
  }

  return chunks
}
