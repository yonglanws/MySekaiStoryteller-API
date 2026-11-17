import { Container, Graphics, Sprite, Text, TextStyle, Texture } from 'pixi.js'
import AnimationManager from '../managers/AnimationManager'

/** 官方 `ac_scenario_telop_v2_01` / `_02` 21 采样点曲线（60fps 每帧采样，`native_ui.rs:159-181`）。 */
export const TELOP_SHOW_BASE_SCALE_X = [
  0.0, 0.12296, 0.25391, 0.37795, 0.48991, 0.58842, 0.67495, 0.74949, 0.8125, 0.86549, 0.90873,
  0.94274, 0.9685, 0.98631, 0.99662, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0
] as const

export const TELOP_SHOW_BASE_ALPHA = [
  0.0, 0.01372, 0.05516, 0.1241, 0.21668, 0.32518, 0.4419, 0.55721, 0.66336, 0.75705, 0.83532,
  0.89725, 0.94396, 0.97589, 0.99411, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0
] as const

export const TELOP_SHOW_TEXT_ALPHA = [
  0.0, 0.0, 0.0, 0.0, 0.01159, 0.05211, 0.1365, 0.29176, 0.54934, 0.80819, 0.90005, 0.92208,
  0.94093, 0.95669, 0.96952, 0.97981, 0.98771, 0.99342, 0.99723, 0.99935, 1.0
] as const

export const TELOP_SHOW_TEXT_X = [
  -30.0, -30.0, -30.0, -30.0, -29.69962, -28.85422, -27.52697, -25.79509, -23.74549, -21.42683,
  -18.92424, -16.32728, -13.678, -11.0655, -8.57801, -6.25891, -4.19729, -2.47611, -1.14798,
  -0.29804, 0.0
] as const

export const TELOP_HIDE_ALPHA = [
  1.0, 0.99797, 0.99153, 0.97992, 0.96224, 0.93757, 0.90421, 0.86046, 0.8045, 0.73316, 0.6446,
  0.53982, 0.42369, 0.30985, 0.21207, 0.1352, 0.07928, 0.04113, 0.01686, 0.00391, 0.00001
] as const

export function sampleTelopCurve(table: readonly number[], progress: number): number {
  const idxFloat = Math.max(0, Math.min(20, progress * 20))
  const i = Math.min(19, Math.floor(idxFloat))
  const frac = idxFloat - i
  return table[i] + (table[i + 1] - table[i]) * frac
}

function createTelopBandTexture(): Texture | null {
  if (typeof document === 'undefined') return null
  const w = 1040
  const h = 120
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const grad = ctx.createLinearGradient(0, 0, w, 0)
  grad.addColorStop(0, 'rgba(68, 68, 102, 0.0)')
  grad.addColorStop(0.25, 'rgba(68, 68, 102, 0.8)')
  grad.addColorStop(0.75, 'rgba(68, 68, 102, 0.8)')
  grad.addColorStop(1, 'rgba(68, 68, 102, 0.0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)
  return Texture.from(canvas)
}

/**
 * 官方 `Telop` 横幅（`[440, 480, 1040, 120]` @ 1920×1080，`rgba(68,68,102,0.8)`）。
 * 修复旧版 `hide()` 中 `this.x -> this.x + 10` 永不归零导致的永久向右漂移 Bug，
 * 并精确采用官方 21 点 `ac_scenario_telop_v2_01/02` 缩放/透明/文本滑入曲线。
 */
export default class UITelop extends Container {
  private readonly telopBand: Sprite | Graphics
  private readonly telopText: Text
  private readonly k: number
  private readonly baseTextX: number
  private animGen = 0

  constructor(fallbackTexture: Texture, screen_width: number, screen_height: number) {
    super()
    this.k = Math.min(screen_width / 1920, screen_height / 1080)
    this.visible = false
    this.x = 0
    this.y = 0

    const bandTex = createTelopBandTexture()
    const left = 440 * this.k
    const top = 480 * this.k
    const width = 1040 * this.k
    const height = 120 * this.k
    const pivotLocalX = 0.02 * width

    if (bandTex) {
      const sp = new Sprite(bandTex)
      sp.width = width
      sp.height = height
      sp.pivot.set(0.02 * bandTex.width, 0)
      sp.position.set(left + pivotLocalX, top)
      this.telopBand = sp
    } else if (fallbackTexture && fallbackTexture !== Texture.EMPTY) {
      const sp = new Sprite(fallbackTexture)
      sp.width = width
      sp.height = height
      sp.position.set(left + pivotLocalX, top)
      this.telopBand = sp
    } else {
      const g = new Graphics()
      g.beginFill(0x444466, 0.8)
      g.drawRect(-pivotLocalX, 0, width, height)
      g.endFill()
      g.position.set(left + pivotLocalX, top)
      this.telopBand = g
    }

    const style = new TextStyle({
      align: 'center',
      fill: '#FFFFFF',
      fontFamily: "'MiSans Medium', sans-serif",
      fontSize: 44 * this.k,
      stroke: 'rgba(20, 20, 40, 0.35)',
      strokeThickness: 1.5 * this.k
    })
    this.telopText = new Text('', style)
    this.telopText.anchor.set(0.5, 0.5)
    this.baseTextX = screen_width / 2
    this.telopText.x = this.baseTextX
    this.telopText.y = (480 + 60) * this.k

    this.addChild(this.telopBand, this.telopText)
  }

  set text(text: string) {
    this.telopText.text = text
  }

  get textX(): number {
    return this.telopText.x
  }

  private resetOrigin(): void {
    this.x = 0
    this.y = 0
    this.telopBand.scale.x = 1
    this.telopBand.alpha = 0
    this.telopText.alpha = 0
    this.telopText.x = this.baseTextX
  }

  public async show(time: number): Promise<void> {
    const gen = ++this.animGen
    this.resetOrigin()
    this.visible = true

    if (time <= 0) {
      this.telopBand.scale.x = 1
      this.telopBand.alpha = 1
      this.telopText.alpha = 1
      this.telopText.x = this.baseTextX
      return
    }

    await AnimationManager.linear((progress) => {
      if (gen !== this.animGen) return
      this.telopBand.scale.x = sampleTelopCurve(TELOP_SHOW_BASE_SCALE_X, progress)
      this.telopBand.alpha = sampleTelopCurve(TELOP_SHOW_BASE_ALPHA, progress)
      this.telopText.alpha = sampleTelopCurve(TELOP_SHOW_TEXT_ALPHA, progress)
      this.telopText.x = this.baseTextX + sampleTelopCurve(TELOP_SHOW_TEXT_X, progress) * this.k
    }, time)

    if (gen === this.animGen) {
      this.telopBand.scale.x = 1
      this.telopBand.alpha = 1
      this.telopText.alpha = 1
      this.telopText.x = this.baseTextX
    }
  }

  public async hide(time: number): Promise<void> {
    const gen = ++this.animGen
    this.x = 0
    this.telopBand.scale.x = 1
    this.telopText.x = this.baseTextX

    if (time > 0) {
      await AnimationManager.linear((progress) => {
        if (gen !== this.animGen) return
        const a = sampleTelopCurve(TELOP_HIDE_ALPHA, progress)
        this.telopBand.alpha = a
        this.telopText.alpha = a
      }, time)
    }

    if (gen === this.animGen) {
      this.resetOrigin()
      this.visible = false
    }
  }
}
