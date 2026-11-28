import { resolveRegisteredSeFile } from '../../resources/resourceCatalog'
import {
  detectSceneSekaiContext,
  guardSceneBgmSelection,
  isBgmAllowedInScene,
  type SceneContextInput
} from '../bgmGuard'
import { isInternalThoughtContent } from '../officialLinter'
import { formatBgmPromptLine, formatImagePromptLine, type CatalogView } from '../prompt'
import { CURATED_SCENARIO_EFFECTS, normalizeScenarioEffectName } from '../scenarioCues'
import {
  formatDialogueLineForPrompt,
  formatDirectingAnchorBlock,
  formatWorldviewCueBlock,
  isRecord,
  matchBgm,
  normalizeAmbient,
  normalizeBackground,
  normalizeTransitionKind,
  num,
  oneLine,
  resolveModel,
  str,
  toBool,
  unwrapRecord
} from './helpers'
import type {
  StagedCameraCue,
  StagedCastPlan,
  StagedDialogue,
  StagedDialogueLine,
  StagedMessages,
  StagedPromptOptions,
  StagedStaging,
  StagedStagingEvent,
  StagedStagingScene
} from './types'

// ---------------------------------------------------------------------------
// 第三段：舞台调度与运镜音效（directStaging）
// ---------------------------------------------------------------------------

function isStagingDramaticEpisode(
  scene: string,
  plan: StagedCastPlan,
  dialogue: StagedDialogue
): boolean {
  const planText = [
    scene,
    plan.event,
    plan.logline,
    plan.understanding?.turningPoint ?? '',
    ...(plan.outline ?? [])
  ].join('\n')
  const hasHighDramaKeyword =
    /对峙|争执|吵架|冲突|追逐|对决|battle|比试|决斗|崩溃|绝望|质问|爆发|冲刺|舞台高潮|演出高潮|动作|震撼|惊变|急转|跌落|撞/i.test(
      planText
    )
  let intenseLines = 0
  let shoutingOrShockLines = 0
  for (const line of dialogue.lines) {
    if (/！！|!!|？！|\?!/.test(line.content)) shoutingOrShockLines += 1
    if (
      /别走|住口|够了|闭嘴|别岔开话题|别开玩笑|对不起|求你|受不了|回不去|怎么可能|接招|上吧/.test(
        line.content
      )
    ) {
      intenseLines += 1
    }
  }
  return hasHighDramaKeyword || intenseLines >= 2 || shoutingOrShockLines >= 3
}

