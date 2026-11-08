import BaseSnippet from './BaseSnippet'

export default class ShakeScreenSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'ShakeScreen') return

    await this.app.shakeScreen(this.data.data.duration, this.data.data.amplitude)
  }
}
