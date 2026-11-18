import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'
import FakeTimers from '@sinonjs/fake-timers'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const root = process.cwd()
const rendererRoot = path.join(root, 'src/renderer/src')

function createRendererLoader(mocks = new Map(), extraGlobals = {}) {
  const modules = new Map()
  const compiled = new Map()
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    requestAnimationFrame: (cb) => setTimeout(() => cb(performance.now()), 16),
    cancelAnimationFrame: (id) => clearTimeout(id),
    AbortController,
    performance,
    navigator: { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    Uint8Array,
    Int16Array,
    Float32Array,
    ArrayBuffer,
    DataView,
    Buffer,
    Promise,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Error,
    Math,
    ...extraGlobals
  })
  vm.runInContext('this.Date = Date; this.Promise = Promise', context)

  function load(target, fromDir = rendererRoot) {
    for (const [key, value] of mocks.entries()) {
      if (target === key) return value
    }

    const baseCandidate = target.startsWith('.')
      ? path.resolve(fromDir, target)
      : path.isAbsolute(target)
        ? target
        : path.join(rendererRoot, target)

    for (const [key, value] of mocks.entries()) {
      if (key === baseCandidate || key === `${baseCandidate}.ts`) return value
    }

    const candidates = [baseCandidate, `${baseCandidate}.ts`, path.join(baseCandidate, 'index.ts')]
    const resolved = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile())
    if (!resolved) {
      return require(target)
    }
    if (modules.has(resolved)) return modules.get(resolved)

    if (!compiled.has(resolved)) {
      const source = fs.readFileSync(resolved, 'utf8')
      compiled.set(
        resolved,
        new vm.Script(
          `(function (exports, require, module) {\n${
            ts.transpileModule(source, {
              compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
              fileName: resolved
            }).outputText
          }\n})`,
          { filename: resolved }
        )
      )
    }

    const mod = { exports: {} }
    modules.set(resolved, mod.exports)
    const dir = path.dirname(resolved)
    const req = (spec) => {
      if (mocks.has(spec)) return mocks.get(spec)
      if (!spec.startsWith('.')) return require(spec)
      return load(spec, dir)
    }
    compiled.get(resolved).runInContext(context)(mod.exports, req, mod)
    return mod.exports
  }

  return { load, context, mocks }
}

/** 从指定 tempRepo 根加载 compiled `out-host/host/config.js`，使 `resolveRootDir()` 指向该临时仓库 */
function loadConfigFromTempRepo(tempRepo) {
  const compiledConfigPath = path.join(root, 'out-host/host/config.js')
  const code = fs.readFileSync(compiledConfigPath, 'utf8')
  const mod = { exports: {} }
  const fakeDirname = path.join(tempRepo, 'out-host', 'host')
  const fakeFilename = path.join(fakeDirname, 'config.js')
  const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', code)
  fn(mod.exports, require, mod, fakeFilename, fakeDirname)
  return mod.exports
}

// ============================================================================
// 1. host config defaults & record deprecation
// ============================================================================

test('config.ts defaults exportMode to fast & ttsMode to concurrent, and deprecates record mode', (t) => {
  const envKeys = ['MSS_EXPORT_MODE', 'MSS_TTS_MODE', 'MSS_RECORD_TARGET_SIZE_MB']
  const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]))
  const origWarn = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args.join(' '))

  t.after(() => {
    console.warn = origWarn
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  })

  const tempRepo = mkdtempSync(path.join(tmpdir(), 'mss-cfg-wave4-'))
  t.after(() => rmSync(tempRepo, { recursive: true, force: true }))
  writeFileSync(path.join(tempRepo, 'package.json'), '{"name":"test"}\n', 'utf8')
  for (const k of envKeys) delete process.env[k]

  const { loadHostConfig } = loadConfigFromTempRepo(tempRepo)

  const defaults = loadHostConfig()
  assert.equal(defaults.video.exportMode, 'fast')
  assert.equal(defaults.video.ttsMode, 'concurrent')
  assert.equal(warnings.length, 0)

  // Explicit record + recordTargetSizeMb logs deprecation warning & delegates to fast
  writeFileSync(
    path.join(tempRepo, 'config.yaml'),
    'video:\n  exportMode: record\n  recordTargetSizeMb: 42\n',
    'utf8'
  )
  const legacyCfg = loadHostConfig()
  assert.equal(legacyCfg.video.exportMode, 'fast')
  assert.ok(warnings.some((w) => w.includes('exportMode="record" is deprecated')))
  assert.ok(warnings.some((w) => w.includes('recordTargetSizeMb is deprecated')))

  // Env override MSS_EXPORT_MODE=record also delegates to fast
  warnings.length = 0
  writeFileSync(path.join(tempRepo, 'config.yaml'), 'video:\n  exportMode: fast\n', 'utf8')
  process.env.MSS_EXPORT_MODE = 'record'
  const envLegacyCfg = loadHostConfig()
  assert.equal(envLegacyCfg.video.exportMode, 'fast')
  assert.ok(warnings.some((w) => w.includes('exportMode="record" is deprecated')))
})

