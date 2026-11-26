/**
 * Project SEKAI CN 客户端（6.4.0）内置游戏渲染字体加载与排版常量。
 *
 * 来源对照：`SekaiStoryExporter` (`ADR-0011`, `crates/sse-render/src/client.rs`,
 * `crates/sse-render/src/lib.rs`, `crates/sse-text/src/lib.rs`)：
 * - 正文 / Telop / PlaceInfo / FullScreenText：`fot-rodinntlgpro-db@Font.otf`
 *   （国服客户端为 `Source Han Sans SC Medium` v2.004，65535 字形，weight 500）
 * - 说话人姓名 / 选项按钮：`fot-rodinntlgpro-eb@Font.otf`
 *   （国服客户端为 `Source Han Sans SC Bold` v2.004，65535 字形，weight 700）
 */

export const GAME_FONT_BODY_FAMILY = 'SekaiCN-Medium'
export const GAME_FONT_NAME_FAMILY = 'SekaiCN-Bold'

export const GAME_FONT_BODY_WEIGHT = '500'
export const GAME_FONT_NAME_WEIGHT = '700'

export const GAME_FONT_BODY_STACK = `'${GAME_FONT_BODY_FAMILY}', 'Source Han Sans SC', sans-serif`
export const GAME_FONT_NAME_STACK = `'${GAME_FONT_NAME_FAMILY}', '${GAME_FONT_BODY_FAMILY}', 'Source Han Sans SC', sans-serif`

export interface GameFontSpec {
  readonly role: 'body' | 'name'
  readonly family: string
  readonly weight: string
  readonly style: 'normal'
  readonly format: 'opentype'
  readonly url: string
  readonly fileName: string
  readonly sha256: string
}

export const GAME_FONT_SPECS: readonly GameFontSpec[] = [
  {
    role: 'body',
    family: GAME_FONT_BODY_FAMILY,
    weight: GAME_FONT_BODY_WEIGHT,
    style: 'normal',
    format: 'opentype',
    url: 'fonts/SourceHanSansSC-Medium.otf',
    fileName: 'SourceHanSansSC-Medium.otf',
    sha256: 'c43383a8ac94024203f062537b5b3a0d0a5bf056172eff78673636ea8fb3c039'
  },
  {
    role: 'name',
    family: GAME_FONT_NAME_FAMILY,
    weight: GAME_FONT_NAME_WEIGHT,
    style: 'normal',
    format: 'opentype',
    url: 'fonts/SourceHanSansSC-Bold.otf',
    fileName: 'SourceHanSansSC-Bold.otf',
    sha256: '3baae4d7da5af78133c2db849814e1c0ca962e490f681714922cc499c6aeb355'
  }
] as const

/**
 * TextMeshPro / `sse-text` 排版参数（1920×1080 参考坐标）。
 */
export const SSE_TMP_FACE_INFO = {
  pointSize: 35,
  lineHeight: 70,
  ascent: 30.8,
  descent: -4.2,
  gradientScale: 6,
  outlineFaceDilate: 0.5,
  outlineWidth: 0.5,
  outlineSoftness: 0,
  weightBold: 0.75
} as const

/**
 * `sse-text::outline_reach()`：描边层超出字形边缘的图集像素半径（≈ 4.2105263）。
 */
export function sseOutlineReachAtlasPx(): number {
  const { gradientScale, outlineFaceDilate, outlineWidth, outlineSoftness, weightBold } =
    SSE_TMP_FACE_INFO
  const t = Math.max(1, weightBold / 4 + outlineFaceDilate + outlineWidth + outlineSoftness)
  const ratioA = (gradientScale - 1) / (gradientScale * t)
  return (((outlineFaceDilate + outlineWidth) * ratioA) / 2) * (2 * gradientScale)
}

/**
 * 将 `sse-text` 描边外扩半径换算为 Canvas 2D / PIXI `strokeThickness`（居中描边，外扩 = thickness / 2）。
 */
