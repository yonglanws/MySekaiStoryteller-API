import {
  BREATH_INFLUENCE,
  BREATH_VECTOR_DEGREES_PER_FRAME,
  DEG2RAD,
  EYEBLINK_MAX_DEVIATION_SECONDS,
  EYEBLINK_MEAN_SECONDS,
  EYEBLINK_SPEED
} from '../../../common/official/timing'

/**
 * 官方 `Live2DEyeBlinkController.Status`。
 *
 * 自动眨眼只有 Ready（间隔计时）、Closing（|sin| 下降沿）、Opening（|sin| 上升沿）
 * 三个相位；Sleep 只是把自动眨眼停住，不关掉控制器。
 */
export type BlinkStatus = 'sleep' | 'ready' | 'closing' | 'opening'

/** `Live2DEyeBlinkController.PlayMode`：Auto 自动眨眼，Command 由动作事件驱动。 */
export type BlinkMode = 'auto' | 'command'

/** `PlayStatus`；一旦播过命令就不会再回到 None。 */
export type BlinkPlayStatus = 'none' | 'playing' | 'finish'

/** `PlayCommand(closing, closed, opening)` 的 DOTween 序列。 */
export interface BlinkCommand {
  closing: number
  closed: number
  opening: number
  /** 序列位置；null 表示 DOTween 的 OnStart 还没跑（事件帧本身）。 */
  elapsed: number | null
  /** closing 段起始值，OnStart 时取当时的 EyeOpening。 */
  from: number
  /** 事件与 tick 落在同一帧时先跳过一帧：命令从下一帧才开始推进。 */
  deferred: boolean
}

export interface BlinkState {
  status: BlinkStatus
  mode: BlinkMode
  playStatus: BlinkPlayStatus
  command: BlinkCommand | null
  /** 距离下一次自动眨眼的剩余秒数；首次唤醒后为 0，下一帧立刻开始。 */
  untilTime: number
  /** |sin| 的相位（弧度），从 -π/2 起每帧 += speed×dt。 */
  blinkRadian: number
  lastValue: number
  /** Auto 模式写出的开合（1 = 完全睁开，0 = 完全闭合）。 */
  opening: number
  /** `eyeValue`：Auto 与 Command 共用，命令模式直接写它。 */
  eyeValue: number
  /** `doSleep`：当前这眨结束后停住自动眨眼。 */
  doSleep: boolean
  nextRandom: () => number
}

/**
 * 每模型自然动作种子。
 *
 * 官方 `Baker::character_seed` 把共享 RNG 的一次 `Range(0,360)` 抽取与角色 id 混合成
 * per-character seed（`sse-bake/src/lib.rs:1388`）。MSST 没有 Unity 的共享随机流，
 * 改用 id 的 Knuth 乘法散列：同一 id 每次导出得到同一序列，不同 id 彼此独立，
 * 眨眼间隔与呼吸初相位都从这个种子派生。
 */
