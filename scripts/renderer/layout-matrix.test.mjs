/**
 * 布局矩阵回归：Appear / Clear / Move × Slow/Normal/Fast/Immediate × 位移/原地。
 *
 * 这张表直接对应官方 `ScenarioCharacterLayout`：
 * - Appear 只等淡入 7 帧（1 帧 alpha=0 + 6 帧淡入），滑入继续在后台；
 * - Clear 原地 9+6=15 帧；滑动 fade 从 move-6 帧开始，总长 move；
 * - Move 按 MoveSpeedType 20/30/45 帧，Immediate 0；
 * - timeline 与 plan 的 moveEnd/fade 帧必须逐项一致。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadAuditRuntime } from '../stories/official-plan-audit.mjs'

const runtime = loadAuditRuntime()
const { timeline, plan, timing } = runtime

const speeds = ['Slow', 'Normal', 'Fast', 'Immediate']
const framesForSpeed = (speed) =>
  timing.framesForSeconds(timing.MOVE_SPEED_DURATION_MS[speed] / 1000)

const sides = {
  inPlace: { from: { side: 'Left', offset: 0 }, to: { side: 'Left', offset: 0 } },
  moved: { from: { side: 'Left', offset: 0 }, to: { side: 'Right', offset: 0 } }
}

function layoutSnippet(type, speed, position) {
  return {
    type,
    wait: true,
    delay: 0,
    data: {
      modelId: 1,
      ...sides[position],
      moveSpeed: speed,
      ...(type === 'Move' ? { motion: '', facial: '' } : {})
    }
  }
}

function run(type, speed, position) {
  const snippet = layoutSnippet(type, speed, position)
  // Clear 只在角色已显示时走滑动/淡出分支；补一条前置 Appear 建立在场状态。
  const track =
    type === 'LayoutClear'
      ? [layoutSnippet('LayoutAppear', 'Normal', 'inPlace'), snippet]
      : [snippet]
  const result = timeline.calculateTimeline(track, new Map())
  const baked = plan.bakeStoryPlan(track, result.entries)
  const index = track.length - 1
  return {
    durationMs: result.entries[index].durationMs,
    durationFrames: baked.entries[index].durationFrames,
    startFrame: baked.entries[index].startFrame,
    layout: baked.entries[index].layout,
    estimatedMs: timeline.estimateSnippetDuration(snippet)
  }
}

test('LayoutAppear always completes on the 7-frame fade; move continues in background', () => {
  for (const speed of speeds) {
    for (const position of ['inPlace', 'moved']) {
      const result = run('LayoutAppear', speed, position)
      assert.equal(result.durationFrames, timing.APPEAR_FADE_TOTAL_FRAMES, `${speed}/${position}`)
      assert.equal(result.durationMs, timing.APPEAR_FADE_TOTAL_MS, `${speed}/${position}`)
      assert.equal(result.estimatedMs, timing.APPEAR_FADE_TOTAL_MS, `${speed}/${position}`)
      assert.equal(result.layout.fadeStartFrame, 1, `${speed}/${position}`)
      assert.equal(
        result.layout.fadeEndFrame,
        timing.APPEAR_FADE_TOTAL_FRAMES,
        `${speed}/${position}`
      )
      assert.equal(result.layout.moveEndFrame, framesForSpeed(speed), `${speed}/${position}`)
    }
  }
})

test('LayoutClear in place is 15 frames; sliding ends exactly when the fade ends', () => {
  const fadeFrames = timing.framesForSeconds(timing.CHARACTER_FADE_MS / 1000)
  for (const speed of speeds) {
    const inPlace = run('LayoutClear', speed, 'inPlace')
    assert.equal(inPlace.durationFrames, timing.HIDE_IN_PLACE_TOTAL_FRAMES, `${speed}/in-place`)
    assert.equal(inPlace.layout.moveEndFrame, inPlace.startFrame, `${speed}/in-place`)
    assert.equal(
      inPlace.layout.fadeStartFrame - inPlace.startFrame,
      timing.framesForSeconds(timing.HIDE_DELAY_IN_PLACE_MS / 1000),
      `${speed}/in-place`
    )
    assert.equal(
      inPlace.layout.fadeEndFrame - inPlace.startFrame,
      timing.HIDE_IN_PLACE_TOTAL_FRAMES,
      `${speed}/in-place`
    )

    const moved = run('LayoutClear', speed, 'moved')
    const moveFrames = framesForSpeed(speed)
    const expected = Math.max(fadeFrames, moveFrames)
    assert.equal(moved.durationFrames, expected, `${speed}/moved`)
    assert.equal(moved.layout.moveEndFrame - moved.startFrame, moveFrames, `${speed}/moved`)
    assert.equal(
      moved.layout.fadeStartFrame - moved.startFrame,
      Math.max(0, moveFrames - fadeFrames),
      `${speed}/moved`
    )
    assert.equal(moved.layout.fadeEndFrame - moved.startFrame, expected, `${speed}/moved`)
  }
})

test('repeated Appear slides 12 frames without a fade; hidden Clear finishes immediately', () => {
  const appear = layoutSnippet('LayoutAppear', 'Slow', 'moved')
  const clear = layoutSnippet('LayoutClear', 'Slow', 'moved')
  const track = [appear, appear, clear, clear]
  const result = timeline.calculateTimeline(track, new Map())
  const baked = plan.bakeStoryPlan(track, result.entries)

  assert.equal(
    baked.entries[1].durationFrames,
    timing.APPEAR_SHOWN_MOVE_FRAMES,
    '已在场 Appear 应只滑 0.2s'
  )
  assert.equal(baked.entries[1].layout.fadeStartFrame, null)
  assert.equal(baked.entries[1].layout.fadeEndFrame, null)
  assert.equal(
    baked.entries[1].layout.moveEndFrame - baked.entries[1].startFrame,
    timing.APPEAR_SHOWN_MOVE_FRAMES
  )

  assert.equal(baked.entries[2].durationFrames, framesForSpeed('Slow'))
  assert.equal(baked.entries[3].durationFrames, 0, '未在场 Clear 应立即完成')
  assert.equal(baked.entries[3].layout.fadeStartFrame, null)
  assert.equal(baked.entries[3].layout.fadeEndFrame, null)
  assert.equal(baked.entries[3].layout.moveEndFrame, baked.entries[3].startFrame)
})

test('Move waits exactly the MoveSpeedType duration, including zero for Immediate', () => {
  for (const speed of speeds) {
    for (const position of ['inPlace', 'moved']) {
      const result = run('Move', speed, position)
      const expected = framesForSpeed(speed)
      assert.equal(result.durationFrames, expected, `${speed}/${position}`)
      assert.equal(result.layout.moveEndFrame, expected, `${speed}/${position}`)
      assert.equal(result.estimatedMs, timing.framesToMs(expected), `${speed}/${position}`)
    }
  }
})

test('exact effect durations are not padded to the 500ms minimum', () => {
  const cases = [
    ['BlackIn', { duration: 100, color: 'white' }, 100],
    ['BlackOut', { duration: 100, color: 'white' }, 100],
    ['Wipe', { mode: 'in', direction: 'right', duration: 400 }, 400],
    ['ShakeScreen', { duration: 500, amplitude: 0.01 }, 500],
    ['CameraMove', { x: 10, y: 0, duration: 0 }, 0],
    ['CameraZoom', { scale: 1.2, duration: 0 }, 0],
    ['PlaySe', { file: 'se.mp3', volume: 1, loop: false, fadeMs: 0 }, 0]
  ]
  const snippets = cases.map(([type, data]) => ({ type, wait: true, delay: 0, data }))
  const result = timeline.calculateTimeline(snippets, new Map())
  cases.forEach(([type, , expected], index) => {
    assert.equal(result.entries[index].durationMs, expected, type)
  })
})
