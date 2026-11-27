import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { CHARACTERS, isVirtualSinger } from '../assets/names'
import {
  DEFAULT_BUILTIN_PERSONA_DIR,
  resolveBuiltinPersonaDir,
  type LlmPersona,
  type LlmSettings
} from '../config'
import type { CatalogModel } from '../resources/resourceCatalog'

export { DEFAULT_BUILTIN_PERSONA_DIR, resolveBuiltinPersonaDir }

export interface PersonaEntry {
  name: string
  prompt: string
  aliases: string[]
  group: string
  source: string
  unit?: string
  canonicalName?: string
  isVariant?: boolean
}

export interface PersonaLookupOptions {
  unitHint?: string
  contextText?: string
}

export interface PairwiseAddressRule {
  from: string
  to: string
  zh: string
  note?: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export const CANONICAL_UNITS = {
  N25: '25时',
  LN: 'Leo/need',
  MMJ: 'MORE MORE JUMP!',
  VBS: 'Vivid BAD SQUAD',
  WXS: 'Wonderlands x Showtime'
} as const

const MAIN_CHARACTER_UNITS: Record<string, string> = {
  星乃一歌: CANONICAL_UNITS.LN,
  天马咲希: CANONICAL_UNITS.LN,
  望月穗波: CANONICAL_UNITS.LN,
  日野森志步: CANONICAL_UNITS.LN,
  花里实乃理: CANONICAL_UNITS.MMJ,
  桐谷遥: CANONICAL_UNITS.MMJ,
  桃井爱莉: CANONICAL_UNITS.MMJ,
  日野森雫: CANONICAL_UNITS.MMJ,
  小豆泽心羽: CANONICAL_UNITS.VBS,
  白石杏: CANONICAL_UNITS.VBS,
  东云彰人: CANONICAL_UNITS.VBS,
  青柳冬弥: CANONICAL_UNITS.VBS,
  天马司: CANONICAL_UNITS.WXS,
  凤笑梦: CANONICAL_UNITS.WXS,
  草薙宁宁: CANONICAL_UNITS.WXS,
  神代类: CANONICAL_UNITS.WXS,
  宵崎奏: CANONICAL_UNITS.N25,
  朝比奈真冬: CANONICAL_UNITS.N25,
  东云绘名: CANONICAL_UNITS.N25,
  晓山瑞希: CANONICAL_UNITS.N25
}

const SUB_CHARACTER_ALIASES: Record<string, string[]> = {
  古泷凪: ['古泷凪', '凪', '凪姐', 'nagi'],
  晓山优希: ['晓山优希', '优希', 'yuuki'],
  东云慎英: ['东云慎英', '慎英', 'shinei'],
  真冬的母亲: ['真冬的母亲', '朝比奈太太', '真冬妈妈', '真冬母亲'],
  奏的父亲: ['奏的父亲', '宵崎先生', '奏爸爸', '奏父亲'],
  奏的母亲: ['奏的母亲', '宵崎太太', '小奏的妈妈', '奏妈妈', '奏母亲']
}

interface VariantInferenceRule {
  canonicalName: string
  variantNamePatterns: RegExp[]
  contextInclude: RegExp
  contextExclude?: RegExp
  variantAliases: string[]
}

const VARIANT_RULES: VariantInferenceRule[] = [
  {
    canonicalName: '东云彰人',
    variantNamePatterns: [/优男彰人/, /优男模式/],
    contextInclude:
      /优男|营业模式|对外营业|面对陌生人|不熟的同学|刚认识|初次见面|客套礼貌|完美好青年|观众搭话|店里客人/,
    contextExclude: /私下|卸下面具|毒舌形态|真实形态|伙伴互怼/,
    variantAliases: ['优男彰人', '优男模式彰人', '营业彰人']
  },
  {
    canonicalName: '朝比奈真冬',
    variantNamePatterns: [/优等生真冬/, /班长真冬/],
    contextInclude:
      /优等生|班长|好孩子|宫益坂|宫女|在校|老师面前|白天营业|弓道部|优等生模式|模范生|3-B/,
    contextExclude: /25时|nightcord|\bown\b|真实形态|空洞|离家出走|奏家/i,
    variantAliases: ['优等生真冬', '班长真冬', '营业真冬']
  }
]

const UNIT_CLOUD_TOKENS: Array<{ unit: string; token: string }> = [
  { unit: CANONICAL_UNITS.N25, token: 'night' },
  { unit: CANONICAL_UNITS.LN, token: 'band' },
  { unit: CANONICAL_UNITS.MMJ, token: 'idol' },
  { unit: CANONICAL_UNITS.VBS, token: 'street' },
  { unit: CANONICAL_UNITS.WXS, token: 'wonder' }
]

const UNIT_PREFIX_LABELS: Array<{ unit: string; prefixes: string[] }> = [
  { unit: CANONICAL_UNITS.N25, prefixes: ['25时', '无人世界', '25时风'] },
  { unit: CANONICAL_UNITS.LN, prefixes: ['LN', 'L/n', '教室世界'] },
  { unit: CANONICAL_UNITS.MMJ, prefixes: ['MMJ', '舞台世界'] },
  { unit: CANONICAL_UNITS.VBS, prefixes: ['VBS', '街头世界'] },
  { unit: CANONICAL_UNITS.WXS, prefixes: ['WS', 'WxS', '乐园世界', '奇幻世界'] }
]

const UNIT_KEYWORD_PATTERNS: Array<{ unit: string; pattern: RegExp }> = [
  {
    unit: CANONICAL_UNITS.N25,
    pattern: /25时|25点|25時|nightcord|ニーゴ|无人[的]?世界|没有人的世界|誰もいないセカイ|_night\b|night_/i
  },
  {
    unit: CANONICAL_UNITS.LN,
    pattern:
      /leo[\s/_-]*need|l\/n|レオニ|教室[的]?世界|教室のセカイ|_band\b|band_|(?:^|[^a-z])ln(?:[^a-z]|$)|^ln[\u4e00-\u9fa5a-z]/i
  },
  {
    unit: CANONICAL_UNITS.MMJ,
    pattern: /more[\s_-]*more[\s_-]*jump|mmj|モモジャン|舞台[的]?世界|ステージのセカイ|_idol\b|idol_/i
  },
  {
    unit: CANONICAL_UNITS.VBS,
    pattern: /vivid[\s_-]*bad[\s_-]*squad|vbs|ビビバス|街头[的]?世界|ストリートのセカイ|_street\b|street_/i
  },
  {
    unit: CANONICAL_UNITS.WXS,
    pattern:
      /wonderlands|w[×x]?s(?:[^a-z]|$)|^ws[\u4e00-\u9fa5a-z]|ワンダショ|乐园[的]?世界|奇幻[的]?世界|奇幻乐园|ワンダーランドのセカイ|_wonder\b|wonder_/i
  }
]

const UNIT_CAST_MEMBER_PATTERNS: Array<{ unit: string; members: RegExp[] }> = [
  {
    unit: CANONICAL_UNITS.N25,
    members: [
      /宵崎奏|(?<![演节伴前间尾合独重齐协变弹吹拉])(?:^|[\s，,、|/·「」()（）和与跟对向叫找])奏(?!(?:的)?(?:母亲|妈妈|父亲|爸爸)|[响鸣曲乐章折])(?:$|[\s，,、|/·「」()（）和与跟在的说问笑])|(?<![a-z])kanade(?![a-z])/i,
      /朝比奈真冬|朝比奈まふゆ|真冬(?!(?:的)?(?:母亲|妈妈|父亲|爸爸))|まふゆ|(?<![a-z])mafuyu(?![a-z])/i,
      /东云绘名|東雲絵名|绘名|絵名|绘绘|绘名名|えななん|(?<![a-z])ena(?![a-z])/i,
      /晓山瑞希|暁山瑞希|瑞希|みずき|(?<![a-z])(?:mizuki|amia)(?![a-z])/i
    ]
  },
  {
    unit: CANONICAL_UNITS.LN,
    members: [
      /星乃一歌|一歌|いちか|(?<![a-z])ichika(?![a-z])/i,
      /天马咲希|天馬咲希|咲希|さき|(?<![a-z])saki(?![a-z])/i,
      /望月穗波|望月穂波|穗波|穂波|ほなみ|(?<![a-z])honami(?![a-z])/i,
      /日野森志步|日野森志歩|志步|志歩|しほ|(?<![a-z])shiho(?![a-z])/i
    ]
  },
  {
    unit: CANONICAL_UNITS.MMJ,
    members: [
      /花里实乃理|花里みのり|实乃理|みのり|(?<![a-z])minori(?![a-z])/i,
      /桐谷遥|(?:^|[\s，,、|/·「」()（）和与跟对向叫找])遥(?![远望想控测感指不相无])(?:$|[\s，,、|/·「」()（）和与跟在的说问笑])|はるか|(?<![a-z])haruka(?![a-z])/i,
      /桃井爱莉|桃井愛莉|爱莉|愛莉|あいり|(?<![a-z])airi(?![a-z])/i,
      /日野森雫|(?:^|[\s，,、|/·「」()（）和与跟对向叫找])雫(?:$|[\s，,、|/·「」()（）和与跟在的说问笑])|しずく|(?<![a-z])shizuku(?![a-z])/i
    ]
  },
  {
    unit: CANONICAL_UNITS.VBS,
    members: [
      /小豆泽心羽|小豆沢こはね|心羽|こはね|(?<![a-z])kohane(?![a-z])/i,
      /白石杏|(?<![银青红白黄甜酸苦大山野])(?:^|[\s，,、|/·「」()（）和与跟对向叫找])杏(?![仁花树子林黄红干酱脯])(?:$|[\s，,、|/·「」()（）和与跟在的说问笑])/i,
      /东云彰人|東雲彰人|彰人|あきと|(?<![a-z])akito(?![a-z])/i,
      /青柳冬弥|青柳冬彌|冬弥|冬彌|とうや|(?<![a-z])(?:touya|toya)(?![a-z])/i
    ]
  },
  {
    unit: CANONICAL_UNITS.WXS,
    members: [
      /天马司|天馬司|(?<![公上有祭主分总官大法百三都巡土])(?:^|[\s，,、|/·「」()（）和与跟对向叫找])司(?![法机令仪空徒马库长员])(?:$|[\s，,、|/·「」()（）和与跟前辈君的在说问笑])|つかさ|(?<![a-z])tsukasa(?![a-z])/i,
      /凤笑梦|鳳えむ|笑梦|えむ|(?<![a-z])emu(?![a-z])/i,
      /草薙宁宁|草薙寧々|宁宁|寧々|ねね|(?<![a-z])nene(?![a-z])/i,
      /神代类|神代類|(?<![人分种同此归异品大小各另这那其门细科属族词句肉鸟鱼兽藻菌])(?:^|[\s，,、|/·「」()（）和与跟对向叫找])类(?![似型别比目聚属群])(?:$|[\s，,、|/·「」()（）和与跟前辈君的在说问笑])|るい|(?<![a-z])rui(?![a-z])/i
    ]
  }
]

/** 将目录名、H1 标题、model.cloudId / outfitLabel / 场景文本或同团角色共现归一化为标准团名。 */
export function inferUnitFromText(text: string): string | undefined {
  if (!text) return undefined

  // 1. 显式组合名 / SEKAI / cloudId 关键词优先；若唯一命中则直接返回
  const keywordHits = UNIT_KEYWORD_PATTERNS.filter((entry) => entry.pattern.test(text)).map(
    (entry) => entry.unit
  )
  if (keywordHits.length === 1) {
    return keywordHits[0]
  }

  // 2. 从各团固定成员姓名/简称共现做多数票推断（若并列模糊则返回 undefined）
  const scores = new Map<string, number>()
  for (const unit of keywordHits) {
    scores.set(unit, (scores.get(unit) ?? 0) + 3)
  }
  for (const group of UNIT_CAST_MEMBER_PATTERNS) {
    let count = 0
    for (const memberRe of group.members) {
      if (memberRe.test(text)) count += 1
    }
    if (count > 0) {
      scores.set(group.unit, (scores.get(group.unit) ?? 0) + count)
    }
  }
  if (scores.size === 0) return undefined

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1])
  if (ranked.length >= 2 && ranked[0][1] === ranked[1][1]) {
    return undefined
  }
  return ranked[0][0]
}

