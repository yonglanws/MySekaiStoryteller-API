import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { ILogObj, Logger } from 'tslog'
import type { HostConfig } from '../config'
import {
  readSoundtrackIndex,
  soundtrackKey,
  soundtrackLabel,
  type SoundtrackIndex
} from '../assets/soundtracks'
import type { CloudCatalogData } from '../assets/cloudCatalog'

export interface CatalogModel {
  id: number
  name: string
  /** 简称（提示词与说话人绑定用）；缺省回退 name */
  shortName?: string
  /** 相对 resources/models/ 的 model3.json 路径 */
  path: string
  /** 动作名清单（model3.json FileReferences.Motions 中非 face_ 前缀的 key） */
  motions: string[]
  /** 表情名清单（face_ 前缀） */
  facials: string[]
  defaultMotion: string
  defaultFacial: string
  /** 条目来源：未标时为本地登记；cloud 表示从云端目录补齐 */
  source?: 'local' | 'cloud'
  /** 云端模型 id（source=cloud 时） */
  cloudId?: string
}

export interface CatalogImage {
  file: string
  name: string
  description: string
  /** 云端背景的稳定 id（source=cloud 时） */
  id?: string
  /** 官方剧情中同一背景出现过的其它地点名 */
  aliases?: string[]
  source?: 'local' | 'cloud'
}

export interface CatalogBgm {
  file: string
  name: string
  description: string
  /** 云端 BGM 的稳定 id（source=cloud 时） */
  id?: string
  source?: 'local' | 'cloud'
}

export interface ResourceCatalogData {
  models: CatalogModel[]
  images: string[]
  /** 带描述的背景清单（有登记表时供 AI 选图；无登记时为空） */
  imageDetails: CatalogImage[]
  voices: string[]
  bgm: string[]
  /** 带描述的 BGM 清单（audio/bgm/bgm.yaml 登记时供 AI 了解可选项；未登记时为空） */
  bgmDetails: CatalogBgm[]
  /** 云端目录状态；云端不可用时省略 */
  cloud?: {
    generatedAt: string
    models: number
    backgrounds: number
    bgm: number
  }
}

interface ModelManifest {
  models?: Array<{
    id: number
    name: string
    shortName?: string
    path: string
  }>
}

interface ImageManifest {
  images?: Array<{
    file?: string
    name?: string
    description?: string
  }>
}

interface BgmManifest {
  bgm?: Array<{
    file?: string
    name?: string
    description?: string
  }>
}

const CACHE_TTL_MS = 30_000
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.flac'])
const DEFAULT_MOTION_PREFERENCE = ['w-normal-default01', 'w-normal-greeting01', 'w-normal-nod01']
const DEFAULT_FACIAL_PREFERENCE = ['face_smile_01']

function pickPreferred(names: string[], preferences: string[]): string {
  for (const candidate of preferences) {
    if (names.includes(candidate)) return candidate
  }
  return names[0] ?? ''
}

/** bg_a000301.webp → bg_a000301；用于把云端名字贴到本地同名资源上。 */
function fileStem(file: string): string {
  return path.basename(file).replace(/\.[^.]+$/, '')
}

/**
 * 资源目录：从 resources/ 构建模型/背景/语音/BGM 的全量清单。
 *
 * - models/models.yaml 为用户维护的角色登记表
 * - images/images.yaml 为用户维护的背景描述表（AI 按 description 选图）
 * - 每个模型的动作/表情从 model3.json 的 FileReferences.Motions 自动解析
 * - 30 秒内存缓存；构建失败时沿用上一次成功结果
 */
export class ResourceCatalog {
  private readonly logger: Logger<ILogObj>
  private readonly config: HostConfig
  private readonly cloud: (() => CloudCatalogData | null) | null
  private cache: ResourceCatalogData | null = null
  private cacheTime = 0

  constructor(
    logger: Logger<ILogObj>,
    config: HostConfig,
    cloud: (() => CloudCatalogData | null) | null = null
  ) {
    this.logger = logger
    this.config = config
    this.cloud = cloud
  }

  get(): ResourceCatalogData {
    const now = Date.now()
    if (this.cache && now - this.cacheTime < CACHE_TTL_MS) {
      return this.cache
    }

    try {
      const data = this.build()
      this.cache = data
      this.cacheTime = now
      return data
    } catch (err) {
      this.logger.error('[Catalog] Failed to build resource catalog', err)
      if (this.cache) {
        return this.cache
      }
      return { models: [], images: [], imageDetails: [], voices: [], bgm: [], bgmDetails: [] }
    }
  }

