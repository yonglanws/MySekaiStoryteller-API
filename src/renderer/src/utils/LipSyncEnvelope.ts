import {
  FRAME_MS,
  LIP_LEVELS,
  LIP_RMS_MIN_VALUE,
  MOUTH_SYNC_FALLBACK_PRESET,
  TALK_DISPLAY_MS_PER_CHAR,
  lipTargetFromRms,
  smoothLipValue
} from '../../../common/official/timing'

export interface LipSyncEnvelope {
  values: Float32Array
  frameMs: number
  /** 可采样的总长度（音频长度 + 收尾释放段）。 */
  durationMs: number
  /** 语音本身长度；用于诊断。 */
  audioDurationMs: number
  /** 响度归一增益（只放大不衰减）。 */
  loudnessGain?: number
  /** 归一前的 95 分位目标值。 */
  loudnessP95?: number
}

/** 口型策略参数（`AdvLipSyncPolicy` 预设结构）。 */
export interface MouthSyncPreset {
  readonly attack: number
  readonly release: number
  readonly hold: number
  readonly hfs: number
  readonly speakingThr: number
  readonly silenceFloor: number
  readonly speechFloor: number
  readonly minSpeech: number
  readonly onset: number
  readonly openScale: number
  readonly comp: number
  readonly openCap: number
  readonly formOpenSupp: number
}

export interface MouthSyncState {
  /** 第一道（细节）平滑后的开度。 */
  filtered: number
  /** 最终输出（attack/release 后）的开度。 */
  presented: number
  /** 轻声保底剩余的 hold 秒数。 */
  hold: number
  speaking: boolean
}

/** 音频结束后继续采样的释放段：让嘴在语音播完后自然合上，而不是硬切到 0。 */
export const MOUTH_RELEASE_TAIL_MS = 300

/** 每句语音的响度归一目标：95 分位目标值抬到该开度，保证不同 TTS 音量下张嘴幅度一致。 */
export const MOUTH_LOUDNESS_TARGET = 0.78
/** 归一增益上限：极轻的语音最多放大 2.4 倍，避免把气声放大成夸张嘴型。 */
export const MOUTH_LOUDNESS_MAX_GAIN = 2.4

/**
 * 释放段末尾再叠一个 120ms 的线性收尾，保证最后一帧严格回到 0。
 * 只作用于 `start` 之后的尾巴，不碰语音本体。
 */
function fadeOutTail(values: Float32Array, start: number, frameMs: number): void {
  const total = values.length
  if (start >= total) return
  const rampFrames = Math.max(2, Math.min(total - start, Math.ceil(120 / frameMs)))
  const rampStart = total - rampFrames
  const denom = Math.max(1, total - 1 - rampStart)
  for (let i = rampStart; i < total; i++) {
    values[i] *= (total - 1 - i) / denom
  }
}

export function createMouthSyncState(): MouthSyncState {
  return { filtered: 0, presented: 0, hold: 0, speaking: false }
}

/**
 * 游戏 `AdvLipSyncPolicy`（Fallback 预设）的逐帧移植：
 *
 * 1. 开度乘 `openScale`、按 `comp` 压缩、限幅 `openCap`；
 * 2. 说话时给轻声一个 `speechFloor` / `minSpeech` 保底，避免每个音节都合上；
 * 3. 音节间隙 `hold` 秒内不闭合；完全静音才落到 `silenceFloor`；
 * 4. 细节平滑（上行加速）后再做 attack/release 指数平滑；
 * 5. 每次开口第一帧至少 `onset`，形成明确的"张嘴"起势。
 */
export function stepMouthSync(
  state: MouthSyncState,
  rawOpenY: number,
  deltaSeconds: number,
  preset: MouthSyncPreset = MOUTH_SYNC_FALLBACK_PRESET
): number {
  const dt = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0
  const raw = Number.isFinite(rawOpenY) ? Math.min(1, Math.max(0, rawOpenY)) : 0

  let t = Math.min(1, Math.max(0, raw * preset.openScale))
  if (preset.comp > 0) t = t / (preset.comp * t + 1)
  t = Math.min(t, preset.openCap)

  let wasOpen =
    state.hold > 0 || state.presented >= Math.max(preset.silenceFloor, preset.minSpeech * 0.5)
  const speaking = raw >= preset.speakingThr
  if (speaking) {
    state.hold = preset.hold
    if (t > 0 && t <= preset.speechFloor) t = preset.speechFloor
    if (t <= preset.minSpeech) t = preset.minSpeech
  } else {
    state.hold = Math.max(0, state.hold - dt)
    if (state.hold > 0) {
      wasOpen = true
      if (t > 0 && t <= preset.speechFloor) t = preset.speechFloor
    } else {
      if (t < preset.silenceFloor) t = 0
      wasOpen = true
    }
  }

  // 细节平滑：下行用 hfs，上行再快 35%。
  let tau = t <= state.filtered ? preset.hfs : preset.hfs * 0.65
  if (tau > 0) {
    t = state.filtered + (t - state.filtered) * Math.min(1, 1 - Math.exp(-dt / tau))
  }
  state.filtered = t

  // 最终输出：张嘴 attack、合嘴 release。
  tau = t <= state.presented ? preset.release : preset.attack
  if (tau > 0) {
    t = state.presented + (t - state.presented) * Math.min(1, 1 - Math.exp(-dt / tau))
  }
  state.presented = t

  let out = Math.min(1, Math.max(0, t))
  if (!wasOpen) {
    out = Math.max(out, preset.onset)
    state.filtered = Math.max(state.filtered, out)
    state.presented = Math.max(state.presented, out)
  }
  state.speaking = speaking
  return out
}

