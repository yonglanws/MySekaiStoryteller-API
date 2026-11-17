import BaseSnippet from './BaseSnippet'
import { Cubism2InternalModel, Cubism4InternalModel } from 'pixi-live2d-display-advanced'
import AdvancedModel from '../model/AdvancedModel'
import type { CharacterAction } from '../../../common/types/Story'
import AnimationManager from '../managers/AnimationManager'
import { scheduleCharacterActions } from '../utils/CharacterActionScheduler'
import { sampleLipSync, textLipSequence, type LipSyncEnvelope } from '../utils/LipSyncEnvelope'
import {
  AUTO_NEXT_PAGE_DELAY_MS,
  AUTO_WAIT_AFTER_VOICE_MS,
  FRAME_MS,
  TALK_WINDOW_OPEN_CLOSE_MS,
  VOICE_END_LATENCY_MS
} from '../../../common/official/timing'
import {
  calculateTalkDurationMs,
  TALK_DISPLAY_MS_PER_CHAR,
  visibleTextLength
} from '../utils/TalkTiming'
import {
  areTrackedMotionsSettled,
  getLayoutRunningEndMs,
  getMotionSettledEndMs,
  nowMs,
  recordMotionSettledAt,
  type ExtendedModelLayer,
  type ExtendedUILayer
} from './stageTiming'

interface TalkData {
  type: 'Talk'
  wait?: boolean
  progressBehavior?: 'Now' | 'WaitFinished'
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
    closeWindowOnFinish?: boolean
    effect?: 'Normal' | 'Internal' | 'Overlap'
  }
}

export default class TalkSnippet extends BaseSnippet {
  private mouthCleanup: (() => void) | null = null
  private capturedPlannedDurationMs = 0
  private capturedLipSync: LipSyncEnvelope | null = null

  override async runSnippet(): Promise<void> {
    // 在前置栅栏后、delay 前同步捕获本句的规划时长和口型包络，
    // 防止紧随其后的 ProgressBehavior=Now 片段覆盖 App 上的状态。
    this.capturedPlannedDurationMs = this.app.lastSnippetActualDurationMs
    this.capturedLipSync = this.app.currentTalkLipSync
    await super.runSnippet()
  }

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

