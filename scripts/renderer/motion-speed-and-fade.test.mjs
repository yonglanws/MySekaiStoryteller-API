/**
 * Regression tests for:
 * 1. installHoldLastFrameHook WeakSet identity after stopAllMotions() (initialize sequence);
 * 2. installCrossfade syncing oldEntry._motion.setFadeOutTime(fade) and clearing queue when fade === 0;
 * 3. AdvancedModel.update(dt) offstage deltaTime isolation and resetClockBaselines() elapsedTime domain;
 * 4. LayoutAppearSnippet in-place fade-in (visible=true, no pop/flash, exact fade startMs).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const nodeRequire = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const renderer = path.join(root, 'src/renderer/src')

function createLoader(extraMocks = new Map(), opts = {}) {
  let nowMs = opts.initialNowMs ?? 1000
  const context = vm.createContext({
    console,
    performance: { now: () => nowMs },
    Date,
    setTimeout,
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
    }
  }
  class Filter {
    destroy() {}
  }
  class Live2DModel {
    constructor() {
      this.parent = null
      this.destroyed = false
      this.visible = true
      this.deltaTime = 0
      this.elapsedTime = 0
      this.filters = [new AlphaFilter(0)]
    }
    update(dt) {
      this.deltaTime += dt
      this.elapsedTime += dt
    }
    destroy() {
      this.destroyed = true
    }
  }
  class Cubism2InternalModel {}
  class Cubism4InternalModel {}
  class VisualEffectManager {}

  let exporting = true
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
    ['pixi.js', { AlphaFilter, Filter, Ticker: { shared: { add() {}, remove() {} } } }],
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
    Live2DModel,
    setNow: (v) => {
      nowMs = v
    },
    getNow: () => nowMs,
    setExporting: (v) => {
      exporting = v
    }
  }
}

test('installHoldLastFrameHook still marks clips finished after stopAllMotions() replaces channel WeakSets', () => {
  const loader = createLoader()
  const AdvancedModel = loader.load('model/AdvancedModel.ts').default
  const model = Object.create(AdvancedModel.prototype)
  model.channelHeldEntries = [new WeakSet(), new WeakSet()]
  model.channelFinishFiredEntries = [new WeakSet(), new WeakSet()]
  model.channelEntryCounts = [0, 0]
  model.oneShotWaitDepth = 0

  let finishCount = 0
  let startTime = 10
  let endTime = 12.6
  const entry = {
    _motion: {
      _motionData: { duration: 2.6, loop: true },
      isLoop: () => false,
      getDuration: () => 2.6,
      _onFinishedMotion: () => {
        finishCount++
      }
    },
    isStarted: () => true,
    isFinished: () => false,
    isTriggeredFadeOut: () => false,
    getStartTime: () => startTime,
    setStartTime: (t) => {
      startTime = t
    },
    setFadeInStartTime: () => {},
    getEndTime: () => endTime,
    setEndTime: (t) => {
      endTime = t
    },
    setLastCheckEventSeconds: () => {}
  }

  const queueManager = {
    _motions: [],
    doUpdateMotion: () => true,
    stopAllMotions() {
      this._motions = []
    }
  }
  const manager = {
    queueManager,
    isFinished: () => queueManager._motions.length === 0
  }
  model.internalModel = { parallelMotionManager: [manager, manager] }

  model.installHoldLastFrameHook(0)
  // Mirrors initialize(): stopAllMotions() runs immediately after installHoldLastFrameHook(0)
  queueManager.stopAllMotions()

  queueManager._motions = [entry]
  // Mid-clip: not finished yet
  queueManager.doUpdateMotion({}, 11.0)
  assert.equal(manager.isFinished(), false)
  assert.equal(finishCount, 0)

  // End-of-clip: held at last frame AND manager.isFinished() reports true
  queueManager.doUpdateMotion({}, 12.65)
  assert.equal(
    manager.isFinished(),
    true,
    'manager.isFinished() must see held entry after stopAllMotions()'
  )
  assert.equal(model.hasActiveHeldEntry(0), true, 'hasActiveHeldEntry must see held entry')
  assert.equal(finishCount, 1, 'finish handler must fire once')

  // Subsequent frames keep holding without double-firing finish
  queueManager.doUpdateMotion({}, 15.0)
  assert.equal(manager.isFinished(), true)
  assert.equal(finishCount, 1)
})

test('installCrossfade syncs old motion _fadeOutSeconds and clears queue when fade === 0', () => {
  const loader = createLoader()
  const AdvancedModel = loader.load('model/AdvancedModel.ts').default
  const model = Object.create(AdvancedModel.prototype)
  model.channelFadeSeconds = [0.125, 0]
  model.logger = { warn() {} }

  let oldMotionFadeOut = 0.5
  let oldEntryFadeOut = null
  let stopAllCount = 0
  const oldEntry = {
    _motion: {
      setFadeOutTime(sec) {
        oldMotionFadeOut = sec
      }
    },
    setFadeOut(sec) {
      oldEntryFadeOut = sec
    }
  }
  const newEntry = { setFadeOut() {} }

  const queue0 = {
    _motions: [oldEntry, newEntry],
    stopAllMotions() {
      stopAllCount++
      this._motions = []
    },
    startMotion() {
      return 1
    }
  }
  const queue1 = {
    _motions: [oldEntry],
    stopAllMotions() {
      stopAllCount++
      this._motions = []
    },
    startMotion() {
      this._motions.push(newEntry)
      return 2
    }
  }
  const mgr0 = { queueManager: queue0, _startMotion() {} }
  const mgr1 = { queueManager: queue1, _startMotion() {} }
  model.internalModel = { parallelMotionManager: [mgr0, mgr1] }

  model.installCrossfade(0)
  model.installCrossfade(1)

  // Channel 0: fade=0.125 -> syncs BOTH entry.setFadeOut(0.125) and oldEntry._motion.setFadeOutTime(0.125)
  let newFadeIn = null
  mgr0._startMotion({
    setFadeInTime(sec) {
      newFadeIn = sec
    }
  })
  assert.equal(newFadeIn, 0.125)
  assert.equal(oldEntryFadeOut, 0.125)
  assert.equal(oldMotionFadeOut, 0.125, 'old motion _fadeOutSeconds must match crossfade window')
  assert.equal(stopAllCount, 0, 'positive crossfade must not call stopAllMotions')

  // Channel 1: fade=0 -> calls stopAllMotions so old entry does not linger for 1 ghost frame
  mgr1._startMotion({ setFadeInTime() {} })
  assert.equal(stopAllCount, 1, 'fade=0 must clear old entries immediately')
  assert.equal(queue1._motions.length, 1)
})

test('AdvancedModel.update prevents offstage deltaTime buildup and resetClockBaselines preserves elapsedTime domain', () => {
  const loader = createLoader()
  const AdvancedModel = loader.load('model/AdvancedModel.ts').default
  const model = new AdvancedModel()

  // Simulate 50 seconds offstage (before LayoutAppear or after LayoutClear)
  for (let i = 0; i < 3000; i++) {
    model.update(1000 / 60)
  }
  assert.equal(model.deltaTime, 0, 'offstage model must not accumulate deltaTime')
  assert.ok(model.elapsedTime > 49_000, 'elapsedTime stays monotonic')

  // Attach to stage: single step accumulates normally, clamped against giant spikes
  model.parent = {}
  model.update(1000 / 60)
  assert.ok(Math.abs(model.deltaTime - 1000 / 60) < 1e-6)

  loader.setExporting(false)
  model.deltaTime = 0
  model.update(5000)
  assert.equal(model.deltaTime, 100, 'preview spikes are clamped to 100ms')

  // resetClockBaselines resets deltaTime and uses elapsedTime domain (50s), NOT performance.now() (0ms)
  let entryStart = 49.5
  let startTimeWrites = 0
  model.internalModel = {
    parallelMotionManager: [
      {
        queueManager: {
          _motions: [
            {
              getStartTime: () => entryStart,
              setStartTime: (t) => {
                startTimeWrites++
                entryStart = t
              },
              setFadeInStartTime: () => {},
              setLastCheckEventSeconds: () => {},
              setEndTime: () => {},
              isTriggeredFadeOut: () => false
            }
          ]
        }
      },
      { queueManager: { _motions: [] } }
    ]
  }
  model.resetClockBaselines(0)
  assert.equal(model.deltaTime, 0)
  assert.equal(
    startTimeWrites,
    0,
    'entry started at 49.5s in elapsedTime domain must not be overwritten to 0s when performance.now() resets'
  )
})

test('LayoutAppearSnippet in-place fade-in resets stale alpha when offstage, sets visible=true, and passes exact startMs', async () => {
  const loader = createLoader(
    new Map([
      [
        path.join(root, 'src/common/types/Story.ts'),
        {
          MoveSpeed: { Slow: 'Slow', Normal: 'Normal', Fast: 'Fast', Immediate: 'Immediate' },
          Sides: { Center: 'Center', Left: 'Left', Right: 'Right' },
          LayoutModes: { Normal: 'Normal', Three: 'Three' }
        }
      ],
      [
        path.join(renderer, 'utils/StageUtils.ts'),
        {
          default: {
            side_to_position: () => ({ x: 0.3, y: 0.5 }),
            move_speed_to_num: () => 500
          }
        }
      ]
    ]),
    { initialNowMs: 500 }
  )
  const LayoutAppearSnippet = loader.load('snippets/LayoutAppearSnippet.ts').default

  const calls = []
  let showArgs = null
  const model = {
    visible: false,
    parent: null,
    internalModel: {},
    beginVisibilityChange: () => 1,
    setOpacity: (a) => calls.push(`setOpacity:${a}`),
    setPositionRel: () => calls.push('setPositionRel'),
    hasMotion: () => true,
    isMotionLooping: () => false,
    getMotionDurationMs: () => 2600,
    startMotions: async () => calls.push('startMotions'),
    startEntryMotion: async () => {},
    startBodyIdleLoop: () => calls.push('startBodyIdleLoop'),
    show: async (...args) => {
      showArgs = args
      calls.push('show')
    }
  }
  const app = {
    stage_size: [1920, 1080],
    getModelById: () => model,
    layerModel: {
      layoutMode: 'Normal',
      markModelShown: () => false,
      addModelToLayer: () => {
        calls.push('addModelToLayer')
        model.parent = {}
      }
    }
  }

  const snippet = new LayoutAppearSnippet(app, {
    type: 'LayoutAppear',
    wait: true,
    delay: 0,
    data: {
      modelId: 1,
      from: { side: 'Left', offset: 0 },
      to: { side: 'Left', offset: 0 },
      motion: 'w-normal-trouble01',
      facial: 'face_trouble_01',
      facialFirst: true,
      moveSpeed: 'Normal',
      hologram: false
    }
  })

  await snippet.runSnippet()

  assert.equal(
    model.visible,
    true,
    'LayoutAppear must restore visible=true (e.g. after changeCostume)'
  )
  assert.ok(
    calls.indexOf('setOpacity:0') >= 0 &&
      calls.indexOf('setOpacity:0') < calls.indexOf('addModelToLayer'),
    `fresh offstage appear must zero opacity before adding to layer: ${calls.join(',')}`
  )
  assert.ok(showArgs, 'show must be called')
  assert.equal(showArgs[0], 350, 'in-place character fade-in = 350ms (21 frames)')
  // branchDelay (1 frame) + holdFrames (1 frame) = 2 * (1000/60) = 33.333ms after t=500
  assert.ok(
    Math.abs(showArgs[3] - (500 + (2 * 1000) / 60)) < 1e-6,
    `expected exact fade startMs=${500 + (2 * 1000) / 60}, got ${showArgs[3]}`
  )
})
