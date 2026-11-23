/**
 * 官方 `BlurIn/BlurOut`：`fadeValue` 0→1 OutQuad；setter 写
 * `Spread = 3 * min(x / duration, 1)`（Out 为 `3 - ...`）。
 * 见 `sse-bake/src/lib.rs:2693-2707` 与 `:3190-3205`。
 * 返回值是 0..1 的强度比例，由层乘以屏幕尺度。
 */
export function cameraBlurRatio(
  active: boolean,
  durationSeconds: number,
  progress: number
): number {
  const seconds = Math.max(0, durationSeconds)
  const k = seconds > 0 ? Math.min(Math.max(0, progress) / seconds, 1) : 1
  return active ? k : 1 - k
}
