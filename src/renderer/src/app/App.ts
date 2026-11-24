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
import { Application, Container, Texture, Ticker, type Filter } from 'pixi.js'
import SpecialEffectLayer from '../layers/SpecialEffectLayer'
import EnvironmentLayer from '../layers/EnvironmentLayer'
import { runEasedTween } from '../effects/Ease'
import { preloadCommonInappTextures, resetInappTextureCache } from '../effects/InappTextures'
import { createMulberry32, DollyZoomFilter } from '../effects/OfficialFilters'
import { configureCubism4 } from 'pixi-live2d-display-advanced'
import VideoExportManager, {
  VideoExportOptions,
  ExportProgress
} from '../managers/VideoExportManager'
import AnimationManager from '../managers/AnimationManager'
import { TTSManager } from '../managers/TTSManager'
import type { LipSyncEnvelope } from '../utils/LipSyncEnvelope'
import { framesForSeconds } from '../../../common/official/timing'
import {
  SHAKE_RANDOMNESS,
  SHAKE_VIBRATO,
  buildShakePlan,
  shakeOffsetAt
} from '../../../common/official/screenShake'
import { nextPostEffectOwner, type PostEffectOwner } from '../effects/PostEffectSlot'
import { recordEffectProbe } from '../utils/EffectProbe'

/** 宿主统一下发的 TTS 配置（config.yaml 的 tts 节） */
export interface ApiExportTtsConfig {
  enabled: boolean
  provider: 'gpt-sovits' | 'irodori'
  apiBaseUrl: string
  timeoutMs: number
  defaultRefAudioPath: string
  defaultPromptText: string
  promptLang: string
  textLang: string
  speedFactor: number
  gptWeightsPath: string
  sovitsWeightsPath: string
  irodori: {
    model: string
    responseFormat: 'wav' | 'mp3' | 'ogg'
    numSteps: number
    cfgScaleText: number
    cfgScaleCaption: number
    cfgScaleSpeaker: number
    durationScale: number
    chunkingEnabled: boolean
    chunkMinChars: number
    seed: number
    defaultLoraAdapter: string
    defaultCaption: string
  }
  characters: Array<{
    characterName: string
    refAudioPath: string
    refAudioPaths?: string[]
    promptText: string
    promptLang: string
    gptWeightsPath: string
    sovitsWeightsPath: string
    loraAdapter?: string
    caption?: string
    speed?: number
    numSteps?: number
    emotions?: Array<{
      emotion: string
      refAudioPath?: string
      refAudioPaths?: string[]
      loraAdapter?: string
      caption?: string
      speed?: number
      numSteps?: number
    }>
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
  public layerEnvironment!: EnvironmentLayer
  public ttsManager: TTSManager = new TTSManager()

  /** 相机状态（PJSK ChangeCameraPosition / ChangeCameraZoomLevel / DollyZoom） */
  private cameraScale = 1
  private cameraOffsetX = 0
  private cameraOffsetY = 0
  private cameraMoveGen = 0
  private cameraMoveTarget: { x: number; y: number } | null = null
  private cameraZoomGen = 0
  private cameraZoomTarget: number | null = null
  private dollyZoomGen = 0
  /** 震屏附加偏移，不改变相机基准值 */
  private shakeOffsetX = 0
  private shakeOffsetY = 0
  private shakeGeneration = 0
  private scenarioContainer!: Container
  private readonly dollyZoomFilter = new DollyZoomFilter(0, 0)
  private envFilters: Filter[] = []
  private cameraBlurFilter: Filter | null = null
  /** 官方单个 PostEffectType 槽：color / blur 互斥，blur 活动时每帧胜出。 */
  private postEffectOwner: PostEffectOwner = 'none'

  private models: Live2DModelMap[] = []
  private textures: TextureMap[] = []

  public exporting: boolean = false
  public lastSnippetActualDurationMs: number = 0
  public currentTalkLipSync: LipSyncEnvelope | null = null
  public currentTalkStartedAtMs: number = 0
  private apiExportInProgress: boolean = false
  /**
   * 宿主取消闩锁：abort 可能在资产预热阶段到达（此时新的 VideoExportManager
   * 尚未创建），先按 taskId 记住，manager 创建后立即应用，避免取消被吞掉。
   */
  private pendingAbortTaskId: string | null = null

  public async initializeManagers(storyData: StoryData): Promise<void> {
    this.storyManager = new StoryManager(storyData)
    this.logger.info('StoryManager initialized (builtin resources)')

    this.snippetStrategyManager = new SnippetStrategyManager(this)
    this.logger.info('SnippetStrategyManager initialized')
  }

  /**
   * @param scale renderScale：导出时是「输出宽度相对 1280 的倍率」。
   *   1 = 按输出分辨率 1:1 渲染；1.5 = 超采样（抗锯齿更好、更贵）；
   *   <1 = 降渲染分辨率提速（画面变软）。
   * @param forExport 导出模式
   * @param outputWidth 输出视频宽度（决定后备存储倍率）
   * @param outputHeight 输出视频高度
   */
  public initializeRenderer(
    scale: number,
    forExport = false,
    outputWidth = 1280,
    outputHeight = 720
  ): void {
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
        this.disposeLayers()
        resetInappTextureCache()
        // Do NOT destroy shared base/global textures (Texture.WHITE / imported SVGs) across worker reuse
        this.pixiApplication.destroy(true, {
          children: true,
          texture: false,
          baseTexture: false
        })
      } catch (e) {
        this.logger.warn('Failed to destroy previous pixiApplication', e)
      }
    }