export function naturalMotionSeed(modelId: number): number {
  return Math.imul(modelId, 2654435761) >>> 0
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
 * 官方 `Live2DModel.BuildModelComponent`：控制器建好后立即 `Sleep()`，
 * 新模型不会眨眼；`untilTime` 初值 0，所以第一次唤醒后的下一帧就开眨。
 */
export function createBlinkState(seed = 1): BlinkState {
  const state: BlinkState = {
    status: 'ready',
    mode: 'auto',
    playStatus: 'none',
    command: null,
    untilTime: 0,
    blinkRadian: 0,
    lastValue: 0,
    opening: 1,
    eyeValue: 0,
    doSleep: false,
    nextRandom: createSeededRandom(seed)
  }
  sleepBlink(state)
  return state
}

/** `Sleep()`：停住自动眨眼；已在进行的这一眨会走完再停。 */
export function sleepBlink(state: BlinkState): void {
  if (state.status === 'ready') state.status = 'sleep'
  state.doSleep = true
}

/**
 * `WakeUp()`：只有 Sleep 状态会清 `doSleep`（飞行中的这一眨仍然在结束时停住），
 * 模式总是回到 Auto；`untilTime` 不重置。
 */
export function wakeBlink(state: BlinkState): void {
  if (state.status === 'sleep') {
    state.status = 'ready'
    state.doSleep = false
  }
  state.mode = 'auto'
}

/** `ScenarioModel.ChangeMotionCore` 的结尾：任何身体动作切换都 `Sleep()`。 */
export function bodyMotionChangedBlink(state: BlinkState): void {
  sleepBlink(state)
}

/** `ScenarioModel.OnFinishMotion`：只有非循环身体 clip 越过结尾才 `WakeUp()`。 */
export function bodyMotionFinishedBlink(state: BlinkState, looping: boolean): void {
  if (!looping) wakeBlink(state)
}

/**
 * `ChangeMotionCore` 请求了模型没有的动作：`OnFinishMotion` 先按当前 clip 是否
 * 非循环决定唤醒，随后照常 `Sleep()`；当前 clip 早已报过结束，所以之后不会
 * 再有唤醒，眨眼永久停住。
 */
export function missingBodyMotionBlink(state: BlinkState, currentLooping: boolean): void {
  if (!currentLooping) wakeBlink(state)
  sleepBlink(state)
}

/** `PlayCommand(closingTime, closedTime, openingTime)`；序列播放中忽略新命令。 */
export function playBlinkCommand(
  state: BlinkState,
  closing: number,
  closed: number,
  opening: number
): void {
  if (state.playStatus === 'playing') return
  state.mode = 'command'
  state.playStatus = 'playing'
  state.command = { closing, closed, opening, elapsed: null, from: 0, deferred: true }
}

/**
 * `OnLive2DInvokeUserData`（例如 `eyeblink,0.2,0.79,0.24`）。
 * 少于 4 段时官方在 `PlayCommand` 之前就报错返回；参数按 `float.TryParse`，
 * 解析失败写 0。
 */
export function invokeBlinkUserData(state: BlinkState, data: string): void {
  const parts = String(data).split(',')
  if (parts.length < 4) return
  const arg = (text: string): number => {
    const value = Number.parseFloat(text.trim())
    return Number.isFinite(value) ? value : 0
  }
  playBlinkCommand(state, arg(parts[1]), arg(parts[2]), arg(parts[3]))
}

/** DOTween 的 Update tick：命令序列无论当前模式都会推进。 */
function tickBlinkCommand(state: BlinkState, delta: number): void {
  const command = state.command
  if (!command) return
  if (command.deferred) {
    // 事件在动作求值时触发，LateUpdate 的 tick 已过；参考里命令从下一帧才 OnStart。
    command.deferred = false
    return
  }
  // 官方序列时间是 f32；用 fround 累加，0.2s 的 closing 段在第 12 步正好落到 0。
  const step = Math.fround(delta)
  let elapsed: number
  if (command.elapsed === null) {
    // OnStart：eyeValue = EyeOpening，closing 段从它开始。
    state.eyeValue = state.opening
    command.from = state.eyeValue
    elapsed = step
  } else {
    elapsed = Math.fround(command.elapsed + step)
  }
  command.elapsed = elapsed
  const held = command.closing + command.closed
  if (elapsed < command.closing) {
    state.eyeValue = command.from + (elapsed / command.closing) * (0 - command.from)
  } else if (elapsed < held) {
    state.eyeValue = 0
  } else if (elapsed < held + command.opening) {
    state.eyeValue = (elapsed - held) / command.opening
  } else {
    // 睁眼段在终点完成，然后 OnComplete。
    state.command = null
    state.playStatus = 'finish'
    state.eyeValue = 1
  }
}

/**
 * `PlayAutoMode`：Ready 状态下 `untilTime` 递减，越过 0 后从 -π/2 起走一段
 * `π / speed` 秒的 |sin| 眨眼，并在同一帧推进；|sin| 回到上升沿时停下，
 * 重抽 `3 + Random.Range(-2, 2)` 的间隔。
 */
function autoMode(state: BlinkState, delta: number): void {
  if (state.status === 'sleep') return
  if (state.status === 'ready') {
    state.untilTime -= delta
    // 官方 `if (untilTime >= 0) return`，NaN 也在这里返回。
    if (state.untilTime >= 0 || Number.isNaN(state.untilTime)) return
    state.blinkRadian = -Math.PI / 2
    state.lastValue = 1
    state.status = 'closing'
  }
  state.blinkRadian += delta * EYEBLINK_SPEED
  state.eyeValue = Math.abs(Math.sin(state.blinkRadian))
  if (state.status === 'opening' && state.eyeValue < state.lastValue) {
    state.status = state.doSleep ? 'sleep' : 'ready'
    state.eyeValue = 1
    state.untilTime =
      EYEBLINK_MEAN_SECONDS + (state.nextRandom() * 2 - 1) * EYEBLINK_MAX_DEVIATION_SECONDS
  } else if (state.status === 'closing' && state.eyeValue > state.lastValue) {
    state.status = 'opening'
  }
  state.opening = state.eyeValue
  state.lastValue = state.eyeValue
}

/** `LateUpdate`：Auto 模式跑自动眨眼，Command 模式把 eyeValue 写到开合上。 */
function lateUpdateBlink(state: BlinkState, delta: number): void {
  if (state.mode === 'command') {
    if (state.playStatus === 'finish') state.mode = 'auto'
    state.opening = state.eyeValue
    state.lastValue = state.eyeValue
    return
  }
  autoMode(state, delta)
}

/**
 * 一帧：tick 命令序列（全局 DOTween，非 active 也推进），再在 active 时让当前模式
 * 写 EyeOpening，返回本帧开合（1 = 完全睁开）。
 *
 * 自动眨眼是 |sin| 控制器而不是四段线性相位：一眨 19 步小于 1、第 20 步强制
 * 回到 1.0，30fps 抽取时按步号奇偶得到 0.0707 或 0.0957 两个谷值。
 */
export function stepBlink(state: BlinkState, deltaSeconds: number, active = true): number {
  const delta = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0
  tickBlinkCommand(state, delta)
  if (active) {
    lateUpdateBlink(state, delta)
  }
  return state.opening
}

/** `BuildModelComponent`: `breathDegree = Random.Range(0, 360)`（int 重载）。 */
export function createBreathDegree(seed: number): number {
  return Math.floor(createSeededRandom(seed ^ 0x6272656174)() * 360)
}

/**
 * `Live2DModel.LateUpdate`：`d = breathDegree + breathVector × deltaK`，
 * 越过一整圈只减一次 360。deltaK 按 60fps 帧数，story 的 60fps 下即帧差。
 */
export function advanceBreathDegree(degree: number, deltaSeconds: number): number {
  const deltaK = Math.max(0, deltaSeconds) * 60
  const next = degree + deltaK * BREATH_VECTOR_DEGREES_PER_FRAME
  // 官方 `if (!(d < 360f)) d += -360f`：只减一次，也没有下界。
  return next >= 360 ? next - 360 : next
}

/** LateUpdate 写入 ParamBreath 的值。 */
export function breathParameterValue(degree: number): number {
  return (Math.sin(degree * DEG2RAD) * 0.5 + 0.5) * BREATH_INFLUENCE
}
