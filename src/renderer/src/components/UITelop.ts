import { Container, Sprite, Text, TextStyle, Texture } from 'pixi.js'
import AnimationManager from '../managers/AnimationManager'
import {
  GAME_FONT_BODY_STACK,
  GAME_FONT_BODY_WEIGHT,
  SSE_UI_SPEC,
  sseLineAdvance
} from '../utils/FontLoader'

const TELOP = SSE_UI_SPEC.telop

/**
 * 官方 `ac_scenario_telop_v2_01` / `_02` 21 点 60fps 曲线（`SekaiStoryExporter/crates/sse-render/src/native_ui.rs::telop_clip`）。
 */
const SHOW_BASE_SCALE_X = [
  0.0, 0.12296, 0.25391, 0.37795, 0.48991, 0.58842, 0.67495, 0.74949, 0.8125, 0.86549, 0.90873,
  0.94274, 0.9685, 0.98631, 0.99662, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0
] as const

const SHOW_BASE_ALPHA = [
  0.0, 0.01372, 0.05516, 0.1241, 0.21668, 0.32518, 0.4419, 0.55721, 0.66336, 0.75705, 0.83532,
  0.89725, 0.94396, 0.97589, 0.99411, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0
] as const

const SHOW_TEXT_ALPHA = [
  0.0, 0.0, 0.0, 0.0, 0.01159, 0.05211, 0.1365, 0.29176, 0.54934, 0.80819, 0.90005, 0.92208,
  0.94093, 0.95669, 0.96952, 0.97981, 0.98771, 0.99342, 0.99723, 0.99935, 1.0
] as const

const SHOW_TEXT_X = [
  -30.0, -30.0, -30.0, -30.0, -29.69962, -28.85422, -27.52697, -25.79509, -23.74549, -21.42683,
  -18.92424, -16.32728, -13.678, -11.0655, -8.57801, -6.25891, -4.19729, -2.47611, -1.14798,
  -0.29804, 0.0
] as const

const HIDE_ALPHA = [
  1.0, 0.99797, 0.99153, 0.97992, 0.96224, 0.93757, 0.90421, 0.86046, 0.8045, 0.73316, 0.6446,
  0.53982, 0.42369, 0.30985, 0.21207, 0.1352, 0.07928, 0.04113, 0.01686, 0.00391, 0.00001
] as const

function sampleClip(table: readonly number[], progress: number): number {
  const x = Math.max(0, Math.min(1, progress)) * (table.length - 1)
  const i = Math.min(table.length - 2, Math.floor(x))
  const w = x - i
  return table[i] * (1 - w) + table[i + 1] * w
}

