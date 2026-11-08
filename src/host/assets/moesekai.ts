import fs from 'node:fs'
import path from 'node:path'
import type { AssetsSettings } from '../config'
import { assetUrl, atomicWrite, fetchJson, request, withSlash, type RequestOptions } from './http'
import { appendModelsManifest, readModelsManifest, type ModelManifestEntry } from './manifest'
import { convertSseMotion } from './motion3'
import { characterById, CHARACTERS, resolveCharacterToken } from './names'

export type AssetRegion = AssetsSettings['region']

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
}

interface RipperManifest {
  format?: string
  version?: number
  bundle?: string
  files: RipperFile[]
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
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, run))
  return results
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

function indexUrlFor(settings: AssetsSettings, region: AssetRegion): string {
  return `${withSlash(settings.indexBase)}${region}/models.json`
}

export function libraryRootFor(
  index: MoesekaiIndex,
  settings: AssetsSettings,
  region: AssetRegion
): string {
  // index.library 是区服目录（<base>/<region>/），实际文件在它的 library/ 下
  if (index.library && index.library.trim()) {
    return withSlash(`${withSlash(index.library.trim())}library`)
  }
  return withSlash(`${withSlash(settings.libraryBase)}${region}/library`)
}

export async function loadMoesekaiIndex(
  settings: AssetsSettings,
  region: AssetRegion = settings.region,
  options: { timeoutMs?: number; retries?: number; signal?: AbortSignal } = {}
): Promise<{ index: MoesekaiIndex; indexUrl: string }> {
  const indexUrl = indexUrlFor(settings, region)
  const index = await fetchJson<MoesekaiIndex>(indexUrl, {
    timeoutMs: options.timeoutMs ?? settings.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retries: options.retries ?? settings.retries ?? DEFAULT_RETRIES,
    signal: options.signal
  })
  if (index.format !== 1 || !Array.isArray(index.models)) {
    throw new Error(`${indexUrl}: unsupported model index format`)
  }
  return { index, indexUrl }
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

/**
 * 按 `--characters` / `--models` 选模型。
 * - characters：每个角色挑一套首选服装（v1 normal → v1 casual → …）
 * - models：精确模型 id（含 v2_ / clb / sub / mob）
 */
export function selectModels(
  index: MoesekaiIndex,
  options: { characters?: string[]; models?: string[] }
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
    for (const token of options.characters) {
      if (token.toLowerCase() === 'all') {
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
        (model) => kindOf(model) === 'character' && model.characterId === characterId
      )
      const best = preferredModel(candidates)
      if (best) selected.set(best.id, best)
    }
  }

  return [...selected.values()]
}

export async function ripperManifest(
  libraryRoot: string,
  bundle: string,
  options: RequestOptions
): Promise<RipperManifest> {
  const url = assetUrl(libraryRoot, `${bundle}/_ripper.json`)
  const manifest = await fetchJson<RipperManifest>(url, options)
  if (!Array.isArray(manifest.files)) {
    throw new Error(`${url}: invalid ripper manifest`)
  }
  return manifest
}

async function downloadBundle(
  libraryRoot: string,
  bundle: string,
  destDir: string,
  options: RequestOptions & { force?: boolean; concurrency?: number }
): Promise<{ files: number; bytes: number }> {
  const manifest = await ripperManifest(libraryRoot, bundle, options)
  const files = manifest.files.filter(
    (file) => typeof file.path === 'string' && file.path.length > 0
  )
  let downloaded = 0
  let bytes = 0

  await mapPool(files, options.concurrency ?? DEFAULT_CONCURRENCY, async (file) => {
    const dest = path.join(destDir, ...file.path.split('/'))
    if (!options.force && fs.existsSync(dest)) return
    const url = assetUrl(libraryRoot, `${bundle}/${file.path}`)
    const data = await fetchBuffer(url, options)
    atomicWrite(dest, data)
    downloaded += 1
    bytes += data.length
  })

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
  const model3File = bundleManifest.files.find((file) => file.path.endsWith('.model3.json'))
  if (!model3File) {
    throw new Error(`${entry.id}: no .model3.json in ${entry.bundle}`)
  }
  const variant = path.basename(model3File.path, '.model3.json')
  const destDir = path.join(modelsDir, entry.id, variant)

  progress(`模型 ${entry.id} → ${path.relative(modelsDir, destDir)}`)
  const downloaded = await downloadBundle(libraryRoot, entry.bundle, destDir, options)

  const motionBundles = (
    entry.motions?.length ? entry.motions : entry.motion ? [entry.motion] : []
  ).filter((bundle): bundle is string => typeof bundle === 'string' && bundle.length > 0)
  const uniqueBundles = [...new Set(motionBundles)]

  // 动作包放在持久缓存里：网络中断后重跑只补缺失文件，同角色不同服装共用
  const motionCache = path.join(options.cacheDir, 'motion')
  const motionDirs: string[] = []
  for (const bundle of uniqueBundles) {
    const bundleDir = path.join(motionCache, safeClipName(bundle.replace(/^live2d\/motion\//, '')))
    await withKeyLock(`motion:${bundle}`, () =>
      downloadBundle(libraryRoot, bundle, bundleDir, {
        ...options,
        force: false
      })
    )
    motionDirs.push(bundleDir)
  }

  const clips = new Map<string, { filename: string; fadeIn: number; fadeOut: number }>()
  const walk = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return []
    const result: string[] = []
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name)
      if (item.isDirectory()) result.push(...walk(full))
      else if (item.name.endsWith('.sse-motion.json')) result.push(full)
    }
    return result
  }

  for (const motionDir of motionDirs) {
    for (const file of walk(motionDir)) {
      let raw: unknown
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
      } catch (error) {
        progress(`跳过无法解析的动作 ${path.relative(motionDir, file)}: ${String(error)}`)
        continue
      }
      let converted
      try {
        converted = convertSseMotion(raw)
      } catch (error) {
        progress(`跳过无法转换的动作 ${path.relative(motionDir, file)}: ${String(error)}`)
        continue
      }
      if (converted.motion3.Curves.length === 0) continue
      if (clips.has(converted.name)) continue

      const filename = `${safeClipName(converted.name)}.motion3.json`
      const motionFile = path.join(destDir, 'motions', filename)
      atomicWrite(motionFile, JSON.stringify(converted.motion3))
      clips.set(converted.name, {
        filename,
        fadeIn: converted.fadeIn,
        fadeOut: converted.fadeOut
      })
    }
  }

  const modelJsonPath = path.join(destDir, ...model3File.path.split('/'))
  const model3 = JSON.parse(fs.readFileSync(modelJsonPath, 'utf-8')) as {
    FileReferences?: {
      Motions?: Record<string, Array<{ File: string; FadeInTime: number; FadeOutTime: number }>>
    }
  }
  if (!model3.FileReferences) model3.FileReferences = {}
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
    ...(model3.FileReferences.Motions ?? {}),
    ...motions
  }
  atomicWrite(modelJsonPath, JSON.stringify(model3, null, 2))

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
    bytes: downloaded.bytes
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
