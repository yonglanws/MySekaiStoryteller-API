import { ILogObj, Logger } from 'tslog'
import getSubLogger from '../utils/Logger'

export interface TTSConfig {
  enabled: boolean
  apiBaseUrl: string
  /** 宿主 API 地址；用于申请 GSV 权重租约（空 = 不租约，直接合成） */
  hostApiBaseUrl: string
  textLang: string
  promptLang: string
  defaultRefAudioPath: string
  defaultPromptText: string
  speedFactor: number
  topK: number
  topP: number
  temperature: number
  mediaType: 'wav' | 'ogg' | 'aac' | 'raw'
  fragmentInterval: number
  gptWeightsPath: string
  sovitsWeightsPath: string
}

export interface TranslationConfig {
  enabled: boolean
  apiType: 'openai' | 'deepseek' | 'claude' | 'custom'
  apiUrl: string
  apiKey: string
  model: string
  sourceLang: string
  targetLang: string
  systemPrompt: string
}

export interface BGMConfig {
  enabled: boolean
  path: string
  volume: number
}

export interface TTSRequest {
  text: string
  text_lang: string
  ref_audio_path: string
  aux_ref_audio_paths: string[]
  prompt_text: string
  prompt_lang: string
  top_k: number
  top_p: number
  temperature: number
  text_split_method: string
  batch_size: number
  batch_threshold: number
  split_bucket: boolean
  speed_factor: number
  fragment_interval: number
  seed: number
  media_type: string
  streaming_mode: boolean
  parallel_infer: boolean
  repetition_penalty: number
  gpt_weights?: string
  sovits_weights?: string
}

export interface CharacterVoiceConfig {
  characterName: string
  refAudioPath: string
  promptText: string
  promptLang: string
  gptWeightsPath?: string
  sovitsWeightsPath?: string
}

export const DEFAULT_TTS_CONFIG: TTSConfig = {
  enabled: false,
  apiBaseUrl: 'http://127.0.0.1:9880',
  hostApiBaseUrl: '',
  textLang: 'zh',
  promptLang: 'zh',
  defaultRefAudioPath: '',
  defaultPromptText: '',
  speedFactor: 1.0,
  topK: 5,
  topP: 1.0,
  temperature: 1.0,
  mediaType: 'wav',
  fragmentInterval: 0.3,
  gptWeightsPath: '',
  sovitsWeightsPath: ''
}

export interface TTSResult {
  audioBuffer: ArrayBuffer
  duration: number
  success: boolean
  error?: string
}

interface CacheEntry {
  result: TTSResult
  timestamp: number
}

interface Dialogue {
  text: string
  characterName: string
}

interface TtsWeights {
  gptWeightsPath: string
  sovitsWeightsPath: string
}

interface TtsLeaseGrant {
  leaseId: string
  currentWeights: TtsWeights | null
}

const MAX_CACHE_SIZE = 50
const CACHE_TTL_MS = 30 * 60 * 1000
const REQUEST_TIMEOUT_MS = 30000
const TEST_TIMEOUT_MS = 15000
/** 排队等租约的上限：要覆盖前面若干个导出各占一次 30s 合成的最坏情况 */
const LEASE_ACQUIRE_TIMEOUT_MS = 180000
const LEASE_RELEASE_TIMEOUT_MS = 5000
/** 切 GPT/SoVITS 权重是加载几百 MB 模型，给足时间 */
const WEIGHT_SWITCH_TIMEOUT_MS = 120000

export class TTSService {
  private readonly logger: Logger<ILogObj>
  private config: TTSConfig
  private characterConfigs: Map<string, CharacterVoiceConfig>
  private audioCache: Map<string, CacheEntry>
  private audioContext: AudioContext | null = null
  /** 每次导出开始时置位：首句强制重切权重，避免继承上一次导出或 WebUI 留下的状态 */
  private forceWeightSwitch: boolean = false
  private leaseUnavailableLogged: boolean = false
  /** 宿主没有租约端点（Electron/开发模式）时永久降级，避免每句都白等一次 */
  private leaseDisabled: boolean = false

