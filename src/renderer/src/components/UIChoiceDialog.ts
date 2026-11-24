import { Container, Graphics, Sprite, Text, TextStyle } from 'pixi.js'
import { inappUrl, loadInappTexture } from '../effects/InappTextures'
import AnimationManager from '../managers/AnimationManager'
import { framesForSeconds, framesToMs } from '../../../common/official/timing'
import {
  SIMPLE_SELECTABLE_AUTO_WAIT_SECONDS,
  SIMPLE_SELECTABLE_CLOSE_SECONDS,
  SIMPLE_SELECTABLE_OPEN_SECONDS
} from '../../../common/official/timing'

const DIALOG_SCALE_DURATION_MS = SIMPLE_SELECTABLE_OPEN_SECONDS * 1000
const EXPORT_CHOICE_WAIT_MS = SIMPLE_SELECTABLE_AUTO_WAIT_SECONDS * 1000
const EXPORT_CHOICE_PRESS_MS = 100

/** 官方 `ExportChoice`：作答 = act + frames_for(1.5) = 91，按压 = 作答 − frames_for(0.1) = 85。 */
const EXPORT_CHOICE_ANSWER_FRAMES = framesForSeconds(EXPORT_CHOICE_WAIT_MS / 1000)
const EXPORT_CHOICE_PRESS_FRAMES = framesForSeconds(EXPORT_CHOICE_PRESS_MS / 1000)
/** 作答后 `AnswerChoiceDialog.onFinishAnswerDialog` 等 0.5s = 30 帧；收起缩放占 8 帧。 */
const ANSWER_FINISH_FRAMES = framesForSeconds(SIMPLE_SELECTABLE_CLOSE_SECONDS)
const DIALOG_SCALE_FRAMES = framesForSeconds(DIALOG_SCALE_DURATION_MS / 1000)

interface ChoiceButtonView {
  root: Container
  bg: Sprite | Graphics
  glow: Sprite | Graphics
  label: Text
}

/**
 * 官方 `AnswerChoiceDialog`（`EffectType 23 SimpleSelectable`）：
 * `520x96` 圆角按钮、0→1 `0.125s` 展开、自动选择停顿 `1.5s`、`#A1F4EB` 高亮 + 音效、收起 `0.5s`。
 */
export default class UIChoiceDialog extends Container {
  private readonly k: number
  private readonly screenW: number
  private readonly screenH: number
  private readonly windowRoot: Container
  private animGen = 0

  constructor(screen_width: number, screen_height: number) {
    super()
    this.screenW = screen_width
    this.screenH = screen_height
    this.k = Math.min(screen_width / 1920, screen_height / 1080)
    this.visible = false

    this.windowRoot = new Container()
    this.windowRoot.position.set(screen_width / 2, screen_height / 2 - 40 * this.k)
    this.addChild(this.windowRoot)

    void loadInappTexture('player/loose/Sprite/btn_round_h80_wh.png')
    void loadInappTexture('player/loose/Sprite/eff_btn_round_h80_a70_wh.png')
  }

  private playUiSe(relPath: string): void {
    if (AnimationManager.isExporting() || typeof Audio === 'undefined') return
    try {
      const audio = new Audio(inappUrl(relPath))
      audio.volume = 0.8
      void audio.play().catch(() => undefined)
    } catch {
      // ignore offline or unsupported audio errors
    }
  }

