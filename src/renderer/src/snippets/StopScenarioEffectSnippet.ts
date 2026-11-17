import BaseSnippet from './BaseSnippet'
import { normalizeEffectDurationMs } from '../../../common/official/timing'
import type { ExtendedSpecialEffectLayer } from './stageTiming'

export default class StopScenarioEffectSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'StopScenarioEffect') return

    const delayMs =
      this.data.data.duration !== undefined
        ? normalizeEffectDurationMs(this.data.data.duration)
        : undefined
    const fx = this.app.layerSpecialEffect as unknown as ExtendedSpecialEffectLayer
    await fx.stopScenarioEffect?.(this.data.data.effectName, delayMs)
  }
}
