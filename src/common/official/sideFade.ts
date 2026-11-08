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
  const outside = horizontal
    ? edge === 'left'
      ? -width
      : width
    : edge === 'top'
      ? -height
      : height
  const revealExit = horizontal
    ? edge === 'left'
      ? width
      : -width
    : edge === 'top'
      ? -height
      : height
  return {
    horizontal,
    start: mode === 'out' ? outside : 0,
    end: mode === 'out' ? 0 : revealExit
  }
}
