import { actingPersonaPrompt, inferUnitFromText, normalizePjskTerminology } from '../personas'
import type { CatalogView } from '../prompt'
import { normalizeDialogueLineBreaks } from '../validate'
import {
  formatDialogueLineForPrompt,
  formatPairwiseAddressBlock,
  isRecord,
  mergePairwiseAddresses,
  num,
  resolveMemberPersona,
  str
} from './helpers'
import type {
  StagedCastPlan,
  StagedDirectorReviewHints,
  StagedDirectorReviewPatch,
  StagedDirectorReviewResult,
  StagedMessages,
  StagedPromptOptions
} from './types'

/**
 * 为 staged / 统一流水线合成后的成稿构造紧凑的【导演终审】提示词：
 * 传入压缩后的片段时间线、统计摘要与局部问题句演技推荐（onlyIssues），让模型以导演身份审视并输出少量精准外科修补（绝不破坏 ttsText）。
 */
export function buildDirectorReviewPrompt(
  view: CatalogView,
  plan: StagedCastPlan,
  story: { models: Array<{ id: number }>; snippets: Array<Record<string, unknown>> },
  options: StagedPromptOptions,
  reviewHints?: StagedDirectorReviewHints
): StagedMessages {
  const snippets = story.snippets
  let talkCount = 0
  let playSeCount = 0
  let bgmCount = 0
  let standaloneMotionCount = 0
  let moveCount = 0
  let waitCount = 0

  const compactTimeline: string[] = []
  for (let i = 0; i < snippets.length; i++) {
    const s = snippets[i]
    const kind = str(s.type)
    const d = isRecord(s.data) ? s.data : {}
    if (kind === 'PlaySe') {
      playSeCount += 1
      compactTimeline.push(`[${i}] PlaySe(${str(d.file)})`)
    } else if (kind === 'ChangeBgm') {
      bgmCount += 1
      compactTimeline.push(
        `[${i}] ChangeBgm(${d.stop === true ? 'STOP' : str(d.file)}, fade=${num(d.fadeMs, 600)})`
      )
    } else if (kind === 'Motion') {
      standaloneMotionCount += 1
      compactTimeline.push(
        `[${i}] Motion(m=${num(d.modelId, -1)}, ${str(d.motion)}/${str(d.facial)})`
      )
    } else if (kind === 'Move') {
      moveCount += 1
      const to = isRecord(d.to) ? d.to : {}
      compactTimeline.push(
        `[${i}] Move(m=${num(d.modelId, -1)}->${str(to.side)}, ${str(d.motion)}/${str(d.facial)})`
      )
    } else if (kind === 'Wait') {
      waitCount += 1
      compactTimeline.push(`[${i}] Wait(${num(d.duration, 500)}ms)`)
    } else if (kind === 'Talk') {
      talkCount += 1
      const acts = Array.isArray(d.actions)
        ? (d.actions as Array<Record<string, unknown>>)
            .map(
              (a) =>
                `m${num(a.modelId, -1)}:${str(a.motion)}/${str(a.facial)}${num(a.at, 0) > 0 ? `@${num(a.at, 0)}` : ''}`
            )
            .join(',')
        : ''
      const text = formatDialogueLineForPrompt(str(d.content)).slice(0, 46).replace(/\\$/, '')
      const emo = str(d.emotion)
      const delayTag = num(s.delay, 0) > 0 ? ` delay=${num(s.delay, 0)}` : ''
      compactTimeline.push(
        `[${i}] Talk(${str(d.speaker)}${emo ? `/${emo}` : ''}${delayTag}): ${text}${acts ? ` | ${acts}` : ''}`
      )
    } else if (
      kind === 'LayoutAppear' ||
      kind === 'LayoutClear' ||
      kind === 'BlackOut' ||
      kind === 'BlackIn' ||
      kind === 'AmbientColor' ||
      kind === 'ShakeScreen' ||
      kind === 'CameraZoom'
    ) {
      compactTimeline.push(`[${i}] ${kind}`)
    }
  }

  const seChoices = view.seList(options.scene, 14)
  const reviewContextText = `${options.scene}\n${plan.event}\n${plan.logline}`
  const castMotionHints = plan.cast
    .map((m) => {
      const model = view.modelById(m.modelId)
      if (!model) return ''
      const motions = view.promptMotions(model).slice(0, 14)
      const facials = view.promptFacials(model).slice(0, 12)
      const persona = resolveMemberPersona(options.personas, m, view, reviewContextText)
      const actingBrief = actingPersonaPrompt(persona, 1200)
      return `- ${m.name}(modelId=${m.modelId}) 动作样本: ${motions.join(', ')} | 表情样本: ${facials.join(', ')}${
        actingBrief ? `\n  人设演技基调：\n  ${actingBrief.replace(/\n/g, '\n  ')}` : ''
      }`
    })
    .filter(Boolean)
    .join('\n')
  const reviewUnitHint = inferUnitFromText(reviewContextText)
  const reviewAddressBlock = formatPairwiseAddressBlock({
    ...plan,
    pairwiseAddress: mergePairwiseAddresses(
      options.personas,
      plan.cast.map((c) => c.name),
      plan.pairwiseAddress,
      {
        ...(reviewUnitHint ? { unitHint: reviewUnitHint } : {}),
        ...(reviewContextText ? { contextText: reviewContextText } : {})
      }
    )
  })
  const issueHintsBlock =
    reviewHints &&
    (reviewHints.telemetrySummary ||
      (reviewHints.reviewFocusPoints?.length ?? 0) > 0 ||
      (reviewHints.actingIssueHints?.length ?? 0) > 0)
      ? [
          '',
          '## 审校重点与问题句局部演技推荐（onlyIssues）',
          ...(reviewHints.telemetrySummary ? [reviewHints.telemetrySummary] : []),
          ...(reviewHints.reviewFocusPoints?.map((p) => `- 重点核查：${p}`) ?? []),
          ...(reviewHints.actingIssueHints?.map(
            (h) =>
              `- snippets[${h.snippetIndex}](${h.speaker}): ${h.issues.join('；')}` +
              (h.recommendedFacials.length > 0
                ? ` | 推荐表情[${h.recommendedFacials.join(', ')}]`
                : '') +
              (h.recommendedMotions.length > 0
                ? ` | 推荐动作[${h.recommendedMotions.join(', ')}]`
                : '')
          ) ?? [])
        ].join('\n')
      : ''

  return {
    system: [
      '你是 Project SEKAI 视觉小说的总导演（Director Review）。请以观众和导演视角审视已合成的剧本时间线，评估：',
      '1. 戏剧弧光与句长节奏（开场抓手、情绪转折、收尾余韵）',
      '2. 情绪连贯与人物口吻',
      '3. 音频设计（开场 BGM、高潮静音切停 ChangeBgm stop:true、PlaySe 物理/情绪音效）',
      '4. 舞台节奏（Wait 呼吸留白、独立 Motion 静默反应、原地单双人焦点淡入淡出切镜；日常/谈心保持 CameraZoom 与 CharacterShake 克制不滥用）',
      '5. 表情与动作自然度（避免机械循环，也不要无故频繁乱动；自然不死板）',
      '若发现具体薄弱处，请在 operations 中输出精准局部修补（最多 12 条）；若成稿已经精良，operations 可为空数组。严禁编造不在清单中的动作/表情/音效，严禁输出 markdown。',
      '若通过 update_talk 修改台词正文，多行换行统一使用 \\n，严禁用 / 或 " / " 表示换行。'
    ].join('\n'),
    user: `## 场景与大纲
场景：${options.scene}
标题：${plan.title || '（无）'}
梗概：${plan.logline || plan.event}

## 成稿统计
共 ${snippets.length} 片段 / ${talkCount} 句 Talk | PlaySe=${playSeCount} | ChangeBgm=${bgmCount} | 独立 Motion=${standaloneMotionCount} | Move=${moveCount} | Wait=${waitCount}

## 角色演技基调与可用动作/表情参考
${castMotionHints}${reviewAddressBlock}${issueHintsBlock}

## 常用 PlaySe 参考
${seChoices}

## 紧凑时间线（[index]，多行台词以 \\n 表示换行）
${compactTimeline.join('\n')}

## 输出 JSON
{
  "dramaticArc": "简评戏剧弧光与结尾",
  "emotionalContinuityAndVoice": "简评情绪连贯与人物口吻",
  "audioAndSeDesign": "简评 BGM 与 PlaySe 音效",
  "stageRhythm": "简评 Wait/Motion/Move/切镜节奏",
  "actingNaturalness": "简评表情动作自然度与多样性",
  "concreteFixes": ["发现并修补的具体点1", "..."],
  "operations": [
    { "op": "insert_before", "index": 5, "snippet": { "type": "PlaySe", "wait": false, "delay": 0, "data": { "file": "se_run_women_001_1.mp3", "volume": 0.9 } } },
    { "op": "update_acting", "index": 12, "motion": "w-normal-sigh01", "facial": "face_sad_01" }
  ]
}
只输出一个合法 JSON 对象。`
  }
}

