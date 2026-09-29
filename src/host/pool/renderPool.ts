import { chromium, Browser, Page } from 'playwright'
import { ILogObj, Logger } from 'tslog'
import * as fs from 'node:fs'
import * as os from 'node:os'
import type { HostConfig, TtsCharacter } from '../config'
import type { WsHub, WorkerMessage } from '../bridge/wsHub'
import type { ExportDispatcher, ExportTask } from '../servers/VideoApiServer'

export interface ExportResultPayload {
  taskId: string
  success: boolean
  videoPath?: string
  duration?: number
  frameCount?: number
  outputSize?: number
  /** 分段时间统计（页内埋点，毫秒） */
  timings?: Record<string, number>
  error?: string
}

interface WorkerState {
  workerId: string
  browser: Browser | null
  page: Page | null
  ready: boolean
  busy: boolean
  busyTaskId: string | null
  exportsCompleted: number
  webglRenderer: string | null
  launching: boolean
  /** 正在主动回收，忽略旧页面关闭产生的断连通知 */
  recovering: boolean
  /** 任务截止时间或取消时间；再过 WATCHDOG_GRACE_MS 后强制回收 */
  taskDeadline: number | null
  /** 看门狗：是否已向该 worker 发过 abort */
  abortSent: boolean
}

const WORKER_READY_TIMEOUT_MS = 60000
const RELAUNCH_DELAY_MS = 30000
/** 看门狗巡检间隔 */
const WATCHDOG_INTERVAL_MS = 15000
/** 超过任务超时后、强制回收前的宽限（等待渲染端优雅退出） */
const WATCHDOG_GRACE_MS = 60000

function baseLaunchArgs(config: HostConfig): string[] {
  const args = [
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-dev-shm-usage',
    '--force-color-profile=srgb'
  ]

  if (process.platform === 'linux') {
    args.push('--no-sandbox')
    if (config.render.linuxGpuAngle) {
      args.push('--use-angle=gl')
    }
  }
  args.push(
    ...config.render.extraChromeArgs
      .split(' ')
      .map((a) => a.trim())
      .filter(Boolean)
  )
  return args
}

/**
 * 无头浏览器渲染池。
 * 每个工作进程 = 一个独立浏览器实例（独立 WebGL 上下文），页面加载 webrenderer
 * 后通过 WebSocket 接收 api:start-export 任务、回传 api:export-result。
 */
export class RenderPool implements ExportDispatcher {
  private readonly logger: Logger<ILogObj>
  private readonly config: HostConfig
  private readonly hub: WsHub
  private readonly workers = new Map<string, WorkerState>()
  private readonly readyWaiters = new Map<string, Array<() => void>>()
  private readonly bufferedTasks: ExportTask[] = []
  private stopping = false
  private watchdogInterval: ReturnType<typeof setInterval> | null = null

  onExportResult: ((taskId: string, result: ExportResultPayload) => void) | null = null

  constructor(
    logger: Logger<ILogObj>,
    config: HostConfig,
    hub: WsHub,
    private readonly catalog?: {
      get(): {
        models: Array<{ id: number; name: string; shortName?: string }>
      }
    }
  ) {
    this.logger = logger
    this.config = config
    this.hub = hub
  }

