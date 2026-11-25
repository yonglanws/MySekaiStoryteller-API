import fs from 'node:fs'
import path from 'node:path'

export type FacialSemanticRole =
  | 'genuine_smile'
  | 'closed_smile'
  | 'wry_smile'
  | 'tearful_smile'
  | 'playful'
  | 'neutral'
  | 'closed_neutral'
  | 'closed_troubled'
  | 'serious'
  | 'cold_hollow'
  | 'sad'
  | 'trouble'
  | 'cry'
  | 'angry'
  | 'surprise'
  | 'shy'
  | 'sleepy'
  | 'other'

export interface FacialInspection {
  role: FacialSemanticRole
  label: string
  fromMotion3: boolean
}

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

export interface MotionInspection {
  role: MotionSemanticRole
  label: string
  style: string
  durationSec?: number
  fromMotion3: boolean
}

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

export interface DramaticContextSummary {
  mood: DramaticContextMood
  tense: boolean
  apologyOrRegret: boolean
  questionOrDoubt: boolean
  cheerful: boolean
  resolve: boolean
  monologue: boolean
}

const facialCache = new Map<string, FacialInspection>()
const motionCache = new Map<string, MotionInspection>()
let cachedModelsRoot: string | null | undefined

/** 查找本地 `resources/models` 根目录；找不到时返回 null（退化为名字语义分析）。 */
export function resolveModelsRoot(explicitRoot?: string): string | null {
  if (explicitRoot) {
    return fs.existsSync(explicitRoot) ? explicitRoot : null
  }
  if (cachedModelsRoot !== undefined) return cachedModelsRoot

  const envResourceDir = process.env.MSS_RESOURCE_DIR?.trim()
  const candidates = [
    envResourceDir ? path.join(envResourceDir, 'models') : '',
    path.resolve(process.cwd(), 'resources', 'models'),
    path.resolve(__dirname, '../../../resources/models'),
    path.resolve(__dirname, '../../../../resources/models')
  ].filter(Boolean)

  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      cachedModelsRoot = dir
      return dir
    }
  }
  cachedModelsRoot = null
  return null
}

function readMotion3Data(motion3Path: string): {
  curves: Map<string, number>
  durationSec?: number
} | null {
  try {
    const raw = fs.readFileSync(motion3Path, 'utf8')
    const parsed = JSON.parse(raw) as {
      Meta?: { Duration?: number }
      Curves?: Array<{ Id?: string; Segments?: number[] }>
    }
    if (!Array.isArray(parsed.Curves)) return null
    const values = new Map<string, number>()
    for (const curve of parsed.Curves) {
      const id = typeof curve?.Id === 'string' ? curve.Id : ''
      const segs = curve?.Segments
      if (!id || !Array.isArray(segs) || segs.length < 2) continue
      // 取动作稳定段（末尾关键帧值若存在则优先末尾，否则取首关键帧值）
      const val =
        segs.length >= 4 && typeof segs[segs.length - 1] === 'number'
          ? segs[segs.length - 1]
          : segs[1]
      if (typeof val === 'number' && Number.isFinite(val)) {
        values.set(id, val)
      }
    }
    const durationSec =
      typeof parsed.Meta?.Duration === 'number' && Number.isFinite(parsed.Meta.Duration)
        ? parsed.Meta.Duration
        : undefined
    return { curves: values, durationSec }
  } catch {
    return null
  }
}

function resolveMotion3File(
  modelPath: string,
  clipName: string,
  modelsRoot: string
): string | null {
  const clean = modelPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const modelDir = path.dirname(clean)
  if (!modelDir || modelDir === '.') return null
  for (const sub of ['motions', 'motion']) {
    const full = path.join(modelsRoot, modelDir, sub, `${clipName}.motion3.json`)
    if (fs.existsSync(full)) return full
  }
  return null
}

/** 剥离 `face_nc*` / `face_os*` / `face_night_*` / `face_band_*` 等官方前缀以便统一识别语义。 */
function stripFacialVariantPrefix(lower: string): string {
  return lower.replace(/^face_(?:night_|band_|wonder_|lion|osnc|os|nc)/, 'face_')
}

function classifyByName(facialName: string): FacialInspection {
  const rawLower = facialName
    .trim()
    .toLowerCase()
    .replace(/^face_\s+/, 'face_')
  if (/^face_dark/.test(rawLower)) {
    if (rawLower.includes('smile'))
      return { role: 'wry_smile', label: '阴郁苦笑/假笑', fromMotion3: false }
    if (rawLower.includes('sad') || rawLower.includes('heartbreak')) {
      return { role: 'sad', label: '阴郁低落', fromMotion3: false }
    }
    if (rawLower.includes('angry') || rawLower.includes('disgust')) {
      return { role: 'angry', label: '阴沉冷怒', fromMotion3: false }
    }
    if (rawLower.includes('trouble'))
      return { role: 'trouble', label: '阴郁困扰', fromMotion3: false }
    if (rawLower.includes('closeeye'))
      return { role: 'closed_troubled', label: '沉重闭眼', fromMotion3: false }
    if (rawLower.includes('serious'))
      return { role: 'serious', label: '阴沉认真', fromMotion3: false }
    if (rawLower.includes('shy')) return { role: 'shy', label: '阴郁局促', fromMotion3: false }
    if (rawLower.includes('surprise'))
      return { role: 'surprise', label: '阴郁惊愕', fromMotion3: false }
    return { role: 'cold_hollow', label: '阴沉面无表情', fromMotion3: false }
  }
  if (/^face_nhi/.test(rawLower)) {
    if (rawLower.includes('smile'))
      return { role: 'wry_smile', label: '空洞假笑', fromMotion3: false }
    if (rawLower.includes('cry')) return { role: 'cry', label: '失神落泪', fromMotion3: false }
    if (rawLower.includes('sad')) return { role: 'sad', label: '空洞失落', fromMotion3: false }
    if (rawLower.includes('surprise') || rawLower.includes('baffling')) {
      return { role: 'surprise', label: '空洞惊愕', fromMotion3: false }
    }
    return { role: 'cold_hollow', label: '空洞/冷眼', fromMotion3: false }
  }
  if (/^face_(?:coldeyes|emptiness|shadow|slitmouth)/.test(rawLower)) {
    return { role: 'cold_hollow', label: '空洞/冷眼', fromMotion3: false }
  }

  const lower = stripFacialVariantPrefix(rawLower)
  if (/^face_(?:purpose|fight)/.test(lower)) {
    return { role: 'serious', label: '坚定/决心', fromMotion3: false }
  }
  if (/^face_(?:sharp|serious)/.test(lower)) {
    return { role: 'serious', label: '认真/锐利', fromMotion3: false }
  }
  if (/^face_smile/.test(lower)) {
    return { role: 'genuine_smile', label: '微笑', fromMotion3: false }
  }
  if (/^face_(?:wink|smug|doya|play|sing|sparkling|delicious|eat|interest|spoony)/.test(lower)) {
    return { role: 'playful', label: '俏皮/得意/闪亮', fromMotion3: false }
  }
  if (/^face_closeeye/.test(lower)) {
    return { role: 'closed_neutral', label: '轻闭眼', fromMotion3: false }
  }
  if (/^face_(?:cry|ecry)/.test(lower)) {
    return { role: 'cry', label: '落泪/哭泣', fromMotion3: false }
  }
  if (
    /^face_(?:sad|lookdown|sigh|regret|tired|exhaustion|heartbreak|desperate|baffling)/.test(lower)
  ) {
    return { role: 'sad', label: '低落/失落', fromMotion3: false }
  }
  if (
    /^face_(?:trouble|worry|dizzy|hawawa|guruguru|think|breath|fever|sneeze|disgorge)/.test(lower)
  ) {
    return { role: 'trouble', label: '困扰/为难', fromMotion3: false }
  }
  if (/^face_(?:angry|disgust|complain|hate|scream)/.test(lower)) {
    return { role: 'angry', label: '生气/不满', fromMotion3: false }
  }
  if (
    /^face_(?:surprise|shock|notice|scared|nsscared|^e(?:_|$))/.test(lower) ||
    /^face_e(?:_|$)/.test(lower)
  ) {
    return { role: 'surprise', label: '惊讶/吃惊', fromMotion3: false }
  }
  if (/^face_(?:shy|blush)/.test(lower)) {
    return { role: 'shy', label: '害羞/微红', fromMotion3: false }
  }
  if (/^face_sleepy/.test(lower)) {
    return { role: 'sleepy', label: '犯困/倦意', fromMotion3: false }
  }
  if (/^face_(?:normal|smallmouth|lookaway|robot)/.test(lower)) {
    return { role: 'neutral', label: '平静自然', fromMotion3: false }
  }
  return { role: 'other', label: '常规神情', fromMotion3: false }
}

