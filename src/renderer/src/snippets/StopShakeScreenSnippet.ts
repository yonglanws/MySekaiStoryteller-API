import BaseSnippet from './BaseSnippet'
import type { ExtendedApp } from './stageTiming'

export default class StopShakeScreenSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'StopShakeScreen') return

    const app = this.app as unknown as ExtendedApp
    if (typeof app.stopShakeScreen === 'function') {
      app.stopShakeScreen()
    } else {
      app.stopShake?.()
    }
  }
}
