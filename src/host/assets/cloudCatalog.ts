/**
 * 云端资源目录：背景、BGM、SE、Live2D 模型全部从公开资源站/官方 master data 生成，
 * 不要求本地预下载或手工登记。
 *
 * 与 ournotes-player 的 "story site" 思路一致：目录本身只是一个清单（id → 名字 →
 * 远端位置），真正的图片/音频/模型在导出时按需物化到资源根下的 `cloud/` 子目录。
 * 这样 AI 只需要看到可读名字，宿主负责把名字/ID 解析成真实文件。
 *
 * 数据源：
 * - 模型：assets.pjsk.moe 的 sekai-live2d 索引 + 剧情库 `_ripper.json` + 离线服装语义库
 * - 背景 / BGM / SE：storage.exmeaning.com 的 bundle 列表（含 scenario/bgm 与 area_bgm）
 * - 背景/BGM/SE 中文语义：scripts/assets/build-*.mjs 离线生成的简体中文语义索引
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ILogObj, Logger } from 'tslog'
import type { AssetsSettings } from '../config'
import { atomicWrite, type RequestOptions } from './http'
import { mapPool } from './shared'
import { listMedia, listScenarioSeFiles } from './media'
import {
  isLegacyDeadMoesekaiUrl,
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
import bgmSemanticsData from './bgm-semantics.json'
import modelMetadataData from './model-metadata.json'
import seSemanticsData from './se-semantics.json'

export const CLOUD_CATALOG_FORMAT = 'msst.cloud-catalog/1'
export const CLOUD_CATALOG_SCHEMA_VERSION = 2
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const MODEL_CONCURRENCY = 10
const DEFAULT_MOTION_PREFERENCE = ['w-normal-default01', 'w-normal-greeting01', 'w-normal-nod01']
const DEFAULT_FACIAL_PREFERENCE = ['face_smile_01']

interface BackgroundNameMeta {
  name?: string
  aliases?: string[]
  category?: string
  timeOfDay?: string
  indoor?: string
  tags?: string[]
}

interface BackgroundNameFile {
  format?: string
  backgrounds?: Record<string, BackgroundNameMeta>
}

interface BgmSemanticMeta {
  name?: string
  category?: string
  mood?: string
  tempo?: string
  unit?: string
  scenes?: string[]
  description?: string
  bundlePrefix?: string
  tags?: string[]
}

interface BgmSemanticsFile {
  format?: string
  tracks?: Record<string, BgmSemanticMeta>
}

interface ModelMetaRecord {
  id: string
  characterId: number | null
  kind?: string
  name: string
  shortName: string
  unit?: string
  outfitCategory?: string
  outfitLabel?: string
  isDefault?: boolean
  isSubCharacter?: boolean
  model3Path?: string
  cloudPath?: string
}

interface ModelMetadataFile {
  format?: string
  models?: Record<string, ModelMetaRecord>
}

interface SeSemanticRecord {
  id: string
  file?: string
  category?: string
  description?: string
  tags?: string[]
}

interface SeSemanticsFile {
  format?: string
  cues?: Record<string, SeSemanticRecord>
}

const backgroundNames = (backgroundNameData as BackgroundNameFile).backgrounds ?? {}
const bgmSemantics = (bgmSemanticsData as BgmSemanticsFile).tracks ?? {}
const modelMetadata = (modelMetadataData as ModelMetadataFile).models ?? {}
const seSemantics = (seSemanticsData as SeSemanticsFile).cues ?? {}

const NOTABLE_SUB_IDS = new Set(
  Object.values(modelMetadata)
    .filter((entry) => entry.isSubCharacter)
    .map((entry) => entry.id)
)

export interface CloudModelEntry {
  /** moesekai 模型 id，如 20mizuki_normal */
  id: string
  characterId: number | null
  name: string
  shortName: string
  unit?: string
  outfitCategory?: string
  outfitLabel?: string
  isDefault?: boolean
  isSubCharacter?: boolean
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
  category?: string
  timeOfDay?: string
  indoor?: string
  tags?: string[]
}

