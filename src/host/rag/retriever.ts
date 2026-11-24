import type { ILogObj, Logger } from 'tslog'
import type { RagAdaptiveSettings, RagSettings } from '../config'
import type { EmbeddingClient } from './embeddingClient'
import type { RerankClient } from './rerankClient'
import { PJSK_DOMAIN } from './storyCorpus'
import type {
  RagCastMemberHint,
  RagChunk,
  RagExcerpt,
  RagMode,
  RagRetrieveRequest,
  RagRetrieveResult,
  RagSections,
  RerankMode
} from './types'
import { IncrementalSq8Cache } from './vectorIndex'

const COLD_START_SMALL_CORPUS_LIMIT = 2000
const LARGE_CORPUS_PREFILTER_TOP_M = 160
const STAGE1_CHANNEL_TOP_K = 64
const RRF_K = 60
const DEFAULT_CANDIDATE_POOL = 32
const LEXICAL_FALLBACK_FLOOR = 0.35
const JACCARD_DEDUP_THRESHOLD = 0.75

const CJK_RUN_PATTERN = /[\u3040-\u30ff\u3400-\u9fff]+/gu
const ASCII_TOKEN_PATTERN = /[a-z0-9_]{2,}/gi

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/**
 * 轻量 CJK 二元组 + ASCII 词元分词器（用于 BM25 与 Jaccard 去重，零外部依赖）。
 */
export function tokenizeHybrid(text: string): string[] {
  const input = String(text ?? '').toLowerCase()
  const tokens: string[] = []

  const ascii = input.match(ASCII_TOKEN_PATTERN)
  if (ascii) {
    for (const t of ascii) tokens.push(t)
  }

  const cjkRuns = input.match(CJK_RUN_PATTERN)
  if (cjkRuns) {
    for (const run of cjkRuns) {
      if (run.length === 1) {
        tokens.push(run)
      } else {
        for (let i = 0; i < run.length - 1; i++) {
          tokens.push(run.slice(i, i + 2))
        }
      }
    }
  }
  return tokens
}

interface LexicalIndex {
  docLengths: Float32Array
  avgDocLen: number
  idf: Map<string, number>
  postings: Map<string, Array<{ idx: number; tf: number }>>
}

function buildLexicalIndex(chunks: RagChunk[]): LexicalIndex {
  const n = chunks.length
  const docLengths = new Float32Array(n)
  const postings = new Map<string, Array<{ idx: number; tf: number }>>()
  let totalLen = 0

  for (let i = 0; i < n; i++) {
    const tokens = tokenizeHybrid(chunks[i].text)
    docLengths[i] = tokens.length
    totalLen += tokens.length
    const tfMap = new Map<string, number>()
    for (const tok of tokens) {
      tfMap.set(tok, (tfMap.get(tok) ?? 0) + 1)
    }
    for (const [tok, tf] of tfMap) {
      let list = postings.get(tok)
      if (!list) {
        list = []
        postings.set(tok, list)
      }
      list.push({ idx: i, tf })
    }
  }

  const avgDocLen = n > 0 ? totalLen / n : 1
  const idf = new Map<string, number>()
  for (const [tok, list] of postings) {
    const df = list.length
    idf.set(tok, Math.log(1 + (n - df + 0.5) / (df + 0.5)))
  }

  return { docLengths, avgDocLen, idf, postings }
}

