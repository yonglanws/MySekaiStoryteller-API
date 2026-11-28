import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { AssetsSettings } from '../config'
import { ffmpegPath } from '../../shared/ffmpeg'
import {
  assertHttpUrl,
  atomicWrite,
  CANONICAL_ASSET_ORIGINS,
  fetchBuffer,
  fetchJson,
  isCanonicalAssetOrigin,
  isLikelyOriginFailure,
  markCanonicalOriginFailed,
  markCanonicalOriginHealthy,
  orderCanonicalOrigins,
  type RequestOptions
} from './http'
import { mapPool } from './shared'
import { appendNamedManifest, type NamedManifestEntry } from './manifest'
import { soundtrackKey, soundtrackLabel, type SoundtrackIndex } from './soundtracks'

const execFileAsync = promisify(execFile)

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

const DEFAULT_ASSET_BASE = CANONICAL_ASSET_ORIGINS[0]
const BACKUP_ASSET_BASE = CANONICAL_ASSET_ORIGINS[1]
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

interface DirectoryListingFile {
  name?: string
  extension?: string
  size?: number
}

interface DirectoryListingPage {
  format?: string
  version?: number
  directories?: string[]
  files?: Array<string | DirectoryListingFile>
}

interface AudioCuesDocument {
  format?: string
  version?: number
  cues?: Array<{
    name?: string
    waveforms?: Array<{
      role?: string
      frames?: number
      sample_rate?: number
      channels?: number
      loop?: [number, number]
    }>
  }>
}

function normalizeAssetBase(raw: string | undefined): string {
  const value = (raw || DEFAULT_ASSET_BASE).trim().replace(/\/+$/, '')
  const url = assertHttpUrl(value, 'assetBase')
  return url.href.replace(/\/+$/, '')
}

function apiOrigin(assetBase: string): string {
  return new URL(assetBase).origin
}

export function assetBaseCandidates(raw: string | undefined): string[] {
  const primary = normalizeAssetBase(raw)
  const origin = apiOrigin(primary)
  if (!raw || !raw.trim()) return orderCanonicalOrigins([...CANONICAL_ASSET_ORIGINS])
  if (origin === DEFAULT_ASSET_BASE) return orderCanonicalOrigins([primary, BACKUP_ASSET_BASE])
  if (origin === BACKUP_ASSET_BASE) return orderCanonicalOrigins([primary, DEFAULT_ASSET_BASE])
  return [primary]
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
  const kind: MediaKind = prefix.startsWith('scenario/background') ? 'background' : 'bgm'
  const isSe = prefix.startsWith('sound/scenario/se')

  if (isCanonicalAssetOrigin(origin)) {
    const cleanPrefix = prefix.replace(/^\/+/, '').replace(/\/?$/, '/')
    const url = `${origin}/sekai-${region}-assets/${cleanPrefix}`
    const page = await fetchJson<DirectoryListingPage>(url, options)
    if (page.format !== 'directory-listing' || page.version !== 1) {
      throw new Error(`${url}: unsupported directory-listing`)
    }
    const bundles: MediaBundle[] = []
    for (const dirName of page.directories ?? []) {
      if (!dirName) continue
      if (kind === 'background' && !isBackgroundName(dirName)) continue
      if (kind === 'bgm' && !isSe && !isBgmName(dirName)) continue
      bundles.push({
        kind,
        name: dirName,
        path: `${cleanPrefix}${dirName}`,
        bytes: 0,
        files: 0,
        prefix: cleanPrefix
      })
    }
    return bundles
  }

  const bundles: MediaBundle[] = []
  const seenCursors = new Set<string>()
  let cursor: string | null = null

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
      if (kind === 'bgm' && !isSe && !isBgmName(item.name)) continue
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
  if (isCanonicalAssetOrigin(origin)) {
    const cleanBundle = bundle.path.replace(/^\/+|\/+$/g, '')
    const listingUrl = `${origin}/sekai-${region}-assets/${cleanBundle}/`
    const page = await fetchJson<DirectoryListingPage>(listingUrl, options)
    if (page.format !== 'directory-listing' || page.version !== 1) {
      throw new Error(`${listingUrl}: unsupported directory-listing`)
    }
    const files: MediaFile[] = []
    for (const entry of page.files ?? []) {
      const name = typeof entry === 'string' ? entry : entry?.name
      if (!name) continue
      const relPath = `${cleanBundle}/${name}`
      files.push({
        name,
        path: relPath,
        url: `${origin}/sekai-${region}-assets/${relPath.split('/').map(encodeURIComponent).join('/')}`,
        size: typeof entry === 'string' ? 0 : (entry.size ?? 0)
      })
    }
    return files
  }

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

const HTML_OR_ERROR_PREFIXES = [
  '<!doctype',
  '<html',
  '<head',
  '<body',
  '<?xml',
  '<error',
  '{"error"',
  '{"message"',
  '{"code"',
  '404 not found',
  '403 forbidden',
  '502 bad gateway',
  '503 service unavailable'
]

/** 检测响应/缓存内容是否为 HTML/XML/JSON 错误页，避免把上游错误页落盘成假图片或假音频。 */
export function isHtmlOrErrorPayload(buffer: Buffer): boolean {
  if (buffer.byteLength === 0) return true
  const sample = buffer
    .subarray(0, Math.min(buffer.byteLength, 256))
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase()
  return HTML_OR_ERROR_PREFIXES.some((prefix) => sample.startsWith(prefix))
}

/** 校验常见图片魔数（WebP / PNG / JPEG）。 */
export function hasValidImageMagic(buffer: Buffer): boolean {
  if (
    buffer.byteLength >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return true
  }
  if (
    buffer.byteLength >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return true
  }
  if (buffer.byteLength >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return true
  }
  return false
}

function validateDownloadedMediaBuffer(
  buffer: Buffer,
  kind: MediaKind,
  url: string,
  strictImageMagic: boolean
): void {
  if (buffer.byteLength === 0) {
    throw new Error(`${url}: empty response body`)
  }
  if (isHtmlOrErrorPayload(buffer)) {
    throw new Error(`${url}: received HTML/error payload instead of ${kind} binary`)
  }
  if (strictImageMagic && kind === 'background' && !hasValidImageMagic(buffer)) {
    throw new Error(`${url}: invalid image signature for background payload`)
  }
}

/**
 * 校验磁盘缓存媒体文件是否可用：拒绝 0 字节、HTML/错误页以及（在严格模式下）魔数损坏的图片，
 * 以便调用方自动重新下载自愈。
 */
export function isUsableCachedMediaFile(
  filePath: string,
  kind: MediaKind,
  strictImageMagic = false
): boolean {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size <= 0) return false
    const readLen = Math.min(stat.size, 256)
    const head = Buffer.alloc(readLen)
    const fd = fs.openSync(filePath, 'r')
    try {
      const bytesRead = fs.readSync(fd, head, 0, readLen, 0)
      const slice = head.subarray(0, bytesRead)
      if (slice.byteLength === 0 || isHtmlOrErrorPayload(slice)) return false
      if (strictImageMagic && kind === 'background' && !hasValidImageMagic(slice)) return false
      return true
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return false
  }
}

