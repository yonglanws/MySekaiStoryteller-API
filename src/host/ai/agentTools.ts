import type { ILogObj, Logger } from 'tslog'
import type { CatalogModel } from '../resources/resourceCatalog'
import type { StoryData } from '../../common/types/Story'
import type { AdaptiveRagRetriever } from '../rag/retriever'
import * as corpusExamplesMod from './corpusExamples'
import {
  hasSpokenStageDirectionLeak,
  lintDialogueFidelity,
  repairSpokenStageDirections
} from './dialogueLinter'
import * as facialSemanticsMod from './facialSemantics'
import {
  extractJson,
  LlmClient,
  LlmError,
  type ChatMessage,
  type ChatUsage,
  type LlmToolCall,
  type LlmToolDefinition
} from './llm'
import * as officialLinterMod from './officialLinter'
import * as personasMod from './personas'
import { buildActingExample, isBackViewModel, isStandingMotion, type CatalogView } from './prompt'
import * as scenarioCuesMod from './scenarioCues'
import { alignStoryTtsEmotionsAndCaptions } from './ttsText'
import { validateAndFixStory } from './validate'

export type MotionSemanticRole =
  | 'nod'
  | 'tilthead'
  | 'shakehead'
  | 'glad'
  | 'playful'
  | 'shy'
  | 'trouble'
  | 'sad'
  | 'angry'
  | 'forward'
  | 'think'
  | 'surprise'
  | 'relief'
  | 'greeting'
  | 'standing'
  | 'special'
  | 'other'

export type DramaticContextMood =
  | 'surprise'
  | 'awkward'
  | 'gentle_reassure'
  | 'inner_resolve'
  | 'shy_hesitation'
  | 'angry_frustration'
  | 'sad_regret'
  | 'cheerful_banter'
  | 'attentive_listen'
  | 'thinking_monologue'
  | 'entry_exit'
  | 'neutral'

export interface MotionInspection {
  role: MotionSemanticRole
  label: string
  style: string
  durationSec?: number
  fromMotion3: boolean
}

export interface DramaticContextSummary {
  mood: DramaticContextMood
  tense: boolean
  apologyOrRegret: boolean
  questionOrDoubt: boolean
  cheerful: boolean
  resolve: boolean
  monologue: boolean
}

export interface MotionCompatibilityResult {
  ok: boolean
  reason?: string
}

export interface ActingLineEvaluationIssue {
  field: 'facial' | 'motion' | 'repetition'
  code: string
  severity: 'high' | 'medium'
  message: string
}

export interface ActingLineEvaluation {
  ok: boolean
  inferredMood: DramaticContextMood
  issues: ActingLineEvaluationIssue[]
  recommendedFacials: string[]
  recommendedMotions: string[]
}

export interface ActingFidelityDiagnostic {
  snippetIndex: number
  lineNumber: number
  modelId: number
  listenerModelId?: number
  speaker: string
  content: string
  emotion: string
  facial: string
  motion: string
  inferredMood: DramaticContextMood
  field: 'facial' | 'motion' | 'repetition' | 'staging' | 'dialogue' | 'bgm' | 'tts'
  code: string
  severity: 'high' | 'medium'
  message: string
  recommendedFacials: string[]
  recommendedMotions: string[]
}

export interface ActingFidelityReport {
  passed: boolean
  score: number
  talkCount: number
  diagnostics: ActingFidelityDiagnostic[]
  zeroMotionModelIds: number[]
  repeatedFacialRunCount: number
  facialMismatchCount: number
  motionMismatchCount: number
  simultaneousCollisionCount: number
  stageDirectionLeakCount: number
  listenerFrozenCount?: number
  duplicateBgmCount?: number
  zeroWidthCharCount?: number
  staggeredMidlineMotionCount?: number
  excessiveSlidingCount?: number
  officialReport: officialLinterMod.OfficialLintReport
}

export interface CharacterActingProfile {
  restrained: boolean
  temperament: 'restrained' | 'earnest' | 'expressive' | 'theatrical' | 'playful' | 'gentle'
  actingNote: string
}

type FacialSemanticsExtended = typeof facialSemanticsMod & {
  inspectModelMotion?: (
    modelPath: string | undefined,
    motionName: string,
    modelsRoot?: string
  ) => MotionInspection
  annotateMotionName?: (
    modelPath: string | undefined,
    motionName: string,
    modelsRoot?: string
  ) => string
  inferDramaticContext?: (params: {
    content: string
    emotion?: string
    prevContent?: string
    prevEmotion?: string
    isMonologue?: boolean
    isListener?: boolean
    isEntryExit?: boolean
    restrainedRole?: boolean
    ttsCaption?: string
  }) => DramaticContextSummary
  isMotionCompatibleWithLine?: (params: {
    motion: string
    modelPath?: string
    emotion?: string
    content: string
    prevContent?: string
    prevEmotion?: string
    prevTense?: boolean
    isListener?: boolean
    restrainedRole?: boolean
    modelsRoot?: string
  }) => MotionCompatibilityResult
  recommendActingForLine?: (params: {
    facials: string[]
    motions: string[]
    modelPath?: string
    content: string
    emotion?: string
    prevContent?: string
    prevEmotion?: string
    prevTense?: boolean
    isMonologue?: boolean
    isListener?: boolean
    isEntryExit?: boolean
    restrainedRole?: boolean
    prevFacial?: string
    prevMotion?: string
    recentMotions?: ReadonlySet<string> | string[]
    modelsRoot?: string
    limit?: number
  }) => { mood: DramaticContextMood; facials: string[]; motions: string[] }
  evaluateActingLineMatch?: (params: {
    facial?: string
    motion?: string
    facials?: string[]
    motions?: string[]
    modelPath?: string
    content: string
    emotion?: string
    prevContent?: string
    prevEmotion?: string
    prevTense?: boolean
    isMonologue?: boolean
    isListener?: boolean
    isEntryExit?: boolean
    restrainedRole?: boolean
    prevFacial?: string
    prevMotion?: string
    consecutiveSameFacialCount?: number
    consecutiveSameMotionCount?: number
    modelsRoot?: string
  }) => ActingLineEvaluation
}

type OfficialLinterExtended = typeof officialLinterMod & {
  auditStoryActingAndFidelity?: (
    story: StoryData | Record<string, unknown>,
    view?: CatalogView,
    options?: { restrainedNames?: string[] }
  ) => ActingFidelityReport
}

type CatalogViewExtended = CatalogView & {
  recommendActingChoices?: (
    modelId: number,
    params: {
      content: string
      emotion?: string
      isListener?: boolean
      prevFacial?: string
      prevMotion?: string
      restrainedRole?: boolean
    }
  ) => { mood: DramaticContextMood; facials: string[]; motions: string[] }
}

type PersonasExtended = typeof personasMod & {
  characterActingProfile?: (nameOrPath: string, roleHint?: string) => CharacterActingProfile
}

type ScenarioCuesExtended = typeof scenarioCuesMod & {
  recommendScenarioCues?: (
    sceneText: string,
    options?: { isFlashback?: boolean; isSekai?: boolean; isMonologue?: boolean }
  ) => {
    ambient: 'normal' | 'evening' | 'night'
    transition: 'black' | 'sideFade' | 'flashback' | 'sekaiIn' | 'sekaiOut'
    seCues: scenarioCuesMod.ScenarioSeCue[]
    effects: scenarioCuesMod.CuratedScenarioEffect[]
  }
}

type CorpusExamplesExtended = typeof corpusExamplesMod & {
  getOfficialActingGuidelines?: (options?: {
    castCount?: number
    isSekai?: boolean
    isFlashback?: boolean
  }) => string
}

const facialApi = facialSemanticsMod as unknown as FacialSemanticsExtended
const officialLinterApi = officialLinterMod as unknown as OfficialLinterExtended
const personasApi = personasMod as unknown as PersonasExtended
const scenarioCuesApi = scenarioCuesMod as unknown as ScenarioCuesExtended
const corpusExamplesApi = corpusExamplesMod as unknown as CorpusExamplesExtended

export interface StoryAgentToolkitDeps {
  view: CatalogView
  personas: personasMod.PersonaEntry[]
  emotionLabels?: string[]
  targetMinutes?: number
  ragRetriever?: AdaptiveRagRetriever | null
  logger: Logger<ILogObj>
}

export interface DirectorReviewRecord {
  dramaticArc: string
  emotionalContinuityAndVoice: string
  audioAndSeDesign: string
  stageRhythm: string
  actingNaturalness: string
  concreteFixes: string[]
  appliedOperationsCount: number
}

export interface DirectorStageTelemetry {
  snippetCount: number
  talkCount: number
  avgTalkChars: number
  longLineShare: number
  soloTalkShare: number
  playSeCount: number
  bgmCueCount: number
  hasOpeningBgm: boolean
  hasBgmSilenceCut: boolean
  standaloneMotionCount: number
  moveCount: number
  waitCount: number
  ambientColorCount: number
  cameraOrShakeCount: number
  talkWithMotionShare: number
  talkFacialOnlyShare: number
  talkStillShare: number
  distinctMotionsUsed: number
  distinctFacialsUsed: number
  maxSameMotionRun: number
  dominantEmotion?: string
  dominantEmotionShare?: number
  reviewFocusPoints: string[]
}

export interface StoryAgentToolkit {
  definitions: LlmToolDefinition[]
  execute: (name: string, rawArgs: unknown, signal?: AbortSignal) => Promise<string>
  getSavedDraft: () => Record<string, unknown> | null
  getSavedPlan: () => SavedStoryPlan | null
  getDirectorReview: () => DirectorReviewRecord | null
  isFinalized: () => boolean
}

interface SavedStoryPlan {
  title: string
  logline: string
  event: string
  cast: Array<{ modelId: number; name: string; role: string }>
  scenes: Array<{
    id: string
    summary: string
    background: string
    ambient: 'normal' | 'evening' | 'night'
    transitionIn: string
    activeCast: string[]
    bgm?: string
    isFlashback?: boolean
    isSekai?: boolean
  }>
  beats: string[]
  understanding?: {
    explicitRequests: string[]
    turningPoint?: string
    openingMotif?: string
    closingCallback?: string
    canonHooks: string[]
  }
  pairwiseAddress?: Array<{ from: string; to: string; zh: string; ja?: string }>
}

const MOTION_CLASS_TABLE: Array<{
  re: RegExp
  role: MotionSemanticRole
  label: string
}> = [
  { re: /default|stand/i, role: 'standing', label: '默认站姿' },
  { re: /nod/i, role: 'nod', label: '点头认同' },
  { re: /tilthead|tilt/i, role: 'tilthead', label: '歪头疑惑/思考' },
  { re: /shakehead/i, role: 'shakehead', label: '摇头否定' },
  { re: /glad|happy|cheer|joy/i, role: 'glad', label: '开心欢呼' },
  { re: /wink|smug|doya|pose|sing/i, role: 'playful', label: '俏皮/得意/摆姿势' },
  { re: /shy|blush|fidget/i, role: 'shy', label: '害羞/局促' },
  { re: /trouble|worry/i, role: 'trouble', label: '为难/困扰' },
  { re: /sad|sigh|lookdown|cry/i, role: 'sad', label: '低落/叹气' },
  { re: /angry|disgust/i, role: 'angry', label: '生气/不满' },
  { re: /forward|point/i, role: 'forward', label: '前倾认真' },
  { re: /think|lookaway|lookup/i, role: 'think', label: '思考/移开视线' },
  { re: /surprise|shock|scared/i, role: 'surprise', label: '惊讶/受惊' },
  { re: /relief/i, role: 'relief', label: '松一口气' },
  { re: /greeting|wave/i, role: 'greeting', label: '打招呼/挥手' },
  { re: /delicious|eat|drink/i, role: 'special', label: '吃喝/品尝（仅限食物饮品场景）' },
  { re: /sleep|stretch/i, role: 'special', label: '倦意/睡眠（仅限困倦睡眠场景）' }
]

const MOOD_QUERY_SYNONYMS: Array<{ kw: RegExp; tokens: string[] }> = [
  {
    kw: /伤心|难过|悲伤|哭|低落|失落|遗憾|痛苦|委屈/,
    tokens: ['sad', 'cry', 'sigh', 'lookdown', 'worry', 'trouble']
  },
  {
    kw: /道歉|愧疚|对不起|抱歉|为难|困扰|纠结|尴尬|无奈/,
    tokens: ['trouble', 'worry', 'wry', 'lookaway', 'sigh', 'sad', 'closeeye']
  },
  {
    kw: /生气|愤怒|不满|吵架|烦|恼火|责怪/,
    tokens: ['angry', 'disgust', 'sharp', 'serious', 'shakehead']
  },
  { kw: /害怕|恐惧|紧张|不安|慌/, tokens: ['scared', 'worry', 'trouble', 'fidget', 'surprise'] },
  { kw: /惊讶|震惊|吃惊|意外|发现/, tokens: ['surprise', 'shock', 'notice', 'tilthead'] },
  { kw: /害羞|脸红|不好意思|羞涩/, tokens: ['shy', 'blush', 'fidget', 'lookaway'] },
  {
    kw: /开心|高兴|微笑|笑|欢快|愉快|打趣|俏皮/,
    tokens: ['smile', 'glad', 'wink', 'smug', 'playful', 'sparkling', 'nod', 'relief']
  },
  { kw: /苦笑|勉强/, tokens: ['wry', 'trouble', 'closeeye', 'sigh'] },
  {
    kw: /思考|思索|独白|认真|决心|平静|倾听|点头/,
    tokens: ['think', 'serious', 'closeeye', 'smallmouth', 'nod', 'tilthead', 'forward', 'normal']
  },
  { kw: /告别|打招呼|重逢|松口气|安心/, tokens: ['greeting', 'relief', 'nod', 'smile'] }
]

function fallbackInspectMotion(motionName: string): MotionInspection {
  const clean = motionName.trim()
  const parts = clean.split('-')
  const style = parts.length > 2 ? parts[1] : ''
  for (const row of MOTION_CLASS_TABLE) {
    if (row.re.test(clean)) {
      return { role: row.role, label: row.label, style, fromMotion3: false }
    }
  }
  return { role: 'other', label: '常规身体动作', style, fromMotion3: false }
}

function inspectMotion(modelPath: string | undefined, motionName: string): MotionInspection {
  if (typeof facialApi.inspectModelMotion === 'function') {
    return facialApi.inspectModelMotion(modelPath, motionName)
  }
  return fallbackInspectMotion(motionName)
}

function annotateMotion(modelPath: string | undefined, motionName: string): string {
  if (typeof facialApi.annotateMotionName === 'function') {
    return facialApi.annotateMotionName(modelPath, motionName)
  }
  const info = fallbackInspectMotion(motionName)
  return info.label ? `${motionName}(${info.label})` : motionName
}

function getActingProfile(nameOrPath: string, roleHint = ''): CharacterActingProfile {
  if (typeof personasApi.characterActingProfile === 'function') {
    return personasApi.characterActingProfile(nameOrPath, roleHint)
  }
  const combined = `${nameOrPath} ${roleHint}`
  if (/真冬|mafuyu/i.test(combined)) {
    return {
      restrained: true,
      temperament: 'restrained',
      actingNote:
        '朝比奈真冬：日常保持克制内敛，多用轻闭眼、抿嘴、微垂眸或礼貌浅笑，避免大开大合的欢呼或夸张笑脸。'
    }
  }
  if (/奏|kanade|一歌|ichika|冬弥|toya|touya/i.test(combined)) {
    return {
      restrained: false,
      temperament: 'gentle',
      actingNote: '说话沉稳轻柔，动作幅度不宜过度夸张，优先点头、前倾倾听、微思索。'
    }
  }
  if (/笑梦|emu|司|tsukasa/i.test(combined)) {
    return {
      restrained: false,
      temperament: 'theatrical',
      actingNote:
        '富有舞台表现力与热情，开心或鼓劲时可用明快表情与动作，但低落/认真转折时仍需收敛。'
    }
  }
  return {
    restrained: false,
    temperament: 'earnest',
    actingNote: '依据当下台词语气与剧情张力自然切换表情和动作。'
  }
}

function inferDramaticMoodFallback(params: {
  content: string
  emotion?: string
  prevContent?: string
  prevEmotion?: string
  isMonologue?: boolean
  isListener?: boolean
}): DramaticContextSummary {
  if (typeof facialApi.inferDramaticContext === 'function') {
    return facialApi.inferDramaticContext(params)
  }
  const text = params.content.trim()
  const emo = (params.emotion ?? '').trim()
  const prevText = (params.prevContent ?? '').trim()
  const prevEmo = (params.prevEmotion ?? '').trim()
  const monologue = Boolean(params.isMonologue) || (/^[（(]/.test(text) && /[）)]$/.test(text))
  const apologyOrRegret = /对不起|抱歉|对不住|都是我的错|搞砸|后悔|抱歉啦/.test(text)
  const tense =
    ['生气', '伤心', '害怕'].includes(emo) ||
    ['生气', '伤心', '害怕'].includes(prevEmo) ||
    apologyOrRegret ||
    /别再|少啰嗦|闭嘴|为什么|骗人|糟糕|讨厌|难过|哭|眼泪|吵架|冷淡/.test(text) ||
    /别再|少啰嗦|闭嘴|为什么|骗人|糟糕/.test(prevText)
  const cheerful =
    !tense &&
    !apologyOrRegret &&
    (emo === '开心' || /太好了|好耶|哈哈|嘿嘿|嘻嘻|～♪|♪|Wonderhoy|真可爱|最喜欢/.test(text))
  const questionOrDoubt = /[？?]|难道|怎么|为什么|真的吗|咦|诶/.test(text)
  const resolve = /决定|一定|必须|听我说|绝对|我会|绝不/.test(text)

  let mood: DramaticContextMood = 'neutral'
  if (emo === '惊讶' || /什么！？|怎么会|竟然|！？|\?!/.test(text)) mood = 'surprise'
  else if (emo === '害羞' || /脸红|害羞|笨蛋|才、才不是|别看我/.test(text)) mood = 'shy_hesitation'
  else if (emo === '生气' || /烦死|够了|住口|气死|少啰嗦/.test(text)) mood = 'angry_frustration'
  else if (emo === '伤心' || apologyOrRegret || /难过|伤心|眼泪|哭|失落|做不到/.test(text))
    mood = 'sad_regret'
  else if (monologue) mood = 'thinking_monologue'
  else if (cheerful) mood = 'cheerful_banter'
  else if (resolve) mood = 'inner_resolve'
  else if (/那个|呃|勉强|苦笑|没办法|叹/.test(text)) mood = 'awkward'
  else if (params.isListener) mood = 'attentive_listen'
  else if (/没关系|别担心|慢慢来|陪着你|加油/.test(text)) mood = 'gentle_reassure'

  return { mood, tense, apologyOrRegret, questionOrDoubt, cheerful, resolve, monologue }
}

const NEGATIVE_MOTION_ROLES = new Set<MotionSemanticRole>(['sad', 'angry', 'trouble'])
const JOYFUL_MOTION_ROLES = new Set<MotionSemanticRole>(['glad', 'playful'])
const FOOD_DRINK_CUE_RE =
  /吃|喝|美味|好吃|甜品|蛋糕|面包|拉面|茶|咖啡|点心|便当|饮料|食物|品尝|味道|饿|嘴馋|delicious|eat|drink/i
const SLEEP_CUE_RE = /困|睡|熬夜|累|疲惫|打哈欠|睡着|午睡|晚安|想睡|sleep|tired|yawn/i

function checkMotionCompatibility(params: {
  motion: string
  modelPath?: string
  emotion?: string
  content: string
  prevContent?: string
  prevEmotion?: string
  prevTense?: boolean
  isListener?: boolean
  restrainedRole?: boolean
}): MotionCompatibilityResult {
  if (!params.motion.trim()) return { ok: true }
  if (/delicious|eat|drink/i.test(params.motion) && !FOOD_DRINK_CUE_RE.test(params.content)) {
    return { ok: false, reason: 'prop_food_motion_without_food_cue' }
  }
  if (/sleep/i.test(params.motion) && !SLEEP_CUE_RE.test(params.content)) {
    return { ok: false, reason: 'sleep_motion_without_sleep_cue' }
  }
  if (typeof facialApi.isMotionCompatibleWithLine === 'function') {
    return facialApi.isMotionCompatibleWithLine(params)
  }
  const info = inspectMotion(params.modelPath, params.motion)
  const ctx = inferDramaticMoodFallback(params)
  const emo = (params.emotion ?? '').trim()
  if (
    (ctx.tense || params.prevTense || emo === '伤心' || emo === '生气' || emo === '害怕') &&
    JOYFUL_MOTION_ROLES.has(info.role)
  ) {
    return { ok: false, reason: 'tense_or_sad_context_joyful_motion' }
  }
  if ((emo === '开心' || ctx.cheerful) && !ctx.tense && NEGATIVE_MOTION_ROLES.has(info.role)) {
    return { ok: false, reason: 'cheerful_context_negative_motion' }
  }
  if (params.restrainedRole && info.role === 'glad') {
    return { ok: false, reason: 'restrained_role_exuberant_motion' }
  }
  if (
    (ctx.mood === 'sad_regret' || ctx.monologue) &&
    emo !== '惊讶' &&
    ['tilthead', 'greeting', 'relief', 'surprise', 'angry'].includes(info.role)
  ) {
    return { ok: false, reason: 'sad_or_monologue_unrelated_motion' }
  }
  if (ctx.mood === 'angry_frustration' && ['tilthead', 'greeting'].includes(info.role)) {
    return { ok: false, reason: 'angry_context_unrelated_motion' }
  }
  return { ok: true }
}