export function buildStagingPrompt(
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  options: StagedPromptOptions
): StagedMessages {
  const lineList = dialogue.lines
    .map(
      (line) =>
        `- ${line.id}${line.sceneId ? `[${line.sceneId}]` : ''} ${line.speaker}：${formatDialogueLineForPrompt(line.content)}`
    )
    .join('\n')

  const castList = plan.cast
    .map(
      (c) =>
        `- ${c.name}（modelId=${c.modelId}${c.isVirtualSinger ? ', 虚拟歌手' : ''}）：${c.role || '出场角色'}`
    )
    .join('\n')

  const plannedScenes = (plan.scenes ?? [])
    .map(
      (s) =>
        `- ${s.id}: ${s.summary} | bg=${s.background} | ambient=${s.ambient} | transitionIn=${s.transitionIn} | cast=${s.activeCast.join('、')}`
    )
    .join('\n')

  const stagingQuery = `${options.scene} ${plan.event} ${plan.cast.map((c) => c.name).join(' ')} ${dialogue.lines
    .slice(0, 12)
    .map((l) => l.content)
    .join(' ')}`
  const backgrounds = view
    .imagePromptChoices(64, stagingQuery)
    .map((detail) => formatImagePromptLine(detail))
    .join('\n')

  const plannedSceneContexts = (plan.scenes ?? []).map((ps) =>
    detectSceneSekaiContext(
      {
        isSekaiFlag: ps.isSekai,
        transitionIn: ps.transitionIn,
        background: ps.background,
        placeInfo: ps.placeInfo,
        telop: ps.telop,
        summary: ps.summary,
        promptText: `${options.scene} ${plan.event}`
      },
      view
    )
  )
  const primarySceneCtx =
    plannedSceneContexts[0] ??
    detectSceneSekaiContext(
      {
        background: plan.background,
        promptText: `${options.scene} ${plan.event}`
      },
      view
    )
  const effectiveSceneContexts =
    plannedSceneContexts.length > 0 ? plannedSceneContexts : [primarySceneCtx]
  const rawBgmChoices = view.bgmPromptChoices(36, stagingQuery)
  const filteredBgmChoices = rawBgmChoices.filter((d) =>
    effectiveSceneContexts.some((ctx) => isBgmAllowedInScene(d.file, ctx, d))
  )
  const bgmPool = filteredBgmChoices.length > 0 ? [...filteredBgmChoices] : [...rawBgmChoices]
  // 多幕剧情中若有分幕显式进入某 SEKAI（即使 stagingQuery 首段未写 SEKAI 词），补齐最多 4 首该分幕对应的 SEKAI 曲目供选择
  const sekaiContexts = effectiveSceneContexts.filter((ctx) => ctx.isSekai)
  if (sekaiContexts.length > 0) {
    const seenFiles = new Set(bgmPool.map((d) => d.file.toLowerCase()))
    let addedSekai = 0
    for (const detail of view.bgmDetailsList()) {
      if (addedSekai >= 4) break
      if (seenFiles.has(detail.file.toLowerCase())) continue
      if (
        sekaiContexts.some(
          (ctx) =>
            isBgmAllowedInScene(detail.file, ctx, detail) &&
            !isBgmAllowedInScene(
              detail.file,
              { isSekai: false, sekaiUnit: null, isSpecialEvent: false, reason: '' },
              detail
            )
        )
      ) {
        bgmPool.push(detail)
        seenFiles.add(detail.file.toLowerCase())
        addedSekai += 1
      }
    }
  }
  const bgms = bgmPool.map((d) => formatBgmPromptLine(d)).join('\n')

  const primarySafeBgms = bgmPool.filter((d) => isBgmAllowedInScene(d.file, primarySceneCtx, d))
  const exampleBgmPool = primarySafeBgms.length > 0 ? primarySafeBgms : view.bgmPromptChoices(10)
  const firstBgm = exampleBgmPool[0]?.file ?? ''
  const secondBgm = exampleBgmPool.find((b) => b.file !== firstBgm)?.file ?? ''
  const midLine = dialogue.lines[Math.floor(dialogue.lines.length * 0.45)]?.id ?? 'l1'
  const peakLine = dialogue.lines[Math.floor(dialogue.lines.length * 0.58)]?.id ?? midLine
  const lateLine = dialogue.lines[Math.floor(dialogue.lines.length * 0.72)]?.id ?? 'l1'
  const isDramaticEpisode = isStagingDramaticEpisode(options.scene, plan, dialogue)

  const firstSe = view.seDetailsList()[0]?.file ?? 'se00053_b.mp3'
  const example = {
    scenes: [
      {
        id: 's1',
        fromLineId: 'l1',
        background: plan.background || view.defaultImage() || 'bg_room.jpg',
        ambient: 'normal',
        transitionIn: 'black',
        activeCast: plan.cast.slice(0, Math.min(2, plan.cast.length)).map((c) => c.name),
        bgm: firstBgm || ''
      }
    ],
    events: [
      {
        lineId: midLine,
        pauseBefore: 1.0,
        stageGroup: {
          activeCast: [plan.cast[0]?.name ?? '']
        },
        ...(secondBgm ? { bgmCut: { action: 'play', file: secondBgm, fadeMs: 900 } } : {})
      },
      ...(isDramaticEpisode
        ? [
            {
              lineId: peakLine,
              camera: { kind: 'zoomIn', scale: 1.12, durationMs: 450 }
            }
          ]
        : []),
      {
        lineId: lateLine,
        se: { file: firstSe, timing: 'before' },
        ...(isDramaticEpisode ? { camera: { kind: 'zoomReset', durationMs: 450 } } : {}),
        silentReaction: { modelId: plan.cast[0]?.modelId ?? 1 }
      }
    ]
  }

  const presenceRule =
    plan.cast.length === 2
      ? '- **双人动态聚焦切镜（单人 Center <-> 双人 Left/Right，一律原地淡入淡出）**：本场 2 人，除开场双人同框（Left/Right）外，要善用 `events[].stageGroup` 进行干净的镜头聚焦切换——每当出现内心独白（`（……）`）、情绪转折/坦白单人重音句、或需要拉近倾听/压迫感时，**在第一句就用 `events[].stageGroup` 短暂切到单人 Center**（`activeCast: [角色名]`，先双人同时 `LayoutClear` 原地淡出，再 `LayoutAppear(Center)` 原地淡入，**严禁 `Move` 横向滑动**），并在 1~4 句后切回双人 Left/Right 同框（整场 35 句约安排 3~6 次单双人焦点切换）。同一时间地点连续对话只写 1 幕（s1），仅切换地点、跳过时段、切入回忆或出入 SEKAI 时再新开幕次。'
      : '- **多人动态分组与单人特写切镜（Normal 模式 <=2 人同台）**：本场 >=3 人，始终保持 `Normal` 模式（Left / Right 双人或单人 Center），积极利用 `events.stageGroup` 随着对话焦点在 1 人特写（Center）与 2 人同框（Left/Right）之间通过 `LayoutClear` + `LayoutAppear` 原地淡出淡入轮换（约 24~35 次入出场节奏），严禁 3 人以上同时挤在台上，也严禁横向滑动。同一时间地点无需硬拆幕次，仅切换地点/时段/回忆/SEKAI 时再新开幕。'

  return {
    system: [
      '你是 Project SEKAI 官方演出的舞台监督与摄影导演（directStaging）。',
      '台词已经定稿；你负责规划幕次转场（Telop/PlaceInfo/SideFade/Flashback/Sekai）、原地单双人切镜（stageGroup）、音效（PlaySe）、镜头/震动、虚拟歌手全息与 BGM 静音切停。',
      '只输出一个 JSON 对象，不要改写台词。',
      options.systemPrompt?.trim() ?? ''
    ]
      .filter(Boolean)
      .join('\n'),
    user: `## 本场与大纲
小事件：${plan.event || options.scene}
${formatDirectingAnchorBlock(plan)}
角色（共 ${plan.cast.length} 名）：
${castList}${formatWorldviewCueBlock(options.ragContext)}

${plannedScenes ? `## 一阶段分幕参考\n${plannedScenes}\n` : ''}## 定稿台词（仅引用 lineId）
${lineList}

## 可用背景（时段白天/黄昏/夜晚与情景一致）
${backgrounds || '（无）'}

## 可用 BGM（填 file/id，静音切停写 "silence"）
${bgms || '（无描述 BGM，可留空或用 silence）'}

## 可用官方音效 PlaySe（约每 40 句安排 2~4 次，按动作/环境语义选）
${view.seList(stagingQuery, 32)}

## 舞台与摄影规则
${presenceRule}
- **严禁滑动入出场与横向滑位**：所有 \`LayoutAppear\` / \`LayoutClear\` 必须原地渐变淡入淡出（\`from.side === to.side, offset: 0\`），禁止使用 \`walkInCast\` / \`walkOutCast\` / \`LeftOver\` / \`RightOver\` 画外滑入滑出，也禁止 \`Move\` 左右偏移滑行或从 Left/Right 滑到 Center。
- **克制镜头、震动与开场字幕条（严禁每场套模板）**：
  - 说话后需要角色沉默留白或低头反应时，设 \`silentReaction: { modelId }\`（无需强行把 \`closeWindowAfter: true\` 挂在紧接瞬时动作之前）；仅在停顿 \`Wait >= 300ms\` 或场景/幕次切换前才设置 \`closeWindowAfter: true\`。
  - **镜头（\`events[].camera\`）与震动（\`events[].characterShake\`）按剧情强弱分化（严禁平均摊派）**：
    - **日常谈心 / 后台会议 / 轻喜剧 / 温柔回忆**：保持 **0 次镜头推拉、0 次震动**（不要加 \`camera\` 或 \`characterShake\`）。
    - **激烈对峙 / 情绪崩溃 / 街头 Battle / 天台追逐或舞台高潮**：**务必**在转折或爆发峰值 1~2 句上精准安排运镜与震动，并于 1~3 句后复位：
      - 推进/横摇/复位：\`camera: { kind: "zoomIn", scale: 1.12, durationMs: 450 }\`、\`camera: { kind: "pan", x: 50, y: 0, durationMs: 500 }\`、\`camera: { kind: "zoomReset", durationMs: 450 }\`
      - 爆发/冲击震动：\`camera: { kind: "shakeScreen" | "shakeWindow", durationMs: 420 }\` 或碰撞惊吓 \`characterShake: { modelId: <id>, axis: "X" }\`（全场至多 1~2 次，绝不用于普通对话）。
    - ${
      isDramaticEpisode
        ? '**本场判定为冲突/动作高潮场**：请在最关键的 1~2 个峰值句安排 `camera`（如 `zoomIn` + 1~3 句后 `zoomReset`，或 `pan`），必要时配 1 次 `shakeScreen` / `characterShake`，不要全片 `0/0`。'
        : '**本场判定为日常/温和对话场**：请保持克制，`events` 中不要添加 `camera` 推拉或 `shake` 震动（保持 0/0）。'
    }
  - **开场 Telop / PlaceInfo 按需选用**：仅在时间/地点需要明确交代或跳幕时才写 \`telop\` / \`placeInfo\`，安静延续或私密谈心可直接入戏，不必每场千篇一律加 \`Telop + PlaceInfo\`。
  - 虚拟歌手在现实场景现身或远程通话时，在 \`hologramCast\` 或 \`hologram: { modelId, enabled: true }\` 启用 \`hologram\` 着色器。
- **特效与转场**：跳时间/换场地优先善用 \`SideFade\`（\`transitionIn: "sideFade"\`），回忆段务必配 \`transitionIn: "flashback"\`, \`isFlashback: true\`（自动接 \`WhiteOut -> se00053_b -> FlashbackIn -> WhiteIn\`），时段/氛围变化用 \`ambient\`（\`normal\`/\`evening\`/\`night\`），出入 SEKAI 用 \`sekaiIn\`/\`sekaiOut\`，天候粒子用（${CURATED_SCENARIO_EFFECTS.join('/')}）。
- **BGM 与停顿节奏**：首幕（s1）必须从可用 BGM 清单选定契合开场氛围的曲目（例如追逐/对峙/低落选戏剧或沉重曲，日常/喜剧选轻快日常曲）；若刻意做冷开场，最多留 2~4 句静音并在第 5 句（l5）前用 \`bgmCut\` 切入 BGM，**严禁前段大段无声**。大部分台词 \`delay: 0\`，只把 1.0/1.5 秒停顿放在关键沉默句的 \`pauseBefore\`。中后段转折前可将幕次 \`bgm\` 或 \`bgmCut\` 设为 \`silence\`（\`bgm00000\` 静音），留白 2~4 句后再接入第二首 BGM。
- **严禁跨世界线误用 SEKAI 专属 BGM**：标注「仅限对应SEKAI场景 / 仅限SEKAI内使用 / SEKAI主题 / SEKAI氛围」的曲目（如无人「世界」主题曲 \`bgm_area00005\`/\`nightcode_untitled*\`、教室/舞台/街头/奇幻乐园「世界」主题曲 \`bgm_area00001..00004\`/\`*_untitled*\` 等）**绝对禁止**用于任何现实世界场景（卧室、客厅、家庭餐厅、教室、天台、涩谷街头、Nightcord 语音连线等）；进入某组合 SEKAI 时也只能选用该组合对应的 SEKAI 主题曲或通用 SEKAI 曲，严禁混用其他组合的 SEKAI 主题曲。
- **对齐 Stage 1 转折点**：把 BGM 静音切停、1.0/1.5 秒停顿、镜头推近/震动与 Move 峰值优先安排在转折点前后 1~3 句；开场意象句给一个安静的停顿或特写，收尾回扣句不要加大动作。

## 输出 JSON
${JSON.stringify(example, null, 2)}

只输出 JSON 对象本身，不要 markdown 或解释。`
  }
}

