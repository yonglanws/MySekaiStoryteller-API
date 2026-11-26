/**
 * Live2D, Motion & Stage Animation Parity regression suite against SekaiStoryExporter:
 * 1. PlayableAnimator normalized linear crossfade + default-value return (MotionBlend.ts & AdvancedModel.ts);
 * 2. NaturalMotion: Cubism4 built-in 3.2345s breath disabled, per-model seeded resetClockBaselines,
 *    parallelMotionManager[0/1] eyeblink UserData hooks, active/inactive fade-in continuity;
 * 3. Same-body-motion replay after hold-last-frame & bodyForce on re-appear after LayoutClear;
 * 4. ModelLayer exact Cubism-unit scaling (1.4 * H * modeScale / PPU), AlphaFilter resolution sync,
 *    blur [1,3] clamping & deterministic 60Hz hologram step, non-locking bringToFront vs setLayoutDepth;
 * 5. LayoutAppear / LayoutClear / Move / Talk snippet parity (non-locking speaker/move depth,
 *    smooth 0.25s facial crossfade on Move/Clear, concurrent fade-in lip-sync, 900000 unison lip-sync).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const nodeRequire = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const renderer = path.join(root, 'src/renderer/src')

function createLoader(extraMocks = new Map(), opts = {}) {
  let nowMs = opts.initialNowMs ?? 0
  let exporting = opts.exporting ?? true
  const context = vm.createContext({
    console,
    performance: { now: () => nowMs },
    Date,
    setTimeout: (fn, ms = 0, ...args) =>
      setTimeout(() => {
        nowMs += Math.max(1, Number(ms) || 0)
        fn(...args)
      }, 0),
    clearTimeout,
    AbortController,
    AbortSignal
  })

  class Logger {
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
      this.resolution = 1
    }
  }
  class ColorMatrixFilter {
    matrix = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0]
    resolution = 1
    destroy() {}
  }
  class Filter {
    destroy() {}
  }
  class Container {
    children = []
    filters = null
    filterArea = null
    addChild(child) {
      this.children.push(child)
      child.parent = this
    }
    addChildAt(child, idx) {
      this.children.splice(idx, 0, child)
      child.parent = this
    }
    removeChild(child) {
      const i = this.children.indexOf(child)
      if (i >= 0) this.children.splice(i, 1)
      child.parent = null
    }
    setChildIndex(child, idx) {
      const i = this.children.indexOf(child)
      if (i >= 0) this.children.splice(i, 1)
      this.children.splice(idx, 0, child)
    }
  }
  class Live2DModel {
    constructor() {
      this.parent = null
      this.destroyed = false
      this.visible = true
      this.deltaTime = 0
      this.elapsedTime = 0
      this.filters = [new AlphaFilter(0)]
      this.anchor = { x: 0, y: 0 }
      this.position = { x: 0, y: 0 }
      this.scale = {
        x: 1,
        y: 1,
        set(v) {
          this.x = v
          this.y = v
        }
      }
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
    applyEffect() {}
    disable() {}
    disableAll() {}
    destroy() {}
  }
  const tickerHandlers = new Set()
  const MockTicker = {
    shared: {
      elapsedMS: 50,
      add(fn) {
        tickerHandlers.add(fn)
      },
      remove(fn) {
        tickerHandlers.delete(fn)
      },
      tick() {
        for (const fn of Array.from(tickerHandlers)) fn(1)
      }
    }
  }

  const animation = {
    linear: async (cb) => {
      cb(1)
    },
    delay: async (ms) => {
      nowMs += Math.max(0, Number(ms) || 0)
    },
    in_ticker: async () => {},
    isExporting: () => exporting,
    exportEncodeFPS: 60
  }

  const mocks = new Map([
    [
      'pixi-live2d-display-advanced',
      { Live2DModel, Cubism2InternalModel, Cubism4InternalModel, MotionPriority: { FORCE: 3 } }
    ],
    [
      'pixi.js',
      {
        Application: class {},
        Container,
        AlphaFilter,
        ColorMatrixFilter,
        Filter,
        Ticker: MockTicker
      }
    ],
    ['tslog', { Logger }],
    [path.join(renderer, 'utils/Logger.ts'), { default: () => new Logger() }],
    [path.join(renderer, 'managers/AnimationManager.ts'), { default: animation }],
    [path.join(renderer, 'managers/VisualEffectManager.ts'), { VisualEffectManager }],
    ...extraMocks
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
    Container,
    AlphaFilter,
    Cubism4InternalModel,
    MockTicker,
    setNow: (v) => {
      nowMs = v
    },
    setExporting: (v) => {
      exporting = v
    }
  }
}

test('PlayableBlendLayer matches SSE Animator linear weights, zero midpoint dip, and default return', () => {
  const loader = createLoader()
  const blend = loader.load('model/MotionBlend.ts')
  const layer = blend.createPlayableBlendLayer()

  // First clip gets weight=1 immediately even if blendSeconds > 0
  blend.changePlayableBlendLayer(layer, 'clipA', 0.5)
  assert.equal(layer.inputs.length, 1)
  assert.equal(layer.inputs[0].weight, 1)

  // Crossfade to clipB over 0.5s (30 frames at 60fps)
  blend.changePlayableBlendLayer(layer, 'clipB', 0.5)
  assert.equal(layer.inputs.length, 2)
  assert.equal(layer.inputs[0].weight, 1)
  assert.equal(layer.inputs[1].weight, 0)

  // Halfway (0.25s = 15 frames): exact linear 0.5 / 0.5
  for (let i = 0; i < 15; i++) {
    const pruned = blend.advancePlayableBlendLayer(layer, 1 / 60)
    assert.equal(pruned.length, 0)
  }
  assert.ok(Math.abs(layer.inputs[0].weight - 0.5) < 1e-6)
  assert.ok(Math.abs(layer.inputs[1].weight - 0.5) < 1e-6)

  // Evaluate:
  // - param 0 (shared constant 30 -> 30): MUST stay 30 (zero 25% dip!)
  // - param 1 (outgoing-only 1.0, default 0): MUST blend to 0.5
  // - param 2 (incoming-only 20, default 0): MUST blend to 10
  // - param 3 (shared 10 -> 30): MUST blend to 20
  const defaults = [0, 0, 0, 0]
  const out = blend.evaluateBlendedLayerValues(
    [
      {
        weight: layer.inputs[0].weight,
        values: new Map([
          [0, 30],
          [1, 1],
          [3, 10]
        ])
      },
      {
        weight: layer.inputs[1].weight,
        values: new Map([
          [0, 30],
          [2, 20],
          [3, 30]
        ])
      }
    ],
    (idx) => defaults[idx]
  )
  assert.ok(Math.abs(out.get(0) - 30) < 1e-6, `constant pose must not dip: ${out.get(0)}`)
  assert.ok(
    Math.abs(out.get(1) - 0.5) < 1e-6,
    `outgoing-only param returns linearly: ${out.get(1)}`
  )
  assert.ok(Math.abs(out.get(2) - 10) < 1e-6, `incoming-only param enters linearly: ${out.get(2)}`)
  assert.ok(Math.abs(out.get(3) - 20) < 1e-6, `shared param blends linearly: ${out.get(3)}`)

  // Mid-blend triple switch to clipC over 0.25s: weights still sum to 1.0!
  blend.changePlayableBlendLayer(layer, 'clipC', 0.25)
  blend.advancePlayableBlendLayer(layer, 0.125)
  const sum = layer.inputs.reduce((acc, inp) => acc + inp.weight, 0)
  assert.ok(Math.abs(sum - 1) < 1e-6, `multi-input weights must sum to 1, got ${sum}`)

  // Finish blend: clipA & clipB pruned, only clipC remains at weight=1
  const pruned = blend.advancePlayableBlendLayer(layer, 0.125)
  assert.deepEqual([...pruned], ['clipA', 'clipB'])
  assert.equal(layer.inputs.length, 1)
  assert.equal(layer.inputs[0].key, 'clipC')
  assert.equal(layer.inputs[0].weight, 1)
})

test('AdvancedModel disables Cubism4 built-in breath, keeps per-model resetClockBaselines seeds, and hooks parallelMotionManager eyeblink UserData', () => {
  const loader = createLoader()
  const AdvancedModel = loader.load('model/AdvancedModel.ts').default
  const natural = loader.load('model/NaturalMotion.ts')

  const makeFakeQueue = () => ({
    _motions: [],
    _eventCallBack: null,
    _eventCustomData: null,
    setEventCallback(cb, data) {
      this._eventCallBack = cb
      this._eventCustomData = data
    },
    stopAllMotions() {
      this._motions = []
    },
    startMotion(motion) {
      const entry = {
        _motion: motion,
        isStarted: () => true,
        isFinished: () => false,
        isTriggeredFadeOut: () => false,
        setFadeOut() {}
      }
      this._motions.push(entry)
      return 1
    },
    doUpdateMotion: () => true
  })

  const makeInitializedModel = (id) => {
    const model = new AdvancedModel()
    const mainQueue = makeFakeQueue()
    const bodyQueue = makeFakeQueue()
    const faceQueue = makeFakeQueue()
    const internal = new loader.Cubism4InternalModel()
    internal.eyeBlink = { fake: 'eyeBlink' }
    internal.breath = { fake: 'cubismBreath32345' }
    internal.coreModel = {
      _parameterIds: ['ParamEyeLOpen', 'ParamEyeROpen', 'ParamBreath', 'ParamMouthOpenY'],
      getParameterCount: () => 4,
      getParameterIndex: (pid) =>
        ['ParamEyeLOpen', 'ParamEyeROpen', 'ParamBreath', 'ParamMouthOpenY'].indexOf(pid),
      getParameterDefaultValue: (i) => (i < 2 ? 1 : 0),
      getParameterMinimumValue: () => 0,
      getParameterMaximumValue: () => 1,
      getParameterValueById: () => 1,
      setParameterValueById: () => {},
      getDrawableCount: () => 0,
      getMultiplyColor: () => ({ R: 1, G: 1, B: 1, A: 1 }),
      getScreenColor: () => ({ R: 0, G: 0, B: 0, A: 0 })
    }
    internal.motionManager = {
      motionGroups: {},
      definitions: {},
      queueManager: mainQueue,
      loadMotion: async () => null
    }
    internal.parallelMotionManager = []
    internal.extendParallelMotionManager = () => {
      internal.parallelMotionManager = [
        {
          queueManager: bodyQueue,
          state: { setReserved() {} },
          _startMotion() {},
          update: () => true,
          stopAllMotions() {
            bodyQueue.stopAllMotions()
          },
          isFinished: () => true
        },
        {
          queueManager: faceQueue,
          state: { setReserved() {} },
          _startMotion() {},
          update: () => true,
          stopAllMotions() {
            faceQueue.stopAllMotions()
          },
          isFinished: () => true
        }
      ]
    }
    model.internalModel = internal
    model.initialize({
      id,
      model: 'test.model3.json',
      normal_scale: 2.1,
      small_scale: 1.8,
      anchor: 0.5
    })
    return { model, internal, bodyQueue, faceQueue }
  }

  const m21 = makeInitializedModel(21)
  const m22 = makeInitializedModel(22)

  // 1. Both eyeBlink and built-in 3.2345s breath must be disabled
  assert.equal(m21.internal.eyeBlink, undefined)
  assert.equal(m21.internal.breath, undefined)

  // 2. resetClockBaselines preserves per-model deterministic seeds (independent across IDs, identical per ID)
  m21.model.resetClockBaselines(0)
  m22.model.resetClockBaselines(0)
  const expectedBreath21 = natural.createBreathDegree(natural.naturalMotionSeed(21))
  const expectedBreath22 = natural.createBreathDegree(natural.naturalMotionSeed(22))
  assert.equal(m21.model.breathDegree, expectedBreath21)
  assert.equal(m22.model.breathDegree, expectedBreath22)
  assert.notEqual(m21.model.breathDegree, m22.model.breathDegree)

  // 3. parallelMotionManager[0] & [1] UserData callbacks drive blink Command mode!
  assert.equal(typeof m21.bodyQueue._eventCallBack, 'function')
  assert.equal(typeof m21.faceQueue._eventCallBack, 'function')
  m21.bodyQueue._eventCallBack(m21.bodyQueue, 'eyeblink,0.2,0.24,0.24', null)
  assert.equal(m21.model.blinkState.mode, 'command')
  assert.equal(m21.model.blinkState.command.closing, 0.2)
  assert.equal(m21.model.blinkState.command.closed, 0.24)
  assert.equal(m21.model.blinkState.command.opening, 0.24)
})

test('AdvancedModel tryUpdatePlayableBlend crossfades Cubism4 curves linearly without midpoint dip and clears outgoing-only params', () => {
  const loader = createLoader()
  const AdvancedModel = loader.load('model/AdvancedModel.ts').default
  const model = new AdvancedModel()

  const paramIds = ['ParamAngleX', 'ParamTearBROn', 'ParamArmL1']
  const defaults = [0, 0, 0]
  const currentValues = [0, 0, 0]
  const core = {
    getParameterCount: () => paramIds.length,
    getParameterIndex: (id) => paramIds.indexOf(id),
    getParameterDefaultValue: (idx) => defaults[idx],
    getParameterValueByIndex: (idx) => currentValues[idx],
    setParameterValueByIndex: (idx, val) => {
      currentValues[idx] = val
    }
  }

  const makeEntry = (curveMap, events = []) => {
    let started = false
    let startTime = 0
    let lastCheck = 0
    let endTime = -1
    const motion = {
      _fadeInSeconds: 0.5,
      _fadeOutSeconds: 0.5,
      _motionData: { duration: 2.0, loop: false },
      getDuration: () => 2.0,
      setFadeInTime(s) {
        this._fadeInSeconds = s
      },
      setFadeOutTime(s) {
        this._fadeOutSeconds = s
      },
      doUpdateParameters(target, _t, weight) {
        for (const [id, val] of Object.entries(curveMap)) {
          const idx = target.getParameterIndex(id)
          target.setParameterValueByIndex(idx, val, weight)
        }
      },
      getFiredEvent(before, after) {
        return events.filter((e) => e.at > before && e.at <= after).map((e) => e.value)
      }
    }
    return {
      _motion: motion,
      isStarted: () => started,
      setIsStarted: (v) => {
        started = v
      },
      isFinished: () => false,
      isTriggeredFadeOut: () => false,
      getStartTime: () => startTime,
      setStartTime: (t) => {
        startTime = t
      },
      setFadeInStartTime() {},
      getEndTime: () => endTime,
      setEndTime: (t) => {
        endTime = t
      },
      getLastCheckEventSeconds: () => lastCheck,
      setLastCheckEventSeconds: (t) => {
        lastCheck = t
      },
      setState() {},
      setFadeOut() {},
      release() {}
    }
  }

  const firedEvents = []
  const queue = {
    _motions: [],
    _eventCallBack: (_caller, val) => firedEvents.push(val),
    startMotion(motion) {
      const entry = motion._entry
      this._motions.push(entry)
      return this._motions.length
    },
    stopAllMotions() {
      this._motions = []
    },
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

  // Start clipA (fade=0): ParamAngleX=30, ParamTearBROn=1.0
  const entryA = makeEntry({ ParamAngleX: 30, ParamTearBROn: 1.0 })
  entryA._motion._entry = entryA
  model.channelFadeSeconds[0] = 0
  manager._startMotion(entryA._motion)
  queue.doUpdateMotion(core, 1.0)
  assert.equal(currentValues[0], 30)
  assert.equal(currentValues[1], 1.0)

  // Crossfade to clipB over 0.5s (30 frames): ParamAngleX=30, ParamArmL1=20 (NO ParamTearBROn!)
  const entryB = makeEntry({ ParamAngleX: 30, ParamArmL1: 20 }, [
    { at: 0.1, value: 'eyeblink,0.1,0.1,0.1' }
  ])
  entryB._motion._entry = entryB
  model.channelFadeSeconds[0] = 0.5
  manager._startMotion(entryB._motion)

  // Step 15 frames (0.25s = exact midpoint)
  for (let i = 1; i <= 15; i++) {
    queue.doUpdateMotion(core, 1.0 + i / 60)
  }
  assert.ok(
    Math.abs(currentValues[0] - 30) < 1e-5,
    `shared constant must not dip: ${currentValues[0]}`
  )
  assert.ok(
    Math.abs(currentValues[1] - 0.5) < 1e-5,
    `outgoing-only ParamTearBROn must fade linearly: ${currentValues[1]}`
  )
  assert.ok(
    Math.abs(currentValues[2] - 10) < 1e-5,
    `incoming-only ParamArmL1 must fade in linearly: ${currentValues[2]}`
  )
  assert.deepEqual(firedEvents, ['eyeblink,0.1,0.1,0.1'], 'newest input UserData event must fire')

  // Step remaining 15 frames (0.5s = blend complete): entryA pruned, ParamTearBROn cleanly 0!
  for (let i = 16; i <= 30; i++) {
    queue.doUpdateMotion(core, 1.0 + i / 60)
  }
  assert.equal(queue._motions.length, 1, 'outgoing entry must be pruned after blend completes')
  assert.ok(Math.abs(currentValues[0] - 30) < 1e-5)
  assert.ok(
    Math.abs(currentValues[1] - 0) < 1e-5,
    `ParamTearBROn must return to default 0: ${currentValues[1]}`
  )
  assert.ok(Math.abs(currentValues[2] - 20) < 1e-5)
})

test('AdvancedModel allows replaying the same finished body motion and honors bodyForce on re-appear', async () => {
  const loader = createLoader()
  const AdvancedModel = loader.load('model/AdvancedModel.ts').default
  const model = new AdvancedModel()
  model._metadata = { id: 21 }
  model.firstBodyCue = false
  model.currentBodyMotion = 'w-normal-nod01'

  const startHistory = []
  const bodyManager = {
    playing: true,
    isFinished: () => true, // held at last frame!
    state: {
      currentGroup: 'w-normal-nod01',
      currentIndex: 0,
      currentPriority: 3,
      setReserved() {}
    },
    async startMotion(group, index) {
      // Simulate pixi MotionState.reserve refusing if currentGroup === group && currentIndex === index
      if (this.state.currentGroup === group && this.state.currentIndex === index) {
        return false
      }
      this.state.currentGroup = group
      this.state.currentIndex = index
      startHistory.push({ group, fade: model.channelFadeSeconds[0] })
      return true
    }
  }
  model.internalModel = {
    motionManager: {
      definitions: {
        'w-normal-nod01': [{ FadeInTime: 0.5 }],
        'w-cute-glad01': [{ FadeInTime: 0.5 }]
      },
      motionGroups: {
        'w-normal-nod01': [{ getDuration: () => 2.0, setIsLoop() {} }],
        'w-cute-glad01': [{ getDuration: () => 2.0, setIsLoop() {} }]
      },
      loadMotion: async (name) => ({ getDuration: () => 2.0, setIsLoop() {}, _name: name })
    },
    parallelMotionManager: [bodyManager, bodyManager]
  }

  // 1. Replay the same finished body motion: must NOT be refused by MotionState.reserve, blend = 0.125s
  await model.applyMotion('w-normal-nod01')
  assert.equal(startHistory.length, 1)
  assert.equal(startHistory[0].group, 'w-normal-nod01')
  assert.equal(startHistory[0].fade, 0.125)

  // 2. Re-appear after LayoutClear with a different motion and bodyForce: true -> fade MUST be 0s!
  await model.startMotions('w-cute-glad01', undefined, true, { bodyForce: true })
  assert.equal(startHistory.length, 2)
  assert.equal(startHistory[1].group, 'w-cute-glad01')
  assert.equal(startHistory[1].fade, 0)
})

test('ModelLayer scales by Cubism pixelsPerUnit (1.4 * H * modeScale), syncs AlphaFilter resolution, clamps blur [1,3], and bringToFront does not lock depth', () => {
  const blurInstances = []
  const holoSteps = []
  const loader = createLoader(
    new Map([
      [
        path.join(renderer, 'effects/OfficialFilters.ts'),
        {
          Live2DBlurFilter: class {
            constructor(level) {
              this.level = level
              blurInstances.push(this)
            }
            destroy() {}
          },
          Live2DHologramShaderFilter: class {
            step(dt) {
              holoSteps.push(dt)
            }
            setHoloTexture() {}
            destroy() {}
          }
        }
      ],
      [path.join(renderer, 'effects/InappTextures.ts'), { loadInappTexture: async () => null }]
    ])
  )
  const ModelLayer = loader.load('layers/ModelLayer.ts').default
  const { LIVE2D_CUBISM_UNIT_TO_SCREEN_HEIGHT } = loader.load('layers/ModelLayer.ts')
  assert.ok(Math.abs(LIVE2D_CUBISM_UNIT_TO_SCREEN_HEIGHT - 1.4) < 1e-9)

  const app = {
    stage: new loader.Container(),
    screen: { width: 1280, height: 720 },
    renderer: { resolution: 1.5 }
  }
  const layer = new ModelLayer(app)

  const makeModel = (id, opts = {}) => ({
    metadata: { id, normal_scale: opts.normal_scale ?? 2.1 },
    destroyed: false,
    visible: true,
    filters: [new loader.AlphaFilter(1)],
    internalModel: {
      originalHeight: opts.originalHeight ?? 4500,
      pixelsPerUnit: opts.pixelsPerUnit ?? 3000
    },
    scale: {
      value: 0,
      set(v) {
        this.value = v
      }
    },
    _shader: null,
    getCharacterShaderFilter() {
      return this._shader
    },
    setCharacterShaderFilter(f) {
      this._shader = f
    }
  })

  // 1. Standard 3000x4500 PPU=3000 -> scale = 720 * 1.4 / 3000 = 0.336 === 720 / 4500 * 2.1
  const m1 = makeModel(1)
  layer.addModelToLayer(m1)
  assert.ok(Math.abs(m1.scale.value - (720 / 4500) * 2.1) < 1e-9)
  assert.equal(
    m1.filters[0].resolution,
    1.5,
    'AlphaFilter resolution must sync to renderer resolution'
  )

  // 2. Non-standard canvas height (3000x3000 PPU=3000): SSE projects by PPU (still 1.4*H/3000 = 0.336!)
  const m2 = makeModel(2, { originalHeight: 3000, pixelsPerUnit: 3000 })
  layer.addModelToLayer(m2)
  assert.ok(Math.abs(m2.scale.value - (720 * 1.4) / 3000) < 1e-9)

  // 3. bringToFront alternates speakers WITHOUT permanently locking first speaker to front!
  layer.bringToFront(1)
  assert.equal(layer.getContainer().children.at(-1), m1)
  layer.bringToFront(2)
  assert.equal(
    layer.getContainer().children.at(-1),
    m2,
    'speaker 2 must come in front of speaker 1'
  )
  layer.bringToFront(1)
  assert.equal(layer.getContainer().children.at(-1), m1, 'speaker 1 must come back to front')

  // 4. Blur level clamped to [1, 3]
  layer.setCharacterShader(1, 'blur', 8.0)
  assert.equal(blurInstances.at(-1).level, 3)
  layer.setCharacterShader(1, 'blur', 0.2)
  assert.equal(blurInstances.at(-1).level, 3 - 2) // clamped to 1

  // 5. Hologram steps at deterministic 1/60s during export (ignoring 50ms wall Ticker.shared.elapsedMS)
  layer.setCharacterShader(2, 'hologram')
  loader.MockTicker.shared.tick()
  assert.equal(holoSteps.length, 1)
  assert.ok(Math.abs(holoSteps[0] - 1 / 60) < 1e-9)
  layer.destroy()
})

test('LayoutAppear, LayoutClear, Move, and Talk snippets match SSE depth, facialFade, bodyForce, and 900000 unison lip-sync', async () => {
  const loader = createLoader()
  const LayoutAppearSnippet = loader.load('snippets/LayoutAppearSnippet.ts').default
  const LayoutClearSnippet = loader.load('snippets/LayoutClearSnippet.ts').default
  const MoveSnippet = loader.load('snippets/MoveSnippet.ts').default
  const TalkSnippet = loader.load('snippets/TalkSnippet.ts').default

  const calls = []
  const shown = new Set()
  const mouthWrites = new Map()
  const makeStageModel = (id) => {
    const internal = new loader.Cubism4InternalModel()
    return {
      metadata: { id },
      destroyed: false,
      visible: true,
      parent: null,
      internalModel: internal,
      actionSignal: new AbortController().signal,
      beginVisibilityChange: () => 1,
      currentVisibilityGeneration: () => 1,
      isVisibilityCurrent: () => true,
      hasMotion: (m) => Boolean(m),
      isMotionLooping: () => false,
      getMotionDurationMs: () => 0,
      setOpacity: () => {},
      setPositionRel: () => {},
      startMotions: async (motion, facial, _ff, opts) => {
        calls.push({ kind: 'startMotions', id, motion, facial, opts })
      },
      startEntryMotion: async () => {
        calls.push({ kind: 'startEntryMotion', id })
      },
      startBodyIdleLoop: () => {},
      show: async () => {},
      hide: async () => {},
      move: async () => true,
      moveToCurrent: async () => true,
      applyCharacterAction: async () => {},
      setMouthOpening: (v) => {
        const arr = mouthWrites.get(id) ?? []
        arr.push(v)
        mouthWrites.set(id, arr)
      },
      releaseMouth: () => {}
    }
  }

  const m1 = makeStageModel(1)
  const m2 = makeStageModel(2)
  const models = new Map([
    [1, m1],
    [2, m2]
  ])
  const app = {
    stage_size: [1920, 1080],
    isExporting: true,
    currentTalkStartedAtMs: 0,
    lastSnippetActualDurationMs: 200,
    currentTalkLipSync: null,
    videoExportManager: { signal: new AbortController().signal },
    ttsManager: { isTTSEnabled: () => false },
    getModelById: (id) => {
      const m = models.get(id)
      if (!m) throw new Error(`Model ${id} not found`)
      return m
    },
    layerModel: {
      layoutMode: 'Normal',
      addModelToLayer: (m) => {
        m.parent = {}
      },
      removeModel: (m) => {
        shown.delete(m.metadata.id)
        m.parent = null
      },
      isModelShown: (id) => shown.has(id),
      isModelVisible: () => false, // simulate alpha=0 during concurrent fade-in!
      markModelShown: (id) => {
        const was = shown.has(id)
        shown.add(id)
        return was
      },
      markModelHidden: (id) => {
        const was = shown.has(id)
        shown.delete(id)
        return was
      },
      bringToFront: (id) => calls.push({ kind: 'bringToFront', id }),
      setLayoutDepth: (id, depth) => calls.push({ kind: 'setLayoutDepth', id, depth }),
      getUnisonSpeakerModels: () => [m1, m2]
    },
    layerUI: {
      UITalkShowed: true,
      resetTalkData: () => {},
      setTalkData: () => {},
      showTextBackground: async () => {},
      startDisplayContent: async () => {},
      closePlaceInfo: () => {}
    }
  }

  // 1. Fresh LayoutAppear -> bodyForce: true, facialForce: true
  await new LayoutAppearSnippet(app, {
    type: 'LayoutAppear',
    delay: 0,
    data: {
      modelId: 1,
      from: { side: 'Center', offset: 0 },
      to: { side: 'Center', offset: 0 },
      motion: 'w-normal-nod01',
      facial: 'face_normal_01',
      facialFirst: true,
      moveSpeed: 'Normal',
      hologram: false
    }
  }).runSnippet()
  const appearOpts = calls.find((c) => c.kind === 'startMotions')?.opts
  assert.equal(appearOpts?.bodyForce, true)
  assert.equal(appearOpts?.facialForce, true)

  // 2. Re-appear while already shown with empty motion -> must NOT overwrite with startEntryMotion
  calls.length = 0
  await new LayoutAppearSnippet(app, {
    type: 'LayoutAppear',
    delay: 0,
    data: {
      modelId: 1,
      from: { side: 'Center', offset: 0 },
      to: { side: 'Left', offset: 0 },
      motion: '',
      facial: '',
      facialFirst: true,
      moveSpeed: 'Normal',
      hologram: false
    }
  }).runSnippet()
  assert.equal(
    calls.some((c) => c.kind === 'startEntryMotion'),
    false
  )

  // 3. Move -> bringToFront (NOT setLayoutDepth!) and facialForce: false
  calls.length = 0
  await new MoveSnippet(app, {
    type: 'Move',
    delay: 0,
    data: {
      modelId: 1,
      from: { side: 'Left', offset: 0 },
      to: { side: 'Left', offset: 0 },
      motion: 'w-normal-sigh01',
      facial: 'face_sad_01',
      facialFirst: true,
      moveSpeed: 'Normal'
    }
  }).runSnippet()
  assert.ok(calls.some((c) => c.kind === 'bringToFront' && c.id === 1))
  assert.equal(
    calls.some((c) => c.kind === 'setLayoutDepth'),
    false
  )
  assert.equal(calls.find((c) => c.kind === 'startMotions')?.opts.facialForce, false)

  // 4. Talk during concurrent fade-in (isModelVisible=false, isModelShown=true):
  //    bringToFront (not setLayoutDepth) AND speaker mouth animates!
  calls.length = 0
  mouthWrites.clear()
  loader.setNow(0)
  await new TalkSnippet(app, {
    type: 'Talk',
    delay: 0,
    data: { speaker: '绘名', content: '你好啊', modelId: 1, voice: '' }
  }).runSnippet()
  assert.ok(calls.some((c) => c.kind === 'bringToFront' && c.id === 1))
  assert.equal(
    calls.some((c) => c.kind === 'setLayoutDepth'),
    false
  )
  assert.ok(
    (mouthWrites.get(1)?.length ?? 0) > 0,
    'speaker mouth must animate while isModelShown is true'
  )

  // 5. Unison Talk (modelId = 900000): does NOT throw getModelById(900000), drives both m1 & m2!
  shown.add(2)
  mouthWrites.clear()
  loader.setNow(0)
  await new TalkSnippet(app, {
    type: 'Talk',
    delay: 0,
    data: { speaker: '全员', content: '一起加油！', modelId: 900000, voice: '' }
  }).runSnippet()
  assert.ok((mouthWrites.get(1)?.length ?? 0) > 0, 'unison talk must drive model 1')
  assert.ok((mouthWrites.get(2)?.length ?? 0) > 0, 'unison talk must drive model 2')

  // 6. Sliding LayoutClear -> bringToFront + facialForce: false
  calls.length = 0
  await new LayoutClearSnippet(app, {
    type: 'LayoutClear',
    delay: 0,
    data: {
      modelId: 1,
      from: { side: 'Left', offset: 0 },
      to: { side: 'LeftOver', offset: 0 },
      motion: 'w-normal-nod01',
      facial: 'face_smile_01',
      moveSpeed: 'Normal'
    }
  }).runSnippet()
  assert.ok(calls.some((c) => c.kind === 'bringToFront' && c.id === 1))
  assert.equal(calls.find((c) => c.kind === 'startMotions')?.opts.facialForce, false)
})
