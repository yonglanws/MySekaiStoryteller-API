import { sanitizeIrodoriCaption } from '../../../common/tts/irodori'
import { isGenuineCalmResolution } from '../officialLinter'
import { actingPersonaPrompt } from '../personas'
import {
  formatDialogueLineForPrompt,
  formatDirectingAnchorBlock,
  isRecord,
  resolveMemberPersona,
  str
} from './helpers'
import type {
  StagedCastPlan,
  StagedDialogue,
  StagedDialogueLine,
  StagedMessages,
  StagedPromptOptions,
  StagedVoiceDirectionLine
} from './types'

const VOICE_NORMAL_SPEED_MIN = 0.92

const VOICE_NORMAL_SPEED_MAX = 1.08

const VOICE_SPECIAL_SPEED_MIN = 0.85

const VOICE_SPECIAL_SPEED_MAX = 1.18

const VOICE_SPECIAL_SCENE_MAX_RATIO = 0.15

const clampVoiceSpeed = (value: number, special: boolean): number =>
  Math.min(
    special ? VOICE_SPECIAL_SPEED_MAX : VOICE_NORMAL_SPEED_MAX,
    Math.max(special ? VOICE_SPECIAL_SPEED_MIN : VOICE_NORMAL_SPEED_MIN, value)
  )

