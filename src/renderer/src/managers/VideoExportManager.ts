import { App } from '../app/App'
import AnimationManager from './AnimationManager'
import { Sprite, Texture, Ticker } from 'pixi.js'
import {
  ExportLogger,
  CheckpointManager,
  ProgressTracker,
  ErrorRecoveryManager,
  ExportError,
  ExportErrorCode,
  ExportResult,
  AudioMuxer,
  ConcurrentExportPipeline,
  SnippetTimestampRecorder,
  AsyncFrameCapturer,
  buildExportDiagnostics,
  sanitizeDiagnostics,
  exportLogBus,
  motionTrace,
  exportTraceContext,
  type ExportDiagnostics
} from './video-export'
import { VirtualClockController } from './video-export/VirtualClockController'
import { BgmPlan } from './video-export/BgmPlan'
import { SePlan } from './video-export/SePlan'
import { WebCodecsMp4Encoder, type WebCodecsProbeResult } from './video-export/WebCodecsMp4Encoder'
import { JpegFrameSink } from './video-export/JpegFrameSink'
import { applyTalkPatch } from './video-export/talkPatch'
import type { VideoExportOptions } from './video-export'
import type { ExportProgress as ExtendedExportProgress } from './video-export'
import type { SnippetData } from '../../../common/types/Story'
import { snippetHasPreFence } from '../../../common/export/snippetSemantics'
import type { SnippetTimelineEntry } from './TTSManager'
import { estimateSnippetDuration } from '../utils/TimelineCalculator'
import { calculateTalkDurationMs } from '../utils/TalkTiming'
import {
  OPENING_COVER_FADE_MS,
  PLAYED_WAIT_TIME_MS,
  SCENARIO_EXIT_BGM_FADE_MS,
  SILENT_PUNCTUATION_HOLD_MS,
  STORY_FPS,
  TALK_WINDOW_OPEN_CLOSE_MS
} from '../../../common/official/timing'
import { hasSpeakableSpeechText } from '../../../common/tts/speechText'
import type { TimelineOptions } from '../utils/TimelineCalculator'
import {
  getLayoutRunningEndMs,
  getMotionSettledEndMs,
  resetStageTiming,
  type ExtendedApp
} from '../snippets/stageTiming'
import { webGLValidator } from '../utils/WebGLContextValidator'
import { frameValidator } from '../utils/FrameContentValidator'
import { resolveBgmUrl } from '../utils/ResourceUrl'
import { buildLipSyncEnvelope } from '../utils/LipSyncEnvelope'

export { VideoExportOptions }
export interface ExportProgress {
  stage: 'initializing' | 'loading' | 'capturing' | 'encoding' | 'saving' | 'complete'
  current: number
  total: number
  message: string
}

type ProgressCallback = (progress: ExportProgress) => void
type InternalProgressCallback = (progress: ExtendedExportProgress) => void

interface TalkSnippetLike {
  content: string
  ttsText?: string
  modelId: number
  motion?: string
  actions?: Array<{ at: number; modelId: number; motion?: string }>
}

export default class VideoExportManager {
  private readonly logger: ExportLogger
  private readonly checkpointManager: CheckpointManager
  private readonly errorRecovery: ErrorRecoveryManager
  private readonly progressTracker: ProgressTracker

  private readonly app: App
  private isAborted: boolean = false
  private abortController: AbortController | null = null
  /** Talk 索引 -> 动作收尾时间（ms，相对 Talk 开始），用于 diagnostics 的逐帧计划。 */
  private talkSettleMsByIndex = new Map<number, number>()
  private lipSyncCache = new Map<number, ReturnType<typeof buildLipSyncEnvelope> | null>()
  private pendingLipSync = new Map<
    number,
    Promise<ReturnType<typeof buildLipSyncEnvelope> | null>
  >()
  private pcmCache = new Map<
    number,
    { channel0: Float32Array; channel1: Float32Array; sampleRate: number }
  >()
  private lastWebCodecsProbeConfig: VideoEncoderConfig | null = null

  /** 已在同一常驻 worker 页面上通过首次 WebGL/黑屏校验的 App 实例集合 */
  private static readonly warmValidatedApps = new WeakSet<object>()
  /** 按 App 实例隔离的 WebCodecs 探测缓存，避免跨复用页重复 5 帧测速 */
  private static readonly webCodecsProbeCache = new WeakMap<
    object,
    Map<string, WebCodecsProbeResult | null>
  >()

  private static readonly DEFAULT_BATCH_SIZE = 30

  constructor(app: App) {
    this.app = app
    this.logger = new ExportLogger('VideoExportManager')
    this.checkpointManager = new CheckpointManager()
    this.errorRecovery = new ErrorRecoveryManager(3)
    this.progressTracker = new ProgressTracker()
  }

  public get signal(): AbortSignal | undefined {
    return this.abortController?.signal
  }

  public abort(): void {
    this.isAborted = true
    this.abortController?.abort()
    this.app.currentTalkLipSync = null
    this.logger.info('Export aborted by user')
  }

  /**
   * 本句说话人模型的口型系数（官方 `SetLipSyncK(tvs, tvs × 1.75)` 的 tvs）。
   * MSST 剧本没有 per-talk `TargetValueScale`，用模型初值：资源名角色号属于
   * 1/4/8/12/17/18 时为 1.25，否则 1.0。
   */
  private lipScaleForSnippet(snippets: SnippetData[], index: number): number {
    const snippet = snippets[index] as { data?: { modelId?: number } } | undefined
    const modelId = snippet?.data?.modelId
    if (typeof modelId !== 'number' || modelId < 0) return 1
    let model: ReturnType<App['getModelById']> | undefined
    try {
      model = this.app.getModelById?.(modelId)
    } catch {
      // 模型尚未加载（预热早期）时退回 1.0，不让口型解码中断导出。
      model = undefined
    }
    const scale = model?.getLipSyncScale?.()
    return typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : 1
  }

  private async decodeLipSyncEnvelope(
    audioBuffer: ArrayBuffer,
    snippetIndex = -1,
    targetValueScale = 1
  ): Promise<ReturnType<typeof buildLipSyncEnvelope> | null> {
    try {
      // Offline decoding must not wait on timers while the fast frame pump is paused.
      const decoder = new OfflineAudioContext(1, 1, 48000)
      const decoded = await decoder.decodeAudioData(audioBuffer.slice(0))
      this.checkAborted()
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
      this.checkAborted()
      this.logger.warn('Speech envelope unavailable; skipping lip sync', error)
      return null
    }
  }

  private predecodeTalkLipSync(
    snippetIndex: number,
    audioBuffer?: ArrayBuffer,
    targetValueScale = 1
  ): void {
    if (
      snippetIndex < 0 ||
      !audioBuffer ||
      this.lipSyncCache.has(snippetIndex) ||
      this.pendingLipSync.has(snippetIndex)
    ) {
      return
    }
    const task = this.decodeLipSyncEnvelope(audioBuffer, snippetIndex, targetValueScale)
      .then((envelope) => {
        this.lipSyncCache.set(snippetIndex, envelope)
        return envelope
      })
      .finally(() => {
        this.pendingLipSync.delete(snippetIndex)
      })
    this.pendingLipSync.set(snippetIndex, task)
  }

  private async prepareTalkLipSync(
    audioBuffer?: ArrayBuffer,
    snippetIndex = -1,
    targetValueScale = 1
  ): Promise<void> {
    this.app.currentTalkLipSync = null
    if (snippetIndex >= 0 && this.lipSyncCache.has(snippetIndex)) {
      this.app.currentTalkLipSync = this.lipSyncCache.get(snippetIndex) ?? null
      return
    }
    if (snippetIndex >= 0 && this.pendingLipSync.has(snippetIndex)) {
      this.app.currentTalkLipSync = (await this.pendingLipSync.get(snippetIndex)) ?? null
      return
    }
    if (!audioBuffer) return
    const envelope = await this.decodeLipSyncEnvelope(audioBuffer, snippetIndex, targetValueScale)
    if (snippetIndex >= 0) this.lipSyncCache.set(snippetIndex, envelope)
    this.app.currentTalkLipSync = envelope
  }

  private getOpeningCurtainColor(snippets: SnippetData[]): 'black' | 'white' | null {
    for (const snippet of snippets) {
      if (snippet.type === 'BlackOut' || snippet.type === 'BlackIn') {
        const color = (snippet as { data?: { color?: string } }).data?.color
        return color === 'white' ? 'white' : 'black'
      }
      if (snippet.type === 'LayoutAppear' || snippet.type === 'Talk') return null
    }
    return null
  }

  private hasOpeningCurtain(snippets: SnippetData[]): boolean {
    return this.getOpeningCurtainColor(snippets) !== null
  }

