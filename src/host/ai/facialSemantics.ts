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

const facialCache = new Map<string, FacialInspection>()
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

function readCurveValues(motion3Path: string): Map<string, number> | null {
  try {
    const raw = fs.readFileSync(motion3Path, 'utf8')
    const parsed = JSON.parse(raw) as {
      Curves?: Array<{ Id?: string; Segments?: number[] }>
    }
    if (!Array.isArray(parsed.Curves)) return null
    const values = new Map<string, number>()
    for (const curve of parsed.Curves) {
      const id = typeof curve?.Id === 'string' ? curve.Id : ''
      const segs = curve?.Segments
      if (!id || !Array.isArray(segs) || segs.length < 2) continue
      // 取动作稳定段（末尾关键帧值若存在则优先末尾，否则取首关键帧值）
      const val = segs.length >= 4 && typeof segs[segs.length - 1] === 'number'
        ? segs[segs.length - 1]
        : segs[1]
      if (typeof val === 'number' && Number.isFinite(val)) {
        values.set(id, val)
      }
    }
    return values
  } catch {
    return null
  }
}

function resolveMotion3File(
  modelPath: string,
  facialName: string,
  modelsRoot: string
): string | null {
  const clean = modelPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const modelDir = path.dirname(clean)
  if (!modelDir || modelDir === '.') return null
  for (const sub of ['motions', 'motion']) {
    const full = path.join(modelsRoot, modelDir, sub, `${facialName}.motion3.json`)
    if (fs.existsSync(full)) return full
  }
  return null
}

function classifyByName(facialName: string): FacialInspection {
  const lower = facialName.toLowerCase()
  if (/^face_dark/.test(lower)) {
    if (lower.includes('sad')) return { role: 'sad', label: '阴郁低落', fromMotion3: false }
    if (lower.includes('angry')) return { role: 'angry', label: '阴沉冷怒', fromMotion3: false }
    if (lower.includes('trouble')) return { role: 'trouble', label: '阴郁困扰', fromMotion3: false }
    if (lower.includes('closeeye')) return { role: 'closed_troubled', label: '沉重闭眼', fromMotion3: false }
    return { role: 'cold_hollow', label: '阴沉面无表情', fromMotion3: false }
  }
  if (/^face_(?:coldeyes|emptiness|nhi)/.test(lower)) {
    return { role: 'cold_hollow', label: '空洞/冷眼', fromMotion3: false }
  }
  if (/^face_(?:sharp|serious)/.test(lower)) {
    return { role: 'serious', label: '认真/锐利', fromMotion3: false }
  }
  if (/^face_smile/.test(lower)) {
    return { role: 'genuine_smile', label: '微笑', fromMotion3: false }
  }
  if (/^face_(?:wink|smug|doya|play|sing|sparkling)/.test(lower)) {
    return { role: 'playful', label: '俏皮/得意/闪亮', fromMotion3: false }
  }
  if (/^face_closeeye/.test(lower)) {
    return { role: 'closed_neutral', label: '轻闭眼', fromMotion3: false }
  }
  if (/^face_(?:cry)/.test(lower)) {
    return { role: 'cry', label: '落泪/哭泣', fromMotion3: false }
  }
  if (/^face_(?:sad|lookdown|sigh|regret|tired|baffling)/.test(lower)) {
    return { role: 'sad', label: '低落/失落', fromMotion3: false }
  }
  if (/^face_(?:trouble|worry|dizzy|hawawa)/.test(lower)) {
    return { role: 'trouble', label: '困扰/为难', fromMotion3: false }
  }
  if (/^face_(?:angry|disgust)/.test(lower)) {
    return { role: 'angry', label: '生气/不满', fromMotion3: false }
  }
  if (/^face_(?:surprise|shock|notice|scared)/.test(lower)) {
    return { role: 'surprise', label: '惊讶/吃惊', fromMotion3: false }
  }
  if (/^face_(?:shy|blushed)/.test(lower)) {
    return { role: 'shy', label: '害羞/微红', fromMotion3: false }
  }
  if (/^face_sleepy/.test(lower)) {
    return { role: 'sleepy', label: '犯困/倦意', fromMotion3: false }
  }
  if (/^face_(?:normal|smallmouth|lookaway)/.test(lower)) {
    return { role: 'neutral', label: '平静自然', fromMotion3: false }
  }
  return { role: 'other', label: '常规神情', fromMotion3: false }
}

