import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createLoader } from '../lib/load-ts.mjs'

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
  // 参考像素单位的 Spread 与反函数。
  assert.equal(blur.cameraBlurSpread(true, 0.5, 0.25), 1.5)
  assert.equal(blur.cameraBlurSpread(true, 0.5, 1), 3)
  assert.equal(blur.cameraBlurSpread(true, 2, 1), 1.5)
  assert.equal(blur.cameraBlurSpread(false, 0.5, 0.25), 1.5)
  assert.equal(blur.cameraBlurSpread(false, 0.5, 0), 3)
  assert.ok(close(blur.cameraBlurTweenValue(true, 1, 1.2), 0.4))
  assert.ok(close(blur.cameraBlurTweenValue(false, 1, 1.8), 0.4))
  // 短于 1s 的 In 在 tweenValue=d 时饱和；反演只能回到饱和点。
  assert.ok(close(blur.cameraBlurTweenValue(true, 0.5, 3), 0.5))
})

test('shake plan reproduces DOTween 8-segment decay, angle walk and rest offset', () => {
  const shake = load()('src/common/official/screenShake.ts')
  const rng = () => 0.25
  const plan = shake.buildShakePlan({
    durationSeconds: 0.5,
    strength: 10,
    rng,
    vibrato: 16,
    randomness: 90,
    ignoreZAxis: true,
    fadeOut: true
  })
  assert.equal(plan.segments, 8)
  assert.equal(plan.ends.length, 8)
  assert.equal(plan.offsets.length, 8)
  assert.ok(close(plan.ends.at(-1), 0.5, 1e-12))
  // randomness=0.25 → 游走量 0；初角 90°，每段幅度 10 - i*10/8。
  for (let i = 0; i < 7; i++) {
    const [x, y] = plan.offsets[i]
    assert.ok(close(Math.hypot(x, y), 10 - i * 1.25, 1e-9), `segment ${i} magnitude`)
  }
  const screen = shake.shakeOffsetToScreen([3, 4])
  assert.equal(screen[0], 3)
  assert.equal(screen[1], -4)
  const atRest = (value) => close(value[0], 0) && close(value[1], 0)
  assert.ok(atRest(plan.offsets[7]))
  assert.ok(atRest(shake.shakeOffsetAt(plan, 0)))
  assert.ok(atRest(shake.shakeOffsetAt(plan, 0.5)))
  for (const t of [0.03, 0.1, 0.25, 0.37, 0.49]) {
    const sampled = shake.shakeOffsetAt(plan, t)
    const direct = shake.shakeSegmentOffset(plan.ends, plan.offsets, t)
    assert.ok(close(sampled[0], direct[0]) && close(sampled[1], direct[1]))
  }
})

test('shake plan keeps z-axis scaling only when ignoreZAxis=false', () => {
  const shake = load()('src/common/official/screenShake.ts')
  const base = { durationSeconds: 0.5, strength: 10, rng: () => 0.1 }
  const withZ = shake.buildShakePlan({ ...base, ignoreZAxis: false })
  const noZ = shake.buildShakePlan({ ...base, ignoreZAxis: true })
  // 第三个 RNG 值 0.1 → z 角 -72°，cos=0.309；x 被压到 30.9%。
  assert.ok(Math.abs(withZ.offsets[0][0]) < Math.abs(noZ.offsets[0][0]) * 0.4)
  assert.ok(close(withZ.offsets[0][1], noZ.offsets[0][1]))
  // fadeOut=false 时每段保持原幅度，最后一段仍然归零。
  const hold = shake.buildShakePlan({ ...base, fadeOut: false, ignoreZAxis: true })
  for (let i = 0; i < 7; i++) {
    assert.ok(close(Math.hypot(hold.offsets[i][0], hold.offsets[i][1]), 10, 1e-9))
  }
  assert.ok(close(hold.offsets[7][0], 0) && close(hold.offsets[7][1], 0))
})

test('post effect slot is single-owner: blur wins while active, off clears it', () => {
  const slot = load()('src/renderer/src/effects/PostEffectSlot.ts')
  let owner = 'none'
  owner = slot.nextPostEffectOwner(owner, 'color-filters', false)
  assert.equal(owner, 'color')
  owner = slot.nextPostEffectOwner(owner, 'blur-filter', true)
  assert.equal(owner, 'blur')
  // blur tween 期间 Sepia/Flashback 的 setter 不能叠到 blur 上。
  owner = slot.nextPostEffectOwner(owner, 'color-filters', true)
  assert.equal(owner, 'blur')
  owner = slot.nextPostEffectOwner(owner, 'no-blur-filter', false)
  assert.equal(owner, 'none')
  // 下一次 color 事件重新取得槽位；color off 清空。
  owner = slot.nextPostEffectOwner(owner, 'color-filters', false)
  assert.equal(owner, 'color')
  owner = slot.nextPostEffectOwner(owner, 'no-color-filters', false)
  assert.equal(owner, 'none')
  // CameraColorOff 无条件清空：残留的 blur 也一起结束（下一帧 blur setter 可重写）。
  owner = slot.nextPostEffectOwner('blur', 'no-color-filters', true)
  assert.equal(owner, 'none')
})

test('reference Live2D origin and 2338×1440 background stage rect match SSE', () => {
  const live2d = load()('src/common/official/live2dStage.ts')
  assert.ok(close(live2d.live2dCharacterOriginY(1080, 1), 873.18, 1e-9))
  assert.ok(close(live2d.live2dCharacterOriginY(1080, 0.9), 893.862, 1e-9))

  const bg = load()('src/common/official/backgroundStage.ts')
  assert.deepEqual(
    { ...bg.backgroundStageRect(1920, 1080) },
    {
      x: -209,
      y: -180,
      width: 2338,
      height: 1440
    }
  )
  const logical = bg.backgroundStageRect(1280, 720)
  assert.ok(close(logical.x, -418 / 3))
  assert.ok(close(logical.y, -120))
  assert.ok(close(logical.width, (2338 * 2) / 3))
  assert.ok(close(logical.height, 960))
  // 参考的 scale 规则：content 小于基准时为 1，不会按图片像素 cover。
  assert.equal(bg.backgroundBaseScale(1920, 1080), 1)
  assert.ok(close(bg.backgroundBaseScale(2560, 1080), 2560 / 2338))
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