// ============================================================================
// 2. ConcurrentExportPipeline concurrency=3, emotion, onTtsReady, realTimeMs
// ============================================================================

test('ConcurrentExportPipeline defaults maxConcurrentTts to 3, forwards emotion, fires onTtsReady, and uses nowMs()', async () => {
  const fakePerfNow = 9_999_999
  let realClock = 1000
  const { ConcurrentExportPipeline } = createRendererLoader(new Map(), {
    performance: { now: () => fakePerfNow }
  }).load('managers/video-export/ConcurrentExportPipeline.ts')

  const snippets = [0, 1, 2, 3, 4].map((idx) => ({
    type: 'Talk',
    delay: 0.2,
    data: {
      speaker: `char-${idx}`,
      content: `line-${idx}`,
      ttsText: `tts-${idx}`,
      emotion: `emo-${idx}`
    }
  }))

  let inFlight = 0
  let peakInFlight = 0
  const seenEmotions = []
  const resolvers = new Map()
  const ttsManager = {
    setCurrentTime: () => {},
    synthesizeWithText: (_text, _speaker, snippetIndex, emotion) => {
      seenEmotions.push({ snippetIndex, emotion })
      inFlight++
      peakInFlight = Math.max(peakInFlight, inFlight)
      return new Promise((resolve) => {
        resolvers.set(snippetIndex, () => {
          inFlight--
          realClock += 25
          resolve({ success: true, duration: 1000 + snippetIndex * 100 })
        })
      })
    },
    translateAndSynthesize: async () => ({ success: false, duration: 0 })
  }

  const readyEvents = []
  const pipeline = new ConcurrentExportPipeline({
    ttsLookahead: 3,
    ttsTimeoutMs: 5000,
    targetFps: 30,
    nowMs: () => realClock,
    waitMs: (ms) => new Promise((r) => setTimeout(r, ms)),
    onTtsReady: (snippetIndex, res) => readyEvents.push({ snippetIndex, duration: res.duration })
  })

  pipeline.startTTSPipeline(snippets, ttsManager)
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(peakInFlight, 3, 'default maxConcurrentTts must run 3 syntheses concurrently')

  resolvers.get(2)()
  await new Promise((r) => setTimeout(r, 0))
  assert.ok(resolvers.has(3), 'slot frees up for snippet 3 immediately')
  resolvers.get(0)()
  resolvers.get(1)()
  await new Promise((r) => setTimeout(r, 0))
  assert.ok(resolvers.has(4))
  resolvers.get(3)()
  resolvers.get(4)()

  await pipeline.waitForTTSPipeline()
  pipeline.markRenderStart()
  realClock += 120
  pipeline.markRenderEnd()
  realClock += 10

  const metrics = pipeline.getMetrics()
  assert.equal(readyEvents.length, 5)
  assert.deepEqual(
    seenEmotions.sort((a, b) => a.snippetIndex - b.snippetIndex).map((e) => e.emotion),
    ['emo-0', 'emo-1', 'emo-2', 'emo-3', 'emo-4']
  )
  assert.ok(
    metrics.totalDurationMs > 0 && metrics.totalDurationMs < 500,
    'uses nowMs, not virtual performance.now'
  )
  assert.ok(metrics.ttsLatenciesMs.every((v) => v >= 0 && v < 500))
  assert.equal(metrics.renderPipelineDurationMs, 120)
})

