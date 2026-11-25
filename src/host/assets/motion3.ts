/**
 * moesekai / SekaiStoryRipper 的 sse-motion.json 及 sekai-serve canonical live2d-motion
 * -> Cubism motion3.json 转换器。
 *
 * 游戏资产里没有 motion3：动作是 Unity AnimationClip 导出的 sse-motion 或
 * canonical `live2d-motion`（clip v2 + CRC-32 path/attribute 绑定）。
 * 这里按 Unity 的求值方式还原曲线，再把每段三次多项式精确转成 Cubism 的 Bezier 段
 * （不是采样、也不是把曲线拉直），端点与现有第三方转换结果逐点一致。
 *
 * sse / clip v2 段的 coeff 顺序是 [d, c, b, a]，即：
 *   value(dt) = a + b*dt + c*dt^2 + d*dt^3, dt = t - segment.t
 */

export interface SseCurveSegment {
  t: number
  coeff: number[]
}

export interface SseCurve {
  binding?: {
    resolved?: {
      target?: string
      id?: string
    } | null
  }
  kind?: string
  value?: number
  segments?: SseCurveSegment[]
}

export interface SseMotionEvent {
  time?: number
  function?: string
  data?: string
  float?: number
  int?: number
}

export interface SseMotion {
  format?: string
  version?: number
  name?: string
  sampleRate?: number
  startTime?: number
  stopTime?: number
  loopTime?: boolean
  fade?: { in?: number; out?: number }
  curves?: SseCurve[]
  events?: SseMotionEvent[]
}

export interface Live2DClipCurve {
  path: number
  attribute: number
  class_id?: number
  script?: string | null
  custom_type?: number
  component?: number
  kind?: string
  value?: number
  segments?: number[][]
  begin_time?: number
  sample_rate?: number
  samples?: number[]
}

export interface Live2DClip {
  format?: string
  version?: number
  name?: string
  sample_rate?: number
  start_time?: number
  stop_time?: number
  loop?: boolean
  curves?: Live2DClipCurve[]
  events?: SseMotionEvent[]
}

export interface Live2DMotionDocument {
  format?: string
  version?: number
  fade_in?: number | null
  fade_out?: number | null
  clip?: Live2DClip
}

export interface Moc3BindingResolver {
  resolve: (
    pathHash: number,
    attributeHash: number
  ) => { target: 'Parameter' | 'PartOpacity'; id: string } | null
}

/** `crc32("Value")`: 驱动 Live2D Parameter 的属性哈希 */
export const LIVE2D_PARAMETER_ATTRIBUTE_HASH = 0xdcb67730
/** `crc32("Opacity")`: 驱动 Live2D PartOpacity 的属性哈希 */
export const LIVE2D_PART_ATTRIBUTE_HASH = 0x8c4054fa

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

/** 计算标准 IEEE CRC-32（与 Unity AnimationClip path/attribute 哈希一致）。 */
export function crc32Utf8(value: string): number {
  let crc = 0xffffffff
  const bytes = Buffer.from(value, 'utf8')
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 从 `.moc3` 二进制（或已知参数/部件 ID 列表）构建 CRC-32 绑定解析器。 */
export function buildMoc3BindingResolver(
  moc3OrIds: Buffer | readonly string[]
): Moc3BindingResolver {
  const ids = Array.isArray(moc3OrIds)
    ? moc3OrIds
    : (Buffer.from(moc3OrIds as Buffer)
        .toString('latin1')
        .match(/[A-Za-z0-9_.-]{2,64}/g) ?? [])

  const paramByHash = new Map<number, string>()
  const partByHash = new Map<number, string>()
  for (const rawId of ids) {
    const id = String(rawId).trim()
    if (!id) continue
    paramByHash.set(crc32Utf8(`Parameters/${id}`), id)
    partByHash.set(crc32Utf8(`Parts/${id}`), id)
  }

  return {
    resolve(pathHash: number, attributeHash: number) {
      if (attributeHash === LIVE2D_PARAMETER_ATTRIBUTE_HASH) {
        const id = paramByHash.get(pathHash >>> 0)
        return id ? { target: 'Parameter', id } : null
      }
      if (attributeHash === LIVE2D_PART_ATTRIBUTE_HASH) {
        const id = partByHash.get(pathHash >>> 0)
        return id ? { target: 'PartOpacity', id } : null
      }
      return null
    }
  }
}

export interface Motion3Curve {
  Target: 'Parameter' | 'PartOpacity'
  Id: string
  Segments: number[]
}

export interface Motion3UserData {
  /** 事件时间（秒）。 */
  Time: number
  /** `OnLive2DInvokeUserData` 的 data，例如 `eyeblink,0.2,0.24,0.24`。 */
  Value: string
}

export interface Motion3File {
  Version: 3
  Meta: {
    Duration: number
    Fps: number
    Loop: boolean
    AreBeziersRestricted: boolean
    CurveCount: number
    TotalSegmentCount: number
    TotalPointCount: number
    UserDataCount: number
    TotalUserDataSize: number
  }
  Curves: Motion3Curve[]
  UserData: Motion3UserData[]
}

export interface ConvertedMotion {
  name: string
  fadeIn: number
  fadeOut: number
  motion3: Motion3File
}

const round = (value: number): number => {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 1_000_000) / 1_000_000
}

