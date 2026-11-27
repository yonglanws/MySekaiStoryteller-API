import BaseSnippet from './BaseSnippet'
import AnimationManager from '../managers/AnimationManager'
import type { ExtendedSpecialEffectLayer } from './stageTiming'

export default class MovieSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'Movie') return

    const rawDuration = this.data.data.duration
    const durationMs =
      rawDuration !== undefined ? (rawDuration > 300 ? rawDuration : rawDuration * 1000) : undefined
    const fx = this.app.layerSpecialEffect as unknown as ExtendedSpecialEffectLayer
    if (typeof fx.playMovie === 'function') {
      await fx.playMovie(this.data.data.file, durationMs)
    } else if (durationMs && durationMs > 0) {
      await AnimationManager.delay(durationMs)
    }
  }
}
