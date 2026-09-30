export const TALK_DISPLAY_MS_PER_CHAR = 80
export const TALK_ESTIMATED_SPEECH_MS_PER_CHAR = 143
export const TALK_TAIL_MS = 600
export const MIN_TALK_DURATION_MS = 1800

/** Dialogue body only; BaseSnippet owns the separate pre-dialogue delay. */
export function calculateTalkDurationMs(content: string, ttsDurationMs = 0, ttsText = ''): number {
  // Keep UTF-16 string.length in sync with UIText's typewriter animation.
  const displayMs = content.length * TALK_DISPLAY_MS_PER_CHAR
  const speechMs =
    Number.isFinite(ttsDurationMs) && ttsDurationMs > 0
      ? ttsDurationMs
      : (ttsText || content).length * TALK_ESTIMATED_SPEECH_MS_PER_CHAR
  return Math.max(MIN_TALK_DURATION_MS, Math.max(displayMs, speechMs) + TALK_TAIL_MS)
}