export function normalizeDirectorReviewResult(raw: unknown): StagedDirectorReviewResult | null {
  if (!isRecord(raw)) return null
  const dramaticArc = str(raw.dramaticArc).trim()
  const emotionalContinuityAndVoice = str(raw.emotionalContinuityAndVoice).trim()
  const audioAndSeDesign = str(raw.audioAndSeDesign).trim()
  const stageRhythm = str(raw.stageRhythm).trim()
  const actingNaturalness = str(raw.actingNaturalness).trim()
  if (
    !dramaticArc &&
    !emotionalContinuityAndVoice &&
    !audioAndSeDesign &&
    !stageRhythm &&
    !actingNaturalness
  ) {
    return null
  }
  const concreteFixes = Array.isArray(raw.concreteFixes)
    ? raw.concreteFixes
        .map((x) => str(x).trim())
        .filter(Boolean)
        .slice(0, 12)
    : []
  const allowedOps = new Set([
    'update_acting',
    'update_talk',
    'insert_before',
    'insert_after',
    'delete'
  ])
  const operations: StagedDirectorReviewPatch[] = []
  if (Array.isArray(raw.operations)) {
    for (const item of raw.operations.slice(0, 12)) {
      if (!isRecord(item)) continue
      const op = str(item.op).trim()
      const index = Math.floor(num(item.index, -1))
      if (!allowedOps.has(op) || index < 0) continue
      operations.push({
        op: op as StagedDirectorReviewPatch['op'],
        index,
        ...(typeof item.motion === 'string' ? { motion: item.motion } : {}),
        ...(typeof item.facial === 'string' ? { facial: item.facial } : {}),
        ...(typeof item.content === 'string' ? { content: item.content } : {}),
        ...(typeof item.emotion === 'string' ? { emotion: item.emotion } : {}),
        ...(typeof item.delay === 'number' && Number.isFinite(item.delay)
          ? { delay: item.delay }
          : {}),
        ...(typeof item.closeWindowOnFinish === 'boolean'
          ? { closeWindowOnFinish: item.closeWindowOnFinish }
          : {}),
        ...(isRecord(item.snippet) ? { snippet: item.snippet } : {})
      })
    }
  }
  return {
    dramaticArc,
    emotionalContinuityAndVoice,
    audioAndSeDesign,
    stageRhythm,
    actingNaturalness,
    concreteFixes,
    operations
  }
}

