import express, { Router } from 'express'
import * as fs from 'node:fs'
import type { HostConfig } from '../config'

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
