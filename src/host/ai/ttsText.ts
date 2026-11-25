import type { ILogObj, Logger } from 'tslog'
import type { StoryData } from '../../common/types/Story'
import { isJapaneseSpeechText } from '../../common/tts/speechText'
import { enforceIrodoriEmojiBudget } from '../../common/tts/irodori'

/** 零宽字符（ZWSP / ZWNJ / Word Joiner / BOM；保留 \u200D ZWJ 以免破坏 😮‍💨 等 Irodori 组合 Emoji） */
const ZERO_WIDTH_CHARS_RE = /[\u200B\u200C\u2060\uFEFF]/gu

/** 剥离文本中的零宽字符（\u200b、\u200c、\u2060、\ufeff），保留 Irodori Emoji 与 ZWJ。 */
export function stripZeroWidthChars(text: string): string {
  return String(text ?? '').replace(ZERO_WIDTH_CHARS_RE, '')
}

/** 检测文本中是否混入了零宽字符（\u200b、\u200c、\u2060、\ufeff）。 */
export function hasZeroWidthChars(text: string): boolean {
  return /[\u200B\u200C\u2060\uFEFF]/u.test(String(text ?? ''))
}

/**
 * 清洗发往 IrodoriTTS 的日文台词：
 * 1. 剥离零宽字符（\u200b、\ufeff 等，保留 \u200D 以兼容组合 Emoji）；
 * 2. 保留 Irodori 情绪表达 Emoji 并按安全白名单与单句预算（<=2）裁剪。
 */
export function cleanTtsText(text: string): string {
  return enforceIrodoriEmojiBudget(stripZeroWidthChars(text), 2)
}

/**
 * IrodoriTTS 只接受日文。宿主在导出前必须把每条 Talk 的 ttsText 补成日文，
 * 不能像以前那样在缺失时把中文 content 直接送去合成。
 *
 * 与 renderer 共用同一判定：含假名，或纯汉字但不含高置信中文标记。
 */
export function isJapaneseText(text: string): boolean {
  return isJapaneseSpeechText(text)
}

/**
 * 是否含需要翻译的语言内容。
 *
 * 只有标点/符号/空白的 Talk（如「……」「——」「♪」）没有可翻译的语义，
 * 也不该因为没有假名被当成“漏翻”阻断整次导出。
 */
export function hasTranslationContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text)
}

export interface TtsTranslationItem {
  text: string
  speaker?: string
  emotion?: string
  ttsCaption?: string
  addressHint?: string
}

export interface TtsTarget {
  snippetIndex: number
  content: string
  speaker?: string
  emotion?: string
  ttsCaption?: string
  data: { ttsText: string; content: string }
}

/** 找出所有没有日文 ttsText 的 Talk（空串、中文、半成品都算）。 */
export function collectTtsTargets(story: StoryData): TtsTarget[] {
  const targets: TtsTarget[] = []
  story.snippets.forEach((snippet, snippetIndex) => {
    if (snippet.type !== 'Talk') return
    const data = snippet.data as {
      ttsText?: string
      content: string
      speaker?: string
      emotion?: string
      ttsCaption?: string
    }
    if (!data.content?.trim()) return
    if (!hasTranslationContent(data.content)) return
    if (isJapaneseText(data.ttsText ?? '')) return
    targets.push({
      snippetIndex,
      content: data.content,
      speaker: data.speaker?.trim() || undefined,
      emotion: data.emotion?.trim() || undefined,
      ttsCaption: data.ttsCaption?.trim() || undefined,
      data: data as TtsTarget['data']
    })
  })
  return targets
}

export type TtsBatchTranslator = (
  texts: string[],
  items?: TtsTranslationItem[]
) => Promise<string[]>

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

export interface EnsureJapaneseTtsOptions {
  chunkSize?: number
  /** 同一轮内同时发出的翻译批次数（默认 3；1 = 串行） */
  concurrency?: number
  /** 仍有缺失时额外补翻的轮数（默认 1；每轮批量会缩小，便于定位到具体台词） */
  retries?: number
  strict?: boolean
}

