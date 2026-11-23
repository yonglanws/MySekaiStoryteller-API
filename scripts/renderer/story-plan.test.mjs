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
      [0, 10, 18],
      [1, 18, 223],
      [2, 223, 424],
      // HideTalk 是 1ms 状态片段，和 ChangeLayoutMode 一样不占故事帧。
      [3, 424, 424],
      [4, 424, 637],
      [5, 637, 652]
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
    { window: 12, typingStart: 30, typingEnd: 110, voiceEnd: 193, gateEnd: 193 }
  )
  assert.deepEqual(
    {
      window: plan.entries[2].talk.windowOpenFrames,
      typingEnd: plan.entries[2].talk.typingEndFrame,
      voiceEnd: plan.entries[2].talk.voiceEndFrame,
      gateEnd: plan.entries[2].talk.gateEndFrame
    },
    { window: 0, typingEnd: 303, voiceEnd: 287, gateEnd: 303 }
  )
  assert.equal(plan.entries[4].talk.windowOpenFrames, 12, 'HideTalk 后重新打开窗口')
  assert.equal(plan.entries[4].talk.voiceEndFrame, null)
  assert.equal(plan.entries[4].talk.gateEndFrame, 516)
  // 带 motion 的新角色：类型分支延后一帧，fade 从 12 到 18。
  assert.equal(plan.entries[0].layout.fadeStartFrame, 12)
  assert.equal(plan.entries[0].layout.fadeEndFrame, 18)
  assert.equal(plan.entries[5].layout.fadeStartFrame, 646)
  assert.equal(plan.entries[5].layout.fadeEndFrame, 652)
  assert.equal(plan.entries[0].actions[0].frame, 10)
  assert.equal(plan.entries[1].actions[0].frame, 18)
  // PlayCore 10 帧暖场 + cleanup 后 31 帧尾。
  assert.equal(plan.totalFrames, 683)
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
      [10, 17, 7],
      [10, 25, 15],
      [25, 32, 7],
      [32, 47, 15]
    ]
  )
  assert.equal(plan.entries[1].layout.fadeStartFrame, 19)
  assert.equal(plan.entries[1].layout.fadeEndFrame, 25)
  assert.equal(plan.entries[2].layout.fadeStartFrame, 26)
  assert.equal(plan.entries[2].layout.fadeEndFrame, 32)
  assert.equal(plan.entries[3].layout.fadeStartFrame, 41)
  assert.equal(plan.entries[3].layout.fadeEndFrame, 47)
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

  // Appear 7f 完成后启动有声 Talk (frame 17)，后台滑行到 frame 40 > max(typing=21, voice=38) -> gateEnd=40
  assert.equal(plan.entries[0].startFrame, 10)
  assert.equal(plan.entries[0].endFrame, 17)
  assert.equal(plan.entries[1].startFrame, 17)
  assert.equal(plan.entries[1].talk.gateEndFrame, 40)
  assert.equal(plan.entries[1].talk.computedEndFrame, 70)
  assert.equal(plan.entries[1].durationFrames, 53)
  // closeWindowOnFinish 后下一句 Talk 重新打开 12f 对话框
  assert.equal(plan.entries[2].talk.windowOpenFrames, 12)
})