  private build(): ResourceCatalogData {
    const resourcesDir = this.config.paths.resources
    const modelsDir = path.join(resourcesDir, 'models')
    const manifestPath = path.join(modelsDir, 'models.yaml')

    // 云端模式下 models.yaml 可以完全不存在：本地清单是可选覆盖，
    // 不是启动前提。
    let manifest: ModelManifest = { models: [] }
    if (fs.existsSync(manifestPath)) {
      const loaded = yaml.load(fs.readFileSync(manifestPath, 'utf-8')) as unknown
      if (loaded !== null && loaded !== undefined) {
        if (typeof loaded !== 'object' || Array.isArray(loaded)) {
          throw new Error(`models.yaml must be a key-value mapping: ${manifestPath}`)
        }
        manifest = loaded as ModelManifest
      }
    } else {
      this.logger.info('[Catalog] models.yaml not found, using cloud catalog only')
    }

    const models: CatalogModel[] = []
    for (const entry of manifest.models ?? []) {
      if (!entry?.path || !entry?.name || !Number.isFinite(entry.id)) {
        this.logger.warn(`[Catalog] Invalid model manifest entry: ${JSON.stringify(entry)}`)
        continue
      }

      const modelJsonPath = path.join(modelsDir, entry.path)
      let motions: string[] = []
      let facials: string[] = []

      try {
        const names = this.readMotionNames(modelJsonPath)
        motions = names.filter((n) => !n.startsWith('face_')).sort()
        facials = names.filter((n) => n.startsWith('face_')).sort()
      } catch (err) {
        this.logger.warn(`[Catalog] Failed to read model3.json for ${entry.path}`, err)
      }

      models.push({
        id: entry.id,
        name: entry.name,
        shortName: entry.shortName || entry.name,
        path: entry.path,
        motions,
        facials,
        defaultMotion: pickPreferred(motions, DEFAULT_MOTION_PREFERENCE),
        defaultFacial: pickPreferred(facials, DEFAULT_FACIAL_PREFERENCE),
        source: 'local'
      })
    }

    const listFiles = (relDir: string, extensions: Set<string>): string[] => {
      const dir = path.join(resourcesDir, relDir)
      if (!fs.existsSync(dir)) {
        return []
      }
      return fs
        .readdirSync(dir)
        .filter((f) => {
          try {
            return (
              fs.statSync(path.join(dir, f)).isFile() && extensions.has(path.extname(f).toLowerCase())
            )
          } catch {
            return false
          }
        })
        .sort()
    }

    const imageFiles = listFiles('images', IMAGE_EXTENSIONS)
    const imageDetails = this.loadImageDetails(resourcesDir, imageFiles)
    const bgmFiles = listFiles('audio/bgm', AUDIO_EXTENSIONS)
    const bgmDetails = this.loadBgmDetails(resourcesDir, bgmFiles)

    const cloud = this.cloud?.() ?? null
    if (cloud) {
      this.mergeCloudModels(models, cloud)
      this.mergeCloudBackgrounds(imageFiles, imageDetails, cloud)
      this.mergeCloudBgm(bgmFiles, bgmDetails, cloud)
    }

    return {
      models,
      images: imageFiles,
      imageDetails,
      voices: listFiles('voices', AUDIO_EXTENSIONS),
      bgm: bgmFiles,
      bgmDetails,
      ...(cloud
        ? {
            cloud: {
              generatedAt: cloud.generatedAt,
              models: cloud.models.length,
              backgrounds: cloud.backgrounds.length,
              bgm: cloud.bgm.length
            }
          }
        : {})
    }
  }

  /**
   * 云端模型补进目录：本地已有同名角色时本地优先（用户明确下载过的模型
   * 不应被云端首选服装替换）；数值 id 用 1000+characterId，避免和本地
   * models.yaml 的 1..N 冲突。
   */
  private mergeCloudModels(models: CatalogModel[], cloud: CloudCatalogData): void {
    const localNames = new Set(models.map((model) => model.name.toLowerCase()))
    const usedIds = new Set(models.map((model) => model.id))
    for (const entry of cloud.models) {
      if (localNames.has(entry.name.toLowerCase())) continue
      const numericId = entry.characterId ? 1000 + entry.characterId : 2000 + models.length
      if (usedIds.has(numericId)) continue
      usedIds.add(numericId)
      localNames.add(entry.name.toLowerCase())
      models.push({
        id: numericId,
        name: entry.name,
        shortName: entry.shortName,
        path: entry.path,
        motions: entry.motions,
        facials: entry.facials,
        defaultMotion: entry.defaultMotion,
        defaultFacial: entry.defaultFacial,
        source: 'cloud',
        cloudId: entry.id
      })
    }
  }

