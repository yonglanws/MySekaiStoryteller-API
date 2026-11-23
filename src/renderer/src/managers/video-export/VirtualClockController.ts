import { Ticker } from 'pixi.js'
import * as FakeTimers from '@sinonjs/fake-timers'
import { FRAME_MS, STORY_FPS } from '../../../../common/official/timing'
import { ExportLogger } from './ExportLogger'

/**
 * 虚拟时钟控制器（fast 导出模式核心）。
 *
 * 用 @sinonjs/fake-timers 接管页面内的计时 API（setTimeout/setInterval/
 * requestAnimationFrame/performance.now/Date），然后由帧泵按**固定 1/60 故事步**
 * 推进虚拟时间。
 *
 * 关键点（对齐 sse-core time.rs 的固定 1/60 与 sse-live2d runtime 的每步 update）：
 * - 导出期间 Ticker.shared 不启动、autoStart=false，rAF 不再驱动模型；
 *   帧泵每个故事步显式调用一次 `Ticker.shared.update(该步虚拟时刻)`。
 * - 每次 update 的 elapsedMS 精确等于 1000/60，deltaTime 恒为 1（不再受 16ms rAF 影响）。
 * - 故事步数由帧泵按 `floor((k+1)×60/fps) − floor(k×60/fps)` 累加，非整除帧率
 *   不会用 ceil 放大剧情时间。
 *
 * 注意：
 * - fetch / decodeAudioData / WebSocket 等真实异步不受虚拟时钟影响；
 *   所有网络/解码类工作必须在 install() 之前完成。
 * - uninstall 时恢复 Ticker.shared 的 autoStart 与运行状态。
 */
export class VirtualClockController {
  private readonly logger = new ExportLogger('VirtualClock')
  private clock: FakeTimers.Clock | null = null
  private wasTickerStarted: boolean = false
  private wasTickerAutoStart: boolean = true
  /** 安装前的真实 performance.now（用于统计真实耗时） */
  private readonly realNow: () => number
  /** 安装前的真实 setTimeout（TTS 等待等不能走虚拟时钟） */
  private readonly nativeSetTimeout: typeof setTimeout

  constructor() {
    this.realNow = performance.now.bind(performance)
    this.nativeSetTimeout = globalThis.setTimeout.bind(globalThis)
  }

  install(): void {
    if (this.clock) {
      this.logger.warn('Virtual clock already installed')
      return
    }

    const wasStarted = Ticker.shared.started
    this.wasTickerAutoStart = Ticker.shared.autoStart
    // 停掉 Ticker.shared 并禁止自动重启：导出期间只允许帧泵显式 update
    try {
      Ticker.shared.autoStart = false
      Ticker.shared.stop()
    } catch {
      /* ignore */
    }

    let installedClock: FakeTimers.Clock | null = null
    try {
      installedClock = FakeTimers.install({
        toFake: [
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'requestAnimationFrame',
          'cancelAnimationFrame',
          'performance',
          'Date'
        ],
        shouldAdvanceTime: false
      })
      this.clock = installedClock
      this.wasTickerStarted = wasStarted
      this.resetTickerTimebase()

      // 不再 start()：Ticker 的 rAF 会按假时钟 16ms 的频率回调，破坏固定 1/60 步进。
      // 帧泵通过 advanceStorySteps() 显式驱动。
    } catch (error) {
      // 安装抛错时必须立即回滚假时钟，避免污染全局计时器或卡死 Ticker.shared
      this.clock = null
      try {
        Ticker.shared.stop()
        Ticker.shared.autoStart = this.wasTickerAutoStart
      } catch {
        /* ignore */
      }
      if (installedClock) {
        try {
          installedClock.uninstall()
        } catch {
          /* ignore */
        }
      }
      this.resetTickerTimebase()
      if (wasStarted) {
        try {
          Ticker.shared.start()
        } catch {
          /* ignore */
        }
      }
      throw error
    }

    this.logger.info(`Virtual clock installed (fixed ${STORY_FPS}Hz story steps)`)
  }

  private resetTickerTimebase(): void {
    const ticker = Ticker.shared as unknown as { lastTime: number; _lastFrame?: number }
    ticker.lastTime = -1
    if (typeof ticker._lastFrame === 'number') {
      ticker._lastFrame = -1
    }
  }

  /**
   * 推进 `steps` 个固定 1/60 故事步；每步只调用一次 Ticker.shared.update，
   * 并保证 elapsedMS 精确为 1000/60（与真实 rAF 的 16.00ms 脱钩）。
   */
  async advanceStorySteps(steps: number, onStep?: (nowMs: number) => void): Promise<void> {
    if (!this.clock) throw new Error('Virtual clock not installed')
    const count = Math.max(0, Math.floor(steps))
    const ticker = Ticker.shared as Ticker & { lastTime: number }
    for (let i = 0; i < count; i++) {
      await this.clock.tickAsync(FRAME_MS)
      const now = this.clock.now
      // 强制本次 update 的 elapsedMS = FRAME_MS，不受上一次 rAF/update 影响
      ticker.lastTime = now - FRAME_MS
      ticker.update(now)
      onStep?.(now)
    }
  }

  /** 推进虚拟时间 deltaMs 并等待期间触发的计时器回调完成 */
  async tick(deltaMs: number): Promise<void> {
    if (!this.clock) throw new Error('Virtual clock not installed')
    await this.clock.tickAsync(deltaMs)
  }

  /** 当前虚拟时间（等价于 performance.now()，只是语义更明确） */
  now(): number {
    return this.clock ? this.clock.performance.now() : this.realNow()
  }

  /** 真实墙钟时间（不受虚拟时钟影响），用于耗时统计 */
  realTimeMs(): number {
    return this.realNow()
  }

  /** 真实墙钟 sleep；虚拟时钟暂停时必须用这个，否则 setTimeout 永不触发 */
  realSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.nativeSetTimeout(resolve, ms)
    })
  }

  uninstall(restoreStarted?: boolean): void {
    const clock = this.clock
    if (!clock) return
    // 先置空再卸载，即使后续抛出也不会二次卸载或留下悬挂状态
    this.clock = null
    const shouldRestart = restoreStarted ?? this.wasTickerStarted
    const restoreAutoStart = this.wasTickerAutoStart
    this.wasTickerStarted = false
    this.wasTickerAutoStart = true

    let tickerErr: unknown = null
    try {
      // 先停再卸，避免卸载瞬间 Ticker 又向假时钟注册 rAF
      Ticker.shared.stop()
    } catch (error) {
      tickerErr = error
    }

    try {
      clock.uninstall()
    } finally {
      this.resetTickerTimebase()
      try {
        Ticker.shared.autoStart = restoreAutoStart
      } catch {
        /* ignore */
      }
      const hasListeners = (Ticker.shared as unknown as { count?: number }).count ?? 0
      if (shouldRestart || (Ticker.shared.autoStart && hasListeners > 0)) {
        try {
          Ticker.shared.start()
        } catch (error) {
          tickerErr = tickerErr ?? error
        }
      }
    }

    if (tickerErr) {
      this.logger.warn('Failed to restore Ticker.shared cleanly during uninstall', tickerErr)
    }
    this.logger.info('Virtual clock uninstalled')
  }
}
