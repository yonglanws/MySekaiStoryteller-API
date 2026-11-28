import type { CatalogModel } from '../../resources/resourceCatalog'
import {
  extractPairwiseAddressBook,
  inferUnitFromText,
  normalizeUnit,
  personaFor,
  type PersonaEntry
} from '../personas'
import {
  formatBgmPromptLine,
  formatImagePromptLine,
  isBackViewModel,
  type CatalogView
} from '../prompt'
import { normalizeScenarioEffectName } from '../scenarioCues'
import {
  castMemberFor,
  formatCanonGroundingBrief,
  isRecord,
  lineBudget,
  matchBgm,
  mergePairwiseAddresses,
  normalizeAmbient,
  normalizeBackground,
  normalizeCharacterGoals,
  normalizeTransitionKind,
  oneLine,
  personaSummary,
  resolveFirstModel,
  resolveModel,
  str,
  titleOrDefault,
  toBool,
  unwrapRecord
} from './helpers'
import type {
  QuickCastOptions,
  StagedCastMember,
  StagedCastPlan,
  StagedMessages,
  StagedPairwiseAddress,
  StagedPromptOptions,
  StagedPromptUnderstanding,
  StagedRetrievalQueries,
  StagedScenePlan
} from './types'

const EXPLICIT_GROUP_INTENT_RE =
  /大家|全员|全体|全团|全队|众人|成员们|其他成员|其余成员|队友们|三人|四人|五人|聚会|团建|live|演唱会|文化祭/i

const META_EVENT_STYLE_RE = /活动风格|活动剧情|活动卡面|活动向|20\d\d\s*年活动/g