  private mergeCloudBackgrounds(
    imageFiles: string[],
    imageDetails: CatalogImage[],
    cloud: CloudCatalogData
  ): void {
    const files = new Set(imageFiles.map((file) => file.toLowerCase()))
    const localByStem = new Map(imageFiles.map((file) => [fileStem(file).toLowerCase(), file]))
    const detailsByFile = new Map(imageDetails.map((detail) => [detail.file.toLowerCase(), detail]))
    const names = new Set(imageDetails.map((detail) => detail.name.toLowerCase()))
    for (const entry of cloud.backgrounds) {
      // 没有官方地点名的背景只保留在云端目录里，可用 id 直接引用；
      // 不放进 AI 候选/插件资源列表，避免 1300+ 条无语义条目刷屏。
      if (entry.name === entry.id) continue

      const localFile = localByStem.get(entry.id.toLowerCase())
      if (localFile) {
        // 本地已有同一背景（常见于 fetch:media 下载的 bg_xxx.webp）：
        // 不新增 cloud/ 副本，而是把官方地点名贴到本地条目上。
        const detail = detailsByFile.get(localFile.toLowerCase())
        if (detail) {
          if (!detail.name || detail.name === detail.file) detail.name = entry.name
          if (!detail.id) detail.id = entry.id
          if (!detail.aliases?.length) detail.aliases = entry.aliases
          if (!detail.description) detail.description = entry.description
        } else {
          const created: CatalogImage = {
            file: localFile,
            name: entry.name,
            description: entry.description,
            id: entry.id,
            aliases: entry.aliases,
            source: 'cloud'
          }
          imageDetails.push(created)
          detailsByFile.set(localFile.toLowerCase(), created)
        }
        names.add(entry.name.toLowerCase())
        continue
      }

      const fileKey = entry.file.toLowerCase()
      const nameKey = entry.name.toLowerCase()
      if (files.has(fileKey) || names.has(nameKey)) continue
      files.add(fileKey)
      names.add(nameKey)
      imageFiles.push(entry.file)
      const created: CatalogImage = {
        file: entry.file,
        name: entry.name,
        description: entry.description,
        id: entry.id,
        aliases: entry.aliases,
        source: 'cloud'
      }
      imageDetails.push(created)
      detailsByFile.set(entry.file.toLowerCase(), created)
    }
  }

  private mergeCloudBgm(
    bgmFiles: string[],
    bgmDetails: CatalogBgm[],
    cloud: CloudCatalogData
  ): void {
    const files = new Set(bgmFiles.map((file) => file.toLowerCase()))
    const localByStem = new Map(bgmFiles.map((file) => [fileStem(file).toLowerCase(), file]))
    const detailsByFile = new Map(bgmDetails.map((detail) => [detail.file.toLowerCase(), detail]))
    const names = new Set(bgmDetails.map((detail) => detail.name.toLowerCase()))
    let cloudCount = 0
    for (const entry of cloud.bgm) {
      if (cloudCount >= 80) break
      // 官方曲名索引没覆盖的曲目只保留 id 能力，不进入候选。
      if (entry.name === entry.id && !entry.description) continue

      const localFile = localByStem.get(entry.id.toLowerCase())
      if (localFile) {
        // 本地已有同一首曲子：只补曲名/分类，不新增 cloud/ 副本。
        const detail = detailsByFile.get(localFile.toLowerCase())
        if (detail) {
          if (!detail.name || detail.name === detail.file) detail.name = entry.name
          if (!detail.id) detail.id = entry.id
          if (!detail.description) detail.description = entry.description
        } else {
          const created: CatalogBgm = {
            file: localFile,
            name: entry.name,
            description: entry.description,
            id: entry.id,
            source: 'cloud'
          }
          bgmDetails.push(created)
          detailsByFile.set(localFile.toLowerCase(), created)
        }
        names.add(entry.name.toLowerCase())
        continue
      }

      const fileKey = entry.file.toLowerCase()
      const nameKey = entry.name.toLowerCase()
      if (files.has(fileKey) || names.has(nameKey)) continue
      files.add(fileKey)
      names.add(nameKey)
      cloudCount++
      bgmFiles.push(entry.file)
      const created: CatalogBgm = {
        file: entry.file,
        name: entry.name,
        description: entry.description,
        id: entry.id,
        source: 'cloud'
      }
      bgmDetails.push(created)
      detailsByFile.set(entry.file.toLowerCase(), created)
    }
  }

