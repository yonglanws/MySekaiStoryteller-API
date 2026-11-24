import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { withGlobal } from '@sinonjs/fake-timers'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const renderer = path.join(root, 'src/renderer/src')
const compiled = new Map()
const twentyChars = 'あ'.repeat(20)
const noop = () => {}

function talk(content = twentyChars, { delay = 0, ...data } = {}) {
  return {
    type: 'Talk',
    delay,
    wait: true,
    data: { speaker: 'speaker', content, modelId: 1, voice: '', ttsText: '', ...data }
  }
}

// Only renderer/platform boundaries are replaced. The timing, snippet lifecycle,
// scheduler, typewriter and envelope algorithms below all execute production TS.
function fixture(t, { driveExportSteps = true } = {}) {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    AbortController,
    performance: { now: () => 0 }
  })
  vm.runInContext('this.Date = Date; this.Promise = Promise', context)
  const clock = withGlobal(context).install({
    now: 0,
    toFake: [
      'Date',
      'performance',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'setImmediate',
      'clearImmediate'
    ]
  })
  t.after(() => clock.uninstall())
  const warnings = []
  class Logger {
    info = noop
    error = noop
    debug = noop
    warn = (...args) => warnings.push(args)
    getSubLogger = () => this
  }
  class Cubism4InternalModel extends EventEmitter {}
  class Cubism2InternalModel extends EventEmitter {}
  class Text {
    constructor(text, style) {
      this.text = text
      this.style = style
    }
  }
  class AlphaFilter {
    constructor(alpha) {
      this.alpha = alpha
    }
  }
  const modules = new Map()
  const mocks = new Map([
    [
      'pixi.js',
      {
        Text,
        AlphaFilter,
        TextStyle: class {},
        Ticker: {
          shared: { elapsedMS: 1000 / 60, deltaMS: 1000 / 60, deltaTime: 1, lastTime: 0 }
        }
      }
    ],
    ['pixi-live2d-display-advanced', { Cubism4InternalModel, Cubism2InternalModel }],
    [path.join(renderer, 'utils/Logger.ts'), { default: () => new Logger() }]
  ])
  function load(relative) {
    const filename = path.isAbsolute(relative) ? relative : path.join(renderer, relative)
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

  const timingPath = path.join(renderer, 'utils/TalkTiming.ts')
  const timing = fs.existsSync(timingPath) ? load(timingPath) : {}
  const timingCalls = []
  if (timing.calculateTalkDurationMs) {
    const calculate = timing.calculateTalkDurationMs
    timing.calculateTalkDurationMs = (...args) => {
      const result = calculate(...args)
      timingCalls.push({ args, result })
      return result
    }
  }
  const animation = load('managers/AnimationManager.ts').default
  animation.setExportMode(true)
  // 直调片段的测试沿用原有的 125fps setTimeout 步进；完整帧泵测试由
  // advanceStorySteps 驱动，关闭测试替身避免双重步进。
  animation.exportTargetFPS = 125
  animation.testExportStepIntervalMs = driveExportSteps ? 8 : null
  const UIText = load('components/UIText.ts').default
  const uiText = new UIText(1920, 1080)
  const abort = new AbortController()
  const actions = []
  const models = new Map()
  function model(id, cubism2 = false) {
    const controller = new AbortController()
    const writes = []
    const internalModel = new (cubism2 ? Cubism2InternalModel : Cubism4InternalModel)()
    internalModel.motionManager = {
      lipSyncIds: ['mouth'],
      stopAllMotions: () => assert.fail('Dialogue must not stop character motions')
    }
    const write = (param, value) => writes.push({ param, value, at: clock.now })
    internalModel.coreModel = { setParameterValueById: write, setParamFloat: write }
    const result = {
      metadata: { id },
      internalModel,
      actionSignal: controller.signal,
      destroyed: false,
      visible: true,
      writes,
      mouthCalls: [],
      released: false,
      pendingMouthOpen: null,
      mouthUpdateHooked: false,
      releaseMouth() {
        this.pendingMouthOpen = null
        this.released = true
      },
      setMouthOpening(value) {
        this.mouthCalls.push({ value, at: clock.now })
        const core = this.internalModel.coreModel
        if (typeof core.update !== 'function') {
          write('ParamMouthOpenY', value)
          return
        }
        this.pendingMouthOpen = value
        write('ParamMouthOpenY', value)
        if (this.mouthUpdateHooked) return
        const original = core.update
        core.update = function updateMouthThenMesh() {
          if (result.pendingMouthOpen !== null) write('ParamMouthOpenY', result.pendingMouthOpen)
          return original.call(this)
        }
        this.mouthUpdateHooked = true
      },
      getMouthOpenParamIds() {
        return ['ParamMouthOpenY']
      },
      getMouthFormInfo() {
        return null
      },
      setMouthForm() {},
      applyCharacterAction(action, signal, isVisible) {
        if (!signal.aborted && isVisible()) actions.push({ action, signal, at: clock.now })
      },
      destroy() {
        controller.abort() // AdvancedModel.destroy aborts before destroying its internal model.
        this.destroyed = true
      }
    }
    models.set(id, result)
    return result
  }
  model(1)
  model(2, true)
  const starts = []
  const app = {
    isExporting: true,
    currentTalkLipSync: null,
    currentTalkStartedAtMs: 0,
    lastSnippetActualDurationMs: 0,
    videoExportManager: { signal: abort.signal },
    getModelById: (id) => models.get(id),
    layerModel: { isModelVisible: (id) => models.get(id)?.visible ?? false },
    layerUI: {
      UITalkShowed: true,
      resetTalkData: noop,
      setTalkData(_speaker, content) {
        uiText.data = content
        starts.push(clock.now)
      },
      showTextBackground: async () => {},
      startDisplayContent: () => uiText.startDisplayContent()
    }
  }
  const TalkSnippet = load('snippets/TalkSnippet.ts').default
  return {
    app,
    clock,
    context,
    mocks,
    load,
    Logger,
    warnings,
    timing,
    timingCalls,
    models,
    actions,
    starts,
    abort,
    uiText,
    run: (data = talk()) => new TalkSnippet(app, data).runSnippet()
  }
}

const timingCases = [
  ['20 characters without TTS', twentyChars, 0, '', 3350, 3550],
  ['equivalent real speech', twentyChars, 2860, '', 3416.667, 3416.667],
  ['longer real speech', twentyChars, 4000, '', 4566.667, 4566.667],
  ['short text minimum', 'あ', 0, '', 2083.333, 2283.333],
  ['empty text minimum', '', 0, '', 2016.667, 2216.667],
  ['long text is not capped', 'あ'.repeat(300), 0, '', 22016.667, 22216.667],
  ['audio over 30 seconds is capped by auto_voice_timeout', 'あ', 60000, '', 30566.667, 30766.667],
  ['ttsText without a voice file stays silent pacing', twentyChars, 0, 'い'.repeat(30), 3350, 3550],
  ['short ttsText still waits for visible text', twentyChars, 0, 'い', 3350, 3550],
  ['real speech replaces long ttsText estimate', twentyChars, 1000, 'い'.repeat(100), 3350, 3550],
  ['UTF-16 length matches UIText', '😀'.repeat(10), 0, '', 3350, 3550],
  ['NaN falls back to estimation', twentyChars, NaN, '', 3350, 3550],
  ['Infinity falls back to estimation', twentyChars, Infinity, '', 3350, 3550],
  ['negative duration falls back to estimation', twentyChars, -100, '', 3350, 3550]
]