function classifyCurves(facialName: string, curves: Map<string, number>): FacialInspection {
  const num = (id: string): number => curves.get(id) ?? 0
  const eyeOpen = Math.min(num('ParamEyeLOpen'), num('ParamEyeROpen'))
  const eyeSmile = (num('ParamEyeLSmile') + num('ParamEyeRSmile')) / 2
  const browY = (num('ParamBrowLY') + num('ParamBrowRY')) / 2
  const browAngle = (num('ParamBrowLAngle') + num('ParamBrowRAngle')) / 2
  const mouthForm = num('ParamMouthForm')
  const mouthOpen = num('ParamMouthOpenY')
  const tear = Math.max(num('ParamTear'), num('ParamEyeTeary'))
  const cheek = Math.max(num('ParamCheek'), num('ParamCheek2'))
  const shadow = Math.abs(num('ParamFaceShadow'))
  const sweat = Math.max(num('ParamSweatOn'), num('ParamSweatOn2'))
  const eyeHi = curves.has('ParamEyeHi') ? num('ParamEyeHi') : 0
  const rawLower = facialName.toLowerCase()
  const lower = stripFacialVariantPrefix(rawLower)

  const closed = eyeOpen <= 0.08
  const darkPrefix =
    rawLower.startsWith('face_dark') || rawLower.includes('nhi') || shadow > 0.15 || eyeHi < -0.2
  const isExplicitSurpriseName = /^face_(?:surprise|shock|notice|scared|nsscared|e(?:_|$))/.test(
    lower
  )

  if (isExplicitSurpriseName) {
    const base = classifyByName(facialName)
    return { ...base, role: 'surprise', fromMotion3: true }
  }

  if (tear > 0.2) {
    if (mouthForm >= 0.25 || eyeSmile >= 0.4) {
      return { role: 'tearful_smile', label: '含泪微笑', fromMotion3: true }
    }
    return { role: 'cry', label: '含泪/哭泣', fromMotion3: true }
  }

  if (lower.startsWith('face_smile') || lower.startsWith('face_closeeye')) {
    // 真正的苦笑/勉强笑：嘴角上扬但眼笑为负（眼底紧绷）、冒冷汗、带脸部阴影，或深蹙眉且无眼笑
    const hasTenseEyes = eyeSmile < -0.15
    const hasStrainedBrow = browY <= -0.55 && eyeSmile < 0.25 && cheek < 0.3
    const hasClosedTension = closed && (browY <= -0.35 || eyeSmile < -0.15 || sweat > 0.2)
    if (hasTenseEyes || sweat > 0.2 || shadow > 0.15 || hasStrainedBrow || hasClosedTension) {
      if (lower.startsWith('face_smile') && mouthForm >= 0.2) {
        return { role: 'wry_smile', label: '苦笑/勉强笑', fromMotion3: true }
      }
      if (closed) {
        return { role: 'closed_troubled', label: '闭眼为难/紧绷', fromMotion3: true }
      }
    }
    if (closed && (eyeSmile >= 0.4 || mouthForm >= 0.3)) {
      return {
        role: 'closed_smile',
        label: mouthOpen >= 0.4 ? '闭眼大笑' : '闭眼微笑',
        fromMotion3: true
      }
    }
    if (lower.startsWith('face_smile')) {
      if (cheek >= 0.5 && mouthForm >= 0.3) {
        return { role: 'genuine_smile', label: '红晕开心笑', fromMotion3: true }
      }
      if (eyeSmile >= 0.4 && mouthForm >= 0.3) {
        return {
          role: 'genuine_smile',
          label: mouthOpen >= 0.4 ? '开朗大笑' : '温和微笑',
          fromMotion3: true
        }
      }
      if (mouthForm >= 0.15) {
        return { role: 'genuine_smile', label: '浅笑', fromMotion3: true }
      }
      return { role: 'wry_smile', label: '克制微苦笑', fromMotion3: true }
    }
    if (closed) {
      return {
        role: browY < -0.25 ? 'closed_troubled' : 'closed_neutral',
        label: browY < -0.25 ? '闭眼隐忍/思考' : '安静闭眼',
        fromMotion3: true
      }
    }
  }

  if (darkPrefix) {
    if (rawLower.includes('smile') || mouthForm >= 0.2) {
      return { role: 'wry_smile', label: '阴郁假笑/勉强笑', fromMotion3: true }
    }
    if (mouthForm <= 0.05) {
      return {
        role: rawLower.includes('sad')
          ? 'sad'
          : rawLower.includes('angry')
            ? 'angry'
            : 'cold_hollow',
        label: rawLower.includes('sad')
          ? '阴郁低落'
          : rawLower.includes('angry')
            ? '阴沉压迫'
            : '阴暗/失神冷脸',
        fromMotion3: true
      }
    }
  }

  if (
    lower.includes('shy') ||
    lower.includes('blush') ||
    (cheek >= 0.5 && browAngle >= -0.1 && mouthForm >= -0.1 && !lower.includes('angry'))
  ) {
    return { role: 'shy', label: '脸红/害羞', fromMotion3: true }
  }

  if (browAngle <= -0.3 && mouthForm <= 0.05) {
    return { role: 'angry', label: '蹙眉不满/生气', fromMotion3: true }
  }

  if (browY <= -0.25 && browAngle >= 0.25 && !lower.includes('smile')) {
    return { role: 'trouble', label: '苦恼/不安', fromMotion3: true }
  }

  const base = classifyByName(facialName)
  return { ...base, fromMotion3: true }
}

/**
 * 结合本地 motion3 参数与表情命名，返回高精度语义分类与中文简注。
 */
