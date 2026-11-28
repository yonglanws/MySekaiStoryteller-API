import BaseSnippet from './BaseSnippet'
import { normalizeEffectDurationMs } from '../../../common/official/timing'
import type { ExtendedBackgroundLayer, ExtendedModelLayer } from './stageTiming'

export default class ChangeBackgroundImageSnippet extends BaseSnippet {
  private resolveBackgroundTexture(requestedId: number): unknown {
    try {
      const exact = this.app.getTextureById(requestedId)
      if (exact) return exact
    } catch (error) {
      this.logger.warn(
        `Background texture id=${String(requestedId)} unavailable; trying fallback`,
        error
      )
    }

    const candidateIds: number[] = []
    if (requestedId !== 1) candidateIds.push(1)
    const storyImages = this.app.storyManager?.storyData?.images
    if (Array.isArray(storyImages)) {
      for (const entry of storyImages) {
        if (typeof entry?.id === 'number' && !candidateIds.includes(entry.id)) {
          candidateIds.push(entry.id)
        }
      }
    }

    for (const candidateId of candidateIds) {
      if (candidateId === requestedId) continue
      try {
        const fallback = this.app.getTextureById(candidateId)
        if (fallback) {
          this.logger.warn(
            `Recovered ChangeBackgroundImage id=${String(requestedId)} using fallback texture id=${candidateId}`
          )
          return fallback
        }
      } catch {
        // continue trying remaining preloaded textures
      }
    }
    return null
  }

  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'ChangeBackgroundImage') return

    const requestedId = this.data.data.imageId
    const img = this.resolveBackgroundTexture(requestedId)
    if (!img) {
      this.logger.warn(
        `Skipping ChangeBackgroundImage for id=${String(requestedId)}: no usable preloaded texture`
      )
      return
    }

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
