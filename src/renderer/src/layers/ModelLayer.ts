import BaseLayer from './BaseLayer'
import { Application, ColorMatrixFilter } from 'pixi.js'
import { LayoutModes } from '../../../common/types/Story'
import AdvancedModel from '../model/AdvancedModel'

export default class ModelLayer extends BaseLayer {
  public layoutMode: LayoutModes = LayoutModes.Normal
  private ambientFilter: ColorMatrixFilter | null = null

  constructor(app: Application) {
    super(app, 1)
  }

  /**
   * 人物层环境色（PJSK AmbientColor*）。
   * normal 移除滤镜；evening 压暗并降低饱和度；night 更冷更暗。
   */
  public setAmbientColor(mode: 'normal' | 'evening' | 'night'): void {
    if (mode === 'normal') {
      this.layerContainer.filters = null
      this.ambientFilter = null
      return
    }

    const filter = new ColorMatrixFilter()
    if (mode === 'evening') {
      filter.matrix = [0.9, 0, 0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0.8, 0, 0, 0, 0, 0, 1, 0]
      filter.saturate(-0.1, true)
    } else {
      filter.matrix = [0.7, 0, 0, 0, 0, 0, 0.75, 0, 0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 1, 0]
      filter.saturate(-0.25, true)
    }
    this.ambientFilter = filter
    this.layerContainer.filters = [filter]
  }

  public addModelToLayer(model: AdvancedModel): void {
    if (this.layerContainer.children.includes(model)) return

    const scale = this.app.screen.height / model.internalModel.originalHeight
    model.scale.set(
      scale *
        (this.layoutMode === LayoutModes.Normal
          ? model.metadata.normal_scale
          : model.metadata.small_scale)
    )

    this.layerContainer.addChild(model)
  }

  public removeModel(model: AdvancedModel): void {
    if (this.layerContainer.children.includes(model)) {
      this.layerContainer.removeChild(model)
    }
  }

  /** Read-only membership/opacity query for timed character cues. */
  public isModelVisible(modelId: number): boolean {
    const model = this.layerContainer.children.find((child) => {
      const candidate = child as AdvancedModel
      return candidate.metadata?.id === modelId
    }) as AdvancedModel | undefined
    if (!model || !model.visible) return false
    const alpha = (model.filters?.[0] as { alpha?: number } | undefined)?.alpha
    return alpha === undefined || alpha > 0.01
  }
}