export function inspectModelFacial(
  modelPath: string | undefined,
  facialName: string,
  modelsRoot?: string
): FacialInspection {
  const cleanName = facialName.trim()
  if (!cleanName) return { role: 'other', label: '', fromMotion3: false }
  const root = resolveModelsRoot(modelsRoot)
  const cacheKey = `${root ?? ''}|${modelPath ?? ''}|${cleanName}`
  const hit = facialCache.get(cacheKey)
  if (hit) return hit

  let result: FacialInspection | null = null
  if (root && modelPath) {
    const file = resolveMotion3File(modelPath, cleanName, root)
    if (file) {
      const parsed = readMotion3Data(file)
      if (parsed) result = classifyCurves(cleanName, parsed.curves)
    }
  }
  if (!result) result = classifyByName(cleanName)
  facialCache.set(cacheKey, result)
  return result
}

export function annotateFacialName(
  modelPath: string | undefined,
  facialName: string,
  modelsRoot?: string
): string {
  const info = inspectModelFacial(modelPath, facialName, modelsRoot)
  return info.label ? `${facialName}(${info.label})` : facialName
}

function parseMotionStem(motionName: string): { style: string; stem: string } {
  const clean = motionName.trim()
  const lower = clean.toLowerCase()
  const parts = lower.split('-')
  const style = parts.length >= 3 ? parts[1] : ''
  const tail = parts[parts.length - 1] ?? lower
  const stem = tail
    .replace(/_nb$/i, '')
    .replace(/\d+[a-z]?$/i, '')
    .replace(/[A-Z]$/, '')
    .replace(/^nb/, '')
  return { style, stem }
}

function classifyMotionByName(motionName: string): MotionInspection {
  const clean = motionName.trim()
  const lower = clean.toLowerCase()
  const { style, stem } = parseMotionStem(clean)

  if (
    /^(?:front|left|right)clear$/.test(stem) ||
    lower.startsWith('still_') ||
    lower.startsWith('s-')
  ) {
    return { role: 'special', label: '特殊演出姿势', style, fromMotion3: false }
  }
  if (stem === 'default' || stem === 'stand') {
    return { role: 'standing', label: '默认站姿', style, fromMotion3: false }
  }
  if (stem === 'angrynod') {
    return { role: 'angry', label: '气愤点头', style, fromMotion3: false }
  }
  if (stem === 'angry' || stem === 'poseangry' || stem === 'disgust') {
    return {
      role: 'angry',
      label: stem === 'disgust' ? '厌恶/不满' : '生气/不满',
      style,
      fromMotion3: false
    }
  }
  if (stem === 'shakeheadsad') {
    return { role: 'sad', label: '失落摇头', style, fromMotion3: false }
  }
  if (
    stem === 'sad' ||
    stem === 'posesad' ||
    stem === 'lookdown' ||
    stem === 'poselookdown' ||
    stem === 'cry'
  ) {
    return {
      role: 'sad',
      label: stem.includes('lookdown') ? '低头垂眸' : '低落/难过',
      style,
      fromMotion3: false
    }
  }
  if (stem === 'trouble' || stem === 'posetrouble' || stem === 'sigh' || stem === 'regret') {
    return {
      role: 'trouble',
      label: stem.startsWith('sigh') ? '叹气/无奈' : stem === 'regret' ? '懊悔/愧疚' : '困扰/为难',
      style,
      fromMotion3: false
    }
  }
  if (stem === 'shy' || stem === 'blushed' || stem === 'fidget' || stem.startsWith('armescape')) {
    return {
      role: 'shy',
      label: stem === 'fidget' || stem.startsWith('armescape') ? '局促/躲闪' : '害羞/不好意思',
      style,
      fromMotion3: false
    }
  }
  if (stem === 'surprise') {
    return { role: 'surprise', label: '吃惊/一震', style, fromMotion3: false }
  }
  if (stem === 'relief') {
    return { role: 'relief', label: '松一口气', style, fromMotion3: false }
  }
  if (stem === 'greeting') {
    return { role: 'greeting', label: '打招呼/致意', style, fromMotion3: false }
  }
  if (
    stem === 'glad' ||
    stem === 'poseglad' ||
    stem === 'guts' ||
    stem === 'wandahoi' ||
    stem === 'joy' ||
    stem === 'delicious'
  ) {
    return {
      role: 'glad',
      label: stem === 'guts' ? '握拳打气' : stem === 'wandahoi' ? '欢呼雀跃' : '开心/轻快',
      style,
      fromMotion3: false
    }
  }
  if (
    stem === 'smug' ||
    stem === 'wink' ||
    stem === 'joke' ||
    stem === 'pride' ||
    stem === 'piece' ||
    stem === 'pose'
  ) {
    return { role: 'playful', label: '得意/俏皮/摆姿', style, fromMotion3: false }
  }
  if (
    stem === 'forward' ||
    stem === 'poseforward' ||
    stem === 'forwardnod' ||
    stem === 'purpose' ||
    stem === 'plan' ||
    stem === 'handshake' ||
    stem === 'shakehand'
  ) {
    return {
      role: 'forward',
      label:
        stem === 'purpose'
          ? '坚定/下定决心'
          : stem.includes('hand')
            ? '握手/呼应'
            : '前倾/认真倾诉',
      style,
      fromMotion3: false
    }
  }
  if (
    stem === 'think' ||
    stem.startsWith('look') ||
    stem === 'sleep' ||
    stem === 'guruguru' ||
    stem === 'yurayura'
  ) {
    return {
      role: 'think',
      label:
        stem.includes('lookaway') ||
        stem.includes('lookleft') ||
        stem.includes('lookright') ||
        stem.includes('lookside')
          ? '移开视线/环顾'
          : stem === 'sleep'
            ? '犯困/迷糊'
            : '思索/沉吟',
      style,
      fromMotion3: false
    }
  }
  if (stem === 'shakehead') {
    return { role: 'shakehead', label: '摇头否认', style, fromMotion3: false }
  }
  if (stem === 'nod' || stem === 'posenod' || stem === 'tiltheadnod') {
    return { role: 'nod', label: '点头回应', style, fromMotion3: false }
  }
  if (
    stem.startsWith('tilthead') ||
    stem === 'posetilthead' ||
    stem === 'tilt' ||
    stem === 'cheek'
  ) {
    return { role: 'tilthead', label: '歪头/倾听', style, fromMotion3: false }
  }
  return { role: 'other', label: '自然动作', style, fromMotion3: false }
}

/** 识别身体动作的剧情语义角色、风格与时长（若本地有 motion3 则读取 Duration）。 */
export function inspectModelMotion(
  modelPath: string | undefined,
  motionName: string,
  modelsRoot?: string
): MotionInspection {
  const cleanName = motionName.trim()
  if (!cleanName) return { role: 'other', label: '', style: '', fromMotion3: false }
  const root = resolveModelsRoot(modelsRoot)
  const cacheKey = `${root ?? ''}|${modelPath ?? ''}|${cleanName}`
  const hit = motionCache.get(cacheKey)
  if (hit) return hit

  const base = classifyMotionByName(cleanName)
  if (root && modelPath) {
    const file = resolveMotion3File(modelPath, cleanName, root)
    if (file) {
      const parsed = readMotion3Data(file)
      if (parsed) {
        const enriched: MotionInspection = {
          ...base,
          ...(parsed.durationSec !== undefined ? { durationSec: parsed.durationSec } : {}),
          fromMotion3: true
        }
        motionCache.set(cacheKey, enriched)
        return enriched
      }
    }
  }
  motionCache.set(cacheKey, base)
  return base
}

export function annotateMotionName(
  modelPath: string | undefined,
  motionName: string,
  modelsRoot?: string
): string {
  const info = inspectModelMotion(modelPath, motionName, modelsRoot)
  return info.label ? `${motionName}(${info.label})` : motionName
}

