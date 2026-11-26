import { AlphaFilter, Text, TextMetrics, TextStyle } from 'pixi.js'
import AnimationManager from '../managers/AnimationManager'
import {
  GAME_FONT_NAME_STACK,
  GAME_FONT_NAME_WEIGHT,
  SSE_UI_SPEC,
  computePixiTextPosition,
  sseLineAdvance,
  sseOutlineThickness,
  type PixiFontMetricsLike
} from '../utils/FontLoader'

const NAME = SSE_UI_SPEC.name

function measureStyleFontMetrics(style: TextStyle): PixiFontMetricsLike | null {
  if (
    typeof document === 'undefined' ||
    typeof TextMetrics?.measureFont !== 'function' ||
    typeof style.toFontString !== 'function'
  ) {
    return null
  }
  try {
    return TextMetrics.measureFont(style.toFontString())
  } catch {
    return null
  }
}

/**
 * 官方 `TalkWindow/Name`（`[230, 790, 593, 44]` @ 1920×1080）：
 * - 字体：CN 6.4.0 内置 `Source Han Sans SC Bold`（`SekaiCN-Bold`, weight 700）
 * - 字号：`44 * k`，字色 `#EBEBF2`，描边 `rgba(68, 68, 102, 0.6)` 圆角外扩
 * - 自动抵消 PixiJS v7 `strokeThickness/2` 与 `fontProperties.ascent` 偏移，使基线落在 `828.72 * k`
 */
export default class UISpeakerText extends Text {
  private readonly k: number
  private readonly frameX: number
  private readonly frameY: number
  private animGen = 0

  constructor(screen_width: number, screen_height: number, y?: number) {
    const k = Math.min(screen_width / SSE_UI_SPEC.refWidth, screen_height / SSE_UI_SPEC.refHeight)

    const style = new TextStyle({
      align: 'left',
      fill: NAME.fill,
      fontFamily: GAME_FONT_NAME_STACK,
      fontWeight: GAME_FONT_NAME_WEIGHT,
      fontSize: NAME.fontSize * k,
      lineHeight: sseLineAdvance(NAME.fontSize, NAME.lineSpacing) * k,
      stroke: NAME.outline,
      strokeThickness: sseOutlineThickness(NAME.fontSize) * k,
      lineJoin: 'round',
      padding: Math.ceil(6 * k),
      wordWrap: true,
      wordWrapWidth: NAME.width * k,
      breakWords: true
    })
    super('', style)

    this.k = k
    this.frameX = NAME.x * k
    this.frameY = y ?? NAME.y * k
    this.syncPosition()

    const alpha_filter = new AlphaFilter(0)
    alpha_filter.resolution = 2
    this.filters = [alpha_filter]
  }

  private syncPosition(): void {
    const pos = computePixiTextPosition({
      frameX: this.frameX,
      frameY: this.frameY,
      fontSizeRef: NAME.fontSize,
      k: this.k,
      strokeThickness: Number(this.style.strokeThickness ?? 0),
      lineHeight: Number(this.style.lineHeight ?? 0),
      fontMetrics: measureStyleFontMetrics(this.style)
    })
    this.x = pos.x
    this.y = pos.y
  }

  public async show(time: number): Promise<void> {
    const gen = ++this.animGen
    this.syncPosition()
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
}
