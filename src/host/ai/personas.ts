import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import type { LlmPersona, LlmSettings } from '../config'
import type { CatalogModel } from '../resources/resourceCatalog'

export interface PersonaEntry {
  name: string
  prompt: string
  aliases: string[]
  group: string
  source: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function parsePersonaFile(file: string): PersonaEntry | null {
  const text = fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n')
  let name = path.basename(file, path.extname(file))
  let aliases: string[] = []
  let group = ''
  let body = text

  const front = FRONTMATTER.exec(text)
  if (front) {
    try {
      const meta = yaml.load(front[1]) as Record<string, unknown> | null
      if (meta && typeof meta === 'object') {
        if (typeof meta.name === 'string' && meta.name.trim()) name = meta.name.trim()
        if (typeof meta.group === 'string') group = meta.group.trim()
        if (Array.isArray(meta.aliases)) {
          aliases = meta.aliases.filter((item): item is string => typeof item === 'string')
        }
        body = text.slice(front[0].length)
      }
    } catch {
      // frontmatter 写错就当普通正文，不因为一个人格文件阻断整场生成
    }
  }

  const prompt = normalizePjskTerminology(body.trim())
  if (!prompt) return null
  return { name, prompt, aliases, group, source: file }
}

/**
 * 角色人格表：config.llm.personas + personaDirs 下的 *.md / *.txt。
 *
 * 显式配置优先于目录文件；同名条目后出现的覆盖先出现的。
 */
export function loadPersonas(settings: LlmSettings): PersonaEntry[] {
  const entries: PersonaEntry[] = []

  for (const dir of settings.personaDirs) {
    if (!fs.existsSync(dir)) continue
    const files = fs
      .readdirSync(dir)
      .filter((name) => /\.(md|txt)$/i.test(name))
      .sort()
    for (const name of files) {
      const entry = parsePersonaFile(path.join(dir, name))
      if (entry) entries.push(entry)
    }
  }

  for (const persona of settings.personas as LlmPersona[]) {
    if (!persona.name || !persona.prompt.trim()) continue
    entries.push({
      name: persona.name,
      prompt: normalizePjskTerminology(persona.prompt.trim()),
      aliases: persona.aliases ?? [],
      group: persona.group ?? '',
      source: 'config'
    })
  }

  const byName = new Map<string, PersonaEntry>()
  for (const entry of entries) byName.set(entry.name, entry)
  return [...byName.values()]
}

/**
 * 为一个模型找到人格：
 * 1. name / shortName / aliases 精确匹配
 * 2. 模型 id 里的罗马字片段（mizuki）匹配 aliases
 */
export function personaFor(personas: PersonaEntry[], model: CatalogModel): PersonaEntry | null {
  const names = [model.name, model.shortName ?? '']
    .filter(Boolean)
    .map((value) => value.toLowerCase())

  // 先按角色名精确匹配，避免别名把两个角色串在一起
  for (const persona of personas) {
    const candidates = [persona.name, ...persona.aliases]
      .filter(Boolean)
      .map((value) => value.toLowerCase())
    if (candidates.some((value) => names.includes(value))) return persona
  }

  const haystack = `${model.id} ${model.path}`.toLowerCase()
  for (const persona of personas) {
    for (const alias of persona.aliases) {
      if (alias.length >= 3 && haystack.includes(alias.toLowerCase())) return persona
    }
  }
  return null
}

export const GENERIC_PROFILE =
  '未配置专属人设：依据角色名、当前场景与其他角色的互动自然演绎，保持前后一致；不要提及自己是 AI 或程序。'

/** 对白阶段真正需要的段落；其余章节是面向聊天机器人的协议/安全/环境说明，不进剧本提示词。 */
const DIALOGUE_SECTION_ORDER = ['核心机制', '语言与风格', '角色档案', '核心禁忌']
const DIALOGUE_PERSONA_MAX_CHARS = 5000

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

/**
 * 对白/聊天提示词用的人设：长人设只保留核心身份、语言风格、角色档案与禁忌。
 *
 * 26 份完整人设约 22 万字符，其中「交互协议 / 共情公式 / 环境感知 / 注入防御」
 * 对写剧本没有帮助，却会把真正的语气信息稀释掉。短人设原样返回。
 */
export function dialoguePersonaPrompt(
  persona: PersonaEntry | null,
  maxChars = DIALOGUE_PERSONA_MAX_CHARS
): string {
  if (!persona) return ''
  const text = normalizePjskTerminology(persona.prompt.trim())
  if (!text || text.length <= maxChars) return text

  const lines = text.split('\n')
  const ranges = sectionRanges(lines, DIALOGUE_SECTION_ORDER)
  if (ranges.length === 0) return truncateAtLine(text, maxChars)

  const used = new Set<number>()
  let output = ''
  for (const keyword of DIALOGUE_SECTION_ORDER) {
    const range = ranges.find((item) => !used.has(item.start) && item.title.includes(keyword))
    if (!range) continue
    const chunk = lines.slice(range.start, range.end).join('\n').trim()
    if (!chunk) continue
    const candidate = output ? `${output}\n\n${chunk}` : chunk
    if (candidate.length <= maxChars) {
      output = candidate
      used.add(range.start)
      continue
    }
    if (output.length < maxChars * 0.6) {
      output = truncateAtLine(candidate, maxChars)
      used.add(range.start)
    }
    break
  }

  return output.length >= 600 ? output : truncateAtLine(text, maxChars)
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
    pattern: /真冬|mafuyu|朝比奈/,
    profile: {
      restrained: true,
      temperament: 'restrained',
      actingNote:
        '表面礼貌温和（face_normal/smallmouth/苦笑），私下或 Nightcord 内流露空洞、疲惫与隐忍，忌大幅度雀跃或大笑。'
    }
  },
  {
    pattern: /奏|kanade|宵崎|志步|shiho|冬弥|touya|toya/,
    profile: {
      restrained: true,
      temperament: 'restrained',
      actingNote:
        '说话与动作偏沉稳内敛，情绪通过微垂眼、轻点头或安静停顿表达，仅在触动内心时才露出浅笑或明显波动。'
    }
  },
  {
    pattern: /宁宁|nene|草薙|绘名|ena|东云|彰人|akito|一歌|ichika/,
    profile: {
      restrained: false,
      temperament: 'earnest',
      actingNote:
        '平时直率或略带别扭，情绪来得真实且有克制转折；嘴硬或被戳中心事时常伴移开视线、微脸红或皱眉。'
    }
  },
  {
    pattern: /司|tsukasa|天马司/,
    profile: {
      restrained: false,
      temperament: 'theatrical',
      actingNote:
        '台词与肢体富有舞台张力（pose/forward/smug/glad），但在独处或安抚同伴时会收起夸张姿势转为认真沉稳。'
    }
  },
  {
    pattern: /笑梦|emu|凤笑梦|咲希|saki|实乃理|minori|杏|an|瑞希|mizuki|晓山/,
    profile: {
      restrained: false,
      temperament: 'expressive',
      actingNote: '外在表情丰富明快；其中瑞希在触及秘密或独白时会突然收敛笑容转为低落/苦笑/闪避。'
    }
  },
  {
    pattern: /类|rui|神代|爱莉|airi|铃|rin|连|len/,
    profile: {
      restrained: false,
      temperament: 'playful',
      actingNote:
        '语气常带俏皮或调侃余韵（tilthead/smug/wink），切换认真话题时动作转为前倾或闭眼沉吟。'
    }
  },
  {
    pattern: /穗波|honami|遥|haruka|雫|shizuku|心羽|kohane|初音|miku|巡音|luka|meiko|kaito/,
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
  const hay = `${nameOrPath} ${roleHint}`
  for (const rule of CHARACTER_ACTING_RULES) {
    if (rule.pattern.test(hay)) return rule.profile
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
