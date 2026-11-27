import fs from 'node:fs'
import path from 'node:path'
import type { AssetsSettings } from '../config'
import {
  assetUrl,
  atomicWrite,
  fetchJson,
  request,
  withSlash,
  writeFileFastAsync,
  type RequestOptions
} from './http'
import { mapPool, MOTION_BUNDLES_SIDECAR } from './shared'
import { appendModelsManifest, readModelsManifest, type ModelManifestEntry } from './manifest'
import { buildMoc3BindingResolver, convertAnyMotion, type Moc3BindingResolver } from './motion3'
import { characterById, CHARACTERS, resolveCharacterToken } from './names'

export type AssetRegion = AssetsSettings['region']

export const CANONICAL_ASSET_SITES = [
  'https://storage.pjsk.moe',
  'https://storage.exmeaning.com'
] as const

export interface MoesekaiIndexEntry {
  id: string
  /** `live2d/model/<id>` */
  bundle: string
  /** 默认动作包 `live2d/motion/<x>_motion_base`；null 表示没有动作 */
  motion: string | null
  motions?: string[]
  kind?: 'character' | 'sub' | 'mob'
  characterId?: number | null
  character2dIds?: number[]
  unit?: string
  bytes?: number
  files?: number
  textures?: number
  /** sekai-serve canonical 资产名（如 live2d/model/.../buildmodeldata） */
  canonicalAsset?: string
  /** sekai-serve canonical 动作包资产名映射 */
  canonicalMotionAssets?: Record<string, string>
}

export interface MoesekaiIndex {
  format: number
  region?: string
  generatedAt?: string
  library?: string
  assetVersion?: string
  models: MoesekaiIndexEntry[]
}

interface RipperFile {
  path: string
  kind?: string
  container?: string
  canonicalUrl?: string
  storageUrl?: string
}

interface RipperManifest {
  format?: string
  version?: number
  bundle?: string
  files: RipperFile[]
  canonicalBase?: string
  canonicalAsset?: string
  members?: CanonicalAssetMember[]
}

interface CanonicalFormAsset {
  name: string
  fingerprint?: string
  size?: number
}

interface CanonicalFormListing {
  format?: string
  version?: number
  published_version?: string
  form?: string
  assets?: CanonicalFormAsset[]
}

interface CanonicalDirectoryListing {
  format?: string
  version?: number
  published_version?: string
  directories?: string[]
  files?: Array<{ name: string; extension?: string; size?: number }>
}

interface CanonicalAssetMember {
  role: string
  sha256?: string
  size?: number
  extension: string
  media_type?: string
}

interface CanonicalAssetDocument {
  format?: string
  version?: number
  name?: string
  form?: string
  members?: CanonicalAssetMember[]
}

export interface FetchAssetsOptions {
  /** 资源根（默认 <repo>/resources） */
  outDir: string
  /** 动作包缓存目录（可断点续传） */
  cacheDir?: string
  region?: AssetRegion
  indexBase?: string
  libraryBase?: string
  concurrency?: number
  timeoutMs?: number
  retries?: number
  force?: boolean
  dryRun?: boolean
  characters?: string[]
  models?: string[]
  onProgress?: (message: string) => void
}

export interface FetchedModel {
  id: string
  name: string
  shortName: string
  /** 相对资源根 models/ 的 model3.json 路径 */
  path: string
  motions: number
  facials: number
  bytes: number
}

export interface FetchAssetsResult {
  region: AssetRegion
  indexUrl: string
  selected: Array<{ id: string; name: string }>
  models: FetchedModel[]
  skipped: string[]
  added: ModelManifestEntry[]
  errors: Array<{ id: string; error: string }>
}

const DEFAULT_CONCURRENCY = 6
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_RETRIES = 2

async function fetchBuffer(url: string, options: RequestOptions): Promise<Buffer> {
  const response = await request(url, options)
  return Buffer.from(await response.arrayBuffer())
}

const bundleLocks = new Map<string, Promise<void>>()

/** 同一个动作包被多个服装共用时只下载一次。 */
async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = bundleLocks.get(key) ?? Promise.resolve()
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.then(() => gate)
  bundleLocks.set(key, queued)
  await previous
  try {
    return await fn()
  } finally {
    release()
    if (bundleLocks.get(key) === queued) bundleLocks.delete(key)
  }
}

const REGIONS = new Set<string>(['jp', 'cn', 'tw', 'kr', 'en'])
const MAIN_CHARACTER_PREFIX_RE = /^(?:v2_)?(?:clb\d+_)?(0[1-9]|1\d|2[0-6])[a-z]+/
const MODEL_FORM_ASSET_RE = /^live2d\/model\/([^/]+)(?:\/.+)?$/
const MOTION_FORM_ASSET_RE = /^live2d\/motion\/([^/]+)(?:\/.+)?$/

interface CanonicalFormCacheEntry {
  version: string
  models: Map<string, { assetName: string; size?: number }>
  motions: Map<string, { assetName: string; size?: number }>
}

const canonicalFormCache = new Map<string, CanonicalFormCacheEntry>()

export function isLegacyDeadMoesekaiUrl(url: string): boolean {
  return /assets\.pjsk\.moe\/sekai-extra-assets\//i.test(url)
}

function isCanonicalSiteHost(url: string): boolean {
  return /^https?:\/\/(storage\.pjsk\.moe|storage\.exmeaning\.com)(\/|$)/i.test(url.trim())
}

function canonicalSitesFor(preferredUrl?: string): string[] {
  const trimmed = (preferredUrl ?? '').trim()
  if (trimmed && isCanonicalSiteHost(trimmed)) {
    const origin = new URL(trimmed).origin
    return [origin, ...CANONICAL_ASSET_SITES.filter((site) => site !== origin)]
  }
  return [...CANONICAL_ASSET_SITES]
}