export function buildEmotionPrompt(
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  options: StagedPromptOptions
): StagedMessages {
  const labels = (options.emotionLabels ?? []).map((label) => label.trim()).filter(Boolean)
  const defaultEmotion = labels.includes('平静') ? '平静' : (labels[0] ?? '平静')
  const strongLabels = labels.filter((label) => label !== defaultEmotion)
  const lineLines = dialogue.lines
    .map((line) => `- ${line.id} ${line.speaker}：${formatDialogueLineForPrompt(line.content)}`)
    .join('\n')

  const cast = plan.cast
    .map((member) => {
      const persona = resolveMemberPersona(
        options.personas,
        member,
        undefined,
        `${options.scene}\n${plan.event}`
      )
      const acting = actingPersonaPrompt(persona, 1600)
      return acting
        ? `- ${member.name}（${member.role || '出场角色'}）：\n${acting}`
        : `- ${member.name}：${member.role || '出场角色'}`
    })
    .join('\n')

  const firstId = dialogue.lines[0]?.id ?? 'l1'
  const secondId = dialogue.lines[1]?.id ?? firstId
  const lastId = dialogue.lines[dialogue.lines.length - 1]?.id ?? firstId
  const maxSpecialCount = Math.floor(dialogue.lines.length * VOICE_SPECIAL_SCENE_MAX_RATIO)

  const example = {
    lines: [
      {
        id: firstId,
        emotion: defaultEmotion,
        ttsCaption: '少し落ち着かない様子で、柔らかい口調ながら控えめに話している。',
        ttsSpeed: 0.98,
        ttsSpecialScene: false
      },
      ...(secondId !== firstId
        ? [
            {
              id: secondId,
              emotion: strongLabels[0] ?? defaultEmotion,
              ttsCaption: '少し照れながら、早口で慌てたように話している。',
              ttsSpeed: 1.05,
              ttsSpecialScene: false
            }
          ]
        : []),
      ...(dialogue.lines.length >= 7
        ? [
            {
              id: lastId,
              emotion: strongLabels[1] ?? strongLabels[0] ?? defaultEmotion,
              ttsCaption: '声を震わせながら、今にも泣き出しそうな切実なトーンで訴えかける。',
              ttsSpeed: 0.9,
              ttsSpecialScene: true
            }
          ]
        : [])
    ]
  }

  return {
    system: [
      '你是 Project SEKAI 官方剧情的配音导演兼情绪标注员（Voice Director），负责为 IrodoriTTS 生成逐句情绪标签与日语表演韵律指令。',
      '台词已经定稿，你必须为每一句台词输出 { id, emotion, ttsCaption, ttsSpeed, ttsSpecialScene }。',
      '核心原则（双层音色保护）：',
      '1. 普通台词保持角色基础参考音频锁定，靠精细的日语 ttsCaption（语气、呼吸、语速、停顿、情感张力）与轻微语速变化表达细腻表演，绝不改变角色音色底色。',
      '2. ttsCaption 必须严格只写表演与韵律（2~4 个简短日语短语），严禁出现任何年龄/性别/基础声线词（如「若い女性」「少女」「少年」「低い声」「高い声」「幼い声」「アニメ声」「ロリ」等），否则会与角色 LoRA/参考音频冲突。',
      '3. 严禁把真正的情绪爆发、哭腔、喊叫、脆弱道歉或震惊错标为「平静」；哭泣/悲伤对峙途中即便出现安抚（「没关系的」）、克制解释或绝望叹息（「可窗户纸一旦破了，我就再也没办法安心笑出来了」），也必须全段持续保持「伤心」，绝不中途掉回「平静」；只有到真正释怀和解或夕阳余韵收尾时，才允许自然过渡到舒缓的「平静」或「开心」。',
      '4. ttsSpecialScene 仅用于全片真正的高潮爆发/哭喊/哽咽/耳语/回忆转折（占比严格 <= 15%）。只输出一个 JSON 对象。',
      options.systemPrompt?.trim() ?? ''
    ]
      .filter(Boolean)
      .join('\n'),
    user: `## 这一场
小事件：${plan.event || options.scene}
${plan.logline ? `一句话：${plan.logline}` : ''}
${formatDirectingAnchorBlock(plan)}
角色：
${cast}

## 台词稿（共 ${dialogue.lines.length} 句，请逐句给出语音导演指令）
${lineLines}

## 粗情绪标签（emotion 字段只能从中选）
${labels.length > 0 ? labels.join('、') : '平静、开心、生气、伤心、害羞、惊讶'}

## 逐句语音导演规则
- **覆盖全部台词**：从 ${firstId} 到 ${lastId} 每一句都给出一项，不要漏句。
- **emotion（粗情绪族）**：
  - 平静：仅用于日常寒暄、温和叙述、冷静思考。**绝不要**把喊人（「瑞希っ！」）、含泪道歉（「对不起」「ごめんね」）、哽咽（「可是……可是……！」）或激动呐喊错标为「平静」。
  - 开心：轻松玩笑、被逗笑、温柔鼓励、豁然开朗或愉悦收尾（如带「～♪」、互相打趣、和好约定）。
  - 排练入戏后的调侃打趣切换：前面哪怕刚刚在排练悲情戏码或感慨（「『别难过……』」），只要紧接着有人笑着打趣、调侃或温和夸赞（「呵呵呵，很有远行的气势嘛，司。」「哈哈哈」「不错嘛」且无真正哭诉/痛苦词），**立刻切回「开心」或「平静」**，绝不把排练的「伤心」惯性拖到调侃句上。
  - 伤心：失落、脆弱倾诉、愧疚、哽咽、含泪恳求，以及哭戏途中强忍泪水安慰对方（「没关系的」）、无奈解释（「大家都太温柔了」）或绝望吐露——**哭戏未真正释怀和解前全段保持「伤心」，严禁中途掉回「平静」**。
  - 结尾呼吸感与余韵过渡：当冲突在结尾真正走向释怀、夕阳缓和或安静接纳时（如「夕阳沉下去了」「再等我一会儿」），允许结尾数句自然过渡到柔和释放的「平静」或「开心」（搭配安堵/温柔的 ttsCaption），让情绪弧光有呼吸落点，不要把整场几十句锁死在单一哭腔。
  - 生气：争执、嘴硬反驳、委屈发火、情绪激动地质问或焦急大喊；**严禁因前文在打趣就把突然认真/反驳/斥责的急停句（如「别岔开话题！」「别开玩笑了！」「够了！」）惯性标成「开心」，必须立刻切回「生气」或「平静」**。
  - 害羞：被夸、慌张掩饰、不好意思。
  - 惊讶：突然的揭示、意外、倒吸一口气或惊呼。
  - 同一情绪拍内保持粗标签连贯，避免无意义的逐句 A/B 抖动或哭戏途中掉回「平静」；遇到真正的情感转折、哭诉、结尾释怀或欢快收尾时忠实切换。
- **ttsCaption（日语表演/韵律描述，必填）**：
  - 用 2~4 个自然日语短语描述**语气、呼吸感、语速、停顿、强弱与情绪层次**（例如：「安堵して、柔らかく温かい口調でゆっくり話している。」「息を切らしながら、切羽詰まった様子で必死に呼びかける。」）。
  - **严禁描述说话人的年龄、性别或基础音色**（禁止出现 若い女性/大人の女性/少女/少年/男の子/女の子/低い声/高い声/幼い声/アニメ声 等词）。
- **ttsSpeed（可选语速微调）**：
  - 普通句（ttsSpecialScene=false）：范围 **0.92 ~ 1.08**（犹豫/温柔/沉重略慢 0.92~0.97，轻快/慌张/急促略快 1.03~1.08）。
  - 特殊高潮句（ttsSpecialScene=true）：范围 **0.85 ~ 1.18**。
- **ttsSpecialScene（布尔值，默认 false）**：
  - 仅在真正极端高潮（痛哭/哽咽崩溃、撕裂喊叫、极近距离耳语、关键回忆爆发）时设为 true。
  - 整场最多允许 **${maxSpecialCount}** 句设为 true（严格 <= 15%）。
- **对齐 Stage 1 转折点**：语速最慢、气息最不稳、\`ttsSpecialScene=true\` 的句子优先落在中段转折点附近；开场意象句与收尾回扣句保持克制（普通语速、平静或轻微情绪），不要提前把情绪拉满。

## 输出 JSON
${JSON.stringify(example, null, 2)}

只输出 JSON 对象本身，不要 markdown 或解释。`
  }
}

