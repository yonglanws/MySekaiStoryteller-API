import BaseSnippet from './BaseSnippet'

/** 官方 EffectType 29~36：ScenarioSideFadePlayer。 */
export default class SideFadeSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'SideFade') return
    await this.app.layerSpecialEffect.sideFade(
      this.data.data.edge,
      this.data.data.mode,
      this.data.data.duration
    )
  }
}
