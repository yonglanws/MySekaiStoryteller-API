import { selectUnitFewShotExcerpts } from '../corpusExamples'
import type { DialogueLintIssue } from '../dialogueLinter'
import {
  GENERIC_PROFILE,
  dialoguePersonaPrompt,
  inferUnitFromText,
  normalizePjskTerminology
} from '../personas'
import { type CatalogView } from '../prompt'
import { normalizeDialogueLineBreaks } from '../validate'
import {
  castBlock,
  cleanText,
  displayWidth,
  entriesOf,
  formatCanonGroundingBrief,
  formatDialogueLineForPrompt,
  formatDirectingAnchorBlock,
  formatPairwiseAddressBlock,
  isRecord,
  lineBudget,
  mergePairwiseAddresses,
  num,
  packExcerptsCleanly,
  resolveMemberPersona,
  str,
  titleOrDefault,
  toBool,
  unwrapRecord
} from './helpers'
import type {
  DialoguePolishOptions,
  StagedCastMember,
  StagedCastPlan,
  StagedDialogue,
  StagedDialogueLine,
  StagedMessages,
  StagedPromptOptions
} from './types'

export function buildDialoguePrompt(
  view: CatalogView,
  plan: StagedCastPlan,
  options: StagedPromptOptions
): StagedMessages {
  const budget = lineBudget(options.targetMinutes)
  const dialogueContextText = [
    options.scene,
    plan.event,
    plan.logline,
    ...plan.outline,
    ...plan.cast.map((c) => c.role)
  ]
    .filter(Boolean)
    .join('\n')

  const castLines = plan.cast
    .map((member) => {
      const persona = resolveMemberPersona(options.personas, member, view, dialogueContextText)
      const prompt = dialoguePersonaPrompt(persona, 11000)
      return [
        `### ${member.name}（say: "${member.name}"）${member.role ? ` — ${member.role}` : ''}`,
        prompt ? prompt : `角色提示词：${GENERIC_PROFILE}`
      ].join('\n')
    })
    .join('\n\n')

  const scenesSummary =
    plan.scenes && plan.scenes.length > 0
      ? plan.scenes
          .map(
            (s) =>
              `- [${s.id}] ${s.summary || '（推进剧情）'}（在场：${s.activeCast.join('、') || '全员'}${
                s.isFlashback ? '，回忆片段' : ''
              }${s.isSekai ? '，SEKAI' : ''}）`
          )
          .join('\n')
      : ''

  const outline = plan.outline.length
    ? plan.outline.map((item, index) => `${index + 1}. ${item}`).join('\n')
    : '（围绕本场事件展开）'

  const hasRagVoice = (options.ragContext?.sections?.dialogueVoice?.length ?? 0) > 0
  const u = plan.understanding
  const craftAnchors = [
    u?.openingMotif
      ? `- 开场意象：前 1~4 句让「${u.openingMotif}」以具体动作/声音/触感自然出现。`
      : '',
    u?.turningPoint
      ? `- 中段转折：在「${u.turningPoint}」这一拍让语气或话题拐弯，前后留短反应。`
      : '',
    u?.closingCallback
      ? `- 收尾回扣：结尾 2~3 句用「${u.closingCallback}」轻巧呼应，不做总结陈词。`
      : '',
    (u?.characterGoals?.length ?? 0) > 0
      ? `- 表里动机：${(u?.characterGoals ?? [])
          .map((g) => `${g.cast || '角色'}（想：${g.wants || '—'} / 藏：${g.hides || '—'}）`)
          .join('；')}（隐瞒面只从停顿/改口/岔开话题漏出）。`
      : ''
  ]
    .filter(Boolean)
    .join('\n')

  const fewShotExcerpts = hasRagVoice ? '' : selectUnitFewShotExcerpts(plan.cast, options.scene)
  const groundingBrief = formatCanonGroundingBrief({
    scene: options.scene,
    plan,
    ragContext: options.ragContext,
    stage: 'dialogue',
    maxChars: 2200
  })
  const dialogueUnitHint = inferUnitFromText(dialogueContextText)
  const mergedAddresses = mergePairwiseAddresses(
    options.personas,
    plan.cast.map((c) => c.name),
    plan.pairwiseAddress,
    {
      ...(dialogueUnitHint ? { unitHint: dialogueUnitHint } : {}),
      ...(dialogueContextText ? { contextText: dialogueContextText } : {})
    }
  )
  const addressBlock = formatPairwiseAddressBlock({ ...plan, pairwiseAddress: mergedAddresses })
  const researchBriefBlock = options.researchBrief?.trim()
    ? `\n## 前置探索核实简报（记忆线索与官方事件锚点）\n${options.researchBrief.trim()}\n`
    : ''
  const hasWxs = plan.cast.some((c) =>
    /笑梦|宁宁|司|类|emu|nene|tsukasa|rui/i.test(`${c.name} ${c.path}`)
  )
  const termHint = hasWxs
    ? '\n- 术语固定：笑梦口号写 **Wonderhoy**，宁宁的机器人写 **宁宁号**。'
    : ''

  const a = plan.cast[0]
  const b = plan.cast[1] ?? plan.cast[0]
  const c = plan.cast[2]
  const example = {
    title: plan.title || '短标题',
    turns: [
      {
        scene: plan.scenes?.[0]?.id || 's1',
        speaker: a.name,
        lines: [
          '今天也……一起练吧。',
          '我把副歌重新编了一下，\n你听听看？',
          '（……其实昨晚改完后，一直有点没底。）'
        ]
      },
      ...(b && b.name !== a.name
        ? [
            {
              speaker: b.name,
              lines: [
                '诶，什么时候弄的？',
                '……我看看。',
                { content: '……先让我再听一遍。', closeWindowAfter: true }
              ]
            }
          ]
        : []),
      ...(c
        ? [
            {
              scene: plan.scenes?.[1]?.id || 's1',
              speaker: c.name,
              lines: [{ content: '……我刚到，你们已经在听新编曲了？', pauseBefore: 1.0 }]
            }
          ]
        : [])
    ]
  }

  const minLines = Math.max(10, Math.round(budget * 0.92))
  const maxLines = Math.max(14, Math.round(budget * 1.2))

  return {
    system: [
      '你是 Project SEKAI 视觉小说编剧。这是五阶段创作的第二轮：只写台词稿（禁止写动作/表情/镜头/旁白括号）。',
      '以「出场角色完整重写人设」作为第一真相源——角色的性格、重要记忆、关系边界、语言与风格、会说与绝不会说、称呼规范压倒一切通用猜测。只输出一个 JSON 对象。',
      options.systemPrompt?.trim() ?? ''
    ]
      .filter(Boolean)
      .join('\n'),
    user: `## 出场角色完整人设（第一真相源：语气、记忆、禁忌与称呼严格以此为准）
${castLines}
${addressBlock}
## 本场事件与分幕
事件：${plan.event || options.scene}${plan.logline ? ` | 梗概：${plan.logline}` : ''}${plan.background ? ` | 背景：${plan.background}` : ''}
出场：
${castBlock(plan)}
${scenesSummary ? `\n分幕：\n${scenesSummary}` : ''}
大纲：
${outline}
${researchBriefBlock}${groundingBrief}${
      fewShotExcerpts ? `\n## 官方对白节奏样例（只学断句停顿，严禁照抄）\n${fewShotExcerpts}\n` : ''
    }## 写作与格式规范（目标约 ${budget} 句，范围 ${minLines}~${maxLines} 句 / ${options.targetMinutes} 分钟）
- 中文输出，用 \`turns\`（\`speaker\` + \`lines\` 1~6 条，可带 \`scene\`/\`pauseBefore\` 1.0|1.5/\`closeWindowAfter\`）。
- 贴近官方连说节奏：1/3 单句短反应（>=${Math.max(4, Math.round(budget * 0.25))} 个），1/2 为 2~3 句自然连说，情绪最重处可用 5~6 条（最多 1 处）；平均 18~21 字，每行 <=30 字宽、最多 3 行。
- 内心独白用全角括号 \`（……）\`（全片 3~6 句 / 10%~16%）；**严禁** \`（微笑）\`/\`*叹气*\` 等动作描写或第三人称旁白。
- Show, Don't Tell：禁止心理咨询套话、AI 总结腔与结尾说教，允许抢话、欲言又止（……、——）与日常余韵收尾。${craftAnchors ? `\n${craftAnchors}` : ''}${termHint}

## 输出 JSON
${JSON.stringify(example, null, 2)}

只输出 JSON 对象本身。`
  }
}

