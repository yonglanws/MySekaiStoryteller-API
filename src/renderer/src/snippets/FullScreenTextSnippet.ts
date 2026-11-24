import BaseSnippet from './BaseSnippet'
import { normalizeEffectDurationMs } from '../../../common/official/timing'
import type { ExtendedUILayer } from './stageTiming'

export default class FullScreenTextSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'FullScreenText') return

    const durationMs =
      this.data.data.duration !== undefined
        ? normalizeEffectDurationMs(this.data.data.duration)
        : undefined
    // 参考按相邻 instruction 判定：连续的全屏文字共用一个对话框（黑边不收起）。
    // 剧本没写 keepBars 时，由下一条是否同类补上。
    const next =
      this.snippetIndex >= 0 ? this.app.storyManager?.snippets?.[this.snippetIndex + 1] : undefined
    const keepBars = this.data.data.keepBars === true || next?.type === 'FullScreenText'
    const ui = this.app.layerUI as unknown as ExtendedUILayer
    await ui.showFullScreenText?.({
      text: this.data.data.text,
      durationMs,
      keepBars
    })
  }
}
