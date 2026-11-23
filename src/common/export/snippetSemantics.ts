import type { ProgressBehavior } from '../types/Story'

/**
 * 官方 `PlayCore` 的 `ProgressBehavior` 前置栅栏（Pre-Start Fence）语义：
 * - WaitFinished（1）：在启动当前片段（及其 delay）之前，先等待所有正在运行的
 *   任务结束；一旦当前片段启动，调度器立即推进到下一条。
 * - Now（0）：不等待前置任务，与上一条在同一个渲染帧同时启动。
 *
 * Talk 额外保留前置栅栏，保证 TTS/字幕/口型不会与上一句 Talk 互相覆盖
 * （即使旧 AI 剧本写了 `wait: false` 且未传 `progressBehavior`）。
 */
export interface SnippetWaitLike {
  type?: string
  wait?: boolean
  progressBehavior?: ProgressBehavior
}

export function resolveProgressBehavior(snippet: SnippetWaitLike): ProgressBehavior {
  if (snippet.progressBehavior === 'WaitFinished') return 'WaitFinished'
  if (snippet.progressBehavior === 'Now') return 'Now'
  return snippet.wait === true ? 'WaitFinished' : 'Now'
}

export function snippetHasPreFence(snippet: SnippetWaitLike): boolean {
  // Talk 没有额外的前置栅栏：只看 ProgressBehavior；Talk 间冲突交给显式等待。
  return resolveProgressBehavior(snippet) === 'WaitFinished'
}

/** 兼容旧调用点名称：返回该片段是否触发前置栅栏。 */
export function snippetBlocksTimeline(snippet: SnippetWaitLike): boolean {
  return snippetHasPreFence(snippet)
}