  private createButton(text: string, x: number, y: number): ChoiceButtonView {
    const k = this.k
    const w = 520 * k
    const h = 96 * k
    const r = 48 * k

    const root = new Container()
    root.position.set(x, y)

    const bg = new Graphics()
    bg.lineStyle(2 * k, 0xd8dce8, 0.9)
    bg.beginFill(0xffffff, 0.96)
    bg.drawRoundedRect(-w / 2, -h / 2, w, h, r)
    bg.endFill()

    const glow = new Graphics()
    glow.lineStyle(5 * k, 0xa1f4eb, 0.95)
    glow.beginFill(0xa1f4eb, 0.35)
    glow.drawRoundedRect(-w / 2 - 4 * k, -h / 2 - 4 * k, w + 8 * k, h + 8 * k, r + 4 * k)
    glow.endFill()
    glow.visible = false
    glow.alpha = 0

    const label = new Text(
      text,
      new TextStyle({
        align: 'center',
        fill: '#444466',
        fontFamily: "'MiSans Medium', sans-serif",
        fontSize: 34 * k,
        wordWrap: true,
        wordWrapWidth: w - 48 * k
      })
    )
    label.anchor.set(0.5)

    root.addChild(bg, glow, label)
    this.windowRoot.addChild(root)
    return { root, bg, glow, label }
  }

  public async show(choices: string[], pickedIndex = 0): Promise<number> {
    const gen = ++this.animGen
    for (const child of [...this.windowRoot.children]) {
      this.windowRoot.removeChild(child)
      child.destroy({ children: true })
    }

    const list = choices.length > 0 ? choices : ['...']
    const clampedIndex = Math.max(0, Math.min(list.length - 1, pickedIndex))
    const buttons: ChoiceButtonView[] = []

    if (list.length === 1) {
      buttons.push(this.createButton(list[0], 0, 40 * this.k))
    } else if (list.length === 2) {
      buttons.push(this.createButton(list[0], -360 * this.k, 40 * this.k))
      buttons.push(this.createButton(list[1], 360 * this.k, 40 * this.k))
    } else {
      const stepY = 116 * this.k
      const startY = -((list.length - 1) * stepY) / 2
      list.forEach((choice, idx) => {
        buttons.push(this.createButton(choice, 0, startY + idx * stepY))
      })
    }

    this.visible = true
    this.windowRoot.scale.set(0)
    this.windowRoot.alpha = 1
    this.playUiSe('audio/MenuCommon/SE_UI_CHOICES_OPEN.wav')

    // 官方时序：打开动画与 1.5s 作答等待并行；pressed = answered − 0.1s = 85 帧；
    // 作答 = act+91；作答后收起 8 帧 + 剩余 22 帧，片段 act→finish = 91+30 = 121 帧。
    const pressedMs = framesToMs(EXPORT_CHOICE_ANSWER_FRAMES - EXPORT_CHOICE_PRESS_FRAMES)
    const pressToAnswerMs = framesToMs(EXPORT_CHOICE_PRESS_FRAMES)
    void AnimationManager.linear((p) => {
      if (gen !== this.animGen) return
      this.windowRoot.scale.set(p)
    }, DIALOG_SCALE_DURATION_MS)

    await AnimationManager.delay(pressedMs)
    if (gen !== this.animGen) return clampedIndex

    const pickedBtn = buttons[clampedIndex]
    pickedBtn.glow.visible = true
    pickedBtn.glow.alpha = 1
    pickedBtn.label.style.fill = '#FFFFFF'
    this.playUiSe('audio/MenuCommon_Built_in/SE_DECIDE1.wav')
    this.playUiSe('audio/MenuCommon/SE_UI_CHOICES_DECIDE.wav')

    await AnimationManager.delay(Math.max(0, pressToAnswerMs))
    if (gen !== this.animGen) return clampedIndex

    await AnimationManager.linear((p) => {
      if (gen !== this.animGen) return
      this.windowRoot.scale.set(1 - p)
      this.windowRoot.alpha = 1 - p
    }, DIALOG_SCALE_DURATION_MS)
    await AnimationManager.delay(
      framesToMs(Math.max(0, ANSWER_FINISH_FRAMES - DIALOG_SCALE_FRAMES))
    )
    if (gen !== this.animGen) return clampedIndex

    if (gen === this.animGen) {
      this.visible = false
      for (const child of [...this.windowRoot.children]) {
        this.windowRoot.removeChild(child)
        child.destroy({ children: true })
      }
    }
    return clampedIndex
  }
}
