import BaseSnippet from './BaseSnippet'
import type { ExtendedModelLayer } from './stageTiming'

export default class CharacterShakeSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'CharacterShake') return

    const layer = this.app.layerModel as unknown as ExtendedModelLayer
    await layer.shakeCharacter?.(this.data.data.modelId, this.data.data.axis)
  }
}
