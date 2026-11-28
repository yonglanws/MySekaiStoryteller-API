import express, { Router } from 'express'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { HostConfig } from '../config'

const IMAGE_FALLBACK_EXTS = ['.webp', '.png', '.jpg', '.jpeg']

/**
 * cloudOnly=true 时对 /resources 静态路由的严格隔离判定：
 * - 允许 inapp/ 公共 UI/字体/音效资源
 * - models/、images/、audio/bgm/、audio/se/ 下仅允许 cloud/ 子目录
 * - 拒绝 voices/ 与本地清单（models.yaml / bgm.yaml / images.yaml）
 */
export function isAllowedCloudOnlyResourcePath(rawPath: string): boolean {
  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return false
  }
  const norm = decoded.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
  const segments = norm.split('/').filter(Boolean)
  if (segments.length === 0 || segments.includes('..')) return false
  const clean = segments.join('/')
  if (clean === 'inapp' || clean.startsWith('inapp/')) return true
  if (clean === 'models.yaml' || clean === 'bgm.yaml' || clean === 'images.yaml') return false
  if (clean === 'voices' || clean.startsWith('voices/')) return false
  if (clean === 'models' || clean.startsWith('models/')) {
    return clean.startsWith('models/cloud/')
  }
  if (clean === 'images' || clean.startsWith('images/')) {
    return clean.startsWith('images/cloud/')
  }
  if (clean === 'audio/bgm' || clean.startsWith('audio/bgm/')) {
    return clean.startsWith('audio/bgm/cloud/')
  }
  if (clean === 'audio/se' || clean.startsWith('audio/se/')) {
    return clean.startsWith('audio/se/cloud/')
  }
  return true
}

/**
 * 静态资源托管：
 * - /              → webrenderer 构建产物（渲染工作进程页面）
 * - /resources/*   → 资源根：models/ images/ voices/ audio/ stories/
 * - /apifile/*     → API 故事 JSON 与导出视频
 * express.static 自带路径穿越防护（拒绝 .. 段）。
 */
export function createStaticRouter(config: HostConfig): Router {
  const router = Router()

  if (!fs.existsSync(config.paths.webRenderer)) {
    throw new Error(
      `Web renderer build not found at ${config.paths.webRenderer}. Run "npm run build:web" first.`
    )
  }

  if (config.assets?.cloudOnly) {
    router.use('/resources', (req, res, next) => {
      if (!isAllowedCloudOnlyResourcePath(req.path)) {
        res.status(403).end()
        return
      }
      next()
    })
  }

  // 对无扩展名的 /resources/images/* 请求（例如未提前物化扩展名的云端背景路径 cloud/bg_a000301）
  // 自动匹配磁盘上非空的 .webp/.png/.jpg/.jpeg 文件，防止背景 404 渲染黑屏。
  const imagesRoot = path.resolve(config.paths.resources, 'images')
  router.use('/resources', (req, _res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next()
      return
    }
    const qIdx = req.url.indexOf('?')
    const rawUrlPath = qIdx >= 0 ? req.url.slice(0, qIdx) : req.url
    const querySuffix = qIdx >= 0 ? req.url.slice(qIdx) : ''
    let decodedPath: string
    try {
      decodedPath = decodeURIComponent(rawUrlPath)
    } catch {
      next()
      return
    }
    const normalized = decodedPath.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!normalized.toLowerCase().startsWith('images/')) {
      next()
      return
    }
    const relFromImages = normalized.slice('images/'.length)
    if (!relFromImages || relFromImages.endsWith('/') || path.posix.extname(relFromImages)) {
      next()
      return
    }
    const segments = relFromImages.split('/').filter(Boolean)
    if (segments.length === 0 || segments.includes('..')) {
      next()
      return
    }
    const baseCandidate = path.resolve(imagesRoot, ...segments)
    const relCheck = path.relative(imagesRoot, baseCandidate)
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      next()
      return
    }
    for (const ext of IMAGE_FALLBACK_EXTS) {
      const candidatePath = `${baseCandidate}${ext}`
      try {
        const stat = fs.statSync(candidatePath)
        if (stat.isFile() && stat.size > 0) {
          const rewrittenRel = `images/${segments.join('/')}${ext}`
          if (config.assets?.cloudOnly && !isAllowedCloudOnlyResourcePath(rewrittenRel)) {
            break
          }
          const encodedSegments = segments.map((s) => encodeURIComponent(s)).join('/')
          req.url = `/images/${encodedSegments}${ext}${querySuffix}`
          break
        }
      } catch {
        // candidate extension absent
      }
    }
    next()
  })

  router.use('/resources', express.static(config.paths.resources))
  router.use('/apifile', express.static(config.paths.output, { index: false }))
  router.use(
    express.static(config.paths.webRenderer, {
      index: 'index.html',
      setHeaders: (res, filePath) => {
        if (/\.(otf|ttf|woff2?)$/i.test(filePath)) {
          if (/\.otf$/i.test(filePath)) {
            res.setHeader('Content-Type', 'font/otf')
          }
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        }
      }
    })
  )

  return router
}
