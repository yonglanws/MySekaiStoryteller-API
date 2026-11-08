import BaseSnippet from './BaseSnippet'

/** SE 停止由导出音频层离线处理（见 SePlan / AudioMuxer）。 */
export default class StopSeSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'StopSe') return
  }
}