function resolveDialogueSpeaker(plan: StagedCastPlan, value: unknown): StagedCastMember | null {
  const text = str(value).trim()
  if (!text) return null
  const lower = text.toLowerCase()
  return (
    plan.cast.find(
      (member) =>
        member.name.toLowerCase() === lower ||
        member.fullName.toLowerCase() === lower ||
        String(member.modelId) === text
    ) ?? null
  )
}

export function normalizeDialogue(
  raw: unknown,
  plan: StagedCastPlan,
  maxLines = 120,
  emotionLabels?: string[]
): StagedDialogue | null {
  const doc = unwrapRecord(raw, ['dialogue', 'story', 'plan'])
  if (!isRecord(doc)) return null
  const labels = (emotionLabels ?? []).map((label) => label.trim()).filter(Boolean)
  const lines: StagedDialogueLine[] = []

  const pushLine = (
    member: StagedCastMember,
    content: string,
    rawEmotion: unknown,
    meta: {
      sceneId?: unknown
      pauseBefore?: unknown
      closeWindowAfter?: unknown
      windowDisplayMode?: unknown
      effect?: unknown
    } = {}
  ): void => {
    const text = cleanText(content)
    if (!text) return
    const emotionValue = str(rawEmotion).trim()
    const emotion =
      labels.length > 0 ? (labels.includes(emotionValue) ? emotionValue : '') : emotionValue
    const pauseRaw = num(meta.pauseBefore, 0)
    const pauseBefore = pauseRaw >= 1.25 ? 1.5 : pauseRaw >= 0.75 ? 1.0 : pauseRaw >= 0.4 ? 0.5 : 0
    const sceneId = str(meta.sceneId).trim()
    const closeWindowAfter = toBool(meta.closeWindowAfter)
    const windowDisplayMode = str(meta.windowDisplayMode).trim()
    const rawEff = str(meta.effect).trim()
    const effect =
      rawEff === 'Normal' || rawEff === 'Internal' || rawEff === 'Overlap' ? rawEff : undefined
    lines.push({
      id: `l${lines.length + 1}`,
      speaker: member.name,
      content: text,
      ...(emotion ? { emotion } : {}),
      ...(sceneId ? { sceneId } : {}),
      ...(pauseBefore > 0 ? { pauseBefore } : {}),
      ...(closeWindowAfter ? { closeWindowAfter: true } : {}),
      ...(windowDisplayMode ? { windowDisplayMode } : {}),
      ...(effect ? { effect } : {})
    })
  }

  const turns = Array.isArray(doc.turns) ? doc.turns : []
  if (turns.length > 0) {
    for (const turn of turns) {
      if (!isRecord(turn)) continue
      const member = resolveDialogueSpeaker(
        plan,
        turn.speaker ?? turn.say ?? turn.cast ?? turn.name
      )
      if (!member) continue
      const turnEmotion = turn.emotion
      const turnScene = turn.scene ?? turn.sceneId
      const rawLines = Array.isArray(turn.lines) ? turn.lines : [turn]
      for (let i = 0; i < rawLines.length; i++) {
        const rawLine = rawLines[i]
        const content = isRecord(rawLine)
          ? (rawLine.content ?? rawLine.text ?? rawLine.line)
          : rawLine
        pushLine(
          member,
          str(content),
          isRecord(rawLine) ? (rawLine.emotion ?? turnEmotion) : turnEmotion,
          {
            sceneId: isRecord(rawLine)
              ? (rawLine.scene ?? rawLine.sceneId ?? turnScene)
              : turnScene,
            pauseBefore: isRecord(rawLine) ? rawLine.pauseBefore : i === 0 ? turn.pauseBefore : 0,
            closeWindowAfter: isRecord(rawLine)
              ? rawLine.closeWindowAfter
              : i === rawLines.length - 1
                ? turn.closeWindowAfter
                : false,
            windowDisplayMode: isRecord(rawLine)
              ? rawLine.windowDisplayMode
              : turn.windowDisplayMode,
            effect: isRecord(rawLine) ? rawLine.effect : turn.effect
          }
        )
      }
    }
  }

  if (lines.length === 0) {
    const body = entriesOf(doc.lines ?? doc.dialogue ?? doc.beats)
    for (const item of body) {
      if (!isRecord(item)) continue
      const member = resolveDialogueSpeaker(
        plan,
        item.speaker ?? item.say ?? item.cast ?? item.name
      )
      if (!member) continue
      pushLine(member, str(item.content ?? item.text ?? item.line), item.emotion, {
        sceneId: item.scene ?? item.sceneId,
        pauseBefore: item.pauseBefore,
        closeWindowAfter: item.closeWindowAfter,
        windowDisplayMode: item.windowDisplayMode,
        effect: item.effect
      })
    }
  }

  if (lines.length > maxLines) lines.length = maxLines
  if (lines.length < 2) return null
  return { title: titleOrDefault(doc.title, plan.title), lines }
}

