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

export type MotionContextTag = 'food' | 'sleep' | 'sing'

export interface FacialInspection {
  role: FacialSemanticRole
  label: string
  fromMotion3: boolean
  mouthForm?: number
  contextTag?: MotionContextTag
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
  contextTag?: MotionContextTag
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
  const dirCandidates = clean.startsWith('cloud/')
    ? [modelDir]
    : [modelDir, path.posix.join('cloud', modelDir)]
  for (const dir of dirCandidates) {
    for (const sub of ['motions', 'motion']) {
      const full = path.join(modelsRoot, dir, sub, `${clipName}.motion3.json`)
      if (fs.existsSync(full)) return full
    }
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
  if (/^face_(?:delicious|eat)/.test(lower)) {
    return { role: 'other', contextTag: 'food', label: '享用美食/饮品', fromMotion3: false }
  }
  if (/^face_(?:sing|mic)/.test(lower)) {
    return { role: 'other', contextTag: 'sing', label: '歌唱/舞台', fromMotion3: false }
  }
  if (/^face_(?:wink|smug|doya|play|sparkling|interest|spoony)/.test(lower)) {
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
    return { role: 'sleepy', contextTag: 'sleep', label: '犯困/倦意', fromMotion3: false }
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
  const tear = Math.max(
    num('ParamTear'),
    num('ParamEyeTeary'),
    num('ParamCry'),
    num('ParamTear3'),
    num('ParamTear4')
  )
  const cheek = Math.max(num('ParamCheek'), num('ParamCheek2'))
  const shadow = Math.abs(num('ParamFaceShadow'))
  const sweat = Math.max(num('ParamSweatOn'), num('ParamSweatOn2'))
  const eyeHi = curves.has('ParamEyeHi') ? num('ParamEyeHi') : 0
  const rawLower = facialName.toLowerCase()
  const lower = stripFacialVariantPrefix(rawLower)

  const closed = eyeOpen <= 0.08
  const darkPrefix =
    rawLower.startsWith('face_dark') || rawLower.includes('nhi') || shadow > 0.15 || eyeHi < -0.2
  const isStrainedSmile =
    browY <= -0.25 ||
    browAngle >= 0.25 ||
    eyeSmile < -0.15 ||
    sweat > 0.2 ||
    shadow > 0.15 ||
    darkPrefix
  const isExplicitSurpriseName = /^face_(?:surprise|shock|notice|scared|nsscared|e(?:_|$))/.test(
    lower
  )

  if (isExplicitSurpriseName) {
    const base = classifyByName(facialName)
    return { ...base, role: 'surprise', fromMotion3: true, mouthForm }
  }

  if (tear > 0.2) {
    if (mouthForm >= 0.2) {
      return { role: 'tearful_smile', label: '含泪微笑', fromMotion3: true, mouthForm }
    }
    return { role: 'cry', label: '含泪/哭泣', fromMotion3: true, mouthForm }
  }

  if (lower.startsWith('face_smile') || lower.startsWith('face_closeeye')) {
    // 真正的苦笑/勉强笑：嘴角上扬但眼笑为负（眼底紧绷）、冒冷汗、带脸部阴影，或深蹙眉且无眼笑
    const hasTenseEyes = eyeSmile < -0.15
    const hasStrainedBrow = browY <= -0.55 && eyeSmile < 0.25 && cheek < 0.3
    const hasClosedTension = closed && (browY <= -0.35 || eyeSmile < -0.15 || sweat > 0.2)
    if (hasTenseEyes || sweat > 0.2 || shadow > 0.15 || hasStrainedBrow || hasClosedTension) {
      if ((lower.startsWith('face_smile') || closed) && mouthForm >= 0.2) {
        return {
          role: 'wry_smile',
          label: closed ? '闭眼苦笑/勉强笑' : '苦笑/勉强笑',
          fromMotion3: true,
          mouthForm
        }
      }
      if (closed) {
        return { role: 'closed_troubled', label: '闭眼为难/紧绷', fromMotion3: true, mouthForm }
      }
    }
    if (closed && mouthForm >= 0.2) {
      if (browY <= -0.25 || browAngle >= 0.25) {
        return { role: 'wry_smile', label: '闭眼苦笑/嘴角微扬', fromMotion3: true, mouthForm }
      }
      return {
        role: 'closed_smile',
        label: mouthOpen >= 0.4 ? '闭眼大笑' : '闭眼微笑',
        fromMotion3: true,
        mouthForm
      }
    }
    if (closed && eyeSmile >= 0.4) {
      return {
        role: 'closed_smile',
        label: mouthOpen >= 0.4 ? '闭眼大笑' : '闭眼微笑',
        fromMotion3: true,
        mouthForm
      }
    }
    if (lower.startsWith('face_smile')) {
      if (cheek >= 0.5 && mouthForm >= 0.3) {
        return { role: 'genuine_smile', label: '红晕开心笑', fromMotion3: true, mouthForm }
      }
      if (eyeSmile >= 0.4 && mouthForm >= 0.3) {
        return {
          role: 'genuine_smile',
          label: mouthOpen >= 0.4 ? '开朗大笑' : '温和微笑',
          fromMotion3: true,
          mouthForm
        }
      }
      if (mouthForm >= 0.15) {
        return { role: 'genuine_smile', label: '浅笑', fromMotion3: true, mouthForm }
      }
      return { role: 'wry_smile', label: '克制微苦笑', fromMotion3: true, mouthForm }
    }
    if (closed) {
      return {
        role: browY < -0.25 ? 'closed_troubled' : 'closed_neutral',
        label: browY < -0.25 ? '闭眼隐忍/思考' : '安静闭眼',
        fromMotion3: true,
        mouthForm
      }
    }
  }

  if (darkPrefix) {
    if (rawLower.includes('smile') || mouthForm >= 0.2) {
      return { role: 'wry_smile', label: '阴郁假笑/勉强笑', fromMotion3: true, mouthForm }
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
        fromMotion3: true,
        mouthForm
      }
    }
  }

  if (
    lower.includes('shy') ||
    lower.includes('blush') ||
    (cheek >= 0.5 && browAngle >= -0.1 && mouthForm >= -0.1 && !lower.includes('angry'))
  ) {
    return { role: 'shy', label: '脸红/害羞', fromMotion3: true, mouthForm }
  }

  // 上下文限定表情（如 face_delicious / face_eat / face_sing / face_sleepy）与显式俏皮表情（smug/wink/doya）不误判为苦笑
  const namedBase = classifyByName(facialName)
  if (namedBase.contextTag) {
    return { ...namedBase, fromMotion3: true, mouthForm }
  }
  if (/^face_(?:wink|smug|doya|play|sparkling|interest|spoony)/.test(lower) && !darkPrefix) {
    return { role: 'playful', label: '俏皮/得意/闪亮', fromMotion3: true, mouthForm }
  }

  // 无论文件名前缀如何（如 face_trouble_02 / face_normal_* / face_sad_* / face_cry_01 无泪等），
  // 只要 ParamMouthForm >= 0.2 即存在明显嘴角上扬笑意，必须标为苦笑或微笑，绝不能混入普通 trouble/sad！
  if (mouthForm >= 0.2) {
    if (isStrainedSmile) {
      return { role: 'wry_smile', label: '苦笑/嘴角上扬', fromMotion3: true, mouthForm }
    }
    if (closed) {
      return {
        role: 'closed_smile',
        label: mouthOpen >= 0.4 ? '闭眼大笑' : '闭眼微笑',
        fromMotion3: true,
        mouthForm
      }
    }
    return {
      role: 'genuine_smile',
      label: mouthOpen >= 0.4 ? '开朗微笑' : '微笑/嘴角上扬',
      fromMotion3: true,
      mouthForm
    }
  }

  if (/^face_(?:serious|sharp|purpose|fight)/.test(lower) && !darkPrefix) {
    return { role: 'serious', label: '认真/锐利', fromMotion3: true, mouthForm }
  }

  // 显式哭泣/悲伤/懊悔前缀即便在 ParamTear<=0.2 且皱眉（browAngle<=-0.3）时也属于哭泣/悲伤而非生气
  if (/^face_(?:cry|ecry)/.test(lower)) {
    return { role: 'cry', label: '含泪/哭泣', fromMotion3: true, mouthForm }
  }
  const isSadNamed =
    /^face_(?:sad|lookdown|sigh|regret|tired|exhaustion|heartbreak|desperate|baffling|darksad)/.test(
      lower
    )

  if (browAngle <= -0.3 && mouthForm <= 0.05 && !isSadNamed) {
    return { role: 'angry', label: '蹙眉不满/生气', fromMotion3: true, mouthForm }
  }

  if (browY <= -0.25 && browAngle >= 0.25 && !lower.includes('smile')) {
    return { role: 'trouble', label: '苦恼/不安', fromMotion3: true, mouthForm }
  }

  const base = classifyByName(facialName)
  return { ...base, fromMotion3: true, mouthForm }
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

export function parseMotionStem(motionName: string): { style: string; stem: string } {
  const clean = motionName.trim()
  const rawParts = clean.split('-')
  const style = rawParts.length >= 3 ? rawParts[1].toLowerCase() : ''
  // 先剥离大写变体后缀（如 sleepB / deliciousB），再转小写并去数字后缀
  const rawTail = (rawParts[rawParts.length - 1] ?? clean)
    .replace(/_nb$/i, '')
    .replace(/[A-Z]$/, '')
  const stem = rawTail
    .toLowerCase()
    .replace(/\d+[a-z]?$/i, '')
    .replace(/^nb/, '')
  return { style, stem }
}

const FOOD_MOTION_STEM_RE = /^(?:delicious|eat|eating|drink|drinking)/
const SLEEP_MOTION_STEM_RE = /^(?:sleep|sleeping|yawn|yawning)/
const SING_MOTION_STEM_RE = /^(?:sing|singing|mic|microphone)$|^sing_|_sing$|^mic_|_mic$/

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
  if (FOOD_MOTION_STEM_RE.test(stem)) {
    return {
      role: 'other',
      contextTag: 'food',
      label: '享用美食/饮品',
      style,
      fromMotion3: false
    }
  }
  if (SLEEP_MOTION_STEM_RE.test(stem)) {
    return {
      role: 'other',
      contextTag: 'sleep',
      label: '犯困/打盹',
      style,
      fromMotion3: false
    }
  }
  if (SING_MOTION_STEM_RE.test(stem)) {
    return {
      role: 'other',
      contextTag: 'sing',
      label: '歌唱/舞台',
      style,
      fromMotion3: false
    }
  }
  if (
    stem === 'glad' ||
    stem === 'poseglad' ||
    stem === 'guts' ||
    stem === 'wandahoi' ||
    stem === 'joy'
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
  if (stem === 'think' || stem.startsWith('look') || stem === 'guruguru' || stem === 'yurayura') {
    return {
      role: 'think',
      label:
        stem.includes('lookaway') ||
        stem.includes('lookleft') ||
        stem.includes('lookright') ||
        stem.includes('lookside')
          ? '移开视线/环顾'
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
  const info = inspectModelFacial(modelPath, facialName, modelsRoot)
  return (
    info.role === 'genuine_smile' ||
    info.role === 'closed_smile' ||
    info.role === 'playful' ||
    info.role === 'wry_smile' ||
    info.role === 'tearful_smile' ||
    (info.mouthForm !== undefined && info.mouthForm >= 0.2)
  )
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
  cheerfulScene?: boolean
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
  const suppressMockPrevAngry =
    Boolean(params.cheerfulScene) &&
    emo !== '伤心' &&
    emo !== '害怕' &&
    !apologyOrRegret &&
    !isDespair
  const tense =
    emo === '生气' ||
    emo === '伤心' ||
    emo === '害怕' ||
    (!suppressMockPrevAngry && prevEmo === '生气') ||
    prevEmo === '伤心' ||
    ANGRY_TEXT_RE.test(text) ||
    (!suppressMockPrevAngry && ANGRY_TEXT_RE.test(prevText))

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

const EXPLICIT_WRY_SMILE_TEXT_RE =
  /(?:苦笑|勉强笑|强颜欢笑|含泪笑|自嘲|微笑|笑着|没事的|没关系|别担心|不用担心|安心)/
const CRY_DESPAIR_CONFRONT_RE =
  /(?:哭|泣|泪|呜咽|嗚咽|别走|再见|窒息|崩溃|绝望|受不了|不行啊|做不到|对不起|抱歉|后悔|没能|不要|别再|少啰嗦|闭嘴|滚|干嘛|为什么)/
export const GENUINE_HAPPY_OR_RECONCILIATION_RE =
  /(?:太好了|好耶|太棒了|哈哈|嘻嘻|嘿嘿|和好|原谅|终于放心|松了口气|雨过天晴|真开心|好开心|真高兴|好高兴|最喜欢|谢谢你|真期待|好期待|不愧是|Wonderhoy|よかった|答对啦|～♪|♪)/
const FOOD_CONTEXT_TEXT_RE =
  /(?:吃|喝|尝|味道|美味|好吃|好喝|甜点|甜品|蛋糕|点心|松饼|面包|饼干|咖啡|红茶|绿茶|奶茶|茶|饮料|果汁|拉面|料理|便当|午饭|晚饭|早饭|吃饭|零食|糖|水果|草莓|饿|饱|口渴|干杯|品尝|美食|食堂|餐厅|咖啡厅|甜点店|食|飲|おいしい|スイーツ|ケーキ|パン|コーヒー|紅茶|お茶|食べ|飲み|お腹)/i
const SLEEP_CONTEXT_TEXT_RE =
  /(?:好困|犯困|想睡|睡觉|午睡|小睡|打盹|瞌睡|打哈欠|哈欠|好累|累了|疲惫|疲倦|熬夜|失眠|通宵|没睡|睡着|睡意|困意|晚安|闭目养神|寝|眠|あくび|うとうと|おやすみ)/i
const SING_CONTEXT_TEXT_RE =
  /(?:唱歌|唱|歌声|清唱|合唱|主唱|副歌|旋律|曲子|乐曲|歌曲|歌词|演出|舞台|live|演唱会|麦克风|话筒|排练|练歌|试唱|哼歌|哼唱|うた|歌|ライブ|マイク)/i

function isContextTagCompatibleWithText(
  tag: MotionContextTag | undefined,
  content: string
): { ok: boolean; reason?: string } {
  if (!tag) return { ok: true }
  if (tag === 'food' && !FOOD_CONTEXT_TEXT_RE.test(content)) {
    return { ok: false, reason: 'food_motion_without_food_context' }
  }
  if (tag === 'sleep' && !SLEEP_CONTEXT_TEXT_RE.test(content)) {
    return { ok: false, reason: 'sleep_motion_without_sleep_context' }
  }
  if (tag === 'sing' && !SING_CONTEXT_TEXT_RE.test(content)) {
    return { ok: false, reason: 'sing_motion_without_sing_context' }
  }
  return { ok: true }
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
  cheerfulScene?: boolean
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
    cheerfulScene,
    modelsRoot
  } = params
  if (!facial.trim()) return { ok: true }
  const info = inspectModelFacial(modelPath, facial, modelsRoot)
  const emo = (emotion ?? '').trim()
  const text = content.trim()
  const ctxTagCheck = isContextTagCompatibleWithText(info.contextTag, text)
  if (!ctxTagCheck.ok) {
    return ctxTagCheck
  }
  const ctx = inferDramaticContext({
    content: text,
    emotion: emo,
    isMonologue,
    isListener,
    restrainedRole,
    cheerfulScene
  })
  const hasNegCue =
    (NEGATIVE_TEXT_CUE_RE.test(text) || NEGATED_JOY_RE.test(text)) && ctx.mood !== 'gentle_reassure'
  const hasPosCue = POSITIVE_TEXT_CUE_RE.test(text) && !NEGATED_JOY_RE.test(text)
  const isLightComicListenerSurprise =
    Boolean(isListener) &&
    Boolean(cheerfulScene) &&
    emo === '惊讶' &&
    !hasNegCue &&
    !ctx.apologyOrRegret &&
    !DESPAIR_TEXT_RE.test(text) &&
    !CRY_DESPAIR_CONFRONT_RE.test(text) &&
    !/(?:出事|糟了|不好了|怎么会|骗人|吓)/.test(text)
  const isTenseEmotion =
    emo === '生气' ||
    emo === '伤心' ||
    emo === '害怕' ||
    (emo === '惊讶' && !isLightComicListenerSurprise)
  const isNegativeOrConfrontation =
    isTenseEmotion ||
    hasNegCue ||
    ctx.apologyOrRegret ||
    ctx.mood === 'sad_regret' ||
    ctx.mood === 'angry_frustration' ||
    (ctx.mood === 'surprise' && !isLightComicListenerSurprise) ||
    DESPAIR_TEXT_RE.test(text) ||
    CRY_DESPAIR_CONFRONT_RE.test(text)
  const hasPositiveMouth = info.mouthForm !== undefined && info.mouthForm >= 0.2
  const allowsWrySmile =
    EXPLICIT_WRY_SMILE_TEXT_RE.test(text) &&
    emo !== '生气' &&
    emo !== '惊讶' &&
    !/(?:哭|泣|呜|不行|崩溃|绝望|窒息|别走|再见|闭嘴|烦死|气死|什么！？)/.test(text)

  // 1) 明确负面/紧张/道歉/惊愕/哭泣对峙语境：严禁纯正微笑/俏皮表情，且任何嘴角上扬(mouthForm >= 0.2 / wry_smile / tearful_smile)
  //    均严格拦截，除非台词本身明确表达苦笑/含泪安抚笑意
  if (
    isNegativeOrConfrontation &&
    (info.role === 'genuine_smile' ||
      info.role === 'closed_smile' ||
      info.role === 'playful' ||
      (info.role === 'shy' && emo !== '害羞'))
  ) {
    return { ok: false, reason: 'negative_context_smile' }
  }
  if (
    isNegativeOrConfrontation &&
    (info.role === 'wry_smile' ||
      info.role === 'tearful_smile' ||
      (hasPositiveMouth && info.role !== 'surprise' && !(info.role === 'shy' && emo === '害羞'))) &&
    !allowsWrySmile
  ) {
    return { ok: false, reason: 'negative_context_smile' }
  }

  // 2) 紧张对峙打圆场/强装轻松或克制型角色：未真正和好/明确开心时，禁用纯正阳光大笑/闭眼大笑（保留苦笑 wry_smile 给说话者掩饰）
  const isWarmGroupClosure =
    !restrainedRole &&
    emo === '开心' &&
    !hasNegCue &&
    !ctx.apologyOrRegret &&
    !DESPAIR_TEXT_RE.test(text) &&
    !CRY_DESPAIR_CONFRONT_RE.test(text) &&
    !/(?:没事|没关系|不用|别管|不在意|而已|罢了)/.test(text) &&
    /(?:涂鸦|明天|四个人|大家|一起|去庆功|走吧)/.test(text)
  const isCheerfulHappyTurn =
    Boolean(cheerfulScene) &&
    emo === '开心' &&
    !hasNegCue &&
    !ctx.apologyOrRegret &&
    !DESPAIR_TEXT_RE.test(text) &&
    !CRY_DESPAIR_CONFRONT_RE.test(text)
  const isGenuineHappyOrReconcile =
    GENUINE_HAPPY_OR_RECONCILIATION_RE.test(text) || isCheerfulHappyTurn || isWarmGroupClosure
  if (
    prevTense &&
    !isGenuineHappyOrReconcile &&
    (info.role === 'genuine_smile' ||
      info.role === 'closed_smile' ||
      info.role === 'playful' ||
      (Boolean(isListener) &&
        (info.role === 'wry_smile' ||
          info.role === 'tearful_smile' ||
          (hasPositiveMouth &&
            info.role !== 'surprise' &&
            !(info.role === 'shy' && emo === '害羞')))))
  ) {
    return { ok: false, reason: 'restrained_or_tense_smile' }
  }
  if (
    (restrainedRole || prevTense) &&
    !hasPosCue &&
    emo !== '开心' &&
    (info.role === 'genuine_smile' ||
      info.role === 'closed_smile' ||
      info.role === 'playful' ||
      (hasPositiveMouth &&
        info.role !== 'surprise' &&
        info.role !== 'wry_smile' &&
        info.role !== 'tearful_smile' &&
        !(info.role === 'shy' && emo === '害羞')))
  ) {
    return { ok: false, reason: 'restrained_or_tense_smile' }
  }

  // 3) 台词和情绪明确开心轻松（且非对峙强装轻松/听者承压）时，不挂哭泣/暴怒/阴暗冷脸/困扰
  if (
    !isListener &&
    !(prevTense && !isGenuineHappyOrReconcile) &&
    (emo === '开心' ||
      (hasPosCue &&
        !hasNegCue &&
        !prevTense &&
        emo !== '伤心' &&
        emo !== '生气' &&
        emo !== '害怕')) &&
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

  // 7) 含泪自责/伤心懊悔台词（无明确怒气）严禁误挂生气脸（听者前序若正在发火对峙允许维持生气神情）
  if (
    !isListener &&
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

export function isCharacterSignatureMotionAllowed(motion: string, modelPath?: string): boolean {
  const clean = motion.trim()
  if (!clean) return true
  const pathLower = (modelPath ?? '').toLowerCase()
  const charPrefix = /^m-([a-z]+)-/i.exec(clean)
  if (charPrefix && pathLower && !pathLower.includes(charPrefix[1].toLowerCase())) {
    return false
  }
  if (/wandahoi/i.test(clean) && pathLower && !/(?:13tsukasa|14emu|tsukasa|emu)/i.test(pathLower)) {
    return false
  }
  return true
}

export function isMotionAutoPickAllowed(motion: string, modelPath?: string): boolean {
  const clean = motion.trim()
  if (!clean || isSpecialOrStandingMotion(clean)) return false
  if (!isCharacterSignatureMotionAllowed(clean, modelPath)) return false
  if (/animal/i.test(clean)) return false
  return true
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
  cheerfulScene?: boolean
  modelsRoot?: string
}): MotionCompatibilityResult {
  const clean = params.motion.trim()
  if (!clean) return { ok: true }
  if (!isCharacterSignatureMotionAllowed(clean, params.modelPath)) {
    return { ok: false, reason: 'character_exclusive_motion' }
  }
  const info = inspectModelMotion(params.modelPath, clean, params.modelsRoot)
  if (info.role === 'special') {
    return { ok: false, reason: 'special_clear_motion_in_dialogue' }
  }
  const text = (params.content ?? '').trim()
  const ctxTagCheck = isContextTagCompatibleWithText(info.contextTag, text)
  if (!ctxTagCheck.ok) {
    return ctxTagCheck
  }

  const ctx = inferDramaticContext({
    content: params.content,
    emotion: params.emotion,
    prevContent: params.prevContent,
    prevEmotion: params.prevEmotion,
    isListener: params.isListener,
    restrainedRole: params.restrainedRole,
    cheerfulScene: params.cheerfulScene
  })
  const tense = ctx.tense || Boolean(params.prevTense)
  const isGenuineHappyOrReconcile = GENUINE_HAPPY_OR_RECONCILIATION_RE.test(text)

  // 1) 负面/悲伤/道歉/紧张/愤怒语境或对峙未和好时的强装欢快打圆场：禁止欢快/得意/打招呼动作（glad / playful / greeting）
  if (
    (ctx.mood === 'sad_regret' ||
      ctx.mood === 'angry_frustration' ||
      ctx.apologyOrRegret ||
      (tense && !isGenuineHappyOrReconcile)) &&
    (info.role === 'glad' || info.role === 'playful' || info.role === 'greeting')
  ) {
    return {
      ok: false,
      reason:
        tense && ctx.mood === 'cheerful_banter'
          ? 'glad_motion_on_tense_deflection'
          : 'cheerful_motion_on_tense_or_sad_line'
    }
  }

  // 2) 开心/温柔安抚语境（且非紧张对峙打圆场）禁止用生气/沮丧/摇头否定动作
  if (
    !params.isListener &&
    !(tense && !isGenuineHappyOrReconcile) &&
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
  const isDespair = DESPAIR_TEXT_RE.test(text)
  const isGenuineShock = emo === '惊讶' || GENUINE_SURPRISE_TEXT_RE.test(text)

  // 5) 悲伤/绝望/愤怒语境禁止打招呼等轻松社交动作；relief(松口气) 仅在愤怒或极端绝望崩溃句禁用（官方悲伤/叹息语境常自然用 relief 表现轻叹释放）
  if (
    (ctx.mood === 'sad_regret' || ctx.mood === 'angry_frustration' || isDespair) &&
    (info.role === 'greeting' ||
      (info.role === 'relief' && (ctx.mood === 'angry_frustration' || isDespair)))
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
  sad: ['cry', 'sad', 'closed_troubled', 'trouble', 'cold_hollow', 'neutral'],
  trouble: ['trouble', 'closed_troubled', 'sad', 'serious', 'neutral'],
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
    const hit = facials.find((f) => {
      const info = inspectModelFacial(modelPath, f, modelsRoot)
      return !info.contextTag && info.role === wantedRole
    })
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
      const info = inspectModelFacial(modelPath, f, modelsRoot)
      const role = info.role
      return (
        !info.contextTag &&
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

export type ActorTenseState = 'angry' | 'sad' | 'cry' | 'serious' | 'trouble' | null

export function facialRoleToTenseState(role: FacialSemanticRole): ActorTenseState {
  if (role === 'angry') return 'angry'
  if (role === 'cry' || role === 'tearful_smile') return 'cry'
  if (role === 'sad' || role === 'cold_hollow') return 'sad'
  if (role === 'serious') return 'serious'
  if (role === 'trouble' || role === 'closed_troubled') return 'trouble'
  return null
}

export function isGenuineHappyOrReconciliation(content: string): boolean {
  return GENUINE_HAPPY_OR_RECONCILIATION_RE.test(content) && !NEGATIVE_TEXT_CUE_RE.test(content)
}

export function isCalmReassureResolution(content: string, emotion: string): boolean {
  const emo = emotion.trim()
  if (emo === '生气' || emo === '伤心' || emo === '害怕') return false
  if (isGenuineHappyOrReconciliation(content)) return true
  return (
    REASSURE_TEXT_RE.test(content) &&
    !APOLOGY_REGRET_RE.test(content) &&
    !DESPAIR_TEXT_RE.test(content)
  )
}

export interface SceneTenseTracker {
  tense: boolean
  calmRun: number
}

const SERIOUS_CRY_OR_HURT_RE = /[哭泣泪呜咽嗚咽]/

/**
 * 判断当前台词周边是否处于明显欢快喜剧主导的段落（`开心` 占多数，且无伤心/害怕或哭泣/绝望/道歉等沉重线索），
 * 用于防止喜剧斗嘴中的玩笑「生气」把后续「Wonderhoy」等欢快演出锁死成紧张对峙。
 */
export function isCheerfulComedyContext(
  lines: ReadonlyArray<{ content?: string; emotion?: string; sceneId?: string }>,
  index: number
): boolean {
  if (index < 0 || index >= lines.length) return false
  const currentSceneId = lines[index]?.sceneId
  let winStart = index
  while (winStart > Math.max(0, index - 10)) {
    const prev = lines[winStart - 1]
    if (currentSceneId && prev?.sceneId && prev.sceneId !== currentSceneId) break
    winStart -= 1
  }
  let winEnd = index
  while (winEnd < Math.min(lines.length - 1, index + 6)) {
    const next = lines[winEnd + 1]
    if (currentSceneId && next?.sceneId && next.sceneId !== currentSceneId) break
    winEnd += 1
  }

  let total = 0
  let happyCount = 0
  let angryCount = 0
  for (let i = winStart; i <= winEnd; i++) {
    const line = lines[i]
    if (!line) continue
    total += 1
    const emo = (line.emotion ?? '').trim()
    const text = (line.content ?? '').trim()
    if (emo === '伤心' || emo === '害怕') return false
    if (
      SERIOUS_CRY_OR_HURT_RE.test(text) ||
      DESPAIR_TEXT_RE.test(text) ||
      APOLOGY_REGRET_RE.test(text) ||
      SELF_BLAME_REGRET_RE.test(text)
    ) {
      return false
    }
    if (emo === '生气') {
      angryCount += 1
    } else if (
      emo === '开心' ||
      (emo === '' && POSITIVE_TEXT_CUE_RE.test(text) && !NEGATED_JOY_RE.test(text))
    ) {
      happyCount += 1
    }
  }
  return happyCount >= 3 && happyCount > total * 0.5 && happyCount >= angryCount * 2
}

export function updateSceneTenseAfterTalk(
  tracker: SceneTenseTracker,
  content: string,
  emotion: string,
  options: { cheerfulScene?: boolean } = {}
): void {
  const emo = emotion.trim()
  const text = content.trim()
  const hasSeriousSadOrRegret =
    emo === '伤心' ||
    emo === '害怕' ||
    APOLOGY_REGRET_RE.test(text) ||
    SELF_BLAME_REGRET_RE.test(text) ||
    DESPAIR_TEXT_RE.test(text) ||
    /(?:骗人|糟糕|难过|哭|呜)/.test(text)
  if (hasSeriousSadOrRegret) {
    tracker.tense = true
    tracker.calmRun = 0
    return
  }
  const isAngryBeat = emo === '生气' || ANGRY_TEXT_RE.test(text)
  if (isAngryBeat) {
    if (options.cheerfulScene) {
      tracker.tense = false
      tracker.calmRun = 0
      return
    }
    tracker.tense = true
    tracker.calmRun = 0
    return
  }
  if (isCalmReassureResolution(text, emo)) {
    tracker.tense = false
    tracker.calmRun = 0
    return
  }
  if (emo === '开心' && !NEGATED_JOY_RE.test(text)) {
    tracker.calmRun += 1
    if (options.cheerfulScene || POSITIVE_TEXT_CUE_RE.test(text) || tracker.calmRun >= 2) {
      tracker.tense = false
      tracker.calmRun = 0
    }
    return
  }
  if (emo === '平静' || emo === '') {
    tracker.calmRun += 1
    if (tracker.calmRun >= 2 || /陪你|吹一会儿|多陪|走吧|涂鸦|明天.*再说/.test(text)) {
      tracker.tense = false
    }
  } else {
    tracker.calmRun = 0
  }
}

export function pickListenerFallbackFacial(
  facials: string[],
  tenseState: Exclude<ActorTenseState, null>,
  modelPath?: string,
  restrainedRole?: boolean,
  modelsRoot?: string
): string {
  const preferredRoles: FacialSemanticRole[] =
    tenseState === 'angry' || tenseState === 'serious'
      ? ['serious', 'trouble', 'sad', 'closed_troubled', 'neutral', 'closed_neutral']
      : tenseState === 'cry' || tenseState === 'sad'
        ? ['sad', 'trouble', 'serious', 'closed_troubled', 'neutral', 'closed_neutral']
        : ['trouble', 'serious', 'sad', 'closed_troubled', 'neutral', 'closed_neutral']

  if (tenseState === 'angry' || tenseState === 'serious') {
    const seriousNamed = facials.find(
      (f) => /^face_(?:dark)?serious/i.test(f) && !isSmileLikeFacial(f, modelPath, modelsRoot)
    )
    if (seriousNamed) return seriousNamed
  }
  for (const role of preferredRoles) {
    const hit = facials.find((f) => {
      const info = inspectModelFacial(modelPath, f, modelsRoot)
      return !info.contextTag && info.role === role
    })
    if (hit) return hit
  }
  return pickNeutralFacial(facials, undefined, modelPath, restrainedRole, modelsRoot)
}

const MOTION_ROLES_BY_DRAMATIC_MOOD: Record<DramaticContextMood, MotionSemanticRole[]> = {
  surprise: ['surprise', 'forward', 'shakehead', 'tilthead'],
  awkward: ['trouble', 'shy', 'think', 'nod', 'relief', 'tilthead'],
  gentle_reassure: ['nod', 'relief', 'forward', 'tilthead'],
  inner_resolve: ['forward', 'nod', 'relief', 'think'],
  shy_hesitation: ['shy', 'trouble', 'think', 'tilthead'],
  angry_frustration: ['angry', 'shakehead', 'forward', 'trouble'],
  sad_regret: ['sad', 'trouble', 'shakehead', 'think', 'nod', 'relief', 'forward'],
  cheerful_banter: ['glad', 'playful', 'nod', 'tilthead', 'greeting', 'relief'],
  attentive_listen: ['nod', 'think', 'tilthead', 'relief', 'trouble'],
  thinking_monologue: ['think', 'trouble', 'sad', 'nod', 'relief'],
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

/** 根据剧情情绪从角色真实动作集中挑选最贴切的身体动作（过滤掉 default 与 special 清场动作，并优先未重复使用的新鲜变体）。 */
export function pickMoodMatchedMotion(
  motions: string[],
  mood: DramaticContextMood | TargetMood,
  modelPath?: string,
  restrainedRole?: boolean,
  avoidMotions?: ReadonlySet<string> | string[],
  modelsRoot?: string,
  diversity?: {
    motionCounts?: ReadonlyMap<string, number>
    stemCounts?: ReadonlyMap<string, number>
  }
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
  const activePool = motions.filter((m) => isMotionAutoPickAllowed(m, modelPath))
  const pool = sortMotionsByStyleConsistency(activePool.length > 0 ? activePool : motions)
  const wantedRoles =
    MOTION_ROLES_BY_DRAMATIC_MOOD[dramaticMood] ?? MOTION_ROLES_BY_DRAMATIC_MOOD.neutral

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

  if (diversity?.motionCounts || diversity?.stemCounts) {
    const mCounts = diversity.motionCounts
    const sCounts = diversity.stemCounts
    const scored = pool
      .map((m, idx) => {
        const info = inspectModelMotion(modelPath, m, modelsRoot)
        if (info.contextTag || isOppositeRole(info.role)) return null
        const roleIdx = wantedRoles.indexOf(info.role)
        let score = roleIdx >= 0 ? 30 - roleIdx * 4 : 4
        if (restrainedRole && info.role === 'playful') score -= 40
        const { style, stem } = parseMotionStem(m)
        if (style.startsWith('normal')) score += 1.5
        if (avoid?.has(m)) score -= 25
        score -= (mCounts?.get(m) ?? 0) * 40
        score -= (sCounts?.get(stem) ?? 0) * 16
        return { m, score, idx }
      })
      .filter((entry): entry is { m: string; score: number; idx: number } => entry !== null)
      .sort((a, b) => b.score - a.score || a.idx - b.idx)
    if (scored.length > 0) return scored[0].m
  }

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

  return (
    pickFromRoles(false) ||
    pool.find((m) => {
      if (avoid?.has(m)) return false
      const info = inspectModelMotion(modelPath, m, modelsRoot)
      return !info.contextTag && !isOppositeRole(info.role)
    }) ||
    pickFromRoles(true) ||
    pool.find((m) => !avoid?.has(m) && !inspectModelMotion(modelPath, m, modelsRoot).contextTag) ||
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
  cheerfulScene?: boolean
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
      cheerfulScene: params.cheerfulScene,
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
      cheerfulScene: params.cheerfulScene,
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
  // 官方近期剧集约 61.7% 跨句延续同一表情；哭泣/悲伤高潮段落需要持续挂着含泪/失落神情 4~8+ 句而非逐句乱跳，
  // 因此 cry/sad/cold_hollow 允许连续维持至 8 句（>=9 句才温和提示），trouble/serious/angry 允许至 4 句（>=5 句提示），
  // 中性或纯笑脸在连续 >=3 句时提示微调，避免僵笑或全程 face_normal_01。
  const facialRole = facial
    ? inspectModelFacial(params.modelPath, facial, params.modelsRoot).role
    : 'other'
  const facialHoldLimit =
    facialRole === 'neutral' ||
    facialRole === 'genuine_smile' ||
    facialRole === 'closed_smile' ||
    facialRole === 'playful'
      ? 3
      : facialRole === 'cry' || facialRole === 'sad' || facialRole === 'cold_hollow'
        ? 9
        : 5
  if (facial && sameFacialCount >= facialHoldLimit) {
    issues.push({
      field: 'repetition',
      code: 'consecutive_same_facial',
      severity: 'medium',
      message: `表情 ${facial} 已连续 ${sameFacialCount} 句未变化，建议随台词语气微调`
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