/** sse 的 [d, c, b, a] -> a + b*dt + c*dt^2 + d*dt^3 */
function evaluate(coeff: number[], dt: number): number {
  const a = coeff[3] ?? 0
  const b = coeff[2] ?? 0
  const c = coeff[1] ?? 0
  const d = coeff[0] ?? 0
  return a + b * dt + c * dt * dt + d * dt * dt * dt
}

/** 该段是否退化为线性（二次项与三次项都为 0） */
function isLinear(coeff: number[]): boolean {
  return Math.abs(coeff[0] ?? 0) < 1e-12 && Math.abs(coeff[1] ?? 0) < 1e-12
}

/** 该段是否完全静止 */
function isConstant(coeff: number[]): boolean {
  return isLinear(coeff) && Math.abs(coeff[2] ?? 0) < 1e-12
}

function buildDenseSegments(
  beginTimeRaw: number | undefined,
  sampleRateRaw: number | undefined,
  samplesRaw: number[] | undefined,
  duration: number
): number[] {
  const samples = Array.isArray(samplesRaw) ? samplesRaw.map(Number) : []
  if (samples.length === 0) return [0, 0]
  const beginTime = Math.max(0, Number(beginTimeRaw ?? 0) || 0)
  const sampleRate = Math.max(1e-6, Number(sampleRateRaw ?? 60) || 60)
  const step = 1 / sampleRate
  const firstVal = round(samples[0] ?? 0)
  const segments: number[] = [0, firstVal]
  if (beginTime > 0) {
    segments.push(2, round(beginTime), firstVal)
  }
  for (let i = 1; i < samples.length; i++) {
    const t = beginTime + i * step
    if (t > duration) break
    segments.push(0, round(t), round(samples[i] ?? 0))
  }
  const lastT = beginTime + (samples.length - 1) * step
  if (lastT < duration) {
    segments.push(2, round(duration), round(samples[samples.length - 1] ?? 0))
  }
  return segments
}

