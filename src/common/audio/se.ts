import type { SnippetData } from '../types/Story'

/** 相对 resources/audio/se/ 的路径归一化。 */
export function normalizeSeFile(value: unknown): string {
  if (typeof value !== 'string') return ''
  const parts = value
    .replace(/\\/g, '/')
    .trim()
    .split('/')
    .filter((part) => Boolean(part) && part !== '.' && part !== '..')
  if (parts.length === 0) return ''
  if (parts[0] === 'resources') parts.shift()
  if (parts[0] === 'audio') parts.shift()
  if (parts[0] === 'se') parts.shift()
  return parts.join('/')
}

/** 剧本里的一次 SE 播放/停止，位置由片段索引 + delay 决定。 */
export interface SeChangeSpec {
  snippetIndex: number
  file: string
  stop: boolean
  volume: number
  loop: boolean
  fadeMs: number
  delayMs: number
}

/** 从剧本片段提取 SE 事件；旧故事没有 PlaySe/StopSe 时返回空数组。 */
export function collectSeChanges(snippets: SnippetData[]): SeChangeSpec[] {
  const changes: SeChangeSpec[] = []
  for (const [snippetIndex, snippet] of snippets.entries()) {
    if (snippet.type === 'PlaySe') {
      const file = normalizeSeFile(snippet.data.file)
      if (!file) continue
      changes.push({
        snippetIndex,
        file,
        stop: false,
        volume: Math.max(0, snippet.data.volume ?? 1),
        loop: snippet.data.loop === true,
        fadeMs: Math.max(0, snippet.data.fadeMs ?? 0),
        delayMs: Math.max(0, (snippet.delay ?? 0) * 1000)
      })
    } else if (snippet.type === 'StopSe') {
      const file = normalizeSeFile(snippet.data.file)
      if (!file) continue
      changes.push({
        snippetIndex,
        file,
        stop: true,
        volume: 0,
        loop: false,
        fadeMs: Math.max(0, snippet.data.fadeMs ?? 0),
        delayMs: Math.max(0, (snippet.delay ?? 0) * 1000)
      })
    }
  }
  return changes
}

export interface SeBufferCue {
  timeMs: number
  file: string
  stop: boolean
  volume: number
  loop: boolean
  fadeMs: number
  channel0: Float32Array | null
  channel1: Float32Array | null
}

export interface SeBuffer {
  channel0: Float32Array
  channel1: Float32Array
}

/** 把 SE 变更和片段起始时间合成为混音事件；加载失败的文件跳过。 */
export function buildSeCues(
  changes: SeChangeSpec[],
  startTimesMs: ReadonlyArray<number>,
  buffers: ReadonlyMap<string, SeBuffer>,
  startTimesIncludeDelay = false
): SeBufferCue[] {
  const cues: SeBufferCue[] = []
  for (const change of changes) {
    const base = Math.max(0, startTimesMs[change.snippetIndex] ?? 0)
    const timeMs = base + (startTimesIncludeDelay ? 0 : change.delayMs)
    if (change.stop) {
      cues.push({
        timeMs,
        file: change.file,
        stop: true,
        volume: 0,
        loop: false,
        fadeMs: change.fadeMs,
        channel0: null,
        channel1: null
      })
      continue
    }
    const buffer = buffers.get(change.file)
    if (!buffer) continue
    cues.push({
      timeMs,
      file: change.file,
      stop: false,
      volume: change.volume,
      loop: change.loop,
      fadeMs: change.fadeMs,
      channel0: buffer.channel0,
      channel1: buffer.channel1
    })
  }
  cues.sort((a, b) => a.timeMs - b.timeMs)
  return cues
}

export interface SeMixStats {
  events: number
  oneShots: number
  loops: number
  skipped: number
}

function sampleIndex(timeMs: number, sampleRate: number, totalSamples: number): number {
  return Math.max(0, Math.min(totalSamples, Math.floor((timeMs / 1000) * sampleRate)))
}

/** 单个循环实例：从 start 到 end，volume 事件按时间插值。 */
interface LoopInstance {
  channel0: Float32Array
  channel1: Float32Array
  start: number
  end: number
  volumes: Array<{ sample: number; volume: number; fadeSamples: number }>
}

/**
 * 把 SE 事件混进左右声道。
 *
 * - 一次性 SE 从头播到尾；fadeMs > 0 时线性淡入。
 * - loop SE 维护一个实例；同一文件再次 PlaySe 视为音量渐变，StopSe 在指定点淡出。
 */
