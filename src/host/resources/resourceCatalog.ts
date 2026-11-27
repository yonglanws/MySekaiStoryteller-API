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
import bgmSemanticsData from '../assets/bgm-semantics.json'
import seSemanticsData from '../assets/se-semantics.json'
import { CURATED_SCENARIO_SES, resolveScenarioSe } from '../ai/scenarioCues'

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
  /** PJSK 角色编号（1~26） */
  characterId?: number | null
  /** 所属组合（Leo/need、25时，Nightcord de. 等） */
  unit?: string
  /** 服装大类（常服/校服/私服/队服/运动服/泳装/和服/演出服/活动/特殊） */
  outfitCategory?: string
  /** 服装中文说明 */
  outfitLabel?: string
  /** 是否为该角色的首选默认服装 */
  isDefault?: boolean
  /** 是否为配角/联动角色 */
  isSubCharacter?: boolean
}

export interface CatalogImage {
  file: string
  name: string
  description: string
  /** 云端背景的稳定 id（source=cloud 时） */
  id?: string
  /** 官方剧情中同一背景出现过的其它地点名 */
  aliases?: string[]
  category?: string
  timeOfDay?: string
  indoor?: string
  tags?: string[]
  source?: 'local' | 'cloud'
}

export interface CatalogBgm {
  file: string
  name: string
  description: string
  /** 云端 BGM 的稳定 id（source=cloud 时） */
  id?: string
  mood?: string
  tempo?: string
  category?: string
  unit?: string
  tags?: string[]
  source?: 'local' | 'cloud'
  loopStartMs?: number
  loopEndMs?: number
  durationMs?: number
}

export interface CatalogSeItem {
  file: string
  id?: string
  name: string
  category?: string
  description: string
  tags?: string[]
}