test('ConcurrentExportPipeline waitForTTSReady resolves immediately upon abort()', async () => {
  const { ConcurrentExportPipeline } = createRendererLoader().load(
    'managers/video-export/ConcurrentExportPipeline.ts'
  )
  const pipeline = new ConcurrentExportPipeline({
    ttsTimeoutMs: 60_000,
    waitMs: () => new Promise(() => {})
  })
  const pendingTts = {
    setCurrentTime: () => {},
    synthesizeWithText: () => new Promise(() => {}),
    translateAndSynthesize: () => new Promise(() => {})
  }
  pipeline.startTTSPipeline(
    [{ type: 'Talk', delay: 0.2, data: { speaker: 'a', content: 'hi', ttsText: 'hi' } }],
    pendingTts
  )
  const waiter = pipeline.waitForTTSReady(0)
  pipeline.abort()
  const res = await waiter
  assert.equal(res?.success, false)
  assert.equal(res?.duration, 0)
})

// ============================================================================
// 3. VirtualClockController safe install / uninstall rollback
// ============================================================================

test('VirtualClockController restores context globals and Ticker.shared cleanly on throw and double uninstall', (t) => {
  const fakeTicker = {
    started: true,
    autoStart: true,
    count: 1,
    lastTime: 12345,
    _lastFrame: 12340,
    startCalls: 0,
    stopCalls: 0,
    throwOnCall: 0,
    start() {
      this.startCalls++
      if (this.throwOnCall > 0 && this.startCalls === this.throwOnCall) {
        throw new Error('ticker boom')
      }
      this.started = true
    },
    stop() {
      this.stopCalls++
      this.started = false
    }
  }

  let loader
  const scopedFakeTimers = {
    install(cfg) {
      return FakeTimers.withGlobal(loader.context).install(cfg)
    }
  }
  const mocks = new Map([
    ['pixi.js', { Ticker: { shared: fakeTicker } }],
    ['@sinonjs/fake-timers', scopedFakeTimers]
  ])
  loader = createRendererLoader(mocks, { performance })
  const origCtxSetTimeout = loader.context.setTimeout
  const { VirtualClockController } = loader.load('managers/video-export/VirtualClockController.ts')

  const vc = new VirtualClockController()
  t.after(() => vc.uninstall())

  vc.install()
  assert.notEqual(loader.context.setTimeout, origCtxSetTimeout)
  assert.equal(fakeTicker.lastTime, -1)
  vc.uninstall()
  assert.equal(loader.context.setTimeout, origCtxSetTimeout)
  assert.equal(fakeTicker.started, true)
  assert.equal(fakeTicker.lastTime, -1)
  vc.uninstall() // idempotent

  // Install rollback if Ticker.shared.start() throws
  fakeTicker.startCalls = 0
  fakeTicker.throwOnCall = 1
  fakeTicker.started = true
  assert.throws(() => vc.install(), /ticker boom/)
  assert.equal(
    loader.context.setTimeout,
    origCtxSetTimeout,
    'FakeTimers rolled back on install failure'
  )
  fakeTicker.throwOnCall = 0
})

// ============================================================================
// 4. WebCodecsMp4Encoder hardware probe, bt709 colorSpace, dequeue error wakeup
// ============================================================================

