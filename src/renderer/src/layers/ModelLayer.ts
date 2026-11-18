import { Application, ColorMatrixFilter, Container, Filter, Ticker } from 'pixi.js'
import { Cubism2InternalModel } from 'pixi-live2d-display-advanced'
import { LayoutModes, ModelData } from '../../../common/types/Story'
import { MODEL_COLOR_EVENING, MODEL_COLOR_NIGHT } from '../../../common/official/timing'
import { evaluateEase } from '../effects/Ease'
import { loadInappTexture } from '../effects/InappTextures'
import { Live2DBlurFilter, Live2DHologramShaderFilter } from '../effects/OfficialFilters'
import AnimationManager from '../managers/AnimationManager'
import AdvancedModel from '../model/AdvancedModel'
import StageUtils from '../utils/StageUtils'
import { resourceUrl } from '../utils/ResourceUrl'
import BaseLayer from './BaseLayer'

interface CharacterShaderEntry {
  kind: 'hologram' | 'monitor' | 'blur'
  filter: Filter
  tickerFn?: (delta: number) => void
}

export default class ModelLayer extends BaseLayer {
  public layoutMode: LayoutModes = LayoutModes.Normal
  private ambientFilter: ColorMatrixFilter | null = null
  private ambientMode: 'normal' | 'evening' | 'night' = 'normal'
  private ambientGen = 0
  /** 官方显示状态（ScenarioCharacterView 的 Appear/Hide），与 alpha 无关。 */
  private readonly shownModels = new Set<number>()
  /** 官方 `LockCharacterDepth`: Front / Back 锁定角色 ID。 */
  private lockedFrontModelId: number | null = null
  private lockedBackModelId: number | null = null
  /** 官方动作完成时间戳（ms，与 Talk 的 motionsSettled Gate 对齐）。 */
  private readonly motionSettledAt = new Map<number, number>()
  private readonly characterShaders = new Map<number, CharacterShaderEntry>()
  private onModelReplacedCb: ((modelId: number, model: AdvancedModel) => void) | null = null

  constructor(app: Application) {
    super(app, 0)
  }

  public getContainer(): Container {
    return this.layerContainer
  }

  public setOnModelReplaced(cb: ((modelId: number, model: AdvancedModel) => void) | null): void {
    this.onModelReplacedCb = cb
  }

  /** 官方 `AmbientColor`：直接对 Live2D 顶层施加 RGB 线性倍乘，无额外去饱和失真。 */
  public setAmbientColor(mode: 'normal' | 'evening' | 'night'): void {
    this.ambientGen++
    this.ambientMode = mode
    if (mode === 'normal') {
      this.layerContainer.filters = null
      return
    }
    const [r, g, b] = mode === 'evening' ? MODEL_COLOR_EVENING : MODEL_COLOR_NIGHT
    const filter = this.ambientFilter ?? new ColorMatrixFilter()
    const res = this.app?.renderer?.resolution
    if (typeof res === 'number' && res > 0) {
      filter.resolution = res
    }
    if (this.app?.screen) {
      this.layerContainer.filterArea = this.app.screen
    }
    filter.matrix = [r, 0, 0, 0, 0, 0, g, 0, 0, 0, 0, 0, b, 0, 0, 0, 0, 0, 1, 0]
    this.ambientFilter = filter
    this.layerContainer.filters = [filter]
  }

  public resetAmbientColor(): void {
    if (this.ambientMode !== 'normal' || this.ambientFilter !== null) {
      this.setAmbientColor('normal')
    }
  }

  private applyModelScale(model: AdvancedModel): void {
    const originalHeight = Math.max(1, model.internalModel?.originalHeight ?? 1024)
    const baseScale = this.app.screen.height / originalHeight
    const modeFactor = StageUtils.modeScale(this.layoutMode)
    const charScale = model.metadata?.normal_scale ?? 2.1
    model.scale.set(baseScale * charScale * modeFactor)
  }

