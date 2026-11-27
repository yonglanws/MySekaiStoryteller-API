import { resolvePersonaByName, type PersonaEntry } from './personas'
import type { StagedCastPlan, StagedDialogue } from './staged'
import { hasZeroWidthChars, stripZeroWidthChars } from './ttsText'

export type DialogueLintCode =
  | 'therapy_cliche'
  | 'ai_slop_phrasing'
  | 'stage_direction_leak'
  | 'moralizing_ending'
  | 'uniform_cadence'
  | 'exclamation_overload'
  | 'address_mismatch'
  | 'gender_label_violation'
  | 'persona_ooc'
  | 'prompt_coverage_gap'
  | 'monologue_overload'
  | 'speaker_imbalance'
  | 'repetitive_opener'
  | 'zero_width_char'

export interface DialogueLintIssue {
  lineId: string
  code: DialogueLintCode
  severity: 'high' | 'medium'
  message: string
}

export interface DialogueLintReport {
  issues: DialogueLintIssue[]
  flaggedLineIds: string[]
  shouldPolish: boolean
}

/** Linter 只需要称呼表、意图理解、角色表与可选人设，避免把整个 plan 耦合进来。 */
export type DialogueLintContext = Partial<
  Pick<StagedCastPlan, 'pairwiseAddress' | 'understanding' | 'cast'>
> & {
  personas?: PersonaEntry[]
}

const THERAPY_CLICHE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /其实我一直想说/, label: '心理咨询式直白剖白「其实我一直想说」' },
  { re: /谢谢你总是这么温柔/, label: '套路化感谢「谢谢你总是这么温柔」' },
  { re: /不管发生什么.{0,12}都在一起/, label: '套路誓言「不管发生什么……都在一起」' },
  { re: /今天的经历让我明白/, label: '说教式总结「今天的经历让我明白」' },
  { re: /经过今天/, label: '说教式总结「经过今天……」' },
  { re: /让我们更加明白/, label: '说教式总结「让我们更加明白」' },
  { re: /我终于明白了/, label: '直白自我解释「我终于明白了」' },
  { re: /真正的意义/, label: '抽象说教词「真正的意义」' },
  { re: /内心深处/, label: '书面抒情套话「内心深处」' },
  { re: /温柔地包容/, label: 'AI 治愈套话「温柔地包容」' },
  { re: /心里暖暖的/, label: 'AI 治愈套话「心里暖暖的」' },
  { re: /心里涌起一股/, label: 'AI 抒情套话「心里涌起一股」' },
  { re: /谢谢你的理解/, label: '套路化感谢「谢谢你的理解」' },
  { re: /有你在真好/, label: '套路化依赖「有你在真好」' },
  { re: /我们会一直走下去/, label: '套路誓言「我们会一直走下去」' },
  { re: /只要不放弃/, label: '励志口号「只要不放弃」' },
  { re: /这正是我们的/, label: '升华总结「这正是我们的……」' },
  { re: /脸上露出了笑容/, label: '旁白式表情描写「脸上露出了笑容」' },
  { re: /敞开心扉|不再迷茫|共同成长/, label: 'AI 心理成长套话' },
  { re: /治愈了我的心|我们之间的羁绊|今后也要携手|心意相通/, label: 'AI 鸡汤抒情套话' }
]