function moodToTargetMood(mood: DramaticContextMood): facialSemanticsMod.TargetMood {
  switch (mood) {
    case 'sad_regret':
      return 'sad'
    case 'awkward':
      return 'trouble'
    case 'angry_frustration':
      return 'angry'
    case 'surprise':
      return 'surprise'
    case 'shy_hesitation':
      return 'shy'
    case 'cheerful_banter':
    case 'gentle_reassure':
      return 'smile'
    default:
      return 'neutral'
  }
}

function recommendForLine(
  view: CatalogView,
  model: CatalogModel,
  params: {
    content: string
    emotion?: string
    prevContent?: string
    prevEmotion?: string
    prevTense?: boolean
    isMonologue?: boolean
    isListener?: boolean
    restrainedRole?: boolean
    prevFacial?: string
    prevMotion?: string
    recentMotions?: ReadonlySet<string> | string[]
    limit?: number
  }
): { mood: DramaticContextMood; facials: string[]; motions: string[] } {
  const limit = params.limit ?? 4
  const extView = view as CatalogViewExtended
  if (typeof facialApi.recommendActingForLine === 'function') {
    return facialApi.recommendActingForLine({
      facials: view.promptFacials(model),
      motions: view.promptMotions(model),
      modelPath: model.path,
      ...params,
      limit
    })
  }
  if (typeof extView.recommendActingChoices === 'function') {
    return extView.recommendActingChoices(model.id, {
      content: params.content,
      emotion: params.emotion,
      isListener: params.isListener,
      prevFacial: params.prevFacial,
      prevMotion: params.prevMotion,
      restrainedRole: params.restrainedRole
    })
  }
  const ctx = inferDramaticMoodFallback(params)
  const facialPool = view.promptFacials(model)
  const motionPool = view.promptMotions(model).filter((m) => !isStandingMotion(m))
  const targetMood = moodToTargetMood(ctx.mood)
  const primaryFacial = facialSemanticsMod.pickMoodMatchedFacial(
    facialPool,
    targetMood,
    model.path,
    params.restrainedRole
  )
  const compatFacials = facialPool.filter(
    (f) =>
      f !== params.prevFacial &&
      facialSemanticsMod.isFacialCompatibleWithLine({
        facial: f,
        modelPath: model.path,
        emotion: params.emotion,
        content: params.content,
        prevTense: params.prevTense || ctx.tense,
        restrainedRole: params.restrainedRole
      }).ok
  )
  const facials = [
    ...(primaryFacial ? [primaryFacial] : []),
    ...compatFacials.filter((f) => f !== primaryFacial)
  ].slice(0, limit)

  const desiredRolesByMood: Record<DramaticContextMood, MotionSemanticRole[]> = {
    surprise: ['surprise', 'tilthead', 'forward', 'nod'],
    awkward: ['trouble', 'think', 'shy', 'tilthead'],
    gentle_reassure: ['nod', 'relief', 'forward'],
    inner_resolve: ['forward', 'nod', 'think'],
    shy_hesitation: ['shy', 'think', 'trouble', 'tilthead'],
    angry_frustration: ['angry', 'shakehead', 'forward'],
    sad_regret: ['sad', 'trouble', 'think'],
    cheerful_banter: ['glad', 'nod', 'playful', 'relief', 'greeting'],
    attentive_listen: ['nod', 'think', 'forward', 'trouble'],
    thinking_monologue: ['think', 'sad', 'trouble'],
    entry_exit: ['greeting', 'nod', 'tilthead'],
    neutral: ['nod', 'tilthead', 'think', 'forward', 'relief']
  }
  const wantedRoles = desiredRolesByMood[ctx.mood] ?? desiredRolesByMood.neutral
  const recentSet = new Set(params.recentMotions ?? [])
  const scoredMotions = motionPool
    .filter(
      (m) =>
        checkMotionCompatibility({
          motion: m,
          modelPath: model.path,
          emotion: params.emotion,
          content: params.content,
          prevTense: params.prevTense || ctx.tense,
          isListener: params.isListener,
          restrainedRole: params.restrainedRole
        }).ok
    )
    .map((m) => {
      const role = inspectMotion(model.path, m).role
      const roleIdx = wantedRoles.indexOf(role)
      let score = roleIdx >= 0 ? 20 - roleIdx * 4 : 0
      if (/^w-normal/i.test(m)) score += 3
      if (m === params.prevMotion) score -= 3
      if (recentSet.has(m)) score -= 2
      return { m, score }
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.m)

  return {
    mood: ctx.mood,
    facials:
      facials.length > 0
        ? facials
        : [
            facialSemanticsMod.pickNeutralFacial(
              facialPool,
              model.defaultFacial,
              model.path,
              params.restrainedRole
            )
          ],
    motions: scoredMotions.slice(0, limit)
  }
}

function appendContextAndListenerGuards(
  story: StoryData,
  view: CatalogView,
  base: ActingFidelityReport
): ActingFidelityReport {
  const extraDiagnostics: ActingFidelityDiagnostic[] = []
  const lastEmotionByModel = new Map<number, string>()
  let prevContent = ''
  let prevEmotion = ''
  let talkIdx = 0
  let addedFacialMismatch = 0
  let addedMotionMismatch = 0

  const hasDiagAt = (
    snippetIndex: number,
    modelId: number,
    field: 'motion' | 'facial',
    code?: string
  ): boolean =>
    base.diagnostics.some(
      (d) =>
        d.snippetIndex === snippetIndex &&
        d.modelId === modelId &&
        d.field === field &&
        (!code || d.code === code)
    )

  for (let i = 0; i < story.snippets.length; i++) {
    const snippet = story.snippets[i]
    const rawData = (
      'data' in snippet && snippet.data && typeof snippet.data === 'object' ? snippet.data : {}
    ) as Record<string, unknown>
    if (
      snippet.type === 'BlackOut' ||
      snippet.type === 'SekaiOut' ||
      (snippet.type === 'SideFade' && String(rawData.mode ?? 'Out').toLowerCase() === 'out') ||
      snippet.type === 'ChangeBackgroundImage'
    ) {
      prevContent = ''
      prevEmotion = ''
      lastEmotionByModel.clear()
      continue
    }
    if (snippet.type !== 'Talk' || !('data' in snippet) || !snippet.data) continue
    talkIdx += 1
    const data = snippet.data as unknown as Record<string, unknown>
    const content = String(data.content ?? '')
    const emotion = String(data.emotion ?? '')
    const speaker = String(data.speaker ?? '')
    const modelId = typeof data.modelId === 'number' ? data.modelId : -1
    if (modelId === -1) {
      prevContent = content
      prevEmotion = emotion
      continue
    }
    const actions = Array.isArray(data.actions)
      ? (data.actions as Array<Record<string, unknown>>)
      : []
    const speakerActs = actions.filter((a) => a && a.modelId === modelId)
    const primaryMotion =
      (typeof speakerActs[0]?.motion === 'string' ? speakerActs[0].motion : '') ||
      (typeof data.motion === 'string' ? data.motion : '')
    const primaryFacial =
      (typeof speakerActs[0]?.facial === 'string' ? speakerActs[0].facial : '') ||
      (typeof data.facial === 'string' ? data.facial : '')
    const model = view.modelById(modelId)

    if (primaryMotion) {
      const propReason =
        /delicious|eat|drink/i.test(primaryMotion) && !FOOD_DRINK_CUE_RE.test(content)
          ? 'prop_food_motion_without_food_cue'
          : /sleep/i.test(primaryMotion) && !SLEEP_CUE_RE.test(content)
            ? 'sleep_motion_without_sleep_cue'
            : ''
      if (propReason && !hasDiagAt(i, modelId, 'motion', propReason)) {
        addedMotionMismatch += 1
        const rec = model
          ? recommendForLine(view, model, {
              content,
              emotion,
              prevContent,
              prevEmotion,
              limit: 3
            })
          : { facials: [], motions: [] }
        extraDiagnostics.push({
          snippetIndex: i,
          lineNumber: talkIdx,
          modelId,
          speaker,
          content: content.slice(0, 60),
          emotion,
          facial: primaryFacial,
          motion: primaryMotion,
          inferredMood: 'neutral',
          field: 'motion',
          code: propReason,
          severity: 'high',
          message: `动作 ${annotateMotion(model?.path, primaryMotion)} 仅限特定食物/睡眠语境(${propReason})`,
          recommendedFacials: rec.facials,
          recommendedMotions: rec.motions
        })
      }
    }

    for (const act of actions) {
      const lid = typeof act?.modelId === 'number' ? act.modelId : -1
      const lFacial = typeof act?.facial === 'string' ? act.facial.trim() : ''
      if (
        lid !== -1 &&
        lid !== modelId &&
        lFacial &&
        !hasDiagAt(i, lid, 'facial', 'listener_tense_smile_flip')
      ) {
        const lPrevEmo = lastEmotionByModel.get(lid) ?? ''
        const lModel = view.modelById(lid)
        if (
          (lPrevEmo === '生气' || lPrevEmo === '伤心') &&
          facialSemanticsMod.isSmileLikeFacial(lFacial, lModel?.path)
        ) {
          addedFacialMismatch += 1
          const lRec = lModel
            ? recommendForLine(view, lModel, {
                content,
                emotion,
                prevContent,
                prevEmotion,
                prevTense: true,
                isListener: true,
                limit: 3
              })
            : { facials: [], motions: [] }
          extraDiagnostics.push({
            snippetIndex: i,
            lineNumber: talkIdx,
            modelId: lid,
            speaker: lModel ? view.shortName(lModel) : String(lid),
            content: content.slice(0, 60),
            emotion,
            facial: lFacial,
            motion: '',
            inferredMood: 'sad_regret',
            field: 'facial',
            code: 'listener_tense_smile_flip',
            severity: 'high',
            message: `听者前序情绪为「${lPrevEmo}」，切忌突然切为笑脸 ${annotateFacial(lModel?.path, lFacial)}`,
            recommendedFacials: lRec.facials,
            recommendedMotions: lRec.motions
          })
        }
      }
    }
    if (emotion) lastEmotionByModel.set(modelId, emotion)
    prevContent = content
    prevEmotion = emotion
  }

  if (extraDiagnostics.length === 0) return base
  const diagnostics = [...extraDiagnostics, ...base.diagnostics].sort(
    (a, b) =>
      (a.severity === 'high' ? 0 : 1) - (b.severity === 'high' ? 0 : 1) ||
      a.snippetIndex - b.snippetIndex
  )
  return {
    ...base,
    diagnostics,
    facialMismatchCount: base.facialMismatchCount + addedFacialMismatch,
    motionMismatchCount: base.motionMismatchCount + addedMotionMismatch,
    score: Math.max(0, base.score - extraDiagnostics.length * 15),
    passed: false
  }
}

function runActingAndFidelityAudit(story: StoryData, view: CatalogView): ActingFidelityReport {
  if (typeof officialLinterApi.auditStoryActingAndFidelity === 'function') {
    return appendContextAndListenerGuards(
      story,
      view,
      officialLinterApi.auditStoryActingAndFidelity(story, view)
    )
  }
  const officialReport = officialLinterMod.lintOfficialStory(story, view)
  const diagnostics: ActingFidelityDiagnostic[] = []
  const bodyMotions = countBodyMotionsByModel(story)
  const zeroMotionModelIds =
    story.models.length >= 2
      ? story.models.filter((m) => (bodyMotions[String(m.id)] ?? 0) === 0).map((m) => m.id)
      : []

  const lastFacialByModel = new Map<number, { facial: string; run: number }>()
  const lastMotionByModel = new Map<number, { motion: string; run: number }>()
  const lastEmotionByModel = new Map<number, string>()
  const onStage = new Set<number>()
  const listenerIdleTalks = new Map<number, number>()
  let lastBgmKey: string | null = null
  let prevTense = false
  let prevContent = ''
  let prevEmotion = ''
  let talkIdx = 0
  let repeatedFacialRunCount = 0
  let facialMismatchCount = 0
  let motionMismatchCount = 0
  let simultaneousCollisionCount = 0
  let stageDirectionLeakCount = 0
  let listenerFrozenCount = 0
  let duplicateBgmCount = 0

  for (let i = 0; i < story.snippets.length; i++) {
    const snippet = story.snippets[i]
    const rawData = (
      'data' in snippet && snippet.data && typeof snippet.data === 'object' ? snippet.data : {}
    ) as Record<string, unknown>

    if (snippet.type === 'LayoutAppear') {
      const mid = typeof rawData.modelId === 'number' ? rawData.modelId : -1
      if (mid !== -1) {
        onStage.add(mid)
        listenerIdleTalks.set(mid, 0)
      }
      continue
    }
    if (snippet.type === 'LayoutClear') {
      const mid = typeof rawData.modelId === 'number' ? rawData.modelId : -1
      onStage.delete(mid)
      listenerIdleTalks.delete(mid)
      continue
    }
    if (snippet.type === 'Move' || snippet.type === 'Motion') {
      const mid = typeof rawData.modelId === 'number' ? rawData.modelId : -1
      if (mid !== -1 && onStage.has(mid)) listenerIdleTalks.set(mid, 0)
      continue
    }
    if (snippet.type === 'ChangeBgm') {
      const stop = Boolean(rawData.stop)
      const file = stop ? '' : String(rawData.file ?? '').trim()
      const key = `${stop ? 'stop' : 'play'}:${file}`
      if (lastBgmKey !== null && lastBgmKey === key) {
        duplicateBgmCount += 1
        diagnostics.push({
          snippetIndex: i,
          lineNumber: talkIdx,
          modelId: -1,
          speaker: '',
          content: file || 'stop',
          emotion: '',
          facial: '',
          motion: '',
          inferredMood: 'neutral',
          field: 'bgm',
          code: 'duplicate_bgm',
          severity: 'medium',
          message: `重复连续播放相同 BGM（${file || 'stop'}），建议删除冗余 ChangeBgm`,
          recommendedFacials: [],
          recommendedMotions: []
        })
      }
      lastBgmKey = key
      continue
    }

    if (snippet.type !== 'Talk' || !('data' in snippet) || !snippet.data) continue
    talkIdx += 1
    const data = rawData
    const speaker = String(data.speaker ?? '')
    const content = String(data.content ?? '')
    const emotion = String(data.emotion ?? '')
    const modelId = typeof data.modelId === 'number' ? data.modelId : -1

    if (hasSpokenStageDirectionLeak(content)) {
      stageDirectionLeakCount += 1
      diagnostics.push({
        snippetIndex: i,
        lineNumber: talkIdx,
        modelId,
        speaker,
        content: content.slice(0, 60),
        emotion,
        facial: '',
        motion: '',
        inferredMood: inferDramaticMoodFallback({ content, emotion }).mood,
        field: 'dialogue',
        code: 'stage_direction_leak',
        severity: 'high',
        message: '口语台词包含舞台动作括号描写（如「（微笑）」），请移除并改由 motion/facial 表现',
        recommendedFacials: [],
        recommendedMotions: []
      })
    }

    if (modelId === -1) {
      prevContent = content
      prevEmotion = emotion
      continue
    }

    const actions = Array.isArray(data.actions)
      ? (data.actions as Array<Record<string, unknown>>)
      : []
    const bodyActTimes: number[] = []
    for (const act of actions) {
      if (typeof act.motion === 'string' && act.motion.trim()) {
        bodyActTimes.push(typeof act.at === 'number' ? act.at : 0)
      }
    }
    if (bodyActTimes.length >= 2) {
      bodyActTimes.sort((a, b) => a - b)
      for (let k = 1; k < bodyActTimes.length; k++) {
        if (bodyActTimes[k] - bodyActTimes[k - 1] < 0.25 - 1e-6) {
          simultaneousCollisionCount += 1
          diagnostics.push({
            snippetIndex: i,
            lineNumber: talkIdx,
            modelId,
            speaker,
            content: content.slice(0, 60),
            emotion,
            facial: '',
            motion: '',
            inferredMood: inferDramaticMoodFallback({ content, emotion }).mood,
            field: 'staging',
            code: 'simultaneous_motion_collision',
            severity: 'high',
            message: '同一句 Talk 内双人动作时刻间距 <0.25，禁止说话者与听者同瞬碰撞',
            recommendedFacials: [],
            recommendedMotions: []
          })
          break
        }
      }
    }

    const speakerActs = actions.filter((a) => a.modelId === modelId)
    const primaryFacial =
      (typeof speakerActs[0]?.facial === 'string' ? speakerActs[0].facial : '') ||
      (typeof data.facial === 'string' ? data.facial : '')
    const primaryMotion =
      (typeof speakerActs[0]?.motion === 'string' ? speakerActs[0].motion : '') ||
      (typeof data.motion === 'string' ? data.motion : '')
    const model = view.modelById(modelId)
    const profile = getActingProfile(model?.name ?? speaker, '')
    const rec = model
      ? recommendForLine(view, model, {
          content,
          emotion,
          prevContent,
          prevEmotion,
          prevTense,
          restrainedRole: profile.restrained,
          prevFacial: lastFacialByModel.get(modelId)?.facial,
          prevMotion: lastMotionByModel.get(modelId)?.motion
        })
      : {
          mood: inferDramaticMoodFallback({ content, emotion, prevContent, prevEmotion }).mood,
          facials: [],
          motions: []
        }

    if (primaryFacial) {
      const fCompat = facialSemanticsMod.isFacialCompatibleWithLine({
        facial: primaryFacial,
        modelPath: model?.path,
        emotion,
        content,
        prevTense,
        restrainedRole: profile.restrained
      })
      if (!fCompat.ok) {
        facialMismatchCount += 1
        diagnostics.push({
          snippetIndex: i,
          lineNumber: talkIdx,
          modelId,
          speaker,
          content: content.slice(0, 60),
          emotion,
          facial: primaryFacial,
          motion: primaryMotion,
          inferredMood: rec.mood,
          field: 'facial',
          code: fCompat.reason ?? 'facial_mood_mismatch',
          severity: 'high',
          message: `表情 ${annotateFacial(model?.path, primaryFacial)} 与剧情/情绪(${rec.mood})冲突(${fCompat.reason ?? 'mismatch'})`,
          recommendedFacials: rec.facials,
          recommendedMotions: rec.motions
        })
      }
      const prevF = lastFacialByModel.get(modelId)
      const nextRun = prevF && prevF.facial === primaryFacial ? prevF.run + 1 : 1
      lastFacialByModel.set(modelId, { facial: primaryFacial, run: nextRun })
      if (nextRun >= 4 && /^face_normal/i.test(primaryFacial) && !profile.restrained) {
        repeatedFacialRunCount += 1
        diagnostics.push({
          snippetIndex: i,
          lineNumber: talkIdx,
          modelId,
          speaker,
          content: content.slice(0, 60),
          emotion,
          facial: primaryFacial,
          motion: primaryMotion,
          inferredMood: rec.mood,
          field: 'repetition',
          code: 'stale_normal_facial_run',
          severity: 'medium',
          message: `连续 ${nextRun} 句停留在 ${primaryFacial}，建议随台词语气细腻切换`,
          recommendedFacials: rec.facials,
          recommendedMotions: []
        })
      }
    }

    if (primaryMotion) {
      const mCompat = checkMotionCompatibility({
        motion: primaryMotion,
        modelPath: model?.path,
        emotion,
        content,
        prevContent,
        prevEmotion,
        prevTense,
        restrainedRole: profile.restrained
      })
      if (!mCompat.ok) {
        motionMismatchCount += 1
        diagnostics.push({
          snippetIndex: i,
          lineNumber: talkIdx,
          modelId,
          speaker,
          content: content.slice(0, 60),
          emotion,
          facial: primaryFacial,
          motion: primaryMotion,
          inferredMood: rec.mood,
          field: 'motion',
          code: mCompat.reason ?? 'motion_mood_mismatch',
          severity: 'high',
          message: `动作 ${annotateMotion(model?.path, primaryMotion)} 与剧情/情绪(${rec.mood})冲突(${mCompat.reason ?? 'mismatch'})`,
          recommendedFacials: rec.facials,
          recommendedMotions: rec.motions
        })
      }
      const prevM = lastMotionByModel.get(modelId)
      const nextRun = prevM && prevM.motion === primaryMotion ? prevM.run + 1 : 1
      lastMotionByModel.set(modelId, { motion: primaryMotion, run: nextRun })
      if (nextRun >= 4) {
        diagnostics.push({
          snippetIndex: i,
          lineNumber: talkIdx,
          modelId,
          speaker,
          content: content.slice(0, 60),
          emotion,
          facial: primaryFacial,
          motion: primaryMotion,
          inferredMood: rec.mood,
          field: 'repetition',
          code: 'repeated_motion_run',
          severity: 'medium',
          message: `连续 ${nextRun} 句重复动作 ${primaryMotion}，建议在情绪转折处自然换拍`,
          recommendedFacials: [],
          recommendedMotions: rec.motions
        })
      }
    }

    // 听者静止检测（对齐官方 event_145_08）：跳过内心独白，连续 >=4 句无更新才提示，推荐 at: 0 纯表情或句间独立 Motion
    const isMonologueLine = /^[（(]/.test(content.trim()) && /[）)]$/.test(content.trim())
    const activeIds = new Set<number>([modelId])
    for (const act of actions) {
      if (typeof act.modelId === 'number') activeIds.add(act.modelId)
    }
    if (!isMonologueLine) {
      for (const onStageId of onStage) {
        if (activeIds.has(onStageId)) {
          listenerIdleTalks.set(onStageId, 0)
          continue
        }
        const nextIdle = (listenerIdleTalks.get(onStageId) ?? 0) + 1
        listenerIdleTalks.set(onStageId, nextIdle)
        if (nextIdle === 4 || (nextIdle > 4 && nextIdle % 4 === 0)) {
          listenerFrozenCount += 1
          const listenerModel = view.modelById(onStageId)
          const listenerProfile = getActingProfile(listenerModel?.name ?? '', '')
          const listenerRec = listenerModel
            ? recommendForLine(view, listenerModel, {
                content,
                emotion,
                prevContent,
                prevEmotion,
                prevTense,
                isListener: true,
                restrainedRole: listenerProfile.restrained,
                limit: 3
              })
            : { mood: 'attentive_listen' as DramaticContextMood, facials: [], motions: [] }
          diagnostics.push({
            snippetIndex: i,
            lineNumber: talkIdx,
            modelId,
            listenerModelId: onStageId,
            speaker,
            content: content.slice(0, 60),
            emotion,
            facial: '',
            motion: '',
            inferredMood: listenerRec.mood,
            field: 'staging',
            code: 'listener_frozen',
            severity: 'medium',
            message: `在场听者(modelId=${onStageId})已连续 ${nextIdle} 句静止无反应，建议在 actions 中于 at: 0 添加纯表情(facial-only)切换，或在情绪转折点句间插入独立 Motion 片段`,
            recommendedFacials: listenerRec.facials,
            recommendedMotions: listenerRec.motions
          })
        }
      }
    }

    const lineCtx = inferDramaticMoodFallback({ content, emotion, prevContent, prevEmotion })
    for (const act of actions) {
      const lid = typeof act.modelId === 'number' ? act.modelId : -1
      const lFacial = typeof act.facial === 'string' ? act.facial.trim() : ''
      if (lid !== -1 && lid !== modelId && lFacial) {
        const lPrevEmo = lastEmotionByModel.get(lid) ?? ''
        const lModel = view.modelById(lid)
        if (
          (lPrevEmo === '生气' || lPrevEmo === '伤心') &&
          facialSemanticsMod.isSmileLikeFacial(lFacial, lModel?.path)
        ) {
          facialMismatchCount += 1
          const lRec = lModel
            ? recommendForLine(view, lModel, {
                content,
                emotion,
                prevContent,
                prevEmotion,
                prevTense: true,
                isListener: true,
                limit: 3
              })
            : { facials: [], motions: [] }
          diagnostics.push({
            snippetIndex: i,
            lineNumber: talkIdx,
            modelId: lid,
            speaker: lModel ? view.shortName(lModel) : String(lid),
            content: content.slice(0, 60),
            emotion,
            facial: lFacial,
            motion: '',
            inferredMood: 'sad_regret',
            field: 'facial',
            code: 'listener_tense_smile_flip',
            severity: 'high',
            message: `听者前序情绪为「${lPrevEmo}」，切忌突然切为笑脸 ${annotateFacial(lModel?.path, lFacial)}`,
            recommendedFacials: lRec.facials,
            recommendedMotions: lRec.motions
          })
        }
      }
    }
    if (emotion) lastEmotionByModel.set(modelId, emotion)
    prevTense = lineCtx.tense
    prevContent = content
    prevEmotion = emotion
  }

  const highCount = diagnostics.filter((d) => d.severity === 'high').length
  const medCount = diagnostics.filter((d) => d.severity === 'medium').length
  const penalty =
    highCount * 15 +
    medCount * 5 +
    officialReport.issues.length * 15 +
    (talkIdx >= 6 ? zeroMotionModelIds.length * 12 : 0)
  const score = Math.max(0, Math.min(100, 100 - penalty))
  const passed =
    officialReport.passed && highCount === 0 && (talkIdx < 6 || zeroMotionModelIds.length === 0)

  return {
    passed,
    score,
    talkCount: talkIdx,
    diagnostics,
    zeroMotionModelIds,
    repeatedFacialRunCount,
    facialMismatchCount,
    motionMismatchCount,
    simultaneousCollisionCount,
    stageDirectionLeakCount,
    listenerFrozenCount,
    duplicateBgmCount,
    officialReport
  }
}

function annotateFacial(modelPath: string | undefined, facialName: string): string {
  return facialSemanticsMod.annotateFacialName(modelPath, facialName)
}

function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return {}
    }
  }
  return {}
}

