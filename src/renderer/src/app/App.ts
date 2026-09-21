import '@pixi/unsafe-eval'
import getSubLogger from '../utils/Logger'
import { ILogObj, Logger } from 'tslog'
import { StoryData } from '../../../common/types/Story'
import StoryManager from '../managers/StoryManager'
import { Live2DModelMap, TextureMap } from '../types/AssetMap'
import BackgroundLayer from '../layers/BackgroundLayer'
import ModelLayer from '../layers/ModelLayer'
import AdvancedModel from '../model/AdvancedModel'
import SnippetStrategyManager from '../managers/SnippetStrategyManager'
import UILayer from '../layers/UILayer'
import FontFaceObserver from 'fontfaceobserver'
import { Application, Texture, Ticker } from 'pixi.js'
import SpecialEffectLayer from '../layers/SpecialEffectLayer'
import { configureCubism4 } from 'pixi-live2d-display-advanced'
import VideoExportManager, {
  VideoExportOptions,
  ExportProgress
} from '../managers/VideoExportManager'
import AnimationManager from '../managers/AnimationManager'
import { TTSManager } from '../managers/TTSManager'
import { AudioMuxer } from '../managers/video-export/AudioMuxer'
import { applyTalkPatch } from '../managers/video-export/segmentTypes'
import { resolveBgmUrl } from '../utils/ResourceUrl'

/** 宿主统一下发的 TTS 配置（config.yaml 的 tts 节） */
export interface ApiExportTtsConfig {
  enabled: boolean
  apiBaseUrl: string
  defaultRefAudioPath: string
  defaultPromptText: string
  promptLang: string
  textLang: string
  speedFactor: number
  gptWeightsPath: string
  sovitsWeightsPath: string
  characters: Array<{
    characterName: string
    refAudioPath: string
    promptText: string
    promptLang: string
    gptWeightsPath: string
    sovitsWeightsPath: string
  }>
}

/** 宿主统一下发的 BGM 配置（config.yaml 的 bgm 节） */
export interface ApiExportBgmConfig {
  enabled: boolean
  path: string
  volume: number
}

/**
 * 纯 API 渲染工作进程：
 * 页面由 Node 宿主（无头浏览器）加载，仅提供 api:start-export → runApiExport 的导出能力，
 * 不再包含桌面 UI、故事选择与预览播放逻辑。
 */
export class App {
  public readonly logger: Logger<ILogObj> = getSubLogger('App')
  public pixiApplication!: Application
  public storyManager!: StoryManager
  public snippetStrategyManager!: SnippetStrategyManager
  private applicationWrapper!: HTMLDivElement | null
  public videoExportManager!: VideoExportManager

  public layerBackground!: BackgroundLayer
  public layerModel!: ModelLayer
  public layerUI!: UILayer
  public layerSpecialEffect!: SpecialEffectLayer
  public ttsManager: TTSManager = new TTSManager()

  private models: Live2DModelMap[] = []
  private textures: TextureMap[] = []

  public exporting: boolean = false
  public lastSnippetActualDurationMs: number = 0
  private apiExportInProgress: boolean = false
  /** 当前导出任务 ID（宿主下发的 taskId，segmented fast 编排用） */
  private currentExportTaskId: string | null = null
  /** segmented fast 编排状态：上报计划后挂起，段结果就绪后继续混音拼接 */
  private segmentedFastState: {
    taskId: string
    outputPath: string
    videoConfig: {
      width: number
      height: number
      renderScale: number
      fps: number
      codec: string
      crf: number
      audioBitrate: string
      watermark?: boolean
    }
    audioTracks: Array<{
      audioBuffer: ArrayBuffer
      startTime: number
      endTime: number
      characterName: string
      text: string
      snippetIndex?: number
    }>
    totalDurationMs: number
    resolve: (() => void) | null
    frameCount: number
    outputSize?: number
  } | null = null

  public async initializeManagers(storyData: StoryData): Promise<void> {
    this.storyManager = new StoryManager(storyData)
    this.logger.info('StoryManager initialized (builtin resources)')

    this.snippetStrategyManager = new SnippetStrategyManager(this)
    this.logger.info('SnippetStrategyManager initialized')
  }

