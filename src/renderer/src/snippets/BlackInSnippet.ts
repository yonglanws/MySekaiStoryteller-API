import BaseSnippet from './BaseSnippet'

export default class BlackInSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'BlackIn') return

    // 旧剧本/官方片段用秒（0.5），本项目内部特效片段用毫秒（500）。
    // 官方 0.1s 转成 100ms 后必须仍按毫秒处理，所以阈值取 10 而不是 100。
    const duration = this.data.data.duration
    const durationMs = duration > 10 ? duration : duration * 1000
    await this.app.layerSpecialEffect.fadeIn(durationMs, this.data.data.color)
  }
}