  /**
   * 读取 BGM 清单（audio/bgm/bgm.yaml）。返回带描述的曲目列表，
   * 只保留在磁盘上真实存在的文件；未登记或格式非法时返回空列表。
   *
   * 清单里 name/description 为空时，用 fetch:media 缓存的官方曲名索引补全
   * （bgm00003 → Slapstick!! / 剧情 BGM）；人工写过的字段优先，不覆盖。
   */
  private loadBgmDetails(resourcesDir: string, bgmFiles: string[]): CatalogBgm[] {
    const manifestPath = path.join(resourcesDir, 'audio', 'bgm', 'bgm.yaml')
    if (!fs.existsSync(manifestPath)) {
      return []
    }

    let manifest: BgmManifest
    try {
      manifest = yaml.load(fs.readFileSync(manifestPath, 'utf-8')) as BgmManifest
    } catch (err) {
      this.logger.warn('[Catalog] Failed to parse audio/bgm/bgm.yaml', err)
      return []
    }

    const soundtracks = this.loadSoundtracks(resourcesDir)
    const known = new Set(bgmFiles)
    const details: CatalogBgm[] = []
    for (const entry of manifest.bgm ?? []) {
      const file = typeof entry?.file === 'string' ? entry.file.trim() : ''
      if (!file) continue
      if (!known.has(file)) {
        this.logger.warn(`[Catalog] bgm.yaml entry missing on disk, skipped: ${file}`)
        continue
      }

      const soundtrack = soundtracks?.tracks.get(soundtrackKey(file))
      const label = soundtrack ? soundtrackLabel(soundtrack) : null
      const rawName = (entry.name || '').trim()
      const rawDescription = (entry.description || '').trim()
      const nameIsPlaceholder = !rawName || rawName === file || rawName === soundtrackKey(file)

      details.push({
        file,
        name: nameIsPlaceholder ? label?.name || file : rawName,
        description: rawDescription || label?.description || ''
      })
    }
    return details
  }

  /** 读取 fetch:media 写下的官方曲名缓存；缺失或损坏时不阻断 catalog。 */
  private loadSoundtracks(resourcesDir: string): SoundtrackIndex | null {
    const file = path.join(resourcesDir, 'audio', 'bgm', 'soundtracks.json')
    try {
      return readSoundtrackIndex(file)
    } catch (err) {
      this.logger.warn('[Catalog] Failed to read audio/bgm/soundtracks.json', err)
      return null
    }
  }

  /**
   * 读取 model3.json 登记的动作/表情 key。
   *
   * 上游"裸包"经常缺 FileReferences.Motions 索引（motions/ 文件在但没登记），
   * 而渲染端加载动作也是按这份索引取文件的，不补就既枚举不到也播不了。
   * 这里发现索引缺失时用 motions/ 目录实际文件补齐并回写 model3.json，
   * 对 catalog 枚举和渲染端加载同时生效。
   */
  private readMotionNames(modelJsonPath: string): string[] {
    interface MotionEntry { File?: string; FadeInTime?: number; FadeOutTime?: number }
    const model3 = JSON.parse(fs.readFileSync(modelJsonPath, 'utf-8')) as {
      FileReferences?: { Motions?: Record<string, MotionEntry[]> }
    }
    if (!model3.FileReferences) model3.FileReferences = {}
    const indexed = model3.FileReferences.Motions ?? {}

    const motionsDir = path.join(path.dirname(modelJsonPath), 'motions')
    if (!fs.existsSync(motionsDir)) {
      return Object.keys(indexed)
    }

    const files = fs
      .readdirSync(motionsDir)
      .filter((f) => f.endsWith('.motion3.json'))
      .sort()

    let dirty = false
    for (const file of files) {
      const key = file.slice(0, -'.motion3.json'.length)
      if (!indexed[key]) {
        indexed[key] = [{ FadeInTime: 0.5, FadeOutTime: 0.5, File: `motions/${file}` }]
        dirty = true
      }
    }

    if (dirty) {
      model3.FileReferences.Motions = indexed
      try {
        fs.writeFileSync(modelJsonPath, JSON.stringify(model3, null, 2))
        this.logger.info(
          `[Catalog] Backfilled ${files.length} motion entries into ${modelJsonPath}`
        )
      } catch (err) {
        // 写不回也不致命：catalog 用内存里的索引，渲染端沿用旧行为
        this.logger.warn(`[Catalog] Failed to write back Motions index to ${modelJsonPath}`, err)
      }
    }

    return Object.keys(indexed)
  }

  private loadImageDetails(resourcesDir: string, imageFiles: string[]): CatalogImage[] {
    const manifestPath = path.join(resourcesDir, 'images', 'images.yaml')
    if (!fs.existsSync(manifestPath)) {
      return []
    }

    let manifest: ImageManifest
    try {
      manifest = yaml.load(fs.readFileSync(manifestPath, 'utf-8')) as ImageManifest
    } catch (err) {
      this.logger.warn('[Catalog] Failed to parse images.yaml', err)
      return []
    }

    const known = new Set(imageFiles)
    const details: CatalogImage[] = []
    for (const entry of manifest.images ?? []) {
      const file = typeof entry?.file === 'string' ? entry.file.trim() : ''
      if (!file) continue
      if (!known.has(file)) {
        this.logger.warn(`[Catalog] images.yaml entry missing on disk, skipped: ${file}`)
        continue
      }
      details.push({
        file,
        name: (entry.name || file).trim(),
        description: (entry.description || '').trim()
      })
    }
    return details
  }
}