  async start(): Promise<void> {
    const launchArgs = baseLaunchArgs(this.config)

    for (let i = 0; i < this.config.render.workers; i++) {
      const workerId = `w${i + 1}`
      this.workers.set(workerId, this.createWorkerState(workerId))
      // 串行启动，避免并发启动争抢
      await this.launchWorker(this.workers.get(workerId)!, launchArgs)
    }

    // 看门狗：渲染端挂起（不返回 export-result 也不崩溃）时强制回收 worker，
    // 否则 busy 永真，后续任务全部堆积在 bufferedTasks；
    // 同时兜底冲刷被内存护栏暂缓的缓冲任务
    this.watchdogInterval = setInterval(() => {
      this.checkWatchdog()
      if (this.bufferedTasks.length > 0) {
        this.flushBufferedTasks()
      }
    }, WATCHDOG_INTERVAL_MS)
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval)
      this.watchdogInterval = null
    }
    this.bufferedTasks.length = 0
    for (const [, worker] of this.workers) {
      await this.closeBrowser(worker)
    }
    this.hub.closeAll()
    this.logger.info('[Pool] All render workers stopped')
  }

  stats(): Record<string, unknown> {
    const all = Array.from(this.workers.values())
    return {
      configuredWorkers: this.config.render.workers,
      readyWorkers: all.filter((w) => w.ready).length,
      idleWorkers: all.filter((w) => w.ready && !w.busy).length,
      busyTaskIds: all.filter((w) => w.busyTaskId).map((w) => w.busyTaskId),
      bufferedTasks: this.bufferedTasks.length,
      webglRenderers: all.map((w) => ({ workerId: w.workerId, renderer: w.webglRenderer })),
      exportsCompleted: all.reduce((sum, w) => sum + w.exportsCompleted, 0)
    }
  }

  // ----- 生命周期 -----

  private createWorkerState(workerId: string): WorkerState {
    return {
      workerId,
      browser: null,
      page: null,
      ready: false,
      busy: false,
      busyTaskId: null,
      exportsCompleted: 0,
      webglRenderer: null,
      launching: false,
      recovering: false,
      taskDeadline: null,
      abortSent: false
    }
  }

  private async launchBrowser(launchArgs: string[]): Promise<{ browser: Browser; via: string }> {
    const channels = this.config.render.browserExecutablePath
      ? [null]
      : [...this.config.render.browserChannels, null]

    const errors: string[] = []
    for (const channel of channels) {
      try {
        const browser = await chromium.launch({
          headless: true,
          channel: channel ?? undefined,
          executablePath: this.config.render.browserExecutablePath || undefined,
          args: launchArgs
        })
        return { browser, via: channel ?? 'bundled-chromium' }
      } catch (err) {
        errors.push(`${channel ?? 'bundled'}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    throw new Error(`Failed to launch any browser. Attempts:\n${errors.join('\n')}`)
  }

  private async launchWorker(worker: WorkerState, launchArgs?: string[]): Promise<void> {
    if (this.stopping || worker.launching) return
    worker.launching = true
    worker.ready = false
    worker.webglRenderer = null

    const args = launchArgs || baseLaunchArgs(this.config)

    try {
      const { browser, via } = await this.launchBrowser(args)
      worker.browser = browser

      browser.on('disconnected', () => {
        // 主动回收已把 worker.browser 清空；旧浏览器不能触发第二次重启。
        if (worker.browser === browser) this.handleBrowserDisconnected(worker)
      })

      await this.openWorkerPage(worker)
      this.logger.info(
        `[Pool] Worker ${worker.workerId} ready (browser: ${via}, recycle every ${
          this.config.render.workerRecycleExports || '∞'
        } exports)`
      )
    } catch (err) {
      this.logger.error(`[Pool] Worker ${worker.workerId} launch failed`, err)
      setTimeout(() => {
        if (!this.stopping) {
          void this.launchWorker(worker).catch(() => undefined)
        }
      }, RELAUNCH_DELAY_MS)
    } finally {
      worker.launching = false
    }
  }

  private async openWorkerPage(worker: WorkerState): Promise<void> {
    // 先关旧页：WS  flap 后重复 newPage 会累积多个带 WebGL 上下文的页面
    if (worker.page) {
      try {
        await worker.page.close()
      } catch {
        /* 旧页可能已随导航/崩溃销毁 */
      }
      worker.page = null
    }

    const page = await worker.browser!.newPage()
    worker.page = page

    const readyPromise = this.waitForReady(worker.workerId)

    await page.goto(`http://127.0.0.1:${this.config.server.port}/?worker=${worker.workerId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })

    await readyPromise
    await this.probeWebGL(worker)
    if (this.stopping || worker.page !== page) return
    worker.ready = true
    this.flushBufferedTasks()
  }

  private waitForReady(workerId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Worker ${workerId} not ready within ${WORKER_READY_TIMEOUT_MS}ms`))
      }, WORKER_READY_TIMEOUT_MS)
      const waiters = this.readyWaiters.get(workerId) || []
      waiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
      this.readyWaiters.set(workerId, waiters)
    })
  }

  private async probeWebGL(worker: WorkerState): Promise<void> {
    if (!worker.page) return
    try {
      // 探测代码以字符串形式注入执行（宿主 TS 环境无 DOM 类型）
      const renderer = (await worker.page.evaluate(`(() => {
        const canvas = document.createElement('canvas')
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
        if (!gl) return 'NO_WEBGL'
        const ext = gl.getExtension('WEBGL_debug_renderer_info')
        if (!ext) return String(gl.getParameter(gl.RENDERER))
        return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || 'UNKNOWN')
      })()`)) as string
      worker.webglRenderer = renderer
      this.logger.info(`[Pool] Worker ${worker.workerId} WebGL renderer: ${renderer}`)
      if (renderer === 'NO_WEBGL' || /swiftshader|software|llvmpipe/i.test(renderer)) {
        this.logger.warn(
          `[Pool] Worker ${worker.workerId} is NOT using hardware GPU acceleration (renderer: ${renderer})!`
        )
      }
    } catch (err) {
      this.logger.warn(`[Pool] Worker ${worker.workerId} WebGL probe failed`, err)
    }
  }

  private handleBrowserDisconnected(worker: WorkerState): void {
    if (this.stopping) return
    this.logger.warn(`[Pool] Worker ${worker.workerId} browser disconnected, relaunching...`)
    worker.browser = null
    worker.page = null
    worker.ready = false
    worker.taskDeadline = null
    worker.abortSent = false

    if (worker.busyTaskId) {
      const taskId = worker.busyTaskId
      worker.busy = false
      worker.busyTaskId = null
      this.onExportResult?.(taskId, {
        taskId,
        success: false,
        error: `Render worker ${worker.workerId} crashed during export`
      })
    }

    void this.launchWorker(worker).catch((err) =>
      this.logger.error(`[Pool] Worker ${worker.workerId} relaunch failed`, err)
    )
  }

  private async closeBrowser(worker: WorkerState): Promise<void> {
    const browser = worker.browser
    worker.browser = null
    worker.page = null
    worker.ready = false
    if (browser) {
      try {
        await browser.close()
      } catch {
        // ignore
      }
    }
  }

  // ----- 事件入口（main 接线到 WsHub）-----

  handleWorkerReady(workerId: string): void {
    this.logger.info(`[Pool] Worker ${workerId} bridge connected`)
    const waiters = this.readyWaiters.get(workerId)
    if (waiters) {
      for (const waiter of waiters) waiter()
      this.readyWaiters.delete(workerId)
    }
  }

  handleWorkerMessage(workerId: string, message: WorkerMessage): void {
    if (message.type === 'api:export-result') {
      const result = message.args[0] as ExportResultPayload
      this.logger.info(
        `[Pool] export-result fields: ${Object.keys(result || {}).join(',')} timings=${JSON.stringify(result?.timings ?? null)}`
      )
      const worker = this.workers.get(workerId)

      if (worker && worker.busyTaskId === result.taskId) {
        this.releaseWorker(worker)
        this.onExportResult?.(result.taskId, result)
      } else {
        this.logger.warn(
          `[Pool] Export-result for unknown/mismatched task: worker=${workerId}, taskId=${result?.taskId}`
        )
      }
      return
    }

    if (message.type === 'electron:on-error') {
      this.logger.error(`[Pool] Worker ${workerId} reported error`, message.args[0])
    }
  }

  handleWorkerDisconnected(workerId: string): void {
    const worker = this.workers.get(workerId)
    if (!worker || !worker.browser || this.stopping || worker.recovering || worker.launching) return
    worker.ready = false
    worker.taskDeadline = null
    worker.abortSent = false

    // WS 断开：若正在导出则视为失败，重启浏览器以清除旧页面和 GPU 状态。
    if (worker.busyTaskId) {
      const taskId = worker.busyTaskId
      worker.busy = false
      worker.busyTaskId = null
      this.onExportResult?.(taskId, {
        taskId,
        success: false,
        error: `Render worker ${worker.workerId} connection lost during export`
      })
    }

    void this.recoverWorker(worker)
  }

  // ----- ExportDispatcher -----

  /** 释放 worker（含按导出次数回收），并冲刷排队的任务 */
  private releaseWorker(worker: WorkerState): void {
    worker.busy = false
    worker.busyTaskId = null
    worker.taskDeadline = null
    worker.abortSent = false
    worker.exportsCompleted++

    // 页面回收：按导出次数重建，防止 Live2D/Cubism 内存累积
    if (
      this.config.render.workerRecycleExports > 0 &&
      worker.exportsCompleted % this.config.render.workerRecycleExports === 0
    ) {
      this.logger.info(
        `[Pool] Recycling worker ${worker.workerId} after ${worker.exportsCompleted} exports`
      )
      void this.closeBrowser(worker)
        .then(() => this.launchWorker(worker))
        .catch((err) =>
          this.logger.error(`[Pool] Worker ${worker.workerId} recycle relaunch failed`, err)
        )
    }

    this.flushBufferedTasks()
  }

  dispatch(task: ExportTask): void {
    if (this.stopping || Date.now() >= task.addedAt + task.timeoutMs) {
      this.onExportResult?.(task.taskId, {
        taskId: task.taskId,
        success: false,
        error: this.stopping
          ? 'Render pool is stopping'
          : 'Export timed out before rendering started'
      })
      return
    }

    const worker = this.pickIdleWorker()
    if (!worker || !this.hasEnoughFreeMemory()) {
      // 正常情况下 VideoApiServer 的并发上限保证有空闲 worker；此处仅兜底
      // （含内存护栏暂缓派发——由看门狗巡检周期内的 flushBufferedTasks 重试）
      this.bufferedTasks.push(task)
      this.logger.warn(
        `[Pool] No idle worker for task ${task.taskId}, buffered (buffered=${this.bufferedTasks.length})`
      )
      return
    }

    worker.busy = true
    worker.busyTaskId = task.taskId
    worker.abortSent = false
    worker.taskDeadline = task.addedAt + task.timeoutMs

    const payload = {
      taskId: task.taskId,
      story: task.story,
      outputPath: task.outputPath,
      videoConfig: task.videoConfig,
      // TTS/BGM 配置由宿主统一下发，渲染器不再读配置文件。
      // 角色名按 models.yaml 展开"全名/短名"双别名——剧本 speaker 可能用任一形式
      tts: { ...this.config.tts, characters: this.expandTtsCharacterAliases() },
      bgm: { ...this.config.bgm }
    }

    const sent = this.hub.send(worker.workerId, { type: 'api:start-export', args: [payload] })
    if (!sent) {
      worker.busy = false
      worker.busyTaskId = null
      worker.taskDeadline = null
      worker.abortSent = false
      this.onExportResult?.(task.taskId, {
        taskId: task.taskId,
        success: false,
        error: `Failed to send task to worker ${worker.workerId}`
      })
    }
  }

  cancel(taskId: string): void {
    const bufferedIndex = this.bufferedTasks.findIndex((task) => task.taskId === taskId)
    if (bufferedIndex !== -1) {
      this.bufferedTasks.splice(bufferedIndex, 1)
      this.logger.info(`[Pool] Cancelled buffered task ${taskId}`)
      return
    }

    // 通知渲染页中止当前导出。worker 保持 busy 直到收到 export-result，
    // 不会被派新任务；否则 HTTP 超时只取消等待，渲染还会跑完并写盘，
    // 白白阻塞下一个排队的任务（单 worker 时直接卡死）。
    for (const worker of this.workers.values()) {
      if (worker.busyTaskId === taskId) {
        if (worker.abortSent) return
        // 取消从现在起计宽限，不能让无响应页面继续占用 worker 直到原任务超时。
        // 重复取消也不能延长宽限期。
        worker.taskDeadline = Math.min(worker.taskDeadline ?? Date.now(), Date.now())
        worker.abortSent = true
        const sent = this.hub.send(worker.workerId, { type: 'api:abort-export', args: [taskId] })
        this.logger.info(
          `[Pool] Abort sent to ${worker.workerId} for task ${taskId} (sent=${sent})`
        )
        return
      }
    }
    this.logger.info(`[Pool] Cancel requested for task ${taskId} (no busy worker)`)
  }

  /**
   * 看门狗巡检：渲染端挂起（既不返回 export-result 也不崩溃/断连）时，
   * 超期先补发 abort，宽限后仍无响应则强制回收页面并失败任务——
   * 避免单个卡死任务把 worker 永久占死、bufferedTasks 无限堆积。
   */
  private checkWatchdog(): void {
    const now = Date.now()
    for (const worker of this.workers.values()) {
      if (!worker.busy || worker.taskDeadline === null) continue

      if (now >= worker.taskDeadline + WATCHDOG_GRACE_MS) {
        const taskId = worker.busyTaskId
        this.logger.error(
          `[Pool] Worker ${worker.workerId} watchdog timeout for task ${taskId}, ` +
            `force-recycling page`
        )
        // 回调可能同步派发下一任务；先隔离旧 worker，避免把新任务派到即将关闭的页。
        worker.ready = false
        worker.busy = false
        worker.busyTaskId = null
        worker.taskDeadline = null
        worker.abortSent = false
        if (taskId) {
          this.onExportResult?.(taskId, {
            taskId,
            success: false,
            error: `Render worker ${worker.workerId} watchdog timeout (no export-result)`
          })
        }
        void this.recoverWorker(worker)
        continue
      }

      if (now >= worker.taskDeadline && !worker.abortSent) {
        this.logger.warn(
          `[Pool] Worker ${worker.workerId} task ${worker.busyTaskId} exceeded timeout, ` +
            `re-sending abort`
        )
        if (worker.busyTaskId) this.cancel(worker.busyTaskId)
      }
    }
  }

  /** 单次回收整个浏览器，释放失联页面/GPU 资源并避免断连回调重复重启。 */
  private async recoverWorker(worker: WorkerState): Promise<void> {
    if (this.stopping || worker.recovering) return
    worker.recovering = true
    worker.ready = false
    try {
      await this.closeBrowser(worker)
      await this.launchWorker(worker)
    } finally {
      worker.recovering = false
    }
  }

  /**
   * TTS 角色配置的名称别名展开：
   * config.tts.characters 里的 characterName 是用户配置的（通常为模型全名，如"晓山瑞希"），
   * 而剧本 Talk.speaker 可能用短名（"瑞希"，models.yaml shortName）或全名。
   * 为每个已配置角色补充短名条目，渲染端按 speaker 精确查找即可命中。
   */
  private expandTtsCharacterAliases(): TtsCharacter[] {
    const characters = this.config.tts.characters
    if (!this.catalog || characters.length === 0) return characters

    const models = this.catalog.get().models
    const expanded = [...characters]
    for (const entry of characters) {
      const model = models.find((m) => m.name === entry.characterName)
      const shortName = model?.shortName
      if (
        shortName &&
        shortName !== entry.characterName &&
        !expanded.some((c) => c.characterName === shortName)
      ) {
        expanded.push({ ...entry, characterName: shortName })
      }
    }
    if (expanded.length !== characters.length) {
      this.logger.info(
        `[Pool] TTS characters expanded with short-name aliases: ${expanded.map((c) => c.characterName).join(', ')}`
      )
    }
    return expanded
  }

  private pickIdleWorker(): WorkerState | null {
    let idle: WorkerState | null = null
    let idleIndex = Number.MAX_SAFE_INTEGER
    const ids = Array.from(this.workers.keys())

    for (let i = 0; i < ids.length; i++) {
      const worker = this.workers.get(ids[i])!
      if (worker.ready && !worker.busy && i < idleIndex) {
        idle = worker
        idleIndex = i
      }
    }
    return idle
  }

  /**
   * 内存护栏（render.minFreeMemoryMb > 0 时生效）：
   * 可用内存过低时暂缓派发，避免 OOM killer 在导出中途杀掉 Chrome。
   * 探测失败时不拦截（宁可尝试也不无限搁置任务）。
   */
  private hasEnoughFreeMemory(): boolean {
    const minMb = this.config.render.minFreeMemoryMb
    if (minMb <= 0) return true

    try {
      if (process.platform === 'linux') {
        const meminfo = fs.readFileSync('/proc/meminfo', 'utf-8')
        const match = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/)
        if (match) {
          return Number(match[1]) / 1024 >= minMb
        }
      }
      return os.freemem() / (1024 * 1024) >= minMb
    } catch {
      return true
    }
  }

  private flushBufferedTasks(): void {
    if (this.stopping) return
    while (this.bufferedTasks.length > 0) {
      // 内存护栏未解除时不 shift，避免 dispatch 再次缓冲形成空转
      if (!this.hasEnoughFreeMemory()) return
      const worker = this.pickIdleWorker()
      if (!worker) return
      const task = this.bufferedTasks.shift()!
      this.dispatch(task)
    }
  }
}