/**
 * 将导演终审的局部外科修补应用到剧本副本（按原始下标降序执行，避免索引漂移；保留既有 ttsText 与 Irodori Emoji 不受破坏）。
 */
export function applyDirectorReviewPatches<T extends { snippets: Array<Record<string, unknown>> }>(
  story: T,
  review: StagedDirectorReviewResult
): { story: T; appliedCount: number } {
  const cloned = structuredClone(story)
  const snippets = cloned.snippets
  const originalLen = snippets.length
  const deleted = new Set<number>()
  let appliedCount = 0

  const phaseOf = (op: StagedDirectorReviewPatch['op']): number => {
    if (op === 'insert_after') return 0
    if (op === 'update_talk' || op === 'update_acting') return 1
    if (op === 'delete') return 2
    return 3
  }

  const ordered = review.operations
    .map((op, order) => ({ op, order }))
    .sort((a, b) => {
      if (a.op.index !== b.op.index) return b.op.index - a.op.index
      const pa = phaseOf(a.op.op)
      const pb = phaseOf(b.op.op)
      if (pa !== pb) return pa - pb
      return pa === 0 || pa === 3 ? b.order - a.order : a.order - b.order
    })

  // 允许插入的安全演出辅助片段（不破坏人物在场状态机）
  const safeInsertTypes = new Set([
    'PlaySe',
    'StopSe',
    'ChangeBgm',
    'Wait',
    'Motion',
    'Move',
    'ShakeScreen',
    'ShakeWindow',
    'CharacterShake',
    'AmbientColor',
    'HideTalk'
  ])

  for (const { op } of ordered) {
    const idx = op.index
    if (idx < 0 || idx >= originalLen || deleted.has(idx)) continue
    const target = snippets[idx]
    if (!isRecord(target)) continue

    if (op.op === 'delete') {
      // 安全保护：导演终审不允许误删核心在场/台词结构，仅允许删冗余 ChangeBgm/Wait/PlaySe/Motion
      const tType = str(target.type)
      if (['ChangeBgm', 'Wait', 'PlaySe', 'Motion'].includes(tType)) {
        snippets.splice(idx, 1)
        deleted.add(idx)
        appliedCount += 1
      }
      continue
    }

    if (op.op === 'insert_before' || op.op === 'insert_after') {
      if (!op.snippet || !safeInsertTypes.has(str(op.snippet.type))) continue
      const insertAt = op.op === 'insert_before' ? idx : idx + 1
      snippets.splice(insertAt, 0, structuredClone(op.snippet))
      appliedCount += 1
      continue
    }

    const d = isRecord(target.data) ? target.data : {}
    if (typeof op.delay === 'number' && Number.isFinite(op.delay) && op.delay >= 0) {
      target.delay = op.delay
    }
    if (op.op === 'update_talk' && str(target.type) === 'Talk') {
      if (typeof op.content === 'string' && op.content.trim()) {
        const nextContent = normalizePjskTerminology(normalizeDialogueLineBreaks(op.content).trim())
        const prevContent = normalizeDialogueLineBreaks(str(d.content)).trim()
        if (nextContent && nextContent !== prevContent) {
          d.content = nextContent
          // 仅当中文正文发生实质改写时清空旧 ttsText 以便后续重翻；未改正文时完整保留含 Irodori Emoji 的 ttsText
          if (typeof d.ttsText === 'string' && d.ttsText) delete d.ttsText
        } else if (nextContent && nextContent !== str(d.content).trim()) {
          d.content = nextContent
        }
      }
      if (typeof op.emotion === 'string') d.emotion = op.emotion
      if (typeof op.closeWindowOnFinish === 'boolean') {
        if (op.closeWindowOnFinish) d.closeWindowOnFinish = true
        else delete d.closeWindowOnFinish
      }
      appliedCount += 1
    }
    if (op.motion !== undefined || op.facial !== undefined) {
      if (str(target.type) === 'Talk') {
        const speakerId = num(d.modelId, -1)
        const acts = Array.isArray(d.actions)
          ? [...(d.actions as Array<Record<string, unknown>>)]
          : []
        const primaryIdx = acts.findIndex((a) => isRecord(a) && num(a.modelId, -1) === speakerId)
        const base: Record<string, unknown> =
          primaryIdx >= 0 ? { ...acts[primaryIdx] } : { at: 0, modelId: speakerId }
        if (typeof op.motion === 'string') {
          if (op.motion.trim()) base.motion = op.motion.trim()
          else delete base.motion
        }
        if (typeof op.facial === 'string') {
          if (op.facial.trim()) base.facial = op.facial.trim()
          else delete base.facial
        }
        if (base.motion || base.facial) {
          if (primaryIdx >= 0) acts[primaryIdx] = base
          else acts.unshift(base)
        } else if (primaryIdx >= 0) {
          acts.splice(primaryIdx, 1)
        }
        d.actions = acts
        if (op.motion !== undefined) delete d.motion
        if (op.facial !== undefined) delete d.facial
      } else {
        if (typeof op.motion === 'string') d.motion = op.motion
        if (typeof op.facial === 'string') d.facial = op.facial
      }
      appliedCount += 1
    }
    target.data = d
  }

  return { story: cloned, appliedCount }
}