export function isSpecialOrStandingMotion(motionName: string): boolean {
  const role = classifyMotionByName(motionName).role
  return role === 'standing' || role === 'special'
}

export function isSmileLikeFacial(
  facialName: string,
  modelPath?: string,
  modelsRoot?: string
): boolean {
  const { role } = inspectModelFacial(modelPath, facialName, modelsRoot)
  return role === 'genuine_smile' || role === 'closed_smile' || role === 'playful'
}

export function isPositiveOnlyFacial(
  facialName: string,
  modelPath?: string,
  modelsRoot?: string
): boolean {
  const { role } = inspectModelFacial(modelPath, facialName, modelsRoot)
  return role === 'genuine_smile' || role === 'closed_smile' || role === 'playful'
}

export function isSadOrAngryFacial(
  facialName: string,
  modelPath?: string,
  modelsRoot?: string
): boolean {
  const { role } = inspectModelFacial(modelPath, facialName, modelsRoot)
  return (
    role === 'sad' ||
    role === 'trouble' ||
    role === 'cry' ||
    role === 'angry' ||
    role === 'cold_hollow' ||
    role === 'closed_troubled'
  )
}

const POSITIVE_TEXT_CUE_RE =
  /(开心|高兴|太好了|好耶|太棒了|哈哈|呵呵|嘿嘿|嘻嘻|太幸运|真期待|好期待|好温柔|真漂亮|好喜欢|最喜欢|不愧是|Wonderhoy|真可爱|辛苦啦|♪)/
const NEGATIVE_TEXT_CUE_RE =
  /(难过|伤心|痛苦|抱歉|对不起|对不住|失落|害怕|恐惧|担心|不安|烦死|气死|讨厌|委屈|眼泪|哭|叹气|沉默|沉重|糟糕|惨了|完蛋|不行|做不到|算了|别管|没空|冷漠|无聊|疲惫|累了|苦恼|烦恼|头疼|纠结|勉强|搞砸|后悔|愧疚|窒息|受不了|没办法面对|不可能一样|不一样了|绝望|崩溃|煎熬|无能为力|没能说出口|什么都没能|不敢|顾虑|推开|逃走|别走)/
const APOLOGY_REGRET_RE = /(对不起|抱歉|对不住|都是我的错|搞砸|愧疚|后悔|不好意思让你)/
const SELF_BLAME_REGRET_RE =
  /(?:对不起|抱歉|对不住|都是我的错|搞砸|愧疚|后悔|不好意思让你|为什么我.{0,8}(?:没能|没有|什么都没|说不出口|做不到)|明明只要|是我不好|我真没用|怪我自己)/
const DESPAIR_TEXT_RE =
  /(?:窒息|受不了|没办法面对|不可能一样|不一样了|绝望|崩溃|好痛苦|撑不住|别说了|再见|别走|推开|(?<!不会|不|别)逃走|顾虑|装作什么都没发生)/
const NEGATED_JOY_RE = /(?:不|没|没有|别|哪有|才不|才没有|算不上).{0,3}(?:开心|高兴|笑得出来|轻松)/
const SURPRISE_TEXT_RE =
  /(?:^|[，。！？\s])(?:咦|诶|欸|吓我一跳|真的吗|怎么会|居然|骗人|……！|！！|\?!|？！)/
