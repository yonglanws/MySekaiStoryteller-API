import type { CatalogModel } from '../../resources/resourceCatalog'
import {
  hasSpokenStageDirectionLeak,
  lintDialogueFidelity,
  repairSpokenStageDirections
} from '../dialogueLinter'
import * as personasMod from '../personas'
import { resolveCastPersonas } from '../staged'
import { validateAndFixStory } from '../validate'
import {
  buildDirectorStageTelemetry,
  runActingAndFidelityAudit,
  type DirectorStageTelemetry
} from './actingAudit'
import { countBodyMotionsByModel, findModel, type ActingFidelityReport } from './actingSemantics'
import type { SavedStoryPlan, ToolkitRuntimeContext } from './toolkitContext'

export function executeDraftTool(
  ctx: ToolkitRuntimeContext,
  name: string,
  args: Record<string, unknown>
): string | null {
  const { view, personas, emotionLabels, targetMinutes, logger } = ctx

  if (name === 'plan_story_outline') {
    const warnings: string[] = []
    const rawCast = Array.isArray(args.cast) ? args.cast : []
    const resolvedCast: SavedStoryPlan['cast'] = []
    for (const item of rawCast) {
      if (!item || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>
      const m = findModel(view, rec.modelId, rec.name)
      if (!m) {
        warnings.push(`未找到角色：${String(rec.name ?? rec.modelId ?? '')}`)
        continue
      }
      resolvedCast.push({
        modelId: m.id,
        name: view.shortName(m),
        role: typeof rec.role === 'string' ? rec.role.trim() : ''
      })
    }
    if (resolvedCast.length === 0) {
      for (const m of view.primaryModels().slice(0, 2)) {
        resolvedCast.push({ modelId: m.id, name: view.shortName(m), role: '' })
      }
    }

    const rawScenes = Array.isArray(args.scenes) ? args.scenes : []
    const resolvedScenes: SavedStoryPlan['scenes'] = rawScenes
      .filter((s): s is Record<string, unknown> => Boolean(s && typeof s === 'object'))
      .slice(0, 4)
      .map((s, idx) => {
        const bgRaw = typeof s.background === 'string' ? s.background : ''
        const bg = view.canonicalImage(bgRaw) ?? view.defaultImage()
        if (bgRaw && !view.canonicalImage(bgRaw)) {
          warnings.push(`幕次 s${idx + 1} 背景「${bgRaw}」未精确匹配，已映射为「${bg}」`)
        }
        const bgmRaw = typeof s.bgm === 'string' ? s.bgm.trim() : ''
        const bgm =
          bgmRaw === 'silence' || bgmRaw === 'keep'
            ? bgmRaw
            : bgmRaw
              ? (view.canonicalBgm(bgmRaw) ?? '')
              : undefined
        if (bgmRaw && bgmRaw !== 'silence' && bgmRaw !== 'keep' && !bgm) {
          warnings.push(
            `幕次 s${idx + 1} BGM「${bgmRaw}」未在目录中找到，请调用 search_assets 核实`
          )
        }
        const ambientRaw = typeof s.ambient === 'string' ? s.ambient : 'normal'
        const ambient = ambientRaw === 'evening' || ambientRaw === 'night' ? ambientRaw : 'normal'
        return {
          id: typeof s.id === 'string' && s.id.trim() ? s.id.trim() : `s${idx + 1}`,
          summary: typeof s.summary === 'string' ? s.summary.trim() : '',
          background: bg,
          ambient,
          transitionIn: typeof s.transitionIn === 'string' ? s.transitionIn : 'black',
          activeCast: Array.isArray(s.activeCast)
            ? s.activeCast.map((x) => String(x)).slice(0, 2)
            : resolvedCast.slice(0, 2).map((c) => c.name),
          ...(bgm ? { bgm } : {}),
          ...(s.isFlashback ? { isFlashback: true } : {}),
          ...(s.isSekai ? { isSekai: true } : {})
        }
      })

    if (
      resolvedScenes.length >= 2 &&
      resolvedScenes.every(
        (s) =>
          s.background === resolvedScenes[0].background &&
          s.ambient === resolvedScenes[0].ambient &&
          !s.isFlashback &&
          !s.isSekai
      )
    ) {
      warnings.push(
        '提示：多幕背景与时段完全相同且非回忆/SEKAI，建议合并为 1 幕（不强制分幕，保持自然连续）'
      )
    }

    const rawPairs = Array.isArray(args.pairwiseAddress) ? args.pairwiseAddress : []
    const pairwiseAddress = rawPairs
      .filter((p): p is Record<string, unknown> => Boolean(p && typeof p === 'object'))
      .map((p) => ({
        from: String(p.from ?? '').trim(),
        to: String(p.to ?? '').trim(),
        zh: String(p.zh ?? '').trim(),
        ...(typeof p.ja === 'string' && p.ja.trim() ? { ja: p.ja.trim() } : {})
      }))
      .filter((p) => p.from && p.to && p.zh)

    ctx.state.savedPlan = {
      title: typeof args.title === 'string' ? args.title.trim() : '',
      logline: typeof args.logline === 'string' ? args.logline.trim() : '',
      event: typeof args.event === 'string' ? args.event.trim() : '',
      cast: resolvedCast,
      scenes: resolvedScenes,
      beats: Array.isArray(args.beats) ? args.beats.map((b) => String(b)) : [],
      ...(pairwiseAddress.length > 0 ? { pairwiseAddress } : {}),
      ...(args.turningPoint || args.openingMotif || args.closingCallback
        ? {
            understanding: {
              explicitRequests: [],
              ...(typeof args.turningPoint === 'string' ? { turningPoint: args.turningPoint } : {}),
              ...(typeof args.openingMotif === 'string' ? { openingMotif: args.openingMotif } : {}),
              ...(typeof args.closingCallback === 'string'
                ? { closingCallback: args.closingCallback }
                : {}),
              canonHooks: []
            }
          }
        : {})
    }

    return JSON.stringify({
      ok: true,
      plan: ctx.state.savedPlan,
      warnings
    })
  }

  if (name === 'validate_dialogue_draft') {
    const rawLines = Array.isArray(args.lines) ? args.lines : []
    const lines = rawLines
      .filter((l): l is Record<string, unknown> => Boolean(l && typeof l === 'object'))
      .map((l, idx) => ({
        id: typeof l.id === 'string' && l.id.trim() ? l.id.trim() : `l${idx + 1}`,
        speaker: typeof l.speaker === 'string' ? l.speaker.trim() : '',
        content: typeof l.content === 'string' ? l.content : ''
      }))
      .filter((l) => l.content.trim().length > 0)
    const speakerNames = Array.from(new Set(lines.map((l) => l.speaker).filter(Boolean)))
    const validateContextText = [
      typeof args.title === 'string' ? args.title : (ctx.state.savedPlan?.title ?? ''),
      ctx.state.savedPlan?.event ?? '',
      ctx.state.savedPlan?.logline ?? '',
      ...speakerNames,
      ...lines.slice(0, 6).map((l) => l.content)
    ]
      .filter(Boolean)
      .join('\n')
    const validateUnitHint = personasMod.inferUnitFromText(validateContextText)
    const validateLookupOpts: personasMod.PersonaLookupOptions | undefined =
      validateUnitHint || validateContextText
        ? {
            ...(validateUnitHint ? { unitHint: validateUnitHint } : {}),
            ...(validateContextText ? { contextText: validateContextText } : {})
          }
        : undefined
    const seededAddresses = [
      ...personasMod
        .extractPairwiseAddressBook(personas, speakerNames, validateLookupOpts)
        .map((r) => ({
          from: r.from,
          to: r.to,
          zh: r.zh
        })),
      ...(ctx.state.savedPlan?.pairwiseAddress ?? [])
    ]
    const validateCast = ctx.state.savedPlan?.cast?.length
      ? ctx.state.savedPlan.cast.map((c) => {
          const m = view.modelById(c.modelId)
          return {
            modelId: c.modelId,
            name: c.name,
            fullName: m?.name ?? c.name,
            path: m?.path ?? '',
            role: c.role ?? ''
          }
        })
      : speakerNames
          .map((sp) => findModel(view, undefined, sp, validateLookupOpts))
          .filter((m): m is CatalogModel => Boolean(m))
          .map((m) => ({
            modelId: m.id,
            name: view.shortName(m),
            fullName: m.name,
            path: m.path,
            role: ''
          }))
    const resolvedValidatePersonas =
      validateCast.length > 0
        ? resolveCastPersonas(personas, validateCast, view, validateContextText)
        : speakerNames
            .map((sp) => personasMod.resolvePersonaByName(personas, sp, validateLookupOpts))
            .filter((p): p is personasMod.PersonaEntry => Boolean(p))
    const lint = lintDialogueFidelity(
      {
        title: typeof args.title === 'string' ? args.title : (ctx.state.savedPlan?.title ?? ''),
        lines
      },
      {
        ...(seededAddresses.length > 0 ? { pairwiseAddress: seededAddresses } : {}),
        personas: resolvedValidatePersonas,
        cast: validateCast
      }
    )
    const stageDirectionFixes = lines
      .filter((l) => hasSpokenStageDirectionLeak(l.content))
      .map((l) => ({
        id: l.id,
        before: l.content,
        repaired: repairSpokenStageDirections(l.content)
      }))
    return JSON.stringify({
      ok: !lint.shouldPolish && lint.issues.length === 0 && stageDirectionFixes.length === 0,
      lineCount: lines.length,
      issues: lint.issues,
      stageDirectionFixes
    })
  }

  if (name === 'save_story_draft') {
    const candidate = ctx.resolveCandidateStory(args)
    if (!candidate) {
      return JSON.stringify({
        draftSaved: false,
        error: '缺少有效的 StoryData 对象（需包含 snippets 数组）'
      })
    }
    ctx.state.savedDraft = structuredClone(candidate)
    ctx.state.directorReview = null
    ctx.state.finalized = false
    const audit = ctx.runCompactAudit(ctx.state.savedDraft)
    return JSON.stringify({
      draftSaved: true,
      snippetCount: Array.isArray(ctx.state.savedDraft.snippets)
        ? ctx.state.savedDraft.snippets.length
        : 0,
      nextStepHint:
        '已返回完整规则体检与 directorTelemetry，无需再重复调用 validate_story_draft / critique_story_draft；请直接调用 submit_director_review 完成 5 维导演终审并同步附带 operations 修补、设 finalizeIfReady: true 一步定稿。',
      ...audit
    })
  }

  if (name === 'inspect_story_draft') {
    if (!ctx.state.savedDraft || !Array.isArray(ctx.state.savedDraft.snippets)) {
      return JSON.stringify({
        error: '当前工作区尚无已保存草稿，请先调用 save_story_draft'
      })
    }
    const snippets = ctx.state.savedDraft.snippets as Array<Record<string, unknown>>
    const filterType = typeof args.type === 'string' ? args.type : 'all'
    const onlyIssues = Boolean(args.onlyIssues)
    let issueByIdx = new Map<number, string[]>()
    if (onlyIssues) {
      try {
        let report: ActingFidelityReport
        try {
          report = ctx.auditDraftCandidate(ctx.state.savedDraft).actingReport
        } catch {
          report = runActingAndFidelityAudit(ctx.buildRawAuditStory(ctx.state.savedDraft), view)
        }
        issueByIdx = new Map<number, string[]>()
        for (const d of report.diagnostics) {
          const arr = issueByIdx.get(d.snippetIndex) ?? []
          arr.push(`${d.code}: ${d.message}`)
          issueByIdx.set(d.snippetIndex, arr)
        }
      } catch {
        // Schema failed; show raw snippets
      }
    }

    const transitionTypes = new Set([
      'BlackOut',
      'BlackIn',
      'SideFade',
      'FlashbackIn',
      'FlashbackOut',
      'SekaiIn',
      'SekaiOut',
      'ChangeBackgroundImage',
      'ChangeBgm',
      'Telop',
      'PlaceInfo'
    ])

    const rows: Array<Record<string, unknown>> = []
    for (let idx = 0; idx < snippets.length; idx++) {
      const s = snippets[idx]
      if (!s || typeof s !== 'object') continue
      const sType = String(s.type ?? '')
      if (filterType === 'transitions' && !transitionTypes.has(sType)) continue
      if (filterType !== 'all' && filterType !== 'transitions' && sType !== filterType) continue
      if (onlyIssues && !issueByIdx.has(idx)) continue
      const d = (s.data && typeof s.data === 'object' ? s.data : {}) as Record<string, unknown>
      rows.push({
        idx,
        type: sType,
        ...(typeof s.delay === 'number' && s.delay !== 0 ? { delay: s.delay } : {}),
        ...(typeof d.modelId === 'number' ? { modelId: d.modelId } : {}),
        ...(typeof d.speaker === 'string' ? { speaker: d.speaker } : {}),
        ...(typeof d.content === 'string' ? { content: d.content } : {}),
        ...(typeof d.emotion === 'string' && d.emotion ? { emotion: d.emotion } : {}),
        ...(typeof d.motion === 'string' && d.motion ? { motion: d.motion } : {}),
        ...(typeof d.facial === 'string' && d.facial ? { facial: d.facial } : {}),
        ...(Array.isArray(d.actions) && d.actions.length > 0 ? { actions: d.actions } : {}),
        ...(d.closeWindowOnFinish ? { closeWindowOnFinish: true } : {}),
        ...(issueByIdx.has(idx) ? { issues: issueByIdx.get(idx) } : {})
      })
    }

    const start =
      typeof args.startIndex === 'number' && Number.isFinite(args.startIndex)
        ? Math.max(0, Math.floor(args.startIndex))
        : 0
    const end =
      typeof args.endIndex === 'number' && Number.isFinite(args.endIndex)
        ? Math.max(start, Math.floor(args.endIndex))
        : start + 25

    return JSON.stringify({
      totalSnippets: snippets.length,
      matchedCount: rows.length,
      slice: rows.slice(start, end)
    })
  }

  const applyDraftPatchOperations = (
    patchArgs: Record<string, unknown>
  ): { applied: string[]; snippetCount: number } | { error: string } => {
    if (!ctx.state.savedDraft || !Array.isArray(ctx.state.savedDraft.snippets)) {
      return { error: '当前工作区尚无已保存草稿，请先调用 save_story_draft' }
    }
    const draft = structuredClone(ctx.state.savedDraft)
    if (Array.isArray(patchArgs.models)) draft.models = patchArgs.models
    if (Array.isArray(patchArgs.images)) draft.images = patchArgs.images
    const snippets = [...(draft.snippets as Array<Record<string, unknown>>)]
    const originalLength = snippets.length
    const ops = Array.isArray(patchArgs.operations) ? patchArgs.operations : []
    const appliedNotes: string[] = []
    const deletedOriginalIndices = new Set<number>()

    // 按原始 index 降序执行（同 index 先 insert_after -> 原位改写 -> delete -> insert_before），
    // 确保同一批次中多个 delete/insert/update_acting 共用原始索引时不发生漂移。
    const opPhase = (op: string): number => {
      if (op === 'insert_after') return 0
      if (
        op === 'update_talk' ||
        op === 'update_acting' ||
        op === 'upsert_listener_action' ||
        op === 'replace'
      )
        return 1
      if (op === 'delete') return 2
      if (op === 'insert_before') return 3
      return 4
    }
    const sortedOps = ops
      .map((rawOp, order) => ({ rawOp, order }))
      .filter((entry): entry is { rawOp: Record<string, unknown>; order: number } =>
        Boolean(entry.rawOp && typeof entry.rawOp === 'object')
      )
      .sort((a, b) => {
        const idxA = typeof a.rawOp.index === 'number' ? Math.floor(a.rawOp.index) : -1
        const idxB = typeof b.rawOp.index === 'number' ? Math.floor(b.rawOp.index) : -1
        if (idxA !== idxB) return idxB - idxA
        const phaseA = opPhase(String(a.rawOp.op ?? ''))
        const phaseB = opPhase(String(b.rawOp.op ?? ''))
        if (phaseA !== phaseB) return phaseA - phaseB
        return phaseA === 0 || phaseA === 3 ? b.order - a.order : a.order - b.order
      })

    for (const { rawOp: opObj } of sortedOps) {
      const op = String(opObj.op ?? '')
      const idx = typeof opObj.index === 'number' ? Math.floor(opObj.index) : -1
      if (idx < 0 || idx >= originalLength || deletedOriginalIndices.has(idx)) {
        appliedNotes.push(`跳过越界操作 ${op}(index=${idx})`)
        continue
      }
      const target = snippets[idx]
      if (op === 'delete') {
        snippets.splice(idx, 1)
        deletedOriginalIndices.add(idx)
        appliedNotes.push(`delete@${idx}`)
        continue
      }
      if (op === 'replace' && opObj.snippet && typeof opObj.snippet === 'object') {
        snippets[idx] = opObj.snippet as Record<string, unknown>
        appliedNotes.push(`replace@${idx}`)
        continue
      }
      if (op === 'insert_before' || op === 'insert_after') {
        const toInsert = Array.isArray(opObj.snippets)
          ? opObj.snippets.filter((x): x is Record<string, unknown> =>
              Boolean(x && typeof x === 'object')
            )
          : opObj.snippet && typeof opObj.snippet === 'object'
            ? [opObj.snippet as Record<string, unknown>]
            : []
        if (toInsert.length > 0) {
          const insertAt = op === 'insert_before' ? idx : idx + 1
          snippets.splice(insertAt, 0, ...toInsert)
          appliedNotes.push(`${op}@${idx}(+${toInsert.length})`)
        }
        continue
      }
      if (op === 'update_talk' || op === 'update_acting' || op === 'upsert_listener_action') {
        const d = (target.data && typeof target.data === 'object' ? target.data : {}) as Record<
          string,
          unknown
        >
        if (typeof opObj.delay === 'number' && Number.isFinite(opObj.delay)) {
          target.delay = opObj.delay
        }
        if (op === 'update_talk') {
          if (typeof opObj.content === 'string' && opObj.content.trim()) {
            const nextContent = opObj.content.trim()
            const prevContent = typeof d.content === 'string' ? d.content.trim() : ''
            if (nextContent !== prevContent) {
              d.content = nextContent
              if (typeof d.ttsText === 'string' && d.ttsText) delete d.ttsText
            }
          }
          if (typeof opObj.emotion === 'string') d.emotion = opObj.emotion
          if (typeof opObj.ttsCaption === 'string') d.ttsCaption = opObj.ttsCaption
          if (typeof opObj.ttsSpeed === 'number' && Number.isFinite(opObj.ttsSpeed)) {
            d.ttsSpeed = opObj.ttsSpeed
          }
          if (typeof opObj.ttsSpecialScene === 'boolean') {
            if (opObj.ttsSpecialScene) d.ttsSpecialScene = true
            else delete d.ttsSpecialScene
          }
          if (typeof opObj.closeWindowOnFinish === 'boolean') {
            if (opObj.closeWindowOnFinish) d.closeWindowOnFinish = true
            else delete d.closeWindowOnFinish
          }
        }
        if (Array.isArray(opObj.actions)) {
          d.actions = opObj.actions
        } else {
          const hasMotionArg = typeof opObj.motion === 'string'
          const hasFacialArg = typeof opObj.facial === 'string'
          if (target.type === 'Talk') {
            const speakerId = typeof d.modelId === 'number' ? d.modelId : -1
            if (op !== 'upsert_listener_action' && (hasMotionArg || hasFacialArg)) {
              const acts = Array.isArray(d.actions)
                ? [...(d.actions as Array<Record<string, unknown>>)]
                : []
              const primaryIdx = acts.findIndex((a) => a && a.modelId === speakerId)
              const baseAct: Record<string, unknown> =
                primaryIdx >= 0 ? { ...acts[primaryIdx] } : { at: 0, modelId: speakerId }
              const resolveAnim = (
                mid: number,
                kind: 'motion' | 'facial',
                rawVal: string
              ): string | null => {
                const trimmed = rawVal.trim()
                if (!trimmed) return ''
                if (mid < 0) return trimmed
                return view.canonicalAnimation(mid, kind, trimmed)
              }
              if (hasMotionArg) {
                const canonical = resolveAnim(speakerId, 'motion', opObj.motion as string)
                if (canonical === '') delete baseAct.motion
                else if (canonical) baseAct.motion = canonical
                else appliedNotes.push(`ignored_invalid_motion@${idx}:${String(opObj.motion)}`)
              }
              if (hasFacialArg) {
                const canonical = resolveAnim(speakerId, 'facial', opObj.facial as string)
                if (canonical === '') delete baseAct.facial
                else if (canonical) baseAct.facial = canonical
                else appliedNotes.push(`ignored_invalid_facial@${idx}:${String(opObj.facial)}`)
              }
              if (baseAct.motion || baseAct.facial) {
                if (primaryIdx >= 0) acts[primaryIdx] = baseAct
                else acts.unshift(baseAct)
              } else if (primaryIdx >= 0) {
                acts.splice(primaryIdx, 1)
              }
              d.actions = acts
              if (hasMotionArg) delete d.motion
              if (hasFacialArg) delete d.facial
            }

            const rawListener =
              opObj.listenerAction && typeof opObj.listenerAction === 'object'
                ? (opObj.listenerAction as Record<string, unknown>)
                : op === 'upsert_listener_action' && typeof opObj.modelId === 'number'
                  ? opObj
                  : null
            if (rawListener && typeof rawListener.modelId === 'number') {
              const lModelId = rawListener.modelId
              const acts = Array.isArray(d.actions)
                ? [...(d.actions as Array<Record<string, unknown>>)]
                : []
              const existingIdx = acts.findIndex((a) => a && a.modelId === lModelId)
              const removeListener = Boolean(rawListener.remove)
              let lMotion =
                typeof rawListener.motion === 'string' ? rawListener.motion.trim() : undefined
              const lFacial =
                typeof rawListener.facial === 'string' ? rawListener.facial.trim() : undefined
              if (removeListener || (lMotion === '' && lFacial === '')) {
                if (existingIdx >= 0) acts.splice(existingIdx, 1)
              } else {
                const desiredAt =
                  typeof rawListener.at === 'number' &&
                  Number.isFinite(rawListener.at) &&
                  rawListener.at >= 0 &&
                  rawListener.at <= 1
                    ? rawListener.at
                    : 0
                const speakerBodyAts = acts
                  .filter(
                    (a) =>
                      a &&
                      a.modelId !== lModelId &&
                      typeof a.motion === 'string' &&
                      a.motion.trim().length > 0
                  )
                  .map((a) => (typeof a.at === 'number' && Number.isFinite(a.at) ? a.at : 0))
                if (
                  lMotion &&
                  speakerBodyAts.some((sat) => Math.abs(sat - desiredAt) < 0.25 - 1e-6)
                ) {
                  lMotion = ''
                  appliedNotes.push(
                    `listener@${idx}:保留at:${desiredAt}纯表情(如需听者身体动作请插独立Motion片段)`
                  )
                }
                const nextAct: Record<string, unknown> =
                  existingIdx >= 0
                    ? { ...acts[existingIdx], at: desiredAt, modelId: lModelId }
                    : { at: desiredAt, modelId: lModelId }
                if (lMotion !== undefined) {
                  if (lMotion === '') delete nextAct.motion
                  else {
                    const canonM = view.canonicalAnimation(lModelId, 'motion', lMotion)
                    if (canonM) nextAct.motion = canonM
                  }
                }
                if (lFacial !== undefined) {
                  if (lFacial === '') delete nextAct.facial
                  else {
                    const canonF = view.canonicalAnimation(lModelId, 'facial', lFacial)
                    if (canonF) nextAct.facial = canonF
                  }
                }
                if (nextAct.motion || nextAct.facial) {
                  if (existingIdx >= 0) acts[existingIdx] = nextAct
                  else acts.push(nextAct)
                }
              }
              acts.sort(
                (a, b) =>
                  (typeof a.at === 'number' ? a.at : 0) - (typeof b.at === 'number' ? b.at : 0)
              )
              d.actions = acts
            }
          } else {
            const targetModelId = typeof d.modelId === 'number' ? d.modelId : -1
            if (hasMotionArg) {
              const rawM = String(opObj.motion ?? '').trim()
              if (!rawM) d.motion = ''
              else {
                const canonM =
                  targetModelId >= 0 ? view.canonicalAnimation(targetModelId, 'motion', rawM) : rawM
                if (canonM) d.motion = canonM
              }
            }
            if (hasFacialArg) {
              const rawF = String(opObj.facial ?? '').trim()
              if (!rawF) d.facial = ''
              else {
                const canonF =
                  targetModelId >= 0 ? view.canonicalAnimation(targetModelId, 'facial', rawF) : rawF
                if (canonF) d.facial = canonF
              }
            }
          }
        }
        target.data = d
        appliedNotes.push(`${op}@${idx}`)
      }
    }

    draft.snippets = snippets
    ctx.state.savedDraft = draft
    ctx.state.finalized = false
    return { applied: appliedNotes, snippetCount: snippets.length }
  }

  if (name === 'patch_story_draft') {
    const res = applyDraftPatchOperations(args)
    if ('error' in res) {
      return JSON.stringify({ patched: false, error: res.error })
    }
    const audit = ctx.runCompactAudit(ctx.state.savedDraft!)
    return JSON.stringify({
      patched: true,
      applied: res.applied,
      snippetCount: res.snippetCount,
      ...audit
    })
  }

  if (name === 'submit_director_review') {
    if (!ctx.state.savedDraft || !Array.isArray(ctx.state.savedDraft.snippets)) {
      return JSON.stringify({
        reviewed: false,
        error: '当前工作区尚无已保存草稿，请先调用 save_story_draft'
      })
    }
    const dramaticArc = typeof args.dramaticArc === 'string' ? args.dramaticArc.trim() : ''
    const emotionalContinuityAndVoice =
      typeof args.emotionalContinuityAndVoice === 'string'
        ? args.emotionalContinuityAndVoice.trim()
        : ''
    const audioAndSeDesign =
      typeof args.audioAndSeDesign === 'string' ? args.audioAndSeDesign.trim() : ''
    const stageRhythm = typeof args.stageRhythm === 'string' ? args.stageRhythm.trim() : ''
    const actingNaturalness =
      typeof args.actingNaturalness === 'string' ? args.actingNaturalness.trim() : ''
    const concreteFixes = Array.isArray(args.concreteFixes)
      ? args.concreteFixes.map((x) => String(x ?? '').trim()).filter(Boolean)
      : []

    let applied: string[] = []
    let snippetCount = (ctx.state.savedDraft.snippets as unknown[]).length
    if (
      (Array.isArray(args.operations) && args.operations.length > 0) ||
      Array.isArray(args.models) ||
      Array.isArray(args.images)
    ) {
      const patchRes = applyDraftPatchOperations(args)
      if ('error' in patchRes) {
        return JSON.stringify({ reviewed: false, error: patchRes.error })
      }
      applied = patchRes.applied
      snippetCount = patchRes.snippetCount
    }

    ctx.state.directorReview = {
      dramaticArc,
      emotionalContinuityAndVoice,
      audioAndSeDesign,
      stageRhythm,
      actingNaturalness,
      concreteFixes,
      appliedOperationsCount: applied.length
    }

    const audit = ctx.runCompactAudit(ctx.state.savedDraft)
    const wantsFinalize = args.finalizeIfReady === true
    if (
      wantsFinalize &&
      audit.schemaValid &&
      audit.officialPassed &&
      (audit.readyToFinalize || audit.postActingPassed)
    ) {
      ctx.state.finalized = true
      return JSON.stringify({
        reviewed: true,
        finalized: true,
        applied,
        snippetCount,
        ...audit
      })
    }
    return JSON.stringify({
      reviewed: true,
      finalized: false,
      applied,
      snippetCount,
      ...audit
    })
  }

  if (name === 'critique_story_draft') {
    const candidate = ctx.resolveCandidateStory(args)
    if (!candidate) {
      return JSON.stringify({
        schemaValid: false,
        error: '未提供 story 且工作区尚无已保存草稿'
      })
    }
    const maxDiag =
      typeof args.maxDiagnostics === 'number' && Number.isFinite(args.maxDiagnostics)
        ? Math.max(1, Math.min(40, Math.round(args.maxDiagnostics)))
        : 15
    try {
      const audited = ctx.auditDraftCandidate(candidate)
      const directorTelemetry = buildDirectorStageTelemetry(candidate, targetMinutes)
      return JSON.stringify({
        schemaValid: true,
        readyToFinalize: audited.readyToFinalize,
        directorReviewed: Boolean(ctx.state.directorReview),
        directorTelemetry,
        actingPassed: audited.actingReport.passed,
        actingScore: audited.actingReport.score,
        officialPassed: audited.officialPassed,
        officialIssues: audited.postOfficialReport.issues,
        zeroMotionModelIds: audited.actingReport.zeroMotionModelIds,
        repeatedFacialRunCount: audited.actingReport.repeatedFacialRunCount,
        facialMismatchCount: audited.actingReport.facialMismatchCount,
        motionMismatchCount: audited.actingReport.motionMismatchCount,
        simultaneousCollisionCount: audited.actingReport.simultaneousCollisionCount,
        stageDirectionLeakCount: audited.actingReport.stageDirectionLeakCount,
        listenerFrozenCount: audited.actingReport.listenerFrozenCount ?? 0,
        duplicateBgmCount: audited.actingReport.duplicateBgmCount ?? 0,
        zeroWidthCharCount: audited.actingReport.zeroWidthCharCount ?? 0,
        staggeredMidlineMotionCount: audited.actingReport.staggeredMidlineMotionCount ?? 0,
        excessiveSlidingCount: audited.actingReport.excessiveSlidingCount ?? 0,
        dialogueIssues: audited.dialogueLint.issues.slice(0, maxDiag),
        diagnostics: audited.actingReport.diagnostics.slice(0, maxDiag),
        warnings: audited.warnings.slice(0, 8)
      })
    } catch (error) {
      return JSON.stringify({
        schemaValid: false,
        readyToFinalize: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  if (name === 'validate_story_draft') {
    const candidate = ctx.resolveCandidateStory(args)
    if (!candidate) {
      return JSON.stringify({
        schemaValid: false,
        error: '未提供有效的 StoryData 对象'
      })
    }
    try {
      const { story, warnings } = validateAndFixStory(candidate, view, logger, {
        emotionLabels
      })
      const actingReport = runActingAndFidelityAudit(story, view)
      const report = actingReport.officialReport
      const bodyMotions = countBodyMotionsByModel(story)
      const zeroMotionModels = story.models
        .filter((m) => (bodyMotions[String(m.id)] ?? 0) === 0)
        .map((m) => m.id)
      const stageLeaks = story.snippets
        .map((s, idx) => ({ idx, s }))
        .filter(
          ({ s }) =>
            s.type === 'Talk' &&
            'data' in s &&
            hasSpokenStageDirectionLeak(String((s.data as Record<string, unknown>)?.content ?? ''))
        )
        .map(({ idx }) => idx)

      return JSON.stringify({
        schemaValid: true,
        officialPassed:
          report.passed &&
          (actingReport.talkCount < 6 || zeroMotionModels.length === 0) &&
          stageLeaks.length === 0,
        actingPassed: actingReport.passed,
        actingScore: actingReport.score,
        warnings: warnings.slice(0, 12),
        officialIssues: report.issues,
        zeroMotionModelIds: zeroMotionModels,
        stageDirectionLeakSnippetIndices: stageLeaks,
        actingDiagnostics: actingReport.diagnostics.slice(0, 10),
        metrics: {
          talkCount: report.metrics.talkCount,
          talkZeroDelayShare: report.metrics.talkZeroDelayShare,
          appearMotionClashCount: report.metrics.appearMotionClashCount,
          inPlaceAppearShare: report.metrics.inPlaceAppearShare,
          bodyMotionsByModel: bodyMotions
        }
      })
    } catch (error) {
      return JSON.stringify({
        schemaValid: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  if (name === 'finalize_story_draft') {
    if (!ctx.state.savedDraft) {
      return JSON.stringify({
        finalized: false,
        error: '尚无已保存草稿，请先调用 save_story_draft 保存剧本'
      })
    }
    const audit = ctx.runCompactAudit(ctx.state.savedDraft)
    const telemetry = audit.directorTelemetry as DirectorStageTelemetry | undefined
    if (
      audit.schemaValid &&
      audit.officialPassed &&
      (telemetry?.talkCount ?? 0) >= 8 &&
      !ctx.state.directorReview
    ) {
      return JSON.stringify({
        finalized: false,
        needsDirectorReview: true,
        message:
          '长篇草稿（>=8 句）定稿前请先调用 submit_director_review 完成 5 维导演终审（评估戏剧弧光、情绪连贯与口吻、BGM/PlaySe 音效、舞台节奏、表情动作自然度）；可在同一次调用中附带 operations 落地修补并设 finalizeIfReady: true 一步定稿。',
        ...audit
      })
    }
    if (audit.schemaValid && audit.officialPassed) {
      ctx.state.finalized = true
      return JSON.stringify({
        finalized: true,
        ...audit
      })
    }
    return JSON.stringify({
      finalized: false,
      ...audit
    })
  }

  return null
}
