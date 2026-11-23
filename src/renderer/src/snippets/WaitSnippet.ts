import BaseSnippet from './BaseSnippet'
import AnimationManager from '../managers/AnimationManager'

/** 纯等待（官方 Action 0 / wait 节点）；不产生画面状态。 */
export default class WaitSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'Wait') return
    const durationMs = Math.max(0, Number(this.data.data.duration) || 0)
    if (durationMs > 0) await AnimationManager.delay(durationMs)
  }
}
