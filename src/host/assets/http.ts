import fs from 'node:fs'
import path from 'node:path'

/** Moesekai 资源下载共用的 HTTP/落盘工具。 */

export const ASSET_USER_AGENT = 'MySekaiStoryteller-API/1.0 (moesekai asset fetcher)'
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
const DEFAULT_BODY_STALL_TIMEOUT_MS = 30_000
const DEFAULT_RETRY_DELAY_MS = 500
let atomicWriteSeq = 0
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function withSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

export function assertHttpUrl(raw: string, what: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${what}: invalid URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${what}: only http and https are allowed: ${raw}`)
  }
  if (url.username || url.password) {
    throw new Error(`${what}: credentials in URL are not allowed: ${raw}`)
  }
  return url
}

/** 把相对路径逐段编码后拼到 base 下；base 可以没有结尾斜杠。 */
export function assetUrl(base: string, rel: string): string {
  const encoded = rel
    .split('/')
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join('/')
  return new URL(encoded, withSlash(base)).href
}

const ensuredDirs = new Map<string, Promise<void>>()
const MAX_ENSURED_DIRS = 4096

async function ensureDirCached(dir: string): Promise<void> {
  const existing = ensuredDirs.get(dir)
  if (existing) {
    await existing
    return
  }
  if (ensuredDirs.size >= MAX_ENSURED_DIRS) {
    ensuredDirs.clear()
  }
  const task = fs.promises.mkdir(dir, { recursive: true }).then(() => undefined)
  ensuredDirs.set(dir, task)
  try {
    await task
  } catch (error) {
    ensuredDirs.delete(dir)
    throw error
  }
}

export function atomicWrite(file: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.${++atomicWriteSeq}.tmp`
  try {
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, file)
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // ignore cleanup errors
    }
    throw error
  }
}

/**
 * 面向大量独立小文件（如单个 `.sse-motion.json` / `.motion3.json` 片段）的异步快写：
 * 缓存目录创建并跳过临时文件 + rename，显著减少 NAS 小文件元数据时延且不阻塞事件循环。
 * 关键索引/清单（`model3.json`、`catalog.json`、`.moc3` 等）仍应使用 `atomicWrite`。
 */
export async function writeFileFastAsync(file: string, data: Buffer | string): Promise<void> {
  const dir = path.dirname(file)
  await ensureDirCached(dir)
  try {
    await fs.promises.writeFile(file, data)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      ensuredDirs.delete(dir)
      await ensureDirCached(dir)
      await fs.promises.writeFile(file, data)
      return
    }
    throw error
  }
}

export interface RequestOptions {
  timeoutMs: number
  retries: number
  /** 流式读取响应体期间的单次空闲超时（毫秒）；未设置时默认 min(timeoutMs, 30_000) */
  stallTimeoutMs?: number
  /** 重试退避基数（毫秒，默认 500；主要用于单测加速） */
  retryDelayMs?: number
  signal?: AbortSignal
}

class NonRetryableHttpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NonRetryableHttpError'
  }
}

function errorFromReason(reason: unknown, fallback: string): Error {
  if (reason instanceof Error) return reason
  if (reason === undefined || reason === null) return new Error(fallback)
  return new Error(String(reason))
}

function retryBackoffMs(attempt: number, baseMs?: number): number {
  const base = Math.max(0, baseMs ?? DEFAULT_RETRY_DELAY_MS)
  if (base === 0) return 0
  return base * 2 ** attempt + Math.random() * Math.min(250, base)
}

