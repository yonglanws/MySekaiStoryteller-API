import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { EmbedCacheIndexFile, RagDomain, Sq8IndexHeader, Sq8VectorMatrix } from './types'

const PJSK_MAGIC = 'PJSK'
const PJSK_VERSION = 1
const QUANT_SQ8_SYM = 2
const HEADER_BYTES = 16

/** 生成与 sekai-story-search 兼容的 32 字符十六进制文本哈希。 */
export function computeChunkHash(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32)
}

/** 将模型名规范为安全的目录名（例如 `BAAI/bge-m3` -> `baai_bge-m3`）。 */
export function modelSlug(model: string): string {
  return (
    model
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'default'
  )
}

/** 原地或复制 L2 归一化为 Float32Array。 */
export function l2Normalize(vec: Float32Array): Float32Array {
  let sumSq = 0
  for (let i = 0; i < vec.length; i++) {
    sumSq += vec[i] * vec[i]
  }
  const norm = Math.sqrt(sumSq)
  if (!Number.isFinite(norm) || norm <= 1e-12) return vec
  const out = new Float32Array(vec.length)
  const inv = 1 / norm
  for (let i = 0; i < vec.length; i++) {
    out[i] = vec[i] * inv
  }
  return out
}

/** 对单条 L2 归一化向量执行对称 INT8（sq8_sym）量化。 */
export function quantizeSq8Sym(vec: Float32Array): { scale: number; data: Int8Array } {
  let maxAbs = 0
  for (let i = 0; i < vec.length; i++) {
    const a = Math.abs(vec[i])
    if (a > maxAbs) maxAbs = a
  }
  const scale = maxAbs > 1e-12 ? maxAbs / 127 : 0
  const data = new Int8Array(vec.length)
  if (scale > 0) {
    const inv = 1 / scale
    for (let i = 0; i < vec.length; i++) {
      const q = Math.round(vec[i] * inv)
      data[i] = q > 127 ? 127 : q < -127 ? -127 : q
    }
  }
  return { scale, data }
}

/** 计算 query (Float32Array) 与 SQ8 矩阵第 row 行的余弦相似度近似值。 */
export function dotSq8Row(
  query: Float32Array,
  matrix: Sq8VectorMatrix,
  row: number
): number {
  const dims = matrix.dims
  if (query.length !== dims) return 0
  const scale = matrix.scales[row]
  if (!scale) return 0
  const base = row * dims
  const data = matrix.data
  let acc = 0
  for (let i = 0; i < dims; i++) {
    acc += query[i] * data[base + i]
  }
  return acc * scale
}

/** 编码 PJSK v1 `sq8_sym` 二进制格式：16B LE 头 + N*f32 scales + N*D*i8 矩阵。 */
export function encodePjskSq8Buffer(matrix: Sq8VectorMatrix): Buffer {
  const { count, dims, scales, data } = matrix
  const scaleBytes = count * 4
  const dataBytes = count * dims
  const buf = Buffer.allocUnsafe(HEADER_BYTES + scaleBytes + dataBytes)

  buf.write(PJSK_MAGIC, 0, 4, 'ascii')
  buf.writeUInt16LE(PJSK_VERSION, 4)
  buf.writeUInt16LE(QUANT_SQ8_SYM, 6)
  buf.writeUInt32LE(count, 8)
  buf.writeUInt32LE(dims, 12)

  for (let i = 0; i < count; i++) {
    buf.writeFloatLE(scales[i], HEADER_BYTES + i * 4)
  }
  Buffer.from(data.buffer, data.byteOffset, dataBytes).copy(buf, HEADER_BYTES + scaleBytes)
  return buf
}

