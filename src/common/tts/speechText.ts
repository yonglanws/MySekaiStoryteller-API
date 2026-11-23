/** 是否包含可朗读的语言字符（字母/汉字/假名/数字）；纯标点（如「……」「——」）返回 false。 */
export function hasSpeakableSpeechText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(String(text ?? ''))
}

/** 平假名/片假名是日文最可靠的判据。 */
const KANA = /[\u3040-\u30ff\u31f0-\u31ff]/
/** CJK 汉字（含扩展 A 与兼容区）。 */
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
/**
 * 高置信中文标记：简体字形、中文专用虚词/人称与中文逗号。
 *
 * 日文台词可以合法地只有汉字（官方剧本里的「瑞希——」「了解」），
 * 因此不能要求每句都含假名；反过来，中文台词几乎必然命中这里的
 * 简体字形或虚词。该判据只用于把“看起来像中文”的行送去翻译，
 * 纯汉字日文不会被误拦。
 */
const CHINESE_MARKER =
  /[你您们們这這说說听聽觉覺对對请错还让讓从從经經么麼为无开关时现儿爱见话门问间长车东马鸟鱼龙头买卖读写认识记语词谁谢很吧呢吗嗎啊呀嘛哦嗯的呗咱啥咋哪怎什些他她它晚给练习，]/u

/**
 * IrodoriTTS 的文本约束：它只会读日文。宿主必须为每条 Talk 提供日文 ttsText，
 * 缺失时不能退回中文 content。
 *
 * 含假名直接判为日文；纯汉字行只要不含高置信中文标记，也按日文处理。
 */
export function isJapaneseSpeechText(text: string): boolean {
  const value = String(text ?? '')
  if (KANA.test(value)) return true
  return HAN.test(value) && !CHINESE_MARKER.test(value)
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
