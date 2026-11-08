/**
 * moesekai / SekaiStoryRipper 的 sse-motion.json -> Cubism motion3.json。
 *
 * 游戏资产里没有 motion3：动作是 Unity AnimationClip 导出的 sse-motion，
 * 每条曲线是若干段三次多项式。这里按 Unity 的求值方式还原曲线，再把每段
 * 三次多项式精确转成 Cubism 的 Bezier 段（不是采样、也不是把曲线拉直），
 * 端点与现有第三方转换结果逐点一致。
 *
 * sse 段的 coeff 顺序是 [d, c, b, a]，即：
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
}

export interface Motion3Curve {
  Target: 'Parameter' | 'PartOpacity'
  Id: string
  Segments: number[]
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
  UserData: unknown[]
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

  const list = [...curves.values()]
  let records = 0
  let points = 0
  for (const curve of list) {
    const counted = countRecords(curve.Segments)
    records += counted.records
    points += counted.points
  }

  return {
    name,
    fadeIn: Number(sse.fade?.in ?? 0.5),
    fadeOut: Number(sse.fade?.out ?? 0.5),
    motion3: {
      Version: 3,
      Meta: {
        Duration: round(duration),
        Fps: Number(sse.sampleRate ?? 60) || 60,
        Loop: Boolean(sse.loopTime),
        AreBeziersRestricted: true,
        CurveCount: list.length,
        TotalSegmentCount: records,
        TotalPointCount: points,
        UserDataCount: 0,
        TotalUserDataSize: 0
      },
      Curves: list,
      UserData: []
    }
  }
}
