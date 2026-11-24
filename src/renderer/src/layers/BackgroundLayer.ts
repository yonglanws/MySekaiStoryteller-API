import { Application, Assets, Container, Sprite, Texture } from 'pixi.js'
import { UI_GAUSSIAN_BLUR_DEFAULT_DISTANCE, UIGaussianBlurFilter } from '../effects/OfficialFilters'
import AnimationManager from '../managers/AnimationManager'
import { backgroundStageRect } from '../../../common/official/backgroundStage'
import BaseLayer from './BaseLayer'

export default class BackgroundLayer extends BaseLayer {
  private readonly sprite: Sprite
  private readonly fadeSprite: Sprite
  private readonly blurFilter = new UIGaussianBlurFilter(UI_GAUSSIAN_BLUR_DEFAULT_DISTANCE)
  private blurGeneration = 0
  private changeGeneration = 0

  constructor(app: Application) {
    super(app, -1)

    this.sprite = new Sprite()
    this.sprite.anchor.set(0.5)
    this.applyStageRect(this.sprite)

    this.fadeSprite = new Sprite()
    this.fadeSprite.anchor.set(0.5)
    this.applyStageRect(this.fadeSprite)
    this.fadeSprite.visible = false
    this.fadeSprite.alpha = 0

    this.layerContainer.addChild(this.sprite, this.fadeSprite)
  }

  public getContainer(): Container {
    return this.layerContainer
  }

  public setBlur(enabled: boolean): void {
    void this.setBackgroundBlur(enabled, 1, 0)
  }

  /** 官方 `EffectType 44 BackgroundBlur`：7-tap 十字高斯模糊（samplingDistance = 2.8）。 */
  public async setBackgroundBlur(active: boolean, level = 1, durationMs = 0): Promise<void> {
    const generation = ++this.blurGeneration
    const refScale = this.app.screen.width / 1920
    const targetDistance = active
      ? UI_GAUSSIAN_BLUR_DEFAULT_DISTANCE * Math.max(0.25, level) * refScale
      : 0
    const startDistance =
      this.layerContainer.filters && this.layerContainer.filters.includes(this.blurFilter)
        ? this.blurFilter.samplingDistance
        : 0

    if (
      active &&
      (!this.layerContainer.filters || !this.layerContainer.filters.includes(this.blurFilter))
    ) {
      this.layerContainer.filters = [this.blurFilter]
    }

    if (durationMs > 0) {
      await AnimationManager.linear((progress) => {
        if (generation !== this.blurGeneration) return
        this.blurFilter.samplingDistance =
          startDistance + (targetDistance - startDistance) * progress
      }, durationMs)
    }

    if (generation !== this.blurGeneration) return
    this.blurFilter.samplingDistance = targetDistance
    if (!active) {
      this.layerContainer.filters = null
    }
  }

  /** 官方背景固定铺进 2338×1440 的居中矩形，不按图片自身像素 cover。 */
  private applyStageRect(sprite: Sprite): void {
    const rect = backgroundStageRect(this.app.screen.width, this.app.screen.height)
    sprite.width = rect.width
    sprite.height = rect.height
    sprite.position.set(rect.x + rect.width * 0.5, rect.y + rect.height * 0.5)
  }

  private async resolveTexture(imageOrUrl: Texture | string): Promise<Texture> {
    if (imageOrUrl instanceof Texture) return imageOrUrl
    try {
      const loaded = await Assets.load(imageOrUrl)
      if (loaded instanceof Texture) return loaded
    } catch {
      // fall through to Texture.from
    }
    return Texture.from(imageOrUrl)
  }

  public setBackground(texture: Texture): void {
    this.changeGeneration++
    this.fadeSprite.visible = false
    this.fadeSprite.alpha = 0
    this.sprite.texture = texture
    this.applyStageRect(this.sprite)
  }

  /** 官方 `ChangeBackground`：支持平滑线性交叉淡化（durationMs=0 立即切换）。 */
  public async changeBackground(imageOrUrl: Texture | string, durationMs = 0): Promise<void> {
    const generation = ++this.changeGeneration
    const nextTex = await this.resolveTexture(imageOrUrl)
    if (generation !== this.changeGeneration) return

    if (durationMs <= 0 || !this.sprite.texture || this.sprite.texture === Texture.EMPTY) {
      this.setBackground(nextTex)
      return
    }

    this.fadeSprite.texture = nextTex
    this.applyStageRect(this.fadeSprite)
    this.fadeSprite.alpha = 0
    this.fadeSprite.visible = true

    await AnimationManager.linear((progress) => {
      if (generation !== this.changeGeneration) return
      this.fadeSprite.alpha = progress
    }, durationMs)

    if (generation !== this.changeGeneration) return
    this.sprite.texture = nextTex
    this.applyStageRect(this.sprite)
    this.fadeSprite.visible = false
    this.fadeSprite.alpha = 0
  }

  public destroy(): void {
    this.blurGeneration++
    this.changeGeneration++
    this.layerContainer.filters = null
    this.blurFilter.destroy()
  }
}
