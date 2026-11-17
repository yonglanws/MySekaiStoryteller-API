import { Application, Container, type Filter } from 'pixi.js'
import { FlashbackFilter, SepiaFilter } from '../effects/OfficialFilters'
import AnimationManager from '../managers/AnimationManager'
import BaseLayer from './BaseLayer'

/**
 * 环境/屏幕空间色彩后处理层（PJSK FlashbackIn/Out & SepiaIn/Out）。
 * 按 SSE `shaders.wgsl` 对背景 + 人物场景层施加真实单色/褐调着色器，而非半透明黑块遮罩。
 */
export default class EnvironmentLayer extends BaseLayer {
  private readonly flashbackFilter = new FlashbackFilter(0)
  private readonly sepiaFilter = new SepiaFilter(0)
  private flashbackActive = false
  private sepiaActive = false
  private flashbackGen = 0
  private sepiaGen = 0
  private filterSyncCallback: ((filters: Filter[]) => void) | null = null

  constructor(app: Application) {
    super(app, 1)
    this.layerContainer.visible = false
  }

  public getContainer(): Container {
    return this.layerContainer
  }

  public setFilterSyncCallback(cb: ((filters: Filter[]) => void) | null): void {
    this.filterSyncCallback = cb
    this.notifyFiltersChanged()
  }

  public getActiveFilters(): Filter[] {
    const out: Filter[] = []
    if (this.flashbackActive || this.flashbackFilter.intensity > 0.001) {
      out.push(this.flashbackFilter)
    }
    if (this.sepiaActive || this.sepiaFilter.intensity > 0.001) {
      out.push(this.sepiaFilter)
    }
    return out
  }

  private notifyFiltersChanged(): void {
    this.filterSyncCallback?.(this.getActiveFilters())
  }

  public async setFlashback(active: boolean, durationMs = 100): Promise<void> {
    const generation = ++this.flashbackGen
    this.flashbackActive = active
    const from = this.flashbackFilter.intensity
    const to = active ? 1 : 0
    this.notifyFiltersChanged()

    if (durationMs > 0) {
      await AnimationManager.linear((progress) => {
        if (generation !== this.flashbackGen) return
        this.flashbackFilter.intensity = from + (to - from) * progress
      }, durationMs)
    }
    if (generation !== this.flashbackGen) return
    this.flashbackFilter.intensity = to
    this.notifyFiltersChanged()
  }

  public async setSepia(active: boolean, durationMs = 100): Promise<void> {
    const generation = ++this.sepiaGen
    this.sepiaActive = active
    const from = this.sepiaFilter.intensity
    const to = active ? 1 : 0
    this.notifyFiltersChanged()

    if (durationMs > 0) {
      await AnimationManager.linear((progress) => {
        if (generation !== this.sepiaGen) return
        this.sepiaFilter.intensity = from + (to - from) * progress
      }, durationMs)
    }
    if (generation !== this.sepiaGen) return
    this.sepiaFilter.intensity = to
    this.notifyFiltersChanged()
  }

  /** 向后兼容旧 API：`alpha` 不用于遮罩黑块，仅激活官方单色闪回着色器。 */
  public async flashbackIn(duration = 100, _alpha = 0.3): Promise<void> {
    await this.setFlashback(true, duration)
  }

  public async flashbackOut(duration = 100): Promise<void> {
    await this.setFlashback(false, duration)
  }
}
