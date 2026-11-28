import { ILogObj, Logger } from 'tslog'
import { DEFAULT_BGM_FADE_MS, MAX_BGM_FADE_MS } from '../../common/audio/bgm'
import { StorySchema, type StoryData } from '../../common/types/Story'
import {
  enforceOfficialStoryInvariants,
  isExplicitThinkingTalkSnippet,
  isThinkingTalkSnippet,
  normalizeLayoutTransitionBarriers,
  type OfficialLintReport
} from './officialLinter'
import { repairSpokenStageDirections } from './dialogueLinter'
import * as facialSemanticsMod from './facialSemantics'
import * as personasMod from './personas'
import { isStandingMotion, type CatalogView } from './prompt'
import { normalizeScenarioEffectName } from './scenarioCues'
import { resolveRegisteredSeFile } from '../resources/resourceCatalog'
import * as ttsTextMod from './ttsText'
import { enforceIrodoriEmojiBudget, sanitizeIrodoriCaption } from '../../common/tts/irodori'

const TALK_LINE_WIDTH_UNITS = 30
const TALK_MAX_LINES = 3
const VALID_SIDES = new Set(['Center', 'Left', 'Right', 'LeftOver', 'RightOver', 'Under'])
const ON_STAGE_SIDES = new Set(['Center', 'Left', 'Right'])
const OFFSCREEN_SIDES = new Set(['LeftOver', 'RightOver', 'Under'])
const VALID_MOVE_SPEEDS = new Set(['Slow', 'Normal', 'Fast', 'Immediate'])
const VALID_SNIPPET_TYPES = new Set([
  'ChangeLayoutMode',
  'ChangeBackgroundImage',
  'ChangeBgm',
  'BgmVolume',
  'PlaySe',
  'StopSe',
  'LayoutAppear',
  'LayoutClear',
  'LayoutDepth',
  'CharacterShake',
  'CostumeChange',
  'Talk',
  'HideTalk',
  'Move',
  'Motion',
  'Telop',
  'PlaceInfo',
  'FullScreenText',
  'SimpleSelectable',
  'Wait',
  'BlackOut',
  'BlackIn',
  'ShakeScreen',
  'StopShakeScreen',
  'ShakeWindow',
  'StopShakeWindow',
  'FlashbackIn',
  'FlashbackOut',
  'SepiaIn',
  'SepiaOut',
  'SekaiIn',
  'SekaiOut',
  'Wipe',
  'SideFade',
  'AttachCharacterShader',
  'PlayScenarioEffect',
  'StopScenarioEffect',
  'BlurIn',
  'BlurOut',
  'CameraMove',
  'CameraZoom',
  'DollyZoom',
  'AmbientColor',
  'BackgroundBlur',
  'StopShake',
  'Movie',
  'DoParam'
])

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

const toBool = (value: unknown, fallback = false): boolean => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return ['true', '1', 'yes'].includes(value.toLowerCase())
  if (typeof value === 'number') return value !== 0
  return fallback
}

const toStr = (value: unknown, fallback = ''): string => {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return fallback
  return String(value)
}

const cleanPath = (value: unknown, fallback = ''): string => {
  const text = toStr(value, fallback)
    .replace(/\\/g, '/')
    .replace(/\s*\.\s*/g, '.')
    .replace(/\s*\/\s*/g, '/')
    .trim()
  return text || fallback
}

interface FacialSemanticsValidationExt {
  isFacialCompatibleWithLine?: (params: {
    facial: string
    modelPath?: string
    emotion?: string
    content: string
    prevTense?: boolean
    isMonologue?: boolean
    isListener?: boolean
    restrainedRole?: boolean
    cheerfulScene?: boolean
    modelsRoot?: string
  }) => { ok: boolean; reason?: string }
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
    cheerfulScene?: boolean
  }) => { ok: boolean; reason?: string }
  pickMoodMatchedMotion?: (
    motions: string[],
    mood: facialSemanticsMod.TargetMood,
    modelPath?: string,
    restrainedRole?: boolean,
    avoidMotions?: ReadonlySet<string> | string[],
    modelsRoot?: string,
    diversity?: {
      motionCounts?: ReadonlyMap<string, number>
      stemCounts?: ReadonlyMap<string, number>
    }
  ) => string
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
    restrainedRole?: boolean
    prevFacial?: string
    prevMotion?: string
    recentMotions?: ReadonlySet<string> | string[]
    limit?: number
  }) => { mood: string; facials: string[]; motions: string[] }
}

interface TtsTextValidationExt {
  stripZeroWidthChars?: (text: string) => string
}

interface PersonasValidationExt {
  characterActingProfile?: (
    nameOrPath: string,
    roleHint?: string
  ) => { restrained: boolean; temperament: string; actingNote: string }
}

const facialValidationApi = facialSemanticsMod as unknown as FacialSemanticsValidationExt
const ttsTextValidationApi = ttsTextMod as unknown as TtsTextValidationExt
const personasValidationApi = personasMod as unknown as PersonasValidationExt

// 只清理零宽空格/无宽连接符/BOM（绝不触碰 \u200D ZWJ 或 \uFE0F，保留 Irodori TTS 复合情绪 emoji 如 😮‍💨、🌬️、⏸️）
const ZERO_WIDTH_CHAR_RE = /[\u200B\u200C\u2060\uFEFF]/g

function stripZeroWidth(text: string): string {
  if (typeof ttsTextValidationApi.stripZeroWidthChars === 'function') {
    return ttsTextValidationApi.stripZeroWidthChars(text)
  }
  return text.replace(ZERO_WIDTH_CHAR_RE, '')
}

const GENUINE_SHOCK_TEXT_RE = /(?:咦|诶|欸|吓我一跳|什么！？|怎么会|竟然|居然|真的吗)/
const DESPAIR_SAD_TEXT_RE =
  /(?:窒息|受不了|没办法面对|不可能一样|顾虑|滋生|再见|别走|对不起|抱歉|难过|伤心|眼泪|哭|失落|做不到|没能说出口|不敢|逃避|现实|藏不住|远了)/
const SELF_BLAME_REGRET_RE =
  /(?:为什么我|没能说出口|没能|对不起|抱歉|后悔|搞砸|都是我的错|别走|言い返せば|言えなかった)/
const DIRECTED_ANGER_RE = /(?:烦死|够了|住口|闭嘴|少啰嗦|气死|你干嘛|胡说什么|别再|混蛋)/

function isInnerMonologueText(text: string): boolean {
  const trimmed = text.trim()
  return /^[（(]/.test(trimmed) && /[）)]$/.test(trimmed)
}

function isFacialStrictlyCompatible(params: {
  facial: string
  modelPath?: string
  emotion: string
  content: string
  prevTense: boolean
  isMonologue?: boolean
  isListener?: boolean
  restrainedRole: boolean
  cheerfulScene?: boolean
}): boolean {
  if (!params.facial.trim()) return true
  const baseCheck =
    typeof facialValidationApi.isFacialCompatibleWithLine === 'function'
      ? facialValidationApi.isFacialCompatibleWithLine(params)
      : facialSemanticsMod.isFacialCompatibleWithLine(params)
  if (!baseCheck.ok) return false

  const info = facialSemanticsMod.inspectModelFacial(params.modelPath, params.facial)
  const lowerFacial = params.facial.trim().toLowerCase()
  const isSurpriseFacial =
    info.role === 'surprise' || /^face_(?:surprise|notice|shock|scared|nsscared)/i.test(lowerFacial)
  const isAngryFacial = info.role === 'angry' || /^face_(?:angry|disgust|scream)/i.test(lowerFacial)
  const emo = params.emotion.trim()
  const text = params.content.trim()
  const monologue = params.isMonologue ?? isInnerMonologueText(text)
  const isSadOrDespair = emo === '伤心' || DESPAIR_SAD_TEXT_RE.test(text)
  const isGenuineShock = emo === '惊讶' || (GENUINE_SHOCK_TEXT_RE.test(text) && emo !== '伤心')

  // 悲伤/绝望/沉重独白句严禁挂 surprise/notice/shock（除非台词本身是真正的震惊/突发发现且非伤心）
  if (isSurpriseFacial && !isGenuineShock && (isSadOrDespair || monologue)) {
    return false
  }

  // 纯自责/含泪悔恨的 [伤心] 台词严禁挂 angry 表情
  if (
    isAngryFacial &&
    emo === '伤心' &&
    (SELF_BLAME_REGRET_RE.test(text) || !DIRECTED_ANGER_RE.test(text))
  ) {
    return false
  }

  return true
}

function inferValidationMood(content: string, emotion: string): facialSemanticsMod.TargetMood {
  const emo = emotion.trim()
  if (emo === '伤心') return 'sad'
  if (emo === '生气') return 'angry'
  if (emo === '害怕') return 'trouble'
  if (emo === '惊讶') return 'surprise'
  if (emo === '害羞') return 'shy'
  if (emo === '开心') return 'smile'
  if (/对不起|抱歉|对不住|搞砸|后悔|难过|伤心|眼泪|哭|失落/.test(content)) return 'sad'
  if (/烦死|够了|住口|气死|少啰嗦/.test(content)) return 'angry'
  if (/那个|苦笑|没办法|为难|尴尬|纠结/.test(content)) return 'trouble'
  if (/什么！？|怎么会|竟然|！？|\?!/.test(content)) return 'surprise'
  if (/脸红|害羞|别看我/.test(content)) return 'shy'
  if (/太好了|好耶|哈哈|嘿嘿|嘻嘻|～♪|♪|Wonderhoy/.test(content)) return 'smile'
  return 'neutral'
}

function isRestrainedActor(modelName: string, modelPath: string): boolean {
  if (typeof personasValidationApi.characterActingProfile === 'function') {
    return personasValidationApi.characterActingProfile(`${modelName} ${modelPath}`).restrained
  }
  return /真冬|mafuyu/i.test(`${modelName} ${modelPath}`)
}

function isMotionMoodCompatible(params: {
  motion: string
  modelPath?: string
  emotion: string
  content: string
  prevContent?: string
  prevEmotion?: string
  prevTense: boolean
  isListener?: boolean
  restrainedRole: boolean
  cheerfulScene?: boolean
}): boolean {
  if (!params.motion.trim()) return true
  const lower = params.motion.toLowerCase()
  const text = params.content.trim()
  if (
    /greeting|shakehand|handshake|wave|byebye|salute/i.test(lower) &&
    !facialSemanticsMod.GREETING_CONTEXT_TEXT_RE.test(text)
  ) {
    return false
  }
  if (typeof facialValidationApi.isMotionCompatibleWithLine === 'function') {
    if (!facialValidationApi.isMotionCompatibleWithLine(params).ok) return false
  }
  const mood = inferValidationMood(params.content, params.emotion)
  const emo = params.emotion.trim()
  const monologue = isInnerMonologueText(text)
  const isSadOrDespair = mood === 'sad' || emo === '伤心' || DESPAIR_SAD_TEXT_RE.test(text)
  const isGenuineShock = emo === '惊讶' || (GENUINE_SHOCK_TEXT_RE.test(text) && emo !== '伤心')
  const isTense =
    params.prevTense || mood === 'sad' || mood === 'angry' || mood === 'trouble' || emo === '害怕'
  const isJoyfulMotion =
    /glad|happy|cheer|joy|wandahoi|wink|smug|doya|pose(?!sad)|delicious|sing|greeting|shakehand|handshake|wave|plan/.test(
      lower
    )
  const isNegativeMotion = /angry|disgust|sad|cry|sigh/.test(lower)
  const isGenuineHappy = facialSemanticsMod.isGenuineHappyOrReconciliation(text)
  if (
    isTense &&
    isJoyfulMotion &&
    !(params.prevTense && mood === 'smile' && isGenuineHappy && emo === '开心')
  ) {
    return false
  }
  if (mood === 'smile' && !params.prevTense && isNegativeMotion) return false
  if (params.restrainedRole && /glad|happy|cheer|joy/.test(lower)) return false
  // 悲伤/绝望/沉重独白句严禁切换为打招呼/惊讶/生气等与情绪脱节的动作；
  // 听者或非疑问的沉重悲伤句禁用卖萌歪头，但说话者轻声反问或温柔叹息（relief，非极端绝望）自然放行
  const isQuestionLine = /[？?]|难道|为什么|怎么|吗/.test(text)
  const isAcuteDespair = /(?:窒息|受不了|绝望|崩溃|再见|别走)/.test(text)
  if ((isSadOrDespair || monologue) && !isGenuineShock) {
    if (/greeting|shakehand|handshake|wave|surprise|shock|angry|disgust/.test(lower)) {
      return false
    }
    if (/relief/.test(lower) && isAcuteDespair) {
      return false
    }
    if (/tilthead|tilt/.test(lower) && (params.isListener || !isQuestionLine || isAcuteDespair)) {
      return false
    }
  }
  if (
    mood === 'angry' &&
    /tilthead|tilt|greeting|shakehand|handshake|wave|blushed|fidget|shy|armescape/.test(lower)
  ) {
    return false
  }
  return true
}

function ensureRealCatalogAnimation(
  view: CatalogView,
  modelId: number,
  field: 'motion' | 'facial',
  candidate: string
): string {
  const clean = candidate.trim()
  if (!clean) return ''
  const choices = view.animationChoices(modelId, field)
  if (choices.size === 0) return clean
  return view.canonicalAnimation(modelId, field, clean) ?? ''
}

function pickCompatibleMotionFallback(
  view: CatalogView,
  modelId: number,
  mood: facialSemanticsMod.TargetMood,
  restrainedRole: boolean,
  avoidMotion?: string
): string {
  const model = view.modelById(modelId)
  if (!model) return ''
  const promptSet = new Set(view.promptMotions(model))
  const rawPrompt = view.promptMotions(model).filter((m) => !isStandingMotion(m))
  const rawAll = (model.motions ?? []).filter((m) => !isStandingMotion(m) && !promptSet.has(m))
  // 先在精选词表内选，若缺失再扩展到该模型真实全量 motions（防止模型缺少 w-normal-sad01 时回退失败）
  const sortNormalFirst = (arr: string[]): string[] => [
    ...arr.filter((m) => /^w-normal/i.test(m)),
    ...arr.filter((m) => !/^w-normal/i.test(m))
  ]
  const candidates = [...sortNormalFirst(rawPrompt), ...sortNormalFirst(rawAll)]
  const isTenseMood = mood === 'sad' || mood === 'angry' || mood === 'trouble'
  const safeFilter = (m: string): boolean => {
    if (facialSemanticsMod.inspectModelMotion(model.path, m).contextTag) return false
    if (/greeting|shakehand|handshake|wave|byebye|salute|plan/i.test(m)) return false
    if (
      isTenseMood &&
      /glad|happy|cheer|joy|wink|smug|doya|playful|blushed|fidget|armescape/i.test(m)
    ) {
      return false
    }
    if (mood === 'neutral' && /blushed|fidget|armescape|angry|disgust/i.test(m)) {
      return false
    }
    return true
  }
  const filteredCandidates = candidates.filter(safeFilter)
  const pool = filteredCandidates.length > 0 ? filteredCandidates : candidates
  if (pool.length === 0) {
    return ensureRealCatalogAnimation(view, modelId, 'motion', view.defaultMotion(modelId))
  }
  if (typeof facialValidationApi.pickMoodMatchedMotion === 'function') {
    const picked = facialValidationApi.pickMoodMatchedMotion(
      pool,
      mood,
      model.path,
      restrainedRole,
      avoidMotion ? [avoidMotion] : undefined
    )
    const verified = ensureRealCatalogAnimation(view, modelId, 'motion', picked)
    if (verified) return verified
  }
  const hintsByMood: Record<facialSemanticsMod.TargetMood, RegExp[]> = {
    sad: [/sad|cry|sigh|lookdown/i, /trouble|think|shakehead/i],
    trouble: [/trouble|think|sigh|lookaway/i, /nod/i],
    angry: [/angry|disgust|shakehead/i, /forward|serious/i],
    surprise: [/surprise|tilthead|forward/i, /nod/i],
    shy: [/shy|blush|fidget|lookaway/i, /tilthead/i],
    smile: [/glad|happy|cheer|joy|relief/i, /nod|tilthead|playful/i],
    gentle: [/relief|nod|tilthead|soft/i, /glad/i],
    wry_smile: [/trouble|relief|sigh/i, /nod|shy/i],
    serious: [/forward|think|shakehead|nod/i, /serious|trouble/i],
    thinking: [/think|lookaway|trouble/i, /nod|sigh/i],
    neutral: [/nod|tilthead|think|forward|relief/i]
  }
  const tiers = hintsByMood[mood] ?? hintsByMood.neutral
  for (const hint of tiers) {
    const match = pool.find((m) => m !== avoidMotion && hint.test(m))
    const verified = match ? ensureRealCatalogAnimation(view, modelId, 'motion', match) : ''
    if (verified) return verified
  }
  for (const hint of tiers) {
    const match = pool.find((m) => hint.test(m))
    const verified = match ? ensureRealCatalogAnimation(view, modelId, 'motion', match) : ''
    if (verified) return verified
  }
  const safeFinal =
    pool.find(
      (m) =>
        m !== avoidMotion &&
        !facialSemanticsMod.inspectModelMotion(model.path, m).contextTag &&
        !/glad|happy|cheer|joy|angry|sad|cry|greeting|shakehand|handshake|wave|plan|blushed|fidget|armescape|tilthead|delicious|eat|drink|sleep|yawn|sing|mic/i.test(
          m
        )
    ) ?? pool[0]
  return safeFinal ? ensureRealCatalogAnimation(view, modelId, 'motion', safeFinal) : ''
}

function pickCompatibleFacialFallback(
  view: CatalogView,
  modelId: number,
  content: string,
  emotion: string,
  prevTense: boolean,
  restrainedRole: boolean,
  options: { isMonologue?: boolean; isListener?: boolean; avoidFacial?: string } = {}
): string {
  const model = view.modelById(modelId)
  if (!model)
    return ensureRealCatalogAnimation(view, modelId, 'facial', view.neutralFacial(modelId))
  const promptSet = new Set(view.promptFacials(model))
  const facials = [
    ...view.promptFacials(model),
    ...(model.facials ?? []).filter((f) => !promptSet.has(f))
  ]
  const mood = inferValidationMood(content, emotion)
  const targetMood: facialSemanticsMod.TargetMood =
    options.isListener && prevTense
      ? 'serious'
      : prevTense && mood === 'smile' && !facialSemanticsMod.isGenuineHappyOrReconciliation(content)
        ? 'wry_smile'
        : mood
  const picked = facialSemanticsMod.pickMoodMatchedFacial(
    facials,
    targetMood,
    model.path,
    restrainedRole
  )
  const verifiedPicked = ensureRealCatalogAnimation(view, modelId, 'facial', picked)
  if (
    verifiedPicked &&
    verifiedPicked !== options.avoidFacial &&
    isFacialStrictlyCompatible({
      facial: verifiedPicked,
      modelPath: model.path,
      emotion,
      content,
      prevTense,
      isMonologue: options.isMonologue,
      isListener: options.isListener,
      restrainedRole
    })
  ) {
    return verifiedPicked
  }
  const compatCandidate = facials.find(
    (f) =>
      f !== options.avoidFacial &&
      isFacialStrictlyCompatible({
        facial: f,
        modelPath: model.path,
        emotion,
        content,
        prevTense,
        isMonologue: options.isMonologue,
        isListener: options.isListener,
        restrainedRole
      })
  )
  if (compatCandidate) {
    const verified = ensureRealCatalogAnimation(view, modelId, 'facial', compatCandidate)
    if (verified) return verified
  }
  const neutral = facialSemanticsMod.pickNeutralFacial(
    facials,
    model.defaultFacial,
    model.path,
    restrainedRole
  )
  return ensureRealCatalogAnimation(view, modelId, 'facial', neutral)
}

