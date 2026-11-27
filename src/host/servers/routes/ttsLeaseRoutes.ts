import type express from 'express'
import type { ILogObj, Logger } from 'tslog'
import type { TtsLeaseManager, TtsWeights } from '../../tts/TtsLeaseManager'

export interface TtsLeaseRoutesDeps {
  logger: Logger<ILogObj>
  ttsLease: TtsLeaseManager
}

export function registerTtsLeaseRoutes(app: express.Application, deps: TtsLeaseRoutesDeps): void {
  const { logger, ttsLease } = deps

  // TTS 权重租约：同一时刻只允许一个渲染 worker 切权重并合成，
  // 避免多个导出并发时 GSV 的全局权重被互相覆盖。
  app.post('/api/v1/tts/lease', async (req, res) => {
    const controller = new AbortController()
    let settled = false
    const onClose = (): void => {
      if (!settled) controller.abort()
    }
    req.on('close', onClose)
    try {
      const grant = await ttsLease.acquire(controller.signal)
      settled = true
      res.json({ success: true, ...grant })
    } catch (error) {
      settled = true
      if (!res.headersSent) {
        res.status(503).json({
          success: false,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    } finally {
      req.off('close', onClose)
    }
  })

  app.post('/api/v1/tts/lease/release', (req, res) => {
    const body = req.body as { leaseId?: unknown; weights?: unknown } | undefined
    if (typeof body?.leaseId !== 'string' || body.leaseId.length === 0) {
      res.status(400).json({ success: false, error: 'leaseId is required' })
      return
    }

    let weights: TtsWeights | null | undefined
    if (body.weights === null) {
      weights = null
    } else if (typeof body.weights === 'object' && body.weights !== null) {
      const raw = body.weights as {
        gptWeightsPath?: unknown
        sovitsWeightsPath?: unknown
      }
      if (typeof raw.gptWeightsPath !== 'string' || typeof raw.sovitsWeightsPath !== 'string') {
        res.status(400).json({ success: false, error: 'weights paths must be strings' })
        return
      }
      weights = {
        gptWeightsPath: raw.gptWeightsPath,
        sovitsWeightsPath: raw.sovitsWeightsPath
      }
    }

    const previous = ttsLease.stats().currentWeights
    const changed =
      weights !== undefined &&
      (weights === null ||
        previous === null ||
        previous.gptWeightsPath !== weights.gptWeightsPath ||
        previous.sovitsWeightsPath !== weights.sovitsWeightsPath)

    if (changed && weights !== undefined) {
      if (weights === null) {
        logger.warn(
          `[TTS] Lease ${body.leaseId} released without confirmed weights; next request will switch`
        )
      } else {
        const gpt = weights.gptWeightsPath.split(/[\\/]/).pop() || weights.gptWeightsPath
        const sovits = weights.sovitsWeightsPath.split(/[\\/]/).pop() || weights.sovitsWeightsPath
        logger.info(`[TTS] Weights active: ${gpt} + ${sovits}`)
      }
    }

    ttsLease.release(body.leaseId, weights)
    res.json({ success: true })
  })
}
