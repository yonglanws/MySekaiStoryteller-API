import BaseSnippet from './BaseSnippet'

/** 官方 EffectType 25/26：StopShakeScreen / StopShakeWindow。 */
export default class StopShakeSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'StopShake') return
    this.app.stopShake()
  }
}
