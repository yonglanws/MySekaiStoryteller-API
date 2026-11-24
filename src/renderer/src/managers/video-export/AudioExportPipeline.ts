import { ExportLogger } from './ExportLogger'
import type { TTSManager } from '../TTSManager'
import type { IrodoriLineOverride } from '../../../../common/tts/irodori'
import type { SnippetData } from '../../../../common/types/Story'
import { hasSpeakableSpeechText } from '../../../../common/tts/speechText'
import { calculateTimeline, type TTSMapping } from '../../utils/TimelineCalculator'
import type { AudioTimestampEntry, AudioTimestampManifest } from './AudioTimestampManifest'

interface PipelineTalkSnippet {
  index: number
  speaker: string
  content: string
  ttsText: string
  emotion: string
  lineOverride?: IrodoriLineOverride
}

export interface AudioExportPipelineConfig {
  ttsTimeoutMs: number
  maxRetries: number
}

export interface AudioExportResult {
  success: boolean
  manifest: AudioTimestampManifest | null
  totalDurationMs: number
  trackCount: number
}

export class AudioExportPipeline {
  private readonly logger: ExportLogger = new ExportLogger('AudioExportPipeline')
  private readonly config: Required<AudioExportPipelineConfig>
  private aborted: boolean = false

  constructor(config?: Partial<AudioExportPipelineConfig>) {
    this.config = {
      ttsTimeoutMs: config?.ttsTimeoutMs ?? 30000,
      maxRetries: config?.maxRetries ?? 2
    }
  }

  abort(): void {
    this.aborted = true
    this.logger.info('Audio export pipeline aborted')
  }

