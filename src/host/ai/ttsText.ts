import type { ILogObj, Logger } from 'tslog'
import type { StoryData } from '../../common/types/Story'
import { isJapaneseSpeechText } from '../../common/tts/speechText'
import {
  enforceIrodoriEmojiBudget,
  extractIrodoriEmojis,
  sanitizeIrodoriCaption,
  stripJoyfulIrodoriEmojis
} from '../../common/tts/irodori'

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
  const retries = Math.max(0, Math.floor(options.retries ?? 2))
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

  // 第一轮按正常批量翻译；仍缺时再补翻，最终残余少数台词切至单句粒度防止坏句拖累整块。
  for (let attempt = 0; attempt <= retries; attempt++) {
    const targets = collectTtsTargets(story)
    if (targets.length === 0) break
    const chunkSize =
      attempt === 0
        ? baseChunkSize
        : attempt >= 2 && targets.length <= 6
          ? 1
          : Math.max(1, Math.min(5, baseChunkSize))
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

const SORROWFUL_EMOJI_SET = new Set(['😭', '🥺', '😮‍💨', '😰', '😟', '😖', '🤧'])
const ANGRY_EMOJI_SET = new Set(['😠', '😰', '😖', '🌬️', '😭'])
const SHOCK_EMOJI_SET = new Set(['😲', '😱', '😮', '😰'])
const TRICKY_BRIGHT_LEXICAL_RE =
  /大丈夫|友達|冗談|笑|一緒|楽し|嬉し|安心|温柔|優し|バカ|馬鹿|平気|没关系|朋友|开玩笑|笨蛋/

const SPOKEN_STRIP_RE =
  /(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}\uFE0F?)*)|[\s….\-—–―〜～!！?？、,，。・♪「」『』（）()]+/gu

const countSpokenChars = (text: string): number => text.replace(SPOKEN_STRIP_RE, '').length

interface TalkSignalProfile {
  snippetIndex: number
  data: Record<string, unknown>
  content: string
  ttsText: string
  emotion: string
  isCryFacial: boolean
  isSadFacial: boolean
  isTroubleFacial: boolean
  isCloseEyeFacial: boolean
  isAngryFacial: boolean
  isShockFacial: boolean
  isSmileFacial: boolean
  isSighMotion: boolean
  hasCryOrBreakupCue: boolean
  hasSorrowfulToneCue: boolean
  hasPositiveSurfaceWords: boolean
  hasBreathOrPantCue: boolean
  isShouting: boolean
  isMonologue: boolean
  baseSadOrCry: boolean
}

export interface AlignTtsEmotionsResult {
  updatedEmotions: number
  updatedCaptions: number
  updatedEmojis: number
  updatedSpecialScenes: number
}

function extractSpeakerSignals(data: Record<string, unknown>): {
  facials: string[]
  motions: string[]
} {
  const modelId = typeof data.modelId === 'number' ? data.modelId : undefined
  const facials: string[] = []
  const motions: string[] = []
  if (typeof data.facial === 'string' && data.facial.trim()) facials.push(data.facial.trim())
  if (typeof data.motion === 'string' && data.motion.trim()) motions.push(data.motion.trim())
  if (Array.isArray(data.actions)) {
    for (const act of data.actions) {
      if (!act || typeof act !== 'object') continue
      const rec = act as Record<string, unknown>
      if (modelId !== undefined && rec.modelId !== undefined && rec.modelId !== modelId) continue
      if (typeof rec.facial === 'string' && rec.facial.trim()) facials.push(rec.facial.trim())
      if (typeof rec.motion === 'string' && rec.motion.trim()) motions.push(rec.motion.trim())
    }
  }
  return { facials, motions }
}

