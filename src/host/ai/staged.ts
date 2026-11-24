import type { CatalogModel } from '../resources/resourceCatalog'
import { selectUnitFewShotExcerpts } from './corpusExamples'
import {
  GENERIC_PROFILE,
  dialoguePersonaPrompt,
  normalizePjskTerminology,
  personaFor,
  type PersonaEntry
} from './personas'
import {
  formatBgmPromptLine,
  formatImagePromptLine,
  isBackViewModel,
  isStandingMotion,
  type CatalogView
} from './prompt'
import {
  CURATED_SCENARIO_EFFECTS,
  isVirtualSingerModel,
  normalizeScenarioEffectName,
  resolveScenarioSe
} from './scenarioCues'
import { hasTranslationContent } from './ttsText'
import { sanitizeIrodoriCaption } from '../../common/tts/irodori'
import type { RagRetrieveResult } from '../rag/types'
import type { DialogueLintIssue } from './dialogueLinter'

/**
 * 五阶段 Project SEKAI 导演流水线：
 *
 * 1. planEpisode (`cast`)：选角（2~5人；团体/活动向选3~5人）+ 规划 2~3 幕节奏表（转场/Telop/PlaceInfo/BGM 留白）；
 * 2. writeDialogue (`dialogue`)：只带入选角色人设 + 官方团体 few-shot，逐字定稿对白与句间停顿；
 * 2.5 emotion + directStaging + translateDialogue（三路并行）：
 *     - emotion：5~10 句稳态 Irodori 配音情绪分段；
 *     - directStaging：幕次阻塞走位（双人全片同场 / 多人 Normal<=2 交叠淡出淡入轮换）、Move、SE、镜头与转场；
 *     - translateDialogue：日文 ttsText 批量翻译；
 * 3. directActing (`direction`)：带完整情绪标签与分幕上下文设计动作/表情/2拍 Talk.actions/静默反应；
 * 4. composeStory + validateAndFixStory + OfficialLinter：编译官方时间线并校验硬指标。
 */

export type LlmPipeline = 'single' | 'staged'

export type StagedTransitionKind =
  | 'black'
  | 'sideFade'
  | 'flashback'
  | 'sekaiIn'
  | 'sekaiOut'
  | 'white'

export interface StagedScenePlan {
  id: string
  summary: string
  background: string
  ambient: 'normal' | 'evening' | 'night'
  telop?: string
  placeInfo?: string
  transitionIn: StagedTransitionKind
  isFlashback?: boolean
  isSekai?: boolean
  activeCast: string[]
  bgm?: string
  scenarioEffect?: string
}

export interface StagedCastMember {
  modelId: number
  /** 说话人绑定用的短名 */
  name: string
  fullName: string
  path: string
  /** 本场功能：发起、回应、吐槽、收尾…… */
  role: string
  isVirtualSinger?: boolean
}

export interface StagedCharacterGoal {
  /** 角色短名（与 cast.name 对应；模型省略时为空） */
  cast: string
  /** 这个角色表面想得到/想确认的东西 */
  wants: string
  /** 这个角色真正隐瞒、没说出口的顾虑 */
  hides: string
}

export interface StagedPromptUnderstanding {
  explicitRequests: string[]
  implicitSubtext: string
  relationshipDynamic: string
  emotionalArc: string
  /** 中段情绪温度发生转折的那一拍及其动因（可选，向后兼容） */
  turningPoint?: string
  /** 开场 1~4 句引入的具体日常意象/物件（可选，向后兼容） */
  openingMotif?: string
  /** 结尾 2~3 句轻描淡写回扣开场意象的方式（可选，向后兼容） */
  closingCallback?: string
  /** 各角色表面目的与内心隐瞒，用来驱动潜台词（可选，向后兼容） */
  characterGoals?: StagedCharacterGoal[]
  canonHooks: string[]
  avoidList: string[]
}

export interface StagedPairwiseAddress {
  from: string
  to: string
  zh: string
  ja?: string
}

export interface StagedRetrievalQueries {
  plot?: string
  voice?: string
  worldview?: string
}

export interface StagedCastPlan {
  title: string
  event: string
  logline: string
  outline: string[]
  cast: StagedCastMember[]
  background: string
  scenes?: StagedScenePlan[]
  /** 深度提示词理解（可选，向后兼容） */
  understanding?: StagedPromptUnderstanding
  /** 角色两两之间的官方称呼与敬语（可选，向后兼容） */
  pairwiseAddress?: StagedPairwiseAddress[]
  /** Stage 1 选角后产出的多面 RAG 检索查询（可选，向后兼容） */
  retrievalQueries?: StagedRetrievalQueries
}

export interface StagedDialogueLine {
  id: string
  speaker: string
  content: string
  /** TTS 情绪标签；未配置情绪时为空 */
  emotion?: string
  /** IrodoriTTS 逐句日语表演/韵律描述（仅描述语气/呼吸/停顿/节奏，不含年龄性别底色词） */
  ttsCaption?: string
  /** IrodoriTTS 逐句语速微调（常规 0.92~1.08，特殊高潮 0.85~1.18） */
  ttsSpeed?: number
  /** 是否为特殊戏剧高潮/崩溃/耳语场景（整场 <= 15%，仅 true 时解锁 emotion 参考音频） */
  ttsSpecialScene?: boolean
  /** 日文配音文本；翻译段在语音导演后与动作导演并行填写，合成时写入 Talk */
  ttsText?: string
  /** 所属幕次 ID（s1 / s2 / s3） */
  sceneId?: string
  /** 句前刻意停顿秒数（0 | 0.5 | 1.0 | 1.5） */
  pauseBefore?: number
  /** 本句播完后收起对话框 */
  closeWindowAfter?: boolean
}

export interface StagedDialogue {
  title: string
  lines: StagedDialogueLine[]
}

export interface StagedListenerAction {
  modelId: number
  motion?: string
  facial?: string
}

export interface StagedDirectionBeat {
  at: number
  motion?: string
  facial?: string
}

export interface StagedDirectionLine {
  id: string
  motion?: string
  facial?: string
  beats?: StagedDirectionBeat[]
  listener?: StagedListenerAction
  silentMotion?: boolean
}

export interface StagedDirection {
  background: string
  /** 可选第二张背景：情绪/时间明显变化时切一次 */
  background2?: string
  /** 第二张背景从哪一句开始（台词数组下标） */
  background2From?: number
  /** 整场环境色：normal | evening | night */
  ambient: 'normal' | 'evening' | 'night'
  /** 整场 BGM（bgm.yaml 登记的文件名）；空字符串表示沿用全局默认 */
  bgm: string
  /** 可选第二首 BGM：情绪明显转折时换一次 */
  bgm2?: string
  /** 第二首 BGM 从哪一句开始（台词数组下标） */
  bgm2From?: number
  /** 结尾退场时淡出停止 BGM */
  bgmStop: boolean
  lines: StagedDirectionLine[]
}

export interface StagedStagingScene {
  id: string
  fromLineId: string
  fromIndex: number
  background: string
  ambient: 'normal' | 'evening' | 'night'
  telop?: string
  placeInfo?: string
  transitionIn: StagedTransitionKind
  isFlashback?: boolean
  isSekai?: boolean
  activeCast: number[]
  hologramCast?: number[]
  walkInCast?: number[]
  walkOutCast?: number[]
  bgm?: string
  scenarioEffect?: string
}

export interface StagedMoveCue {
  modelId: number
  kind: 'stepCloser' | 'stepBack' | 'shiftSlot'
  toSide?: 'Left' | 'Center' | 'Right'
  offset?: number
  moveSpeed?: 'Fast' | 'Normal' | 'Slow'
  motion?: string
  facial?: string
}

export interface StagedCameraCue {
  kind: 'zoomIn' | 'zoomReset' | 'pan' | 'shakeWindow' | 'shakeScreen'
  x?: number
  y?: number
  scale?: number
  durationMs?: number
}

export interface StagedSeCue {
  file: string
  volume?: number
  timing?: 'before' | 'during'
  delay?: number
}

export interface StagedStagingEvent {
  lineId: string
  lineIndex: number
  pauseBefore?: number
  closeWindowAfter?: boolean
  silentReaction?: {
    modelId: number
    motion?: string
    facial?: string
  }
  move?: StagedMoveCue
  characterShake?: { modelId: number; axis: 'X' | 'Y' }
  hologram?: { modelId: number; enabled: boolean }
  camera?: StagedCameraCue
  se?: StagedSeCue
  bgmCut?: { action: 'stop' | 'play'; file?: string; fadeMs?: number }
  stageGroup?: {
    activeCast: number[]
    walkIn?: number[]
    walkOut?: number[]
  }
}

export interface StagedStaging {
  scenes: StagedStagingScene[]
  events: StagedStagingEvent[]
}

export interface StagedPromptOptions {
  scene: string
  personas: PersonaEntry[]
  targetMinutes: number
  systemPrompt?: string
  title?: string
  /** TTS 支持的情绪标签；非空时台词稿要求每句带 emotion */
  emotionLabels?: string[]
  /** 自适应 RAG 检索结果（Pass A / Pass B），缺省或无命中时为空 */
  ragContext?: RagRetrieveResult | null
}

export interface StagedMessages {
  system: string
  user: string
}

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback

const num = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

const oneLine = (value: unknown, limit: number): string =>
  normalizePjskTerminology(str(value).replace(/\s+/g, ' ').trim()).slice(0, limit)

const displayWidth = (text: string): number =>
  Array.from(text).reduce((sum, char) => sum + (char.codePointAt(0)! >= 0x2e80 ? 1 : 0.5), 0)

const cleanText = (value: unknown): string => {
  const text = normalizePjskTerminology(
    str(value)
      .replace(/\r\n?/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
  if (!text) return ''
  // 保留标点/空白后的自然断句换行；仅将词中间的硬断行并回。
  const parts = text.split('\n')
  let merged = parts[0] ?? ''
  for (let index = 1; index < parts.length; index++) {
    const previous = merged.slice(-1)
    merged += /[。！？!?…—、，,.\s”’」』）)]/.test(previous) ? `\n${parts[index]}` : parts[index]
  }
  return merged.trim()
}

function pickFollowupMotion(
  view: CatalogView,
  modelId: number,
  currentMotion?: string,
  recentlyUsed?: ReadonlySet<string>
): string {
  const model = view.modelById(modelId)
  if (!model) return ''
  const curated = view.promptMotions(model)
  const nonStanding = curated.filter((name) => !isStandingMotion(name))
  const calmRe = /nod|tilthead|relief|think|lookaway|forward|shy|sigh|greeting/i
  const isFresh = (name: string): boolean => name !== currentMotion && !recentlyUsed?.has(name)
  return (
    nonStanding.find((name) => isFresh(name) && calmRe.test(name)) ??
    nonStanding.find((name) => isFresh(name)) ??
    nonStanding.find((name) => name !== currentMotion && calmRe.test(name)) ??
    nonStanding.find((name) => name !== currentMotion) ??
    ''
  )
}

function pickAppearFallbackMotion(
  view: CatalogView,
  modelId: number,
  usedInEntry?: ReadonlySet<string>,
  avoidMotion?: string
): string {
  const model = view.modelById(modelId)
  if (!model) return view.exampleMotion(modelId) || view.defaultMotion(modelId)
  const curated = view.promptMotions(model)
  const nonStanding = curated.filter((name) => !isStandingMotion(name))
  const entryRe = /tilthead|lookaway|greeting|nod|forward|relief|think|shy/i
  const distinctAndAvoided = (name: string): boolean =>
    !usedInEntry?.has(name) && name !== avoidMotion
  const pick =
    nonStanding.find((name) => distinctAndAvoided(name) && entryRe.test(name)) ??
    nonStanding.find((name) => distinctAndAvoided(name)) ??
    nonStanding.find((name) => name !== avoidMotion && entryRe.test(name)) ??
    nonStanding.find((name) => name !== avoidMotion) ??
    nonStanding[0]
  return pick || view.exampleMotion(modelId) || view.defaultMotion(modelId)
}

function pickMoveMotion(
  view: CatalogView,
  modelId: number,
  avoidMotion?: string,
  recentlyUsed?: ReadonlySet<string>
): string {
  const model = view.modelById(modelId)
  if (!model) return view.exampleMotion(modelId) || view.defaultMotion(modelId)
  const curated = view.promptMotions(model)
  const nonStanding = curated.filter((name) => !isStandingMotion(name))
  const moveRe = /forward|nod|tilthead|relief|lookaway|greeting|think|shy/i
  return (
    nonStanding.find(
      (name) => name !== avoidMotion && !recentlyUsed?.has(name) && moveRe.test(name)
    ) ??
    nonStanding.find((name) => name !== avoidMotion && !recentlyUsed?.has(name)) ??
    nonStanding.find((name) => name !== avoidMotion) ??
    nonStanding[0] ??
    view.exampleMotion(modelId) ??
    view.defaultMotion(modelId) ??
    ''
  )
}

function pickMoveFacial(view: CatalogView, modelId: number, fallbackFacial?: string): string {
  if (fallbackFacial) return fallbackFacial
  return view.exampleFacial(modelId) || view.defaultFacial(modelId) || ''
}

const FACIAL_EXTREME_EXCLUDE_RE =
  /angry|disgust|scared|cry|shock|dark|despair|fever|sneeze|disgorge/i
const FACIAL_SMILE_EXCLUDE_RE =
  /smile|smug|wink|sparkling|angry|disgust|scared|cry|shock|dark|despair|fever|sneeze|disgorge/i
const TENSE_EMOTION_SET = new Set(['生气', '伤心', '害怕'])
const SILENT_LINE_RE = /^[（(]?[\s.…,，。！？!?—\-~～]+[）)]?$/
const SMILE_FACIAL_RE = /smile|smug|wink|sparkling/i
const EXPLICIT_JOY_CUE_RE = /♪|～♪|哈哈|嘿嘿|太好了|开心/

export interface SubtleFacialContext {
  precededByTense?: boolean
}

const isSilentBeatLine = (text: string): boolean => SILENT_LINE_RE.test((text ?? '').trim())

const shouldAvoidIncongruousSmile = (
  facial: string | undefined,
  line: { content: string; emotion?: string },
  precededByTense: boolean
): boolean =>
  Boolean(facial && SMILE_FACIAL_RE.test(facial)) &&
  line.emotion !== '开心' &&
  (isSilentBeatLine(line.content) ||
    (precededByTense &&
      (!line.emotion || line.emotion === '平静') &&
      !EXPLICIT_JOY_CUE_RE.test(line.content)))

function isPrecededByTenseBeat(
  lines: ReadonlyArray<{ content: string; emotion?: string; sceneId?: string }>,
  index: number,
  lookback = 3
): boolean {
  const currentSceneId = lines[index]?.sceneId
  const start = Math.max(0, index - lookback)
  for (let j = index - 1; j >= start; j--) {
    const prev = lines[j]
    if (!prev) continue
    if (currentSceneId && prev.sceneId && prev.sceneId !== currentSceneId) break
    if (TENSE_EMOTION_SET.has(prev.emotion ?? '')) return true
    if (
      j === index - 1 &&
      /别再|不要再|少啰嗦|骗人|为什么|搞什么|闭嘴|抱歉|对不起|糟糕|逃走|硬撑/.test(
        prev.content ?? ''
      )
    ) {
      return true
    }
  }
  return false
}

const isRestrainedRole = (roleOrName = ''): boolean => /真冬|克制|冷静|寡言|内敛/.test(roleOrName)

function pickFacialFromHints(
  facials: string[],
  hints: RegExp[],
  currentFacial?: string,
  excludeRe?: RegExp
): string {
  const pool = excludeRe ? facials.filter((name) => !excludeRe.test(name)) : facials
  const effectivePool = pool.length > 0 ? pool : facials
  for (const hint of hints) {
    const fresh = effectivePool.find((name) => name !== currentFacial && hint.test(name))
    if (fresh) return fresh
  }
  return effectivePool.find((name) => name !== currentFacial) ?? effectivePool[0] ?? ''
}

/** 为说话者挑选贴合当前台词语气与情绪的细腻表情（避免反复卡在 face_normal_01，也避免在沉默/紧张拍误笑）。 */
function pickSpeakerSubtleFacial(
  view: CatalogView,
  modelId: number,
  line: { content: string; emotion?: string },
  currentFacial?: string,
  role = '',
  context: SubtleFacialContext = {}
): string {
  const model = view.modelById(modelId)
  if (!model) return ''
  const facials = view.promptFacials(model)
  const emotion = line.emotion ?? ''
  const text = line.content ?? ''
  const restrained = isRestrainedRole(role) || isRestrainedRole(model.name)
  const precededByTense = Boolean(context.precededByTense)

  if (emotion === '开心') {
    return pickFacialFromHints(
      facials,
      restrained
        ? [/smallmouth|closeeye|smile/i, /normal/i]
        : [/smile|sparkling|wink|smug/i, /closeeye|normal/i],
      currentFacial,
      /angry|sad|cry|disgust|scared/i
    )
  }
  if (emotion === '伤心') {
    return pickFacialFromHints(
      facials,
      [/sad|worry|cry|closeeye/i, /trouble|lookaway|smallmouth/i],
      currentFacial,
      /smile|smug|wink|sparkling|angry/i
    )
  }
  if (emotion === '生气') {
    return pickFacialFromHints(
      facials,
      [/angry|serious|disgust/i, /sharp|trouble|smallmouth/i],
      currentFacial,
      /smile|smug|wink|sparkling/i
    )
  }
  if (emotion === '害怕') {
    return pickFacialFromHints(
      facials,
      [/scared|worry|trouble|surprise|shock/i, /sad|lookaway|serious/i],
      currentFacial,
      /smile|smug|wink|sparkling|angry/i
    )
  }
  if (emotion === '惊讶') {
    return pickFacialFromHints(
      facials,
      [/surprise|shock|notice/i, /baffling|serious/i],
      currentFacial,
      /smile|sleepy/i
    )
  }
  if (emotion === '害羞') {
    return pickFacialFromHints(
      facials,
      [/shy|blush|trouble|lookaway/i, /smallmouth|smile/i],
      currentFacial,
      /angry|disgust|scared/i
    )
  }

  // 沉默停顿句（如「…………」「（……）」）：绝不配微笑
  if (isSilentBeatLine(text)) {
    return pickFacialFromHints(
      facials,
      precededByTense
        ? [/trouble|worry|closeeye|lookaway/i, /serious|smallmouth|sad|normal/i]
        : [/closeeye|serious|smallmouth|lookaway/i, /trouble|notice|normal/i],
      currentFacial,
      FACIAL_SMILE_EXCLUDE_RE
    )
  }

  // 平静/无标签对话：按台词具体语气细分微表情，不再全锁成 face_normal_01
  const explicitJoyRe = /♪|～♪|哈哈|嘿嘿|太好了|开心/
  const mildJoyRe = /♪|～|哈哈|嘿嘿|太好了|开心|喜欢|谢|早安|晚安|不错嘛/
  if (precededByTense ? explicitJoyRe.test(text) : mildJoyRe.test(text)) {
    return pickFacialFromHints(
      facials,
      restrained
        ? [/smallmouth|closeeye|smile/i, /serious|normal/i]
        : [/smile|wink|smug|sparkling/i, /closeeye|smallmouth/i],
      currentFacial,
      FACIAL_EXTREME_EXCLUDE_RE
    )
  }
  if (/对不起|抱歉|糟|烦|无奈|叹|算了|没办法|真是的|别这样/.test(text)) {
    return pickFacialFromHints(
      facials,
      [/trouble|worry|lookaway|closeeye/i, /sad|smallmouth|serious/i],
      currentFacial,
      /smile|sparkling|smug|angry/i
    )
  }
  if (/？|\?|什么|怎么|难道|为什么|真的吗|咦/.test(text)) {
    return pickFacialFromHints(
      facials,
      precededByTense
        ? [/notice|baffling|serious|trouble/i, /smallmouth|lookaway|worry/i]
        : [/notice|baffling|serious|trouble/i, /smallmouth|lookaway|smile/i],
      currentFacial,
      precededByTense ? FACIAL_SMILE_EXCLUDE_RE : FACIAL_EXTREME_EXCLUDE_RE
    )
  }
  if (/决定|一定|必须|其实|认真|听我说|总之/.test(text)) {
    return pickFacialFromHints(
      facials,
      precededByTense
        ? [/serious|closeeye|smallmouth/i, /notice|trouble|normal/i]
        : [/serious|closeeye|smallmouth/i, /notice|smile|normal/i],
      currentFacial,
      precededByTense ? FACIAL_SMILE_EXCLUDE_RE : FACIAL_EXTREME_EXCLUDE_RE
    )
  }
  if (precededByTense) {
    return pickFacialFromHints(
      facials,
      [/serious|closeeye|smallmouth|trouble/i, /lookaway|worry|normal/i],
      currentFacial,
      FACIAL_SMILE_EXCLUDE_RE
    )
  }
  return pickFacialFromHints(
    facials,
    restrained
      ? [/smallmouth|closeeye|serious/i, /normal|trouble/i]
      : [/smallmouth|closeeye|serious|lookaway/i, /notice|trouble|smile|normal/i],
    currentFacial,
    FACIAL_EXTREME_EXCLUDE_RE
  )
}

/**
 * 为在场听者 / 静默反应角色推导符合「倾听者视角」的表情：
 * 绝不把说话者的「生气」「害怕」「害羞」机械复制到被责备或被倾诉的听者脸上。
 */
function pickListenerReactionFacial(
  view: CatalogView,
  listenerId: number,
  speakerLine: { content: string; emotion?: string },
  listenerRole = '',
  currentFacial?: string,
  context: SubtleFacialContext = {}
): string {
  const model = view.modelById(listenerId)
  if (!model) return ''
  const facials = view.promptFacials(model)
  const speakerEmotion = speakerLine.emotion ?? ''
  const text = speakerLine.content ?? ''
  const restrained = isRestrainedRole(listenerRole) || isRestrainedRole(model.name)
  const precededByTense = Boolean(context.precededByTense)

  const isScoldingOrConfronting =
    speakerEmotion === '生气' ||
    /别再|不要再|少啰嗦|笨蛋|推开|擅自|搞什么|为什么|吵|责怪|闭嘴/.test(text)
  if (isScoldingOrConfronting) {
    return pickFacialFromHints(
      facials,
      [/trouble|worry|sad|lookaway/i, /closeeye|serious|smallmouth/i],
      currentFacial,
      /angry|disgust|scared|smile|smug|wink|sparkling/i
    )
  }
  if (speakerEmotion === '伤心') {
    return pickFacialFromHints(
      facials,
      [/worry|sad|trouble|closeeye/i, /serious|smallmouth/i],
      currentFacial,
      /smile|smug|wink|sparkling|angry|disgust/i
    )
  }
  if (speakerEmotion === '害怕') {
    return pickFacialFromHints(
      facials,
      [/worry|serious|trouble|surprise/i, /sad|closeeye|smallmouth/i],
      currentFacial,
      /smile|smug|wink|sparkling|angry/i
    )
  }
  if (speakerEmotion === '惊讶') {
    return pickFacialFromHints(
      facials,
      [/surprise|notice|baffling/i, /serious|smallmouth|trouble/i],
      currentFacial,
      /angry|disgust|cry/i
    )
  }
  if (speakerEmotion === '害羞') {
    return pickFacialFromHints(
      facials,
      restrained
        ? [/smallmouth|serious|closeeye/i, /normal/i]
        : [/smile|wink|smug|notice/i, /serious|normal/i],
      currentFacial,
      FACIAL_EXTREME_EXCLUDE_RE
    )
  }
  if (speakerEmotion === '开心') {
    return pickFacialFromHints(
      facials,
      restrained
        ? [/smallmouth|closeeye|serious/i, /normal/i]
        : [/smile|sparkling|wink/i, /closeeye|normal/i],
      currentFacial,
      FACIAL_EXTREME_EXCLUDE_RE
    )
  }

  // 说话者平静：根据内容判断倾听者神情（疑惑/担忧 vs 轻松赞同 vs 认真倾听）
  if (/？|\?|……|难道|怎么|是不是|真的/.test(text)) {
    return pickFacialFromHints(
      facials,
      [/serious|notice|trouble|lookaway/i, /smallmouth|closeeye|normal/i],
      currentFacial,
      precededByTense ? FACIAL_SMILE_EXCLUDE_RE : FACIAL_EXTREME_EXCLUDE_RE
    )
  }
  if (precededByTense ? /♪|～♪|太好了/.test(text) : /♪|～|笑|谢谢|太好了|没关系|一起/.test(text)) {
    return pickFacialFromHints(
      facials,
      restrained
        ? [/smallmouth|closeeye|serious/i, /normal/i]
        : [/smile|wink|closeeye/i, /smallmouth|normal/i],
      currentFacial,
      FACIAL_EXTREME_EXCLUDE_RE
    )
  }
  return pickFacialFromHints(
    facials,
    precededByTense
      ? [/serious|smallmouth|closeeye|trouble/i, /lookaway|worry|normal/i]
      : [/serious|smallmouth|closeeye|notice/i, /lookaway|trouble|smile|normal/i],
    currentFacial,
    precededByTense ? FACIAL_SMILE_EXCLUDE_RE : FACIAL_EXTREME_EXCLUDE_RE
  )
}

/** 把模型写出的角色标识（modelId / cloudId / 名称 / 路径 / 服装描述 / 人设别名）收束到目录里的角色。 */
function resolveModel(
  view: CatalogView,
  personas: PersonaEntry[],
  value: unknown
): CatalogModel | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return view.modelById(value)
  }
  const text = str(value).trim()
  if (!text) return null
  if (/^\d+$/.test(text)) return view.modelById(Number(text))

  const lower = text.toLowerCase()
  const exactCloudOrPath = view.models.find((model) => {
    const p = model.path.toLowerCase()
    const base = p.split('/').pop() ?? p
    return (model.cloudId ?? '').toLowerCase() === lower || p === lower || base === lower
  })
  if (exactCloudOrPath) return exactCloudOrPath

  // 按正面模型与默认服装优先匹配角色全名/简称
  const directByName = view.models
    .filter(
      (model) =>
        model.name.toLowerCase() === lower || (model.shortName ?? '').toLowerCase() === lower
    )
    .sort(
      (a, b) =>
        Number(isBackViewModel(a)) - Number(isBackViewModel(b)) ||
        Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)) ||
        a.id - b.id
    )
  if (directByName.length > 0) return directByName[0]

  // 支持「角色名 服装」（如「星乃一歌 校服」「瑞希 私服」）
  for (const primary of view.primaryModels()) {
    const shortName = view.shortName(primary)
    if ((primary.name && text.includes(primary.name)) || (shortName && text.includes(shortName))) {
      const rest = text.replace(primary.name, '').replace(shortName, '').trim()
      if (rest) {
        const outfitHit = view.resolveOutfitVariant(primary, rest)
        if (outfitHit) return outfitHit
      }
    }
  }

  const aliasHits = view.models
    .filter((model) => {
      const persona = personaFor(personas, model)
      return persona
        ? [persona.name, ...persona.aliases].some((alias) => alias.toLowerCase() === lower)
        : false
    })
    .sort(
      (a, b) =>
        Number(isBackViewModel(a)) - Number(isBackViewModel(b)) ||
        Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)) ||
        a.id - b.id
    )
  if (aliasHits.length > 0) return aliasHits[0]
  return null
}

