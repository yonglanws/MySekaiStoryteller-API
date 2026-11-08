import fs from 'node:fs'
import path from 'node:path'

/** Moesekai 资源下载共用的 HTTP/落盘工具。 */

export const ASSET_USER_AGENT = 'MySekaiStoryteller-API/1.0 (moesekai asset fetcher)'
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
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

export function atomicWrite(file: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

export interface RequestOptions {
  timeoutMs: number
  retries: number
  signal?: AbortSignal
}

export async function request(url: string, options: RequestOptions): Promise<Response> {
  const parsed = assertHttpUrl(url, 'request')
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= options.retries; attempt++) {
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
        throw new Error(`${url}: HTTP ${response.status} ${response.statusText}`)
      }
      await response.body?.cancel().catch(() => undefined)
      lastError = new Error(`${url}: HTTP ${response.status} ${response.statusText}`)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (lastError.name === 'AbortError' || options.signal?.aborted) throw lastError
      if (attempt >= options.retries) throw lastError
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
    await sleep(500 * 2 ** attempt + Math.random() * 250)
  }

  throw lastError ?? new Error(`${url}: request failed`)
}

export async function fetchJson<T>(url: string, options: RequestOptions): Promise<T> {
  const response = await request(url, options)
  const text = await response.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${url}: response is not JSON: ${text.slice(0, 200)}`)
  }
}