function parseCanonicalLibraryRoot(
  libraryRoot: string
): { site: string; region: AssetRegion; version?: string } | null {
  const trimmed = libraryRoot.trim()
  if (!trimmed) return null
  if (isLegacyDeadMoesekaiUrl(trimmed)) {
    const regionMatch = /\/ripper\/(jp|cn|tw|kr|en)\b/i.exec(trimmed)
    const region = (regionMatch?.[1]?.toLowerCase() ?? 'jp') as AssetRegion
    return { site: CANONICAL_ASSET_SITES[0], region }
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  const match = /^\/(jp|cn|tw|kr|en)(?:@([^/]+))?\/?$/.exec(url.pathname)
  if (match && REGIONS.has(match[1])) {
    return {
      site: url.origin,
      region: match[1] as AssetRegion,
      ...(match[2] ? { version: decodeURIComponent(match[2]) } : {})
    }
  }
  if (isCanonicalSiteHost(trimmed)) {
    const seg = url.pathname.replace(/^\/+/, '').split('/')[0]?.split('@')[0]?.toLowerCase()
    const region = (seg && REGIONS.has(seg) ? seg : 'jp') as AssetRegion
    return { site: url.origin, region }
  }
  return null
}

function isBuildDataLeaf(assetName: string): boolean {
  const leaf = assetName.split('/').pop() ?? ''
  return /^build\w*data$/i.test(leaf)
}

function preferCanonicalAsset(existing: string | undefined, candidate: string): string {
  if (!existing) return candidate
  const existingBuild = isBuildDataLeaf(existing)
  const candidateBuild = isBuildDataLeaf(candidate)
  if (candidateBuild !== existingBuild) return candidateBuild ? candidate : existing
  return candidate.length < existing.length ? candidate : existing
}

export function live2dMotionSetCandidateNames(modelId: string): string[] {
  const id = modelId.trim()
  if (!id) return []
  const generation = id.startsWith('v2_') ? 'v2_' : ''
  const rest = id.slice(generation.length)
  const prefixes = generation ? [generation, ''] : ['']
  const trimmed = (stem: string): string => stem.replace(/(?:black\d*|young|\d+)+$/, '')
  const character = /^(?:clb\d+_)?(\d{2}[a-z]+)/.exec(rest)
  const parts = rest.split('_')
  const stems = character
    ? [character[1], trimmed(character[1])]
    : parts.flatMap((_, index) => {
        const stem = parts.slice(0, parts.length - index).join('_')
        const stripped = trimmed(stem)
        return stripped && stripped !== stem ? [stem, stripped] : [stem]
      })

  const out: string[] = []
  const seen = new Set<string>()
  for (const stem of stems) {
    if (!stem || stem === 'sub') continue
    for (const prefix of prefixes) {
      const name = `${prefix}${stem}_motion_base`
      if (!seen.has(name)) {
        seen.add(name)
        out.push(name)
      }
    }
  }
  return out
}

function parseCharacterIdFromModelId(id: string): number | null {
  const match = MAIN_CHARACTER_PREFIX_RE.exec(id)
  return match ? Number(match[1]) : null
}

function indexUrlFor(settings: AssetsSettings, region: AssetRegion): string {
  return `${withSlash(settings.indexBase)}${region}/models.json`
}

export function libraryRootFor(
  index: MoesekaiIndex,
  settings: AssetsSettings,
  region: AssetRegion
): string {
  const lib = index.library?.trim() ?? ''
  if (lib && !isLegacyDeadMoesekaiUrl(lib)) {
    if (parseCanonicalLibraryRoot(lib)) {
      return withSlash(lib)
    }
    // 旧版 index.library 是区服目录（<base>/<region>/），实际文件在它的 library/ 下
    return withSlash(`${withSlash(lib)}library`)
  }
  const cfgLib = settings.libraryBase?.trim() ?? ''
  if (cfgLib && !isLegacyDeadMoesekaiUrl(cfgLib) && !isCanonicalSiteHost(cfgLib)) {
    return withSlash(`${withSlash(cfgLib)}${region}/library`)
  }
  return `${CANONICAL_ASSET_SITES[0]}/${region}/`
}

async function fetchCanonicalListingsOnSite(
  site: string,
  region: AssetRegion,
  options: RequestOptions
): Promise<{
  version: string
  models: Map<string, { assetName: string; size?: number }>
  motions: Map<string, { assetName: string; size?: number }>
  indexUrl: string
}> {
  const modelListingUrl = `${site}/listings/${region}/canonical/live2d-model`
  const motionListingUrl = `${site}/listings/${region}/canonical/live2d-motions`

  const [modelListing, motionListing] = await Promise.all([
    fetchJson<CanonicalFormListing>(modelListingUrl, options),
    fetchJson<CanonicalFormListing>(motionListingUrl, options).catch(() => null)
  ])

  if (modelListing.format !== 'form-listing' || !Array.isArray(modelListing.assets)) {
    throw new Error(`${modelListingUrl}: invalid form-listing`)
  }

  const models = new Map<string, { assetName: string; size?: number }>()
  for (const item of modelListing.assets) {
    const match = MODEL_FORM_ASSET_RE.exec(item.name)
    if (!match) continue
    const id = match[1]
    const prev = models.get(id)
    const preferred = preferCanonicalAsset(prev?.assetName, item.name)
    if (!prev || preferred === item.name) {
      models.set(id, { assetName: preferred, size: item.size })
    }
  }

  const motions = new Map<string, { assetName: string; size?: number }>()
  if (motionListing?.format === 'form-listing' && Array.isArray(motionListing.assets)) {
    for (const item of motionListing.assets) {
      const match = MOTION_FORM_ASSET_RE.exec(item.name)
      if (!match) continue
      const setId = match[1]
      const prev = motions.get(setId)
      const preferred = preferCanonicalAsset(prev?.assetName, item.name)
      if (!prev || preferred === item.name) {
        motions.set(setId, { assetName: preferred, size: item.size })
      }
    }
  } else {
    const dirListing = await fetchJson<CanonicalDirectoryListing>(
      `${site}/${region}/live2d/motion/`,
      options
    ).catch(() => null)
    for (const setId of dirListing?.directories ?? []) {
      motions.set(setId, { assetName: '' })
    }
  }

  const version = modelListing.published_version || motionListing?.published_version || ''
  canonicalFormCache.set(`${site}|${region}`, { version, models, motions })
  return { version, models, motions, indexUrl: modelListingUrl }
}

async function ensureCanonicalFormCache(
  site: string,
  region: AssetRegion,
  options: RequestOptions
): Promise<CanonicalFormCacheEntry> {
  const key = `${site}|${region}`
  const cached = canonicalFormCache.get(key)
  if (cached && cached.models.size > 0 && cached.motions.size > 0) return cached
  const fetched = await fetchCanonicalListingsOnSite(site, region, options)
  return { version: fetched.version, models: fetched.models, motions: fetched.motions }
}

export async function loadMoesekaiIndex(
  settings: AssetsSettings,
  region: AssetRegion = settings.region,
  options: { timeoutMs?: number; retries?: number; signal?: AbortSignal } = {}
): Promise<{ index: MoesekaiIndex; indexUrl: string }> {
  const requestOptions: RequestOptions = {
    timeoutMs: options.timeoutMs ?? settings.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retries: options.retries ?? settings.retries ?? DEFAULT_RETRIES,
    signal: options.signal
  }

  const configuredBase = settings.indexBase?.trim() ?? ''
  if (
    configuredBase &&
    !isLegacyDeadMoesekaiUrl(configuredBase) &&
    !isCanonicalSiteHost(configuredBase)
  ) {
    const indexUrl = indexUrlFor(settings, region)
    const index = await fetchJson<MoesekaiIndex>(indexUrl, requestOptions)
    if (index.format !== 1 || !Array.isArray(index.models)) {
      throw new Error(`${indexUrl}: unsupported model index format`)
    }
    return { index, indexUrl }
  }

  const sites = canonicalSitesFor(configuredBase)
  let lastError: unknown = null
  for (const site of sites) {
    try {
      const { version, models, motions, indexUrl } = await fetchCanonicalListingsOnSite(
        site,
        region,
        requestOptions
      )
      const motionSetIds = new Set(motions.keys())
      const entries: MoesekaiIndexEntry[] = []
      for (const [id, info] of [...models.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const characterId = parseCharacterIdFromModelId(id)
        const kind: 'character' | 'sub' | 'mob' =
          characterId !== null ? 'character' : /^(?:v2_)?sub_/.test(id) ? 'sub' : 'mob'
        const candidateNames = live2dMotionSetCandidateNames(id)
        const matchedSets = candidateNames.filter((name) => motionSetIds.has(name))
        const motionBundles = matchedSets.map((name) => `live2d/motion/${name}`)
        const canonicalMotionAssets: Record<string, string> = {}
        for (const name of matchedSets) {
          const mInfo = motions.get(name)
          if (mInfo?.assetName) canonicalMotionAssets[`live2d/motion/${name}`] = mInfo.assetName
        }
        entries.push({
          id,
          bundle: `live2d/model/${id}`,
          motion: motionBundles[0] ?? null,
          motions: motionBundles,
          kind,
          characterId,
          ...(typeof info.size === 'number' ? { bytes: info.size } : {}),
          canonicalAsset: info.assetName,
          ...(Object.keys(canonicalMotionAssets).length > 0 ? { canonicalMotionAssets } : {})
        })
      }
      const library = version
        ? `${site}/${region}@${encodeURIComponent(version)}/`
        : `${site}/${region}/`
      return {
        index: {
          format: 1,
          region,
          library,
          ...(version ? { assetVersion: version } : {}),
          models: entries
        },
        indexUrl
      }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? 'failed to load model index'))
}

const COSTUME_ORDER = [
  'normal',
  'casual',
  'school',
  'unit',
  'sports',
  'pajamas',
  'parttime',
  'lesson',
  'swim',
  'jc',
  'culture',
  'yukata',
  'christmas',
  'wedding',
  'tuxedo',
  'april'
]

function generationOf(id: string): number {
  return id.startsWith('v2_') ? 2 : 1
}

function costumeRank(id: string): number {
  const rest = id.replace(/^v2_/, '')
  if (/^clb\d+_/.test(rest) || rest.startsWith('sub_')) return 1000
  const match = /^\d{2}[a-z]+_(.+)$/.exec(rest)
  if (!match) return 900
  const first = match[1].split('_')[0].replace(/\d+$/, '')
  const index = COSTUME_ORDER.indexOf(first)
  return index === -1 ? 500 : index
}

function preferredModel(models: MoesekaiIndexEntry[]): MoesekaiIndexEntry | null {
  if (models.length === 0) return null
  return [...models].sort((a, b) => {
    const collabA = /^clb\d+_/.test(a.id.replace(/^v2_/, '')) ? 1 : 0
    const collabB = /^clb\d+_/.test(b.id.replace(/^v2_/, '')) ? 1 : 0
    return (
      collabA - collabB ||
      generationOf(a.id) - generationOf(b.id) ||
      costumeRank(a.id) - costumeRank(b.id) ||
      a.id.localeCompare(b.id)
    )
  })[0]
}

function kindOf(entry: MoesekaiIndexEntry): 'character' | 'sub' | 'mob' {
  if (entry.kind === 'character' || entry.kind === 'sub' || entry.kind === 'mob') return entry.kind
  if (typeof entry.characterId === 'number') return 'character'
  if (entry.id.replace(/^v2_/, '').startsWith('sub_')) return 'sub'
  return 'mob'
}

export interface SelectModelsOptions {
  characters?: string[]
  models?: string[]
  /** true 时返回全部常规服装变体（含 v2 / 校服 / 私服 / 队服 / 演出服等），而非每角只挑 1 套 */
  allOutfits?: boolean
  /** true 时把带动作包的 sub 角色也纳入选择 */
  includeSub?: boolean
  /** 额外纳入的知名配角/mob 模型 id 集合 */
  notableIds?: Set<string>
  /** 是否保留 _black 剪影模型（默认跳过） */
  includeBlack?: boolean
}

function isBlackSilhouette(id: string): boolean {
  return /black\d*$/i.test(id)
}

/**
 * 按 `--characters` / `--models` 选模型。
 * - 默认：每个角色挑一套首选服装（v1 normal → v1 casual → …）
 * - allOutfits=true：返回角色的全部常规服装变体（首选服装排在最前）
 * - models：精确模型 id（含 v2_ / clb / sub / mob）
 */
export function selectModels(
  index: MoesekaiIndex,
  options: SelectModelsOptions
): MoesekaiIndexEntry[] {
  const selected = new Map<string, MoesekaiIndexEntry>()

  if (options.models?.length) {
    for (const id of options.models) {
      const entry = index.models.find((model) => model.id === id)
      if (!entry) throw new Error(`model not found in index: ${id}`)
      selected.set(entry.id, entry)
    }
  }

  if (options.characters?.length) {
    const ids = new Set<number>()
    const unmatched: string[] = []
    let selectAll = false
    for (const token of options.characters) {
      if (token.toLowerCase() === 'all') {
        selectAll = true
        for (const character of CHARACTERS) ids.add(character.characterId)
        continue
      }
      const characterId = resolveCharacterToken(token)
      if (characterId !== null) {
        ids.add(characterId)
        continue
      }
      // 也允许直接写模型 id 片段（例如 20mizuki_normal）
      const matches = index.models.filter(
        (model) =>
          kindOf(model) === 'character' && model.id.toLowerCase().includes(token.toLowerCase())
      )
      if (matches.length === 0) {
        unmatched.push(token)
        continue
      }
      for (const entry of matches) selected.set(entry.id, entry)
    }
    if (unmatched.length > 0) {
      throw new Error(
        `unknown character(s): ${unmatched.join(', ')}（可用：${CHARACTERS.map((c) => c.keys[0]).join(', ')}）`
      )
    }
    for (const characterId of ids) {
      const candidates = index.models.filter(
        (model) =>
          kindOf(model) === 'character' &&
          model.characterId === characterId &&
          (options.includeBlack || !isBlackSilhouette(model.id))
      )
      const best = preferredModel(candidates)
      if (best) selected.set(best.id, best)
      if (options.allOutfits) {
        const sorted = [...candidates].sort((a, b) => {
          const collabA = /^clb\d+_/.test(a.id.replace(/^v2_/, '')) ? 1 : 0
          const collabB = /^clb\d+_/.test(b.id.replace(/^v2_/, '')) ? 1 : 0
          return (
            collabA - collabB ||
            costumeRank(a.id) - costumeRank(b.id) ||
            generationOf(a.id) - generationOf(b.id) ||
            a.id.localeCompare(b.id)
          )
        })
        for (const entry of sorted) selected.set(entry.id, entry)
      }
    }
    if (selectAll && (options.includeSub || options.notableIds?.size)) {
      for (const model of index.models) {
        if (!options.includeBlack && isBlackSilhouette(model.id)) continue
        const kind = kindOf(model)
        const hasMotions = Boolean(model.motion || model.motions?.length)
        if (options.notableIds?.has(model.id)) {
          selected.set(model.id, model)
        } else if (options.includeSub && kind === 'sub' && hasMotions) {
          selected.set(model.id, model)
        }
      }
    }
  }

  return [...selected.values()]
}

async function fetchCanonicalAssetDocument(
  sites: string[],
  region: AssetRegion,
  version: string | undefined,
  bundle: string,
  options: RequestOptions
): Promise<{ site: string; baseUrl: string; assetName: string; doc: CanonicalAssetDocument }> {
  const isModel = bundle.startsWith('live2d/model/')
  const isMotion = bundle.startsWith('live2d/motion/')
  const id = bundle.split('/')[2] ?? ''
  let lastError: unknown = null

  for (const site of sites) {
    try {
      const formCache = await ensureCanonicalFormCache(site, region, options)
      const effectiveVer = version || formCache.version
      const baseUrl = effectiveVer
        ? `${site}/${region}@${encodeURIComponent(effectiveVer)}`
        : `${site}/${region}`

      let assetName = isModel
        ? formCache.models.get(id)?.assetName
        : isMotion
          ? formCache.motions.get(id)?.assetName
          : undefined

      if (!assetName) {
        // 回退到目录逐级查找 build*data.asset.json
        let dirPath = bundle.replace(/\/+$/, '') + '/'
        for (let depth = 0; depth < 8; depth++) {
          const listing = await fetchJson<CanonicalDirectoryListing>(
            `${baseUrl}/${dirPath}`,
            options
          )
          const assetFile = (listing.files ?? []).find((f) => f.name.endsWith('.asset.json'))
          if (assetFile) {
            assetName = `${dirPath}${assetFile.name.slice(0, -'.asset.json'.length)}`
            break
          }
          const nextDir = (listing.directories ?? [])[0]
          if (!nextDir) break
          dirPath += `${nextDir}/`
        }
      }

      if (!assetName) {
        throw new Error(`${baseUrl}/${bundle}: canonical .asset.json not found`)
      }

      const docUrl = assetUrl(baseUrl, `${assetName}.asset.json`)
      const doc = await fetchJson<CanonicalAssetDocument>(docUrl, options)
      if (doc.format !== 'asset' || !Array.isArray(doc.members)) {
        throw new Error(`${docUrl}: invalid canonical asset document`)
      }
      return { site, baseUrl, assetName: doc.name || assetName, doc }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? `canonical asset failed: ${bundle}`))
}

export async function ripperManifest(
  libraryRoot: string,
  bundle: string,
  options: RequestOptions
): Promise<RipperManifest> {
  const canonical = parseCanonicalLibraryRoot(libraryRoot)
  if (canonical) {
    const sites = canonicalSitesFor(canonical.site)
    const { site, baseUrl, assetName, doc } = await fetchCanonicalAssetDocument(
      sites,
      canonical.region,
      canonical.version,
      bundle,
      options
    )
    const members = doc.members ?? []
    const files: RipperFile[] = []

    if (bundle.startsWith('live2d/motion/')) {
      for (const member of members) {
        if (!member.role.startsWith('motion/') && !member.role.startsWith('facial/')) continue
        files.push({
          path: `${member.role}.sse-motion.json`,
          kind: 'live2d-motion',
          canonicalUrl: assetUrl(
            baseUrl,
            `${assetName}/${member.role}.${member.extension || 'json'}`
          )
        })
      }
      return {
        format: 'sekai-serve-canonical',
        version: 1,
        bundle,
        files,
        canonicalBase: baseUrl,
        canonicalAsset: assetName,
        members
      }
    }

    // live2d/model/<id>: 先查 storage 视图取真实 .model3.json 名（保留版本后缀以对齐已有静态路径）
    const storageListing = await fetchJson<CanonicalDirectoryListing>(
      `${site}/sekai-${canonical.region}-assets/${bundle}/`,
      options
    ).catch(() => null)
    const model3Storage = storageListing?.files?.find((f) => f.name.endsWith('.model3.json'))
    const modelId = bundle.split('/')[2] ?? 'model'
    const model3Name = model3Storage?.name ?? `${modelId}.model3.json`
    files.push({
      path: model3Name,
      kind: 'model3',
      ...(model3Storage
        ? {
            storageUrl: assetUrl(
              `${site}/sekai-${canonical.region}-assets/`,
              `${bundle}/${model3Storage.name}`
            )
          }
        : {})
    })
    for (const member of members) {
      files.push({
        path: `${member.role}.${member.extension}`,
        kind: member.role,
        canonicalUrl: assetUrl(baseUrl, `${assetName}/${member.role}.${member.extension}`)
      })
    }
    return {
      format: 'sekai-serve-canonical',
      version: 1,
      bundle,
      files,
      canonicalBase: baseUrl,
      canonicalAsset: assetName,
      members
    }
  }

  const url = assetUrl(libraryRoot, `${bundle}/_ripper.json`)
  const manifest = await fetchJson<RipperManifest>(url, options)
  if (!Array.isArray(manifest.files)) {
    throw new Error(`${url}: invalid ripper manifest`)
  }
  return manifest
}

async function fileExistsNonEmptyAsync(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath)
    return stat.size > 0
  } catch {
    return false
  }
}

