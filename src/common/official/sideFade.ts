/**
 * 官方 `ScenarioSideFadePlayer`（EffectType 29~36）的硬边面板几何。
 *
 * `sse-bake/src/lib.rs:2842-2867`：from/to 是根节点 anchoredPosition（+y 向上），
 * 位移 = contentSize + 512；`sse-render/src/lib.rs:1288-1310`：根面板是
 * contentSize + 64 的纯黑矩形，画布左上角为 `(-32 + p.x, -32 - p.y)`。
 * In 类型在 Play 结束时 deactivate，Out 类型保留面板。
 */
export const SIDE_FADE_EDGE_PX = 512
export const SIDE_FADE_PANEL_PAD_PX = 32
/** `tex_transition_left/top` 的 UGUI tiled textureRect 从 128px 开始。 */
export const SIDE_FADE_TRIM_PX = 128

export type SideFadeEdge = 'left' | 'right' | 'top' | 'bottom'
export type SideFadeMode = 'in' | 'out'
export type SideFadeEffectType = 29 | 30 | 31 | 32 | 33 | 34 | 35 | 36

export interface SideFadeTableEntry {
  effectType: SideFadeEffectType
  edge: SideFadeEdge
  mode: SideFadeMode
  /** anchoredPosition from/to 的方向乘数，实际值再乘 ox / oy。 */
  from: readonly [number, number]
  to: readonly [number, number]
  /** In 类型在 Play 结束时 deactivate。 */
  hide: boolean
}

/** 29~36 的官方 from/to 表（`sse-bake/src/lib.rs:2846-2855`）。 */
const TABLE: readonly SideFadeTableEntry[] = [
  { effectType: 29, edge: 'left', mode: 'in', from: [0, 0], to: [1, 0], hide: true },
  { effectType: 30, edge: 'left', mode: 'out', from: [-1, 0], to: [0, 0], hide: false },
  { effectType: 31, edge: 'right', mode: 'in', from: [0, 0], to: [-1, 0], hide: true },
  { effectType: 32, edge: 'right', mode: 'out', from: [1, 0], to: [0, 0], hide: false },
  { effectType: 33, edge: 'top', mode: 'in', from: [0, 0], to: [0, -1], hide: true },
  { effectType: 34, edge: 'top', mode: 'out', from: [0, 1], to: [0, 0], hide: false },
  { effectType: 35, edge: 'bottom', mode: 'in', from: [0, 0], to: [0, 1], hide: true },
  { effectType: 36, edge: 'bottom', mode: 'out', from: [0, -1], to: [0, 0], hide: false }
]

export function sideFadeEffectType(edge: SideFadeEdge, mode: SideFadeMode): SideFadeEffectType {
  const entry = TABLE.find((item) => item.edge === edge && item.mode === mode)
  if (!entry) throw new Error(`Unknown SideFade ${edge} ${mode}`)
  return entry.effectType
}

export function sideFadeTableEntry(effectType: number): SideFadeTableEntry | null {
  return TABLE.find((item) => item.effectType === effectType) ?? null
}

export interface SideFadePlan {
  effectType: SideFadeEffectType
  edge: SideFadeEdge
  mode: SideFadeMode
  horizontal: boolean
  hide: boolean
  content: { width: number; height: number }
  unitScale: number
  pad: number
  panel: { width: number; height: number }
  /** anchoredPosition（+y 向上）。 */
  from: { x: number; y: number }
  to: { x: number; y: number }
}

/**
 * @param unitScale 参考画布像素 → 当前逻辑坐标的缩放；导出画布 1280×720 时为 2/3。
 */
export function sideFadePlan(
  edge: SideFadeEdge,
  mode: SideFadeMode,
  contentWidth: number,
  contentHeight: number,
  unitScale = 1
): SideFadePlan {
  const entry = TABLE.find((item) => item.edge === edge && item.mode === mode)
  if (!entry) throw new Error(`Unknown SideFade ${edge} ${mode}`)
  const scale = Number.isFinite(unitScale) && unitScale > 0 ? unitScale : 1
  const ox = contentWidth + SIDE_FADE_EDGE_PX * scale
  const oy = contentHeight + SIDE_FADE_EDGE_PX * scale
  const pad = SIDE_FADE_PANEL_PAD_PX * scale
  return {
    effectType: entry.effectType,
    edge,
    mode,
    horizontal: edge === 'left' || edge === 'right',
    hide: entry.hide,
    content: { width: contentWidth, height: contentHeight },
    unitScale: scale,
    pad,
    panel: { width: contentWidth + pad * 2, height: contentHeight + pad * 2 },
    from: { x: entry.from[0] * ox, y: entry.from[1] * oy },
    to: { x: entry.to[0] * ox, y: entry.to[1] * oy }
  }
}

