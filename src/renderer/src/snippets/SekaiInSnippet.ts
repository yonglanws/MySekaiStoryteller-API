import BaseSnippet from './BaseSnippet'
import { normalizeEffectDurationMs } from '../../../common/official/timing'
import type { ExtendedSpecialEffectLayer } from './stageTiming'

export default class SekaiInSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'SekaiIn') return

    const durationMs = normalizeEffectDurationMs(this.data.data.duration, 500)
    const fx = this.app.layerSpecialEffect as unknown as ExtendedSpecialEffectLayer
    await fx.playSekaiTransition?.('In', durationMs, this.data.data.variant)
  }
}