for (const [name, content, ttsDurationMs, ttsText, expected, withWindow] of timingCases) {
  test(`Talk timing: ${name}`, (t) => {
    const f = fixture(t)
    const calculator = f.load('utils/TimelineCalculator.ts')
    const snippet = talk(content, { ttsText, delay: 10 })
    const result = calculator.calculateTimeline(
      [snippet],
      new Map([[0, { snippetIndex: 0, durationMs: ttsDurationMs }]])
    )
    assert.equal(result.entries[0].durationMs, withWindow, 'Timeline includes the 0.2s window open')
    assert.equal(result.entries[0].hasTTS, Number.isFinite(ttsDurationMs) && ttsDurationMs > 0)
    assert.equal(typeof f.timing.calculateTalkDurationMs, 'function')
    assert.equal(f.timing.calculateTalkDurationMs(content, ttsDurationMs, ttsText), expected)
    if (!(Number.isFinite(ttsDurationMs) && ttsDurationMs > 0)) {
      assert.equal(calculator.estimateSnippetDuration(snippet), expected)
    }
  })
}

test('UIText keeps UTF-16 typewriter progress and shares the display constant', async (t) => {
  const f = fixture(t)
  assert.equal(f.timing.TALK_DISPLAY_MS_PER_CHAR, 66.667)
  assert.equal(f.timing.TALK_ESTIMATED_SPEECH_MS_PER_CHAR, 143)
  assert.equal(f.timing.TALK_TAIL_MS, 500)
  assert.equal(f.timing.MIN_TALK_DURATION_MS, 0)
  f.uiText.data = '😀'.repeat(10)
  const run = f.uiText.startDisplayContent()
  await f.clock.tickAsync(800)
  assert.equal(f.uiText.text.length, 12)
  await f.clock.tickAsync(800)
  await run
  assert.equal(f.uiText.text, f.uiText.data)
})

test('UIText counts the official UTF-16 body length, including its newlines', async (t) => {
  const f = fixture(t)
  // 官方正文的换行计入 UTF-16 长度；排版折行的零宽空格标记不计。
  assert.equal(f.timing.visibleTextLength('あ\nい'), 3)
  assert.equal(f.timing.sliceVisibleText('あ\nい', 1), 'あ')
  assert.equal(f.timing.sliceVisibleText('あ\nい', 2), 'あ\n')
  assert.equal(f.timing.sliceVisibleText('あ\nい', 3), 'あ\nい')
  assert.equal(f.timing.talkTypingDurationMs('あ\nい'), 200)
  assert.equal(f.timing.talkTypingDurationMs('あい'), 133.333)
  assert.equal(f.timing.calculateTalkDurationMs('あ\nい', 0), 2216.667)
  assert.equal(f.timing.calculateTalkDurationMs('あい', 0), 2150)

  f.uiText.data = `${'あ'.repeat(26)}\n${'い'.repeat(4)}`
  const run = f.uiText.startDisplayContent()
  await f.clock.tickAsync(31 * 66.667 + 20)
  await run
  assert.equal(f.uiText.text, f.uiText.data)
})

test('non-Talk timeline and estimate rules are unchanged', (t) => {
  const f = fixture(t)
  const calculator = f.load('utils/TimelineCalculator.ts')
  const snippets = [
    { type: 'Telop', delay: 1, data: { content: twentyChars } },
    { type: 'BlackOut', delay: 10, data: { duration: 2 } },
    { type: 'Motion', delay: 1, data: { actions: [], duration: 40 } }
  ]
  assert.deepEqual(
    Array.from(calculator.calculateTimeline(snippets).entries, (e) => e.durationMs),
    [2666.667, 2016.667, 40000]
  )
  assert.equal(calculator.estimateSnippetDuration(snippets[1]), 10000)
})

for (const [name, envelope] of [
  ['TTS disabled or failed', null],
  ['empty decoded envelope', { values: new Float32Array(), durationMs: 100, frameMs: 20 }],
  ...[0, -1, NaN, Infinity].map((durationMs) => [
    `invalid envelope duration ${durationMs}`,
    { values: new Float32Array([0.4]), durationMs, frameMs: 20 }
  ])
]) {
  test(`text lip sync without a usable voice envelope: ${name}`, async (t) => {
    const f = fixture(t)
    f.app.currentTalkLipSync = envelope
    const model = f.models.get(1)
    const run = f.run(talk(twentyChars, { facial: 'smile', motion: 'wave' }))
    await f.clock.tickAsync(0)
    assert.equal(model.internalModel.listenerCount('beforeModelUpdate'), 1)
    model.internalModel.emit('beforeModelUpdate')
    assert.ok(model.writes.length > 0, 'Official text lip sync writes LipLevels values')
    assert.ok(model.writes.at(-1).value > 0)
    await f.clock.runAllAsync()
    await run
    assert.equal(model.internalModel.listenerCount('beforeModelUpdate'), 0)
    assert.equal(f.actions.length, 1, 'Silent dialogue still starts body and facial actions')
    assert.equal(f.clock.countTimers(), 0)
  })
}

function voicedEnvelope(f) {
  return f
    .load('utils/LipSyncEnvelope.ts')
    .buildLipSyncEnvelope([new Float32Array(4800).fill(0.2)], 48000)
}

for (const id of [1, 2]) {
  test(`valid envelope drives Cubism ${id === 1 ? 4 : 2} then detaches at deadline`, async (t) => {
    const f = fixture(t)
    const model = f.models.get(id)
    const envelope = voicedEnvelope(f)
    f.app.currentTalkLipSync = envelope
    f.app.lastSnippetActualDurationMs = 3460
    const run = f.run(talk(twentyChars, { modelId: id }))
    await f.clock.tickAsync(40)
    assert.equal(model.internalModel.listenerCount('beforeModelUpdate'), 1)
    model.internalModel.emit('beforeModelUpdate')
    const sampled = f
      .load('utils/LipSyncEnvelope.ts')
      .sampleLipSync(envelope, f.clock.now - f.app.currentTalkStartedAtMs)
    const written = model.writes.at(-1).value
    // 没有音节正弦、没有插值：写入值就是包络在该 60Hz 步上的值。
    assert.equal(written, sampled, 'speaker opening is the envelope value at this step')
    assert.ok(written > 0)
    model.visible = false
    const beforeHidden = model.writes.length
    model.internalModel.emit('beforeModelUpdate')
    assert.equal(model.writes.length, beforeHidden)
    model.visible = true
    await f.clock.tickAsync(100)
    model.internalModel.emit('beforeModelUpdate')
    const afterVoice = model.writes.at(-1).value
    assert.ok(afterVoice > 0, 'the mouth releases instead of snapping shut at the audio end')
    assert.ok(afterVoice < 0.6, `release must decay: ${afterVoice}`)
    // 样本放完后 smooth 继续衰减；到 <0.001 的那一步官方换成 Lip::None（脱手），
    // 之后不再写 ParamMouthOpenY，参数回到动作/表情/默认值。
    await f.clock.tickAsync(420)
    const beforeRelease = model.writes.length
    model.internalModel.emit('beforeModelUpdate')
    assert.equal(model.writes.length, beforeRelease, 'the release detaches without writing')
    assert.equal(model.released, true, 'releaseMouth is called once past the release step')
    await f.clock.tickAsync(3020)
    assert.equal(model.internalModel.listenerCount('beforeModelUpdate'), 0)
    await run
    const afterEnd = model.writes.length
    model.internalModel.emit('beforeModelUpdate')
    assert.equal(
      model.writes.length,
      afterEnd,
      'The finished snippet cannot override later expressions'
    )
  })
}