export function buildDialogueRepairPrompt(
  view: CatalogView,
  plan: StagedCastPlan,
  options: StagedPromptOptions,
  previous: unknown
): StagedMessages {
  const base = buildDialoguePrompt(view, plan, options)
  const raw = typeof previous === 'string' ? previous : JSON.stringify(previous)
  return {
    system: base.system,
    user: `${base.user}\n\n## 上一轮的问题
上一轮没有给出至少 2 条可用的台词：必须用 turns 数组，每个 turn 同时有 speaker（上面列出的出场角色之一）
和 lines（1~6 条台词字符串）。
上一轮的输出开头如下：
${raw.slice(0, 4000)}

请按上面的角色提示词和格式重写完整台词稿，只输出 JSON 对象。`
  }
}

export function buildDialogueLengthPrompt(
  view: CatalogView,
  plan: StagedCastPlan,
  options: StagedPromptOptions,
  previous: unknown,
  actualLines: number,
  requiredLines: number,
  requiredChars = 0
): StagedMessages {
  const base = buildDialoguePrompt(view, plan, options)
  const raw = typeof previous === 'string' ? previous : JSON.stringify(previous)
  const budget = lineBudget(options.targetMinutes)
  const maxBudgetLines = Math.max(14, Math.round(budget * 1.2))
  const effectiveRequired = Math.min(requiredLines, Math.max(10, Math.round(budget * 1.05)))
  const upper = Math.min(
    maxBudgetLines,
    Math.max(effectiveRequired + 2, Math.round(effectiveRequired * 1.15))
  )
  const effectiveRequiredChars =
    requiredChars > 0 ? Math.min(requiredChars, Math.round(budget * 20)) : 0
  const actualChars = countDialogueChars(
    (() => {
      try {
        const parsed = typeof previous === 'string' ? JSON.parse(previous) : previous
        return parsed as StagedDialogue
      } catch {
        return { title: '', lines: [] }
      }
    })()
  )
  const charRule = effectiveRequiredChars
    ? `- 总字数控制在 ${effectiveRequiredChars}~${Math.round(budget * 24)} 字（上一轮约 ${actualChars} 字），平均每句 16~20 字；`
    : ''
  const actualMean = actualLines > 0 ? (actualChars / actualLines).toFixed(1) : '0'
  const longRule = effectiveRequiredChars
    ? `- 上一轮平均每句只有 ${actualMean} 字；这一轮把部分碎句充实到 15 字以上，2~6 字短反应占约 1/6 即可。`
    : ''
  const castNames = plan.cast.map((c) => c.name).join('、')
  const lengthProblemNote =
    actualLines >= effectiveRequired
      ? `上一轮已有 ${actualLines} 句台词（已达到约 ${budget} 句目标），但总字数略少（约 ${actualChars} 字）。请保持总句数严格在 ${Math.max(actualLines, effectiveRequired)}~${upper} 句以内，仅适度充实过于单薄的句子，**严禁为了凑字数增加多余独白或拉长超过 ${upper} 句**：`
      : `上一轮只写了 ${actualLines} 句台词${effectiveRequiredChars ? `、约 ${actualChars} 字` : ''}，\n少于要求的 ${effectiveRequired} 句${effectiveRequiredChars ? ` / ${effectiveRequiredChars} 字` : ''}。请保留原来的小事件和人物关系，\n重写一份完整台词稿：\n- 总句数严格控制在 ${effectiveRequired}~${upper} 句（目标约 ${budget} 句，禁止超预算注水），仍然用 turns 结构，每个 turn 1~6 条 lines；`
  return {
    system: base.system,
    user: `${base.user}\n\n## 上一轮的问题
${lengthProblemNote}
${charRule}
${longRule}
- 不要靠重复台词凑数；补足对话的来回、停顿、短反应和情绪铺垫；
- 出场角色仍限定在 ${castNames}，不要旁白和动作描写。
上一轮的输出开头如下：
${raw.slice(0, 4000)}

只输出 JSON 对象本身，不要 markdown 或解释。`
  }
}