  public updateLayoutMode(mode: 'Normal' | 'Three' | LayoutModes): void {
    this.layoutMode =
      mode === LayoutModes.Three || String(mode) === 'Three' ? LayoutModes.Three : LayoutModes.Normal
    for (const child of this.layerContainer.children) {
      const model = child as AdvancedModel
      if (model.internalModel && !model.destroyed) {
        this.applyModelScale(model)
      }
    }
  }

  public addModelToLayer(model: AdvancedModel): void {
    if (this.layerContainer.children.includes(model)) return
    this.applyModelScale(model)
    this.layerContainer.addChild(model)
  }

  public getModelById(modelId: number): AdvancedModel | undefined {
    return this.layerContainer.children.find((child) => {
      const candidate = child as AdvancedModel
      return candidate.metadata?.id === modelId
    }) as AdvancedModel | undefined
  }

  /** 返回当前处于显示状态的所有模型（用于 `900000` 齐声唇型同步）。 */
  public getVisibleModels(): AdvancedModel[] {
    return this.layerContainer.children.filter((child) => {
      const candidate = child as AdvancedModel
      if (!candidate.metadata || !candidate.visible || candidate.destroyed) return false
      const alpha = (candidate.filters?.[0] as { alpha?: number } | undefined)?.alpha
      return this.shownModels.has(candidate.metadata.id) && (alpha === undefined || alpha > 0.01)
    }) as AdvancedModel[]
  }

  public getUnisonSpeakerModels(): AdvancedModel[] {
    return this.getVisibleModels()
  }

  public removeModel(model: AdvancedModel): void {
    const id = model.metadata?.id
    if (id !== undefined) {
      this.shownModels.delete(id)
      this.motionSettledAt.delete(id)
      if (this.lockedFrontModelId === id) this.lockedFrontModelId = null
      if (this.lockedBackModelId === id) this.lockedBackModelId = null
      this.clearShaderEntry(id)
    }
    if (this.layerContainer.children.includes(model)) {
      this.layerContainer.removeChild(model)
    }
  }

  /** 官方 `SetCharacterDepth(id, Front | Back)` 与 `LockCharacterDepth`（与 `sse-bake:2229-2271` 对齐）。 */
  private setDepth(modelId: number, front: boolean): void {
    const target = this.getModelById(modelId)
    if (!target) return
    const n = this.layerContainer.children.length
    if (n <= 1) return

    let index: number
    if (this.lockedBackModelId === modelId) {
      index = 0
    } else if (this.lockedFrontModelId === modelId) {
      index = n - 1
    } else if (!front && this.lockedBackModelId === null) {
      index = 0
    } else if (front && this.lockedFrontModelId === null) {
      index = n - 1
    } else {
      index = Math.max(0, n - 2)
    }
    this.layerContainer.setChildIndex(target, Math.min(index, n - 1))
  }

  public bringToFront(modelId: number): void {
    this.setDepth(modelId, true)
  }

  public setLayoutDepth(modelId: number, depth: 'Front' | 'Back' | 'Reset'): void {
    if (depth === 'Reset') {
      if (this.lockedBackModelId === modelId) this.lockedBackModelId = null
      if (this.lockedFrontModelId === modelId) this.lockedFrontModelId = null
      return
    }
    const front = depth === 'Front'
    this.setDepth(modelId, front)
    if (this.lockedBackModelId === modelId || this.lockedFrontModelId === modelId) return
    if (front && this.lockedFrontModelId === null) {
      this.lockedFrontModelId = modelId
    } else if (!front && this.lockedBackModelId === null) {
      this.lockedBackModelId = modelId
    }
  }

  /** 官方 `CharacterLayout Type 4/5`: 角色水平/垂直 0.3s 抖动。 */
  public async shakeCharacter(modelId: number, axis: 'X' | 'Y'): Promise<void> {
    const model = this.getModelById(modelId)
    if (!model) return
    await model.shake(axis, this.app.screen.width)
  }

