import {
  FRAME_MS,
  LIP_LEVELS,
  LIP_POW_K,
  LIP_TARGET_VALUE_SCALE,
  WORD_INTERVAL_FRAMES,
  WORD_INTERVAL_HALF_FRAMES,
  lipCoefficients,
  lipTargetFromRms,
  smoothLipValue
} from '../../../common/official/timing'

/**
 * 口型（ADR-0007）：`sse-bake/src/lipsync.rs` 的 `Lip::Voice` / `Lip::Text` 整段移植。
 *
 * 两条链都按剧情 60Hz 步进：每一步取一个目标值，再用官方的三档 `smooth()`
 * （0.6/0.4、0.2/0.8、0.25/0.75）向前一步。没有 AdvLipSyncPolicy、没有响度归一、
 * 没有音节正弦、没有半字线性插值：语音目标来自「结束于当前步的最后一帧样本」的
 * RMS，文本目标来自 `LipLevels[(k·step+first) % 38]`，一个半字 = 2 个相同目标的
 * 60Hz 步。
 *
 * 平滑到 <0.001（且样本已放完 / 文本已进入收尾）后官方把 `Lip` 换成 `None`，
 * 之后不再写嘴——对应这里的 `releaseStep` 与 `AdvancedModel.releaseMouth()`。
 */

/** 口型步长：剧情 60fps，一步 16.667ms。 */
export const LIP_STEP_MS = FRAME_MS

export interface LipSyncEnvelope {
  /** 每个 60Hz 剧情步的开度。 */
  values: Float32Array
  frameMs: number
  /** values.length × frameMs；越界采样返回 0。 */
  durationMs: number
  /** 语音本身长度（毫秒）；用于诊断。 */
  audioDurationMs: number
  /** 平滑到 <0.001 的步号：此后官方 Lip::None 脱手，不再写参数。 */
  releaseStep: number
  targetValueScale: number
  powK: number
}

export interface LipSyncEnvelopeOptions {
  /**
   * 官方 `TargetValueScale`：一次 talk 把说话人的系数重设为
   * `(tvs, tvs × 1.75)`。模型初值见 `AdvancedModel.getLipSyncScale()`。
   */
  targetValueScale?: number
}

function emptyEnvelope(tvs = LIP_TARGET_VALUE_SCALE): LipSyncEnvelope {
  return {
    values: new Float32Array(0),
    frameMs: FRAME_MS,
    durationMs: 0,
    audioDurationMs: 0,
    releaseStep: -1,
    targetValueScale: tvs,
    powK: tvs * LIP_POW_K
  }
}

/**
 * 语音包络：`Lip::Voice::value(frame)` 的逐步移植。
 *
 * - `end = (frame / 60) × rate` 取整，`len = rate / 60` 取整，
 *   窗口是 `[end − len, end)`——即结束于当前步时刻的最后一帧样本
 *   （48k 下 800 个）。样本放完后窗口为空，RMS 记 0，平滑继续衰减。
 * - `a = rms × tvs`，`target = a × (a+1)^powK`；`target < 0.06` 记 0，
 *   否则 clamp 到 0.2~1。
 * - 每一步 `value = smooth(target, prev)`，`prev` 与结果一起写回。
 * - 样本放完且 `value < 0.001`：官方返回 0.0 并换成 `Lip::None`（脱手）。
 */
export function buildLipSyncEnvelope(
  channels: readonly Float32Array[],
  sampleRate: number,
  options: LipSyncEnvelopeOptions = {}
): LipSyncEnvelope {
  const { targetValueScale: tvs, powK } = lipCoefficients(
    options.targetValueScale ?? LIP_TARGET_VALUE_SCALE
  )
  if (!channels.length || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return emptyEnvelope(tvs)
  }
  const samples = Math.min(...channels.map((channel) => channel.length))
  if (!Number.isFinite(samples) || samples <= 0) {
    return emptyEnvelope(tvs)
  }
  const audioDurationMs = (samples / sampleRate) * 1000
  const stepSamples = Math.floor(sampleRate / 60)
  const maxSteps = Math.ceil(samples / Math.max(1, stepSamples)) + 64
  const values = new Float32Array(maxSteps)
  let prev = 0
  let count = 0
  let releaseStep = -1
  for (let step = 0; step < maxSteps; step++) {
    const end = Math.floor((step / 60) * sampleRate)
    const begin = Math.max(0, end - stepSamples)
    let rms = 0
    if (begin < samples && end > begin) {
      const stop = Math.min(end, samples)
      let energy = 0
      for (let i = begin; i < stop; i++) {
        let mixed = 0
        for (const channel of channels) mixed += channel[i]
        mixed /= channels.length
        energy += mixed * mixed
      }
      rms = Math.sqrt(energy / Math.max(1, stop - begin))
    }
    const target = lipTargetFromRms(rms, tvs, powK)
    let value = smoothLipValue(target, prev)
    prev = value
    if (begin >= samples && value < 0.001) {
      // 官方在脱手这一帧仍返回 Some(0.0)。
      value = 0
      values[step] = value
      count = step + 1
      releaseStep = step
      break
    }
    values[step] = value
    count = step + 1
  }
  return {
    values: values.subarray(0, count),
    frameMs: FRAME_MS,
    durationMs: count * FRAME_MS,
    audioDurationMs,
    releaseStep,
    targetValueScale: tvs,
    powK
  }
}

