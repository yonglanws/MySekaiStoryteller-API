import BaseSnippet from './BaseSnippet'
import type { ExtendedUILayer } from './stageTiming'

export default class StopShakeWindowSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'StopShakeWindow') return

    const ui = this.app.layerUI as unknown as ExtendedUILayer
    ui.stopShakeWindow?.()
  }
}
