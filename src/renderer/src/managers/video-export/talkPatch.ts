/** Apply a resolved Talk body duration in place for both record and fast exports. */
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
  targetDurationMs: number
): number {
  const entry = timeline[index]
  if (!entry) return targetDurationMs

  const durationDelta = targetDurationMs - entry.durationMs
  const hasTTS = Number.isFinite(ttsDurationMs) && ttsDurationMs > 0
  entry.ttsDurationMs = hasTTS ? ttsDurationMs : 0
  entry.hasTTS = hasTTS
  entry.durationMs = targetDurationMs
  entry.endTimeMs = entry.startTimeMs + targetDurationMs
  for (let j = index + 1; j < timeline.length; j++) {
    timeline[j].startTimeMs += durationDelta
    timeline[j].endTimeMs += durationDelta
  }
  return targetDurationMs
}
