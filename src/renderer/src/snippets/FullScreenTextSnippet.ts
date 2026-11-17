import BaseSnippet from './BaseSnippet'
import { normalizeEffectDurationMs } from '../../../common/official/timing'
import type { ExtendedUILayer } from './stageTiming'

export default class FullScreenTextSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'FullScreenText') return

    const durationMs =
      this.data.data.duration !== undefined
        ? normalizeEffectDurationMs(this.data.data.duration)
        : undefined
    const ui = this.app.layerUI as unknown as ExtendedUILayer
    await ui.showFullScreenText?.({
      text: this.data.data.text,
      durationMs,
      keepBars: this.data.data.keepBars
    })
  }
}
