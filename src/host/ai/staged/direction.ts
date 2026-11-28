import { annotateFacialName } from '../facialSemantics'
import { actingPersonaPrompt } from '../personas'
import { formatBgmPromptLine, formatImagePromptLine, type CatalogView } from '../prompt'
import { annotateMotionForDirection } from './actingHelpers'
import {
  cleanText,
  corpusStagedApi,
  entriesOf,
  formatDialogueLineForPrompt,
  formatDirectingAnchorBlock,
  formatWorldviewCueBlock,
  isRecord,
  matchBackground,
  matchBgm,
  normalizeAmbient,
  normalizeBackground,
  num,
  personasStagedApi,
  resolveMemberPersona,
  resolveModel,
  str,
  toBool,
  unwrapRecord
} from './helpers'
import type {
  JsonRecord,
  StagedCastMember,
  StagedCastPlan,
  StagedDialogue,
  StagedDirection,
  StagedDirectionBeat,
  StagedDirectionLine,
  StagedListenerAction,
  StagedMessages,
  StagedPromptOptions,
  StagedStaging,
  StagedStagingScene
} from './types'

// ---------------------------------------------------------------------------
// 第四段：细腻动作与表情导演（directActing / buildDirectionPrompt）
// ---------------------------------------------------------------------------

export function buildDirectionPrompt(
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  options: StagedPromptOptions,
  staging?: StagedStaging
): StagedMessages {
  const contextText = `${options.scene}\n${plan.event}\n${plan.logline}`
  const castLines = plan.cast
    .map((member) => {
      const profile =
        typeof personasStagedApi.characterActingProfile === 'function'
          ? personasStagedApi.characterActingProfile(member.name, member.role)
          : null
      const persona = resolveMemberPersona(options.personas, member, view, contextText)
      const actingPrompt = actingPersonaPrompt(persona, 2200)
      const note = profile?.actingNote ? `（演技特点：${profile.actingNote}）` : ''
      return `- ${member.name}（modelId=${member.modelId}）${member.role ? ` — ${member.role}` : ''}${note}${
        actingPrompt ? `\n${actingPrompt}` : ''
      }`
    })
    .join('\n')

  const sceneForLine = (idx: number): StagedStagingScene | null => {
    if (!staging || staging.scenes.length === 0) return null
    let current = staging.scenes[0]
    for (const s of staging.scenes) {
      if (idx >= s.fromIndex) current = s
    }
    return current
  }

  const appearedBefore = new Set<string>()
  const dialogueLines = dialogue.lines
    .map((line, idx) => {
      const scene = sceneForLine(idx)
      const isEntry = !appearedBefore.has(line.speaker)
      appearedBefore.add(line.speaker)
      const ctxTags = [
        line.emotion ? `〔${line.emotion}〕` : '',
        line.ttsCaption ? `[声演:${line.ttsCaption}]` : '',
        line.ttsSpecialScene ? '[高潮]' : '',
        scene
          ? `[${scene.id}${scene.isFlashback ? '/回忆' : ''}${scene.ambient !== 'normal' ? `/${scene.ambient}` : ''}]`
          : '',
        isEntry ? '[刚入场首句]' : ''
      ]
        .filter(Boolean)
        .join('')
      return `- ${line.id} ${line.speaker}${ctxTags}：${formatDialogueLineForPrompt(line.content)}`
    })
    .join('\n')

  const hasEmotionTags = dialogue.lines.some((line) => line.emotion)

  const extView = view as CatalogView & { annotatedMotionList?: (modelIds?: number[]) => string }
  const motionLines =
    typeof extView.annotatedMotionList === 'function'
      ? extView.annotatedMotionList(plan.cast.map((c) => c.modelId))
      : plan.cast
          .map((member) => {
            const model = view.modelById(member.modelId)
            const names = model ? view.promptMotions(model) : []
            const annotated = names.map((name) => annotateMotionForDirection(model?.path, name))
            return `${member.name}(${member.modelId})：${annotated.length ? annotated.join('，') : '（无）'}`
          })
          .join('\n')

  const facialLines = plan.cast
    .map((member) => {
      const model = view.modelById(member.modelId)
      const names = model ? view.promptFacials(model) : []
      const annotated = names.map((name) => annotateFacialName(model?.path, name))
      return `${member.name}(${member.modelId})：${annotated.length ? annotated.join('，') : '（无）'}`
    })
    .join('\n')

  const directionQuery = `${options.scene} ${plan.event} ${plan.cast.map((c) => c.name).join(' ')}`
  const backgrounds = view
    .imagePromptChoices(50, directionQuery)
    .map((detail) => formatImagePromptLine(detail))
    .join('\n')

  const bgmChoices = view
    .bgmPromptChoices(30, directionQuery)
    .map((detail) => formatBgmPromptLine(detail))
    .join('\n')

  const first = plan.cast[0]
  const second = plan.cast[1]
  const firstModel = view.modelById(first.modelId)
  const secondModel = second ? view.modelById(second.modelId) : null
  const firstMotion = firstModel ? view.exampleMotion(firstModel.id) : ''
  const firstFacial = firstModel ? view.exampleFacial(firstModel.id) : ''
  const bgmChoicesList = view.bgmPromptChoices(30)
  const firstBgm = bgmChoicesList[0]?.file ?? ''
  const secondBgmChoice = bgmChoicesList.find((choice) => choice.file !== firstBgm)?.file ?? ''
  const bgmTurnLine = dialogue.lines[Math.min(2, dialogue.lines.length - 1)]

  const example = {
    background: plan.background || view.defaultImage() || '背景文件名',
    ambient: 'normal',
    bgm: firstBgm,
    ...(secondBgmChoice && bgmTurnLine ? { bgm2: secondBgmChoice, bgm2From: bgmTurnLine.id } : {}),
    bgmStop: false,
    lines: [
      {
        id: dialogue.lines[0]?.id ?? 'l1',
        ...(firstFacial ? { facial: firstFacial } : {}),
        ...(secondModel
          ? { listener: { modelId: secondModel.id, facial: view.exampleFacial(secondModel.id) } }
          : {})
      },
      ...(dialogue.lines[1]
        ? [
            {
              id: dialogue.lines[1].id,
              ...(firstMotion ? { motion: firstMotion } : {}),
              ...(firstFacial ? { facial: firstFacial } : {})
            }
          ]
        : [])
    ]
  }

  const officialActingNote =
    typeof corpusStagedApi.getOfficialActingGuidelines === 'function'
      ? `\n${corpusStagedApi.getOfficialActingGuidelines({ castCount: plan.cast.length })}\n`
      : ''

  return {
    system: [
      '你是 Project SEKAI 风格视觉小说的精细演技导演（directActing）。',
      '台词、幕次与情绪段已确定；你负责为每句台词设计说话者句首（at=0）动作与表情、听者反应以及静默反应（silentMotion）。',
      '不要改写任何台词，不要增删台词。只输出一个 JSON 对象。',
      options.systemPrompt?.trim() ?? ''
    ]
      .filter(Boolean)
      .join('\n'),
    user: `## 这一场
小事件：${plan.event || options.scene}
${plan.logline ? `一句话：${plan.logline}` : ''}
${formatDirectingAnchorBlock(plan)}${officialActingNote}
出场角色：
${castLines}${formatWorldviewCueBlock(options.ragContext)}

## 台词稿（逐字，只能引用 id，不能改字）
${dialogueLines}

## 动作/表情关键词（名称由英文语义 + 编号组成；直接输出完整名称）
- 动作：nod 点头 / tilthead 歪头 / shakehead 摇头 / glad 高兴 / sad 难过 / trouble 为难 / shy 害羞 / blushed 脸红 / sigh 叹气 / relief 松口气 / think 思考 / lookaway 移开视线 / angry 生气 / forward 前倾 / fidget 局促 / smug 得意 / wink 眨眼 / pose 摆姿势 / default 默认站姿（**greeting / shakehand / wave 属于大挥手打招呼，仅限明确问好/告别/远距离招手呼喊时使用，严禁用于日常拌嘴、生气、普通入场或听者反应**；plan 仅限得意谋划；sleep 困倦 / delicious 好吃 仅限真实睡眠或吃喝台词，平时禁用）
- 表情：face_smile 微笑 / face_sad 难过 / face_angry 生气 / face_surprise 惊讶 / face_shy 害羞 / face_trouble 为难 / face_closeeye 闭眼 / face_cry 哭 / face_serious 认真 / face_sleepy 困 / face_sparkling 闪闪发光 / face_disgust 厌恶 / face_smug 得意 / face_wink 眨眼 / face_shock 震惊 / face_worry 担心 / face_lookaway 移开视线 / face_smallmouth 抿嘴

## 可用动作（必须使用对应角色的完整名称）
${motionLines}

## 可用表情（必须使用对应角色的完整名称）
${facialLines}

${
  staging
    ? `## 背景参考（时段（白天/黄昏/夜晚）已由舞台导演规划，优先选有描述的条目）\n${backgrounds || '（沿用分幕背景）'}`
    : `## 可用背景（1~2 张）\n${backgrounds || '（目录暂未提供背景）'}\n\n## 可用 BGM（可选，最多两首）\n${bgmChoices || '（目录暂未提供带描述的 BGM，bgm 留空）'}`
}

## 表演要求
- **官方单拍节奏（at=0）与动作密度**：
  - 官方 PJSK 剧本中约四分之三的台词在句首（at=0）触发 1 个自然身体动作 + 表情；不要主动拆分人工双拍（at2）。
  - 约 22% 的句子可以完全没有动作（全量官方剧本 22.2%，多数集在 10%~35%）：平稳承接、情绪延续或刚演过动作的过渡句只换表情、只给 listener 或留空都可以，静止是正常的，不必为每句硬补动作。
- **入场去重与禁无故挥手/双人撞拍**：标有 \`[刚入场首句]\` 的台词因为紧接在 LayoutAppear 后，**不要再派发重覆的 body motion**（只写 \`facial\` 或留空即可）。**严禁在非问好/非告别/非招手呼喊语境下使用 \`greeting\` / \`shakehand\` / \`wave\` 等大幅挥手动作**；双人同场时严禁两名角色同时做相同动作或同时做大幅挥手/夸张姿势（听者只做克制的倾听/点头/思索或纯切表情）。生气争执、疲惫抱怨或普通对话中严禁错用 \`blushed\` / \`fidget\` / \`armescape\`（害羞局促）或 \`plan\`（谋划）。
- **短促反应也要有神态动作**：像「……嗯？」「啊。」「真的吗？」等短反应句**必须保留适合的身体动作与表情**（如轻点头、歪头、惊讶小动作 + facial），绝不因句短剥夺动作！
- **静默反应**：官方全量剧本里，台词之外的独立 Motion 约每 2 句 1 个；本场每 2~4 句可安排 1 个 \`silentMotion\`（听者反应、环境小动作或停顿），让双方表演自然接力。
- **听者反应对齐官方 PJSK（禁止句中错峰刷屏与情绪倒错）**：同一句 \`Talk\` 绝不同时触发说话者与听者的身体动作；当 A 连续说话时，听者 B 优先仅切 **纯表情（只写 \`facial\`，不写 \`motion\`）** 在 \`at: 0\` 自然过渡，或仅在真正情绪转折点通过 \`silentMotion\` / 独立 \`Motion\` 片段表现听者身体反应。**必须从听者自身视角出发**（如认真倾听、担忧、为难、若有所思、温和回应），绝不把说话者的「生气」「害怕」直接复制到挨骂或被倾诉的听者脸上；**若听者刚才还处于「生气」或「伤心」，即使说话者强颜欢笑打岔，听者也严禁切回 \`face_smile_*\` 笑脸**。
- **表情严格贴合语境与括号语义**：务必看清上方表情清单括号里的具体含义（例如 \`face_smile_05(苦笑/勉强笑)\`、\`face_trouble_02(苦笑/嘴角上扬)\`、\`face_closeeye_02(闭眼微笑)\`、\`face_darknormal_01(阴沉面无表情)\`），悲伤/哭泣/生气/道歉/沉重对峙语境严禁错选真笑、含泪微笑或嘴角上扬表情（除非台词明确写到苦笑/含泪安抚微笑）。${
      hasEmotionTags
        ? '〔情绪〕只代表 TTS 语音基调，**严禁把〔平静〕死板锁死在 face_normal_01**！即使在〔平静〕段内，也要根据每句台词的实际语气细腻切换微表情：温和/寒暄/赞同/调侃用真正的微笑或俏皮；认真/思索/倾听用 serious / closeeye / smallmouth / notice；无奈/窘迫/犹豫用 trouble / lookaway / worry / 苦笑；只有毫无波澜的平铺陈述才用 normal。'
        : '随每句台词语气细腻切换表情：温和/寒暄/赞同用微笑；认真/思索用 serious / closeeye / smallmouth；无奈/犹豫用 trouble / lookaway / worry；开心/伤心/生气/惊讶/害羞严格对应各自语义表情。'
    }
- **哭戏/高潮持续表情与结尾呼吸感**：在哭泣/崩溃/泪目表白段落（连续 4~8+ 句），应持续保持 \`face_cry_*\` / \`face_sad_*\` 哭泣神情，期间通过微妙身体动作或省略 \`motion\` 保持情绪连贯，**严禁每句机械乱跳表情（如哭泣途中有事无事切回 face_closeeye_01 或 face_trouble_02）**；当剧情临近结尾真正走向夕阳缓和、释怀或安静接纳时，允许过渡到舒缓释放的神情（如微闭眼/轻柔倾听/释然神态）让情绪弧光自然落地。日常段同一角色跨句延续同一表情也很自然，善用角色丰富的动作变体与贴合气氛的跨风格动作（不必锁死 4~5 个动作循环）；**朝比奈真冬**保持克制内敛的表情与动作。
- 背景的时段（白天/黄昏/夜晚）和室内外要和台词写的时间一致；优先选有描述的条目。

## 输出 JSON
${JSON.stringify(example, null, 2)}

只输出 JSON 对象本身，不要 markdown 或解释。`
  }
}

