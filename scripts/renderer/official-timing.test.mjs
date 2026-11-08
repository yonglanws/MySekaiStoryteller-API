/**
 * PLAN SNAPSHOT — 与 doc/sekai-exporter-parity-plan.md 同步维护。
 *
 * 锁死 SekaiStoryExporter 已核对的官方时序：
 * - 60 fps 帧基，WaitForSeconds 等价 ceil（整帧不因浮点多等一帧）；
 * - 台词每字 4 帧（两个 0.03s 半字），有语音 +0.05s 延迟 +0.5s，无语音 +2.0s；
 * - 动作收尾闸门：语音结束后仍要等身体动作播完，再等 0.5s；
 * - 对话框首次/关闭后重新打开 +0.2s；
 * - LayoutAppear 116.667ms，LayoutClear 原地 250ms，Move 0.75/0.5/0.333s；
 * - 站位普通 ±350、三人 ±550（参考宽 1920）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const renderer = path.join(root, 'src/renderer/src')

function fixture() {
  const context = vm.createContext({ console })
  const mocks = new Map([
    [
      path.join(root, 'src/common/types/Story.ts'),
      {
        MoveSpeed: { Slow: 'Slow', Normal: 'Normal', Fast: 'Fast', Immediate: 'Immediate' },
        Sides: { Center: 'Center', Left: 'Left', Right: 'Right' },
        LayoutModes: { Normal: 'Normal', Three: 'Three' }
      }
    ]
  ])
  const modules = new Map()
  const compiled = new Map()
  function load(target) {
    const filename = path.isAbsolute(target) ? target : path.join(renderer, target)
    if (mocks.has(filename)) return mocks.get(filename)
    if (modules.has(filename)) return modules.get(filename)
    if (!compiled.has(filename)) {
      compiled.set(
        filename,
        new vm.Script(
          `(function (exports, require) {\n${
            ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
              compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
              fileName: filename
            }).outputText
          }\n})`,
          { filename }
        )
      )
    }
    const exports = {}
    modules.set(filename, exports)
    const require = (name) => {
      if (mocks.has(name)) return mocks.get(name)
      assert.ok(name.startsWith('.'), `Unexpected platform dependency: ${name}`)
      const resolved = path.resolve(path.dirname(filename), `${name}.ts`)
      if (mocks.has(resolved)) return mocks.get(resolved)
      return load(resolved)
    }
    compiled.get(filename).runInContext(context)(exports, require)
    return exports
  }
  return { load }
}

const round = (value) => Math.round(value * 1000) / 1000

test('official frame math follows Unity WaitForSeconds and never adds a phantom frame', () => {
  const { load } = fixture()
  const timing = load(path.join(root, 'src/common/official/timing.ts'))
  assert.equal(timing.STORY_FPS, 60)
  assert.equal(timing.framesForSeconds(0.03), 2)
  assert.equal(timing.framesForSeconds(0.06), 4)
  assert.equal(timing.framesForSeconds(0.1), 6)
  assert.equal(timing.framesForSeconds(0.33), 20)
  assert.equal(timing.framesForSeconds(timing.APPEAR_FADE_TOTAL_MS / 1000), 7)
  assert.equal(timing.framesForSeconds(0), 0)
  assert.equal(timing.framesForSeconds(-1), 0)
  assert.equal(round(timing.framesToMs(4)), 66.667)
  assert.equal(timing.WORD_INTERVAL_FRAMES, 4)
  assert.equal(round(timing.APPEAR_FADE_TOTAL_MS), 116.667)
  assert.equal(round(timing.HIDE_IN_PLACE_TOTAL_MS), 250)
})

test('talk body uses 4 frames per char, voice + 0.5s, silence + 2s, and motion gate', () => {
  const { load } = fixture()
  const talk = load('utils/TalkTiming.ts')
  const twenty = 'あ'.repeat(20)
  assert.equal(round(talk.calculateTalkDurationMs(twenty, 0)), 3333.333)
  assert.equal(round(talk.calculateTalkDurationMs(twenty, 2860)), 3416.667)
  assert.equal(round(talk.calculateTalkDurationMs(twenty, 1000)), 1833.333)
  assert.equal(
    round(talk.calculateTalkDurationMs(twenty, 2860, '', { motionSettleMs: 4000 })),
    4500
  )
  assert.equal(
    round(talk.calculateTalkDurationMs(twenty, 2860, '', { windowOpenMs: 200 })),
    3416.667
  )
  assert.equal(round(talk.calculateTalkDurationMs(twenty, 0, '', { windowOpenMs: 200 })), 3533.333)
  assert.equal(round(talk.talkTypingDurationMs(twenty)), 1333.333)
  const described = talk.describeTalkTiming(twenty, 2860)
  assert.equal(round(described.typingMs), 1333.333)
  assert.equal(round(described.voiceEndMs), 2916.667)
  assert.equal(round(described.gateEndMs), 2916.667)
  assert.equal(round(described.totalMs), 3416.667)
})

test('timeline opens the talk window once, reopens it after HideTalk, and quantizes to frames', () => {
  const { load } = fixture()
  const calculator = load('utils/TimelineCalculator.ts')
  const talk = (delay = 0) => ({
    type: 'Talk',
    wait: true,
    delay,
    data: { speaker: 'a', content: 'あ'.repeat(20), ttsText: '', voice: '', modelId: 1 }
  })
  const durations = Array.from(
    calculator
      .calculateTimeline([
        talk(),
        talk(),
        { type: 'HideTalk', wait: true, delay: 0, data: {} },
        talk()
      ])
      .entries.map((entry) => entry.durationMs)
  )
  assert.deepEqual(durations, [3533.333, 3333.333, 1, 3533.333])
})

test('layout and staging match the official transition map', () => {
  const { load } = fixture()
  const calculator = load('utils/TimelineCalculator.ts')
  const stage = load('utils/StageUtils.ts').default
  const snippet = (type, data) => ({ type, wait: true, delay: 0, data })
  const durations = Array.from(
    calculator
      .calculateTimeline([
        snippet('LayoutAppear', {
          modelId: 1,
          from: { side: 'Left', offset: 0 },
          to: { side: 'Center', offset: 0 },
          moveSpeed: 'Slow'
        }),
        snippet('LayoutClear', {
          modelId: 1,
          from: { side: 'Left', offset: 0 },
          to: { side: 'Left', offset: 0 },
          moveSpeed: 'Slow'
        }),
        // Clear 之后角色已离场；再 Appear 一次，滑动 Clear 才走 750ms 分支。
        snippet('LayoutAppear', {
          modelId: 1,
          from: { side: 'Left', offset: 0 },
          to: { side: 'Center', offset: 0 },
          moveSpeed: 'Slow'
        }),
        snippet('LayoutClear', {
          modelId: 1,
          from: { side: 'Center', offset: 0 },
          to: { side: 'Right', offset: 0 },
          moveSpeed: 'Slow'
        }),
        snippet('Move', {
          modelId: 1,
          from: { side: 'Center', offset: 0 },
          to: { side: 'Center', offset: 0 },
          moveSpeed: 'Fast'
        })
      ])
      .entries.map((entry) => entry.durationMs)
  )
  assert.deepEqual(durations, [116.667, 250, 116.667, 750, 333.333])
  assert.equal(round(stage.side_to_position('Left', 'Normal', 0).x), 0.318)
  assert.equal(round(stage.side_to_position('Right', 'Normal', 0).x), 0.682)
  assert.equal(round(stage.side_to_position('Left', 'Three', 0).x), 0.214)
  assert.equal(round(stage.side_to_position('Right', 'Three', 0).x), 0.786)
  assert.equal(stage.move_speed_to_num('Slow'), 750)
  assert.equal(stage.move_speed_to_num('Normal'), 500)
  assert.equal(round(stage.move_speed_to_num('Fast')), 333.333)
  assert.equal(stage.move_speed_to_num('Immediate'), 0)
})
