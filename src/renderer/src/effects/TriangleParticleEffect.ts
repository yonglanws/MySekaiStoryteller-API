import { Container, Graphics, Rectangle, Sprite, Texture } from 'pixi.js'
import type AdvancedModel from '../model/AdvancedModel'
import { loadInappTexture } from './InappTextures'
import { createMulberry32 } from './OfficialFilters'
import { VisualEffect } from './VisualEffect'

interface TriParticleState {
  node: Graphics | Sprite
  vx: number
  vy: number
  rotSpeed: number
  elapsedSec: number
  lifespanSec: number
  baseScale: number
  pulsePhase: number
}

function drawVectorTriangle(
  g: Graphics,
  radius: number,
  color: number,
  alpha: number,
  filled = true
): void {
  const pts: number[] = []
  for (let i = 0; i < 3; i++) {
    const a = (i * 2 * Math.PI) / 3 - Math.PI / 2
    pts.push(Math.cos(a) * radius, Math.sin(a) * radius)
  }
  if (filled) {
    g.beginFill(color, alpha)
  } else {
    g.lineStyle(2.5, color, alpha)
  }
  g.drawPolygon(pts)
  if (filled) g.endFill()
}

class ModelParticleTriangle extends Graphics {
  private readonly vy: number
  private readonly rotSpeed: number
  private elapsedSec = 0
  private readonly lifespanSec: number

  constructor(
    x: number,
    y: number,
    size: number,
    color: number,
    vy: number,
    rotSpeed: number,
    lifespanSec: number,
    isFilled: boolean
  ) {
    super()
    this.x = x
    this.y = y
    this.vy = vy
    this.rotSpeed = rotSpeed
    this.lifespanSec = Math.max(0.05, lifespanSec)
    drawVectorTriangle(this, size, color, 0.85, isFilled)
  }

  updateSec(dtSec: number): boolean {
    this.elapsedSec += dtSec
    this.y += this.vy * dtSec * 60
    this.rotation += this.rotSpeed * dtSec * 60
    const progress = this.elapsedSec / this.lifespanSec
    if (progress < 0.15) {
      this.alpha = progress / 0.15
    } else if (progress > 0.7) {
      this.alpha = Math.max(0, 1 - (progress - 0.7) / 0.3)
    } else {
      this.alpha = 1
    }
    return this.elapsedSec >= this.lifespanSec
  }
}

/**
 * 角色附属三角形上升粒子（用于模型全息伴生特效），全部由虚拟时钟 `delta / 60` 驱动，
 * 不使用 `performance.now()` 或独立 `requestAnimationFrame`。
 */
export default class TriangleParticleEffect extends VisualEffect {
  private readonly particles: ModelParticleTriangle[] = []
  private readonly colors = [0x00ffff, 0x80ffff, 0x40e0d0, 0xafeeee, 0xffffff]
  private readonly rand = createMulberry32(0x13572468)
  private spawnCooldownSec = 0
  private readonly spawnIntervalSec = 0.08

  constructor(model: AdvancedModel) {
    super(model)
    for (let i = 0; i < 6; i++) {
      this.spawnParticle()
    }
  }

  private spawnParticle(): void {
    const x = (this.rand() - 0.5) * 450
    const y = (this.rand() - 0.25) * 500
    const size = 12 + this.rand() * 24
    const color = this.colors[Math.floor(this.rand() * this.colors.length)]
    const vy = -(1.5 + this.rand() * 2.5)
    const rotSpeed = (this.rand() - 0.5) * 0.08
    const lifespanSec = 1.5 + this.rand() * 1.0
    const filled = this.rand() > 0.3
    const p = new ModelParticleTriangle(x, y, size, color, vy, rotSpeed, lifespanSec, filled)
    this.particles.push(p)
    this.addChild(p)
  }