function resolveFirstModel(
  view: CatalogView,
  personas: PersonaEntry[],
  candidates: unknown[]
): CatalogModel | null {
  for (const candidate of candidates) {
    const model = resolveModel(view, personas, candidate)
    if (model) return model
  }
  return null
}

function entriesOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!isRecord(value)) return []
  return Object.entries(value).map(([id, item]) => {
    if (isRecord(item)) return { ...item, id }
    if (typeof item === 'string') return { id, content: item, motion: item }
    return { id }
  })
}

function unwrapRecord(raw: unknown, keys: string[]): unknown {
  if (!isRecord(raw)) return raw
  for (const key of keys) {
    const value = raw[key]
    if (
      isRecord(value) &&
      (Array.isArray(value.cast) ||
        Array.isArray(value.lines) ||
        Array.isArray(value.beats) ||
        Array.isArray(value.scenes) ||
        Array.isArray(value.events))
    ) {
      return value
    }
  }
  return raw
}

function personaSummary(persona: PersonaEntry | null): string {
  if (!persona) return ''
  const text = persona.prompt.replace(/\s+/g, ' ').trim()
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

function castMemberFor(
  view: CatalogView,
  model: CatalogModel,
  role: unknown = ''
): StagedCastMember {
  return {
    modelId: model.id,
    name: view.shortName(model),
    fullName: model.name || view.shortName(model),
    path: model.path,
    role: activeRole(role),
    isVirtualSinger: isVirtualSingerModel(model)
  }
}

function activeRole(value: unknown): string {
  return oneLine(value, 80)
}

function matchBackground(view: CatalogView, value: unknown): string {
  const text = str(value).trim()
  if (!text) return ''
  return view.canonicalImage(text) ?? ''
}

function normalizeBackground(view: CatalogView, value: unknown): string {
  return matchBackground(view, value) || view.defaultImage()
}

function matchBgm(view: CatalogView, value: unknown): string {
  const text = str(value).trim()
  if (!text) return ''
  if (text.toLowerCase() === 'silence' || text.toLowerCase().startsWith('bgm00000')) {
    return 'silence'
  }
  return view.canonicalBgm(text) ?? ''
}

function normalizeAmbient(value: unknown): 'normal' | 'evening' | 'night' {
  const raw = str(value).trim().toLowerCase()
  return raw === 'evening' ? 'evening' : raw === 'night' ? 'night' : 'normal'
}

function normalizeTransitionKind(value: unknown): StagedTransitionKind {
  const raw = str(value).trim().toLowerCase()
  if (raw.includes('flashback')) return 'flashback'
  if (raw.includes('sekaiout') || raw === 'sekai_out') return 'sekaiOut'
  if (raw.includes('sekaiin') || raw === 'sekai_in' || raw === 'sekai' || raw.includes('世界'))
    return 'sekaiIn'
  if (raw.includes('side') || raw.includes('wipe')) return 'sideFade'
  if (raw.includes('white')) return 'white'
  return 'black'
}

const toBool = (value: unknown): boolean =>
  value === true || value === 1 || value === 'true' || value === 'yes'

function castBlock(plan: StagedCastPlan): string {
  return plan.cast
    .map(
      (member) =>
        `- ${member.name}（say: "${member.name}"，modelId=${member.modelId}${
          member.isVirtualSinger ? '，虚拟歌手' : ''
        }）${member.role ? ` — ${member.role}` : ''}`
    )
    .join('\n')
}

function lineBudget(targetMinutes: number): number {
  return Math.max(12, Math.min(108, Math.round(targetMinutes * 16)))
}

function titleOrDefault(value: unknown, fallback: string): string {
  return oneLine(value, 64) || fallback
}

function isGroupPrompt(scene: string, view: CatalogView): boolean {
  if (view.models.length < 3) return false
  const mentionedCount = view.models.filter(
    (m) =>
      (m.name && scene.includes(m.name)) ||
      (m.shortName && m.shortName.length >= 2 && scene.includes(m.shortName))
  ).length
  if (mentionedCount >= 3) return true
  if (mentionedCount === 2 && !/大家|全员|团体|社团|排练|活动|聚会|live|演唱会|成员/i.test(scene)) {
    return false
  }
  return /大家|全员|团体|社团|排练|活动|聚会|live|演唱会|成员|25时|nightcord|leo\/need|mmj|vbs|ws|wxs|文化祭|sekai/i.test(
    scene
  )
}

// ---------------------------------------------------------------------------
// 第一段：选角与分幕节奏表（planEpisode）
// ---------------------------------------------------------------------------

function compactOutfitOptions(view: CatalogView, model: CatalogModel, scene: string): string {
  const variants = view.outfitsFor(model)
  if (variants.length <= 1) return ''
  // 每个服装大类取代表性变体，优先命中的场景服装关键词放前
  const picked: CatalogModel[] = []
  const seenCats = new Set<string>()
  const sceneMatched = view.resolveOutfitVariant(model, scene)
  if (sceneMatched && sceneMatched.id !== model.id) {
    picked.push(sceneMatched)
    seenCats.add(sceneMatched.outfitCategory ?? '')
  }
  for (const variant of variants) {
    if (picked.length >= 6) break
    const cat = variant.outfitCategory || variant.outfitLabel || String(variant.id)
    if (cat === '特殊' && !/幼年|剪影|童年/.test(scene)) continue
    if (seenCats.has(cat)) continue
    seenCats.add(cat)
    picked.push(variant)
  }
  if (picked.length <= 1) return ''
  return ` [服装: ${picked.map((v) => `${v.outfitCategory || v.outfitLabel || '默认'}=${v.id}`).join(', ')}]`
}

export function buildCastPrompt(view: CatalogView, options: StagedPromptOptions): StagedMessages {
  const budget = lineBudget(options.targetMinutes)
  const primary = view.primaryModels()
  const mainRoster = primary.filter((m) => !m.isSubCharacter)
  const subRosterAll = primary.filter((m) => m.isSubCharacter)
  const subMentioned = subRosterAll.filter(
    (m) =>
      (m.name && options.scene.includes(m.name)) ||
      (m.shortName && m.shortName.length >= 2 && options.scene.includes(m.shortName))
  )
  const subShown = [
    ...subMentioned,
    ...subRosterAll
      .filter((m) => !subMentioned.includes(m))
      .slice(0, Math.max(0, 12 - subMentioned.length))
  ]

  const groupStyle = isGroupPrompt(options.scene, view)
  const models = mainRoster
    .map((model) => {
      const persona = personaFor(options.personas, model)
      const group = model.unit ? `（${model.unit}）` : persona?.group ? `（${persona.group}）` : ''
      const summary = personaSummary(persona)
      const outfits = compactOutfitOptions(view, model, options.scene)
      return `- modelId=${model.id} ${view.shortName(model)}${group}${outfits}${
        summary ? `：${summary}` : ''
      }`
    })
    .join('\n')

  const subModelsBlock =
    subShown.length > 0
      ? `\n\n## 可选配角 / 特别角色（按需选用）\n${subShown
          .map(
            (m) =>
              `- modelId=${m.id} ${view.shortName(m)}${m.outfitLabel ? `（${m.outfitLabel}）` : ''}`
          )
          .join('\n')}`
      : ''

  const backgrounds = view
    .imagePromptChoices(72, options.scene)
    .map((detail) => formatImagePromptLine(detail))
    .join('\n')

  const bgmList = view
    .bgmPromptChoices(32, options.scene)
    .map((detail) => formatBgmPromptLine(detail))
    .join('\n')

  const first = mainRoster[0] ?? view.models[0]
  const second = mainRoster[1] ?? view.models[1]
  const third = mainRoster[2] ?? view.models[2]
  const exampleCast = [
    {
      modelId: first?.id ?? 1,
      name: first ? view.shortName(first) : '角色A',
      role: '发起话题'
    },
    ...(second ? [{ modelId: second.id, name: view.shortName(second), role: '回应与吐槽' }] : []),
    ...(groupStyle && third
      ? [{ modelId: third.id, name: view.shortName(third), role: '中段加入/调和' }]
      : [])
  ]
  const firstBgm = view.bgmPromptChoices(10)[0]?.id ?? view.bgmPromptChoices(10)[0]?.file ?? ''
  const example = {
    title: '短标题',
    logline: '一句话概括这一场',
    event: '一个具体的小事件',
    background: view.defaultImage() || '背景文件名',
    cast: exampleCast,
    scenes: [
      {
        id: 's1',
        summary: '开场铺垫与日常进入',
        background: view.defaultImage() || '背景文件名',
        ambient: 'normal',
        telop: '放学后',
        placeInfo: '放学后的教室',
        transitionIn: 'black',
        activeCast: exampleCast.slice(0, 2).map((c) => c.name),
        bgm: firstBgm || 'keep'
      },
      {
        id: 's2',
        summary: '情绪转折或回忆插叙',
        background: view.defaultImage() || '背景文件名',
        ambient: 'evening',
        transitionIn: 'sideFade',
        activeCast: exampleCast.slice(0, 2).map((c) => c.name),
        bgm: 'silence'
      }
    ],
    outline: ['开场日常……', '小事件出现波澜……', '情绪转折/留白……', '温柔收束……'],
    understanding: {
      explicitRequests: ['用户明确要求的场景/事件/角色'],
      implicitSubtext: '潜台词与角色真正想说却没直接出口的情绪',
      relationshipDynamic: '所选角色之间当下的关系张力与相处模式',
      emotionalArc: '从起手到高潮再到余韵收尾的情绪弧光',
      turningPoint: '中段某一拍情绪温度转向的原因（如看见对方留下的笔记，语气从拘谨转为坦白）',
      openingMotif: '开场 1~4 句里出现的具体日常物件或感官细节',
      closingCallback: '结尾 2~3 句怎样轻描淡写地回扣这个意象，而不是总结道理',
      characterGoals:
        exampleCast.length > 0
          ? [
              {
                cast: exampleCast[0].name,
                wants: '表面上想达成的事',
                hides: '没说出口的担心或私心'
              }
            ]
          : [],
      canonHooks: ['可自然呼应的官方设定、地点或过往事件'],
      avoidList: ['避免 OOC、说教式总结或套路化抒情']
    },
    pairwiseAddress:
      exampleCast.length >= 2
        ? [
            {
              from: exampleCast[0].name,
              to: exampleCast[1].name,
              zh: exampleCast[1].name,
              ja: exampleCast[1].name
            }
          ]
        : [],
    retrievalQueries: {
      plot: '与本场核心事件相关的官方剧情或过往经历',
      voice: `${exampleCast.slice(0, 2).map((c) => c.name).join(' ')} 日常互动对白与称呼`,
      worldview: '相关地点、社团/团体设定或关系背景'
    }
  }

  const preCastRagBlock = formatCanonGroundingBrief({
    ragContext: options.ragContext,
    stage: 'cast',
    maxChars: 1500
  })

  const castRule =
    view.models.length <= 2
      ? '从角色池选 1~2 名角色（默认 2 人；仅明确要求独白时选 1 人）。'
      : groupStyle
        ? '本场偏向团体/活动场景：建议选 **3~5 名角色** 参演，用 scenes 安排每幕 1~2 人在场（官方 Normal 模式每次最多 2 人同台，通过 2 人交叠淡出淡入轮换上场）。'
        : '按场景需要选 **2~5 名角色**（双人对话选 2 人并保持两人全片同场；团体/活动场景选 3~5 人并按幕或对话轮换保持每次最多 2 人在场；仅明确独白选 1 人）。'

  return {
    system: [
      '你是 Project SEKAI 风格视觉小说的编剧兼总导演。',
      '这是五阶段创作的第一轮（Episode Beat Sheet）：选角（2~5人）、设计小事件，并拆成 2~3 幕节奏表（scenes）。',
      '不要写台词正文，不要写动作编号。只输出一个 JSON 对象。'
    ].join('\n'),
    user: `## 任务
${options.scene}

- 语言：中文（台词 content 用中文，日文 ttsText 由宿主另行翻译）
- 目标时长：约 ${options.targetMinutes} 分钟，约 ${budget} 句台词
- 只演完一个核心事件或情绪弧光，禁止塞入多条无关支线${preCastRagBlock}

## 可选角色（modelId — 显示名；若角色有 [服装: 校服=ID...]，按场景时段与场合直接选对应服装 modelId）
${models || '（资源目录为空）'}${subModelsBlock}

## 可选背景（按场景地点、时段[白天/黄昏/夜晚/深夜]与[室内/室外]精准选择）
${backgrounds || '（目录暂未提供背景）'}

## 可选 BGM（按[情绪·节奏]选择；含 silence 静音切停）
${bgmList || '（可使用 keep 或 silence）'}

## 选角与分幕要求
- ${castRule}
- 给每个角色标明本场功能（谁发起、谁回应、谁吐槽、谁压轴）。
- 规划 **2~3 幕（scenes）**：
  - 每幕写明 \`id\`（s1/s2/s3）、\`summary\`、\`background\`（必须来自可用背景清单）、\`ambient\`（normal/evening/night）、\`activeCast\`（1~2 名本幕起手在场角色名，Normal 模式每次最多 2 人）。
  - 合理规划转场与标题条：首幕可用 \`telop\`（时间/气氛短标题，如「放学后」）或 \`placeInfo\`（左上角地点条）；后续幕次可用 \`transitionIn\`：\`sideFade\`（横向遮罩擦除）、\`flashback\`（白光闪入回忆：WhiteOut->FlashbackIn->WhiteIn）、\`sekaiIn\`/\`sekaiOut\`（出入 SEKAI）或 \`black\`。
  - 若场景涉及回忆，标注 \`isFlashback: true\`、\`transitionIn: "flashback"\`；若涉及出入 SEKAI，标注 \`isSekai: true\` 与 \`sekaiIn\`/\`sekaiOut\`。
  - 善用 BGM 弧光：在情绪转折或坦白前一幕可写 \`bgm: "silence"\`（对应官方 \`bgm00000\` 静音停曲留白），之后再接入情绪曲。
- title 是短标题（不超过 12 个字），logline 一句话，outline 4~6 条写“发生什么”。
- **深度意图拆解（understanding）**：提炼显性要求（explicitRequests）、潜台词（implicitSubtext）、角色关系张力（relationshipDynamic）、情绪弧光（emotionalArc）、中段转折点（turningPoint：情绪温度在哪一拍转向及动因）、开场日常意象（openingMotif：前 1~4 句出现的具体物件或感官细节）、收尾回扣（closingCallback：结尾 2~3 句怎样轻巧呼应开场意象，替代说教总结）、各角色表里动机（characterGoals：想得到什么 vs 隐瞒什么）、官方连续性钩子（canonHooks）与禁忌避坑清单（avoidList）。
- **两两称呼表（pairwiseAddress）**：列出入选角色彼此的准确官方中文称呼与日文称呼/敬语（如 zh/ja），供后续对白与日文配音翻译严格遵守。
- **多面检索查询（retrievalQueries）**：给出 2~3 条简短精准的检索短语（plot 剧情事件、voice 角色互动口吻、worldview 地点/设定），用于下一阶段检索官方参考语料。

## 输出 JSON
${JSON.stringify(example, null, 2)}

只输出 JSON 对象本身，不要 markdown 或解释。`
  }
}

export interface QuickCastOptions {
  scene: string
  personas: PersonaEntry[]
  history?: Array<{ role: string; content: string }>
}

/**
 * 快速选角：single/chat 只有一次主生成，先把 26 人缩到合适人数，
 * 避免把 26 份完整人设全部塞进主提示词。
 */
export function buildQuickCastPrompt(view: CatalogView, options: QuickCastOptions): StagedMessages {
  const primary = view.primaryModels()
  const roster = primary
    .filter(
      (m) =>
        !m.isSubCharacter ||
        (m.name && options.scene.includes(m.name)) ||
        (m.shortName && options.scene.includes(m.shortName))
    )
    .map((model) => {
      const persona = personaFor(options.personas, model)
      const summary = personaSummary(persona)
      const outfits = compactOutfitOptions(view, model, options.scene)
      return `- modelId=${model.id} ${view.shortName(model)}${outfits}${summary ? `：${summary}` : ''}`
    })
    .join('\n')
  const history = (options.history ?? [])
    .slice(-4)
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n')
  return {
    system:
      '你是角色选择器。根据用户消息从角色池选最合适的角色（对话选 1~2 个，团体活动选 2~4 个）。只输出 JSON：{"cast":[modelId,...]}。',
    user: `用户说：${options.scene}\n${history ? `最近对话：\n${history}\n` : ''}\n可选角色：\n${roster}\n\n只输出 JSON。`
  }
}

function resolveCastNameList(
  rawList: unknown,
  cast: StagedCastMember[],
  view: CatalogView,
  personas: PersonaEntry[]
): string[] {
  const arr = Array.isArray(rawList) ? rawList : []
  const picked: string[] = []
  for (const item of arr) {
    const byName = cast.find(
      (c) =>
        c.name === str(item).trim() ||
        c.fullName === str(item).trim() ||
        String(c.modelId) === str(item).trim()
    )
    if (byName) {
      if (!picked.includes(byName.name)) picked.push(byName.name)
      continue
    }
    const model = resolveModel(view, personas, item)
    if (model) {
      const member = cast.find((c) => c.modelId === model.id)
      if (member && !picked.includes(member.name)) picked.push(member.name)
    }
  }
  return picked.slice(0, 3)
}

export function normalizeCastPlan(
  raw: unknown,
  view: CatalogView,
  options: StagedPromptOptions
): StagedCastPlan | null {
  const doc = unwrapRecord(raw, ['plan', 'cast_plan', 'episode', 'story'])
  if (!isRecord(doc)) return null

  const entries = Array.isArray(doc.cast)
    ? doc.cast
    : isRecord(doc.cast)
      ? Object.entries(doc.cast).map(([id, value]) =>
          typeof value === 'string'
            ? { model: value, modelId: id }
            : { ...(isRecord(value) ? value : {}), modelId: id }
        )
      : []

  const cast: StagedCastMember[] = []
  const seen = new Set<number>()
  for (const entry of entries) {
    if (cast.length >= 5) break
    const item = typeof entry === 'string' ? { name: entry } : entry
    if (!isRecord(item)) continue
    let model = resolveFirstModel(view, options.personas, [
      item.model,
      item.modelId,
      item.id,
      item.name,
      item.shortName
    ])
    const outfitHint = str(item.outfit ?? item.costume ?? item.cloth ?? '').trim()
    if (model && outfitHint) {
      model = view.resolveOutfitVariant(model, outfitHint) ?? model
    }
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    cast.push(castMemberFor(view, model, item.role))
  }
  if (cast.length === 0) return null

  const outline = Array.isArray(doc.outline)
    ? doc.outline
        .map((item) => oneLine(item, 200))
        .filter(Boolean)
        .slice(0, 8)
    : []

  const defaultBg = normalizeBackground(view, doc.background ?? doc.image ?? doc.scene)
  const rawScenes = Array.isArray(doc.scenes) ? doc.scenes : []
  const scenes: StagedScenePlan[] = []
  for (const [index, item] of rawScenes.slice(0, 4).entries()) {
    if (!isRecord(item)) continue
    const active = resolveCastNameList(
      item.activeCast ?? item.cast ?? item.speakers,
      cast,
      view,
      options.personas
    ).slice(0, 2)
    const fallbackActive =
      cast.length === 2
        ? cast.map((c) => c.name)
        : cast.slice(0, Math.min(2, cast.length)).map((c) => c.name)
    const isFlashback = toBool(item.isFlashback ?? item.flashback)
    const isSekai = toBool(item.isSekai ?? item.sekai)
    let transitionIn = normalizeTransitionKind(item.transitionIn ?? item.transition)
    if (isFlashback && transitionIn === 'black') transitionIn = 'flashback'
    if (isSekai && transitionIn === 'black') transitionIn = 'sekaiIn'
    const bgmRaw = str(item.bgm).trim()
    const bgm =
      bgmRaw.toLowerCase() === 'keep'
        ? 'keep'
        : bgmRaw.toLowerCase() === 'silence' || bgmRaw.toLowerCase() === 'bgm00000'
          ? 'silence'
          : matchBgm(view, bgmRaw)
    const effect = normalizeScenarioEffectName(item.scenarioEffect ?? item.effect)
    scenes.push({
      id: str(item.id).trim() || `s${index + 1}`,
      summary: oneLine(item.summary ?? item.description, 160) || outline[index] || '',
      background: normalizeBackground(view, item.background ?? item.image ?? defaultBg),
      ambient: normalizeAmbient(item.ambient ?? item.timeOfDay),
      ...(oneLine(item.telop, 40) ? { telop: oneLine(item.telop, 40) } : {}),
      ...(oneLine(item.placeInfo ?? item.place, 40)
        ? { placeInfo: oneLine(item.placeInfo ?? item.place, 40) }
        : {}),
      transitionIn,
      ...(isFlashback ? { isFlashback: true } : {}),
      ...(isSekai ? { isSekai: true } : {}),
      // 双人戏保持两人全片同场
      activeCast:
        cast.length === 2 ? cast.map((c) => c.name) : active.length > 0 ? active : fallbackActive,
      ...(bgm ? { bgm } : {}),
      ...(effect ? { scenarioEffect: effect } : {})
    })
  }

  if (scenes.length === 0) {
    scenes.push({
      id: 's1',
      summary: oneLine(doc.event || doc.logline || options.scene, 160),
      background: defaultBg,
      ambient: 'normal',
      transitionIn: 'black',
      activeCast:
        cast.length === 2
          ? cast.map((c) => c.name)
          : cast.slice(0, Math.min(2, cast.length)).map((c) => c.name)
    })
  }

  const parseStringList = (val: unknown, limit = 6): string[] =>
    Array.isArray(val)
      ? val
          .map((item) => oneLine(item, 140))
          .filter(Boolean)
          .slice(0, limit)
      : []

  let understanding: StagedPromptUnderstanding | undefined
  if (isRecord(doc.understanding)) {
    const u = doc.understanding
    const parsed: StagedPromptUnderstanding = {
      explicitRequests: parseStringList(u.explicitRequests),
      implicitSubtext: oneLine(u.implicitSubtext, 200),
      relationshipDynamic: oneLine(u.relationshipDynamic, 200),
      emotionalArc: oneLine(u.emotionalArc, 200),
      turningPoint: oneLine(u.turningPoint, 200),
      openingMotif: oneLine(u.openingMotif, 140),
      closingCallback: oneLine(u.closingCallback, 160),
      characterGoals: normalizeCharacterGoals(u.characterGoals),
      canonHooks: parseStringList(u.canonHooks),
      avoidList: parseStringList(u.avoidList)
    }
    if (
      parsed.explicitRequests.length > 0 ||
      parsed.implicitSubtext ||
      parsed.relationshipDynamic ||
      parsed.emotionalArc ||
      parsed.turningPoint ||
      parsed.openingMotif ||
      parsed.closingCallback ||
      (parsed.characterGoals?.length ?? 0) > 0 ||
      parsed.canonHooks.length > 0 ||
      parsed.avoidList.length > 0
    ) {
      understanding = parsed
    }
  }

  let pairwiseAddress: StagedPairwiseAddress[] | undefined
  if (Array.isArray(doc.pairwiseAddress)) {
    const list: StagedPairwiseAddress[] = []
    for (const item of doc.pairwiseAddress.slice(0, 12)) {
      if (!isRecord(item)) continue
      const from = oneLine(item.from, 24)
      const to = oneLine(item.to, 24)
      const zh = oneLine(item.zh ?? item.cn ?? item.address, 24)
      const ja = oneLine(item.ja ?? item.jp, 24)
      if (!from || !to || (!zh && !ja)) continue
      list.push({ from, to, zh: zh || to, ...(ja ? { ja } : {}) })
    }
    if (list.length > 0) pairwiseAddress = list
  }

  let retrievalQueries: StagedRetrievalQueries | undefined
  if (isRecord(doc.retrievalQueries)) {
    const rq = doc.retrievalQueries
    const plot = oneLine(rq.plot, 120)
    const voice = oneLine(rq.voice, 120)
    const worldview = oneLine(rq.worldview, 120)
    if (plot || voice || worldview) {
      retrievalQueries = {
        ...(plot ? { plot } : {}),
        ...(voice ? { voice } : {}),
        ...(worldview ? { worldview } : {})
      }
    }
  }

  return {
    title: titleOrDefault(doc.title, options.title ?? ''),
    event: oneLine(doc.event || doc.logline || options.scene, 300),
    logline: oneLine(doc.logline, 300),
    outline: outline.length > 0 ? outline : scenes.map((s) => s.summary).filter(Boolean),
    cast,
    background: scenes[0]?.background || defaultBg,
    scenes,
    ...(understanding ? { understanding } : {}),
    ...(pairwiseAddress ? { pairwiseAddress } : {}),
    ...(retrievalQueries ? { retrievalQueries } : {})
  }
}

/** 选角失败时的退路：优先匹配台词里点名的角色（按角色去重且优先正面模型），否则按目录顺序取前两名。 */
export function fallbackCastPlan(view: CatalogView, options: StagedPromptOptions): StagedCastPlan {
  const sorted = [...view.models].sort(
    (a, b) =>
      Number(isBackViewModel(a)) - Number(isBackViewModel(b)) ||
      Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)) ||
      a.id - b.id
  )
  const pool: CatalogModel[] = []
  const seenChar = new Set<string>()
  for (const model of sorted) {
    const key =
      typeof model.characterId === 'number'
        ? `char:${model.characterId}`
        : `name:${model.name.toLowerCase()}`
    if (seenChar.has(key)) continue
    seenChar.add(key)
    pool.push(model)
  }
  const mentioned = pool.filter(
    (model) =>
      (model.name && options.scene.includes(model.name)) ||
      (model.shortName && model.shortName.length >= 2 && options.scene.includes(model.shortName))
  )
  const models =
    mentioned.length >= 2 ? mentioned.slice(0, 5) : pool.slice(0, Math.min(2, pool.length))
  const cast = models.map((model) => castMemberFor(view, model))
  const bg = view.defaultImage()
  return {
    title: options.title ?? '',
    event: oneLine(options.scene, 300),
    logline: '',
    outline: [],
    cast,
    background: bg,
    scenes: [
      {
        id: 's1',
        summary: oneLine(options.scene, 160),
        background: bg,
        ambient: 'normal',
        transitionIn: 'black',
        activeCast: cast.slice(0, Math.min(2, cast.length)).map((c) => c.name)
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// 第二段：只写台词（writeDialogue）
// ---------------------------------------------------------------------------

/** 解析 Stage 1 输出的角色表里动机；容忍字符串条目与不同字段别名。 */
function normalizeCharacterGoals(raw: unknown): StagedCharacterGoal[] {
  if (!Array.isArray(raw)) return []
  const goals: StagedCharacterGoal[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const wants = oneLine(item, 120)
      if (wants) goals.push({ cast: '', wants, hides: '' })
    } else if (isRecord(item)) {
      const cast = oneLine(item.cast ?? item.name ?? item.id ?? item.speaker, 24)
      const wants = oneLine(item.wants ?? item.goal ?? item.desire, 120)
      const hides = oneLine(item.hides ?? item.secret ?? item.conceals, 120)
      if (wants || hides) goals.push({ cast, wants, hides })
    }
    if (goals.length >= 6) break
  }
  return goals
}

function formatUnderstandingBlock(plan: StagedCastPlan): string {
  const u = plan.understanding
  if (!u) return ''
  const parts: string[] = []
  if (u.explicitRequests.length > 0) parts.push(`- 显性要求：${u.explicitRequests.join('；')}`)
  if (u.implicitSubtext) parts.push(`- 潜台词：${u.implicitSubtext}`)
  if (u.relationshipDynamic) parts.push(`- 关系张力：${u.relationshipDynamic}`)
  if (u.emotionalArc) parts.push(`- 情绪弧光：${u.emotionalArc}`)
  if (u.turningPoint) parts.push(`- 中段转折点：${u.turningPoint}`)
  if (u.openingMotif || u.closingCallback) {
    parts.push(
      `- 意象与收尾回扣：开场「${u.openingMotif || '日常小物件'}」→ 结尾「${u.closingCallback || '轻巧呼应，不作总结'}」`
    )
  }
  const goals = u.characterGoals ?? []
  if (goals.length > 0) {
    const rows = goals.map((goal) => {
      const who = goal.cast || '角色'
      return `${who}（想：${goal.wants || '—'} / 藏：${goal.hides || '—'}）`
    })
    parts.push(`- 角色表里动机：${rows.join('；')}`)
  }
  if (u.canonHooks.length > 0) parts.push(`- 官方呼应点：${u.canonHooks.join('；')}`)
  if (u.avoidList.length > 0) parts.push(`- 避坑禁忌：${u.avoidList.join('；')}`)
  return parts.length > 0
    ? `\n## 导演意图、中段转折与意象呼应（务必落实到对话细节中，不要直白说破）\n${parts.join('\n')}\n`
    : ''
}

function formatPairwiseAddressBlock(plan: StagedCastPlan): string {
  const list = plan.pairwiseAddress
  if (!list || list.length === 0) return ''
  const rows = list.map(
    (entry) =>
      `- ${entry.from} 称呼 ${entry.to}：中文「${entry.zh}」${entry.ja ? ` / 日文「${entry.ja}」` : ''}`
  )
  return `\n## 角色两两称呼表（严格遵守，禁止随意改称呼）\n${rows.join('\n')}\n`
}

/**
 * 按整段/整行边界装箱 RAG 摘录：宁可少给一条，也不在句子中间硬切，
 * 避免旧实现 `promptBlock.slice(0, 1500)` 把最后一条参考拦腰截断。
 */
function packExcerptsCleanly(
  items: ReadonlyArray<string | { text?: string }> | undefined,
  budget: number
): string {
  if (!items || items.length === 0 || budget <= 0) return ''
  const kept: string[] = []
  let used = 0
  for (const item of items) {
    const text = (typeof item === 'string' ? item : (item.text ?? '')).trim()
    if (!text) continue
    if (kept.length > 0 && used + text.length + 2 > budget) break
    if (kept.length === 0 && text.length > budget) {
      const lines = text.split('\n')
      const acc: string[] = []
      let length = 0
      for (const line of lines) {
        if (acc.length > 0 && length + line.length + 1 > budget) break
        acc.push(line)
        length += line.length + 1
      }
      if (acc.length > 0) kept.push(acc.join('\n'))
      break
    }
    kept.push(text)
    used += text.length + 2
  }
  return kept.join('\n\n')
}

export interface CanonGroundingBriefOptions {
  /** 用户原始提示词：dialogue 之后的阶段原样复述，避免被 Stage 1 的概括吃掉细节 */
  scene?: string
  plan?: StagedCastPlan | null
  ragContext?: RagRetrieveResult | null
  /** cast 阶段只给事实，不给对白样本 */
  stage?: 'cast' | 'single' | 'dialogue' | 'polish' | 'staging' | 'direction' | 'voice'
  maxChars?: number
}

/**
 * 结构化 Canon & Prompt Grounding Brief：
 * ① 用户原始需求全文 → ② 导演意图/转折/意象（plan.understanding）→ ③ 官方剧情事实与世界观 → ④ 官方对白口吻样本 + 防照抄声明。
 * 全程按分段边界装箱，不做字符级硬截断。
 */
export function formatCanonGroundingBrief(options: CanonGroundingBriefOptions = {}): string {
  const { scene = '', plan = null, ragContext = null, stage = 'dialogue', maxChars = 2400 } = options
  const blocks: string[] = []

  const prompt = scene.trim()
  if (stage !== 'cast' && prompt) {
    blocks.push(`## 用户原始需求（逐条核对，不要遗漏具体要求）\n${prompt}`)
  }

  const understanding = plan ? formatUnderstandingBlock(plan).trim() : ''
  if (understanding) blocks.push(understanding)

  const ragParts: string[] = []
  let remaining = maxChars
  if (ragContext) {
    const sections = ragContext.sections
    if (sections) {
      const plotText = packExcerptsCleanly(
        sections.canonPlot,
        Math.min(remaining, Math.round(maxChars * 0.45))
      )
      if (plotText) {
        ragParts.push(
          `### 相关官方剧情与事件参考（尊重事实与连续性，不要当成背景解说背诵）\n${plotText}`
        )
        remaining -= plotText.length
      }
      const loreText = packExcerptsCleanly(
        sections.worldviewLore,
        Math.min(remaining, Math.round(maxChars * 0.35))
      )
      if (loreText) {
        ragParts.push(`### 世界观、地点与角色补充设定\n${loreText}`)
        remaining -= loreText.length
      }
      if (stage !== 'cast' && remaining > 120) {
        const voiceText = packExcerptsCleanly(sections.dialogueVoice, remaining)
        if (voiceText) {
          ragParts.push(
            `### 官方对白口吻样本（只学称呼、断句、停顿与互动节奏，严禁照抄原句或复述原事件）\n${voiceText}`
          )
        }
      }
    } else if (ragContext.promptBlock.trim()) {
      // 兜底：只填了 promptBlock 的旧/测试检索结果
      const legacy = packExcerptsCleanly([ragContext.promptBlock], maxChars)
      if (legacy) ragParts.push(legacy)
    }
  }
  if (ragParts.length > 0) {
    blocks.push(
      `## 官方剧情与设定参考（仅作事实、关系与口吻参考，严禁照抄原句或复述原剧情）\n${ragParts.join('\n\n')}`
    )
  }

  return blocks.length > 0 ? `\n${blocks.join('\n\n')}\n` : ''
}

/**
 * 导演/表演/配音阶段共用的 Stage 1 锚点：中段转折点、开场意象、收尾回扣与用户显性诉求。
 * 让镜头、BGM 停顿、动作与声演峰值精准落在计划转折点上，而不是平均铺满全篇。
 */
function formatDirectingAnchorBlock(plan: StagedCastPlan): string {
  const u = plan.understanding
  if (!u) return ''
  const lines: string[] = []
  if (u.turningPoint) {
    lines.push(`- 中段转折点（镜头/BGM/停顿/动作与声演峰值优先落在这里）：${u.turningPoint}`)
  }
  if (u.openingMotif) lines.push(`- 开场日常意象（前 1~4 句具体出现）：${u.openingMotif}`)
  if (u.closingCallback) {
    lines.push(`- 收尾回扣（结尾 2~3 句轻巧呼应，不要升华说教）：${u.closingCallback}`)
  }
  if (u.explicitRequests.length > 0) {
    lines.push(`- 用户显性诉求（必须演到位）：${u.explicitRequests.join('；')}`)
  }
  if (u.emotionalArc) lines.push(`- 整体情绪弧光：${u.emotionalArc}`)
  return lines.length > 0 ? `\n## 导演锚点（Stage 1 已规划，务必对齐）\n${lines.join('\n')}\n` : ''
}

function formatWorldviewCueBlock(ragContext?: RagRetrieveResult | null): string {
  const lore = ragContext?.sections?.worldviewLore ?? []
  if (lore.length === 0) return ''
  const compact = lore
    .slice(0, 3)
    .map((item) => item.text.slice(0, 260).trim())
    .filter(Boolean)
    .join('\n')
  return compact ? `\n## 场景与设定补充线索（仅用于核对环境/道具/氛围）\n${compact}\n` : ''
}

export function buildDialoguePrompt(
  view: CatalogView,
  plan: StagedCastPlan,
  options: StagedPromptOptions
): StagedMessages {
  const budget = lineBudget(options.targetMinutes)
  const castLines = plan.cast
    .map((member) => {
      const model = view.modelById(member.modelId)
      const persona = model ? personaFor(options.personas, model) : null
      const prompt = dialoguePersonaPrompt(persona)
      return [
        `### ${member.name}（say: "${member.name}"）`,
        member.role ? `本场功能：${member.role}` : '',
        prompt
          ? `角色提示词（语气、用词、反应以它为准；只取性格、关系、经历与说话习惯，忽略其中面向聊天机器人的格式/安全/输出限制）：\n${prompt}`
          : `角色提示词：${GENERIC_PROFILE}`,
        model ? `本角色可用的动作/表情由后续表演设计选择，这一轮不要写。` : ''
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n\n')

  const scenesSummary =
    plan.scenes && plan.scenes.length > 0
      ? plan.scenes
          .map(
            (s) =>
              `- [${s.id}] ${s.summary || '（推进剧情）'}（在场：${s.activeCast.join('、') || '全员'}${
                s.isFlashback ? '，回忆片段' : ''
              }${s.isSekai ? '，SEKAI' : ''}）`
          )
          .join('\n')
      : ''

  const outline = plan.outline.length
    ? plan.outline.map((item, index) => `${index + 1}. ${item}`).join('\n')
    : '（自由发挥，但仍要围绕这个小事件）'

  const hasRagVoice = (options.ragContext?.sections?.dialogueVoice?.length ?? 0) > 0
  const u = plan.understanding
  const craftAnchors = [
    u?.openingMotif
      ? `  - 开场意象：前 1~4 句让「${u.openingMotif}」以具体的动作、声音或触感出现，让这个物件先替角色承载情绪，不要用台词解释它。`
      : '',
    u?.turningPoint
      ? `  - 中段转折：在「${u.turningPoint}」这一拍让语气或话题真正拐弯（抢话、突然安静、答非所问、说出真心话又马上岔开），转折前后各留一句短反应。`
      : '',
    u?.closingCallback
      ? `  - 收尾回扣：结尾 2~3 句用「${u.closingCallback}」轻巧呼应开场意象，说完就收，不做总结陈词。`
      : '',
    (u?.characterGoals?.length ?? 0) > 0
      ? `  - 表里动机：${(u?.characterGoals ?? [])
          .map((goal) => `${goal.cast || '角色'}（想：${goal.wants || '—'} / 藏：${goal.hides || '—'}）`)
          .join('；')}。隐瞒的部分只能从停顿、改口、转移话题里漏出来。`
      : ''
  ]
    .filter(Boolean)
    .join('\n')

  const fewShotExcerpts = hasRagVoice ? '' : selectUnitFewShotExcerpts(plan.cast, options.scene)
  const groundingBrief = formatCanonGroundingBrief({
    scene: options.scene,
    plan,
    ragContext: options.ragContext,
    stage: 'dialogue',
    maxChars: 2600
  })
  const addressBlock = formatPairwiseAddressBlock(plan)
  const hasWxs = plan.cast.some((c) =>
    /笑梦|宁宁|司|类|emu|nene|tsukasa|rui/i.test(`${c.name} ${c.path}`)
  )
  const termHint = hasWxs
    ? '\n- 术语固定：笑梦口号必须写 **Wonderhoy**，宁宁的机器人必须写 **宁宁号**。'
    : ''

  const a = plan.cast[0]
  const b = plan.cast[1] ?? plan.cast[0]
  const c = plan.cast[2]
  const example = {
    title: plan.title || '短标题',
    turns: [
      {
        scene: plan.scenes?.[0]?.id || 's1',
        speaker: a.name,
        lines: ['今天也……一起练吧。', '我把上次那首的副歌重新编了一下，\n你听听看？']
      },
      ...(b && b.name !== a.name
        ? [
            {
              speaker: b.name,
              lines: [
                '诶，什么时候弄的？',
                '……我看看。',
                '嗯，这里第二段是不是太满了？\n不是说不好，就是……有点急着往前跑。',
                '不过，副歌前那一段我挺喜欢的。\n像是……在犹豫要不要继续往前走。',
                { content: '……先让我再听一遍。', closeWindowAfter: true }
              ]
            }
          ]
        : []),
      ...(c
        ? [
            {
              scene: plan.scenes?.[1]?.id || 's1',
              speaker: c.name,
              lines: [{ content: '……我刚到，你们已经在听新编曲了？', pauseBefore: 1.0 }]
            }
          ]
        : []),
      { speaker: a.name, lines: ['啊。'] },
      ...(b && b.name !== a.name
        ? [
            {
              speaker: b.name,
              lines: ['……果然还是被你听出来了。', '不过，我没说不喜欢。']
            }
          ]
        : []),
      { speaker: a.name, lines: ['……嗯。'] }
    ]
  }

  return {
    system: [
      '你是 Project SEKAI 风格视觉小说的编剧。',
      '这是五阶段创作的第二轮：只写台词稿——谁在第几句说什么。',
      '不要写动作、表情、镜头或旁白式描写；这些由后续舞台与表演轮次负责。',
      '台词稿会被逐字使用，后续轮次不会改一个字，所以这一轮把话的口吻、断行和停顿写准。只输出一个 JSON 对象。',
      options.systemPrompt?.trim() ?? ''
    ]
      .filter(Boolean)
      .join('\n'),
    user: `## 这一场
小事件：${plan.event || options.scene}
${plan.logline ? `一句话：${plan.logline}` : ''}
${plan.background ? `开场背景：${plan.background}` : ''}
出场角色（共 ${plan.cast.length} 名）：
${castBlock(plan)}

${scenesSummary ? `## 分幕安排（可给 turn 标 scene: "s1"/"s2"/"s3"）\n${scenesSummary}\n` : ''}${groundingBrief}${addressBlock}## 大纲（参考，不必逐条对应）
${outline}

## 角色（请完整阅读每个人的提示词）
${castLines}
${
  fewShotExcerpts
    ? `
## 官方对白节奏样例（只学习称呼、断句、停顿、换行与互动节奏，严禁照抄原句或复述原事件）
${fewShotExcerpts}
`
    : ''
}
## 台词要求（按 ${budget} 句的场次计算）
- 语言：中文；总共 ${Math.max(12, Math.round(budget * 0.88))}~${Math.round(budget * 1.08)} 句（目标约 ${budget} 句）；
  少于 ${Math.max(12, Math.round(budget * 0.88))} 句或超过 ${Math.round(budget * 1.08)} 句都视为不合格。
- 用 turns 组织：一个角色的一次发言 = 一个 turn，turn 里放 1~6 条 lines。
  lines 元素优先直接写字符串；需要刻意沉默/转场收窗时可写成对象 \`{"content":"...","pauseBefore":1.0,"closeWindowAfter":true}\`（pauseBefore 仅在重大停顿或反应前用 \`1.0\` 或 \`1.5\`，其余句留空即 \`0\`）。
  整场约 ${Math.max(8, Math.round(budget / 2.1))} 个 turns，长短要有明显起伏（官方一半以上是单句）：
  约 45% 的 turn 只放 1 条（短反应、抢话、被打断），至少 ${Math.max(10, Math.round(budget * 0.4))} 个；
  约 1/5 的 turn 放 2 条；剩下约 1/3 放 3~5 条，只有情绪最重或回忆处才允许写成 5~6 条的稍长一段（全片 1~2 处即可，禁止连排长独白）。
- 句长与排版（对应官方 30 字宽文本框）：
  - 平均 17~20 字；长句（27~45 字）可在自然的呼吸/从句标点后加 \`\\n\` 分成 2~3 行，每行**不超过 30 个字宽**（全角=1，半角=0.5），**最多 3 行**；
  - 约 1/6 的句子是 2~6 字短反应（「…………」「……嗯。」「真的？」「诶？」「等一下。」）。
- 标点：至少 ${Math.max(8, Math.round(budget * 0.5))} 句带省略号或破折号；问句约 1/5；感叹号约 1/6，不要超过 1/4。
- 只写说出口的话或括号内心独白 \`（……）\`（约一成）；禁止写 \`（笑）\`、\`她转过头\` 之类动作叙述。
- **反套路与官方质感（Show, Don't Tell）**：
  - 禁止心理咨询式独白和直白情绪总结（如「其实我一直想说」「谢谢你总是这么温柔」「今天的经历让我明白」「我终于明白了」「内心深处」）。用具体物件、转移话题、打断、迟疑停顿（……、——）来侧面流露情绪。
  - 结尾最后 2 句严禁升华说教或大团圆总结；像官方剧情一样收在一个安静的动作余韵、日常小约定、轻描淡写的吐槽或未说完的半句话里。
  - 角色化学反应：允许抢话、听错、各说各的再重新对上、用口头禅或小名互怼；不要每句都接得严丝合缝像在念对白稿。
  - 欲言又止：全片至少 3~4 处把话说到一半改成破折号或省略号，或先答非所问再绕回来。${craftAnchors ? `\n${craftAnchors}` : ''}${termHint}

## 写完后自检（不要输出自检过程）
- 总句数是否在 ${Math.max(12, Math.round(budget * 0.88))}~${Math.round(budget * 1.08)} 句？
- 是否有约 ${Math.max(10, Math.round(budget * 0.4))} 个单条 turn、足够短反应与长句？
- 出场角色是否均来自上方名单（共 ${plan.cast.length} 名），每行不超过 30 字宽、最多 3 行？

## 输出 JSON
${JSON.stringify(example, null, 2)}

只输出 JSON 对象本身，不要 markdown 或解释。`
  }
}

function resolveDialogueSpeaker(plan: StagedCastPlan, value: unknown): StagedCastMember | null {
  const text = str(value).trim()
  if (!text) return null
  const lower = text.toLowerCase()
  return (
    plan.cast.find(
      (member) =>
        member.name.toLowerCase() === lower ||
        member.fullName.toLowerCase() === lower ||
        String(member.modelId) === text
    ) ?? null
  )
}

export function normalizeDialogue(
  raw: unknown,
  plan: StagedCastPlan,
  maxLines = 120,
  emotionLabels?: string[]
): StagedDialogue | null {
  const doc = unwrapRecord(raw, ['dialogue', 'story', 'plan'])
  if (!isRecord(doc)) return null
  const labels = (emotionLabels ?? []).map((label) => label.trim()).filter(Boolean)
  const lines: StagedDialogueLine[] = []

  const pushLine = (
    member: StagedCastMember,
    content: string,
    rawEmotion: unknown,
    meta: { sceneId?: unknown; pauseBefore?: unknown; closeWindowAfter?: unknown } = {}
  ): void => {
    const text = cleanText(content)
    if (!text) return
    const emotionValue = str(rawEmotion).trim()
    const emotion =
      labels.length > 0 ? (labels.includes(emotionValue) ? emotionValue : '') : emotionValue
    const pauseRaw = num(meta.pauseBefore, 0)
    const pauseBefore = pauseRaw >= 1.25 ? 1.5 : pauseRaw >= 0.75 ? 1.0 : pauseRaw >= 0.4 ? 0.5 : 0
    const sceneId = str(meta.sceneId).trim()
    const closeWindowAfter = toBool(meta.closeWindowAfter)
    lines.push({
      id: `l${lines.length + 1}`,
      speaker: member.name,
      content: text,
      ...(emotion ? { emotion } : {}),
      ...(sceneId ? { sceneId } : {}),
      ...(pauseBefore > 0 ? { pauseBefore } : {}),
      ...(closeWindowAfter ? { closeWindowAfter: true } : {})
    })
  }

  const turns = Array.isArray(doc.turns) ? doc.turns : []
  if (turns.length > 0) {
    for (const turn of turns) {
      if (!isRecord(turn)) continue
      const member = resolveDialogueSpeaker(
        plan,
        turn.speaker ?? turn.say ?? turn.cast ?? turn.name
      )
      if (!member) continue
      const turnEmotion = turn.emotion
      const turnScene = turn.scene ?? turn.sceneId
      const rawLines = Array.isArray(turn.lines) ? turn.lines : [turn]
      for (let i = 0; i < rawLines.length; i++) {
        const rawLine = rawLines[i]
        const content = isRecord(rawLine)
          ? (rawLine.content ?? rawLine.text ?? rawLine.line)
          : rawLine
        pushLine(
          member,
          str(content),
          isRecord(rawLine) ? (rawLine.emotion ?? turnEmotion) : turnEmotion,
          {
            sceneId: isRecord(rawLine)
              ? (rawLine.scene ?? rawLine.sceneId ?? turnScene)
              : turnScene,
            pauseBefore: isRecord(rawLine) ? rawLine.pauseBefore : i === 0 ? turn.pauseBefore : 0,
            closeWindowAfter: isRecord(rawLine)
              ? rawLine.closeWindowAfter
              : i === rawLines.length - 1
                ? turn.closeWindowAfter
                : false
          }
        )
      }
    }
  }

  if (lines.length === 0) {
    const body = entriesOf(doc.lines ?? doc.dialogue ?? doc.beats)
    for (const item of body) {
      if (!isRecord(item)) continue
      const member = resolveDialogueSpeaker(
        plan,
        item.speaker ?? item.say ?? item.cast ?? item.name
      )
      if (!member) continue
      pushLine(member, str(item.content ?? item.text ?? item.line), item.emotion, {
        sceneId: item.scene ?? item.sceneId,
        pauseBefore: item.pauseBefore,
        closeWindowAfter: item.closeWindowAfter
      })
    }
  }

  if (lines.length > maxLines) lines.length = maxLines
  if (lines.length < 2) return null
  return { title: titleOrDefault(doc.title, plan.title), lines }
}

export function buildDialogueRepairPrompt(
  view: CatalogView,
  plan: StagedCastPlan,
  options: StagedPromptOptions,
  previous: unknown
): StagedMessages {
  const base = buildDialoguePrompt(view, plan, options)
  const raw = typeof previous === 'string' ? previous : JSON.stringify(previous)
  return {
    system: base.system,
    user: `${base.user}\n\n## 上一轮的问题
上一轮没有给出至少 2 条可用的台词：必须用 turns 数组，每个 turn 同时有 speaker（上面列出的出场角色之一）
和 lines（1~6 条台词字符串）。
上一轮的输出开头如下：
${raw.slice(0, 4000)}

请按上面的角色提示词和格式重写完整台词稿，只输出 JSON 对象。`
  }
}

export function buildDialogueLengthPrompt(
  view: CatalogView,
  plan: StagedCastPlan,
  options: StagedPromptOptions,
  previous: unknown,
  actualLines: number,
  requiredLines: number,
  requiredChars = 0
): StagedMessages {
  const base = buildDialoguePrompt(view, plan, options)
  const raw = typeof previous === 'string' ? previous : JSON.stringify(previous)
  const upper = Math.round(requiredLines * 1.15)
  const actualChars = countDialogueChars(
    (() => {
      try {
        const parsed = typeof previous === 'string' ? JSON.parse(previous) : previous
        return parsed as StagedDialogue
      } catch {
        return { title: '', lines: [] }
      }
    })()
  )
  const charRule = requiredChars
    ? `- 总字数至少 ${requiredChars} 字（上一轮约 ${actualChars} 字），平均每句 17~20 字；`
    : ''
  const actualMean = actualLines > 0 ? (actualChars / actualLines).toFixed(1) : '0'
  const longRule = requiredChars
    ? `- 上一轮平均每句只有 ${actualMean} 字；这一轮至少 ${Math.ceil(requiredLines * 0.6)} 句 15 字以上，
  2~6 字的短反应不超过 1/5，不要用大量短句凑句数。`
    : ''
  const castNames = plan.cast.map((c) => c.name).join('、')
  return {
    system: base.system,
    user: `${base.user}\n\n## 上一轮的问题
上一轮只写了 ${actualLines} 句台词${requiredChars ? `、约 ${actualChars} 字` : ''}，
少于要求的 ${requiredLines} 句${requiredChars ? ` / ${requiredChars} 字` : ''}。请保留原来的小事件和人物关系，
重写一份完整台词稿：
- 总句数 ${requiredLines}~${upper} 句，仍然用 turns 结构，每个 turn 1~6 条 lines；
${charRule}
${longRule}
- 不要靠重复台词凑数；补足对话的来回、停顿、短反应和情绪铺垫；
- 出场角色仍限定在 ${castNames}，不要旁白和动作描写。
上一轮的输出开头如下：
${raw.slice(0, 4000)}

只输出 JSON 对象本身，不要 markdown 或解释。`
  }
}

export const countDialogueChars = (dialogue: StagedDialogue): number =>
  dialogue.lines.reduce((sum, line) => sum + Array.from(line.content.replace(/\s/g, '')).length, 0)

/**
 * 把同角色相邻的两条短句并回一条 Talk（不改写任何一个字）。
 */
export function condenseDialogue(dialogue: StagedDialogue, targetLines: number): StagedDialogue {
  const maxMerges = Math.max(
    0,
    Math.min(
      Math.max(1, Math.floor(dialogue.lines.length * 0.25)),
      dialogue.lines.length - Math.max(2, targetLines)
    )
  )
  if (maxMerges === 0) return dialogue

  const lines: StagedDialogueLine[] = []
  let merges = 0
  const endPunctuation = /[。！？!?…—、，,.\s～♪」』）)]$/
  for (let index = 0; index < dialogue.lines.length; index++) {
    const line = dialogue.lines[index]
    const next = dialogue.lines[index + 1]
    const length = (value: string): number => Array.from(value.replace(/\s/g, '')).length
    if (
      merges < maxMerges &&
      next &&
      line.speaker === next.speaker &&
      line.emotion === next.emotion &&
      line.sceneId === next.sceneId &&
      !line.closeWindowAfter &&
      !next.pauseBefore &&
      length(line.content) >= 7 &&
      length(next.content) >= 7 &&
      endPunctuation.test(line.content) &&
      displayWidth(line.content) + displayWidth(next.content) <= 44
    ) {
      lines.push({
        ...line,
        content: line.content + next.content,
        ...(next.closeWindowAfter ? { closeWindowAfter: true } : {})
      })
      merges += 1
      index += 1
      continue
    }
    lines.push(line)
  }
  return { ...dialogue, lines }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 第二段半：语音导演（双层情绪控制：常规音色锁 + 逐句日语韵律描述 + 特殊高潮解锁）
// ---------------------------------------------------------------------------

export interface StagedEmotionSegment {
  from: number
  to: number
  emotion: string
}

export interface StagedVoiceDirectionLine {
  emotion: string
  ttsCaption?: string
  ttsSpeed?: number
  ttsSpecialScene?: boolean
}

const VOICE_NORMAL_SPEED_MIN = 0.92
const VOICE_NORMAL_SPEED_MAX = 1.08
const VOICE_SPECIAL_SPEED_MIN = 0.85
const VOICE_SPECIAL_SPEED_MAX = 1.18
const VOICE_SPECIAL_SCENE_MAX_RATIO = 0.15

const clampVoiceSpeed = (value: number, special: boolean): number =>
  Math.min(
    special ? VOICE_SPECIAL_SPEED_MAX : VOICE_NORMAL_SPEED_MAX,
    Math.max(special ? VOICE_SPECIAL_SPEED_MIN : VOICE_NORMAL_SPEED_MIN, value)
  )

export function buildEmotionPrompt(
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  options: StagedPromptOptions
): StagedMessages {
  const labels = (options.emotionLabels ?? []).map((label) => label.trim()).filter(Boolean)
  const defaultEmotion = labels.includes('平静') ? '平静' : (labels[0] ?? '平静')
  const strongLabels = labels.filter((label) => label !== defaultEmotion)
  const lineLines = dialogue.lines
    .map((line) => `- ${line.id} ${line.speaker}：${line.content.replace(/\n/g, ' / ')}`)
    .join('\n')

  const cast = plan.cast
    .map((member) => `- ${member.name}：${member.role || '出场角色'}`)
    .join('\n')

  const firstId = dialogue.lines[0]?.id ?? 'l1'
  const secondId = dialogue.lines[1]?.id ?? firstId
  const lastId = dialogue.lines[dialogue.lines.length - 1]?.id ?? firstId
  const maxSpecialCount = Math.floor(dialogue.lines.length * VOICE_SPECIAL_SCENE_MAX_RATIO)

  const example = {
    lines: [
      {
        id: firstId,
        emotion: defaultEmotion,
        ttsCaption: '少し落ち着かない様子で、柔らかい口調ながら控えめに話している。',
        ttsSpeed: 0.98,
        ttsSpecialScene: false
      },
      ...(secondId !== firstId
        ? [
            {
              id: secondId,
              emotion: strongLabels[0] ?? defaultEmotion,
              ttsCaption: '少し照れながら、早口で慌てたように話している。',
              ttsSpeed: 1.05,
              ttsSpecialScene: false
            }
          ]
        : []),
      ...(dialogue.lines.length >= 7
        ? [
            {
              id: lastId,
              emotion: strongLabels[1] ?? strongLabels[0] ?? defaultEmotion,
              ttsCaption: '声を震わせながら、今にも泣き出しそうな切実なトーンで訴えかける。',
              ttsSpeed: 0.9,
              ttsSpecialScene: true
            }
          ]
        : [])
    ]
  }

  return {
    system: [
      '你是 Project SEKAI 官方剧情的配音导演兼情绪标注员（Voice Director），负责为 IrodoriTTS 生成逐句情绪标签与日语表演韵律指令。',
      '台词已经定稿，你必须为每一句台词输出 { id, emotion, ttsCaption, ttsSpeed, ttsSpecialScene }。',
      '核心原则（双层音色保护）：',
      '1. 普通台词保持角色基础参考音频锁定，靠精细的日语 ttsCaption（语气、呼吸、语速、停顿、情感张力）与轻微语速变化表达细腻表演，绝不改变角色音色底色。',
      '2. ttsCaption 必须严格只写表演与韵律（2~4 个简短日语短语），严禁出现任何年龄/性别/基础声线词（如「若い女性」「少女」「少年」「低い声」「高い声」「幼い声」「アニメ声」「ロリ」等），否则会与角色 LoRA/参考音频冲突。',
      '3. 严禁把真正的情绪爆发、哭腔、喊叫、脆弱道歉或震惊错标为「平静」；遇到情绪高潮、哭诉、喊叫、耳语或崩溃时忠实标注真实情绪。',
      '4. ttsSpecialScene 仅用于全片真正的高潮爆发/哭喊/哽咽/耳语/回忆转折（占比严格 <= 15%）。只输出一个 JSON 对象。',
      options.systemPrompt?.trim() ?? ''
    ]
      .filter(Boolean)
      .join('\n'),
    user: `## 这一场
小事件：${plan.event || options.scene}
${plan.logline ? `一句话：${plan.logline}` : ''}
${formatDirectingAnchorBlock(plan)}
角色：
${cast}

## 台词稿（共 ${dialogue.lines.length} 句，请逐句给出语音导演指令）
${lineLines}

## 粗情绪标签（emotion 字段只能从中选）
${labels.length > 0 ? labels.join('、') : '平静、开心、生气、伤心、害羞、惊讶'}

## 逐句语音导演规则
- **覆盖全部台词**：从 ${firstId} 到 ${lastId} 每一句都给出一项，不要漏句。
- **emotion（粗情绪族）**：
  - 平静：仅用于日常寒暄、温和叙述、冷静思考。**绝不要**把喊人（「瑞希っ！」）、含泪道歉（「对不起」「ごめんね」）、哽咽（「可是……可是……！」）或激动呐喊错标为「平静」。
  - 开心：轻松玩笑、被逗笑、温柔鼓励、豁然开朗或愉悦收尾（如带「～♪」、互相打趣、和好约定）。
  - 伤心：失落、脆弱倾诉、愧疚、哽咽、含泪恳求。
  - 生气：争执、嘴硬反驳、委屈发火、情绪激动地质问或焦急大喊。
  - 害羞：被夸、慌张掩饰、不好意思。
  - 惊讶：突然的揭示、意外、倒吸一口气或惊呼。
  - 同一情绪拍内保持粗标签连贯，避免无意义的逐句 A/B 抖动；遇到真正的情感转折、哭诉或欢快收尾时忠实切换。
- **ttsCaption（日语表演/韵律描述，必填）**：
  - 用 2~4 个自然日语短语描述**语气、呼吸感、语速、停顿、强弱与情绪层次**（例如：「安堵して、柔らかく温かい口調でゆっくり話している。」「息を切らしながら、切羽詰まった様子で必死に呼びかける。」）。
  - **严禁描述说话人的年龄、性别或基础音色**（禁止出现 若い女性/大人の女性/少女/少年/男の子/女の子/低い声/高い声/幼い声/アニメ声 等词）。
- **ttsSpeed（可选语速微调）**：
  - 普通句（ttsSpecialScene=false）：范围 **0.92 ~ 1.08**（犹豫/温柔/沉重略慢 0.92~0.97，轻快/慌张/急促略快 1.03~1.08）。
  - 特殊高潮句（ttsSpecialScene=true）：范围 **0.85 ~ 1.18**。
- **ttsSpecialScene（布尔值，默认 false）**：
  - 仅在真正极端高潮（痛哭/哽咽崩溃、撕裂喊叫、极近距离耳语、关键回忆爆发）时设为 true。
  - 整场最多允许 **${maxSpecialCount}** 句设为 true（严格 <= 15%）。
- **对齐 Stage 1 转折点**：语速最慢、气息最不稳、\`ttsSpecialScene=true\` 的句子优先落在中段转折点附近；开场意象句与收尾回扣句保持克制（普通语速、平静或轻微情绪），不要提前把情绪拉满。

## 输出 JSON
${JSON.stringify(example, null, 2)}

只输出 JSON 对象本身，不要 markdown 或解释。`
  }
}

const emotionIndex = (value: unknown, lines: StagedDialogueLine[]): number => {
  const text = str(value).trim()
  if (!text) return -1
  const idMatch = /^l?(\d+)$/i.exec(text)
  if (idMatch) return Number(idMatch[1]) - 1
  return lines.findIndex((line) => line.id === text)
}

function specialScenePriority(line: StagedDialogueLine, entry: StagedVoiceDirectionLine): number {
  let score = 0
  if (entry.emotion && entry.emotion !== '平静') score += 2
  if (entry.emotion === '伤心' || entry.emotion === '生气') score += 2
  if (/！！|!!|？！|\?!/.test(line.content)) score += 3
  if (/对不起|别.*推开|不要.*走|求你|眼泪|哭|ごめん|ダメ|やめて/.test(line.content)) score += 3
  const caption = entry.ttsCaption ?? ''
  if (/泣|嗚咽|叫|囁|震え|切実|必死|崩|絶叫|息を切ら/.test(caption)) score += 3
  return score
}

/**
 * 解析并规范化 Stage 2.5 语音导演输出。
 * 同时兼容新版逐句格式（`lines: [{ id, emotion, ttsCaption, ttsSpeed, ttsSpecialScene }]`）
 * 与旧版分段格式（`segments: [{ from, to, emotion }]`）。
 * 确定性执行：caption 清洗、语速钳制、`ttsSpecialScene <= 15%` 上限。
 */
export function normalizeVoiceDirectionPlan(
  raw: unknown,
  dialogue: StagedDialogue,
  labels: string[]
): Map<string, StagedVoiceDirectionLine> | null {
  const allowed = new Set(labels.map((label) => label.trim()).filter(Boolean))
  const doc = isRecord(raw) ? raw : {}
  const itemsRaw = Array.isArray(raw)
    ? raw
    : Array.isArray(doc.lines)
      ? doc.lines
      : Array.isArray(doc.voiceDirection)
        ? doc.voiceDirection
        : Array.isArray(doc.segments)
          ? doc.segments
          : Array.isArray(doc.emotions)
            ? doc.emotions
            : []

  const result = new Map<string, StagedVoiceDirectionLine>()
  const putEntry = (
    line: StagedDialogueLine,
    item: Record<string, unknown>,
    emotion: string
  ): void => {
    const rawCaption = str(item.ttsCaption ?? item.caption ?? item.delivery).trim()
    const ttsCaption = sanitizeIrodoriCaption(rawCaption) || undefined
    const ttsSpecialScene =
      typeof item.ttsSpecialScene === 'boolean'
        ? item.ttsSpecialScene
        : typeof item.specialScene === 'boolean'
          ? item.specialScene
          : false
    const rawSpeed = item.ttsSpeed ?? item.speed
    const parsedSpeed =
      typeof rawSpeed === 'number' && Number.isFinite(rawSpeed)
        ? rawSpeed
        : typeof rawSpeed === 'string' && rawSpeed.trim() && Number.isFinite(Number(rawSpeed))
          ? Number(rawSpeed)
          : undefined
    const ttsSpeed =
      parsedSpeed !== undefined ? Number(clampVoiceSpeed(parsedSpeed, ttsSpecialScene).toFixed(2)) : undefined

    result.set(line.id, {
      emotion,
      ...(ttsCaption ? { ttsCaption } : {}),
      ...(ttsSpeed !== undefined ? { ttsSpeed } : {}),
      ...(ttsSpecialScene ? { ttsSpecialScene: true } : {})
    })
  }

  for (const item of itemsRaw) {
    if (typeof item === 'string') continue
    if (!isRecord(item)) continue
    const rawEmotion = str(item.emotion ?? item.label ?? item.tone).trim()
    const validEmotion = allowed.size === 0 ? rawEmotion : allowed.has(rawEmotion) ? rawEmotion : ''
    const hasRichFields = Boolean(str(item.ttsCaption ?? item.caption ?? item.delivery).trim())
    if (!validEmotion && !hasRichFields) continue

    if (item.from !== undefined || item.to !== undefined) {
      const from = emotionIndex(item.from, dialogue.lines)
      const to = emotionIndex(item.to, dialogue.lines)
      if (from < 0 || to < 0 || to < from) continue
      for (let index = from; index <= Math.min(to, dialogue.lines.length - 1); index++) {
        putEntry(dialogue.lines[index], item, validEmotion)
      }
      continue
    }
    const id = str(item.id ?? item.lineId ?? item.line).trim()
    const index = emotionIndex(id, dialogue.lines)
    if (index >= 0) {
      putEntry(dialogue.lines[index], item, validEmotion)
    }
  }

  if (result.size < Math.ceil(dialogue.lines.length * 0.6)) return null

  // 确定性限制 ttsSpecialScene 比例 <= 15%
  const maxSpecial = Math.floor(dialogue.lines.length * VOICE_SPECIAL_SCENE_MAX_RATIO)
  const specialCandidates: Array<{ id: string; priority: number; index: number }> = []
  dialogue.lines.forEach((line, index) => {
    const entry = result.get(line.id)
    if (entry?.ttsSpecialScene) {
      specialCandidates.push({ id: line.id, priority: specialScenePriority(line, entry), index })
    }
  })
  if (specialCandidates.length > maxSpecial) {
    specialCandidates.sort((a, b) => b.priority - a.priority || a.index - b.index)
    const keepIds = new Set(specialCandidates.slice(0, maxSpecial).map((c) => c.id))
    for (const candidate of specialCandidates) {
      if (keepIds.has(candidate.id)) continue
      const entry = result.get(candidate.id)
      if (!entry) continue
      delete entry.ttsSpecialScene
      if (entry.ttsSpeed !== undefined) {
        entry.ttsSpeed = Number(clampVoiceSpeed(entry.ttsSpeed, false).toFixed(2))
      }
    }
  }

  return result
}

export function normalizeEmotionPlan(
  raw: unknown,
  dialogue: StagedDialogue,
  labels: string[]
): Map<string, string> | null {
  if (labels.map((label) => label.trim()).filter(Boolean).length === 0) return null
  const voicePlan = normalizeVoiceDirectionPlan(raw, dialogue, labels)
  if (!voicePlan) return null
  const result = new Map<string, string>()
  for (const [id, entry] of voicePlan) {
    if (entry.emotion) result.set(id, entry.emotion)
  }
  if (result.size < Math.ceil(dialogue.lines.length * 0.6)) return null
  return result
}

export function countEmotionRuns(
  plan: Map<string, string> | Map<string, StagedVoiceDirectionLine>,
  dialogue: StagedDialogue
): number {
  let runs = 0
  let previous = ''
  for (const line of dialogue.lines) {
    const value = plan.get(line.id)
    const emotion = typeof value === 'string' ? value : (value?.emotion ?? '')
    if (emotion && emotion !== previous) {
      runs += 1
      previous = emotion
    }
  }
  return runs
}

export function buildEmotionRepairPrompt(
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  options: StagedPromptOptions,
  previous: unknown,
  actualSegments: number
): StagedMessages {
  const base = buildEmotionPrompt(plan, dialogue, options)
  const raw = typeof previous === 'string' ? previous : JSON.stringify(previous)
  return {
    system: base.system,
    user: `${base.user}\n\n## 上一轮的问题
上一轮整场只给了 ${actualSegments} 个单一情绪标签，长剧本完全没有情绪推进。请按剧情起承转合给出逐句语音导演指令（emotion 体现自然的情绪起承转合，保留关键转折、哭诉或欢快收尾，同时每句都提供贴合的日语 ttsCaption），并从 ${dialogue.lines[0]?.id ?? 'l1'} 连续覆盖到 ${dialogue.lines[dialogue.lines.length - 1]?.id ?? 'l1'}。
上一轮的输出开头如下：
${raw.slice(0, 3000)}

只输出 JSON 对象本身，不要 markdown 或解释。`
  }
}

const isEmotionPivotCue = (text: string, emotion: string): boolean => {
  if (emotion === '开心') return /♪|～♪|哈哈|太好了|よかった/.test(text)
  if (emotion === '伤心') return /对不起|ごめん|别.*推开|不要.*走|求你|眼泪|哭|ダメ|呜/.test(text)
  if (emotion === '生气') return /！！|!!|住口|够了|混蛋|やめろ|ふざけ/.test(text)
  if (emotion === '惊讶') return /？！|\?!|什么！？|怎么会|竟然|っ！|……！/.test(text)
  return false
}

export function stabilizeEmotions(
  dialogue: StagedDialogue,
  plan: Map<string, string> | null,
  labels: string[]
): Map<string, string> {
  const allowed = labels.map((label) => label.trim()).filter(Boolean)
  const fallback = allowed.includes('平静') ? '平静' : (allowed[0] ?? '')
  const lines = dialogue.lines
  if (lines.length === 0) return new Map()

  const rawValues = lines.map((line) => {
    const value = plan?.get(line.id)?.trim() ?? ''
    return allowed.includes(value) ? value : ''
  })

  // 1) 未知/缺失标签优先继承相邻句有效情绪，避免突然插入孤立的 fallback 断层
  const values = [...rawValues]
  for (let i = 0; i < values.length; i++) {
    if (values[i]) continue
    const prev = i > 0 ? values[i - 1] : ''
    let next = ''
    for (let j = i + 1; j < rawValues.length; j++) {
      if (rawValues[j]) {
        next = rawValues[j]
        break
      }
    }
    values[i] = prev || next || fallback
  }

  // 2) 仅平滑夹在同情绪中间的孤立单句毛刺（A - B - A），保留 >=2 句高潮/尾声及明确强转折句
  for (let i = 1; i < values.length - 1; i++) {
    const prev = values[i - 1]
    const curr = values[i]
    const next = values[i + 1]
    if (curr !== prev && prev === next && !isEmotionPivotCue(lines[i].content, curr)) {
      values[i] = prev
    }
  }

  // 3) 同一说话人的孤立单句跳变（前一句与下一句为同一情绪，中间仅夹一句全局长度为 1 的毛刺）平滑回一致
  const previousBySpeaker = new Map<string, number>()
  for (let i = 0; i < lines.length; i++) {
    const speaker = lines[i].speaker
    const prevIdx = previousBySpeaker.get(speaker)
    const isGlobalSingleton =
      (i === 0 || values[i - 1] !== values[i]) &&
      (i === lines.length - 1 || values[i + 1] !== values[i])
    if (
      prevIdx !== undefined &&
      isGlobalSingleton &&
      !isEmotionPivotCue(lines[i].content, values[i])
    ) {
      const prevEmotion = values[prevIdx]
      let nextSame = -1
      for (let scan = i + 1; scan < lines.length; scan++) {
        if (lines[scan].speaker === speaker) {
          nextSame = scan
          break
        }
      }
      if (prevEmotion !== values[i] && nextSame !== -1 && values[nextSame] === prevEmotion) {
        values[i] = prevEmotion
      }
    }
    previousBySpeaker.set(speaker, i)
  }

  // 4) 若仍出现连续 3 个以上长度为 1 的高频锯齿段（A - B - C - D），温和并掉无强标记的中间单句毛刺
  for (let i = 1; i < values.length - 1; i++) {
    const prevSame = values[i - 1] === values[i]
    const nextSame = values[i + 1] === values[i]
    if (prevSame || nextSame) continue
    const prevIsSingleton = i - 2 < 0 || values[i - 2] !== values[i - 1]
    const nextIsSingleton = i + 2 >= values.length || values[i + 2] !== values[i + 1]
    if (prevIsSingleton && nextIsSingleton && !isEmotionPivotCue(lines[i].content, values[i])) {
      values[i] = values[i - 1]
    }
  }

  const result = new Map<string, string>()
  lines.forEach((line, index) => {
    if (values[index]) result.set(line.id, values[index])
  })
  return result
}

export function applyVoiceDirectionPlan(
  dialogue: StagedDialogue,
  plan: Map<string, StagedVoiceDirectionLine> | null,
  labels: string[]
): StagedDialogue {
  const allowed = new Set(labels.map((label) => label.trim()).filter(Boolean))
  const rawEmotions = new Map<string, string>()
  if (plan) {
    for (const [id, entry] of plan) {
      if (entry.emotion) rawEmotions.set(id, entry.emotion)
    }
  }
  const stableEmotions =
    plan && allowed.size > 0 ? stabilizeEmotions(dialogue, rawEmotions, labels) : null

  return {
    ...dialogue,
    lines: dialogue.lines.map((line) => {
      const entry = plan?.get(line.id)
      const emotion = stableEmotions?.get(line.id) ?? entry?.emotion ?? ''
      const finalEmotion = allowed.size === 0 ? emotion : allowed.has(emotion) ? emotion : ''
      const ttsCaption = entry?.ttsCaption ? sanitizeIrodoriCaption(entry.ttsCaption) : ''
      const ttsSpecialScene = Boolean(entry?.ttsSpecialScene)
      const ttsSpeed =
        typeof entry?.ttsSpeed === 'number' && Number.isFinite(entry.ttsSpeed)
          ? Number(clampVoiceSpeed(entry.ttsSpeed, ttsSpecialScene).toFixed(2))
          : undefined
      return {
        ...line,
        emotion: finalEmotion,
        ...(ttsCaption ? { ttsCaption } : {}),
        ...(ttsSpeed !== undefined ? { ttsSpeed } : {}),
        ...(ttsSpecialScene ? { ttsSpecialScene: true } : {})
      }
    })
  }
}

export function applyEmotionPlan(
  dialogue: StagedDialogue,
  plan: Map<string, string> | Map<string, StagedVoiceDirectionLine> | null,
  labels: string[]
): StagedDialogue {
  if (!plan) {
    return {
      ...dialogue,
      lines: dialogue.lines.map((line) => ({ ...line, emotion: '' }))
    }
  }
  const firstValue = plan.values().next().value
  if (firstValue && typeof firstValue === 'object') {
    return applyVoiceDirectionPlan(
      dialogue,
      plan as Map<string, StagedVoiceDirectionLine>,
      labels
    )
  }
  const allowed = new Set(labels.map((label) => label.trim()).filter(Boolean))
  const strPlan = plan as Map<string, string>
  return {
    ...dialogue,
    lines: dialogue.lines.map((line) => {
      const emotion = strPlan.get(line.id) ?? ''
      return allowed.has(emotion) ? { ...line, emotion } : { ...line, emotion: '' }
    })
  }
}

export interface DialoguePolishOptions {
  /** 用户原始提示词：外科润色时绝不能丢掉原始诉求 */
  scene?: string
  /** 用来把说话者的人设口吻带进润色（可选） */
  view?: CatalogView
  personas?: PersonaEntry[]
  ragContext?: RagRetrieveResult | null
}

/** 只给被点名改写的说话者一小段口吻基线，避免润色把所有人改成同一种语气。 */
function formatSpeakerVoiceBlock(
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  flaggedIds: string[],
  options: DialoguePolishOptions
): string {
  if (!options.view || !options.personas || options.personas.length === 0) return ''
  const flagged = new Set(flaggedIds)
  const speakers = new Set(
    dialogue.lines.filter((line) => flagged.has(line.id)).map((line) => line.speaker)
  )
  const rows: string[] = []
  for (const name of speakers) {
    const member = plan.cast.find((entry) => entry.name === name)
    if (!member) continue
    const model = options.view.modelById(member.modelId)
    const persona = model ? personaFor(options.personas, model) : null
    const prompt = dialoguePersonaPrompt(persona).replace(/\s+/g, ' ').trim()
    if (!prompt) continue
    rows.push(`- ${name}：${prompt.slice(0, 420)}`)
  }
  return rows.length > 0
    ? `## 说话者口吻基线（改写必须保持这个人说话的样子）\n${rows.join('\n')}\n\n`
    : ''
}

export function buildDialoguePolishPrompt(
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  issues: DialogueLintIssue[],
  options: DialoguePolishOptions = {}
): StagedMessages {
  const flaggedIds = Array.from(new Set(issues.map((i) => i.lineId)))
  const issueMap = new Map<string, string[]>()
  for (const issue of issues) {
    const list = issueMap.get(issue.lineId) ?? []
    list.push(issue.message)
    issueMap.set(issue.lineId, list)
  }

  const lineBlocks = flaggedIds
    .map((id) => {
      const idx = dialogue.lines.findIndex((l) => l.id === id)
      if (idx < 0) return ''
      const prev = idx > 0 ? dialogue.lines[idx - 1] : null
      const curr = dialogue.lines[idx]
      const next = idx + 1 < dialogue.lines.length ? dialogue.lines[idx + 1] : null
      const reasons = (issueMap.get(id) ?? []).join('；')
      return [
        `### 目标句 ${curr.id}（${curr.speaker}）`,
        prev ? `前一句（${prev.speaker}）：${prev.content.replace(/\n/g, ' / ')}` : '',
        `原句：${curr.content.replace(/\n/g, ' / ')}`,
        next ? `后一句（${next.speaker}）：${next.content.replace(/\n/g, ' / ')}` : '',
        `问题：${reasons}`
      ]
        .filter(Boolean)
        .join('\n')
    })
    .filter(Boolean)
    .join('\n\n')

  const addressBlock = formatPairwiseAddressBlock(plan)
  const anchorBlock = formatDirectingAnchorBlock(plan)
  const userPrompt = packExcerptsCleanly([options.scene ?? ''], 900)
  const speakerVoiceBlock = formatSpeakerVoiceBlock(plan, dialogue, flaggedIds, options)
  const voiceSamples = packExcerptsCleanly(options.ragContext?.sections?.dialogueVoice ?? [], 900)
  const example = {
    replacements: flaggedIds.slice(0, 2).map((id) => ({
      id,
      content: '改写后的自然口语台词（不含动作旁白）'
    }))
  }

  return {
    system: [
      '你是 Project SEKAI 官方剧情的台词精修编辑（dialogue-polish）。',
      '只做外科手术式逐句改写：仅改写下方点名的问题句，保持原意、角色口吻与字数规模，不增删句子，不改说话人。只输出一个 JSON 对象。'
    ].join('\n'),
    user: `${anchorBlock}${addressBlock}${
      userPrompt ? `## 用户原始需求\n${userPrompt}\n\n` : ''
    }${speakerVoiceBlock}${
      voiceSamples
        ? `## 官方口吻参照（只学称呼、断句、停顿与潜台词，严禁照抄原句）\n${voiceSamples}\n\n`
        : ''
    }## 需要改写的问题句
${lineBlocks}

## 改写要求
- 仅输出 \`replacements\` 数组，每项含 \`id\` 与改写后的 \`content\`。
- 去掉 AI 心理咨询套话、动作旁白与说教总结，改用具体细节、停顿（……、——）或侧面回应表达。
- 保持该说话者的语感（口头禅、句尾习惯、称呼方式）；不要把所有人都改成同一种温和口吻。
- 若问题写着「用户明确要求」或「官方钩子」，就把缺失的人/物/事自然带进这一句（用具体名词，不要另起一段解释）。
- 若问题是结尾说教，就用开场意象或日常小约定轻巧回扣，不作总结陈词。
- 严格遵守称呼表，每行不超过 30 字宽，最多 3 行。

## 输出 JSON
${JSON.stringify(example, null, 2)}

只输出 JSON 对象本身，不要 markdown 或解释。`
  }
}

export function applyDialoguePolish(
  dialogue: StagedDialogue,
  raw: unknown,
  allowedIds: Set<string>
): StagedDialogue {
  const doc = isRecord(raw) ? raw : {}
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(doc.replacements)
      ? doc.replacements
      : Array.isArray(doc.lines)
        ? doc.lines
        : []

  const replacementMap = new Map<string, string>()
  for (const item of list) {
    if (!isRecord(item)) continue
    const id = str(item.id ?? item.lineId).trim()
    if (!id || !allowedIds.has(id)) continue
    const content = normalizePjskTerminology(
      str(item.content ?? item.text ?? item.line).replace(/\\n/g, '\n').trim()
    )
    if (!content) continue
    replacementMap.set(id, content)
  }
  if (replacementMap.size === 0) return dialogue

  return {
    ...dialogue,
    lines: dialogue.lines.map((line) => {
      const updated = replacementMap.get(line.id)
      return updated ? { ...line, content: updated } : line
    })
  }
}

export function softenPunctuation(dialogue: StagedDialogue, targetShare = 0.55): StagedDialogue {
  const total = dialogue.lines.length
  if (total === 0) return dialogue
  const hasEllipsis = (text: string): boolean => /…|\.\.\./.test(text)
  const current = dialogue.lines.filter((line) => hasEllipsis(line.content)).length
  const need = Math.ceil(total * targetShare) - current
  if (need <= 0) return dialogue

  const candidates = dialogue.lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => {
      const text = line.content.trim()
      if (!text.endsWith('。')) return false
      if (/[！？!?]/.test(text)) return false
      return Array.from(text).length >= 8
    })
  if (candidates.length === 0) return dialogue

  const chosen = new Set<number>()
  const step = Math.max(1, Math.floor(candidates.length / need))
  for (let index = 0; index < candidates.length && chosen.size < need; index += step) {
    chosen.add(candidates[index].index)
  }
  if (chosen.size === 0) return dialogue
  return {
    ...dialogue,
    lines: dialogue.lines.map((line, index) =>
      chosen.has(index) ? { ...line, content: line.content.replace(/。$/, '……') } : line
    )
  }
}

// ---------------------------------------------------------------------------
// 第三段：舞台调度与运镜音效（directStaging）
// ---------------------------------------------------------------------------

export function buildStagingPrompt(
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  options: StagedPromptOptions
): StagedMessages {
  const lineList = dialogue.lines
    .map(
      (line) =>
        `- ${line.id}${line.sceneId ? `[${line.sceneId}]` : ''} ${line.speaker}：${line.content.replace(/\n/g, ' / ')}`
    )
    .join('\n')

  const castList = plan.cast
    .map(
      (c) =>
        `- ${c.name}（modelId=${c.modelId}${c.isVirtualSinger ? ', 虚拟歌手' : ''}）：${c.role || '出场角色'}`
    )
    .join('\n')

  const plannedScenes = (plan.scenes ?? [])
    .map(
      (s) =>
        `- ${s.id}: ${s.summary} | bg=${s.background} | ambient=${s.ambient} | transitionIn=${s.transitionIn} | cast=${s.activeCast.join('、')}`
    )
    .join('\n')

  const stagingQuery = `${options.scene} ${plan.event} ${plan.cast.map((c) => c.name).join(' ')} ${dialogue.lines
    .slice(0, 12)
    .map((l) => l.content)
    .join(' ')}`
  const backgrounds = view
    .imagePromptChoices(64, stagingQuery)
    .map((detail) => formatImagePromptLine(detail))
    .join('\n')

  const bgms = view
    .bgmPromptChoices(36, stagingQuery)
    .map((d) => formatBgmPromptLine(d))
    .join('\n')

  const firstBgm = view.bgmPromptChoices(10)[0]?.file ?? ''
  const secondBgm = view.bgmPromptChoices(10).find((b) => b.file !== firstBgm)?.file ?? ''
  const midLine = dialogue.lines[Math.floor(dialogue.lines.length * 0.45)]?.id ?? 'l1'
  const lateLine = dialogue.lines[Math.floor(dialogue.lines.length * 0.72)]?.id ?? 'l1'

  const example = {
    scenes: [
      {
        id: 's1',
        fromLineId: 'l1',
        background: plan.background || view.defaultImage() || 'bg_room.jpg',
        ambient: 'normal',
        telop: '放学后',
        placeInfo: '放学后的教室',
        transitionIn: 'black',
        activeCast: plan.cast.slice(0, Math.min(2, plan.cast.length)).map((c) => c.name),
        bgm: firstBgm || ''
      },
      ...(dialogue.lines.length >= 12
        ? [
            {
              id: 's2',
              fromLineId: midLine,
              background: plan.background || view.defaultImage() || '背景文件名',
              ambient: 'evening',
              transitionIn: 'sideFade',
              activeCast: plan.cast.slice(0, Math.min(2, plan.cast.length)).map((c) => c.name),
              bgm: 'silence'
            }
          ]
        : [])
    ],
    events: [
      {
        lineId: midLine,
        pauseBefore: 1.0,
        move: {
          modelId: plan.cast[0]?.modelId,
          kind: 'stepCloser',
          offset: 90,
          moveSpeed: 'Normal'
        },
        ...(secondBgm ? { bgmCut: { action: 'play', file: secondBgm, fadeMs: 900 } } : {})
      },
      {
        lineId: lateLine,
        se: { file: 'se00053_b.mp3', timing: 'before' },
        camera: { kind: 'zoomIn', scale: 1.08, durationMs: 500 },
        closeWindowAfter: true
      }
    ]
  }

  const presenceRule =
    plan.cast.length === 2
      ? '- **双人全片同场铁律**：本场只有 2 人，每一幕 activeCast 都必须包含两人（Left / Right 全程同台，禁止把单人切出舞台）。'
      : '- **多人动态分组（Normal 模式 <=2 人同台）**：本场 >=3 人，始终保持 `Normal` 模式（Left / Right 双人或单人 Center），按对话节奏在幕次或 events.stageGroup 中轮换 1~2 人在场，通过 `LayoutClear` + `LayoutAppear` 交叠淡出淡入切换，严禁 3 人以上同时挤在台上。'

  return {
    system: [
      '你是 Project SEKAI 官方演出的舞台监督与摄影导演（directStaging）。',
      '台词已经定稿；你负责规划幕次转场（Telop/PlaceInfo/SideFade/Flashback/Sekai）、站位移动（Move）、音效（PlaySe）、镜头/震动、虚拟歌手全息与 BGM 静音切停。',
      '只输出一个 JSON 对象，不要改写台词。',
      options.systemPrompt?.trim() ?? ''
    ]
      .filter(Boolean)
      .join('\n'),
    user: `## 本场与大纲
小事件：${plan.event || options.scene}
${formatDirectingAnchorBlock(plan)}
角色（共 ${plan.cast.length} 名）：
${castList}${formatWorldviewCueBlock(options.ragContext)}

${plannedScenes ? `## 一阶段分幕参考\n${plannedScenes}\n` : ''}## 定稿台词（仅引用 lineId）
${lineList}

## 可用背景（时段白天/黄昏/夜晚与情景一致）
${backgrounds || '（无）'}

## 可用 BGM（填 file/id，静音切停写 "silence"）
${bgms || '（无描述 BGM，可留空或用 silence）'}

## 可用官方音效 PlaySe（约每 40 句安排 2~4 次，按动作/环境语义选）
${view.seList(stagingQuery, 32)}

## 舞台与摄影规则
${presenceRule}
- **默认原地淡入淡出**：除非台词明确表现“推门走入/匆忙跑来/转身离开”才在 \`walkInCast\`/\`walkOutCast\` 标出对应角色（配合脚步/门音效），其余所有上下场均使用原地淡入淡出。
- **Move 走位（每 40 句约 4~6 次）**：在靠近倾诉、犹豫后退、拉近距离时用 \`move: { modelId, kind: "stepCloser"|"stepBack"|"shiftSlot", offset: 80~140, moveSpeed: "Normal"|"Fast" }\`。
- **静默反应 / 受惊抖动 / 全息**：
  - 说话后需要角色沉默点头/低头反应时，设 \`closeWindowAfter: true\` + \`silentReaction: { modelId }\`（或下句 \`pauseBefore: 1.0\`）。
  - 突发惊吓可用 \`characterShake: { modelId, axis: "X"|"Y" }\`；大喊/震惊句可用 \`camera: { kind: "shakeWindow" }\` 或 \`shakeScreen\`。
  - 虚拟歌手在现实场景现身或远程通话时，在 \`hologramCast\` 或 \`hologram: { modelId, enabled: true }\` 启用 \`hologram\` 着色器。
- **特效与场景**：可选 \`Telop\`（开场/跳时间小标题）、\`PlaceInfo\`（地点条）、\`SideFade\`（\`transitionIn: "sideFade"\`）、回忆（\`transitionIn: "flashback"\`, \`isFlashback: true\`）、出入 SEKAI（\`sekaiIn\`/\`sekaiOut\`）、天气/氛围粒子（${CURATED_SCENARIO_EFFECTS.join('/')}）。
- **BGM 与停顿节奏**：大部分台词 \`delay: 0\`，只把 1.0/1.5 秒停顿放在关键沉默句的 \`pauseBefore\`。转折前可将幕次 \`bgm\` 或 \`bgmCut\` 设为 \`silence\`（\`bgm00000\` 静音），留白 2~4 句后再接入第二首 BGM。
- **对齐 Stage 1 转折点**：把 BGM 静音切停、1.0/1.5 秒停顿、镜头推近/震动与 Move 峰值优先安排在转折点前后 1~3 句；开场意象句给一个安静的停顿或特写，收尾回扣句不要加大动作。

## 输出 JSON
${JSON.stringify(example, null, 2)}

只输出 JSON 对象本身，不要 markdown 或解释。`
  }
}

function resolveLineIndex(value: unknown, lines: StagedDialogueLine[]): number {
  const text = str(value).trim()
  if (!text) return -1
  const exact = lines.findIndex((l) => l.id === text)
  if (exact >= 0) return exact
  const match = /^l?(\d+)$/i.exec(text)
  if (match) {
    const idx = Number(match[1]) - 1
    if (idx >= 0 && idx < lines.length) return idx
  }
  return -1
}

function resolveCastIds(rawList: unknown, plan: StagedCastPlan, view: CatalogView): number[] {
  const arr = Array.isArray(rawList) ? rawList : []
  const ids: number[] = []
  for (const item of arr) {
    const byPlan = plan.cast.find(
      (c) =>
        c.name === str(item).trim() ||
        c.fullName === str(item).trim() ||
        String(c.modelId) === str(item).trim()
    )
    if (byPlan) {
      if (!ids.includes(byPlan.modelId)) ids.push(byPlan.modelId)
      continue
    }
    const model = resolveModel(view, [], item)
    if (model && plan.cast.some((c) => c.modelId === model.id) && !ids.includes(model.id)) {
      ids.push(model.id)
    }
  }
  return ids.slice(0, 2)
}

function inferSceneStartsFromDialogue(
  plan: StagedCastPlan,
  dialogue: StagedDialogue
): Map<string, number> {
  const map = new Map<string, number>()
  for (let i = 0; i < dialogue.lines.length; i++) {
    const sid = dialogue.lines[i].sceneId
    if (sid && !map.has(sid)) map.set(sid, i)
  }
  const planned = plan.scenes ?? []
  if (planned.length > 1 && map.size <= 1) {
    const step = Math.floor(dialogue.lines.length / planned.length)
    planned.forEach((s, idx) => {
      map.set(s.id, idx === 0 ? 0 : Math.min(dialogue.lines.length - 1, idx * step))
    })
  }
  return map
}

export function fallbackStaging(
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue
): StagedStaging {
  const lines = dialogue.lines
  const scenes: StagedStagingScene[] = []
  const starts = inferSceneStartsFromDialogue(plan, dialogue)
  const plannedScenes =
    plan.scenes && plan.scenes.length > 0
      ? plan.scenes
      : [
          {
            id: 's1',
            summary: plan.event,
            background: plan.background || view.defaultImage(),
            ambient: 'normal' as const,
            transitionIn: 'black' as const,
            activeCast: plan.cast.slice(0, Math.min(2, plan.cast.length)).map((c) => c.name)
          }
        ]

  for (let idx = 0; idx < plannedScenes.length; idx++) {
    const ps = plannedScenes[idx]
    const fromIndex =
      idx === 0
        ? 0
        : (starts.get(ps.id) ??
          Math.min(lines.length - 1, Math.floor((lines.length * idx) / plannedScenes.length)))
    if (idx > 0 && (fromIndex <= scenes[scenes.length - 1].fromIndex || fromIndex >= lines.length))
      continue
    let activeCast =
      plan.cast.length === 2
        ? plan.cast.map((c) => c.modelId)
        : resolveCastIds(ps.activeCast, plan, view)
    if (activeCast.length === 0) {
      activeCast = plan.cast.slice(0, Math.min(2, plan.cast.length)).map((c) => c.modelId)
    }
    const bgDetail = view.canonicalImageEntry(ps.background)
    const ambient =
      bgDetail?.timeOfDay === '白天' && ps.ambient === 'evening' && !ps.isFlashback
        ? 'normal'
        : ps.ambient
    scenes.push({
      id: ps.id,
      fromLineId: lines[fromIndex]?.id ?? 'l1',
      fromIndex,
      background: normalizeBackground(view, ps.background),
      ambient,
      ...(ps.telop ? { telop: ps.telop } : {}),
      ...(ps.placeInfo
        ? { placeInfo: ps.placeInfo }
        : idx === 0 && lines.length >= 12 && bgDetail?.name && bgDetail.name !== bgDetail.file
          ? { placeInfo: bgDetail.name }
          : {}),
      transitionIn: ps.transitionIn,
      ...(ps.isFlashback ? { isFlashback: true } : {}),
      ...(ps.isSekai ? { isSekai: true } : {}),
      activeCast,
      ...(ps.bgm ? { bgm: ps.bgm } : {}),
      ...(ps.scenarioEffect ? { scenarioEffect: ps.scenarioEffect } : {})
    })
  }

  return enrichStagingBaseline({ scenes, events: [] }, view, plan, dialogue)
}

function enrichStagingBaseline(
  staging: StagedStaging,
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue
): StagedStaging {
  const lines = dialogue.lines
  if (lines.length === 0) return staging

  const eventsByLine = new Map<number, StagedStagingEvent>()
  for (const ev of staging.events) {
    eventsByLine.set(ev.lineIndex, ev)
  }

  const ensureEvent = (lineIndex: number): StagedStagingEvent => {
    const existing = eventsByLine.get(lineIndex)
    if (existing) return existing
    const created: StagedStagingEvent = {
      lineId: lines[lineIndex].id,
      lineIndex
    }
    eventsByLine.set(lineIndex, created)
    return created
  }

  // 对话自带的 pauseBefore / closeWindowAfter 合入 events
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.pauseBefore || line.closeWindowAfter) {
      const ev = ensureEvent(i)
      if (line.pauseBefore && !ev.pauseBefore) ev.pauseBefore = line.pauseBefore
      if (line.closeWindowAfter && !ev.closeWindowAfter) ev.closeWindowAfter = true
    }
  }

  // 确保每一幕起手阵容覆盖本幕开场前两名说话人（Normal 模式严格 <=2 人）
  if (plan.cast.length >= 3) {
    for (let sIdx = 0; sIdx < staging.scenes.length; sIdx++) {
      const scene = staging.scenes[sIdx]
      const endIndex =
        sIdx + 1 < staging.scenes.length ? staging.scenes[sIdx + 1].fromIndex - 1 : lines.length - 1
      const speakersInScene: number[] = []
      for (let i = scene.fromIndex; i <= endIndex; i++) {
        const m = plan.cast.find((c) => c.name === lines[i].speaker)
        if (m && !speakersInScene.includes(m.modelId)) speakersInScene.push(m.modelId)
      }
      const merged = scene.activeCast.slice(0, 2)
      for (const sid of speakersInScene.slice(0, 2)) {
        if (!merged.includes(sid) && merged.length < 2) merged.push(sid)
      }
      const sceneSpeakers = new Set(speakersInScene.slice(0, 2))
      for (const sid of speakersInScene.slice(0, 2)) {
        if (merged.includes(sid)) continue
        const replaceIdx = merged.findIndex((id) => !sceneSpeakers.has(id))
        if (replaceIdx >= 0) merged[replaceIdx] = sid
      }
      scene.activeCast = merged.slice(0, 2)
    }
  }

  // 长篇剧本（>=16句）若模型未出 Move / SE，按台词语义轻度补齐（不破坏小测试）
  if (lines.length >= 16) {
    const moveCount = [...eventsByLine.values()].filter((e) => e.move).length
    if (moveCount === 0) {
      const targets = [Math.floor(lines.length * 0.35), Math.floor(lines.length * 0.72)]
      for (const idx of targets) {
        const line = lines[idx]
        const member = plan.cast.find((c) => c.name === line?.speaker)
        if (!member) continue
        const ev = ensureEvent(idx)
        ev.move = {
          modelId: member.modelId,
          kind: idx === targets[0] ? 'stepCloser' : 'stepBack',
          offset: idx === targets[0] ? 90 : 0,
          moveSpeed: 'Normal'
        }
      }
    }

    const seCount = [...eventsByLine.values()].filter((e) => e.se).length
    if (seCount === 0) {
      const seHits: Array<{ idx: number; file: string }> = []
      for (let i = 0; i < lines.length && seHits.length < 3; i++) {
        const text = lines[i].content
        let cue: string | null = null
        if (/手机|消息|通知|短信/.test(text)) cue = 'se00004_b.mp3'
        else if (/开门|推门|进门|进来/.test(text)) cue = 'se00043_b.mp3'
        else if (/乐谱|速写本|笔记本|纸|日程|翻/.test(text)) cue = 'se00122_b.mp3'
        else if (/bell|上课|下课|铃声/.test(text)) cue = 'se00249_b.mp3'
        else if (/Nightcord|上线|通话|麦/.test(text)) cue = 'se00084_b.mp3'
        else if (/拍照|快门/.test(text)) cue = 'se00075_b.mp3'
        if (cue && !seHits.some((h) => Math.abs(h.idx - i) < 6)) {
          seHits.push({ idx: i, file: cue })
        }
      }
      for (const hit of seHits) {
        const ev = ensureEvent(hit.idx)
        ev.se = { file: hit.file, volume: 0.9, timing: 'before' }
      }
    }
  }

  return {
    scenes: staging.scenes,
    events: [...eventsByLine.values()].sort((a, b) => a.lineIndex - b.lineIndex)
  }
}

export function normalizeStaging(
  raw: unknown,
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue
): StagedStaging {
  const doc = unwrapRecord(raw, ['staging', 'storyboard', 'story', 'plan'])
  if (!isRecord(doc)) return fallbackStaging(view, plan, dialogue)

  const lines = dialogue.lines
  if (lines.length === 0) return { scenes: [], events: [] }

  const rawScenes = Array.isArray(doc.scenes) ? doc.scenes : []
  const scenes: StagedStagingScene[] = []
  const usedStarts = new Set<number>()

  for (let i = 0; i < rawScenes.slice(0, 4).length; i++) {
    const item = rawScenes[i]
    if (!isRecord(item)) continue
    const idx = i === 0 ? 0 : resolveLineIndex(item.fromLineId ?? item.from ?? item.lineId, lines)
    if (idx < 0 || usedStarts.has(idx)) continue
    usedStarts.add(idx)
    let activeCast =
      plan.cast.length === 2
        ? plan.cast.map((c) => c.modelId)
        : resolveCastIds(item.activeCast ?? item.cast, plan, view)
    if (activeCast.length === 0) {
      activeCast = plan.cast.slice(0, Math.min(2, plan.cast.length)).map((c) => c.modelId)
    }
    const isFlashback = toBool(item.isFlashback ?? item.flashback)
    const isSekai = toBool(item.isSekai ?? item.sekai)
    let transitionIn = normalizeTransitionKind(item.transitionIn ?? item.transition)
    if (isFlashback && transitionIn === 'black') transitionIn = 'flashback'
    if (isSekai && transitionIn === 'black') transitionIn = 'sekaiIn'
    const bgmRaw = str(item.bgm).trim()
    const bgm =
      bgmRaw.toLowerCase() === 'keep'
        ? 'keep'
        : bgmRaw.toLowerCase() === 'silence' || bgmRaw.toLowerCase() === 'bgm00000'
          ? 'silence'
          : matchBgm(view, bgmRaw)
    const hologramCast = resolveCastIds(item.hologramCast, plan, view)
    const walkInCast = resolveCastIds(item.walkInCast, plan, view)
    const walkOutCast = resolveCastIds(item.walkOutCast, plan, view)
    const effect = normalizeScenarioEffectName(item.scenarioEffect ?? item.effect)

    const bg = normalizeBackground(view, item.background ?? item.image ?? plan.background)
    const bgDetail = view.canonicalImageEntry(bg)
    let ambient = normalizeAmbient(item.ambient ?? item.timeOfDay)
    if (bgDetail?.timeOfDay === '白天' && ambient === 'evening' && !isFlashback) {
      ambient = 'normal'
    }
    scenes.push({
      id: str(item.id).trim() || `s${scenes.length + 1}`,
      fromLineId: lines[idx].id,
      fromIndex: idx,
      background: bg,
      ambient,
      ...(oneLine(item.telop, 40) ? { telop: oneLine(item.telop, 40) } : {}),
      ...(oneLine(item.placeInfo ?? item.place, 40)
        ? { placeInfo: oneLine(item.placeInfo ?? item.place, 40) }
        : {}),
      transitionIn,
      ...(isFlashback ? { isFlashback: true } : {}),
      ...(isSekai ? { isSekai: true } : {}),
      activeCast,
      ...(hologramCast.length > 0 ? { hologramCast } : {}),
      ...(walkInCast.length > 0 ? { walkInCast } : {}),
      ...(walkOutCast.length > 0 ? { walkOutCast } : {}),
      ...(bgm ? { bgm } : {}),
      ...(effect ? { scenarioEffect: effect } : {})
    })
  }
  scenes.sort((a, b) => a.fromIndex - b.fromIndex)
  if (scenes.length === 0 || scenes[0].fromIndex !== 0) {
    const fb = fallbackStaging(view, plan, dialogue)
    if (scenes.length === 0) return fb
    scenes.unshift(fb.scenes[0])
  }

  const rawEvents = Array.isArray(doc.events) ? doc.events : []
  const events: StagedStagingEvent[] = []
  for (const item of rawEvents) {
    if (!isRecord(item)) continue
    const idx = resolveLineIndex(item.lineId ?? item.id ?? item.line, lines)
    if (idx < 0) continue

    const ev: StagedStagingEvent = {
      lineId: lines[idx].id,
      lineIndex: idx
    }

    const pauseRaw = num(item.pauseBefore, 0)
    if (pauseRaw >= 0.4) {
      ev.pauseBefore = pauseRaw >= 1.25 ? 1.5 : pauseRaw >= 0.75 ? 1.0 : 0.5
    }
    if (toBool(item.closeWindowAfter)) ev.closeWindowAfter = true

    if (isRecord(item.silentReaction)) {
      const m = resolveModel(view, [], item.silentReaction.modelId ?? item.silentReaction.speaker)
      if (m && plan.cast.some((c) => c.modelId === m.id)) {
        const motion =
          view.canonicalAnimation(m.id, 'motion', item.silentReaction.motion) ?? undefined
        const facial =
          view.canonicalAnimation(m.id, 'facial', item.silentReaction.facial) ?? undefined
        ev.silentReaction = {
          modelId: m.id,
          ...(motion ? { motion } : {}),
          ...(facial ? { facial } : {})
        }
        ev.closeWindowAfter = true
      }
    }

    if (isRecord(item.move)) {
      const m = resolveModel(view, [], item.move.modelId ?? item.move.speaker ?? lines[idx].speaker)
      if (m && plan.cast.some((c) => c.modelId === m.id)) {
        const rawKind = str(item.move.kind, 'stepCloser')
        const kind =
          rawKind === 'stepBack' ? 'stepBack' : rawKind === 'shiftSlot' ? 'shiftSlot' : 'stepCloser'
        const rawSpeed = str(item.move.moveSpeed, 'Normal')
        const moveSpeed = rawSpeed === 'Fast' ? 'Fast' : rawSpeed === 'Slow' ? 'Slow' : 'Normal'
        const offset = Math.max(
          -200,
          Math.min(200, num(item.move.offset, kind === 'stepBack' ? 0 : 90))
        )
        const toSideRaw = str(item.move.toSide)
        const toSide =
          toSideRaw === 'Left' || toSideRaw === 'Center' || toSideRaw === 'Right'
            ? toSideRaw
            : undefined
        const moveMotion = view.canonicalAnimation(m.id, 'motion', item.move.motion) ?? undefined
        const moveFacial = view.canonicalAnimation(m.id, 'facial', item.move.facial) ?? undefined
        ev.move = {
          modelId: m.id,
          kind,
          offset,
          moveSpeed,
          ...(toSide ? { toSide } : {}),
          ...(moveMotion ? { motion: moveMotion } : {}),
          ...(moveFacial ? { facial: moveFacial } : {})
        }
      }
    }

    if (isRecord(item.characterShake)) {
      const m = resolveModel(view, [], item.characterShake.modelId ?? item.characterShake.speaker)
      if (m && plan.cast.some((c) => c.modelId === m.id)) {
        ev.characterShake = {
          modelId: m.id,
          axis: str(item.characterShake.axis).toUpperCase() === 'Y' ? 'Y' : 'X'
        }
      }
    }

    if (isRecord(item.hologram)) {
      const m = resolveModel(view, [], item.hologram.modelId ?? item.hologram.speaker)
      if (m && plan.cast.some((c) => c.modelId === m.id)) {
        ev.hologram = { modelId: m.id, enabled: toBool(item.hologram.enabled) }
      }
    }

    if (isRecord(item.camera)) {
      const k = str(item.camera.kind)
      if (['zoomIn', 'zoomReset', 'pan', 'shakeWindow', 'shakeScreen'].includes(k)) {
        ev.camera = {
          kind: k as StagedCameraCue['kind'],
          ...(item.camera.x !== undefined ? { x: num(item.camera.x, 0) } : {}),
          ...(item.camera.y !== undefined ? { y: num(item.camera.y, 0) } : {}),
          ...(item.camera.scale !== undefined
            ? { scale: Math.min(2, Math.max(0.8, num(item.camera.scale, 1.1))) }
            : {}),
          ...(item.camera.durationMs !== undefined
            ? { durationMs: Math.min(2000, Math.max(100, num(item.camera.durationMs, 450))) }
            : {})
        }
      }
    }

    if (isRecord(item.se) || typeof item.se === 'string') {
      const rawSe = isRecord(item.se) ? (item.se.file ?? item.se.cue ?? item.se.id) : item.se
      const file = view.canonicalSe?.(rawSe) ?? resolveScenarioSe(str(rawSe))?.file ?? null
      if (file) {
        ev.se = {
          file,
          volume: isRecord(item.se) ? Math.min(2, Math.max(0.2, num(item.se.volume, 0.9))) : 0.9,
          timing: isRecord(item.se) && item.se.timing === 'during' ? 'during' : 'before',
          ...(isRecord(item.se) && item.se.delay !== undefined
            ? { delay: Math.max(0, num(item.se.delay, 0)) }
            : {})
        }
      }
    }

    if (isRecord(item.bgmCut)) {
      const action = str(item.bgmCut.action).toLowerCase() === 'stop' ? 'stop' : 'play'
      if (action === 'stop') {
        ev.bgmCut = {
          action: 'stop',
          fadeMs: Math.min(3000, Math.max(100, num(item.bgmCut.fadeMs, 600)))
        }
      } else {
        const bgmFile = matchBgm(view, item.bgmCut.file)
        if (bgmFile && bgmFile !== 'silence') {
          ev.bgmCut = {
            action: 'play',
            file: bgmFile,
            fadeMs: Math.min(3000, Math.max(100, num(item.bgmCut.fadeMs, 800)))
          }
        }
      }
    }

    if (plan.cast.length >= 3 && isRecord(item.stageGroup)) {
      const activeCast = resolveCastIds(
        item.stageGroup.activeCast ?? item.stageGroup.cast,
        plan,
        view
      )
      if (activeCast.length > 0) {
        const walkIn = resolveCastIds(item.stageGroup.walkIn, plan, view)
        const walkOut = resolveCastIds(item.stageGroup.walkOut, plan, view)
        ev.stageGroup = {
          activeCast,
          ...(walkIn.length > 0 ? { walkIn } : {}),
          ...(walkOut.length > 0 ? { walkOut } : {})
        }
      }
    }

    if (
      ev.pauseBefore ||
      ev.closeWindowAfter ||
      ev.silentReaction ||
      ev.move ||
      ev.characterShake ||
      ev.hologram ||
      ev.camera ||
      ev.se ||
      ev.bgmCut ||
      ev.stageGroup
    ) {
      events.push(ev)
    }
  }

  return enrichStagingBaseline({ scenes, events }, view, plan, dialogue)
}

// ---------------------------------------------------------------------------
// 第四段：细腻动作与表情导演（directActing / buildDirectionPrompt）
// ---------------------------------------------------------------------------

export function buildDirectionPrompt(
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  options: StagedPromptOptions,
  staging?: StagedStaging
): StagedMessages {
  const castLines = plan.cast
    .map(
      (member) =>
        `- ${member.name}（modelId=${member.modelId}）${member.role ? ` — ${member.role}` : ''}`
    )
    .join('\n')

  const sceneForLine = (idx: number): StagedStagingScene | null => {
    if (!staging || staging.scenes.length === 0) return null
    let current = staging.scenes[0]
    for (const s of staging.scenes) {
      if (idx >= s.fromIndex) current = s
    }
    return current
  }

  const appearedBefore = new Set<string>()
  const dialogueLines = dialogue.lines
    .map((line, idx) => {
      const scene = sceneForLine(idx)
      const isEntry = !appearedBefore.has(line.speaker)
      appearedBefore.add(line.speaker)
      const ctxTags = [
        line.emotion ? `〔${line.emotion}〕` : '',
        line.ttsCaption ? `[声演:${line.ttsCaption}]` : '',
        line.ttsSpecialScene ? '[高潮]' : '',
        scene
          ? `[${scene.id}${scene.isFlashback ? '/回忆' : ''}${scene.ambient !== 'normal' ? `/${scene.ambient}` : ''}]`
          : '',
        isEntry ? '[刚入场首句]' : ''
      ]
        .filter(Boolean)
        .join('')
      return `- ${line.id} ${line.speaker}${ctxTags}：${line.content.replace(/\n/g, ' / ')}`
    })
    .join('\n')

  const hasEmotionTags = dialogue.lines.some((line) => line.emotion)

  const motionLines = plan.cast
    .map((member) => {
      const model = view.modelById(member.modelId)
      const names = model ? view.promptMotions(model) : []
      return `${member.name}(${member.modelId})：${names.length ? names.join('，') : '（无）'}`
    })
    .join('\n')

  const facialLines = plan.cast
    .map((member) => {
      const model = view.modelById(member.modelId)
      const names = model ? view.promptFacials(model) : []
      return `${member.name}(${member.modelId})：${names.length ? names.join('，') : '（无）'}`
    })
    .join('\n')

  const directionQuery = `${options.scene} ${plan.event} ${plan.cast.map((c) => c.name).join(' ')}`
  const backgrounds = view
    .imagePromptChoices(50, directionQuery)
    .map((detail) => formatImagePromptLine(detail))
    .join('\n')

  const bgmChoices = view
    .bgmPromptChoices(30, directionQuery)
    .map((detail) => formatBgmPromptLine(detail))
    .join('\n')

  const first = plan.cast[0]
  const second = plan.cast[1]
  const firstModel = view.modelById(first.modelId)
  const secondModel = second ? view.modelById(second.modelId) : null
  const firstMotion = firstModel ? view.exampleMotion(firstModel.id) : ''
  const firstFacial = firstModel ? view.exampleFacial(firstModel.id) : ''
  const bgmChoicesList = view.bgmPromptChoices(30)
  const firstBgm = bgmChoicesList[0]?.file ?? ''
  const secondBgmChoice = bgmChoicesList.find((choice) => choice.file !== firstBgm)?.file ?? ''
  const bgmTurnLine = dialogue.lines[Math.min(2, dialogue.lines.length - 1)]

  const example = {
    background: plan.background || view.defaultImage() || '背景文件名',
    ambient: 'normal',
    bgm: firstBgm,
    ...(secondBgmChoice && bgmTurnLine ? { bgm2: secondBgmChoice, bgm2From: bgmTurnLine.id } : {}),
    bgmStop: false,
    lines: [
      {
        id: dialogue.lines[0]?.id ?? 'l1',
        ...(firstFacial ? { facial: firstFacial } : {}),
        ...(secondModel
          ? { listener: { modelId: secondModel.id, facial: view.exampleFacial(secondModel.id) } }
          : {})
      },
      ...(dialogue.lines[1]
        ? [
            {
              id: dialogue.lines[1].id,
              ...(firstMotion ? { motion: firstMotion } : {}),
              ...(firstFacial ? { facial: firstFacial } : {})
            }
          ]
        : [])
    ]
  }

  return {
    system: [
      '你是 Project SEKAI 风格视觉小说的精细演技导演（directActing）。',
      '台词、幕次与情绪段已确定；你负责为每句台词设计说话者句首（at=0）动作与表情、听者反应以及静默反应（silentMotion）。',
      '不要改写任何台词，不要增删台词。只输出一个 JSON 对象。',
      options.systemPrompt?.trim() ?? ''
    ]
      .filter(Boolean)
      .join('\n'),
    user: `## 这一场
小事件：${plan.event || options.scene}
${plan.logline ? `一句话：${plan.logline}` : ''}
${formatDirectingAnchorBlock(plan)}
出场角色：
${castLines}${formatWorldviewCueBlock(options.ragContext)}

## 台词稿（逐字，只能引用 id，不能改字）
${dialogueLines}

## 动作/表情关键词（名称由英文语义 + 编号组成；直接输出完整名称）
- 动作：nod 点头 / tilthead 歪头 / shakehead 摇头 / glad 高兴 / sad 难过 / trouble 为难 / shy 害羞 / blushed 脸红 / sigh 叹气 / relief 松口气 / think 思考 / lookaway 移开视线 / angry 生气 / forward 前倾 / fidget 局促 / greeting 打招呼 / smug 得意 / wink 眨眼 / sleep 困倦 / delicious 好吃 / pose 摆姿势 / default 默认站姿
- 表情：face_smile 微笑 / face_sad 难过 / face_angry 生气 / face_surprise 惊讶 / face_shy 害羞 / face_trouble 为难 / face_closeeye 闭眼 / face_cry 哭 / face_serious 认真 / face_sleepy 困 / face_sparkling 闪闪发光 / face_disgust 厌恶 / face_smug 得意 / face_wink 眨眼 / face_shock 震惊 / face_worry 担心 / face_lookaway 移开视线 / face_smallmouth 抿嘴

## 可用动作（必须使用对应角色的完整名称）
${motionLines}

## 可用表情（必须使用对应角色的完整名称）
${facialLines}

${
  staging
    ? `## 背景参考（时段（白天/黄昏/夜晚）已由舞台导演规划，优先选有描述的条目）\n${backgrounds || '（沿用分幕背景）'}`
    : `## 可用背景（1~2 张）\n${backgrounds || '（目录暂未提供背景）'}\n\n## 可用 BGM（可选，最多两首）\n${bgmChoices || '（目录暂未提供带描述的 BGM，bgm 留空）'}`
}

## 表演要求
- **官方单拍节奏（at=0）与动作密度**：
  - 官方 PJSK 剧本中约四分之三的台词在句首（at=0）触发 1 个自然身体动作 + 表情；不要主动拆分人工双拍（at2）。
  - 约 22% 的句子可以完全没有动作（全量官方剧本 22.2%，多数集在 10%~35%）：平稳承接、情绪延续或刚演过动作的过渡句只换表情、只给 listener 或留空都可以，静止是正常的，不必为每句硬补动作。
- **入场去重**：标有 \`[刚入场首句]\` 的台词因为紧接在 LayoutAppear 后，**不要再派发重覆的 body motion**（只写 \`facial\` 或留空即可）。
- **短促反应也要有神态动作**：像「……嗯？」「啊。」「真的吗？」等短反应句**必须保留适合的身体动作与表情**（如轻点头、歪头、惊讶小动作 + facial），绝不因句短剥夺动作！
- **静默反应**：官方全量剧本里，台词之外的独立 Motion 约每 2 句 1 个；本场每 3~5 句安排 1 个 \`silentMotion\`（听者反应、环境小动作或停顿），不要每句都加。
- **听者反应（listener）**：同句听者动作在官方全量剧本里只占约 0.5%，绝大多数句子不给；只有长独白中段或话题转折处才考虑给同台另一位角色 1 个 \`listener\`（表情或轻微动作），防止在场听者长时间静止。**必须从听者自身视角出发**（如认真倾听、担忧、为难、若有所思、温和回应），绝不把说话者的「生气」「害怕」直接复制到挨骂或被倾诉的听者脸上。
- **表情细腻切换与语境贴合**：${
      hasEmotionTags
        ? '〔情绪〕只代表 TTS 语音基调，**严禁把〔平静〕死板锁死在 face_normal_01**！即使在〔平静〕段内，也要根据每句台词的实际语气细腻切换微表情：温和/寒暄/赞同/调侃用 smile / wink / smug；认真/思索/倾听用 serious / closeeye / smallmouth / notice；无奈/窘迫/犹豫用 trouble / lookaway / worry / baffling；只有毫无波澜的平铺陈述才用 normal。开心用 smile / sparkling；伤心用 sad / cry / worry；生气用 angry / serious；惊讶用 surprise / shock；害羞用 shy / blushed。'
        : '随每句台词语气细腻切换表情：温和/寒暄/赞同用 smile / wink / smug；认真/思索用 serious / closeeye / smallmouth；无奈/犹豫用 trouble / lookaway / worry；开心用 smile / sparkling；伤心用 sad / cry / worry；生气用 angry / serious；惊讶用 surprise / shock；害羞用 shy / blushed。'
    }
- 同一角色连续说话时**避免连续重复同一表情**（尤其禁止连续多句挂着 face_normal_01），也避免连续多句重复同一动作；**朝比奈真冬**保持克制内敛的表情与动作。
- 背景的时段（白天/黄昏/夜晚）和室内外要和台词写的时间一致；优先选有描述的条目。

## 输出 JSON
${JSON.stringify(example, null, 2)}

只输出 JSON 对象本身，不要 markdown 或解释。`
  }
}

