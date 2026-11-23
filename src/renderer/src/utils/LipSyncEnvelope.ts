import {
  FRAME_MS,
  LIP_LEVELS,
  MOUTH_SYNC_FALLBACK_PRESET,
  TALK_DISPLAY_MS_PER_CHAR,
  lipTargetFromRms
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
  /**
   * 与 ournotes fallback 表（lipsync.js:28-30）对齐的数据字段：form 缩放与
   * base→default 归位比例。本 policy 不消费（fallback 源不写 ParamMouthForm），
   * 仅为 preset 数据逐位忠实。
   */
  readonly formScale?: number
  readonly baseToDefault?: number
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

/**
 * 音频结束后继续采样的释放段：让嘴在语音播完后自然合上，而不是硬切到 0。
 * 450ms 的出处：release=0.10 的指数尾在末帧残值 0.76×exp(-4.5)≈0.009（<1%），
 * 且 < AUTO_WAIT_AFTER_VOICE_MS=0.5s（语音后停留期内合完）。指数尾对应
 * ournotes 静音回填的离线等价（motionsync.js 无新样本超 silenceFallbackDelay
 * 后按 dt 补零样本；talk.js 注释 the mouth is not closed——无 120ms 线性收尾）。
 */
export const MOUTH_RELEASE_TAIL_MS = 450

/** 每句语音的响度归一目标：95 分位目标值抬到该开度，保证不同 TTS 音量下张嘴幅度一致。 */
export const MOUTH_LOUDNESS_TARGET = 0.78
/** 归一增益上限：极轻的语音最多放大 2.4 倍，避免把气声放大成夸张嘴型。 */
export const MOUTH_LOUDNESS_MAX_GAIN = 2.4

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
 * 口型包络构建：官方 `Live2DVoice` 的 RMS 曲线裸输出，直入逐位一致的
 * `AdvLipSyncPolicy`（ournotes fallback 预设），不再叠加 smoothLipValue
 * 三段权重平滑与 RMS 下限放宽——ournotes 两条实时路径（CRI Lips、MotionSync）
 * 的特征层都是裸值直入 policy，多出的低通层会把 4-8Hz 音节节奏滤平（发黏）。
 *
 * 逐步：① 每 16.67ms 窗 RMS；② `lipTargetFromRms(rms, 1, 1.75, 0)`
 * （a×(a+1)^1.75、阈值 0.06、上限 1，无下限放宽）；③ 无平滑直通；
 * ④ 响度归一（p95→0.78、增益 ≤2.4、只放大不衰减）——ournotes 输入层
 * （CRI net2 sigmoid、MotionSync viseme clamp）天生归一，此处是等效物；
 * ⑤ 逐帧 `stepMouthSync`；⑥ 音频结束后喂 0 继续 450ms 指数释放尾。
 *
 * 偏差说明：ournotes 有 per-model profile（openScale=1+0.08×口型参数数），
 * 本包络在导出解码时预计算、与模型解耦，且 MSST 模型典型只有
 * ParamMouthOpenY（n=0 → profile=1），故不引入；如需支持多口型参数模型，
 * 应在采样侧按模型缩放。
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
  for (let frame = 0; frame < frames; frame++) {
    const start = frame * windowSize
    const end = Math.min(start + windowSize, samples)
    let energy = 0
    for (const channel of channels) {
      for (let i = start; i < end; i++) energy += channel[i] * channel[i]
    }
    const rms = Math.sqrt(energy / Math.max(1, (end - start) * channels.length))
    // 官方曲线裸输出：无下限放宽（minValue=0）、无 smoothLipValue 低通。
    raw[frame] = lipTargetFromRms(rms, undefined, undefined, 0)
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
  // 释放尾与语音路径一致：MOUTH_RELEASE_TAIL_MS 的指数尾，按半字步长（33.3ms）换算帧数。
  const tail = Math.max(1, Math.ceil(MOUTH_RELEASE_TAIL_MS / stepMs))
  const values = new Float32Array(count + tail)
  const state = createMouthSyncState()
  for (let k = 0; k < values.length; k++) {
    // 结束前两个字归零（官方 talk window 收尾），指数尾巴负责平滑合上。
    const closing = k >= count - 2
    const target = closing ? 0 : LIP_LEVELS[(k * step + first) % LIP_LEVELS.length]
    values[k] = stepMouthSync(state, target, dt)
  }
  return values
}