function resolveLineIndex(value: unknown, lines: StagedDialogueLine[]): number {
  const text = str(value).trim()
  if (!text) return -1
  const exact = lines.findIndex((l) => l.id === text)
  if (exact >= 0) return exact
  const match = /^l?(\d+)$/i.exec(text)
  if (match) {
    const idx = Number(match[1]) - 1
    if (idx >= 0 && idx < lines.length) return idx
  }
  return -1
}

function resolveCastIds(rawList: unknown, plan: StagedCastPlan, view: CatalogView): number[] {
  const arr = Array.isArray(rawList) ? rawList : []
  const ids: number[] = []
  for (const item of arr) {
    const byPlan = plan.cast.find(
      (c) =>
        c.name === str(item).trim() ||
        c.fullName === str(item).trim() ||
        String(c.modelId) === str(item).trim()
    )
    if (byPlan) {
      if (!ids.includes(byPlan.modelId)) ids.push(byPlan.modelId)
      continue
    }
    const model = resolveModel(view, [], item)
    if (model && plan.cast.some((c) => c.modelId === model.id) && !ids.includes(model.id)) {
      ids.push(model.id)
    }
  }
  return ids.slice(0, 2)
}

function inferSceneStartsFromDialogue(
  plan: StagedCastPlan,
  dialogue: StagedDialogue
): Map<string, number> {
  const map = new Map<string, number>()
  for (let i = 0; i < dialogue.lines.length; i++) {
    const sid = dialogue.lines[i].sceneId
    if (sid && !map.has(sid)) map.set(sid, i)
  }
  const planned = plan.scenes ?? []
  if (planned.length > 1 && map.size <= 1) {
    const step = Math.floor(dialogue.lines.length / planned.length)
    planned.forEach((s, idx) => {
      map.set(s.id, idx === 0 ? 0 : Math.min(dialogue.lines.length - 1, idx * step))
    })
  }
  return map
}

