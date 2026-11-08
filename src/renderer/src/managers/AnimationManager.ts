import { Ticker, UPDATE_PRIORITY } from 'pixi.js'
import getSubLogger from '../utils/Logger'
import { ILogObj, Logger } from 'tslog'

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
  private static isExportMode: boolean = false

  public static setExportMode(enabled: boolean): void {
    this.isExportMode = enabled
  }

  public static isExporting(): boolean {
    return this.isExportMode
  }

  public static async in_ticker(
    on_step: (ticker: Ticker) => void,
    when_finish: (ticker: Ticker) => boolean
  ): Promise<void> {
    if (AnimationManager.isExportMode) {
      await AnimationManager.in_ticker_settimeout(on_step, when_finish)
    } else {
      await AnimationManager.in_ticker_raf(on_step, when_finish)
    }
  }

  private static async in_ticker_settimeout(
    on_step: (ticker: Ticker) => void,
    when_finish: (ticker: Ticker) => boolean
  ): Promise<void> {
    const interval = Math.max(Math.round(1000 / AnimationManager.exportTargetFPS), 8)
    let lastTime = performance.now()
    const startTime = performance.now()
    const maxDuration = 60_000

    await new Promise<void>((resolve) => {
      const step = (): void => {
        const now = performance.now()
        const delta = now - lastTime
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
          this.logger.warn(
            `in_ticker_settimeout exceeded ${maxDuration}ms, forcing completion (started at ${startTime}, now=${now})`
          )
          resolve()
          return
        }

        setTimeout(step, interval)
      }

      setTimeout(step, interval)
    })
  }

  private static async in_ticker_raf(
    on_step: (ticker: Ticker) => void,
    when_finish: (ticker: Ticker) => boolean
  ): Promise<void> {
    const task = new Promise<void>((resolve) => {
      const ticker = new Ticker()

      ticker.maxFPS = AnimationManager.exportSpeedMultiplier > 1 ? 0 : 60

      const startTime = performance.now()
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
        if (performance.now() - startTime > maxDuration) {
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

  public static async linear(
    animation: (progress: number) => void,
    time_ms: number,
    elegant: boolean = false
  ): Promise<void> {
    const effectiveTime = time_ms / AnimationManager.exportSpeedMultiplier
    let progress = 0
    animation(0)

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

          progress += usedTime / effectiveTime
          progress = Math.min(progress, 1)
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
