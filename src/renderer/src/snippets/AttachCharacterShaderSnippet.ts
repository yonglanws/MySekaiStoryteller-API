import BaseSnippet from './BaseSnippet'
import type { ExtendedModelLayer } from './stageTiming'

export default class AttachCharacterShaderSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'AttachCharacterShader') return

    const layer = this.app.layerModel as unknown as ExtendedModelLayer
    layer.setCharacterShader?.(this.data.data.modelId, this.data.data.shader, this.data.data.level)
  }
}