for (const end of ['abort', 'destroy', 'UI error']) {
  test(`mouth cleanup on ${end} leaves no listener`, async (t) => {
    const f = fixture(t)
    const model = f.models.get(1)
    f.app.currentTalkLipSync = voicedEnvelope(f)
    if (end === 'UI error')
      f.app.layerUI.startDisplayContent = async () => {
        throw new Error('UI error')
      }
    const run = f.run()
    const outcome = run.catch((error) => error)
    await f.clock.tickAsync(100)
    if (end === 'abort') f.abort.abort()
    if (end === 'destroy') model.destroy()
    assert.equal(model.internalModel.listenerCount('beforeModelUpdate'), 0)
    const writes = model.writes.length
    model.internalModel.emit('beforeModelUpdate')
    assert.equal(model.writes.length, writes)
    await f.clock.runAllAsync()
    const result = await outcome
    if (end === 'UI error') assert.match(result.message, /UI error/)
    assert.equal(f.clock.countTimers(), 0)
  })
}

test('already destroyed models cannot acquire a mouth listener', async (t) => {
  const f = fixture(t)
  f.models.get(1).destroy()
  f.app.currentTalkLipSync = voicedEnvelope(f)
  const run = f.run(talk('あ'))
  await f.clock.tickAsync(0)
  assert.equal(f.models.get(1).internalModel.listenerCount('beforeModelUpdate'), 0)
  await f.clock.runAllAsync()
  await run
})

test('a listener stays shut while the speaker keeps a moving mouth through parameter restore', async (t) => {
  const f = fixture(t)
  const speaker = f.models.get(1)
  const listener = f.models.get(2)
  // 听者自己的 updateMotions 在网格定稿前把嘴张开。
  // 口型必须写在这个模型自己的 core.update() 之前，才能进本帧网格。
  for (const model of [speaker, listener]) {
    model.internalModel.coreModel.update = () => {}
  }
  f.app.layerModel.getVisibleModels = () => [speaker, listener]
  const samples = new Float32Array(48000)
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.sin((i / 48000) * 2 * Math.PI * 180) * 0.4
  }
  f.app.currentTalkLipSync = f
    .load('utils/LipSyncEnvelope.ts')
    .buildLipSyncEnvelope([samples], 48000)
  const run = f.run(talk('今天也一起练习吧。', { modelId: 1 }))
  const speakerOpens = []
  for (const ms of [200, 280, 360, 440]) {
    await f.clock.tickAsync(ms === 200 ? 200 : 80)
    speaker.internalModel.emit('beforeModelUpdate')
    listener.internalModel.emit('beforeModelUpdate')
    // 动作先把嘴张开，再进被口型钩子包住的 core.update（网格定稿前重写）。
    for (const model of [speaker, listener]) {
      const core = model.internalModel.coreModel
      core.setParameterValueById('motion-opened', 0.9)
      core.setParamFloat('motion-opened', 0.9)
      core.update()
    }
    const speakerMouth = [...speaker.writes]
      .reverse()
      .find((entry) => entry.param === 'ParamMouthOpenY')
    speakerOpens.push({ at: f.clock.now, open: speakerMouth.value })
    // 听者只挂自己的动作参数：口型监听只属于本次 talk 的 speaker，不写 0。
    assert.equal(
      listener.writes.some((entry) => entry.param === 'ParamMouthOpenY'),
      false,
      `listener must not be written by the speaker's lip sync at ${ms}ms`
    )
    assert.equal(listener.mouthCalls.length, 0, 'listener setMouthOpening is never called')
  }
  // 说话人的嘴跟随包络（不再叠 8Hz 正弦），每帧写入包络在该 60Hz 步上的值。
  for (const { at, open } of speakerOpens) {
    const expected = f
      .load('utils/LipSyncEnvelope.ts')
      .sampleLipSync(f.app.currentTalkLipSync, at - f.app.currentTalkStartedAtMs)
    assert.equal(open, expected, `speaker mouth at ${at}ms`)
    assert.ok(open > 0)
  }
  await f.clock.runAllAsync()
  await run
})

test('a constant envelope holds the mouth flat across 30 story steps', async (t) => {
  const f = fixture(t)
  const model = f.models.get(1)
  const stepMs = 1000 / 60
  const values = new Float32Array(200).fill(0.75)
  f.app.currentTalkLipSync = {
    values,
    frameMs: stepMs,
    durationMs: values.length * stepMs,
    audioDurationMs: values.length * stepMs,
    releaseStep: values.length - 1,
    targetValueScale: 1,
    powK: 1.75
  }
  const run = f.run(talk())
  const opens = []
  for (let i = 0; i < 31; i++) {
    await f.clock.tickAsync(stepMs)
    model.internalModel.emit('beforeModelUpdate')
    opens.push(model.writes.at(-1).value)
  }
  for (let i = 1; i < opens.length; i++) {
    assert.ok(
      Math.abs(opens[i] - opens[i - 1]) <= 1e-6,
      `story step ${i}: ${opens[i - 1]} -> ${opens[i]}`
    )
  }
  for (const open of opens) assert.equal(open, 0.75)
  await f.clock.runAllAsync()
  await run
})

test('a listener keeps its own facial mouth value', async (t) => {
  const f = fixture(t)
  const speaker = f.models.get(1)
  const listener = f.models.get(2)
  const listenerValues = new Map()
  listener.internalModel.coreModel.update = () => {}
  listener.internalModel.coreModel.setParameterValueById = (id, value) =>
    listenerValues.set(id, value)
  f.app.layerModel.getVisibleModels = () => [speaker, listener]
  const samples = new Float32Array(4800)
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.sin((i / 48000) * 2 * Math.PI * 180) * 0.4
  }
  f.app.currentTalkLipSync = f
    .load('utils/LipSyncEnvelope.ts')
    .buildLipSyncEnvelope([samples], 48000)
  const run = f.run(talk('今天也一起练习吧。', { modelId: 1 }))
  await f.clock.tickAsync(200)
  speaker.internalModel.emit('beforeModelUpdate')
  listener.internalModel.emit('beforeModelUpdate')
  // 表情把听者的嘴写成 0.8；口型不挂听者，这一帧最终值仍是 0.8。
  listener.internalModel.coreModel.setParameterValueById('ParamMouthOpenY', 0.8)
  listener.internalModel.coreModel.update()
  assert.equal(listenerValues.get('ParamMouthOpenY'), 0.8)
  assert.equal(listener.mouthCalls.length, 0, 'the listener is never driven by the talk lip')
  await f.clock.runAllAsync()
  await run
})