test('WebCodecsMp4Encoder rejects software GL, rejects >150ms slow probe, normalizes bt709 colorSpace, and wakes dequeue on error/dispose', async () => {
  let fakeSupport = { supported: true, config: { hardwareAcceleration: 'prefer-hardware' } }
  let fakeElapsedMs = 10
  let nowMock = 0

  class MockVideoFrame {
    close() {}
  }

  class MockVideoEncoder {
    static async isConfigSupported(cfg) {
      if (fakeSupport === 'reject-hw' && cfg.hardwareAcceleration === 'prefer-hardware') {
        return { supported: true, config: { hardwareAcceleration: 'prefer-software' } }
      }
      return fakeSupport
    }
    constructor(init) {
      this._init = init
      this.encodeQueueSize = 0
      this._listeners = new Map()
    }
    addEventListener(ev, fn) {
      if (!this._listeners.has(ev)) this._listeners.set(ev, new Set())
      this._listeners.get(ev).add(fn)
    }
    removeEventListener(ev, fn) {
      this._listeners.get(ev)?.delete(fn)
    }
    configure(cfg) {
      this._cfg = cfg
    }
    encode() {}
    async flush() {
      nowMock += fakeElapsedMs
      for (let i = 0; i < 5; i++) {
        this._init.output(
          { type: i === 0 ? 'key' : 'delta', byteLength: 4 },
          i === 0
            ? {
                decoderConfig: {
                  codec: 'avc1.640028',
                  description: new Uint8Array([1, 2, 3]),
                  colorSpace: {
                    primaries: null,
                    transfer: undefined,
                    matrix: 'rgb',
                    fullRange: undefined
                  }
                }
              }
            : undefined
        )
      }
    }
    close() {}
  }

  const addedMeta = []
  class MockMuxer {
    addVideoChunk(_chunk, meta) {
      addedMeta.push(meta)
    }
    finalize() {}
  }
  class MockStreamTarget {}

  const mocks = new Map([['mp4-muxer', { Muxer: MockMuxer, StreamTarget: MockStreamTarget }]])
  const { WebCodecsMp4Encoder, normalizeDecoderColorSpace } = createRendererLoader(mocks, {
    VideoEncoder: MockVideoEncoder,
    VideoFrame: MockVideoFrame,
    OffscreenCanvas: class {
      constructor(w, h) {
        this.width = w
        this.height = h
      }
      getContext() {
        return { fillRect: () => {}, drawImage: () => {} }
      }
    },
    performance: { now: () => nowMock },
    window: {
      electron: {
        ipcRenderer: {
          invoke: async () => ({ success: true })
        }
      }
    }
  }).load('managers/video-export/WebCodecsMp4Encoder.ts')

  // Rejects software GL (SwiftShader & llvmpipe) in auto mode
  assert.equal(
    await WebCodecsMp4Encoder.probeConfig({
      width: 1280,
      height: 720,
      fps: 30,
      bitrate: 8_000_000,
      mode: 'auto',
      glRenderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))',
      isLinux: false
    }),
    null
  )
  assert.equal(
    await WebCodecsMp4Encoder.probeConfig({
      width: 1280,
      height: 720,
      fps: 30,
      bitrate: 8_000_000,
      mode: 'auto',
      glRenderer: 'llvmpipe (LLVM 15.0.7, 256 bits)',
      isLinux: true
    }),
    null
  )

  // Rejects downgrade to software acceleration when hardware required
  fakeSupport = 'reject-hw'
  assert.equal(
    await WebCodecsMp4Encoder.probeConfig({
      width: 1280,
      height: 720,
      fps: 30,
      bitrate: 8_000_000,
      mode: 'auto',
      glRenderer: 'ANGLE (NVIDIA RTX)',
      isLinux: false
    }),
    null
  )

  // Rejects slow 5-frame benchmark (>150ms) in auto mode
  fakeSupport = { supported: true, config: { hardwareAcceleration: 'prefer-hardware' } }
  fakeElapsedMs = 220
  assert.equal(
    await WebCodecsMp4Encoder.probeConfig({
      width: 1280,
      height: 720,
      fps: 30,
      bitrate: 8_000_000,
      mode: 'auto',
      glRenderer: 'ANGLE (NVIDIA RTX)',
      isLinux: false
    }),
    null
  )

  // Fast probe passes and returns structured config
  fakeElapsedMs = 35
  const probe = await WebCodecsMp4Encoder.probeConfig({
    width: 1280,
    height: 720,
    fps: 30,
    bitrate: 8_000_000,
    mode: 'auto',
    glRenderer: 'ANGLE (NVIDIA RTX)',
    isLinux: false
  })
  assert.ok(probe && probe.config.hardwareAcceleration === 'prefer-hardware')
  assert.equal(probe.elapsedMs, 35)

  // ColorSpace normalization helper & live output chunk normalization
  const norm = normalizeDecoderColorSpace({ matrix: 'rgb' })
  assert.equal(norm.primaries, 'bt709')
  assert.equal(norm.transfer, 'bt709')
  assert.equal(norm.matrix, 'bt709')
  assert.equal(norm.fullRange, false)

  const enc = new WebCodecsMp4Encoder({
    width: 1280,
    height: 720,
    fps: 30,
    bitrate: 8_000_000,
    encoderConfig: probe.config
  })
  await enc.initialize('temp-probe.mp4')
  await enc.finish()
  const cs = addedMeta[0]?.decoderConfig?.colorSpace
  assert.equal(cs?.primaries, 'bt709')
  assert.equal(cs?.transfer, 'bt709')
  assert.equal(cs?.matrix, 'bt709')
  assert.equal(cs?.fullRange, false)

  // Backpressure dequeue waiter wakes immediately on dispose without hanging
  const enc2 = new WebCodecsMp4Encoder({
    width: 1280,
    height: 720,
    fps: 30,
    bitrate: 8_000_000,
    encoderConfig: probe.config
  })
  await enc2.initialize('temp-backpressure.mp4')
  enc2.encoder.encodeQueueSize = 12
  const blockedEncode = enc2.encodeFrame({ width: 1280, height: 720 }, 0, 33333, true)
  enc2.dispose()
  await assert.rejects(blockedEncode, /Encoder disposed/)
})

