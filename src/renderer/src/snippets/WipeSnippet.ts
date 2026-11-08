import BaseSnippet from './BaseSnippet'

export default class WipeSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'Wipe') return

    await this.app.layerSpecialEffect.wipe(
      this.data.data.mode,
      this.data.data.direction,
      this.data.data.duration
    )
  }
}