export const countDialogueChars = (dialogue: StagedDialogue): number =>
  dialogue.lines.reduce((sum, line) => sum + Array.from(line.content.replace(/\s/g, '')).length, 0)

/**
 * 把同角色相邻的两条短句并回一条 Talk（不改写任何一个字）。
 */
export function condenseDialogue(dialogue: StagedDialogue, targetLines: number): StagedDialogue {
  const maxMerges = Math.max(
    0,
    Math.min(
      Math.max(1, Math.floor(dialogue.lines.length * 0.25)),
      dialogue.lines.length - Math.max(2, targetLines)
    )
  )
  if (maxMerges === 0) return dialogue

  const lines: StagedDialogueLine[] = []
  let merges = 0
  const endPunctuation = /[。！？!?…—、，,.\s～♪」』）)]$/
  for (let index = 0; index < dialogue.lines.length; index++) {
    const line = dialogue.lines[index]
    const next = dialogue.lines[index + 1]
    const length = (value: string): number => Array.from(value.replace(/\s/g, '')).length
    if (
      merges < maxMerges &&
      next &&
      line.speaker === next.speaker &&
      line.emotion === next.emotion &&
      line.sceneId === next.sceneId &&
      !line.closeWindowAfter &&
      !next.pauseBefore &&
      length(line.content) >= 7 &&
      length(next.content) >= 7 &&
      endPunctuation.test(line.content) &&
      displayWidth(line.content) + displayWidth(next.content) <= 44
    ) {
      lines.push({
        ...line,
        content: line.content + next.content,
        ...(next.closeWindowAfter ? { closeWindowAfter: true } : {})
      })
      merges += 1
      index += 1
      continue
    }
    lines.push(line)
  }
  return { ...dialogue, lines }
}