function buildTalkSignalProfile(
  snippetIndex: number,
  data: Record<string, unknown>
): TalkSignalProfile {
  const content = typeof data.content === 'string' ? data.content.trim() : ''
  const ttsText = typeof data.ttsText === 'string' ? stripZeroWidthChars(data.ttsText).trim() : ''
  const emotion = typeof data.emotion === 'string' ? data.emotion.trim() : ''
  const { facials, motions } = extractSpeakerSignals(data)
  const facialJoined = facials.join(' ').toLowerCase()
  const motionJoined = motions.join(' ').toLowerCase()
  const combinedText = `${content}\n${ttsText}`

  const isCryFacial = /(?:^|_)cry|ecry|teary|nhicry/.test(facialJoined)
  const isSadFacial =
    /(?:^|_)(?:sad|heartbreak|desperate|regret|lookdown|sigh|nhisad)/.test(facialJoined) ||
    /face_dark.*sad/.test(facialJoined)
  const isTroubleFacial = /(?:^|_)(?:trouble|worry|dizzy|breath)/.test(facialJoined)
  const isCloseEyeFacial = /closeeye/.test(facialJoined)
  const isAngryFacial = /(?:^|_)(?:angry|disgust|scream|hate|complain)/.test(facialJoined)
  const isShockFacial = /(?:^|_)(?:surprise|shock|scared|nsscared|baffling|notice)/.test(
    facialJoined
  )
  const isSmileFacial = /(?:^|_)(?:smile|wink|smug|doya|sparkling|play|delicious)/.test(
    facialJoined
  )
  const isSighMotion = /sigh/.test(motionJoined)

  const hasCryOrBreakupCue =
    /对不起|抱歉|别走|不要走|求你|回不去|再见|受不了|逃走|逃がし|怎么可能|可恶|哭|眼泪|哽咽|ごめん|行かないで|戻れない|さよなら|耐えられない|くそっ|信じたい|許して|助けて/.test(
      combinedText
    )
  const hasSorrowfulToneCue =
    /瞒着|顾虑|小心翼翼|难过|伤心|痛苦|委屈|孤独|寂寞|害怕|不安|勉强|装作|避开|停顿|再也没办法|笑不出来|勇気なんて|傷つけ|気を遣う|腫れ物|笑うことなんてできない|押し殺|嫌われる|隠してた|泣|涙|つら|苦し/.test(
      combinedText
    )
  const hasPositiveSurfaceWords = TRICKY_BRIGHT_LEXICAL_RE.test(combinedText)
  const hasBreathOrPantCue = /はぁ……はぁ|ふぅ……|息を|🌬️/.test(combinedText)
  const isShouting = /！！|!!|——！！|——!!/.test(combinedText)
  const isMonologue = /^[（(].*[）)]$/s.test(content)

  const baseSadOrCry =
    emotion === '伤心' || isCryFacial || isSadFacial || hasCryOrBreakupCue || hasSorrowfulToneCue

  return {
    snippetIndex,
    data,
    content,
    ttsText,
    emotion,
    isCryFacial,
    isSadFacial,
    isTroubleFacial,
    isCloseEyeFacial,
    isAngryFacial,
    isShockFacial,
    isSmileFacial,
    isSighMotion,
    hasCryOrBreakupCue,
    hasSorrowfulToneCue,
    hasPositiveSurfaceWords,
    hasBreathOrPantCue,
    isShouting,
    isMonologue,
    baseSadOrCry
  }
}

function buildAlignedTtsCaption(emotion: string, profile: TalkSignalProfile): string {
  if (emotion === '伤心') {
    if (profile.isCryFacial && (profile.isShouting || profile.hasCryOrBreakupCue)) {
      return '涙をこらえきれず、声を震わせて悲痛に訴えかける。'
    }
    if (profile.isCryFacial) {
      return '今にも泣き崩れそうな声で、言葉を詰まらせながら話す。'
    }
    if (/对不起|抱歉|ごめん|すみません/.test(`${profile.content}\n${profile.ttsText}`)) {
      return '申し訳なさに声を落とし、震えを抑えながら静かに謝る。'
    }
    if (profile.isSighMotion || /😮‍💨/.test(profile.ttsText)) {
      return '諦めと切なさを滲ませ、小さなため息混じりに呟く。'
    }
    if (profile.isMonologue) {
      return '胸の奥で押し殺すように、寂しく静かな独白を漏らす。'
    }
    return '悲しみを堪えながら、少し潤んだ控えめな口調で話す。'
  }
  if (emotion === '生气') {
    if (profile.hasBreathOrPantCue) {
      return '息を切らしながら、焦りと必死さを込めて呼びかける。'
    }
    if (profile.isShouting) {
      return '感情が高ぶり、必死に相手を止めようと強い口調で叫ぶ。'
    }
    return '苛立ちと真剣さを滲ませ、少し強い語気で問い詰める。'
  }
  if (emotion === '惊讶') {
    return '思いがけない言葉に息をのみ、動揺した様子で問い返す。'
  }
  if (emotion === '害羞') {
    return '少し照れながら、控えめに視線を逸らして話す。'
  }
  if (emotion === '开心') {
    return '柔らかく明るい表情が伝わるような、温かく軽やかな口調で話す。'
  }
  if (profile.isMonologue) {
    return '心の中で確かめるように、落ち着いた静かなトーンで呟く。'
  }
  return '落ち着いた自然なペースで、相手に向き合って静かに話す。'
}