export function buildDirectionRepairPrompt(
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  options: StagedPromptOptions,
  previous: unknown,
  staging?: StagedStaging
): StagedMessages {
  const base = buildDirectionPrompt(view, plan, dialogue, options, staging)
  const raw = typeof previous === 'string' ? previous : JSON.stringify(previous)
  return {
    system: base.system,
    user: `${base.user}\n\n## 上一轮的问题
上一轮没有给出任何可用的表演设计：lines 必须逐条引用台词稿里的 id，并且至少给出一项
motion、facial 或 listener。动作/表情必须来自对应角色的清单。
上一轮的输出开头如下：
${raw.slice(0, 4000)}

请按上面的格式重写完整 JSON 对象，不要改台词。`
  }
}

function resolveDirectionListener(
  view: CatalogView,
  plan: StagedCastPlan,
  speaker: StagedCastMember,
  value: unknown
): StagedListenerAction | undefined {
  const item = isRecord(value) ? value : { modelId: value }
  const model = resolveModel(
    view,
    [],
    item.modelId ?? item.model ?? item.id ?? item.name ?? item.speaker
  )
  if (!model || model.id === speaker.modelId) return undefined
  if (!plan.cast.some((member) => member.modelId === model.id)) return undefined

  const motion = view.canonicalAnimation(model.id, 'motion', item.motion)
  const facial = view.canonicalAnimation(model.id, 'facial', item.facial)
  if (!motion && !facial) return undefined
  return { modelId: model.id, ...(motion ? { motion } : {}), ...(facial ? { facial } : {}) }
}

