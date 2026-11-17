import BaseSnippet from './BaseSnippet'
import { FLASHBACK_DEFAULT_MS, normalizeEffectDurationMs } from '../../../common/official/timing'
import type { ExtendedEnvironmentLayer } from './stageTiming'

export default class FlashbackInSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'FlashbackIn') return

    const durationMs = normalizeEffectDurationMs(this.data.data.duration, FLASHBACK_DEFAULT_MS)
    const env = this.app.layerEnvironment as unknown as ExtendedEnvironmentLayer
    if (typeof env.setFlashback === 'function') {
      await env.setFlashback(true, durationMs)
    } else {
      await env.flashbackIn?.(durationMs, this.data.data.alpha ?? 0.3)
    }
  }
}
