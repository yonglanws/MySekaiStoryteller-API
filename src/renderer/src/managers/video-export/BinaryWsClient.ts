export const nativeSetTimeout: typeof setTimeout = globalThis.setTimeout.bind(globalThis)
export const nativeClearTimeout: typeof clearTimeout = globalThis.clearTimeout.bind(globalThis)

export const BINARY_WS_HEADER_BYTES = 16
export const BINARY_WS_KIND_WRITE_FILE_AT = 1
export const BINARY_WS_KIND_PIPE_FRAME = 2
export const BINARY_WS_KIND_REPEAT_FRAME = 3

export const DEFAULT_BINARY_WS_HIGH_WATER_BYTES = 32 * 1024 * 1024
export const DEFAULT_BINARY_WS_LOW_WATER_BYTES = 16 * 1024 * 1024

export interface BinaryStreamVideoConfig {
  encoder?: string
  codec?: string
  crf?: number
}

export interface BinaryStreamEndpointInfo {
  ok?: boolean
  backend?: 'rust' | 'node' | string
  wsUrl?: string
  token?: string
  videoConfig?: BinaryStreamVideoConfig
}

export interface BinaryControlReply {
  ok?: boolean
  error?: string
  op?: string
  streamId?: number
  fileSize?: number
  frames?: number
  dedupedFrames?: number
  encoder?: string
  elapsedMs?: number
}

export interface BinaryWsConnectOptions {
  onAsyncError?: (err: Error) => void
  onClose?: (unexpected: boolean) => void
  highWaterBytes?: number
  lowWaterBytes?: number
  connectTimeoutMs?: number
}

export interface WaitBufferReadyOptions {
  isCancelled?: () => boolean
  highWaterBytes?: number
  lowWaterBytes?: number
  pollMs?: number
  onHighWater?: (bufferedBytes: number) => void
}

function wsOpenReadyState(): number {
  return typeof WebSocket !== 'undefined' && typeof WebSocket.OPEN === 'number' ? WebSocket.OPEN : 1
}

/**
 * 写入 16 字节小端二进制帧头（与 Rust `/bridge/rs-stream` 及 Node `/bridge/ws-bin` 协议一致）：
 * - [0..4)  streamId: u32 LE
 * - [4]     kind: u8 (1=WRITE_FILE_AT, 2=PIPE_FRAME, 3=REPEAT_FRAME)
 * - [5]     flags: u8
 * - [6..8)  reserved: u16 LE (0)
 * - [8..16) offsetOrCount: u64 LE
 */
export function writeBinaryHeader(
  buf: Uint8Array,
  streamId: number,
  kind: number,
  offsetOrCount: number | bigint,
  flags = 0
): void {
  const dv = new DataView(buf.buffer, buf.byteOffset, BINARY_WS_HEADER_BYTES)
  dv.setUint32(0, streamId, true)
  dv.setUint8(4, kind)
  dv.setUint8(5, flags)
  dv.setUint16(6, 0, true)
  dv.setBigUint64(
    8,
    typeof offsetOrCount === 'bigint' ? offsetOrCount : BigInt(offsetOrCount),
    true
  )
}

/**
 * 查询宿主 `/bridge/binary-stream-endpoint`，在非 HTTP 环境或接口不可用时返回 null。
 */
export async function fetchBinaryStreamEndpoint(): Promise<BinaryStreamEndpointInfo | null> {
  if (
    typeof window === 'undefined' ||
    typeof WebSocket === 'undefined' ||
    typeof fetch !== 'function' ||
    typeof location === 'undefined' ||
    !location.protocol.startsWith('http')
  ) {
    return null
  }
  try {
    const token = new URLSearchParams(location.search).get('token') || ''
    const headers: Record<string, string> = token ? { 'x-mss-bridge-token': token } : {}
    const infoRes = await fetch('/bridge/binary-stream-endpoint', { headers })
    if (!infoRes.ok) return null
    const info = (await infoRes.json()) as BinaryStreamEndpointInfo
    if (!info?.ok || !info.wsUrl) return null
    return info
  } catch {
    return null
  }
}

/**
 * 共享二进制 WebSocket 客户端：
 * - 所有定时器均使用模块加载期捕获的 `nativeSetTimeout` / `nativeClearTimeout`，
 *   避免在 `VirtualClockController` 假时钟下发生永久死锁；
 * - 统一封装控制消息 ACK 超时与 `bufferedAmount` 高/低水位背压节流。
 */
export class BinaryWsClient {
  private ws: WebSocket | null
  private closingIntentionally = false
  private closed = false
  private asyncError: Error | null = null
  private readonly ctrlResolvers: Array<(msg: BinaryControlReply) => void> = []
  private readonly highWaterBytes: number
  private readonly lowWaterBytes: number

