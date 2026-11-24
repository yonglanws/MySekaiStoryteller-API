import type { SnippetData } from '../../../../common/types/Story'
import {
  buildSeCues,
  collectSeChanges,
  type SeBuffer,
  type SeBufferCue,
  type SeChangeSpec
} from '../../../../common/audio/se'
import { inappUrl } from '../../effects/InappTextures'
import { SIMPLE_SELECTABLE_AUTO_WAIT_SECONDS } from '../../../../common/official/timing'
import { resampleChannelLinear, type AudioMuxer } from './AudioMuxer'
import { ExportLogger } from './ExportLogger'
import { resolveSeUrl } from '../../utils/ResourceUrl'

interface DeferredUiSeEvent {
  snippetIndex: number
  relUrl: string
  delayMs: number
  afterStartMs: number
  volume: number
}

function collectExtraUiSeEvents(snippets: SnippetData[]): DeferredUiSeEvent[] {
  const events: DeferredUiSeEvent[] = []
  snippets.forEach((snippet, snippetIndex) => {
    const snippetDelayMs = Math.max(0, (Number(snippet.delay) || 0) * 1000)
    if (snippet.type === 'SekaiOut') {
      events.push({
        snippetIndex,
        relUrl: inappUrl('audio/MenuCommon/SE_AREA_TRANSITION_SEKAI.wav'),
        delayMs: snippetDelayMs,
        afterStartMs: 0,
        volume: 0.9
      })
    } else if (snippet.type === 'SimpleSelectable') {
      events.push({
        snippetIndex,
        relUrl: inappUrl('audio/MenuCommon/SE_UI_CHOICES_OPEN.wav'),
        delayMs: snippetDelayMs,
        afterStartMs: 0,
        volume: 0.9
      })
      const tapAfterMs = Math.round(SIMPLE_SELECTABLE_AUTO_WAIT_SECONDS * 1000)
      events.push({
        snippetIndex,
        relUrl: inappUrl('audio/MenuCommon_Built_in/SE_DECIDE1.wav'),
        delayMs: snippetDelayMs,
        afterStartMs: tapAfterMs,
        volume: 0.9
      })
      events.push({
        snippetIndex,
        relUrl: inappUrl('audio/MenuCommon/SE_UI_CHOICES_DECIDE.wav'),
        delayMs: snippetDelayMs,
        afterStartMs: tapAfterMs,
        volume: 0.9
      })
    }
  })
  return events
}

/** 一次导出的 SE 计划：支持故事 PlaySe/StopSe、SeOneShot 延迟偏移以及官方 Sekai/选项 UI 音效。 */
export class SePlan {
  private readonly snippets: SnippetData[]
  private readonly changes: SeChangeSpec[]
  private readonly uiEvents: DeferredUiSeEvent[]
  private readonly buffers = new Map<string, SeBuffer>()
  private readonly uiBuffers = new Map<string, SeBuffer>()
  private readonly logger: ExportLogger = new ExportLogger('SePlan')

  constructor(snippets: SnippetData[]) {
    this.snippets = snippets
    this.changes = collectSeChanges(snippets)
    this.uiEvents = collectExtraUiSeEvents(snippets)
  }

  get hasChanges(): boolean {
    return this.changes.length > 0 || this.uiEvents.length > 0
  }

  get fileCount(): number {
    return new Set(this.changes.filter((change) => !change.stop).map((change) => change.file)).size
  }

  private async decodeUrlInto(url: string, audioMuxer: AudioMuxer): Promise<SeBuffer | null> {
    try {
      const response = await fetch(url)
      if (!response.ok) return null
      const decoded = await audioMuxer.decodeAudioData(await response.arrayBuffer())
      const raw0 = decoded.getChannelData(0)
      const raw1 = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : raw0
      const targetRate = 48000
      const channel0 =
        decoded.sampleRate && decoded.sampleRate !== targetRate
          ? resampleChannelLinear(raw0, decoded.sampleRate, targetRate)
          : raw0
      const channel1 =
        decoded.sampleRate && decoded.sampleRate !== targetRate
          ? raw1 === raw0
            ? channel0
            : resampleChannelLinear(raw1, decoded.sampleRate, targetRate)
          : raw1
      return { channel0, channel1, numberOfChannels: decoded.numberOfChannels } as SeBuffer & {
        numberOfChannels: number
      }
    } catch {
      return null
    }
  }

  async load(audioMuxer: AudioMuxer): Promise<void> {
    const files = [...new Set(this.changes.filter((change) => !change.stop).map((c) => c.file))]
    const pending = [...files]
    const worker = async (): Promise<void> => {
      while (pending.length > 0) {
        const file = pending.shift()
        if (!file) continue
        const url = resolveSeUrl(`audio/se/${file}`)
        const buf = await this.decodeUrlInto(url, audioMuxer)
        if (buf) {
          this.buffers.set(file, buf)
        } else {
          this.logger.warn(`SE ${file} failed to load (${url})`)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, Math.max(1, files.length)) }, worker))

    const uiUrls = [...new Set(this.uiEvents.map((e) => e.relUrl))]
    await Promise.all(
      uiUrls.map(async (url) => {
        const buf = await this.decodeUrlInto(url, audioMuxer)
        if (buf) this.uiBuffers.set(url, buf)
      })
    )
  }

  /**
   * @param startTimesMs 每个片段的起始时间；record 模式传入实际时间（含 delay）
   * @param startTimesIncludeDelay 起始时间是否已经包含片段 delay
   */
  build(startTimesMs: ReadonlyArray<number>, startTimesIncludeDelay = false): SeBufferCue[] {
    const adjustedChanges = this.changes.map((change) => {
      const snippet = this.snippets[change.snippetIndex]
      const extraOffset =
        snippet?.type === 'PlaySe'
          ? Math.max(0, Number((snippet.data as { offsetMs?: number }).offsetMs) || 0)
          : 0
      return extraOffset > 0 ? { ...change, offsetMs: extraOffset } : change
    })
    const cues = buildSeCues(adjustedChanges, startTimesMs, this.buffers, startTimesIncludeDelay)

    for (const ev of this.uiEvents) {
      const buf = this.uiBuffers.get(ev.relUrl)
      if (!buf) continue
      const baseMs = startTimesMs[ev.snippetIndex] ?? 0
      cues.push({
        timeMs: Math.max(0, baseMs + (startTimesIncludeDelay ? 0 : ev.delayMs) + ev.afterStartMs),
        file: ev.relUrl,
        fadeMs: 0,
        stop: false,
        loop: false,
        volume: ev.volume,
        channel0: buf.channel0,
        channel1: buf.channel1,
        ...(buf.numberOfChannels !== undefined ? { numberOfChannels: buf.numberOfChannels } : {})
      })
    }

    return cues.sort((a, b) => a.timeMs - b.timeMs)
  }
}