export function fallbackStaging(
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue
): StagedStaging {
  const lines = dialogue.lines
  const scenes: StagedStagingScene[] = []
  const starts = inferSceneStartsFromDialogue(plan, dialogue)
  const plannedScenes =
    plan.scenes && plan.scenes.length > 0
      ? plan.scenes
      : [
          {
            id: 's1',
            summary: plan.event,
            background: plan.background || view.defaultImage(),
            ambient: 'normal' as const,
            transitionIn: 'black' as const,
            activeCast: plan.cast.slice(0, Math.min(2, plan.cast.length)).map((c) => c.name)
          }
        ]

  for (let idx = 0; idx < plannedScenes.length; idx++) {
    const ps = plannedScenes[idx]
    const fromIndex =
      idx === 0
        ? 0
        : (starts.get(ps.id) ??
          Math.min(lines.length - 1, Math.floor((lines.length * idx) / plannedScenes.length)))
    if (idx > 0 && (fromIndex <= scenes[scenes.length - 1].fromIndex || fromIndex >= lines.length))
      continue
    let activeCast = resolveCastIds(ps.activeCast, plan, view)
    if (activeCast.length === 0) {
      activeCast = plan.cast.slice(0, Math.min(2, plan.cast.length)).map((c) => c.modelId)
    }
    const bgDetail = view.canonicalImageEntry(ps.background)
    const ambient =
      bgDetail?.timeOfDay === '白天' && ps.ambient === 'evening' && !ps.isFlashback
        ? 'normal'
        : ps.ambient
    scenes.push({
      id: ps.id,
      fromLineId: lines[fromIndex]?.id ?? 'l1',
      fromIndex,
      background: normalizeBackground(view, ps.background),
      ambient,
      ...(ps.telop ? { telop: ps.telop } : {}),
      ...(ps.placeInfo ? { placeInfo: ps.placeInfo } : {}),
      transitionIn: ps.transitionIn,
      ...(ps.isFlashback ? { isFlashback: true } : {}),
      ...(ps.isSekai ? { isSekai: true } : {}),
      activeCast,
      ...(ps.bgm ? { bgm: ps.bgm } : {}),
      ...(ps.scenarioEffect ? { scenarioEffect: ps.scenarioEffect } : {})
    })
  }

  return enrichStagingBaseline({ scenes, events: [] }, view, plan, dialogue)
}