function buildSegments(curve: SseCurve, duration: number): number[] {
  if (curve.kind === 'constant') {
    const value = round(Number(curve.value ?? 0))
    // 首两个数字是曲线起点 [time, value]，之后才是 segment 记录
    return [0, value, 2, round(duration), value]
  }

  if (curve.kind !== 'streamed') {
    throw new Error(`unsupported sse-motion curve kind: ${String(curve.kind)}`)
  }

  const raw = (curve.segments ?? []).filter((segment) => Number(segment.t) > -1e30)
  if (raw.length === 0) return [0, 0]

  const points: SseCurveSegment[] = raw.map((segment) => ({
    t: Math.max(0, Number(segment.t)),
    coeff: (segment.coeff ?? []).map(Number)
  }))

  const first = points[0]
  const firstValue = round(evaluate(first.coeff, 0))
  const segments: number[] = [first.t, firstValue]

  for (let index = 0; index < points.length - 1; index++) {
    const from = points[index]
    const to = points[index + 1]
    const span = to.t - from.t
    if (!(span > 0)) continue

    const startValue = evaluate(from.coeff, 0)
    const endValue = evaluate(from.coeff, span)

    if (isConstant(from.coeff)) {
      segments.push(2, round(to.t), round(startValue))
      continue
    }

    if (isLinear(from.coeff)) {
      segments.push(0, round(to.t), round(endValue))
      continue
    }

    // 三次多项式在 [0, T] 上转成 Bezier：控制点取 T/3、2T/3 处的多项式值
    const p1 = evaluate(from.coeff, span / 3)
    const p2 = evaluate(from.coeff, (span * 2) / 3)
    segments.push(
      1,
      round(from.t + span / 3),
      round(p1),
      round(from.t + (span * 2) / 3),
      round(p2),
      round(to.t),
      round(endValue)
    )
  }

  // 曲线在 stopTime 之前结束：最后一段多项式继续求值到成片结束，而不是停在起点
  const last = points[points.length - 1]
  if (last.t < duration) {
    const span = duration - last.t
    const startValue = evaluate(last.coeff, 0)
    const endValue = evaluate(last.coeff, span)
    if (isConstant(last.coeff)) {
      segments.push(2, round(duration), round(startValue))
    } else if (isLinear(last.coeff)) {
      segments.push(0, round(duration), round(endValue))
    } else {
      const p1 = evaluate(last.coeff, span / 3)
      const p2 = evaluate(last.coeff, (span * 2) / 3)
      segments.push(
        1,
        round(last.t + span / 3),
        round(p1),
        round(last.t + (span * 2) / 3),
        round(p2),
        round(duration),
        round(endValue)
      )
    }
  }

  return segments
}

function countRecords(segments: number[]): { records: number; points: number } {
  let records = 0
  let points = 1
  let index = 2
  while (index < segments.length) {
    const type = segments[index]
    if (type === 1) {
      index += 7
      records += 1
      points += 3
    } else if (type === 0 || type === 2 || type === 3) {
      index += 3
      records += 1
      points += 1
    } else {
      break
    }
  }
  return { records, points }
}

function buildMotion3File(params: {
  name: string
  duration: number
  fps: number
  loop: boolean
  fadeIn: number
  fadeOut: number
  curves: Map<string, Motion3Curve>
  events?: SseMotionEvent[]
}): ConvertedMotion {
  const list = [...params.curves.values()]
  let records = 0
  let points = 0
  for (const curve of list) {
    const counted = countRecords(curve.Segments)
    records += counted.records
    points += counted.points
  }

  // `OnLive2DInvokeUserData` 事件 -> motion3 `UserData`（pixi 以 `motion:<Value>` 发出，
  // AdvancedModel 的眨眼控制器消费其中的 `eyeblink,...`）。
  const userData: Motion3UserData[] = (params.events ?? [])
    .filter(
      (event) =>
        event &&
        String(event.function ?? '') === 'OnLive2DInvokeUserData' &&
        event.data !== undefined
    )
    .map((event) => ({
      Time: round(Math.max(0, Number(event.time ?? 0) || 0)),
      Value: String(event.data ?? '')
    }))
    .sort((a, b) => a.Time - b.Time)

  return {
    name: params.name,
    fadeIn: params.fadeIn,
    fadeOut: params.fadeOut,
    motion3: {
      Version: 3,
      Meta: {
        Duration: round(params.duration),
        Fps: params.fps,
        Loop: params.loop,
        AreBeziersRestricted: true,
        CurveCount: list.length,
        TotalSegmentCount: records,
        TotalPointCount: points,
        UserDataCount: userData.length,
        TotalUserDataSize: userData.reduce((sum, entry) => sum + entry.Value.length, 0)
      },
      Curves: list,
      UserData: userData
    }
  }
}

/**
 * 把一条 sse-motion 转成 Cubism motion3。
 *
 * @throws 曲线类型未知、目标不是 Parameter/PartOpacity 时抛错（宁可让调用方看见
 *         单个动作失败，也不生成一条静默错误的曲线）。未解析的 binding 会被跳过。
 */
