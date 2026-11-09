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

  const prompt = body.trim()
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
      prompt: persona.prompt.trim(),
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
  const text = persona.prompt.trim()
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