function existingMediaFile(
  dir: string,
  name: string,
  extensions: string[],
  kind: MediaKind,
  strictImageMagic = false
): string | null {
  for (const ext of extensions) {
    const candidate = path.join(dir, `${name}${ext}`)
    if (isUsableCachedMediaFile(candidate, kind, strictImageMagic)) return candidate
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

  const strictOriginMagic = isCanonicalAssetOrigin(origin)
  return mapPool(bundles, concurrency, async (bundle) => {
    const dir = targetDir(options.outDir, bundle.kind)
    const existing = existingMediaFile(
      dir,
      bundle.name,
      extensions(bundle.kind),
      bundle.kind,
      strictOriginMagic
    )
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
      const downloadUrl = new URL(picked.url, origin).href
      const buffer = await fetchBuffer(downloadUrl, requestOpts)
      validateDownloadedMediaBuffer(
        buffer,
        bundle.kind,
        downloadUrl,
        isCanonicalAssetOrigin(apiOrigin(downloadUrl))
      )
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
  /** bundle 名，如 bg_a000301 / bgm00003 / normal_area */
  name: string
  /** 显式远端 bundle 路径（例如 sound/area_bgm/normal_area）；省略时按 kind 推导 */
  bundlePath?: string
  /** 保存到本地时的文件基名（不含扩展名）；area_bgm 时与 bundle 名对齐便于缓存命中 */
  saveAsName?: string
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
  loop?: AudioLoopMetadata
}

async function fetchCanonicalBgmCuesLoop(
  origin: string,
  region: AssetRegion,
  bundlePath: string,
  cueHint: string,
  options: RequestOptions
): Promise<AudioLoopMetadata | null> {
  if (!isCanonicalAssetOrigin(origin)) return null
  const cleanPath = bundlePath.replace(/^\/+|\/+$/g, '')
  const dirListingUrl = `${origin}/${region}/${cleanPath}/`
  try {
    const dir = await fetchJson<DirectoryListingPage>(dirListingUrl, options)
    const acbDir =
      (dir.directories ?? []).find((d) => d.endsWith('.acb')) ??
      `${path.posix.basename(cleanPath)}.acb`
    const cuesUrl = `${origin}/${region}/${cleanPath}/${acbDir}/cues.json`
    const doc = await fetchJson<AudioCuesDocument>(cuesUrl, options)
    return parseAudioCuesLoop(doc, cueHint)
  } catch {
    return null
  }
}

/**
 * 下载单个背景/BGM bundle 里的首选文件（背景优先 webp，BGM 优先 mp3）。
 * 只写文件，不碰 images.yaml / bgm.yaml —— 云端目录不需要本地登记。
 */
export async function downloadMediaFile(
  options: DownloadMediaFileOptions
): Promise<DownloadedMediaFile | null> {
  const candidates = assetBaseCandidates(options.assetBase)
  const requestOpts = requestOptions(options)
  const defaultPrefix = prefixFor(options.kind, false)
  const candidatePaths = options.bundlePath
    ? [options.bundlePath.replace(/^\/+|\/+$/g, '')]
    : options.kind === 'bgm'
      ? [`${defaultPrefix}${options.name}`, `${prefixFor('bgm', true)}${options.name}`]
      : [`${defaultPrefix}${options.name}`]

  const dir = path.join(targetDir(options.outDir, options.kind), options.subdir ?? '')
  const extensions = options.kind === 'background' ? BACKGROUND_EXTS : BGM_EXTS
  let origin = apiOrigin(candidates[0])
  let matchedBundlePath = candidatePaths[0]
  let files: MediaFile[] = []
  let picked: MediaFile | null = null

  for (let baseIdx = 0; baseIdx < candidates.length; baseIdx++) {
    const base = candidates[baseIdx]
    const baseOrigin = apiOrigin(base)
    const hasMoreMirrors = baseIdx < candidates.length - 1
    const mirrorOpts: RequestOptions = {
      ...requestOpts,
      retries: hasMoreMirrors ? Math.min(requestOpts.retries, 1) : requestOpts.retries
    }
    for (const candidatePath of candidatePaths) {
      const bundle: MediaBundle = {
        kind: options.kind,
        name: options.name,
        path: candidatePath,
        bytes: 0,
        files: 0,
        prefix: `${path.posix.dirname(candidatePath)}/`
      }
      try {
        files = await bundleFiles(baseOrigin, options.region, bundle, mirrorOpts)
        picked = pickFile(files, extensions)
        if (picked) {
          origin = baseOrigin
          matchedBundlePath = candidatePath
          if (candidates.length > 1) markCanonicalOriginHealthy(baseOrigin)
          break
        }
      } catch (error) {
        if (candidates.length > 1 && isLikelyOriginFailure(error)) {
          markCanonicalOriginFailed(baseOrigin)
          // 镜像站超时/连接异常时直接切备用镜像，避免在同一个死站上继续尝试其余前缀
          break
        }
      }
    }
    if (picked) break
  }
  if (!picked) return null

  const pickedBase = path.basename(picked.name)
  const fileName = options.saveAsName
    ? `${options.saveAsName}${path.extname(pickedBase)}`
    : pickedBase
  const target = path.join(dir, fileName)
  if (
    !options.force &&
    isUsableCachedMediaFile(target, options.kind, isCanonicalAssetOrigin(origin))
  ) {
    const existingLoop = options.kind === 'bgm' ? extractAudioLoopMetadata(target) : null
    return {
      file: relativeTo(options.outDir, target),
      bytes: fs.statSync(target).size,
      skipped: true,
      ...(existingLoop ? { loop: existingLoop } : {})
    }
  }
  const primaryUrl = new URL(picked.url, origin).href
  const downloadUrls = [primaryUrl]
  if (isCanonicalAssetOrigin(origin)) {
    const parsed = new URL(primaryUrl)
    for (const base of candidates) {
      const altOrigin = apiOrigin(base)
      if (altOrigin !== origin && isCanonicalAssetOrigin(altOrigin)) {
        const altUrl = `${altOrigin}${parsed.pathname}${parsed.search}`
        if (!downloadUrls.includes(altUrl)) downloadUrls.push(altUrl)
      }
    }
  }
  let buffer: Buffer | null = null
  let lastDownloadError: unknown = null
  let activeOrigin = origin
  for (let i = 0; i < downloadUrls.length; i++) {
    const url = downloadUrls[i]
    const hasBackup = i < downloadUrls.length - 1
    try {
      const buf = await fetchBuffer(url, {
        ...requestOpts,
        retries: hasBackup ? Math.min(requestOpts.retries, 1) : requestOpts.retries
      })
      validateDownloadedMediaBuffer(buf, options.kind, url, isCanonicalAssetOrigin(apiOrigin(url)))
      buffer = buf
      activeOrigin = apiOrigin(url)
      if (downloadUrls.length > 1) markCanonicalOriginHealthy(url)
      break
    } catch (error) {
      lastDownloadError = error
      if (downloadUrls.length > 1 && isLikelyOriginFailure(error)) {
        markCanonicalOriginFailed(url)
      }
    }
  }
  if (!buffer) {
    throw lastDownloadError instanceof Error
      ? lastDownloadError
      : new Error(String(lastDownloadError ?? `failed to download ${primaryUrl}`))
  }
  atomicWrite(target, buffer)
  const metaOpts: RequestOptions = {
    ...requestOpts,
    timeoutMs: Math.min(requestOpts.timeoutMs, 30_000),
    retries: Math.min(requestOpts.retries, 1)
  }
  let loop = options.kind === 'bgm' ? extractAudioLoopMetadata(buffer) : null
  if (!loop && options.kind === 'bgm') {
    const metaCompanion = files.find((f) => /\.(hca|wav)$/i.test(f.name) && f.name !== picked.name)
    if (metaCompanion) {
      try {
        const metaUrl = new URL(metaCompanion.url, activeOrigin).href
        const metaBuf = await fetchBuffer(metaUrl, metaOpts)
        loop = extractAudioLoopMetadata(metaBuf)
      } catch {
        // best-effort companion loop extraction
      }
    }
  }
  if (!loop && options.kind === 'bgm') {
    loop = await fetchCanonicalBgmCuesLoop(
      activeOrigin,
      options.region,
      matchedBundlePath,
      options.name,
      metaOpts
    )
  }
  if (loop) writeAudioLoopSidecar(target, loop)
  return {
    file: relativeTo(options.outDir, target),
    bytes: buffer.byteLength,
    skipped: false,
    ...(loop ? { loop } : {})
  }
}

export interface AudioLoopMetadata {
  loopStartMs: number
  loopEndMs: number
  loopStartSample: number
  loopEndSample: number
  sampleRate: number
  durationMs?: number
  source: 'hca' | 'wav-smpl' | 'sidecar' | 'audio-cues'
}

export function parseAudioCuesLoop(raw: unknown, cueHint?: string): AudioLoopMetadata | null {
  if (!raw || typeof raw !== 'object') return null
  const doc = raw as AudioCuesDocument
  const cues = Array.isArray(doc.cues) ? doc.cues : []
  if (cues.length === 0) return null
  const chosenCue =
    (cueHint ? cues.find((c) => c?.name?.toLowerCase() === cueHint.toLowerCase()) : null) ?? cues[0]
  const wf = chosenCue?.waveforms?.[0]
  if (!wf || !Array.isArray(wf.loop) || wf.loop.length < 2) return null
  const sampleRate = Number(wf.sample_rate) || 0
  const loopStartSample = Number(wf.loop[0])
  const loopEndSample = Number(wf.loop[1])
  const frames = Number(wf.frames) || 0
  if (sampleRate <= 0 || !Number.isFinite(loopStartSample) || loopEndSample <= loopStartSample) {
    return null
  }
  return {
    loopStartMs: Math.round((loopStartSample * 1000000) / sampleRate) / 1000,
    loopEndMs: Math.round((loopEndSample * 1000000) / sampleRate) / 1000,
    loopStartSample,
    loopEndSample,
    sampleRate,
    ...(frames > 0 ? { durationMs: Math.round((frames * 1000000) / sampleRate) / 1000 } : {}),
    source: 'audio-cues'
  }
}

export interface ScenarioSeEntry {
  id: string
  file: string
  bundle: string
  path: string
  url: string
  size: number
  category: string
  description: string
  tags: string[]
}

export const SCENARIO_SE_BUNDLES = [
  'sound/scenario/se/se',
  'sound/scenario/se/se_pack00001',
  'sound/scenario/se/se_pack00001_b'
] as const

const SE_EXTS = ['.mp3', '.wav', '.ogg', '.flac', '.hca']

/** 从 RIFF WAV `smpl` chunk 解析 CRI/vgmstream 写入的无缝循环样本点 `[start, end)`。 */
export function parseWavSmplLoop(buffer: Buffer): AudioLoopMetadata | null {
  if (
    buffer.byteLength < 44 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return null
  }
  let sampleRate = 0
  let channels = 0
  let bitsPerSample = 0
  let dataBytes = 0
  let loopStartSample = -1
  let loopEndSample = -1

  let offset = 12
  while (offset + 8 <= buffer.byteLength) {
    const chunkId = buffer.toString('ascii', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    const bodyStart = offset + 8
    const bodyEnd = Math.min(buffer.byteLength, bodyStart + chunkSize)

    if (chunkId === 'fmt ' && bodyStart + 16 <= bodyEnd) {
      channels = buffer.readUInt16LE(bodyStart + 2)
      sampleRate = buffer.readUInt32LE(bodyStart + 4)
      bitsPerSample = buffer.readUInt16LE(bodyStart + 14)
    } else if (chunkId === 'data') {
      dataBytes = bodyEnd - bodyStart
    } else if (chunkId === 'smpl' && bodyStart + 36 <= bodyEnd) {
      const loopCount = buffer.readUInt32LE(bodyStart + 28)
      if (loopCount > 0 && bodyStart + 60 <= bodyEnd) {
        loopStartSample = buffer.readUInt32LE(bodyStart + 44)
        loopEndSample = buffer.readUInt32LE(bodyStart + 48)
      }
    }

    offset = bodyStart + chunkSize + (chunkSize & 1)
  }

  if (sampleRate <= 0 || loopStartSample < 0 || loopEndSample <= loopStartSample) return null
  const frameBytes = Math.max(1, channels * (bitsPerSample / 8))
  const totalSamples =
    dataBytes > 0 && channels > 0 && bitsPerSample > 0 ? Math.floor(dataBytes / frameBytes) : 0
  const clampedEnd = totalSamples > 0 ? Math.min(loopEndSample, totalSamples) : loopEndSample
  if (clampedEnd <= loopStartSample) return null

  return {
    loopStartMs: Math.round((loopStartSample * 1000000) / sampleRate) / 1000,
    loopEndMs: Math.round((clampedEnd * 1000000) / sampleRate) / 1000,
    loopStartSample,
    loopEndSample: clampedEnd,
    sampleRate,
    ...(totalSamples > 0
      ? { durationMs: Math.round((totalSamples * 1000000) / sampleRate) / 1000 }
      : {}),
    source: 'wav-smpl'
  }
}

/** 从 CriWare `.hca` 头部 `fmt` + `loop` 块提取无缝循环区间（支持 bit-7 加密掩码）。 */
export function parseHcaLoop(buffer: Buffer): AudioLoopMetadata | null {
  if (buffer.byteLength < 16) return null
  const magic =
    String.fromCharCode(buffer[0] & 0x7f, buffer[1] & 0x7f, buffer[2] & 0x7f) +
    String.fromCharCode(buffer[3] & 0x7f)
  if (magic !== 'HCA\0') return null

  const headerSize = Math.min(buffer.byteLength, buffer.readUInt16BE(6))
  let sampleRate = 0
  let blockCount = 0
  let encoderDelay = 0
  let encoderPadding = 0
  let loopStartBlock = -1
  let loopEndBlock = -1
  let loopPreSkip = 0
  let loopEndMargin = 0

  let pos = 8
  while (pos + 4 <= headerSize) {
    const tag = String.fromCharCode(
      buffer[pos] & 0x7f,
      buffer[pos + 1] & 0x7f,
      buffer[pos + 2] & 0x7f,
      buffer[pos + 3] & 0x7f
    )
    if (tag === 'fmt\0' && pos + 16 <= headerSize) {
      sampleRate =
        ((buffer[pos + 5] & 0xff) << 16) |
        ((buffer[pos + 6] & 0xff) << 8) |
        (buffer[pos + 7] & 0xff)
      blockCount = buffer.readUInt32BE(pos + 8)
      encoderDelay = buffer.readUInt16BE(pos + 12)
      encoderPadding = buffer.readUInt16BE(pos + 14)
      pos += 16
    } else if (tag === 'comp' && pos + 16 <= headerSize) {
      pos += 16
    } else if (tag === 'dec\0' && pos + 12 <= headerSize) {
      pos += 12
    } else if (tag === 'loop' && pos + 14 <= headerSize) {
      loopStartBlock = buffer.readUInt32BE(pos + 4)
      loopEndBlock = buffer.readUInt32BE(pos + 8)
      if (pos + 16 <= headerSize) {
        loopPreSkip = buffer.readUInt16BE(pos + 12)
        loopEndMargin = buffer.readUInt16BE(pos + 14)
      }
      pos += pos + 16 <= headerSize ? 16 : 14
    } else if (tag === 'ciph' && pos + 6 <= headerSize) {
      const cipherType = buffer.readUInt16BE(pos + 4)
      pos += cipherType === 56 && pos + 16 <= headerSize ? 16 : 6
    } else if (tag === 'rva\0' && pos + 8 <= headerSize) {
      pos += 8
    } else if (tag === 'comm' && pos + 5 <= headerSize) {
      const len = buffer[pos + 4]
      pos += 5 + len
    } else if (tag === 'pad\0') {
      break
    } else {
      break
    }
  }

  if (sampleRate <= 0 || loopStartBlock < 0 || loopEndBlock < loopStartBlock) return null
  const samplesPerBlock = 1024
  const totalSamples = Math.max(0, blockCount * samplesPerBlock - encoderDelay - encoderPadding)
  const loopStartSample = Math.max(0, loopStartBlock * samplesPerBlock - encoderDelay + loopPreSkip)
  const rawEnd = (loopEndBlock + 1) * samplesPerBlock - encoderDelay - loopEndMargin
  const loopEndSample = totalSamples > 0 ? Math.min(totalSamples, rawEnd) : rawEnd
  if (loopEndSample <= loopStartSample) return null

  return {
    loopStartMs: Math.round((loopStartSample * 1000000) / sampleRate) / 1000,
    loopEndMs: Math.round((loopEndSample * 1000000) / sampleRate) / 1000,
    loopStartSample,
    loopEndSample,
    sampleRate,
    ...(totalSamples > 0
      ? { durationMs: Math.round((totalSamples * 1000000) / sampleRate) / 1000 }
      : {}),
    source: 'hca'
  }
}

export function readAudioLoopSidecar(audioFilePath: string): AudioLoopMetadata | null {
  const sidecarPath = `${audioFilePath}.loop.json`
  if (!fs.existsSync(sidecarPath)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8')) as Partial<AudioLoopMetadata>
    if (
      typeof parsed.loopStartMs === 'number' &&
      typeof parsed.loopEndMs === 'number' &&
      parsed.loopEndMs > parsed.loopStartMs
    ) {
      return {
        loopStartMs: parsed.loopStartMs,
        loopEndMs: parsed.loopEndMs,
        loopStartSample: Number(parsed.loopStartSample) || 0,
        loopEndSample: Number(parsed.loopEndSample) || 0,
        sampleRate: Number(parsed.sampleRate) || 48000,
        ...(typeof parsed.durationMs === 'number' ? { durationMs: parsed.durationMs } : {}),
        source: parsed.source ?? 'sidecar'
      }
    }
  } catch {
    return null
  }
  return null
}

export function writeAudioLoopSidecar(audioFilePath: string, metadata: AudioLoopMetadata): void {
  atomicWrite(`${audioFilePath}.loop.json`, `${JSON.stringify(metadata, null, 2)}\n`)
}

/** 从 Buffer 或磁盘音频文件（含同 stem .hca / .wav / .loop.json 伴生文件）提取循环点。 */
export function extractAudioLoopMetadata(
  filePathOrBuffer: string | Buffer
): AudioLoopMetadata | null {
  if (Buffer.isBuffer(filePathOrBuffer)) {
    return parseHcaLoop(filePathOrBuffer) ?? parseWavSmplLoop(filePathOrBuffer)
  }
  const sidecar = readAudioLoopSidecar(filePathOrBuffer)
  if (sidecar) return sidecar

  const candidates = [filePathOrBuffer]
  const parsed = path.parse(filePathOrBuffer)
  for (const ext of ['.hca', '.wav']) {
    const companion = path.join(parsed.dir, `${parsed.name}${ext}`)
    if (companion !== filePathOrBuffer) candidates.push(companion)
  }
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue
    try {
      const buf = fs.readFileSync(candidate)
      const meta = parseHcaLoop(buf) ?? parseWavSmplLoop(buf)
      if (meta) return meta
    } catch {
      // ignore unreadable candidate
    }
  }
  return null
}

export async function transcodeAudioFile(
  inputPath: string,
  outputPath: string,
  sampleRate = 48000
): Promise<void> {
  const args = ['-y', '-i', inputPath, '-ar', String(sampleRate), '-ac', '2', outputPath]
  await execFileAsync(ffmpegPath(), args)
}

export function inferSeSemanticInfo(
  cueId: string,
  bundlePath: string
): { category: string; description: string; tags: string[] } {
  const lower = cueId.toLowerCase()
  const bundleName = path.posix.basename(bundlePath)
  if (lower.startsWith('se_walk_')) {
    const who =
      lower.includes('men_') && !lower.includes('women_')
        ? '男性'
        : lower.includes('women_')
          ? '女性'
          : ''
    return {
      category: 'footsteps',
      description: `${who}行走脚步声（${cueId}）`,
      tags: ['footsteps', 'walk', ...(who ? [who] : [])]
    }
  }
  if (lower.startsWith('se_run_')) {
    const who =
      lower.includes('men_') && !lower.includes('women_')
        ? '男性'
        : lower.includes('women_')
          ? '女性'
          : ''
    return {
      category: 'running',
      description: `${who}奔跑脚步声（${cueId}）`,
      tags: ['footsteps', 'run', ...(who ? [who] : [])]
    }
  }
  if (lower.startsWith('se_event_')) {
    const slug = cueId.replace(/^se_event_/i, '').replace(/_\d{4}_\d+$/, '')
    return {
      category: 'event',
      description: `活动剧情音效：${slug || cueId}`,
      tags: ['event', ...(slug ? [slug] : [])]
    }
  }
  if (lower.includes('door')) {
    return { category: 'door', description: `门开关音效（${cueId}）`, tags: ['door'] }
  }
  if (lower.includes('phone') || lower.includes('ring') || lower.includes('call')) {
    return { category: 'phone', description: `手机/来电音效（${cueId}）`, tags: ['phone'] }
  }
  if (lower.includes('transition') || lower.includes('sekai')) {
    return {
      category: 'transition',
      description: `世界观转场音效（${cueId}）`,
      tags: ['transition', 'sekai']
    }
  }
  return {
    category: 'scenario',
    description: `官方剧情音效 ${cueId}（资源包 ${bundleName}）`,
    tags: ['scenario', bundleName]
  }
}

/** 列出官方 `sound/scenario/se/*` 资源包中的 SE 文件并生成语义索引。 */
export async function listScenarioSeFiles(options: {
  region: AssetRegion
  assetBase?: string
  bundleNames?: string[]
  timeoutMs?: number
  retries?: number
}): Promise<ScenarioSeEntry[]> {
  const candidates = assetBaseCandidates(options.assetBase)
  const requestOpts = requestOptions(options)

  for (let i = 0; i < candidates.length; i++) {
    const base = candidates[i]
    const origin = apiOrigin(base)
    const hasMoreMirrors = i < candidates.length - 1
    const mirrorOpts: RequestOptions = {
      ...requestOpts,
      retries: hasMoreMirrors ? Math.min(requestOpts.retries, 1) : requestOpts.retries
    }
    let bundles: MediaBundle[] = []
    let originFailed = false
    try {
      bundles = await listBundles(origin, options.region, 'sound/scenario/se/', mirrorOpts)
    } catch (error) {
      if (candidates.length > 1 && isLikelyOriginFailure(error)) {
        markCanonicalOriginFailed(origin)
        originFailed = true
      }
    }
    if (originFailed && hasMoreMirrors) continue
    if (bundles.length === 0) {
      const fallbackNames = options.bundleNames ?? [...SCENARIO_SE_BUNDLES]
      bundles = fallbackNames.map((bundlePath) => ({
        kind: 'bgm' as MediaKind,
        name: path.posix.basename(bundlePath),
        path: bundlePath,
        bytes: 0,
        files: 0,
        prefix: 'sound/scenario/se/'
      }))
    }

    const perBundle = await mapPool(bundles, 3, async (bundle) => {
      let files: MediaFile[] = []
      try {
        files = await bundleFiles(origin, options.region, bundle, mirrorOpts)
      } catch (error) {
        if (candidates.length > 1 && isLikelyOriginFailure(error)) {
          markCanonicalOriginFailed(origin)
        }
        return []
      }
      return files
        .filter((file) => SE_EXTS.includes(path.posix.extname(file.name).toLowerCase()))
        .map((file): ScenarioSeEntry => {
          const id = path.posix.basename(file.name, path.posix.extname(file.name))
          const semantic = inferSeSemanticInfo(id, bundle.path)
          return {
            id,
            file: path.posix.basename(file.name),
            bundle: bundle.path,
            path: file.path,
            url: file.url,
            size: file.size,
            ...semantic
          }
        })
    })

    const deduped = new Map<string, ScenarioSeEntry>()
    for (const list of perBundle) {
      for (const entry of list) {
        if (!deduped.has(entry.file)) {
          deduped.set(entry.file, entry)
        }
      }
    }
    if (deduped.size > 0) {
      if (candidates.length > 1) markCanonicalOriginHealthy(origin)
      return [...deduped.values()].sort((a, b) => a.id.localeCompare(b.id))
    }
  }
  return []
}

/**
 * 按需下载剧情 SE：cue 名（se_door / se00053_b）在 sound/scenario/se/ 的若干包里，
 * 逐个包查文件列表；找到后写到 audio/se/cloud/，必要时自动转码为目标格式。
 */
export async function downloadSeFile(options: {
  name: string
  outDir: string
  region: AssetRegion
  assetBase?: string
  force?: boolean
  timeoutMs?: number
  retries?: number
  transcodeTo?: 'mp3' | 'wav'
}): Promise<DownloadedMediaFile | null> {
  const desired = options.name.trim()
  if (!desired) return null
  const extMatch = path.posix.extname(desired).toLowerCase()
  const desiredStem = extMatch ? desired.slice(0, -extMatch.length) : desired
  const fileName = extMatch ? desired : `${desired}.mp3`
  const seDir = path.join(options.outDir, 'audio', 'se', 'cloud')
  const target = path.join(
    seDir,
    options.transcodeTo ? `${desiredStem}.${options.transcodeTo}` : fileName
  )
  if (fs.existsSync(target) && !options.force) {
    return {
      file: relativeTo(options.outDir, target),
      bytes: fs.statSync(target).size,
      skipped: true
    }
  }

  const candidates = assetBaseCandidates(options.assetBase)
  const requestOpts = requestOptions(options)

  for (let i = 0; i < candidates.length; i++) {
    const base = candidates[i]
    const origin = apiOrigin(base)
    const hasMoreMirrors = i < candidates.length - 1
    const mirrorOpts: RequestOptions = {
      ...requestOpts,
      retries: hasMoreMirrors ? Math.min(requestOpts.retries, 1) : requestOpts.retries
    }
    let bundles: MediaBundle[] = []
    let originFailed = false
    try {
      bundles = await listBundles(origin, options.region, 'sound/scenario/se/', mirrorOpts)
    } catch (error) {
      if (candidates.length > 1 && isLikelyOriginFailure(error)) {
        markCanonicalOriginFailed(origin)
        originFailed = true
      }
    }
    if (originFailed && hasMoreMirrors) continue
    if (bundles.length === 0) {
      bundles = SCENARIO_SE_BUNDLES.map((bundlePath) => ({
        kind: 'bgm' as MediaKind,
        name: path.posix.basename(bundlePath),
        path: bundlePath,
        bytes: 0,
        files: 0,
        prefix: 'sound/scenario/se/'
      }))
    }

    for (const bundle of bundles) {
      let files: MediaFile[] = []
      try {
        files = await bundleFiles(origin, options.region, bundle, mirrorOpts)
      } catch (error) {
        if (candidates.length > 1 && isLikelyOriginFailure(error)) {
          markCanonicalOriginFailed(origin)
          if (hasMoreMirrors) break
        }
        continue
      }
      const hit =
        files.find((file) => file.name.toLowerCase() === fileName.toLowerCase()) ??
        files.find((file) => {
          const ext = path.posix.extname(file.name).toLowerCase()
          if (!SE_EXTS.includes(ext)) return false
          return path.posix.basename(file.name, ext).toLowerCase() === desiredStem.toLowerCase()
        })
      if (!hit) continue

      let buffer: Buffer
      try {
        buffer = await fetchBuffer(new URL(hit.url, origin).href, mirrorOpts)
        if (buffer.byteLength === 0) throw new Error('empty SE response body')
        if (candidates.length > 1) markCanonicalOriginHealthy(origin)
      } catch (error) {
        if (candidates.length > 1 && isLikelyOriginFailure(error)) {
          markCanonicalOriginFailed(origin)
          if (hasMoreMirrors) break
        }
        continue
      }
      const hitTarget = path.join(seDir, path.posix.basename(hit.name))
      atomicWrite(hitTarget, buffer)

      const loopMeta = extractAudioLoopMetadata(buffer)
      if (loopMeta) writeAudioLoopSidecar(hitTarget, loopMeta)

      if (
        options.transcodeTo &&
        path.extname(hitTarget).toLowerCase() !== `.${options.transcodeTo}`
      ) {
        await transcodeAudioFile(hitTarget, target)
        if (loopMeta) writeAudioLoopSidecar(target, loopMeta)
        return {
          file: relativeTo(options.outDir, target),
          bytes: fs.statSync(target).size,
          skipped: false
        }
      }
      return {
        file: relativeTo(options.outDir, hitTarget),
        bytes: buffer.byteLength,
        skipped: false
      }
    }
  }
  return null
}

/** 只列出资源站的背景/BGM bundle，不下载。 */
export async function listMedia(options: ListMediaOptions): Promise<ListMediaResult> {
  const candidates = assetBaseCandidates(options.assetBase)
  const requestOpts = requestOptions(options)
  const kinds = options.kinds ?? ['background', 'bgm']

  let lastError: unknown = null
  for (let i = 0; i < candidates.length; i++) {
    const assetBase = candidates[i]
    const origin = apiOrigin(assetBase)
    const hasMoreMirrors = i < candidates.length - 1
    const mirrorOpts: RequestOptions = {
      ...requestOpts,
      retries: hasMoreMirrors ? Math.min(requestOpts.retries, 1) : requestOpts.retries
    }
    try {
      const bundles: MediaBundle[] = []
      for (const kind of kinds) {
        const prefixes =
          kind === 'bgm' && options.includeAreaBgm
            ? [prefixFor(kind, false), prefixFor(kind, true)]
            : [prefixFor(kind, false)]
        for (const prefix of prefixes) {
          const found = await listBundles(origin, options.region, prefix, mirrorOpts)
          bundles.push(...found)
        }
      }

      if (candidates.length > 1) markCanonicalOriginHealthy(origin)
      const filtered = bundles.filter((bundle) => matchesNames(bundle.name, options.names))
      const limited: MediaBundle[] = []
      for (const kind of kinds) {
        const items = filtered.filter((bundle) => bundle.kind === kind)
        items.sort((a, b) => a.name.localeCompare(b.name))
        limited.push(
          ...(options.limit && options.limit > 0 ? items.slice(0, options.limit) : items)
        )
      }
      return { region: options.region, assetBase, bundles: limited }
    } catch (error) {
      lastError = error
      if (candidates.length > 1 && isLikelyOriginFailure(error)) {
        markCanonicalOriginFailed(origin)
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'listMedia failed'))
}

/** 下载背景/BGM 并追加到 images.yaml / bgm.yaml。 */
export async function fetchMedia(options: FetchMediaOptions): Promise<FetchMediaResult> {
  const selected = await listMedia({
    region: options.region,
    kinds: options.kinds,
    assetBase: options.assetBase,
    limit: options.limit,
    names: options.names,
    includeAreaBgm: options.includeAreaBgm,
    timeoutMs: options.timeoutMs,
    retries: options.retries
  })
  const assetBase = selected.assetBase
  const origin = apiOrigin(assetBase)

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
