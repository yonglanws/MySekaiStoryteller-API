import { Ticker, UPDATE_PRIORITY } from 'pixi.js'
import getSubLogger from '../utils/Logger'
import { ILogObj, Logger } from 'tslog'
import { FRAME_MS } from '../../../common/official/timing'

/**
 * 帧步进：导出模式按真实 elapsed 推进（最多 1 秒），预览模式最多 250ms。
 * 旧实现把 >100ms 的帧压成 20ms，导出负载高时动画会慢 5~10 倍。
 */
export function resolveFrameStepMs(
  rawDeltaMs: number,
  exporting: boolean,
  elegant = false
): number {
  const maxStep = exporting ? 1000 : 250
  let usedTime = Math.min(Math.max(0, rawDeltaMs), maxStep)
  if (!exporting && elegant && usedTime > 30 && usedTime < 100) usedTime = 25
  return usedTime
}

export default class AnimationManager {
  private static logger: Logger<ILogObj> = getSubLogger('AnimationManager').getSubLogger({
    name: 'WatchDog'
  })

  public static exportSpeedMultiplier: number = 1
  public static exportTargetFPS: number = 60
  public static exportEncodeFPS: number = 60
  /**
   * 测试专用：非 null 时导出 in_ticker 回退到该间隔的 setTimeout 步进。
   * 生产导出始终为 null，由帧泵的 1/60 故事步统一驱动。
   */
  public static testExportStepIntervalMs: number | null = null
  /** 帧泵是否已接管导出步进；未接管时（直调片段的测试/预览）回退 setTimeout。 */
  public static exportStepDriverActive: boolean = false
  private static isExportMode: boolean = false

  public static setExportStepDriver(active: boolean): void {
    this.exportStepDriverActive = active
  }

  /**
   * 导出模式的动画步进订阅：由帧泵在每个 1/60 故事步调用一次 dispatchExportStep，
   * 不再使用独立的 17ms setTimeout。每条订阅在 when_finish 返回 true 时解除。
   */
  private static exportStepHandlers = new Set<{
    onStep: (ticker: Ticker) => void
    whenFinish: (ticker: Ticker) => boolean
    startedAt: number
    resolve: () => void
  }>()

  public static setExportMode(enabled: boolean): void {
    this.isExportMode = enabled
    if (!enabled) {
      this.exportEncodeFPS = 60
      this.exportStepHandlers.clear()
    }
  }

  public static isExporting(): boolean {
    return this.isExportMode
  }

  /** 帧泵每个固定 1/60 故事步调用一次；ticker 为 Ticker.shared（deltaMS=1000/60）。 */
  public static dispatchExportStep(ticker: Ticker): void {
    if (this.exportStepHandlers.size === 0) return
    const now = performance.now()
    for (const handler of Array.from(this.exportStepHandlers)) {
      handler.onStep(ticker)
      if (handler.whenFinish(ticker)) {
        this.exportStepHandlers.delete(handler)
        handler.resolve()
        continue
      }
      // 与旧 setTimeout 实现相同的 60s 剧情时间兜底，避免任务永久挂起
      if (now - handler.startedAt > 60_000) {
        this.logger.warn('in_ticker export step exceeded 60000ms, forcing completion')
        this.exportStepHandlers.delete(handler)
        handler.resolve()
      }
    }
  }

  /** 导出异常/取消时清空订阅，避免下一轮导出继承悬挂的 Promise。 */
  public static resetExportStepHandlers(): void {
    for (const handler of this.exportStepHandlers) {
      handler.resolve()
    }
    this.exportStepHandlers.clear()
  }

  public static async in_ticker(
    on_step: (ticker: Ticker) => void,
    when_finish: (ticker: Ticker) => boolean
  ): Promise<void> {
    if (AnimationManager.isExportMode) {
      if (
        AnimationManager.testExportStepIntervalMs !== null ||
        !AnimationManager.exportStepDriverActive
      ) {
        await AnimationManager.in_ticker_settimeout(on_step, when_finish)
      } else {
        await AnimationManager.in_ticker_export(on_step, when_finish)
      }
    } else {
      await AnimationManager.in_ticker_raf(on_step, when_finish)
    }
  }

  /** 仅测试替身使用；生产导出不会走这里。 */
  private static async in_ticker_settimeout(
    on_step: (ticker: Ticker) => void,
    when_finish: (ticker: Ticker) => boolean
  ): Promise<void> {
    const interval = Math.max(
      1,
      AnimationManager.testExportStepIntervalMs ??
        Math.max(Math.round(1000 / AnimationManager.exportTargetFPS), 8)
    )
    let lastTime = performance.now()
    let startTime = lastTime
    const maxDuration = 60_000

    await new Promise<void>((resolve) => {
      const step = (): void => {
        const now = performance.now()
        if (now < lastTime) lastTime = now
        if (now < startTime) startTime = now
        const delta = Math.max(0, now - lastTime)
        lastTime = now

        const fakeTicker = {
          elapsedMS: delta,
          deltaTime: delta * 0.06,
          lastTime: now
        } as Ticker

        on_step(fakeTicker)
        if (when_finish(fakeTicker)) {
          resolve()
          return
        }
        if (now - startTime > maxDuration) {
          AnimationManager.logger.warn(
            `in_ticker test step exceeded ${maxDuration}ms, forcing completion`
          )
          resolve()
          return
        }
        setTimeout(step, interval)
      }

      setTimeout(step, interval)
    })
  }