// ============================================================================
// 5. AudioMuxer OfflineAudioContext zero-sleep decode, sampleRate check & BgmPlan parallel load
// ============================================================================

test('AudioMuxer decodes concurrently without 50/100ms sleeps, checks pcmData.sampleRate, and deduplicates decodes', async () => {
  const decodeCalls = []
  const sleepCalls = []
  const fakeAudioBuffer = (sr = 48000, len = 480) => ({
    sampleRate: sr,
    numberOfChannels: 1,
    length: len,
    duration: len / sr,
    getChannelData: () => new Float32Array(len).fill(0.25)
  })

  let audioCtxCreated = 0
  const { AudioMuxer } = createRendererLoader(new Map(), {
    OfflineAudioContext: class {
      async decodeAudioData(buf) {
        decodeCalls.push(buf.byteLength)
        return fakeAudioBuffer(48000, 480)
      }
    },
    AudioContext: class {
      constructor() {
        audioCtxCreated++
        this.state = 'suspended'
      }
      async resume() {
        this.state = 'running'
      }
      async decodeAudioData(buf) {
        decodeCalls.push(buf.byteLength)
        return fakeAudioBuffer(48000, 480)
      }
      async close() {}
    },
    setTimeout: (fn, ms, ...args) => {
      sleepCalls.push(ms)
      return setTimeout(fn, 0, ...args)
    }
  }).load('managers/video-export/AudioMuxer.ts')

  const muxer = new AudioMuxer()
  const sharedBuf = new ArrayBuffer(64)
  muxer.addAudioTrack({
    audioBuffer: new ArrayBuffer(32),
    pcmData: {
      channel0: new Float32Array(480).fill(0.1),
      channel1: new Float32Array(480).fill(0.1),
      sampleRate: 48000
    },
    startTime: 0,
    endTime: 100,
    characterName: 'c0',
    text: 'a',
    snippetIndex: 0
  })
  muxer.addAudioTrack({
    audioBuffer: new ArrayBuffer(48),
    pcmData: {
      channel0: new Float32Array(240).fill(0.1),
      channel1: new Float32Array(240).fill(0.1),
      sampleRate: 24000
    },
    startTime: 100,
    endTime: 200,
    characterName: 'c1',
    text: 'b',
    snippetIndex: 1
  })
  muxer.addAudioTrack({
    audioBuffer: sharedBuf,
    startTime: 200,
    endTime: 300,
    characterName: 'c2',
    text: 'c',
    snippetIndex: 2
  })
  muxer.addAudioTrack({
    audioBuffer: sharedBuf,
    startTime: 200,
    endTime: 300,
    characterName: 'c2',
    text: 'c',
    snippetIndex: 2
  })

  const pcm = await muxer.mixToInt16Interleaved(500)
  assert.ok(pcm instanceof Int16Array && pcm.length > 0)
  assert.equal(audioCtxCreated, 0)
  assert.deepEqual(sleepCalls, [])
  assert.deepEqual(
    decodeCalls.sort((a, b) => a - b),
    [48, 64]
  )
})

