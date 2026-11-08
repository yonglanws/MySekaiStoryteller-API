import BaseSnippet from './BaseSnippet'

export default class CameraZoomSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'CameraZoom') return

    await this.app.cameraZoom(this.data.data.scale, this.data.data.duration)
  }
}