function scoreBm25(
  index: LexicalIndex,
  queryTokens: string[],
  rawQueries: string[],
  chunks: RagChunk[]
): Float32Array {
  const scores = new Float32Array(chunks.length)
  if (queryTokens.length === 0 || chunks.length === 0) return scores

  const uniqueTokens = Array.from(new Set(queryTokens))
  const k1 = 1.2
  const b = 0.75
  const avgdl = Math.max(1, index.avgDocLen)
  const docHits = new Uint16Array(chunks.length)

  for (const tok of uniqueTokens) {
    const list = index.postings.get(tok)
    if (!list) continue
    const termIdf = index.idf.get(tok) ?? 0
    for (let i = 0; i < list.length; i++) {
      const { idx, tf } = list[i]
      const dl = index.docLengths[idx]
      const denom = tf + k1 * (1 - b + (b * dl) / avgdl)
      scores[idx] += termIdf * ((tf * (k1 + 1)) / denom)
      docHits[idx] += 1
    }
  }

  // 提取 2~6 字 CJK 精确短语加分（小语料覆盖率补偿 + 精确命中加权）
  const phrases = Array.from(
    new Set(
      rawQueries
        .flatMap((q) => q.match(/[\u3040-\u30ff\u3400-\u9fff]{2,6}/gu) ?? [])
        .filter((p) => p.length >= 2)
    )
  ).slice(0, 10)

  for (let i = 0; i < chunks.length; i++) {
    if (docHits[i] > 0) {
      scores[i] += (docHits[i] / uniqueTokens.length) * 2.0
      if (phrases.length > 0) {
        let phraseHits = 0
        for (const p of phrases) {
          if (chunks[i].text.includes(p)) phraseHits += 1
        }
        if (phraseHits > 0) {
          scores[i] += Math.min(1.5, phraseHits * 0.45)
        }
      }
    }
  }
  return scores
}

function buildQueries(req: RagRetrieveRequest): string[] {
  const queries: string[] = []
  const add = (q: string | undefined): void => {
    const clean = (q ?? '').trim()
    if (clean && !queries.includes(clean)) queries.push(clean)
  }

  // Stage 1 显式提取的多面查询优先
  add(req.retrievalQueries?.plot)
  add(req.retrievalQueries?.voice)
  add(req.retrievalQueries?.worldview)

  // 确定性多查询扩展（0 额外 LLM 调用）
  const plotSeed = [req.prompt, req.event, req.logline].filter(Boolean).join(' ')
  add(plotSeed)

  const castNames = (req.cast ?? []).map((c) => c.name).filter(Boolean)
  if (castNames.length > 0 || req.location) {
    const voiceSeed = [castNames.join(' '), req.location, req.event].filter(Boolean).join(' ')
    add(voiceSeed)
  }

  return queries.slice(0, 4)
}

function buildPrimaryRerankQuery(req: RagRetrieveRequest): string {
  const castNames = (req.cast ?? []).map((c) => c.name).filter(Boolean).join('、')
  return [req.prompt, req.event, castNames ? `角色:${castNames}` : '', req.location]
    .filter(Boolean)
    .join(' | ')
    .slice(0, 400)
}

function computeCharAffinity(
  chunk: RagChunk,
  cast: RagCastMemberHint[] | undefined,
  stage: RagRetrieveRequest['stage']
): number {
  let score = 0
  if (cast && cast.length > 0) {
    const hay = `${chunk.chars.join(' ')} ${chunk.story} ${chunk.text.slice(0, 120)}`.toLowerCase()
    let matchedCast = 0
    for (const member of cast) {
      const names = [member.name, member.fullName, ...(member.aliases ?? [])]
        .filter((s): s is string => Boolean(s && s.trim()))
        .map((s) => s.trim().toLowerCase())
      if (names.some((n) => hay.includes(n))) {
        matchedCast += 1
      }
    }
    if (matchedCast >= 2) score += 1.0
    else if (matchedCast === 1) score += 0.5
  }

  if (
    stage === 'cast' &&
    (chunk.sourceKind === 'canon_story' || chunk.sourceKind === 'worldview_lore')
  ) {
    score += 0.25
  } else if (stage === 'dialogue' && chunk.sourceKind === 'dialogue_voice') {
    score += 0.25
  }
  return clamp(score, 0, 1)
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const tok of a) {
    if (b.has(tok)) inter += 1
  }
  const union = a.size + b.size - inter
  return union > 0 ? inter / union : 0
}

function mergeSceneTexts(aText: string, bText: string): string {
  const aLines = aText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const bLines = bText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (aLines.length === 0) return bText
  if (bLines.length === 0) return aText

  // 去掉 b 开头重复的 [story | chars] 头与滑窗重叠行
  const bBody = bLines[0].startsWith('[') && bLines[0].endsWith(']') ? bLines.slice(1) : bLines
  const existingTail = new Set(aLines.slice(-4))
  const appended = bBody.filter((line) => !existingTail.has(line))
  return [...aLines, ...appended].join('\n')
}