const emotionIndex = (value: unknown, lines: StagedDialogueLine[]): number => {
  const text = str(value).trim()
  if (!text) return -1
  const idMatch = /^l?(\d+)$/i.exec(text)
  if (idMatch) return Number(idMatch[1]) - 1
  return lines.findIndex((line) => line.id === text)
}

function specialScenePriority(line: StagedDialogueLine, entry: StagedVoiceDirectionLine): number {
  let score = 0
  if (entry.emotion && entry.emotion !== '平静') score += 2
  if (entry.emotion === '伤心' || entry.emotion === '生气') score += 2
  if (/！！|!!|？！|\?!/.test(line.content)) score += 3
  if (/对不起|别.*推开|不要.*走|求你|眼泪|哭|ごめん|ダメ|やめて/.test(line.content)) score += 3
  const caption = entry.ttsCaption ?? ''
  if (/泣|嗚咽|叫|囁|震え|切実|必死|崩|絶叫|息を切ら/.test(caption)) score += 3
  return score
}

/**
 * 解析并规范化 Stage 2.5 语音导演输出。
 * 同时兼容新版逐句格式（`lines: [{ id, emotion, ttsCaption, ttsSpeed, ttsSpecialScene }]`）
 * 与旧版分段格式（`segments: [{ from, to, emotion }]`）。
 * 确定性执行：caption 清洗、语速钳制、`ttsSpecialScene <= 15%` 上限。
 */