test('BgmPlan.load fetches distinct story BGM files concurrently', async () => {
  let active = 0
  let peak = 0
  const release = []
  const { BgmPlan } = createRendererLoader(
    new Map([['../utils/ResourceUrl', { resolveBgmUrl: (p) => p }]]),
    {
      fetch: async () => ({ ok: false })
    }
  ).load('managers/video-export/BgmPlan.ts')

  const plan = new BgmPlan([
    { type: 'ChangeBgm', delay: 0, data: { file: 'bgm1.mp3', volume: 0.5 } },
    { type: 'ChangeBgm', delay: 1, data: { file: 'bgm2.mp3', volume: 0.5 } },
    { type: 'ChangeBgm', delay: 2, data: { file: 'bgm3.mp3', volume: 0.5 } }
  ])
  const muxer = {
    loadBGMBuffer: () =>
      new Promise((resolve) => {
        active++
        peak = Math.max(peak, active)
        release.push(() => {
          active--
          resolve({
            duration: 10,
            numberOfChannels: 2,
            sampleRate: 48000,
            getChannelData: () => new Float32Array(480)
          })
        })
      })
  }
  const run = plan.load(muxer)
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(peak, 3, 'loads up to 4 story BGMs concurrently')
  while (release.length) release.shift()()
  await run
  assert.equal(plan.hasLoadedFiles, true)
})

// ============================================================================
// 6. VideoExportManager end-to-end Wave 4 behaviors
// ============================================================================

