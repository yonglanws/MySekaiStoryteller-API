import BaseSnippet from './BaseSnippet'

/**
 * BGM 音量渐变在音频离线混音层处理（AudioMuxer / BgmPlan），
 * 画面侧没有副作用；注册为片段类型以支持时间线与调度器。
 */
export default class BgmVolumeSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'BgmVolume') return
  }
}
