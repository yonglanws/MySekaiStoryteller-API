import { ExportLogger } from './ExportLogger'
import { mixBgmCueSamples, type BgmCue, type BgmSampleCue } from '../../../../common/audio/bgm'
import { mixSeCueSamples, type SeBufferCue } from '../../../../common/audio/se'

export const ACF_GAIN_BGM = 0.75
export const ACF_GAIN_SE = 0.8
export const ACF_GAIN_VOICE = 0.9
export const MONO_PAN_GAIN = Math.SQRT1_2

export const VOICE_DUCK_LEVEL = 0.65
export const VOICE_DUCK_RELEASE_SEC = 0.5
export const VOICE_DUCK_CURVE_STRENGTH = 0.5

export const SE_DUCK_LEVEL = 0.8
export const SE_DUCK_RELEASE_SEC = 0.5

export interface DuckSpan {
  startSample: number
  endSample: number | null
  kind: 'voice' | 'se'
}

export interface BgmVolumeTweenPoint {
  timeMs: number
  volume: number
  durationMs: number
}

export type BgmAudioCue = BgmCue<AudioBuffer> & {
  loopStartMs?: number
  loopEndMs?: number
  loopStartSample?: number
  loopEndSample?: number
  sourceSampleRate?: number
}
export type SeAudioCue = SeBufferCue & { numberOfChannels?: number; snippetIndex?: number }

/** CRI `SquareReverse(s)`: `1 - (1 - x)^(1 + s)` (`sse-mix/src/lib.rs:122`). */
export function evaluateDuckReleaseCurve(kind: 'voice' | 'se', x: number): number {
  const clamped = Math.max(0, Math.min(1, x))
  if (kind === 'voice') {
    return 1 - Math.pow(1 - clamped, 1 + VOICE_DUCK_CURVE_STRENGTH)
  }
  return clamped
}

/**
 * 1:1 对齐 `ProjectSekai.acf` REACT 自动闪避曲线：
 * - Voice 期间压低 BGM 至 `0.65x`，结束后 `0.5s` 内按 `SquareReverse(0.5)` 恢复；
 * - SE 期间压低 BGM 至 `0.80x`，结束后 `0.5s` 内按线性恢复；
 * - 多段重叠取更深的最小值（`min`）。
 */
export function computeBgmDuckGainBuffer(
  totalSamples: number,
  sampleRate: number,
  spans: ReadonlyArray<DuckSpan>
): Float32Array {
  const gains = new Float32Array(totalSamples)
  gains.fill(1)
  if (totalSamples <= 0 || spans.length === 0) return gains

  for (const span of spans) {
    const level = span.kind === 'voice' ? VOICE_DUCK_LEVEL : SE_DUCK_LEVEL
    const releaseSec = span.kind === 'voice' ? VOICE_DUCK_RELEASE_SEC : SE_DUCK_RELEASE_SEC
    const start = Math.max(0, Math.min(totalSamples, Math.round(span.startSample)))
    const end =
      span.endSample === null
        ? totalSamples
        : Math.max(start, Math.min(totalSamples, Math.round(span.endSample)))

    for (let i = start; i < end; i++) {
      if (level < gains[i]) gains[i] = level
    }

    if (span.endSample !== null) {
      const releaseStart = Math.max(0, Math.round(span.endSample))
      const releaseSamples = Math.max(1, Math.round(releaseSec * sampleRate))
      const releaseEnd = Math.min(totalSamples, releaseStart + releaseSamples)
      for (let i = releaseStart; i < releaseEnd; i++) {
        const x = (i - releaseStart) / releaseSamples
        const v = level + (1 - level) * evaluateDuckReleaseCurve(span.kind, x)
        if (v < gains[i]) gains[i] = v
      }
    }
  }
  return gains
}

