import { Application, Container, Texture } from 'pixi.js'
import BaseLayer from './BaseLayer'
import ui_text_background from '../../assets/ui/ui_text_background.svg'
import ui_text_underline from '../../assets/ui/ui_text_underline.svg'
import ui_telop from '../../assets/ui/ui_telop.svg'
import UITextBackground from '../components/UITextBackground'
import UITextUnderline from '../components/UITextUnderline'
import UIText from '../components/UIText'
import UISpeakerText from '../components/UISpeakerText'
import UITelop from '../components/UITelop'
import UIWatermark from '../components/UIWatermark'
import UIPlaceInfo from '../components/UIPlaceInfo'
import UIFullScreenText from '../components/UIFullScreenText'
import UIChoiceDialog from '../components/UIChoiceDialog'
import AnimationManager from '../managers/AnimationManager'
import { createMulberry32 } from '../effects/OfficialFilters'
import {
  SHAKE_RANDOMNESS,
  SHAKE_VIBRATO,
  buildShakePlan,
  shakeOffsetAt,
  shakeOffsetToScreen
} from '../../../common/official/screenShake'
import { recordEffectProbe } from '../utils/EffectProbe'
import {
  PLACE_INFO_TRANSITION_MS,
  TALK_WINDOW_OPEN_CLOSE_MS,
  TELOP_ANIM_CLIP_MS,
  TELOP_AUTO_HOLD_MS,
  framesForSeconds
} from '../../../common/official/timing'

export default class UILayer extends BaseLayer {
  private readonly k: number
  private readonly textBackgroundSprite: UITextBackground
  private readonly textUnderlineSprite: UITextUnderline
  private readonly wordsContainer: Container
  private readonly textSprite: UIText
  private readonly textSpeakerSprite: UISpeakerText
  private readonly telopContainer: UITelop
  private readonly watermarkSprite: UIWatermark
  private readonly placeInfoBanner: UIPlaceInfo
  private readonly fullScreenTextDialog: UIFullScreenText
  private readonly choiceDialog: UIChoiceDialog

  private _UITalkShowed = false
  private talkWindowHideGen = 0
  private windowShakeGen = 0

  constructor(app: Application) {
    super(app, 2)
    const w = this.app.screen.width
    const h = this.app.screen.height
    this.k = Math.min(w / 1920, h / 1080)

    this.textBackgroundSprite = new UITextBackground(Texture.from(ui_text_background), w, h)
    this.textUnderlineSprite = new UITextUnderline(Texture.from(ui_text_underline), w, h)
    this.textSprite = new UIText(w, h)
    this.textSpeakerSprite = new UISpeakerText(w, h)
    // 官方 `TalkWindow/Window/ContentRoot/Content/Text`：ShakeWindow 同步抖动姓名与正文，底板与底条保持静止
    this.wordsContainer = new Container()
    this.wordsContainer.addChild(this.textSpeakerSprite, this.textSprite)

    this.telopContainer = new UITelop(Texture.from(ui_telop), w, h)
    this.watermarkSprite = new UIWatermark(w, h)
    this.watermarkSprite.visible = false
    this.watermarkSprite.zIndex = 4

    this.placeInfoBanner = new UIPlaceInfo(w, h)
    this.fullScreenTextDialog = new UIFullScreenText(w, h)
    this.choiceDialog = new UIChoiceDialog(w, h)

    this.textBackgroundSprite.visible = false
    this.textUnderlineSprite.visible = false
    this.textSprite.visible = false
    this.textSpeakerSprite.visible = false

    this.layerContainer.addChild(
      this.fullScreenTextDialog,
      this.textBackgroundSprite,
      this.textUnderlineSprite,
      this.wordsContainer,
      this.placeInfoBanner,
      this.telopContainer,
      this.choiceDialog
    )
    this.app.stage.addChild(this.watermarkSprite)
  }

  public getContainer(): Container {
    return this.layerContainer
  }

  public setWatermarkVisible(visible: boolean): void {
    this.watermarkSprite.visible = visible
  }

  public setWatermarkText(customText: string): void {
    this.watermarkSprite.setCustomText(customText)
  }

  public async telop(text: string): Promise<void> {
    this.telopContainer.text = text
    await this.telopContainer.show(TELOP_ANIM_CLIP_MS)
    await AnimationManager.delay(TELOP_AUTO_HOLD_MS)
    await this.telopContainer.hide(TELOP_ANIM_CLIP_MS)
  }

  public resetTalkData(): void {
    this.textSpeakerSprite.text = ''
    this.textSprite.text = ''
    this.textSprite.data = ''
  }

  public setTalkData(speaker: string, content: string): void {
    this.textSpeakerSprite.text = speaker
    this.textSprite.data = content
  }

  public renderTalkContentImmediately(): void {
    this.textSprite.text = this.textSprite.data
  }

