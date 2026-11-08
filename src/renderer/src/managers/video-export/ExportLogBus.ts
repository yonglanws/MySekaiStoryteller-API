export type ExportLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

export interface ExportLogRecord {
  seq: number
  timestamp: number
  level: ExportLogLevel
  module: string
  message: string
  data?: unknown
}

/**
 * 导出日志总线：所有 ExportLogger 实例把日志同时写进这里，导出结束时一次性
 * 落盘成 `<video>.log.json`。旧的 ExportLogger 只有各实例的 1000 条环形缓冲，
 * 无法还原跨模块的先后顺序。
 */
export class ExportLogBus {
  private readonly maxEntries: number
  private entries: ExportLogRecord[] = []
  private start = 0
  private length = 0
  private seq = 0

  constructor(maxEntries = 20_000) {
    this.maxEntries = Math.max(1, maxEntries)
  }

  reset(): void {
    this.entries = []
    this.start = 0
    this.length = 0
    this.seq = 0
  }

  record(level: ExportLogLevel, module: string, message: string, data?: unknown): void {
    const entry: ExportLogRecord = {
      seq: this.seq++,
      timestamp: Date.now(),
      level,
      module,
      message,
      ...(data === undefined ? {} : { data })
    }
    if (this.length < this.maxEntries) {
      this.entries.push(entry)
      this.length++
      return
    }
    this.entries[this.start] = entry
    this.start = (this.start + 1) % this.maxEntries
  }

  snapshot(): ExportLogRecord[] {
    if (this.length < this.maxEntries) return [...this.entries]
    const result: ExportLogRecord[] = []
    for (let index = 0; index < this.length; index++) {
      result.push(this.entries[(this.start + index) % this.maxEntries])
    }
    return result
  }

  size(): number {
    return this.length
  }
}

export const exportLogBus = new ExportLogBus()
