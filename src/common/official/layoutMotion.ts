/** 官方 `CharacterMoveTo` 的线性位置插值（参考 `sse-bake/src/lib.rs:2026-2041`）。 */
export type PositionPair = readonly [number, number]

export function interpolatePosition(
  from: PositionPair,
  to: PositionPair,
  progress: number
): [number, number] {
  const t = Math.max(0, Math.min(1, progress))
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]
}
