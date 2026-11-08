import BaseSnippet from './BaseSnippet'

export default class AmbientColorSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'AmbientColor') return

    this.app.layerModel.setAmbientColor(this.data.data.mode)
  }
}