function isSceneCutSnippet(snippet: JsonRecord): boolean {
  const kind = toStr(snippet.type)
  const data = isRecord(snippet.data) ? snippet.data : undefined
  return (
    kind === 'BlackOut' ||
    kind === 'SekaiOut' ||
    (kind === 'SideFade' && toStr(data?.mode, 'Out').toLowerCase() === 'out') ||
    kind === 'ChangeBackgroundImage'
  )
}

function isCheerfulComedySnippetContext(snippets: JsonRecord[], snippetIndex: number): boolean {
  let sceneStart = snippetIndex
  while (sceneStart > 0 && !isSceneCutSnippet(snippets[sceneStart - 1])) {
    sceneStart -= 1
  }
  let sceneEnd = snippetIndex
  while (sceneEnd + 1 < snippets.length && !isSceneCutSnippet(snippets[sceneEnd + 1])) {
    sceneEnd += 1
  }
  const talks: Array<{ content: string; emotion: string }> = []
  let targetTalkIdx = -1
  let lastTalkBeforeOrAt = -1
  for (let idx = sceneStart; idx <= sceneEnd; idx++) {
    const s = snippets[idx]
    if (!isRecord(s) || s.type !== 'Talk' || !isRecord(s.data)) continue
    const talkIdx = talks.length
    talks.push({ content: toStr(s.data.content), emotion: toStr(s.data.emotion) })
    if (idx === snippetIndex) targetTalkIdx = talkIdx
    if (idx <= snippetIndex) lastTalkBeforeOrAt = talkIdx
  }
  if (talks.length === 0) return false
  const probeIdx = targetTalkIdx >= 0 ? targetTalkIdx : Math.max(0, lastTalkBeforeOrAt)
  return facialSemanticsMod.isCheerfulComedyContext(talks, probeIdx)
}

function repairActingMismatches(
  story: JsonRecord,
  view: CatalogView,
  warn: (message: string) => void
): void {
  const snippets = Array.isArray(story.snippets) ? (story.snippets as JsonRecord[]) : []
  const tenseTracker: facialSemanticsMod.SceneTenseTracker = { tense: false, calmRun: 0 }
  const actorState = new Map<number, facialSemanticsMod.ActorTenseState>()
  let prevContent = ''
  let prevEmotion = ''

  const updateActorState = (
    modelId: number,
    modelPath: string | undefined,
    facial: string,
    emotion?: string,
    content?: string,
    cheerfulScene = false
  ): void => {
    if (modelId === -1) return
    const emo = (emotion ?? '').trim()
    if (content !== undefined && facialSemanticsMod.isCalmReassureResolution(content, emo)) {
      actorState.set(modelId, null)
      return
    }
    if (cheerfulScene && emo === '开心') {
      actorState.set(modelId, null)
      return
    }
    if (emo === '生气') {
      actorState.set(modelId, cheerfulScene ? null : 'angry')
      return
    }
    if (emo === '伤心' || emo === '害怕') {
      const role = facial ? facialSemanticsMod.inspectModelFacial(modelPath, facial).role : 'other'
      actorState.set(modelId, role === 'cry' || role === 'tearful_smile' ? 'cry' : 'sad')
      return
    }
    if (!facial) return
    const role = facialSemanticsMod.inspectModelFacial(modelPath, facial).role
    const derived = facialSemanticsMod.facialRoleToTenseState(role)
    if (derived) {
      actorState.set(modelId, derived)
    } else if (role === 'genuine_smile' || role === 'closed_smile' || role === 'playful') {
      actorState.set(modelId, null)
    }
  }

  const findNextTalkForActor = (
    startIndex: number,
    modelId: number
  ): { content: string; emotion: string } | null => {
    for (let j = startIndex + 1; j < Math.min(snippets.length, startIndex + 10); j++) {
      const s = snippets[j]
      if (!isRecord(s) || s.type !== 'Talk' || !isRecord(s.data)) continue
      if (toNumber(s.data.modelId, -1) === modelId) {
        return { content: toStr(s.data.content), emotion: toStr(s.data.emotion) }
      }
    }
    return null
  }

  const findNearestSurroundingTalk = (
    index: number,
    modelId: number
  ): { content: string; emotion: string } | null => {
    // 优先看紧邻前 3 条内的同角色或场景台词（如独白结束后的 Move），再看后续台词
    for (let j = index - 1; j >= Math.max(0, index - 3); j--) {
      const s = snippets[j]
      if (!isRecord(s) || s.type !== 'Talk' || !isRecord(s.data)) continue
      if (toNumber(s.data.modelId, -1) === modelId) {
        return { content: toStr(s.data.content), emotion: toStr(s.data.emotion) }
      }
    }
    for (let j = index - 1; j >= Math.max(0, index - 3); j--) {
      const s = snippets[j]
      if (!isRecord(s) || s.type !== 'Talk' || !isRecord(s.data)) continue
      return { content: toStr(s.data.content), emotion: toStr(s.data.emotion) }
    }
    const nextOwn = findNextTalkForActor(index, modelId)
    if (nextOwn) return nextOwn
    for (let j = index + 1; j < Math.min(snippets.length, index + 6); j++) {
      const s = snippets[j]
      if (!isRecord(s) || s.type !== 'Talk' || !isRecord(s.data)) continue
      return { content: toStr(s.data.content), emotion: toStr(s.data.emotion) }
    }
    return null
  }

  for (let i = 0; i < snippets.length; i++) {
    const snippet = snippets[i]
    if (!isRecord(snippet) || !isRecord(snippet.data)) continue
    const kind = toStr(snippet.type)
    const data = snippet.data

    if (
      kind === 'BlackOut' ||
      kind === 'SekaiOut' ||
      (kind === 'SideFade' && toStr(data.mode, 'Out').toLowerCase() === 'out') ||
      kind === 'ChangeBackgroundImage'
    ) {
      tenseTracker.tense = false
      tenseTracker.calmRun = 0
      prevContent = ''
      prevEmotion = ''
      actorState.clear()
      continue
    }

    if (kind === 'LayoutAppear' || kind === 'Move') {
      const modelId = toNumber(data.modelId, -1)
      const model = view.modelById(modelId)
      if (!model) continue
      const contextTalk =
        kind === 'Move'
          ? findNearestSurroundingTalk(i, modelId)
          : (findNextTalkForActor(i, modelId) ?? findNearestSurroundingTalk(i, modelId))
      if (!contextTalk) {
        updateActorState(modelId, model.path, toStr(data.facial))
        continue
      }
      const restrained = isRestrainedActor(model.name, model.path)
      const facial = toStr(data.facial)
      if (
        facial &&
        !isFacialStrictlyCompatible({
          facial,
          modelPath: model.path,
          emotion: contextTalk.emotion,
          content: contextTalk.content,
          prevTense: tenseTracker.tense,
          isMonologue: isInnerMonologueText(contextTalk.content),
          restrainedRole: restrained
        })
      ) {
        const replacement = pickCompatibleFacialFallback(
          view,
          modelId,
          contextTalk.content,
          contextTalk.emotion,
          tenseTracker.tense,
          restrained,
          { isMonologue: isInnerMonologueText(contextTalk.content), avoidFacial: facial }
        )
        if (replacement && replacement !== facial) {
          data.facial = replacement
          warn(
            `snippets[${i}] ${kind} facial '${facial}' 与周边剧情情绪冲突，已改为 ${replacement}`
          )
        }
      }
      const motion = toStr(data.motion)
      if (
        motion &&
        !isMotionMoodCompatible({
          motion,
          modelPath: model.path,
          emotion: contextTalk.emotion,
          content: contextTalk.content,
          prevTense: tenseTracker.tense,
          restrainedRole: restrained
        })
      ) {
        const mood = inferValidationMood(contextTalk.content, contextTalk.emotion)
        const replacement = pickCompatibleMotionFallback(view, modelId, mood, restrained, motion)
        data.motion = replacement && replacement !== motion ? replacement : ''
        warn(
          `snippets[${i}] ${kind} motion '${motion}' 与周边剧情情绪冲突，已${data.motion ? `改为 ${toStr(data.motion)}` : '清除'}`
        )
      }
      updateActorState(modelId, model.path, toStr(data.facial))
      continue
    }

    if (kind === 'Motion') {
      const mid = toNumber(data.modelId, -1)
      const checkMotionTarget = (targetObj: JsonRecord, actorId: number): void => {
        const actorModel = view.modelById(actorId)
        if (!actorModel) return
        const contextTalk = findNearestSurroundingTalk(i, actorId)
        const restrained = isRestrainedActor(actorModel.name, actorModel.path)
        const mot = toStr(targetObj.motion)
        if (
          mot &&
          contextTalk &&
          !isMotionMoodCompatible({
            motion: mot,
            modelPath: actorModel.path,
            emotion: contextTalk.emotion,
            content: contextTalk.content,
            prevTense: tenseTracker.tense,
            restrainedRole: restrained
          })
        ) {
          const mood = inferValidationMood(contextTalk.content, contextTalk.emotion)
          const replacement = pickCompatibleMotionFallback(view, actorId, mood, restrained, mot)
          if (replacement && replacement !== mot) {
            targetObj.motion = replacement
          } else if (targetObj === data) {
            targetObj.motion = ''
          } else {
            delete targetObj.motion
          }
          warn(`snippets[${i}] Motion '${mot}' 与周边语境不匹配，已修正`)
        }
        updateActorState(actorId, actorModel.path, toStr(targetObj.facial))
      }
      checkMotionTarget(data, mid)
      if (Array.isArray(data.actions)) {
        for (const act of data.actions) {
          if (!isRecord(act)) continue
          checkMotionTarget(act, toNumber(act.modelId, mid))
        }
      }
      continue
    }

    if (kind !== 'Talk') continue
    const speakerId = toNumber(data.modelId, -1)
    const content = toStr(data.content)
    const emotion = toStr(data.emotion)
    const monologue = isInnerMonologueText(content)
    const cheerfulScene = isCheerfulComedySnippetContext(snippets, i)
    const effectivePrevTense = tenseTracker.tense && !cheerfulScene
    if (speakerId === -1) {
      facialSemanticsMod.updateSceneTenseAfterTalk(tenseTracker, content, emotion, {
        cheerfulScene
      })
      continue
    }

    const fixActorActing = (targetObj: JsonRecord, actorId: number, isListener: boolean): void => {
      const actorModel = view.modelById(actorId)
      if (!actorModel) return
      const restrained = isRestrainedActor(actorModel.name, actorModel.path)
      const facial = toStr(targetObj.facial)

      if (isListener && facial) {
        const lState = actorState.get(actorId) ?? null
        const isLockedTense =
          !cheerfulScene &&
          (lState === 'angry' ||
            lState === 'sad' ||
            lState === 'cry' ||
            lState === 'serious' ||
            (lState === 'trouble' && effectivePrevTense))
        if (
          isLockedTense &&
          lState &&
          (facialSemanticsMod.isPositiveOnlyFacial(facial, actorModel.path) ||
            (lState === 'angry' && facialSemanticsMod.isSmileLikeFacial(facial, actorModel.path)))
        ) {
          const promptSet = new Set(view.promptFacials(actorModel))
          const facialPool = [
            ...view.promptFacials(actorModel),
            ...(actorModel.facials ?? []).filter((f) => !promptSet.has(f))
          ]
          const picked = ensureRealCatalogAnimation(
            view,
            actorId,
            'facial',
            facialSemanticsMod.pickListenerFallbackFacial(
              facialPool,
              lState,
              actorModel.path,
              restrained
            )
          )
          if (picked && picked !== facial) {
            targetObj.facial = picked
            warn(
              `snippets[${i}] 听者前序处于 ${lState} 状态且未和好，facial '${facial}' 已改为 ${picked}`
            )
          }
        }
      }

      const curFacial = toStr(targetObj.facial)
      if (curFacial) {
        const ok = isFacialStrictlyCompatible({
          facial: curFacial,
          modelPath: actorModel.path,
          emotion,
          content,
          prevTense: effectivePrevTense,
          isMonologue: !isListener && monologue,
          isListener,
          restrainedRole: restrained,
          cheerfulScene
        })
        if (!ok) {
          const replacement = pickCompatibleFacialFallback(
            view,
            actorId,
            content,
            emotion,
            effectivePrevTense,
            restrained,
            { isMonologue: !isListener && monologue, isListener, avoidFacial: curFacial }
          )
          if (replacement && replacement !== curFacial) {
            targetObj.facial = replacement
            warn(
              `snippets[${i}] ${isListener ? '听者' : '说话者'} facial '${curFacial}' 与当前台词情绪冲突，已改为 ${replacement}`
            )
          }
        }
      }
      const motion = toStr(targetObj.motion)
      if (
        motion &&
        !isMotionMoodCompatible({
          motion,
          modelPath: actorModel.path,
          emotion,
          content,
          prevContent,
          prevEmotion,
          prevTense: effectivePrevTense,
          isListener,
          restrainedRole: restrained,
          cheerfulScene
        })
      ) {
        const mood = inferValidationMood(content, emotion)
        const promptSetM = new Set(view.promptMotions(actorModel))
        const fullMotions = [
          ...view.promptMotions(actorModel),
          ...(actorModel.motions ?? []).filter((m) => !promptSetM.has(m))
        ].filter(
          (m) =>
            m !== motion &&
            !facialSemanticsMod.isSpecialOrStandingMotion(m) &&
            isMotionMoodCompatible({
              motion: m,
              modelPath: actorModel.path,
              emotion,
              content,
              prevContent,
              prevEmotion,
              prevTense: effectivePrevTense,
              isListener,
              restrainedRole: restrained,
              cheerfulScene
            })
        )
        const recMot =
          fullMotions.length > 0
            ? ensureRealCatalogAnimation(
                view,
                actorId,
                'motion',
                facialSemanticsMod.pickMoodMatchedMotion(
                  fullMotions,
                  mood,
                  actorModel.path,
                  restrained,
                  [motion]
                )
              )
            : ''
        const candidateRep =
          recMot || pickCompatibleMotionFallback(view, actorId, mood, restrained, motion)
        const replacement =
          candidateRep &&
          isMotionMoodCompatible({
            motion: candidateRep,
            modelPath: actorModel.path,
            emotion,
            content,
            prevContent,
            prevEmotion,
            prevTense: effectivePrevTense,
            isListener,
            restrainedRole: restrained,
            cheerfulScene
          })
            ? candidateRep
            : ''
        if (replacement && replacement !== motion) {
          targetObj.motion = replacement
          warn(
            `snippets[${i}] ${isListener ? '听者' : '说话者'} motion '${motion}' 与当前台词情绪冲突，已改为 ${replacement}`
          )
        } else {
          delete targetObj.motion
          warn(
            `snippets[${i}] ${isListener ? '听者' : '说话者'} motion '${motion}' 与当前台词情绪冲突，无贴合替代动作已清除`
          )
        }
      }
    }

    fixActorActing(data, speakerId, false)
    if (Array.isArray(data.actions)) {
      for (const act of data.actions) {
        if (!isRecord(act)) continue
        const aid = toNumber(act.modelId, speakerId)
        fixActorActing(act, aid, aid !== speakerId)
      }
    }

    const speakerModel = view.modelById(speakerId)
    let speakerFacial = toStr(data.facial)
    if (Array.isArray(data.actions)) {
      for (const act of data.actions) {
        if (isRecord(act) && toNumber(act.modelId, speakerId) === speakerId && toStr(act.facial)) {
          speakerFacial = toStr(act.facial)
          break
        }
      }
    }
    updateActorState(speakerId, speakerModel?.path, speakerFacial, emotion, content, cheerfulScene)
    if (Array.isArray(data.actions)) {
      for (const act of data.actions) {
        if (!isRecord(act)) continue
        const aid = toNumber(act.modelId, speakerId)
        if (aid !== speakerId && toStr(act.facial)) {
          updateActorState(
            aid,
            view.modelById(aid)?.path,
            toStr(act.facial),
            undefined,
            undefined,
            cheerfulScene
          )
        }
      }
    }
    prevContent = content
    prevEmotion = emotion
    facialSemanticsMod.updateSceneTenseAfterTalk(tenseTracker, content, emotion, { cheerfulScene })
  }
}

/**
 * 确定性听者响应补全（对齐官方 event_145_08 演出节奏）：
 * - 跳过内心独白（旁人无法听见说话者的心里话）；
 * - 仅当在场听者连续 >=4 句（高张力台词 >=3 句）未获任何更新时，
 *   在 Talk.data.actions 句首（at: 0）注入轻柔的**纯表情**（facial-only，不含 body motion）变化；
 * - 绝不向台词中途（at: 0.45..0.85）批量塞入错峰身体动作，避免突兀弹跳与错峰干扰。
 */
