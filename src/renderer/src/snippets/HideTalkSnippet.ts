import BaseSnippet from './BaseSnippet'
import type { ExtendedUILayer } from './stageTiming'

export default class HideTalkSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'HideTalk') return

    await (this.app.layerUI as unknown as ExtendedUILayer).hideTextBackground?.(0)
  }
}
