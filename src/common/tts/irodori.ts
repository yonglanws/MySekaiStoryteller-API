/**
 * Irodori-TTS 请求构造、表演描述清洗与非语言行护栏（宿主与渲染端共用）。
 *
 * Irodori-TTS-Server 提供 OpenAI 兼容的 `POST /v1/audio/speech`：
 * 顶层是 `model` / `input` / `response_format` / `speed`，推理参数放在 `irodori` 对象里。
 * 参考音频、LoRA adapter、caption 都是 **服务端可见路径/文本**，不是浏览器上传的文件。
 */

export type IrodoriResponseFormat = 'wav' | 'mp3' | 'ogg'
export type IrodoriTimbreLockMode = 'normal' | 'off'

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
  /** 早期去噪步说话人 K/V 缩放（>1.0 锁定角色底色） */
  speakerKvScale?: number
  /** speaker_kv_scale 生效的最小时间步（默认 0.9） */
  speakerKvMinT?: number
  /** 可选：限制 speaker_kv_scale 作用的最大层数 */
  speakerKvMaxLayers?: number
  /** 音色锁模式：normal=普通句锁基础参考音频，off=允许按 emotion 切换 */
  timbreLockMode?: IrodoriTimbreLockMode
  /** 特殊场景（ttsSpecialScene=true）时的 cfg_scale_caption 引导强度（默认 3.6） */
  specialSceneCfgScaleCaption?: number
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

export interface IrodoriLineOverride {
  ttsCaption?: string
  ttsSpeed?: number
  ttsSpecialScene?: boolean
  cfgScaleCaption?: number
  /** 可选：当前句情绪标签，用于在构造请求前剥离与悲伤/愤怒冲突的欢快表情 */
  emotion?: string
}

export interface ResolveIrodoriVoiceOptions {
  timbreLockMode?: IrodoriTimbreLockMode
  lineOverride?: IrodoriLineOverride
}

export interface NormalizedIrodoriSpeech {
  text: string
  caption?: string
  skip?: boolean
}

/** 适用于 PJSK 剧情的 Irodori 官方训练内联表情白名单 */
export const IRODORI_SAFE_EMOJIS = [
  '🤭',
  '😮‍💨',
  '🥺',
  '😰',
  '😆',
  '😊',
  '😠',
  '😭',
  '😲',
  '🫣',
  '😌',
  '🙄',
  '😏',
  '🫶',
  '⏸️',
  '⏩',
  '🐢',
  '😮',
  '🌬️',
  '👂',
  '😟',
  '🙏',
  '😖',
  '🤔',
  '💪',
  '💥',
  '😱',
  '🤧',
  '👌',
  '🎵'
] as const

/** 剧情中禁止出现的 ASMR/失真类表情 */
export const IRODORI_UNSAFE_EMOJIS = [
  '🥵',
  '👅',
  '💋',
  '😴',
  '🥤',
  '🥴',
  '👃',
  '📢',
  '📞',
  '🤐'
] as const

/** 在悲伤/哭泣/愤怒/惊愕语境中必须剥离的欢快/调侃类表情 */
export const IRODORI_JOYFUL_EMOJIS = ['🤭', '😆', '😊', '😏', '🫶', '🎵'] as const

const NORMAL_SPEED_MIN = 0.92
const NORMAL_SPEED_MAX = 1.08
const SPECIAL_SPEED_MIN = 0.85
const SPECIAL_SPEED_MAX = 1.18
const SPECIAL_SPEAKER_CFG_MIN = 4.5
const DEFAULT_SPECIAL_CAPTION_CFG = 3.6
const MAX_CAPTION_LENGTH = 120
const MAX_EMOJIS_PER_LINE = 2

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const refsOf = (voice: IrodoriVoiceConfig): string[] =>
  (voice.refAudioPaths ?? []).map((item) => item.trim()).filter(Boolean)

/**
 * 说话人身份 / 年龄 / 性别 / 基础音色词（会与参考音频与 LoRA 冲突，导致音色漂移）。
 * 按最长短语优先匹配，并顺带清理紧随其后的助词（の/が/で/として/のような/っぽい）。
 */
