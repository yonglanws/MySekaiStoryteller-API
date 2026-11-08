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
