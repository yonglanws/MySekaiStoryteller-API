import BaseSnippet from './BaseSnippet'
import { normalizeEffectDurationMs } from '../../../common/official/timing'
import type { ExtendedApp } from './stageTiming'

export default class ShakeScreenSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'ShakeScreen') return

    const durationSec = normalizeEffectDurationMs(this.data.data.duration) / 1000
    const intensity =
      this.data.data.intensity ??
      (this.data.data.amplitude !== undefined ? this.data.data.amplitude * 1000 : undefined)
    await (this.app as unknown as ExtendedApp).shakeScreen?.(durationSec, intensity)
  }
}
