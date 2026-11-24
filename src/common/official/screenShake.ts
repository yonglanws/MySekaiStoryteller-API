/**
 * 官方 `DOShakePosition(duration, strength, vibrato, randomness, ignoreZ, fadeOut)` 的分段
 * 计时（`sse-bake/src/shake.rs:32-66`）：`n = max(2, trunc(vibrato * duration))`；
 * fadeOut 时每段原始时长 `(i+1)/n * duration`，再整体缩放到总时长 duration。
 */
export function shakeSegmentCount(durationSeconds: number, vibrato = 16): number {
  return Math.max(2, Math.trunc(vibrato * Math.max(0, durationSeconds)))
}

/** 参考 `ShakeScreen` / `ShakeWindow` 的固定 vibrato / randomness。 */
export const SHAKE_VIBRATO = 16
export const SHAKE_RANDOMNESS = 90

export interface ShakePlanOptions {
  durationSeconds: number
  strength: number
  /** `UnityEngine.Random` 的替代品；0..1。 */
  rng: () => number
  vibrato?: number
  randomness?: number
  ignoreZAxis?: boolean
  fadeOut?: boolean
}

export interface ShakePlan {
  durationSeconds: number
  strength: number
  vibrato: number
  randomness: number
  ignoreZAxis: boolean
  fadeOut: boolean
  segments: number
  /** 每段结束时间（秒，累计）。 */
  ends: number[]
  /** 每段结束时的偏移；最后一段为 [0,0]。 */
  offsets: Array<[number, number]>
}

export function shakeSegmentEnds(
  durationSeconds: number,
  fadeOut: boolean,
  vibrato = 16
): number[] {
  const n = shakeSegmentCount(durationSeconds, vibrato)
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

/**
 * 复刻 `sse-bake/src/shake.rs:39-99` 的 DOTween 分段：
 * 段末幅度减 `strength/n`、角度游走 `-180 ± randomness`、最后一段归零；
 * `ignoreZAxis=false` 时 x 再乘 `cos(±randomness)`（正交相机看不到的 z 分量）。
 */
export function buildShakePlan(options: ShakePlanOptions): ShakePlan {
  const duration = Math.max(0, options.durationSeconds)
  const strength = Math.max(0, options.strength)
  const vibrato = options.vibrato ?? SHAKE_VIBRATO
  const randomness = options.randomness ?? SHAKE_RANDOMNESS
  const ignoreZAxis = options.ignoreZAxis ?? false
  const fadeOut = options.fadeOut ?? true
  const rng = options.rng
  const segments = shakeSegmentCount(duration, vibrato)
  const decay = strength / segments
  let magnitude = strength
  let angle = rng() * 360
  const offsets: Array<[number, number]> = []
  for (let index = 0; index < segments; index++) {
    if (index + 1 < segments) {
      if (index > 0) angle = angle - 180 + (rng() * 2 - 1) * randomness
      const radians = (angle * Math.PI) / 180
      let x = magnitude * Math.cos(radians)
      const y = magnitude * Math.sin(radians)
      if (!ignoreZAxis) {
        const z = ((rng() * 2 - 1) * randomness * Math.PI) / 180
        x *= Math.cos(z)
      }
      offsets.push([x, y])
      if (fadeOut) magnitude -= decay
    } else {
      offsets.push([0, 0])
    }
  }
  return {
    durationSeconds: duration,
    strength,
    vibrato,
    randomness,
    ignoreZAxis,
    fadeOut,
    segments,
    ends: shakeSegmentEnds(duration, fadeOut, vibrato),
    offsets
  }
}

/** 绝对时间（秒）求值；二分查找分段，无限抖动 3600s 也不会每帧线性扫描。 */
export function shakeOffsetAt(plan: ShakePlan, seconds: number): [number, number] {
  const ends = plan.ends
  if (ends.length === 0 || seconds < 0 || seconds > plan.durationSeconds) return [0, 0]
  let low = 0
  let high = ends.length - 1
  while (low < high) {
    const mid = (low + high) >> 1
    if (ends[mid] >= seconds) high = mid
    else low = mid + 1
  }
  return shakeSegmentAt(ends, plan.offsets, low, seconds)
}

function shakeSegmentAt(
  ends: readonly number[],
  tos: readonly (readonly [number, number])[],
  index: number,
  t: number
): [number, number] {
  const start = index === 0 ? 0 : ends[index - 1]
  const len = ends[index] - start
  let p = len > 0 ? (t - start) / len : 1
  p = -p * (p - 2)
  const from = index === 0 ? ([0, 0] as const) : (tos[index - 1] ?? [0, 0])
  const to = tos[index] ?? [0, 0]
  return [from[0] + (to[0] - from[0]) * p, from[1] + (to[1] - from[1]) * p]
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
  return shakeSegmentAt(ends, tos, index, t)
}
