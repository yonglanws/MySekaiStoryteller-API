/**
 * IrodoriTTS 的文本约束：它只会读日文。宿主必须为每条 Talk 提供日文 ttsText，
 * 缺失时不能退回中文 content。
 */
export function isJapaneseSpeechText(text: string): boolean {
  return /[\u3040-\u30ff\u31f0-\u31ff]/.test(text)
}

export type TtsProvider = 'gpt-sovits' | 'irodori'

/**
 * 导出前是否需要把 ttsText 补成日文。
 * 只有启用 Irodori 时才需要；TTS 关闭时 ttsText 不进入音轨，不应阻断纯画面导出。
 */
export function needsJapaneseTtsPreflight(tts: {
  enabled: boolean
  provider: TtsProvider | string
}): boolean {
  return tts.enabled && tts.provider === 'irodori'
}

/**
 * 选择实际送进 TTS 的文本。
 * - irodori：只用日文 ttsText；没有就返回 null（调用方应报错，而不是读中文）。
 * - gpt-sovits：ttsText 优先，缺失时退回 content（GSV 配置了 textLang，可读中文）。
 */
export function selectSpeechText(
  provider: TtsProvider,
  ttsText: string,
  content: string
): string | null {
  if (provider === 'irodori') {
    return isJapaneseSpeechText(ttsText) ? ttsText : null
  }
  return ttsText.trim() ? ttsText : content
}
