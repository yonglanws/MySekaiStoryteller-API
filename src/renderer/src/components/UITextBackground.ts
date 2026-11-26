import { Texture } from 'pixi.js'
import { SSE_UI_SPEC } from '../utils/FontLoader'
import FadableSprite from './FadableSprite'

const WINDOW = SSE_UI_SPEC.window

/**
 * 同步生成与官方 `bg_story_adv.png`（4×399，乘 `WINDOW_COLOR = #000022`）逐段一致的垂直渐变纹理：
 * 顶边 0% 透明平滑过渡至 44% 处 128/255（≈0.502），44%–100% 保持 0.502 均匀半透明底板。
 * 同步创建保证第 0 帧即完全确定性，无异步换图闪烁。
 */
function createOfficialTalkWindowTexture(): Texture | null {
  if (typeof document === 'undefined') return null
  const w = 16
  const h = 399
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const grad = ctx.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0.0, 'rgba(0, 0, 34, 0.004)')
  grad.addColorStop(0.063, 'rgba(0, 0, 34, 0.059)')
  grad.addColorStop(0.126, 'rgba(0, 0, 34, 0.141)')
  grad.addColorStop(0.188, 'rgba(0, 0, 34, 0.235)')
  grad.addColorStop(0.251, 'rgba(0, 0, 34, 0.329)')
  grad.addColorStop(0.314, 'rgba(0, 0, 34, 0.420)')
  grad.addColorStop(0.377, 'rgba(0, 0, 34, 0.486)')
  grad.addColorStop(0.44, 'rgba(0, 0, 34, 0.502)')
  grad.addColorStop(1.0, 'rgba(0, 0, 34, 0.502)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)
  return Texture.from(canvas)
}

/**
 * 官方 `TalkWindow/Window`（`[-440, 768, 2800, 312]` @ 1920×1080，色值 `#000022`）。
 */
export default class UITextBackground extends FadableSprite {
  constructor(fallbackTexture: Texture, screen_width: number, screen_height: number) {
    const k = Math.min(screen_width / SSE_UI_SPEC.refWidth, screen_height / SSE_UI_SPEC.refHeight)
    const officialTex = createOfficialTalkWindowTexture()
    super(officialTex ?? fallbackTexture)

    this.anchor.set(0, 0)
    this.x = WINDOW.x * k
    this.y = WINDOW.y * k
    this.width = WINDOW.width * k
    this.height = WINDOW.height * k
  }
}