interface RawDirectionFields {
  motion?: unknown
  facial?: unknown
  at2?: unknown
  motion2?: unknown
  facial2?: unknown
  listener?: unknown
  beats?: StagedDirectionBeat[]
  silentMotion?: boolean
}

function readDirectionFields(
  item: JsonRecord,
  speaker: StagedCastMember,
  view: CatalogView
): RawDirectionFields {
  const fields: RawDirectionFields = {
    motion: item.motion,
    facial: item.facial,
    at2: item.at2,
    motion2: item.motion2,
    facial2: item.facial2,
    listener: item.listener,
    silentMotion: toBool(item.silentMotion)
  }

  const speakerActions: Array<{ at: number; motion?: string; facial?: string }> = []
  if (Array.isArray(item.actions)) {
    const listenerAction = item.actions.find(
      (action) => isRecord(action) && Number(action.modelId) !== speaker.modelId
    )
    if (!fields.listener && isRecord(listenerAction)) fields.listener = listenerAction

    for (const action of item.actions) {
      if (!isRecord(action) || Number(action.modelId) !== speaker.modelId) continue
      const m = view.canonicalAnimation(speaker.modelId, 'motion', action.motion) ?? undefined
      const f = view.canonicalAnimation(speaker.modelId, 'facial', action.facial) ?? undefined
      if (!m && !f) continue
      speakerActions.push({
        at: Math.max(0, Math.min(1, num(action.at, 0))),
        ...(m ? { motion: m } : {}),
        ...(f ? { facial: f } : {})
      })
    }
  }

  if (speakerActions.length > 0) {
    speakerActions.sort((a, b) => a.at - b.at)
    const first = speakerActions[0]
    fields.motion = fields.motion ?? first.motion
    fields.facial = fields.facial ?? first.facial
    if (speakerActions.length >= 2) {
      const second = speakerActions.find((a) => a.at - first.at >= 0.2)
      if (second) {
        fields.beats = [
          {
            at: 0,
            ...(first.motion ? { motion: first.motion } : {}),
            ...(first.facial ? { facial: first.facial } : {})
          },
          {
            at: Math.min(0.85, Math.max(0.35, second.at)),
            ...(second.motion ? { motion: second.motion } : {}),
            ...(second.facial ? { facial: second.facial } : {})
          }
        ]
      }
    }
  }

  if (!fields.beats && (fields.motion2 !== undefined || fields.facial2 !== undefined)) {
    const m1 = view.canonicalAnimation(speaker.modelId, 'motion', fields.motion) ?? undefined
    const f1 = view.canonicalAnimation(speaker.modelId, 'facial', fields.facial) ?? undefined
    const m2 = view.canonicalAnimation(speaker.modelId, 'motion', fields.motion2) ?? undefined
    const f2 = view.canonicalAnimation(speaker.modelId, 'facial', fields.facial2) ?? undefined
    if ((m1 || f1) && (m2 || f2)) {
      const at2 = Math.min(0.85, Math.max(0.35, num(fields.at2, 0.55)))
      fields.beats = [
        { at: 0, ...(m1 ? { motion: m1 } : {}), ...(f1 ? { facial: f1 } : {}) },
        { at: at2, ...(m2 ? { motion: m2 } : {}), ...(f2 ? { facial: f2 } : {}) }
      ]
    }
  }

  return fields
}