function isIndividualMotionClipFile(file: RipperFile): boolean {
  return (
    file.kind === 'live2d-motion' ||
    file.path.endsWith('.sse-motion.json') ||
    file.path.endsWith('.live2d-motion.json')
  )
}

async function downloadBundle(
  libraryRoot: string,
  bundle: string,
  destDir: string,
  options: RequestOptions & { force?: boolean; concurrency?: number }
): Promise<{ files: number; bytes: number }> {
  const manifest = await ripperManifest(libraryRoot, bundle, options)
  const isCanonical = manifest.format === 'sekai-serve-canonical'
  const files = manifest.files.filter(
    (file) => typeof file.path === 'string' && file.path.length > 0
  )
  let downloaded = 0
  let bytes = 0

  await mapPool(
    files,
    options.concurrency ?? (isCanonical ? 12 : DEFAULT_CONCURRENCY),
    async (file) => {
      const targetRel =
        isCanonical && file.kind === 'live2d-motion'
          ? file.path.replace(/\.sse-motion\.json$/, '.live2d-motion.json')
          : file.path
      const dest = path.join(destDir, ...targetRel.split('/'))
      if (!options.force && (await fileExistsNonEmptyAsync(dest))) return
      const url =
        file.canonicalUrl ?? file.storageUrl ?? assetUrl(libraryRoot, `${bundle}/${file.path}`)
      const data = await fetchBuffer(url, options)
      if (isIndividualMotionClipFile(file)) {
        await writeFileFastAsync(dest, data)
      } else {
        atomicWrite(dest, data)
      }
      downloaded += 1
      bytes += data.length
    }
  )

  return { files: downloaded, bytes }
}

