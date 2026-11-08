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
import type { AssetsSettings } from '../config'
import type { StoryData } from '../../common/types/Story'
import type {
  CloudBackgroundEntry,
  CloudBgmEntry,
  CloudCatalogData,
  CloudModelEntry
} from './cloudCatalog'
import { downloadMediaFile, downloadSeFile } from './media'
import { downloadModel, type MoesekaiIndexEntry } from './moesekai'

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

/** 背景：支持 id（bg_a000301）、文件名、cloud/ 路径、可读名与别名。 */
export function findCloudBackground(
  catalog: CloudCatalogData | null,
  value: unknown
): CloudBackgroundEntry | null {
  if (!catalog) return null
  const raw = normalizeRef(value)
  if (!raw) return null
  const lower = raw.toLowerCase()
  const exact = catalog.backgrounds.find((entry) =>
    keysOf([entry.id, entry.file, stem(entry.file), entry.name, ...entry.aliases]).includes(lower)
  )
  if (exact) return exact

  // 同名背景在官方剧情里很常见（例如多个「屋上」），按 id 排序取第一个，
  // 保证同一份剧本每次导出的结果一致。
  const exactName = catalog.backgrounds.find((entry) =>
    keysOf([entry.name, ...entry.aliases]).includes(lower)
  )
  if (exactName) return exactName

  const byName = catalog.backgrounds
    .filter((entry) =>
      keysOf([entry.name, ...entry.aliases]).some(
        (key) => key.includes(lower) || lower.includes(key)
      )
    )
    .sort((a, b) => a.id.localeCompare(b.id))
  return byName[0] ?? null
}

/** BGM：支持 id（bgm00003）、文件名、cloud/ 路径、曲名。 */
export function findCloudBgm(
  catalog: CloudCatalogData | null,
  value: unknown
): CloudBgmEntry | null {
  if (!catalog) return null
  const raw = normalizeRef(value)
  if (!raw) return null
  const lower = raw.toLowerCase()
  const exact = catalog.bgm.find((entry) =>
    keysOf([entry.id, entry.file, stem(entry.file), entry.name]).includes(lower)
  )
  if (exact) return exact

  const byName = catalog.bgm.filter(
    (entry) => entry.name.toLowerCase() === lower || entry.name.toLowerCase().includes(lower)
  )
  return byName.length === 1 ? byName[0] : null
}

/** 模型：支持云端 id、角色名/简称、cloud/ 路径。 */
export function findCloudModel(
  catalog: CloudCatalogData | null,
  value: unknown
): CloudModelEntry | null {
  if (!catalog) return null
  const raw = normalizeRef(value)
  if (!raw) return null
  const lower = raw.toLowerCase()
  const exact = catalog.models.find((entry) =>
    keysOf([entry.id, entry.name, entry.shortName, entry.path, stem(entry.path)]).includes(lower)
  )
  if (exact) return exact

  const byName = catalog.models.filter(
    (entry) =>
      entry.name.toLowerCase() === lower ||
      entry.shortName.toLowerCase() === lower ||
      entry.id.toLowerCase().includes(lower)
  )
  return byName.length === 1 ? byName[0] : null
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

async function ensureBgm(entry: CloudBgmEntry, ctx: CloudAssetContext): Promise<string> {
  const bgmDir = path.join(ctx.resourcesDir, 'audio', 'bgm', 'cloud')
  const existing = existsWithExtensions(bgmDir, entry.id, AUDIO_EXTENSIONS)
  if (existing) return `cloud/${path.basename(existing)}`

  ctx.logger.info(`[Cloud] 下载 BGM ${entry.id}（${entry.name}）…`)
  const downloaded = await downloadMediaFile({
    kind: 'bgm',
    name: entry.id,
    outDir: ctx.resourcesDir,
    region: ctx.settings.region,
    assetBase: ctx.settings.assetBase || undefined,
    subdir: 'cloud',
    timeoutMs: ctx.settings.timeoutMs,
    retries: ctx.settings.retries
  })
  if (!downloaded) throw new Error(`cloud bgm not found: ${entry.id}`)
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

  ctx.logger.info(`[Cloud] 下载 SE ${name} …`)
  const downloaded = await downloadSeFile({
    name,
    outDir: ctx.resourcesDir,
    region: ctx.settings.region,
    assetBase: ctx.settings.assetBase || undefined,
    timeoutMs: ctx.settings.timeoutMs,
    retries: ctx.settings.retries
  })
  if (!downloaded) return null
  ctx.logger.info(
    `[Cloud] SE ${name} → ${downloaded.file}（${(downloaded.bytes / 1024).toFixed(0)} KB）`
  )
  return `cloud/${path.basename(downloaded.file)}`
}

/**
 * 全局默认 BGM（config.yaml / bgm.yaml 的 `bgm.path`）也允许指向云端曲目：
 * 本地文件不存在时按曲名/id 解析并下载，成功后把 path 改成资源根相对路径。
 * 已经是 http(s) URL、站内绝对路径或本地文件时原样保留。
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

  const entry = findCloudBgm(ctx.catalog, ref) ?? findCloudBgm(ctx.catalog, path.basename(ref))
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

async function ensureModel(entry: CloudModelEntry, ctx: CloudAssetContext): Promise<string> {
  const modelsDir = path.join(ctx.resourcesDir, 'models', 'cloud')
  const modelJson = path.join(ctx.resourcesDir, 'models', ...entry.path.split('/'))
  if (fs.existsSync(modelJson)) return entry.path

  const existing = modelLocks.get(entry.id)
  if (existing) return existing
  const task = (async () => {
    if (!ctx.catalog) throw new Error('cloud catalog unavailable')
    ctx.logger.info(`[Cloud] 下载 Live2D 模型 ${entry.id}（${entry.name}）…`)
    const indexEntry: MoesekaiIndexEntry = {
      id: entry.id,
      bundle: entry.bundle,
      motion: entry.motionBundles[0] ?? null,
      motions: entry.motionBundles,
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
    modelLocks.delete(entry.id)
  })
  modelLocks.set(entry.id, task)
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
    if (localModelExists(ctx.resourcesDir, ref)) continue
    const entry = ref.startsWith('cloud/')
      ? (ctx.catalog.models.find((item) => ref.startsWith(`cloud/${item.id}/`)) ?? null)
      : findCloudModel(ctx.catalog, ref)
    if (!entry) {
      result.missing.push(`model:${ref}`)
      continue
    }
    try {
      model.model = await ensureModel(entry, ctx)
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
    }
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
