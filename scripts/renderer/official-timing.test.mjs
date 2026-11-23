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

test('framesForSeconds follows Unity f32 accumulation, not a 1e-3 ceil', () => {
  const { load } = fixture()
  const timing = load(path.join(root, 'src/common/official/timing.ts'))
  assert.equal(timing.STORY_FPS, 60)
  const cases = [
    [0.06, 4],
    [0.1, 6],
    [0.12, 8],
    [0.125, 8],
    [0.15, 9],
    [0.2, 12],
    [0.25, 15],
    [0.3, 18],
    [0.33333334, 20],
    [0.5, 30],
    [0.51, 31],
    [0.75, 46],
    [1.0, 61],
    [1.5, 91],
    [2.0, 121],
    [2.5, 151],
    [3.0, 181],
    [5.0, 300],
    [10.0, 600],
    [30.0, 1801]
  ]
  for (const [seconds, frames] of cases) {
    assert.equal(timing.framesForSeconds(seconds), frames, `framesForSeconds(${seconds})`)
  }
  assert.equal(timing.framesForSeconds(2.05), 124)
  assert.equal(timing.framesForSeconds(3.05), 184)
  assert.equal(timing.framesForSeconds(0), 0)
  assert.equal(timing.framesForSeconds(-1), 0)
  assert.equal(timing.framesForSeconds(Number.NaN), 0)
  assert.equal(timing.framesForSeconds(Number.POSITIVE_INFINITY), 0xffffffff)
  assert.equal(round(timing.framesToMs(4)), 66.667)
  assert.equal(timing.WORD_INTERVAL_FRAMES, 4)
  assert.equal(timing.APPEAR_FADE_TOTAL_FRAMES, 7)
  assert.equal(round(timing.APPEAR_FADE_TOTAL_MS), 116.667)
  assert.equal(round(timing.HIDE_IN_PLACE_TOTAL_MS), 250)
  // 已量化的毫秒不再被二次换算成多一帧。
  assert.equal(round(timing.quantizeMsToFrame(timing.APPEAR_FADE_TOTAL_MS)), 116.667)
})

test('talk body uses 4 frames per char, voice + 0.5s, silence + 2s, and motion gate', () => {
  const { load } = fixture()
  const talk = load('utils/TalkTiming.ts')
  const twenty = 'あ'.repeat(20)
  // 无语音：打字 80 帧 + auto_next_page_delay 121 帧。
  assert.equal(round(talk.calculateTalkDurationMs(twenty, 0)), 3350)
  // 语音未在打字前结束：等 voice_end 再 Gate 30 帧。
  assert.equal(round(talk.calculateTalkDurationMs(twenty, 2860)), 3416.667)
  // 语音在打字前结束（1000+50ms → 64 帧 < 80 帧）：打字后停 121 帧。
  assert.equal(round(talk.calculateTalkDurationMs(twenty, 1000)), 3350)
  assert.equal(
    round(talk.calculateTalkDurationMs(twenty, 2860, '', { motionSettleMs: 4000 })),
    4516.667
  )
  // 布局剩余时间来自帧计划（4000ms 正好 240 帧），不再经过 f32 秒累加。
  assert.equal(
    round(talk.calculateTalkDurationMs(twenty, 2860, '', { layoutRunningMs: 4000 })),
    4500
  )
  assert.equal(
    round(talk.calculateTalkDurationMs(twenty, 2860, '', { windowOpenMs: 200 })),
    3416.667
  )
  assert.equal(round(talk.calculateTalkDurationMs(twenty, 0, '', { windowOpenMs: 200 })), 3550)
  // 官方语音时长优先于 TTS：4.0s + 0.05s = 244 帧，打字结束前已带语音 → +30 帧。
  assert.equal(
    round(talk.calculateTalkDurationMs(twenty, 1000, '', { voiceDurationMs: 4000 })),
    4566.667
  )
  assert.equal(round(talk.talkTypingDurationMs(twenty)), 1333.333)
  const described = talk.describeTalkTiming(twenty, 2860)
  assert.equal(round(described.typingMs), 1333.333)
  assert.equal(round(described.voiceEndMs), 2916.667)
  assert.equal(round(described.gateEndMs), 2916.667)
  assert.equal(round(described.totalMs), 3416.667)
})

test('timeline opens the talk window once, reopens after HideTalk or closeWindowOnFinish, and includes delay', () => {
  const { load } = fixture()
  const calculator = load('utils/TimelineCalculator.ts')
  const timing = load(path.join(root, 'src/common/official/timing.ts'))
  const talk = (delay = 0, extra = {}) => ({
    type: 'Talk',
    wait: true,
    delay,
    data: { speaker: 'a', content: 'あ'.repeat(20), ttsText: '', voice: '', modelId: 1, ...extra }
  })
  const result = calculator.calculateTimeline([
    talk(),
    talk(0, { closeWindowOnFinish: true }),
    talk(0.5),
    { type: 'HideTalk', wait: true, delay: 0, data: {} },
    talk()
  ])
  const durations = Array.from(result.entries, (entry) => entry.durationMs)
  assert.deepEqual(durations, [3550, 3350, 3550, 0, 3550])
  assert.equal(round(result.entries[2].delayStartTimeMs), round(3550 + 3350))
  assert.equal(round(result.entries[2].startTimeMs), round(3550 + 3350 + 500))
  assert.equal(round(result.entries[2].endTimeMs), round(result.entries[2].startTimeMs + 3550))
  assert.equal(timing.OPENING_COVER_FADE_MS, 500)
  assert.equal(timing.PLAYED_WAIT_TIME_MS, 250)
  assert.equal(timing.SCENARIO_EXIT_BGM_FADE_MS, 250)
  assert.deepEqual(Array.from(timing.MODEL_COLOR_EVENING), [0.99, 0.9, 0.8])
  assert.deepEqual(Array.from(timing.MODEL_COLOR_NIGHT), [0.83, 0.86, 0.91])
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
  assert.deepEqual(durations, [116.667, 250, 116.667, 766.667, 333.333])
  assert.equal(round(stage.side_to_position('Left', 'Normal', 0).x), 0.318)
  assert.equal(round(stage.side_to_position('Right', 'Normal', 0).x), 0.682)
  assert.equal(round(stage.side_to_position('Left', 'Three', 0).x), 0.214)
  assert.equal(round(stage.side_to_position('Right', 'Three', 0).x), 0.786)
  assert.equal(round(stage.move_speed_to_num('Slow')), 766.667)
  assert.equal(stage.move_speed_to_num('Normal'), 500)
  assert.equal(round(stage.move_speed_to_num('Fast')), 333.333)
  assert.equal(stage.move_speed_to_num('Immediate'), 0)
})
