import { Text, TextStyle } from 'pixi.js'
import { GAME_FONT_BODY_STACK, GAME_FONT_BODY_WEIGHT } from '../utils/FontLoader'

export const WATERMARK_LINE_1 = '本视频由 MySekaiStoryteller-API 生成'
export const WATERMARK_LINE_2 = 'Designed by GuangChen2333 & 慵懒午睡'

export type WatermarkAlign = 'left' | 'center' | 'right'

export interface WatermarkLayoutBounds {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
  lineCount: number
}

/**
 * 归一化水印文案换行符：
 * - 统一真实 `\r\n` / `\r` 为 `\n`
 * - 解码单层转义的 `\n` / `\r\n` 为真实换行
 * - 保留双反斜杠转义的 `\\n` 为字面 `\n`
 */
export function normalizeWatermarkText(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return ''
  const decoded = raw
    .replace(/\r\n?/g, '\n')
    .replace(/(\\+)(r\\n|n)/g, (_match, slashes: string, token: string) => {
      const preserved = '\\'.repeat(Math.floor(slashes.length / 2))
      if (slashes.length % 2 === 1) {
        return `${preserved}\n`
      }
      return `${preserved}${token}`
    })

  const lines = decoded.split('\n').map((line) => line.trim())
  while (lines.length > 0 && lines[0] === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

export function resolveWatermarkAlign(anchorX: number): WatermarkAlign {
  if (anchorX >= 0.75) return 'right'
  if (anchorX <= 0.25) return 'left'
  return 'center'
}

function estimateLineWidthPx(line: string, fontSize: number): number {
  let units = 0
  for (const ch of line) {
    units += ch.charCodeAt(0) > 0xff ? 1.0 : 0.58
  }
  return units * fontSize
}

export default class UIWatermark extends Text {
  private readonly screenWidth: number
  private readonly screenHeight: number
  private readonly marginX: number
  private readonly marginY: number
  private readonly baseFontSize: number
  private readonly baseLineHeight: number
  private readonly baseStrokeThickness: number
  private lines: string[]

  constructor(screen_width: number, screen_height: number) {
    const fontSize = screen_height / 48
    const lineHeight = Math.round(fontSize * 1.3)
    const strokeThickness = Math.max(1.5, screen_height / 200)
    const style = new TextStyle({
      align: 'right',
      fill: '#FFFFFFE0',
      fontFamily: GAME_FONT_BODY_STACK,
      fontWeight: GAME_FONT_BODY_WEIGHT,
      fontSize,
      lineHeight,
      stroke: 'rgba(68, 68, 102, 0.75)',
      strokeThickness,
      lineJoin: 'round',
      wordWrap: false
    })
    const initialLines = [WATERMARK_LINE_1, WATERMARK_LINE_2]
    super(initialLines.join('\n'), style)

    this.screenWidth = screen_width
    this.screenHeight = screen_height
    this.marginX = screen_width / 48
    this.marginY = screen_height / 36
    this.baseFontSize = fontSize
    this.baseLineHeight = lineHeight
    this.baseStrokeThickness = strokeThickness
    this.lines = initialLines

    this.anchor.set(1, 0)
    this.x = screen_width - this.marginX
    this.y = this.marginY
    this.updateLayout()
  }

  /**
   * 设置自定义水印：
   * - 支持真实换行（`\n` / `\r\n`）及转义 `\n` 的多行文案
   * - 过滤空行及与自带标题重复的文案，保留每行独立换行展示
   * - 自动同步文本对齐方式并将多行文本块约束在画布安全边距内，避免裁切
   */
  public setCustomText(customText: string): void {
    const normalized = normalizeWatermarkText(customText)
    const customLines = normalized
      ? normalized
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => {
            if (!line) return false
            const lower = line.toLowerCase()
            if (line === WATERMARK_LINE_1 || line === WATERMARK_LINE_2) return false
            if (lower.includes('mysekaistoryteller') && lower.includes('生成')) return false
            return true
          })
      : []

    this.lines =
      customLines.length > 0
        ? [WATERMARK_LINE_1, ...customLines]
        : [WATERMARK_LINE_1, WATERMARK_LINE_2]
    this.text = this.lines.join('\n')
    this.updateLayout()
  }

  /**
   * 按当前行数、锚点与画布尺寸同步对齐方式、行高与坐标约束，
   * 确保单行与 2–4+ 行水印均清晰排布且不会裁切出画布边缘。
   */
  public updateLayout(): void {
    this.style.align = resolveWatermarkAlign(this.anchor.x)

    const lineCount = Math.max(1, this.lines.length)
    const maxWidth = Math.max(1, this.screenWidth - this.marginX * 2)
    const maxHeight = Math.max(1, this.screenHeight - this.marginY * 2)

    const baseBlockWidth = this.estimateBlockWidth(this.baseFontSize, this.baseStrokeThickness)
    const baseBlockHeight = lineCount * this.baseLineHeight + this.baseStrokeThickness

    const widthRatio = baseBlockWidth > maxWidth ? maxWidth / baseBlockWidth : 1
    const heightRatio = baseBlockHeight > maxHeight ? maxHeight / baseBlockHeight : 1
    const fitRatio = Math.min(1, widthRatio, heightRatio)

    let fontSize = this.baseFontSize
    let lineHeight = this.baseLineHeight
    let strokeThickness = this.baseStrokeThickness

    if (fitRatio < 1) {
      fontSize = Math.max(6, this.baseFontSize * fitRatio)
      strokeThickness = Math.max(1, this.baseStrokeThickness * fitRatio)
      const maxLineHeight = Math.max(1, Math.floor((maxHeight - strokeThickness) / lineCount))
      lineHeight = Math.max(1, Math.min(Math.round(fontSize * 1.3), maxLineHeight))
    }

    this.style.fontSize = fontSize
    this.style.lineHeight = lineHeight
    this.style.strokeThickness = strokeThickness

    const blockWidth = Math.min(maxWidth, this.estimateBlockWidth(fontSize, strokeThickness))
    const blockHeight = Math.min(maxHeight, lineCount * lineHeight + strokeThickness)

    const minX = this.marginX + blockWidth * this.anchor.x
    const maxX = this.screenWidth - this.marginX - blockWidth * (1 - this.anchor.x)
    this.x =
      minX <= maxX
        ? Math.min(Math.max(this.x, minX), maxX)
        : this.anchor.x >= 0.5
          ? this.screenWidth - this.marginX
          : this.marginX

    const minY = this.marginY + blockHeight * this.anchor.y
    const maxY = this.screenHeight - this.marginY - blockHeight * (1 - this.anchor.y)
    this.y = minY <= maxY ? Math.min(Math.max(this.y, minY), maxY) : this.marginY
  }

  /** 返回当前文本块在逻辑画布中的估算包围盒，便于布局校验与单测断言。 */
  public getLayoutBounds(): WatermarkLayoutBounds {
    const lineCount = Math.max(1, this.lines.length)
    const fontSize = Number(this.style.fontSize) || this.baseFontSize
    const lineHeight = Number(this.style.lineHeight) || this.baseLineHeight
    const strokeThickness = Number(this.style.strokeThickness) || 0
    const maxWidth = Math.max(1, this.screenWidth - this.marginX * 2)
    const maxHeight = Math.max(1, this.screenHeight - this.marginY * 2)
    const width = Math.min(maxWidth, this.estimateBlockWidth(fontSize, strokeThickness))
    const height = Math.min(maxHeight, lineCount * lineHeight + strokeThickness)
    const left = this.x - width * this.anchor.x
    const top = this.y - height * this.anchor.y
    return {
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      lineCount
    }
  }

  private estimateBlockWidth(fontSize: number, strokeThickness: number): number {
    let maxLineWidth = 0
    for (const line of this.lines) {
      const w = estimateLineWidthPx(line, fontSize)
      if (w > maxLineWidth) maxLineWidth = w
    }
    return maxLineWidth + strokeThickness
  }
}