  private startMouthAnimation(
    model: AdvancedModel,
    contentLength: number,
    envelope: LipSyncEnvelope | null
  ): void {
    this.stopMouthAnimation()
    if (model.destroyed || model.actionSignal?.aborted) return
    const hasVoice =
      Boolean(envelope?.values.length) &&
      Number.isFinite(envelope?.durationMs) &&
      (envelope?.durationMs ?? 0) > 0
    // 无语音时官方用 LipLevels 文本口型；每半字推进一次，结束前两个字归零。
    const textLip = hasVoice ? null : textLipSequence(contentLength * 2)
    const startTime = this.app.currentTalkStartedAtMs
    const update = (): void => {
      if (!this.app.layerModel.isModelVisible(model.metadata.id)) return
      const elapsed = nowMs() - startTime
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

  private resolveTalkDurationMs(
    talkData: TalkData,
    snippetStartTime: number,
    windowOpenMs: number
  ): number {
    if (Number.isFinite(this.capturedPlannedDurationMs) && this.capturedPlannedDurationMs > 0) {
      return this.capturedPlannedDurationMs
    }
    const layoutRunningMs = Math.max(0, getLayoutRunningEndMs(this.app) - snippetStartTime)
    const existingSettleMs = Math.max(0, getMotionSettledEndMs(this.app) - snippetStartTime)
    return calculateTalkDurationMs(talkData.data.content, 0, talkData.data.ttsText, {
      hasVoice: Boolean(talkData.data.voice),
      windowOpenMs,
      layoutRunningMs,
      motionSettleMs: existingSettleMs
    })
  }

  protected async handleSnippet(): Promise<void> {
    const talkData = this.data as unknown as TalkData
    if (talkData.type !== 'Talk') return
    const isExporting = this.app.isExporting
    const signal = this.app.videoExportManager?.signal
    if (signal?.aborted) return

    const snippetStartTime = nowMs()
    this.app.currentTalkStartedAtMs = snippetStartTime
    const ui = this.app.layerUI as unknown as ExtendedUILayer
    const modelLayer = this.app.layerModel as unknown as ExtendedModelLayer
    const hasModel = talkData.data.modelId !== -1
    if (hasModel) {
      modelLayer.setLayoutDepth?.(talkData.data.modelId, 'Front')
    }

    const windowOpenMs = !ui.UITalkShowed ? TALK_WINDOW_OPEN_CLOSE_MS : 0
    const targetDurationMs = this.resolveTalkDurationMs(talkData, snippetStartTime, windowOpenMs)

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

    // 语音与 at=0 动作在 act 帧立即启动（不等 0.2s 窗口打开动画结束）。
    const sequence = scheduleCharacterActions(
      actions,
      targetDurationMs,
      {
        isVisible: (id) => this.app.layerModel.isModelVisible(id),
        apply: async (action, actionSignal) => {
          const model = this.app.getModelById(action.modelId)
          await model.applyCharacterAction(
            action,
            actionSignal,
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
        onError: (error) => this.logger.warn('Talk character action failed', error)
      },
      signal
    )

    let voiceEndedAtMs: number | null = null
    let voicePromise: Promise<void> | null = null
    if (
      hasModel &&
      talkData.data.voice &&
      !isExporting &&
      !this.app.ttsManager?.isTTSEnabled()
    ) {
      const model = this.app.getModelById(talkData.data.modelId)
      voicePromise = new Promise<void>((resolve) => {
        model.speak(this.app.getVoiceByName(talkData.data.voice), {
          volume: 0.5,
          onFinish: () => {
            voiceEndedAtMs = nowMs()
            resolve()
          }
        })
      })
    }

    const stopMouth = (): void => this.stopMouthAnimation()
    signal?.addEventListener('abort', stopMouth, { once: true })

    try {
      ui.resetTalkData?.()
      ui.setTalkData?.(talkData.data.speaker, talkData.data.content)
      if (hasModel) {
        this.startMouthAnimation(
          this.app.getModelById(talkData.data.modelId),
          visibleTextLength(talkData.data.content),
          this.capturedLipSync
        )
      }
      if (!ui.UITalkShowed) await ui.showTextBackground?.()
      await ui.startDisplayContent?.()
      const typingEndedAtMs = nowMs()

      if (voicePromise) {
        await voicePromise
        const voiceDoneMs = (voiceEndedAtMs ?? nowMs()) + VOICE_END_LATENCY_MS
        const remainingLatencyMs = Math.max(0, voiceDoneMs - nowMs())
        if (remainingLatencyMs > 0 && !signal?.aborted) {
          await AnimationManager.delay(remainingLatencyMs)
        }
        // 官方 AUTO Gate：等仍在执行的布局与身体动作收尾后再进入停留倒计时。
        while (
          !signal?.aborted &&
          (!areTrackedMotionsSettled(this.app, nowMs()) ||
            nowMs() < getLayoutRunningEndMs(this.app) - 0.5)
        ) {
          await AnimationManager.delay(FRAME_MS)
        }
        if (!signal?.aborted) {
          const tailMs =
            voiceDoneMs < typingEndedAtMs ? AUTO_NEXT_PAGE_DELAY_MS : AUTO_WAIT_AFTER_VOICE_MS
          await AnimationManager.delay(tailMs)
        }
      } else {
        // 导出模式（已把语音与门控合并进 targetDurationMs）或无语音交互播放：
        // 必须等到目标时长（含 2.0s / 0.5s 停留与门控），不能打字结束就立刻返回。
        if (!isExporting && Boolean(talkData.data.voice)) {
          while (
            !signal?.aborted &&
            (!areTrackedMotionsSettled(this.app, nowMs()) ||
              nowMs() < getLayoutRunningEndMs(this.app) - 0.5)
          ) {
            await AnimationManager.delay(FRAME_MS)
          }
        }
        const elapsedMs = nowMs() - snippetStartTime
        const remainingTargetMs = Math.max(0, targetDurationMs - elapsedMs)
        if (remainingTargetMs > 0 && !signal?.aborted) {
          await AnimationManager.delay(remainingTargetMs)
        }
        await sequence.finished
      }

      ui.closePlaceInfo?.()
      if (talkData.data.closeWindowOnFinish) {
        // 官方 WhenFinishCloseWindow：Talk 完成帧异步发起 0.2s 窗口关闭。
        void ui.hideTextBackground?.(TALK_WINDOW_OPEN_CLOSE_MS)
      }
    } finally {
      sequence.cancel()
      signal?.removeEventListener('abort', stopMouth)
      this.stopMouthAnimation()
    }
  }
}