const GENERIC_UNIT_LABEL_RE = /^(?:虚拟歌手|虚拟歌姬|virtual\s*singer|vs|piapro|联动(?:\/特别)?)$/i

/** 规范化组合标签，将「虚拟歌手」「联动」等泛标签视作未指定组合以便由场景上下文推断。 */
export function normalizeUnit(unit: string | undefined): string | undefined {
  if (!unit) return undefined
  const trimmed = unit.trim()
  if (!trimmed || GENERIC_UNIT_LABEL_RE.test(trimmed)) {
    return undefined
  }
  return inferUnitFromText(trimmed) ?? trimmed
}

function stripWorldSuffix(heading: string): string {
  return heading.replace(/[（(][^）)]*(?:世界|乐园)[^）)]*[）)]\s*$/, '').trim()
}

function findCharacterMeta(nameOrHeading: string): (typeof CHARACTERS)[number] | null {
  const clean = stripWorldSuffix(nameOrHeading).trim()
  if (!clean) return null
  for (const ch of CHARACTERS) {
    if (ch.name === clean || ch.shortName === clean) return ch
  }
  return null
}

function extractH1Heading(body: string): string {
  const match = /^#\s+(.+?)\s*$/m.exec(body)
  return match ? match[1].trim() : ''
}

function extractRomanjiAliases(body: string): string[] {
  const line = /^-\s*姓名[：:]\s*(.+)$/m.exec(body)?.[1]
  if (!line) return []
  const paren = /[（(]([^）)]+)[）)]/.exec(line)?.[1]?.trim()
  if (!paren || !/[a-zA-Z]/.test(paren)) return []
  const parts = paren.split(/\s+/).filter((p) => p.length >= 3)
  return Array.from(new Set([paren, ...parts]))
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    const val = raw.trim()
    if (!val) continue
    const key = val.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(val)
  }
  return out
}

