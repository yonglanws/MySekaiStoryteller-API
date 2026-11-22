import {
  BREATH_INFLUENCE,
  BREATH_VECTOR_DEGREES_PER_FRAME,
  DEG2RAD,
  EYEBLINK_CLOSED_SECONDS,
  EYEBLINK_CLOSING_SECONDS,
  EYEBLINK_MAX_DEVIATION_SECONDS,
  EYEBLINK_MEAN_SECONDS,
  EYEBLINK_OPENING_SECONDS
} from '../../../common/official/timing'

export type BlinkStatus = 'sleep' | 'ready' | 'closing' | 'closed' | 'opening'

export interface BlinkState {
  status: BlinkStatus
  /** 距离下一次自动眨眼的剩余秒数；首次唤醒后为 0，下一帧立刻开始。 */
  untilTime: number
  /** 当前相位的已用时间（秒）。 */
  phaseElapsed: number
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
 * 官方 `CubismAutoEyeBlinkInput`：新模型先 Sleep；身体动作开始时 Sleep，
 * 非循环动作结束后 Wake。`untilTime` 初值为 0，所以唤醒后的第一次眨眼立即开始。
 */
export function createBlinkState(seed: number): BlinkState {
  return {
    status: 'sleep',
    untilTime: 0,
    phaseElapsed: 0,
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
    state.phaseElapsed = 0
    state.opening = 1
  }
  // 眨眼途中被唤醒：这一眨走完后回到间隔计时，而不是回到 Sleep。
  state.doSleep = false
}

function phaseDuration(status: 'closing' | 'closed' | 'opening'): number {
  return status === 'closing'
    ? EYEBLINK_CLOSING_SECONDS
    : status === 'closed'
      ? EYEBLINK_CLOSED_SECONDS
      : EYEBLINK_OPENING_SECONDS
}

function phaseOpening(status: 'closing' | 'closed' | 'opening', elapsed: number): number {
  if (status === 'closing') {
    return Math.max(0, 1 - elapsed / EYEBLINK_CLOSING_SECONDS)
  }
  if (status === 'closed') return 0
  return Math.min(1, Math.max(0, elapsed / EYEBLINK_OPENING_SECONDS))
}

function scheduleNextBlink(state: BlinkState): void {
  state.untilTime =
    EYEBLINK_MEAN_SECONDS + (state.nextRandom() * 2 - 1) * EYEBLINK_MAX_DEVIATION_SECONDS
}

/**
 * 推进一帧，返回本帧的 EyeOpening（1 表示完全睁开）。
 *
 * 四段线性相位（闭眼/全闭/睁眼），一帧内跨过多个相位时把剩余时间带到下一相位，
 * 30fps 导出也能完整走完"闭—合—睁"，而不是被正弦曲线磨成一次抽搐。
 */
export function stepBlink(state: BlinkState, deltaSeconds: number): number {
  if (state.status === 'sleep') return state.opening
  const dt = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0
  let budget = dt

  if (state.status === 'ready') {
    const wait = Math.max(0, state.untilTime)
    if (budget < wait) {
      state.untilTime = wait - budget
      state.opening = 1
      return 1
    }
    budget -= wait
    state.untilTime = 0
    state.phaseElapsed = 0
    state.status = 'closing'
  }

  // 单帧最多跨 3 个相位（闭/合/睁）；防御异常大的 dt，剩余时间直接丢弃。
  let status = state.status as BlinkStatus
  for (let guard = 0; guard < 4; guard++) {
    if (status !== 'closing' && status !== 'closed' && status !== 'opening') break
    const phase = status
    const left = phaseDuration(phase) - state.phaseElapsed
    if (budget < left) {
      state.phaseElapsed += budget
      state.opening = phaseOpening(phase, state.phaseElapsed)
      state.lastValue = state.opening
      state.status = phase
      return state.opening
    }
    budget -= Math.max(0, left)
    state.phaseElapsed = 0
    if (phase === 'closing') {
      status = 'closed'
      state.opening = 0
    } else if (phase === 'closed') {
      status = 'opening'
      state.opening = 0
    } else {
      // 一眨结束：官方在睁眼完成后回到间隔计时；动作期间 Sleep。
      status = state.doSleep ? 'sleep' : 'ready'
      state.opening = 1
      state.lastValue = 1
      if (status === 'ready') scheduleNextBlink(state)
      state.status = status
      return 1
    }
    state.status = status
  }

  state.lastValue = state.opening
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
