import type { SnippetData } from '../../../../common/types/Story'
import {
  buildBgmCues,
  collectBgmChanges,
  type BgmChangeSpec,
  type BgmCue
} from '../../../../common/audio/bgm'
import type { AudioMuxer, BgmAudioCue, BgmVolumeTweenPoint } from './AudioMuxer'
import { ExportLogger } from './ExportLogger'
import { resolveBgmUrl } from '../../utils/ResourceUrl'

export interface BgmLoopMetadata {
  loopStartMs: number
  loopEndMs: number
  loopStartSample?: number
  loopEndSample?: number
  sampleRate?: number
}

export interface BgmVolumeSpec {
  snippetIndex: number
  volume: number
  durationMs: number
  delayMs: number
}

export function collectBgmVolumeSpecs(snippets: SnippetData[]): BgmVolumeSpec[] {
  const specs: BgmVolumeSpec[] = []
  snippets.forEach((snippet, snippetIndex) => {
    if (snippet.type !== 'BgmVolume') return
    specs.push({
      snippetIndex,
      volume: Math.max(0, Math.min(2, Number(snippet.data.volume) || 0)),
      durationMs: Math.max(0, Number(snippet.data.duration) || 0),
      delayMs: Math.max(0, (Number(snippet.delay) || 0) * 1000)
    })
  })
  return specs
}

export function buildBgmVolumeTweens(
  specs: ReadonlyArray<BgmVolumeSpec>,
  startTimesMs: ReadonlyArray<number>,
  startTimesIncludeDelay = false
): BgmVolumeTweenPoint[] {
  return specs
    .map((spec) => {
      const baseMs = startTimesMs[spec.snippetIndex] ?? 0
      const timeMs = baseMs + (startTimesIncludeDelay ? 0 : spec.delayMs)
      return {
        timeMs: Math.max(0, timeMs),
        volume: spec.volume,
        durationMs: spec.durationMs
      }
    })
    .sort((a, b) => a.timeMs - b.timeMs)
}

export type BuiltBgmCueList = BgmAudioCue[] & {
  volumeTweens?: BgmVolumeTweenPoint[]
}

/**
 * 一次导出的 BGM 计划：
 * - 加载故事里 ChangeBgm 引用到的文件，同时顺带读取可选 `.loop.json` 循环点元数据；
 * - 提取 `BgmVolume` (`PlayMode 4`) 渐变点并挂到 `build()` 返回的队列上供 `AudioMuxer` 消费。
 */
export class BgmPlan {
  private readonly changes: BgmChangeSpec[]
  private readonly volumeSpecs: BgmVolumeSpec[]
  private readonly buffers = new Map<string, AudioBuffer>()
  private readonly loops = new Map<string, BgmLoopMetadata>()
  private readonly loopByBuffer = new WeakMap<AudioBuffer, BgmLoopMetadata>()
  private readonly logger: ExportLogger = new ExportLogger('BgmPlan')

  constructor(snippets: SnippetData[]) {
    this.changes = collectBgmChanges(snippets)
    this.volumeSpecs = collectBgmVolumeSpecs(snippets)
  }

