import BaseSnippet from './BaseSnippet'

/** 官方 EffectType 44：背景模糊开关。 */
export default class BackgroundBlurSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'BackgroundBlur') return
    this.app.layerBackground.setBlur(this.data.data.enabled)
  }
}
