import { ExportLogger } from './ExportLogger'
import type { TTSManager } from '../TTSManager'
import type { SnippetData } from '../../../../common/types/Story'

export interface ConcurrentPipelineConfig {
  ttsLookahead: number
  ttsTimeoutMs: number
  targetFps: number
  maxConcurrentTts: number
  /** 等待函数；fast 模式下必须用真实时钟 sleep，否则虚拟时钟会把等待编进视频 */
  waitMs?: (ms: number) => Promise<void>
  /** 真实墙钟 now；fast 模式下 performance.now 是虚拟时间 */
  nowMs?: () => number
}

export interface PipelineTTSResult {
  success: boolean
  duration: number
}

export interface PipelineMetrics {
  ttsLatenciesMs: number[]
  averageTtsLatencyMs: number
  maxTtsLatencyMs: number
  p95TtsLatencyMs: number
  ttsSuccessCount: number
  ttsFailureCount: number
  ttsTimeoutCount: number
  frameCaptureTimesMs: number[]
  averageFrameTimeMs: number
  droppedFrames: number
  totalFrames: number
  dropRate: number
  pipelineStartTime: number
  pipelineEndTime: number
  totalDurationMs: number
  ttsPipelineDurationMs: number
  renderPipelineDurationMs: number
  overlapDurationMs: number
}

type TTSWaitResolver = () => void

export class ConcurrentExportPipeline {
  private readonly logger: ExportLogger = new ExportLogger('ConcurrentExportPipeline')
  private readonly config: ConcurrentPipelineConfig

  private ttsResults: Map<number, PipelineTTSResult> = new Map()
  private ttsReadyFlags: Map<number, boolean> = new Map()
  private ttsWaitResolvers: Map<number, TTSWaitResolver> = new Map()

  private isRunning: boolean = false
  private isAborted: boolean = false
  private ttsPipelinePromise: Promise<void> | null = null

  private ttsPipelineStartTime: number = 0
  private ttsPipelineEndTime: number = 0
  private renderPipelineStartTime: number = 0
  private renderPipelineEndTime: number = 0

  private metrics: PipelineMetrics

  constructor(config?: Partial<ConcurrentPipelineConfig>) {
    this.config = {
      ttsLookahead: config?.ttsLookahead ?? 3,
      ttsTimeoutMs: config?.ttsTimeoutMs ?? 30000,
      targetFps: config?.targetFps ?? 30,
      maxConcurrentTts: 1,
      waitMs: config?.waitMs,
      nowMs: config?.nowMs
    }
    this.metrics = this.createInitialMetrics()
  }

  private createInitialMetrics(): PipelineMetrics {
    return {
      ttsLatenciesMs: [],
      averageTtsLatencyMs: 0,
      maxTtsLatencyMs: 0,
      p95TtsLatencyMs: 0,
      ttsSuccessCount: 0,
      ttsFailureCount: 0,
      ttsTimeoutCount: 0,
      frameCaptureTimesMs: [],
      averageFrameTimeMs: 0,
      droppedFrames: 0,
      totalFrames: 0,
      dropRate: 0,
      pipelineStartTime: 0,
      pipelineEndTime: 0,
      totalDurationMs: 0,
      ttsPipelineDurationMs: 0,
      renderPipelineDurationMs: 0,
      overlapDurationMs: 0
    }
  }

  startTTSPipeline(
    snippets: SnippetData[],
    ttsManager: TTSManager,
    onProgress?: (current: number, total: number, message: string) => void
  ): void {
    this.isRunning = true
    this.isAborted = false
    this.metrics = this.createInitialMetrics()
    this.metrics.pipelineStartTime = performance.now()
    this.ttsPipelineStartTime = performance.now()

    for (let i = 0; i < snippets.length; i++) {
      if (snippets[i].type === 'Talk') {
        this.ttsReadyFlags.set(i, false)
      }
    }

    this.ttsPipelinePromise = this.runTTSPipeline(snippets, ttsManager, onProgress)
    this.logger.info('TTS pipeline started', {
      talkSnippetCount: this.ttsReadyFlags.size,
      lookahead: this.config.ttsLookahead,
      timeout: this.config.ttsTimeoutMs
    })
  }

