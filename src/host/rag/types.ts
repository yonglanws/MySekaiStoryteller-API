/**
 * 自适应语义 RAG 类型定义（与 StarMoe-org/sekai-story-search 兼容）。
 */

export type RagDomain = 'pjsk'

export type RagSourceKind = 'canon_story' | 'dialogue_voice' | 'worldview_lore'

export type RerankMode = 'reranked' | 'fallback' | 'disabled'

export interface RagChunk {
  id: string
  /** 领域隔离标记：MSST 仅接受 Project SEKAI ('pjsk') */
  domain?: RagDomain
  /** sha256(text).slice(0, 32)，用于 bit-for-bit 增量向量缓存复用 */
  chunkHash: string
  sourceKind: RagSourceKind
  storyId: string
  story: string
  ep?: string
  epTitle?: string
  scenarioId: string
  /** unit | event | event_synopsis | card | talk | self | special | persona */
  type: string
  /** 所属组合标签（25时 / WS / VBS / MMJ / L/n / VS / 混活） */
  unit?: string
  /** 活动期数编号（如 145、210），用于时效加权 */
  eventNum?: number
  /** 活动或剧情年份（如 2025、2026） */
  eventYear?: number
  /** 是否属于 2025/2026 近期新剧本（含 jp_new_stories） */
  isRecent2025_2026?: boolean
  /** 语料对白语言（'cn' | 'jp'） */
  lang?: 'cn' | 'jp'
  /** 可选场景/演出/梗概标记 */
  tags?: string[]
  chars: string[]
  charIds?: number[]
  lineStart: number
  lineEnd: number
  text: string
  /** 可选日文样本（有则供翻译阶段参考） */
  jpText?: string
}

export interface RagExcerpt {
  id: string
  sourceKind: RagSourceKind
  storyId: string
  story: string
  ep?: string
  epTitle?: string
  scenarioId: string
  type: string
  unit?: string
  eventNum?: number
  isRecent2025_2026?: boolean
  lang?: 'cn' | 'jp'
  chars: string[]
  lineStart: number
  lineEnd: number
  text: string
  jpText?: string
  score: number
  denseScore: number
  lexicalScore: number
  charScore: number
  rerankScore?: number
  recencyBoost?: number
}

export interface RagCastMemberHint {
  name: string
  fullName?: string
  aliases?: string[]
  charId?: number
}

export interface RagRetrievalQueries {
  plot?: string
  voice?: string
  worldview?: string
}

export interface RagRetrieveRequest {
  prompt: string
  stage: 'cast' | 'dialogue' | 'single'
  cast?: RagCastMemberHint[]
  event?: string
  logline?: string
  outline?: string[]
  location?: string
  retrievalQueries?: RagRetrievalQueries
  /** 可选硬上限（例如 Pass A 选角前检索 <= 1500 字符） */
  maxCharBudget?: number
  signal?: AbortSignal
}

export interface RagSections {
  canonPlot: RagExcerpt[]
  dialogueVoice: RagExcerpt[]
  worldviewLore: RagExcerpt[]
}

export type RagMode = 'hybrid' | 'lexical_fallback' | 'disabled'

export interface RagRetrieveResult {
  domain?: RagDomain
  mode: RagMode
  model: string
  rerankMode?: RerankMode
  rerankModel?: string
  rerankLatencyMs?: number
  expandedCount?: number
  queries: string[]
  candidateCount: number
  selectedCount: number
  totalChars: number
  charBudget: number
  topScore: number
  latencyMs: number
  sections: RagSections
  /** 已格式化的 Markdown 注入块；无命中时为空字符串 */
  promptBlock: string
}

export interface RagMetaSummary {
  domain?: RagDomain
  mode: RagMode
  model: string
  rerankMode?: RerankMode
  rerankModel?: string
  rerankLatencyMs?: number
  expandedCount?: number
  selectedCount: number
  totalChars: number
  topScore: number
  latencyMs: number
}

export interface ScenarioContextResult {
  scenarioId: string
  storyId: string
  story: string
  ep?: string
  epTitle?: string
  unit?: string
  eventNum?: number
  isRecent2025_2026?: boolean
  lang?: 'cn' | 'jp'
  totalChunks: number
  windowStartIdx: number
  windowEndIdx: number
  lineStart: number
  lineEnd: number
  text: string
  chunks: RagChunk[]
}

export interface StoryCatalogScenarioSummary {
  scenarioId: string
  ep?: string
  epTitle?: string
  chunkCount: number
}

export interface StoryCatalogSummary {
  storyId: string
  story: string
  type: string
  sourceKind: RagSourceKind
  unit?: string
  eventNum?: number
  isRecent2025_2026?: boolean
  lang?: 'cn' | 'jp'
  scenarios: StoryCatalogScenarioSummary[]
}

export interface ListStoriesFilter {
  query?: string
  unit?: string
  sourceKind?: RagSourceKind
  recentOnly?: boolean
  limit?: number
}

export interface RagStructuredRetrieveResult extends RagRetrieveResult {
  expandedContexts: ScenarioContextResult[]
  availableStories: StoryCatalogSummary[]
}

export interface Sq8IndexHeader {
  magic: string
  version: number
  quantType: number
  count: number
  dims: number
}

export interface Sq8VectorMatrix {
  count: number
  dims: number
  scales: Float32Array
  data: Int8Array
}

export interface EmbedCacheIndexFile {
  schemaVersion: number
  domain?: RagDomain
  model: string
  dims: number
  quant: 'sq8_sym'
  updatedAt: string
  /** chunkHash -> row index in embed-cache.sq8.bin */
  entries: Record<string, number>
}
