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
  ['20 characters without TTS', twentyChars, 0, '', 3460],
  ['equivalent real speech', twentyChars, 2860, '', 3460],
  ['longer real speech', twentyChars, 4000, '', 4600],
  ['short text minimum', 'あ', 0, '', 1800],
  ['empty text minimum', '', 0, '', 1800],
  ['long text is not capped', 'あ'.repeat(300), 0, '', 43500],
  ['audio over 30 seconds is not capped', 'あ', 60000, '', 60600],
  ['ttsText replaces estimated speech', twentyChars, 0, 'い'.repeat(30), 4890],
  ['short ttsText still waits for visible text', twentyChars, 0, 'い', 2200],
  ['real speech replaces long ttsText estimate', twentyChars, 1000, 'い'.repeat(100), 2200],
  ['UTF-16 length matches UIText', '😀'.repeat(10), 0, '', 3460],
  ['NaN falls back to estimation', twentyChars, NaN, '', 3460],
  ['Infinity falls back to estimation', twentyChars, Infinity, '', 3460],
  ['negative duration falls back to estimation', twentyChars, -100, '', 3460]
]

for (const [name, content, ttsDurationMs, ttsText, expected] of timingCases) {
  test(`Talk timing: ${name}`, (t) => {
    const f = fixture(t)
    const calculator = f.load('utils/TimelineCalculator.ts')
    const snippet = talk(content, { ttsText, delay: 10 })
    const result = calculator.calculateTimeline(
      [snippet],
      new Map([[0, { snippetIndex: 0, durationMs: ttsDurationMs }]])
    )
    assert.equal(result.entries[0].durationMs, expected)
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
  assert.equal(f.timing.TALK_DISPLAY_MS_PER_CHAR, 80)
  assert.equal(f.timing.TALK_ESTIMATED_SPEECH_MS_PER_CHAR, 143)
  assert.equal(f.timing.TALK_TAIL_MS, 600)
  assert.equal(f.timing.MIN_TALK_DURATION_MS, 1800)
  f.uiText.data = '😀'.repeat(10)
  const run = f.uiText.startDisplayContent()
  await f.clock.tickAsync(800)
  assert.equal(f.uiText.text.length, 10)
  await f.clock.tickAsync(800)
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
    [1400, 2000, 40000]
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
  test(`no mouth listener or parameter writes: ${name}`, async (t) => {
    const f = fixture(t)
    f.app.currentTalkLipSync = envelope
    const model = f.models.get(1)
    const run = f.run(talk(twentyChars, { facial: 'smile', motion: 'wave' }))
    await f.clock.tickAsync(0)
    assert.equal(model.internalModel.listenerCount('beforeModelUpdate'), 0)
    assert.equal(model.writes.length, 0, 'Do not lock an expression mouth even to zero')
    await f.clock.runAllAsync()
    await run
    assert.equal(model.writes.length, 0)
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
    assert.equal(model.writes.at(-1).value, 0, 'Real audio silence is sampled unchanged')
    await f.clock.tickAsync(3320)
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

test('voiced to silent dialogue, including a speaker change, never reattaches old mouth updates', async (t) => {
  const f = fixture(t)
  f.app.currentTalkLipSync = voicedEnvelope(f)
  let run = f.run(talk('あ'))
  await f.clock.runAllAsync()
  await run
  f.app.currentTalkLipSync = null
  const previousWrites = f.models.get(1).writes.length
  for (const modelId of [1, 2]) {
    run = f.run(talk('あ', { modelId, facial: 'smile' }))
    await f.clock.tickAsync(0)
    for (const model of f.models.values()) {
      assert.equal(model.internalModel.listenerCount('beforeModelUpdate'), 0)
      model.internalModel.emit('beforeModelUpdate')
    }
    await f.clock.runAllAsync()
    await run
  }
  assert.equal(f.models.get(1).writes.length, previousWrites)
  assert.equal(f.models.get(2).writes.length, 0)
  assert.equal(f.actions.length, 2)
})

for (const delay of [0, 1, 10]) {
  test(`BaseSnippet applies ${delay}s delay once, outside the 3460ms dialogue deadline`, async (t) => {
    const f = fixture(t)
    const snippet = talk(twentyChars, { delay })
    const timeline = f.load('utils/TimelineCalculator.ts').calculateTimelineWithoutTTS([snippet])
    assert.equal(timeline.entries[0].durationMs, 3460)
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
    await f.clock.tickAsync(3459)
    assert.equal(finished, false)
    await f.clock.tickAsync(1)
    assert.equal(finished, true)
    await run
    assert.equal(f.clock.now, delay * 1000 + 3460)
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
    assert.equal(f.clock.now, 12200)
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
  assert.deepEqual(f.starts, [0, 3460, 6920])
  assert.deepEqual(ends, [3460, 6920, 10380])
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

// Exercise both real export loops (not a regex/source inspection). Preparation,
// GPU capture, TTS network results and final encoding/IPC are isolated boundaries.
// Both loops still execute real snippets, timeline calculation, patching, envelope
// preparation, action scheduling and timestamp recording.
function exportFixture(
  t,
  { snippets, results = [], enabled = true, missingTimeline = false, decodeFails = false }
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
  class Empty {}
  class StreamRecorder {
    setOnErrorCallback = noop
    startRecordingToSink = noop
    stopRecordingToSink = async () => {}
    dispose = noop
  }
  class AudioMuxer {
    initialize = async () => {}
    addAudioTrack = noop
    mixAudioTracks = async () => ({})
    audioBufferToWav = async () => new ArrayBuffer(0)
    dispose = noop
  }
  class Pipeline {
    startTTSPipeline = noop
    markRenderStart = noop
    markRenderEnd = noop
    waitForTTSReady = async (index) => results[index]
    isTTSReady = () => true
    dispose = async () => {}
  }
  class ClockBoundary {
    install = noop
    uninstall = noop
    now = () => f.clock.now
    realTimeMs = () => f.clock.now
    realSleep = () => new Promise((resolve) => setImmediate(resolve))
    tick = (ms) => f.clock.tickAsync(ms)
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
    StreamRecorder,
    AudioMuxer,
    ConcurrentExportPipeline: Pipeline,
    SnippetTimestampRecorder
  })
  f.mocks.set('./video-export/VirtualClockController', { VirtualClockController: ClockBoundary })
  f.mocks.set('./video-export/JpegFrameSink', { JpegFrameSink: JpegSink })
  f.mocks.set('./video-export/WebCodecsMp4Encoder', {})
  f.mocks.set('../utils/WebGLContextValidator', {})
  f.mocks.set('../utils/FrameContentValidator', {
    frameValidator: { reset: noop, validateFrame: () => ({ isValid: true, isBlackScreen: false }) }
  })
  f.mocks.set('../utils/ResourceUrl', {})
  f.context.OfflineAudioContext = class {
    async decodeAudioData() {
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
    getBGMConfig: () => ({ enabled: false }),
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
  manager.prepareStreamRecording = async () => ({ canvas, snippets, captureFps: 10 })
  manager.resolveFastUseWebCodecs = async () => false
  manager.saveApiVideoFromDisk = async () => ({
    frameCount: 1,
    durationMs: f.clock.now,
    fileSize: 123
  })
  const options = { fps: 10, width: 1920, height: 1080, quality: 1, apiMode: true }
  return {
    ...f,
    manager,
    planned,
    patchCalls,
    async export(mode) {
      if (mode === 'record') {
        const run = manager.exportVideoStream(options, null, null, noop)
        await f.clock.runAllAsync()
        return run
      }
      return manager.exportVideoFast(options, null, null, noop)
    }
  }
}

for (const mode of ['record', 'fast']) {
  test(`${mode} entry uses the shared target helper/patch for success and failure`, async (t) => {
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
    assert.deepEqual(f.planned, [3460, 4600, 2200])
    assert.equal(f.patchCalls.length, 3, 'Both real entry paths must reuse talkPatch')
    assert.deepEqual(
      f.patchCalls.map((args) => [args[1], args[2], args[3]]),
      [
        [0, 2860, 3460],
        [1, 4000, 4600],
        [2, 0, 2200]
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
    assert.deepEqual(f.planned, [3460])
    assert.equal(f.models.get(1).writes.length, 0)
  })

  test(`${mode} decoding failure skips lip sync but retains real speech duration`, async (t) => {
    const f = exportFixture(t, {
      snippets: [talk()],
      results: [{ success: true, duration: 4000 }],
      decodeFails: true
    })
    assert.equal((await f.export(mode)).success, true)
    assert.deepEqual(f.planned, [4600])
    assert.equal(f.models.get(1).writes.length, 0)
    assert.equal(f.models.get(1).internalModel.listenerCount('beforeModelUpdate'), 0)
    assert.ok(f.warnings.some(([message]) => /skipping lip sync/i.test(message)))
    assert.ok(f.warnings.every(([message]) => !/text rhythm/i.test(message)))
  })
}
