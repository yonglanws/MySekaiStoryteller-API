import BaseLayer from './BaseLayer'
import { Application, ColorMatrixFilter } from 'pixi.js'
import { LayoutModes } from '../../../common/types/Story'
import AdvancedModel from '../model/AdvancedModel'

export default class ModelLayer extends BaseLayer {
  public layoutMode: LayoutModes = LayoutModes.Normal
  private ambientFilter: ColorMatrixFilter | null = null
  /**
   * 官方显示状态（ScenarioCharacterView 的 Appear/Hide），与 alpha 无关。
   * HideCharacter 在协程开始时就把它置为 false；ProgressBehavior=0 时协程还在
   * 后台淡出，但这之后的 Appear 必须按“新入场”处理（7 帧淡入），而不是
   * 按 alpha 判断成“已在场”走 0.2s 移动分支。
   */
  private shownModels = new Set<number>()

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
    this.shownModels.delete(model.metadata?.id)
    if (this.layerContainer.children.includes(model)) {
      this.layerContainer.removeChild(model)
    }
  }

  /** 官方 Appear 的显示状态：返回此前是否已出场。 */
  public markModelShown(modelId: number): boolean {
    const wasShown = this.shownModels.has(modelId)
    this.shownModels.add(modelId)
    return wasShown
  }

  /** 官方 HideCharacter 的显示状态：返回此前是否已出场。 */
  public markModelHidden(modelId: number): boolean {
    const wasShown = this.shownModels.has(modelId)
    this.shownModels.delete(modelId)
    return wasShown
  }

  public isModelShown(modelId: number): boolean {
    return this.shownModels.has(modelId)
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
