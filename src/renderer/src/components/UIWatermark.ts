import { Text, TextStyle } from 'pixi.js'

const WATERMARK_LINE_1 = '本视频由 MySekaiStoryteller-API 生成'
const WATERMARK_LINE_2 = 'Designed by GuangChen2333 & 慵懒午睡'
/** 自定义水印最多追加行数，防止过长配置向下顶出画面 */
const MAX_CUSTOM_LINES = 2

export default class UIWatermark extends Text {
  constructor(screen_width: number, screen_height: number) {
    const fontSize = screen_height / 42
    const style = new TextStyle({
      align: 'right',
      fill: '#FFFFFFF5',
      fontFamily: "'MiSans Medium', sans-serif",
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

  /**
   * 设置自定义水印：追加在自带两行水印的下一行（右对齐，样式一致）。
   * 传空串或纯空白则只显示自带水印。
   */
  public setCustomText(customText: string): void {
    const customLines = String(customText || '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, MAX_CUSTOM_LINES)

    const lines = [WATERMARK_LINE_1, WATERMARK_LINE_2, ...customLines]
    this.text = lines.join('\n')
  }
}
