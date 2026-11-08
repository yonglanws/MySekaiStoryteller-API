import { AlphaFilter, Text, TextStyle } from 'pixi.js'
import AnimationManager from '../managers/AnimationManager'
import { TALK_DISPLAY_MS_PER_CHAR, sliceVisibleText, visibleTextLength } from '../utils/TalkTiming'

export default class UIText extends Text {
  public data: string = ''

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
    this.visible = true
    const alphaFilter: AlphaFilter = this.filters![0] as AlphaFilter
    alphaFilter.alpha = 0

    await AnimationManager.linear((progress) => {
      alphaFilter.alpha = progress
    }, time)
  }

  public async hide(time: number): Promise<void> {
    const alphaFilter: AlphaFilter = this.filters![0] as AlphaFilter
    alphaFilter.alpha = 1

    await AnimationManager.linear((progress) => {
      alphaFilter.alpha = 1 - progress
    }, time)

    this.visible = false
  }

  public async startDisplayContent(): Promise<void> {
    // 排版换行不计入官方 4 帧/字；长句被 sanitizeDisplayText 折行后仍保持原速。
    const contentLength = visibleTextLength(this.data)
    const timeMS = contentLength * TALK_DISPLAY_MS_PER_CHAR

    if (contentLength === 0 || timeMS < 30) {
      this.text = this.data
      return
    }

    // 官方 PlayWords(startFirst: true)：第一次迭代就显示 1 个 UTF-16 单元，
    // 之后每 4 帧（66.7ms）多显示一个。
    this.text = sliceVisibleText(this.data, 1)
    await AnimationManager.linear((progress) => {
      const charsToShow = Math.max(1, Math.min(Math.ceil(progress * contentLength), contentLength))
      this.text = sliceVisibleText(this.data, charsToShow)
    }, timeMS)
  }
}
