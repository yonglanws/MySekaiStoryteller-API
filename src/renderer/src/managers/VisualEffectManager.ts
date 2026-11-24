import { Filter, Ticker } from 'pixi.js'
import AdvancedModel from '../model/AdvancedModel'
import { VisualEffect } from '../effects/VisualEffect'
import { HologramEffect } from '../effects/HologramEffect'
import TriangleParticleEffect from '../effects/TriangleParticleEffect'

interface EffectSet {
  effects: Record<string, VisualEffect>
}

class VFXGlobalTicker {
  private static instance: Ticker

  /**
   * 共用 Ticker.shared：预览时随它 60fps 运行；导出时 Ticker.shared 由帧泵
   * 每个 1/60 故事步显式 update，独立的 rAF ticker 会破坏固定步进与确定性。
   */
  static getInstance(): Ticker {
    if (!VFXGlobalTicker.instance) {
      VFXGlobalTicker.instance = Ticker.shared
    }
    return VFXGlobalTicker.instance
  }
}

export class VisualEffectManager {
  private effectSet: EffectSet = { effects: {} }
  private ticker: Ticker = VFXGlobalTicker.getInstance()
  private readonly effectFactories: Record<string, () => VisualEffect> = {}
  private readonly onTick = (delta: number): void => this.updateAll(delta)
  private destroyed = false

  constructor(private model: AdvancedModel) {
    this.effectFactories = {
      hologram: () => new HologramEffect(this.model, 3000, 4500),
      triangles: () => new TriangleParticleEffect(this.model)
    }

    this.ticker.add(this.onTick)
  }

  private updateAll(delta: number): void {
    if (this.destroyed) return
    for (const name in this.effectSet.effects) {
      this.effectSet.effects[name].update(delta)
    }
  }

  public createAll(): void {
    if (this.destroyed) return
    for (const name in this.effectFactories) {
      if (!this.effectSet.effects[name]) {
        this.effectSet.effects[name] = this.effectFactories[name]()
      }
    }
  }

  public getActiveFilters(): Filter[] {
    const active: Filter[] = []
    for (const name in this.effectSet.effects) {
      const effect = this.effectSet.effects[name]
      if (!effect.enabled) continue
      for (const filter of effect.parentFilters) {
        if (!active.includes(filter)) active.push(filter)
      }
    }
    return active
  }

  private syncModelFilters(): void {
    const syncable = this.model as unknown as { syncModelFilters?: () => void }
    if (typeof syncable.syncModelFilters === 'function') {
      syncable.syncModelFilters()
      return
    }
    const existing = this.model.filters ?? []
    const allEffectFilters = Object.values(this.effectSet.effects).flatMap(
      (item) => item.parentFilters
    )
    const base = existing.filter((f) => !allEffectFilters.includes(f))
    const next = [...base, ...this.getActiveFilters()]
    this.model.filters = next.length > 0 ? next : null
  }

  public applyEffect(effectName: string): void {
    if (this.destroyed) return
    const effect = this.effectSet.effects[effectName]
    if (!effect) return

    if (!effect.parent) this.model.addChild(effect)
    effect.enabled = true
    this.syncModelFilters()
  }

  public disable(effectName: string): void {
    const effect = this.effectSet.effects[effectName]
    if (!effect) return

    effect.enabled = false
    if (effect.parent) effect.parent.removeChild(effect)
    this.syncModelFilters()

    effect.clearAllParticles()
  }

  public getEffect(effectName: string): VisualEffect | undefined {
    return this.effectSet.effects[effectName]
  }

  public disableAll(): void {
    for (const name in this.effectSet.effects) {
      this.disable(name)
    }
  }

  public destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.ticker.remove(this.onTick)
    this.disableAll()
  }
}
