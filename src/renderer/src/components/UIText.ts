import { AlphaFilter, Text, TextMetrics, TextStyle } from 'pixi.js'
import AnimationManager from '../managers/AnimationManager'
import {
  GAME_FONT_BODY_FAMILY,
  GAME_FONT_BODY_STACK,
  GAME_FONT_BODY_WEIGHT,
  SSE_UI_SPEC,
  computePixiTextPosition,
  sseLineAdvance,
  sseOutlineThickness,
  type PixiFontMetricsLike
} from '../utils/FontLoader'
import { TALK_DISPLAY_MS_PER_CHAR, sliceVisibleText, visibleTextLength } from '../utils/TalkTiming'

const WORDS = SSE_UI_SPEC.words

let measureCtx: CanvasRenderingContext2D | null | undefined

function getMeasureContext(): CanvasRenderingContext2D | null {
  if (measureCtx !== undefined) return measureCtx
  if (typeof document === 'undefined') {
    measureCtx = null
    return null
  }
  try {
    measureCtx = document.createElement('canvas').getContext('2d')
  } catch {
    measureCtx = null
  }
  return measureCtx
}

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

function estimateCharWidthRef(char: string, fontSizeRef: number): number {
  const code = char.codePointAt(0) ?? 0
  if (code <= 0x007f) return fontSizeRef * 0.55
  return fontSizeRef
}

function measureWrappedLines(text: string, fontSizeRef: number, maxWidthRef: number): number {
  if (!text) return 1
  const ctx = getMeasureContext()
  if (ctx) {
    ctx.font = `${GAME_FONT_BODY_WEIGHT} ${fontSizeRef}px "${GAME_FONT_BODY_FAMILY}", sans-serif`
  }
  let lines = 1
  let lineWidth = 0
  for (const ch of Array.from(text)) {
    if (ch === '\r') continue
    if (ch === '\n') {
      lines++
      lineWidth = 0
      continue
    }
    const adv = ctx ? ctx.measureText(ch).width : estimateCharWidthRef(ch, fontSizeRef)
    if (lineWidth > 0 && lineWidth + adv > maxWidthRef) {
      lines++
      lineWidth = adv
    } else {
      lineWidth += adv
    }
  }
  return lines
}

/**
 * 对齐 `SekaiStoryExporter` (`sse-text/src/lib.rs` & `sse-render/src/lib.rs`)：
 * `Words` 在 `[minFontSize=22, fontSize=44]` 内以 1pt 步进自动缩字，确保多行文本不超出 `154px` 对话框高度。
 */
export function computeTalkBodyFontSizeRef(text: string): number {
  let size: number = WORDS.fontSize
  while (size > WORDS.minFontSize) {
    const lines = measureWrappedLines(text, size, WORDS.width)
    const blockH = size + (lines - 1) * sseLineAdvance(size, WORDS.lineSpacing)
    if (blockH <= WORDS.height) break
    size -= 1
  }
  return size
}

/**
 * 官方 `TalkWindow/Words`（`[250, 858, 1368.3, 154]` @ 1920×1080）：
 * - 字体：CN 6.4.0 内置 `Source Han Sans SC Medium`（`SekaiCN-Medium`, weight 500）
 * - 字号：`44 * k`（支持 `[22, 44]` 自动缩字），行距 `52.8 * k`（TMP `lineSpacing = -80`）
 * - 描边：`rgba(68, 68, 102, 0.6)` 圆角外扩（`SDF_Base_Scenario_Outline`）
 * - 自动抵消 PixiJS v7 `strokeThickness/2` 与 `fontProperties.ascent` 偏移，使首行基线落在 `896.72 * k`
 */
export default class UIText extends Text {
  private readonly k: number
  private readonly frameX: number
  private readonly frameY: number
  private currentFontSizeRef: number = WORDS.fontSize
  private _data: string = ''
  private animGen = 0

  constructor(screen_width: number, screen_height: number) {
    const k = Math.min(screen_width / SSE_UI_SPEC.refWidth, screen_height / SSE_UI_SPEC.refHeight)

    const style = new TextStyle({
      align: 'left',
      fill: WORDS.fill,
      fontFamily: GAME_FONT_BODY_STACK,
      fontWeight: GAME_FONT_BODY_WEIGHT,
      fontSize: WORDS.fontSize * k,
      lineHeight: sseLineAdvance(WORDS.fontSize, WORDS.lineSpacing) * k,
      stroke: WORDS.outline,
      strokeThickness: sseOutlineThickness(WORDS.fontSize) * k,
      lineJoin: 'round',
      padding: Math.ceil(6 * k),
      wordWrap: true,
      wordWrapWidth: WORDS.width * k,
      breakWords: true
    })
    super('', style)

    this.k = k
    this.frameX = WORDS.x * k
    this.frameY = WORDS.y * k
    this.syncPosition(WORDS.fontSize)

    const alpha_filter = new AlphaFilter(0)
    alpha_filter.resolution = 2
    this.filters = [alpha_filter]
  }

  public get data(): string {
    return this._data
  }

  public set data(value: string) {
    this._data = value
    this.applyAutoSize(value)
  }

  private syncPosition(fontSizeRef: number): void {
    const pos = computePixiTextPosition({
      frameX: this.frameX,
      frameY: this.frameY,
      fontSizeRef,
      k: this.k,
      strokeThickness: Number(this.style.strokeThickness ?? 0),
      lineHeight: Number(this.style.lineHeight ?? 0),
      fontMetrics: measureStyleFontMetrics(this.style)
    })
    this.x = pos.x
    this.y = pos.y
  }

  private applyAutoSize(fullText: string): void {
    const sizeRef = computeTalkBodyFontSizeRef(fullText)
    this.currentFontSizeRef = sizeRef
    this.style.fontSize = sizeRef * this.k
    this.style.lineHeight = sseLineAdvance(sizeRef, WORDS.lineSpacing) * this.k
    this.style.strokeThickness = sseOutlineThickness(sizeRef) * this.k
    this.syncPosition(sizeRef)
  }

  public async show(time: number): Promise<void> {
    const gen = ++this.animGen
    this.syncPosition(this.currentFontSizeRef)
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
    this.applyAutoSize(this.data)
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
