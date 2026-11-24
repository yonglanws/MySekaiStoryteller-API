import { ExportLogger } from './ExportLogger'

export interface SnippetTimestamp {
  snippetIndex: number
  snippetType: string
  wallStartMs: number
  wallEndMs: number
  wallDurationMs: number
  isTalk: boolean
  speaker?: string
  content?: string
  ttsDurationMs?: number
  speechOffsetMs?: number
}

export class SnippetTimestampRecorder {
  private readonly logger: ExportLogger = new ExportLogger('TimestampRecorder')
  private timestamps: SnippetTimestamp[] = []
  private timestampIndex: Map<number, SnippetTimestamp> = new Map()
  private renderStartWallMs: number = 0
  /** TimelineCalculator 的 0 点（故事帧 10）；诊断漂移相对它计算。 */
  private timelineStartWallMs: number = 0
  private currentSnippetStartWallMs: number = 0
  private currentSnippetIndex: number = -1
  private currentSnippetType: string = ''
  private currentSnippetData: { speaker?: string; content?: string } = {}
  private activeStarts: Map<
    number,
    {
      snippetType: string
      wallStartMs: number
      data: { speaker?: string; content?: string }
    }
  > = new Map()
  private talkSpeechStartByIndex: Map<number, number> = new Map()

  /**
   * @param renderStartWallMs 成片帧 0（故事帧 0）的时刻；音频 placement 相对它。
   * @param timelineStartWallMs TimelineCalculator 的 0 点（故事帧 10）；
   *   诊断里的 planned/actual 漂移相对它，二者相差 PlayCore 预热帧。
   */
  markRenderStart(
    renderStartWallMs: number = performance.now(),
    timelineStartWallMs: number = renderStartWallMs
  ): void {
    this.renderStartWallMs = renderStartWallMs
    this.timelineStartWallMs = timelineStartWallMs
    this.timestamps = []
    this.timestampIndex.clear()
    this.activeStarts.clear()
    this.talkSpeechStartByIndex.clear()
    this.logger.info(
      `Render start marked at wall time ${this.renderStartWallMs.toFixed(0)}ms ` +
        `(timeline origin ${this.timelineStartWallMs.toFixed(0)}ms)`
    )
  }

  markSnippetStart(
    index: number,
    type: string,
    data?: { speaker?: string; content?: string }
  ): void {
    const wallStartMs = performance.now()
    const snippetData = data || {}
    this.currentSnippetIndex = index
    this.currentSnippetType = type
    this.currentSnippetData = snippetData
    this.currentSnippetStartWallMs = wallStartMs
    this.activeStarts.set(index, {
      snippetType: type,
      wallStartMs,
      data: snippetData
    })
    this.logger.info(`Snippet[${index}] start: type=${type}, wall=${wallStartMs.toFixed(0)}ms`)
  }

  markTalkSpeechStart(index: number, wallMs: number = performance.now()): void {
    this.talkSpeechStartByIndex.set(index, wallMs)
  }

  markSnippetEnd(ttsDurationMs?: number, speechOffsetMs = 0, snippetIndex?: number): void {
    const targetIndex = snippetIndex ?? this.currentSnippetIndex
    if (targetIndex < 0) return

    const active = this.activeStarts.get(targetIndex)
    const wallStartMs = active?.wallStartMs ?? this.currentSnippetStartWallMs
    const snippetType = active?.snippetType ?? this.currentSnippetType
    const snippetData = active?.data ?? this.currentSnippetData
    this.activeStarts.delete(targetIndex)

    const recordedSpeechStart = this.talkSpeechStartByIndex.get(targetIndex)
    this.talkSpeechStartByIndex.delete(targetIndex)
    const resolvedSpeechOffsetMs =
      speechOffsetMs > 0
        ? speechOffsetMs
        : recordedSpeechStart !== undefined
          ? Math.max(0, recordedSpeechStart - wallStartMs)
          : 0

    const wallEndMs = performance.now()
    const isTalk = snippetType === 'Talk'

    const entry: SnippetTimestamp = {
      snippetIndex: targetIndex,
      snippetType,
      wallStartMs,
      wallEndMs,
      wallDurationMs: wallEndMs - wallStartMs,
      isTalk,
      speaker: snippetData.speaker,
      content: snippetData.content,
      ttsDurationMs,
      speechOffsetMs: Math.max(0, resolvedSpeechOffsetMs)
    }

    this.timestamps.push(entry)
    this.timestampIndex.set(entry.snippetIndex, entry)

    this.logger.info(
      `Snippet[${entry.snippetIndex}] end: wall=${wallEndMs.toFixed(0)}ms, duration=${entry.wallDurationMs.toFixed(0)}ms`
    )

    if (targetIndex === this.currentSnippetIndex) {
      this.currentSnippetIndex = -1
    }
  }

  recordSnippet(
    index: number,
    type: string,
    startWallMs: number,
    endWallMs: number,
    data?: { speaker?: string; content?: string; ttsDurationMs?: number }
  ): void {
    const isTalk = type === 'Talk'
    this.timestamps.push({
      snippetIndex: index,
      snippetType: type,
      wallStartMs: startWallMs,
      wallEndMs: endWallMs,
      wallDurationMs: endWallMs - startWallMs,
      isTalk,
      speaker: data?.speaker,
      content: data?.content,
      ttsDurationMs: data?.ttsDurationMs
    })
    this.timestampIndex.set(index, this.timestamps[this.timestamps.length - 1])
  }

