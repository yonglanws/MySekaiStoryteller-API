import { AlphaFilter, Sprite, Texture } from 'pixi.js'
import AnimationManager from '../managers/AnimationManager'

const OPAQUE_ALPHA_THRESHOLD = 0.999

export default class FadableSprite extends Sprite {
  private readonly alphaFilter: AlphaFilter
  private animGen = 0

  protected constructor(texture: Texture) {
    super(texture)

    this.alphaFilter = new AlphaFilter(0)
    // 保留在 filters[0]，兼容 SpecialEffectLayer 对 SEBlack.filters[0] 的直接读写；
    // 通过 show()/hide() 驱动的 UI 背景在稳态（alpha<=0 或 >=0.999）时清空 filters。
    this.filters = [this.alphaFilter]
  }

  private getCurrentOpacity(): number {
    if (!this.visible) return 0
    if (this.filters?.includes(this.alphaFilter)) {
      return Math.max(0, Math.min(1, this.alphaFilter.alpha))
    }
    return 1
  }

  private syncOpacity(alpha: number): void {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 0))
    this.alphaFilter.alpha = clamped
    if (clamped <= 0) {
      this.visible = false
      this.filters = null
    } else if (clamped >= OPAQUE_ALPHA_THRESHOLD) {
      this.visible = true
      this.filters = null
    } else {
      this.visible = true
      if (this.filters?.[0] !== this.alphaFilter) {
        this.filters = [this.alphaFilter]
      }
    }
  }

  public async show(time: number): Promise<void> {
    const gen = ++this.animGen
    if (time <= 0) {
      this.syncOpacity(1)
      return
    }
    const startAlpha = this.getCurrentOpacity()
    if (startAlpha < OPAQUE_ALPHA_THRESHOLD) {
      this.alphaFilter.alpha = startAlpha
      this.visible = true
      if (this.filters?.[0] !== this.alphaFilter) {
        this.filters = [this.alphaFilter]
      }
    } else {
      this.syncOpacity(1)
    }

    await AnimationManager.linear((progress) => {
      if (gen !== this.animGen) return
      this.syncOpacity(startAlpha + (1 - startAlpha) * progress)
    }, time)

    if (gen === this.animGen) {
      this.syncOpacity(1)
    }
  }

  public async hide(time: number): Promise<void> {
    const gen = ++this.animGen
    if (time <= 0) {
      await AnimationManager.linear((progress) => {
        if (gen !== this.animGen) return
        if (progress >= 1) this.syncOpacity(0)
      }, 0)
      if (gen === this.animGen) {
        this.syncOpacity(0)
      }
      return
    }

    const startAlpha = this.getCurrentOpacity()
    if (startAlpha <= 0) {
      this.syncOpacity(0)
      return
    }

    await AnimationManager.linear((progress) => {
      if (gen !== this.animGen) return
      this.syncOpacity(startAlpha * (1 - progress))
    }, time)

    if (gen === this.animGen) {
      this.syncOpacity(0)
    }
  }
}
