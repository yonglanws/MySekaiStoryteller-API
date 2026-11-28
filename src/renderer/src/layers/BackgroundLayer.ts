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

  /** 校验纹理是否可用：拒绝 Texture.EMPTY、已销毁或明确 0×0 无资源的空纹理，兼容测试桩对象。 */
  private isUsableTexture(tex: unknown): tex is Texture {
    if (!tex || typeof tex !== 'object') return false
    if (tex === Texture.EMPTY) return false
    const candidate = tex as {
      valid?: boolean
      destroyed?: boolean
      baseTexture?: {
        valid?: boolean
        destroyed?: boolean
        width?: number
        height?: number
        resource?: unknown
      }
    }
    if (candidate.destroyed === true || candidate.baseTexture?.destroyed === true) return false
    if (
      candidate.baseTexture?.valid === true &&
      typeof candidate.baseTexture.width === 'number' &&
      typeof candidate.baseTexture.height === 'number' &&
      (candidate.baseTexture.width <= 0 || candidate.baseTexture.height <= 0)
    ) {
      return false
    }
    if (candidate.valid === false && !candidate.baseTexture?.resource) return false
    return true
  }

  /** 官方背景固定铺进 2338×1440 的居中矩形，不按图片自身像素 cover。 */
  private applyStageRect(sprite: Sprite): void {
    const rect = backgroundStageRect(this.app.screen.width, this.app.screen.height)
    sprite.position.set(rect.x + rect.width * 0.5, rect.y + rect.height * 0.5)
    const tex = sprite.texture as
      | (Texture & {
          orig?: { width?: number; height?: number }
          baseTexture?: {
            width?: number
            height?: number
            once?: (event: string, fn: () => void) => void
          }
        })
      | undefined
    const texW = tex?.orig?.width ?? tex?.baseTexture?.width ?? tex?.width
    const texH = tex?.orig?.height ?? tex?.baseTexture?.height ?? tex?.height
    if (typeof texW === 'number' && typeof texH === 'number' && (texW <= 0 || texH <= 0)) {
      // 防止对未加载完成的 0×0 纹理写入 width/height 导致 PixiJS 把 scale 锁死成 0（整张背景不可见）
      if (typeof tex?.baseTexture?.once === 'function') {
        const targetTex = tex
        tex.baseTexture.once('loaded', () => {
          if (sprite.texture === targetTex) {
            this.applyStageRect(sprite)
          }
        })
      }
      return
    }
    sprite.width = rect.width
    sprite.height = rect.height
  }

  private async resolveTexture(imageOrUrl: Texture | string): Promise<Texture> {
    if (typeof imageOrUrl !== 'string') return imageOrUrl
    const trimmed = imageOrUrl.trim()
    if (!trimmed) {
      console.warn('[BackgroundLayer] Ignoring empty background URL')
      return Texture.EMPTY
    }
    try {
      const loaded = await Assets.load(trimmed)
      if (this.isUsableTexture(loaded)) return loaded
      console.warn(
        `[BackgroundLayer] Assets.load returned non-usable texture for "${trimmed}", falling back to Texture.from`
      )
    } catch (error) {
      console.warn(
        `[BackgroundLayer] Assets.load failed for "${trimmed}", falling back to Texture.from`,
        error
      )
    }
    try {
      const fallback = Texture.from(trimmed)
      const base = (
        fallback as Texture & {
          baseTexture?: { once?: (event: string, fn: (err?: unknown) => void) => void }
        }
      )?.baseTexture
      if (typeof base?.once === 'function') {
        base.once('error', (err?: unknown) => {
          console.warn(`[BackgroundLayer] Background texture load error for "${trimmed}"`, err)
        })
      }
      return fallback
    } catch (error) {
      console.warn(`[BackgroundLayer] Texture.from failed for "${trimmed}"`, error)
      return Texture.EMPTY
    }
  }

  public setBackground(texture: Texture): void {
    if (!this.isUsableTexture(texture)) {
      console.warn(
        '[BackgroundLayer] Ignoring empty or invalid background texture; preserving current background'
      )
      return
    }
    this.changeGeneration++
    this.fadeSprite.visible = false
    this.fadeSprite.alpha = 0
    this.sprite.texture = texture
    this.applyStageRect(this.sprite)
  }

  /** 官方 `ChangeBackground`：支持平滑线性交叉淡化（durationMs=0 立即同步切换）。 */
  public async changeBackground(imageOrUrl: Texture | string, durationMs = 0): Promise<void> {
    // 预加载纹理即时切换走同步快路径，避免首帧出现 1 tick 微任务空档
    if (typeof imageOrUrl !== 'string') {
      if (!this.isUsableTexture(imageOrUrl)) {
        console.warn(
          '[BackgroundLayer] changeBackground received empty or invalid texture; preserving current background'
        )
        return
      }
      if (durationMs <= 0 || !this.isUsableTexture(this.sprite.texture)) {
        this.setBackground(imageOrUrl)
        return
      }
    }

    const generation = ++this.changeGeneration
    const nextTex =
      typeof imageOrUrl === 'string' ? await this.resolveTexture(imageOrUrl) : imageOrUrl
    if (generation !== this.changeGeneration) return

    if (!this.isUsableTexture(nextTex)) {
      console.warn(
        `[BackgroundLayer] Failed to resolve usable background texture${typeof imageOrUrl === 'string' ? ` for "${imageOrUrl}"` : ''}; preserving current background`
      )
      return
    }

    if (durationMs <= 0 || !this.isUsableTexture(this.sprite.texture)) {
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
