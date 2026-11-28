/**
 * 云端资源物化：把故事里的云端引用（背景名/ID、BGM 名/ID、云端模型 id）
 * 解析成资源根下的真实文件，并把故事路径改写为渲染端可直接加载的相对路径。
 *
 * 按需加载设计目标：
 * - 目录（名字、ID、远端位置）来自云端，不需要本地 YAML 登记；
 * - 第一次导出时才下载真正用到的文件，之后命中 `cloud/` 缓存直接复用；
 * - 全部写入资源根的 `cloud/` 子目录，仍然走同一个 `/resources` 静态路由，
 *   渲染端不需要知道资源来自云端。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ILogObj, Logger } from 'tslog'
import { DEFAULT_CLOUD_BGM_ID, DEFAULT_LOCAL_BGM_PATH, type AssetsSettings } from '../config'
import type { StoryData } from '../../common/types/Story'
import {
  atomicWrite,
  fetchBuffer,
  isLikelyOriginFailure,
  markCanonicalOriginFailed,
  markCanonicalOriginHealthy,
  orderCanonicalOrigins
} from './http'
import { mapPool, MOTION_BUNDLES_SIDECAR } from './shared'
import type {
  CloudBackgroundEntry,
  CloudBgmEntry,
  CloudCatalogData,
  CloudModelEntry,
  CloudSeEntry
} from './cloudCatalog'
import {
  downloadMediaFile,
  downloadSeFile,
  extractAudioLoopMetadata,
  transcodeAudioFile,
  writeAudioLoopSidecar
} from './media'
import {
  CANONICAL_ASSET_SITES,
  downloadModel,
  live2dMotionSetCandidateNames,
  type MoesekaiIndexEntry
} from './moesekai'
import { CHARACTERS } from './names'

const IMAGE_EXTENSIONS = ['.webp', '.png', '.jpg', '.jpeg']
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.flac']

export interface CloudAssetContext {
  settings: AssetsSettings
  resourcesDir: string
  catalog: CloudCatalogData | null
  logger: Logger<ILogObj>
  onProgress?: (message: string) => void
  /** 严格纯云端模式：不命中或复用任何非 `cloud/` 路径的旧本地资源 */
  cloudOnly?: boolean
}

export interface CloudAssetResolution {
  models: number
  images: number
  bgm: number
  se: number
  missing: string[]
}

const modelLocks = new Map<string, Promise<string>>()
const backgroundLocks = new Map<string, Promise<string>>()
const bgmLocks = new Map<string, Promise<string>>()
const seLocks = new Map<string, Promise<string | null>>()
const inappFileLocks = new Map<string, Promise<boolean>>()

function withSingleFlight<T>(
  locks: Map<string, Promise<T>>,
  key: string,
  factory: () => Promise<T>
): Promise<T> {
  const existing = locks.get(key)
  if (existing) return existing
  const task = factory().finally(() => {
    if (locks.get(key) === task) {
      locks.delete(key)
    }
  })
  locks.set(key, task)
  return task
}

function stripResourcePrefix(
  value: unknown,
  kindPrefix?: 'models' | 'images' | 'audio/bgm' | 'audio/se'
): string {
  let out = String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^resources\//i, '')
  if (kindPrefix) {
    out = out.replace(new RegExp(`^${kindPrefix}/`, 'i'), '')
  }
  return out
}

function isCloudSubdirRef(
  value: unknown,
  kindPrefix?: 'models' | 'images' | 'audio/bgm' | 'audio/se'
): boolean {
  return stripResourcePrefix(value, kindPrefix).toLowerCase().startsWith('cloud/')
}