  getSnippetTimestamp(index: number): SnippetTimestamp | undefined {
    return this.timestampIndex.get(index)
  }

  getTalkTimestamps(): SnippetTimestamp[] {
    return this.timestamps.filter((t) => t.isTalk)
  }

  getVideoRelativeStartTimeMs(index: number): number {
    const ts = this.getSnippetTimestamp(index)
    if (!ts) return 0
    return Math.max(0, ts.wallStartMs - this.renderStartWallMs)
  }

  getVideoRelativeEndTimeMs(index: number): number {
    const ts = this.getSnippetTimestamp(index)
    if (!ts) return 0
    return Math.max(0, ts.wallEndMs - this.renderStartWallMs)
  }

  getTotalVideoDurationMs(): number {
    if (this.timestamps.length === 0) return 0
    const lastEnd = this.timestamps[this.timestamps.length - 1].wallEndMs
    return Math.max(0, lastEnd - this.renderStartWallMs)
  }

  getRenderStartWallMs(): number {
    return this.renderStartWallMs
  }

  /** TimelineCalculator 的 0 点（故事帧 10）的墙钟时刻；诊断漂移相对它。 */
  getTimelineStartWallMs(): number {
    return this.timelineStartWallMs
  }

  getAllTimestamps(): SnippetTimestamp[] {
    return [...this.timestamps]
  }

  buildAudioTrackPlacements(
    ttsResults: Map<
      number,
      {
        audioBuffer: ArrayBuffer
        pcmData?: {
          channel0: Float32Array
          channel1: Float32Array
          sampleRate: number
        }
        durationMs: number
        characterName: string
        text: string
        preDecoded: boolean
      }
    >
  ): Array<{
    audioBuffer: ArrayBuffer
    pcmData?: {
      channel0: Float32Array
      channel1: Float32Array
      sampleRate: number
    }
    startTimeMs: number
    endTimeMs: number
    characterName: string
    text: string
    preDecoded: boolean
  }> {
    const placements: Array<{
      audioBuffer: ArrayBuffer
      pcmData?: {
        channel0: Float32Array
        channel1: Float32Array
        sampleRate: number
      }
      startTimeMs: number
      endTimeMs: number
      characterName: string
      text: string
      preDecoded: boolean
    }> = []

    for (const [snippetIndex, ttsResult] of ttsResults) {
      const ts = this.getSnippetTimestamp(snippetIndex)
      if (!ts) {
        this.logger.warn(`No timestamp for snippet[${snippetIndex}], skipping audio placement`)
        continue
      }

      const videoRelativeStart =
        this.getVideoRelativeStartTimeMs(snippetIndex) + (ts.speechOffsetMs ?? 0)
      const ttsDurationMs = ttsResult.durationMs
      const snippetDurationMs = ts.wallDurationMs

      const audioStartMs = videoRelativeStart
      const audioEndMs = videoRelativeStart + ttsDurationMs

      placements.push({
        audioBuffer: ttsResult.audioBuffer,
        pcmData: ttsResult.pcmData,
        startTimeMs: Math.round(audioStartMs),
        endTimeMs: Math.round(audioEndMs),
        characterName: ttsResult.characterName,
        text: ttsResult.text,
        preDecoded: ttsResult.preDecoded || false
      })

      this.logger.info(
        `Audio placement: snippet[${snippetIndex}] "${ttsResult.characterName}" ` +
          `videoStart=${videoRelativeStart.toFixed(0)}ms, ` +
          `audioStart=${audioStartMs.toFixed(0)}ms, audioEnd=${audioEndMs.toFixed(0)}ms, ` +
          `ttsDur=${ttsDurationMs}ms, snippetDur=${snippetDurationMs.toFixed(0)}ms`
      )
    }

    return placements
  }

  logSummary(): void {
    this.logger.info('=== Timestamp Summary ===')
    this.logger.info(`Render start: ${this.renderStartWallMs.toFixed(0)}ms`)
    this.logger.info(`Total video duration: ${this.getTotalVideoDurationMs().toFixed(0)}ms`)
    this.logger.info(`Total snippets: ${this.timestamps.length}`)

    for (const ts of this.timestamps) {
      const relStart = (ts.wallStartMs - this.renderStartWallMs).toFixed(0)
      const relEnd = (ts.wallEndMs - this.renderStartWallMs).toFixed(0)
      this.logger.info(
        `  [${ts.snippetIndex}] ${ts.snippetType}: ${relStart}ms → ${relEnd}ms (${ts.wallDurationMs.toFixed(0)}ms)` +
          (ts.isTalk ? ` speaker="${ts.speaker}" ttsDur=${ts.ttsDurationMs ?? 'N/A'}ms` : '')
      )
    }
  }

  reset(): void {
    this.timestamps = []
    this.timestampIndex.clear()
    this.renderStartWallMs = 0
    this.timelineStartWallMs = 0
    this.currentSnippetIndex = -1
    this.currentSnippetStartWallMs = 0
    this.activeStarts.clear()
    this.talkSpeechStartByIndex.clear()
  }
}
