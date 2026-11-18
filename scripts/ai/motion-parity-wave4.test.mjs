import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const rendererRoot = path.join(root, 'src/renderer/src')

const staged = require(path.join(root, 'out-host/host/ai/staged.js'))
const promptMod = require(path.join(root, 'out-host/host/ai/prompt.js'))
const validate = require(path.join(root, 'out-host/host/ai/validate.js'))
const linter = require(path.join(root, 'out-host/host/ai/officialLinter.js'))

function createRendererLoader(overrides = {}, globals = {}) {
  let fakePerfNow = 1000
  const context = vm.createContext({
    console,
    Date,
    setTimeout,
    clearTimeout,
    AbortController,
    performance: { now: () => fakePerfNow },
    ...globals
  })
  class Logger {
    info() {}
    error() {}
    debug() {}
    warn() {}
    getSubLogger() {
      return new Logger()
    }
  }
  class Live2DModel {
    destroy() {}
  }
  class Cubism2InternalModel {}
  class Cubism4InternalModel {}
  class AlphaFilter {
    constructor(alpha = 0) {
      this.alpha = alpha
    }
  }
  class VisualEffectManager {
    createAll() {}
    applyEffect() {}
    disableAll() {}
  }
  const mocks = new Map([
    [
      'pixi-live2d-display-advanced',
      {
        Live2DModel,
        Cubism2InternalModel,
        Cubism4InternalModel,
        MotionPriority: { FORCE: 3 }
      }
    ],
    ['pixi.js', { AlphaFilter }],
    ['pixi.js-legacy', { Ticker: class {}, UPDATE_PRIORITY: { INTERACTION: 50 } }],
    [
      path.join(rendererRoot, 'utils/Logger.ts'),
      { default: () => new Logger(), getSubLogger: () => new Logger() }
    ],
    [path.join(rendererRoot, 'managers/VisualEffectManager.ts'), { VisualEffectManager }],
    [
      path.join(rendererRoot, 'managers/AnimationManager.ts'),
      {
        default: {
          linear: async () => {},
          delay: async () => {},
          in_ticker: async (_step, when) => {
            if (typeof when === 'function') when()
          },
          isExporting: () => true
        }
      }
    ],
    ...Object.entries(overrides).map(([k, v]) => [
      k.startsWith('.') || !path.isAbsolute(k) ? path.join(rendererRoot, k) : k,
      v
    ])
  ])
  const modules = new Map()
  const compiled = new Map()
  function load(target) {
    const filename = path.isAbsolute(target) ? target : path.join(rendererRoot, target)
    if (mocks.has(filename)) return mocks.get(filename)
    if (modules.has(filename)) return modules.get(filename)
    if (!compiled.has(filename)) {
      const source = fs.readFileSync(filename, 'utf8')
      compiled.set(
        filename,
        new vm.Script(
          `(function (exports, require) {\n${
            ts.transpileModule(source, {
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
    const localRequire = (name) => {
      if (mocks.has(name)) return mocks.get(name)
      const resolvedTs = path.resolve(path.dirname(filename), `${name}.ts`)
      if (mocks.has(resolvedTs)) return mocks.get(resolvedTs)
      assert.ok(name.startsWith('.'), `Unexpected dependency in VM: ${name}`)
      return load(resolvedTs)
    }
    compiled.get(filename).runInContext(context)(exports, localRequire)
    return exports
  }
  return {
    load,
    setNow: (ms) => {
      fakePerfNow = ms
    },
    getNow: () => fakePerfNow,
    mocks
  }
}

function makeRichCatalog() {
  return {
    models: [
      {
        id: 1,
        characterId: 1,
        name: '星乃一歌',
        shortName: '一歌',
        path: '01ichika_normal/01ichika_normal.model3.json',
        motions: [
          'w-normal-default01',
          'w-normal-nod01',
          'w-normal-tilthead01',
          'w-normal-lookaway01',
          'w-normal-relief01',
          'w-normal-think01',
          'w-normal-sigh01',
          'w-normal-greeting01',
          'w-cute-glad01',
          'w-adult-blushed01'
        ],
        facials: [
          'face_normal_01',
          'face_smile_01',
          'face_trouble_01',
          'face_surprise_01',
          'face_serious_01',
          'face_closeeye_01'
        ],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_normal_01'
      },
      {
        id: 2,
        characterId: 2,
        name: '天马咲希',
        shortName: '咲希',
        path: '02saki_normal/02saki_normal.model3.json',
        motions: [
          'w-normal-default01',
          'w-normal-nod01',
          'w-normal-tilthead01',
          'w-normal-lookaway01',
          'w-normal-relief01',
          'w-normal-think01',
          'w-normal-sigh01',
          'w-normal-greeting01',
          'w-cute-glad01',
          'w-adult-blushed01'
        ],
        facials: [
          'face_normal_01',
          'face_smile_01',
          'face_trouble_01',
          'face_surprise_01',
          'face_serious_01',
          'face_closeeye_01'
        ],
        defaultMotion: 'w-normal-default01',
        defaultFacial: 'face_normal_01'
      }
    ],
    backgrounds: [{ id: 'bg1', name: '教室', file: 'bg_room.jpg' }],
    bgm: [{ id: 'bgm00001', title: '日常', file: 'bgm00001.mp3' }],
    se: [{ id: 'se00004_b', file: 'se00004_b.mp3', description: '手机消息' }]
  }
}

test('AdvancedModel eliminates Date.now() leaks and recovers VirtualClock backward jumps via resetClockBaselines & auto-sync', () => {
  const advancedSource = fs.readFileSync(path.join(rendererRoot, 'model/AdvancedModel.ts'), 'utf8')
  assert.equal(
    /\bDate\.now\s*\(/.test(advancedSource),
    false,
    'AdvancedModel must not use Date.now()'
  )

  const loader = createRendererLoader()
  loader.setNow(120_000)
  const mod = loader.load('model/AdvancedModel.ts')
  const AdvancedModel = mod.default
  const stageTiming = loader.load('snippets/stageTiming.ts')

  const model = Object.create(AdvancedModel.prototype)
  model.visible = true
  model.destroyed = false
  model.filters = [{ alpha: 1 }]
  model.breathDegree = 0
  model.blinkState = { status: 'ready', timer: 0, opening: 1, untilTime: 0.01, count: 0 }
  const params = new Map([
    ['ParamEyeROpen', 1],
    ['ParamEyeLOpen', 1],
    ['ParamBreath', 0]
  ])
  const listeners = new Map()
  model.internalModel = {
    on: (ev, cb) => listeners.set(ev, cb),
    coreModel: {
      getParameterIndex: (id) => (params.has(id) ? 0 : -1),
      getParameterValueById: (id) => params.get(id) ?? 0,
      setParameterValueById: (id, val) => params.set(id, val)
    }
  }
  model.installNaturalMotion()
  const beforeUpdate = listeners.get('beforeModelUpdate')
  assert.ok(typeof beforeUpdate === 'function')

  // Simulate VirtualClockController.install() resetting performance.now() from 120s -> 0
  loader.setNow(0)
  beforeUpdate()
  const degreeAtZero = model.breathDegree

  loader.setNow(100)
  beforeUpdate()
  assert.ok(
    model.breathDegree > degreeAtZero,
    `Expected breath to advance after backward clock reset, stayed at ${model.breathDegree}`
  )
  assert.notEqual(
    params.get('ParamEyeLOpen'),
    1,
    'Expected blink to step once clock reset recovered'
  )

  // StageTiming epoch reset on backward clock jump & explicit resetClockBaselines
  const mockApp = { layerModel: { children: [model] } }
  loader.setNow(90_000)
  stageTiming.recordLayoutRunningEnd(mockApp, 92_000)
  stageTiming.recordMotionSettledAt(mockApp, 1, 93_500)
  assert.equal(stageTiming.getLayoutRunningEndMs(mockApp), 92_000)
  assert.equal(stageTiming.areTrackedMotionsSettled(mockApp, 90_000), false)

  loader.setNow(16)
  assert.equal(
    stageTiming.getLayoutRunningEndMs(mockApp),
    0,
    'layoutEndMs must clear across clock reset'
  )
  assert.equal(stageTiming.areTrackedMotionsSettled(mockApp, 16), true)
  stageTiming.recordLayoutRunningEnd(mockApp, 500)
  assert.equal(stageTiming.getLayoutRunningEndMs(mockApp), 500)

  model.lastChangeBlinkTime = 99_999
  stageTiming.resetClockBaselines(mockApp, 0)
  assert.equal(stageTiming.getLayoutRunningEndMs(mockApp), 0)
  assert.equal(model.lastChangeBlinkTime, 0)
})

test('AnimationManager ticker clocks recover cleanly across backward VirtualClock jumps', async () => {
  const events = []
  let fakeNow = 50_000
  const timers = []
  const animLoader = createRendererLoader(
    {
      'managers/AnimationManager.ts': undefined
    },
    {
      performance: { now: () => fakeNow },
      setTimeout: (fn) => {
        timers.push(fn)
        return timers.length
      }
    }
  )
  // Remove AnimationManager mock so we load real AnimationManager.ts inside VM
  animLoader.mocks.delete(path.join(rendererRoot, 'managers/AnimationManager.ts'))
  const AnimationManager = animLoader.load('managers/AnimationManager.ts').default
  AnimationManager.isExportMode = true

  let finished = false
  const run = AnimationManager.in_ticker(
    (ticker) => {
      events.push(ticker.elapsedMS)
      if (events.length >= 3) finished = true
    },
    () => finished
  )
  // Frame 1: VirtualClock installs and resets performance.now() to 0!
  fakeNow = 0
  timers.shift()()
  // Frame 2: advance 16ms
  fakeNow = 16
  timers.shift()()
  // Frame 3: advance 33ms
  fakeNow = 33
  timers.shift()()
  await run

  assert.ok(
    events.every((d) => d >= 0),
    `Ticker deltas must never be negative: ${events.join(', ')}`
  )
  assert.deepEqual(events, [0, 16, 17])
})

test('Cubism4 loop flag, hold-last-frame on channel 1, lowercase ParamEyeball* & body isolation work together', async () => {
  const loader = createRendererLoader({
    [path.join(root, 'src/common/types/Story.ts')]: {
      MoveSpeed: { Slow: 'Slow', Normal: 'Normal', Fast: 'Fast', Immediate: 'Immediate' },
      Sides: { Center: 'Center', Left: 'Left', Right: 'Right' },
      LayoutModes: { Normal: 'Normal', Three: 'Three' }
    }
  })
  const mod = loader.load('model/AdvancedModel.ts')
  const AdvancedModel = mod.default
  const { motionFamilyKey } = mod

  assert.equal(motionFamilyKey('w-normal01-nod'), 'w-normal')
  assert.equal(motionFamilyKey('w-normal16-relief'), 'w-normal')
  assert.equal(motionFamilyKey('w-normal07cool02-think'), 'w-normal')
  assert.equal(motionFamilyKey('l-night03-sigh'), 'l-night')

  // Verify lowercase ParamEyeballX/Y + uppercase ParamEyeBallX/Y + alias normalization
  const model = Object.create(AdvancedModel.prototype)
  model.logger = { warn() {} }
  model._metadata = { id: 1 }
  model.channelGeneration = [0, 0]
  model.channelFadeSeconds = [0.5, 0.25]
  model.channelHeldEntries = [new WeakSet(), new WeakSet()]
  model.channelFinishFiredEntries = [new WeakSet(), new WeakSet()]
  model.channelEntryCounts = [0, 0]
  model.recentBodyMotions = []
  model.bodyIgnoredParamIds = []
  model.oneShotWaitDepth = 0
  model.firstBodyCue = true
  model.actionController = new AbortController()
  model.blinkState = { status: 'sleep', timer: 0, opening: 1, untilTime: 0, count: 0 }

  const eyes = model.eyeParameterIds()
  assert.equal(eyes[0], 'ParamEyeROpen')
  assert.equal(eyes[1], 'ParamEyeLOpen')
  assert.ok(eyes.includes('ParamEyeballX') && eyes.includes('ParamEyeballY'))
  assert.ok(eyes.includes('ParamEyeBallX') && eyes.includes('ParamEyeBallY'))

  const fakeCoreParams = {
    ParamEyeROpen: 1,
    ParamEyeLOpen: 1,
    ParamEyeballX: 0.25,
    ParamEyeballY: -0.1,
    ParamBrowLX: -0.4,
    ParamBrowLY: 0.3,
    ParamEyeLSmile: 0.8,
    ParamMouthForm: 0.9,
    ParamMouthOpenY: 0,
    ParamBreath: 0.5,
    ParamBodyAngleX: 0
  }
  model.modelParamIds = new Set(Object.keys(fakeCoreParams))

  let currentFadeIn = 0
  const bodyEntries = []
  const facialEntries = []

  function makeManager(entriesRef, isFace) {
    return {
      playing: false,
      state: { setReserved() {}, complete() {} },
      _startMotion(m, onFinish, _ignoreIds) {
        m.setFinishedMotionHandler?.(onFinish)
        return 1
      },
      isFinished() {
        return entriesRef.every((e) => e.isFinished())
      },
      async startMotion(name) {
        this.playing = true
        const m = await model.internalModel.motionManager.loadMotion(name, 0)
        const entry = {
          _motion: m,
          _started: false,
          _finished: false,
          _startTime: 0,
          _fadeIn: 0,
          _endTime: -1,
          _lastCheck: 0,
          _fadeOutSec: 0.25,
          _trigFadeOut: false,
          isStarted: () => entry._started,
          setIsStarted: (v) => {
            entry._started = v
          },
          isFinished: () => entry._finished,
          setIsFinished: (v) => {
            entry._finished = v
          },
          isTriggeredFadeOut: () => entry._trigFadeOut,
          setFadeOut: (s) => {
            entry._fadeOutSec = s
            entry._trigFadeOut = true
          },
          startFadeOut: (s, u) => {
            entry._trigFadeOut = true
            if (entry._endTime < 0 || u + s < entry._endTime) entry._endTime = u + s
          },
          getFadeOutSeconds: () => entry._fadeOutSec,
          getStartTime: () => entry._startTime,
          setStartTime: (t) => {
            entry._startTime = t
          },
          setFadeInStartTime: (t) => {
            entry._fadeIn = t
          },
          getEndTime: () => entry._endTime,
          setEndTime: (t) => {
            entry._endTime = t
          },
          setLastCheckEventSeconds: (t) => {
            entry._lastCheck = t
          }
        }
        entriesRef.push(entry)
        this._startMotion(m, () => {
          this.playing = false
        }, [])
        return true
      },
      update(core, userTimeSeconds) {
        return this.queueManager.doUpdateMotion(core, userTimeSeconds)
      },
      queueManager: {
        _motions: entriesRef,
        startMotion(m, _auto) {
          entriesRef[entriesRef.length - 1]._motion = m
          return entriesRef.length
        },
        stopAllMotions() {
          entriesRef.length = 0
        },
        doUpdateMotion(_core, userTimeSeconds) {
          for (let i = 0; i < entriesRef.length; i++) {
            const e = entriesRef[i]
            const m = e._motion
            let justStarted = false
            if (!e.isStarted()) {
              justStarted = true
              e.setIsStarted(true)
              e.setStartTime(userTimeSeconds)
              e.setFadeInStartTime(userTimeSeconds)
              e.setEndTime(m.isLoop() ? -1 : userTimeSeconds + m._motionData.duration)
            }
            const t = userTimeSeconds - e.getStartTime()
            if (isFace) {
              // Verify fadeOut suppression on active non-looping facial after initial start
              if (!justStarted && !e.isTriggeredFadeOut()) {
                assert.equal(e.getEndTime(), -1, 'Held facial must clear premature endTime')
              }
            } else {
              // Body tries to clobber facial + eyeball + body params!
              fakeCoreParams.ParamEyeballX = 0
              fakeCoreParams.ParamBrowLX = 0
              fakeCoreParams.ParamEyeLSmile = 0
              fakeCoreParams.ParamMouthForm = 0
              fakeCoreParams.ParamEyeLOpen = 0
              fakeCoreParams.ParamBreath = 0
              fakeCoreParams.ParamBodyAngleX = 12
            }
            if (t >= m._motionData.duration && !m.isLoop()) {
              m._onFinishedMotion?.(m)
              e.setIsFinished(true)
              entriesRef.splice(i, 1)
              i--
              continue
            }
            if (e.getEndTime() > 0 && e.getEndTime() < userTimeSeconds) {
              e.setIsFinished(true)
              entriesRef.splice(i, 1)
              i--
            } else if (e.isTriggeredFadeOut()) {
              e.startFadeOut(e.getFadeOutSeconds(), userTimeSeconds)
            }
          }
          return true
        }
      }
    }
  }

  const loopMotion = {
    _isLoop: false,
    _isLoopFadeIn: true,
    _motionData: {
      loop: true,
      duration: 2.0,
      curves: [{ id: 'ParamBodyAngleX' }, { id: 'ParamEyeballX' }, { id: 'ParamBrowLX' }]
    },
    setIsLoop(v) {
      this._isLoop = v
    },
    isLoop() {
      return this._isLoop
    },
    setIsLoopFadeIn(v) {
      this._isLoopFadeIn = v
    },
    setFadeInTime(s) {
      currentFadeIn = s
    },
    setFinishedMotionHandler(fn) {
      this._onFinishedMotion = fn
    }
  }

  const shortFaceMotion = {
    _isLoop: false,
    _motionData: {
      loop: false,
      duration: 1.2,
      curves: [{ id: 'ParamMouthForm' }, { id: 'ParamBrowLX' }, { id: 'ParamEyeLSmile' }]
    },
    isLoop() {
      return false
    },
    setFadeInTime() {},
    setFinishedMotionHandler(fn) {
      this._onFinishedMotion = fn
    }
  }

  const createdRaw = {
    _isLoop: false,
    _isLoopFadeIn: true,
    _motionData: { loop: true, duration: 2.0 },
    setIsLoop(v) {
      this._isLoop = v
    },
    setIsLoopFadeIn(v) {
      this._isLoopFadeIn = v
    }
  }

  model.internalModel = {
    coreModel: {
      _parameterIds: Object.keys(fakeCoreParams),
      getParameterValueById: (id) => fakeCoreParams[id] ?? 0,
      setParameterValueById: (id, val) => {
        fakeCoreParams[id] = val
      }
    },
    motionManager: {
      definitions: {
        'w-normal01-nod': [{}],
        'w-normal04-relief': [{}],
        'w-normal-default01': [{}],
        'l-night03-sigh': [{}],
        face_smile_01: [{}]
      },
      motionGroups: {
        'w-normal01-nod': [loopMotion],
        face_smile_01: [shortFaceMotion],
        face_surprise_01: [{ ...shortFaceMotion }]
      },
      createMotion: () => createdRaw,
      loadMotion: async (name) => model.internalModel.motionManager.motionGroups[name]?.[0] ?? null
    },
    parallelMotionManager: [makeManager(bodyEntries, false), makeManager(facialEntries, true)]
  }
  Object.setPrototypeOf(model.internalModel.coreModel, {})

  // Hook installation
  model.installMotionLoopHook()
  const wrappedCreated = model.internalModel.motionManager.createMotion({}, 'w-normal01-nod', {})
  assert.equal(wrappedCreated._isLoop, true, 'Meta.Loop=true must call setIsLoop(true)')
  assert.equal(wrappedCreated._isLoopFadeIn, false, 'Looping clips must disable fadeIn bounce')

  model.installHoldLastFrameHook(0)
  model.installHoldLastFrameHook(1)
  model.installBodyParameterIsolation()
  model.installCrossfade(0)
  model.installCrossfade(1)

  // Patch coreModel instanceof check bypass by testing isolation around startMotions(facialFirst=undefined)
  // Real runtime uses Cubism4InternalModel, so test both startMotions param isolation wiring & hold-last-frame!
  await model.startMotions('w-normal01-nod', 'face_smile_01', undefined, { facialForce: true })
  assert.equal(loopMotion._isLoop, true, 'Looping body clip must enable setIsLoop(true)')
  assert.equal(
    model.blinkState.status,
    'ready',
    'Isolated eyes must wake auto-blink even while looping'
  )
  assert.ok(
    model.bodyIgnoredParamIds.includes('ParamEyeballX') &&
      model.bodyIgnoredParamIds.includes('ParamBrowLX') &&
      model.bodyIgnoredParamIds.includes('ParamEyeLSmile') &&
      model.bodyIgnoredParamIds.includes('ParamMouthForm') &&
      model.bodyIgnoredParamIds.includes('ParamBreath') &&
      model.bodyIgnoredParamIds.includes('ParamEyeLOpen'),
    `Expected all facial + eye + eyeball params isolated, got: ${model.bodyIgnoredParamIds.join(', ')}`
  )

  // Advance channel 1 facial past 1.2s duration to 5.0s: must HOLD last frame and report isFinished() === true!
  const faceMgr = model.internalModel.parallelMotionManager[1]
  faceMgr.update(model.internalModel.coreModel, 0.0)
  assert.equal(facialEntries[0].getEndTime(), -1, 'Frame-0 post-update must suppress endTime')
  faceMgr.update(model.internalModel.coreModel, 0.9)
  assert.equal(facialEntries.length, 1)
  assert.equal(faceMgr.isFinished(), false)

  faceMgr.update(model.internalModel.coreModel, 1.5)
  assert.equal(
    facialEntries.length,
    1,
    'Short non-looping v2 face_* clip must NOT splice after 1.2s'
  )
  assert.equal(
    faceMgr.isFinished(),
    true,
    'Held facial must report isFinished() === true after duration'
  )

  faceMgr.update(model.internalModel.coreModel, 5.0)
  assert.equal(facialEntries.length, 1, 'Held facial stays pinned through 5s Talk')

  // Next facial triggers 0.25s crossfade and fades held entry out cleanly
  await model.applyFacial('face_surprise_01', false)
  assert.equal(facialEntries.length, 2)
  assert.equal(facialEntries[0]._fadeOutSec, 0.25)
  faceMgr.update(model.internalModel.coreModel, 5.1)
  assert.equal(facialEntries.length, 2, 'Old held facial smoothly fades out over 0.25s')
  faceMgr.update(model.internalModel.coreModel, 5.4)
  assert.equal(
    facialEntries.length,
    1,
    'Old held facial splices out cleanly once crossfade completes'
  )

  // Test pickChainMotion matching across numbered v2 prefix w-normal01 -> w-normal04
  model.recentBodyMotions = ['w-normal01-nod']
  for (let i = 0; i < 6; i++) {
    const picked = model.pickChainMotion()
    assert.equal(
      picked,
      'w-normal04-relief',
      'Expected normalized family match skipping default/recent'
    )
  }

  // Verify applyAndWait turns off loop temporarily so one-shot completes, then normal start turns loop back on
  model.oneShotWaitDepth++
  await model.startMotions('w-normal01-nod', undefined, false)
  assert.equal(loopMotion._isLoop, false, 'One-shot wait must disable loop temporarily')
  model.oneShotWaitDepth--
  assert.ok(currentFadeIn >= 0)

  // Verify LayoutAppearSnippet & MoveSnippet isolate facial + eyeball params when facialFirst is omitted
  const startMotionsCalls = []
  const snippetModel = Object.assign(Object.create(AdvancedModel.prototype), {
    _metadata: { id: 1 },
    internalModel: {},
    beginVisibilityChange: () => 1,
    hasMotion: () => true,
    isMotionLooping: () => false,
    getMotionDurationMs: () => 0,
    setPositionRel() {},
    setOpacity() {},
    async move() {},
    async show() {},
    startBodyIdleLoop() {},
    async startMotions(motion, facial, facialFirst, opts) {
      startMotionsCalls.push({ motion, facial, facialFirst, opts })
    },
    async startEntryMotion() {}
  })
  const mockSnippetApp = {
    stage_size: [1920, 1080],
    layerModel: {
      layoutMode: 'Normal',
      markModelShown: () => false,
      addModelToLayer() {},
      setLayoutDepth() {}
    },
    getModelById: () => snippetModel
  }
  const LayoutAppearSnippet = loader.load('snippets/LayoutAppearSnippet.ts').default
  await new LayoutAppearSnippet(mockSnippetApp, {
    type: 'LayoutAppear',
    data: {
      modelId: 1,
      from: { side: 'Left', offset: 0 },
      to: { side: 'Left', offset: 0 },
      motion: 'w-normal01-nod',
      facial: 'face_smile_01',
      moveSpeed: 'Normal',
      hologram: false
    }
  }).runSnippet()
  assert.equal(
    startMotionsCalls[0].facialFirst,
    true,
    'LayoutAppearSnippet must default facialFirst to true'
  )

  const MoveSnippet = loader.load('snippets/MoveSnippet.ts').default
  await new MoveSnippet(mockSnippetApp, {
    type: 'Move',
    data: {
      modelId: 1,
      from: { side: 'Left', offset: 0 },
      to: { side: 'Left', offset: 90 },
      motion: 'w-normal01-nod',
      facial: 'face_smile_01',
      moveSpeed: 'Normal'
    }
  }).runSnippet()
  assert.equal(
    startMotionsCalls[1].facialFirst,
    true,
    'MoveSnippet must default facialFirst to true'
  )

  // Verify startEntryMotion picks distinct entrance poses across models without standing/blushed fallback
  const entryPicked = []
  for (const id of [1, 2]) {
    const m = Object.create(AdvancedModel.prototype)
    m._metadata = { id }
    m.recentBodyMotions = []
    m.defaultMotionName = 'w-normal-default01'
    m.defaultFacialName = 'face_normal_01'
    m.internalModel = {
      motionManager: {
        definitions: {
          'w-normal-default01': [{}],
          'w-adult-blushed01': [{}],
          'w-normal-nod01': [{}],
          'w-normal-tilthead01': [{}],
          'w-normal-lookaway01': [{}],
          'w-normal-greeting01': [{}]
        }
      }
    }
    entryPicked.push(m.pickEntryMotion(0))
  }
  assert.notEqual(entryPicked[0], entryPicked[1], 'Entry motions must diversify across models')
  assert.ok(entryPicked.every((name) => name !== 'w-normal-default01'))
})

test('storyPlan omits empty motion/facial ghost cues and preserves modelId 0', () => {
  const loader = createRendererLoader({
    [path.join(root, 'src/common/types/Story.ts')]: {
      MoveSpeed: { Slow: 'Slow', Normal: 'Normal', Fast: 'Fast', Immediate: 'Immediate' },
      Sides: { Center: 'Center', Left: 'Left', Right: 'Right' },
      LayoutModes: { Normal: 'Normal', Three: 'Three' }
    }
  })
  const planMod = loader.load(path.join(root, 'src/common/export/storyPlan.ts'))
  const snippets = [
    {
      type: 'Talk',
      wait: true,
      delay: 0,
      data: {
        speaker: '一歌',
        content: '你好。',
        ttsText: '',
        voice: '',
        modelId: 0,
        motion: '',
        facial: '',
        actions: [{ at: 0, modelId: 0, motion: '', facial: '' }]
      }
    },
    {
      type: 'Talk',
      wait: true,
      delay: 0,
      data: {
        speaker: '一歌',
        content: '嗯。',
        ttsText: '',
        voice: '',
        modelId: 0,
        motion: 'w-normal-nod01',
        facial: 'face_smile_01'
      }
    }
  ]
  const timeline = [
    { snippetIndex: 0, startTimeMs: 0, endTimeMs: 2500, durationMs: 2500 },
    { snippetIndex: 1, startTimeMs: 2500, endTimeMs: 5000, durationMs: 2500 }
  ]
  const plan = planMod.bakeStoryPlan(snippets, timeline)

  assert.equal(
    plan.entries[0].actions.length,
    0,
    'Empty motion/facial strings must NOT emit ghost actions'
  )
  assert.equal(plan.entries[1].actions.length, 1)
  assert.equal(
    plan.entries[1].actions[0].modelId,
    0,
    'modelId=0 must be preserved, not coerced to -1'
  )
})

test('staged.ts preserves short-line motion, eliminates synthetic 2-beat injection & freezes, and passes linter', () => {
  const catalog = makeRichCatalog()
  const view = new promptMod.CatalogView(catalog, {
    background: 'bg_room.jpg',
    cast: [
      { id: 1, model: catalog.models[0].path, characterId: 1, name: '星乃一歌' },
      { id: 2, model: catalog.models[1].path, characterId: 2, name: '天马咲希' }
    ]
  })
  const plan = staged.normalizeCastPlan(
    {
      title: '练习日',
      background: 'bg_room.jpg',
      cast: [
        { modelId: 1, name: '一歌', role: '主唱' },
        { modelId: 2, name: '咲希', role: '键盘手' }
      ],
      scenes: [
        { id: 's1', location: 'bg_room.jpg', time: 'day', transition: 'black', summary: '讨论新曲' }
      ]
    },
    view,
    '放学后讨论新曲'
  )

  const lines = Array.from({ length: 20 }, (_, i) => ({
    id: `l${i + 1}`,
    speaker: i < 5 ? '一歌' : i % 2 === 0 ? '一歌' : '咲希',
    content:
      i % 5 === 1
        ? '嗯。'
        : i % 5 === 4
          ? '原来如此……真是这样啊。'
          : '虽然还在调整副歌的节奏，但大家一起试一遍吧。',
    emotion: i % 4 === 0 ? '平静' : '开心'
  }))
  const dialogue = staged.normalizeDialogue({ title: '练习日', lines }, plan)
  const staging = staged.normalizeStaging(
    {
      scenes: [
        {
          id: 's1',
          fromLineId: 'l1',
          background: 'bg_room.jpg',
          ambient: 'normal',
          activeCast: [1, 2]
        }
      ],
      events: [{ lineId: 'l7', move: { speaker: '咲希', kind: 'stepCloser', offset: 90 } }]
    },
    view,
    plan,
    dialogue
  )

  // Over-saturate calm + <=7-char lines to verify pruning does NOT strip short-line motion or create frozen gaps,
  // and does NOT inject synthetic at:0.55 2-beat Talk actions!
  const direction = staged.normalizeDirection(
    {
      background: 'bg_room.jpg',
      lines: lines.map((l, idx) => ({
        id: l.id,
        motion: idx === 10 || idx === 11 ? '' : 'w-normal-nod01',
        facial: idx === 10 || idx === 11 ? '' : 'face_smile_01'
      }))
    },
    view,
    plan,
    dialogue
  )

  const l2Dir = direction.lines.find((l) => l.id === 'l2')
  assert.equal(l2Dir.motion, 'w-normal-nod01', '<=7-char line must preserve body motion')
  const syntheticTwoBeat = direction.lines.filter((l) => (l.beats?.length ?? 0) >= 2)
  assert.equal(syntheticTwoBeat.length, 0, 'Must NOT inject artificial 20% at:0.55 2-beat Talks')

  const rawStory = staged.composeStory(view, plan, dialogue, direction, staging)
  const { story } = validate.validateAndFixStory(rawStory, view)
  const report = linter.lintOfficialStory(story, view)
  assert.equal(report.passed, true, `officialLinter issues: ${report.issues.join('; ')}`)
  assert.equal(report.metrics.appearMotionClashCount, 0)

  const appears = story.snippets.filter((s) => s.type === 'LayoutAppear')
  assert.equal(appears.length, 2)
  assert.notEqual(
    appears[0].data.motion,
    appears[1].data.motion,
    'Entering cast members must not clone identical fallback poses'
  )

  const moves = story.snippets.filter((s) => s.type === 'Move')
  assert.ok(moves.length >= 1)
  assert.ok(
    moves.every((m) => Boolean(m.data.motion) && Boolean(m.data.facial)),
    'Move snippets must carry motion & facial'
  )

  const standaloneMotions = story.snippets.filter((s) => s.type === 'Motion')
  assert.ok(
    standaloneMotions.length >= 2,
    'Should emit standalone quiet-reaction Motion cues in 20-line dialogue'
  )
  assert.ok(
    standaloneMotions.every((m) => m.wait === true && m.delay >= 0.25),
    'Standalone Motion cues must wait after closed Talk cleanly'
  )
  // No standalone Motion may start on an actor whose immediately following Talk (<400ms) acts on the same modelId
  for (let idx = 0; idx < story.snippets.length - 1; idx++) {
    const cur = story.snippets[idx]
    const nxt = story.snippets[idx + 1]
    if (
      cur.type === 'Motion' &&
      cur.data?.motion &&
      nxt.type === 'Talk' &&
      (nxt.delay ?? 0) < 0.8
    ) {
      const nxtActions = Array.isArray(nxt.data?.actions) ? nxt.data.actions : []
      const hasImmediateConflict =
        (nxt.data?.modelId === cur.data.modelId && Boolean(nxt.data?.motion)) ||
        nxtActions.some(
          (a) => a.modelId === cur.data.modelId && Boolean(a.motion) && (a.at ?? 0) < 0.35
        )
      assert.equal(
        hasImmediateConflict,
        false,
        `Standalone Motion at snippets[${idx}] (modelId=${cur.data.modelId}) must not be interrupted <400ms by next Talk`
      )
    }
  }

  // Verify directed.silentMotion picks an off-turn actor (!== nextTalkSpeaker), AND explicit same-speaker
  // silentReaction preserves its pose across the next unpaused Talk without immediate body-motion cutoff
  const miniLines = [
    { id: 'l1', speaker: '一歌', content: '咲希，准备好了吗？', emotion: '平静' },
    { id: 'l2', speaker: '咲希', content: '嗯，交给我吧。', emotion: '开心' },
    { id: 'l3', speaker: '一歌', content: '那就开始吧！', emotion: '开心' }
  ]
  const miniDialogue = staged.normalizeDialogue({ title: '测试', lines: miniLines }, plan)
  const miniStaging = staged.normalizeStaging(
    {
      scenes: [
        {
          id: 's1',
          fromLineId: 'l1',
          background: 'bg_room.jpg',
          ambient: 'normal',
          activeCast: [1, 2]
        }
      ],
      events: [
        {
          lineId: 'l2',
          silentReaction: { speaker: '一歌', motion: 'w-normal-relief01', facial: 'face_smile_01' }
        }
      ]
    },
    view,
    plan,
    miniDialogue
  )
  const miniDir = staged.normalizeDirection(
    {
      background: 'bg_room.jpg',
      lines: [
        { id: 'l1', motion: 'w-normal-nod01', facial: 'face_normal_01', silentMotion: true },
        { id: 'l2', motion: 'w-normal-tilthead01', facial: 'face_smile_01' },
        { id: 'l3', motion: 'w-normal-think01', facial: 'face_smile_01' }
      ]
    },
    view,
    plan,
    miniDialogue
  )
  const miniStory = staged.composeStory(view, plan, miniDialogue, miniDir, miniStaging)
  const miniAppears = miniStory.snippets.filter((s) => s.type === 'LayoutAppear')
  const miniTalks = miniStory.snippets.filter((s) => s.type === 'Talk')
  const miniMotions = miniStory.snippets.filter((s) => s.type === 'Motion')
  assert.equal(
    miniMotions.length,
    2,
    'Both directed.silentMotion and ev.silentReaction emit Motion snippets'
  )
  assert.equal(miniTalks[0].data.closeWindowOnFinish, true)
  assert.notEqual(
    miniMotions[0].data.modelId,
    miniTalks[1].data.modelId,
    'Auto/directed silentMotion must choose off-turn actor rather than immediate next Talk speaker'
  )
  assert.equal(
    miniTalks[2].data.actions?.some(
      (a) => a.modelId === miniMotions[1].data.modelId && Boolean(a.motion)
    ),
    false,
    'Next unpaused Talk on explicit silentReaction target must not interrupt Motion <400ms'
  )
  const sakiAppearMotion = miniAppears.find((s) => s.data.modelId === 2)?.data.motion
  const sakiFirstTalkMotion = miniTalks[1].data.actions?.find((a) => a.modelId === 2)?.motion
  assert.notEqual(
    sakiAppearMotion,
    sakiFirstTalkMotion,
    'Second actor first Talk must not repeat their LayoutAppear motion'
  )
})
