import type { ILogObj, Logger } from 'tslog'
import type { StoryData } from '../../common/types/Story'

/**
 * IrodoriTTS 只接受日文。宿主在导出前必须把每条 Talk 的 ttsText 补成日文，
 * 不能像以前那样在缺失时把中文 content 直接送去合成。
 */
export function isJapaneseText(text: string): boolean {
  // 平假名/片假名是日文最可靠的判据；中文台词不会出现这些字符。
  // 纯汉字短句（如「無言」）无法与中文区分，统一按“需要翻译”处理，宁可多译一次。
  return /[\u3040-\u30ff\u31f0-\u31ff]/.test(text)
}

export interface TtsTarget {
  snippetIndex: number
  content: string
  data: { ttsText: string; content: string }
}

/** 找出所有没有日文 ttsText 的 Talk（空串、中文、半成品都算）。 */
export function collectTtsTargets(story: StoryData): TtsTarget[] {
  const targets: TtsTarget[] = []
  story.snippets.forEach((snippet, snippetIndex) => {
    if (snippet.type !== 'Talk') return
    const data = snippet.data as { ttsText?: string; content: string }
    if (!data.content?.trim()) return
    if (isJapaneseText(data.ttsText ?? '')) return
    targets.push({ snippetIndex, content: data.content, data: data as TtsTarget['data'] })
  })
  return targets
}

export type TtsBatchTranslator = (texts: string[]) => Promise<string[]>

export interface EnsureJapaneseTtsResult {
  translated: number
  missing: number[]
}

export class TtsTextTranslationError extends Error {
  readonly missing: number[]

  constructor(missing: number[]) {
    super(
      `IrodoriTTS 需要日文 ttsText，但以下 Talk 仍未翻译：${missing
        .map((index) => `snippets[${index}]`)
        .join(', ')}`
    )
    this.name = 'TtsTextTranslationError'
    this.missing = missing
  }
}

/**
 * 批量补齐日文 ttsText。
 *
 * - 已有日文（含假名）的句子原样保留，不重复翻译；
 * - 翻译结果必须仍是长度相同的数组，否则整块放弃并记 missing；
 * - strict=true 时，仍有缺失就抛 TtsTextTranslationError（导出前预检用）。
 */
export async function ensureJapaneseTtsText(
  story: StoryData,
  translate: TtsBatchTranslator,
  logger: Pick<Logger<ILogObj>, 'info' | 'warn'>,
  options: { chunkSize?: number; strict?: boolean } = {}
): Promise<EnsureJapaneseTtsResult> {
  const targets = collectTtsTargets(story)
  if (targets.length === 0) return { translated: 0, missing: [] }

  const chunkSize = Math.max(1, options.chunkSize ?? 20)
  let translated = 0

  for (let offset = 0; offset < targets.length; offset += chunkSize) {
    const chunk = targets.slice(offset, offset + chunkSize)
    const input = chunk.map((target) => target.content)
    try {
      const output = await translate(input)
      if (!Array.isArray(output) || output.length !== input.length) {
        logger.warn(
          `[TTS] 日文翻译数量不匹配（期望 ${input.length}，收到 ${
            Array.isArray(output) ? output.length : 0
          }），保留缺失 ttsText`
        )
        continue
      }
      for (let index = 0; index < chunk.length; index++) {
        const value = output[index]
        if (typeof value !== 'string' || !value.trim() || !isJapaneseText(value)) {
          logger.warn(`[TTS] snippets[${chunk[index].snippetIndex}] 翻译结果不是日文，已忽略`)
          continue
        }
        chunk[index].data.ttsText = value.trim()
        translated += 1
      }
    } catch (error) {
      logger.warn(
        `[TTS] 日文翻译失败（${offset + 1}-${offset + chunk.length}）：${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  const missing = collectTtsTargets(story).map((target) => target.snippetIndex)
  if (translated > 0) {
    logger.info(
      `[TTS] 已补齐 ${translated} 条日文 ttsText${missing.length ? `，仍缺 ${missing.length} 条` : ''}`
    )
  }
  if (options.strict && missing.length > 0) {
    throw new TtsTextTranslationError(missing)
  }
  return { translated, missing }
}