  private async runTTSPipeline(
    snippets: SnippetData[],
    ttsManager: TTSManager,
    onProgress?: (current: number, total: number, message: string) => void
  ): Promise<void> {
    const talkSnippets: { index: number; speaker: string; content: string; ttsText: string }[] = []

    for (let i = 0; i < snippets.length; i++) {
      if (snippets[i].type === 'Talk') {
        const snippet = snippets[i] as SnippetData & {
          data?: { speaker: string; content: string; ttsText?: string }
        }
        const data =
          snippet.data ||
          ((snippet as Record<string, unknown>).data as
            | { speaker: string; content: string; ttsText?: string }
            | undefined)
        talkSnippets.push({
          index: i,
          speaker: data?.speaker || '',
          content: data?.content || '',
          ttsText: data?.ttsText || ''
        })
      }
    }

    const total = talkSnippets.length
    let completed = 0
    const synthesizedDurations: Map<number, number> = new Map()

    this.logger.info(`TTS pipeline: ${total} Talk snippets to synthesize`)

    for (let i = 0; i < talkSnippets.length; i++) {
      if (this.isAborted) {
        this.logger.info('TTS pipeline aborted')
        break
      }

      const talk = talkSnippets[i]

      let currentTimeMs = 0
      for (let j = 0; j < talk.index; j++) {
        const snippet = snippets[j]
        const baseDelayMs = Math.max((snippet.delay || 0) * 1000, 200)
        const ttsDurationMs = synthesizedDurations.get(j) ?? 0
        const durationMs =
          ttsDurationMs > 0 ? Math.max(baseDelayMs, ttsDurationMs + 80) : baseDelayMs
        currentTimeMs += durationMs
      }

      ttsManager.setCurrentTime(currentTimeMs)

      const startTime = performance.now()

      try {
        let result: { success: boolean; duration: number }

        if (talk.ttsText) {
          result = await ttsManager.synthesizeWithText(talk.ttsText, talk.speaker, talk.index)
        } else {
          result = await ttsManager.translateAndSynthesize(talk.content, talk.speaker, talk.index)
        }

        const latency = performance.now() - startTime

        this.metrics.ttsLatenciesMs.push(latency)

        const pipelineResult: PipelineTTSResult = {
          success: result.success,
          duration: result.duration
        }

        if (result.success) {
          this.metrics.ttsSuccessCount++
          synthesizedDurations.set(talk.index, result.duration)
          if (completed % 10 === 0) {
            this.logger.info(
              `TTS [${talk.index}] "${talk.speaker}": success, duration=${result.duration}ms, latency=${latency.toFixed(0)}ms`
            )
          }
        } else {
          this.metrics.ttsFailureCount++
          this.logger.warn(
            `TTS [${talk.index}] "${talk.speaker}": failed, latency=${latency.toFixed(0)}ms`
          )
        }

        this.ttsResults.set(talk.index, pipelineResult)
      } catch (error) {
        const latency = performance.now() - startTime
        this.metrics.ttsLatenciesMs.push(latency)
        this.metrics.ttsFailureCount++
        this.ttsResults.set(talk.index, { success: false, duration: 0 })
        this.logger.error(
          `TTS [${talk.index}] exception: ${error instanceof Error ? error.message : String(error)}`
        )
      }

      this.ttsReadyFlags.set(talk.index, true)
      const resolver = this.ttsWaitResolvers.get(talk.index)
      if (resolver) {
        resolver()
        this.ttsWaitResolvers.delete(talk.index)
      }

      completed++
      onProgress?.(completed, total, `正在合成语音 ${completed}/${total}: ${talk.speaker}`)

      if (completed % 5 === 0) {
        await this.wait(0)
      }
    }

    this.ttsPipelineEndTime = performance.now()
    this.logger.info(
      `TTS pipeline completed: ${this.metrics.ttsSuccessCount} succeeded, ${this.metrics.ttsFailureCount} failed, duration=${(this.ttsPipelineEndTime - this.ttsPipelineStartTime).toFixed(0)}ms`
    )
  }

