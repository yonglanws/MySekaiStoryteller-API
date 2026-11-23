import BaseSnippet from './BaseSnippet'
import {
  PLACE_INFO_TRANSITION_MS,
  normalizeEffectDurationMs
} from '../../../common/official/timing'
import type { ExtendedUILayer } from './stageTiming'

export default class PlaceInfoSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'PlaceInfo') return

    // 官方 PlaceInfo 片段在 act 帧 finish：面板 0.2s OutQuart 滑入在后台继续。
    const durationMs =
      this.data.data.duration !== undefined
        ? normalizeEffectDurationMs(this.data.data.duration)
        : PLACE_INFO_TRANSITION_MS
    const ui = this.app.layerUI as unknown as ExtendedUILayer
    void ui.showPlaceInfo?.(this.data.data.text, durationMs)
  }
}