/** 解析 PJSK v1 `sq8_sym` 二进制缓冲区。 */
export function parsePjskSq8Buffer(buf: Buffer): { header: Sq8IndexHeader; matrix: Sq8VectorMatrix } {
  if (buf.byteLength < HEADER_BYTES) {
    throw new Error(`Invalid PJSK SQ8 buffer: too short (${buf.byteLength} bytes)`)
  }
  const magic = buf.toString('ascii', 0, 4)
  const version = buf.readUInt16LE(4)
  const quantType = buf.readUInt16LE(6)
  const count = buf.readUInt32LE(8)
  const dims = buf.readUInt32LE(12)

  if (magic !== PJSK_MAGIC || version !== PJSK_VERSION || quantType !== QUANT_SQ8_SYM) {
    throw new Error(
      `Unsupported PJSK SQ8 header: magic=${magic}, version=${version}, quantType=${quantType}`
    )
  }
  const scaleBytes = count * 4
  const dataBytes = count * dims
  const expectedBytes = HEADER_BYTES + scaleBytes + dataBytes
  if (buf.byteLength < expectedBytes) {
    throw new Error(
      `Truncated PJSK SQ8 buffer: expected ${expectedBytes} bytes, got ${buf.byteLength}`
    )
  }

  const scales = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    scales[i] = buf.readFloatLE(HEADER_BYTES + i * 4)
  }
  const data = new Int8Array(dataBytes)
  for (let i = 0; i < dataBytes; i++) {
    data[i] = buf.readInt8(HEADER_BYTES + scaleBytes + i)
  }

  return {
    header: { magic, version, quantType, count, dims },
    matrix: { count, dims, scales, data }
  }
}

export function writePjskSq8File(filePath: string, matrix: Sq8VectorMatrix): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmpPath, encodePjskSq8Buffer(matrix))
  fs.renameSync(tmpPath, filePath)
}

export function readPjskSq8File(filePath: string): Sq8VectorMatrix {
  return parsePjskSq8Buffer(fs.readFileSync(filePath)).matrix
}

/**
 * 基于 `chunkHash` 的磁盘增量 SQ8 向量缓存：
 * - 目录结构：`<cacheDir>/<modelSlug>-<dims>d/`（未探测维度前用 `<cacheDir>/<modelSlug>/`）；
 * - 复用未变更的 `chunkHash` 向量，仅对新增文本调用 `/embeddings`；
 * - 全内存点积检索，零原生依赖。
 */
export class IncrementalSq8Cache {
  readonly baseDir: string
  readonly model: string
  readonly domain: RagDomain
  private dims: number
  private entries = new Map<string, number>()
  private scales: number[] = []
  private rows: Int8Array[] = []
  private dirty = false
  private loaded = false

  constructor(cacheDir: string, model: string, dims = 0, domain: RagDomain = 'pjsk') {
    this.baseDir = cacheDir
    this.model = model
    this.domain = domain
    this.dims = dims > 0 ? dims : 0
  }

  get dimension(): number {
    return this.dims
  }

  get size(): number {
    return this.entries.size
  }

  stats(): { size: number; dims: number; model: string; domain: RagDomain; dir: string } {
    return {
      size: this.entries.size,
      dims: this.dims,
      model: this.model,
      domain: this.domain,
      dir: this.resolveDir()
    }
  }

  private resolveDir(): string {
    const slug = `${this.domain}-${modelSlug(this.model)}`
    if (this.dims > 0) {
      return path.join(this.baseDir, `${slug}-${this.dims}d`)
    }
    // 自动发现已有 `<domain>-<slug>-<dims>d` 目录（按维度数值挑选，避免字典序误判）
    if (fs.existsSync(this.baseDir)) {
      const prefix = `${slug}-`
      const candidates = fs
        .readdirSync(this.baseDir)
        .map((name) => {
          if (!name.startsWith(prefix)) return null
          const suffix = name.slice(prefix.length)
          const match = /^(\d+)d$/.exec(suffix)
          return match ? { name, dims: Number(match[1]) } : null
        })
        .filter((item): item is { name: string; dims: number } => Boolean(item))
        .sort((a, b) => a.dims - b.dims)
      if (candidates.length > 0) {
        return path.join(this.baseDir, candidates[candidates.length - 1].name)
      }
    }
    return path.join(this.baseDir, slug)
  }

  load(): boolean {
    if (this.loaded) return this.entries.size > 0
    this.loaded = true
    const dir = this.resolveDir()
    const indexPath = path.join(dir, 'embed-cache.index.json')
    const binPath = path.join(dir, 'embed-cache.sq8.bin')
    if (!fs.existsSync(indexPath) || !fs.existsSync(binPath)) return false

    try {
      const meta = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as EmbedCacheIndexFile
      if (meta.domain && meta.domain !== this.domain) return false
      if (meta.schemaVersion !== 1 || meta.model !== this.model || !meta.entries) return false
      const matrix = readPjskSq8File(binPath)
      if (matrix.dims !== meta.dims) return false

      this.dims = matrix.dims
      this.entries.clear()
      this.scales = Array.from(matrix.scales)
      this.rows = new Array(matrix.count)
      for (let i = 0; i < matrix.count; i++) {
        this.rows[i] = matrix.data.slice(i * matrix.dims, (i + 1) * matrix.dims)
      }
      for (const [hash, row] of Object.entries(meta.entries)) {
        if (Number.isInteger(row) && row >= 0 && row < matrix.count) {
          this.entries.set(hash, row)
        }
      }
      return this.entries.size > 0
    } catch {
      return false
    }
  }

