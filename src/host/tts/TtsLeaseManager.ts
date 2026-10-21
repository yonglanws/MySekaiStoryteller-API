import { ILogObj, Logger } from 'tslog'

/**
 * GPT-SoVITS 的权重是服务端全局状态（/set_gpt_weights、/set_sovits_weights），
 * 不是每个 /tts 请求独立的。多个渲染 worker 同时合成不同角色时，必须把
 * 「切权重 + 合成」串行化，否则一个 worker 会在另一个 worker 合成途中把权重换掉。
 *
 * 这是宿主侧的租约：同一时刻只发一张租约；渲染端拿到租约后才切权重并请求 /tts。
 */
export interface TtsWeights {
  gptWeightsPath: string
  sovitsWeightsPath: string
}

export interface TtsLeaseGrant {
  leaseId: string
  /** 上一次释放时确认已加载的权重；null 表示未知，调用方必须重新切换 */
  currentWeights: TtsWeights | null
}

export interface TtsLeaseOptions {
  /** 租约最长持有时间；渲染端 /tts 超时 30s，这里留足切换与排队余量 */
  leaseTtlMs?: number
  /** 空闲超过该时长后，下一次租约强制重新切权重（防止 WebUI 等外部改过权重） */
  idleResetMs?: number
  /** 排队等待租约的上限 */
  acquireTimeoutMs?: number
}

interface Waiter {
  resolve: (grant: TtsLeaseGrant) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}

interface ActiveLease {
  leaseId: string
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_LEASE_TTL_MS = 90_000
const DEFAULT_IDLE_RESET_MS = 30_000
const DEFAULT_ACQUIRE_TIMEOUT_MS = 180_000

export class TtsLeaseManager {
  private readonly logger: Logger<ILogObj>
  private readonly leaseTtlMs: number
  private readonly idleResetMs: number
  private readonly acquireTimeoutMs: number

  private active: ActiveLease | null = null
  private waiters: Waiter[] = []
  private currentWeights: TtsWeights | null = null
  private lastActivityAt: number = Date.now()
  private sequence: number = 0

  constructor(logger: Logger<ILogObj>, options: TtsLeaseOptions = {}) {
    this.logger = logger
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
    this.idleResetMs = options.idleResetMs ?? DEFAULT_IDLE_RESET_MS
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS
  }

  /**
   * 取得租约。空闲时立即返回；否则按 FIFO 排队。调用方应在释放时回报
   * 实际加载的权重，宿主只缓存「经过租约确认」的状态。
   */
  acquire(signal?: AbortSignal): Promise<TtsLeaseGrant> {
    if (signal?.aborted) {
      return Promise.reject(new Error('TTS lease acquisition aborted'))
    }

    return new Promise<TtsLeaseGrant>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(waiter)
          reject(new Error('Timed out waiting for TTS lease'))
        }, this.acquireTimeoutMs),
        signal
      }

      if (signal) {
        waiter.onAbort = () => {
          this.removeWaiter(waiter)
          clearTimeout(waiter.timer)
          reject(new Error('TTS lease acquisition aborted'))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }

      if (this.active) {
        this.waiters.push(waiter)
        this.logger.info(`[TTS] Lease queued (waiters=${this.waiters.length})`)
      } else {
        this.grant(waiter)
      }
    })
  }

  /**
   * 释放租约。weights 传对象表示确认已加载；传 null 表示状态未知（强制下次重切）；
   * 省略表示保持上一次的缓存。
   */
  release(leaseId: string, weights?: TtsWeights | null): void {
    if (!this.active || this.active.leaseId !== leaseId) {
      this.logger.warn(`[TTS] Ignoring release for unknown/stale lease ${leaseId}`)
      return
    }

    clearTimeout(this.active.timer)
    this.active = null
    if (weights !== undefined) {
      this.currentWeights = weights
    }
    this.lastActivityAt = Date.now()
    this.grantNext()
  }

  stats(): {
    active: boolean
    waiters: number
    currentWeights: TtsWeights | null
  } {
    return {
      active: this.active !== null,
      waiters: this.waiters.length,
      currentWeights: this.currentWeights
    }
  }

  dispose(): void {
    if (this.active) {
      clearTimeout(this.active.timer)
      this.active = null
    }
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      this.detachAbort(waiter)
      waiter.reject(new Error('TTS lease manager disposed'))
    }
    this.waiters = []
  }

  private grant(waiter: Waiter): void {
    clearTimeout(waiter.timer)
    this.detachAbort(waiter)

    if (Date.now() - this.lastActivityAt >= this.idleResetMs) {
      // 空闲期间可能有人在 GSV WebUI 手动切过权重，不能再信任缓存
      this.currentWeights = null
    }

    const leaseId = `tts-${++this.sequence}`
    const timer = setTimeout(() => this.expire(leaseId), this.leaseTtlMs)
    this.active = { leaseId, timer }
    this.lastActivityAt = Date.now()

    waiter.resolve({ leaseId, currentWeights: this.currentWeights })
  }

  private grantNext(): void {
    while (this.waiters.length > 0) {
      const next = this.waiters.shift()!
      if (next.signal?.aborted) {
        clearTimeout(next.timer)
        this.detachAbort(next)
        next.reject(new Error('TTS lease acquisition aborted'))
        continue
      }
      this.grant(next)
      return
    }
  }

  private expire(leaseId: string): void {
    if (!this.active || this.active.leaseId !== leaseId) return

    this.logger.warn(`[TTS] Lease ${leaseId} expired without release; invalidating weight cache`)
    this.active = null
    // 渲染端可能已经切了权重但没来得及回报，下一次必须重新切
    this.currentWeights = null
    this.lastActivityAt = Date.now()
    this.grantNext()
  }

  private removeWaiter(waiter: Waiter): void {
    const index = this.waiters.indexOf(waiter)
    if (index >= 0) {
      this.waiters.splice(index, 1)
    }
    this.detachAbort(waiter)
  }

  private detachAbort(waiter: Waiter): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      waiter.onAbort = undefined
    }
  }
}
