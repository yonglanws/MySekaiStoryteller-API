/** Apply a resolved Talk body duration in place for both record and fast exports. */
export function applyTalkPatch(
  timeline: Array<{
    snippetIndex: number
    delayStartTimeMs?: number
    startTimeMs: number
    durationMs: number
    endTimeMs: number
    ttsDurationMs: number
    hasTTS: boolean
    blocking?: boolean
  }>,
  index: number,
  ttsDurationMs: number,
  targetDurationMs: number
): number {
  const entry = timeline[index]
  if (!entry) return targetDurationMs

  const oldEnd = entry.endTimeMs
  const durationDelta = targetDurationMs - entry.durationMs
  const hasTTS = Number.isFinite(ttsDurationMs) && ttsDurationMs > 0
  entry.ttsDurationMs = hasTTS ? ttsDurationMs : 0
  entry.hasTTS = hasTTS
  entry.durationMs = targetDurationMs
  entry.endTimeMs = entry.startTimeMs + targetDurationMs

  // ProgressBehavior=0 entries immediately following this Talk run concurrently at its start;
  // only entries from the next pre-fence onward wait for this Talk (and any concurrent tasks) to settle.
  let firstFence = index + 1
  let concurrentMaxEnd = 0
  while (firstFence < timeline.length && timeline[firstFence].blocking === false) {
    concurrentMaxEnd = Math.max(concurrentMaxEnd, timeline[firstFence].endTimeMs)
    firstFence++
  }
  const shiftDelta =
    firstFence > index + 1
      ? Math.max(entry.endTimeMs, concurrentMaxEnd) - Math.max(oldEnd, concurrentMaxEnd)
      : durationDelta
  for (let j = firstFence; j < timeline.length; j++) {
    if (timeline[j].delayStartTimeMs !== undefined) timeline[j].delayStartTimeMs! += shiftDelta
    timeline[j].startTimeMs += shiftDelta
    timeline[j].endTimeMs += shiftDelta
  }
  return targetDurationMs
}
