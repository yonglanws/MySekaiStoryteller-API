import BaseSnippet from './BaseSnippet'
import { normalizeEffectDurationMs } from '../../../common/official/timing'
import type { ExtendedSpecialEffectLayer } from './stageTiming'

export default class BlurInSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'BlurIn') return

    const durationMs = normalizeEffectDurationMs(this.data.data.duration, 300)
    const fx = this.app.layerSpecialEffect as unknown as ExtendedSpecialEffectLayer
    await fx.setCameraBlur?.(true, durationMs)
  }
}
