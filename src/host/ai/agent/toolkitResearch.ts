import type { CatalogModel } from '../../resources/resourceCatalog'
import * as corpusExamplesMod from '../corpusExamples'
import * as facialSemanticsMod from '../facialSemantics'
import * as personasMod from '../personas'
import { isBackViewModel, isStandingMotion } from '../prompt'
import * as scenarioCuesMod from '../scenarioCues'
import { recommendForLine } from './actingAudit'
import {
  annotateMotion,
  corpusExamplesApi,
  expandMoodTokens,
  findModel,
  getActingProfile,
  inferDramaticMoodFallback,
  inspectMotion,
  scenarioCuesApi
} from './actingSemantics'
import type { ToolkitRuntimeContext } from './toolkitContext'

export async function executeResearchTool(
  ctx: ToolkitRuntimeContext,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<string | null> {
  const { view, personas, ragRetriever, logger } = ctx

  const buildModelExpressionOverview = (
    model: CatalogModel,
    options: {
      mood?: string
      moods?: string[]
      dialogueLine?: string
      emotion?: string
      kind?: string
      compact?: boolean
    } = {}
  ): Record<string, unknown> => {
    const mood = (options.mood ?? '').trim()
    const moodsArg = (options.moods ?? []).map((m) => m.trim()).filter(Boolean)
    const dialogueLine = (options.dialogueLine ?? '').trim()
    const emotion = (options.emotion ?? '').trim()
    const kind = options.kind ?? 'all'
    const compact = Boolean(options.compact)
    const profile = getActingProfile(`${model.name} ${model.path}`)

    // 结合全量模型动作与表情库（不局限于 34/28 提示词截断集），让 Agent 能调用到 face_cry_*、face_sad_02+、跨风格动作变体
    const curatedMotions = view.promptMotions(model)
    const fullMotions =
      model.motions && model.motions.length > curatedMotions.length
        ? [
            ...curatedMotions,
            ...model.motions.filter(
              (m) => !curatedMotions.includes(m) && !facialSemanticsMod.isSpecialOrStandingMotion(m)
            )
          ]
        : curatedMotions
    const curatedFacials = view.promptFacials(model)
    const fullFacials =
      model.facials && model.facials.length > curatedFacials.length
        ? [...curatedFacials, ...model.facials.filter((f) => !curatedFacials.includes(f))]
        : curatedFacials

    const filterBySemanticsForTokens = (
      items: string[],
      tokens: string[],
      labelFn: (item: string) => string,
      maxPerStem = 2
    ): string[] => {
      const isSadMood = tokens.some((t) =>
        /^(sad|cry|crying|trouble|worry|伤心|难过|哭|困扰|绝望)$/i.test(t)
      )
      const scored =
        tokens.length === 0
          ? items
          : items
              .map((item, idx) => {
                const hay = `${item} ${labelFn(item)}`.toLowerCase()
                const hits = tokens.filter((tok) => hay.includes(tok)).length
                const normalBonus = /^w-normal/i.test(item) ? 0.25 : 0
                const wrySmilePenalty =
                  isSadMood &&
                  /\b(wry_smile|tearful_smile|genuine_smile|closed_smile|smile)\b/.test(hay)
                    ? -2
                    : 0
                const trueCryBonus =
                  isSadMood && wrySmilePenalty === 0 && /\b(cry|sad)\b/.test(hay) ? 0.5 : 0
                return {
                  item,
                  score: hits + normalBonus + trueCryBonus + wrySmilePenalty,
                  hits,
                  idx
                }
              })
              .filter((entry) => entry.hits > 0 && entry.score > 0)
              .sort((a, b) => b.score - a.score || a.idx - b.idx)
              .map((entry) => entry.item)
      const base = scored.length > 0 ? scored : items
      // 同一 stem 最多取 maxPerStem 个变体，避免某一个词根占满整组（如全是 nod01..06）
      const stemCounts = new Map<string, number>()
      const diverse: string[] = []
      for (const item of base) {
        const stem = item
          .toLowerCase()
          .replace(/^w-[a-z]+-/, '')
          .replace(/^face_/, '')
          .replace(/[_-]?\d+[a-z]?$/i, '')
        const cnt = stemCounts.get(stem) ?? 0
        if (cnt >= maxPerStem) continue
        stemCounts.set(stem, cnt + 1)
        diverse.push(item)
      }
      return diverse.length > 0 ? diverse : base
    }

    const facialLabelFn = (f: string): string =>
      `${facialSemanticsMod.inspectModelFacial(model.path, f).role} ${facialSemanticsMod.inspectModelFacial(model.path, f).label}`
    const motionLabelFn = (m: string): string => inspectMotion(model.path, m).label

    const targetMoods =
      moodsArg.length > 0
        ? moodsArg.slice(0, 8)
        : !mood && !dialogueLine && !emotion
          ? ['平静', '开心', '伤心', '困扰', '生气', '惊讶', '害羞']
          : []

    const perMoodFacialLimit = compact ? 4 : 5
    const perMoodMotionLimit = compact ? 4 : 6
    const nonStandingMotions = fullMotions.filter((m) => !isStandingMotion(m))
    const byMood: Record<string, { facials?: string[]; motions?: string[] }> = {}
    if (targetMoods.length > 0) {
      for (const mKey of targetMoods) {
        const mTokens = expandMoodTokens(mKey)
        const entry: { facials?: string[]; motions?: string[] } = {}
        if (kind !== 'motion') {
          entry.facials = filterBySemanticsForTokens(fullFacials, mTokens, facialLabelFn, 2)
            .slice(0, perMoodFacialLimit)
            .map((f) => facialSemanticsMod.annotateFacialName(model.path, f))
        }
        if (kind !== 'facial') {
          entry.motions = filterBySemanticsForTokens(nonStandingMotions, mTokens, motionLabelFn, 2)
            .slice(0, perMoodMotionLimit)
            .map((m) => annotateMotion(model.path, m))
        }
        byMood[mKey] = entry
      }
    }

    const tokens = mood ? expandMoodTokens(mood) : []
    const motions =
      kind === 'facial' || compact
        ? []
        : filterBySemanticsForTokens(fullMotions, tokens, motionLabelFn, 2)
            .slice(0, targetMoods.length > 0 ? 14 : 24)
            .map((m) => annotateMotion(model.path, m))

    const facials =
      kind === 'motion' || compact
        ? []
        : filterBySemanticsForTokens(fullFacials, tokens, facialLabelFn, 2)
            .slice(0, targetMoods.length > 0 ? 14 : 24)
            .map((f) => facialSemanticsMod.annotateFacialName(model.path, f))

    const recommended =
      dialogueLine || emotion || mood
        ? recommendForLine(view, model, {
            content: dialogueLine || mood,
            emotion,
            restrainedRole: profile.restrained,
            limit: 4
          })
        : null

    return {
      modelId: model.id,
      name: view.shortName(model),
      restrained: profile.restrained,
      actingNote: profile.actingNote,
      ...(Object.keys(byMood).length > 0 ? { byMood } : {}),
      ...(recommended
        ? {
            recommended: {
              mood: recommended.mood,
              facials: recommended.facials.map((f) =>
                facialSemanticsMod.annotateFacialName(model.path, f)
              ),
              motions: recommended.motions.map((m) => annotateMotion(model.path, m))
            }
          }
        : {}),
      ...(motions.length > 0 ? { motions } : {}),
      ...(facials.length > 0 ? { facials } : {})
    }
  }

  const resolveBatchModels = (
    args: Record<string, unknown>,
    lookupOpts: { unitHint?: string; contextText?: string } = {}
  ): CatalogModel[] => {
    const picked: CatalogModel[] = []
    const seen = new Set<number>()
    const addIfFound = (m: CatalogModel | null): void => {
      if (m && !seen.has(m.id)) {
        seen.add(m.id)
        picked.push(m)
      }
    }
    if (Array.isArray(args.modelIds)) {
      for (const id of args.modelIds) addIfFound(findModel(view, id, undefined, lookupOpts))
    }
    if (Array.isArray(args.characters)) {
      for (const c of args.characters) addIfFound(findModel(view, undefined, c, lookupOpts))
    }
    if (args.modelId !== undefined || args.character !== undefined) {
      addIfFound(findModel(view, args.modelId, args.character, lookupOpts))
    }
    return picked
  }

  if (name === 'lookup_character') {
    const unitHint = typeof args.unitHint === 'string' ? args.unitHint.trim() : ''
    const contextText = typeof args.contextText === 'string' ? args.contextText.trim() : ''
    const effectiveUnitHint = unitHint || personasMod.inferUnitFromText(contextText) || ''
    const lookupOpts = {
      ...(effectiveUnitHint ? { unitHint: effectiveUnitHint } : {}),
      ...(contextText ? { contextText } : {})
    }
    const requestedBatch = resolveBatchModels(args, lookupOpts)
    const hasExplicitFilter =
      Array.isArray(args.characters) ||
      Array.isArray(args.modelIds) ||
      args.character !== undefined ||
      args.modelId !== undefined
    const list = hasExplicitFilter ? requestedBatch : view.primaryModels()
    const includeExpressions = Boolean(args.includeExpressions)
    const moodsArg = Array.isArray(args.moods)
      ? args.moods.map((m) => String(m ?? '').trim()).filter(Boolean)
      : undefined
    const pairwiseAddressBook =
      list.length >= 2
        ? personasMod.extractPairwiseAddressBook(
            personas,
            list.map((m) => view.shortName(m)),
            lookupOpts
          )
        : []
    return JSON.stringify({
      characters: list.map((m) => {
        const persona = personasMod.personaFor(personas, m, {
          unitHint: effectiveUnitHint || personasMod.normalizeUnit(m.unit),
          ...(contextText ? { contextText } : {})
        })
        const profile = getActingProfile(`${m.name} ${m.path}`)
        const allFrontOutfits = view.outfitsFor(m).filter((o) => !isBackViewModel(o))
        const recommendedOutfit = contextText ? view.resolveOutfitVariant(m, contextText) : null
        const orderedOutfits = recommendedOutfit
          ? [recommendedOutfit, ...allFrontOutfits.filter((o) => o.id !== recommendedOutfit.id)]
          : allFrontOutfits
        const outfits = orderedOutfits.slice(0, 8).map((o) => ({
          modelId: o.id,
          label: o.outfitLabel || o.outfitCategory || o.cloudId || '默认',
          ...(recommendedOutfit?.id === o.id ? { recommended: true } : {})
        }))
        const exprBlock = includeExpressions
          ? buildModelExpressionOverview(m, { moods: moodsArg, compact: true })
          : null
        const dialoguePersona = persona ? personasMod.dialoguePersonaPrompt(persona, 11000) : ''
        const planningHighlights = persona ? personasMod.planningPersonaPrompt(persona, 3200) : ''
        const actingNotes = persona ? personasMod.actingPersonaPrompt(persona, 2200) : ''
        return {
          modelId: m.id,
          name: m.name,
          shortName: view.shortName(m),
          path: m.path,
          ...(m.unit ? { unit: m.unit } : {}),
          ...(persona?.unit ? { personaUnit: persona.unit } : {}),
          ...(persona?.isVariant ? { personaVariant: persona.name } : {}),
          ...(m.outfitLabel ? { outfitLabel: m.outfitLabel } : {}),
          ...(outfits.length > 1 ? { availableOutfits: outfits } : {}),
          actingProfile: profile,
          ...(actingNotes ? { actingNotes } : {}),
          ...(planningHighlights ? { planningHighlights } : {}),
          persona: dialoguePersona || '（按该角色官方设定演绎）',
          ...(exprBlock?.byMood ? { expressionsByMood: exprBlock.byMood } : {})
        }
      }),
      ...(pairwiseAddressBook.length > 0 ? { pairwiseAddressBook } : {})
    })
  }

  if (name === 'inspect_character_expressions') {
    const mood = typeof args.mood === 'string' ? args.mood.trim() : ''
    const moodsArg = Array.isArray(args.moods)
      ? args.moods.map((m) => String(m ?? '').trim()).filter(Boolean)
      : []
    const dialogueLine = typeof args.dialogueLine === 'string' ? args.dialogueLine.trim() : ''
    const emotion = typeof args.emotion === 'string' ? args.emotion.trim() : ''
    const kind = typeof args.kind === 'string' ? args.kind : 'all'

    const isBatch = Array.isArray(args.modelIds) || Array.isArray(args.characters)
    if (isBatch) {
      const models = resolveBatchModels(args)
      if (models.length === 0) {
        return JSON.stringify({
          error: '未找到指定角色',
          available: view.models.map((m) => ({ modelId: m.id, name: view.shortName(m) }))
        })
      }
      return JSON.stringify({
        characters: models.map((m) =>
          buildModelExpressionOverview(m, {
            mood,
            moods: moodsArg,
            dialogueLine,
            emotion,
            kind,
            compact: models.length >= 2
          })
        )
      })
    }

    const model = findModel(view, args.modelId, args.character)
    if (!model) {
      return JSON.stringify({
        error: '未找到指定角色',
        available: view.models.map((m) => ({ modelId: m.id, name: view.shortName(m) }))
      })
    }
    return JSON.stringify(
      buildModelExpressionOverview(model, {
        mood,
        moods: moodsArg,
        dialogueLine,
        emotion,
        kind
      })
    )
  }

  if (name === 'recommend_acting_for_lines') {
    let rawLines: Array<Record<string, unknown>> = Array.isArray(args.lines)
      ? (args.lines as Array<Record<string, unknown>>)
      : []
    if ((rawLines.length === 0 || args.useCurrentDraft === true) && ctx.state.savedDraft) {
      const snippets = Array.isArray(ctx.state.savedDraft.snippets)
        ? (ctx.state.savedDraft.snippets as Array<Record<string, unknown>>)
        : []
      const filterIdxSet = Array.isArray(args.snippetIndices)
        ? new Set(
            args.snippetIndices
              .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
              .map((n) => Math.floor(n))
          )
        : null
      let issueIdxSet: Set<number> | null = null
      if (args.onlyIssues === true) {
        try {
          const report = ctx.auditDraftCandidate(ctx.state.savedDraft).actingReport
          issueIdxSet = new Set(report.diagnostics.map((d) => d.snippetIndex))
        } catch {
          issueIdxSet = null
        }
      }
      const onStage = new Set<number>()
      const extracted: Array<Record<string, unknown>> = []
      for (let idx = 0; idx < snippets.length; idx++) {
        const s = snippets[idx]
        if (!s || typeof s !== 'object') continue
        const d = (s.data && typeof s.data === 'object' ? s.data : {}) as Record<string, unknown>
        if (s.type === 'LayoutAppear' && typeof d.modelId === 'number') onStage.add(d.modelId)
        else if (s.type === 'LayoutClear' && typeof d.modelId === 'number')
          onStage.delete(d.modelId)
        if (s.type !== 'Talk') continue
        if (filterIdxSet && !filterIdxSet.has(idx)) continue
        if (issueIdxSet && !issueIdxSet.has(idx)) continue
        const speakerId = typeof d.modelId === 'number' ? d.modelId : -1
        const listenerId = [...onStage].find((id) => id !== speakerId)
        extracted.push({
          id: `snippets[${idx}]`,
          snippetIndex: idx,
          modelId: speakerId,
          speaker: typeof d.speaker === 'string' ? d.speaker : '',
          content: typeof d.content === 'string' ? d.content : '',
          emotion: typeof d.emotion === 'string' ? d.emotion : '',
          ...(listenerId !== undefined ? { listenerModelId: listenerId } : {})
        })
      }
      rawLines = extracted
    }

    const defaultPerLineLimit = rawLines.length > 8 ? 2 : 4
    const perLineLimit =
      typeof args.limit === 'number' && Number.isFinite(args.limit)
        ? Math.max(1, Math.min(4, Math.round(args.limit)))
        : defaultPerLineLimit
    const recommendations: Array<Record<string, unknown>> = []
    const lastFacial = new Map<number, string>()
    const lastMotion = new Map<number, string>()
    let prevContent = ''
    let prevEmotion = ''
    let prevTense = false
    let hasAnyListener = false

    for (let i = 0; i < rawLines.length; i++) {
      const raw = rawLines[i]
      if (!raw || typeof raw !== 'object') continue
      const rec = raw
      const content = typeof rec.content === 'string' ? rec.content : ''
      const emotion = typeof rec.emotion === 'string' ? rec.emotion : ''
      const isListener = Boolean(rec.isListener)
      const isMonologue = Boolean(rec.isMonologue)
      const model = findModel(view, rec.modelId, rec.speaker)
      if (!model) {
        recommendations.push({
          id: typeof rec.id === 'string' ? rec.id : `l${i + 1}`,
          error: '未找到对应角色模型'
        })
        continue
      }
      const profile = getActingProfile(`${model.name} ${model.path}`)
      const advised = recommendForLine(view, model, {
        content,
        emotion,
        prevContent,
        prevEmotion,
        prevTense,
        isListener,
        isMonologue,
        restrainedRole: profile.restrained,
        prevFacial: lastFacial.get(model.id),
        prevMotion: lastMotion.get(model.id),
        limit: perLineLimit
      })
      if (advised.facials[0]) lastFacial.set(model.id, advised.facials[0])
      if (advised.motions[0]) lastMotion.set(model.id, advised.motions[0])

      let listenerReaction: Record<string, unknown> | undefined
      const listenerModel =
        rec.listenerModelId !== undefined || rec.listenerSpeaker !== undefined
          ? findModel(view, rec.listenerModelId, rec.listenerSpeaker)
          : null
      if (listenerModel && listenerModel.id !== model.id) {
        hasAnyListener = true
        const lProfile = getActingProfile(`${listenerModel.name} ${listenerModel.path}`)
        const lAdvised = recommendForLine(view, listenerModel, {
          content,
          emotion,
          prevContent,
          prevEmotion,
          prevTense,
          isListener: true,
          restrainedRole: lProfile.restrained,
          prevFacial: lastFacial.get(listenerModel.id),
          prevMotion: lastMotion.get(listenerModel.id),
          limit: Math.min(2, perLineLimit)
        })
        if (lAdvised.facials[0]) lastFacial.set(listenerModel.id, lAdvised.facials[0])
        if (lAdvised.motions[0]) lastMotion.set(listenerModel.id, lAdvised.motions[0])
        listenerReaction = {
          modelId: listenerModel.id,
          speaker: view.shortName(listenerModel),
          suggestedAt: 0,
          preferFacialOnly: true,
          inferredMood: lAdvised.mood,
          recommendedFacials: lAdvised.facials.map((f) => ({
            name: f,
            label: facialSemanticsMod.inspectModelFacial(listenerModel.path, f).label
          })),
          recommendedMotions: lAdvised.motions.map((m) => ({
            name: m,
            label: inspectMotion(listenerModel.path, m).label
          }))
        }
      }

      const ctx = inferDramaticMoodFallback({
        content,
        emotion,
        prevContent,
        prevEmotion,
        isMonologue,
        isListener
      })
      prevTense = ctx.tense
      prevContent = content
      prevEmotion = emotion

      recommendations.push({
        id: typeof rec.id === 'string' ? rec.id : `l${i + 1}`,
        ...(typeof rec.snippetIndex === 'number' ? { snippetIndex: rec.snippetIndex } : {}),
        modelId: model.id,
        speaker: view.shortName(model),
        restrained: profile.restrained,
        inferredMood: advised.mood,
        recommendedFacials: advised.facials.map((f) => ({
          name: f,
          label: facialSemanticsMod.inspectModelFacial(model.path, f).label
        })),
        recommendedMotions: advised.motions.map((m) => ({
          name: m,
          label: inspectMotion(model.path, m).label
        })),
        ...(listenerReaction ? { listenerReaction } : {})
      })
    }
    return JSON.stringify({
      ...(hasAnyListener
        ? {
            listenerNote:
              '官方 PJSK 节奏：听者反应优先通过切镜/原地 Move/短停顿，或句首 at: 0 纯切 facial 表达，避免在句中 at: 0.5..0.85 塞入听者身体动作'
          }
        : {}),
      recommendations
    })
  }

  if (name === 'search_assets') {
    const rawKinds = Array.isArray(args.kinds)
      ? args.kinds.map((k) => String(k ?? '').trim()).filter(Boolean)
      : []
    const kindSet = new Set<string>(
      rawKinds.length > 0 ? rawKinds : [typeof args.kind === 'string' ? args.kind : 'all']
    )
    const wantsAll = kindSet.has('all')
    const rawQueries = Array.isArray(args.queries)
      ? args.queries.map((q) => String(q ?? '').trim()).filter(Boolean)
      : []
    const singleQuery = typeof args.query === 'string' ? args.query.trim() : ''
    const queryList =
      rawQueries.length > 0 ? rawQueries.slice(0, 6) : singleQuery ? [singleQuery] : ['']
    const limit =
      typeof args.limit === 'number' && Number.isFinite(args.limit)
        ? Math.max(1, Math.min(25, Math.round(args.limit)))
        : 12
    const result: Record<string, unknown> = {}

    if (wantsAll || kindSet.has('background')) {
      const bgMap = new Map<string, Record<string, unknown>>()
      for (const q of queryList) {
        for (const b of view.imagePromptChoices(limit, q)) {
          if (!bgMap.has(b.file)) {
            bgMap.set(b.file, {
              file: b.file,
              name: b.name,
              timeOfDay: b.timeOfDay,
              indoor: b.indoor,
              description: b.description
            })
          }
        }
      }
      result.backgrounds = [...bgMap.values()].slice(0, limit)
    }
    if (wantsAll || kindSet.has('bgm')) {
      const bgmMap = new Map<string, Record<string, unknown>>()
      for (const q of queryList) {
        for (const b of view.bgmPromptChoices(limit, q)) {
          if (!bgmMap.has(b.file)) {
            bgmMap.set(b.file, {
              file: b.file,
              name: b.name,
              mood: b.mood,
              tempo: b.tempo,
              description: b.description
            })
          }
        }
      }
      result.bgm = [...bgmMap.values()].slice(0, limit)
    }
    if (wantsAll || kindSet.has('se')) {
      const seItems =
        view.seDetailsList().length > 0
          ? view.seDetailsList().map((s) => ({
              file: s.file,
              name: s.name,
              category: s.category,
              description: s.description
            }))
          : scenarioCuesMod.CURATED_SCENARIO_SES.map((s) => ({
              file: s.file,
              name: s.id,
              category: s.category,
              description: s.description
            }))
      const seMap = new Map<string, (typeof seItems)[number]>()
      for (const qRaw of queryList) {
        const q = qRaw.toLowerCase()
        const matched = q
          ? seItems.filter((s) =>
              `${s.file} ${s.name} ${s.category ?? ''} ${s.description}`.toLowerCase().includes(q)
            )
          : seItems
        for (const item of matched) {
          if (!seMap.has(item.file)) seMap.set(item.file, item)
        }
      }
      result.se = (seMap.size > 0 ? [...seMap.values()] : seItems).slice(0, limit)
    }
    if (wantsAll || kindSet.has('effect')) {
      result.effects = [...scenarioCuesMod.CURATED_SCENARIO_EFFECTS]
    }
    if (kindSet.has('outfit')) {
      const model = findModel(view, args.modelId, args.character)
      if (model) {
        const combinedQuery = queryList.filter(Boolean).join(' ')
        const matched = combinedQuery ? view.resolveOutfitVariant(model, combinedQuery) : null
        result.outfits = view
          .outfitsFor(model)
          .slice(0, limit)
          .map((o) => ({
            modelId: o.id,
            path: o.path,
            outfitCategory: o.outfitCategory,
            outfitLabel: o.outfitLabel,
            isBackView: isBackViewModel(o),
            recommended: matched?.id === o.id
          }))
      } else {
        result.outfits = []
        result.note = '查询服装请传入 character 或 modelId'
      }
    }
    const combinedCueQuery = queryList.filter(Boolean).join(' ')
    if (combinedCueQuery && typeof scenarioCuesApi.recommendScenarioCues === 'function') {
      result.cueRecommendations = scenarioCuesApi.recommendScenarioCues(combinedCueQuery)
    }
    return JSON.stringify(result)
  }

  if (name === 'search_official_corpus') {
    const modeRaw = typeof args.mode === 'string' ? args.mode.trim() : 'search'
    const mode: 'search' | 'expand' | 'list_stories' =
      modeRaw === 'expand' || modeRaw === 'list_stories' ? modeRaw : 'search'
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    const stage: 'cast' | 'dialogue' = args.stage === 'cast' ? 'cast' : 'dialogue'
    const actingGuidelines =
      typeof corpusExamplesApi.getOfficialActingGuidelines === 'function'
        ? corpusExamplesApi.getOfficialActingGuidelines({
            castCount: ctx.state.savedPlan?.cast.length ?? view.primaryModels().length,
            isFlashback: /回忆|过去|以前/.test(query),
            isSekai: /sekai|世界/i.test(query)
          })
        : '官方PJSK规范：同场景连续对话保持1幕；允许短时单人Center内省留白再切回Left/Right；口语台词禁用括号动作提示；约75%~80%台词句首单拍动作，90%+ delay=0，双人各有动作切换且不同瞬碰撞。'

    if (mode === 'list_stories') {
      const limit =
        typeof args.limit === 'number' && Number.isFinite(args.limit)
          ? Math.max(1, Math.min(50, Math.round(args.limit)))
          : 20
      const stories = ragRetriever
        ? ragRetriever.listAvailableStories({
            ...(query ? { query } : {}),
            ...(typeof args.unit === 'string' && args.unit.trim()
              ? { unit: args.unit.trim() }
              : {}),
            ...(args.recentOnly === true ? { recentOnly: true } : {}),
            limit
          })
        : []
      return JSON.stringify({
        mode: 'list_stories',
        stories,
        actingGuidelines
      })
    }

    if (mode === 'expand') {
      const scenarioId = typeof args.scenarioId === 'string' ? args.scenarioId.trim() : ''
      const aroundLine =
        typeof args.aroundLine === 'number' && Number.isFinite(args.aroundLine)
          ? args.aroundLine
          : undefined
      const radiusChunks =
        typeof args.radiusChunks === 'number' && Number.isFinite(args.radiusChunks)
          ? Math.max(0, Math.min(6, Math.round(args.radiusChunks)))
          : 2
      if (!scenarioId) {
        return JSON.stringify({
          mode: 'expand',
          found: false,
          error: 'mode="expand" 需要传入 scenarioId（可先从 search 或 list_stories 获取）'
        })
      }
      const context = ragRetriever
        ? ragRetriever.expandScenarioContext(scenarioId, aroundLine, radiusChunks)
        : null
      return JSON.stringify({
        mode: 'expand',
        found: Boolean(context),
        context: context
          ? {
              scenarioId: context.scenarioId,
              storyId: context.storyId,
              story: context.story,
              ep: context.ep,
              epTitle: context.epTitle,
              unit: context.unit,
              eventNum: context.eventNum,
              isRecent2025_2026: context.isRecent2025_2026,
              lang: context.lang,
              lineStart: context.lineStart,
              lineEnd: context.lineEnd,
              totalChunks: context.totalChunks,
              text: context.text
            }
          : null,
        actingGuidelines
      })
    }

    const excerpts = corpusExamplesMod.selectUnitFewShotExcerpts(
      view
        .primaryModels()
        .slice(0, 3)
        .map((m) => ({ name: view.shortName(m), path: m.path })),
      query
    )
    const castHints = Array.isArray(args.cast)
      ? args.cast
          .map((c) => findModel(view, undefined, c))
          .filter((m): m is CatalogModel => Boolean(m))
          .map((m) => ({ name: view.shortName(m), fullName: m.name }))
      : view
          .primaryModels()
          .slice(0, 4)
          .map((m) => ({ name: view.shortName(m), fullName: m.name }))

    let ragText = ''
    let expandedContexts: Array<Record<string, unknown>> = []
    let availableStories: Array<Record<string, unknown>> = []
    if (ragRetriever && query) {
      try {
        const structured = await ragRetriever.searchStructured(
          {
            prompt: query,
            stage,
            cast: castHints,
            signal
          },
          {
            expandContextRadius: 1,
            includeAvailableStories: true,
            storyCatalogLimit: 12
          }
        )
        ragText = structured.promptBlock ?? ''
        expandedContexts = structured.expandedContexts.map((c) => ({
          scenarioId: c.scenarioId,
          storyId: c.storyId,
          story: c.story,
          epTitle: c.epTitle,
          unit: c.unit,
          eventNum: c.eventNum,
          isRecent2025_2026: c.isRecent2025_2026,
          lang: c.lang,
          lineStart: c.lineStart,
          lineEnd: c.lineEnd,
          text: c.text
        }))
        availableStories = structured.availableStories.map((s) => ({
          storyId: s.storyId,
          story: s.story,
          unit: s.unit,
          eventNum: s.eventNum,
          isRecent2025_2026: s.isRecent2025_2026,
          lang: s.lang,
          scenarios: s.scenarios.slice(0, 4)
        }))
      } catch (error) {
        if (signal?.aborted) throw error
        logger.debug(`[AgentTool] RAG query failed: ${String(error)}`)
      }
    }
    return JSON.stringify({
      mode: 'search',
      note: '仅学习称呼、断句、潜台词与留白节奏，严禁照抄原句；可传 mode:"expand" + scenarioId 查看完整前后剧情',
      actingGuidelines,
      excerpts: ragText || excerpts || '（当前查询暂无额外语料，请严格遵循角色口吻）',
      ...(expandedContexts.length > 0 ? { expandedContexts } : {}),
      ...(availableStories.length > 0 ? { availableStories } : {})
    })
  }

  return null
}