export interface CloudBgmEntry {
  /** 稳定 id：bgm00003 / normal_area */
  id: string
  /** 相对 resources/audio/bgm/ 的路径 */
  file: string
  name: string
  description: string
  mood?: string
  tempo?: string
  category?: string
  unit?: string
  tags?: string[]
  /** 远端 bundle 路径（如 sound/scenario/bgm/bgm00003 或 sound/area_bgm/normal_area） */
  bundlePath?: string
  /** 若提取到 HCA/WAV 循环区间，则记录毫秒边界 */
  loopStartMs?: number
  loopEndMs?: number
}

export interface CloudSeEntry {
  /** 稳定 cue id：se00053_b / se_walk_women_001_1 */
  id: string
  /** 相对 resources/audio/se/ 的路径：cloud/se00053_b.mp3 */
  file: string
  name: string
  bundle: string
  category: string
  description: string
  tags: string[]
}

export interface CloudCatalogData {
  format: typeof CLOUD_CATALOG_FORMAT
  schemaVersion?: number
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
  se?: CloudSeEntry[]
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

type RipperCache = Map<string, Promise<Awaited<ReturnType<typeof ripperManifest>>>>

function cachedRipperManifest(
  cache: RipperCache,
  libraryRoot: string,
  bundle: string,
  options: RequestOptions
): ReturnType<typeof ripperManifest> {
  const key = `${libraryRoot}::${bundle}`
  let promise = cache.get(key)
  if (!promise) {
    promise = ripperManifest(libraryRoot, bundle, options).catch((error) => {
      cache.delete(key)
      throw error
    })
    cache.set(key, promise)
  }
  return promise
}

async function cloudModelActions(
  entry: MoesekaiIndexEntry,
  libraryRoot: string,
  options: RequestOptions,
  ripperCache: RipperCache,
  useStaticModelPath: boolean,
  onProgress: (message: string) => void
): Promise<{ path: string; motions: string[]; facials: string[] } | null> {
  const staticMeta = useStaticModelPath ? modelMetadata[entry.id] : undefined
  let cloudPath = staticMeta?.cloudPath ?? ''

  if (!cloudPath) {
    let modelManifest
    try {
      modelManifest = await cachedRipperManifest(ripperCache, libraryRoot, entry.bundle, options)
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
    cloudPath = `cloud/${entry.id}/${variant}/${model3Name}`
  }

  const motions = new Set<string>()
  const facials = new Set<string>()
  const bundles = (
    entry.motions?.length ? entry.motions : entry.motion ? [entry.motion] : []
  ).filter((bundle): bundle is string => typeof bundle === 'string' && bundle.length > 0)

  for (const bundle of [...new Set(bundles)]) {
    try {
      const manifest = await cachedRipperManifest(ripperCache, libraryRoot, bundle, options)
      for (const name of motionNames(manifest, 'motion')) motions.add(name)
      for (const name of motionNames(manifest, 'facial')) facials.add(name)
    } catch (error) {
      onProgress(`云端模型 ${entry.id} 读取动作包 ${bundle} 失败：${String(error)}`)
    }
  }

  return {
    path: cloudPath,
    motions: [...motions].sort(),
    facials: [...facials].sort()
  }
}

function backgroundMetaOf(id: string): {
  name: string
  aliases: string[]
  description: string
  category?: string
  timeOfDay?: string
  indoor?: string
  tags?: string[]
} {
  const entry = backgroundNames[id]
  const rawName = typeof entry?.name === 'string' ? entry.name.trim() : ''
  const name = rawName && !/^[?？]+$/.test(rawName) ? rawName : id
  const aliases = Array.isArray(entry?.aliases)
    ? entry.aliases.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : []
  const category = typeof entry?.category === 'string' ? entry.category : undefined
  const timeOfDay = typeof entry?.timeOfDay === 'string' ? entry.timeOfDay : undefined
  const indoor = typeof entry?.indoor === 'string' ? entry.indoor : undefined
  const tags = Array.isArray(entry?.tags) ? entry.tags : undefined

  const metaBits = [category, timeOfDay, indoor].filter(Boolean).join('·')
  const aliasBit = aliases.length > 0 ? `别名：${aliases.join(' / ')}` : ''
  const description = [metaBits, aliasBit].filter(Boolean).join(' | ')
  return { name, aliases, description, category, timeOfDay, indoor, tags }
}

function bgmLabelOf(
  id: string,
  soundtracks: SoundtrackIndex | null
): {
  name: string
  description: string
  mood?: string
  tempo?: string
  category?: string
  unit?: string
  tags?: string[]
} {
  const info = soundtracks?.tracks.get(soundtrackKey(id))
  const label = info ? soundtrackLabel(info) : null
  const sem = bgmSemantics[id] ?? bgmSemantics[id.replace(/_\d+$/, '')]
  if (sem) {
    const name = label?.name && label.name !== id ? label.name : sem.name || id
    const baseDesc = sem.description || ''
    const hasCat =
      label?.description && !baseDesc.includes(label.description.replace(/\s*BGM$/, ''))
    const description =
      hasCat && label?.description ? `${baseDesc}（${label.description}）` : baseDesc
    return {
      name,
      description,
      mood: sem.mood,
      tempo: sem.tempo,
      category: sem.category,
      unit: sem.unit,
      tags: sem.tags
    }
  }
  if (!label) return { name: id, description: '' }
  return { name: label.name || id, description: label.description }
}

function inferDefaultOutfitMeta(
  id: string,
  isDefault: boolean
): {
  outfitCategory: string
  outfitLabel: string
} {
  const clean = id.replace(/^v2_/, '')
  const isV2 = id.startsWith('v2_')
  const verTag = isV2 ? '(新立绘)' : ''
  if (/black\d*$/i.test(clean)) return { outfitCategory: '特殊', outfitLabel: '暗色剪影' }
  if (clean.includes('child')) return { outfitCategory: '特殊', outfitLabel: '幼年时期' }
  if (/^clb\d+_/.test(clean)) return { outfitCategory: '联动', outfitLabel: '联动服装' }
  if (clean.includes('april')) return { outfitCategory: '活动', outfitLabel: '愚人节限定服' }

  const suffix = clean.replace(/^\d{2}[a-z]+_/, '')
  if (suffix === 'normal')
    return { outfitCategory: '常服', outfitLabel: isV2 ? '日常常服(新版)' : '日常常服' }
  if (suffix.startsWith('casual')) return { outfitCategory: '私服', outfitLabel: `私服${verTag}` }
  if (suffix.startsWith('school')) return { outfitCategory: '校服', outfitLabel: `校服${verTag}` }
  if (suffix.startsWith('jc')) return { outfitCategory: '校服', outfitLabel: '初中校服' }
  if (suffix.startsWith('unit') || suffix.startsWith('longunit')) {
    return { outfitCategory: '队服', outfitLabel: `团体队服${verTag}` }
  }
  if (suffix.includes('darkunit'))
    return { outfitCategory: '队服', outfitLabel: `暗色队服${verTag}` }
  if (suffix.startsWith('sports')) return { outfitCategory: '运动服', outfitLabel: '运动服/体操服' }
  if (suffix.startsWith('swim')) return { outfitCategory: '泳装', outfitLabel: '泳装' }
  if (suffix.startsWith('pajamas')) return { outfitCategory: '私服', outfitLabel: '睡衣' }
  if (suffix.startsWith('parttime')) return { outfitCategory: '打工服', outfitLabel: '打工服' }
  if (suffix.startsWith('lesson')) return { outfitCategory: '运动服', outfitLabel: '练习服' }
  if (suffix.startsWith('culture')) return { outfitCategory: '活动', outfitLabel: '文化祭服装' }
  if (suffix.startsWith('yukata') || suffix.startsWith('kimono') || suffix.startsWith('haregi')) {
    return { outfitCategory: '和服', outfitLabel: '和服/浴衣' }
  }
  if (suffix.startsWith('christmas')) return { outfitCategory: '活动', outfitLabel: '圣诞服装' }
  if (suffix.startsWith('wedding') || suffix.startsWith('tuxedo'))
    return { outfitCategory: '礼服', outfitLabel: '礼服' }
  if (suffix.startsWith('archery')) return { outfitCategory: '活动', outfitLabel: '弓道服' }
  if (suffix.startsWith('priestess')) return { outfitCategory: '活动', outfitLabel: '巫女服' }
  if (suffix.startsWith('police')) return { outfitCategory: '活动', outfitLabel: '警服' }
  if (suffix.startsWith('tenniswear')) return { outfitCategory: '运动服', outfitLabel: '网球服' }
  if (suffix.includes('fancostume'))
    return { outfitCategory: '演出服', outfitLabel: `粉丝应援演出服(${suffix})` }
  if (suffix.startsWith('cloth'))
    return { outfitCategory: '演出服', outfitLabel: `活动演出服(${suffix})` }
  if (/^(?:band|idol|street|wonder|night)/.test(suffix)) {
    return { outfitCategory: '队服', outfitLabel: `「世界」队服(${suffix})` }
  }
  return {
    outfitCategory: isDefault ? '常服' : '活动',
    outfitLabel: isDefault ? '默认服装' : suffix
  }
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

  // 选出各角色的默认首选服装 id，用于标记 isDefault，同时保留全量服装与知名配角。
  const primaryModels = selectModels(index, { characters: ['all'] })
  const primaryIds = new Set(primaryModels.map((entry) => entry.id))
  const selected = selectModels(index, {
    characters: ['all'],
    allOutfits: true,
    includeSub: true,
    notableIds: NOTABLE_SUB_IDS
  })
  progress(`云端模型索引：${index.models.length} 个模型，全量选角/换装候选 ${selected.length} 个`)

  // 本地 mock 测试或极小索引直接拉 _ripper.json；真实远端全量索引优先复用离线 model-metadata.json 的 model3Path
  const isMockOrSmallIndex =
    index.models.length <= 50 ||
    /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(settings.indexBase)
  const ripperCache: RipperCache = new Map()

  const models = (
    await mapPool(selected, MODEL_CONCURRENCY, async (entry) => {
      const character = characterById(entry.characterId ?? null)
      const staticMeta = modelMetadata[entry.id]
      const actions = await cloudModelActions(
        entry,
        libraryRoot,
        requestOptions,
        ripperCache,
        !isMockOrSmallIndex,
        progress
      )
      if (!actions) return null
      const isDefault = primaryIds.has(entry.id) || Boolean(staticMeta?.isDefault)
      const fallbackOutfit = inferDefaultOutfitMeta(entry.id, isDefault)
      const display = {
        name: character?.name ?? staticMeta?.name ?? entry.id,
        shortName: character?.shortName ?? staticMeta?.shortName ?? entry.id
      }
      const result: CloudModelEntry = {
        id: entry.id,
        characterId: entry.characterId ?? null,
        name: display.name,
        shortName: display.shortName,
        ...(staticMeta?.unit ? { unit: staticMeta.unit } : {}),
        outfitCategory: staticMeta?.outfitCategory ?? fallbackOutfit.outfitCategory,
        outfitLabel: staticMeta?.outfitLabel ?? fallbackOutfit.outfitLabel,
        isDefault,
        ...(staticMeta?.isSubCharacter || (!character && entry.kind !== 'character')
          ? { isSubCharacter: true }
          : {}),
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
      const meta = backgroundMetaOf(bundle.name)
      return {
        id: bundle.name,
        file: `cloud/${bundle.name}`,
        name: meta.name,
        aliases: meta.aliases,
        description: meta.description,
        ...(meta.category ? { category: meta.category } : {}),
        ...(meta.timeOfDay ? { timeOfDay: meta.timeOfDay } : {}),
        ...(meta.indoor ? { indoor: meta.indoor } : {}),
        ...(meta.tags?.length ? { tags: meta.tags } : {})
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
  progress(`云端背景：${backgrounds.length} 个`)

  progress('读取云端 BGM（含区域 BGM）与 SE 列表 …')
  const [bgmMedia, soundtracks, scenarioSe] = await Promise.all([
    listMedia({
      region: settings.region,
      kinds: ['bgm'],
      includeAreaBgm: true,
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
    }),
    listScenarioSeFiles({
      region: settings.region,
      assetBase: settings.assetBase || undefined,
      timeoutMs: Math.min(requestOptions.timeoutMs, 25_000),
      retries: Math.min(requestOptions.retries, 1)
    }).catch((error) => {
      progress(`云端 SE 索引不可用：${String(error)}`)
      return []
    })
  ])

  const seenBgmIds = new Set<string>()
  const bgm: CloudBgmEntry[] = []
  for (const bundle of bgmMedia.bundles) {
    if (seenBgmIds.has(bundle.name)) continue
    seenBgmIds.add(bundle.name)
    const label = bgmLabelOf(bundle.name, soundtracks)
    bgm.push({
      id: bundle.name,
      file: `cloud/${bundle.name}.mp3`,
      name: label.name,
      description: label.description,
      bundlePath: bundle.path,
      ...(label.mood ? { mood: label.mood } : {}),
      ...(label.tempo ? { tempo: label.tempo } : {}),
      ...(label.category ? { category: label.category } : {}),
      ...(label.unit ? { unit: label.unit } : {}),
      ...(label.tags?.length ? { tags: label.tags } : {})
    })
  }
  bgm.sort((a, b) => a.id.localeCompare(b.id))

  const se: CloudSeEntry[] = scenarioSe.map((entry) => {
    const sem =
      seSemantics[entry.id] ??
      seSemantics[entry.id.replace(/_b$/, '')] ??
      seSemantics[entry.id.replace(/(?:_b)?_\d+$/, '')]
    return {
      id: entry.id,
      file: `cloud/${entry.file}`,
      name: entry.id,
      bundle: entry.bundle,
      category: sem?.category || entry.category,
      description: sem?.description || entry.description,
      tags: sem?.tags?.length ? sem.tags : entry.tags
    }
  })
  progress(`云端 BGM：${bgm.length} 首（含区域 BGM），SE：${se.length} 个`)

  return {
    format: CLOUD_CATALOG_FORMAT,
    schemaVersion: CLOUD_CATALOG_SCHEMA_VERSION,
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
    bgm,
    se
  }
}

function readCachedCatalog(file: string): CloudCatalogData | null {
  if (!fs.existsSync(file)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as CloudCatalogData
    if (parsed?.format !== CLOUD_CATALOG_FORMAT) return null
    if (parsed.schemaVersion !== CLOUD_CATALOG_SCHEMA_VERSION) return null
    if (
      !Array.isArray(parsed.models) ||
      !Array.isArray(parsed.backgrounds) ||
      !Array.isArray(parsed.bgm)
    ) {
      return null
    }
    if (!Array.isArray(parsed.se)) {
      parsed.se = []
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
    if (!this.snapshot) return true
    if (isLegacyDeadMoesekaiUrl(this.snapshot.sources?.indexUrl ?? '')) return true
    return ageOf(this.snapshot) > this.ttlMs
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
          `[Cloud] catalog ready: ${catalog.models.length} models, ${catalog.backgrounds.length} backgrounds, ${catalog.bgm.length} bgm, ${catalog.se?.length ?? 0} se`
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
  async ensure(timeoutMs = 0, signal?: AbortSignal): Promise<CloudCatalogData | null> {
    if (this.snapshot && !this.isStale()) return this.snapshot
    if (signal?.aborted) return this.snapshot
    const refresh = this.refresh()
    if (timeoutMs <= 0 && !signal) {
      await refresh
      return this.snapshot
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    let onAbort: (() => void) | null = null
    const racers: Array<Promise<void>> = [refresh.then(() => undefined)]
    if (timeoutMs > 0) {
      racers.push(
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs)
        })
      )
    }
    if (signal) {
      racers.push(
        new Promise<void>((resolve) => {
          onAbort = () => resolve()
          signal.addEventListener('abort', onAbort, { once: true })
        })
      )
    }
    try {
      await Promise.race(racers)
    } finally {
      if (timer) clearTimeout(timer)
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    }
    return this.snapshot
  }

  /**
   * 按当前是否存在快照选择等待窗口：
   * - 已有缓存（仅过期刷新）：只等 `staleTimeoutMs`（默认 2s），不阻塞日常请求
   * - 冷启动尚无任何快照（零本地缓存）：最多等 `coldTimeoutMs`（默认 60s），避免早期请求撞上空目录
   */
  async waitReady(
    options: { coldTimeoutMs?: number; staleTimeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<CloudCatalogData | null> {
    const staleTimeoutMs = options.staleTimeoutMs ?? 2_000
    const coldTimeoutMs = options.coldTimeoutMs ?? 60_000
    const waitMs = this.snapshot ? staleTimeoutMs : coldTimeoutMs
    return this.ensure(waitMs, options.signal)
  }
}
