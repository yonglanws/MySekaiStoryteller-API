import { Sprite, Texture } from 'pixi.js'
import type { App } from '../../app/App'

export interface WebGLValidatorLike {
  validateCanvas: (canvas: HTMLCanvasElement) => Promise<{
    success: boolean
    errors: string[]
    contextInfo: { renderer?: string }
  }>
  validateModelRendering: (
    canvas: HTMLCanvasElement,
    timeoutMs?: number
  ) => Promise<{
    success: boolean
    averageBrightness: number
  }>
}

export interface ValidationProbeLogger {
  info: (message: string, data?: unknown) => void
  warn: (message: string, data?: unknown) => void
  error: (message: string, data?: unknown) => void
}

async function requestAnimationFrameOnce(): Promise<void> {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    await new Promise((resolve) => setTimeout(resolve, 0))
    return
  }
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve(undefined))
  })
}

/**
 * 导出前 WebGL 上下文 / 非黑屏渲染探针与 Live2D 模型 GPU 预热协调器。
 * 在常驻 worker 页面上按 App 实例缓存首次通过状态，避免重复 readPixels 校验。
 */
export class WebGLValidationProbe {
  /** 已在同一常驻 worker 页面上通过首次 WebGL/黑屏校验的 App 实例集合 */
  private static readonly warmValidatedApps = new WeakSet<object>()

  constructor(
    private readonly app: App,
    private readonly logger: ValidationProbeLogger,
    private readonly validator: WebGLValidatorLike
  ) {}

  static markWarm(app: object): void {
    WebGLValidationProbe.warmValidatedApps.add(app)
  }

  static invalidate(app: object): void {
    WebGLValidationProbe.warmValidatedApps.delete(app)
  }

  static isWarm(app: object): boolean {
    return WebGLValidationProbe.warmValidatedApps.has(app)
  }

  async validateBeforeExport(
    canvas: HTMLCanvasElement,
    options?: { segmentPrepareOnly?: boolean }
  ): Promise<void> {
    const gl =
      typeof canvas.getContext === 'function'
        ? canvas.getContext('webgl2') || canvas.getContext('webgl')
        : null
    const glLost = Boolean(gl && typeof gl.isContextLost === 'function' && gl.isContextLost())
    const skipWarmValidation =
      options?.segmentPrepareOnly === true || (WebGLValidationProbe.isWarm(this.app) && !glLost)

    if (skipWarmValidation) {
      this.logger.info('Warm worker page: skipping redundant WebGL shader/readPixels validation')
      this.app.pixiApplication.render?.()
      return
    }

    WebGLValidationProbe.invalidate(this.app)
    this.logger.info('Performing pre-export WebGL validation...')

    const validationResult = await this.validator.validateCanvas(canvas)
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

    await this.runWithValidationProbe(canvas, async () => {
      this.app.pixiApplication.render?.()
      const modelValidation = await this.validator.validateModelRendering(canvas, 3000)
      if (!modelValidation.success) {
        throw new Error(
          `Model rendering validation failed: black screen detected ` +
            `(brightness: ${modelValidation.averageBrightness.toFixed(2)}%). ` +
            `Models are not rendering properly. Check WebGL context and model files.`
        )
      }
    })

    WebGLValidationProbe.markWarm(this.app)
    this.logger.info('Pre-export validation passed')
  }

  /**
   * 导出阶段 pixiApplication 背景为 0x000000（避免黑幕下透白闪屏），在故事尚未铺设
   * 背景/角色前直接 render() 会得到全黑画面。这里临时挂载一个中心角色（或无角色时的白色
   * Sprite 探针）验证 WebGL 实际渲染输出，结束后立即恢复并重绘回纯黑。
   */
  async runWithValidationProbe(canvas: HTMLCanvasElement, fn: () => Promise<void>): Promise<void> {
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

  /**
   * 第一次把角色加进舞台会触发纹理上传/着色器编译（约 50~120ms）。在导出开始前
   * 以 alpha=0.01 预画一帧，让 GPU 资源就绪，但不影响成片。
   */
  async prewarmStoryModels(): Promise<void> {
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
    await requestAnimationFrameOnce()
  }
}
