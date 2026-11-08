import {
  BODY_MOTION_FADE_SECONDS,
  FACIAL_FADE_SECONDS,
  SAME_CATEGORY_BLEND_SECONDS
} from '../../../common/official/timing'

/**
 * 官方动作名规则（ScenarioModel.IsLinkMotion / PlayableAnimator 的 blend 选择）：
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

/**
 * 身体层混合时间。官方 `ChangeMotionCore`：
 * 同类别或任一侧是链接动作 -> 0.125s；否则 0.5s；没有旧 clip -> 0。
 */
export function bodyBlendSeconds(current: string | null | undefined, next: string): number {
  if (!current) return 0
  if (isLinkMotion(current) || isLinkMotion(next)) return SAME_CATEGORY_BLEND_SECONDS
  if (motionCategory(current) === motionCategory(next)) return SAME_CATEGORY_BLEND_SECONDS
  return BODY_MOTION_FADE_SECONDS
}

/** 表情层混合：普通 0.25s，Force（入场/换装）0s。 */
export function facialBlendSeconds(force = false): number {
  return force ? 0 : FACIAL_FADE_SECONDS
}
