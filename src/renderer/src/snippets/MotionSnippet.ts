import BaseSnippet from './BaseSnippet'
import type { CharacterAction } from '../../../common/types/Story'
import { scheduleCharacterActions } from '../utils/CharacterActionScheduler'

export default class MotionSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'Motion') return

    const data = this.data.data
    if (data.actions !== undefined) {
      const actions: CharacterAction[] = []
      if (data.motion || data.facial) {
        actions.push({
          at: 0,
          modelId: data.modelId,
          ...(data.motion ? { motion: data.motion } : {}),
          ...(data.facial ? { facial: data.facial } : {})
        })
      }
      actions.push(...data.actions)
      const sequence = scheduleCharacterActions(
        actions,
        (data.duration ?? 2) * 1000,
        {
          isVisible: (id) => this.app.layerModel.isModelVisible(id),
          apply: (action, signal) => {
            const model = this.app.getModelById(action.modelId)
            return model.applyCharacterAction(
              action,
              signal,
              () => this.app.layerModel.isModelVisible(action.modelId),
              this.snippetIndex
            )
          },
          onError: (error, action) => this.logger.warn('Character action failed', action, error)
        },
        this.app.videoExportManager?.signal
      )
      const anchorModel = this.app.getModelById(data.modelId)
      const cancel = (): void => sequence.cancel()
      anchorModel.actionSignal.addEventListener('abort', cancel, { once: true })
      if (anchorModel.actionSignal.aborted) cancel()
      try {
        await sequence.finished
      } finally {
        anchorModel.actionSignal.removeEventListener('abort', cancel)
        sequence.cancel()
      }
      return
    }

    // Preserve legacy scalar Motion behavior, including its wait/last-frame semantics.
    const model = this.app.getModelById(data.modelId)
    this.app.layerModel.addModelToLayer(model)

    model.internalModel?.parallelMotionManager[0]?.stopAllMotions()
    model.internalModel?.parallelMotionManager[1]?.stopAllMotions()

    await new Promise((resolve) => requestAnimationFrame(resolve))

    await model.applyAndWait(
      this.data.data.motion,
      this.data.data.facial,
      this.data.data.facialFirst,
      this.snippetIndex
    )

    await model.playMotionLastFrame(this.data.data.motion, this.data.data.facial)
  }
}
