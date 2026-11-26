/**
 * 云端资源物化：把故事里的云端引用（背景名/ID、BGM 名/ID、云端模型 id）
 * 解析成资源根下的真实文件，并把故事路径改写为渲染端可直接加载的相对路径。
 *
 * 设计目标与 ournotes-player 的按需加载一致：
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
import { atomicWrite, request } from './http'
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

const IMAGE_EXTENSIONS = ['.webp', '.png', '.jpg', '.jpeg']
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.flac']

export interface CloudAssetContext {
  settings: AssetsSettings
  resourcesDir: string
  catalog: CloudCatalogData | null
  logger: Logger<ILogObj>
  onProgress?: (message: string) => void
}

export interface CloudAssetResolution {
  models: number
  images: number
  bgm: number
  se: number
  missing: string[]
}

const modelLocks = new Map<string, Promise<string>>()

function normalizeRef(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^resources\//i, '')
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
    if (fs.existsSync(candidate)) return candidate
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

/** 模型：支持云端 id、服装标签（如「星乃一歌 校服」）、角色名/简称、cloud/ 路径。 */
export function findCloudModel(
  catalog: CloudCatalogData | null,
  value: unknown
): CloudModelEntry | null {
  if (!catalog) return null
  const raw = normalizeRef(value)
  if (!raw) return null
  const lower = raw.toLowerCase()

  const exactId = catalog.models.find((entry) =>
    keysOf([entry.id, entry.path, stem(entry.path)]).includes(lower)
  )
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
  return bySubstring.length === 1 ? bySubstring[0] : null
}