const IDENTITY_CONFLICT_PATTERN = new RegExp(
  '(?:' +
    [
      '若い女性',
      '大人の女性',
      '成人女性',
      '高齢女性',
      '中年女性',
      '若い男性',
      '大人の男性',
      '成人男性',
      '高齢男性',
      '中年男性',
      '女子高生',
      '女子中学生',
      '男子高生',
      '男子中学生',
      '美少女',
      '美少年',
      '男の子',
      '女の子',
      'おじいさん',
      'おばあさん',
      'おじさん',
      'おばさん',
      '子供っぽい声',
      '子どもっぽい声',
      '子供の声',
      '子どもの声',
      '中性的(?:な)?声',
      'ハスキーな声',
      '可愛らしい声',
      'かわいい声',
      '透き通る声',
      '澄んだ声',
      'アニメ声',
      'ロリ声',
      'ショタ声',
      '幼い声',
      '低めの声',
      '高めの声',
      '低い声',
      '高い声',
      '太い声',
      '細い声',
      'イケボ',
      'カワボ',
      '少女',
      '少年',
      '幼女',
      '幼児',
      '女声',
      '男声',
      '女性',
      '男性',
      'ロリ',
      'ショタ',
      '年轻女性',
      '成年女性',
      '年轻男性',
      '成年男性',
      '少女音',
      '少年音',
      '萝莉音',
      '御姐音',
      '大叔音',
      '低沉女声',
      '低沉男声',
      '高音女声'
    ].join('|') +
    ')(?:のような|みたいな|っぽい|らしい|として|による|の|が|で|は)?',
  'gu'
)

/**
 * 悲伤/哭泣语境中必须剥离的积极/笑颜词根（即便出现「笑顔ではなく」等否定句式，
 * 也会把扩散注意力拉向笑意，导致悲伤声线发亮或笑场）。
 */
const SAD_POSITIVE_TOKEN_PATTERN =
  /(?:明るい|明るく|明るさ|笑顔|楽しい|楽しく|楽しそう|楽しげ|楽しみ|嬉しい|嬉しく|嬉しそう|嬉しげ|笑い|笑う|笑って|笑わ|笑み|微笑|愉快|陽気|ウキウキ|軽やか|弾むよう|はしゃ)/u

const SAD_POSITIVE_INLINE_PHRASE_PATTERN = new RegExp(
  '(?:無理に|強いて|わざと|いつものように|少し)?[^、。]*?' +
    '(?:明るい|明るく|明るさ|笑顔|楽しい|楽しく|楽しそう|楽しげ|楽しみ|嬉しい|嬉しく|嬉しそう|嬉しげ|笑い|笑う|笑って|笑わ|笑み|微笑|愉快|陽気|ウキウキ|軽やか|弾むよう|はしゃ)' +
    '(?:[^、。]*?(?:ではなくて?|じゃなくて?|ずに|ないで|とは裏腹に|を装って?|を装い|を隠して?|を作ろうとして?|を作ろうとし|を作って?|を浮かべようとして?|を浮かべようとし|を浮かべて?|を浮かべ|ながらも?|ながら|つつも?|つつ|ように)|(?:な|に|く|で|を|が|と|の))?',
  'gu'
)

function stripSadPositiveCaptionClauses(caption: string): string {
  const sentences = caption.split(/(?<=。)/u).filter((s) => s.trim().length > 0)
  const keptSentences: string[] = []
  for (const sentence of sentences) {
    const endsWithPeriod = sentence.trim().endsWith('。')
    const body = endsWithPeriod ? sentence.trim().slice(0, -1) : sentence.trim()
    const clauses = body
      .split(/、/u)
      .map((c) => c.trim())
      .filter(Boolean)
    const keptClauses: string[] = []
    for (const clause of clauses) {
      if (!SAD_POSITIVE_TOKEN_PATTERN.test(clause)) {
        keptClauses.push(clause)
        continue
      }
      // 单句无逗号分割时，剥离含积极词根的否定/对比短语，保留后半句真实悲伤描述
      if (clauses.length === 1) {
        const strippedSingle = clause
          .replace(SAD_POSITIVE_INLINE_PHRASE_PATTERN, '')
          .replace(/^(?:ではなくて?|じゃなくて?|ずに|ないで)[、,\s]*/u, '')
          .trim()
        if (
          strippedSingle &&
          !SAD_POSITIVE_TOKEN_PATTERN.test(strippedSingle) &&
          !/^(?:話す|話している|言う|呟く|答える|返す)$/u.test(strippedSingle)
        ) {
          keptClauses.push(strippedSingle)
        }
      }
    }
    if (keptClauses.length > 0) {
      keptSentences.push(keptClauses.join('、') + (endsWithPeriod ? '。' : ''))
    }
  }
  return keptSentences.join(' ')
}

