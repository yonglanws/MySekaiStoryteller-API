import { Text, TextStyle } from 'pixi.js'

const WATERMARK_LINE_1 = '本视频由 MySekaiStoryteller-API 生成'
const WATERMARK_LINE_2 = 'Designed by GuangChen2333 & 慵懒午睡'

export default class UIWatermark extends Text {
  constructor(screen_width: number, screen_height: number) {
    const fontSize = screen_height / 42
    const style = new TextStyle({
      align: 'right',
      fill: '#FFFFFFF5',
      fontFamily: 'Source Han Sans SC',
      fontSize,
      lineHeight: fontSize * 1.35,
      stroke: '#4A4968D9',
      strokeThickness: Math.max(2, screen_height / 180),
      wordWrap: false
    })
    super(`${WATERMARK_LINE_1}\n${WATERMARK_LINE_2}`, style)

    this.anchor.set(1, 0)
    this.x = screen_width - screen_width / 48
    this.y = screen_height / 36
  }
}