export function normalizeVoiceDirectionPlan(
  raw: unknown,
  dialogue: StagedDialogue,
  labels: string[]
): Map<string, StagedVoiceDirectionLine> | null {
  const allowed = new Set(labels.map((label) => label.trim()).filter(Boolean))
  const doc = isRecord(raw) ? raw : {}
  const itemsRaw = Array.isArray(raw)
    ? raw
    : Array.isArray(doc.lines)
      ? doc.lines
      : Array.isArray(doc.voiceDirection)
        ? doc.voiceDirection
        : Array.isArray(doc.segments)
          ? doc.segments
          : Array.isArray(doc.emotions)
            ? doc.emotions
            : []

  const result = new Map<string, StagedVoiceDirectionLine>()
  const putEntry = (
    line: StagedDialogueLine,
    item: Record<string, unknown>,
    emotion: string
  ): void => {
    const rawCaption = str(item.ttsCaption ?? item.caption ?? item.delivery).trim()
    const ttsCaption = sanitizeIrodoriCaption(rawCaption) || undefined
    const rawSpecialScene =
      typeof item.ttsSpecialScene === 'boolean'
        ? item.ttsSpecialScene
        : typeof item.specialScene === 'boolean'
          ? item.specialScene
          : false
    const calmWithoutIntensityCue =
      emotion === '平静' &&
      !/[！!]{2}|泣|叫|呜|耳语|ささや|嗚咽/.test(line.content) &&
      !/耳語|ささや|泣|叫|嗚咽|震え/.test(ttsCaption ?? '')
    const ttsSpecialScene = rawSpecialScene && !calmWithoutIntensityCue
    const rawSpeed = item.ttsSpeed ?? item.speed
    const parsedSpeed =
      typeof rawSpeed === 'number' && Number.isFinite(rawSpeed)
        ? rawSpeed
        : typeof rawSpeed === 'string' && rawSpeed.trim() && Number.isFinite(Number(rawSpeed))
          ? Number(rawSpeed)
          : undefined
    const clampedSpeed =
      parsedSpeed !== undefined
        ? clampVoiceSpeed(
            emotion === '平静' ? Math.min(1.05, Math.max(0.95, parsedSpeed)) : parsedSpeed,
            ttsSpecialScene
          )
        : undefined
    const ttsSpeed = clampedSpeed !== undefined ? Number(clampedSpeed.toFixed(2)) : undefined

    result.set(line.id, {
      emotion,
      ...(ttsCaption ? { ttsCaption } : {}),
      ...(ttsSpeed !== undefined ? { ttsSpeed } : {}),
      ...(ttsSpecialScene ? { ttsSpecialScene: true } : {})
    })
  }

  for (const item of itemsRaw) {
    if (typeof item === 'string') continue
    if (!isRecord(item)) continue
    const rawEmotion = str(item.emotion ?? item.label ?? item.tone).trim()
    const validEmotion = allowed.size === 0 ? rawEmotion : allowed.has(rawEmotion) ? rawEmotion : ''
    const hasRichFields = Boolean(str(item.ttsCaption ?? item.caption ?? item.delivery).trim())
    if (!validEmotion && !hasRichFields) continue

    if (item.from !== undefined || item.to !== undefined) {
      const from = emotionIndex(item.from, dialogue.lines)
      const to = emotionIndex(item.to, dialogue.lines)
      if (from < 0 || to < 0 || to < from) continue
      for (let index = from; index <= Math.min(to, dialogue.lines.length - 1); index++) {
        putEntry(dialogue.lines[index], item, validEmotion)
      }
      continue
    }
    const id = str(item.id ?? item.lineId ?? item.line).trim()
    const index = emotionIndex(id, dialogue.lines)
    if (index >= 0) {
      putEntry(dialogue.lines[index], item, validEmotion)
    }
  }

  if (result.size < Math.ceil(dialogue.lines.length * 0.6)) return null

  // 确定性限制 ttsSpecialScene 比例 <= 15%
  const maxSpecial = Math.floor(dialogue.lines.length * VOICE_SPECIAL_SCENE_MAX_RATIO)
  const specialCandidates: Array<{ id: string; priority: number; index: number }> = []
  dialogue.lines.forEach((line, index) => {
    const entry = result.get(line.id)
    if (entry?.ttsSpecialScene) {
      specialCandidates.push({ id: line.id, priority: specialScenePriority(line, entry), index })
    }
  })
  if (specialCandidates.length > maxSpecial) {
    specialCandidates.sort((a, b) => b.priority - a.priority || a.index - b.index)
    const keepIds = new Set(specialCandidates.slice(0, maxSpecial).map((c) => c.id))
    for (const candidate of specialCandidates) {
      if (keepIds.has(candidate.id)) continue
      const entry = result.get(candidate.id)
      if (!entry) continue
      delete entry.ttsSpecialScene
      if (entry.ttsSpeed !== undefined) {
        entry.ttsSpeed = Number(clampVoiceSpeed(entry.ttsSpeed, false).toFixed(2))
      }
    }
  }

  return result
}