test('VideoExportManager: warm worker skips validateModelRendering, overlapping prewarm zero double-pause, pcmCache -> mixToInt16, and WebCodecs fallback', async (t) => {
  let validateCanvasCalls = 0
  let validateModelCalls = 0
  let glContextLost = false
  let mixInt16Calls = 0
  const addedAudioTracks = []
  let pumpSleepPolls = 0
  let encoderInitThrows = true
  let jpegPipeStarted = 0

  const realSetTimeoutFn = setTimeout
  const mocks = new Map()
  let virtualClock = null

  const loader = createRendererLoader(mocks, {
    window: {
      electron: {
        ipcRenderer: {
          invoke: async (ch) => {
            if (ch === 'electron:get-temp-base-dir') return '/tmp/base'
            if (ch === 'electron:frames-stream-start') {
              jpegPipeStarted++
              return { id: 'pipe-1', videoPath: '/tmp/pipe/video.mp4' }
            }
            if (ch === 'electron:frames-stream-chunk') return { success: true }
            if (ch === 'electron:frames-stream-finish') return { videoPath: '/tmp/pipe/video.mp4' }
            if (ch === 'electron:api-remux-video-from-files')
              return { success: true, fileSize: 999 }
            if (ch === 'electron:write-temp-file') return '/tmp/audio.wav'
            return { success: true }
          }
        }
      }
    },
    OfflineAudioContext: class {
      async decodeAudioData() {
        return {
          numberOfChannels: 2,
          sampleRate: 48000,
          getChannelData: () => new Float32Array(4800).fill(0.3)
        }
      }
    }
  })

  t.after(() => {
    virtualClock?.uninstall()
  })

  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  const { SnippetTimestampRecorder } = loader.load(
    'managers/video-export/SnippetTimestampRecorder.ts'
  )
  const { applyTalkPatch } = loader.load('managers/video-export/talkPatch.ts')

  const tickerShared = { maxFPS: 60, stop: () => {}, start: () => {} }
  mocks.set('pixi.js', {
    Text: class {},
    AlphaFilter: class {},
    TextStyle: class {},
    Ticker: { shared: tickerShared }
  })
  mocks.set('pixi-live2d-display-advanced', {
    Cubism4InternalModel: class extends EventEmitter {},
    Cubism2InternalModel: class extends EventEmitter {}
  })
  mocks.set(path.join(rendererRoot, 'utils/Logger.ts'), { default: () => logger })
  mocks.set(path.join(rendererRoot, 'utils/WebGLContextValidator.ts'), {
    webGLValidator: {
      validateCanvas: async () => {
        validateCanvasCalls++
        return { success: true, errors: [], contextInfo: { renderer: 'TestGPU' } }
      },
      validateModelRendering: async () => {
        validateModelCalls++
        return { success: true, averageBrightness: 80 }
      }
    }
  })
  mocks.set(path.join(rendererRoot, 'utils/FrameContentValidator.ts'), {
    frameValidator: {
      reset: () => {},
      validateFrame: () => ({ isValid: true, isBlackScreen: false, brightness: 80 })
    }
  })
  mocks.set(path.join(rendererRoot, 'utils/ResourceUrl.ts'), { resolveBgmUrl: (p) => p })
  mocks.set(path.join(rendererRoot, 'managers/AnimationManager.ts'), {
    default: { setExportMode: () => {}, exportSpeedMultiplier: 1, exportTargetFPS: 30 }
  })
  mocks.set(path.join(rendererRoot, 'snippets/stageTiming.ts'), {
    getLayoutRunningEndMs: () => 0,
    getMotionSettledEndMs: () => 0,
    resetStageTiming: () => {}
  })
  mocks.set('./video-export', {
    ExportLogger: class {
      info = () => {}
      warn = () => {}
      error = () => {}
    },
    CheckpointManager: class {
      clearCheckpoint = () => {}
      hasCheckpoint = () => false
    },
    ErrorRecoveryManager: class {
      reset = () => {}
    },
    ProgressTracker: class {
      start = () => {}
      update = () => {}
    },
    ExportError: class extends Error {
      constructor(c, m) {
        super(m)
        this.code = c
      }
    },
    ExportErrorCode: { CANCELLED: 'CANCELLED', TIMEOUT: 'TIMEOUT', UNKNOWN: 'UNKNOWN' },
    AudioMuxer: class {
      initialize = async () => {}
      setBGMConfig = () => {}
      addAudioTrack = (tr) => addedAudioTracks.push(tr)
      mixToInt16Interleaved = async () => {
        mixInt16Calls++
        return new Int16Array(960)
      }
      encodeWavFromInt16 = () => new ArrayBuffer(128)
      dispose = () => {}
    },
    ConcurrentExportPipeline: class {
      constructor(cfg) {
        this.cfg = cfg
      }
      startTTSPipeline(snippets) {
        for (let i = 0; i < snippets.length; i++) {
          if (snippets[i].type === 'Talk') {
            this.cfg.onTtsReady?.(i, { success: true, duration: 900 })
          }
        }
      }
      isTTSReady = () => true
      getTTSResult = () => ({ success: true, duration: 900 })
      waitForTTSReady = async () => ({ success: true, duration: 900 })
      waitForTTSPipeline = async () => {}
      markRenderStart = () => {}
      markRenderEnd = () => {}
      dispose = async () => {}
    },
    SnippetTimestampRecorder,
    exportTraceContext: { setSnippet: () => {}, reset: () => {} },
    motionTrace: { reset: () => {}, snapshot: () => [] },
    exportLogBus: { reset: () => {}, snapshot: () => [] },
    buildExportDiagnostics: () => ({ summary: {} }),
    sanitizeDiagnostics: (d) => d
  })
  mocks.set('./video-export/VirtualClockController', {
    VirtualClockController: class {
      install() {
        virtualClock = FakeTimers.withGlobal(loader.context).install({
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
      }
      uninstall() {
        if (virtualClock) {
          virtualClock.uninstall()
          virtualClock = null
        }
      }
      now = () => (virtualClock ? virtualClock.now : 0)
      realTimeMs = () => performance.now()
      realSleep = (ms) => {
        pumpSleepPolls++
        return new Promise((r) => realSetTimeoutFn(r, ms))
      }
      tick = (ms) => virtualClock.tickAsync(ms)
    }
  })
  mocks.set('./video-export/BgmPlan', {
    BgmPlan: class {
      hasStoryFiles = false
      hasLoadedFiles = false
      hasChanges = false
      load = async () => {}
    }
  })
  mocks.set('./video-export/SePlan', {
    SePlan: class {
      hasChanges = false
      load = async () => {}
    }
  })
  mocks.set('./video-export/WebCodecsMp4Encoder', {
    WebCodecsMp4Encoder: class {
      static async probeConfig() {
        return {
          config: { codec: 'avc1.640028', width: 1280, height: 720 },
          glRenderer: 'TestGPU',
          elapsedMs: 12
        }
      }
      async initialize() {
        if (encoderInitThrows) throw new Error('runtime configure boom')
      }
      async encodeFrame() {}
      async finish() {
        return '/tmp/base/vid.mp4'
      }
      dispose() {}
    }
  })
  mocks.set('./video-export/JpegFrameSink', {
    JpegFrameSink: class {
      get isPipeMode() {
        return true
      }
      get framesDirectory() {
        return ''
      }
      async initialize() {
        jpegPipeStarted++
      }
      async captureFrame() {}
      async finish() {
        return '/tmp/pipe/video.mp4'
      }
      async dispose() {}
    }
  })
  mocks.set('./video-export/talkPatch', { applyTalkPatch })

  const VideoExportManager = loader.load('managers/VideoExportManager.ts').default

  const canvas = {
    width: 1280,
    height: 720,
    getContext: () => ({
      isContextLost: () => glContextLost,
      getExtension: () => null,
      getParameter: () => ''
    })
  }
  const app = {
    exporting: false,
    lastSnippetActualDurationMs: 0,
    currentTalkStartedAtMs: 0,
    currentTalkLipSync: null,
    storyManager: {
      snippets: [
        {
          type: 'Talk',
          delay: 0,
          data: {
            speaker: 'miku',
            content: 'こんにちは',
            ttsText: 'こんにちは',
            modelId: 1
          }
        }
      ],
      storyData: { models: [], images: [] }
    },
    pixiApplication: {
      view: canvas,
      ticker: { start: () => {}, stop: () => {} },
      render: () => {},
      renderer: { render: () => {} },
      stage: {}
    },
    layerModel: { isModelVisible: () => true },
    ttsManager: {
      isTTSEnabled: () => true,
      checkTTSAvailability: async () => true,
      getBGMConfig: () => ({ enabled: false }),
      getConfig: () => ({ timeoutMs: 90_000 }),
      buildTimelineWithoutTTS: () => [
        {
          snippetIndex: 0,
          snippetType: 'Talk',
          delayStartTimeMs: 0,
          startTimeMs: 0,
          durationMs: 1200,
          endTimeMs: 1200,
          ttsDurationMs: 0,
          hasTTS: false,
          blocking: true,
          durationSource: 'text'
        }
      ],
      setTimeline: () => {},
      getAudioBufferForSnippet: () => new ArrayBuffer(64),
      clearAudioTracks: () => {}
    },
    snippetStrategyManager: {
      resetBackgroundSnippets: () => {},
      handleSnippetForExport: async () => {
        await new Promise((r) => loader.context.setTimeout(r, 1200))
      }
    }
  }

  const mgr1 = new VideoExportManager(app)
  const res1 = await mgr1.exportVideo({
    fps: 30,
    fastFps: 30,
    width: 1280,
    height: 720,
    quality: 'high',
    format: 'mp4',
    exportMode: 'record',
    exportFastEncoder: 'auto',
    apiMode: true,
    apiOutputPath: '/tmp/out1.mp4'
  })
  assert.equal(res1.success, true)
  assert.equal(validateCanvasCalls, 1)
  assert.equal(validateModelCalls, 1)
  assert.equal(jpegPipeStarted, 1, 'WebCodecs init throw falls back cleanly to JpegFrameSink')
  assert.equal(pumpSleepPolls, 0, 'pre-decoded onTtsReady avoids framePump pause & poll')
  assert.equal(mixInt16Calls, 1, 'uses mixToInt16Interleaved + encodeWavFromInt16')
  assert.equal(addedAudioTracks[0]?.pcmData?.sampleRate, 48000, 'reuses decoded 48kHz PCM')
  assert.equal(tickerShared.maxFPS, 60, 'restores Ticker.shared.maxFPS after fast export')

  // Export 2 on same warm app instance: skips redundant validateCanvas & validateModelRendering!
  encoderInitThrows = false
  const mgr2 = new VideoExportManager(app)
  const res2 = await mgr2.exportVideo({
    fps: 30,
    fastFps: 30,
    width: 1280,
    height: 720,
    quality: 'high',
    format: 'mp4',
    exportMode: 'fast',
    exportFastEncoder: 'auto',
    apiMode: true,
    apiOutputPath: '/tmp/out2.mp4'
  })
  assert.equal(res2.success, true)
  assert.equal(validateCanvasCalls, 1, 'warm page skips validateCanvas')
  assert.equal(validateModelCalls, 1, 'warm page skips readPixels validateModelRendering')

  // If WebGL context reports lost on warm page, validation runs again
  glContextLost = true
  const mgr3 = new VideoExportManager(app)
  await mgr3.exportVideo({
    fps: 30,
    fastFps: 30,
    width: 1280,
    height: 720,
    quality: 'high',
    format: 'mp4',
    exportMode: 'fast',
    exportFastEncoder: 'auto',
    apiMode: true,
    apiOutputPath: '/tmp/out3.mp4'
  })
  assert.equal(validateCanvasCalls, 2)
  assert.equal(validateModelCalls, 2)
})