  update(delta: number): void {
    const dtSec = Math.max(0, delta) / 60
    this.spawnCooldownSec += dtSec
    while (this.spawnCooldownSec >= this.spawnIntervalSec) {
      this.spawnCooldownSec -= this.spawnIntervalSec
      if (this.particles.length < 30) {
        this.spawnParticle()
      }
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const particle = this.particles[i]
      if (particle.updateSec(dtSec)) {
        this.removeChild(particle)
        particle.destroy()
        this.particles.splice(i, 1)
      }
    }
  }

  destroyEffect(): void {
    this.destroy()
  }

  destroy(): void {
    for (const p of this.particles) p.destroy()
    this.particles.length = 0
    super.destroy({ children: true })
  }
}

const SEKAI_V1_COLORS = [0x6be8f2, 0x7effc8, 0xff9ad5, 0x82b8ff, 0xfff08a, 0xffffff]
const SEKAI_V2_COLORS = [0x82f7ff, 0xffb3ec, 0x9cf09b, 0xa3c4ff, 0xffe49e, 0xffffff]

/**
 * `SekaiIn/Out` (`EffectType 20/21/40/41`) 独立全屏三角光片爆发特效（对应 `fx_transition_scenario`），
 * 优先使用 `inapp` 官包图集 `tex_common_tri_01.png`（4x4 子块），离线时回退高洁矢量三角。
 */
export class SekaiTransitionParticles extends Container {
  private readonly particles: TriParticleState[] = []
  private readonly rand = createMulberry32(0x20214041)
  private readonly widthPx: number
  private readonly heightPx: number
  private readonly variant: 'v1' | 'v2'
  private sheetTexture: Texture | null = null
  private elapsedSec = 0
  private readonly burstDurationSec = 1.6
  private totalEmitted = 0

  constructor(width: number, height: number, variant: 'v1' | 'v2' = 'v1') {
    super()
    this.widthPx = width
    this.heightPx = height
    this.variant = variant
    void loadInappTexture('player/loose/Texture2D/tex_common_tri_01.png').then((tex) => {
      if (!this.destroyed && tex && tex.valid && tex.baseTexture?.valid) {
        this.sheetTexture = tex
      }
    })
    const initialCount = variant === 'v2' ? 28 : 22
    for (let i = 0; i < initialCount; i++) {
      this.spawnOne()
    }
  }

  private tileTexture(index: number): Texture | null {
    if (!this.sheetTexture || !this.sheetTexture.valid || !this.sheetTexture.baseTexture?.valid) {
      return null
    }
    const base = this.sheetTexture.baseTexture
    const w = base.width
    const h = base.height
    if (w < 16 || h < 16) return null
    const col = index % 4
    const row = Math.floor(index / 4) % 4
    const cellW = Math.floor(w / 4)
    const cellH = Math.floor(h / 4)
    return new Texture(base, new Rectangle(col * cellW, row * cellH, cellW, cellH))
  }

  private spawnOne(): void {
    const colors = this.variant === 'v2' ? SEKAI_V2_COLORS : SEKAI_V1_COLORS
    const color = colors[Math.floor(this.rand() * colors.length)]
    const cx = this.widthPx * 0.5
    const cy = this.heightPx * 0.5
    const angle = this.rand() * Math.PI * 2
    const spawnDist = this.rand() * Math.min(this.widthPx, this.heightPx) * 0.45
    const x = cx + Math.cos(angle) * spawnDist
    const y = cy + Math.sin(angle) * spawnDist
    const speed = (180 + this.rand() * 440) * (this.widthPx / 1920)
    const scale = (0.35 + this.rand() * 0.95) * (this.widthPx / 1920)

    const tile = this.tileTexture(Math.floor(this.rand() * 16))
    let node: Graphics | Sprite
    if (tile) {
      const sprite = new Sprite(tile)
      sprite.anchor.set(0.5)
      sprite.tint = color
      sprite.scale.set(scale)
      node = sprite
    } else {
      const g = new Graphics()
      drawVectorTriangle(g, 28 * scale, color, 0.92, this.rand() > 0.25)
      node = g
    }

    node.position.set(x, y)
    node.rotation = this.rand() * Math.PI * 2
    this.addChild(node)
    this.particles.push({
      node,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 40 * (this.heightPx / 1080),
      rotSpeed: (this.rand() - 0.5) * 4.5,
      elapsedSec: 0,
      lifespanSec: 0.9 + this.rand() * 1.4,
      baseScale: node instanceof Sprite ? scale : 1,
      pulsePhase: this.rand() * Math.PI * 2
    })
    this.totalEmitted++
  }