export function normalizeEmotionPlan(
  raw: unknown,
  dialogue: StagedDialogue,
  labels: string[]
): Map<string, string> | null {
  if (labels.map((label) => label.trim()).filter(Boolean).length === 0) return null
  const voicePlan = normalizeVoiceDirectionPlan(raw, dialogue, labels)
  if (!voicePlan) return null
  const result = new Map<string, string>()
  for (const [id, entry] of voicePlan) {
    if (entry.emotion) result.set(id, entry.emotion)
  }
  if (result.size < Math.ceil(dialogue.lines.length * 0.6)) return null
  return result
}

export function countEmotionRuns(
  plan: Map<string, string> | Map<string, StagedVoiceDirectionLine>,
  dialogue: StagedDialogue
): number {
  let runs = 0
  let previous = ''
  for (const line of dialogue.lines) {
    const value = plan.get(line.id)
    const emotion = typeof value === 'string' ? value : (value?.emotion ?? '')
    if (emotion && emotion !== previous) {
      runs += 1
      previous = emotion
    }
  }
  return runs
}

export function buildEmotionRepairPrompt(
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  options: StagedPromptOptions,
  previous: unknown,
  actualSegments: number
): StagedMessages {
  const base = buildEmotionPrompt(plan, dialogue, options)
  const raw = typeof previous === 'string' ? previous : JSON.stringify(previous)
  return {
    system: base.system,
    user: `${base.user}\n\n## 上一轮的问题
上一轮整场只给了 ${actualSegments} 个单一情绪标签，长剧本完全没有情绪推进。请按剧情起承转合给出逐句语音导演指令（emotion 体现自然的情绪起承转合，保留关键转折、哭诉或欢快收尾，同时每句都提供贴合的日语 ttsCaption），并从 ${dialogue.lines[0]?.id ?? 'l1'} 连续覆盖到 ${dialogue.lines[dialogue.lines.length - 1]?.id ?? 'l1'}。
上一轮的输出开头如下：
${raw.slice(0, 3000)}

只输出 JSON 对象本身，不要 markdown 或解释。`
  }
}

const isEmotionPivotCue = (text: string, emotion: string): boolean => {
  if (emotion === '开心') {
    return (
      /♪|～♪|哈哈|呵呵|嘿嘿|嘻嘻|太好了|よかった|气势嘛|不错嘛|厉害嘛/.test(text) &&
      !/对不起|ごめん|难过|伤心|痛苦|……/.test(text)
    )
  }
  if (emotion === '伤心') return /对不起|ごめん|别.*推开|不要.*走|求你|眼泪|哭|ダメ|呜/.test(text)
  if (emotion === '生气') {
    return /！！|!!|住口|够了|闭嘴|混蛋|别岔开话题|别转移话题|别开玩笑|别敷衍|别装|少啰嗦|别闹了|やめろ|ふざけ/.test(
      text
    )
  }
  if (emotion === '平静') {
    return /别岔开话题|别转移话题|别开玩笑|别敷衍|我是认真的|认真一点|冷静/.test(text)
  }
  if (emotion === '惊讶') return /？！|\?!|什么！？|怎么会|竟然|っ！|……！/.test(text)
  return false
}