function normalizeRef(value: unknown): string {
  return stripResourcePrefix(value)
    .replace(/^images\//i, '')
    .replace(/^models\//i, '')
    .replace(/^audio\/(bgm|se)\//i, '')
}

function stem(value: string): string {
  return path.basename(value).replace(/\.[^.]+$/, '')
}

function keysOf(values: Array<string | undefined>): string[] {
  return values
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .map((value) => value.trim().toLowerCase())
}

function existsWithExtensions(dir: string, base: string, extensions: string[]): string | null {
  for (const extension of extensions) {
    const candidate = path.join(dir, `${base}${extension}`)
    if (isNonEmptyFile(candidate)) return candidate
  }
  return null
}

function extractTimeHint(text: string): string | null {
  if (/深夜|25点|凌晨|半夜/.test(text)) return '深夜'
  if (/黄昏|傍晚|夕阳|放学/.test(text)) return '黄昏'
  if (/夜晚|夜间|晚上|夜景|\bnight\b/i.test(text)) return '夜晚'
  if (/白天|清晨|上午|中午|午休|早上|\bday\b/i.test(text)) return '白天'
  return null
}

function stripTimeHint(text: string): string {
  return text
    .replace(/[·\s（(【[]*(白天|黄昏|傍晚|夜晚|夜间|深夜|通用|室内|室外)[）)】\]]*$/g, '')
    .trim()
}

function timeRank(entryTime: string | undefined, hint: string | null): number {
  if (hint) {
    if (entryTime === hint) return 0
    if (hint === '夜晚' && entryTime === '深夜') return 1
    if (hint === '深夜' && entryTime === '夜晚') return 1
    if (entryTime === '通用') return 2
    return 3
  }
  if (!entryTime || entryTime === '白天') return 0
  if (entryTime === '通用') return 1
  if (entryTime === '黄昏') return 2
  return 3
}

/** 背景：支持 id（bg_a000301）、文件名、cloud/ 路径、可读名、别名与时段限定变体。 */
export function findCloudBackground(
  catalog: CloudCatalogData | null,
  value: unknown
): CloudBackgroundEntry | null {
  if (!catalog) return null
  const raw = normalizeRef(value)
  if (!raw) return null
  const lower = raw.toLowerCase()
  const lowerStem = stem(lower).toLowerCase()

  // 1. 精确 id / 文件名 / stem 命中
  const byId = catalog.backgrounds.find(
    (entry) =>
      keysOf([entry.id, entry.file, stem(entry.file)]).includes(lower) ||
      keysOf([entry.id, stem(entry.file)]).includes(lowerStem)
  )
  if (byId) return byId

  // 2. 可读名 + 可选时段消歧（例如「神山高校 天台·黄昏」/「神山高校 天台（夜晚）」）
  const timeHint = extractTimeHint(raw)
  const baseQuery = stripTimeHint(raw).toLowerCase()
  const exactNameMatches = catalog.backgrounds.filter((entry) => {
    const names = keysOf([
      entry.name,
      entry.timeOfDay ? `${entry.name}·${entry.timeOfDay}` : undefined,
      entry.timeOfDay ? `${entry.name}（${entry.timeOfDay}）` : undefined,
      entry.timeOfDay ? `${entry.name} ${entry.timeOfDay}` : undefined,
      ...entry.aliases
    ])
    return (
      names.includes(lower) ||
      (Boolean(baseQuery) && keysOf([entry.name, ...entry.aliases]).includes(baseQuery))
    )
  })
  if (exactNameMatches.length > 0) {
    return exactNameMatches.sort(
      (a, b) =>
        timeRank(a.timeOfDay, timeHint) - timeRank(b.timeOfDay, timeHint) ||
        a.id.localeCompare(b.id)
    )[0]
  }

  // 3. 子串 / 标签模糊命中，优先匹配时段、名称更短更贴切的条目
  const fuzzyTarget = baseQuery || lower
  const byFuzzy = catalog.backgrounds
    .filter((entry) =>
      keysOf([entry.name, ...entry.aliases, ...(entry.tags ?? [])]).some(
        (key) => key.includes(fuzzyTarget) || fuzzyTarget.includes(key)
      )
    )
    .sort(
      (a, b) =>
        timeRank(a.timeOfDay, timeHint) - timeRank(b.timeOfDay, timeHint) ||
        a.name.length - b.name.length ||
        a.id.localeCompare(b.id)
    )
  return byFuzzy[0] ?? null
}

/** BGM：支持 id（bgm00003 / normal_area）、文件名、cloud/ 路径、曲名。 */
export function findCloudBgm(
  catalog: CloudCatalogData | null,
  value: unknown
): CloudBgmEntry | null {
  if (!catalog) return null
  const raw = normalizeRef(value)
  if (!raw) return null
  const lower = raw.toLowerCase()
  const lowerStem = stem(lower).toLowerCase()
  const exact = catalog.bgm.find(
    (entry) =>
      keysOf([entry.id, entry.file, stem(entry.file), entry.name]).includes(lower) ||
      keysOf([entry.id, stem(entry.file)]).includes(lowerStem)
  )
  if (exact) return exact

  const byName = catalog.bgm.filter(
    (entry) => entry.name.toLowerCase() === lower || entry.name.toLowerCase().includes(lower)
  )
  return byName.length === 1 ? byName[0] : null
}

const isBackViewCloudId = (id: string): boolean => /(?:^|[_-])back(?:\d*)$/i.test(id)

function stripModelExt(value: string): string {
  return value.replace(/\.model3\.json$/i, '').replace(/\.json$/i, '')
}

function stripVersionSuffix(value: string): string {
  return value.replace(/_\d+\.\d+(?:_[a-z0-9]+)*$/i, '')
}

function findCharacterModelFallback(
  catalog: CloudCatalogData,
  segments: string[]
): CloudModelEntry | null {
  const ordered = [
    segments[0],
    segments.length > 1 ? stripModelExt(segments[segments.length - 1]) : undefined,
    ...segments.slice(1, -1)
  ].filter((item): item is string => Boolean(item))

  for (const seg of ordered) {
    const clean = stripVersionSuffix(stripModelExt(seg)).toLowerCase()
    const match = /^(?:v2_)?(?:clb\d+_)?(?:\d{2})?([a-z]{2,12})(?:_([a-z0-9_]+))?$/.exec(clean)
    if (!match) continue
    const charKey = match[1]
    const outfitHint = (match[2] ?? '').toLowerCase()
    const charDef = CHARACTERS.find((c) => c.keys.some((k) => k === charKey))
    if (!charDef) continue

    const candidates = catalog.models
      .filter((entry) => entry.characterId === charDef.characterId)
      .sort(
        (a, b) =>
          Number(isBackViewCloudId(a.id)) - Number(isBackViewCloudId(b.id)) ||
          Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)) ||
          a.id.localeCompare(b.id)
      )
    if (candidates.length === 0) continue

    if (outfitHint) {
      const wantBack = isBackViewCloudId(clean)
      const pool = wantBack ? candidates : candidates.filter((m) => !isBackViewCloudId(m.id))
      const effectivePool = pool.length > 0 ? pool : candidates
      const outfitBase = outfitHint.replace(/\d+$/, '')
      const exactOutfit = effectivePool.find(
        (m) =>
          m.id.toLowerCase().endsWith(`_${outfitHint}`) ||
          (outfitBase.length > 0 && m.id.toLowerCase().endsWith(`_${outfitBase}`))
      )
      if (exactOutfit) return exactOutfit
      const partialOutfit = effectivePool.find(
        (m) => outfitBase.length > 0 && m.id.toLowerCase().includes(`_${outfitBase}`)
      )
      if (partialOutfit) return partialOutfit
    }
    return candidates[0]
  }
  return null
}

/** 模型：支持云端 id、服装标签（如「星乃一歌 校服」）、角色名/简称、cloud/ 路径与旧本地模型路径归一化。 */
export function findCloudModel(
  catalog: CloudCatalogData | null,
  value: unknown
): CloudModelEntry | null {
  if (!catalog) return null
  const raw = normalizeRef(value)
  if (!raw) return null
  const lower = raw.toLowerCase()
  const noCloud = raw.replace(/^cloud\//i, '')
  const segments = noCloud.split('/').filter(Boolean)

  const pathCandidates = new Set<string>([lower, noCloud.toLowerCase()])
  for (const seg of segments) {
    const segLower = seg.toLowerCase()
    const noExt = stripModelExt(segLower)
    pathCandidates.add(segLower)
    pathCandidates.add(noExt)
    pathCandidates.add(stripVersionSuffix(noExt))
  }

  const exactId = catalog.models.find((entry) => {
    const entryKeys = keysOf([
      entry.id,
      entry.path,
      entry.path.replace(/^cloud\//i, ''),
      stripModelExt(path.basename(entry.path))
    ])
    return entryKeys.some((k) => pathCandidates.has(k))
  })
  if (exactId) return exactId

  const byCharAndOutfit = catalog.models
    .filter((entry) => {
      const variants = keysOf([
        entry.outfitLabel ? `${entry.name} ${entry.outfitLabel}` : undefined,
        entry.outfitLabel ? `${entry.shortName} ${entry.outfitLabel}` : undefined,
        entry.outfitLabel ? `${entry.name}·${entry.outfitLabel}` : undefined,
        entry.outfitCategory ? `${entry.name} ${entry.outfitCategory}` : undefined,
        entry.outfitCategory ? `${entry.shortName} ${entry.outfitCategory}` : undefined
      ])
      return variants.includes(lower)
    })
    .sort(
      (a, b) =>
        Number(isBackViewCloudId(a.id)) - Number(isBackViewCloudId(b.id)) ||
        Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)) ||
        a.id.localeCompare(b.id)
    )
  if (byCharAndOutfit.length > 0) {
    return byCharAndOutfit[0]
  }

  const byChar = catalog.models
    .filter((entry) => keysOf([entry.name, entry.shortName]).includes(lower))
    .sort(
      (a, b) =>
        Number(isBackViewCloudId(a.id)) - Number(isBackViewCloudId(b.id)) ||
        Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)) ||
        a.id.localeCompare(b.id)
    )
  if (byChar.length > 0) return byChar[0]

  const bySubstring = catalog.models.filter((entry) => entry.id.toLowerCase().includes(lower))
  if (bySubstring.length === 1) return bySubstring[0]

  if (
    segments.length > 1 ||
    /\.model3\.json$/i.test(noCloud) ||
    /^(?:v2_)?(?:\d{2})?[a-z]+_/i.test(noCloud)
  ) {
    return findCharacterModelFallback(catalog, segments)
  }
  return null
}

async function ensureBackground(
  entry: CloudBackgroundEntry,
  ctx: CloudAssetContext
): Promise<string> {
  const imagesDir = path.join(ctx.resourcesDir, 'images', 'cloud')
  const existing = existsWithExtensions(imagesDir, entry.id, IMAGE_EXTENSIONS)
  if (existing) return `cloud/${path.basename(existing)}`

  const lockKey = `${path.resolve(ctx.resourcesDir)}::bg::${entry.id}`
  return withSingleFlight(backgroundLocks, lockKey, async () => {
    const cached = existsWithExtensions(imagesDir, entry.id, IMAGE_EXTENSIONS)
    if (cached) return `cloud/${path.basename(cached)}`

    ctx.logger.info(`[Cloud] 下载背景 ${entry.id}（${entry.name}）…`)
    const downloaded = await downloadMediaFile({
      kind: 'background',
      name: entry.id,
      outDir: ctx.resourcesDir,
      region: ctx.settings.region,
      assetBase: ctx.settings.assetBase || undefined,
      subdir: 'cloud',
      timeoutMs: ctx.settings.timeoutMs,
      retries: ctx.settings.retries
    })
    if (!downloaded) throw new Error(`cloud background not found: ${entry.id}`)
    ctx.logger.info(
      `[Cloud] 背景 ${entry.id} → ${downloaded.file}（${(downloaded.bytes / 1024).toFixed(0)} KB）`
    )
    return `cloud/${path.basename(downloaded.file)}`
  })
}

export const DEFAULT_INAPP_VERSION = 'jp-7.0.0'
export const DEFAULT_INAPP_CDN_BASE = 'https://storage.pjsk.moe/client/jp'