async function ensureBackground(
  entry: CloudBackgroundEntry,
  ctx: CloudAssetContext
): Promise<string> {
  const imagesDir = path.join(ctx.resourcesDir, 'images', 'cloud')
  const existing = existsWithExtensions(imagesDir, entry.id, IMAGE_EXTENSIONS)
  if (existing) return `cloud/${path.basename(existing)}`

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

const inappInflights = new Map<string, Promise<EnsureInappAssetsResult>>()

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
 * 离线或单文件失败时绝不阻断流程，由渲染端矢量 fallback（A3）自动兜底。
 */
export async function ensureInappUiAssets(
  ctx: Pick<CloudAssetContext, 'resourcesDir' | 'settings' | 'logger'>,
  options: EnsureInappAssetsOptions = {}
): Promise<EnsureInappAssetsResult> {
  const version = options.version ?? DEFAULT_INAPP_VERSION
  const explicitBase = options.inappBase?.trim().replace(/\/+$/, '')
  const region = ctx.settings?.region ?? 'jp'
  const paths = options.paths ?? INAPP_UI_ASSET_PATHS
  const key = `${ctx.resourcesDir}::${version}::${paths.length}`
  const existingLock = !options.force ? inappInflights.get(key) : undefined
  if (existingLock) return existingLock

  const work = (async (): Promise<EnsureInappAssetsResult> => {
    const rootDir = path.join(ctx.resourcesDir, 'inapp', version)
    const timeoutMs = options.timeoutMs ?? Math.min(ctx.settings.timeoutMs, 15_000)
    const retries = options.retries ?? Math.min(ctx.settings.retries, 1)
    let cached = 0
    let downloaded = 0
    const failed: string[] = []

    for (const relPath of paths) {
      const localPath = resolveInappAssetPath(ctx.resourcesDir, relPath, version)
      if (!options.force && fs.existsSync(localPath) && fs.statSync(localPath).size > 0) {
        cached++
        continue
      }
      const cleanRel = relPath.replace(/^\/+/, '')
      const candidateUrls = explicitBase
        ? [`${explicitBase}/${cleanRel}`]
        : CANONICAL_ASSET_SITES.flatMap((site) => canonicalInappUrls(site, region, cleanRel))

      let saved = false
      for (const url of candidateUrls) {
        try {
          const resp = await request(url, { timeoutMs, retries })
          const buffer = Buffer.from(await resp.arrayBuffer())
          if (buffer.byteLength === 0) throw new Error('empty body')
          if (localPath.toLowerCase().endsWith('.wav') && url.toLowerCase().endsWith('.mp3')) {
            const mp3Temp = `${localPath}.tmp.mp3`
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
          saved = true
          break
        } catch {
          // try next candidate URL / backup mirror
        }
      }
      if (saved) downloaded++
      else failed.push(relPath)
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
  })()

  inappInflights.set(key, work)
  try {
    return await work
  } finally {
    inappInflights.delete(key)
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
}

async function ensureSe(file: string, ctx: CloudAssetContext): Promise<string | null> {
  // 故事可能已经写成上一轮物化后的 cloud/xxx.mp3；查资源和下载都用纯文件名。
  const name = file.replace(/^cloud\//i, '')
  const seDir = path.join(ctx.resourcesDir, 'audio', 'se', 'cloud')
  const local = existsWithExtensions(seDir, stem(name), AUDIO_EXTENSIONS)
  if (local) return `cloud/${path.basename(local)}`

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
    if (fs.existsSync(inappLocal)) {
      fs.mkdirSync(seDir, { recursive: true })
      const destName = path.basename(inappLocal)
      fs.copyFileSync(inappLocal, path.join(seDir, destName))
      return `cloud/${destName}`
    }
  }

  const catalogMatch = ctx.catalog ? findCloudSe(ctx.catalog, name) : undefined
  const targetCue = catalogMatch?.id ?? name

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
}

function isLegacyDefaultBgmRef(ref: string): boolean {
  const lower = ref.trim().replace(/^\/+/, '').toLowerCase()
  return lower === DEFAULT_LOCAL_BGM_PATH.toLowerCase() || lower === 'bg1.mp3' || lower === 'bg1'
}

/**
 * 全局默认 BGM（config.yaml / bgm.yaml 的 `bgm.path`）也允许指向云端曲目：
 * 本地文件真实存在时永远优先保留；本地不存在时按曲名/id 解析并下载，
 * 若仍为旧默认占位 `audio/bgm/bg1.mp3` 且磁盘无该文件，则回落到已验证的云端日常 BGM（如 bgm00003）。
 */
export async function resolveGlobalBgm(
  bgm: { enabled: boolean; path: string },
  ctx: CloudAssetContext
): Promise<boolean> {
  if (!bgm.enabled || !bgm.path || !ctx.catalog) return false
  const raw = bgm.path.trim()
  if (/^https?:\/\//i.test(raw) || raw.startsWith('/')) return false
  const ref = raw.replace(/^resources\//i, '')
  if (fs.existsSync(path.join(ctx.resourcesDir, ...ref.split('/')))) return false

  let entry = findCloudBgm(ctx.catalog, ref) ?? findCloudBgm(ctx.catalog, path.basename(ref))
  if (!entry && isLegacyDefaultBgmRef(ref)) {
    entry =
      findCloudBgm(ctx.catalog, DEFAULT_CLOUD_BGM_ID) ??
      ctx.catalog.bgm.find((item) => item.id !== 'bgm00000' && Boolean(item.description)) ??
      ctx.catalog.bgm.find((item) => item.id !== 'bgm00000') ??
      null
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

const MOTION_BUNDLES_SIDECAR = '.motion-bundles.json'

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

function modelNeedsRepair(entry: CloudModelEntry, modelJsonPath: string): boolean {
  if (!fs.existsSync(modelJsonPath)) return true
  const modelDir = path.dirname(modelJsonPath)
  try {
    const model3 = JSON.parse(fs.readFileSync(modelJsonPath, 'utf-8')) as {
      FileReferences?: {
        Moc?: string
        Textures?: string[]
        Motions?: Record<string, Array<{ File?: string }>>
      }
    }
    const refs = model3?.FileReferences
    if (!refs) return true
    if (refs.Moc && !fs.existsSync(path.join(modelDir, ...refs.Moc.split('/')))) {
      return true
    }
    for (const tex of refs.Textures ?? []) {
      if (tex && !fs.existsSync(path.join(modelDir, ...tex.split('/')))) {
        return true
      }
    }
    const indexed = refs.Motions ?? {}
    for (const motionName of entry.motions ?? []) {
      const fileRel = Array.isArray(indexed[motionName]) ? indexed[motionName][0]?.File : undefined
      if (!fileRel || !fs.existsSync(path.join(modelDir, ...fileRel.split('/')))) {
        return true
      }
    }

    const expectedRequired = (entry.motionBundles ?? []).filter(Boolean)
    if (expectedRequired.length > 0 || entry.id.startsWith('v2_')) {
      const sidecarPath = path.join(modelDir, MOTION_BUNDLES_SIDECAR)
      if (!fs.existsSync(sidecarPath)) return true
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

async function ensureModel(entry: CloudModelEntry, ctx: CloudAssetContext): Promise<string> {
  const modelsDir = path.join(ctx.resourcesDir, 'models', 'cloud')
  const modelJson = path.join(ctx.resourcesDir, 'models', ...entry.path.split('/'))
  if (!modelNeedsRepair(entry, modelJson)) return entry.path

  const lockKey = `${path.resolve(ctx.resourcesDir)}::${entry.id}`
  const existing = modelLocks.get(lockKey)
  if (existing) return existing
  const task = (async () => {
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
        concurrency: ctx.settings.concurrency,
        cacheDir: ctx.settings.cacheDir
      },
      (message) => ctx.logger.info(`[Cloud] ${message}`)
    )
    ctx.logger.info(
      `[Cloud] Live2D 模型 ${entry.id} → models/cloud/${result.path}（${result.motions} 动作 / ${result.facials} 表情）`
    )
    return `cloud/${result.path}`
  })().finally(() => {
    modelLocks.delete(lockKey)
  })
  modelLocks.set(lockKey, task)
  return task
}

function localModelExists(resourcesDir: string, ref: string): boolean {
  return fs.existsSync(path.join(resourcesDir, 'models', ...ref.split('/')))
}

function localImageExists(resourcesDir: string, ref: string): boolean {
  return fs.existsSync(path.join(resourcesDir, 'images', ...ref.split('/')))
}

function localAudioExists(resourcesDir: string, kind: 'bgm' | 'se', ref: string): boolean {
  return fs.existsSync(path.join(resourcesDir, 'audio', kind, ...ref.split('/')))
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
  if (!ctx.catalog) {
    ctx.logger.warn('[Cloud] catalog unavailable, story assets stay local-only')
    return result
  }

  for (const model of story.models) {
    const ref = model.model
    const cloudEntry = ref.startsWith('cloud/')
      ? (ctx.catalog.models.find(
          (item) =>
            ref === item.path || ref === `cloud/${item.id}` || ref.startsWith(`cloud/${item.id}/`)
        ) ?? findCloudModel(ctx.catalog, ref))
      : findCloudModel(ctx.catalog, ref)
    if (localModelExists(ctx.resourcesDir, ref)) {
      if (ref.startsWith('cloud/') && cloudEntry) {
        const localPath = path.join(ctx.resourcesDir, 'models', ...ref.split('/'))
        if (modelNeedsRepair(cloudEntry, localPath)) {
          try {
            model.model = await ensureModel(cloudEntry, ctx)
            result.models++
          } catch (error) {
            ctx.logger.warn(`[Cloud] 模型 ${ref} 动作补全失败，保留本地缓存：${String(error)}`)
          }
        }
      }
      continue
    }
    if (!cloudEntry) {
      result.missing.push(`model:${ref}`)
      continue
    }
    try {
      model.model = await ensureModel(cloudEntry, ctx)
      result.models++
    } catch (error) {
      ctx.logger.error(`[Cloud] 模型 ${ref} 物化失败：${String(error)}`)
      result.missing.push(`model:${ref}`)
    }
  }

  for (const image of story.images) {
    const ref = image.image
    if (localImageExists(ctx.resourcesDir, ref)) continue
    const entry = findCloudBackground(ctx.catalog, ref)
    if (!entry) {
      result.missing.push(`image:${ref}`)
      continue
    }
    try {
      image.image = await ensureBackground(entry, ctx)
      result.images++
    } catch (error) {
      ctx.logger.error(`[Cloud] 背景 ${ref} 物化失败：${String(error)}`)
      result.missing.push(`image:${ref}`)
    }
  }

  const neededInapp = new Set<string>()
  const modelById = new Map(story.models.map((m) => [m.id, m]))

  for (const snippet of story.snippets) {
    if (snippet.type === 'ChangeBgm') {
      if (snippet.data.stop) continue
      const ref = snippet.data.file
      if (!ref || localAudioExists(ctx.resourcesDir, 'bgm', ref)) continue
      const entry = findCloudBgm(ctx.catalog, ref)
      if (!entry) {
        result.missing.push(`bgm:${ref}`)
        continue
      }
      try {
        snippet.data.file = await ensureBgm(entry, ctx)
        result.bgm++
      } catch (error) {
        ctx.logger.error(`[Cloud] BGM ${ref} 物化失败：${String(error)}`)
        result.missing.push(`bgm:${ref}`)
      }
      continue
    }

    if (snippet.type === 'PlaySe' || snippet.type === 'StopSe') {
      const ref = snippet.data.file
      if (!ref || localAudioExists(ctx.resourcesDir, 'se', ref)) continue
      try {
        const resolved = await ensureSe(ref, ctx)
        if (resolved) {
          snippet.data.file = resolved
          result.se++
        } else {
          result.missing.push(`se:${ref}`)
        }
      } catch (error) {
        ctx.logger.error(`[Cloud] SE ${ref} 物化失败：${String(error)}`)
        result.missing.push(`se:${ref}`)
      }
      continue
    }

    if (snippet.type === 'CostumeChange') {
      const targetModel = modelById.get(snippet.data.modelId)
      const costumeRef = targetModel?.costumes?.[snippet.data.costume] ?? snippet.data.costume
      if (costumeRef) {
        const entry = findCloudModel(ctx.catalog, costumeRef)
        const isLocal = localModelExists(ctx.resourcesDir, costumeRef)
        if (entry && (!isLocal || (costumeRef.startsWith('cloud/') && modelNeedsRepair(entry, path.join(ctx.resourcesDir, 'models', ...costumeRef.split('/')))))) {
          try {
            const resolved = await ensureModel(entry, ctx)
            if (targetModel) {
              targetModel.costumes = {
                ...(targetModel.costumes ?? {}),
                [snippet.data.costume]: resolved
              }
            }
            result.models++
          } catch (error) {
            ctx.logger.error(`[Cloud] 服装模型 ${costumeRef} 物化失败：${String(error)}`)
          }
        }
      }
      continue
    }

    if (snippet.type === 'SekaiIn' || snippet.type === 'SekaiOut') {
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

  const isLocalTestMock = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(
    ctx.settings.assetBase || ''
  )
  if (neededInapp.size > 0 && !isLocalTestMock) {
    await ensureInappUiAssets(ctx, {
      paths: [...neededInapp],
      timeoutMs: Math.min(ctx.settings.timeoutMs, 5_000),
      retries: 0
    }).catch(() => undefined)
  }

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
