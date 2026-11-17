import BaseSnippet from './BaseSnippet'
import type { CharacterAction } from '../../../common/types/Story'
import { scheduleCharacterActions } from '../utils/CharacterActionScheduler'
import { nowMs, recordMotionSettledAt } from './stageTiming'

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
          apply: async (action, signal) => {
            const model = this.app.getModelById(action.modelId)
            await model.applyCharacterAction(
              action,
              signal,
              () => this.app.layerModel.isModelVisible(action.modelId),
              this.snippetIndex
            )
            if (action.motion && !model.isMotionLooping?.(action.motion)) {
              const clipMs = model.getMotionDurationMs?.(action.motion) ?? 0
              if (clipMs > 0) {
                recordMotionSettledAt(this.app, action.modelId, nowMs() + clipMs)
              }
            }
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

    // 官方 Action=4（CharacterMotion）：立即触发动作，0 帧阻塞片段本身，
    // 并在 ModelLayer 登记身体动作收尾时刻供 Talk Gate 检查。
    const model = this.app.getModelById(data.modelId)
    await model.startMotions(data.motion || undefined, data.facial || undefined, data.facialFirst, {
      traceSnippetIndex: this.snippetIndex
    })
    if (data.motion && !model.isMotionLooping?.(data.motion)) {
      const clipMs = model.getMotionDurationMs?.(data.motion) ?? 0
      if (clipMs > 0) {
        recordMotionSettledAt(this.app, data.modelId, nowMs() + clipMs)
      }
    }
  }
}
