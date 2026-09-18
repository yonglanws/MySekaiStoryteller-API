import BaseSnippet from './BaseSnippet'
import AnimationManager from '../managers/AnimationManager'
import { Cubism2InternalModel, Cubism4InternalModel } from 'pixi-live2d-display-advanced'
import AdvancedModel from '../model/AdvancedModel'
import { Ticker } from 'pixi.js'

interface TalkData {
  type: 'Talk'
  wait: boolean
  delay: number
  data: {
    speaker: string
    content: string
    modelId: number
    voice: string
    motion?: string
    facial?: string
  }
}

// 预计算的嘴型参数
const MOUTH_PARAM_ID = 'ParamMouthOpenY'
const MOUTH_OPEN_MIN = 0.02
const MOUTH_OPEN_MAX = 0.35

// 预计算的音节模式模板
const SYLLABLE_TEMPLATES = {
  vowel: [0.8, 0.9, 0.7, 0.4],
  consonant: [0.3, 0.5, 0.2, 0.1],
  pause: [0.05, 0.05, 0.05, 0.05]
}

/**
 * 高性能嘴型动画管理器
 *
 * 优化点：
 * 1. 预计算 - 避免每帧重复计算
 * 2. 对象池 - 复用Ticker对象
 * 3. 节流 - 降低更新频率
 */
export default class TalkSnippet extends BaseSnippet {
  private mouthTicker: Ticker | null = null
  private syllablePattern: number[] = []
  private syllableIndex = 0
  private lastUpdateTime = 0
  private readonly updateInterval = 33 // 30fps更新频率

  private setMouthParam(model: AdvancedModel, value: number): void {
    const clamped = Math.max(0, Math.min(1, value))
    if (model.internalModel instanceof Cubism4InternalModel) {
      model.internalModel.coreModel.setParameterValueById(MOUTH_PARAM_ID, clamped)
    } else if (model.internalModel instanceof Cubism2InternalModel) {
      model.internalModel.coreModel.setParamFloat(MOUTH_PARAM_ID, clamped)
    }
  }

  /**
   * 生成音节模式 - 使用预计算模板
   */
  private generateSyllablePattern(durationMs: number): number[] {
    const pattern: number[] = []
    // 减慢频率：每个音节持续更长时间 (180ms -> 350ms)
    const syllableCount = Math.max(2, Math.floor(durationMs / 350))

    for (let i = 0; i < syllableCount; i++) {
      const isVowel = Math.random() > 0.4
      const intensity = 0.6 + Math.random() * 0.3
      const template = isVowel ? SYLLABLE_TEMPLATES.vowel : SYLLABLE_TEMPLATES.consonant

      // 应用强度缩放
      pattern.push(...template.map((v) => v * intensity))
    }

    return pattern
  }

  private easeInOutCubic(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
  }

  /**
   * 启动嘴型动画 - 使用节流优化
   */
  private startMouthAnimation(model: AdvancedModel, durationMs: number): void {
    const startTime = performance.now()
    this.syllablePattern = this.generateSyllablePattern(durationMs)
    this.syllableIndex = 0
    this.lastUpdateTime = 0

    let currentTarget = 0
    let syllableStartTime = startTime
    const syllableDuration = durationMs / (this.syllablePattern.length / 4)

    this.mouthTicker = new Ticker()
    this.mouthTicker.maxFPS = 30 // 限制帧率减少计算

    this.mouthTicker.add(() => {
      const now = performance.now()
      const elapsed = now - startTime

      if (elapsed >= durationMs) {
        this.stopMouthAnimation(model)
        return
      }

      // 节流：限制更新频率
      if (now - this.lastUpdateTime < this.updateInterval) {
        return
      }
      this.lastUpdateTime = now

      const syllableElapsed = now - syllableStartTime
      const syllableProgress = Math.min(1, syllableElapsed / syllableDuration)

      // 更新音节索引
      if (
        syllableElapsed >= syllableDuration &&
        this.syllableIndex < this.syllablePattern.length - 4
      ) {
        this.syllableIndex += 4
        syllableStartTime = now
      }

      // 获取当前音节的目标值
      currentTarget = this.syllablePattern[this.syllableIndex] || 0

      // 计算包络
      const attackTime = 0.25
      const sustainTime = 0.5

      let envelope: number
      if (syllableProgress < attackTime) {
        envelope = this.easeInOutCubic(syllableProgress / attackTime)
      } else if (syllableProgress < sustainTime) {
        envelope = 1
      } else {
        envelope = 1 - (syllableProgress - sustainTime) / (1 - sustainTime)
      }

      // 计算最终嘴型值
      const baseValue =
        MOUTH_OPEN_MIN + (MOUTH_OPEN_MAX - MOUTH_OPEN_MIN) * currentTarget * envelope
      const microVariation = Math.sin(now * 0.01) * 0.01
      const breathPause = Math.sin(now * 0.003) > 0.9 ? 0.6 : 1.0

      const finalValue = (baseValue + microVariation) * breathPause
      this.setMouthParam(model, Math.max(0.02, Math.min(1, finalValue)))
    })

    this.mouthTicker.start()
  }