    // 逻辑坐标空间固定 1280×720（所有布局代码依赖 stage_size，改这里会破坏构图），
    // 用 resolution 控制后备存储：renderScale 1.0 + 1920 宽输出 → 后备 1920×1080。
    const logicalWidth = 1280
    const logicalHeight = 720
    if (forExport && outputWidth / outputHeight !== logicalWidth / logicalHeight) {
      // 布局按 16:9 设计，非 16:9 输出只能靠 ffmpeg 侧 pad 补齐
      this.logger.warn(
        `Output aspect ${outputWidth}x${outputHeight} is not 16:9; ` +
          `scene will be letterboxed by the host encoder`
      )
    }
    const resolution = forExport ? scale * (outputWidth / logicalWidth) : scale

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PixiJS v7 的 ApplicationOptions 未导出 resizeTo 宽泛类型
      const appOptions: any = {
        backgroundColor: forExport ? 0x000000 : 0xffffff,
        autoDensity: true,
        antialias: true,
        resolution,
        preserveDrawingBuffer: forExport
      }

      if (forExport) {
        appOptions.width = logicalWidth
        appOptions.height = logicalHeight
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

    await new FontFaceObserver('MiSans Medium', {}).load()
    this.logger.info(`Loaded fonts.`)
    preloadCommonInappTextures()

    this.logger.info('Preloaded story assets')
  }

  private disposeLayers(): void {
    this.layerBackground?.destroy?.()
    this.layerModel?.destroy?.()
    this.layerEnvironment?.destroy?.()
    this.layerSpecialEffect?.destroy?.()
  }

  private syncScenarioFilters(): void {
    if (!this.scenarioContainer) return
    const list: Filter[] = []
    if (this.postEffectOwner === 'color') list.push(...this.envFilters)
    if (this.postEffectOwner === 'blur' && this.cameraBlurFilter) {
      list.push(this.cameraBlurFilter)
    }
    if (
      Math.abs(this.dollyZoomFilter.distortion) > 0.0001 ||
      this.dollyZoomFilter.samplingDistance > 0.001
    ) {
      list.push(this.dollyZoomFilter)
    }
    this.scenarioContainer.filters = list.length > 0 ? list : null
  }

  private resetSceneState(): void {
    this.cameraMoveGen++
    this.cameraZoomGen++
    this.dollyZoomGen++
    this.shakeGeneration++
    this.cameraScale = 1
    this.cameraOffsetX = 0
    this.cameraOffsetY = 0
    this.cameraMoveTarget = null
    this.cameraZoomTarget = null
    this.shakeOffsetX = 0
    this.shakeOffsetY = 0
    this.envFilters = []
    this.cameraBlurFilter = null
    this.postEffectOwner = 'none'
    this.dollyZoomFilter.distortion = 0
    this.dollyZoomFilter.samplingDistance = 0
    this.syncScenarioFilters()
  }

