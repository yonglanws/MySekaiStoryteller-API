import BaseSnippet from './BaseSnippet'
import { SEPIA_DEFAULT_MS, normalizeEffectDurationMs } from '../../../common/official/timing'
import type { ExtendedEnvironmentLayer } from './stageTiming'

export default class SepiaInSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'SepiaIn') return

    const durationMs = normalizeEffectDurationMs(this.data.data.duration, SEPIA_DEFAULT_MS)
    const env = this.app.layerEnvironment as unknown as ExtendedEnvironmentLayer
    await env.setSepia?.(true, durationMs)
  }
}