function safeClipName(name: string): string {
  const cleaned = name.trim().replace(/[^\w.-]+/g, '_')
  return cleaned || 'motion'
}

function displayFor(entry: MoesekaiIndexEntry): { name: string; shortName: string } {
  const character = characterById(entry.characterId ?? null)
  return character
    ? { name: character.name, shortName: character.shortName }
    : { name: entry.id, shortName: entry.id }
}

interface Model3JsonShape {
  Version?: number
  FileReferences?: {
    Moc?: string
    Textures?: string[]
    Physics?: string
    Motions?: Record<string, Array<{ File: string; FadeInTime: number; FadeOutTime: number }>>
  }
  Groups?: Array<{ Target: string; Name: string; Ids: string[] }>
}

async function downloadCanonicalModelBundle(
  entry: MoesekaiIndexEntry,
  manifest: RipperManifest,
  modelsDir: string,
  options: RequestOptions & { force?: boolean; concurrency?: number },
  progress: (message: string) => void
): Promise<{
  destDir: string
  modelJsonPath: string
  mocBuffer: Buffer
  bytes: number
}> {
  const model3File = manifest.files.find((file) => file.path.endsWith('.model3.json'))
  if (!model3File) {
    throw new Error(`${entry.id}: no .model3.json in ${entry.bundle}`)
  }
  const variant = path.basename(model3File.path, '.model3.json')
  const destDir = path.join(modelsDir, entry.id, variant)
  const modelJsonPath = path.join(destDir, model3File.path)
  progress(`模型 ${entry.id} → ${path.relative(modelsDir, destDir)}`)

  let bytes = 0
  let model3: Model3JsonShape | null = null
  if (!options.force && fs.existsSync(modelJsonPath)) {
    try {
      model3 = JSON.parse(fs.readFileSync(modelJsonPath, 'utf-8')) as Model3JsonShape
    } catch {
      model3 = null
    }
  }
  if (!model3 && model3File.storageUrl) {
    try {
      const buf = await fetchBuffer(model3File.storageUrl, options)
      bytes += buf.length
      model3 = JSON.parse(buf.toString('utf-8')) as Model3JsonShape
    } catch {
      model3 = null
    }
  }

  const members = manifest.members ?? []
  const mocMember = members.find((m) => m.role === 'moc')
  if (!mocMember) throw new Error(`${entry.id}: missing moc member in canonical asset`)
  const physicsMember = members.find((m) => m.role === 'physics')
  const textureMembers = members
    .filter((m) => /^texture\/\d+$/.test(m.role))
    .sort((a, b) => Number(a.role.split('/')[1]) - Number(b.role.split('/')[1]))

  if (!model3) {
    model3 = {
      Version: 3,
      FileReferences: {
        Moc: `${variant}.moc3`,
        Textures: textureMembers.map(
          (_, idx) => `${variant}.2048/texture_${String(idx).padStart(2, '0')}.png`
        ),
        ...(physicsMember ? { Physics: `${variant}.physics3.json` } : {})
      },
      Groups: [
        { Target: 'Parameter', Name: 'EyeBlink', Ids: [] },
        { Target: 'Parameter', Name: 'LipSync', Ids: [] }
      ]
    }
  }

  const refs = model3.FileReferences ?? {}
  const mocRel = refs.Moc || `${variant}.moc3`
  const mocDest = path.join(destDir, ...mocRel.split('/'))
  let mocBuffer: Buffer
  if (!options.force && fs.existsSync(mocDest)) {
    mocBuffer = fs.readFileSync(mocDest)
  } else {
    const mocFile = manifest.files.find((f) => f.kind === 'moc')
    if (!mocFile?.canonicalUrl) throw new Error(`${entry.id}: missing moc URL`)
    mocBuffer = await fetchBuffer(mocFile.canonicalUrl, options)
    atomicWrite(mocDest, mocBuffer)
    bytes += mocBuffer.length
  }

  const downloads: Array<{ url: string; dest: string }> = []
  if (physicsMember) {
    const phyRel = refs.Physics || `${variant}.physics3.json`
    const phyFile = manifest.files.find((f) => f.kind === 'physics')
    if (phyFile?.canonicalUrl) {
      downloads.push({ url: phyFile.canonicalUrl, dest: path.join(destDir, ...phyRel.split('/')) })
    }
  }
  for (let i = 0; i < textureMembers.length; i++) {
    const texRel = refs.Textures?.[i] ?? `${variant}.2048/texture_${String(i).padStart(2, '0')}.png`
    const texFile = manifest.files.find((f) => f.kind === textureMembers[i].role)
    if (texFile?.canonicalUrl) {
      downloads.push({ url: texFile.canonicalUrl, dest: path.join(destDir, ...texRel.split('/')) })
    }
  }

  await mapPool(downloads, options.concurrency ?? DEFAULT_CONCURRENCY, async (item) => {
    if (!options.force && fs.existsSync(item.dest)) return
    const buf = await fetchBuffer(item.url, options)
    atomicWrite(item.dest, buf)
    bytes += buf.length
  })

  atomicWrite(modelJsonPath, JSON.stringify(model3, null, 2))
  return { destDir, modelJsonPath, mocBuffer, bytes }
}

