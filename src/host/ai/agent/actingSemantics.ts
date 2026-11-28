import type { StoryData } from '../../../common/types/Story'
import type { CatalogModel } from '../../resources/resourceCatalog'
import * as corpusExamplesMod from '../corpusExamples'
import * as facialSemanticsMod from '../facialSemantics'
import type { ChatUsage } from '../llm'
import * as officialLinterMod from '../officialLinter'
import * as personasMod from '../personas'
import type { CatalogView } from '../prompt'
import * as scenarioCuesMod from '../scenarioCues'
import { FOOD_DRINK_CUE_RE, SLEEP_CUE_RE } from '../staged/helpers'

export { FOOD_DRINK_CUE_RE, SLEEP_CUE_RE }

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

export type FacialSemanticsExtended = typeof facialSemanticsMod & {
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

export type OfficialLinterExtended = typeof officialLinterMod & {
  auditStoryActingAndFidelity?: (
    story: StoryData | Record<string, unknown>,
    view?: CatalogView,
    options?: { restrainedNames?: string[] }
  ) => ActingFidelityReport
}

export type CatalogViewExtended = CatalogView & {
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

export type PersonasExtended = typeof personasMod & {
  characterActingProfile?: (nameOrPath: string, roleHint?: string) => CharacterActingProfile
}

export type ScenarioCuesExtended = typeof scenarioCuesMod & {
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

export type CorpusExamplesExtended = typeof corpusExamplesMod & {
  getOfficialActingGuidelines?: (options?: {
    castCount?: number
    isSekai?: boolean
    isFlashback?: boolean
  }) => string
}

export const facialApi = facialSemanticsMod as unknown as FacialSemanticsExtended

export const officialLinterApi = officialLinterMod as unknown as OfficialLinterExtended

export const personasApi = personasMod as unknown as PersonasExtended

export const scenarioCuesApi = scenarioCuesMod as unknown as ScenarioCuesExtended

export const corpusExamplesApi = corpusExamplesMod as unknown as CorpusExamplesExtended

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
  { re: /wink|smug|doya|pose|sing|plan/i, role: 'playful', label: '俏皮/得意/摆姿势' },
  { re: /shy|blush|fidget|armescape/i, role: 'shy', label: '害羞/局促' },
  { re: /trouble|worry/i, role: 'trouble', label: '为难/困扰' },
  { re: /sad|sigh|lookdown|cry/i, role: 'sad', label: '低落/叹气' },
  { re: /angry|disgust/i, role: 'angry', label: '生气/不满' },
  { re: /forward|point/i, role: 'forward', label: '前倾认真' },
  { re: /think|lookaway|lookup/i, role: 'think', label: '思考/移开视线' },
  { re: /surprise|shock|scared/i, role: 'surprise', label: '惊讶/受惊' },
  { re: /relief/i, role: 'relief', label: '松一口气' },
  {
    re: /greeting|shakehand|handshake|wave|byebye|salute/i,
    role: 'greeting',
    label: '大挥手/打招呼（仅限招呼/告别）'
  },
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

export function inspectMotion(modelPath: string | undefined, motionName: string): MotionInspection {
  if (typeof facialApi.inspectModelMotion === 'function') {
    return facialApi.inspectModelMotion(modelPath, motionName)
  }
  return fallbackInspectMotion(motionName)
}

export function annotateMotion(modelPath: string | undefined, motionName: string): string {
  if (typeof facialApi.annotateMotionName === 'function') {
    return facialApi.annotateMotionName(modelPath, motionName)
  }
  const info = fallbackInspectMotion(motionName)
  return info.label ? `${motionName}(${info.label})` : motionName
}

export function getActingProfile(nameOrPath: string, roleHint = ''): CharacterActingProfile {
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

export function inferDramaticMoodFallback(params: {
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

export function checkMotionCompatibility(params: {
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
  if (
    /greeting|shakehand|handshake|wave|byebye|salute/i.test(params.motion) &&
    !facialSemanticsMod.GREETING_CONTEXT_TEXT_RE.test(params.content)
  ) {
    return { ok: false, reason: 'greeting_motion_without_greeting_context' }
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

export function moodToTargetMood(mood: DramaticContextMood): facialSemanticsMod.TargetMood {
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

export function annotateFacial(modelPath: string | undefined, facialName: string): string {
  return facialSemanticsMod.annotateFacialName(modelPath, facialName)
}

export function parseToolArgs(raw: unknown): Record<string, unknown> {
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

export function addUsage(acc: ChatUsage, delta: ChatUsage | null): void {
  if (!delta) return
  if (delta.promptTokens !== undefined)
    acc.promptTokens = (acc.promptTokens ?? 0) + delta.promptTokens
  if (delta.completionTokens !== undefined) {
    acc.completionTokens = (acc.completionTokens ?? 0) + delta.completionTokens
  }
  if (delta.totalTokens !== undefined) acc.totalTokens = (acc.totalTokens ?? 0) + delta.totalTokens
}

export function findModel(
  view: CatalogView,
  modelId?: unknown,
  character?: unknown,
  options: { unitHint?: string; contextText?: string } = {}
): CatalogModel | null {
  if (typeof modelId === 'number' && Number.isFinite(modelId)) {
    const byId = view.modelById(modelId)
    if (byId) return byId
  }
  const q = typeof character === 'string' ? character.trim().toLowerCase() : ''
  if (!q) return null
  const primary = view.primaryModels()
  const searchPool = [...primary, ...view.models.filter((m) => !primary.includes(m))]
  const matched =
    searchPool.find(
      (m) =>
        m.name.toLowerCase() === q ||
        (m.shortName ?? '').toLowerCase() === q ||
        (m.cloudId ?? '').toLowerCase() === q
    ) ??
    searchPool.find(
      (m) =>
        m.name.toLowerCase().includes(q) || (m.shortName && q.includes(m.shortName.toLowerCase()))
    ) ??
    null
  if (!matched) return null
  const charOutfitSignal =
    typeof character === 'string' &&
    character.trim() &&
    character.trim().toLowerCase() !== matched.name.toLowerCase() &&
    character.trim().toLowerCase() !== (matched.shortName ?? '').toLowerCase()
      ? character.trim()
      : ''
  const outfitHint = [options.unitHint, charOutfitSignal, options.contextText]
    .filter(Boolean)
    .join(' ')
    .trim()
  if (outfitHint) {
    return view.resolveOutfitVariant(matched, outfitHint) ?? matched
  }
  return matched
}

export function countBodyMotionsByModel(story: StoryData): Record<string, number> {
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

export function expandMoodTokens(mood: string): string[] {
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

export function extractDialogueLinesFromStory(
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

export function isStoryObjectCandidate(val: unknown): boolean {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return false
  const rec = val as Record<string, unknown>
  return Array.isArray(rec.snippets)
}
