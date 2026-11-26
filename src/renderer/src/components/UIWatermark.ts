import { Text, TextStyle } from 'pixi.js'
import { GAME_FONT_BODY_STACK, GAME_FONT_BODY_WEIGHT } from '../utils/FontLoader'

const WATERMARK_LINE_1 = '本视频由 MySekaiStoryteller-API 生成'
const WATERMARK_LINE_2 = 'Designed by GuangChen2333 & 慵懒午睡'
/** 自定义水印最多保留条数，合并进第二行避免右上角堆叠过多行 */
const MAX_CUSTOM_LINES = 2

export default class UIWatermark extends Text {
  constructor(screen_width: number, screen_height: number) {
    const fontSize = screen_height / 48
    const style = new TextStyle({
      align: 'right',
      fill: '#FFFFFFE0',
      fontFamily: GAME_FONT_BODY_STACK,
      fontWeight: GAME_FONT_BODY_WEIGHT,
      fontSize,
      lineHeight: fontSize * 1.3,
      stroke: 'rgba(68, 68, 102, 0.75)',
      strokeThickness: Math.max(1.5, screen_height / 200),
      lineJoin: 'round',
      wordWrap: false
    })
    super(`${WATERMARK_LINE_1}\n${WATERMARK_LINE_2}`, style)

    this.anchor.set(1, 0)
    this.x = screen_width - screen_width / 48
    this.y = screen_height / 36
  }

  /**
   * 设置自定义水印：过滤与自带标题重复的文案后，精简为至多两行右对齐展示，
   * 避免右上角堆叠 3~4 行造成遮挡。
   */
  public setCustomText(customText: string): void {
    const customLines = String(customText || '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => {
        if (!line) return false
        const lower = line.toLowerCase()
        if (line === WATERMARK_LINE_1 || line === WATERMARK_LINE_2) return false
        if (lower.includes('mysekaistoryteller') && lower.includes('生成')) return false
        return true
      })
      .slice(0, MAX_CUSTOM_LINES)

    const lines =
      customLines.length > 0
        ? [WATERMARK_LINE_1, customLines.join(' · ')]
        : [WATERMARK_LINE_1, WATERMARK_LINE_2]
    this.text = lines.join('\n')
  }
}
