import type { StagedCastPlan, StagedDialogue } from './staged'
import { hasZeroWidthChars, stripZeroWidthChars } from './ttsText'

export type DialogueLintCode =
  | 'therapy_cliche'
  | 'stage_direction_leak'
  | 'moralizing_ending'
  | 'uniform_cadence'
  | 'exclamation_overload'
  | 'address_mismatch'
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

/** Linter 只需要称呼表、意图理解与角色表，避免把整个 plan 耦合进来。 */
export type DialogueLintContext = Partial<
  Pick<StagedCastPlan, 'pairwiseAddress' | 'understanding' | 'cast'>
>

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

const STAGE_ACTION_CORE_RE =
  /^(?:轻笑|大笑|微笑|苦笑|冷笑|坏笑|干笑|嗤笑|偷笑|尴尬地笑|笑着|笑|叹气|轻叹|长叹|叹息|叹了口气|深吸一口气|沉默|沉默片刻|顿了顿|停顿|稍作停顿|点头|点点头|微微点头|摇头|摇摇头|低头|低下头|垂眸|抬头|抬起头|歪头|歪了歪头|脸红|耳根微红|红着脸|撇嘴|鼓脸|嘟嘴|转身|转过身|转过头|背过身|挥手|招手|摆手|挠头|挠了挠头|摸头|抓头发|耸肩|摊手|握拳|攥紧拳头|咬唇|咬住下唇|眨眼|眨眨眼|瞪眼|瞪大眼睛|揉眼睛|擦眼泪|抽泣|哽咽|移开视线|别过视线|别开视线|环顾四周|走近|走上前|后退|退后一步|站起身|起身|坐下|俯身|前倾|抱臂|双手抱胸|摊开双手|伸懒腰|打哈欠|拍拍肩|拍了拍|敲了敲|竖起食指|捂脸|捂嘴|捂住嘴|托腮|叉腰|小声|轻声|低声|压低声音|喃喃|自言自语|干咳|咳嗽|清了清嗓子|深呼吸|耸耸肩|摊摊手|摸摸鼻子|鼓起腮帮|皱眉|皱起眉|瞪了一眼)$/

const STAGE_ACTION_MODIFIED_RE =
  /^(?:微微|轻轻|无奈地?|苦笑着?|笑着|冷冷地?|温柔地?|认真地?|小声地?|轻声地?|低声地?|慌忙地?|犹豫地?|平静地?|若有所思地?|尴尬地?|突然|停下来|忍不住|悄悄)?(?:一笑|笑了一声|笑了笑|笑出声|露出微笑|叹了口气|叹了声|点点头|摇摇头|低下头|抬起头|歪了歪头|转过头|转过身|挠了挠头|摸了摸鼻子|耸了耸肩|摊了摊手|眨了眨眼|移开了?视线|别过头|擦了擦眼角|咬了咬嘴唇|皱了皱眉|双手合十|看向[^，。！？]{1,8}|望向[^，。！？]{1,8}|盯向[^，。！？]{1,8}|看着[^，。！？]{1,8}|举起[^，。！？]{1,8}|递出[^，。！？]{1,8}|伸出手|缩回手|握紧[^，。！？]{1,8}|压低声音|拉了拉[^，。！？]{1,8}|跺了跺脚|拍了拍[^，。！？]{1,8})$/

const STAGE_DIRECTION_BODY_CUE_RE =
  /^(?:眼神|目光|视线|声音|嘴角|脸上|耳根|双手|手指|眉头)(?:微动|一顿|闪烁|飘向别处|躲闪|柔和下来|冷了下来|压低|上扬|微红|紧握|交叠|紧锁|微蹙)/

const STAGE_DIRECTION_LEAK_PATTERNS: RegExp[] = [
  /(?:^|[，。！？\s])(?:她|他)(?:转过头|低下头|笑了笑|叹了口气|轻声说道|小声嘀咕|沉默了片刻|移开视线|摇了摇头|点了点头)/
]