export function stabilizeEmotions(
  dialogue: StagedDialogue,
  plan: Map<string, string> | null,
  labels: string[]
): Map<string, string> {
  const allowed = labels.map((label) => label.trim()).filter(Boolean)
  const fallback = allowed.includes('平静') ? '平静' : (allowed[0] ?? '')
  const lines = dialogue.lines
  if (lines.length === 0) return new Map()

  const rawValues = lines.map((line) => {
    const value = plan?.get(line.id)?.trim() ?? ''
    return allowed.includes(value) ? value : ''
  })

  // 1) 未知/缺失标签优先继承相邻句有效情绪，避免突然插入孤立的 fallback 断层
  const values = [...rawValues]
  for (let i = 0; i < values.length; i++) {
    if (values[i]) continue
    const prev = i > 0 ? values[i - 1] : ''
    let next = ''
    for (let j = i + 1; j < rawValues.length; j++) {
      if (rawValues[j]) {
        next = rawValues[j]
        break
      }
    }
    values[i] = prev || next || fallback
  }

  // 2) 仅平滑夹在同情绪中间的孤立单句毛刺（A - B - A），保留 >=2 句高潮/尾声及明确强转折句
  for (let i = 1; i < values.length - 1; i++) {
    const prev = values[i - 1]
    const curr = values[i]
    const next = values[i + 1]
    if (curr !== prev && prev === next && !isEmotionPivotCue(lines[i].content, curr)) {
      values[i] = prev
    }
  }

  // 3) 同一说话人的孤立单句跳变（前一句与下一句为同一情绪，中间仅夹一句全局长度为 1 的毛刺）平滑回一致
  const previousBySpeaker = new Map<string, number>()
  for (let i = 0; i < lines.length; i++) {
    const speaker = lines[i].speaker
    const prevIdx = previousBySpeaker.get(speaker)
    const isGlobalSingleton =
      (i === 0 || values[i - 1] !== values[i]) &&
      (i === lines.length - 1 || values[i + 1] !== values[i])
    if (
      prevIdx !== undefined &&
      isGlobalSingleton &&
      !isEmotionPivotCue(lines[i].content, values[i])
    ) {
      const prevEmotion = values[prevIdx]
      let nextSame = -1
      for (let scan = i + 1; scan < lines.length; scan++) {
        if (lines[scan].speaker === speaker) {
          nextSame = scan
          break
        }
      }
      if (prevEmotion !== values[i] && nextSame !== -1 && values[nextSame] === prevEmotion) {
        values[i] = prevEmotion
      }
    }
    previousBySpeaker.set(speaker, i)
  }

  // 4) 若仍出现连续 3 个以上长度为 1 的高频锯齿段（A - B - C - D），温和并掉无强标记的中间单句毛刺
  for (let i = 1; i < values.length - 1; i++) {
    const prevSame = values[i - 1] === values[i]
    const nextSame = values[i + 1] === values[i]
    if (prevSame || nextSame) continue
    const prevIsSingleton = i - 2 < 0 || values[i - 2] !== values[i - 1]
    const nextIsSingleton = i + 2 >= values.length || values[i + 2] !== values[i + 1]
    if (prevIsSingleton && nextIsSingleton && !isEmotionPivotCue(lines[i].content, values[i])) {
      values[i] = values[i - 1]
    }
  }

  // 5) 防止哭戏/悲伤或争执途中短段（1~4句）意外掉回「平静」：前后同处于「伤心」/「生气」弧光且无真正释怀/欢快收尾时保持情绪连贯
  const isDenseTenseEmotion = (emo: string): boolean => emo === '伤心' || emo === '生气'
  for (let start = 1; start < lines.length - 1; start++) {
    if (values[start] !== '平静') continue
    let end = start
    while (end + 1 < lines.length - 1 && values[end + 1] === '平静') {
      end += 1
    }
    const spanLen = end - start + 1
    if (spanLen <= 4) {
      const spanScene = lines[start].sceneId
      let leftTense = ''
      for (let l = start - 1; l >= Math.max(0, start - 3); l--) {
        if (spanScene && lines[l].sceneId && lines[l].sceneId !== spanScene) break
        if (isDenseTenseEmotion(values[l])) {
          leftTense = values[l]
          break
        }
        if (values[l] !== '惊讶' && values[l] !== '害怕') break
      }
      let rightTense = ''
      for (let r = end + 1; r <= Math.min(lines.length - 1, end + 3); r++) {
        if (spanScene && lines[r].sceneId && lines[r].sceneId !== spanScene) break
        if (isDenseTenseEmotion(values[r])) {
          rightTense = values[r]
          break
        }
        if (values[r] !== '惊讶' && values[r] !== '害怕') break
      }
      if (leftTense && rightTense) {
        const hasResolution = lines
          .slice(start, end + 1)
          .some((l) => isGenuineCalmResolution(l.content))
        if (!hasResolution) {
          const fillEmotion = leftTense === '伤心' || rightTense === '伤心' ? '伤心' : leftTense
          for (let k = start; k <= end; k++) {
            values[k] = fillEmotion
          }
        }
      }
    }
    start = end
  }

  const result = new Map<string, string>()
  lines.forEach((line, index) => {
    if (values[index]) result.set(line.id, values[index])
  })
  return result
}

