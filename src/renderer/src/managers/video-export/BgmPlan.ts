import type { SnippetData } from '../../../../common/types/Story'
import {
  buildBgmCues,
  collectBgmChanges,
  type BgmChangeSpec,
  type BgmCue
} from '../../../../common/audio/bgm'
import type { AudioMuxer } from './AudioMuxer'
import { ExportLogger } from './ExportLogger'
import { resolveBgmUrl } from '../../utils/ResourceUrl'

/**
 * 一次导出的 BGM 计划：
 * - 只加载故事里 ChangeBgm 引用到的文件；
 * - 没有 ChangeBgm 引用文件时，保留旧的全局 bgm.yaml 行为；
 * - cue 的播放位置在时间线确定后由 build() 计算（Talk 的 TTS 时长会改变后续时间点）。
 */
export class BgmPlan {
  private readonly changes: BgmChangeSpec[]
  private readonly buffers = new Map<string, AudioBuffer>()
  private readonly logger: ExportLogger = new ExportLogger('BgmPlan')

  constructor(snippets: SnippetData[]) {
    this.changes = collectBgmChanges(snippets)
  }

  get hasChanges(): boolean {
    return this.changes.length > 0
  }

  /** 故事里是否有换曲（而不是只有 stop）；有换曲时不再混全局默认 BGM。 */
  get hasStoryFiles(): boolean {
    return this.changes.some((change) => !change.stop)
  }

  get hasLoadedFiles(): boolean {
    return this.buffers.size > 0
  }

  get fileCount(): number {
    return new Set(this.changes.filter((change) => !change.stop).map((change) => change.file)).size
  }

  async load(audioMuxer: AudioMuxer): Promise<void> {
    const files = [...new Set(this.changes.filter((change) => !change.stop).map((c) => c.file))]
    for (const file of files) {
      const url = resolveBgmUrl(`audio/bgm/${file}`)
      this.logger.info(`Loading story BGM: ${file} (${url})`)
      const buffer = await audioMuxer.loadBGMBuffer(url)
      if (buffer) {
        this.buffers.set(file, buffer)
        this.logger.info(`Story BGM loaded: ${file}, duration=${buffer.duration.toFixed(2)}s`)
      } else {
        this.logger.warn(`Story BGM failed to load, skipped: ${file}`)
      }
    }
  }

  build(
    startTimesMs: ReadonlyArray<number>,
    globalBuffer: AudioBuffer | null
  ): BgmCue<AudioBuffer>[] {
    return buildBgmCues(this.changes, startTimesMs, this.buffers, globalBuffer)
  }
}