function addUsage(acc: ChatUsage, delta: ChatUsage | null): void {
  if (!delta) return
  if (delta.promptTokens !== undefined)
    acc.promptTokens = (acc.promptTokens ?? 0) + delta.promptTokens
  if (delta.completionTokens !== undefined) {
    acc.completionTokens = (acc.completionTokens ?? 0) + delta.completionTokens
  }
  if (delta.totalTokens !== undefined) acc.totalTokens = (acc.totalTokens ?? 0) + delta.totalTokens
}

function findModel(view: CatalogView, modelId?: unknown, character?: unknown): CatalogModel | null {
  if (typeof modelId === 'number' && Number.isFinite(modelId)) {
    const byId = view.modelById(modelId)
    if (byId) return byId
  }
  const q = typeof character === 'string' ? character.trim().toLowerCase() : ''
  if (!q) return null
  return (
    view.models.find(
      (m) =>
        m.name.toLowerCase() === q ||
        (m.shortName ?? '').toLowerCase() === q ||
        (m.cloudId ?? '').toLowerCase() === q
    ) ??
    view.models.find(
      (m) =>
        m.name.toLowerCase().includes(q) || (m.shortName && q.includes(m.shortName.toLowerCase()))
    ) ??
    null
  )
}

function countBodyMotionsByModel(story: StoryData): Record<string, number> {
  const counts = new Map<number, number>()
  for (const m of story.models) {
    counts.set(m.id, 0)
  }
  for (const snippet of story.snippets) {
    const data = ('data' in snippet && snippet.data ? snippet.data : {}) as Record<string, unknown>
    if (snippet.type === 'Talk') {
      const actions = Array.isArray(data.actions) ? data.actions : []
      for (const act of actions) {
        if (!act || typeof act !== 'object') continue
        const rec = act as Record<string, unknown>
        if (typeof rec.motion === 'string' && rec.motion.trim()) {
          const mid = Number(rec.modelId ?? data.modelId)
          counts.set(mid, (counts.get(mid) ?? 0) + 1)
        }
      }
      if (typeof data.motion === 'string' && data.motion.trim()) {
        const mid = Number(data.modelId)
        counts.set(mid, (counts.get(mid) ?? 0) + 1)
      }
    } else if (snippet.type === 'Motion' || snippet.type === 'Move') {
      if (typeof data.motion === 'string' && data.motion.trim()) {
        const mid = Number(data.modelId)
        counts.set(mid, (counts.get(mid) ?? 0) + 1)
      }
    }
  }
  const out: Record<string, number> = {}
  for (const m of story.models) {
    out[`${m.id}`] = counts.get(m.id) ?? 0
  }
  return out
}

function expandMoodTokens(mood: string): string[] {
  const rawTokens = mood
    .toLowerCase()
    .split(/[\s,，/、]+/)
    .filter(Boolean)
  const expanded = new Set<string>(rawTokens)
  for (const entry of MOOD_QUERY_SYNONYMS) {
    if (entry.kw.test(mood)) {
      for (const tok of entry.tokens) expanded.add(tok)
    }
  }
  return [...expanded]
}

function extractDialogueLinesFromStory(
  story: Record<string, unknown>
): Array<{ id: string; speaker: string; content: string; emotion?: string; snippetIndex: number }> {
  const snippets = Array.isArray(story.snippets) ? story.snippets : []
  const lines: Array<{
    id: string
    speaker: string
    content: string
    emotion?: string
    snippetIndex: number
  }> = []
  snippets.forEach((raw, idx) => {
    if (!raw || typeof raw !== 'object') return
    const rec = raw as Record<string, unknown>
    if (rec.type !== 'Talk' || !rec.data || typeof rec.data !== 'object') return
    const d = rec.data as Record<string, unknown>
    const content = typeof d.content === 'string' ? d.content.trim() : ''
    if (!content) return
    lines.push({
      id: `l${lines.length + 1}`,
      speaker: typeof d.speaker === 'string' ? d.speaker.trim() : '',
      content,
      ...(typeof d.emotion === 'string' && d.emotion ? { emotion: d.emotion } : {}),
      snippetIndex: idx
    })
  })
  return lines
}

function isStoryObjectCandidate(val: unknown): boolean {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return false
  const rec = val as Record<string, unknown>
  return Array.isArray(rec.snippets)
}

function buildDirectorStageTelemetry(
  story: Record<string, unknown>,
  targetMinutes?: number
): DirectorStageTelemetry {
  const snippets = Array.isArray(story.snippets)
    ? (story.snippets as Array<Record<string, unknown>>)
    : []
  let talkCount = 0
  let playSeCount = 0
  let bgmCueCount = 0
  let firstTalkIdx = -1
  let firstBgmIdx = -1
  let firstBgmPlayTalkCount = -1
  let hasBgmSilenceCut = false
  let standaloneMotionCount = 0
  let moveCount = 0
  let waitCount = 0
  let ambientColorCount = 0
  let cameraOrShakeCount = 0
  let talkWithMotion = 0
  let talkFacialOnly = 0
  let talkStill = 0
  let totalTalkChars = 0
  let longTalkCount = 0
  let soloTalkCount = 0
  const onStage = new Set<number>()
  const emotionCounts = new Map<string, number>()
  let calmOnCryOrSadFacialCount = 0
  let missingCaptionCount = 0
  const distinctMotions = new Set<string>()
  const distinctFacials = new Set<string>()
  const motionRunByModel = new Map<number, { motion: string; run: number }>()
  let maxSameMotionRun = 0

  for (let i = 0; i < snippets.length; i++) {
    const s = snippets[i]
    if (!s || typeof s !== 'object') continue
    const kind = String(s.type ?? '')
    const d = (s.data && typeof s.data === 'object' ? s.data : {}) as Record<string, unknown>
    if (kind === 'LayoutAppear') {
      if (typeof d.modelId === 'number') onStage.add(d.modelId)
    } else if (kind === 'LayoutClear') {
      if (typeof d.modelId === 'number') onStage.delete(d.modelId)
    } else if (kind === 'PlaySe') {
      playSeCount += 1
    } else if (kind === 'ChangeBgm') {
      bgmCueCount += 1
      if (firstBgmIdx === -1) firstBgmIdx = i
      if (d.stop === true) hasBgmSilenceCut = true
      else if (firstBgmPlayTalkCount === -1 && typeof d.file === 'string' && d.file.trim()) {
        firstBgmPlayTalkCount = talkCount
      }
    } else if (kind === 'Motion') {
      standaloneMotionCount += 1
    } else if (kind === 'Move') {
      moveCount += 1
    } else if (kind === 'Wait') {
      waitCount += 1
    } else if (kind === 'AmbientColor') {
      ambientColorCount += 1
    } else if (
      kind === 'CameraZoom' ||
      kind === 'CameraMove' ||
      kind === 'DollyZoom' ||
      kind === 'ShakeScreen' ||
      kind === 'ShakeWindow' ||
      kind === 'CharacterShake'
    ) {
      cameraOrShakeCount += 1
    } else if (kind === 'Talk') {
      talkCount += 1
      if (firstTalkIdx === -1) firstTalkIdx = i
      if (onStage.size === 1) soloTalkCount += 1
      const contentStr = typeof d.content === 'string' ? d.content.replace(/\s+/g, '') : ''
      const chars = Array.from(contentStr).length
      totalTalkChars += chars
      if (chars >= 24) longTalkCount += 1
      const emoStr = typeof d.emotion === 'string' ? d.emotion.trim() : ''
      if (emoStr) emotionCounts.set(emoStr, (emotionCounts.get(emoStr) ?? 0) + 1)
      const mid = typeof d.modelId === 'number' ? d.modelId : -1
      const acts = Array.isArray(d.actions) ? (d.actions as Array<Record<string, unknown>>) : []
      const speakerActs = acts.filter((a) => a && (a.modelId === mid || a.modelId === undefined))
      const speakerMotion =
        speakerActs.find((a) => typeof a.motion === 'string' && a.motion.trim())?.motion ??
        (typeof d.motion === 'string' && d.motion.trim() ? d.motion : '')
      const speakerFacial =
        speakerActs.find((a) => typeof a.facial === 'string' && a.facial.trim())?.facial ??
        (typeof d.facial === 'string' && d.facial.trim() ? d.facial : '')
      const mStr = typeof speakerMotion === 'string' ? speakerMotion.trim() : ''
      const fStr = typeof speakerFacial === 'string' ? speakerFacial.trim() : ''
      const allSpeakerFacials = [
        fStr,
        ...speakerActs
          .map((a) => (typeof a.facial === 'string' ? a.facial.trim() : ''))
          .filter(Boolean)
      ].join(' ')
      if ((!emoStr || emoStr === '平静') && /(?:cry|sad|nhisad|heartbreak|desperate)/i.test(allSpeakerFacials)) {
        calmOnCryOrSadFacialCount += 1
      }
      if (typeof d.ttsCaption !== 'string' || !d.ttsCaption.trim()) {
        missingCaptionCount += 1
      }
      if (mStr) {
        talkWithMotion += 1
        distinctMotions.add(mStr)
        if (mid !== -1) {
          const prev = motionRunByModel.get(mid)
          const run = prev && prev.motion === mStr ? prev.run + 1 : 1
          motionRunByModel.set(mid, { motion: mStr, run })
          if (run > maxSameMotionRun) maxSameMotionRun = run
        }
      } else if (fStr) {
        talkFacialOnly += 1
      } else {
        talkStill += 1
      }
      if (fStr) distinctFacials.add(fStr)
      for (const a of acts) {
        if (typeof a?.motion === 'string' && a.motion.trim()) distinctMotions.add(a.motion.trim())
        if (typeof a?.facial === 'string' && a.facial.trim()) distinctFacials.add(a.facial.trim())
      }
    }
  }

  const hasTopLevelBgm = Array.isArray(story.bgm)
    ? story.bgm.length > 0
    : typeof story.bgm === 'string' && story.bgm.trim().length > 0
  const hasOpeningBgm =
    hasTopLevelBgm ||
    (firstBgmPlayTalkCount !== -1 && firstBgmPlayTalkCount <= 4) ||
    (firstBgmIdx !== -1 && (firstTalkIdx === -1 || firstBgmIdx < firstTalkIdx))
  const talkWithMotionShare = talkCount > 0 ? Number((talkWithMotion / talkCount).toFixed(2)) : 0
  const talkFacialOnlyShare = talkCount > 0 ? Number((talkFacialOnly / talkCount).toFixed(2)) : 0
  const talkStillShare = talkCount > 0 ? Number((talkStill / talkCount).toFixed(2)) : 0
  const avgTalkChars = talkCount > 0 ? Number((totalTalkChars / talkCount).toFixed(1)) : 0
  const longLineShare = talkCount > 0 ? Number((longTalkCount / talkCount).toFixed(2)) : 0
  const soloTalkShare = talkCount > 0 ? Number((soloTalkCount / talkCount).toFixed(2)) : 0
  let dominantEmotion: string | undefined
  let dominantEmotionCount = 0
  for (const [emo, cnt] of emotionCounts) {
    if (cnt > dominantEmotionCount) {
      dominantEmotion = emo
      dominantEmotionCount = cnt
    }
  }
  const dominantEmotionShare =
    talkCount > 0 && dominantEmotionCount > 0
      ? Number((dominantEmotionCount / talkCount).toFixed(2))
      : undefined

  const reviewFocusPoints: string[] = []
  if (talkCount >= 10 && playSeCount === 0) {
    reviewFocusPoints.push(
      '全片 0 个 PlaySe 音效（官方近期剧集 96% 含音效）：请在脚步、奔跑、开关门、衣料/翻纸、惊觉或转场处点缀 2~5 处 PlaySe'
    )
  }
  if (talkCount >= 8 && !hasOpeningBgm) {
    reviewFocusPoints.push(
      '开场前段未设置 BGM（严禁大段无声冷开场）：请在首句 Talk 前用 ChangeBgm 配上贴合氛围的曲目（除非刻意仅留 2~4 句冷开场并在第 5 句前切入 ChangeBgm）'
    )
  }
  if (typeof targetMinutes === 'number' && targetMinutes >= 0.5) {
    const maxTalksForBudget = Math.max(12, Math.round(targetMinutes * 12.5))
    const minTalksForBudget = Math.max(8, Math.round(targetMinutes * 9.5))
    const idealMaxTalks = Math.max(minTalksForBudget + 4, Math.round(targetMinutes * 12))
    if (talkCount > maxTalksForBudget) {
      reviewFocusPoints.push(
        `全片共 ${talkCount} 句 Talk（按约 7 秒/句约 ${((talkCount * 7) / 60).toFixed(1)} 分钟，超出目标 ${targetMinutes} 分钟）：请用 delete/update_talk 精简重复独白或合并铺垫，收束至 ${minTalksForBudget}~${idealMaxTalks} 句`
      )
    }
  }
  if (talkCount >= 18 && !hasBgmSilenceCut && bgmCueCount <= 1) {
    reviewFocusPoints.push(
      '长场次 BGM 全程单一未切停：可在情绪转折或爆发前用 ChangeBgm({stop:true}) 制造留白或切曲'
    )
  }
    if (talkCount >= 14 && standaloneMotionCount === 0 && waitCount === 0) {
      reviewFocusPoints.push(
        '舞台节奏偏平（0 独立 Motion、0 Wait）：可在情绪重拍或长句后插入 4~8 处句间独立 Motion 静默反应拍或短 Wait，切忌使用 Move 横向滑动'
      )
    }
    if (talkCount >= 16 && soloTalkShare < 0.15) {
      reviewFocusPoints.push(
        `单人 Center 特写占比偏低（${(soloTalkShare * 100).toFixed(0)}%）：可在内心独白或强情绪段使用 LayoutClear + LayoutAppear(Center) 原地淡入淡出切镜（isMoved:false）`
      )
    }
    if (talkCount >= 16 && distinctMotions.size <= 8) {
      reviewFocusPoints.push(
        `全片仅使用了 ${distinctMotions.size} 种不同身体动作，容易陷入机械循环（近期官方主演单集约 18~30+ 种）：请从角色全量动作库补充不同编号及贴合气氛的跨风格动作`
      )
    }
    if (talkCount >= 12 && cameraOrShakeCount >= 4 && dominantEmotion === '平静') {
      reviewFocusPoints.push(
        `日常/平静场景镜头与震动偏多（${cameraOrShakeCount} 处）：请克制 CameraZoom/CameraMove（0~1 次）与 CharacterShake（仅真实受惊/物理碰撞），避免公式化抖动`
      )
    }
  if (talkCount >= 14 && avgTalkChars >= 19 && longLineShare >= 0.35) {
    reviewFocusPoints.push(
      `台词均长 ${avgTalkChars} 字且长句占比 ${(longLineShare * 100).toFixed(0)}%，容易像书面说明（官方近期多为短反应与中等句交错）：可将部分解释句拆短，留出停顿与潜台词`
    )
  }
  if (talkCount >= 16 && dominantEmotion && (dominantEmotionShare ?? 0) >= 0.8) {
    reviewFocusPoints.push(
      `情绪标签有 ${((dominantEmotionShare ?? 0) * 100).toFixed(0)}% 锁死在「${dominantEmotion}」：可按情绪铺垫、试探、动摇、收尾的层次微调 emotion，避免语音全程单调`
    )
  }
  if (calmOnCryOrSadFacialCount > 0) {
    reviewFocusPoints.push(
      `发现 ${calmOnCryOrSadFacialCount} 条哭泣/悲伤表情（face_cry_*/face_sad_*）错标为「平静」或空情绪：请在 update_talk 中改标为「伤心」，避免哭戏 TTS 笑场`
    )
  }
  if (talkCount >= 8 && missingCaptionCount === talkCount) {
    reviewFocusPoints.push(
      '当前草稿缺少逐句日语 ttsCaption（含哭腔/高潮 ttsSpecialScene）：建议在重要情感转折与高潮哭喊句补上 ttsCaption（严禁年龄/性别词）与 ttsSpecialScene: true（<=15%）'
    )
  }
  if (talkCount >= 12 && talkWithMotionShare > 0.9) {
    reviewFocusPoints.push(
      `说话带动作占比 ${(talkWithMotionShare * 100).toFixed(0)}% 偏满：可让约 15%~25% 的承接/情绪延续句省略 motion（自然保持姿态或只微调 facial），避免逐句乱动`
    )
  }

  return {
    snippetCount: snippets.length,
    talkCount,
    avgTalkChars,
    longLineShare,
    soloTalkShare,
    playSeCount,
    bgmCueCount,
    hasOpeningBgm,
    hasBgmSilenceCut,
    standaloneMotionCount,
    moveCount,
    waitCount,
    ambientColorCount,
    cameraOrShakeCount,
    talkWithMotionShare,
    talkFacialOnlyShare,
    talkStillShare,
    distinctMotionsUsed: distinctMotions.size,
    distinctFacialsUsed: distinctFacials.size,
    maxSameMotionRun,
    ...(dominantEmotion ? { dominantEmotion, dominantEmotionShare } : {}),
    reviewFocusPoints
  }
}