export function convertSseMotion(raw: unknown): ConvertedMotion {
  if (!raw || typeof raw !== 'object') {
    throw new Error('sse-motion: expected an object')
  }
  const sse = raw as SseMotion
  if (sse.format !== undefined && sse.format !== 'sse-motion') {
    throw new Error(`sse-motion: unsupported format ${String(sse.format)}`)
  }

  const name = String(sse.name ?? 'motion')
  const duration = Math.max(0.001, Number(sse.stopTime ?? 0) || 0)
  const curves = new Map<string, Motion3Curve>()

  for (const curve of sse.curves ?? []) {
    const resolved = curve.binding?.resolved
    if (!resolved?.id) continue
    const target =
      resolved.target === 'PartOpacity'
        ? 'PartOpacity'
        : resolved.target === 'Parameter'
          ? 'Parameter'
          : null
    if (!target) continue

    const key = `${target}:${resolved.id}`
    curves.set(key, {
      Target: target,
      Id: resolved.id,
      Segments: buildSegments(curve, duration)
    })
  }

  return buildMotion3File({
    name,
    duration,
    fps: Number(sse.sampleRate ?? 60) || 60,
    loop: Boolean(sse.loopTime),
    fadeIn: Number(sse.fade?.in ?? 0.5),
    fadeOut: Number(sse.fade?.out ?? 0.5),
    curves,
    events: sse.events
  })
}

/**
 * 把 sekai-serve canonical `live2d-motion`（clip v2 + CRC-32 绑定）转成 Cubism motion3。
 */
export function convertLive2DMotion(
  raw: unknown,
  resolver: Moc3BindingResolver,
  fallbackName = 'motion'
): ConvertedMotion {
  if (!raw || typeof raw !== 'object') {
    throw new Error('live2d-motion: expected an object')
  }
  const doc = raw as Live2DMotionDocument
  if (doc.format !== 'live2d-motion' || !doc.clip || typeof doc.clip !== 'object') {
    throw new Error(`live2d-motion: unsupported format ${String(doc.format)}`)
  }
  const clip = doc.clip
  const name = String(clip.name ?? fallbackName)
  const duration = Math.max(0.001, Number(clip.stop_time ?? 0) || 0)
  const curves = new Map<string, Motion3Curve>()

  for (const curve of clip.curves ?? []) {
    const resolved = resolver.resolve(curve.path, curve.attribute)
    if (!resolved) continue
    let segments: number[]
    if (curve.kind === 'dense') {
      segments = buildDenseSegments(curve.begin_time, curve.sample_rate, curve.samples, duration)
    } else if (curve.kind === 'streamed') {
      const sseLike: SseCurve = {
        kind: 'streamed',
        segments: (curve.segments ?? []).map((seg) => ({
          t: Number(seg[0] ?? 0),
          coeff: [
            Number(seg[1] ?? 0),
            Number(seg[2] ?? 0),
            Number(seg[3] ?? 0),
            Number(seg[4] ?? 0)
          ]
        }))
      }
      segments = buildSegments(sseLike, duration)
    } else if (curve.kind === 'constant') {
      segments = buildSegments({ kind: 'constant', value: curve.value }, duration)
    } else {
      throw new Error(`unsupported live2d-motion curve kind: ${String(curve.kind)}`)
    }

    const key = `${resolved.target}:${resolved.id}`
    curves.set(key, {
      Target: resolved.target,
      Id: resolved.id,
      Segments: segments
    })
  }

  return buildMotion3File({
    name,
    duration,
    fps: Number(clip.sample_rate ?? 60) || 60,
    loop: Boolean(clip.loop),
    fadeIn: typeof doc.fade_in === 'number' && Number.isFinite(doc.fade_in) ? doc.fade_in : 0.5,
    fadeOut: typeof doc.fade_out === 'number' && Number.isFinite(doc.fade_out) ? doc.fade_out : 0.5,
    curves,
    events: clip.events
  })
}

/** 自动识别 `live2d-motion` 与 `sse-motion` 并转换为 Cubism motion3。 */
export function convertAnyMotion(
  raw: unknown,
  resolver?: Moc3BindingResolver,
  fallbackName = 'motion'
): ConvertedMotion {
  if (raw && typeof raw === 'object' && (raw as { format?: unknown }).format === 'live2d-motion') {
    if (!resolver) {
      throw new Error('live2d-motion requires a Moc3BindingResolver')
    }
    return convertLive2DMotion(raw, resolver, fallbackName)
  }
  return convertSseMotion(raw)
}
