import { Texture } from 'pixi.js'
import { SSE_UI_SPEC } from '../utils/FontLoader'
import FadableSprite from './FadableSprite'

const NAME_BAR = SSE_UI_SPEC.nameBar

/**
 * 同步生成与 `SekaiStoryExporter` (`native_ui.rs::name_bar`) 一致的姓名底条纹理：
 * `720×16`，左端 8px 半圆帽，透明度沿 X 线性从 `0.6` 衰减至 `0.0`。
 */
function createOfficialNameBarTexture(): Texture | null {
  if (typeof document === 'undefined') return null
  const w = NAME_BAR.width
  const h = NAME_BAR.height
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const grad = ctx.createLinearGradient(0, 0, w, 0)
  grad.addColorStop(0, `rgba(255, 255, 255, ${NAME_BAR.alpha})`)
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
 * 官方 `TalkWindow/NameBackground`（`[210, 824, 720, 16]` @ 1920×1080）。
 */
export default class UITextUnderline extends FadableSprite {
  constructor(fallbackTexture: Texture, screen_width: number, screen_height: number) {
    const k = Math.min(screen_width / SSE_UI_SPEC.refWidth, screen_height / SSE_UI_SPEC.refHeight)
    const officialTex = createOfficialNameBarTexture()
    super(officialTex ?? fallbackTexture)

    this.x = NAME_BAR.x * k
    this.y = NAME_BAR.y * k
    this.width = NAME_BAR.width * k
    this.height = NAME_BAR.height * k
  }
}