/**
 * 清洗 Irodori 表演描述（caption）：
 * 1. 剥离年龄/性别/基础音色等与参考音频/LoRA 冲突的身份词；
 * 2. 当 emotion 为「伤心」时，剥离积极/笑颜词根（含否定形式如「笑顔ではなく」）；
 * 3. 折叠多余空白与残余标点；
 * 4. 控制长度在 120 字符以内，优先在句末标点截断。
 */
export function sanitizeIrodoriCaption(caption: string, emotion?: string): string {
  const raw = text(caption)
  if (!raw) return ''

  let cleaned = raw.replace(/[\r\n\t]+/g, ' ').replace(IDENTITY_CONFLICT_PATTERN, '')

  if (text(emotion) === '伤心') {
    cleaned = stripSadPositiveCaptionClauses(cleaned)
  }

  cleaned = cleaned
    .replace(/\s+/g, ' ')
    .replace(/[、,，]{2,}/g, '、')
    .replace(/[。.]{2,}/g, '。')
    .replace(/([。！？!?])[、,，]+/g, '$1')
    .replace(/^[、,，。・/\-—–\s]+/, '')
    .replace(/[、,，・/\-—–\s]+$/, '')
    .trim()

  if (!cleaned) return ''
  if (cleaned.length > MAX_CAPTION_LENGTH) {
    const slice = cleaned.slice(0, MAX_CAPTION_LENGTH)
    const lastStop = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('、'))
    cleaned = (lastStop >= 24 ? slice.slice(0, lastStop + 1) : slice).trim()
  }
  return cleaned
}

const UNSAFE_EMOJI_PATTERN = new RegExp(
  IRODORI_UNSAFE_EMOJIS.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'gu'
)

const JOYFUL_EMOJI_PATTERN = new RegExp(
  IRODORI_JOYFUL_EMOJIS.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'gu'
)

const SAFE_EMOJI_SET = new Set<string>(IRODORI_SAFE_EMOJIS)

/** 匹配单/组合 Emoji（含 ZWJ 与 FE0F 变体选择符，如 😮‍💨、⏸️、🌬️） */
const EMOJI_TOKEN_PATTERN =
  /(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}\uFE0F?)*)/gu

/** 仅含标点/省略号/破折号/叹号/孤立促音/空白的非语言行（无实词） */
const BARE_NON_VERBAL_PATTERN = /^[\s….\-—–―ー〜～!！?？、,，。・♪っッ「」『』（）()]+$/u

/** 提取文本中的所有 Irodori Emoji（保留 ZWJ 与 FE0F）。 */
export function extractIrodoriEmojis(input: string): string[] {
  return String(input ?? '').match(EMOJI_TOKEN_PATTERN) ?? []
}

/** 剥离欢快/调侃类内联表情（保留悲伤/紧张表情与 ZWJ/FE0F）。 */
export function stripJoyfulIrodoriEmojis(input: string, includeRelieved = false): string {
  const withoutJoyful = String(input ?? '').replace(JOYFUL_EMOJI_PATTERN, '')
  const cleaned = includeRelieved ? withoutJoyful.replace(/😌/gu, '') : withoutJoyful
  return cleaned.replace(/[ \t]{2,}/g, ' ').trim()
}

export function countIrodoriEmojis(input: string): number {
  const matches = String(input ?? '').match(EMOJI_TOKEN_PATTERN)
  return matches ? matches.length : 0
}

/**
 * 裁剪文本中的不安全 ASMR 表情，并将单句内联表情数控制在上限（默认 2 个）以内。
 */
export function enforceIrodoriEmojiBudget(input: string, maxEmojis = MAX_EMOJIS_PER_LINE): string {
  let cleaned = String(input ?? '').replace(UNSAFE_EMOJI_PATTERN, '')
  let kept = 0
  cleaned = cleaned.replace(EMOJI_TOKEN_PATTERN, (token) => {
    if (kept < maxEmojis) {
      kept += 1
      return token
    }
    return ''
  })
  return cleaned.replace(/[ \t]{2,}/g, ' ').trim()
}

