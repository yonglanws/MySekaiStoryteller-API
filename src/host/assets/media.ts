import fs from 'node:fs'
import path from 'node:path'
import type { AssetsSettings } from '../config'
import { assertHttpUrl, atomicWrite, fetchJson, request, type RequestOptions } from './http'
import { appendNamedManifest, type NamedManifestEntry } from './manifest'
import { soundtrackKey, soundtrackLabel, type SoundtrackIndex } from './soundtracks'

/**
 * 从 Moesekai 资源站拉取背景与 BGM。
 *
 * 资源站提供 bundle 浏览 API：
 *   GET <asset-origin>/api/assets/bundles?server=jp&prefix=scenario/background/
 *   GET <asset-origin>/api/assets/bundle-files?server=jp&path=scenario/background/bg_a000001
 * 背景 bundle 里有 `.png` / `.webp`，剧情 BGM 是 `sound/scenario/bgm/<name>/<name>.mp3`。
 * 下载后分别登记到 `resources/images/images.yaml` 与 `resources/audio/bgm/bgm.yaml`。
 */

export type MediaKind = 'background' | 'bgm'
export type AssetRegion = AssetsSettings['region']

export interface MediaBundle {
  kind: MediaKind
  name: string
  path: string
  bytes: number
  files: number
  prefix: string
}

export interface MediaFile {
  name: string
  path: string
  url: string
  size: number
}

export interface FetchMediaOptions {
  outDir: string
  region: AssetRegion
  kinds?: MediaKind[]
  /** 资源站根地址；默认 https://storage.exmeaning.com */
  assetBase?: string
  /** 每种资源最多处理多少个 bundle；0/省略 = 全部 */
  limit?: number
  /** 只处理名称精确匹配或包含这些片段的 bundle */
  names?: string[]
  /** 同时拉取 sound/area_bgm（区域 BGM） */
  includeAreaBgm?: boolean
  force?: boolean
  dryRun?: boolean
  concurrency?: number
  timeoutMs?: number
  retries?: number
  /**
   * PJSK 官方曲名索引。提供时新登记的 BGM 会写入曲名/分类，
   * 避免 AI 只看到 bgm00003 这类无语义文件名。
   */
  soundtrackIndex?: SoundtrackIndex | null
  onProgress?: (message: string) => void
}

export interface FetchedMediaItem {
  kind: MediaKind
  name: string
  /** 相对资源根的路径，如 images/bg_a000001.webp */
  file: string
  bytes: number
  skipped: boolean
}

export interface FetchMediaResult {
  region: AssetRegion
  assetBase: string
  dryRun: boolean
  backgrounds: FetchedMediaItem[]
  bgm: FetchedMediaItem[]
  skipped: string[]
  errors: Array<{ kind: MediaKind; name: string; error: string }>
  addedImages: NamedManifestEntry[]
  addedBgm: NamedManifestEntry[]
}

export interface ListMediaOptions {
  region: AssetRegion
  kinds?: MediaKind[]
  assetBase?: string
  limit?: number
  names?: string[]
  includeAreaBgm?: boolean
  timeoutMs?: number
  retries?: number
}

export interface ListMediaResult {
  region: AssetRegion
  assetBase: string
  bundles: MediaBundle[]
}

const DEFAULT_ASSET_BASE = 'https://storage.exmeaning.com'
const DEFAULT_CONCURRENCY = 4
const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_RETRIES = 3
const PAGE_LIMIT = 200

const BACKGROUND_EXTS = ['.webp', '.png', '.jpg', '.jpeg']
const BGM_EXTS = ['.mp3', '.wav', '.ogg', '.flac']

interface AssetApiItem {
  type?: string
  name?: string
  path?: string
  url?: string
  size?: number
  fileCount?: number
  totalSize?: number
}

interface AssetApiPage {
  items?: AssetApiItem[]
  nextCursor?: string
}

function normalizeAssetBase(raw: string | undefined): string {
  const value = (raw || DEFAULT_ASSET_BASE).trim().replace(/\/+$/, '')
  const url = assertHttpUrl(value, 'assetBase')
  return url.href.replace(/\/+$/, '')
}

function apiOrigin(assetBase: string): string {
  return new URL(assetBase).origin
}

function requestOptions(options: { timeoutMs?: number; retries?: number }): RequestOptions {
  return {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retries: options.retries ?? DEFAULT_RETRIES
  }
}

function prefixFor(kind: MediaKind, area: boolean): string {
  if (kind === 'background') return 'scenario/background/'
  return area ? 'sound/area_bgm/' : 'sound/scenario/bgm/'
}

function isBackgroundName(name: string): boolean {
  return /^bg/i.test(name) && name !== 'background'
}