const PERSON_LEFT_DELIM_RE = /[与和跟找对向把给连比让请由被、，。！？（）()“”"‘’'「」『』：:/\s]/

const PERSON_RIGHT_DELIM_RE = /[与和跟对向把给、，。！？（）()“”"‘’'「」『』：:/\s]/

const SINGLE_CHAR_NON_NAME_WORDS: Record<string, RegExp> = {
  类: /类型|类似|种类|分类|人类|同类|这类|那类|此类|另类|肉类|酒类|鱼类|鸟类|门类|之类|各类|全类|品类|大类/,
  司: /公司|司机|上司|司令|司仪|司法|司空|司职|司马|有司/,
  遥: /遥远|遥望|遥控|逍遥|遥想|遥感|遥测|遥相|路遥/,
  奏: /演奏|合奏|伴奏|前奏|间奏|节奏|独奏|重奏|奏效|奏章|奏折|奏鸣|先斩后奏/,
  杏: /银杏|杏仁|杏花|杏色|杏黄|杏子|青杏/,
  铃: /铃声|铃铛|门铃|电铃|响铃|风铃|闹铃|哑铃|铃兰/,
  连: /连续|连线|连夜|连日|连同|连连|牵连|接连|连接|连带|连累|连衣|连忙|连载|连贯|连锁|连胜|连任|连长|连队|一连|连日|相连|流连/
}

function hasSingleCharNameMention(scene: string, shortName: string): boolean {
  if (!scene || shortName.length !== 1) return false
  const compoundRe = SINGLE_CHAR_NON_NAME_WORDS[shortName]
  let idx = scene.indexOf(shortName)
  while (idx !== -1) {
    const prev = idx > 0 ? scene[idx - 1] : ''
    const next = idx + 1 < scene.length ? scene[idx + 1] : ''
    const leftOk = idx === 0 || PERSON_LEFT_DELIM_RE.test(prev)
    const rightSepOk = idx + 1 === scene.length || PERSON_RIGHT_DELIM_RE.test(next)
    // 「连」作副词（如「连我都忘了」）高频误判，仅在明确人名并列/介词称谓且非后续代词时匹配
    const particleGuard =
      shortName !== '连' ||
      ((prev === '' || /[与和跟对向把给、，：:「『（\s]/.test(prev)) &&
        !/^[我你他她它这那谁也都很再]/.test(next))
    let spansCompound = false
    if (compoundRe) {
      const window2Left = scene.slice(Math.max(0, idx - 1), idx + 1)
      const window2Right = scene.slice(idx, Math.min(scene.length, idx + 2))
      const window3 = scene.slice(Math.max(0, idx - 1), Math.min(scene.length, idx + 2))
      const window4 = scene.slice(Math.max(0, idx - 2), Math.min(scene.length, idx + 3))
      if (
        compoundRe.test(window2Left) ||
        compoundRe.test(window2Right) ||
        compoundRe.test(window3) ||
        compoundRe.test(window4)
      ) {
        spansCompound = true
      }
    }
    if (!spansCompound && particleGuard && (leftOk || rightSepOk)) {
      return true
    }
    idx = scene.indexOf(shortName, idx + 1)
  }
  return false
}

function isModelMentionedInScene(scene: string, model: CatalogModel): boolean {
  if (model.name && scene.includes(model.name)) return true
  const short = (model.shortName ?? '').trim()
  if (!short) return false
  if (short.length >= 2) return scene.includes(short)
  return hasSingleCharNameMention(scene, short)
}

function findMentionedPrimaryModels(scene: string, models: CatalogModel[]): CatalogModel[] {
  const seenChar = new Set<string>()
  const picked: CatalogModel[] = []
  for (const model of models) {
    const key =
      typeof model.characterId === 'number'
        ? `char:${model.characterId}`
        : `name:${model.name.toLowerCase()}`
    if (seenChar.has(key)) continue
    if (isModelMentionedInScene(scene, model)) {
      seenChar.add(key)
      picked.push(model)
    }
  }
  return picked
}

function isGroupPrompt(scene: string, view: CatalogView): boolean {
  if (view.models.length < 3) return false
  const mentionedCount = findMentionedPrimaryModels(scene, view.primaryModels()).length
  if (mentionedCount >= 3) return true
  const cleanedScene = scene.replace(META_EVENT_STYLE_RE, '')
  if (mentionedCount >= 1) {
    return EXPLICIT_GROUP_INTENT_RE.test(cleanedScene)
  }
  return (
    EXPLICIT_GROUP_INTENT_RE.test(cleanedScene) ||
    /社团|排练|25时|nightcord|leo\/need|mmj|vbs|ws|wxs|sekai/i.test(cleanedScene)
  )
}

// ---------------------------------------------------------------------------
// 第一段：选角与分幕节奏表（planEpisode）
// ---------------------------------------------------------------------------

function compactOutfitOptions(view: CatalogView, model: CatalogModel, scene: string): string {
  const variants = view.outfitsFor(model)
  if (variants.length <= 1) return ''
  const allowBack = /背影|背面|背对|back\s*view/i.test(scene)
  const frontVariants = allowBack ? variants : variants.filter((v) => !isBackViewModel(v))
  const pool = frontVariants.length > 0 ? frontVariants : variants
  // 每个服装大类取代表性变体，优先命中的场景服装/组合关键词放前，适配 576+ 云端模型目录
  const picked: CatalogModel[] = []
  const seenCats = new Set<string>()
  const sceneMatched = view.resolveOutfitVariant(model, scene)
  if (
    sceneMatched &&
    sceneMatched.id !== model.id &&
    (allowBack || !isBackViewModel(sceneMatched))
  ) {
    picked.push(sceneMatched)
    seenCats.add(sceneMatched.outfitCategory ?? sceneMatched.outfitLabel ?? '')
  }
  for (const variant of pool) {
    if (picked.length >= 6) break
    const cat = variant.outfitCategory || variant.outfitLabel || String(variant.id)
    if (cat === '特殊' && !/幼年|剪影|童年/.test(scene)) continue
    if (seenCats.has(cat)) continue
    seenCats.add(cat)
    picked.push(variant)
  }
  if (picked.length <= 1) return ''
  return ` [服装: ${picked.map((v) => `${v.outfitLabel || v.outfitCategory || '默认'}=${v.id}`).join(', ')}]`
}

export function buildCastPrompt(view: CatalogView, options: StagedPromptOptions): StagedMessages {
  const budget = lineBudget(options.targetMinutes)
  const primary = view.primaryModels()
  const mainRoster = primary.filter((m) => !m.isSubCharacter)
  const subRosterAll = primary.filter((m) => m.isSubCharacter)
  const subMentioned = subRosterAll.filter((m) => isModelMentionedInScene(options.scene, m))
  const subShown = [
    ...subMentioned,
    ...subRosterAll
      .filter((m) => !subMentioned.includes(m))
      .slice(0, Math.max(0, 12 - subMentioned.length))
  ]

  const mentionedModels = findMentionedPrimaryModels(options.scene, primary)
  const mentionedSet = new Set(mentionedModels.map((m) => m.id))
  const sceneUnitHint = inferUnitFromText(options.scene)
  const cleanedSceneForGroup = options.scene.replace(META_EVENT_STYLE_RE, '')
  const asksForGroup = EXPLICIT_GROUP_INTENT_RE.test(cleanedSceneForGroup)
  const groupStyle = isGroupPrompt(options.scene, view)
  const richRoster = mainRoster.length <= 6
  const models = mainRoster
    .map((model) => {
      const normalizedUnit = normalizeUnit(model.unit)
      const persona = personaFor(options.personas, model, {
        unitHint: sceneUnitHint ?? normalizedUnit,
        contextText: options.scene
      })
      const group = model.unit ? `（${model.unit}）` : persona?.group ? `（${persona.group}）` : ''
      const isFocused =
        richRoster ||
        mentionedSet.has(model.id) ||
        Boolean(sceneUnitHint && normalizeUnit(persona?.unit) === sceneUnitHint)
      const digest = personaSummary(
        persona,
        mentionedSet.has(model.id) ? 2200 : isFocused ? 1100 : 260
      )
      const outfits = compactOutfitOptions(view, model, options.scene)
      return `- modelId=${model.id} ${view.shortName(model)}${group}${outfits}${
        digest ? `\n${digest}` : ''
      }`
    })
    .join('\n')

  const subModelsBlock =
    subShown.length > 0
      ? `\n\n## 可选配角 / 特别角色（按需选用）\n${subShown
          .map((m) => {
            const p = subMentioned.includes(m)
              ? personaFor(options.personas, m, {
                  unitHint: sceneUnitHint ?? normalizeUnit(m.unit),
                  contextText: options.scene
                })
              : null
            const subDigest = p ? personaSummary(p, 900) : ''
            return `- modelId=${m.id} ${view.shortName(m)}${m.outfitLabel ? `（${m.outfitLabel}）` : ''}${
              subDigest ? `\n${subDigest}` : ''
            }`
          })
          .join('\n')}`
      : ''

  const candidateAddressBook =
    mentionedModels.length >= 2
      ? extractPairwiseAddressBook(
          options.personas,
          mentionedModels.map((m) => view.shortName(m)),
          {
            ...(sceneUnitHint ? { unitHint: sceneUnitHint } : {}),
            ...(options.scene ? { contextText: options.scene } : {})
          }
        )
      : []
  const candidateAddressBlock =
    candidateAddressBook.length > 0
      ? `\n\n## 候选角色已知人设称呼（pairwiseAddress 必须采纳）\n${candidateAddressBook
          .map((r) => `- ${r.from} → ${r.to}：「${r.zh}」${r.note ? `（${r.note}）` : ''}`)
          .join('\n')}`
      : ''
  const researchBriefBlock = options.researchBrief?.trim()
    ? `\n\n## 前置探索研究简报（已核实人设记忆、官方剧情与云端素材，选角与大纲优先采纳）\n${options.researchBrief.trim()}`
    : ''

  const backgrounds = view
    .imagePromptChoices(72, options.scene)
    .map((detail) => formatImagePromptLine(detail))
    .join('\n')

  const bgmList = view
    .bgmPromptChoices(32, options.scene)
    .map((detail) => formatBgmPromptLine(detail))
    .join('\n')

  const first = mainRoster[0] ?? view.models[0]
  const second = mainRoster[1] ?? view.models[1]
  const third = mainRoster[2] ?? view.models[2]
  const exampleCast = [
    {
      modelId: first?.id ?? 1,
      name: first ? view.shortName(first) : '角色A',
      role: '发起话题'
    },
    ...(second ? [{ modelId: second.id, name: view.shortName(second), role: '回应与吐槽' }] : []),
    ...(groupStyle && third
      ? [{ modelId: third.id, name: view.shortName(third), role: '中段加入/调和' }]
      : [])
  ]
  const firstBgm = view.bgmPromptChoices(10)[0]?.id ?? view.bgmPromptChoices(10)[0]?.file ?? ''
  const example = {
    title: '短标题',
    logline: '一句话概括这一场',
    event: '一个具体的小事件',
    background: view.defaultImage() || '背景文件名',
    cast: exampleCast,
    scenes: [
      {
        id: 's1',
        summary: '开场铺垫与日常进入',
        background: view.defaultImage() || '背景文件名',
        ambient: 'normal',
        telop: '放学后',
        placeInfo: '放学后的教室',
        transitionIn: 'black',
        activeCast: exampleCast.slice(0, 2).map((c) => c.name),
        bgm: firstBgm || 'keep'
      },
      {
        id: 's2',
        summary: '情绪转折或回忆插叙',
        background: view.defaultImage() || '背景文件名',
        ambient: 'evening',
        transitionIn: 'sideFade',
        activeCast: exampleCast.slice(0, 2).map((c) => c.name),
        bgm: 'silence'
      }
    ],
    outline: ['开场日常……', '小事件出现波澜……', '情绪转折/留白……', '温柔收束……'],
    understanding: {
      explicitRequests: ['用户明确要求的场景/事件/角色'],
      implicitSubtext: '潜台词与角色真正想说却没直接出口的情绪',
      relationshipDynamic: '所选角色之间当下的关系张力与相处模式',
      emotionalArc: '从起手到高潮再到余韵收尾的情绪弧光',
      turningPoint: '中段某一拍情绪温度转向的原因（如看见对方留下的笔记，语气从拘谨转为坦白）',
      openingMotif: '开场 1~4 句里出现的具体日常物件或感官细节',
      closingCallback: '结尾 2~3 句怎样轻描淡写地回扣这个意象，而不是总结道理',
      characterGoals:
        exampleCast.length > 0
          ? [
              {
                cast: exampleCast[0].name,
                wants: '表面上想达成的事',
                hides: '没说出口的担心或私心'
              }
            ]
          : [],
      canonHooks: ['可自然呼应的官方设定、地点或过往事件'],
      avoidList: ['避免 OOC、说教式总结或套路化抒情']
    },
    pairwiseAddress:
      exampleCast.length >= 2
        ? [
            {
              from: exampleCast[0].name,
              to: exampleCast[1].name,
              zh: exampleCast[1].name,
              ja: exampleCast[1].name
            }
          ]
        : [],
    retrievalQueries: {
      plot: '与本场核心事件相关的官方剧情或过往经历',
      voice: `${exampleCast
        .slice(0, 2)
        .map((c) => c.name)
        .join(' ')} 日常互动对白与称呼`,
      worldview: '相关地点、社团/团体设定或关系背景'
    }
  }

  const preCastRagBlock = formatCanonGroundingBrief({
    ragContext: options.ragContext,
    stage: 'cast',
    maxChars: 1500
  })

  const mentionedLabels = mentionedModels
    .map((m) => `${view.shortName(m)}(modelId=${m.id})`)
    .join('、')
  const castRule =
    view.models.length <= 2
      ? '从角色池选 1~2 名角色（默认 2 人；仅明确要求独白时选 1 人）。'
      : mentionedModels.length >= 2 && !asksForGroup
        ? `用户已明确点名出场角色（${mentionedLabels}），且未要求其他成员或群像加入：**本次严格只选这 ${mentionedModels.length} 名角色**，严禁擅自加入未点名的同组合队友或其他无关角色。`
        : mentionedModels.length === 1 && !asksForGroup
          ? `用户已明确点名「${mentionedLabels}」：若描述为单人独白则只选这 1 人；若需要对手戏且剧情隐含另一位搭档，最多再配 1 名最相关角色（共 1~2 人），切勿无故拉入未提及的多余队友。`
          : groupStyle
            ? '本场偏向团体/活动场景：建议选 **3~5 名角色** 参演，用 scenes 或 stageGroup 安排每幕 1~2 人在场（官方 Normal 模式每次最多 2 人同台，通过 2 人交叠淡出淡入轮换上场）。'
            : '按场景需要选 **2~5 名角色**（双人对话选 2 人，日常同框为主、内心独白或思索时也允许切单人 Center 留白；团体/活动场景选 3~5 人并按场景或对话轮换保持每次最多 2 人在场；仅明确独白选 1 人），严禁擅自加入未提及的多余角色。'

  return {
    system: [
      '你是 Project SEKAI 风格视觉小说的编剧兼总导演。',
      '这是五阶段创作的第一轮（Episode Beat Sheet）：选角（1~5人）、设计小事件，并按剧情需要规划 1~3 幕节奏表（scenes；连续同时空对话只写 1 幕即可）。',
      '不要写台词正文，不要写动作编号。只输出一个 JSON 对象。'
    ].join('\n'),
    user: `## 任务
${options.scene}

- 语言：中文（台词 content 用中文，日文 ttsText 由宿主另行翻译）
- 目标时长：约 ${options.targetMinutes} 分钟，约 ${budget} 句台词（按 PJSK 配音与停顿约 7 秒/句换算，凝练紧凑，切勿注水拉长）
- 只演完一个核心事件或情绪弧光，禁止塞入多条无关支线${preCastRagBlock}

## 可选角色（modelId — 显示名；含重写人设记忆与关系；若角色有 [服装: ...=ID]，按场合直接选对应 modelId）
${models || '（资源目录为空）'}${subModelsBlock}${candidateAddressBlock}${researchBriefBlock}

## 可选背景（按场景地点、时段[白天/黄昏/夜晚/深夜]与[室内/室外]精准选择）
${backgrounds || '（目录暂未提供背景）'}

## 可选 BGM（按[情绪·节奏]选择；含 silence 静音切停）
${bgmList || '（可使用 keep 或 silence）'}

## 选角与分幕要求
- ${castRule}
- 若用户描述涉及明确的三方关系冲突（例如「真冬 + 真冬母亲 + 25时 KAITO」），请勿删掉核心当事人导致其余两人隔空争执，应一并选入 \`cast\`（通过 Normal 每次最多 2 人同框轮换呈现）；非「世界」持有者不直接肉身进入 SEKAI，虚拟歌手介入现实场景优先使用手机全息投影或梦境/错觉包装。
- 给每个角色标明本场功能（谁发起、谁回应、谁吐槽、谁压轴）。
- **自然分幕（1~3 幕 scenes，不强制凑数）**：
  - 同一地点、同一时段的连续对话只规划 **1 幕（s1）** 即可，切勿硬拆成 2~3 幕；仅当真正需要换地点、跳时间、插回忆或出入 SEKAI 时才拆出第 2~3 幕。
  - 每幕写明 \`id\`（s1/s2/s3）、\`summary\`、\`background\`（必须来自可用背景清单中的真实场景背景，严禁使用纯黑/纯色过渡幕布如 \`bg_a000000\` 或 \`特效与纯色\`）、\`ambient\`（normal/evening/night）、\`activeCast\`（1~2 名本幕起手在场角色名，Normal 模式每次最多 2 人）。
  - 合理规划转场与标题条：首幕可用 \`telop\`（时间/气氛短标题，如「放学后」）或 \`placeInfo\`（左上角地点条）；后续幕次可用 \`transitionIn\`：\`sideFade\`（横向遮罩擦除）、\`flashback\`（白光闪入回忆：WhiteOut->FlashbackIn->WhiteIn）、\`sekaiIn\`/\`sekaiOut\`（出入 SEKAI）或 \`black\`。
  - 若场景涉及回忆，标注 \`isFlashback: true\`、\`transitionIn: "flashback"\`；若涉及出入 SEKAI，标注 \`isSekai: true\` 与 \`sekaiIn\`/\`sekaiOut\`。
  - 善用 BGM 弧光：首幕（s1）必须从可用 BGM 清单选择贴合气氛的开场配乐（严禁首幕大段无声，只有 2~4 句冷开场且第 5 句前切入 BGM 才可留空）；中后段情绪转折或坦白前一幕可写 \`bgm: "silence"\`（对应官方 \`bgm00000\` 静音停曲留白），之后再接入情绪曲。
- title 是短标题（不超过 12 个字），logline 一句话，outline 4~6 条写“发生什么”。
- **深度意图拆解（understanding）**：提炼显性要求（explicitRequests）、潜台词（implicitSubtext）、角色关系张力（relationshipDynamic）、情绪弧光（emotionalArc）、中段转折点（turningPoint：情绪温度在哪一拍转向及动因）、开场日常意象（openingMotif：前 1~4 句出现的具体物件或感官细节）、收尾回扣（closingCallback：结尾 2~3 句怎样轻巧呼应开场意象，替代说教总结）、各角色表里动机（characterGoals：想得到什么 vs 隐瞒什么）、官方连续性钩子（canonHooks）与禁忌避坑清单（avoidList）。
- **两两称呼表（pairwiseAddress）**：列出入选角色彼此的准确官方中文称呼与日文称呼/敬语（如 zh/ja），供后续对白与日文配音翻译严格遵守。
- **多面检索查询（retrievalQueries）**：给出 2~3 条简短精准的检索短语（plot 剧情事件、voice 角色互动口吻、worldview 地点/设定），用于下一阶段检索官方参考语料。

## 输出 JSON
${JSON.stringify(example, null, 2)}

只输出 JSON 对象本身，不要 markdown 或解释。`
  }
}

/**
 * 快速选角：single/chat 只有一次主生成，先把 26 人缩到合适人数，
 * 避免把 26 份完整人设全部塞进主提示词。
 */
export function buildQuickCastPrompt(view: CatalogView, options: QuickCastOptions): StagedMessages {
  const primary = view.primaryModels()
  const roster = primary
    .filter(
      (m) =>
        !m.isSubCharacter ||
        (m.name && options.scene.includes(m.name)) ||
        (m.shortName && options.scene.includes(m.shortName))
    )
    .map((model) => {
      const persona = personaFor(options.personas, model)
      const summary = personaSummary(persona)
      const outfits = compactOutfitOptions(view, model, options.scene)
      return `- modelId=${model.id} ${view.shortName(model)}${outfits}${summary ? `：${summary}` : ''}`
    })
    .join('\n')
  const history = (options.history ?? [])
    .slice(-4)
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n')
  return {
    system:
      '你是角色选择器。根据用户消息从角色池选最合适的角色（对话选 1~2 个，团体活动选 2~4 个）。只输出 JSON：{"cast":[modelId,...]}。',
    user: `用户说：${options.scene}\n${history ? `最近对话：\n${history}\n` : ''}\n可选角色：\n${roster}\n\n只输出 JSON。`
  }
}

function resolveCastNameList(
  rawList: unknown,
  cast: StagedCastMember[],
  view: CatalogView,
  personas: PersonaEntry[]
): string[] {
  const arr = Array.isArray(rawList) ? rawList : []
  const picked: string[] = []
  for (const item of arr) {
    const byName = cast.find(
      (c) =>
        c.name === str(item).trim() ||
        c.fullName === str(item).trim() ||
        String(c.modelId) === str(item).trim()
    )
    if (byName) {
      if (!picked.includes(byName.name)) picked.push(byName.name)
      continue
    }
    const model = resolveModel(view, personas, item)
    if (model) {
      const member = cast.find((c) => c.modelId === model.id)
      if (member && !picked.includes(member.name)) picked.push(member.name)
    }
  }
  return picked.slice(0, 3)
}

export function normalizeCastPlan(
  raw: unknown,
  view: CatalogView,
  options: StagedPromptOptions
): StagedCastPlan | null {
  const doc = unwrapRecord(raw, ['plan', 'cast_plan', 'episode', 'story'])
  if (!isRecord(doc)) return null

  const entries = Array.isArray(doc.cast)
    ? doc.cast
    : isRecord(doc.cast)
      ? Object.entries(doc.cast).map(([id, value]) =>
          typeof value === 'string'
            ? { model: value, modelId: id }
            : { ...(isRecord(value) ? value : {}), modelId: id }
        )
      : []

  const cast: StagedCastMember[] = []
  const seen = new Set<number>()
  for (const entry of entries) {
    if (cast.length >= 5) break
    const item = typeof entry === 'string' ? { name: entry } : entry
    if (!isRecord(item)) continue
    let model = resolveFirstModel(view, options.personas, [
      item.model,
      item.modelId,
      item.id,
      item.name,
      item.shortName
    ])
    const outfitHint = str(item.outfit ?? item.costume ?? item.cloth ?? '').trim()
    if (model && outfitHint) {
      model = view.resolveOutfitVariant(model, outfitHint) ?? model
    }
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    cast.push(castMemberFor(view, model, item.role))
  }
  if (cast.length === 0) return null

  const outline = Array.isArray(doc.outline)
    ? doc.outline
        .map((item) => oneLine(item, 200))
        .filter(Boolean)
        .slice(0, 8)
    : []

  const planBgHint = [
    options.scene,
    str(doc.event),
    str(doc.logline),
    cast.map((c) => c.name).join(' ')
  ]
    .filter(Boolean)
    .join(' ')
  const defaultBg = normalizeBackground(view, doc.background ?? doc.image ?? doc.scene, planBgHint)
  const rawScenes = Array.isArray(doc.scenes) ? doc.scenes : []
  const scenes: StagedScenePlan[] = []
  for (const [index, item] of rawScenes.slice(0, 4).entries()) {
    if (!isRecord(item)) continue
    const active = resolveCastNameList(
      item.activeCast ?? item.cast ?? item.speakers,
      cast,
      view,
      options.personas
    ).slice(0, 2)
    const fallbackActive =
      cast.length === 2
        ? cast.map((c) => c.name)
        : cast.slice(0, Math.min(2, cast.length)).map((c) => c.name)
    const isFlashback = toBool(item.isFlashback ?? item.flashback)
    const isSekai = toBool(item.isSekai ?? item.sekai)
    let transitionIn = normalizeTransitionKind(item.transitionIn ?? item.transition)
    if (isFlashback && transitionIn === 'black') transitionIn = 'flashback'
    if (isSekai && transitionIn === 'black') transitionIn = 'sekaiIn'
    const bgmRaw = str(item.bgm).trim()
    const bgm =
      bgmRaw.toLowerCase() === 'keep'
        ? 'keep'
        : bgmRaw.toLowerCase() === 'silence' || bgmRaw.toLowerCase() === 'bgm00000'
          ? 'silence'
          : matchBgm(view, bgmRaw)
    const effect = normalizeScenarioEffectName(item.scenarioEffect ?? item.effect)
    const scenePlaceInfo = oneLine(item.placeInfo ?? item.place, 40)
    const sceneTelop = oneLine(item.telop, 40)
    const sceneSummary = oneLine(item.summary ?? item.description, 160) || outline[index] || ''
    const sceneBgHint = [scenePlaceInfo, sceneTelop, sceneSummary, planBgHint]
      .filter(Boolean)
      .join(' ')
    scenes.push({
      id: str(item.id).trim() || `s${index + 1}`,
      summary: sceneSummary,
      background: normalizeBackground(
        view,
        item.background ?? item.image ?? defaultBg,
        sceneBgHint
      ),
      ambient: normalizeAmbient(item.ambient ?? item.timeOfDay),
      ...(sceneTelop ? { telop: sceneTelop } : {}),
      ...(scenePlaceInfo ? { placeInfo: scenePlaceInfo } : {}),
      transitionIn,
      ...(isFlashback ? { isFlashback: true } : {}),
      ...(isSekai ? { isSekai: true } : {}),
      activeCast:
        active.length > 0
          ? active.slice(0, 2)
          : cast.length === 2
            ? cast.map((c) => c.name)
            : fallbackActive,
      ...(bgm ? { bgm } : {}),
      ...(effect ? { scenarioEffect: effect } : {})
    })
  }

  if (scenes.length === 0) {
    scenes.push({
      id: 's1',
      summary: oneLine(doc.event || doc.logline || options.scene, 160),
      background: defaultBg,
      ambient: 'normal',
      transitionIn: 'black',
      activeCast:
        cast.length === 2
          ? cast.map((c) => c.name)
          : cast.slice(0, Math.min(2, cast.length)).map((c) => c.name)
    })
  }

  const parseStringList = (val: unknown, limit = 6): string[] =>
    Array.isArray(val)
      ? val
          .map((item) => oneLine(item, 140))
          .filter(Boolean)
          .slice(0, limit)
      : []

  let understanding: StagedPromptUnderstanding | undefined
  if (isRecord(doc.understanding)) {
    const u = doc.understanding
    const parsed: StagedPromptUnderstanding = {
      explicitRequests: parseStringList(u.explicitRequests),
      implicitSubtext: oneLine(u.implicitSubtext, 200),
      relationshipDynamic: oneLine(u.relationshipDynamic, 200),
      emotionalArc: oneLine(u.emotionalArc, 200),
      turningPoint: oneLine(u.turningPoint, 200),
      openingMotif: oneLine(u.openingMotif, 140),
      closingCallback: oneLine(u.closingCallback, 160),
      characterGoals: normalizeCharacterGoals(u.characterGoals),
      canonHooks: parseStringList(u.canonHooks),
      avoidList: parseStringList(u.avoidList)
    }
    if (
      parsed.explicitRequests.length > 0 ||
      parsed.implicitSubtext ||
      parsed.relationshipDynamic ||
      parsed.emotionalArc ||
      parsed.turningPoint ||
      parsed.openingMotif ||
      parsed.closingCallback ||
      (parsed.characterGoals?.length ?? 0) > 0 ||
      parsed.canonHooks.length > 0 ||
      parsed.avoidList.length > 0
    ) {
      understanding = parsed
    }
  }

  let rawPairwiseAddress: StagedPairwiseAddress[] | undefined
  if (Array.isArray(doc.pairwiseAddress)) {
    const list: StagedPairwiseAddress[] = []
    for (const item of doc.pairwiseAddress.slice(0, 12)) {
      if (!isRecord(item)) continue
      const from = oneLine(item.from, 24)
      const to = oneLine(item.to, 24)
      const zh = oneLine(item.zh ?? item.cn ?? item.address, 24)
      const ja = oneLine(item.ja ?? item.jp, 24)
      if (!from || !to || (!zh && !ja)) continue
      list.push({ from, to, zh: zh || to, ...(ja ? { ja } : {}) })
    }
    if (list.length > 0) rawPairwiseAddress = list
  }
  const planContext = [options.scene, str(doc.event), str(doc.logline), ...outline]
    .filter(Boolean)
    .join('\n')
  const planUnitHint = inferUnitFromText(planContext)
  const pairwiseAddress = mergePairwiseAddresses(
    options.personas,
    cast.map((c) => c.name),
    rawPairwiseAddress,
    {
      ...(planUnitHint ? { unitHint: planUnitHint } : {}),
      ...(planContext ? { contextText: planContext } : {})
    }
  )

  let retrievalQueries: StagedRetrievalQueries | undefined
  if (isRecord(doc.retrievalQueries)) {
    const rq = doc.retrievalQueries
    const plot = oneLine(rq.plot, 120)
    const voice = oneLine(rq.voice, 120)
    const worldview = oneLine(rq.worldview, 120)
    if (plot || voice || worldview) {
      retrievalQueries = {
        ...(plot ? { plot } : {}),
        ...(voice ? { voice } : {}),
        ...(worldview ? { worldview } : {})
      }
    }
  }

  return {
    title: titleOrDefault(doc.title, options.title ?? ''),
    event: oneLine(doc.event || doc.logline || options.scene, 300),
    logline: oneLine(doc.logline, 300),
    outline: outline.length > 0 ? outline : scenes.map((s) => s.summary).filter(Boolean),
    cast,
    background: scenes[0]?.background || defaultBg,
    scenes,
    ...(understanding ? { understanding } : {}),
    ...(pairwiseAddress ? { pairwiseAddress } : {}),
    ...(retrievalQueries ? { retrievalQueries } : {})
  }
}

/** 选角失败时的退路：优先匹配台词里点名的角色（按角色去重且优先正面模型），否则按目录顺序取前两名。 */
export function fallbackCastPlan(view: CatalogView, options: StagedPromptOptions): StagedCastPlan {
  const sorted = [...view.models].sort(
    (a, b) =>
      Number(isBackViewModel(a)) - Number(isBackViewModel(b)) ||
      Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)) ||
      a.id - b.id
  )
  const pool: CatalogModel[] = []
  const seenChar = new Set<string>()
  for (const model of sorted) {
    const key =
      typeof model.characterId === 'number'
        ? `char:${model.characterId}`
        : `name:${model.name.toLowerCase()}`
    if (seenChar.has(key)) continue
    seenChar.add(key)
    pool.push(model)
  }
  const mentioned = findMentionedPrimaryModels(options.scene, pool)
  const models =
    mentioned.length >= 2 ? mentioned.slice(0, 5) : pool.slice(0, Math.min(2, pool.length))
  const cast = models.map((model) => castMemberFor(view, model))
  const bg =
    view.pickScenicFallbackImage(`${options.scene} ${cast.map((c) => c.name).join(' ')}`) ||
    view.defaultImage()
  const fallbackUnitHint = inferUnitFromText(options.scene)
  const pairwiseAddress = mergePairwiseAddresses(
    options.personas,
    cast.map((c) => c.name),
    undefined,
    {
      ...(fallbackUnitHint ? { unitHint: fallbackUnitHint } : {}),
      ...(options.scene ? { contextText: options.scene } : {})
    }
  )
  return {
    title: options.title ?? '',
    event: oneLine(options.scene, 300),
    logline: '',
    outline: [],
    cast,
    background: bg,
    ...(pairwiseAddress ? { pairwiseAddress } : {}),
    scenes: [
      {
        id: 's1',
        summary: oneLine(options.scene, 160),
        background: bg,
        ambient: 'normal',
        transitionIn: 'black',
        activeCast: cast.slice(0, Math.min(2, cast.length)).map((c) => c.name)
      }
    ]
  }
}
