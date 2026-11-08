import BaseLayer from './BaseLayer'
import { Application, Texture } from 'pixi.js'
import ui_text_background from '../../assets/ui/ui_text_background.svg'
import ui_text_underline from '../../assets/ui/ui_text_underline.svg'
import ui_telop from '../../assets/ui/ui_telop.svg'
import UITextBackground from '../components/UITextBackground'
import UITextUnderline from '../components/UITextUnderline'
import UIText from '../components/UIText'
import UISpeakerText from '../components/UISpeakerText'
import UITelop from '../components/UITelop'
import UIWatermark from '../components/UIWatermark'
import AnimationManager from '../managers/AnimationManager'
import {
  TALK_WINDOW_OPEN_CLOSE_MS,
  TELOP_ANIM_CLIP_MS,
  TELOP_AUTO_HOLD_MS
} from '../../../common/official/timing'

export default class UILayer extends BaseLayer {
  private readonly textBackgroundSprite!: UITextBackground
  private readonly textUnderlineSprite!: UITextUnderline
  private readonly textSprite!: UIText
  private readonly textSpeakerSprite!: UISpeakerText
  private readonly telopContainer!: UITelop
  private readonly watermarkSprite!: UIWatermark

  private _UITalkShowed: boolean = false

  constructor(app: Application) {
    super(app, 2)
    const textBackgroundTexture = Texture.from(ui_text_background)
    const textUnderlineTexture = Texture.from(ui_text_underline)
    const telopTexture = Texture.from(ui_telop)

    this.textBackgroundSprite = new UITextBackground(
      textBackgroundTexture,
      this.app.screen.width,
      this.app.screen.height
    )
    this.textUnderlineSprite = new UITextUnderline(
      textUnderlineTexture,
      this.app.screen.width,
      this.app.screen.height
    )
    this.textSprite = new UIText(this.app.screen.width, this.app.screen.height)
    this.textSpeakerSprite = new UISpeakerText(
      this.app.screen.width,
      this.app.screen.height,
      this.textUnderlineSprite.y - this.app.screen.width / 37
    )
    this.telopContainer = new UITelop(telopTexture, this.app.screen.width, this.app.screen.height)
    this.watermarkSprite = new UIWatermark(this.app.screen.width, this.app.screen.height)
    this.watermarkSprite.visible = false
    this.watermarkSprite.zIndex = 4

    this.layerContainer.addChild(this.textBackgroundSprite)
    this.layerContainer.addChild(this.textUnderlineSprite)
    this.layerContainer.addChild(this.textSprite)
    this.layerContainer.addChild(this.textSpeakerSprite)
    this.layerContainer.addChild(this.telopContainer)
    this.app.stage.addChild(this.watermarkSprite)
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

  public async showTextBackground(): Promise<void> {
    this._UITalkShowed = true
    // TalkWindow.Open：PlayActive(1, 0.2)，打字从 OnCompleteOpen 开始。
    const showDuration = TALK_WINDOW_OPEN_CLOSE_MS
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

  public async hideTextBackground(): Promise<void> {
    // TalkWindow.Close 先把 canvas group 的 alpha 设为 0，tween 只延迟 OnCompleteClose；
    // 画面上是立即消失，不做 100ms 淡出。
    this._UITalkShowed = false
    const hideDuration = 0
    await Promise.all([
      this.textBackgroundSprite.hide(hideDuration),
      this.textUnderlineSprite.hide(hideDuration),
      this.textSprite.hide(hideDuration),
      this.textSpeakerSprite.hide(hideDuration)
    ])
  }

  get UITalkShowed(): boolean {
    return this._UITalkShowed
  }
}
