import { ILogObj, Logger } from 'tslog'
import type { LlmSettings } from '../config'

export interface LlmToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface LlmToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: LlmToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ChatOptions {
  /** 要求服务返回 JSON 对象（OpenAI response_format） */
  json?: boolean
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  /** OpenAI 兼容 function/tool calling 工具定义 */
  tools?: LlmToolDefinition[]
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }
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
  finishReason?: string
  toolCalls?: LlmToolCall[]
}

export interface ExtractJsonContext {
  finishReason?: string
  maxTokens?: number
}

export class LlmError extends Error {
  readonly status: number | null
  readonly retryable: boolean
  readonly toolCallingUnsupported: boolean

  constructor(
    message: string,
    status: number | null = null,
    retryable = false,
    toolCallingUnsupported = false
  ) {
    super(message)
    this.name = 'LlmError'
    this.status = status
    this.retryable = retryable
    this.toolCallingUnsupported = toolCallingUnsupported
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
export function extractJson(text: string, context?: ExtractJsonContext): unknown {
  const lengthSuffix =
    context?.finishReason === 'length'
      ? ` (finish_reason=length; output truncated at max_tokens=${context.maxTokens ?? 'unknown'} before complete JSON)`
      : ''
  const cleaned = text.replace(/^\uFEFF/, '').trim()
  if (!cleaned) throw new Error(`empty model response${lengthSuffix}`)

  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(cleaned)
  const body = (fenced ? fenced[1] : cleaned).trim()

  const startObject = body.indexOf('{')
  const startArray = body.indexOf('[')
  let start = -1
  let open = ''
  let close = ''
  if (startObject === -1 && startArray === -1) {
    throw new Error(`no JSON value in model response${lengthSuffix}`)
  }
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
          throw new Error(`invalid JSON in model response${lengthSuffix}: ${String(error)}`)
        }
      }
    }
  }
  throw new Error(`unterminated JSON in model response${lengthSuffix}`)
}

interface ChatCompletionResponse {
  model?: string
  choices?: Array<{
    message?: {
      content?: string | null
      tool_calls?: Array<{
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
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
        const hasTools = Boolean(options.tools && options.tools.length > 0)
        const serializedMessages = messages.map((message) => {
          const msg: Record<string, unknown> = {
            role: message.role,
            content: message.content ?? ''
          }
          if (message.tool_calls?.length) msg.tool_calls = message.tool_calls
          if (message.tool_call_id) msg.tool_call_id = message.tool_call_id
          if (message.name) msg.name = message.name
          return msg
        })
        const body: Record<string, unknown> = {
          ...this.config.extraBody,
          model: this.config.model,
          messages: serializedMessages,
          temperature: options.temperature ?? this.config.temperature,
          max_tokens: options.maxTokens ?? this.config.maxTokens,
          stream: false
        }
        if (hasTools) {
          body.tools = options.tools
          body.tool_choice = options.toolChoice ?? 'auto'
        } else if (tryJson && this.config.jsonMode !== 'off') {
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

          if (
            hasTools &&
            (response.status === 400 ||
              response.status === 404 ||
              response.status === 422 ||
              response.status === 501 ||
              /tool|function_call|not support|unrecognized/i.test(message))
          ) {
            throw new LlmError(message, response.status, false, true)
          }

          // auto：服务不支持 response_format 时去掉它再试一次（不消耗重试次数）
          if (
            !hasTools &&
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
          const maxTokens = options.maxTokens ?? this.config.maxTokens
          const choice = parsed.choices?.[0]
          const finishReason = choice?.finish_reason
          const rawToolCalls = choice?.message?.tool_calls
          const toolCalls: LlmToolCall[] = Array.isArray(rawToolCalls)
            ? rawToolCalls
                .filter((tc) => Boolean(tc?.function?.name))
                .map((tc, idx) => ({
                  id: tc.id || `call_${idx + 1}`,
                  type: 'function' as const,
                  function: {
                    name: String(tc.function!.name),
                    arguments:
                      typeof tc.function?.arguments === 'string'
                        ? tc.function.arguments
                        : JSON.stringify(tc.function?.arguments ?? {})
                  }
                }))
            : []
          const content = choice?.message?.content
          if (
            toolCalls.length === 0 &&
            (typeof content !== 'string' || content.trim().length === 0)
          ) {
            if (finishReason === 'length') {
              throw new LlmError(
                `${url}: empty choice content (finish_reason=length; output truncated at max_tokens=${maxTokens} before JSON/text output)`,
                null,
                false
              )
            }
            throw new LlmError(`${url}: empty choice content`, null, true)
          }
          if (finishReason === 'length') {
            this.logger.warn(
              `[AI] LLM ${parsed.model ?? this.config.model} truncated with finish_reason=length (max_tokens=${maxTokens})`
            )
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
            content: typeof content === 'string' ? content : '',
            model: parsed.model ?? this.config.model,
            usage,
            latencyMs,
            ...(finishReason ? { finishReason } : {}),
            ...(toolCalls.length > 0 ? { toolCalls } : {})
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
    const maxTokens = options.maxTokens ?? this.config.maxTokens
    let data: T
    try {
      data = extractJson(result.content, { finishReason: result.finishReason, maxTokens }) as T
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