/** 固定并发跑完一组任务；单个任务内部自己处理错误。 */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const limit = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length))
  let cursor = 0
  const runners = Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      await worker(items[index])
    }
  })
  await Promise.all(runners)
}

/**
 * 批量补齐日文 ttsText。
 *
 * - 已有日文（含假名）的句子原样保留，不重复翻译；
 * - 只有标点/符号的 Talk 不需要翻译，也不计入缺失；
 * - 翻译结果必须仍是长度相同的数组，否则整块放弃并进入下一轮补翻；
 * - strict=true 时，仍有缺失就抛 TtsTextTranslationError（导出前预检用）。
 */
export async function ensureJapaneseTtsText(
  story: StoryData,
  translate: TtsBatchTranslator,
  logger: Pick<Logger<ILogObj>, 'info' | 'warn'>,
  options: EnsureJapaneseTtsOptions = {}
): Promise<EnsureJapaneseTtsResult> {
  const baseChunkSize = Math.max(1, options.chunkSize ?? 20)
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 3))
  const retries = Math.max(0, Math.floor(options.retries ?? 1))
  let translated = 0

  // 预先清洗已有 Talk 的 content 与 ttsText 中的零宽字符（保留 Irodori Emoji）
  for (const snippet of story.snippets) {
    if (snippet.type !== 'Talk') continue
    const data = snippet.data as { content?: string; ttsText?: string }
    if (typeof data.content === 'string' && hasZeroWidthChars(data.content)) {
      data.content = stripZeroWidthChars(data.content)
    }
    if (typeof data.ttsText === 'string' && data.ttsText && hasZeroWidthChars(data.ttsText)) {
      data.ttsText = stripZeroWidthChars(data.ttsText)
    }
  }

  // 第一轮按正常批量翻译；仍缺时再补翻，批量缩小以降低“一条坏掉整块丢弃”的影响。
  for (let attempt = 0; attempt <= retries; attempt++) {
    const targets = collectTtsTargets(story)
    if (targets.length === 0) break
    const chunkSize = attempt === 0 ? baseChunkSize : Math.max(1, Math.min(5, baseChunkSize))
    if (attempt > 0) {
      logger.info(`[TTS] 仍有 ${targets.length} 条缺少日文 ttsText，开始第 ${attempt + 1} 轮补翻`)
    }

    const chunks: TtsTarget[][] = []
    for (let offset = 0; offset < targets.length; offset += chunkSize) {
      chunks.push(targets.slice(offset, offset + chunkSize))
    }
    // 各批次互不依赖，并发发送；长台词分 3 批时翻译时间和单批持平。
    await runWithConcurrency(chunks, concurrency, async (chunk) => {
      const input = chunk.map((target) => target.content)
      const items: TtsTranslationItem[] = chunk.map((target) => ({
        text: target.content,
        ...(target.speaker ? { speaker: target.speaker } : {}),
        ...(target.emotion ? { emotion: target.emotion } : {}),
        ...(target.ttsCaption ? { ttsCaption: target.ttsCaption } : {})
      }))
      try {
        const output = await translate(input, items)
        if (!Array.isArray(output) || output.length !== input.length) {
          logger.warn(
            `[TTS] 日文翻译数量不匹配（期望 ${input.length}，收到 ${
              Array.isArray(output) ? output.length : 0
            }），保留缺失 ttsText`
          )
          return
        }
        for (let index = 0; index < chunk.length; index++) {
          const rawValue = output[index]
          const value = typeof rawValue === 'string' ? cleanTtsText(rawValue) : ''
          if (!value || !isJapaneseText(value)) {
            logger.warn(`[TTS] snippets[${chunk[index].snippetIndex}] 翻译结果不是日文，已忽略`)
            continue
          }
          chunk[index].data.ttsText = value
          translated += 1
        }
      } catch (error) {
        logger.warn(
          `[TTS] 日文翻译失败（${chunk[0]?.snippetIndex ?? 0} 起 ${chunk.length} 条）：${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    })
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
