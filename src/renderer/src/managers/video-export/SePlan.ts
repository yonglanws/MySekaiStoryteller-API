import type { SnippetData } from '../../../../common/types/Story'
import {
  buildSeCues,
  collectSeChanges,
  type SeBuffer,
  type SeBufferCue,
  type SeChangeSpec
} from '../../../../common/audio/se'
import type { AudioMuxer } from './AudioMuxer'
import { ExportLogger } from './ExportLogger'
import { resolveSeUrl } from '../../utils/ResourceUrl'

/**
 * 一次导出的 SE 计划：
 * - 只加载故事里 PlaySe 引用到的文件；
 * - cue 时间点由时间线决定（record 模式用实际片段起始时间，已包含 delay）。
 */
export class SePlan {
  private readonly changes: SeChangeSpec[]
  private readonly buffers = new Map<string, SeBuffer>()
  private readonly logger: ExportLogger = new ExportLogger('SePlan')

  constructor(snippets: SnippetData[]) {
    this.changes = collectSeChanges(snippets)
  }

  get hasChanges(): boolean {
    return this.changes.length > 0
  }

  get hasLoadedFiles(): boolean {
    return this.buffers.size > 0
  }

  get fileCount(): number {
    return new Set(this.changes.filter((change) => !change.stop).map((change) => change.file)).size
  }

  async load(audioMuxer: AudioMuxer): Promise<void> {
    const files = [...new Set(this.changes.filter((change) => !change.stop).map((c) => c.file))]
    const pending = [...files]
    const worker = async (): Promise<void> => {
      while (pending.length > 0) {
        const file = pending.shift()
        if (!file) continue
        const url = resolveSeUrl(`audio/se/${file}`)
        try {
          const response = await fetch(url)
          if (!response.ok) {
            this.logger.warn(`SE ${file} failed: HTTP ${response.status}`)
            continue
          }
          const decoded = await audioMuxer.decodeAudioData(await response.arrayBuffer())
          const channel0 = decoded.getChannelData(0)
          const channel1 =
            decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : decoded.getChannelData(0)
          this.buffers.set(file, { channel0, channel1 })
        } catch (error) {
          this.logger.warn(
            `SE ${file} failed to load: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker))
  }

  /**
   * @param startTimesMs 每个片段的起始时间；record 模式传入实际时间（含 delay）
   * @param startTimesIncludeDelay 起始时间是否已经包含片段 delay
   */
  build(startTimesMs: ReadonlyArray<number>, startTimesIncludeDelay = false): SeBufferCue[] {
    return buildSeCues(this.changes, startTimesMs, this.buffers, startTimesIncludeDelay)
  }
}