test('voiced to silent dialogue moves text lip sync to the current speaker only', async (t) => {
  const f = fixture(t)
  f.app.currentTalkLipSync = voicedEnvelope(f)
  let run = f.run(talk('あ'))
  await f.clock.runAllAsync()
  await run
  f.app.currentTalkLipSync = null
  const previousWrites = new Map(Array.from(f.models, ([id, model]) => [id, model.writes.length]))
  for (const modelId of [1, 2]) {
    run = f.run(talk('あ', { modelId, facial: 'smile' }))
    await f.clock.tickAsync(0)
    for (const [id, model] of f.models) {
      assert.equal(model.internalModel.listenerCount('beforeModelUpdate'), id === modelId ? 1 : 0)
      model.internalModel.emit('beforeModelUpdate')
    }
    await f.clock.runAllAsync()
    await run
    for (const model of f.models.values()) {
      assert.equal(model.internalModel.listenerCount('beforeModelUpdate'), 0)
    }
  }
  assert.ok(f.models.get(1).writes.length > previousWrites.get(1))
  assert.ok(f.models.get(2).writes.length > previousWrites.get(2))
  assert.equal(f.actions.length, 2)
})

for (const delay of [0, 1, 10]) {
  test(`BaseSnippet applies ${delay}s delay once, outside the 3550ms dialogue deadline`, async (t) => {
    const f = fixture(t)
    const snippet = talk(twentyChars, { delay })
    const timeline = f.load('utils/TimelineCalculator.ts').calculateTimelineWithoutTTS([snippet])
    assert.equal(timeline.entries[0].durationMs, 3550)
    f.app.lastSnippetActualDurationMs = timeline.entries[0].durationMs
    let finished = false
    const run = f.run(snippet).then(() => {
      finished = true
    })
    if (delay > 0) {
      await f.clock.tickAsync(delay * 1000 - 1)
      assert.equal(f.starts.length, 0)
      await f.clock.tickAsync(1)
    } else {
      await f.clock.tickAsync(0)
    }
    assert.deepEqual(f.starts, [delay * 1000])
    await f.clock.tickAsync(3550)
    assert.equal(finished, true)
    await run
    assert.ok(Math.abs(f.clock.now - (delay * 1000 + 3550)) <= 1, `finish ${f.clock.now}`)
  })
}

for (const planned of [2200, 4600, 60600]) {
  test(`TalkSnippet honors resolved ${planned}ms, without another estimate lower bound`, async (t) => {
    const f = fixture(t)
    f.app.lastSnippetActualDurationMs = planned
    let finished = false
    const run = f.run().then(() => {
      finished = true
    })
    await f.clock.tickAsync(planned - 1)
    assert.equal(finished, false)
    await f.clock.tickAsync(1)
    assert.equal(finished, true)
    await run
  })
}

for (const planned of [0, -1, NaN, Infinity]) {
  test(`TalkSnippet falls back to content/ttsText for invalid plan ${planned}`, async (t) => {
    const f = fixture(t)
    f.app.lastSnippetActualDurationMs = planned
    const run = f.run(talk(twentyChars, { delay: 10, ttsText: 'い' }))
    await f.clock.runAllAsync()
    await run
    assert.equal(f.clock.now, 13350)
  })
}

test('three consecutive silent lines use three independent body deadlines', async (t) => {
  const f = fixture(t)
  const snippets = [talk(), talk(), talk()]
  const timeline = f.load('utils/TimelineCalculator.ts').calculateTimelineWithoutTTS(snippets)
  const ends = []
  const run = (async () => {
    for (const [i, snippet] of snippets.entries()) {
      f.app.lastSnippetActualDurationMs = timeline.entries[i].durationMs
      await f.run(snippet)
      ends.push(f.clock.now)
    }
  })()
  await f.clock.runAllAsync()
  await run
  assert.deepEqual(f.starts, [0, 3550, 6900])
  assert.deepEqual(ends, [3550, 6900, 10250])
  assert.equal(f.clock.countTimers(), 0)
})

test('actions retain proportional timing and deadline cues without stopping active motions', async (t) => {
  const f = fixture(t)
  f.app.lastSnippetActualDurationMs = 3460
  const run = f.run(
    talk(twentyChars, {
      delay: 1,
      actions: [0, 0.5, 1].map((at) => ({ at, modelId: 1, motion: `motion-${at}` }))
    })
  )
  await f.clock.tickAsync(2729)
  assert.deepEqual(
    f.actions.map((entry) => entry.at),
    [1000]
  )
  await f.clock.tickAsync(1)
  assert.deepEqual(
    f.actions.map((entry) => entry.at),
    [1000, 2730]
  )
  await f.clock.tickAsync(1730)
  await run
  assert.deepEqual(
    f.actions.map((entry) => entry.at),
    [1000, 2730, 4460]
  )
  assert.ok(
    f.actions.every((entry) => entry.signal.aborted),
    'Pending loads are invalidated on completion'
  )
})

test('abort cancels future action cues and invalidates pending loads', async (t) => {
  const f = fixture(t)
  const run = f.run(
    talk(twentyChars, {
      actions: [0, 0.5, 1].map((at) => ({ at, modelId: 1, facial: `facial-${at}` }))
    })
  )
  await f.clock.tickAsync(100)
  f.abort.abort()
  await f.clock.runAllAsync()
  await run
  assert.equal(f.actions.length, 1)
  assert.equal(f.actions[0].signal.aborted, true)
  assert.equal(f.clock.countTimers(), 0)
})

function patchTimeline() {
  return [
    {
      snippetIndex: 0,
      startTimeMs: 0,
      durationMs: 4230,
      endTimeMs: 4230,
      ttsDurationMs: 0,
      hasTTS: false
    },
    {
      snippetIndex: 1,
      startTimeMs: 4230,
      durationMs: 1800,
      endTimeMs: 6030,
      ttsDurationMs: 0,
      hasTTS: false
    },
    {
      snippetIndex: 2,
      startTimeMs: 6030,
      durationMs: 1800,
      endTimeMs: 7830,
      ttsDurationMs: 0,
      hasTTS: false
    }
  ]
}

for (const [name, audio, target] of [
  ['shrink', 2860, 3460],
  ['grow', 4000, 4600]
]) {
  test(`talkPatch can ${name} and keeps shared array and entry identities`, (t) => {
    const f = fixture(t)
    const { applyTalkPatch } = f.load('managers/video-export/talkPatch.ts')
    const timeline = patchTimeline()
    const original = [...timeline]
    assert.equal(applyTalkPatch(timeline, 0, audio, target), target)
    for (const [i, entry] of timeline.entries()) assert.equal(entry, original[i])
    assert.equal(timeline[0].durationMs, target)
    assert.equal(timeline[0].ttsDurationMs, audio)
    assert.equal(timeline[0].hasTTS, true)
    assert.equal(timeline[1].startTimeMs, target)
    assert.equal(timeline[2].endTimeMs, target + 3600)
  })
}