function mergeAdjacentExcerpts(excerpts: RagExcerpt[], maxGap: number): RagExcerpt[] {
  if (excerpts.length <= 1 || maxGap < 0) return excerpts
  const byScenario = new Map<string, RagExcerpt[]>()
  const order: string[] = []
  for (const ex of excerpts) {
    let list = byScenario.get(ex.scenarioId)
    if (!list) {
      list = []
      byScenario.set(ex.scenarioId, list)
      order.push(ex.scenarioId)
    }
    list.push(ex)
  }

  const mergedAll: RagExcerpt[] = []
  for (const key of order) {
    const group = byScenario.get(key)!.sort((a, b) => a.lineStart - b.lineStart)
    let current = { ...group[0] }
    for (let i = 1; i < group.length; i++) {
      const next = group[i]
      if (next.lineStart - current.lineEnd <= maxGap) {
        current = {
          ...current,
          lineEnd: Math.max(current.lineEnd, next.lineEnd),
          text: mergeSceneTexts(current.text, next.text),
          chars: Array.from(new Set([...current.chars, ...next.chars])),
          score: Math.max(current.score, next.score),
          denseScore: Math.max(current.denseScore, next.denseScore),
          lexicalScore: Math.max(current.lexicalScore, next.lexicalScore),
          charScore: Math.max(current.charScore, next.charScore),
          ...(current.rerankScore !== undefined || next.rerankScore !== undefined
            ? { rerankScore: Math.max(current.rerankScore ?? 0, next.rerankScore ?? 0) }
            : {})
        }
      } else {
        mergedAll.push(current)
        current = { ...next }
      }
    }
    mergedAll.push(current)
  }
  return mergedAll.sort((a, b) => b.score - a.score)
}

export function formatRagPromptBlock(sections: RagSections): string {
  const blocks: string[] = []
  const renderList = (title: string, items: RagExcerpt[]): void => {
    if (items.length === 0) return
    const lines = items.map((item) => item.text.trim()).filter(Boolean)
    if (lines.length === 0) return
    blocks.push(`### ${title}\n${lines.join('\n\n')}`)
  }

  renderList('相关官方剧情与事件参考', sections.canonPlot)
  renderList('角色口吻与互动对白样本', sections.dialogueVoice)
  renderList('世界观与角色补充设定', sections.worldviewLore)

  if (blocks.length === 0) return ''
  return [
    '## 官方剧情与设定参考（自适应检索）',
    '> 以下内容仅作事实、关系、称呼与口吻参考，严禁照抄原句或复述原剧情。',
    ...blocks
  ].join('\n\n')
}

export interface AdaptiveRagRetrieverOptions {
  chunks: RagChunk[]
  settings: Pick<RagSettings, 'enabled' | 'model' | 'cacheDir' | 'fallbackLexical'> & {
    adaptive?: Partial<RagAdaptiveSettings>
  }
  embeddingClient?: EmbeddingClient | null
  rerankClient?: RerankClient | null
  logger?: Pick<Logger<ILogObj>, 'info' | 'warn' | 'debug'>
}

const DEFAULT_ADAPTIVE: RagAdaptiveSettings = {
  minScore: 0.42,
  highScore: 0.62,
  relativeDropRatio: 0.78,
  elbowDropDelta: 0.065,
  minChunks: 0,
  maxChunks: 12,
  softCharBudget: 1800,
  maxCharBudget: 4800,
  maxPerStory: 2,
  mergeAdjacentGap: 4,
  expandAdjacentContext: true
}

function topIndicesByScore(scores: Float32Array, indices: number[], limit: number): number[] {
  return [...indices]
    .filter((i) => scores[i] > 0)
    .sort((a, b) => scores[b] - scores[a])
    .slice(0, limit)
}

/**
 * 两阶段自适应多面语义检索器（PJSK 领域隔离）：
 * - Stage 1：宽召回（BM25+CJK+短语 Top-64 + Dense SQ8 Top-64 / 大语料预筛 160 + 角色亲和）+ RRF (k=60) -> Top-32；
 * - Stage 2：`qwen3-reranker-8b` Cross-Encoder 校准重排（0.65/0.20/0.10/0.05，失败优雅回退）；
 * - Stage 3：自适应截断 + 高分剧情块 ±1 相邻上下文自动扩展 + 滑窗去重合并 + `maxPerStory` 多样性。
 */
