import { Container, Graphics, Text, TextStyle } from 'pixi.js'
import { evaluateEase } from '../effects/Ease'
import AnimationManager from '../managers/AnimationManager'
import {
  FRAME_MS,
  FST_BARS_FRAMES,
  FST_FADE_FRAMES,
  FST_HOLD_FRAMES,
  FST_OPEN_DELAY_FRAMES,
  FST_SLOT_FRAMES,
  fullScreenTextSlots
} from '../../../common/official/timing'

const FST_BASE_ALPHA = 0.5
const FST_CINEMASCOPE_HEIGHT = 240

/**
 * 官方 `ScenarioFullScreenTextDialog`（`EffectType 24`）：
 * 上下 `240px` 黑边（OutQuad 61 帧），`0.5` 半透底幕，居中叙事文字逐槽
 * 0.125s（8 帧）显示；槽数取 `max(8, UTF-32 长度)`，跨行只增不减。
 */
export default class UIFullScreenText extends Container {
  private readonly k: number
  private readonly widthPx: number
  private readonly heightPx: number
  private readonly backdrop: Graphics
  private readonly topBar: Graphics
  private readonly bottomBar: Graphics
  private readonly label: Text
  private barsOpen = false
  /** TMP `characterInfo` 槽数：新对话重置为 8，跨行只增不减。 */
  private slots = 0
  private animGen = 0

  constructor(screen_width: number, screen_height: number) {
    super()
    this.widthPx = screen_width
    this.heightPx = screen_height
    this.k = Math.min(screen_width / 1920, screen_height / 1080)
    this.visible = false

    this.backdrop = new Graphics()
    this.backdrop.beginFill(0x000000, 1)
    this.backdrop.drawRect(0, 0, screen_width, screen_height)
    this.backdrop.endFill()
    this.backdrop.alpha = 0

    this.topBar = new Graphics()
    this.bottomBar = new Graphics()
    this.drawBars(0)

    const style = new TextStyle({
      align: 'left',
      fill: '#FFFFFF',
      fontFamily: "'MiSans Medium', sans-serif",
      fontSize: 52 * this.k,
      lineHeight: 76 * this.k,
      wordWrap: true,
      wordWrapWidth: Math.max(200, screen_width - 560 * this.k),
      breakWords: true
    })
    this.label = new Text('', style)
    this.label.anchor.set(0, 0.5)
    this.label.x = 280 * this.k
    this.label.y = screen_height / 2
    this.label.alpha = 0

    this.addChild(this.backdrop, this.topBar, this.bottomBar, this.label)
  }

  private drawBars(barHeight: number): void {
    this.topBar.clear()
    this.bottomBar.clear()
    if (barHeight <= 0.1) return
    this.topBar.beginFill(0x000000, 1)
    this.topBar.drawRect(0, 0, this.widthPx, barHeight)
    this.topBar.endFill()

    this.bottomBar.beginFill(0x000000, 1)
    this.bottomBar.drawRect(0, this.heightPx - barHeight, this.widthPx, barHeight)
    this.bottomBar.endFill()
  }

  /** 按故事帧等待：`frames×FRAME_MS` 且提前 1µs，避免正好落在帧边界时多等一 tick。 */
  private waitFrames(frames: number): Promise<void> {
    const ms = frames * FRAME_MS - 0.001
    return ms > 0 ? AnimationManager.delay(ms) : Promise.resolve()
  }

  /** 按故事帧求值的缓动（与 `runEasedTween` 相同，但时长来自整数帧而不是毫秒）。 */
  private async tweenFrames(
    frames: number,
    ease: string,
    onProgress: (eased: number) => void,
    isCancelled?: () => boolean
  ): Promise<void> {
    if (frames <= 0) {
      if (!isCancelled?.()) onProgress(1)
      return
    }
    const startMs = typeof performance !== 'undefined' ? performance.now() : 0
    await AnimationManager.linear(
      (raw) => {
        if (isCancelled?.()) return
        onProgress(evaluateEase(ease, raw))
      },
      frames * FRAME_MS,
      false,
      { startMs, frames }
    )
    if (!isCancelled?.()) onProgress(1)
  }

  /**
   * 官方 `ScenarioFullScreenTextDialog.PlayCore`：
   * 新对话先黑边 1s + 0.5s，随后逐槽 0.125s 显示（槽数 `max(8, UTF-32 长度)`，
   * 新对话初值 8、跨行只增不减），停留 1s；最后一行再淡出 1s。
   * 单行 8 槽 = 61+30+64+61+61 = 277 帧。`durationMs` 属于旧扩展，不再参与官方时长。
   */
  public async show(opts: {
    text: string
    durationMs?: number
    keepBars?: boolean
    slots?: number
  }): Promise<void> {
    const gen = ++this.animGen
    const targetBarH = FST_CINEMASCOPE_HEIGHT * this.k
    const text = opts.text ?? ''
    const shownText = text.replace(/^[\n\r]+/, '')
    const chars = Array.from(shownText)
    this.visible = true
    this.label.text = ''
    this.label.alpha = 0

    if (!this.barsOpen) {
      this.slots = 0
      await this.tweenFrames(
        FST_BARS_FRAMES,
        'OutQuad',
        (p) => {
          if (gen !== this.animGen) return
          this.backdrop.alpha = FST_BASE_ALPHA * p
          this.drawBars(targetBarH * p)
        },
        () => gen !== this.animGen
      )
      if (gen !== this.animGen) return
      this.barsOpen = true
      await this.waitFrames(FST_OPEN_DELAY_FRAMES)
      if (gen !== this.animGen) return
    } else {
      this.backdrop.alpha = FST_BASE_ALPHA
      this.drawBars(targetBarH)
    }

    const slots = fullScreenTextSlots(this.slots, text)
    this.slots = slots
    this.label.alpha = 1
    for (let slot = 1; slot <= slots; slot++) {
      this.label.text = chars.slice(0, Math.min(chars.length, slot)).join('')
      await this.waitFrames(FST_SLOT_FRAMES)
      if (gen !== this.animGen) return
    }

    await this.waitFrames(FST_HOLD_FRAMES)
    if (gen !== this.animGen) return

    if (!opts.keepBars) {
      await this.hideFrames(FST_FADE_FRAMES)
    }
  }

  /** 片尾 `FadeOutAll(1) ∥ bars out`：按故事帧淡出并收起黑边。 */
  public async hideFrames(frames = FST_FADE_FRAMES): Promise<void> {
    if (!this.visible && !this.barsOpen) return
    const gen = ++this.animGen
    const targetBarH = FST_CINEMASCOPE_HEIGHT * this.k
    const startLabelAlpha = this.label.alpha
    const startBackdropAlpha = this.backdrop.alpha

    await this.tweenFrames(
      frames,
      'OutQuad',
      (p) => {
        if (gen !== this.animGen) return
        this.label.alpha = startLabelAlpha * (1 - p)
        this.backdrop.alpha = startBackdropAlpha * (1 - p)
        this.drawBars(targetBarH * (1 - p))
      },
      () => gen !== this.animGen
    )

    if (gen === this.animGen) {
      this.barsOpen = false
      this.visible = false
      this.label.alpha = 0
      this.backdrop.alpha = 0
      this.drawBars(0)
    }
  }

  /** 兼容 layer API：默认按最后一行淡出的 61 帧收起。 */
  public async hide(frames = FST_FADE_FRAMES): Promise<void> {
    await this.hideFrames(frames)
  }
}