  private clearShaderEntry(modelId: number): void {
    const prev = this.characterShaders.get(modelId)
    if (!prev) return
    if (prev.tickerFn) {
      Ticker.shared.remove(prev.tickerFn)
    }
    this.characterShaders.delete(modelId)
    const model = this.getModelById(modelId)
    if (model && !model.destroyed && model.getCharacterShaderFilter() === prev.filter) {
      model.setCharacterShaderFilter(null)
    } else {
      prev.filter.destroy()
    }
  }

  /** 官方 `EffectType 22 AttachCharacterShader`: 全息扫描线 / 监视器 / 角色模糊 / 清除。 */
  public setCharacterShader(
    modelId: number,
    shader: 'hologram' | 'monitor' | 'blur' | 'none',
    level = 1.5
  ): void {
    const model = this.getModelById(modelId)
    if (!model || model.destroyed) {
      this.clearShaderEntry(modelId)
      return
    }

    if (shader === 'none') {
      this.clearShaderEntry(modelId)
      model.setCharacterShaderFilter(null)
      model.visualEffectManager?.disable('hologram')
      return
    }

    const existing = this.characterShaders.get(modelId)
    if (shader === 'blur') {
      if (
        existing?.kind === 'blur' &&
        existing.filter instanceof Live2DBlurFilter &&
        model.getCharacterShaderFilter() === existing.filter
      ) {
        existing.filter.level = level
        return
      }
      this.clearShaderEntry(modelId)
      const blurFilter = new Live2DBlurFilter(level)
      this.characterShaders.set(modelId, { kind: 'blur', filter: blurFilter })
      model.setCharacterShaderFilter(blurFilter)
      return
    }

    this.clearShaderEntry(modelId)

    const isMonitor = shader === 'monitor'
    const holoFilter = new Live2DHologramShaderFilter({
      monitor: isMonitor,
      seed: ((modelId + 1) * 2654435761) >>> 0
    })
    const tickerFn = (): void => {
      if (model.destroyed) {
        this.clearShaderEntry(modelId)
        return
      }
      holoFilter.step(Math.max(0, Ticker.shared.elapsedMS) / 1000)
    }
    Ticker.shared.add(tickerFn)
    this.characterShaders.set(modelId, { kind: shader, filter: holoFilter, tickerFn })
    model.setCharacterShaderFilter(holoFilter)

    void loadInappTexture('player/loose/Texture2D/holo.png').then((tex) => {
      if (
        !model.destroyed &&
        tex &&
        tex.valid &&
        tex.baseTexture?.valid &&
        this.characterShaders.get(modelId)?.filter === holoFilter
      ) {
        holoFilter.setHoloTexture(tex)
      }
    })
  }

  /** 官方 `CheckAndChangeCostume`: 换装后重建视图并在未出场前保持隐藏。 */
  public async changeCostume(modelId: number, costume: string): Promise<void> {
    const current = this.getModelById(modelId)
    if (!current || current.currentCostume === costume) return

    const metadata = current.metadata
    const resolvedCostumePath = metadata.costumes?.[costume] ?? costume
    if (!resolvedCostumePath) return

    const fullPath =
      /^https?:\/\//i.test(resolvedCostumePath) || resolvedCostumePath.startsWith('/')
        ? resolvedCostumePath
        : resourceUrl(`models/${resolvedCostumePath}`)

    const nextModel = await AdvancedModel.from(fullPath, {
      ticker: Ticker.shared,
      autoFocus: false,
      autoHitTest: false,
      breathDepth: 0
    })
    if (nextModel.internalModel instanceof Cubism2InternalModel) {
      nextModel.internalModel.setAutoBlinkEnable(false)
    }
    const nextMeta: ModelData = { ...metadata, model: resolvedCostumePath }
    nextModel.initialize(nextMeta)
    nextModel.currentCostume = costume
    nextModel.position.copyFrom(current.position)
    nextModel.setOpacity(0)
    nextModel.visible = false
    this.shownModels.delete(modelId)

    const oldIndex = this.layerContainer.children.indexOf(current)
    const activeShader = this.characterShaders.get(modelId)
    this.clearShaderEntry(modelId)
    this.layerContainer.removeChild(current)
    current.destroy()

    this.applyModelScale(nextModel)
    if (oldIndex >= 0 && oldIndex <= this.layerContainer.children.length) {
      this.layerContainer.addChildAt(nextModel, oldIndex)
    } else {
      this.layerContainer.addChild(nextModel)
    }

    if (activeShader) {
      this.setCharacterShader(modelId, activeShader.kind)
    }
    this.onModelReplacedCb?.(modelId, nextModel)
  }

