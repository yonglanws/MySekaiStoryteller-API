/**
 * ProgressBehavior=0 的后台片段任务。
 *
 * 官方调度器在启动协程后立刻继续下一条；导出收尾的 WaitAllFinished 再统一等待。
 * 这里只负责记录 Promise：每个 task 都先挂一个 null-catch，避免后台失败在收尾前
 * 触发 unhandledRejection；settle 仍会拿到原始 rejection 并让导出失败。
 */
export class BackgroundSnippetTasks {
  private readonly tasks = new Set<Promise<void>>()

  get size(): number {
    return this.tasks.size
  }

  track(task: Promise<void>): void {
    this.tasks.add(task)
    void task.catch(() => undefined).finally(() => this.tasks.delete(task))
  }

  async settle(): Promise<void> {
    while (this.tasks.size > 0) {
      const batch = [...this.tasks]
      const results = await Promise.allSettled(batch)
      for (const task of batch) this.tasks.delete(task)
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      )
      if (failure) throw failure.reason
    }
  }

  reset(): void {
    this.tasks.clear()
  }
}
