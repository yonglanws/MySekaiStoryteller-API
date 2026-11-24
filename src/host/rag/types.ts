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
  scenarioId: string
  /** unit | event | card | talk | self | special | persona */
  type: string
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
  scenarioId: string
  type: string
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