const GENUINE_SURPRISE_TEXT_RE =
  /(?:^|[，。！？\s「（(])(?:咦|诶|欸|哎|啊咧|吓我一跳|吓了一跳|真的吗|怎么会|居然|骗人|不会吧|什么意思|等一下|发生了什么|怎么突然|没想到|竟然)|(?:\?!|？！)/
const SHY_TEXT_RE = /(?:才没有|才不是|别看我|好害羞|脸红|讨厌啦|哪有那样|少、少啰嗦)/
const RESOLVE_TEXT_RE = /(?:决定|一定|必须|绝对要|不会逃|试一次|认真听|听我说|交给我吧)/
const REASSURE_TEXT_RE =
  /(?:没关系|别担心|不用担心|慢慢来|有我在|辛苦了|别勉强|不用勉强|休息一下|不用急)/
const ANGRY_TEXT_RE = /(?:别再|不要再|少啰嗦|闭嘴|搞什么|烦死|气死|够了|混蛋|笨蛋|别逃)/
const AWKWARD_TEXT_RE = /(?:苦笑|真拿你没办法|呃……|那个……|说不上来|唉|算了)/
const INNER_MONOLOGUE_RE = /^[（(][^（）()]+[）)]$/

/** 根据台词文本、TTS 情绪、上一拍上下文与角色角色位推断当前演出的戏剧语境。 */
export function inferDramaticContext(params: {
  content: string
  emotion?: string
  prevContent?: string
  prevEmotion?: string
  isMonologue?: boolean
  isListener?: boolean
  isEntryExit?: boolean
  restrainedRole?: boolean
  ttsCaption?: string
}): DramaticContextSummary {
  const text = (params.content ?? '').trim()
  const emo = (params.emotion ?? '').trim()
  const prevEmo = (params.prevEmotion ?? '').trim()
  const prevText = (params.prevContent ?? '').trim()
  const caption = (params.ttsCaption ?? '').trim()

  const monologue = Boolean(params.isMonologue) || INNER_MONOLOGUE_RE.test(text)
  const apologyOrRegret = APOLOGY_REGRET_RE.test(text) || SELF_BLAME_REGRET_RE.test(text)
  const isDespair = DESPAIR_TEXT_RE.test(text)
  const reassure = REASSURE_TEXT_RE.test(text) && !apologyOrRegret && !isDespair
  const hasNegCue = (NEGATIVE_TEXT_CUE_RE.test(text) || NEGATED_JOY_RE.test(text)) && !reassure
  const hasPosCue = POSITIVE_TEXT_CUE_RE.test(text) && !NEGATED_JOY_RE.test(text)
  const questionOrDoubt = /[？?]/.test(text) || /(?:难道|为什么|怎么|是不是)/.test(text)
  const resolve = RESOLVE_TEXT_RE.test(text) && !hasNegCue
  const tense =
    emo === '生气' ||
    emo === '伤心' ||
    emo === '害怕' ||
    prevEmo === '生气' ||
    prevEmo === '伤心' ||
    ANGRY_TEXT_RE.test(text) ||
    ANGRY_TEXT_RE.test(prevText)

  if (params.isEntryExit) {
    return {
      mood: 'entry_exit',
      tense,
      apologyOrRegret,
      questionOrDoubt,
      cheerful: hasPosCue,
      resolve,
      monologue
    }
  }

  let mood: DramaticContextMood = 'neutral'
  if (params.isListener) {
    if (monologue) mood = 'attentive_listen'
    else if (emo === '生气' || ANGRY_TEXT_RE.test(text)) mood = 'sad_regret'
    else if (emo === '伤心' || emo === '害怕' || apologyOrRegret || isDespair) mood = 'sad_regret'
    else if (reassure) mood = 'gentle_reassure'
    else if (emo === '惊讶' || SURPRISE_TEXT_RE.test(text)) {
      mood =
        hasNegCue || prevEmo === '伤心' || prevEmo === '生气' ? 'sad_regret' : 'attentive_listen'
    } else if (emo === '开心' || (hasPosCue && !tense)) mood = 'cheerful_banter'
    else mood = 'attentive_listen'
  } else if (emo === '生气' || (ANGRY_TEXT_RE.test(text) && !hasPosCue)) {
    mood = 'angry_frustration'
  } else if (emo === '伤心' || emo === '害怕' || apologyOrRegret || isDespair) {
    mood = 'sad_regret'
  } else if (emo === '惊讶' || SURPRISE_TEXT_RE.test(text)) {
    mood = 'surprise'
  } else if (emo === '害羞' || SHY_TEXT_RE.test(text)) {
    mood = 'shy_hesitation'
  } else if (monologue) {
    mood = hasNegCue ? 'sad_regret' : 'thinking_monologue'
  } else if (reassure) {
    mood = 'gentle_reassure'
  } else if (hasNegCue || AWKWARD_TEXT_RE.test(text) || /苦笑|ため息|照れ/.test(caption)) {
    mood = apologyOrRegret ? 'sad_regret' : 'awkward'
  } else if (resolve) {
    mood = 'inner_resolve'
  } else if (emo === '开心' || (hasPosCue && !tense)) {
    mood = 'cheerful_banter'
  } else if (/思考|想想|……/.test(text) && questionOrDoubt) {
    mood = 'thinking_monologue'
  }

  return {
    mood,
    tense,
    apologyOrRegret,
    questionOrDoubt,
    cheerful: mood === 'cheerful_banter',
    resolve,
    monologue
  }
}

export interface FacialCompatibilityResult {
  ok: boolean
  reason?: string
}

/**
 * 校验某句台词的 facial 是否与情绪标签、文本语境及前一拍气氛明显冲突。
 */
export function isFacialCompatibleWithLine(params: {
  facial: string
  modelPath?: string
  emotion?: string
  content: string
  prevTense?: boolean
  isMonologue?: boolean
  isListener?: boolean
  restrainedRole?: boolean
  modelsRoot?: string
}): FacialCompatibilityResult {
  const {
    facial,
    modelPath,
    emotion,
    content,
    prevTense,
    isMonologue,
    isListener,
    restrainedRole,
    modelsRoot
  } = params
  if (!facial.trim()) return { ok: true }
  const info = inspectModelFacial(modelPath, facial, modelsRoot)
  const emo = (emotion ?? '').trim()
  const text = content.trim()
  const ctx = inferDramaticContext({
    content: text,
    emotion: emo,
    isMonologue,
    isListener,
    restrainedRole
  })
  const hasNegCue =
    (NEGATIVE_TEXT_CUE_RE.test(text) || NEGATED_JOY_RE.test(text)) && ctx.mood !== 'gentle_reassure'
  const hasPosCue = POSITIVE_TEXT_CUE_RE.test(text) && !NEGATED_JOY_RE.test(text)
  const isTenseEmotion = emo === '生气' || emo === '伤心' || emo === '害怕' || emo === '惊讶'

  // 1) 明确负面/紧张/道歉/惊愕情绪绝对禁止搭配纯正微笑/俏皮表情（苦笑 wry_smile 与含泪微笑 tearful_smile 除外）
  if (
    (isTenseEmotion || hasNegCue || ctx.apologyOrRegret || ctx.mood === 'sad_regret') &&
    (info.role === 'genuine_smile' || info.role === 'closed_smile' || info.role === 'playful')
  ) {
    return { ok: false, reason: 'negative_context_smile' }
  }

  // 2) 克制型角色（真冬等）或上一拍仍在紧张氛围中，无明确正向台词时不用阳光大笑
  if (
    (restrainedRole || prevTense) &&
    !hasPosCue &&
    emo !== '开心' &&
    (info.role === 'genuine_smile' || info.role === 'closed_smile' || info.role === 'playful')
  ) {
    return { ok: false, reason: 'restrained_or_tense_smile' }
  }

  // 3) 台词和情绪明确开心轻松时，不挂哭泣/暴怒/阴暗冷脸/困扰
  if (
    (emo === '开心' || (hasPosCue && !hasNegCue && !prevTense)) &&
    (info.role === 'sad' ||
      info.role === 'angry' ||
      info.role === 'cry' ||
      info.role === 'cold_hollow' ||
      info.role === 'trouble' ||
      info.role === 'closed_troubled')
  ) {
    return { ok: false, reason: 'positive_context_sad_or_angry' }
  }

  // 4) 认真决心 / 温柔安慰 / 严肃独白时，避免得意俏皮脸（wink/smug/doya）
  if (
    (ctx.mood === 'inner_resolve' ||
      ctx.mood === 'gentle_reassure' ||
      (ctx.mood === 'thinking_monologue' && hasNegCue)) &&
    info.role === 'playful'
  ) {
    return { ok: false, reason: 'playful_on_earnest_or_monologue' }
  }

  // 5) 温柔安抚时不用怒脸/冷眼
  if (ctx.mood === 'gentle_reassure' && (info.role === 'angry' || info.role === 'cold_hollow')) {
    return { ok: false, reason: 'angry_on_reassure' }
  }

  // 6) 悲伤/绝望/独白语境严禁误挂惊讶/察觉/震惊脸（除非台词本身明确是惊讶/恍然大悟）
  const isGenuineShock = emo === '惊讶' || GENUINE_SURPRISE_TEXT_RE.test(text)
  const isScaredOnFear = emo === '害怕' && /scared/i.test(facial)
  if (
    !isListener &&
    info.role === 'surprise' &&
    !isGenuineShock &&
    !isScaredOnFear &&
    (ctx.mood === 'sad_regret' ||
      ctx.mood === 'thinking_monologue' ||
      DESPAIR_TEXT_RE.test(text) ||
      emo === '伤心')
  ) {
    return { ok: false, reason: 'surprise_on_sad_or_monologue' }
  }

  // 7) 含泪自责/伤心懊悔台词（无明确怒气）严禁误挂生气脸
  if (
    info.role === 'angry' &&
    emo !== '生气' &&
    !ANGRY_TEXT_RE.test(text) &&
    (emo === '伤心' ||
      emo === '害怕' ||
      ctx.mood === 'sad_regret' ||
      ctx.apologyOrRegret ||
      SELF_BLAME_REGRET_RE.test(text))
  ) {
    return { ok: false, reason: 'angry_on_sad_or_regret' }
  }

  return { ok: true }
}

export interface MotionCompatibilityResult {
  ok: boolean
  reason?: string
}

/**
 * 校验身体动作（motion）是否贴合台词情绪、听者视角与克制人设。
 */
export function isMotionCompatibleWithLine(params: {
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
}): MotionCompatibilityResult {
  const clean = params.motion.trim()
  if (!clean) return { ok: true }
  const info = inspectModelMotion(params.modelPath, clean, params.modelsRoot)
  if (info.role === 'special') {
    return { ok: false, reason: 'special_clear_motion_in_dialogue' }
  }

  const ctx = inferDramaticContext({
    content: params.content,
    emotion: params.emotion,
    prevContent: params.prevContent,
    prevEmotion: params.prevEmotion,
    isListener: params.isListener,
    restrainedRole: params.restrainedRole
  })
  const tense = ctx.tense || Boolean(params.prevTense)

  // 1) 负面/悲伤/道歉/紧张/愤怒语境禁止用欢快/得意动作（glad / playful / wandahoi）
  if (
    (ctx.mood === 'sad_regret' ||
      ctx.mood === 'angry_frustration' ||
      ctx.apologyOrRegret ||
      (tense && !ctx.cheerful)) &&
    (info.role === 'glad' || info.role === 'playful')
  ) {
    return { ok: false, reason: 'cheerful_motion_on_tense_or_sad_line' }
  }

  // 2) 开心/温柔安抚语境禁止用生气/沮丧/摇头否定动作
  if (
    (ctx.mood === 'cheerful_banter' || ctx.mood === 'gentle_reassure') &&
    (info.role === 'angry' ||
      info.role === 'sad' ||
      (ctx.mood === 'cheerful_banter' && info.role === 'trouble'))
  ) {
    return { ok: false, reason: 'negative_motion_on_positive_line' }
  }

  // 3) 强情绪句（惊讶/生气/悲伤/决心）配静态 default 站姿会显得僵硬
  if (
    (ctx.mood === 'surprise' ||
      ctx.mood === 'angry_frustration' ||
      ctx.mood === 'sad_regret' ||
      ctx.mood === 'inner_resolve') &&
    info.role === 'standing'
  ) {
    return { ok: false, reason: 'standing_motion_on_expressive_beat' }
  }

  // 4) 克制型角色（如真冬）不用夸张俏皮动作
  if (params.restrainedRole && info.role === 'playful') {
    return { ok: false, reason: 'playful_motion_on_restrained_role' }
  }

  const emo = (params.emotion ?? '').trim()
  const text = (params.content ?? '').trim()
  const isDespair = DESPAIR_TEXT_RE.test(text)
  const isGenuineShock = emo === '惊讶' || GENUINE_SURPRISE_TEXT_RE.test(text)

  // 5) 悲伤/绝望/愤怒语境禁止配打招呼/松口气等轻松社交动作
  if (
    (ctx.mood === 'sad_regret' || ctx.mood === 'angry_frustration' || isDespair) &&
    (info.role === 'greeting' || info.role === 'relief')
  ) {
    return { ok: false, reason: 'casual_motion_on_tense_or_sad_line' }
  }

  // 6) 强烈悲伤/自责/听者承压句禁止用无关的歪头动作（避免心碎场面突然卖萌歪头）
  if (
    ctx.mood === 'sad_regret' &&
    info.role === 'tilthead' &&
    (!ctx.questionOrDoubt || Boolean(params.isListener) || isDespair || ctx.apologyOrRegret)
  ) {
    return { ok: false, reason: 'tilthead_motion_on_sad_line' }
  }

  // 7) 悲伤/独白语境（非真正惊讶）禁止误用吃惊动作
  if (
    !isGenuineShock &&
    info.role === 'surprise' &&
    (ctx.mood === 'sad_regret' || ctx.mood === 'thinking_monologue' || isDespair)
  ) {
    return { ok: false, reason: 'surprise_motion_on_sad_or_monologue' }
  }

  // 8) 含泪自责/伤心台词（无明确怒气）禁止误用生气动作
  if (
    ctx.mood === 'sad_regret' &&
    info.role === 'angry' &&
    emo !== '生气' &&
    !ANGRY_TEXT_RE.test(text)
  ) {
    return { ok: false, reason: 'angry_motion_on_sad_or_regret' }
  }

  return { ok: true }
}

/**
 * 选出安全的中性/平静默认表情，优先 normal / smallmouth / serious，避免错误回退到笑脸。
 */
export function pickNeutralFacial(
  facials: string[],
  defaultFacial?: string,
  modelPath?: string,
  restrainedRole?: boolean,
  modelsRoot?: string
): string {
  const preferred = restrainedRole
    ? ['face_normal_01', 'face_smallmouth_01', 'face_serious_01', 'face_darknormal_01']
    : ['face_normal_01', 'face_smallmouth_01', 'face_serious_01']
  for (const cand of preferred) {
    if (facials.includes(cand)) return cand
  }
  for (const f of facials) {
    const role = inspectModelFacial(modelPath, f, modelsRoot).role
    if (role === 'neutral' || role === 'serious') return f
  }
  if (defaultFacial && !isSmileLikeFacial(defaultFacial, modelPath, modelsRoot)) {
    return defaultFacial
  }
  return (
    facials.find((f) => !isSmileLikeFacial(f, modelPath, modelsRoot)) ??
    defaultFacial ??
    facials[0] ??
    'face_normal_01'
  )
}

export type TargetMood =
  | 'sad'
  | 'trouble'
  | 'angry'
  | 'surprise'
  | 'shy'
  | 'neutral'
  | 'smile'
  | 'wry_smile'
  | 'serious'
  | 'gentle'
  | 'thinking'

const FACIAL_ROLES_BY_MOOD: Record<TargetMood, FacialSemanticRole[]> = {
  sad: ['sad', 'closed_troubled', 'trouble', 'cry', 'cold_hollow', 'wry_smile', 'neutral'],
  trouble: ['trouble', 'closed_troubled', 'wry_smile', 'sad', 'serious', 'neutral'],
  angry: ['angry', 'serious', 'cold_hollow', 'trouble', 'neutral'],
  surprise: ['surprise', 'serious', 'trouble', 'neutral'],
  shy: ['shy', 'wry_smile', 'genuine_smile', 'neutral'],
  neutral: ['neutral', 'serious', 'closed_neutral'],
  smile: ['genuine_smile', 'closed_smile', 'playful', 'neutral'],
  wry_smile: ['wry_smile', 'trouble', 'closed_troubled', 'sad', 'neutral'],
  serious: ['serious', 'closed_neutral', 'neutral', 'cold_hollow'],
  gentle: ['genuine_smile', 'closed_smile', 'neutral', 'closed_neutral'],
  thinking: ['closed_neutral', 'serious', 'neutral', 'trouble', 'cold_hollow']
}

function dramaticMoodToTargetMood(mood: DramaticContextMood | TargetMood): TargetMood {
  switch (mood) {
    case 'surprise':
      return 'surprise'
    case 'awkward':
      return 'wry_smile'
    case 'gentle_reassure':
      return 'gentle'
    case 'inner_resolve':
      return 'serious'
    case 'shy_hesitation':
      return 'shy'
    case 'angry_frustration':
      return 'angry'
    case 'sad_regret':
      return 'sad'
    case 'cheerful_banter':
      return 'smile'
    case 'attentive_listen':
      return 'serious'
    case 'thinking_monologue':
      return 'thinking'
    case 'entry_exit':
      return 'neutral'
    default:
      return mood
  }
}

/** 根据目标情绪从角色实际拥有的表情集合中选择最贴切的表情。 */
export function pickMoodMatchedFacial(
  facials: string[],
  mood: TargetMood | DramaticContextMood,
  modelPath?: string,
  restrainedRole?: boolean,
  modelsRoot?: string
): string {
  const targetMood = dramaticMoodToTargetMood(mood)
  const roles =
    targetMood === 'neutral' && restrainedRole
      ? (['neutral', 'serious', 'cold_hollow', 'closed_neutral'] as FacialSemanticRole[])
      : targetMood === 'smile' && restrainedRole
        ? (['wry_smile', 'neutral', 'genuine_smile'] as FacialSemanticRole[])
        : targetMood === 'gentle' && restrainedRole
          ? (['closed_neutral', 'neutral', 'wry_smile', 'genuine_smile'] as FacialSemanticRole[])
          : FACIAL_ROLES_BY_MOOD[targetMood]

  for (const wantedRole of roles) {
    const hit = facials.find(
      (f) => inspectModelFacial(modelPath, f, modelsRoot).role === wantedRole
    )
    if (hit) return hit
  }
  if (
    targetMood === 'sad' ||
    targetMood === 'thinking' ||
    targetMood === 'trouble' ||
    targetMood === 'wry_smile' ||
    targetMood === 'gentle'
  ) {
    const safeFallback = facials.find((f) => {
      const role = inspectModelFacial(modelPath, f, modelsRoot).role
      return (
        role !== 'surprise' &&
        role !== 'angry' &&
        role !== 'genuine_smile' &&
        role !== 'closed_smile' &&
        role !== 'playful'
      )
    })
    if (safeFallback) return safeFallback
  }
  return pickNeutralFacial(facials, undefined, modelPath, restrainedRole, modelsRoot)
}

const MOTION_ROLES_BY_DRAMATIC_MOOD: Record<DramaticContextMood, MotionSemanticRole[]> = {
  surprise: ['surprise', 'forward', 'shakehead', 'tilthead'],
  awkward: ['trouble', 'shy', 'think', 'nod'],
  gentle_reassure: ['nod', 'relief', 'forward', 'tilthead'],
  inner_resolve: ['forward', 'nod', 'relief'],
  shy_hesitation: ['shy', 'trouble', 'think'],
  angry_frustration: ['angry', 'shakehead', 'forward', 'trouble'],
  sad_regret: ['sad', 'trouble', 'shakehead', 'think'],
  cheerful_banter: ['glad', 'playful', 'nod', 'tilthead', 'greeting', 'relief'],
  attentive_listen: ['nod', 'think', 'tilthead', 'relief'],
  thinking_monologue: ['think', 'trouble', 'sad', 'nod'],
  entry_exit: ['nod', 'tilthead', 'greeting', 'relief', 'forward'],
  neutral: ['nod', 'tilthead', 'relief', 'forward', 'think']
}

/** 优先保持动作风格一致（w-normal-* 优先，避免对话中途在 normal 与 cool/cute/happy 风格间突兀跳切）。 */
function sortMotionsByStyleConsistency(motions: string[], preferredStyle?: string): string[] {
  const pref = (preferredStyle ?? '').toLowerCase()
  const rankOf = (m: string): number => {
    const style = parseMotionStem(m).style
    if (pref && pref.startsWith('normal') && style === pref) return 0
    if (style.startsWith('normal')) return 1
    if (pref && style === pref) return 2
    if (!style) return 3
    return 4
  }
  return motions
    .map((m, idx) => ({ m, idx, rank: rankOf(m) }))
    .sort((a, b) => a.rank - b.rank || a.idx - b.idx)
    .map((entry) => entry.m)
}

/** 根据剧情情绪从角色真实动作集中挑选最贴切的身体动作（过滤掉 default 与 special 清场动作）。 */
export function pickMoodMatchedMotion(
  motions: string[],
  mood: DramaticContextMood | TargetMood,
  modelPath?: string,
  restrainedRole?: boolean,
  avoidMotions?: ReadonlySet<string> | string[],
  modelsRoot?: string
): string {
  const dramaticMood: DramaticContextMood =
    mood in MOTION_ROLES_BY_DRAMATIC_MOOD
      ? (mood as DramaticContextMood)
      : mood === 'sad'
        ? 'sad_regret'
        : mood === 'trouble' || mood === 'wry_smile'
          ? 'awkward'
          : mood === 'angry'
            ? 'angry_frustration'
            : mood === 'shy'
              ? 'shy_hesitation'
              : mood === 'smile'
                ? 'cheerful_banter'
                : mood === 'gentle'
                  ? 'gentle_reassure'
                  : mood === 'serious'
                    ? 'inner_resolve'
                    : mood === 'thinking'
                      ? 'thinking_monologue'
                      : (mood as DramaticContextMood)

  const avoid = Array.isArray(avoidMotions) ? new Set(avoidMotions) : avoidMotions
  const activePool = motions.filter((m) => !isSpecialOrStandingMotion(m))
  const pool = sortMotionsByStyleConsistency(activePool.length > 0 ? activePool : motions)
  const wantedRoles =
    MOTION_ROLES_BY_DRAMATIC_MOOD[dramaticMood] ?? MOTION_ROLES_BY_DRAMATIC_MOOD.neutral

  const pickFromRoles = (allowAvoided: boolean): string => {
    for (const wantedRole of wantedRoles) {
      if (restrainedRole && wantedRole === 'playful') continue
      const hit = pool.find((m) => {
        if (!allowAvoided && avoid?.has(m)) return false
        return inspectModelMotion(modelPath, m, modelsRoot).role === wantedRole
      })
      if (hit) return hit
    }
    return ''
  }

  const isOppositeRole = (role: MotionSemanticRole): boolean => {
    if (
      dramaticMood === 'sad_regret' ||
      dramaticMood === 'angry_frustration' ||
      dramaticMood === 'awkward' ||
      dramaticMood === 'shy_hesitation'
    ) {
      return role === 'glad' || role === 'playful'
    }
    if (dramaticMood === 'cheerful_banter') {
      return role === 'sad' || role === 'angry'
    }
    return false
  }

  return (
    pickFromRoles(false) ||
    pool.find(
      (m) => !avoid?.has(m) && !isOppositeRole(inspectModelMotion(modelPath, m, modelsRoot).role)
    ) ||
    pickFromRoles(true) ||
    pool.find((m) => !avoid?.has(m)) ||
    pool[0] ||
    ''
  )
}

/** 为某句台词同时推荐最贴合剧情上下文的表情与身体动作候选列表（自动避开上一拍重复项）。 */
export function recommendActingForLine(params: {
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
}): {
  mood: DramaticContextMood
  facials: string[]
  motions: string[]
} {
  const limit = Math.max(1, Math.min(8, params.limit ?? 4))
  const ctx = inferDramaticContext({
    content: params.content,
    emotion: params.emotion,
    prevContent: params.prevContent,
    prevEmotion: params.prevEmotion,
    isMonologue: params.isMonologue,
    isListener: params.isListener,
    isEntryExit: params.isEntryExit,
    restrainedRole: params.restrainedRole
  })
  const targetMood = dramaticMoodToTargetMood(ctx.mood)
  const wantedFacialRoles =
    targetMood === 'neutral' && params.restrainedRole
      ? (['neutral', 'serious', 'cold_hollow', 'closed_neutral'] as FacialSemanticRole[])
      : targetMood === 'smile' && params.restrainedRole
        ? (['wry_smile', 'neutral', 'genuine_smile'] as FacialSemanticRole[])
        : FACIAL_ROLES_BY_MOOD[targetMood]

  const compatibleFacials = params.facials.filter(
    (f) =>
      isFacialCompatibleWithLine({
        facial: f,
        modelPath: params.modelPath,
        emotion: params.emotion,
        content: params.content,
        prevTense: params.prevTense || ctx.tense,
        isMonologue: params.isMonologue,
        isListener: params.isListener,
        restrainedRole: params.restrainedRole,
        modelsRoot: params.modelsRoot
      }).ok
  )
  const facialPool = compatibleFacials.length > 0 ? compatibleFacials : params.facials
  const rankedFacials: string[] = []
  for (const role of wantedFacialRoles) {
    for (const f of facialPool) {
      if (rankedFacials.length >= limit) break
      if (f === params.prevFacial) continue
      if (rankedFacials.includes(f)) continue
      if (inspectModelFacial(params.modelPath, f, params.modelsRoot).role === role) {
        rankedFacials.push(f)
      }
    }
  }
  if (rankedFacials.length < limit) {
    const primary = pickMoodMatchedFacial(
      facialPool,
      targetMood,
      params.modelPath,
      params.restrainedRole,
      params.modelsRoot
    )
    if (primary && !rankedFacials.includes(primary)) rankedFacials.push(primary)
    for (const f of facialPool) {
      if (rankedFacials.length >= limit) break
      if (!rankedFacials.includes(f) && f !== params.prevFacial) rankedFacials.push(f)
    }
  }

  const recentSet = new Set(
    Array.isArray(params.recentMotions) ? params.recentMotions : [...(params.recentMotions ?? [])]
  )
  if (params.prevMotion) recentSet.add(params.prevMotion)

  const compatibleMotions = params.motions.filter(
    (m) =>
      !isSpecialOrStandingMotion(m) &&
      isMotionCompatibleWithLine({
        motion: m,
        modelPath: params.modelPath,
        emotion: params.emotion,
        content: params.content,
        prevContent: params.prevContent,
        prevEmotion: params.prevEmotion,
        prevTense: params.prevTense,
        isListener: params.isListener,
        restrainedRole: params.restrainedRole,
        modelsRoot: params.modelsRoot
      }).ok
  )
  const motionPool =
    compatibleMotions.length > 0
      ? compatibleMotions
      : params.motions.filter((m) => !isSpecialOrStandingMotion(m))
  const prevStyle = params.prevMotion ? parseMotionStem(params.prevMotion).style : ''
  const effectiveMotions = sortMotionsByStyleConsistency(
    motionPool.length > 0 ? motionPool : params.motions,
    prevStyle
  )

  const wantedMotionRoles = MOTION_ROLES_BY_DRAMATIC_MOOD[ctx.mood]
  const rankedMotions: string[] = []
  for (const role of wantedMotionRoles) {
    if (params.restrainedRole && role === 'playful') continue
    for (const m of effectiveMotions) {
      if (rankedMotions.length >= limit) break
      if (recentSet.has(m) || rankedMotions.includes(m)) continue
      if (inspectModelMotion(params.modelPath, m, params.modelsRoot).role === role) {
        rankedMotions.push(m)
      }
    }
  }
  // 若情绪匹配的候选仍不足，允许复用同情绪角色池中的动作（宁可保持贴合情绪的姿势，也不跨情绪硬换无关动作）
  if (rankedMotions.length < limit) {
    for (const role of wantedMotionRoles) {
      if (params.restrainedRole && role === 'playful') continue
      for (const m of effectiveMotions) {
        if (rankedMotions.length >= limit) break
        if (rankedMotions.includes(m)) continue
        if (inspectModelMotion(params.modelPath, m, params.modelsRoot).role === role) {
          rankedMotions.push(m)
        }
      }
    }
  }
  if (rankedMotions.length === 0) {
    const fallback = pickMoodMatchedMotion(
      effectiveMotions,
      ctx.mood,
      params.modelPath,
      params.restrainedRole,
      recentSet,
      params.modelsRoot
    )
    if (fallback && !rankedMotions.includes(fallback)) rankedMotions.push(fallback)
    for (const m of effectiveMotions) {
      if (rankedMotions.length >= limit) break
      if (!rankedMotions.includes(m)) rankedMotions.push(m)
    }
  }

  return {
    mood: ctx.mood,
    facials: rankedFacials.slice(0, limit),
    motions: rankedMotions.slice(0, limit)
  }
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

/** 综合诊断某句台词的 facial、motion 与连续重复问题，并返回可替换的候选列表。 */
export function evaluateActingLineMatch(params: {
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
}): ActingLineEvaluation {
  const issues: ActingLineEvaluationIssue[] = []
  const rec = recommendActingForLine({
    facials: params.facials ?? [],
    motions: params.motions ?? [],
    modelPath: params.modelPath,
    content: params.content,
    emotion: params.emotion,
    prevContent: params.prevContent,
    prevEmotion: params.prevEmotion,
    prevTense: params.prevTense,
    isMonologue: params.isMonologue,
    isListener: params.isListener,
    isEntryExit: params.isEntryExit,
    restrainedRole: params.restrainedRole,
    prevFacial: params.prevFacial,
    prevMotion: params.prevMotion,
    modelsRoot: params.modelsRoot
  })

  const facial = (params.facial ?? '').trim()
  if (facial) {
    const fc = isFacialCompatibleWithLine({
      facial,
      modelPath: params.modelPath,
      emotion: params.emotion,
      content: params.content,
      prevTense: params.prevTense,
      isMonologue: params.isMonologue,
      isListener: params.isListener,
      restrainedRole: params.restrainedRole,
      modelsRoot: params.modelsRoot
    })
    if (!fc.ok) {
      const info = inspectModelFacial(params.modelPath, facial, params.modelsRoot)
      issues.push({
        field: 'facial',
        code: fc.reason ?? 'facial_mood_mismatch',
        severity: 'high',
        message: `表情 ${facial}(${info.label}) 与当前「${rec.mood}」语境冲突`
      })
    }
  }

  const motion = (params.motion ?? '').trim()
  if (motion) {
    const mc = isMotionCompatibleWithLine({
      motion,
      modelPath: params.modelPath,
      emotion: params.emotion,
      content: params.content,
      prevContent: params.prevContent,
      prevEmotion: params.prevEmotion,
      prevTense: params.prevTense,
      isListener: params.isListener,
      restrainedRole: params.restrainedRole,
      modelsRoot: params.modelsRoot
    })
    if (!mc.ok) {
      const info = inspectModelMotion(params.modelPath, motion, params.modelsRoot)
      issues.push({
        field: 'motion',
        code: mc.reason ?? 'motion_mood_mismatch',
        severity: mc.reason === 'standing_motion_on_expressive_beat' ? 'medium' : 'high',
        message: `动作 ${motion}(${info.label}) 与当前「${rec.mood}」语境不搭`
      })
    }
  }

  const sameFacialCount = params.consecutiveSameFacialCount ?? 0
  if (facial && sameFacialCount >= 3) {
    issues.push({
      field: 'repetition',
      code: 'consecutive_same_facial',
      severity: 'medium',
      message: `表情 ${facial} 已连续 ${sameFacialCount} 句未变化，建议随台词语气切换`
    })
  } else if (
    facial &&
    /^face_normal/i.test(facial) &&
    sameFacialCount >= 2 &&
    !params.restrainedRole &&
    rec.mood !== 'neutral'
  ) {
    issues.push({
      field: 'repetition',
      code: 'stuck_on_neutral_facial',
      severity: 'medium',
      message: `情绪语境为「${rec.mood}」但连续挂着中性表情 ${facial}，建议换成更贴切的微表情`
    })
  }

  const sameMotionCount = params.consecutiveSameMotionCount ?? 0
  if (motion && sameMotionCount >= 4) {
    issues.push({
      field: 'repetition',
      code: 'consecutive_same_motion',
      severity: 'medium',
      message: `身体动作 ${motion} 已连续重复 ${sameMotionCount} 句，可在合适情绪节点适度换姿（若情绪延续可留空 motion 保持当前姿态）`
    })
  }

  return {
    ok: issues.length === 0,
    inferredMood: rec.mood,
    issues,
    recommendedFacials: rec.facials,
    recommendedMotions: rec.motions
  }
}
