import {
  BREATH_INFLUENCE,
  BREATH_VECTOR_DEGREES_PER_FRAME,
  DEG2RAD,
  EYEBLINK_MAX_DEVIATION_SECONDS,
  EYEBLINK_MEAN_SECONDS,
  EYEBLINK_SPEED
} from '../../../common/official/timing'

export type BlinkStatus = 'sleep' | 'ready' | 'closing' | 'opening'

export interface BlinkState {
  status: BlinkStatus
  /** 距离下一次自动眨眼的剩余秒数；首次唤醒后为 0，下一帧立刻开始。 */
  untilTime: number
  radian: number
  lastValue: number
  /** 1 = 完全睁开，0 = 完全闭合。 */
  opening: number
  doSleep: boolean
  nextRandom: () => number
}

/** 确定性 RNG（mulberry32）：同一模型 id 的眨眼间隔在每次导出中一致。 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 官方 `Live2DEyeBlinkController`：新模型先 Sleep；身体动作开始时 Sleep，
 * 非循环动作结束后 Wake。`untilTime` 初值为 0，所以唤醒后的第一次眨眼立即开始。
 */
export function createBlinkState(seed: number): BlinkState {
  return {
    status: 'sleep',
    untilTime: 0,
    radian: 0,
    lastValue: 1,
    opening: 1,
    doSleep: true,
    nextRandom: createSeededRandom(seed)
  }
}

export function sleepBlink(state: BlinkState): void {
  if (state.status === 'ready') state.status = 'sleep'
  state.doSleep = true
}

export function wakeBlink(state: BlinkState): void {
  if (state.status === 'sleep') {
    state.status = 'ready'
    state.doSleep = false
  }
}

/** 推进一帧，返回本帧的 EyeOpening（1 表示完全睁开）。 */
export function stepBlink(state: BlinkState, deltaSeconds: number): number {
  if (state.status === 'sleep') {
    return state.opening
  }
  const dt = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0
  if (state.status === 'ready') {
    state.untilTime -= dt
    if (state.untilTime >= 0) return state.opening
    state.radian = -Math.PI / 2
    state.lastValue = 1
    state.status = 'closing'
  }
  state.radian += dt * EYEBLINK_SPEED
  const eye = Math.abs(Math.sin(state.radian))
  if (state.status === 'opening' && eye < state.lastValue) {
    state.status = state.doSleep ? 'sleep' : 'ready'
    state.opening = 1
    state.untilTime =
      EYEBLINK_MEAN_SECONDS + (state.nextRandom() * 2 - 1) * EYEBLINK_MAX_DEVIATION_SECONDS
    return state.opening
  }
  if (state.status === 'closing' && eye > state.lastValue) state.status = 'opening'
  state.opening = eye
  state.lastValue = eye
  return state.opening
}

/** `Live2DModel.Update`: breathDegree += deltaK × breathVector；这里 deltaK 按 60fps 帧数。 */
export function advanceBreathDegree(degree: number, deltaSeconds: number): number {
  const frames = Math.max(0, deltaSeconds) * 60
  return degree + frames * BREATH_VECTOR_DEGREES_PER_FRAME
}

/** LateUpdate 写入 ParamBreath 的值。 */
export function breathParameterValue(degree: number): number {
  return (Math.sin(degree * DEG2RAD) * 0.5 + 0.5) * BREATH_INFLUENCE
}
