import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { createRequire } from 'node:module'
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
      const transpiled = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true
        },
        fileName: resolved
      }).outputText
      compiled.set(
        resolved,
        new vm.Script(
          `(function (exports, require, module, __filename, __dirname) {\n${transpiled}\n})`,
          { filename: resolved }
        )
      )
    }

    const mod = { exports: {} }
    modules.set(resolved, mod.exports)
    const localRequire = (dep) => load(dep, path.dirname(resolved))
    compiled.get(resolved).runInContext(context)(
      mod.exports,
      localRequire,
      mod,
      resolved,
      path.dirname(resolved)
    )
    modules.set(resolved, mod.exports)
    return mod.exports
  }

  return { load, context, mocks }
}

const noop = () => {}

test('ConcurrentExportPipeline skips punctuation-only Talk cleanly with 0 failures and 0 warnings', async () => {
  const warnings = []
  const loggerFactory = () => ({
    info: noop,
    warn: (...args) => warnings.push(args),
    error: noop,
    debug: noop
  })

  const { load } = createRendererLoader(
    new Map([[path.join(rendererRoot, 'utils/Logger.ts'), { __esModule: true, default: loggerFactory }]])
  )
  const { ConcurrentExportPipeline } = load('managers/video-export/ConcurrentExportPipeline.ts')

  const synthInputs = []
  const translateCalls = []
  const ttsManager = {
    setCurrentTime: noop,
    synthesizeWithText: async (text) => {
      synthInputs.push(text)
      return { success: true, duration: 1500 }
    },
    translateAndSynthesize: async (content) => {
      translateCalls.push(content)
      return { success: false, duration: 0 }
    }
  }

  const pipeline = new ConcurrentExportPipeline({
    ttsLookahead: 3,
    ttsTimeoutMs: 5000,
    targetFps: 30,
    nowMs: () => Date.now(),
    waitMs: (ms) => new Promise((r) => setTimeout(r, ms))
  })

  const snippets = [
    {
      type: 'Talk',
      delay: 0,
      data: { speaker: '绘名', content: '…………', modelId: 1, voice: '', ttsText: '' }
    },
    {
      type: 'Talk',
      delay: 0,
      data: { speaker: '瑞希', content: '……なに？', modelId: 2, voice: '', ttsText: '……なに？' }
    }
  ]

  await pipeline.startTTSPipeline(snippets, ttsManager)
  const first = await pipeline.waitForTTSReady(0)
  const second = await pipeline.waitForTTSReady(1)
  await pipeline.waitForTTSPipeline()
  const metrics = pipeline.getMetrics()

  assert.deepEqual(synthInputs, ['……なに？'])
  assert.deepEqual(translateCalls, [])
  assert.equal(first.success, false)
  assert.equal(first.duration, 0)
  assert.equal(second.success, true)
  assert.equal(second.duration, 1500)
  assert.equal(metrics.ttsFailureCount, 0)
  assert.equal(metrics.ttsSuccessCount, 1)
  assert.equal(warnings.length, 0)
})