export function mixSeCueSamples(
  cues: SeBufferCue[],
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  globalVolume: number
): SeMixStats {
  const totalSamples = Math.min(left.length, right.length)
  const sorted = [...cues].sort((a, b) => a.timeMs - b.timeMs)
  const loops = new Map<string, LoopInstance>()
  const closedLoops: LoopInstance[] = []
  let oneShots = 0
  let loopCount = 0
  let skipped = 0

  const closeLoop = (file: string, atSample: number, fadeSamples: number): void => {
    const instance = loops.get(file)
    if (!instance) return
    instance.end = Math.min(totalSamples, Math.max(instance.start, atSample))
    if (fadeSamples > 0) {
      const fade = Math.min(fadeSamples, instance.end - instance.start)
      instance.volumes.push({
        sample: Math.max(instance.start, instance.end - fade),
        volume: 0,
        fadeSamples: fade
      })
    }
    closedLoops.push(instance)
    loops.delete(file)
  }

  for (const cue of sorted) {
    const at = sampleIndex(cue.timeMs, sampleRate, totalSamples)
    if (cue.stop) {
      closeLoop(cue.file, at, Math.round((cue.fadeMs / 1000) * sampleRate))
      continue
    }
    if (!cue.channel0 || cue.channel0.length === 0) {
      skipped++
      continue
    }

    if (cue.loop) {
      const existing = loops.get(cue.file)
      if (existing) {
        existing.volumes.push({
          sample: at,
          volume: cue.volume,
          fadeSamples: Math.round((cue.fadeMs / 1000) * sampleRate)
        })
      } else {
        loops.set(cue.file, {
          channel0: cue.channel0,
          channel1: cue.channel1 ?? cue.channel0,
          start: at,
          end: totalSamples,
          volumes: [
            {
              sample: at,
              volume: cue.volume,
              fadeSamples: Math.round((cue.fadeMs / 1000) * sampleRate)
            }
          ]
        })
        loopCount++
      }
      continue
    }

    // 一次性 SE
    const source0 = cue.channel0
    const source1 = cue.channel1 ?? cue.channel0
    const end = Math.min(totalSamples, at + source0.length)
    const fade = Math.min(Math.round((cue.fadeMs / 1000) * sampleRate), Math.max(0, end - at))
    for (let sample = at; sample < end; sample++) {
      const local = sample - at
      const gain = fade > 0 && local < fade ? local / fade : 1
      const sourceIndex = local
      left[sample] += source0[sourceIndex] * cue.volume * globalVolume * gain
      right[sample] +=
        (sourceIndex < source1.length ? source1[sourceIndex] : source0[sourceIndex]) *
        cue.volume *
        globalVolume *
        gain
    }
    oneShots++
  }

  for (const file of [...loops.keys()]) {
    closeLoop(file, totalSamples, 0)
  }

  for (const instance of closedLoops) {
    if (instance.end <= instance.start) continue
    const source0 = instance.channel0
    const source1 = instance.channel1
    const sourceLength = source0.length
    if (sourceLength === 0) continue
    const volumes = instance.volumes
      .map((entry) => ({
        sample: Math.max(instance.start, Math.min(instance.end, entry.sample)),
        volume: entry.volume,
        fadeSamples: entry.fadeSamples
      }))
      .sort((a, b) => a.sample - b.sample)
    let volumeIndex = 0
    let currentVolume = volumes[0]?.volume ?? 0
    let fadeStart = instance.start
    let fadeFrom = 0
    let fadeTo = currentVolume
    let fadeSamples = volumes[0]?.fadeSamples ?? 0

    for (let sample = instance.start; sample < instance.end; sample++) {
      while (volumeIndex + 1 < volumes.length && sample >= volumes[volumeIndex + 1].sample) {
        volumeIndex++
        fadeFrom = currentVolume
        fadeTo = volumes[volumeIndex].volume
        fadeStart = sample
        fadeSamples = volumes[volumeIndex].fadeSamples
        currentVolume = fadeTo
      }
      let gain = currentVolume
      if (fadeSamples > 0) {
        const local = sample - fadeStart
        if (local < fadeSamples) gain = fadeFrom + (fadeTo - fadeFrom) * (local / fadeSamples)
      }
      const sourceIndex = (sample - instance.start) % sourceLength
      left[sample] += source0[sourceIndex] * gain * globalVolume
      right[sample] +=
        (sourceIndex < source1.length ? source1[sourceIndex] : source0[sourceIndex]) *
        gain *
        globalVolume
    }
  }

  return { events: sorted.length, oneShots, loops: loopCount, skipped }
}
