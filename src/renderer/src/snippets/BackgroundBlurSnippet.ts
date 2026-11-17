import BaseSnippet from './BaseSnippet'
import { normalizeEffectDurationMs } from '../../../common/official/timing'
import type { ExtendedBackgroundLayer } from './stageTiming'

/** 官方 EffectType 44：背景模糊开关。 */
export default class BackgroundBlurSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'BackgroundBlur') return

    const active =
      this.data.data.mode !== undefined
        ? this.data.data.mode === 'In'
        : Boolean(this.data.data.enabled)
    const durationMs =
      this.data.data.duration !== undefined
        ? normalizeEffectDurationMs(this.data.data.duration)
        : undefined
    const bg = this.app.layerBackground as unknown as ExtendedBackgroundLayer
    if (typeof bg.setBackgroundBlur === 'function') {
      await bg.setBackgroundBlur(active, this.data.data.level, durationMs)
    } else {
      bg.setBlur?.(active)
    }
  }
}
