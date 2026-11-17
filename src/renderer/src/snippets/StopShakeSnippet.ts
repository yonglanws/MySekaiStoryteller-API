import BaseSnippet from './BaseSnippet'
import type { ExtendedApp, ExtendedUILayer } from './stageTiming'

/** 官方 EffectType 25/26：StopShakeScreen / StopShakeWindow。 */
export default class StopShakeSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'StopShake') return

    const app = this.app as unknown as ExtendedApp
    if (typeof app.stopShakeScreen === 'function') {
      app.stopShakeScreen()
    } else {
      app.stopShake?.()
    }
    const ui = this.app.layerUI as unknown as ExtendedUILayer | undefined
    ui?.stopShakeWindow?.()
  }
}