function canonicalInappUrls(site: string, region: string, relPath: string): string[] {
  const clientBase = `${site}/client/${region}`
  const clean = relPath.replace(/^\/+/, '')
  const spriteMatch = /^player\/loose\/Sprite\/([^/]+)\.png$/i.exec(clean)
  if (spriteMatch) {
    return [`${clientBase}/player/loose/Sprite/${encodeURIComponent(spriteMatch[1])}/image.png`]
  }
  if (clean === 'player/loose/Texture2D/tex_transition_left.png') {
    return [`${clientBase}/player/scenario/textures/tex_transition_left.png`]
  }
  if (clean === 'player/loose/Texture2D/tex_transition_top.png') {
    return [`${clientBase}/player/scenario/textures/tex_transition_top.png`]
  }
  if (clean === 'player/loose/Texture2D/tex_common_tri_01.png') {
    return [
      `${clientBase}/player/effects/common/tex_select_common_tri_01.png`,
      `${clientBase}/player/effects/common/texture/tex_tri_b.png`
    ]
  }
  if (clean === 'player/loose/Texture2D/holo.png') {
    return [`${clientBase}/player/live2d/materials/holo.png`]
  }
  const menuMatch = /^audio\/MenuCommon\/([^/]+)\.(?:wav|mp3)$/i.exec(clean)
  if (menuMatch) {
    return [
      `${clientBase}/streamingassets/MenuCommon.acb/cue/${encodeURIComponent(menuMatch[1])}.mp3`
    ]
  }
  const builtinMatch = /^audio\/MenuCommon_Built_in\/([^/]+)\.(?:wav|mp3)$/i.exec(clean)
  if (builtinMatch) {
    const cue = builtinMatch[1]
    const candidates = [
      `${clientBase}/streamingassets/MenuCommon_Built_in.acb/cue/${encodeURIComponent(cue)}.mp3`
    ]
    if (cue === 'SE_DECIDE1') {
      candidates.push(
        `${clientBase}/streamingassets/MenuCommon_Built_in.acb/cue/SE_CHOICE_DECIDE.mp3`,
        `${clientBase}/streamingassets/MenuCommon_Built_in.acb/cue/SE_DECIDE1_old.mp3`
      )
    }
    return candidates
  }
  return [`${clientBase}/${clean}`]
}

export const INAPP_UI_ASSET_PATHS = [
  'player/loose/Sprite/bg_story_adv.png',
  'player/loose/Sprite/bg_base_half_r8_wh.png',
  'player/loose/Sprite/bg_base_round_h48_wh.png',
  'player/loose/Sprite/icon_triangle_h22_wh.png',
  'player/loose/Sprite/btn_circle_h80_wh.png',
  'player/loose/Sprite/icon_menu_story_wh.png',
  'player/loose/Sprite/icon_pageForward_gn.png',
  'player/loose/Sprite/btn_round_h80_wh.png',
  'player/loose/Sprite/eff_btn_round_h80_a70_wh.png',
  'player/loose/Texture2D/tex_transition_left.png',
  'player/loose/Texture2D/tex_transition_top.png',
  'player/loose/Texture2D/tex_common_tri_01.png',
  'player/loose/Texture2D/holo.png',
  'audio/MenuCommon/SE_AREA_TRANSITION_SEKAI.wav',
  'audio/MenuCommon/SE_UI_CHOICES_OPEN.wav',
  'audio/MenuCommon/SE_UI_CHOICES_DECIDE.wav',
  'audio/MenuCommon_Built_in/SE_DECIDE1.wav'
] as const

export interface EnsureInappAssetsOptions {
  version?: string
  inappBase?: string
  paths?: readonly string[]
  force?: boolean
  timeoutMs?: number
  retries?: number
}

export interface EnsureInappAssetsResult {
  version: string
  rootDir: string
  cached: number
  downloaded: number
  failed: string[]
  offlineFallback: boolean
}

export function resolveInappAssetPath(
  resourcesDir: string,
  relPath: string,
  version = DEFAULT_INAPP_VERSION
): string {
  const clean = relPath.replace(/^\/+/, '')
  return path.join(resourcesDir, 'inapp', version, ...clean.split('/'))
}

/**
 * 拉取并缓存官方 `inapp/jp-7.0.0` UI/FX 贴图与通用 UI 音效到 `resources/inapp/<version>/`；
 * 支持多文件并发拉取与逐文件 single-flight 去重；
 * 离线或单文件失败时绝不阻断流程，由渲染端矢量 fallback（A3）自动兜底。
 */
export async function ensureInappUiAssets(
  ctx: Pick<CloudAssetContext, 'resourcesDir' | 'settings' | 'logger'>,
  options: EnsureInappAssetsOptions = {}
): Promise<EnsureInappAssetsResult> {
  const version = options.version ?? DEFAULT_INAPP_VERSION
  const explicitBase = options.inappBase?.trim().replace(/\/+$/, '')
  const region = ctx.settings?.region ?? 'jp'
  const paths = [...(options.paths ?? INAPP_UI_ASSET_PATHS)]
  const rootDir = path.join(ctx.resourcesDir, 'inapp', version)
  const resolvedRoot = path.resolve(ctx.resourcesDir)
  const timeoutMs = options.timeoutMs ?? Math.min(ctx.settings.timeoutMs, 15_000)
  const retries = options.retries ?? Math.min(ctx.settings.retries, 1)
  const concurrency = Math.max(1, Math.min(6, ctx.settings?.concurrency || 4))

  const outcomes = await mapPool(paths, concurrency, async (relPath) => {
    const localPath = resolveInappAssetPath(ctx.resourcesDir, relPath, version)
    if (!options.force && isNonEmptyFile(localPath)) {
      return 'cached' as const
    }
    const cleanRel = relPath.replace(/^\/+/, '')
    const downloadOne = async (): Promise<boolean> => {
      if (!options.force && isNonEmptyFile(localPath)) return true
      const candidateUrls = explicitBase
        ? [`${explicitBase}/${cleanRel}`]
        : orderCanonicalOrigins([...CANONICAL_ASSET_SITES]).flatMap((site) =>
            canonicalInappUrls(site, region, cleanRel)
          )

      for (const url of candidateUrls) {
        try {
          const buffer = await fetchBuffer(url, { timeoutMs, retries })
          if (buffer.byteLength === 0) throw new Error('empty body')
          if (!explicitBase) markCanonicalOriginHealthy(url)
          if (localPath.toLowerCase().endsWith('.wav') && url.toLowerCase().endsWith('.mp3')) {
            const mp3Temp = `${localPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp.mp3`
            atomicWrite(mp3Temp, buffer)
            try {
              fs.mkdirSync(path.dirname(localPath), { recursive: true })
              await transcodeAudioFile(mp3Temp, localPath)
            } catch {
              atomicWrite(localPath, buffer)
            } finally {
              fs.rmSync(mp3Temp, { force: true })
            }
          } else {
            atomicWrite(localPath, buffer)
          }
          return true
        } catch (error) {
          if (!explicitBase && isLikelyOriginFailure(error)) {
            markCanonicalOriginFailed(url)
          }
          // try next candidate URL / backup mirror
        }
      }
      return false
    }

    const saved = options.force
      ? await downloadOne()
      : await withSingleFlight(
          inappFileLocks,
          `${resolvedRoot}::${version}::${cleanRel}`,
          downloadOne
        )
    return saved ? ('downloaded' as const) : ('failed' as const)
  })

  let cached = 0
  let downloaded = 0
  const failed: string[] = []
  for (let i = 0; i < paths.length; i++) {
    const outcome = outcomes[i]
    if (outcome === 'cached') cached++
    else if (outcome === 'downloaded') downloaded++
    else failed.push(paths[i])
  }

  if (downloaded > 0 || failed.length > 0) {
    ctx.logger.info(
      `[Cloud] inapp/${version}: cached=${cached}, downloaded=${downloaded}, fallback=${failed.length}`
    )
  }
  return {
    version,
    rootDir,
    cached,
    downloaded,
    failed,
    offlineFallback: failed.length > 0
  }
}