export function sseOutlineThickness(fontSizeRef: number): number {
  const outerRadius = sseOutlineReachAtlasPx() * (fontSizeRef / SSE_TMP_FACE_INFO.pointSize)
  return outerRadius * 2
}

/**
 * `sse-text::Style::line_advance`：`LINE_HEIGHT * (size / POINT_SIZE) + lineSpacing * size * 0.01`。
 * 对 `lineSpacing = -80` 得 `1.2 * size`（44pt → 52.8px）；对 `lineSpacing = -32` 得 `1.68 * size`（56pt → 94.08px）。
 */
export function sseLineAdvance(fontSizeRef: number, lineSpacing: number): number {
  const s = fontSizeRef / SSE_TMP_FACE_INFO.pointSize
  return SSE_TMP_FACE_INFO.lineHeight * s + lineSpacing * fontSizeRef * 0.01
}

/**
 * `SekaiStoryExporter` (`native_ui.rs` / `sse-render/src/lib.rs`) 参考分辨率 1920×1080 下的 UI 坐标与色彩。
 */
export const SSE_UI_SPEC = {
  refWidth: 1920,
  refHeight: 1080,
  window: { x: -440, y: 768, width: 2800, height: 312, colorHex: '#000022' },
  nameBar: { x: 210, y: 824, width: 720, height: 16, alpha: 0.6 },
  name: {
    x: 230,
    y: 790,
    width: 593,
    height: 44,
    fontSize: 44,
    lineSpacing: -80,
    fill: '#EBEBF2',
    outline: 'rgba(68, 68, 102, 0.6)'
  },
  words: {
    x: 250,
    y: 858,
    width: 1368.3,
    height: 154,
    fontSize: 44,
    minFontSize: 22,
    lineSpacing: -80,
    fill: '#FFFFFF',
    outline: 'rgba(68, 68, 102, 0.6)'
  },
  telop: {
    x: 440,
    y: 480,
    width: 1040,
    height: 120,
    leftRamp: 260,
    solid: 520,
    rightRamp: 260,
    pivotX: 0.02,
    bandColor: 'rgba(68, 68, 102, 0.8)',
    fontSize: 44,
    lineSpacing: -80,
    fill: '#FFFFFF'
  },
  placeInfo: {
    y: 31,
    solidWidth: 580,
    height: 64,
    leftRamp: 152,
    rightRamp: 152,
    bandColor: 'rgba(68, 68, 102, 0.8)',
    textX: 40,
    textY: 43,
    textWidth: 520,
    textHeight: 40,
    fontSize: 40,
    fill: '#FFFFFF'
  },
  fullScreenText: {
    baseAlpha: 0.5,
    cinemascopeHeight: 240,
    textX: 280,
    textRightInset: 0,
    fontSize: 56,
    lineSpacing: -32,
    fill: '#FFFFFF',
    underlayColor: '#000000',
    /** `6.0 * 0.6770833 / 35.0` em downward offset (`SDF_Base_Scenario_Full`) */
    underlayOffsetEm: (6.0 * 0.6770833) / 35.0
  },
  choice: {
    windowOffsetY: 40,
    buttonPosY: -40,
    twoChoiceOffsetX: 460,
    buttonWidth: 520,
    buttonHeight: 96,
    glowOutset: 4,
    textInset: 24,
    fontSize: 32,
    minFontSize: 16,
    textColor: '#444466',
    pressedTextColor: '#FFFFFF',
    glowColorHex: 0xa1f4eb
  }
} as const

export interface EnsureGameFontsOptions {
  /** 单次字体加载超时（毫秒），默认 15000ms */
  timeoutMs?: number
  /** 为 true 时任一游戏字体未成功加载即抛错，避免静默回退到系统字体 */
  strict?: boolean
}

export interface LoadedGameFonts {
  loaded: string[]
  skipped: boolean
}

const WARMUP_SAMPLE = '世界计划测试标点，。！？「」……あいうアイウABC0123'

let cachedLoadPromise: Promise<LoadedGameFonts> | null = null

