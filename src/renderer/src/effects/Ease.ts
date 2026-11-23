import AnimationManager from '../managers/AnimationManager'
import { FRAME_MS } from '../../../common/official/timing'

/** DOTween 的 22 个 `Ease`（`sse-core/src/ease.rs:6-107`），不含 Expo。 */
export type EaseKind =
  | 'Linear'
  | 'InSine'
  | 'OutSine'
  | 'InOutSine'
  | 'InQuad'
  | 'OutQuad'
  | 'InOutQuad'
  | 'InCubic'
  | 'OutCubic'
  | 'InOutCubic'
  | 'InQuart'
  | 'OutQuart'
  | 'InOutQuart'
  | 'InQuint'
  | 'OutQuint'
  | 'InOutQuint'
  | 'InCirc'
  | 'OutCirc'
  | 'InOutCirc'
  | 'InBack'
  | 'OutBack'
  | 'InOutBack'

const EASE_KINDS: readonly EaseKind[] = [
  'Linear',
  'InSine',
  'OutSine',
  'InOutSine',
  'InQuad',
  'OutQuad',
  'InOutQuad',
  'InCubic',
  'OutCubic',
  'InOutCubic',
  'InQuart',
  'OutQuart',
  'InOutQuart',
  'InQuint',
  'OutQuint',
  'InOutQuint',
  'InCirc',
  'OutCirc',
  'InOutCirc',
  'InBack',
  'OutBack',
  'InOutBack'
]

const EASE_LOOKUP = new Map<string, EaseKind>(EASE_KINDS.map((kind) => [kind.toLowerCase(), kind]))

/**
 * `Enum.TryParse<Ease>(name, ignoreCase: true)`：只认 22 个名字，
 * 未知名字（含已删除的 Expo）返回 null，由调用方回落到 Linear。
 */
export function tryParseEase(name?: string): EaseKind | null {
  if (!name) return null
  return EASE_LOOKUP.get(name.trim().toLowerCase()) ?? null
}

/** 兼容旧调用：未知名字回落到 `fallback`（默认 OutQuad）。 */
export function parseEase(name?: string, fallback: EaseKind = 'OutQuad'): EaseKind {
  return tryParseEase(name) ?? fallback
}

const BACK_OVERSHOOT = 1.70158

function inOut(f: (x: number) => number, t: number): number {
  return t < 0.5 ? f(t * 2) * 0.5 : 1 - f((1 - t) * 2) * 0.5
}

/** DOTween 缓动函数实现，与 `sse-core/src/ease.rs` 数值对齐。 */
export function evaluateEase(ease: string | EaseKind | undefined, rawT: number): number {
  const t = Math.max(0, Math.min(1, rawT))
  const kind = tryParseEase(ease) ?? 'Linear'
  switch (kind) {
    case 'Linear':
      return t
    case 'InSine':
      return 1 - Math.cos((t * Math.PI) / 2)
    case 'OutSine':
      return Math.sin((t * Math.PI) / 2)
    case 'InOutSine':
      return -(Math.cos(Math.PI * t) - 1) / 2
    case 'InQuad':
      return t * t
    case 'OutQuad':
      return -t * (t - 2)
    case 'InOutQuad':
      return inOut((x) => x * x, t)
    case 'InCubic':
      return Math.pow(t, 3)
    case 'OutCubic':
      return Math.pow(t - 1, 3) + 1
    case 'InOutCubic':
      return inOut((x) => Math.pow(x, 3), t)
    case 'InQuart':
      return Math.pow(t, 4)
    case 'OutQuart':
      return -(Math.pow(t - 1, 4) - 1)
    case 'InOutQuart':
      return inOut((x) => Math.pow(x, 4), t)
    case 'InQuint':
      return Math.pow(t, 5)
    case 'OutQuint':
      return Math.pow(t - 1, 5) + 1
    case 'InOutQuint':
      return inOut((x) => Math.pow(x, 5), t)
    case 'InCirc':
      return -(Math.sqrt(Math.max(0, 1 - t * t)) - 1)
    case 'OutCirc':
      return Math.sqrt(Math.max(0, 1 - (t - 1) * (t - 1)))
    case 'InOutCirc':
      return inOut((x) => 1 - Math.sqrt(Math.max(0, 1 - x * x)), t)
    case 'InBack':
      return t * t * ((BACK_OVERSHOOT + 1) * t - BACK_OVERSHOOT)
    case 'OutBack': {
      const u = t - 1
      return u * u * ((BACK_OVERSHOOT + 1) * u + BACK_OVERSHOOT) + 1
    }
    case 'InOutBack': {
      const s = BACK_OVERSHOOT * 1.525
      return inOut((x) => x * x * ((s + 1) * x - s), t)
    }
  }
}

export interface FrameTween {
  from: number
  to: number
  /** 绝对开始帧。 */
  startFrame: number
  /** 帧长；0 表示立刻到位。 */
  frames: number
  ease?: string | EaseKind
}

/**
 * 官方 `Tween::at(frame)` 的纯函数版本（`sse-bake/src/lib.rs:624-638`）：
 * `frame <= start` 取 from，`frame >= start + frames` 取 to，中间按 ease 插值。
 */
export function evaluateFrameTween(tween: FrameTween, frame: number): number {
  if (tween.frames === 0 || frame >= tween.startFrame + tween.frames) return tween.to
  if (frame <= tween.startFrame) return tween.from
  const t = (frame - tween.startFrame) / tween.frames
  const eased = tween.ease === undefined ? t : evaluateEase(tween.ease, t)
  return tween.from + (tween.to - tween.from) * eased
}

/** 以虚拟毫秒求值的同一补间：帧号 = floor((now − startMs) / 16.667)。 */
export function evaluateTimeTween(
  tween: Omit<FrameTween, 'startFrame'> & { startMs: number },
  nowMs: number
): number {
  const elapsedFrames = Number.isFinite(nowMs) ? (nowMs - tween.startMs) / FRAME_MS : 0
  return evaluateFrameTween({ ...tween, startFrame: 0 }, elapsedFrames)
}

/** 0..1 的原始进度；同一时刻求值结果相同，不累积。 */
export function tweenProgressAt(startMs: number, frames: number, nowMs: number): number {
  if (!(frames > 0) || !Number.isFinite(nowMs)) return 1
  return Math.max(0, Math.min(1, (nowMs - startMs) / (frames * FRAME_MS)))
}

export async function runEasedTween(
  durationMs: number,
  ease: string | EaseKind | undefined,
  onProgress: (eased: number, raw: number) => void,
  isCancelled?: () => boolean
): Promise<void> {
  if (durationMs <= 0) {
    if (!isCancelled?.()) onProgress(1, 1)
    return
  }
  await AnimationManager.linear((raw) => {
    if (isCancelled?.()) return
    onProgress(evaluateEase(ease, raw), raw)
  }, durationMs)
  if (!isCancelled?.()) {
    onProgress(1, 1)
  }
}