  public initializeLayers(): void {
    this.resetSceneState()
    this.scenarioContainer = new Container()
    this.scenarioContainer.zIndex = 0
    this.scenarioContainer.sortableChildren = true
    this.scenarioContainer.filterArea = this.pixiApplication.screen
    this.pixiApplication.stage.addChild(this.scenarioContainer)

    this.layerBackground = new BackgroundLayer(this.pixiApplication)
    this.layerModel = new ModelLayer(this.pixiApplication)
    this.layerEnvironment = new EnvironmentLayer(this.pixiApplication)
    this.layerUI = new UILayer(this.pixiApplication)
    this.layerSpecialEffect = new SpecialEffectLayer(this.pixiApplication)

    this.scenarioContainer.addChild(
      this.layerBackground.getContainer(),
      this.layerModel.getContainer()
    )

    this.layerEnvironment.setFilterSyncCallback((filters) => {
      this.envFilters = filters
      this.postEffectOwner = nextPostEffectOwner(
        this.postEffectOwner,
        filters.length > 0 ? 'color-filters' : 'no-color-filters',
        this.cameraBlurFilter !== null
      )
      this.syncScenarioFilters()
    })
    this.layerSpecialEffect.setCameraBlurCallback((filter) => {
      this.cameraBlurFilter = filter
      this.postEffectOwner = nextPostEffectOwner(
        this.postEffectOwner,
        filter ? 'blur-filter' : 'no-blur-filter',
        filter !== null
      )
      this.syncScenarioFilters()
    })
    this.layerModel.setOnModelReplaced((modelId, model) => {
      const entry = this.models.find((m) => m.id === modelId)
      if (entry) entry.model = model
    })
  }

  private applyViewTransform(): void {
    // 与 sekai-viewer-reborn 的 set_style 一致：
    // root.position = stage * (0.5 - posX / scale, 0.5 + posY / scale)
    const [width, height] = this.stage_size
    const offsetX = -(this.cameraOffsetX / this.cameraScale) * width + this.shakeOffsetX
    const offsetY = (this.cameraOffsetY / this.cameraScale) * height + this.shakeOffsetY
    this.layerBackground.setViewTransform(this.cameraScale, offsetX, offsetY)
    this.layerModel.setViewTransform(this.cameraScale, offsetX, offsetY)
  }

  /** 相机平移：x/y 使用游戏 1920×1080 舞台像素，默认 DOTween OutQuad 缓动。 */
  public async cameraMove(
    x: number,
    y: number,
    durationMs: number,
    ease = 'OutQuad'
  ): Promise<void> {
    const gen = ++this.cameraMoveGen
    const toX = x / 1920
    const toY = y / 1080
    // `Kill(complete)`：上一条 tween 被中断时直接取它的目标值作为新起点。
    const fromX = this.cameraMoveTarget?.x ?? this.cameraOffsetX
    const fromY = this.cameraMoveTarget?.y ?? this.cameraOffsetY
    this.cameraMoveTarget = { x: toX, y: toY }
    await runEasedTween(
      durationMs,
      ease,
      (p) => {
        if (gen !== this.cameraMoveGen) return
        this.cameraOffsetX = fromX + (toX - fromX) * p
        this.cameraOffsetY = fromY + (toY - fromY) * p
        this.applyViewTransform()
      },
      () => gen !== this.cameraMoveGen
    )
  }

  /** 相机缩放：scale 为绝对倍率，1 = 初始视角，默认 DOTween OutQuad 缓动。 */
  public async cameraZoom(scale: number, durationMs: number, ease = 'OutQuad'): Promise<void> {
    const gen = ++this.cameraZoomGen
    // `Kill(complete)`：从上一条 zoom tween 的目标值继续。
    const from = this.cameraZoomTarget ?? this.cameraScale
    const to = Math.max(0.1, scale)
    this.cameraZoomTarget = to
    await runEasedTween(
      durationMs,
      ease,
      (p) => {
        if (gen !== this.cameraZoomGen) return
        this.cameraScale = from + (to - from) * p
        this.applyViewTransform()
      },
      () => gen !== this.cameraZoomGen
    )
  }