export function normalizeDirection(
  raw: unknown,
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue
): StagedDirection {
  const doc = unwrapRecord(raw, ['direction', 'storyboard', 'story', 'plan'])
  if (!isRecord(doc)) return fallbackDirection(view, plan)
  const body = entriesOf(doc.lines ?? doc.beats)
  const byId = new Map(dialogue.lines.map((line) => [line.id, line]))
  const result = new Map<string, StagedDirectionLine>()

  for (const [index, item] of body.entries()) {
    if (!isRecord(item)) continue
    const id = str(item.id ?? item.lineId ?? item.line) || dialogue.lines[index]?.id || ''
    const line = byId.get(id)
    if (!line) continue
    const speaker = plan.cast.find((member) => member.name === line.speaker)
    if (!speaker) continue

    const fields = readDirectionFields(item, speaker, view)
    let motion = view.canonicalAnimation(speaker.modelId, 'motion', fields.motion)
    let facial = view.canonicalAnimation(speaker.modelId, 'facial', fields.facial)
    const listener = resolveDirectionListener(view, plan, speaker, fields.listener)
    let beats = fields.beats
    // 短台词（<=16字）不要在句中切第二个 body motion，以免刚起的短动作被腰斩（保留第二个表情）
    if (beats && beats.length >= 2 && cleanText(line.content).length <= 16) {
      beats = beats.map((beat, beatIdx) => {
        if (beatIdx === 0 || !beat.motion) return beat
        const { motion: _drop, ...restBeat } = beat
        return restBeat
      })
      beats = beats.filter((beat) => Boolean(beat.motion || beat.facial))
      if (beats.length < 2) {
        motion = motion ?? beats[0]?.motion ?? null
        facial = facial ?? beats[0]?.facial ?? null
        beats = undefined
      }
    }
    if (!motion && !facial && !listener && (!beats || beats.length === 0)) continue
    result.set(id, {
      id,
      ...(motion ? { motion } : {}),
      ...(facial ? { facial } : {}),
      ...(beats && beats.length >= 2 ? { beats } : {}),
      ...(listener ? { listener } : {}),
      ...(fields.silentMotion ? { silentMotion: true } : {})
    })
  }

  const bgm = matchBgm(view, doc.bgm ?? doc.music ?? doc.bgmFile)

  // 听者反应预算：长对话保留约 18%（>=6 句至少 1 条），允许在双人对话中错峰回应，避免一方长期僵立。
  const maxListeners =
    dialogue.lines.length < 6 ? 0 : Math.max(1, Math.round(dialogue.lines.length * 0.18))
  let listenerCount = 0
  let previousSpeakerForListener = ''
  for (const line of dialogue.lines) {
    const directed = result.get(line.id)
    if (!directed?.listener) {
      previousSpeakerForListener = line.speaker
      continue
    }
    const firstOfRun = previousSpeakerForListener !== line.speaker
    if (
      listenerCount < maxListeners &&
      (firstOfRun || listenerCount < Math.floor(maxListeners * 0.6))
    ) {
      listenerCount += 1
    } else {
      const { listener: _dropped, ...rest } = directed
      result.set(line.id, rest)
    }
    previousSpeakerForListener = line.speaker
  }

  // 动作预算控制：
  // 遵循官方 PJSK ~80% 单拍动作密度；仅统计并裁剪多余的 body motion，绝对保留每句的 facial 表情！
  const maxSpeakerActions = Math.ceil(dialogue.lines.length * 0.9)
  const hasMotionInDirection = (d: StagedDirectionLine | undefined): boolean =>
    Boolean(d?.motion || (d?.beats && d.beats.some((b) => Boolean(b.motion))))
  const speakerLinesWithMotion = dialogue.lines.filter((line) =>
    hasMotionInDirection(result.get(line.id))
  ).length
  if (speakerLinesWithMotion > maxSpeakerActions) {
    const lineIdxById = new Map(dialogue.lines.map((l, idx) => [l.id, idx]))
    const hasMotionOnIndex = (idx: number): boolean => {
      if (idx < 0 || idx >= dialogue.lines.length) return false
      return hasMotionInDirection(result.get(dialogue.lines[idx].id))
    }
    const candidates = dialogue.lines
      .map((line, index) => ({
        line,
        index,
        directed: result.get(line.id)
      }))
      .filter((item) => hasMotionInDirection(item.directed))
      .sort((a, b) => {
        const aCalm = !a.line.emotion || a.line.emotion === '平静' ? 0 : 1
        const bCalm = !b.line.emotion || b.line.emotion === '平静' ? 0 : 1
        if (aCalm !== bCalm) return aCalm - bCalm
        return b.index - a.index
      })
    let remaining = speakerLinesWithMotion
    for (const candidate of candidates) {
      if (remaining <= maxSpeakerActions) break
      const idx = lineIdxById.get(candidate.line.id) ?? candidate.index
      // 不连续两句静态站桩：只有前后两句都有动作时才允许省去中间这句
      if (!hasMotionOnIndex(idx - 1) || !hasMotionOnIndex(idx + 1)) continue
      const directed = result.get(candidate.line.id)
      if (!directed) continue
      const preservedFacial =
        directed.facial ?? directed.beats?.find((b) => Boolean(b.facial))?.facial
      const { motion: _motion, beats: _beats, ...rest } = directed
      if (preservedFacial) rest.facial = preservedFacial
      if (rest.facial || rest.listener || rest.silentMotion) {
        result.set(candidate.line.id, rest)
      } else {
        result.delete(candidate.line.id)
      }
      remaining -= 1
    }
  }

  const ambient = normalizeAmbient(doc.ambient ?? doc.timeOfDay)
  const mainBackground =
    matchBackground(view, doc.background) ||
    normalizeBackground(view, plan.background) ||
    view.defaultImage()
  const secondBackground = matchBackground(view, doc.background2 ?? doc.backgroundAlt)
  const secondFromIndex = dialogue.lines.findIndex(
    (line) => line.id === str(doc.background2From ?? doc.background2FromLine).trim()
  )
  const useSecond =
    Boolean(secondBackground) &&
    secondBackground !== mainBackground &&
    secondFromIndex > 0 &&
    secondFromIndex < dialogue.lines.length - 1

  const secondBgm = matchBgm(view, doc.bgm2 ?? doc.bgmAlt)
  const secondBgmFromIndex = dialogue.lines.findIndex(
    (line) => line.id === str(doc.bgm2From ?? doc.bgm2FromLine).trim()
  )
  const useSecondBgm =
    Boolean(bgm) &&
    Boolean(secondBgm) &&
    secondBgm !== 'silence' &&
    secondBgm !== bgm &&
    secondBgmFromIndex > 0 &&
    secondBgmFromIndex < dialogue.lines.length - 1

  return {
    background: mainBackground,
    ...(useSecond
      ? { background2: secondBackground as string, background2From: secondFromIndex }
      : {}),
    ambient,
    bgm: bgm === 'silence' ? '' : bgm,
    ...(useSecondBgm ? { bgm2: secondBgm as string, bgm2From: secondBgmFromIndex } : {}),
    bgmStop: toBool(doc.bgmStop ?? doc.stopBgm),
    lines: dialogue.lines
      .map((line) => result.get(line.id))
      .filter((line): line is StagedDirectionLine => Boolean(line))
  }
}

export function fallbackDirection(view: CatalogView, plan: StagedCastPlan): StagedDirection {
  return {
    background: plan.background || view.defaultImage(),
    ambient: 'normal',
    bgm: '',
    bgmStop: false,
    lines: []
  }
}