export function ensureListenerReactivity(
  story: JsonRecord,
  view: CatalogView,
  warn: (message: string) => void
): void {
  const snippets = Array.isArray(story.snippets) ? (story.snippets as JsonRecord[]) : []
  const onStage = new Set<number>()
  const idleTalks = new Map<number, number>()
  const justAppeared = new Set<number>()
  const lastListenerFacial = new Map<number, string>()

  let prevContent = ''
  let prevEmotion = ''
  const tenseTracker: facialSemanticsMod.SceneTenseTracker = { tense: false, calmRun: 0 }
  let injectedCount = 0

  for (let snippetIdx = 0; snippetIdx < snippets.length; snippetIdx++) {
    const snippet = snippets[snippetIdx]
    if (!isRecord(snippet) || !isRecord(snippet.data)) continue
    const kind = toStr(snippet.type)
    const data = snippet.data

    if (
      kind === 'BlackOut' ||
      kind === 'SekaiOut' ||
      (kind === 'SideFade' && toStr(data.mode, 'Out').toLowerCase() === 'out') ||
      kind === 'ChangeBackgroundImage'
    ) {
      tenseTracker.tense = false
      tenseTracker.calmRun = 0
      continue
    }

    if (kind === 'LayoutAppear') {
      const mid = toNumber(data.modelId, -1)
      if (mid !== -1) {
        onStage.add(mid)
        idleTalks.set(mid, 0)
        justAppeared.add(mid)
        const f = toStr(data.facial)
        if (f) lastListenerFacial.set(mid, f)
      }
      continue
    }
    if (kind === 'LayoutClear') {
      const mid = toNumber(data.modelId, -1)
      onStage.delete(mid)
      idleTalks.delete(mid)
      justAppeared.delete(mid)
      continue
    }
    if (kind === 'Move' || kind === 'Motion') {
      const mid = toNumber(data.modelId, -1)
      if (mid !== -1 && onStage.has(mid)) {
        idleTalks.set(mid, 0)
        justAppeared.delete(mid)
        const f = toStr(data.facial)
        if (f) lastListenerFacial.set(mid, f)
      }
      continue
    }
    if (kind !== 'Talk') continue

    const speakerId = toNumber(data.modelId, -1)
    const content = toStr(data.content)
    const emotion = toStr(data.emotion)
    if (speakerId === -1 || isInnerMonologueText(content)) {
      prevContent = content
      prevEmotion = emotion
      continue
    }

    const actions: JsonRecord[] = Array.isArray(data.actions)
      ? (data.actions as JsonRecord[]).filter((a): a is JsonRecord => isRecord(a))
      : []

    const activeInThisTalk = new Set<number>([speakerId])
    for (const act of actions) {
      const aid = toNumber(act.modelId, speakerId)
      activeInThisTalk.add(aid)
      if (aid !== speakerId) {
        idleTalks.set(aid, 0)
        if (toStr(act.facial)) lastListenerFacial.set(aid, toStr(act.facial))
      }
    }

    const isHighIntensity =
      ['生气', '伤心', '惊讶', '害怕'].includes(emotion) &&
      /[！!]{1,2}|！？|\?!|对不起|再见|别走|窒息|受不了|讨厌|为什么/.test(content)

    let addedListenerOnThisTalk = actions.some((a) => toNumber(a.modelId, speakerId) !== speakerId)

    for (const listenerId of onStage) {
      if (listenerId === speakerId) continue
      if (activeInThisTalk.has(listenerId)) continue

      const nextIdle = (idleTalks.get(listenerId) ?? 0) + 1
      const freshlyAppeared = justAppeared.has(listenerId)
      const shouldReact =
        !addedListenerOnThisTalk &&
        (nextIdle >= 4 || (isHighIntensity && nextIdle >= 3 && !freshlyAppeared))

      if (!shouldReact) {
        idleTalks.set(listenerId, nextIdle)
        continue
      }

      const listenerModel = view.modelById(listenerId)
      if (!listenerModel) {
        idleTalks.set(listenerId, nextIdle)
        continue
      }

      // 若听者当前已持续挂着 cry 哭泣表情，允许自然延续更长时间，避免机械切回 closeeye 破坏持续哭戏
      const currentLF = lastListenerFacial.get(listenerId) ?? ''
      const currentLFRole = currentLF
        ? facialSemanticsMod.inspectModelFacial(listenerModel.path, currentLF).role
        : 'other'
      if ((emotion === '伤心' || tenseTracker.tense) && currentLFRole === 'cry' && nextIdle < 6) {
        idleTalks.set(listenerId, nextIdle)
        continue
      }

      const restrained = isRestrainedActor(listenerModel.name, listenerModel.path)
      let pickedFacial = ''

      const listenerFacialPool = [
        ...view.promptFacials(listenerModel),
        ...(listenerModel.facials ?? []).filter(
          (f) => !view.promptFacials(listenerModel).includes(f)
        )
      ]
      if (typeof facialValidationApi.recommendActingForLine === 'function') {
        const rec = facialValidationApi.recommendActingForLine({
          facials: listenerFacialPool,
          motions: view.promptMotions(listenerModel),
          modelPath: listenerModel.path,
          content,
          emotion,
          prevContent,
          prevEmotion,
          prevTense: tenseTracker.tense,
          isListener: true,
          restrainedRole: restrained,
          prevFacial: lastListenerFacial.get(listenerId),
          limit: 4
        })
        pickedFacial =
          rec.facials.find((f) =>
            isFacialStrictlyCompatible({
              facial: f,
              modelPath: listenerModel.path,
              emotion,
              content,
              prevTense: tenseTracker.tense,
              isListener: true,
              restrainedRole: restrained
            })
          ) ?? ''
      }

      if (!pickedFacial) {
        const listenerMood =
          emotion === '生气' || emotion === '伤心' || emotion === '害怕'
            ? '伤心'
            : emotion === '惊讶'
              ? '惊讶'
              : emotion
        pickedFacial = pickCompatibleFacialFallback(
          view,
          listenerId,
          content,
          listenerMood,
          tenseTracker.tense,
          restrained,
          { isListener: true, avoidFacial: lastListenerFacial.get(listenerId) }
        )
      }

      if (pickedFacial) {
        const listenerAct: JsonRecord = {
          at: 0,
          modelId: listenerId,
          facial: pickedFacial
        }
        actions.push(listenerAct)
        actions.sort((a, b) => toNumber(a.at) - toNumber(b.at))
        data.actions = actions
        idleTalks.set(listenerId, 0)
        lastListenerFacial.set(listenerId, pickedFacial)
        addedListenerOnThisTalk = true
        injectedCount += 1
      } else {
        idleTalks.set(listenerId, nextIdle)
      }
    }

    idleTalks.set(speakerId, 0)
    justAppeared.clear()
    prevContent = content
    prevEmotion = emotion
    facialSemanticsMod.updateSceneTenseAfterTalk(tenseTracker, content, emotion, {
      cheerfulScene: isCheerfulComedySnippetContext(snippets, snippetIdx)
    })
  }

  if (injectedCount > 0) {
    warn(`已为在场听者自动补充 ${injectedCount} 处句首(at: 0)纯微表情倾听反应，避免角色长时间静止`)
  }
}

const CJK_SLASH_LEAK_LEFT = String.raw`[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff，。！？…—～♪、）】」』”’]`
const CJK_SLASH_LEAK_RIGHT = String.raw`[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff（【「『“‘…—]`
const CJK_PUNCT_SLASH_LEAK_LEFT = String.raw`[，。！？…—、）】」』”’]`

// 匹配被 CJK 文本/标点包裹的带空格斜杠（如 `一聊起画画， / 绘名名`、`嗯。 ／ 走吧`）
const CJK_SPACED_SLASH_BREAK_RE = new RegExp(
  `(${CJK_SLASH_LEAK_LEFT})[ \\t\\u3000]+[\\/／][ \\t\\u3000]+(?=${CJK_SLASH_LEAK_RIGHT})`,
  'g'
)

// 匹配紧跟在 CJK 句读标点后的全角斜杠或单侧带空格斜杠（如 `画画，／绘名名`、`画画， /绘名名`）
const CJK_PUNCT_SLASH_BREAK_RE = new RegExp(
  `(${CJK_PUNCT_SLASH_LEAK_LEFT})(?:[ \\t\\u3000]*／[ \\t\\u3000]*|[ \\t\\u3000]+\\/[ \\t\\u3000]*|[ \\t\\u3000]*\\/[ \\t\\u3000]+)(?=${CJK_SLASH_LEAK_RIGHT})`,
  'g'
)

/**
 * 规范化台词/字幕换行：
 * 1. 将字面量 `\n` / `\r\n` 与 CRLF 统一还原为真实换行 `\n`；
 * 2. 兜底清理 LLM 从提示词里抄漏的中文/日文换行斜杠（如 `一聊起画画， / 绘名名`、`嗯。 ／ 走吧`），
 *    同时严格保留合法的非空格斜杠（如 `Leo/need`、`24/7`、`1/2`、`A/B`、`https://...`、`cloud/bg_...`）。
 */
export function normalizeDialogueLineBreaks(raw: string): string {
  if (!raw) return ''
  return raw
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r\n?/g, '\n')
    .replace(CJK_SPACED_SLASH_BREAK_RE, '$1\n')
    .replace(CJK_PUNCT_SLASH_BREAK_RE, '$1\n')
}

/** 字符显示宽度：CJK/全角记 1，ASCII 记 0.5。 */
export function charWidthUnits(char: string): number {
  return char.codePointAt(0)! >= 0x2e80 ? 1 : 0.5
}

/**
 * 清洗台词/字幕：统一换行、折叠连续空白、按 30 字宽硬折行。
 * 只排版不删台词；超行由 splitOverflowTalks 拆条。
 */
export function sanitizeDisplayText(text: unknown, wrap = true): string {
  if (typeof text !== 'string') return ''
  const cleaned = normalizeDialogueLineBreaks(stripZeroWidth(text))
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
  if (!cleaned) return ''
  if (!wrap) {
    return cleaned
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n')
  }
  const lines: string[] = []
  const breakAfter = /[。！？!?…、，,.\s」』）)]/
  for (const rawSegment of cleaned.split('\n')) {
    const segment = rawSegment.trim()
    if (!segment) continue
    let current: string[] = []
    let width = 0
    const flush = (): void => {
      if (current.length > 0) lines.push(current.join(''))
      current = []
      width = 0
    }
    for (const char of segment) {
      const charWidth = charWidthUnits(char)
      if (current.length > 0 && width + charWidth > TALK_LINE_WIDTH_UNITS) {
        // 优先在上一个标点/空格后折行，避免把中文词或语气词拦腰截断；
        // 找不到合适的断点时才按宽度硬折。
        let breakAt = -1
        for (let index = current.length - 1; index > 0; index--) {
          if (breakAfter.test(current[index])) {
            breakAt = index
            break
          }
        }
        if (breakAt > 0 && breakAt < current.length - 1) {
          const head = current.slice(0, breakAt + 1)
          const tail = current.slice(breakAt + 1)
          lines.push(head.join(''))
          current = tail
          width = tail.reduce((sum, item) => sum + charWidthUnits(item), 0)
        } else {
          flush()
        }
      }
      current.push(char)
      width += charWidth
    }
    flush()
  }
  return lines.join('\n')
}

function distributeTextParts(
  parts: string[],
  groupCount: number,
  weights?: number[],
  joiner = ''
): string[] {
  if (!weights || weights.length !== groupCount) {
    const base = Math.floor(parts.length / groupCount)
    const extra = parts.length % groupCount
    const buckets: string[] = []
    let index = 0
    for (let i = 0; i < groupCount; i++) {
      const take = base + (i < extra ? 1 : 0)
      buckets.push(
        parts
          .slice(index, index + take)
          .join(joiner)
          .trim()
      )
      index += take
    }
    return buckets
  }

  const totalWeight = weights.reduce((sum, w) => sum + Math.max(1, w), 0)
  const partLengths = parts.map((p) => Math.max(1, Array.from(p).length))
  const totalPartChars = partLengths.reduce((sum, len) => sum + len, 0)

  const buckets: string[] = []
  let cursor = 0
  let consumedWeight = 0
  let consumedChars = 0

  for (let i = 0; i < groupCount; i++) {
    if (i === groupCount - 1) {
      buckets.push(parts.slice(cursor).join(joiner).trim())
      break
    }
    consumedWeight += Math.max(1, weights[i])
    const targetChars = (consumedWeight / totalWeight) * totalPartChars
    const maxEnd = parts.length - (groupCount - 1 - i)
    let end = cursor + 1
    consumedChars += partLengths[cursor] ?? 0
    while (end < maxEnd) {
      const nextLen = partLengths[end] ?? 0
      const distBefore = Math.abs(consumedChars - targetChars)
      const distAfter = Math.abs(consumedChars + nextLen - targetChars)
      if (distAfter <= distBefore) {
        consumedChars += nextLen
        end += 1
      } else {
        break
      }
    }
    buckets.push(parts.slice(cursor, end).join(joiner).trim())
    cursor = end
  }
  return buckets
}

function segmentGraphemes(text: string): string[] {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' })
    return Array.from(segmenter.segment(text), (item) => item.segment)
  }
  return Array.from(text)
}

function splitTtsText(tts: string, groupCount: number, weights?: number[]): string[] {
  const clean = tts.trim()
  if (!clean) return Array.from({ length: groupCount }, () => '')
  if (groupCount <= 1) return [clean]

  const lineParts = clean
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean)
  if (lineParts.length === groupCount) return lineParts

  const sentenceParts = clean
    .split(/(?<=[。！？!?.])\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (sentenceParts.length === groupCount) return sentenceParts
  if (sentenceParts.length > groupCount) {
    return distributeTextParts(sentenceParts, groupCount, weights)
  }
  if (lineParts.length >= groupCount) {
    return distributeTextParts(lineParts, groupCount, weights, '\n')
  }

  // 句子数少于拆分段数时，优先按日文/中文子句标点切分，再按字符权重切分，绝不清空 ttsText
  const clauseParts = clean
    .split(/(?<=[、，,;；。！？!?.…])\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (clauseParts.length >= groupCount) {
    return distributeTextParts(clauseParts, groupCount, weights)
  }

  const graphemes = segmentGraphemes(clean)
  const effectiveWeights =
    weights && weights.length === groupCount
      ? weights.map((w) => Math.max(1, w))
      : Array.from({ length: groupCount }, () => 1)
  const totalWeight = effectiveWeights.reduce((sum, w) => sum + w, 0)
  const buckets: string[] = []
  let cursor = 0
  let accWeight = 0

  for (let i = 0; i < groupCount; i++) {
    if (i === groupCount - 1) {
      buckets.push(graphemes.slice(cursor).join('').trim())
      break
    }
    accWeight += effectiveWeights[i]
    const targetEnd = Math.round((accWeight / totalWeight) * graphemes.length)
    const minEnd = graphemes.length >= groupCount ? cursor + 1 : cursor
    const maxEnd =
      graphemes.length >= groupCount
        ? Math.max(minEnd, graphemes.length - (groupCount - 1 - i))
        : graphemes.length
    const end = Math.min(maxEnd, Math.max(minEnd, targetEnd))
    buckets.push(graphemes.slice(cursor, end).join('').trim())
    cursor = end
  }
  return buckets
}

/** 把超过 3 行的 Talk 拆成同角色连续多条，台词一字不丢。 */
export function splitOverflowTalks(story: JsonRecord): JsonRecord {
  const snippets = story.snippets
  if (!Array.isArray(snippets)) return story

  const result: unknown[] = []
  for (const snippet of snippets) {
    if (!isRecord(snippet) || snippet.type !== 'Talk') {
      result.push(snippet)
      continue
    }
    const data = isRecord(snippet.data) ? snippet.data : {}
    const lines = toStr(data.content)
      .split('\n')
      .filter((line) => line.trim().length > 0)
    if (lines.length <= TALK_MAX_LINES) {
      result.push(snippet)
      continue
    }

    const groups: string[][] = []
    for (let index = 0; index < lines.length; index += TALK_MAX_LINES) {
      groups.push(lines.slice(index, index + TALK_MAX_LINES))
    }
    const weights = groups.map((group) =>
      Math.max(
        1,
        [...group.join('')].reduce((sum, char) => sum + charWidthUnits(char), 0)
      )
    )
    const ttsGroups = splitTtsText(toStr(data.ttsText), groups.length, weights)
    const total = weights.reduce((sum, value) => sum + value, 0)
    let start = 0
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const end = groupIndex < groups.length - 1 ? start + weights[groupIndex] / total : 1
      const partData: JsonRecord = {
        ...data,
        content: groups[groupIndex].join('\n'),
        ttsText: ttsGroups[groupIndex]
      }
      if (Array.isArray(data.actions)) {
        partData.actions = []
        for (const action of data.actions) {
          if (!isRecord(action)) continue
          const at = toNumber(action.at)
          if ((at >= start && at < end) || (groupIndex === groups.length - 1 && at === 1)) {
            ;(partData.actions as unknown[]).push({
              ...action,
              at: Math.min(1, Math.max(0, (at - start) / (end - start)))
            })
          }
        }
      }
      if (groupIndex > 0) {
        partData.motion = ''
        partData.facial = ''
      }
      if (groupIndex < groups.length - 1) {
        delete partData.closeWindowOnFinish
      }
      const nextSnippet: JsonRecord = {
        type: 'Talk',
        wait: Boolean(snippet.wait),
        delay: groupIndex === 0 ? toNumber(snippet.delay) : 0,
        data: partData
      }
      if (snippet.progressBehavior === 'Now' || snippet.progressBehavior === 'WaitFinished') {
        nextSnippet.progressBehavior = snippet.progressBehavior
      }
      result.push(nextSnippet)
      start = end
    }
  }
  story.snippets = result
  return story
}

function parsePosition(raw: unknown, fallbackSide: string): JsonRecord {
  const pos = isRecord(raw) ? raw : {}
  const side = VALID_SIDES.has(toStr(pos.side)) ? toStr(pos.side) : fallbackSide
  const under = toBool(pos.under, false)
  return {
    side,
    offset: toNumber(pos.offset, 0),
    ...(under ? { under: true } : {})
  }
}

function isOffscreenPosition(pos: JsonRecord): boolean {
  return OFFSCREEN_SIDES.has(toStr(pos.side)) || pos.under === true
}

function fixAnimation(
  view: CatalogView,
  modelId: number,
  field: 'motion' | 'facial',
  value: unknown
): string | null {
  const cleaned = cleanPath(value)
  if (!cleaned) return null
  const choices = view.animationChoices(modelId, field)
  if (choices.has(cleaned)) return cleaned
  return view.canonicalAnimation(modelId, field, cleaned)
}

function validateActions(
  data: JsonRecord,
  view: CatalogView,
  modelIds: Set<number>,
  label: string,
  speakerCap = 5
): void {
  if (!('actions' in data) || data.actions === undefined) return
  const actions = data.actions
  if (!Array.isArray(actions) || actions.length > 24) {
    throw new Error(`${label}.actions 必须是最多 24 项的数组`)
  }
  const normalized: JsonRecord[] = []
  for (const [index, action] of actions.entries()) {
    if (!isRecord(action)) throw new Error(`${label}.actions[${index}] 必须是对象`)
    const at = action.at
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0 || at > 1) {
      throw new Error(`${label}.actions[${index}].at 必须是 0..1 的有限数字`)
    }
    const modelId = action.modelId
    if (typeof modelId !== 'number' || !Number.isInteger(modelId) || !modelIds.has(modelId)) {
      throw new Error(`${label}.actions[${index}].modelId 必须是 models 中的角色整数 ID`)
    }
    const cleaned: JsonRecord = { at, modelId }
    for (const field of ['motion', 'facial'] as const) {
      if (!(field in action)) continue
      const fixed = fixAnimation(view, modelId, field, action[field])
      if (fixed) cleaned[field] = fixed
    }
    if (!cleaned.motion && !cleaned.facial) continue
    normalized.push(cleaned)
  }
  normalized.sort((a, b) => toNumber(a.at) - toNumber(b.at))

  const byModel = new Map<number, JsonRecord[]>()
  for (const action of normalized) {
    const modelId = action.modelId as number
    if (!byModel.has(modelId)) byModel.set(modelId, [])
    byModel.get(modelId)!.push(action)
  }
  const kept: JsonRecord[] = []
  const speakerId = data.modelId
  for (const [actorId, items] of byModel) {
    // 官方 TalkData.Motions 每句只有 0 或 1 条：Talk 说话者与听者各保留 1 个动作。
    // Motion 片段（静默动作序列）不属于 Talk，保留多拍。
    const cap = actorId === speakerId ? speakerCap : 1
    let lastAt: number | null = null
    let count = 0
    for (const action of items) {
      if (count >= cap) continue
      const at = toNumber(action.at)
      if (lastAt !== null && at - lastAt < 0.2 - 1e-9) continue
      kept.push(action)
      lastAt = at
      count += 1
    }
  }
  kept.sort((a, b) => toNumber(a.at) - toNumber(b.at))
  if (speakerCap === 1 && kept.length > 1) {
    // 禁止同一瞬间双人同时做身体动作（说话者优先）；纯表情听者反应（无 motion）允许在 at: 0 与说话者自然共存。
    const hasBodyMotion = (act: JsonRecord): boolean =>
      typeof act.motion === 'string' && act.motion.trim().length > 0
    const deduped: JsonRecord[] = []
    for (const action of kept) {
      const actionHasBody = hasBodyMotion(action)
      const conflictIdx = actionHasBody
        ? deduped.findIndex(
            (existing) =>
              hasBodyMotion(existing) &&
              Math.abs(toNumber(existing.at) - toNumber(action.at)) < 0.25 - 1e-9
          )
        : -1
      if (conflictIdx < 0) {
        deduped.push(action)
      } else if (action.modelId === speakerId && deduped[conflictIdx].modelId !== speakerId) {
        deduped[conflictIdx] = action
      }
    }
    data.actions = deduped.slice(0, 2)
    return
  }
  data.actions = kept
}

