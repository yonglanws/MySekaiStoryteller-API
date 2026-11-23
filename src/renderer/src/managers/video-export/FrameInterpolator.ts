import type { App } from '../../app/App'

/**
 * 非整除帧率的帧间插值（对齐 sse-export Clock::state 的 lerp）。
 *
 * MSST 的模拟固定按 1/60 步进；当输出帧率不是 60 的约数时，输出帧 n 对应
 * 故事时间 n/fps，落在两个故事步之间（余量 t）。这里把连续量（Live2D 参数与
 * 模型容器变换）在 base 与 base+1 两个快照之间按 t 线性插值，阶梯量（文字、
 * visible 等）保持 base 帧的值。
 *
 * 渲染完成后调用 restore(B)，让下一次模拟从 base+1 状态继续，插值只影响当前
 * 这一帧的绘制，不回写模拟状态。
 */
interface CoreModelLike {
  getParameterCount?: () => number
  getParameterValueByIndex?: (index: number) => number
  setParameterValueByIndex?: (index: number, value: number, weight: number) => void
}

interface DisplayLike {
  position?: { x: number; y: number; set?: (x: number, y: number) => void }
  scale?: { x: number; y: number; set?: (x: number, y: number) => void }
  rotation?: number
  alpha?: number
  visible?: boolean
  filters?: Array<{ alpha?: number }>
}

interface ModelEntry {
  core: CoreModelLike | null
  display: DisplayLike
}

interface ParamSnapshot {
  core: CoreModelLike
  values: Float32Array
}

interface TransformSnapshot {
  display: DisplayLike
  x: number
  y: number
  scaleX: number
  scaleY: number
  rotation: number
  alpha: number
  filterAlpha: number
}

export interface FrameSnapshot {
  params: ParamSnapshot[]
  transforms: TransformSnapshot[]
}

export class FrameInterpolator {
  private readonly entries: ModelEntry[] = []
  private unavailableLogged = false

  constructor(
    app: App,
    private readonly logger: { warn: (message: string, data?: unknown) => void }
  ) {
    const models = app.storyManager?.storyData?.models ?? []
    for (const descriptor of models) {
      const model = app.getModelById?.(descriptor.id) as
        | (DisplayLike & { internalModel?: { coreModel?: CoreModelLike } })
        | undefined
      if (!model) continue
      this.entries.push({
        core: model.internalModel?.coreModel ?? null,
        display: model
      })
    }
  }

  get active(): boolean {
    return this.entries.some(
      (entry) =>
        typeof entry.core?.getParameterCount === 'function' &&
        typeof entry.core?.getParameterValueByIndex === 'function' &&
        typeof entry.core?.setParameterValueByIndex === 'function'
    )
  }

  snapshot(): FrameSnapshot {
    const params: ParamSnapshot[] = []
    const transforms: TransformSnapshot[] = []
    for (const entry of this.entries) {
      if (entry.core) {
        const count = entry.core.getParameterCount?.() ?? 0
        if (count > 0 && typeof entry.core.getParameterValueByIndex === 'function') {
          const values = new Float32Array(count)
          for (let i = 0; i < count; i++) {
            values[i] = entry.core.getParameterValueByIndex(i)
          }
          params.push({ core: entry.core, values })
        }
      }
      const display = entry.display
      transforms.push({
        display,
        x: display.position?.x ?? 0,
        y: display.position?.y ?? 0,
        scaleX: display.scale?.x ?? 1,
        scaleY: display.scale?.y ?? 1,
        rotation: display.rotation ?? 0,
        alpha: display.alpha ?? 1,
        filterAlpha: display.filters?.[0]?.alpha ?? 1
      })
    }
    return { params, transforms }
  }

  /** 把 from→to 的连续量按 t（0..1）写入模型，供当前帧绘制。 */
  apply(from: FrameSnapshot, to: FrameSnapshot, t: number): void {
    const mix = Math.max(0, Math.min(1, t))
    for (let i = 0; i < from.params.length && i < to.params.length; i++) {
      const a = from.params[i]
      const b = to.params[i]
      if (a.core !== b.core || a.values.length !== b.values.length) continue
      const setter = b.core.setParameterValueByIndex
      if (typeof setter !== 'function') continue
      for (let p = 0; p < a.values.length; p++) {
        const value = a.values[p] + (b.values[p] - a.values[p]) * mix
        setter.call(b.core, p, value, 1)
      }
    }
    for (let i = 0; i < from.transforms.length && i < to.transforms.length; i++) {
      const a = from.transforms[i]
      const b = to.transforms[i]
      if (a.display !== b.display) continue
      const display = b.display
      display.position?.set?.(a.x + (b.x - a.x) * mix, a.y + (b.y - a.y) * mix)
      display.scale?.set?.(
        a.scaleX + (b.scaleX - a.scaleX) * mix,
        a.scaleY + (b.scaleY - a.scaleY) * mix
      )
      if (typeof display.rotation === 'number') {
        display.rotation = a.rotation + (b.rotation - a.rotation) * mix
      }
      if (typeof display.alpha === 'number') {
        display.alpha = a.alpha + (b.alpha - a.alpha) * mix
      }
      const filter = display.filters?.[0]
      if (filter && typeof filter.alpha === 'number') {
        filter.alpha = a.filterAlpha + (b.filterAlpha - a.filterAlpha) * mix
      }
    }
  }

  /** 插值只用于绘制；渲染后恢复到 base+1 快照，保证下一步模拟连续。 */
  restore(to: FrameSnapshot): void {
    for (const param of to.params) {
      const setter = param.core.setParameterValueByIndex
      if (typeof setter !== 'function') continue
      for (let p = 0; p < param.values.length; p++) {
        setter.call(param.core, p, param.values[p], 1)
      }
    }
    for (const t of to.transforms) {
      t.display.position?.set?.(t.x, t.y)
      t.display.scale?.set?.(t.scaleX, t.scaleY)
      if (typeof t.display.rotation === 'number') t.display.rotation = t.rotation
      if (typeof t.display.alpha === 'number') t.display.alpha = t.alpha
      const filter = t.display.filters?.[0]
      if (filter && typeof filter.alpha === 'number') filter.alpha = t.filterAlpha
    }
  }

  logUnavailableOnce(): void {
    if (this.unavailableLogged) return
    this.unavailableLogged = true
    this.logger.warn(
      'Frame interpolation unavailable: Live2D core does not expose parameter index access; ' +
        'non-divisible fps will render the base story step.'
    )
  }
}
