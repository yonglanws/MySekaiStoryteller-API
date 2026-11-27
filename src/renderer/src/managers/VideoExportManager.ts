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
import { FrameInterpolator, type FrameSnapshot } from './video-export/FrameInterpolator'
import { applyTalkPatch } from './video-export/talkPatch'
import {
  normalizeExportVideoCodec,
  resolveRemuxCodecPlan,
  type VideoExportOptions
} from './video-export/types'
import type { ExportProgress as ExtendedExportProgress } from './video-export'
import type { SnippetData } from '../../../common/types/Story'
import { snippetHasPreFence } from '../../../common/export/snippetSemantics'
import { bakeStoryPlan } from '../../../common/export/storyPlan'
import type { SnippetTimelineEntry } from './TTSManager'
import { estimateSnippetDuration } from '../utils/TimelineCalculator'
import { calculateTalkDurationMs } from '../utils/TalkTiming'
import {
  FRAME_MS,
  LIP_LOUD_CHARACTERS,
  LIP_LOUD_TARGET_VALUE_SCALE,
  LIP_TARGET_VALUE_SCALE,
  OPENING_COVER_FADE_MS,
  PLAYCORE_WARMUP_FRAMES,
  PLAYED_WAIT_TIME_MS,
  SCENARIO_EXIT_BGM_FADE_MS,
  SILENT_PUNCTUATION_HOLD_MS,
  STORY_FPS,
  TALK_WINDOW_OPEN_CLOSE_MS,
  framesForSeconds,
  framesToMs,
  storyFrameForVideoFrame,
  storyFrameTweenForVideoFrame,
  videoFrameCountForStoryFrames
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
  /** 官方正文；打字机按它的长度计时（content 是译文）。 */
  typingText?: string
  /** 官方语音时长（毫秒）：参考实现按官方语音计时，优先于 TTS 音频。 */
  voiceDurationMs?: number
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
  /** Talk 索引 -> 动作收尾帧数（相对 Talk 开始），用于 diagnostics 的逐帧计划。 */
  private talkSettleFramesByIndex = new Map<number, number>()
  /**
   * 导出计划用的角色 shown 状态：按剧本顺序维护，避免 Now 布局片段尚未
   * await 时 `layerModel.isModelShown` 还是旧值（Appear 与 Talk 同帧时尤其明显）。
   */
  private exportModelShown = new Map<number, boolean>()
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
  /** 最近一次导出实际使用的帧通道，用于诊断报告（encoder/convert 字段）。 */
  private lastSinkKind: 'webcodecs' | 'image2pipe' | 'frames' = 'image2pipe'
  private lastEncoderLabel = 'ffmpeg'
  /** 收尾转换由谁完成：browser=WebCodecs 流满足 BT.709/tv 直接 remux；ffmpeg=重编码修正 */
  private lastConvert: 'browser' | 'ffmpeg' = 'ffmpeg'

  /** 已在同一常驻 worker 页面上通过首次 WebGL/黑屏校验的 App 实例集合 */
  private static readonly warmValidatedApps = new WeakSet<object>()
  /** 按 App 实例隔离的 WebCodecs 探测缓存，避免跨复用页重复 5 帧测速 */
  private static readonly webCodecsProbeCache = new WeakMap<
    object,
    Map<string, WebCodecsProbeResult | null>
  >()

  private static readonly DEFAULT_BATCH_SIZE = 30
  private rustBackendProbe: Promise<boolean> | null = null
  private rustAudioUnavailable = false

  constructor(app: App) {
    this.app = app
    this.logger = new ExportLogger('VideoExportManager')
    this.checkpointManager = new CheckpointManager()
    this.errorRecovery = new ErrorRecoveryManager(3)
    this.progressTracker = new ProgressTracker()
  }

  private isHttpBridgeMode(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof fetch === 'function' &&
      typeof location !== 'undefined' &&
      location.protocol.startsWith('http')
    )
  }

  private bridgeFetchHeaders(extra?: Record<string, string>): Record<string, string> {
    const token =
      typeof location !== 'undefined'
        ? new URLSearchParams(location.search).get('token') || ''
        : ''
    return token ? { ...extra, 'x-mss-bridge-token': token } : { ...extra }
  }

  private probeRustBackendAvailable(): Promise<boolean> {
    if (this.rustAudioUnavailable || !this.isHttpBridgeMode()) {
      return Promise.resolve(false)
    }
    if (!this.rustBackendProbe) {
      this.rustBackendProbe = fetch('/bridge/binary-stream-endpoint', {
        headers: this.bridgeFetchHeaders()
      })
        .then(async (res) => {
          if (!res.ok) return false
          const body = (await res.json()) as { ok?: boolean; backend?: string }
          return Boolean(body?.ok && body.backend === 'rust')
        })
        .catch(() => false)
    }
    return this.rustBackendProbe
  }

  private arrayBufferToBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf)
    let binary = ''
    const chunkSize = 0x8000
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
    }
    return btoa(binary)
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
      model = undefined
    }
    const scale = model?.getLipSyncScale?.()
    if (typeof scale === 'number' && Number.isFinite(scale) && scale > 0) return scale

    const modelPath = this.app.storyManager?.storyData?.models?.find((m) => m.id === modelId)?.model
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

  private async decodeLipSyncEnvelope(
    audioBuffer: ArrayBuffer,
    snippetIndex = -1,
    targetValueScale = 1
  ): Promise<ReturnType<typeof buildLipSyncEnvelope> | null> {
    try {
      if (await this.probeRustBackendAvailable()) {
        try {
          const qs = `?targetValueScale=${encodeURIComponent(String(targetValueScale))}`
          const resp = await fetch(`/bridge/rust/compute-lipsync${qs}`, {
            method: 'POST',
            headers: this.bridgeFetchHeaders({ 'content-type': 'application/octet-stream' }),
            body: audioBuffer
          })
          this.checkAborted()
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
            this.rustAudioUnavailable = true
          }
        } catch (rustErr) {
          this.checkAborted()
          this.logger.warn('Rust compute-lipsync failed, falling back to OfflineAudioContext:', rustErr)
        }
      }
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
   * 参考 `motions_settled` 只看 `CurrentDisplayStatus == Appear` 的角色：
   * 已 Clear（shown=false）的角色即使同帧 `set_body` 了也不阻塞 Talk
   * （片尾 HideTalk/BlackOut 前的两句实测被隐藏角色的动作多拖了 97/12 帧）。
   * 这里用布局层的 shown 状态，不用 alpha：Appear 与 Talk 同帧启动时 alpha 还是 0。
   */
  private motionGateCounts(modelId: number): boolean {
    const scripted = this.exportModelShown.get(modelId)
    if (scripted !== undefined) return scripted
    const layer = this.app.layerModel as unknown as {
      isModelShown?: (id: number) => boolean
    }
    return typeof layer?.isModelShown === 'function' ? layer.isModelShown(modelId) : true
  }

  /**
   * 跟随 Talk 同帧注册的 Now 片段（例如 delay=1.75s 的 Motion）会在 Talk 的
   * 语音结束前开始身体动作；官方 `motions_settled` 会等它播完再进入停留。
   * 导出必须在算 Talk 目标时长时预读这些并发动作，否则计划会比参考短。
   *
   * 帧数按参考的方式分段换算：`frames_for(delay)` + `frames_for(clip 秒)`。
   * 合成一段毫秒再 `frames_for` 会少一帧（1s + 2.033s = 61+122 = 183 帧，
   * 而 3.033s 只有 182 帧）。Now 片段与 Talk 在同一帧注册，delay 也各自从
   * 注册帧起算；换成相对 Talk act 的偏移要 `frames_for(现在) − frames_for(Talk delay)`
   * 再相减（Talk delay=2s、Motion delay=6s 时是 361−121=240，不是 frames_for(4s)=241）。
   */
  private concurrentMotionSettleFrames(
    snippets: readonly SnippetData[],
    index: number,
    talkDelayFrames: number,
    windowFrames: number
  ): number {
    if (index < 0 || index >= snippets.length) return 0
    let settleFrames = 0
    const consider = (modelId: number, motion: string | undefined, startFrames: number): void => {
      if (!motion) return
      if (!this.motionGateCounts(modelId)) return
      try {
        const model = this.app.getModelById(modelId)
        if (model.isMotionLooping?.(motion)) return
        const clipMs = model.getMotionDurationMs?.(motion) ?? 0
        if (clipMs > 0) {
          settleFrames = Math.max(settleFrames, startFrames + framesForSeconds(clipMs / 1000))
        }
      } catch {
        /* model not loaded; the gate cannot be planned */
      }
    }
    for (let j = index + 1; j < snippets.length; j++) {
      const next = snippets[j]
      // 遇到 WaitFinished 片段就说明后续动作不会在 Talk 结束前启动。
      if (snippetHasPreFence(next)) break
      const data = ((next as { data?: unknown }).data ?? {}) as {
        modelId?: number
        motion?: string
        duration?: number
        actions?: Array<{ at?: number; modelId?: number; motion?: string }>
      }
      const delayFrames = framesForSeconds(Number(next.delay) || 0)
      const startFrames = Math.max(0, delayFrames - talkDelayFrames)
      if (startFrames > windowFrames + 1) continue
      consider(Number(data.modelId) || -1, data.motion, startFrames)
      const actionWindowFrames = framesForSeconds(Number(data.duration) || 2)
      for (const action of data.actions ?? []) {
        consider(
          Number(action.modelId ?? data.modelId) || -1,
          action.motion,
          startFrames + Math.max(0, Math.round((Number(action.at) || 0) * actionWindowFrames))
        )
      }
    }
    return settleFrames
  }

  /**
   * 计划层用的 `modelId|motion` -> clip 帧数表。计划自己按剧本帧推导 Talk gate，
   * 不再把运行时时间戳（带 1–3 帧启动漂移）回灌进计划。
   */
  private buildMotionClipFrames(snippets: readonly SnippetData[]): Map<string, number> {
    const frames = new Map<string, number>()
    const add = (modelRaw: unknown, motionRaw: unknown): void => {
      const motion = typeof motionRaw === 'string' ? motionRaw.trim() : ''
      if (!motion) return
      const modelId = Number(modelRaw) || -1
      const key = `${modelId}|${motion}`
      if (frames.has(key)) return
      try {
        const model = this.app.getModelById(modelId)
        if (model.isMotionLooping?.(motion)) {
          frames.set(key, 0)
          return
        }
        const clipMs = model.getMotionDurationMs(motion)
        frames.set(key, clipMs > 0 ? framesForSeconds(clipMs / 1000) : 0)
      } catch {
        frames.set(key, 0)
      }
    }
    for (const snippet of snippets) {
      const data = ((snippet as { data?: unknown }).data ?? {}) as {
        modelId?: number
        motion?: string
        actions?: Array<{ modelId?: number; motion?: string }>
      }
      add(data.modelId, data.motion)
      for (const action of data.actions ?? []) {
        add(action.modelId ?? data.modelId, action.motion)
      }
    }
    return frames
  }

  /**
   * 本句 Talk 自己的动作（顶层 motion 与 actions）的收尾帧数（相对 act）。
   *
   * 官方 `talk_start` 在同帧 `set_body`，`motions_settled` 会一直等到该 clip 结束；
   * 计划与运行时都要算进来，否则会把动作提前掐断（snippets[19] 的 215ms 打断就是
   * 这类）。这里不看当前 alpha/visible：Appear 与 Talk 同帧启动时角色还没淡入，
   * 但 `set_body` 已经生效。
   */
  private talkOwnMotionSettleFrames(talk: TalkSnippetLike, baseDurationMs = 0): number {
    const cues: Array<{ at: number; modelId: number; motion?: string }> = []
    if (talk.motion) cues.push({ at: 0, modelId: talk.modelId, motion: talk.motion })
    for (const action of talk.actions ?? []) {
      if (action.motion) cues.push(action)
    }
    let settleFrames = 0
    for (const cue of cues) {
      if (!cue.motion) continue
      if (!this.motionGateCounts(cue.modelId)) continue
      try {
        const model = this.app.getModelById(cue.modelId)
        if (model.isMotionLooping?.(cue.motion)) continue
        const clipMs = model.getMotionDurationMs(cue.motion)
        if (clipMs > 0) {
          const startFrames = cue.at > 0 ? framesForSeconds((cue.at * baseDurationMs) / 1000) : 0
          settleFrames = Math.max(settleFrames, startFrames + framesForSeconds(clipMs / 1000))
        }
      } catch {
        /* model not loaded; the gate cannot be planned */
      }
    }
    return settleFrames
  }

  private talkDurationWithMotionGate(
    talk: TalkSnippetLike,
    ttsDurationMs: number,
    windowOpenMs = 0,
    snippetIndex = -1,
    layoutRunningMs = 0,
    existingMotionSettleMs = 0,
    silentHoldMs?: number,
    talkDelayMs = 0
  ): number {
    const officialVoiceMs =
      typeof talk.voiceDurationMs === 'number' &&
      Number.isFinite(talk.voiceDurationMs) &&
      talk.voiceDurationMs > 0
        ? talk.voiceDurationMs
        : 0
    const timingVoiceMs = officialVoiceMs > 0 ? officialVoiceMs : ttsDurationMs
    const existingSettleFrames =
      existingMotionSettleMs > 0 ? framesForSeconds(existingMotionSettleMs / 1000) : 0
    const base = calculateTalkDurationMs(talk.content, timingVoiceMs, talk.ttsText, {
      voiceDurationMs: officialVoiceMs,
      typingText: talk.typingText,
      windowOpenMs,
      layoutRunningMs,
      motionSettleFrames: existingSettleFrames,
      silentHoldMs
    })
    let settleFrames = Math.max(existingSettleFrames, this.talkOwnMotionSettleFrames(talk, base))
    const snippets = this.app.storyManager?.snippets ?? []
    const talkDelayFrames = framesForSeconds(talkDelayMs / 1000)
    let duration = base
    // 最多两轮：第一轮找到语音窗内启动的并发动作，第二轮把因动作延长后
    // 才落入窗口的后续动作也算进去。
    for (let pass = 0; pass < 2; pass++) {
      const concurrentFrames = this.concurrentMotionSettleFrames(
        snippets,
        snippetIndex,
        talkDelayFrames,
        framesForSeconds(duration / 1000)
      )
      if (concurrentFrames <= settleFrames) break
      settleFrames = concurrentFrames
      duration = calculateTalkDurationMs(talk.content, timingVoiceMs, talk.ttsText, {
        voiceDurationMs: officialVoiceMs,
        typingText: talk.typingText,
        motionSettleFrames: settleFrames,
        layoutRunningMs,
        windowOpenMs,
        silentHoldMs
      })
    }
    if (settleFrames > 0 && snippetIndex >= 0) {
      this.talkSettleFramesByIndex.set(snippetIndex, settleFrames)
    }
    return settleFrames > 0 || layoutRunningMs > 0
      ? calculateTalkDurationMs(talk.content, timingVoiceMs, talk.ttsText, {
          voiceDurationMs: officialVoiceMs,
          typingText: talk.typingText,
          motionSettleFrames: settleFrames,
          layoutRunningMs,
          windowOpenMs,
          silentHoldMs
        })
      : base
  }

  /**
   * 首个 Talk（或真正关闭后第一句）需要 0.2s 打开对话框。
   * `closeWindowOnFinish` 是台词结束后 0.2s 才关窗；下一句若在这之前开始，
   * 窗口仍按打开处理（参考 `end_talk` → `window_closes_at`）。
   */
  private talkWindowOpenMs(
    snippets: SnippetData[],
    index: number,
    timeline?: SnippetTimelineEntry[]
  ): number {
    let open = false
    let closesAtMs: number | null = null
    for (let i = 0; i <= index; i++) {
      const snippet = snippets[i]
      const entry = timeline?.[i]
      const startMs = entry?.startTimeMs ?? 0
      if (closesAtMs !== null && closesAtMs <= startMs) {
        open = false
        closesAtMs = null
      }
      if (snippet.type === 'Talk') {
        if (!open) {
          if (i === index) return TALK_WINDOW_OPEN_CLOSE_MS
          open = true
        }
        if (snippet.data.closeWindowOnFinish) {
          if (entry) {
            closesAtMs = entry.endTimeMs + TALK_WINDOW_OPEN_CLOSE_MS
          } else {
            open = false
          }
        }
      } else if (snippet.type === 'HideTalk') {
        open = false
        closesAtMs = null
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
    this.talkSettleFramesByIndex.clear()
    this.exportModelShown.clear()
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
        // fast 模式按 fastFps 编码，与 options.fps 不同；诊断里的帧映射要写真实编码帧率。
        videoFps:
          mode === 'fast' ? Math.max(1, Math.min(options.fastFps ?? 30, options.fps)) : options.fps,
        frameCount: result.frameCount,
        // result.duration 是导出墙钟耗时；报告要的是成片时长。
        durationMs:
          result.timings?.videoDurationMs ??
          Math.round((result.frameCount / Math.max(1, options.fps)) * 1000),
        ...(result.outputSize !== undefined ? { outputSize: result.outputSize } : {}),
        ...(result.timings ? { timings: result.timings } : {}),
        encoder: this.lastEncoderLabel,
        segments: 1,
        convert: this.lastConvert,
        // 所有收尾路径都经过 BT.709/tv 滤镜或重编码；copy 分支只在源流本身已合规时使用
        color: 'bt709/tv'
      },
      provider: this.app.ttsManager?.getConfig().provider,
      ttsEnabled,
      storyCounts: story ? { models: story.models.length, images: story.images.length } : undefined,
      // 诊断沿用毫秒口径；内部计划用帧数（分段 frames_for 相加）。
      motionSettleMs: new Map(
        [...this.talkSettleFramesByIndex].map(([index, frames]) => [index, framesToMs(frames)])
      ),
      motionClipFrames: this.buildMotionClipFrames(snippets)
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
    gpuRenderer: 'auto' | 'nvidia' | 'amd' | 'intel' | 'cpu' = 'auto',
    codec: 'h264' | 'hevc' = 'h264'
  ): Promise<boolean> {
    this.lastWebCodecsProbeConfig = null
    if (choice === 'frames') return false
    if (typeof WebCodecsMp4Encoder?.probeConfig !== 'function') return false

    const cacheKey = `${width}x${height}@${fps}:${bitrate}:${choice}:${gpuRenderer}:${codec}`
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
      codec,
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
    const bitrate = options.exportBitrate ?? 3_200_000
    // 编码帧率独立于时间轴：动画仍按 options.fps 的虚拟时间推进，
    // 但每帧 GPU 读回很贵。用 video.fastFps（默认 30）封顶，时长不变。
    const fastFpsCap = Math.max(1, Math.min(options.fastFps ?? 30, fps))
    const encodeFps = options.segmentRange?.encodeFps ?? fastFpsCap
    const frameMs = 1000 / encodeFps
    const segmentPrepareOnly = options.segmentPrepareOnly === true
    const segmentRange = options.segmentRange
    const isSegmentWorker = Boolean(segmentRange)
    const startFrame = segmentRange ? segmentRange.startFrame : 0
    const endFrame = segmentRange ? segmentRange.endFrame : -1
    const precomputedTts = segmentRange?.precomputedTts
    const sharedWriteId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const preparedTtsWavs: Record<number, { filePath: string; durationMs: number }> = {}
    const sharedTtsUploadTasks: Array<Promise<void>> = []
    const bridgeToken =
      typeof window !== 'undefined' && typeof window.location?.search === 'string'
        ? new URLSearchParams(window.location.search).get('token')
        : null
    const readBridgeTempFile = async (filePath: string): Promise<ArrayBuffer> => {
      const url =
        `/bridge/temp-file?path=${encodeURIComponent(filePath)}` +
        (bridgeToken ? `&token=${encodeURIComponent(bridgeToken)}` : '')
      const res = await fetch(url)
      if (!res.ok) {
        throw new Error(`Failed to fetch precomputed TTS file: HTTP ${res.status}`)
      }
      return res.arrayBuffer()
    }

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
    // 以确定性帧计划预排 Talk 时长与整条时间线：运行时的 stageTiming settle 会带
    // 1–3 帧启动漂移，逐句累积后成片 act 会偏离计划（实测片尾早 68 帧）。
    // plan 帧号含 PlayCore 前 10 帧，时间线的 0 对应故事帧 10。
    const plannedTalkDurationMs = new Map<number, number>()
    const plannedEntries = bakeStoryPlan(snippets, timeline, {
      motionClipFrames: this.buildMotionClipFrames(snippets),
      exportFps: encodeFps,
      ttsEnabled
    }).entries
    for (const entry of plannedEntries) {
      if (entry.type === 'Talk') {
        plannedTalkDurationMs.set(entry.index, framesToMs(entry.durationFrames))
      }
      const t = timeline[entry.index]
      if (!t) continue
      const startMs = Math.max(0, (entry.startFrame - PLAYCORE_WARMUP_FRAMES) * (1000 / STORY_FPS))
      const delayStartMs = Math.max(
        0,
        (entry.delayStartFrame - PLAYCORE_WARMUP_FRAMES) * (1000 / STORY_FPS)
      )
      const durationMs = entry.durationFrames * (1000 / STORY_FPS)
      if (t.delayStartTimeMs !== undefined) t.delayStartTimeMs = delayStartMs
      t.startTimeMs = startMs
      t.durationMs = durationMs
      t.endTimeMs = startMs + durationMs
    }

    const virtualClock = new VirtualClockController()
    const timestampRecorder = new SnippetTimestampRecorder()
    const configuredTtsTimeoutMs = this.app.ttsManager?.getConfig?.().timeoutMs ?? 120_000
    const concurrentPipeline = new ConcurrentExportPipeline({
      ttsLookahead: 4,
      ttsTimeoutMs: Math.max(30_000, configuredTtsTimeoutMs),
      targetFps: fps,
      maxConcurrentTts: 4,
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
                if (segmentPrepareOnly && options.segmentSharedDir) {
                  const wavPath = `${options.segmentSharedDir}/tts-${snippetIndex}-${sharedWriteId}.wav`
                  const upload = window.electron.ipcRenderer
                    .invoke('electron:append-to-file', {
                      filePath: wavPath,
                      data: new Uint8Array(buf)
                    })
                    .then(() => {
                      preparedTtsWavs[snippetIndex] = { filePath: wavPath, durationMs: res.duration }
                    })
                  sharedTtsUploadTasks.push(upload)
                }
              }
            }
          }
        : undefined
    })

    const serialTts = (options.ttsMode ?? 'concurrent') === 'serial'
    if (ttsEnabled && !isSegmentWorker) {
      this.logger.info(
        serialTts
          ? 'Serial mode: Synthesizing all TTS before fast rendering'
          : 'Concurrent mode: Starting TTS pipeline (maxConcurrentTts=4) alongside rendering'
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

    const [useWebCodecs, rustAudioProbe] = await Promise.all([
      segmentPrepareOnly
        ? Promise.resolve(false)
        : this.resolveFastUseWebCodecs(
            canvas,
            outW,
            outH,
            encodeFps,
            bitrate,
            options.exportFastEncoder ?? 'auto',
            options.gpuRenderer ?? 'auto',
            normalizeExportVideoCodec(options.codec) ?? 'h264'
          ),
      isSegmentWorker ? Promise.resolve(false) : this.probeRustBackendAvailable()
    ])
    this.checkAborted()

    const useRustAudio = rustAudioProbe
    const loadFallbackJsAudio = async (): Promise<AudioBuffer | null> => {
      await Promise.all([
        bgmEnabled && bgmPlan.hasStoryFiles ? bgmPlan.load(audioMuxer) : Promise.resolve(),
        sePlan.hasChanges ? sePlan.load(audioMuxer) : Promise.resolve()
      ])
      if (bgmEnabled && bgmConfig) {
        audioMuxer.setBGMConfig(bgmConfig)
        if (useGlobalBgm && bgmConfig.path) {
          try {
            return await audioMuxer.loadBGMBuffer(resolveBgmUrl(bgmConfig.path))
          } catch (error) {
            this.logger.warn(`Failed to load BGM: ${error}`)
          }
        }
      }
      return null
    }
    let bgmBuffer: AudioBuffer | null =
      isSegmentWorker || useRustAudio ? null : await loadFallbackJsAudio()
    this.checkAborted()

    const bgmActive =
      bgmEnabled &&
      (useRustAudio
        ? bgmPlan.hasStoryFiles || Boolean(bgmConfig?.path)
        : bgmPlan.hasLoadedFiles || bgmBuffer !== null)

    let ttsSetupMs = 0
    if (ttsEnabled && !isSegmentWorker && (serialTts || segmentPrepareOnly)) {
      const serialTtsStart = virtualClock.realTimeMs()
      onProgress({
        stage: 'loading',
        current: 0,
        total: 1,
        message: '正在合成语音…',
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
      ttsSetupMs = virtualClock.realTimeMs() - serialTtsStart
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
      if (segmentPrepareOnly) return
      if (sinks.encoder || sinks.jpegSink) return
      const encoderChoice = options.exportFastEncoder ?? 'auto'
      if (useWebCodecs) {
        let videoFilePath: string
        if (isSegmentWorker && segmentRange) {
          videoFilePath = `${segmentRange.outputPath}.raw.mp4`
        } else {
          const tempDir = await window.electron.ipcRenderer.invoke('electron:get-temp-base-dir')
          sinks.tempBaseDir = tempDir
          const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          videoFilePath = `${tempDir}/mss-fast-${uniqueSuffix}.mp4`
        }
        const encoder = new WebCodecsMp4Encoder({
          width: outW,
          height: outH,
          fps: encodeFps,
          bitrate,
          encoderConfig: this.lastWebCodecsProbeConfig,
          useGpuYuvReadback: true
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
    this.lastSinkKind = sinks.encoder ? 'webcodecs' : 'image2pipe'
    this.lastEncoderLabel = sinks.encoder
      ? sinks.encoder.encoderCodecKind === 'hevc'
        ? 'webcodecs-hevc'
        : 'webcodecs-h264'
      : 'ffmpeg'
    this.lastConvert = 'ffmpeg'

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
    // 测试里的 AnimationManager 可能被替换成精简 mock；导出步进接口允许缺席
    const animationSteps = AnimationManager as unknown as {
      dispatchExportStep?: (ticker: Ticker) => void
      resetExportStepHandlers?: () => void
      setExportStepDriver?: (active: boolean) => void
      exportStepHandlers?: Set<unknown>
    }
    animationSteps.setExportStepDriver?.(true)
    // 非整除帧率（24/25fps）的连续量插值；30/60fps 余量为 0，不参与任何绘制覆盖
    const frameInterpolator = new FrameInterpolator(this.app, this.logger)

    virtualClock.install()
    // 成片帧 n 对应故事帧 n（sse-export `Clock::base`：`table.frames[n*60/fps]`）。
    // PlayCore 前 10 个故事帧（first_frame=10）也是成片的一部分：参考导出默认
    // `--from 0`，前 10 帧只有开场黑幕/空舞台。`virtualRenderStartMs` 是成片帧 0，
    // `timelineStartMs` 是 TimelineCalculator 的 0（故事帧 10），两者相差预热帧。
    const virtualRenderStartMs = virtualClock.now()
    const timelineStartMs = virtualRenderStartMs + PLAYCORE_WARMUP_FRAMES * (1000 / STORY_FPS)

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

    // 帧 0 允许在第一个片段应用之前渲染：参考成片的前 10 帧本来就是 PlayCore 预热
    // （开场黑幕/空舞台）。帧泵只等舞台初始化（开场黑幕已挂上）就放行，不再等片段开工。
    let signalStageReady: (() => void) | null = null
    const stageReady = new Promise<void>((resolve) => {
      signalStageReady = resolve
    })
    const markStageReady = (): void => {
      const resolve = signalStageReady
      signalStageReady = null
      resolve?.()
    }

    const abortFastWait = (): void => {
      concurrentPipeline.abort()
      markStageReady()
      animationSteps.resetExportStepHandlers?.()
      animationSteps.setExportStepDriver?.(false)
      setPumpPaused(false)
      pumpDone = true
    }
    this.signal?.addEventListener('abort', abortFastWait)

    /** 尾部追帧目标（虚拟毫秒）：片段循环结束后让帧泵跑到这个虚拟时间再停 */
    let pumpTargetVirtualMs = -1
    /** 尾部目标故事帧（plan 的 end_frame）；成片只拍到它前 1 帧。 */
    let tailStorySteps = -1
    /** 片尾封包是否还在等虚拟时钟：成片拍完后要继续推进故事步让它收尾。 */
    let endingEnvelopePending = false
    let endingEnvelopeDone = false
    let snippetLoopDone = false
    let pumpError: Error | null = null
    let blackFrameValidationCount = 0
    frameValidator.reset()
    let frameIndex = 0
    /** 已执行的固定 1/60 故事步数 */
    let storyStep = 0

    // !shouldRenderFrame（如 segmentPrepareOnly 或分段 worker 跳过前序帧）时不会经过
    // encodeFrame / PBO 异步等待；若不在每帧让出宏任务，framePump 会在微任务循环里把
    // 浏览器网络回调、IPC 与片段协程彻底饿死。用 MessageChannel 实现亚毫秒级宏任务让出。
    const yieldMacrotask = (() => {
      if (typeof MessageChannel !== 'undefined') {
        const channel = new MessageChannel()
        const queue: Array<() => void> = []
        channel.port1.onmessage = () => {
          const resolve = queue.shift()
          resolve?.()
        }
        return () =>
          new Promise<void>((resolve) => {
            queue.push(resolve)
            channel.port2.postMessage(null)
          })
      }
      return () => virtualClock.realSleep(0)
    })()

    /** 输出帧 k 对应的故事帧：floor(k×60/fps)；步数差按 floor 差分，非整除帧率不放大剧情。 */
    const storyStepForFrame = (frame: number): number => storyFrameForVideoFrame(frame, encodeFps)

    const advanceToStoryStep = async (target: number): Promise<void> => {
      if (target <= storyStep) return
      const tickStart = virtualClock.realTimeMs()
      await virtualClock.advanceStorySteps(target - storyStep, () => {
        const handlers = animationSteps.exportStepHandlers
        const prevSize = handlers ? handlers.size : -1
        animationSteps.dispatchExportStep?.(Ticker.shared)
        const nextSize = handlers ? handlers.size : -1
        // 仅当有动画订阅结束（集合缩减）或 mock 未暴露集合时才触发 64 轮微任务冲刷
        return prevSize < 0 || nextSize !== prevSize
      })
      storyStep = target
      tickMs += virtualClock.realTimeMs() - tickStart
    }

    let skippedStaticFrames = 0
    const framePump = (async (): Promise<void> => {
      try {
        await stageReady
        let hasRenderedFrame = false
        let prevWasVisuallyActive = true
        let prevSceneSig = ''
        let lastEncodedLocalFrame = -encodeFps * 4
        const shouldStop = (): boolean => {
          if (isSegmentWorker && endFrame >= 0 && snippetLoopDone && frameIndex >= endFrame) {
            return true
          }
          if (!pumpDone) return false
          if (isSegmentWorker && endFrame >= 0) {
            return frameIndex >= endFrame
          }
          if (pumpTargetVirtualMs < 0) return true
          if (frameIndex === 0) return false
          // pumpTargetVirtualMs 是绝对虚拟时刻；成片帧 0 就是 renderStartMs。
          return virtualRenderStartMs + frameIndex * frameMs >= pumpTargetVirtualMs - 1e-6
        }
        while (!shouldStop()) {
          this.checkAborted()
          if (pumpPaused && !pumpDone) {
            await waitPumpResumed()
            continue
          }
          const frameStart = virtualClock.realTimeMs()

          // 成片帧 n 就是故事帧 n：先推进到 floor(n×60/fps)，再渲染该帧的模拟结果。
          // 60fps 时帧 0 在 0 个故事步之后渲染（PlayCore 预热帧也在成片里）。
          const videoStoryStep = storyStepForFrame(frameIndex)
          const baseStoryStep = videoStoryStep
          const storyTween = storyFrameTweenForVideoFrame(frameIndex, encodeFps)
          await advanceToStoryStep(baseStoryStep)

          const shouldRenderFrame =
            !segmentPrepareOnly && frameIndex >= startFrame && (endFrame < 0 || frameIndex < endFrame)

          if (shouldRenderFrame) {
            const localFrame = frameIndex - startFrame
            const nextFrameVirtualMs = virtualRenderStartMs + (frameIndex + 1) * frameMs
            const tailFrames = Math.ceil(encodeFps * 0.6)
            const inEndingTail =
              pumpTargetVirtualMs >= 0 &&
              nextFrameVirtualMs > pumpTargetVirtualMs - 600 &&
              frameIndex >
                Math.max(
                  0,
                  Math.ceil((pumpTargetVirtualMs - virtualRenderStartMs) / frameMs) - tailFrames
                )
            const isEdgeFrame =
              localFrame === 0 ||
              (endFrame > 0 && frameIndex >= endFrame - 1) ||
              (pumpDone && pumpTargetVirtualMs >= 0 && nextFrameVirtualMs >= pumpTargetVirtualMs - 1e-6)
            const extendedStageApp = this.app as unknown as {
              isFrameVisuallyActive?: () => boolean
              getStaticSceneSignature?: () => string
            }
            const isVisuallyActive =
              storyTween > 1e-9 || Boolean(extendedStageApp.isFrameVisuallyActive?.())
            const sceneSig =
              !isVisuallyActive && typeof extendedStageApp.getStaticSceneSignature === 'function'
                ? extendedStageApp.getStaticSceneSignature()
                : ''
            const canSkipStatic =
              Boolean(sinks.encoder || sinks.jpegSink?.canRepeatLastFrame) &&
              !isEdgeFrame &&
              !isVisuallyActive &&
              !prevWasVisuallyActive &&
              hasRenderedFrame &&
              sceneSig !== '' &&
              sceneSig === prevSceneSig

            const timestampUs = Math.round(localFrame * (1_000_000 / encodeFps))
            const durationUs = Math.round(1_000_000 / encodeFps)
            // 片尾淡出至黑时 4 秒一个关键帧会把近黑渐变做成大块。
            // 最后约 0.6s 改为每 4 帧一个关键帧，硬件编码器也能跟上暗部变化。
            const framesSinceEncoded = localFrame - lastEncodedLocalFrame
            const keyFrame =
              localFrame === 0 ||
              framesSinceEncoded >= encodeFps * 4 ||
              (inEndingTail ? frameIndex % 4 === 0 : localFrame % (encodeFps * 4) === 0)

            let handledStaticRepeat = false
            if (canSkipStatic) {
              const captureStart = virtualClock.realTimeMs()
              if (sinks.encoder?.repeatLastFrame) {
                handledStaticRepeat = await sinks.encoder.repeatLastFrame(
                  timestampUs,
                  durationUs,
                  keyFrame
                )
              } else if (sinks.jpegSink?.repeatLastFrame) {
                handledStaticRepeat = await sinks.jpegSink.repeatLastFrame()
              }
              snapshotMs += virtualClock.realTimeMs() - captureStart
              if (handledStaticRepeat) {
                skippedStaticFrames++
                lastEncodedLocalFrame = localFrame
                if (skippedStaticFrames % 16 === 0) {
                  await yieldMacrotask()
                }
              }
            }

            if (!handledStaticRepeat) {
              let interpolatedTo: FrameSnapshot | null = null
              if (storyTween > 1e-9) {
                if (frameInterpolator.active) {
                  // base 与 base+1 两个故事步之间按余量 lerp 连续量，阶梯量保持 base
                  const fromSnapshot = frameInterpolator.snapshot()
                  await advanceToStoryStep(baseStoryStep + 1)
                  const toSnapshot = frameInterpolator.snapshot()
                  frameInterpolator.apply(fromSnapshot, toSnapshot, storyTween)
                  interpolatedTo = toSnapshot
                } else {
                  frameInterpolator.logUnavailableOnce()
                }
              }

              const renderStart = virtualClock.realTimeMs()
              this.app.pixiApplication.render()
              renderMs += virtualClock.realTimeMs() - renderStart
              if (interpolatedTo) {
                // 插值只影响本帧绘制；恢复 base+1，保证后续模拟连续
                frameInterpolator.restore(interpolatedTo)
              }
              hasRenderedFrame = true
              prevWasVisuallyActive = isVisuallyActive
              prevSceneSig = sceneSig
              lastEncodedLocalFrame = localFrame

              const captureStart = virtualClock.realTimeMs()
              if (sinks.encoder) {
                await sinks.encoder.encodeFrame(canvas, timestampUs, durationUs, keyFrame)
              } else if (sinks.jpegSink) {
                await sinks.jpegSink.captureFrame(canvas)
              }
              snapshotMs += virtualClock.realTimeMs() - captureStart

              if (
                localFrame === 0 ||
                (blackFrameValidationCount > 0 && localFrame % encodeFps === 0) ||
                localFrame % (encodeFps * 60) === 0
              ) {
                const intentionalBlackCurtain =
                  inEndingTail ||
                  Boolean(
                    (
                      this.app.layerSpecialEffect as
                        | { isBlackCurtainOpaque?: () => boolean }
                        | undefined
                    )?.isBlackCurtainOpaque?.()
                  )
                const v = frameValidator.validateFrame(canvas, frameIndex)
                if (!v.isValid && v.error) {
                  VideoExportManager.warmValidatedApps.delete(this.app)
                  throw new Error(
                    `Rendering validation failed at frame ${frameIndex}: ${v.error}. ` +
                      `Brightness: ${v.brightness.toFixed(2)}%`
                  )
                }
                if (v.isBlackScreen && !intentionalBlackCurtain) {
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
            }
          } else {
            await yieldMacrotask()
          }

          frameIndex++
          pumpMs += virtualClock.realTimeMs() - frameStart
        }
        // 成片只拍到 end_frame 前 1 帧；end_frame 上的收尾回调（片尾淡出到黑、
        // 音频分块）还需要虚拟时钟继续走。这里只推进模拟、不再渲染/采集，
        // 否则帧泵先停会把收尾封包永久挂起（假时钟下没有别的 tick 来源）。
        let flushGuard = 0
        while (
          !pumpError &&
          pumpDone &&
          endingEnvelopePending &&
          !endingEnvelopeDone &&
          flushGuard < 600
        ) {
          await advanceToStoryStep(storyStep + 1)
          flushGuard++
        }
        if (!pumpError && pumpDone && tailStorySteps > storyStep) {
          await advanceToStoryStep(tailStorySteps)
        }
      } catch (e) {
        pumpError = e instanceof Error ? e : new Error(String(e))
      }
    })()

    try {
      // 成片帧 0 = 故事帧 0 = 视频时间 0；timeline 的 0 点在故事帧 10。
      // 时间戳按两个原点各记一份：音频相对成片 0，诊断漂移相对 timeline 0。
      timestampRecorder.markRenderStart(virtualRenderStartMs, timelineStartMs)
      concurrentPipeline.markRenderStart()

      const totalSnippets = snippets.length

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
      // 舞台（开场黑幕/空背景）就绪后才让帧泵渲染帧 0；片段本身还在 delay 里，
      // 它的 act 由故事帧推进触发，帧泵不会等片段结束。
      markStageReady()

      const appSpeechHooks = this.app as unknown as {
        onTalkSpeechStart?: (snippetIndex: number, wallMs: number) => void
      }
      const recorderSpeechHooks = timestampRecorder as unknown as {
        markTalkSpeechStart?: (snippetIndex: number, startWallMs: number) => void
      }
      appSpeechHooks.onTalkSpeechStart = (talkSnippetIndex, wallMs) => {
        recorderSpeechHooks.markTalkSpeechStart?.(talkSnippetIndex, wallMs)
      }

      const pendingTimestampTasks: Promise<void>[] = []
      const flushPendingTimestamps = async (): Promise<void> => {
        if (pendingTimestampTasks.length === 0) return
        const batch = [...pendingTimestampTasks]
        pendingTimestampTasks.length = 0
        await Promise.allSettled(batch)
      }

      const segStartMs = (startFrame / Math.max(1, encodeFps)) * 1000
      const segEndMs =
        endFrame >= 0 ? (endFrame / Math.max(1, encodeFps)) * 1000 : Number.POSITIVE_INFINITY
      const segEndTimelineMs =
        isSegmentWorker && endFrame >= 0
          ? Math.max(
              0,
              (storyStepForFrame(endFrame) - PLAYCORE_WARMUP_FRAMES) * (1000 / STORY_FPS)
            )
          : Number.POSITIVE_INFINITY

      for (let i = 0; i < totalSnippets; i++) {
        this.checkAborted()
        if (pumpError) throw pumpError

        const snippet = snippets[i]
        if (isSegmentWorker && timeline[i]) {
          const preDelayStartMs =
            timeline[i].delayStartTimeMs ??
            Math.max(0, timeline[i].startTimeMs - Math.round((snippet.delay || 0) * 1000))
          if (preDelayStartMs >= segEndTimelineMs) {
            break
          }
        }
        if (snippetHasPreFence(snippet)) {
          await this.app.snippetStrategyManager?.waitForPreFence?.(snippet)
          await flushPendingTimestamps()
        }

        exportTraceContext.setSnippet(i, snippet.type)
        // 参考 `CurrentDisplayStatus`：布局片段的 shown 在 act 生效，不等淡入结束。
        // 计划层按剧本顺序记状态，避免 Now Appear 与 Talk 同帧时运行时状态滞后。
        {
          const layoutModelId =
            Number(((snippet as { data?: { modelId?: number } }).data ?? {}).modelId) || -1
          if (layoutModelId >= 0) {
            if (snippet.type === 'LayoutAppear') this.exportModelShown.set(layoutModelId, true)
            else if (snippet.type === 'LayoutClear') this.exportModelShown.set(layoutModelId, false)
          }
        }
        const isTalk = snippet.type === 'Talk'
        const talkData = snippet.type === 'Talk' ? snippet.data : undefined
        const nowMs = performance.now()
        // 片段 delay 从当前时刻开始，Talk 的 act 在 delay 之后；gate 用的是相对 act
        // 的剩余时间，必须先把 delay 帧减掉。否则 delay=2s 的 Talk 会把上一段动作
        // 的剩余时间多算 121 帧（片尾 HideTalk 前的两句实测多出 97 帧）。
        const snippetDelayMs = Math.max(0, Number(snippet.delay) || 0) * 1000
        const actOffsetMs = framesForSeconds(snippetDelayMs / 1000) * FRAME_MS
        const layoutRunningMs = isTalk
          ? Math.max(0, getLayoutRunningEndMs(this.app) - nowMs - actOffsetMs)
          : 0
        const existingMotionSettleMs = isTalk
          ? Math.max(0, getMotionSettledEndMs(this.app) - nowMs - actOffsetMs)
          : 0

        let resolvedTalkDurationMs: number | undefined
        // 自身动作的收尾与 TTS 是否开启无关：官方 `talk_start` 同帧 set_body，
        // 计划层的 Talk gate 必须等它结束（否则动作会被提前掐断）。
        if (talkData) {
          const ownSettleFrames = this.talkOwnMotionSettleFrames(
            talkData as unknown as TalkSnippetLike
          )
          if (ownSettleFrames > 0) {
            this.talkSettleFramesByIndex.set(
              i,
              Math.max(this.talkSettleFramesByIndex.get(i) ?? 0, ownSettleFrames)
            )
          }
        }
        if (ttsEnabled && isSegmentWorker && talkData) {
          const pre = precomputedTts?.[i]
          const ttsDurationMs = pre && pre.durationMs > 0 ? pre.durationMs : 0
          const silentHoldMs =
            ttsDurationMs <= 0 &&
            !(talkData as { voice?: string }).voice &&
            !hasSpeakableSpeechText(talkData.ttsText ?? '') &&
            !hasSpeakableSpeechText(talkData.content ?? '')
              ? SILENT_PUNCTUATION_HOLD_MS
              : undefined
          const officialVoiceMs =
            Number((talkData as { voiceDurationMs?: number }).voiceDurationMs) || 0
          const plannedMs = officialVoiceMs > 0 ? plannedTalkDurationMs.get(i) : undefined
          resolvedTalkDurationMs = applyTalkPatch(
            timeline,
            i,
            ttsDurationMs,
            plannedMs ??
              this.talkDurationWithMotionGate(
                talkData as unknown as TalkSnippetLike,
                ttsDurationMs,
                this.talkWindowOpenMs(snippets, i, timeline),
                i,
                layoutRunningMs,
                existingMotionSettleMs,
                silentHoldMs,
                (snippet.delay || 0) * 1000
              )
          )
          this.app.ttsManager.setTimeline(timeline)
          const patchedEntry = timeline[i]
          const overlapsSegment =
            patchedEntry &&
            patchedEntry.endTimeMs >= Math.max(0, segStartMs - 5000) &&
            patchedEntry.startTimeMs <= segEndMs + 500
          if (ttsDurationMs > 0 && pre?.filePath && overlapsSegment) {
            const wavBuf = await readBridgeTempFile(pre.filePath)
            await this.prepareTalkLipSync(wavBuf, i, this.lipScaleForSnippet(snippets, i))
          } else {
            this.app.currentTalkLipSync = null
          }
        } else if (ttsEnabled && talkData) {
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
          const officialVoiceMs =
            Number((talkData as { voiceDurationMs?: number }).voiceDurationMs) || 0
          const plannedMs = officialVoiceMs > 0 ? plannedTalkDurationMs.get(i) : undefined
          resolvedTalkDurationMs = applyTalkPatch(
            timeline,
            i,
            ttsDurationMs,
            plannedMs ??
              this.talkDurationWithMotionGate(
                talkData as unknown as TalkSnippetLike,
                ttsDurationMs,
                this.talkWindowOpenMs(snippets, i, timeline),
                i,
                layoutRunningMs,
                existingMotionSettleMs,
                silentHoldMs,
                (snippet.delay || 0) * 1000
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
        } else if (isTalk && talkData) {
          this.app.currentTalkLipSync = null
          // 没有 TTS 时也要按官方 gate 时长播放（含官方 voiceDurationMs 与动作收尾），
          // 并把后续时间线一起平移，否则运行时比计划早结束、动作被掐断。
          const silentHoldMs =
            !(talkData as { voice?: string }).voice &&
            !hasSpeakableSpeechText(talkData.ttsText ?? '') &&
            !hasSpeakableSpeechText(talkData.content ?? '')
              ? SILENT_PUNCTUATION_HOLD_MS
              : undefined
          const officialVoiceMs =
            Number((talkData as { voiceDurationMs?: number }).voiceDurationMs) || 0
          const plannedMs = officialVoiceMs > 0 ? plannedTalkDurationMs.get(i) : undefined
          resolvedTalkDurationMs = applyTalkPatch(
            timeline,
            i,
            0,
            plannedMs ??
              this.talkDurationWithMotionGate(
                talkData as unknown as TalkSnippetLike,
                0,
                this.talkWindowOpenMs(snippets, i, timeline),
                i,
                layoutRunningMs,
                existingMotionSettleMs,
                silentHoldMs,
                (snippet.delay || 0) * 1000
              )
          )
          this.app.ttsManager.setTimeline(timeline)
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
                this.talkWindowOpenMs(snippets, i, timeline),
                i,
                layoutRunningMs,
                existingMotionSettleMs,
                undefined,
                (snippet.delay || 0) * 1000
              )
            : Math.max(Math.round((snippet.delay || 0) * 1000), estimateSnippetDuration(snippet)))

        // 片段实际启动必须落在时间线的 delayStart/act 上，而不是上一片段一 resolve
        // 就立刻启动。plan 在每个 blocking 片段后留了 1 帧栅栏；旧循环把这帧吃掉，
        // 49 条 Talk 的实际起点因此累积早约 332ms。
        const plannedDelayStartMs =
          timelineEntry?.delayStartTimeMs ??
          Math.max(0, (timelineEntry?.startTimeMs ?? 0) - Math.round((snippet.delay || 0) * 1000))
        if (isSegmentWorker && plannedDelayStartMs >= segEndTimelineMs) {
          break
        }
        const waitForPlannedStartMs = timelineStartMs + plannedDelayStartMs - virtualClock.now()
        if (waitForPlannedStartMs > 0.5 && !this.isAborted) {
          await AnimationManager.delay(Math.max(0, waitForPlannedStartMs - 0.001))
        }

        if (isTalk) {
          this.app.currentTalkStartedAtMs = 0
          timestampRecorder.markSnippetStart(i, snippet.type, {
            speaker: talkData?.speaker,
            content: talkData?.content
          })
        }

        const snippetStartedAtMs = performance.now()
        // 启动若晚于 plan 的 delayStart，BaseSnippet 只补到 plan act 的剩余 delay，
        // 防止开场初始化/上一片段抖动把 act 整体推后。timeline 的 0 点是故事帧 10，
        // 所以这里用 timeline 坐标系（可能为负，不能 clamp 掉预热帧）。
        const plannedActMs = timelineEntry?.startTimeMs
        const currentTimelineMs = virtualClock.now() - timelineStartMs
        const delayOverrideMs =
          plannedActMs !== undefined ? Math.max(0, plannedActMs - currentTimelineMs) : undefined
        // 绝对 act 墙钟：handleSnippetForExport 内部还要过 WaitFinished 前置栅栏，
        // 若栅栏耗时一帧，delayOverride 的起点会整体后移。BaseSnippet 用绝对时刻
        // 重算剩余 delay，保证 fade/sidefade 等从 plan act 帧起步。
        const actWallMs = plannedActMs !== undefined ? timelineStartMs + plannedActMs : undefined
        const snippetSetup = this.app.snippetStrategyManager.handleSnippetForExport(
          snippet,
          i,
          delayOverrideMs,
          actWallMs
        )
        await snippetSetup
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
            ;(
              timestampRecorder as unknown as {
                markSnippetEnd: (
                  ttsDurationMs?: number,
                  speechOffsetMs?: number,
                  snippetIndex?: number
                ) => void
              }
            ).markSnippetEnd(ttsDur, speechOffsetMs, i)
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

      snippetLoopDone = true

      if (isSegmentWorker && segmentRange) {
        setPumpPaused(false)
        pumpDone = true
        await framePump
        if (pumpError) throw pumpError

        virtualClock.uninstall()
        const finishStart = virtualClock.realTimeMs()
        const segVideoRaw = sinks.encoder
          ? await sinks.encoder.finish()
          : await sinks.jpegSink!.finish()
        if (sinks.jpegSink?.isPipeMode) {
          sinks.pipeTempDir = segVideoRaw.replace(/[\\/][^\\/]*$/, '')
        }
        encodeMs = virtualClock.realTimeMs() - finishStart

        const segFrames = Math.max(1, segmentRange.endFrame - segmentRange.startFrame)
        const segDurationSec = segFrames / Math.max(1, encodeFps)
        const maxOutputMbps = options.maxOutputMbps ?? 3.5
        const invokeStart = virtualClock.realTimeMs()
        let finalSegmentPath = segVideoRaw
        let segmentConvert: 'browser' | 'ffmpeg' = 'browser'
        const segPlan = resolveRemuxCodecPlan(options.codec, sinks.encoder)
        let segCodec: 'h264' | 'hevc' = sinks.encoder
          ? segPlan.encoderCodec
          : options.codec === 'h264'
            ? 'h264'
            : 'hevc'

        if (sinks.encoder) {
          const actualMbps =
            segDurationSec >= 2 ? (sinks.encoder.writtenBytes * 8) / (segDurationSec * 1_000_000) : 0
          const needsRemux =
            segPlan.transcode || (maxOutputMbps > 0 && actualMbps > maxOutputMbps)
          if (needsRemux) {
            const remuxRes = await window.electron.ipcRenderer.invoke(
              'electron:api-remux-video-from-files',
              {
                videoPath: segVideoRaw,
                outputPath: segmentRange.outputPath,
                audioBitrate: options.apiAudioBitrate ?? '128k',
                frameCount: segFrames,
                fps: encodeFps,
                ...(segPlan.targetCodec ? { codec: segPlan.targetCodec } : {}),
                transcode: segPlan.transcode,
                inputWidth: outW,
                inputHeight: outH,
                crf: options.apiCrf ?? options.crf ?? 23,
                recordedBitrate: bitrate,
                inputCodec: segPlan.encoderCodec
              }
            )
            if (!remuxRes?.success) {
              throw new Error(remuxRes?.error || 'Segment video remux failed')
            }
            finalSegmentPath = segmentRange.outputPath
            segCodec = segPlan.finalCodec
            segmentConvert = segPlan.needsColorConversion ? 'ffmpeg' : 'browser'
          }
        } else if (sinks.jpegSink?.isPipeMode) {
          const remuxRes = await window.electron.ipcRenderer.invoke(
            'electron:api-remux-video-from-files',
            {
              videoPath: segVideoRaw,
              outputPath: segmentRange.outputPath,
              audioBitrate: options.apiAudioBitrate ?? '128k',
              frameCount: segFrames,
              fps: encodeFps
            }
          )
          if (!remuxRes?.success) {
            throw new Error(remuxRes?.error || 'Segment pipe video remux failed')
          }
          finalSegmentPath = segmentRange.outputPath
          segmentConvert = 'ffmpeg'
        } else {
          const framesDir = sinks.framesDir || segVideoRaw
          const encRes = await window.electron.ipcRenderer.invoke('electron:api-encode-frames-video', {
            framesDir,
            outputPath: segmentRange.outputPath,
            fps: encodeFps,
            audioBitrate: options.apiAudioBitrate ?? '128k',
            inputWidth: outW,
            inputHeight: outH
          })
          if (!encRes?.success) {
            throw new Error(encRes?.error || 'Segment frames encode failed')
          }
          finalSegmentPath = segmentRange.outputPath
          segmentConvert = 'ffmpeg'
        }
        invokeMs = virtualClock.realTimeMs() - invokeStart
        VideoExportManager.warmValidatedApps.add(this.app)

        const timings: Record<string, number> = {
          pumpMs: Math.round(pumpMs),
          tickMs: Math.round(tickMs),
          renderMs: Math.round(renderMs),
          snapshotMs: Math.round(snapshotMs),
          ttsSetupMs: 0,
          ttsWaitMs: 0,
          encodeMs: Math.round(encodeMs),
          audioMs: 0,
          invokeMs: Math.round(invokeMs),
          frames: segFrames,
          encodedFrames: segFrames,
          videoDurationMs: Math.round(segDurationSec * 1000),
          wallMs: Math.round(virtualClock.realTimeMs() - realStart),
          avgPumpFps: pumpMs > 0 ? Math.round((segFrames / (pumpMs / 1000)) * 10) / 10 : 0
        }
        return {
          success: true,
          duration: segDurationSec,
          frameCount: segFrames,
          videoPath: finalSegmentPath,
          segmentCodec: segCodec,
          segmentConvert,
          timings
        }
      }

      // 官方 WaitAllFinished + 开场黑幕收尾 + 0.25s 停留 + 0.25s BGM/黑幕淡出。
      await this.app.snippetStrategyManager?.settleBackgroundSnippets?.()
      await flushPendingTimestamps()
      // 开场黑幕与片尾黑幕可以并行：在这里等它会把片尾起点推迟到 0.5s，
      // 短剧本的 ending envelope 因此被多算若干帧。让帧泵继续推进即可。

      // 以最终烘焙的 plan 为唯一帧数依据：plan.totalFrames 已包含 10 帧预热与
      // playedWaitTime + 1 + BGM fade 的 31 帧尾长。不能只用 timeline.endTimeMs，
      // 因为前置栅栏会让 plan 的最后一个片段排在 timeline 末尾之后（effects 实测
      // 753 vs 814 帧），帧泵会提前停、收尾黑幕计时器再也得不到步进。
      const finalPlan = bakeStoryPlan(snippets, timeline, {
        motionSettleFrames: this.talkSettleFramesByIndex,
        motionClipFrames: this.buildMotionClipFrames(snippets),
        exportFps: encodeFps,
        ttsEnabled
      })
      // 官方 end_frame = cleanup + playedWaitTime(15) + 1 + BGM fade(15) = +31 帧。
      // 没有 setEndingEnvelope 的宿主不会补这段尾长，目标停在最后一个片段帧。
      const hasEndingEnvelope = typeof extendedApp.setEndingEnvelope === 'function'
      // plan 的故事帧号就是成片帧号（含 PlayCore 前 10 帧），成片帧数不再 −10。
      const plannedStoryFrames = Math.max(
        1,
        hasEndingEnvelope ? finalPlan.totalFrames : finalPlan.entries.at(-1)!.endFrame
      )
      const endingEnvelopeMs = hasEndingEnvelope
        ? PLAYED_WAIT_TIME_MS + FRAME_MS + SCENARIO_EXIT_BGM_FADE_MS
        : 0
      // plan 的帧号是 60fps 故事帧；编码帧率可能是 30fps，不能直接乘 frameMs。
      const storyFrameMs = 1000 / STORY_FPS
      const envelopeFrames = hasEndingEnvelope
        ? // 250ms + 1 帧 + 250ms 都是帧量化值（15+1+15=31）；
          // 直接用 ceil 会把 31.000000000000004 收成 32，额外多拍 1 帧。
          Math.max(1, Math.round(endingEnvelopeMs / storyFrameMs))
        : 0
      const currentStoryFrame = storyStepForFrame(frameIndex)
      // 若运行时最后一条片段晚 1~2 帧，收尾黑幕的 hold/fade 相应缩短，
      // 而不是延长目标帧并在成片尾部多拍。
      const envelopeOverrunFrames = Math.max(
        0,
        currentStoryFrame + envelopeFrames - plannedStoryFrames
      )
      const targetFrames = plannedStoryFrames
      // 成片帧数由 plan 直接换算（`Clock::frames`）：ceil(storyFrames × fps / 60)。
      // 帧泵按「输出帧」计时，不能把 60Hz 故事时长四舍五入到最近的输出帧：
      // 25fps、plan=77 故事帧时 1283.33ms / 40ms = 32.08，四舍五入只拍 32 帧，
      // 而参考 `Clock.frames(0..77)` 是 33 帧。目标时刻必须是 finalFrameCount 帧。
      const finalFrameCount = videoFrameCountForStoryFrames(targetFrames, encodeFps)
      const rawPumpTargetMs = virtualRenderStartMs + targetFrames * storyFrameMs
      pumpTargetVirtualMs = virtualRenderStartMs + finalFrameCount * frameMs
      const holdFrames = Math.max(
        0,
        Math.round(PLAYED_WAIT_TIME_MS / storyFrameMs) - envelopeOverrunFrames
      )
      const fadeFrames = Math.max(
        0,
        Math.round(SCENARIO_EXIT_BGM_FADE_MS / storyFrameMs) -
          Math.max(0, envelopeOverrunFrames - Math.round(PLAYED_WAIT_TIME_MS / storyFrameMs))
      )
      const endingHoldMs = holdFrames * storyFrameMs
      const endingFadeMs = fadeFrames * storyFrameMs
      this.logger.info('Fast export tail target', {
        renderStartMs: virtualRenderStartMs,
        timelineStartMs,
        planTotalFrames: finalPlan.totalFrames,
        plannedStoryFrames,
        currentFrame: frameIndex,
        envelopeFrames,
        envelopeOverrunFrames,
        endingHoldMs,
        endingFadeMs,
        rawPumpTargetMs,
        finalFrameCount,
        pumpTargetVirtualMs,
        targetFrames: finalFrameCount
      })
      // 收尾黑幕从片段循环结束的当前虚拟时刻启动；目标帧已为它预留完整尾长。
      tailStorySteps = targetFrames
      endingEnvelopePending = hasEndingEnvelope
      const endingEnvelopeTask = hasEndingEnvelope
        ? extendedApp.setEndingEnvelope!(endingHoldMs, endingFadeMs)
        : Promise.resolve()
      void endingEnvelopeTask.then(
        () => {
          endingEnvelopeDone = true
        },
        () => {
          endingEnvelopeDone = true
        }
      )
      // 先解除暂停并标记片段播放完毕，帧泵看到目标帧就停；否则收尾黑幕
      // 结束时帧泵会多拍 1 帧。
      setPumpPaused(false)
      pumpDone = true

      // 收尾并行：帧泵还在追尾帧时就开始混音/流式写 WAV。
      // 时长在片段全部落定后即可精确推出（帧数 = ceil(target/frameMs)）。
      const hasTtsTracks = ttsEnabled && ttsAudioResults.size > 0
      const actualVideoDurationMs = timestampRecorder.getTotalVideoDurationMs()
      // targetFrames 是 60Hz 故事帧数；成片帧 n 覆盖故事帧 n，按编码帧率换算：
      // ceil(storyFrames × fps / 60)。用浮点 ceil 会把 835.0000004 收成 836，
      // 所以交给 videoFrameCountForStoryFrames 做整数换算（也用于上面的帧泵目标）。
      const totalDurationMs = Math.max(
        actualVideoDurationMs + endingEnvelopeMs,
        Math.round((finalFrameCount / encodeFps) * 1000)
      )
      const actualStartTimesMs = snippets.map((_, index) =>
        timestampRecorder.getVideoRelativeStartTimeMs(index)
      )
      const audioTask = (async (): Promise<string | undefined> => {
        if (isSegmentWorker) return undefined
        if (!(hasTtsTracks || bgmActive || sePlan.hasChanges)) return undefined

        const audioPlacements = hasTtsTracks
          ? timestampRecorder.buildAudioTrackPlacements(ttsAudioResults)
          : []
        const useSharedMixFile = segmentPrepareOnly && Boolean(options.segmentSharedDir)
        const targetMixPath = useSharedMixFile
          ? `${options.segmentSharedDir}/mixed-${sharedWriteId}.wav`
          : undefined

        if (useRustAudio) {
          try {
            const rustBgm = bgmPlan.hasChanges
              ? bgmPlan.getRustCues(actualStartTimesMs)
              : { cues: [], volumeTweens: [] }
            const rustSeCues = sePlan.hasChanges ? sePlan.getRustCues(actualStartTimesMs) : []
            const voices = audioPlacements.map((placement) => ({
              startMs: placement.startTimeMs,
              endMs: placement.endTimeMs,
              audioBase64: this.arrayBufferToBase64(placement.audioBuffer)
            }))
            const resp = await fetch('/bridge/rust/mix-audio-plan', {
              method: 'POST',
              headers: this.bridgeFetchHeaders({ 'content-type': 'application/json' }),
              body: JSON.stringify({
                durationMs: totalDurationMs,
                ...(targetMixPath ? { outputPath: targetMixPath } : {}),
                ...(bgmActive || bgmPlan.hasChanges
                  ? {
                      bgm: {
                        enabled: bgmEnabled,
                        volume: bgmConfig?.volume ?? 0.35,
                        ...(useGlobalBgm && bgmConfig?.path
                          ? { globalPath: resolveBgmUrl(bgmConfig.path) }
                          : {}),
                        cues: rustBgm.cues,
                        volumeTweens: rustBgm.volumeTweens
                      }
                    }
                  : {}),
                ...(rustSeCues.length > 0 ? { se: { cues: rustSeCues } } : {}),
                ...(voices.length > 0 ? { voices } : {})
              })
            })
            if (resp.ok) {
              const resJson = (await resp.json()) as {
                ok?: boolean
                outputPath?: string
                elapsedMs?: number
              }
              if (resJson?.ok && resJson.outputPath) {
                this.logger.info(
                  `Rust mixAudioPlan finished in ${resJson.elapsedMs ?? 0}ms → ${resJson.outputPath}`
                )
                this.pcmCache.clear()
                this.lipSyncCache.clear()
                return resJson.outputPath
              }
            } else if (resp.status === 503) {
              this.rustAudioUnavailable = true
            }
          } catch (rustMixErr) {
            this.logger.warn('Rust mix-audio-plan failed, falling back to AudioMuxer:', rustMixErr)
          }
          bgmBuffer = await loadFallbackJsAudio()
        }

        if (bgmPlan.hasChanges) {
          audioMuxer.setBgmCues(bgmPlan.build(actualStartTimesMs, useGlobalBgm ? bgmBuffer : null))
        }
        if (sePlan.hasChanges) {
          audioMuxer.setSeCues(sePlan.build(actualStartTimesMs))
        }
        if (hasTtsTracks) {
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

        const mixInputBgm = bgmBuffer || undefined
        const muxer = audioMuxer as unknown as {
          mixToInt16Chunks?: (durationMs: number, bgm?: AudioBuffer) => AsyncGenerator<Int16Array>
          createWavHeader?: (durationMs: number) => ArrayBuffer
          mixToInt16Interleaved?: (durationMs: number, bgm?: AudioBuffer) => Promise<Int16Array>
          encodeWavFromInt16?: (pcm: Int16Array) => ArrayBuffer
          mixAudioTracks?: (durationMs: number, bgm?: AudioBuffer) => Promise<AudioBuffer>
          audioBufferToWav?: (buffer: AudioBuffer) => Promise<ArrayBuffer>
        }

        let path: string
        if (
          typeof muxer.mixToInt16Chunks === 'function' &&
          typeof muxer.createWavHeader === 'function'
        ) {
          // 流式：先写 44 字节头，再按块追加 Int16 PCM；不再分配整段 Int16 + WAV
          path = useSharedMixFile
            ? `${options.segmentSharedDir}/mixed-${sharedWriteId}.wav`
            : await window.electron.ipcRenderer.invoke('electron:write-temp-file', {
                data: new ArrayBuffer(0),
                prefix: 'mss-audio',
                extension: 'wav'
              })
          try {
            await window.electron.ipcRenderer.invoke('electron:append-to-file', {
              filePath: path,
              data: new Uint8Array(muxer.createWavHeader(totalDurationMs))
            })
            for await (const chunk of muxer.mixToInt16Chunks(totalDurationMs, mixInputBgm)) {
              await window.electron.ipcRenderer.invoke('electron:append-to-file', {
                filePath: path,
                // bridge 客户端只把 ArrayBuffer/Uint8Array 识别为二进制参数
                data: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
              })
            }
          } catch (error) {
            if (!useSharedMixFile) {
              await window.electron.ipcRenderer
                .invoke('electron:delete-temp-file', { filePath: path })
                .catch(() => undefined)
            }
            throw error
          }
        } else {
          let wavBuffer: ArrayBuffer
          if (
            typeof muxer.mixToInt16Interleaved === 'function' &&
            typeof muxer.encodeWavFromInt16 === 'function'
          ) {
            const pcm = await muxer.mixToInt16Interleaved(totalDurationMs, mixInputBgm)
            wavBuffer = muxer.encodeWavFromInt16(pcm)
          } else {
            const mixedAudioBuffer = await muxer.mixAudioTracks!(totalDurationMs, mixInputBgm)
            wavBuffer = await muxer.audioBufferToWav!(mixedAudioBuffer)
          }
          if (useSharedMixFile) {
            path = `${options.segmentSharedDir}/mixed-${sharedWriteId}.wav`
            await window.electron.ipcRenderer.invoke('electron:append-to-file', {
              filePath: path,
              data: new Uint8Array(wavBuffer)
            })
          } else {
            path = await window.electron.ipcRenderer.invoke('electron:write-temp-file', {
              data: wavBuffer,
              prefix: 'mss-audio',
              extension: 'wav'
            })
          }
        }
        this.pcmCache.clear()
        this.lipSyncCache.clear()
        return path
      })()

      await endingEnvelopeTask
      await framePump
      if (pumpError) throw pumpError

      concurrentPipeline.markRenderEnd()
      timestampRecorder.logSummary()

      // 帧泵/收尾封包都已结束；编码冲刷和最终 MP4 定位写必须回到真实时钟。
      // 假时钟下最后一块 muxer 数据可能一直等不到下一次 tick，长片会卡在
      // 片尾分块写入直到客户端超时。
      virtualClock.uninstall()

      const finishStart = virtualClock.realTimeMs()
      if (segmentPrepareOnly) {
        const [audioFilePath] = await Promise.all([
          audioTask.then((res) => {
            audioMs = virtualClock.realTimeMs() - finishStart
            return res
          }),
          Promise.allSettled(sharedTtsUploadTasks)
        ])
        sinks.audioFilePath = null
        const videoDurationMs = (finalFrameCount / Math.max(1, encodeFps)) * 1000
        const timings: Record<string, number> = {
          pumpMs: Math.round(pumpMs),
          tickMs: Math.round(tickMs),
          renderMs: 0,
          snapshotMs: 0,
          ttsSetupMs: Math.round(ttsSetupMs),
          ttsWaitMs: Math.round(ttsWaitMs),
          encodeMs: 0,
          audioMs: Math.round(audioMs),
          invokeMs: 0,
          frames: finalFrameCount,
          encodedFrames: finalFrameCount,
          videoDurationMs: Math.round(videoDurationMs),
          wallMs: Math.round(virtualClock.realTimeMs() - realStart),
          avgPumpFps: 0
        }
        const prepResult: ExportResult = {
          success: true,
          duration: videoDurationMs / 1000,
          frameCount: finalFrameCount,
          timings
        }
        this.attachDiagnostics(
          prepResult,
          snippets,
          timeline,
          timestampRecorder,
          ttsAudioResults,
          'fast',
          options,
          ttsEnabled
        )
        prepResult.prepared = {
          totalFrames: finalFrameCount,
          encodeFps,
          audioFilePath,
          ttsWavs: preparedTtsWavs,
          diagnostics: prepResult.diagnostics,
          timings
        }
        return prepResult
      }

      const finishVideoSink = async (): Promise<string> => {
        if (sinks.encoder) {
          return sinks.encoder.finish()
        }
        const path = await sinks.jpegSink!.finish()
        if (sinks.jpegSink!.isPipeMode) {
          sinks.pipeTempDir = path.replace(/[\\/][^\\/]*$/, '')
        }
        return path
      }

      const [audioFilePath, videoFilePath] = await Promise.all([
        audioTask.then((res) => {
          audioMs = virtualClock.realTimeMs() - finishStart
          return res
        }),
        finishVideoSink().then((res) => {
          encodeMs = virtualClock.realTimeMs() - finishStart
          return res
        })
      ])
      sinks.audioFilePath = audioFilePath ?? null

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
        // WebCodecs 的硬件编码器经常输出 full-range/yuvj420p 且带 sRGB TRC；
        // 此时必须让宿主按统一 BT.709/tv 滤镜链重编码，不能直接 copy 容器。
        const codecPlan = resolveRemuxCodecPlan(options.codec, sinks.encoder)
        saveResult = await window.electron.ipcRenderer.invoke(
          'electron:api-remux-video-from-files',
          {
            videoPath: videoFilePath,
            audioPath: audioFilePath,
            outputPath,
            audioBitrate,
            frameCount: finalFrameCount,
            fps: encodeFps,
            ...(codecPlan.targetCodec ? { codec: codecPlan.targetCodec } : {}),
            ...(sinks.encoder
              ? {
                  transcode: codecPlan.transcode,
                  inputWidth: outW,
                  inputHeight: outH,
                  crf: options.apiCrf ?? options.crf ?? 23,
                  recordedBitrate: bitrate,
                  inputCodec: codecPlan.encoderCodec
                }
              : {})
          }
        )
        if (sinks.encoder) {
          this.lastEncoderLabel = codecPlan.transcode
            ? `webcodecs-${codecPlan.encoderCodec}+${codecPlan.finalCodec === 'hevc' ? 'hevc_qsv' : 'ffmpeg'}`
            : `webcodecs-${codecPlan.encoderCodec}`
          this.lastConvert = codecPlan.needsColorConversion ? 'ffmpeg' : 'browser'
        }
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

      // API 的 duration 必须描述成片本身（frameCount / fps），不是渲染墙钟耗时。
      // encodedFrames 是 WebCodecs 实际编码帧数；多出的一帧只用于冲刷编码器，
      // 由宿主按 frameCount 截断，避免写成片尾多一帧。
      const videoDurationMs = (finalFrameCount / Math.max(1, encodeFps)) * 1000
      const timings: Record<string, number> = {
        pumpMs: Math.round(pumpMs),
        tickMs: Math.round(tickMs),
        renderMs: Math.round(renderMs),
        snapshotMs: Math.round(snapshotMs),
        ttsSetupMs: Math.round(ttsSetupMs),
        ttsWaitMs: Math.round(ttsWaitMs),
        encodeMs: Math.round(encodeMs),
        audioMs: Math.round(audioMs),
        invokeMs: Math.round(invokeMs),
        frames: finalFrameCount,
        encodedFrames: frameIndex,
        skippedStaticFrames,
        videoDurationMs: Math.round(videoDurationMs),
        // 墙钟耗时保留在 timings，供性能排查；不再冒充 API 的 duration
        wallMs: Math.round(virtualClock.realTimeMs() - realStart),
        avgPumpFps: pumpMs > 0 ? Math.round((frameIndex / (pumpMs / 1000)) * 10) / 10 : 0
      }

      const result = {
        success: true,
        duration: videoDurationMs / 1000,
        frameCount: finalFrameCount,
        outputSize: saveResult.fileSize,
        timings
      }

      this.logger.info(
        `Fast export phase timings: pump=${pumpMs.toFixed(0)}ms ` +
          `(tick=${tickMs.toFixed(0)}ms render=${renderMs.toFixed(0)}ms ` +
          `capture=${snapshotMs.toFixed(0)}ms skippedStatic=${skippedStaticFrames}) ` +
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
      markStageReady()
      animationSteps.resetExportStepHandlers?.()
      animationSteps.setExportStepDriver?.(false)
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
      ;(
        this.app as unknown as {
          onTalkSpeechStart?: ((snippetIndex: number, wallMs: number) => void) | null
        }
      ).onTalkSpeechStart = null
      animationSteps.resetExportStepHandlers?.()
      animationSteps.setExportStepDriver?.(false)
      try {
        const strategy = this.app.snippetStrategyManager as unknown as {
          onSnippetStarted?: ((snippetIndex: number) => void) | null
        }
        if (strategy) strategy.onSnippetStarted = null
      } catch {
        /* app may already be destroyed */
      }
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
    const skipWarmValidation =
      options.segmentPrepareOnly === true ||
      (VideoExportManager.warmValidatedApps.has(this.app) && !glLost)

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
    if (!options.segmentPrepareOnly) {
      await this.prewarmStoryModels()
    }

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
      if (useGlobalBgm && bgmConfig.path) {
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
                this.talkWindowOpenMs(snippets, i, timeline),
                i,
                Math.max(0, getLayoutRunningEndMs(this.app) - nowMs),
                Math.max(0, getMotionSettledEndMs(this.app) - nowMs),
                undefined,
                (snippet.delay || 0) * 1000
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
      const trackBySnippetIndex = new Map<number, (typeof audioTracks)[number]>()
      for (const track of audioTracks) {
        const idx = (track as { snippetIndex?: number }).snippetIndex
        if (typeof idx === 'number') trackBySnippetIndex.set(idx, track)
      }
      let talkIdx = 0

      for (let i = 0; i < snippets.length; i++) {
        if (snippets[i].type === 'Talk') {
          const duration = ttsDurations.get(i) ?? timeline[i]?.durationMs ?? 0
          const track = trackBySnippetIndex.get(i) ?? audioTracks[talkIdx]

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

    const resultVideoDurationMs = (capturedFrames / Math.max(1, options.fps)) * 1000
    const result: ExportResult = {
      success: true,
      duration: resultVideoDurationMs / 1000,
      frameCount: capturedFrames,
      timings: {
        frames: capturedFrames,
        videoDurationMs: Math.round(resultVideoDurationMs),
        wallMs: Math.round(performance.now() - captureStartTime)
      }
    }
    this.lastSinkKind = 'frames'
    this.lastEncoderLabel = 'ffmpeg'
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