/** 重写人设「用词语感与反AI约束 / 会说与绝不会说」中明确禁用的 AI 客服/公众号/元叙述腔。 */
const AI_SLOP_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /总的来说|综上所述|总而言之|归根结底/, label: '公众号/AI 总结腔' },
  { re: /不得不说|值得一提的是/, label: '公众号点评过渡词' },
  { re: /我(?:非常|完全)?理解你(?:此刻)?的(?:感受|心情|困扰|焦虑|痛苦)/, label: 'AI 共情客服模板' },
  { re: /很高兴为您(?:服务|解答)|请问还有什么我可以帮您/, label: 'AI 客服礼貌模板' },
  { re: /希望这能帮到你|希望能帮到您|祝您今天愉快/, label: 'AI 客服收尾模板' },
  { re: /(?:从以下|提供以下)(?:几|三)[个条](?:方面|建议|方案|维度)/, label: 'AI 分点建议腔' },
  { re: /这个问题很有(?:深度|探讨价值)|值得我们好好探讨/, label: 'AI 访谈总结腔' },
  {
    re: /作为(?:你的朋友，我觉得|一名.{1,10}(?:虚拟歌手|偶像|演员|高中生|画家))/,
    label: 'AI 元身份自述腔'
  },
  { re: /每个人的经历都是宝贵的|人生总有低谷|学会接纳(?:真实|自己)的情绪/, label: 'AI 心灵鸡汤腔' },
  { re: /在数字世界陪伴你|身处不同的次元/, label: 'AI 破壁元叙事模板' },
  { re: /从心理学角度来看|这背后反映出/, label: 'AI 论文分析腔' }
]

const STAGE_ACTION_CORE_RE =
  /^(?:轻笑|大笑|微笑|苦笑|冷笑|坏笑|干笑|嗤笑|偷笑|尴尬地笑|笑着|笑|叹气|轻叹|长叹|叹息|叹了口气|深吸一口气|沉默|沉默片刻|顿了顿|停顿|稍作停顿|点头|点点头|微微点头|摇头|摇摇头|低头|低下头|垂眸|抬头|抬起头|歪头|歪了歪头|脸红|耳根微红|红着脸|撇嘴|鼓脸|嘟嘴|转身|转过身|转过头|背过身|挥手|招手|摆手|挠头|挠了挠头|摸头|抓头发|耸肩|摊手|握拳|攥紧拳头|咬唇|咬住下唇|眨眼|眨眨眼|瞪眼|瞪大眼睛|揉眼睛|擦眼泪|抽泣|哽咽|移开视线|别过视线|别开视线|环顾四周|走近|走上前|后退|退后一步|站起身|起身|坐下|俯身|前倾|抱臂|双手抱胸|摊开双手|伸懒腰|打哈欠|拍拍肩|拍了拍|敲了敲|竖起食指|捂脸|捂嘴|捂住嘴|托腮|叉腰|小声|轻声|低声|压低声音|喃喃|自言自语|干咳|咳嗽|清了清嗓子|深呼吸|耸耸肩|摊摊手|摸摸鼻子|鼓起腮帮|皱眉|皱起眉|瞪了一眼|跳起来|挂上营业微笑|礼貌地欠身|叉起腰笑|抱起吉他|端起茶杯|翻开草图本)$/

const STAGE_ACTION_MODIFIED_RE =
  /^(?:微微|轻轻|无奈地?|苦笑着?|笑着|冷冷地?|温柔地?|认真地?|小声地?|轻声地?|低声地?|慌忙地?|犹豫地?|平静地?|若有所思地?|尴尬地?|俏皮地?|突然|停下来|忍不住|悄悄)?(?:一笑|笑了一声|笑了笑|笑出声|露出微笑|露出受伤的表情|叹了口气|叹了声|点点头|摇摇头|低下头|抬起头|歪了歪头|转过头|转过身|挠了挠头|摸了摸鼻子|耸了耸肩|摊了摊手|眨了眨眼|吐了吐舌头|移开了?视线|别过头|别过脸去|擦了擦眼角|咬了咬嘴唇|皱了皱眉|皱起眉头抱着手臂|双手合十|冷哼一声转过头去|揉了揉眼睛|端起茶杯微微皱眉|笑着拍了拍[^，。！？]{1,8}|看向[^，。！？]{1,8}|望向[^，。！？]{1,8}|盯向[^，。！？]{1,8}|看着[^，。！？]{1,8}|举起[^，。！？]{1,8}|递出[^，。！？]{1,8}|伸出手|缩回手|握紧[^，。！？]{1,8}|压低声音|拉了拉[^，。！？]{1,8}|跺了跺脚|拍了拍[^，。！？]{1,8})$/