/**
 * 严格舞台校验：支持 Normal（<=2人，Left/Right 或单人 Center）与 Three（<=3人，Left/Center/Right）；
 * 不在场说话、重复入场、槽位冲突、4人以上同台都会抛错，由上层重写（不删角色或台词）。
 */
function normalizeScene(story: JsonRecord, warn?: (message: string) => void): void {
  const visible = new Map<number, JsonRecord>()
  const lastFacialByModel = new Map<number, string>()
  let thinkingReturnCast: Array<{ id: number; side: string; facial: string }> | null = null
  let layoutMode: 'Normal' | 'Three' = 'Normal'
  const rewrittenSnippets: JsonRecord[] = []
  let normalizedSlides = 0
  let convertedMoves = 0
  let normalizedThinkingCuts = 0

  const restoreDuoFromThinking = (): void => {
    if (!thinkingReturnCast || thinkingReturnCast.length < 2) {
      thinkingReturnCast = null
      return
    }
    if (visible.size === 1) {
      const [[soloId, soloPos]] = [...visible.entries()]
      const soloSide = toStr(soloPos.side, 'Center')
      rewrittenSnippets.push({
        type: 'LayoutClear',
        wait: true,
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: {
          modelId: soloId,
          from: { side: soloSide, offset: 0 },
          to: { side: soloSide, offset: 0 },
          motion: '',
          facial: '',
          moveSpeed: 'Normal'
        }
      })
      visible.delete(soloId)
    }
    thinkingReturnCast.forEach((actor, idx) => {
      if (visible.has(actor.id)) return
      const pos: JsonRecord = { side: actor.side, offset: 0 }
      const isFirst = idx === 0
      rewrittenSnippets.push({
        type: 'LayoutAppear',
        wait: isFirst,
        progressBehavior: isFirst ? 'WaitFinished' : 'Now',
        delay: 0,
        data: {
          modelId: actor.id,
          from: { side: actor.side, offset: 0 },
          to: { side: actor.side, offset: 0 },
          motion: '',
          facial: lastFacialByModel.get(actor.id) ?? actor.facial,
          facialFirst: true,
          moveSpeed: 'Normal',
          hologram: false
        }
      })
      visible.set(actor.id, pos)
    })
    thinkingReturnCast = null
  }

  const checkSlotAvailable = (
    targetSide: string,
    ignoreModelId: number | undefined,
    label: string
  ): void => {
    for (const [other, current] of visible) {
      if (other === ignoreModelId) continue
      const currentSide = toStr(current.side)
      if (currentSide === targetSide) {
        throw new Error(`${label} 槽位 ${targetSide} 已被占用`)
      }
      if (layoutMode === 'Normal' && (currentSide === 'Center' || targetSide === 'Center')) {
        throw new Error(`${label} Normal 模式双人必须占用 Left/Right 槽位，不可与 Center 混用`)
      }
    }
  }

  for (const [index, snippet] of (story.snippets as JsonRecord[]).entries()) {
    const kind = snippet.type as string
    const data = isRecord(snippet.data) ? snippet.data : {}
    const modelId = data.modelId as number | undefined
    const label = `snippets[${index}] ${kind}`

    if (kind === 'ChangeLayoutMode') {
      thinkingReturnCast = null
      const mode = toStr(data.mode) === 'Three' ? 'Three' : 'Normal'
      if (mode === 'Normal' && visible.size >= 3) {
        throw new Error(`${label} 场上已有 3 名角色，需先 LayoutClear 退场后再切回 Normal`)
      }
      layoutMode = mode
      data.mode = mode
      rewrittenSnippets.push(snippet)
      continue
    }
    if (kind === 'LayoutAppear') {
      thinkingReturnCast = null
      if (typeof modelId !== 'number') throw new Error(`${label} 缺少 modelId`)
      if (visible.has(modelId)) throw new Error(`${label} 角色已在场，不能重复入场`)
      const maxOnStage = layoutMode === 'Three' ? 3 : 2
      if (visible.size >= maxOnStage) {
        throw new Error(
          layoutMode === 'Three'
            ? `${label} Three 模式同时最多三人在场；先 LayoutClear 退场旧角色再入场`
            : `${label} Normal 模式同时最多两人在场；请先 LayoutClear 退场旧角色再入场`
        )
      }
      const toRaw = parsePosition(data.to, 'Left')
      const fromRaw = parsePosition(data.from, toStr(toRaw.side))
      const side = ON_STAGE_SIDES.has(toStr(toRaw.side)) ? toStr(toRaw.side) : 'Left'
      if (
        isOffscreenPosition(fromRaw) ||
        isOffscreenPosition(toRaw) ||
        toStr(fromRaw.side) !== side ||
        toNumber(fromRaw.offset, 0) !== 0 ||
        toNumber(toRaw.offset, 0) !== 0
      ) {
        normalizedSlides += 1
      }
      const position: JsonRecord = { side, offset: 0 }
      checkSlotAvailable(side, undefined, label)
      data.to = position
      data.from = { side, offset: 0 }
      visible.set(modelId, position)
      if (toStr(data.facial).trim()) lastFacialByModel.set(modelId, toStr(data.facial).trim())
      rewrittenSnippets.push(snippet)
      continue
    }
    if (kind === 'LayoutClear' || kind === 'Move') {
      if (kind === 'LayoutClear') thinkingReturnCast = null
      if (typeof modelId !== 'number' || !visible.has(modelId)) {
        throw new Error(`${label} 角色不在场`)
      }
      const current = visible.get(modelId)!
      const currentSide = toStr(current.side)
      if (kind === 'LayoutClear') {
        const toRaw = parsePosition(data.to, currentSide)
        if (
          isOffscreenPosition(toRaw) ||
          toStr(toRaw.side) !== currentSide ||
          toNumber(toRaw.offset, 0) !== 0 ||
          toNumber(current.offset, 0) !== 0
        ) {
          normalizedSlides += 1
        }
        data.from = { side: currentSide, offset: 0 }
        data.to = { side: currentSide, offset: 0 }
        visible.delete(modelId)
        rewrittenSnippets.push(snippet)
      } else {
        const toRaw = parsePosition(data.to, currentSide)
        const targetSide = ON_STAGE_SIDES.has(toStr(toRaw.side)) ? toStr(toRaw.side) : currentSide
        checkSlotAvailable(targetSide, modelId, label)
        if (targetSide !== currentSide) {
          // 严禁槽位间滑动（如 Center <-> Left/Right）：改为原地渐变淡出 -> 目标槽位原地渐变淡入
          convertedMoves += 1
          const motion = toStr(data.motion)
          const facial = toStr(data.facial)
          const origWait = snippet.wait !== false
          const origBehavior =
            snippet.progressBehavior === 'Now' || snippet.progressBehavior === 'WaitFinished'
              ? snippet.progressBehavior
              : origWait
                ? 'WaitFinished'
                : 'Now'
          rewrittenSnippets.push({
            type: 'LayoutClear',
            wait: true,
            progressBehavior: 'WaitFinished',
            delay: toNumber(snippet.delay, 0),
            data: {
              modelId,
              from: { side: currentSide, offset: 0 },
              to: { side: currentSide, offset: 0 },
              motion: '',
              facial: '',
              moveSpeed: 'Normal'
            }
          })
          rewrittenSnippets.push({
            type: 'LayoutAppear',
            wait: origWait,
            progressBehavior: origBehavior,
            delay: 0,
            data: {
              modelId,
              from: { side: targetSide, offset: 0 },
              to: { side: targetSide, offset: 0 },
              motion,
              facial,
              facialFirst: true,
              moveSpeed: 'Normal',
              hologram: false
            }
          })
          visible.set(modelId, { side: targetSide, offset: 0 })
        } else {
          if (
            isOffscreenPosition(toRaw) ||
            toNumber(toRaw.offset, 0) !== 0 ||
            toNumber(current.offset, 0) !== 0
          ) {
            normalizedSlides += 1
          }
          const nextPos: JsonRecord = { side: targetSide, offset: 0 }
          data.from = { side: currentSide, offset: 0 }
          data.to = nextPos
          visible.set(modelId, nextPos)
          rewrittenSnippets.push(snippet)
        }
      }
      continue
    }
    if (kind === 'LayoutDepth' || kind === 'CharacterShake') {
      if (thinkingReturnCast && typeof modelId === 'number' && !visible.has(modelId)) {
        restoreDuoFromThinking()
      }
      if (typeof modelId !== 'number' || !visible.has(modelId)) {
        throw new Error(`${label} 角色不在场`)
      }
      rewrittenSnippets.push(snippet)
      continue
    }
    if (kind === 'Talk' || kind === 'Motion' || kind === 'DoParam') {
      if (
        kind === 'Talk' &&
        layoutMode === 'Normal' &&
        typeof modelId === 'number' &&
        modelId !== -1 &&
        isExplicitThinkingTalkSnippet(snippet) &&
        visible.size >= 2
      ) {
        const snapshot = [...visible.entries()].map(([id, pos]) => ({
          id,
          side: toStr(pos.side, 'Left'),
          facial: lastFacialByModel.get(id) ?? ''
        }))
        snapshot.forEach((actor, idx) => {
          const isFirst = idx === 0
          rewrittenSnippets.push({
            type: 'LayoutClear',
            wait: isFirst,
            progressBehavior: isFirst ? 'WaitFinished' : 'Now',
            delay: 0,
            data: {
              modelId: actor.id,
              from: { side: actor.side, offset: 0 },
              to: { side: actor.side, offset: 0 },
              motion: '',
              facial: '',
              moveSpeed: 'Normal'
            }
          })
          visible.delete(actor.id)
        })
        rewrittenSnippets.push({
          type: 'LayoutAppear',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: {
            modelId,
            from: { side: 'Center', offset: 0 },
            to: { side: 'Center', offset: 0 },
            motion: '',
            facial: lastFacialByModel.get(modelId) ?? '',
            facialFirst: true,
            moveSpeed: 'Normal',
            hologram: false
          }
        })
        visible.set(modelId, { side: 'Center', offset: 0 })
        thinkingReturnCast = snapshot
        normalizedThinkingCuts += 1
      } else if (
        thinkingReturnCast &&
        ((kind === 'Talk' && !isExplicitThinkingTalkSnippet(snippet)) ||
          (kind !== 'Talk' && typeof modelId === 'number' && !visible.has(modelId)))
      ) {
        restoreDuoFromThinking()
      }

      if (thinkingReturnCast && kind === 'Talk' && Array.isArray(data.actions)) {
        data.actions = (data.actions as JsonRecord[]).filter(
          (act) => !isRecord(act) || toNumber(act.modelId, modelId as number) === modelId
        )
      }

      if (modelId !== -1 && (typeof modelId !== 'number' || !visible.has(modelId))) {
        throw new Error(`${label} 说话/动作角色必须已入场且未退场`)
      }
      if (kind === 'Talk' && modelId === -1 && (data.motion || data.facial)) {
        throw new Error(`${label} 旁白不能播放角色动作`)
      }
      if (Array.isArray(data.actions)) {
        for (const action of data.actions) {
          if (
            !isRecord(action) ||
            typeof action.modelId !== 'number' ||
            !visible.has(action.modelId)
          ) {
            throw new Error(`${label}.actions 的角色不在场，不能表演听者反应`)
          }
          if (toStr(action.facial).trim()) {
            lastFacialByModel.set(action.modelId, toStr(action.facial).trim())
          }
        }
      }
      if (typeof modelId === 'number' && modelId !== -1 && toStr(data.facial).trim()) {
        lastFacialByModel.set(modelId, toStr(data.facial).trim())
      }
      if (kind === 'Motion' && 'actions' in data && snippet.progressBehavior === undefined) {
        snippet.wait = true
      }
    }
    rewrittenSnippets.push(snippet)
  }

  normalizeLayoutTransitionBarriers(rewrittenSnippets, warn)
  story.snippets = rewrittenSnippets
  if (normalizedSlides > 0) {
    warn?.(`已将 ${normalizedSlides} 处滑动入出场/偏移规范化为槽位原地渐变（offset: 0）`)
  }
  if (convertedMoves > 0) {
    warn?.(
      `已将 ${convertedMoves} 处跨槽位 Move 滑动转换为原地渐变切镜（LayoutClear + LayoutAppear）`
    )
  }
  if (normalizedThinkingCuts > 0) {
    warn?.(`已将 ${normalizedThinkingCuts} 处思考模式段落自动转为双人先退场、再单人 Center 淡入`)
  }
}

/**
 * 节制镜头/震动与开场字幕套路化（仅在长场次 >=14 句 Talk 上抑制无端堆砌；并清理孤立的 CameraMove(0,0) 复位）。
 */
function enforceCameraShakeOpeningRestraint(
  story: JsonRecord,
  warn: (message: string) => void
): void {
  const snippets = Array.isArray(story.snippets) ? (story.snippets as JsonRecord[]) : []
  if (snippets.length === 0) return

  const talks = snippets.filter((s) => isRecord(s) && s.type === 'Talk')
  const talkCount = talks.length

  // 先清理从未移动过镜头却被附带发射的孤立 CameraMove(0,0) / CameraZoom(1) 复位
  const orphanResets = new Set<number>()
  let zoomActive = false
  let moveActive = false
  for (let i = 0; i < snippets.length; i++) {
    const s = snippets[i]
    if (!isRecord(s) || !isRecord(s.data)) continue
    if (s.type === 'CameraZoom') {
      const isReset = Math.abs(toNumber(s.data.scale, 1) - 1) <= 0.01
      if (isReset) {
        if (!zoomActive) orphanResets.add(i)
        zoomActive = false
      } else {
        zoomActive = true
      }
    } else if (s.type === 'CameraMove') {
      const isReset =
        Math.abs(toNumber(s.data.x, 0)) <= 0.5 && Math.abs(toNumber(s.data.y, 0)) <= 0.5
      if (isReset) {
        if (!moveActive) orphanResets.add(i)
        moveActive = false
      } else {
        moveActive = true
      }
    }
  }
  if (orphanResets.size > 0) {
    story.snippets = snippets.filter((_, idx) => !orphanResets.has(idx))
  }

  if (talkCount < 14) return

  const work = story.snippets as JsonRecord[]
  const STARTLE_OR_JOLT_RE =
    /(?:吓|一震|猛地|撞上|撞到|撞进|相撞|摔|抓|推|痛|啊！|呜哇|糟了|追|轰|咚|啪)/
  const DRAMATIC_LINE_RE =
    /(?:追|撞上|撞到|撞进|相撞|摔|抓|窒息|崩溃|争执|对峙|决裂|滚|住手|休想|到底怎么|爆发|哭喊|全速|绝不|舞台|聚光灯|一、二|倒数|欢呼)/

  let highDramaTalks = 0
  for (const t of talks) {
    const d = isRecord(t.data) ? t.data : {}
    const emo = toStr(d.emotion).trim()
    const content = toStr(d.content)
    if (
      emo === '生气' ||
      DRAMATIC_LINE_RE.test(content) ||
      (d.ttsSpecialScene === true &&
        (emo === '伤心' || emo === '害怕' || emo === '惊讶') &&
        !/(?:谢谢|感谢|加油|一起)/.test(content))
    ) {
      highDramaTalks += 1
    }
  }
  const isDramaticStory = highDramaTalks / talkCount >= 0.12 || highDramaTalks >= 4
  const maxCameraCues = isDramaticStory ? 3 : highDramaTalks >= 2 ? 1 : 0
  const maxCharShakes = isDramaticStory ? 2 : 1

  const adjacentTalkWindow = (idx: number): JsonRecord[] => {
    const nearby: JsonRecord[] = []
    for (let b = idx - 1, found = 0; b >= 0 && found < 2; b--) {
      if (work[b]?.type === 'Talk') {
        nearby.push(work[b])
        found += 1
      }
    }
    for (let f = idx + 1, found = 0; f < work.length && found < 1; f++) {
      if (work[f]?.type === 'Talk') {
        nearby.push(work[f])
        found += 1
      }
    }
    return nearby
  }

  const dropIndices = new Set<number>()

  // 1) 过滤日常无根据的 CharacterShake（仅保留真实受惊/物理碰撞）
  const keptShakes: Array<{ idx: number; score: number }> = []
  for (let i = 0; i < work.length; i++) {
    const s = work[i]
    if (!isRecord(s) || s.type !== 'CharacterShake') continue
    const nearby = adjacentTalkWindow(i)
    let score = 0
    for (const t of nearby) {
      const d = isRecord(t.data) ? t.data : {}
      const emo = toStr(d.emotion).trim()
      const content = toStr(d.content)
      if (
        (emo === '惊讶' && /[！!]/.test(content)) ||
        emo === '害怕' ||
        (isDramaticStory && (emo === '生气' || DRAMATIC_LINE_RE.test(content)))
      ) {
        score += 2
      }
      if (STARTLE_OR_JOLT_RE.test(content)) score += 3
    }
    if (score === 0) {
      dropIndices.add(i)
    } else {
      keptShakes.push({ idx: i, score })
    }
  }
  if (keptShakes.length > maxCharShakes) {
    keptShakes.sort((a, b) => b.score - a.score || a.idx - b.idx)
    for (let k = maxCharShakes; k < keptShakes.length; k++) {
      dropIndices.add(keptShakes[k].idx)
    }
  }

  // 2) 限制 CameraZoom / CameraMove 非复位镜头次数（冷静日常场 0~1 次，高潮冲突场 <=3 次）
  const activeCameras: Array<{ idx: number; kind: 'zoom' | 'move'; score: number }> = []
  for (let i = 0; i < work.length; i++) {
    const s = work[i]
    if (!isRecord(s) || !isRecord(s.data)) continue
    if (s.type === 'CameraZoom') {
      const scale = toNumber(s.data.scale, 1)
      if (Math.abs(scale - 1) <= 0.01) continue
      const nearby = adjacentTalkWindow(i)
      let score = Math.abs(scale - 1) * 20
      for (const t of nearby) {
        const d = isRecord(t.data) ? t.data : {}
        const emo = toStr(d.emotion).trim()
        if (emo === '生气' || emo === '惊讶' || d.ttsSpecialScene === true) score += 4
        if (DRAMATIC_LINE_RE.test(toStr(d.content))) score += 3
      }
      activeCameras.push({ idx: i, kind: 'zoom', score })
    } else if (s.type === 'CameraMove') {
      const x = toNumber(s.data.x, 0)
      const y = toNumber(s.data.y, 0)
      if (Math.abs(x) <= 0.5 && Math.abs(y) <= 0.5) continue
      const nearby = adjacentTalkWindow(i)
      let score = Math.hypot(x, y) * 0.05
      for (const t of nearby) {
        const d = isRecord(t.data) ? t.data : {}
        const emo = toStr(d.emotion).trim()
        if (emo === '生气' || emo === '惊讶' || d.ttsSpecialScene === true) score += 4
      }
      activeCameras.push({ idx: i, kind: 'move', score })
    }
  }
  if (activeCameras.length > maxCameraCues) {
    const sorted = [...activeCameras].sort((a, b) => b.score - a.score || a.idx - b.idx)
    const keepSet = new Set(sorted.slice(0, maxCameraCues).map((c) => c.idx))
    for (const c of activeCameras) {
      if (!keepSet.has(c.idx)) dropIndices.add(c.idx)
    }
  }

  // 3) 清理开场及转场中套路化的 Telop + PlaceInfo 双挂（同一转场块内同时出现时保留 Telop 或移除开场冗余 PlaceInfo）
  const firstTalkIdx = work.findIndex((s) => s.type === 'Talk')
  if (firstTalkIdx > 0) {
    const openingTelops = work
      .map((s, idx) => ({ s, idx }))
      .filter(({ s, idx }) => idx < firstTalkIdx && s.type === 'Telop')
    const openingPlaces = work
      .map((s, idx) => ({ s, idx }))
      .filter(({ s, idx }) => idx < firstTalkIdx && s.type === 'PlaceInfo')
    if (openingTelops.length > 0 && openingPlaces.length > 0) {
      for (const p of openingPlaces) dropIndices.add(p.idx)
    }
  }
  for (let i = 0; i < work.length; i++) {
    if (work[i]?.type !== 'Telop' || dropIndices.has(i)) continue
    for (let j = i + 1; j < Math.min(work.length, i + 4); j++) {
      if (work[j]?.type === 'Talk') break
      if (work[j]?.type === 'PlaceInfo') dropIndices.add(j)
    }
  }

  if (dropIndices.size === 0) return

  // 联动移除因非复位镜头被删而悬空的复位指令
  const afterPrimary = work.filter((_, idx) => !dropIndices.has(idx))
  const finalSnippets: JsonRecord[] = []
  let zOn = false
  let mOn = false
  for (const s of afterPrimary) {
    if (s.type === 'CameraZoom' && isRecord(s.data)) {
      const isReset = Math.abs(toNumber(s.data.scale, 1) - 1) <= 0.01
      if (isReset) {
        if (!zOn) continue
        zOn = false
      } else {
        zOn = true
      }
    } else if (s.type === 'CameraMove' && isRecord(s.data)) {
      const isReset =
        Math.abs(toNumber(s.data.x, 0)) <= 0.5 && Math.abs(toNumber(s.data.y, 0)) <= 0.5
      if (isReset) {
        if (!mOn) continue
        mOn = false
      } else {
        mOn = true
      }
    }
    finalSnippets.push(s)
  }
  const removed = work.length - finalSnippets.length
  if (removed > 0) {
    story.snippets = finalSnippets
    warn(`已精简 ${removed} 处非必要的日常镜头推拉/角色震动/开场冗余字幕，贴合官方 PJSK 克制运镜`)
  }
}