  get isFinished(): boolean {
    return this.elapsedSec >= 3.5 && this.particles.length === 0
  }

  step(dtSec: number): void {
    const dt = Math.max(0, dtSec)
    this.elapsedSec += dt
    if (this.elapsedSec < this.burstDurationSec && this.totalEmitted < 72 && this.particles.length < 48) {
      const emitCount = Math.min(2, 48 - this.particles.length)
      for (let i = 0; i < emitCount; i++) this.spawnOne()
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]
      p.elapsedSec += dt
      p.node.x += p.vx * dt
      p.node.y += p.vy * dt
      p.node.rotation += p.rotSpeed * dt
      const t = p.elapsedSec / p.lifespanSec
      const shimmer = 0.85 + 0.15 * Math.sin(this.elapsedSec * 9 + p.pulsePhase)
      if (t < 0.2) {
        p.node.alpha = (t / 0.2) * shimmer
      } else {
        p.node.alpha = Math.max(0, 1 - (t - 0.2) / 0.8) * shimmer
      }
      if (p.node instanceof Sprite) {
        p.node.scale.set(p.baseScale * (1 + t * 0.35))
      }
      if (t >= 1) {
        this.removeChild(p.node)
        p.node.destroy()
        this.particles.splice(i, 1)
      }
    }
  }
}

export type ScenarioEffectPreset =
  | 'rain'
  | 'snow'
  | 'sakura'
  | 'sparkle'
  | 'speedlines'
  | 'memories'
  | 'bubble'
  | 'mist'

interface OverlayParticle {
  g: Graphics
  x: number
  y: number
  vx: number
  vy: number
  phase: number
  spin: number
  life: number
  maxLife: number
  scale: number
}

export function classifyScenarioEffect(name: string): ScenarioEffectPreset {
  const n = name.toLowerCase()
  if (/rain|ame|雨|thunder|storm/.test(n)) return 'rain'
  if (/snow|yuki|雪|ice|blizzard/.test(n)) return 'snow'
  if (/sakura|cherry|petal|桜|花|hanabira/.test(n)) return 'sakura'
  if (/speed|line|dash|集中|wind_line|impact/.test(n)) return 'speedlines'
  if (/memor|recollect|回想|vignette|flashback/.test(n)) return 'memories'
  if (/bubble|泡|water|sea/.test(n)) return 'bubble'
  if (/mist|fog|smoke|steam|霧|煙/.test(n)) return 'mist'
  return 'sparkle'
}

/**
 * `PlayScenarioEffect` / `StopScenarioEffect` (`EffectType 15/16`) 虚拟时钟场景粒子预设播放器。
 */
export class ScenarioEffectOverlay extends Container {
  readonly effectName: string
  readonly preset: ScenarioEffectPreset
  private readonly widthPx: number
  private readonly heightPx: number
  private readonly rand: () => number
  private readonly items: OverlayParticle[] = []
  private readonly backdrop: Graphics
  private elapsedSec = 0
  private stopping = false
  private fadeAlpha = 1

