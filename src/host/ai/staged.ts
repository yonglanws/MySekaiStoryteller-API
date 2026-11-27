import { resolveRegisteredSeFile, type CatalogModel } from '../resources/resourceCatalog'
import * as corpusExamplesMod from './corpusExamples'
import { selectUnitFewShotExcerpts } from './corpusExamples'
import * as personasMod from './personas'
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
  normalizeScenarioEffectName
} from './scenarioCues'
import { hasTranslationContent } from './ttsText'
import {
  isGenuineCalmResolution,
  isInternalThoughtContent,
  normalizeLayoutTransitionBarriers,
  syncTalkEmotionContinuity
} from './officialLinter'
import { sanitizeIrodoriCaption } from '../../common/tts/irodori'
import type { RagRetrieveResult } from '../rag/types'
import { type DialogueLintIssue } from './dialogueLinter'
import * as facialSemanticsMod from './facialSemantics'
import {
  annotateFacialName,
  inspectModelFacial,
  isFacialCompatibleWithLine,
  isSmileLikeFacial,
  pickMoodMatchedFacial
} from './facialSemantics'

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

export type LlmPipeline = 'single' | 'staged' | 'agent'

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
  /** 对话框显示模式（如 Thinking 表示内心独白） */
  windowDisplayMode?: string
  /** Talk 效果类型（如 Internal 表示内心独白） */
  effect?: 'Normal' | 'Internal' | 'Overlap'
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

interface FacialSemanticsStagedExt {
  annotateMotionName?: (modelPath: string | undefined, motionName: string) => string
  isMotionCompatibleWithLine?: (params: {
    motion: string
    modelPath?: string
    emotion?: string
    content: string
    prevTense?: boolean
    isListener?: boolean
    restrainedRole?: boolean
    cheerfulScene?: boolean
  }) => { ok: boolean; reason?: string }
  isCheerfulComedyContext?: (
    lines: ReadonlyArray<{ content?: string; emotion?: string; sceneId?: string }>,
    index: number
  ) => boolean
  pickMoodMatchedMotion?: (
    motions: string[],
    mood: facialSemanticsMod.TargetMood,
    modelPath?: string,
    restrainedRole?: boolean,
    avoidMotions?: ReadonlySet<string> | string[]
  ) => string
}

interface PersonasStagedExt {
  characterActingProfile?: (
    nameOrPath: string,
    roleHint?: string
  ) => { restrained: boolean; temperament: string; actingNote: string }
}

interface CorpusExamplesStagedExt {
  getOfficialActingGuidelines?: (options?: {
    castCount?: number
    isSekai?: boolean
    isFlashback?: boolean
  }) => string
}

const facialStagedApi = facialSemanticsMod as unknown as FacialSemanticsStagedExt
const personasStagedApi = personasMod as unknown as PersonasStagedExt
const corpusStagedApi = corpusExamplesMod as unknown as CorpusExamplesStagedExt

const MOTION_LABEL_FALLBACK: Array<[RegExp, string]> = [
  [/default|stand/i, '默认站姿'],
  [/nod/i, '点头'],
  [/tilthead|tilt/i, '歪头'],
  [/shakehead/i, '摇头'],
  [/glad|happy|cheer|joy/i, '开心欢呼'],
  [/wink|smug|doya|pose/i, '俏皮/得意'],
  [/shy|blush|fidget/i, '害羞/局促'],
  [/trouble|worry/i, '为难'],
  [/sad|sigh|lookdown|cry/i, '低落/叹气'],
  [/angry|disgust/i, '生气'],
  [/forward/i, '前倾认真'],
  [/think|lookaway|lookup/i, '思考'],
  [/surprise|shock|scared/i, '惊讶'],
  [/relief/i, '松口气'],
  [/greeting|wave/i, '打招呼'],
  [/delicious|eat|drink/i, '吃喝/美味(仅限食物饮品)'],
  [/sleep/i, '困倦(仅限犯困睡眠)']
]

function annotateMotionForDirection(modelPath: string | undefined, motionName: string): string {
  if (typeof facialStagedApi.annotateMotionName === 'function') {
    return facialStagedApi.annotateMotionName(modelPath, motionName)
  }
  for (const [re, label] of MOTION_LABEL_FALLBACK) {
    if (re.test(motionName)) return `${motionName}(${label})`
  }
  return motionName
}

function inferMotionMoodKey(
  line?: { content: string; emotion?: string },
  prevTense = false
): 'sad' | 'angry' | 'trouble' | 'surprise' | 'shy' | 'smile' | 'thinking' | 'neutral' {
  if (!line) return prevTense ? 'trouble' : 'neutral'
  const emo = (line.emotion ?? '').trim()
  const text = line.content ?? ''
  if (emo === '伤心') return 'sad'
  if (emo === '生气') return 'angry'
  if (emo === '害怕') return 'trouble'
  if (emo === '惊讶') return 'surprise'
  if (emo === '害羞') return 'shy'
  if (emo === '开心') return 'smile'
  if (/对不起|抱歉|对不住|搞砸|后悔|难过|伤心|眼泪|哭|失落/.test(text)) return 'sad'
  if (/烦死|够了|住口|气死|少啰嗦/.test(text)) return 'angry'
  if (/苦笑|没办法|为难|尴尬|纠结|勉强/.test(text)) return 'trouble'
  if (/什么！？|怎么会|竟然|！？|\?!/.test(text)) return 'surprise'
  if (/脸红|害羞|别看我/.test(text)) return 'shy'
  if (/^[（(].*[）)]$/.test(text.trim())) return 'thinking'
  if (!prevTense && /太好了|好耶|哈哈|嘿嘿|嘻嘻|～♪|♪|Wonderhoy/.test(text)) return 'smile'
  return prevTense ? 'trouble' : 'neutral'
}

const FOOD_DRINK_CUE_RE =
  /吃|喝|美味|好吃|甜品|蛋糕|面包|拉面|茶|咖啡|点心|便当|饮料|食物|品尝|味道|饿|嘴馋|delicious|eat|drink/i
const SLEEP_CUE_RE = /困|睡|熬夜|累|疲惫|打哈欠|睡着|午睡|晚安|想睡|sleep|tired|yawn/i

function isMotionCompatibleWithContext(params: {
  motion: string
  modelPath?: string
  line: { content: string; emotion?: string }
  prevTense: boolean
  isListener?: boolean
  restrainedRole?: boolean
  cheerfulScene?: boolean
}): boolean {
  if (!params.motion.trim()) return true
  const lower = params.motion.toLowerCase()
  const text = (params.line.content ?? '').trim()
  if (/delicious|eat|drink/i.test(lower) && !FOOD_DRINK_CUE_RE.test(text)) return false
  if (/sleep/i.test(lower) && !SLEEP_CUE_RE.test(text)) return false
  if (typeof facialStagedApi.isMotionCompatibleWithLine === 'function') {
    if (
      !facialStagedApi.isMotionCompatibleWithLine({
        motion: params.motion,
        modelPath: params.modelPath,
        emotion: params.line.emotion,
        content: params.line.content,
        prevTense: params.prevTense,
        isListener: params.isListener,
        restrainedRole: params.restrainedRole,
        cheerfulScene: params.cheerfulScene
      }).ok
    ) {
      return false
    }
  }
  const mood = inferMotionMoodKey(params.line, params.prevTense)
  const emo = (params.line.emotion ?? '').trim()
  const monologue = /^[（(]/.test(text) && /[）)]$/.test(text)
  const isTense = params.prevTense || mood === 'sad' || mood === 'angry' || mood === 'trouble'
  const isJoyful =
    /glad|happy|cheer|joy|wandahoi|wink|smug|doya|pose(?!sad)|delicious|sing|greeting|wave/.test(
      lower
    )
  const isNegative = /angry|disgust|sad|cry|sigh/.test(lower)
  const isGenuineHappy = facialSemanticsMod.isGenuineHappyOrReconciliation(text)
  if (
    isTense &&
    isJoyful &&
    !(params.prevTense && mood === 'smile' && isGenuineHappy && emo === '开心')
  ) {
    return false
  }
  if (mood === 'smile' && !params.prevTense && isNegative) return false
  if (params.restrainedRole && /glad|happy|cheer|joy/.test(lower)) return false
  const isQuestionLine = /[？?]|难道|为什么|怎么|吗/.test(text)
  const isAcuteDespair = /(?:窒息|受不了|绝望|崩溃|再见|别走)/.test(text)
  if ((mood === 'sad' || monologue) && emo !== '惊讶') {
    if (/greeting|wave|surprise|shock|angry|disgust/.test(lower)) {
      return false
    }
    if (/relief/.test(lower) && isAcuteDespair) {
      return false
    }
    if (/tilthead|tilt/.test(lower) && (params.isListener || !isQuestionLine || isAcuteDespair)) {
      return false
    }
  }
  if (mood === 'angry' && /tilthead|tilt|greeting|wave/.test(lower)) {
    return false
  }
  return true
}

function ensureRealModelAnim(
  view: CatalogView,
  modelId: number,
  field: 'motion' | 'facial',
  candidate: string | undefined
): string {
  const clean = (candidate ?? '').trim()
  if (!clean) return ''
  const choices = view.animationChoices(modelId, field)
  if (choices.size === 0) return clean
  return view.canonicalAnimation(modelId, field, clean) ?? ''
}

function collectModelNonStandingMotions(view: CatalogView, modelId: number): string[] {
  const model = view.modelById(modelId)
  if (!model) return []
  const curated = view.promptMotions(model)
  const curatedSet = new Set(curated)
  const rest = (model.motions ?? []).filter((m) => !curatedSet.has(m))
  const sortNormalFirst = (arr: string[]): string[] => {
    const nonStand = arr.filter((name) => !isStandingMotion(name))
    return [
      ...nonStand.filter((m) => /^w-normal/i.test(m)),
      ...nonStand.filter((m) => !/^w-normal/i.test(m))
    ]
  }
  return [...sortNormalFirst(curated), ...sortNormalFirst(rest)]
}

function collectModelFacials(view: CatalogView, modelId: number): string[] {
  const model = view.modelById(modelId)
  if (!model) return []
  const curated = view.promptFacials(model)
  const curatedSet = new Set(curated)
  return [...curated, ...(model.facials ?? []).filter((f) => !curatedSet.has(f))]
}

function pickFollowupMotion(
  view: CatalogView,
  modelId: number,
  currentMotion?: string,
  recentlyUsed?: ReadonlySet<string>,
  moodContext?: {
    line?: { content: string; emotion?: string }
    prevTense?: boolean
    restrained?: boolean
  }
): string {
  const model = view.modelById(modelId)
  if (!model) return ''
  const nonStanding = collectModelNonStandingMotions(view, modelId).filter((m) => {
    const lineText = moodContext?.line?.content ?? ''
    if (/delicious|eat|drink/i.test(m) && !FOOD_DRINK_CUE_RE.test(lineText)) return false
    if (/sleep/i.test(m) && !SLEEP_CUE_RE.test(lineText)) return false
    return true
  })
  const moodKey = inferMotionMoodKey(moodContext?.line, Boolean(moodContext?.prevTense))
  const isTense = Boolean(
    moodContext?.prevTense || moodKey === 'sad' || moodKey === 'angry' || moodKey === 'trouble'
  )
  const safeNonStanding = isTense
    ? nonStanding.filter(
        (m) => !/glad|happy|cheer|joy|wink|smug|doya|greeting|wave|playful/i.test(m)
      )
    : nonStanding
  const baseList = safeNonStanding.length > 0 ? safeNonStanding : nonStanding
  if (typeof facialStagedApi.pickMoodMatchedMotion === 'function' && moodContext?.line) {
    const avoid = new Set<string>(recentlyUsed ?? [])
    if (currentMotion) avoid.add(currentMotion)
    const matched = facialStagedApi.pickMoodMatchedMotion(
      baseList,
      moodKey,
      model.path,
      moodContext.restrained,
      avoid
    )
    const verified = ensureRealModelAnim(view, modelId, 'motion', matched)
    if (verified && verified !== currentMotion) return verified
  }
  const moodHints: Record<typeof moodKey, RegExp> = {
    sad: /sad|cry|sigh|lookdown|trouble|think|shakehead/i,
    angry: /angry|shakehead|forward|serious/i,
    trouble: /trouble|think|lookaway|sigh/i,
    surprise: /surprise|tilthead|forward|nod/i,
    shy: /shy|blush|fidget|tilthead|lookaway/i,
    smile: /glad|nod|tilthead|relief|greeting|playful/i,
    thinking: /think|lookaway|sigh|trouble|sad/i,
    neutral: /nod|tilthead|relief|think|lookaway|forward|shy|sigh/i
  }
  const calmRe = moodHints[moodKey] ?? moodHints.neutral
  const compatiblePool = moodContext?.line
    ? baseList.filter((name) =>
        isMotionCompatibleWithContext({
          motion: name,
          modelPath: model.path,
          line: moodContext.line!,
          prevTense: Boolean(moodContext.prevTense),
          restrainedRole: moodContext.restrained
        })
      )
    : baseList
  if (compatiblePool.length === 0) return ''
  const pool = compatiblePool
  const isFresh = (name: string): boolean => name !== currentMotion && !recentlyUsed?.has(name)
  const raw =
    pool.find((name) => isFresh(name) && calmRe.test(name)) ??
    pool.find((name) => isFresh(name)) ??
    pool.find((name) => name !== currentMotion && calmRe.test(name)) ??
    pool.find((name) => name !== currentMotion) ??
    ''
  return ensureRealModelAnim(view, modelId, 'motion', raw)
}

function pickAppearFallbackMotion(
  view: CatalogView,
  modelId: number,
  usedInEntry?: ReadonlySet<string>,
  avoidMotion?: string,
  tense = false
): string {
  const model = view.modelById(modelId)
  if (!model) {
    return ensureRealModelAnim(
      view,
      modelId,
      'motion',
      view.exampleMotion(modelId) || view.defaultMotion(modelId)
    )
  }
  const nonStanding = collectModelNonStandingMotions(view, modelId).filter(
    (m) => !/delicious|eat|drink|sleep/i.test(m)
  )
  const entryRe = tense
    ? /trouble|sad|cry|sigh|think|lookaway/i
    : /tilthead|lookaway|greeting|nod|forward|relief|think|shy/i
  const isSafe = (name: string): boolean =>
    !tense || !/glad|happy|cheer|joy|wink|smug|doya|greeting|wave|playful|tilthead/i.test(name)
  const distinctAndAvoided = (name: string): boolean =>
    !usedInEntry?.has(name) && name !== avoidMotion
  const pick =
    nonStanding.find((name) => distinctAndAvoided(name) && isSafe(name) && entryRe.test(name)) ??
    nonStanding.find((name) => distinctAndAvoided(name) && isSafe(name)) ??
    nonStanding.find((name) => name !== avoidMotion && isSafe(name) && entryRe.test(name)) ??
    nonStanding.find((name) => name !== avoidMotion && isSafe(name)) ??
    nonStanding[0]
  return (
    ensureRealModelAnim(view, modelId, 'motion', pick) ||
    ensureRealModelAnim(view, modelId, 'motion', view.exampleMotion(modelId)) ||
    ensureRealModelAnim(view, modelId, 'motion', view.defaultMotion(modelId))
  )
}