/**
 * 官方 `Live2DVoice.UpdateParam`：每帧取最近一帧音频的 RMS，
 * 经 `a×scale`、`a×pow(a+1,1.75)`、阈值 0.06、官方限幅（默认 0.2~1，RMS 路径
 * 用 `LIP_RMS_MIN_VALUE` 放宽下限），再用 `smooth(target, prev)` 按当前口型值
 * 选择权重平滑；最后再过一遍 `AdvLipSyncPolicy`（ournotes 的 Fallback 预设），
 * 并补 300ms 释放段。
 *
 * 官方曲线的输入是游戏混音后的语音，TTS 音量参差不齐时张嘴幅度会忽大忽小；
 * 这里按每句的 95 分位目标值做一次只放大不衰减的响度归一。
 */
export function buildLipSyncEnvelope(
  channels: readonly Float32Array[],
  sampleRate: number,
  frameMs = FRAME_MS
): LipSyncEnvelope {
  if (!channels.length || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return { values: new Float32Array(0), frameMs: FRAME_MS, durationMs: 0, audioDurationMs: 0 }
  }
  frameMs = Number.isFinite(frameMs) ? Math.max(5, frameMs) : FRAME_MS
  const samples = Math.min(...channels.map((channel) => channel.length))
  const windowSize = Math.max(1, Math.round((sampleRate * frameMs) / 1000))
  const frames = Math.ceil(samples / windowSize)
  const raw = new Float32Array(frames)
  let previous = 0
  for (let frame = 0; frame < frames; frame++) {
    const start = frame * windowSize
    const end = Math.min(start + windowSize, samples)
    let energy = 0
    for (const channel of channels) {
      for (let i = start; i < end; i++) energy += channel[i] * channel[i]
    }
    const rms = Math.sqrt(energy / Math.max(1, (end - start) * channels.length))
    previous = smoothLipValue(
      lipTargetFromRms(rms, undefined, undefined, LIP_RMS_MIN_VALUE),
      previous
    )
    raw[frame] = previous
  }

  // 响度归一：只在整体偏轻时放大，让不同音色的张嘴幅度稳定。
  const sorted = Array.from(raw).sort((a, b) => a - b)
  const p95 =
    sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0
  const gain =
    p95 > 1e-4 ? Math.min(MOUTH_LOUDNESS_MAX_GAIN, Math.max(1, MOUTH_LOUDNESS_TARGET / p95)) : 1
  if (gain > 1) {
    for (let i = 0; i < raw.length; i++) raw[i] = Math.min(1, raw[i] * gain)
  }

  const dt = frameMs / 1000
  const tailFrames = Math.max(1, Math.ceil(MOUTH_RELEASE_TAIL_MS / frameMs))
  const values = new Float32Array(frames + tailFrames)
  const state = createMouthSyncState()
  for (let frame = 0; frame < values.length; frame++) {
    values[frame] = stepMouthSync(state, frame < frames ? raw[frame] : 0, dt)
  }
  fadeOutTail(values, frames, frameMs)
  const audioDurationMs = (samples / sampleRate) * 1000
  return {
    values,
    frameMs,
    durationMs: audioDurationMs + tailFrames * frameMs,
    audioDurationMs,
    loudnessGain: gain,
    loudnessP95: p95
  }
}

export function sampleLipSync(envelope: LipSyncEnvelope, elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= envelope.durationMs) return 0
  const frame = elapsedMs / envelope.frameMs
  const index = Math.floor(frame)
  const current = envelope.values[index] ?? 0
  const next = envelope.values[index + 1] ?? 0
  return current + (next - current) * (frame - index)
}

/**
 * 无语音时的文本口型：`OnTalkWindowOnHalfLetter` 每半字推进一次，
 * 读取 `LipLevels[(k × step + first) % 38]`，再走同一套口型策略。
 * `slot` 是说话人在场上角色中的序号；未提供时按"所有角色"处理。
 */
export function textLipSequence(
  halfLetters: number,
  slot: { index: number; total: number } | null = null
): Float32Array {
  const count = Math.max(0, Math.floor(halfLetters))
  if (count === 0) return new Float32Array(0)
  const stepMs = TALK_DISPLAY_MS_PER_CHAR / 2
  const dt = stepMs / 1000
  const step = slot ? Math.max(1, slot.total) : 1
  const first = slot ? slot.index + 1 : 0
  const tail = Math.max(1, Math.ceil(MOUTH_RELEASE_TAIL_MS / stepMs))
  const values = new Float32Array(count + tail)
  const state = createMouthSyncState()
  for (let k = 0; k < values.length; k++) {
    // 结束前两个字归零（官方 talk window 收尾），策略与尾巴负责平滑合上。
    const closing = k >= count - 2
    const target = closing ? 0 : LIP_LEVELS[(k * step + first) % LIP_LEVELS.length]
    values[k] = stepMouthSync(state, target, dt)
  }
  fadeOutTail(values, count, stepMs)
  return values
}
