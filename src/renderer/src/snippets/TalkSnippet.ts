import BaseSnippet from './BaseSnippet'
import { Cubism2InternalModel, Cubism4InternalModel } from 'pixi-live2d-display-advanced'
import AdvancedModel from '../model/AdvancedModel'
import type { CharacterAction } from '../../../common/types/Story'
import { scheduleCharacterActions } from '../utils/CharacterActionScheduler'
import { sampleLipSync, textLipSequence } from '../utils/LipSyncEnvelope'
import {
  calculateTalkDurationMs,
  TALK_DISPLAY_MS_PER_CHAR,
  visibleTextLength
} from '../utils/TalkTiming'

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
    const clamped = Math.max(0, Math.min(1, value))
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

  private startMouthAnimation(model: AdvancedModel, contentLength: number): void {
    this.stopMouthAnimation()
    if (model.destroyed || model.actionSignal?.aborted) return
    const envelope = this.app.currentTalkLipSync
    const hasVoice =
      Boolean(envelope?.values.length) &&
      Number.isFinite(envelope?.durationMs) &&
      (envelope?.durationMs ?? 0) > 0
    // 无语音时官方用 LipLevels 文本口型；每半字推进一次，结束前两个字归零。
    const textLip = hasVoice ? null : textLipSequence(contentLength * 2)
    const startTime = this.app.currentTalkStartedAtMs
    const update = (): void => {
      if (!this.app.layerModel.isModelVisible(model.metadata.id)) return
      const elapsed = performance.now() - startTime
      if (hasVoice) {
        this.setMouthParam(model, sampleLipSync(envelope!, elapsed))
        return
      }
      if (!textLip || textLip.length === 0) {
        this.setMouthParam(model, 0)
        return
      }
      const halfMs = TALK_DISPLAY_MS_PER_CHAR / 2
      const index = Math.floor(elapsed / halfMs)
      const closing = index >= textLip.length - 2
      this.setMouthParam(model, closing ? 0 : textLip[Math.min(index, textLip.length - 1)])
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
            .applyCharacterAction(
              action,
              actionSignal,
              () => this.app.layerModel.isModelVisible(action.modelId),
              this.snippetIndex
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
      if (hasModel) {
        this.startMouthAnimation(
          this.app.getModelById(talkData.data.modelId),
          visibleTextLength(talkData.data.content)
        )
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
      // 官方 AUTO 模式：打字结束、语音结束、动作收尾之后才进入下一句。
      // sequence 的时长已经由 lastSnippetActualDurationMs 按同一套官方时序给出。
      await sequence.finished
    } finally {
      sequence.cancel()
      signal?.removeEventListener('abort', stopMouth)
      this.stopMouthAnimation()
    }
  }
}
