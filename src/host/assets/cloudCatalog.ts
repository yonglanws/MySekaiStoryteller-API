/**
 * 云端资源目录：背景、BGM、Live2D 模型全部从公开资源站/官方 master data 生成，
 * 不要求本地预下载或手工登记。
 *
 * 与 ournotes-player 的 "story site" 思路一致：目录本身只是一个清单（id → 名字 →
 * 远端位置），真正的图片/音频/模型在导出时按需物化到资源根下的 `cloud/` 子目录。
 * 这样 AI 只需要看到可读名字，宿主负责把名字/ID 解析成真实文件。
 *
 * 数据源：
 * - 模型：assets.pjsk.moe 的 sekai-live2d 索引 + 剧情库 `_ripper.json`
 * - 背景 / BGM：storage.exmeaning.com 的 bundle 列表
 * - 背景名：官方剧情 PlaceInfo/Telop 地点文本（scripts/assets/build-background-names.mjs）
 * - BGM 名：Sekai-World master data 的 musicSoundTracks.json
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ILogObj, Logger } from 'tslog'
import type { AssetsSettings } from '../config'
import { atomicWrite, type RequestOptions } from './http'
import { listMedia } from './media'
import {
  libraryRootFor,
  loadMoesekaiIndex,
  ripperManifest,
  selectModels,
  type MoesekaiIndexEntry
} from './moesekai'
import { characterById } from './names'
import {
  loadSoundtrackIndex,
  soundtrackKey,
  soundtrackLabel,
  type SoundtrackIndex
} from './soundtracks'
import backgroundNameData from './background-names.json'

export const CLOUD_CATALOG_FORMAT = 'msst.cloud-catalog/1'
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const MODEL_CONCURRENCY = 6
const DEFAULT_MOTION_PREFERENCE = ['w-normal-default01', 'w-normal-greeting01', 'w-normal-nod01']
const DEFAULT_FACIAL_PREFERENCE = ['face_smile_01']

interface BackgroundNameFile {
  format?: string
  backgrounds?: Record<string, { name?: string; aliases?: string[] }>
}

const backgroundNames = (backgroundNameData as BackgroundNameFile).backgrounds ?? {}

export interface CloudModelEntry {
  /** moesekai 模型 id，如 20mizuki_normal */
  id: string
  characterId: number | null
  name: string
  shortName: string
  bundle: string
  motionBundles: string[]
  /** 相对 resources/models/，指向尚未物化的 model3.json */
  path: string
  motions: string[]
  facials: string[]
  defaultMotion: string
  defaultFacial: string
}

export interface CloudBackgroundEntry {
  /** 稳定 id：bg_a000301 */
  id: string
  /** 相对 resources/images/ 的占位路径；物化后替换为真实扩展名 */
  file: string
  name: string
  /** 官方剧情中同一背景出现过的其它地点名 */
  aliases: string[]
  description: string
}

export interface CloudBgmEntry {
  /** 稳定 id：bgm00003 */
  id: string
  /** 相对 resources/audio/bgm/ 的路径 */
  file: string
  name: string
  description: string
}

export interface CloudCatalogData {
  format: typeof CLOUD_CATALOG_FORMAT
  generatedAt: string
  region: AssetsSettings['region']
  sources: {
    indexUrl: string
    libraryRoot: string
    assetBase: string
    soundtrack: string
  }
  models: CloudModelEntry[]
  backgrounds: CloudBackgroundEntry[]
  bgm: CloudBgmEntry[]
}

export interface BuildCloudCatalogOptions {
  signal?: AbortSignal
  onProgress?: (message: string) => void
  /** 覆盖 settings.timeoutMs，测试用 */
  timeoutMs?: number
  retries?: number
}

function pickPreferred(names: string[], preferences: string[]): string {
  for (const candidate of preferences) {
    if (names.includes(candidate)) return candidate
  }
  return names[0] ?? ''
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
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run))
  return results
}

function motionNames(
  manifest: { files?: Array<{ path?: string }> },
  folder: 'motion' | 'facial'
): string[] {
  const names = new Set<string>()
  for (const file of manifest.files ?? []) {
    const filePath = typeof file.path === 'string' ? file.path : ''
    if (!filePath.startsWith(`${folder}/`) || !filePath.endsWith('.sse-motion.json')) continue
    const base = path.basename(filePath, '.sse-motion.json').trim()
    if (base) names.add(base)
  }
  return [...names].sort()
}