  /** 官方 `EffectType 45 DollyZoom`: 同步缩放场景 + 桶形畸变与边缘径向模糊。 */
  public async dollyZoom(
    zoom: number,
    durationMs: number,
    ease = 'OutQuad',
    dist?: number,
    blur?: number
  ): Promise<void> {
    const gen = ++this.dollyZoomGen
    const fromScale = this.cameraScale
    const toScale = Math.max(0.1, zoom)
    const fromDist = this.dollyZoomFilter.samplingDistance
    // 官方 `CalcDistortionStrength`：distortion = dist × −(zoom − 1)；未给 dist 时为 0。
    const toDistortion = dist === undefined ? 0 : dist * -(toScale - 1)
    const toSampling = Math.max(0, blur ?? 0) * (this.stage_size[0] / 1920)
    const fromDistortion = this.dollyZoomFilter.distortion

    await runEasedTween(
      durationMs,
      ease,
      (p) => {
        if (gen !== this.dollyZoomGen) return
        this.cameraScale = fromScale + (toScale - fromScale) * p
        this.dollyZoomFilter.distortion = fromDistortion + (toDistortion - fromDistortion) * p
        this.dollyZoomFilter.samplingDistance = fromDist + (toSampling - fromDist) * p
        this.applyViewTransform()
        this.syncScenarioFilters()
      },
      () => gen !== this.dollyZoomGen
    )
    if (gen !== this.dollyZoomGen) return
    if (Math.abs(toScale - 1) < 1e-4) {
      this.dollyZoomFilter.distortion = 0
      this.dollyZoomFilter.samplingDistance = 0
      this.syncScenarioFilters()
    }
  }

  /**
   * 震屏：背景与人物一起抖动，UI 不动（PJSK ShakeScreen）。
   * 对齐 DOTween `DOShakePosition(dur, strength=10, vibrato=16, fadeOut=(dur<3600))` + `SHAKE_BASE_Y = -8`。
   * @param durationSec 秒（>=3600 视为无限持续直至 StopShakeScreen）
   * @param intensity 振幅（参考 1080 像素默认 10；若 <1 按屏高比例兼容旧调用）
   */
  public async shakeScreen(durationSec: number, intensity = 10): Promise<void> {
    const height = this.stage_size[1]
    const scaleY = height / 1080
    const clampedSec = Math.min(3600, Math.max(0, durationSec))
    const durationMs = clampedSec * 1000
    const fadeOut = clampedSec < 3600
    // `DOShakePosition(duration, strength, vibrato=16, randomness=90, fadeOut)`：
    // n = max(2, trunc(16×duration)) 段，段内 OutQuad，段末幅度减 strength/n。
    const generation = ++this.shakeGeneration
    const rng = createMulberry32((generation * 2654435761) >>> 0)
    const amp =
      (intensity > 0 && intensity < 1 ? intensity * height : Math.max(0, intensity)) * scaleY
    const plan = buildShakePlan({
      durationSeconds: clampedSec,
      strength: amp,
      rng,
      vibrato: SHAKE_VIBRATO,
      randomness: SHAKE_RANDOMNESS,
      ignoreZAxis: false,
      fadeOut
    })
    // `fadeOut` 时每段时长 (i+1)/n×duration 再按总和归一（后段更长）。
    // 有限抖动：父节点 y 从 -8 用 OutQuad 升到 0。
    const baseStart = -8 * scaleY
    const startWall = performance.now()
    recordEffectProbe('shake-screen', {
      durationSec: clampedSec,
      fadeOut,
      segments: plan.segments,
      strength: amp,
      baseY: baseStart,
      resolution: this.pixiApplication.renderer?.resolution ?? 1,
      // 8 段（0.5s）时完整落盘，便于逐段反演；无限抖动只报段数。
      ...(plan.segments <= 64 ? { ends: plan.ends, offsets: plan.offsets } : {})
    })

    await AnimationManager.linear(
      (progress) => {
        if (generation !== this.shakeGeneration) return
        const [offsetX, offsetY] = shakeOffsetAt(plan, progress * clampedSec)
        this.shakeOffsetX = offsetX
        this.shakeOffsetY = offsetY
        if (fadeOut) {
          // 父节点基线：从 -8 用 OutQuad 升到 0（与持续时间的进度同步）。
          const eased = -progress * (progress - 2)
          this.shakeOffsetY += baseStart * (1 - eased)
        } else {
          this.shakeOffsetY += baseStart
        }
        this.applyViewTransform()
      },
      Math.max(1, durationMs),
      false,
      { startMs: startWall, frames: framesForSeconds(clampedSec) }
    )

    if (generation === this.shakeGeneration) {
      this.shakeOffsetX = 0
      this.shakeOffsetY = 0
      this.applyViewTransform()
    }
  }