export interface SideFadePanelRect {
  x: number
  y: number
  width: number
  height: number
  /** 已覆盖/已露出的前沿（canvas 像素；横向取 x，纵向取 y）。 */
  leading: number
}

/** 根面板在画布左上角坐标系里的矩形；`eased` 是 OutQuad 之后的 0..1。 */
export function sideFadePanelRect(plan: SideFadePlan, eased: number): SideFadePanelRect {
  const t = Math.max(0, Math.min(1, Number.isFinite(eased) ? eased : 0))
  const anchorX = plan.from.x + (plan.to.x - plan.from.x) * t
  const anchorY = plan.from.y + (plan.to.y - plan.from.y) * t
  // Pixi 的 y 向下；官方 anchoredPosition 的 +y 向上。
  const x = -plan.pad + anchorX
  const y = -plan.pad - anchorY
  let leading: number
  switch (plan.edge) {
    case 'left':
      leading = plan.mode === 'out' ? x + plan.panel.width : x
      break
    case 'right':
      leading = plan.mode === 'out' ? x : x + plan.panel.width
      break
    case 'top':
      leading = plan.mode === 'out' ? y + plan.panel.height : y
      break
    default:
      leading = plan.mode === 'out' ? y : y + plan.panel.height
  }
  return { x, y, width: plan.panel.width, height: plan.panel.height, leading }
}

export function sideFadeLeadingEdgeAt(plan: SideFadePlan, eased: number): number {
  return sideFadePanelRect(plan, eased).leading
}

/** 参考 `SideFadePlayer` 根面板外的一枚 512px `tex_transition_*` tile。 */
export interface SideFadeEdgeTile {
  side: 'top' | 'bottom' | 'left' | 'right'
  /** 相对根面板左上角的逻辑坐标。 */
  x: number
  y: number
  width: number
  height: number
  texture: 'top' | 'left'
  /** 纹理像素矩形（512×512 原图坐标）。 */
  frame: { x: number; y: number; width: number; height: number }
  flipX: boolean
  flipY: boolean
}

/**
 * `sse-render/src/lib.rs:1288-1342`：根面板四周各铺 512px tile。
 * 顶部/底部按 x 从左到右平铺（最后一块可窄），左侧/右侧按 Unity y 从根底部
 * 向上平铺（最后一块可矮）；UV 只取 textureRect 的 128..512。
 */
export function sideFadeEdgeTiles(plan: SideFadePlan): SideFadeEdgeTile[] {
  const scale = plan.unitScale
  const edge = SIDE_FADE_EDGE_PX * scale
  const trim = SIDE_FADE_TRIM_PX
  const width = plan.panel.width
  const height = plan.panel.height
  const tiles: SideFadeEdgeTile[] = []

  for (let offset = 0; offset < width; offset += edge) {
    const tileWidth = Math.min(edge, width - offset)
    const frameWidth = tileWidth / scale
    const frame = { x: 0, y: trim, width: frameWidth, height: SIDE_FADE_EDGE_PX - trim }
    tiles.push({
      side: 'top',
      x: offset,
      y: -edge,
      width: tileWidth,
      height: edge,
      texture: 'top',
      frame,
      flipX: false,
      flipY: false
    })
    tiles.push({
      side: 'bottom',
      x: offset,
      y: height,
      width: tileWidth,
      height: edge,
      texture: 'top',
      frame,
      flipX: false,
      flipY: true
    })
  }

  for (let offset = 0; offset < height; offset += edge) {
    const tileHeight = Math.min(edge, height - offset)
    const frameHeight = tileHeight / scale
    const frame = {
      x: trim,
      y: SIDE_FADE_EDGE_PX - frameHeight,
      width: SIDE_FADE_EDGE_PX - trim,
      height: frameHeight
    }
    const y = height - offset - tileHeight
    tiles.push({
      side: 'left',
      x: -edge,
      y,
      width: edge,
      height: tileHeight,
      texture: 'left',
      frame,
      flipX: false,
      flipY: false
    })
    tiles.push({
      side: 'right',
      x: width,
      y,
      width: edge,
      height: tileHeight,
      texture: 'left',
      frame,
      flipX: true,
      flipY: false
    })
  }

  return tiles
}

export interface SideFadePositions {
  horizontal: boolean
  start: number
  end: number
}

/** 兼容旧调用：只返回沿运动轴的 anchoredPosition 起点/终点。 */
export function sideFadePositions(
  edge: SideFadeEdge,
  mode: SideFadeMode,
  width: number,
  height: number,
  unitScale = 1
): SideFadePositions {
  const plan = sideFadePlan(edge, mode, width, height, unitScale)
  return {
    horizontal: plan.horizontal,
    start: plan.horizontal ? plan.from.x : plan.from.y,
    end: plan.horizontal ? plan.to.x : plan.to.y
  }
}
