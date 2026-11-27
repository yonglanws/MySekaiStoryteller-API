import type { App } from '../../app/App'
import type { SnippetData } from '../../../../common/types/Story'
import {
  FRAME_MS,
  LIP_LOUD_CHARACTERS,
  LIP_LOUD_TARGET_VALUE_SCALE,
  LIP_TARGET_VALUE_SCALE
} from '../../../../common/official/timing'
import { buildLipSyncEnvelope } from '../../utils/LipSyncEnvelope'
import type { ConcurrentExportPipeline } from './ConcurrentExportPipeline'

export type LipSyncEnvelopeData = ReturnType<typeof buildLipSyncEnvelope>

export interface DecodedPcmData {
  channel0: Float32Array
  channel1: Float32Array
  sampleRate: number
}

export interface LipSyncLogger {
  warn: (message: string, data?: unknown) => void
}

export interface LipSyncCoordinatorDeps {
  app: App
  logger: LipSyncLogger
  checkAborted: () => void
  probeRustBackendAvailable: () => Promise<boolean>
  bridgeFetchHeaders: (extra?: Record<string, string>) => Record<string, string>
  onRustAudioUnavailable?: () => void
}

/**
 * 本句说话人模型的口型系数（官方 `SetLipSyncK(tvs, tvs × 1.75)` 的 tvs）。
 * MSST 剧本没有 per-talk `TargetValueScale`，用模型初值：资源名角色号属于
 * 1/4/8/12/17/18 时为 1.25，否则 1.0。
 */
export function resolveLipSyncScale(app: App, snippets: SnippetData[], index: number): number {
  const snippet = snippets[index] as { data?: { modelId?: number } } | undefined
  const modelId = snippet?.data?.modelId
  if (typeof modelId !== 'number' || modelId < 0) return 1
  let model: ReturnType<App['getModelById']> | undefined
  try {
    model = app.getModelById?.(modelId)
  } catch {
    model = undefined
  }
  const scale = model?.getLipSyncScale?.()
  if (typeof scale === 'number' && Number.isFinite(scale) && scale > 0) return scale

  const modelPath = app.storyManager?.storyData?.models?.find((m) => m.id === modelId)?.model
  if (typeof modelPath === 'string' && modelPath) {
    const match = /(?:^|[/\\])(?:v\d+_)?0?([1-9]\d?)[a-z_-]/i.exec(modelPath)
    if (match) {
      const charId = Number(match[1])
      if (Number.isInteger(charId)) {
        return (LIP_LOUD_CHARACTERS as readonly number[]).includes(charId)
          ? LIP_LOUD_TARGET_VALUE_SCALE
          : LIP_TARGET_VALUE_SCALE
      }
    }
  }
  return 1
}

/**
 * 负责导出期间语音口型包络的 Rust/OfflineAudioContext 解码、预热缓存与解码后 PCM 复用。
 */
export class LipSyncCoordinator {
  private readonly lipSyncCache = new Map<number, LipSyncEnvelopeData | null>()
  private readonly pendingLipSync = new Map<number, Promise<LipSyncEnvelopeData | null>>()
  private readonly pcmCache = new Map<number, DecodedPcmData>()

  constructor(private readonly deps: LipSyncCoordinatorDeps) {}

  lipScaleForSnippet(snippets: SnippetData[], index: number): number {
    return resolveLipSyncScale(this.deps.app, snippets, index)
  }

  hasCachedEnvelope(snippetIndex: number): boolean {
    return this.lipSyncCache.has(snippetIndex)
  }

  getCachedPcm(snippetIndex: number): DecodedPcmData | undefined {
    return this.pcmCache.get(snippetIndex)
  }

  async waitPending(): Promise<void> {
    if (this.pendingLipSync.size > 0) {
      await Promise.allSettled([...this.pendingLipSync.values()])
      this.deps.checkAborted()
    }
  }