  /** 官方 EffectType 25：StopShakeScreen。 */
  public stopShakeScreen(): void {
    this.shakeGeneration++
    this.shakeOffsetX = 0
    this.shakeOffsetY = 0
    this.applyViewTransform()
  }

  /** 兼容旧调用：同时停止全屏震动与对话框文本震动。 */
  public stopShake(): void {
    this.stopShakeScreen()
    this.layerUI?.stopShakeWindow()
  }

  public async setOpeningCover(durationMs = 500): Promise<void> {
    await this.layerSpecialEffect.setOpeningCover(durationMs)
  }

  public async setEndingEnvelope(holdMs = 250, fadeMs = 250): Promise<void> {
    await this.layerSpecialEffect.setEndingEnvelope(holdMs, fadeMs)
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
      async (
        _event,
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
            watermarkText?: string
            exportMode?: 'record' | 'fast'
            exportBitrate?: number
            exportFastEncoder?: 'auto' | 'webcodecs' | 'frames'
            fastFps?: number
            idleChainGapSec?: number
            ttsMode?: 'serial' | 'concurrent'
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
        this.logger.info(`API export started: taskId=${payload.taskId}`)
        // 快导出结束后主 ticker 会恢复运行；空闲 worker 若继续按 60fps 渲染已加载的 Live2D 场景，
        // 会把 GPU 长期打满（实测空闲 99% SM）。导出前再启动，其余时间停掉。
        try {
          this.pixiApplication.ticker.start()
        } catch {
          /* pixi may not be ready yet; export path starts its own ticker */
        }

        try {
          const result = await this.runApiExport(
            payload.story,
            payload.outputPath,
            payload.videoConfig,
            payload.tts,
            payload.bgm,
            payload.taskId
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
            diagnostics: result.diagnostics,
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
          this.pendingAbortTaskId = null
          // 结果已回传，worker 回到空闲：停止预览渲染，避免空闲页面持续占用 GPU。
          try {
            this.pixiApplication.ticker.stop()
          } catch {
            /* renderer may already be destroyed */
          }
        }
      }
    )

    // 宿主取消（HTTP 超时等）：中止正在进行的导出，让 worker 尽快回收。
    // 否则取消只影响 HTTP 等待，渲染仍会跑完并写盘，持续占用 worker。
    window.electron.ipcRenderer.on('api:abort-export', (_event, taskId: string) => {
      this.logger.info(`Abort requested by host, aborting in-flight export: ${taskId}`)
      // 预热阶段（manager 尚未创建）abort 会丢失：按 taskId 闩锁，稍后应用
      this.pendingAbortTaskId = taskId
      this.videoExportManager?.abort()
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
      watermarkText?: string
      exportMode?: 'record' | 'fast'
      exportBitrate?: number
      exportFastEncoder?: 'auto' | 'webcodecs' | 'frames'
      fastFps?: number
      idleChainGapSec?: number
      ttsMode?: 'serial' | 'concurrent'
    },
    ttsConfig?: ApiExportTtsConfig,
    bgmConfig?: ApiExportBgmConfig,
    taskId?: string
  ): Promise<{
    success: boolean
    videoPath?: string
    duration?: number
    frameCount?: number
    outputSize?: number
    timings?: Record<string, number>
    diagnostics?: import('../managers/video-export/ExportDiagnostics').ExportDiagnostics
    error?: string
  }> {
    this.logger.info(
      `API export: ${videoConfig.width}x${videoConfig.height}, ${videoConfig.fps}fps, scale=${videoConfig.renderScale}`
    )

    this.applyApiExportConfig(ttsConfig, bgmConfig)
    this.ttsManager.beginExportSession()

    AnimationManager.exportSpeedMultiplier = 1
    // 表演续演间隔由宿主配置下发；0 = 关闭续演（动作播完回落默认待机后保持安静）
    AdvancedModel.idleChainGapMs = Math.max(0, (videoConfig.idleChainGapSec ?? 0) * 1000)

    await this.initializeManagers(storyData)
    this.initializeRenderer(videoConfig.renderScale, true, videoConfig.width, videoConfig.height)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    await this.preloadStoryAssets()
    this.initializeLayers()
    this.layerUI.setWatermarkVisible(videoConfig.watermark !== false)
    this.layerUI.setWatermarkText(videoConfig.watermarkText ?? '')
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    this.videoExportManager = new VideoExportManager(this)

    // 预热期间到达的取消：此时旧 manager 已销毁、新 manager 刚创建，
    // resetState 会清除 isAborted，必须在此按 taskId 重新应用
    if (taskId && this.pendingAbortTaskId === taskId) {
      this.logger.info(`Applying pending abort for taskId=${taskId} before export start`)
      this.videoExportManager.abort()
    }

    if (videoConfig.exportMode === 'record') {
      this.logger.warn('video.exportMode="record" is deprecated; delegating to "fast"')
    }

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
      exportMode: 'fast',
      exportBitrate: videoConfig.exportBitrate,
      exportFastEncoder: videoConfig.exportFastEncoder,
      fastFps: videoConfig.fastFps,
      ttsMode: videoConfig.ttsMode ?? 'concurrent',
      jpegQuality: 0.85,
      batchSize: 30,
      apiMode: true,
      apiOutputPath: outputPath,
      apiCrf: videoConfig.crf,
      apiAudioBitrate: videoConfig.audioBitrate
    }

    try {
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
        // 成片时长以帧泵/编码器统计为准，不使用页内墙钟耗时
        duration: result.duration,
        frameCount: result.frameCount,
        outputSize: result.outputSize,
        timings: result.timings,
        diagnostics: result.diagnostics
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
      this.currentTalkLipSync = null
      this.currentTalkStartedAtMs = 0
      this.ttsManager?.clearAudioTracks()
      this.layerModel?.clearAllShaders()
      this.layerSpecialEffect?.reset()
      this.layerUI?.closePlaceInfo()
      this.resetSceneState()
      Ticker.shared.stop()
      this.logger.info('Ticker stopped after API export completed to reduce GPU idle usage')
    }
  }