  private prewarmReadyLipSync(
    snippets: SnippetData[],
    concurrentPipeline: ConcurrentExportPipeline,
    fromIndex: number,
    lookahead: number
  ): void {
    if (!this.app.ttsManager) return
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
        const buf = this.app.ttsManager.getAudioBufferForSnippet(j)
        if (buf) this.predecodeTalkLipSync(j, buf, this.lipScaleForSnippet(snippets, j))
      }
    }
  }

  /**
   * 官方 AUTO 模式在语音结束后还要等身体动作播完，再停留 0.5s。
   * 动作剪辑时长来自已预加载的 motionGroups；循环动作/未加载动作不参与（返回 0）。
   */
  private talkDurationWithMotionGate(
    talk: TalkSnippetLike,
    ttsDurationMs: number,
    windowOpenMs = 0,
    snippetIndex = -1,
    layoutRunningMs = 0,
    existingMotionSettleMs = 0,
    silentHoldMs?: number
  ): number {
    const base = calculateTalkDurationMs(talk.content, ttsDurationMs, talk.ttsText, {
      windowOpenMs,
      layoutRunningMs,
      motionSettleMs: existingMotionSettleMs,
      silentHoldMs
    })
    if (!(ttsDurationMs > 0)) return base
    const cues: Array<{ at: number; modelId: number; motion?: string }> = []
    if (talk.motion) cues.push({ at: 0, modelId: talk.modelId, motion: talk.motion })
    for (const action of talk.actions ?? []) {
      if (action.motion) cues.push(action)
    }
    let settleMs = existingMotionSettleMs
    for (const cue of cues) {
      const visible =
        this.app.layerModel.isModelVisible(cue.modelId) ||
        Boolean(this.app.layerModel.isModelShown?.(cue.modelId))
      if (!cue.motion || !visible) continue
      try {
        const model = this.app.getModelById(cue.modelId)
        if (model.isMotionLooping?.(cue.motion)) continue
        const clipMs = model.getMotionDurationMs(cue.motion)
        if (clipMs > 0) settleMs = Math.max(settleMs, cue.at * base + clipMs)
      } catch {
        /* model not loaded; the gate cannot be planned */
      }
    }
    if (settleMs > 0 && snippetIndex >= 0) this.talkSettleMsByIndex.set(snippetIndex, settleMs)
    return settleMs > 0 || layoutRunningMs > 0
      ? calculateTalkDurationMs(talk.content, ttsDurationMs, talk.ttsText, {
          motionSettleMs: settleMs,
          layoutRunningMs,
          windowOpenMs,
          silentHoldMs
        })
      : base
  }

  /** 首个 Talk（或关闭后第一句）需要 0.2s 打开对话框；连续 Talk 不再加。 */
  private talkWindowOpenMs(snippets: SnippetData[], index: number): number {
    let open = false
    for (let i = 0; i <= index; i++) {
      const snippet = snippets[i]
      if (snippet.type === 'Talk') {
        if (!open) {
          if (i === index) return TALK_WINDOW_OPEN_CLOSE_MS
          open = true
        }
        if (snippet.data.closeWindowOnFinish) {
          open = false
        }
      } else if (snippet.type === 'HideTalk') {
        open = false
      }
    }
    return 0
  }

  private resetState(): void {
    this.isAborted = false
    this.abortController = new AbortController()
    this.errorRecovery.reset()
    this.checkpointManager.clearCheckpoint()
    // 每次导出都从空日志/动作追踪开始；落盘时才能按本次导出复原。
    exportLogBus.reset()
    motionTrace.reset()
    exportTraceContext.reset()
    this.talkSettleMsByIndex.clear()
    this.lipSyncCache.clear()
    this.pendingLipSync.clear()
    this.pcmCache.clear()
    resetStageTiming(this.app)
    this.app.snippetStrategyManager?.resetBackgroundSnippets?.()
  }

  private attachDiagnostics(
    result: ExportResult,
    snippets: SnippetData[],
    timeline: SnippetTimelineEntry[],
    timestampRecorder: SnippetTimestampRecorder,
    ttsResults: Map<number, { durationMs: number; characterName: string; text: string }>,
    mode: string,
    options: VideoExportOptions,
    ttsEnabled: boolean
  ): ExportResult {
    const story = this.app.storyManager?.storyData
    const diagnostics: ExportDiagnostics = buildExportDiagnostics({
      snippets,
      timeline,
      timestamps: timestampRecorder,
      ttsResults,
      motion: motionTrace.snapshot(),
      logs: exportLogBus.snapshot(),
      exportMeta: {
        mode,
        width: options.width,
        height: options.height,
        fps: options.fps,
        frameCount: result.frameCount,
        // result.duration 是导出墙钟耗时；报告要的是成片时长。
        durationMs:
          result.timings?.videoDurationMs ??
          Math.round((result.frameCount / Math.max(1, options.fps)) * 1000),
        ...(result.outputSize !== undefined ? { outputSize: result.outputSize } : {}),
        ...(result.timings ? { timings: result.timings } : {})
      },
      provider: this.app.ttsManager?.getConfig().provider,
      ttsEnabled,
      storyCounts: story ? { models: story.models.length, images: story.images.length } : undefined,
      motionSettleMs: this.talkSettleMsByIndex
    })
    // 日志 data 里可能有 Map/Error/循环引用；必须在通过 WebSocket 回传宿主前拍平。
    result.diagnostics = sanitizeDiagnostics(diagnostics)
    this.logger.info('Export diagnostics attached', {
      snippets: diagnostics.summary.snippets,
      talks: diagnostics.summary.talks,
      anomalies: diagnostics.summary.anomalies,
      motionEvents: diagnostics.summary.motionEvents,
      logEntries: diagnostics.summary.logEntries
    })
    return result
  }

  private checkAborted(): void {
    if (this.isAborted) {
      throw ExportError.cancelled()
    }
  }

  private async yieldToBrowser(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private async requestAnimationFrameOnce(): Promise<void> {
    if (typeof window.requestAnimationFrame !== 'function') {
      await new Promise((resolve) => setTimeout(resolve, 0))
      return
    }
    return new Promise((resolve) => {
      window.requestAnimationFrame(() => resolve(undefined))
    })
  }

  private createProgressAdapter(onProgress?: ProgressCallback): InternalProgressCallback {
    return (progress: ExtendedExportProgress) => {
      if (onProgress) {
        onProgress({
          stage: progress.stage as ExportProgress['stage'],
          current: progress.current,
          total: progress.total,
          message: progress.message
        })
      }
    }
  }

  private async executeSnippet(snippet: SnippetData, index = -1): Promise<void> {
    await this.app.snippetStrategyManager.handleSnippetForExport(snippet, index)
  }

  private async processSnippetFrames(
    snippet: SnippetData,
    index: number,
    fps: number,
    canvas: HTMLCanvasElement,
    capturer: AsyncFrameCapturer
  ): Promise<number> {
    // ChangeBgm 是零时长的音频事件，不占用画面帧
    if (snippet.type === 'ChangeBgm') {
      await this.executeSnippet(snippet, index)
      return 0
    }

    const originalDurationMs = Math.round(snippet.delay * 1000)
    const frameIntervalMs = 1000 / fps
    const targetFrameCount = Math.max(1, Math.round(originalDurationMs / frameIntervalMs))

    await this.executeSnippet(snippet, index)

    const capturePromises: Promise<void>[] = []
    const batchLimit = 60

    for (let f = 0; f < targetFrameCount; f++) {
      capturePromises.push(capturer.captureFrameAsync(canvas))

      if ((f + 1) % batchLimit === 0) {
        await Promise.all(capturePromises)
        capturePromises.length = 0
        await this.yieldToBrowser()
      }
    }

    if (capturePromises.length > 0) {
      await Promise.all(capturePromises)
    }

    return targetFrameCount
  }

  async exportVideo(
    options: VideoExportOptions,
    onProgress?: ProgressCallback
  ): Promise<ExportResult> {
    this.resetState()

    const startTime = performance.now()
    const progressCallback = this.createProgressAdapter(onProgress)
    const isApiMode = options.apiMode === true

    let overlay: HTMLElement | null = null
    let progressFill: HTMLDivElement | null = null
    let exportStatus: HTMLElement | null = null

    if (!isApiMode) {
      overlay = document.getElementById('export-overlay')
      progressFill = document.getElementById('progressFill') as HTMLDivElement | null
      exportStatus = document.getElementById('exportStatus')
      if (overlay) overlay.hidden = false
    }

    try {
      this.logger.info('Starting video export', { ...options, apiMode: isApiMode })

      this.progressTracker.start()
      this.app.exporting = true

      await this.initializeExport(options, progressFill, exportStatus, progressCallback)
      this.checkAborted()

      if (options.exportMode === 'record' || options.exportMode === 'stream') {
        this.logger.warn(
          `exportMode="${options.exportMode}" is deprecated and will be removed; delegating to "fast"`
        )
      }

      if (options.exportMode !== 'frames') {
        return await this.exportVideoFast(
          { ...options, exportMode: 'fast' },
          progressFill,
          exportStatus,
          progressCallback
        )
      }

      const { canvas, framesDir, totalSnippets, startSnippetIndex, startFrameIndex } =
        await this.prepareRendering(options, progressFill, exportStatus, progressCallback)
      this.checkAborted()

      const result = await this.captureAndEncodeFrames(
        options,
        canvas,
        framesDir,
        totalSnippets,
        startSnippetIndex,
        startFrameIndex,
        progressFill,
        exportStatus,
        progressCallback
      )

      result.duration = (performance.now() - startTime) / 1000

      this.logger.info('Export completed successfully', {
        duration: result.duration,
        frameCount: result.frameCount
      })

      if (!isApiMode) {
        await this.showCompletionMessage(progressFill!, exportStatus!, progressCallback)
      }

      return result
    } catch (error) {
      return await this.handleExportError(
        error,
        exportStatus || (typeof document !== 'undefined' ? document.body : null),
        startTime
      )
    } finally {
      this.cleanup()
    }
  }

  /** best-effort 删除导出临时文件/目录（不存在时静默） */
  private async removeTempPaths(paths: Array<string | null | undefined>): Promise<void> {
    for (const target of paths) {
      if (!target) continue
      try {
        await window.electron.ipcRenderer.invoke('electron:delete-temp-file', {
          filePath: target
        })
      } catch (error) {
        this.logger.warn(`Failed to remove temp path: ${target}`, error)
      }
    }
  }

  /**
   * fast 模式页内编码路径选择（对齐 ournotes-player 硬件探测与 5 帧测速）：
   * - 'frames'：直接走 JPEG 帧序列（image2pipe）
   * - 'webcodecs'：尽量走 WebCodecs
   * - 'auto'：拒绝软件 WebGL / Linux+NVIDIA 等软编路径，校验 prefer-hardware 并做 5 帧 <=150ms 测速；
   *           慢路径自动回落 image2pipe。结果按 app 实例缓存避免复用 worker 重复测速。
   */
  private async resolveFastUseWebCodecs(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    fps: number,
    bitrate: number,
    choice: 'auto' | 'webcodecs' | 'frames',
    gpuRenderer: 'auto' | 'nvidia' | 'amd' | 'intel' | 'cpu' = 'auto'
  ): Promise<boolean> {
    this.lastWebCodecsProbeConfig = null
    if (choice === 'frames') return false
    if (typeof WebCodecsMp4Encoder?.probeConfig !== 'function') return false

    const cacheKey = `${width}x${height}@${fps}:${bitrate}:${choice}:${gpuRenderer}`
    let appCache = VideoExportManager.webCodecsProbeCache.get(this.app)
    if (appCache?.has(cacheKey)) {
      const cached = appCache.get(cacheKey) ?? null
      this.lastWebCodecsProbeConfig = cached?.config ?? null
      return cached !== null
    }

    const probe = await WebCodecsMp4Encoder.probeConfig({
      width,
      height,
      fps,
      bitrate,
      mode: choice,
      canvas,
      gpuRenderer,
      benchmark: choice === 'auto'
    })

    if (!appCache) {
      appCache = new Map()
      VideoExportManager.webCodecsProbeCache.set(this.app, appCache)
    }
    appCache.set(cacheKey, probe)

    if (!probe) {
      this.logger.info(
        `Fast export: WebCodecs probe fell back to image2pipe (choice=${choice}, gpu=${gpuRenderer})`
      )
      return false
    }

    this.lastWebCodecsProbeConfig = probe.config
    if (probe.elapsedMs > 0) {
      this.logger.info(
        `Fast export: WebCodecs ready (${probe.config.codec}, ${probe.elapsedMs.toFixed(1)}ms for 5 frames, gl=${probe.glRenderer || 'unknown'})`
      )
    }
    return true
  }

  /**
   * fast 导出模式：虚拟时钟逐帧渲染 + 页内 WebCodecs 直编（回退 image2pipe）。
   */
  private async exportVideoFast(
    options: VideoExportOptions,
    progressFill: HTMLDivElement | null,
    exportStatus: HTMLElement | null,
    onProgress: InternalProgressCallback
  ): Promise<ExportResult> {
    const { canvas, snippets } = await this.prepareStreamRecording(
      options,
      progressFill,
      exportStatus,
      onProgress
    )
    this.checkAborted()

    const fps = options.fps
    const outW = options.width
    const outH = options.height
    const bitrate = options.exportBitrate ?? 12_000_000
    // 编码帧率独立于时间轴：动画仍按 options.fps 的虚拟时间推进，
    // 但每帧 GPU 读回很贵。用 video.fastFps（默认 30）封顶，时长不变。
    const fastFpsCap = Math.max(1, Math.min(options.fastFps ?? 30, fps))
    const encodeFps = fastFpsCap
    const frameMs = 1000 / encodeFps

    this.logger.info('Starting fast export (virtual clock)', {
      fps,
      encodeFps,
      width: outW,
      height: outH,
      bitrate,
      snippetCount: snippets.length
    })

    let ttsEnabled = this.app.ttsManager?.isTTSEnabled() ?? false
    if (ttsEnabled) {
      this.logger.info('Checking TTS service availability...')
      const available = await this.app.ttsManager!.checkTTSAvailability()
      if (!available) {
        this.logger.warn('TTS service not available. Disabling TTS for this export.')
        ttsEnabled = false
      }
    }

    const bgmConfig = this.app.ttsManager?.getBGMConfig()
    const bgmEnabled = bgmConfig?.enabled ?? false
    const bgmPlan = new BgmPlan(snippets)
    const sePlan = new SePlan(snippets)
    const audioMuxer = new AudioMuxer()
    const useGlobalBgm = bgmEnabled && !bgmPlan.hasStoryFiles

    const ttsAudioResults = new Map<
      number,
      {
        audioBuffer: ArrayBuffer
        pcmData?: { channel0: Float32Array; channel1: Float32Array; sampleRate: number }
        durationMs: number
        characterName: string
        text: string
        preDecoded: boolean
      }
    >()

    const timelineOptions: TimelineOptions = { exportFps: encodeFps, ttsEnabled }
    const timeline: SnippetTimelineEntry[] = (
      this.app.ttsManager.buildTimelineWithoutTTS as (
        s: SnippetData[],
        o?: TimelineOptions
      ) => SnippetTimelineEntry[]
    )(snippets, timelineOptions)
    this.app.ttsManager.setTimeline(timeline)

    const virtualClock = new VirtualClockController()
    const timestampRecorder = new SnippetTimestampRecorder()
    const configuredTtsTimeoutMs = this.app.ttsManager?.getConfig?.().timeoutMs ?? 120_000
    const concurrentPipeline = new ConcurrentExportPipeline({
      ttsLookahead: 3,
      ttsTimeoutMs: Math.max(30_000, configuredTtsTimeoutMs),
      targetFps: fps,
      maxConcurrentTts: 3,
      waitMs: (ms) => virtualClock.realSleep(ms),
      nowMs: () => virtualClock.realTimeMs(),
      onTtsReady: ttsEnabled
        ? (snippetIndex, res) => {
            if (res.success && res.duration > 0) {
              const buf = this.app.ttsManager?.getAudioBufferForSnippet(snippetIndex)
              if (buf) {
                this.predecodeTalkLipSync(
                  snippetIndex,
                  buf,
                  this.lipScaleForSnippet(snippets, snippetIndex)
                )
              }
            }
          }
        : undefined
    })

    const serialTts = (options.ttsMode ?? 'concurrent') === 'serial'
    if (ttsEnabled) {
      this.logger.info(
        serialTts
          ? 'Serial mode: Synthesizing all TTS before fast rendering'
          : 'Concurrent mode: Starting TTS pipeline (maxConcurrentTts=3) alongside rendering'
      )
      // 尽早启动 TTS 管线，使其网络合成与 BGM/SE 加载、WebCodecs 探测完全重叠
      concurrentPipeline.startTTSPipeline(
        snippets,
        this.app.ttsManager,
        (current, total, message) => {
          this.logger.info(`[TTS Pipeline] ${current}/${total}: ${message}`)
        }
      )
    }

    const [useWebCodecs, bgmBuffer] = await Promise.all([
      this.resolveFastUseWebCodecs(
        canvas,
        outW,
        outH,
        encodeFps,
        bitrate,
        options.exportFastEncoder ?? 'auto',
        options.gpuRenderer ?? 'auto'
      ),
      (async (): Promise<AudioBuffer | null> => {
        await Promise.all([
          bgmEnabled && bgmPlan.hasStoryFiles ? bgmPlan.load(audioMuxer) : Promise.resolve(),
          sePlan.hasChanges ? sePlan.load(audioMuxer) : Promise.resolve()
        ])
        if (bgmEnabled && bgmConfig) {
          audioMuxer.setBGMConfig(bgmConfig)
          if (useGlobalBgm) {
            try {
              return await audioMuxer.loadBGMBuffer(resolveBgmUrl(bgmConfig.path))
            } catch (error) {
              this.logger.warn(`Failed to load BGM: ${error}`)
            }
          }
        }
        return null
      })()
    ])
    this.checkAborted()

    const bgmActive = bgmEnabled && (bgmPlan.hasLoadedFiles || bgmBuffer !== null)

    if (ttsEnabled && serialTts) {
      onProgress({
        stage: 'loading',
        current: 0,
        total: 1,
        message: '正在串行合成语音…',
        percentage: 20
      })
      await concurrentPipeline.waitForTTSPipeline()
      this.checkAborted()
      for (let idx = 0; idx < snippets.length; idx++) {
        if (snippets[idx].type !== 'Talk') continue
        const res = await concurrentPipeline.waitForTTSReady(idx)
        if (res?.success && res.duration > 0) {
          const buf = this.app.ttsManager.getAudioBufferForSnippet(idx)
          if (buf) this.predecodeTalkLipSync(idx, buf, this.lipScaleForSnippet(snippets, idx))
        }
      }
      if (this.pendingLipSync.size > 0) {
        await Promise.allSettled([...this.pendingLipSync.values()])
        this.checkAborted()
      }
      if (exportStatus) exportStatus.textContent = '语音合成完成，开始渲染…'
    }

    // sink 由 createSink 异步创建；放进对象属性可避免 TS 控制流把裸 let
    // 收窄成 never（异步赋值不参与收窄）。
    const sinks: {
      encoder: WebCodecsMp4Encoder | null
      jpegSink: JpegFrameSink | null
      framesDir: string | null
      tempBaseDir: string | null
      audioFilePath: string | null
      pipeTempDir: string | null
    } = {
      encoder: null,
      jpegSink: null,
      framesDir: null,
      tempBaseDir: null,
      audioFilePath: null,
      pipeTempDir: null
    }

    const createJpegSink = async (): Promise<void> => {
      const jpegSink = new JpegFrameSink({
        width: outW,
        height: outH,
        quality: Math.max(this.getJpegQuality(options.quality), 0.92),
        fps: encodeFps,
        crf: options.apiCrf ?? options.crf ?? 23
      })
      await jpegSink.initialize(canvas)
      sinks.jpegSink = jpegSink
      sinks.framesDir = jpegSink.framesDirectory || null
    }

    const createSink = async (): Promise<void> => {
      if (sinks.encoder || sinks.jpegSink) return
      const encoderChoice = options.exportFastEncoder ?? 'auto'
      if (useWebCodecs) {
        const tempDir = await window.electron.ipcRenderer.invoke('electron:get-temp-base-dir')
        sinks.tempBaseDir = tempDir
        const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const videoFilePath = `${tempDir}/mss-fast-${uniqueSuffix}.mp4`
        const encoder = new WebCodecsMp4Encoder({
          width: outW,
          height: outH,
          fps: encodeFps,
          bitrate,
          encoderConfig: this.lastWebCodecsProbeConfig
        })
        try {
          await encoder.initialize(videoFilePath)
          sinks.encoder = encoder
          this.logger.info(`Fast export: WebCodecs MP4 → ${videoFilePath}`)
          return
        } catch (initErr) {
          encoder.dispose()
          if (encoderChoice === 'webcodecs') {
            throw initErr
          }
          this.logger.warn(
            'WebCodecs runtime initialization failed, falling back to JPEG pipe:',
            initErr
          )
        }
      }
      await createJpegSink()
    }

    await createSink()

    const realStart = virtualClock.realTimeMs()

    // fast 模式每帧只渲染一次：停掉应用私有 ticker，由帧泵在故事步推进后显式 render；
    // Ticker.shared 在导出期间不启动（VirtualClockController 会 autoStart=false + stop），
    // 每个 1/60 故事步由帧泵显式 update 一次，不再由 16ms rAF 驱动。
    this.app.pixiApplication.ticker.stop()
    this.logger.info('Fast export: app render ticker stopped, rendering once per frame')

    AnimationManager.exportTargetFPS = STORY_FPS
    AnimationManager.exportEncodeFPS = encodeFps
    const prevTickerMaxFps = Ticker.shared.maxFPS
    Ticker.shared.maxFPS = 0

    virtualClock.install()
    const virtualRenderStartMs = virtualClock.now()
    timestampRecorder.markRenderStart()
    concurrentPipeline.markRenderStart()

    // 分段计时（真实墙钟；虚拟时钟下 performance.now 是虚拟时间）
    let pumpMs = 0
    let tickMs = 0
    let renderMs = 0
    let snapshotMs = 0
    let ttsWaitMs = 0
    let encodeMs = 0
    let audioMs = 0
    let invokeMs = 0

    let pumpPaused = false
    let pumpDone = false
    let pumpResumeResolve: (() => void) | null = null
    const setPumpPaused = (paused: boolean): void => {
      pumpPaused = paused
      if (!paused && pumpResumeResolve) {
        const wake = pumpResumeResolve
        pumpResumeResolve = null
        wake()
      }
    }
    const waitPumpResumed = (): Promise<void> =>
      new Promise<void>((resolve) => {
        if (!pumpPaused || pumpDone || this.isAborted) {
          resolve()
          return
        }
        pumpResumeResolve = resolve
      })

    // 帧 0 必须等第一个片段真正启动后再渲染，否则会拍到片段应用之前的默认舞台
    let signalFirstSnippet: (() => void) | null = null
    const firstSnippetStarted = new Promise<void>((resolve) => {
      signalFirstSnippet = resolve
    })
    const markFirstSnippetStarted = (): void => {
      const resolve = signalFirstSnippet
      signalFirstSnippet = null
      resolve?.()
    }

    const abortFastWait = (): void => {
      concurrentPipeline.abort()
      markFirstSnippetStarted()
      AnimationManager.resetExportStepHandlers()
      setPumpPaused(false)
      pumpDone = true
    }
    this.signal?.addEventListener('abort', abortFastWait)

    /** 尾部追帧目标（虚拟毫秒）：片段循环结束后让帧泵跑到这个虚拟时间再停 */
    let pumpTargetVirtualMs = -1
    let pumpError: Error | null = null
    let blackFrameValidationCount = 0
    frameValidator.reset()
    let frameIndex = 0
    /** 已执行的固定 1/60 故事步数 */
    let storyStep = 0

    /** 输出帧 k 对应的故事步：floor(k×60/fps)，非整除帧率按余量分配。 */
    const storyStepForFrame = (frame: number): number =>
      Math.floor((frame * STORY_FPS) / encodeFps)

    const advanceToStoryStep = async (target: number): Promise<void> => {
      if (target <= storyStep) return
      const tickStart = virtualClock.realTimeMs()
      await virtualClock.advanceStorySteps(target - storyStep, () => {
        AnimationManager.dispatchExportStep(Ticker.shared)
      })
      storyStep = target
      tickMs += virtualClock.realTimeMs() - tickStart
    }

    const framePump = (async (): Promise<void> => {
      try {
        await firstSnippetStarted
        const shouldStop = (): boolean => {
          if (!pumpDone) return false
          if (pumpTargetVirtualMs < 0) return true
          if (frameIndex === 0) return false
          return frameIndex * frameMs >= pumpTargetVirtualMs - 1e-6
        }
        while (!shouldStop()) {
          this.checkAborted()
          if (pumpPaused && !pumpDone) {
            await waitPumpResumed()
            continue
          }
          const frameStart = virtualClock.realTimeMs()

          // 帧 n = 故事时间 n/fps：先把模拟推进到 floor(n×60/fps) 个 1/60 步，再渲染。
          await advanceToStoryStep(storyStepForFrame(frameIndex))

          const renderStart = virtualClock.realTimeMs()
          this.app.pixiApplication.render()
          renderMs += virtualClock.realTimeMs() - renderStart

          const timestampUs = Math.round(frameIndex * (1_000_000 / encodeFps))
          const durationUs = Math.round(1_000_000 / encodeFps)
          // 片尾淡出至黑时 4 秒一个关键帧会把近黑渐变做成大块。
          // 最后约 0.6s 改为每 4 帧一个关键帧，硬件编码器也能跟上暗部变化。
          const nextFrameVirtualMs = virtualRenderStartMs + (frameIndex + 1) * frameMs
          const tailFrames = Math.ceil(encodeFps * 0.6)
          const inEndingTail =
            pumpTargetVirtualMs >= 0 &&
            nextFrameVirtualMs > pumpTargetVirtualMs - 600 &&
            frameIndex > Math.max(0, Math.ceil(pumpTargetVirtualMs / frameMs) - tailFrames)
          const keyFrame = inEndingTail ? frameIndex % 4 === 0 : frameIndex % (encodeFps * 4) === 0

          const captureStart = virtualClock.realTimeMs()
          if (sinks.encoder) {
            await sinks.encoder.encodeFrame(canvas, timestampUs, durationUs, keyFrame)
          } else if (sinks.jpegSink) {
            await sinks.jpegSink.captureFrame(canvas)
          }
          snapshotMs += virtualClock.realTimeMs() - captureStart

          if (frameIndex % (encodeFps * 5) === 0) {
            const v = frameValidator.validateFrame(canvas, frameIndex)
            if (!v.isValid && v.error) {
              VideoExportManager.warmValidatedApps.delete(this.app)
              throw new Error(
                `Rendering validation failed at frame ${frameIndex}: ${v.error}. ` +
                  `Brightness: ${v.brightness.toFixed(2)}%`
              )
            }
            if (v.isBlackScreen) {
              blackFrameValidationCount++
              if (blackFrameValidationCount >= 5) {
                VideoExportManager.warmValidatedApps.delete(this.app)
                throw new Error(
                  `Detected ${blackFrameValidationCount} black frames during fast export. ` +
                    `Models are not rendering.`
                )
              }
            } else {
              blackFrameValidationCount = 0
            }
          }

          frameIndex++
          pumpMs += virtualClock.realTimeMs() - frameStart
        }
      } catch (e) {
        pumpError = e instanceof Error ? e : new Error(String(e))
      }
    })()

    try {
      const totalSnippets = snippets.length
      if (totalSnippets === 0) markFirstSnippetStarted()
      const extendedApp = this.app as unknown as ExtendedApp
      const openingCurtainColor = this.getOpeningCurtainColor(snippets)
      if (openingCurtainColor) {
        const sfxLayer = (
          this.app as {
            layerSpecialEffect?: {
              fadeOut?: (duration: number, color?: 'black' | 'white') => Promise<void>
            }
          }
        ).layerSpecialEffect
        await sfxLayer?.fadeOut?.(0, openingCurtainColor)
      }
      const openingCoverTask = openingCurtainColor
        ? undefined
        : extendedApp.setOpeningCover?.(OPENING_COVER_FADE_MS)
      void openingCoverTask?.catch(() => undefined)

      const pendingTimestampTasks: Promise<void>[] = []
      const flushPendingTimestamps = async (): Promise<void> => {
        if (pendingTimestampTasks.length === 0) return
        const batch = [...pendingTimestampTasks]
        pendingTimestampTasks.length = 0
        await Promise.allSettled(batch)
      }

      for (let i = 0; i < totalSnippets; i++) {
        this.checkAborted()
        if (pumpError) throw pumpError

        const snippet = snippets[i]
        if (snippetHasPreFence(snippet)) {
          await this.app.snippetStrategyManager?.waitForPreFence?.(snippet)
          await flushPendingTimestamps()
        }

        exportTraceContext.setSnippet(i, snippet.type)
        const isTalk = snippet.type === 'Talk'
        const talkData = snippet.type === 'Talk' ? snippet.data : undefined
        const nowMs = performance.now()
        const layoutRunningMs = isTalk ? Math.max(0, getLayoutRunningEndMs(this.app) - nowMs) : 0
        const existingMotionSettleMs = isTalk
          ? Math.max(0, getMotionSettledEndMs(this.app) - nowMs)
          : 0

        let resolvedTalkDurationMs: number | undefined
        if (ttsEnabled && talkData) {
          const ttsReadyNow = concurrentPipeline.isTTSReady(i)
          if (!ttsReadyNow) {
            setPumpPaused(true)
          }
          const ttsWaitStart = virtualClock.realTimeMs()
          const ttsResult =
            ttsReadyNow && typeof concurrentPipeline.getTTSResult === 'function'
              ? concurrentPipeline.getTTSResult(i)
              : await concurrentPipeline.waitForTTSReady(i)
          if (!ttsReadyNow) {
            ttsWaitMs += virtualClock.realTimeMs() - ttsWaitStart
          }

          const ttsDurationMs =
            ttsResult?.success && Number.isFinite(ttsResult.duration) && ttsResult.duration > 0
              ? ttsResult.duration
              : 0
          const silentHoldMs =
            ttsDurationMs <= 0 &&
            !(talkData as { voice?: string }).voice &&
            !hasSpeakableSpeechText(talkData.ttsText ?? '') &&
            !hasSpeakableSpeechText(talkData.content ?? '')
              ? SILENT_PUNCTUATION_HOLD_MS
              : undefined
          resolvedTalkDurationMs = applyTalkPatch(
            timeline,
            i,
            ttsDurationMs,
            this.talkDurationWithMotionGate(
              talkData as unknown as TalkSnippetLike,
              ttsDurationMs,
              this.talkWindowOpenMs(snippets, i),
              i,
              layoutRunningMs,
              existingMotionSettleMs,
              silentHoldMs
            )
          )
          if (ttsDurationMs > 0) {
            const rawAudioBuffer = this.app.ttsManager.getAudioBufferForSnippet(i)
            if (rawAudioBuffer) {
              ttsAudioResults.set(i, {
                audioBuffer: rawAudioBuffer,
                pcmData: this.pcmCache.get(i),
                durationMs: ttsDurationMs,
                characterName: talkData.speaker,
                text: talkData.content,
                preDecoded: false
              })
            }
          }
          this.app.ttsManager.setTimeline(timeline)
          this.prewarmReadyLipSync(snippets, concurrentPipeline, i + 1, 3)

          if (pumpError) {
            setPumpPaused(false)
            throw pumpError
          }

          const audioEntry = ttsAudioResults.get(i)
          const needsDecodeWait = !this.lipSyncCache.has(i) && Boolean(audioEntry?.audioBuffer)
          if (needsDecodeWait && !pumpPaused) {
            setPumpPaused(true)
          }
          await this.prepareTalkLipSync(
            audioEntry?.audioBuffer,
            i,
            this.lipScaleForSnippet(snippets, i)
          )
          const decodedPcm = this.pcmCache.get(i)
          if (decodedPcm && audioEntry && !audioEntry.pcmData) {
            audioEntry.pcmData = decodedPcm
          }
          if (pumpPaused) {
            setPumpPaused(false)
          }
        } else if (isTalk) {
          this.app.currentTalkLipSync = null
        }

        const timelineEntry = timeline[i]
        const pct = 30 + Math.round(((i + 1) / totalSnippets) * 60)
        if (progressFill) progressFill.style.width = `${pct}%`
        onProgress({
          stage: 'capturing',
          current: i + 1,
          total: totalSnippets,
          message: `处理片段 ${i + 1}/${totalSnippets}`,
          percentage: pct
        })

        this.app.lastSnippetActualDurationMs =
          resolvedTalkDurationMs ??
          timelineEntry?.durationMs ??
          (snippet.type === 'Talk'
            ? this.talkDurationWithMotionGate(
                snippet.data as unknown as TalkSnippetLike,
                0,
                this.talkWindowOpenMs(snippets, i),
                i,
                layoutRunningMs,
                existingMotionSettleMs
              )
            : Math.max(Math.round((snippet.delay || 0) * 1000), estimateSnippetDuration(snippet)))

        if (isTalk) {
          this.app.currentTalkStartedAtMs = 0
          timestampRecorder.markSnippetStart(i, snippet.type, {
            speaker: talkData?.speaker,
            content: talkData?.content
          })
        }

        const snippetStartedAtMs = performance.now()
        await this.app.snippetStrategyManager.handleSnippetForExport(snippet, i)
        if (i === 0) markFirstSnippetStarted()
        const hasAsyncTaskTracker =
          typeof this.app.snippetStrategyManager?.getLastLaunchedTask === 'function'
        const launchedTask = hasAsyncTaskTracker
          ? this.app.snippetStrategyManager.getLastLaunchedTask()
          : null

        const ttsDur = ttsAudioResults.get(i)?.durationMs
        if (isTalk) {
          // speechOffset 必须在定义处立即捕获：launchedTask 可能跨句 resolve，
          // 届时 currentTalkStartedAtMs 已被下一句 Talk 覆盖，闭包惰性求值会记错口型起点。
          const speechOffsetMs =
            this.app.currentTalkStartedAtMs > 0
              ? this.app.currentTalkStartedAtMs - snippetStartedAtMs
              : 0
          const recordEnd = (): void => {
            timestampRecorder.markSnippetEnd(ttsDur, speechOffsetMs)
          }
          if (launchedTask) {
            pendingTimestampTasks.push(launchedTask.then(recordEnd, () => {}))
          } else {
            recordEnd()
          }
        } else if (launchedTask) {
          pendingTimestampTasks.push(
            launchedTask.then(
              () => {
                timestampRecorder.recordSnippet(
                  i,
                  snippet.type,
                  snippetStartedAtMs,
                  performance.now()
                )
              },
              () => {}
            )
          )
        } else {
          timestampRecorder.recordSnippet(i, snippet.type, snippetStartedAtMs, performance.now())
        }
      }

      // 官方 WaitAllFinished + 开场黑幕收尾 + 0.25s 停留 + 0.25s BGM/黑幕淡出。
      await this.app.snippetStrategyManager?.settleBackgroundSnippets?.()
      await flushPendingTimestamps()
      if (openingCoverTask) await openingCoverTask

      const hasEndingEnvelope = typeof extendedApp.setEndingEnvelope === 'function'
      const endingEnvelopeMs = hasEndingEnvelope
        ? PLAYED_WAIT_TIME_MS + SCENARIO_EXIT_BGM_FADE_MS
        : 0
      if (hasEndingEnvelope) {
        await extendedApp.setEndingEnvelope!(PLAYED_WAIT_TIME_MS, SCENARIO_EXIT_BGM_FADE_MS)
      }

      // 尾部追帧：让帧泵渲染到「最后一个片段及收尾黑幕的虚拟结束时间」
      const maxTimelineEndMs = timeline.reduce((max, entry) => Math.max(max, entry.endTimeMs), 0)
      pumpTargetVirtualMs = Math.max(
        virtualClock.now(),
        virtualRenderStartMs + maxTimelineEndMs + endingEnvelopeMs
      )
      setPumpPaused(false)
      pumpDone = true
      await framePump
      if (pumpError) throw pumpError

      concurrentPipeline.markRenderEnd()
      timestampRecorder.logSummary()

      let videoFilePath: string
      const encodeStart = virtualClock.realTimeMs()
      if (sinks.encoder) {
        videoFilePath = await sinks.encoder.finish()
      } else {
        videoFilePath = await sinks.jpegSink!.finish()
        if (sinks.jpegSink!.isPipeMode) {
          sinks.pipeTempDir = videoFilePath.replace(/[\\/][^\\/]*$/, '')
        }
      }
      encodeMs = virtualClock.realTimeMs() - encodeStart

      virtualClock.uninstall()

      const actualVideoDurationMs = timestampRecorder.getTotalVideoDurationMs()
      const capturedVideoDurationMs = Math.round((frameIndex / encodeFps) * 1000)
      const totalDurationMs = Math.max(
        actualVideoDurationMs + endingEnvelopeMs,
        capturedVideoDurationMs
      )
      const hasTtsTracks = ttsEnabled && ttsAudioResults.size > 0

      const actualStartTimesMs = snippets.map((_, index) =>
        timestampRecorder.getVideoRelativeStartTimeMs(index)
      )
      if (bgmPlan.hasChanges) {
        audioMuxer.setBgmCues(bgmPlan.build(actualStartTimesMs, useGlobalBgm ? bgmBuffer : null))
      }
      if (sePlan.hasChanges) {
        audioMuxer.setSeCues(sePlan.build(actualStartTimesMs))
      }

      let audioFilePath: string | undefined
      if (hasTtsTracks || bgmActive || sePlan.hasChanges) {
        const audioStart = virtualClock.realTimeMs()
        if (hasTtsTracks) {
          const audioPlacements = timestampRecorder.buildAudioTrackPlacements(ttsAudioResults)
          for (const placement of audioPlacements) {
            audioMuxer.addAudioTrack({
              audioBuffer: placement.audioBuffer,
              pcmData: placement.pcmData,
              startTime: placement.startTimeMs,
              endTime: placement.endTimeMs,
              characterName: placement.characterName,
              text: placement.text
            })
          }
        }

        let wavBuffer: ArrayBuffer
        const mixInputBgm = bgmBuffer || undefined
        if (
          typeof (audioMuxer as unknown as { mixToInt16Interleaved?: unknown })
            .mixToInt16Interleaved === 'function' &&
          typeof (audioMuxer as unknown as { encodeWavFromInt16?: unknown }).encodeWavFromInt16 ===
            'function'
        ) {
          const pcm = await audioMuxer.mixToInt16Interleaved(totalDurationMs, mixInputBgm)
          wavBuffer = audioMuxer.encodeWavFromInt16(pcm)
        } else {
          const mixedAudioBuffer = await audioMuxer.mixAudioTracks(totalDurationMs, mixInputBgm)
          wavBuffer = await audioMuxer.audioBufferToWav(mixedAudioBuffer)
        }
        this.pcmCache.clear()
        this.lipSyncCache.clear()

        audioFilePath = await window.electron.ipcRenderer.invoke('electron:write-temp-file', {
          data: wavBuffer,
          prefix: 'mss-audio',
          extension: 'wav'
        })
        sinks.audioFilePath = audioFilePath ?? null
        audioMs = virtualClock.realTimeMs() - audioStart
      }

      if (exportStatus) exportStatus.textContent = '正在合成视频…'
      onProgress({
        stage: 'saving',
        current: 1,
        total: 1,
        message: '正在合成视频...',
        percentage: 95
      })

      const outputPath = options.apiOutputPath ?? ''
      const audioBitrate = options.apiAudioBitrate ?? '128k'

      let saveResult: { success: boolean; error?: string; fileSize?: number }
      const invokeStart = virtualClock.realTimeMs()
      if (sinks.encoder || sinks.jpegSink?.isPipeMode) {
        saveResult = await window.electron.ipcRenderer.invoke(
          'electron:api-remux-video-from-files',
          {
            videoPath: videoFilePath,
            audioPath: audioFilePath,
            outputPath,
            audioBitrate
          }
        )
      } else {
        const framesDir = sinks.framesDir || videoFilePath
        if (!framesDir) throw new Error('JPEG frame sink produced no frames directory')
        saveResult = await window.electron.ipcRenderer.invoke('electron:api-encode-frames-video', {
          framesDir,
          audioPath: audioFilePath,
          outputPath,
          fps: encodeFps,
          audioBitrate,
          inputWidth: outW,
          inputHeight: outH
        })
      }
      invokeMs = virtualClock.realTimeMs() - invokeStart

      if (!saveResult?.success) {
        throw new Error(saveResult?.error || 'Video assembly failed on host')
      }

      VideoExportManager.warmValidatedApps.add(this.app)

      const timings: Record<string, number> = {
        pumpMs: Math.round(pumpMs),
        tickMs: Math.round(tickMs),
        renderMs: Math.round(renderMs),
        snapshotMs: Math.round(snapshotMs),
        ttsWaitMs: Math.round(ttsWaitMs),
        encodeMs: Math.round(encodeMs),
        audioMs: Math.round(audioMs),
        invokeMs: Math.round(invokeMs),
        frames: frameIndex,
        avgPumpFps: pumpMs > 0 ? Math.round((frameIndex / (pumpMs / 1000)) * 10) / 10 : 0
      }

      const result = {
        success: true,
        duration: (virtualClock.realTimeMs() - realStart) / 1000,
        frameCount: frameIndex,
        outputSize: saveResult.fileSize,
        timings
      }

      this.logger.info(
        `Fast export phase timings: pump=${pumpMs.toFixed(0)}ms ` +
          `(tick=${tickMs.toFixed(0)}ms render=${renderMs.toFixed(0)}ms ` +
          `capture=${snapshotMs.toFixed(0)}ms) ` +
          `ttsWait=${ttsWaitMs.toFixed(0)}ms encode=${encodeMs.toFixed(0)}ms ` +
          `audio=${audioMs.toFixed(0)}ms invoke=${invokeMs.toFixed(0)}ms ` +
          `frames=${frameIndex} ` +
          `avgPumpFps=${pumpMs > 0 ? (frameIndex / (pumpMs / 1000)).toFixed(1) : '0'}`
      )
      this.logger.info('Fast export completed', result)
      this.attachDiagnostics(
        result,
        snippets,
        timeline,
        timestampRecorder,
        ttsAudioResults,
        'fast',
        options,
        ttsEnabled
      )
      return result
    } catch (error) {
      VideoExportManager.warmValidatedApps.delete(this.app)
      markFirstSnippetStarted()
      AnimationManager.resetExportStepHandlers()
      setPumpPaused(false)
      pumpDone = true
      sinks.encoder?.dispose()
      if (sinks.jpegSink) {
        await sinks.jpegSink.dispose().catch(() => undefined)
      }
      await framePump.catch(() => undefined)
      this.logger.error('Fast export failed', error)
      throw error
    } finally {
      this.signal?.removeEventListener('abort', abortFastWait)
      AnimationManager.resetExportStepHandlers()
      Ticker.shared.maxFPS = prevTickerMaxFps
      try {
        virtualClock.uninstall()
      } catch {
        /* already uninstalled */
      }
      try {
        this.app.pixiApplication.ticker.start()
        this.logger.info('Fast export: app render ticker restored')
      } catch {
        /* renderer may already be destroyed */
      }
      sinks.encoder?.dispose()
      if (sinks.jpegSink) await sinks.jpegSink.dispose()
      this.pcmCache.clear()
      this.lipSyncCache.clear()
      this.pendingLipSync.clear()
      const framesRootDir =
        typeof sinks.framesDir === 'string' ? sinks.framesDir.replace(/[\\/]+frames$/, '') : null
      await this.removeTempPaths([
        sinks.tempBaseDir,
        framesRootDir,
        sinks.audioFilePath,
        sinks.pipeTempDir
      ])
      await concurrentPipeline.dispose()
      audioMuxer.dispose()
      this.app.ttsManager?.clearAudioTracks()
    }
  }

  private async prepareStreamRecording(
    options: VideoExportOptions,
    _progressFill: HTMLDivElement | null,
    exportStatus: HTMLElement | null,
    _onProgress: InternalProgressCallback
  ): Promise<{ canvas: HTMLCanvasElement; snippets: SnippetData[]; captureFps: number }> {
    const isApiMode = options.apiMode === true

    AnimationManager.setExportMode(true)
    AnimationManager.exportSpeedMultiplier = 1
    const fastFpsCap = Math.max(1, Math.min(options.fastFps ?? 30, options.fps))
    AnimationManager.exportTargetFPS = Math.max(STORY_FPS, fastFpsCap)
    AnimationManager.exportEncodeFPS = fastFpsCap

    const captureFps = options.fps

    if (isApiMode) {
      this.logger.info('API mode: skipping story reload, using pre-initialized story data')
    }

    const canvas = this.app.pixiApplication.view as HTMLCanvasElement
    this.logger.info(`Canvas size: ${canvas.width}x${canvas.height}`)

    if (canvas.width === 0 || canvas.height === 0) {
      throw ExportError.invalidCanvas(canvas.width, canvas.height)
    }

    const snippets = this.app.storyManager.snippets

    const gl =
      typeof canvas.getContext === 'function'
        ? canvas.getContext('webgl2') || canvas.getContext('webgl')
        : null
    const glLost = Boolean(gl && typeof gl.isContextLost === 'function' && gl.isContextLost())
    const skipWarmValidation = VideoExportManager.warmValidatedApps.has(this.app) && !glLost

    if (skipWarmValidation) {
      this.logger.info('Warm worker page: skipping redundant WebGL shader/readPixels validation')
      this.app.pixiApplication.render?.()
    } else {
      VideoExportManager.warmValidatedApps.delete(this.app)
      this.logger.info('Performing pre-export WebGL validation...')
      if (exportStatus) exportStatus.textContent = '正在验证渲染环境...'

      const validationResult = await webGLValidator.validateCanvas(canvas)
      if (!validationResult.success) {
        const errorDetails = validationResult.errors.join('; ')
        this.logger.error('WebGL validation failed before export:', validationResult)
        throw new Error(
          `WebGL rendering validation failed: ${errorDetails}. ` +
            `Please check GPU drivers, model files, and rendering environment. ` +
            `GPU: ${validationResult.contextInfo.renderer || 'unknown'}`
        )
      }

      this.logger.info('Validating model rendering output...')
      if (exportStatus) exportStatus.textContent = '正在验证模型渲染...'

      await this.runWithValidationProbe(canvas, async () => {
        this.app.pixiApplication.render?.()
        const modelValidation = await webGLValidator.validateModelRendering(canvas, 3000)
        if (!modelValidation.success) {
          throw new Error(
            `Model rendering validation failed: black screen detected ` +
              `(brightness: ${modelValidation.averageBrightness.toFixed(2)}%). ` +
              `Models are not rendering properly. Check WebGL context and model files.`
          )
        }
      })

      VideoExportManager.warmValidatedApps.add(this.app)
      this.logger.info('Pre-export validation passed')
    }

    // 第一次把角色加进舞台会触发纹理上传/着色器编译（约 50~120ms）。在导出开始前
    // 以 alpha=0.01 预画一帧，让 GPU 资源就绪，但不影响成片。
    await this.prewarmStoryModels()

    return { canvas, snippets, captureFps }
  }

  /**
   * 导出阶段 pixiApplication 背景为 0x000000（避免黑幕下透白闪屏），在故事尚未铺设
   * 背景/角色前直接 render() 会得到全黑画面。这里临时挂载一个中心角色（或无角色时的白色
   * Sprite 探针）验证 WebGL 实际渲染输出，结束后立即恢复并重绘回纯黑。
   */
  private async runWithValidationProbe(
    canvas: HTMLCanvasElement,
    fn: () => Promise<void>
  ): Promise<void> {
    let probedModel: ReturnType<App['getModelById']> | null = null
    let prevVisible = true
    let prevX = 0
    let prevY = 0
    let prevAlpha: number | undefined
    let probeSprite: Sprite | null = null
    let mountedProbe = false

    const models = this.app.storyManager?.storyData?.models ?? []
    if (
      models.length > 0 &&
      typeof this.app.getModelById === 'function' &&
      typeof this.app.layerModel?.addModelToLayer === 'function' &&
      typeof this.app.layerModel?.removeModel === 'function'
    ) {
      for (const descriptor of models) {
        try {
          const candidate = this.app.getModelById(descriptor.id)
          if (!candidate?.internalModel) continue
          probedModel = candidate
          prevVisible = candidate.visible
          prevX = candidate.position?.x ?? 0
          prevY = candidate.position?.y ?? 0
          const filter = (candidate.filters?.[0] ?? null) as { alpha?: number } | null
          prevAlpha = filter?.alpha

          this.app.layerModel.addModelToLayer(candidate)
          if (typeof candidate.setPositionRel === 'function') {
            candidate.setPositionRel(this.app.stage_size ?? [canvas.width, canvas.height], {
              x: 0.5,
              y: 0.5
            })
          } else {
            candidate.position?.set?.(canvas.width / 2, canvas.height / 2)
          }
          if (filter) filter.alpha = 1
          candidate.visible = true
          mountedProbe = true
          break
        } catch (error) {
          this.logger.warn(`Validation probe failed for model id=${descriptor.id}`, error)
          probedModel = null
        }
      }
    }

    if (
      !mountedProbe &&
      typeof Sprite === 'function' &&
      Texture?.WHITE &&
      typeof this.app.pixiApplication?.stage?.addChild === 'function' &&
      typeof this.app.pixiApplication?.stage?.removeChild === 'function'
    ) {
      probeSprite = new Sprite(Texture.WHITE)
      probeSprite.width = this.app.pixiApplication.screen?.width ?? canvas.width
      probeSprite.height = this.app.pixiApplication.screen?.height ?? canvas.height
      this.app.pixiApplication.stage.addChild(probeSprite)
      mountedProbe = true
    }

    try {
      await fn()
    } finally {
      if (probedModel) {
        const filter = (probedModel.filters?.[0] ?? null) as { alpha?: number } | null
        if (filter) filter.alpha = prevAlpha ?? 0
        probedModel.visible = prevVisible
        probedModel.position?.set?.(prevX, prevY)
        this.app.layerModel?.removeModel?.(probedModel)
      }
      if (probeSprite) {
        this.app.pixiApplication?.stage?.removeChild?.(probeSprite)
        probeSprite.destroy?.()
      }
      if (mountedProbe) {
        this.app.pixiApplication?.render?.()
      }
    }
  }

  private async prewarmStoryModels(): Promise<void> {
    const models = this.app.storyManager?.storyData?.models ?? []
    let warmedAny = false
    for (const descriptor of models) {
      try {
        const model = this.app.getModelById(descriptor.id)
        if (!model?.internalModel) continue
        this.app.layerModel.addModelToLayer(model)
        const filter = (model.filters?.[0] ?? null) as { alpha?: number } | null
        const previousAlpha = filter?.alpha
        const previousVisible = model.visible
        if (filter) filter.alpha = 0.01
        model.visible = true
        this.app.pixiApplication.renderer.render(this.app.pixiApplication.stage)
        if (filter) filter.alpha = previousAlpha ?? 0
        // 预画后必须恢复 visible=true：LayoutAppear 只做 alpha 淡入，不会再把
        // visible 设回 true；留成 false 会让整场角色都不渲染。
        model.visible = previousVisible
        this.app.layerModel.removeModel(model)
        warmedAny = true
      } catch (error) {
        this.logger.warn(`Model prewarm failed for id=${descriptor.id}`, error)
      }
    }
    if (warmedAny) {
      this.app.pixiApplication?.render?.()
    }
    await this.requestAnimationFrameOnce()
  }

  private async initializeExport(
    _options: VideoExportOptions,
    _progressFill: HTMLDivElement | null,
    exportStatus: HTMLElement | null,
    onProgress: InternalProgressCallback
  ): Promise<void> {
    this.logger.info('Initializing export')

    onProgress({
      stage: 'initializing',
      current: 0,
      total: 1,
      message: '正在初始化渲染器…',
      percentage: 0
    })

    if (exportStatus) exportStatus.textContent = '正在初始化渲染器…'
    await this.yieldToBrowser()
  }

  private async prepareRendering(
    options: VideoExportOptions,
    _progressFill: HTMLDivElement | null,
    exportStatus: HTMLElement | null,
    onProgress: InternalProgressCallback
  ): Promise<{
    canvas: HTMLCanvasElement
    framesDir: string
    totalSnippets: number
    startSnippetIndex: number
    startFrameIndex: number
  }> {
    const isApiMode = options.apiMode === true

    AnimationManager.setExportMode(true)
    AnimationManager.exportSpeedMultiplier = 1
    AnimationManager.exportTargetFPS = options.fps

    this.logger.info('Animation speed multiplier: 1x')

    if (isApiMode) {
      this.logger.info('API mode: skipping story reload, using pre-initialized story data')
    }

    const canvas = this.app.pixiApplication.view as HTMLCanvasElement
    this.logger.info(`Canvas size: ${canvas.width}x${canvas.height}`)

    if (canvas.width === 0 || canvas.height === 0) {
      throw ExportError.invalidCanvas(canvas.width, canvas.height)
    }

    onProgress({
      stage: 'capturing',
      current: 0,
      total: 1,
      message: '正在捕获帧…',
      percentage: 0
    })

    if (exportStatus) exportStatus.textContent = '正在准备流式编码…'
    await this.yieldToBrowser()
    await this.requestAnimationFrameOnce()

    const framesDir = await window.electron.ipcRenderer.invoke('electron:get-temp-dir')
    this.logger.info(`Temp frames directory: ${framesDir}`)

    const snippets = this.app.storyManager.snippets
    const totalSnippets = snippets.length

    let startSnippetIndex = 0
    let startFrameIndex = 0

    if (options.enableResumable !== false && this.checkpointManager.hasCheckpoint()) {
      const checkpoint = this.checkpointManager.loadCheckpoint()
      if (checkpoint && this.checkpointManager.canResume(totalSnippets)) {
        this.logger.info('Resuming from checkpoint', checkpoint)
        startSnippetIndex = checkpoint.lastSnippetIndex
        startFrameIndex = checkpoint.lastFrameIndex
      }
    }

    return {
      canvas,
      framesDir,
      totalSnippets,
      startSnippetIndex,
      startFrameIndex
    }
  }

  private async captureAndEncodeFrames(
    options: VideoExportOptions,
    canvas: HTMLCanvasElement,
    framesDir: string,
    totalSnippets: number,
    startSnippetIndex: number,
    startFrameIndex: number,
    progressFill: HTMLDivElement | null,
    exportStatus: HTMLElement | null,
    onProgress: InternalProgressCallback
  ): Promise<ExportResult> {
    const captureStartTime = performance.now()
    const snippets = this.app.storyManager.snippets
    let frameIndex = startFrameIndex
    let capturedFrames = 0

    const jpegQuality = this.getJpegQuality(options.quality)
    const batchSize = options.batchSize || VideoExportManager.DEFAULT_BATCH_SIZE

    const capturer = new AsyncFrameCapturer(this.logger, {
      width: options.width,
      height: options.height,
      quality: jpegQuality,
      batchSize,
      framesDir,
      maxQueueSize: 60,
      concurrentCaptures: 8
    })

    await capturer.initialize(canvas)

    const ttsEnabled = this.app.ttsManager?.isTTSEnabled() ?? false
    const bgmConfig = this.app.ttsManager?.getBGMConfig()
    const bgmEnabled = bgmConfig?.enabled ?? false
    const bgmPlan = new BgmPlan(snippets)
    const sePlan = new SePlan(snippets)
    const audioMuxer = new AudioMuxer()
    if (ttsEnabled || bgmEnabled || sePlan.hasChanges) {
      await audioMuxer.initialize()
    }

    const useGlobalBgm = bgmEnabled && !bgmPlan.hasStoryFiles
    if (bgmEnabled && bgmPlan.hasStoryFiles) {
      await bgmPlan.load(audioMuxer)
    }
    if (sePlan.hasChanges) {
      await sePlan.load(audioMuxer)
    }

    let bgmBuffer: AudioBuffer | null = null
    if (bgmEnabled && bgmConfig) {
      audioMuxer.setBGMConfig(bgmConfig)
      if (useGlobalBgm) {
        try {
          const bgmPath = resolveBgmUrl(bgmConfig.path)
          this.logger.info(`Loading BGM from: ${bgmPath}`)
          bgmBuffer = await audioMuxer.loadBGMBuffer(bgmPath)
          this.logger.info(
            `BGM loaded: ${bgmBuffer ? 'success' : 'failed'}, duration: ${bgmBuffer ? bgmBuffer.duration.toFixed(2) : 0}s`
          )
        } catch (error) {
          this.logger.warn(`Failed to load BGM: ${error}`)
        }
      }
    }
    const bgmActive = bgmEnabled && (bgmPlan.hasLoadedFiles || bgmBuffer !== null)

    let timeline: SnippetTimelineEntry[] = []

    timeline = this.app.ttsManager.buildTimelineWithoutTTS(snippets)
    this.app.ttsManager.setTimeline(timeline)

    this.logger.info(
      'Phase 2: High-concurrency async rendering — Frame Capture + Snippet execution',
      {
        totalSnippets,
        startIndex: startSnippetIndex,
        fps: options.fps,
        ttsEnabled,
        bgmEnabled
      }
    )

    const timestampRecorder = new SnippetTimestampRecorder()
    timestampRecorder.markRenderStart()

    const ttsAudioResults = new Map<
      number,
      {
        audioBuffer: ArrayBuffer
        pcmData?: {
          channel0: Float32Array
          channel1: Float32Array
          sampleRate: number
        }
        durationMs: number
        characterName: string
        text: string
        preDecoded: boolean
      }
    >()

    let ttsPromise: Promise<void> | null = null
    const serialTts = (options.ttsMode ?? 'concurrent') === 'serial'

    if (ttsEnabled) {
      this.logger.info(
        serialTts
          ? 'Serial mode: Synthesizing all TTS before frame capture'
          : 'Starting TTS synthesis in background'
      )
      if (exportStatus) {
        exportStatus.textContent = serialTts ? '正在合成语音…' : '启动语音合成（后台运行）…'
      }

      ttsPromise = (async () => {
        await this.app.ttsManager.preSynthesizeAll(snippets, (current, total, message) => {
          this.logger.info(`[TTS Background] ${current}/${total}: ${message}`)
        })
        this.logger.info('TTS background synthesis completed')
      })()

      if (serialTts) {
        onProgress({
          stage: 'loading',
          current: 0,
          total: 1,
          message: '正在串行合成语音…',
          percentage: 20
        })
        await ttsPromise
        this.checkAborted()
        if (exportStatus) exportStatus.textContent = '语音合成完成，开始渲染…'
      }
    }

    const extendedApp = this.app as unknown as ExtendedApp
    const openingCoverTask = this.hasOpeningCurtain(snippets)
      ? undefined
      : extendedApp.setOpeningCover?.(OPENING_COVER_FADE_MS)
    void openingCoverTask?.catch(() => undefined)

    try {
      for (let i = startSnippetIndex; i < snippets.length; i++) {
        this.checkAborted()

        const snippet = snippets[i]
        if (snippetHasPreFence(snippet)) {
          await this.app.snippetStrategyManager?.waitForPreFence?.(snippet)
        }
        exportTraceContext.setSnippet(i, snippet.type)
        const timelineEntry = timeline[i]
        const safeTotal = totalSnippets || 1
        const pct = 10 + Math.round(((i + 1) / safeTotal) * 80)

        if (progressFill) progressFill.style.width = `${pct}%`
        if (exportStatus) exportStatus.textContent = `渲染中… ${i + 1}/${totalSnippets}`

        onProgress({
          stage: 'capturing',
          current: i + 1,
          total: totalSnippets,
          message: `处理片段 ${i + 1}/${totalSnippets}`,
          percentage: pct
        })

        const nowMs = performance.now()
        this.app.lastSnippetActualDurationMs =
          timelineEntry?.durationMs ??
          (snippet.type === 'Talk'
            ? this.talkDurationWithMotionGate(
                snippet.data as unknown as TalkSnippetLike,
                0,
                this.talkWindowOpenMs(snippets, i),
                i,
                Math.max(0, getLayoutRunningEndMs(this.app) - nowMs),
                Math.max(0, getMotionSettledEndMs(this.app) - nowMs)
              )
            : Math.max(Math.round((snippet.delay || 0) * 1000), estimateSnippetDuration(snippet)))

        const talkData = snippet.type === 'Talk' ? snippet.data : undefined

        this.app.currentTalkStartedAtMs = 0
        timestampRecorder.markSnippetStart(i, snippet.type, {
          speaker: talkData?.speaker,
          content: talkData?.content
        })

        const framesForSnippet = await this.processSnippetFrames(
          snippet,
          i,
          options.fps,
          canvas,
          capturer
        )

        frameIndex += framesForSnippet
        capturedFrames += framesForSnippet

        timestampRecorder.markSnippetEnd()

        if (capturedFrames % 50 === 0) {
          this.checkpointManager.saveCheckpoint({
            lastSnippetIndex: i,
            lastFrameIndex: frameIndex,
            totalFramesCaptured: capturedFrames,
            timestamp: Date.now(),
            exportOptions: {
              fps: options.fps,
              quality: options.quality,
              width: options.width,
              height: options.height
            }
          })
        }

        if (i % 20 === 0) {
          await this.yieldToBrowser()
        }
      }

      // 后台片段播完后再 flush，否则尾帧会被截掉。
      await this.app.snippetStrategyManager?.settleBackgroundSnippets?.()
      if (openingCoverTask) await openingCoverTask
      await extendedApp.setEndingEnvelope?.(PLAYED_WAIT_TIME_MS, SCENARIO_EXIT_BGM_FADE_MS)
    } catch (error) {
      this.logger.error('Frame capture loop failed, cleaning up resources', error)
      try {
        await capturer.dispose()
      } catch {
        /* cleanup */
      }
      audioMuxer.dispose()
      if (ttsEnabled) {
        this.app.ttsManager?.clearAudioTracks()
      }
      throw error
    }

    timestampRecorder.logSummary()

    await capturer.flushAll()

    this.logger.info(`Frame capture completed: ${capturedFrames} frames`)

    if (ttsEnabled && ttsPromise) {
      this.logger.info('Waiting for TTS synthesis to complete...')
      if (exportStatus) exportStatus.textContent = '等待语音合成完成…'
      await ttsPromise
      this.logger.info('TTS synthesis finished')

      const ttsDurations = this.app.ttsManager.getPreSynthesizedTtsDurations()
      const audioTracks = this.app.ttsManager.getAudioTracks()
      let talkIdx = 0

      for (let i = 0; i < snippets.length; i++) {
        if (snippets[i].type === 'Talk') {
          const duration = ttsDurations.get(i) ?? timeline[i]?.durationMs ?? 0
          const track = audioTracks[talkIdx]

          if (track) {
            ttsAudioResults.set(i, {
              audioBuffer: track.audioBuffer,
              durationMs: duration,
              characterName: track.characterName,
              text: track.text,
              preDecoded: false
            })
          }

          talkIdx++
        }
      }

      this.logger.info(`Collected ${ttsAudioResults.size} TTS audio tracks after synthesis`)
    }

    const actualVideoDurationMs = timestampRecorder.getTotalVideoDurationMs()
    const videoDurationMs = (frameIndex / options.fps) * 1000
    const lastTimelineEntry = timeline[timeline.length - 1]
    const totalDurationMs =
      Math.max(lastTimelineEntry?.endTimeMs ?? 0, videoDurationMs, actualVideoDurationMs) + 500

    const hasTtsTracks = ttsEnabled && ttsAudioResults.size > 0
    let wavData: Uint8Array | null = null

    this.logger.info('Phase 3: Audio mixing', {
      hasTtsTracks,
      ttsCount: ttsAudioResults.size,
      bgmEnabled,
      bgmActive,
      storyBgmFiles: bgmPlan.fileCount
    })

    const actualStartTimesMs = snippets.map((_, index) =>
      timestampRecorder.getVideoRelativeStartTimeMs(index)
    )
    if (bgmPlan.hasChanges) {
      audioMuxer.setBgmCues(bgmPlan.build(actualStartTimesMs, useGlobalBgm ? bgmBuffer : null))
    }
    if (sePlan.hasChanges) {
      audioMuxer.setSeCues(sePlan.build(actualStartTimesMs))
    }

    if (
      (hasTtsTracks || bgmActive || sePlan.hasChanges) &&
      (ttsEnabled || bgmEnabled || sePlan.hasChanges)
    ) {
      if (hasTtsTracks) {
        if (exportStatus)
          exportStatus.textContent = `正在混合音频 (${ttsAudioResults.size} 条音轨)...`

        const audioPlacements = timestampRecorder.buildAudioTrackPlacements(ttsAudioResults)

        for (const placement of audioPlacements) {
          audioMuxer.addAudioTrack({
            audioBuffer: placement.audioBuffer,
            startTime: placement.startTimeMs,
            endTime: placement.endTimeMs,
            characterName: placement.characterName,
            text: placement.text
          })
          this.logger.info(
            `Audio placed: "${placement.characterName}" at ${placement.startTimeMs}ms → ${placement.endTimeMs}ms`
          )
        }
      } else if (bgmEnabled) {
        if (exportStatus) exportStatus.textContent = '正在添加背景音乐...'
      }

      this.logger.info(
        `Audio mixing: outputDuration=${totalDurationMs}ms, tracks=${ttsAudioResults.size}, bgm=${!!bgmBuffer}, storyBgmFiles=${bgmPlan.fileCount}`
      )
      const mixedAudioBuffer = await audioMuxer.mixAudioTracks(
        totalDurationMs,
        bgmBuffer || undefined
      )
      const wavBuffer = await audioMuxer.audioBufferToWav(mixedAudioBuffer)
      wavData = new Uint8Array(wavBuffer)
      this.logger.info(`WAV buffer prepared: ${(wavBuffer.byteLength / 1024).toFixed(1)} KB`)
    }

    onProgress({
      stage: 'encoding',
      current: frameIndex,
      total: frameIndex,
      message: '正在编码视频…',
      percentage: 95
    })

    if (exportStatus) exportStatus.textContent = '正在编码视频…'
    await this.sleep(200)

    onProgress({
      stage: 'saving',
      current: frameIndex,
      total: frameIndex,
      message: '正在保存视频…',
      percentage: 98
    })

    if (exportStatus) exportStatus.textContent = '正在保存视频…'

    await this.encodeAndSaveVideo(framesDir, frameIndex, options, wavData ?? undefined)
    this.checkAborted()

    this.checkpointManager.clearCheckpoint()
    audioMuxer.dispose()
    if (ttsEnabled) {
      this.app.ttsManager?.clearAudioTracks()
    }
    await capturer.dispose()

    this.logger.info('Frame capture summary', {
      totalFrames: capturedFrames,
      capturerStats: capturer.stats
    })

    const result: ExportResult = {
      success: true,
      duration: (performance.now() - captureStartTime) / 1000,
      frameCount: capturedFrames
    }
    return this.attachDiagnostics(
      result,
      snippets,
      timeline,
      timestampRecorder,
      ttsAudioResults,
      'frames',
      options,
      ttsEnabled
    )
  }

  private getJpegQuality(quality: 'draft' | 'standard' | 'high'): number {
    switch (quality) {
      case 'draft':
        return 0.7
      case 'standard':
        return 0.8
      case 'high':
      default:
        return 0.85
    }
  }

  private async showCompletionMessage(
    progressFill: HTMLDivElement | null,
    exportStatus: HTMLElement | null,
    onProgress: InternalProgressCallback
  ): Promise<void> {
    if (progressFill) progressFill.style.width = '100%'

    onProgress({
      stage: 'complete',
      current: 1,
      total: 1,
      message: '视频已保存！',
      percentage: 100
    })

    if (exportStatus) exportStatus.textContent = '视频已保存！'
    await this.sleep(1500)
  }

  private async handleExportError(
    error: unknown,
    exportStatus: HTMLElement | null,
    _startTime: number
  ): Promise<ExportResult> {
    this.logger.error('Export failed', error)

    const errorMsg = error instanceof Error ? error.message : String(error)
    const errorCode = error instanceof ExportError ? error.code : ExportErrorCode.UNKNOWN

    if (errorCode === ExportErrorCode.CANCELLED) {
      if (exportStatus) exportStatus.textContent = '导出已取消'
    } else if (errorCode === ExportErrorCode.TIMEOUT) {
      if (exportStatus) exportStatus.textContent = '导出超时，请尝试减少片段数或降低分辨率'
    } else {
      if (exportStatus) exportStatus.textContent = `导出失败: ${errorMsg.substring(0, 50)}`
    }

    throw error
  }

  private cleanup(): void {
    AnimationManager.setExportMode(false)
    AnimationManager.exportSpeedMultiplier = 1
    this.app.exporting = false
    this.app.lastSnippetActualDurationMs = 0

    this.app.ttsManager?.clearAudioTracks()
    ;(Ticker.shared as { stop?: () => void })?.stop?.()

    const overlay =
      typeof document !== 'undefined' ? document.getElementById('export-overlay') : null
    if (overlay) {
      overlay.hidden = true
    }

    this.logger.info('Export cleanup completed, Ticker stopped to reduce GPU idle usage')
  }

  private async encodeAndSaveVideo(
    framesDir: string,
    frameCount: number,
    options: VideoExportOptions,
    audioData?: Uint8Array
  ): Promise<void> {
    const startTime = performance.now()
    this.logger.info(
      `Starting video encoding: ${frameCount} frames, ${options.fps}fps, format=${options.format}, quality=${options.quality}, gpuRenderer=${options.gpuRenderer || 'auto'}, hasAudio=${!!audioData}`
    )

    let audioFilePath: string | undefined
    if (audioData && audioData.byteLength > 0) {
      audioFilePath = await window.electron.ipcRenderer.invoke('electron:write-temp-file', {
        data: audioData.buffer.slice(
          audioData.byteOffset,
          audioData.byteOffset + audioData.byteLength
        ),
        prefix: 'mss-audio',
        extension: 'wav'
      })
      this.logger.info(
        `Audio temp file: ${audioFilePath}, size=${(audioData.byteLength / 1024).toFixed(1)} KB`
      )
    }

    await window.electron.ipcRenderer.invoke('electron:hyperframes-save-video', {
      framesDir,
      frameCount,
      keyFrameCount: 0,
      fps: options.fps,
      width: options.width,
      height: options.height,
      totalDuration: frameCount / options.fps,
      gpuRenderer: options.gpuRenderer || 'auto',
      audioFilePath
    })

    const encodeTime = ((performance.now() - startTime) / 1000).toFixed(2)
    this.logger.info(`Video encoding completed in ${encodeTime}s`)
  }

  destroy(): void {
    this.abort()
    this.checkpointManager.clearCheckpoint()
    this.logger.info('VideoExportManager destroyed')
  }
}