function isBgmName(name: string): boolean {
  return name !== 'bgm' && name !== 'bgm00000'
}

function matchesNames(name: string, names: string[] | undefined): boolean {
  if (!names || names.length === 0) return true
  const lower = name.toLowerCase()
  return names.some((item) => {
    const token = item.trim().toLowerCase()
    return token.length > 0 && (lower === token || lower.includes(token))
  })
}

async function listBundles(
  origin: string,
  region: AssetRegion,
  prefix: string,
  options: RequestOptions
): Promise<MediaBundle[]> {
  const bundles: MediaBundle[] = []
  const seenCursors = new Set<string>()
  let cursor: string | null = null
  const kind: MediaKind = prefix.startsWith('scenario/background') ? 'background' : 'bgm'

  do {
    const query = new URLSearchParams({
      server: region,
      prefix,
      limit: String(PAGE_LIMIT)
    })
    if (cursor) query.set('cursor', cursor)
    const page = await fetchJson<AssetApiPage>(
      `${origin}/api/assets/bundles?${query.toString()}`,
      options
    )
    for (const item of page.items ?? []) {
      if (item.type !== 'bundle' || !item.name || !item.path) continue
      if (!item.path.startsWith(prefix)) continue
      if (kind === 'background' && !isBackgroundName(item.name)) continue
      if (kind === 'bgm' && !isBgmName(item.name)) continue
      bundles.push({
        kind,
        name: item.name,
        path: item.path,
        bytes: item.totalSize ?? 0,
        files: item.fileCount ?? 0,
        prefix
      })
    }
    cursor = page.nextCursor?.trim() || null
    if (cursor && seenCursors.has(cursor)) break
    if (cursor) seenCursors.add(cursor)
  } while (cursor)

  return bundles
}

async function bundleFiles(
  origin: string,
  region: AssetRegion,
  bundle: MediaBundle,
  options: RequestOptions
): Promise<MediaFile[]> {
  const files: MediaFile[] = []
  const seenCursors = new Set<string>()
  let cursor: string | null = null
  do {
    const query = new URLSearchParams({
      server: region,
      path: bundle.path,
      limit: String(PAGE_LIMIT)
    })
    if (cursor) query.set('cursor', cursor)
    const page = await fetchJson<AssetApiPage>(
      `${origin}/api/assets/bundle-files?${query.toString()}`,
      options
    )
    for (const item of page.items ?? []) {
      if (item.type !== 'asset' || typeof item.name !== 'string' || typeof item.url !== 'string') {
        continue
      }
      files.push({
        name: item.name,
        path: item.path ?? '',
        url: item.url,
        size: item.size ?? 0
      })
    }
    cursor = page.nextCursor?.trim() || null
    if (cursor && seenCursors.has(cursor)) break
    if (cursor) seenCursors.add(cursor)
  } while (cursor)
  return files
}

function pickFile(files: MediaFile[], extensions: string[]): MediaFile | null {
  for (const ext of extensions) {
    const hit = files.find((file) => file.name.toLowerCase().endsWith(ext))
    if (hit) return hit
  }
  return null
}

function existingMediaFile(dir: string, name: string, extensions: string[]): string | null {
  for (const ext of extensions) {
    const candidate = path.join(dir, `${name}${ext}`)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function targetDir(outDir: string, kind: MediaKind): string {
  return kind === 'background' ? path.join(outDir, 'images') : path.join(outDir, 'audio', 'bgm')
}

function relativeTo(outDir: string, file: string): string {
  return path.relative(outDir, file).split(path.sep).join('/')
}

/**
 * BGM 清单条目：官方曲名索引命中时写曲名 + 中文分类，
 * 否则退回 bundle 名（后续仍可在 bgm.yaml 手工补描述）。
 */
function bgmManifestEntry(
  file: string,
  fallbackName: string,
  index: SoundtrackIndex | null | undefined
): NamedManifestEntry {
  const info = index?.tracks.get(soundtrackKey(file))
  if (!info) return { file, name: fallbackName, description: '' }
  const label = soundtrackLabel(info)
  return { file, name: label.name, description: label.description }
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => run()))
  return results
}

