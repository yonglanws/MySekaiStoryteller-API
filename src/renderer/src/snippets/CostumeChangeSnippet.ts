import BaseSnippet from './BaseSnippet'
import type { ExtendedModelLayer } from './stageTiming'

export default class CostumeChangeSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'CostumeChange') return

    const layer = this.app.layerModel as unknown as ExtendedModelLayer
    await layer.changeCostume?.(this.data.data.modelId, this.data.data.costume)
  }
}