export class AdaptiveRagRetriever {
  private readonly chunks: RagChunk[]
  private readonly settings: AdaptiveRagRetrieverOptions['settings']
  private readonly adaptive: RagAdaptiveSettings
  private readonly embeddingClient: EmbeddingClient | null
  private readonly rerankClient: RerankClient | null
  private readonly cache: IncrementalSq8Cache
  private readonly lexical: LexicalIndex
  private readonly scenarioChunksMap: Map<string, RagChunk[]>
  private readonly logger?: Pick<Logger<ILogObj>, 'info' | 'warn' | 'debug'>

  constructor(options: AdaptiveRagRetrieverOptions) {
    // 领域隔离：仅保留 PJSK 块（忽略任何非 'pjsk' 领域块）
    this.chunks = options.chunks.filter((c) => !c.domain || c.domain === PJSK_DOMAIN)
    this.settings = options.settings
    this.adaptive = { ...DEFAULT_ADAPTIVE, ...(options.settings.adaptive ?? {}) }
    this.embeddingClient = options.embeddingClient ?? null
    this.rerankClient = options.rerankClient ?? null
    this.cache = new IncrementalSq8Cache(
      options.settings.cacheDir,
      options.settings.model,
      0,
      PJSK_DOMAIN
    )
    this.cache.load()
    this.lexical = buildLexicalIndex(this.chunks)
    this.scenarioChunksMap = new Map()
    for (const chunk of this.chunks) {
      let list = this.scenarioChunksMap.get(chunk.scenarioId)
      if (!list) {
        list = []
        this.scenarioChunksMap.set(chunk.scenarioId, list)
      }
      list.push(chunk)
    }
    for (const list of this.scenarioChunksMap.values()) {
      list.sort((a, b) => a.lineStart - b.lineStart)
    }
    this.logger = options.logger
  }

  get chunkCount(): number {
    return this.chunks.length
  }

