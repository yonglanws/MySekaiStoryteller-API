import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { ILogObj, Logger } from 'tslog'
import type { HostConfig } from '../config'

export interface CatalogModel {
  id: number
  name: string
  /** 相对 resources/models/ 的 model3.json 路径 */
  path: string
  /** 动作名清单（model3.json FileReferences.Motions 中非 face_ 前缀的 key） */
  motions: string[]
  /** 表情名清单（face_ 前缀） */
  facials: string[]
  defaultMotion: string
  defaultFacial: string
}

export interface CatalogImage {
  file: string
  name: string
  description: string
}

export interface ResourceCatalogData {
  models: CatalogModel[]
  images: string[]
  /** 带描述的背景清单（有登记表时供 AI 选图；无登记时为空） */
  imageDetails: CatalogImage[]
  voices: string[]
  bgm: string[]
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
  private cache: ResourceCatalogData | null = null
  private cacheTime = 0

  constructor(logger: Logger<ILogObj>, config: HostConfig) {
    this.logger = logger
    this.config = config
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
      return { models: [], images: [], imageDetails: [], voices: [], bgm: [] }
    }
  }

  private build(): ResourceCatalogData {
    const resourcesDir = this.config.paths.resources
    const modelsDir = path.join(resourcesDir, 'models')

    const manifest = yaml.load(
      fs.readFileSync(path.join(modelsDir, 'models.yaml'), 'utf-8')
    ) as ModelManifest

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
        path: entry.path,
        motions,
        facials,
        defaultMotion: pickPreferred(motions, DEFAULT_MOTION_PREFERENCE),
        defaultFacial: pickPreferred(facials, DEFAULT_FACIAL_PREFERENCE)
      })
      // shortName 透传给目录消费方（插件对照表用）
      const model = models[models.length - 1]
      ;(model as CatalogModel & { shortName?: string }).shortName = entry.shortName || entry.name
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

    return {
      models,
      images: imageFiles,
      imageDetails,
      voices: listFiles('voices', AUDIO_EXTENSIONS),
      bgm: listFiles('audio/bgm', AUDIO_EXTENSIONS)
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
