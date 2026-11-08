export interface Snippet {
  /** 导出时由 SnippetStrategyManager 写入，用于动作追踪归因。 */
  snippetIndex: number
  runSnippet(): Promise<void>
}