export function buildDirectionRepairPrompt(
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  options: StagedPromptOptions,
  previous: unknown,
  staging?: StagedStaging
): StagedMessages {
  const base = buildDirectionPrompt(view, plan, dialogue, options, staging)
  const raw = typeof previous === 'string' ? previous : JSON.stringify(previous)
  return {
    system: base.system,
    user: `${base.user}\n\n## 上一轮的问题
上一轮没有给出任何可用的表演设计：lines 必须逐条引用台词稿里的 id，并且至少给出一项
motion、facial 或 listener。动作/表情必须来自对应角色的清单。
上一轮的输出开头如下：
${raw.slice(0, 4000)}

请按上面的格式重写完整 JSON 对象，不要改台词。`
  }
}

function resolveDirectionListener(
  view: CatalogView,
  plan: StagedCastPlan,
  speaker: StagedCastMember,
  value: unknown
): StagedListenerAction | undefined {
  const item = isRecord(value) ? value : { modelId: value }
  const model = resolveModel(
    view,
    [],
    item.modelId ?? item.model ?? item.id ?? item.name ?? item.speaker
  )
  if (!model || model.id === speaker.modelId) return undefined
  if (!plan.cast.some((member) => member.modelId === model.id)) return undefined

  const motion = view.canonicalAnimation(model.id, 'motion', item.motion)
  const facial = view.canonicalAnimation(model.id, 'facial', item.facial)
  if (!motion && !facial) return undefined
  return { modelId: model.id, ...(motion ? { motion } : {}), ...(facial ? { facial } : {}) }
}

