import { Snippet } from './Snippet'
import { App } from '../app/App'
import { SnippetData } from '../../../common/types/Story'
import AnimationManager from '../managers/AnimationManager'
import getSubLogger from '../utils/Logger'
import { ILogObj, Logger } from 'tslog'

export default abstract class BaseSnippet implements Snippet {
  protected readonly app: App
  protected readonly logger: Logger<ILogObj>
  protected data!: SnippetData
  /** 导出时由 SnippetStrategyManager 写入；后台片段记录动作追踪时用它标注来源。 */
  public snippetIndex = -1
  /** 导出模式：从当前时刻到 plan act 的剩余 delay（启动较晚时缩短，避免 act 漂移）。 */
  public exportDelayMs?: number
  /**
   * 导出模式：plan act 的绝对虚拟墙钟。前置栅栏可能耗时一帧；若 delayOverrideMs
   * 在栅栏前算好、栅栏后才 setTimeout，会把 act 整体推后。runDelay 用绝对时刻
   * 重算剩余时间，保证淡变等片段从 plan act 帧开始。
   */
  public exportActWallMs?: number

  constructor(app: App, data: SnippetData) {
    this.app = app
    this.data = data
    this.logger = getSubLogger(this.constructor.name)
  }

  async runSnippet(): Promise<void> {
    await this.runDelay()
    await this.handleSnippet()
  }

  async runDelay(): Promise<void> {
    if (this.exportActWallMs !== undefined) {
      const now = typeof performance !== 'undefined' ? performance.now() : 0
      // 提前 1µs：目标正好落在故事帧边界时，fake timer 会算到下一 tick。
      const remainingMs = this.exportActWallMs - now - 0.001
      if (remainingMs > 0) await AnimationManager.delay(remainingMs)
      return
    }
    const delayMs = this.exportDelayMs ?? this.data.delay * 1000
    await AnimationManager.delay(delayMs)
  }

  protected abstract handleSnippet(): Promise<void>
}