async function fetchFiles(
  origin: string,
  region: AssetRegion,
  bundles: MediaBundle[],
  options: FetchMediaOptions & { outDir: string }
): Promise<FetchedMediaItem[]> {
  const requestOpts = requestOptions(options)
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
  const extensions = (kind: MediaKind): string[] =>
    kind === 'background' ? BACKGROUND_EXTS : BGM_EXTS

  return mapPool(bundles, concurrency, async (bundle) => {
    const dir = targetDir(options.outDir, bundle.kind)
    const existing = existingMediaFile(dir, bundle.name, extensions(bundle.kind))
    if (existing && !options.force) {
      options.onProgress?.(`跳过已存在：${relativeTo(options.outDir, existing)}`)
      return {
        kind: bundle.kind,
        name: bundle.name,
        file: relativeTo(options.outDir, existing),
        bytes: fs.statSync(existing).size,
        skipped: true
      }
    }

    try {
      const files = await bundleFiles(origin, region, bundle, requestOpts)
      const picked = pickFile(files, extensions(bundle.kind))
      if (!picked) {
        throw new Error(`bundle 中没有可用的 ${extensions(bundle.kind).join('/')} 文件`)
      }
      const target = path.join(dir, path.basename(picked.name))
      if (options.dryRun) {
        options.onProgress?.(`将下载：${relativeTo(options.outDir, target)}`)
        return {
          kind: bundle.kind,
          name: bundle.name,
          file: relativeTo(options.outDir, target),
          bytes: picked.size,
          skipped: false
        }
      }

      options.onProgress?.(`下载 ${bundle.kind} ${bundle.name} …`)
      const response = await request(new URL(picked.url, origin).href, requestOpts)
      const buffer = Buffer.from(await response.arrayBuffer())
      atomicWrite(target, buffer)
      options.onProgress?.(
        `完成 ${relativeTo(options.outDir, target)}（${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB）`
      )
      return {
        kind: bundle.kind,
        name: bundle.name,
        file: relativeTo(options.outDir, target),
        bytes: buffer.byteLength,
        skipped: false
      }
    } catch (error) {
      throw new Error(
        `${bundle.kind} ${bundle.name}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  })
}

export interface DownloadMediaFileOptions {
  kind: MediaKind
  /** bundle 名，如 bg_a000301 / bgm00003 */
  name: string
  outDir: string
  region: AssetRegion
  assetBase?: string
  /** 目标子目录（相对 images/ 或 audio/bgm/），云端按需物化用 'cloud' */
  subdir?: string
  force?: boolean
  timeoutMs?: number
  retries?: number
}

export interface DownloadedMediaFile {
  /** 相对 outDir 的路径，如 images/cloud/bg_a000301.webp */
  file: string
  bytes: number
  skipped: boolean
}

/**
 * 下载单个背景/BGM bundle 里的首选文件（背景优先 webp，BGM 优先 mp3）。
 * 只写文件，不碰 images.yaml / bgm.yaml —— 云端目录不需要本地登记。
 */
export async function downloadMediaFile(
  options: DownloadMediaFileOptions
): Promise<DownloadedMediaFile | null> {
  const assetBase = normalizeAssetBase(options.assetBase)
  const origin = apiOrigin(assetBase)
  const requestOpts = requestOptions(options)
  const prefix = prefixFor(options.kind, false)
  const bundle: MediaBundle = {
    kind: options.kind,
    name: options.name,
    path: `${prefix}${options.name}`,
    bytes: 0,
    files: 0,
    prefix
  }
  const dir = path.join(targetDir(options.outDir, options.kind), options.subdir ?? '')
  const extensions = options.kind === 'background' ? BACKGROUND_EXTS : BGM_EXTS
  const files = await bundleFiles(origin, options.region, bundle, requestOpts)
  const picked = pickFile(files, extensions)
  if (!picked) return null

  const target = path.join(dir, path.basename(picked.name))
  if (fs.existsSync(target) && !options.force) {
    return {
      file: relativeTo(options.outDir, target),
      bytes: fs.statSync(target).size,
      skipped: true
    }
  }
  const response = await request(new URL(picked.url, origin).href, requestOpts)
  const buffer = Buffer.from(await response.arrayBuffer())
  atomicWrite(target, buffer)
  return { file: relativeTo(options.outDir, target), bytes: buffer.byteLength, skipped: false }
}

/**
 * 按需下载剧情 SE：cue 名（se_door）在 sound/scenario/se/ 的若干包里，
 * 逐个包查文件列表；找到后写到 audio/se/cloud/。
 */
export async function downloadSeFile(options: {
  name: string
  outDir: string
  region: AssetRegion
  assetBase?: string
  force?: boolean
  timeoutMs?: number
  retries?: number
}): Promise<DownloadedMediaFile | null> {
  const desired = options.name.trim()
  if (!desired) return null
  const fileName = /\.(mp3|wav|ogg|flac)$/i.test(desired) ? desired : `${desired}.mp3`
  const target = path.join(options.outDir, 'audio', 'se', 'cloud', fileName)
  if (fs.existsSync(target) && !options.force) {
    return {
      file: relativeTo(options.outDir, target),
      bytes: fs.statSync(target).size,
      skipped: true
    }
  }

  const assetBase = normalizeAssetBase(options.assetBase)
  const origin = apiOrigin(assetBase)
  const requestOpts = requestOptions(options)
  const bundles = await listBundles(origin, options.region, 'sound/scenario/se/', requestOpts)
  for (const bundle of bundles) {
    const files = await bundleFiles(origin, options.region, bundle, requestOpts)
    const hit = files.find((file) => file.name.toLowerCase() === fileName.toLowerCase())
    if (!hit) continue
    const response = await request(new URL(hit.url, origin).href, requestOpts)
    const buffer = Buffer.from(await response.arrayBuffer())
    atomicWrite(target, buffer)
    return { file: relativeTo(options.outDir, target), bytes: buffer.byteLength, skipped: false }
  }
  return null
}

/** 只列出资源站的背景/BGM bundle，不下载。 */
export async function listMedia(options: ListMediaOptions): Promise<ListMediaResult> {
  const assetBase = normalizeAssetBase(options.assetBase)
  const origin = apiOrigin(assetBase)
  const requestOpts = requestOptions(options)
  const kinds = options.kinds ?? ['background', 'bgm']
  const bundles: MediaBundle[] = []

  for (const kind of kinds) {
    const prefixes =
      kind === 'bgm' && options.includeAreaBgm
        ? [prefixFor(kind, false), prefixFor(kind, true)]
        : [prefixFor(kind, false)]
    for (const prefix of prefixes) {
      const found = await listBundles(origin, options.region, prefix, requestOpts)
      bundles.push(...found)
    }
  }

  const filtered = bundles.filter((bundle) => matchesNames(bundle.name, options.names))
  const limited: MediaBundle[] = []
  for (const kind of kinds) {
    const items = filtered.filter((bundle) => bundle.kind === kind)
    items.sort((a, b) => a.name.localeCompare(b.name))
    limited.push(...(options.limit && options.limit > 0 ? items.slice(0, options.limit) : items))
  }
  return { region: options.region, assetBase, bundles: limited }
}

/** 下载背景/BGM 并追加到 images.yaml / bgm.yaml。 */
export async function fetchMedia(options: FetchMediaOptions): Promise<FetchMediaResult> {
  const assetBase = normalizeAssetBase(options.assetBase)
  const origin = apiOrigin(assetBase)
  const selected = await listMedia({
    region: options.region,
    kinds: options.kinds,
    assetBase,
    limit: options.limit,
    names: options.names,
    includeAreaBgm: options.includeAreaBgm,
    timeoutMs: options.timeoutMs,
    retries: options.retries
  })

  const backgrounds = selected.bundles.filter((bundle) => bundle.kind === 'background')
  const bgm = selected.bundles.filter((bundle) => bundle.kind === 'bgm')
  const result: FetchMediaResult = {
    region: options.region,
    assetBase,
    dryRun: options.dryRun === true,
    backgrounds: [],
    bgm: [],
    skipped: [],
    errors: [],
    addedImages: [],
    addedBgm: []
  }

  // fetchFiles 的 mapPool 会在第一个错误时 reject；这里逐项捕获，保留成功项和每个错误。
  const runBundles = async (bundles: MediaBundle[]): Promise<FetchedMediaItem[]> => {
    const items = await mapPool(
      bundles,
      options.concurrency ?? DEFAULT_CONCURRENCY,
      async (bundle): Promise<FetchedMediaItem | null> => {
        try {
          const [item] = await fetchFiles(origin, options.region, [bundle], {
            ...options,
            concurrency: 1
          })
          if (item.skipped) result.skipped.push(item.file)
          return item
        } catch (error) {
          result.errors.push({
            kind: bundle.kind,
            name: bundle.name,
            error: error instanceof Error ? error.message : String(error)
          })
          return null
        }
      }
    )
    return items.filter((item): item is FetchedMediaItem => item !== null)
  }

  if (backgrounds.length > 0) {
    options.onProgress?.(`背景：${backgrounds.length} 个 bundle`)
    result.backgrounds = await runBundles(backgrounds)
  }
  if (bgm.length > 0) {
    options.onProgress?.(`BGM：${bgm.length} 个 bundle`)
    result.bgm = await runBundles(bgm)
  }

  if (!options.dryRun) {
    const imageEntries = result.backgrounds.map((item) => ({
      file: path.basename(item.file),
      name: item.name,
      description: ''
    }))
    const bgmEntries = result.bgm.map((item) =>
      bgmManifestEntry(path.basename(item.file), item.name, options.soundtrackIndex)
    )
    result.addedImages = appendNamedManifest(
      path.join(options.outDir, 'images', 'images.yaml'),
      'images',
      imageEntries
    )
    result.addedBgm = appendNamedManifest(
      path.join(options.outDir, 'audio', 'bgm', 'bgm.yaml'),
      'bgm',
      bgmEntries
    )
  }

  return result
}
