import BaseSnippet from './BaseSnippet'

export default class FlashbackOutSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'FlashbackOut') return

    await this.app.layerEnvironment.flashbackOut(this.data.data.duration)
  }
}