const FACIAL_EXTREME_EXCLUDE_RE =
  /angry|disgust|scared|cry|shock|dark|despair|fever|sneeze|disgorge/i
const FACIAL_SMILE_EXCLUDE_RE =
  /smile|smug|wink|sparkling|angry|disgust|scared|cry|shock|dark|despair|fever|sneeze|disgorge/i
const TENSE_EMOTION_SET = new Set(['生气', '伤心', '害怕'])
const SILENT_LINE_RE = /^[（(]?[\s.…,，。！？!?—\-~～]+[）)]?$/
const SMILE_FACIAL_RE = /smile|smug|wink|sparkling/i

export interface SubtleFacialContext {
  precededByTense?: boolean
  modelPath?: string
  restrained?: boolean
  listenerPrevEmotion?: string
}

const isSilentBeatLine = (text: string): boolean => SILENT_LINE_RE.test((text ?? '').trim())

const shouldAvoidIncongruousSmile = (
  facial: string | undefined,
  line: { content: string; emotion?: string },
  precededByTense: boolean,
  context: { modelPath?: string; restrained?: boolean } = {}
): boolean => {
  if (!facial) return false
  if (
    !isFacialCompatibleWithLine({
      facial,
      modelPath: context.modelPath,
      emotion: line.emotion,
      content: line.content,
      prevTense: precededByTense,
      restrainedRole: context.restrained
    }).ok
  ) {
    return true
  }
  return SMILE_FACIAL_RE.test(facial) && line.emotion !== '开心' && isSilentBeatLine(line.content)
}

function isCheerfulComedyLines(
  lines: ReadonlyArray<{ content: string; emotion?: string; sceneId?: string }>,
  index: number
): boolean {
  if (typeof facialStagedApi.isCheerfulComedyContext === 'function') {
    return facialStagedApi.isCheerfulComedyContext(lines, index)
  }
  return false
}

