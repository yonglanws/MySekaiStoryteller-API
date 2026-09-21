/**
 * Talk 片段时长补丁（fast 导出路径使用）：
 * duration = max(原估算, tts 时长 + 尾垫)，并把后续所有片段整体后移。
 * 返回新的 duration（未变化时与原值相同）。
 */
export function applyTalkPatch(
  timeline: Array<{
    snippetIndex: number
    startTimeMs: number
    durationMs: number
    endTimeMs: number
    ttsDurationMs: number
    hasTTS: boolean
  }>,
  index: number,
  ttsDurationMs: number,
  fallbackMs?: number
): number {
  const entry = timeline[index]
  if (!entry) return 0
  const target =
    ttsDurationMs > 0
      ? Math.max(entry.durationMs, ttsDurationMs + TALK_TAIL_SILENCE_MS)
      : fallbackMs && fallbackMs > entry.durationMs
        ? fallbackMs
        : entry.durationMs
  if (target <= entry.durationMs) return entry.durationMs

  const durationDelta = target - entry.durationMs
  timeline[index] = {
    ...entry,
    ttsDurationMs: ttsDurationMs > 0 ? ttsDurationMs : entry.ttsDurationMs,
    hasTTS: ttsDurationMs > 0 ? true : entry.hasTTS,
    durationMs: target,
    endTimeMs: entry.startTimeMs + target
  }
  for (let j = index + 1; j < timeline.length; j++) {
    timeline[j] = {
      ...timeline[j],
      startTimeMs: timeline[j].startTimeMs + durationDelta,
      endTimeMs: timeline[j].endTimeMs + durationDelta
    }
  }
  return target
}

/** 台词音频结束后的静音尾垫：保证相邻对话之间有呼吸间隔（与 fast 路径一致） */
const TALK_TAIL_SILENCE_MS = 600

