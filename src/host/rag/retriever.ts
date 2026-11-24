import type { ILogObj, Logger } from 'tslog'
import type { RagAdaptiveSettings, RagSettings } from '../config'
import type { EmbeddingClient } from './embeddingClient'
import type {
  RagCastMemberHint,
  RagChunk,
  RagExcerpt,
  RagMode,
  RagRetrieveRequest,
  RagRetrieveResult,
  RagSections
} from './types'
import { IncrementalSq8Cache } from './vectorIndex'

const COLD_START_SMALL_CORPUS_LIMIT = 2000
const LARGE_CORPUS_PREFILTER_TOP_M = 96
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

function scoreBm25(index: LexicalIndex, queryTokens: string[], chunks: RagChunk[]): Float32Array {
  const scores = new Float32Array(chunks.length)
  if (queryTokens.length === 0 || chunks.length === 0) return scores

  const uniqueTokens = Array.from(new Set(queryTokens))
  const k1 = 1.2
  const b = 0.75
  const avgdl = Math.max(1, index.avgDocLen)

  for (const tok of uniqueTokens) {
    const list = index.postings.get(tok)
    if (!list) continue
    const termIdf = index.idf.get(tok) ?? 0
    for (let i = 0; i < list.length; i++) {
      const { idx, tf } = list[i]
      const dl = index.docLengths[idx]
      const denom = tf + k1 * (1 - b + (b * dl) / avgdl)
      scores[idx] += termIdf * ((tf * (k1 + 1)) / denom)
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

  if (stage === 'cast' && (chunk.sourceKind === 'canon_story' || chunk.sourceKind === 'worldview_lore')) {
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
  const aLines = aText.split('\n').map((l) => l.trim()).filter(Boolean)
  const bLines = bText.split('\n').map((l) => l.trim()).filter(Boolean)
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
          charScore: Math.max(current.charScore, next.charScore)
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
  settings: Pick<RagSettings, 'enabled' | 'model' | 'cacheDir' | 'fallbackLexical' | 'adaptive'>
  embeddingClient?: EmbeddingClient | null
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
  mergeAdjacentGap: 4
}

/**
 * 自适应多面语义检索器：
 * - 混合打分（Dense + BM25 CJK-bigram + 角色共现加权）；
 * - 两级冷启动保护（<=2000 块全量增量缓存；>2000 块先 BM25 预筛 Top-96 再增量嵌入）；
 * - 自适应可变输出量（绝对下限 + 相对跌幅 + 拐点断崖 + 动态字符预算）；
 * - 相邻滑窗场景合并 + `maxPerStory` 多样性 + Jaccard 近重复抑制；
 * - Embedding 不可用时零报错自动降级为纯词法检索。
 */
export class AdaptiveRagRetriever {
  private readonly chunks: RagChunk[]
  private readonly settings: AdaptiveRagRetrieverOptions['settings']
  private readonly adaptive: RagAdaptiveSettings
  private readonly embeddingClient: EmbeddingClient | null
  private readonly cache: IncrementalSq8Cache
  private readonly lexical: LexicalIndex
  private readonly logger?: Pick<Logger<ILogObj>, 'info' | 'warn' | 'debug'>

  constructor(options: AdaptiveRagRetrieverOptions) {
    this.chunks = options.chunks
    this.settings = options.settings
    this.adaptive = { ...DEFAULT_ADAPTIVE, ...(options.settings.adaptive ?? {}) }
    this.embeddingClient = options.embeddingClient ?? null
    this.cache = new IncrementalSq8Cache(options.settings.cacheDir, options.settings.model)
    this.cache.load()
    this.lexical = buildLexicalIndex(this.chunks)
    this.logger = options.logger
  }

  get chunkCount(): number {
    return this.chunks.length
  }

  async retrieve(req: RagRetrieveRequest): Promise<RagRetrieveResult> {
    const startedAt = Date.now()
    const empty = (mode: RagMode, queries: string[]): RagRetrieveResult => ({
      mode,
      model: this.settings.model,
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
      return empty('disabled', [])
    }

    const queries = buildQueries(req)
    if (queries.length === 0) {
      return empty('disabled', [])
    }

    // 1. 计算词法 BM25 分数与角色亲和度（始终 <30ms）
    const combinedQueryTokens = tokenizeHybrid(queries.join(' '))
    const bm25Raw = scoreBm25(this.lexical, combinedQueryTokens, this.chunks)
    const lexScores = new Float32Array(this.chunks.length)
    const charScores = new Float32Array(this.chunks.length)
    for (let i = 0; i < this.chunks.length; i++) {
      const bm = bm25Raw[i]
      lexScores[i] = bm > 0 ? bm / (bm + 2.5) : 0
      charScores[i] = computeCharAffinity(this.chunks[i], req.cast, req.stage)
    }

    // 2. 决定候选集并尝试混合向量检索
    let mode: RagMode = 'lexical_fallback'
    const denseScores = new Float32Array(this.chunks.length)
    let candidateIndices: number[]

    const canUseDense = Boolean(this.embeddingClient?.enabled)
    if (canUseDense && this.embeddingClient) {
      try {
        const queryVectors = await this.embeddingClient.embedQueries(queries, req.signal)
        if (this.chunks.length <= COLD_START_SMALL_CORPUS_LIMIT) {
          candidateIndices = Array.from({ length: this.chunks.length }, (_, i) => i)
        } else {
          // 大语料两级冷启动保护：若全量缓存已就绪则全扫，否则 BM25+角色预筛 Top-96
          let cachedAll = true
          for (let i = 0; i < this.chunks.length; i++) {
            if (!this.cache.has(this.chunks[i].chunkHash)) {
              cachedAll = false
              break
            }
          }
          if (cachedAll) {
            candidateIndices = Array.from({ length: this.chunks.length }, (_, i) => i)
          } else {
            const ranked = Array.from({ length: this.chunks.length }, (_, i) => ({
              i,
              pre: 0.85 * lexScores[i] + 0.15 * charScores[i]
            })).sort((a, b) => b.pre - a.pre)
            candidateIndices = ranked
              .slice(0, Math.min(LARGE_CORPUS_PREFILTER_TOP_M, ranked.length))
              .map((item) => item.i)
          }
        }

        // 仅对未命中磁盘 chunkHash 缓存的候选调用 /embeddings
        const uncached: Array<{ idx: number; chunk: RagChunk }> = []
        for (const idx of candidateIndices) {
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

        for (const idx of candidateIndices) {
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
        mode = 'hybrid'
      } catch (error) {
        if (!this.settings.fallbackLexical) {
          this.logger?.warn?.(
            `[RAG] Embedding failed and lexical fallback disabled: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
          return empty('disabled', queries)
        }
        this.logger?.warn?.(
          `[RAG] Embedding 不可用，已自动降级为词法检索：${
            error instanceof Error ? error.message : String(error)
          }`
        )
        candidateIndices = Array.from({ length: this.chunks.length }, (_, i) => i)
        mode = 'lexical_fallback'
      }
    } else {
      if (!this.settings.fallbackLexical) {
        return empty('disabled', queries)
      }
      candidateIndices = Array.from({ length: this.chunks.length }, (_, i) => i)
      mode = 'lexical_fallback'
    }

    // 3. 融合打分与绝对下限过滤
    const minScore =
      mode === 'hybrid'
        ? this.adaptive.minScore
        : Math.min(this.adaptive.minScore, LEXICAL_FALLBACK_FLOOR)

    const scored: RagExcerpt[] = []
    for (const idx of candidateIndices) {
      const chunk = this.chunks[idx]
      const dense = denseScores[idx]
      const lex = lexScores[idx]
      const ch = charScores[idx]
      const score =
        mode === 'hybrid' ? 0.72 * dense + 0.2 * lex + 0.08 * ch : 0.85 * lex + 0.15 * ch
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
        charScore: Number(ch.toFixed(4))
      })
    }

    if (scored.length === 0) {
      return empty(mode, queries)
    }

    scored.sort((a, b) => b.score - a.score)
    const topScore = scored[0].score

    // 4. 自适应动态字符预算与相对跌幅 / 拐点断崖截断
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

    // 5. 同 scenarioId 相邻滑窗合并 + maxPerStory 多样性 + Jaccard 近重复抑制
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
      if (selectedTokenSets.some((prev) => jaccardSimilarity(prev, tokenSet) > JACCARD_DEDUP_THRESHOLD)) {
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
      mode,
      model: this.settings.model,
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
