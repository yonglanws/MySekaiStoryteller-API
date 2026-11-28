import type { StoryData } from '../../../common/types/Story'
import type { CatalogModel } from '../../resources/resourceCatalog'
import { hasSpokenStageDirectionLeak } from '../dialogueLinter'
import * as facialSemanticsMod from '../facialSemantics'
import * as officialLinterMod from '../officialLinter'
import { isStandingMotion, type CatalogView } from '../prompt'
import type { StagedDirectorActingHint, StagedDirectorReviewHints } from '../staged/types'
import {
  FOOD_DRINK_CUE_RE,
  SLEEP_CUE_RE,
  annotateFacial,
  annotateMotion,
  checkMotionCompatibility,
  countBodyMotionsByModel,
  facialApi,
  findModel,
  getActingProfile,
  inferDramaticMoodFallback,
  inspectMotion,
  moodToTargetMood,
  officialLinterApi,
  type ActingFidelityDiagnostic,
  type ActingFidelityReport,
  type CatalogViewExtended,
  type DramaticContextMood,
  type MotionSemanticRole
} from './actingSemantics'

export interface DirectorStageTelemetry {
  snippetCount: number
  talkCount: number
  avgTalkChars: number
  longLineShare: number
  soloTalkShare: number
  playSeCount: number
  bgmCueCount: number
  hasOpeningBgm: boolean
  hasBgmSilenceCut: boolean
  standaloneMotionCount: number
  moveCount: number
  waitCount: number
  ambientColorCount: number
  cameraOrShakeCount: number
  talkWithMotionShare: number
  talkFacialOnlyShare: number
  talkStillShare: number
  distinctMotionsUsed: number
  distinctFacialsUsed: number
  maxSameMotionRun: number
  dominantEmotion?: string
  dominantEmotionShare?: number
  reviewFocusPoints: string[]
}