/** 给被点名或全部说话者提供完整语言风格/会说与绝不会说/称呼基线，确保润色与 Critic 贴合重写人设。 */
function formatSpeakerVoiceBlock(
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  flaggedIds: string[],
  options: DialoguePolishOptions,
  allSpeakers = false
): string {
  if (!options.personas || options.personas.length === 0) return ''
  const flagged = new Set(flaggedIds)
  const speakers = allSpeakers
    ? new Set(plan.cast.map((c) => c.name))
    : new Set(dialogue.lines.filter((line) => flagged.has(line.id)).map((line) => line.speaker))
  const contextText = `${options.scene ?? ''}\n${plan.event}\n${plan.logline}`
  const rows: string[] = []
  for (const name of speakers) {
    const member = plan.cast.find((entry) => entry.name === name)
    if (!member) continue
    const persona = resolveMemberPersona(options.personas, member, options.view, contextText)
    const prompt = dialoguePersonaPrompt(persona, 3200).trim()
    if (!prompt) continue
    rows.push(`### ${name}\n${prompt}`)
  }
  return rows.length > 0
    ? `## 说话者口吻基线（严格核对「语言与风格」「会说与绝不会说」「称呼」「核心禁忌」）\n${rows.join('\n\n')}\n\n`
    : ''
}

