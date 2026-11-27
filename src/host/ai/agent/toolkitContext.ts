import type { ILogObj, Logger } from 'tslog'
import type { StoryData } from '../../../common/types/Story'
import type { AdaptiveRagRetriever } from '../../rag/retriever'
import type { CatalogModel } from '../../resources/resourceCatalog'
import { hasSpokenStageDirectionLeak, lintDialogueFidelity } from '../dialogueLinter'
import type { LlmClient, LlmToolDefinition } from '../llm'
import * as officialLinterMod from '../officialLinter'
import * as personasMod from '../personas'
import type { CatalogView } from '../prompt'
import { resolveCastPersonas } from '../staged'
import { validateAndFixStory } from '../validate'
import { buildDirectorStageTelemetry, runActingAndFidelityAudit } from './actingAudit'
import {
  countBodyMotionsByModel,
  extractDialogueLinesFromStory,
  findModel,
  isStoryObjectCandidate,
  type ActingFidelityReport
} from './actingSemantics'

export interface StoryAgentToolkitDeps {
  view: CatalogView
  personas: personasMod.PersonaEntry[]
  emotionLabels?: string[]
  targetMinutes?: number
  ragRetriever?: AdaptiveRagRetriever | null
  llm?: LlmClient
  logger: Logger<ILogObj>
}

export interface DirectorReviewRecord {
  dramaticArc: string
  emotionalContinuityAndVoice: string
  audioAndSeDesign: string
  stageRhythm: string
  actingNaturalness: string
  concreteFixes: string[]
  appliedOperationsCount: number
}

export interface StoryAgentToolkit {
  definitions: LlmToolDefinition[]
  execute: (name: string, rawArgs: unknown, signal?: AbortSignal) => Promise<string>
  getSavedDraft: () => Record<string, unknown> | null
  getSavedPlan: () => SavedStoryPlan | null
  getDirectorReview: () => DirectorReviewRecord | null
  isFinalized: () => boolean
}

export interface SavedStoryPlan {
  title: string
  logline: string
  event: string
  cast: Array<{ modelId: number; name: string; role: string }>
  scenes: Array<{
    id: string
    summary: string
    background: string
    ambient: 'normal' | 'evening' | 'night'
    transitionIn: string
    activeCast: string[]
    bgm?: string
    isFlashback?: boolean
    isSekai?: boolean
  }>
  beats: string[]
  understanding?: {
    explicitRequests: string[]
    turningPoint?: string
    openingMotif?: string
    closingCallback?: string
    canonHooks: string[]
  }
  pairwiseAddress?: Array<{ from: string; to: string; zh: string; ja?: string }>
}

export interface ToolkitMutableState {
  savedPlan: SavedStoryPlan | null
  savedDraft: Record<string, unknown> | null
  directorReview: DirectorReviewRecord | null
  finalized: boolean
}

export interface ToolkitAuditResult {
  story: StoryData
  warnings: string[]
  actingReport: ActingFidelityReport
  postActingReport: ActingFidelityReport
  postOfficialReport: ReturnType<typeof officialLinterMod.lintOfficialStory>
  dialogueLint: ReturnType<typeof lintDialogueFidelity>
  bodyMotions: Record<string, number>
  stageLeaks: number[]
  officialPassed: boolean
  postActingPassed: boolean
  readyToFinalize: boolean
}

export interface ToolkitRuntimeContext {
  deps: StoryAgentToolkitDeps
  view: CatalogView
  personas: personasMod.PersonaEntry[]
  emotionLabels: string[]
  targetMinutes?: number
  ragRetriever?: AdaptiveRagRetriever | null
  llm?: LlmClient
  logger: Logger<ILogObj>
  state: ToolkitMutableState
  resolveCandidateStory: (args: Record<string, unknown>) => Record<string, unknown> | null
  buildRawAuditStory: (
    candidate: Record<string, unknown>,
    fallbackModels?: StoryData['models'],
    fallbackImages?: StoryData['images']
  ) => StoryData
  auditDraftCandidate: (candidate: Record<string, unknown>) => ToolkitAuditResult
  runCompactAudit: (candidate: Record<string, unknown>) => Record<string, unknown>
}