function classifyCurves(
  facialName: string,
  curves: Map<string, number>
): FacialInspection {
  const num = (id: string): number => curves.get(id) ?? 0
  const eyeOpen = Math.min(num('ParamEyeLOpen'), num('ParamEyeROpen'))
  const eyeSmile = (num('ParamEyeLSmile') + num('ParamEyeRSmile')) / 2
  const browY = (num('ParamBrowLY') + num('ParamBrowRY')) / 2
  const browAngle = (num('ParamBrowLAngle') + num('ParamBrowRAngle')) / 2
  const mouthForm = num('ParamMouthForm')
  const mouthOpen = num('ParamMouthOpenY')
  const tear = Math.max(num('ParamTear'), num('ParamEyeTeary'))
  const cheek = Math.max(num('ParamCheek'), num('ParamCheek2'))
  const shadow = num('ParamFaceShadow')
  const sweat = num('ParamSweatOn')
  const eyeHi = num('ParamEyeHi')
  const lower = facialName.toLowerCase()

  const closed = eyeOpen <= 0.08
  const darkPrefix = lower.startsWith('face_dark') || lower.includes('nhi') || shadow > 0.15 || eyeHi < -0.2

  if (tear > 0.2) {
    if (mouthForm >= 0.25 || eyeSmile >= 0.4) {
      return { role: 'tearful_smile', label: '含泪微笑', fromMotion3: true }
    }
    return { role: 'cry', label: '含泪/哭泣', fromMotion3: true }
  }

  if (lower.startsWith('face_smile') || lower.startsWith('face_closeeye')) {
    if (browY < -0.2 || browAngle > 0.35 || eyeSmile < -0.15 || sweat > 0.2) {
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
        role: browY < -0.15 ? 'closed_troubled' : 'closed_neutral',
        label: browY < -0.15 ? '闭眼隐忍/思考' : '安静闭眼',
        fromMotion3: true
      }
    }
  }

  if (darkPrefix && mouthForm <= 0.05) {
    return {
      role: lower.includes('sad') ? 'sad' : lower.includes('angry') ? 'angry' : 'cold_hollow',
      label: lower.includes('sad') ? '阴郁低落' : lower.includes('angry') ? '阴沉压迫' : '阴暗/失神冷脸',
      fromMotion3: true
    }
  }

  if (lower.includes('shy') || lower.includes('blushed') || (cheek >= 0.5 && browAngle >= -0.1 && mouthForm >= -0.1)) {
    return { role: 'shy', label: '脸红/害羞', fromMotion3: true }
  }

  if (browAngle <= -0.3 && mouthForm <= 0.05) {
    return { role: 'angry', label: '蹙眉不满/生气', fromMotion3: true }
  }

  if (browY <= -0.25 && browAngle >= 0.25) {
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
      const curves = readCurveValues(file)
      if (curves) result = classifyCurves(cleanName, curves)
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

export function isSmileLikeFacial(
  facialName: string,
  modelPath?: string,
  modelsRoot?: string
): boolean {
  const { role } = inspectModelFacial(modelPath, facialName, modelsRoot)
  return (
    role === 'genuine_smile' ||
    role === 'closed_smile' ||
    role === 'playful'
  )
}

export function isPositiveOnlyFacial(
  facialName: string,
  modelPath?: string,
  modelsRoot?: string
): boolean {
  const { role } = inspectModelFacial(modelPath, facialName, modelsRoot)
  return (
    role === 'genuine_smile' ||
    role === 'closed_smile' ||
    role === 'playful'
  )
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
  /(开心|高兴|太好了|好耶|太棒了|哈哈|呵呵|嘿嘿|嘻嘻|太幸运|真期待|好期待|好温柔|真漂亮|好喜欢|最喜欢|不愧是|Wonderhoy|真可爱|辛苦啦)/
const NEGATIVE_TEXT_CUE_RE =
  /(难过|伤心|痛苦|抱歉|对不起|对不住|失落|害怕|恐惧|担心|不安|烦死|气死|讨厌|委屈|眼泪|哭|叹气|沉默|沉重|糟糕|惨了|完蛋|不行|做不到|算了|别管|没空|冷漠|无聊|疲惫|累了|苦恼|烦恼|头疼|纠结|勉强)/
const NEGATED_JOY_RE = /(?:不|没|没有|别|哪有|才不|才没有|算不上).{0,3}(?:开心|高兴|笑得出来|轻松)/

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
  restrainedRole?: boolean
  modelsRoot?: string
}): FacialCompatibilityResult {
  const { facial, modelPath, emotion, content, prevTense, restrainedRole, modelsRoot } = params
  if (!facial.trim()) return { ok: true }
  const info = inspectModelFacial(modelPath, facial, modelsRoot)
  const emo = (emotion ?? '').trim()
  const text = content.trim()
  const hasNegCue = NEGATIVE_TEXT_CUE_RE.test(text) || NEGATED_JOY_RE.test(text)
  const hasPosCue = POSITIVE_TEXT_CUE_RE.test(text) && !NEGATED_JOY_RE.test(text)
  const isTenseEmotion = emo === '生气' || emo === '伤心' || emo === '害怕' || emo === '惊讶'

  // 1) 明确负面/紧张情绪绝对禁止搭配纯正微笑/俏皮表情（苦笑 wry_smile 除外）
  if (
    (isTenseEmotion || hasNegCue) &&
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

  // 3) 台词和情绪明确开心轻松时，不挂哭泣/暴怒/阴暗冷脸
  if (
    (emo === '开心' || (hasPosCue && !hasNegCue)) &&
    (info.role === 'sad' ||
      info.role === 'angry' ||
      info.role === 'cry' ||
      info.role === 'cold_hollow' ||
      info.role === 'trouble')
  ) {
    return { ok: false, reason: 'positive_context_sad_or_angry' }
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
  return facials.find((f) => !isSmileLikeFacial(f, modelPath, modelsRoot)) ?? defaultFacial ?? facials[0] ?? 'face_normal_01'
}

export type TargetMood = 'sad' | 'trouble' | 'angry' | 'surprise' | 'shy' | 'neutral' | 'smile'

/** 根据目标情绪从角色实际拥有的表情集合中选择最贴切的表情。 */
export function pickMoodMatchedFacial(
  facials: string[],
  mood: TargetMood,
  modelPath?: string,
  restrainedRole?: boolean,
  modelsRoot?: string
): string {
  const wantRoles: Record<TargetMood, FacialSemanticRole[]> = {
    sad: ['sad', 'closed_troubled', 'trouble', 'cry', 'cold_hollow', 'neutral'],
    trouble: ['trouble', 'closed_troubled', 'wry_smile', 'sad', 'serious', 'neutral'],
    angry: ['angry', 'serious', 'cold_hollow', 'trouble', 'neutral'],
    surprise: ['surprise', 'serious', 'neutral'],
    shy: ['shy', 'wry_smile', 'genuine_smile', 'neutral'],
    neutral: restrainedRole
      ? ['neutral', 'serious', 'cold_hollow', 'closed_neutral']
      : ['neutral', 'serious', 'closed_neutral'],
    smile: restrainedRole
      ? ['wry_smile', 'neutral', 'genuine_smile']
      : ['genuine_smile', 'closed_smile', 'playful', 'neutral']
  }

  for (const wantedRole of wantRoles[mood]) {
    const hit = facials.find(
      (f) => inspectModelFacial(modelPath, f, modelsRoot).role === wantedRole
    )
    if (hit) return hit
  }
  return pickNeutralFacial(facials, undefined, modelPath, restrainedRole, modelsRoot)
}
