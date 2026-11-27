import * as fs from 'node:fs'
import { IncomingMessage } from 'node:http'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket } from 'ws'
import { ILogObj, Logger } from 'tslog'
import { resolveContainedTempPath, timingSafeTokenEqual } from './bridgeSecurity'

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
  private readonly binarySockets = new Set<WebSocket>()
  private wss: WebSocketServer | null = null
  private binWss: WebSocketServer | null = null
  private events: WsHubEvents
  private readonly bridgeToken?: string

  constructor(logger: Logger<ILogObj>, events: WsHubEvents, bridgeToken?: string) {
    this.logger = logger
    this.events = events
    this.bridgeToken = bridgeToken
  }

  get connectedWorkerIds(): string[] {
    return Array.from(this.connections.keys())
  }

  private isAuthorizedUpgrade(request: IncomingMessage, url: URL): boolean {
    if (!this.bridgeToken) return true
    const headerToken = request.headers['x-mss-bridge-token']
    const queryToken = url.searchParams.get('token')
    const provided = (typeof headerToken === 'string' ? headerToken : '') || queryToken || ''
    return timingSafeTokenEqual(provided, this.bridgeToken)
  }

  attach(httpServer: {
    on: (event: string, listener: (...args: unknown[]) => void) => void
  }): void {
    this.wss = new WebSocketServer({ noServer: true })
    this.binWss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 * 1024 })

    httpServer.on('upgrade', (req: unknown, socket: unknown, head: unknown) => {
      const request = req as IncomingMessage
      const url = new URL(request.url || '/', 'http://localhost')
      if (url.pathname !== '/bridge/ws' && url.pathname !== '/bridge/ws-bin') {
        return
      }
      if (!this.isAuthorizedUpgrade(request, url)) {
        const netSocket = socket as Duplex
        netSocket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        netSocket.destroy()
        return
      }
      if (url.pathname === '/bridge/ws-bin') {
        this.binWss?.handleUpgrade(request, socket as Duplex, head as Buffer, (ws) => {
          this.handleBinaryConnection(ws)
        })
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

  private resolveContainedTempPath(rawPath: string): string | null {
    return resolveContainedTempPath(rawPath)
  }

  /**
   * 宿主机同源二进制 WebSocket 通道（`/bridge/ws-bin`）：
   * 作为 Rust `/bridge/rs-stream` 不可用时的零 HTTP 开销 fallback，
   * 支持 `open-file` / `close` / `abort` 与 `kind=1` (`WRITE_FILE_AT`) 16B 二进制帧。
   */
  private handleBinaryConnection(ws: WebSocket): void {
    this.binarySockets.add(ws)
    interface FileStreamEntry {
      filePath: string
      handle: fs.promises.FileHandle | null
      tail: Promise<void>
      closing: boolean
      error: Error | null
    }
    const streams = new Map<number, FileStreamEntry>()
    const openingStreams = new Set<number>()
    let wsClosed = false

    const sendJson = (payload: Record<string, unknown>): void => {
      if (wsClosed || ws.readyState !== WebSocket.OPEN) return
      try {
        ws.send(JSON.stringify(payload))
      } catch {
        /* ignore send failure on closing socket */
      }
    }

    const closeStream = async (
      streamId: number
    ): Promise<{ fileSize: number; error: Error | null }> => {
      const entry = streams.get(streamId)
      if (!entry) return { fileSize: 0, error: null }
      streams.delete(streamId)
      entry.closing = true
      await entry.tail.catch(() => {})
      if (entry.handle) {
        await entry.handle.close().catch(() => {})
        entry.handle = null
      }
      if (entry.error) {
        return { fileSize: 0, error: entry.error }
      }
      try {
        return { fileSize: fs.statSync(entry.filePath).size, error: null }
      } catch {
        return { fileSize: 0, error: null }
      }
    }

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data as ArrayBuffer)
        if (buf.length < 16) return
        const streamId = buf.readUInt32LE(0)
        const kind = buf.readUInt8(4)
        const offsetBig = buf.readBigUInt64LE(8)
        if (kind !== 1) return
        const entry = streams.get(streamId)
        if (!entry || entry.closing || entry.error) return
        const payload = buf.subarray(16)
        const pos = offsetBig === 0xffff_ffff_ffff_ffffn ? null : Number(offsetBig)
        entry.tail = entry.tail.then(async () => {
          if (!entry.handle || entry.error) return
          try {
            await entry.handle.write(payload, 0, payload.length, pos)
          } catch (err) {
            const wrapped = err instanceof Error ? err : new Error(String(err))
            entry.error = wrapped
            sendJson({ ok: false, op: 'async-error', streamId, error: wrapped.message })
          }
        })
        return
      }

      void (async () => {
        try {
          const msg = JSON.parse(data.toString()) as {
            op?: string
            streamId?: number
            path?: string
            truncate?: boolean
          }
          if (msg.op === 'ping') {
            sendJson({ ok: true, op: 'pong' })
            return
          }
          const streamId = Number(msg.streamId)
          if (!Number.isInteger(streamId) || streamId <= 0) {
            sendJson({ ok: false, op: 'error', error: 'Invalid streamId' })
            return
          }
          if (msg.op === 'open-file') {
            if (streams.has(streamId) || openingStreams.has(streamId)) {
              sendJson({ ok: false, op: 'error', streamId, error: 'Duplicate streamId' })
              return
            }
            const safePath = this.resolveContainedTempPath(msg.path || '')
            if (!safePath) {
              sendJson({ ok: false, op: 'error', streamId, error: 'Path outside tmpdir' })
              return
            }
            openingStreams.add(streamId)
            let handle: fs.promises.FileHandle | null = null
            try {
              await fs.promises.mkdir(path.dirname(safePath), { recursive: true })
              if (wsClosed || ws.readyState !== WebSocket.OPEN) {
                return
              }
              handle = await fs.promises.open(safePath, msg.truncate !== false ? 'w+' : 'r+')
              if (wsClosed || ws.readyState !== WebSocket.OPEN) {
                await handle.close().catch(() => {})
                handle = null
                return
              }
              streams.set(streamId, {
                filePath: safePath,
                handle,
                tail: Promise.resolve(),
                closing: false,
                error: null
              })
              handle = null
              sendJson({ ok: true, op: 'ack', streamId })
            } finally {
              openingStreams.delete(streamId)
              if (handle) {
                await handle.close().catch(() => {})
              }
            }
            return
          }
          if (msg.op === 'close') {
            const { fileSize, error } = await closeStream(streamId)
            if (error) {
              sendJson({ ok: false, op: 'error', streamId, error: error.message })
              return
            }
            sendJson({ ok: true, op: 'closed', streamId, fileSize })
            return
          }
          if (msg.op === 'abort') {
            await closeStream(streamId)
            sendJson({ ok: true, op: 'aborted', streamId })
            return
          }
        } catch (err) {
          sendJson({
            ok: false,
            op: 'error',
            error: err instanceof Error ? err.message : String(err)
          })
        }
      })()
    })

    ws.on('close', () => {
      wsClosed = true
      this.binarySockets.delete(ws)
      for (const streamId of Array.from(streams.keys())) {
        void closeStream(streamId)
      }
    })
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
    for (const sock of this.binarySockets) {
      try {
        sock.close()
      } catch {
        // ignore
      }
    }
    this.binarySockets.clear()
  }
}
