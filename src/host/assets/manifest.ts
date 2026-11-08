import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

export interface ModelManifestEntry {
  id: number
  name: string
  shortName?: string
  path: string
}

/** images.yaml / bgm.yaml 共用的描述条目 */
export interface NamedManifestEntry {
  file: string
  name: string
  description: string
}

interface ModelsManifest {
  models?: ModelManifestEntry[]
}

export function readModelsManifest(file: string): ModelManifestEntry[] {
  if (!fs.existsSync(file)) return []
  const loaded = yaml.load(fs.readFileSync(file, 'utf-8')) as unknown
  if (loaded === null || loaded === undefined) return []
  if (typeof loaded !== 'object' || Array.isArray(loaded)) {
    throw new Error(`models.yaml must be a key-value mapping: ${file}`)
  }
  const models = (loaded as ModelsManifest).models
  if (!Array.isArray(models)) return []
  return models.filter((entry): entry is ModelManifestEntry => {
    return (
      !!entry &&
      typeof entry === 'object' &&
      Number.isFinite(entry.id) &&
      typeof entry.name === 'string' &&
      typeof entry.path === 'string'
    )
  })
}

const quote = (value: string): string => JSON.stringify(value)

function manifestBlock(entries: ModelManifestEntry[]): string {
  return entries
    .map((entry) => {
      const lines = [`  - id: ${entry.id}`, `    name: ${quote(entry.name)}`]
      if (entry.shortName) lines.push(`    shortName: ${quote(entry.shortName)}`)
      lines.push(`    path: ${quote(entry.path)}`)
      return lines.join('\n')
    })
    .join('\n')
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, text, 'utf-8')
  fs.renameSync(tmp, file)
}

/**
 * 把新模型追加到 models.yaml，保留文件里已有注释与条目。
 *
 * 只追加 newline + 新的 block sequence 项，不重新序列化整个 YAML；
 * 已存在的 path 会被跳过，id 从现有最大 id + 1 开始。
 */
export function appendModelsManifest(
  file: string,
  entries: Array<Omit<ModelManifestEntry, 'id'>>
): ModelManifestEntry[] {
  if (entries.length === 0) return []

  const existing = readModelsManifest(file)
  const existingPaths = new Set(existing.map((entry) => entry.path))
  let nextId = existing.reduce((max, entry) => Math.max(max, entry.id), 0) + 1

  const additions: ModelManifestEntry[] = []
  for (const entry of entries) {
    if (existingPaths.has(entry.path)) continue
    existingPaths.add(entry.path)
    additions.push({ ...entry, id: nextId++ })
  }
  if (additions.length === 0) return []

  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
  let text = original.replace(/\r\n/g, '\n')
  const block = manifestBlock(additions)

  const modelsLine = /^models:[ \t]*(.*)$/m.exec(text)
  if (!modelsLine) {
    if (text.length > 0 && !text.endsWith('\n')) text += '\n'
    text += `${text.length > 0 ? '\n' : ''}models:\n${block}\n`
    writeAtomic(file, text)
    return additions
  }

  const lineStart = modelsLine.index
  const lineEnd = lineStart + modelsLine[0].length
  const inline = (modelsLine[1] ?? '').trim()

  if (inline.length > 0) {
    // models: [] / models: 已有内联值：替换成 block sequence
    text = `${text.slice(0, lineStart)}models:\n${block}${text.slice(lineEnd)}`
    writeAtomic(file, text)
    return additions
  }

  // 找到 models 块之后的第一个顶层 key，插在它前面；没有就追加到文件末尾
  const after = text.slice(lineEnd)
  const lines = after.split('\n')
  let offset = lineEnd
  let insertAt = text.length
  for (let index = 1; index < lines.length; index++) {
    offset += lines[index - 1].length + 1
    const line = lines[index]
    if (/^[A-Za-z_][\w-]*[ \t]*:/.test(line)) {
      insertAt = offset
      break
    }
  }

  const before = text.slice(0, insertAt).replace(/\n+$/, '')
  const afterText = text.slice(insertAt)
  const joined = `${before}\n${block}\n${afterText.startsWith('\n') ? '' : '\n'}${afterText}`
  writeAtomic(file, joined)
  return additions
}

