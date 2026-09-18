/**
 * 浏览器端桥接层：在普通网页环境中实现与 Electron preload 相同形状的
 * window.electron.ipcRenderer / window.api 接口。
 *
 * - invoke  → POST /bridge/invoke/:channel        （JSON 请求/响应）
 * - invoke（二进制通道）→ POST /bridge/bin/:channel （裸二进制 body，其余参数走 query）
 * - tts/translation 代理 → POST /bridge/proxy/*    （JSON 请求，tts 为二进制响应）
 * - send/on → WebSocket /bridge/ws                （api:start-export 下行、export-result/on-error 上行）
 *
 * 通道语义与原 src/main/handlers/IpcHandler.ts 严格对齐（返回值形状、错误行为）。
 */

type IpcListener = (event: unknown, ...args: unknown[]) => void

const JSON_INVOKE_CHANNELS = new Set([
  'electron:get-temp-dir',
  'electron:get-temp-base-dir',
  'electron:api-export-video-from-files',
  'electron:api-remux-video-from-files',
  'electron:api-encode-frames-video'
])

const BINARY_INVOKE_CHANNELS = new Set([
  'electron:append-to-file',
  'electron:write-file-at',
  'electron:write-frame',
  'electron:write-frame-batch',
  'electron:write-temp-file'
])

function encodeChannel(channel: string): string {
  return encodeURIComponent(channel)
}

async function invokeJson(channel: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`/bridge/invoke/${encodeChannel(channel)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args)
  })
  const data = (await res.json()) as { ok: boolean; result?: unknown; error?: string }
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `Bridge invoke failed: ${channel} (HTTP ${res.status})`)
  }
  return data.result
}

function extractBinary(args: unknown[]): {
  meta: unknown[]
  binary: ArrayBuffer | Uint8Array | null
} {
  let binary: ArrayBuffer | Uint8Array | null = null
  const meta = args.map((arg) => {
    if (arg instanceof ArrayBuffer) {
      binary = arg
      return null
    }
    if (arg instanceof Uint8Array) {
      binary = arg
      return null
    }
    // 二进制也可能嵌在 payload 对象内（如 {filePath, data: ArrayBuffer}）
    if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
      const record = arg as Record<string, unknown>
      for (const key of Object.keys(record)) {
        const value = record[key]
        if (value instanceof ArrayBuffer || value instanceof Uint8Array) {
          binary = value
          return { ...record, [key]: null }
        }
      }
    }
    return arg
  })
  return { meta, binary }
}

async function invokeBinary(channel: string, args: unknown[]): Promise<unknown> {
  const { meta, binary } = extractBinary(args)

  if (binary === null) {
    return invokeJson(channel, args)
  }

  const metaParam = encodeURIComponent(JSON.stringify(meta))
  const body: ArrayBuffer =
    binary instanceof Uint8Array ? (binary.slice().buffer as ArrayBuffer) : binary
  const res = await fetch(`/bridge/bin/${encodeChannel(channel)}?args=${metaParam}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body
  })
  const data = (await res.json()) as { ok: boolean; result?: unknown; error?: string }
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `Bridge binary invoke failed: ${channel} (HTTP ${res.status})`)
  }
  return data.result
}

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  if (channel === 'electron:tts-fetch') {
    return proxyFetch('/bridge/proxy/tts-fetch', args[0], 'arrayBuffer')
  }
  if (channel === 'electron:translation-fetch') {
    return proxyFetch('/bridge/proxy/translation-fetch', args[0], 'text')
  }
  if (BINARY_INVOKE_CHANNELS.has(channel) || JSON_INVOKE_CHANNELS.has(channel)) {
    return invokeBinaryOrJson(channel, args)
  }
  // 未知通道：明确报错，便于发现遗漏
  throw new Error(`Unsupported bridge channel: ${channel}`)
}

async function invokeBinaryOrJson(channel: string, args: unknown[]): Promise<unknown> {
  if (BINARY_INVOKE_CHANNELS.has(channel)) {
    return invokeBinary(channel, args)
  }
  return invokeJson(channel, args)
}

