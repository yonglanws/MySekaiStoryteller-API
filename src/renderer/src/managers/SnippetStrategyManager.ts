import { Snippet } from '../snippets/Snippet'
import { App } from '../app/App'
import ChangeBackgroundImageSnippet from '../snippets/ChangeBackgroundImageSnippet'
import ChangeBgmSnippet from '../snippets/ChangeBgmSnippet'
import { SnippetData } from '../../../common/types/Story'
import { snippetBlocksTimeline } from '../../../common/export/snippetSemantics'
import { estimateSnippetDuration } from '../utils/TimelineCalculator'
import ChangeLayoutModeSnippet from '../snippets/ChangeLayoutModeSnippet'
import LayoutAppearSnippet from '../snippets/LayoutAppearSnippet'
import { ILogObj, Logger } from 'tslog'
import getSubLogger from '../utils/Logger'
import LayoutClearSnippet from '../snippets/LayoutClearSnippet'
import TalkSnippet from '../snippets/TalkSnippet'
import HideTalkSnippet from '../snippets/HideTalkSnippet'
import MoveSnippet from '../snippets/MoveSnippet'
import MotionSnippet from '../snippets/MotionSnippet'
import TelopSnippet from '../snippets/TelopSnippet'
import BlackOutSnippet from '../snippets/BlackOutSnippet'
import BlackInSnippet from '../snippets/BlackInSnippet'
import DoParamSnippet from '../snippets/DoParamSnippet'
import PlaySeSnippet from '../snippets/PlaySeSnippet'
import StopSeSnippet from '../snippets/StopSeSnippet'
import ShakeScreenSnippet from '../snippets/ShakeScreenSnippet'
import FlashbackInSnippet from '../snippets/FlashbackInSnippet'
import FlashbackOutSnippet from '../snippets/FlashbackOutSnippet'
import WipeSnippet from '../snippets/WipeSnippet'
import CameraMoveSnippet from '../snippets/CameraMoveSnippet'
import CameraZoomSnippet from '../snippets/CameraZoomSnippet'
import AmbientColorSnippet from '../snippets/AmbientColorSnippet'
import SideFadeSnippet from '../snippets/SideFadeSnippet'
import BackgroundBlurSnippet from '../snippets/BackgroundBlurSnippet'
import StopShakeSnippet from '../snippets/StopShakeSnippet'
import { BackgroundSnippetTasks } from '../utils/BackgroundSnippetTasks'

export default class SnippetStrategyManager {
  private readonly app: App
  private readonly logger: Logger<ILogObj> = getSubLogger('SnippetStrategyManager')
  private readonly snippets!: { [key: string]: new (app: App, data: SnippetData) => Snippet }
  /** ProgressBehavior=0 的协程：导出时不阻塞下一条，收尾统一等待。 */
  private readonly backgroundSnippets = new BackgroundSnippetTasks()

  constructor(app: App) {
    this.app = app
    this.snippets = {
      ChangeBackgroundImage: ChangeBackgroundImageSnippet,
      ChangeBgm: ChangeBgmSnippet,
      ChangeLayoutMode: ChangeLayoutModeSnippet,
      LayoutAppear: LayoutAppearSnippet,
      LayoutClear: LayoutClearSnippet,
      Talk: TalkSnippet,
      HideTalk: HideTalkSnippet,
      Move: MoveSnippet,
      Motion: MotionSnippet,
      Telop: TelopSnippet,
      BlackOut: BlackOutSnippet,
      BlackIn: BlackInSnippet,
      DoParam: DoParamSnippet,
      PlaySe: PlaySeSnippet,
      StopSe: StopSeSnippet,
      ShakeScreen: ShakeScreenSnippet,
      FlashbackIn: FlashbackInSnippet,
      FlashbackOut: FlashbackOutSnippet,
      Wipe: WipeSnippet,
      CameraMove: CameraMoveSnippet,
      CameraZoom: CameraZoomSnippet,
      AmbientColor: AmbientColorSnippet,
      SideFade: SideFadeSnippet,
      BackgroundBlur: BackgroundBlurSnippet,
      StopShake: StopShakeSnippet
    }
  }

  async handleSnippet(data: SnippetData): Promise<void> {
    const snippetConstructor = this.snippets[data.type]
    if (snippetConstructor) {
      const snippet = new snippetConstructor(this.app, data)

      if (data.wait) {
        await snippet.runSnippet()
      } else {
        snippet.runSnippet().catch(this.logger.error)
      }
    } else {
      throw new TypeError(`Not implemented ${data.type}`)
    }
  }

  async handleSnippetForExport(data: SnippetData, snippetIndex = -1): Promise<void> {
    const snippetConstructor = this.snippets[data.type]
    if (!snippetConstructor) {
      throw new TypeError(`Not implemented ${data.type}`)
    }

    const snippet = new snippetConstructor(this.app, data)
    snippet.snippetIndex = snippetIndex
    if (snippetBlocksTimeline(data)) {
      await snippet.runSnippet()
    } else {
      // 官方 ProgressBehavior=0：启动协程后立刻继续下一条。delay/动画都在后台跑。
      this.backgroundSnippets.track(snippet.runSnippet())
    }

    if (this.app.lastSnippetActualDurationMs === 0) {
      this.app.lastSnippetActualDurationMs = snippetBlocksTimeline(data)
        ? Math.max((data.delay || 0) * 1000, estimateSnippetDuration(data))
        : 0
    }
  }

  /** 导出收尾：官方 WaitAllFinished 等所有后台协程结束。 */
  async settleBackgroundSnippets(): Promise<void> {
    await this.backgroundSnippets.settle()
  }

  /** 新一次导出开始前清掉上一次的引用；旧任务应由 abort/自然结束收尾。 */
  resetBackgroundSnippets(): void {
    this.backgroundSnippets.reset()
  }
}
