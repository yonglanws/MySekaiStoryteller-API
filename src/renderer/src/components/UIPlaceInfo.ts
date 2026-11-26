import { Container, Graphics, Sprite, Text, TextStyle, Texture } from 'pixi.js'
import { runEasedTween } from '../effects/Ease'
import { GAME_FONT_BODY_STACK, GAME_FONT_BODY_WEIGHT, SSE_UI_SPEC } from '../utils/FontLoader'

const PLACE = SSE_UI_SPEC.placeInfo

function createPlaceInfoBandTexture(): Texture | null {
  if (typeof document === 'undefined') return null
  const leftRamp = PLACE.leftRamp
  const solid = PLACE.solidWidth
  const rightRamp = PLACE.rightRamp
  const totalW = leftRamp + solid + rightRamp
  const h = PLACE.height
  const canvas = document.createElement('canvas')
  canvas.width = totalW
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const grad = ctx.createLinearGradient(0, 0, totalW, 0)
  grad.addColorStop(0, 'rgba(68, 68, 102, 0.0)')
  grad.addColorStop(leftRamp / totalW, PLACE.bandColor)
  grad.addColorStop((leftRamp + solid) / totalW, PLACE.bandColor)
  grad.addColorStop(1, 'rgba(68, 68, 102, 0.0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, totalW, h)
  return Texture.from(canvas)
}

/**
 * 官方 `ScenarioPlaceInfo`（`EffectType 18`）：左上角 `580×64` 地点横幅（`y=31`，两侧各 `152px` 渐变，
 * `rgba(68, 68, 102, 0.8)`），`OutQuart 0.2s` 滑入，在下一句 `Talk` 结束时自动关闭（`close()`）。
 * 文字 `[40, 43, 520, 40]`，`40 * k` `SekaiCN-Medium` 白字无描边。
 */
export default class UIPlaceInfo extends Container {
  private readonly k: number
  private readonly hiddenX: number
  private readonly label: Text
  private active = false
  private animGen = 0

  constructor(screen_width: number, screen_height: number) {
    super()
    this.k = Math.min(screen_width / SSE_UI_SPEC.refWidth, screen_height / SSE_UI_SPEC.refHeight)
    const aspect = screen_width / Math.max(1, screen_height)
    this.hiddenX = (aspect - PLACE.solidWidth) * this.k
    this.visible = false
    this.x = this.hiddenX
    this.y = 0

    const tex = createPlaceInfoBandTexture()
    if (tex && tex.valid && tex.baseTexture?.valid) {
      const sp = new Sprite(tex)
      sp.x = -PLACE.leftRamp * this.k
      sp.y = PLACE.y * this.k
      sp.width = (PLACE.leftRamp + PLACE.solidWidth + PLACE.rightRamp) * this.k
      sp.height = PLACE.height * this.k
      this.addChild(sp)
    } else {
      const g = new Graphics()
      g.beginFill(0x444466, 0.8)
      g.drawRect(0, PLACE.y * this.k, PLACE.solidWidth * this.k, PLACE.height * this.k)
      g.endFill()
      this.addChild(g)
    }

    const style = new TextStyle({
      align: 'left',
      fill: PLACE.fill,
      fontFamily: GAME_FONT_BODY_STACK,
      fontWeight: GAME_FONT_BODY_WEIGHT,
      fontSize: PLACE.fontSize * this.k,
      strokeThickness: 0
    })
    this.label = new Text('', style)
    this.label.anchor.set(0, 0.5)
    this.label.x = PLACE.textX * this.k
    this.label.y = (PLACE.textY + PLACE.textHeight / 2) * this.k
    this.addChild(this.label)
  }

  public get isActive(): boolean {
    return this.active
  }

  public async show(text: string, durationMs = 200): Promise<void> {
    const gen = ++this.animGen
    this.active = true
    this.label.text = text
    this.visible = true
    this.x = this.hiddenX

    await runEasedTween(
      durationMs,
      'OutQuart',
      (p) => {
        if (gen !== this.animGen) return
        this.x = this.hiddenX + (0 - this.hiddenX) * p
      },
      () => gen !== this.animGen
    )
    if (gen === this.animGen) {
      this.x = 0
    }
  }

  public async close(durationMs = 200): Promise<void> {
    if (!this.active && !this.visible) return
    const gen = ++this.animGen
    this.active = false
    const startX = this.x

    await runEasedTween(
      durationMs,
      'OutQuart',
      (p) => {
        if (gen !== this.animGen) return
        this.x = startX + (this.hiddenX - startX) * p
      },
      () => gen !== this.animGen
    )
    if (gen === this.animGen) {
      this.x = this.hiddenX
      this.visible = false
    }
  }
}