interface RawDirectionFields {
  motion?: unknown
  facial?: unknown
  at2?: unknown
  motion2?: unknown
  facial2?: unknown
  listener?: unknown
  beats?: StagedDirectionBeat[]
  silentMotion?: boolean
}

function readDirectionFields(
  item: JsonRecord,
  speaker: StagedCastMember,
  view: CatalogView
): RawDirectionFields {
  const fields: RawDirectionFields = {
    motion: item.motion,
    facial: item.facial,
    at2: item.at2,
    motion2: item.motion2,
    facial2: item.facial2,
    listener: item.listener,
    silentMotion: toBool(item.silentMotion)
  }

  const speakerActions: Array<{ at: number; motion?: string; facial?: string }> = []
  if (Array.isArray(item.actions)) {
    const listenerAction = item.actions.find(
      (action) => isRecord(action) && Number(action.modelId) !== speaker.modelId
    )
    if (!fields.listener && isRecord(listenerAction)) fields.listener = listenerAction

    for (const action of item.actions) {
      if (!isRecord(action) || Number(action.modelId) !== speaker.modelId) continue
      const m = view.canonicalAnimation(speaker.modelId, 'motion', action.motion) ?? undefined
      const f = view.canonicalAnimation(speaker.modelId, 'facial', action.facial) ?? undefined
      if (!m && !f) continue
      speakerActions.push({
        at: Math.max(0, Math.min(1, num(action.at, 0))),
        ...(m ? { motion: m } : {}),
        ...(f ? { facial: f } : {})
      })
    }
  }

  if (speakerActions.length > 0) {
    speakerActions.sort((a, b) => a.at - b.at)
    const first = speakerActions[0]
    fields.motion = fields.motion ?? first.motion
    fields.facial = fields.facial ?? first.facial
    if (speakerActions.length >= 2) {
      const second = speakerActions.find((a) => a.at - first.at >= 0.2)
      if (second) {
        fields.beats = [
          {
            at: 0,
            ...(first.motion ? { motion: first.motion } : {}),
            ...(first.facial ? { facial: first.facial } : {})
          },
          {
            at: Math.min(0.85, Math.max(0.35, second.at)),
            ...(second.motion ? { motion: second.motion } : {}),
            ...(second.facial ? { facial: second.facial } : {})
          }
        ]
      }
    }
  }

  if (!fields.beats && (fields.motion2 !== undefined || fields.facial2 !== undefined)) {
    const m1 = view.canonicalAnimation(speaker.modelId, 'motion', fields.motion) ?? undefined
    const f1 = view.canonicalAnimation(speaker.modelId, 'facial', fields.facial) ?? undefined
    const m2 = view.canonicalAnimation(speaker.modelId, 'motion', fields.motion2) ?? undefined
    const f2 = view.canonicalAnimation(speaker.modelId, 'facial', fields.facial2) ?? undefined
    if ((m1 || f1) && (m2 || f2)) {
      const at2 = Math.min(0.85, Math.max(0.35, num(fields.at2, 0.55)))
      fields.beats = [
        { at: 0, ...(m1 ? { motion: m1 } : {}), ...(f1 ? { facial: f1 } : {}) },
        { at: at2, ...(m2 ? { motion: m2 } : {}), ...(f2 ? { facial: f2 } : {}) }
      ]
    }
  }

  return fields
}