export function buildDialoguePolishPrompt(
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  issues: DialogueLintIssue[],
  options: DialoguePolishOptions = {}
): StagedMessages {
  const flaggedIds = Array.from(new Set(issues.map((i) => i.lineId)))
  const issueMap = new Map<string, string[]>()
  for (const issue of issues) {
    const list = issueMap.get(issue.lineId) ?? []
    list.push(issue.message)
    issueMap.set(issue.lineId, list)
  }

  const lineBlocks = flaggedIds
    .map((id) => {
      const idx = dialogue.lines.findIndex((l) => l.id === id)
      if (idx < 0) return ''
      const prev = idx > 0 ? dialogue.lines[idx - 1] : null
      const curr = dialogue.lines[idx]
      const next = idx + 1 < dialogue.lines.length ? dialogue.lines[idx + 1] : null
      const reasons = (issueMap.get(id) ?? []).join('；')
      return [
        `### 目标句 ${curr.id}（${curr.speaker}）`,
        prev ? `前一句（${prev.speaker}）：${formatDialogueLineForPrompt(prev.content)}` : '',
        `原句：${formatDialogueLineForPrompt(curr.content)}`,
        next ? `后一句（${next.speaker}）：${formatDialogueLineForPrompt(next.content)}` : '',
        `问题：${reasons}`
      ]
        .filter(Boolean)
        .join('\n')
    })
    .filter(Boolean)
    .join('\n\n')

  const polishContextText = [options.scene ?? '', plan.event, plan.logline]
    .filter(Boolean)
    .join('\n')
  const polishUnitHint = inferUnitFromText(polishContextText)
  const mergedAddresses = mergePairwiseAddresses(
    options.personas ?? [],
    plan.cast.map((c) => c.name),
    plan.pairwiseAddress,
    {
      ...(polishUnitHint ? { unitHint: polishUnitHint } : {}),
      ...(polishContextText ? { contextText: polishContextText } : {})
    }
  )
  const addressBlock = formatPairwiseAddressBlock({ ...plan, pairwiseAddress: mergedAddresses })
  const anchorBlock = formatDirectingAnchorBlock(plan)
  const userPrompt = packExcerptsCleanly([options.scene ?? ''], 900)
  const speakerVoiceBlock = formatSpeakerVoiceBlock(plan, dialogue, flaggedIds, options)
  const voiceSamples = packExcerptsCleanly(options.ragContext?.sections?.dialogueVoice ?? [], 900)
  const example = {
    replacements: flaggedIds.slice(0, 2).map((id) => ({
      id,
      content: '改写后的自然口语台词（不含动作旁白）'
    }))
  }

  return {
    system: [
      '你是 Project SEKAI 官方剧情的台词精修编辑（dialogue-polish）。',
      '只做外科手术式逐句改写：仅改写下方点名的问题句，保持原意、角色口吻与字数规模，不增删句子，不改说话人。只输出一个 JSON 对象。'
    ].join('\n'),
    user: `${anchorBlock}${addressBlock}${
      userPrompt ? `## 用户原始需求\n${userPrompt}\n\n` : ''
    }${speakerVoiceBlock}${
      voiceSamples
        ? `## 官方口吻参照（只学称呼、断句、停顿与潜台词，严禁照抄原句）\n${voiceSamples}\n\n`
        : ''
    }## 需要改写的问题句
${lineBlocks}

## 改写要求
- 仅输出 \`replacements\` 数组，每项含 \`id\` 与改写后的 \`content\`。
- 去掉 AI 心理咨询套话、动作旁白与说教总结，改用具体细节、停顿（……、——）或侧面回应表达。
- 保持该说话者的语感（口头禅、句尾习惯、称呼方式）；不要把所有人都改成同一种温和口吻。
- 若问题写着「用户明确要求」或「官方钩子」，就把缺失的人/物/事自然带进这一句（用具体名词，不要另起一段解释）。
- 若问题是结尾说教，就用开场意象或日常小约定轻巧回扣，不作总结陈词。
- 严格遵守称呼表，每行不超过 30 字宽，最多 3 行。
- 多行台词的换行统一使用 \`\\n\`，严禁用 \`/\` 或 \` / \` 表示换行。

## 输出 JSON
${JSON.stringify(example, null, 2)}

只输出 JSON 对象本身，不要 markdown 或解释。`
  }
}

/**
 * Stage 2.5 人设 Critic 精修提示词（供 hybrid / 增强润色阶段核查台词是否背离重写人设）：
 * 逐句对照角色「语言与风格」「会说与绝不会说」「称呼规范」与剧情潜台词深度，仅对明显偏离人设/偏平淡的句子做外科微调。
 */