  async waitForTTSReady(snippetIndex: number): Promise<PipelineTTSResult | null> {
    if (!this.ttsReadyFlags.has(snippetIndex)) {
      return null
    }

    if (this.ttsReadyFlags.get(snippetIndex)) {
      return this.ttsResults.get(snippetIndex) ?? null
    }

    // 使用更高效的轮询+事件混合机制
    const startTime = this.now()
    const checkInterval = 10 // 10ms检查一次
    const maxWaitTime = this.config.ttsTimeoutMs

    while (this.now() - startTime < maxWaitTime) {
      if (this.ttsReadyFlags.get(snippetIndex)) {
        return this.ttsResults.get(snippetIndex) ?? null
      }

      await this.wait(checkInterval)

      if (this.isAborted) {
        return { success: false, duration: 0 }
      }
    }

    // 超时处理
    this.metrics.ttsTimeoutCount++
    this.logger.warn(`TTS wait timeout for snippet ${snippetIndex} (${this.config.ttsTimeoutMs}ms)`)
    this.ttsReadyFlags.set(snippetIndex, true)
    this.ttsResults.set(snippetIndex, { success: false, duration: 0 })
    return { success: false, duration: 0 }
  }

  private wait(ms: number): Promise<void> {
    if (this.config.waitMs) return this.config.waitMs(ms)
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private now(): number {
    return this.config.nowMs ? this.config.nowMs() : performance.now()
  }

  isTTSReady(snippetIndex: number): boolean {
    return this.ttsReadyFlags.get(snippetIndex) ?? true
  }

  getTTSResult(snippetIndex: number): PipelineTTSResult | null {
    return this.ttsResults.get(snippetIndex) ?? null
  }

  markRenderStart(): void {
    this.renderPipelineStartTime = performance.now()
  }

  markRenderEnd(): void {
    this.renderPipelineEndTime = performance.now()
  }

  recordFrameCapture(frameTimeMs: number, dropped: boolean): void {
    this.metrics.frameCaptureTimesMs.push(frameTimeMs)
    this.metrics.totalFrames++
    if (dropped) {
      this.metrics.droppedFrames++
    }
  }

  getMetrics(): PipelineMetrics {
    const latencies = this.metrics.ttsLatenciesMs
    const frameTimes = this.metrics.frameCaptureTimesMs

    const sortedLatencies = [...latencies].sort((a, b) => a - b)
    const p95Index = Math.floor(sortedLatencies.length * 0.95)
    const p95 =
      sortedLatencies.length > 0
        ? sortedLatencies[Math.min(p95Index, sortedLatencies.length - 1)]
        : 0

    const ttsDuration = this.ttsPipelineEndTime - this.ttsPipelineStartTime
    const renderDuration = this.renderPipelineEndTime - this.renderPipelineStartTime

    const overlapStart = Math.max(this.ttsPipelineStartTime, this.renderPipelineStartTime)
    const overlapEnd = Math.min(this.ttsPipelineEndTime, this.renderPipelineEndTime)
    const overlap = overlapEnd > overlapStart ? overlapEnd - overlapStart : 0

    return {
      ...this.metrics,
      averageTtsLatencyMs:
        latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
      maxTtsLatencyMs: latencies.length > 0 ? Math.max(...latencies) : 0,
      p95TtsLatencyMs: p95,
      averageFrameTimeMs:
        frameTimes.length > 0 ? frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length : 0,
      dropRate:
        this.metrics.totalFrames > 0 ? this.metrics.droppedFrames / this.metrics.totalFrames : 0,
      pipelineEndTime: performance.now(),
      totalDurationMs: performance.now() - this.metrics.pipelineStartTime,
      ttsPipelineDurationMs: ttsDuration,
      renderPipelineDurationMs: renderDuration,
      overlapDurationMs: overlap
    }
  }

  isPipelineRunning(): boolean {
    return this.isRunning
  }

  abort(): void {
    this.isAborted = true
    this.logger.info('Concurrent pipeline abort requested')

    for (const [index, resolver] of this.ttsWaitResolvers) {
      this.ttsReadyFlags.set(index, true)
      this.ttsResults.set(index, { success: false, duration: 0 })
      resolver()
    }
    this.ttsWaitResolvers.clear()
  }

  async waitForTTSPipeline(): Promise<void> {
    if (this.ttsPipelinePromise) {
      try {
        await this.ttsPipelinePromise
      } catch (error) {
        this.logger.error('TTS pipeline error during wait', error)
      }
    }
  }

  async dispose(): Promise<void> {
    this.abort()

    if (this.ttsPipelinePromise) {
      try {
        await this.ttsPipelinePromise
      } catch {
        // ignore
      }
    }

    this.ttsResults.clear()
    this.ttsReadyFlags.clear()
    this.ttsWaitResolvers.clear()
    this.ttsPipelinePromise = null
    this.isRunning = false

    this.logger.info('Concurrent pipeline disposed')
  }
}
