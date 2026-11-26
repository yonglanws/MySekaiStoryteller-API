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
  private readonly alphaFilter = new AlphaFilter(0)

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
    this.filters = null
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

  private getCurrentOpacity(): number {
    if (!this.visible) return 0
    if (this.filters?.includes(this.alphaFilter)) {
      return Math.max(0, Math.min(1, this.alphaFilter.alpha))
    }
    return 1
  }

  private syncOpacity(alpha: number): void {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 0))
    this.alphaFilter.alpha = clamped
    if (clamped <= 0) {
      this.visible = false
      this.filters = null
    } else if (clamped >= 0.999) {
      this.visible = true
      this.filters = null
    } else {
      this.visible = true
      if (this.filters?.[0] !== this.alphaFilter) {
        this.filters = [this.alphaFilter]
      }
    }
  }

  public async show(time: number): Promise<void> {
    const gen = ++this.animGen
    this.syncPosition()
    if (time <= 0) {
      this.syncOpacity(1)
      return
    }
    const startAlpha = this.getCurrentOpacity()
    if (startAlpha < 0.999) {
      this.alphaFilter.alpha = startAlpha
      this.visible = true
      if (this.filters?.[0] !== this.alphaFilter) {
        this.filters = [this.alphaFilter]
      }
    } else {
      this.syncOpacity(1)
    }
    await AnimationManager.linear((progress) => {
      if (gen !== this.animGen) return
      this.syncOpacity(startAlpha + (1 - startAlpha) * progress)
    }, time)
    if (gen === this.animGen) this.syncOpacity(1)
  }

  public async hide(time: number): Promise<void> {
    const gen = ++this.animGen
    if (time <= 0) {
      this.syncOpacity(0)
      return
    }
    const from = this.getCurrentOpacity()
    if (from <= 0) {
      this.syncOpacity(0)
      return
    }
    await AnimationManager.linear((progress) => {
      if (gen !== this.animGen) return
      this.syncOpacity(from * (1 - progress))
    }, time)
    if (gen === this.animGen) {
      this.syncOpacity(0)
    }
  }
}