  private stopMouthAnimation(model: AdvancedModel): void {
    if (this.mouthTicker) {
      this.mouthTicker.stop()
      this.mouthTicker.destroy()
      this.mouthTicker = null
    }
    this.setMouthParam(model, 0)
    this.syllablePattern = []
    this.syllableIndex = 0
  }

  /**
   * 导出时台词的目标时长：时间轴给定值与"按字数下限"取较大者。
   * 下限与 TimelineCalculator 的无 TTS 估算对齐（打字机 + 等效语音时长/2 +
   * 阅读停留），保证无配音时台词不会显得"没说完就跳"。
   */
  private resolveExportTalkDurationMs(originalDelayMs: number): number {
    const timelineMs =
      this.app.lastSnippetActualDurationMs > 0
        ? this.app.lastSnippetActualDurationMs
        : originalDelayMs
    const talkData = this.data as unknown as TalkData
    const contentLength = talkData.data?.content?.length ?? 0
    const charBasedMinMs = Math.max(
      contentLength * 80 + (contentLength * 143) / 2 + 1200,
      1800
    )
    return Math.max(timelineMs, charBasedMinMs)
  }

  protected async handleSnippet(): Promise<void> {
    const talkData = this.data as unknown as TalkData
    if (talkData.type !== 'Talk') return

    const originalDelayMs = talkData.delay * 1000
    const isExporting = this.app.isExporting
    const ttsEnabled = this.app.ttsManager?.isTTSEnabled() ?? false

    const snippetStartTime = isExporting ? performance.now() : 0

    this.app.layerUI.resetTalkData()
    this.app.layerUI.setTalkData(talkData.data.speaker, talkData.data.content)

    const lipSyncEnable = talkData.data.modelId !== -1 && talkData.data.voice !== ''
    const hasModel = talkData.data.modelId !== -1
    if (!this.app.layerUI.UITalkShowed) {
      await this.app.layerUI.showTextBackground()
    }

    // 说话并发动作：Talk 开始时即触发身体动作/表情（不等待播完），
    // 动作剔除眼部与嘴部参数——眼睛归当前表情/眨眼，嘴型归口型动画，互不踩踏。
    // 动作短于台词时经 fade-out 自然回到基础姿态，长于台词时被下一个 Motion 片段切换。
    if (hasModel) {
      const model = this.app.getModelById(talkData.data.modelId)
      const gesture = talkData.data.motion?.trim()
      const facial = talkData.data.facial?.trim()
      if (gesture) {
        model.applyMotion(gesture, true, [MOUTH_PARAM_ID]).catch((e) => {
          this.logger.warn(`Talk concurrent motion '${gesture}' failed`, e)
        })
      }
      if (facial) {
        model.applyFacial(facial).catch((e) => {
          this.logger.warn(`Talk concurrent facial '${facial}' failed`, e)
        })
      }
    }

    const waits: Promise<unknown>[] = []

    if (lipSyncEnable && !isExporting && !ttsEnabled) {
      const model = this.app.getModelById(talkData.data.modelId)

      const speak_task = new Promise<void>((resolve) => {
        const d = this.data as unknown as TalkData
        if (d.type !== 'Talk') return

        model.speak(this.app.getVoiceByName(d.data.voice), {
          volume: 0.5,
          onFinish: resolve
        })
      })

      waits.push(speak_task)
    }

    if (isExporting && hasModel) {
      const model = this.app.getModelById(talkData.data.modelId)
      const targetDurationMs = this.resolveExportTalkDurationMs(originalDelayMs)

      this.startMouthAnimation(model, targetDurationMs)
    }

    waits.push(this.app.layerUI.startDisplayContent())

    await Promise.all(waits)

    if (isExporting) {
      const elapsedMs = performance.now() - snippetStartTime
      const targetDurationMs = this.resolveExportTalkDurationMs(originalDelayMs)

      const remainingWait = targetDurationMs - elapsedMs
      if (remainingWait > 50) {
        await AnimationManager.delay(remainingWait)
      }

      if (hasModel) {
        const model = this.app.getModelById(talkData.data.modelId)
        this.stopMouthAnimation(model)
      }
    } else {
      const contentLength = talkData.data.content.length
      const readingLingerMs = Math.max(800, contentLength * 30)
      await AnimationManager.delay(readingLingerMs)
    }
  }
}
