import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import type { PersonaEntry } from '../ai/personas'
import type { RagChunk, RagDomain, RagSourceKind } from './types'
import { computeChunkHash } from './vectorIndex'

export const PJSK_DOMAIN: RagDomain = 'pjsk'

const WINDOW_SIZE = 8
const WINDOW_STRIDE = 6
const FOREIGN_DOMAIN_MARKER = /\b(?:bdon\.moe|ournotes|ournotes-player)\b/i

export interface LoadStoryCorpusOptions {
  localDirs?: string[]
  /** 可选直接传入的 sekai-story-search `.jsonl.br` / `.jsonl` 文件路径 */
  jsonlFiles?: string[]
  personas?: PersonaEntry[]
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
  scenario_id?: string
  type?: string
  chars?: string[]
  char_ids?: number[]
  line_start?: number
  line_end?: number
  text?: string
  jp_text?: string
}

interface PjskTitleMaps {
  eventById: Map<string, string>
  eventByBundle: Map<string, string>
  areaById: Map<string, string>
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
      chunks.push({
        id,
        domain: PJSK_DOMAIN,
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
  if (isForeignOurnotesPayload(doc)) return []
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
  if (isForeignOurnotesPayload(doc)) return []
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
      domain: PJSK_DOMAIN,
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
        domain: PJSK_DOMAIN,
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

/**
 * 从 `cache/semantic-build` 目录加载可选的 `events_cn.json` / `areas_cn.json`（及 jp 回退），
 * 将原始文件名（如 `event_allout_2026__event_193_01`）映射为可读的 PJSK 活动/区域标题。
 */
export function loadPjskTitleMaps(rootDir: string): PjskTitleMaps {
  const eventById = new Map<string, string>()
  const eventByBundle = new Map<string, string>()
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

  // JP 先装，CN 后装以中文标题覆盖
  for (const evFile of ['events_jp.json', 'events_cn.json']) {
    for (const item of readJsonArray(evFile)) {
      const name = typeof item.name === 'string' ? item.name.trim() : ''
      if (!name) continue
      if (item.id !== undefined && item.id !== null) {
        eventById.set(String(item.id), name)
      }
      if (typeof item.assetbundleName === 'string' && item.assetbundleName.trim()) {
        eventByBundle.set(item.assetbundleName.trim().toLowerCase(), name)
      }
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

  return { eventById, eventByBundle, areaById }
}

export function resolvePjskTitle(
  baseName: string,
  type: string,
  titleMaps: PjskTitleMaps
): string {
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
    const areaMatch = /(?:area|actionset)_(\d+)/i.exec(baseName)
    if (areaMatch) {
      const idStr = String(Number(areaMatch[1]))
      const byArea = titleMaps.areaById.get(idStr) ?? titleMaps.areaById.get(areaMatch[1])
      if (byArea) return byArea
    }
  }

  return baseName
}

function inferTypeFromDir(dirName: string): string {
  const lower = dirName.toLowerCase()
  if (lower.includes('actionset') || lower.includes('talk')) return 'talk'
  if (lower.includes('event')) return 'event'
  if (lower.includes('card')) return 'card'
  if (lower.includes('stor')) return 'unit'
  return 'event'
}

function scanLocalDir(
  dir: string,
  out: RagChunk[],
  maxChunks: number,
  titleMaps: PjskTitleMaps
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
      scanLocalDir(fullPath, out, maxChunks, titleMaps)
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
      // 跳过元信息表（events_cn.json / areas_cn.json 等数组文件），只处理剧情对象
      const base = entry.name.replace(/\.json$/i, '')
      if (/^(events|eventStories|areas|musicSoundTracks|manifest)/i.test(base)) continue
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
        if (isForeignOurnotesPayload(parsed, fullPath)) continue
        const parentName = path.basename(dir)
        const type = inferTypeFromDir(parentName)
        const storyId = base.replace(/_\d+$/, '') || base
        const story = resolvePjskTitle(base, type, titleMaps)
        const chunks = chunkPjskScenario(parsed, {
          storyId,
          story,
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
    scanLocalDir(dir, chunks, maxChunks, titleMaps)
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