export function createToolkitRuntimeContext(deps: StoryAgentToolkitDeps): ToolkitRuntimeContext {
  const { view, personas, emotionLabels = [], targetMinutes, ragRetriever, llm, logger } = deps
  const state: ToolkitMutableState = {
    savedPlan: null,
    savedDraft: null,
    directorReview: null,
    finalized: false
  }

  const resolveCandidateStory = (args: Record<string, unknown>): Record<string, unknown> | null => {
    if (isStoryObjectCandidate(args.story)) return args.story as Record<string, unknown>
    if (isStoryObjectCandidate(args)) return args
    if (args.useCurrentDraft !== false && state.savedDraft) return state.savedDraft
    return null
  }

  const buildRawAuditStory = (
    candidate: Record<string, unknown>,
    fallbackModels: StoryData['models'] = [],
    fallbackImages: StoryData['images'] = []
  ): StoryData => {
    const rawSnippets = Array.isArray(candidate.snippets) ? candidate.snippets : []
    const clonedSnippets = rawSnippets.map((s) =>
      s && typeof s === 'object' ? structuredClone(s) : { type: 'Unknown', data: {} }
    )
    const rawModels = Array.isArray(candidate.models)
      ? (structuredClone(candidate.models) as StoryData['models'])
      : fallbackModels
    const rawImages = Array.isArray(candidate.images)
      ? (structuredClone(candidate.images) as StoryData['images'])
      : fallbackImages
    return {
      models: rawModels,
      images: rawImages,
      snippets: clonedSnippets as unknown as StoryData['snippets']
    }
  }

  const auditDraftCandidate = (
    candidate: Record<string, unknown>
  ): {
    story: StoryData
    warnings: string[]
    actingReport: ActingFidelityReport
    postActingReport: ActingFidelityReport
    postOfficialReport: ReturnType<typeof officialLinterMod.lintOfficialStory>
    dialogueLint: ReturnType<typeof lintDialogueFidelity>
    bodyMotions: Record<string, number>
    stageLeaks: number[]
    officialPassed: boolean
    postActingPassed: boolean
    readyToFinalize: boolean
  } => {
    const { story, warnings } = validateAndFixStory(candidate, view, logger, {
      emotionLabels
    })
    // 审计 raw candidate.snippets，保留与 savedDraft 一致的 snippetIndex，避免 ensureOpeningAndEnding
    // 位移索引或 repairActingMismatches 掩盖尚未修复的表情/动作冲突。
    const rawAuditStory = buildRawAuditStory(candidate, story.models, story.images)
    const actingReport = runActingAndFidelityAudit(rawAuditStory, view)
    const postActingReport = runActingAndFidelityAudit(story, view)
    const postOfficialReport = officialLinterMod.lintOfficialStory(story, view)
    const dialogueLines = extractDialogueLinesFromStory(
      rawAuditStory as unknown as Record<string, unknown>
    )
    const speakerNames = Array.from(new Set(dialogueLines.map((l) => l.speaker).filter(Boolean)))
    const auditContextText = [
      state.savedPlan?.event ?? '',
      state.savedPlan?.logline ?? '',
      ...speakerNames,
      ...dialogueLines.slice(0, 6).map((l) => l.content)
    ]
      .filter(Boolean)
      .join('\n')
    const auditUnitHint = personasMod.inferUnitFromText(auditContextText)
    const auditLookupOpts: personasMod.PersonaLookupOptions | undefined =
      auditUnitHint || auditContextText
        ? {
            ...(auditUnitHint ? { unitHint: auditUnitHint } : {}),
            ...(auditContextText ? { contextText: auditContextText } : {})
          }
        : undefined
    const seededAddresses = [
      ...personasMod
        .extractPairwiseAddressBook(personas, speakerNames, auditLookupOpts)
        .map((r) => ({
          from: r.from,
          to: r.to,
          zh: r.zh
        })),
      ...(state.savedPlan?.pairwiseAddress ?? [])
    ]
    const auditCast = state.savedPlan?.cast?.length
      ? state.savedPlan.cast.map((c) => {
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
          .map((sp) => findModel(view, undefined, sp, auditLookupOpts))
          .filter((m): m is CatalogModel => Boolean(m))
          .map((m) => ({
            modelId: m.id,
            name: view.shortName(m),
            fullName: m.name,
            path: m.path,
            role: ''
          }))
    const resolvedAuditPersonas =
      auditCast.length > 0
        ? resolveCastPersonas(personas, auditCast, view, auditContextText)
        : speakerNames
            .map((sp) => personasMod.resolvePersonaByName(personas, sp, auditLookupOpts))
            .filter((p): p is personasMod.PersonaEntry => Boolean(p))
    const dialogueLint = lintDialogueFidelity(
      {
        title: state.savedPlan?.title ?? '',
        lines: dialogueLines.map((l) => ({ id: l.id, speaker: l.speaker, content: l.content }))
      },
      {
        ...(seededAddresses.length > 0 ? { pairwiseAddress: seededAddresses } : {}),
        personas: resolvedAuditPersonas,
        cast: auditCast
      }
    )
    const bodyMotions = countBodyMotionsByModel(rawAuditStory)
    const stageLeaks = rawAuditStory.snippets
      .map((s, idx) => ({ idx, s }))
      .filter(
        ({ s }) =>
          s.type === 'Talk' &&
          'data' in s &&
          hasSpokenStageDirectionLeak(String((s.data as Record<string, unknown>)?.content ?? ''))
      )
      .map(({ idx }) => idx)
    const officialPassed =
      postOfficialReport.passed &&
      (actingReport.talkCount < 6 || actingReport.zeroMotionModelIds.length === 0) &&
      stageLeaks.length === 0
    const postActingPassed =
      postActingReport.passed &&
      (postActingReport.talkCount < 6 || postActingReport.zeroMotionModelIds.length === 0) &&
      !dialogueLint.issues.some((i) => i.severity === 'high')
    return {
      story,
      warnings,
      actingReport,
      postActingReport,
      postOfficialReport,
      dialogueLint,
      bodyMotions,
      stageLeaks,
      officialPassed,
      postActingPassed,
      readyToFinalize:
        officialPassed &&
        actingReport.passed &&
        !dialogueLint.issues.some((i) => i.severity === 'high')
    }
  }

  const runCompactAudit = (candidate: Record<string, unknown>): Record<string, unknown> => {
    try {
      const audited = auditDraftCandidate(candidate)
      const directorTelemetry = buildDirectorStageTelemetry(candidate, targetMinutes)
      return {
        schemaValid: true,
        officialPassed: audited.officialPassed,
        actingPassed: audited.actingReport.passed,
        postActingPassed: audited.postActingPassed,
        actingScore: audited.actingReport.score,
        readyToFinalize: audited.readyToFinalize,
        directorReviewed: Boolean(state.directorReview),
        directorTelemetry,
        warnings: audited.warnings.slice(0, 12),
        officialIssues: audited.postOfficialReport.issues,
        zeroMotionModelIds: audited.actingReport.zeroMotionModelIds,
        stageDirectionLeakSnippetIndices: audited.stageLeaks,
        dialogueIssues: audited.dialogueLint.issues.slice(0, 10),
        actingDiagnostics: audited.actingReport.diagnostics.slice(0, 12),
        metrics: {
          talkCount: audited.postOfficialReport.metrics.talkCount,
          talkZeroDelayShare: audited.postOfficialReport.metrics.talkZeroDelayShare,
          appearMotionClashCount: audited.postOfficialReport.metrics.appearMotionClashCount,
          inPlaceAppearShare: audited.postOfficialReport.metrics.inPlaceAppearShare,
          bodyMotionsByModel: audited.bodyMotions,
          facialMismatchCount: audited.actingReport.facialMismatchCount,
          motionMismatchCount: audited.actingReport.motionMismatchCount,
          repeatedFacialRunCount: audited.actingReport.repeatedFacialRunCount,
          listenerFrozenCount: audited.actingReport.listenerFrozenCount ?? 0,
          duplicateBgmCount: audited.actingReport.duplicateBgmCount ?? 0,
          zeroWidthCharCount: audited.actingReport.zeroWidthCharCount ?? 0
        }
      }
    } catch (error) {
      return {
        schemaValid: false,
        officialPassed: false,
        actingPassed: false,
        readyToFinalize: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  return {
    deps,
    view,
    personas,
    emotionLabels,
    targetMinutes,
    ragRetriever,
    llm,
    logger,
    state,
    resolveCandidateStory,
    buildRawAuditStory,
    auditDraftCandidate,
    runCompactAudit
  }
}
