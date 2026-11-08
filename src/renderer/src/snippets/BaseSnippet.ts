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
    await AnimationManager.delay(this.data.delay * 1000)
  }

  protected abstract handleSnippet(): Promise<void>
}
