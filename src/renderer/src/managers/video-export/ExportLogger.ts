import { ILogObj, Logger } from 'tslog'
import getSubLogger from '../../utils/Logger'
import { exportLogBus } from './ExportLogBus'

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR'
}

export interface ExportLogEntry {
  timestamp: number
  level: LogLevel
  module: string
  message: string
  data?: unknown
}

export class ExportLogger {
  private readonly logger: Logger<ILogObj>
  private readonly moduleName: string
  private readonly logHistory: ExportLogEntry[] = []
  private readonly maxHistorySize: number = 1000
  private historyStart: number = 0
  private historyLength: number = 0

  constructor(moduleName: string = 'VideoExport') {
    this.moduleName = moduleName
    this.logger = getSubLogger(moduleName)
  }

  debug(message: string, data?: unknown): void {
    this.log(LogLevel.DEBUG, message, data)
    this.logger.debug(message, data)
  }

  info(message: string, data?: unknown): void {
    this.log(LogLevel.INFO, message, data)
    this.logger.info(message, data)
  }

  warn(message: string, data?: unknown): void {
    this.log(LogLevel.WARN, message, data)
    this.logger.warn(message, data)
  }

  error(message: string, data?: unknown): void {
    this.log(LogLevel.ERROR, message, data)
    this.logger.error(message, data)
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    const entry: ExportLogEntry = {
      timestamp: Date.now(),
      level,
      module: this.moduleName,
      message,
      data
    }

    // 全局总线保留跨模块顺序，导出结束时落盘；各实例环形缓冲继续供本地查询。
    exportLogBus.record(level, this.moduleName, message, data)

    if (this.historyLength < this.maxHistorySize) {
      if (this.logHistory.length < this.maxHistorySize) {
        this.logHistory.push(entry)
      } else {
        this.logHistory[this.historyStart] = entry
        this.historyStart = (this.historyStart + 1) % this.maxHistorySize
      }
      this.historyLength++
    } else {
      this.logHistory[this.historyStart] = entry
      this.historyStart = (this.historyStart + 1) % this.maxHistorySize
    }
  }

  getHistory(): ReadonlyArray<ExportLogEntry> {
    if (this.historyLength < this.maxHistorySize) {
      return [...this.logHistory]
    }
    const result: ExportLogEntry[] = []
    for (let i = 0; i < this.historyLength; i++) {
      const idx = (this.historyStart + i) % this.maxHistorySize
      result.push(this.logHistory[idx])
    }
    return result
  }

  clearHistory(): void {
    this.logHistory.length = 0
    this.historyStart = 0
    this.historyLength = 0
  }

  exportLogs(): string {
    return this.getHistory()
      .map((entry) => {
        let dataStr = ''
        if (entry.data !== undefined) {
          try {
            dataStr = ` | Data: ${JSON.stringify(entry.data)}`
          } catch {
            dataStr = ' | Data: [non-serializable]'
          }
        }
        return `[${new Date(entry.timestamp).toISOString()}][${entry.level}][${entry.module}] ${entry.message}${dataStr}`
      })
      .join('\n')
  }
}