const VOICE_SPECIAL_SCENE_MAX_RATIO = 0.15

function prependOrAnchorEmoji(ttsText: string, emoji: string): string {
  if (!ttsText) return ttsText
  // 已有 2 个非目标类表情（如 🐢）时，优先保住情绪表情并裁剪总数至 <= 2
  const leadingMatch = /^(……+|[.]{3,}|[—―]+)\s*/u.exec(ttsText)
  const combined = leadingMatch
    ? `${leadingMatch[1]}${emoji} ${ttsText.slice(leadingMatch[0].length)}`.trim()
    : `${emoji} ${ttsText}`.trim()
  return enforceIrodoriEmojiBudget(combined, 2)
}

/**
 * 为悲伤/哭泣台词确保哭腔表情出现在句首（第 0 帧）或关键明亮词从句之前：
 * - 若整句没有悲伤表情，直接在句首锚定；
 * - 若唯一悲伤表情位于句尾（末尾之后无实词），前移到句首，防止整句先以平调/亮调合成；
 * - 若悲伤表情在句中，且前半句含「笑/冗談/大丈夫/バカ/友達」等易飘亮词，或处于哭戏/高潮长句开头，
 *   在句首补一个 🥺/😭（总表情数仍控制在 <= 2），从第 0 帧锁定哭腔声线。
 */
function ensureSorrowEmojiFraming(
  ttsText: string,
  chosen: string,
  profile: TalkSignalProfile,
  emotion: string
): string {
  const tokens = extractIrodoriEmojis(ttsText)
  const firstSorrowIdx = tokens.findIndex((tok) => SORROWFUL_EMOJI_SET.has(tok))
  if (firstSorrowIdx === -1) {
    return prependOrAnchorEmoji(ttsText, chosen)
  }

  const firstSorrow = tokens[firstSorrowIdx]
  const pos = ttsText.indexOf(firstSorrow)
  const beforeFirst = pos >= 0 ? ttsText.slice(0, pos) : ''
  const afterFirst = pos >= 0 ? ttsText.slice(pos + firstSorrow.length) : ''
  const spokenBefore = countSpokenChars(beforeFirst)
  const spokenAfter = countSpokenChars(afterFirst)

  // 已经在第 0 帧（表情前没有实词，仅有前导省略号/破折号/空白）
  if (spokenBefore === 0) {
    return ttsText
  }

  // 悲伤表情落在句尾（后面没有实词）：前移到句首
  if (spokenAfter === 0 && tokens.length === 1) {
    const withoutTrailing = `${beforeFirst}${afterFirst}`.replace(/[ \t]{2,}/g, ' ').trim()
    return prependOrAnchorEmoji(withoutTrailing, firstSorrow)
  }

  const prefixHasTrickyCue = TRICKY_BRIGHT_LEXICAL_RE.test(beforeFirst)
  const isDesperateCry =
    profile.isCryFacial &&
    (profile.isShouting || profile.hasCryOrBreakupCue || profile.data.ttsSpecialScene === true)
  const needsFrame0Anchor =
    prefixHasTrickyCue ||
    (spokenBefore >= 4 &&
      (profile.hasPositiveSurfaceWords ||
        profile.isCryFacial ||
        profile.hasCryOrBreakupCue ||
        profile.data.ttsSpecialScene === true))

  if (!needsFrame0Anchor) {
    return ttsText
  }

  // 句首补齐哭腔锚点；若句首存在加速表情 ⏩ 会在悲伤句引发急促亮调，先剥离再锚定
  const strippedPace = ttsText.replace(/⏩/gu, '').replace(/[ \t]{2,}/g, ' ').trim()
  const frame0Emoji =
    isDesperateCry || (profile.isShouting && emotion === '伤心')
      ? '😭'
      : firstSorrow === '😭' && !prefixHasTrickyCue
        ? '😭'
        : '🥺'
  return prependOrAnchorEmoji(strippedPace, frame0Emoji)
}