function createOfficialTelopBandTexture(): Texture | null {
  if (typeof document === 'undefined') return null
  const w = TELOP.width
  const h = TELOP.height
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const grad = ctx.createLinearGradient(0, 0, w, 0)
  grad.addColorStop(0, 'rgba(68, 68, 102, 0.0)')
  grad.addColorStop(TELOP.leftRamp / w, TELOP.bandColor)
  grad.addColorStop((TELOP.leftRamp + TELOP.solid) / w, TELOP.bandColor)
  grad.addColorStop(1, 'rgba(68, 68, 102, 0.0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)
  return Texture.from(canvas)
}

/**
 * 官方 `ScenarioTelop`（`[440, 480, 1040, 120]` @ 1920×1080）：
 * - 三段式渐变带 `260 / 520 / 260`，色值 `rgba(68, 68, 102, 0.8)`，绕 `pivotX = 0.02` 水平展开
 * - 居中 `44 * k` `SekaiCN-Medium` 白字无描边，文字独立 `-30 -> 0` 滑入且容器原点恒为 0（零漂移）
 */
export default class UITelop extends Container {
  private readonly k: number
  private readonly baseSpriteScaleX: number
  private readonly baseTextX: number
  private readonly telopSprite: Sprite
  private readonly telopText: Text
  private animGen = 0

  constructor(telopTexture: Texture, screen_width: number, screen_height: number) {
    super()
    this.k = Math.min(screen_width / SSE_UI_SPEC.refWidth, screen_height / SSE_UI_SPEC.refHeight)
    this.visible = false
    this.x = 0
    this.y = 0

    const officialTex = createOfficialTelopBandTexture()
    const tex = officialTex ?? telopTexture
    this.telopSprite = new Sprite(tex)
    this.telopSprite.anchor.set(TELOP.pivotX, 0.5)
    this.telopSprite.x = (TELOP.x + TELOP.pivotX * TELOP.width) * this.k
    this.telopSprite.y = screen_height / 2
    this.telopSprite.width = TELOP.width * this.k
    this.telopSprite.height = TELOP.height * this.k
    this.baseSpriteScaleX = this.telopSprite.scale.x

    const style = new TextStyle({
      align: 'center',
      fill: TELOP.fill,
      fontFamily: GAME_FONT_BODY_STACK,
      fontWeight: GAME_FONT_BODY_WEIGHT,
      fontSize: TELOP.fontSize * this.k,
      lineHeight: sseLineAdvance(TELOP.fontSize, TELOP.lineSpacing) * this.k,
      strokeThickness: 0,
      wordWrap: true,
      wordWrapWidth: TELOP.width * this.k,
      breakWords: true
    })
    this.telopText = new Text('', style)
    this.telopText.anchor.set(0.5, 0.5)
    this.baseTextX = screen_width / 2
    this.telopText.x = this.baseTextX
    this.telopText.y = screen_height / 2

    this.addChild(this.telopSprite)
    this.addChild(this.telopText)
  }

  set text(text: string) {
    this.telopText.text = text
  }

  private resetOrigin(): void {
    this.x = 0
    this.y = 0
  }

  public async show(time: number): Promise<void> {
    const gen = ++this.animGen
    this.resetOrigin()
    this.visible = true

    if (time <= 0) {
      this.telopSprite.scale.x = this.baseSpriteScaleX
      this.telopSprite.alpha = 1
      this.telopText.alpha = 1
      this.telopText.x = this.baseTextX
      return
    }

    this.telopSprite.scale.x = 0
    this.telopSprite.alpha = 0
    this.telopText.alpha = 0
    this.telopText.x = this.baseTextX + SHOW_TEXT_X[0] * this.k

    await AnimationManager.linear((progress) => {
      if (gen !== this.animGen) return
      this.telopSprite.scale.x = this.baseSpriteScaleX * sampleClip(SHOW_BASE_SCALE_X, progress)
      this.telopSprite.alpha = sampleClip(SHOW_BASE_ALPHA, progress)
      this.telopText.alpha = sampleClip(SHOW_TEXT_ALPHA, progress)
      this.telopText.x = this.baseTextX + sampleClip(SHOW_TEXT_X, progress) * this.k
    }, time)

    if (gen === this.animGen) {
      this.telopSprite.scale.x = this.baseSpriteScaleX
      this.telopSprite.alpha = 1
      this.telopText.alpha = 1
      this.telopText.x = this.baseTextX
      this.resetOrigin()
    }
  }

  public async hide(time: number): Promise<void> {
    const gen = ++this.animGen
    this.resetOrigin()

    if (time > 0) {
      const fromSpriteAlpha = this.telopSprite.alpha
      const fromTextAlpha = this.telopText.alpha
      await AnimationManager.linear((progress) => {
        if (gen !== this.animGen) return
        const a = sampleClip(HIDE_ALPHA, progress)
        this.telopSprite.alpha = fromSpriteAlpha * a
        this.telopText.alpha = fromTextAlpha * a
      }, time)
    }

    if (gen === this.animGen) {
      this.telopSprite.alpha = 0
      this.telopText.alpha = 0
      this.telopText.x = this.baseTextX
      this.resetOrigin()
      this.visible = false
    }
  }
}