test('talkPatch updates metadata at zero delta, clears failed audio and tolerates missing entry', (t) => {
  const f = fixture(t)
  const { applyTalkPatch } = f.load('managers/video-export/talkPatch.ts')
  const timeline = patchTimeline()
  applyTalkPatch(timeline, 0, 3630, 4230)
  assert.equal(timeline[0].ttsDurationMs, 3630)
  assert.equal(timeline[0].hasTTS, true)
  for (const invalid of [0, NaN, Infinity, -1]) {
    applyTalkPatch(timeline, 0, invalid, 4230)
    assert.equal(timeline[0].ttsDurationMs, 0)
    assert.equal(timeline[0].hasTTS, false)
  }
  assert.equal(applyTalkPatch([], 0, 2860, 3460), 3460)
})

test('talkPatch keeps concurrent non-blocking cues after Talk at the Talk start cursor', (t) => {
  const f = fixture(t)
  const { applyTalkPatch } = f.load('managers/video-export/talkPatch.ts')
  const timeline = [
    {
      snippetIndex: 0,
      delayStartTimeMs: 1000,
      startTimeMs: 1000,
      durationMs: 2000,
      endTimeMs: 3000,
      ttsDurationMs: 0,
      hasTTS: false,
      blocking: true
    },
    {
      snippetIndex: 1,
      delayStartTimeMs: 1000,
      startTimeMs: 1000,
      durationMs: 0,
      endTimeMs: 1000,
      ttsDurationMs: 0,
      hasTTS: false,
      blocking: false
    },
    {
      snippetIndex: 2,
      delayStartTimeMs: 3000,
      startTimeMs: 3000,
      durationMs: 1500,
      endTimeMs: 4500,
      ttsDurationMs: 0,
      hasTTS: false,
      blocking: true
    }
  ]
  applyTalkPatch(timeline, 0, 4000, 4500)
  assert.equal(timeline[0].endTimeMs, 5500)
  assert.equal(timeline[1].startTimeMs, 1000, 'PlaySe/Now right after Talk stays at Talk start')
  assert.equal(
    timeline[1].delayStartTimeMs,
    1000,
    'concurrent cue delayStartTimeMs stays at Talk start'
  )
  assert.equal(timeline[2].startTimeMs, 5500, 'subsequent blocking Talk shifts to patched end')
  assert.equal(
    timeline[2].delayStartTimeMs,
    5500,
    'subsequent blocking Talk delayStartTimeMs shifts too'
  )
})

// Exercise both real export loops (not a regex/source inspection). Preparation,
// GPU capture, TTS network results and final encoding/IPC are isolated boundaries.
// Both loops still execute real snippets, timeline calculation, patching, envelope
// preparation, action scheduling and timestamp recording.
function exportFixture(
  t,
  {
    snippets,
    results = [],
    enabled = true,
    missingTimeline = false,
    decodeFails = false,
    fps = 10,
    fastFps,
    bgmEnabled = false,
    onClockTick,
    onStorySteps,
    onRender,
    onMixAudioTracks,
    onDecodeAudioData,
    driveExportSteps = false
  }
) {
  const f = fixture(t, { driveExportSteps })
  const planned = []
  const patchCalls = []
  const { applyTalkPatch } = f.load('managers/video-export/talkPatch.ts')
  f.load('managers/video-export/talkPatch.ts').applyTalkPatch = (...args) => {
    patchCalls.push(args)
    return applyTalkPatch(...args)
  }
  const calculator = f.load('utils/TimelineCalculator.ts')
  class Empty {
    reset = noop
    clearCheckpoint = noop
    start = noop
    update = noop
    stop = noop
    hasCheckpoint = () => false
  }
  class AudioMuxer {
    initialize = async () => {}
    setBGMConfig = noop
    loadBGMBuffer = async () => ({ duration: 10 })
    addAudioTrack = noop
    mixAudioTracks = async (durationMs) => {
      onMixAudioTracks?.(durationMs)
      return {}
    }
    audioBufferToWav = async () => new ArrayBuffer(0)
    dispose = noop
  }
  class Pipeline {
    startTTSPipeline = noop
    markRenderStart = noop
    markRenderEnd = noop
    waitForTTSReady = async (index) => results[index]
    waitForTTSPipeline = async () => {}
    isTTSReady = () => true
    dispose = async () => {}
  }
  class ClockBoundary {
    install = noop
    uninstall = noop
    now = () => f.clock.now
    realTimeMs = () => f.clock.now
    realSleep = () => new Promise((resolve) => setImmediate(resolve))
    tick = (ms) => {
      onClockTick?.(ms)
      return f.clock.tickAsync(ms)
    }
    advanceStorySteps = async (steps, onStep) => {
      onStorySteps?.(steps)
      for (let i = 0; i < steps; i++) {
        onClockTick?.(1000 / 60)
        await f.clock.tickAsync(1000 / 60)
        onStep?.(f.clock.now)
      }
    }
  }
  class JpegSink {
    initialize = async () => {}
    captureFrame = async () => {}
    finish = async () => 'fixture-frames'
    dispose = async () => {}
  }
  f.mocks.set(path.join(renderer, 'managers/video-export/ExportLogger.ts'), {
    ExportLogger: f.Logger
  })
  const { SnippetTimestampRecorder } = f.load('managers/video-export/SnippetTimestampRecorder.ts')
  f.mocks.set('./video-export', {
    ExportLogger: f.Logger,
    CheckpointManager: Empty,
    ErrorRecoveryManager: Empty,
    ProgressTracker: Empty,
    AudioMuxer,
    ConcurrentExportPipeline: Pipeline,
    SnippetTimestampRecorder,
    exportTraceContext: { setSnippet() {}, reset() {} },
    motionTrace: { reset() {}, snapshot: () => [] },
    exportLogBus: { reset() {}, snapshot: () => [] },
    buildExportDiagnostics: () => ({
      summary: { snippets: 0, talks: 0, anomalies: 0, motionEvents: 0, logEntries: 0 }
    }),
    sanitizeDiagnostics: (value) => value
  })
  f.mocks.set('./video-export/VirtualClockController', { VirtualClockController: ClockBoundary })
  f.mocks.set('./video-export/JpegFrameSink', { JpegFrameSink: JpegSink })
  f.mocks.set('./video-export/WebCodecsMp4Encoder', {})
  f.mocks.set('../utils/WebGLContextValidator', {})
  f.mocks.set('../utils/FrameContentValidator', {
    frameValidator: { reset: noop, validateFrame: () => ({ isValid: true, isBlackScreen: false }) }
  })
  f.mocks.set('../utils/ResourceUrl', { resolveBgmUrl: (p) => p })
  f.context.OfflineAudioContext = class {
    async decodeAudioData() {
      onDecodeAudioData?.()
      if (decodeFails) throw new Error('fixture decode failed')
      return {
        numberOfChannels: 1,
        sampleRate: 48000,
        getChannelData: () => new Float32Array(4800).fill(0.2)
      }
    }
  }
  f.context.window = {
    electron: {
      ipcRenderer: { invoke: async () => ({ id: 'fixture', success: true, fileSize: 123 }) }
    }
  }
  const Manager = f.load('managers/VideoExportManager.ts').default
  const canvas = { width: 1920, height: 1080, addEventListener: noop, removeEventListener: noop }
  f.app.pixiApplication = {
    ticker: { start: noop, stop: noop },
    render: () => onRender?.(f.clock.now)
  }
  f.app.ttsManager = {
    isTTSEnabled: () => enabled,
    checkTTSAvailability: async () => true,
    getBGMConfig: () => (bgmEnabled ? { enabled: true, path: 'bgm.mp3' } : { enabled: false }),
    getConfig: () => ({ provider: 'gpt-sovits' }),
    buildTimelineWithoutTTS: (data) =>
      missingTimeline ? [] : calculator.calculateTimelineWithoutTTS(data).entries,
    setTimeline: (value) => {
      f.timeline = value
    },
    getAudioBufferForSnippet: () => new ArrayBuffer(8),
    clearAudioTracks: noop
  }
  f.app.snippetStrategyManager = {
    async handleSnippetForExport(snippet) {
      planned.push(f.app.lastSnippetActualDurationMs)
      await f.run(snippet)
    }
  }
  const manager = new Manager(f.app)
  manager.prepareStreamRecording = async () => ({ canvas, snippets, captureFps: fps })
  manager.resolveFastUseWebCodecs = async () => false
  const options = {
    fps,
    ...(fastFps !== undefined ? { fastFps } : {}),
    width: 1920,
    height: 1080,
    quality: 1,
    apiMode: true
  }
  return {
    ...f,
    manager,
    planned,
    patchCalls,
    async export(mode, extra = {}) {
      if (mode === 'record') {
        const run = manager.exportVideo({ ...options, ...extra, exportMode: 'record' }, noop)
        await f.clock.tickAsync(0)
        return run
      }
      return manager.exportVideoFast({ ...options, ...extra, exportMode: 'fast' }, null, null, noop)
    }
  }
}

