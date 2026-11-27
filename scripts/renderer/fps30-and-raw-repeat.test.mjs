/**
 * Regression tests for:
 * 1. AdvancedModel 30fps vs 60fps Live2D blend & natural motion (blink/breath) 1.0x speed parity;
 * 2. JpegFrameSink rawvideo batch buffer reuse + coalesced repeatLastFrame + bridgeRoutes repeat;
 * 3. Moesekai async writeFileFastAsync & bounded-parallel deterministic model3.json generation.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { Logger } from 'tslog'
import ts from 'typescript'

const nodeRequire = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const rendererRoot = path.join(root, 'src/renderer/src')

function createRendererLoader(extraMocks = new Map(), globals = {}) {
  let nowMs = 1000
  let exporting = true
  const context = vm.createContext({
    console,
    Uint8Array,
    Float32Array,
    Int32Array,
    Uint16Array,
    ArrayBuffer,
    DataView,
    performance: { now: () => nowMs },
    Date,
    Math,
    setTimeout,
    clearTimeout,
    AbortController,
    AbortSignal,
    ...globals
  })

  class MockLogger {
    info() {}
    warn() {}
    error() {}
    debug() {}
    getSubLogger() {
      return this
    }
  }
  class AlphaFilter {
    constructor(alpha = 0) {
      this.alpha = alpha
    }
  }
  class Filter {
    destroy() {}
  }
  class Live2DModel {
    constructor() {
      this.parent = {}
      this.destroyed = false
      this.visible = true
      this.deltaTime = 0
      this.elapsedTime = 0
      this.filters = [new AlphaFilter(0)]
      this.anchor = { x: 0, y: 0 }
      this.position = { x: 0, y: 0 }
      this.scale = { x: 1, y: 1, set(v) { this.x = v; this.y = v } }
    }
    update(dt) {
      this.deltaTime += dt
      this.elapsedTime += dt
    }
    destroy() {
      this.destroyed = true
    }
  }
  class Cubism2InternalModel extends EventEmitter {}
  class Cubism4InternalModel extends EventEmitter {}
  class VisualEffectManager {
    createAll() {}
    destroy() {}
  }

  const animation = {
    linear: async (cb) => { cb(1) },
    delay: async () => {},
    in_ticker: async () => {},
    isExporting: () => exporting,
    exportEncodeFPS: 30
  }

  const mocks = new Map([
    [
      'pixi-live2d-display-advanced',
      { Live2DModel, Cubism2InternalModel, Cubism4InternalModel, MotionPriority: { FORCE: 3 } }
    ],
    ['pixi.js', { AlphaFilter, Filter, Ticker: { shared: { add() {}, remove() {} } } }],
    ['tslog', { Logger: MockLogger }],
    [path.join(rendererRoot, 'utils/Logger.ts'), { default: () => new MockLogger() }],
    [path.join(rendererRoot, 'managers/AnimationManager.ts'), { default: animation }],
    [path.join(rendererRoot, 'managers/VisualEffectManager.ts'), { VisualEffectManager }],
    ...extraMocks
  ])

  const modules = new Map()
  const compiled = new Map()
  function load(target) {
    const filename = path.isAbsolute(target) ? target : path.join(rendererRoot, target)
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
      if (!name.startsWith('.')) return nodeRequire(name)
      const base = path.resolve(path.dirname(filename), name)
      for (const candidate of [`${base}.ts`, path.join(base, 'index.ts'), base]) {
        if (mocks.has(candidate)) return mocks.get(candidate)
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return load(candidate)
      }
      throw new Error(`Cannot resolve ${name} from ${filename}`)
    }
    compiled.get(filename).runInContext(context)(exports, require)
    return exports
  }

  return {
    load,
    Cubism4InternalModel,
    setNow: (v) => { nowMs = v },
    setExporting: (v) => { exporting = v }
  }
}

// ============================================================================
// 1. AdvancedModel 30fps vs 60fps blend & natural motion parity
// ============================================================================

test('AdvancedModel tryUpdatePlayableBlend advances at 1.0x speed under both 30fps and 60fps export', () => {
  const runCrossfadeAtFps = (fps) => {
    const loader = createRendererLoader()
    const AdvancedModel = loader.load('model/AdvancedModel.ts').default
    const model = new AdvancedModel()

    const paramIds = ['ParamAngleX', 'ParamArmL1']
    const defaults = [0, 0]
    const values = [0, 0]
    const core = {
      getParameterCount: () => paramIds.length,
      getParameterIndex: (id) => paramIds.indexOf(id),
      getParameterDefaultValue: (idx) => defaults[idx],
      getParameterValueByIndex: (idx) => values[idx],
      setParameterValueByIndex: (idx, val) => { values[idx] = val }
    }

    const makeEntry = (curveMap) => {
      let started = false
      let startTime = 0
      let endTime = -1
      const motion = {
        _fadeInSeconds: 0.5,
        _fadeOutSeconds: 0.5,
        _motionData: { duration: 2.0, loop: false },
        getDuration: () => 2.0,
        setFadeInTime(s) { this._fadeInSeconds = s },
        setFadeOutTime(s) { this._fadeOutSeconds = s },
        doUpdateParameters(target, _t, weight) {
          for (const [id, val] of Object.entries(curveMap)) {
            target.setParameterValueByIndex(target.getParameterIndex(id), val, weight)
          }
        },
        getFiredEvent: () => []
      }
      return {
        _motion: motion,
        isStarted: () => started,
        setIsStarted: (v) => { started = v },
        isFinished: () => false,
        isTriggeredFadeOut: () => false,
        getStartTime: () => startTime,
        setStartTime: (t) => { startTime = t },
        setFadeInStartTime() {},
        getEndTime: () => endTime,
        setEndTime: (t) => { endTime = t },
        getLastCheckEventSeconds: () => 0,
        setLastCheckEventSeconds() {},
        setState() {},
        setFadeOut() {},
        release() {}
      }
    }

    const queue = {
      _motions: [],
      startMotion(motion) {
        this._motions.push(motion._entry)
        return this._motions.length
      },
      stopAllMotions() { this._motions = [] },
      doUpdateMotion: () => true
    }
    const manager = {
      queueManager: queue,
      _startMotion() {},
      isFinished: () => queue._motions.length === 0
    }
    model.internalModel = { parallelMotionManager: [manager, manager] }
    model.installHoldLastFrameHook(0)
    model.installCrossfade(0)

    const entryA = makeEntry({ ParamAngleX: 10, ParamArmL1: 0 })
    entryA._motion._entry = entryA
    model.channelFadeSeconds[0] = 0
    manager._startMotion(entryA._motion)
    queue.doUpdateMotion(core, 1.0)
    assert.equal(values[0], 10)

    // Crossfade to entryB over 0.5s
    const entryB = makeEntry({ ParamAngleX: 30, ParamArmL1: 20 })
    entryB._motion._entry = entryB
    model.channelFadeSeconds[0] = 0.5
    manager._startMotion(entryB._motion)

    const framesForHalf = Math.round(0.25 * fps)
    const framesForFull = Math.round(0.5 * fps)
    // Exact 0.25s midpoint (only exact at even fps like 60; at 30fps 0.25s = 7.5 frames -> check at 0.2s & 0.5s)
    const framesAt02s = Math.round(0.2 * fps)
    let angleAt02s = 0
    for (let i = 1; i <= framesForFull; i++) {
      const t = 1.0 + i / fps
      queue.doUpdateMotion(core, t)
      if (i === framesAt02s) angleAt02s = values[0]
    }
    return {
      framesForHalf,
      angleAt02s,
      finalAngle: values[0],
      finalArm: values[1],
      remainingEntries: queue._motions.length
    }
  }

  const res60 = runCrossfadeAtFps(60)
  const res30 = runCrossfadeAtFps(30)

  // At t=0.2s (40% of 0.5s): 10 + 0.4 * (30 - 10) = 18.0 at BOTH 30fps and 60fps!
  assert.ok(Math.abs(res60.angleAt02s - 18) < 1e-5, `60fps @0.2s expected 18, got ${res60.angleAt02s}`)
  assert.ok(Math.abs(res30.angleAt02s - 18) < 1e-5, `30fps @0.2s expected 18, got ${res30.angleAt02s}`)
  // At t=0.5s: blend completes and prunes outgoing entry at BOTH 30fps (15 frames) and 60fps (30 frames)!
  assert.ok(Math.abs(res60.finalAngle - 30) < 1e-5)
  assert.ok(Math.abs(res30.finalAngle - 30) < 1e-5)
  assert.ok(Math.abs(res30.finalArm - 20) < 1e-5)
  assert.equal(res60.remainingEntries, 1)
  assert.equal(res30.remainingEntries, 1, '30fps 0.5s blend must complete in 15 frames and prune old entry')
})

test('AdvancedModel tryUpdatePlayableBlend handles backwards clock reset cleanly during export', () => {
  const loader = createRendererLoader()
  const AdvancedModel = loader.load('model/AdvancedModel.ts').default
  const model = new AdvancedModel()

  const values = [0]
  const core = {
    getParameterCount: () => 1,
    getParameterIndex: (id) => (id === 'ParamAngleX' ? 0 : -1),
    getParameterDefaultValue: () => 0,
    getParameterValueByIndex: () => values[0],
    setParameterValueByIndex: (_idx, val) => { values[0] = val }
  }
  const makeEntry = (val) => {
    let started = false
    const motion = {
      _fadeInSeconds: 0.5,
      _fadeOutSeconds: 0.5,
      _motionData: { duration: 2.0, loop: false },
      getDuration: () => 2.0,
      setFadeInTime() {},
      setFadeOutTime() {},
      doUpdateParameters(target, _t, weight) {
        target.setParameterValueByIndex(0, val, weight)
      },
      getFiredEvent: () => []
    }
    return {
      _motion: motion,
      isStarted: () => started,
      setIsStarted: (v) => { started = v },
      isFinished: () => false,
      isTriggeredFadeOut: () => false,
      getStartTime: () => 0,
      setStartTime() {},
      setFadeInStartTime() {},
      getEndTime: () => -1,
      setEndTime() {},
      getLastCheckEventSeconds: () => 0,
      setLastCheckEventSeconds() {},
      setState() {},
      setFadeOut() {},
      release() {}
    }
  }
  const queue = {
    _motions: [],
    startMotion(m) { this._motions.push(m._entry); return this._motions.length },
    stopAllMotions() { this._motions = [] },
    doUpdateMotion: () => true
  }
  const manager = { queueManager: queue, _startMotion() {}, isFinished: () => false }
  model.internalModel = { parallelMotionManager: [manager, manager] }
  model.installHoldLastFrameHook(0)
  model.installCrossfade(0)

  const a = makeEntry(0)
  a._motion._entry = a
  const b = makeEntry(10)
  b._motion._entry = b
  model.channelFadeSeconds[0] = 0
  manager._startMotion(a._motion)
  queue.doUpdateMotion(core, 5.0)
  model.channelFadeSeconds[0] = 0.5
  manager._startMotion(b._motion)

  // Backwards clock jump: 5.0 -> 0.1 must yield dt=0 (not negative/NaN), then resume normally
  queue.doUpdateMotion(core, 0.1)
  assert.equal(values[0], 0, 'backwards jump must not advance with negative dt')
  queue.doUpdateMotion(core, 0.35) // +0.25s = midpoint
  assert.ok(Math.abs(values[0] - 5) < 1e-5, `expected midpoint 5 after resume, got ${values[0]}`)
})

test('AdvancedModel beforeModelUpdate natural blink and breath run at exact 1.0x speed at 30fps and 60fps', () => {
  const simulateNaturalAtFps = (fps) => {
    const loader = createRendererLoader()
    const AdvancedModel = loader.load('model/AdvancedModel.ts').default
    const natural = loader.load('model/NaturalMotion.ts')

    const model = new AdvancedModel()
    const internal = new loader.Cubism4InternalModel()
    const params = new Map([
      ['ParamEyeLOpen', 1],
      ['ParamEyeROpen', 1],
      ['ParamBreath', 0]
    ])
    internal.coreModel = {
      _parameterIds: ['ParamEyeLOpen', 'ParamEyeROpen', 'ParamBreath'],
      getParameterCount: () => 3,
      getParameterIndex: (id) => ['ParamEyeLOpen', 'ParamEyeROpen', 'ParamBreath'].indexOf(id),
      getParameterDefaultValue: () => 1,
      getParameterValueById: (id) => params.get(id) ?? 1,
      setParameterValueById: (id, val) => { params.set(id, val) },
      getDrawableCount: () => 0,
      getMultiplyColor: () => ({ R: 1, G: 1, B: 1, A: 1 }),
      getScreenColor: () => ({ R: 0, G: 0, B: 0, A: 0 })
    }
    const fakeQueue = {
      _motions: [],
      setEventCallback() {},
      stopAllMotions() {},
      doUpdateMotion: () => true
    }
    internal.motionManager = { motionGroups: {}, definitions: {}, queueManager: fakeQueue }
    internal.parallelMotionManager = []
    internal.extendParallelMotionManager = () => {
      internal.parallelMotionManager = [
        { queueManager: fakeQueue, _startMotion() {}, stopAllMotions() {}, isFinished: () => true },
        { queueManager: fakeQueue, _startMotion() {}, stopAllMotions() {}, isFinished: () => true }
      ]
    }
    model.internalModel = internal
    model.initialize({ id: 21, model: 'test.model3.json', normal_scale: 2, small_scale: 1.8, anchor: 0.5 })
    model.parent = {}
    model.visible = true
    model.resetClockBaselines(0)

    const startBreath = model.breathDegree
    // Wake blink so first blink starts immediately
    natural.wakeBlink(model.blinkState)

    const stepsPerFrame = 60 / fps
    const totalFrames = fps // 1.0 second
    let blinkFinishedAtSec = -1
    for (let f = 0; f < totalFrames; f++) {
      // Simulate Ticker.shared stepping at 60Hz before pixiApplication.render()
      for (let s = 0; s < stepsPerFrame; s++) {
        model.update(1000 / 60)
      }
      params.set('ParamEyeLOpen', 1)
      params.set('ParamEyeROpen', 1)
      internal.emit('beforeModelUpdate')
      // Mirror Live2DModel._render resetting deltaTime to 0 after internalModel.update
      model.deltaTime = 0
      if (blinkFinishedAtSec < 0 && model.blinkState.status === 'ready') {
        blinkFinishedAtSec = (f + 1) / fps
      }
    }
    const endBreath = model.breathDegree
    const breathDelta = (endBreath - startBreath + 360) % 360
    return { breathDelta, blinkFinishedAtSec }
  }

  const r60 = simulateNaturalAtFps(60)
  const r30 = simulateNaturalAtFps(30)

  // Breath advances 2 deg per 1/60s = 120 deg per 1.0s at BOTH 30fps and 60fps
  assert.ok(Math.abs(r60.breathDelta - 120) < 1e-6, `60fps breathDelta=${r60.breathDelta}`)
  assert.ok(Math.abs(r30.breathDelta - 120) < 1e-6, `30fps breathDelta=${r30.breathDelta}`)

  // Natural blink completes in ~0.333s (20/60s at 60fps, 10/30s at 30fps), NOT 0.667s!
  assert.ok(Math.abs(r60.blinkFinishedAtSec - 20 / 60) < 1e-6, `60fps blink=${r60.blinkFinishedAtSec}`)
  assert.ok(Math.abs(r30.blinkFinishedAtSec - 10 / 30) < 1e-6, `30fps blink=${r30.blinkFinishedAtSec}`)
})

// ============================================================================
// 2. JpegFrameSink buffer reuse + repeatLastFrame + bridgeRoutes repeat
// ============================================================================

test('JpegFrameSink reuses batch buffers, lowers raw batch size, and coalesces static repeatLastFrame', async () => {
  const frameBytes = (1920 * 1080 * 3) / 2 // 3,110,400 bytes
  let enqueueCount = 0
  let drainCount = 0
  const pendingPbo = []
  const ipcEvents = []
  const chunkArrayBuffers = new Set()
  const chunkByteLengths = []

  const fakeConverter = {
    frameByteLength: frameBytes,
    enqueueAsync: async (_canvas, reuse) => {
      enqueueCount++
      const buf = reuse && reuse.byteLength === frameBytes ? reuse : new Uint8Array(frameBytes)
      buf[0] = enqueueCount
      pendingPbo.push(buf)
      if (pendingPbo.length >= 2) {
        return pendingPbo.shift()
      }
      return null
    },
    drainAllAsync: async (acquire) => {
      drainCount++
      const out = []
      while (pendingPbo.length > 0) {
        const src = pendingPbo.shift()
        const dst = acquire ? acquire() : src
        if (dst !== src) dst.set(src)
        out.push(dst)
      }
      return out
    },
    dispose: () => {}
  }

  const fakeWindow = {
    electron: {
      ipcRenderer: {
        invoke: async (channel, payload) => {
          if (channel === 'electron:frames-stream-start') {
            ipcEvents.push({ channel, frameFormat: payload.frameFormat })
            return { id: 'pipe-1', videoPath: '/tmp/pipe-1.mp4' }
          }
          if (channel === 'electron:frames-stream-chunk') {
            // Simulate async HTTP upload tick
            await new Promise((r) => setTimeout(r, 2))
            chunkArrayBuffers.add(payload.data.buffer)
            chunkByteLengths.push(payload.data.byteLength)
            const firstBytes = []
            for (let off = 0; off < payload.data.byteLength; off += frameBytes) {
              firstBytes.push(payload.data[off])
            }
            ipcEvents.push({ channel, frames: firstBytes })
            return null
          }
          if (channel === 'electron:frames-stream-repeat') {
            ipcEvents.push({ channel, count: payload.count })
            return { repeated: payload.count }
          }
          if (channel === 'electron:frames-stream-finish') {
            ipcEvents.push({ channel })
            return { videoPath: '/tmp/pipe-1.mp4' }
          }
          throw new Error(`Unexpected IPC channel: ${channel}`)
        }
      }
    }
  }

  const loader = createRendererLoader(
    new Map([
      [path.join(rendererRoot, 'managers/video-export/ExportLogger.ts'), { ExportLogger: class { info() {} warn() {} error() {} } }],
      [path.join(rendererRoot, 'managers/video-export/AsyncFrameCapturer.ts'), { AsyncFrameCapturer: class { async initialize() {} async dispose() {} } }],
      [path.join(rendererRoot, 'managers/video-export/GpuYuv420Converter.ts'), { GpuYuv420Converter: { create: () => fakeConverter } }]
    ]),
    { window: fakeWindow }
  )

  const { JpegFrameSink } = loader.load('managers/video-export/JpegFrameSink.ts')
  const sink = new JpegFrameSink({ width: 1920, height: 1080, quality: 0.92, fps: 30, crf: 23 })
  await sink.initialize({})

  assert.equal(sink.isRawVideoMode, true)
  assert.equal(sink.canRepeatLastFrame, false, 'cannot repeat before first frame')

  // Capture 8 frames (4 batches of 2 frames each = 6.22 MB/batch) to verify batch buffer reuse
  for (let i = 0; i < 8; i++) {
    await sink.captureFrame({})
  }
  assert.equal(sink.canRepeatLastFrame, true)

  // Repeat last frame (frame 8) 5 times consecutively -> coalesced!
  for (let i = 0; i < 5; i++) {
    assert.equal(await sink.repeatLastFrame(), true)
  }

  // Capture 1 new active frame (frame 9), then 2 trailing repeats, then finish
  await sink.captureFrame({})
  assert.equal(await sink.repeatLastFrame(), true)
  assert.equal(await sink.repeatLastFrame(), true)
  const outPath = await sink.finish()

  assert.equal(outPath, '/tmp/pipe-1.mp4')
  assert.equal(enqueueCount, 9, 'GPU enqueueAsync only called for 9 active frames, not 7 static repeats')
  assert.equal(sink.frames, 16, '9 captured + 5 + 2 repeated = 16 total frames')
  assert.ok(drainCount >= 2)

  // Verify every batch is <= 8 MB (at most 2 frames = 6,220,800 bytes at 1080p)
  assert.ok(
    chunkByteLengths.every((len) => len <= 8 * 1024 * 1024),
    `expected raw chunk <= 8 MiB, got ${chunkByteLengths.join(', ')}`
  )
  // Verify batch/single ArrayBuffers were reused across chunks (not freshly allocated each batch)
  assert.ok(
    chunkArrayBuffers.size <= 5,
    `expected pooled buffer reuse (<=5 unique ArrayBuffers), got ${chunkArrayBuffers.size}`
  )

  // Verify exact frame order sent to host: frames [1..8], then repeat(5), then frame [9], then repeat(2), then finish
  const emittedTimeline = []
  for (const ev of ipcEvents) {
    if (ev.channel === 'electron:frames-stream-chunk') {
      emittedTimeline.push(...ev.frames)
    } else if (ev.channel === 'electron:frames-stream-repeat') {
      emittedTimeline.push(`repeat:${ev.count}`)
    }
  }
  assert.deepEqual(emittedTimeline, [1, 2, 3, 4, 5, 6, 7, 8, 'repeat:5', 9, 'repeat:2'])
})

test('bridgeRoutes electron:frames-stream-repeat repeats only the last single rawvideo frame and validates input', async (t) => {
  const { createBridgeRouter } = await import('../../out-host/host/bridge/bridgeRoutes.js')

  // Verify browser-bridge.ts allowlists electron:frames-stream-repeat
  const bridgeSrc = fs.readFileSync(path.join(root, 'src/webrender/src/browser-bridge.ts'), 'utf8')
  assert.match(bridgeSrc, /'electron:frames-stream-repeat'/)

  const writtenFrames = []
  const frameBytes = (4 * 4 * 3) / 2 // 24 bytes per 4x4 yuv420p frame
  let pipeController = null

  const app = express()
  const router = createBridgeRouter({
    logger: new Logger({ minLevel: 6 }),
    config: {
      paths: { resources: tmpdir(), output: tmpdir() },
      video: { fps: 30, width: 4, height: 4, crf: 23, encoder: 'cpu', codec: 'h264', useRustExporter: false },
      tts: { apiBaseUrl: 'http://127.0.0.1:9880', timeoutMs: 10000 },
      llm: { enabled: false },
      bgm: {},
      assets: {}
    },
    createFramesPipe: async (opts) => ({
      outputPath: opts.outputPath,
      get frameCount() {
        return writtenFrames.length
      },
      async write(chunk) {
        for (let off = 0; off < chunk.length; off += frameBytes) {
          writtenFrames.push(chunk[off])
        }
      },
      async finish() {
        return opts.outputPath
      },
      async abort() {}
    }),
    onController: (ctrl) => {
      pipeController = ctrl
    }
  })
  app.use('/bridge', router)

  const server = http.createServer(app)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}/bridge`
  t.after(async () => {
    await pipeController?.disposeAll()
    server.close()
    await once(server, 'close')
  })

  const invokeJson = async (channel, args) => {
    const res = await fetch(`${base}/invoke/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args)
    })
    return { status: res.status, body: await res.json() }
  }

  // Start rawvideo pipe session (4x4 -> 24 bytes/frame)
  const startRes = await invokeJson('electron:frames-stream-start', [
    { fps: 30, width: 4, height: 4, frameFormat: 'rawvideo' }
  ])
  assert.equal(startRes.status, 200)
  const { id } = startRes.body.result

  // Repeat before any frame written -> 400
  const earlyRepeat = await invokeJson('electron:frames-stream-repeat', [{ id, count: 2 }])
  assert.equal(earlyRepeat.status, 400)

  // Invalid count -> 400
  const badCount = await invokeJson('electron:frames-stream-repeat', [{ id, count: -1 }])
  assert.equal(badCount.status, 400)

  // Send a 2-frame batch: frame A (0x11) + frame B (0x22)
  const batch = Buffer.alloc(frameBytes * 2)
  batch.fill(0x11, 0, frameBytes)
  batch.fill(0x22, frameBytes, frameBytes * 2)
  const metaParam = encodeURIComponent(JSON.stringify([{ id, data: null }]))
  const chunkRes = await fetch(
    `${base}/bin/${encodeURIComponent('electron:frames-stream-chunk')}?args=${metaParam}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: batch
    }
  )
  assert.equal(chunkRes.status, 200)

  // Repeat last frame 3 times -> must repeat ONLY frame B (0x22), NOT [A, B]!
  const repRes = await invokeJson('electron:frames-stream-repeat', [{ id, count: 3 }])
  assert.equal(repRes.status, 200)
  assert.equal(repRes.body.result.repeated, 3)

  const finRes = await invokeJson('electron:frames-stream-finish', [{ id }])
  assert.equal(finRes.status, 200)

  assert.deepEqual(writtenFrames, [0x11, 0x22, 0x22, 0x22, 0x22])
})

// ============================================================================
// 3. Moesekai async fast clip write + deterministic model3.json output
// ============================================================================

test('writeFileFastAsync caches directory creation and recovers from removed directory', async (t) => {
  const { writeFileFastAsync } = await import('../../out-host/host/assets/http.js')
  const dir = mkdtempSync(path.join(tmpdir(), 'mss-fast-write-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const nested = path.join(dir, 'sub', 'clips')
  await Promise.all(
    Array.from({ length: 24 }, (_, i) =>
      writeFileFastAsync(path.join(nested, `clip_${i}.json`), JSON.stringify({ i }))
    )
  )
  assert.equal(fs.readdirSync(nested).length, 24)
  assert.equal(JSON.parse(fs.readFileSync(path.join(nested, 'clip_23.json'), 'utf8')).i, 23)

  // Simulate external directory removal: ENOENT recovery recreates directory cleanly
  rmSync(nested, { recursive: true, force: true })
  await writeFileFastAsync(path.join(nested, 'recovered.json'), '{"ok":true}')
  assert.equal(fs.readFileSync(path.join(nested, 'recovered.json'), 'utf8'), '{"ok":true}')
})

test('moesekai downloadModel parallel async clip writes produce deterministic model3.json and bundle priority', async (t) => {
  const { downloadModel } = await import('../../out-host/host/assets/moesekai.js')
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'mss-moesekai-speed-src-'))
  const outA = mkdtempSync(path.join(tmpdir(), 'mss-moesekai-speed-outA-'))
  const outB = mkdtempSync(path.join(tmpdir(), 'mss-moesekai-speed-outB-'))
  const cacheDir = mkdtempSync(path.join(tmpdir(), 'mss-moesekai-speed-cache-'))
  t.after(() => {
    rmSync(fixtureRoot, { recursive: true, force: true })
    rmSync(outA, { recursive: true, force: true })
    rmSync(outB, { recursive: true, force: true })
    rmSync(cacheDir, { recursive: true, force: true })
  })

  const writeFile = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }

  const makeMotionSse = (name, value) =>
    JSON.stringify({
      format: 'sse-motion',
      version: 1,
      name,
      sampleRate: 60,
      startTime: 0,
      stopTime: 1,
      loopTime: false,
      fade: { in: 0.25, out: 0.25 },
      curves: [
        {
          binding: { resolved: { target: 'Parameter', id: 'ParamAngleX' } },
          kind: 'constant',
          value
        }
      ]
    })

  const modelBundle = 'live2d/model/v2_01test_normal'
  const primaryMotionBundle = 'live2d/motion/v2_01test_motion_base'
  const fallbackMotionBundle = 'live2d/motion/01test_motion_base'
  const libDir = path.join(fixtureRoot, 'library')

  // Model bundle
  const modelDir = path.join(libDir, modelBundle)
  writeFile(
    path.join(modelDir, '_ripper.json'),
    JSON.stringify({
      format: 'ripper-unpack',
      version: 3,
      bundle: modelBundle,
      files: [
        { path: 'v2_01test_normal.model3.json' },
        { path: 'v2_01test_normal.moc3' }
      ]
    })
  )
  writeFile(
    path.join(modelDir, 'v2_01test_normal.model3.json'),
    JSON.stringify({
      Version: 3,
      FileReferences: { Moc: 'v2_01test_normal.moc3', Textures: [] },
      Groups: []
    })
  )
  writeFile(path.join(modelDir, 'v2_01test_normal.moc3'), 'MOC3')

  // Primary motion bundle: 30 clips (value = 10)
  const primaryFiles = []
  for (let i = 0; i < 30; i++) {
    const isFace = i % 3 === 0
    const name = isFace
      ? `face_clip_${String(i).padStart(2, '0')}`
      : `w-normal-clip${String(i).padStart(2, '0')}`
    const rel = `${isFace ? 'facial' : 'motion'}/${name}.sse-motion.json`
    primaryFiles.push({ path: rel })
    writeFile(path.join(libDir, primaryMotionBundle, rel), makeMotionSse(name, 10))
  }
  writeFile(
    path.join(libDir, primaryMotionBundle, '_ripper.json'),
    JSON.stringify({ format: 'ripper-unpack', version: 3, bundle: primaryMotionBundle, files: primaryFiles })
  )

  // Secondary/fallback motion bundle: 1 overlapping clip (value = 99 -> must lose to primary!) + 5 unique clips
  const fallbackFiles = [
    { path: 'motion/w-normal-clip01.sse-motion.json' },
    { path: 'motion/w-fallback-extra01.sse-motion.json' }
  ]
  writeFile(
    path.join(libDir, fallbackMotionBundle, 'motion/w-normal-clip01.sse-motion.json'),
    makeMotionSse('w-normal-clip01', 99)
  )
  writeFile(
    path.join(libDir, fallbackMotionBundle, 'motion/w-fallback-extra01.sse-motion.json'),
    makeMotionSse('w-fallback-extra01', 42)
  )
  writeFile(
    path.join(libDir, fallbackMotionBundle, '_ripper.json'),
    JSON.stringify({ format: 'ripper-unpack', version: 3, bundle: fallbackMotionBundle, files: fallbackFiles })
  )

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const full = path.resolve(libDir, rel)
    fs.readFile(full, (err, data) => {
      if (err) {
        res.statusCode = 404
        res.end('not found')
        return
      }
      res.end(data)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const libRoot = `http://127.0.0.1:${server.address().port}/`
  t.after(async () => {
    server.close()
    await once(server, 'close')
  })

  const entry = {
    id: 'v2_01test_normal',
    bundle: modelBundle,
    motion: primaryMotionBundle,
    motions: [primaryMotionBundle],
    kind: 'character',
    characterId: 1
  }

  const resA = await downloadModel(
    entry,
    libRoot,
    outA,
    { timeoutMs: 5000, retries: 1, concurrency: 8, cacheDir, force: true },
    () => {}
  )
  const resB = await downloadModel(
    entry,
    libRoot,
    outB,
    { timeoutMs: 5000, retries: 1, concurrency: 8, cacheDir, force: true },
    () => {}
  )

  assert.equal(resA.motions + resA.facials, 31)
  assert.equal(resB.motions + resB.facials, 31)

  const model3A = JSON.parse(
    fs.readFileSync(path.join(outA, 'v2_01test_normal/v2_01test_normal/v2_01test_normal.model3.json'), 'utf8')
  )
  const model3B = JSON.parse(
    fs.readFileSync(path.join(outB, 'v2_01test_normal/v2_01test_normal/v2_01test_normal.model3.json'), 'utf8')
  )

  // Key order in model3.json must be strictly deterministic across runs
  assert.deepEqual(Object.keys(model3A.FileReferences.Motions), Object.keys(model3B.FileReferences.Motions))

  // Primary v2 bundle must win over optional v1 fallback bundle on overlapping clip name
  const overlapClip = JSON.parse(
    fs.readFileSync(
      path.join(outA, 'v2_01test_normal/v2_01test_normal/motions/w-normal-clip01.motion3.json'),
      'utf8'
    )
  )
  assert.equal(overlapClip.Curves[0].Segments[1], 10, 'primary bundle clip value (10) must win over fallback (99)')

  // Fallback-only clip must also be included
  const extraClip = JSON.parse(
    fs.readFileSync(
      path.join(outA, 'v2_01test_normal/v2_01test_normal/motions/w-fallback-extra01.motion3.json'),
      'utf8'
    )
  )
  assert.equal(extraClip.Curves[0].Segments[1], 42)

  // No leftover .tmp files in motions directory
  const motionFiles = fs.readdirSync(path.join(outA, 'v2_01test_normal/v2_01test_normal/motions'))
  assert.equal(motionFiles.some((f) => f.endsWith('.tmp')), false)
})
