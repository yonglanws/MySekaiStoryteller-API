/**
 * Agentic 自主导演工具集与 Phase 1 探索编排（barrel re-export 门面）。
 *
 * 实现已按职责拆分至 `./agent/*` 子模块，保持全部既有导出签名向后兼容。
 */
export type {
  ActingFidelityDiagnostic,
  ActingFidelityReport,
  ActingLineEvaluation,
  ActingLineEvaluationIssue,
  CharacterActingProfile,
  DramaticContextMood,
  DramaticContextSummary,
  MotionCompatibilityResult,
  MotionInspection,
  MotionSemanticRole
} from './agent/actingSemantics'

export type { DirectorStageTelemetry } from './agent/actingAudit'
export { buildLocalizedDirectorReviewHints } from './agent/actingAudit'

export type {
  DirectorReviewRecord,
  StoryAgentToolkit,
  StoryAgentToolkitDeps
} from './agent/toolkit'
export { createStoryAgentToolkit } from './agent/toolkit'

export type {
  AgenticGenerationOptions,
  AgenticGenerationResult,
  Phase1ExploreOptions,
  Phase1ExploreResult,
  Phase1ExploreStage
} from './agent/phase1Explore'
export { runAgenticStoryGeneration, runPhase1Exploration } from './agent/phase1Explore'
