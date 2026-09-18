import express, { Router, Request, Response, NextFunction } from 'express'
import * as fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { ILogObj, Logger } from 'tslog'
import type { HostConfig } from '../config'
import {
  apiConvertVideoWithCompression,
  apiMergeVideoAudioWithCompression,
  apiMuxVideoAudioCopy,
  apiCopyVideo,
  encodeFramesToVideo,
  VideoEncoderChoice
} from '../../shared/ffmpeg'

interface BridgeDeps {
  logger: Logger<ILogObj>
  config: HostConfig
}

/**
 * 渲染页面 ↔ 宿主的桥接层。
 * 通道语义与原 Electron IpcHandler 对齐：
 * - api-export-video-from-files：ffmpeg 转码/合流后删除输入文件
 * - tts-fetch：30s 超时代理；translation-fetch：无超时代理
 * 配置（TTS/BGM）由宿主在任务下发时注入 payload，不再走配置文件通道。
 */
export function createBridgeRouter(deps: BridgeDeps): Router {
  const { logger, config } = deps
  const router = Router()

  // ----- JSON invoke 通道 -----

  router.post('/invoke/:channel', express.json({ limit: '50mb' }), async (req, res) => {
    const channel = String(req.params.channel)
    const args = (Array.isArray(req.body) ? req.body : []) as unknown[]

    try {
      const result = await handleInvoke(channel, args)
      res.json({ ok: true, result })
    } catch (error) {
      logger.error(`[Bridge] invoke ${channel} failed`, error)
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })

  async function handleInvoke(channel: string, args: unknown[]): Promise<unknown> {
    switch (channel) {
      case 'electron:get-temp-dir': {
        const framesDir = path.join(tmpdir(), `mss-hf-${Date.now()}`, 'frames')
        await fs.promises.mkdir(framesDir, { recursive: true })
        return framesDir
      }

      case 'electron:get-temp-base-dir': {
        const baseDir = path.join(tmpdir(), `mss-export-${Date.now()}`)
        await fs.promises.mkdir(baseDir, { recursive: true })
        return baseDir
      }

      case 'electron:api-export-video-from-files': {
        const payload = args[0] as {
          videoPath: string
          audioPath?: string
          outputPath: string
          fps: number
          width: number
          height: number
          crf: number
          audioBitrate: string
        }
        logger.info(
          `[Bridge] API: videoPath=${payload.videoPath}, audioPath=${payload.audioPath}, outputPath=${payload.outputPath}`
        )

        try {
          const outputDir = path.dirname(payload.outputPath)
          if (!fs.existsSync(outputDir)) {
            await fs.promises.mkdir(outputDir, { recursive: true })
          }

          const encoder = config.video.encoder as VideoEncoderChoice

          if (payload.audioPath && fs.existsSync(payload.audioPath)) {
            await apiMergeVideoAudioWithCompression(
              payload.videoPath,
              payload.audioPath,
              payload.outputPath,
              payload.crf,
              payload.audioBitrate,
              payload.fps,
              encoder,
              config.video.width,
              config.video.height
            )
          } else {
            await apiConvertVideoWithCompression(
              payload.videoPath,
              payload.outputPath,
              payload.crf,
              payload.fps,
              encoder,
              config.video.width,
              config.video.height
            )
          }

          if (!fs.existsSync(payload.outputPath)) {
            logger.error(`[Bridge] API: Output file NOT found at: ${payload.outputPath}`)
            return {
              success: false,
              error: 'Video encoding completed but output file not found'
            }
          }

          const outputSize = (await fs.promises.stat(payload.outputPath)).size
          logger.info(
            `[Bridge] API: Video exported successfully: ${payload.outputPath}, size=${(outputSize / 1024 / 1024).toFixed(2)} MB`
          )
          return { success: true, outputPath: payload.outputPath, fileSize: outputSize }
        } catch (error) {
          logger.error('[Bridge] API: Failed to export video from files', error)
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
          }
        } finally {
          try {
            if (payload.videoPath) await fs.promises.unlink(payload.videoPath)
          } catch {
            /* cleanup */
          }
          try {
            if (payload.audioPath) await fs.promises.unlink(payload.audioPath)
          } catch {
            /* cleanup */
          }
        }
      }

      case 'electron:api-remux-video-from-files': {
        // fast 导出收尾：页内 WebCodecs 已产出 H.264 MP4，仅 remux/合流，不重编码
        const payload = args[0] as {
          videoPath: string
          audioPath?: string
          outputPath: string
          audioBitrate: string
        }
        logger.info(
          `[Bridge] API remux: videoPath=${payload.videoPath}, audioPath=${payload.audioPath}, outputPath=${payload.outputPath}`
        )

        try {
          const outputDir = path.dirname(payload.outputPath)
          if (!fs.existsSync(outputDir)) {
            await fs.promises.mkdir(outputDir, { recursive: true })
          }

          if (payload.audioPath && fs.existsSync(payload.audioPath)) {
            await apiMuxVideoAudioCopy(
              payload.videoPath,
              payload.audioPath,
              payload.outputPath,
              payload.audioBitrate
            )
          } else {
            await apiCopyVideo(payload.videoPath, payload.outputPath)
          }

          if (!fs.existsSync(payload.outputPath)) {
            logger.error(`[Bridge] API remux: Output file NOT found at: ${payload.outputPath}`)
            return {
              success: false,
              error: 'Video remux completed but output file not found'
            }
          }

          const outputSize = (await fs.promises.stat(payload.outputPath)).size
          logger.info(
            `[Bridge] API remux: Video exported successfully: ${payload.outputPath}, size=${(outputSize / 1024 / 1024).toFixed(2)} MB`
          )
          return { success: true, outputPath: payload.outputPath, fileSize: outputSize }
        } catch (error) {
          logger.error('[Bridge] API remux: Failed to remux video from files', error)
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
          }
        } finally {
          try {
            if (payload.videoPath) await fs.promises.unlink(payload.videoPath)
          } catch {
            /* cleanup */
          }
          try {
            if (payload.audioPath) await fs.promises.unlink(payload.audioPath)
          } catch {
            /* cleanup */
          }
        }
      }

      case 'electron:api-encode-frames-video': {
        // fast 导出 JPEG 兜底收尾：帧序列 → ffmpeg 编码 → 可选音频合流
        const payload = args[0] as {
          framesDir: string
          audioPath?: string
          outputPath: string
          fps: number
          audioBitrate: string
        }
        logger.info(
          `[Bridge] API frames-encode: framesDir=${payload.framesDir}, audioPath=${payload.audioPath}, outputPath=${payload.outputPath}`
        )

        try {
          const outputDir = path.dirname(payload.outputPath)
          if (!fs.existsSync(outputDir)) {
            await fs.promises.mkdir(outputDir, { recursive: true })
          }

          const encoder = config.video.encoder as VideoEncoderChoice
          const intermediatePath = payload.audioPath
            ? path.join(outputDir, `.mss-frames-video-${Date.now()}.mp4`)
            : payload.outputPath

          await encodeFramesToVideo(
            payload.fps,
            payload.framesDir,
            intermediatePath,
            encoder,
            config.video.width,
            config.video.height
          )

          if (payload.audioPath && fs.existsSync(payload.audioPath)) {
            await apiMuxVideoAudioCopy(
              intermediatePath,
              payload.audioPath,
              payload.outputPath,
              payload.audioBitrate
            )
          }

          if (!fs.existsSync(payload.outputPath)) {
            logger.error(
              `[Bridge] API frames-encode: Output file NOT found at: ${payload.outputPath}`
            )
            return {
              success: false,
              error: 'Frame encoding completed but output file not found'
            }
          }

          const outputSize = (await fs.promises.stat(payload.outputPath)).size
          logger.info(
            `[Bridge] API frames-encode: Video exported successfully: ${payload.outputPath}, size=${(outputSize / 1024 / 1024).toFixed(2)} MB`
          )
          return { success: true, outputPath: payload.outputPath, fileSize: outputSize }
        } catch (error) {
          logger.error('[Bridge] API frames-encode failed', error)
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
          }
        } finally {
          try {
            if (payload.audioPath) await fs.promises.unlink(payload.audioPath)
          } catch {
            /* cleanup */
          }
        }
      }

      case 'electron:write-frame-batch': {
        // 帧捕获回退路径：批量 base64 帧写盘
        const batch = args[0] as Array<{ path: string; data: string }>
        await Promise.allSettled(
          batch.map(async (item) => {
            const buffer = Buffer.from(item.data, 'base64')
            await fs.promises.writeFile(item.path, buffer)
          })
        )
        return null
      }

      default:
        throw new Error(`Unsupported bridge invoke channel: ${channel}`)
    }
  }

  // ----- 二进制 invoke 通道（裸 body 传输大块数据，其余参数走 query） -----

  router.post(
    '/bin/:channel',
    express.raw({ type: '*/*', limit: '500mb' }),
    async (req: Request, res: Response, _next: NextFunction) => {
      const channel = String(req.params.channel)
      let args: unknown[] = []
      try {
        const raw = (req.query.args as string) || '[]'
        args = JSON.parse(raw) as unknown[]
      } catch {
        res.status(400).json({ ok: false, error: 'Invalid args query parameter' })
        return
      }

      try {
        const result = await handleBinaryInvoke(channel, args, req.body as Buffer)
        res.json({ ok: true, result })
      } catch (error) {
        logger.error(`[Bridge] bin ${channel} failed`, error)
        res.status(500).json({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  )

  async function handleBinaryInvoke(
    channel: string,
    args: unknown[],
    body: Buffer
  ): Promise<unknown> {
    switch (channel) {
      case 'electron:append-to-file': {
        const payload = args[0] as { filePath: string }
        await fs.promises.appendFile(payload.filePath, body)
        return null
      }

      case 'electron:write-file-at': {
        // mp4-muxer StreamTarget 的定位写：fastStart 需要在文件头部回写 moov
        const payload = args[0] as { filePath: string; position: number }
        await fs.promises.mkdir(path.dirname(payload.filePath), { recursive: true })
        const handle = await fs.promises.open(payload.filePath, 'r+')
        try {
          await handle.write(body, 0, body.length, payload.position)
        } finally {
          await handle.close()
        }
        return null
      }

      case 'electron:write-frame': {
        const payload = args[0] as { path: string }
        await fs.promises.writeFile(payload.path, body)
        return null
      }

      case 'electron:write-temp-file': {
        const payload = args[0] as { prefix: string; extension: string }
        const tempPath = path.join(tmpdir(), `${payload.prefix}-${Date.now()}.${payload.extension}`)
        await fs.promises.writeFile(tempPath, body)
        logger.info(
          `[Bridge] Temp file written: ${tempPath}, size=${(body.length / 1024 / 1024).toFixed(2)} MB`
        )
        return tempPath
      }

      default:
        throw new Error(`Unsupported bridge binary channel: ${channel}`)
    }
  }

  // ----- 网络代理（与原 tts-fetch / translation-fetch 语义一致） -----

  router.post(
    '/proxy/tts-fetch',
    express.json({ limit: '10mb' }),
    async (req: Request, res: Response) => {
      const payload = req.body as {
        url: string
        method: string
        headers: Record<string, string>
        body: string
      }
      logger.info(`[Bridge] TTS proxy: ${payload.method} ${payload.url}`)

      try {
        const response = await fetch(payload.url, {
          method: payload.method,
          headers: payload.headers,
          // GET/HEAD 请求不允许携带 body（Node fetch 会直接抛 TypeError）
          body: payload.method !== 'GET' && payload.method !== 'HEAD' ? payload.body : undefined,
          signal: AbortSignal.timeout(30000)
        })
        const arrayBuffer = await response.arrayBuffer()
        res.setHeader('x-mss-status', String(response.status))
        res.setHeader('x-mss-ok', response.ok ? '1' : '0')
        res.send(Buffer.from(arrayBuffer))
      } catch (error) {
        logger.error('[Bridge] TTS proxy fetch failed', error)
        res.setHeader('x-mss-status', '0')
        res.setHeader('x-mss-ok', '0')
        res.send(Buffer.alloc(0))
      }
    }
  )

  router.post(
    '/proxy/translation-fetch',
    express.json({ limit: '10mb' }),
    async (req: Request, res: Response) => {
      const payload = req.body as {
        url: string
        method: string
        headers: Record<string, string>
        body: string
      }
      logger.info(`[Bridge] Translation proxy: ${payload.method} ${payload.url}`)

      try {
        const response = await fetch(payload.url, {
          method: payload.method,
          headers: payload.headers,
          // GET/HEAD 请求不允许携带 body（Node fetch 会直接抛 TypeError）
          body: payload.method !== 'GET' && payload.method !== 'HEAD' ? payload.body : undefined
        })
        const text = await response.text()
        res.setHeader('x-mss-status', String(response.status))
        res.setHeader('x-mss-ok', response.ok ? '1' : '0')
        res.send(text)
      } catch (error) {
        logger.error('[Bridge] Translation proxy fetch failed', error)
        res.setHeader('x-mss-status', '0')
        res.setHeader('x-mss-ok', '0')
        res.send('{}')
      }
    }
  )

  return router
}