function resolveFontUrl(relativeUrl: string): string {
  const base =
    typeof document !== 'undefined' && document.baseURI
      ? document.baseURI
      : typeof location !== 'undefined' && location.href
        ? location.href
        : 'http://localhost/'
  try {
    return new URL(relativeUrl, base).href
  } catch {
    return relativeUrl.startsWith('/') ? relativeUrl : `/${relativeUrl}`
  }
}

function normalizeFamilyName(family: string): string {
  return family.trim().replace(/^['"]+|['"]+$/g, '')
}

function findLoadedFontFace(spec: GameFontSpec): FontFace | undefined {
  if (typeof document === 'undefined' || !document.fonts) return undefined
  for (const face of document.fonts) {
    if (
      normalizeFamilyName(face.family) === spec.family &&
      String(face.weight) === spec.weight &&
      face.status === 'loaded'
    ) {
      return face
    }
  }
  return undefined
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) return promise
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms while loading ${label}`))
        }, timeoutMs)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function warmUpCanvasFontCache(): void {
  if (typeof document === 'undefined') return
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    for (const spec of GAME_FONT_SPECS) {
      ctx.font = `${spec.weight} 44px "${spec.family}"`
      ctx.measureText(WARMUP_SAMPLE)
      ctx.fillText('测', 0, 44)
    }
  } catch {
    // non-DOM or headless mock without 2D context
  }
}

async function loadAllGameFonts(options: EnsureGameFontsOptions): Promise<LoadedGameFonts> {
  if (typeof document === 'undefined' || !('fonts' in document) || !document.fonts) {
    return { loaded: [], skipped: true }
  }

  const timeoutMs = options.timeoutMs ?? 15_000
  const strict = options.strict ?? true
  const loaded: string[] = []

  await Promise.all(
    GAME_FONT_SPECS.map(async (spec) => {
      if (!findLoadedFontFace(spec) && typeof FontFace !== 'undefined') {
        const resolvedUrl = resolveFontUrl(spec.url)
        const face = new FontFace(spec.family, `url("${resolvedUrl}") format("${spec.format}")`, {
          weight: spec.weight,
          style: spec.style,
          display: 'block'
        })
        const loadedFace = await withTimeout(
          face.load(),
          timeoutMs,
          `game font ${spec.family} (${resolvedUrl})`
        )
        document.fonts.add(loadedFace)
      }

      const fontShorthand = `${spec.weight} 44px "${spec.family}"`
      await withTimeout(
        document.fonts.load(fontShorthand, WARMUP_SAMPLE),
        timeoutMs,
        `document.fonts.load(${fontShorthand})`
      )
      loaded.push(spec.family)
    })
  )

  await withTimeout(document.fonts.ready, timeoutMs, 'document.fonts.ready')

  if (strict) {
    for (const spec of GAME_FONT_SPECS) {
      const fontShorthand = `${spec.weight} 44px "${spec.family}"`
      const ok =
        typeof document.fonts.check === 'function'
          ? document.fonts.check(fontShorthand, '测试')
          : Boolean(findLoadedFontFace(spec))
      if (!ok) {
        throw new Error(
          `Bundled game Chinese font "${spec.family}" (${spec.fileName}) did not report loaded in document.fonts`
        )
      }
    }
  }

  warmUpCanvasFontCache()
  return { loaded, skipped: false }
}

/**
 * 确定性预加载内置的 CN 6.4.0 游戏渲染字体（`SekaiCN-Medium` + `SekaiCN-Bold`），
 * 并在返回前完成 `document.fonts.ready` 与 Canvas 字形缓存预热，防止首帧回退系统字体。
 */
export function ensureGameFontsLoaded(
  options: EnsureGameFontsOptions = {}
): Promise<LoadedGameFonts> {
  if (!cachedLoadPromise) {
    cachedLoadPromise = loadAllGameFonts(options).catch((error) => {
      cachedLoadPromise = null
      throw error
    })
  }
  return cachedLoadPromise
}

/** 仅供单元测试重置缓存状态 */
export function resetGameFontLoaderCache(): void {
  cachedLoadPromise = null
}
