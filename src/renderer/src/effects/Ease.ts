import AnimationManager from '../managers/AnimationManager'

export type EaseKind =
  | 'Linear'
  | 'InQuad'
  | 'OutQuad'
  | 'InOutQuad'
  | 'InCubic'
  | 'OutCubic'
  | 'InOutCubic'
  | 'InQuart'
  | 'OutQuart'
  | 'InOutQuart'
  | 'InSine'
  | 'OutSine'
  | 'InOutSine'
  | 'InExpo'
  | 'OutExpo'
  | 'InOutExpo'

const EASE_ALIASES: Record<string, EaseKind> = {
  linear: 'Linear',
  inquad: 'InQuad',
  easeinquad: 'InQuad',
  outquad: 'OutQuad',
  easeoutquad: 'OutQuad',
  inoutquad: 'InOutQuad',
  easeinoutquad: 'InOutQuad',
  incubic: 'InCubic',
  easeincubic: 'InCubic',
  outcubic: 'OutCubic',
  easeoutcubic: 'OutCubic',
  inoutcubic: 'InOutCubic',
  easeinoutcubic: 'InOutCubic',
  inquart: 'InQuart',
  easeinquart: 'InQuart',
  outquart: 'OutQuart',
  easeoutquart: 'OutQuart',
  inoutquart: 'InOutQuart',
  easeinoutquart: 'InOutQuart',
  insine: 'InSine',
  easeinsine: 'InSine',
  outsine: 'OutSine',
  easeoutsine: 'OutSine',
  inoutsine: 'InOutSine',
  easeinoutsine: 'InOutSine',
  inexpo: 'InExpo',
  easeinexpo: 'InExpo',
  outexpo: 'OutExpo',
  easeoutexpo: 'OutExpo',
  inoutexpo: 'InOutExpo',
  easeinoutexpo: 'InOutExpo'
}

export function parseEase(name?: string, fallback: EaseKind = 'OutQuad'): EaseKind {
  if (!name) return fallback
  const key = name.trim().toLowerCase().replace(/[\s_-]+/g, '')
  return EASE_ALIASES[key] ?? fallback
}

/** DOTween 缓动函数实现，与 `sse-core/src/ease.rs` 数值对齐。 */
export function evaluateEase(ease: string | EaseKind | undefined, rawT: number): number {
  const t = Math.max(0, Math.min(1, rawT))
  const kind = parseEase(ease, 'Linear')
  switch (kind) {
    case 'Linear':
      return t
    case 'InQuad':
      return t * t
    case 'OutQuad':
      return t * (2 - t)
    case 'InOutQuad':
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
    case 'InCubic':
      return t * t * t
    case 'OutCubic':
      return 1 - Math.pow(1 - t, 3)
    case 'InOutCubic':
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
    case 'InQuart':
      return t * t * t * t
    case 'OutQuart':
      return 1 - Math.pow(1 - t, 4)
    case 'InOutQuart':
      return t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2
    case 'InSine':
      return 1 - Math.cos((t * Math.PI) / 2)
    case 'OutSine':
      return Math.sin((t * Math.PI) / 2)
    case 'InOutSine':
      return -(Math.cos(Math.PI * t) - 1) / 2
    case 'InExpo':
      return t === 0 ? 0 : Math.pow(2, 10 * t - 10)
    case 'OutExpo':
      return t === 1 ? 1 : 1 - Math.pow(2, -10 * t)
    case 'InOutExpo':
      if (t === 0 || t === 1) return t
      return t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2
  }
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
