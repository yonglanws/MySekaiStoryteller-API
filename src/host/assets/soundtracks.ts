/**
 * PJSK 官方 BGM 曲名索引（musicSoundTracks）。
 *
 * 云端拉下来的剧情 BGM 文件名是 bgm00003 这类无语义 id。sekai-master-db 的
 * musicSoundTracks.json 把它们映射到曲名与分类，作用等价于 ournotes-player
 * 里 sound_bgm_adv_* 这类可读 cue 名：AI 按曲名/分类感知氛围，而不是猜 id。
 *
 * 宿主只缓存精简后的映射（resources/audio/bgm/soundtracks.json），
 * 不把整份 master data 写进仓库；缓存缺失或网络失败时退回人工描述。
 */
import fs from 'node:fs'
import path from 'node:path'
import { assetUrl, atomicWrite, fetchJson, withSlash } from './http'
import type { RequestOptions } from './http'

export const DEFAULT_SOUNDTRACK_BASE =
  'https://cdn.jsdelivr.net/gh/Sekai-World/sekai-master-db-diff@master/'

/** jsDelivr 不通时的直连回退（部分地区需要代理才能访问 raw.githubusercontent.com） */
export const FALLBACK_SOUNDTRACK_BASE =
  'https://raw.githubusercontent.com/Sekai-World/sekai-master-db-diff/master/'

/** master data 的分类名（日文）→ 提示词里使用的中文标签 */
const CATEGORY_LABELS: Record<number, string> = {
  1: '组合综合',
  2: '虚拟歌手',
  3: 'Leo/need',
  4: 'MORE MORE JUMP!',
  5: 'Vivid BAD SQUAD',
  6: 'Wonderlands×Showtime',
  7: '25时，Nightcord de.',
  11: '游戏内',
  12: '我的世界',
  13: '剧情',
  14: 'Live',
  15: '虚拟 Live',
  16: '抽卡',
  20: '其他',
  30: '联动'
}

const CACHE_VERSION = 1
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_TITLE_CHARS = 80

export interface SoundtrackInfo {
  /** 不带扩展名的资源名，如 bgm00003 */
  file: string
  /** 同一文件可能对应多首曲目（区域 BGM） */
  titles: string[]
  /** 已中文化的分类标签，如 剧情 */
  categories: string[]
}

export interface SoundtrackIndex {
  source: string
  fetchedAt: string
  tracks: Map<string, SoundtrackInfo>
}

export interface SoundtrackLabel {
  name: string
  description: string
}

interface RawSoundtrackTrack {
  title?: unknown
  musicSoundTrackCategoryId?: unknown
  assetbundleFileName?: unknown
}

interface RawSoundtrackCategory {
  id?: unknown
  name?: unknown
}

interface CachedSoundtrackTrack {
  titles: string[]
  categories: string[]
}

interface CachedSoundtrackFile {
  version?: unknown
  source?: unknown
  fetchedAt?: unknown
  tracks?: unknown
}

/** 把资源名收成不带目录/扩展名的 key：audio/bgm/bgm00003.mp3 → bgm00003 */
export function soundtrackKey(value: string): string {
  return path.basename(value.trim()).replace(/\.[^.\\/]+$/, '')
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function categoryLabel(id: unknown, names: Map<number, string>): string {
  const numeric = typeof id === 'number' ? id : Number(id)
  if (!Number.isFinite(numeric)) return ''
  return CATEGORY_LABELS[numeric] ?? names.get(numeric) ?? ''
}

/**
 * 解析 master data 的两份 JSON。非法条目直接跳过，不阻断下载；
 * 同一资源名的多首曲目按出现顺序去重。
 */
export function parseSoundtrackIndex(
  rawTracks: unknown,
  rawCategories: unknown,
  source = '',
  fetchedAt = new Date().toISOString()
): SoundtrackIndex {
  const categoryNames = new Map<number, string>()
  if (Array.isArray(rawCategories)) {
    for (const item of rawCategories as RawSoundtrackCategory[]) {
      if (!item || typeof item !== 'object') continue
      const id = typeof item.id === 'number' ? item.id : Number(item.id)
      const name = text(item.name)
      if (Number.isFinite(id) && name) categoryNames.set(id, name)
    }
  }

  const tracks = new Map<string, SoundtrackInfo>()
  if (Array.isArray(rawTracks)) {
    for (const item of rawTracks as RawSoundtrackTrack[]) {
      if (!item || typeof item !== 'object') continue
      const file = soundtrackKey(text(item.assetbundleFileName))
      const title = text(item.title)
      if (!file || !title) continue

      const category = categoryLabel(item.musicSoundTrackCategoryId, categoryNames)
      const existing = tracks.get(file)
      if (!existing) {
        tracks.set(file, {
          file,
          titles: [title],
          categories: category ? [category] : []
        })
        continue
      }
      if (!existing.titles.includes(title)) existing.titles.push(title)
      if (category && !existing.categories.includes(category)) {
        existing.categories.push(category)
      }
    }
  }

  return { source, fetchedAt, tracks }
}

function titleText(titles: string[]): string {
  if (titles.length <= 3) return titles.join(' / ')
  const head = titles.slice(0, 3).join(' / ')
  return `${head} 等 ${titles.length} 首`
}

/**
 * 曲名索引 → 清单里的 name/description。
 *
 * name 用官方曲名；description 用中文分类（剧情 BGM / Wonderlands×Showtime BGM）。
 * 描述只写分类，不重复曲名——提示词会拼成“文件名（曲名）：分类 BGM”。
 */
export function soundtrackLabel(info: SoundtrackInfo): SoundtrackLabel {
  const title = titleText(info.titles).slice(0, MAX_TITLE_CHARS)
  const categories = info.categories.filter(Boolean)
  const description = categories.length > 0 ? `${categories.join(' / ')} BGM` : '游戏 BGM'
  return { name: title || info.file, description }
}

function readCachedTrack(value: unknown): CachedSoundtrackTrack | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const titles = Array.isArray(record.titles)
    ? record.titles.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : []
  const categories = Array.isArray(record.categories)
    ? record.categories.filter(
        (item): item is string => typeof item === 'string' && item.trim() !== ''
      )
    : []
  if (titles.length === 0) return null
  return { titles, categories }
}