function scoreSpecialClimax(emotion: string, profile: TalkSignalProfile): number {
  if (emotion === '平静' || emotion === '开心' || emotion === '害羞') return 0
  let score = 0
  if (emotion === '伤心') score += 2
  if (emotion === '生气') score += 1
  if (profile.isCryFacial) score += 3
  if (profile.isShouting) score += 3
  if (profile.hasCryOrBreakupCue) score += 2
  if (profile.ttsText.includes('😭')) score += 2
  const caption = typeof profile.data.ttsCaption === 'string' ? profile.data.ttsCaption : ''
  if (/涙|泣|悲痛|叫|震/.test(caption)) score += 1
  return score
}

/**
 * 语音情绪与 Irodori 表演一致性对齐（同时服务 native agent 与 staged 流水线）：
 * 1. 把哭泣/悲伤/紧绷语境中错标的「平静」纠正为「伤心」（或「生气」「惊讶」）；
 * 2. 在悲伤/愤怒/惊愕语境下剥离欢快表情（🤭😆😊😏🫶🎵😌），防止 TTS 笑场；
 * 3. 为缺少情绪锚点的哭泣/悲伤句（含「大丈夫」「友達」「冗談」「笑」等正字面词）补齐 😭/🥺/😮‍💨，
 *    严格遵守 <= 2 表情预算并保留 \u200D / \uFE0F；
 * 4. 补齐缺失的日语 ttsCaption（清洗身份词）、ttsSpeed 与高潮句 ttsSpecialScene（<= 15% 上限）。
 */
