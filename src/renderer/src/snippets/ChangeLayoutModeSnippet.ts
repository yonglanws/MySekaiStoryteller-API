import { LayoutModes } from '../../../common/types/Story'
import BaseSnippet from './BaseSnippet'
import type { ExtendedModelLayer } from './stageTiming'

export default class ChangeLayoutModeSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'ChangeLayoutMode') return

    const layer = this.app.layerModel as unknown as ExtendedModelLayer
    if (typeof layer.updateLayoutMode === 'function') {
      layer.updateLayoutMode(this.data.data.mode)
    } else {
      layer.layoutMode = LayoutModes[this.data.data.mode]
    }
  }
}
