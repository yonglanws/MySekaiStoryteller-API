import * as facialSemanticsMod from '../facialSemantics'
import {
  inspectModelFacial,
  isFacialCompatibleWithLine,
  isSmileLikeFacial,
  pickMoodMatchedFacial
} from '../facialSemantics'
import { isStandingMotion, type CatalogView } from '../prompt'
import { FOOD_DRINK_CUE_RE, SLEEP_CUE_RE, personasStagedApi } from './helpers'
import type { SubtleFacialContext } from './types'

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

const facialStagedApi = facialSemanticsMod as unknown as FacialSemanticsStagedExt

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
  [/greeting|shakehand|handshake|wave|byebye|bye|salute/i, '大挥手/打招呼(仅限招呼告别)'],
  [/delicious|eat|drink/i, '吃喝/美味(仅限食物饮品)'],
  [/sleep/i, '困倦(仅限犯困睡眠)']
]

export function annotateMotionForDirection(
  modelPath: string | undefined,
  motionName: string
): string {
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

export function isMotionCompatibleWithContext(params: {
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
  if (
    /greeting|shakehand|handshake|wave|byebye|salute/i.test(lower) &&
    !facialSemanticsMod.GREETING_CONTEXT_TEXT_RE.test(text)
  ) {
    return false
  }
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
    /glad|happy|cheer|joy|wandahoi|wink|smug|doya|pose(?!sad)|delicious|sing|greeting|shakehand|handshake|wave/.test(
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

export function pickFollowupMotion(
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
    if (
      /greeting|shakehand|handshake|wave|byebye|salute/i.test(m) &&
      !facialSemanticsMod.GREETING_CONTEXT_TEXT_RE.test(lineText)
    ) {
      return false
    }
    if (/plan/i.test(m) && !/(?:计划|主意|策略|点子|秘密|偷偷|嘿嘿|哼哼)/.test(lineText)) {
      return false
    }
    return true
  })
  const moodKey = inferMotionMoodKey(moodContext?.line, Boolean(moodContext?.prevTense))
  const isTense = Boolean(
    moodContext?.prevTense || moodKey === 'sad' || moodKey === 'angry' || moodKey === 'trouble'
  )
  const safeNonStanding = isTense
    ? nonStanding.filter(
        (m) =>
          !/glad|happy|cheer|joy|wink|smug|doya|greeting|shakehand|handshake|wave|playful|plan|blushed|fidget|armescape/i.test(
            m
          )
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
    smile: /glad|nod|tilthead|relief|playful/i,
    thinking: /think|lookaway|sigh|trouble|sad/i,
    neutral: /nod|tilthead|relief|think|lookaway|forward|sigh/i
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

export function pickAppearFallbackMotion(
  view: CatalogView,
  modelId: number,
  usedInEntry?: ReadonlySet<string>,
  avoidMotion?: string,
  tense = false,
  options: { avoidStems?: ReadonlySet<string>; subtleOnly?: boolean } = {}
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
    (m) =>
      !/delicious|eat|drink|sleep|greeting|shakehand|handshake|wave|byebye|salute|blushed|fidget|armescape|plan/i.test(
        m
      )
  )
  const entryRe = tense
    ? /trouble|sad|cry|sigh|think|lookaway|lookdown/i
    : options.subtleOnly
      ? /nod|think|lookaway|relief|lookdown|tilthead/i
      : /tilthead|lookaway|nod|forward|relief|think/i
  const isSafe = (name: string): boolean => {
    if (options.subtleOnly && facialSemanticsMod.isWavingOrBigTheatricalMotion(name, model.path)) {
      return false
    }
    return (
      !tense ||
      !/glad|happy|cheer|joy|wink|smug|doya|greeting|shakehand|handshake|wave|playful|tilthead|plan/i.test(
        name
      )
    )
  }
  const distinctStem = (name: string): boolean => {
    if (!options.avoidStems || options.avoidStems.size === 0) return true
    const stem = facialSemanticsMod.parseMotionStem(name).stem
    return !stem || !options.avoidStems.has(stem)
  }
  const distinctAndAvoided = (name: string): boolean =>
    !usedInEntry?.has(name) && name !== avoidMotion && distinctStem(name)
  const pick =
    nonStanding.find((name) => distinctAndAvoided(name) && isSafe(name) && entryRe.test(name)) ??
    nonStanding.find((name) => distinctAndAvoided(name) && isSafe(name)) ??
    nonStanding.find((name) => name !== avoidMotion && isSafe(name) && entryRe.test(name)) ??
    nonStanding.find((name) => name !== avoidMotion && isSafe(name)) ??
    nonStanding[0]
  return (
    ensureRealModelAnim(view, modelId, 'motion', pick) ||
    (options.subtleOnly
      ? ''
      : ensureRealModelAnim(view, modelId, 'motion', view.exampleMotion(modelId)) ||
        ensureRealModelAnim(view, modelId, 'motion', view.defaultMotion(modelId)))
  )
}

const FACIAL_EXTREME_EXCLUDE_RE =
  /angry|disgust|scared|cry|shock|dark|despair|fever|sneeze|disgorge/i

const FACIAL_SMILE_EXCLUDE_RE =
  /smile|smug|wink|sparkling|angry|disgust|scared|cry|shock|dark|despair|fever|sneeze|disgorge/i

export const TENSE_EMOTION_SET = new Set(['生气', '伤心', '害怕'])

const SILENT_LINE_RE = /^[（(]?[\s.…,，。！？!?—\-~～]+[）)]?$/

export const SMILE_FACIAL_RE = /smile|smug|wink|sparkling/i

const isSilentBeatLine = (text: string): boolean => SILENT_LINE_RE.test((text ?? '').trim())

export const shouldAvoidIncongruousSmile = (
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

export function isCheerfulComedyLines(
  lines: ReadonlyArray<{ content: string; emotion?: string; sceneId?: string }>,
  index: number
): boolean {
  if (typeof facialStagedApi.isCheerfulComedyContext === 'function') {
    return facialStagedApi.isCheerfulComedyContext(lines, index)
  }
  return false
}

export function isPrecededByTenseBeat(
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

export const isRestrainedRole = (roleOrName = ''): boolean => {
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
export function pickSpeakerSubtleFacial(
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
      pickFacialFromHints(safePool, hints, currentFacial, /smile|smug|wink|sparkling|angry/i) ||
      pickMoodMatchedFacial(safePool, 'sad', modelPath, restrained)
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
export function pickListenerReactionFacial(
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
  const facials = allFacials.filter((f) => !isSmileLikeFacial(f, context.modelPath ?? model.path))
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
