import {
  TTSService,
  TTSConfig,
  DEFAULT_TTS_CONFIG,
  CharacterVoiceConfig,
  TranslationConfig,
  BGMConfig
} from '../services/TTSService'
import { TranslationService } from '../services/TranslationService'
import { AudioTrackData } from './video-export/AudioMuxer'
import getSubLogger from '../utils/Logger'
import { ILogObj, Logger } from 'tslog'
import type { SnippetData } from '../../../common/types/Story'
import {
  calculateTimeline as calcTimelineFull,
  validateTimelineIntegrity,
  type TTSMapping as CalcTTSMapping
} from '../utils/TimelineCalculator'

export interface SnippetTimelineEntry {
  snippetIndex: number
  snippetType: string
  startTimeMs: number
  durationMs: number
  endTimeMs: number
  ttsDurationMs: number
  hasTTS: boolean
}

interface TalkSnippet {
  index: number
  speaker: string
  content: string
  ttsText: string
}

interface SynthesizeResult {
  success: boolean
  duration: number
  index: number
}

const DEFAULT_CONCURRENCY = 3
const PREFETCH_CACHE_SIZE = 100

/**
 * TTS管理器 - 负责文本转语音的全流程管理
 *
 * 功能包括：
 * - 语音合成（本地TTS和远程TTS服务）
 * - 文本翻译（支持多语言翻译）
 * - 时间线构建（预合成语音并计算时间轴）
 * - 并发控制（批量处理语音合成任务）
 * - BGM配置管理
 *
 * @example
 * ```typescript
 * const ttsManager = new TTSManager();
 * ttsManager.initialize();
 * await ttsManager.preSynthesizeAll(snippets);
 * ```
 */
export class TTSManager {
  private readonly logger: Logger<ILogObj> = getSubLogger('TTSManager')
  private ttsService: TTSService | null = null
  private translationService: TranslationService | null = null
  private config: TTSConfig
  private translationConfig: TranslationConfig
  private bgmConfig: BGMConfig
  private characterConfigs: Map<string, CharacterVoiceConfig> = new Map()
  private audioTracks: AudioTrackData[] = []
  private currentTimeMs: number = 0
  private preSynthesizedTimeline: SnippetTimelineEntry[] = []
  private preSynthesizedTtsDurations: Map<number, number> = new Map()

  // 预取缓存 - 用于提前准备翻译结果
  private prefetchCache: Map<
    string,
    { text: string; characterName: string; translatedText: string }
  > = new Map()

  // 并发控制
  private concurrency: number = DEFAULT_CONCURRENCY

  constructor() {
    this.config = {
      ...DEFAULT_TTS_CONFIG,
      enabled: true,
      apiBaseUrl: 'http://127.0.0.1:9880',
      defaultRefAudioPath: 'a.wav',
      defaultPromptText: 'ふっふっふ、このまたのなおーっていうやッ、言ってみたかったんだよねえ',
      textLang: 'ja',
      speedFactor: 1.0
    }
    this.translationConfig = {
      enabled: true,
      apiType: 'openai',
      apiUrl: '',
      apiKey: '',
      model: 'longcat-flash-chat',
      sourceLang: 'zh',
      targetLang: 'ja',
      systemPrompt: ''
    }
    this.bgmConfig = {
      enabled: true,
      path: 'audio/bgm/bg1.mp3',
      volume: 0.2
    }
  }

  /**
   * 初始化TTS服务和翻译服务
   *
   * 根据配置创建TTS服务实例和翻译服务实例。
   * 如果服务已存在则不会重复创建。
   */
  initialize(): void {
    if (!this.ttsService) {
      this.ttsService = new TTSService(this.config)
      this.logger.info('TTS service initialized')
    }
    if (this.translationConfig.enabled && !this.translationService) {
      this.translationService = new TranslationService(this.translationConfig)
      this.logger.info('Translation service initialized')
    }
  }

  updateConfig(newConfig: Partial<TTSConfig>): void {
    this.config = { ...this.config, ...newConfig }
    if (this.ttsService) {
      this.ttsService.updateConfig(newConfig)
    }
  }