export function buildPersonaCriticPrompt(
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  options: DialoguePolishOptions = {},
  issues: DialogueLintIssue[] = []
): StagedMessages {
  const polishContextText = [options.scene ?? '', plan.event, plan.logline]
    .filter(Boolean)
    .join('\n')
  const polishUnitHint = inferUnitFromText(polishContextText)
  const mergedAddresses = mergePairwiseAddresses(
    options.personas ?? [],
    plan.cast.map((c) => c.name),
    plan.pairwiseAddress,
    {
      ...(polishUnitHint ? { unitHint: polishUnitHint } : {}),
      ...(polishContextText ? { contextText: polishContextText } : {})
    }
  )
  const addressBlock = formatPairwiseAddressBlock({ ...plan, pairwiseAddress: mergedAddresses })
  const anchorBlock = formatDirectingAnchorBlock(plan)
  const speakerVoiceBlock = formatSpeakerVoiceBlock(plan, dialogue, [], options, true)
  const issueNote =
    issues.length > 0
      ? `\n## 规则 Linter 已发现问题（必须一并修复）\n${issues
          .map((i) => `- [${i.lineId}] (${i.code}) ${i.message}`)
          .join('\n')}\n`
      : ''
  const linesBlock = dialogue.lines
    .map((line) => `- ${line.id} ${line.speaker}：${formatDialogueLineForPrompt(line.content)}`)
    .join('\n')

  return {
    system: [
      '你是 Project SEKAI 重写人设审校 Critic（dialogue-persona-critic）。',
      '你的任务是逐句对照每个角色的真实重写人设（「语言与风格」「会说与绝不会说」「人际称呼」「心理模型」），找出仍然像通用 AI、OOC、称呼写错、或潜台词太直白浅薄的台词，给出精准外科替换；已经贴合人设的句子不要改动。',
      '只输出 JSON 对象：{"critique":"简评","replacements":[{"id":"l3","content":"..."}]}；若全篇都已足够贴合人设，replacements 输出空数组 []。'
    ].join('\n'),
    user: `${anchorBlock}${addressBlock}${speakerVoiceBlock}${issueNote}## 待审校台词稿（共 ${dialogue.lines.length} 句）
${linesBlock}

## 审校清单
1. 核对每句用词是否符合该角色的「语言与风格」「会说与绝不会说」（如奏禁用～/♪、真冬低平破碎留白、瑞希表面轻快暗藏闪避、优男/优等生面具边界）。
2. 核对称呼是否严格符合「角色两两称呼表」，不得把姓氏/网名/正式称呼混用。
3. 将直白说教或平淡应付的台词改写为更有潜台词、动作留白或真实记忆呼应的对白（禁止夹带括号动作描写；每行 <=30 字宽、最多 3 行）。
4. 多行台词的换行统一使用 \`\\n\`，严禁用 \`/\` 或 \` / \` 表示换行。

只输出 JSON 对象：{"critique":"...","replacements":[...]}`
  }
}

export function applyDialoguePolish(
  dialogue: StagedDialogue,
  raw: unknown,
  allowedIds: Set<string>
): StagedDialogue {
  const doc = isRecord(raw) ? raw : {}
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(doc.replacements)
      ? doc.replacements
      : Array.isArray(doc.lines)
        ? doc.lines
        : []

  const replacementMap = new Map<string, string>()
  for (const item of list) {
    if (!isRecord(item)) continue
    const id = str(item.id ?? item.lineId).trim()
    if (!id || !allowedIds.has(id)) continue
    const content = normalizePjskTerminology(
      normalizeDialogueLineBreaks(str(item.content ?? item.text ?? item.line)).trim()
    )
    if (!content) continue
    replacementMap.set(id, content)
  }
  if (replacementMap.size === 0) return dialogue

  return {
    ...dialogue,
    lines: dialogue.lines.map((line) => {
      const updated = replacementMap.get(line.id)
      return updated ? { ...line, content: updated } : line
    })
  }
}

export function softenPunctuation(dialogue: StagedDialogue, targetShare = 0.55): StagedDialogue {
  const total = dialogue.lines.length
  if (total === 0) return dialogue
  const hasEllipsis = (text: string): boolean => /…|\.\.\./.test(text)
  const current = dialogue.lines.filter((line) => hasEllipsis(line.content)).length
  const need = Math.ceil(total * targetShare) - current
  if (need <= 0) return dialogue

  const candidates = dialogue.lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => {
      const text = line.content.trim()
      if (!text.endsWith('。')) return false
      if (/[！？!?]/.test(text)) return false
      return Array.from(text).length >= 8
    })
  if (candidates.length === 0) return dialogue

  const chosen = new Set<number>()
  const step = Math.max(1, Math.floor(candidates.length / need))
  for (let index = 0; index < candidates.length && chosen.size < need; index += step) {
    chosen.add(candidates[index].index)
  }
  if (chosen.size === 0) return dialogue
  return {
    ...dialogue,
    lines: dialogue.lines.map((line, index) =>
      chosen.has(index) ? { ...line, content: line.content.replace(/。$/, '……') } : line
    )
  }
}