/** 计算 `BgmVolume` (`PlayMode 4`) 线性渐变包络。 */
export function computeBgmVolumeTweenBuffer(
  totalSamples: number,
  sampleRate: number,
  tweens: ReadonlyArray<BgmVolumeTweenPoint>,
  initialVolume = 1
): Float32Array {
  const gains = new Float32Array(totalSamples)
  gains.fill(initialVolume)
  if (totalSamples <= 0 || tweens.length === 0) return gains

  const sorted = [...tweens].sort((a, b) => a.timeMs - b.timeMs)
  let currentVol = initialVolume
  let cursor = 0

  for (const tw of sorted) {
    const start = Math.max(cursor, Math.min(totalSamples, Math.round((tw.timeMs / 1000) * sampleRate)))
    for (let i = cursor; i < start; i++) gains[i] = currentVol

    const durSamples = Math.max(0, Math.round((tw.durationMs / 1000) * sampleRate))
    const target = Math.max(0, tw.volume)
    const end = Math.min(totalSamples, start + durSamples)
    if (end > start && durSamples > 0) {
      for (let i = start; i < end; i++) {
        const p = (i - start) / durSamples
        gains[i] = currentVol + (target - currentVol) * p
      }
    }
    currentVol = target
    cursor = end
  }
  for (let i = cursor; i < totalSamples; i++) gains[i] = currentVol
  return gains
}

export function resolveLoopSampleIndex(
  playedSamples: number,
  totalLength: number,
  loopStart?: number,
  loopEnd?: number
): number {
  if (totalLength <= 0) return 0
  if (
    loopStart !== undefined &&
    loopEnd !== undefined &&
    loopEnd > loopStart &&
    loopStart >= 0 &&
    loopEnd <= totalLength
  ) {
    if (playedSamples < loopEnd) return playedSamples
    return loopStart + ((playedSamples - loopStart) % (loopEnd - loopStart))
  }
  return playedSamples % totalLength
}

export interface AudioTrackData {
  audioBuffer: ArrayBuffer
  pcmData?: {
    channel0: Float32Array
    channel1: Float32Array
    sampleRate: number
  }
  startTime: number
  endTime: number
  characterName: string
  text: string
  /** 预合成路径记录的所属片段索引（并发合成时用于精确归属音轨） */
  snippetIndex?: number
}

export interface BGMConfig {
  enabled: boolean
  path: string
  volume: number
}

export class AudioMuxer {
  private audioContext: AudioContext | null = null
  private audioTracks: AudioTrackData[] = []
  private bgmConfig: BGMConfig | null = null
  private bgmCues: BgmAudioCue[] = []
  private bgmVolumeTweens: BgmVolumeTweenPoint[] = []
  private seCues: SeAudioCue[] = []
  private readonly logger: ExportLogger = new ExportLogger('AudioMuxer')
  private decodedBufferCache: Map<string, AudioBuffer> = new Map()

  constructor() {
    this.audioContext = null
    this.audioTracks = []
    this.bgmConfig = null
    this.bgmCues = []
    this.seCues = []
  }