  has(chunkHash: string): boolean {
    return this.entries.has(chunkHash)
  }

  dot(query: Float32Array, chunkHash: string): number | null {
    const row = this.entries.get(chunkHash)
    if (row === undefined) return null
    const data = this.rows[row]
    const scale = this.scales[row]
    if (!data || !scale || data.length !== query.length) return null
    let acc = 0
    for (let i = 0; i < data.length; i++) {
      acc += query[i] * data[i]
    }
    return acc * scale
  }

  put(chunkHash: string, vector: Float32Array): void {
    if (vector.length === 0) return
    if (this.dims === 0) {
      this.dims = vector.length
    } else if (this.dims !== vector.length) {
      // 模型维度变化时重置缓存，避免维度错位
      this.dims = vector.length
      this.entries.clear()
      this.scales = []
      this.rows = []
    }
    const { scale, data } = quantizeSq8Sym(l2Normalize(vector))
    const existing = this.entries.get(chunkHash)
    if (existing !== undefined) {
      this.scales[existing] = scale
      this.rows[existing] = data
    } else {
      const idx = this.rows.length
      this.entries.set(chunkHash, idx)
      this.scales.push(scale)
      this.rows.push(data)
    }
    this.dirty = true
  }

  putBatch(items: Array<{ chunkHash: string; vector: Float32Array }>): void {
    for (const item of items) {
      this.put(item.chunkHash, item.vector)
    }
  }

  /**
   * 仅保留 `validHashes` 中的缓存向量并紧凑重建行索引（用于全量语料加载后清理过期哈希）。
   * 返回被清理的条目数。
   */
  prune(validHashes: Iterable<string>): number {
    if (this.entries.size === 0) return 0
    const validSet = validHashes instanceof Set ? validHashes : new Set(validHashes)
    let staleCount = 0
    for (const hash of this.entries.keys()) {
      if (!validSet.has(hash)) staleCount += 1
    }
    if (staleCount === 0) return 0

    const nextEntries = new Map<string, number>()
    const nextScales: number[] = []
    const nextRows: Int8Array[] = []
    for (const [hash, rowIdx] of this.entries) {
      if (!validSet.has(hash)) continue
      const data = this.rows[rowIdx]
      const scale = this.scales[rowIdx]
      if (!data) continue
      nextEntries.set(hash, nextRows.length)
      nextScales.push(scale)
      nextRows.push(data)
    }
    this.entries = nextEntries
    this.scales = nextScales
    this.rows = nextRows
    this.dirty = true
    return staleCount
  }

  save(): void {
    if (!this.dirty || this.dims <= 0) return
    if (this.rows.length === 0 && this.entries.size === 0 && !fs.existsSync(this.resolveDir())) return
    const dir = this.resolveDir()
    fs.mkdirSync(dir, { recursive: true })

    const count = this.rows.length
    const scales = Float32Array.from(this.scales)
    const data = new Int8Array(count * this.dims)
    for (let i = 0; i < count; i++) {
      data.set(this.rows[i], i * this.dims)
    }
    writePjskSq8File(path.join(dir, 'embed-cache.sq8.bin'), { count, dims: this.dims, scales, data })

    const entriesObj: Record<string, number> = {}
    for (const [hash, row] of this.entries) {
      entriesObj[hash] = row
    }
    const indexDoc: EmbedCacheIndexFile = {
      schemaVersion: 1,
      domain: this.domain,
      model: this.model,
      dims: this.dims,
      quant: 'sq8_sym',
      updatedAt: new Date().toISOString(),
      entries: entriesObj
    }
    const indexPath = path.join(dir, 'embed-cache.index.json')
    const tmpPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmpPath, JSON.stringify(indexDoc), 'utf8')
    fs.renameSync(tmpPath, indexPath)
    this.dirty = false
  }
}