  constructor(effectName: string, width: number, height: number) {
    super()
    this.effectName = effectName
    this.preset = classifyScenarioEffect(effectName)
    this.widthPx = width
    this.heightPx = height
    let hash = 0x9e3779b9
    for (let i = 0; i < effectName.length; i++) {
      hash = (Math.imul(hash, 31) + effectName.charCodeAt(i)) >>> 0
    }
    this.rand = createMulberry32(hash)
    this.backdrop = new Graphics()
    this.addChild(this.backdrop)

    if (this.preset === 'memories') {
      this.drawMemoriesFrame()
    }
    const count =
      this.preset === 'rain'
        ? 64
        : this.preset === 'speedlines'
          ? 28
          : this.preset === 'mist'
            ? 14
            : 36
    for (let i = 0; i < count; i++) {
      this.spawnItem(true)
    }
  }

  private drawMemoriesFrame(): void {
    const g = this.backdrop
    g.clear()
    g.lineStyle(48 * (this.widthPx / 1920), 0x161830, 0.38)
    g.drawRect(0, 0, this.widthPx, this.heightPx)
    g.lineStyle(22 * (this.widthPx / 1920), 0xffffff, 0.14)
    g.drawRect(24, 24, this.widthPx - 48, this.heightPx - 48)
  }

  private spawnItem(initial = false): void {
    const g = new Graphics()
    const scaleRatio = this.widthPx / 1920
    let x = this.rand() * this.widthPx
    let y = initial ? this.rand() * this.heightPx : -20
    let vx = 0
    let vy = 0
    let spin = 0
    const maxLife = 2 + this.rand() * 3.5

    switch (this.preset) {
      case 'rain': {
        g.lineStyle(1.8 * scaleRatio, 0xcce6ff, 0.55)
        g.moveTo(0, 0)
        g.lineTo(-8 * scaleRatio, 38 * scaleRatio)
        x = this.rand() * (this.widthPx + 200)
        y = initial ? this.rand() * this.heightPx : -40
        vx = -220 * scaleRatio
        vy = 1150 * scaleRatio
        break
      }
      case 'snow': {
        g.beginFill(0xffffff, 0.72)
        g.drawCircle(0, 0, (2.5 + this.rand() * 4.5) * scaleRatio)
        g.endFill()
        vx = (this.rand() - 0.5) * 35 * scaleRatio
        vy = (55 + this.rand() * 75) * scaleRatio
        break
      }
      case 'sakura': {
        const s = (7 + this.rand() * 7) * scaleRatio
        g.beginFill(0xffb7d5, 0.82)
        g.drawPolygon([0, -s, s * 0.55, 0, 0, s * 0.85, -s * 0.55, 0])
        g.endFill()
        x = this.rand() * (this.widthPx + 180)
        vx = -(30 + this.rand() * 65) * scaleRatio
        vy = (70 + this.rand() * 70) * scaleRatio
        spin = (this.rand() - 0.5) * 3.2
        break
      }
      case 'speedlines': {
        const angle = this.rand() * Math.PI * 2
        const rInner = Math.min(this.widthPx, this.heightPx) * (0.36 + this.rand() * 0.14)
        const rOuter = Math.max(this.widthPx, this.heightPx) * 0.9
        g.lineStyle((2 + this.rand() * 3.5) * scaleRatio, 0xffffff, 0.55)
        g.moveTo(this.widthPx * 0.5 + Math.cos(angle) * rInner, this.heightPx * 0.5 + Math.sin(angle) * rInner)
        g.lineTo(this.widthPx * 0.5 + Math.cos(angle) * rOuter, this.heightPx * 0.5 + Math.sin(angle) * rOuter)
        x = 0
        y = 0
        break
      }
      case 'bubble': {
        const r = (6 + this.rand() * 14) * scaleRatio
        g.lineStyle(1.6 * scaleRatio, 0xdcf7ff, 0.65)
        g.beginFill(0xffffff, 0.14)
        g.drawCircle(0, 0, r)
        g.endFill()
        y = initial ? this.rand() * this.heightPx : this.heightPx + 20
        vx = (this.rand() - 0.5) * 24 * scaleRatio
        vy = -(45 + this.rand() * 55) * scaleRatio
        break
      }
      case 'mist': {
        const r = (120 + this.rand() * 140) * scaleRatio
        g.beginFill(0xe8eefc, 0.08)
        g.drawEllipse(0, 0, r * 1.4, r * 0.6)
        g.endFill()
        y = this.heightPx * (0.5 + this.rand() * 0.45)
        vx = (20 + this.rand() * 35) * (this.rand() > 0.5 ? 1 : -1) * scaleRatio
        vy = 0
        break
      }
      case 'memories':
      case 'sparkle':
      default: {
        const r = (4 + this.rand() * 6) * scaleRatio
        const tint = this.preset === 'memories' ? 0xd9e4ff : 0xfff3b8
        g.beginFill(tint, 0.78)
        g.drawPolygon([0, -r, r * 0.4, -r * 0.4, r, 0, r * 0.4, r * 0.4, 0, r, -r * 0.4, r * 0.4, -r, 0, -r * 0.4, -r * 0.4])
        g.endFill()
        y = this.rand() * this.heightPx
        vx = (this.rand() - 0.5) * 20 * scaleRatio
        vy = -(12 + this.rand() * 24) * scaleRatio
        spin = (this.rand() - 0.5) * 1.2
        break
      }
    }

    g.position.set(x, y)
    this.addChild(g)
    this.items.push({
      g,
      x,
      y,
      vx,
      vy,
      phase: this.rand() * Math.PI * 2,
      spin,
      life: initial ? this.rand() * maxLife : 0,
      maxLife,
      scale: 0.7 + this.rand() * 0.6
    })
  }