async function readResponseBuffer(
  response: Response,
  controller: AbortController,
  stallTimeoutMs: number
): Promise<Buffer> {
  const contentEncoding = response.headers.get('content-encoding')
  const contentLengthHeader = response.headers.get('content-length')
  const expectedLength =
    !contentEncoding && contentLengthHeader && /^\d+$/.test(contentLengthHeader.trim())
      ? Number(contentLengthHeader.trim())
      : null

  let buffer: Buffer
  const body = response.body
  if (!body || typeof body.getReader !== 'function') {
    buffer = Buffer.from(await response.arrayBuffer())
  } else {
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let totalBytes = 0
    let abortReason: Error | null = null
    let stallTimer: ReturnType<typeof setTimeout> | null = null

    const armStallTimer = (): void => {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        abortReason = new Error(`response body stalled after ${stallTimeoutMs}ms`)
        controller.abort(abortReason)
        void reader.cancel(abortReason).catch(() => undefined)
      }, stallTimeoutMs)
    }

    const onControllerAbort = (): void => {
      if (!abortReason) {
        abortReason = errorFromReason(controller.signal.reason, 'aborted')
      }
      void reader.cancel(abortReason).catch(() => undefined)
    }
    controller.signal.addEventListener('abort', onControllerAbort, { once: true })

    try {
      if (controller.signal.aborted) {
        throw errorFromReason(controller.signal.reason, 'aborted')
      }
      armStallTimer()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.byteLength > 0) {
          chunks.push(value)
          totalBytes += value.byteLength
          armStallTimer()
        }
      }
      if (abortReason) throw abortReason
      if (controller.signal.aborted) {
        throw errorFromReason(controller.signal.reason, 'aborted')
      }
    } finally {
      if (stallTimer) clearTimeout(stallTimer)
      controller.signal.removeEventListener('abort', onControllerAbort)
      try {
        reader.releaseLock()
      } catch {
        // ignore if already closed/cancelled
      }
    }
    buffer = Buffer.concat(chunks, totalBytes)
  }

  if (expectedLength !== null && buffer.byteLength < expectedLength) {
    throw new Error(
      `truncated response body: expected ${expectedLength} bytes, got ${buffer.byteLength}`
    )
  }
  return buffer
}

export async function request(url: string, options: RequestOptions): Promise<Response> {
  const parsed = assertHttpUrl(url, 'request')
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= options.retries; attempt++) {
    if (options.signal?.aborted) {
      throw errorFromReason(options.signal.reason, `${url}: aborted`)
    }
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error(`timeout after ${options.timeoutMs}ms`)),
      options.timeoutMs
    )
    const onAbort = (): void => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await fetch(parsed, {
        headers: { 'user-agent': ASSET_USER_AGENT, accept: '*/*' },
        redirect: 'follow',
        signal: controller.signal
      })
      if (response.ok) return response

      if (!RETRY_STATUS.has(response.status) || attempt >= options.retries) {
        throw new NonRetryableHttpError(`${url}: HTTP ${response.status} ${response.statusText}`)
      }
      await response.body?.cancel().catch(() => undefined)
      lastError = new Error(`${url}: HTTP ${response.status} ${response.statusText}`)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (error instanceof NonRetryableHttpError || options.signal?.aborted) throw lastError
      if (attempt >= options.retries) throw lastError
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
    await sleep(retryBackoffMs(attempt, options.retryDelayMs))
  }

  throw lastError ?? new Error(`${url}: request failed`)
}

/**
 * 带完整响应体超时、流式卡死（stall）检测、Content-Length 截断校验与重试的二进制下载。
 * 解决 Node/undici 在收到响应头后读取响应体时连接中断（`TypeError: terminated`）
 * 或 TCP 假死（无超时）导致下载无限挂起/零重试的问题。
 */
export async function fetchBuffer(url: string, options: RequestOptions): Promise<Buffer> {
  const parsed = assertHttpUrl(url, 'fetchBuffer')
  const stallTimeoutMs = Math.max(
    1,
    Math.min(options.timeoutMs, options.stallTimeoutMs ?? DEFAULT_BODY_STALL_TIMEOUT_MS)
  )
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= options.retries; attempt++) {
    if (options.signal?.aborted) {
      throw errorFromReason(options.signal.reason, `${url}: aborted`)
    }
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error(`timeout after ${options.timeoutMs}ms`)),
      options.timeoutMs
    )
    const onAbort = (): void => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await fetch(parsed, {
        headers: { 'user-agent': ASSET_USER_AGENT, accept: '*/*' },
        redirect: 'follow',
        signal: controller.signal
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        const httpError = new Error(`${url}: HTTP ${response.status} ${response.statusText}`)
        if (!RETRY_STATUS.has(response.status)) {
          throw new NonRetryableHttpError(httpError.message)
        }
        if (attempt >= options.retries) throw httpError
        lastError = httpError
      } else {
        return await readResponseBuffer(response, controller, stallTimeoutMs)
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (error instanceof NonRetryableHttpError || options.signal?.aborted) throw lastError
      if (attempt >= options.retries) throw lastError
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
    await sleep(retryBackoffMs(attempt, options.retryDelayMs))
  }

  throw lastError ?? new Error(`${url}: request failed`)
}

export async function fetchText(url: string, options: RequestOptions): Promise<string> {
  const buffer = await fetchBuffer(url, options)
  return buffer.toString('utf-8')
}

export async function fetchJson<T>(url: string, options: RequestOptions): Promise<T> {
  const text = await fetchText(url, options)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${url}: response is not JSON: ${text.slice(0, 200)}`)
  }
}