function pickNonVerbalCue(
  rawText: string,
  caption: string,
  emotion: string
): { cue: string; fallbackCaption: string } {
  const combined = `${emotion} ${caption}`
  if (/伤心|悲|泣|嗚咽|涙|震え|苦し|悔し|つら/.test(combined)) {
    return {
      cue: '😭',
      fallbackCaption: '声を詰まらせながら、小さく嗚咽をもらす。'
    }
  }
  if (/息切れ|荒い息|走|呼吸|切迫|焦|慌/.test(combined)) {
    return {
      cue: '🌬️',
      fallbackCaption: '息を切らして、短く荒い呼吸をもらす。'
    }
  }
  if (/ため息|溜息|吐息|安堵|疲|ほっと|落ち着/.test(combined)) {
    return {
      cue: '😮‍💨',
      fallbackCaption: '小さく静かな吐息をもらす。'
    }
  }
  if (/惊讶|驚|ショック|怯|緊張|急/.test(combined) || /[!！?？っッ]/.test(rawText)) {
    return {
      cue: '😮',
      fallbackCaption: '思わず短く息をのむ。'
    }
  }
  return {
    cue: '😮‍💨',
    fallbackCaption: '小さく息をもらす。'
  }
}

/**
 * 规范化发往 IrodoriTTS 的单句文本：
 * 1. 剥离不安全的 ASMR/失真表情（🥵/👅/💋/😴/🥤/🥴/👃 等）；
 * 2. 限制单句表情数量 <= 2；
 * 3. 拦截裸标点与孤立促音（如 `……っ`、`……！`、`…………っ！！`、`……`），
 *    避免 IrodoriTTS 产生幻觉词或 0ms 静音，改为安全副语言提示或显式 skip。
 */
export function normalizeIrodoriSpeechText(
  input: string,
  caption?: string,
  emotion?: string
): NormalizedIrodoriSpeech {
  const sanitizedCaption = sanitizeIrodoriCaption(caption ?? '', emotion)
  const emotionLabel = text(emotion)
  const emotionFiltered =
    emotionLabel === '伤心' || emotionLabel === '生气'
      ? stripJoyfulIrodoriEmojis(input, true)
      : input
  const cleaned = enforceIrodoriEmojiBudget(emotionFiltered, MAX_EMOJIS_PER_LINE)
  if (!cleaned) {
    return {
      text: '',
      caption: sanitizedCaption || undefined,
      skip: true
    }
  }

  // 若文本已包含安全副语言表情且去掉表情后只有标点，直接保留该副语言表情
  const tokens = cleaned.match(EMOJI_TOKEN_PATTERN) ?? []
  const textWithoutEmojis = cleaned.replace(EMOJI_TOKEN_PATTERN, '').trim()
  if (
    tokens.length > 0 &&
    (!textWithoutEmojis || BARE_NON_VERBAL_PATTERN.test(textWithoutEmojis))
  ) {
    const safeTokens = tokens.filter((t) => SAFE_EMOJI_SET.has(t))
    if (safeTokens.length > 0) {
      return {
        text: safeTokens.slice(0, MAX_EMOJIS_PER_LINE).join(''),
        caption: sanitizedCaption || undefined,
        skip: false
      }
    }
  }

  // 裸标点 / 孤立促音护栏
  if (BARE_NON_VERBAL_PATTERN.test(cleaned)) {
    const hasExpressiveMark = /[!！?？っッ]/.test(cleaned)
    const hasEmotionalContext =
      Boolean(sanitizedCaption) || (Boolean(text(emotion)) && text(emotion) !== '平静')
    if (!hasExpressiveMark && !hasEmotionalContext) {
      return {
        text: '',
        caption: sanitizedCaption || undefined,
        skip: true
      }
    }
    const { cue, fallbackCaption } = pickNonVerbalCue(cleaned, sanitizedCaption, text(emotion))
    return {
      text: cue,
      caption: sanitizedCaption || fallbackCaption,
      skip: false
    }
  }

  return {
    text: cleaned,
    caption: sanitizedCaption || undefined,
    skip: false
  }
}

/**
 * 解析当前句子的 Irodori 声线参数（双层情绪控制：常规音色锁 + 特殊场景解锁）。
 *
 * - `timbreLockMode !== 'off'` 且 `!lineOverride?.ttsSpecialScene`：
 *   锁定角色基础 `refAudioPath`/`refAudioPaths`/`loraAdapter`（不切情绪参考音频），
 *   用逐句 `ttsCaption`（回退情绪静态 `caption` / 角色默认）承载细腻表演，语速钳制在 `[0.92, 1.08]`。
 * - `ttsSpecialScene === true` 或 `timbreLockMode === 'off'`：
 *   允许情绪条目覆盖 `refAudioPath`/`refAudioPaths`/`loraAdapter`；
 *   特殊场景语速钳制在 `[0.85, 1.18]`，`timbreLockMode === 'off'` 不额外钳制语速。
 */