export function normalizeDirection(
  raw: unknown,
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue
): StagedDirection {
  const doc = unwrapRecord(raw, ['direction', 'storyboard', 'story', 'plan'])
  if (!isRecord(doc)) return fallbackDirection(view, plan)
  const body = entriesOf(doc.lines ?? doc.beats)
  const byId = new Map(dialogue.lines.map((line) => [line.id, line]))
  const result = new Map<string, StagedDirectionLine>()

  for (const [index, item] of body.entries()) {
    if (!isRecord(item)) continue
    const id = str(item.id ?? item.lineId ?? item.line) || dialogue.lines[index]?.id || ''
    const line = byId.get(id)
    if (!line) continue
    const speaker = plan.cast.find((member) => member.name === line.speaker)
    if (!speaker) continue

    const fields = readDirectionFields(item, speaker, view)
    let motion = view.canonicalAnimation(speaker.modelId, 'motion', fields.motion)
    let facial = view.canonicalAnimation(speaker.modelId, 'facial', fields.facial)
    const listener = resolveDirectionListener(view, plan, speaker, fields.listener)
    let beats = fields.beats
    // 短台词（<=16字）不要在句中切第二个 body motion，以免刚起的短动作被腰斩（保留第二个表情）
    if (beats && beats.length >= 2 && cleanText(line.content).length <= 16) {
      beats = beats.map((beat, beatIdx) => {
        if (beatIdx === 0 || !beat.motion) return beat
        const { motion: _drop, ...restBeat } = beat
        return restBeat
      })
      beats = beats.filter((beat) => Boolean(beat.motion || beat.facial))
      if (beats.length < 2) {
        motion = motion ?? beats[0]?.motion ?? null
        facial = facial ?? beats[0]?.facial ?? null
        beats = undefined
      }
    }
    if (!motion && !facial && !listener && (!beats || beats.length === 0)) continue
    result.set(id, {
      id,
      ...(motion ? { motion } : {}),
      ...(facial ? { facial } : {}),
      ...(beats && beats.length >= 2 ? { beats } : {}),
      ...(listener ? { listener } : {}),
      ...(fields.silentMotion ? { silentMotion: true } : {})
    })
  }

  const bgm = matchBgm(view, doc.bgm ?? doc.music ?? doc.bgmFile)

  // 听者反应预算：不超过 5%（官方样本同句听者反应约 0.9%），把主要动作留给说话者。
  const maxListeners = Math.floor(dialogue.lines.length * 0.05)
  let listenerCount = 0
  let previousSpeakerForListener = ''
  for (const line of dialogue.lines) {
    const directed = result.get(line.id)
    if (!directed?.listener) {
      previousSpeakerForListener = line.speaker
      continue
    }
    const firstOfRun = previousSpeakerForListener !== line.speaker
    if (
      listenerCount < maxListeners &&
      (firstOfRun || listenerCount < Math.floor(maxListeners * 0.6))
    ) {
      listenerCount += 1
    } else {
      const { listener: _dropped, ...rest } = directed
      result.set(line.id, rest)
    }
    previousSpeakerForListener = line.speaker
  }

  // 动作预算控制：
  // 遵循官方 PJSK ~80% 单拍动作密度；仅统计并裁剪多余的 body motion，绝对保留每句的 facial 表情！
  const maxSpeakerActions = Math.ceil(dialogue.lines.length * 0.9)
  const hasMotionInDirection = (d: StagedDirectionLine | undefined): boolean =>
    Boolean(d?.motion || (d?.beats && d.beats.some((b) => Boolean(b.motion))))
  const speakerLinesWithMotion = dialogue.lines.filter((line) =>
    hasMotionInDirection(result.get(line.id))
  ).length
  if (speakerLinesWithMotion > maxSpeakerActions) {
    const lineIdxById = new Map(dialogue.lines.map((l, idx) => [l.id, idx]))
    const hasMotionOnIndex = (idx: number): boolean => {
      if (idx < 0 || idx >= dialogue.lines.length) return false
      return hasMotionInDirection(result.get(dialogue.lines[idx].id))
    }
    const candidates = dialogue.lines
      .map((line, index) => ({
        line,
        index,
        directed: result.get(line.id)
      }))
      .filter((item) => hasMotionInDirection(item.directed))
      .sort((a, b) => {
        const aCalm = !a.line.emotion || a.line.emotion === '平静' ? 0 : 1
        const bCalm = !b.line.emotion || b.line.emotion === '平静' ? 0 : 1
        if (aCalm !== bCalm) return aCalm - bCalm
        return b.index - a.index
      })
    let remaining = speakerLinesWithMotion
    for (const candidate of candidates) {
      if (remaining <= maxSpeakerActions) break
      const idx = lineIdxById.get(candidate.line.id) ?? candidate.index
      // 不连续两句静态站桩：只有前后两句都有动作时才允许省去中间这句
      if (!hasMotionOnIndex(idx - 1) || !hasMotionOnIndex(idx + 1)) continue
      const directed = result.get(candidate.line.id)
      if (!directed) continue
      const preservedFacial =
        directed.facial ?? directed.beats?.find((b) => Boolean(b.facial))?.facial
      const { motion: _motion, beats: _beats, ...rest } = directed
      if (preservedFacial) rest.facial = preservedFacial
      if (rest.facial || rest.listener || rest.silentMotion) {
        result.set(candidate.line.id, rest)
      } else {
        result.delete(candidate.line.id)
      }
      remaining -= 1
    }
  }

  const ambient = normalizeAmbient(doc.ambient ?? doc.timeOfDay)
  const mainBackground =
    matchBackground(view, doc.background) ||
    normalizeBackground(view, plan.background) ||
    view.defaultImage()
  const secondBackground = matchBackground(view, doc.background2 ?? doc.backgroundAlt)
  const secondFromIndex = dialogue.lines.findIndex(
    (line) => line.id === str(doc.background2From ?? doc.background2FromLine).trim()
  )
  const useSecond =
    Boolean(secondBackground) &&
    secondBackground !== mainBackground &&
    secondFromIndex > 0 &&
    secondFromIndex < dialogue.lines.length - 1

  const secondBgm = matchBgm(view, doc.bgm2 ?? doc.bgmAlt)
  const secondBgmFromIndex = dialogue.lines.findIndex(
    (line) => line.id === str(doc.bgm2From ?? doc.bgm2FromLine).trim()
  )
  const useSecondBgm =
    Boolean(bgm) &&
    Boolean(secondBgm) &&
    secondBgm !== 'silence' &&
    secondBgm !== bgm &&
    secondBgmFromIndex > 0 &&
    secondBgmFromIndex < dialogue.lines.length - 1

  return {
    background: mainBackground,
    ...(useSecond
      ? { background2: secondBackground as string, background2From: secondFromIndex }
      : {}),
    ambient,
    bgm: bgm === 'silence' ? '' : bgm,
    ...(useSecondBgm ? { bgm2: secondBgm as string, bgm2From: secondBgmFromIndex } : {}),
    bgmStop: toBool(doc.bgmStop ?? doc.stopBgm),
    lines: dialogue.lines
      .map((line) => result.get(line.id))
      .filter((line): line is StagedDirectionLine => Boolean(line))
  }
}