  get hasChanges(): boolean {
    return this.changes.length > 0 || this.volumeSpecs.length > 0
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
    if (files.length === 0) return

    const MAX_CONCURRENCY = 4
    let cursor = 0
    const workerCount = Math.min(MAX_CONCURRENCY, files.length)

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (cursor < files.length) {
          const file = files[cursor++]
          const url = resolveBgmUrl(`audio/bgm/${file}`)
          this.logger.info(`Loading story BGM: ${file} (${url})`)
          const [buffer, loopMeta] = await Promise.all([
            audioMuxer.loadBGMBuffer(url),
            this.loadLoopSidecar(url)
          ])
          if (buffer) {
            this.buffers.set(file, buffer)
            if (loopMeta) {
              this.loops.set(file, loopMeta)
              this.loopByBuffer.set(buffer, loopMeta)
            }
          } else {
            this.logger.warn(`Story BGM missing or decode failed, cue skipped: ${file}`)
          }
        }
      })
    )
  }

  private async loadLoopSidecar(bgmUrl: string): Promise<BgmLoopMetadata | null> {
    if (typeof fetch === 'undefined') return null
    try {
      const resp = await fetch(`${bgmUrl}.loop.json`)
      if (!resp.ok) return null
      const parsed = (await resp.json()) as Partial<BgmLoopMetadata>
      if (
        typeof parsed.loopStartMs === 'number' &&
        typeof parsed.loopEndMs === 'number' &&
        parsed.loopEndMs > parsed.loopStartMs
      ) {
        return {
          loopStartMs: parsed.loopStartMs,
          loopEndMs: parsed.loopEndMs,
          ...(typeof parsed.loopStartSample === 'number'
            ? { loopStartSample: parsed.loopStartSample }
            : {}),
          ...(typeof parsed.loopEndSample === 'number'
            ? { loopEndSample: parsed.loopEndSample }
            : {}),
          ...(typeof parsed.sampleRate === 'number' ? { sampleRate: parsed.sampleRate } : {})
        }
      }
      return null
    } catch {
      return null
    }
  }

  buildVolumeTweens(
    startTimesMs: ReadonlyArray<number>,
    startTimesIncludeDelay = false
  ): BgmVolumeTweenPoint[] {
    return buildBgmVolumeTweens(this.volumeSpecs, startTimesMs, startTimesIncludeDelay)
  }

  /**
   * @param startTimesMs 每个片段的起始时间；record 模式传入实际时间（含 delay）
   * @param globalBuffer 若剧本未禁用背景音乐且配置了全局 BGM，则作为兜底音轨
   * @param startTimesIncludeDelay 起始时间是否已经包含片段 delay
   */
  build(
    startTimesMs: ReadonlyArray<number>,
    globalBuffer: AudioBuffer | null = null,
    startTimesIncludeDelay = false
  ): BuiltBgmCueList {
    const normalizedChanges = startTimesIncludeDelay
      ? this.changes.map((change) => ({ ...change, delayMs: 0 }))
      : this.changes
    const baseCues = buildBgmCues(normalizedChanges, startTimesMs, this.buffers, globalBuffer)
    const enriched: BuiltBgmCueList = baseCues.map((cue: BgmCue<AudioBuffer>) => {
      const loop = cue.buffer ? this.loopByBuffer.get(cue.buffer) : undefined
      return {
        ...cue,
        ...(loop
          ? {
              loopStartMs: loop.loopStartMs,
              loopEndMs: loop.loopEndMs,
              loopStartSample: loop.loopStartSample,
              loopEndSample: loop.loopEndSample,
              sourceSampleRate: loop.sampleRate
            }
          : {})
      }
    })
    enriched.volumeTweens = this.buildVolumeTweens(startTimesMs, startTimesIncludeDelay)
    return enriched
  }

  /** 生成供原生 Rust `mixAudioPlan` 使用的路径级 cue 描述（无需浏览器解音频）。 */
  public getRustCues(
    startTimesMs: ReadonlyArray<number>,
    startTimesIncludeDelay = false
  ): {
    cues: Array<{
      timeMs: number
      fadeMs: number
      stop: boolean
      relPath?: string
      volume: number
    }>
    volumeTweens: BgmVolumeTweenPoint[]
  } {
    const cues = this.changes.map((change) => ({
      timeMs: Math.max(
        0,
        (startTimesMs[change.snippetIndex] ?? 0) + (startTimesIncludeDelay ? 0 : change.delayMs)
      ),
      fadeMs: change.fadeMs,
      stop: change.stop,
      ...(change.stop ? {} : { relPath: `audio/bgm/${change.file}` }),
      volume: change.stop ? 0 : change.volume
    }))
    return {
      cues,
      volumeTweens: this.buildVolumeTweens(startTimesMs, startTimesIncludeDelay)
    }
  }
}
