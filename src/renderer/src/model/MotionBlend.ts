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

/**
 * 官方 `CP.PlayableAnimator` / `PlayableBlender` 单层混合状态
 * （移植自 `SekaiStoryExporter/crates/sse-live2d/src/motion.rs:80-258`）。
 *
 * 与 Cubism SDK `CubismMotionQueueManager` 的差异：
 * 1. 权重严格按线性 `t = clamp01(blendElapsed / blendTime)` 过渡，而不是 `getEasingSine`；
 * 2. 所有活跃输入权重之和恒为 1.0，且旧 clip 中有而新 clip 中没有的参数向默认值线性归位，
 *    不再产生交叉淡化中点向默认姿态下陷 25% 或旧参数永久残留的问题。
 */
export interface PlayableBlendInput<T> {
  key: T
  from: number
  to: number
  weight: number
}

export interface PlayableBlendLayer<T> {
  inputs: PlayableBlendInput<T>[]
  blendElapsed: number
  blendTime: number
}

export function createPlayableBlendLayer<T>(): PlayableBlendLayer<T> {
  return {
    inputs: [],
    blendElapsed: 0,
    blendTime: 0
  }
}

export function clearPlayableBlendLayer<T>(layer: PlayableBlendLayer<T>): void {
  layer.inputs.length = 0
  layer.blendElapsed = 0
  layer.blendTime = 0
}

/**
 * `PlayableAnimator.ChangeAnimation(layer, clip, blend, rewind: true)` 的权重规划：
 * - `blend <= 0` 或层内无旧输入时清空旧输入，新输入直接权重 1；
 * - 否则将所有已有输入的 `from = weight, to = 0`，追加新输入 `from = 0, to = 1`。
 */
export function changePlayableBlendLayer<T>(
  layer: PlayableBlendLayer<T>,
  key: T,
  blendSeconds: number
): T[] {
  const blend = Number.isFinite(blendSeconds) && blendSeconds > 0 ? blendSeconds : 0
  if (blend <= 0 || layer.inputs.length === 0) {
    const removed = layer.inputs.map((input) => input.key)
    layer.inputs = [{ key, from: 1, to: 1, weight: 1 }]
    layer.blendTime = 0
    layer.blendElapsed = 0
    return removed
  }
  for (const input of layer.inputs) {
    input.from = input.weight
    input.to = 0
  }
  layer.inputs.push({ key, from: 0, to: 1, weight: 0 })
  layer.blendTime = blend
  layer.blendElapsed = 0
  return []
}

/**
 * 按 `deltaSeconds` 推进线性混合权重，返回权重归零并被移除的旧输入 key。
 */
export function advancePlayableBlendLayer<T>(
  layer: PlayableBlendLayer<T>,
  deltaSeconds: number
): T[] {
  if (layer.blendTime <= 0 || layer.inputs.length === 0) return []
  const dt = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0
  layer.blendElapsed += dt
  const rawT = Math.max(0, Math.min(1, layer.blendElapsed / layer.blendTime))
  // 30 * (1/60) 在 IEEE-754 f64 下为 0.49999999999999994，按 1e-6 容差归 1 避免多留 1 帧残影。
  const done = rawT >= 1 - 1e-6
  const t = done ? 1 : rawT
  for (const input of layer.inputs) {
    input.weight = input.from + (input.to - input.from) * t
  }
  if (done) {
    const removed: T[] = []
    const kept: PlayableBlendInput<T>[] = []
    for (const input of layer.inputs) {
      if (input.to > 0) kept.push(input)
      else removed.push(input.key)
    }
    layer.inputs = kept
    layer.blendTime = 0
    layer.blendElapsed = 0
    return removed
  }
  return []
}

export interface EvaluatedBlendInput {
  weight: number
  values: ReadonlyMap<number, number>
}

/**
 * `Animator::evaluate` 的单层求值：
 * 对所有被层内任意输入动画化的参数 `p`，计算归一化线性加权和；
 * 某输入未覆盖 `p` 时贡献 `defaultValueAt(p)`。
 */
export function evaluateBlendedLayerValues(
  inputs: readonly EvaluatedBlendInput[],
  defaultValueAt: (paramIndex: number) => number
): Map<number, number> {
  const result = new Map<number, number>()
  if (inputs.length === 0) return result
  const animated = new Set<number>()
  for (const input of inputs) {
    for (const paramIndex of input.values.keys()) {
      animated.add(paramIndex)
    }
  }
  if (animated.size === 0) return result
  for (const paramIndex of animated) {
    let acc = 0
    const fallback = defaultValueAt(paramIndex)
    for (const input of inputs) {
      const value = input.values.get(paramIndex)
      acc += input.weight * (value !== undefined ? value : fallback)
    }
    result.set(paramIndex, acc)
  }
  return result
}