  async decodeEnvelope(
    audioBuffer: ArrayBuffer,
    snippetIndex = -1,
    targetValueScale = 1
  ): Promise<LipSyncEnvelopeData | null> {
    try {
      if (await this.deps.probeRustBackendAvailable()) {
        try {
          const qs = `?targetValueScale=${encodeURIComponent(String(targetValueScale))}`
          const resp = await fetch(`/bridge/rust/compute-lipsync${qs}`, {
            method: 'POST',
            headers: this.deps.bridgeFetchHeaders({ 'content-type': 'application/octet-stream' }),
            body: audioBuffer
          })
          this.deps.checkAborted()
          if (resp.ok) {
            const parsed = (await resp.json()) as {
              ok?: boolean
              values?: number[]
              frameMs?: number
              durationMs?: number
              audioDurationMs?: number
              releaseStep?: number
              targetValueScale?: number
              powK?: number
            }
            if (parsed?.ok && Array.isArray(parsed.values)) {
              return {
                values: Float32Array.from(parsed.values),
                frameMs: Number(parsed.frameMs) || FRAME_MS,
                durationMs: Number(parsed.durationMs) || 0,
                audioDurationMs: Number(parsed.audioDurationMs) || 0,
                releaseStep: Number(parsed.releaseStep) || 0,
                targetValueScale: Number(parsed.targetValueScale) || targetValueScale,
                powK: Number(parsed.powK) || 0
              }
            }
          } else if (resp.status === 503) {
            this.deps.onRustAudioUnavailable?.()
          }
        } catch (rustErr) {
          this.deps.checkAborted()
          this.deps.logger.warn(
            'Rust compute-lipsync failed, falling back to OfflineAudioContext:',
            rustErr
          )
        }
      }
      // Offline decoding must not wait on timers while the fast frame pump is paused.
      const decoder = new OfflineAudioContext(1, 1, 48000)
      const decoded = await decoder.decodeAudioData(audioBuffer.slice(0))
      this.deps.checkAborted()
      const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) =>
        decoded.getChannelData(index)
      )
      if (snippetIndex >= 0 && channels.length > 0 && channels[0].length > 0) {
        const ch0 = channels[0]
        const ch1 = channels.length > 1 ? channels[1] : ch0
        this.pcmCache.set(snippetIndex, {
          channel0: ch0,
          channel1: ch1,
          sampleRate: decoded.sampleRate
        })
      }
      return buildLipSyncEnvelope(channels, decoded.sampleRate, { targetValueScale })
    } catch (error) {
      this.deps.checkAborted()
      this.deps.logger.warn('Speech envelope unavailable; skipping lip sync', error)
      return null
    }
  }

  predecode(snippetIndex: number, audioBuffer?: ArrayBuffer, targetValueScale = 1): void {
    if (
      snippetIndex < 0 ||
      !audioBuffer ||
      this.lipSyncCache.has(snippetIndex) ||
      this.pendingLipSync.has(snippetIndex)
    ) {
      return
    }
    const task = this.decodeEnvelope(audioBuffer, snippetIndex, targetValueScale)
      .then((envelope) => {
        this.lipSyncCache.set(snippetIndex, envelope)
        return envelope
      })
      .finally(() => {
        this.pendingLipSync.delete(snippetIndex)
      })
    this.pendingLipSync.set(snippetIndex, task)
  }

  async prepareForTalk(
    audioBuffer?: ArrayBuffer,
    snippetIndex = -1,
    targetValueScale = 1
  ): Promise<void> {
    this.deps.app.currentTalkLipSync = null
    if (snippetIndex >= 0 && this.lipSyncCache.has(snippetIndex)) {
      this.deps.app.currentTalkLipSync = this.lipSyncCache.get(snippetIndex) ?? null
      return
    }
    if (snippetIndex >= 0 && this.pendingLipSync.has(snippetIndex)) {
      this.deps.app.currentTalkLipSync = (await this.pendingLipSync.get(snippetIndex)) ?? null
      return
    }
    if (!audioBuffer) return
    const envelope = await this.decodeEnvelope(audioBuffer, snippetIndex, targetValueScale)
    if (snippetIndex >= 0) this.lipSyncCache.set(snippetIndex, envelope)
    this.deps.app.currentTalkLipSync = envelope
  }

  prewarmReady(
    snippets: SnippetData[],
    concurrentPipeline: ConcurrentExportPipeline,
    fromIndex: number,
    lookahead: number
  ): void {
    if (!this.deps.app.ttsManager) return
    let queued = 0
    for (let j = fromIndex; j < snippets.length && queued < lookahead; j++) {
      if (snippets[j].type !== 'Talk') continue
      queued++
      if (this.lipSyncCache.has(j) || this.pendingLipSync.has(j)) continue
      if (!concurrentPipeline.isTTSReady(j)) continue
      const res =
        typeof concurrentPipeline.getTTSResult === 'function'
          ? concurrentPipeline.getTTSResult(j)
          : null
      if (res?.success && res.duration > 0) {
        const buf = this.deps.app.ttsManager.getAudioBufferForSnippet(j)
        if (buf) this.predecode(j, buf, this.lipScaleForSnippet(snippets, j))
      }
    }
  }

  clearDecodedCaches(): void {
    this.pcmCache.clear()
    this.lipSyncCache.clear()
  }

  reset(): void {
    this.lipSyncCache.clear()
    this.pendingLipSync.clear()
    this.pcmCache.clear()
  }
}