export function resolveIrodoriVoice(
  base: IrodoriVoiceConfig,
  emotions: IrodoriEmotionConfig[] | undefined,
  emotion: string | undefined,
  options?: ResolveIrodoriVoiceOptions
): IrodoriVoiceConfig {
  const timbreLockMode: IrodoriTimbreLockMode = options?.timbreLockMode ?? 'normal'
  const lineOverride = options?.lineOverride
  const isSpecialScene = Boolean(lineOverride?.ttsSpecialScene)
  const unlockEmotionRef = timbreLockMode === 'off' || isSpecialScene

  const label = text(emotion)
  const hit = label ? emotions?.find((entry) => entry.emotion === label) : undefined

  const merged: IrodoriVoiceConfig = { ...base }

  if (hit) {
    if (unlockEmotionRef) {
      if (text(hit.refAudioPath)) merged.refAudioPath = hit.refAudioPath
      const hitRefs = refsOf(hit)
      if (hitRefs.length > 0) {
        merged.refAudioPaths = hitRefs
      } else if (text(hit.refAudioPath)) {
        merged.refAudioPaths = undefined
      }
      if (text(hit.loraAdapter)) merged.loraAdapter = hit.loraAdapter
    }
    if (text(hit.caption)) merged.caption = hit.caption
    if (typeof hit.speed === 'number' && Number.isFinite(hit.speed)) merged.speed = hit.speed
    if (typeof hit.numSteps === 'number' && hit.numSteps > 0) merged.numSteps = hit.numSteps
  }

  // 逐句 caption 覆盖（清洗身份冲突词与伤心句中的积极笑颜词根）
  const lineCaption = sanitizeIrodoriCaption(lineOverride?.ttsCaption ?? '', label)
  if (lineCaption) {
    merged.caption = lineCaption
  } else if (merged.caption !== undefined) {
    merged.caption = sanitizeIrodoriCaption(merged.caption, label)
  }

  // 逐句语速覆盖 + 音色锁钳制
  if (typeof lineOverride?.ttsSpeed === 'number' && Number.isFinite(lineOverride.ttsSpeed)) {
    merged.speed = lineOverride.ttsSpeed
  }
  if (
    typeof merged.speed === 'number' &&
    Number.isFinite(merged.speed) &&
    timbreLockMode !== 'off'
  ) {
    merged.speed = isSpecialScene
      ? clamp(merged.speed, SPECIAL_SPEED_MIN, SPECIAL_SPEED_MAX)
      : clamp(merged.speed, NORMAL_SPEED_MIN, NORMAL_SPEED_MAX)
  }

  return merged
}

/**
 * 构造 OpenAI 兼容的 Irodori 语音请求体。
 *
 * - `ref_wav` 与 `ref_wavs` 互斥，多参考优先；
 * - 空字符串、`seed < 0`、`num_steps <= 0` 一律省略，让服务端使用自己的默认值；
 * - 自动清洗 `caption`（剥离年龄/性别/基础音色词）与规范化 `input`（非语言护栏 + 表情预算）；
 * - 透传 `speaker_kv_scale` / `speaker_kv_min_t` / `speaker_kv_max_layers`；
 * - 特殊场景（`ttsSpecialScene: true`）提升 `cfg_scale_caption` 并保持 `cfg_scale_speaker >= 4.5`。
 */