for (const mode of ['record', 'fast']) {
  test(`${mode} (delegating to fast) uses the shared target helper/patch for success and failure`, async (t) => {
    const snippets = [
      talk(twentyChars, { ttsText: 'い'.repeat(40) }),
      talk(),
      talk(twentyChars, { ttsText: 'い', delay: 1 })
    ]
    const f = exportFixture(t, {
      snippets,
      results: [
        { success: true, duration: 2860 },
        { success: true, duration: 4000 },
        { success: false }
      ]
    })
    assert.equal((await f.export(mode)).success, true)
    assert.deepEqual(f.planned, [3416.667, 4566.667, 3350])
    assert.equal(f.patchCalls.length, 3, 'Both real entry paths must reuse talkPatch')
    assert.deepEqual(
      f.patchCalls.map((args) => [args[1], args[2], args[3]]),
      [
        [0, 2860, 3416.667],
        [1, 4000, 4566.667],
        [2, 0, 3350]
      ]
    )
    assert.ok(
      f.timingCalls.some(
        ({ args }) =>
          args[0] === twentyChars && args[1] === 2860 && args[2] === snippets[0].data.ttsText
      )
    )
    assert.equal(f.models.get(1).internalModel.listenerCount('beforeModelUpdate'), 0)
  })

  test(`${mode} disabled TTS and a missing entry do not count the 10s pre-delay twice`, async (t) => {
    const f = exportFixture(t, {
      snippets: [talk(twentyChars, { delay: 10 })],
      enabled: false,
      missingTimeline: true
    })
    assert.equal((await f.export(mode)).success, true)
    assert.deepEqual(f.planned, [3550])
    assert.ok(f.models.get(1).writes.length > 0, 'text lip sync writes mouth values')
  })

  test(`${mode} decoding failure falls back to text lip sync with real speech duration`, async (t) => {
    const f = exportFixture(t, {
      snippets: [talk()],
      results: [{ success: true, duration: 4000 }],
      decodeFails: true
    })
    assert.equal((await f.export(mode)).success, true)
    assert.deepEqual(f.planned, [4566.667])
    assert.ok(f.models.get(1).writes.length > 0, 'text lip sync writes mouth values')
    assert.equal(f.models.get(1).internalModel.listenerCount('beforeModelUpdate'), 0)
    assert.ok(f.warnings.some(([message]) => /skipping lip sync/i.test(message)))
    assert.ok(f.warnings.every(([message]) => !/text rhythm/i.test(message)))
  })
}

test('fast export drives fixed 1/60 story steps (two per 30fps frame) and computes ending envelope accurately', async (t) => {
  const tickDeltas = []
  const mixedDurations = []
  const f = exportFixture(t, {
    snippets: [talk('あ'.repeat(4))],
    enabled: false,
    fps: 60,
    fastFps: 30,
    bgmEnabled: true,
    driveExportSteps: false,
    onClockTick: (ms) => tickDeltas.push(ms),
    onMixAudioTracks: (ms) => mixedDurations.push(ms)
  })
  const resNoEnvelope = await f.export('fast')
  assert.equal(resNoEnvelope.success, true)
  assert.ok(tickDeltas.length > 0)
  // 固定 1/60 故事步：30fps 每输出帧 2 步，绝不会出现 33ms 的单步或 16ms rAF 抖动。
  assert.ok(
    tickDeltas.every((ms) => Math.abs(ms - 1000 / 60) < 1e-6),
    `Expected every virtual step to be 1/60s, got ${Math.min(...tickDeltas)}..${Math.max(...tickDeltas)}`
  )
  assert.equal(
    tickDeltas.length,
    2 * (resNoEnvelope.timings.encodedFrames - 1),
    'frame n is story frame floor(n×60/30): 2 steps per frame transition, no warmup offset'
  )
  // Without setEndingEnvelope, audio mix duration must NOT add a hardcoded +500ms tail.
  // 成片帧 0 是故事帧 0，PlayCore 前 10 帧（166.667ms）也在成片里，所以音频至少多出这段。
  const snippetDur = Math.round(f.planned[0])
  const warmupMs = (10 * 1000) / 60
  assert.ok(
    mixedDurations[0] >= snippetDur + warmupMs - 1 &&
      mixedDurations[0] < snippetDur + warmupMs + 100,
    `Expected no hardcoded +500ms tail when setEndingEnvelope is absent, got mix=${mixedDurations[0]} vs snippet=${snippetDur}+${warmupMs}`
  )

  // Now with setEndingEnvelope present, tail equals PLAYED_WAIT_TIME_MS + SCENARIO_EXIT_BGM_FADE_MS (500ms).
  mixedDurations.length = 0
  f.app.setEndingEnvelope = async (holdMs, fadeMs) => {
    await new Promise((r) => setTimeout(r, holdMs + fadeMs))
  }
  const resWithEnvelope = await f.export('fast')
  assert.equal(resWithEnvelope.success, true)
  assert.ok(
    mixedDurations[0] >= snippetDur + 500,
    `Expected accurate 500ms ending envelope tail, got ${mixedDurations[0]}`
  )
})