  private applyApiExportConfig(
    ttsConfig?: ApiExportTtsConfig,
    bgmConfig?: ApiExportBgmConfig
  ): void {
    if (ttsConfig) {
      this.ttsManager.updateConfig({
        enabled: ttsConfig.enabled,
        provider: ttsConfig.provider || 'gpt-sovits',
        apiBaseUrl: ttsConfig.apiBaseUrl || 'http://127.0.0.1:9880',
        timeoutMs: ttsConfig.timeoutMs || 120000,
        // 租约走宿主自己的 HTTP 端口；页面由宿主加载时 origin 就是宿主
        hostApiBaseUrl:
          typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol)
            ? window.location.origin
            : '',
        defaultRefAudioPath: ttsConfig.defaultRefAudioPath || '',
        defaultPromptText: ttsConfig.defaultPromptText || '',
        promptLang: ttsConfig.promptLang || 'ja',
        speedFactor: ttsConfig.speedFactor || 1.0,
        textLang: ttsConfig.textLang || 'ja',
        gptWeightsPath: ttsConfig.gptWeightsPath || '',
        sovitsWeightsPath: ttsConfig.sovitsWeightsPath || '',
        ...(ttsConfig.irodori ? { irodori: ttsConfig.irodori } : {})
      })
      for (const char of ttsConfig.characters || []) {
        const hasRef = Boolean(char.refAudioPath) || (char.refAudioPaths?.length ?? 0) > 0
        if (char.characterName && hasRef) {
          this.ttsManager.setCharacterVoice(char.characterName, {
            characterName: char.characterName,
            refAudioPath: char.refAudioPath || '',
            refAudioPaths: char.refAudioPaths,
            loraAdapter: char.loraAdapter || undefined,
            caption: char.caption || undefined,
            speed: char.speed,
            numSteps: char.numSteps,
            emotions: char.emotions,
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
