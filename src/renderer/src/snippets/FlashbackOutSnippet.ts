import BaseSnippet from './BaseSnippet'
import { FLASHBACK_DEFAULT_MS, normalizeEffectDurationMs } from '../../../common/official/timing'
import type { ExtendedEnvironmentLayer } from './stageTiming'

export default class FlashbackOutSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'FlashbackOut') return

    const durationMs = normalizeEffectDurationMs(this.data.data.duration, FLASHBACK_DEFAULT_MS)
    const env = this.app.layerEnvironment as unknown as ExtendedEnvironmentLayer
    if (typeof env.setFlashback === 'function') {
      await env.setFlashback(false, durationMs)
    } else {
      await env.flashbackOut?.(durationMs)
    }
  }
}