  private constructor(ws: WebSocket, opts: BinaryWsConnectOptions) {
    this.ws = ws
    this.highWaterBytes = opts.highWaterBytes ?? DEFAULT_BINARY_WS_HIGH_WATER_BYTES
    this.lowWaterBytes = opts.lowWaterBytes ?? DEFAULT_BINARY_WS_LOW_WATER_BYTES

    const reportAsyncError = (err: Error): void => {
      if (!this.asyncError) {
        this.asyncError = err
      }
      opts.onAsyncError?.(this.asyncError)
    }

    ws.addEventListener('message', (ev) => {
      try {
        const parsed = JSON.parse(String(ev.data)) as BinaryControlReply
        if (
          parsed.op === 'async-error' ||
          (parsed.ok === false && this.ctrlResolvers.length === 0)
        ) {
          if (!this.closingIntentionally && !this.closed) {
            reportAsyncError(new Error(parsed.error || 'Binary WS async write error'))
          }
          return
        }
        const resolver = this.ctrlResolvers.shift()
        resolver?.(parsed)
      } catch {
        // ignore malformed ctrl reply
      }
    })

    ws.addEventListener('error', () => {
      if (!this.closingIntentionally && !this.closed) {
        reportAsyncError(new Error('Binary WS transport error'))
      }
    })

    ws.addEventListener('close', () => {
      const unexpected = !this.closingIntentionally && !this.closed
      this.closed = true
      this.ws = null
      while (this.ctrlResolvers.length > 0) {
        const resolver = this.ctrlResolvers.shift()
        resolver?.({ ok: false, error: 'Binary WS closed unexpectedly' })
      }
      if (unexpected) {
        reportAsyncError(new Error('Binary WS closed unexpectedly during export'))
      }
      opts.onClose?.(unexpected)
    })
  }

  static async connect(wsUrl: string, opts: BinaryWsConnectOptions = {}): Promise<BinaryWsClient> {
    if (typeof WebSocket === 'undefined') {
      throw new Error('WebSocket is unavailable')
    }
    const fullWsUrl = wsUrl.startsWith('/')
      ? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${wsUrl}`
      : wsUrl
    const ws = new WebSocket(fullWsUrl)
    ws.binaryType = 'arraybuffer'
    const connectTimeoutMs = opts.connectTimeoutMs ?? 10_000

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timer =
        connectTimeoutMs > 0
          ? nativeSetTimeout(() => {
              if (settled) return
              settled = true
              cleanup()
              try {
                ws.close()
              } catch {
                /* ignore */
              }
              reject(new Error('Binary WS handshake timeout'))
            }, connectTimeoutMs)
          : null

      const cleanup = (): void => {
        if (timer !== null) nativeClearTimeout(timer)
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onErr)
        ws.removeEventListener('close', onClose)
      }
      const onOpen = (): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }
      const onErr = (): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error('Binary WS connection error'))
      }
      const onClose = (): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error('Binary WS closed during handshake'))
      }
      ws.addEventListener('open', onOpen)
      ws.addEventListener('error', onErr)
      ws.addEventListener('close', onClose)
    })

    return new BinaryWsClient(ws, opts)
  }

  get isOpen(): boolean {
    return Boolean(this.ws && !this.closed && this.ws.readyState === wsOpenReadyState())
  }

  get bufferedAmount(): number {
    return this.ws && typeof this.ws.bufferedAmount === 'number' ? this.ws.bufferedAmount : 0
  }

  get lastError(): Error | null {
    return this.asyncError
  }

  sendControl(payload: Record<string, unknown>, timeoutMs = 15_000): Promise<BinaryControlReply> {
    const ws = this.ws
    if (!ws || this.closed || ws.readyState !== wsOpenReadyState()) {
      return Promise.resolve({ ok: false, error: 'Binary WS not open' })
    }
    return new Promise((resolve) => {
      const done = (msg: BinaryControlReply): void => {
        nativeClearTimeout(timer)
        resolve(msg)
      }
      const timer = nativeSetTimeout(() => {
        const idx = this.ctrlResolvers.indexOf(done)
        if (idx >= 0) this.ctrlResolvers.splice(idx, 1)
        resolve({ ok: false, error: 'Binary WS control ack timeout' })
      }, timeoutMs)
      this.ctrlResolvers.push(done)
      try {
        ws.send(JSON.stringify(payload))
      } catch (err) {
        const idx = this.ctrlResolvers.indexOf(done)
        if (idx >= 0) this.ctrlResolvers.splice(idx, 1)
        nativeClearTimeout(timer)
        resolve({
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    })
  }

  sendBinary(packet: Uint8Array): void {
    const ws = this.ws
    if (!ws || this.closed || ws.readyState !== wsOpenReadyState()) {
      throw this.asyncError ?? new Error('Binary WS not open')
    }
    ws.send(packet)
  }

  async waitBufferReady(opts: WaitBufferReadyOptions = {}): Promise<void> {
    if (this.asyncError) throw this.asyncError
    if (!this.isOpen) return
    const highWater = opts.highWaterBytes ?? this.highWaterBytes
    const lowWater = opts.lowWaterBytes ?? this.lowWaterBytes
    const pollMs = opts.pollMs ?? 8
    if (this.bufferedAmount > highWater) {
      opts.onHighWater?.(this.bufferedAmount)
      while (
        !opts.isCancelled?.() &&
        !this.asyncError &&
        this.isOpen &&
        this.bufferedAmount > lowWater
      ) {
        await new Promise<void>((resolve) => nativeSetTimeout(resolve, pollMs))
      }
      if (this.asyncError) throw this.asyncError
    }
  }

  sendAbort(streamId: number): void {
    const ws = this.ws
    if (!ws || this.closed || ws.readyState !== wsOpenReadyState()) return
    try {
      ws.send(JSON.stringify({ op: 'abort', streamId }))
    } catch {
      /* ignore */
    }
  }

  close(): void {
    const ws = this.ws
    this.ws = null
    this.closingIntentionally = true
    this.closed = true
    while (this.ctrlResolvers.length > 0) {
      const resolver = this.ctrlResolvers.shift()
      resolver?.({ ok: false, error: 'Binary WS closed' })
    }
    if (ws) {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  }
}
