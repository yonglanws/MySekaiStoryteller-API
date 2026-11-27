import type { StoryData } from '../../../common/types/Story'
import type { CatalogModel } from '../../resources/resourceCatalog'
import { lintDialogueFidelity, repairSpokenStageDirections } from '../dialogueLinter'
import { extractJson } from '../llm'
import * as personasMod from '../personas'
import {
  applyVoiceDirectionPlan,
  buildDirectionPrompt,
  buildEmotionPrompt,
  buildStagingPrompt,
  composeStory,
  fallbackDirection,
  fallbackStaging,
  normalizeDialogue,
  normalizeDirection,
  normalizeStaging,
  normalizeVoiceDirectionPlan,
  resolveCastPersonas,
  type StagedCastPlan,
  type StagedDialogue,
  type StagedDirection,
  type StagedDirectionLine,
  type StagedPairwiseAddress,
  type StagedScenePlan,
  type StagedStaging
} from '../staged'
import { alignStoryTtsEmotionsAndCaptions } from '../ttsText'
import { validateAndFixStory } from '../validate'
import { recommendForLine } from './actingAudit'
import { findModel, getActingProfile, inferDramaticMoodFallback } from './actingSemantics'
import type { ToolkitRuntimeContext } from './toolkitContext'

export async function executeCompileDialogueWorkflow(
  ctx: ToolkitRuntimeContext,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<string | null> {
  const { view, personas, emotionLabels, targetMinutes, llm, logger } = ctx

  if (name === 'compile_dialogue_workflow') {
    const title =
      typeof args.title === 'string' && args.title.trim()
        ? args.title.trim()
        : (ctx.state.savedPlan?.title ?? '')
    const event =
      typeof args.event === 'string' && args.event.trim()
        ? args.event.trim()
        : (ctx.state.savedPlan?.event ?? title)
    const logline =
      typeof args.logline === 'string' && args.logline.trim()
        ? args.logline.trim()
        : (ctx.state.savedPlan?.logline ?? '')
    const contextText = `${event}\n${logline}`
    const unitHint = personasMod.inferUnitFromText(contextText)

    // 1. 解析 cast（优先 args.cast -> savedPlan.cast -> lines[].speaker -> primaryModels）
    const resolvedCast: StagedCastPlan['cast'] = []
    const seenCastIds = new Set<number>()
    const pushCastModel = (m: CatalogModel | null, role = ''): void => {
      if (!m || seenCastIds.has(m.id)) return
      seenCastIds.add(m.id)
      resolvedCast.push({
        modelId: m.id,
        name: view.shortName(m),
        fullName: m.name || view.shortName(m),
        path: m.path,
        role
      })
    }

    if (Array.isArray(args.cast)) {
      for (const item of args.cast) {
        if (!item || typeof item !== 'object') continue
        const rec = item as Record<string, unknown>
        const outfit = typeof rec.outfit === 'string' ? rec.outfit.trim() : ''
        const m = findModel(view, rec.modelId, rec.name, {
          ...(unitHint ? { unitHint } : {}),
          contextText: outfit || contextText
        })
        pushCastModel(m, typeof rec.role === 'string' ? rec.role.trim() : '')
      }
    }
    if (resolvedCast.length === 0 && ctx.state.savedPlan?.cast?.length) {
      for (const c of ctx.state.savedPlan.cast) {
        pushCastModel(
          findModel(view, c.modelId, c.name, {
            ...(unitHint ? { unitHint } : {}),
            contextText
          }),
          c.role
        )
      }
    }

    // 提前扫一遍 lines / turns 的 speaker 以防 cast 未显式传入
    const rawTurns = Array.isArray(args.turns) ? args.turns : []
    const rawLinesInput = Array.isArray(args.lines) ? args.lines : []
    if (resolvedCast.length === 0) {
      const speakerCandidates: string[] = []
      for (const t of rawTurns) {
        if (
          t &&
          typeof t === 'object' &&
          typeof (t as Record<string, unknown>).speaker === 'string'
        ) {
          speakerCandidates.push(String((t as Record<string, unknown>).speaker))
        }
      }
      for (const l of rawLinesInput) {
        if (
          l &&
          typeof l === 'object' &&
          typeof (l as Record<string, unknown>).speaker === 'string'
        ) {
          speakerCandidates.push(String((l as Record<string, unknown>).speaker))
        }
      }
      for (const sp of speakerCandidates) {
        pushCastModel(
          findModel(view, undefined, sp, { ...(unitHint ? { unitHint } : {}), contextText })
        )
      }
    }
    if (resolvedCast.length === 0) {
      for (const m of view.primaryModels().slice(0, 2)) pushCastModel(m)
    }

    const defaultBg =
      view.canonicalImage(args.background) ??
      ctx.state.savedPlan?.scenes?.[0]?.background ??
      view.defaultImage()
    const defaultAmbient: 'normal' | 'evening' | 'night' =
      args.ambient === 'evening' || args.ambient === 'night' ? args.ambient : 'normal'
    const explicitBgm =
      typeof args.bgm === 'string' && args.bgm.trim()
        ? (view.canonicalBgm(args.bgm.trim()) ?? '')
        : ''

    const rawScenes = Array.isArray(args.scenes) ? args.scenes : []
    const compiledScenes: StagedScenePlan[] =
      rawScenes.length > 0
        ? rawScenes
            .filter((s): s is Record<string, unknown> => Boolean(s && typeof s === 'object'))
            .slice(0, 4)
            .map((s, idx) => {
              const bg = view.canonicalImage(s.background) ?? defaultBg
              const amb: 'normal' | 'evening' | 'night' =
                s.ambient === 'evening' || s.ambient === 'night' ? s.ambient : defaultAmbient
              const bgmRaw = typeof s.bgm === 'string' ? s.bgm.trim() : ''
              const sBgm =
                bgmRaw === 'silence' || bgmRaw === 'keep'
                  ? bgmRaw
                  : bgmRaw
                    ? (view.canonicalBgm(bgmRaw) ?? '')
                    : explicitBgm || undefined
              const transRaw = typeof s.transitionIn === 'string' ? s.transitionIn : 'black'
              const transitionIn =
                transRaw === 'sideFade' ||
                transRaw === 'flashback' ||
                transRaw === 'sekaiIn' ||
                transRaw === 'sekaiOut' ||
                transRaw === 'white'
                  ? transRaw
                  : 'black'
              return {
                id: typeof s.id === 'string' && s.id.trim() ? s.id.trim() : `s${idx + 1}`,
                summary: typeof s.summary === 'string' ? s.summary.trim() : '',
                background: bg,
                ambient: amb,
                ...(typeof s.telop === 'string' && s.telop.trim() ? { telop: s.telop.trim() } : {}),
                ...(typeof s.placeInfo === 'string' && s.placeInfo.trim()
                  ? { placeInfo: s.placeInfo.trim() }
                  : {}),
                transitionIn,
                ...(s.isFlashback ? { isFlashback: true } : {}),
                ...(s.isSekai ? { isSekai: true } : {}),
                activeCast: Array.isArray(s.activeCast)
                  ? s.activeCast.map((x) => String(x)).slice(0, 2)
                  : resolvedCast.slice(0, 2).map((c) => c.name),
                ...(sBgm ? { bgm: sBgm } : {})
              }
            })
        : ctx.state.savedPlan?.scenes?.length
          ? ctx.state.savedPlan.scenes.map((s) => ({
              id: s.id,
              summary: s.summary,
              background: s.background,
              ambient: s.ambient,
              transitionIn:
                s.transitionIn === 'sideFade' ||
                s.transitionIn === 'flashback' ||
                s.transitionIn === 'sekaiIn' ||
                s.transitionIn === 'sekaiOut' ||
                s.transitionIn === 'white'
                  ? s.transitionIn
                  : 'black',
              activeCast: s.activeCast,
              ...(s.bgm ? { bgm: s.bgm } : {}),
              ...(s.isFlashback ? { isFlashback: true } : {}),
              ...(s.isSekai ? { isSekai: true } : {})
            }))
          : [
              {
                id: 's1',
                summary: event || title,
                background: defaultBg,
                ambient: defaultAmbient,
                transitionIn: 'black',
                activeCast: resolvedCast.slice(0, 2).map((c) => c.name),
                ...(explicitBgm ? { bgm: explicitBgm } : {})
              }
            ]

    const pairwiseMap = new Map<string, StagedPairwiseAddress>()
    for (const r of personasMod.extractPairwiseAddressBook(
      personas,
      resolvedCast.map((c) => c.name),
      {
        ...(unitHint ? { unitHint } : {}),
        ...(contextText ? { contextText } : {})
      }
    )) {
      pairwiseMap.set(`${r.from}::${r.to}`, { from: r.from, to: r.to, zh: r.zh })
    }
    for (const p of [
      ...(ctx.state.savedPlan?.pairwiseAddress ?? []),
      ...(Array.isArray(args.pairwiseAddress)
        ? (args.pairwiseAddress as Array<Record<string, unknown>>).map((x) => ({
            from: String(x?.from ?? '').trim(),
            to: String(x?.to ?? '').trim(),
            zh: String(x?.zh ?? '').trim(),
            ...(typeof x?.ja === 'string' && x.ja.trim() ? { ja: x.ja.trim() } : {})
          }))
        : [])
    ]) {
      if (!p.from || !p.to || !p.zh) continue
      pairwiseMap.set(`${p.from}::${p.to}`, p)
    }

    const plan: StagedCastPlan = {
      title,
      event,
      logline,
      outline: ctx.state.savedPlan?.beats ?? [],
      cast: resolvedCast,
      background: compiledScenes[0]?.background || defaultBg,
      scenes: compiledScenes,
      ...(ctx.state.savedPlan?.understanding
        ? {
            understanding: {
              explicitRequests: ctx.state.savedPlan.understanding.explicitRequests ?? [],
              implicitSubtext: '',
              relationshipDynamic: '',
              emotionalArc: '',
              ...(ctx.state.savedPlan.understanding.turningPoint
                ? { turningPoint: ctx.state.savedPlan.understanding.turningPoint }
                : {}),
              ...(ctx.state.savedPlan.understanding.openingMotif
                ? { openingMotif: ctx.state.savedPlan.understanding.openingMotif }
                : {}),
              ...(ctx.state.savedPlan.understanding.closingCallback
                ? { closingCallback: ctx.state.savedPlan.understanding.closingCallback }
                : {}),
              canonHooks: ctx.state.savedPlan.understanding.canonHooks ?? [],
              avoidList: []
            }
          }
        : {}),
      ...(pairwiseMap.size > 0 ? { pairwiseAddress: [...pairwiseMap.values()] } : {})
    }

    const normalizedDialogue = normalizeDialogue(
      rawTurns.length > 0 ? { title, turns: rawTurns } : { title, lines: rawLinesInput },
      plan,
      120,
      emotionLabels
    )
    if (!normalizedDialogue || normalizedDialogue.lines.length < 2) {
      return JSON.stringify({
        compiled: false,
        error: '请提供至少 2 条有效台词（lines 或 turns），且说话人需匹配 cast 中的角色'
      })
    }

    // 保留调用方显式附带的 ttsCaption/ttsSpeed/ttsSpecialScene 与可选单句 motion/facial 覆盖（同时支持 turns 与 lines）
    type ExplicitLineMeta = {
      motion?: string
      facial?: string
      ttsCaption?: string
      ttsSpeed?: number
      ttsSpecialScene?: boolean
    }
    const extractMeta = (r: Record<string, unknown>): ExplicitLineMeta => ({
      ...(typeof r.motion === 'string' && r.motion.trim() ? { motion: r.motion.trim() } : {}),
      ...(typeof r.facial === 'string' && r.facial.trim() ? { facial: r.facial.trim() } : {}),
      ...(typeof r.ttsCaption === 'string' && r.ttsCaption.trim()
        ? { ttsCaption: r.ttsCaption.trim() }
        : {}),
      ...(typeof r.ttsSpeed === 'number' && Number.isFinite(r.ttsSpeed)
        ? { ttsSpeed: r.ttsSpeed }
        : {}),
      ...(r.ttsSpecialScene === true ? { ttsSpecialScene: true } : {})
    })
    const flatRawEntries: Array<{ content: string; meta: ExplicitLineMeta }> = []
    if (rawTurns.length > 0) {
      for (const turn of rawTurns) {
        if (!turn || typeof turn !== 'object') continue
        const tObj = turn as Record<string, unknown>
        const turnLines = Array.isArray(tObj.lines) ? tObj.lines : []
        for (const entry of turnLines) {
          if (typeof entry === 'string') {
            const content = entry.trim()
            if (content) flatRawEntries.push({ content, meta: {} })
          } else if (entry && typeof entry === 'object') {
            const r = entry as Record<string, unknown>
            const content =
              typeof r.content === 'string'
                ? r.content.trim()
                : typeof r.text === 'string'
                  ? r.text.trim()
                  : ''
            if (content) flatRawEntries.push({ content, meta: extractMeta(r) })
          }
        }
      }
    } else {
      for (const raw of rawLinesInput) {
        if (!raw || typeof raw !== 'object') continue
        const r = raw as Record<string, unknown>
        const content =
          typeof r.content === 'string'
            ? r.content.trim()
            : typeof r.text === 'string'
              ? r.text.trim()
              : ''
        if (content) flatRawEntries.push({ content, meta: extractMeta(r) })
      }
    }

    const explicitLineMeta = new Map<number, ExplicitLineMeta>()
    if (flatRawEntries.length === normalizedDialogue.lines.length) {
      flatRawEntries.forEach((entry, idx) => {
        explicitLineMeta.set(idx, entry.meta)
      })
    } else if (flatRawEntries.length > 0) {
      let cursor = 0
      for (let idx = 0; idx < normalizedDialogue.lines.length; idx++) {
        const normContent = normalizedDialogue.lines[idx].content.trim()
        const foundAt = flatRawEntries.findIndex(
          (entry, pos) =>
            pos >= cursor && (entry.content === normContent || normContent.includes(entry.content))
        )
        if (foundAt >= 0) {
          explicitLineMeta.set(idx, flatRawEntries[foundAt].meta)
          cursor = foundAt + 1
        }
      }
    }

    let dialogue: StagedDialogue = {
      ...normalizedDialogue,
      lines: normalizedDialogue.lines.map((line, idx) => {
        const meta = explicitLineMeta.get(idx)
        return {
          ...line,
          content: repairSpokenStageDirections(line.content),
          ...(meta?.ttsCaption ? { ttsCaption: meta.ttsCaption } : {}),
          ...(meta?.ttsSpeed !== undefined ? { ttsSpeed: meta.ttsSpeed } : {}),
          ...(meta?.ttsSpecialScene ? { ttsSpecialScene: true } : {})
        }
      })
    }

    const resolvedWorkflowPersonas = resolveCastPersonas(personas, plan.cast, view, contextText)
    const dialogueLint = lintDialogueFidelity(dialogue, {
      ...plan,
      personas: resolvedWorkflowPersonas
    })
    const useLlmStages = Boolean(llm?.enabled && args.runLlmStages !== false)
    const stagePromptOpts = {
      scene: event || title,
      personas,
      targetMinutes: targetMinutes ?? 3,
      emotionLabels
    }

    let staging: StagedStaging | null = null
    if (useLlmStages && llm) {
      try {
        const [emoRes, stgRes] = await Promise.all([
          emotionLabels.length > 0
            ? llm
                .chat(
                  [
                    {
                      role: 'system',
                      content: buildEmotionPrompt(plan, dialogue, stagePromptOpts).system
                    },
                    {
                      role: 'user',
                      content: buildEmotionPrompt(plan, dialogue, stagePromptOpts).user
                    }
                  ],
                  { json: true, temperature: 0.25, signal }
                )
                .catch((error) => {
                  if (signal?.aborted) throw error
                  return null
                })
            : Promise.resolve(null),
          llm
            .chat(
              [
                {
                  role: 'system',
                  content: buildStagingPrompt(view, plan, dialogue, stagePromptOpts).system
                },
                {
                  role: 'user',
                  content: buildStagingPrompt(view, plan, dialogue, stagePromptOpts).user
                }
              ],
              { json: true, signal }
            )
            .catch((error) => {
              if (signal?.aborted) throw error
              return null
            })
        ])
        if (emoRes) {
          const voicePlan = normalizeVoiceDirectionPlan(
            extractJson(emoRes.content),
            dialogue,
            emotionLabels
          )
          if (voicePlan) {
            dialogue = applyVoiceDirectionPlan(dialogue, voicePlan, emotionLabels)
          }
        }
        if (stgRes) {
          staging = normalizeStaging(extractJson(stgRes.content), view, plan, dialogue)
        }
      } catch (error) {
        if (signal?.aborted) throw error
        // 回退到确定性编译
      }
    }
    if (!staging) {
      staging = fallbackStaging(view, plan, dialogue)
    }

    // 构建表演设计：优先可选 LLM direction，否则确定性使用 recommendForLine + characterActingProfile
    let direction: StagedDirection | null = null
    if (useLlmStages && llm) {
      try {
        const dirPrompt = buildDirectionPrompt(view, plan, dialogue, stagePromptOpts, staging)
        const dirRes = await llm.chat(
          [
            { role: 'system', content: dirPrompt.system },
            { role: 'user', content: dirPrompt.user }
          ],
          { json: true, signal }
        )
        const parsedDir = normalizeDirection(extractJson(dirRes.content), view, plan, dialogue)
        if (parsedDir.lines.length > 0) direction = parsedDir
      } catch (error) {
        if (signal?.aborted) throw error
        // 回退确定性表演编译
      }
    }

    if (!direction) {
      const lastFacial = new Map<number, string>()
      const lastMotion = new Map<number, string>()
      const recentMotions = new Map<number, string[]>()
      const appeared = new Set<number>()
      let prevContent = ''
      let prevEmotion = ''
      let prevTense = false

      const dirLines: StagedDirectionLine[] = dialogue.lines.map((line, idx) => {
        const member =
          plan.cast.find((c) => c.name === line.speaker || c.fullName === line.speaker) ??
          plan.cast[0]
        const model = view.modelById(member.modelId)
        const meta = explicitLineMeta.get(idx)
        if (!model) {
          return {
            id: line.id,
            ...(meta?.motion ? { motion: meta.motion } : {}),
            ...(meta?.facial ? { facial: meta.facial } : {})
          }
        }
        const profile = getActingProfile(`${model.name} ${model.path}`, member.role)
        const recList = recentMotions.get(model.id) ?? []
        const advised = recommendForLine(view, model, {
          content: line.content,
          emotion: line.emotion,
          prevContent,
          prevEmotion,
          prevTense,
          isMonologue: /^[（(]/.test(line.content.trim()) && /[）)]$/.test(line.content.trim()),
          restrainedRole: profile.restrained,
          prevFacial: lastFacial.get(model.id),
          prevMotion: lastMotion.get(model.id),
          recentMotions: recList,
          limit: 4
        })
        const isFirstEntry = !appeared.has(model.id)
        appeared.add(model.id)
        const facial = meta?.facial || advised.facials[0] || view.neutralFacial(model.id)
        // 首句紧接 LayoutAppear 时留空 body motion，其余句子避免连续 4 句相同动作并跳过 20% 平稳过渡句
        const motionCandidate =
          meta?.motion ||
          (isFirstEntry
            ? ''
            : idx % 5 === 3 && advised.mood === 'neutral'
              ? ''
              : (advised.motions.find((m) => m !== lastMotion.get(model.id)) ??
                advised.motions[0] ??
                ''))
        if (facial) lastFacial.set(model.id, facial)
        if (motionCandidate) {
          lastMotion.set(model.id, motionCandidate)
          recentMotions.set(model.id, [...recList.slice(-4), motionCandidate])
        }
        const ctx = inferDramaticMoodFallback({
          content: line.content,
          emotion: line.emotion,
          prevContent,
          prevEmotion
        })
        prevTense = ctx.tense
        prevContent = line.content
        prevEmotion = line.emotion ?? ''

        return {
          id: line.id,
          ...(motionCandidate ? { motion: motionCandidate } : {}),
          ...(facial ? { facial } : {})
        }
      })

      const baseDir = fallbackDirection(view, plan)
      direction = {
        ...baseDir,
        background: staging.scenes[0]?.background || baseDir.background,
        ambient: staging.scenes[0]?.ambient || baseDir.ambient,
        bgm:
          staging.scenes[0]?.bgm &&
          staging.scenes[0].bgm !== 'keep' &&
          staging.scenes[0].bgm !== 'silence'
            ? staging.scenes[0].bgm
            : baseDir.bgm,
        lines: dirLines
      }
    }

    const composed = composeStory(view, plan, dialogue, direction, staging)
    alignStoryTtsEmotionsAndCaptions(composed as unknown as StoryData, { emotionLabels })
    const { story, warnings } = validateAndFixStory(composed, view, logger, { emotionLabels })

    const shouldSave = args.autoSaveDraft !== false
    const storyObj = story as unknown as Record<string, unknown>
    if (shouldSave) {
      const preservedUnderstanding =
        ctx.state.savedPlan?.understanding ??
        (args.turningPoint || args.openingMotif || args.closingCallback
          ? {
              explicitRequests: [],
              ...(typeof args.turningPoint === 'string' ? { turningPoint: args.turningPoint } : {}),
              ...(typeof args.openingMotif === 'string' ? { openingMotif: args.openingMotif } : {}),
              ...(typeof args.closingCallback === 'string'
                ? { closingCallback: args.closingCallback }
                : {}),
              canonHooks: []
            }
          : undefined)
      ctx.state.savedPlan = {
        title: plan.title,
        logline: plan.logline,
        event: plan.event,
        cast: plan.cast.map((c) => ({ modelId: c.modelId, name: c.name, role: c.role })),
        scenes: (plan.scenes ?? []).map((s) => ({
          id: s.id,
          summary: s.summary,
          background: s.background,
          ambient: s.ambient,
          transitionIn: s.transitionIn,
          activeCast: s.activeCast,
          ...(s.bgm ? { bgm: s.bgm } : {}),
          ...(s.isFlashback ? { isFlashback: true } : {}),
          ...(s.isSekai ? { isSekai: true } : {})
        })),
        beats: plan.outline,
        ...(preservedUnderstanding ? { understanding: preservedUnderstanding } : {}),
        ...(plan.pairwiseAddress ? { pairwiseAddress: plan.pairwiseAddress } : {})
      }
      ctx.state.savedDraft = structuredClone(storyObj)
      ctx.state.directorReview = null
      ctx.state.finalized = false
    }
    const audit = ctx.runCompactAudit(storyObj)
    return JSON.stringify({
      compiled: true,
      draftSaved: shouldSave,
      snippetCount: story.snippets.length,
      compileWarnings: warnings.slice(0, 10),
      dialogueLintIssues: dialogueLint.issues.slice(0, 10),
      ...(shouldSave ? {} : { story: storyObj }),
      ...audit
    })
  }

  return null
}