  /** 导出模式：注册到帧泵的故事步；每次 dispatch 用同一个 Ticker.shared 步进。 */
  private static in_ticker_export(
    on_step: (ticker: Ticker) => void,
    when_finish: (ticker: Ticker) => boolean
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      AnimationManager.exportStepHandlers.add({
        onStep: on_step,
        whenFinish: when_finish,
        startedAt: performance.now(),
        resolve
      })
    })
  }

  private static async in_ticker_raf(
    on_step: (ticker: Ticker) => void,
    when_finish: (ticker: Ticker) => boolean
  ): Promise<void> {
    const task = new Promise<void>((resolve) => {
      const ticker = new Ticker()

      ticker.maxFPS = AnimationManager.exportSpeedMultiplier > 1 ? 0 : 60

      let startTime = performance.now()
      const maxDuration = 60_000
      let timeoutId: ReturnType<typeof setTimeout> | null = null

      const tickerFn = (): void => {
        on_step(ticker)
        if (when_finish(ticker)) {
          resolve()
          ticker.stop()
          ticker.destroy()
          if (timeoutId) clearTimeout(timeoutId)
          return
        }
        const now = performance.now()
        if (now < startTime) startTime = now
        if (now - startTime > maxDuration) {
          this.logger.warn(`in_ticker_raf exceeded ${maxDuration}ms, forcing completion`)
          resolve()
          ticker.stop()
          ticker.destroy()
          if (timeoutId) clearTimeout(timeoutId)
        }
      }

      ticker.add(tickerFn, UPDATE_PRIORITY.INTERACTION)
      ticker.start()

      timeoutId = setTimeout(() => {
        this.logger.warn(`in_ticker_raf timeout after ${maxDuration}ms, forcing completion`)
        resolve()
        ticker.stop()
        ticker.destroy()
      }, maxDuration)
    })
    await task
  }

  /**
   * 0..1 的线性进度，只由虚拟时钟决定：同一时刻求值结果相同，暂停后不累积漂移。
   * `startMs` 是绝对开始时刻，`frames` 是官方帧数。
   */
  public static progressAt(startMs: number, frames: number, now = performance.now()): number {
    if (!(frames > 0) || !Number.isFinite(now)) return 1
    return Math.max(0, Math.min(1, (now - startMs) / (frames * FRAME_MS)))
  }

  public static async linear(
    animation: (progress: number) => void,
    time_ms: number,
    elegant: boolean = false,
    opts?: { maxProgressPerFrame?: number; startMs?: number; frames?: number }
  ): Promise<void> {
    // 绝对时间模式：官方 `Tween::at(frame)` 的等价物，progress 不再逐帧累加。
    if (opts?.startMs !== undefined && opts?.frames !== undefined) {
      const startMs = opts.startMs
      const frames = Math.max(0, opts.frames)
      if (frames === 0) {
        animation(1)
        return
      }
      let progress = 0
      const evaluate = (): number => {
        progress = AnimationManager.progressAt(startMs, frames)
        animation(progress)
        return progress
      }
      if (evaluate() >= 1) return
      await AnimationManager.in_ticker(
        () => {
          evaluate()
        },
        () => progress >= 1
      )
      animation(1)
      return
    }
    const effectiveTime = time_ms / AnimationManager.exportSpeedMultiplier
    let progress = 0
    animation(0)

    // 预览卡顿限幅：单帧最多推进 opts.maxProgressPerFrame（如 show/hide 传 0.25），
    // 长帧（切后台/卡顿）不再把 100ms 渐变跳成一步。仅预览生效；导出的虚拟时钟
    // 33ms 均匀 tick 不受影响，maxStep 追赶语义保留。
    const maxProgressPerFrame =
      !AnimationManager.isExportMode &&
      Number.isFinite(opts?.maxProgressPerFrame) &&
      (opts?.maxProgressPerFrame ?? 0) > 0
        ? (opts?.maxProgressPerFrame as number)
        : 0

    if (effectiveTime >= 30) {
      await AnimationManager.in_ticker(
        (ticker) => {
          const rawDeltaTime = ticker.elapsedMS
          // 导出时必须按真实帧间隔推进：旧实现把 >100ms 的帧截成 20ms，负载高时
          // fade/move 会慢 5~10 倍，而 Live2D 动作仍按真实时间播放，两者不同步。
          // 只保留 1 秒上限，防止切后台/断点恢复时一次跳完整段动画。
          const usedTime = resolveFrameStepMs(rawDeltaTime, AnimationManager.isExportMode, elegant)
          if (rawDeltaTime > 250) {
            this.logger.warn(
              `A frame time of up to ${rawDeltaTime.toFixed(2)}ms has been detected` +
                (AnimationManager.isExportMode ? ' (using real elapsed time)' : ' (clamped)')
            )
          }

          const previous = progress
          progress += usedTime / effectiveTime
          progress = Math.min(progress, 1)
          if (maxProgressPerFrame > 0) {
            progress = Math.min(progress, previous + maxProgressPerFrame)
          }
          animation(progress)
        },
        () => progress >= 1
      )
    }
    animation(1)
  }

  public static async cosine(
    animation: (progress: number) => void,
    time_ms: number,
    elegant: boolean = false
  ): Promise<void> {
    await AnimationManager.linear(
      (p) => {
        const eased = (1 - Math.cos(p * Math.PI)) / 2
        animation(eased)
      },
      time_ms,
      elegant
    )
  }

  public static async sine(
    animation: (progress: number) => void,
    time_ms: number,
    elegant: boolean = false
  ): Promise<void> {
    await AnimationManager.linear(
      (p) => {
        const eased = Math.sin((p * Math.PI) / 2)
        animation(eased)
      },
      time_ms,
      elegant
    )
  }

  public static async delay(time_ms: number): Promise<void> {
    const effectiveDelay = time_ms / AnimationManager.exportSpeedMultiplier
    if (effectiveDelay <= 0) return
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve()
      }, effectiveDelay)
    })
  }
}
