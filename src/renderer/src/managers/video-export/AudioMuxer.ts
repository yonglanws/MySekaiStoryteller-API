import { ExportLogger } from './ExportLogger'

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
  private readonly logger: ExportLogger = new ExportLogger('AudioMuxer')
  private decodedBufferCache: Map<string, AudioBuffer> = new Map()

  constructor() {
    this.audioContext = null
    this.audioTracks = []
    this.bgmConfig = null
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

  addAudioTrack(track: AudioTrackData): void {
    this.audioTracks.push(track)
    this.logger.info(
      `Audio track added: character="${track.characterName}", start=${track.startTime}ms, end=${track.endTime}ms, bufferSize=${track.audioBuffer.byteLength}`
    )
  }

  clearTracks(): void {
    this.audioTracks = []
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

  async mixAudioTracks(outputDuration: number, bgmBuffer?: AudioBuffer): Promise<AudioBuffer> {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      await this.initialize()
    }

    if (this.audioContext!.state === 'suspended') {
      this.logger.info('AudioContext suspended before mixing, resuming...')
      await this.audioContext!.resume()
      await new Promise((r) => setTimeout(r, 100))
    }

    this.logger.info(
      `Mixing audio: outputDuration=${outputDuration}ms, tracks=${this.audioTracks.length}, hasBGM=${!!bgmBuffer}, contextState=${this.audioContext!.state}`
    )

    const sampleRate = 48000
    const totalSamples = Math.ceil((outputDuration / 1000) * sampleRate)
    const numChannels = 2

    const leftBuffer = new Float32Array(totalSamples)
    const rightBuffer = new Float32Array(totalSamples)

    if (bgmBuffer && this.bgmConfig?.enabled) {
      this.mixBGM(leftBuffer, rightBuffer, bgmBuffer, totalSamples)
    }

    await this.mixTTSTracks(leftBuffer, rightBuffer, totalSamples, sampleRate)

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
    totalSamples: number
  ): void {
    const bgmChannels = bgmBuffer.numberOfChannels
    const bgmTotalSamples = bgmBuffer.getChannelData(0).length
    const bgmVolume = this.bgmConfig!.volume ?? 0.1

    // 减少日志:只在开始时记录一次
    this.logger.info(
      `Mixing BGM: volume=${bgmVolume}, channels=${bgmChannels}, bgmSamples=${bgmTotalSamples}, outputSamples=${totalSamples}`
    )

    const bgmLeftData = bgmBuffer.getChannelData(0)
    const bgmRightData = bgmChannels > 1 ? bgmBuffer.getChannelData(1) : null

    // 使用局部变量缓存,提高循环性能
    const leftBuf = leftBuffer
    const rightBuf = rightBuffer
    const volume = bgmVolume
    const bgmLen = bgmTotalSamples

    if (bgmChannels === 1) {
      // 单声道BGM:复制到左右声道
      for (let i = 0; i < totalSamples; i++) {
        const sample = bgmLeftData[i % bgmLen] * volume
        leftBuf[i] += sample
        rightBuf[i] += sample
      }
    } else {
      // 双声道BGM:分别混合
      const rightData = bgmRightData!
      for (let i = 0; i < totalSamples; i++) {
        const idx = i % bgmLen
        leftBuf[i] += bgmLeftData[idx] * volume
        rightBuf[i] += rightData[idx] * volume
      }
    }

    const loopCount = Math.ceil(totalSamples / bgmTotalSamples)
    this.logger.info(`BGM mixing complete: volume=${bgmVolume}, loops=${loopCount}`)
  }

  private async mixTTSTracks(
    leftBuffer: Float32Array,
    rightBuffer: Float32Array,
    totalSamples: number,
    sampleRate: number
  ): Promise<void> {
    if (this.audioTracks.length === 0) return

    interface ValidTrack {
      track: AudioTrackData
      sourceCh0: Float32Array
      sourceCh1: Float32Array
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
        // 减少日志:只在调试时记录
        // this.logger.info(
        //   `Using pre-extracted PCM data for "${track.characterName}" (samples=${track.pcmData.channel0.length}, sampleRate=${track.pcmData.sampleRate})`
        // )
        validTracks.push({
          track,
          sourceCh0: track.pcmData.channel0,
          sourceCh1: track.pcmData.channel1
        })
      } else {
        const decodePromise = this.decodeAudioTrackCached(track).then((decoded) => {
          if (!decoded || typeof decoded.getChannelData !== 'function') {
            this.logger.warn(`Decoded buffer invalid for "${track.characterName}", skipping`)
            return
          }
          const ch0 = decoded.getChannelData(0)
          const ch1 = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : ch0
          validTracks.push({ track, sourceCh0: ch0, sourceCh1: ch1 })
        })
        decodePromises.push(decodePromise)
      }
    }

    await Promise.all(decodePromises)

    let mixedTrackCount = 0
    let skippedTrackCount = 0
    let totalSampleCount = 0

    // 批量处理音频轨道,减少函数调用开销
    for (const { track, sourceCh0, sourceCh1 } of validTracks) {
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

        // 使用局部变量缓存,提高性能
        const volumeScale = 0.5
        const ch0 = sourceCh0
        const ch1 = sourceCh1
        const leftBuf = leftBuffer
        const rightBuf = rightBuffer
        const start = startSample
        const end = endSample

        // 优化后的混合循环:减少属性访问和重复计算
        for (let i = start; i < end; i++) {
          const sourceIndex = i - start
          const leftSample = ch0[sourceIndex] * volumeScale
          const rightSample = ch1[sourceIndex] * volumeScale
          leftBuf[i] += leftSample
          rightBuf[i] += rightSample
        }

        mixedTrackCount++
        totalSampleCount += end - start
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
    if (!this.audioContext || this.audioContext.state === 'closed') {
      await this.initialize()
    }

    if (this.audioContext!.state === 'suspended') {
      this.logger.info('AudioContext suspended before mixing, resuming...')
      await this.audioContext!.resume()
      await new Promise((r) => setTimeout(r, 100))
    }

    this.logger.info(
      `Mixing audio (int16 direct): outputDuration=${outputDuration}ms, tracks=${this.audioTracks.length}, hasBGM=${!!bgmBuffer}`
    )

    const sampleRate = 48000
    const totalSamples = Math.ceil((outputDuration / 1000) * sampleRate)

    const leftBuffer = new Float32Array(totalSamples)
    const rightBuffer = new Float32Array(totalSamples)

    if (bgmBuffer && this.bgmConfig?.enabled) {
      this.mixBGM(leftBuffer, rightBuffer, bgmBuffer, totalSamples)
    }

    await this.mixTTSTracks(leftBuffer, rightBuffer, totalSamples, sampleRate)

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
    this.decodedBufferCache.clear()
  }
}
