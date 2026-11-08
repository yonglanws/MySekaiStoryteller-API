import BaseSnippet from './BaseSnippet'

export default class CameraMoveSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'CameraMove') return

    await this.app.cameraMove(this.data.data.x, this.data.data.y, this.data.data.duration)
  }
}
