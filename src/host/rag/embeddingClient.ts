import type { ILogObj, Logger } from 'tslog'
import type { LlmSettings, RagSettings } from '../config'
import { l2Normalize } from './vectorIndex'

export interface EmbeddingClientConfig {
  enabled: boolean
  baseUrl: string
  apiKeyEnv: string
  model: string
  dimensions: number
  queryInstruct: string
  timeoutMs: number
  batchSize: number
}

interface OpenAiEmbeddingResponse {
  data?: Array<{
    index?: number
    embedding?: number[]
  }>
  error?: { message?: string }
}

const QUERY_LRU_MAX = 256

/**
 * 合并 `llm.rag` 与 `llm` 的继承项：
 * `rag.baseUrl` / `rag.apiKeyEnv` 留空时自动复用 `llm.baseUrl` / `llm.apiKeyEnv`。
 */
export function resolveEmbeddingConfig(
  llm: Pick<LlmSettings, 'baseUrl' | 'apiKeyEnv' | 'rag'> | { baseUrl: string; apiKeyEnv: string; rag?: Partial<RagSettings> }
): EmbeddingClientConfig {
  const rag = llm.rag ?? {}
  const baseUrl = (rag.baseUrl?.trim() || llm.baseUrl || '').replace(/\/+$/, '')
  const apiKeyEnv = rag.apiKeyEnv?.trim() || llm.apiKeyEnv || 'MSS_LLM_API_KEY'
  return {
    enabled: rag.enabled !== false,
    baseUrl,
    apiKeyEnv,
    model: rag.model?.trim() || 'bge-m3',
    dimensions: typeof rag.dimensions === 'number' && rag.dimensions > 0 ? Math.floor(rag.dimensions) : 0,
    queryInstruct: rag.queryInstruct ?? '',
    timeoutMs: typeof rag.timeoutMs === 'number' && rag.timeoutMs > 0 ? rag.timeoutMs : 30_000,
    batchSize: typeof rag.batchSize === 'number' && rag.batchSize >= 1 ? Math.min(128, Math.floor(rag.batchSize)) : 32
  }
}

/**
 * OpenAI 兼容 `/embeddings` 客户端（默认 `bge-m3`，无原生依赖）。
 *
 * - 文档直接送原文；
 * - 查询仅在 `queryInstruct` 非空时拼接 `Instruct: ...\nQuery: ...`（`bge-m3` 默认空串不加前缀）；
 * - 所有输出向量自动 L2 归一化为 `Float32Array`，可直接做余弦点积或 SQ8 量化；
 * - 内置查询 LRU 缓存，避免同一次生成或相邻请求重复嵌入相同查询。
 */
export class EmbeddingClient {
  readonly config: EmbeddingClientConfig
  private readonly logger?: Pick<Logger<ILogObj>, 'info' | 'warn' | 'debug'>
  private readonly queryCache = new Map<string, Float32Array>()

  constructor(
    config: EmbeddingClientConfig,
    logger?: Pick<Logger<ILogObj>, 'info' | 'warn' | 'debug'>
  ) {
    this.config = config
    this.logger = logger
  }

  get enabled(): boolean {
    return this.config.enabled && Boolean(this.config.baseUrl) && Boolean(this.config.model)
  }

  get model(): string {
    return this.config.model
  }

  private apiKey(): string {
    return (process.env[this.config.apiKeyEnv] ?? '').trim()
  }

  formatQuery(query: string): string {
    const clean = query.trim()
    const instruct = this.config.queryInstruct.trim()
    if (!instruct) return clean
    return `Instruct: ${instruct}\nQuery: ${clean}`
  }

  async embedDocuments(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    const results: Float32Array[] = new Array(texts.length)
    const batchSize = this.config.batchSize
    for (let offset = 0; offset < texts.length; offset += batchSize) {
      const slice = texts.slice(offset, offset + batchSize)
      const vectors = await this.requestEmbeddings(slice, signal)
      for (let i = 0; i < vectors.length; i++) {
        results[offset + i] = vectors[i]
      }
    }
    return results
  }

  async embedQueries(queries: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (queries.length === 0) return []
    const formatted = queries.map((q) => this.formatQuery(q))
    const results: Float32Array[] = new Array(formatted.length)
    const missingIdx: number[] = []
    const missingTexts: string[] = []

    formatted.forEach((text, idx) => {
      const key = `${this.config.model}:${this.config.dimensions}:${text}`
      const hit = this.queryCache.get(key)
      if (hit) {
        // 刷新 LRU 顺序
        this.queryCache.delete(key)
        this.queryCache.set(key, hit)
        results[idx] = hit
      } else {
        missingIdx.push(idx)
        missingTexts.push(text)
      }
    })

    if (missingTexts.length > 0) {
      const fetched = await this.embedDocuments(missingTexts, signal)
      for (let i = 0; i < missingIdx.length; i++) {
        const idx = missingIdx[i]
        const vec = fetched[i]
        results[idx] = vec
        const key = `${this.config.model}:${this.config.dimensions}:${formatted[idx]}`
        if (this.queryCache.size >= QUERY_LRU_MAX) {
          const oldest = this.queryCache.keys().next().value
          if (oldest !== undefined) this.queryCache.delete(oldest)
        }
        this.queryCache.set(key, vec)
      }
    }
    return results
  }

  private async requestEmbeddings(inputs: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (!this.enabled) {
      throw new Error('EmbeddingClient is disabled or missing baseUrl/model')
    }
    const url = `${this.config.baseUrl}/embeddings`
    const payload: Record<string, unknown> = {
      model: this.config.model,
      input: inputs,
      encoding_format: 'float'
    }
    if (this.config.dimensions > 0) {
      payload.dimensions = this.config.dimensions
    }

    const headers: Record<string, string> = { 'content-type': 'application/json' }
    const key = this.apiKey()
    if (key) headers.authorization = `Bearer ${key}`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)
    const onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      })
      if (!response.ok) {
        const errText = await response.text().catch(() => '')
        throw new Error(`Embedding HTTP ${response.status}: ${errText.slice(0, 200)}`)
      }
      const json = (await response.json()) as OpenAiEmbeddingResponse
      if (!Array.isArray(json.data) || json.data.length !== inputs.length) {
        throw new Error(
          `Embedding response size mismatch: expected ${inputs.length}, got ${json.data?.length ?? 0}`
        )
      }
      const ordered = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      return ordered.map((item, idx) => {
        if (!Array.isArray(item.embedding) || item.embedding.length === 0) {
          throw new Error(`Embedding vector[${idx}] is empty`)
        }
        return l2Normalize(Float32Array.from(item.embedding))
      })
    } catch (error) {
      this.logger?.debug?.(
        `[RAG] Embedding request failed (${this.config.model}): ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}
