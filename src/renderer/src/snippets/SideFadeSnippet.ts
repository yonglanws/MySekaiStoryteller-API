import BaseSnippet from './BaseSnippet'
import { normalizeEffectDurationMs } from '../../../common/official/timing'
import type { ExtendedSpecialEffectLayer } from './stageTiming'

/** 官方 EffectType 29~36：ScenarioSideFadePlayer。 */
export default class SideFadeSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'SideFade') return

    const rawDir = this.data.data.direction ?? this.data.data.edge ?? 'left'
    const direction = (rawDir.charAt(0).toUpperCase() + rawDir.slice(1).toLowerCase()) as
      | 'Left'
      | 'Right'
      | 'Top'
      | 'Bottom'
    const rawMode = this.data.data.mode
    const mode = (rawMode.charAt(0).toUpperCase() + rawMode.slice(1).toLowerCase()) as 'In' | 'Out'
    const durationMs = normalizeEffectDurationMs(this.data.data.duration)

    const fx = this.app.layerSpecialEffect as unknown as ExtendedSpecialEffectLayer
    if (typeof fx.playSideFade === 'function') {
      await fx.playSideFade(mode, direction, durationMs)
    } else if (typeof fx.sideFade === 'function') {
      await fx.sideFade(
        direction.toLowerCase() as 'left' | 'right' | 'top' | 'bottom',
        mode.toLowerCase() as 'in' | 'out',
        durationMs
      )
    }
  }
}
