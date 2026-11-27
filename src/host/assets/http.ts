import fs from 'node:fs'
import path from 'node:path'

/** Moesekai 资源下载共用的 HTTP/落盘工具。 */

export const ASSET_USER_AGENT = 'MySekaiStoryteller-API/1.0 (moesekai asset fetcher)'
export const CANONICAL_ASSET_ORIGINS = [
  'https://storage.pjsk.moe',
  'https://storage.exmeaning.com'
] as const
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
const DEFAULT_BODY_STALL_TIMEOUT_MS = 20_000
const DEFAULT_RETRY_DELAY_MS = 500
const CANONICAL_ORIGIN_PREF_TTL_MS = 10 * 60_000
const CANONICAL_ORIGIN_FAIL_TTL_MS = 5 * 60_000
let atomicWriteSeq = 0
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let preferredCanonicalOrigin: { origin: string; until: number } | null = null
const failedCanonicalOrigins = new Map<string, number>()

function extractCanonicalOrigin(urlOrOrigin: string): string | null {
  const trimmed = urlOrOrigin.trim()
  if (!trimmed) return null
  try {
    const origin = new URL(trimmed).origin
    return (CANONICAL_ASSET_ORIGINS as readonly string[]).includes(origin) ? origin : null
  } catch {
    return null
  }
}

export function isCanonicalAssetOrigin(urlOrOrigin: string): boolean {
  return extractCanonicalOrigin(urlOrOrigin) !== null
}

/**
 * 判断错误是否更可能源于镜像站不可用/网络卡死（超时、断流、5xx/429 等），
 * 而非正常的 404 路径不存在。
 */
export function isLikelyOriginFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (/:\s*HTTP\s+4(?:00|01|03|04|05|10|22)\b/.test(message)) {
    return false
  }
  return true
}

/** 将某个 canonical 镜像标记为健康并置顶（共享给 Live2D 与背景/BGM/SE 链路）。 */
export function markCanonicalOriginHealthy(urlOrOrigin: string): void {
  const origin = extractCanonicalOrigin(urlOrOrigin)
  if (!origin) return
  failedCanonicalOrigins.delete(origin)
  preferredCanonicalOrigin = { origin, until: Date.now() + CANONICAL_ORIGIN_PREF_TTL_MS }
}

/** 将某个 canonical 镜像标记为近期异常并降权，使后续请求优先走健康镜像。 */
export function markCanonicalOriginFailed(urlOrOrigin: string): void {
  const origin = extractCanonicalOrigin(urlOrOrigin)
  if (!origin) return
  failedCanonicalOrigins.set(origin, Date.now() + CANONICAL_ORIGIN_FAIL_TTL_MS)
  if (preferredCanonicalOrigin?.origin === origin) {
    preferredCanonicalOrigin = null
  }
}

/** 重置共享 canonical 镜像健康状态（单测用）。 */
export function resetCanonicalOriginPreference(): void {
  preferredCanonicalOrigin = null
  failedCanonicalOrigins.clear()
}

/**
 * 按近期健康状态对候选 origin / URL 排序：
 * 健康置顶镜像（10 分钟内）排最前，近期失败镜像（5 分钟内）排最后，其余保持原序。
 */
export function orderCanonicalOrigins(candidates: readonly string[]): string[] {
  const unique: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (!seen.has(candidate)) {
      seen.add(candidate)
      unique.push(candidate)
    }
  }
  if (unique.length <= 1) return unique

  const now = Date.now()
  if (preferredCanonicalOrigin && now > preferredCanonicalOrigin.until) {
    preferredCanonicalOrigin = null
  }
  for (const [origin, until] of failedCanonicalOrigins) {
    if (now > until) failedCanonicalOrigins.delete(origin)
  }

  const rankOf = (candidate: string): number => {
    const origin = extractCanonicalOrigin(candidate)
    if (!origin) return 1
    if (
      preferredCanonicalOrigin &&
      origin === preferredCanonicalOrigin.origin &&
      !failedCanonicalOrigins.has(origin)
    ) {
      return 0
    }
    if (failedCanonicalOrigins.has(origin)) return 2
    return 1
  }

  return unique
    .map((candidate, index) => ({ candidate, index, rank: rankOf(candidate) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((item) => item.candidate)
}

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
  /** 等待响应头（TTFB）的超时（毫秒）；未设置时默认 min(timeoutMs, stallTimeoutMs ?? 20_000) */
  headerTimeoutMs?: number
  /** 流式读取响应体期间的单次空闲超时（毫秒）；未设置时默认 min(timeoutMs, 20_000) */
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
  const headerTimeoutMs = Math.max(
    1,
    Math.min(
      options.timeoutMs,
      options.headerTimeoutMs ?? options.stallTimeoutMs ?? DEFAULT_BODY_STALL_TIMEOUT_MS
    )
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
    const headerTimer = setTimeout(
      () => controller.abort(new Error(`response header timeout after ${headerTimeoutMs}ms`)),
      headerTimeoutMs
    )
    const onAbort = (): void => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await fetch(parsed, {
        headers: { 'user-agent': ASSET_USER_AGENT, accept: '*/*' },
        redirect: 'follow',
        signal: controller.signal
      })
      clearTimeout(headerTimer)
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
      clearTimeout(headerTimer)
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
    await sleep(retryBackoffMs(attempt, options.retryDelayMs))
  }

  throw lastError ?? new Error(`${url}: request failed`)
}

/**
 * 带响应头（TTFB）超时、完整响应体超时、流式卡死（stall）检测、Content-Length 截断校验与重试的二进制下载。
 * 解决 Node/undici 在等待响应头挂死、收到响应头后读取响应体时连接中断（`TypeError: terminated`）
 * 或 TCP 假死（无超时）导致下载长时间挂起/零重试的问题。
 */
export async function fetchBuffer(url: string, options: RequestOptions): Promise<Buffer> {
  const parsed = assertHttpUrl(url, 'fetchBuffer')
  const stallTimeoutMs = Math.max(
    1,
    Math.min(options.timeoutMs, options.stallTimeoutMs ?? DEFAULT_BODY_STALL_TIMEOUT_MS)
  )
  const headerTimeoutMs = Math.max(
    1,
    Math.min(
      options.timeoutMs,
      options.headerTimeoutMs ?? options.stallTimeoutMs ?? DEFAULT_BODY_STALL_TIMEOUT_MS
    )
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
    const headerTimer = setTimeout(
      () => controller.abort(new Error(`response header timeout after ${headerTimeoutMs}ms`)),
      headerTimeoutMs
    )
    const onAbort = (): void => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await fetch(parsed, {
        headers: { 'user-agent': ASSET_USER_AGENT, accept: '*/*' },
        redirect: 'follow',
        signal: controller.signal
      })
      clearTimeout(headerTimer)
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
      clearTimeout(headerTimer)
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