export function pickOpeningBgmForScene(
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue,
  sceneSummary = '',
  sceneContextInput?: SceneContextInput
): string {
  const queryParts = [
    plan.event,
    plan.logline,
    plan.understanding?.emotionalArc ?? '',
    sceneSummary,
    ...dialogue.lines.slice(0, 12).map((l) => `${l.emotion ?? ''} ${l.content}`)
  ].filter(Boolean)
  const query = queryParts.join(' ')
  const sceneCtx = detectSceneSekaiContext(
    sceneContextInput ?? {
      isSekaiFlag: plan.scenes?.[0]?.isSekai,
      transitionIn: plan.scenes?.[0]?.transitionIn,
      background: plan.scenes?.[0]?.background || plan.background,
      placeInfo: plan.scenes?.[0]?.placeInfo,
      telop: plan.scenes?.[0]?.telop,
      summary: sceneSummary || plan.scenes?.[0]?.summary,
      promptText: `${plan.event} ${plan.logline}`,
      dialogueText: dialogue.lines
        .slice(0, 12)
        .map((l) => l.content)
        .join(' ')
    },
    view
  )
  const choices = view
    .bgmPromptChoices(36, query)
    .filter((item) => isBgmAllowedInScene(item.file, sceneCtx, item))
  const allSafeDescribed = view
    .bgmDetailsList()
    .filter(
      (detail) =>
        (detail.description ?? '').trim().length > 0 &&
        isBgmAllowedInScene(detail.file, sceneCtx, detail)
    )
  const pool =
    choices.length > 0
      ? choices
      : allSafeDescribed.length > 0
        ? allSafeDescribed
        : view
            .bgmDetailsList()
            .filter((detail) => isBgmAllowedInScene(detail.file, sceneCtx, detail))
  if (pool.length === 0) return ''

  const openingEmos = dialogue.lines.slice(0, 12).map((l) => (l.emotion ?? '').trim())
  const tenseCue =
    openingEmos.some((e) => e === '伤心' || e === '生气' || e === '害怕') ||
    /追|逃|对峙|冲突|吵|哭|泪|道歉|告别|压抑|低沉|沉重|紧张|不安|严肃|秘密|隐瞒|害怕|悬疑|暗涌|夜晚|深夜|暴雨|雨/.test(
      query
    )
  const warmCue =
    !tenseCue &&
    (openingEmos.some((e) => e === '开心') ||
      /日常|轻松|温馨|闲聊|笑|搞笑|玩笑|派对|排练|零食|下午茶|阳光|早安|开心|欢快/.test(query))

  let best = pool[0]
  let bestScore = -Infinity
  for (let idx = 0; idx < pool.length; idx++) {
    const item = pool[idx]
    const hay =
      `${item.file} ${item.name} ${item.mood ?? ''} ${item.category ?? ''} ${item.description} ${(item.tags ?? []).join(' ')}`.toLowerCase()
    let score = -idx * 0.01
    if (tenseCue) {
      if (
        /低沉|克制|压抑|悲伤|感伤|忧郁|紧绷|紧张|紧迫|暗涌|悬疑|冲突|告[白别]|沉重|严肃|dramatic|tense|sad|melanchol|thorns/i.test(
          hay
        )
      ) {
        score += 20
      }
      if (/日常|闲聊|温馨|轻松|欢快|搞笑|喜剧|轻缓|居家/i.test(hay)) {
        score -= 10
      }
    } else if (warmCue) {
      if (/轻松|日常|温暖|温馨|欢快|元气|活泼|轻缓|居家|搞笑|slapstick/i.test(hay)) {
        score += 20
      }
      if (/压抑|低沉|悲伤|紧绷|冲突|告别/i.test(hay)) {
        score -= 10
      }
    } else {
      if (/轻松|日常|轻缓|温暖|平稳|宁静/i.test(hay)) {
        score += 8
      }
    }
    if (score > bestScore) {
      bestScore = score
      best = item
    }
  }
  return best.file
}

