import path from 'node:path'
import type express from 'express'
import type { ILogObj, Logger } from 'tslog'
import type { HostConfig } from '../../config'
import type { CloudCatalogService } from '../../assets/cloudCatalog'
import type { ResourceCatalog } from '../../resources/resourceCatalog'
import { fetchModels, loadMoesekaiIndex, selectModels } from '../../assets/moesekai'
import { fetchMedia, listMedia, type MediaKind } from '../../assets/media'
import { loadSoundtrackIndex } from '../../assets/soundtracks'

export interface AssetRoutesDeps {
  logger: Logger<ILogObj>
  config: HostConfig
  useCloudCatalog: boolean
  cloudCatalog: CloudCatalogService
  resourceCatalog: ResourceCatalog
}

export interface AssetRoutesHandle {
  isFetching: () => boolean
}

export function registerAssetRoutes(
  app: express.Application,
  deps: AssetRoutesDeps
): AssetRoutesHandle {
  const { logger, config, useCloudCatalog, cloudCatalog, resourceCatalog } = deps
  let assetFetchTask: Promise<unknown> | null = null

  // 资源目录：供 AstrBot 插件动态构建提示词与校验白名单。
  // 已有缓存时最多等 2 秒刷新；冷启动尚无本地缓存时等待完整首轮拉取（上限 180 秒）。
  app.get('/api/v1/resources', async (_req, res) => {
    if (useCloudCatalog) {
      await cloudCatalog.waitReady({ coldTimeoutMs: 180_000, staleTimeoutMs: 2_000 })
    }
    res.json({ success: true, ...resourceCatalog.get() })
  })

  // 手动刷新云端目录（模型/背景/BGM 名称索引）。
  app.post('/api/v1/cloud/refresh', async (_req, res) => {
    if (!useCloudCatalog) {
      res.status(409).json({ success: false, error: 'cloud catalog is disabled' })
      return
    }
    const catalog = await cloudCatalog.refresh()
    if (!catalog) {
      res.status(502).json({ success: false, error: 'cloud catalog refresh failed' })
      return
    }
    res.json({
      success: true,
      generatedAt: catalog.generatedAt,
      models: catalog.models.length,
      backgrounds: catalog.backgrounds.length,
      bgm: catalog.bgm.length,
      se: catalog.se?.length ?? 0
    })
  })

  // ---- 云端资源（moesekai / pjsk.moe） ------------------------------------------------------------
  app.get('/api/v1/assets/moesekai/models', async (req, res) => {
    const region = String(req.query.region ?? config.assets.region) as typeof config.assets.region
    if (!['jp', 'cn', 'tw', 'kr', 'en'].includes(region)) {
      res.status(400).json({ success: false, error: 'region must be jp/cn/tw/kr/en' })
      return
    }
    try {
      const { index, indexUrl } = await loadMoesekaiIndex(config.assets, region)
      const characters = String(req.query.characters ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
      const models = String(req.query.models ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
      const selected =
        characters.length === 0 && models.length === 0
          ? index.models
          : selectModels(index, {
              characters: characters.length > 0 ? characters : undefined,
              models: models.length > 0 ? models : undefined
            })
      res.json({
        success: true,
        region,
        indexUrl,
        generatedAt: index.generatedAt,
        assetVersion: index.assetVersion,
        total: index.models.length,
        models: selected.map((model) => ({
          id: model.id,
          kind: model.kind ?? null,
          characterId: model.characterId ?? null,
          bundle: model.bundle,
          motionBundles: model.motions ?? (model.motion ? [model.motion] : []),
          bytes: model.bytes ?? 0
        }))
      })
    } catch (error) {
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })

  // 背景/BGM 浏览（不下载）；kind=backgrounds|bgm|all
  app.get('/api/v1/assets/moesekai/media', async (req, res) => {
    const region = String(req.query.region ?? config.assets.region)
    if (!['jp', 'cn', 'tw', 'kr', 'en'].includes(region)) {
      res.status(400).json({ success: false, error: 'region must be jp/cn/tw/kr/en' })
      return
    }
    const rawKind = String(req.query.kind ?? 'all').toLowerCase()
    const kinds: MediaKind[] | null =
      rawKind === 'all'
        ? ['background', 'bgm']
        : rawKind === 'backgrounds' || rawKind === 'background'
          ? ['background']
          : rawKind === 'bgm'
            ? ['bgm']
            : null
    if (!kinds) {
      res.status(400).json({ success: false, error: 'kind must be backgrounds/bgm/all' })
      return
    }
    const names = String(req.query.names ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    const rawLimit = req.query.limit
    let limit: number | undefined
    if (rawLimit !== undefined) {
      limit = Number(rawLimit)
      if (!Number.isInteger(limit) || limit < 0) {
        res.status(400).json({ success: false, error: 'limit must be an integer >= 0' })
        return
      }
    }
    try {
      const result = await listMedia({
        region: region as typeof config.assets.region,
        kinds,
        assetBase: config.assets.assetBase || undefined,
        limit,
        names: names.length > 0 ? names : undefined,
        includeAreaBgm: req.query.includeArea === '1' || req.query.includeArea === 'true',
        timeoutMs: config.assets.timeoutMs,
        retries: config.assets.retries
      })
      res.json({ success: true, ...result })
    } catch (error) {
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })

  app.post('/api/v1/assets/fetch', async (req, res) => {
    if (assetFetchTask) {
      res.status(409).json({ success: false, error: 'another asset fetch is already running' })
      return
    }
    const body = (req.body ?? {}) as {
      kind?: unknown
      characters?: unknown
      models?: unknown
      names?: unknown
      limit?: unknown
      region?: unknown
      force?: unknown
      dryRun?: unknown
      includeArea?: unknown
    }
    const toList = (value: unknown, label: string): string[] | undefined => {
      if (value === undefined) return undefined
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new Error(`${label} must be a string array`)
      }
      return value as string[]
    }
    const region = String(body.region ?? config.assets.region)
    if (!['jp', 'cn', 'tw', 'kr', 'en'].includes(region)) {
      res.status(400).json({ success: false, error: 'region must be jp/cn/tw/kr/en' })
      return
    }

    let characters: string[] | undefined
    let models: string[] | undefined
    let names: string[] | undefined
    let limit: number | undefined
    let kind: 'backgrounds' | 'bgm' | 'all' | undefined
    try {
      characters = toList(body.characters, 'characters')
      models = toList(body.models, 'models')
      names = toList(body.names, 'names')
      if (body.limit !== undefined) {
        if (typeof body.limit !== 'number' || !Number.isInteger(body.limit) || body.limit < 0) {
          throw new Error('limit must be an integer >= 0')
        }
        limit = body.limit
      }
      if (body.kind !== undefined) {
        const raw = String(body.kind).toLowerCase()
        if (raw === 'backgrounds' || raw === 'background') kind = 'backgrounds'
        else if (raw === 'bgm') kind = 'bgm'
        else if (raw === 'all') kind = 'all'
        else throw new Error('kind must be backgrounds/bgm/all')
      }
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      })
      return
    }

    if (!kind && !characters?.length && !models?.length) {
      res.status(400).json({
        success: false,
        error: 'kind (backgrounds/bgm/all) or characters/models is required'
      })
      return
    }

    const fetchKinds: MediaKind[] =
      kind === 'all' ? ['background', 'bgm'] : [kind === 'backgrounds' ? 'background' : 'bgm']

    assetFetchTask = kind
      ? (async () => {
          // 官方曲名索引只影响新登记的 BGM；dry-run 不写清单，无需多拉一次网络。
          const soundtrackIndex =
            fetchKinds.includes('bgm') && body.dryRun !== true
              ? await loadSoundtrackIndex({
                  cacheFile: path.join(config.paths.resources, 'audio', 'bgm', 'soundtracks.json'),
                  baseUrl: config.assets.soundtrackBase,
                  timeoutMs: Math.min(config.assets.timeoutMs, 60_000),
                  retries: Math.min(config.assets.retries, 1),
                  onProgress: (message) => logger.info(`[Assets] ${message}`)
                })
              : null
          return fetchMedia({
            outDir: config.paths.resources,
            region: region as typeof config.assets.region,
            kinds: fetchKinds,
            assetBase: config.assets.assetBase || undefined,
            names,
            limit,
            includeAreaBgm: body.includeArea === true,
            force: body.force === true,
            dryRun: body.dryRun === true,
            timeoutMs: config.assets.timeoutMs,
            retries: config.assets.retries,
            soundtrackIndex,
            onProgress: (message) => logger.info(`[Assets] ${message}`)
          })
        })()
      : fetchModels(config.assets, {
          outDir: config.paths.resources,
          region: region as typeof config.assets.region,
          characters,
          models,
          force: body.force === true,
          dryRun: body.dryRun === true,
          onProgress: (message) => logger.info(`[Assets] ${message}`)
        })
    try {
      const result = await assetFetchTask
      res.json({ success: true, ...(result as object) })
    } catch (error) {
      res.status(502).json({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      assetFetchTask = null
    }
  })

  return {
    isFetching: () => assetFetchTask !== null
  }
}