const STAGE_DIRECTION_BODY_CUE_RE =
  /^(?:眼神|目光|视线|声音|嘴角|脸上|耳根|双手|手指|眉头)(?:微动|一顿|闪烁|飘向别处|躲闪|柔和下来|冷了下来|暗了一瞬|暗了一下|压低|上扬|微扬|微红|紧握|交叠|紧锁|微蹙)|^心里(?:一紧|暗暗啧了一声)/

const STAGE_DIRECTION_LEAK_PATTERNS: RegExp[] = [
  /(?:^|[，。！？\s])(?:她|他)(?:转过头|低下头|笑了笑|叹了口气|轻声说道|小声嘀咕|沉默了片刻|移开视线|摇了摇头|点了点头)/
]

/** 判断括号或星号内部文本是否属于舞台动作/神态提示，而非角色心里话。 */
export function isStageDirectionParenthetical(inner: string): boolean {
  const clean = inner
    .trim()
    .replace(/[。，、,.！!？?~～…]+$/g, '')
    .trim()
  if (!clean || clean.length > 22) return false
  // 含明显内心独白口吻/疑问/第一人称思考时保留为心里话
  if (
    /[？?]|^(?:……|难道|怎么|为什么|还是|要是|如果|糟了|不对|算了|真是|该不会|果然|我|她|他|这|那|好想|真希望|不会吧|居然|原来|总觉得|好像|明明|可是|刚才|说不定|至少|也许|希望)/.test(
      clean
    )
  ) {
    return false
  }
  return (
    STAGE_ACTION_CORE_RE.test(clean) ||
    STAGE_ACTION_MODIFIED_RE.test(clean) ||
    STAGE_DIRECTION_BODY_CUE_RE.test(clean)
  )
}

/** 检测台词中是否夹带括号动作提示、星号动作描写（如 *叹了口气*）或第三人称动作旁白。 */
export function hasSpokenStageDirectionLeak(content: string): boolean {
  if (STAGE_DIRECTION_LEAK_PATTERNS.some((re) => re.test(content))) return true
  const parenRe = /[（(]([^（）()]+)[）)]/g
  let match: RegExpExecArray | null
  while ((match = parenRe.exec(content)) !== null) {
    if (isStageDirectionParenthetical(match[1])) return true
  }
  const starRe = /\*([^*\n]{1,24})\*/g
  while ((match = starRe.exec(content)) !== null) {
    if (isStageDirectionParenthetical(match[1])) return true
  }
  return false
}

/** 清理台词中的零宽字符（\u200b/\ufeff 等），保留换行与常规标点。 */
export function sanitizeDialogueContent(content: string): string {
  if (!content) return content
  return stripZeroWidthChars(content)
}

/** 清理台词中的括号/星号动作提示（如 (微笑)、*叹了口气*）与零宽字符，同时保留真正的心里话括号独白。 */
export function repairSpokenStageDirections(content: string): string {
  if (!content) return content
  const withoutZwc = stripZeroWidthChars(content)
  let changed = withoutZwc !== content
  let replaced = withoutZwc.replace(/[（(]([^（）()]+)[）)]/g, (full, inner: string) => {
    if (!isStageDirectionParenthetical(inner)) return full
    changed = true
    return ''
  })
  replaced = replaced.replace(/\*([^*\n]{1,24})\*/g, (full, inner: string) => {
    if (!isStageDirectionParenthetical(inner)) return full
    changed = true
    return ''
  })
  if (!changed) return content
  const cleaned = replaced
    .split('\n')
    .map((line) =>
      line
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/^[，,、]\s*/, '')
        .trim()
    )
    .filter((line, idx, arr) => line.length > 0 || (arr.length === 1 && idx === 0))
    .join('\n')
    .trim()
  return cleaned || '……'
}