async function proxyFetch(
  path: string,
  payload: unknown,
  responseType: 'arrayBuffer' | 'text'
): Promise<{ status: number; body: ArrayBuffer | string; ok: boolean }> {
  try {
    const { url, method, headers, body } = payload as {
      url: string
      method: string
      headers: Record<string, string>
      body: string
    }
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, method, headers, body })
    })
    const status = Number(res.headers.get('x-mss-status') ?? res.status)
    const ok = res.headers.get('x-mss-ok') === '1'
    if (responseType === 'arrayBuffer') {
      return { status, body: await res.arrayBuffer(), ok }
    }
    return { status, body: await res.text(), ok }
  } catch {
    return responseType === 'arrayBuffer'
      ? { status: 0, body: new ArrayBuffer(0), ok: false }
      : { status: 0, body: '{}', ok: false }
  }
}

// ---------------------------------------------------------------------------
// WebSocket 事件通道
// ---------------------------------------------------------------------------

const listeners = new Map<string, Set<IpcListener>>()
let ws: WebSocket | null = null
let wsClosed = false

function wsSend(message: { type: string; args: unknown[] }): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message))
  }
}

function connectWs(): Promise<void> {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    // 渲染池通过页面 URL 的 ?worker=<id> 标识工作进程，需透传给 WS
    const workerParam = new URLSearchParams(location.search).get('worker')
    const workerQuery = workerParam ? `?worker=${encodeURIComponent(workerParam)}` : ''
    const socket = new WebSocket(`${proto}//${location.host}/bridge/ws${workerQuery}`)

    socket.onopen = () => {
      ws = socket
      resolve()
    }

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string) as { type: string; args: unknown[] }
        const set = listeners.get(message.type)
        if (set) {
          for (const listener of set) {
            listener(null, ...message.args)
          }
        }
      } catch (err) {
        console.error('[bridge] Failed to parse ws message', err)
      }
    }

    socket.onclose = () => {
      if (ws === socket) {
        ws = null
      }
      // 页面由宿主管理生命周期；异常断开时退避重连
      if (!wsClosed) {
        setTimeout(() => void connectWs().catch(() => undefined), 2000)
      }
    }

    socket.onerror = () => {
      if (ws !== socket) {
        reject(new Error('Bridge WebSocket connection failed'))
      }
    }
  })
}

function on(channel: string, listener: IpcListener): void {
  let set = listeners.get(channel)
  if (!set) {
    set = new Set()
    listeners.set(channel, set)
  }
  set.add(listener)
}

function send(channel: string, ...args: unknown[]): void {
  wsSend({ type: channel, args })
}

// ---------------------------------------------------------------------------
// 接口安装
// ---------------------------------------------------------------------------

export function installBrowserBridge(): Promise<void> {
  ;(globalThis as unknown as Record<string, unknown>).__apiOnlyMode = true
  ;(globalThis as unknown as Record<string, unknown>).__hostMode = 'web'
  ;(window as unknown as Record<string, unknown>).electron = {
    ipcRenderer: {
      invoke,
      send,
      on,
      once: (channel: string, listener: IpcListener): void => {
        const wrapped: IpcListener = (event, ...args) => {
          listeners.get(channel)?.delete(wrapped)
          listener(event, ...args)
        }
        on(channel, wrapped)
      },
      removeAllListeners: (channel: string): void => {
        listeners.delete(channel)
      }
    },
    webFrame: {},
    process: { platform: navigator.platform, versions: {} }
  }
  ;(window as unknown as Record<string, unknown>).api = {
    getFolder: (filePath: string): string => {
      const normalized = filePath.replace(/\\/g, '/')
      const idx = normalized.lastIndexOf('/')
      return idx > 0 ? normalized.slice(0, idx) : normalized
    }
  }

  wsClosed = false
  return connectWs()
}

export function closeBridge(): void {
  wsClosed = true
  ws?.close()
  ws = null
}