  async synthesizeAllAudio(
    snippets: SnippetData[],
    ttsManager: TTSManager,
    onProgress?: (current: number, total: number, message: string) => void
  ): Promise<AudioExportResult> {
    this.aborted = false
    const startTime = performance.now()

    if (!ttsManager.isTTSEnabled()) {
      this.logger.info('TTS disabled, skipping audio synthesis')
      return { success: true, manifest: null, totalDurationMs: 0, trackCount: 0 }
    }

    this.logger.info('Starting audio export pipeline', {
      snippetCount: snippets.length,
      timeout: this.config.ttsTimeoutMs,
      maxRetries: this.config.maxRetries
    })

    const talkSnippets: PipelineTalkSnippet[] = []
    for (let i = 0; i < snippets.length; i++) {
      const snippet = snippets[i]
      if (snippet.type === 'Talk') {
        const data = (snippet.data || {}) as {
          speaker?: string
          content?: string
          ttsText?: string
          emotion?: string
          ttsCaption?: string
          ttsSpeed?: number
          ttsSpecialScene?: boolean
        }
        const lineOverride: IrodoriLineOverride | undefined =
          data.ttsCaption || data.ttsSpeed !== undefined || data.ttsSpecialScene !== undefined
            ? {
                ttsCaption: data.ttsCaption,
                ttsSpeed: data.ttsSpeed,
                ttsSpecialScene: data.ttsSpecialScene
              }
            : undefined
        talkSnippets.push({
          index: i,
          speaker: data.speaker || '',
          content: data.content || '',
          ttsText: data.ttsText || '',
          emotion: data.emotion || '',
          lineOverride
        })
      }
    }

    this.logger.info(`Audio pipeline: ${talkSnippets.length} Talk snippets to synthesize`)

    const totalTalkCount = talkSnippets.length
    const ttsMappings = new Map<number, TTSMapping>()
    const talkByIndex = new Map<number, PipelineTalkSnippet>(talkSnippets.map((t) => [t.index, t]))

    for (let talkIndex = 0; talkIndex < talkSnippets.length; talkIndex++) {
      if (this.aborted) {
        this.logger.info('Audio pipeline aborted')
        break
      }

      const talk = talkSnippets[talkIndex]
      const hasSpeakableTts = hasSpeakableSpeechText(talk.ttsText)
      const hasSpeakableContent = hasSpeakableSpeechText(talk.content)

      if (hasSpeakableTts || hasSpeakableContent) {
        const ttsResult = await this.synthesizeWithRetry(
          ttsManager,
          talk,
          talkIndex,
          totalTalkCount
        )

        if (ttsResult && ttsResult.success && ttsResult.duration > 0) {
          ttsMappings.set(talk.index, {
            snippetIndex: talk.index,
            durationMs: ttsResult.duration
          })
          this.logger.info(
            `Audio entry [${talk.index}] "${talk.speaker}": duration=${ttsResult.duration}ms, ttsManager audioTracks now: ${ttsManager.getAudioTracks().length}`
          )
        } else {
          this.logger.warn(`Audio synthesis failed for snippet ${talk.index}, using silence`)
        }
      }

      onProgress?.(talkIndex + 1, totalTalkCount, `正在合成语音 ${talkIndex + 1}/${totalTalkCount}`)
    }

    // 用与渲染一致的官方时间线计算每条对白的精确起始时间（含 delay / 门控）
    const timeline = calculateTimeline(snippets, ttsMappings)
    const entryByIndex = new Map(timeline.entries.map((e) => [e.snippetIndex, e]))

    for (const track of ttsManager.getAudioTracks()) {
      if (track.snippetIndex === undefined) continue
      const entry = entryByIndex.get(track.snippetIndex)
      if (!entry) continue
      const trackDuration = Math.max(0, track.endTime - track.startTime)
      track.startTime = entry.startTimeMs
      track.endTime = entry.startTimeMs + trackDuration
    }

    const entries: AudioTimestampEntry[] = []
    for (const [snippetIndex, mapping] of ttsMappings) {
      const entry = entryByIndex.get(snippetIndex)
      const talk = talkByIndex.get(snippetIndex)
      if (!entry || !talk) continue
      entries.push({
        snippetIndex,
        characterName: talk.speaker,
        text: talk.ttsText || talk.content,
        startTimeMs: entry.startTimeMs,
        endTimeMs: entry.startTimeMs + mapping.durationMs,
        durationMs: mapping.durationMs,
        audioFilePath: `track_${snippetIndex}`
      })
    }

    const totalDurationMs = timeline.totalDurationMs
    const trackCount = entries.length

    const manifest: AudioTimestampManifest = {
      entries,
      totalAudioDurationMs: entries.reduce((sum, e) => sum + e.durationMs, 0),
      totalStoryDurationMs: totalDurationMs
    }

    const elapsed = performance.now() - startTime
    this.logger.info('Audio export pipeline completed', {
      trackCount,
      totalDurationMs,
      elapsed: `${(elapsed / 1000).toFixed(1)}s`
    })

    return {
      success: true,
      manifest,
      totalDurationMs,
      trackCount
    }
  }

  private async synthesizeWithRetry(
    ttsManager: TTSManager,
    talk: PipelineTalkSnippet,
    index: number,
    _total: number
  ): Promise<{ success: boolean; duration: number } | null> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (this.aborted) return null

      try {
        const result = await this.synthesizeWithTimeout(ttsManager, talk)
        return result
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        this.logger.warn(
          `TTS attempt ${attempt + 1}/${this.config.maxRetries + 1} failed for [${index}]: ${lastError.message}`
        )
        if (attempt < this.config.maxRetries) {
          await this.sleep(500 * (attempt + 1))
        }
      }
    }

    this.logger.error(
      `TTS failed for [${index}] after ${this.config.maxRetries + 1} attempts: ${lastError?.message}`
    )
    return null
  }

  private async synthesizeWithTimeout(
    ttsManager: TTSManager,
    talk: PipelineTalkSnippet
  ): Promise<{ success: boolean; duration: number }> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`TTS synthesis timeout (${this.config.ttsTimeoutMs}ms)`))
      }, this.config.ttsTimeoutMs)
    })

    const synthPromise = hasSpeakableSpeechText(talk.ttsText)
      ? ttsManager.synthesizeWithText(
          talk.ttsText,
          talk.speaker,
          talk.index,
          talk.emotion,
          talk.lineOverride
        )
      : ttsManager.translateAndSynthesize(
          talk.content,
          talk.speaker,
          talk.index,
          talk.emotion,
          talk.lineOverride
        )

    try {
      return await Promise.race([synthPromise, timeoutPromise])
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
