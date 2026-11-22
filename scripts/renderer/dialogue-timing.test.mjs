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
function fixture(t) {
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
    ['pixi.js', { Text, AlphaFilter, TextStyle: class {}, Ticker: { shared: {} } }],
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
  animation.exportTargetFPS = 125 // 8ms ticks exactly divide UIText's 80ms/character.
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
      setMouthOpening(value) {
        write('ParamMouthOpenY', value)
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
  ['20 characters without TTS', twentyChars, 0, '', 3333.333, 3533.333],
  ['equivalent real speech', twentyChars, 2860, '', 3416.667, 3416.667],
  ['longer real speech', twentyChars, 4000, '', 4550, 4550],
  ['short text minimum', 'あ', 0, '', 2066.667, 2266.667],
  ['empty text minimum', '', 0, '', 2000, 2200],
  ['long text is not capped', 'あ'.repeat(300), 0, '', 22000, 22200],
  ['audio over 30 seconds is not capped', 'あ', 60000, '', 60550, 60550],
  [
    'ttsText without a voice file stays silent pacing',
    twentyChars,
    0,
    'い'.repeat(30),
    3333.333,
    3533.333
  ],
  ['short ttsText still waits for visible text', twentyChars, 0, 'い', 3333.333, 3533.333],
  [
    'real speech replaces long ttsText estimate',
    twentyChars,
    1000,
    'い'.repeat(100),
    3333.333,
    3533.333
  ],
  ['UTF-16 length matches UIText', '😀'.repeat(10), 0, '', 3333.333, 3533.333],
  ['NaN falls back to estimation', twentyChars, NaN, '', 3333.333, 3533.333],
  ['Infinity falls back to estimation', twentyChars, Infinity, '', 3333.333, 3533.333],
  ['negative duration falls back to estimation', twentyChars, -100, '', 3333.333, 3533.333]
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

test('UIText counts visible characters, so layout newlines do not slow typing', async (t) => {
  const f = fixture(t)
  assert.equal(f.timing.visibleTextLength('あ\nい'), 2)
  assert.equal(f.timing.sliceVisibleText('あ\nい', 1), 'あ\n')
  assert.equal(f.timing.sliceVisibleText('あ\nい', 2), 'あ\nい')
  assert.equal(f.timing.talkTypingDurationMs('あ\nい'), f.timing.talkTypingDurationMs('あい'))
  assert.equal(
    f.timing.calculateTalkDurationMs('あ\nい', 0),
    f.timing.calculateTalkDurationMs('あい', 0)
  )

  f.uiText.data = `${'あ'.repeat(26)}\n${'い'.repeat(4)}`
  const run = f.uiText.startDisplayContent()
  await f.clock.tickAsync(30 * 66.667 + 20)
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
    [2666.667, 2000, 40000]
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
    assert.equal(
      model.writes.at(-1).value,
      f.load('utils/LipSyncEnvelope.ts').sampleLipSync(envelope, 40)
    )
    assert.ok(model.writes.at(-1).value > 0)
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
    await f.clock.tickAsync(300)
    model.internalModel.emit('beforeModelUpdate')
    assert.equal(model.writes.at(-1).value, 0, 'the release tail closes the mouth')
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
  test(`BaseSnippet applies ${delay}s delay once, outside the 3533ms dialogue deadline`, async (t) => {
    const f = fixture(t)
    const snippet = talk(twentyChars, { delay })
    const timeline = f.load('utils/TimelineCalculator.ts').calculateTimelineWithoutTTS([snippet])
    assert.equal(timeline.entries[0].durationMs, 3533.333)
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
    await f.clock.tickAsync(3533)
    assert.equal(finished, false)
    await f.clock.tickAsync(1)
    assert.equal(finished, true)
    await run
    assert.ok(Math.abs(f.clock.now - (delay * 1000 + 3533.333)) <= 1, `finish ${f.clock.now}`)
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
    assert.equal(f.clock.now, 13334)
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
  assert.deepEqual(f.starts, [0, 3534, 6868])
  assert.deepEqual(ends, [3534, 6868, 10202])
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
    { snippetIndex: 0, delayStartTimeMs: 1000, startTimeMs: 1000, durationMs: 2000, endTimeMs: 3000, ttsDurationMs: 0, hasTTS: false, blocking: true },
    { snippetIndex: 1, delayStartTimeMs: 1000, startTimeMs: 1000, durationMs: 0, endTimeMs: 1000, ttsDurationMs: 0, hasTTS: false, blocking: false },
    { snippetIndex: 2, delayStartTimeMs: 3000, startTimeMs: 3000, durationMs: 1500, endTimeMs: 4500, ttsDurationMs: 0, hasTTS: false, blocking: true },
  ]
  applyTalkPatch(timeline, 0, 4000, 4500)
  assert.equal(timeline[0].endTimeMs, 5500)
  assert.equal(timeline[1].startTimeMs, 1000, 'PlaySe/Now right after Talk stays at Talk start')
  assert.equal(timeline[1].delayStartTimeMs, 1000, 'concurrent cue delayStartTimeMs stays at Talk start')
  assert.equal(timeline[2].startTimeMs, 5500, 'subsequent blocking Talk shifts to patched end')
  assert.equal(timeline[2].delayStartTimeMs, 5500, 'subsequent blocking Talk delayStartTimeMs shifts too')
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
    onMixAudioTracks,
    onDecodeAudioData
  }
) {
  const f = fixture(t)
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
  f.app.pixiApplication = { ticker: { start: noop, stop: noop }, render: noop }
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
    assert.deepEqual(f.planned, [3416.667, 4550, 3333.333])
    assert.equal(f.patchCalls.length, 3, 'Both real entry paths must reuse talkPatch')
    assert.deepEqual(
      f.patchCalls.map((args) => [args[1], args[2], args[3]]),
      [
        [0, 2860, 3416.667],
        [1, 4000, 4550],
        [2, 0, 3333.333]
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
    assert.deepEqual(f.planned, [3533.333])
    assert.ok(f.models.get(1).writes.length > 0, 'text lip sync writes mouth values')
  })

  test(`${mode} decoding failure falls back to text lip sync with real speech duration`, async (t) => {
    const f = exportFixture(t, {
      snippets: [talk()],
      results: [{ success: true, duration: 4000 }],
      decodeFails: true
    })
    assert.equal((await f.export(mode)).success, true)
    assert.deepEqual(f.planned, [4550])
    assert.ok(f.models.get(1).writes.length > 0, 'text lip sync writes mouth values')
    assert.equal(f.models.get(1).internalModel.listenerCount('beforeModelUpdate'), 0)
    assert.ok(f.warnings.some(([message]) => /skipping lip sync/i.test(message)))
    assert.ok(f.warnings.every(([message]) => !/text rhythm/i.test(message)))
  })
}

test('fast export steps VirtualClockController once per frame (~33.33ms at 30fps) and computes ending envelope accurately', async (t) => {
  const tickDeltas = []
  const mixedDurations = []
  const f = exportFixture(t, {
    snippets: [talk('あ'.repeat(4))],
    enabled: false,
    fps: 60,
    fastFps: 30,
    bgmEnabled: true,
    onClockTick: (ms) => tickDeltas.push(ms),
    onMixAudioTracks: (ms) => mixedDurations.push(ms)
  })
  const resNoEnvelope = await f.export('fast')
  assert.equal(resNoEnvelope.success, true)
  assert.ok(tickDeltas.length > 0)
  // FakeTimers truncates fractional ms per tickAsync(33.33ms), so every 3rd catchup step is ~34.0ms
  // rather than invoking two <=16.67ms sub-ticks per frame.
  assert.ok(
    tickDeltas.every((ms) => ms <= 34.01),
    `Expected single virtual step per frame (~33.33ms, catchup <= 34.01ms) at 30fps, got max=${Math.max(...tickDeltas)}`
  )
  assert.ok(
    tickDeltas.some((ms) => ms >= 33),
    `Expected >=33ms single-step tick (no 16.67ms split), got max=${Math.max(...tickDeltas)}`
  )
  // Without setEndingEnvelope, audio mix duration must NOT add a hardcoded +500ms tail.
  const snippetDur = Math.round(f.planned[0])
  assert.ok(
    mixedDurations[0] >= snippetDur && mixedDurations[0] < snippetDur + 100,
    `Expected no hardcoded +500ms tail when setEndingEnvelope is absent, got mix=${mixedDurations[0]} vs snippet=${snippetDur}`
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
  assert.equal(decodeCallsDuringSnippet, 0, 'Serial fast export must pre-decode before snippet loop')
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
    Texture: { from: () => ({ valid: true, baseTexture: { valid: true } }), WHITE: { valid: true, baseTexture: { valid: true } }, EMPTY: {} },
    Ticker: { shared: { add: noop, elapsedMS: 16 } }
  })
  f.mocks.set('../../assets/ui/ui_se_black.svg', 'ui_se_black.svg')
  f.mocks.set('../components/SEBlack', { default: Sprite })
  f.mocks.set('../effects/Ease', { runEasedTween: async () => {} })
  f.mocks.set('../effects/InappTextures', { inappUrl: (p) => p, loadInappTexture: async () => null })
  f.mocks.set('../effects/OfficialFilters', { CameraBlurFilter: class { spread = 0 } })
  f.mocks.set('../effects/TriangleParticleEffect', { ScenarioEffectOverlay: class {}, SekaiTransitionParticles: class {} })

  const SpecialEffectLayer = f.load('layers/SpecialEffectLayer.ts').default
  const layer = new SpecialEffectLayer({ stage: new Container(), screen: { width: 1920, height: 1080 } })
  // Case 1: fadeOut called immediately over an already opaque opening cover must NOT snap alpha back to 0 (no bright flash)
  const coverPromise = layer.setOpeningCover(500)
  const blackOutPromise = layer.fadeOut(500, 'black')
  await f.clock.tickAsync(250)
  const coveredMidAlpha = layer.seBlackSprite.filters[0].alpha
  await f.clock.tickAsync(300)
  await Promise.all([coverPromise, blackOutPromise])
  assert.equal(coveredMidAlpha, 1, `Expected already-opaque curtain to stay at alpha=1 without flashing bright, got ${coveredMidAlpha}`)
  assert.equal(layer.seBlackSprite.filters[0].alpha, 1, 'BlackOut must end fully opaque without stale fadeIn reset')
  assert.equal(layer.seBlackSprite.visible, true)

  // Case 2: fadeOut after partial fade-in continues monotonically upward from current alpha without cover fight
  const partialCoverPromise = layer.setOpeningCover(500)
  await f.clock.tickAsync(250)
  const preBlackOutAlpha = layer.seBlackSprite.filters[0].alpha
  assert.ok(preBlackOutAlpha > 0.35 && preBlackOutAlpha < 0.65, `Expected half-faded opening cover ~0.5, got ${preBlackOutAlpha}`)
  const smoothBlackOutPromise = layer.fadeOut(500, 'black')
  await f.clock.tickAsync(250)
  const smoothMidAlpha = layer.seBlackSprite.filters[0].alpha
  await f.clock.tickAsync(300)
  await Promise.all([partialCoverPromise, smoothBlackOutPromise])
  assert.ok(smoothMidAlpha > preBlackOutAlpha + 0.1 && smoothMidAlpha < 0.95, `Expected monotonic fadeOut upward from ~0.5 without cover fight, got ${smoothMidAlpha}`)
  assert.equal(layer.seBlackSprite.filters[0].alpha, 1, 'Second BlackOut must end fully opaque')
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
