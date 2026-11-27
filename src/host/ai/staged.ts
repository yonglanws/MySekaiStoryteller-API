/**
 * 五阶段 Project SEKAI 导演流水线（barrel re-export 门面）。
 *
 * 实现已按职责拆分至 `./staged/*` 子模块，保持全部既有导出签名向后兼容。
 */
export { normalizeDialogueLineBreaks } from './validate'

export type {
  LlmPipeline,
  StagedTransitionKind,
  StagedScenePlan,
  StagedCastMember,
  StagedCharacterGoal,
  StagedPromptUnderstanding,
  StagedPairwiseAddress,
  StagedRetrievalQueries,
  StagedCastPlan,
  StagedDialogueLine,
  StagedDialogue,
  StagedListenerAction,
  StagedDirectionBeat,
  StagedDirectionLine,
  StagedDirection,
  StagedStagingScene,
  StagedMoveCue,
  StagedCameraCue,
  StagedSeCue,
  StagedStagingEvent,
  StagedStaging,
  StagedPromptOptions,
  StagedMessages,
  SubtleFacialContext,
  QuickCastOptions,
  CanonGroundingBriefOptions,
  StagedEmotionSegment,
  StagedVoiceDirectionLine,
  DialoguePolishOptions,
  StagedPresenceSegment,
  StagedDirectorReviewPatch,
  StagedDirectorActingHint,
  StagedDirectorReviewHints,
  StagedDirectorReviewResult
} from './staged/types'
export {
  resolveMemberPersona,
  resolveCastPersonas,
  formatCanonGroundingBrief
} from './staged/helpers'
export {
  buildCastPrompt,
  buildQuickCastPrompt,
  normalizeCastPlan,
  fallbackCastPlan
} from './staged/cast'
export {
  buildDialoguePrompt,
  normalizeDialogue,
  buildDialogueRepairPrompt,
  buildDialogueLengthPrompt,
  countDialogueChars,
  condenseDialogue,
  buildDialoguePolishPrompt,
  buildPersonaCriticPrompt,
  applyDialoguePolish,
  softenPunctuation
} from './staged/dialogue'
export {
  buildEmotionPrompt,
  normalizeVoiceDirectionPlan,
  normalizeEmotionPlan,
  countEmotionRuns,
  buildEmotionRepairPrompt,
  stabilizeEmotions,
  applyVoiceDirectionPlan,
  applyEmotionPlan
} from './staged/voiceDirection'
export { buildStagingPrompt, fallbackStaging, normalizeStaging } from './staged/staging'
export {
  buildDirectionPrompt,
  buildDirectionRepairPrompt,
  normalizeDirection,
  fallbackDirection
} from './staged/direction'
export { planPresence, composeStory } from './staged/composer'
export {
  buildDirectorReviewPrompt,
  normalizeDirectorReviewResult,
  applyDirectorReviewPatches
} from './staged/directorReview'