function inferPersonaMetadata(options: {
  filePath: string
  rootDir: string
  body: string
  frontmatterName?: string
  frontmatterGroup?: string
  frontmatterUnit?: string
  frontmatterCanonical?: string
  frontmatterIsVariant?: boolean
  frontmatterAliases?: string[]
}): {
  name: string
  group: string
  unit?: string
  canonicalName?: string
  isVariant: boolean
  aliases: string[]
} {
  const baseName = path.basename(options.filePath, path.extname(options.filePath))
  const relDir = path.relative(options.rootDir, path.dirname(options.filePath))
  const h1 = extractH1Heading(options.body)

  const name = options.frontmatterName?.trim() || baseName
  const h1Clean = stripWorldSuffix(h1)

  let isVariant = options.frontmatterIsVariant ?? false
  let canonicalName = options.frontmatterCanonical?.trim() || undefined

  for (const rule of VARIANT_RULES) {
    if (rule.variantNamePatterns.some((re) => re.test(name) || re.test(baseName) || re.test(h1))) {
      isVariant = true
      canonicalName = canonicalName ?? rule.canonicalName
      break
    }
  }

  const charMeta =
    findCharacterMeta(canonicalName ?? '') ??
    findCharacterMeta(h1Clean) ??
    findCharacterMeta(name) ??
    CHARACTERS.find(
      (ch) => baseName.endsWith(ch.name) || (ch.name.length >= 2 && baseName.endsWith(ch.shortName))
    ) ??
    null

  if (!canonicalName) {
    if (charMeta) {
      canonicalName = charMeta.name
    } else if (SUB_CHARACTER_ALIASES[name]) {
      canonicalName = name
    } else if (h1Clean) {
      canonicalName = h1Clean
    } else {
      canonicalName = name
    }
  }

  const unit =
    normalizeUnit(options.frontmatterUnit) ??
    normalizeUnit(options.frontmatterGroup) ??
    inferUnitFromText(relDir) ??
    inferUnitFromText(h1) ??
    inferUnitFromText(baseName) ??
    (canonicalName ? MAIN_CHARACTER_UNITS[canonicalName] : undefined)

  const group =
    options.frontmatterGroup?.trim() ||
    unit ||
    (SUB_CHARACTER_ALIASES[canonicalName ?? name] ? '配角' : '')

  const aliasPool: string[] = [...(options.frontmatterAliases ?? [])]
  if (h1 && h1 !== name) aliasPool.push(h1)
  if (baseName && baseName !== name) aliasPool.push(baseName)

  const isVs = Boolean(charMeta && isVirtualSinger(charMeta.characterId))
  if (charMeta && !isVariant) {
    aliasPool.push(charMeta.name, charMeta.shortName, ...charMeta.keys)
    if (isVs && unit) {
      const prefixEntry = UNIT_PREFIX_LABELS.find((p) => p.unit === unit)
      const tokenEntry = UNIT_CLOUD_TOKENS.find((t) => t.unit === unit)
      if (prefixEntry) {
        for (const p of prefixEntry.prefixes) {
          aliasPool.push(`${p}${charMeta.name}`)
        }
      }
      if (tokenEntry) {
        for (const key of charMeta.keys) {
          aliasPool.push(`${charMeta.characterId}${key}_${tokenEntry.token}`)
          aliasPool.push(`${key}_${tokenEntry.token}`)
        }
      }
    }
  } else if (isVariant) {
    const matchedVariant = VARIANT_RULES.find((r) => r.canonicalName === canonicalName)
    if (matchedVariant) aliasPool.push(...matchedVariant.variantAliases)
  }

  if (canonicalName && SUB_CHARACTER_ALIASES[canonicalName]) {
    aliasPool.push(...SUB_CHARACTER_ALIASES[canonicalName])
  }
  aliasPool.push(...extractRomanjiAliases(options.body))

  return {
    name,
    group,
    ...(unit ? { unit } : {}),
    ...(canonicalName ? { canonicalName } : {}),
    isVariant,
    aliases: dedupeStrings(aliasPool).filter((a) => a.toLowerCase() !== name.toLowerCase())
  }
}

function parsePersonaFile(file: string, rootDir: string): PersonaEntry | null {
  const text = fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n')
  let frontName: string | undefined
  let frontGroup: string | undefined
  let frontUnit: string | undefined
  let frontCanonical: string | undefined
  let frontIsVariant: boolean | undefined
  let frontAliases: string[] = []
  let body = text

  const front = FRONTMATTER.exec(text)
  if (front) {
    try {
      const meta = yaml.load(front[1]) as Record<string, unknown> | null
      if (meta && typeof meta === 'object') {
        if (typeof meta.name === 'string' && meta.name.trim()) frontName = meta.name.trim()
        if (typeof meta.group === 'string' && meta.group.trim()) frontGroup = meta.group.trim()
        if (typeof meta.unit === 'string' && meta.unit.trim()) frontUnit = meta.unit.trim()
        if (typeof meta.canonicalName === 'string' && meta.canonicalName.trim()) {
          frontCanonical = meta.canonicalName.trim()
        }
        if (typeof meta.isVariant === 'boolean') frontIsVariant = meta.isVariant
        if (Array.isArray(meta.aliases)) {
          frontAliases = meta.aliases.filter((item): item is string => typeof item === 'string')
        }
        body = text.slice(front[0].length)
      }
    } catch {
      // frontmatter 写错就当普通正文，不因为一个人格文件阻断整场生成
    }
  }

  const prompt = normalizePjskTerminology(body.trim())
  if (!prompt) return null

  const meta = inferPersonaMetadata({
    filePath: file,
    rootDir,
    body: prompt,
    frontmatterName: frontName,
    frontmatterGroup: frontGroup,
    frontmatterUnit: frontUnit,
    frontmatterCanonical: frontCanonical,
    frontmatterIsVariant: frontIsVariant,
    frontmatterAliases: frontAliases
  })

  return {
    name: meta.name,
    prompt,
    aliases: meta.aliases,
    group: meta.group,
    source: file,
    ...(meta.unit ? { unit: meta.unit } : {}),
    ...(meta.canonicalName ? { canonicalName: meta.canonicalName } : {}),
    isVariant: meta.isVariant
  }
}

