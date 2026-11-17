import { Texture } from 'pixi.js'
import { loadInappTexture } from '../effects/InappTextures'
import FadableSprite from './FadableSprite'

function createNameBarGradientTexture(): Texture | null {
  if (typeof document === 'undefined') return null
  const w = 720
  const h = 16
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const grad = ctx.createLinearGradient(0, 0, w, 0)
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.6)')
  grad.addColorStop(0.55, 'rgba(255, 255, 255, 0.28)')
  grad.addColorStop(1, 'rgba(255, 255, 255, 0.0)')

  const r = h / 2
  ctx.beginPath()
  ctx.moveTo(r, 0)
  ctx.lineTo(w, 0)
  ctx.lineTo(w, h)
  ctx.lineTo(r, h)
  ctx.arc(r, r, r, Math.PI / 2, (Math.PI * 3) / 2)
  ctx.closePath()
  ctx.fillStyle = grad
  ctx.fill()
  return Texture.from(canvas)
}

/**
 * 官方 `NameBackground`（`[210, 824, 720, 16]` @ 1920×1080，左端透明度 0.6 → 右端 0 渐变）。
 */
export default class UITextUnderline extends FadableSprite {
  constructor(fallbackTexture: Texture, screen_width: number, screen_height: number) {
    const k = Math.min(screen_width / 1920, screen_height / 1080)
    const gradTex = createNameBarGradientTexture()
    super(gradTex ?? fallbackTexture)

    this.x = 210 * k
    this.y = 824 * k
    this.width = 720 * k
    this.height = 16 * k

    if (gradTex) {
      this.alpha = 1
    } else {
      void loadInappTexture('player/loose/Sprite/bg_base_half_r8_wh.png').then((tex) => {
        if (!this.destroyed && tex && tex.valid && tex.baseTexture?.valid) {
          this.texture = tex
        }
      })
    }
  }
}
