import { Texture } from 'pixi.js'
import { loadInappTexture } from '../effects/InappTextures'
import FadableSprite from './FadableSprite'

function createFallbackTalkWindowTexture(): Texture | null {
  if (typeof document === 'undefined') return null
  const w = 1400
  const h = 312
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const bgGrad = ctx.createLinearGradient(0, 0, 0, h)
  bgGrad.addColorStop(0, 'rgba(0, 0, 34, 0.0)')
  bgGrad.addColorStop(0.08, 'rgba(0, 0, 34, 0.80)')
  bgGrad.addColorStop(0.28, 'rgba(0, 0, 34, 0.88)')
  bgGrad.addColorStop(1, 'rgba(0, 0, 34, 0.92)')
  ctx.fillStyle = bgGrad
  ctx.fillRect(0, 0, w, h)

  // 顶部微光边线（匹配官方 bg_story_adv 顶边质感）
  const lineGrad = ctx.createLinearGradient(0, 0, w, 0)
  lineGrad.addColorStop(0, 'rgba(150, 170, 220, 0.05)')
  lineGrad.addColorStop(0.2, 'rgba(190, 210, 255, 0.45)')
  lineGrad.addColorStop(0.8, 'rgba(190, 210, 255, 0.45)')
  lineGrad.addColorStop(1, 'rgba(150, 170, 220, 0.05)')
  ctx.fillStyle = lineGrad
  ctx.fillRect(0, 14, w, 2)

  return Texture.from(canvas)
}

/**
 * 官方 `TalkWindow/Window`（`[-440, 768, 2800, 312]` @ 1920×1080，色值 `#000022`）：
 * 优先使用缓存的 `inapp/jp-7.0.0/player/loose/Sprite/bg_story_adv.png`，离线自动使用矢量渐变纹理。
 */
export default class UITextBackground extends FadableSprite {
  constructor(fallbackTexture: Texture, screen_width: number, screen_height: number) {
    const k = Math.min(screen_width / 1920, screen_height / 1080)
    const vectorTex = createFallbackTalkWindowTexture()
    super(vectorTex ?? fallbackTexture)

    this.anchor.set(0, 0)
    if (vectorTex) {
      this.x = -440 * k
      this.y = 768 * k
      this.width = 2800 * k
      this.height = 312 * k
    } else {
      this.x = 0
      this.y = 0
      this.width = screen_width
      this.height = screen_height
    }

    void loadInappTexture('player/loose/Sprite/bg_story_adv.png').then((tex) => {
      if (!this.destroyed && tex && tex.valid && tex.baseTexture?.valid) {
        this.texture = tex
        this.tint = 0x000022
        this.x = -440 * k
        this.y = 768 * k
        this.width = 2800 * k
        this.height = 312 * k
      }
    })
  }
}