export function recommendForLine(
  view: CatalogView,
  model: CatalogModel,
  params: {
    content: string
    emotion?: string
    prevContent?: string
    prevEmotion?: string
    prevTense?: boolean
    isMonologue?: boolean
    isListener?: boolean
    restrainedRole?: boolean
    prevFacial?: string
    prevMotion?: string
    recentMotions?: ReadonlySet<string> | string[]
    limit?: number
  }
): { mood: DramaticContextMood; facials: string[]; motions: string[] } {
  const limit = params.limit ?? 4
  const extView = view as CatalogViewExtended
  if (typeof facialApi.recommendActingForLine === 'function') {
    return facialApi.recommendActingForLine({
      facials: view.promptFacials(model),
      motions: view.promptMotions(model),
      modelPath: model.path,
      ...params,
      limit
    })
  }
  if (typeof extView.recommendActingChoices === 'function') {
    return extView.recommendActingChoices(model.id, {
      content: params.content,
      emotion: params.emotion,
      isListener: params.isListener,
      prevFacial: params.prevFacial,
      prevMotion: params.prevMotion,
      restrainedRole: params.restrainedRole
    })
  }
  const ctx = inferDramaticMoodFallback(params)
  const facialPool = view.promptFacials(model)
  const motionPool = view.promptMotions(model).filter((m) => !isStandingMotion(m))
  const targetMood = moodToTargetMood(ctx.mood)
  const primaryFacial = facialSemanticsMod.pickMoodMatchedFacial(
    facialPool,
    targetMood,
    model.path,
    params.restrainedRole
  )
  const compatFacials = facialPool.filter(
    (f) =>
      f !== params.prevFacial &&
      facialSemanticsMod.isFacialCompatibleWithLine({
        facial: f,
        modelPath: model.path,
        emotion: params.emotion,
        content: params.content,
        prevTense: params.prevTense || ctx.tense,
        restrainedRole: params.restrainedRole
      }).ok
  )
  const facials = [
    ...(primaryFacial ? [primaryFacial] : []),
    ...compatFacials.filter((f) => f !== primaryFacial)
  ].slice(0, limit)

  const desiredRolesByMood: Record<DramaticContextMood, MotionSemanticRole[]> = {
    surprise: ['surprise', 'tilthead', 'forward', 'nod'],
    awkward: ['trouble', 'think', 'shy', 'tilthead'],
    gentle_reassure: ['nod', 'relief', 'forward'],
    inner_resolve: ['forward', 'nod', 'think'],
    shy_hesitation: ['shy', 'think', 'trouble', 'tilthead'],
    angry_frustration: ['angry', 'shakehead', 'forward'],
    sad_regret: ['sad', 'trouble', 'think'],
    cheerful_banter: ['glad', 'nod', 'playful', 'relief'],
    attentive_listen: ['nod', 'think', 'forward', 'trouble'],
    thinking_monologue: ['think', 'sad', 'trouble'],
    entry_exit: ['nod', 'tilthead', 'relief', 'think'],
    neutral: ['nod', 'tilthead', 'think', 'forward', 'relief']
  }
  const wantedRoles = desiredRolesByMood[ctx.mood] ?? desiredRolesByMood.neutral
  const recentSet = new Set(params.recentMotions ?? [])
  const scoredMotions = motionPool
    .filter(
      (m) =>
        checkMotionCompatibility({
          motion: m,
          modelPath: model.path,
          emotion: params.emotion,
          content: params.content,
          prevTense: params.prevTense || ctx.tense,
          isListener: params.isListener,
          restrainedRole: params.restrainedRole
        }).ok
    )
    .map((m) => {
      const role = inspectMotion(model.path, m).role
      const roleIdx = wantedRoles.indexOf(role)
      let score = roleIdx >= 0 ? 20 - roleIdx * 4 : 0
      if (/^w-normal/i.test(m)) score += 3
      if (m === params.prevMotion) score -= 3
      if (recentSet.has(m)) score -= 2
      return { m, score }
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.m)

  return {
    mood: ctx.mood,
    facials:
      facials.length > 0
        ? facials
        : [
            facialSemanticsMod.pickNeutralFacial(
              facialPool,
              model.defaultFacial,
              model.path,
              params.restrainedRole
            )
          ],
    motions: scoredMotions.slice(0, limit)
  }
}

function appendContextAndListenerGuards(
  story: StoryData,
  view: CatalogView,
  base: ActingFidelityReport
): ActingFidelityReport {
  const extraDiagnostics: ActingFidelityDiagnostic[] = []
  const lastEmotionByModel = new Map<number, string>()
  let prevContent = ''
  let prevEmotion = ''
  let talkIdx = 0
  let addedFacialMismatch = 0
  let addedMotionMismatch = 0

  const hasDiagAt = (
    snippetIndex: number,
    modelId: number,
    field: 'motion' | 'facial',
    code?: string
  ): boolean =>
    base.diagnostics.some(
      (d) =>
        d.snippetIndex === snippetIndex &&
        d.modelId === modelId &&
        d.field === field &&
        (!code || d.code === code)
    )

  for (let i = 0; i < story.snippets.length; i++) {
    const snippet = story.snippets[i]
    const rawData = (
      'data' in snippet && snippet.data && typeof snippet.data === 'object' ? snippet.data : {}
    ) as Record<string, unknown>
    if (
      snippet.type === 'BlackOut' ||
      snippet.type === 'SekaiOut' ||
      (snippet.type === 'SideFade' && String(rawData.mode ?? 'Out').toLowerCase() === 'out') ||
      snippet.type === 'ChangeBackgroundImage'
    ) {
      prevContent = ''
      prevEmotion = ''
      lastEmotionByModel.clear()
      continue
    }
    if (snippet.type !== 'Talk' || !('data' in snippet) || !snippet.data) continue
    talkIdx += 1
    const data = snippet.data as unknown as Record<string, unknown>
    const content = String(data.content ?? '')
    const emotion = String(data.emotion ?? '')
    const speaker = String(data.speaker ?? '')
    const modelId = typeof data.modelId === 'number' ? data.modelId : -1
    if (modelId === -1) {
      prevContent = content
      prevEmotion = emotion
      continue
    }
    const actions = Array.isArray(data.actions)
      ? (data.actions as Array<Record<string, unknown>>)
      : []
    const speakerActs = actions.filter((a) => a && a.modelId === modelId)
    const primaryMotion =
      (typeof speakerActs[0]?.motion === 'string' ? speakerActs[0].motion : '') ||
      (typeof data.motion === 'string' ? data.motion : '')
    const primaryFacial =
      (typeof speakerActs[0]?.facial === 'string' ? speakerActs[0].facial : '') ||
      (typeof data.facial === 'string' ? data.facial : '')
    const model = view.modelById(modelId)

    if (primaryMotion) {
      const propReason =
        /delicious|eat|drink/i.test(primaryMotion) && !FOOD_DRINK_CUE_RE.test(content)
          ? 'prop_food_motion_without_food_cue'
          : /sleep/i.test(primaryMotion) && !SLEEP_CUE_RE.test(content)
            ? 'sleep_motion_without_sleep_cue'
            : ''
      if (propReason && !hasDiagAt(i, modelId, 'motion', propReason)) {
        addedMotionMismatch += 1
        const rec = model
          ? recommendForLine(view, model, {
              content,
              emotion,
              prevContent,
              prevEmotion,
              limit: 3
            })
          : { facials: [], motions: [] }
        extraDiagnostics.push({
          snippetIndex: i,
          lineNumber: talkIdx,
          modelId,
          speaker,
          content: content.slice(0, 60),
          emotion,
          facial: primaryFacial,
          motion: primaryMotion,
          inferredMood: 'neutral',
          field: 'motion',
          code: propReason,
          severity: 'high',
          message: `动作 ${annotateMotion(model?.path, primaryMotion)} 仅限特定食物/睡眠语境(${propReason})`,
          recommendedFacials: rec.facials,
          recommendedMotions: rec.motions
        })
      }
    }

    for (const act of actions) {
      const lid = typeof act?.modelId === 'number' ? act.modelId : -1
      const lFacial = typeof act?.facial === 'string' ? act.facial.trim() : ''
      if (
        lid !== -1 &&
        lid !== modelId &&
        lFacial &&
        !hasDiagAt(i, lid, 'facial', 'listener_tense_smile_flip')
      ) {
        const lPrevEmo = lastEmotionByModel.get(lid) ?? ''
        const lModel = view.modelById(lid)
        if (
          (lPrevEmo === '生气' || lPrevEmo === '伤心') &&
          facialSemanticsMod.isSmileLikeFacial(lFacial, lModel?.path)
        ) {
          addedFacialMismatch += 1
          const lRec = lModel
            ? recommendForLine(view, lModel, {
                content,
                emotion,
                prevContent,
                prevEmotion,
                prevTense: true,
                isListener: true,
                limit: 3
              })
            : { facials: [], motions: [] }
          extraDiagnostics.push({
            snippetIndex: i,
            lineNumber: talkIdx,
            modelId: lid,
            speaker: lModel ? view.shortName(lModel) : String(lid),
            content: content.slice(0, 60),
            emotion,
            facial: lFacial,
            motion: '',
            inferredMood: 'sad_regret',
            field: 'facial',
            code: 'listener_tense_smile_flip',
            severity: 'high',
            message: `听者前序情绪为「${lPrevEmo}」，切忌突然切为笑脸 ${annotateFacial(lModel?.path, lFacial)}`,
            recommendedFacials: lRec.facials,
            recommendedMotions: lRec.motions
          })
        }
      }
    }
    if (emotion) lastEmotionByModel.set(modelId, emotion)
    prevContent = content
    prevEmotion = emotion
  }

  if (extraDiagnostics.length === 0) return base
  const diagnostics = [...extraDiagnostics, ...base.diagnostics].sort(
    (a, b) =>
      (a.severity === 'high' ? 0 : 1) - (b.severity === 'high' ? 0 : 1) ||
      a.snippetIndex - b.snippetIndex
  )
  return {
    ...base,
    diagnostics,
    facialMismatchCount: base.facialMismatchCount + addedFacialMismatch,
    motionMismatchCount: base.motionMismatchCount + addedMotionMismatch,
    score: Math.max(0, base.score - extraDiagnostics.length * 15),
    passed: false
  }
}

export function runActingAndFidelityAudit(
  story: StoryData,
  view: CatalogView
): ActingFidelityReport {
  if (typeof officialLinterApi.auditStoryActingAndFidelity === 'function') {
    return appendContextAndListenerGuards(
      story,
      view,
      officialLinterApi.auditStoryActingAndFidelity(story, view)
    )
  }
  const officialReport = officialLinterMod.lintOfficialStory(story, view)
  const diagnostics: ActingFidelityDiagnostic[] = []
  const bodyMotions = countBodyMotionsByModel(story)
  const zeroMotionModelIds =
    story.models.length >= 2
      ? story.models.filter((m) => (bodyMotions[String(m.id)] ?? 0) === 0).map((m) => m.id)
      : []

  const lastFacialByModel = new Map<number, { facial: string; run: number }>()
  const lastMotionByModel = new Map<number, { motion: string; run: number }>()
  const lastEmotionByModel = new Map<number, string>()
  const onStage = new Set<number>()
  const listenerIdleTalks = new Map<number, number>()
  let lastBgmKey: string | null = null
  let prevTense = false
  let prevContent = ''
  let prevEmotion = ''
  let talkIdx = 0
  let repeatedFacialRunCount = 0
  let facialMismatchCount = 0
  let motionMismatchCount = 0
  let simultaneousCollisionCount = 0
  let stageDirectionLeakCount = 0
  let listenerFrozenCount = 0
  let duplicateBgmCount = 0

  for (let i = 0; i < story.snippets.length; i++) {
    const snippet = story.snippets[i]
    const rawData = (
      'data' in snippet && snippet.data && typeof snippet.data === 'object' ? snippet.data : {}
    ) as Record<string, unknown>

    if (snippet.type === 'LayoutAppear') {
      const mid = typeof rawData.modelId === 'number' ? rawData.modelId : -1
      if (mid !== -1) {
        onStage.add(mid)
        listenerIdleTalks.set(mid, 0)
      }
      continue
    }
    if (snippet.type === 'LayoutClear') {
      const mid = typeof rawData.modelId === 'number' ? rawData.modelId : -1
      onStage.delete(mid)
      listenerIdleTalks.delete(mid)
      continue
    }
    if (snippet.type === 'Move' || snippet.type === 'Motion') {
      const mid = typeof rawData.modelId === 'number' ? rawData.modelId : -1
      if (mid !== -1 && onStage.has(mid)) listenerIdleTalks.set(mid, 0)
      continue
    }
    if (snippet.type === 'ChangeBgm') {
      const stop = Boolean(rawData.stop)
      const file = stop ? '' : String(rawData.file ?? '').trim()
      const key = `${stop ? 'stop' : 'play'}:${file}`
      if (lastBgmKey !== null && lastBgmKey === key) {
        duplicateBgmCount += 1
        diagnostics.push({
          snippetIndex: i,
          lineNumber: talkIdx,
          modelId: -1,
          speaker: '',
          content: file || 'stop',
          emotion: '',
          facial: '',
          motion: '',
          inferredMood: 'neutral',
          field: 'bgm',
          code: 'duplicate_bgm',
          severity: 'medium',
          message: `重复连续播放相同 BGM（${file || 'stop'}），建议删除冗余 ChangeBgm`,
          recommendedFacials: [],
          recommendedMotions: []
        })
      }
      lastBgmKey = key
      continue
    }

    if (snippet.type !== 'Talk' || !('data' in snippet) || !snippet.data) continue
    talkIdx += 1
    const data = rawData
    const speaker = String(data.speaker ?? '')
    const content = String(data.content ?? '')
    const emotion = String(data.emotion ?? '')
    const modelId = typeof data.modelId === 'number' ? data.modelId : -1

    if (hasSpokenStageDirectionLeak(content)) {
      stageDirectionLeakCount += 1
      diagnostics.push({
        snippetIndex: i,
        lineNumber: talkIdx,
        modelId,
        speaker,
        content: content.slice(0, 60),
        emotion,
        facial: '',
        motion: '',
        inferredMood: inferDramaticMoodFallback({ content, emotion }).mood,
        field: 'dialogue',
        code: 'stage_direction_leak',
        severity: 'high',
        message: '口语台词包含舞台动作括号描写（如「（微笑）」），请移除并改由 motion/facial 表现',
        recommendedFacials: [],
        recommendedMotions: []
      })
    }

    if (modelId === -1) {
      prevContent = content
      prevEmotion = emotion
      continue
    }

    const actions = Array.isArray(data.actions)
      ? (data.actions as Array<Record<string, unknown>>)
      : []
    const bodyActTimes: number[] = []
    for (const act of actions) {
      if (typeof act.motion === 'string' && act.motion.trim()) {
        bodyActTimes.push(typeof act.at === 'number' ? act.at : 0)
      }
    }
    if (bodyActTimes.length >= 2) {
      bodyActTimes.sort((a, b) => a - b)
      for (let k = 1; k < bodyActTimes.length; k++) {
        if (bodyActTimes[k] - bodyActTimes[k - 1] < 0.25 - 1e-6) {
          simultaneousCollisionCount += 1
          diagnostics.push({
            snippetIndex: i,
            lineNumber: talkIdx,
            modelId,
            speaker,
            content: content.slice(0, 60),
            emotion,
            facial: '',
            motion: '',
            inferredMood: inferDramaticMoodFallback({ content, emotion }).mood,
            field: 'staging',
            code: 'simultaneous_motion_collision',
            severity: 'high',
            message: '同一句 Talk 内双人动作时刻间距 <0.25，禁止说话者与听者同瞬碰撞',
            recommendedFacials: [],
            recommendedMotions: []
          })
          break
        }
      }
    }

    const speakerActs = actions.filter((a) => a.modelId === modelId)
    const primaryFacial =
      (typeof speakerActs[0]?.facial === 'string' ? speakerActs[0].facial : '') ||
      (typeof data.facial === 'string' ? data.facial : '')
    const primaryMotion =
      (typeof speakerActs[0]?.motion === 'string' ? speakerActs[0].motion : '') ||
      (typeof data.motion === 'string' ? data.motion : '')
    const model = view.modelById(modelId)
    const profile = getActingProfile(model?.name ?? speaker, '')
    const rec = model
      ? recommendForLine(view, model, {
          content,
          emotion,
          prevContent,
          prevEmotion,
          prevTense,
          restrainedRole: profile.restrained,
          prevFacial: lastFacialByModel.get(modelId)?.facial,
          prevMotion: lastMotionByModel.get(modelId)?.motion
        })
      : {
          mood: inferDramaticMoodFallback({ content, emotion, prevContent, prevEmotion }).mood,
          facials: [],
          motions: []
        }

    if (primaryFacial) {
      const fCompat = facialSemanticsMod.isFacialCompatibleWithLine({
        facial: primaryFacial,
        modelPath: model?.path,
        emotion,
        content,
        prevTense,
        restrainedRole: profile.restrained
      })
      if (!fCompat.ok) {
        facialMismatchCount += 1
        diagnostics.push({
          snippetIndex: i,
          lineNumber: talkIdx,
          modelId,
          speaker,
          content: content.slice(0, 60),
          emotion,
          facial: primaryFacial,
          motion: primaryMotion,
          inferredMood: rec.mood,
          field: 'facial',
          code: fCompat.reason ?? 'facial_mood_mismatch',
          severity: 'high',
          message: `表情 ${annotateFacial(model?.path, primaryFacial)} 与剧情/情绪(${rec.mood})冲突(${fCompat.reason ?? 'mismatch'})`,
          recommendedFacials: rec.facials,
          recommendedMotions: rec.motions
        })
      }
      const prevF = lastFacialByModel.get(modelId)
      const nextRun = prevF && prevF.facial === primaryFacial ? prevF.run + 1 : 1
      lastFacialByModel.set(modelId, { facial: primaryFacial, run: nextRun })
      if (nextRun >= 4 && /^face_normal/i.test(primaryFacial) && !profile.restrained) {
        repeatedFacialRunCount += 1
        diagnostics.push({
          snippetIndex: i,
          lineNumber: talkIdx,
          modelId,
          speaker,
          content: content.slice(0, 60),
          emotion,
          facial: primaryFacial,
          motion: primaryMotion,
          inferredMood: rec.mood,
          field: 'repetition',
          code: 'stale_normal_facial_run',
          severity: 'medium',
          message: `连续 ${nextRun} 句停留在 ${primaryFacial}，建议随台词语气细腻切换`,
          recommendedFacials: rec.facials,
          recommendedMotions: []
        })
      }
    }

    if (primaryMotion) {
      const mCompat = checkMotionCompatibility({
        motion: primaryMotion,
        modelPath: model?.path,
        emotion,
        content,
        prevContent,
        prevEmotion,
        prevTense,
        restrainedRole: profile.restrained
      })
      if (!mCompat.ok) {
        motionMismatchCount += 1
        diagnostics.push({
          snippetIndex: i,
          lineNumber: talkIdx,
          modelId,
          speaker,
          content: content.slice(0, 60),
          emotion,
          facial: primaryFacial,
          motion: primaryMotion,
          inferredMood: rec.mood,
          field: 'motion',
          code: mCompat.reason ?? 'motion_mood_mismatch',
          severity: 'high',
          message: `动作 ${annotateMotion(model?.path, primaryMotion)} 与剧情/情绪(${rec.mood})冲突(${mCompat.reason ?? 'mismatch'})`,
          recommendedFacials: rec.facials,
          recommendedMotions: rec.motions
        })
      }
      const prevM = lastMotionByModel.get(modelId)
      const nextRun = prevM && prevM.motion === primaryMotion ? prevM.run + 1 : 1
      lastMotionByModel.set(modelId, { motion: primaryMotion, run: nextRun })
      if (nextRun >= 4) {
        diagnostics.push({
          snippetIndex: i,
          lineNumber: talkIdx,
          modelId,
          speaker,
          content: content.slice(0, 60),
          emotion,
          facial: primaryFacial,
          motion: primaryMotion,
          inferredMood: rec.mood,
          field: 'repetition',
          code: 'repeated_motion_run',
          severity: 'medium',
          message: `连续 ${nextRun} 句重复动作 ${primaryMotion}，建议在情绪转折处自然换拍`,
          recommendedFacials: [],
          recommendedMotions: rec.motions
        })
      }
    }

    // 听者静止检测（对齐官方 event_145_08）：跳过内心独白，连续 >=4 句无更新才提示，推荐 at: 0 纯表情或句间独立 Motion
    const isMonologueLine = /^[（(]/.test(content.trim()) && /[）)]$/.test(content.trim())
    const activeIds = new Set<number>([modelId])
    for (const act of actions) {
      if (typeof act.modelId === 'number') activeIds.add(act.modelId)
    }
    if (!isMonologueLine) {
      for (const onStageId of onStage) {
        if (activeIds.has(onStageId)) {
          listenerIdleTalks.set(onStageId, 0)
          continue
        }
        const nextIdle = (listenerIdleTalks.get(onStageId) ?? 0) + 1
        listenerIdleTalks.set(onStageId, nextIdle)
        if (nextIdle === 4 || (nextIdle > 4 && nextIdle % 4 === 0)) {
          listenerFrozenCount += 1
          const listenerModel = view.modelById(onStageId)
          const listenerProfile = getActingProfile(listenerModel?.name ?? '', '')
          const listenerRec = listenerModel
            ? recommendForLine(view, listenerModel, {
                content,
                emotion,
                prevContent,
                prevEmotion,
                prevTense,
                isListener: true,
                restrainedRole: listenerProfile.restrained,
                limit: 3
              })
            : { mood: 'attentive_listen' as DramaticContextMood, facials: [], motions: [] }
          diagnostics.push({
            snippetIndex: i,
            lineNumber: talkIdx,
            modelId,
            listenerModelId: onStageId,
            speaker,
            content: content.slice(0, 60),
            emotion,
            facial: '',
            motion: '',
            inferredMood: listenerRec.mood,
            field: 'staging',
            code: 'listener_frozen',
            severity: 'medium',
            message: `在场听者(modelId=${onStageId})已连续 ${nextIdle} 句静止无反应，建议在 actions 中于 at: 0 添加纯表情(facial-only)切换，或在情绪转折点句间插入独立 Motion 片段`,
            recommendedFacials: listenerRec.facials,
            recommendedMotions: listenerRec.motions
          })
        }
      }
    }

    const lineCtx = inferDramaticMoodFallback({ content, emotion, prevContent, prevEmotion })
    for (const act of actions) {
      const lid = typeof act.modelId === 'number' ? act.modelId : -1
      const lFacial = typeof act.facial === 'string' ? act.facial.trim() : ''
      if (lid !== -1 && lid !== modelId && lFacial) {
        const lPrevEmo = lastEmotionByModel.get(lid) ?? ''
        const lModel = view.modelById(lid)
        if (
          (lPrevEmo === '生气' || lPrevEmo === '伤心') &&
          facialSemanticsMod.isSmileLikeFacial(lFacial, lModel?.path)
        ) {
          facialMismatchCount += 1
          const lRec = lModel
            ? recommendForLine(view, lModel, {
                content,
                emotion,
                prevContent,
                prevEmotion,
                prevTense: true,
                isListener: true,
                limit: 3
              })
            : { facials: [], motions: [] }
          diagnostics.push({
            snippetIndex: i,
            lineNumber: talkIdx,
            modelId: lid,
            speaker: lModel ? view.shortName(lModel) : String(lid),
            content: content.slice(0, 60),
            emotion,
            facial: lFacial,
            motion: '',
            inferredMood: 'sad_regret',
            field: 'facial',
            code: 'listener_tense_smile_flip',
            severity: 'high',
            message: `听者前序情绪为「${lPrevEmo}」，切忌突然切为笑脸 ${annotateFacial(lModel?.path, lFacial)}`,
            recommendedFacials: lRec.facials,
            recommendedMotions: lRec.motions
          })
        }
      }
    }
    if (emotion) lastEmotionByModel.set(modelId, emotion)
    prevTense = lineCtx.tense
    prevContent = content
    prevEmotion = emotion
  }

  const highCount = diagnostics.filter((d) => d.severity === 'high').length
  const medCount = diagnostics.filter((d) => d.severity === 'medium').length
  const penalty =
    highCount * 15 +
    medCount * 5 +
    officialReport.issues.length * 15 +
    (talkIdx >= 6 ? zeroMotionModelIds.length * 12 : 0)
  const score = Math.max(0, Math.min(100, 100 - penalty))
  const passed =
    officialReport.passed && highCount === 0 && (talkIdx < 6 || zeroMotionModelIds.length === 0)

  return {
    passed,
    score,
    talkCount: talkIdx,
    diagnostics,
    zeroMotionModelIds,
    repeatedFacialRunCount,
    facialMismatchCount,
    motionMismatchCount,
    simultaneousCollisionCount,
    stageDirectionLeakCount,
    listenerFrozenCount,
    duplicateBgmCount,
    officialReport
  }
}

export function buildLocalizedDirectorReviewHints(
  story: StoryData,
  view: CatalogView,
  targetMinutes?: number
): StagedDirectorReviewHints {
  const storyObj = story as unknown as Record<string, unknown>
  const telemetry = buildDirectorStageTelemetry(storyObj, targetMinutes)
  const actingReport = runActingAndFidelityAudit(story, view)
  const snippets = Array.isArray(story.snippets)
    ? (story.snippets as unknown as Array<Record<string, unknown>>)
    : []

  const issuesByIdx = new Map<number, string[]>()
  for (const d of actingReport.diagnostics) {
    const arr = issuesByIdx.get(d.snippetIndex) ?? []
    arr.push(`${d.code}: ${d.message}`)
    issuesByIdx.set(d.snippetIndex, arr)
  }

  const actingIssueHints: StagedDirectorActingHint[] = []
  if (issuesByIdx.size > 0) {
    const lastFacial = new Map<number, string>()
    const lastMotion = new Map<number, string>()
    let prevContent = ''
    let prevEmotion = ''
    let prevTense = false

    for (let idx = 0; idx < snippets.length; idx++) {
      const s = snippets[idx]
      if (!s || s.type !== 'Talk') continue
      const d = (s.data && typeof s.data === 'object' ? s.data : {}) as Record<string, unknown>
      const content = typeof d.content === 'string' ? d.content : ''
      const emotion = typeof d.emotion === 'string' ? d.emotion : ''
      const modelId = typeof d.modelId === 'number' ? d.modelId : -1
      const speaker = typeof d.speaker === 'string' ? d.speaker : ''
      const model = view.modelById(modelId) ?? findModel(view, modelId, speaker)

      if (model && issuesByIdx.has(idx) && actingIssueHints.length < 10) {
        const profile = getActingProfile(`${model.name} ${model.path}`)
        const advised = recommendForLine(view, model, {
          content,
          emotion,
          prevContent,
          prevEmotion,
          prevTense,
          isMonologue: /^[（(]/.test(content.trim()) && /[）)]$/.test(content.trim()),
          restrainedRole: profile.restrained,
          prevFacial: lastFacial.get(model.id),
          prevMotion: lastMotion.get(model.id),
          limit: 3
        })
        if (advised.facials[0]) lastFacial.set(model.id, advised.facials[0])
        if (advised.motions[0]) lastMotion.set(model.id, advised.motions[0])
        actingIssueHints.push({
          snippetIndex: idx,
          speaker: speaker || view.shortName(model),
          issues: issuesByIdx.get(idx) ?? [],
          recommendedFacials: advised.facials.slice(0, 3),
          recommendedMotions: advised.motions.slice(0, 3)
        })
      }

      const ctx = inferDramaticMoodFallback({
        content,
        emotion,
        prevContent,
        prevEmotion
      })
      prevTense = ctx.tense
      prevContent = content
      prevEmotion = emotion
    }
  }

  const estMin = ((telemetry.talkCount * 7) / 60).toFixed(1)
  return {
    telemetrySummary: `声画遥测：Talk=${telemetry.talkCount}（约 ${estMin} 分钟），BGM=${telemetry.bgmCueCount}，PlaySe=${telemetry.playSeCount}，独立 Motion=${telemetry.standaloneMotionCount}，Wait=${telemetry.waitCount}，不同动作=${telemetry.distinctMotionsUsed}，不同表情=${telemetry.distinctFacialsUsed}`,
    reviewFocusPoints: telemetry.reviewFocusPoints.slice(0, 6),
    actingIssueHints
  }
}

export function buildDirectorStageTelemetry(
  story: Record<string, unknown>,
  targetMinutes?: number
): DirectorStageTelemetry {
  const snippets = Array.isArray(story.snippets)
    ? (story.snippets as Array<Record<string, unknown>>)
    : []
  let talkCount = 0
  let playSeCount = 0
  let bgmCueCount = 0
  let firstTalkIdx = -1
  let firstBgmIdx = -1
  let firstBgmPlayTalkCount = -1
  let hasBgmSilenceCut = false
  let standaloneMotionCount = 0
  let moveCount = 0
  let waitCount = 0
  let ambientColorCount = 0
  let cameraOrShakeCount = 0
  let talkWithMotion = 0
  let talkFacialOnly = 0
  let talkStill = 0
  let totalTalkChars = 0
  let longTalkCount = 0
  let soloTalkCount = 0
  const onStage = new Set<number>()
  const emotionCounts = new Map<string, number>()
  let calmOnCryOrSadFacialCount = 0
  let missingCaptionCount = 0
  const distinctMotions = new Set<string>()
  const distinctFacials = new Set<string>()
  const motionRunByModel = new Map<number, { motion: string; run: number }>()
  let maxSameMotionRun = 0

  for (let i = 0; i < snippets.length; i++) {
    const s = snippets[i]
    if (!s || typeof s !== 'object') continue
    const kind = String(s.type ?? '')
    const d = (s.data && typeof s.data === 'object' ? s.data : {}) as Record<string, unknown>
    if (kind === 'LayoutAppear') {
      if (typeof d.modelId === 'number') onStage.add(d.modelId)
    } else if (kind === 'LayoutClear') {
      if (typeof d.modelId === 'number') onStage.delete(d.modelId)
    } else if (kind === 'PlaySe') {
      playSeCount += 1
    } else if (kind === 'ChangeBgm') {
      bgmCueCount += 1
      if (firstBgmIdx === -1) firstBgmIdx = i
      if (d.stop === true) hasBgmSilenceCut = true
      else if (firstBgmPlayTalkCount === -1 && typeof d.file === 'string' && d.file.trim()) {
        firstBgmPlayTalkCount = talkCount
      }
    } else if (kind === 'Motion') {
      standaloneMotionCount += 1
    } else if (kind === 'Move') {
      moveCount += 1
    } else if (kind === 'Wait') {
      waitCount += 1
    } else if (kind === 'AmbientColor') {
      ambientColorCount += 1
    } else if (
      kind === 'CameraZoom' ||
      kind === 'CameraMove' ||
      kind === 'DollyZoom' ||
      kind === 'ShakeScreen' ||
      kind === 'ShakeWindow' ||
      kind === 'CharacterShake'
    ) {
      cameraOrShakeCount += 1
    } else if (kind === 'Talk') {
      talkCount += 1
      if (firstTalkIdx === -1) firstTalkIdx = i
      if (onStage.size === 1) soloTalkCount += 1
      const contentStr = typeof d.content === 'string' ? d.content.replace(/\s+/g, '') : ''
      const chars = Array.from(contentStr).length
      totalTalkChars += chars
      if (chars >= 24) longTalkCount += 1
      const emoStr = typeof d.emotion === 'string' ? d.emotion.trim() : ''
      if (emoStr) emotionCounts.set(emoStr, (emotionCounts.get(emoStr) ?? 0) + 1)
      const mid = typeof d.modelId === 'number' ? d.modelId : -1
      const acts = Array.isArray(d.actions) ? (d.actions as Array<Record<string, unknown>>) : []
      const speakerActs = acts.filter((a) => a && (a.modelId === mid || a.modelId === undefined))
      const speakerMotion =
        speakerActs.find((a) => typeof a.motion === 'string' && a.motion.trim())?.motion ??
        (typeof d.motion === 'string' && d.motion.trim() ? d.motion : '')
      const speakerFacial =
        speakerActs.find((a) => typeof a.facial === 'string' && a.facial.trim())?.facial ??
        (typeof d.facial === 'string' && d.facial.trim() ? d.facial : '')
      const mStr = typeof speakerMotion === 'string' ? speakerMotion.trim() : ''
      const fStr = typeof speakerFacial === 'string' ? speakerFacial.trim() : ''
      const allSpeakerFacials = [
        fStr,
        ...speakerActs
          .map((a) => (typeof a.facial === 'string' ? a.facial.trim() : ''))
          .filter(Boolean)
      ].join(' ')
      if (
        (!emoStr || emoStr === '平静') &&
        /(?:cry|sad|nhisad|heartbreak|desperate)/i.test(allSpeakerFacials)
      ) {
        calmOnCryOrSadFacialCount += 1
      }
      if (typeof d.ttsCaption !== 'string' || !d.ttsCaption.trim()) {
        missingCaptionCount += 1
      }
      if (mStr) {
        talkWithMotion += 1
        distinctMotions.add(mStr)
        if (mid !== -1) {
          const prev = motionRunByModel.get(mid)
          const run = prev && prev.motion === mStr ? prev.run + 1 : 1
          motionRunByModel.set(mid, { motion: mStr, run })
          if (run > maxSameMotionRun) maxSameMotionRun = run
        }
      } else if (fStr) {
        talkFacialOnly += 1
      } else {
        talkStill += 1
      }
      if (fStr) distinctFacials.add(fStr)
      for (const a of acts) {
        if (typeof a?.motion === 'string' && a.motion.trim()) distinctMotions.add(a.motion.trim())
        if (typeof a?.facial === 'string' && a.facial.trim()) distinctFacials.add(a.facial.trim())
      }
    }
  }

  const hasTopLevelBgm = Array.isArray(story.bgm)
    ? story.bgm.length > 0
    : typeof story.bgm === 'string' && story.bgm.trim().length > 0
  const hasOpeningBgm =
    hasTopLevelBgm ||
    (firstBgmPlayTalkCount !== -1 && firstBgmPlayTalkCount <= 4) ||
    (firstBgmIdx !== -1 && (firstTalkIdx === -1 || firstBgmIdx < firstTalkIdx))
  const talkWithMotionShare = talkCount > 0 ? Number((talkWithMotion / talkCount).toFixed(2)) : 0
  const talkFacialOnlyShare = talkCount > 0 ? Number((talkFacialOnly / talkCount).toFixed(2)) : 0
  const talkStillShare = talkCount > 0 ? Number((talkStill / talkCount).toFixed(2)) : 0
  const avgTalkChars = talkCount > 0 ? Number((totalTalkChars / talkCount).toFixed(1)) : 0
  const longLineShare = talkCount > 0 ? Number((longTalkCount / talkCount).toFixed(2)) : 0
  const soloTalkShare = talkCount > 0 ? Number((soloTalkCount / talkCount).toFixed(2)) : 0
  let dominantEmotion: string | undefined
  let dominantEmotionCount = 0
  for (const [emo, cnt] of emotionCounts) {
    if (cnt > dominantEmotionCount) {
      dominantEmotion = emo
      dominantEmotionCount = cnt
    }
  }
  const dominantEmotionShare =
    talkCount > 0 && dominantEmotionCount > 0
      ? Number((dominantEmotionCount / talkCount).toFixed(2))
      : undefined

  const reviewFocusPoints: string[] = []
  if (talkCount >= 10 && playSeCount === 0) {
    reviewFocusPoints.push(
      '全片 0 个 PlaySe 音效（官方近期剧集 96% 含音效）：请在脚步、奔跑、开关门、衣料/翻纸、惊觉或转场处点缀 2~5 处 PlaySe'
    )
  }
  if (talkCount >= 8 && !hasOpeningBgm) {
    reviewFocusPoints.push(
      '开场前段未设置 BGM（严禁大段无声冷开场）：请在首句 Talk 前用 ChangeBgm 配上贴合氛围的曲目（除非刻意仅留 2~4 句冷开场并在第 5 句前切入 ChangeBgm）'
    )
  }
  if (typeof targetMinutes === 'number' && targetMinutes >= 0.5) {
    const maxTalksForBudget = Math.max(12, Math.round(targetMinutes * 12.5))
    const minTalksForBudget = Math.max(8, Math.round(targetMinutes * 9.5))
    const idealMaxTalks = Math.max(minTalksForBudget + 4, Math.round(targetMinutes * 12))
    if (talkCount > maxTalksForBudget) {
      reviewFocusPoints.push(
        `全片共 ${talkCount} 句 Talk（按约 7 秒/句约 ${((talkCount * 7) / 60).toFixed(1)} 分钟，超出目标 ${targetMinutes} 分钟）：请用 delete/update_talk 精简重复独白或合并铺垫，收束至 ${minTalksForBudget}~${idealMaxTalks} 句`
      )
    }
  }
  if (talkCount >= 18 && !hasBgmSilenceCut && bgmCueCount <= 1) {
    reviewFocusPoints.push(
      '长场次 BGM 全程单一未切停：可在情绪转折或爆发前用 ChangeBgm({stop:true}) 制造留白或切曲'
    )
  }
  if (talkCount >= 14 && standaloneMotionCount === 0 && waitCount === 0) {
    reviewFocusPoints.push(
      '舞台节奏偏平（0 独立 Motion、0 Wait）：可在情绪重拍或长句后插入 4~8 处句间独立 Motion 静默反应拍或短 Wait，切忌使用 Move 横向滑动'
    )
  }
  if (talkCount >= 16 && soloTalkShare < 0.15) {
    reviewFocusPoints.push(
      `单人 Center 特写占比偏低（${(soloTalkShare * 100).toFixed(0)}%）：可在内心独白或强情绪段使用 LayoutClear + LayoutAppear(Center) 原地淡入淡出切镜（isMoved:false）`
    )
  }
  if (talkCount >= 16 && distinctMotions.size <= 8) {
    reviewFocusPoints.push(
      `全片仅使用了 ${distinctMotions.size} 种不同身体动作，容易陷入机械循环（近期官方主演单集约 18~30+ 种）：请从角色全量动作库补充不同编号及贴合气氛的跨风格动作`
    )
  }
  const highEnergyDramaCount = (emotionCounts.get('生气') ?? 0) + (emotionCounts.get('惊讶') ?? 0)
  if (talkCount >= 12 && cameraOrShakeCount >= 4 && dominantEmotion === '平静') {
    reviewFocusPoints.push(
      `日常/平静场景镜头与震动偏多（${cameraOrShakeCount} 处）：日常/谈心/后台场请保持 CameraZoom/CameraMove 与 CharacterShake 为 0，避免公式化抖动`
    )
  } else if (talkCount >= 16 && highEnergyDramaCount >= 4 && cameraOrShakeCount === 0) {
    reviewFocusPoints.push(
      `冲突/高潮张力较强（生气/惊讶共 ${highEnergyDramaCount} 句）但全片 0 镜头推进与震动：请在核心对峙/爆发或受惊冲击句配置 1~2 处 CameraZoom(1.06~1.12 -> 1.0) 或 CharacterShake/ShakeScreen`
    )
  }
  if (talkCount >= 14 && avgTalkChars >= 19 && longLineShare >= 0.35) {
    reviewFocusPoints.push(
      `台词均长 ${avgTalkChars} 字且长句占比 ${(longLineShare * 100).toFixed(0)}%，容易像书面说明（官方近期多为短反应与中等句交错）：可将部分解释句拆短，留出停顿与潜台词`
    )
  }
  if (talkCount >= 16 && dominantEmotion && (dominantEmotionShare ?? 0) >= 0.8) {
    reviewFocusPoints.push(
      `情绪标签有 ${((dominantEmotionShare ?? 0) * 100).toFixed(0)}% 锁死在「${dominantEmotion}」：可按情绪铺垫、试探、动摇、收尾的层次微调 emotion，避免语音全程单调`
    )
  }
  if (calmOnCryOrSadFacialCount > 0) {
    reviewFocusPoints.push(
      `发现 ${calmOnCryOrSadFacialCount} 条哭泣/悲伤表情（face_cry_*/face_sad_*）错标为「平静」或空情绪：请在 update_talk 中改标为「伤心」，避免哭戏 TTS 笑场`
    )
  }
  if (talkCount >= 8 && missingCaptionCount === talkCount) {
    reviewFocusPoints.push(
      '当前草稿缺少逐句日语 ttsCaption（含哭腔/高潮 ttsSpecialScene）：建议在重要情感转折与高潮哭喊句补上 ttsCaption（严禁年龄/性别词）与 ttsSpecialScene: true（<=15%）'
    )
  }
  if (talkCount >= 12 && talkWithMotionShare > 0.9) {
    reviewFocusPoints.push(
      `说话带动作占比 ${(talkWithMotionShare * 100).toFixed(0)}% 偏满：可让约 15%~25% 的承接/情绪延续句省略 motion（自然保持姿态或只微调 facial），避免逐句乱动`
    )
  }

  return {
    snippetCount: snippets.length,
    talkCount,
    avgTalkChars,
    longLineShare,
    soloTalkShare,
    playSeCount,
    bgmCueCount,
    hasOpeningBgm,
    hasBgmSilenceCut,
    standaloneMotionCount,
    moveCount,
    waitCount,
    ambientColorCount,
    cameraOrShakeCount,
    talkWithMotionShare,
    talkFacialOnlyShare,
    talkStillShare,
    distinctMotionsUsed: distinctMotions.size,
    distinctFacialsUsed: distinctFacials.size,
    maxSameMotionRun,
    ...(dominantEmotion ? { dominantEmotion, dominantEmotionShare } : {}),
    reviewFocusPoints
  }
}