test('video frame n renders story frame n: frame 0 at 0ms, two 1/60 steps per 30fps frame', async (t) => {
  const renderTimes = []
  const f = exportFixture(t, {
    snippets: [talk('あ'.repeat(4))],
    enabled: false,
    fps: 30,
    fastFps: 30,
    onRender: (ms) => renderTimes.push(ms)
  })
  const res = await f.export('fast')
  assert.equal(res.success, true)
  const pumpRenders = renderTimes.slice(-res.timings.encodedFrames)
  assert.equal(pumpRenders.length, res.timings.encodedFrames)
  assert.ok(
    Math.abs(pumpRenders[0]) < 2,
    `frame 0 must render at story frame 0 (video frame n = story frame n), got ${pumpRenders[0]}ms`
  )
  for (const n of [1, 15, 30]) {
    assert.ok(
      Math.abs(pumpRenders[n] - (n * 1000) / 30) < 2,
      `frame ${n} must render at ${(n * 1000) / 30}ms, got ${pumpRenders[n]}`
    )
  }
})

test('25fps consumes 2,2,3,2,3 story steps per frame (no ceil), every step exactly 1/60', async (t) => {
  const tickDeltas = []
  const stepCalls = []
  const f = exportFixture(t, {
    snippets: [talk('あ'.repeat(4))],
    enabled: false,
    fps: 25,
    fastFps: 25,
    onClockTick: (ms) => tickDeltas.push(ms),
    onStorySteps: (steps) => stepCalls.push(steps)
  })
  const res = await f.export('fast')
  assert.equal(res.success, true)
  assert.deepEqual(
    stepCalls.slice(0, 5),
    [2, 2, 3, 2, 3],
    '25fps must distribute 60 steps over 25 frames by remainder, never ceil'
  )
  assert.ok(
    tickDeltas.every((ms) => Math.abs(ms - 1000 / 60) < 1e-6),
    `every story step must be 1/60s, got ${Math.min(...tickDeltas)}..${Math.max(...tickDeltas)}`
  )
  assert.equal(
    tickDeltas.length,
    Math.floor(((res.timings.encodedFrames - 1) * 60) / 25),
    'frame n maps to floor(n×60/25) story steps'
  )
})

test('24fps consumes 2,3,2,3 story steps per frame (no ceil), every step exactly 1/60', async (t) => {
  const tickDeltas = []
  const stepCalls = []
  const f = exportFixture(t, {
    snippets: [talk('あ'.repeat(4))],
    enabled: false,
    fps: 24,
    fastFps: 24,
    onClockTick: (ms) => tickDeltas.push(ms),
    onStorySteps: (steps) => stepCalls.push(steps)
  })
  const res = await f.export('fast')
  assert.equal(res.success, true)
  assert.deepEqual(
    stepCalls.slice(0, 5),
    [2, 3, 2, 3, 2],
    '24fps must distribute 60 steps over 24 frames by remainder (2,3,…), never ceil'
  )
  assert.ok(
    tickDeltas.every((ms) => Math.abs(ms - 1000 / 60) < 1e-6),
    `every story step must be 1/60s, got ${Math.min(...tickDeltas)}..${Math.max(...tickDeltas)}`
  )
  assert.equal(
    tickDeltas.length,
    Math.floor(((res.timings.encodedFrames - 1) * 60) / 24),
    'frame n maps to floor(n×60/24) story steps'
  )
})

test('serial fast export pre-decodes lip-sync envelopes before snippet loop and skips opening cover on BlackOut stories', async (t) => {
  let decodeCallsDuringSnippet = 0
  let inSnippetLoop = false
  let openingCoverCalled = 0
  const snippets = [
    { type: 'BlackOut', wait: true, delay: 0, data: { duration: 500 } },
    talk('あ'.repeat(4))
  ]
  const f = exportFixture(t, {
    snippets,
    results: [undefined, { success: true, duration: 1200 }],
    enabled: true,
    fps: 30,
    onDecodeAudioData: () => {
      if (inSnippetLoop) decodeCallsDuringSnippet++
    }
  })
  f.app.setOpeningCover = async () => {
    openingCoverCalled++
  }
  const origHandle = f.app.snippetStrategyManager.handleSnippetForExport
  f.app.snippetStrategyManager.handleSnippetForExport = async (snippet, idx) => {
    inSnippetLoop = true
    if (snippet.type === 'BlackOut') return
    return origHandle(snippet, idx)
  }
  const res = await f.export('fast', { ttsMode: 'serial' })
  assert.equal(res.success, true)
  assert.equal(
    decodeCallsDuringSnippet,
    0,
    'Serial fast export must pre-decode before snippet loop'
  )
  assert.equal(openingCoverCalled, 0, 'Must skip setOpeningCover when story starts with BlackOut')
})

test('SpecialEffectLayer fadeGen prevents setOpeningCover vs BlackOut fade collision', async (t) => {
  const f = fixture(t)
  class Sprite {
    constructor() {
      this.anchor = { set: noop }
      this.position = { set: noop }
      this.filters = [{ alpha: 0 }]
      this.visible = true
      this.alpha = 1
    }
  }
  class Container {
    children = []
    addChild(...items) {
      this.children.push(...items)
    }
    removeChild() {}
  }
  f.mocks.set('pixi.js', {
    Application: class {},
    Container,
    Sprite,
    Texture: {
      from: () => ({ valid: true, baseTexture: { valid: true } }),
      WHITE: { valid: true, baseTexture: { valid: true } },
      EMPTY: {}
    },
    Ticker: { shared: { add: noop, elapsedMS: 16 } }
  })
  f.mocks.set('../../assets/ui/ui_se_black.svg', 'ui_se_black.svg')
  f.mocks.set('../components/SEBlack', { default: Sprite })
  f.mocks.set('../effects/Ease', { runEasedTween: async () => {} })
  f.mocks.set('../effects/InappTextures', {
    inappUrl: (p) => p,
    loadInappTexture: async () => null
  })
  f.mocks.set('../effects/OfficialFilters', {
    CameraBlurFilter: class {
      spread = 0
    }
  })
  f.mocks.set('../effects/TriangleParticleEffect', {
    ScenarioEffectOverlay: class {},
    SekaiTransitionParticles: class {}
  })

  const SpecialEffectLayer = f.load('layers/SpecialEffectLayer.ts').default
  const layer = new SpecialEffectLayer({
    stage: new Container(),
    screen: { width: 1920, height: 1080 }
  })
  // Case 1: fadeOut called immediately over an already opaque opening cover must NOT snap alpha back to 0 (no bright flash)
  const coverPromise = layer.setOpeningCover(500)
  const blackOutPromise = layer.fadeOut(500, 'black')
  await f.clock.tickAsync(250)
  const coveredMidAlpha = layer.seBlackSprite.filters[0].alpha
  await f.clock.tickAsync(300)
  await Promise.all([coverPromise, blackOutPromise])
  assert.equal(
    coveredMidAlpha,
    1,
    `Expected already-opaque curtain to stay at alpha=1 without flashing bright, got ${coveredMidAlpha}`
  )
  assert.equal(
    layer.seBlackSprite.filters[0].alpha,
    1,
    'BlackOut must end fully opaque without stale fadeIn reset'
  )
  assert.equal(layer.seBlackSprite.visible, true)

  // Case 2: fadeOut after partial fade-in continues monotonically upward from current alpha without cover fight
  const partialCoverPromise = layer.setOpeningCover(500)
  await f.clock.tickAsync(250)
  const preBlackOutAlpha = layer.seBlackSprite.filters[0].alpha
  assert.ok(
    preBlackOutAlpha > 0.35 && preBlackOutAlpha < 0.65,
    `Expected half-faded opening cover ~0.5, got ${preBlackOutAlpha}`
  )
  const smoothBlackOutPromise = layer.fadeOut(500, 'black')
  await f.clock.tickAsync(250)
  const smoothMidAlpha = layer.seBlackSprite.filters[0].alpha
  await f.clock.tickAsync(300)
  await Promise.all([partialCoverPromise, smoothBlackOutPromise])
  assert.ok(
    smoothMidAlpha > preBlackOutAlpha + 0.1 && smoothMidAlpha < 0.95,
    `Expected monotonic fadeOut upward from ~0.5 without cover fight, got ${smoothMidAlpha}`
  )
  assert.equal(layer.seBlackSprite.filters[0].alpha, 1, 'Second BlackOut must end fully opaque')
})

