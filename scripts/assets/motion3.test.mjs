import assert from 'node:assert/strict'
import { test } from 'node:test'
import { convertSseMotion } from '../../out-host/host/assets/motion3.js'

const sse = (curves, overrides = {}) => ({
  format: 'sse-motion',
  version: 1,
  name: 'w-test',
  sampleRate: 60,
  startTime: 0,
  stopTime: 1,
  loopTime: false,
  fade: { in: 0.25, out: 0.3 },
  curves,
  ...overrides
})

const parameter = (id, curve) => ({
  binding: { resolved: { target: 'Parameter', id } },
  ...curve
})

/** 按 Cubism motion3 的曲线格式求值：首两个数字是起点，之后是 segment 记录。 */
function evaluate(segments, time) {
  const bezier = (p0, p1, p2, p3, u) => {
    const v = 1 - u
    return v * v * v * p0 + 3 * v * v * u * p1 + 3 * v * u * u * p2 + u * u * u * p3
  }
  let x0 = segments[0]
  let y0 = segments[1]
  let index = 2
  while (index < segments.length) {
    const type = segments[index]
    if (type === 0 || type === 2 || type === 3) {
      const x = segments[index + 1]
      const y = segments[index + 2]
      if (time <= x) {
        if (type === 2) return y0
        if (type === 3) return y
        return x === x0 ? y : y0 + ((y - y0) * (time - x0)) / (x - x0)
      }
      x0 = x
      y0 = y
      index += 3
    } else if (type === 1) {
      const c1x = segments[index + 1]
      const c1y = segments[index + 2]
      const c2x = segments[index + 3]
      const c2y = segments[index + 4]
      const x = segments[index + 5]
      const y = segments[index + 6]
      if (time <= x) {
        let low = 0
        let high = 1
        for (let i = 0; i < 60; i++) {
          const mid = (low + high) / 2
          if (bezier(x0, c1x, c2x, x, mid) < time) low = mid
          else high = mid
        }
        return bezier(y0, c1y, c2y, y, (low + high) / 2)
      }
      x0 = x
      y0 = y
      index += 7
    } else {
      break
    }
  }
  return y0
}

test('constant sse curve becomes a held motion3 segment', () => {
  const converted = convertSseMotion(
    sse([parameter('ParamBrowRY', { kind: 'constant', value: -0.2 })], {
      name: 'face_smile_01'
    })
  )
  assert.equal(converted.name, 'face_smile_01')
  assert.equal(converted.fadeIn, 0.25)
  assert.equal(converted.fadeOut, 0.3)
  assert.equal(converted.motion3.Meta.Duration, 1)
  assert.equal(converted.motion3.Meta.Fps, 60)
  assert.deepEqual(converted.motion3.Curves, [
    {
      Target: 'Parameter',
      Id: 'ParamBrowRY',
      Segments: [0, -0.2, 2, 1, -0.2]
    }
  ])
})

test('streamed cubic curve is converted exactly at its endpoints', () => {
  // 与现有资源同一条曲线的原始 SSE 数据（ParamArmL1, -44 → -41）
  const converted = convertSseMotion(
    sse([
      parameter('ParamArmL1', {
        kind: 'streamed',
        segments: [
          { t: -3.4028235e38, coeff: [0, 0, 0, -44] },
          { t: 0, coeff: [-73.90733, 48.00281, 0, -44] },
          { t: 0.433, coeff: [0, 0, 0, -41] },
          { t: 1, coeff: [0, 0, 0, -41] }
        ]
      })
    ])
  )
  const segments = converted.motion3.Curves[0].Segments
  assert.equal(segments[0], 0)
  assert.equal(segments[1], -44)
  assert.equal(segments[2], 1, 'cubic segment must be a bezier record')
  assert.equal(evaluate(segments, 0), -44)
  assert.ok(Math.abs(evaluate(segments, 0.433) - -41) < 1e-6)
  assert.equal(evaluate(segments, 1), -41)
  // 中间点应忠实保留三次曲线（旧转换把它拉直会偏 0.5 度以上）
  assert.ok(evaluate(segments, 0.2) < -42.6)
})

test('linear and stepped curves use the compact record types', () => {
  const converted = convertSseMotion(
    sse([
      parameter('ParamA', {
        kind: 'streamed',
        segments: [
          { t: 0, coeff: [0, 0, 0, 0] },
          { t: 0.5, coeff: [0, 0, 10, 5] }
        ]
      }),
      parameter('ParamB', {
        kind: 'streamed',
        segments: [
          { t: 0, coeff: [0, 0, 0, 1] },
          { t: 1, coeff: [0, 0, 0, 1] }
        ]
      })
    ])
  )
  const a = converted.motion3.Curves.find((curve) => curve.Id === 'ParamA').Segments
  assert.deepEqual(a, [0, 0, 2, 0.5, 0, 0, 1, 10])
  const b = converted.motion3.Curves.find((curve) => curve.Id === 'ParamB').Segments
  assert.deepEqual(b, [0, 1, 2, 1, 1])
})

test('unresolved bindings are skipped and PartOpacity targets are kept', () => {
  const converted = convertSseMotion(
    sse([
      { binding: { resolved: null }, kind: 'constant', value: 1 },
      parameter('ParamA', { kind: 'constant', value: 0.5 }),
      {
        binding: { resolved: { target: 'PartOpacity', id: 'PartArmL' } },
        kind: 'constant',
        value: 0.75
      }
    ])
  )
  assert.equal(converted.motion3.Curves.length, 2)
  const part = converted.motion3.Curves.find((curve) => curve.Id === 'PartArmL')
  assert.equal(part.Target, 'PartOpacity')
  assert.equal(converted.motion3.Meta.CurveCount, 2)
})

test('unknown curve kinds fail the single clip instead of producing bad data', () => {
  assert.throws(
    () => convertSseMotion(sse([parameter('ParamA', { kind: 'mystery' })])),
    /unsupported sse-motion curve kind/
  )
})
