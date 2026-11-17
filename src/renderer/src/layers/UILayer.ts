import { Container, Graphics, Sprite, Text, TextStyle, Texture, Ticker, Application } from 'pixi.js'
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
import { loadInappTexture } from '../effects/InappTextures'
import { createMulberry32 } from '../effects/OfficialFilters'
import {
  PLACE_INFO_TRANSITION_MS,
  TALK_WINDOW_OPEN_CLOSE_MS,
  TELOP_ANIM_CLIP_MS,
  TELOP_AUTO_HOLD_MS
} from '../../../common/official/timing'

const AUTO_ICON_ON_SEC = 0.50276244
const END_SIGN_PERIOD_SEC = 1.0833333

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

  private readonly autoContainer: Container
  private readonly autoBlinkIcon: Sprite | Graphics
  private readonly menuContainer: Container
  private readonly endSignContainer: Container
  private readonly endSignBaseY: number

  private _UITalkShowed = false
  private talkTypingCompleted = false
  private windowVisGen = 0
  private windowShakeGen = 0
  private chromeTimerSec = 0

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

    this.textSpeakerSprite = new UISpeakerText(w, h)
    this.telopContainer = new UITelop(Texture.from(ui_telop), w, h)
    this.watermarkSprite = new UIWatermark(w, h)
    this.placeInfoBanner = new UIPlaceInfo(w, h)
    this.fullScreenTextDialog = new UIFullScreenText(w, h)
    this.choiceDialog = new UIChoiceDialog(w, h)

    // 官方 `AUTO` 指示器 `[1656, 1008, 200, 48]`
    this.autoContainer = new Container()
    this.autoContainer.visible = false
    this.autoContainer.alpha = 0
    const autoBg = new Graphics()
    autoBg.beginFill(0x444466, 0.8)
    autoBg.drawRoundedRect(1656 * this.k, 1008 * this.k, 200 * this.k, 48 * this.k, 24 * this.k)
    autoBg.endFill()
    const autoText = new Text(
      'AUTO',
      new TextStyle({
        fill: '#FFFFFF',
        fontFamily: "'MiSans Medium', sans-serif",
        fontSize: 28 * this.k,
        fontWeight: '600',
        letterSpacing: -1 * this.k
      })
    )
    autoText.anchor.set(0, 0.5)
    autoText.position.set((1656 + 78) * this.k, (1008 + 24) * this.k)

    const triIcon = new Graphics()
    triIcon.beginFill(0xffffff, 1)
    const triR = 11 * this.k
    triIcon.drawPolygon([-triR * 0.6, -triR * 0.85, triR, 0, -triR * 0.6, triR * 0.85])
    triIcon.endFill()
    triIcon.position.set((1656 + 56) * this.k, (1008 + 24) * this.k)
    this.autoBlinkIcon = triIcon
    this.autoContainer.addChild(autoBg, triIcon, autoText)

    // 官方 `MENU` 圆形按钮 `[1808, 16, 96, 96]`
    this.menuContainer = new Container()
    const menuCx = (1808 + 48) * this.k
    const menuCy = (16 + 48) * this.k
    const menuBg = new Graphics()
    menuBg.lineStyle(2 * this.k, 0x444466, 0.14)
    menuBg.beginFill(0xffffff, 0.94)
    menuBg.drawCircle(menuCx, menuCy, 44 * this.k)
    menuBg.endFill()
    const menuDots = new Graphics()
    menuDots.beginFill(0x444466, 1)
    for (const dx of [-16, 0, 16]) {
      menuDots.drawCircle(menuCx + dx * this.k, menuCy, 5 * this.k)
    }
    menuDots.endFill()
    this.menuContainer.addChild(menuBg, menuDots)

    void loadInappTexture('player/loose/Sprite/btn_circle_h80_wh.png').then((tex) => {
      if (!this.menuContainer.destroyed && tex && tex.valid && tex.baseTexture?.valid) {
        const sp = new Sprite(tex)
        sp.anchor.set(0.5)
        sp.position.set(menuCx, menuCy)
        sp.width = 96 * this.k
        sp.height = 96 * this.k
        this.menuContainer.addChildAt(sp, 0)
        menuBg.visible = false
      }
    })
    void loadInappTexture('player/loose/Sprite/icon_menu_story_wh.png').then((tex) => {
      if (!this.menuContainer.destroyed && tex && tex.valid && tex.baseTexture?.valid) {
        const iconSp = new Sprite(tex)
        iconSp.anchor.set(0.5)
        iconSp.position.set(menuCx, menuCy)
        iconSp.width = 52 * this.k
        iconSp.height = 12 * this.k
        iconSp.tint = 0x444466
        this.menuContainer.addChild(iconSp)
        menuDots.visible = false
      }
    })

    // 官方 `EndSign` `[1593.5, 1050]`，尺寸 `[50, 44]`
    this.endSignContainer = new Container()
    this.endSignBaseY = 1050 * this.k
    this.endSignContainer.position.set(1593.5 * this.k, this.endSignBaseY)
    this.endSignContainer.visible = false

    const endSignVec = new Graphics()
    endSignVec.beginFill(0x6ee7c8, 0.95)
    endSignVec.drawPolygon([-20 * this.k, -34 * this.k, 20 * this.k, -34 * this.k, 0, -4 * this.k])
    endSignVec.endFill()
    this.endSignContainer.addChild(endSignVec)

    void loadInappTexture('player/loose/Sprite/icon_pageForward_gn.png').then((tex) => {
      if (!this.endSignContainer.destroyed && tex && tex.valid && tex.baseTexture?.valid) {
        const sp = new Sprite(tex)
        sp.anchor.set(0.5, 1)
        sp.width = 50 * this.k
        sp.height = 44 * this.k
        this.endSignContainer.addChild(sp)
        endSignVec.visible = false
      }
    })

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
      this.autoContainer,
      this.endSignContainer,
      this.placeInfoBanner,
      this.telopContainer,
      this.choiceDialog,
      this.menuContainer,
      this.watermarkSprite
    )

    Ticker.shared.add(this.updateChromeTicker, this)
  }

  public getContainer(): Container {
    return this.layerContainer
  }

  private updateChromeTicker = (): void => {
    const dtSec = Math.max(0, Ticker.shared.elapsedMS) / 1000
    this.chromeTimerSec += dtSec

    if (this._UITalkShowed) {
      this.autoBlinkIcon.visible = this.chromeTimerSec % 1.0 < AUTO_ICON_ON_SEC
    }
    const showEndSign = this._UITalkShowed && this.talkTypingCompleted
    this.endSignContainer.visible = showEndSign
    if (showEndSign) {
      const phase = (this.chromeTimerSec % END_SIGN_PERIOD_SEC) / END_SIGN_PERIOD_SEC
      const bob = Math.sin(phase * Math.PI * 2) * 3.5 * this.k
      this.endSignContainer.y = this.endSignBaseY - bob
      this.endSignContainer.scale.y = phase < 0.25 ? 0.95 + phase * 0.2 : 1.0
    }
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
    this.talkTypingCompleted = false
    this.textSprite.text = ''
    this.textSpeakerSprite.text = ''
  }

  public setTalkData(speaker: string, content: string): void {
    this.talkTypingCompleted = false
    this.textSpeakerSprite.text = speaker
    this.textSprite.data = content
  }

  public renderTalkContentImmediately(): void {
    this.textSprite.text = this.textSprite.data
    this.talkTypingCompleted = true
  }

  public async showTextBackground(durationMs = TALK_WINDOW_OPEN_CLOSE_MS): Promise<void> {
    const gen = ++this.windowVisGen
    this._UITalkShowed = true
    this.autoContainer.visible = true

    const openTask = Promise.all([
      this.textBackgroundSprite.show(durationMs),
      this.textUnderlineSprite.show(durationMs),
      this.textSprite.show(durationMs),
      this.textSpeakerSprite.show(durationMs),
      AnimationManager.linear((p) => {
        if (gen !== this.windowVisGen) return
        this.autoContainer.alpha = p
      }, durationMs)
    ])
    await openTask
    if (gen === this.windowVisGen) {
      this.autoContainer.alpha = 1
    }
  }

  public async startDisplayContent(): Promise<void> {
    this.talkTypingCompleted = false
    await this.textSprite.startDisplayContent()
    this.talkTypingCompleted = true
  }

  /**
   * 隐藏对话框（`HideTalk` 或 `Talk.closeWindowOnFinish`）：
   * 支持平滑线性淡出（默认 `200ms`，传 `0` 立即关闭）。
   */
  public async hideTextBackground(durationMs = TALK_WINDOW_OPEN_CLOSE_MS): Promise<void> {
    const gen = ++this.windowVisGen
    this._UITalkShowed = false
    this.talkTypingCompleted = false
    this.endSignContainer.visible = false
    this.stopShakeWindow()

    const fadeMs = Math.max(0, durationMs)
    const startAutoAlpha = this.autoContainer.alpha
    await Promise.all([
      this.textBackgroundSprite.hide(fadeMs),
      this.textUnderlineSprite.hide(fadeMs),
      this.textSprite.hide(fadeMs),
      this.textSpeakerSprite.hide(fadeMs),
      fadeMs > 0
        ? AnimationManager.linear((p) => {
            if (gen !== this.windowVisGen) return
            this.autoContainer.alpha = startAutoAlpha * (1 - p)
          }, fadeMs)
        : Promise.resolve()
    ])
    if (gen === this.windowVisGen) {
      this.autoContainer.visible = false
      this.autoContainer.alpha = 0
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
   * 官方 `EffectType 6 ShakeWindow`: 只抖动对话框内 `Words` 正文容器，
   * 对话框底板、名字底线、姓名文本、AUTO 指示器、MENU 按钮均静止不动。
   */
  public async shakeWindow(durationSec: number, intensity = 10): Promise<void> {
    const gen = ++this.windowShakeGen
    const clampedSec = Math.min(3600, Math.max(0, durationSec))
    const durationMs = clampedSec * 1000
    const amp = (intensity > 0 && intensity < 1 ? intensity * this.app.screen.height : intensity) * this.k
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