export function alignStoryTtsEmotionsAndCaptions(
  story: StoryData,
  options: { emotionLabels?: string[] } = {}
): AlignTtsEmotionsResult {
  const allowedLabels = new Set(
    (options.emotionLabels ?? []).map((label) => label.trim()).filter(Boolean)
  )
  const canUseLabel = (label: string): boolean =>
    allowedLabels.size === 0 || allowedLabels.has(label)

  const profiles: TalkSignalProfile[] = []
  story.snippets.forEach((snippet, idx) => {
    if (snippet.type !== 'Talk' || !('data' in snippet) || !snippet.data) return
    profiles.push(buildTalkSignalProfile(idx, snippet.data as unknown as Record<string, unknown>))
  })

  if (profiles.length === 0) {
    return {
      updatedEmotions: 0,
      updatedCaptions: 0,
      updatedEmojis: 0,
      updatedSpecialScenes: 0
    }
  }

  let updatedEmotions = 0
  let updatedCaptions = 0
  let updatedEmojis = 0
  let updatedSpecialScenes = 0

  const effectiveEmotions: string[] = profiles.map((p) => p.emotion)

  // Pass 1: 结合自身面部表情、台词线索与上下文窗口修正错标情绪
  for (let i = 0; i < profiles.length; i++) {
    const p = profiles[i]
    let hasPrevSad = false
    let hasNextSad = false
    let hasNearbySadFacial = false
    for (let d = -3; d <= -1; d++) {
      const nb = profiles[i + d]
      if (!nb) continue
      if (nb.emotion === '伤心' || nb.isCryFacial || nb.hasCryOrBreakupCue || nb.hasSorrowfulToneCue) {
        hasPrevSad = true
      }
      if (Math.abs(d) <= 2 && nb.isSadFacial) hasNearbySadFacial = true
    }
    for (let d = 1; d <= 3; d++) {
      const nb = profiles[i + d]
      if (!nb) continue
      if (nb.emotion === '伤心' || nb.isCryFacial || nb.hasCryOrBreakupCue || nb.hasSorrowfulToneCue) {
        hasNextSad = true
      }
      if (Math.abs(d) <= 2 && nb.isSadFacial) hasNearbySadFacial = true
    }
    const inSadContext = hasPrevSad || (hasNextSad && (p.hasCryOrBreakupCue || p.hasSorrowfulToneCue))
    const hasSadTextSignal = p.hasCryOrBreakupCue || p.hasSorrowfulToneCue || p.hasPositiveSurfaceWords

    let nextEmotion = p.emotion
    if (p.isCryFacial && p.emotion !== '伤心' && canUseLabel('伤心')) {
      nextEmotion = '伤心'
    } else if (!p.emotion || p.emotion === '平静') {
      if (
        ((p.isSadFacial && (inSadContext || hasNextSad || hasNearbySadFacial || hasSadTextSignal)) ||
          (hasPrevSad &&
            (p.isTroubleFacial || p.isCloseEyeFacial) &&
            (hasNextSad || hasNearbySadFacial || hasSadTextSignal)) ||
          (inSadContext && (p.hasCryOrBreakupCue || p.hasSorrowfulToneCue))) &&
        canUseLabel('伤心')
      ) {
        nextEmotion = '伤心'
      } else if (p.isAngryFacial && canUseLabel('生气')) {
        nextEmotion = '生气'
      } else if (p.isShockFacial && canUseLabel('惊讶')) {
        nextEmotion = '惊讶'
      }
    }

    if (nextEmotion !== p.emotion) {
      p.data.emotion = nextEmotion
      p.emotion = nextEmotion
      updatedEmotions += 1
    }
    effectiveEmotions[i] = nextEmotion
  }

  // Pass 2: 清洗欢快表情、补齐哭泣/悲伤/紧张表情、补齐 ttsCaption 与 ttsSpeed
  for (let i = 0; i < profiles.length; i++) {
    const p = profiles[i]
    const emo = effectiveEmotions[i]
    const isSadOrCrying = emo === '伤心' || p.isCryFacial
    const isAngryOrTense = !isSadOrCrying && (emo === '生气' || p.isAngryFacial)
    const isShocked = !isSadOrCrying && !isAngryOrTense && (emo === '惊讶' || p.isShockFacial)

    // 2a. 仅对含可翻译内容且已有日文 ttsText 的句子做表情约束
    if (
      hasTranslationContent(p.content) &&
      p.ttsText &&
      isJapaneseText(p.ttsText)
    ) {
      let nextTts = stripZeroWidthChars(p.ttsText)
      if (isSadOrCrying || isAngryOrTense || isShocked) {
        const stripped = stripJoyfulIrodoriEmojis(nextTts, isSadOrCrying || isAngryOrTense)
        if (stripped && isJapaneseText(stripped)) {
          nextTts = stripped
        }
      }

      const allowFastPaceOnSad =
        p.data.ttsSpecialScene === true &&
        /!{2,}|！{2,}|助けて|待って/.test(`${p.content}\n${nextTts}`)
      if (isSadOrCrying && nextTts.includes('⏩') && !allowFastPaceOnSad) {
        nextTts = nextTts.replace(/⏩/gu, '').replace(/[ \t]{2,}/g, ' ').trim()
      }

      const tokens = extractIrodoriEmojis(nextTts)
      if (isSadOrCrying) {
        const isDesperateCry =
          p.isCryFacial &&
          (p.isShouting || p.hasCryOrBreakupCue || p.data.ttsSpecialScene === true)
        const chosen = isDesperateCry || (p.isShouting && emo === '伤心')
          ? '😭'
          : p.isSighMotion && !p.isCryFacial && !p.hasPositiveSurfaceWords && !p.hasCryOrBreakupCue
            ? '😮‍💨'
            : '🥺'
        nextTts = ensureSorrowEmojiFraming(nextTts, chosen, p, emo)
      } else if (isAngryOrTense) {
        const hasAngry = tokens.some((tok) => ANGRY_EMOJI_SET.has(tok))
        if (!hasAngry && (p.isAngryFacial || p.isShouting)) {
          nextTts = prependOrAnchorEmoji(nextTts, '😠')
        }
      } else if (isShocked) {
        const hasShock = tokens.some((tok) => SHOCK_EMOJI_SET.has(tok))
        if (!hasShock && (p.isShockFacial || /[？?][！!]|[！!][？?]/.test(p.content))) {
          nextTts = prependOrAnchorEmoji(nextTts, '😲')
        }
      }

      nextTts = enforceIrodoriEmojiBudget(nextTts, 2)
      if (nextTts !== p.ttsText) {
        p.data.ttsText = nextTts
        p.ttsText = nextTts
        updatedEmojis += 1
      }
    }

    // 2b. 补齐并清洗日语 ttsCaption（严禁年龄/性别身份词；伤心句严禁积极/笑颜词根）
    const rawExistingCaption =
      typeof p.data.ttsCaption === 'string' ? p.data.ttsCaption : ''
    const existingCaption = rawExistingCaption ? sanitizeIrodoriCaption(rawExistingCaption, emo) : ''
    if (existingCaption) {
      if (existingCaption !== rawExistingCaption) {
        p.data.ttsCaption = existingCaption
        updatedCaptions += 1
      }
    } else if (hasTranslationContent(p.content)) {
      const generated = sanitizeIrodoriCaption(buildAlignedTtsCaption(emo, p), emo)
      if (generated) {
        p.data.ttsCaption = generated
        updatedCaptions += 1
      }
    }

    // 2c. 补齐合理语速微调（不覆盖模型已有合法值；非喊叫的伤心+正面词句收紧至 <= 0.94，普通非高潮伤心 <= 0.95）
    if (hasTranslationContent(p.content)) {
      if (typeof p.data.ttsSpeed !== 'number' || !Number.isFinite(p.data.ttsSpeed)) {
        if (emo === '伤心') {
          p.data.ttsSpeed = p.data.ttsSpecialScene === true ? 0.88 : p.isSighMotion ? 0.95 : 0.94
        } else if (emo === '生气') {
          p.data.ttsSpeed = p.isShouting || p.hasBreathOrPantCue ? 1.05 : 1.03
        } else if (emo === '惊讶') {
          p.data.ttsSpeed = 1.04
        } else if (emo === '开心') {
          p.data.ttsSpeed = 1.02
        } else if (emo === '害羞') {
          p.data.ttsSpeed = 0.97
        } else {
          p.data.ttsSpeed = 1.0
        }
      } else if (emo === '伤心') {
        if (!p.isShouting && p.hasPositiveSurfaceWords && p.data.ttsSpeed > 0.94) {
          p.data.ttsSpeed = 0.94
        } else if (p.data.ttsSpecialScene !== true && p.data.ttsSpeed > 0.95) {
          p.data.ttsSpeed = 0.95
        }
      }
    }
  }

  // Pass 3: 若整场缺少 ttsSpecialScene（典型于 native agent 输出），在 15% 上限内晋升最强哭喊/撕裂高潮句
  const maxSpecial = Math.floor(profiles.length * VOICE_SPECIAL_SCENE_MAX_RATIO)
  const existingSpecialCount = profiles.filter((p) => p.data.ttsSpecialScene === true).length
  if (existingSpecialCount < maxSpecial) {
    const remainingSlots = maxSpecial - existingSpecialCount
    const candidates = profiles
      .map((p, idx) => ({
        idx,
        profile: p,
        score: p.data.ttsSpecialScene === true ? 0 : scoreSpecialClimax(effectiveEmotions[idx], p)
      }))
      .filter((entry) => entry.score >= 5 && hasTranslationContent(entry.profile.content))
      .sort((a, b) => b.score - a.score || a.idx - b.idx)
      .slice(0, remainingSlots)

    for (const candidate of candidates) {
      candidate.profile.data.ttsSpecialScene = true
      if (
        effectiveEmotions[candidate.idx] === '伤心' &&
        (typeof candidate.profile.data.ttsSpeed !== 'number' ||
          candidate.profile.data.ttsSpeed >= 0.92)
      ) {
        candidate.profile.data.ttsSpeed = 0.88
      }
      updatedSpecialScenes += 1
    }
  }

  return {
    updatedEmotions,
    updatedCaptions,
    updatedEmojis,
    updatedSpecialScenes
  }
}
