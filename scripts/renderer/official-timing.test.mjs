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
  assert.equal(timing.CHARACTER_FADE_IN_PLACE_FRAMES, 21)
  assert.equal(timing.CHARACTER_FADE_IN_PLACE_MS, 350)
  assert.equal(timing.APPEAR_IN_PLACE_FADE_TOTAL_FRAMES, 22)
  assert.equal(round(timing.APPEAR_IN_PLACE_FADE_TOTAL_MS), 366.667)
  assert.equal(timing.HIDE_DELAY_IN_PLACE_SMOOTH_MS, 0)
  assert.equal(timing.HIDE_IN_PLACE_SMOOTH_TOTAL_FRAMES, 21)
  assert.equal(timing.HIDE_IN_PLACE_SMOOTH_TOTAL_MS, 350)
  assert.equal(timing.resolveCharacterFadeMs(false, 60, false), 100)
  assert.equal(timing.resolveCharacterFadeMs(false, 60, true), 350)
  assert.equal(timing.resolveCharacterFadeMs(true, 60, true), 350)
  // 已量化的毫秒不再被二次换算成多一帧。
  assert.equal(round(timing.quantizeMsToFrame(timing.APPEAR_FADE_TOTAL_MS)), 116.667)
  assert.equal(round(timing.quantizeMsToFrame(timing.APPEAR_IN_PLACE_FADE_TOTAL_MS)), 366.667)
})

test('video frame n maps to story frame floor(n×60/fps) and steps by floor difference', () => {
  const { load } = fixture()
  const timing = load(path.join(root, 'src/common/official/timing.ts'))
  // 60fps：成片帧 n 就是故事帧 n（含 PlayCore 前 10 帧）。
  for (const n of [0, 1, 9, 10, 11, 20266, 20267]) {
    assert.equal(timing.storyFrameForVideoFrame(n, 60), n)
    assert.equal(timing.storyFrameTweenForVideoFrame(n, 60), 0)
  }
  // 30fps：成片帧 n = 故事帧 2n。
  assert.equal(timing.storyFrameForVideoFrame(0, 30), 0)
  assert.equal(timing.storyFrameForVideoFrame(1, 30), 2)
  assert.equal(timing.storyFrameForVideoFrame(10133, 30), 20266)
  // 25fps：floor(n×60/25) = 2,4,7,9,12；步数差 2,2,3,2,3，绝不是 ceil(60/25)=3。
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((n) => timing.storyFrameForVideoFrame(n, 25)),
    [0, 2, 4, 7, 9, 12]
  )
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((n) => timing.storyStepsForVideoFrame(n, 25)),
    [2, 2, 3, 2, 3, 2]
  )
  // 24fps：floor(n×2.5) = 0,2,5,7,10；步数差 2,3,2,3，不是 ceil(2.5)=3。
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((n) => timing.storyFrameForVideoFrame(n, 24)),
    [0, 2, 5, 7, 10]
  )
  assert.deepEqual(
    [0, 1, 2, 3].map((n) => timing.storyStepsForVideoFrame(n, 24)),
    [2, 3, 2, 3]
  )
  // 25fps 第 1 帧的故事时间落在故事帧 2 与 3 之间 0.4；第 5 帧正好落在故事帧 12。
  assert.equal(round(timing.storyFrameTweenForVideoFrame(1, 25)), 0.4)
  assert.equal(round(timing.storyFrameTweenForVideoFrame(2, 25)), 0.8)
  assert.equal(timing.storyFrameTweenForVideoFrame(5, 25), 0)
  // 24fps 每 2 帧半帧：0.5 / 0 交替。
  assert.equal(timing.storyFrameTweenForVideoFrame(1, 24), 0.5)
  assert.equal(timing.storyFrameTweenForVideoFrame(2, 24), 0)
  // 故事帧数 -> 成片帧数：ceil(storyFrames×fps/60)，60fps 原样。
  assert.equal(timing.videoFrameCountForStoryFrames(20267, 60), 20267)
  assert.equal(timing.videoFrameCountForStoryFrames(20267, 30), 10134)
  assert.equal(timing.videoFrameCountForStoryFrames(20267, 25), 8445)
  assert.equal(timing.videoFrameCountForStoryFrames(20267, 24), 8107)
  // 无穷/NaN/负数都退化成 0 帧，不产生负索引。
  assert.equal(timing.storyFrameForVideoFrame(-5, 24), 0)
  assert.equal(timing.storyFrameForVideoFrame(Number.NaN, 24), 0)
  assert.equal(timing.storyStepsForVideoFrame(Number.NaN, 24), 2)
})

