import BaseSnippet from './BaseSnippet'
import AnimationManager from '../managers/AnimationManager'
import { Cubism2InternalModel, Cubism4InternalModel } from 'pixi-live2d-display-advanced'
import AdvancedModel from '../model/AdvancedModel'
import type { CharacterAction } from '../../../common/types/Story'
import { scheduleCharacterActions } from '../utils/CharacterActionScheduler'
import { sampleLipSync } from '../utils/LipSyncEnvelope'
import { calculateTalkDurationMs } from '../utils/TalkTiming'

interface TalkData {
  type: 'Talk'
  wait: boolean
  delay: number
  data: {
    speaker: string
    content: string
    ttsText?: string
    modelId: number
    voice: string
    motion?: string
    facial?: string
    actions?: CharacterAction[]
  }
}

export default class TalkSnippet extends BaseSnippet {
  private mouthCleanup: (() => void) | null = null

  private setMouthParam(model: AdvancedModel, value: number): void {
    const internal = model.internalModel
    const ids = (internal.motionManager as unknown as { lipSyncIds?: string[] }).lipSyncIds
    const clamped = Math.max(0, Math.min(0.8, value))
    if (internal instanceof Cubism4InternalModel) {
      for (const id of ids?.length ? ids : ['ParamMouthOpenY']) {
        internal.coreModel.setParameterValueById(id, clamped)
      }
    } else if (internal instanceof Cubism2InternalModel) {
      for (const id of ids?.length ? ids : ['PARAM_MOUTH_OPEN_Y']) {
        internal.coreModel.setParamFloat(id, clamped)
      }
    }
  }

  private startMouthAnimation(model: AdvancedModel): void {
    this.stopMouthAnimation()
    const envelope = this.app.currentTalkLipSync
    if (
      !envelope?.values.length ||
      !Number.isFinite(envelope.durationMs) ||
      envelope.durationMs <= 0 ||
      model.destroyed ||
      model.actionSignal?.aborted
    )
      return
    const startTime = this.app.currentTalkStartedAtMs
    const update = (): void => {
      if (!this.app.layerModel.isModelVisible(model.metadata.id)) return
      const elapsed = performance.now() - startTime
      this.setMouthParam(model, sampleLipSync(envelope, elapsed))
    }
    // The dependency emits this event after physics but omits it from its declaration.
    const events = model.internalModel as unknown as {
      on(event: 'beforeModelUpdate', listener: () => void): void
      off(event: 'beforeModelUpdate', listener: () => void): void
    }
    events.on('beforeModelUpdate', update)
    update()
    const onDestroyed = (): void => this.stopMouthAnimation()
    this.mouthCleanup = () => {
      events.off('beforeModelUpdate', update)
      model.actionSignal?.removeEventListener('abort', onDestroyed)
      if (!model.destroyed) this.setMouthParam(model, 0)
    }
    model.actionSignal?.addEventListener('abort', onDestroyed, { once: true })
  }

  private stopMouthAnimation(): void {
    this.mouthCleanup?.()
    this.mouthCleanup = null
  }

  private resolveExportTalkDurationMs(): number {
    const timelineMs = this.app.lastSnippetActualDurationMs
    if (Number.isFinite(timelineMs) && timelineMs > 0) return timelineMs
    const talkData = this.data as unknown as TalkData
    return calculateTalkDurationMs(talkData.data.content, 0, talkData.data.ttsText)
  }

  protected async handleSnippet(): Promise<void> {
    const talkData = this.data as unknown as TalkData
    if (talkData.type !== 'Talk') return
    const isExporting = this.app.isExporting
    const signal = this.app.videoExportManager?.signal
    if (signal?.aborted) return
    const snippetStartTime = performance.now()
    this.app.currentTalkStartedAtMs = snippetStartTime
    const targetDurationMs = this.resolveExportTalkDurationMs()
    const hasModel = talkData.data.modelId !== -1
    const actions: CharacterAction[] = []
    if (hasModel && (talkData.data.motion || talkData.data.facial)) {
      actions.push({
        at: 0,
        modelId: talkData.data.modelId,
        motion: talkData.data.motion,
        facial: talkData.data.facial
      })
    }
    actions.push(...(talkData.data.actions ?? []))
    const sequence = scheduleCharacterActions(
      actions,
      targetDurationMs,
      {
        isVisible: (id) => this.app.layerModel.isModelVisible(id),
        apply: (action, actionSignal) =>
          this.app
            .getModelById(action.modelId)
            .applyCharacterAction(action, actionSignal, () =>
              this.app.layerModel.isModelVisible(action.modelId)
            ),
        onError: (error) => this.logger.warn('Talk character action failed', error)
      },
      signal
    )
    const stopMouth = (): void => this.stopMouthAnimation()
    signal?.addEventListener('abort', stopMouth, { once: true })

    try {
      this.app.layerUI.resetTalkData()
      this.app.layerUI.setTalkData(talkData.data.speaker, talkData.data.content)
      if (isExporting && hasModel) {
        this.startMouthAnimation(this.app.getModelById(talkData.data.modelId))
      }
      if (!this.app.layerUI.UITalkShowed) await this.app.layerUI.showTextBackground()
      const waits: Promise<unknown>[] = [this.app.layerUI.startDisplayContent()]
      if (hasModel && talkData.data.voice && !isExporting && !this.app.ttsManager?.isTTSEnabled()) {
        const model = this.app.getModelById(talkData.data.modelId)
        waits.push(
          new Promise<void>((resolve) => {
            model.speak(this.app.getVoiceByName(talkData.data.voice), {
              volume: 0.5,
              onFinish: resolve
            })
          })
        )
      }
      await Promise.all(waits)
      if (isExporting) {
        await sequence.finished
      } else {
        await AnimationManager.delay(Math.max(800, talkData.data.content.length * 30))
      }
    } finally {
      sequence.cancel()
      signal?.removeEventListener('abort', stopMouth)
      this.stopMouthAnimation()
    }
  }
}
