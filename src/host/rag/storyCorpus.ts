import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import type { PersonaEntry } from '../ai/personas'
import type { RagChunk, RagSourceKind } from './types'
import { computeChunkHash } from './vectorIndex'

const WINDOW_SIZE = 8
const WINDOW_STRIDE = 6

export interface LoadStoryCorpusOptions {
  localDirs?: string[]
  /** 可选直接传入的 sekai-story-search `.jsonl.br` / `.jsonl` 文件路径 */
  jsonlFiles?: string[]
  personas?: PersonaEntry[]
  includePersonas?: boolean
  /** 防止单次加载过大（默认不截断常规目录，最多 80_000 条） */
  maxChunks?: number
}

interface RawSekaiChunk {
  id?: string | number
  chunk_hash?: string
  story_id?: string | number
  story?: string
  ep?: string | number
  scenario_id?: string
  type?: string
  chars?: string[]
  char_ids?: number[]
  line_start?: number
  line_end?: number
  text?: string
  jp_text?: string
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

/** 解析 sekai-story-search 格式的 `.jsonl` 或 `.jsonl.br` 缓冲区。 */
export function parseSekaiJsonlBuffer(buf: Buffer, isBrotli = false): RagChunk[] {
  const rawBuf = isBrotli ? zlib.brotliDecompressSync(buf) : buf
  const content = rawBuf.toString('utf8')
  const chunks: RagChunk[] = []
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed) as RawSekaiChunk
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
      chunks.push({
        id,
        chunkHash,
        sourceKind: sourceKindForType(type),
        storyId,
        story,
        ep: obj.ep !== undefined ? String(obj.ep) : undefined,
        scenarioId,
        type,
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
  body: string
  charId?: number
}

function extractTalkLinesFromJson(doc: unknown): TalkLine[] {
  if (!doc || typeof doc !== 'object') return []
  const record = doc as Record<string, unknown>
  const lines: TalkLine[] = []

  // 格式 A：PJSK 官方剧情 JSON（Snippets + TalkData）
  if (Array.isArray(record.Snippets) && Array.isArray(record.TalkData)) {
    const talkData = record.TalkData as Array<Record<string, unknown>>
    for (const snip of record.Snippets as Array<Record<string, unknown>>) {
      if (snip?.Action !== 1) continue
      const refIdx = typeof snip.ReferenceIndex === 'number' ? snip.ReferenceIndex : -1
      const talk = talkData[refIdx]
      if (!talk) continue
      const body = String(talk.Body ?? '').replace(/\r?\n+/g, ' ').trim()
      if (!body) continue
      const speaker = String(talk.WindowDisplayName ?? '').trim() || '旁白'
      const talkChars = Array.isArray(talk.TalkCharacters)
        ? (talk.TalkCharacters as Array<Record<string, unknown>>)
        : []
      const charId =
        typeof talkChars[0]?.Character2dId === 'number'
          ? (talkChars[0].Character2dId as number)
          : undefined
      lines.push({ speaker, body, charId })
    }
    return lines
  }

  // 格式 B：MSST `.sekai-story.json`（snippets[{ type: 'Talk', data: { speaker, content } }]）
  if (Array.isArray(record.snippets)) {
    for (const snip of record.snippets as Array<Record<string, unknown>>) {
      if (snip?.type !== 'Talk' || !snip.data || typeof snip.data !== 'object') continue
      const data = snip.data as Record<string, unknown>
      const body = String(data.content ?? '').replace(/\r?\n+/g, ' ').trim()
      if (!body) continue
      const speaker = String(data.speaker ?? '').trim() || '旁白'
      lines.push({ speaker, body })
    }
  }
  return lines
}

/**
 * 将单份 PJSK 官方剧情 JSON 切分为 8 行滑窗（步长 6，2 行重叠），与 sekai-story-search 对齐。
 */
export function chunkPjskScenario(
  doc: unknown,
  meta: { storyId: string; story: string; scenarioId: string; type: string; ep?: string }
): RagChunk[] {
  const lines = extractTalkLinesFromJson(doc)
  if (lines.length === 0) return []

  const chunks: RagChunk[] = []
  const sourceKind = sourceKindForType(meta.type)
  for (let start = 0; start < lines.length; start += WINDOW_STRIDE) {
    const end = Math.min(lines.length, start + WINDOW_SIZE)
    const slice = lines.slice(start, end)
    if (slice.length === 0) break

    const charSet = new Set<string>()
    const charIdSet = new Set<number>()
    for (const line of slice) {
      if (line.speaker && line.speaker !== '旁白') charSet.add(line.speaker)
      if (typeof line.charId === 'number' && line.charId > 0) charIdSet.add(line.charId)
    }
    const chars = [...charSet]
    const header =
      chars.length > 0 ? `[${meta.story} | ${chars.join(', ')}]` : `[${meta.story}]`
    const body = slice.map((l) => `${l.speaker}: ${l.body}`).join('\n')
    const text = `${header}\n${body}`
    chunks.push({
      id: `${meta.scenarioId}:${start}-${end - 1}`,
      chunkHash: computeChunkHash(text),
      sourceKind,
      storyId: meta.storyId,
      story: meta.story,
      ep: meta.ep,
      scenarioId: meta.scenarioId,
      type: meta.type,
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

/**
 * 将角色完整人设 Markdown 按二级/三级标题切分为 `worldview_lore` 块，
 * 以便对话阶段能按需检索人设中被截断的细节与人际关系设定。
 */
export function chunkPersonasToLore(personas: PersonaEntry[]): RagChunk[] {
  const chunks: RagChunk[] = []
  for (const persona of personas) {
    const prompt = persona.prompt?.trim()
    if (!prompt) continue
    const sections = prompt.split(/\n(?=#{2,3}\s+)/)
    let lineCursor = 0
    for (let i = 0; i < sections.length; i++) {
      const sec = sections[i].trim()
      if (sec.length < 24) continue
      const headingMatch = /^#{2,3}\s+(.+)/.exec(sec)
      const heading = headingMatch ? headingMatch[1].trim() : '角色设定'
      const body = sec.length > 700 ? `${sec.slice(0, 700).trim()}…` : sec
      const text = `[${persona.name} · ${heading}]\n${body}`
      const chars = [persona.name, ...(persona.aliases ?? []).slice(0, 2)].filter(Boolean)
      const lineCount = body.split('\n').length
      chunks.push({
        id: `persona:${persona.name}:${i}`,
        chunkHash: computeChunkHash(text),
        sourceKind: 'worldview_lore',
        storyId: `persona:${persona.name}`,
        story: `${persona.name} 设定`,
        scenarioId: `persona:${persona.name}`,
        type: 'persona',
        chars,
        lineStart: lineCursor,
        lineEnd: lineCursor + lineCount - 1,
        text
      })
      lineCursor += lineCount + 1
    }
  }
  return chunks
}

function inferTypeFromDir(dirName: string): string {
  const lower = dirName.toLowerCase()
  if (lower.includes('actionset') || lower.includes('talk')) return 'talk'
  if (lower.includes('event')) return 'event'
  if (lower.includes('card')) return 'card'
  if (lower.includes('stor')) return 'unit'
  return 'event'
}

function scanLocalDir(dir: string, out: RagChunk[], maxChunks: number): void {
  if (!fs.existsSync(dir) || out.length >= maxChunks) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (out.length >= maxChunks) break
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      scanLocalDir(fullPath, out, maxChunks)
      continue
    }
    if (entry.name.endsWith('.jsonl.br')) {
      try {
        const loaded = parseSekaiJsonlBuffer(fs.readFileSync(fullPath), true)
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
        const loaded = parseSekaiJsonlBuffer(fs.readFileSync(fullPath), false)
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
      // 跳过元信息表（events_cn.json / areas_cn.json 等数组文件），只处理剧情对象
      const base = entry.name.replace(/\.json$/i, '')
      if (/^(events|eventStories|areas|musicSoundTracks|manifest)/i.test(base)) continue
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
        const parentName = path.basename(dir)
        const type = inferTypeFromDir(parentName)
        const storyId = base.replace(/_\d+$/, '') || base
        const chunks = chunkPjskScenario(parsed, {
          storyId,
          story: base,
          scenarioId: base,
          type
        })
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

/**
 * 加载本地所有可用语料（sekai-story-search `.jsonl.br`/`.jsonl`、本地 `cache/semantic-build` 剧情 JSON、人设 Lore）。
 */
export function loadStoryCorpus(options: LoadStoryCorpusOptions): RagChunk[] {
  const maxChunks = options.maxChunks ?? 80_000
  const chunks: RagChunk[] = []

  for (const file of options.jsonlFiles ?? []) {
    if (chunks.length >= maxChunks) break
    if (!fs.existsSync(file)) continue
    try {
      const loaded = parseSekaiJsonlBuffer(fs.readFileSync(file), file.endsWith('.br'))
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
    scanLocalDir(dir, chunks, maxChunks)
  }

  if (options.includePersonas !== false && options.personas?.length) {
    const lore = chunkPersonasToLore(options.personas)
    for (const chunk of lore) {
      if (chunks.length >= maxChunks) break
      chunks.push(chunk)
    }
  }

  return chunks
}