  public initializeRenderer(scale: number, forExport = false): void {
    this.applicationWrapper = document.getElementById('app') as HTMLDivElement | null

    if (!this.applicationWrapper) {
      const wrapper = document.createElement('div')
      wrapper.id = 'app'
      wrapper.style.width = '1280px'
      wrapper.style.height = '720px'
      if (document.body) {
        document.body.appendChild(wrapper)
      } else {
        document.addEventListener('DOMContentLoaded', () => {
          document.body.appendChild(wrapper)
        })
      }
      this.applicationWrapper = wrapper
    }

    if (this.pixiApplication) {
      try {
        Ticker.shared.stop()
        this.pixiApplication.destroy(true, { children: true, texture: true })
      } catch (e) {
        this.logger.warn('Failed to destroy previous pixiApplication', e)
      }
    }

    const resolution = scale

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PixiJS v7 的 ApplicationOptions 未导出 resizeTo 宽泛类型
      const appOptions: any = {
        backgroundColor: 0xffffff,
        autoDensity: true,
        antialias: true,
        resolution,
        preserveDrawingBuffer: forExport
      }

      if (forExport) {
        appOptions.width = 1280
        appOptions.height = 720
      } else {
        appOptions.resizeTo = this.applicationWrapper
      }

      this.pixiApplication = new Application(appOptions)
      this.logger.info(`PixiJS renderer: ${this.pixiApplication.renderer.type}`)
    } catch (e) {
      this.logger.error('PixiJS Application creation failed:', e)
      throw e
    }

    Ticker.shared.maxFPS = forExport ? 120 : 60
    Ticker.shared.start()

    if (this.applicationWrapper) {
      this.applicationWrapper.appendChild(this.pixiApplication.view as HTMLCanvasElement)
    } else {
      this.logger.warn('applicationWrapper is null, skipping canvas append')
    }

    this.pixiApplication.stage.sortableChildren = true

    configureCubism4({
      memorySizeMB: forExport ? 256 : 128
    })