export interface ResourceCatalogData {
  models: CatalogModel[]
  images: string[]
  /** 带描述的背景清单（有登记表时供 AI 选图；无登记时为空） */
  imageDetails: CatalogImage[]
  voices: string[]
  bgm: string[]
  /** 带描述的 BGM 清单（audio/bgm/bgm.yaml 或云端目录；未登记时为空） */
  bgmDetails: CatalogBgm[]
  /** 云端 SE 语义清单 */
  seDetails?: CatalogSeItem[]
  /** 是否处于严格纯云端模式 */
  cloudOnly?: boolean
  /** 云端目录状态；云端不可用时省略 */
  cloud?: {
    generatedAt: string
    models: number
    backgrounds: number
    bgm: number
    se?: number
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

interface BgmSemanticMeta {
  name?: string
  category?: string
  mood?: string
  tempo?: string
  unit?: string
  description?: string
  tags?: string[]
}

interface BgmSemanticsFile {
  tracks?: Record<string, BgmSemanticMeta>
}

interface SeSemanticMeta {
  id?: string
  file?: string
  category?: string
  description?: string
  tags?: string[]
}

interface SeSemanticsFile {
  cues?: Record<string, SeSemanticMeta>
}

interface LoopSidecarMeta {
  loopStartMs?: number
  loopEndMs?: number
  durationMs?: number
}

const bgmSemantics = (bgmSemanticsData as BgmSemanticsFile).tracks ?? {}
const seSemantics = (seSemanticsData as SeSemanticsFile).cues ?? {}

function lookupBgmSemantic(stem: string): BgmSemanticMeta | null {
  return (
    bgmSemantics[stem] ??
    bgmSemantics[stem.toLowerCase()] ??
    bgmSemantics[stem.replace(/_\d+$/, '')] ??
    null
  )
}

function lookupSeSemantic(stem: string): SeSemanticMeta | null {
  return (
    seSemantics[stem] ??
    seSemantics[stem.toLowerCase()] ??
    seSemantics[stem.replace(/_\d+$/, '')] ??
    null
  )
}

function readLoopSidecar(audioFullPath: string): LoopSidecarMeta | null {
  const sidecarPath = `${audioFullPath}.loop.json`
  if (!fs.existsSync(sidecarPath)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8')) as Record<string, unknown>
    const out: LoopSidecarMeta = {}
    if (typeof parsed.loopStartMs === 'number' && Number.isFinite(parsed.loopStartMs)) {
      out.loopStartMs = parsed.loopStartMs
    }
    if (typeof parsed.loopEndMs === 'number' && Number.isFinite(parsed.loopEndMs)) {
      out.loopEndMs = parsed.loopEndMs
    }
    if (typeof parsed.durationMs === 'number' && Number.isFinite(parsed.durationMs)) {
      out.durationMs = parsed.durationMs
    }
    return Object.keys(out).length > 0 ? out : null
  } catch {
    return null
  }
}

function inferLocalSeMetadata(relFile: string, stem: string): CatalogSeItem {
  const lowerStem = stem.toLowerCase()
  const curated = CURATED_SCENARIO_SES.find((c) => c.id.toLowerCase() === lowerStem)
  const sem = lookupSeSemantic(stem)
  if (curated) {
    const tags = [...new Set([...curated.tags, ...(sem?.tags ?? [])])]
    return {
      file: relFile,
      id: curated.id,
      name: curated.id,
      category: curated.category,
      description: curated.description,
      tags
    }
  }
  if (sem) {
    return {
      file: relFile,
      id: sem.id || stem,
      name: sem.id || stem,
      category: sem.category || 'se',
      description: sem.description || `本地音效（${stem}）`,
      tags: sem.tags?.length ? [...sem.tags] : [stem]
    }
  }
  if (/^se_run_/i.test(lowerStem)) {
    return {
      file: relFile,
      id: stem,
      name: stem,
      category: 'running',
      description: '匆忙奔跑脚步声',
      tags: ['run', 'footsteps', stem]
    }
  }
  if (/^se_walk_/i.test(lowerStem)) {
    return {
      file: relFile,
      id: stem,
      name: stem,
      category: 'footsteps',
      description: '走动脚步声',
      tags: ['walk', 'footsteps', stem]
    }
  }
  if (/thorns|mood|ambient|env/i.test(lowerStem)) {
    return {
      file: relFile,
      id: stem,
      name: stem,
      category: 'mood',
      description: '剧情氛围环境音效',
      tags: ['mood', 'ambient', stem]
    }
  }
  return {
    file: relFile,
    id: stem,
    name: stem,
    category: 'se',
    description: `本地音效（${stem}）`,
    tags: [stem]
  }
}

export interface SeCatalogViewLike {
  readonly seDetails: ReadonlyArray<{
    file: string
    id?: string
    category?: string
    tags?: string[]
  }>
  readonly cloudOnly?: boolean
  canonicalSe?: (value: unknown) => string | null
}

function findRegisteredSeByStem(
  registered: SeCatalogViewLike['seDetails'],
  stemPriority: string[]
): string | null {
  for (const wanted of stemPriority) {
    const wLower = wanted.toLowerCase()
    const hit = registered.find(
      (entry) =>
        (entry.id ?? '').toLowerCase() === wLower ||
        fileStem(entry.file).toLowerCase() === wLower
    )
    if (hit) return hit.file
  }
  return null
}

/**
 * 把任意 SE 引用（文件名 / cue id / 描述词）解析并落盘到当前目录真实已登记的 SE 路径；
 * 当 `cloudCatalog: false`（`seDetails` 仅含本地实存 SE）且目标 SE 缺席时，按语义类别确定性
 * 重映射到同类的实存本地 SE，避免导出阶段报 missing file / 静音。
 */
export function resolveRegisteredSeFile(
  view: SeCatalogViewLike,
  rawValue: unknown
): { file: string; remapped: boolean } | null {
  const raw = String(rawValue ?? '')
    .replace(/\\/g, '/')
    .replace(/^resources\//i, '')
    .replace(/^audio\/se\//i, '')
    .trim()
  if (!raw) return null

  const canonical = view.canonicalSe?.(raw) ?? resolveScenarioSe(raw)?.file ?? raw
  const registered = view.seDetails ?? []
  if (registered.length === 0) {
    if (view.cloudOnly) {
      if (raw.toLowerCase().startsWith('cloud/')) {
        return { file: raw, remapped: false }
      }
      const known = view.canonicalSe?.(raw) ?? resolveScenarioSe(raw)?.file
      if (!known) return null
      const prefixed = known.toLowerCase().startsWith('cloud/')
        ? known
        : `cloud/${known.replace(/^\/+/, '')}`
      return { file: prefixed, remapped: false }
    }
    return canonical ? { file: canonical, remapped: false } : null
  }

  const candidates = [canonical, raw].filter(Boolean)
  for (const cand of candidates) {
    const lower = cand.toLowerCase()
    const stem = fileStem(lower).toLowerCase()
    const exact = registered.find(
      (entry) =>
        entry.file.toLowerCase() === lower ||
        (entry.id ?? '').toLowerCase() === lower ||
        (entry.id ?? '').toLowerCase() === stem ||
        fileStem(entry.file).toLowerCase() === stem
    )
    if (exact) {
      return { file: exact.file, remapped: false }
    }
  }

  const cue = resolveScenarioSe(raw) ?? (canonical ? resolveScenarioSe(canonical) : null)
  const hint = `${raw} ${canonical ?? ''} ${cue?.category ?? ''} ${(cue?.tags ?? []).join(' ')} ${cue?.description ?? ''}`.toLowerCase()

  let priority: string[]
  if (/running|\brun\b|se_run_|奔跑|急跑|冲进|hurry|rush/.test(hint)) {
    priority = /men|男/.test(hint)
      ? [
          'se_run_men_001_1',
          'se_run_men_001_2',
          'se_run_men_002_1',
          'se_run_women_001_1',
          'se_run_women_002_1',
          'se_walk_women_001_1'
        ]
      : [
          'se_run_women_001_1',
          'se_run_women_002_1',
          'se_run_women_002_2',
          'se_walk_women_001_1',
          'se_run_men_001_1'
        ]
  } else if (/footsteps|\bwalk\b|se_walk_|脚步|走近|走远/.test(hint)) {
    priority = /men|男/.test(hint)
      ? [
          'se_run_men_001_1',
          'se_walk_women_001_1',
          'se_walk_women_002_1',
          'se_run_women_001_1',
          'se_run_women_002_1'
        ]
      : [
          'se_walk_women_001_1',
          'se_walk_women_002_1',
          'se_run_women_001_1',
          'se_run_women_002_1'
        ]
  } else if (/\bdoor\b|门|敲门|推门/.test(hint)) {
    priority = ['se00055_b', 'se_walk_women_001_1', 'se00097', 'se00053_b']
  } else if (
    /shock|startle|surprise|reaction|flashback|transition|sekai|\bhit\b|gasp|crowd|stage|se00053|se00028|se00092|se00034|se00019/.test(
      hint
    )
  ) {
    priority = ['se00053_b', 'se00028_b', 'se00092_b', 'se00097', 'se00055_b']
  } else if (/paper|pc|keyboard|music_edit|instrument|se00122|se00007|se00320|se00027/.test(hint)) {
    priority = ['se00122_b', 'se00007_b', 'se00055_b', 'se00097']
  } else if (
    /bell|chime|phone|camera|cloth|drink|weather|rain|wind|pause|mood|se00037|se00097|se00055|se00004|se00249|se00075|se00005|se00084|se00098|se00183/.test(
      hint
    )
  ) {
    priority = ['se00097', 'se00055_b', 'se00028_b', 'se00053_b']
  } else {
    priority = ['se00097', 'se00055_b', 'se00028_b', 'se00053_b']
  }

  const matched = findRegisteredSeByStem(registered, priority) ?? registered[0]?.file ?? null
  return matched ? { file: matched, remapped: true } : null
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
  private cacheCloudGeneratedAt: string | null = null

  constructor(
    logger: Logger<ILogObj>,
    config: HostConfig,
    cloud: (() => CloudCatalogData | null) | null = null
  ) {
    this.logger = logger
    this.config = config
    this.cloud = cloud
  }

  invalidate(): void {
    this.cache = null
    this.cacheTime = 0
    this.cacheCloudGeneratedAt = null
  }

  get(): ResourceCatalogData {
    const now = Date.now()
    const cloudGeneratedAt = this.cloud?.()?.generatedAt ?? null
    if (
      this.cache &&
      now - this.cacheTime < CACHE_TTL_MS &&
      this.cacheCloudGeneratedAt === cloudGeneratedAt
    ) {
      return this.cache
    }

    try {
      const data = this.build()
      this.cache = data
      this.cacheTime = now
      this.cacheCloudGeneratedAt = data.cloud?.generatedAt ?? cloudGeneratedAt
      return data
    } catch (err) {
      this.logger.error('[Catalog] Failed to build resource catalog', err)
      if (this.cache) {
        return this.cache
      }
      return { models: [], images: [], imageDetails: [], voices: [], bgm: [], bgmDetails: [] }
    }
  }

  /** 按角色名、简称、cloudId 或数字 id 精确/模糊查找目录模型（默认服装优先）。 */
  findModel(query: string | number): CatalogModel | null {
    const data = this.get()
    if (typeof query === 'number' && Number.isFinite(query)) {
      return data.models.find((m) => m.id === query) ?? null
    }
    const q = String(query ?? '').trim().toLowerCase()
    if (!q) return null
    const exact = data.models.find(
      (m) =>
        String(m.id) === q ||
        (m.cloudId ?? '').toLowerCase() === q ||
        m.path.toLowerCase() === q
    )
    if (exact) return exact

    const byName = data.models
      .filter(
        (m) =>
          m.name.toLowerCase() === q ||
          (m.shortName ?? '').toLowerCase() === q ||
          `${m.name} ${m.outfitLabel ?? ''}`.trim().toLowerCase() === q ||
          `${m.shortName ?? m.name} ${m.outfitCategory ?? ''}`.trim().toLowerCase() === q
      )
      .sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)) || a.id - b.id)
    if (byName.length > 0) return byName[0]

    const fuzzy = data.models
      .filter((m) =>
        `${m.id} ${m.cloudId ?? ''} ${m.name} ${m.shortName ?? ''} ${m.outfitLabel ?? ''}`
          .toLowerCase()
          .includes(q)
      )
      .sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)) || a.id - b.id)
    return fuzzy[0] ?? null
  }

  /** 按 id / 文件名 / 中文名 / 别名 / 标签检索背景。 */
  findBackground(query: string): CatalogImage | null {
    const q = query.trim().toLowerCase()
    if (!q) return null
    const details = this.get().imageDetails
    return (
      details.find(
        (d) =>
          d.id?.toLowerCase() === q ||
          d.file.toLowerCase() === q ||
          fileStem(d.file).toLowerCase() === q ||
          d.name.toLowerCase() === q
      ) ??
      details.find(
        (d) =>
          (d.aliases ?? []).some((a) => a.toLowerCase() === q) ||
          d.name.toLowerCase().includes(q) ||
          (d.tags ?? []).some((t) => t.toLowerCase() === q)
      ) ??
      null
    )
  }

  /** 按 id / 文件名 / 曲名检索 BGM。 */
  findBgm(query: string): CatalogBgm | null {
    const q = query.trim().toLowerCase()
    if (!q) return null
    const details = this.get().bgmDetails
    return (
      details.find(
        (d) =>
          d.id?.toLowerCase() === q ||
          d.file.toLowerCase() === q ||
          fileStem(d.file).toLowerCase() === q ||
          d.name.toLowerCase() === q
      ) ??
      details.find((d) => d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q)) ??
      null
    )
  }

  /** 按 cue id / 文件名 / 语义描述检索 SE。 */
  findSe(query: string): CatalogSeItem | null {
    const q = query.trim().toLowerCase()
    if (!q) return null
    const stemQ = q.replace(/^cloud\//, '').replace(/\.(mp3|wav|ogg|flac|hca)$/i, '')
    const baseStemQ = stemQ.replace(/(?:_b)?_\d+$/, '')
    const details = this.get().seDetails ?? []
    return (
      details.find((d) => d.id?.toLowerCase() === stemQ || d.file.toLowerCase() === q) ??
      details.find((d) => d.id?.toLowerCase() === stemQ.replace(/_b$/, '') || d.id?.toLowerCase() === baseStemQ) ??
      details.find(
        (d) =>
          d.description.toLowerCase().includes(q) ||
          (d.tags ?? []).some((t) => t.toLowerCase() === stemQ || t.toLowerCase().includes(q))
      ) ??
      null
    )
  }

  /** 统一检索当前全量目录中的模型、背景、BGM 与 SE。 */
  searchAssets(options: {
    kind?: 'model' | 'background' | 'bgm' | 'se' | 'all'
    query?: string
    limit?: number
  } = {}): {
    models?: CatalogModel[]
    backgrounds?: CatalogImage[]
    bgm?: CatalogBgm[]
    se?: CatalogSeItem[]
  } {
    const kind = options.kind ?? 'all'
    const q = (options.query ?? '').trim().toLowerCase()
    const limit = Math.max(1, Math.min(100, Math.round(options.limit ?? 20)))
    const data = this.get()
    const tokens = q.split(/[\s,，/]+/).filter(Boolean)
    const matches = (haystack: string): boolean => {
      if (tokens.length === 0) return true
      const lower = haystack.toLowerCase()
      return tokens.every((tok) => lower.includes(tok))
    }

    const out: {
      models?: CatalogModel[]
      backgrounds?: CatalogImage[]
      bgm?: CatalogBgm[]
      se?: CatalogSeItem[]
    } = {}
    if (kind === 'model' || kind === 'all') {
      out.models = data.models
        .filter((m) =>
          matches(`${m.cloudId ?? ''} ${m.name} ${m.shortName ?? ''} ${m.unit ?? ''} ${m.outfitCategory ?? ''} ${m.outfitLabel ?? ''}`)
        )
        .slice(0, limit)
    }
    if (kind === 'background' || kind === 'all') {
      out.backgrounds = data.imageDetails
        .filter((b) =>
          matches(`${b.id ?? ''} ${b.name} ${(b.aliases ?? []).join(' ')} ${b.category ?? ''} ${b.timeOfDay ?? ''} ${b.indoor ?? ''} ${(b.tags ?? []).join(' ')}`)
        )
        .slice(0, limit)
    }
    if (kind === 'bgm' || kind === 'all') {
      out.bgm = data.bgmDetails
        .filter((b) =>
          matches(`${b.id ?? ''} ${b.name} ${b.mood ?? ''} ${b.category ?? ''} ${b.unit ?? ''} ${b.description} ${(b.tags ?? []).join(' ')}`)
        )
        .slice(0, limit)
    }
    if (kind === 'se' || kind === 'all') {
      out.se = (data.seDetails ?? [])
        .filter((s) =>
          matches(`${s.id ?? ''} ${s.name} ${s.category ?? ''} ${s.description} ${(s.tags ?? []).join(' ')}`)
        )
        .slice(0, limit)
    }
    return out
  }

  private build(): ResourceCatalogData {
    const resourcesDir = this.config.paths.resources
    const cloudOnly = Boolean(this.config.assets?.cloudOnly)
    const modelsDir = path.join(resourcesDir, 'models')
    const manifestPath = path.join(modelsDir, 'models.yaml')

    const models: CatalogModel[] = []
    if (!cloudOnly) {
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

    const imageFiles = cloudOnly ? [] : listFiles('images', IMAGE_EXTENSIONS)
    const imageDetails = cloudOnly ? [] : this.loadImageDetails(resourcesDir, imageFiles)
    const bgmFiles = cloudOnly
      ? []
      : this.listAudioFilesRecursive(resourcesDir, path.join('audio', 'bgm'))
    const bgmDetails = cloudOnly ? [] : this.loadBgmDetails(resourcesDir, bgmFiles)
    const localSeFiles = cloudOnly ? [] : this.listSeFiles(resourcesDir)

    const cloud = this.cloud?.() ?? null
    const seDetails: CatalogSeItem[] = []
    const seByStem = new Map<string, CatalogSeItem>()
    const seFilesSeen = new Set<string>()
    for (const relFile of localSeFiles) {
      const stem = fileStem(relFile)
      const item = inferLocalSeMetadata(relFile, stem)
      seDetails.push(item)
      seByStem.set(stem.toLowerCase(), item)
      seFilesSeen.add(relFile.toLowerCase())
    }
    if (cloud) {
      this.mergeCloudModels(models, cloud)
      this.mergeCloudBackgrounds(imageFiles, imageDetails, cloud)
      this.mergeCloudBgm(bgmFiles, bgmDetails, cloud)
      for (const entry of cloud.se ?? []) {
        const entryFile =
          cloudOnly && !entry.file.toLowerCase().startsWith('cloud/')
            ? `cloud/${entry.file.replace(/^\/+/, '')}`
            : entry.file
        const stemKey = (entry.id || fileStem(entryFile)).toLowerCase()
        const localItem = seByStem.get(stemKey)
        if (localItem) {
          if (entry.description && (!localItem.description || localItem.description.startsWith('本地音效（'))) {
            localItem.description = entry.description
          }
          if (entry.category && (!localItem.category || localItem.category === 'se')) {
            localItem.category = entry.category
          }
          if (entry.tags?.length && (!localItem.tags || localItem.tags.length <= 1)) {
            localItem.tags = entry.tags
          }
          continue
        }
        const fileKey = entryFile.toLowerCase()
        if (seFilesSeen.has(fileKey)) continue
        seFilesSeen.add(fileKey)
        seDetails.push({
          file: entryFile,
          id: entry.id,
          name: entry.name,
          category: entry.category,
          description: entry.description,
          tags: entry.tags
        })
      }
      if (cloudOnly && seDetails.length === 0) {
        for (const cue of CURATED_SCENARIO_SES) {
          const entryFile = cue.file.toLowerCase().startsWith('cloud/')
            ? cue.file
            : `cloud/${cue.file.replace(/^\/+/, '')}`
          seDetails.push({
            file: entryFile,
            id: cue.id,
            name: cue.id,
            category: cue.category,
            description: cue.description,
            tags: [...cue.tags]
          })
        }
      }
    }

    return {
      models,
      images: imageFiles,
      imageDetails,
      voices: cloudOnly ? [] : listFiles('voices', AUDIO_EXTENSIONS),
      bgm: bgmFiles,
      bgmDetails,
      ...(cloudOnly ? { cloudOnly: true } : {}),
      ...(seDetails.length > 0 ? { seDetails } : {}),
      ...(cloud
        ? {
            cloud: {
              generatedAt: cloud.generatedAt,
              models: cloud.models.length,
              backgrounds: cloud.backgrounds.length,
              bgm: cloud.bgm.length,
              se: cloud.se?.length ?? 0
            }
          }
        : {})
    }
  }

  /**
   * 云端模型补进目录：
   * - 本地 models.yaml 已登记的角色只占该角色的默认首选位（用户自定义本地模型优先），
   *   绝不压制同一角色的其它云端换装变体，也不压制缺失的虚拟歌手/其他角色/配角；
   * - 若本地模型路径本身就是某套服装 id（例如 01ichika_normal/...），仅去重该套服装本身；
   * - 首选默认服装用 1000+characterId，换装变体与配角用 >=2000 确定性递增 id。
   */
  private mergeCloudModels(models: CatalogModel[], cloud: CloudCatalogData): void {
    const localDefaultNames = new Set(models.map((model) => model.name.toLowerCase()))
    const localPaths = new Set(models.map((model) => model.path.toLowerCase()))
    const localModelRoots = new Set(
      models.map((model) => model.path.replace(/\\/g, '/').split('/')[0]?.toLowerCase() ?? '')
    )
    const usedIds = new Set(models.map((model) => model.id))
    const usedCloudIds = new Set<string>()
    let nextAltId = 2000

    for (const entry of cloud.models) {
      const cloudIdLower = entry.id.toLowerCase()
      if (usedCloudIds.has(cloudIdLower)) continue
      if (localPaths.has(entry.path.toLowerCase()) || localModelRoots.has(cloudIdLower)) continue
      if (entry.isDefault !== false && localDefaultNames.has(entry.name.toLowerCase())) continue

      let numericId: number
      const preferredId = entry.characterId ? 1000 + entry.characterId : -1
      if (entry.isDefault !== false && preferredId > 0 && !usedIds.has(preferredId)) {
        numericId = preferredId
      } else {
        while (usedIds.has(nextAltId)) nextAltId++
        numericId = nextAltId++
      }

      let motions = entry.motions
      let facials = entry.facials
      let defaultMotion = entry.defaultMotion
      let defaultFacial = entry.defaultFacial

      // 已物化到磁盘的云端模型：以本地真实 .model3.json + motions/ 为准，
      // 防止目录报告了尚未补齐/转换的动作导致渲染端报 motion not found。
      const localModelJsonPath = path.join(
        this.config.paths.resources,
        'models',
        ...entry.path.split('/')
      )
      if (fs.existsSync(localModelJsonPath)) {
        try {
          const names = this.readMotionNames(localModelJsonPath)
          if (names.length > 0) {
            motions = names.filter((n) => !n.startsWith('face_')).sort()
            facials = names.filter((n) => n.startsWith('face_')).sort()
            defaultMotion = pickPreferred(motions, DEFAULT_MOTION_PREFERENCE)
            defaultFacial = pickPreferred(facials, DEFAULT_FACIAL_PREFERENCE)
          }
        } catch (err) {
          this.logger.warn(
            `[Catalog] Failed to read cached cloud model3.json for ${entry.path}`,
            err
          )
        }
      }

      usedIds.add(numericId)
      usedCloudIds.add(cloudIdLower)
      models.push({
        id: numericId,
        name: entry.name,
        shortName: entry.shortName,
        path: entry.path,
        motions,
        facials,
        defaultMotion,
        defaultFacial,
        source: 'cloud',
        cloudId: entry.id,
        characterId: entry.characterId ?? null,
        ...(entry.unit ? { unit: entry.unit } : {}),
        ...(entry.outfitCategory ? { outfitCategory: entry.outfitCategory } : {}),
        ...(entry.outfitLabel ? { outfitLabel: entry.outfitLabel } : {}),
        isDefault: entry.isDefault !== false,
        ...(entry.isSubCharacter ? { isSubCharacter: true } : {})
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
    for (const entry of cloud.backgrounds) {
      const localFile = localByStem.get(entry.id.toLowerCase())
      if (localFile) {
        // 本地已有同一背景（常见于 fetch:media 下载的 bg_xxx.webp）：
        // 不新增 cloud/ 副本，而是把官方地点名与语义标签贴到本地条目上。
        const detail = detailsByFile.get(localFile.toLowerCase())
        if (detail) {
          if (!detail.name || detail.name === detail.file) detail.name = entry.name
          if (!detail.id) detail.id = entry.id
          if (!detail.aliases?.length) detail.aliases = entry.aliases
          if (!detail.description) detail.description = entry.description
          if (!detail.category && entry.category) detail.category = entry.category
          if (!detail.timeOfDay && entry.timeOfDay) detail.timeOfDay = entry.timeOfDay
          if (!detail.indoor && entry.indoor) detail.indoor = entry.indoor
          if (!detail.tags?.length && entry.tags?.length) detail.tags = entry.tags
        } else {
          const created: CatalogImage = {
            file: localFile,
            name: entry.name,
            description: entry.description,
            id: entry.id,
            aliases: entry.aliases,
            ...(entry.category ? { category: entry.category } : {}),
            ...(entry.timeOfDay ? { timeOfDay: entry.timeOfDay } : {}),
            ...(entry.indoor ? { indoor: entry.indoor } : {}),
            ...(entry.tags?.length ? { tags: entry.tags } : {}),
            source: 'cloud'
          }
          imageDetails.push(created)
          detailsByFile.set(localFile.toLowerCase(), created)
        }
        continue
      }

      // 全量保留所有云端背景（含多时段变体与未命名条目），仅按 file 去重，绝不因重名丢弃。
      const fileKey = entry.file.toLowerCase()
      if (files.has(fileKey)) continue
      files.add(fileKey)
      imageFiles.push(entry.file)
      const created: CatalogImage = {
        file: entry.file,
        name: entry.name,
        description: entry.description,
        id: entry.id,
        aliases: entry.aliases,
        ...(entry.category ? { category: entry.category } : {}),
        ...(entry.timeOfDay ? { timeOfDay: entry.timeOfDay } : {}),
        ...(entry.indoor ? { indoor: entry.indoor } : {}),
        ...(entry.tags?.length ? { tags: entry.tags } : {}),
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
    for (const entry of cloud.bgm) {
      const localFile = localByStem.get(entry.id.toLowerCase())
      if (localFile) {
        // 本地已有同一首曲子：只补曲名/分类/语义标签，不新增 cloud/ 副本。
        const detail = detailsByFile.get(localFile.toLowerCase())
        if (detail) {
          if (!detail.name || detail.name === detail.file) detail.name = entry.name
          if (!detail.id) detail.id = entry.id
          if (!detail.description) detail.description = entry.description
          if (!detail.mood && entry.mood) detail.mood = entry.mood
          if (!detail.tempo && entry.tempo) detail.tempo = entry.tempo
          if (!detail.category && entry.category) detail.category = entry.category
          if (!detail.unit && entry.unit) detail.unit = entry.unit
          if (!detail.tags?.length && entry.tags?.length) detail.tags = entry.tags
        } else {
          const created: CatalogBgm = {
            file: localFile,
            name: entry.name,
            description: entry.description,
            id: entry.id,
            ...(entry.mood ? { mood: entry.mood } : {}),
            ...(entry.tempo ? { tempo: entry.tempo } : {}),
            ...(entry.category ? { category: entry.category } : {}),
            ...(entry.unit ? { unit: entry.unit } : {}),
            ...(entry.tags?.length ? { tags: entry.tags } : {}),
            source: 'cloud'
          }
          bgmDetails.push(created)
          detailsByFile.set(localFile.toLowerCase(), created)
        }
        continue
      }

      // 全量纳入云端剧情 BGM + 区域 BGM，不设 80 首截断，也不因未入 soundtracks.json 或重名丢弃。
      const fileKey = entry.file.toLowerCase()
      if (files.has(fileKey)) continue
      files.add(fileKey)
      bgmFiles.push(entry.file)
      const created: CatalogBgm = {
        file: entry.file,
        name: entry.name,
        description: entry.description,
        id: entry.id,
        ...(entry.mood ? { mood: entry.mood } : {}),
        ...(entry.tempo ? { tempo: entry.tempo } : {}),
        ...(entry.category ? { category: entry.category } : {}),
        ...(entry.unit ? { unit: entry.unit } : {}),
        ...(entry.tags?.length ? { tags: entry.tags } : {}),
        source: 'cloud'
      }
      bgmDetails.push(created)
      detailsByFile.set(entry.file.toLowerCase(), created)
    }
  }

  /** 递归扫描本地音频目录（根目录优先，其次 `cloud/` 等子目录），按 stem 去重。 */
  private listAudioFilesRecursive(resourcesDir: string, relRoot: string): string[] {
    const baseDir = path.join(resourcesDir, relRoot)
    if (!fs.existsSync(baseDir)) {
      return []
    }
    const rootFiles: string[] = []
    const nestedFiles: string[] = []
    const walk = (dir: string, prefix: string): void => {
      const entries = fs.readdirSync(dir).sort()
      for (const name of entries) {
        const full = path.join(dir, name)
        let stat: fs.Stats
        try {
          stat = fs.statSync(full)
        } catch {
          continue
        }
        if (stat.isDirectory()) {
          walk(full, prefix ? `${prefix}/${name}` : name)
        } else if (stat.isFile() && AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase())) {
          const rel = prefix ? `${prefix}/${name}` : name
          if (prefix) nestedFiles.push(rel)
          else rootFiles.push(rel)
        }
      }
    }
    walk(baseDir, '')

    const out: string[] = []
    const seenStems = new Set<string>()
    for (const rel of [...rootFiles, ...nestedFiles]) {
      const stem = fileStem(rel).toLowerCase()
      if (seenStems.has(stem)) continue
      seenStems.add(stem)
      out.push(rel)
    }
    return out
  }

  /** 扫描本地 `audio/se/` 与 `audio/se/cloud/`（含子目录），同名 stem 优先根目录文件。 */
  private listSeFiles(resourcesDir: string): string[] {
    return this.listAudioFilesRecursive(resourcesDir, path.join('audio', 'se'))
  }

  /**
   * 读取 BGM 清单（audio/bgm/bgm.yaml），并自动补全磁盘上其余带官方语义或循环元数据
   * 的曲目（例如 `audio/bgm/cloud/*.mp3`），使 `cloudCatalog: false` 时也能使用完整曲库。
   *
   * 人工在 bgm.yaml 显式登记的条目保持原有字段与优先级不变；未登记但有 `bgm-semantics.json`、
   * `soundtracks.json`、`.loop.json` 或位于子目录的真实磁盘曲目会自动语义丰富化并纳入 `bgmDetails`。
   */
  private loadBgmDetails(resourcesDir: string, bgmFiles: string[]): CatalogBgm[] {
    const manifestPath = path.join(resourcesDir, 'audio', 'bgm', 'bgm.yaml')
    const soundtracks = this.loadSoundtracks(resourcesDir)
    const known = new Set(bgmFiles)
    const details: CatalogBgm[] = []
    const listedFiles = new Set<string>()

    if (fs.existsSync(manifestPath)) {
      let manifest: BgmManifest | null | undefined
      try {
        manifest = yaml.load(fs.readFileSync(manifestPath, 'utf-8')) as
          | BgmManifest
          | null
          | undefined
      } catch (err) {
        this.logger.warn('[Catalog] Failed to parse audio/bgm/bgm.yaml', err)
        manifest = null
      }
      if (manifest && typeof manifest === 'object' && Array.isArray(manifest.bgm)) {
        for (const entry of manifest.bgm) {
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
          const loopMeta = readLoopSidecar(
            path.join(resourcesDir, 'audio', 'bgm', ...file.split('/'))
          )

          details.push({
            file,
            name: nameIsPlaceholder ? label?.name || file : rawName,
            description: rawDescription || label?.description || '',
            ...(loopMeta ?? {})
          })
          listedFiles.add(file.toLowerCase())
        }
      }
    }

    for (const file of bgmFiles) {
      if (listedFiles.has(file.toLowerCase())) continue
      const stem = fileStem(file)
      const sem = lookupBgmSemantic(stem)
      const soundtrack = soundtracks?.tracks.get(soundtrackKey(file))
      const label = soundtrack ? soundtrackLabel(soundtrack) : null
      const loopMeta = readLoopSidecar(path.join(resourcesDir, 'audio', 'bgm', ...file.split('/')))
      const isNested = file.includes('/')
      if (!sem && !label && !loopMeta && !isNested) continue

      const name =
        label?.name && label.name !== stem ? label.name : sem?.name || label?.name || stem
      const baseDesc = sem?.description || label?.description || (isNested ? `本地配乐（${stem}）` : '')
      const hasCat =
        label?.description &&
        baseDesc &&
        !baseDesc.includes(label.description.replace(/\s*BGM$/, ''))
      const description =
        hasCat && label?.description ? `${baseDesc}（${label.description}）` : baseDesc

      details.push({
        file,
        name,
        description,
        id: stem,
        ...(sem?.mood ? { mood: sem.mood } : {}),
        ...(sem?.tempo ? { tempo: sem.tempo } : {}),
        ...(sem?.category ? { category: sem.category } : {}),
        ...(sem?.unit ? { unit: sem.unit } : {}),
        ...(sem?.tags?.length ? { tags: [...sem.tags] } : {}),
        source: 'local',
        ...(loopMeta ?? {})
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

    const modelDir = path.dirname(modelJsonPath)
    return Object.keys(indexed).filter((key) => {
      const fileRel = Array.isArray(indexed[key]) ? indexed[key][0]?.File : undefined
      return Boolean(fileRel && fs.existsSync(path.join(modelDir, ...fileRel.split('/'))))
    })
  }

  private loadImageDetails(resourcesDir: string, imageFiles: string[]): CatalogImage[] {
    const manifestPath = path.join(resourcesDir, 'images', 'images.yaml')
    if (!fs.existsSync(manifestPath)) {
      return []
    }

    let manifest: ImageManifest | null | undefined
    try {
      manifest = yaml.load(fs.readFileSync(manifestPath, 'utf-8')) as
        | ImageManifest
        | null
        | undefined
    } catch (err) {
      this.logger.warn('[Catalog] Failed to parse images.yaml', err)
      return []
    }
    if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.images)) {
      return []
    }

    const known = new Set(imageFiles)
    const details: CatalogImage[] = []
    for (const entry of manifest.images) {
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
