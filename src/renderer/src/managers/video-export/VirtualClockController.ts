import { Ticker } from 'pixi.js'
import * as FakeTimers from '@sinonjs/fake-timers'
import { ExportLogger } from './ExportLogger'

/**
 * 虚拟时钟控制器（fast 导出模式核心）。
 *
 * 用 @sinonjs/fake-timers 接管页面内的计时 API（setTimeout/setInterval/
 * requestAnimationFrame/performance.now/Date），然后由帧泵以固定步长
 * （1000/fps 毫秒）推进虚拟时间。
 *
 * 这样所有动画系统——AnimationManager 的 setTimeout 步进、Ticker.shared
 * 驱动的 Live2D、TalkSnippet 的口型 ticker 与 performance.now 采样、
 * AdvancedModel 的 Date.now 眨眼计时、打字机——都按虚拟时间演进，
 * 行为与实时录制一致，但不再等待真实时间流逝。
 *
 * 注意：
 * - fetch / decodeAudioData / WebSocket 等真实异步不受虚拟时钟影响；
 *   所有网络/解码类工作必须在 install() 之前完成。
 * - install 前会重启 Ticker.shared，保证其 rAF 回调来自假时钟；
 *   uninstall 时同样重启一次恢复真实驱动。
 */
export class VirtualClockController {
  private readonly logger = new ExportLogger('VirtualClock')
  private clock: FakeTimers.Clock | null = null
  private wasTickerStarted: boolean = false
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
    // 停掉 Ticker.shared，使其在 install 之后重新获取（假的）rAF
    try {
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

      // 重新启动 Ticker.shared —— 此时它内部调度的 rAF 已进入虚拟时钟
      Ticker.shared.start()
    } catch (error) {
      // 安装或重启 Ticker 抛错时必须立即回滚假时钟，避免污染全局计时器或卡死 Ticker.shared
      this.clock = null
      try {
        Ticker.shared.stop()
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

    this.logger.info('Virtual clock installed')
  }

  private resetTickerTimebase(): void {
    const ticker = Ticker.shared as unknown as { lastTime: number; _lastFrame?: number }
    ticker.lastTime = -1
    if (typeof ticker._lastFrame === 'number') {
      ticker._lastFrame = -1
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
    this.wasTickerStarted = false

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