/**
 * 为偏静态的长场次（>=14 句 Talk）补充纯原地淡入淡出切镜（Center 单人特写 <-> Left/Right 双人同框，绝不用 Move 滑动），
 * 并为跳时间/换场地/回忆段落补全 SideFade 与 FlashbackIn/Out。
 */
function enrichDynamicFocusStaging(
  story: JsonRecord,
  view: CatalogView,
  warn: (message: string) => void
): void {
  const snippets = Array.isArray(story.snippets) ? (story.snippets as JsonRecord[]) : []
  const talks = snippets.filter((s) => isRecord(s) && s.type === 'Talk')
  const talkCount = talks.length
  if (talkCount < 14) return

  // 1) 为中段时空切换补齐 SideFade，为回忆段补齐 FlashbackIn/Out
  const hasSideFade = snippets.some((s) => s.type === 'SideFade')
  let hasFlashback = snippets.some((s) => s.type === 'FlashbackIn')
  const firstTalkIdx = snippets.findIndex((s) => s.type === 'Talk')
  const lastTalkIdx = (() => {
    for (let i = snippets.length - 1; i >= 0; i--) {
      if (snippets[i]?.type === 'Talk') return i
    }
    return -1
  })()

  if (!hasSideFade || !hasFlashback) {
    for (let i = Math.max(1, firstTalkIdx); i < lastTalkIdx; i++) {
      if (snippets[i]?.type !== 'BlackOut') continue
      let bgIdx = -1
      let blackInIdx = -1
      let nextTalkIdx = -1
      let hasFlash = false
      let sceneHintText = ''
      for (let j = i + 1; j < Math.min(snippets.length, i + 12); j++) {
        const sj = snippets[j]
        if (!isRecord(sj)) continue
        if (sj.type === 'ChangeBackgroundImage') bgIdx = j
        if (sj.type === 'FlashbackIn') hasFlash = true
        if (sj.type === 'Telop' && isRecord(sj.data)) sceneHintText += ' ' + toStr(sj.data.content)
        if (sj.type === 'PlaceInfo' && isRecord(sj.data)) sceneHintText += ' ' + toStr(sj.data.text)
        if (sj.type === 'BlackIn') {
          blackInIdx = j
          break
        }
        if (sj.type === 'Talk') {
          nextTalkIdx = j
          break
        }
      }
      if (blackInIdx === -1) continue
      if (nextTalkIdx === -1) {
        for (let j = blackInIdx + 1; j < Math.min(snippets.length, blackInIdx + 5); j++) {
          const sj = snippets[j]
          if (isRecord(sj) && sj.type === 'Talk' && isRecord(sj.data)) {
            sceneHintText += ' ' + toStr(sj.data.content)
            break
          }
        }
      }
      if (!hasFlash && !hasFlashback && /(?:回忆|想起|以前|小时候|那时候)/.test(sceneHintText)) {
        snippets.splice(bgIdx > i ? bgIdx : i + 1, 0, {
          type: 'FlashbackIn',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { duration: 100, alpha: 0.3 }
        })
        hasFlashback = true
        i += 1
      } else if (
        !hasSideFade &&
        !hasFlash &&
        bgIdx !== -1 &&
        /(?:次日|第二天|几天后|午休|傍晚|深夜|与此同时|回到|天台|教室|街道|之后|走廊)/.test(
          sceneHintText
        )
      ) {
        snippets[i] = {
          type: 'SideFade',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { direction: 'Left', edge: 'left', mode: 'Out', duration: 450 }
        }
        snippets[blackInIdx] = {
          type: 'SideFade',
          wait: true,
          progressBehavior: 'WaitFinished',
          delay: 0,
          data: { direction: 'Right', edge: 'right', mode: 'In', duration: 450 }
        }
      }
    }
  }

  // 2) 若当前切镜偏少（< 26 次/40T），为内心独白、连续同人段与情绪/叙事焦点句插入原地淡出淡入的 Center 特写切镜
  const existingAppears = snippets.filter((s) => s.type === 'LayoutAppear').length
  if ((existingAppears / talkCount) * 40 >= 26) return

  const targetAppears = Math.min(Math.round(talkCount * 0.78), Math.ceil(talkCount * 0.85))
  let projectedAppears = existingAppears

  const makeClear = (modelId: number, side: string, wait: boolean): JsonRecord => ({
    type: 'LayoutClear',
    wait,
    progressBehavior: wait ? 'WaitFinished' : 'Now',
    delay: 0,
    data: {
      modelId,
      from: { side, offset: 0 },
      to: { side, offset: 0 },
      motion: '',
      facial: '',
      moveSpeed: 'Normal'
    }
  })

  const makeAppear = (
    modelId: number,
    side: string,
    facial: string,
    wait: boolean
  ): JsonRecord => ({
    type: 'LayoutAppear',
    wait,
    progressBehavior: wait ? 'WaitFinished' : 'Now',
    delay: 0,
    data: {
      modelId,
      from: { side, offset: 0 },
      to: { side, offset: 0 },
      motion: '',
      facial: facial || view.neutralFacial(modelId),
      facialFirst: true,
      moveSpeed: 'Normal',
      hologram: false
    }
  })

  const isCutBoundary = (s: JsonRecord | undefined): boolean => {
    if (!s) return true
    const k = toStr(s.type)
    return (
      k === 'LayoutAppear' ||
      k === 'LayoutClear' ||
      k === 'Move' ||
      k === 'BlackOut' ||
      k === 'SideFade' ||
      k === 'SekaiOut' ||
      k === 'ChangeBackgroundImage' ||
      k === 'CharacterShake' ||
      k === 'Telop' ||
      k === 'FullScreenText'
    )
  }

  const onStage = new Map<number, { side: string; facial: string }>()
  let layoutMode: 'Normal' | 'Three' = 'Normal'
  let talkCounter = 0
  let lastAppearTalk = -10
  let lastTalkIdxSeen = -1
  let addedCuts = 0

  for (let i = 0; i < snippets.length && projectedAppears < targetAppears; i++) {
    const s = snippets[i]
    if (!isRecord(s)) continue
    const kind = toStr(s.type)
    const d = isRecord(s.data) ? s.data : {}

    if (kind === 'ChangeLayoutMode') {
      layoutMode = toStr(d.mode) === 'Three' ? 'Three' : 'Normal'
      continue
    }
    if (kind === 'LayoutAppear') {
      const mid = toNumber(d.modelId, -1)
      const toSide = isRecord(d.to) ? toStr(d.to.side, 'Left') : 'Left'
      if (mid !== -1) onStage.set(mid, { side: toSide, facial: toStr(d.facial) })
      lastAppearTalk = talkCounter
      continue
    }
    if (kind === 'LayoutClear') {
      const mid = toNumber(d.modelId, -1)
      onStage.delete(mid)
      continue
    }
    if (kind === 'Talk') {
      talkCounter += 1
      const speakerId = toNumber(d.modelId, -1)
      const prevTalkIndex = lastTalkIdxSeen
      lastTalkIdxSeen = i

      if (
        speakerId === -1 ||
        layoutMode !== 'Normal' ||
        onStage.size !== 2 ||
        !onStage.has(speakerId)
      ) {
        continue
      }
      if (talkCounter - lastAppearTalk < 2) continue
      // 不在倒数 2 句插短切镜，避免结尾仓促退场
      if (i + 3 >= lastTalkIdx) continue

      const acts = Array.isArray(d.actions) ? (d.actions as JsonRecord[]) : []
      const hasListenerAct = acts.some(
        (a) => isRecord(a) && toNumber(a.modelId, speakerId) !== speakerId
      )
      const isThinking = isThinkingTalkSnippet(s)
      const emo = toStr(d.emotion).trim()
      const isEmotionalBeat =
        d.ttsSpecialScene === true || emo === '伤心' || emo === '生气' || emo === '惊讶'

      // 检查紧接其后可纳入同一段 solo Center 镜头中的连续同说话人句数（1..3）
      let soloEndIdx = i
      let soloTalkCount = 1
      let nextTalkFound = -1
      for (let j = i + 1; j < snippets.length && soloTalkCount < 3; j++) {
        const sj = snippets[j]
        if (!isRecord(sj)) break
        if (isCutBoundary(sj)) break
        if (sj.type === 'Motion') {
          const mMid = toNumber(isRecord(sj.data) ? sj.data.modelId : -1, -1)
          const mActs =
            isRecord(sj.data) && Array.isArray(sj.data.actions)
              ? (sj.data.actions as JsonRecord[])
              : []
          if (
            (mMid !== -1 && mMid !== speakerId) ||
            mActs.some((a) => isRecord(a) && toNumber(a.modelId, mMid) !== speakerId)
          ) {
            break
          }
        }
        if (sj.type === 'Talk') {
          const nd = isRecord(sj.data) ? sj.data : {}
          const nMid = toNumber(nd.modelId, -1)
          const nActs = Array.isArray(nd.actions) ? (nd.actions as JsonRecord[]) : []
          const nHasListener = nActs.some((a) => isRecord(a) && toNumber(a.modelId, nMid) !== nMid)
          if (nMid === speakerId && !nHasListener) {
            soloEndIdx = j
            soloTalkCount += 1
            continue
          }
          nextTalkFound = j
          break
        }
      }
      if (nextTalkFound === -1) {
        for (let j = soloEndIdx + 1; j < snippets.length; j++) {
          if (isCutBoundary(snippets[j])) break
          if (snippets[j]?.type === 'Talk') {
            nextTalkFound = j
            break
          }
        }
      }
      // 若 solo 段后面紧跟幕间转场而非 Talk，不强行切回双人，直接让后续幕间切场处理
      const qualifies =
        !hasListenerAct &&
        (isThinking ||
          soloTalkCount >= 2 ||
          (isEmotionalBeat && talkCounter - lastAppearTalk >= 3) ||
          (Array.from(toStr(d.content)).length >= 16 && talkCounter - lastAppearTalk >= 3))
      if (!qualifies || nextTalkFound === -1) continue

      // 在 solo 段前插入双人淡出 -> 单人 Center 淡入；在 solo 段后插入 Center 淡出 -> 双人恢复
      const duoSnapshot = [...onStage.entries()].map(([id, st]) => ({
        id,
        side: st.side === 'Right' ? 'Right' : 'Left',
        facial: st.facial
      }))
      const speakerInfo = duoSnapshot.find((a) => a.id === speakerId)
      if (!speakerInfo) continue

      const getTalkFacial = (talkRec: JsonRecord): string => {
        const td = isRecord(talkRec.data) ? talkRec.data : {}
        if (Array.isArray(td.actions)) {
          for (const a of td.actions) {
            if (isRecord(a) && toNumber(a.modelId, speakerId) === speakerId && toStr(a.facial)) {
              return toStr(a.facial)
            }
          }
        }
        return toStr(td.facial) || speakerInfo.facial
      }

      if (prevTalkIndex >= 0 && isRecord(snippets[prevTalkIndex]?.data)) {
        snippets[prevTalkIndex].data.closeWindowOnFinish = true
      }

      const enterCenter: JsonRecord[] = [
        ...duoSnapshot.map((actor, idx) => makeClear(actor.id, actor.side, idx === 0)),
        makeAppear(speakerId, 'Center', getTalkFacial(s), true)
      ]
      const lastSoloTalk = snippets[soloEndIdx]
      if (isRecord(lastSoloTalk?.data)) {
        lastSoloTalk.data.closeWindowOnFinish = true
      }
      const exitCenter: JsonRecord[] = [
        makeClear(speakerId, 'Center', true),
        ...duoSnapshot.map((actor, idx) =>
          makeAppear(
            actor.id,
            actor.side,
            actor.id === speakerId ? getTalkFacial(lastSoloTalk) : actor.facial,
            idx === 0
          )
        )
      ]

      // 先插入后段再插入前段，避免索引位移影响 soloEndIdx
      snippets.splice(soloEndIdx + 1, 0, ...exitCenter)
      snippets.splice(i, 0, ...enterCenter)

      const insertedBefore = enterCenter.length
      const insertedAfter = exitCenter.length
      // 跳过刚插入的切镜与整个 solo 段，使状态停留在恢复后的双人同框
      i = soloEndIdx + insertedBefore + insertedAfter
      talkCounter += soloTalkCount - 1
      lastAppearTalk = talkCounter
      lastTalkIdxSeen = soloEndIdx + insertedBefore
      projectedAppears += 3
      addedCuts += 1
    }
  }

  if (addedCuts > 0) {
    warn(
      `已补充 ${addedCuts} 处「双人同框 <-> 单人 Center 特写」原地淡入淡出切镜，提升 PJSK 镜头节奏`
    )
  }
}

/**
 * 消除连续表情冻结与台词动作词汇坍缩（nod01/sad01 刷屏），调用角色全量动作库多样化表演，
 * 并为长场次（>=14 句 Talk）补足句间/句前独立 Motion 节拍。
 */