/**
 * 按剧情步采样：`floor(elapsed / 16.667)`，不做插值。
 * 越界（含 durationMs）返回 0。
 */
export function sampleLipSync(envelope: LipSyncEnvelope, elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 0
  const step = Math.floor(elapsedMs / envelope.frameMs + 1e-9)
  return envelope.values[step] ?? 0
}

// ---- text lip --------------------------------------------------------------------------

/**
 * `Lip::Text`：`OnTalkWindowOnHalfLetter` 每半字推进一次 `lipLevelIndex`，
 * 读取 `LipLevels[(k × step + first) % 38]`；`step` 是说话人数、`first` 是
 * `slot + 1`（全员 talk 时 step=1、first=0）。
 */
export interface TextLipState {
  /** 每 talk 说话人数（`TalkCharacters` 的 count）。 */
  step: number
  /** 第一个读取的 LipLevels 下标（`slot + 1`）。 */
  first: number
  framesPerHalf: number
  framesPerChar: number
  prev: number
  released: boolean
}

export interface TextLipSlot {
  index: number
  total: number
}

export function createTextLipState(
  slot: TextLipSlot | null = null,
  framesPerHalf = WORD_INTERVAL_HALF_FRAMES,
  framesPerChar = WORD_INTERVAL_FRAMES
): TextLipState {
  const step = slot ? Math.max(1, slot.total) : 1
  const first = slot ? slot.index + 1 : 0
  return { step, first, framesPerHalf, framesPerChar, prev: 0, released: false }
}

/** 收尾帧（相对 typing_start）：`typing_end − 一个整字`，不早于 typing_start。 */
export function textLipCloseFrame(halfLetters: number, state: TextLipState): number {
  return Math.max(halfLetters * state.framesPerHalf - state.framesPerChar, 0)
}

/**
 * 目标值：`frame` 相对 typing_start；收尾后（或点击提前结束时）归零，
 * 其余按半字索引读 `LipLevels`。
 */
export function textLipTargetAt(
  state: TextLipState,
  frame: number,
  halfLetters: number,
  endFrame?: number
): number {
  const closed =
    (endFrame !== undefined && frame >= endFrame) || frame >= textLipCloseFrame(halfLetters, state)
  if (closed) return 0
  const k = Math.floor(frame / Math.max(1, state.framesPerHalf))
  return LIP_LEVELS[(k * state.step + state.first) % LIP_LEVELS.length]
}

/** 走一步 `smooth()`；脱手后恒 0。`frame` 相对 typing_start。 */
export function stepTextLipAt(
  state: TextLipState,
  frame: number,
  halfLetters: number,
  endFrame?: number
): number {
  if (state.released) return 0
  const target = textLipTargetAt(state, frame, halfLetters, endFrame)
  const value = smoothLipValue(target, state.prev)
  state.prev = value
  const closed =
    (endFrame !== undefined && frame >= endFrame) || frame >= textLipCloseFrame(halfLetters, state)
  if (closed && value < 0.001) {
    state.released = true
    return 0
  }
  return value
}

export interface TextLipSequence {
  values: Float32Array
  /** 每一步的目标值；收尾后为 0。 */
  targets: Float32Array
  frameMs: number
  /** 平滑到 <0.001 的步号（相对 typing_start）：此后脱手。 */
  releaseStep: number
}

/**
 * 一次性生成一条文本口型（测试与导出前预计算用）：从 typing_start 起每 60Hz
 * 步一个值，`typing_end − 一个整字` 处开始归零，平滑到 <0.001 后脱手。
 */
export function textLipSequence(
  halfLetters: number,
  slot: TextLipSlot | null = null,
  options: { endStep?: number } = {}
): TextLipSequence {
  const count = Math.max(0, Math.floor(halfLetters))
  const state = createTextLipState(slot)
  if (count === 0) {
    return {
      values: new Float32Array(0),
      targets: new Float32Array(0),
      frameMs: FRAME_MS,
      releaseStep: -1
    }
  }
  const closes = textLipCloseFrame(count, state)
  const limit = Math.max(options.endStep ?? closes, closes) + 64
  const values = new Float32Array(limit)
  const targets = new Float32Array(limit)
  let length = 0
  let releaseStep = -1
  for (let frame = 0; frame < limit; frame++) {
    targets[frame] = textLipTargetAt(state, frame, count, options.endStep)
    values[frame] = stepTextLipAt(state, frame, count, options.endStep)
    length = frame + 1
    if (state.released) {
      releaseStep = frame
      break
    }
  }
  return {
    values: values.subarray(0, length),
    targets: targets.subarray(0, length),
    frameMs: FRAME_MS,
    releaseStep
  }
}