/** 判断括号内部文本是否属于舞台动作/神态提示，而非角色心里话。 */
export function isStageDirectionParenthetical(inner: string): boolean {
  const clean = inner
    .trim()
    .replace(/[。，、,.！!？?~～…]+$/g, '')
    .trim()
  if (!clean || clean.length > 22) return false
  // 含明显内心独白口吻/疑问/第一人称思考时保留为心里话
  if (
    /[？?]|^(?:……|难道|怎么|为什么|还是|要是|如果|糟了|不对|算了|真是|该不会|果然|我|她|他|这|那|好想|真希望|不会吧|居然|原来)/.test(
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

/** 检测台词中是否夹带括号动作提示或第三人称动作旁白。 */
export function hasSpokenStageDirectionLeak(content: string): boolean {
  if (STAGE_DIRECTION_LEAK_PATTERNS.some((re) => re.test(content))) return true
  const re = /[（(]([^（）()]+)[）)]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(content)) !== null) {
    if (isStageDirectionParenthetical(match[1])) return true
  }
  return false
}

/** 清理台词中的零宽字符（\u200b/\ufeff 等），保留换行与常规标点。 */
export function sanitizeDialogueContent(content: string): string {
  if (!content) return content
  return stripZeroWidthChars(content)
}

/** 清理台词中的括号动作提示（如 (微笑)、（挠头））与零宽字符，同时保留真正的心里话括号独白。 */
export function repairSpokenStageDirections(content: string): string {
  if (!content) return content
  const withoutZwc = stripZeroWidthChars(content)
  let changed = withoutZwc !== content
  const replaced = withoutZwc.replace(/[（(]([^（）()]+)[）)]/g, (full, inner: string) => {
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

/**
 * 请求关键词里太泛的虚词/元词：不参与覆盖率判断，否则任何台词都会被判成“已覆盖”。
 * 只保留单字（按字符比对），多字短语没有分词器时无法可靠匹配。
 */
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

/**
 * 抽出诉求里真正有区分度的汉字（去掉虚词、标点、数字与登场角色名），
 * 用于零成本的“诉求是否落地”检查。没有分词器时按字符比对更稳。
 */
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

/** 至少命中 2 个区分字（或全部区分字）才算这条诉求在台词里真正落地。 */
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

  // 连续 6 句以上、每句都超过 26 字：典型说教墙/长独白堆叠。
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

  // 双人场景一人占掉 > 72% 的台词：官方几乎没有这种失衡。
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

/**
 * 零延迟、确定性官方质感反套路对白 Linter。
 *
 * 检查 8 类高频 AI 写作痕迹：
 * 1. 心理咨询式直白剖白与套话（therapy_cliche）
 * 2. 夹带动作/神态旁白泄露（stage_direction_leak）
 * 3. 结尾最后两句升华说教总结（moralizing_ending）
 * 4. 连续齐整句长或感叹号过载（uniform_cadence / exclamation_overload）
 * 5. 违背 Stage 1 规划的两两官方称呼（address_mismatch，含姓氏误称）
 * 6. 用户明示诉求/官方钩子没有落地（prompt_coverage_gap）
 * 7. 长句说教墙与双人戏份失衡（monologue_overload / speaker_imbalance）
 * 8. 句首填充词模板化重复（repetitive_opener）
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

  // 1 & 2. 逐句检查套话与动作旁白泄露
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
    if (hasSpokenStageDirectionLeak(content)) {
      issues.push({
        lineId: line.id,
        code: 'stage_direction_leak',
        severity: 'high',
        message: '台词内夹带了动作/神态描写，请删除括号动作或第三人称叙述，只保留说出口的话'
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

  // 3. 结尾反说教总结（仅检查最后 2 句）
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

  // 4a. 连续齐整句长检查（连续 >= 5 句长度几乎一致且均 >= 10 字）
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

  // 4b. 感叹号过载检查（>= 6 句且含叹号句占比 > 28%）
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

  // 5. 两两称呼一致性检查（昵称偏离 + 姓氏/两字误称）
  const addresses = plan?.pairwiseAddress ?? []
  if (addresses.length > 0) {
    const cast = plan?.cast ?? []
    for (const rule of addresses) {
      const zh = rule.zh?.trim()
      const to = rule.to?.trim()
      const from = rule.from?.trim()
      if (!from || !to || !zh || zh === to) continue
      const member = cast.find((entry) => entry.name === to)
      const familyName = member ? member.fullName.replace(member.name, '').trim() : ''
      for (const line of lines) {
        if (line.speaker !== from) continue
        if (line.content.includes(zh)) continue
        if (line.content.includes(to)) {
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

  // 6. 用户诉求与官方钩子覆盖率
  const understanding = plan?.understanding
  if (understanding) {
    const castNames = (plan?.cast ?? []).flatMap((member) =>
      [member.name, member.fullName].filter(
        (value) => typeof value === 'string' && value.length >= 2
      )
    )
    issues.push(...promptCoverageIssues(dialogue, understanding, castNames))
  }

  // 7. 说教墙与双人戏份失衡
  issues.push(...distributionIssues(dialogue))

  // 8. 句首填充词模板化
  issues.push(...repetitiveOpenerIssues(dialogue))

  const flaggedLineIds = Array.from(new Set(issues.map((item) => item.lineId)))
  const hasHigh = issues.some((item) => item.severity === 'high')
  return {
    issues,
    flaggedLineIds,
    shouldPolish: hasHigh || issues.length >= 2
  }
}
