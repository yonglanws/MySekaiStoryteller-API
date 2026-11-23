/**
 * 官方 `DOShakePosition(duration, strength, vibrato, randomness, ignoreZ, fadeOut)` 的分段
 * 计时（`sse-bake/src/shake.rs:32-66`）：`n = max(2, trunc(vibrato * duration))`；
 * fadeOut 时每段原始时长 `(i+1)/n * duration`，再整体缩放到总时长 duration。
 */
export function shakeSegmentCount(durationSeconds: number, vibrato = 16): number {
  return Math.max(2, Math.trunc(vibrato * Math.max(0, durationSeconds)))
}

export function shakeSegmentEnds(durationSeconds: number, fadeOut: boolean): number[] {
  const n = shakeSegmentCount(durationSeconds)
  const raw = Array.from({ length: n }, (_, i) =>
    fadeOut ? ((i + 1) / n) * durationSeconds : durationSeconds / n
  )
  const sum = raw.reduce((a, b) => a + b, 0)
  let acc = 0
  return raw.map((d) => {
    acc += sum > 0 ? (d * durationSeconds) / sum : 0
    return acc
  })
}

/** 每个段末的偏移（最后一段归零）；随机路径由调用方 RNG 生成。 */
export function shakeSegmentOffset(
  ends: readonly number[],
  tos: readonly (readonly [number, number])[],
  t: number
): [number, number] {
  if (ends.length === 0 || t < 0 || t > ends[ends.length - 1]) return [0, 0]
  let index = ends.findIndex((e) => e >= t)
  if (index < 0) index = ends.length - 1
  const start = index === 0 ? 0 : ends[index - 1]
  const len = ends[index] - start
  let p = len > 0 ? (t - start) / len : 1
  p = -p * (p - 2)
  const from = index === 0 ? ([0, 0] as const) : tos[index - 1]
  const to = tos[index] ?? [0, 0]
  return [from[0] + (to[0] - from[0]) * p, from[1] + (to[1] - from[1]) * p]
}