test('VideoExportManager pre-covers opening curtain when BlackOut opens story and mixes audio when only SE exists', async (t) => {
  const realSetTimeoutFn = setTimeout
  const loader = createRendererLoader(new Map(), {
    window: {
      electron: {
        ipcRenderer: {
          invoke: async (ch) => {
            if (ch === 'electron:frames-stream-start') return { id: 'pipe-1', videoPath: '/tmp/vid.mp4' }
            if (ch === 'electron:frames-stream-finish') return { videoPath: '/tmp/vid.mp4' }
            if (ch === 'electron:api-remux-video-from-files') return { success: true, fileSize: 999 }
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
          getChannelData: () => new Float32Array(4800).fill(0.2)
        }
      }
    }
  })

  let virtualClock = null
  t.after(() => virtualClock?.uninstall())

  const { mocks } = loader
  const events = []
  let seLoadCalls = 0
  let mixInt16Calls = 0

  const logger = { info: noop, warn: noop, error: noop, debug: noop }
  const { SnippetTimestampRecorder } = loader.load('managers/video-export/SnippetTimestampRecorder.ts')
  const { applyTalkPatch } = loader.load('managers/video-export/talkPatch.ts')

  mocks.set('pixi.js', {
    Text: class {},
    AlphaFilter: class {},
    TextStyle: class {},
    Ticker: { shared: { maxFPS: 60, stop: noop, start: noop } }
  })
  mocks.set('pixi-live2d-display-advanced', {
    Cubism4InternalModel: class extends EventEmitter {},
    Cubism2InternalModel: class extends EventEmitter {}
  })
  mocks.set(path.join(rendererRoot, 'utils/Logger.ts'), { __esModule: true, default: () => logger })
  mocks.set(path.join(rendererRoot, 'utils/WebGLContextValidator.ts'), {
    webGLValidator: {
      validateCanvas: async () => ({ success: true, errors: [], contextInfo: { renderer: 'TestGPU' } }),
      validateModelRendering: async () => ({ success: true, averageBrightness: 80 })
    }
  })
  mocks.set(path.join(rendererRoot, 'utils/FrameContentValidator.ts'), {
    frameValidator: { reset: noop, validateFrame: () => ({ isValid: true, isBlackScreen: false, brightness: 80 }) }
  })
  mocks.set(path.join(rendererRoot, 'utils/ResourceUrl.ts'), { resolveBgmUrl: (p) => p })
  mocks.set(path.join(rendererRoot, 'managers/AnimationManager.ts'), {
    __esModule: true,
    default: { setExportMode: noop, exportSpeedMultiplier: 1, exportTargetFPS: 30, exportEncodeFPS: 30 }
  })
  mocks.set(path.join(rendererRoot, 'snippets/stageTiming.ts'), {
    getLayoutRunningEndMs: () => 0,
    getMotionSettledEndMs: () => 0,
    resetStageTiming: noop
  })
  mocks.set('./video-export', {
    ExportLogger: class { info = noop; warn = noop; error = noop },
    CheckpointManager: class { clearCheckpoint = noop; hasCheckpoint = () => false },
    ErrorRecoveryManager: class { reset = noop },
    ProgressTracker: class { start = noop; update = noop },
    ExportError: class extends Error { constructor(c, m) { super(m); this.code = c } },
    ExportErrorCode: { CANCELLED: 'CANCELLED', TIMEOUT: 'TIMEOUT', UNKNOWN: 'UNKNOWN' },
    AudioMuxer: class {
      initialize = async () => {}
      setBGMConfig = noop
      setSeCues = noop
      setBgmCues = noop
      addAudioTrack = noop
      mixToInt16Interleaved = async () => {
        mixInt16Calls++
        return new Int16Array(960)
      }
      encodeWavFromInt16 = () => new ArrayBuffer(128)
      dispose = noop
    },
    ConcurrentExportPipeline: class {
      startTTSPipeline = noop
      isTTSReady = () => false
      getTTSResult = () => null
      waitForTTSReady = async () => null
      waitForTTSPipeline = async () => {}
      markRenderStart = noop
      markRenderEnd = noop
      dispose = async () => {}
    },
    SnippetTimestampRecorder,
    exportTraceContext: { setSnippet: noop, reset: noop },
    motionTrace: { reset: noop, snapshot: () => [] },
    exportLogBus: { reset: noop, snapshot: () => [] },
    buildExportDiagnostics: () => ({ summary: {} }),
    sanitizeDiagnostics: (d) => d
  })
  mocks.set('./video-export/VirtualClockController', {
    VirtualClockController: class {
      install() {
        virtualClock = FakeTimers.withGlobal(loader.context).install({
          now: 0,
          toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate']
        })
      }
      uninstall() {
        virtualClock?.uninstall()
        virtualClock = null
      }
      now = () => (virtualClock ? virtualClock.now : 0)
      realTimeMs = () => performance.now()
      realSleep = (ms) => new Promise((r) => realSetTimeoutFn(r, ms))
      tick = (ms) => virtualClock.tickAsync(ms)
    }
  })
  mocks.set('./video-export/BgmPlan', {
    BgmPlan: class { hasStoryFiles = false; hasLoadedFiles = false; hasChanges = false; load = async () => {} }
  })
  mocks.set('./video-export/SePlan', {
    SePlan: class {
      hasChanges = true
      load = async () => { seLoadCalls++ }
      build = () => []
    }
  })
  mocks.set('./video-export/WebCodecsMp4Encoder', {
    WebCodecsMp4Encoder: class {
      static async probeConfig() {
        return {
          config: { codec: 'avc1.640028', width: 1280, height: 720 },
          glRenderer: 'TestGPU',
          elapsedMs: 10
        }
      }
      async initialize() {
        throw new Error('use JpegFrameSink')
      }
      async encodeFrame() {}
      async finish() {
        return '/tmp/pipe/video.mp4'
      }
      dispose() {}
    }
  })
  mocks.set('./video-export/JpegFrameSink', {
    JpegFrameSink: class {
      get isPipeMode() { return true }
      get framesDirectory() { return '' }
      async initialize() {}
      async captureFrame() {}
      async finish() { return '/tmp/pipe/video.mp4' }
      async dispose() {}
    }
  })
  mocks.set('./video-export/talkPatch', { applyTalkPatch })

  const VideoExportManager = loader.load('managers/VideoExportManager.ts').default
  const canvas = {
    width: 1280,
    height: 720,
    getContext: () => ({ isContextLost: () => false, getExtension: () => null, getParameter: () => '' })
  }
  const app = {
    exporting: false,
    lastSnippetActualDurationMs: 0,
    currentTalkStartedAtMs: 0,
    currentTalkLipSync: null,
    storyManager: {
      snippets: [
        { type: 'BlackOut', delay: 0, wait: true, data: { color: 'black', duration: 0 } },
        { type: 'PlaySe', delay: 0, wait: true, data: { se: 'se_test', timing: 'before' } },
        { type: 'BlackOut', delay: 0, wait: true, data: { color: 'black', duration: 600 } }
      ],
      storyData: { models: [], images: [] }
    },
    pixiApplication: { view: canvas, ticker: { start: noop, stop: noop }, render: noop, renderer: { render: noop }, stage: {} },
    layerModel: { isModelVisible: () => true },
    layerSpecialEffect: {
      fadeOut: async (ms, color) => { events.push({ kind: 'sfxFadeOut', ms, color }) }
    },
    setOpeningCover: async (ms) => { events.push({ kind: 'setOpeningCover', ms }) },
    setEndingEnvelope: async (hold, fade) => { events.push({ kind: 'setEndingEnvelope', hold, fade }) },
    ttsManager: {
      isTTSEnabled: () => false,
      checkTTSAvailability: async () => true,
      getBGMConfig: () => ({ enabled: false }),
      getConfig: () => ({ timeoutMs: 90_000 }),
      buildTimelineWithoutTTS: () => [
        { snippetIndex: 0, snippetType: 'BlackOut', delayStartTimeMs: 0, startTimeMs: 0, durationMs: 0, endTimeMs: 0, ttsDurationMs: 0, hasTTS: false, blocking: true, durationSource: 'fixed' },
        { snippetIndex: 1, snippetType: 'PlaySe', delayStartTimeMs: 0, startTimeMs: 0, durationMs: 0, endTimeMs: 0, ttsDurationMs: 0, hasTTS: false, blocking: true, durationSource: 'fixed' },
        { snippetIndex: 2, snippetType: 'BlackOut', delayStartTimeMs: 0, startTimeMs: 0, durationMs: 600, endTimeMs: 600, ttsDurationMs: 0, hasTTS: false, blocking: true, durationSource: 'fixed' }
      ],
      setTimeline: noop,
      clearAudioTracks: noop
    },
    snippetStrategyManager: {
      resetBackgroundSnippets: noop,
      handleSnippetForExport: async (s) => {
        events.push({ kind: 'exec', type: s.type })
        if (s.type === 'BlackOut' && s.data?.duration) {
          await new Promise((r) => loader.context.setTimeout(r, s.data.duration))
        }
      }
    }
  }

  const mgr = new VideoExportManager(app)
  assert.equal(mgr.getOpeningCurtainColor([{ type: 'BlackOut', delay: 0, wait: true, data: { color: 'white', duration: 0 } }]), 'white')
  assert.equal(mgr.getOpeningCurtainColor([{ type: 'Talk', delay: 0, wait: true, data: {} }, { type: 'BlackOut', delay: 0, wait: true, data: {} }]), null)

  const res = await mgr.exportVideo({
    fps: 30,
    fastFps: 30,
    width: 1280,
    height: 720,
    quality: 'high',
    format: 'mp4',
    exportMode: 'fast',
    exportFastEncoder: 'auto',
    apiMode: true,
    apiOutputPath: '/tmp/wave5-out.mp4'
  })

  assert.equal(res.success, true)
  assert.equal(events.filter((e) => e.kind === 'setOpeningCover').length, 0, 'Must pre-cover opening curtain instead of setOpeningCover when BlackOut opens story')
  assert.deepEqual(events[0], { kind: 'sfxFadeOut', ms: 0, color: 'black' })
  assert.equal(seLoadCalls, 1, 'SePlan.load must run even when TTS & BGM are disabled')
  assert.equal(mixInt16Calls, 1, 'AudioMuxer.mixToInt16Interleaved must run when only sePlan has changes')
})