  async initialize(): Promise<void> {
    try {
      if (!this.audioContext) {
        this.audioContext = new AudioContext({ sampleRate: 48000 })
        this.logger.info('AudioContext initialized', {
          sampleRate: 48000,
          state: this.audioContext.state
        })
      }
      if (this.audioContext.state === 'suspended') {
        this.logger.info('AudioContext is suspended, resuming...')
        await this.audioContext.resume()
      }
    } catch (error) {
      throw new Error(
        `Failed to initialize AudioContext: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  setBGMConfig(bgmConfig: BGMConfig): void {
    this.bgmConfig = bgmConfig
    this.logger.info('BGM config set', {
      enabled: bgmConfig.enabled,
      path: bgmConfig.path,
      volume: bgmConfig.volume
    })
  }

  /** 故事级 BGM 时间点；非空时优先于全局 bgmBuffer。 */
  setBgmCues(cues: BgmAudioCue[] & { volumeTweens?: BgmVolumeTweenPoint[] }): void {
    this.bgmCues = cues
    if (Array.isArray(cues.volumeTweens)) {
      this.bgmVolumeTweens = cues.volumeTweens
    }
    this.logger.info('BGM cues set', {
      cues: cues.length,
      files: cues.filter((cue) => !cue.stop).length,
      stops: cues.filter((cue) => cue.stop).length,
      volumeTweens: this.bgmVolumeTweens.length
    })
  }

  setBgmVolumeTweens(tweens: BgmVolumeTweenPoint[]): void {
    this.bgmVolumeTweens = tweens
  }

  hasBgmCues(): boolean {
    return this.bgmCues.some((cue) => !cue.stop && cue.buffer !== null)
  }

  /** 故事级 SE 时间点（PlaySe / StopSe）。 */
  setSeCues(cues: SeAudioCue[]): void {
    this.seCues = cues
    this.logger.info('SE cues set', {
      cues: cues.length,
      plays: cues.filter((cue) => !cue.stop).length,
      stops: cues.filter((cue) => cue.stop).length
    })
  }

  hasSeCues(): boolean {
    return this.seCues.some((cue) => !cue.stop && cue.channel0 !== null)
  }

  addAudioTrack(track: AudioTrackData): void {
    this.audioTracks.push(track)
    this.logger.info(
      `Audio track added: character="${track.characterName}", start=${track.startTime}ms, end=${track.endTime}ms, bufferSize=${track.audioBuffer.byteLength}`
    )
  }

  clearTracks(): void {
    this.audioTracks = []
    this.bgmVolumeTweens = []
    this.decodedBufferCache.clear()
  }

  async decodeAudioData(audioBuffer: ArrayBuffer): Promise<AudioBuffer> {
    const MAX_RETRIES = 3
    let lastError: Error | null = null

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        if (!this.audioContext || this.audioContext.state === 'closed') {
          this.logger.info(`AudioContext unavailable (attempt ${attempt + 1}), recreating...`)
          this.audioContext?.close()
          this.audioContext = new AudioContext({ sampleRate: 48000 })
        }

        if (this.audioContext!.state === 'suspended') {
          this.logger.info(`AudioContext suspended (attempt ${attempt + 1}), resuming...`)
          await this.audioContext!.resume()
          await new Promise((r) => setTimeout(r, 50))
        }

        const decoded = await this.audioContext!.decodeAudioData(audioBuffer.slice(0))

        if (!decoded) {
          throw new Error('decodeAudioData returned null/undefined')
        }

        return decoded
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        this.logger.warn(
          `Decode attempt ${attempt + 1}/${MAX_RETRIES} failed: ${lastError.message}`
        )

        if (attempt < MAX_RETRIES - 1) {
          this.audioContext?.close()
          this.audioContext = null
          await new Promise((r) => setTimeout(r, 100 * (attempt + 1)))
        }
      }
    }

    throw lastError || new Error('Failed to decode audio data after retries')
  }

  private async decodeAudioTrackCached(track: AudioTrackData): Promise<AudioBuffer> {
    const cacheKey = `${track.characterName}-${track.startTime}-${track.audioBuffer.byteLength}`
    let decoded = this.decodedBufferCache.get(cacheKey)

    if (!decoded) {
      decoded = await this.decodeAudioData(track.audioBuffer)
      this.decodedBufferCache.set(cacheKey, decoded)
    }

    return decoded
  }

  private async ensureAudioContextReady(): Promise<void> {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      await this.initialize()
    }
    if (this.audioContext!.state === 'suspended') {
      this.logger.info('AudioContext suspended before mixing, resuming...')
      await this.audioContext!.resume()
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  /**
   * 统一混音核心：按 `ProjectSekai.acf` 类别增益（BGM 0.75 / SE 0.80 / Voice 0.90 + 单声道 -3.01dB）、
   * HCA 循环点、`BgmVolume` 渐变、以及 Voice(0.65x, 0.5s SquareReverse) / SE(0.80x, 0.5s Linear) 自动闪避
   * 合成 48kHz 立体声缓冲区。
   */
  private async mixIntoStereoBuffers(
    outputDuration: number,
    bgmBuffer?: AudioBuffer
  ): Promise<{ leftBuffer: Float32Array; rightBuffer: Float32Array; totalSamples: number; sampleRate: number }> {
    await this.ensureAudioContextReady()

    const sampleRate = 48000
    const totalSamples = Math.ceil((outputDuration / 1000) * sampleRate)
    const leftBuffer = new Float32Array(totalSamples)
    const rightBuffer = new Float32Array(totalSamples)

    const voiceSpans = await this.mixTTSTracks(leftBuffer, rightBuffer, totalSamples, sampleRate)
    const seSpans = this.mixStorySe(leftBuffer, rightBuffer, totalSamples, sampleRate)

    if (this.bgmConfig?.enabled) {
      const duckGains = computeBgmDuckGainBuffer(totalSamples, sampleRate, [...voiceSpans, ...seSpans])
      const tweenGains = computeBgmVolumeTweenBuffer(totalSamples, sampleRate, this.bgmVolumeTweens, 1)

      if (this.bgmCues.length > 0) {
        this.mixStoryBGM(leftBuffer, rightBuffer, totalSamples, sampleRate, duckGains, tweenGains)
      } else if (bgmBuffer) {
        this.mixBGM(leftBuffer, rightBuffer, bgmBuffer, totalSamples, duckGains, tweenGains)
      }
    }

    return { leftBuffer, rightBuffer, totalSamples, sampleRate }
  }

  async mixAudioTracks(outputDuration: number, bgmBuffer?: AudioBuffer): Promise<AudioBuffer> {
    this.logger.info(
      `Mixing audio: outputDuration=${outputDuration}ms, tracks=${this.audioTracks.length}, hasBGM=${!!bgmBuffer}`
    )
    const { leftBuffer, rightBuffer, totalSamples, sampleRate } = await this.mixIntoStereoBuffers(
      outputDuration,
      bgmBuffer
    )
    const numChannels = 2
    const outputBuffer = this.audioContext!.createBuffer(numChannels, totalSamples, sampleRate)
    outputBuffer.getChannelData(0).set(leftBuffer)
    outputBuffer.getChannelData(1).set(rightBuffer)

    this.logger.info(
      `Audio mix output: duration=${outputBuffer.duration.toFixed(3)}s, samples=${totalSamples}, channels=${numChannels}`
    )
    return outputBuffer
  }

  private mixBGM(
    leftBuffer: Float32Array,
    rightBuffer: Float32Array,
    bgmBuffer: AudioBuffer,
    totalSamples: number,
    duckGains: Float32Array,
    tweenGains: Float32Array
  ): void {
    const bgmChannels = bgmBuffer.numberOfChannels
    const bgmTotalSamples = bgmBuffer.getChannelData(0).length
    if (bgmTotalSamples <= 0) return
    const volume = (this.bgmConfig?.volume ?? 1.0) * ACF_GAIN_BGM * (bgmChannels === 1 ? MONO_PAN_GAIN : 1)

    const bgmLeftData = bgmBuffer.getChannelData(0)
    const bgmRightData = bgmChannels > 1 ? bgmBuffer.getChannelData(1) : bgmLeftData

    for (let i = 0; i < totalSamples; i++) {
      const idx = i % bgmTotalSamples
      const g = volume * duckGains[i] * tweenGains[i]
      leftBuffer[i] += bgmLeftData[idx] * g
      rightBuffer[i] += bgmRightData[idx] * g
    }

    const loopCount = Math.ceil(totalSamples / bgmTotalSamples)
    this.logger.info(`BGM mixing complete: effectiveGain=${volume.toFixed(3)}, loops=${loopCount}`)
  }

  private resolveCueLoopSamples(
    cue: BgmAudioCue,
    sampleRate: number,
    sourceLength: number
  ): { loopStart?: number; loopEnd?: number } {
    if (
      typeof cue.loopStartSample === 'number' &&
      typeof cue.loopEndSample === 'number' &&
      cue.loopEndSample > cue.loopStartSample
    ) {
      const ratio = cue.sourceSampleRate && cue.sourceSampleRate > 0 ? sampleRate / cue.sourceSampleRate : 1
      const s = Math.max(0, Math.round(cue.loopStartSample * ratio))
      const e = Math.min(sourceLength, Math.round(cue.loopEndSample * ratio))
      if (e > s) return { loopStart: s, loopEnd: e }
    }
    if (
      typeof cue.loopStartMs === 'number' &&
      typeof cue.loopEndMs === 'number' &&
      cue.loopEndMs > cue.loopStartMs
    ) {
      const s = Math.max(0, Math.round((cue.loopStartMs / 1000) * sampleRate))
      const e = Math.min(sourceLength, Math.round((cue.loopEndMs / 1000) * sampleRate))
      if (e > s) return { loopStart: s, loopEnd: e }
    }
    return {}
  }

  /** 故事级 BGM：按 ChangeBgm 时间点 + HCA 循环区 + 交叉淡化 + ACF 增益 + 闪避包络混音。 */
  private mixStoryBGM(
    leftBuffer: Float32Array,
    rightBuffer: Float32Array,
    totalSamples: number,
    sampleRate: number,
    duckGains: Float32Array,
    tweenGains: Float32Array
  ): void {
    const hasLoopRegions = this.bgmCues.some(
      (c) => (typeof c.loopEndSample === 'number' || typeof c.loopEndMs === 'number') && !c.stop
    )
    const masterGain = (this.bgmConfig?.volume ?? 1.0) * ACF_GAIN_BGM
    const bgmL = new Float32Array(totalSamples)
    const bgmR = new Float32Array(totalSamples)

    if (!hasLoopRegions) {
      const sampleCues: BgmSampleCue[] = this.bgmCues.map((cue) => {
        if (!cue.buffer) {
          return {
            timeMs: cue.timeMs,
            fadeMs: cue.fadeMs,
            stop: cue.stop,
            channel0: null,
            channel1: null,
            volume: cue.volume
          }
        }
        const channel0 = cue.buffer.getChannelData(0)
        const isMono = cue.buffer.numberOfChannels === 1
        const channel1 = isMono ? channel0 : cue.buffer.getChannelData(1)
        const pan = isMono ? MONO_PAN_GAIN : 1
        return {
          timeMs: cue.timeMs,
          fadeMs: cue.fadeMs,
          stop: cue.stop,
          channel0,
          channel1,
          volume: (cue.volume ?? 1) * pan
        }
      })
      const stats = mixBgmCueSamples(sampleCues, bgmL, bgmR, sampleRate, masterGain)
      for (let i = 0; i < totalSamples; i++) {
        const mod = duckGains[i] * tweenGains[i]
        leftBuffer[i] += bgmL[i] * mod
        rightBuffer[i] += bgmR[i] * mod
      }
      this.logger.info(
        `Story BGM mixed: cues=${stats.cueCount}, segments=${stats.segments}, masterGain=${masterGain.toFixed(3)}`
      )
      return
    }

    const sorted = [...this.bgmCues].sort((a, b) => a.timeMs - b.timeMs)
    const starts = sorted.map((c) => Math.max(0, Math.min(totalSamples, Math.round((c.timeMs / 1000) * sampleRate))))
    let segments = 0
    for (let idx = 0; idx < sorted.length; idx++) {
      const cue = sorted[idx]
      if (cue.stop || !cue.buffer) continue
      const source0 = cue.buffer.getChannelData(0)
      if (source0.length === 0) continue
      const isMono = cue.buffer.numberOfChannels === 1
      const source1 = isMono ? source0 : cue.buffer.getChannelData(1)
      const pan = isMono ? MONO_PAN_GAIN : 1
      const start = starts[idx]
      const next = sorted[idx + 1]
      const rawFadeOut = next ? Math.min(totalSamples - start, Math.round((Math.max(0, next.fadeMs) / 1000) * sampleRate)) : 0
      const end = Math.min(totalSamples, (next ? starts[idx + 1] : totalSamples) + rawFadeOut)
      if (end <= start) continue

      const duration = end - start
      const fadeIn = cue.fadeMs > 0 ? Math.min(duration, Math.round((cue.fadeMs / 1000) * sampleRate)) : 0
      const fadeOut = Math.min(rawFadeOut, duration)
      const cueVol = (cue.volume ?? 1) * pan * masterGain
      const { loopStart, loopEnd } = this.resolveCueLoopSamples(cue, sampleRate, source0.length)

      let played = 0
      for (let sample = start; sample < end; sample++) {
        let fadeGain = 1
        const local = sample - start
        if (fadeIn > 0 && local < fadeIn) fadeGain = local / fadeIn
        if (fadeOut > 0) {
          const remaining = end - sample
          if (remaining <= fadeOut) fadeGain = Math.min(fadeGain, remaining / fadeOut)
        }
        const sIdx = resolveLoopSampleIndex(played, source0.length, loopStart, loopEnd)
        const mod = cueVol * fadeGain * duckGains[sample] * tweenGains[sample]
        leftBuffer[sample] += source0[sIdx] * mod
        rightBuffer[sample] += source1[sIdx] * mod
        played++
      }
      segments++
    }
    this.logger.info(`Story BGM mixed (HCA loop): cues=${sorted.length}, segments=${segments}`)
  }

  /** 故事级 SE：按 `ACF_GAIN_SE = 0.80` 混音并返回用于压低 BGM 的区间表。 */
  private mixStorySe(
    leftBuffer: Float32Array,
    rightBuffer: Float32Array,
    totalSamples: number,
    sampleRate: number
  ): DuckSpan[] {
    const spans: DuckSpan[] = []
    if (this.seCues.length === 0) return spans

    const activeLoopStartByKey = new Map<string, number>()
    const panCues = this.seCues.map((cue) => {
      const startSample = Math.max(0, Math.round((cue.timeMs / 1000) * sampleRate))
      const key = cue.file || String(cue.snippetIndex ?? 'loop')
      if (!cue.stop && cue.channel0) {
        if (!cue.loop) {
          spans.push({
            startSample,
            endSample: Math.min(totalSamples, startSample + cue.channel0.length),
            kind: 'se'
          })
        } else {
          activeLoopStartByKey.set(key, startSample)
        }
      } else if (cue.stop) {
        const stopFade = Math.round((Math.max(0, cue.fadeMs) / 1000) * sampleRate)
        for (const [k, sStart] of activeLoopStartByKey.entries()) {
          if (!cue.file || k === key) {
            spans.push({
              startSample: sStart,
              endSample: Math.min(totalSamples, startSample + stopFade),
              kind: 'se'
            })
            activeLoopStartByKey.delete(k)
          }
        }
      }

      const isMono = cue.numberOfChannels === 1
      if (!isMono || cue.stop) return cue
      return { ...cue, volume: cue.volume * MONO_PAN_GAIN }
    })

    for (const sStart of activeLoopStartByKey.values()) {
      spans.push({ startSample: sStart, endSample: null, kind: 'se' })
    }

    const stats = mixSeCueSamples(panCues, leftBuffer, rightBuffer, sampleRate, ACF_GAIN_SE)
    this.logger.info(
      `Story SE mixed: events=${stats.events}, oneShots=${stats.oneShots}, loops=${stats.loops}, gain=${ACF_GAIN_SE}`
    )
    return spans
  }

  private async mixTTSTracks(
    leftBuffer: Float32Array,
    rightBuffer: Float32Array,
    totalSamples: number,
    sampleRate: number
  ): Promise<DuckSpan[]> {
    const voiceSpans: DuckSpan[] = []
    if (this.audioTracks.length === 0) return voiceSpans

    interface ValidTrack {
      track: AudioTrackData
      sourceCh0: Float32Array
      sourceCh1: Float32Array
      isMono: boolean
    }

    const validTracks: ValidTrack[] = []
    const decodePromises: Promise<void>[] = []

    for (const track of this.audioTracks) {
      if (!track.audioBuffer || track.audioBuffer.byteLength === 0) {
        this.logger.warn(`Skipping empty audio track for character "${track.characterName}"`)
        continue
      }

      const startSample = Math.floor((track.startTime / 1000) * sampleRate)
      if (startSample >= totalSamples) {
        this.logger.warn(
          `Audio track for "${track.characterName}" starts at ${track.startTime}ms which is beyond output duration, skipping`
        )
        continue
      }

      if (track.pcmData && track.pcmData.channel0.length > 0) {
        validTracks.push({
          track,
          sourceCh0: track.pcmData.channel0,
          sourceCh1: track.pcmData.channel1,
          isMono: track.pcmData.channel0 === track.pcmData.channel1
        })
      } else {
        const decodePromise = this.decodeAudioTrackCached(track).then((decoded) => {
          if (!decoded || typeof decoded.getChannelData !== 'function') {
            this.logger.warn(`Decoded buffer invalid for "${track.characterName}", skipping`)
            return
          }
          const ch0 = decoded.getChannelData(0)
          const isMono = decoded.numberOfChannels <= 1
          const ch1 = isMono ? ch0 : decoded.getChannelData(1)
          validTracks.push({ track, sourceCh0: ch0, sourceCh1: ch1, isMono })
        })
        decodePromises.push(decodePromise)
      }
    }

    await Promise.all(decodePromises)

    let mixedTrackCount = 0
    let skippedTrackCount = 0
    let totalSampleCount = 0

    for (const { track, sourceCh0, sourceCh1, isMono } of validTracks) {
      try {
        if (!sourceCh0 || sourceCh0.length === 0) {
          this.logger.warn(`Empty channel data for "${track.characterName}", skipping`)
          skippedTrackCount++
          continue
        }

        const startSample = Math.floor((track.startTime / 1000) * sampleRate)
        const endSample = Math.min(startSample + sourceCh0.length, totalSamples)
        if (startSample >= totalSamples) {
          skippedTrackCount++
          continue
        }

        voiceSpans.push({ startSample, endSample, kind: 'voice' })

        const volumeScale = ACF_GAIN_VOICE * (isMono ? MONO_PAN_GAIN : 1)
        const ch0 = sourceCh0
        const ch1 = sourceCh1
        const leftBuf = leftBuffer
        const rightBuf = rightBuffer

        for (let i = startSample; i < endSample; i++) {
          const sourceIndex = i - startSample
          leftBuf[i] += ch0[sourceIndex] * volumeScale
          rightBuf[i] += ch1[sourceIndex] * volumeScale
        }

        mixedTrackCount++
        totalSampleCount += endSample - startSample
      } catch (error) {
        this.logger.error(
          `Failed to mix audio track for character "${track.characterName}": ${error instanceof Error ? error.message : String(error)}`,
          error
        )
        skippedTrackCount++
      }
    }

    this.logger.info(
      `Track mixing complete: mixed=${mixedTrackCount}, skipped=${skippedTrackCount}, totalSamples=${totalSampleCount}`
    )
    return voiceSpans
  }

  async loadBGMBuffer(bgmPath: string): Promise<AudioBuffer | null> {
    if (!this.audioContext) {
      await this.initialize()
    }

    try {
      this.logger.info(`Loading BGM from: ${bgmPath}`)
      const response = await fetch(bgmPath)
      if (!response.ok) {
        this.logger.error(`Failed to load BGM file: ${bgmPath}, status: ${response.status}`)
        return null
      }

      const arrayBuffer = await response.arrayBuffer()
      this.logger.info(`BGM file loaded: size=${(arrayBuffer.byteLength / 1024).toFixed(1)} KB`)
      const decodedBuffer = await this.decodeAudioData(arrayBuffer)
      this.logger.info(
        `BGM decoded: duration=${decodedBuffer.duration.toFixed(2)}s, channels=${decodedBuffer.numberOfChannels}, sampleRate=${decodedBuffer.sampleRate}`
      )
      return decodedBuffer
    } catch (error) {
      this.logger.error(
        `Failed to load BGM: ${error instanceof Error ? error.message : String(error)}`,
        error
      )
      return null
    }
  }

  /**
   * 混音直出 Int16 交错 PCM（48kHz 立体声）。
   * 与 mixAudioTracks + audioBufferToWav 的数学完全一致（BGM 循环、TTS 0.5 缩放、
   * clamp、×0x8000/×0x7fff、L/R 交错），省去全时长 Float32Array 对、AudioBuffer
   * 拷贝与逐样本 DataView.setInt16——3 分钟立体声从千万次调用降为一次遍历。
   */
  async mixToInt16Interleaved(
    outputDuration: number,
    bgmBuffer?: AudioBuffer
  ): Promise<Int16Array> {
    this.logger.info(
      `Mixing audio (int16 direct): outputDuration=${outputDuration}ms, tracks=${this.audioTracks.length}, hasBGM=${!!bgmBuffer}`
    )
    const { leftBuffer, rightBuffer, totalSamples } = await this.mixIntoStereoBuffers(
      outputDuration,
      bgmBuffer
    )

    const pcm = new Int16Array(totalSamples * 2)
    for (let i = 0; i < totalSamples; i++) {
      let left = leftBuffer[i]
      let right = rightBuffer[i]
      left = left < -1 ? -1 : left > 1 ? 1 : left
      right = right < -1 ? -1 : right > 1 ? 1 : right
      pcm[i * 2] = left < 0 ? left * 0x8000 : left * 0x7fff
      pcm[i * 2 + 1] = right < 0 ? right * 0x8000 : right * 0x7fff
    }

    this.logger.info(`Int16 interleaved PCM: samples=${totalSamples}, bytes=${pcm.byteLength}`)
    return pcm
  }

  /** 把 Int16 交错 PCM 包装成 16bit WAV（44 字节头 + 数据） */
  encodeWavFromInt16(pcm: Int16Array, sampleRate = 48000, numChannels = 2): ArrayBuffer {
    const bitDepth = 16
    const bytesPerSample = bitDepth / 8
    const blockAlign = numChannels * bytesPerSample
    const dataSize = pcm.byteLength
    const headerSize = 44
    const totalSize = headerSize + dataSize

    const arrayBuffer = new ArrayBuffer(totalSize)
    const view = new DataView(arrayBuffer)
    this.writeWavHeader(view, totalSize, sampleRate, numChannels, blockAlign, bitDepth, dataSize)
    new Uint8Array(arrayBuffer, headerSize).set(
      new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    )
    return arrayBuffer
  }

  private writeWavHeader(
    view: DataView,
    totalSize: number,
    sampleRate: number,
    numChannels: number,
    blockAlign: number,
    bitDepth: number,
    dataSize: number
  ): void {
    let offset = 0

    view.setUint32(offset, 0x46464952, true) // "RIFF"
    offset += 4
    view.setUint32(offset, totalSize - 8, true)
    offset += 4
    view.setUint32(offset, 0x45564157, true) // "WAVE"
    offset += 4

    view.setUint32(offset, 0x20746d66, true) // "fmt "
    offset += 4
    view.setUint32(offset, 16, true)
    offset += 4
    view.setUint16(offset, 1, true) // PCM
    offset += 2
    view.setUint16(offset, numChannels, true)
    offset += 2
    view.setUint32(offset, sampleRate, true)
    offset += 4
    view.setUint32(offset, sampleRate * blockAlign, true)
    offset += 4
    view.setUint16(offset, blockAlign, true)
    offset += 2
    view.setUint16(offset, bitDepth, true)
    offset += 2

    view.setUint32(offset, 0x61746164, true) // "data"
    offset += 4
    view.setUint32(offset, dataSize, true)
    offset += 4
  }

  async audioBufferToWav(audioBuffer: AudioBuffer): Promise<ArrayBuffer> {
    const numChannels = audioBuffer.numberOfChannels
    const sampleRate = audioBuffer.sampleRate
    const bitDepth = 16

    const length = audioBuffer.length
    const bytesPerSample = bitDepth / 8
    const blockAlign = numChannels * bytesPerSample
    const dataSize = length * blockAlign
    const headerSize = 44
    const totalSize = headerSize + dataSize

    this.logger.info(
      `Encoding WAV: channels=${numChannels}, sampleRate=${sampleRate}, duration=${audioBuffer.duration.toFixed(3)}s, dataSize=${(dataSize / 1024).toFixed(1)} KB`
    )

    try {
      const arrayBuffer = new ArrayBuffer(totalSize)
      const view = new DataView(arrayBuffer)

      this.writeWavHeader(view, totalSize, sampleRate, numChannels, blockAlign, bitDepth, dataSize)

      let offset = headerSize

      const channelData: Float32Array[] = []
      for (let ch = 0; ch < numChannels; ch++) {
        channelData.push(audioBuffer.getChannelData(ch))
      }

      for (let i = 0; i < length; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
          const sample = channelData[ch][i]
          const clampedSample = Math.max(-1, Math.min(1, sample))
          const int16Value = clampedSample < 0 ? clampedSample * 0x8000 : clampedSample * 0x7fff
          view.setInt16(offset, int16Value, true)
          offset += 2
        }
      }

      this.logger.info(`WAV encoding complete: totalSize=${(totalSize / 1024).toFixed(1)} KB`)

      return arrayBuffer
    } catch (error) {
      throw new Error(
        `WAV encoding failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  getAudioTracks(): AudioTrackData[] {
    return this.audioTracks
  }

  dispose(): void {
    if (this.audioContext) {
      this.audioContext
        .close()
        .catch((err) =>
          this.logger.warn('AudioContext close error', err instanceof Error ? err.message : err)
        )
      this.audioContext = null
    }
    this.audioTracks = []
    this.bgmConfig = null
    this.bgmCues = []
    this.seCues = []
    this.decodedBufferCache.clear()
  }
}