  updateTranslationConfig(newConfig: Partial<TranslationConfig>): void {
    this.translationConfig = { ...this.translationConfig, ...newConfig }
    if (this.translationService) {
      this.translationService.updateConfig(newConfig)
    } else if (this.translationConfig.enabled) {
      this.translationService = new TranslationService(this.translationConfig)
      this.logger.info(`Translation service initialized: ${this.translationConfig.apiUrl}`)
    }
    this.logger.info(
      `Translation config updated: enabled=${this.translationConfig.enabled}, apiUrl=${this.translationConfig.apiUrl}, model=${this.translationConfig.model}`
    )
  }

  updateBGMConfig(newConfig: Partial<BGMConfig>): void {
    this.bgmConfig = { ...this.bgmConfig, ...newConfig }
  }

  setConcurrency(concurrency: number): void {
    this.concurrency = Math.max(1, Math.min(concurrency, 5))
    this.logger.info(`TTS concurrency set to ${this.concurrency}`)
  }

  setCharacterVoice(characterName: string, voiceConfig: CharacterVoiceConfig): void {
    if (!this.ttsService) {
      this.initialize()
    }
    this.characterConfigs.set(characterName, voiceConfig)
    this.ttsService?.setCharacterVoice(characterName, voiceConfig)
    this.logger.info(`Character voice configured: ${characterName}`)
  }

  setCurrentTime(timeMs: number): void {
    this.currentTimeMs = timeMs
  }

  getAudioTracks(): AudioTrackData[] {
    return this.audioTracks
  }

  clearAudioTracks(): void {
    this.audioTracks = []
    this.currentTimeMs = 0
    this.preSynthesizedTimeline = []
    this.preSynthesizedTtsDurations.clear()
  }

  async preSynthesizeAll(
    snippets: SnippetData[],
    onProgress?: (current: number, total: number, message: string) => void
  ): Promise<SnippetTimelineEntry[]> {
    this.clearAudioTracks()
    this.prefetchCache.clear()

    if (!this.config.enabled) {
      this.logger.info('TTS disabled, building timeline without pre-synthesis')
      return this.buildTimelineWithoutTTS(snippets)
    }

    this.initialize()

    const talkSnippets = this.extractTalkSnippets(snippets)
    this.logger.info(
      `Pre-synthesis: ${talkSnippets.length} Talk snippets out of ${snippets.length} total (concurrency: ${this.concurrency})`
    )

    if (talkSnippets.length === 0) {
      return this.buildTimelineWithoutTTS(snippets)
    }

    // 并行预翻译所有文本
    if (this.translationConfig.enabled) {
      await this.prefetchAllTranslations(talkSnippets)
    }

    // 并行合成语音（带并发控制）
    const results = await this.synthesizeBatch(talkSnippets, onProgress)

    // 处理结果
    let successCount = 0
    let failedCount = 0
    for (const result of results) {
      if (result.success && result.duration > 0) {
        this.preSynthesizedTtsDurations.set(result.index, result.duration)
        successCount++
      } else {
        failedCount++
      }
    }

    this.logger.info(
      `Pre-synthesis complete: ${successCount}/${talkSnippets.length} succeeded, ${failedCount} failed`
    )

    const timeline = this.buildTimelineWithTTS(snippets)
    this.logger.info(
      `Timeline built: ${timeline.length} entries, total duration=${timeline[timeline.length - 1]?.endTimeMs ?? 0}ms`
    )

    return timeline
  }

  private extractTalkSnippets(snippets: SnippetData[]): TalkSnippet[] {
    const talkSnippets: TalkSnippet[] = []
    for (let i = 0; i < snippets.length; i++) {
      const s = snippets[i]
      if (s.type === 'Talk') {
        const data = s.data as { speaker: string; content: string; ttsText?: string }
        talkSnippets.push({
          index: i,
          speaker: data.speaker,
          content: data.content,
          ttsText: data.ttsText || ''
        })
      }
    }
    return talkSnippets
  }

