import BaseSnippet from './BaseSnippet'
import type { CharacterAction } from '../../../common/types/Story'
import { scheduleCharacterActions } from '../utils/CharacterActionScheduler'
import { nowMs, recordMotionSettledAt } from './stageTiming'

export default class MotionSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'Motion') return

    const motionStartMs = nowMs()
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
      const layerModel = this.app.layerModel as unknown as {
        isModelVisible: (id: number) => boolean
        isModelShown?: (id: number) => boolean
      }
      const isTargetShown = (id: number): boolean =>
        layerModel.isModelShown?.(id) ?? layerModel.isModelVisible(id)
      const sequence = scheduleCharacterActions(
        actions,
        (data.duration ?? 2) * 1000,
        {
          isVisible: isTargetShown,
          apply: async (action, signal) => {
            const model = this.app.getModelById(action.modelId)
            await model.applyCharacterAction(
              action,
              signal,
              () => isTargetShown(action.modelId),
              this.snippetIndex
            )
            if (action.motion && !model.isMotionLooping?.(action.motion)) {
              const clipMs = model.getMotionDurationMs?.(action.motion) ?? 0
              if (clipMs > 0) {
                // 计划帧 = act + at×窗口；await 的耗时不能算进 settle。
                const actionStartMs =
                  motionStartMs + Math.max(0, Number(action.at) || 0) * (data.duration ?? 2) * 1000
                recordMotionSettledAt(this.app, action.modelId, actionStartMs + clipMs)
              }
            }
          },
          onError: (error, action) => this.logger.warn('Character action failed', action, error)
        },
        this.app.videoExportManager?.signal
      )
      const anchorModel = data.modelId >= 0 ? this.app.getModelById(data.modelId) : null
      const cancel = (): void => sequence.cancel()
      anchorModel?.actionSignal.addEventListener('abort', cancel, { once: true })
      if (anchorModel?.actionSignal.aborted) cancel()
      try {
        await sequence.finished
      } finally {
        anchorModel?.actionSignal.removeEventListener('abort', cancel)
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
        recordMotionSettledAt(this.app, data.modelId, motionStartMs + clipMs)
      }
    }
  }
}
