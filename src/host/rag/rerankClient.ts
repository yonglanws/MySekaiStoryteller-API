import type { ILogObj, Logger } from 'tslog'
import type { LlmSettings, RagRerankSettings, RagSettings } from '../config'

export const PJSK_DEFAULT_RERANK_INSTRUCTION =
  'Given a Project SEKAI story prompt, judge how relevant each official Project SEKAI dialogue or lore passage is for canon plot continuity, character voice, and relationships.'

export interface RerankClientConfig {
  enabled: boolean
  model: string
  baseUrl: string
  apiKeyEnv: string
  endpointPath: string
  candidatePool: number
  topN: number
  timeoutMs: number
  instruction: string
}

export interface RerankScoreItem {
  index: number
  score: number
  rawScore: number
}

export interface RerankResponseResult {
  items: RerankScoreItem[]
  latencyMs: number
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/**
 * 合并 `llm.rag.rerank` 与 `llm.rag` / `llm` 继承链：
 * `rerank.baseUrl || rag.baseUrl || llm.baseUrl`
 * `rerank.apiKeyEnv || rag.apiKeyEnv || llm.apiKeyEnv`
 */
export function resolveRerankConfig(
  llm:
    | Pick<LlmSettings, 'baseUrl' | 'apiKeyEnv' | 'rag'>
    | {
        baseUrl: string
        apiKeyEnv: string
        rag?: Partial<Omit<RagSettings, 'rerank'>> & { rerank?: Partial<RagRerankSettings> }
      }
): RerankClientConfig {
  const rag = llm.rag ?? {}
  const rerank = rag.rerank ?? {}
  const baseUrl = (rerank.baseUrl?.trim() || rag.baseUrl?.trim() || llm.baseUrl || '').replace(
    /\/+$/,
    ''
  )
  const apiKeyEnv =
    rerank.apiKeyEnv?.trim() || rag.apiKeyEnv?.trim() || llm.apiKeyEnv || 'MSS_LLM_API_KEY'
  const candidatePool =
    typeof rerank.candidatePool === 'number' && rerank.candidatePool >= 1
      ? Math.min(128, Math.floor(rerank.candidatePool))
      : 32
  const topN =
    typeof rerank.topN === 'number' && rerank.topN >= 1
      ? Math.min(128, Math.floor(rerank.topN))
      : candidatePool
  return {
    enabled: rag.enabled !== false && rerank.enabled !== false,
    model: rerank.model?.trim() || 'qwen3-reranker-8b',
    baseUrl,
    apiKeyEnv,
    endpointPath: rerank.endpointPath?.trim() || '/rerank',
    candidatePool,
    topN,
    timeoutMs:
      typeof rerank.timeoutMs === 'number' && rerank.timeoutMs > 0 ? rerank.timeoutMs : 30_000,
    instruction: rerank.instruction?.trim() || PJSK_DEFAULT_RERANK_INSTRUCTION
  }
}

/**
 * 重排分数校准：
 * - 若返回分数全部落在 `[0, 1]`（已概率校准，如 SiliconFlow / vLLM / Cohere / Jina），直接钳制 `[0, 1]`；
 * - 若存在 `< 0` 或 `> 1` 的原始 cross-encoder logit（如 TEI / 本地 vLLM 原始 logits），应用 sigmoid 映射。
 */
export function calibrateRerankScores(
  rawItems: Array<{ index: number; rawScore: number }>
): RerankScoreItem[] {
  const valid = rawItems.filter(
    (item) => Number.isInteger(item.index) && item.index >= 0 && Number.isFinite(item.rawScore)
  )
  if (valid.length === 0) return []

  const allProbability = valid.every((item) => item.rawScore >= 0 && item.rawScore <= 1)
  return valid.map((item) => ({
    index: item.index,
    rawScore: item.rawScore,
    score: allProbability
      ? clamp(item.rawScore, 0, 1)
      : clamp(1 / (1 + Math.exp(-item.rawScore)), 0, 1)
  }))
}

/**
 * 解析多厂商 `/rerank` 响应格式：`results[]`、`data[]`、`output.results[]`。
 */
export function parseRerankResponse(json: unknown): Array<{ index: number; rawScore: number }> {
  if (!json || typeof json !== 'object') return []
  const obj = json as Record<string, unknown>
  const output =
    obj.output && typeof obj.output === 'object' ? (obj.output as Record<string, unknown>) : null
  const rows = Array.isArray(obj.results)
    ? obj.results
    : Array.isArray(obj.data)
      ? obj.data
      : Array.isArray(output?.results)
        ? output.results
        : []

  const parsed: Array<{ index: number; rawScore: number }> = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row || typeof row !== 'object') continue
    const rec = row as Record<string, unknown>
    const idx = Number(rec.index ?? i)
    const rawScore = Number(rec.relevance_score ?? rec.score ?? rec.logit)
    if (Number.isInteger(idx) && idx >= 0 && Number.isFinite(rawScore)) {
      parsed.push({ index: idx, rawScore })
    }
  }
  return parsed
}

