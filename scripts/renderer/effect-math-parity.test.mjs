import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createLoader } from '../../apifile/verify2/r4/lib/load-ts.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function load() {
  const context = vm.createContext({ console, Math, Number, Date })
  const loader = createLoader(context)
  return (rel) => loader(path.join(root, rel))
}

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps

test('Move interpolation is exact per story frame (550px / 30f)', () => {
  const mod = load()('src/common/official/layoutMotion.ts')
  // 1920 参考画布上 Center → Right+200 是 550px；导出逻辑画布 1280、resolution 1.5。
  const logicalDelta = (550 / 1920) * 1280
  const from = [640, 360]
  const to = [640 + logicalDelta, 360]
  let prev = mod.interpolatePosition(from, to, 0)
  assert.ok(close(prev[0], 640) && close(prev[1], 360))
  for (let frame = 1; frame <= 30; frame++) {
    const p = mod.interpolatePosition(from, to, frame / 30)
    const step = (p[0] - prev[0]) * 1.5
    assert.ok(close(step, 550 / 30, 1e-9), `frame ${frame} step=${step}`)
    assert.ok(close(p[0] * 1.5, (640 + logicalDelta * (frame / 30)) * 1.5, 1e-9))
    prev = p
  }
  assert.ok(close((prev[0] - from[0]) * 1.5, 550, 1e-9))
  // 静态时重复求值不产生漂移。
  for (let i = 0; i < 100; i++) {
    const hold = mod.interpolatePosition(from, to, 1)
    assert.ok(close(hold[0], prev[0]) && close(hold[1], prev[1]))
  }
})

test('DOShakePosition 0.5s has 8 fade-out segments and ends at rest', () => {
  const shake = load()('src/common/official/screenShake.ts')
  assert.equal(shake.shakeSegmentCount(0.5), 8)
  const ends = shake.shakeSegmentEnds(0.5, true)
  assert.equal(ends.length, 8)
  assert.ok(close(ends.at(-1), 0.5, 1e-12))
  for (let i = 1; i < ends.length; i++) {
    assert.ok(ends[i] > ends[i - 1], 'fade-out segments get longer')
  }
  const tos = Array.from({ length: 8 }, (_, i) => [10 - i, i % 2 ? 2 : -2])
  tos[7] = [0, 0]
  const atStart = shake.shakeSegmentOffset(ends, tos, 0)
  const atEnd = shake.shakeSegmentOffset(ends, tos, 0.5)
  assert.ok(close(atStart[0], 0) && close(atStart[1], 0))
  assert.ok(close(atEnd[0], 0) && close(atEnd[1], 0))
  const mid = shake.shakeSegmentOffset(ends, tos, 0.25)
  assert.ok(Number.isFinite(mid[0]) && Number.isFinite(mid[1]))
})

test('Blur spread ratio matches 3*min(t/d,1) / 3-3*min(t/d,1)', () => {
  const blur = load()('src/common/official/cameraBlur.ts')
  assert.equal(blur.cameraBlurRatio(true, 0.5, 0), 0)
  assert.equal(blur.cameraBlurRatio(true, 0.5, 0.25), 0.5)
  assert.equal(blur.cameraBlurRatio(true, 0.5, 1), 1)
  assert.equal(blur.cameraBlurRatio(true, 2, 1), 0.5)
  assert.equal(blur.cameraBlurRatio(false, 0.5, 0.25), 0.5)
  assert.equal(blur.cameraBlurRatio(false, 0.5, 1), 0)
})

test('seconds-based fade/effect frame counts use f32 frames_for', () => {
  const timing = load()('src/common/official/timing.ts')
  assert.equal(timing.framesForSeconds(3.0), 181)
  assert.equal(timing.framesForSeconds(2.0), 121)
  assert.equal(timing.framesForSeconds(4.0), 241)
  assert.equal(timing.framesForSeconds(25.0), 1501)
  assert.equal(timing.framesForSeconds(0.5), 30)
  assert.equal(timing.msToFrameCount(3000), 180)
})