    this.logger.info(
      `Render initialized: resolution=${resolution}, forExport=${forExport}, canvas=${(this.pixiApplication.view as HTMLCanvasElement).width}x${(this.pixiApplication.view as HTMLCanvasElement).height}`
    )
  }

  get stage_size(): [number, number] {
    return [this.pixiApplication.screen.width, this.pixiApplication.screen.height]
  }

  public async preloadStoryAssets(): Promise<void> {
    this.models = await this.storyManager.preloadModels()
    this.logger.info(`Loaded ${this.models.length} models`)

    this.textures = await this.storyManager.preloadImages()
    this.logger.info(`Loaded ${this.textures.length} textures`)

    await new FontFaceObserver('FOT Rodin NTLG Pro', {}).load()
    this.logger.info(`Loaded fonts.`)

    this.logger.info('Preloaded story assets')
  }

  public initializeLayers(): void {
    this.layerBackground = new BackgroundLayer(this.pixiApplication)
    this.layerModel = new ModelLayer(this.pixiApplication)
    this.layerUI = new UILayer(this.pixiApplication)
    this.layerSpecialEffect = new SpecialEffectLayer(this.pixiApplication)
  }

  public getTextureById(id: number): Texture {
    const entry = this.textures.find((image) => image.id === id)
    if (!entry) throw new Error(`Texture with id ${id} not found`)
    return entry.image
  }

  public get isExporting(): boolean {
    return this.exporting
  }

  public getModelById(id: number): AdvancedModel {
    const entry = this.models.find((model) => model.id === id)
    if (!entry) throw new Error(`Model with id ${id} not found`)
    return entry.model
  }

  public getVoiceByName(name: string): string {
    return this.storyManager.geVoiceUrlByName(name)
  }

  private setupApiExportListener(): void {
    window.electron.ipcRenderer.on(
      'api:start-export',
      async (        _event,
        payload: {
          taskId: string
          story: StoryData
          outputPath: string
          videoConfig: {
            width: number
            height: number
            renderScale: number
            fps: number
            codec: string
            crf: number
            audioBitrate: string
            watermark?: boolean
            exportMode?: 'record' | 'fast'
            exportBitrate?: number
            exportFastEncoder?: 'auto' | 'webcodecs' | 'frames'
            fastSegments?: number
          }
          tts?: ApiExportTtsConfig
          bgm?: ApiExportBgmConfig
        }
      ) => {
        if (this.apiExportInProgress) {
          this.logger.warn(`API export already in progress, rejecting task: ${payload.taskId}`)
          window.electron.ipcRenderer.send('api:export-result', {
            taskId: payload.taskId,
            success: false,
            error: 'Another API export is already in progress'
          })
          return
        }

        this.apiExportInProgress = true
        this.currentExportTaskId = payload.taskId
        this.logger.info(`API export started: taskId=${payload.taskId}`)

        try {
          const result = await this.runApiExport(
            payload.story,
            payload.outputPath,
            payload.videoConfig,
            payload.tts,
            payload.bgm
          )
          this.logger.info(
            `API export result: success=${result.success}, videoPath=${result.videoPath}`
          )
          window.electron.ipcRenderer.send('api:export-result', {
            taskId: payload.taskId,
            success: result.success,
            videoPath: result.videoPath,
            duration: result.duration,
            frameCount: result.frameCount,
            outputSize: result.outputSize,
            timings: result.timings,
            error: result.error
          })
          this.logger.info(`api:export-result sent for taskId=${payload.taskId}`)
        } catch (error) {
          this.logger.error('API export failed', error)
          window.electron.ipcRenderer.send('api:export-result', {
            taskId: payload.taskId,
            success: false,
            error: error instanceof Error ? error.message : String(error)
          })
        } finally {
          this.apiExportInProgress = false
        }
      }
    )

    // 宿主取消（HTTP 超时等）：中止正在进行的导出，让 worker 尽快回收。
    // 否则取消只影响 HTTP 等待，渲染仍会跑完并写盘，持续占用 worker。
    window.electron.ipcRenderer.on('api:abort-export', () => {
      this.logger.info('Abort requested by host, aborting in-flight export')
      this.videoExportManager?.abort()
    })

    // ---- parallel 模式：worker 页接收段渲染任务 ----
    window.electron.ipcRenderer.on('api:render-segment', async (_event, payload) => {
      const seg = payload as {
        taskId: string
        segmentIndex: number
        fromSnippet: number
        toSnippet: number
        startTimeMs: number
        timeline: Array<{
          snippetIndex: number
          snippetType: string
          startTimeMs: number
          durationMs: number
          endTimeMs: number
          ttsDurationMs: number
          hasTTS: boolean
        }>
        outputPath: string
        videoConfig: {
          width: number
          height: number
          renderScale: number
          fps: number
          codec: string
          crf: number
          audioBitrate: string
          watermark?: boolean
          exportFastEncoder?: 'auto' | 'webcodecs' | 'frames'
          exportBitrate?: number
        }
        story?: StoryData
      }

      this.logger.info(
        `Segment task received: ${seg.taskId} (seg ${seg.segmentIndex}, ` +
          `snippets [${seg.fromSnippet},${seg.toSnippet}))`
      )
      try {
        // 编排页自己渲段 0 时场景已就绪，不要重复初始化（会重建 storyManager/丢状态）；
        // 只有被宿主派段的空闲 worker 页才需要完整初始化。
        const alreadyInitialized = !!this.pixiApplication && !!this.layerUI
        if (seg.story && !alreadyInitialized) {
          await this.initializeManagers(seg.story)
        }
        if (!this.pixiApplication) {
          this.initializeRenderer(seg.videoConfig.renderScale, true)
          await new Promise<void>((resolve) => setTimeout(resolve, 100))
        }
        if (!this.layerUI) {
          await this.preloadStoryAssets()
          this.initializeLayers()
          ;(this.layerUI as UILayer).setWatermarkVisible(seg.videoConfig.watermark !== false)
          await new Promise<void>((resolve) => setTimeout(resolve, 100))
        }
        if (alreadyInitialized) {
          this.logger.info('Segment task: reusing in-page scene (orchestrator self-render)')
        }

        this.videoExportManager = new VideoExportManager(this)
        const segmentResult = await this.videoExportManager.exportSegment({
          index: seg.segmentIndex,
          fromSnippet: seg.fromSnippet,
          toSnippet: seg.toSnippet,
          startTimeMs: seg.startTimeMs,
          timeline: seg.timeline,
          outputPath: seg.outputPath,
          videoConfig: seg.videoConfig
        })

        window.electron.ipcRenderer.send('api:segment-result', {
          taskId: seg.taskId,
          success: true,
          segmentIndex: seg.segmentIndex,
          videoPath: segmentResult.videoPath,
          actualStartMs: segmentResult.actualStartMs,
          talkPlacements: segmentResult.talkPlacements,
          frameCount: segmentResult.frameCount
        })
      } catch (error) {
        this.logger.error(`Segment ${seg.segmentIndex} failed`, error)
        window.electron.ipcRenderer.send('api:segment-result', {
          taskId: seg.taskId,
          success: false,
          segmentIndex: seg.segmentIndex,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    })

    // ---- parallel 模式：编排页接收「所有段就绪」 ----
    window.electron.ipcRenderer.on('api:parallel-segments-done', (_event, payload) => {
      this.logger.info('Segmented fast: segments done notification received')
      this.resolveParallelPlan(payload as {
        taskId: string
        segments: Array<{
          index: number
          videoPath: string
          actualStartMs: number
          talkPlacements: Array<{
            snippetIndex: number
            startMs: number
            endMs: number
            speaker?: string
            content?: string
            ttsDurationMs?: number
          }>
          frameCount: number
        }>
        totalDurationMs: number
      }).catch((err) => this.logger.error('Parallel plan stage failed', err))
    })

    this.logger.info('API export listener registered')
  }

  public async runApiExport(
    storyData: StoryData,
    outputPath: string,
    videoConfig: {
      width: number
      height: number
      renderScale: number
      fps: number
      codec: string
      crf: number
      audioBitrate: string
      watermark?: boolean
      exportMode?: 'record' | 'fast'
      exportBitrate?: number
      exportFastEncoder?: 'auto' | 'webcodecs' | 'frames'
      fastSegments?: number
    },
    ttsConfig?: ApiExportTtsConfig,
    bgmConfig?: ApiExportBgmConfig
  ): Promise<{
    success: boolean
    videoPath?: string
    duration?: number
    frameCount?: number
    outputSize?: number
    timings?: Record<string, number>
    error?: string
  }> {
    const startTime = performance.now()
    this.logger.info(
      `API export: ${videoConfig.width}x${videoConfig.height}, ${videoConfig.fps}fps, scale=${videoConfig.renderScale}`
    )

    this.applyApiExportConfig(ttsConfig, bgmConfig)

    AnimationManager.exportSpeedMultiplier = 1

    await this.initializeManagers(storyData)
    this.initializeRenderer(videoConfig.renderScale, true)
    await new Promise<void>((resolve) => setTimeout(resolve, 100))

    await this.preloadStoryAssets()
    this.initializeLayers()
    this.layerUI.setWatermarkVisible(videoConfig.watermark !== false)
    await new Promise<void>((resolve) => setTimeout(resolve, 100))

    this.videoExportManager = new VideoExportManager(this)

    const exportOptions: VideoExportOptions = {
      fps: videoConfig.fps,
      width: videoConfig.width,
      height: videoConfig.height,
      quality: 'high',
      format: 'mp4',
      codec: 'h264',
      crf: videoConfig.crf,
      useGpu: true,
      gpuRenderer: 'auto',
      exportMode: videoConfig.exportMode === 'fast' ? 'fast' : 'stream',
      exportBitrate: videoConfig.exportBitrate,
      exportFastEncoder: videoConfig.exportFastEncoder,
      jpegQuality: 0.85,
      batchSize: 30,
      apiMode: true,
      apiOutputPath: outputPath,
      apiCrf: videoConfig.crf,
      apiAudioBitrate: videoConfig.audioBitrate
    }

    try {
      // fast 模式：可行时按段落拆分并行渲染（分段是 fast 的内部加速，不是第三种导出模式）。
      // 分段链路任何一步失败都回退到单段 fast——慢一点也要出片，绝不半路失败。
      if (exportOptions.exportMode === 'fast' && (videoConfig.fastSegments ?? 2) > 1) {
        try {
          return await this.runSegmentedFastExport(storyData, outputPath, videoConfig, startTime)
        } catch (segError) {
          this.logger.warn(
            `Segmented fast export failed (${segError instanceof Error ? segError.message : segError}), ` +
              `falling back to single-segment fast`
          )
          this.segmentedFastState = null
          this.ttsManager?.clearAudioTracks()
          this.videoExportManager = new VideoExportManager(this)
        }
      }

      const result = await this.videoExportManager.exportVideo(
        exportOptions,
        (progress: ExportProgress) => {
          this.logger.info(
            `API Export progress: ${progress.stage} - ${progress.current}/${progress.total} - ${progress.message}`
          )
        }
      )

      this.logger.info('API video rendering completed, starting compression...')

      return {
        success: true,
        videoPath: outputPath,
        duration: (performance.now() - startTime) / 1000,
        frameCount: result.frameCount,
        outputSize: result.outputSize,
        timings: result.timings
      }
    } catch (error) {
      this.logger.error('API export failed during rendering', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    } finally {
      this.videoExportManager.destroy()
      AnimationManager.setExportMode(false)
      AnimationManager.exportSpeedMultiplier = 1
      this.exporting = false
      this.lastSnippetActualDurationMs = 0
      this.ttsManager?.clearAudioTracks()
      Ticker.shared.stop()
      this.logger.info('Ticker stopped after API export completed to reduce GPU idle usage')
    }
  }

  /**
   * parallel 导出编排（编排页职责）：
   * 1. 预合成全部 TTS（并发 3），得到定稿时间轴
   * 2. 按 BlackIn 切点分段
   * 3. 计划上报宿主 → 宿主派各段到空闲 worker 并行渲染
   * 4. 收齐各段画面 + 台词落点 → 混音 → 宿主 concat 无损拼接
   *
   * 任何一步失败都会向上抛错，由调用方回退到 fast/record，绝不在半路产出坏片。
   */
  private async runSegmentedFastExport(
    storyData: StoryData,
    outputPath: string,
    videoConfig: {
      width: number
      height: number
      renderScale: number
      fps: number
      codec: string
      crf: number
      audioBitrate: string
      watermark?: boolean
      exportMode?: 'record' | 'fast'
      exportBitrate?: number
      exportFastEncoder?: 'auto' | 'webcodecs' | 'frames'
      fastSegments?: number
    },
    startTime: number
  ): Promise<{
    success: boolean
    videoPath?: string
    duration?: number
    frameCount?: number
    outputSize?: number
    timings?: Record<string, number>
    error?: string
  }> {
    const planStart = performance.now()

    // ---- 1. 预合成 TTS + 定稿时间轴 ----
    const ttsEnabled = this.ttsManager?.isTTSEnabled() ?? false
    const snippets = this.storyManager.snippets
    let timeline = this.ttsManager.buildTimelineWithoutTTS(snippets)

    if (ttsEnabled) {
      this.logger.info('Segmented fast: pre-synthesizing all TTS...')
      const available = await this.ttsManager!.checkTTSAvailability()
      if (!available) {
        this.logger.warn('Segmented fast: TTS service unavailable, continuing without TTS')
      } else {
        // preSynthesizeAll 返回的 timeline 已并入 TTS（内部用 tts+300 判定），
        // 但导出时间轴必须与 fast 路径的补丁规则完全一致（tts + 600 尾垫），
        // 因此以它的 TTS 时长为输入、在本地时间轴上重新打补丁。
        const ttsDurations = new Map<number, number>()
        const before = await this.ttsManager.preSynthesizeAll(snippets, (c, t, m) => {
          this.logger.info(`[TTS PreSynth] ${c}/${t}: ${m}`)
        })
        for (const entry of before) {
          if (entry.snippetType === 'Talk' && entry.ttsDurationMs > 0) {
            ttsDurations.set(entry.snippetIndex, entry.ttsDurationMs)
          }
        }
        for (let i = 0; i < snippets.length; i++) {
          if (snippets[i].type !== 'Talk') continue
          const dur = ttsDurations.get(i) ?? 0
          applyTalkPatch(timeline, i, dur)
        }
        this.ttsManager.setTimeline(timeline)
        this.logger.info(
          `Segmented fast: timeline fixed, total=${timeline[timeline.length - 1]?.endTimeMs ?? 0}ms, ` +
            `ttsLines=${ttsDurations.size}`
        )
      }
    }

    // ---- 2. 分段 ----
    const maxSegments = Math.max(1, Math.min(videoConfig.fastSegments ?? 2, 4))
    const segments = this.videoExportManager.planSegmentsFor(snippets, timeline, maxSegments)
    this.logger.info(
      `Segmented fast: planned ${segments.length} segment(s): ` +
        segments.map((s) => `[${s.fromSnippet},${s.toSnippet})@${s.startTimeMs}ms`).join(' ')
    )

    // ---- 3. 上报计划，宿主派段并行渲染；本页挂起等待段结果通知 ----
    const taskId = this.currentExportTaskId ?? ''
    const plan = {
      taskId,
      segments: segments.map((s) => ({
        index: s.index,
        fromSnippet: s.fromSnippet,
        toSnippet: s.toSnippet,
        startTimeMs: s.startTimeMs
      })),
      timeline: timeline.map((e) => ({
        snippetIndex: e.snippetIndex,
        snippetType: e.snippetType,
        startTimeMs: e.startTimeMs,
        durationMs: e.durationMs,
        endTimeMs: e.endTimeMs,
        ttsDurationMs: e.ttsDurationMs,
        hasTTS: e.hasTTS
      })),
      totalDurationMs: timeline.length > 0 ? timeline[timeline.length - 1].endTimeMs : 0
    }
    this.segmentedFastState = {
      taskId,
      outputPath,
      videoConfig,
      audioTracks: this.ttsManager.getAudioTracks(),
      totalDurationMs: plan.totalDurationMs,
      resolve: null,
      frameCount: 0
    }

    await window.electron.ipcRenderer.invoke('electron:parallel-plan', {
      ...plan,
      outputPath,
      story: storyData,
      videoConfig,
      // 编排页自己的 workerId（?worker=wN），宿主据此把段结果发回来
      workerId: new URLSearchParams(window.location.search).get('worker')
    })

    // 等待宿主通过 WS 回传「所有段就绪」（由 api:parallel-segments-done 触发 resolve）
    await new Promise<void>((resolve, reject) => {
      const state = this.segmentedFastState
      if (!state) {
        reject(new Error('Parallel plan state lost'))
        return
      }
      state.resolve = resolve
      // 段级失败由宿主直接 reject 整个任务，这里只等待
    })

    this.logger.info('Segmented fast: all segments assembled')
    return {
      success: true,
      videoPath: outputPath,
      duration: (performance.now() - startTime) / 1000,
      frameCount: this.segmentedFastState?.frameCount ?? 0,
      outputSize: this.segmentedFastState?.outputSize,
      timings: {
        planMs: Math.round(performance.now() - planStart),
        segments: segments.length,
        frames: this.segmentedFastState?.frameCount ?? 0
      }
    }
  }

  /** 段结果就绪通知到达：混音 + 宿主 concat 拼接（parallel 编排第二阶段） */
  private async resolveParallelPlan(payload: {
    taskId: string
    segments: Array<{
      index: number
      videoPath: string
      actualStartMs: number
      talkPlacements: Array<{
        snippetIndex: number
        startMs: number
        endMs: number
        speaker?: string
        content?: string
        ttsDurationMs?: number
      }>
      frameCount: number
    }>
    totalDurationMs: number
  }): Promise<void> {
    const state = this.segmentedFastState
    if (!state || state.taskId !== payload.taskId) {
      this.logger.warn(`Segmented fast: segments-done for unknown task ${payload.taskId}`)
      return
    }

    // ---- 4. 混音：各段实测台词落点 + 本页预合成的 TTS 缓冲 ----
    const audioMuxer = new AudioMuxer()
    await audioMuxer.initialize()

    const bgmConfig = this.ttsManager.getBGMConfig()
    let bgmBuffer: AudioBuffer | null = null
    if (bgmConfig?.enabled) {
      audioMuxer.setBGMConfig(bgmConfig)
      try {
        bgmBuffer = await audioMuxer.loadBGMBuffer(resolveBgmUrl(bgmConfig.path))
      } catch (error) {
        this.logger.warn(`Segmented fast: failed to load BGM: ${error}`)
      }
    }

    // 音频长度必须按「实际渲染出的视频总长」算：段画面帧数是唯一可信的
    // 长度来源（时间轴估算会因为 Talk 尾垫/渲染节奏偏差而偏短，
    // 偏短就会被 ffmpeg 的 -shortest 把最后一段整段截掉）。
    const videoDurationMs =
      (payload.segments.reduce((sum, seg) => sum + seg.frameCount, 0) * 1000) /
      Math.min(state.videoConfig.fps, 30)
    const totalDurationMs = Math.max(payload.totalDurationMs, videoDurationMs) + 500
    const placements: Array<{
      audioBuffer: ArrayBuffer
      startTime: number
      endTime: number
      characterName: string
      text: string
    }> = []
    for (const seg of payload.segments) {
      for (const talk of seg.talkPlacements) {
        const track = state.audioTracks.find((t) => t.snippetIndex === talk.snippetIndex)
        if (!track) continue
        const absStart = seg.actualStartMs + talk.startMs
        placements.push({
          audioBuffer: track.audioBuffer,
          startTime: absStart,
          endTime: absStart + (track.endTime - track.startTime),
          characterName: talk.speaker ?? track.characterName,
          text: talk.content ?? track.text
        })
      }
    }
    for (const placement of placements) {
      audioMuxer.addAudioTrack(placement)
    }
    this.logger.info(
      `Segmented fast: mixing ${placements.length} audio placements over ${totalDurationMs}ms`
    )

    const mixedBuffer = await audioMuxer.mixAudioTracks(totalDurationMs, bgmBuffer || undefined)
    const wavBuffer = await audioMuxer.audioBufferToWav(mixedBuffer)
    const audioPath = (await window.electron.ipcRenderer.invoke('electron:write-temp-file', {
      data: wavBuffer,
      prefix: 'mss-audio',
      extension: 'wav'
    })) as string
    audioMuxer.dispose()

    // ---- 5. 宿主 concat 无损拼接 + 合流音频 ----
    const saveResult = (await window.electron.ipcRenderer.invoke('electron:parallel-finalize', {
      taskId: payload.taskId,
      segmentPaths: payload.segments.map((s) => s.videoPath),
      audioPath,
      outputPath: state.outputPath,
      audioBitrate: state.videoConfig.audioBitrate,
      fps: Math.min(state.videoConfig.fps, 30)
    })) as { success: boolean; error?: string; fileSize?: number }

    if (!saveResult.success) {
      throw new Error(saveResult.error || 'Parallel finalize failed on host')
    }

    state.frameCount = payload.segments.reduce((sum, s) => sum + s.frameCount, 0)
    state.outputSize = saveResult.fileSize
    this.logger.info(
      `Segmented fast: final video ${state.outputPath}, frames=${state.frameCount}, ` +
        `size=${((saveResult.fileSize ?? 0) / 1024 / 1024).toFixed(2)} MB`
    )
    state.resolve?.()
  }

  /**
   * 应用宿主下发的 TTS/BGM 配置（config.yaml 的 tts/bgm 节随任务 payload 传入）。
   * 翻译固定关闭——翻译由 AstrBot 插件侧的 LLM 完成。
   */
  private applyApiExportConfig(
    ttsConfig?: ApiExportTtsConfig,
    bgmConfig?: ApiExportBgmConfig
  ): void {
    if (ttsConfig) {
      this.ttsManager.updateConfig({
        enabled: ttsConfig.enabled,
        apiBaseUrl: ttsConfig.apiBaseUrl || 'http://127.0.0.1:9880',
        defaultRefAudioPath: ttsConfig.defaultRefAudioPath || '',
        defaultPromptText: ttsConfig.defaultPromptText || '',
        promptLang: ttsConfig.promptLang || 'ja',
        speedFactor: ttsConfig.speedFactor || 1.0,
        textLang: ttsConfig.textLang || 'ja',
        gptWeightsPath: ttsConfig.gptWeightsPath || '',
        sovitsWeightsPath: ttsConfig.sovitsWeightsPath || ''
      })
      for (const char of ttsConfig.characters || []) {
        if (char.characterName && char.refAudioPath) {
          this.ttsManager.setCharacterVoice(char.characterName, {
            characterName: char.characterName,
            refAudioPath: char.refAudioPath,
            promptText: char.promptText || ttsConfig.defaultPromptText || '',
            promptLang: char.promptLang || ttsConfig.promptLang || 'ja',
            gptWeightsPath: char.gptWeightsPath || undefined,
            sovitsWeightsPath: char.sovitsWeightsPath || undefined
          })
        }
      }
      this.logger.info(
        `API export: TTS config applied from host (enabled=${ttsConfig.enabled}, characters=${ttsConfig.characters?.length ?? 0})`
      )
    }

    this.ttsManager.updateBGMConfig({
      enabled: bgmConfig?.enabled ?? true,
      path: bgmConfig?.path ?? 'audio/bgm/bg1.mp3',
      volume: bgmConfig?.volume ?? 0.2
    })

    this.ttsManager.updateTranslationConfig({
      enabled: false
    })
  }

  public async run(): Promise<void> {
    this.setupApiExportListener()
    this.logger.info('Render worker ready (pure API mode)')
  }
}

async function main(): Promise<void> {
  const app = new App()
  await app.run()
}

export default main
