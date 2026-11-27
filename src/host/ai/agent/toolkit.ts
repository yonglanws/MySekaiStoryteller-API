import { parseToolArgs } from './actingSemantics'
import { executeCompileDialogueWorkflow } from './toolkitCompile'
import {
  createToolkitRuntimeContext,
  type StoryAgentToolkit,
  type StoryAgentToolkitDeps
} from './toolkitContext'
import { STORY_AGENT_TOOL_DEFINITIONS } from './toolkitDefinitions'
import { executeDraftTool } from './toolkitDraft'
import { executeResearchTool } from './toolkitResearch'

export type {
  DirectorReviewRecord,
  SavedStoryPlan,
  StoryAgentToolkit,
  StoryAgentToolkitDeps
} from './toolkitContext'

/**
 * 构建供 Agentic Loop 使用的完整自主导演工具集：
 * - 角色、服装与表情/动作一体化批量查询（lookup_character, inspect_character_expressions, recommend_acting_for_lines）
 * - 官方资源/特效/场景 Cue 批量检索（search_assets）
 * - 官方语料与演技规范检索（search_official_corpus）
 * - 状态化大纲、草稿管理与导演终审（plan_story_outline, save_story_draft, inspect_story_draft, patch_story_draft, submit_director_review, finalize_story_draft）
 * - 对白、舞台、剧情表情动作逐句质检（validate_dialogue_draft, critique_story_draft, validate_story_draft）
 */
export function createStoryAgentToolkit(deps: StoryAgentToolkitDeps): StoryAgentToolkit {
  const ctx = createToolkitRuntimeContext(deps)

  const execute = async (name: string, rawArgs: unknown, signal?: AbortSignal): Promise<string> => {
    const args = parseToolArgs(rawArgs)

    const researchRes = await executeResearchTool(ctx, name, args, signal)
    if (researchRes !== null) return researchRes

    const compileRes = await executeCompileDialogueWorkflow(ctx, name, args, signal)
    if (compileRes !== null) return compileRes

    const draftRes = executeDraftTool(ctx, name, args)
    if (draftRes !== null) return draftRes

    return JSON.stringify({ error: `未知工具：${name}` })
  }

  return {
    definitions: STORY_AGENT_TOOL_DEFINITIONS,
    execute,
    getSavedDraft: () => ctx.state.savedDraft,
    getSavedPlan: () => ctx.state.savedPlan,
    getDirectorReview: () => ctx.state.directorReview,
    isFinalized: () => ctx.state.finalized
  }
}
