import BaseSnippet from './BaseSnippet'
import { normalizeEffectDurationMs } from '../../../common/official/timing'
import type { ExtendedUILayer } from './stageTiming'

export default class ShakeWindowSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'ShakeWindow') return

    const durationSec =
      (this.data.data.duration !== undefined
        ? normalizeEffectDurationMs(this.data.data.duration)
        : 500) / 1000
    const ui = this.app.layerUI as unknown as ExtendedUILayer
    await ui.shakeWindow?.(durationSec, this.data.data.intensity)
  }
}