  public async showTextBackground(durationMs = TALK_WINDOW_OPEN_CLOSE_MS): Promise<void> {
    const gen = ++this.talkWindowHideGen
    this._UITalkShowed = true
    // TalkWindow.Open：PlayActive(1, 0.2)，打字从 OnCompleteOpen 开始。
    const showDuration = Math.max(0, durationMs)
    await Promise.all([
      this.textBackgroundSprite.show(showDuration),
      this.textUnderlineSprite.show(showDuration),
      this.textSprite.show(showDuration),
      this.textSpeakerSprite.show(showDuration)
    ])
    if (gen === this.talkWindowHideGen) {
      this._UITalkShowed = true
    }
  }

  /** 无缝衔接下一句台词时取消任何残留退场渐变，并同步把对话框拉回完全不透明。 */
  public ensureTalkWindowVisible(): void {
    this.talkWindowHideGen++
    this._UITalkShowed = true
    void this.textBackgroundSprite.show(0)
    void this.textUnderlineSprite.show(0)
    void this.textSprite.show(0)
    void this.textSpeakerSprite.show(0)
  }

  public async startDisplayContent(typingLength?: number): Promise<void> {
    await this.textSprite.startDisplayContent(typingLength)
  }

  public async hideTextBackground(durationMs = 0): Promise<void> {
    // 发起关闭即把 _UITalkShowed 置 false：下一句 Talk 若在 200ms 渐隐期开始，
    // 必须重新走 showTextBackground() 取消本次 hide 并从当前 alpha 顺滑拉回 1。
    const gen = ++this.talkWindowHideGen
    this._UITalkShowed = false
    const hideDuration = Math.max(0, durationMs)
    this.stopShakeWindow()

    await Promise.all([
      this.textBackgroundSprite.hide(hideDuration),
      this.textUnderlineSprite.hide(hideDuration),
      this.textSprite.hide(hideDuration),
      this.textSpeakerSprite.hide(hideDuration)
    ])
    if (gen === this.talkWindowHideGen) {
      this._UITalkShowed = false
    }
  }

  public async showPlaceInfo(text: string, durationMs = PLACE_INFO_TRANSITION_MS): Promise<void> {
    await this.placeInfoBanner.show(text, durationMs)
  }

  public async closePlaceInfo(): Promise<void> {
    await this.placeInfoBanner.close(PLACE_INFO_TRANSITION_MS)
  }

  public async showFullScreenText(opts: {
    text: string
    durationMs?: number
    keepBars?: boolean
  }): Promise<void> {
    await this.fullScreenTextDialog.show(opts)
  }

  public async hideFullScreenText(): Promise<void> {
    await this.fullScreenTextDialog.hide()
  }

  public async showChoiceDialog(choices: string[], pickedIndex = 0): Promise<number> {
    return this.choiceDialog.show(choices, pickedIndex)
  }

  /**
   * 官方 `EffectType 6 ShakeWindow`: 抖动对话框内 `Text` 容器（包含 `Name` 姓名与 `Words` 正文），
   * 对话框底板与名字底线静止不动（对齐 `SekaiStoryExporter/crates/sse-render/src/lib.rs`）。
   * `DOShakeAnchorPos(Duration, 10, 16, 90, ignoreZ=true, fadeOut=true)`，
   * 与震屏共用 DOTween 分段，但按绝对帧求值（导出时钟单源）。
   */
  public async shakeWindow(durationSec: number, intensity = 10): Promise<void> {
    const gen = ++this.windowShakeGen
    const clampedSec = Math.min(3600, Math.max(0, durationSec))
    const durationMs = clampedSec * 1000
    const amp =
      (intensity > 0 && intensity < 1 ? intensity * this.app.screen.height : intensity) * this.k
    const plan = buildShakePlan({
      durationSeconds: clampedSec,
      strength: amp,
      rng: createMulberry32((gen * 2654435761) >>> 0),
      vibrato: SHAKE_VIBRATO,
      randomness: SHAKE_RANDOMNESS,
      ignoreZAxis: true,
      fadeOut: true
    })
    const startWall = performance.now()
    recordEffectProbe('shake-window', {
      durationSec: clampedSec,
      segments: plan.segments,
      strength: amp,
      resolution: this.app.renderer?.resolution ?? 1,
      ...(plan.segments <= 64 ? { ends: plan.ends, offsets: plan.offsets } : {})
    })

    await AnimationManager.linear(
      (progress) => {
        if (gen !== this.windowShakeGen) return
        const [x, y] = shakeOffsetToScreen(shakeOffsetAt(plan, progress * clampedSec))
        this.wordsContainer.position.set(x, y)
      },
      Math.max(1, durationMs),
      false,
      { startMs: startWall, frames: framesForSeconds(clampedSec) }
    )

    if (gen === this.windowShakeGen) {
      this.wordsContainer.position.set(0, 0)
    }
  }

  public stopShakeWindow(): void {
    this.windowShakeGen++
    this.wordsContainer.position.set(0, 0)
  }

  get UITalkShowed(): boolean {
    return this._UITalkShowed
  }
}
