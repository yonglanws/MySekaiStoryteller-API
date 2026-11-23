import { Snippet } from '../snippets/Snippet'
import { App } from '../app/App'
import ChangeBackgroundImageSnippet from '../snippets/ChangeBackgroundImageSnippet'
import ChangeBgmSnippet from '../snippets/ChangeBgmSnippet'
import { SnippetData } from '../../../common/types/Story'
import { snippetHasPreFence } from '../../../common/export/snippetSemantics'
import { estimateSnippetDuration } from '../utils/TimelineCalculator'
import ChangeLayoutModeSnippet from '../snippets/ChangeLayoutModeSnippet'
import LayoutAppearSnippet from '../snippets/LayoutAppearSnippet'
import { ILogObj, Logger } from 'tslog'
import getSubLogger from '../utils/Logger'
import LayoutClearSnippet from '../snippets/LayoutClearSnippet'
import LayoutDepthSnippet from '../snippets/LayoutDepthSnippet'
import CharacterShakeSnippet from '../snippets/CharacterShakeSnippet'
import CostumeChangeSnippet from '../snippets/CostumeChangeSnippet'
import TalkSnippet from '../snippets/TalkSnippet'
import HideTalkSnippet from '../snippets/HideTalkSnippet'
import MoveSnippet from '../snippets/MoveSnippet'
import MotionSnippet from '../snippets/MotionSnippet'
import TelopSnippet from '../snippets/TelopSnippet'
import PlaceInfoSnippet from '../snippets/PlaceInfoSnippet'
import FullScreenTextSnippet from '../snippets/FullScreenTextSnippet'
import SimpleSelectableSnippet from '../snippets/SimpleSelectableSnippet'
import WaitSnippet from '../snippets/WaitSnippet'
import BlackOutSnippet from '../snippets/BlackOutSnippet'
import BlackInSnippet from '../snippets/BlackInSnippet'
import DoParamSnippet from '../snippets/DoParamSnippet'
import PlaySeSnippet from '../snippets/PlaySeSnippet'
import StopSeSnippet from '../snippets/StopSeSnippet'
import ShakeScreenSnippet from '../snippets/ShakeScreenSnippet'
import StopShakeScreenSnippet from '../snippets/StopShakeScreenSnippet'
import ShakeWindowSnippet from '../snippets/ShakeWindowSnippet'
import StopShakeWindowSnippet from '../snippets/StopShakeWindowSnippet'
import FlashbackInSnippet from '../snippets/FlashbackInSnippet'
import FlashbackOutSnippet from '../snippets/FlashbackOutSnippet'
import SepiaInSnippet from '../snippets/SepiaInSnippet'
import SepiaOutSnippet from '../snippets/SepiaOutSnippet'
import SekaiInSnippet from '../snippets/SekaiInSnippet'
import SekaiOutSnippet from '../snippets/SekaiOutSnippet'
import WipeSnippet from '../snippets/WipeSnippet'
import CameraMoveSnippet from '../snippets/CameraMoveSnippet'
import CameraZoomSnippet from '../snippets/CameraZoomSnippet'
import DollyZoomSnippet from '../snippets/DollyZoomSnippet'
import AmbientColorSnippet from '../snippets/AmbientColorSnippet'
import SideFadeSnippet from '../snippets/SideFadeSnippet'
import AttachCharacterShaderSnippet from '../snippets/AttachCharacterShaderSnippet'
import PlayScenarioEffectSnippet from '../snippets/PlayScenarioEffectSnippet'
import StopScenarioEffectSnippet from '../snippets/StopScenarioEffectSnippet'
import BlurInSnippet from '../snippets/BlurInSnippet'
import BlurOutSnippet from '../snippets/BlurOutSnippet'
import BackgroundBlurSnippet from '../snippets/BackgroundBlurSnippet'
import StopShakeSnippet from '../snippets/StopShakeSnippet'
import BgmVolumeSnippet from '../snippets/BgmVolumeSnippet'
import MovieSnippet from '../snippets/MovieSnippet'
import { resetStageTiming } from '../snippets/stageTiming'
import { BackgroundSnippetTasks } from '../utils/BackgroundSnippetTasks'

export default class SnippetStrategyManager {
  private readonly app: App
  private readonly logger: Logger<ILogObj> = getSubLogger('SnippetStrategyManager')
  private readonly snippets!: { [key: string]: new (app: App, data: SnippetData) => Snippet }
  /** PlayCore 当前正在运行的协程集合（WaitFinished 前置栅栏与收尾统一等待）。 */
  private readonly runningTasks = new BackgroundSnippetTasks()
  private lastLaunchedTask: Promise<void> = Promise.resolve()
  /**
   * 片段 `runSnippet()` 启动（同步前缀已应用初始状态）后的回调。
   * 导出帧泵用它保证帧 0 拍到第一个片段的初始画面。
   */
  onSnippetStarted: ((snippetIndex: number) => void) | null = null

