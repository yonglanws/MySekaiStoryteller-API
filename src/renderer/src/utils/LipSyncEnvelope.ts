import {
  FRAME_MS,
  LIP_LEVELS,
  lipTargetFromRms,
  smoothLipValue
} from '../../../common/official/timing'

export interface LipSyncEnvelope {
  values: Float32Array
  frameMs: number
  durationMs: number
}

/**
 * 官方 `Live2DVoice.UpdateParam`：每帧取最近一帧音频的 RMS，
 * 经 `a×scale`、`a×pow(a+1,1.75)`、阈值 0.06、限幅 0.2~1，再用
 * `smooth(target, prev)` 按当前口型值选择权重平滑。
 */
export function buildLipSyncEnvelope(
  channels: readonly Float32Array[],
  sampleRate: number,
  frameMs = FRAME_MS
): LipSyncEnvelope {
  if (!channels.length || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return { values: new Float32Array(0), frameMs: FRAME_MS, durationMs: 0 }
  }
  frameMs = Number.isFinite(frameMs) ? Math.max(5, frameMs) : FRAME_MS
  const samples = Math.min(...channels.map((channel) => channel.length))
  const windowSize = Math.max(1, Math.round((sampleRate * frameMs) / 1000))
  const values = new Float32Array(Math.ceil(samples / windowSize))
  let previous = 0
  for (let frame = 0; frame < values.length; frame++) {
    const start = frame * windowSize
    const end = Math.min(start + windowSize, samples)
    let energy = 0
    for (const channel of channels) {
      for (let i = start; i < end; i++) energy += channel[i] * channel[i]
    }
    const rms = Math.sqrt(energy / Math.max(1, (end - start) * channels.length))
    const target = lipTargetFromRms(rms)
    previous = smoothLipValue(target, previous)
    values[frame] = previous
  }
  return { values, frameMs, durationMs: (samples / sampleRate) * 1000 }
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
 * 读取 `LipLevels[(k × step + first) % 38]`，然后同样做官方平滑。
 * `slot` 是说话人在场上角色中的序号；未提供时按“所有角色”处理。
 */
export function textLipSequence(
  halfLetters: number,
  slot: { index: number; total: number } | null = null
): Float32Array {
  const count = Math.max(0, Math.floor(halfLetters))
  const values = new Float32Array(count)
  const step = slot ? Math.max(1, slot.total) : 1
  const first = slot ? slot.index + 1 : 0
  let previous = 0
  for (let k = 0; k < count; k++) {
    const target = LIP_LEVELS[(k * step + first) % LIP_LEVELS.length]
    previous = smoothLipValue(target, previous)
    values[k] = previous
  }
  return values
}
