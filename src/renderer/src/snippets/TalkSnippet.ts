import BaseSnippet from './BaseSnippet'
import AdvancedModel from '../model/AdvancedModel'
import type { CharacterAction } from '../../../common/types/Story'
import AnimationManager from '../managers/AnimationManager'
import { scheduleCharacterActions } from '../utils/CharacterActionScheduler'
import {
  sampleLipSync,
  textLipSequence,
  type LipSyncEnvelope,
  type TextLipSequence
} from '../utils/LipSyncEnvelope'
import {
  AUTO_NEXT_PAGE_DELAY_MS,
  AUTO_WAIT_AFTER_VOICE_MS,
  FRAME_MS,
  TALK_WINDOW_OPEN_CLOSE_MS,
  VOICE_END_LATENCY_MS
} from '../../../common/official/timing'
import { calculateTalkDurationMs, visibleTextLength } from '../utils/TalkTiming'
import { hasSpeakableSpeechText } from '../../../common/tts/speechText'
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
    /** 官方正文；打字机计时按它，content 只负责显示。 */
    typingText?: string
    modelId: number
    voice: string
    /** 官方语音时长（毫秒）；有值时按官方语音而不是 TTS 计时。 */
    voiceDurationMs?: number
    motion?: string
    facial?: string
    actions?: CharacterAction[]
    closeWindowOnFinish?: boolean
    effect?: 'Normal' | 'Internal' | 'Overlap'
  }
}

/**
 * `ParamMouthForm` 完全不写、由表情/动作拥有：对应 ournotes fallback 路径
 * （lipsync.js hasForm:false，policy 仅在 hasForm&&hasBase 时介入）。
 * 说话时向默认值中和 form 不是 ournotes 任何路径的行为（托管路径的
 * formOpenSupp 是元音 delta 的抑制因子，MSST 无元音数据）。
 */
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

  /**
   * 本句口型开度；`null` = 官方 `Lip::None` 已脱手（本帧不写参数）。
   *
   * 语音与文本都按剧情 60Hz 步进、按步号直接取值（不插值）：语音步号从 talk
   * 开始（= 语音起点）算，文本步号从 typing_start 算。平滑到 <0.001 的那一步
   * 之后脱手，`Talk` 结束时也脱手。
   */
  private speakerOpening(
    elapsed: number,
    envelope: LipSyncEnvelope | null,
    textLip: TextLipSequence | null,
    typingStartMs: number
  ): number | null {
    if (envelope && envelope.values.length > 0) {
      const step = Math.floor(elapsed / envelope.frameMs + 1e-9)
      if (step < 0 || step > envelope.releaseStep) return null
      return sampleLipSync(envelope, elapsed)
    }
    // 没有可显示的字符（纯标点）：官方文本口型在 typing_start 就收尾并脱手。
    if (!textLip || textLip.values.length === 0) return null
    const frame = Math.floor((elapsed - typingStartMs) / FRAME_MS + 1e-9)
    // typing_start 之前官方不写嘴；收尾平滑完（<0.001）后脱手。
    if (frame < 0 || frame > textLip.releaseStep) return null
    return textLip.values[frame] ?? 0
  }

  private startMouthAnimation(
    model: AdvancedModel,
    contentLength: number,
    envelope: LipSyncEnvelope | null,
    typingStartMs = 0
  ): void {
    this.stopMouthAnimation()
    if (model.destroyed || model.actionSignal?.aborted) return
    const hasVoice =
      Boolean(envelope?.values.length) &&
      Number.isFinite(envelope?.durationMs) &&
      (envelope?.durationMs ?? 0) > 0
    // 无语音时官方用 LipLevels 文本口型：每半字推进一次 LipLevels，收尾提前一个整字。
    // 本句只有一个说话人模型，slot = 0 of 1（first = slot + 1）。
    const textLip = hasVoice ? null : textLipSequence(contentLength * 2, { index: 0, total: 1 })
    let startTime = this.app.currentTalkStartedAtMs
    const update = (): void => {
      if (!this.app.layerModel.isModelVisible(model.metadata.id)) return
      const current = nowMs()
      if (current < startTime) startTime = current
      const elapsed = Math.max(0, current - startTime)
      const open = this.speakerOpening(elapsed, hasVoice ? envelope : null, textLip, typingStartMs)
      // 只有本次 talk 的 speaker 挂口型；同台听者不写 0，嘴由他们自己的动作/表情决定。
      if (open === null) model.releaseMouth()
      else model.setMouthOpening(open)
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
      // Talk 结束：官方 `Lip::None`，参数回到动作/表情/默认值。
      if (!model.destroyed) model.releaseMouth()
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
      voiceDurationMs: talkData.data.voiceDurationMs,
      typingText: talkData.data.typingText,
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

    let snippetStartTime = nowMs()
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
            this.snippetIndex,
            { talkDurationMs: targetDurationMs }
          )
          if (action.motion && !model.isMotionLooping?.(action.motion)) {
            const clipMs = model.getMotionDurationMs?.(action.motion) ?? 0
            if (clipMs > 0) {
              // 官方 `set_body` 在 action 的计划帧立即生效；`applyCharacterAction`
              // 的 await 可能跨几帧，不能用 nowMs()，否则 gate 会被推后。
              const actionStartMs =
                snippetStartTime + Math.max(0, Number(action.at) || 0) * targetDurationMs
              recordMotionSettledAt(this.app, action.modelId, actionStartMs + clipMs)
            }
          }
        },
        onError: (error) => this.logger.warn('Talk character action failed', error)
      },
      signal
    )

    let voiceEndedAtMs: number | null = null
    let voicePromise: Promise<void> | null = null
    if (hasModel && talkData.data.voice && !isExporting && !this.app.ttsManager?.isTTSEnabled()) {
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
        const mouthChars =
          this.capturedLipSync || hasSpeakableSpeechText(talkData.data.content)
            ? visibleTextLength(talkData.data.typingText || talkData.data.content)
            : 0
        this.startMouthAnimation(
          this.app.getModelById(talkData.data.modelId),
          mouthChars,
          this.capturedLipSync,
          windowOpenMs
        )
      }
      if (!ui.UITalkShowed) await ui.showTextBackground?.()
      await ui.startDisplayContent?.(
        visibleTextLength(talkData.data.typingText || talkData.data.content)
      )
      const typingEndedAtMs = nowMs()

      if (voicePromise) {
        await voicePromise
        const currentVoiceNow = nowMs()
        const rawVoiceEndedAt = voiceEndedAtMs ?? currentVoiceNow
        const clampedVoiceEndedAt =
          rawVoiceEndedAt <= currentVoiceNow ? rawVoiceEndedAt : currentVoiceNow
        const voiceDoneMs = clampedVoiceEndedAt + VOICE_END_LATENCY_MS
        const remainingLatencyMs = Math.max(0, voiceDoneMs - currentVoiceNow)
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
        const currentElapsedNow = nowMs()
        if (currentElapsedNow < snippetStartTime) snippetStartTime = currentElapsedNow
        const elapsedMs = Math.max(0, currentElapsedNow - snippetStartTime)
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