/**
 * 读取 images.yaml / bgm.yaml 里的描述数组（根键分别为 images / bgm）。
 * 文件不存在或没有该键时返回空数组；结构错误直接抛错。
 */
export function readNamedManifest(file: string, key: string): NamedManifestEntry[] {
  if (!fs.existsSync(file)) return []
  const loaded = yaml.load(fs.readFileSync(file, 'utf-8')) as unknown
  if (loaded === null || loaded === undefined) return []
  if (typeof loaded !== 'object' || Array.isArray(loaded)) {
    throw new Error(`${path.basename(file)} must be a key-value mapping: ${file}`)
  }
  const list = (loaded as Record<string, unknown>)[key]
  if (!Array.isArray(list)) return []
  return list
    .filter((entry): entry is NamedManifestEntry => {
      return (
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as NamedManifestEntry).file === 'string' &&
        (entry as NamedManifestEntry).file.length > 0
      )
    })
    .map((entry) => ({
      file: entry.file,
      name: typeof entry.name === 'string' ? entry.name : '',
      description: typeof entry.description === 'string' ? entry.description : ''
    }))
}

/**
 * 把背景/BGM 条目追加到清单，保留文件已有注释与条目。
 * 只追加新的 block sequence 项，不重新序列化整个 YAML；file 已存在则跳过。
 */
export function appendNamedManifest(
  file: string,
  key: string,
  entries: NamedManifestEntry[]
): NamedManifestEntry[] {
  if (entries.length === 0) return []

  const existing = readNamedManifest(file, key)
  const existingFiles = new Set(existing.map((entry) => entry.file))
  const additions: NamedManifestEntry[] = []
  for (const entry of entries) {
    if (!entry.file || existingFiles.has(entry.file)) continue
    existingFiles.add(entry.file)
    additions.push({
      file: entry.file,
      name: entry.name || entry.file,
      description: entry.description || ''
    })
  }
  if (additions.length === 0) return []

  const block = additions
    .map((entry) =>
      [
        `  - file: ${quote(entry.file)}`,
        `    name: ${quote(entry.name)}`,
        `    description: ${quote(entry.description)}`
      ].join('\n')
    )
    .join('\n')

  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
  let text = original.replace(/\r\n/g, '\n')
  const keyPattern = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm')
  const keyLine = keyPattern.exec(text)

  if (!keyLine) {
    if (text.length > 0 && !text.endsWith('\n')) text += '\n'
    text += `${text.length > 0 ? '\n' : ''}${key}:\n${block}\n`
    writeAtomic(file, text)
    return additions
  }

  const lineStart = keyLine.index
  const lineEnd = lineStart + keyLine[0].length
  const inline = (keyLine[1] ?? '').trim()
  if (inline.length > 0) {
    text = `${text.slice(0, lineStart)}${key}:\n${block}${text.slice(lineEnd)}`
    writeAtomic(file, text)
    return additions
  }

  const after = text.slice(lineEnd)
  const lines = after.split('\n')
  let offset = lineEnd
  let insertAt = text.length
  for (let index = 1; index < lines.length; index++) {
    offset += lines[index - 1].length + 1
    if (/^[A-Za-z_][\w-]*[ \t]*:/.test(lines[index])) {
      insertAt = offset
      break
    }
  }

  const before = text.slice(0, insertAt).replace(/\n+$/, '')
  const afterText = text.slice(insertAt)
  writeAtomic(file, `${before}\n${block}\n${afterText.startsWith('\n') ? '' : '\n'}${afterText}`)
  return additions
}
