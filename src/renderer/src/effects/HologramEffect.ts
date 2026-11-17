import { Graphics } from 'pixi.js'
import AdvancedModel from '../model/AdvancedModel'
import { loadInappTexture } from './InappTextures'
import { Live2DHologramShaderFilter } from './OfficialFilters'
import { VisualEffect } from './VisualEffect'

/**
 * 全息投影模型特效：通过虚拟时钟步进 `Live2DHologramShaderFilter` 扫描线与闪烁，
 * 不使用任何独立 `requestAnimationFrame`，以保证 fast 导出的严格帧确定性。
 */
export class HologramEffect extends VisualEffect {
  private readonly shaderFilter: Live2DHologramShaderFilter
  private readonly pedestal: Graphics
  private elapsedSec = 0

  constructor(model: AdvancedModel, width: number, height: number, monitor = false) {
    super(model)

    this.shaderFilter = new Live2DHologramShaderFilter({ monitor })
    this.pedestal = new Graphics()
    this.drawPedestal(width, height, 0)
    this.addChild(this.pedestal)

    const currentFilters = Array.isArray(this.model.filters) ? [...this.model.filters] : []
    if (!currentFilters.includes(this.shaderFilter)) {
      currentFilters.push(this.shaderFilter)
      this.model.filters = currentFilters
    }

    void loadInappTexture('player/loose/Texture2D/holo.png').then((tex) => {
      if (!this.destroyed && tex && tex.valid && tex.baseTexture?.valid) {
        this.shaderFilter.setHoloTexture(tex)
      }
    })
  }

  private drawPedestal(width: number, height: number, phase: number): void {
    const g = this.pedestal
    g.clear()
    const radiusX = Math.max(120, Math.min(360, width * 0.14))
    const radiusY = radiusX * 0.22
    const y = Math.min(height * 0.18, 120)
    const pulse = 0.28 + 0.1 * Math.sin(phase * 3.1)

    g.beginFill(0x66f0ff, pulse * 0.35)
    g.drawEllipse(0, y, radiusX, radiusY)
    g.endFill()

    g.lineStyle(2.5, 0x9cf7ff, pulse * 0.85)
    g.drawEllipse(0, y, radiusX * 0.92, radiusY * 0.92)
    g.lineStyle(1.5, 0xffffff, pulse * 0.6)
    g.drawEllipse(0, y, radiusX * 0.62, radiusY * 0.62)
  }

  update(delta: number): void {
    if (this.destroyed) return
    const dtSec = Math.max(0, delta) / 60
    this.elapsedSec += dtSec
    this.shaderFilter.step(dtSec)
    this.drawPedestal(3000, 4500, this.elapsedSec)
  }

  destroyEffect(): void {
    this.destroy()
  }

  destroy(): void {
    if (this.model && !this.model.destroyed && Array.isArray(this.model.filters)) {
      const remaining = this.model.filters.filter((f) => f !== this.shaderFilter)
      this.model.filters = remaining.length > 0 ? remaining : null
    }
    this.shaderFilter.destroy()
    super.destroy({ children: true })
  }
}