async function cloudModelActions(
  entry: MoesekaiIndexEntry,
  libraryRoot: string,
  options: RequestOptions,
  onProgress: (message: string) => void
): Promise<{ path: string; motions: string[]; facials: string[] } | null> {
  let modelManifest
  try {
    modelManifest = await ripperManifest(libraryRoot, entry.bundle, options)
  } catch (error) {
    onProgress(`云端模型 ${entry.id} 读取包清单失败：${String(error)}`)
    return null
  }
  const model3File = modelManifest.files.find((file) => file.path.endsWith('.model3.json'))
  if (!model3File) {
    onProgress(`云端模型 ${entry.id} 没有 model3.json，已跳过`)
    return null
  }
  const variant = path.basename(model3File.path, '.model3.json')
  const model3Name = path.basename(model3File.path)
  const motions = new Set<string>()
  const facials = new Set<string>()
  const bundles = (
    entry.motions?.length ? entry.motions : entry.motion ? [entry.motion] : []
  ).filter((bundle): bundle is string => typeof bundle === 'string' && bundle.length > 0)

  for (const bundle of [...new Set(bundles)]) {
    try {
      const manifest = await ripperManifest(libraryRoot, bundle, options)
      for (const name of motionNames(manifest, 'motion')) motions.add(name)
      for (const name of motionNames(manifest, 'facial')) facials.add(name)
    } catch (error) {
      onProgress(`云端模型 ${entry.id} 读取动作包 ${bundle} 失败：${String(error)}`)
    }
  }

  return {
    path: `cloud/${entry.id}/${variant}/${model3Name}`,
    motions: [...motions].sort(),
    facials: [...facials].sort()
  }
}

function backgroundNameOf(id: string): { name: string; aliases: string[] } {
  const entry = backgroundNames[id]
  const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
  const aliases = Array.isArray(entry?.aliases)
    ? entry.aliases.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : []
  return { name: name && !/^[?？]+$/.test(name) ? name : id, aliases }
}

function bgmLabelOf(
  id: string,
  soundtracks: SoundtrackIndex | null
): { name: string; description: string } {
  const info = soundtracks?.tracks.get(soundtrackKey(id))
  if (!info) return { name: id, description: '' }
  const label = soundtrackLabel(info)
  return { name: label.name || id, description: label.description }
}

/**
 * 拉取一份完整云端目录（不落盘）。网络失败的单条模型会被跳过，
 * 背景/BGM 列表或模型索引整体失败则抛错，由调用方决定是否沿用旧缓存。
 */