  private async prefetchAllTranslations(talkSnippets: TalkSnippet[]): Promise<void> {
    if (!this.translationConfig.enabled) {
      this.logger.info('Translation disabled, skipping prefetch')
      return
    }

    if (!this.translationService) {
      this.translationService = new TranslationService(this.translationConfig)
      this.logger.info('Translation service created for prefetch')
    }

    this.logger.info(`Starting prefetch for ${talkSnippets.length} snippets`)

    const executing: Set<Promise<void>> = new Set()
    let succeeded = 0
    let failed = 0

    for (const talk of talkSnippets) {
      const cacheKey = talk.content
      if (this.prefetchCache.has(cacheKey)) {
        continue
      }

      const promise = this.translationService!.translate(talk.content)
        .then((result) => {
          if (result.success) {
            this.prefetchCache.set(cacheKey, {
              text: talk.content,
              characterName: talk.speaker,
              translatedText: result.translatedText
            })
            succeeded++
          } else {
            this.logger.warn(
              `Translation failed for: "${talk.content.substring(0, 30)}..." - ${result.error}`
            )
            failed++
          }
        })
        .catch((error) => {
          this.logger.warn(
            `Translation error for: "${talk.content.substring(0, 30)}..." - ${error instanceof Error ? error.message : String(error)}`
          )
          failed++
        })

      executing.add(promise)
      promise.finally(() => executing.delete(promise))

      if (executing.size >= this.concurrency) {
        await Promise.race(executing)
      }
    }

    await Promise.all(executing)

    while (this.prefetchCache.size > PREFETCH_CACHE_SIZE) {
      const firstKey = this.prefetchCache.keys().next().value
      if (firstKey !== undefined) {
        this.prefetchCache.delete(firstKey)
      }
    }

    this.logger.info(
      `Prefetch complete: ${succeeded} succeeded, ${failed} failed, cache size: ${this.prefetchCache.size}`
    )
  }

  private async synthesizeBatch(
    talkSnippets: TalkSnippet[],
    onProgress?: (current: number, total: number, message: string) => void
  ): Promise<SynthesizeResult[]> {
    const results: SynthesizeResult[] = new Array(talkSnippets.length)
    let completedCount = 0
    const executing: Set<Promise<void>> = new Set()

    for (let i = 0; i < talkSnippets.length; i++) {
      const talk = talkSnippets[i]

      const promise = this.synthesizeSingle(talk, i).then((result) => {
        results[i] = result
        completedCount++
        if (onProgress) {
          onProgress(
            completedCount,
            talkSnippets.length,
            `正在合成语音 ${completedCount}/${talkSnippets.length}: ${talk.speaker}`
          )
        }
      })

      executing.add(promise)
      promise.finally(() => executing.delete(promise))

      if (executing.size >= this.concurrency) {
        await Promise.race(executing)
      }
    }

    await Promise.all(executing)
    return results
  }

  private async synthesizeSingle(
    talk: TalkSnippet,
    _arrayIndex: number
  ): Promise<SynthesizeResult> {
    try {
      this.currentTimeMs = this.calculateCurrentTimeMsFromIndex(talk.index)
      if (talk.ttsText) {
        const result = await this.synthesizeWithText(talk.ttsText, talk.speaker, talk.index)
        return { ...result, index: talk.index }
      }
      const result = await this.translateAndSynthesizeWithPrefetch(
        talk.content,
        talk.speaker,
        talk.index
      )
      return { ...result, index: talk.index }
    } catch (error) {
      this.logger.error(
        `Pre-synthesis exception [${talk.index}]: ${error instanceof Error ? error.message : String(error)}`
      )
      return { success: false, duration: 0, index: talk.index }
    }
  }

  async synthesizeWithText(
    text: string,
    characterName: string,
    snippetIndex?: number
  ): Promise<{ success: boolean; duration: number }> {
    if (!this.ttsService) {
      this.initialize()
    }

    if (!this.ttsService) {
      return { success: false, duration: 0 }
    }

    const ttsResult = await this.ttsService.synthesizeSpeech(text, characterName)

    if (ttsResult.success && ttsResult.audioBuffer.byteLength > 0) {
      const audioTrack: AudioTrackData = {
        audioBuffer: ttsResult.audioBuffer,
        startTime: this.currentTimeMs,
        endTime: this.currentTimeMs + ttsResult.duration,
        characterName,
        text,
        snippetIndex
      }
      this.audioTracks.push(audioTrack)
      return { success: true, duration: ttsResult.duration }
    }

    return { success: false, duration: 0 }
  }

  private calculateCurrentTimeMsFromIndex(targetIndex: number): number {
    let timeMs = 0
    for (let i = 0; i < targetIndex; i++) {
      const ttsDurationMs = this.preSynthesizedTtsDurations.get(i) ?? 0
      timeMs += Math.max(0, ttsDurationMs)
    }
    return timeMs
  }