function enrichStagingBaseline(
  staging: StagedStaging,
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue
): StagedStaging {
  const lines = dialogue.lines
  if (lines.length === 0) return staging

  const eventsByLine = new Map<number, StagedStagingEvent>()
  for (const ev of staging.events) {
    eventsByLine.set(ev.lineIndex, ev)
  }

  const sceneContextAt = (sceneIndex: number): SceneContextInput => {
    const scene = staging.scenes[sceneIndex]
    const nextFrom =
      sceneIndex + 1 < staging.scenes.length
        ? staging.scenes[sceneIndex + 1].fromIndex
        : lines.length
    const sceneDialogue = lines
      .slice(scene.fromIndex, Math.min(nextFrom, scene.fromIndex + 12))
      .map((l) => l.content)
      .join(' ')
    const plannedScene = plan.scenes?.find((ps) => ps.id === scene.id) ?? plan.scenes?.[sceneIndex]
    return {
      isSekaiFlag: scene.isSekai,
      transitionIn: scene.transitionIn,
      background: scene.background,
      placeInfo: scene.placeInfo,
      telop: scene.telop,
      summary: plannedScene?.summary ?? '',
      promptText: `${plan.event} ${plan.logline}`,
      dialogueText: sceneDialogue
    }
  }

  const usedSafeBgms = new Set<string>()
  // 确定性 SEKAI BGM 守卫：逐幕校验 scene.bgm 与 events[].bgmCut，严禁 SEKAI 专属曲泄漏到现实场景或跨团串台
  for (let sIdx = 0; sIdx < staging.scenes.length; sIdx++) {
    const scene = staging.scenes[sIdx]
    if (scene.bgm && scene.bgm !== 'silence' && scene.bgm !== 'keep') {
      const decision = guardSceneBgmSelection(view, scene.bgm, sceneContextAt(sIdx), {
        excludeFiles: usedSafeBgms
      })
      if (decision.replaced) {
        scene.bgm = decision.finalFile || undefined
      }
      if (decision.finalFile && decision.finalFile !== 'silence' && decision.finalFile !== 'keep') {
        usedSafeBgms.add(decision.finalFile)
      }
    }
  }
  for (const ev of staging.events) {
    if (ev.bgmCut?.action !== 'play' || !ev.bgmCut.file) continue
    let ownerIdx = 0
    for (let sIdx = 0; sIdx < staging.scenes.length; sIdx++) {
      if (staging.scenes[sIdx].fromIndex <= ev.lineIndex) ownerIdx = sIdx
      else break
    }
    const decision = guardSceneBgmSelection(view, ev.bgmCut.file, sceneContextAt(ownerIdx), {
      excludeFiles: usedSafeBgms
    })
    if (decision.replaced) {
      if (decision.finalFile) {
        ev.bgmCut.file = decision.finalFile
      } else {
        delete ev.bgmCut
      }
    }
    if (decision.finalFile) usedSafeBgms.add(decision.finalFile)
  }

  // 开场首幕 BGM 兜底：长场次禁止因 scene0.bgm 留空或无效 silence 导致前几分钟全程无声；
  // 仅当刻意冷开场并在第 5 句（index <= 5）前显式切入 BGM 时才允许 scene0 静音开场。
  if (lines.length >= 6 && staging.scenes.length > 0) {
    const scene0 = staging.scenes[0]
    const hasEarlyBgmPlay =
      staging.events.some(
        (ev) => ev.lineIndex <= 5 && ev.bgmCut?.action === 'play' && Boolean(ev.bgmCut.file)
      ) ||
      staging.scenes
        .slice(1)
        .some((s) => s.fromIndex <= 5 && Boolean(s.bgm) && s.bgm !== 'silence' && s.bgm !== 'keep')
    const missingOrLongSilence =
      !scene0.bgm || scene0.bgm === 'keep' || (scene0.bgm === 'silence' && !hasEarlyBgmPlay)
    if (missingOrLongSilence) {
      const openingBgm = pickOpeningBgmForScene(
        view,
        plan,
        dialogue,
        plan.scenes?.[0]?.summary ?? '',
        sceneContextAt(0)
      )
      if (openingBgm) {
        scene0.bgm = openingBgm
      }
    }
  }

  const ensureEvent = (lineIndex: number): StagedStagingEvent => {
    const existing = eventsByLine.get(lineIndex)
    if (existing) return existing
    const created: StagedStagingEvent = {
      lineId: lines[lineIndex].id,
      lineIndex
    }
    eventsByLine.set(lineIndex, created)
    return created
  }

  // 对话自带的 pauseBefore / closeWindowAfter 合入 events
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.pauseBefore || line.closeWindowAfter) {
      const ev = ensureEvent(i)
      if (line.pauseBefore && !ev.pauseBefore) ev.pauseBefore = line.pauseBefore
      if (line.closeWindowAfter && !ev.closeWindowAfter) ev.closeWindowAfter = true
    }
  }

  // 思考/内心独白切镜对齐：绝不在第一句独白仍站在 Left/Right，到第二句才切 Center
  if (plan.cast.length >= 2) {
    const isThinkingLine = (line: StagedDialogueLine): boolean =>
      line.windowDisplayMode === 'Thinking' ||
      line.effect === 'Internal' ||
      isInternalThoughtContent(line.content)
    const isExplicitThinking = (line: StagedDialogueLine): boolean =>
      line.windowDisplayMode === 'Thinking' || line.effect === 'Internal'

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!isThinkingLine(line)) continue
      const speakerMember = plan.cast.find((c) => c.name === line.speaker)
      if (!speakerMember) continue
      const evCurr = eventsByLine.get(i)
      // 若第二句独白才有 stageGroup=[speaker]，提前到第一句独白
      if (!evCurr?.stageGroup && i + 1 < lines.length) {
        const nextLine = lines[i + 1]
        const evNext = eventsByLine.get(i + 1)
        if (
          nextLine.speaker === line.speaker &&
          isThinkingLine(nextLine) &&
          evNext?.stageGroup?.activeCast.length === 1 &&
          evNext.stageGroup.activeCast[0] === speakerMember.modelId
        ) {
          ensureEvent(i).stageGroup = { ...evNext.stageGroup }
          delete evNext.stageGroup
        }
      }
      // 显式 Thinking/Internal 或 >=2 句同人连续括号内心独白（无 stageGroup）时自动切到 Center，并在独白结束恢复双人
      let runEnd = i
      while (
        runEnd + 1 < lines.length &&
        lines[runEnd + 1].speaker === line.speaker &&
        isThinkingLine(lines[runEnd + 1])
      ) {
        runEnd += 1
      }
      const hasGroupInRun = Array.from(
        { length: runEnd - i + 1 },
        (_, off) => eventsByLine.get(i + off)?.stageGroup
      ).some(Boolean)
      if (!hasGroupInRun && (isExplicitThinking(line) || runEnd > i)) {
        ensureEvent(i).stageGroup = { activeCast: [speakerMember.modelId] }
      }
      i = runEnd
    }
  }

  // 确保每一幕起手阵容覆盖本幕开场前两名说话人（Normal 模式严格 <=2 人）
  if (plan.cast.length >= 3) {
    for (let sIdx = 0; sIdx < staging.scenes.length; sIdx++) {
      const scene = staging.scenes[sIdx]
      const endIndex =
        sIdx + 1 < staging.scenes.length ? staging.scenes[sIdx + 1].fromIndex - 1 : lines.length - 1
      const speakersInScene: number[] = []
      for (let i = scene.fromIndex; i <= endIndex; i++) {
        const m = plan.cast.find((c) => c.name === lines[i].speaker)
        if (m && !speakersInScene.includes(m.modelId)) speakersInScene.push(m.modelId)
      }
      const merged = scene.activeCast.slice(0, 2)
      for (const sid of speakersInScene.slice(0, 2)) {
        if (!merged.includes(sid) && merged.length < 2) merged.push(sid)
      }
      const sceneSpeakers = new Set(speakersInScene.slice(0, 2))
      for (const sid of speakersInScene.slice(0, 2)) {
        if (merged.includes(sid)) continue
        const replaceIdx = merged.findIndex((id) => !sceneSpeakers.has(id))
        if (replaceIdx >= 0) merged[replaceIdx] = sid
      }
      scene.activeCast = merged.slice(0, 2)
    }
  }

  // 长篇剧本（>=16句）若模型未出 SE，按台词语义轻度补齐（严禁自动注入 Move 横向滑动）
  if (lines.length >= 16) {
    const seCount = [...eventsByLine.values()].filter((e) => e.se).length
    if (seCount === 0) {
      const seHits: Array<{ idx: number; file: string }> = []
      for (let i = 0; i < lines.length && seHits.length < 3; i++) {
        const text = lines[i].content
        let cue: string | null = null
        if (/手机|消息|通知|短信/.test(text)) cue = 'se00004_b.mp3'
        else if (/开门|推门|进门|进来/.test(text)) cue = 'se00043_b.mp3'
        else if (/乐谱|速写本|笔记本|纸|日程|翻/.test(text)) cue = 'se00122_b.mp3'
        else if (/bell|上课|下课|铃声/.test(text)) cue = 'se00249_b.mp3'
        else if (/Nightcord|上线|通话|麦/.test(text)) cue = 'se00084_b.mp3'
        else if (/拍照|快门/.test(text)) cue = 'se00075_b.mp3'
        const resolved = cue ? (resolveRegisteredSeFile(view, cue)?.file ?? null) : null
        if (resolved && !seHits.some((h) => Math.abs(h.idx - i) < 6)) {
          seHits.push({ idx: i, file: resolved })
        }
      }
      for (const hit of seHits) {
        const ev = ensureEvent(hit.idx)
        ev.se = { file: hit.file, volume: 0.9, timing: 'before' }
      }
    }
  }

  return {
    scenes: staging.scenes,
    events: [...eventsByLine.values()].sort((a, b) => a.lineIndex - b.lineIndex)
  }
}

