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
  private currentSnippetStartWallMs: number = 0
  private currentSnippetIndex: number = -1
  private currentSnippetType: string = ''
  private currentSnippetData: { speaker?: string; content?: string } = {}

  markRenderStart(): void {
    this.renderStartWallMs = performance.now()
    this.timestamps = []
    this.logger.info(`Render start marked at wall time ${this.renderStartWallMs.toFixed(0)}ms`)
  }

  markSnippetStart(
    index: number,
    type: string,
    data?: { speaker?: string; content?: string }
  ): void {
    this.currentSnippetIndex = index
    this.currentSnippetType = type
    this.currentSnippetData = data || {}
    this.currentSnippetStartWallMs = performance.now()
    this.logger.info(
      `Snippet[${index}] start: type=${type}, wall=${this.currentSnippetStartWallMs.toFixed(0)}ms`
    )
  }

  markSnippetEnd(ttsDurationMs?: number, speechOffsetMs = 0): void {
    if (this.currentSnippetIndex < 0) return

    const wallEndMs = performance.now()
    const isTalk = this.currentSnippetType === 'Talk'

    const entry: SnippetTimestamp = {
      snippetIndex: this.currentSnippetIndex,
      snippetType: this.currentSnippetType,
      wallStartMs: this.currentSnippetStartWallMs,
      wallEndMs,
      wallDurationMs: wallEndMs - this.currentSnippetStartWallMs,
      isTalk,
      speaker: this.currentSnippetData.speaker,
      content: this.currentSnippetData.content,
      ttsDurationMs,
      speechOffsetMs: Math.max(0, speechOffsetMs)
    }

    this.timestamps.push(entry)
    this.timestampIndex.set(entry.snippetIndex, entry)

    this.logger.info(
      `Snippet[${entry.snippetIndex}] end: wall=${wallEndMs.toFixed(0)}ms, duration=${entry.wallDurationMs.toFixed(0)}ms`
    )

    this.currentSnippetIndex = -1
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

      let audioStartMs: number
      let audioEndMs: number

      if (ttsDurationMs <= snippetDurationMs) {
        audioStartMs = videoRelativeStart
        audioEndMs = videoRelativeStart + ttsDurationMs
      } else {
        audioStartMs = videoRelativeStart
        audioEndMs = videoRelativeStart + ttsDurationMs
      }

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
    this.currentSnippetIndex = -1
    this.currentSnippetStartWallMs = 0
  }
}
