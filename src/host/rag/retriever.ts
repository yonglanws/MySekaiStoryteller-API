import type { ILogObj, Logger } from 'tslog'
import type { RagAdaptiveSettings, RagSettings } from '../config'
import type { EmbeddingClient } from './embeddingClient'
import type { RerankClient } from './rerankClient'
import {
  extractCanonicalEntityTokens,
  PJSK_DOMAIN,
  resolveCharKeysFromHint,
  resolveUnitLabel
} from './storyCorpus'
import type {
  ListStoriesFilter,
  RagCastMemberHint,
  RagChunk,
  RagExcerpt,
  RagMode,
  RagRetrieveRequest,
  RagRetrieveResult,
  RagSections,
  RagSourceKind,
  RagStructuredRetrieveResult,
  RerankMode,
  ScenarioContextResult,
  StoryCatalogSummary
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
 * 轻量 CJK 二元组 + ASCII 词元 + 跨语种 PJSK 实体归一化分词器（用于 BM25 与 Jaccard 去重）。
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

  // 注入跨语种规范实体 token（char:mizuki / unit:n25 / kw:school_festival 等）
  const canonical = extractCanonicalEntityTokens(text)
  for (const tok of canonical.tokens) {
    tokens.push(tok)
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
    const chunk = chunks[i]
    const indexText =
      chunk.chars.length > 0 ? `${chunk.text}\n${chunk.chars.join(' ')}` : chunk.text
    const tokens = tokenizeHybrid(indexText)
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
  ).slice(0, 12)

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

/**
 * 构建多面查询 + 跨语种日文实体桥接查询，使中文查询能够同时召回 `jp_new_stories` 的日文剧本。
 */
export function buildQueries(req: RagRetrieveRequest): string[] {
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

  // 跨语种 JP 桥接查询（让 Embedding 与 Rerank 直接衔接日文 2025/2026 新活动对白）
  const entitySeed = [
    req.prompt,
    req.event,
    req.location,
    ...castNames,
    ...(req.cast ?? []).map((c) => c.fullName).filter(Boolean)
  ]
    .filter(Boolean)
    .join(' ')
  const extracted = extractCanonicalEntityTokens(entitySeed)
  if (extracted.bridgeTerms.length > 0) {
    const bridgeQuery = [...extracted.bridgeTerms.slice(0, 8), req.event, req.location]
      .filter(Boolean)
      .join(' ')
      .trim()
    add(bridgeQuery)
  }

  return queries.slice(0, 5)
}

function buildPrimaryRerankQuery(req: RagRetrieveRequest): string {
  const castNames = (req.cast ?? []).map((c) => c.name).filter(Boolean).join('、')
  return [req.prompt, req.event, castNames ? `角色:${castNames}` : '', req.location]
    .filter(Boolean)
    .join(' | ')
    .slice(0, 400)
}

interface CharAffinityResult {
  charScore: number
  matchedCastCount: number
}

function computeCharAffinity(
  chunk: RagChunk,
  cast: RagCastMemberHint[] | undefined,
  stage: RagRetrieveRequest['stage']
): CharAffinityResult {
  let score = 0
  let matchedCastCount = 0

  if (cast && cast.length > 0) {
    const hay = `${chunk.chars.join(' ')} ${chunk.story} ${chunk.text.slice(0, 180)}`.toLowerCase()
    const chunkCharKeys = new Set<string>(extractCanonicalEntityTokens(hay).charKeys)
    for (const cid of chunk.charIds ?? []) {
      for (const key of resolveCharKeysFromHint({ charId: cid })) {
        chunkCharKeys.add(key)
      }
    }

    for (const member of cast) {
      const memberKeys = resolveCharKeysFromHint(member)
      const names = [member.name, member.fullName, ...(member.aliases ?? [])]
        .filter((s): s is string => Boolean(s && s.trim()))
        .map((s) => s.trim().toLowerCase())

      const keyMatched = memberKeys.some((k) => chunkCharKeys.has(k))
      const textMatched = names.some((n) => hay.includes(n))
      if (keyMatched || textMatched) {
        matchedCastCount += 1
      }
    }

    if (matchedCastCount >= 3) score += 1.0
    else if (matchedCastCount === 2) score += 0.85
    else if (matchedCastCount === 1) score += 0.45
  }

  if (
    stage === 'cast' &&
    (chunk.sourceKind === 'canon_story' || chunk.sourceKind === 'worldview_lore')
  ) {
    score += 0.2
  } else if (stage === 'dialogue' && chunk.sourceKind === 'dialogue_voice') {
    score += 0.2
  }
  return { charScore: clamp(score, 0, 1), matchedCastCount }
}

/** 计算剧本时效因子 [0, 1]：越接近 2025/2026 年的官方活动与 JP 新剧本权重越高。 */
export function computeRecencyFactor(chunk: RagChunk): number {
  if (chunk.sourceKind === 'worldview_lore' || chunk.type === 'persona') {
    return 0
  }
  if (typeof chunk.eventNum === 'number' && Number.isFinite(chunk.eventNum)) {
    const n = chunk.eventNum
    if (n >= 200) return 1.0
    if (n >= 154) return clamp(0.65 + ((n - 154) / 46) * 0.3, 0.65, 0.95)
    if (n >= 100) return clamp(0.15 + ((n - 100) / 54) * 0.25, 0.15, 0.4)
    if (n > 0) return clamp((n / 100) * 0.12, 0, 0.12)
  }
  if (chunk.isRecent2025_2026) return 0.9
  if (typeof chunk.eventYear === 'number' && Number.isFinite(chunk.eventYear)) {
    if (chunk.eventYear >= 2026) return 1.0
    if (chunk.eventYear === 2025) return 0.78
    if (chunk.eventYear === 2024) return 0.3
    return 0.08
  }
  return 0
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
            : {}),
          ...(current.recencyBoost !== undefined || next.recencyBoost !== undefined
            ? { recencyBoost: Math.max(current.recencyBoost ?? 0, next.recencyBoost ?? 0) }
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

interface SectionQuotaSpec {
  kind: RagSourceKind
  charCap: number
  maxSlots: number
}

function getSectionQuotas(
  stage: RagRetrieveRequest['stage'],
  charBudget: number,
  maxChunks: number
): SectionQuotaSpec[] {
  if (stage === 'cast') {
    return [
      {
        kind: 'canon_story',
        charCap: Math.round(charBudget * 0.55),
        maxSlots: Math.max(2, Math.ceil(maxChunks * 0.55))
      },
      {
        kind: 'worldview_lore',
        charCap: Math.round(charBudget * 0.3),
        maxSlots: Math.max(1, Math.ceil(maxChunks * 0.35))
      },
      {
        kind: 'dialogue_voice',
        charCap: Math.round(charBudget * 0.2),
        maxSlots: Math.max(1, Math.ceil(maxChunks * 0.25))
      }
    ]
  }
  return [
    {
      kind: 'canon_story',
      charCap: Math.round(charBudget * 0.45),
      maxSlots: Math.max(2, Math.ceil(maxChunks * 0.45))
    },
    {
      kind: 'dialogue_voice',
      charCap: Math.round(charBudget * 0.3),
      maxSlots: Math.max(2, Math.ceil(maxChunks * 0.35))
    },
    {
      kind: 'worldview_lore',
      charCap: Math.round(charBudget * 0.3),
      maxSlots: Math.max(2, Math.ceil(maxChunks * 0.35))
    }
  ]
}

function chunkToExcerpt(
  chunk: RagChunk,
  metrics: {
    score: number
    denseScore: number
    lexicalScore: number
    charScore: number
    rerankScore?: number
    recencyBoost?: number
  }
): RagExcerpt {
  return {
    id: chunk.id,
    sourceKind: chunk.sourceKind,
    storyId: chunk.storyId,
    story: chunk.story,
    ...(chunk.ep !== undefined ? { ep: chunk.ep } : {}),
    ...(chunk.epTitle ? { epTitle: chunk.epTitle } : {}),
    scenarioId: chunk.scenarioId,
    type: chunk.type,
    ...(chunk.unit ? { unit: chunk.unit } : {}),
    ...(chunk.eventNum !== undefined ? { eventNum: chunk.eventNum } : {}),
    ...(chunk.isRecent2025_2026 ? { isRecent2025_2026: true } : {}),
    ...(chunk.lang ? { lang: chunk.lang } : {}),
    chars: chunk.chars,
    lineStart: chunk.lineStart,
    lineEnd: chunk.lineEnd,
    text: chunk.text,
    ...(chunk.jpText ? { jpText: chunk.jpText } : {}),
    score: Number(metrics.score.toFixed(4)),
    denseScore: Number(metrics.denseScore.toFixed(4)),
    lexicalScore: Number(metrics.lexicalScore.toFixed(4)),
    charScore: Number(metrics.charScore.toFixed(4)),
    ...(metrics.rerankScore !== undefined
      ? { rerankScore: Number(metrics.rerankScore.toFixed(4)) }
      : {}),
    ...(metrics.recencyBoost !== undefined && metrics.recencyBoost > 0
      ? { recencyBoost: Number(metrics.recencyBoost.toFixed(4)) }
      : {})
  }
}

/**
 * 两阶段自适应多面语义检索器（PJSK 领域隔离）：
 * - Stage 1：跨语种宽召回（BM25+CJK+规范实体 Top-64 + Dense SQ8 + 角色共现）+ RRF (k=60) + 三路池保底；
 * - Stage 2：Cross-Encoder 校准重排 + 2025/2026 时效加权 + 多角色同台共现协同加分；
 * - Stage 3：分栏均衡配额（剧情/对白/人设互不挤占）+ ±1 相邻上下文扩展 + 滑窗去重合并。
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
  private readonly recencyFactors: Float32Array
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
    this.recencyFactors = new Float32Array(this.chunks.length)

    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i]
      this.recencyFactors[i] = computeRecencyFactor(chunk)
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

  /**
   * 按 `scenarioId` 钻取某官方章节的连续上下文，供 Agent 工具或工作流展开阅读。
   * - `aroundLine` 省略时默认从开头起展开；
   * - `radiusChunks` 指定中心块前后各自扩展的切片数量（默认 2，最多覆盖 5 个切片约 28 句）。
   */
  expandScenarioContext(
    scenarioId: string,
    aroundLine?: number,
    radiusChunks = 2
  ): ScenarioContextResult | null {
    const list = this.scenarioChunksMap.get(scenarioId)
    if (!list || list.length === 0) return null

    const radius = Math.max(0, Math.floor(radiusChunks))
    let centerIdx = 0
    if (aroundLine !== undefined && Number.isFinite(aroundLine)) {
      let bestIdx = 0
      let bestDist = Infinity
      for (let i = 0; i < list.length; i++) {
        const c = list[i]
        if (aroundLine >= c.lineStart && aroundLine <= c.lineEnd) {
          bestIdx = i
          break
        }
        const dist = Math.min(Math.abs(aroundLine - c.lineStart), Math.abs(aroundLine - c.lineEnd))
        if (dist < bestDist) {
          bestDist = dist
          bestIdx = i
        }
      }
      centerIdx = bestIdx
    }

    const startIdx = Math.max(0, centerIdx - radius)
    const endIdx = Math.min(list.length - 1, centerIdx + radius)
    const slice = list.slice(startIdx, endIdx + 1)

    let mergedText = slice[0].text
    for (let i = 1; i < slice.length; i++) {
      mergedText = mergeSceneTexts(mergedText, slice[i].text)
    }
    const anchor = slice[0]
    return {
      scenarioId: anchor.scenarioId,
      storyId: anchor.storyId,
      story: anchor.story,
      ...(anchor.ep !== undefined ? { ep: anchor.ep } : {}),
      ...(anchor.epTitle ? { epTitle: anchor.epTitle } : {}),
      ...(anchor.unit ? { unit: anchor.unit } : {}),
      ...(anchor.eventNum !== undefined ? { eventNum: anchor.eventNum } : {}),
      ...(anchor.isRecent2025_2026 ? { isRecent2025_2026: true } : {}),
      ...(anchor.lang ? { lang: anchor.lang } : {}),
      totalChunks: list.length,
      windowStartIdx: startIdx,
      windowEndIdx: endIdx,
      lineStart: slice[0].lineStart,
      lineEnd: slice[slice.length - 1].lineEnd,
      text: mergedText,
      chunks: slice
    }
  }

  /**
   * 列出当前索引中可用的官方故事/活动/人设目录（按时效从新到旧排序），支持按关键词、组合或 2025/2026 过滤。
   */
  listAvailableStories(filter: ListStoriesFilter = {}): StoryCatalogSummary[] {
    const byStory = new Map<
      string,
      StoryCatalogSummary & { _scenarioMap: Map<string, { scenarioId: string; ep?: string; epTitle?: string; chunkCount: number }> }
    >()

    for (const chunk of this.chunks) {
      let item = byStory.get(chunk.storyId)
      if (!item) {
        item = {
          storyId: chunk.storyId,
          story: chunk.story,
          type: chunk.type,
          sourceKind: chunk.sourceKind,
          ...(chunk.unit ? { unit: chunk.unit } : {}),
          ...(chunk.eventNum !== undefined ? { eventNum: chunk.eventNum } : {}),
          ...(chunk.isRecent2025_2026 ? { isRecent2025_2026: true } : {}),
          ...(chunk.lang ? { lang: chunk.lang } : {}),
          scenarios: [],
          _scenarioMap: new Map()
        }
        byStory.set(chunk.storyId, item)
      } else {
        if (!item.unit && chunk.unit) item.unit = chunk.unit
        if (item.eventNum === undefined && chunk.eventNum !== undefined) item.eventNum = chunk.eventNum
        if (!item.isRecent2025_2026 && chunk.isRecent2025_2026) item.isRecent2025_2026 = true
      }

      const existingSc = item._scenarioMap.get(chunk.scenarioId)
      if (existingSc) {
        existingSc.chunkCount += 1
      } else {
        item._scenarioMap.set(chunk.scenarioId, {
          scenarioId: chunk.scenarioId,
          ...(chunk.ep !== undefined ? { ep: chunk.ep } : {}),
          ...(chunk.epTitle ? { epTitle: chunk.epTitle } : {}),
          chunkCount: 1
        })
      }
    }

    const queryText = (filter.query ?? '').trim()
    const queryTokens = queryText ? new Set(tokenizeHybrid(queryText)) : null
    const filterUnit = filter.unit ? resolveUnitLabel(filter.unit) || filter.unit.trim() : ''

    const results: StoryCatalogSummary[] = []
    for (const item of byStory.values()) {
      if (filter.sourceKind && item.sourceKind !== filter.sourceKind) continue
      if (filter.recentOnly && !item.isRecent2025_2026) continue
      if (filterUnit && item.unit !== filterUnit) continue

      const scenarios = [...item._scenarioMap.values()]
      if (queryText && queryTokens) {
        const hay = [
          item.story,
          item.storyId,
          item.unit ?? '',
          ...scenarios.map((s) => `${s.scenarioId} ${s.epTitle ?? ''}`)
        ].join(' ')
        const hayTokens = new Set(tokenizeHybrid(hay))
        const hit =
          hay.toLowerCase().includes(queryText.toLowerCase()) ||
          [...queryTokens].some((t) => hayTokens.has(t))
        if (!hit) continue
      }

      const { _scenarioMap: _ignored, ...summary } = item
      summary.scenarios = scenarios
      results.push(summary)
    }

    results.sort((a, b) => {
      const recA = (a.isRecent2025_2026 ? 10_000 : 0) + (a.eventNum ?? 0)
      const recB = (b.isRecent2025_2026 ? 10_000 : 0) + (b.eventNum ?? 0)
      if (recB !== recA) return recB - recA
      return a.storyId.localeCompare(b.storyId)
    })

    const limit = typeof filter.limit === 'number' && filter.limit > 0 ? filter.limit : 50
    return results.slice(0, limit)
  }

  /**
   * 结构化检索入口：返回常规检索结果 + 头部命中章节的上下文展开 + 相关可用故事标题清单。
   */
  async searchStructured(
    req: RagRetrieveRequest,
    options: {
      expandContextRadius?: number
      includeAvailableStories?: boolean
      storyCatalogLimit?: number
    } = {}
  ): Promise<RagStructuredRetrieveResult> {
    const base = await this.retrieve(req)
    const radius = options.expandContextRadius ?? 1
    const expandedContexts: ScenarioContextResult[] = []
    const seenScenarios = new Set<string>()

    const topScenarios = [...base.sections.canonPlot, ...base.sections.dialogueVoice]
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)

    for (const ex of topScenarios) {
      if (seenScenarios.has(ex.scenarioId)) continue
      const expanded = this.expandScenarioContext(
        ex.scenarioId,
        Math.floor((ex.lineStart + ex.lineEnd) / 2),
        radius
      )
      if (expanded) {
        seenScenarios.add(ex.scenarioId)
        expandedContexts.push(expanded)
      }
    }

    const availableStories =
      options.includeAvailableStories === false
        ? []
        : this.listAvailableStories({
            query: [req.event, ...(req.cast ?? []).map((c) => c.name)].filter(Boolean).join(' ') || req.prompt,
            limit: options.storyCatalogLimit ?? 20
          })

    return {
      ...base,
      expandedContexts,
      availableStories
    }
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

    // ---- Stage 1A：词法 BM25+CJK+跨语种实体 与 多角色同台亲和打分 ----
    const allIndices = Array.from({ length: this.chunks.length }, (_, i) => i)
    const combinedQueryTokens = tokenizeHybrid(queries.join(' '))
    const bm25Raw = scoreBm25(this.lexical, combinedQueryTokens, queries, this.chunks)
    const lexScores = new Float32Array(this.chunks.length)
    const charScores = new Float32Array(this.chunks.length)
    const matchedCastCounts = new Uint8Array(this.chunks.length)

    for (let i = 0; i < this.chunks.length; i++) {
      const bm = bm25Raw[i]
      lexScores[i] = bm > 0 ? bm / (bm + 2.5) : 0
      const affinity = computeCharAffinity(this.chunks[i], req.cast, req.stage)
      charScores[i] = affinity.charScore
      matchedCastCounts[i] = affinity.matchedCastCount
    }

    // ---- Stage 1B：向量检索（保留全部已缓存向量 + 增量嵌入 Top-160 未缓存候选） ----
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
          const cachedIndices: number[] = []
          const uncachedScored: Array<{ i: number; pre: number }> = []
          for (let i = 0; i < this.chunks.length; i++) {
            if (this.cache.has(this.chunks[i].chunkHash)) {
              cachedIndices.push(i)
            } else {
              uncachedScored.push({
                i,
                pre:
                  0.78 * lexScores[i] +
                  0.16 * charScores[i] +
                  0.06 * this.recencyFactors[i]
              })
            }
          }
          if (uncachedScored.length === 0) {
            evalIndices = cachedIndices
          } else {
            uncachedScored.sort((a, b) => b.pre - a.pre)
            const topUncached = uncachedScored
              .slice(0, Math.min(LARGE_CORPUS_PREFILTER_TOP_M, uncachedScored.length))
              .map((item) => item.i)
            evalIndices = [...cachedIndices, ...topUncached]
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

    // ---- Stage 1C：多路 Reciprocal Rank Fusion (k = 60) + 三类候选池保底 -> Top candidatePool ----
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

    // 对已被召回的候选附带轻度时效偏置，确保 2025/2026 新活动顺利进入候选池
    for (const [idx, rrf] of rrfScores) {
      const recency = this.recencyFactors[idx]
      if (recency > 0) {
        rrfScores.set(idx, rrf + 0.003 * recency)
      }
    }

    const candidatePoolLimit = this.rerankClient?.config.candidatePool ?? DEFAULT_CANDIDATE_POOL
    const sortedPool = Array.from(rrfScores.entries()).sort((a, b) => b[1] - a[1])

    // 为 dialogue_voice 与 worldview_lore 在候选池中保留少量保底席位，防止 canon_story 挤占重排入口
    const poolSet = new Set<number>()
    const reserveForKind = (kind: RagSourceKind, limit: number): void => {
      let count = 0
      for (const [idx] of sortedPool) {
        if (count >= limit) break
        const c = this.chunks[idx]
        if (c.sourceKind !== kind) continue
        if (lexScores[idx] <= 0 && denseScores[idx] <= 0 && charScores[idx] < 0.45) continue
        poolSet.add(idx)
        count += 1
      }
    }
    reserveForKind('dialogue_voice', Math.min(4, Math.floor(candidatePoolLimit / 6)))
    reserveForKind('worldview_lore', Math.min(4, Math.floor(candidatePoolLimit / 6)))

    for (const [idx] of sortedPool) {
      if (poolSet.size >= candidatePoolLimit) break
      poolSet.add(idx)
    }
    const poolIndices = Array.from(poolSet)

    if (poolIndices.length === 0) {
      return empty(mode, queries, this.rerankClient?.enabled ? 'fallback' : 'disabled')
    }

    // ---- Stage 2：Cross-Encoder 重排 + 时效/共现协同校准 ----
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

    const castHintCount = req.cast?.length ?? 0
    const scored: RagExcerpt[] = []

    for (const idx of poolIndices) {
      const chunk = this.chunks[idx]
      const dense = denseScores[idx]
      const lex = lexScores[idx]
      const ch = charScores[idx]
      const rr = rerankScoreByChunkIdx.get(idx)

      let baseScore: number
      if (mode === 'hybrid' && rerankMode === 'reranked' && rr !== undefined) {
        baseScore = 0.65 * rr + 0.2 * dense + 0.1 * lex + 0.05 * ch
      } else if (mode === 'hybrid') {
        baseScore = 0.72 * dense + 0.2 * lex + 0.08 * ch
      } else if (rerankMode === 'reranked' && rr !== undefined) {
        baseScore = 0.72 * rr + 0.2 * lex + 0.08 * ch
      } else {
        baseScore = 0.85 * lex + 0.15 * ch
      }

      // 严格以未加权的基础相关性过门限，保证无关查询零误报
      if (baseScore < minScore) continue

      const recencyFactor = this.recencyFactors[idx]
      const recencyBoost = chunk.sourceKind === 'worldview_lore' ? 0 : 0.1 * recencyFactor
      const cooccur =
        castHintCount >= 2 && matchedCastCounts[idx] >= 2
          ? matchedCastCounts[idx] >= 3
            ? 0.08
            : 0.05
          : 0
      const finalScore = Math.min(1.2, baseScore + recencyBoost + cooccur)

      scored.push(
        chunkToExcerpt(chunk, {
          score: finalScore,
          denseScore: dense,
          lexicalScore: lex,
          charScore: ch,
          ...(rr !== undefined ? { rerankScore: rr } : {}),
          ...(recencyBoost > 0 ? { recencyBoost } : {})
        })
      )
    }

    if (scored.length === 0) {
      return empty(mode, queries, rerankMode, rerankLatencyMs)
    }

    scored.sort((a, b) => b.score - a.score)
    const topScore = scored[0].score

    // ---- Stage 3：分栏自适应截断 + ±1 相邻上下文扩展 + 滑窗合并 + 均衡配额 ----
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

    // 按 sourceKind 分栏做截断，避免高分剧情块把对白样本和人设截断在门外
    const cutoffCandidates: RagExcerpt[] = []
    for (const kind of ['canon_story', 'dialogue_voice', 'worldview_lore'] as const) {
      const group = scored.filter((item) => item.sourceKind === kind)
      if (group.length === 0) continue
      const groupTop = group[0].score
      for (let i = 0; i < group.length; i++) {
        const item = group[i]
        if (i > 0 && item.score < groupTop * this.adaptive.relativeDropRatio) {
          if (i >= this.adaptive.minChunks) break
        }
        if (
          i >= 2 &&
          item.score < highScore &&
          group[i - 1].score - item.score >= this.adaptive.elbowDropDelta
        ) {
          if (i >= this.adaptive.minChunks) break
        }
        cutoffCandidates.push(item)
        if (i + 1 >= this.adaptive.maxChunks) break
      }
    }
    cutoffCandidates.sort((a, b) => b.score - a.score)

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
          expandedToAdd.push(
            chunkToExcerpt(neighbor, {
              score: anchor.score * 0.96,
              denseScore: anchor.denseScore,
              lexicalScore: anchor.lexicalScore,
              charScore: anchor.charScore,
              recencyBoost: anchor.recencyBoost
            })
          )
        }
      }
      cutoffCandidates.push(...expandedToAdd)
    }

    const merged = mergeAdjacentExcerpts(cutoffCandidates, this.adaptive.mergeAdjacentGap)
    const selected: RagExcerpt[] = []
    const selectedIds = new Set<string>()
    const perStoryCount = new Map<string, number>()
    const selectedTokenSets: Array<Set<string>> = []
    let totalChars = 0

    const trySelect = (item: RagExcerpt): boolean => {
      if (selected.length >= this.adaptive.maxChunks) return false
      if (selectedIds.has(item.id)) return false
      const storyCount = perStoryCount.get(item.storyId) ?? 0
      if (storyCount >= this.adaptive.maxPerStory) return false

      const tokenSet = new Set(tokenizeHybrid(item.text))
      if (
        selectedTokenSets.some(
          (prev) => jaccardSimilarity(prev, tokenSet) > JACCARD_DEDUP_THRESHOLD
        )
      ) {
        return false
      }

      const len = item.text.length
      if (selected.length > 0 && totalChars + len > charBudget) return false

      selected.push(item)
      selectedIds.add(item.id)
      selectedTokenSets.push(tokenSet)
      perStoryCount.set(item.storyId, storyCount + 1)
      totalChars += len
      return true
    }

    // Pass 1：按阶段配额均衡各栏目预算，防止单一类别挤占另外两类
    const quotas = getSectionQuotas(req.stage, charBudget, this.adaptive.maxChunks)
    for (const q of quotas) {
      let sectionChars = 0
      let sectionCount = 0
      const candidates = merged.filter((item) => item.sourceKind === q.kind)
      for (const item of candidates) {
        if (sectionCount >= q.maxSlots) break
        const len = item.text.length
        // 每个非空类别至少允许放入 1 条（只要总 charBudget 容得下），避免较长人设记忆块被小额配额卡掉
        if (sectionCount > 0 && sectionChars + len > q.charCap) continue
        if (trySelect(item)) {
          sectionChars += len
          sectionCount += 1
        }
      }
    }

    // Pass 2：若某类无命中留下剩余配额，按总分回填其余高分候选
    for (const item of merged) {
      if (selected.length >= this.adaptive.maxChunks || totalChars >= charBudget) break
      trySelect(item)
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
