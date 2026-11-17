import BaseSnippet from './BaseSnippet'
import { normalizeEffectDurationMs } from '../../../common/official/timing'
import type { ExtendedApp } from './stageTiming'

export default class DollyZoomSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'DollyZoom') return

    const durationMs = normalizeEffectDurationMs(this.data.data.duration)
    await (this.app as unknown as ExtendedApp).dollyZoom?.(
      this.data.data.zoom,
      durationMs,
      this.data.data.ease
    )
  }
}