export function buildIrodoriSpeechRequest(
  input: string,
  voice: IrodoriVoiceConfig,
  defaults: IrodoriDefaults,
  speedOverride?: number,
  lineOverride?: IrodoriLineOverride
): Record<string, unknown> {
  const isSpecialScene = Boolean(lineOverride?.ttsSpecialScene)
  const overrideEmotion = lineOverride?.emotion
  const cleanedLineCaption = lineOverride?.ttsCaption?.trim()
    ? sanitizeIrodoriCaption(lineOverride.ttsCaption, overrideEmotion)
    : ''
  const rawCaption = cleanedLineCaption || voice.caption
  const normalized = normalizeIrodoriSpeechText(input, rawCaption, overrideEmotion)
  const finalInput = normalized.skip ? '' : normalized.text
  const finalCaption =
    normalized.caption ?? sanitizeIrodoriCaption(rawCaption ?? '', overrideEmotion)

  const payload: Record<string, unknown> = {
    model: text(defaults.model) || 'irodori-tts',
    input: finalInput,
    response_format: defaults.responseFormat || 'wav'
  }

  const rawSpeed = lineOverride?.ttsSpeed ?? voice.speed ?? speedOverride ?? 1.0
  if (typeof rawSpeed === 'number' && Number.isFinite(rawSpeed)) {
    const shouldClamp =
      defaults.timbreLockMode === 'normal' ||
      (defaults.timbreLockMode !== 'off' && lineOverride !== undefined)
    payload.speed = shouldClamp
      ? isSpecialScene
        ? clamp(rawSpeed, SPECIAL_SPEED_MIN, SPECIAL_SPEED_MAX)
        : clamp(rawSpeed, NORMAL_SPEED_MIN, NORMAL_SPEED_MAX)
      : rawSpeed
  }

  const irodori: Record<string, unknown> = {}
  const refs = refsOf(voice)
  if (refs.length > 0) {
    irodori.ref_wavs = refs
  } else if (text(voice.refAudioPath)) {
    irodori.ref_wav = text(voice.refAudioPath)
  }
  if (text(voice.loraAdapter)) irodori.lora_adapter = text(voice.loraAdapter)
  if (finalCaption) irodori.caption = finalCaption

  const numSteps = voice.numSteps ?? defaults.numSteps
  if (Number.isFinite(numSteps) && numSteps > 0) irodori.num_steps = numSteps
  if (Number.isFinite(defaults.cfgScaleText)) irodori.cfg_scale_text = defaults.cfgScaleText

  // 特殊场景提升 caption 引导，同时保护 speaker 引导底线 >= 4.5
  let cfgScaleCaption = lineOverride?.cfgScaleCaption ?? defaults.cfgScaleCaption
  if (isSpecialScene && lineOverride?.cfgScaleCaption === undefined) {
    const specialTarget =
      typeof defaults.specialSceneCfgScaleCaption === 'number' &&
      Number.isFinite(defaults.specialSceneCfgScaleCaption) &&
      defaults.specialSceneCfgScaleCaption > 0
        ? defaults.specialSceneCfgScaleCaption
        : DEFAULT_SPECIAL_CAPTION_CFG
    cfgScaleCaption = Number.isFinite(cfgScaleCaption)
      ? Math.max(cfgScaleCaption, specialTarget)
      : specialTarget
  }
  if (Number.isFinite(cfgScaleCaption)) {
    irodori.cfg_scale_caption = cfgScaleCaption
  }

  let cfgScaleSpeaker = defaults.cfgScaleSpeaker
  if (isSpecialScene && Number.isFinite(cfgScaleSpeaker)) {
    cfgScaleSpeaker = Math.max(SPECIAL_SPEAKER_CFG_MIN, cfgScaleSpeaker)
  }
  if (Number.isFinite(cfgScaleSpeaker)) {
    irodori.cfg_scale_speaker = cfgScaleSpeaker
  }

  if (Number.isFinite(defaults.durationScale)) irodori.duration_scale = defaults.durationScale
  irodori.chunking_enabled = defaults.chunkingEnabled
  if (Number.isFinite(defaults.chunkMinChars) && defaults.chunkMinChars > 0) {
    irodori.chunk_min_chars = defaults.chunkMinChars
  }
  if (Number.isInteger(defaults.seed) && defaults.seed >= 0) irodori.seed = defaults.seed

  // 早期去噪步说话人 K/V 缩放（锁定音色底色）
  if (
    typeof defaults.speakerKvScale === 'number' &&
    Number.isFinite(defaults.speakerKvScale) &&
    defaults.speakerKvScale > 0
  ) {
    irodori.speaker_kv_scale = defaults.speakerKvScale
  }
  if (
    typeof defaults.speakerKvMinT === 'number' &&
    Number.isFinite(defaults.speakerKvMinT) &&
    defaults.speakerKvMinT >= 0 &&
    defaults.speakerKvMinT <= 1
  ) {
    irodori.speaker_kv_min_t = defaults.speakerKvMinT
  }
  if (
    typeof defaults.speakerKvMaxLayers === 'number' &&
    Number.isInteger(defaults.speakerKvMaxLayers) &&
    defaults.speakerKvMaxLayers > 0
  ) {
    irodori.speaker_kv_max_layers = defaults.speakerKvMaxLayers
  }

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
