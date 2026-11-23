import {
  BODY_MOTION_FADE_SECONDS,
  FACIAL_FADE_SECONDS,
  SAME_CATEGORY_BLEND_SECONDS
} from '../../../common/official/timing'

/**
 * 官方动作名规则（`ScenarioModel.IsLinkMotion` / `PlayableAnimator` 的 blend 选择）：
 * 类别是 `[a-z]-[alnum]+-[alnum]+` 的最长前缀；`_to_` 连接两个完整规则名是链接动作。
 * 例：`w-normal-nod05_f` 的类别是 `w-normal-nod05`；
 *     `w-a-b01_to_w-a-c02` 是链接动作。
 */
export function matchMotionRule(name: string): number | null {
  const match = /^[a-z]-[A-Za-z0-9]+-[A-Za-z0-9]+/.exec(name)
  return match ? match[0].length : null
}

export function motionCategory(name: string): string {
  const length = matchMotionRule(name)
  return length === null ? '' : name.slice(0, length)
}

export function isLinkMotion(name: string): boolean {
  const length = matchMotionRule(name)
  if (length === null) return false
  const rest = name.slice(length)
  if (!rest.startsWith('_to_')) return false
  const tail = rest.slice('_to_'.length)
  return matchMotionRule(tail) === tail.length
}

export interface BodyBlendOptions {
  /** `ChangeMotionForce(name, 0)`：混合时间 0，除非同类/链接规则更早命中。 */
  force?: boolean
  /** 该层还没有任何 clip（新模型 / 首次 Appear）。 */
  first?: boolean
  /** 新 clip 的 `FadeInTime`（model3 的 FileReferences.Motions 条目），缺省 0.5。 */
  clipFadeIn?: number
}

/**
 * 身体层混合时间。官方 `ScenarioModel.ChangeMotionCore` 的分支顺序：
 * `force && first` → 0；同类别或任一侧是链接动作 → 0.125s；`force` → 0；
 * 否则新 clip 的 `FadeInTime`（缺省 0.5s）。没有旧 clip 时无从混合，取 0。
 */
export function bodyBlendSeconds(
  current: string | null | undefined,
  next: string,
  options: BodyBlendOptions = {}
): number {
  if (!current) return 0
  const { force = false, first = false, clipFadeIn } = options
  if (force && first) return 0
  if (isLinkMotion(current) || isLinkMotion(next)) return SAME_CATEGORY_BLEND_SECONDS
  if (motionCategory(current) === motionCategory(next)) return SAME_CATEGORY_BLEND_SECONDS
  if (force) return 0
  return typeof clipFadeIn === 'number' && Number.isFinite(clipFadeIn)
    ? clipFadeIn
    : BODY_MOTION_FADE_SECONDS
}

/**
 * 表情层混合。官方 `ChangeFacialForce` → 0；普通 `ChangeFacial` 用 clip 的
 * `FadeInTime`，缺省 `live2d.facial_fade = 0.25s`。
 */
export function facialBlendSeconds(force = false, clipFadeIn?: number): number {
  if (force) return 0
  return typeof clipFadeIn === 'number' && Number.isFinite(clipFadeIn)
    ? clipFadeIn
    : FACIAL_FADE_SECONDS
}
