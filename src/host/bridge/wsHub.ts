import { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket } from 'ws'
import { ILogObj, Logger } from 'tslog'

export interface WorkerMessage {
  type: string
  args: unknown[]
}

interface WorkerConnection {
  workerId: string
  socket: WebSocket
}

export interface WsHubEvents {
  onWorkerReady: (workerId: string) => void
  onWorkerMessage: (workerId: string, message: WorkerMessage) => void
  onWorkerDisconnected: (workerId: string) => void
}

/**
 * 渲染工作进程（无头浏览器页面）的 WebSocket 注册表。
 * 页面侧由 browser-bridge 连接 /bridge/ws?worker=<workerId>。
 */
export class WsHub {
  private readonly logger: Logger<ILogObj>
  private readonly connections = new Map<string, WorkerConnection>()
  private wss: WebSocketServer | null = null
  private events: WsHubEvents

  constructor(logger: Logger<ILogObj>, events: WsHubEvents) {
    this.logger = logger
    this.events = events
  }

  get connectedWorkerIds(): string[] {
    return Array.from(this.connections.keys())
  }

  attach(httpServer: {
    on: (event: string, listener: (...args: unknown[]) => void) => void
  }): void {
    this.wss = new WebSocketServer({ noServer: true })

    httpServer.on('upgrade', (req: unknown, socket: unknown, head: unknown) => {
      const request = req as IncomingMessage
      const url = new URL(request.url || '/', 'http://localhost')
      if (url.pathname !== '/bridge/ws') {
        return
      }
      this.wss?.handleUpgrade(request, socket as Duplex, head as Buffer, (ws) => {
        this.wss?.emit('connection', ws, request)
      })
    })

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const url = new URL(req.url || '/', 'http://localhost')
      const workerId = url.searchParams.get('worker') || `anon-${Date.now()}`

      // 同一 worker 重连：静默替换旧连接。先关旧 socket 防止连接累积；
      // 旧 socket 的 close 回调因映射已更新不会触发误报的断连事件。
      const existing = this.connections.get(workerId)
      if (existing && existing.socket !== ws) {
        this.logger.info(`[WS] Replacing stale connection for worker ${workerId}`)
        try {
          existing.socket.close()
        } catch {
          /* 旧 socket 可能已处于关闭中 */
        }
      }

      this.connections.set(workerId, { workerId, socket: ws })
      this.logger.info(`[WS] Worker connected: ${workerId}`)

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString()) as WorkerMessage
          this.events.onWorkerMessage(workerId, message)
        } catch (err) {
          this.logger.warn(`[WS] Failed to parse message from ${workerId}`, err)
        }
      })

      ws.on('close', () => {
        const existing = this.connections.get(workerId)
        if (existing && existing.socket === ws) {
          this.connections.delete(workerId)
          this.logger.info(`[WS] Worker disconnected: ${workerId}`)
          this.events.onWorkerDisconnected(workerId)
        }
      })

      ws.on('error', (err) => {
        this.logger.warn(`[WS] Worker ${workerId} socket error`, err)
      })

      this.events.onWorkerReady(workerId)
    })
  }

  send(workerId: string, message: WorkerMessage): boolean {
    const connection = this.connections.get(workerId)
    if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
      return false
    }
    connection.socket.send(JSON.stringify(message))
    return true
  }

  closeAll(): void {
    for (const [, connection] of this.connections) {
      try {
        connection.socket.close()
      } catch {
        // ignore
      }
    }
    this.connections.clear()
  }
}
