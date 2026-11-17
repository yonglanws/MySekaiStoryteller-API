import BaseSnippet from './BaseSnippet'
import type { ExtendedModelLayer } from './stageTiming'

export default class LayoutDepthSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'LayoutDepth') return

    const layer = this.app.layerModel as unknown as ExtendedModelLayer
    layer.setLayoutDepth?.(this.data.data.modelId, this.data.data.depth)
  }
}