function collectPersonaFiles(dir: string): string[] {
  const out: string[] = []
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collectPersonaFiles(full))
    } else if (entry.isFile() && /\.(md|txt)$/i.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

function dedupeKeyForPersona(entry: PersonaEntry): string {
  const canonical = entry.canonicalName ?? entry.name
  const charMeta = findCharacterMeta(canonical)
  if (charMeta && isVirtualSinger(charMeta.characterId)) {
    const unitTag = normalizeUnit(entry.unit ?? entry.group) ?? ''
    if (entry.name === canonical || entry.name === charMeta.name) {
      return `vs:${charMeta.name}::${unitTag}`
    }
  }
  return entry.name
}

/**
 * 角色人格表：config.llm.personas + personaDirs 下的 *.md / *.txt（递归扫描子目录）。
 *
 * 显式配置优先于目录文件；同名非虚拟歌手条目后出现的覆盖先出现的，
 * 而 5 团专属虚拟歌手（25时 / L/n / MMJ / VBS / WxS）始终各自保留独立条目。
 */
export function loadPersonas(settings: LlmSettings): PersonaEntry[] {
  const entries: PersonaEntry[] = []

  for (const dir of settings.personaDirs) {
    if (!fs.existsSync(dir)) continue
    const files = collectPersonaFiles(dir)
    for (const file of files) {
      const entry = parsePersonaFile(file, dir)
      if (entry) entries.push(entry)
    }
  }

  for (const persona of settings.personas as LlmPersona[]) {
    if (!persona.name || !persona.prompt.trim()) continue
    const trimmedPrompt = normalizePjskTerminology(persona.prompt.trim())
    const h1 = extractH1Heading(trimmedPrompt)
    const charMeta = findCharacterMeta(persona.name) ?? findCharacterMeta(h1)
    const unit =
      normalizeUnit(persona.group) ??
      inferUnitFromText(persona.name) ??
      inferUnitFromText(h1) ??
      (charMeta ? MAIN_CHARACTER_UNITS[charMeta.name] : undefined)
    entries.push({
      name: persona.name,
      prompt: trimmedPrompt,
      aliases: persona.aliases ?? [],
      group: persona.group ?? unit ?? '',
      source: 'config',
      ...(unit ? { unit } : {}),
      ...(charMeta ? { canonicalName: charMeta.name } : {}),
      isVariant: VARIANT_RULES.some((r) =>
        r.variantNamePatterns.some((re) => re.test(persona.name) || re.test(h1))
      )
    })
  }

  const byKey = new Map<string, PersonaEntry>()
  for (const entry of entries) {
    byKey.set(dedupeKeyForPersona(entry), entry)
  }
  return [...byKey.values()]
}

function asciiTokenMatches(haystack: string, token: string): boolean {
  const lowerToken = token.toLowerCase()
  if (/^[a-z0-9_]+$/.test(lowerToken) && lowerToken.length <= 3) {
    const escaped = lowerToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?:^|[^a-z])${escaped}(?:[^a-z]|$)`).test(haystack)
  }
  return haystack.includes(lowerToken)
}

function contextMatchesVariant(persona: PersonaEntry, contextText: string): boolean {
  if (!contextText) return false
  if (contextText.includes(persona.name)) return true
  const canonical = persona.canonicalName ?? ''
  for (const rule of VARIANT_RULES) {
    if (
      rule.canonicalName === canonical ||
      rule.variantNamePatterns.some((re) => re.test(persona.name))
    ) {
      if (rule.contextExclude?.test(contextText)) return false
      if (rule.contextInclude.test(contextText)) return true
    }
  }
  return false
}

/**
 * 为一个模型找到最贴切的人格：
 * 1. 支持按 `cloudId / path / outfitLabel / unit / options.unitHint / options.contextText` 区分 5 团虚拟歌手；
 * 2. 支持 `options.contextText` 触发形态变体（如优男彰人 / 优等生真冬），默认优先主形态；
 * 3. 兼容旧版双参数调用 `personaFor(personas, model)`。
 */
export function personaFor(
  personas: PersonaEntry[],
  model: CatalogModel,
  options?: PersonaLookupOptions
): PersonaEntry | null {
  if (personas.length === 0) return null

  const names = [model.name, model.shortName ?? '']
    .filter(Boolean)
    .map((value) => value.toLowerCase())

  const modelUnit =
    inferUnitFromText(model.cloudId ?? '') ??
    inferUnitFromText(model.path ?? '') ??
    inferUnitFromText(model.outfitLabel ?? '') ??
    inferUnitFromText(model.name ?? '') ??
    normalizeUnit(model.unit)
  const hintUnit = normalizeUnit(options?.unitHint) ?? inferUnitFromText(options?.unitHint ?? '')
  const contextUnit = inferUnitFromText(options?.contextText ?? '')
  const targetUnit = modelUnit ?? hintUnit ?? contextUnit

  const haystack =
    `${model.id} ${model.cloudId ?? ''} ${model.path} ${model.outfitLabel ?? ''} ${model.name}`.toLowerCase()
  const contextText = options?.contextText?.trim() ?? ''

  let best: PersonaEntry | null = null
  let bestScore = 0

  for (const persona of personas) {
    let baseScore = 0
    const pName = persona.name.toLowerCase()
    const pCanonical = persona.canonicalName?.toLowerCase() ?? ''
    const pAliases = persona.aliases.filter(Boolean).map((a) => a.toLowerCase())

    if (names.includes(pName)) {
      baseScore = Math.max(baseScore, 100)
    }
    if (pCanonical && names.includes(pCanonical)) {
      baseScore = Math.max(baseScore, 85)
    }
    if (pAliases.some((alias) => names.includes(alias))) {
      baseScore = Math.max(baseScore, 75)
    }

    if (baseScore === 0) {
      for (const alias of pAliases) {
        if (alias.length >= 3 && asciiTokenMatches(haystack, alias)) {
          baseScore = Math.max(baseScore, 45)
        }
      }
      if (pCanonical && pCanonical.length >= 2 && haystack.includes(pCanonical)) {
        baseScore = Math.max(baseScore, 40)
      }
      if (pName.length >= 2 && haystack.includes(pName)) {
        baseScore = Math.max(baseScore, 45)
      }
    }

    if (baseScore === 0) continue

    let score = baseScore
    const personaUnit = normalizeUnit(persona.unit) ?? normalizeUnit(persona.group)
    const canonicalChar = findCharacterMeta(persona.canonicalName ?? persona.name)
    const isVs = Boolean(canonicalChar && isVirtualSinger(canonicalChar.characterId))

    if (targetUnit && personaUnit) {
      if (personaUnit === targetUnit) {
        score += modelUnit && personaUnit === modelUnit ? 220 : 200
      } else if (isVs) {
        score -= 120
      }
    } else if (isVs && targetUnit && !personaUnit) {
      score += 10
    }

    if (persona.isVariant) {
      if (contextMatchesVariant(persona, contextText)) {
        score += 150
      } else {
        score -= 150
      }
    }

    if (score > bestScore) {
      bestScore = score
      best = persona
    }
  }

  return bestScore > 0 ? best : null
}

export const GENERIC_PROFILE =
  '未配置专属人设：依据角色名、当前场景与其他角色的互动自然演绎，保持前后一致；不要提及自己是 AI 或程序。'

const DIALOGUE_PERSONA_MAX_CHARS = 11000
const PLANNING_PERSONA_MAX_CHARS = 4200
const ACTING_PERSONA_MAX_CHARS = 2200

interface SectionRange {
  start: number
  end: number
  title: string
}

function sectionRanges(lines: string[], wanted: string[]): SectionRange[] {
  const ranges: SectionRange[] = []
  for (let index = 0; index < lines.length; index++) {
    const match = /^(#{2,3})\s+(.+?)\s*$/.exec(lines[index])
    if (!match) continue
    const level = match[1].length
    const title = match[2]
    if (!wanted.some((keyword) => title.includes(keyword))) continue
    let end = lines.length
    for (let next = index + 1; next < lines.length; next++) {
      const heading = /^(#{1,6})\s+/.exec(lines[next])
      if (heading && heading[1].length <= level) {
        end = next
        break
      }
    }
    ranges.push({ start: index, end, title })
  }
  // 合并重叠区间（例如 H2「角色档案」覆盖其下的 H3）
  ranges.sort((a, b) => a.start - b.start)
  const merged: SectionRange[] = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range.start < last.end) {
      last.end = Math.max(last.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

/** 站内统一术语规范：保留 Wonderhoy / 宁宁号，覆盖国服官译 Wonderhoi / 宁宁机器人。 */
export function normalizePjskTerminology(text: string): string {
  if (!text) return text
  return text
    .replace(/Wonderho([～~ー-]*)i/gi, (_m, wave: string) => `Wonderho${wave}y`)
    .replace(/宁宁机器人/g, '宁宁号')
}

function truncateAtLine(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const cut = text.slice(0, maxChars)
  const lineEnd = cut.lastIndexOf('\n')
  const body = (lineEnd > maxChars * 0.6 ? cut.slice(0, lineEnd) : cut).trimEnd()
  return `${body}\n……`
}

const CHATBOT_NOISE_HEADING_RE = /^(?:安全与防御协议|身份防御|注入防御|交互协议)$/
const CHATBOT_NOISE_BULLET_RE =
  /^-\s*(?:格式限制|禁止换行|长度限制|长度控制|隐私保护|等待启动|向真人学习(?:与有来有回)?|有来有回|拒绝重复|禁止CP话题|打字聊天感(?:与换行)?)\s*[：:]/
const CHATBOT_IF_THEN_DROP_RE =
  /^\s*-\s*IF\b.*(?:收到.*图片|只有图|发来.*图|非文字图片|乱码|逻辑混乱|消息顺序|好友验证|审问|钓鱼|惹我生气|惹怒|死缠烂打|自证|土味情话|油腻|撩人)/i

/**
 * 仅剥离面向聊天机器人的协议噪声（安全与防御协议 / 身份防御 / 注入防御 / 格式限制 /
 * 乱码・网速・土味情话类 IF-THEN），完整保留核心机制、人际关系、心理模型、语言风格与实质禁忌。
 */
export function stripPersonaProtocolNoise(text: string): string {
  if (!text) return text
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let skipUntilLevel = 0
  let inSecurityPreamble = false
  let inIfThenBlock = false
  let ifThenHeaderIdx = -1
  let ifThenKeptCount = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line)

    if (headingMatch) {
      if (inIfThenBlock && ifThenKeptCount === 0 && ifThenHeaderIdx >= 0) {
        out.splice(ifThenHeaderIdx)
      }
      inIfThenBlock = false
      ifThenHeaderIdx = -1
      ifThenKeptCount = 0

      const level = headingMatch[1].length
      const title = headingMatch[2].trim()
      if (skipUntilLevel > 0 && level <= skipUntilLevel) {
        skipUntilLevel = 0
      }
      if (skipUntilLevel > 0) continue

      if (title === '安全与防御协议') {
        inSecurityPreamble = true
        // 仅跳过该标题行及其直属导语，保留其下有价值的 ### 核心禁忌，同时过滤身份防御/注入防御
        continue
      }
      if (title === '交互协议') {
        skipUntilLevel = level
        continue
      }
      inSecurityPreamble = false
      if (CHATBOT_NOISE_HEADING_RE.test(title)) {
        skipUntilLevel = level
        continue
      }
      out.push(line)
      continue
    }

    if (skipUntilLevel > 0) continue
    if (inSecurityPreamble) {
      if (/^本部分为最高优先级|^$|^-{3,}$/.test(line.trim())) continue
      inSecurityPreamble = false
    }

    if (/^-\s*特殊输入处理\s*\(IF-THEN\)[：:]?/.test(line.trim())) {
      inIfThenBlock = true
      ifThenHeaderIdx = out.length
      ifThenKeptCount = 0
      out.push(line)
      continue
    }

    if (inIfThenBlock) {
      if (/^-\s+[^\s]/.test(line)) {
        if (ifThenKeptCount === 0 && ifThenHeaderIdx >= 0) {
          out.splice(ifThenHeaderIdx)
        }
        inIfThenBlock = false
        ifThenHeaderIdx = -1
      } else {
        if (CHATBOT_IF_THEN_DROP_RE.test(line)) continue
        if (line.trim()) ifThenKeptCount++
        out.push(line)
        continue
      }
    }

    if (CHATBOT_NOISE_BULLET_RE.test(line.trim())) continue

    const cleanedLine = line
      .replace(
        /严禁在输出中使用任何形式的换行(?:[（(][^）)]*[）)])?[，,]?\s*(?:始终只输出一个连续的段落[。.]?)?/g,
        ''
      )
      .replace(
        /[，,、]?\s*或括号心理描写(?:[（(][^）)]*[）)])?(?:也严禁带括号输出)?[）)]*[，,]?\s*(?:严格维持纯打字聊天质感[。.]?)?/g,
        ''
      )
    if (line.trim() && (!cleanedLine.trim() || /^-\s*$/.test(cleanedLine.trim()))) continue
    out.push(cleanedLine)
  }

  if (inIfThenBlock && ifThenKeptCount === 0 && ifThenHeaderIdx >= 0) {
    out.splice(ifThenHeaderIdx)
  }

  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractBulletBlocks(lines: string[], wantedPrefixes: string[]): string[] {
  const blocks: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (!trimmed.startsWith('- ')) continue
    const label = trimmed.slice(2).split(/[：:]/)[0]
    if (!wantedPrefixes.some((prefix) => label.includes(prefix))) continue
    const blockLines = [lines[i]]
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]
      if (/^#{1,6}\s+/.test(next) || /^-\s+[^\s]/.test(next)) break
      if (next.trim() === '' && j + 1 < lines.length && /^-\s+[^\s]/.test(lines[j + 1])) break
      blockLines.push(next)
      i = j
    }
    const text = blockLines.join('\n').trim()
    if (text) blocks.push(text)
  }
  return blocks
}

function packChunks(chunks: string[], maxChars: number): string {
  let output = ''
  for (const raw of chunks) {
    const chunk = raw.trim()
    if (!chunk) continue
    const candidate = output ? `${output}\n\n${chunk}` : chunk
    if (candidate.length <= maxChars) {
      output = candidate
      continue
    }
    if (output.length < maxChars * 0.85) {
      const remaining = maxChars - (output ? output.length + 2 : 0)
      if (remaining >= 120) {
        output = output
          ? `${output}\n\n${truncateAtLine(chunk, remaining)}`
          : truncateAtLine(chunk, maxChars)
      }
    }
    break
  }
  return output
}

function splitTopHeadingAndBody(text: string): { h1: string; bodyLines: string[] } {
  const lines = text.split('\n')
  if (lines.length > 0 && /^#\s+/.test(lines[0])) {
    return { h1: lines[0].trim(), bodyLines: lines.slice(1) }
  }
  return { h1: '', bodyLines: lines }
}

/**
 * Stage 1（选角、分幕规划与剧情钩子）专用精炼人设：
 * 提取核心机制、核心性格、内在信念、人际关系、重要记忆与情境要点。
 */
export function planningPersonaPrompt(
  persona: PersonaEntry | null,
  maxChars = PLANNING_PERSONA_MAX_CHARS
): string {
  if (!persona) return ''
  const raw = normalizePjskTerminology(persona.prompt.trim())
  if (!raw) return ''
  const cleaned = stripPersonaProtocolNoise(raw)
  if (!cleaned) return ''

  const { h1, bodyLines } = splitTopHeadingAndBody(cleaned)
  const coreMech = sectionRanges(bodyLines, ['核心机制']).map((r) =>
    bodyLines.slice(r.start, r.end).join('\n').trim()
  )
  const psycheTraits = extractBulletBlocks(bodyLines, ['核心性格', '内在信念'])
  const relations = extractBulletBlocks(bodyLines, ['人际关系'])
  const memories = extractBulletBlocks(bodyLines, ['重要记忆', '当前状态'])
  const contextHooks = extractBulletBlocks(bodyLines, [
    '情境驱动',
    '话题处理方式',
    '绝对保密事项',
    '边界与分寸',
    '绝对认知边界',
    '绝对时间线',
    '风格特点'
  ])
  const envSection = sectionRanges(bodyLines, ['环境感知']).map((r) =>
    bodyLines.slice(r.start, r.end).join('\n').trim()
  )

  const parts: string[] = []
  if (h1) parts.push(h1)
  parts.push(...coreMech)
  if (psycheTraits.length > 0) parts.push(`### 性格与信念\n${psycheTraits.join('\n')}`)
  if (relations.length > 0) parts.push(`### 人际关系\n${relations.join('\n')}`)
  if (memories.length > 0) parts.push(`### 重要记忆与现状\n${memories.join('\n')}`)
  if (contextHooks.length > 0) parts.push(`### 情境要点\n${contextHooks.join('\n')}`)
  parts.push(...envSection)

  const packed = packChunks(parts, maxChars)
  if (packed.length >= 200 || cleaned.length <= maxChars) {
    return packed || truncateAtLine(cleaned, maxChars)
  }
  return truncateAtLine(cleaned, maxChars)
}

/**
 * Stage 2（对白编写）专用人设：
 * 剔除聊天机器人安全/注入/乱码等协议噪声后，按优先级保留：
 * 核心机制 -> 语言与风格 -> 人际关系 -> 心理模型/重要记忆 -> 共情公式/上下文与逻辑 -> 核心禁忌/环境感知。
 */
export function dialoguePersonaPrompt(
  persona: PersonaEntry | null,
  maxChars = DIALOGUE_PERSONA_MAX_CHARS
): string {
  if (!persona) return ''
  const raw = normalizePjskTerminology(persona.prompt.trim())
  if (!raw) return ''

  const hasNoiseMarkers =
    /(?:安全与防御协议|身份防御|注入防御|交互协议|特殊输入处理|格式限制|禁止换行|长度限制|长度控制|隐私保护|等待启动|向真人学习|有来有回|拒绝重复|打字聊天感|禁止CP话题|严禁在输出中使用|括号心理描写)/.test(
      raw
    )
  const cleaned = hasNoiseMarkers ? stripPersonaProtocolNoise(raw) : raw
  if (!cleaned) return truncateAtLine(raw, maxChars)
  if (cleaned.length <= maxChars && !hasNoiseMarkers) return cleaned

  const { h1, bodyLines } = splitTopHeadingAndBody(cleaned)
  const h2Ranges = sectionRanges(bodyLines, [
    '核心机制',
    '语言与风格',
    '角色档案',
    '知识与边界',
    '共情公式',
    '上下文与逻辑',
    '环境感知',
    '核心禁忌'
  ])

  if (h2Ranges.length === 0) return truncateAtLine(cleaned, maxChars)

  // 提取可单独提权的细粒度区块（人际关系 / 心理模型 / 重要记忆），防止被长篇基本信息挤出
  const relationBlocks = extractBulletBlocks(bodyLines, ['人际关系'])
  const psycheRanges = sectionRanges(bodyLines, ['心理模型'])
  const basicInfoRanges = sectionRanges(bodyLines, ['基本信息'])
  const memoryBlocks = extractBulletBlocks(bodyLines, ['重要记忆'])

  const findH2 = (kw: string): string =>
    h2Ranges.find((r) => r.title.includes(kw))
      ? bodyLines
          .slice(
            h2Ranges.find((r) => r.title.includes(kw))!.start,
            h2Ranges.find((r) => r.title.includes(kw))!.end
          )
          .join('\n')
          .trim()
      : ''

  const knowledgeFull = findH2('知识与边界')
  const knowledgeWithoutRelations = knowledgeFull
    ? knowledgeFull
        .split('\n')
        .filter((line) => !relationBlocks.some((b) => b.split('\n').includes(line)))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    : ''

  const priorityChunks: string[] = []
  if (h1) priorityChunks.push(h1)
  const coreMech = findH2('核心机制')
  if (coreMech) priorityChunks.push(coreMech)
  const langStyle = findH2('语言与风格')
  if (langStyle) priorityChunks.push(langStyle)
  if (relationBlocks.length > 0) priorityChunks.push(`### 人际关系\n${relationBlocks.join('\n')}`)

  if (psycheRanges.length > 0) {
    for (const r of psycheRanges) {
      priorityChunks.push(bodyLines.slice(r.start, r.end).join('\n').trim())
    }
  } else if (memoryBlocks.length > 0) {
    priorityChunks.push(memoryBlocks.join('\n'))
  }

  const empathy = findH2('共情公式')
  if (empathy) priorityChunks.push(empathy)
  const contextLogic = findH2('上下文与逻辑')
  if (contextLogic) priorityChunks.push(contextLogic)
  const taboos = findH2('核心禁忌')
  if (taboos) priorityChunks.push(taboos)
  if (knowledgeWithoutRelations && knowledgeWithoutRelations !== '## 知识与边界') {
    priorityChunks.push(knowledgeWithoutRelations)
  }
  for (const r of basicInfoRanges) {
    priorityChunks.push(bodyLines.slice(r.start, r.end).join('\n').trim())
  }
  const env = findH2('环境感知')
  if (env) priorityChunks.push(env)

  const packed = packChunks(priorityChunks, maxChars)
  if (packed.length >= 200 || cleaned.length <= maxChars) {
    return packed || truncateAtLine(cleaned, maxChars)
  }
  return truncateAtLine(cleaned, maxChars)
}

/**
 * Stage 3（演技导演 / 语音情绪导演）专用精炼人设：
 * 提取核心性格、情绪驱动、表里反差（风格特点）、外貌神态/微表情线索与演戏基调。
 */
export function actingPersonaPrompt(
  persona: PersonaEntry | null,
  maxChars = ACTING_PERSONA_MAX_CHARS
): string {
  if (!persona) return ''
  const raw = normalizePjskTerminology(persona.prompt.trim())
  if (!raw) return ''
  const cleaned = stripPersonaProtocolNoise(raw)
  const { h1, bodyLines } = splitTopHeadingAndBody(cleaned)

  const appearance = extractBulletBlocks(bodyLines, ['外貌'])
  const coreCharacter = extractBulletBlocks(bodyLines, ['核心性格'])
  const emotionDrive = extractBulletBlocks(bodyLines, ['情绪驱动'])
  const styleContrast = extractBulletBlocks(bodyLines, ['风格特点'])
  const acting = characterActingProfile(
    `${persona.name} ${persona.canonicalName ?? ''} ${persona.unit ?? ''}`,
    cleaned
  )

  const chunks: string[] = []
  if (h1) chunks.push(h1)
  chunks.push(`演戏基调（${acting.temperament}）：${acting.actingNote}`)
  if (coreCharacter.length > 0) chunks.push(coreCharacter.join('\n'))
  if (emotionDrive.length > 0) chunks.push(emotionDrive.join('\n'))
  if (styleContrast.length > 0) chunks.push(styleContrast.join('\n'))
  if (appearance.length > 0) chunks.push(appearance.join('\n'))

  const packed = packChunks(chunks, maxChars)
  return packed || truncateAtLine(cleaned, maxChars)
}

// ---------------------------------------------------------------------------
// 人际称呼表提取（供 Stage 1 / Stage 2 / dialogueLinter 直接复用）
// ---------------------------------------------------------------------------

interface TargetLookup {
  raw: string
  canonical: string
  shortName: string
  familyName: string
  matchKeys: string[]
}

const KNOWN_FAMILY_NAMES = [
  '小豆泽',
  '朝比奈',
  '日野森',
  '东云',
  '宵崎',
  '晓山',
  '天马',
  '星乃',
  '望月',
  '花里',
  '桐谷',
  '桃井',
  '白石',
  '青柳',
  '凤',
  '草薙',
  '神代',
  '古泷'
]

function buildTargetLookup(
  name: string,
  personas: PersonaEntry[],
  options?: PersonaLookupOptions
): TargetLookup {
  const persona = resolvePersonaByName(personas, name, options)
  const canonical = persona?.canonicalName ?? findCharacterMeta(name)?.name ?? name
  const charMeta = findCharacterMeta(canonical) ?? findCharacterMeta(name)
  const shortName = charMeta?.shortName ?? canonical
  const matchedFamily = KNOWN_FAMILY_NAMES.find((f) => canonical.startsWith(f)) ?? ''
  const matchKeys = dedupeStrings([
    name,
    canonical,
    shortName,
    matchedFamily,
    ...(charMeta ? [charMeta.name, charMeta.shortName] : [])
  ])
  return {
    raw: name,
    canonical,
    shortName,
    familyName: matchedFamily,
    matchKeys
  }
}

/**
 * 按名字或别名解析角色人设，支持通过 `options.unitHint` / `options.contextText`
 * 精准区分 5 团虚拟歌手与形态变体（向后兼容双参数调用）。
 */
export function resolvePersonaByName(
  personas: PersonaEntry[],
  name: string,
  options?: PersonaLookupOptions
): PersonaEntry | null {
  const trimmed = name.trim()
  if (!trimmed || personas.length === 0) return null
  const lower = trimmed.toLowerCase()

  const nameUnit = inferUnitFromText(trimmed)
  const hintUnit = normalizeUnit(options?.unitHint) ?? inferUnitFromText(options?.unitHint ?? '')
  const contextUnit = inferUnitFromText(options?.contextText ?? '')
  const targetUnit = nameUnit ?? hintUnit ?? contextUnit
  const contextText = options?.contextText?.trim() ?? ''
  const canonicalLookup = findCharacterMeta(trimmed)?.name.toLowerCase() ?? ''

  let best: PersonaEntry | null = null
  let bestScore = 0

  for (const p of personas) {
    const pName = p.name.toLowerCase()
    const pCanonical = p.canonicalName?.toLowerCase() ?? ''
    const pAliases = p.aliases.filter(Boolean).map((a) => a.toLowerCase())

    let baseScore = 0
    if (pName === lower) baseScore = 100
    else if (pCanonical === lower) baseScore = 85
    else if (pAliases.includes(lower)) baseScore = 75
    else if (canonicalLookup && pCanonical === canonicalLookup) baseScore = 70
    if (baseScore === 0) continue

    let score = baseScore
    const personaUnit = normalizeUnit(p.unit) ?? normalizeUnit(p.group)
    const canonicalChar = findCharacterMeta(p.canonicalName ?? p.name)
    const isVs = Boolean(canonicalChar && isVirtualSinger(canonicalChar.characterId))

    if (targetUnit && personaUnit) {
      if (personaUnit === targetUnit) {
        score += nameUnit && personaUnit === nameUnit ? 220 : 200
      } else if (isVs) {
        score -= 120
      }
    } else if (isVs && targetUnit && !personaUnit) {
      score += 10
    }

    if (p.isVariant) {
      if (pName === lower || contextMatchesVariant(p, contextText)) {
        score += 150
      } else {
        score -= 50
      }
    }

    if (score > bestScore) {
      bestScore = score
      best = p
    }
  }

  return bestScore > 0 ? best : null
}

function cleanCallToken(raw: string): string {
  return raw
    .replace(/^称呼(?:严格|固定)?(?:为|为|是)?[：:]?\s*/i, '')
    .replace(
      /^(?:对[^\s，,：:]+)?(?:固定)?(?:亲昵地|日常|现在|一般|偶尔)?(?:直呼|叫|称呼|称)[：:]?\s*/i,
      ''
    )
    .replace(/[“”"「」『』]/g, '')
    .trim()
}

function extractCallFromParen(
  parenContent: string,
  target: TargetLookup,
  isGroupSubject = false
): string {
  const withoutIncoming = parenContent
    .replace(/[，,；;]\s*(?:她|他|对方)叫你[^，,；;]*/g, '')
    .replace(/[，,；;]\s*对(?:机器人|宁宁号)[^，,；;]*/g, '')
    .trim()
  if (!withoutIncoming) return ''

  // 1. 「A→B」形式取箭头后的当前日常称呼
  const arrowMatch = /[→➜➡]\s*[“"「]?([^”"」，,；;）)]+)[”"」]?/.exec(withoutIncoming)
  if (arrowMatch?.[1]) {
    const cleaned = cleanCallToken(arrowMatch[1])
    if (cleaned) return cleaned
  }

  // 2. 「线下和日常叫“真冬”」/ 「日常叫“XX”」优先于「网上叫“XX”」（排除“绝不再用/严禁叫”否定表述）
  const offlineMatch =
    /(?:线下|日常|现在|固定(?:亲昵地)?叫)(?:(?!绝不|不再|严禁|不叫|不用)[^“"「\n]){0,8}[“"「]([^”"」]+)[”"」]/.exec(
      withoutIncoming
    )
  if (offlineMatch?.[1]) {
    const cleaned = cleanCallToken(offlineMatch[1])
    if (cleaned) return cleaned
  }

  // 3. 群体虚拟歌手括号：直呼“未来”“铃”“连”...
  const allQuoted = [...withoutIncoming.matchAll(/[“"「]([^”"」]+)[”"」]/g)].map((m) => m[1].trim())
  if (isGroupSubject && allQuoted.length > 1) {
    const hit = allQuoted.find(
      (q) =>
        q === target.shortName ||
        q === target.canonical ||
        (target.familyName && q.includes(target.familyName)) ||
        (target.shortName.length >= 1 && q.includes(target.shortName))
    )
    if (hit) return hit
  }

  // 4. 常规第一段（如「冬弥，动真格时叫“搭档”」 / 「称呼"司"」 / 「心羽，早年叫过...」）
  const firstSegment = withoutIncoming.split(/[，,；;/或]/)[0] ?? ''
  const quotedInFirst = /[“"「]([^”"」]+)[”"」]/.exec(firstSegment)?.[1]
  if (quotedInFirst) {
    const cleaned = cleanCallToken(quotedInFirst)
    if (cleaned && !/^(?:我|你)$/.test(cleaned)) return cleaned
  }
  const plain = cleanCallToken(firstSegment)
  if (plain && !plain.includes('不') && !plain.includes('严禁') && plain.length <= 10) {
    return plain
  }
  return allQuoted[0] ?? ''
}

function tokenMatchesTarget(token: string, target: TargetLookup): boolean {
  const t = token.trim()
  if (!t || t.length > 12) return false
  if (t === target.canonical || t === target.shortName || t === target.raw) return true
  if (target.familyName && t.includes(target.familyName)) return true
  if (target.shortName.length >= 2 && t.includes(target.shortName)) return true
  // 单字名如 杏 / 司 / 类 / 遥 / 雫 / 铃 / 连 / 奏
  if (
    target.shortName.length === 1 &&
    (t === `小${target.shortName}` ||
      t === `${target.shortName}前辈` ||
      t === `${target.shortName}学姐` ||
      t === `${target.shortName}学长` ||
      t === `${target.shortName}君` ||
      t === `${target.shortName}姐` ||
      t === `${target.shortName}哥` ||
      t === `${target.shortName}亲` ||
      t === `${target.shortName}${target.shortName}`)
  ) {
    return true
  }
  return false
}

function extractCallFromPersonaLines(
  persona: PersonaEntry,
  target: TargetLookup
): { zh: string; note?: string } | null {
  const lines = persona.prompt.replace(/\r\n/g, '\n').split('\n')

  // 1. 优先从 `- 人际关系：` 子条目提取
  const relStart = lines.findIndex((l) => /^-\s*人际关系/.test(l.trim()))
  const relSubLines: string[] = []
  if (relStart >= 0) {
    for (let i = relStart + 1; i < lines.length; i++) {
      const l = lines[i]
      if (/^#{1,6}\s+/.test(l) || /^-\s+[^\s]/.test(l)) break
      if (l.trim().startsWith('- ')) relSubLines.push(l.trim().slice(2))
    }
  }

  for (const sub of relSubLines) {
    const header = sub.split(/[：:](?![^（(]*[）)])/)[0] ?? sub
    // 1a. 多人并列 `A（callA）、B（callB）`
    const pairMatches = [...header.matchAll(/([^（(、，,\s：:与和]+)\s*[（(]([^）)]+)[）)]/g)]
    for (const pm of pairMatches) {
      const subject = pm[1].trim()
      const paren = pm[2].trim()
      const isGroup =
        subject.includes('虚拟歌手') &&
        ['初音未来', '镜音铃', '镜音连', '巡音流歌', 'MEIKO', 'KAITO'].includes(target.canonical)
      const subjectHits =
        subject === target.canonical ||
        subject === target.raw ||
        subject === target.shortName ||
        isGroup
      if (!subjectHits) continue
      const zh = extractCallFromParen(paren, target, isGroup)
      if (zh) return { zh, note: paren }
    }

    // 1b. 无括号直列称呼列表（如 `MEIKO小姐、未来、连、铃、流歌姐、KAITO先生`）
    if (pairMatches.length === 0) {
      const tokens = header.split(/[、，,]/).map((s) => cleanCallToken(s))
      for (const tok of tokens) {
        if (tokenMatchesTarget(tok, target)) {
          return { zh: tok }
        }
      }
    }
  }

  // 2. 回退从 `- 口语化` / `称呼...` 规则行提取
  const callLines = lines.filter((l) => /称呼|人际关系|队外熟人|其他熟人|虚拟歌手/.test(l))
  for (const line of callLines) {
    // 显式 `Target叫"Call"`
    for (const key of target.matchKeys) {
      if (!key) continue
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const m = new RegExp(
        `${escaped}(?:叫|称为|称呼为|称)[“"「]?([^”"」，,。；;\\s]+)[”"」]?`
      ).exec(line)
      if (m?.[1]) {
        const cleaned = cleanCallToken(m[1])
        if (cleaned && cleaned.length <= 10) return { zh: cleaned }
      }
    }

    // 显式 `称呼：...` 列表项匹配
    const callClause = /称呼[^。\n]*?[：:]([^。\n]+)/.exec(line)?.[1]
    if (callClause) {
      const tokens = callClause
        .split(/[、，,]/)
        .map((s) => s.replace(/[（(][^）)]*[）)]/g, '').trim())
        .map((s) => cleanCallToken(s))
      for (const tok of tokens) {
        if (tokenMatchesTarget(tok, target)) return { zh: tok }
      }
    }

    // 括号举例子列表（如 `（望月同学、星乃同学...）` / `（“小咲希”“小穗波”...）`）
    const parenMatches = [...line.matchAll(/[（(]([^）)]+)[）)]/g)]
    for (const pm of parenMatches) {
      const quoted = [...pm[1].matchAll(/[“"「]([^”"」]+)[”"」]/g)].map((m) => cleanCallToken(m[1]))
      for (const tok of quoted) {
        if (tokenMatchesTarget(tok, target)) return { zh: tok }
      }
      const tokens = pm[1].split(/[、，,]/).map((s) => cleanCallToken(s.replace(/等$/, '')))
      for (const tok of tokens) {
        if (tokenMatchesTarget(tok, target)) return { zh: tok }
        if (tok.length > 4) {
          const shortEsc = target.shortName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const famEsc = target.familyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const m = new RegExp(
            `(?:小${shortEsc}|${famEsc}(?:同学|学姐|学长|小姐|先生|前辈)|${shortEsc}(?:前辈|学姐|学长|小姐|先生|君|姐|哥|亲)?)`
          ).exec(tok)
          if (m?.[0] && tokenMatchesTarget(m[0], target)) return { zh: m[0] }
        }
      }
    }
  }

  // 3. 明确通则回退：虚拟歌手直呼其名
  const fullText = persona.prompt
  if (
    ['初音未来', '镜音铃', '镜音连', '巡音流歌', 'MEIKO', 'KAITO'].includes(target.canonical) &&
    /虚拟歌手[^。\n]{0,16}直呼(?:其)?名/.test(fullText)
  ) {
    return { zh: target.shortName === '初音' ? '未来' : target.shortName }
  }

  return null
}

/**
 * 从角色人设的 `人际关系` 与 `口语化` 章节直接提取两两官方称呼规则，
 * 供 Stage 1 规划、Stage 2 对白及 dialogueLinter 复用。
 * 支持可选第 3 参数 `options`（`unitHint` / `contextText`）区分 5 团虚拟歌手，向后兼容双参数调用。
 */
export function extractPairwiseAddressBook(
  personas: PersonaEntry[],
  names: string[],
  options?: PersonaLookupOptions
): PairwiseAddressRule[] {
  const uniqueNames = dedupeStrings(names)
  if (uniqueNames.length < 2 || personas.length === 0) return []

  const effectiveUnitHint =
    normalizeUnit(options?.unitHint) ??
    inferUnitFromText(options?.unitHint ?? '') ??
    inferUnitFromText(options?.contextText ?? '') ??
    inferUnitFromText(uniqueNames.join(' '))
  const lookupOptions: PersonaLookupOptions | undefined =
    effectiveUnitHint || options?.contextText
      ? {
          ...(effectiveUnitHint ? { unitHint: effectiveUnitHint } : {}),
          ...(options?.contextText ? { contextText: options.contextText } : {})
        }
      : undefined

  const lookups = uniqueNames.map((n) => buildTargetLookup(n, personas, lookupOptions))
  const rules: PairwiseAddressRule[] = []

  for (let i = 0; i < uniqueNames.length; i++) {
    const fromName = uniqueNames[i]
    const fromPersona = resolvePersonaByName(personas, fromName, lookupOptions)
    if (!fromPersona) continue

    for (let j = 0; j < uniqueNames.length; j++) {
      if (i === j) continue
      const target = lookups[j]
      const extracted = extractCallFromPersonaLines(fromPersona, target)
      if (!extracted) continue
      rules.push({
        from: fromName,
        to: target.raw,
        zh: extracted.zh,
        ...(extracted.note ? { note: extracted.note } : {})
      })
    }
  }

  return rules
}

export interface CharacterActingProfile {
  restrained: boolean
  temperament: 'restrained' | 'earnest' | 'expressive' | 'theatrical' | 'playful' | 'gentle'
  actingNote: string
}

const CHARACTER_ACTING_RULES: Array<{
  pattern: RegExp
  profile: CharacterActingProfile
}> = [
  {
    pattern: /25时KAITO|26kaito_night|KAITO（无人的世界）/i,
    profile: {
      restrained: true,
      temperament: 'restrained',
      actingNote:
        '冷峻尖锐、抱臂疏离（face_serious/angry/normal），极少露笑，常用沉稳站姿或干脆别开视线压迫对方直面现实。'
    }
  },
  {
    pattern: /WS初音未来|21miku_wonder|初音未来（奇幻的世界）/i,
    profile: {
      restrained: false,
      temperament: 'playful',
      actingNote:
        '古灵精怪、猫系剧团活力（pose/glad/wink/jump），动作幅度丰富明快，鼓励伙伴时转为真挚前倾。'
    }
  },
  {
    pattern: /真冬|朝比奈|(?:^|[^a-z])mafuyu(?:[^a-z]|$)/i,
    profile: {
      restrained: true,
      temperament: 'restrained',
      actingNote:
        '表面礼貌温和（face_normal/smallmouth/苦笑），私下或 Nightcord 内流露空洞、疲惫与隐忍，忌大幅度雀跃或大笑。'
    }
  },
  {
    pattern:
      /宵崎奏|日野森志步|青柳冬弥|东云慎英|志步|冬弥|慎英|(?:^|[^a-z])(?:kanade|shiho|touya|toya|shinei)(?:[^a-z]|$)|(?:^|[\s/·，、])奏(?:$|[\s/·，、])/i,
    profile: {
      restrained: true,
      temperament: 'restrained',
      actingNote:
        '说话与动作偏沉稳内敛，情绪通过微垂眼、轻点头或安静停顿表达，仅在触动内心时才露出浅笑或明显波动。'
    }
  },
  {
    pattern:
      /草薙宁宁|宁宁|东云绘名|绘名|东云彰人|彰人|星乃一歌|一歌|(?:^|[^a-z])(?:nene|ena|akito|ichika)(?:[^a-z]|$)/i,
    profile: {
      restrained: false,
      temperament: 'earnest',
      actingNote:
        '平时直率或略带别扭，情绪来得真实且有克制转折；嘴硬或被戳中心事时常伴移开视线、微脸红或皱眉。'
    }
  },
  {
    pattern: /天马司|(?:^|[^a-z])tsukasa(?:[^a-z]|$)|(?:^|[\s/·，、])司(?:$|[\s/·，、])/i,
    profile: {
      restrained: false,
      temperament: 'theatrical',
      actingNote:
        '台词与肢体富有舞台张力（pose/forward/smug/glad），但在独处或安抚同伴时会收起夸张姿势转为认真沉稳。'
    }
  },
  {
    pattern:
      /凤笑梦|笑梦|天马咲希|咲希|花里实乃理|实乃理|白石杏|晓山瑞希|瑞希|古泷凪|(?:^|[^a-z])(?:emu|saki|minori|an|mizuki|nagi)(?:[^a-z]|$)|(?:^|[\s/·，、])(?:杏|凪)(?:$|[\s/·，、])/i,
    profile: {
      restrained: false,
      temperament: 'expressive',
      actingNote: '外在表情丰富明快；其中瑞希在触及秘密或独白时会突然收敛笑容转为低落/苦笑/闪避。'
    }
  },
  {
    pattern:
      /神代类|桃井爱莉|爱莉|镜音铃|镜音连|晓山优希|(?:^|[^a-z])(?:rui|airi|rin|len|yuuki)(?:[^a-z]|$)|(?:^|[\s/·，、])(?:类|铃|连|优希)(?:$|[\s/·，、])/i,
    profile: {
      restrained: false,
      temperament: 'playful',
      actingNote:
        '语气常带俏皮或调侃余韵（tilthead/smug/wink），切换认真话题时动作转为前倾或闭眼沉吟。'
    }
  },
  {
    pattern:
      /望月穗波|穗波|桐谷遥|日野森雫|小豆泽心羽|心羽|初音未来|初音|巡音流歌|巡音|真冬的母亲|奏的母亲|奏的父亲|(?:^|[^a-z])(?:honami|haruka|shizuku|kohane|miku|luka|meiko|kaito)(?:[^a-z]|$)|(?:^|[\s/·，、])(?:遥|雫)(?:$|[\s/·，、])/i,
    profile: {
      restrained: false,
      temperament: 'gentle',
      actingNote:
        '气质柔和包容，常用温和浅笑、点头倾听与轻声安慰；不安或犹豫时以小幅度害羞/困扰动作表现。'
    }
  }
]

/** 根据官方 PJSK 角色性格返回演戏基调（克制程度、气质与选表情/动作提示）。 */
export function characterActingProfile(nameOrPath: string, roleHint = ''): CharacterActingProfile {
  for (const rule of CHARACTER_ACTING_RULES) {
    if (rule.pattern.test(nameOrPath)) return rule.profile
  }
  if (/克制|冷静|寡言|内敛|沉默/.test(roleHint)) {
    return {
      restrained: true,
      temperament: 'restrained',
      actingNote: '言行偏克制，优先中性、认真与微表情，避免过度夸张动作。'
    }
  }
  return {
    restrained: false,
    temperament: 'earnest',
    actingNote: '随剧情情绪自然起伏，平时以点头、歪头、倾听为主，情绪高点再切换强表情。'
  }
}
