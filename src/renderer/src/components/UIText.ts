import { AlphaFilter, Text, TextStyle } from 'pixi.js'
import AnimationManager from '../managers/AnimationManager'
import { TALK_DISPLAY_MS_PER_CHAR, sliceVisibleText, visibleTextLength } from '../utils/TalkTiming'

/**
 * 官方 `TalkWindow/Words`（`[250, 858, 1368.3, 154]` @ 1920×1080）：
 * - 行宽 1368.3 * k（对应约 30 个全角汉字/行）；
 * - 去除旧版厚重 `#4A4968D9` 描边，保持清晰锐利的 `#FFFFFF` 字形与轻微投影。
 */
export default class UIText extends Text {
  public data: string = ''
  private animGen = 0

  constructor(screen_width: number, screen_height: number) {
    const k = Math.min(screen_width / 1920, screen_height / 1080)
    const style = new TextStyle({
      align: 'left',
      fill: '#FFFFFF',
      fontFamily: "'MiSans Medium', sans-serif",
      fontSize: 42 * k,
      lineHeight: 48 * k,
      strokeThickness: 0,
      dropShadow: true,
      dropShadowColor: 'rgba(10, 12, 34, 0.55)',
      dropShadowBlur: 2 * k,
      dropShadowDistance: 1.5 * k,
      wordWrap: true,
      wordWrapWidth: 1368.3 * k,
      breakWords: true
    })
    super('', style)

    this.x = 250 * k
    this.y = 858 * k

    const alphaFilter = new AlphaFilter(0)
    alphaFilter.resolution = 2
    this.filters = [alphaFilter]
  }

  public async show(time: number): Promise<void> {
    const gen = ++this.animGen
    this.visible = true
    const alphaFilter = this.filters![0] as AlphaFilter
    alphaFilter.alpha = time <= 0 ? 1 : 0
    if (time > 0) {
      await AnimationManager.linear((progress) => {
        if (gen !== this.animGen) return
        alphaFilter.alpha = progress
      }, time)
      if (gen === this.animGen) alphaFilter.alpha = 1
    }
  }

  public async hide(time: number): Promise<void> {
    const gen = ++this.animGen
    const alphaFilter = this.filters![0] as AlphaFilter
    if (time <= 0) {
      alphaFilter.alpha = 0
      this.visible = false
      return
    }
    const from = alphaFilter.alpha
    await AnimationManager.linear((progress) => {
      if (gen !== this.animGen) return
      alphaFilter.alpha = from * (1 - progress)
    }, time)
    if (gen === this.animGen) {
      alphaFilter.alpha = 0
      this.visible = false
    }
  }

  public async startDisplayContent(): Promise<void> {
    const gen = ++this.animGen
    const contentLength = visibleTextLength(this.data)
    const timeMS = contentLength * TALK_DISPLAY_MS_PER_CHAR

    if (contentLength === 0 || timeMS < 30) {
      this.text = this.data
      return
    }

    // 官方 PlayWords(startFirst: true)：第一次迭代就显示 1 个 UTF-16 单元，之后每 4 帧（66.7ms）多显示一个。
    this.text = sliceVisibleText(this.data, 1)
    await AnimationManager.linear((progress) => {
      if (gen !== this.animGen) return
      const charsToShow = Math.max(1, Math.min(Math.ceil(progress * contentLength), contentLength))
      this.text = sliceVisibleText(this.data, charsToShow)
    }, timeMS)
    if (gen === this.animGen) {
      this.text = this.data
    }
  }
}
