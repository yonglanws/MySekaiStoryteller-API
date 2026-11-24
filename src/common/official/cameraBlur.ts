/**
 * 官方 `BlurIn/BlurOut`：`fadeValue` 0→1 OutQuad；setter 写
 * `Spread = 3 * min(x / duration, 1)`（Out 为 `3 - ...`）。
 * 见 `sse-bake/src/lib.rs:2693-2707` 与 `:3190-3205`。
 * `cameraBlurRatio` 返回 0..1 的强度比例；`cameraBlurSpread` 返回参考像素单位 0..3。
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

/** `Spread = 3 × min(tweenValue / duration, 1)`（Out 为 `3 − …`），参考像素单位。 */
export const CAMERA_BLUR_MAX_SPREAD = 3

export function cameraBlurSpread(
  active: boolean,
  durationSeconds: number,
  tweenValue: number,
  maxSpread = CAMERA_BLUR_MAX_SPREAD
): number {
  return maxSpread * cameraBlurRatio(active, durationSeconds, tweenValue)
}

/**
 * `cameraBlurSpread` 的反函数：给定 spread 求 tweenValue。
 * 饱和段（spread=3）只能反演出首次到达 3 的 tweenValue。
 */
export function cameraBlurTweenValue(
  active: boolean,
  durationSeconds: number,
  spread: number,
  maxSpread = CAMERA_BLUR_MAX_SPREAD
): number {
  const ratio = maxSpread > 0 ? Math.max(0, Math.min(1, spread / maxSpread)) : 0
  const k = active ? ratio : 1 - ratio
  return k * Math.max(0, durationSeconds)
}
