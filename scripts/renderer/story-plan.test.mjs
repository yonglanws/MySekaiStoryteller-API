/**
 * PLAN SNAPSHOT — 与 doc/sekai-exporter-parity-plan.md 同步维护。
 *
 * Pass 1 计划层：把剧本 + 时间线烘焙成 60 fps 逐帧计划，供导出日志直接对照。
 * 验收：
 * - Talk 的窗口/打字/语音/gate 帧与 timeline 完全对齐；
 * - 首句窗口只加在打字开始前，语音够长时不额外拉长；
 * - LayoutAppear 的 fade 7 帧、LayoutClear 原地 15 帧、动作 cue 帧正确；
 * - 总帧数等于最后一条的 endFrame。
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
      return load(path.resolve(path.dirname(filename), `${name}.ts`))
    }
    compiled.get(filename).runInContext(context)(exports, require)
    return exports
  }
  return { load }
}

const talk = (opts = {}) => ({
  type: 'Talk',
  wait: true,
  delay: 0,
  data: {
    speaker: '瑞希',
    content: 'あ'.repeat(20),
    ttsText: '',
    voice: '',
    modelId: 1,
    motion: 'w-normal-nod01',
    facial: 'face_normal_01',
    ...opts
  }
})

test('story plan bakes the official frame timeline', () => {
  const { load } = fixture()
  const calculator = load('utils/TimelineCalculator.ts')
  const planModule = load(path.join(root, 'src/common/export/storyPlan.ts'))
  const snippets = [
    {
      type: 'LayoutAppear',
      wait: true,
      delay: 0,
      data: {
        modelId: 1,
        from: { side: 'Left', offset: 0 },
        to: { side: 'Left', offset: 0 },
        motion: 'w-normal-nod01',
        facial: 'face_normal_01',
        moveSpeed: 'Normal',
        hologram: false
      }
    },
    talk({ ttsText: 'い'.repeat(40) }),
    talk({ ttsText: 'い'.repeat(20) }),
    { type: 'HideTalk', wait: true, delay: 0, data: {} },
    talk({ motion: '', facial: '' }),
    {
      type: 'LayoutClear',
      wait: true,
      delay: 0,
      data: {
        modelId: 1,
        from: { side: 'Left', offset: 0 },
        to: { side: 'Left', offset: 0 },
        moveSpeed: 'Normal'
      }
    }
  ]
  const tts = new Map([
    [1, { snippetIndex: 1, durationMs: 2860 }],
    [2, { snippetIndex: 2, durationMs: 1000 }]
  ])
  const timeline = calculator.calculateTimeline(snippets, tts)
  const plan = planModule.bakeStoryPlan(snippets, timeline.entries)

  assert.equal(plan.fps, 60)
  assert.deepEqual(
    Array.from(plan.entries, (entry) => [entry.index, entry.startFrame, entry.endFrame]),
    [
      [0, 10, 19],
      [1, 19, 225],
      [2, 225, 427],
      // HideTalk 不等待；非末条的 endFrame 记录下一帧栅栏，durationFrames 仍为 0。
      [3, 427, 428],
      [4, 427, 641],
      [5, 641, 656]
    ]
  )
  assert.deepEqual(
    {
      window: plan.entries[1].talk.windowOpenFrames,
      typingStart: plan.entries[1].talk.typingStartFrame,
      typingEnd: plan.entries[1].talk.typingEndFrame,
      voiceEnd: plan.entries[1].talk.voiceEndFrame,
      gateEnd: plan.entries[1].talk.gateEndFrame
    },
    { window: 12, typingStart: 31, typingEnd: 111, voiceEnd: 194, gateEnd: 194 }
  )
  assert.deepEqual(
    {
      window: plan.entries[2].talk.windowOpenFrames,
      typingEnd: plan.entries[2].talk.typingEndFrame,
      voiceEnd: plan.entries[2].talk.voiceEndFrame,
      gateEnd: plan.entries[2].talk.gateEndFrame
    },
    { window: 0, typingEnd: 305, voiceEnd: 289, gateEnd: 305 }
  )
  assert.equal(plan.entries[4].talk.windowOpenFrames, 12, 'HideTalk 后重新打开窗口')
  assert.equal(plan.entries[4].talk.voiceEndFrame, null)
  assert.equal(plan.entries[4].talk.gateEndFrame, 519)
  // 带 motion 的新角色：类型分支延后一帧，fade 从 12 到 18。
  assert.equal(plan.entries[0].layout.fadeStartFrame, 12)
  assert.equal(plan.entries[0].layout.fadeEndFrame, 18)
  assert.equal(plan.entries[5].layout.fadeStartFrame, 650)
  assert.equal(plan.entries[5].layout.fadeEndFrame, 656)
  assert.equal(plan.entries[0].actions[0].frame, 10)
  assert.equal(plan.entries[1].actions[0].frame, 19)
  // PlayCore 10 帧暖场 + cleanup 后 31 帧尾。
  assert.equal(plan.totalFrames, 687)
})

test('official voiceDurationMs drives Talk timing instead of the TTS audio length', () => {
  const { load } = fixture()
  const calculator = load('utils/TimelineCalculator.ts')
  const planModule = load(path.join(root, 'src/common/export/storyPlan.ts'))
  const snippet = talk({ voiceDurationMs: 4000 })
  const timeline = calculator.calculateTimeline(
    [snippet],
    new Map([[0, { snippetIndex: 0, durationMs: 1000 }]])
  )
  // 4.0s 官方语音 + 0.05s 结束延迟 = 244 帧；TTS 的 1000ms 不参与计时。
  assert.equal(timeline.entries[0].durationMs, 4566.667)
  const plan = planModule.bakeStoryPlan([snippet], timeline.entries)
  assert.equal(plan.entries[0].talk.voiceEndFrame, 10 + 244)
  assert.equal(plan.entries[0].talk.gateEndFrame, 10 + 244)
  assert.equal(plan.entries[0].durationFrames, 274)
  assert.equal(plan.entries[0].endFrame, 10 + 274)
})

test('typingText uses the official body length while content remains the display text', () => {
  const { load } = fixture()
  const calculator = load('utils/TimelineCalculator.ts')
  const planModule = load(path.join(root, 'src/common/export/storyPlan.ts'))
  // 译文 content 20 字，官方日文 body 40 字；无语音时停 121 帧。
  const snippet = talk({
    content: 'あ'.repeat(20),
    typingText: 'い'.repeat(40),
    motion: '',
    facial: ''
  })
  const timeline = calculator.calculateTimeline([snippet], new Map())
  // 12 帧开窗 + 160 帧打字 + 121 帧自动停留 = 293 帧。
  assert.equal(timeline.entries[0].durationMs, 4883.333)
  const plan = planModule.bakeStoryPlan([snippet], timeline.entries)
  const entry = plan.entries[0]
  assert.equal(entry.talk.typingStartFrame, 22)
  assert.equal(entry.talk.typingEndFrame, 182)
  assert.equal(entry.talk.gateEndFrame, 182)
  assert.equal(entry.durationFrames, 293)
  assert.equal(plan.totalFrames, 334)
})

test('Wait occupies its own plan frames and is a data_duration snippet', () => {
  const { load } = fixture()
  const calculator = load('utils/TimelineCalculator.ts')
  const planModule = load(path.join(root, 'src/common/export/storyPlan.ts'))
  const snippet = { type: 'Wait', wait: true, delay: 0, data: { duration: 4000 } }
  const timeline = calculator.calculateTimeline([snippet], new Map())
  // 4.0s 官方 f32 frames_for = 241 帧（与 25s/3s/2s 同源）。
  assert.equal(timeline.entries[0].durationMs, 4016.667)
  const plan = planModule.bakeStoryPlan([snippet], timeline.entries)
  assert.deepEqual(
    Array.from(plan.entries, (entry) => [entry.startFrame, entry.endFrame, entry.durationFrames]),
    [[10, 251, 241]]
  )
  assert.equal(plan.totalFrames, 282)
})

test('sub-frame state cues do not consume story frames in the plan', () => {
  const { load } = fixture()
  const calculator = load('utils/TimelineCalculator.ts')
  const planModule = load(path.join(root, 'src/common/export/storyPlan.ts'))
  const snippets = [
    { type: 'ChangeLayoutMode', wait: false, delay: 0, data: { mode: 'Normal' } },
    { type: 'ChangeBackgroundImage', wait: false, delay: 0, data: { imageId: 1 } },
    { type: 'AmbientColor', wait: true, delay: 0, data: { mode: 'night' } },
    {
      type: 'LayoutAppear',
      wait: true,
      delay: 0,
      data: {
        modelId: 1,
        from: { side: 'Center', offset: 0 },
        to: { side: 'Center', offset: 0 },
        motion: '',
        facial: '',
        moveSpeed: 'Normal',
        hologram: false
      }
    }
  ]
  const timeline = calculator.calculateTimeline(snippets, new Map())
  const plan = planModule.bakeStoryPlan(snippets, timeline.entries)
  assert.deepEqual(
    Array.from(plan.entries, (entry) => entry.durationFrames),
    [0, 0, 0, 7]
  )
  assert.deepEqual(
    Array.from(plan.entries, (entry) => entry.startFrame),
    [10, 10, 10, 10]
  )
})

test('diagnostics carries the baked plan and approximation list', () => {
  const { load } = fixture()
  const diagnostics = load('managers/video-export/ExportDiagnostics.ts')
  const report = diagnostics.buildExportDiagnostics({
    snippets: [talk({ ttsText: 'い'.repeat(40) })],
    timeline: [
      {
        snippetIndex: 0,
        snippetType: 'Talk',
        startTimeMs: 0,
        durationMs: 3416.667,
        endTimeMs: 3416.667,
        ttsDurationMs: 2860,
        hasTTS: true
      }
    ],
    timestamps: {
      getSnippetTimestamp: () => null,
      getRenderStartWallMs: () => 0
    },
    ttsResults: new Map([[0, { durationMs: 2860, characterName: '瑞希', text: 'あ' }]]),
    motion: [],
    logs: [],
    exportMeta: {
      mode: 'fast',
      width: 1920,
      height: 1080,
      fps: 30,
      frameCount: 100,
      durationMs: 3417
    },
    provider: 'irodori'
  })
  assert.equal(report.plan.entries.length, 1)
  assert.equal(report.plan.entries[0].talk.gateEndFrame, 185)
  assert.ok(report.approximations.some((item) => /PixiJS/.test(item)))
})

test('pre-start fence lets Now overlap at frame 0 while WaitFinished drains prior tasks', () => {
  const { load } = fixture()
  const calculator = load('utils/TimelineCalculator.ts')
  const planModule = load(path.join(root, 'src/common/export/storyPlan.ts'))
  const layout = (type, wait, extra = {}) => ({
    type,
    wait,
    delay: 0,
    data: {
      modelId: 1,
      from: { side: 'Center', offset: 0 },
      to: { side: 'Center', offset: 0 },
      moveSpeed: 'Normal',
      ...(type === 'LayoutAppear' ? { motion: '', facial: '', hologram: false } : {}),
      ...extra
    }
  })
  const snippets = [
    layout('LayoutAppear', true),
    layout('LayoutClear', false),
    layout('LayoutAppear', true),
    layout('LayoutClear', true)
  ]
  const timeline = calculator.calculateTimeline(snippets, new Map())
  const plan = planModule.bakeStoryPlan(snippets, timeline.entries)

  // PlayCore 从第 10 帧开始：snippet 0 与 Now 的 snippet 1 同在该帧开跑；
  // snippet 2 (WaitFinished) 等 0 和 1 全部跑完（第 25 帧）再启动。
  assert.deepEqual(
    Array.from(plan.entries, (entry) => [entry.startFrame, entry.endFrame, entry.durationFrames]),
    [
      [10, 18, 7],
      [10, 26, 15],
      [26, 34, 7],
      [34, 49, 15]
    ]
  )
  assert.equal(plan.entries[1].layout.fadeStartFrame, 19)
  assert.equal(plan.entries[1].layout.fadeEndFrame, 25)
  assert.equal(plan.entries[2].layout.fadeStartFrame, 27)
  assert.equal(plan.entries[2].layout.fadeEndFrame, 33)
  assert.equal(plan.entries[3].layout.fadeStartFrame, 43)
  assert.equal(plan.entries[3].layout.fadeEndFrame, 49)
})

test('Talk closeWindowOnFinish and async LayoutAppear slide end gate in storyPlan', () => {
  const { load } = fixture()
  const calculator = load('utils/TimelineCalculator.ts')
  const planModule = load(path.join(root, 'src/common/export/storyPlan.ts'))
  const snippets = [
    {
      type: 'LayoutAppear',
      wait: true,
      progressBehavior: 'Now',
      delay: 0,
      data: {
        modelId: 1,
        from: { side: 'Left', offset: 0 },
        to: { side: 'Right', offset: 0 },
        motion: '',
        facial: '',
        moveSpeed: 'Normal',
        hologram: false
      }
    },
    talk({ content: 'あ', closeWindowOnFinish: true }),
    talk({ content: 'あ' })
  ]
  const tts = new Map([[1, { snippetIndex: 1, durationMs: 300 }]])
  const timeline = calculator.calculateTimeline(snippets, tts)
  const plan = planModule.bakeStoryPlan(snippets, timeline.entries)

  // Appear 7f 完成后启动有声 Talk (frame 18)；后台滑行到 frame 40 不再阻塞门，
  // gate = max(typing_end=34, voice_end=39) = 39（参考 `layout_running` 只看片段本身）。
  assert.equal(plan.entries[0].startFrame, 10)
  assert.equal(plan.entries[0].endFrame, 18)
  assert.equal(plan.entries[1].startFrame, 18)
  assert.equal(plan.entries[1].talk.gateEndFrame, 39)
  assert.equal(plan.entries[1].talk.computedEndFrame, 69)
  assert.equal(plan.entries[1].durationFrames, 51)
  // 参考 end_talk 在台词结束 0.2s 后才关窗；紧接着开始的下一句仍算窗口打开。
  assert.equal(plan.entries[2].talk.windowOpenFrames, 0)
})

test('full screen text, choice and black fades use the official frame counts', () => {
  const { load } = fixture()
  const calculator = load('utils/TimelineCalculator.ts')
  const planModule = load(path.join(root, 'src/common/export/storyPlan.ts'))
  const snippets = [
    { type: 'FullScreenText', wait: true, delay: 0, data: { text: '独白' } },
    {
      type: 'SimpleSelectable',
      wait: true,
      delay: 0,
      data: { choices: ['A', 'B'], pickedIndex: 1 }
    },
    { type: 'BlackOut', wait: true, delay: 0, data: { duration: 3000 } },
    { type: 'BlackIn', wait: true, delay: 0, data: { duration: 2000 } }
  ]
  const timeline = calculator.calculateTimeline(snippets)
  const plan = planModule.bakeStoryPlan(snippets, timeline.entries)

  const fst = plan.entries[0]
  assert.equal(fst.type, 'FullScreenText')
  assert.equal(fst.durationFrames, 277, '8 slots: 91 + 64 + 61 + 61')
  assert.equal(fst.fst.first, true)
  assert.equal(fst.fst.last, true)
  assert.equal(fst.fst.slots, 8)
  assert.equal(fst.fst.textStartFrame, 10 + 91)
  assert.equal(fst.fst.textEndFrame, 10 + 155)
  assert.equal(fst.fst.holdFrames, 61)
  assert.equal(fst.fst.fadeFrames, 61)

  const choice = plan.entries[1]
  assert.equal(choice.type, 'SimpleSelectable')
  assert.equal(choice.durationFrames, 121, 'answered act+91 + ANSWER_FINISH_DELAY 30')

  assert.equal(plan.entries[2].type, 'BlackOut')
  assert.equal(plan.entries[2].durationFrames, 181, 'frames_for(3.0)')
  assert.equal(plan.entries[3].type, 'BlackIn')
  assert.equal(plan.entries[3].durationFrames, 121, 'frames_for(2.0)')
})

test('consecutive full screen text keeps one dialog and grows its TMP slots', () => {
  const { load } = fixture()
  const calculator = load('utils/TimelineCalculator.ts')
  const planModule = load(path.join(root, 'src/common/export/storyPlan.ts'))
  const snippets = [
    { type: 'FullScreenText', wait: true, delay: 0, data: { text: '独白' } },
    { type: 'FullScreenText', wait: true, delay: 0, data: { text: '一二三四五六七八九十' } },
    { type: 'FullScreenText', wait: true, delay: 0, data: { text: '短' } }
  ]
  const timeline = calculator.calculateTimeline(snippets)
  const plan = planModule.bakeStoryPlan(snippets, timeline.entries)

  // 首行 8 槽、不淡出：91 + 64 + 61 = 216。
  assert.equal(plan.entries[0].durationFrames, 216)
  assert.equal(plan.entries[0].fst.first, true)
  assert.equal(plan.entries[0].fst.last, false)
  assert.equal(plan.entries[0].fst.slots, 8)
  // 第二行 10 槽、中间行：80 + 61 = 141。
  assert.equal(plan.entries[1].durationFrames, 141)
  assert.equal(plan.entries[1].fst.first, false)
  assert.equal(plan.entries[1].fst.last, false)
  assert.equal(plan.entries[1].fst.slots, 10)
  // 第三行仍按 10 槽（只增不减）、末行淡出：80 + 61 + 61 = 202。
  assert.equal(plan.entries[2].durationFrames, 202)
  assert.equal(plan.entries[2].fst.first, false)
  assert.equal(plan.entries[2].fst.last, true)
  assert.equal(plan.entries[2].fst.slots, 10)
  // 时间线也要与 plan 一致（下一片段起点依赖它）。
  const timelineFrames = (index) => Math.round(timeline.entries[index].durationMs / (1000 / 60))
  assert.equal(timelineFrames(0), 216)
  assert.equal(timelineFrames(1), 141)
  assert.equal(timelineFrames(2), 202)
})

test('LayoutAppear hands over at act+7 / act+8 and the Talk follows at finish+1', () => {
  const { load } = fixture()
  const calculator = load('utils/TimelineCalculator.ts')
  const planModule = load(path.join(root, 'src/common/export/storyPlan.ts'))
  const appear = (motion, modelId) => ({
    type: 'LayoutAppear',
    wait: true,
    delay: 0,
    data: {
      modelId,
      from: { side: 'Center', offset: 0 },
      to: { side: 'Right', offset: 0 },
      motion,
      facial: '',
      moveSpeed: 'Slow',
      hologram: false
    }
  })
  const snippets = [
    appear('', 1),
    talk({ content: 'あ', motion: '', modelId: 1 }),
    appear('m1', 2),
    talk({ content: 'あ', motion: '', modelId: 2 })
  ]
  const timeline = calculator.calculateTimeline(snippets)
  const plan = planModule.bakeStoryPlan(snippets, timeline.entries)

  // 无 motion：act 10、fade 从 act+1 起、到 act+7；片段 finish=17，下一句 start=18。
  assert.equal(plan.entries[0].startFrame, 10)
  assert.equal(plan.entries[0].layout.fadeStartFrame, 11)
  assert.equal(plan.entries[0].layout.fadeEndFrame, 17)
  assert.equal(plan.entries[0].durationFrames, 7)
  assert.equal(plan.entries[0].endFrame, 18)
  assert.equal(plan.entries[1].startFrame, 18)

  // 有 motion：类型分支 act+1、opacity 从 act+2 起 6 帧、until=act+8。
  const withMotion = plan.entries[2]
  assert.equal(withMotion.startFrame, withMotion.delayStartFrame)
  assert.equal(withMotion.layout.fadeStartFrame, withMotion.startFrame + 2)
  assert.equal(withMotion.layout.fadeEndFrame, withMotion.startFrame + 8)
  assert.equal(withMotion.durationFrames, 8)
  // 后台 Slow 滑入（46 帧）不阻塞下一条。
  assert.equal(withMotion.layout.moveEndFrame, withMotion.startFrame + 1 + 46)
  assert.equal(plan.entries[3].startFrame, withMotion.endFrame)
})

test('plan uses per-snippet motion settle frames without collapsing them into seconds', () => {
  const { load } = fixture()
  const calculator = load('utils/TimelineCalculator.ts')
  const planModule = load(path.join(root, 'src/common/export/storyPlan.ts'))
  const snippets = [
    {
      type: 'Talk',
      wait: true,
      delay: 0,
      data: {
        speaker: '瑞希',
        content: 'あ'.repeat(16),
        typingText: 'あ'.repeat(16),
        modelId: 1,
        voiceDurationMs: 1819.637
      }
    }
  ]
  const timeline = calculator.calculateTimeline(snippets)
  // 参考：set_body 在 act 同帧，收尾 = frames_for(2.033s) = 122 帧；
  // 若动作带 1s 栅栏，则是 frames_for(1.0)+frames_for(2.033) = 61+122 = 183 帧。
  const byFrames = planModule.bakeStoryPlan(snippets, timeline.entries, {
    motionSettleFrames: new Map([[0, 183]])
  }).entries[0]
  const byMs = planModule.bakeStoryPlan(snippets, timeline.entries, {
    motionSettleMs: new Map([[0, 3033]])
  }).entries[0]
  assert.equal(byFrames.talk.gateEndFrame - byFrames.startFrame, 183)
  assert.equal(byFrames.durationFrames, 213)
  assert.equal(byMs.talk.gateEndFrame - byMs.startFrame, 182)
  assert.equal(byMs.durationFrames, 212)
  // 诊断里能看到 gate 的两个来源：动作收尾帧数与仍在跑的布局结束帧。
  assert.equal(byFrames.talk.settleFrames, 183)
  assert.equal(byFrames.talk.layoutGateFrame, 0)
  assert.equal(byMs.talk.settleFrames, 182)
  // 183 = 1s(61) + 2.033s(122)，逐段换算比整段毫秒多一帧。
  assert.equal(byFrames.durationFrames - byMs.durationFrames, 1)
})

test('plan derives Talk gate from script frames and clip lengths, skipping hidden characters', () => {
  const { load } = fixture()
  const calculator = load('utils/TimelineCalculator.ts')
  const planModule = load(path.join(root, 'src/common/export/storyPlan.ts'))
  const appear = {
    type: 'LayoutAppear',
    wait: true,
    delay: 0,
    data: {
      modelId: 1,
      from: { side: 'Center', offset: 0 },
      to: { side: 'Center', offset: 0 },
      moveSpeed: 'Normal',
      motion: 'm-long'
    }
  }
  const talk = {
    type: 'Talk',
    wait: true,
    delay: 0,
    data: {
      content: 'あ'.repeat(10),
      typingText: 'あ'.repeat(10),
      modelId: 1,
      voiceDurationMs: 500,
      actions: [{ at: 0, modelId: 1, motion: 'm-own' }]
    }
  }
  const clear = {
    type: 'LayoutClear',
    wait: true,
    delay: 0,
    data: {
      modelId: 1,
      from: { side: 'Center', offset: 0 },
      to: { side: 'Center', offset: 0 },
      moveSpeed: 'Normal'
    }
  }
  const clips = new Map([
    ['1|m-long', 20],
    ['1|m-own', 90]
  ])
  const shownSnippets = [appear, talk]
  const shown = planModule.bakeStoryPlan(
    shownSnippets,
    calculator.calculateTimeline(shownSnippets).entries,
    { motionClipFrames: clips }
  )
  // 本句自己的动作在 act 帧 set_body，gate = act + 90。
  assert.equal(shown.entries[1].talk.settleFrames, 90)
  const hiddenSnippets = [appear, clear, talk]
  const hidden = planModule.bakeStoryPlan(
    hiddenSnippets,
    calculator.calculateTimeline(hiddenSnippets).entries,
    { motionClipFrames: clips }
  )
  assert.equal(hidden.entries[2].talk.settleFrames, 0)
})

test('Talk auto advance is max(typing_end, voice_end) + 30 / typing_end + 121', () => {
  const { load } = fixture()
  const calculator = load('utils/TimelineCalculator.ts')
  const planModule = load(path.join(root, 'src/common/export/storyPlan.ts'))
  const make = (voiceMs) => ({
    type: 'Talk',
    wait: true,
    delay: 0,
    data: {
      speaker: '瑞希',
      content: 'あ'.repeat(10),
      typingText: 'あ'.repeat(10),
      modelId: 1,
      ...(voiceMs > 0 ? { voiceDurationMs: voiceMs } : {})
    }
  })
  // 10 字 = 40 帧；首句窗口 12 帧。
  // 无语音：act 10 + 12 + 40 + 121 = 183 finish。
  // 语音 2.0s = 121 帧（act+12+121=143? 语音结束 = act + frames_for(2.05) = act+124）
  // 语音 0.5s 在打字前结束：仍 typing_end + 121。
  const cases = [
    { voiceMs: 0, finish: 183 },
    { voiceMs: 500, finish: 183 },
    { voiceMs: 2000, finish: 10 + 12 + 40 + 124 - 41 + 30 }
  ]
  for (const c of cases) {
    const snippets = [make(c.voiceMs)]
    const timeline = calculator.calculateTimeline(snippets)
    const plan = planModule.bakeStoryPlan(snippets, timeline.entries)
    const entry = plan.entries[0]
    const talk = entry.talk
    const voiceEnd = c.voiceMs > 0 ? talk.voiceEndFrame : null
    const expectedGate =
      voiceEnd !== null && voiceEnd > talk.typingEndFrame ? voiceEnd : talk.typingEndFrame
    const expectedTail = voiceEnd !== null && voiceEnd > talk.typingEndFrame ? 30 : 121
    assert.equal(talk.gateEndFrame, expectedGate, `voice=${c.voiceMs} gate`)
    assert.equal(talk.computedEndFrame, expectedGate + expectedTail, `voice=${c.voiceMs} finish`)
  }
})

test('bakeStoryPlan preserves modelId 0 across layout/actions and computes at > 0 action frames without timeline', () => {
  const { load } = fixture()
  const planModule = load(path.join(root, 'src/common/export/storyPlan.ts'))
  const snippets = [
    {
      type: 'LayoutAppear',
      wait: false,
      delay: 0,
      data: {
        modelId: 0,
        motion: 'w-cute-nod01',
        from: { side: 'Left', offset: 0 },
        to: { side: 'Left', offset: 0 },
        moveSpeed: 'Normal'
      }
    },
    {
      type: 'LayoutClear',
      wait: true,
      delay: 0,
      data: {
        modelId: 0,
        from: { side: 'Left', offset: 0 },
        to: { side: 'Left', offset: 0 },
        moveSpeed: 'Normal'
      }
    },
    {
      type: 'Talk',
      wait: true,
      delay: 0,
      data: {
        speaker: '一歌',
        content: 'こんにちは！今日もいい天気ですね。',
        modelId: 0,
        actions: [{ at: 0.5, facial: 'face_smile01' }]
      }
    }
  ]
  const plan = planModule.bakeStoryPlan(snippets, [], {
    motionClipFrames: new Map([['0|w-cute-nod01', 90]])
  })
  // modelId 0 was previously coerced to -1 in layout handling, making LayoutAppear invisible & LayoutClear no-op
  assert.equal(plan.entries[0].layout.kind, 'appear')
  assert.equal(plan.entries[0].actions[0].modelId, 0)
  assert.equal(plan.entries[1].layout.kind, 'clear')
  assert.notEqual(plan.entries[1].layout.fadeStartFrame, null)
  // Cleared modelId 0 must not block the subsequent Talk's settleFrames
  assert.equal(plan.entries[2].talk.settleFrames, 0)
  // Mid-line action (at=0.5) should advance past startFrame even when bakeStoryPlan receives empty timeline
  assert.equal(plan.entries[2].actions[0].modelId, 0)
  assert.ok(plan.entries[2].actions[0].frame > plan.entries[2].startFrame)
})