function diversifyActingAndPreTalkMotions(
  story: JsonRecord,
  view: CatalogView,
  warn: (message: string) => void
): void {
  const snippets = Array.isArray(story.snippets) ? (story.snippets as JsonRecord[]) : []
  const talks = snippets.filter((s) => isRecord(s) && s.type === 'Talk')
  const talkCount = talks.length
  if (talkCount < 6) return

  const fullMotionsFor = (modelId: number): string[] => {
    const m = view.modelById(modelId)
    if (!m) return []
    const promptM = view.promptMotions(m)
    const promptSet = new Set(promptM)
    const rest = (m.motions ?? []).filter((name) => !promptSet.has(name))
    return [...promptM, ...rest].filter((name) =>
      facialSemanticsMod.isMotionAutoPickAllowed(name, m.path)
    )
  }

  const fullFacialsFor = (modelId: number): string[] => {
    const m = view.modelById(modelId)
    if (!m) return []
    const promptF = view.promptFacials(m)
    const promptSet = new Set(promptF)
    return [...promptF, ...(m.facials ?? []).filter((name) => !promptSet.has(name))]
  }

  const motionCountsByActor = new Map<number, Map<string, number>>()
  const stemCountsByActor = new Map<number, Map<string, number>>()
  const lastBodyMotionByActor = new Map<number, string>()
  const facialCountsByActor = new Map<number, Map<string, number>>()
  const prevFacialTrack = new Map<number, { facial: string; count: number }>()
  const onStage = new Set<number>()
  const tenseTracker: facialSemanticsMod.SceneTenseTracker = { tense: false, calmRun: 0 }
  let prevContent = ''
  let prevEmotion = ''
  let diversifiedMotions = 0
  let diversifiedFacials = 0

  const incMap = (outer: Map<number, Map<string, number>>, mid: number, key: string): number => {
    if (!key) return 0
    let inner = outer.get(mid)
    if (!inner) {
      inner = new Map()
      outer.set(mid, inner)
    }
    const next = (inner.get(key) ?? 0) + 1
    inner.set(key, next)
    return next
  }

  const getMap = (outer: Map<number, Map<string, number>>, mid: number): Map<string, number> => {
    let inner = outer.get(mid)
    if (!inner) {
      inner = new Map()
      outer.set(mid, inner)
    }
    return inner
  }

  const pickFreshFacial = (
    modelId: number,
    content: string,
    emotion: string,
    prevTense: boolean,
    isMonologue: boolean,
    isListener: boolean,
    currentFacial: string,
    cheerfulScene: boolean
  ): string => {
    const model = view.modelById(modelId)
    if (!model) return ''
    const restrained = isRestrainedActor(model.name, model.path)
    const allFacials = fullFacialsFor(modelId)
    const currentRole = facialSemanticsMod.inspectModelFacial(model.path, currentFacial).role
    const fCounts = getMap(facialCountsByActor, modelId)
    const compat = allFacials.filter(
      (f) =>
        f !== currentFacial &&
        isFacialStrictlyCompatible({
          facial: f,
          modelPath: model.path,
          emotion,
          content,
          prevTense,
          isMonologue,
          isListener,
          restrainedRole: restrained,
          cheerfulScene
        })
    )
    if (compat.length === 0) return ''
    const rec = facialSemanticsMod.recommendActingForLine({
      facials: compat,
      motions: [],
      modelPath: model.path,
      content,
      emotion,
      prevContent,
      prevEmotion,
      prevTense,
      isMonologue,
      isListener,
      restrainedRole: restrained,
      prevFacial: currentFacial,
      limit: 6
    })
    const scored = compat
      .map((f, idx) => {
        const role = facialSemanticsMod.inspectModelFacial(model.path, f).role
        let score = 0
        if (rec.facials.includes(f)) score += 12 - rec.facials.indexOf(f) * 2
        if (role === currentRole && currentRole !== 'neutral') score += 6
        else if (
          /^face_normal/i.test(currentFacial) &&
          (role === 'serious' || role === 'closed_neutral' || role === 'genuine_smile')
        ) {
          score += 4
        }
        score -= (fCounts.get(f) ?? 0) * 4
        return { f, score, idx }
      })
      .sort((a, b) => b.score - a.score || a.idx - b.idx)
    const picked = scored[0]?.f ?? ''
    return picked ? ensureRealCatalogAnimation(view, modelId, 'facial', picked) : ''
  }

  const pickFreshMotion = (
    modelId: number,
    content: string,
    emotion: string,
    prevTense: boolean,
    isListener: boolean,
    currentMotion: string,
    cheerfulScene: boolean,
    options: { subtleOnly?: boolean; avoidStems?: ReadonlySet<string> } = {}
  ): string => {
    const model = view.modelById(modelId)
    if (!model) return ''
    const restrained = isRestrainedActor(model.name, model.path)
    const allMotions = fullMotionsFor(modelId)
    const compat = allMotions.filter((m) => {
      if (m === currentMotion) return false
      const info = facialSemanticsMod.inspectModelMotion(model.path, m)
      if (info.contextTag) return false
      if (
        (isListener || options.subtleOnly) &&
        facialSemanticsMod.isWavingOrBigTheatricalMotion(m, model.path)
      ) {
        return false
      }
      if (options.avoidStems && options.avoidStems.size > 0) {
        const stem = facialSemanticsMod.parseMotionStem(m).stem
        if (stem && options.avoidStems.has(stem)) return false
      }
      return isMotionMoodCompatible({
        motion: m,
        modelPath: model.path,
        emotion,
        content,
        prevContent,
        prevEmotion,
        prevTense,
        isListener,
        restrainedRole: restrained,
        cheerfulScene
      })
    })
    if (compat.length === 0) return ''
    const mCounts = getMap(motionCountsByActor, modelId)
    const sCounts = getMap(stemCountsByActor, modelId)
    const avoid = new Set<string>()
    if (currentMotion) avoid.add(currentMotion)
    const lastM = lastBodyMotionByActor.get(modelId)
    if (lastM) avoid.add(lastM)
    const mood = inferValidationMood(content, emotion)
    const raw = facialSemanticsMod.pickMoodMatchedMotion(
      compat,
      mood,
      model.path,
      restrained,
      avoid,
      undefined,
      { motionCounts: mCounts, stemCounts: sCounts }
    )
    return raw ? ensureRealCatalogAnimation(view, modelId, 'motion', raw) : ''
  }

  const recordFacial = (mid: number, facial: string): void => {
    if (!facial || mid === -1) return
    incMap(facialCountsByActor, mid, facial)
    const prev = prevFacialTrack.get(mid)
    if (prev && prev.facial === facial) {
      prevFacialTrack.set(mid, { facial, count: prev.count + 1 })
    } else {
      prevFacialTrack.set(mid, { facial, count: 1 })
    }
  }

  const recordMotion = (mid: number, motion: string): void => {
    if (!motion || mid === -1) return
    incMap(motionCountsByActor, mid, motion)
    const stem = facialSemanticsMod.parseMotionStem(motion).stem
    if (stem) incMap(stemCountsByActor, mid, stem)
    lastBodyMotionByActor.set(mid, motion)
  }

  for (let i = 0; i < snippets.length; i++) {
    const snippet = snippets[i]
    if (!isRecord(snippet) || !isRecord(snippet.data)) continue
    const kind = toStr(snippet.type)
    const data = snippet.data

    if (isSceneCutSnippet(snippet)) {
      tenseTracker.tense = false
      tenseTracker.calmRun = 0
      prevContent = ''
      prevEmotion = ''
      continue
    }

    if (kind === 'LayoutAppear') {
      const mid = toNumber(data.modelId, -1)
      if (mid !== -1) {
        onStage.add(mid)
        const af = toStr(data.facial).trim()
        if (af) {
          incMap(facialCountsByActor, mid, af)
          prevFacialTrack.set(mid, { facial: af, count: 1 })
        } else {
          prevFacialTrack.delete(mid)
        }
        let appMot = toStr(data.motion).trim()
        if (appMot && !facialSemanticsMod.isSpecialOrStandingMotion(appMot)) {
          const model = view.modelById(mid)
          const mCounts = getMap(motionCountsByActor, mid)
          const sCounts = getMap(stemCountsByActor, mid)
          const stem = facialSemanticsMod.parseMotionStem(appMot).stem
          const nextTalk = snippets.slice(i + 1).find((x) => isRecord(x) && x.type === 'Talk')
          const nd = nextTalk && isRecord(nextTalk.data) ? nextTalk.data : {}
          const cheerfulScene = isCheerfulComedySnippetContext(snippets, i)
          const prevSnip = i > 0 ? snippets[i - 1] : undefined
          const prevAppearData =
            isRecord(prevSnip) && prevSnip.type === 'LayoutAppear' && isRecord(prevSnip.data)
              ? prevSnip.data
              : null
          const prevAppearMot = prevAppearData ? toStr(prevAppearData.motion).trim() : ''
          const prevAppearStem = prevAppearMot
            ? facialSemanticsMod.parseMotionStem(prevAppearMot).stem
            : ''
          const prevAppearModel = prevAppearData
            ? view.modelById(toNumber(prevAppearData.modelId, -1))
            : null
          const dualAppearClash =
            Boolean(prevAppearMot) &&
            (stem === prevAppearStem ||
              (facialSemanticsMod.isWavingOrBigTheatricalMotion(appMot, model?.path) &&
                facialSemanticsMod.isWavingOrBigTheatricalMotion(
                  prevAppearMot,
                  prevAppearModel?.path
                )))
          const compatAppMot = isMotionMoodCompatible({
            motion: appMot,
            modelPath: model?.path,
            emotion: toStr(nd.emotion),
            content: toStr(nd.content),
            prevTense: tenseTracker.tense && !cheerfulScene,
            isListener: Boolean(prevAppearData),
            restrainedRole: model ? isRestrainedActor(model.name, model.path) : false,
            cheerfulScene
          })
          const forbiddenAppMot =
            !facialSemanticsMod.isCharacterSignatureMotionAllowed(appMot, model?.path) ||
            /animal/i.test(appMot) ||
            !compatAppMot ||
            dualAppearClash
          if (forbiddenAppMot || (mCounts.get(appMot) ?? 0) >= 2 || (sCounts.get(stem) ?? 0) >= 3) {
            const freshM = pickFreshMotion(
              mid,
              toStr(nd.content),
              toStr(nd.emotion),
              tenseTracker.tense && !cheerfulScene,
              Boolean(prevAppearData),
              appMot,
              cheerfulScene,
              {
                subtleOnly: Boolean(prevAppearData),
                avoidStems: prevAppearStem ? new Set([prevAppearStem]) : undefined
              }
            )
            if (freshM && freshM !== appMot) {
              data.motion = freshM
              appMot = freshM
              diversifiedMotions += 1
            } else if (forbiddenAppMot) {
              data.motion = ''
              appMot = ''
              diversifiedMotions += 1
            }
          }
          if (appMot) recordMotion(mid, appMot)
        }
      }
      continue
    }
    if (kind === 'LayoutClear') {
      const mid = toNumber(data.modelId, -1)
      onStage.delete(mid)
      prevFacialTrack.delete(mid)
      continue
    }
    if (kind === 'Move') {
      const mid = toNumber(data.modelId, -1)
      const mf = toStr(data.facial).trim()
      if (mf) recordFacial(mid, mf)
      recordMotion(mid, toStr(data.motion).trim())
      continue
    }
    if (kind === 'Motion') {
      const mid = toNumber(data.modelId, -1)
      incMap(facialCountsByActor, mid, toStr(data.facial).trim())
      const diversifyMotionTarget = (target: JsonRecord, actorId: number): void => {
        let mot = toStr(target.motion).trim()
        if (!mot || actorId === -1 || facialSemanticsMod.isSpecialOrStandingMotion(mot)) return
        const mCounts = getMap(motionCountsByActor, actorId)
        const sCounts = getMap(stemCountsByActor, actorId)
        const stem = facialSemanticsMod.parseMotionStem(mot).stem
        const prevM = lastBodyMotionByActor.get(actorId)
        const actorModel = view.modelById(actorId)
        const nearTalk = snippets.slice(i + 1).find((x) => isRecord(x) && x.type === 'Talk')
        const nd = nearTalk && isRecord(nearTalk.data) ? nearTalk.data : {}
        const ctxContent = prevContent || toStr(nd.content)
        const ctxEmotion = prevEmotion || toStr(nd.emotion)
        const cheerfulScene = isCheerfulComedySnippetContext(snippets, i)
        const isListenerMot = prevContent ? false : toNumber(nd.modelId, -1) !== actorId
        const compatMot = isMotionMoodCompatible({
          motion: mot,
          modelPath: actorModel?.path,
          emotion: ctxEmotion,
          content: ctxContent,
          prevTense: tenseTracker.tense && !cheerfulScene,
          isListener: isListenerMot,
          restrainedRole: actorModel ? isRestrainedActor(actorModel.name, actorModel.path) : false,
          cheerfulScene
        })
        const forbiddenMot =
          !facialSemanticsMod.isCharacterSignatureMotionAllowed(mot, actorModel?.path) ||
          /animal/i.test(mot) ||
          !compatMot ||
          (isListenerMot && facialSemanticsMod.isWavingOrBigTheatricalMotion(mot, actorModel?.path))
        if (
          forbiddenMot ||
          mot === prevM ||
          (mCounts.get(mot) ?? 0) >= 2 ||
          (sCounts.get(stem) ?? 0) >= 3
        ) {
          const freshM = pickFreshMotion(
            actorId,
            ctxContent,
            ctxEmotion,
            tenseTracker.tense && !cheerfulScene,
            isListenerMot,
            mot,
            cheerfulScene,
            { subtleOnly: isListenerMot }
          )
          if (freshM && freshM !== mot) {
            target.motion = freshM
            mot = freshM
            diversifiedMotions += 1
          } else if (forbiddenMot) {
            if (target === data) target.motion = ''
            else delete target.motion
            mot = ''
            diversifiedMotions += 1
          }
        }
        if (mot) recordMotion(actorId, mot)
      }
      diversifyMotionTarget(data, mid)
      if (Array.isArray(data.actions)) {
        for (const a of data.actions) {
          if (!isRecord(a)) continue
          const aid = toNumber(a.modelId, mid)
          incMap(facialCountsByActor, aid, toStr(a.facial).trim())
          diversifyMotionTarget(a, aid)
        }
      }
      continue
    }
    if (kind !== 'Talk') continue

    const speakerId = toNumber(data.modelId, -1)
    const content = toStr(data.content)
    const emotion = toStr(data.emotion)
    const isMonologue = isInnerMonologueText(content)
    const cheerfulScene = isCheerfulComedySnippetContext(snippets, i)
    const effectivePrevTense = tenseTracker.tense && !cheerfulScene
    if (speakerId === -1) {
      prevContent = content
      prevEmotion = emotion
      facialSemanticsMod.updateSceneTenseAfterTalk(tenseTracker, content, emotion, {
        cheerfulScene
      })
      continue
    }

    const processTarget = (target: JsonRecord, actorId: number, isListener: boolean): void => {
      if (actorId === -1) return
      const model = view.modelById(actorId)
      if (!model) return
      const restrained = isRestrainedActor(model.name, model.path)
      let facial = toStr(target.facial).trim()
      if (facial) {
        const prev = prevFacialTrack.get(actorId)
        const nextSame = prev && prev.facial === facial ? prev.count + 1 : 1
        const fRole = facialSemanticsMod.inspectModelFacial(model.path, facial).role
        const holdLimit =
          fRole === 'neutral' ||
          fRole === 'genuine_smile' ||
          fRole === 'closed_smile' ||
          fRole === 'playful'
            ? 3
            : fRole === 'cry' || fRole === 'sad' || fRole === 'cold_hollow'
              ? 9
              : 5
        const auditMood = facialSemanticsMod.inferDramaticContext({
          content,
          emotion,
          prevContent,
          prevEmotion,
          isMonologue: !isListener && isMonologue,
          isListener,
          restrainedRole: restrained
        }).mood
        const stuckNormal =
          /^face_normal/i.test(facial) && nextSame >= 2 && !restrained && auditMood !== 'neutral'
        if (nextSame >= holdLimit || stuckNormal) {
          const freshF = pickFreshFacial(
            actorId,
            content,
            emotion,
            effectivePrevTense,
            !isListener && isMonologue,
            isListener,
            facial,
            cheerfulScene
          )
          if (freshF && freshF !== facial) {
            target.facial = freshF
            facial = freshF
            diversifiedFacials += 1
          }
        }
        recordFacial(actorId, facial)
      }

      let motion = toStr(target.motion).trim()
      if (motion) {
        const mCounts = getMap(motionCountsByActor, actorId)
        const sCounts = getMap(stemCountsByActor, actorId)
        const stem = facialSemanticsMod.parseMotionStem(motion).stem
        const usedExact = mCounts.get(motion) ?? 0
        const usedStem = sCounts.get(stem) ?? 0
        const prevM = lastBodyMotionByActor.get(actorId)
        const isSignatureComedy =
          cheerfulScene &&
          /wandahoi/i.test(motion) &&
          facialSemanticsMod.isCharacterSignatureMotionAllowed(motion, model.path) &&
          usedExact < 2
        const forbiddenMot =
          !facialSemanticsMod.isCharacterSignatureMotionAllowed(motion, model.path) ||
          /animal/i.test(motion) ||
          (isListener && facialSemanticsMod.isWavingOrBigTheatricalMotion(motion, model.path)) ||
          !isMotionMoodCompatible({
            motion,
            modelPath: model.path,
            emotion,
            content,
            prevContent,
            prevEmotion,
            prevTense: effectivePrevTense,
            isListener,
            restrainedRole: restrained,
            cheerfulScene
          })
        const needsVariety =
          forbiddenMot ||
          (!isSignatureComedy && (motion === prevM || usedExact >= 2 || usedStem >= 3))
        if (needsVariety) {
          const freshM = pickFreshMotion(
            actorId,
            content,
            emotion,
            effectivePrevTense,
            isListener,
            motion,
            cheerfulScene,
            { subtleOnly: isListener }
          )
          if (freshM && freshM !== motion) {
            target.motion = freshM
            motion = freshM
            diversifiedMotions += 1
          } else if (forbiddenMot) {
            if (target === data) target.motion = ''
            else delete target.motion
            motion = ''
            diversifiedMotions += 1
          }
        }
        if (motion) recordMotion(actorId, motion)
      }
    }

    if (Array.isArray(data.actions) && data.actions.length > 0) {
      for (const act of data.actions) {
        if (!isRecord(act)) continue
        const aid = toNumber(act.modelId, speakerId)
        processTarget(act, aid, aid !== speakerId)
      }
    } else {
      processTarget(data, speakerId, false)
    }

    prevContent = content
    prevEmotion = emotion
    facialSemanticsMod.updateSceneTenseAfterTalk(tenseTracker, content, emotion, { cheerfulScene })
  }

  // 2) 长场次（>=14 句 Talk）若句前/句间独立 Motion 节拍偏少（< 16 次/40T），补充自然反应 Motion
  let addedPreTalkMotions = 0
  if (talkCount >= 14) {
    const existingMotions = snippets.filter((s) => s.type === 'Motion').length
    const targetMotions = Math.round(talkCount * 0.54)
    if (existingMotions < targetMotions) {
      const needed = targetMotions - existingMotions
      const stageActorsNow = new Set<number>()
      const recentAppearMotionActors = new Set<number>()
      const inserts: Array<{ afterIdx: number; snippet: JsonRecord }> = []
      const lastMotionAtTalk = new Map<number, number>()
      let tIdx = 0
      const tTracker: facialSemanticsMod.SceneTenseTracker = { tense: false, calmRun: 0 }
      let pContent = ''
      let pEmotion = ''

      for (let i = 0; i < snippets.length && inserts.length < needed; i++) {
        const s = snippets[i]
        if (!isRecord(s) || !isRecord(s.data)) continue
        const k = toStr(s.type)
        const d = s.data
        if (isSceneCutSnippet(s)) {
          tTracker.tense = false
          tTracker.calmRun = 0
          pContent = ''
          pEmotion = ''
          recentAppearMotionActors.clear()
          continue
        }
        if (k === 'LayoutAppear') {
          const mid = toNumber(d.modelId, -1)
          if (mid !== -1) {
            stageActorsNow.add(mid)
            if (toStr(d.motion).trim()) recentAppearMotionActors.add(mid)
          }
          continue
        }
        if (k === 'LayoutClear') {
          const mid = toNumber(d.modelId, -1)
          stageActorsNow.delete(mid)
          recentAppearMotionActors.delete(mid)
          continue
        }
        if (k === 'Motion') {
          lastMotionAtTalk.set(toNumber(d.modelId, -1), tIdx)
          continue
        }
        if (k !== 'Talk') continue
        tIdx += 1
        const speakerId = toNumber(d.modelId, -1)
        const content = toStr(d.content)
        const emotion = toStr(d.emotion)
        const next = snippets[i + 1]
        const acts = Array.isArray(d.actions) ? (d.actions as JsonRecord[]) : []
        const talkBodyActors = new Set<number>()
        if (toStr(d.motion).trim() && speakerId !== -1) talkBodyActors.add(speakerId)
        for (const a of acts) {
          if (isRecord(a) && toStr(a.motion).trim()) {
            const aid = toNumber(a.modelId, speakerId)
            if (aid !== -1) talkBodyActors.add(aid)
          }
        }
        // 若本句 Talk 或刚入场的 LayoutAppear 已有身体动作，严禁打断说话者自身或在双人大动作/刚入场时发射并发叠加 Motion；
        // 对听者：若下一句不会 <400ms 立即打断该听者，优先用 wait=true 顺承静默拍；否则仅在非大动作/非刚入场时发射轻柔句中反应。
        const hasActiveConcurrentMotion =
          talkBodyActors.size > 0 || recentAppearMotionActors.size > 0
        const talkHasBigMotion =
          (toStr(d.motion).trim() &&
            facialSemanticsMod.isWavingOrBigTheatricalMotion(
              toStr(d.motion).trim(),
              view.modelById(speakerId)?.path
            )) ||
          acts.some((a) => {
            if (!isRecord(a) || !toStr(a.motion).trim()) return false
            const aid = toNumber(a.modelId, speakerId)
            return facialSemanticsMod.isWavingOrBigTheatricalMotion(
              toStr(a.motion).trim(),
              view.modelById(aid)?.path
            )
          })
        const canInsertAfter =
          speakerId !== -1 &&
          d.closeWindowOnFinish !== true &&
          isRecord(next) &&
          next.type === 'Talk'
        if (canInsertAfter) {
          const nextData = isRecord(next.data) ? next.data : {}
          const nextDelay = toNumber(next.delay, 0)
          const nextSpeaker = toNumber(nextData.modelId, -1)
          const nextActs = Array.isArray(nextData.actions) ? (nextData.actions as JsonRecord[]) : []
          const willNextTalkInterrupt = (actorId: number): boolean => {
            if (nextDelay >= 0.8) return false
            if (nextSpeaker === actorId && toStr(nextData.motion).trim()) return true
            return nextActs.some(
              (a) =>
                isRecord(a) &&
                toNumber(a.modelId, nextSpeaker) === actorId &&
                Boolean(toStr(a.motion).trim()) &&
                toNumber(a.at, 0) < 0.35
            )
          }
          const partners = [...stageActorsNow].filter((id) => id !== speakerId)
          const partnerWithoutAction = partners.find(
            (pid) =>
              !acts.some((a) => isRecord(a) && toNumber(a.modelId, speakerId) === pid) &&
              !recentAppearMotionActors.has(pid) &&
              (!willNextTalkInterrupt(pid) ||
                (recentAppearMotionActors.size === 0 && !talkHasBigMotion))
          )
          const isPivotOrLong = Array.from(content).length >= 16 || /[……——！？!?]/.test(content)
          const speakerCanReact =
            !talkBodyActors.has(speakerId) &&
            !recentAppearMotionActors.has(speakerId) &&
            !willNextTalkInterrupt(speakerId)
          const chosenId =
            partnerWithoutAction !== undefined &&
            tIdx - (lastMotionAtTalk.get(partnerWithoutAction) ?? -10) >= 2 &&
            !isInnerMonologueText(content)
              ? partnerWithoutAction
              : speakerCanReact &&
                  isPivotOrLong &&
                  tIdx - (lastMotionAtTalk.get(speakerId) ?? -10) >= 2
                ? speakerId
                : -1
          if (chosenId !== -1) {
            const isListener = chosenId !== speakerId
            const cheerfulScene = isCheerfulComedySnippetContext(snippets, i)
            const freshM = pickFreshMotion(
              chosenId,
              content,
              emotion,
              tTracker.tense && !cheerfulScene,
              isListener,
              lastBodyMotionByActor.get(chosenId) ?? '',
              cheerfulScene,
              { subtleOnly: true }
            )
            if (freshM) {
              const useSequentialBeat =
                hasActiveConcurrentMotion && !willNextTalkInterrupt(chosenId)
              inserts.push({
                afterIdx: i,
                snippet: {
                  type: 'Motion',
                  wait: useSequentialBeat,
                  progressBehavior: useSequentialBeat ? 'WaitFinished' : 'Now',
                  delay: useSequentialBeat ? 0.25 : 0.3,
                  data: { modelId: chosenId, motion: freshM, facial: '', facialFirst: true }
                }
              })
              recordMotion(chosenId, freshM)
              lastMotionAtTalk.set(chosenId, tIdx)
              addedPreTalkMotions += 1
            }
          }
        }
        recentAppearMotionActors.clear()
        pContent = content
        pEmotion = emotion
        facialSemanticsMod.updateSceneTenseAfterTalk(tTracker, content, emotion)
      }

      if (inserts.length > 0) {
        inserts.sort((a, b) => b.afterIdx - a.afterIdx)
        for (const item of inserts) {
          snippets.splice(item.afterIdx + 1, 0, item.snippet)
        }
      }
      void pContent
      void pEmotion
    }
  }

  if (diversifiedMotions > 0 || diversifiedFacials > 0 || addedPreTalkMotions > 0) {
    warn(
      `已扩展表演词汇与节奏：多样化动作 ${diversifiedMotions} 处、微调连播表情 ${diversifiedFacials} 处、补充句间反应 Motion ${addedPreTalkMotions} 处`
    )
  }
}