  constructor(app: App) {
    this.app = app
    this.snippets = {
      ChangeBackgroundImage: ChangeBackgroundImageSnippet,
      ChangeBgm: ChangeBgmSnippet,
      BgmVolume: BgmVolumeSnippet,
      ChangeLayoutMode: ChangeLayoutModeSnippet,
      LayoutAppear: LayoutAppearSnippet,
      LayoutClear: LayoutClearSnippet,
      LayoutDepth: LayoutDepthSnippet,
      CharacterShake: CharacterShakeSnippet,
      CostumeChange: CostumeChangeSnippet,
      Talk: TalkSnippet,
      HideTalk: HideTalkSnippet,
      Move: MoveSnippet,
      Motion: MotionSnippet,
      Telop: TelopSnippet,
      PlaceInfo: PlaceInfoSnippet,
      FullScreenText: FullScreenTextSnippet,
      SimpleSelectable: SimpleSelectableSnippet,
      Wait: WaitSnippet,
      BlackOut: BlackOutSnippet,
      BlackIn: BlackInSnippet,
      DoParam: DoParamSnippet,
      PlaySe: PlaySeSnippet,
      StopSe: StopSeSnippet,
      ShakeScreen: ShakeScreenSnippet,
      StopShakeScreen: StopShakeScreenSnippet,
      ShakeWindow: ShakeWindowSnippet,
      StopShakeWindow: StopShakeWindowSnippet,
      FlashbackIn: FlashbackInSnippet,
      FlashbackOut: FlashbackOutSnippet,
      SepiaIn: SepiaInSnippet,
      SepiaOut: SepiaOutSnippet,
      SekaiIn: SekaiInSnippet,
      SekaiOut: SekaiOutSnippet,
      Wipe: WipeSnippet,
      CameraMove: CameraMoveSnippet,
      CameraZoom: CameraZoomSnippet,
      DollyZoom: DollyZoomSnippet,
      AmbientColor: AmbientColorSnippet,
      SideFade: SideFadeSnippet,
      AttachCharacterShader: AttachCharacterShaderSnippet,
      PlayScenarioEffect: PlayScenarioEffectSnippet,
      StopScenarioEffect: StopScenarioEffectSnippet,
      BlurIn: BlurInSnippet,
      BlurOut: BlurOutSnippet,
      BackgroundBlur: BackgroundBlurSnippet,
      StopShake: StopShakeSnippet,
      Movie: MovieSnippet
    }
  }

  /** 官方 PlayCore 前置栅栏：WaitFinished（或 Talk）在 delay 开始前等所有在跑任务结束。 */
  async waitForPreFence(data: SnippetData): Promise<void> {
    if (snippetHasPreFence(data)) {
      await this.runningTasks.settle()
    }
  }

  getLastLaunchedTask(): Promise<void> {
    return this.lastLaunchedTask
  }

  private async dispatchSnippet(
    data: SnippetData,
    snippetIndex: number,
    forExport: boolean
  ): Promise<void> {
    const snippetConstructor = this.snippets[data.type]
    if (!snippetConstructor) {
      throw new TypeError(`Not implemented ${data.type}`)
    }

    await this.waitForPreFence(data)

    const snippet = new snippetConstructor(this.app, data)
    snippet.snippetIndex = snippetIndex

    if (forExport && this.app.lastSnippetActualDurationMs === 0) {
      this.app.lastSnippetActualDurationMs = estimateSnippetDuration(data)
    }

    const task = snippet.runSnippet()
    this.lastLaunchedTask = task
    this.runningTasks.track(task)
    this.onSnippetStarted?.(snippetIndex)
    if (!forExport) {
      void task.catch((error) => this.logger.error(error))
    }
  }

  async handleSnippet(data: SnippetData, snippetIndex = -1): Promise<void> {
    await this.dispatchSnippet(data, snippetIndex, false)
  }

  async handleSnippetForExport(data: SnippetData, snippetIndex = -1): Promise<void> {
    await this.dispatchSnippet(data, snippetIndex, true)
  }

  /** 官方 WaitAllFinished：等所有仍在运行的协程结束。 */
  async settleBackgroundSnippets(): Promise<void> {
    await this.runningTasks.settle()
  }

  /** 新一次导出/播放开始前清掉上一次的引用与阶段计时状态。 */
  resetBackgroundSnippets(): void {
    this.runningTasks.reset()
    this.lastLaunchedTask = Promise.resolve()
    resetStageTiming(this.app)
  }
}