export function normalizeStaging(
  raw: unknown,
  view: CatalogView,
  plan: StagedCastPlan,
  dialogue: StagedDialogue
): StagedStaging {
  const doc = unwrapRecord(raw, ['staging', 'storyboard', 'story', 'plan'])
  if (!isRecord(doc)) return fallbackStaging(view, plan, dialogue)

  const lines = dialogue.lines
  if (lines.length === 0) return { scenes: [], events: [] }

  const rawScenes = Array.isArray(doc.scenes) ? doc.scenes : []
  const scenes: StagedStagingScene[] = []
  const usedStarts = new Set<number>()

  for (let i = 0; i < rawScenes.slice(0, 4).length; i++) {
    const item = rawScenes[i]
    if (!isRecord(item)) continue
    const idx = i === 0 ? 0 : resolveLineIndex(item.fromLineId ?? item.from ?? item.lineId, lines)
    if (idx < 0 || usedStarts.has(idx)) continue
    usedStarts.add(idx)
    let activeCast = resolveCastIds(item.activeCast ?? item.cast, plan, view)
    if (activeCast.length === 0) {
      activeCast = plan.cast.slice(0, Math.min(2, plan.cast.length)).map((c) => c.modelId)
    }
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
    const hologramCast = resolveCastIds(item.hologramCast, plan, view)
    const effect = normalizeScenarioEffectName(item.scenarioEffect ?? item.effect)

    const bg = normalizeBackground(view, item.background ?? item.image ?? plan.background)
    const bgDetail = view.canonicalImageEntry(bg)
    let ambient = normalizeAmbient(item.ambient ?? item.timeOfDay)
    if (bgDetail?.timeOfDay === '白天' && ambient === 'evening' && !isFlashback) {
      ambient = 'normal'
    }
    scenes.push({
      id: str(item.id).trim() || `s${scenes.length + 1}`,
      fromLineId: lines[idx].id,
      fromIndex: idx,
      background: bg,
      ambient,
      ...(oneLine(item.telop, 40) ? { telop: oneLine(item.telop, 40) } : {}),
      ...(oneLine(item.placeInfo ?? item.place, 40)
        ? { placeInfo: oneLine(item.placeInfo ?? item.place, 40) }
        : {}),
      transitionIn,
      ...(isFlashback ? { isFlashback: true } : {}),
      ...(isSekai ? { isSekai: true } : {}),
      activeCast,
      ...(hologramCast.length > 0 ? { hologramCast } : {}),
      ...(bgm ? { bgm } : {}),
      ...(effect ? { scenarioEffect: effect } : {})
    })
  }
  scenes.sort((a, b) => a.fromIndex - b.fromIndex)
  if (scenes.length === 0 || scenes[0].fromIndex !== 0) {
    const fb = fallbackStaging(view, plan, dialogue)
    if (scenes.length === 0) return fb
    scenes.unshift(fb.scenes[0])
  }

  const rawEvents = Array.isArray(doc.events) ? doc.events : []
  const events: StagedStagingEvent[] = []
  for (const item of rawEvents) {
    if (!isRecord(item)) continue
    const idx = resolveLineIndex(item.lineId ?? item.id ?? item.line, lines)
    if (idx < 0) continue

    const ev: StagedStagingEvent = {
      lineId: lines[idx].id,
      lineIndex: idx
    }

    const pauseRaw = num(item.pauseBefore, 0)
    if (pauseRaw >= 0.4) {
      ev.pauseBefore = pauseRaw >= 1.25 ? 1.5 : pauseRaw >= 0.75 ? 1.0 : 0.5
    }
    if (toBool(item.closeWindowAfter)) ev.closeWindowAfter = true

    if (isRecord(item.silentReaction)) {
      const m = resolveModel(view, [], item.silentReaction.modelId ?? item.silentReaction.speaker)
      if (m && plan.cast.some((c) => c.modelId === m.id)) {
        const motion =
          view.canonicalAnimation(m.id, 'motion', item.silentReaction.motion) ?? undefined
        const facial =
          view.canonicalAnimation(m.id, 'facial', item.silentReaction.facial) ?? undefined
        ev.silentReaction = {
          modelId: m.id,
          ...(motion ? { motion } : {}),
          ...(facial ? { facial } : {})
        }
      }
    }

    if (isRecord(item.move)) {
      const m = resolveModel(view, [], item.move.modelId ?? item.move.speaker ?? lines[idx].speaker)
      if (m && plan.cast.some((c) => c.modelId === m.id)) {
        const toSideRaw = str(item.move.toSide)
        const toSide =
          toSideRaw === 'Left' || toSideRaw === 'Center' || toSideRaw === 'Right'
            ? toSideRaw
            : undefined
        if (toSide && !isRecord(item.stageGroup)) {
          // 若模型仍写了 shiftSlot 到 Center，转为 stageGroup 原地渐变切镜，禁止 Move 滑动
          if (toSide === 'Center') {
            ev.stageGroup = { activeCast: [m.id] }
          }
        }
      }
    }

    if (isRecord(item.characterShake)) {
      const m = resolveModel(view, [], item.characterShake.modelId ?? item.characterShake.speaker)
      if (m && plan.cast.some((c) => c.modelId === m.id)) {
        ev.characterShake = {
          modelId: m.id,
          axis: str(item.characterShake.axis).toUpperCase() === 'Y' ? 'Y' : 'X'
        }
      }
    }

    if (isRecord(item.hologram)) {
      const m = resolveModel(view, [], item.hologram.modelId ?? item.hologram.speaker)
      if (m && plan.cast.some((c) => c.modelId === m.id)) {
        ev.hologram = { modelId: m.id, enabled: toBool(item.hologram.enabled) }
      }
    }

    if (isRecord(item.camera)) {
      const k = str(item.camera.kind)
      if (['zoomIn', 'zoomReset', 'pan', 'shakeWindow', 'shakeScreen'].includes(k)) {
        ev.camera = {
          kind: k as StagedCameraCue['kind'],
          ...(item.camera.x !== undefined ? { x: num(item.camera.x, 0) } : {}),
          ...(item.camera.y !== undefined ? { y: num(item.camera.y, 0) } : {}),
          ...(item.camera.scale !== undefined
            ? { scale: Math.min(2, Math.max(0.8, num(item.camera.scale, 1.1))) }
            : {}),
          ...(item.camera.durationMs !== undefined
            ? { durationMs: Math.min(2000, Math.max(100, num(item.camera.durationMs, 450))) }
            : {})
        }
      }
    }

    if (isRecord(item.se) || typeof item.se === 'string') {
      const rawSe = isRecord(item.se) ? (item.se.file ?? item.se.cue ?? item.se.id) : item.se
      const file = resolveRegisteredSeFile(view, rawSe)?.file ?? null
      if (file) {
        ev.se = {
          file,
          volume: isRecord(item.se) ? Math.min(2, Math.max(0.2, num(item.se.volume, 0.9))) : 0.9,
          timing: isRecord(item.se) && item.se.timing === 'during' ? 'during' : 'before',
          ...(isRecord(item.se) && item.se.delay !== undefined
            ? { delay: Math.max(0, num(item.se.delay, 0)) }
            : {})
        }
      }
    }

    if (isRecord(item.bgmCut)) {
      const action = str(item.bgmCut.action).toLowerCase() === 'stop' ? 'stop' : 'play'
      if (action === 'stop') {
        ev.bgmCut = {
          action: 'stop',
          fadeMs: Math.min(3000, Math.max(100, num(item.bgmCut.fadeMs, 600)))
        }
      } else {
        const bgmFile = matchBgm(view, item.bgmCut.file)
        if (bgmFile && bgmFile !== 'silence') {
          ev.bgmCut = {
            action: 'play',
            file: bgmFile,
            fadeMs: Math.min(3000, Math.max(100, num(item.bgmCut.fadeMs, 800)))
          }
        }
      }
    }

    if (plan.cast.length >= 2 && isRecord(item.stageGroup)) {
      const activeCast = resolveCastIds(
        item.stageGroup.activeCast ?? item.stageGroup.cast,
        plan,
        view
      )
      if (activeCast.length > 0) {
        ev.stageGroup = {
          activeCast
        }
      }
    }

    if (
      ev.pauseBefore ||
      ev.closeWindowAfter ||
      ev.silentReaction ||
      ev.move ||
      ev.characterShake ||
      ev.hologram ||
      ev.camera ||
      ev.se ||
      ev.bgmCut ||
      ev.stageGroup
    ) {
      events.push(ev)
    }
  }

  return enrichStagingBaseline({ scenes, events }, view, plan, dialogue)
}