  private async translateAndSynthesizeWithPrefetch(
    text: string,
    characterName: string,
    snippetIndex?: number
  ): Promise<{ success: boolean; duration: number }> {
    // 使用纯文本内容作为缓存键，与预取时保持一致
    const cacheKey = text
    const prefetched = this.prefetchCache.get(cacheKey)

    let translatedText = text

    if (this.translationConfig.enabled) {
      if (prefetched) {
        translatedText = prefetched.translatedText
        this.logger.debug(`Using prefetched translation for "${text.substring(0, 30)}..."`)
      } else if (this.translationService) {
        this.logger.debug(`No prefetch cache for "${text.substring(0, 30)}...", translating now...`)
        const translationResult = await this.translationService.translate(text)
        if (translationResult.success) {
          translatedText = translationResult.translatedText
          this.logger.debug(
            `Live translated: "${text.substring(0, 30)}..." -> "${translatedText.substring(0, 30)}..."`
          )
        } else {
          this.logger.warn(`Live translation failed: ${translationResult.error}`)
        }
      } else {
        this.logger.warn(`Translation enabled but no translation service available`)
      }
    }

    if (!this.ttsService) {
      this.initialize()
    }

    if (!this.ttsService) {
      return { success: false, duration: 0 }
    }

    const ttsResult = await this.ttsService.synthesizeSpeech(translatedText, characterName)

    if (ttsResult.success && ttsResult.audioBuffer.byteLength > 0) {
      const audioTrack: AudioTrackData = {
        audioBuffer: ttsResult.audioBuffer,
        startTime: this.currentTimeMs,
        endTime: this.currentTimeMs + ttsResult.duration,
        characterName,
        text: translatedText,
        snippetIndex
      }
      this.audioTracks.push(audioTrack)
      return { success: true, duration: ttsResult.duration }
    }

    return { success: false, duration: 0 }
  }

  private buildTimelineWithTTS(snippets: SnippetData[]): SnippetTimelineEntry[] {
    const ttsMappings = new Map<number, CalcTTSMapping>()
    for (const [idx, dur] of this.preSynthesizedTtsDurations) {
      if (snippets[idx]?.type === 'Talk' && dur > 0) {
        ttsMappings.set(idx, { snippetIndex: idx, durationMs: dur })
      }
    }
    const result = calcTimelineFull(snippets, ttsMappings)
    this.logTimelineValidation(result)
    return result.entries.map((e) => this.toSnippetTimelineEntry(e))
  }

  buildTimelineWithoutTTS(snippets: SnippetData[]): SnippetTimelineEntry[] {
    const result = calcTimelineFull(snippets, new Map())
    this.logTimelineValidation(result)
    return result.entries.map((e) => this.toSnippetTimelineEntry(e))
  }

  buildTimelineWithTTSFromTracks(snippets: SnippetData[]): SnippetTimelineEntry[] {
    const ttsMappings = new Map<number, CalcTTSMapping>()
    let talkIdx = 0
    for (let i = 0; i < snippets.length; i++) {
      if (snippets[i].type === 'Talk' && talkIdx < this.audioTracks.length) {
        const track = this.audioTracks[talkIdx]
        const dur = track.endTime - track.startTime
        if (dur > 0) {
          ttsMappings.set(i, { snippetIndex: i, durationMs: dur })
        }
        talkIdx++
      }
    }
    const result = calcTimelineFull(snippets, ttsMappings)
    this.logTimelineValidation(result)
    return result.entries.map((e) => this.toSnippetTimelineEntry(e))
  }

  private toSnippetTimelineEntry(
    e: import('../utils/TimelineCalculator').TimelineEntry
  ): SnippetTimelineEntry {
    return {
      snippetIndex: e.snippetIndex,
      snippetType: e.snippetType,
      startTimeMs: e.startTimeMs,
      durationMs: e.durationMs,
      endTimeMs: e.endTimeMs,
      ttsDurationMs: e.ttsDurationMs,
      hasTTS: e.hasTTS
    }
  }

  private logTimelineValidation(
    result: import('../utils/TimelineCalculator').TimelineCalculationResult
  ): void {
    const v = result.validationSummary
    if (!v.crossValidationPassed || v.anomaliesDetected.length > 0) {
      this.logger.warn(
        `Timeline validation: ${v.validCount} valid, ${v.warningCount} warnings, ${v.errorCount} errors`
      )
      for (const a of v.anomaliesDetected) {
        this.logger.warn(`  Anomaly: ${a}`)
      }
    }
    const integrity = validateTimelineIntegrity(result.entries)
    if (!integrity.valid) {
      this.logger.error('Timeline integrity check FAILED:')
      for (const err of integrity.errors) {
        this.logger.error(`  ${err}`)
      }
    }
  }

