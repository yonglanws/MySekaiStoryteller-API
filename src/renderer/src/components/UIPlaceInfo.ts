import { Container, Graphics, Sprite, Text, TextStyle, Texture } from 'pixi.js'
import { runEasedTween } from '../effects/Ease'

function createPlaceInfoBandTexture(): Texture | null {
  if (typeof document === 'undefined') return null
  const leftRamp = 152
  const solid = 580
  const rightRamp = 152
  const totalW = leftRamp + solid + rightRamp
  const h = 72
  const canvas = document.createElement('canvas')
  canvas.width = totalW
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const grad = ctx.createLinearGradient(0, 0, totalW, 0)
  grad.addColorStop(0, 'rgba(68, 68, 102, 0.0)')
  grad.addColorStop(leftRamp / totalW, 'rgba(68, 68, 102, 0.82)')
  grad.addColorStop((leftRamp + solid) / totalW, 'rgba(68, 68, 102, 0.82)')
  grad.addColorStop(1, 'rgba(68, 68, 102, 0.0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, totalW, h)
  return Texture.from(canvas)
}

/**
 * 官方 `ScenarioPlaceInfo`（`EffectType 18`）：左上角 `580x72` 地点横幅，`OutQuart 0.2s` 滑入，
 * 在下一句 `Talk` 结束时自动关闭（`close()`）。
 */
export default class UIPlaceInfo extends Container {
  private readonly k: number
  private readonly hiddenX: number
  private readonly label: Text
  private active = false
  private animGen = 0

  constructor(screen_width: number, screen_height: number) {
    super()
    this.k = Math.min(screen_width / 1920, screen_height / 1080)
    const aspect = screen_width / Math.max(1, screen_height)
    this.hiddenX = (aspect - 580) * this.k
    this.visible = false
    this.x = this.hiddenX
    this.y = 0

    const tex = createPlaceInfoBandTexture()
    if (tex && tex.valid && tex.baseTexture?.valid) {
      const sp = new Sprite(tex)
      sp.x = -152 * this.k
      sp.y = 31 * this.k
      sp.width = (152 + 580 + 152) * this.k
      sp.height = 72 * this.k
      this.addChild(sp)
    } else {
      const g = new Graphics()
      g.beginFill(0x444466, 0.82)
      g.drawRect(0, 31 * this.k, 580 * this.k, 72 * this.k)
      g.endFill()
      this.addChild(g)
    }

    const style = new TextStyle({
      align: 'left',
      fill: '#FFFFFF',
      fontFamily: "'MiSans Medium', sans-serif",
      fontSize: 38 * this.k,
      stroke: 'rgba(20, 20, 40, 0.35)',
      strokeThickness: 1.5 * this.k
    })
    this.label = new Text('', style)
    this.label.anchor.set(0, 0.5)
    this.label.x = 40 * this.k
    this.label.y = (31 + 36) * this.k
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
