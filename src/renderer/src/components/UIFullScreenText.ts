import { Container, Graphics, Text, TextStyle } from 'pixi.js'
import { runEasedTween } from '../effects/Ease'
import AnimationManager from '../managers/AnimationManager'
import {
  FULLSCREEN_BARS_MS,
  FULLSCREEN_CHAR_FADE_MS,
  FULLSCREEN_TEXT_PRE_DELAY_MS
} from '../../../common/official/timing'

const FST_BASE_ALPHA = 0.5
const FST_CINEMASCOPE_HEIGHT = 240

/**
 * 官方 `ScenarioFullScreenTextDialog`（`EffectType 24`）：
 * 上下 `240px` 黑边（OutQuad `1.0s`），`0.5` 半透底幕，居中叙事文字逐段渐现，支持 `keepBars` 连续播放。
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

  public async show(opts: { text: string; durationMs?: number; keepBars?: boolean }): Promise<void> {
    const gen = ++this.animGen
    const targetBarH = FST_CINEMASCOPE_HEIGHT * this.k
    this.visible = true
    this.label.text = opts.text
    this.label.alpha = 0

    if (!this.barsOpen) {
      await runEasedTween(
        FULLSCREEN_BARS_MS,
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
      await AnimationManager.delay(FULLSCREEN_TEXT_PRE_DELAY_MS)
      if (gen !== this.animGen) return
    } else {
      this.backdrop.alpha = FST_BASE_ALPHA
      this.drawBars(targetBarH)
    }

    // 文字渐现（按文本长度分片 0.125s/段，最长不超过 600ms 保证流畅）
    const fadeInMs = Math.min(600, Math.max(200, Math.ceil(opts.text.length / 8) * FULLSCREEN_CHAR_FADE_MS))
    await AnimationManager.linear((p) => {
      if (gen !== this.animGen) return
      this.label.alpha = p
    }, fadeInMs)
    if (gen !== this.animGen) return
    this.label.alpha = 1

    const holdMs = opts.durationMs !== undefined ? Math.max(0, opts.durationMs) : Math.max(1200, opts.text.length * 67)
    if (holdMs > 0) {
      await AnimationManager.delay(holdMs)
      if (gen !== this.animGen) return
    }

    if (!opts.keepBars) {
      await this.hide()
    }
  }

  public async hide(durationMs = FULLSCREEN_BARS_MS): Promise<void> {
    if (!this.visible && !this.barsOpen) return
    const gen = ++this.animGen
    const targetBarH = FST_CINEMASCOPE_HEIGHT * this.k
    const startLabelAlpha = this.label.alpha
    const startBackdropAlpha = this.backdrop.alpha

    await runEasedTween(
      durationMs,
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
}