export function applyVoiceDirectionPlan(
  dialogue: StagedDialogue,
  plan: Map<string, StagedVoiceDirectionLine> | null,
  labels: string[]
): StagedDialogue {
  const allowed = new Set(labels.map((label) => label.trim()).filter(Boolean))
  const rawEmotions = new Map<string, string>()
  if (plan) {
    for (const [id, entry] of plan) {
      if (entry.emotion) rawEmotions.set(id, entry.emotion)
    }
  }
  const stableEmotions =
    plan && allowed.size > 0 ? stabilizeEmotions(dialogue, rawEmotions, labels) : null

  const prevSpeedBySpeaker = new Map<string, number>()
  return {
    ...dialogue,
    lines: dialogue.lines.map((line) => {
      const entry = plan?.get(line.id)
      const emotion = stableEmotions?.get(line.id) ?? entry?.emotion ?? ''
      const finalEmotion = allowed.size === 0 ? emotion : allowed.has(emotion) ? emotion : ''
      const ttsCaption = entry?.ttsCaption ? sanitizeIrodoriCaption(entry.ttsCaption) : ''
      const rawSpecialScene = Boolean(entry?.ttsSpecialScene)
      const ttsSpecialScene =
        rawSpecialScene &&
        (finalEmotion !== '平静' ||
          /[！!]{2}|泣|叫|呜|耳语|ささや|嗚咽/.test(line.content) ||
          /耳語|ささや|泣|叫|嗚咽|震え/.test(ttsCaption))
      let ttsSpeed =
        typeof entry?.ttsSpeed === 'number' && Number.isFinite(entry.ttsSpeed)
          ? clampVoiceSpeed(
              finalEmotion === '平静'
                ? Math.min(1.05, Math.max(0.95, entry.ttsSpeed))
                : entry.ttsSpeed,
              ttsSpecialScene
            )
          : undefined
      if (ttsSpeed !== undefined && !ttsSpecialScene) {
        const lastSpeed = prevSpeedBySpeaker.get(line.speaker)
        if (lastSpeed !== undefined && Math.abs(ttsSpeed - lastSpeed) > 0.08) {
          ttsSpeed = lastSpeed + Math.sign(ttsSpeed - lastSpeed) * 0.08
        }
        ttsSpeed = Number(clampVoiceSpeed(ttsSpeed, false).toFixed(2))
      } else if (ttsSpeed !== undefined) {
        ttsSpeed = Number(ttsSpeed.toFixed(2))
      }
      if (ttsSpeed !== undefined) {
        prevSpeedBySpeaker.set(line.speaker, ttsSpeed)
      }
      return {
        ...line,
        emotion: finalEmotion,
        ...(ttsCaption ? { ttsCaption } : {}),
        ...(ttsSpeed !== undefined ? { ttsSpeed } : {}),
        ...(ttsSpecialScene ? { ttsSpecialScene: true } : {})
      }
    })
  }
}

export function applyEmotionPlan(
  dialogue: StagedDialogue,
  plan: Map<string, string> | Map<string, StagedVoiceDirectionLine> | null,
  labels: string[]
): StagedDialogue {
  if (!plan) {
    return {
      ...dialogue,
      lines: dialogue.lines.map((line) => ({ ...line, emotion: '' }))
    }
  }
  const firstValue = plan.values().next().value
  if (firstValue && typeof firstValue === 'object') {
    return applyVoiceDirectionPlan(dialogue, plan as Map<string, StagedVoiceDirectionLine>, labels)
  }
  const allowed = new Set(labels.map((label) => label.trim()).filter(Boolean))
  const strPlan = plan as Map<string, string>
  return {
    ...dialogue,
    lines: dialogue.lines.map((line) => {
      const emotion = strPlan.get(line.id) ?? ''
      return allowed.has(emotion) ? { ...line, emotion } : { ...line, emotion: '' }
    })
  }
}
