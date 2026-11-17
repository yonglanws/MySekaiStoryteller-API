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
import { evaluateEase } from '../effects/Ease'
import { createMulberry32 } from '../effects/OfficialFilters'
import {
  PLACE_INFO_TRANSITION_MS,
  TALK_WINDOW_OPEN_CLOSE_MS,
  TELOP_ANIM_CLIP_MS,
  TELOP_AUTO_HOLD_MS
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
  private windowShakeGen = 0

  constructor(app: Application) {
    super(app, 2)
    const w = this.app.screen.width
    const h = this.app.screen.height
    this.k = Math.min(w / 1920, h / 1080)

    this.textBackgroundSprite = new UITextBackground(Texture.from(ui_text_background), w, h)
    this.textUnderlineSprite = new UITextUnderline(Texture.from(ui_text_underline), w, h)
    this.textSprite = new UIText(w, h)
    this.wordsContainer = new Container()
    this.wordsContainer.addChild(this.textSprite)

    this.textSpeakerSprite = new UISpeakerText(w, h, this.textUnderlineSprite.y - w / 37)
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
      this.textSpeakerSprite,
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
    this._UITalkShowed = true
    // TalkWindow.Open：PlayActive(1, 0.2)，打字从 OnCompleteOpen 开始。
    const showDuration = Math.max(0, durationMs)
    await Promise.all([
      this.textBackgroundSprite.show(showDuration),
      this.textUnderlineSprite.show(showDuration),
      this.textSprite.show(showDuration),
      this.textSpeakerSprite.show(showDuration)
    ])
  }

  public async startDisplayContent(): Promise<void> {
    await this.textSprite.startDisplayContent()
  }

  public async hideTextBackground(durationMs = 0): Promise<void> {
    // TalkWindow.Close 先把 canvas group 的 alpha 设为 0，tween 只延迟 OnCompleteClose；
    // 默认立即消失（0ms），也兼容传入显式淡出时长。
    this._UITalkShowed = false
    this.stopShakeWindow()

    const hideDuration = Math.max(0, durationMs)
    await Promise.all([
      this.textBackgroundSprite.hide(hideDuration),
      this.textUnderlineSprite.hide(hideDuration),
      this.textSprite.hide(hideDuration),
      this.textSpeakerSprite.hide(hideDuration)
    ])
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
   * 官方 `EffectType 6 ShakeWindow`: 只抖动对话框内 `Words` 正文容器，
   * 对话框底板、名字底线、姓名文本均静止不动。
   */
  public async shakeWindow(durationSec: number, intensity = 10): Promise<void> {
    const gen = ++this.windowShakeGen
    const clampedSec = Math.min(3600, Math.max(0, durationSec))
    const durationMs = clampedSec * 1000
    const amp =
      (intensity > 0 && intensity < 1 ? intensity * this.app.screen.height : intensity) * this.k
    const fadeOut = clampedSec < 3600
    const vibrato = Math.max(8, Math.round(16 * Math.max(0.5, Math.min(60, clampedSec))))
    const rng = createMulberry32((gen * 2654435761) >>> 0)
    const dirs = Array.from({ length: vibrato + 1 }, () => {
      const a = rng() * Math.PI * 2
      return [Math.cos(a), Math.sin(a)] as const
    })

    await AnimationManager.linear((progress) => {
      if (gen !== this.windowShakeGen) return
      const decay = fadeOut ? 1 - evaluateEase('OutQuad', progress) : 1
      const segFloat = progress * vibrato
      const seg = Math.min(vibrato - 1, Math.floor(segFloat))
      const env = Math.sin((segFloat - seg) * Math.PI)
      const [dx, dy] = dirs[seg]
      this.wordsContainer.position.set(dx * amp * env * decay, dy * amp * env * decay)
    }, Math.max(1, durationMs))

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