export async function buildCloudCatalog(
  settings: AssetsSettings,
  options: BuildCloudCatalogOptions = {}
): Promise<CloudCatalogData> {
  const progress = options.onProgress ?? ((): void => undefined)
  const requestOptions: RequestOptions = {
    timeoutMs: options.timeoutMs ?? settings.timeoutMs,
    retries: options.retries ?? Math.min(settings.retries, 2),
    signal: options.signal
  }

  progress('读取云端 Live2D 模型索引 …')
  const { index, indexUrl } = await loadMoesekaiIndex(settings, settings.region, requestOptions)
  const libraryRoot = libraryRootFor(index, settings, settings.region)
  // 26 位角色各取一套首选服装；子角色/杂鱼不进入 AI 候选，避免目录膨胀。
  const selected = selectModels(index, { characters: ['all'] })
  progress(`云端模型索引：${index.models.length} 个模型，选角候选 ${selected.length} 个`)

  const models = (
    await mapPool(selected, MODEL_CONCURRENCY, async (entry) => {
      const character = characterById(entry.characterId ?? null)
      const actions = await cloudModelActions(entry, libraryRoot, requestOptions, progress)
      if (!actions) return null
      const display = {
        name: character?.name ?? entry.id,
        shortName: character?.shortName ?? entry.id
      }
      const result: CloudModelEntry = {
        id: entry.id,
        characterId: entry.characterId ?? null,
        name: display.name,
        shortName: display.shortName,
        bundle: entry.bundle,
        motionBundles: [
          ...new Set(
            (entry.motions?.length ? entry.motions : entry.motion ? [entry.motion] : []).filter(
              (bundle): bundle is string => typeof bundle === 'string' && bundle.length > 0
            )
          )
        ],
        path: actions.path,
        motions: actions.motions,
        facials: actions.facials,
        defaultMotion: pickPreferred(actions.motions, DEFAULT_MOTION_PREFERENCE),
        defaultFacial: pickPreferred(actions.facials, DEFAULT_FACIAL_PREFERENCE)
      }
      return result
    })
  ).filter((entry): entry is CloudModelEntry => entry !== null)

  progress('读取云端背景列表 …')
  const media = await listMedia({
    region: settings.region,
    kinds: ['background'],
    assetBase: settings.assetBase || undefined,
    timeoutMs: requestOptions.timeoutMs,
    retries: requestOptions.retries
  })
  const backgrounds: CloudBackgroundEntry[] = media.bundles
    .map((bundle) => {
      const named = backgroundNameOf(bundle.name)
      return {
        id: bundle.name,
        file: `cloud/${bundle.name}`,
        name: named.name,
        aliases: named.aliases,
        description: named.aliases.length > 0 ? `同类场景：${named.aliases.join(' / ')}` : ''
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
  progress(`云端背景：${backgrounds.length} 个`)

  progress('读取云端 BGM 列表 …')
  const [bgmMedia, soundtracks] = await Promise.all([
    listMedia({
      region: settings.region,
      kinds: ['bgm'],
      assetBase: settings.assetBase || undefined,
      timeoutMs: requestOptions.timeoutMs,
      retries: requestOptions.retries
    }),
    loadSoundtrackIndex({
      cacheFile: path.join(settings.cacheDir, 'soundtracks.json'),
      baseUrl: settings.soundtrackBase,
      timeoutMs: Math.min(requestOptions.timeoutMs, 20_000),
      retries: Math.min(requestOptions.retries, 1),
      onProgress: progress
    }).catch((error) => {
      progress(`BGM 曲名索引不可用：${String(error)}`)
      return null
    })
  ])
  const bgm: CloudBgmEntry[] = bgmMedia.bundles
    .map((bundle) => {
      const label = bgmLabelOf(bundle.name, soundtracks)
      return {
        id: bundle.name,
        file: `cloud/${bundle.name}.mp3`,
        name: label.name,
        description: label.description
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
  progress(`云端 BGM：${bgm.length} 首`)

  return {
    format: CLOUD_CATALOG_FORMAT,
    generatedAt: new Date().toISOString(),
    region: settings.region,
    sources: {
      indexUrl,
      libraryRoot,
      assetBase: media.assetBase,
      soundtrack: soundtracks?.source ?? ''
    },
    models,
    backgrounds,
    bgm
  }
}

function readCachedCatalog(file: string): CloudCatalogData | null {
  if (!fs.existsSync(file)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as CloudCatalogData
    if (parsed?.format !== CLOUD_CATALOG_FORMAT) return null
    if (
      !Array.isArray(parsed.models) ||
      !Array.isArray(parsed.backgrounds) ||
      !Array.isArray(parsed.bgm)
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function ageOf(catalog: CloudCatalogData): number {
  const generated = Date.parse(catalog.generatedAt)
  return Number.isFinite(generated) ? Date.now() - generated : Number.POSITIVE_INFINITY
}

/**
 * 云端目录服务：内存快照 + 磁盘缓存 + 定时刷新。
 *
 * `get()` 始终同步，供 ResourceCatalog 在构建提示词时读取最近一次成功快照；
 * `ensure()` 用于导出/AI 生成前等待首轮目录（带超时，离线时沿用旧快照）。
 */
export class CloudCatalogService {
  private readonly logger: Logger<ILogObj>
  private readonly settings: AssetsSettings
  private readonly cacheFile: string
  private readonly ttlMs: number
  private snapshot: CloudCatalogData | null = null
  private refreshing: Promise<CloudCatalogData | null> | null = null

  constructor(
    logger: Logger<ILogObj>,
    settings: AssetsSettings,
    options: { cacheFile?: string; ttlMs?: number } = {}
  ) {
    this.logger = logger
    this.settings = settings
    this.cacheFile = options.cacheFile ?? path.join(settings.cacheDir, 'catalog.json')
    this.ttlMs = options.ttlMs ?? CACHE_TTL_MS
  }

  /** 只读磁盘缓存，不联网；宿主启动时先调用，立即可用。 */
  loadFromCache(): CloudCatalogData | null {
    const cached = readCachedCatalog(this.cacheFile)
    if (cached) {
      this.snapshot = cached
      this.logger.info(
        `[Cloud] catalog cache loaded: ${cached.models.length} models, ${cached.backgrounds.length} backgrounds, ${cached.bgm.length} bgm (${cached.generatedAt})`
      )
    }
    return cached
  }

  get(): CloudCatalogData | null {
    return this.snapshot
  }

  isStale(): boolean {
    return !this.snapshot || ageOf(this.snapshot) > this.ttlMs
  }

  /** 拉取并替换快照；失败时保留旧快照。 */
  async refresh(): Promise<CloudCatalogData | null> {
    if (this.refreshing) return this.refreshing
    this.logger.info('[Cloud] refreshing resource catalog …')
    this.refreshing = buildCloudCatalog(this.settings, {
      onProgress: (message) => this.logger.info(`[Cloud] ${message}`)
    })
      .then((catalog) => {
        this.snapshot = catalog
        try {
          atomicWrite(this.cacheFile, `${JSON.stringify(catalog, null, 2)}\n`)
        } catch (error) {
          this.logger.warn(`[Cloud] failed to write catalog cache: ${String(error)}`)
        }
        this.logger.info(
          `[Cloud] catalog ready: ${catalog.models.length} models, ${catalog.backgrounds.length} backgrounds, ${catalog.bgm.length} bgm`
        )
        return catalog
      })
      .catch((error) => {
        this.logger.warn(`[Cloud] catalog refresh failed: ${String(error)}`)
        return this.snapshot
      })
      .finally(() => {
        this.refreshing = null
      })
    return this.refreshing
  }

  /**
   * 保证目录可用：有新鲜快照直接返回；否则等待刷新，最多等 timeoutMs；
   * 超时/失败返回已有快照（可能为 null），调用方回落本地资源。
   */
  async ensure(timeoutMs = 0): Promise<CloudCatalogData | null> {
    if (this.snapshot && !this.isStale()) return this.snapshot
    const refresh = this.refresh()
    if (timeoutMs <= 0) {
      await refresh
      return this.snapshot
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
    try {
      await Promise.race([refresh.then(() => undefined), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
    return this.snapshot
  }
}