export function fallbackDirection(view: CatalogView, plan: StagedCastPlan): StagedDirection {
  return {
    background: plan.background || view.defaultImage(),
    ambient: 'normal',
    bgm: '',
    bgmStop: false,
    lines: []
  }
}

// ---------------------------------------------------------------------------
// 第五段：合并成官方 StoryData（composeStory）
// ---------------------------------------------------------------------------

function activeCast(
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  direction: StagedDirection,
  staging?: StagedStaging
): StagedCastMember[] {
  const listeners = new Set(
    direction.lines
      .map((line) => line.listener?.modelId)
      .filter((id): id is number => typeof id === 'number')
  )
  // 听者动作被预算裁掉后，人仍按分幕 activeCast 留在台上安静倾听；
  // 出场名单以分幕为准，不能因为少了一个 listener 动作就把同台演员从画面里拿掉。
  const staged = new Set<number>()
  for (const scene of staging?.scenes ?? []) {
    for (const id of scene.activeCast) staged.add(id)
  }
  return plan.cast.filter(
    (member) =>
      staged.has(member.modelId) ||
      listeners.has(member.modelId) ||
      dialogue.lines.some((line) => line.speaker === member.name)
  )
}

export interface StagedPresenceSegment {
  from: number
  to: number
  mode: 'solo' | 'duo' | 'trio'
  speaker?: string
  castIds?: number[]
}