/**
 * `qwen3-reranker-8b` Cross-Encoder 重排客户端：
 * - 支持多厂商 `/rerank` 响应解析；
 * - 若服务端因不识别 `instruction` 字段返回 HTTP 400/422，自动降级为把 `Instruct: ...\nQuery: ...` 拼入 `query` 重试一次；
 * - 408/429/5xx 重试 1 次；任何故障返回 `null` 由调用方静默回退，永不中断剧本生成。
 */
export class RerankClient {
  readonly config: RerankClientConfig
  private readonly logger?: Pick<Logger<ILogObj>, 'info' | 'warn' | 'debug'>

  constructor(
    config: RerankClientConfig,
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

  private endpointUrl(): string {
    const base = this.config.baseUrl.replace(/\/+$/, '')
    const suffix = this.config.endpointPath.replace(/^\/+/, '')
    return `${base}/${suffix}`
  }

  async rerank(
    query: string,
    documents: string[],
    options: { topN?: number; signal?: AbortSignal } = {}
  ): Promise<RerankResponseResult | null> {
    if (!this.enabled || !query.trim() || documents.length === 0) return null
    const startedAt = Date.now()
    const topN = Math.min(documents.length, Math.max(1, options.topN ?? this.config.topN))
    const instruction = this.config.instruction.trim() || PJSK_DEFAULT_RERANK_INSTRUCTION

    try {
      const firstPayload: Record<string, unknown> = {
        model: this.config.model,
        query: query.trim(),
        documents,
        top_n: topN,
        return_documents: false,
        instruction
      }
      let response = await this.postWithRetry(firstPayload, options.signal)

      // 某些服务端不接受顶层 instruction 字段（400/422）：回退到 query 前缀重试一次
      if (response.status === 400 || response.status === 422) {
        const inlineQuery = /^Instruct:/i.test(query.trim())
          ? query.trim()
          : `Instruct: ${instruction}\nQuery: ${query.trim()}`
        const fallbackPayload: Record<string, unknown> = {
          model: this.config.model,
          query: inlineQuery,
          documents,
          top_n: topN,
          return_documents: false
        }
        response = await this.postWithRetry(fallbackPayload, options.signal)
      }

      if (!response.ok) {
        this.logger?.warn?.(
          `[RAG] Rerank HTTP ${response.status} (${this.config.model}), falling back`
        )
        return null
      }

      const json = (await response.json()) as unknown
      const rawItems = parseRerankResponse(json)
      if (rawItems.length === 0) return null

      const items = calibrateRerankScores(rawItems).filter((item) => item.index < documents.length)
      return {
        items,
        latencyMs: Date.now() - startedAt
      }
    } catch (error) {
      if (options.signal?.aborted) throw error
      this.logger?.warn?.(
        `[RAG] Rerank request failed (${this.config.model}), falling back: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return null
    }
  }

  private async postWithRetry(
    payload: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Response> {
    const url = this.endpointUrl()
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    const key = this.apiKey()
    if (key) headers.authorization = `Bearer ${key}`

    const attempt = async (): Promise<Response> => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)
      const onAbort = (): void => controller.abort()
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        return await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal
        })
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
    }

    let res = await attempt()
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      res = await attempt()
    }
    return res
  }
}
