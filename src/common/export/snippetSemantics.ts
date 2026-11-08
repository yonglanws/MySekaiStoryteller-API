/**
 * 官方 scenario 的 `ProgressBehavior`：
 * - 1（WaitFinished）：调度器等该片段协程结束才启动下一条；
 * - 0（Now）：启动协程后立刻继续下一条，协程里的 delay/动画在后台跑。
 *
 * Talk 额外强制阻塞：TTS/字幕/口型按句串行，后台化会让音轨对位和下一句字幕
 * 互相覆盖。官方 328 集里非阻塞 Talk 只有 11 条，代价可以接受。
 */
export interface SnippetWaitLike {
  type?: string
  wait?: boolean
}

export function snippetBlocksTimeline(snippet: SnippetWaitLike): boolean {
  return snippet.wait !== false || snippet.type === 'Talk'
}
