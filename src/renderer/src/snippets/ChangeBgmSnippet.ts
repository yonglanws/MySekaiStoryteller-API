import BaseSnippet from './BaseSnippet'

/**
 * BGM 切换在音频层离线混音时生效（见 AudioMuxer / BgmPlan），
 * 画面侧没有副作用；保留为片段类型是为了让 ChangeBgm 出现在时间线里，
 * 并以零时长决定切歌的时间点。
 */
export default class ChangeBgmSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'ChangeBgm') return
  }
}