/**
 * 构建供 Agentic Loop 使用的完整自主导演工具集：
 * - 角色、服装与表情/动作一体化批量查询（lookup_character, inspect_character_expressions, recommend_acting_for_lines）
 * - 官方资源/特效/场景 Cue 批量检索（search_assets）
 * - 官方语料与演技规范检索（search_official_corpus）
 * - 状态化大纲、草稿管理与导演终审（plan_story_outline, save_story_draft, inspect_story_draft, patch_story_draft, submit_director_review, finalize_story_draft）
 * - 对白、舞台、剧情表情动作逐句质检（validate_dialogue_draft, critique_story_draft, validate_story_draft）
 */
export function createStoryAgentToolkit(deps: StoryAgentToolkitDeps): StoryAgentToolkit {
  const { view, personas, emotionLabels = [], targetMinutes, ragRetriever, logger } = deps

  let savedPlan: SavedStoryPlan | null = null
  let savedDraft: Record<string, unknown> | null = null
  let directorReview: DirectorReviewRecord | null = null
  let finalized = false

  const definitions: LlmToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'lookup_character',
        description:
          '一次批量查询全部出场角色的 modelId、模型路径、可用服装、人设口吻、表演气质；设 includeExpressions: true 时同步返回按情绪分组的丰富表情与多风格动作调色板（1 次调用即可替代多轮 lookup + inspect_character_expressions！）。',
        parameters: {
          type: 'object',
          properties: {
            character: {
              type: 'string',
              description: '单个角色全名、简称或关键字（多角色请优先用 characters 数组）'
            },
            characters: {
              type: 'array',
              items: { type: 'string' },
              description: '推荐：一次批量查询多个出场角色（如 ["瑞希","绘名"]），节省步数'
            },
            modelId: { type: 'number', description: '可选单个角色 modelId' },
            modelIds: {
              type: 'array',
              items: { type: 'number' },
              description: '可选：一次批量查询多个 modelId'
            },
            includeExpressions: {
              type: 'boolean',
              description:
                '推荐设为 true：同步返回每个角色按情绪分组的多样化表情（含 cry/sad 变体）与跨风格动作调色板，省去额外的 inspect_character_expressions 轮次'
            },
            moods: {
              type: 'array',
              items: { type: 'string' },
              description: '配合 includeExpressions 使用的情绪清单（留空则返回核心 7 类情绪总览）'
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'inspect_character_expressions',
        description:
          '按情绪/剧情台词语义查询指定角色（支持 modelIds/characters 一次查多角色、moods 一次查多情绪）的可用身体动作（motion）和带 motion3 语义注释的表情（facial）。若 lookup_character 已设 includeExpressions: true，通常无需再重复调用。',
        parameters: {
          type: 'object',
          properties: {
            modelId: { type: 'number', description: '单个角色 modelId' },
            modelIds: {
              type: 'array',
              items: { type: 'number' },
              description: '批量查询多个角色 modelId'
            },
            character: { type: 'string', description: '单个角色名或简称（未传 modelId 时使用）' },
            characters: {
              type: 'array',
              items: { type: 'string' },
              description: '批量查询多个角色名或简称'
            },
            mood: {
              type: 'string',
              description:
                '按单个情绪或动作关键词筛选，例如：伤心、苦笑、道歉、微笑、生气、点头、思考'
            },
            moods: {
              type: 'array',
              items: { type: 'string' },
              description:
                '推荐：一次批量查询多个情绪（如 ["伤心","生气","惊讶","平静","困扰"]），节省工具步数'
            },
            dialogueLine: {
              type: 'string',
              description:
                '可选：传入实际台词文本，自动推导戏剧气氛并优先返回最贴合该句的表情与动作'
            },
            emotion: {
              type: 'string',
              description: '可选：TTS 情绪标签（平静/开心/生气/伤心/害羞/惊讶）'
            },
            kind: {
              type: 'string',
              enum: ['all', 'motion', 'facial'],
              description: '只查动作、只查表情或全查（默认 all）'
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'recommend_acting_for_lines',
        description:
          '按需为指定台词匹配贴合剧情情绪的表情与动作候选。注意：常规创作无需把整场几十句台词重发一遍给此工具！直接基于 lookup_character(includeExpressions:true) 的调色板起草进 save_story_draft；仅在审校阶段对少数疑难句调用（支持 useCurrentDraft: true + onlyIssues: true 或 snippetIndices 免重发台词）。',
        parameters: {
          type: 'object',
          properties: {
            useCurrentDraft: {
              type: 'boolean',
              description:
                '直接从已保存草稿读取台词（无需重复传 lines），推荐配合 onlyIssues 或 snippetIndices 使用'
            },
            onlyIssues: {
              type: 'boolean',
              description: '配合 useCurrentDraft 使用：仅针对审校标出的问题台词返回替代建议'
            },
            snippetIndices: {
              type: 'array',
              items: { type: 'number' },
              description: '配合 useCurrentDraft 使用：仅查询指定 snippet 下标的台词'
            },
            limit: {
              type: 'number',
              description: '每句返回的候选上限（默认小批量 4、大批量 2，保持上下文紧凑）'
            },
            lines: {
              type: 'array',
              description:
                '可选：手动传入少量待查台词 [{ id?, modelId?, speaker?, content, emotion?, isListener?, isMonologue?, listenerModelId?, listenerSpeaker? }]',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  modelId: { type: 'number' },
                  speaker: { type: 'string' },
                  content: { type: 'string' },
                  emotion: { type: 'string' },
                  isListener: { type: 'boolean' },
                  isMonologue: { type: 'boolean' },
                  listenerModelId: {
                    type: 'number',
                    description: '可选：同台听者 modelId，提供时同步返回句首(at: 0)听者微表情建议'
                  },
                  listenerSpeaker: {
                    type: 'string',
                    description: '可选：同台听者角色名（未传 listenerModelId 时使用）'
                  }
                },
                required: ['content']
              }
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_assets',
        description:
          '检索目录中真实存在的背景（background）、BGM、官方音效（se）、场景粒子特效（effect）与角色换装（outfit）。支持传 kinds 数组和 queries 数组在单次调用内批量检索多类素材！',
        parameters: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['background', 'bgm', 'se', 'effect', 'outfit', 'all'],
              description: '单个资源类别（批量查询时优先用 kinds）'
            },
            kinds: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['background', 'bgm', 'se', 'effect', 'outfit', 'all']
              },
              description: '推荐：一次批量查询多个类别，如 ["background","bgm","se"]'
            },
            query: {
              type: 'string',
              description: '单个场景/时段/氛围/服装关键词，如 夜晚、天台、校服、钢琴、脚步'
            },
            queries: {
              type: 'array',
              items: { type: 'string' },
              description: '推荐：一次批量传入多个关键词（如 ["连廊","悲伤","脚步"]），合并去重返回'
            },
            character: { type: 'string', description: '查询 outfit 时可指定角色名' },
            modelId: { type: 'number', description: '查询 outfit 时可指定基础 modelId' },
            limit: { type: 'number', description: '每类最多返回条数（默认 12）' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_official_corpus',
        description:
          '检索 Project SEKAI 官方剧情语料示例、对白节奏参考与官方演出规范（用于把握角色真实口吻、断句、停顿和单人留白，严禁照抄原句）。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '剧情事件、关系或地点关键词' },
            stage: {
              type: 'string',
              enum: ['cast', 'dialogue', 'acting'],
              description: '参考阶段（默认 dialogue）'
            }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'plan_story_outline',
        description:
          '规划并保存本场剧本结构大纲（标题、出场角色、自然分幕、起承转合节点、意象回扣、两两称呼表），自动校验角色/背景/BGM 并提示是否过度分幕。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            logline: { type: 'string' },
            event: { type: 'string' },
            cast: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  modelId: { type: 'number' },
                  name: { type: 'string' },
                  role: { type: 'string' }
                }
              }
            },
            scenes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  summary: { type: 'string' },
                  background: { type: 'string' },
                  ambient: { type: 'string', enum: ['normal', 'evening', 'night'] },
                  transitionIn: { type: 'string' },
                  activeCast: { type: 'array', items: { type: 'string' } },
                  bgm: { type: 'string' },
                  isFlashback: { type: 'boolean' },
                  isSekai: { type: 'boolean' }
                }
              }
            },
            beats: { type: 'array', items: { type: 'string' } },
            turningPoint: { type: 'string' },
            openingMotif: { type: 'string' },
            closingCallback: { type: 'string' },
            pairwiseAddress: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  from: { type: 'string' },
                  to: { type: 'string' },
                  zh: { type: 'string' },
                  ja: { type: 'string' }
                }
              }
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'validate_dialogue_draft',
        description:
          '用规则质检器检查台词草稿：检测括号动作提示泄露、AI 抒情套话、结尾说教、齐整句长、称呼偏差与文本框溢出，同时允许正常括号心里话。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            lines: {
              type: 'array',
              description: '台词数组 [{ id?, speaker, content }]',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  speaker: { type: 'string' },
                  content: { type: 'string' }
                },
                required: ['speaker', 'content']
              }
            }
          },
          required: ['lines']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'save_story_draft',
        description:
          '保存当前完整 StoryData 草稿到 Agent 工作区，并立即返回精简质检摘要（无需重复回传长 JSON），后续可直接用 inspect_story_draft / patch_story_draft 局部精修并 finalize_story_draft 交卷。',
        parameters: {
          type: 'object',
          properties: {
            story: {
              type: 'object',
              description: '完整 StoryData 对象（含 models、images、snippets，可选 bgm）'
            },
            models: { type: 'array', items: { type: 'object' } },
            images: { type: 'array', items: { type: 'object' } },
            snippets: { type: 'array', items: { type: 'object' } },
            bgm: { type: 'array', items: { type: 'string' } }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'inspect_story_draft',
        description:
          '分页或按问题筛选查看已保存的剧本草稿片段（按 snippet 索引返回角色、台词、表情、动作、delay 等紧凑视图），用于精准定位要修补的行。',
        parameters: {
          type: 'object',
          properties: {
            startIndex: { type: 'number', description: '起始 snippet 下标（默认 0）' },
            endIndex: {
              type: 'number',
              description: '结束 snippet 下标（不含，默认 startIndex + 25）'
            },
            type: {
              type: 'string',
              enum: ['all', 'Talk', 'LayoutAppear', 'LayoutClear', 'Motion', 'Move', 'transitions'],
              description: '筛选片段类型'
            },
            onlyIssues: {
              type: 'boolean',
              description: '仅列出存在表演/官方规范问题的片段（默认 false）'
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'patch_story_draft',
        description:
          '对已保存的草稿执行局部外科修补（改某句台词、切换某个 Talk/Appear/Motion 的 facial 或 motion、增删片段），无需重写整份大 JSON！',
        parameters: {
          type: 'object',
          properties: {
            models: {
              type: 'array',
              items: { type: 'object' },
              description: '可选：整体替换 models'
            },
            images: {
              type: 'array',
              items: { type: 'object' },
              description: '可选：整体替换 images'
            },
            operations: {
              type: 'array',
              description: '局部修改操作列表（按顺序应用）',
              items: {
                type: 'object',
                properties: {
                  op: {
                    type: 'string',
                    enum: [
                      'replace',
                      'update_talk',
                      'update_acting',
                      'upsert_listener_action',
                      'insert_before',
                      'insert_after',
                      'delete'
                    ]
                  },
                  index: { type: 'number', description: '目标 snippet 下标' },
                  snippet: { type: 'object', description: 'replace 时的新 snippet 对象' },
                  snippets: {
                    type: 'array',
                    items: { type: 'object' },
                    description: 'insert_before / insert_after 时要插入的 snippet 数组'
                  },
                  content: { type: 'string' },
                  emotion: { type: 'string' },
                  ttsCaption: {
                    type: 'string',
                    description: '可选：IrodoriTTS 逐句日语声演/韵律描述（不含年龄/性别/声线词）'
                  },
                  ttsSpeed: {
                    type: 'number',
                    description: '可选：IrodoriTTS 语速微调（常规 0.92~1.08，高潮 0.85~1.18）'
                  },
                  ttsSpecialScene: {
                    type: 'boolean',
                    description: '可选：极端哭喊/崩溃/耳语高潮句设为 true（整场 <= 15%）'
                  },
                  delay: { type: 'number' },
                  closeWindowOnFinish: { type: 'boolean' },
                  motion: {
                    type: 'string',
                    description: '说话者或片段主体的 motion（设为空串可清除）'
                  },
                  facial: { type: 'string', description: '说话者或片段主体的 facial' },
                  listenerAction: {
                    type: 'object',
                    description:
                      '为 Talk 片段新增/更新听者反应（默认 at: 0 纯表情，不与说话者身体动作冲突；如需听者身体动作请插独立 Motion 片段）',
                    properties: {
                      modelId: { type: 'number', description: '听者 modelId' },
                      at: { type: 'number', description: '触发时刻（默认 0，纯表情无需错峰）' },
                      facial: { type: 'string', description: '听者微表情（推荐仅传 facial）' },
                      motion: {
                        type: 'string',
                        description:
                          '可选：仅当说话者本句无身体动作时生效；否则自动保留纯表情以避免双人动作碰撞'
                      },
                      remove: { type: 'boolean', description: '为 true 时移除该听者的动作' }
                    },
                    required: ['modelId']
                  },
                  actions: {
                    type: 'array',
                    items: { type: 'object' },
                    description: '直接替换 Talk/Motion 的 actions 数组'
                  }
                },
                required: ['op', 'index']
              }
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'critique_story_draft',
        description:
          '对剧本草稿运行全维度逐句导演审校：检查剧情与表情/动作语义冲突、重复呆板表情、0动作角色、双人同瞬动作碰撞、括号动作泄露、官方节奏规范与对白质感，并给出逐句推荐替代项！',
        parameters: {
          type: 'object',
          properties: {
            story: {
              type: 'object',
              description: '可选：待检查 StoryData（省略时直接检查已保存的草稿）'
            },
            useCurrentDraft: { type: 'boolean' },
            maxDiagnostics: { type: 'number', description: '最多返回诊断条数（默认 15）' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'validate_story_draft',
        description:
          '运行完整 Schema 校验 + 官方舞台规范检查（入场冲突、双人同瞬动作、动作切换分布、括号动作泄露、背景与资源合法性），支持直接校验已保存草稿。',
        parameters: {
          type: 'object',
          properties: {
            story: {
              type: 'object',
              description: '完整 StoryData JSON 对象（省略时校验已保存的草稿）'
            },
            useCurrentDraft: { type: 'boolean' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'submit_director_review',
        description:
          '对已保存剧本执行真正的【5 维导演终审】，审视：戏剧弧光与收尾、情绪连贯与人物口吻、BGM/PlaySe 音效设计、舞台节奏（Wait/独立 Motion 静默拍/Move/单双人切镜/淡入淡出）与表情动作自然度；可同步提交 operations 一次性完成所有外科修补，并设 finalizeIfReady: true 一步定稿！',
        parameters: {
          type: 'object',
          properties: {
            dramaticArc: {
              type: 'string',
              description:
                '评估开场抓手、中段情绪转折、句长节奏（是否有短促反应与潜台词）与结尾余韵'
            },
            emotionalContinuityAndVoice: {
              type: 'string',
              description:
                '评估角色口吻真实度、情绪过渡自然度（严禁在哭泣/悲伤/紧绷段穿插「平静」标签，避免哭戏 TTS 笑场）与关键句 ttsCaption/ttsSpecialScene 声演设计'
            },
            audioAndSeDesign: {
              type: 'string',
              description: '评估开场与切停 BGM（如高潮静音留白）及 PlaySe 物理/情绪音效是否到位'
            },
            stageRhythm: {
              type: 'string',
              description:
                '评估单人 Center 特写与双人 Left/Right 原地淡入淡出切镜（isMoved:false，严禁 Move 滑动）、Wait/独立 Motion 静默拍（每 40 句约 16~22 处）、SideFade/Flashback/AmbientColor 与克制的镜头/震动使用'
            },
            actingNaturalness: {
              type: 'string',
              description:
                '评估表情/动作多样性与自然度（避免 4 动作死循环，也避免机械每句乱动；情绪延续自然保持姿态或微调表情）'
            },
            concreteFixes: {
              type: 'array',
              items: { type: 'string' },
              description: '本轮审校发现并准备修补的具体清单（若无须修改可为空数组）'
            },
            operations: {
              type: 'array',
              description:
                '可选：与 patch_story_draft 完全相同格式的局部修补操作列表，将在审校同时落地',
              items: {
                type: 'object',
                properties: {
                  op: {
                    type: 'string',
                    enum: [
                      'replace',
                      'update_talk',
                      'update_acting',
                      'upsert_listener_action',
                      'insert_before',
                      'insert_after',
                      'delete'
                    ]
                  },
                  index: { type: 'number' },
                  snippet: { type: 'object' },
                  snippets: { type: 'array', items: { type: 'object' } },
                  content: { type: 'string' },
                  emotion: { type: 'string' },
                  ttsCaption: {
                    type: 'string',
                    description: '可选：IrodoriTTS 逐句日语声演/韵律描述（不含年龄/性别/声线词）'
                  },
                  ttsSpeed: {
                    type: 'number',
                    description: '可选：IrodoriTTS 语速微调（常规 0.92~1.08，高潮 0.85~1.18）'
                  },
                  ttsSpecialScene: {
                    type: 'boolean',
                    description: '可选：极端哭喊/崩溃/耳语高潮句设为 true（整场 <= 15%）'
                  },
                  delay: { type: 'number' },
                  closeWindowOnFinish: { type: 'boolean' },
                  motion: { type: 'string' },
                  facial: { type: 'string' },
                  listenerAction: { type: 'object' },
                  actions: { type: 'array', items: { type: 'object' } }
                },
                required: ['op', 'index']
              }
            },
            finalizeIfReady: {
              type: 'boolean',
              description:
                '若修补后全部校验通过则直接定稿提交（推荐 true，省去额外一轮 finalize_story_draft）'
            }
          },
          required: [
            'dramaticArc',
            'emotionalContinuityAndVoice',
            'audioAndSeDesign',
            'stageRhythm',
            'actingNaturalness'
          ]
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'finalize_story_draft',
        description:
          '确认已保存并通过导演终审的草稿无误后直接定稿提交，无需再次输出长 JSON（长篇草稿 >=8 句须先经过 submit_director_review）。',
        parameters: {
          type: 'object',
          properties: {
            note: { type: 'string', description: '可选：定稿说明' }
          }
        }
      }
    }
  ]

  const resolveCandidateStory = (args: Record<string, unknown>): Record<string, unknown> | null => {
    if (isStoryObjectCandidate(args.story)) return args.story as Record<string, unknown>
    if (isStoryObjectCandidate(args)) return args
    if (args.useCurrentDraft !== false && savedDraft) return savedDraft
    return null
  }

  const buildRawAuditStory = (
    candidate: Record<string, unknown>,
    fallbackModels: StoryData['models'] = [],
    fallbackImages: StoryData['images'] = []
  ): StoryData => {
    const rawSnippets = Array.isArray(candidate.snippets) ? candidate.snippets : []
    const clonedSnippets = rawSnippets.map((s) =>
      s && typeof s === 'object' ? structuredClone(s) : { type: 'Unknown', data: {} }
    )
    const rawModels = Array.isArray(candidate.models)
      ? (structuredClone(candidate.models) as StoryData['models'])
      : fallbackModels
    const rawImages = Array.isArray(candidate.images)
      ? (structuredClone(candidate.images) as StoryData['images'])
      : fallbackImages
    return {
      models: rawModels,
      images: rawImages,
      snippets: clonedSnippets as unknown as StoryData['snippets']
    }
  }

  const auditDraftCandidate = (
    candidate: Record<string, unknown>
  ): {
    story: StoryData
    warnings: string[]
    actingReport: ActingFidelityReport
    postActingReport: ActingFidelityReport
    postOfficialReport: ReturnType<typeof officialLinterMod.lintOfficialStory>
    dialogueLint: ReturnType<typeof lintDialogueFidelity>
    bodyMotions: Record<string, number>
    stageLeaks: number[]
    officialPassed: boolean
    postActingPassed: boolean
    readyToFinalize: boolean
  } => {
    const { story, warnings } = validateAndFixStory(candidate, view, logger, {
      emotionLabels
    })
    // 审计 raw candidate.snippets，保留与 savedDraft 一致的 snippetIndex，避免 ensureOpeningAndEnding
    // 位移索引或 repairActingMismatches 掩盖尚未修复的表情/动作冲突。
    const rawAuditStory = buildRawAuditStory(candidate, story.models, story.images)
    const actingReport = runActingAndFidelityAudit(rawAuditStory, view)
    const postActingReport = runActingAndFidelityAudit(story, view)
    const postOfficialReport = officialLinterMod.lintOfficialStory(story, view)
    const dialogueLines = extractDialogueLinesFromStory(
      rawAuditStory as unknown as Record<string, unknown>
    )
    const dialogueLint = lintDialogueFidelity(
      {
        title: savedPlan?.title ?? '',
        lines: dialogueLines.map((l) => ({ id: l.id, speaker: l.speaker, content: l.content }))
      },
      {
        ...(savedPlan?.pairwiseAddress ? { pairwiseAddress: savedPlan.pairwiseAddress } : {}),
        cast: view.primaryModels().map((m) => ({
          modelId: m.id,
          name: view.shortName(m),
          fullName: m.name,
          path: m.path,
          role: ''
        }))
      }
    )
    const bodyMotions = countBodyMotionsByModel(rawAuditStory)
    const stageLeaks = rawAuditStory.snippets
      .map((s, idx) => ({ idx, s }))
      .filter(
        ({ s }) =>
          s.type === 'Talk' &&
          'data' in s &&
          hasSpokenStageDirectionLeak(String((s.data as Record<string, unknown>)?.content ?? ''))
      )
      .map(({ idx }) => idx)
    const officialPassed =
      postOfficialReport.passed &&
      (actingReport.talkCount < 6 || actingReport.zeroMotionModelIds.length === 0) &&
      stageLeaks.length === 0
    const postActingPassed =
      postActingReport.passed &&
      (postActingReport.talkCount < 6 || postActingReport.zeroMotionModelIds.length === 0) &&
      !dialogueLint.issues.some((i) => i.severity === 'high')
    return {
      story,
      warnings,
      actingReport,
      postActingReport,
      postOfficialReport,
      dialogueLint,
      bodyMotions,
      stageLeaks,
      officialPassed,
      postActingPassed,
      readyToFinalize:
        officialPassed &&
        actingReport.passed &&
        !dialogueLint.issues.some((i) => i.severity === 'high')
    }
  }

  const runCompactAudit = (candidate: Record<string, unknown>): Record<string, unknown> => {
    try {
      const audited = auditDraftCandidate(candidate)
      const directorTelemetry = buildDirectorStageTelemetry(candidate, targetMinutes)
      return {
        schemaValid: true,
        officialPassed: audited.officialPassed,
        actingPassed: audited.actingReport.passed,
        postActingPassed: audited.postActingPassed,
        actingScore: audited.actingReport.score,
        readyToFinalize: audited.readyToFinalize,
        directorReviewed: Boolean(directorReview),
        directorTelemetry,
        warnings: audited.warnings.slice(0, 12),
        officialIssues: audited.postOfficialReport.issues,
        zeroMotionModelIds: audited.actingReport.zeroMotionModelIds,
        stageDirectionLeakSnippetIndices: audited.stageLeaks,
        dialogueIssues: audited.dialogueLint.issues.slice(0, 10),
        actingDiagnostics: audited.actingReport.diagnostics.slice(0, 12),
        metrics: {
          talkCount: audited.postOfficialReport.metrics.talkCount,
          talkZeroDelayShare: audited.postOfficialReport.metrics.talkZeroDelayShare,
          appearMotionClashCount: audited.postOfficialReport.metrics.appearMotionClashCount,
          inPlaceAppearShare: audited.postOfficialReport.metrics.inPlaceAppearShare,
          bodyMotionsByModel: audited.bodyMotions,
          facialMismatchCount: audited.actingReport.facialMismatchCount,
          motionMismatchCount: audited.actingReport.motionMismatchCount,
          repeatedFacialRunCount: audited.actingReport.repeatedFacialRunCount,
          listenerFrozenCount: audited.actingReport.listenerFrozenCount ?? 0,
          duplicateBgmCount: audited.actingReport.duplicateBgmCount ?? 0,
          zeroWidthCharCount: audited.actingReport.zeroWidthCharCount ?? 0
        }
      }
    } catch (error) {
      return {
        schemaValid: false,
        officialPassed: false,
        actingPassed: false,
        readyToFinalize: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  const buildModelExpressionOverview = (
    model: CatalogModel,
    options: {
      mood?: string
      moods?: string[]
      dialogueLine?: string
      emotion?: string
      kind?: string
      compact?: boolean
    } = {}
  ): Record<string, unknown> => {
    const mood = (options.mood ?? '').trim()
    const moodsArg = (options.moods ?? []).map((m) => m.trim()).filter(Boolean)
    const dialogueLine = (options.dialogueLine ?? '').trim()
    const emotion = (options.emotion ?? '').trim()
    const kind = options.kind ?? 'all'
    const compact = Boolean(options.compact)
    const profile = getActingProfile(`${model.name} ${model.path}`)

    // 结合全量模型动作与表情库（不局限于 34/28 提示词截断集），让 Agent 能调用到 face_cry_*、face_sad_02+、跨风格动作变体
    const curatedMotions = view.promptMotions(model)
    const fullMotions =
      model.motions && model.motions.length > curatedMotions.length
        ? [
            ...curatedMotions,
            ...model.motions.filter(
              (m) => !curatedMotions.includes(m) && !facialSemanticsMod.isSpecialOrStandingMotion(m)
            )
          ]
        : curatedMotions
    const curatedFacials = view.promptFacials(model)
    const fullFacials =
      model.facials && model.facials.length > curatedFacials.length
        ? [...curatedFacials, ...model.facials.filter((f) => !curatedFacials.includes(f))]
        : curatedFacials

    const filterBySemanticsForTokens = (
      items: string[],
      tokens: string[],
      labelFn: (item: string) => string,
      maxPerStem = 2
    ): string[] => {
      const isSadMood = tokens.some((t) => /^(sad|cry|crying|trouble|worry|伤心|难过|哭|困扰|绝望)$/i.test(t))
      const scored =
        tokens.length === 0
          ? items
          : items
              .map((item, idx) => {
                const hay = `${item} ${labelFn(item)}`.toLowerCase()
                const hits = tokens.filter((tok) => hay.includes(tok)).length
                const normalBonus = /^w-normal/i.test(item) ? 0.25 : 0
                const wrySmilePenalty =
                  isSadMood && /\b(wry_smile|tearful_smile|genuine_smile|closed_smile|smile)\b/.test(hay)
                    ? -2
                    : 0
                const trueCryBonus =
                  isSadMood && wrySmilePenalty === 0 && /\b(cry|sad)\b/.test(hay) ? 0.5 : 0
                return { item, score: hits + normalBonus + trueCryBonus + wrySmilePenalty, hits, idx }
              })
              .filter((entry) => entry.hits > 0 && entry.score > 0)
              .sort((a, b) => b.score - a.score || a.idx - b.idx)
              .map((entry) => entry.item)
      const base = scored.length > 0 ? scored : items
      // 同一 stem 最多取 maxPerStem 个变体，避免某一个词根占满整组（如全是 nod01..06）
      const stemCounts = new Map<string, number>()
      const diverse: string[] = []
      for (const item of base) {
        const stem = item
          .toLowerCase()
          .replace(/^w-[a-z]+-/, '')
          .replace(/^face_/, '')
          .replace(/[_-]?\d+[a-z]?$/i, '')
        const cnt = stemCounts.get(stem) ?? 0
        if (cnt >= maxPerStem) continue
        stemCounts.set(stem, cnt + 1)
        diverse.push(item)
      }
      return diverse.length > 0 ? diverse : base
    }

    const facialLabelFn = (f: string): string =>
      `${facialSemanticsMod.inspectModelFacial(model.path, f).role} ${facialSemanticsMod.inspectModelFacial(model.path, f).label}`
    const motionLabelFn = (m: string): string => inspectMotion(model.path, m).label

    const targetMoods =
      moodsArg.length > 0
        ? moodsArg.slice(0, 8)
        : !mood && !dialogueLine && !emotion
          ? ['平静', '开心', '伤心', '困扰', '生气', '惊讶', '害羞']
          : []

    const perMoodFacialLimit = compact ? 4 : 5
    const perMoodMotionLimit = compact ? 4 : 6
    const nonStandingMotions = fullMotions.filter((m) => !isStandingMotion(m))
    const byMood: Record<string, { facials?: string[]; motions?: string[] }> = {}
    if (targetMoods.length > 0) {
      for (const mKey of targetMoods) {
        const mTokens = expandMoodTokens(mKey)
        const entry: { facials?: string[]; motions?: string[] } = {}
        if (kind !== 'motion') {
          entry.facials = filterBySemanticsForTokens(fullFacials, mTokens, facialLabelFn, 2)
            .slice(0, perMoodFacialLimit)
            .map((f) => facialSemanticsMod.annotateFacialName(model.path, f))
        }
        if (kind !== 'facial') {
          entry.motions = filterBySemanticsForTokens(nonStandingMotions, mTokens, motionLabelFn, 2)
            .slice(0, perMoodMotionLimit)
            .map((m) => annotateMotion(model.path, m))
        }
        byMood[mKey] = entry
      }
    }

    const tokens = mood ? expandMoodTokens(mood) : []
    const motions =
      kind === 'facial' || compact
        ? []
        : filterBySemanticsForTokens(fullMotions, tokens, motionLabelFn, 2)
            .slice(0, targetMoods.length > 0 ? 14 : 24)
            .map((m) => annotateMotion(model.path, m))

    const facials =
      kind === 'motion' || compact
        ? []
        : filterBySemanticsForTokens(fullFacials, tokens, facialLabelFn, 2)
            .slice(0, targetMoods.length > 0 ? 14 : 24)
            .map((f) => facialSemanticsMod.annotateFacialName(model.path, f))

    const recommended =
      dialogueLine || emotion || mood
        ? recommendForLine(view, model, {
            content: dialogueLine || mood,
            emotion,
            restrainedRole: profile.restrained,
            limit: 4
          })
        : null

    return {
      modelId: model.id,
      name: view.shortName(model),
      restrained: profile.restrained,
      actingNote: profile.actingNote,
      ...(Object.keys(byMood).length > 0 ? { byMood } : {}),
      ...(recommended
        ? {
            recommended: {
              mood: recommended.mood,
              facials: recommended.facials.map((f) =>
                facialSemanticsMod.annotateFacialName(model.path, f)
              ),
              motions: recommended.motions.map((m) => annotateMotion(model.path, m))
            }
          }
        : {}),
      ...(motions.length > 0 ? { motions } : {}),
      ...(facials.length > 0 ? { facials } : {})
    }
  }

  const resolveBatchModels = (args: Record<string, unknown>): CatalogModel[] => {
    const picked: CatalogModel[] = []
    const seen = new Set<number>()
    const addIfFound = (m: CatalogModel | null): void => {
      if (m && !seen.has(m.id)) {
        seen.add(m.id)
        picked.push(m)
      }
    }
    if (Array.isArray(args.modelIds)) {
      for (const id of args.modelIds) addIfFound(findModel(view, id, undefined))
    }
    if (Array.isArray(args.characters)) {
      for (const c of args.characters) addIfFound(findModel(view, undefined, c))
    }
    if (args.modelId !== undefined || args.character !== undefined) {
      addIfFound(findModel(view, args.modelId, args.character))
    }
    return picked
  }

  const execute = async (name: string, rawArgs: unknown, signal?: AbortSignal): Promise<string> => {
    const args = parseToolArgs(rawArgs)

    if (name === 'lookup_character') {
      const requestedBatch = resolveBatchModels(args)
      const hasExplicitFilter =
        Array.isArray(args.characters) ||
        Array.isArray(args.modelIds) ||
        args.character !== undefined ||
        args.modelId !== undefined
      const list = hasExplicitFilter ? requestedBatch : view.primaryModels()
      const includeExpressions = Boolean(args.includeExpressions)
      const moodsArg = Array.isArray(args.moods)
        ? args.moods.map((m) => String(m ?? '').trim()).filter(Boolean)
        : undefined
      return JSON.stringify({
        characters: list.map((m) => {
          const persona = personasMod.personaFor(personas, m)
          const profile = getActingProfile(`${m.name} ${m.path}`)
          const outfits = view
            .outfitsFor(m)
            .filter((o) => !isBackViewModel(o))
            .slice(0, 6)
            .map((o) => ({
              modelId: o.id,
              label: o.outfitLabel || o.outfitCategory || o.cloudId || '默认'
            }))
          const exprBlock = includeExpressions
            ? buildModelExpressionOverview(m, { moods: moodsArg, compact: true })
            : null
          return {
            modelId: m.id,
            name: m.name,
            shortName: view.shortName(m),
            path: m.path,
            ...(m.unit ? { unit: m.unit } : {}),
            ...(m.outfitLabel ? { outfitLabel: m.outfitLabel } : {}),
            ...(outfits.length > 1 ? { availableOutfits: outfits } : {}),
            actingProfile: profile,
            persona: persona
              ? personasMod.dialoguePersonaPrompt(persona)
              : '（按该角色官方设定演绎）',
            ...(exprBlock?.byMood ? { expressionsByMood: exprBlock.byMood } : {})
          }
        })
      })
    }

    if (name === 'inspect_character_expressions') {
      const mood = typeof args.mood === 'string' ? args.mood.trim() : ''
      const moodsArg = Array.isArray(args.moods)
        ? args.moods.map((m) => String(m ?? '').trim()).filter(Boolean)
        : []
      const dialogueLine = typeof args.dialogueLine === 'string' ? args.dialogueLine.trim() : ''
      const emotion = typeof args.emotion === 'string' ? args.emotion.trim() : ''
      const kind = typeof args.kind === 'string' ? args.kind : 'all'

      const isBatch = Array.isArray(args.modelIds) || Array.isArray(args.characters)
      if (isBatch) {
        const models = resolveBatchModels(args)
        if (models.length === 0) {
          return JSON.stringify({
            error: '未找到指定角色',
            available: view.models.map((m) => ({ modelId: m.id, name: view.shortName(m) }))
          })
        }
        return JSON.stringify({
          characters: models.map((m) =>
            buildModelExpressionOverview(m, {
              mood,
              moods: moodsArg,
              dialogueLine,
              emotion,
              kind,
              compact: models.length >= 2
            })
          )
        })
      }

      const model = findModel(view, args.modelId, args.character)
      if (!model) {
        return JSON.stringify({
          error: '未找到指定角色',
          available: view.models.map((m) => ({ modelId: m.id, name: view.shortName(m) }))
        })
      }
      return JSON.stringify(
        buildModelExpressionOverview(model, {
          mood,
          moods: moodsArg,
          dialogueLine,
          emotion,
          kind
        })
      )
    }

    if (name === 'recommend_acting_for_lines') {
      let rawLines: Array<Record<string, unknown>> = Array.isArray(args.lines)
        ? (args.lines as Array<Record<string, unknown>>)
        : []
      if ((rawLines.length === 0 || args.useCurrentDraft === true) && savedDraft) {
        const snippets = Array.isArray(savedDraft.snippets)
          ? (savedDraft.snippets as Array<Record<string, unknown>>)
          : []
        const filterIdxSet = Array.isArray(args.snippetIndices)
          ? new Set(
              args.snippetIndices
                .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
                .map((n) => Math.floor(n))
            )
          : null
        let issueIdxSet: Set<number> | null = null
        if (args.onlyIssues === true) {
          try {
            const report = auditDraftCandidate(savedDraft).actingReport
            issueIdxSet = new Set(report.diagnostics.map((d) => d.snippetIndex))
          } catch {
            issueIdxSet = null
          }
        }
        const onStage = new Set<number>()
        const extracted: Array<Record<string, unknown>> = []
        for (let idx = 0; idx < snippets.length; idx++) {
          const s = snippets[idx]
          if (!s || typeof s !== 'object') continue
          const d = (s.data && typeof s.data === 'object' ? s.data : {}) as Record<string, unknown>
          if (s.type === 'LayoutAppear' && typeof d.modelId === 'number') onStage.add(d.modelId)
          else if (s.type === 'LayoutClear' && typeof d.modelId === 'number')
            onStage.delete(d.modelId)
          if (s.type !== 'Talk') continue
          if (filterIdxSet && !filterIdxSet.has(idx)) continue
          if (issueIdxSet && !issueIdxSet.has(idx)) continue
          const speakerId = typeof d.modelId === 'number' ? d.modelId : -1
          const listenerId = [...onStage].find((id) => id !== speakerId)
          extracted.push({
            id: `snippets[${idx}]`,
            snippetIndex: idx,
            modelId: speakerId,
            speaker: typeof d.speaker === 'string' ? d.speaker : '',
            content: typeof d.content === 'string' ? d.content : '',
            emotion: typeof d.emotion === 'string' ? d.emotion : '',
            ...(listenerId !== undefined ? { listenerModelId: listenerId } : {})
          })
        }
        rawLines = extracted
      }

      const defaultPerLineLimit = rawLines.length > 8 ? 2 : 4
      const perLineLimit =
        typeof args.limit === 'number' && Number.isFinite(args.limit)
          ? Math.max(1, Math.min(4, Math.round(args.limit)))
          : defaultPerLineLimit
      const recommendations: Array<Record<string, unknown>> = []
      const lastFacial = new Map<number, string>()
      const lastMotion = new Map<number, string>()
      let prevContent = ''
      let prevEmotion = ''
      let prevTense = false
      let hasAnyListener = false

      for (let i = 0; i < rawLines.length; i++) {
        const raw = rawLines[i]
        if (!raw || typeof raw !== 'object') continue
        const rec = raw
        const content = typeof rec.content === 'string' ? rec.content : ''
        const emotion = typeof rec.emotion === 'string' ? rec.emotion : ''
        const isListener = Boolean(rec.isListener)
        const isMonologue = Boolean(rec.isMonologue)
        const model = findModel(view, rec.modelId, rec.speaker)
        if (!model) {
          recommendations.push({
            id: typeof rec.id === 'string' ? rec.id : `l${i + 1}`,
            error: '未找到对应角色模型'
          })
          continue
        }
        const profile = getActingProfile(`${model.name} ${model.path}`)
        const advised = recommendForLine(view, model, {
          content,
          emotion,
          prevContent,
          prevEmotion,
          prevTense,
          isListener,
          isMonologue,
          restrainedRole: profile.restrained,
          prevFacial: lastFacial.get(model.id),
          prevMotion: lastMotion.get(model.id),
          limit: perLineLimit
        })
        if (advised.facials[0]) lastFacial.set(model.id, advised.facials[0])
        if (advised.motions[0]) lastMotion.set(model.id, advised.motions[0])

        let listenerReaction: Record<string, unknown> | undefined
        const listenerModel =
          rec.listenerModelId !== undefined || rec.listenerSpeaker !== undefined
            ? findModel(view, rec.listenerModelId, rec.listenerSpeaker)
            : null
        if (listenerModel && listenerModel.id !== model.id) {
          hasAnyListener = true
          const lProfile = getActingProfile(`${listenerModel.name} ${listenerModel.path}`)
          const lAdvised = recommendForLine(view, listenerModel, {
            content,
            emotion,
            prevContent,
            prevEmotion,
            prevTense,
            isListener: true,
            restrainedRole: lProfile.restrained,
            prevFacial: lastFacial.get(listenerModel.id),
            prevMotion: lastMotion.get(listenerModel.id),
            limit: Math.min(2, perLineLimit)
          })
          if (lAdvised.facials[0]) lastFacial.set(listenerModel.id, lAdvised.facials[0])
          if (lAdvised.motions[0]) lastMotion.set(listenerModel.id, lAdvised.motions[0])
          listenerReaction = {
            modelId: listenerModel.id,
            speaker: view.shortName(listenerModel),
            suggestedAt: 0,
            preferFacialOnly: true,
            inferredMood: lAdvised.mood,
            recommendedFacials: lAdvised.facials.map((f) => ({
              name: f,
              label: facialSemanticsMod.inspectModelFacial(listenerModel.path, f).label
            })),
            recommendedMotions: lAdvised.motions.map((m) => ({
              name: m,
              label: inspectMotion(listenerModel.path, m).label
            }))
          }
        }

        const ctx = inferDramaticMoodFallback({
          content,
          emotion,
          prevContent,
          prevEmotion,
          isMonologue,
          isListener
        })
        prevTense = ctx.tense
        prevContent = content
        prevEmotion = emotion

        recommendations.push({
          id: typeof rec.id === 'string' ? rec.id : `l${i + 1}`,
          ...(typeof rec.snippetIndex === 'number' ? { snippetIndex: rec.snippetIndex } : {}),
          modelId: model.id,
          speaker: view.shortName(model),
          restrained: profile.restrained,
          inferredMood: advised.mood,
          recommendedFacials: advised.facials.map((f) => ({
            name: f,
            label: facialSemanticsMod.inspectModelFacial(model.path, f).label
          })),
          recommendedMotions: advised.motions.map((m) => ({
            name: m,
            label: inspectMotion(model.path, m).label
          })),
          ...(listenerReaction ? { listenerReaction } : {})
        })
      }
      return JSON.stringify({
        ...(hasAnyListener
          ? {
              listenerNote:
                '官方 PJSK 节奏：听者反应优先通过切镜/原地 Move/短停顿，或句首 at: 0 纯切 facial 表达，避免在句中 at: 0.5..0.85 塞入听者身体动作'
            }
          : {}),
        recommendations
      })
    }

    if (name === 'search_assets') {
      const rawKinds = Array.isArray(args.kinds)
        ? args.kinds.map((k) => String(k ?? '').trim()).filter(Boolean)
        : []
      const kindSet = new Set<string>(
        rawKinds.length > 0 ? rawKinds : [typeof args.kind === 'string' ? args.kind : 'all']
      )
      const wantsAll = kindSet.has('all')
      const rawQueries = Array.isArray(args.queries)
        ? args.queries.map((q) => String(q ?? '').trim()).filter(Boolean)
        : []
      const singleQuery = typeof args.query === 'string' ? args.query.trim() : ''
      const queryList =
        rawQueries.length > 0 ? rawQueries.slice(0, 6) : singleQuery ? [singleQuery] : ['']
      const limit =
        typeof args.limit === 'number' && Number.isFinite(args.limit)
          ? Math.max(1, Math.min(25, Math.round(args.limit)))
          : 12
      const result: Record<string, unknown> = {}

      if (wantsAll || kindSet.has('background')) {
        const bgMap = new Map<string, Record<string, unknown>>()
        for (const q of queryList) {
          for (const b of view.imagePromptChoices(limit, q)) {
            if (!bgMap.has(b.file)) {
              bgMap.set(b.file, {
                file: b.file,
                name: b.name,
                timeOfDay: b.timeOfDay,
                indoor: b.indoor,
                description: b.description
              })
            }
          }
        }
        result.backgrounds = [...bgMap.values()].slice(0, limit)
      }
      if (wantsAll || kindSet.has('bgm')) {
        const bgmMap = new Map<string, Record<string, unknown>>()
        for (const q of queryList) {
          for (const b of view.bgmPromptChoices(limit, q)) {
            if (!bgmMap.has(b.file)) {
              bgmMap.set(b.file, {
                file: b.file,
                name: b.name,
                mood: b.mood,
                tempo: b.tempo,
                description: b.description
              })
            }
          }
        }
        result.bgm = [...bgmMap.values()].slice(0, limit)
      }
      if (wantsAll || kindSet.has('se')) {
        const seItems =
          view.seDetailsList().length > 0
            ? view.seDetailsList().map((s) => ({
                file: s.file,
                name: s.name,
                category: s.category,
                description: s.description
              }))
            : scenarioCuesMod.CURATED_SCENARIO_SES.map((s) => ({
                file: s.file,
                name: s.id,
                category: s.category,
                description: s.description
              }))
        const seMap = new Map<string, (typeof seItems)[number]>()
        for (const qRaw of queryList) {
          const q = qRaw.toLowerCase()
          const matched = q
            ? seItems.filter((s) =>
                `${s.file} ${s.name} ${s.category ?? ''} ${s.description}`.toLowerCase().includes(q)
              )
            : seItems
          for (const item of matched) {
            if (!seMap.has(item.file)) seMap.set(item.file, item)
          }
        }
        result.se = (seMap.size > 0 ? [...seMap.values()] : seItems).slice(0, limit)
      }
      if (wantsAll || kindSet.has('effect')) {
        result.effects = [...scenarioCuesMod.CURATED_SCENARIO_EFFECTS]
      }
      if (kindSet.has('outfit')) {
        const model = findModel(view, args.modelId, args.character)
        if (model) {
          const combinedQuery = queryList.filter(Boolean).join(' ')
          const matched = combinedQuery ? view.resolveOutfitVariant(model, combinedQuery) : null
          result.outfits = view
            .outfitsFor(model)
            .slice(0, limit)
            .map((o) => ({
              modelId: o.id,
              path: o.path,
              outfitCategory: o.outfitCategory,
              outfitLabel: o.outfitLabel,
              isBackView: isBackViewModel(o),
              recommended: matched?.id === o.id
            }))
        } else {
          result.outfits = []
          result.note = '查询服装请传入 character 或 modelId'
        }
      }
      const combinedCueQuery = queryList.filter(Boolean).join(' ')
      if (combinedCueQuery && typeof scenarioCuesApi.recommendScenarioCues === 'function') {
        result.cueRecommendations = scenarioCuesApi.recommendScenarioCues(combinedCueQuery)
      }
      return JSON.stringify(result)
    }

    if (name === 'search_official_corpus') {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      const stage: 'cast' | 'dialogue' = args.stage === 'cast' ? 'cast' : 'dialogue'
      const excerpts = corpusExamplesMod.selectUnitFewShotExcerpts(
        view
          .primaryModels()
          .slice(0, 3)
          .map((m) => ({ name: view.shortName(m), path: m.path })),
        query
      )
      let ragText = ''
      if (ragRetriever && query) {
        try {
          const retrieved = await ragRetriever.retrieve({
            prompt: query,
            stage,
            cast: view
              .primaryModels()
              .slice(0, 4)
              .map((m) => ({
                name: view.shortName(m),
                fullName: m.name
              })),
            signal
          })
          ragText = retrieved?.promptBlock ?? ''
        } catch (error) {
          logger.debug(`[AgentTool] RAG query failed: ${String(error)}`)
        }
      }
      const actingGuidelines =
        typeof corpusExamplesApi.getOfficialActingGuidelines === 'function'
          ? corpusExamplesApi.getOfficialActingGuidelines({
              castCount: savedPlan?.cast.length ?? view.primaryModels().length,
              isFlashback: /回忆|过去|以前/.test(query),
              isSekai: /sekai|世界/i.test(query)
            })
          : '官方PJSK规范：同场景连续对话保持1幕；允许短时单人Center内省留白再切回Left/Right；口语台词禁用括号动作提示；约75%~80%台词句首单拍动作，90%+ delay=0，双人各有动作切换且不同瞬碰撞。'
      return JSON.stringify({
        note: '仅学习称呼、断句、潜台词与留白节奏，严禁照抄原句',
        actingGuidelines,
        excerpts: ragText || excerpts || '（当前查询暂无额外语料，请严格遵循角色口吻）'
      })
    }

    if (name === 'plan_story_outline') {
      const warnings: string[] = []
      const rawCast = Array.isArray(args.cast) ? args.cast : []
      const resolvedCast: SavedStoryPlan['cast'] = []
      for (const item of rawCast) {
        if (!item || typeof item !== 'object') continue
        const rec = item as Record<string, unknown>
        const m = findModel(view, rec.modelId, rec.name)
        if (!m) {
          warnings.push(`未找到角色：${String(rec.name ?? rec.modelId ?? '')}`)
          continue
        }
        resolvedCast.push({
          modelId: m.id,
          name: view.shortName(m),
          role: typeof rec.role === 'string' ? rec.role.trim() : ''
        })
      }
      if (resolvedCast.length === 0) {
        for (const m of view.primaryModels().slice(0, 2)) {
          resolvedCast.push({ modelId: m.id, name: view.shortName(m), role: '' })
        }
      }

      const rawScenes = Array.isArray(args.scenes) ? args.scenes : []
      const resolvedScenes: SavedStoryPlan['scenes'] = rawScenes
        .filter((s): s is Record<string, unknown> => Boolean(s && typeof s === 'object'))
        .slice(0, 4)
        .map((s, idx) => {
          const bgRaw = typeof s.background === 'string' ? s.background : ''
          const bg = view.canonicalImage(bgRaw) ?? view.defaultImage()
          if (bgRaw && !view.canonicalImage(bgRaw)) {
            warnings.push(`幕次 s${idx + 1} 背景「${bgRaw}」未精确匹配，已映射为「${bg}」`)
          }
          const bgmRaw = typeof s.bgm === 'string' ? s.bgm.trim() : ''
          const bgm =
            bgmRaw === 'silence' || bgmRaw === 'keep'
              ? bgmRaw
              : bgmRaw
                ? (view.canonicalBgm(bgmRaw) ?? '')
                : undefined
          if (bgmRaw && bgmRaw !== 'silence' && bgmRaw !== 'keep' && !bgm) {
            warnings.push(
              `幕次 s${idx + 1} BGM「${bgmRaw}」未在目录中找到，请调用 search_assets 核实`
            )
          }
          const ambientRaw = typeof s.ambient === 'string' ? s.ambient : 'normal'
          const ambient = ambientRaw === 'evening' || ambientRaw === 'night' ? ambientRaw : 'normal'
          return {
            id: typeof s.id === 'string' && s.id.trim() ? s.id.trim() : `s${idx + 1}`,
            summary: typeof s.summary === 'string' ? s.summary.trim() : '',
            background: bg,
            ambient,
            transitionIn: typeof s.transitionIn === 'string' ? s.transitionIn : 'black',
            activeCast: Array.isArray(s.activeCast)
              ? s.activeCast.map((x) => String(x)).slice(0, 2)
              : resolvedCast.slice(0, 2).map((c) => c.name),
            ...(bgm ? { bgm } : {}),
            ...(s.isFlashback ? { isFlashback: true } : {}),
            ...(s.isSekai ? { isSekai: true } : {})
          }
        })

      if (
        resolvedScenes.length >= 2 &&
        resolvedScenes.every(
          (s) =>
            s.background === resolvedScenes[0].background &&
            s.ambient === resolvedScenes[0].ambient &&
            !s.isFlashback &&
            !s.isSekai
        )
      ) {
        warnings.push(
          '提示：多幕背景与时段完全相同且非回忆/SEKAI，建议合并为 1 幕（不强制分幕，保持自然连续）'
        )
      }

      const rawPairs = Array.isArray(args.pairwiseAddress) ? args.pairwiseAddress : []
      const pairwiseAddress = rawPairs
        .filter((p): p is Record<string, unknown> => Boolean(p && typeof p === 'object'))
        .map((p) => ({
          from: String(p.from ?? '').trim(),
          to: String(p.to ?? '').trim(),
          zh: String(p.zh ?? '').trim(),
          ...(typeof p.ja === 'string' && p.ja.trim() ? { ja: p.ja.trim() } : {})
        }))
        .filter((p) => p.from && p.to && p.zh)

      savedPlan = {
        title: typeof args.title === 'string' ? args.title.trim() : '',
        logline: typeof args.logline === 'string' ? args.logline.trim() : '',
        event: typeof args.event === 'string' ? args.event.trim() : '',
        cast: resolvedCast,
        scenes: resolvedScenes,
        beats: Array.isArray(args.beats) ? args.beats.map((b) => String(b)) : [],
        ...(pairwiseAddress.length > 0 ? { pairwiseAddress } : {}),
        ...(args.turningPoint || args.openingMotif || args.closingCallback
          ? {
              understanding: {
                explicitRequests: [],
                ...(typeof args.turningPoint === 'string'
                  ? { turningPoint: args.turningPoint }
                  : {}),
                ...(typeof args.openingMotif === 'string'
                  ? { openingMotif: args.openingMotif }
                  : {}),
                ...(typeof args.closingCallback === 'string'
                  ? { closingCallback: args.closingCallback }
                  : {}),
                canonHooks: []
              }
            }
          : {})
      }

      return JSON.stringify({
        ok: true,
        plan: savedPlan,
        warnings
      })
    }

    if (name === 'validate_dialogue_draft') {
      const rawLines = Array.isArray(args.lines) ? args.lines : []
      const lines = rawLines
        .filter((l): l is Record<string, unknown> => Boolean(l && typeof l === 'object'))
        .map((l, idx) => ({
          id: typeof l.id === 'string' && l.id.trim() ? l.id.trim() : `l${idx + 1}`,
          speaker: typeof l.speaker === 'string' ? l.speaker.trim() : '',
          content: typeof l.content === 'string' ? l.content : ''
        }))
        .filter((l) => l.content.trim().length > 0)
      const lint = lintDialogueFidelity(
        { title: typeof args.title === 'string' ? args.title : (savedPlan?.title ?? ''), lines },
        {
          ...(savedPlan?.pairwiseAddress ? { pairwiseAddress: savedPlan.pairwiseAddress } : {}),
          cast: view.primaryModels().map((m) => ({
            modelId: m.id,
            name: view.shortName(m),
            fullName: m.name,
            path: m.path,
            role: ''
          }))
        }
      )
      const stageDirectionFixes = lines
        .filter((l) => hasSpokenStageDirectionLeak(l.content))
        .map((l) => ({
          id: l.id,
          before: l.content,
          repaired: repairSpokenStageDirections(l.content)
        }))
      return JSON.stringify({
        ok: !lint.shouldPolish && lint.issues.length === 0 && stageDirectionFixes.length === 0,
        lineCount: lines.length,
        issues: lint.issues,
        stageDirectionFixes
      })
    }

    if (name === 'save_story_draft') {
      const candidate = resolveCandidateStory(args)
      if (!candidate) {
        return JSON.stringify({
          draftSaved: false,
          error: '缺少有效的 StoryData 对象（需包含 snippets 数组）'
        })
      }
      savedDraft = structuredClone(candidate)
      directorReview = null
      finalized = false
      const audit = runCompactAudit(savedDraft)
      return JSON.stringify({
        draftSaved: true,
        snippetCount: Array.isArray(savedDraft.snippets) ? savedDraft.snippets.length : 0,
        nextStepHint:
          '已返回完整规则体检与 directorTelemetry，无需再重复调用 validate_story_draft / critique_story_draft；请直接调用 submit_director_review 完成 5 维导演终审并同步附带 operations 修补、设 finalizeIfReady: true 一步定稿。',
        ...audit
      })
    }

    if (name === 'inspect_story_draft') {
      if (!savedDraft || !Array.isArray(savedDraft.snippets)) {
        return JSON.stringify({
          error: '当前工作区尚无已保存草稿，请先调用 save_story_draft'
        })
      }
      const snippets = savedDraft.snippets as Array<Record<string, unknown>>
      const filterType = typeof args.type === 'string' ? args.type : 'all'
      const onlyIssues = Boolean(args.onlyIssues)
      let issueByIdx = new Map<number, string[]>()
      if (onlyIssues) {
        try {
          let report: ActingFidelityReport
          try {
            report = auditDraftCandidate(savedDraft).actingReport
          } catch {
            report = runActingAndFidelityAudit(buildRawAuditStory(savedDraft), view)
          }
          issueByIdx = new Map<number, string[]>()
          for (const d of report.diagnostics) {
            const arr = issueByIdx.get(d.snippetIndex) ?? []
            arr.push(`${d.code}: ${d.message}`)
            issueByIdx.set(d.snippetIndex, arr)
          }
        } catch {
          // Schema failed; show raw snippets
        }
      }

      const transitionTypes = new Set([
        'BlackOut',
        'BlackIn',
        'SideFade',
        'FlashbackIn',
        'FlashbackOut',
        'SekaiIn',
        'SekaiOut',
        'ChangeBackgroundImage',
        'ChangeBgm',
        'Telop',
        'PlaceInfo'
      ])

      const rows: Array<Record<string, unknown>> = []
      for (let idx = 0; idx < snippets.length; idx++) {
        const s = snippets[idx]
        if (!s || typeof s !== 'object') continue
        const sType = String(s.type ?? '')
        if (filterType === 'transitions' && !transitionTypes.has(sType)) continue
        if (filterType !== 'all' && filterType !== 'transitions' && sType !== filterType) continue
        if (onlyIssues && !issueByIdx.has(idx)) continue
        const d = (s.data && typeof s.data === 'object' ? s.data : {}) as Record<string, unknown>
        rows.push({
          idx,
          type: sType,
          ...(typeof s.delay === 'number' && s.delay !== 0 ? { delay: s.delay } : {}),
          ...(typeof d.modelId === 'number' ? { modelId: d.modelId } : {}),
          ...(typeof d.speaker === 'string' ? { speaker: d.speaker } : {}),
          ...(typeof d.content === 'string' ? { content: d.content } : {}),
          ...(typeof d.emotion === 'string' && d.emotion ? { emotion: d.emotion } : {}),
          ...(typeof d.motion === 'string' && d.motion ? { motion: d.motion } : {}),
          ...(typeof d.facial === 'string' && d.facial ? { facial: d.facial } : {}),
          ...(Array.isArray(d.actions) && d.actions.length > 0 ? { actions: d.actions } : {}),
          ...(d.closeWindowOnFinish ? { closeWindowOnFinish: true } : {}),
          ...(issueByIdx.has(idx) ? { issues: issueByIdx.get(idx) } : {})
        })
      }

      const start =
        typeof args.startIndex === 'number' && Number.isFinite(args.startIndex)
          ? Math.max(0, Math.floor(args.startIndex))
          : 0
      const end =
        typeof args.endIndex === 'number' && Number.isFinite(args.endIndex)
          ? Math.max(start, Math.floor(args.endIndex))
          : start + 25

      return JSON.stringify({
        totalSnippets: snippets.length,
        matchedCount: rows.length,
        slice: rows.slice(start, end)
      })
    }

    const applyDraftPatchOperations = (
      patchArgs: Record<string, unknown>
    ): { applied: string[]; snippetCount: number } | { error: string } => {
      if (!savedDraft || !Array.isArray(savedDraft.snippets)) {
        return { error: '当前工作区尚无已保存草稿，请先调用 save_story_draft' }
      }
      const draft = structuredClone(savedDraft)
      if (Array.isArray(patchArgs.models)) draft.models = patchArgs.models
      if (Array.isArray(patchArgs.images)) draft.images = patchArgs.images
      const snippets = [...(draft.snippets as Array<Record<string, unknown>>)]
      const originalLength = snippets.length
      const ops = Array.isArray(patchArgs.operations) ? patchArgs.operations : []
      const appliedNotes: string[] = []
      const deletedOriginalIndices = new Set<number>()

      // 按原始 index 降序执行（同 index 先 insert_after -> 原位改写 -> delete -> insert_before），
      // 确保同一批次中多个 delete/insert/update_acting 共用原始索引时不发生漂移。
      const opPhase = (op: string): number => {
        if (op === 'insert_after') return 0
        if (
          op === 'update_talk' ||
          op === 'update_acting' ||
          op === 'upsert_listener_action' ||
          op === 'replace'
        )
          return 1
        if (op === 'delete') return 2
        if (op === 'insert_before') return 3
        return 4
      }
      const sortedOps = ops
        .map((rawOp, order) => ({ rawOp, order }))
        .filter((entry): entry is { rawOp: Record<string, unknown>; order: number } =>
          Boolean(entry.rawOp && typeof entry.rawOp === 'object')
        )
        .sort((a, b) => {
          const idxA = typeof a.rawOp.index === 'number' ? Math.floor(a.rawOp.index) : -1
          const idxB = typeof b.rawOp.index === 'number' ? Math.floor(b.rawOp.index) : -1
          if (idxA !== idxB) return idxB - idxA
          const phaseA = opPhase(String(a.rawOp.op ?? ''))
          const phaseB = opPhase(String(b.rawOp.op ?? ''))
          if (phaseA !== phaseB) return phaseA - phaseB
          return phaseA === 0 || phaseA === 3 ? b.order - a.order : a.order - b.order
        })

      for (const { rawOp: opObj } of sortedOps) {
        const op = String(opObj.op ?? '')
        const idx = typeof opObj.index === 'number' ? Math.floor(opObj.index) : -1
        if (idx < 0 || idx >= originalLength || deletedOriginalIndices.has(idx)) {
          appliedNotes.push(`跳过越界操作 ${op}(index=${idx})`)
          continue
        }
        const target = snippets[idx]
        if (op === 'delete') {
          snippets.splice(idx, 1)
          deletedOriginalIndices.add(idx)
          appliedNotes.push(`delete@${idx}`)
          continue
        }
        if (op === 'replace' && opObj.snippet && typeof opObj.snippet === 'object') {
          snippets[idx] = opObj.snippet as Record<string, unknown>
          appliedNotes.push(`replace@${idx}`)
          continue
        }
        if (op === 'insert_before' || op === 'insert_after') {
          const toInsert = Array.isArray(opObj.snippets)
            ? opObj.snippets.filter((x): x is Record<string, unknown> =>
                Boolean(x && typeof x === 'object')
              )
            : opObj.snippet && typeof opObj.snippet === 'object'
              ? [opObj.snippet as Record<string, unknown>]
              : []
          if (toInsert.length > 0) {
            const insertAt = op === 'insert_before' ? idx : idx + 1
            snippets.splice(insertAt, 0, ...toInsert)
            appliedNotes.push(`${op}@${idx}(+${toInsert.length})`)
          }
          continue
        }
        if (op === 'update_talk' || op === 'update_acting' || op === 'upsert_listener_action') {
          const d = (target.data && typeof target.data === 'object' ? target.data : {}) as Record<
            string,
            unknown
          >
          if (typeof opObj.delay === 'number' && Number.isFinite(opObj.delay)) {
            target.delay = opObj.delay
          }
          if (op === 'update_talk') {
            if (typeof opObj.content === 'string') d.content = opObj.content
            if (typeof opObj.emotion === 'string') d.emotion = opObj.emotion
            if (typeof opObj.ttsCaption === 'string') d.ttsCaption = opObj.ttsCaption
            if (typeof opObj.ttsSpeed === 'number' && Number.isFinite(opObj.ttsSpeed)) {
              d.ttsSpeed = opObj.ttsSpeed
            }
            if (typeof opObj.ttsSpecialScene === 'boolean') {
              if (opObj.ttsSpecialScene) d.ttsSpecialScene = true
              else delete d.ttsSpecialScene
            }
            if (typeof opObj.closeWindowOnFinish === 'boolean') {
              if (opObj.closeWindowOnFinish) d.closeWindowOnFinish = true
              else delete d.closeWindowOnFinish
            }
          }
          if (Array.isArray(opObj.actions)) {
            d.actions = opObj.actions
          } else {
            const hasMotionArg = typeof opObj.motion === 'string'
            const hasFacialArg = typeof opObj.facial === 'string'
            if (target.type === 'Talk') {
              const speakerId = typeof d.modelId === 'number' ? d.modelId : -1
              if (op !== 'upsert_listener_action' && (hasMotionArg || hasFacialArg)) {
                const acts = Array.isArray(d.actions)
                  ? [...(d.actions as Array<Record<string, unknown>>)]
                  : []
                const primaryIdx = acts.findIndex((a) => a && a.modelId === speakerId)
                const baseAct: Record<string, unknown> =
                  primaryIdx >= 0 ? { ...acts[primaryIdx] } : { at: 0, modelId: speakerId }
                const resolveAnim = (
                  mid: number,
                  kind: 'motion' | 'facial',
                  rawVal: string
                ): string | null => {
                  const trimmed = rawVal.trim()
                  if (!trimmed) return ''
                  if (mid < 0) return trimmed
                  return view.canonicalAnimation(mid, kind, trimmed)
                }
                if (hasMotionArg) {
                  const canonical = resolveAnim(speakerId, 'motion', opObj.motion as string)
                  if (canonical === '') delete baseAct.motion
                  else if (canonical) baseAct.motion = canonical
                  else appliedNotes.push(`ignored_invalid_motion@${idx}:${String(opObj.motion)}`)
                }
                if (hasFacialArg) {
                  const canonical = resolveAnim(speakerId, 'facial', opObj.facial as string)
                  if (canonical === '') delete baseAct.facial
                  else if (canonical) baseAct.facial = canonical
                  else appliedNotes.push(`ignored_invalid_facial@${idx}:${String(opObj.facial)}`)
                }
                if (baseAct.motion || baseAct.facial) {
                  if (primaryIdx >= 0) acts[primaryIdx] = baseAct
                  else acts.unshift(baseAct)
                } else if (primaryIdx >= 0) {
                  acts.splice(primaryIdx, 1)
                }
                d.actions = acts
                if (hasMotionArg) delete d.motion
                if (hasFacialArg) delete d.facial
              }

              const rawListener =
                opObj.listenerAction && typeof opObj.listenerAction === 'object'
                  ? (opObj.listenerAction as Record<string, unknown>)
                  : op === 'upsert_listener_action' && typeof opObj.modelId === 'number'
                    ? opObj
                    : null
              if (rawListener && typeof rawListener.modelId === 'number') {
                const lModelId = rawListener.modelId
                const acts = Array.isArray(d.actions)
                  ? [...(d.actions as Array<Record<string, unknown>>)]
                  : []
                const existingIdx = acts.findIndex((a) => a && a.modelId === lModelId)
                const removeListener = Boolean(rawListener.remove)
                let lMotion =
                  typeof rawListener.motion === 'string' ? rawListener.motion.trim() : undefined
                const lFacial =
                  typeof rawListener.facial === 'string' ? rawListener.facial.trim() : undefined
                if (removeListener || (lMotion === '' && lFacial === '')) {
                  if (existingIdx >= 0) acts.splice(existingIdx, 1)
                } else {
                  const desiredAt =
                    typeof rawListener.at === 'number' &&
                    Number.isFinite(rawListener.at) &&
                    rawListener.at >= 0 &&
                    rawListener.at <= 1
                      ? rawListener.at
                      : 0
                  const speakerBodyAts = acts
                    .filter(
                      (a) =>
                        a &&
                        a.modelId !== lModelId &&
                        typeof a.motion === 'string' &&
                        a.motion.trim().length > 0
                    )
                    .map((a) => (typeof a.at === 'number' && Number.isFinite(a.at) ? a.at : 0))
                  if (
                    lMotion &&
                    speakerBodyAts.some((sat) => Math.abs(sat - desiredAt) < 0.25 - 1e-6)
                  ) {
                    lMotion = ''
                    appliedNotes.push(
                      `listener@${idx}:保留at:${desiredAt}纯表情(如需听者身体动作请插独立Motion片段)`
                    )
                  }
                  const nextAct: Record<string, unknown> =
                    existingIdx >= 0
                      ? { ...acts[existingIdx], at: desiredAt, modelId: lModelId }
                      : { at: desiredAt, modelId: lModelId }
                  if (lMotion !== undefined) {
                    if (lMotion === '') delete nextAct.motion
                    else {
                      const canonM = view.canonicalAnimation(lModelId, 'motion', lMotion)
                      if (canonM) nextAct.motion = canonM
                    }
                  }
                  if (lFacial !== undefined) {
                    if (lFacial === '') delete nextAct.facial
                    else {
                      const canonF = view.canonicalAnimation(lModelId, 'facial', lFacial)
                      if (canonF) nextAct.facial = canonF
                    }
                  }
                  if (nextAct.motion || nextAct.facial) {
                    if (existingIdx >= 0) acts[existingIdx] = nextAct
                    else acts.push(nextAct)
                  }
                }
                acts.sort(
                  (a, b) =>
                    (typeof a.at === 'number' ? a.at : 0) - (typeof b.at === 'number' ? b.at : 0)
                )
                d.actions = acts
              }
            } else {
              const targetModelId = typeof d.modelId === 'number' ? d.modelId : -1
              if (hasMotionArg) {
                const rawM = String(opObj.motion ?? '').trim()
                if (!rawM) d.motion = ''
                else {
                  const canonM =
                    targetModelId >= 0 ? view.canonicalAnimation(targetModelId, 'motion', rawM) : rawM
                  if (canonM) d.motion = canonM
                }
              }
              if (hasFacialArg) {
                const rawF = String(opObj.facial ?? '').trim()
                if (!rawF) d.facial = ''
                else {
                  const canonF =
                    targetModelId >= 0 ? view.canonicalAnimation(targetModelId, 'facial', rawF) : rawF
                  if (canonF) d.facial = canonF
                }
              }
            }
          }
          target.data = d
          appliedNotes.push(`${op}@${idx}`)
        }
      }

      draft.snippets = snippets
      savedDraft = draft
      finalized = false
      return { applied: appliedNotes, snippetCount: snippets.length }
    }

    if (name === 'patch_story_draft') {
      const res = applyDraftPatchOperations(args)
      if ('error' in res) {
        return JSON.stringify({ patched: false, error: res.error })
      }
      const audit = runCompactAudit(savedDraft!)
      return JSON.stringify({
        patched: true,
        applied: res.applied,
        snippetCount: res.snippetCount,
        ...audit
      })
    }

    if (name === 'submit_director_review') {
      if (!savedDraft || !Array.isArray(savedDraft.snippets)) {
        return JSON.stringify({
          reviewed: false,
          error: '当前工作区尚无已保存草稿，请先调用 save_story_draft'
        })
      }
      const dramaticArc = typeof args.dramaticArc === 'string' ? args.dramaticArc.trim() : ''
      const emotionalContinuityAndVoice =
        typeof args.emotionalContinuityAndVoice === 'string'
          ? args.emotionalContinuityAndVoice.trim()
          : ''
      const audioAndSeDesign =
        typeof args.audioAndSeDesign === 'string' ? args.audioAndSeDesign.trim() : ''
      const stageRhythm = typeof args.stageRhythm === 'string' ? args.stageRhythm.trim() : ''
      const actingNaturalness =
        typeof args.actingNaturalness === 'string' ? args.actingNaturalness.trim() : ''
      const concreteFixes = Array.isArray(args.concreteFixes)
        ? args.concreteFixes.map((x) => String(x ?? '').trim()).filter(Boolean)
        : []

      let applied: string[] = []
      let snippetCount = (savedDraft.snippets as unknown[]).length
      if (
        (Array.isArray(args.operations) && args.operations.length > 0) ||
        Array.isArray(args.models) ||
        Array.isArray(args.images)
      ) {
        const patchRes = applyDraftPatchOperations(args)
        if ('error' in patchRes) {
          return JSON.stringify({ reviewed: false, error: patchRes.error })
        }
        applied = patchRes.applied
        snippetCount = patchRes.snippetCount
      }

      directorReview = {
        dramaticArc,
        emotionalContinuityAndVoice,
        audioAndSeDesign,
        stageRhythm,
        actingNaturalness,
        concreteFixes,
        appliedOperationsCount: applied.length
      }

      const audit = runCompactAudit(savedDraft)
      const wantsFinalize = args.finalizeIfReady === true
      if (
        wantsFinalize &&
        audit.schemaValid &&
        audit.officialPassed &&
        (audit.readyToFinalize || audit.postActingPassed)
      ) {
        finalized = true
        return JSON.stringify({
          reviewed: true,
          finalized: true,
          applied,
          snippetCount,
          ...audit
        })
      }
      return JSON.stringify({
        reviewed: true,
        finalized: false,
        applied,
        snippetCount,
        ...audit
      })
    }

    if (name === 'critique_story_draft') {
      const candidate = resolveCandidateStory(args)
      if (!candidate) {
        return JSON.stringify({
          schemaValid: false,
          error: '未提供 story 且工作区尚无已保存草稿'
        })
      }
      const maxDiag =
        typeof args.maxDiagnostics === 'number' && Number.isFinite(args.maxDiagnostics)
          ? Math.max(1, Math.min(40, Math.round(args.maxDiagnostics)))
          : 15
      try {
        const audited = auditDraftCandidate(candidate)
        const directorTelemetry = buildDirectorStageTelemetry(candidate, targetMinutes)
        return JSON.stringify({
          schemaValid: true,
          readyToFinalize: audited.readyToFinalize,
          directorReviewed: Boolean(directorReview),
          directorTelemetry,
          actingPassed: audited.actingReport.passed,
          actingScore: audited.actingReport.score,
          officialPassed: audited.officialPassed,
          officialIssues: audited.postOfficialReport.issues,
          zeroMotionModelIds: audited.actingReport.zeroMotionModelIds,
          repeatedFacialRunCount: audited.actingReport.repeatedFacialRunCount,
          facialMismatchCount: audited.actingReport.facialMismatchCount,
          motionMismatchCount: audited.actingReport.motionMismatchCount,
          simultaneousCollisionCount: audited.actingReport.simultaneousCollisionCount,
          stageDirectionLeakCount: audited.actingReport.stageDirectionLeakCount,
          listenerFrozenCount: audited.actingReport.listenerFrozenCount ?? 0,
          duplicateBgmCount: audited.actingReport.duplicateBgmCount ?? 0,
          zeroWidthCharCount: audited.actingReport.zeroWidthCharCount ?? 0,
          staggeredMidlineMotionCount: audited.actingReport.staggeredMidlineMotionCount ?? 0,
          excessiveSlidingCount: audited.actingReport.excessiveSlidingCount ?? 0,
          dialogueIssues: audited.dialogueLint.issues.slice(0, maxDiag),
          diagnostics: audited.actingReport.diagnostics.slice(0, maxDiag),
          warnings: audited.warnings.slice(0, 8)
        })
      } catch (error) {
        return JSON.stringify({
          schemaValid: false,
          readyToFinalize: false,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    if (name === 'validate_story_draft') {
      const candidate = resolveCandidateStory(args)
      if (!candidate) {
        return JSON.stringify({
          schemaValid: false,
          error: '未提供有效的 StoryData 对象'
        })
      }
      try {
        const { story, warnings } = validateAndFixStory(candidate, view, logger, {
          emotionLabels
        })
        const actingReport = runActingAndFidelityAudit(story, view)
        const report = actingReport.officialReport
        const bodyMotions = countBodyMotionsByModel(story)
        const zeroMotionModels = story.models
          .filter((m) => (bodyMotions[String(m.id)] ?? 0) === 0)
          .map((m) => m.id)
        const stageLeaks = story.snippets
          .map((s, idx) => ({ idx, s }))
          .filter(
            ({ s }) =>
              s.type === 'Talk' &&
              'data' in s &&
              hasSpokenStageDirectionLeak(
                String((s.data as Record<string, unknown>)?.content ?? '')
              )
          )
          .map(({ idx }) => idx)

        return JSON.stringify({
          schemaValid: true,
          officialPassed:
            report.passed &&
            (actingReport.talkCount < 6 || zeroMotionModels.length === 0) &&
            stageLeaks.length === 0,
          actingPassed: actingReport.passed,
          actingScore: actingReport.score,
          warnings: warnings.slice(0, 12),
          officialIssues: report.issues,
          zeroMotionModelIds: zeroMotionModels,
          stageDirectionLeakSnippetIndices: stageLeaks,
          actingDiagnostics: actingReport.diagnostics.slice(0, 10),
          metrics: {
            talkCount: report.metrics.talkCount,
            talkZeroDelayShare: report.metrics.talkZeroDelayShare,
            appearMotionClashCount: report.metrics.appearMotionClashCount,
            inPlaceAppearShare: report.metrics.inPlaceAppearShare,
            bodyMotionsByModel: bodyMotions
          }
        })
      } catch (error) {
        return JSON.stringify({
          schemaValid: false,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    if (name === 'finalize_story_draft') {
      if (!savedDraft) {
        return JSON.stringify({
          finalized: false,
          error: '尚无已保存草稿，请先调用 save_story_draft 保存剧本'
        })
      }
      const audit = runCompactAudit(savedDraft)
      const telemetry = audit.directorTelemetry as DirectorStageTelemetry | undefined
      if (
        audit.schemaValid &&
        audit.officialPassed &&
        (telemetry?.talkCount ?? 0) >= 8 &&
        !directorReview
      ) {
        return JSON.stringify({
          finalized: false,
          needsDirectorReview: true,
          message:
            '长篇草稿（>=8 句）定稿前请先调用 submit_director_review 完成 5 维导演终审（评估戏剧弧光、情绪连贯与口吻、BGM/PlaySe 音效、舞台节奏、表情动作自然度）；可在同一次调用中附带 operations 落地修补并设 finalizeIfReady: true 一步定稿。',
          ...audit
        })
      }
      if (audit.schemaValid && audit.officialPassed) {
        finalized = true
        return JSON.stringify({
          finalized: true,
          ...audit
        })
      }
      return JSON.stringify({
        finalized: false,
        ...audit
      })
    }

    return JSON.stringify({ error: `未知工具：${name}` })
  }

  return {
    definitions,
    execute,
    getSavedDraft: () => savedDraft,
    getSavedPlan: () => savedPlan,
    getDirectorReview: () => directorReview,
    isFinalized: () => finalized
  }
}

export interface AgenticGenerationOptions {
  llm: LlmClient
  view: CatalogView
  personas: personasMod.PersonaEntry[]
  scene: string
  targetMinutes: number
  emotionLabels?: string[]
  systemPrompt?: string
  ragRetriever?: AdaptiveRagRetriever | null
  logger: Logger<ILogObj>
  maxToolTurns?: number
  signal?: AbortSignal
}

export interface AgenticGenerationResult {
  story: StoryData
  title?: string
  warnings: string[]
  rounds: number
  latencyMs: number
  model: string
  usage: ChatUsage | null
  toolCallsUsed: string[]
  modeUsed: 'native' | 'react-json'
  directorReview?: DirectorReviewRecord
}

/**
 * 压缩已被更新草稿取代的历史大体积工具调用载荷，防止多轮反复重传 20~30KB 完整草稿或全量推荐导致上下文膨胀。
 * 保持 OpenAI tool_calls / tool 消息配对结构 100% 合法，仅替换较早回合的冗余大块 JSON。
 */
function compactSupersededAgentMessages(messages: ChatMessage[]): void {
  const COMPACT_THRESHOLD = 3200
  const COMPACTABLE_TOOLS = new Set([
    'save_story_draft',
    'validate_dialogue_draft',
    'recommend_acting_for_lines'
  ])
  // 找到最近一次 save_story_draft 所在的 assistant 消息下标；只压缩严格早于它的历史大载荷
  let latestSaveAssistantIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (
      m.role === 'assistant' &&
      m.tool_calls?.some((tc) => tc.function.name === 'save_story_draft')
    ) {
      latestSaveAssistantIdx = i
      break
    }
  }
  if (latestSaveAssistantIdx <= 1) return

  const compactedCallIds = new Set<string>()
  for (let i = 0; i < latestSaveAssistantIdx; i++) {
    const m = messages[i]
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (
          COMPACTABLE_TOOLS.has(tc.function.name) &&
          tc.function.arguments.length > COMPACT_THRESHOLD
        ) {
          tc.function.arguments = JSON.stringify({
            _compacted: true,
            tool: tc.function.name,
            note: 'superseded by newer workspace draft'
          })
          compactedCallIds.add(tc.id)
        }
      }
    } else if (
      m.role === 'tool' &&
      m.tool_call_id &&
      compactedCallIds.has(m.tool_call_id) &&
      typeof m.content === 'string' &&
      m.content.length > COMPACT_THRESHOLD
    ) {
      m.content = JSON.stringify({
        _compacted: true,
        tool: m.name ?? '',
        note: 'superseded by newer workspace draft'
      })
    }
  }
}

/**
 * 运行多步自主 Agentic Tool-Calling 剧本导演闭环：
 * 1. 支持多轮自主探索、规划、台词与表演语义查询、草稿暂存（save_story_draft）、逐句表演审校（critique_story_draft）、局部修补（patch_story_draft）与确认交卷（finalize_story_draft）；
 * 2. 优先使用 OpenAI 原生 tools / function calling，同时兼容部分代理把 ReAct tool_call 写在 content 的情况；
 * 3. 若底层模型或网关不支持原生 tools（返回 400/404/422/501），自动无缝切换至 ReAct JSON 工具信封模式，同样可调用全部工具并自检定稿。
 */
export async function runAgenticStoryGeneration(
  options: AgenticGenerationOptions
): Promise<AgenticGenerationResult> {
  const {
    llm,
    view,
    personas,
    scene,
    targetMinutes,
    emotionLabels = [],
    ragRetriever,
    logger,
    signal
  } = options
  const maxToolTurns = Math.max(2, options.maxToolTurns ?? 16)
  const toolkit = createStoryAgentToolkit({
    view,
    personas,
    emotionLabels,
    targetMinutes,
    ragRetriever,
    logger
  })

  const castSummary = view
    .primaryModels()
    .map((m, idx) =>
      idx < 14
        ? `${view.shortName(m)}(modelId=${m.id}, path=${m.path})`
        : `${view.shortName(m)}(modelId=${m.id})`
    )
    .join('；')
  const emotionNote =
    emotionLabels.length > 0
      ? `每条 Talk 填 emotion（可选：${emotionLabels.join('、')}，日常陈述选「${emotionLabels.includes('平静') ? '平静' : emotionLabels[0]}」）；**严禁在哭泣/悲伤/道歉/恳求/对峙段中间掉回「平静」**（即使台词表面说「没关系」「只是吓了一跳」也必须标「伤心」），但当剧情真正进入结尾释怀、夕阳缓和或安静接纳余韵时，允许自然过渡到温和释放的「平静」或「开心」让情绪弧光呼吸。请同时为哭腔/情绪转折/高潮句写简短日语 \`ttsCaption\`（仅描述语气/呼吸/颤抖/停顿，严禁出現年龄/性别/声线词）与 \`ttsSpeed\`（沉重哭诉 0.90~0.96，急促喊叫 1.04~1.12），全片最痛哭/撕裂高潮（<= 15%）设 \`ttsSpecialScene: true\`。`
      : ''

  const sharedRules = [
    '你是 Project SEKAI 风格视觉小说导演 Agent。请用高效 4~5 步闭环完成高质感创作，杜绝冗余情绪标注轮次：',
    '- **第 1 步（并行批量探索）**：在同 1 轮并行调用 `lookup_character({ characters: [...全部出场角色], includeExpressions: true })` + `search_assets({ kinds: ["background","bgm","se"], queries: [...] })` + `search_official_corpus({ query })`；**不要**按角色逐一重复查 `lookup_character` 或 `inspect_character_expressions`！',
    '- **第 2 步（直接起草）**：基于已获取的人设、表情/动作调色板与素材，直接起草完整高质量 StoryData 并调用 1 次 `save_story_draft`（复杂多幕可先 `plan_story_outline`）。**严禁**把整场几十句台词重发一遍给 `validate_dialogue_draft` 或 `recommend_acting_for_lines`！`save_story_draft` 已自带全套规则体检与 `directorTelemetry`，**无需**再重复调用 `validate_story_draft` 或 `critique_story_draft`。',
    "- **第 3 步（真正 5 维导演终审 + 外科修补 + 一步定稿）**：结合 `save_story_draft` 返回的 `directorTelemetry` 与诊断，调用 `submit_director_review`，以导演视角切实审视：（1）戏剧弧光、总句数时长达标与凝练句长（2）情绪连贯与人物口吻（3）开场/静音切停 BGM 与 `PlaySe` 物理音效（4）舞台镜头与节奏（单人 Center 特写与双人 Left/Right 原地淡入淡出切镜、`SideFade`/`FlashbackIn`/`AmbientColor`、独立 `Motion` 静默拍、`Wait` 留白，以及克制的镜头/震动使用）（5）全量动作库多样性与表情自然度（严禁 `nod01`/`sad01` 刷屏，确保每位角色都有丰富动作）；在同一次 `submit_director_review` 中用 `operations` 落地所有具体修补并设 `finalizeIfReady: true` 一步交卷！",
    '创作指南（基于 5,138 集近期加权官方 PJSK 规律，灵活自然切忌死板套指标）：',
    '1. **持续情绪、动作多样性与真伪笑脸分辨**：泣不成声、悲伤倾诉、冲突崩溃段应自然维持 `face_cry_*` / `face_sad_*` 连续 4~8+ 句；充分利用角色全量动作库（含 `nod02/03`、`forward02`、`sigh01`、`lookaway01`、`fidget01`、`relief01` 及贴合气氛的跨风格变体），同一词根整场不要重复超过 2~3 次，确保每位在场角色都有多样身体动作，并在句间/转折前点缀独立 `Motion` 节拍（约 16~22 次/40句）。严禁在悲伤/哭泣/愤怒/惊愕台词中误用嘴角上扬（`ParamMouthForm >= 0.2`）的苦笑/强颜欢笑脸（如 `face_trouble_02`）或欢快动作（`w-normal-glad*`/`w-happy-*`/`greeting`）；先前处于「生气/伤心」的听者严禁突然切为 `face_smile_*`；`delicious`/`eat`/`drink` 与 `sleep` 仅限真实吃喝或睡眠台词；真冬保持克制内敛。',
    '2. **电影感切镜、听者反应与原地淡入淡出（严禁滑动）**：近期官方 PJSK 剧集高频穿插「单人 Center 特写切镜」与「双人 Left/Right 同框」（内心独白、连续说话或情绪爆发切单人 `Center`），所有 `LayoutAppear` / `LayoutClear` 一律采用原地渐变淡入淡出（`from.side === to.side, offset: 0`），**严禁使用 `LeftOver`/`RightOver`/`Under` 画外滑入滑出，也严禁 `Move` 横向滑位或 Center <-> Left/Right 滑动**；转场善用 `SideFade`、`FlashbackIn/Out` 与 `AmbientColor`。听者反应优先用切镜、句间独立 `Motion` 静默反应拍、短促「……」回应或双人同框句首 `at: 0` 纯 `facial` 微调，严禁在说话者句中 `at: 0.45..0.85` 塞入听者错峰身体动作。',
    '3. **声画节拍与镜头/震动/字幕克制**：开场必须由 `ChangeBgm` 起乐，情绪高潮/转折前善用 `ChangeBgm({stop:true})` 制造静音留白，物理/情绪节拍务必配 `PlaySe`；**严禁公式化滥用镜头、震动与开场字幕**：日常/谈心/后台戏 `CameraZoom`/`CameraMove` 仅用 `0~1` 次（仅高潮爆点用 `1~3` 次），`CharacterShake` 仅限真实受惊/物理碰撞（平常对话不用），`Telop`/`PlaceInfo` 仅在明确需要交代时空时可选使用、不要每场模板双挂；片尾用 `closeWindowOnFinish: true` + 留白/缓慢 `BlackOut` 收束余韵。',
    '4. **凝练对白、`closeWindowOnFinish` 与排版**：多用 4~14 字短促反应、停顿与潜台词和中等句交错，避免连续长篇书面说教或重复独白拖长；台词只写说出口的话或完整括号心里话，严禁「（微笑）」「（叹气）」等动作括号；每条 Talk 最多 3 行（每行<=30字宽），不写 `ttsText`；约 90% Talk `delay=0`，仅重停顿用 `1.0/1.5` 或独立 `Wait`；`closeWindowOnFinish: true` **仅**用于真实停顿（`Wait >= 300ms`）或转场/淡出（`BlackOut`/`SideFade`/`Telop`/`LayoutClear`）之前，**严禁**在瞬时 `Motion` / `PlaySe` / `ChangeBgm` 后立刻接下句 `Talk` 时设 `closeWindowOnFinish: true` 导致对话框闪烁。',
    emotionNote,
    options.systemPrompt?.trim() ?? ''
  ]
    .filter(Boolean)
    .join('\n')

  const targetTalkMin = Math.max(8, Math.round(targetMinutes * 9.5))
  const targetTalkMax = Math.max(targetTalkMin + 4, Math.round(targetMinutes * 12))
  const exampleSnippet = buildActingExample(view)
  const userPrompt = [
    `场景要求：${scene}`,
    `目标时长：约 ${targetMinutes} 分钟（按 PJSK 配音与停顿约 7 秒/句换算，全片严格控制在 ${targetTalkMin}~${targetTalkMax} 句 Talk；凝练抓重点，严禁连排重复独白拉长）`,
    `可选角色摘要：${castSummary}`,
    `JSON 结构示例：\n\`\`\`json\n${exampleSnippet}\n\`\`\``,
    '请充分利用工具核实角色人设、表情与动作语义、背景/BGM/SE 资源和官方语料，通过规划→起草→逐句导演审校→局部修补完成高质量剧本。'
  ].join('\n\n')

  const totalUsage: ChatUsage = {}
  let totalLatency = 0
  let lastModel = llm.model
  const toolCallsUsed: string[] = []
  let rounds = 0

  const tryFinalize = (
    rawContent: string,
    context: { finishReason?: string; enforceActingStrict?: boolean } = {}
  ):
    | { ok: true; story: StoryData; warnings: string[] }
    | { ok: false; error: string; candidateObj?: Record<string, unknown> } => {
    try {
      const parsed = extractJson(rawContent, { finishReason: context.finishReason })
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>).use_saved_draft === true
      ) {
        const draft = toolkit.getSavedDraft()
        if (!draft) {
          return { ok: false, error: '当前没有已保存草稿（use_saved_draft=true 无效）' }
        }
        return finalizeStoryCandidate(draft, context.enforceActingStrict ?? false)
      }
      return finalizeStoryCandidate(parsed, context.enforceActingStrict ?? false)
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  const finalizeStoryCandidate = (
    candidate: unknown,
    enforceActingStrict: boolean
  ):
    | { ok: true; story: StoryData; warnings: string[] }
    | { ok: false; error: string; candidateObj?: Record<string, unknown> } => {
    try {
      const prepared =
        candidate && typeof candidate === 'object' && !Array.isArray(candidate)
          ? structuredClone(candidate as Record<string, unknown>)
          : candidate
      if (
        prepared &&
        typeof prepared === 'object' &&
        !Array.isArray(prepared) &&
        Array.isArray((prepared as Record<string, unknown>).snippets)
      ) {
        // 在 validateAndFixStory 的表情冲突修复前先对齐错标「平静」的哭泣/悲伤台词，防止 face_sad_*/face_cry_* 被覆盖
        alignStoryTtsEmotionsAndCaptions(prepared as unknown as StoryData, { emotionLabels })
      }
      const { story, warnings } = validateAndFixStory(prepared, view, logger, { emotionLabels })
      const actingReport = runActingAndFidelityAudit(story, view)
      const report = actingReport.officialReport
      const issues: string[] = []
      if (!report.passed && report.issues.length > 0) {
        issues.push(`官方剧本检查未通过：${report.issues.slice(0, 4).join('；')}`)
      }
      if (
        enforceActingStrict &&
        actingReport.talkCount >= 6 &&
        actingReport.zeroMotionModelIds.length > 0
      ) {
        issues.push(
          `角色 ${actingReport.zeroMotionModelIds.join(',')} 全程 0 身体动作，请通过 patch_story_draft 为其补齐自然的动作切换`
        )
      }
      if (enforceActingStrict && actingReport.talkCount >= 4) {
        const highActing = actingReport.diagnostics.filter(
          (d) => d.severity === 'high' && (d.field === 'facial' || d.field === 'motion')
        )
        if (highActing.length > 0) {
          const sample = highActing
            .slice(0, 3)
            .map(
              (d) =>
                `snippets[${d.snippetIndex}](${d.speaker}): ${d.message}` +
                (d.recommendedFacials.length > 0
                  ? `，推荐表情[${d.recommendedFacials.slice(0, 2).join(',')}]`
                  : '') +
                (d.recommendedMotions.length > 0
                  ? `，推荐动作[${d.recommendedMotions.slice(0, 2).join(',')}]`
                  : '')
            )
            .join('；')
          issues.push(`表情/动作与剧情情绪冲突：${sample}`)
        }
      }
      if (issues.length > 0) {
        return {
          ok: false,
          error: issues.join(' | '),
          ...(candidate && typeof candidate === 'object' && !Array.isArray(candidate)
            ? { candidateObj: candidate as Record<string, unknown> }
            : {})
        }
      }
      return { ok: true, story, warnings }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  const recoverSavedDraftIfValid = (): {
    ok: true
    story: StoryData
    warnings: string[]
  } | null => {
    const draft = toolkit.getSavedDraft()
    if (!draft) return null
    const res = finalizeStoryCandidate(draft, false)
    if (res.ok) return res
    return null
  }

  const tryExtractEnvelopeToolCall = (
    rawContent: string
  ): { name: string; arguments: unknown } | null => {
    try {
      const val = extractJson(rawContent)
      if (!val || typeof val !== 'object' || Array.isArray(val)) return null
      const rec = val as Record<string, unknown>
      if (rec.tool_call && typeof rec.tool_call === 'object') {
        const tc = rec.tool_call as Record<string, unknown>
        const fnName = typeof tc.name === 'string' ? tc.name.trim() : ''
        if (fnName) return { name: fnName, arguments: tc.arguments }
      }
    } catch {
      return null
    }
    return null
  }

  // ---- 模式 1：OpenAI 原生 function calling ----
  const nativeMessages: ChatMessage[] = [
    { role: 'system', content: sharedRules },
    { role: 'user', content: userPrompt }
  ]

  let switchToReactFallback = false
  for (let turn = 0; turn < maxToolTurns; turn++) {
    rounds += 1
    const isFinalTurn = turn >= maxToolTurns - 1
    try {
      const hasDraft = Boolean(toolkit.getSavedDraft())
      const res = await llm.chat(
        isFinalTurn
          ? [
              ...nativeMessages,
              {
                role: 'user',
                content: hasDraft
                  ? '工具调用轮次已达上限。若工作区草稿已就绪请直接输出 {"use_saved_draft":true}，否则输出完整合法的 StoryData JSON（仅含 models、images、snippets）。'
                  : '工具调用轮次已达上限，请立即综合以上已获取信息直接输出最终完整合法的 StoryData JSON（仅含 models、images、snippets）。'
              }
            ]
          : nativeMessages,
        isFinalTurn
          ? { json: true, signal }
          : {
              tools: toolkit.definitions,
              toolChoice: 'auto',
              signal
            }
      )
      totalLatency += res.latencyMs
      lastModel = res.model
      addUsage(totalUsage, res.usage)

      const calls: LlmToolCall[] = res.toolCalls ?? []
      if (calls.length > 0) {
        nativeMessages.push({
          role: 'assistant',
          content: res.content || null,
          tool_calls: calls
        })
        for (const call of calls) {
          toolCallsUsed.push(call.function.name)
          const output = await toolkit.execute(call.function.name, call.function.arguments, signal)
          nativeMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: output
          })
        }
        compactSupersededAgentMessages(nativeMessages)
        if (toolkit.isFinalized()) {
          const recovered = recoverSavedDraftIfValid()
          if (recovered) {
            const review = toolkit.getDirectorReview()
            return {
              story: recovered.story,
              ...(toolkit.getSavedPlan()?.title ? { title: toolkit.getSavedPlan()!.title } : {}),
              warnings: recovered.warnings,
              rounds,
              latencyMs: totalLatency,
              model: lastModel,
              usage: Object.keys(totalUsage).length > 0 ? totalUsage : null,
              toolCallsUsed,
              modeUsed: 'native',
              ...(review ? { directorReview: review } : {})
            }
          }
        }
        continue
      }

      // 部分代理会在未报错的情况下把 tool_call JSON 放在 content 里
      if (!isFinalTurn) {
        const inlineCall = tryExtractEnvelopeToolCall(res.content)
        if (inlineCall) {
          toolCallsUsed.push(inlineCall.name)
          const output = await toolkit.execute(inlineCall.name, inlineCall.arguments, signal)
          nativeMessages.push({ role: 'assistant', content: res.content.slice(0, 12_000) })
          nativeMessages.push({
            role: 'user',
            content: `工具 ${inlineCall.name} 返回结果：\n${output}\n\n请继续调用下一个工具，或调用 finalize_story_draft / 输出最终 StoryData JSON。`
          })
          if (toolkit.isFinalized()) {
            const recovered = recoverSavedDraftIfValid()
            if (recovered) {
              return {
                story: recovered.story,
                ...(toolkit.getSavedPlan()?.title ? { title: toolkit.getSavedPlan()!.title } : {}),
                warnings: recovered.warnings,
                rounds,
                latencyMs: totalLatency,
                model: lastModel,
                usage: Object.keys(totalUsage).length > 0 ? totalUsage : null,
                toolCallsUsed,
                modeUsed: 'native'
              }
            }
          }
          continue
        }
      }

      const finalized = tryFinalize(res.content, {
        finishReason: res.finishReason,
        enforceActingStrict: !isFinalTurn
      })
      if (finalized.ok) {
        return {
          story: finalized.story,
          ...(toolkit.getSavedPlan()?.title ? { title: toolkit.getSavedPlan()!.title } : {}),
          warnings: finalized.warnings,
          rounds,
          latencyMs: totalLatency,
          model: lastModel,
          usage: Object.keys(totalUsage).length > 0 ? totalUsage : null,
          toolCallsUsed,
          modeUsed: 'native'
        }
      }
      if (turn + 1 < maxToolTurns) {
        if (finalized.candidateObj && !toolkit.getSavedDraft()) {
          await toolkit.execute('save_story_draft', { story: finalized.candidateObj }, signal)
        }
        nativeMessages.push({ role: 'assistant', content: res.content.slice(0, 20_000) })
        nativeMessages.push({
          role: 'user',
          content: toolkit.getSavedDraft()
            ? `输出未通过导演终审：${finalized.error}。草稿已保存在工作区，请使用 patch_story_draft 定点修补问题行后调用 finalize_story_draft，或直接输出修正后的完整 JSON。`
            : `最终输出未通过校验：${finalized.error}。请修正后输出完整合法的 StoryData JSON（或先调用 save_story_draft 保存后再局部修补）。`
        })
        continue
      }
      const recovered = recoverSavedDraftIfValid()
      if (recovered) {
        return {
          story: recovered.story,
          ...(toolkit.getSavedPlan()?.title ? { title: toolkit.getSavedPlan()!.title } : {}),
          warnings: recovered.warnings,
          rounds,
          latencyMs: totalLatency,
          model: lastModel,
          usage: Object.keys(totalUsage).length > 0 ? totalUsage : null,
          toolCallsUsed,
          modeUsed: 'native'
        }
      }
      throw new LlmError(`Agentic 输出未通过校验：${finalized.error}`)
    } catch (error) {
      if (error instanceof LlmError && error.toolCallingUnsupported) {
        logger.info(
          '[AI] 当前模型/网关不支持原生 tool calling，自动切换至 ReAct JSON 工具信封回退模式'
        )
        switchToReactFallback = true
        break
      }
      if (isFinalTurn) {
        const recovered = recoverSavedDraftIfValid()
        if (recovered) {
          const review = toolkit.getDirectorReview()
          logger.warn(
            `[AI] Agentic 末轮响应失败（${error instanceof Error ? error.message : String(error)}），已直接采用工作区通过校验的草稿`
          )
          return {
            story: recovered.story,
            ...(toolkit.getSavedPlan()?.title ? { title: toolkit.getSavedPlan()!.title } : {}),
            warnings: recovered.warnings,
            rounds,
            latencyMs: totalLatency,
            model: lastModel,
            usage: Object.keys(totalUsage).length > 0 ? totalUsage : null,
            toolCallsUsed,
            modeUsed: 'native',
            ...(review ? { directorReview: review } : {})
          }
        }
      }
      throw error
    }
  }

  if (!switchToReactFallback) {
    const recovered = recoverSavedDraftIfValid()
    if (recovered) {
      return {
        story: recovered.story,
        ...(toolkit.getSavedPlan()?.title ? { title: toolkit.getSavedPlan()!.title } : {}),
        warnings: recovered.warnings,
        rounds,
        latencyMs: totalLatency,
        model: lastModel,
        usage: Object.keys(totalUsage).length > 0 ? totalUsage : null,
        toolCallsUsed,
        modeUsed: 'native'
      }
    }
    throw new LlmError(`Agentic 模式在 ${maxToolTurns} 轮内未输出可通过校验的最终剧本`)
  }

  // ---- 模式 2：无原生 tools 支持时的 ReAct JSON 工具信封回退 ----
  const toolCatalogText = toolkit.definitions
    .map(
      (def) =>
        `- ${def.function.name}: ${def.function.description} 参数: ${JSON.stringify(def.function.parameters)}`
    )
    .join('\n')

  const reactMessages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        sharedRules,
        '',
        '## 可用工具（ReAct JSON 协议）',
        toolCatalogText,
        '每一轮只输出一个合法 JSON 对象：',
        '- 需要调工具时输出：{"tool_call":{"name":"工具名","arguments":{...}}}',
        '- 若草稿已通过 save_story_draft + patch_story_draft + critique_story_draft 且确认交卷，可输出：{"use_saved_draft":true}',
        '- 或直接输出最终剧本：{"final":{...完整StoryData...}}（或直接输出含 models、images、snippets 的 StoryData JSON）。'
      ].join('\n')
    },
    { role: 'user', content: userPrompt }
  ]

  for (let turn = 0; turn < maxToolTurns; turn++) {
    rounds += 1
    const isFinalTurn = turn >= maxToolTurns - 1
    let res
    try {
      res = await llm.chat(reactMessages, { json: true, signal })
    } catch (error) {
      if (isFinalTurn) {
        const recovered = recoverSavedDraftIfValid()
        if (recovered) {
          const review = toolkit.getDirectorReview()
          logger.warn(
            `[AI] ReAct 末轮响应失败（${error instanceof Error ? error.message : String(error)}），已直接采用工作区通过校验的草稿`
          )
          return {
            story: recovered.story,
            ...(toolkit.getSavedPlan()?.title ? { title: toolkit.getSavedPlan()!.title } : {}),
            warnings: recovered.warnings,
            rounds,
            latencyMs: totalLatency,
            model: lastModel,
            usage: Object.keys(totalUsage).length > 0 ? totalUsage : null,
            toolCallsUsed,
            modeUsed: 'react-json',
            ...(review ? { directorReview: review } : {})
          }
        }
      }
      throw error
    }
    totalLatency += res.latencyMs
    lastModel = res.model
    addUsage(totalUsage, res.usage)

    let parsed: Record<string, unknown> | null = null
    try {
      const val = extractJson(res.content, { finishReason: res.finishReason })
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        parsed = val as Record<string, unknown>
      }
    } catch (error) {
      if (turn + 1 >= maxToolTurns) {
        const recovered = recoverSavedDraftIfValid()
        if (recovered) {
          return {
            story: recovered.story,
            ...(toolkit.getSavedPlan()?.title ? { title: toolkit.getSavedPlan()!.title } : {}),
            warnings: recovered.warnings,
            rounds,
            latencyMs: totalLatency,
            model: lastModel,
            usage: Object.keys(totalUsage).length > 0 ? totalUsage : null,
            toolCallsUsed,
            modeUsed: 'react-json'
          }
        }
        throw error
      }
      reactMessages.push({ role: 'assistant', content: res.content.slice(0, 20_000) })
      reactMessages.push({
        role: 'user',
        content: `输出不是合法 JSON（${error instanceof Error ? error.message : String(error)}），请严格输出 {"tool_call":...}、{"use_saved_draft":true} 或 {"final":...}。`
      })
      continue
    }

    if (parsed?.tool_call && typeof parsed.tool_call === 'object') {
      const tc = parsed.tool_call as Record<string, unknown>
      const fnName = typeof tc.name === 'string' ? tc.name.trim() : ''
      if (fnName) {
        toolCallsUsed.push(fnName)
        const output = await toolkit.execute(fnName, tc.arguments, signal)
        if (toolkit.isFinalized()) {
          const recovered = recoverSavedDraftIfValid()
          if (recovered) {
            return {
              story: recovered.story,
              ...(toolkit.getSavedPlan()?.title ? { title: toolkit.getSavedPlan()!.title } : {}),
              warnings: recovered.warnings,
              rounds,
              latencyMs: totalLatency,
              model: lastModel,
              usage: Object.keys(totalUsage).length > 0 ? totalUsage : null,
              toolCallsUsed,
              modeUsed: 'react-json'
            }
          }
        }
        reactMessages.push({ role: 'assistant', content: res.content.slice(0, 12_000) })
        reactMessages.push({
          role: 'user',
          content: `工具 ${fnName} 返回结果：\n${output}\n\n请继续调用下一个工具，或输出 {"use_saved_draft":true} / {"final": ...完整StoryData...}。`
        })
        continue
      }
    }

    const candidateObj =
      parsed && 'final' in parsed && parsed.final && typeof parsed.final === 'object'
        ? parsed.final
        : parsed
    const finalized = tryFinalize(JSON.stringify(candidateObj), {
      finishReason: res.finishReason,
      enforceActingStrict: !isFinalTurn
    })
    if (finalized.ok) {
      return {
        story: finalized.story,
        ...(toolkit.getSavedPlan()?.title ? { title: toolkit.getSavedPlan()!.title } : {}),
        warnings: finalized.warnings,
        rounds,
        latencyMs: totalLatency,
        model: lastModel,
        usage: Object.keys(totalUsage).length > 0 ? totalUsage : null,
        toolCallsUsed,
        modeUsed: 'react-json'
      }
    }
    if (turn + 1 < maxToolTurns) {
      if (finalized.candidateObj && !toolkit.getSavedDraft()) {
        await toolkit.execute('save_story_draft', { story: finalized.candidateObj }, signal)
      }
      reactMessages.push({ role: 'assistant', content: res.content.slice(0, 20_000) })
      reactMessages.push({
        role: 'user',
        content: toolkit.getSavedDraft()
          ? `剧本未通过导演终审：${finalized.error}。草稿已保存在工作区，请用 patch_story_draft 定点修补问题行后 finalize_story_draft，或直接输出 {"final": ...}。`
          : `最终剧本未通过校验：${finalized.error}。请修正并输出 {"final": ...}。`
      })
      continue
    }
    const recovered = recoverSavedDraftIfValid()
    if (recovered) {
      return {
        story: recovered.story,
        ...(toolkit.getSavedPlan()?.title ? { title: toolkit.getSavedPlan()!.title } : {}),
        warnings: recovered.warnings,
        rounds,
        latencyMs: totalLatency,
        model: lastModel,
        usage: Object.keys(totalUsage).length > 0 ? totalUsage : null,
        toolCallsUsed,
        modeUsed: 'react-json'
      }
    }
    throw new LlmError(`ReAct 回退模式未通过校验：${finalized.error}`)
  }

  const recovered = recoverSavedDraftIfValid()
  if (recovered) {
    return {
      story: recovered.story,
      ...(toolkit.getSavedPlan()?.title ? { title: toolkit.getSavedPlan()!.title } : {}),
      warnings: recovered.warnings,
      rounds,
      latencyMs: totalLatency,
      model: lastModel,
      usage: Object.keys(totalUsage).length > 0 ? totalUsage : null,
      toolCallsUsed,
      modeUsed: 'react-json'
    }
  }
  throw new LlmError(`ReAct 回退模式在 ${maxToolTurns} 轮内未完成剧本生成`)
}