const MORALIZING_ENDING_PATTERNS: RegExp[] = [
  /只要.{0,10}(?:大家|我们|你).{0,8}在一起/,
  /一定会(?:越来越好|变得更好|没问题的)/,
  /今天真是.{0,8}(?:难忘|美好|充实|有意义)的一天/,
  /无论未来.{0,12}都会/,
  /这就是.{0,8}的意义/,
  /以后也要一直/,
  /(?:一定|肯定)能(?:做到|成功|克服)/
]

/** Stage 2 常见的句首填充词：同一个人反复用同一种开场，会像 AI 在轮播模板。 */
const REPETITIVE_OPENERS = ['其实', '不过', '说起来', '那个', '话说'] as const

const REQUEST_FUNCTION_CHARS = new Set([
  '的',
  '了',
  '着',
  '过',
  '吧',
  '呢',
  '吗',
  '啊',
  '呀',
  '哦',
  '嘛',
  '把',
  '被',
  '给',
  '和',
  '与',
  '及',
  '或',
  '是',
  '在',
  '从',
  '到',
  '向',
  '对',
  '为',
  '也',
  '都',
  '就',
  '还',
  '又',
  '很',
  '太',
  '更',
  '最',
  '不',
  '没',
  '要',
  '会',
  '能',
  '可',
  '让',
  '使',
  '请',
  '想',
  '一',
  '些',
  '点',
  '个',
  '这',
  '那',
  '们',
  '两',
  '二',
  '人',
  '场',
  '次',
  '段'
])

function visibleLength(text: string): number {
  return Array.from(text.replace(/[\s\n]/g, '')).length
}

function distinctiveChars(text: string, castNames: string[]): string[] {
  let rest = text
  for (const name of castNames) {
    if (name.length >= 2) rest = rest.split(name).join(' ')
  }
  const chars = new Set<string>()
  for (const char of rest) {
    if (REQUEST_FUNCTION_CHARS.has(char)) continue
    if (/[\s，。；、！？,.;!?…—～「」『』【】（）()\d]/.test(char)) continue
    chars.add(char)
  }
  return [...chars]
}

function isCovered(chars: string[], fullText: string): boolean {
  if (chars.length === 0) return true
  const hits = chars.filter((char) => fullText.includes(char)).length
  return hits >= 2 || hits === chars.length
}