  constructor(config: TTSConfig) {
    this.config = config
    this.characterConfigs = new Map()
    this.audioCache = new Map()
    this.logger = getSubLogger('TTSService')
  }

  updateConfig(config: Partial<TTSConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /** 新导出开始：首句必须重新确认 GSV 权重，不能信任上一场留下的全局状态 */
  beginSession(): void {
    this.forceWeightSwitch = true
  }

  setCharacterVoice(characterName: string, voiceConfig: CharacterVoiceConfig): void {
    this.characterConfigs.set(characterName, voiceConfig)
  }

  getCharacterVoice(characterName: string): CharacterVoiceConfig | undefined {
    const exact = this.characterConfigs.get(characterName)
    if (exact) return exact
    // 兜底：speaker 与配置名"全名/短名"不完全一致时做包含匹配（如"瑞希" ↔ "晓山瑞希"）
    for (const [name, config] of this.characterConfigs) {
      if (name.includes(characterName) || characterName.includes(name)) {
        return config
      }
    }
    return undefined
  }

  clearCache(): void {
    this.audioCache.clear()
  }

  private getCacheKey(
    text: string,
    characterName: string,
    speedFactor?: number,
    gptWeightsPath: string = '',
    sovitsWeightsPath: string = ''
  ): string {
    // 权重也进缓存键：改了角色权重后不能复用旧音色的缓存
    return `${characterName}:${speedFactor ?? this.config.speedFactor}:${gptWeightsPath}:${sovitsWeightsPath}:${text}`
  }

  private addToCache(key: string, result: TTSResult): void {
    if (this.audioCache.size >= MAX_CACHE_SIZE) {
      const oldestKey = this.audioCache.keys().next().value
      if (oldestKey !== undefined) {
        this.audioCache.delete(oldestKey)
      }
    }
    this.audioCache.set(key, { result, timestamp: Date.now() })
  }

  private cleanupExpiredCache(): void {
    const now = Date.now()
    for (const [key, entry] of this.audioCache.entries()) {
      if (now - entry.timestamp > CACHE_TTL_MS) {
        this.audioCache.delete(key)
      }
    }
  }

  async synthesizeSpeech(
    text: string,
    characterName: string,
    speedFactor?: number
  ): Promise<TTSResult> {
    this.cleanupExpiredCache()

    const charConfig = this.getCharacterVoice(characterName)
    const refAudioPath = charConfig?.refAudioPath || this.config.defaultRefAudioPath
    const promptText = charConfig?.promptText || this.config.defaultPromptText
    const promptLang = charConfig?.promptLang || this.config.promptLang
    const gptWeightsPath = charConfig?.gptWeightsPath || this.config.gptWeightsPath || ''
    const sovitsWeightsPath = charConfig?.sovitsWeightsPath || this.config.sovitsWeightsPath || ''

    const cacheKey = this.getCacheKey(
      text,
      characterName,
      speedFactor,
      gptWeightsPath,
      sovitsWeightsPath
    )
    const cached = this.audioCache.get(cacheKey)
    if (cached) {
      cached.timestamp = Date.now()
      return cached.result
    }

    if (!this.config.enabled) {
      return {
        audioBuffer: new ArrayBuffer(0),
        duration: 0,
        success: false,
        error: 'TTS is not enabled'
      }
    }

    if (!refAudioPath) {
      return {
        audioBuffer: new ArrayBuffer(0),
        duration: 0,
        success: false,
        error: `No reference audio configured for character: ${characterName}`
      }
    }

    const request: TTSRequest = {
      text: text,
      text_lang: this.config.textLang.toLowerCase(),
      ref_audio_path: refAudioPath,
      aux_ref_audio_paths: [],
      prompt_text: promptText,
      prompt_lang: promptLang.toLowerCase(),
      top_k: this.config.topK,
      top_p: this.config.topP,
      temperature: this.config.temperature,
      text_split_method: 'cut5',
      batch_size: 1,
      batch_threshold: 0.75,
      split_bucket: true,
      speed_factor: speedFactor ?? this.config.speedFactor,
      fragment_interval: this.config.fragmentInterval,
      seed: -1,
      media_type: this.config.mediaType,
      streaming_mode: false,
      parallel_infer: true,
      repetition_penalty: 1.35
    }

    if (gptWeightsPath) {
      request.gpt_weights = gptWeightsPath
    }
    if (sovitsWeightsPath) {
      request.sovits_weights = sovitsWeightsPath
    }

    // GSV 的权重是服务端全局状态：拿租约 → 切权重 → /tts → 释放，
    // 全程串行，避免别的渲染 worker 在合成途中把权重换掉。
    const lease = await this.acquireTtsLease()
    const baseWeights = lease?.currentWeights ?? null
    const effectiveGpt = gptWeightsPath || baseWeights?.gptWeightsPath || ''
    const effectiveSovits = sovitsWeightsPath || baseWeights?.sovitsWeightsPath || ''
    let releaseWeights: TtsWeights | null =
      effectiveGpt && effectiveSovits
        ? { gptWeightsPath: effectiveGpt, sovitsWeightsPath: effectiveSovits }
        : null

    try {
      if (lease) {
        await this.ensureWeights(gptWeightsPath, sovitsWeightsPath, lease.currentWeights)
      }

      const audioBuffer = await this.fetchTTS(request)

      if (!audioBuffer || audioBuffer.byteLength === 0) {
        return {
          audioBuffer: new ArrayBuffer(0),
          duration: 0,
          success: false,
          error: 'TTS API returned empty audio data'
        }
      }

      this.logger.info(`TTS API returned audio: ${audioBuffer.byteLength} bytes`)

      const duration = await this.calculateAudioDuration(audioBuffer)

      this.logger.info(`Calculated audio duration: ${duration}ms`)

      const result: TTSResult = {
        audioBuffer,
        duration,
        success: true
      }

      this.addToCache(cacheKey, result)
      return result
    } catch (error) {
      // 切权重失败时服务端可能处于新旧混合状态，下一次必须重新切
      releaseWeights = null
      return {
        audioBuffer: new ArrayBuffer(0),
        duration: 0,
        success: false,
        error: `TTS request failed: ${error instanceof Error ? error.message : String(error)}`
      }
    } finally {
      if (lease) {
        await this.releaseTtsLease(lease.leaseId, releaseWeights)
      }
    }
  }

  /**
   * 申请宿主租约。宿主不可用（例如 Electron/开发模式）时返回 null，
   * 退化为直接合成；API 模式下宿主一定提供该端点。
   */
  private async acquireTtsLease(): Promise<TtsLeaseGrant | null> {
    if (this.leaseDisabled) return null
    const base = this.normalizeBaseUrl(this.config.hostApiBaseUrl)
    if (!base) return null

    let permanentFailure = false
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), LEASE_ACQUIRE_TIMEOUT_MS)
    try {
      const response = await fetch(`${base}/api/v1/tts/lease`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: controller.signal
      })
      if (response.status === 404) {
        permanentFailure = true
        throw new Error('HTTP 404')
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const contentType = response.headers.get('content-type') || ''
      if (!contentType.includes('application/json')) {
        permanentFailure = true
        throw new Error(`unexpected lease response type: ${contentType || 'unknown'}`)
      }
      const data = (await response.json()) as {
        success?: boolean
        leaseId?: string
        currentWeights?: TtsWeights | null
      }
      if (!data.success || typeof data.leaseId !== 'string') {
        permanentFailure = true
        throw new Error('invalid lease response')
      }
      return {
        leaseId: data.leaseId,
        currentWeights: data.currentWeights ?? null
      }
    } catch (error) {
      if (permanentFailure || error instanceof TypeError) {
        this.leaseDisabled = true
      }
      if (!this.leaseUnavailableLogged) {
        this.leaseUnavailableLogged = true
        this.logger.warn(
          `TTS lease unavailable (${error instanceof Error ? error.message : String(error)}); ` +
            'falling back to direct synthesis without weight serialization'
        )
      }
      return null
    } finally {
      clearTimeout(timeoutId)
    }
  }

  private async releaseTtsLease(leaseId: string, weights: TtsWeights | null): Promise<void> {
    const base = this.normalizeBaseUrl(this.config.hostApiBaseUrl)
    if (!base) return

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), LEASE_RELEASE_TIMEOUT_MS)
    try {
      await fetch(`${base}/api/v1/tts/lease/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leaseId, weights }),
        signal: controller.signal
      })
    } catch (error) {
      // 释放失败由宿主租约 TTL 兜底，不能阻塞导出
      this.logger.warn(
        `TTS lease release failed: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * 在租约内把 GSV 权重切到当前角色。空路径表示沿用服务端已有权重。
   */
  private async ensureWeights(
    gptWeightsPath: string,
    sovitsWeightsPath: string,
    currentWeights: TtsWeights | null
  ): Promise<void> {
    const force = this.forceWeightSwitch
    const needGpt = !!gptWeightsPath && (force || currentWeights?.gptWeightsPath !== gptWeightsPath)
    const needSovits =
      !!sovitsWeightsPath && (force || currentWeights?.sovitsWeightsPath !== sovitsWeightsPath)

    if (needGpt) {
      const startedAt = Date.now()
      await this.setWeights('gpt', gptWeightsPath)
      this.logger.info(`TTS GPT weights switched in ${Date.now() - startedAt}ms: ${gptWeightsPath}`)
    }
    if (needSovits) {
      const startedAt = Date.now()
      await this.setWeights('sovits', sovitsWeightsPath)
      this.logger.info(
        `TTS SoVITS weights switched in ${Date.now() - startedAt}ms: ${sovitsWeightsPath}`
      )
    }

    // 只在真正处理过租约后清除；宿主不可用时保留，等下次拿到租约再强制切
    this.forceWeightSwitch = false
  }

  private async setWeights(kind: 'gpt' | 'sovits', weightsPath: string): Promise<void> {
    const base = this.normalizeBaseUrl(this.config.apiBaseUrl)
    if (!base) {
      throw new Error(`Invalid TTS apiBaseUrl: ${this.config.apiBaseUrl}`)
    }

    const url = `${base}/set_${kind}_weights?weights_path=${encodeURIComponent(weightsPath)}`
    const response = await this.fetchTtsAuxiliary(url)

    let parsed: { message?: string; Exception?: string } | null = null
    try {
      parsed = JSON.parse(response.text) as { message?: string; Exception?: string }
    } catch {
      // 非 JSON 响应（例如代理层错误页）在下面统一报错
    }

    if (!response.ok || parsed?.message !== 'success') {
      const detail =
        parsed?.Exception ||
        parsed?.message ||
        response.text.slice(0, 200) ||
        `HTTP ${response.status}`
      throw new Error(`Failed to switch ${kind} weights: ${detail}`)
    }
  }

  /**
   * GSV 不带 CORS 头，浏览器直连 /set_* 会被拦；走宿主已有的 tts-fetch 代理
   * （与 /tts 直连失败时的兜底路径一致），Electron 下由主进程转发。
   */
  private async fetchTtsAuxiliary(
    url: string
  ): Promise<{ ok: boolean; status: number; text: string }> {
    const ipc = typeof window !== 'undefined' ? window.electron?.ipcRenderer : undefined

    if (ipc?.invoke) {
      let timeoutId: ReturnType<typeof setTimeout> | null = null
      try {
        const result = (await Promise.race([
          ipc.invoke('electron:tts-fetch', {
            url,
            method: 'GET',
            headers: {},
            body: ''
          }),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error('TTS auxiliary request timed out')),
              WEIGHT_SWITCH_TIMEOUT_MS
            )
          })
        ])) as { ok: boolean; status: number; body: ArrayBuffer }

        return {
          ok: result.ok,
          status: result.status,
          text: new TextDecoder().decode(new Uint8Array(result.body))
        }
      } catch (error) {
        // IPC 代理不可用时再退回直连（同源/开发环境）
        this.logger.warn(
          `TTS auxiliary IPC proxy failed, trying direct fetch: ${error instanceof Error ? error.message : String(error)}`
        )
      } finally {
        if (timeoutId) clearTimeout(timeoutId)
      }
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), WEIGHT_SWITCH_TIMEOUT_MS)
    try {
      const response = await fetch(url, { method: 'GET', signal: controller.signal })
      return {
        ok: response.ok,
        status: response.status,
        text: await response.text()
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Timed out requesting ${url}`)
      }
      throw error
    } finally {
      clearTimeout(timeoutId)
    }
  }

  private normalizeBaseUrl(raw: string | undefined): string {
    const value = raw?.trim()
    if (!value) return ''
    try {
      const parsed = new URL(value)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
      if (parsed.username || parsed.password || parsed.search || parsed.hash) return ''
      return parsed.href.replace(/\/+$/, '')
    } catch {
      return ''
    }
  }

  private async fetchTTS(request: TTSRequest): Promise<ArrayBuffer> {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

      const response = await fetch(`${this.config.apiBaseUrl}/tts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(request),
        signal: controller.signal
      })
      clearTimeout(timeoutId)

      if (!response.ok) {
        const errorData = await response.json().catch(() => null)
        const errorMsg = errorData?.message || errorData?.Exception || `HTTP ${response.status}`
        throw new Error(`TTS API error: ${errorMsg}`)
      }

      return await response.arrayBuffer()
    } catch (fetchError) {
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        throw new Error('TTS request timed out')
      }

      this.logger.warn(
        `Direct fetch failed, trying IPC proxy: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`
      )

      const ipcResult = await Promise.race([
        window.electron.ipcRenderer.invoke('electron:tts-fetch', {
          url: `${this.config.apiBaseUrl}/tts`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(request)
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('TTS IPC proxy timed out')), REQUEST_TIMEOUT_MS)
        )
      ])

      if (!ipcResult.ok) {
        throw new Error(`TTS IPC error: HTTP ${ipcResult.status}`)
      }

      return ipcResult.body
    }
  }

  private async calculateAudioDuration(audioBuffer: ArrayBuffer): Promise<number> {
    if (audioBuffer.byteLength < 44) {
      return 0
    }

    const view = new DataView(audioBuffer)
    if (view.getUint32(0, true) === 0x46464952) {
      const sampleRate = view.getUint32(24, true)
      const dataSize = view.getUint32(40, true)
      const bitsPerSample = view.getUint16(34, true)
      const numChannels = view.getUint16(22, true)

      const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
      if (byteRate === 0) {
        return 0
      }

      return (dataSize / byteRate) * 1000
    }

    try {
      if (!this.audioContext) {
        this.audioContext = new AudioContext()
      }
      const decoded = await this.audioContext.decodeAudioData(audioBuffer.slice(0))
      return decoded.duration * 1000
    } catch {
      return 0
    }
  }

  async synthesizeBatch(
    dialogues: Dialogue[],
    concurrency: number = 3
  ): Promise<Map<string, TTSResult>> {
    const results = new Map<string, TTSResult>()
    const executing: Promise<void>[] = []

    for (let i = 0; i < dialogues.length; i++) {
      const dialogue = dialogues[i]
      const promise = this.synthesizeSpeech(dialogue.text, dialogue.characterName).then(
        (result) => {
          const cacheKey = this.getCacheKey(dialogue.text, dialogue.characterName)
          results.set(cacheKey, result)
        }
      )
      executing.push(promise)

      if (executing.length >= concurrency) {
        await Promise.race(executing)
        const index = executing.findIndex((p) => p === promise)
        if (index > -1) {
          executing.splice(index, 1)
        }
      }
    }

    await Promise.all(executing)
    return results
  }

  async testConnection(): Promise<{ success: boolean; message: string; details?: string }> {
    const refAudioPath = this.config.defaultRefAudioPath || 'audio_ref.wav'
    const promptText = this.config.defaultPromptText || '测试'
    const promptLang = this.config.promptLang || 'zh'
    const textLang = this.config.textLang || 'zh'

    const testRequest: TTSRequest = {
      text: '测试',
      text_lang: textLang.toLowerCase(),
      ref_audio_path: refAudioPath,
      aux_ref_audio_paths: [],
      prompt_text: promptText,
      prompt_lang: promptLang.toLowerCase(),
      top_k: this.config.topK,
      top_p: this.config.topP,
      temperature: this.config.temperature,
      text_split_method: 'cut5',
      batch_size: 1,
      batch_threshold: 0.75,
      split_bucket: true,
      speed_factor: this.config.speedFactor,
      fragment_interval: this.config.fragmentInterval,
      seed: -1,
      media_type: this.config.mediaType,
      streaming_mode: false,
      parallel_infer: true,
      repetition_penalty: 1.35
    }

    if (this.config.gptWeightsPath) {
      testRequest.gpt_weights = this.config.gptWeightsPath
    }
    if (this.config.sovitsWeightsPath) {
      testRequest.sovits_weights = this.config.sovitsWeightsPath
    }

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)

      const response = await fetch(`${this.config.apiBaseUrl}/tts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(testRequest),
        signal: controller.signal
      })
      clearTimeout(timeoutId)

      if (response.ok) {
        const audioData = await response.arrayBuffer()
        if (audioData.byteLength > 0) {
          return {
            success: true,
            message: 'TTS服务连接成功',
            details: `GPT-SoVITS API 正常响应，音频大小: ${(audioData.byteLength / 1024).toFixed(1)} KB`
          }
        }
        return {
          success: true,
          message: 'TTS服务连接成功',
          details: 'GPT-SoVITS API 响应正常（音频数据为空，请检查参考音频路径配置）'
        }
      }

      if (response.status === 400) {
        const errorData = await response.json().catch(() => null)
        const errorMsg = errorData?.message || errorData?.Exception || ''
        return {
          success: false,
          message: 'TTS服务参数错误',
          details: `HTTP 400: ${errorMsg || '请检查参考音频路径和提示文本配置是否正确'}`
        }
      }

      return {
        success: false,
        message: `连接异常，HTTP ${response.status}`
      }
    } catch (fetchError) {
      this.logger.warn(
        `Direct fetch failed in test, trying IPC: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`
      )

      try {
        const ipcResult = await window.electron.ipcRenderer.invoke('electron:tts-fetch', {
          url: `${this.config.apiBaseUrl}/tts`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(testRequest)
        })

        if (ipcResult.ok) {
          const audioSize = ipcResult.body?.byteLength ?? 0
          return {
            success: true,
            message: 'TTS服务连接成功',
            details: `GPT-SoVITS API 正常响应（通过IPC代理），音频大小: ${(audioSize / 1024).toFixed(1)} KB`
          }
        }

        if (ipcResult.status === 400) {
          return {
            success: false,
            message: 'TTS服务参数错误',
            details: `HTTP 400: 请检查参考音频路径和提示文本配置是否正确`
          }
        }

        return {
          success: false,
          message: `连接失败，HTTP ${ipcResult.status}`
        }
      } catch (ipcError) {
        return {
          success: false,
          message: `无法连接到TTS服务`,
          details: ipcError instanceof Error ? ipcError.message : String(ipcError)
        }
      }
    }
  }

  getConfig(): TTSConfig {
    return { ...this.config }
  }

  dispose(): void {
    if (this.audioContext) {
      this.audioContext.close().catch((err) => {
        this.logger.warn('AudioContext close error', err instanceof Error ? err.message : err)
      })
      this.audioContext = null
    }
    this.clearCache()
  }
}
