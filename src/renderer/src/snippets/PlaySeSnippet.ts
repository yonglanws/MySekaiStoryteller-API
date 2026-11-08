import BaseSnippet from './BaseSnippet'

/** SE 由导出音频层离线混音（见 SePlan / AudioMuxer），画面片段本身不做事。 */
export default class PlaySeSnippet extends BaseSnippet {
  protected async handleSnippet(): Promise<void> {
    if (this.data.type !== 'PlaySe') return
  }
}