test('SideFade panel uses content+64, reference from/to and In deactivates', async (t) => {
  const f = fixture(t)
  class Sprite {
    constructor() {
      this.anchor = { set: noop }
      this.position = {
        x: 0,
        y: 0,
        set(x, y) {
          this.x = x
          this.y = y
        }
      }
      this.scale = {
        x: 1,
        y: 1,
        set(x, y) {
          this.x = x
          this.y = y
        }
      }
      this.visible = true
      this.alpha = 1
      this.width = 0
      this.height = 0
      this.x = 0
      this.y = 0
    }
  }
  class Container {
    children = []
    position = {
      x: 0,
      y: 0,
      set(x, y) {
        this.x = x
        this.y = y
      }
    }
    visible = true
    addChild(...items) {
      this.children.push(...items)
    }
    removeChild() {}
  }
  f.mocks.set('pixi.js', {
    Application: class {},
    Container,
    Rectangle: class {
      constructor(x, y, width, height) {
        Object.assign(this, { x, y, width, height })
      }
    },
    Sprite,
    Texture: {
      from: () => ({ valid: true, baseTexture: { valid: true } }),
      WHITE: { valid: true, baseTexture: { valid: true } },
      EMPTY: {}
    },
    Ticker: { shared: { add: noop, elapsedMS: 16 } }
  })
  f.mocks.set('../../assets/ui/ui_se_black.svg', 'ui_se_black.svg')
  f.mocks.set('../components/SEBlack', { default: Sprite })
  f.mocks.set('../effects/Ease', {
    runEasedTween: async (_duration, _ease, onProgress) => {
      onProgress(0, 0)
      onProgress(1, 1)
    }
  })
  f.mocks.set('../effects/InappTextures', {
    inappUrl: (p) => p,
    loadInappTexture: async () => null
  })
  f.mocks.set('../effects/OfficialFilters', {
    CameraBlurFilter: class {
      spread = 0
    }
  })
  f.mocks.set('../effects/TriangleParticleEffect', {
    ScenarioEffectOverlay: class {},
    SekaiTransitionParticles: class {}
  })

  const SpecialEffectLayer = f.load('layers/SpecialEffectLayer.ts').default
  const layer = new SpecialEffectLayer({
    stage: new Container(),
    screen: { width: 1280, height: 720 }
  })
  const scale = 1280 / 1920
  const pad = 32 * scale
  const panelWidth = 1280 + pad * 2
  const ox = 1280 + 512 * scale

  await layer.playSideFade('Out', 'Left', 500)
  assert.equal(layer.sideFadeContainer.visible, true, 'Out keeps the panel')
  const root = layer.sideFadeContainer.children[0]
  assert.ok(Math.abs(root.width - panelWidth) < 1e-6)
  assert.ok(Math.abs(root.height - (720 + pad * 2)) < 1e-6)
  assert.ok(Math.abs(layer.sideFadeContainer.position.x - -pad) < 1e-6, 'Out ends at -pad')
  assert.ok(Math.abs(layer.sideFadeContainer.position.y - -pad) < 1e-6)

  await layer.playSideFade('In', 'Left', 500)
  assert.equal(layer.sideFadeContainer.visible, false, 'In deactivates at the end')
  assert.ok(Math.abs(layer.sideFadeContainer.position.x - (-pad + ox)) < 1e-6)
  assert.ok(Math.abs(layer.sideFadeContainer.position.y - -pad) < 1e-6)
})

test('AdvancedModel channel 0 skips duplicate active body cues without false interrupted or motion-refused errors', async (t) => {
  const f = fixture(t)
  f.mocks.set('pixi.js', {
    Text: class {},
    AlphaFilter: class {},
    Filter: class {},
    TextStyle: class {},
    Ticker: { shared: {} }
  })
  f.mocks.set('pixi-live2d-display-advanced', {
    Cubism4InternalModel: class {},
    Cubism2InternalModel: class {},
    Live2DModel: class {},
    MotionPriority: { FORCE: 3 }
  })
  f.mocks.set(path.join(renderer, 'managers/VisualEffectManager.ts'), {
    VisualEffectManager: class {}
  })
  f.mocks.set(path.join(renderer, 'effects/Ease.ts'), {
    evaluateEase: (_k, tVal) => tVal
  })
  const { motionTrace } = f.load('managers/video-export/MotionTraceCollector.ts')
  const { default: AdvancedModel } = f.load('model/AdvancedModel.ts')
  motionTrace.reset()

  const body = {
    playing: false,
    finished: true,
    state: { setReserved() {} },
    stopAllMotions: noop,
    async startMotion() {
      body.playing = true
      body.finished = false
      return true
    },
    isFinished() {
      return body.finished
    }
  }
  const facial = { ...body, isFinished: () => true }
  const model = Object.create(AdvancedModel.prototype)
  model._metadata = { id: 1 }
  model.destroyed = false
  model.actionController = new AbortController()
  model.channelGeneration = [0, 0]
  model.bodyChainArmed = false
  model.bodyChainGeneration = -1
  model.bodyChainTimer = null
  model.recentBodyMotions = []
  model.bodyIgnoredParamIds = []
  model.currentBodyMotion = null
  model.currentBodyStartedAt = 0
  model.currentBodyClipDurationMs = 0
  model.bodyFinishReported = true
  model.channelFadeSeconds = [0.5, 0.25]
  model.facialForceNext = false
  model.firstBodyCue = true
  model.defaultMotionName = null
  model.blinkState = { status: 'ready', doSleep: false, opening: 1 }
  model.internalModel = {
    parallelMotionManager: [body, facial],
    motionManager: {
      async loadMotion(name) {
        return { getDuration: () => 2.0, name }
      }
    }
  }
  model.logger = new f.Logger()

  await model.startCharacterChannel(0, 'w-normal-nod01', [], undefined, undefined, false, 1)
  await model.startCharacterChannel(0, 'w-normal-nod01', [], undefined, undefined, true, 2)
  const events = Array.from(motionTrace.snapshot())
  assert.equal(events.filter((e) => e.event === 'interrupted').length, 0)
  assert.equal(events.filter((e) => e.reason === 'motion manager refused the cue').length, 0)
  const skipped = events.find((e) => e.event === 'skipped')
  assert.ok(skipped && skipped.reason === 'same body motion already active')
})