  beginStop(): void {
    this.stopping = true
  }

  get isStopped(): boolean {
    return this.stopping && this.fadeAlpha <= 0
  }

  step(dtSec: number): void {
    const dt = Math.max(0, dtSec)
    this.elapsedSec += dt
    if (this.stopping) {
      this.fadeAlpha = Math.max(0, this.fadeAlpha - dt * 2.5)
      this.alpha = this.fadeAlpha
      if (this.fadeAlpha <= 0) return
    }

    for (const p of this.items) {
      p.life += dt
      if (this.preset === 'speedlines') {
        p.g.alpha = 0.25 + 0.55 * Math.abs(Math.sin(this.elapsedSec * 18 + p.phase))
        continue
      }
      const sway = this.preset === 'snow' || this.preset === 'sakura' ? Math.sin(this.elapsedSec * 2 + p.phase) * 26 * (this.widthPx / 1920) : 0
      p.x += (p.vx + sway) * dt
      p.y += p.vy * dt
      p.g.rotation += p.spin * dt
      p.g.position.set(p.x, p.y)

      if (this.preset === 'sparkle' || this.preset === 'memories') {
        p.g.alpha = 0.2 + 0.75 * Math.abs(Math.sin(this.elapsedSec * 2.4 + p.phase))
      }

      const outBottom = p.vy > 0 && p.y > this.heightPx + 60
      const outTop = p.vy < 0 && p.y < -60
      const outSide = p.x < -200 || p.x > this.widthPx + 200
      if (outBottom || outTop || outSide || p.life >= p.maxLife) {
        p.life = 0
        if (this.preset === 'rain' || this.preset === 'snow' || this.preset === 'sakura') {
          p.x = this.rand() * (this.widthPx + 180)
          p.y = -30
        } else if (this.preset === 'bubble') {
          p.x = this.rand() * this.widthPx
          p.y = this.heightPx + 30
        } else {
          p.x = this.rand() * this.widthPx
          p.y = this.rand() * this.heightPx
        }
        p.g.position.set(p.x, p.y)
      }
    }
  }

  override destroy(): void {
    for (const p of this.items) p.g.destroy()
    this.items.length = 0
    super.destroy({ children: true })
  }
}