function resolveMotionBundles(entry: MoesekaiIndexEntry): {
  required: string[]
  optional: string[]
} {
  const raw = (
    entry.motions?.length ? entry.motions : entry.motion ? [entry.motion] : []
  ).filter((bundle): bundle is string => typeof bundle === 'string' && bundle.length > 0)
  const required = [...new Set(raw)]
  const seen = new Set(required)
  const isV2 =
    entry.id.startsWith('v2_') || required.some((bundle) => bundle.startsWith('live2d/motion/v2_'))
  const optional: string[] = []
  if (isV2) {
    for (const candidate of live2dMotionSetCandidateNames(entry.id)) {
      if (candidate.startsWith('v2_')) continue
      const bundle = `live2d/motion/${candidate}`
      if (!seen.has(bundle)) {
        seen.add(bundle)
        optional.push(bundle)
      }
    }
  }
  return { required, optional }
}

/**
 * 下载一个模型包及其动作包，并把动作写成 model3.json 可加载的 `motions/*.motion3.json`。
 *
 * 目录布局与现有资源一致：
 *   models/<模型 id>/<model3 文件名去后缀>/<model3 文件名>
 *
 * `modelsDir` 传 `resources/models` 时是 fetch:models 的常规落盘；云端按需物化
 * 传 `resources/models/cloud`，两条路径共用同一套下载/动作转换逻辑。
 */