test('full screen text slots are max(8, UTF-32 length) and 8 slots take 277 frames', () => {
  const { load } = fixture()
  const timing = load(path.join(root, 'src/common/official/timing.ts'))
  // 参考 `PlayCore`：黑边 61 + 开窗 30 + 逐槽 8 + 停留 61 + 淡出 61。
  assert.equal(timing.FST_BARS_FRAMES, 61)
  assert.equal(timing.FST_OPEN_DELAY_FRAMES, 30)
  assert.equal(timing.FST_SLOT_FRAMES, 8)
  assert.equal(timing.FST_HOLD_FRAMES, 61)
  assert.equal(timing.FST_FADE_FRAMES, 61)
  // `tmp_character_info_len`：初值 8、只增不减、按 UTF-32 计数（含富文本标签）。
  assert.equal(timing.fullScreenTextSlots(0, '独白'), 8)
  assert.equal(timing.fullScreenTextSlots(0, '\n0123456789'), 10)
  assert.equal(timing.fullScreenTextSlots(8, 'short'), 8)
  assert.equal(timing.fullScreenTextSlots(8, '<b>ab</b>'), 9)
  assert.equal(timing.fullScreenTextSlots(38, 'short'), 38)
  // 单行、8 槽、首尾同一片段：91 + 64 + 61 + 61 = 277。
  const single = timing.fullScreenTextFrames({ first: true, last: true, slots: 8 })
  assert.equal(single.textStartFrame, 91)
  assert.equal(single.textEndFrame, 155)
  assert.equal(single.totalFrames, 277)
  // 连续对话：首行不淡出 216；中间行不黑边不淡出 125；末行不黑边 186。
  assert.equal(timing.fullScreenTextFrames({ first: true, last: false, slots: 8 }).totalFrames, 216)
  assert.equal(
    timing.fullScreenTextFrames({ first: false, last: false, slots: 8 }).totalFrames,
    125
  )
  assert.equal(timing.fullScreenTextFrames({ first: false, last: true, slots: 8 }).totalFrames, 186)
  // 长首行 10 槽、下一行仍按 10 槽计时。
  const longFirst = timing.fullScreenTextFrames({
    first: true,
    last: false,
    slots: timing.fullScreenTextSlots(0, '0123456789')
  })
  assert.equal(longFirst.totalFrames, 91 + 80 + 61)
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
  // 译文 content 20 字，官方日文 body 40 字：打字窗按 body 的 160 帧走。
  assert.equal(
    round(talk.calculateTalkDurationMs(twenty, 1000, '', { typingText: 'い'.repeat(40) })),
    4683.333
  )
  assert.equal(round(talk.talkTypingDurationMs(twenty)), 1333.333)
  // 动作收尾按参考分段换算：`frames_for(1s 延迟) + frames_for(2.033s clip)`
  // = 61 + 122 = 183 帧；合成 3.033s 再换算只有 182 帧。
  assert.equal(
    round(talk.calculateTalkDurationMs(twenty, 2860, '', { motionSettleFrames: 183 })),
    3550
  )
  assert.equal(
    round(talk.calculateTalkDurationMs(twenty, 2860, '', { motionSettleMs: 3033 })),
    3533.333
  )
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
  // 每条正等待片段后有一帧栅栏：3550 + 1f + 3350 + 1f = 6933.333ms。
  assert.equal(round(result.entries[2].delayStartTimeMs), 6933.333)
  assert.equal(round(result.entries[2].startTimeMs), 7433.333)
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
          to: { side: 'Left', offset: 0 },
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
  assert.deepEqual(durations, [366.667, 350, 116.667, 766.667, 333.333])
  assert.equal(round(stage.side_to_position('Left', 'Normal', 0).x), 0.318)
  assert.equal(round(stage.side_to_position('Right', 'Normal', 0).x), 0.682)
  assert.equal(round(stage.side_to_position('Left', 'Three', 0).x), 0.214)
  assert.equal(round(stage.side_to_position('Right', 'Three', 0).x), 0.786)
  assert.equal(round(stage.side_to_position('Center', 'Normal', 0).y), 0.809)
  assert.equal(round(stage.side_to_position('Center', 'Three', 0).y), 0.828)
  assert.equal(round(stage.side_to_position('Under', 'Normal', 0).y), 2.067)
  assert.equal(round(stage.move_speed_to_num('Slow')), 766.667)
  assert.equal(stage.move_speed_to_num('Normal'), 500)
  assert.equal(round(stage.move_speed_to_num('Fast')), 333.333)
  assert.equal(stage.move_speed_to_num('Immediate'), 0)
})
