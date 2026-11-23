import { AlphaFilter, Text, TextStyle } from 'pixi.js'
import AnimationManager from '../managers/AnimationManager'
import { TALK_DISPLAY_MS_PER_CHAR, sliceVisibleText, visibleTextLength } from '../utils/TalkTiming'

export default class UIText extends Text {
  public data: string = ''
  private animGen = 0

  constructor(screen_width: number, screen_height: number) {
    const x = screen_width / 8

    const style = new TextStyle({
      align: 'left',
      fill: '#FFFFFFF5',
      fontFamily: "'MiSans Medium', sans-serif",
      fontSize: screen_height / 26,
      lineHeight: screen_height / 19,
      stroke: '#4A4968D9',
      strokeThickness: screen_height / 120,
      wordWrap: true,
      wordWrapWidth: screen_width - x * 2
    })
    super('', style)

    this.x = x
    this.y = screen_height / 1.27

    const alpha_filter = new AlphaFilter(0)
    alpha_filter.resolution = 2
    this.filters = [alpha_filter]
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

  /**
   * `typingLength` 是官方正文的字符数（译文 content 可能更短/更长）；显示仍按
   * content 逐字揭示，但整个打字窗与官方 4 帧/字一致。
   */
  public async startDisplayContent(typingLength = visibleTextLength(this.data)): Promise<void> {
    const gen = ++this.animGen
    // 排版换行不计入官方 4 帧/字；长句被 sanitizeDisplayText 折行后仍保持原速。
    const contentLength = visibleTextLength(this.data)
    const timeMS = Math.max(0, typingLength) * TALK_DISPLAY_MS_PER_CHAR

    if (contentLength === 0 || timeMS < 30) {
      this.text = this.data
      return
    }

    // 官方 ShowWords(startFirst: true)：第一次迭代就显示 1 个字，之后每 4 帧
    // （两个半字）多显示一个；第 4 帧第 2 个字已可见。
    this.text = sliceVisibleText(this.data, 1)
    await AnimationManager.linear((progress) => {
      if (gen !== this.animGen) return
      const charsToShow = Math.max(
        1,
        Math.min(1 + Math.floor(progress * contentLength + 1e-9), contentLength)
      )
      this.text = sliceVisibleText(this.data, charsToShow)
    }, timeMS)
    if (gen === this.animGen) {
      this.text = this.data
    }
  }
}