  public markMotionSettledAt(modelId: number, endMs: number): void {
    const prev = this.motionSettledAt.get(modelId) ?? 0
    if (endMs > prev) {
      this.motionSettledAt.set(modelId, endMs)
    }
  }

  public areMotionsSettled(nowMs: number): boolean {
    for (const [modelId, endMs] of this.motionSettledAt.entries()) {
      if (!this.shownModels.has(modelId)) continue
      if (nowMs < endMs - 0.5) return false
    }
    return true
  }

  public markModelShown(modelId: number): boolean {
    const wasShown = this.shownModels.has(modelId)
    this.shownModels.add(modelId)
    return wasShown
  }

  public markModelHidden(modelId: number): boolean {
    const wasShown = this.shownModels.has(modelId)
    this.shownModels.delete(modelId)
    return wasShown
  }

  public isModelShown(modelId: number): boolean {
    return this.shownModels.has(modelId)
  }

  public isModelVisible(modelId: number): boolean {
    const model = this.getModelById(modelId)
    if (!model || !model.visible) return false
    const alpha = (model.filters?.[0] as { alpha?: number } | undefined)?.alpha
    return alpha === undefined || alpha > 0.01
  }

  public clearAllShaders(): void {
    for (const id of [...this.characterShaders.keys()]) {
      this.setCharacterShader(id, 'none')
    }
    this.motionSettledAt.clear()
  }

  public async tweenAmbientColor(mode: 'normal' | 'evening' | 'night', durationMs = 0): Promise<void> {
    if (durationMs <= 0) {
      this.setAmbientColor(mode)
      return
    }
    const gen = ++this.ambientGen
    const [r, g, b] =
      mode === 'normal' ? [1, 1, 1] : mode === 'evening' ? MODEL_COLOR_EVENING : MODEL_COLOR_NIGHT
    const prev = this.ambientFilter?.matrix ?? [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0]
    const fr = prev[0]
    const fg = prev[6]
    const fb = prev[12]
    const filter = this.ambientFilter ?? new ColorMatrixFilter()
    const res = this.app?.renderer?.resolution
    if (typeof res === 'number' && res > 0) {
      filter.resolution = res
    }
    if (this.app?.screen) {
      this.layerContainer.filterArea = this.app.screen
    }
    this.ambientFilter = filter
    this.layerContainer.filters = [filter]
    await AnimationManager.linear((raw) => {
      if (gen !== this.ambientGen) return
      const p = evaluateEase('Linear', raw)
      const cr = fr + (r - fr) * p
      const cg = fg + (g - fg) * p
      const cb = fb + (b - fb) * p
      filter.matrix = [cr, 0, 0, 0, 0, 0, cg, 0, 0, 0, 0, 0, cb, 0, 0, 0, 0, 0, 1, 0]
    }, durationMs)
    if (gen !== this.ambientGen) return
    this.setAmbientColor(mode)
  }

  public destroy(): void {
    this.clearAllShaders()
    this.layerContainer.filters = null
    if (this.ambientFilter) {
      this.ambientFilter.destroy()
      this.ambientFilter = null
    }
  }
}