  getPreSynthesizedTtsDuration(snippetIndex: number): number {
    return this.preSynthesizedTtsDurations.get(snippetIndex) ?? 0
  }

  getPreSynthesizedTtsDurations(): Map<number, number> {
    return new Map(this.preSynthesizedTtsDurations)
  }

  getTimeline(): SnippetTimelineEntry[] {
    return this.preSynthesizedTimeline
  }

  setTimeline(timeline: SnippetTimelineEntry[]): void {
    this.preSynthesizedTimeline = timeline
  }

  async translateAndSynthesize(
    text: string,
    characterName: string,
    snippetIndex?: number
  ): Promise<{ success: boolean; duration: number }> {
    // 不清空缓存，允许复用预取结果
    return this.translateAndSynthesizeWithPrefetch(text, characterName, snippetIndex)
  }

  getService(): TTSService | null {
    if (!this.ttsService) {
      this.initialize()
    }
    return this.ttsService
  }

  getTranslationService(): TranslationService | null {
    return this.translationService
  }

  getConfig(): TTSConfig {
    return { ...this.config }
  }

  getTranslationConfig(): TranslationConfig {
    return { ...this.translationConfig }
  }

  getBGMConfig(): BGMConfig {
    return { ...this.bgmConfig }
  }

  isTTSEnabled(): boolean {
    return this.config.enabled
  }

  getAudioBufferForSnippet(snippetIndex: number): ArrayBuffer | null {
    const byIndex = this.audioTracks.find((t) => t.snippetIndex === snippetIndex)
    if (byIndex) return byIndex.audioBuffer
    const track = this.audioTracks.find(
      (t) =>
        t.startTime >= 0 && this.audioTracks.indexOf(t) === this.getTalkTrackIndex(snippetIndex)
    )
    return track?.audioBuffer ?? null
  }

  private getTalkTrackIndex(snippetIndex: number): number {
    let talkCount = -1
    if (!this.preSynthesizedTimeline || this.preSynthesizedTimeline.length === 0) return -1
    for (let i = 0; i <= snippetIndex && i < this.preSynthesizedTimeline.length; i++) {
      if (this.preSynthesizedTimeline[i].snippetType === 'Talk') {
        talkCount++
      }
    }
    return talkCount
  }

  isTranslationEnabled(): boolean {
    return this.translationConfig.enabled
  }

  dispose(): void {
    if (this.ttsService) {
      this.ttsService.dispose()
    }
    if (this.translationService) {
      this.translationService.clearCache()
    }
    this.ttsService = null
    this.translationService = null
    this.audioTracks = []
    this.prefetchCache.clear()
  }

  async testTTSConnection(): Promise<{ success: boolean; message: string; details?: string }> {
    if (!this.ttsService) {
      this.initialize()
    }
    if (!this.ttsService) {
      return {
        success: false,
        message: 'TTS服务未初始化'
      }
    }
    return await this.ttsService.testConnection()
  }

  async checkTTSAvailability(): Promise<boolean> {
    const apiBaseUrl = this.config.apiBaseUrl || 'http://127.0.0.1:9880'
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 5000)
      await fetch(`${apiBaseUrl}/tts`, {
        method: 'HEAD',
        signal: controller.signal
      })
      clearTimeout(timeoutId)
      return true
    } catch {
      try {
        const ipcResult = await Promise.race([
          window.electron.ipcRenderer.invoke('electron:tts-fetch', {
            url: `${apiBaseUrl}/tts`,
            method: 'HEAD',
            headers: {},
            body: ''
          }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
        ])
        return ipcResult.ok || ipcResult.status > 0
      } catch {
        return false
      }
    }
  }

  async testTranslationConnection(): Promise<{
    success: boolean
    message: string
    details?: string
  }> {
    if (!this.translationService) {
      if (this.translationConfig.enabled) {
        this.translationService = new TranslationService(this.translationConfig)
      } else {
        return {
          success: false,
          message: '翻译功能未启用'
        }
      }
    }
    return await this.translationService.testConnection()
  }
}