export async function downloadModel(
  entry: MoesekaiIndexEntry,
  libraryRoot: string,
  modelsDir: string,
  options: RequestOptions & { force?: boolean; concurrency?: number; cacheDir: string },
  progress: (message: string) => void
): Promise<FetchedModel> {
  const bundleManifest = await ripperManifest(libraryRoot, entry.bundle, options)
  const isCanonical = bundleManifest.format === 'sekai-serve-canonical'

  let destDir: string
  let modelJsonPath: string
  let downloadedBytes = 0
  let mocResolver: Moc3BindingResolver | undefined

  if (isCanonical) {
    const res = await downloadCanonicalModelBundle(
      entry,
      bundleManifest,
      modelsDir,
      options,
      progress
    )
    destDir = res.destDir
    modelJsonPath = res.modelJsonPath
    downloadedBytes = res.bytes
    mocResolver = buildMoc3BindingResolver(res.mocBuffer)
  } else {
    const model3File = bundleManifest.files.find((file) => file.path.endsWith('.model3.json'))
    if (!model3File) {
      throw new Error(`${entry.id}: no .model3.json in ${entry.bundle}`)
    }
    const variant = path.basename(model3File.path, '.model3.json')
    destDir = path.join(modelsDir, entry.id, variant)
    modelJsonPath = path.join(destDir, ...model3File.path.split('/'))

    progress(`模型 ${entry.id} → ${path.relative(modelsDir, destDir)}`)
    const downloaded = await downloadBundle(libraryRoot, entry.bundle, destDir, options)
    downloadedBytes = downloaded.bytes
  }

  const { required: requiredBundles, optional: optionalBundles } = resolveMotionBundles(entry)

  // 动作包放在持久缓存里：网络中断后重跑只补缺失文件，同角色不同服装共用
  const motionCache = path.join(options.cacheDir, 'motion')
  const motionDirs: string[] = []
  const mergedBundles: string[] = []
  for (const bundle of requiredBundles) {
    const bundleDir = path.join(motionCache, safeClipName(bundle.replace(/^live2d\/motion\//, '')))
    await withKeyLock(`motion:${bundle}`, () =>
      downloadBundle(libraryRoot, bundle, bundleDir, {
        ...options,
        force: false
      })
    )
    motionDirs.push(bundleDir)
    mergedBundles.push(bundle)
  }
  for (const bundle of optionalBundles) {
    const bundleDir = path.join(motionCache, safeClipName(bundle.replace(/^live2d\/motion\//, '')))
    try {
      await withKeyLock(`motion:${bundle}`, () =>
        downloadBundle(libraryRoot, bundle, bundleDir, {
          ...options,
          force: false
        })
      )
      motionDirs.push(bundleDir)
      mergedBundles.push(bundle)
    } catch {
      // 可选基础动作包（如 v2_* 回退到 v1）不存在时忽略，不阻断主流程
    }
  }

  const clips = new Map<string, { filename: string; fadeIn: number; fadeOut: number }>()
  const walk = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return []
    const result: string[] = []
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const item of entries) {
      const full = path.join(dir, item.name)
      if (item.isDirectory()) result.push(...walk(full))
      else if (
        item.name.endsWith('.sse-motion.json') ||
        item.name.endsWith('.live2d-motion.json')
      ) {
        result.push(full)
      }
    }
    return result
  }

  const motionsOutDir = path.join(destDir, 'motions')
  const existingMotionFiles = new Set<string>(
    await fs.promises.readdir(motionsOutDir).catch(() => [])
  )
  const claimedClipNames = new Set<string>()
  const MOTION_CONVERT_CONCURRENCY = 16

  for (const motionDir of motionDirs) {
    const files = walk(motionDir)
    const convertedBatch = await mapPool(files, MOTION_CONVERT_CONCURRENCY, async (file) => {
      let raw: unknown
      try {
        raw = JSON.parse(await fs.promises.readFile(file, 'utf-8'))
      } catch (error) {
        progress(`跳过无法解析的动作 ${path.relative(motionDir, file)}: ${String(error)}`)
        return null
      }
      const fallbackName = path.basename(file).replace(/\.(?:sse-motion|live2d-motion)\.json$/, '')
      let converted
      try {
        converted = convertAnyMotion(raw, mocResolver, fallbackName)
      } catch (error) {
        progress(`跳过无法转换的动作 ${path.relative(motionDir, file)}: ${String(error)}`)
        return null
      }
      if (converted.motion3.Curves.length === 0) return null
      if (claimedClipNames.has(converted.name)) return null
      claimedClipNames.add(converted.name)

      const filename = `${safeClipName(converted.name)}.motion3.json`
      const motionFile = path.join(motionsOutDir, filename)
      const needsWrite =
        Boolean(options.force) ||
        !existingMotionFiles.has(filename) ||
        !(await fileExistsNonEmptyAsync(motionFile))
      if (needsWrite) {
        await writeFileFastAsync(motionFile, JSON.stringify(converted.motion3))
        existingMotionFiles.add(filename)
      }
      return {
        name: converted.name,
        filename,
        fadeIn: converted.fadeIn,
        fadeOut: converted.fadeOut
      }
    })

    // 按排序后的输入索引顺序写入 clips，保证 model3.json 的 Motions 映射顺序完全确定。
    for (const item of convertedBatch) {
      if (!item || clips.has(item.name)) continue
      clips.set(item.name, {
        filename: item.filename,
        fadeIn: item.fadeIn,
        fadeOut: item.fadeOut
      })
    }
  }

  const model3 = JSON.parse(fs.readFileSync(modelJsonPath, 'utf-8')) as Model3JsonShape
  if (!model3.FileReferences) model3.FileReferences = {}
  const existingMotions: NonNullable<Model3JsonShape['FileReferences']>['Motions'] = {}
  for (const [name, list] of Object.entries(model3.FileReferences.Motions ?? {})) {
    const fileRel = Array.isArray(list) ? list[0]?.File : undefined
    if (!fileRel) continue
    const exists = fileRel.startsWith('motions/')
      ? existingMotionFiles.has(fileRel.slice('motions/'.length))
      : fs.existsSync(path.join(destDir, ...fileRel.split('/')))
    if (exists) {
      existingMotions[name] = list
    }
  }
  const motions: Record<
    string,
    Array<{ File: string; FadeInTime: number; FadeOutTime: number }>
  > = {}
  for (const [name, clip] of clips) {
    motions[name] = [
      {
        File: `motions/${clip.filename}`,
        FadeInTime: clip.fadeIn,
        FadeOutTime: clip.fadeOut
      }
    ]
  }
  model3.FileReferences.Motions = {
    ...existingMotions,
    ...motions
  }
  atomicWrite(modelJsonPath, JSON.stringify(model3, null, 2))
  atomicWrite(
    path.join(destDir, MOTION_BUNDLES_SIDECAR),
    JSON.stringify({ version: 1, bundles: mergedBundles }, null, 2)
  )

  const names = [...clips.keys()]
  const facials = names.filter((name) => name.startsWith('face_')).length
  const display = displayFor(entry)

  return {
    id: entry.id,
    name: display.name,
    shortName: display.shortName,
    path: path.relative(modelsDir, modelJsonPath).split(path.sep).join('/'),
    motions: names.length - facials,
    facials,
    bytes: downloadedBytes
  }
}

/**
 * 从 moesekai 拉取模型并转成本宿主可直接渲染的资源目录。
 *
 * 只写 resources/models/<id>/<variant>/ 与 models.yaml；动作源文件在临时目录里
 * 转完即删，不会把 sse-motion 或 buildmotiondata 暴露到静态资源目录。
 */
export async function fetchModels(
  settings: AssetsSettings,
  options: FetchAssetsOptions & { signal?: AbortSignal }
): Promise<FetchAssetsResult> {
  const region = options.region ?? settings.region
  const effective: AssetsSettings = {
    ...settings,
    region,
    indexBase: options.indexBase ?? settings.indexBase,
    libraryBase: options.libraryBase ?? settings.libraryBase,
    cacheDir: options.cacheDir ?? settings.cacheDir,
    concurrency: options.concurrency ?? settings.concurrency,
    timeoutMs: options.timeoutMs ?? settings.timeoutMs,
    retries: options.retries ?? settings.retries
  }
  const progress = options.onProgress ?? (() => undefined)
  const { index, indexUrl } = await loadMoesekaiIndex(effective, region, {
    timeoutMs: effective.timeoutMs,
    retries: effective.retries,
    signal: options.signal
  })
  const libraryRoot = libraryRootFor(index, effective, region)
  const selected = selectModels(index, {
    characters: options.characters,
    models: options.models
  })
  if (selected.length === 0) {
    throw new Error('no models selected; pass --characters or --models')
  }

  const modelsDir = path.join(options.outDir, 'models')
  const manifestPath = path.join(modelsDir, 'models.yaml')
  const existing = readModelsManifest(manifestPath)

  const selectedInfo = selected.map((entry) => ({
    id: entry.id,
    name: characterById(entry.characterId ?? null)?.name ?? entry.id
  }))

  if (options.dryRun) {
    return {
      region,
      indexUrl,
      selected: selectedInfo,
      models: [],
      skipped: [],
      added: [],
      errors: []
    }
  }

  const fetched: FetchedModel[] = []
  const skipped: string[] = []
  const errors: Array<{ id: string; error: string }> = []

  await mapPool(selected, Math.max(1, effective.concurrency), async (entry) => {
    if (options.signal?.aborted) return
    const display = displayFor(entry)
    const already = existing.find((item) => item.path.startsWith(`${entry.id}/`))
    const sameCharacterRegistered =
      Boolean(options.characters?.length) &&
      !options.models?.length &&
      existing.some((item) => item.name === display.name)
    if ((already || sameCharacterRegistered) && !options.force) {
      skipped.push(entry.id)
      progress(`跳过 ${entry.id}（models.yaml 已登记${sameCharacterRegistered ? '同名角色' : ''}）`)
      return
    }
    try {
      const model = await downloadModel(
        entry,
        libraryRoot,
        modelsDir,
        {
          timeoutMs: effective.timeoutMs,
          retries: effective.retries,
          concurrency: effective.concurrency,
          cacheDir: effective.cacheDir,
          force: options.force,
          signal: options.signal
        },
        progress
      )
      fetched.push(model)
      progress(`完成 ${model.id}：${model.motions} 个动作，${model.facials} 个表情`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push({ id: entry.id, error: message })
      progress(`失败 ${entry.id}: ${message}`)
    }
  })

  const added = appendModelsManifest(
    manifestPath,
    fetched.map((model) => ({
      name: model.name,
      shortName: model.shortName,
      path: model.path
    }))
  )

  if (fetched.length === 0 && errors.length > 0 && skipped.length === 0) {
    throw new Error(
      `all models failed: ${errors.map((item) => `${item.id}: ${item.error}`).join('; ')}`
    )
  }

  return {
    region,
    indexUrl,
    selected: selectedInfo,
    models: fetched,
    skipped,
    added,
    errors
  }
}

export { CHARACTERS }