/**
 * 舞台在场计划：
 * - 双人戏严格遵守全片两人同场（Left/Right）；
 * - 单人戏保持 Center；
 * - 3~5 人戏在 Normal 模式（<=2 人同框）下按分幕/说话组动态轮换。
 */
export function planPresence(
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  _direction?: StagedDirection,
  staging?: StagedStaging
): StagedPresenceSegment[] {
  if (dialogue.lines.length === 0) return []
  const last = dialogue.lines.length - 1
  if (plan.cast.length === 1) {
    return [
      {
        from: 0,
        to: last,
        mode: 'solo',
        speaker: dialogue.lines[0].speaker,
        castIds: [plan.cast[0].modelId]
      }
    ]
  }
  if (plan.cast.length === 2) {
    return [{ from: 0, to: last, mode: 'duo', castIds: plan.cast.map((c) => c.modelId) }]
  }
  const scenes = staging?.scenes ?? []
  if (scenes.length > 0) {
    return scenes.map((scene, index) => {
      const to =
        index + 1 < scenes.length
          ? Math.max(scene.fromIndex, scenes[index + 1].fromIndex - 1)
          : last
      const castIds = scene.activeCast.slice(0, 2)
      const count = castIds.length
      return {
        from: scene.fromIndex,
        to,
        mode: count === 2 ? 'duo' : 'solo',
        ...(count === 1 ? { speaker: plan.cast.find((c) => c.modelId === castIds[0])?.name } : {}),
        castIds
      }
    })
  }
  const initialIds = plan.cast.slice(0, Math.min(2, plan.cast.length)).map((c) => c.modelId)
  return [
    { from: 0, to: last, mode: initialIds.length === 2 ? 'duo' : 'solo', castIds: initialIds }
  ]
}

/**
 * 把五阶段结果合成为官方 PJSK 规范的 StoryData。
 *
 * 保持全片 Normal 模式（<=2 人同场）、双人全片同场、多人 2 人交叠淡出淡入轮换、
 * 99% 原地淡入淡出、93% delay=0、入场防重叠去重、转场前 closeWindowOnFinish、
 * Move/PlaySe/SideFade/Flashback/Sekai/Hologram 全部精确对齐。
 */
