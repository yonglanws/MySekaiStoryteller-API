import type { StagedCastPlan, StagedDialogue } from './staged'

export type DialogueLintCode =
  | 'therapy_cliche'
  | 'stage_direction_leak'
  | 'moralizing_ending'
  | 'uniform_cadence'
  | 'exclamation_overload'
  | 'address_mismatch'

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

const THERAPY_CLICHE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /其实我一直想说/, label: '心理咨询式直白剖白「其实我一直想说」' },
  { re: /谢谢你总是这么温柔/, label: '套路化感谢「谢谢你总是这么温柔」' },
  { re: /不管发生什么.{0,12}都在一起/, label: '套路誓言「不管发生什么……都在一起」' },
  { re: /今天的经历让我明白/, label: '说教式总结「今天的经历让我明白」' },
  { re: /我终于明白了/, label: '直白自我解释「我终于明白了」' },
  { re: /真正的意义/, label: '抽象说教词「真正的意义」' },
  { re: /内心深处/, label: '书面抒情套话「内心深处」' },
  { re: /温柔地包容/, label: 'AI 治愈套话「温柔地包容」' },
  { re: /敞开心扉|不再迷茫|共同成长/, label: 'AI 心理成长套话' }
]

const STAGE_DIRECTION_LEAK_PATTERNS: RegExp[] = [
  /[（(](?:轻笑|笑|微笑|苦笑|叹气|轻叹|沉默|点头|摇头|低头|抬头|脸红|撇嘴|转身|挥手|顿了顿)[）)]/,
  /(?:^|[，。！？\s])(?:她|他)(?:转过头|低下头|笑了笑|叹了口气|轻声说道|小声嘀咕|沉默了片刻)/
]

const MORALIZING_ENDING_PATTERNS: RegExp[] = [
  /只要.{0,10}(?:大家|我们|你).{0,8}在一起/,
  /一定会(?:越来越好|变得更好|没问题的)/,
  /今天真是.{0,8}(?:难忘|美好|充实|有意义)的一天/,
  /无论未来.{0,12}都会/,
  /这就是.{0,8}的意义/
]

function visibleLength(text: string): number {
  return Array.from(text.replace(/[\s\n]/g, '')).length
}

/**
 * 零延迟、确定性官方质感反套路对白 Linter。
 *
 * 检查 5 类高频 AI 写作痕迹：
 * 1. 心理咨询式直白剖白与套话（therapy_cliche）
 * 2. 夹带动作/神态旁白泄露（stage_direction_leak）
 * 3. 结尾最后两句升华说教总结（moralizing_ending）
 * 4. 连续齐整句长或感叹号过载（uniform_cadence / exclamation_overload）
 * 5. 违背 Stage 1 规划的两两官方称呼（address_mismatch）
 */
export function lintDialogueFidelity(
  dialogue: StagedDialogue,
  plan?: Pick<StagedCastPlan, 'pairwiseAddress'>
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
    if (STAGE_DIRECTION_LEAK_PATTERNS.some((re) => re.test(content))) {
      issues.push({
        lineId: line.id,
        code: 'stage_direction_leak',
        severity: 'high',
        message: '台词内夹带了动作/神态描写，请删除括号动作或第三人称叙述，只保留说出口的话'
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

  // 5. 两两称呼一致性检查（仅当指定了区别于原名的昵称/称呼时）
  const addresses = plan?.pairwiseAddress ?? []
  if (addresses.length > 0) {
    for (const rule of addresses) {
      const zh = rule.zh?.trim()
      const to = rule.to?.trim()
      const from = rule.from?.trim()
      if (!from || !to || !zh || zh === to) continue
      for (const line of lines) {
        if (line.speaker !== from) continue
        if (line.content.includes(to) && !line.content.includes(zh)) {
          issues.push({
            lineId: line.id,
            code: 'address_mismatch',
            severity: 'high',
            message: `${from} 对 ${to} 的约定称呼为「${zh}」，句中误用了「${to}」`
          })
        }
      }
    }
  }

  const flaggedLineIds = Array.from(new Set(issues.map((item) => item.lineId)))
  const hasHigh = issues.some((item) => item.severity === 'high')
  return {
    issues,
    flaggedLineIds,
    shouldPolish: hasHigh || issues.length >= 2
  }
}