  async retrieve(req: RagRetrieveRequest): Promise<RagRetrieveResult> {
    const startedAt = Date.now()
    const rerankModel = this.rerankClient?.model ?? ''
    const empty = (
      mode: RagMode,
      queries: string[],
      rerankMode: RerankMode = this.rerankClient?.enabled ? 'fallback' : 'disabled',
      rerankLatencyMs = 0
    ): RagRetrieveResult => ({
      domain: PJSK_DOMAIN,
      mode,
      model: this.settings.model,
      rerankMode,
      rerankModel,
      rerankLatencyMs,
      expandedCount: 0,
      queries,
      candidateCount: 0,
      selectedCount: 0,
      totalChars: 0,
      charBudget: 0,
      topScore: 0,
      latencyMs: Date.now() - startedAt,
      sections: { canonPlot: [], dialogueVoice: [], worldviewLore: [] },
      promptBlock: ''
    })

    if (!this.settings.enabled || this.chunks.length === 0) {
      return empty('disabled', [], 'disabled')
    }

    const queries = buildQueries(req)
    if (queries.length === 0) {
      return empty('disabled', [], 'disabled')
    }

    // ---- Stage 1A：词法 BM25+CJK+精确短语 与 角色亲和打分 ----
    const allIndices = Array.from({ length: this.chunks.length }, (_, i) => i)
    const combinedQueryTokens = tokenizeHybrid(queries.join(' '))
    const bm25Raw = scoreBm25(this.lexical, combinedQueryTokens, queries, this.chunks)
    const lexScores = new Float32Array(this.chunks.length)
    const charScores = new Float32Array(this.chunks.length)
    for (let i = 0; i < this.chunks.length; i++) {
      const bm = bm25Raw[i]
      lexScores[i] = bm > 0 ? bm / (bm + 2.5) : 0
      charScores[i] = computeCharAffinity(this.chunks[i], req.cast, req.stage)
    }

    // ---- Stage 1B：向量检索（含大语料 160 预筛冷启动保护） ----
    let mode: RagMode = 'lexical_fallback'
    const denseScores = new Float32Array(this.chunks.length)
    let denseIndices: number[] = []

    const canUseDense = Boolean(this.embeddingClient?.enabled)
    if (canUseDense && this.embeddingClient) {
      try {
        const queryVectors = await this.embeddingClient.embedQueries(queries, req.signal)
        let evalIndices: number[]
        if (this.chunks.length <= COLD_START_SMALL_CORPUS_LIMIT) {
          evalIndices = allIndices
        } else {
          let cachedAll = true
          for (let i = 0; i < this.chunks.length; i++) {
            if (!this.cache.has(this.chunks[i].chunkHash)) {
              cachedAll = false
              break
            }
          }
          if (cachedAll) {
            evalIndices = allIndices
          } else {
            const ranked = allIndices
              .map((i) => ({ i, pre: 0.85 * lexScores[i] + 0.15 * charScores[i] }))
              .sort((a, b) => b.pre - a.pre)
            evalIndices = ranked
              .slice(0, Math.min(LARGE_CORPUS_PREFILTER_TOP_M, ranked.length))
              .map((item) => item.i)
          }
        }

        const uncached: Array<{ idx: number; chunk: RagChunk }> = []
        for (const idx of evalIndices) {
          const chunk = this.chunks[idx]
          if (!this.cache.has(chunk.chunkHash)) {
            uncached.push({ idx, chunk })
          }
        }
        if (uncached.length > 0) {
          const vectors = await this.embeddingClient.embedDocuments(
            uncached.map((u) => u.chunk.text),
            req.signal
          )
          this.cache.putBatch(
            uncached.map((u, i) => ({ chunkHash: u.chunk.chunkHash, vector: vectors[i] }))
          )
          try {
            this.cache.save()
          } catch {
            // 磁盘缓存写入失败不影响本次检索结果
          }
        }

        for (const idx of evalIndices) {
          const hash = this.chunks[idx].chunkHash
          let maxSim = 0
          let sumSim = 0
          for (const qv of queryVectors) {
            const sim = clamp(this.cache.dot(qv, hash) ?? 0, 0, 1)
            if (sim > maxSim) maxSim = sim
            sumSim += sim
          }
          const meanSim = queryVectors.length > 0 ? sumSim / queryVectors.length : 0
          denseScores[idx] = clamp(0.75 * maxSim + 0.25 * meanSim, 0, 1)
        }
        denseIndices = evalIndices
        mode = 'hybrid'
      } catch (error) {
        if (!this.settings.fallbackLexical) {
          this.logger?.warn?.(
            `[RAG] Embedding failed and lexical fallback disabled: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
          return empty('disabled', queries, 'disabled')
        }
        this.logger?.warn?.(
          `[RAG] Embedding 不可用，已自动降级为词法检索：${
            error instanceof Error ? error.message : String(error)
          }`
        )
        mode = 'lexical_fallback'
      }
    } else if (!this.settings.fallbackLexical) {
      return empty('disabled', queries, 'disabled')
    }

    // ---- Stage 1C：多路 Reciprocal Rank Fusion (k = 60) -> Top candidatePool (默认 32) ----
    const lexTop = topIndicesByScore(lexScores, allIndices, STAGE1_CHANNEL_TOP_K)
    const charTop = topIndicesByScore(charScores, allIndices, STAGE1_CHANNEL_TOP_K)
    const denseTop =
      mode === 'hybrid' ? topIndicesByScore(denseScores, denseIndices, STAGE1_CHANNEL_TOP_K) : []

    const rrfScores = new Map<number, number>()
    const addRrf = (ranked: number[], weight: number): void => {
      for (let rank = 0; rank < ranked.length; rank++) {
        const idx = ranked[rank]
        rrfScores.set(idx, (rrfScores.get(idx) ?? 0) + weight / (RRF_K + rank + 1))
      }
    }
    if (mode === 'hybrid') {
      addRrf(denseTop, 1.0)
      addRrf(lexTop, 0.75)
      addRrf(charTop, 0.35)
    } else {
      addRrf(lexTop, 1.0)
      addRrf(charTop, 0.45)
    }

    const candidatePoolLimit = this.rerankClient?.config.candidatePool ?? DEFAULT_CANDIDATE_POOL
    const poolIndices = Array.from(rrfScores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, candidatePoolLimit)
      .map(([idx]) => idx)

    if (poolIndices.length === 0) {
      return empty(mode, queries, this.rerankClient?.enabled ? 'fallback' : 'disabled')
    }

    // ---- Stage 2：qwen3-reranker-8b Cross-Encoder 重排与校准融合 ----
    let rerankMode: RerankMode = this.rerankClient?.enabled ? 'fallback' : 'disabled'
    let rerankLatencyMs = 0
    const rerankScoreByChunkIdx = new Map<number, number>()

    if (this.rerankClient?.enabled) {
      const primaryQuery = buildPrimaryRerankQuery(req)
      const docs = poolIndices.map((idx) => this.chunks[idx].text)
      const reranked = await this.rerankClient.rerank(primaryQuery, docs, {
        topN: Math.min(docs.length, this.rerankClient.config.topN),
        signal: req.signal
      })
      if (reranked && reranked.items.length > 0) {
        rerankMode = 'reranked'
        rerankLatencyMs = reranked.latencyMs
        for (const item of reranked.items) {
          const chunkIdx = poolIndices[item.index]
          if (chunkIdx !== undefined) {
            rerankScoreByChunkIdx.set(chunkIdx, item.score)
          }
        }
      }
    }

    const minScore =
      mode === 'hybrid' || rerankMode === 'reranked'
        ? this.adaptive.minScore
        : Math.min(this.adaptive.minScore, LEXICAL_FALLBACK_FLOOR)

    const scored: RagExcerpt[] = []
    for (const idx of poolIndices) {
      const chunk = this.chunks[idx]
      const dense = denseScores[idx]
      const lex = lexScores[idx]
      const ch = charScores[idx]
      const rr = rerankScoreByChunkIdx.get(idx)

      let score: number
      if (mode === 'hybrid' && rerankMode === 'reranked' && rr !== undefined) {
        score = 0.65 * rr + 0.2 * dense + 0.1 * lex + 0.05 * ch
      } else if (mode === 'hybrid') {
        score = 0.72 * dense + 0.2 * lex + 0.08 * ch
      } else if (rerankMode === 'reranked' && rr !== undefined) {
        score = 0.72 * rr + 0.2 * lex + 0.08 * ch
      } else {
        score = 0.85 * lex + 0.15 * ch
      }

      if (score < minScore) continue
      scored.push({
        id: chunk.id,
        sourceKind: chunk.sourceKind,
        storyId: chunk.storyId,
        story: chunk.story,
        scenarioId: chunk.scenarioId,
        type: chunk.type,
        chars: chunk.chars,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        text: chunk.text,
        ...(chunk.jpText ? { jpText: chunk.jpText } : {}),
        score: Number(score.toFixed(4)),
        denseScore: Number(dense.toFixed(4)),
        lexicalScore: Number(lex.toFixed(4)),
        charScore: Number(ch.toFixed(4)),
        ...(rr !== undefined ? { rerankScore: Number(rr.toFixed(4)) } : {})
      })
    }

    if (scored.length === 0) {
      return empty(mode, queries, rerankMode, rerankLatencyMs)
    }

    scored.sort((a, b) => b.score - a.score)
    const topScore = scored[0].score

    // ---- Stage 3：自适应截断 + ±1 相邻上下文自动扩展 + 滑窗合并 + 多样性 ----
    const highScore = this.adaptive.highScore
    const alpha = clamp((topScore - minScore) / Math.max(0.01, highScore - minScore), 0, 1)
    const nHigh = scored.filter((item) => item.score >= highScore).length
    const effectiveMaxBudget = Math.min(
      this.adaptive.maxCharBudget,
      req.maxCharBudget ?? this.adaptive.maxCharBudget
    )
    const charBudget = clamp(
      Math.round(this.adaptive.softCharBudget * (0.45 + 0.55 * alpha) + Math.min(nHigh, 6) * 450),
      Math.min(600, effectiveMaxBudget),
      effectiveMaxBudget
    )

    const cutoffCandidates: RagExcerpt[] = []
    for (let i = 0; i < scored.length; i++) {
      const item = scored[i]
      if (i > 0 && item.score < topScore * this.adaptive.relativeDropRatio) {
        if (cutoffCandidates.length >= this.adaptive.minChunks) break
      }
      if (
        i >= 2 &&
        item.score < highScore &&
        scored[i - 1].score - item.score >= this.adaptive.elbowDropDelta
      ) {
        if (cutoffCandidates.length >= this.adaptive.minChunks) break
      }
      cutoffCandidates.push(item)
      if (cutoffCandidates.length >= this.adaptive.maxChunks * 2) break
    }

    // ±1 相邻上下文自动扩展（针对前 2 条高置信非人设命中块）
    let expandedCount = 0
    if (this.adaptive.expandAdjacentContext) {
      const existingIds = new Set(cutoffCandidates.map((c) => c.id))
      const topExpandable = cutoffCandidates
        .filter(
          (item) =>
            item.sourceKind !== 'worldview_lore' &&
            item.type !== 'persona' &&
            (item.score >= highScore || item.score >= topScore * 0.92)
        )
        .slice(0, 2)

      let estimatedChars = cutoffCandidates.reduce((sum, item) => sum + item.text.length, 0)
      const expandedToAdd: RagExcerpt[] = []

      for (const anchor of topExpandable) {
        const scenarioList = this.scenarioChunksMap.get(anchor.scenarioId)
        if (!scenarioList || scenarioList.length <= 1) continue
        const pos = scenarioList.findIndex((c) => c.id === anchor.id)
        if (pos < 0) continue

        for (const neighborPos of [pos - 1, pos + 1]) {
          const neighbor = scenarioList[neighborPos]
          if (!neighbor || existingIds.has(neighbor.id)) continue
          const gap =
            neighborPos < pos
              ? anchor.lineStart - neighbor.lineEnd
              : neighbor.lineStart - anchor.lineEnd
          if (gap > this.adaptive.mergeAdjacentGap + 8) continue
          if (estimatedChars + neighbor.text.length > effectiveMaxBudget) continue

          existingIds.add(neighbor.id)
          estimatedChars += neighbor.text.length
          expandedCount += 1
          expandedToAdd.push({
            id: neighbor.id,
            sourceKind: neighbor.sourceKind,
            storyId: neighbor.storyId,
            story: neighbor.story,
            scenarioId: neighbor.scenarioId,
            type: neighbor.type,
            chars: neighbor.chars,
            lineStart: neighbor.lineStart,
            lineEnd: neighbor.lineEnd,
            text: neighbor.text,
            ...(neighbor.jpText ? { jpText: neighbor.jpText } : {}),
            score: Number((anchor.score * 0.96).toFixed(4)),
            denseScore: anchor.denseScore,
            lexicalScore: anchor.lexicalScore,
            charScore: anchor.charScore
          })
        }
      }
      cutoffCandidates.push(...expandedToAdd)
    }

    const merged = mergeAdjacentExcerpts(cutoffCandidates, this.adaptive.mergeAdjacentGap)
    const selected: RagExcerpt[] = []
    const perStoryCount = new Map<string, number>()
    const selectedTokenSets: Array<Set<string>> = []
    let totalChars = 0

    for (const item of merged) {
      if (selected.length >= this.adaptive.maxChunks) break
      const storyCount = perStoryCount.get(item.storyId) ?? 0
      if (storyCount >= this.adaptive.maxPerStory) continue

      const tokenSet = new Set(tokenizeHybrid(item.text))
      if (
        selectedTokenSets.some(
          (prev) => jaccardSimilarity(prev, tokenSet) > JACCARD_DEDUP_THRESHOLD
        )
      ) {
        continue
      }

      const len = item.text.length
      if (selected.length > 0 && totalChars + len > charBudget) continue

      selected.push(item)
      selectedTokenSets.push(tokenSet)
      perStoryCount.set(item.storyId, storyCount + 1)
      totalChars += len
    }

    const sections: RagSections = {
      canonPlot: selected.filter((item) => item.sourceKind === 'canon_story'),
      dialogueVoice: selected.filter((item) => item.sourceKind === 'dialogue_voice'),
      worldviewLore: selected.filter((item) => item.sourceKind === 'worldview_lore')
    }
    const promptBlock = formatRagPromptBlock(sections)

    return {
      domain: PJSK_DOMAIN,
      mode,
      model: this.settings.model,
      rerankMode,
      rerankModel,
      rerankLatencyMs,
      expandedCount,
      queries,
      candidateCount: scored.length,
      selectedCount: selected.length,
      totalChars: promptBlock.length,
      charBudget,
      topScore,
      latencyMs: Date.now() - startedAt,
      sections,
      promptBlock
    }
  }
}