function isPrecededByTenseBeat(
  lines: ReadonlyArray<{ content: string; emotion?: string; sceneId?: string }>,
  index: number,
  lookback = 3
): boolean {
  if (isCheerfulComedyLines(lines, index)) return false
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

const isRestrainedRole = (roleOrName = ''): boolean => {
  if (typeof personasStagedApi.characterActingProfile === 'function') {
    return personasStagedApi.characterActingProfile(roleOrName, roleOrName).restrained
  }
  return /真冬|mafuyu|克制|冷静|寡言|内敛|沉默/.test(roleOrName)
}

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
  const facials = collectModelFacials(view, modelId)
  const emotion = line.emotion ?? ''
  const text = line.content ?? ''
  const restrained = context.restrained ?? (isRestrainedRole(role) || isRestrainedRole(model.name))
  const precededByTense = Boolean(context.precededByTense)
  const modelPath = context.modelPath ?? model.path
  const nonSmileFacials = facials.filter((f) => !isSmileLikeFacial(f, modelPath))
  const safePool = nonSmileFacials.length > 0 ? nonSmileFacials : facials

  if (emotion === '开心') {
    const matched = pickMoodMatchedFacial(facials, 'smile', modelPath, restrained)
    if (matched && matched !== currentFacial) return matched
    return pickFacialFromHints(
      facials,
      restrained
        ? [/smallmouth|closeeye|smile/i, /normal/i]
        : [/smile|sparkling|wink|smug/i, /closeeye|normal/i],
      currentFacial,
      /angry|sad|cry|disgust|scared|dark/i
    )
  }
  if (emotion === '伤心') {
    const isCryingOrClimax = /哭|泣|泪|呜|😭|🥺|不行|别走|再见|窒息|崩溃|绝望|对不起|抱歉/.test(
      text
    )
    const hints = isCryingOrClimax
      ? [/cry/i, /sad|darksad|ossad/i, /worry|trouble|lookaway/i, /closeeye|smallmouth/i]
      : [/sad|darksad|cry/i, /worry|trouble|lookaway/i, /closeeye|smallmouth/i]
    return (
      pickFacialFromHints(
        safePool,
        hints,
        currentFacial,
        /smile|smug|wink|sparkling|angry/i
      ) || pickMoodMatchedFacial(safePool, 'sad', modelPath, restrained)
    )
  }
  if (emotion === '生气') {
    return (
      pickFacialFromHints(
        safePool,
        [/angry|darkangry|sharp|serious|disgust/i, /trouble|smallmouth/i],
        currentFacial,
        /smile|smug|wink|sparkling/i
      ) || pickMoodMatchedFacial(facials, 'angry', modelPath, restrained)
    )
  }
  if (emotion === '害怕') {
    return pickFacialFromHints(
      safePool,
      [/scared|worry|trouble|surprise|shock/i, /sad|lookaway|serious/i],
      currentFacial,
      /smile|smug|wink|sparkling|angry/i
    )
  }
  if (emotion === '惊讶') {
    return pickFacialFromHints(
      safePool,
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
      safePool,
      precededByTense
        ? [/trouble|worry|closeeye|lookaway/i, /serious|smallmouth|sad|normal/i]
        : [/closeeye|serious|smallmouth|lookaway/i, /trouble|notice|normal/i],
      currentFacial,
      FACIAL_SMILE_EXCLUDE_RE
    )
  }

  // 平静/无标签对话：按台词具体语气细分微表情，不再全锁成 face_normal_01，也不误触发道歉句的笑脸
  const explicitJoyRe = /♪|～♪|哈哈|嘿嘿|太好了|开心/
  const mildJoyRe = /♪|～|哈哈|嘿嘿|太好了|开心|最喜欢|好喜欢|谢谢啦|早安|晚安|不错嘛/
  const hasNegOrApology =
    /对不起|抱歉|糟|烦|无奈|叹|算了|没办法|真是的|别这样|讨厌|难过|不开心|不高兴|没笑/.test(text)
  if (!hasNegOrApology && (precededByTense ? explicitJoyRe.test(text) : mildJoyRe.test(text))) {
    return pickFacialFromHints(
      facials,
      restrained
        ? [/smallmouth|closeeye|smile/i, /serious|normal/i]
        : [/smile|wink|smug|sparkling/i, /closeeye|smallmouth/i],
      currentFacial,
      FACIAL_EXTREME_EXCLUDE_RE
    )
  }
  if (hasNegOrApology) {
    return pickFacialFromHints(
      safePool,
      [/trouble|worry|lookaway|closeeye/i, /sad|smallmouth|serious/i],
      currentFacial,
      /smile|sparkling|smug|angry/i
    )
  }
  if (/？|\?|什么|怎么|难道|为什么|真的吗|咦/.test(text)) {
    return pickFacialFromHints(
      precededByTense ? safePool : facials,
      precededByTense
        ? [/notice|baffling|serious|trouble/i, /smallmouth|lookaway|worry/i]
        : [/notice|baffling|serious|trouble/i, /smallmouth|lookaway|smile/i],
      currentFacial,
      precededByTense ? FACIAL_SMILE_EXCLUDE_RE : FACIAL_EXTREME_EXCLUDE_RE
    )
  }
  if (/决定|一定|必须|其实|认真|听我说|总之/.test(text)) {
    return pickFacialFromHints(
      precededByTense ? safePool : facials,
      precededByTense
        ? [/serious|closeeye|smallmouth/i, /notice|trouble|normal/i]
        : [/serious|closeeye|smallmouth/i, /notice|smile|normal/i],
      currentFacial,
      precededByTense ? FACIAL_SMILE_EXCLUDE_RE : FACIAL_EXTREME_EXCLUDE_RE
    )
  }
  if (precededByTense) {
    return pickFacialFromHints(
      safePool,
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
  const allFacials = collectModelFacials(view, listenerId)
  const facials = allFacials.filter(
    (f) => !isSmileLikeFacial(f, context.modelPath ?? model.path)
  )
  const safeListenerPool = facials.length > 0 ? facials : allFacials
  const speakerEmotion = speakerLine.emotion ?? ''
  const text = speakerLine.content ?? ''
  const restrained = isRestrainedRole(listenerRole) || isRestrainedRole(model.name)
  const listenerPrevEmo = (context.listenerPrevEmotion ?? '').trim()
  const currentFacialRole = currentFacial
    ? inspectModelFacial(context.modelPath ?? model.path, currentFacial).role
    : 'neutral'
  const listenerHadTenseMood =
    listenerPrevEmo === '生气' ||
    listenerPrevEmo === '伤心' ||
    listenerPrevEmo === '害怕' ||
    currentFacialRole === 'angry' ||
    currentFacialRole === 'sad' ||
    currentFacialRole === 'cry' ||
    currentFacialRole === 'trouble' ||
    currentFacialRole === 'cold_hollow' ||
    currentFacialRole === 'closed_troubled'
  const precededByTense = Boolean(context.precededByTense) || listenerHadTenseMood

  const isScoldingOrConfronting =
    speakerEmotion === '生气' ||
    /别再|不要再|少啰嗦|笨蛋|推开|擅自|搞什么|为什么|吵|责怪|闭嘴/.test(text)
  if (isScoldingOrConfronting) {
    return pickFacialFromHints(
      safeListenerPool,
      [/trouble|worry|sad|lookaway/i, /closeeye|serious|smallmouth/i],
      currentFacial,
      /angry|disgust|scared|smile|smug|wink|sparkling/i
    )
  }
  if (speakerEmotion === '伤心') {
    return pickFacialFromHints(
      safeListenerPool,
      [/worry|sad|trouble/i, /closeeye|serious|smallmouth/i],
      currentFacial,
      /smile|smug|wink|sparkling|angry|disgust/i
    )
  }
  if (speakerEmotion === '害怕') {
    return pickFacialFromHints(
      safeListenerPool,
      [/worry|serious|trouble|surprise/i, /sad|closeeye|smallmouth/i],
      currentFacial,
      /smile|smug|wink|sparkling|angry/i
    )
  }
  if (speakerEmotion === '惊讶') {
    return pickFacialFromHints(
      precededByTense ? safeListenerPool : allFacials,
      [/surprise|notice|baffling/i, /serious|smallmouth|trouble/i],
      currentFacial,
      precededByTense ? /angry|disgust|cry|smile|smug|wink|sparkling/i : /angry|disgust|cry/i
    )
  }
  if (speakerEmotion === '害羞') {
    if (precededByTense) {
      return pickFacialFromHints(
        safeListenerPool,
        [/serious|trouble|notice/i, /smallmouth|closeeye|normal/i],
        currentFacial,
        FACIAL_SMILE_EXCLUDE_RE
      )
    }
    return pickFacialFromHints(
      allFacials,
      restrained
        ? [/smallmouth|serious|closeeye/i, /normal/i]
        : [/smile|wink|smug|notice/i, /serious|normal/i],
      currentFacial,
      FACIAL_EXTREME_EXCLUDE_RE
    )
  }
  if (speakerEmotion === '开心') {
    if (precededByTense) {
      return pickFacialFromHints(
        safeListenerPool,
        [/trouble|worry|serious|sad/i, /smallmouth|closeeye|lookaway|normal/i],
        currentFacial,
        FACIAL_SMILE_EXCLUDE_RE
      )
    }
    return pickFacialFromHints(
      allFacials,
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
      precededByTense ? safeListenerPool : allFacials,
      [/serious|notice|trouble|lookaway/i, /smallmouth|closeeye|normal/i],
      currentFacial,
      precededByTense ? FACIAL_SMILE_EXCLUDE_RE : FACIAL_EXTREME_EXCLUDE_RE
    )
  }
  if (!precededByTense && /♪|～|笑|谢谢|太好了|没关系|一起/.test(text)) {
    return pickFacialFromHints(
      allFacials,
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
  return Math.max(10, Math.min(80, Math.round(targetMinutes * 10)))
}

function titleOrDefault(value: unknown, fallback: string): string {
  return oneLine(value, 64) || fallback
}

const EXPLICIT_GROUP_INTENT_RE =
  /大家|全员|全体|全团|全队|众人|成员们|其他成员|其余成员|队友们|三人|四人|五人|聚会|团建|live|演唱会|文化祭/i
const META_EVENT_STYLE_RE = /活动风格|活动剧情|活动卡面|活动向|20\d\d\s*年活动/g
const PERSON_LEFT_DELIM_RE =
  /[与和跟找对向把给连比让请由被、，。！？（）()“”"‘’'「」『』：:/\s]/
const PERSON_RIGHT_DELIM_RE =
  /[与和跟对向把给、，。！？（）()“”"‘’'「」『』：:/\s]/
const SINGLE_CHAR_NON_NAME_WORDS: Record<string, RegExp> = {
  类: /类型|类似|种类|分类|人类|同类|这类|那类|此类|另类|肉类|酒类|鱼类|鸟类|门类|之类|各类|全类|品类|大类/,
  司: /公司|司机|上司|司令|司仪|司法|司空|司职|司马|有司/,
  遥: /遥远|遥望|遥控|逍遥|遥想|遥感|遥测|遥相|路遥/,
  奏: /演奏|合奏|伴奏|前奏|间奏|节奏|独奏|重奏|奏效|奏章|奏折|奏鸣|先斩后奏/,
  杏: /银杏|杏仁|杏花|杏色|杏黄|杏子|青杏/,
  铃: /铃声|铃铛|门铃|电铃|响铃|风铃|闹铃|哑铃|铃兰/,
  连: /连续|连线|连夜|连日|连同|连连|牵连|接连|连接|连带|连累|连衣|连忙|连载|连贯|连锁|连胜|连任|连长|连队|一连|连日|相连|流连/
}

function hasSingleCharNameMention(scene: string, shortName: string): boolean {
  if (!scene || shortName.length !== 1) return false
  const compoundRe = SINGLE_CHAR_NON_NAME_WORDS[shortName]
  let idx = scene.indexOf(shortName)
  while (idx !== -1) {
    const prev = idx > 0 ? scene[idx - 1] : ''
    const next = idx + 1 < scene.length ? scene[idx + 1] : ''
    const leftOk = idx === 0 || PERSON_LEFT_DELIM_RE.test(prev)
    const rightSepOk = idx + 1 === scene.length || PERSON_RIGHT_DELIM_RE.test(next)
    // 「连」作副词（如「连我都忘了」）高频误判，仅在明确人名并列/介词称谓且非后续代词时匹配
    const particleGuard =
      shortName !== '连' ||
      ((prev === '' || /[与和跟对向把给、，：:「『（\s]/.test(prev)) &&
        !/^[我你他她它这那谁也都很再]/.test(next))
    let spansCompound = false
    if (compoundRe) {
      const window2Left = scene.slice(Math.max(0, idx - 1), idx + 1)
      const window2Right = scene.slice(idx, Math.min(scene.length, idx + 2))
      const window3 = scene.slice(Math.max(0, idx - 1), Math.min(scene.length, idx + 2))
      const window4 = scene.slice(Math.max(0, idx - 2), Math.min(scene.length, idx + 3))
      if (
        compoundRe.test(window2Left) ||
        compoundRe.test(window2Right) ||
        compoundRe.test(window3) ||
        compoundRe.test(window4)
      ) {
        spansCompound = true
      }
    }
    if (!spansCompound && particleGuard && (leftOk || rightSepOk)) {
      return true
    }
    idx = scene.indexOf(shortName, idx + 1)
  }
  return false
}

function isModelMentionedInScene(scene: string, model: CatalogModel): boolean {
  if (model.name && scene.includes(model.name)) return true
  const short = (model.shortName ?? '').trim()
  if (!short) return false
  if (short.length >= 2) return scene.includes(short)
  return hasSingleCharNameMention(scene, short)
}

function findMentionedPrimaryModels(scene: string, models: CatalogModel[]): CatalogModel[] {
  const seenChar = new Set<string>()
  const picked: CatalogModel[] = []
  for (const model of models) {
    const key =
      typeof model.characterId === 'number'
        ? `char:${model.characterId}`
        : `name:${model.name.toLowerCase()}`
    if (seenChar.has(key)) continue
    if (isModelMentionedInScene(scene, model)) {
      seenChar.add(key)
      picked.push(model)
    }
  }
  return picked
}

function isGroupPrompt(scene: string, view: CatalogView): boolean {
  if (view.models.length < 3) return false
  const mentionedCount = findMentionedPrimaryModels(scene, view.primaryModels()).length
  if (mentionedCount >= 3) return true
  const cleanedScene = scene.replace(META_EVENT_STYLE_RE, '')
  if (mentionedCount >= 1) {
    return EXPLICIT_GROUP_INTENT_RE.test(cleanedScene)
  }
  return (
    EXPLICIT_GROUP_INTENT_RE.test(cleanedScene) ||
    /社团|排练|25时|nightcord|leo\/need|mmj|vbs|ws|wxs|sekai/i.test(cleanedScene)
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
  const subMentioned = subRosterAll.filter((m) => isModelMentionedInScene(options.scene, m))
  const subShown = [
    ...subMentioned,
    ...subRosterAll
      .filter((m) => !subMentioned.includes(m))
      .slice(0, Math.max(0, 12 - subMentioned.length))
  ]

  const mentionedModels = findMentionedPrimaryModels(options.scene, primary)
  const cleanedSceneForGroup = options.scene.replace(META_EVENT_STYLE_RE, '')
  const asksForGroup = EXPLICIT_GROUP_INTENT_RE.test(cleanedSceneForGroup)
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
      voice: `${exampleCast
        .slice(0, 2)
        .map((c) => c.name)
        .join(' ')} 日常互动对白与称呼`,
      worldview: '相关地点、社团/团体设定或关系背景'
    }
  }

  const preCastRagBlock = formatCanonGroundingBrief({
    ragContext: options.ragContext,
    stage: 'cast',
    maxChars: 1500
  })

  const mentionedLabels = mentionedModels
    .map((m) => `${view.shortName(m)}(modelId=${m.id})`)
    .join('、')
  const castRule =
    view.models.length <= 2
      ? '从角色池选 1~2 名角色（默认 2 人；仅明确要求独白时选 1 人）。'
      : mentionedModels.length >= 2 && !asksForGroup
        ? `用户已明确点名出场角色（${mentionedLabels}），且未要求其他成员或群像加入：**本次严格只选这 ${mentionedModels.length} 名角色**，严禁擅自加入未点名的同组合队友或其他无关角色。`
        : mentionedModels.length === 1 && !asksForGroup
          ? `用户已明确点名「${mentionedLabels}」：若描述为单人独白则只选这 1 人；若需要对手戏且剧情隐含另一位搭档，最多再配 1 名最相关角色（共 1~2 人），切勿无故拉入未提及的多余队友。`
          : groupStyle
            ? '本场偏向团体/活动场景：建议选 **3~5 名角色** 参演，用 scenes 或 stageGroup 安排每幕 1~2 人在场（官方 Normal 模式每次最多 2 人同台，通过 2 人交叠淡出淡入轮换上场）。'
            : '按场景需要选 **2~5 名角色**（双人对话选 2 人，日常同框为主、内心独白或思索时也允许切单人 Center 留白；团体/活动场景选 3~5 人并按场景或对话轮换保持每次最多 2 人在场；仅明确独白选 1 人），严禁擅自加入未提及的多余角色。'

  return {
    system: [
      '你是 Project SEKAI 风格视觉小说的编剧兼总导演。',
      '这是五阶段创作的第一轮（Episode Beat Sheet）：选角（1~5人）、设计小事件，并按剧情需要规划 1~3 幕节奏表（scenes；连续同时空对话只写 1 幕即可）。',
      '不要写台词正文，不要写动作编号。只输出一个 JSON 对象。'
    ].join('\n'),
    user: `## 任务
${options.scene}

- 语言：中文（台词 content 用中文，日文 ttsText 由宿主另行翻译）
- 目标时长：约 ${options.targetMinutes} 分钟，约 ${budget} 句台词（按 PJSK 配音与停顿约 7 秒/句换算，凝练紧凑，切勿注水拉长）
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
- **自然分幕（1~3 幕 scenes，不强制凑数）**：
  - 同一地点、同一时段的连续对话只规划 **1 幕（s1）** 即可，切勿硬拆成 2~3 幕；仅当真正需要换地点、跳时间、插回忆或出入 SEKAI 时才拆出第 2~3 幕。
  - 每幕写明 \`id\`（s1/s2/s3）、\`summary\`、\`background\`（必须来自可用背景清单）、\`ambient\`（normal/evening/night）、\`activeCast\`（1~2 名本幕起手在场角色名，Normal 模式每次最多 2 人）。
  - 合理规划转场与标题条：首幕可用 \`telop\`（时间/气氛短标题，如「放学后」）或 \`placeInfo\`（左上角地点条）；后续幕次可用 \`transitionIn\`：\`sideFade\`（横向遮罩擦除）、\`flashback\`（白光闪入回忆：WhiteOut->FlashbackIn->WhiteIn）、\`sekaiIn\`/\`sekaiOut\`（出入 SEKAI）或 \`black\`。
  - 若场景涉及回忆，标注 \`isFlashback: true\`、\`transitionIn: "flashback"\`；若涉及出入 SEKAI，标注 \`isSekai: true\` 与 \`sekaiIn\`/\`sekaiOut\`。
  - 善用 BGM 弧光：首幕（s1）必须从可用 BGM 清单选择贴合气氛的开场配乐（严禁首幕大段无声，只有 2~4 句冷开场且第 5 句前切入 BGM 才可留空）；中后段情绪转折或坦白前一幕可写 \`bgm: "silence"\`（对应官方 \`bgm00000\` 静音停曲留白），之后再接入情绪曲。
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
      activeCast:
        active.length > 0
          ? active.slice(0, 2)
          : cast.length === 2
            ? cast.map((c) => c.name)
            : fallbackActive,
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
  const mentioned = findMentionedPrimaryModels(options.scene, pool)
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
  const {
    scene = '',
    plan = null,
    ragContext = null,
    stage = 'dialogue',
    maxChars = 2400
  } = options
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
          .map(
            (goal) =>
              `${goal.cast || '角色'}（想：${goal.wants || '—'} / 藏：${goal.hides || '—'}）`
          )
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
        lines: [
          '今天也……一起练吧。',
          '我把上次那首的副歌重新编了一下，\n你听听看？',
          '（……其实昨晚改完之后，一直有点没底。）'
        ]
      },
      ...(b && b.name !== a.name
        ? [
            {
              speaker: b.name,
              lines: [
                '诶，什么时候弄的？',
                '……我看看。',
                '嗯，这里第二段是不是太满了？\n不是说不好，就是……有点急着往前跑。',
                '（……明明才熬过一次通宵，干嘛还要这么拼。）',
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
      {
        speaker: a.name,
        lines: ['啊。', '（……果然还是被听出来了啊。）']
      },
      ...(b && b.name !== a.name
        ? [
            {
              speaker: b.name,
              lines: ['……我可没说不好听。', '下次改谱之前，好歹先喝口热茶歇一歇。']
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
## 台词要求（按 ${budget} 句的场次计算，约 ${options.targetMinutes} 分钟）
- 语言：中文；总共 ${Math.max(10, Math.round(budget * 0.92))}~${Math.max(14, Math.round(budget * 1.2))} 句（目标约 ${budget} 句，按 PJSK 配音与停留约 7 秒/句换算）；
  少于 ${Math.max(10, Math.round(budget * 0.92))} 句或超过 ${Math.max(14, Math.round(budget * 1.2))} 句都视为不合格。
- 用 turns 组织：一个角色的一次发言 = 一个 turn，turn 里放 1~6 条 lines。
  lines 元素优先直接写字符串；需要刻意沉默/转场收窗时可写成对象 \`{"content":"...","pauseBefore":1.0,"closeWindowAfter":true}\`（pauseBefore 仅在重大停顿或反应前用 \`1.0\` 或 \`1.5\`，其余句留空即 \`0\`）。
  **贴近官方 PJSK 的自然连说节奏（平均每轮约 1.8~2.2 句）**：避免机械一问一答交替（A-B-A-B）——约 1/3 的 turn 用 1 句短反应/抢话（至少 ${Math.max(4, Math.round(budget * 0.25))} 个），约 1/2 的 turn 用 2~3 句自然连说（先接一句短反应或内心心声，再顺势说出想法），少数情绪最重或回忆处可用 4~6 条（5~6 条的稍长一段全片最多 1 处，严禁多处连排长独白）。
- 句长与排版（对应官方 30 字宽文本框）：
  - 平均 18~21 字；长句（27~45 字）可在自然的呼吸/从句标点后加 \`\\n\` 分成 2~3 行，每行**不超过 30 个字宽**（全角=1，半角=0.5），**最多 3 行**；
  - 约 1/7 的句子是 2~6 字短反应（「…………」「……嗯。」「真的？」「诶？」「等一下。」）。
- **内心独白（（……），全片约 10%~16% / 3~6 句）**：自然穿插全角括号内心独白（如 \`（……她其实也很在意吧）\`、\`（现在这样笑出来，反而更难受……）\`），用来写角色顾虑、犹豫、暗自观察或表里动机的隐瞒面；**严禁夹带 \`（微笑）\` \`(挠头)\` \`（叹气）\` 等舞台动作/神态括号**，也禁止 \`她转过头\` 之类第三人称动作叙述。
- 节奏要贴合场景和角色性格自然流动，不要刻意凑齐任何“标准比例”；有对话往来、短反应、适当留白即可。
- **反套路与官方质感（Show, Don't Tell）**：
  - 禁止心理咨询式独白和直白情绪总结（如「其实我一直想说」「谢谢你总是这么温柔」「今天的经历让我明白」「我终于明白了」「内心深处」）。用具体物件、转移话题、打断、迟疑停顿（……、——）来侧面流露情绪。
  - 结尾最后 2 句严禁升华说教或大团圆总结；像官方剧情一样收在一个安静的动作余韵、日常小约定、轻描淡写的吐槽或未说完的半句话里。
  - 角色化学反应：允许抢话、听错、各说各的再重新对上、用口头禅或小名互怼；不要每句都接得严丝合缝像在念对白稿。
  - 欲言又止：全片至少 3~4 处把话说到一半改成破折号或省略号，或先答非所问再绕回来。${craftAnchors ? `\n${craftAnchors}` : ''}${termHint}

## 写完后自检（不要输出自检过程）
- 总句数是否在 ${Math.max(10, Math.round(budget * 0.92))}~${Math.max(14, Math.round(budget * 1.2))} 句？
- 是否有自然的 2~3 句连说、足够短反应与 3~6 句 \`（……）\` 内心独白？
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
    meta: {
      sceneId?: unknown
      pauseBefore?: unknown
      closeWindowAfter?: unknown
      windowDisplayMode?: unknown
      effect?: unknown
    } = {}
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
    const windowDisplayMode = str(meta.windowDisplayMode).trim()
    const rawEff = str(meta.effect).trim()
    const effect =
      rawEff === 'Normal' || rawEff === 'Internal' || rawEff === 'Overlap' ? rawEff : undefined
    lines.push({
      id: `l${lines.length + 1}`,
      speaker: member.name,
      content: text,
      ...(emotion ? { emotion } : {}),
      ...(sceneId ? { sceneId } : {}),
      ...(pauseBefore > 0 ? { pauseBefore } : {}),
      ...(closeWindowAfter ? { closeWindowAfter: true } : {}),
      ...(windowDisplayMode ? { windowDisplayMode } : {}),
      ...(effect ? { effect } : {})
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
                : false,
            windowDisplayMode: isRecord(rawLine) ? rawLine.windowDisplayMode : turn.windowDisplayMode,
            effect: isRecord(rawLine) ? rawLine.effect : turn.effect
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
        closeWindowAfter: item.closeWindowAfter,
        windowDisplayMode: item.windowDisplayMode,
        effect: item.effect
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
  const budget = lineBudget(options.targetMinutes)
  const maxBudgetLines = Math.max(14, Math.round(budget * 1.2))
  const effectiveRequired = Math.min(requiredLines, Math.max(10, Math.round(budget * 1.05)))
  const upper = Math.min(
    maxBudgetLines,
    Math.max(effectiveRequired + 2, Math.round(effectiveRequired * 1.15))
  )
  const effectiveRequiredChars =
    requiredChars > 0 ? Math.min(requiredChars, Math.round(budget * 20)) : 0
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
  const charRule = effectiveRequiredChars
    ? `- 总字数控制在 ${effectiveRequiredChars}~${Math.round(budget * 24)} 字（上一轮约 ${actualChars} 字），平均每句 16~20 字；`
    : ''
  const actualMean = actualLines > 0 ? (actualChars / actualLines).toFixed(1) : '0'
  const longRule = effectiveRequiredChars
    ? `- 上一轮平均每句只有 ${actualMean} 字；这一轮把部分碎句充实到 15 字以上，2~6 字短反应占约 1/6 即可。`
    : ''
  const castNames = plan.cast.map((c) => c.name).join('、')
  const lengthProblemNote =
    actualLines >= effectiveRequired
      ? `上一轮已有 ${actualLines} 句台词（已达到约 ${budget} 句目标），但总字数略少（约 ${actualChars} 字）。请保持总句数严格在 ${Math.max(actualLines, effectiveRequired)}~${upper} 句以内，仅适度充实过于单薄的句子，**严禁为了凑字数增加多余独白或拉长超过 ${upper} 句**：`
      : `上一轮只写了 ${actualLines} 句台词${effectiveRequiredChars ? `、约 ${actualChars} 字` : ''}，\n少于要求的 ${effectiveRequired} 句${effectiveRequiredChars ? ` / ${effectiveRequiredChars} 字` : ''}。请保留原来的小事件和人物关系，\n重写一份完整台词稿：\n- 总句数严格控制在 ${effectiveRequired}~${upper} 句（目标约 ${budget} 句，禁止超预算注水），仍然用 turns 结构，每个 turn 1~6 条 lines；`
  return {
    system: base.system,
    user: `${base.user}\n\n## 上一轮的问题
${lengthProblemNote}
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
      '3. 严禁把真正的情绪爆发、哭腔、喊叫、脆弱道歉或震惊错标为「平静」；哭泣/悲伤对峙途中即便出现安抚（「没关系的」）、克制解释或绝望叹息（「可窗户纸一旦破了，我就再也没办法安心笑出来了」），也必须全段持续保持「伤心」，绝不中途掉回「平静」；只有到真正释怀和解或夕阳余韵收尾时，才允许自然过渡到舒缓的「平静」或「开心」。',
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
  - 伤心：失落、脆弱倾诉、愧疚、哽咽、含泪恳求，以及哭戏途中强忍泪水安慰对方（「没关系的」）、无奈解释（「大家都太温柔了」）或绝望吐露——**哭戏未真正释怀和解前全段保持「伤心」，严禁中途掉回「平静」**。
  - 结尾呼吸感与余韵过渡：当冲突在结尾真正走向释怀、夕阳缓和或安静接纳时（如「夕阳沉下去了」「再等我一会儿」），允许结尾数句自然过渡到柔和释放的「平静」或「开心」（搭配安堵/温柔的 ttsCaption），让情绪弧光有呼吸落点，不要把整场几十句锁死在单一哭腔。
  - 生气：争执、嘴硬反驳、委屈发火、情绪激动地质问或焦急大喊；**严禁因前文在打趣就把突然认真/反驳/斥责的急停句（如「别岔开话题！」「别开玩笑了！」「够了！」）惯性标成「开心」，必须立刻切回「生气」或「平静」**。
  - 害羞：被夸、慌张掩饰、不好意思。
  - 惊讶：突然的揭示、意外、倒吸一口气或惊呼。
  - 同一情绪拍内保持粗标签连贯，避免无意义的逐句 A/B 抖动或哭戏途中掉回「平静」；遇到真正的情感转折、哭诉、结尾释怀或欢快收尾时忠实切换。
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
    const rawSpecialScene =
      typeof item.ttsSpecialScene === 'boolean'
        ? item.ttsSpecialScene
        : typeof item.specialScene === 'boolean'
          ? item.specialScene
          : false
    const calmWithoutIntensityCue =
      emotion === '平静' &&
      !/[！!]{2}|泣|叫|呜|耳语|ささや|嗚咽/.test(line.content) &&
      !/耳語|ささや|泣|叫|嗚咽|震え/.test(ttsCaption ?? '')
    const ttsSpecialScene = rawSpecialScene && !calmWithoutIntensityCue
    const rawSpeed = item.ttsSpeed ?? item.speed
    const parsedSpeed =
      typeof rawSpeed === 'number' && Number.isFinite(rawSpeed)
        ? rawSpeed
        : typeof rawSpeed === 'string' && rawSpeed.trim() && Number.isFinite(Number(rawSpeed))
          ? Number(rawSpeed)
          : undefined
    const clampedSpeed =
      parsedSpeed !== undefined
        ? clampVoiceSpeed(
            emotion === '平静' ? Math.min(1.05, Math.max(0.95, parsedSpeed)) : parsedSpeed,
            ttsSpecialScene
          )
        : undefined
    const ttsSpeed = clampedSpeed !== undefined ? Number(clampedSpeed.toFixed(2)) : undefined

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
  if (emotion === '生气') {
    return /！！|!!|住口|够了|闭嘴|混蛋|别岔开话题|别转移话题|别开玩笑|别敷衍|别装|少啰嗦|别闹了|やめろ|ふざけ/.test(
      text
    )
  }
  if (emotion === '平静') {
    return /别岔开话题|别转移话题|别开玩笑|别敷衍|我是认真的|认真一点|冷静/.test(text)
  }
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

  // 5) 防止哭戏/悲伤或争执途中短段（1~4句）意外掉回「平静」：前后同处于「伤心」/「生气」弧光且无真正释怀/欢快收尾时保持情绪连贯
  const isDenseTenseEmotion = (emo: string): boolean => emo === '伤心' || emo === '生气'
  for (let start = 1; start < lines.length - 1; start++) {
    if (values[start] !== '平静') continue
    let end = start
    while (end + 1 < lines.length - 1 && values[end + 1] === '平静') {
      end += 1
    }
    const spanLen = end - start + 1
    if (spanLen <= 4) {
      const spanScene = lines[start].sceneId
      let leftTense = ''
      for (let l = start - 1; l >= Math.max(0, start - 3); l--) {
        if (spanScene && lines[l].sceneId && lines[l].sceneId !== spanScene) break
        if (isDenseTenseEmotion(values[l])) {
          leftTense = values[l]
          break
        }
        if (values[l] !== '惊讶' && values[l] !== '害怕') break
      }
      let rightTense = ''
      for (let r = end + 1; r <= Math.min(lines.length - 1, end + 3); r++) {
        if (spanScene && lines[r].sceneId && lines[r].sceneId !== spanScene) break
        if (isDenseTenseEmotion(values[r])) {
          rightTense = values[r]
          break
        }
        if (values[r] !== '惊讶' && values[r] !== '害怕') break
      }
      if (leftTense && rightTense) {
        const hasResolution = lines
          .slice(start, end + 1)
          .some((l) => isGenuineCalmResolution(l.content))
        if (!hasResolution) {
          const fillEmotion = leftTense === '伤心' || rightTense === '伤心' ? '伤心' : leftTense
          for (let k = start; k <= end; k++) {
            values[k] = fillEmotion
          }
        }
      }
    }
    start = end
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

  const prevSpeedBySpeaker = new Map<string, number>()
  return {
    ...dialogue,
    lines: dialogue.lines.map((line) => {
      const entry = plan?.get(line.id)
      const emotion = stableEmotions?.get(line.id) ?? entry?.emotion ?? ''
      const finalEmotion = allowed.size === 0 ? emotion : allowed.has(emotion) ? emotion : ''
      const ttsCaption = entry?.ttsCaption ? sanitizeIrodoriCaption(entry.ttsCaption) : ''
      const rawSpecialScene = Boolean(entry?.ttsSpecialScene)
      const ttsSpecialScene =
        rawSpecialScene &&
        (finalEmotion !== '平静' ||
          /[！!]{2}|泣|叫|呜|耳语|ささや|嗚咽/.test(line.content) ||
          /耳語|ささや|泣|叫|嗚咽|震え/.test(ttsCaption))
      let ttsSpeed =
        typeof entry?.ttsSpeed === 'number' && Number.isFinite(entry.ttsSpeed)
          ? clampVoiceSpeed(
              finalEmotion === '平静'
                ? Math.min(1.05, Math.max(0.95, entry.ttsSpeed))
                : entry.ttsSpeed,
              ttsSpecialScene
            )
          : undefined
      if (ttsSpeed !== undefined && !ttsSpecialScene) {
        const lastSpeed = prevSpeedBySpeaker.get(line.speaker)
        if (lastSpeed !== undefined && Math.abs(ttsSpeed - lastSpeed) > 0.08) {
          ttsSpeed = lastSpeed + Math.sign(ttsSpeed - lastSpeed) * 0.08
        }
        ttsSpeed = Number(clampVoiceSpeed(ttsSpeed, false).toFixed(2))
      } else if (ttsSpeed !== undefined) {
        ttsSpeed = Number(ttsSpeed.toFixed(2))
      }
      if (ttsSpeed !== undefined) {
        prevSpeedBySpeaker.set(line.speaker, ttsSpeed)
      }
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
    return applyVoiceDirectionPlan(dialogue, plan as Map<string, StagedVoiceDirectionLine>, labels)
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
      str(item.content ?? item.text ?? item.line)
        .replace(/\\n/g, '\n')
        .trim()
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

  const firstSe = view.seDetailsList()[0]?.file ?? 'se00053_b.mp3'
  const example = {
    scenes: [
      {
        id: 's1',
        fromLineId: 'l1',
        background: plan.background || view.defaultImage() || 'bg_room.jpg',
        ambient: 'normal',
        transitionIn: 'black',
        activeCast: plan.cast.slice(0, Math.min(2, plan.cast.length)).map((c) => c.name),
        bgm: firstBgm || ''
      }
    ],
    events: [
      {
        lineId: midLine,
        pauseBefore: 1.0,
        stageGroup: {
          activeCast: [plan.cast[0]?.name ?? '']
        },
        ...(secondBgm ? { bgmCut: { action: 'play', file: secondBgm, fadeMs: 900 } } : {})
      },
      {
        lineId: lateLine,
        se: { file: firstSe, timing: 'before' },
        silentReaction: { modelId: plan.cast[0]?.modelId ?? 1 }
      }
    ]
  }

  const presenceRule =
    plan.cast.length === 2
      ? '- **双人动态聚焦切镜（单人 Center <-> 双人 Left/Right，一律原地淡入淡出）**：本场 2 人，除开场双人同框（Left/Right）外，要善用 `events[].stageGroup` 进行干净的镜头聚焦切换——每当出现内心独白（`（……）`）、情绪转折/坦白单人重音句、或需要拉近倾听/压迫感时，**在第一句就用 `events[].stageGroup` 短暂切到单人 Center**（`activeCast: [角色名]`，先双人同时 `LayoutClear` 原地淡出，再 `LayoutAppear(Center)` 原地淡入，**严禁 `Move` 横向滑动**），并在 1~4 句后切回双人 Left/Right 同框（整场 35 句约安排 3~6 次单双人焦点切换）。同一时间地点连续对话只写 1 幕（s1），仅切换地点、跳过时段、切入回忆或出入 SEKAI 时再新开幕次。'
      : '- **多人动态分组与单人特写切镜（Normal 模式 <=2 人同台）**：本场 >=3 人，始终保持 `Normal` 模式（Left / Right 双人或单人 Center），积极利用 `events.stageGroup` 随着对话焦点在 1 人特写（Center）与 2 人同框（Left/Right）之间通过 `LayoutClear` + `LayoutAppear` 原地淡出淡入轮换（约 24~35 次入出场节奏），严禁 3 人以上同时挤在台上，也严禁横向滑动。同一时间地点无需硬拆幕次，仅切换地点/时段/回忆/SEKAI 时再新开幕。'

  return {
    system: [
      '你是 Project SEKAI 官方演出的舞台监督与摄影导演（directStaging）。',
      '台词已经定稿；你负责规划幕次转场（Telop/PlaceInfo/SideFade/Flashback/Sekai）、原地单双人切镜（stageGroup）、音效（PlaySe）、镜头/震动、虚拟歌手全息与 BGM 静音切停。',
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
- **严禁滑动入出场与横向滑位**：所有 \`LayoutAppear\` / \`LayoutClear\` 必须原地渐变淡入淡出（\`from.side === to.side, offset: 0\`），禁止使用 \`walkInCast\` / \`walkOutCast\` / \`LeftOver\` / \`RightOver\` 画外滑入滑出，也禁止 \`Move\` 左右偏移滑行或从 Left/Right 滑到 Center。
- **克制镜头、震动与开场字幕条（严禁每场套模板）**：
  - 说话后需要角色沉默留白或低头反应时，设 \`silentReaction: { modelId }\`（无需强行把 \`closeWindowAfter: true\` 挂在紧接瞬时动作之前）；仅在停顿 \`Wait >= 300ms\` 或场景/幕次切换前才设置 \`closeWindowAfter: true\`。
  - **镜头（CameraZoom / CameraMove）克制原则**：官方日常谈心、后台会议、安静独白场次大多 **0~1 次**（切忌平均塞 4~8 次推进平移！）；仅在真正的高潮爆发、重大揭示或舞台演出切镜时用 \`1~3\` 次，且高潮过后及时用 \`zoomReset\` 复位。
  - **震动（CharacterShake / ShakeWindow / ShakeScreen）极稀缺**：\`CharacterShake\` 仅在真实物理碰撞或猛然吓一跳时偶用（日常对话/安静谈心禁用）；\`ShakeWindow\` / \`ShakeScreen\` 仅用于大喊/突发惊吓。
  - **开场 Telop / PlaceInfo 按需选用**：仅在时间/地点需要明确交代或跳幕时才写 \`telop\` / \`placeInfo\`，安静延续或私密谈心可直接入戏，不必每场千篇一律加 \`Telop + PlaceInfo\`。
  - 虚拟歌手在现实场景现身或远程通话时，在 \`hologramCast\` 或 \`hologram: { modelId, enabled: true }\` 启用 \`hologram\` 着色器。
- **特效与转场**：跳时间/换场地优先善用 \`SideFade\`（\`transitionIn: "sideFade"\`），回忆段务必配 \`transitionIn: "flashback"\`, \`isFlashback: true\`（自动接 \`WhiteOut -> se00053_b -> FlashbackIn -> WhiteIn\`），时段/氛围变化用 \`ambient\`（\`normal\`/\`evening\`/\`night\`），出入 SEKAI 用 \`sekaiIn\`/\`sekaiOut\`，天候粒子用（${CURATED_SCENARIO_EFFECTS.join('/')}）。
- **BGM 与停顿节奏**：首幕（s1）必须从可用 BGM 清单选定契合开场氛围的曲目（例如追逐/对峙/低落选戏剧或沉重曲，日常/喜剧选轻快日常曲）；若刻意做冷开场，最多留 2~4 句静音并在第 5 句（l5）前用 \`bgmCut\` 切入 BGM，**严禁前段大段无声**。大部分台词 \`delay: 0\`，只把 1.0/1.5 秒停顿放在关键沉默句的 \`pauseBefore\`。中后段转折前可将幕次 \`bgm\` 或 \`bgmCut\` 设为 \`silence\`（\`bgm00000\` 静音），留白 2~4 句后再接入第二首 BGM。
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
    let activeCast = resolveCastIds(ps.activeCast, plan, view)
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
      ...(ps.placeInfo ? { placeInfo: ps.placeInfo } : {}),
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

function pickOpeningBgmForScene(
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  sceneSummary = ''
): string {
  const queryParts = [
    plan.event,
    plan.logline,
    plan.understanding?.emotionalArc ?? '',
    sceneSummary,
    ...dialogue.lines.slice(0, 12).map((l) => `${l.emotion ?? ''} ${l.content}`)
  ].filter(Boolean)
  const query = queryParts.join(' ')
  const choices = view.bgmPromptChoices(36, query)
  const pool =
    choices.length > 0
      ? choices
      : view.bgmDetailsList().filter((detail) => (detail.description ?? '').trim().length > 0)
  if (pool.length === 0) return ''

  const openingEmos = dialogue.lines.slice(0, 12).map((l) => (l.emotion ?? '').trim())
  const tenseCue =
    openingEmos.some((e) => e === '伤心' || e === '生气' || e === '害怕') ||
    /追|逃|对峙|冲突|吵|哭|泪|道歉|告别|压抑|低沉|沉重|紧张|不安|严肃|秘密|隐瞒|害怕|悬疑|暗涌|夜晚|深夜|暴雨|雨/.test(
      query
    )
  const warmCue =
    !tenseCue &&
    (openingEmos.some((e) => e === '开心') ||
      /日常|轻松|温馨|闲聊|笑|搞笑|玩笑|派对|排练|零食|下午茶|阳光|早安|开心|欢快/.test(query))

  let best = pool[0]
  let bestScore = -Infinity
  for (let idx = 0; idx < pool.length; idx++) {
    const item = pool[idx]
    const hay =
      `${item.file} ${item.name} ${item.mood ?? ''} ${item.category ?? ''} ${item.description} ${(item.tags ?? []).join(' ')}`.toLowerCase()
    let score = -idx * 0.01
    if (tenseCue) {
      if (
        /低沉|克制|压抑|悲伤|感伤|忧郁|紧绷|紧张|紧迫|暗涌|悬疑|冲突|告[白别]|沉重|严肃|dramatic|tense|sad|melanchol|thorns/i.test(
          hay
        )
      ) {
        score += 20
      }
      if (/日常|闲聊|温馨|轻松|欢快|搞笑|喜剧|轻缓|居家/i.test(hay)) {
        score -= 10
      }
    } else if (warmCue) {
      if (/轻松|日常|温暖|温馨|欢快|元气|活泼|轻缓|居家|搞笑|slapstick/i.test(hay)) {
        score += 20
      }
      if (/压抑|低沉|悲伤|紧绷|冲突|告别/i.test(hay)) {
        score -= 10
      }
    } else {
      if (/轻松|日常|轻缓|温暖|平稳|宁静/i.test(hay)) {
        score += 8
      }
    }
    if (score > bestScore) {
      bestScore = score
      best = item
    }
  }
  return best.file
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

  // 开场首幕 BGM 兜底：长场次禁止因 scene0.bgm 留空或无效 silence 导致前几分钟全程无声；
  // 仅当刻意冷开场并在第 5 句（index <= 5）前显式切入 BGM 时才允许 scene0 静音开场。
  if (lines.length >= 6 && staging.scenes.length > 0) {
    const scene0 = staging.scenes[0]
    const hasEarlyBgmPlay =
      staging.events.some(
        (ev) => ev.lineIndex <= 5 && ev.bgmCut?.action === 'play' && Boolean(ev.bgmCut.file)
      ) ||
      staging.scenes
        .slice(1)
        .some(
          (s) => s.fromIndex <= 5 && Boolean(s.bgm) && s.bgm !== 'silence' && s.bgm !== 'keep'
        )
    const missingOrLongSilence =
      !scene0.bgm || scene0.bgm === 'keep' || (scene0.bgm === 'silence' && !hasEarlyBgmPlay)
    if (missingOrLongSilence) {
      const openingBgm = pickOpeningBgmForScene(view, plan, dialogue, plan.scenes?.[0]?.summary ?? '')
      if (openingBgm) {
        scene0.bgm = openingBgm
      }
    }
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

  // 思考/内心独白切镜对齐：绝不在第一句独白仍站在 Left/Right，到第二句才切 Center
  if (plan.cast.length >= 2) {
    const isThinkingLine = (line: StagedDialogueLine): boolean =>
      line.windowDisplayMode === 'Thinking' ||
      line.effect === 'Internal' ||
      isInternalThoughtContent(line.content)
    const isExplicitThinking = (line: StagedDialogueLine): boolean =>
      line.windowDisplayMode === 'Thinking' || line.effect === 'Internal'

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!isThinkingLine(line)) continue
      const speakerMember = plan.cast.find((c) => c.name === line.speaker)
      if (!speakerMember) continue
      const evCurr = eventsByLine.get(i)
      // 若第二句独白才有 stageGroup=[speaker]，提前到第一句独白
      if (!evCurr?.stageGroup && i + 1 < lines.length) {
        const nextLine = lines[i + 1]
        const evNext = eventsByLine.get(i + 1)
        if (
          nextLine.speaker === line.speaker &&
          isThinkingLine(nextLine) &&
          evNext?.stageGroup?.activeCast.length === 1 &&
          evNext.stageGroup.activeCast[0] === speakerMember.modelId
        ) {
          ensureEvent(i).stageGroup = { ...evNext.stageGroup }
          delete evNext.stageGroup
        }
      }
      // 显式 Thinking/Internal 或 >=2 句同人连续括号内心独白（无 stageGroup）时自动切到 Center，并在独白结束恢复双人
      let runEnd = i
      while (
        runEnd + 1 < lines.length &&
        lines[runEnd + 1].speaker === line.speaker &&
        isThinkingLine(lines[runEnd + 1])
      ) {
        runEnd += 1
      }
      const hasGroupInRun = Array.from({ length: runEnd - i + 1 }, (_, off) =>
        eventsByLine.get(i + off)?.stageGroup
      ).some(Boolean)
      if (!hasGroupInRun && (isExplicitThinking(line) || runEnd > i)) {
        ensureEvent(i).stageGroup = { activeCast: [speakerMember.modelId] }
      }
      i = runEnd
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

  // 长篇剧本（>=16句）若模型未出 SE，按台词语义轻度补齐（严禁自动注入 Move 横向滑动）
  if (lines.length >= 16) {
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
        const resolved = cue ? resolveRegisteredSeFile(view, cue)?.file ?? null : null
        if (resolved && !seHits.some((h) => Math.abs(h.idx - i) < 6)) {
          seHits.push({ idx: i, file: resolved })
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
    let activeCast = resolveCastIds(item.activeCast ?? item.cast, plan, view)
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
      }
    }

    if (isRecord(item.move)) {
      const m = resolveModel(view, [], item.move.modelId ?? item.move.speaker ?? lines[idx].speaker)
      if (m && plan.cast.some((c) => c.modelId === m.id)) {
        const toSideRaw = str(item.move.toSide)
        const toSide =
          toSideRaw === 'Left' || toSideRaw === 'Center' || toSideRaw === 'Right'
            ? toSideRaw
            : undefined
        if (toSide && !isRecord(item.stageGroup)) {
          // 若模型仍写了 shiftSlot 到 Center，转为 stageGroup 原地渐变切镜，禁止 Move 滑动
          if (toSide === 'Center') {
            ev.stageGroup = { activeCast: [m.id] }
          }
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
      const file = resolveRegisteredSeFile(view, rawSe)?.file ?? null
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

    if (plan.cast.length >= 2 && isRecord(item.stageGroup)) {
      const activeCast = resolveCastIds(
        item.stageGroup.activeCast ?? item.stageGroup.cast,
        plan,
        view
      )
      if (activeCast.length > 0) {
        ev.stageGroup = {
          activeCast
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
    .map((member) => {
      const profile =
        typeof personasStagedApi.characterActingProfile === 'function'
          ? personasStagedApi.characterActingProfile(member.name, member.role)
          : null
      const note = profile?.actingNote ? `（演技特点：${profile.actingNote}）` : ''
      return `- ${member.name}（modelId=${member.modelId}）${member.role ? ` — ${member.role}` : ''}${note}`
    })
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

  const extView = view as CatalogView & { annotatedMotionList?: (modelIds?: number[]) => string }
  const motionLines =
    typeof extView.annotatedMotionList === 'function'
      ? extView.annotatedMotionList(plan.cast.map((c) => c.modelId))
      : plan.cast
          .map((member) => {
            const model = view.modelById(member.modelId)
            const names = model ? view.promptMotions(model) : []
            const annotated = names.map((name) => annotateMotionForDirection(model?.path, name))
            return `${member.name}(${member.modelId})：${annotated.length ? annotated.join('，') : '（无）'}`
          })
          .join('\n')

  const facialLines = plan.cast
    .map((member) => {
      const model = view.modelById(member.modelId)
      const names = model ? view.promptFacials(model) : []
      const annotated = names.map((name) => annotateFacialName(model?.path, name))
      return `${member.name}(${member.modelId})：${annotated.length ? annotated.join('，') : '（无）'}`
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

  const officialActingNote =
    typeof corpusStagedApi.getOfficialActingGuidelines === 'function'
      ? `\n${corpusStagedApi.getOfficialActingGuidelines({ castCount: plan.cast.length })}\n`
      : ''

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
${formatDirectingAnchorBlock(plan)}${officialActingNote}
出场角色：
${castLines}${formatWorldviewCueBlock(options.ragContext)}

## 台词稿（逐字，只能引用 id，不能改字）
${dialogueLines}

## 动作/表情关键词（名称由英文语义 + 编号组成；直接输出完整名称）
- 动作：nod 点头 / tilthead 歪头 / shakehead 摇头 / glad 高兴 / sad 难过 / trouble 为难 / shy 害羞 / blushed 脸红 / sigh 叹气 / relief 松口气 / think 思考 / lookaway 移开视线 / angry 生气 / forward 前倾 / fidget 局促 / greeting 打招呼 / smug 得意 / wink 眨眼 / pose 摆姿势 / default 默认站姿（sleep 困倦 / delicious 好吃 仅限真实睡眠或吃喝台词，平时禁用）
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
- **静默反应**：官方全量剧本里，台词之外的独立 Motion 约每 2 句 1 个；本场每 2~4 句可安排 1 个 \`silentMotion\`（听者反应、环境小动作或停顿），让双方表演自然接力。
- **听者反应对齐官方 PJSK（禁止句中错峰刷屏与情绪倒错）**：同一句 \`Talk\` 绝不同时触发说话者与听者的身体动作；当 A 连续说话时，听者 B 优先仅切 **纯表情（只写 \`facial\`，不写 \`motion\`）** 在 \`at: 0\` 自然过渡，或仅在真正情绪转折点通过 \`silentMotion\` / 独立 \`Motion\` 片段表现听者身体反应。**必须从听者自身视角出发**（如认真倾听、担忧、为难、若有所思、温和回应），绝不把说话者的「生气」「害怕」直接复制到挨骂或被倾诉的听者脸上；**若听者刚才还处于「生气」或「伤心」，即使说话者强颜欢笑打岔，听者也严禁切回 \`face_smile_*\` 笑脸**。
- **表情严格贴合语境与括号语义**：务必看清上方表情清单括号里的具体含义（例如 \`face_smile_05(苦笑/勉强笑)\`、\`face_trouble_02(苦笑/嘴角上扬)\`、\`face_closeeye_02(闭眼微笑)\`、\`face_darknormal_01(阴沉面无表情)\`），悲伤/哭泣/生气/道歉/沉重对峙语境严禁错选真笑、含泪微笑或嘴角上扬表情（除非台词明确写到苦笑/含泪安抚微笑）。${
      hasEmotionTags
        ? '〔情绪〕只代表 TTS 语音基调，**严禁把〔平静〕死板锁死在 face_normal_01**！即使在〔平静〕段内，也要根据每句台词的实际语气细腻切换微表情：温和/寒暄/赞同/调侃用真正的微笑或俏皮；认真/思索/倾听用 serious / closeeye / smallmouth / notice；无奈/窘迫/犹豫用 trouble / lookaway / worry / 苦笑；只有毫无波澜的平铺陈述才用 normal。'
        : '随每句台词语气细腻切换表情：温和/寒暄/赞同用微笑；认真/思索用 serious / closeeye / smallmouth；无奈/犹豫用 trouble / lookaway / worry；开心/伤心/生气/惊讶/害羞严格对应各自语义表情。'
    }
- **哭戏/高潮持续表情与结尾呼吸感**：在哭泣/崩溃/泪目表白段落（连续 4~8+ 句），应持续保持 \`face_cry_*\` / \`face_sad_*\` 哭泣神情，期间通过微妙身体动作或省略 \`motion\` 保持情绪连贯，**严禁每句机械乱跳表情（如哭泣途中有事无事切回 face_closeeye_01 或 face_trouble_02）**；当剧情临近结尾真正走向夕阳缓和、释怀或安静接纳时，允许过渡到舒缓释放的神情（如微闭眼/轻柔倾听/释然神态）让情绪弧光自然落地。日常段同一角色跨句延续同一表情也很自然，善用角色丰富的动作变体与贴合气氛的跨风格动作（不必锁死 4~5 个动作循环）；**朝比奈真冬**保持克制内敛的表情与动作。
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

  // 听者反应预算：长对话保留约 18%（>=6 句至少 1 条），允许在双人对话中错峰回应，避免一方长期僵立。
  const maxListeners =
    dialogue.lines.length < 6 ? 0 : Math.max(1, Math.round(dialogue.lines.length * 0.18))
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
  const scenes = staging?.scenes ?? []
  const hasSoloScene = scenes.some((s) => s.activeCast.length === 1)
  if (plan.cast.length === 2 && !hasSoloScene && scenes.length <= 1) {
    return [{ from: 0, to: last, mode: 'duo', castIds: plan.cast.map((c) => c.modelId) }]
  }
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
    consecutiveSameBodyMotion: number
    lastFacial: string
    lastSpeakingFacial: string
    consecutiveSameFacial: number
    lastSpeakingWasShortWithMotion: boolean
    recentBodyMotions: string[]
    speakingCountSinceAppear: number
    linesSinceLastBodyMotion: number
  }
  const totalBodyMotions = new Map<number, number>()
  const storyMotionCounts = new Map<number, Map<string, number>>()
  const getOverusedMotions = (modelId: number, extra?: ReadonlyArray<string>): Set<string> => {
    const out = new Set<string>(extra ?? [])
    const counts = storyMotionCounts.get(modelId)
    if (counts) {
      for (const [m, c] of counts) {
        if (c >= 2) out.add(m)
      }
    }
    return out
  }
  const preferredSide = new Map<number, 'Left' | 'Right'>()
  if (cast.length === 2) {
    preferredSide.set(cast[0].modelId, 'Left')
    preferredSide.set(cast[1].modelId, 'Right')
  }
  const onStage = new Map<number, StageActorState>()
  const trackActorBodyMotion = (
    st: StageActorState | undefined,
    motionName: string,
    modelId?: number
  ): void => {
    if (!st || !motionName) return
    st.consecutiveSameBodyMotion =
      st.lastBodyMotion === motionName ? st.consecutiveSameBodyMotion + 1 : 1
    st.lastBodyMotion = motionName
    st.linesSinceLastBodyMotion = 0
    if (modelId !== undefined) {
      totalBodyMotions.set(modelId, (totalBodyMotions.get(modelId) ?? 0) + 1)
      let actorCounts = storyMotionCounts.get(modelId)
      if (!actorCounts) {
        actorCounts = new Map<string, number>()
        storyMotionCounts.set(modelId, actorCounts)
      }
      actorCounts.set(motionName, (actorCounts.get(motionName) ?? 0) + 1)
    }
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
  let cameraZoomDirty = false
  let cameraMoveDirty = false
  let shakeScreenActive = false
  let lastSpeakerId: number | null = null
  const lastEmotionByActor = new Map<number, string>()
  let lastSilentReactionLine = -10
  let lastSilentReactionTargetId: number | null = null
  let silentReactionsEmitted = 0
  let thinkingSoloReturnCast: number[] | null = null
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
    if (!cameraZoomDirty && !cameraMoveDirty) return
    if (cameraZoomDirty) {
      snippets.push({
        type: 'CameraZoom',
        wait: !cameraMoveDirty,
        progressBehavior: !cameraMoveDirty ? 'WaitFinished' : 'Now',
        delay: 0,
        data: { scale: 1, duration: 400, ease: 'OutQuad' }
      })
      cameraZoomDirty = false
    }
    if (cameraMoveDirty) {
      snippets.push({
        type: 'CameraMove',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: { x: 0, y: 0, duration: 400, ease: 'OutQuad' }
      })
      cameraMoveDirty = false
    }
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

  const clearActors = (ids: number[], _walkOutSet = new Set<number>()): number => {
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
      snippets.push({
        type: 'LayoutClear',
        wait: idx === 0,
        progressBehavior: idx === 0 ? 'WaitFinished' : 'Now',
        delay: 0,
        data: {
          modelId: id,
          from: { side: state.side, offset: 0 },
          to: { side: state.side, offset: 0 },
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
      // 若从 Center 切回双人，优先还原角色原本习惯的 Left/Right 槽位
      for (const id of validIds) {
        if (desiredSlotFor.has(id)) continue
        const pref = preferredSide.get(id)
        if (pref && freeSlots.includes(pref)) {
          desiredSlotFor.set(id, pref)
          freeSlots.splice(freeSlots.indexOf(pref), 1)
        }
      }
      for (const id of validIds) {
        if (!desiredSlotFor.has(id)) {
          const assigned = (freeSlots.shift() ?? 'Right') as 'Left' | 'Right'
          desiredSlotFor.set(id, assigned)
          preferredSide.set(id, assigned)
        }
      }
    }

    // 单人 Center <-> 双人 Left/Right 切镜统一采用「原地 LayoutClear 淡出 -> 原地 LayoutAppear 淡入」，严禁横向 Move 滑动
    const slotShiftedStates = new Map<number, StageActorState>()
    const outgoing: number[] = []
    for (const [id, st] of onStage.entries()) {
      const targetSide = desiredSlotFor.get(id)
      if (!validIds.includes(id) || (targetSide && st.side !== targetSide)) {
        outgoing.push(id)
        if (validIds.includes(id)) {
          slotShiftedStates.set(id, { ...st, recentBodyMotions: [...st.recentBodyMotions] })
        }
      }
    }
    if (outgoing.length > 0) closeWindowBeforeBreak()
    clearActors(outgoing)
    ensureNormalLayoutMode()

    const lineAtEntry = dialogue.lines[lineIndex]
    const directedAtEntry = lineAtEntry ? directionById.get(lineAtEntry.id) : undefined
    const incoming = validIds.filter((id) => !onStage.has(id))
    const usedEntryMotions = new Set<string>()
    incoming.forEach((id, idx) => {
      const slot = desiredSlotFor.get(id)!
      const prevShiftState = slotShiftedStates.get(id)
      // 所有入场严格使用原地渐变淡入（from == to, offset: 0），严禁 LeftOver/RightOver 滑入
      const fromPos = { side: slot, offset: 0 }
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
      const surroundingTense = dialogue.lines
        .slice(Math.max(0, lineIndex - 2), Math.min(dialogue.lines.length, lineIndex + 6))
        .some((l) => TENSE_EMOTION_SET.has(l.emotion ?? ''))
      const entryMemberPath = view.modelById(id)?.path
      const directedMotionOk =
        Boolean(directedMotion) &&
        !isStandingMotion(directedMotion!) &&
        isMotionCompatibleWithContext({
          motion: directedMotion!,
          modelPath: entryMemberPath,
          line: firstLineForMember ?? { content: '', emotion: surroundingTense ? '伤心' : '平静' },
          prevTense: surroundingTense,
          restrainedRole: isRestrainedRole(member?.role ?? '') || isRestrainedRole(member?.name ?? '')
        })
      const entryMotion = directedMotionOk
        ? directedMotion!
        : pickAppearFallbackMotion(
            view,
            id,
            getOverusedMotions(id, [...usedEntryMotions]),
            firstFutureTalkMotion,
            surroundingTense
          )
      if (entryMotion) usedEntryMotions.add(entryMotion)
      const firstLineIdx = firstLineForMember ? dialogue.lines.indexOf(firstLineForMember) : -1
      const entryPrecededByTense =
        firstLineIdx >= 0 ? isPrecededByTenseBeat(dialogue.lines, firstLineIdx) : surroundingTense
      const safeDirectedFacial = shouldAvoidIncongruousSmile(
        directedFacial,
        firstLineForMember ?? { content: '', emotion: '平静' },
        entryPrecededByTense
      )
        ? ''
        : directedFacial
      const shiftedModelPath = view.modelById(id)?.path
      const preservedShiftFacial =
        prevShiftState?.lastFacial &&
        !shouldAvoidIncongruousSmile(
          prevShiftState.lastFacial,
          firstLineForMember ?? { content: '', emotion: '平静' },
          entryPrecededByTense,
          { modelPath: shiftedModelPath }
        )
          ? prevShiftState.lastFacial
          : ''
      const entryFacial =
        safeDirectedFacial ||
        preservedShiftFacial ||
        (firstLineForMember
          ? pickSpeakerSubtleFacial(view, id, firstLineForMember, undefined, member?.role, {
              precededByTense: entryPrecededByTense,
              modelPath: shiftedModelPath
            })
          : '') ||
        (surroundingTense
          ? pickSpeakerSubtleFacial(
              view,
              id,
              { content: '', emotion: '平静' },
              undefined,
              member?.role,
              { precededByTense: true, modelPath: shiftedModelPath }
            )
          : '') ||
        view.exampleFacial(id) ||
        view.defaultFacial(id)
      const isHolo = hologramSet.has(id)
      const waitFirst = idx === 0
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
        lastBodyMotion: entryMotion || prevShiftState?.lastBodyMotion || '',
        consecutiveSameBodyMotion: entryMotion ? 1 : 0,
        lastFacial: entryFacial,
        lastSpeakingFacial: prevShiftState?.lastSpeakingFacial || '',
        consecutiveSameFacial: prevShiftState?.consecutiveSameFacial ?? 0,
        lastSpeakingWasShortWithMotion: false,
        recentBodyMotions: entryMotion
          ? [entryMotion]
          : prevShiftState?.recentBodyMotions ?? [],
        speakingCountSinceAppear: prevShiftState?.speakingCountSinceAppear ?? 0,
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
    let initialBgm = scene0.bgm || direction.bgm
    if (dialogue.lines.length >= 6 && (!initialBgm || initialBgm === 'keep' || initialBgm === 'silence')) {
      const hasEarlyBgmPlay =
        effectiveStaging.events.some(
          (ev) => ev.lineIndex <= 5 && ev.bgmCut?.action === 'play' && Boolean(ev.bgmCut.file)
        ) ||
        effectiveStaging.scenes
          .slice(1)
          .some(
            (s) => s.fromIndex <= 5 && Boolean(s.bgm) && s.bgm !== 'silence' && s.bgm !== 'keep'
          )
      if (!initialBgm || initialBgm === 'keep' || (initialBgm === 'silence' && !hasEarlyBgmPlay)) {
        const picked = pickOpeningBgmForScene(view, plan, dialogue, plan.scenes?.[0]?.summary ?? '')
        if (picked) initialBgm = picked
      }
    }
    applyBgmDirective(initialBgm, 600)
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

  // 控制停顿预算：保证 Talk.delay == 0 占比 >= 88%，满足官方 >=85% 节奏基线
  const maxDelayedTalks = Math.max(1, Math.floor(dialogue.lines.length * 0.12))
  let delayedTalkCount = 0

  for (let index = 0; index < dialogue.lines.length; index++) {
    const nextScene = sceneByStart.get(index)
    if (nextScene) {
      thinkingSoloReturnCast = null
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
    const isThinkingLine =
      line.windowDisplayMode === 'Thinking' ||
      line.effect === 'Internal' ||
      isInternalThoughtContent(line.content)

    // 多人戏若本句说话人尚未在场，安全入场或以 Normal 模式（<=2 人）原地淡出淡入切镜
    if (ev?.stageGroup && plan.cast.length >= 2) {
      const targetGroup = ev.stageGroup.activeCast.includes(member.modelId)
        ? ev.stageGroup.activeCast.slice(0, 2)
        : [member.modelId, ...ev.stageGroup.activeCast.slice(0, 1)]
      const prevIds = [...onStage.keys()]
      if (isThinkingLine && targetGroup.length === 1 && prevIds.length >= 2) {
        thinkingSoloReturnCast = prevIds
      } else {
        thinkingSoloReturnCast = null
      }
      appearActors(targetGroup, index, {
        walkInSet: new Set(ev.stageGroup.walkIn ?? []),
        walkOutSet: new Set(ev.stageGroup.walkOut ?? [])
      })
    } else if (!isThinkingLine && thinkingSoloReturnCast) {
      const restoreIds = thinkingSoloReturnCast.includes(member.modelId)
        ? thinkingSoloReturnCast
        : [member.modelId, ...thinkingSoloReturnCast.slice(0, 1)]
      thinkingSoloReturnCast = null
      appearActors(restoreIds, index)
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

    // 禁止任何横向 Move 滑动/偏移（原地渐变切镜已由 stageGroup 的 LayoutClear + LayoutAppear 处理）

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
    const rawTalkDelay = ev?.pauseBefore ?? line.pauseBefore ?? 0
    let talkDelay = rawTalkDelay
    if (talkDelay > 0) {
      if (delayedTalkCount < maxDelayedTalks) {
        delayedTalkCount += 1
      } else {
        talkDelay = 0
      }
    }
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
          getOverusedMotions(member.modelId, actorState.recentBodyMotions)
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

    // 防止说话人连续多句卡死在 face_normal_01 或同一表情，也防止表情/动作与剧情情绪冲突
    const cheerfulScene = isCheerfulComedyLines(dialogue.lines, index)
    const precededByTense = isPrecededByTenseBeat(dialogue.lines, index)
    const speakerModelPath = view.modelById(member.modelId)?.path
    const speakerRestrained = isRestrainedRole(member.role) || isRestrainedRole(member.name)
    if (actorState) {
      const speakerZeroAct = actions.find((a) => a.modelId === member.modelId && a.at === 0)
      const currentSpeakerFacial =
        typeof speakerZeroAct?.facial === 'string' ? speakerZeroAct.facial : undefined
      const allowStaleCheck = dialogue.lines.length >= 6 && direction.lines.length > 0
      const stuckOnNormal =
        !speakerRestrained &&
        allowStaleCheck &&
        Boolean(currentSpeakerFacial && /^face_normal/i.test(currentSpeakerFacial)) &&
        /^face_normal/i.test(actorState.lastSpeakingFacial || actorState.lastFacial)
      const currentFacialRole = currentSpeakerFacial
        ? inspectModelFacial(speakerModelPath ?? '', currentSpeakerFacial).role
        : 'neutral'
      const isSustainedSadCryLine =
        ['伤心', '害怕', '困惑'].includes(line.emotion ?? '') ||
        /哭|泪|哽咽|抽泣|对不起|求你|不要|别走|原谅|痛苦|难过|崩溃|受不了|委屈|悲伤/.test(
          line.content
        )
      const isSustainedCryRole =
        currentFacialRole === 'cry' ||
        currentFacialRole === 'sad' ||
        currentFacialRole === 'cold_hollow' ||
        (currentFacialRole === 'closed_troubled' && /^face_(cry|sad)/i.test(currentSpeakerFacial ?? ''))
      const repeatThreshold = isSustainedCryRole && isSustainedSadCryLine ? 8 : 2
      const staleRepeatedFacial =
        allowStaleCheck &&
        Boolean(currentSpeakerFacial) &&
        currentSpeakerFacial === actorState.lastSpeakingFacial &&
        actorState.consecutiveSameFacial >= repeatThreshold &&
        !(isSustainedCryRole && isSustainedSadCryLine)
      const incongruousSmile = shouldAvoidIncongruousSmile(
        currentSpeakerFacial,
        line,
        precededByTense,
        { modelPath: speakerModelPath, restrained: speakerRestrained }
      )
      if (stuckOnNormal || staleRepeatedFacial || incongruousSmile) {
        const varied = pickSpeakerSubtleFacial(
          view,
          member.modelId,
          line,
          actorState.lastSpeakingFacial || actorState.lastFacial,
          member.role,
          { precededByTense, modelPath: speakerModelPath, restrained: speakerRestrained }
        )
        if (varied && varied !== currentSpeakerFacial) {
          if (speakerZeroAct) {
            speakerZeroAct.facial = varied
          } else {
            actions.unshift({ at: 0, modelId: member.modelId, facial: varied })
          }
        }
      }

      // 校验说话者身体动作是否与剧情情绪冲突；仅在连续 >=4 句重复同一动作时温和切换，避免为了防重复乱切动作
      const speakerMotionAct = actions.find(
        (a) =>
          a.modelId === member.modelId && typeof a.motion === 'string' && a.motion.trim().length > 0
      )
      const currentSpeakerMotion =
        typeof speakerMotionAct?.motion === 'string' ? speakerMotionAct.motion.trim() : ''
      if (currentSpeakerMotion && speakerMotionAct) {
        const motionCompat = isMotionCompatibleWithContext({
          motion: currentSpeakerMotion,
          modelPath: speakerModelPath,
          line,
          prevTense: precededByTense,
          restrainedRole: speakerRestrained,
          cheerfulScene
        })
        const repeatedTooLong =
          allowStaleCheck &&
          (currentSpeakerMotion === actorState.lastBodyMotion &&
            actorState.consecutiveSameBodyMotion >= 4 ||
            ((storyMotionCounts.get(member.modelId)?.get(currentSpeakerMotion) ?? 0) >= 3 &&
              !(currentSpeakerMotion === actorState.lastBodyMotion && actorState.consecutiveSameBodyMotion <= 2)))
        if (!motionCompat || repeatedTooLong) {
          const replacement = pickFollowupMotion(
            view,
            member.modelId,
            currentSpeakerMotion,
            getOverusedMotions(member.modelId, actorState.recentBodyMotions),
            { line, prevTense: precededByTense, restrained: speakerRestrained }
          )
          if (replacement && replacement !== currentSpeakerMotion) {
            speakerMotionAct.motion = replacement
          } else if (!motionCompat) {
            delete speakerMotionAct.motion
          }
        }
      }
    }

    const nextLine = index + 1 < dialogue.lines.length ? dialogue.lines[index + 1] : undefined
    const nextSpeakerId = nextLine
      ? (cast.find((c) => c.name === nextLine.speaker)?.modelId ?? null)
      : null
    const nextEvent = index + 1 < dialogue.lines.length ? eventByIndex.get(index + 1) : undefined
    const nextTalkPause = nextEvent?.pauseBefore ?? nextLine?.pauseBefore ?? 0
    const nextDir = nextLine ? directionById.get(nextLine.id) : undefined
    const nextSpeakerHasImmediateMotion =
      nextTalkPause < 0.8 && Boolean(nextDir?.beats?.[0]?.motion ?? nextDir?.motion)

    let pendingListenerMotion: { modelId: number; motion?: string; facial?: string } | null = null
    if (
      directed?.listener &&
      directed.listener.modelId !== member.modelId &&
      onStage.has(directed.listener.modelId)
    ) {
      const listenerState = onStage.get(directed.listener.modelId)
      const listenerModelPath = view.modelById(directed.listener.modelId)?.path
      const listenerMember = cast.find((c) => c.modelId === directed.listener!.modelId)
      const listenerRestrained =
        isRestrainedRole(listenerMember?.role ?? '') || isRestrainedRole(listenerMember?.name ?? '')
      const listenerJustAppeared =
        Boolean(listenerState?.appearedWithMotion) &&
        index === (listenerState?.appearedAtLine ?? -99) &&
        (ev?.pauseBefore ?? 0) === 0
      const listenerJustHadStandalone: boolean =
        lastSilentReactionTargetId === directed.listener.modelId &&
        index === lastSilentReactionLine + 1 &&
        talkDelay < 0.8
      const listenerMotion: string | undefined =
        listenerJustAppeared || listenerJustHadStandalone ? undefined : directed.listener.motion
      const listenerPrecededByTense = precededByTense || TENSE_EMOTION_SET.has(line.emotion ?? '')
      const listenerPrevEmo = lastEmotionByActor.get(directed.listener.modelId) ?? ''
      const listenerPrevFacialRole = listenerState?.lastFacial
        ? inspectModelFacial(listenerModelPath ?? '', listenerState.lastFacial).role
        : 'neutral'
      const listenerHadTenseMood =
        listenerPrevEmo === '生气' ||
        listenerPrevEmo === '伤心' ||
        listenerPrevEmo === '害怕' ||
        listenerPrevFacialRole === 'angry' ||
        listenerPrevFacialRole === 'sad' ||
        listenerPrevFacialRole === 'cry' ||
        listenerPrevFacialRole === 'trouble' ||
        listenerPrevFacialRole === 'cold_hollow' ||
        listenerPrevFacialRole === 'closed_troubled'
      const listenerFacialRaw = directed.listener.facial
      const forbiddenTenseSmile =
        Boolean(listenerFacialRaw) &&
        (listenerHadTenseMood || listenerPrecededByTense) &&
        (SMILE_FACIAL_RE.test(listenerFacialRaw!) ||
          isSmileLikeFacial(listenerFacialRaw!, listenerModelPath))
      const listenerFacial =
        forbiddenTenseSmile ||
        shouldAvoidIncongruousSmile(listenerFacialRaw, line, listenerPrecededByTense, {
          modelPath: listenerModelPath,
          restrained: listenerRestrained
        })
          ? pickListenerReactionFacial(
              view,
              directed.listener.modelId,
              line,
              listenerMember?.role,
              listenerState?.lastFacial,
              {
                precededByTense: listenerPrecededByTense || listenerHadTenseMood,
                modelPath: listenerModelPath,
                restrained: listenerRestrained,
                listenerPrevEmotion: listenerPrevEmo
              }
            )
          : listenerFacialRaw
      const speakerBodyActedThisLine = actions.some(
        (a) =>
          a.modelId === member.modelId &&
          num(a.at) < 0.25 &&
          typeof a.motion === 'string' &&
          a.motion.trim().length > 0
      )
      if (listenerMotion || listenerFacial) {
        if (!listenerMotion || !speakerBodyActedThisLine || dialogue.lines.length < 6) {
          actions.push({
            at: 0,
            modelId: directed.listener.modelId,
            ...(listenerMotion ? { motion: listenerMotion } : {}),
            ...(listenerFacial ? { facial: listenerFacial } : {})
          })
        } else if (
          !ev?.silentReaction &&
          !directed?.silentMotion &&
          index < dialogue.lines.length - 1 &&
          !(directed.listener.modelId === nextSpeakerId && nextSpeakerHasImmediateMotion)
        ) {
          pendingListenerMotion = {
            modelId: directed.listener.modelId,
            ...(listenerMotion ? { motion: listenerMotion } : {}),
            ...(listenerFacial ? { facial: listenerFacial } : {})
          }
        }
      }
    }

    if (actorState) {
      actorState.speakingCountSinceAppear += 1
      actorState.appearedWithMotion = false
    }

    // 预判下一句是否会立即对 targetId 执行 LayoutClear（如独白切回双人、stageGroup 换人/换槽、三人轮换退场或切入下一幕），
    // 防止在即将 LayoutClear 前发射独立 Motion 造成 400ms 被腰斩异常。
    const willActorClearImmediatelyAfter = (
      targetId: number,
      includeSceneCurtain = true
    ): boolean => {
      if (!onStage.has(targetId)) return true
      const nextIndex = index + 1
      if (nextIndex >= dialogue.lines.length) return true
      if (sceneByStart.has(nextIndex)) return includeSceneCurtain
      const nLine = dialogue.lines[nextIndex]
      const nMember = cast.find((c) => c.name === nLine.speaker)
      if (!nMember) return false
      const nEv = eventByIndex.get(nextIndex)
      const nIsThinking =
        nLine.windowDisplayMode === 'Thinking' ||
        nLine.effect === 'Internal' ||
        isInternalThoughtContent(nLine.content)
      const currentSide = onStage.get(targetId)?.side

      let nextGroup: number[] | null = null
      if (nEv?.stageGroup && plan.cast.length >= 2) {
        nextGroup = nEv.stageGroup.activeCast.includes(nMember.modelId)
          ? nEv.stageGroup.activeCast.slice(0, 2)
          : [nMember.modelId, ...nEv.stageGroup.activeCast.slice(0, 1)]
      } else if (!nIsThinking && thinkingSoloReturnCast) {
        nextGroup = thinkingSoloReturnCast.includes(nMember.modelId)
          ? thinkingSoloReturnCast
          : [nMember.modelId, ...thinkingSoloReturnCast.slice(0, 1)]
      } else if (!onStage.has(nMember.modelId)) {
        if (plan.cast.length >= 3) {
          const currentIds = [...onStage.keys()]
          const keepId = currentIds.includes(member.modelId)
            ? member.modelId
            : currentIds[currentIds.length - 1]
          nextGroup =
            currentIds.length < 2 ? [...currentIds, nMember.modelId] : [keepId, nMember.modelId]
        } else {
          nextGroup = cast.map((c) => c.modelId)
        }
      }

      if (!nextGroup) return false
      const validNext = nextGroup.filter((id) => cast.some((c) => c.modelId === id)).slice(0, 2)
      if (validNext.length === 0) return false
      if (!validNext.includes(targetId)) return true
      if (validNext.length === 1 && currentSide !== 'Center') return true
      if (validNext.length >= 2 && currentSide === 'Center') return true
      return false
    }

    const explicitSilentReaction = Boolean(ev?.silentReaction || directed?.silentMotion)
    let autoSilentTargetId: number | null = null
    const hasZeroMotionActorOnStage = [...onStage.entries()].some(
      ([pid, pst]) => index > pst.appearedAtLine && (totalBodyMotions.get(pid) ?? 0) === 0
    )
    const minSilentGap = hasZeroMotionActorOnStage ? 1 : 2
    if (
      !explicitSilentReaction &&
      !pendingListenerMotion &&
      dialogue.lines.length >= 6 &&
      direction.lines.length > 0 &&
      index >= 1 &&
      index < dialogue.lines.length - 1 &&
      !ev?.move &&
      index - lastSilentReactionLine >= minSilentGap &&
      silentReactionsEmitted < Math.max(2, Math.round(dialogue.lines.length * 0.42))
    ) {
      const turnBoundary = nextLine && nextLine.speaker !== line.speaker
      const pauseOrEllipsis =
        /……|——/.test(line.content) || Boolean(ev?.closeWindowAfter || line.closeWindowAfter)
      const eligibleCandidates = [...onStage.entries()]
        .filter(
          ([pid, pst]) =>
            index > pst.appearedAtLine &&
            !willActorClearImmediatelyAfter(pid) &&
            (pid !== nextSpeakerId || nextTalkPause >= 0.8 || !nextSpeakerHasImmediateMotion)
        )
        .sort(([aid], [bid]) => (totalBodyMotions.get(aid) ?? 0) - (totalBodyMotions.get(bid) ?? 0))
      const idlePartner = eligibleCandidates.find(
        ([pid, pst]) => pid !== member.modelId && pst.linesSinceLastBodyMotion >= 2
      )
      const fallbackOffTurn =
        eligibleCandidates.find(([pid]) => pid !== member.modelId && pid !== nextSpeakerId) ??
        eligibleCandidates.find(([pid]) => pid !== nextSpeakerId) ??
        eligibleCandidates[0]
      if (
        hasZeroMotionActorOnStage ||
        pauseOrEllipsis ||
        idlePartner ||
        (turnBoundary && index % 4 === 2)
      ) {
        const picked = idlePartner ?? fallbackOffTurn
        if (picked) {
          autoSilentTargetId = picked[0]
        }
      }
    }

    const hasSilentAfter =
      explicitSilentReaction || pendingListenerMotion !== null || autoSilentTargetId !== null
    // 仅当调用方显式要求关窗（如停顿/场景切镜前）才设 closeWindowAfter；严禁因瞬时 Motion 静默拍反复关闭并闪烁对话框
    const closeAfter = Boolean(ev?.closeWindowAfter || line.closeWindowAfter)

    // 官方 TalkData.Motions 每条动作都同时带 MotionName 与 FacialName；
    // 回填时必须校验情绪兼容性，绝不把之前残留的笑脸带进伤心/生气/紧张台词。
    const rawLastFacial = actorState?.lastFacial || ''
    let speakerFacial =
      rawLastFacial &&
      isFacialCompatibleWithLine({
        facial: rawLastFacial,
        modelPath: speakerModelPath,
        emotion: line.emotion,
        content: line.content,
        prevTense: precededByTense,
        restrainedRole: speakerRestrained
      }).ok
        ? rawLastFacial
        : ''
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
      const filled =
        speakerFacial ||
        pickSpeakerSubtleFacial(view, member.modelId, line, '', member.role, {
          precededByTense,
          modelPath: speakerModelPath,
          restrained: speakerRestrained
        }) ||
        view.neutralFacial(member.modelId)
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
        ...(line.windowDisplayMode ? { windowDisplayMode: line.windowDisplayMode } : {}),
        ...(line.effect ? { effect: line.effect } : {}),
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
    if (line.emotion) lastEmotionByActor.set(member.modelId, line.emotion)

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
        cameraZoomDirty = true
      } else if (cam.kind === 'pan') {
        snippets.push({
          type: 'CameraMove',
          wait: false,
          progressBehavior: 'Now',
          delay: 0,
          data: { x: cam.x ?? 60, y: cam.y ?? 0, duration: cam.durationMs ?? 500, ease: 'OutQuad' }
        })
        cameraMoveDirty = true
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
        trackActorBodyMotion(ast, act.motion, aid)
        actedBodyThisLine.add(aid)
      }
      if (typeof act.facial === 'string' && act.facial.length > 0) {
        if (aid === member.modelId) {
          ast.consecutiveSameFacial =
            ast.lastSpeakingFacial === act.facial ? ast.consecutiveSameFacial + 1 : 1
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
          ([id, st]) =>
            id !== nextSpeakerId &&
            id !== member.modelId &&
            index > st.appearedAtLine &&
            !willActorClearImmediatelyAfter(id)
        )?.[0] ??
        [...onStage.entries()].find(
          ([id, st]) =>
            id !== nextSpeakerId && index > st.appearedAtLine && !willActorClearImmediatelyAfter(id)
        )?.[0]
      const partnerId = [...onStage.keys()].find((id) => id !== member.modelId)
      const targetId: number =
        ev?.silentReaction && onStage.has(ev.silentReaction.modelId)
          ? ev.silentReaction.modelId
          : pendingListenerMotion && onStage.has(pendingListenerMotion.modelId)
            ? pendingListenerMotion.modelId
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
      const isExplicitStagingSilent = Boolean(ev?.silentReaction && onStage.has(ev.silentReaction.modelId))
      if (
        targetId !== -1 &&
        onStage.has(targetId) &&
        !avoidClobberingShortSelfMotion &&
        !willActorClearImmediatelyAfter(targetId, !isExplicitStagingSilent)
      ) {
        const targetState = onStage.get(targetId)!
        const targetMember = cast.find((c) => c.modelId === targetId)
        const targetModelPath = view.modelById(targetId)?.path
        const fromPendingListener =
          pendingListenerMotion?.modelId === targetId ? pendingListenerMotion : null
        const silentPrecededByTense = precededByTense || TENSE_EMOTION_SET.has(line.emotion ?? '')
        const targetPrevEmo = lastEmotionByActor.get(targetId) ?? ''
        const targetRestrained =
          isRestrainedRole(targetMember?.role ?? '') || isRestrainedRole(targetMember?.name ?? '')
        const rawSilentMotion = ev?.silentReaction?.motion || fromPendingListener?.motion || ''
        const safeSilentMotion =
          rawSilentMotion &&
          isMotionCompatibleWithContext({
            motion: rawSilentMotion,
            modelPath: targetModelPath,
            line,
            prevTense: silentPrecededByTense,
            isListener: targetId !== member.modelId,
            restrainedRole: targetRestrained
          })
            ? rawSilentMotion
            : ''
        const motion =
          safeSilentMotion ||
          pickFollowupMotion(
            view,
            targetId,
            targetState.lastBodyMotion,
            getOverusedMotions(targetId, targetState.recentBodyMotions),
            { line, prevTense: silentPrecededByTense, restrained: targetRestrained }
          )
        const rawSilentFacial = ev?.silentReaction?.facial || fromPendingListener?.facial || ''
        const targetHadTense =
          silentPrecededByTense ||
          targetPrevEmo === '生气' ||
          targetPrevEmo === '伤心' ||
          targetPrevEmo === '害怕'
        const safeSilentFacial =
          (rawSilentFacial &&
            targetHadTense &&
            (SMILE_FACIAL_RE.test(rawSilentFacial) ||
              isSmileLikeFacial(rawSilentFacial, targetModelPath))) ||
          shouldAvoidIncongruousSmile(rawSilentFacial, line, silentPrecededByTense, {
            modelPath: targetModelPath
          })
            ? ''
            : rawSilentFacial
        const holdExistingCryFacial =
          !safeSilentFacial &&
          Boolean(targetState.lastFacial) &&
          silentPrecededByTense &&
          (() => {
            const r = inspectModelFacial(targetModelPath ?? '', targetState.lastFacial).role
            return r === 'cry' || r === 'sad'
          })()
        const facial =
          safeSilentFacial ||
          (holdExistingCryFacial
            ? ''
            : directed?.silentMotion ||
                autoSilentTargetId !== null ||
                rawSilentFacial ||
                fromPendingListener
              ? targetId === member.modelId
                ? pickSpeakerSubtleFacial(
                    view,
                    targetId,
                    line,
                    targetState.lastFacial,
                    targetMember?.role,
                    { precededByTense: silentPrecededByTense, modelPath: targetModelPath }
                  )
                : pickListenerReactionFacial(
                    view,
                    targetId,
                    line,
                    targetMember?.role,
                    targetState.lastFacial,
                    {
                      precededByTense: targetHadTense,
                      modelPath: targetModelPath,
                      listenerPrevEmotion: targetPrevEmo
                    }
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
          trackActorBodyMotion(targetState, motion, targetId)
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

  normalizeLayoutTransitionBarriers(snippets)
  syncTalkEmotionContinuity(snippets, { models, view })

  return { models, images, snippets }
}

// ---------------------------------------------------------------------------
// Stage 5.5：导演终审（Director Review）— 审视整场成稿的戏剧弧光、情绪连贯、音效、舞台节奏与表演自然度
// ---------------------------------------------------------------------------

export interface StagedDirectorReviewPatch {
  op: 'update_acting' | 'update_talk' | 'insert_before' | 'insert_after' | 'delete'
  index: number
  motion?: string
  facial?: string
  content?: string
  emotion?: string
  delay?: number
  closeWindowOnFinish?: boolean
  snippet?: Record<string, unknown>
}

export interface StagedDirectorReviewResult {
  dramaticArc: string
  emotionalContinuityAndVoice: string
  audioAndSeDesign: string
  stageRhythm: string
  actingNaturalness: string
  concreteFixes: string[]
  operations: StagedDirectorReviewPatch[]
}

/**
 * 为 staged 流水线合成后的成稿构造紧凑的【导演终审】提示词：
 * 传入压缩后的片段时间线与统计摘要，让模型以导演身份审视并输出少量精准外科修补（绝不破坏 ttsText）。
 */
export function buildDirectorReviewPrompt(
  view: CatalogView,
  plan: StagedCastPlan,
  story: { models: Array<{ id: number }>; snippets: Array<Record<string, unknown>> },
  options: StagedPromptOptions
): StagedMessages {
  const snippets = story.snippets
  let talkCount = 0
  let playSeCount = 0
  let bgmCount = 0
  let standaloneMotionCount = 0
  let moveCount = 0
  let waitCount = 0

  const compactTimeline: string[] = []
  for (let i = 0; i < snippets.length; i++) {
    const s = snippets[i]
    const kind = str(s.type)
    const d = isRecord(s.data) ? s.data : {}
    if (kind === 'PlaySe') {
      playSeCount += 1
      compactTimeline.push(`[${i}] PlaySe(${str(d.file)})`)
    } else if (kind === 'ChangeBgm') {
      bgmCount += 1
      compactTimeline.push(
        `[${i}] ChangeBgm(${d.stop === true ? 'STOP' : str(d.file)}, fade=${num(d.fadeMs, 600)})`
      )
    } else if (kind === 'Motion') {
      standaloneMotionCount += 1
      compactTimeline.push(
        `[${i}] Motion(m=${num(d.modelId, -1)}, ${str(d.motion)}/${str(d.facial)})`
      )
    } else if (kind === 'Move') {
      moveCount += 1
      const to = isRecord(d.to) ? d.to : {}
      compactTimeline.push(
        `[${i}] Move(m=${num(d.modelId, -1)}->${str(to.side)}, ${str(d.motion)}/${str(d.facial)})`
      )
    } else if (kind === 'Wait') {
      waitCount += 1
      compactTimeline.push(`[${i}] Wait(${num(d.duration, 500)}ms)`)
    } else if (kind === 'Talk') {
      talkCount += 1
      const acts = Array.isArray(d.actions)
        ? (d.actions as Array<Record<string, unknown>>)
            .map(
              (a) =>
                `m${num(a.modelId, -1)}:${str(a.motion)}/${str(a.facial)}${num(a.at, 0) > 0 ? `@${num(a.at, 0)}` : ''}`
            )
            .join(',')
        : ''
      const text = str(d.content).replace(/\n/g, ' / ').slice(0, 46)
      const emo = str(d.emotion)
      const delayTag = num(s.delay, 0) > 0 ? ` delay=${num(s.delay, 0)}` : ''
      compactTimeline.push(
        `[${i}] Talk(${str(d.speaker)}${emo ? `/${emo}` : ''}${delayTag}): ${text}${acts ? ` | ${acts}` : ''}`
      )
    } else if (
      kind === 'LayoutAppear' ||
      kind === 'LayoutClear' ||
      kind === 'BlackOut' ||
      kind === 'BlackIn' ||
      kind === 'AmbientColor' ||
      kind === 'ShakeScreen' ||
      kind === 'CameraZoom'
    ) {
      compactTimeline.push(`[${i}] ${kind}`)
    }
  }

  const seChoices = view.seList(options.scene, 14)
  const castMotionHints = plan.cast
    .map((m) => {
      const model = view.modelById(m.modelId)
      if (!model) return ''
      const motions = view.promptMotions(model).slice(0, 14)
      const facials = view.promptFacials(model).slice(0, 12)
      return `- ${m.name}(modelId=${m.modelId}) 动作样本: ${motions.join(', ')} | 表情样本: ${facials.join(', ')}`
    })
    .filter(Boolean)
    .join('\n')

  return {
    system: [
      '你是 Project SEKAI 视觉小说的总导演（Director Review）。请以观众和导演视角审视已合成的剧本时间线，评估：',
      '1. 戏剧弧光与句长节奏（开场抓手、情绪转折、收尾余韵）',
      '2. 情绪连贯与人物口吻',
      '3. 音频设计（开场 BGM、高潮静音切停 ChangeBgm stop:true、PlaySe 物理/情绪音效）',
      '4. 舞台节奏（Wait 呼吸留白、独立 Motion 静默反应、原地单双人焦点淡入淡出切镜；日常/谈心保持 CameraZoom 与 CharacterShake 克制不滥用）',
      '5. 表情与动作自然度（避免机械循环，也不要无故频繁乱动；自然不死板）',
      '若发现具体薄弱处，请在 operations 中输出精准局部修补（最多 12 条）；若成稿已经精良，operations 可为空数组。严禁编造不在清单中的动作/表情/音效，严禁输出 markdown。'
    ].join('\n'),
    user: `## 场景与大纲
场景：${options.scene}
标题：${plan.title || '（无）'}
梗概：${plan.logline || plan.event}

## 成稿统计
共 ${snippets.length} 片段 / ${talkCount} 句 Talk | PlaySe=${playSeCount} | ChangeBgm=${bgmCount} | 独立 Motion=${standaloneMotionCount} | Move=${moveCount} | Wait=${waitCount}

## 角色可用动作/表情参考
${castMotionHints}

## 常用 PlaySe 参考
${seChoices}

## 紧凑时间线（[index]）
${compactTimeline.join('\n')}

## 输出 JSON
{
  "dramaticArc": "简评戏剧弧光与结尾",
  "emotionalContinuityAndVoice": "简评情绪连贯与人物口吻",
  "audioAndSeDesign": "简评 BGM 与 PlaySe 音效",
  "stageRhythm": "简评 Wait/Motion/Move/切镜节奏",
  "actingNaturalness": "简评表情动作自然度与多样性",
  "concreteFixes": ["发现并修补的具体点1", "..."],
  "operations": [
    { "op": "insert_before", "index": 5, "snippet": { "type": "PlaySe", "wait": false, "delay": 0, "data": { "file": "se_run_women_001_1.mp3", "volume": 0.9 } } },
    { "op": "update_acting", "index": 12, "motion": "w-normal-sigh01", "facial": "face_sad_01" }
  ]
}
只输出一个合法 JSON 对象。`
  }
}

export function normalizeDirectorReviewResult(raw: unknown): StagedDirectorReviewResult | null {
  if (!isRecord(raw)) return null
  const dramaticArc = str(raw.dramaticArc).trim()
  const emotionalContinuityAndVoice = str(raw.emotionalContinuityAndVoice).trim()
  const audioAndSeDesign = str(raw.audioAndSeDesign).trim()
  const stageRhythm = str(raw.stageRhythm).trim()
  const actingNaturalness = str(raw.actingNaturalness).trim()
  if (
    !dramaticArc &&
    !emotionalContinuityAndVoice &&
    !audioAndSeDesign &&
    !stageRhythm &&
    !actingNaturalness
  ) {
    return null
  }
  const concreteFixes = Array.isArray(raw.concreteFixes)
    ? raw.concreteFixes
        .map((x) => str(x).trim())
        .filter(Boolean)
        .slice(0, 12)
    : []
  const allowedOps = new Set([
    'update_acting',
    'update_talk',
    'insert_before',
    'insert_after',
    'delete'
  ])
  const operations: StagedDirectorReviewPatch[] = []
  if (Array.isArray(raw.operations)) {
    for (const item of raw.operations.slice(0, 12)) {
      if (!isRecord(item)) continue
      const op = str(item.op).trim()
      const index = Math.floor(num(item.index, -1))
      if (!allowedOps.has(op) || index < 0) continue
      operations.push({
        op: op as StagedDirectorReviewPatch['op'],
        index,
        ...(typeof item.motion === 'string' ? { motion: item.motion } : {}),
        ...(typeof item.facial === 'string' ? { facial: item.facial } : {}),
        ...(typeof item.content === 'string' ? { content: item.content } : {}),
        ...(typeof item.emotion === 'string' ? { emotion: item.emotion } : {}),
        ...(typeof item.delay === 'number' && Number.isFinite(item.delay)
          ? { delay: item.delay }
          : {}),
        ...(typeof item.closeWindowOnFinish === 'boolean'
          ? { closeWindowOnFinish: item.closeWindowOnFinish }
          : {}),
        ...(isRecord(item.snippet) ? { snippet: item.snippet } : {})
      })
    }
  }
  return {
    dramaticArc,
    emotionalContinuityAndVoice,
    audioAndSeDesign,
    stageRhythm,
    actingNaturalness,
    concreteFixes,
    operations
  }
}

/**
 * 将导演终审的局部外科修补应用到剧本副本（按原始下标降序执行，避免索引漂移；保留既有 ttsText 与 Irodori Emoji 不受破坏）。
 */
export function applyDirectorReviewPatches<T extends { snippets: Array<Record<string, unknown>> }>(
  story: T,
  review: StagedDirectorReviewResult
): { story: T; appliedCount: number } {
  const cloned = structuredClone(story)
  const snippets = cloned.snippets
  const originalLen = snippets.length
  const deleted = new Set<number>()
  let appliedCount = 0

  const phaseOf = (op: StagedDirectorReviewPatch['op']): number => {
    if (op === 'insert_after') return 0
    if (op === 'update_talk' || op === 'update_acting') return 1
    if (op === 'delete') return 2
    return 3
  }

  const ordered = review.operations
    .map((op, order) => ({ op, order }))
    .sort((a, b) => {
      if (a.op.index !== b.op.index) return b.op.index - a.op.index
      const pa = phaseOf(a.op.op)
      const pb = phaseOf(b.op.op)
      if (pa !== pb) return pa - pb
      return pa === 0 || pa === 3 ? b.order - a.order : a.order - b.order
    })

  // 允许插入的安全演出辅助片段（不破坏人物在场状态机）
  const safeInsertTypes = new Set([
    'PlaySe',
    'StopSe',
    'ChangeBgm',
    'Wait',
    'Motion',
    'Move',
    'ShakeScreen',
    'ShakeWindow',
    'CharacterShake',
    'AmbientColor',
    'HideTalk'
  ])

  for (const { op } of ordered) {
    const idx = op.index
    if (idx < 0 || idx >= originalLen || deleted.has(idx)) continue
    const target = snippets[idx]
    if (!isRecord(target)) continue

    if (op.op === 'delete') {
      // 安全保护：导演终审不允许误删核心在场/台词结构，仅允许删冗余 ChangeBgm/Wait/PlaySe/Motion
      const tType = str(target.type)
      if (['ChangeBgm', 'Wait', 'PlaySe', 'Motion'].includes(tType)) {
        snippets.splice(idx, 1)
        deleted.add(idx)
        appliedCount += 1
      }
      continue
    }

    if (op.op === 'insert_before' || op.op === 'insert_after') {
      if (!op.snippet || !safeInsertTypes.has(str(op.snippet.type))) continue
      const insertAt = op.op === 'insert_before' ? idx : idx + 1
      snippets.splice(insertAt, 0, structuredClone(op.snippet))
      appliedCount += 1
      continue
    }

    const d = isRecord(target.data) ? target.data : {}
    if (typeof op.delay === 'number' && Number.isFinite(op.delay) && op.delay >= 0) {
      target.delay = op.delay
    }
    if (op.op === 'update_talk' && str(target.type) === 'Talk') {
      if (typeof op.content === 'string' && op.content.trim()) {
        const nextContent = op.content.trim()
        const prevContent = str(d.content).trim()
        if (nextContent !== prevContent) {
          d.content = nextContent
          // 仅当中文正文发生实质改写时清空旧 ttsText 以便后续重翻；未改正文时完整保留含 Irodori Emoji 的 ttsText
          if (typeof d.ttsText === 'string' && d.ttsText) delete d.ttsText
        }
      }
      if (typeof op.emotion === 'string') d.emotion = op.emotion
      if (typeof op.closeWindowOnFinish === 'boolean') {
        if (op.closeWindowOnFinish) d.closeWindowOnFinish = true
        else delete d.closeWindowOnFinish
      }
      appliedCount += 1
    }
    if (op.motion !== undefined || op.facial !== undefined) {
      if (str(target.type) === 'Talk') {
        const speakerId = num(d.modelId, -1)
        const acts = Array.isArray(d.actions)
          ? [...(d.actions as Array<Record<string, unknown>>)]
          : []
        const primaryIdx = acts.findIndex((a) => isRecord(a) && num(a.modelId, -1) === speakerId)
        const base: Record<string, unknown> =
          primaryIdx >= 0 ? { ...acts[primaryIdx] } : { at: 0, modelId: speakerId }
        if (typeof op.motion === 'string') {
          if (op.motion.trim()) base.motion = op.motion.trim()
          else delete base.motion
        }
        if (typeof op.facial === 'string') {
          if (op.facial.trim()) base.facial = op.facial.trim()
          else delete base.facial
        }
        if (base.motion || base.facial) {
          if (primaryIdx >= 0) acts[primaryIdx] = base
          else acts.unshift(base)
        } else if (primaryIdx >= 0) {
          acts.splice(primaryIdx, 1)
        }
        d.actions = acts
        if (op.motion !== undefined) delete d.motion
        if (op.facial !== undefined) delete d.facial
      } else {
        if (typeof op.motion === 'string') d.motion = op.motion
        if (typeof op.facial === 'string') d.facial = op.facial
      }
      appliedCount += 1
    }
    target.data = d
  }

  return { story: cloned, appliedCount }
}
