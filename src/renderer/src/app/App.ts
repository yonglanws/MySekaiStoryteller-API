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
