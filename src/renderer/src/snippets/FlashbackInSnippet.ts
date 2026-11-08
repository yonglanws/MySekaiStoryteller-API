import BaseSnippet from './BaseSnippet'

export default class FlashbackInSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'FlashbackIn') return

    await this.app.layerEnvironment.flashbackIn(this.data.data.duration, this.data.data.alpha)
  }
}
