import { ILogObj, Logger } from 'tslog'
import type { LlmSettings } from '../config'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  /** 要求服务返回 JSON 对象（OpenAI response_format） */
  json?: boolean
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

export interface ChatUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

export interface ChatResult {
  content: string
  model: string
  usage: ChatUsage | null
  latencyMs: number
}

export class LlmError extends Error {
  readonly status: number | null
  readonly retryable: boolean

  constructor(message: string, status: number | null = null, retryable = false) {
    super(message)
    this.name = 'LlmError'
    this.status = status
    this.retryable = retryable
  }
}

const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 从模型回复里提取 JSON。
 *
 * 兼容 ```json 代码块、前后解释文字和 BOM；对象与数组都支持。
 * 用括号配对扫描而不是贪婪正则，避免把解释里的 `}` 吃进来。
 */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/^\uFEFF/, '').trim()
  if (!cleaned) throw new Error('empty model response')

  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(cleaned)
  const body = (fenced ? fenced[1] : cleaned).trim()

  const startObject = body.indexOf('{')
  const startArray = body.indexOf('[')
  let start = -1
  let open = ''
  let close = ''
  if (startObject === -1 && startArray === -1) throw new Error('no JSON value in model response')
  if (startObject === -1) {
    start = startArray
    open = '['
    close = ']'
  } else if (startArray === -1) {
    start = startObject
    open = '{'
    close = '}'
  } else if (startObject < startArray) {
    start = startObject
    open = '{'
    close = '}'
  } else {
    start = startArray
    open = '['
    close = ']'
  }

  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < body.length; index++) {
    const char = body[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) {
        const candidate = body.slice(start, index + 1)
        try {
          return JSON.parse(candidate)
        } catch (error) {
          throw new Error(`invalid JSON in model response: ${String(error)}`)
        }
      }
    }
  }
  throw new Error('unterminated JSON in model response')
}

interface ChatCompletionResponse {
  model?: string
  choices?: Array<{
    message?: { content?: string | null }
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
  error?: { message?: string; type?: string; code?: string | number }
}

/**
 * OpenAI Chat Completions 客户端。
 *
 * 密钥只从 apiKeyEnv 指定的环境变量读取；没有密钥时不发 Authorization
 * （本机 Ollama / vLLM 等通常不需要）。网络错误、429、5xx 自动退避重试。
 */
export class LlmClient {
  private readonly config: LlmSettings
  private readonly logger: Logger<ILogObj>

  constructor(config: LlmSettings, logger: Logger<ILogObj>) {
    this.config = config
    this.logger = logger
  }

  get model(): string {
    return this.config.model
  }

  get enabled(): boolean {
    return this.config.enabled && this.config.model.trim().length > 0
  }

  get apiKey(): string {
    return (process.env[this.config.apiKeyEnv] ?? '').trim()
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    if (!this.enabled) {
      throw new LlmError('LLM is disabled or llm.model is empty', null, false)
    }
    if (messages.length === 0) throw new LlmError('LLM messages are empty', null, false)

    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`
    const apiKey = this.apiKey
    const jsonRequested = options.json === true
    let tryJson = jsonRequested && this.config.jsonMode !== 'off'
    let jsonFallbackTried = false
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= this.config.retries; attempt++) {
      const startedAt = Date.now()
      const controller = new AbortController()
      const timer = setTimeout(
        () => controller.abort(new Error(`LLM timeout after ${this.config.timeoutMs}ms`)),
        this.config.timeoutMs
      )
      const onAbort = (): void => controller.abort(options.signal?.reason)
      options.signal?.addEventListener('abort', onAbort, { once: true })

      try {
        const body: Record<string, unknown> = {
          ...this.config.extraBody,
          model: this.config.model,
          messages: messages.map((message) => ({ role: message.role, content: message.content })),
          temperature: options.temperature ?? this.config.temperature,
          max_tokens: options.maxTokens ?? this.config.maxTokens,
          stream: false
        }
        if (tryJson && this.config.jsonMode !== 'off') {
          body.response_format = { type: 'json_object' }
        }

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
          },
          body: JSON.stringify(body),
          signal: controller.signal
        })

        const text = await response.text()
        if (!response.ok) {
          let message = `${url}: HTTP ${response.status}`
          try {
            const parsed = JSON.parse(text) as ChatCompletionResponse
            if (parsed.error?.message) message += ` - ${parsed.error.message}`
          } catch {
            if (text.trim()) message += ` - ${text.trim().slice(0, 300)}`
          }

          // auto：服务不支持 response_format 时去掉它再试一次（不消耗重试次数）
          if (
            tryJson &&
            this.config.jsonMode === 'auto' &&
            !jsonFallbackTried &&
            (response.status === 400 || response.status === 422)
          ) {
            this.logger.info(
              '[AI] LLM rejected the JSON-mode request, retrying without response_format'
            )
            jsonFallbackTried = true
            tryJson = false
            attempt -= 1
            continue
          }

          const retryable = RETRY_STATUS.has(response.status)
          lastError = new LlmError(message, response.status, retryable)
          if (!retryable || attempt >= this.config.retries) throw lastError
        } else {
          let parsed: ChatCompletionResponse
          try {
            parsed = JSON.parse(text) as ChatCompletionResponse
          } catch (error) {
            throw new LlmError(`${url}: invalid JSON response: ${String(error)}`, null, true)
          }
          const content = parsed.choices?.[0]?.message?.content
          if (typeof content !== 'string' || content.trim().length === 0) {
            throw new LlmError(`${url}: empty choice content`, null, true)
          }
          const latencyMs = Date.now() - startedAt
          const usage = parsed.usage
            ? {
                promptTokens: parsed.usage.prompt_tokens,
                completionTokens: parsed.usage.completion_tokens,
                totalTokens: parsed.usage.total_tokens
              }
            : null
          this.logger.debug(
            `[AI] LLM ${parsed.model ?? this.config.model} ok in ${latencyMs}ms` +
              (usage?.totalTokens ? `, ${usage.totalTokens} tokens` : '')
          )
          return {
            content,
            model: parsed.model ?? this.config.model,
            usage,
            latencyMs
          }
        }
      } catch (error) {
        const candidate =
          error instanceof LlmError
            ? error
            : new LlmError(error instanceof Error ? error.message : String(error), null, true)
        lastError = candidate
        if (candidate instanceof LlmError && !candidate.retryable) throw candidate
        if (options.signal?.aborted) throw candidate
        if (attempt >= this.config.retries) throw candidate
        this.logger.warn(
          `[AI] LLM request failed (attempt ${attempt + 1}/${this.config.retries + 1}): ${candidate.message}`
        )
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }

      await sleep(800 * 2 ** attempt + Math.random() * 400)
    }

    throw lastError ?? new LlmError('LLM request failed', null, true)
  }

  async chatJson<T>(
    messages: ChatMessage[],
    options: ChatOptions = {}
  ): Promise<{ data: T; result: ChatResult }> {
    const result = await this.chat(messages, { ...options, json: true })
    let data: T
    try {
      data = extractJson(result.content) as T
    } catch (error) {
      throw new LlmError(
        `LLM returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        null,
        false
      )
    }
    return { data, result }
  }
}