function leadingOpener(content: string): string | null {
  const text = content.replace(/^[「『“"'（(…—\s]+/, '')
  for (const opener of REPETITIVE_OPENERS) {
    if (text.startsWith(opener)) return opener
  }
  return null
}

function promptCoverageIssues(
  dialogue: StagedDialogue,
  understanding: NonNullable<StagedCastPlan['understanding']>,
  castNames: string[]
): DialogueLintIssue[] {
  const issues: DialogueLintIssue[] = []
  const anchorId = dialogue.lines[0]?.id ?? 'l1'
  const fullText = dialogue.lines.map((line) => line.content).join('\n')

  for (const request of (understanding.explicitRequests ?? []).slice(0, 4)) {
    const chars = distinctiveChars(request, castNames)
    if (chars.length === 0) continue
    if (isCovered(chars, fullText)) continue
    issues.push({
      lineId: anchorId,
      code: 'prompt_coverage_gap',
      severity: 'medium',
      message: `用户明确要求「${request}」没有在任何台词里落地，请让人物在对话中自然提到相关的人/物/事`
    })
  }

  const hooks = understanding.canonHooks ?? []
  if (hooks.length > 0) {
    const hookChars = distinctiveChars(hooks.join('、'), castNames)
    if (hookChars.length > 0 && !isCovered(hookChars, fullText)) {
      issues.push({
        lineId: anchorId,
        code: 'prompt_coverage_gap',
        severity: 'medium',
        message: `官方钩子（${hooks.join('；')}）一个都没在台词里出现，请挑一个不突兀地自然带进对话`
      })
    }
  }
  return issues
}

function distributionIssues(dialogue: StagedDialogue): DialogueLintIssue[] {
  const issues: DialogueLintIssue[] = []
  const lines = dialogue.lines

  let wallRun = 0
  for (const line of lines) {
    if (visibleLength(line.content) > 26) {
      wallRun += 1
      if (wallRun === 6) {
        issues.push({
          lineId: line.id,
          code: 'monologue_overload',
          severity: 'medium',
          message: '连续 6 句以上都是长句，形成说教墙；请把其中几句拆成短反应、抢话或停顿'
        })
      }
    } else {
      wallRun = 0
    }
  }

  if (lines.length >= 10) {
    const perSpeaker = new Map<string, number>()
    for (const line of lines) perSpeaker.set(line.speaker, (perSpeaker.get(line.speaker) ?? 0) + 1)
    if (perSpeaker.size === 2) {
      const [dominant] = [...perSpeaker.entries()].sort((a, b) => b[1] - a[1])
      if (dominant[1] / lines.length > 0.72) {
        const target = lines.find((line) => line.speaker === dominant[0])
        issues.push({
          lineId: target?.id ?? lines[0].id,
          code: 'speaker_imbalance',
          severity: 'medium',
          message: `双人场景里 ${dominant[0]} 占了 ${dominant[1]}/${lines.length} 句，另一人几乎没接上；请把部分解释性长句让给对方用短反应或反问接住`
        })
      }
    }
  }
  return issues
}

function repetitiveOpenerIssues(dialogue: StagedDialogue): DialogueLintIssue[] {
  const lines = dialogue.lines
  if (lines.length < 6) return []
  const issues: DialogueLintIssue[] = []
  const occurrences = new Map<string, typeof lines>()
  for (const line of lines) {
    const opener = leadingOpener(line.content)
    if (!opener) continue
    const list = occurrences.get(opener) ?? []
    list.push(line)
    occurrences.set(opener, list)
  }
  for (const [opener, list] of occurrences) {
    if (list.length < 3) continue
    const last = list[list.length - 1]
    issues.push({
      lineId: last.id,
      code: 'repetitive_opener',
      severity: 'medium',
      message: `「${opener}……」这类句首填充词出现 ${list.length} 次，过于模板化；请换掉这一句的开头，直接从具体内容说起`
    })
  }
  return issues
}

const MIZUKI_SPEAKER_RE = /^(?:晓山)?瑞希$|^Amia$/i
const MIZUKI_SELF_GENDER_LABEL_RE =
  /(?:其实)?我是(?:个)?(?:男孩子|男生|女孩子|女生|男孩|女孩|男的|女的)|作为(?:一个)?(?:男孩子|男生|女孩子|女生)|跨性别|伪娘|男娘/
const MIZUKI_THIRD_PARTY_GENDER_RE =
  /(?:瑞希|晓山|Amia)[^。！？\n]{0,8}(?:是个?|本来就是|其实是|毕竟是)(?:男孩子|男生|女孩子|女生|男孩|女孩|男的|女的)|(?:男孩子|男生|女孩子|女生|伪娘|男娘)[^。！？\n]{0,6}(?:瑞希|晓山|Amia)|(?:瑞希|晓山|Amia)[^。！？\n]{0,12}(?:跨性别|伪娘|男娘)/

function genderLabelIssues(
  dialogue: StagedDialogue,
  plan?: DialogueLintContext
): DialogueLintIssue[] {
  const hasMizuki =
    dialogue.lines.some((l) => MIZUKI_SPEAKER_RE.test(l.speaker.trim())) ||
    (plan?.cast ?? []).some((m) => /瑞希|mizuki/i.test(`${m.name} ${m.fullName} ${m.path}`))
  if (!hasMizuki) return []

  const issues: DialogueLintIssue[] = []
  for (const line of dialogue.lines) {
    const isMizukiSpeaker = MIZUKI_SPEAKER_RE.test(line.speaker.trim())
    if (
      (isMizukiSpeaker && MIZUKI_SELF_GENDER_LABEL_RE.test(line.content)) ||
      MIZUKI_THIRD_PARTY_GENDER_RE.test(line.content)
    ) {
      issues.push({
        lineId: line.id,
        code: 'gender_label_violation',
        severity: 'high',
        message: '违反「晓山瑞希」人设留白红线：严禁替瑞希下性别认同定论或贴任何性别标签'
      })
    }
  }
  return issues
}

function personaOocIssues(
  dialogue: StagedDialogue,
  plan?: DialogueLintContext
): DialogueLintIssue[] {
  const issues: DialogueLintIssue[] = []
  const cast = plan?.cast ?? []
  const personas = plan?.personas ?? []
  const understanding = plan?.understanding
  const contextText = understanding
    ? [
        ...(understanding.explicitRequests ?? []),
        understanding.implicitSubtext ?? '',
        understanding.relationshipDynamic ?? '',
        understanding.emotionalArc ?? '',
        ...(understanding.canonHooks ?? [])
      ]
        .filter(Boolean)
        .join('\n')
    : ''

  const isModeActive = (speaker: string, keywordRe: RegExp, roleKeywordRe: RegExp): boolean => {
    if (keywordRe.test(speaker)) return true
    const member = cast.find(
      (m) => m.name === speaker || m.fullName === speaker || (m.role && m.role.includes(speaker))
    )
    if (member && roleKeywordRe.test(`${member.name} ${member.fullName} ${member.role}`)) {
      return true
    }

    // 当传入全量 personas（同时含基础形态与变体形态）时，绝不能用 canonicalName 回退误激活变体规则；
    // 仅当解析出的目标人设本身是该变体（无基础形态或上下文明确触发变体模式）时才激活。
    const resolved = resolvePersonaByName(
      personas,
      speaker,
      contextText ? { contextText } : undefined
    )
    if (resolved?.isVariant && keywordRe.test(resolved.name)) {
      return true
    }
    if (!resolved) {
      const matchingVariants = personas.filter(
        (p) =>
          p.isVariant &&
          keywordRe.test(p.name) &&
          (p.name === speaker ||
            p.canonicalName === speaker ||
            p.canonicalName?.includes(speaker) ||
            (member ? p.canonicalName === member.fullName : false))
      )
      if (matchingVariants.length > 0) {
        const hasBaseCanonical = matchingVariants.some((v) =>
          personas.some(
            (other) =>
              !other.isVariant &&
              (other.name === v.canonicalName ||
                other.canonicalName === v.canonicalName ||
                other.name === speaker)
          )
        )
        if (!hasBaseCanonical) return true
      }
    }
    return false
  }

  for (const line of dialogue.lines) {
    const sp = line.speaker.trim()
    // 宵崎奏 / 东云慎英：人设严禁波浪号「～」与音符「♪」
    if (/^(?:宵崎)?奏$|^东云慎英$|^慎英$/.test(sp) && /[～~♪]/.test(line.content)) {
      issues.push({
        lineId: line.id,
        code: 'persona_ooc',
        severity: 'high',
        message: `${sp} 的语感克制平淡，人设明确禁用波浪号「～」与音符「♪」`
      })
    }

    // 优男彰人形态：严禁窜戏到私下毒舌腔
    if (
      isModeActive(sp, /优男彰人|优男模式/, /优男彰人|优男模式/) &&
      /(?:……啧|啰里啰唆|狂什么啊|别胡说八道)/.test(line.content)
    ) {
      issues.push({
        lineId: line.id,
        code: 'persona_ooc',
        severity: 'high',
        message: '「优男彰人」营业模式下严禁混入私下粗口或毒舌腔，请改用礼貌却暗藏疏离的措辞'
      })
    }

    // 优等生真冬形态：严禁泄露 25时 / Nightcord / OWN / 深夜称呼
    if (
      isModeActive(sp, /优等生真冬|班长真冬/, /优等生真冬|班长真冬|优等生模式|班长模式/) &&
      /(?:25时|Nightcord|\bOWN\b|绘绘|Amia)/i.test(line.content)
    ) {
      issues.push({
        lineId: line.id,
        code: 'persona_ooc',
        severity: 'high',
        message: '「优等生真冬」白天营业模式下严禁泄露 25时 / Nightcord / OWN / 深夜网名等机密'
      })
    }
  }
  return issues
}

function matchesSpeakerName(
  speaker: string,
  target: string,
  cast: StagedCastPlan['cast']
): boolean {
  if (speaker === target) return true
  const member = cast.find((m) => m.name === speaker || m.fullName === speaker)
  return Boolean(member && (member.name === target || member.fullName === target))
}

/**
 * 零延迟、确定性官方质感反套路对白 Linter。
 *
 * 检查高频 AI 写作痕迹与人设红线：
 * 1. 心理咨询式直白剖白与套话（therapy_cliche）
 * 2. AI 客服/公众号总结/元叙事禁语（ai_slop_phrasing）
 * 3. 夹带括号/星号动作或第三人称动作旁白泄露（stage_direction_leak）
 * 4. 结尾最后两句升华说教总结（moralizing_ending）
 * 5. 连续齐整句长或感叹号过载（uniform_cadence / exclamation_overload）
 * 6. 违背 Stage 1 / 人设称呼表的两两官方称呼（address_mismatch，含姓氏误称）
 * 7. 晓山瑞希性别认同留白红线（gender_label_violation）与确定性 OOC 红线（persona_ooc）
 * 8. 用户明示诉求/官方钩子没有落地（prompt_coverage_gap）
 * 9. 长句说教墙与双人戏份失衡（monologue_overload / speaker_imbalance）
 * 10. 句首填充词模板化重复（repetitive_opener）与零宽字符（zero_width_char）
 */
export function lintDialogueFidelity(
  dialogue: StagedDialogue,
  plan?: DialogueLintContext
): DialogueLintReport {
  const issues: DialogueLintIssue[] = []
  const lines = dialogue.lines
  if (lines.length === 0) {
    return { issues, flaggedLineIds: [], shouldPolish: false }
  }

  for (const line of lines) {
    const content = line.content
    for (const rule of THERAPY_CLICHE_PATTERNS) {
      if (rule.re.test(content)) {
        issues.push({
          lineId: line.id,
          code: 'therapy_cliche',
          severity: 'high',
          message: `${rule.label}，请改用具体细节、停顿或侧面回应表现情绪`
        })
        break
      }
    }
    for (const rule of AI_SLOP_PATTERNS) {
      if (rule.re.test(content)) {
        issues.push({
          lineId: line.id,
          code: 'ai_slop_phrasing',
          severity: 'high',
          message: `命中人设禁用的${rule.label}，请改为符合角色口语与年龄的真实对话`
        })
        break
      }
    }
    if (hasSpokenStageDirectionLeak(content)) {
      issues.push({
        lineId: line.id,
        code: 'stage_direction_leak',
        severity: 'high',
        message: '台词内夹带了动作/神态描写，请删除括号/星号动作或第三人称叙述，只保留说出口的话'
      })
    }
    if (hasZeroWidthChars(content)) {
      issues.push({
        lineId: line.id,
        code: 'zero_width_char',
        severity: 'high',
        message: '台词内混入了零宽字符（如 \\u200b/\\ufeff），请清理为纯文本对白'
      })
    }
  }

  // 结尾反说教总结（仅检查最后 2 句）
  const tailStart = Math.max(0, lines.length - 2)
  for (let i = tailStart; i < lines.length; i++) {
    const line = lines[i]
    if (MORALIZING_ENDING_PATTERNS.some((re) => re.test(line.content))) {
      issues.push({
        lineId: line.id,
        code: 'moralizing_ending',
        severity: 'high',
        message: '结尾出现升华/总结式台词，请改收在安静余韵、日常小约定或轻描淡写的打趣里'
      })
    }
  }

  // 连续齐整句长检查（连续 >= 5 句长度几乎一致且均 >= 10 字）
  let uniformRun = 1
  for (let i = 1; i < lines.length; i++) {
    const prevLen = visibleLength(lines[i - 1].content)
    const currLen = visibleLength(lines[i].content)
    if (prevLen >= 10 && currLen >= 10 && Math.abs(currLen - prevLen) <= 3) {
      uniformRun += 1
      if (uniformRun === 5) {
        issues.push({
          lineId: lines[i].id,
          code: 'uniform_cadence',
          severity: 'medium',
          message: '连续多句字数过于齐整，建议将本句拉短成自然短反应或打断节奏'
        })
      }
    } else {
      uniformRun = 1
    }
  }

  // 感叹号过载检查（>= 6 句且含叹号句占比 > 28%）
  if (lines.length >= 6) {
    const exclLines = lines.filter((l) => /[!！]/.test(l.content))
    if (exclLines.length / lines.length > 0.28) {
      const target = exclLines[exclLines.length - 1]
      issues.push({
        lineId: target.id,
        code: 'exclamation_overload',
        severity: 'medium',
        message: `全场感叹号密度偏高（${exclLines.length}/${lines.length}），请柔化语气改用句号或省略号`
      })
    }
  }

  // 两两称呼一致性检查（昵称偏离 + 姓氏/两字误称）
  const addresses = plan?.pairwiseAddress ?? []
  if (addresses.length > 0) {
    const cast = plan?.cast ?? []
    for (const rule of addresses) {
      const zh = rule.zh?.trim()
      const to = rule.to?.trim()
      const from = rule.from?.trim()
      if (!from || !to || !zh || zh === to) continue
      const member = cast.find((entry) => entry.name === to || entry.fullName === to)
      const toShort = member?.name ?? to
      const toFull = member?.fullName ?? to
      const familyName = member ? member.fullName.replace(member.name, '').trim() : ''
      if (zh === toShort) continue
      for (const line of lines) {
        if (!matchesSpeakerName(line.speaker, from, cast)) continue
        if (line.content.includes(zh)) continue
        if (
          line.content.includes(toShort) ||
          (toFull !== toShort && line.content.includes(toFull))
        ) {
          issues.push({
            lineId: line.id,
            code: 'address_mismatch',
            severity: 'high',
            message: `${from} 对 ${to} 的约定称呼为「${zh}」，句中误用了「${to}」`
          })
          continue
        }
        if (familyName.length >= 2 && line.content.includes(familyName)) {
          issues.push({
            lineId: line.id,
            code: 'address_mismatch',
            severity: 'high',
            message: `${from} 对 ${to} 的约定称呼为「${zh}」，句中误用了姓氏「${familyName}」`
          })
        }
      }
    }
  }

  issues.push(...genderLabelIssues(dialogue, plan))
  issues.push(...personaOocIssues(dialogue, plan))

  const understanding = plan?.understanding
  if (understanding) {
    const castNames = (plan?.cast ?? []).flatMap((member) =>
      [member.name, member.fullName].filter(
        (value) => typeof value === 'string' && value.length >= 2
      )
    )
    issues.push(...promptCoverageIssues(dialogue, understanding, castNames))
  }

  issues.push(...distributionIssues(dialogue))
  issues.push(...repetitiveOpenerIssues(dialogue))

  const flaggedLineIds = Array.from(new Set(issues.map((item) => item.lineId)))
  const hasHigh = issues.some((item) => item.severity === 'high')
  return {
    issues,
    flaggedLineIds,
    shouldPolish: hasHigh || issues.length >= 2
  }
}
