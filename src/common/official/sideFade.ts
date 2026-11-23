/**
 * ScenarioSideFadePlayer 的滑入/滑出位置（SSE `sse-bake` 29~36）。
 * 面板本身覆盖全屏；这里只返回它沿轴的起点/终点。
 */
export interface SideFadePositions {
  horizontal: boolean
  start: number
  end: number
}

export function sideFadePositions(
  edge: 'left' | 'right' | 'top' | 'bottom',
  mode: 'in' | 'out',
  width: number,
  height: number
): SideFadePositions {
  const horizontal = edge === 'left' || edge === 'right'
  // out：从该侧画外滑到 0（覆盖）；in：从 0 滑向该侧画外（露出）。
  // 官方 ScenarioSideFadePlayer 的位移 = contentSize + 512（`sse-bake/src/lib.rs:2842-2865`）。
  const ox = width + 512
  const oy = height + 512
  const outside = horizontal ? (edge === 'left' ? -ox : ox) : edge === 'top' ? -oy : oy
  const revealExit = horizontal ? (edge === 'left' ? ox : -ox) : edge === 'top' ? -oy : oy
  return {
    horizontal,
    start: mode === 'out' ? outside : 0,
    end: mode === 'out' ? 0 : revealExit
  }
}
