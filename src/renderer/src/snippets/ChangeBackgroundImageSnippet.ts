import BaseSnippet from './BaseSnippet'
import { normalizeEffectDurationMs } from '../../../common/official/timing'
import type { ExtendedBackgroundLayer, ExtendedModelLayer } from './stageTiming'

export default class ChangeBackgroundImageSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'ChangeBackgroundImage') return

    const img = this.app.getTextureById(this.data.data.imageId)
    const durationMs =
      this.data.data.duration !== undefined ? normalizeEffectDurationMs(this.data.data.duration) : 0

    const bg = this.app.layerBackground as unknown as ExtendedBackgroundLayer
    if (typeof bg.changeBackground === 'function') {
      const task = bg.changeBackground(img, durationMs)
      if (task && typeof (task as Promise<void>).catch === 'function') {
        void (task as Promise<void>).catch((error) =>
          this.logger.warn('Background change failed', error)
        )
      }
    } else {
      bg.setBackground?.(img)
    }

    const modelLayer = this.app.layerModel as unknown as ExtendedModelLayer | undefined
    if (typeof modelLayer?.resetAmbientColor === 'function') {
      modelLayer.resetAmbientColor()
    } else {
      modelLayer?.setAmbientColor?.('normal')
    }
  }
}