export function findCloudSe(catalog: CloudCatalogData | null, query: string): CloudSeEntry | null {
  if (!catalog) return null
  const entries = catalog.se ?? []
  if (entries.length === 0) return null
  const q = query.trim().toLowerCase()
  if (!q) return null
  const stemQ = q.replace(/^cloud\//, '').replace(/\.(mp3|wav|ogg|flac|hca)$/i, '')
  const baseStemQ = stemQ.replace(/(?:_b)?_\d+$/, '')
  return (
    entries.find((e) => e.id.toLowerCase() === stemQ) ??
    entries.find((e) => e.file.toLowerCase() === q) ??
    entries.find((e) => e.id.toLowerCase() === stemQ.replace(/_b$/, '')) ??
    entries.find((e) => e.id.toLowerCase() === baseStemQ) ??
    entries.find(
      (e) =>
        e.description.toLowerCase().includes(q) ||
        e.tags.some((t) => t.toLowerCase() === stemQ || t.toLowerCase().includes(q))
    ) ??
    null
  )
}

async function ensureBgm(entry: CloudBgmEntry, ctx: CloudAssetContext): Promise<string> {
  const bgmDir = path.join(ctx.resourcesDir, 'audio', 'bgm', 'cloud')
  const existing = existsWithExtensions(bgmDir, entry.id, AUDIO_EXTENSIONS)
  if (existing) {
    const loop = extractAudioLoopMetadata(existing)
    if (loop) {
      entry.loopStartMs = loop.loopStartMs
      entry.loopEndMs = loop.loopEndMs
    }
    return `cloud/${path.basename(existing)}`
  }

  const lockKey = `${path.resolve(ctx.resourcesDir)}::bgm::${entry.id}`
  const resolved = await withSingleFlight(bgmLocks, lockKey, async () => {
    const cached = existsWithExtensions(bgmDir, entry.id, AUDIO_EXTENSIONS)
    if (cached) return `cloud/${path.basename(cached)}`

    ctx.logger.info(`[Cloud] 下载 BGM ${entry.id}（${entry.name}）…`)
    const downloaded = await downloadMediaFile({
      kind: 'bgm',
      name: entry.id,
      bundlePath: entry.bundlePath,
      saveAsName: entry.id,
      outDir: ctx.resourcesDir,
      region: ctx.settings.region,
      assetBase: ctx.settings.assetBase || undefined,
      subdir: 'cloud',
      timeoutMs: ctx.settings.timeoutMs,
      retries: ctx.settings.retries
    })
    if (!downloaded) throw new Error(`cloud bgm not found: ${entry.id}`)
    if (downloaded.loop) {
      entry.loopStartMs = downloaded.loop.loopStartMs
      entry.loopEndMs = downloaded.loop.loopEndMs
    } else {
      const localTarget = path.join(ctx.resourcesDir, ...downloaded.file.split('/'))
      const loop = extractAudioLoopMetadata(localTarget)
      if (loop) {
        entry.loopStartMs = loop.loopStartMs
        entry.loopEndMs = loop.loopEndMs
        writeAudioLoopSidecar(localTarget, loop)
      }
    }
    ctx.logger.info(
      `[Cloud] BGM ${entry.id} → ${downloaded.file}（${(downloaded.bytes / 1024 / 1024).toFixed(1)} MB）`
    )
    return `cloud/${path.basename(downloaded.file)}`
  })

  if (entry.loopStartMs === undefined) {
    const localAfter = path.join(ctx.resourcesDir, 'audio', 'bgm', ...resolved.split('/'))
    const loop = extractAudioLoopMetadata(localAfter)
    if (loop) {
      entry.loopStartMs = loop.loopStartMs
      entry.loopEndMs = loop.loopEndMs
    }
  }
  return resolved
}

async function ensureSe(file: string, ctx: CloudAssetContext): Promise<string | null> {
  // 故事可能已经写成上一轮物化后的 cloud/xxx.mp3，或旧本地 audio/se/xxx.mp3；统一归一化为纯文件名。
  const name = stripResourcePrefix(file, 'audio/se').replace(/^cloud\//i, '')
  const seDir = path.join(ctx.resourcesDir, 'audio', 'se', 'cloud')
  const local = existsWithExtensions(seDir, stem(name), AUDIO_EXTENSIONS)
  if (local) return `cloud/${path.basename(local)}`

  const catalogMatch = ctx.catalog ? findCloudSe(ctx.catalog, name) : undefined
  const targetCue = catalogMatch?.id ?? name
  const lockKey = `${path.resolve(ctx.resourcesDir)}::se::${stem(targetCue).toLowerCase()}`

  return withSingleFlight(seLocks, lockKey, async () => {
    const cached = existsWithExtensions(seDir, stem(name), AUDIO_EXTENSIONS)
    if (cached) return `cloud/${path.basename(cached)}`

    const inappCandidate = INAPP_UI_ASSET_PATHS.find(
      (p) =>
        p.startsWith('audio/') &&
        stem(path.posix.basename(p)).toLowerCase() === stem(name).toLowerCase()
    )
    if (inappCandidate) {
      await ensureInappUiAssets(ctx, {
        paths: [inappCandidate],
        timeoutMs: Math.min(ctx.settings.timeoutMs, 10_000)
      })
      const inappLocal = resolveInappAssetPath(ctx.resourcesDir, inappCandidate)
      if (isNonEmptyFile(inappLocal)) {
        const destName = path.basename(inappLocal)
        atomicWrite(path.join(seDir, destName), fs.readFileSync(inappLocal))
        return `cloud/${destName}`
      }
    }

    ctx.logger.info(`[Cloud] 下载 SE ${targetCue} …`)
    const downloaded = await downloadSeFile({
      name: targetCue,
      outDir: ctx.resourcesDir,
      region: ctx.settings.region,
      assetBase: ctx.settings.assetBase || undefined,
      timeoutMs: ctx.settings.timeoutMs,
      retries: ctx.settings.retries
    })
    if (!downloaded) return null
    ctx.logger.info(
      `[Cloud] SE ${targetCue} → ${downloaded.file}（${(downloaded.bytes / 1024).toFixed(0)} KB）`
    )
    return `cloud/${path.basename(downloaded.file)}`
  })
}

function isLegacyDefaultBgmRef(ref: string): boolean {
  const lower = ref
    .trim()
    .replace(/^\/+/, '')
    .replace(/^resources\//i, '')
    .toLowerCase()
  return lower === DEFAULT_LOCAL_BGM_PATH.toLowerCase() || lower === 'bg1.mp3' || lower === 'bg1'
}

function findDefaultCloudBgmEntry(catalog: CloudCatalogData): CloudBgmEntry | null {
  return (
    findCloudBgm(catalog, DEFAULT_CLOUD_BGM_ID) ??
    catalog.bgm.find((item) => item.id !== 'bgm00000' && Boolean(item.description)) ??
    catalog.bgm.find((item) => item.id !== 'bgm00000') ??
    null
  )
}

/**
 * 全局默认 BGM（config.yaml / bgm.yaml 的 `bgm.path`）也允许指向云端曲目：
 * - 非 cloudOnly 模式：本地文件真实存在时优先保留；
 * - cloudOnly 模式：严格忽略非 `cloud/` 本地文件，旧默认 `audio/bgm/bg1.mp3` 与其它本地路径
 *   一律按 id/曲名归一化并物化到 `audio/bgm/cloud/`。
 */
export async function resolveGlobalBgm(
  bgm: { enabled: boolean; path: string },
  ctx: CloudAssetContext
): Promise<boolean> {
  if (!bgm.enabled || !bgm.path) return false
  const isCloudOnly = Boolean(ctx.cloudOnly ?? ctx.settings?.cloudOnly)
  const raw = bgm.path.trim()
  if (/^https?:\/\//i.test(raw) || raw.startsWith('/')) return false
  const ref = raw.replace(/^resources\//i, '')
  const bgmRel = stripResourcePrefix(ref, 'audio/bgm')
  const isCloudRef = isCloudSubdirRef(ref, 'audio/bgm')

  if (!isCloudOnly && fs.existsSync(path.join(ctx.resourcesDir, ...ref.split('/')))) return false
  if (isCloudOnly && isCloudRef && localAudioExists(ctx.resourcesDir, 'bgm', bgmRel)) {
    const normalized = `audio/bgm/${bgmRel}`
    if (bgm.path !== normalized) {
      bgm.path = normalized
      return true
    }
    return false
  }

  const cloudBgmDir = path.join(ctx.resourcesDir, 'audio', 'bgm', 'cloud')
  const lookupStem = isCloudOnly && isLegacyDefaultBgmRef(ref) ? DEFAULT_CLOUD_BGM_ID : stem(bgmRel)
  const cachedCloud = lookupStem
    ? existsWithExtensions(cloudBgmDir, lookupStem, AUDIO_EXTENSIONS)
    : null
  if (cachedCloud) {
    const normalized = `audio/bgm/cloud/${path.basename(cachedCloud)}`
    if (bgm.path !== normalized) {
      bgm.path = normalized
      return true
    }
    return false
  }

  if (!ctx.catalog) return false

  let entry = findCloudBgm(ctx.catalog, bgmRel) ?? findCloudBgm(ctx.catalog, path.basename(bgmRel))
  if (!entry && isLegacyDefaultBgmRef(ref)) {
    entry = findDefaultCloudBgmEntry(ctx.catalog)
  }
  if (!entry) return false
  try {
    const file = await ensureBgm(entry, ctx)
    bgm.path = `audio/bgm/${file}`
    ctx.logger.info(`[Cloud] 全局 BGM 改用云端曲目 ${entry.name}（${bgm.path}）`)
    return true
  } catch (error) {
    ctx.logger.warn(`[Cloud] 全局 BGM 物化失败：${String(error)}`)
    return false
  }
}

function expectedModelBundles(entry: CloudModelEntry): string[] {
  const bundles = [...(entry.motionBundles ?? [])].filter(Boolean)
  const seen = new Set(bundles)
  if (entry.id.startsWith('v2_') || bundles.some((b) => b.startsWith('live2d/motion/v2_'))) {
    for (const candidate of live2dMotionSetCandidateNames(entry.id)) {
      if (candidate.startsWith('v2_')) continue
      const bundle = `live2d/motion/${candidate}`
      if (!seen.has(bundle)) {
        seen.add(bundle)
        bundles.push(bundle)
      }
    }
  }
  return bundles
}

function isNonEmptyFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

function isModelCoreComplete(modelJsonPath: string): boolean {
  if (!isNonEmptyFile(modelJsonPath)) return false
  const modelDir = path.dirname(modelJsonPath)
  try {
    const model3 = JSON.parse(fs.readFileSync(modelJsonPath, 'utf-8')) as {
      FileReferences?: {
        Moc?: string
        Physics?: string
        Textures?: string[]
      }
    }
    const refs = model3?.FileReferences
    if (!refs) return false
    if (refs.Moc && !isNonEmptyFile(path.join(modelDir, ...refs.Moc.split('/')))) {
      return false
    }
    if (refs.Physics && !isNonEmptyFile(path.join(modelDir, ...refs.Physics.split('/')))) {
      return false
    }
    for (const tex of refs.Textures ?? []) {
      if (tex && !isNonEmptyFile(path.join(modelDir, ...tex.split('/')))) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

function modelNeedsRepair(entry: CloudModelEntry, modelJsonPath: string): boolean {
  if (!isModelCoreComplete(modelJsonPath)) return true
  const modelDir = path.dirname(modelJsonPath)
  try {
    const model3 = JSON.parse(fs.readFileSync(modelJsonPath, 'utf-8')) as {
      FileReferences?: {
        Motions?: Record<string, Array<{ File?: string }>>
      }
    }
    const refs = model3?.FileReferences
    if (!refs) return true
    const indexed = refs.Motions ?? {}
    for (const motionName of entry.motions ?? []) {
      const fileRel = Array.isArray(indexed[motionName]) ? indexed[motionName][0]?.File : undefined
      if (!fileRel || !isNonEmptyFile(path.join(modelDir, ...fileRel.split('/')))) {
        return true
      }
    }

    const expectedRequired = (entry.motionBundles ?? []).filter(Boolean)
    if (expectedRequired.length > 0 || entry.id.startsWith('v2_')) {
      const sidecarPath = path.join(modelDir, MOTION_BUNDLES_SIDECAR)
      if (!isNonEmptyFile(sidecarPath)) return true
      const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8')) as { bundles?: string[] }
      const recorded = new Set(Array.isArray(sidecar?.bundles) ? sidecar.bundles : [])
      for (const bundle of expectedRequired) {
        if (!recorded.has(bundle)) return true
      }
    }
    return false
  } catch {
    return true
  }
}

/**
 * 当指定服装云端模型在重试与镜像切换后仍无法物化时，按同角色降级回退：
 * 1. 优先复用本地已完整缓存的同角色其他服装（同世代 v2/v1 与默认服装优先），零网络即可恢复；
 * 2. 其次尝试拉取同角色默认服装（最多尝试 2 个候选），避免单个活动服装异常导致整条导出失败。
 */
async function tryFallbackCharacterModel(
  failedEntry: CloudModelEntry,
  ctx: CloudAssetContext
): Promise<{ id: string; path: string } | null> {
  if (!ctx.catalog || typeof failedEntry.characterId !== 'number') return null
  const wantV2 = failedEntry.id.startsWith('v2_')
  const sameCharacter = ctx.catalog.models.filter(
    (entry) =>
      entry.characterId === failedEntry.characterId &&
      entry.id !== failedEntry.id &&
      !isBackViewCloudId(entry.id) &&
      !/black\d*$/i.test(entry.id)
  )
  if (sameCharacter.length === 0) return null

  const cachedReady: Array<{ entry: CloudModelEntry; full: boolean }> = []
  const uncached: CloudModelEntry[] = []
  for (const candidate of sameCharacter) {
    const candidatePath = path.join(ctx.resourcesDir, 'models', ...candidate.path.split('/'))
    if (isModelCoreComplete(candidatePath)) {
      cachedReady.push({ entry: candidate, full: !modelNeedsRepair(candidate, candidatePath) })
    } else {
      uncached.push(candidate)
    }
  }

  if (cachedReady.length > 0) {
    cachedReady.sort(
      (a, b) =>
        Number(b.full) - Number(a.full) ||
        Number(b.entry.id.startsWith('v2_') === wantV2) -
          Number(a.entry.id.startsWith('v2_') === wantV2) ||
        Number(Boolean(b.entry.isDefault)) - Number(Boolean(a.entry.isDefault)) ||
        a.entry.id.localeCompare(b.entry.id)
    )
    const picked = cachedReady[0].entry
    return { id: picked.id, path: picked.path }
  }

  uncached.sort(
    (a, b) =>
      Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)) ||
      Number(b.id.startsWith('v2_') === wantV2) - Number(a.id.startsWith('v2_') === wantV2) ||
      a.id.localeCompare(b.id)
  )
  for (const candidate of uncached.slice(0, 2)) {
    try {
      const resolvedPath = await ensureModel(candidate, ctx)
      return { id: candidate.id, path: resolvedPath }
    } catch {
      // try next fallback candidate
    }
  }
  return null
}

async function ensureModel(
  entry: CloudModelEntry,
  ctx: CloudAssetContext,
  concurrencyOverride?: number
): Promise<string> {
  const modelsDir = path.join(ctx.resourcesDir, 'models', 'cloud')
  const modelJson = path.join(ctx.resourcesDir, 'models', ...entry.path.split('/'))
  if (!modelNeedsRepair(entry, modelJson)) return entry.path

  const lockKey = `${path.resolve(ctx.resourcesDir)}::${entry.id}`
  return withSingleFlight(modelLocks, lockKey, async () => {
    if (!modelNeedsRepair(entry, modelJson)) return entry.path
    if (!ctx.catalog) throw new Error('cloud catalog unavailable')
    const repairing = fs.existsSync(modelJson)
    ctx.logger.info(
      `[Cloud] ${repairing ? '校验并补全' : '下载'} Live2D 模型 ${entry.id}（${entry.name}）…`
    )
    const bundles = expectedModelBundles(entry)
    const indexEntry: MoesekaiIndexEntry = {
      id: entry.id,
      bundle: entry.bundle,
      motion: bundles[0] ?? null,
      motions: entry.motionBundles?.length ? entry.motionBundles : bundles,
      characterId: entry.characterId
    }
    const result = await downloadModel(
      indexEntry,
      ctx.catalog.sources.libraryRoot,
      modelsDir,
      {
        timeoutMs: ctx.settings.timeoutMs,
        retries: ctx.settings.retries,
        concurrency: concurrencyOverride ?? ctx.settings.concurrency,
        cacheDir: ctx.settings.cacheDir
      },
      (message) => ctx.logger.info(`[Cloud] ${message}`)
    )
    ctx.logger.info(
      `[Cloud] Live2D 模型 ${entry.id} → models/cloud/${result.path}（${result.motions} 动作 / ${result.facials} 表情）`
    )
    return `cloud/${result.path}`
  })
}

function localModelExists(resourcesDir: string, ref: string): boolean {
  return isNonEmptyFile(path.join(resourcesDir, 'models', ...ref.split('/')))
}

function localImageExists(resourcesDir: string, ref: string): boolean {
  return isNonEmptyFile(path.join(resourcesDir, 'images', ...ref.split('/')))
}

function localAudioExists(resourcesDir: string, kind: 'bgm' | 'se', ref: string): boolean {
  return isNonEmptyFile(path.join(resourcesDir, 'audio', kind, ...ref.split('/')))
}

/**
 * 在导出前把故事里的云端引用物化并改写。
 *
 * 本地已存在的文件永远优先；只有找不到本地文件时才查云端目录。
 * 找不到对应云端条目时保留原值，让渲染端报出清晰的 "could not be loaded"。
 */
export async function resolveStoryCloudAssets(
  story: StoryData,
  ctx: CloudAssetContext
): Promise<CloudAssetResolution> {
  const result: CloudAssetResolution = { models: 0, images: 0, bgm: 0, se: 0, missing: [] }
  const isCloudOnly = Boolean(ctx.cloudOnly ?? ctx.settings?.cloudOnly)
  if (!ctx.catalog) {
    if (isCloudOnly) {
      ctx.logger.warn(
        '[Cloud] catalog unavailable in cloudOnly mode; legacy local assets are ignored'
      )
      for (const model of story.models) {
        const norm = stripResourcePrefix(model.model, 'models')
        if (!isCloudSubdirRef(model.model, 'models') || !localModelExists(ctx.resourcesDir, norm)) {
          result.missing.push(`model:${model.model}`)
        }
      }
      for (const image of story.images) {
        const norm = stripResourcePrefix(image.image, 'images')
        if (!isCloudSubdirRef(image.image, 'images') || !localImageExists(ctx.resourcesDir, norm)) {
          result.missing.push(`image:${image.image}`)
        }
      }
      for (const snippet of story.snippets) {
        if (snippet.type === 'ChangeBgm' && !snippet.data.stop && snippet.data.file) {
          const norm = stripResourcePrefix(snippet.data.file, 'audio/bgm')
          if (
            !isCloudSubdirRef(snippet.data.file, 'audio/bgm') ||
            !localAudioExists(ctx.resourcesDir, 'bgm', norm)
          ) {
            result.missing.push(`bgm:${snippet.data.file}`)
          }
        } else if ((snippet.type === 'PlaySe' || snippet.type === 'StopSe') && snippet.data.file) {
          const norm = stripResourcePrefix(snippet.data.file, 'audio/se')
          if (
            !isCloudSubdirRef(snippet.data.file, 'audio/se') ||
            !localAudioExists(ctx.resourcesDir, 'se', norm)
          ) {
            result.missing.push(`se:${snippet.data.file}`)
          }
        }
      }
    } else {
      ctx.logger.warn('[Cloud] catalog unavailable, story assets stay local-only')
    }
    return result
  }

  const catalog = ctx.catalog
  const configuredConcurrency = Math.max(1, ctx.settings.concurrency || 4)
  const modelConcurrency = Math.max(1, Math.min(4, configuredConcurrency))
  const mediaConcurrency = Math.max(1, Math.min(6, configuredConcurrency))
  const perModelFileConcurrency =
    configuredConcurrency <= 1
      ? 1
      : Math.max(
          2,
          Math.ceil(
            configuredConcurrency / Math.min(modelConcurrency, Math.max(1, story.models.length))
          )
        )

  const modelMissing: string[] = []
  const imageMissing: string[] = []
  const snippetMissingByIndex = new Map<number, string>()

  const resolveModelRef = (
    rawRef: string
  ): { normRef: string; isCloudRef: boolean; cloudEntry: CloudModelEntry | null } => {
    const normRef = stripResourcePrefix(rawRef, 'models')
    const isCloudRef = isCloudSubdirRef(rawRef, 'models')
    const cloudEntry = isCloudRef
      ? (catalog.models.find(
          (item) =>
            normRef === item.path ||
            normRef === `cloud/${item.id}` ||
            normRef.startsWith(`cloud/${item.id}/`)
        ) ?? findCloudModel(catalog, normRef))
      : findCloudModel(catalog, normRef)
    return { normRef, isCloudRef, cloudEntry }
  }

  // 预先收集各类片段任务，使模型 / 背景 / BGM / SE / 换装 / inapp UI 贴图全链路并行物化
  const modelById = new Map(story.models.map((m) => [m.id, m]))
  const bgmTasks: Array<{
    snippetIndex: number
    snippet: Extract<StoryData['snippets'][number], { type: 'ChangeBgm' }>
  }> = []
  const seTasks: Array<{
    snippetIndex: number
    snippet: Extract<StoryData['snippets'][number], { type: 'PlaySe' | 'StopSe' }>
  }> = []
  const costumeTasks: Array<{
    snippetIndex: number
    snippet: Extract<StoryData['snippets'][number], { type: 'CostumeChange' }>
  }> = []
  const neededInapp = new Set<string>()

  for (let i = 0; i < story.snippets.length; i++) {
    const snippet = story.snippets[i]
    if (snippet.type === 'ChangeBgm') {
      if (!snippet.data.stop && snippet.data.file) {
        bgmTasks.push({ snippetIndex: i, snippet })
      }
    } else if (snippet.type === 'PlaySe' || snippet.type === 'StopSe') {
      if (snippet.data.file) {
        seTasks.push({ snippetIndex: i, snippet })
      }
    } else if (snippet.type === 'CostumeChange') {
      costumeTasks.push({ snippetIndex: i, snippet })
    } else if (snippet.type === 'SekaiIn' || snippet.type === 'SekaiOut') {
      neededInapp.add('player/loose/Texture2D/tex_common_tri_01.png')
      neededInapp.add('audio/MenuCommon/SE_AREA_TRANSITION_SEKAI.wav')
    } else if (snippet.type === 'SideFade') {
      neededInapp.add('player/loose/Texture2D/tex_transition_left.png')
      neededInapp.add('player/loose/Texture2D/tex_transition_top.png')
    } else if (
      snippet.type === 'AttachCharacterShader' &&
      (snippet.data.shader === 'hologram' || snippet.data.shader === 'monitor')
    ) {
      neededInapp.add('player/loose/Texture2D/holo.png')
    } else if (snippet.type === 'SimpleSelectable') {
      neededInapp.add('player/loose/Sprite/btn_round_h80_wh.png')
      neededInapp.add('player/loose/Sprite/eff_btn_round_h80_a70_wh.png')
      neededInapp.add('audio/MenuCommon/SE_UI_CHOICES_OPEN.wav')
      neededInapp.add('audio/MenuCommon/SE_UI_CHOICES_DECIDE.wav')
      neededInapp.add('audio/MenuCommon_Built_in/SE_DECIDE1.wav')
    } else if (snippet.type === 'Talk' || snippet.type === 'PlaceInfo') {
      neededInapp.add('player/loose/Sprite/bg_story_adv.png')
      neededInapp.add('player/loose/Sprite/bg_base_half_r8_wh.png')
      neededInapp.add('player/loose/Sprite/bg_base_round_h48_wh.png')
      neededInapp.add('player/loose/Sprite/icon_triangle_h22_wh.png')
      neededInapp.add('player/loose/Sprite/btn_circle_h80_wh.png')
      neededInapp.add('player/loose/Sprite/icon_menu_story_wh.png')
      neededInapp.add('player/loose/Sprite/icon_pageForward_gn.png')
    }
  }

  const modelsWork = mapPool(story.models, modelConcurrency, async (model, idx) => {
    const rawRef = model.model
    const { normRef, isCloudRef, cloudEntry } = resolveModelRef(rawRef)

    if ((!isCloudOnly || isCloudRef) && localModelExists(ctx.resourcesDir, normRef)) {
      const localPath = path.join(ctx.resourcesDir, 'models', ...normRef.split('/'))
      const coreComplete = !isCloudRef || isModelCoreComplete(localPath)
      if (coreComplete) {
        if (isCloudRef && rawRef !== normRef) {
          model.model = normRef
        }
        if (isCloudRef && cloudEntry && modelNeedsRepair(cloudEntry, localPath)) {
          try {
            model.model = await ensureModel(cloudEntry, ctx, perModelFileConcurrency)
            result.models++
          } catch (error) {
            ctx.logger.warn(`[Cloud] 模型 ${rawRef} 动作补全失败，保留本地缓存：${String(error)}`)
          }
        }
        return null
      }
      ctx.logger.warn(`[Cloud] 本地缓存模型 ${rawRef} 缺少核心文件或已损坏，将重新物化`)
    }
    if (!cloudEntry) {
      return { idx, missing: `model:${rawRef}` }
    }
    try {
      model.model = await ensureModel(cloudEntry, ctx, perModelFileConcurrency)
      result.models++
    } catch (error) {
      const fallback = await tryFallbackCharacterModel(cloudEntry, ctx)
      if (fallback) {
        ctx.logger.warn(
          `[Cloud] 模型 ${rawRef} 物化失败（${String(error)}），已自动回退为同角色模型 ${fallback.id}（${fallback.path}）`
        )
        model.model = fallback.path
        result.models++
      } else {
        ctx.logger.error(`[Cloud] 模型 ${rawRef} 物化失败：${String(error)}`)
        return { idx, missing: `model:${rawRef}` }
      }
    }
    return null
  })

  const imagesWork = mapPool(story.images, mediaConcurrency, async (image, idx) => {
    const rawRef = image.image
    const normRef = stripResourcePrefix(rawRef, 'images')
    const isCloudRef = isCloudSubdirRef(rawRef, 'images')
    if ((!isCloudOnly || isCloudRef) && localImageExists(ctx.resourcesDir, normRef)) {
      if (isCloudRef && rawRef !== normRef) {
        image.image = normRef
      }
      return null
    }
    const entry = findCloudBackground(catalog, normRef)
    if (!entry) {
      return { idx, missing: `image:${rawRef}` }
    }
    try {
      image.image = await ensureBackground(entry, ctx)
      result.images++
    } catch (error) {
      ctx.logger.error(`[Cloud] 背景 ${rawRef} 物化失败：${String(error)}`)
      return { idx, missing: `image:${rawRef}` }
    }
    return null
  })

  const bgmWork = mapPool(bgmTasks, mediaConcurrency, async ({ snippetIndex, snippet }) => {
    const rawRef = snippet.data.file
    if (!rawRef) return
    const normRef = stripResourcePrefix(rawRef, 'audio/bgm')
    const isCloudRef = isCloudSubdirRef(rawRef, 'audio/bgm')
    if ((!isCloudOnly || isCloudRef) && localAudioExists(ctx.resourcesDir, 'bgm', normRef)) {
      if (isCloudRef && rawRef !== normRef) {
        snippet.data.file = normRef
      }
      return
    }
    let entry = findCloudBgm(catalog, normRef) ?? findCloudBgm(catalog, path.basename(normRef))
    if (!entry && isCloudOnly && isLegacyDefaultBgmRef(rawRef)) {
      entry = findDefaultCloudBgmEntry(catalog)
    }
    if (!entry) {
      snippetMissingByIndex.set(snippetIndex, `bgm:${rawRef}`)
      return
    }
    try {
      snippet.data.file = await ensureBgm(entry, ctx)
      result.bgm++
    } catch (error) {
      ctx.logger.error(`[Cloud] BGM ${rawRef} 物化失败：${String(error)}`)
      snippetMissingByIndex.set(snippetIndex, `bgm:${rawRef}`)
    }
  })

  const seWork = mapPool(seTasks, mediaConcurrency, async ({ snippetIndex, snippet }) => {
    const rawRef = snippet.data.file
    if (!rawRef) return
    const normRef = stripResourcePrefix(rawRef, 'audio/se')
    const isCloudRef = isCloudSubdirRef(rawRef, 'audio/se')
    if ((!isCloudOnly || isCloudRef) && localAudioExists(ctx.resourcesDir, 'se', normRef)) {
      if (isCloudRef && rawRef !== normRef) {
        snippet.data.file = normRef
      }
      return
    }
    try {
      const resolved = await ensureSe(normRef, ctx)
      if (resolved) {
        snippet.data.file = resolved
        result.se++
      } else {
        snippetMissingByIndex.set(snippetIndex, `se:${rawRef}`)
      }
    } catch (error) {
      ctx.logger.error(`[Cloud] SE ${rawRef} 物化失败：${String(error)}`)
      snippetMissingByIndex.set(snippetIndex, `se:${rawRef}`)
    }
  })

  const costumeWork = mapPool(costumeTasks, modelConcurrency, async ({ snippet }) => {
    const targetModel = modelById.get(snippet.data.modelId)
    const costumeRef = targetModel?.costumes?.[snippet.data.costume] ?? snippet.data.costume
    if (!costumeRef) return
    const normCostume = stripResourcePrefix(costumeRef, 'models')
    const isCloudRef = isCloudSubdirRef(costumeRef, 'models')
    const entry = findCloudModel(catalog, normCostume)
    const canReuseLocal =
      (!isCloudOnly || isCloudRef) && localModelExists(ctx.resourcesDir, normCostume)
    if (
      entry &&
      (!canReuseLocal ||
        (isCloudRef &&
          modelNeedsRepair(
            entry,
            path.join(ctx.resourcesDir, 'models', ...normCostume.split('/'))
          )))
    ) {
      try {
        const resolved = await ensureModel(entry, ctx, perModelFileConcurrency)
        if (targetModel) {
          targetModel.costumes = {
            ...(targetModel.costumes ?? {}),
            [snippet.data.costume]: resolved
          }
        }
        result.models++
      } catch (error) {
        const fallback = await tryFallbackCharacterModel(entry, ctx)
        if (fallback && targetModel) {
          ctx.logger.warn(
            `[Cloud] 服装模型 ${costumeRef} 物化失败（${String(error)}），已自动回退为同角色模型 ${fallback.id}（${fallback.path}）`
          )
          targetModel.costumes = {
            ...(targetModel.costumes ?? {}),
            [snippet.data.costume]: fallback.path
          }
          result.models++
        } else {
          ctx.logger.error(`[Cloud] 服装模型 ${costumeRef} 物化失败：${String(error)}`)
        }
      }
    }
  })

  const isLocalTestMock = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(
    ctx.settings.assetBase || ''
  )
  const inappWork =
    neededInapp.size > 0 && !isLocalTestMock
      ? ensureInappUiAssets(ctx, {
          paths: [...neededInapp],
          timeoutMs: Math.min(ctx.settings.timeoutMs, 5_000),
          retries: 0
        }).catch(() => undefined)
      : Promise.resolve(undefined)

  const [modelOutcomes, imageOutcomes] = await Promise.all([
    modelsWork,
    imagesWork,
    bgmWork,
    seWork,
    costumeWork,
    inappWork
  ])

  for (const item of modelOutcomes) {
    if (item?.missing) modelMissing.push(item.missing)
  }
  for (const item of imageOutcomes) {
    if (item?.missing) imageMissing.push(item.missing)
  }
  const snippetMissing = [...snippetMissingByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, missing]) => missing)
  result.missing.push(...modelMissing, ...imageMissing, ...snippetMissing)

  if (result.models + result.images + result.bgm + result.se > 0) {
    ctx.logger.info(
      `[Cloud] story assets materialized: models=${result.models}, images=${result.images}, bgm=${result.bgm}, se=${result.se}`
    )
  }
  if (result.missing.length > 0) {
    ctx.logger.warn(`[Cloud] unresolved cloud refs: ${result.missing.join(', ')}`)
  }
  return result
}

export interface CloudAssetPrewarmRefs {
  models?: string[]
  backgrounds?: string[]
  bgms?: string[]
  ses?: string[]
  inapp?: string[]
  globalBgm?: { enabled: boolean; path: string }
  signal?: AbortSignal
}

/**
 * 后台无副作用预热云端资源（不改写任何 StoryData / 全局配置对象）。
 *
 * 与 `resolveStoryCloudAssets` / `resolveGlobalBgm` 共用同一组进程内 single-flight 锁：
 * - 在 AI `cast` / `staging` 锁定模型、背景、BGM、SE 后立即启动，与后续 110s+ LLM 阶段重叠；
 * - 导出前 `resolveStoryCloudAssets` 调用时，已下完的直接命中本地缓存（<1ms），仍在途的
 *   自动复用同一 Promise，绝不重复下载或产生写盘竞态。
 */
export async function prewarmCloudAssets(
  refs: CloudAssetPrewarmRefs,
  ctx: CloudAssetContext
): Promise<CloudAssetResolution> {
  const result: CloudAssetResolution = { models: 0, images: 0, bgm: 0, se: 0, missing: [] }
  const catalog = ctx.catalog
  if (!catalog || refs.signal?.aborted) return result

  const isCloudOnly = Boolean(ctx.cloudOnly ?? ctx.settings?.cloudOnly)
  const configuredConcurrency = Math.max(1, ctx.settings.concurrency || 4)
  const modelConcurrency = Math.max(1, Math.min(3, configuredConcurrency))
  const mediaConcurrency = Math.max(1, Math.min(6, configuredConcurrency))

  const uniqueStrings = (list?: string[]): string[] => {
    if (!list || list.length === 0) return []
    const out: string[] = []
    const seen = new Set<string>()
    for (const raw of list) {
      const trimmed = typeof raw === 'string' ? raw.trim() : ''
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      out.push(trimmed)
    }
    return out
  }

  const modelRefs = uniqueStrings(refs.models)
  const bgRefs = uniqueStrings(refs.backgrounds)
  const bgmRefs = uniqueStrings(refs.bgms)
  const seRefs = uniqueStrings(refs.ses)
  const inappRefs = uniqueStrings(refs.inapp)

  const perModelFileConcurrency =
    configuredConcurrency <= 1
      ? 1
      : Math.max(
          2,
          Math.ceil(
            configuredConcurrency / Math.min(modelConcurrency, Math.max(1, modelRefs.length))
          )
        )

  const modelsWork = mapPool(modelRefs, modelConcurrency, async (rawRef) => {
    if (refs.signal?.aborted) return
    const normRef = stripResourcePrefix(rawRef, 'models')
    const isCloudRef = isCloudSubdirRef(rawRef, 'models')
    const entry = isCloudRef
      ? (catalog.models.find(
          (item) =>
            normRef === item.path ||
            normRef === `cloud/${item.id}` ||
            normRef.startsWith(`cloud/${item.id}/`)
        ) ?? findCloudModel(catalog, normRef))
      : findCloudModel(catalog, normRef)
    if (!entry) return
    if (
      (!isCloudOnly || isCloudRef) &&
      localModelExists(ctx.resourcesDir, normRef) &&
      !modelNeedsRepair(entry, path.join(ctx.resourcesDir, 'models', ...normRef.split('/')))
    ) {
      return
    }
    try {
      await ensureModel(entry, ctx, perModelFileConcurrency)
      result.models++
    } catch (error) {
      ctx.logger.debug?.(`[Cloud] 后台预热模型 ${entry.id} 跳过：${String(error)}`)
    }
  })

  const bgsWork = mapPool(bgRefs, mediaConcurrency, async (rawRef) => {
    if (refs.signal?.aborted) return
    const normRef = stripResourcePrefix(rawRef, 'images')
    const isCloudRef = isCloudSubdirRef(rawRef, 'images')
    if ((!isCloudOnly || isCloudRef) && localImageExists(ctx.resourcesDir, normRef)) return
    const entry = findCloudBackground(catalog, normRef)
    if (!entry) return
    try {
      await ensureBackground(entry, ctx)
      result.images++
    } catch (error) {
      ctx.logger.debug?.(`[Cloud] 后台预热背景 ${entry.id} 跳过：${String(error)}`)
    }
  })

  const bgmCandidateRefs = [...bgmRefs]
  if (refs.globalBgm?.enabled && refs.globalBgm.path) {
    const raw = refs.globalBgm.path.trim()
    if (
      raw &&
      !/^https?:\/\//i.test(raw) &&
      !raw.startsWith('/') &&
      !bgmCandidateRefs.includes(raw)
    ) {
      bgmCandidateRefs.push(raw)
    }
  }

  const bgmsWork = mapPool(bgmCandidateRefs, mediaConcurrency, async (rawRef) => {
    if (refs.signal?.aborted) return
    const normRef = stripResourcePrefix(rawRef, 'audio/bgm')
    const isCloudRef = isCloudSubdirRef(rawRef, 'audio/bgm')
    if ((!isCloudOnly || isCloudRef) && localAudioExists(ctx.resourcesDir, 'bgm', normRef)) return
    let entry = findCloudBgm(catalog, normRef) ?? findCloudBgm(catalog, path.basename(normRef))
    if (!entry && isCloudOnly && isLegacyDefaultBgmRef(rawRef)) {
      entry = findDefaultCloudBgmEntry(catalog)
    }
    if (!entry) return
    try {
      await ensureBgm(entry, ctx)
      result.bgm++
    } catch (error) {
      ctx.logger.debug?.(`[Cloud] 后台预热 BGM ${entry.id} 跳过：${String(error)}`)
    }
  })

  const sesWork = mapPool(seRefs, mediaConcurrency, async (rawRef) => {
    if (refs.signal?.aborted) return
    const normRef = stripResourcePrefix(rawRef, 'audio/se')
    const isCloudRef = isCloudSubdirRef(rawRef, 'audio/se')
    if ((!isCloudOnly || isCloudRef) && localAudioExists(ctx.resourcesDir, 'se', normRef)) return
    try {
      const resolved = await ensureSe(normRef, ctx)
      if (resolved) result.se++
    } catch (error) {
      ctx.logger.debug?.(`[Cloud] 后台预热 SE ${normRef} 跳过：${String(error)}`)
    }
  })

  const isLocalTestMock = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(
    ctx.settings.assetBase || ''
  )
  const inappWork =
    inappRefs.length > 0 && !isLocalTestMock && !refs.signal?.aborted
      ? ensureInappUiAssets(ctx, {
          paths: inappRefs,
          timeoutMs: Math.min(ctx.settings.timeoutMs, 5_000),
          retries: 0
        }).catch(() => undefined)
      : Promise.resolve(undefined)

  await Promise.all([modelsWork, bgsWork, bgmsWork, sesWork, inappWork])
  if (result.models + result.images + result.bgm + result.se > 0) {
    ctx.logger.info(
      `[Cloud] background prewarm complete: models=${result.models}, images=${result.images}, bgm=${result.bgm}, se=${result.se}`
    )
  }
  return result
}