export interface ValidationResult {
  story: StoryData
  warnings: string[]
  lint?: OfficialLintReport
}

/**
 * 补齐最基本的开场/收尾镜头：AI 偶尔会漏掉 ChangeLayoutMode 或 ChangeBackgroundImage，
 * 结果整片白底或直接黑屏结束。这里只在完全缺失时补一条，不覆盖模型已经写好的演出。
 */
function ensureOpeningAndEnding(story: JsonRecord): void {
  const snippets = story.snippets as JsonRecord[]
  if (!snippets.some((snippet) => snippet.type === 'ChangeLayoutMode')) {
    snippets.unshift({
      type: 'ChangeLayoutMode',
      wait: false,
      delay: 0,
      data: { mode: 'Normal' }
    })
  }

  const images = Array.isArray(story.images) ? (story.images as JsonRecord[]) : []
  if (images.length > 0 && !snippets.some((snippet) => snippet.type === 'ChangeBackgroundImage')) {
    const imageId = toNumber(images[0].id, 1)
    const firstScene = snippets.findIndex((snippet) => snippet.type !== 'ChangeLayoutMode')
    snippets.splice(firstScene < 0 ? snippets.length : firstScene, 0, {
      type: 'ChangeBackgroundImage',
      wait: false,
      delay: 0,
      data: { imageId }
    })
  }

  const hasEnding = snippets.slice(-3).some((snippet) => snippet.type === 'BlackOut')
  if (!hasEnding) {
    snippets.push({ type: 'BlackOut', wait: true, delay: 0, data: { duration: 600 } })
  }
}

/**
 * 单段生成时模型在顶层写 `bgm`（与 images 对齐的数组或单个字符串），
 * 这里把它编译成 ChangeBgm 片段：第一首在开场，后续在对应背景切换前接上。
 * 只有 bgm.yaml 登记过的文件才会被采用；非法值直接忽略并回退全局默认。
 */
function compileStoryBgm(
  story: JsonRecord,
  view: CatalogView,
  warn: (message: string) => void
): void {
  const raw = story.bgm
  if (raw === undefined || raw === null) return

  const snippets = story.snippets as JsonRecord[]
  const firstBgmIndex = snippets.findIndex((snippet) => snippet.type === 'ChangeBgm')
  if (firstBgmIndex >= 0) {
    // 若模型同时写了顶层 bgm 作为开场曲、又在剧情中段写了 ChangeBgm 切曲/停曲，
    // 保留首支顶层 bgm 作为开场 BGM，避免前半段剧情意外全程静音。
    const firstTalkIndex = snippets.findIndex((snippet) => snippet.type === 'Talk')
    const hasOpeningBgm = firstTalkIndex < 0 || firstBgmIndex < firstTalkIndex
    if (!hasOpeningBgm) {
      const list = Array.isArray(raw) ? raw : [raw]
      const firstItem = list[0]
      const requested =
        typeof firstItem === 'string'
          ? firstItem
          : isRecord(firstItem)
            ? toStr(firstItem.file ?? firstItem.bgm ?? firstItem.name ?? firstItem.value, '')
            : ''
      const openingFile = requested ? (view.canonicalBgm(requested) ?? '') : ''
      if (openingFile) {
        const insertAt = Math.max(
          0,
          snippets.findIndex((s) => s.type === 'ChangeBackgroundImage') + 1
        )
        snippets.splice(insertAt, 0, {
          type: 'ChangeBgm',
          wait: false,
          delay: 0,
          data: { file: openingFile, stop: false, fadeMs: DEFAULT_BGM_FADE_MS }
        })
        warn(`剧本同时给了顶层 bgm 和中段 ChangeBgm，已将顶层首曲 '${openingFile}' 补为开场 BGM`)
        delete story.bgm
        return
      }
    }
    warn('剧本同时给了顶层 bgm 和 ChangeBgm 片段，保留片段写法')
    delete story.bgm
    return
  }

  const images = Array.isArray(story.images) ? (story.images as JsonRecord[]) : []
  const list = Array.isArray(raw) ? raw : [raw]
  const entries: Array<{ imageIndex: number; file: string }> = []

  for (const [index, item] of list.entries()) {
    let file = ''
    let imageIndex = index
    let requested = ''
    if (typeof item === 'string') {
      requested = item
      file = view.canonicalBgm(item) ?? ''
    } else if (isRecord(item)) {
      requested = toStr(item.file ?? item.bgm ?? item.name ?? item.value, '')
      file = view.canonicalBgm(requested) ?? ''
      if (item.imageId !== undefined) {
        const imageId = toNumber(item.imageId, Number.NaN)
        const mapped = images.findIndex((image) => toNumber(image.id, -1) === imageId)
        if (mapped >= 0) imageIndex = mapped
      } else if (item.imageIndex !== undefined || item.index !== undefined) {
        imageIndex = Math.max(0, Math.floor(toNumber(item.imageIndex ?? item.index, index)))
      }
    }
    if (!file) {
      warn(`顶层 bgm[${index}] '${requested || '(空)'}' 不在 bgm.yaml 清单，已忽略并回退全局默认`)
      continue
    }
    entries.push({ imageIndex, file })
  }

  delete story.bgm
  if (entries.length === 0) return

  const limit = Math.max(1, images.length)
  const insertBefore = new Map<number, JsonRecord[]>()
  let lastFile = ''

  for (const entry of entries.slice(0, limit)) {
    if (entry.file === lastFile) continue
    lastFile = entry.file
    const cue: JsonRecord = {
      type: 'ChangeBgm',
      wait: false,
      delay: 0,
      data: { file: entry.file, stop: false, fadeMs: DEFAULT_BGM_FADE_MS }
    }

    if (entry.imageIndex <= 0) {
      if (!insertBefore.has(0)) insertBefore.set(0, [])
      insertBefore.get(0)!.push(cue)
      continue
    }

    const image = images[entry.imageIndex]
    const imageId = image ? toNumber(image.id, entry.imageIndex + 1) : entry.imageIndex + 1
    let target = snippets.findIndex((snippet) => {
      const data = isRecord(snippet.data) ? snippet.data : {}
      return snippet.type === 'ChangeBackgroundImage' && toNumber(data.imageId, -1) === imageId
    })
    if (target < 0) {
      target = snippets.findIndex((snippet) => snippet.type === 'ChangeBackgroundImage')
    }
    if (target < 0) target = snippets.length
    if (!insertBefore.has(target)) insertBefore.set(target, [])
    insertBefore.get(target)!.push(cue)
  }

  const result: JsonRecord[] = []
  for (let index = 0; index < snippets.length; index++) {
    const cues = insertBefore.get(index)
    if (cues) result.push(...cues)
    result.push(snippets[index])
  }
  const tail = insertBefore.get(snippets.length)
  if (tail) result.push(...tail)
  story.snippets = result
}

/**
 * 校验并尽可能修复模型生成的剧本。
 *
 * 任何会破坏舞台语义的错误（不在场说话、双人同侧等）都会抛出，
 * 由 StoryWriter 带错误信息请求模型重写；命名类错误则直接按目录纠正/丢弃。
 */
export interface ValidationOptions {
  /** TTS 支持的情绪标签；提供时把不在列表里的 Talk.emotion 清空 */
  emotionLabels?: string[]
}

