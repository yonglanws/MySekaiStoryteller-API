/**
 * Irodori-TTS 请求构造（宿主与渲染端共用）。
 *
 * Irodori-TTS-Server 提供 OpenAI 兼容的 `POST /v1/audio/speech`：
 * 顶层是 `model` / `input` / `response_format` / `speed`，推理参数放在 `irodori` 对象里。
 * 参考音频、LoRA adapter、caption 都是 **服务端可见路径/文本**，不是浏览器上传的文件。
 */

export type IrodoriResponseFormat = 'wav' | 'mp3' | 'ogg'

export interface IrodoriDefaults {
  model: string
  responseFormat: IrodoriResponseFormat
  numSteps: number
  cfgScaleText: number
  cfgScaleCaption: number
  cfgScaleSpeaker: number
  durationScale: number
  chunkingEnabled: boolean
  chunkMinChars: number
  seed: number
}

export interface IrodoriVoiceConfig {
  /** 单条参考音频（服务端路径） */
  refAudioPath?: string
  /** 多条参考音频；非空时发送 ref_wavs，且不再发送 ref_wav */
  refAudioPaths?: string[]
  /** PEFT LoRA adapter 目录（服务端路径）；留空走基座零样本 */
  loraAdapter?: string
  /** 表演描述，例如「落ち着いた、穏やかな口調で話している。」 */
  caption?: string
  speed?: number
  numSteps?: number
}

export interface IrodoriEmotionConfig extends IrodoriVoiceConfig {
  emotion: string
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const refsOf = (voice: IrodoriVoiceConfig): string[] =>
  (voice.refAudioPaths ?? []).map((item) => item.trim()).filter(Boolean)

/**
 * 情绪命中时用情绪条目的非空字段覆盖角色默认值；未命中时原样返回角色默认值。
 * 空字符串表示“没有覆盖”，与 Irodori 插件的情绪条目语义一致。
 */
export function resolveIrodoriVoice(
  base: IrodoriVoiceConfig,
  emotions: IrodoriEmotionConfig[] | undefined,
  emotion: string | undefined
): IrodoriVoiceConfig {
  const label = text(emotion)
  const hit = label ? emotions?.find((entry) => entry.emotion === label) : undefined
  if (!hit) return base

  const merged: IrodoriVoiceConfig = { ...base }
  if (text(hit.refAudioPath)) merged.refAudioPath = hit.refAudioPath
  const hitRefs = refsOf(hit)
  if (hitRefs.length > 0) merged.refAudioPaths = hitRefs
  if (text(hit.loraAdapter)) merged.loraAdapter = hit.loraAdapter
  if (text(hit.caption)) merged.caption = hit.caption
  if (typeof hit.speed === 'number' && Number.isFinite(hit.speed)) merged.speed = hit.speed
  if (typeof hit.numSteps === 'number' && hit.numSteps > 0) merged.numSteps = hit.numSteps
  return merged
}

/**
 * 构造 OpenAI 兼容的 Irodori 语音请求体。
 *
 * - `ref_wav` 与 `ref_wavs` 互斥，多参考优先；
 * - 空字符串、`seed < 0`、`num_steps <= 0` 一律省略，让服务端使用自己的默认值；
 * - `speed` 取角色/情绪覆盖值，其次调用方传入值，最后 1.0。
 */
export function buildIrodoriSpeechRequest(
  input: string,
  voice: IrodoriVoiceConfig,
  defaults: IrodoriDefaults,
  speedOverride?: number
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: text(defaults.model) || 'irodori-tts',
    input,
    response_format: defaults.responseFormat || 'wav'
  }

  const speed = voice.speed ?? speedOverride ?? 1.0
  if (typeof speed === 'number' && Number.isFinite(speed)) payload.speed = speed

  const irodori: Record<string, unknown> = {}
  const refs = refsOf(voice)
  if (refs.length > 0) {
    irodori.ref_wavs = refs
  } else if (text(voice.refAudioPath)) {
    irodori.ref_wav = text(voice.refAudioPath)
  }
  if (text(voice.loraAdapter)) irodori.lora_adapter = text(voice.loraAdapter)
  if (text(voice.caption)) irodori.caption = text(voice.caption)

  const numSteps = voice.numSteps ?? defaults.numSteps
  if (Number.isFinite(numSteps) && numSteps > 0) irodori.num_steps = numSteps
  if (Number.isFinite(defaults.cfgScaleText)) irodori.cfg_scale_text = defaults.cfgScaleText
  if (Number.isFinite(defaults.cfgScaleCaption)) {
    irodori.cfg_scale_caption = defaults.cfgScaleCaption
  }
  if (Number.isFinite(defaults.cfgScaleSpeaker)) {
    irodori.cfg_scale_speaker = defaults.cfgScaleSpeaker
  }
  if (Number.isFinite(defaults.durationScale)) irodori.duration_scale = defaults.durationScale
  irodori.chunking_enabled = defaults.chunkingEnabled
  if (Number.isFinite(defaults.chunkMinChars) && defaults.chunkMinChars > 0) {
    irodori.chunk_min_chars = defaults.chunkMinChars
  }
  if (Number.isInteger(defaults.seed) && defaults.seed >= 0) irodori.seed = defaults.seed

  if (Object.keys(irodori).length > 0) payload.irodori = irodori
  return payload
}

/** 配置里出现过的情绪标签（去重、保持顺序），供 AI 提示词与校验使用。 */
export function collectEmotionLabels(
  defaults: string[] | undefined,
  characters: Array<{ emotions?: Array<{ emotion: string }> }> | undefined
): string[] {
  const labels: string[] = []
  const add = (value: string): void => {
    const label = value.trim()
    if (label && !labels.includes(label)) labels.push(label)
  }
  for (const label of defaults ?? []) add(label)
  for (const character of characters ?? []) {
    for (const entry of character.emotions ?? []) add(entry.emotion)
  }
  return labels
}