/** 读取 fetch:media 写下的精简缓存；损坏或版本不符时返回 null。 */
export function readSoundtrackIndex(file: string): SoundtrackIndex | null {
  if (!fs.existsSync(file)) return null
  let parsed: CachedSoundtrackFile
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as CachedSoundtrackFile
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  if (parsed.version !== undefined && parsed.version !== CACHE_VERSION) return null
  if (!parsed.tracks || typeof parsed.tracks !== 'object' || Array.isArray(parsed.tracks)) {
    return null
  }

  const tracks = new Map<string, SoundtrackInfo>()
  for (const [rawFile, rawTrack] of Object.entries(parsed.tracks as Record<string, unknown>)) {
    const cached = readCachedTrack(rawTrack)
    if (!cached) continue
    const file = soundtrackKey(rawFile)
    if (!file) continue
    tracks.set(file, { file, titles: cached.titles, categories: cached.categories })
  }
  if (tracks.size === 0) return null
  return {
    source: text(parsed.source),
    fetchedAt: text(parsed.fetchedAt) || new Date(0).toISOString(),
    tracks
  }
}

/** 写入精简缓存；只保存 AI 需要的曲名/分类，不落整份 master data。 */
export function writeSoundtrackIndex(file: string, index: SoundtrackIndex): void {
  const tracks: Record<string, CachedSoundtrackTrack> = {}
  for (const [key, info] of index.tracks) {
    tracks[key] = { titles: info.titles, categories: info.categories }
  }
  atomicWrite(
    file,
    `${JSON.stringify(
      {
        version: CACHE_VERSION,
        source: index.source,
        fetchedAt: index.fetchedAt,
        tracks
      },
      null,
      2
    )}\n`
  )
}

function cacheAgeMs(index: SoundtrackIndex): number {
  const fetched = Date.parse(index.fetchedAt)
  if (!Number.isFinite(fetched)) return Number.POSITIVE_INFINITY
  return Date.now() - fetched
}

export interface LoadSoundtrackOptions {
  /** 精简缓存路径，通常是 <resources>/audio/bgm/soundtracks.json */
  cacheFile: string
  /** master data 目录；默认 Sekai-World 的 jp master-db-diff */
  baseUrl?: string
  timeoutMs?: number
  retries?: number
  /** 忽略缓存有效期，强制联网更新 */
  refresh?: boolean
  onProgress?: (message: string) => void
}

/**
 * 读取曲名索引：优先使用未过期的本地缓存；缓存过期或不存在时联网更新，
 * 更新失败仍退回旧缓存。任何失败都只影响描述补全，不阻断 BGM 下载。
 */
export async function loadSoundtrackIndex(
  options: LoadSoundtrackOptions
): Promise<SoundtrackIndex | null> {
  const cached = readSoundtrackIndex(options.cacheFile)
  if (cached && !options.refresh && cacheAgeMs(cached) < CACHE_MAX_AGE_MS) {
    options.onProgress?.(`BGM 曲名索引：${cached.tracks.size} 首（本地缓存）`)
    return cached
  }

  const requestOptions: RequestOptions = {
    // 曲名索引只有几十 KB；不要把资源下载的 180 秒超时套到这里，
    // 否则镜像不通时 fetch:media 会在开跑前干等几分钟。
    timeoutMs: Math.min(options.timeoutMs ?? 20_000, 20_000),
    retries: Math.min(options.retries ?? 1, 1)
  }
  const bases = [options.baseUrl || DEFAULT_SOUNDTRACK_BASE, FALLBACK_SOUNDTRACK_BASE]
    .map(withSlash)
    .filter((base, index, all) => all.indexOf(base) === index)

  let lastError: unknown = null
  for (const base of bases) {
    try {
      options.onProgress?.('读取 BGM 曲名索引 …')
      const [tracks, categories] = await Promise.all([
        fetchJson<RawSoundtrackTrack[]>(assetUrl(base, 'musicSoundTracks.json'), requestOptions),
        fetchJson<RawSoundtrackCategory[]>(
          assetUrl(base, 'musicSoundTrackCategories.json'),
          requestOptions
        )
      ])
      const index = parseSoundtrackIndex(tracks, categories, base)
      if (index.tracks.size === 0) {
        throw new Error('musicSoundTracks.json 没有可用条目')
      }
      try {
        writeSoundtrackIndex(options.cacheFile, index)
      } catch (error) {
        // 只读资源目录不应该让本次 fetch 失去曲名；缓存写不进去就下次再试。
        const reason = error instanceof Error ? error.message : String(error)
        options.onProgress?.(`BGM 曲名缓存写入失败：${reason}`)
      }
      options.onProgress?.(`BGM 曲名索引：${index.tracks.size} 首`)
      return index
    } catch (error) {
      lastError = error
      const reason = error instanceof Error ? error.message : String(error)
      options.onProgress?.(`BGM 曲名索引源不可用（${base}）：${reason}`)
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  if (cached) {
    options.onProgress?.(`BGM 曲名索引更新失败，沿用缓存：${reason}`)
    return cached
  }
  options.onProgress?.(`BGM 曲名索引不可用，曲目暂不进入 AI 候选：${reason}`)
  return null
}
