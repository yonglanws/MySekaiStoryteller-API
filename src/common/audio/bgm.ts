import type { SnippetData } from '../types/Story'

/** 默认淡入淡出时长（毫秒） */
export const DEFAULT_BGM_FADE_MS = 600
export const MAX_BGM_FADE_MS = 10_000

/** 剧本里的一次 BGM 切换/停止，位置由片段索引决定。 */
export interface BgmChangeSpec {
  snippetIndex: number
  /** 相对 resources/audio/bgm/ 的文件名；stop=true 时为空 */
  file: string
  stop: boolean
  fadeMs: number
  /** 相对音量（PJSK SetBgmVolume）；旧故事缺省为 1 */
  volume: number
  /** 片段自身的 delay（毫秒）；cue 真正生效的时间 = 片段起点 + delay */
  delayMs: number
}

/** 音频层实际混音用的 BGM 时间点。 */
export interface BgmCue<TBuffer = unknown> {
  timeMs: number
  fadeMs: number
  stop: boolean
  buffer: TBuffer | null
  volume: number
}

/**
 * 统一 BGM 文件写法：允许 `resources/audio/bgm/x.mp3`、`audio/bgm/x.mp3`
 * 或直接 `x.mp3`，去掉越级路径段，返回相对 audio/bgm/ 的路径。
 */
export function normalizeBgmFile(value: unknown): string {
  if (typeof value !== 'string') return ''
  const parts = value
    .replace(/\\/g, '/')
    .trim()
    .split('/')
    .filter((part) => Boolean(part) && part !== '.' && part !== '..')
  if (parts.length === 0) return ''
  if (parts[0] === 'resources') parts.shift()
  if (parts[0] === 'audio') parts.shift()
  if (parts[0] === 'bgm') parts.shift()
  return parts.join('/')
}

/** 从剧本片段里提取 BGM 变更；没有 ChangeBgm 的旧故事返回空数组。 */
export function collectBgmChanges(snippets: SnippetData[]): BgmChangeSpec[] {
  const changes: BgmChangeSpec[] = []
  for (const [snippetIndex, snippet] of snippets.entries()) {
    if (snippet.type !== 'ChangeBgm') continue
    const file = normalizeBgmFile(snippet.data.file)
    const stop = snippet.data.stop === true
    if (!stop && !file) continue
    const rawFade = snippet.data.fadeMs
    const fadeMs = Number.isFinite(rawFade)
      ? Math.min(MAX_BGM_FADE_MS, Math.max(0, rawFade))
      : DEFAULT_BGM_FADE_MS
    const volume = Number.isFinite(snippet.data.volume)
      ? Math.max(0, Math.min(2, snippet.data.volume))
      : 1
    changes.push({
      snippetIndex,
      file: stop ? '' : file,
      stop,
      fadeMs,
      volume,
      delayMs: Math.max(0, (snippet.delay || 0) * 1000)
    })
  }
  return changes
}

/**
 * 把 BGM 变更和片段起始时间合成混音时间点。
 *
 * - 故事里只要出现过带文件的 ChangeBgm，就不再混全局默认 BGM；
 * - 只有 stop 时，全局默认 BGM 从 0 开始播放，在 stop 处淡出；
 * - 加载失败的文件会被跳过，避免整段导出失败。
 */
export function buildBgmCues<TBuffer>(
  changes: BgmChangeSpec[],
  startTimesMs: ReadonlyArray<number>,
  buffers: ReadonlyMap<string, TBuffer>,
  globalBuffer: TBuffer | null
): BgmCue<TBuffer>[] {
  const hasStoryFiles = changes.some((change) => !change.stop)
  const cues: BgmCue<TBuffer>[] = []

  for (const change of changes) {
    const timeMs = Math.max(0, (startTimesMs[change.snippetIndex] ?? 0) + change.delayMs)
    if (change.stop) {
      cues.push({ timeMs, fadeMs: change.fadeMs, stop: true, buffer: null, volume: 0 })
      continue
    }
    const buffer = buffers.get(change.file)
    if (!buffer) continue
    cues.push({ timeMs, fadeMs: change.fadeMs, stop: false, buffer, volume: change.volume })
  }

  if (!hasStoryFiles && globalBuffer) {
    cues.unshift({ timeMs: 0, fadeMs: 0, stop: false, buffer: globalBuffer, volume: 1 })
  }
  cues.sort((a, b) => a.timeMs - b.timeMs)
  return cues
}

export interface BgmSampleCue {
  timeMs: number
  fadeMs: number
  stop: boolean
  channel0: Float32Array | null
  channel1: Float32Array | null
  /** 相对音量，缺省 1 */
  volume?: number
}

export interface BgmMixStats {
  cueCount: number
  segments: number
  skipped: number
}

function normalizeFadeSamples(fadeMs: number, durationSamples: number, sampleRate: number): number {
  if (!Number.isFinite(fadeMs) || fadeMs <= 0) return 0
  return Math.min(Math.round((fadeMs / 1000) * sampleRate), durationSamples)
}

/**
 * 按时间点把多段 BGM 混进左右声道。
 *
 * 每段从自己的 timeMs 开始循环播放，到下一个 cue（换曲或 stop）为止；
 * 新曲用 cue.fadeMs 淡入，旧曲用同一个 fadeMs 淡出，形成交叉淡化。
 */
export function mixBgmCueSamples(
  cues: BgmSampleCue[],
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  volume: number
): BgmMixStats {
  const sorted = [...cues].sort((a, b) => a.timeMs - b.timeMs)
  const totalSamples = Math.min(left.length, right.length)
  const starts = sorted.map((cue) =>
    Math.max(0, Math.min(totalSamples, Math.floor((cue.timeMs / 1000) * sampleRate)))
  )

  let segments = 0
  let skipped = 0

  for (let index = 0; index < sorted.length; index++) {
    const cue = sorted[index]
    if (cue.stop || !cue.channel0 || cue.channel0.length === 0) {
      skipped++
      continue
    }

    const start = starts[index]
    const next = sorted[index + 1]
    // 换曲/停止时旧曲继续淡出，与下一首的淡入重叠，形成交叉淡化
    const rawFadeOut = next
      ? normalizeFadeSamples(next.fadeMs, totalSamples - start, sampleRate)
      : 0
    const end = Math.min(totalSamples, (next ? starts[index + 1] : totalSamples) + rawFadeOut)
    if (end <= start) {
      skipped++
      continue
    }

    const duration = end - start
    const fadeIn = normalizeFadeSamples(cue.fadeMs, duration, sampleRate)
    const fadeOut = Math.min(rawFadeOut, duration)
    const cueVolume = Number.isFinite(cue.volume) ? Math.max(0, cue.volume!) : 1
    const source0 = cue.channel0
    const source1 = cue.channel1 ?? cue.channel0
    const sourceLength = source0.length
    let sourceIndex = 0

    for (let sample = start; sample < end; sample++) {
      let gain = 1
      const local = sample - start
      if (fadeIn > 0 && local < fadeIn) gain = local / fadeIn
      if (fadeOut > 0) {
        const remaining = end - sample
        if (remaining <= fadeOut) gain = Math.min(gain, remaining / fadeOut)
      }
      left[sample] += source0[sourceIndex] * volume * cueVolume * gain
      right[sample] +=
        (sourceIndex < source1.length ? source1[sourceIndex] : source0[sourceIndex]) *
        volume *
        cueVolume *
        gain
      sourceIndex++
      if (sourceIndex >= sourceLength) sourceIndex = 0
    }
    segments++
  }

  return { cueCount: sorted.length, segments, skipped }
}
