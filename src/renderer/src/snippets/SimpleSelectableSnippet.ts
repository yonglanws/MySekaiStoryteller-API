import BaseSnippet from './BaseSnippet'
import type { ExtendedUILayer } from './stageTiming'

export default class SimpleSelectableSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'SimpleSelectable') return

    const ui = this.app.layerUI as unknown as ExtendedUILayer
    await ui.showChoiceDialog?.(this.data.data.choices, this.data.data.pickedIndex)
  }
}
