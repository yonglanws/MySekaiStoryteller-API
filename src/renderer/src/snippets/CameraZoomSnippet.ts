import BaseSnippet from './BaseSnippet'
import { normalizeEffectDurationMs } from '../../../common/official/timing'
import type { ExtendedApp } from './stageTiming'

export default class CameraZoomSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'CameraZoom') return

    const durationMs = normalizeEffectDurationMs(this.data.data.duration)
    await (this.app as unknown as ExtendedApp).cameraZoom?.(
      this.data.data.scale,
      durationMs,
      this.data.data.ease
    )
  }
}