export function validateAndFixStory(
  input: unknown,
  view: CatalogView,
  logger?: Logger<ILogObj>,
  options: ValidationOptions = {}
): ValidationResult {
  if (!isRecord(input)) throw new Error('剧本必须是 JSON 对象')
  const story: JsonRecord = structuredClone(input)
  const warnings: string[] = []
  const warn = (message: string): void => {
    warnings.push(message)
    logger?.warn(`[AI] ${message}`)
  }

  const defaultModel = view.defaultModel()
  if (!defaultModel) throw new Error('资源目录为空：请先配置 models.yaml 或拉取模型')

  // ---- models -----------------------------------------------------------------------------------------------
  if (!Array.isArray(story.models) || story.models.length === 0) {
    story.models = [{ id: defaultModel.id, model: defaultModel.path }]
  }
  const modelIds = new Set<number>()
  const idRemap = new Map<number, number>()
  const modelEntries: JsonRecord[] = []

  for (const [index, raw] of (story.models as unknown[]).entries()) {
    if (!isRecord(raw)) throw new Error(`models[${index}] 必须是角色对象`)
    const rawId = toNumber(raw.id, Number.NaN)
    let catalog = Number.isFinite(rawId) ? view.modelById(rawId) : null
    let modelId = catalog?.id

    if (!catalog) {
      const path = cleanPath(raw.model)
      catalog =
        (path
          ? (view.models.find((model) => model.path === path) ??
            view.models.find(
              (model) => (model.cloudId ?? '').toLowerCase() === path.toLowerCase()
            ) ??
            view.models.find((model) => path.endsWith(model.path) || model.path.endsWith(path)))
          : undefined) ??
        view.models.find(
          (model) => path.length > 0 && path.split('/').pop() === model.path.split('/').pop()
        ) ??
        null
      if (!catalog) {
        throw new Error(
          `models[${index}].id/path 必须来自角色目录（收到 id=${String(raw.id)}, model=${path}）`
        )
      }
      modelId = catalog.id
      if (Number.isFinite(rawId)) idRemap.set(rawId, catalog.id)
      warn(`models[${index}] 的 id=${rawId} 与 model 路径不一致，已按目录改为 ${catalog.id}`)
    }

    if (modelId === undefined) throw new Error(`models[${index}] 无法对应角色目录`)
    if (modelIds.has(modelId)) throw new Error(`models 中角色 id 重复: ${modelId}`)
    modelIds.add(modelId)
    modelEntries.push({
      id: modelId,
      model: catalog.path,
      normal_scale: toNumber(raw.normal_scale, 2.1),
      small_scale: toNumber(raw.small_scale, 1.8),
      anchor: toNumber(raw.anchor, 0.5)
    })
  }
  story.models = modelEntries

  const remapId = (value: unknown): unknown => {
    if (typeof value !== 'number') return value
    return idRemap.get(value) ?? value
  }

  // ---- images -----------------------------------------------------------------------------------------------
  const fixImage = (value: unknown): string => {
    // 背景可以写本地文件名、云端 id（bg_a000301）或可读名（教室）；
    // canonicalImage 统一收束到目录里的 file。
    return view.canonicalImage(cleanPath(value)) ?? view.defaultImage()
  }

  if (!Array.isArray(story.images) || story.images.length === 0) {
    story.images = [{ id: 1, image: view.defaultImage() }]
  } else {
    story.images = (story.images as unknown[]).map((raw, index) => {
      if (!isRecord(raw)) return { id: index + 1, image: view.defaultImage() }
      return {
        id: toNumber(raw.id, index + 1),
        image: fixImage(raw.image)
      }
    })
  }
  if (!view.defaultImage()) {
    story.images = []
  }

  // ---- snippets ---------------------------------------------------------------------------------------------
  if (!Array.isArray(story.snippets) || story.snippets.length === 0) {
    throw new Error('snippets 必须是非空数组')
  }

  const droppedSnippets = new Set<number>()
  for (const [index, raw] of (story.snippets as unknown[]).entries()) {
    if (!isRecord(raw) || typeof raw.type !== 'string' || !VALID_SNIPPET_TYPES.has(raw.type)) {
      throw new Error(`snippets[${index}] 必须是有效类型的片段对象`)
    }
    const snippet = raw
    const kind = snippet.type as string
    if (snippet.progressBehavior === 'Now' || snippet.progressBehavior === 'WaitFinished') {
      snippet.wait = snippet.progressBehavior === 'WaitFinished'
    } else {
      snippet.wait = toBool(snippet.wait, false)
    }
    snippet.delay = toNumber(snippet.delay, 0)
    if (!Number.isFinite(snippet.delay) || (snippet.delay as number) < 0) {
      throw new Error(`snippets[${index}].delay 必须是非负有限秒数`)
    }

    const needsData = kind !== 'HideTalk' && kind !== 'StopShake'
    if (needsData) {
      if (!isRecord(snippet.data)) snippet.data = {}
    }
    const data = isRecord(snippet.data) ? snippet.data : {}

    if (
      [
        'Talk',
        'Motion',
        'LayoutAppear',
        'LayoutClear',
        'Move',
        'DoParam',
        'LayoutDepth',
        'CharacterShake',
        'CostumeChange',
        'AttachCharacterShader'
      ].includes(kind)
    ) {
      if (!('modelId' in data)) data.modelId = defaultModel.id
      data.modelId = remapId(data.modelId)
      const modelId = data.modelId
      const allowNarration = kind === 'Talk' && modelId === -1
      if (
        typeof modelId !== 'number' ||
        !Number.isInteger(modelId) ||
        (!modelIds.has(modelId) && !allowNarration)
      ) {
        throw new Error(
          `snippets[${index}].modelId 必须是 models 中的角色整数 ID（旁白 Talk 可用 -1）`
        )
      }
      if (kind === 'Talk' || kind === 'Motion') {
        if (Array.isArray(data.actions)) {
          data.actions = data.actions.map((action) =>
            isRecord(action) ? { ...action, modelId: remapId(action.modelId) } : action
          )
        }
        validateActions(data, view, modelIds, `snippets[${index}]`, kind === 'Talk' ? 1 : 5)
      }
    }

    if (kind === 'Talk') {
      const modelId = data.modelId as number
      const model = modelId === -1 ? null : view.modelById(modelId)
      const speakerRaw = toStr(data.speaker, '')
      if (model && ![model.name, model.shortName].includes(speakerRaw)) {
        data.speaker = view.shortName(model)
        if (speakerRaw)
          warn(`snippets[${index}] speaker '${speakerRaw}' 与 modelId 不符，已改为 ${data.speaker}`)
      } else {
        data.speaker = speakerRaw || (model ? view.shortName(model) : '')
      }
      const content = repairSpokenStageDirections(
        personasMod.normalizePjskTerminology(
          normalizeDialogueLineBreaks(stripZeroWidth(toStr(data.content, '...')))
        )
      )
      data.content = stripZeroWidth(sanitizeDisplayText(content)) || '...'
      data.voice = toStr(data.voice, '')
      const rawTtsText = typeof data.ttsText === 'string' ? stripZeroWidth(data.ttsText).trim() : ''
      data.ttsText =
        ttsTextMod.hasTranslationContent(data.content as string) &&
        ttsTextMod.hasTranslationContent(rawTtsText)
          ? enforceIrodoriEmojiBudget(rawTtsText, 2)
          : ''
      const rawEmotion = toStr(data.emotion, '').trim()
      const labels = options.emotionLabels ?? []
      data.emotion =
        labels.length > 0 ? (labels.includes(rawEmotion) ? rawEmotion : '') : rawEmotion

      // Irodori 逐句语音导演字段清洗与钳制
      data.ttsCaption = sanitizeIrodoriCaption(toStr(data.ttsCaption, ''))
      const isSpecialScene = toBool(data.ttsSpecialScene, false)
      if (isSpecialScene) {
        data.ttsSpecialScene = true
      } else {
        delete data.ttsSpecialScene
      }
      if (
        'ttsSpeed' in data &&
        data.ttsSpeed !== undefined &&
        data.ttsSpeed !== null &&
        data.ttsSpeed !== ''
      ) {
        const parsedSpeed = toNumber(data.ttsSpeed, Number.NaN)
        if (Number.isFinite(parsedSpeed) && parsedSpeed > 0) {
          const minSpeed = isSpecialScene ? 0.85 : 0.92
          const maxSpeed = isSpecialScene ? 1.18 : 1.08
          data.ttsSpeed = Number(Math.min(maxSpeed, Math.max(minSpeed, parsedSpeed)).toFixed(2))
        } else {
          delete data.ttsSpeed
        }
      } else {
        delete data.ttsSpeed
      }

      if ('closeWindowOnFinish' in data) {
        if (typeof data.closeWindowOnFinish === 'boolean') {
          if (!data.closeWindowOnFinish) delete data.closeWindowOnFinish
        } else {
          if (toBool(data.closeWindowOnFinish, false)) data.closeWindowOnFinish = true
          else delete data.closeWindowOnFinish
        }
      }
      if ('effect' in data) {
        const eff = toStr(data.effect).trim()
        if (eff === 'Normal' || eff === 'Internal' || eff === 'Overlap') data.effect = eff
        else delete data.effect
      }

      if (modelId === -1) {
        // 旁白没有模型，不能携带动作/表情
        data.motion = ''
        data.facial = ''
        snippet.data = data
        continue
      }

      for (const field of ['motion', 'facial'] as const) {
        const current = cleanPath(data[field])
        if (!current) {
          data[field] = ''
          continue
        }
        const fixed = fixAnimation(view, modelId, field, current)
        if (fixed) {
          data[field] = fixed
        } else if (field === 'motion') {
          warn(`snippets[${index}] motion '${current}' 不可用，已按语境回退动作`)
          const mood = inferValidationMood(toStr(data.content), toStr(data.emotion))
          const m = view.modelById(modelId)
          data[field] = pickCompatibleMotionFallback(
            view,
            modelId,
            mood,
            m ? isRestrainedActor(m.name, m.path) : false
          )
        } else {
          warn(`snippets[${index}] facial '${current}' 不可用，已按语境回退表情`)
          const m = view.modelById(modelId)
          data[field] = pickCompatibleFacialFallback(
            view,
            modelId,
            toStr(data.content),
            toStr(data.emotion),
            false,
            m ? isRestrainedActor(m.name, m.path) : false
          )
        }
      }
      snippet.data = data
      continue
    }

    if (kind === 'ChangeBgm') {
      const stop = toBool(data.stop, false)
      const fadeMs = Math.min(
        MAX_BGM_FADE_MS,
        Math.max(0, toNumber(data.fadeMs, DEFAULT_BGM_FADE_MS))
      )
      const requested = cleanPath(data.file)

      if (stop || requested.toLowerCase().replace(/\.mp3$/i, '') === 'bgm00000') {
        if (requested && !stop) {
          warn(`snippets[${index}] ChangeBgm bgm00000 按停止 BGM 处理`)
        } else if (requested && stop) {
          warn(`snippets[${index}] ChangeBgm 同时给了 file 和 stop，按停止处理`)
        }
        data.file = ''
        data.stop = true
        data.fadeMs = fadeMs
        if ('volume' in data) data.volume = Math.min(2, Math.max(0, toNumber(data.volume, 1)))
        snippet.data = data
        continue
      }

      const file = view.canonicalBgm(requested)
      if (!file) {
        warn(
          `snippets[${index}] BGM '${requested || '(空)'}' 不在 bgm.yaml 清单，已丢弃并回退全局默认`
        )
        droppedSnippets.add(index)
        continue
      }

      data.file = file
      data.stop = false
      data.fadeMs = fadeMs
      if ('volume' in data) data.volume = Math.min(2, Math.max(0, toNumber(data.volume, 1)))
      snippet.data = data
      continue
    }

    if (kind === 'BgmVolume') {
      data.volume = Math.min(2, Math.max(0, toNumber(data.volume, 1)))
      data.duration = Math.min(30000, Math.max(0, toNumber(data.duration, 500)))
      snippet.data = data
      continue
    }

    if (kind === 'PlaySe') {
      const rawFile = cleanPath(data.file)
      const resolved = resolveRegisteredSeFile(view, rawFile)
      if (!resolved) {
        droppedSnippets.add(index)
        continue
      }
      if (resolved.remapped) {
        warn(`snippets[${index}] PlaySe '${rawFile}' 不在本地 SE 目录，已映射为 ${resolved.file}`)
      }
      data.file = resolved.file
      data.volume = Math.min(4, Math.max(0, toNumber(data.volume, 1)))
      data.loop = toBool(data.loop, false)
      data.fadeMs = Math.min(10000, Math.max(0, toNumber(data.fadeMs, 0)))
      snippet.data = data
      continue
    }

    if (kind === 'StopSe') {
      const rawFile = cleanPath(data.file)
      const resolved = resolveRegisteredSeFile(view, rawFile)
      if (!resolved) {
        droppedSnippets.add(index)
        continue
      }
      if (resolved.remapped) {
        warn(`snippets[${index}] StopSe '${rawFile}' 不在本地 SE 目录，已映射为 ${resolved.file}`)
      }
      data.file = resolved.file
      data.fadeMs = Math.min(10000, Math.max(0, toNumber(data.fadeMs, 0)))
      snippet.data = data
      continue
    }

    if (kind === 'LayoutAppear') {
      const modelId = data.modelId as number
      for (const field of ['motion', 'facial'] as const) {
        const rawAnim = cleanPath(data[field])
        if (!rawAnim) {
          data[field] =
            field === 'facial'
              ? ensureRealCatalogAnimation(view, modelId, 'facial', view.defaultFacial(modelId))
              : ''
          continue
        }
        const fixed = fixAnimation(view, modelId, field, rawAnim)
        data[field] =
          fixed ??
          (field === 'facial'
            ? ensureRealCatalogAnimation(view, modelId, 'facial', view.defaultFacial(modelId))
            : '')
      }
      if (isStandingMotion(toStr(data.motion))) {
        data.motion = ''
      }
      data.facialFirst = toBool(data.facialFirst, true)
      data.moveSpeed = VALID_MOVE_SPEEDS.has(toStr(data.moveSpeed))
        ? toStr(data.moveSpeed)
        : 'Normal'
      data.hologram = toBool(data.hologram, false)
      const toRaw = parsePosition(data.to, 'Left')
      const toSide = ON_STAGE_SIDES.has(toStr(toRaw.side)) ? toStr(toRaw.side) : 'Left'
      const toPos: JsonRecord = { side: toSide, offset: 0 }
      data.to = toPos
      // 严禁滑动入场：一律槽位原地渐变淡入（from == to, offset: 0）
      data.from = { side: toSide, offset: 0 }
      delete data.fadeIn
      snippet.data = data
      continue
    }

    if (kind === 'LayoutClear') {
      const modelId = data.modelId as number
      data.moveSpeed = VALID_MOVE_SPEEDS.has(toStr(data.moveSpeed))
        ? toStr(data.moveSpeed)
        : 'Normal'
      const fromRaw = parsePosition(data.from, 'Center')
      const fromSide = ON_STAGE_SIDES.has(toStr(fromRaw.side)) ? toStr(fromRaw.side) : 'Center'
      const fromPos: JsonRecord = { side: fromSide, offset: 0 }
      data.from = fromPos
      // 严禁滑动退场：一律槽位原地渐变淡出（from == to, offset: 0）
      data.to = { side: fromSide, offset: 0 }
      let motion = fixAnimation(view, modelId, 'motion', data.motion) ?? ''
      if (isStandingMotion(motion)) motion = ''
      data.motion = motion
      const facial = fixAnimation(view, modelId, 'facial', data.facial) ?? ''
      data.facial = facial
      delete data.fadeOut
      snippet.data = data
      continue
    }

    if (kind === 'LayoutDepth') {
      const d = toStr(data.depth)
      data.depth = d === 'Front' || d === 'Back' || d === 'Reset' ? d : 'Front'
      snippet.data = data
      continue
    }

    if (kind === 'CharacterShake') {
      data.axis = toStr(data.axis).toUpperCase() === 'Y' ? 'Y' : 'X'
      snippet.data = data
      continue
    }

    if (kind === 'CostumeChange') {
      data.costume = toStr(data.costume).trim()
      snippet.data = data
      continue
    }

    if (kind === 'AttachCharacterShader') {
      const s = toStr(data.shader).trim().toLowerCase()
      data.shader =
        s === 'hologram' || s === 'monitor' || s === 'blur' || s === 'none' ? s : 'hologram'
      if ('level' in data) {
        data.level = Math.min(10, Math.max(0, toNumber(data.level, 1)))
      }
      snippet.data = data
      continue
    }

    if (kind === 'Motion') {
      const modelId = data.modelId as number
      const hasActions = 'actions' in data
      if (hasActions || 'duration' in data) {
        const duration = toNumber(data.duration, 2)
        if (!(duration > 0) || duration > 120) {
          throw new Error(`snippets[${index}].duration 必须大于 0 且不超过 120 秒`)
        }
        data.duration = duration
      }
      const rawMotion = cleanPath(data.motion)
      const rawFacial = cleanPath(data.facial)
      const motion = rawMotion ? fixAnimation(view, modelId, 'motion', rawMotion) : null
      const facial = rawFacial ? fixAnimation(view, modelId, 'facial', rawFacial) : null
      // 保留刻意留空的 facial: ""（避免二次 validate 把纯动作反应片段的空表情误覆写为 defaultFacial=face_smile_01！）
      data.motion =
        motion ??
        (hasActions || rawFacial
          ? ''
          : ensureRealCatalogAnimation(view, modelId, 'motion', view.defaultMotion(modelId)))
      data.facial =
        facial ??
        (hasActions || !rawFacial
          ? ''
          : ensureRealCatalogAnimation(view, modelId, 'facial', view.defaultFacial(modelId)))
      data.facialFirst = toBool(data.facialFirst, true)
      snippet.data = data
      continue
    }

    if (kind === 'Move') {
      const modelId = data.modelId as number
      data.moveSpeed = VALID_MOVE_SPEEDS.has(toStr(data.moveSpeed))
        ? toStr(data.moveSpeed)
        : 'Normal'
      data.from = parsePosition(data.from, 'Center')
      data.to = parsePosition(data.to, 'Left')
      data.motion = fixAnimation(view, modelId, 'motion', data.motion) ?? ''
      data.facial = fixAnimation(view, modelId, 'facial', data.facial) ?? ''
      data.facialFirst = toBool(data.facialFirst, true)
      snippet.data = data
      continue
    }

    if (kind === 'Wait') {
      const rawDuration = toNumber(data.duration, 600)
      // 兼容模型偶尔误写秒（<=10 且非 0）与标准毫秒
      const ms = rawDuration > 0 && rawDuration <= 10 ? Math.round(rawDuration * 1000) : rawDuration
      data.duration = Math.min(30000, Math.max(0, ms))
      if (snippet.progressBehavior === undefined) {
        snippet.wait = true
      }
      snippet.data = data
      continue
    }

    if (kind === 'BlackOut' || kind === 'BlackIn') {
      data.duration = toNumber(data.duration, kind === 'BlackOut' ? 800 : 1000)
      data.color = toStr(data.color).toLowerCase() === 'white' ? 'white' : 'black'
      snippet.data = data
      continue
    }

    if (kind === 'FlashbackIn') {
      data.duration = Math.min(10000, Math.max(0, toNumber(data.duration, 100)))
      data.alpha = Math.min(1, Math.max(0, toNumber(data.alpha, 0.3)))
      snippet.data = data
      continue
    }

    if (kind === 'FlashbackOut') {
      data.duration = Math.min(10000, Math.max(0, toNumber(data.duration, 100)))
      snippet.data = data
      continue
    }

    if (kind === 'SepiaIn' || kind === 'SepiaOut') {
      if ('duration' in data)
        data.duration = Math.min(30000, Math.max(0, toNumber(data.duration, 400)))
      snippet.data = data
      continue
    }

    if (kind === 'SekaiIn' || kind === 'SekaiOut') {
      if ('duration' in data)
        data.duration = Math.min(30000, Math.max(0, toNumber(data.duration, 500)))
      if ('variant' in data) {
        data.variant = toStr(data.variant) === 'v2' ? 'v2' : 'v1'
      }
      snippet.data = data
      continue
    }

    if (kind === 'SideFade') {
      const rawDir = toStr(data.direction ?? data.edge, 'Left')
        .trim()
        .toLowerCase()
      const dir =
        rawDir === 'right'
          ? 'Right'
          : rawDir === 'top'
            ? 'Top'
            : rawDir === 'bottom'
              ? 'Bottom'
              : 'Left'
      const rawMode = toStr(data.mode, 'Out').trim().toLowerCase()
      const mode = rawMode === 'in' ? 'In' : 'Out'
      data.direction = dir
      data.edge = dir.toLowerCase()
      data.mode = mode
      data.duration = Math.min(10000, Math.max(0, toNumber(data.duration, 450)))
      snippet.data = data
      continue
    }

    if (kind === 'Wipe') {
      data.direction = toStr(data.direction).toLowerCase() === 'left' ? 'left' : 'right'
      data.mode = toStr(data.mode).toLowerCase() === 'out' ? 'out' : 'in'
      data.duration = Math.min(10000, Math.max(0, toNumber(data.duration, 450)))
      snippet.data = data
      continue
    }

    if (kind === 'BackgroundBlur') {
      if (data.mode !== undefined) {
        const mode = toStr(data.mode).toLowerCase() === 'out' ? 'Out' : 'In'
        data.mode = mode
        data.enabled = mode === 'In'
      } else {
        const enabled = toBool(data.enabled, true)
        data.enabled = enabled
        data.mode = enabled ? 'In' : 'Out'
      }
      if ('level' in data) data.level = Math.min(64, Math.max(0, toNumber(data.level, 8)))
      if ('duration' in data)
        data.duration = Math.min(10000, Math.max(0, toNumber(data.duration, 300)))
      snippet.data = data
      continue
    }

    if (kind === 'BlurIn' || kind === 'BlurOut') {
      data.duration = Math.min(30000, Math.max(0, toNumber(data.duration, 400)))
      snippet.data = data
      continue
    }

    if (kind === 'PlayScenarioEffect' || kind === 'StopScenarioEffect') {
      data.effectName =
        normalizeScenarioEffectName(data.effectName) || toStr(data.effectName).trim()
      if ('duration' in data)
        data.duration = Math.min(30000, Math.max(0, toNumber(data.duration, 0)))
      snippet.data = data
      continue
    }

    if (kind === 'ChangeBackgroundImage') {
      data.imageId = toNumber(data.imageId, 1)
      if ('duration' in data)
        data.duration = Math.min(30000, Math.max(0, toNumber(data.duration, 0)))
      snippet.data = data
      continue
    }

    if (kind === 'ChangeLayoutMode') {
      data.mode = toStr(data.mode) === 'Three' ? 'Three' : 'Normal'
      snippet.data = data
      continue
    }

    if (kind === 'Telop') {
      data.content = sanitizeDisplayText(
        personasMod.normalizePjskTerminology(toStr(data.content)),
        false
      )
      snippet.data = data
      continue
    }

    if (kind === 'PlaceInfo') {
      data.text =
        sanitizeDisplayText(personasMod.normalizePjskTerminology(toStr(data.text)), false) || '...'
      if ('duration' in data)
        data.duration = Math.min(30000, Math.max(0, toNumber(data.duration, 0)))
      snippet.data = data
      continue
    }

    if (kind === 'FullScreenText') {
      data.text = personasMod.normalizePjskTerminology(toStr(data.text).trim())
      if ('duration' in data)
        data.duration = Math.min(120000, Math.max(0, toNumber(data.duration, 2500)))
      snippet.data = data
      continue
    }

    if (kind === 'SimpleSelectable') {
      const choices = Array.isArray(data.choices)
        ? data.choices.map((c) => toStr(c).trim()).filter(Boolean)
        : ['……']
      data.choices = choices.length > 0 ? choices : ['……']
      if ('pickedIndex' in data) {
        data.pickedIndex = Math.max(
          0,
          Math.min((data.choices as string[]).length - 1, Math.floor(toNumber(data.pickedIndex, 0)))
        )
      }
      snippet.data = data
      continue
    }

    if (kind === 'ShakeScreen') {
      data.duration = Math.min(30000, Math.max(0, toNumber(data.duration, 400)))
      data.amplitude = Math.min(0.2, Math.max(0, toNumber(data.amplitude, 0.01)))
      if ('intensity' in data)
        data.intensity = Math.min(100, Math.max(0, toNumber(data.intensity, 10)))
      snippet.data = data
      continue
    }

    if (kind === 'ShakeWindow') {
      if ('duration' in data)
        data.duration = Math.min(30000, Math.max(0, toNumber(data.duration, 400)))
      if ('intensity' in data)
        data.intensity = Math.min(100, Math.max(0, toNumber(data.intensity, 10)))
      snippet.data = data
      continue
    }

    if (kind === 'StopShakeScreen' || kind === 'StopShakeWindow') {
      snippet.data = {}
      continue
    }

    if (kind === 'CameraMove') {
      data.x = toNumber(data.x, 0)
      data.y = toNumber(data.y, 0)
      data.duration = Math.min(30000, Math.max(0, toNumber(data.duration, 500)))
      snippet.data = data
      continue
    }

    if (kind === 'CameraZoom') {
      data.scale = Math.min(5, Math.max(0.1, toNumber(data.scale, 1)))
      data.duration = Math.min(30000, Math.max(0, toNumber(data.duration, 500)))
      snippet.data = data
      continue
    }

    if (kind === 'DollyZoom') {
      data.duration = Math.min(30000, Math.max(0, toNumber(data.duration, 600)))
      data.zoom = Math.min(10, Math.max(0.1, toNumber(data.zoom, 1.2)))
      snippet.data = data
      continue
    }

    if (kind === 'AmbientColor') {
      const m = toStr(data.mode).toLowerCase()
      data.mode = m === 'evening' ? 'evening' : m === 'night' ? 'night' : 'normal'
      snippet.data = data
      continue
    }

    if (kind === 'Movie') {
      data.file = cleanPath(data.file)
      if ('duration' in data)
        data.duration = Math.min(600000, Math.max(0, toNumber(data.duration, 0)))
      snippet.data = data
      continue
    }

    if (kind === 'DoParam') {
      if (!Array.isArray(data.params)) data.params = []
      snippet.data = data
    }
  }

  if (droppedSnippets.size > 0) {
    story.snippets = (story.snippets as JsonRecord[]).filter(
      (_snippet, index) => !droppedSnippets.has(index)
    )
  }

  function dedupeConsecutiveChangeBgm(story: JsonRecord, warn: (message: string) => void): void {
    const snippets = Array.isArray(story.snippets) ? (story.snippets as JsonRecord[]) : []
    let lastState: { stop: boolean; file: string } | null = null
    const kept: JsonRecord[] = []
    let dropped = 0
    for (const snippet of snippets) {
      if (isRecord(snippet) && snippet.type === 'ChangeBgm' && isRecord(snippet.data)) {
        const stop = toBool(snippet.data.stop, false)
        const file = stop ? '' : cleanPath(snippet.data.file)
        if (lastState && lastState.stop === stop && lastState.file === file) {
          dropped += 1
          continue
        }
        lastState = { stop, file }
      }
      kept.push(snippet)
    }
    if (dropped > 0) {
      story.snippets = kept
      warn(`已移除 ${dropped} 条重复连续的 ChangeBgm 片段，避免音乐重头播放`)
    }
  }

  ensureOpeningAndEnding(story)
  compileStoryBgm(story, view, warn)
  dedupeConsecutiveChangeBgm(story, warn)
  enforceCameraShakeOpeningRestraint(story, warn)
  enrichDynamicFocusStaging(story, view, warn)
  normalizeScene(story, warn)
  splitOverflowTalks(story)
  repairActingMismatches(story, view, warn)
  ensureListenerReactivity(story, view, warn)
  diversifyActingAndPreTalkMotions(story, view, warn)
  // 确定性限制整场 ttsSpecialScene 占比 <= 15%，并重新钳制被降级句子的语速
  {
    const talkDatas = (story.snippets as JsonRecord[])
      .filter((s) => isRecord(s) && s.type === 'Talk' && isRecord(s.data))
      .map((s) => s.data as JsonRecord)
    const maxSpecial = Math.floor(talkDatas.length * 0.15)
    const specialTalks = talkDatas.filter((d) => d.ttsSpecialScene === true)
    if (specialTalks.length > maxSpecial) {
      let dropped = 0
      for (let i = maxSpecial; i < specialTalks.length; i++) {
        delete specialTalks[i].ttsSpecialScene
        if (typeof specialTalks[i].ttsSpeed === 'number') {
          specialTalks[i].ttsSpeed = Number(
            Math.min(1.08, Math.max(0.92, specialTalks[i].ttsSpeed as number)).toFixed(2)
          )
        }
        dropped += 1
      }
      warn(
        `ttsSpecialScene 超过 15% 上限（${specialTalks.length}/${talkDatas.length}），已收敛 ${dropped} 句`
      )
    }
  }
  const lint = enforceOfficialStoryInvariants(story, view, warn, {
    emotionLabels: options.emotionLabels
  })

  const parsed = StorySchema.parse(story)
  return { story: parsed, warnings, lint }
}

export const validateAndNormalizeStory = validateAndFixStory
