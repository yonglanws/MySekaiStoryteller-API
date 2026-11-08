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
      [0, 0, 7],
      [1, 7, 212],
      [2, 212, 322],
      [3, 322, 323],
      [4, 323, 535],
      [5, 535, 550]
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
    { window: 12, typingStart: 19, typingEnd: 99, voiceEnd: 182, gateEnd: 182 }
  )
  assert.deepEqual(
    {
      window: plan.entries[2].talk.windowOpenFrames,
      typingEnd: plan.entries[2].talk.typingEndFrame,
      voiceEnd: plan.entries[2].talk.voiceEndFrame,
      gateEnd: plan.entries[2].talk.gateEndFrame
    },
    { window: 0, typingEnd: 292, voiceEnd: 275, gateEnd: 292 }
  )
  assert.equal(plan.entries[4].talk.windowOpenFrames, 12, 'HideTalk 后重新打开窗口')
  assert.equal(plan.entries[4].talk.voiceEndFrame, null)
  assert.equal(plan.entries[4].talk.gateEndFrame, 415)
  assert.equal(plan.entries[0].layout.fadeStartFrame, 1)
  assert.equal(plan.entries[0].layout.fadeEndFrame, 7)
  assert.equal(plan.entries[5].layout.fadeStartFrame, 544)
  assert.equal(plan.entries[5].layout.fadeEndFrame, 550)
  assert.equal(plan.entries[0].actions[0].frame, 0)
  assert.equal(plan.entries[1].actions[0].frame, 7)
  assert.equal(plan.totalFrames, 550)
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
  assert.equal(report.plan.entries[0].talk.gateEndFrame, 175)
  assert.ok(report.approximations.some((item) => /PixiJS/.test(item)))
})

test('non-blocking clear still bakes its 15-frame fade; following appear is new', () => {
  const { load } = fixture()
  const calculator = load('utils/TimelineCalculator.ts')
  const planModule = load(path.join(root, 'src/common/export/storyPlan.ts'))
  const layout = (type, wait) => ({
    type,
    wait,
    delay: 0,
    data: {
      modelId: 1,
      from: { side: 'Center', offset: 0 },
      to: { side: 'Center', offset: 0 },
      moveSpeed: 'Normal',
      ...(type === 'LayoutAppear' ? { motion: '', facial: '', hologram: false } : {})
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

  // 非阻塞 Clear 不推进 cursor，但后台淡出仍是 0.15s + 0.1s。
  assert.equal(plan.entries[1].durationFrames, 0)
  assert.equal(plan.entries[1].layout.fadeStartFrame, 7 + 9)
  assert.equal(plan.entries[1].layout.fadeEndFrame, 7 + 15)
  assert.ok(
    plan.entries[1].layout.fadeStartFrame <= plan.entries[1].layout.fadeEndFrame,
    'fadeStart must not exceed fadeEnd'
  )

  // Clear 在开始时就把角色标记为不在场，因此同一帧的 Appear 是新入场（7 帧淡入）。
  assert.equal(plan.entries[2].layout.fadeStartFrame, 8)
  assert.equal(plan.entries[2].layout.fadeEndFrame, 14)

  // 后面的 Clear 重新看到“在场”，按原地 15 帧退场。
  assert.equal(plan.entries[3].durationFrames, 15)
  assert.equal(plan.entries[3].layout.fadeStartFrame, 14 + 9)
  assert.equal(plan.entries[3].layout.fadeEndFrame, 14 + 15)
})