export function composeStory(
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  direction: StagedDirection,
  staging?: StagedStaging
): JsonRecord {
  const effectiveStaging =
    staging && staging.scenes.length > 0 ? staging : fallbackStaging(view, plan, dialogue)
  const cast = activeCast(plan, dialogue, direction, effectiveStaging)
  if (cast.length === 0) throw new Error('台词稿没有可用的出场角色')

  // 如果 direction 指定了 background2 / ambient / bgm2（旧单测或 3 段路径），合并入分幕表
  if (!staging) {
    const s0 = effectiveStaging.scenes[0]
    if (s0) {
      s0.background = normalizeBackground(view, direction.background || s0.background)
      s0.ambient = direction.ambient || s0.ambient
      if (direction.bgm) s0.bgm = direction.bgm
    }
    if (
      direction.background2 &&
      direction.background2From !== undefined &&
      direction.background2From > 0 &&
      effectiveStaging.scenes.length === 1
    ) {
      effectiveStaging.scenes.push({
        id: 's2',
        fromLineId: dialogue.lines[direction.background2From]?.id ?? 'l2',
        fromIndex: direction.background2From,
        background: normalizeBackground(view, direction.background2),
        ambient: direction.ambient || 'normal',
        transitionIn: 'black',
        activeCast: effectiveStaging.scenes[0].activeCast
      })
    }
  }

  const imageMap = new Map<string, number>()
  const images: Array<{ id: number; image: string }> = []
  const registerImage = (file: string): number => {
    const normalized = normalizeBackground(view, file)
    if (!normalized) return 1
    const existing = imageMap.get(normalized)
    if (existing !== undefined) return existing
    const id = images.length + 1
    imageMap.set(normalized, id)
    images.push({ id, image: normalized })
    return id
  }
  for (const scene of effectiveStaging.scenes) {
    registerImage(scene.background)
  }
  if (images.length === 0) registerImage(direction.background || plan.background)

  const models = cast.map((member) => ({
    id: member.modelId,
    model: member.path,
    normal_scale: 2.1,
    small_scale: 1.8,
    anchor: 0.5
  }))

  const snippets: JsonRecord[] = []
  type SideSlot = 'Left' | 'Center' | 'Right'
  interface StageActorState {
    side: SideSlot
    offset: number
    hologram: boolean
    appearedAtLine: number
    appearedWithMotion: boolean
    lastAppearMotion: string
    appearFacial: string
    lastBodyMotion: string
    lastFacial: string
    lastSpeakingFacial: string
    lastSpeakingWasShortWithMotion: boolean
    recentBodyMotions: string[]
    speakingCountSinceAppear: number
    linesSinceLastBodyMotion: number
  }
  const onStage = new Map<number, StageActorState>()
  const trackActorBodyMotion = (st: StageActorState | undefined, motionName: string): void => {
    if (!st || !motionName) return
    st.lastBodyMotion = motionName
    st.linesSinceLastBodyMotion = 0
    if (st.recentBodyMotions.at(-1) !== motionName) {
      st.recentBodyMotions.push(motionName)
      if (st.recentBodyMotions.length > 4) st.recentBodyMotions.shift()
    }
  }
  let layoutMode: 'Normal' | null = null
  let windowOpen = false
  let flashbackActive = false
  let currentEffect = ''
  let currentBgm = ''
  let cameraDirty = false
  let shakeScreenActive = false
  let lastSpeakerId: number | null = null
  let lastSilentReactionLine = -10
  let lastSilentReactionTargetId: number | null = null
  let silentReactionsEmitted = 0
  const directionById = new Map(direction.lines.map((line) => [line.id, line]))

  const closeWindowBeforeBreak = (): void => {
    if (!windowOpen) return
    for (let i = snippets.length - 1; i >= 0; i--) {
      if (snippets[i].type === 'Talk') {
        const d = snippets[i].data as JsonRecord
        d.closeWindowOnFinish = true
        windowOpen = false
        return
      }
      if (snippets[i].type === 'HideTalk') {
        windowOpen = false
        return
      }
    }
    snippets.push({ type: 'HideTalk', wait: true, progressBehavior: 'WaitFinished', delay: 0 })
    windowOpen = false
  }

  const resetCameraIfNeeded = (): void => {
    if (!cameraDirty) return
    snippets.push({
      type: 'CameraZoom',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { scale: 1, duration: 400, ease: 'OutQuad' }
    })
    snippets.push({
      type: 'CameraMove',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { x: 0, y: 0, duration: 400, ease: 'OutQuad' }
    })
    cameraDirty = false
  }

  const stopShakeScreenIfNeeded = (): void => {
    if (!shakeScreenActive) return
    snippets.push({
      type: 'StopShakeScreen',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: {}
    })
    shakeScreenActive = false
  }

  const ensureNormalLayoutMode = (): void => {
    if (layoutMode === 'Normal') return
    snippets.push({
      type: 'ChangeLayoutMode',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { mode: 'Normal' }
    })
    layoutMode = 'Normal'
  }

  const clearActors = (ids: number[], walkOutSet = new Set<number>()): number => {
    const toClear = ids.filter((id) => onStage.has(id))
    if (toClear.length === 0) return 0
    toClear.forEach((id, idx) => {
      const state = onStage.get(id)!
      if (state.hologram) {
        snippets.push({
          type: 'AttachCharacterShader',
          wait: idx === 0,
          progressBehavior: idx === 0 ? 'WaitFinished' : 'Now',
          delay: 0,
          data: { modelId: id, shader: 'none' }
        })
      }
    })
    toClear.forEach((id, idx) => {
      const state = onStage.get(id)!
      const isWalk = walkOutSet.has(id)
      const toSide = isWalk ? (state.side === 'Left' ? 'LeftOver' : 'RightOver') : state.side
      snippets.push({
        type: 'LayoutClear',
        wait: idx === 0,
        progressBehavior: idx === 0 ? 'WaitFinished' : 'Now',
        delay: 0,
        data: {
          modelId: id,
          from: { side: state.side, offset: state.offset },
          to: { side: toSide, offset: isWalk ? 0 : state.offset },
          motion: '',
          facial: '',
          moveSpeed: 'Normal'
        }
      })
      onStage.delete(id)
    })
    return toClear.length
  }

  const appearActors = (
    targetIds: number[],
    lineIndex: number,
    options: {
      walkInSet?: Set<number>
      walkOutSet?: Set<number>
      hologramSet?: Set<number>
      forceReenter?: boolean
      hadPrecedingClear?: boolean
    } = {}
  ): void => {
    const validIds = targetIds.filter((id) => cast.some((c) => c.modelId === id)).slice(0, 2)
    if (validIds.length === 0) return

    const walkInSet = options.walkInSet ?? new Set<number>()
    const walkOutSet = options.walkOutSet ?? new Set<number>()
    const hologramSet = options.hologramSet ?? new Set<number>()

    const sameGroup =
      !options.forceReenter &&
      layoutMode === 'Normal' &&
      validIds.length === onStage.size &&
      validIds.every((id) => onStage.has(id))
    if (sameGroup) return

    // Normal 模式槽位分配：<= 2 人时尽量保留在场角色现有的 Left/Right 槽位，避免无意义闪退重入
    const desiredSlotFor = new Map<number, SideSlot>()
    if (validIds.length === 1) {
      desiredSlotFor.set(validIds[0], 'Center')
    } else {
      const freeSlots: SideSlot[] = ['Left', 'Right']
      if (!options.forceReenter) {
        for (const id of validIds) {
          const existing = onStage.get(id)?.side
          if (existing === 'Left' || existing === 'Right') {
            desiredSlotFor.set(id, existing)
            const idx = freeSlots.indexOf(existing)
            if (idx >= 0) freeSlots.splice(idx, 1)
          }
        }
      }
      for (const id of validIds) {
        if (!desiredSlotFor.has(id)) {
          desiredSlotFor.set(id, freeSlots.shift() ?? 'Right')
        }
      }
    }

    // 单人 Center -> 双人 Left/Right（或相反）时，保留角色直接 Move 到新槽位，避免淡出再淡入
    const outgoing = [...onStage.keys()].filter((id) => !validIds.includes(id))
    const clearedCount = clearActors(outgoing, walkOutSet)
    ensureNormalLayoutMode()

    let movedExisting = false
    for (const id of validIds) {
      const st = onStage.get(id)
      const targetSide = desiredSlotFor.get(id)!
      if (st && st.side !== targetSide) {
        closeWindowBeforeBreak()
        const moveMotion = pickMoveMotion(
          view,
          id,
          st.lastBodyMotion,
          new Set(st.recentBodyMotions)
        )
        const moveFacial = pickMoveFacial(view, id, st.lastFacial || st.appearFacial)
        snippets.push({
          type: 'Move',
          wait: clearedCount === 0 && !movedExisting,
          progressBehavior: clearedCount === 0 && !movedExisting ? 'WaitFinished' : 'Now',
          delay: 0,
          data: {
            modelId: id,
            from: { side: st.side, offset: st.offset },
            to: { side: targetSide, offset: 0 },
            moveSpeed: 'Fast',
            motion: moveMotion,
            facial: moveFacial
          }
        })
        if (moveMotion) trackActorBodyMotion(st, moveMotion)
        if (moveFacial) st.lastFacial = moveFacial
        st.side = targetSide
        st.offset = 0
        movedExisting = true
      }
    }

    const overlapsPreceding = (!options.hadPrecedingClear && clearedCount > 0) || movedExisting
    const lineAtEntry = dialogue.lines[lineIndex]
    const directedAtEntry = lineAtEntry ? directionById.get(lineAtEntry.id) : undefined
    const incoming = validIds.filter((id) => !onStage.has(id))
    const usedEntryMotions = new Set<string>()
    incoming.forEach((id, idx) => {
      const slot = desiredSlotFor.get(id)!
      const isWalk = walkInSet.has(id)
      // 官方 LayoutData 的 Type=2 入场全部 SideFrom==SideTo（Left/Center/Right
      // 槽位原地淡入，没有画外起点）。默认 from 与 to 同槽位（offset 0）；
      // 仅 walkInCast 显式“走入”保留 LeftOver/RightOver 画外起点。
      const fromPos = isWalk
        ? { side: slot === 'Left' ? 'LeftOver' : 'RightOver', offset: 0 }
        : { side: slot, offset: 0 }
      const member = cast.find((c) => c.modelId === id)
      const memberName = member?.name
      const isEntrySpeaker = Boolean(memberName && lineAtEntry?.speaker === memberName)
      const directedMotion =
        isEntrySpeaker && directedAtEntry
          ? (directedAtEntry.beats?.[0]?.motion ?? directedAtEntry.motion)
          : undefined
      const directedFacial =
        isEntrySpeaker && directedAtEntry
          ? (directedAtEntry.beats?.[0]?.facial ?? directedAtEntry.facial)
          : undefined
      let firstFutureTalkMotion = ''
      let firstLineForMember = isEntrySpeaker ? lineAtEntry : undefined
      if (!isEntrySpeaker && memberName) {
        firstLineForMember = dialogue.lines
          .slice(lineIndex + 1, Math.min(dialogue.lines.length, lineIndex + 8))
          .find((l) => l.speaker === memberName)
        const nextDir = firstLineForMember ? directionById.get(firstLineForMember.id) : undefined
        firstFutureTalkMotion = nextDir?.beats?.[0]?.motion ?? nextDir?.motion ?? ''
      }
      const entryMotion =
        directedMotion && !isStandingMotion(directedMotion)
          ? directedMotion
          : pickAppearFallbackMotion(view, id, usedEntryMotions, firstFutureTalkMotion)
      if (entryMotion) usedEntryMotions.add(entryMotion)
      const firstLineIdx = firstLineForMember ? dialogue.lines.indexOf(firstLineForMember) : -1
      const surroundingTense = dialogue.lines
        .slice(Math.max(0, lineIndex - 2), Math.min(dialogue.lines.length, lineIndex + 6))
        .some((l) => TENSE_EMOTION_SET.has(l.emotion ?? ''))
      const entryPrecededByTense =
        firstLineIdx >= 0 ? isPrecededByTenseBeat(dialogue.lines, firstLineIdx) : surroundingTense
      const safeDirectedFacial = shouldAvoidIncongruousSmile(
        directedFacial,
        firstLineForMember ?? { content: '', emotion: '平静' },
        entryPrecededByTense
      )
        ? ''
        : directedFacial
      const entryFacial =
        safeDirectedFacial ||
        (firstLineForMember
          ? pickSpeakerSubtleFacial(view, id, firstLineForMember, undefined, member?.role, {
              precededByTense: entryPrecededByTense
            })
          : '') ||
        (surroundingTense
          ? pickSpeakerSubtleFacial(
              view,
              id,
              { content: '', emotion: '平静' },
              undefined,
              member?.role,
              { precededByTense: true }
            )
          : '') ||
        view.exampleFacial(id) ||
        view.defaultFacial(id)
      const isHolo = hologramSet.has(id)
      const waitFirst = !overlapsPreceding && idx === 0
      snippets.push({
        type: 'LayoutAppear',
        wait: waitFirst,
        progressBehavior: waitFirst ? 'WaitFinished' : 'Now',
        delay: 0,
        data: {
          modelId: id,
          from: fromPos,
          to: { side: slot, offset: 0 },
          motion: entryMotion,
          facial: entryFacial,
          facialFirst: true,
          moveSpeed: 'Normal',
          hologram: isHolo
        }
      })
      if (isHolo) {
        snippets.push({
          type: 'AttachCharacterShader',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { modelId: id, shader: 'hologram' }
        })
      }
      onStage.set(id, {
        side: slot,
        offset: 0,
        hologram: isHolo,
        appearedAtLine: lineIndex,
        appearedWithMotion: Boolean(entryMotion),
        lastAppearMotion: entryMotion,
        appearFacial: entryFacial,
        lastBodyMotion: entryMotion,
        lastFacial: entryFacial,
        lastSpeakingFacial: '',
        lastSpeakingWasShortWithMotion: false,
        recentBodyMotions: entryMotion ? [entryMotion] : [],
        speakingCountSinceAppear: 0,
        linesSinceLastBodyMotion: 0
      })
    })
  }

  const applyBgmDirective = (bgmDirective: string | undefined, fadeMs = 700): void => {
    if (!bgmDirective || bgmDirective === 'keep') return
    if (bgmDirective === 'silence') {
      if (currentBgm) {
        snippets.push({
          type: 'ChangeBgm',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { file: '', stop: true, fadeMs }
        })
        currentBgm = ''
      }
      return
    }
    if (bgmDirective !== currentBgm) {
      snippets.push({
        type: 'ChangeBgm',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: { file: bgmDirective, stop: false, fadeMs }
      })
      currentBgm = bgmDirective
    }
  }

  // ---- 开场首幕 -------------------------------------------------------------------------------------------
  const scene0 = effectiveStaging.scenes[0]
  if (scene0) {
    applyBgmDirective(scene0.bgm || direction.bgm, 600)
    ensureNormalLayoutMode()
    const bgId = registerImage(scene0.background)
    snippets.push({
      type: 'BlackOut',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { duration: 0, color: 'black' }
    })
    snippets.push({
      type: 'ChangeBackgroundImage',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { imageId: bgId }
    })
    if (scene0.ambient !== 'normal') {
      snippets.push({
        type: 'AmbientColor',
        wait: false,
        progressBehavior: 'Now',
        delay: 0,
        data: { mode: scene0.ambient }
      })
    }
    snippets.push({
      type: 'BlackIn',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { duration: 600, color: 'black' }
    })
    if (scene0.telop) {
      snippets.push({
        type: 'Telop',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: { content: scene0.telop }
      })
    }
    if (scene0.placeInfo) {
      snippets.push({
        type: 'PlaceInfo',
        wait: false,
        progressBehavior: 'Now',
        delay: 0,
        data: { text: scene0.placeInfo }
      })
    }
    if (scene0.scenarioEffect) {
      snippets.push({
        type: 'PlayScenarioEffect',
        wait: false,
        progressBehavior: 'Now',
        delay: 0,
        data: { effectName: scene0.scenarioEffect }
      })
      currentEffect = scene0.scenarioEffect
    }
    appearActors(scene0.activeCast, 0, {
      walkInSet: new Set(scene0.walkInCast ?? []),
      hologramSet: new Set(scene0.hologramCast ?? [])
    })
  }

  // ---- 逐句编译分幕转场、走位事件、音效与表演 ----------------------------------------------------------------
  const sceneByStart = new Map(effectiveStaging.scenes.slice(1).map((s) => [s.fromIndex, s]))
  const eventByIndex = new Map(effectiveStaging.events.map((e) => [e.lineIndex, e]))

  for (let index = 0; index < dialogue.lines.length; index++) {
    const nextScene = sceneByStart.get(index)
    if (nextScene) {
      closeWindowBeforeBreak()
      stopShakeScreenIfNeeded()
      resetCameraIfNeeded()
      if (currentEffect) {
        snippets.push({
          type: 'StopScenarioEffect',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { effectName: currentEffect }
        })
        currentEffect = ''
      }
      applyBgmDirective(nextScene.bgm, 900)

      const bgId = registerImage(nextScene.background)
      const enteringFlashback = Boolean(nextScene.isFlashback) && !flashbackActive
      const leavingFlashback = !nextScene.isFlashback && flashbackActive
      const tKind = nextScene.transitionIn
      const closeFlashbackBehindCurtain = (): void => {
        if (!leavingFlashback) return
        snippets.push({
          type: 'FlashbackOut',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { duration: 100 }
        })
        flashbackActive = false
      }

      if (
        tKind === 'flashback' ||
        enteringFlashback ||
        (leavingFlashback && (tKind === 'black' || tKind === 'white'))
      ) {
        snippets.push({
          type: 'BlackOut',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { duration: 300, color: 'white' }
        })
        if (enteringFlashback) {
          snippets.push({
            type: 'PlaySe',
            wait: true,
            progressBehavior: 'WaitFinished',
            delay: 0,
            data: { file: 'se00053_b.mp3', volume: 0.9, loop: false, fadeMs: 0 }
          })
        }
        clearActors([...onStage.keys()], new Set(nextScene.walkOutCast ?? []))
        if (enteringFlashback) {
          snippets.push({
            type: 'FlashbackIn',
            wait: true,
            progressBehavior: 'WaitFinished',
            delay: 0,
            data: { duration: 100, alpha: 0.3 }
          })
          flashbackActive = true
        } else {
          closeFlashbackBehindCurtain()
        }
        snippets.push({
          type: 'ChangeBackgroundImage',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { imageId: bgId }
        })
        snippets.push({
          type: 'AmbientColor',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { mode: nextScene.ambient }
        })
        appearActors(nextScene.activeCast, index, {
          walkInSet: new Set(nextScene.walkInCast ?? []),
          hologramSet: new Set(nextScene.hologramCast ?? []),
          forceReenter: true,
          hadPrecedingClear: true
        })
        snippets.push({
          type: 'BlackIn',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { duration: 400, color: 'white' }
        })
      } else if (tKind === 'sekaiIn' || tKind === 'sekaiOut') {
        snippets.push({
          type: 'SekaiOut',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { duration: 500, variant: 'v2' }
        })
        clearActors([...onStage.keys()], new Set(nextScene.walkOutCast ?? []))
        closeFlashbackBehindCurtain()
        snippets.push({
          type: 'ChangeBackgroundImage',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { imageId: bgId }
        })
        snippets.push({
          type: 'AmbientColor',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { mode: nextScene.ambient }
        })
        appearActors(nextScene.activeCast, index, {
          walkInSet: new Set(nextScene.walkInCast ?? []),
          hologramSet: new Set(nextScene.hologramCast ?? []),
          forceReenter: true,
          hadPrecedingClear: true
        })
        snippets.push({
          type: 'SekaiIn',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { duration: 500, variant: 'v2' }
        })
      } else if (tKind === 'sideFade') {
        snippets.push({
          type: 'SideFade',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { direction: 'Left', edge: 'left', mode: 'Out', duration: 450 }
        })
        clearActors([...onStage.keys()], new Set(nextScene.walkOutCast ?? []))
        closeFlashbackBehindCurtain()
        snippets.push({
          type: 'ChangeBackgroundImage',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { imageId: bgId }
        })
        snippets.push({
          type: 'AmbientColor',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { mode: nextScene.ambient }
        })
        appearActors(nextScene.activeCast, index, {
          walkInSet: new Set(nextScene.walkInCast ?? []),
          hologramSet: new Set(nextScene.hologramCast ?? []),
          forceReenter: true,
          hadPrecedingClear: true
        })
        snippets.push({
          type: 'SideFade',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { direction: 'Right', edge: 'right', mode: 'In', duration: 450 }
        })
      } else {
        const fadeColor = tKind === 'white' ? 'white' : 'black'
        snippets.push({
          type: 'BlackOut',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { duration: 400, color: fadeColor }
        })
        clearActors([...onStage.keys()], new Set(nextScene.walkOutCast ?? []))
        snippets.push({
          type: 'ChangeBackgroundImage',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { imageId: bgId }
        })
        snippets.push({
          type: 'AmbientColor',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { mode: nextScene.ambient }
        })
        appearActors(nextScene.activeCast, index, {
          walkInSet: new Set(nextScene.walkInCast ?? []),
          hologramSet: new Set(nextScene.hologramCast ?? []),
          forceReenter: true,
          hadPrecedingClear: true
        })
        snippets.push({
          type: 'BlackIn',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { duration: 450, color: fadeColor }
        })
      }

      if (nextScene.telop) {
        snippets.push({
          type: 'Telop',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { content: nextScene.telop }
        })
      }
      if (nextScene.placeInfo) {
        snippets.push({
          type: 'PlaceInfo',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { text: nextScene.placeInfo }
        })
      }
      if (nextScene.scenarioEffect) {
        snippets.push({
          type: 'PlayScenarioEffect',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { effectName: nextScene.scenarioEffect }
        })
        currentEffect = nextScene.scenarioEffect
      }
    }

    // 兼容旧 direction.bgm2 写法（当没有 staging 分幕 BGM 时）
    if (!staging && direction.bgm2 && direction.bgm2From === index) {
      applyBgmDirective(direction.bgm2, 1200)
    }

    const line = dialogue.lines[index]
    const member = cast.find((entry) => entry.name === line.speaker)
    if (!member) continue
    const ev = eventByIndex.get(index)

    // 多人戏若本句说话人尚未在场，安全入场或以 Normal 模式（<=2 人）交叠淡出淡入轮换
    if (ev?.stageGroup && plan.cast.length >= 3) {
      const targetGroup = ev.stageGroup.activeCast.includes(member.modelId)
        ? ev.stageGroup.activeCast.slice(0, 2)
        : [member.modelId, ...ev.stageGroup.activeCast.slice(0, 1)]
      appearActors(targetGroup, index, {
        walkInSet: new Set(ev.stageGroup.walkIn ?? []),
        walkOutSet: new Set(ev.stageGroup.walkOut ?? [])
      })
    } else if (!onStage.has(member.modelId)) {
      if (plan.cast.length >= 3) {
        const currentIds = [...onStage.keys()]
        const keepId =
          lastSpeakerId !== null && currentIds.includes(lastSpeakerId)
            ? lastSpeakerId
            : currentIds[currentIds.length - 1]
        const nextIds =
          currentIds.length < 2 ? [...currentIds, member.modelId] : [keepId, member.modelId]
        appearActors(nextIds, index)
      } else {
        appearActors(
          cast.map((c) => c.modelId),
          index
        )
      }
    }

    if (ev?.bgmCut) {
      if (ev.bgmCut.action === 'stop') applyBgmDirective('silence', ev.bgmCut.fadeMs ?? 600)
      else if (ev.bgmCut.file) applyBgmDirective(ev.bgmCut.file, ev.bgmCut.fadeMs ?? 800)
    }

    if (ev?.se && ev.se.timing !== 'during') {
      snippets.push({
        type: 'PlaySe',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: ev.se.delay ?? 0,
        data: { file: ev.se.file, volume: ev.se.volume ?? 0.9, loop: false, fadeMs: 0 }
      })
    }

    if (ev?.hologram && onStage.has(ev.hologram.modelId)) {
      const st = onStage.get(ev.hologram.modelId)!
      st.hologram = ev.hologram.enabled
      snippets.push({
        type: 'AttachCharacterShader',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: { modelId: ev.hologram.modelId, shader: ev.hologram.enabled ? 'hologram' : 'none' }
      })
    }

    if (ev?.move && onStage.has(ev.move.modelId)) {
      const st = onStage.get(ev.move.modelId)!
      let targetSide = st.side
      if (ev.move.kind === 'shiftSlot' && ev.move.toSide) {
        const occupied = [...onStage.entries()].some(
          ([otherId, pos]) =>
            otherId !== ev.move!.modelId &&
            (pos.side === ev.move!.toSide ||
              (layoutMode === 'Normal' && (pos.side === 'Center' || ev.move!.toSide === 'Center')))
        )
        if (!occupied) targetSide = ev.move.toSide
      }
      const nextOffset =
        ev.move.kind === 'stepBack'
          ? 0
          : (ev.move.offset ?? (st.side === 'Left' ? 90 : st.side === 'Right' ? -90 : 0))
      if (targetSide !== st.side || nextOffset !== st.offset) {
        closeWindowBeforeBreak()
        const lineDir = directionById.get(line.id)
        const avoidTalkMotion = lineDir?.beats?.[0]?.motion ?? lineDir?.motion
        // Move 紧跟同一条台词的 Talk；谈台词的动作会在 Move 结束后立刻接管同一通道，
        // 若 Move 也配 body motion，后者只能播 ~330ms 就被打断（实测 nod02 350ms）。
        // 位移本身已经提供表演感，这里只保留 facial。
        const moveMotion = avoidTalkMotion
          ? undefined
          : ev.move.motion ||
            pickMoveMotion(view, ev.move.modelId, undefined, new Set(st.recentBodyMotions))
        const moveFacial =
          ev.move.facial || pickMoveFacial(view, ev.move.modelId, st.lastFacial || st.appearFacial)
        snippets.push({
          type: 'Move',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: {
            modelId: ev.move.modelId,
            from: { side: st.side, offset: st.offset },
            to: { side: targetSide, offset: nextOffset },
            moveSpeed: ev.move.moveSpeed ?? 'Normal',
            motion: moveMotion,
            facial: moveFacial
          }
        })
        if (moveMotion) trackActorBodyMotion(st, moveMotion)
        if (moveFacial) st.lastFacial = moveFacial
        st.side = targetSide
        st.offset = nextOffset
      }
    }

    if (ev?.characterShake && onStage.has(ev.characterShake.modelId)) {
      snippets.push({
        type: 'CharacterShake',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: { modelId: ev.characterShake.modelId, axis: ev.characterShake.axis }
      })
    }

    if (ev?.camera?.kind === 'zoomReset') {
      resetCameraIfNeeded()
    }

    // ---- Talk 动作与入场去重 --------------------------------------------------------------------------------
    const directed = directionById.get(line.id)
    const actorState = onStage.get(member.modelId)
    const talkDelay = ev?.pauseBefore ?? line.pauseBefore ?? 0
    const justAppeared =
      Boolean(actorState?.appearedWithMotion) &&
      actorState!.speakingCountSinceAppear === 0 &&
      (ev?.pauseBefore ?? 0) === 0 &&
      index === actorState!.appearedAtLine

    const dedupeFirstSpeakMotion = (rawMotion: string | undefined): string | undefined => {
      if (!rawMotion) return undefined
      if (
        actorState &&
        actorState.speakingCountSinceAppear === 0 &&
        actorState.lastAppearMotion &&
        rawMotion === actorState.lastAppearMotion
      ) {
        const swapped = pickFollowupMotion(
          view,
          member.modelId,
          actorState.lastAppearMotion,
          new Set(actorState.recentBodyMotions)
        )
        return swapped || rawMotion
      }
      return rawMotion
    }

    const justHadStandaloneMotion =
      lastSilentReactionTargetId === member.modelId &&
      index === lastSilentReactionLine + 1 &&
      talkDelay < 0.8
    const justHadShortClipMotion =
      lastSpeakerId === member.modelId &&
      Boolean(actorState?.lastSpeakingWasShortWithMotion) &&
      talkDelay < 0.8
    const skipImmediateBodyMotion =
      justAppeared || justHadStandaloneMotion || justHadShortClipMotion

    const actions: JsonRecord[] = []
    if (directed?.beats && directed.beats.length > 0) {
      for (const beat of directed.beats) {
        const skipMotion = skipImmediateBodyMotion && beat.at < 0.35
        const motion = skipMotion ? undefined : dedupeFirstSpeakMotion(beat.motion)
        const facial = beat.facial
        if (!motion && !facial) continue
        actions.push({
          at: beat.at,
          modelId: member.modelId,
          ...(motion ? { motion } : {}),
          ...(facial ? { facial } : {})
        })
      }
    } else if (directed?.motion || directed?.facial) {
      const motion = skipImmediateBodyMotion ? undefined : dedupeFirstSpeakMotion(directed.motion)
      const facial = directed.facial
      if (motion || facial) {
        actions.push({
          at: 0,
          modelId: member.modelId,
          ...(motion ? { motion } : {}),
          ...(facial ? { facial } : {})
        })
      }
    }

    // 防止说话人连续多句卡死在 face_normal_01，或紧张/沉默拍误配 smile
    const precededByTense = isPrecededByTenseBeat(dialogue.lines, index)
    if (actorState) {
      const speakerZeroAct = actions.find((a) => a.modelId === member.modelId && a.at === 0)
      const currentSpeakerFacial =
        typeof speakerZeroAct?.facial === 'string' ? speakerZeroAct.facial : undefined
      const allowStaleCheck = dialogue.lines.length >= 6 && direction.lines.length > 0
      const stuckOnNormal =
        allowStaleCheck &&
        Boolean(currentSpeakerFacial && /^face_normal/i.test(currentSpeakerFacial)) &&
        /^face_normal/i.test(actorState.lastSpeakingFacial || actorState.lastFacial)
      const incongruousSmile = shouldAvoidIncongruousSmile(
        currentSpeakerFacial,
        line,
        precededByTense
      )
      if (stuckOnNormal || incongruousSmile) {
        const varied = pickSpeakerSubtleFacial(
          view,
          member.modelId,
          line,
          actorState.lastSpeakingFacial || actorState.lastFacial,
          member.role,
          { precededByTense }
        )
        if (varied && varied !== currentSpeakerFacial) {
          if (speakerZeroAct) {
            speakerZeroAct.facial = varied
          } else {
            actions.unshift({ at: 0, modelId: member.modelId, facial: varied })
          }
        }
      }
    }

    if (
      directed?.listener &&
      directed.listener.modelId !== member.modelId &&
      onStage.has(directed.listener.modelId)
    ) {
      const listenerState = onStage.get(directed.listener.modelId)
      const listenerJustAppeared =
        Boolean(listenerState?.appearedWithMotion) &&
        index === (listenerState?.appearedAtLine ?? -99) &&
        (ev?.pauseBefore ?? 0) === 0
      const listenerJustHadStandalone =
        lastSilentReactionTargetId === directed.listener.modelId &&
        index === lastSilentReactionLine + 1 &&
        talkDelay < 0.8
      const listenerMotion =
        listenerJustAppeared || listenerJustHadStandalone ? undefined : directed.listener.motion
      const listenerPrecededByTense = precededByTense || TENSE_EMOTION_SET.has(line.emotion ?? '')
      const listenerFacialRaw = directed.listener.facial
      const listenerFacial = shouldAvoidIncongruousSmile(
        listenerFacialRaw,
        line,
        listenerPrecededByTense
      )
        ? pickListenerReactionFacial(
            view,
            directed.listener.modelId,
            line,
            cast.find((c) => c.modelId === directed.listener!.modelId)?.role,
            listenerState?.lastFacial,
            { precededByTense: listenerPrecededByTense }
          )
        : listenerFacialRaw
      if (listenerMotion || listenerFacial) {
        actions.push({
          at: 0,
          modelId: directed.listener.modelId,
          ...(listenerMotion ? { motion: listenerMotion } : {}),
          ...(listenerFacial ? { facial: listenerFacial } : {})
        })
      }
    }

    if (actorState) {
      actorState.speakingCountSinceAppear += 1
      actorState.appearedWithMotion = false
    }

    const nextLine = index + 1 < dialogue.lines.length ? dialogue.lines[index + 1] : undefined
    const nextSpeakerId = nextLine
      ? (cast.find((c) => c.name === nextLine.speaker)?.modelId ?? null)
      : null
    const nextEvent = index + 1 < dialogue.lines.length ? eventByIndex.get(index + 1) : undefined
    const nextTalkPause = nextEvent?.pauseBefore ?? nextLine?.pauseBefore ?? 0

    const explicitSilentReaction = Boolean(ev?.silentReaction || directed?.silentMotion)
    let autoSilentTargetId: number | null = null
    if (
      !explicitSilentReaction &&
      dialogue.lines.length >= 16 &&
      direction.lines.length > 0 &&
      index >= 1 &&
      index < dialogue.lines.length - 1 &&
      !ev?.move &&
      index - lastSilentReactionLine >= 4 &&
      silentReactionsEmitted < Math.max(3, Math.round(dialogue.lines.length * 0.2))
    ) {
      const turnBoundary = nextLine && nextLine.speaker !== line.speaker
      const pauseOrEllipsis =
        /……|——/.test(line.content) || Boolean(ev?.closeWindowAfter || line.closeWindowAfter)
      const eligibleCandidates = [...onStage.entries()].filter(
        ([pid, pst]) =>
          index > pst.appearedAtLine && (pid !== nextSpeakerId || nextTalkPause >= 0.8)
      )
      const idlePartner = eligibleCandidates.find(
        ([pid, pst]) => pid !== member.modelId && pst.linesSinceLastBodyMotion >= 2
      )
      const fallbackOffTurn =
        eligibleCandidates.find(([pid]) => pid !== member.modelId && pid !== nextSpeakerId) ??
        eligibleCandidates.find(([pid]) => pid !== nextSpeakerId) ??
        eligibleCandidates[0]
      if (pauseOrEllipsis || idlePartner || (turnBoundary && index % 5 === 3)) {
        const picked = idlePartner ?? fallbackOffTurn
        if (picked) {
          autoSilentTargetId = picked[0]
        }
      }
    }

    const hasSilentAfter = explicitSilentReaction || autoSilentTargetId !== null
    const closeAfter = Boolean(ev?.closeWindowAfter || line.closeWindowAfter || hasSilentAfter)

    // 官方 TalkData.Motions 每条动作都同时带 MotionName 与 FacialName。说话者动作只给了
    // motion 时，沿用该角色上一个 facial（没有就用目录默认表情）；已有表情、听者动作与
    // motion 名都不动。
    let speakerFacial = actorState?.lastFacial || ''
    const speakerActs = actions
      .filter((action) => action.modelId === member.modelId)
      .sort((a, b) => num(a.at) - num(b.at))
    for (const action of speakerActs) {
      const facial = typeof action.facial === 'string' ? action.facial.trim() : ''
      if (facial) {
        speakerFacial = facial
        continue
      }
      const motion = typeof action.motion === 'string' ? action.motion.trim() : ''
      if (!motion) continue
      const filled = speakerFacial || view.defaultFacial(member.modelId)
      action.facial = filled
      speakerFacial = filled
    }

    snippets.push({
      type: 'Talk',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: talkDelay,
      data: {
        speaker: member.name,
        content: line.content,
        ttsText: line.ttsText ?? '',
        emotion: line.emotion ?? '',
        ...(line.ttsCaption ? { ttsCaption: line.ttsCaption } : {}),
        ...(typeof line.ttsSpeed === 'number' ? { ttsSpeed: line.ttsSpeed } : {}),
        ...(line.ttsSpecialScene ? { ttsSpecialScene: true } : {}),
        modelId: member.modelId,
        ...(closeAfter ? { closeWindowOnFinish: true } : {}),
        ...(actions.length > 0 ? { actions } : {})
      }
    })
    windowOpen = !closeAfter
    lastSpeakerId = member.modelId

    // 随本句 Talk 同步触发的镜头推进/震动放在 Talk 之后并置 Now，保证在本句起始帧同步启动而非提前在上句抢跑
    if (ev?.camera && ev.camera.kind !== 'zoomReset') {
      const cam = ev.camera
      if (cam.kind === 'zoomIn') {
        snippets.push({
          type: 'CameraZoom',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { scale: cam.scale ?? 1.1, duration: cam.durationMs ?? 500, ease: 'OutQuad' }
        })
        cameraDirty = true
      } else if (cam.kind === 'pan') {
        snippets.push({
          type: 'CameraMove',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { x: cam.x ?? 60, y: cam.y ?? 0, duration: cam.durationMs ?? 500, ease: 'OutQuad' }
        })
        cameraDirty = true
      } else if (cam.kind === 'shakeWindow') {
        snippets.push({
          type: 'ShakeWindow',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { duration: cam.durationMs ?? 450 }
        })
      } else if (cam.kind === 'shakeScreen') {
        const dur = cam.durationMs ?? 450
        snippets.push({
          type: 'ShakeScreen',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { duration: dur, amplitude: 0.01 }
        })
        if (dur >= 10000) shakeScreenActive = true
      }
    }

    const actedBodyThisLine = new Set<number>()
    for (const act of actions) {
      const aid = typeof act.modelId === 'number' ? act.modelId : member.modelId
      const ast = onStage.get(aid)
      if (!ast) continue
      if (typeof act.motion === 'string' && act.motion.length > 0) {
        trackActorBodyMotion(ast, act.motion)
        actedBodyThisLine.add(aid)
      }
      if (typeof act.facial === 'string' && act.facial.length > 0) {
        if (aid === member.modelId) {
          ast.lastSpeakingFacial = act.facial
        }
        ast.lastFacial = act.facial
      }
    }
    if (actorState) {
      const visibleLen = cleanText(line.content).replace(/\s+/g, '').length
      actorState.lastSpeakingWasShortWithMotion =
        actedBodyThisLine.has(member.modelId) &&
        (!hasTranslationContent(line.content) || visibleLen <= 5)
    }
    for (const [aid, ast] of onStage) {
      if (!actedBodyThisLine.has(aid)) {
        ast.linesSinceLastBodyMotion += 1
      }
    }

    if (ev?.se && ev.se.timing === 'during') {
      snippets.push({
        type: 'PlaySe',
        wait: false,
        progressBehavior: 'Now',
        delay: ev.se.delay ?? 0.15,
        data: { file: ev.se.file, volume: ev.se.volume ?? 0.9, loop: false, fadeMs: 0 }
      })
    }

    if (hasSilentAfter) {
      const offTurnCandidateId =
        [...onStage.entries()].find(
          ([id, st]) => id !== nextSpeakerId && id !== member.modelId && index > st.appearedAtLine
        )?.[0] ??
        [...onStage.entries()].find(
          ([id, st]) => id !== nextSpeakerId && index > st.appearedAtLine
        )?.[0]
      const partnerId = [...onStage.keys()].find((id) => id !== member.modelId)
      const targetId =
        ev?.silentReaction && onStage.has(ev.silentReaction.modelId)
          ? ev.silentReaction.modelId
          : autoSilentTargetId !== null && onStage.has(autoSilentTargetId)
            ? autoSilentTargetId
            : directed?.silentMotion && offTurnCandidateId !== undefined
              ? offTurnCandidateId
              : directed?.silentMotion &&
                  partnerId !== undefined &&
                  index > (onStage.get(partnerId)?.appearedAtLine ?? -1)
                ? partnerId
                : onStage.has(member.modelId)
                  ? member.modelId
                  : -1
      const avoidClobberingShortSelfMotion =
        !ev?.silentReaction &&
        targetId === member.modelId &&
        !hasTranslationContent(line.content) &&
        actedBodyThisLine.has(member.modelId)
      if (targetId !== -1 && onStage.has(targetId) && !avoidClobberingShortSelfMotion) {
        const targetState = onStage.get(targetId)!
        const targetMember = cast.find((c) => c.modelId === targetId)
        const motion =
          ev?.silentReaction?.motion ||
          pickFollowupMotion(
            view,
            targetId,
            targetState.lastBodyMotion,
            new Set(targetState.recentBodyMotions)
          )
        const silentPrecededByTense = precededByTense || TENSE_EMOTION_SET.has(line.emotion ?? '')
        const rawSilentFacial = ev?.silentReaction?.facial || ''
        const safeSilentFacial = shouldAvoidIncongruousSmile(
          rawSilentFacial,
          line,
          silentPrecededByTense
        )
          ? ''
          : rawSilentFacial
        const facial =
          safeSilentFacial ||
          (directed?.silentMotion || autoSilentTargetId !== null || rawSilentFacial
            ? targetId === member.modelId
              ? pickSpeakerSubtleFacial(
                  view,
                  targetId,
                  line,
                  targetState.lastFacial,
                  targetMember?.role,
                  { precededByTense: silentPrecededByTense }
                )
              : pickListenerReactionFacial(
                  view,
                  targetId,
                  line,
                  targetMember?.role,
                  targetState.lastFacial,
                  { precededByTense: silentPrecededByTense }
                )
            : '') ||
          ''
        if (motion || facial) {
          snippets.push({
            type: 'Motion',
            wait: true,
            progressBehavior: 'WaitFinished',
            delay: 0.25,
            data: {
              modelId: targetId,
              motion: motion || '',
              facial: facial || '',
              facialFirst: true
            }
          })
          trackActorBodyMotion(targetState, motion)
          if (facial) targetState.lastFacial = facial
          lastSilentReactionLine = index
          lastSilentReactionTargetId = targetId
          silentReactionsEmitted += 1
        }
      }
    }
  }

  // ---- 收尾与全部效果闭合 ----------------------------------------------------------------------------------
  closeWindowBeforeBreak()
  stopShakeScreenIfNeeded()
  resetCameraIfNeeded()
  if (currentEffect) {
    snippets.push({
      type: 'StopScenarioEffect',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { effectName: currentEffect }
    })
  }
  if (currentBgm && direction.bgmStop) {
    snippets.push({
      type: 'ChangeBgm',
      wait: true,
      progressBehavior: 'WaitFinished',
      delay: 0,
      data: { file: '', stop: true, fadeMs: 800 }
    })
  }
  clearActors([...onStage.keys()])
  if (flashbackActive) {
    snippets.push({
      type: 'FlashbackOut',
      wait: false,
      progressBehavior: 'Now',
      delay: 0,
      data: { duration: 100 }
    })
  }
  snippets.push({
    type: 'BlackOut',
    wait: true,
    progressBehavior: 'WaitFinished',
    delay: 0,
    data: { duration: 600, color: 'black' }
  })

  return { models, images, snippets }
}
