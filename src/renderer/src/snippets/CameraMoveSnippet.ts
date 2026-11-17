import BaseSnippet from './BaseSnippet'
import { normalizeEffectDurationMs } from '../../../common/official/timing'
import type { ExtendedApp } from './stageTiming'

export default class CameraMoveSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'CameraMove') return

    const durationMs = normalizeEffectDurationMs(this.data.data.duration)
    await (this.app as unknown as ExtendedApp).cameraMove?.(
      this.data.data.x,
      this.data.data.y,
      durationMs,
      this.data.data.ease
    )
  }
}
