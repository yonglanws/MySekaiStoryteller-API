/**
 * 角色位移与显隐的缓动/连续性。
 *
 * - 入场/退场/Move 的位移走 DOTween OutQuad（与 sse-core/src/ease.rs 同款），
 *   不再是线性匀速。
 * - show/hide 从当前 AlphaFilter 值补间到目标值：退场中途重新 Appear、
 *   连续 Hide 都不会闪一帧全透明/全不透明。
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

const PROGRESS = [0, 0.25, 0.5, 0.75, 1]

function loadAdvancedModel() {
  const context = vm.createContext({ console, performance: { now: () => 0 } })
  class AlphaFilter {
    constructor(alpha = 0) {
      this.alpha = alpha
    }
  }
  class Live2DModel {}
  class Cubism2InternalModel {}
  class Cubism4InternalModel {}
  class Logger {
    info() {}
    error() {}
    debug() {}
    warn() {}
    getSubLogger() {
      return this
    }
  }
  const frames = { progress: [...PROGRESS] }
  const animation = {
    linear: async (callback) => {
      for (const p of frames.progress) callback(p)
    },
    delay: async () => {},
    isExporting: () => true,
    exportEncodeFPS: 30
  }
  const mocks = new Map([
    [
      'pixi-live2d-display-advanced',
      { Live2DModel, Cubism2InternalModel, Cubism4InternalModel, MotionPriority: { FORCE: 3 } }
    ],
    ['pixi.js', { AlphaFilter }],
    [path.join(renderer, 'utils/Logger.ts'), { default: () => new Logger() }],
    [path.join(renderer, 'managers/AnimationManager.ts'), { default: animation }],
    [
      path.join(renderer, 'managers/VisualEffectManager.ts'),
      {
        VisualEffectManager: class {
          createAll() {}
          applyEffect() {}
          disableAll() {}
        }
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
      const resolved = path.resolve(path.dirname(filename), `${name}.ts`)
      if (mocks.has(resolved)) return mocks.get(resolved)
      return load(resolved)
    }
    compiled.get(filename).runInContext(context)(exports, require)
    return exports
  }
  return {
    AdvancedModel: load('model/AdvancedModel.ts').default,
    Cubism4InternalModel,
    load,
    frames
  }
}

function makeModel(loader) {
  const { AdvancedModel, load } = loader
  const natural = load('model/NaturalMotion.ts')
  const model = Object.create(AdvancedModel.prototype)
  const alpha = { alpha: 0 }
  const positions = []
  let px = 0
  let py = 0
  model.filters = [alpha]
  model.destroyed = false
  model.visible = true
  model.inHologram = false
  model.currentBodyMotion = null
  model.bodyChainTimer = null
  model.channelGeneration = [0, 0]
  model.shakeGeneration = 0
  model.basePositionBeforeShake = null
  model.position = {
    get x() {
      return px
    },
    set x(value) {
      px = value
      positions.push({ x: value, y: py })
    },
    get y() {
      return py
    },
    set y(value) {
      py = value
      positions.push({ x: px, y: value })
    }
  }
  model.blinkState = natural.createBlinkState(1)
  model.autoBlink = true
  model.lastChangeBlinkTime = null
  model.visualEffectManager = { applyEffect() {}, disableAll() {} }
  model.cancelPendingActions = function () {
    this.bodyChainArmed = false
  }
  model.isVisibilityCurrent = () => true
  return { model, alpha, positions }
}

test('drawable multiply/screen colours are neutralized to match the reference shader', () => {
  const { AdvancedModel } = loadAdvancedModel()
  const model = Object.create(AdvancedModel.prototype)
  model.logger = { info() {} }
  model._metadata = { id: 21 }
  const rawMultiply = [
    { R: 0.9, G: 0.9, B: 0.9, A: 1 },
    { R: 1, G: 1, B: 1, A: 1 }
  ]
  const rawScreen = [
    { R: 0, G: 0, B: 0, A: 0 },
    { R: 0.1, G: 0.2, B: 0.3, A: 1 }
  ]
  const core = {
    getDrawableCount: () => 2,
    getDrawableMultiplyColor: (i) => rawMultiply[i],
    getDrawableScreenColor: (i) => rawScreen[i],
    getMultiplyColor: (i) => rawMultiply[i],
    getScreenColor: (i) => rawScreen[i]
  }
  model.internalModel = { coreModel: core }
  model.neutralizeDrawableColors()
  const multiply = core.getMultiplyColor(0)
  assert.equal([multiply.R, multiply.G, multiply.B, multiply.A].join(','), '1,1,1,1')
  const screen = core.getScreenColor(1)
  assert.equal([screen.R, screen.G, screen.B, screen.A].join(','), '0,0,0,0')
})

test('move lands exactly on the destination in both axes', async () => {
  const loader = loadAdvancedModel()
  const { model } = makeModel(loader)
  // 参考宽 1000：Left = 200px，Right = 800px；y 是模型画布中心的归一化位置。
  await model.move([1000, 1000], { x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }, 500)
  assert.equal(model.position.x, 800)
  assert.equal(model.position.y, 500)
})

test('move x samples the official linear curve at each frame', async () => {
  const loader = loadAdvancedModel()
  const { model, positions } = makeModel(loader)
  await model.move([1000, 1000], { x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }, 500)
  const xs = []
  let last
  for (const entry of positions) {
    if (entry.x !== last) {
      xs.push(entry.x)
      last = entry.x
    }
  }
  // 官方 `DOLocalMove(...).SetEase(Linear)`：p=0 → 200；0.25 → 350；0.5 → 500；
  // 0.75 → 650；1 → 800。
  for (const [i, expected] of [200, 350, 500, 650, 800].entries()) {
    assert.ok(
      Math.abs((xs[i] ?? Number.NaN) - expected) < 1e-6,
      `sample ${i}: expected ${expected}, got ${xs[i]} (${xs.join(',')})`
    )
  }
  assert.equal(xs[2], 500, 'linear midpoint at 50% time')
})

test('moveToCurrent starts at the current position, not a stale layout from', async () => {
  const loader = loadAdvancedModel()
  const { model, positions } = makeModel(loader)
  // 角色已经在一帧 Appear 里落到 0.5；Move 的 from 字段仍是旧值，不能把它拉回去。
  model.setPositionRel([1000, 1000], { x: 0.5, y: 0.8085 })
  positions.length = 0
  const moved = await model.moveToCurrent([1000, 1000], { x: 0.2, y: 0.8085 }, 500)
  assert.equal(moved, true)
  assert.equal(positions[0].x, 500)
  assert.equal(positions[0].y, 808.5)
  assert.equal(positions.at(-1).x, 200)
  assert.equal(positions.at(-1).y, 808.5)

  positions.length = 0
  const noop = await model.moveToCurrent([1000, 1000], { x: 0.2, y: 0.8085 }, 500)
  assert.equal(noop, false, 'already at target: no tween, caller still waits the duration')
  assert.equal(positions.length, 0)
})

test('show fades from the current alpha instead of always restarting at 0', async () => {
  const loader = loadAdvancedModel()
  const { model, alpha } = makeModel(loader)
  const seen = []
  let value = 0.4
  Object.defineProperty(alpha, 'alpha', {
    get: () => value,
    set: (next) => {
      value = next
      seen.push(next)
    }
  })
  await model.show(200, false)
  assert.equal(seen[0], 0.4, `show must start at the current alpha: ${seen.join(',')}`)
  assert.equal(seen.at(-1), 1)
  assert.ok(seen.every((v, i) => i === 0 || v >= seen[i - 1]))
})

test('hide fades from the current alpha instead of snapping to 1', async () => {
  const loader = loadAdvancedModel()
  const { model, alpha } = makeModel(loader)
  const seen = []
  let value = 0.4
  Object.defineProperty(alpha, 'alpha', {
    get: () => value,
    set: (next) => {
      value = next
      seen.push(next)
    }
  })
  await model.hide(200)
  // 0.4 → 0.3 → 0.2 → 0.1 → 0
  assert.deepEqual(
    seen.map((v) => Math.round(v * 100) / 100),
    [0.4, 0.3, 0.2, 0.1, 0]
  )
})

test('releaseMouth hands ParamMouthOpenY back to the next writer', async () => {
  const loader = loadAdvancedModel()
  const { AdvancedModel, Cubism4InternalModel } = loader
  const model = Object.create(AdvancedModel.prototype)
  const values = new Map([['ParamMouthOpenY', 0]])
  const core = {
    getParameterIndex: () => 0,
    getParameterCount: () => 1,
    getParameterMinimumValue: () => 0,
    getParameterMaximumValue: () => 1,
    getParameterDefaultValue: () => 0,
    getParameterValueById: (id) => values.get(id),
    setParameterValueById: (id, value) => values.set(id, value),
    update: () => {}
  }
  const internal = new Cubism4InternalModel()
  internal.coreModel = core
  model.internalModel = internal
  model.mouthOpenParamIds = ['ParamMouthOpenY']
  model.mouthOpenIndices = new Map([['ParamMouthOpenY', 0]])
  model.mouthParamCount = 1
  model.mouthFormParamId = null
  model.mouthFormIndex = -1
  model.mouthFormRange = null
  model.mouthUpdateHooked = false
  model.pendingMouthOpen = null
  model.setMouthOpening(0.5)
  assert.equal(values.get('ParamMouthOpenY'), 0.5)
  // 官方 Lip::None：脱手后外部（动作/表情/默认值）写入的 0.8 必须在 core.update 后保留。
  model.releaseMouth()
  values.set('ParamMouthOpenY', 0.8)
  core.update()
  assert.equal(values.get('ParamMouthOpenY'), 0.8)
})

test('the model lip-sync scale follows the game character id', async () => {
  const loader = loadAdvancedModel()
  const { AdvancedModel } = loader
  const model = Object.create(AdvancedModel.prototype)
  model._metadata = {
    model: 'resources/models/01ichika_normal/01ichika_normal_3.0_f_t04/01ichika_normal.model3.json'
  }
  assert.equal(model.inferCharacterId(), 1)
  assert.equal(model.getLipSyncScale(), 1.25)
  model._metadata = { model: 'v2_20mizuki_culture' }
  assert.equal(model.inferCharacterId(), 20)
  assert.equal(model.getLipSyncScale(), 1)
  model._metadata = { model: 'v2_07airi' }
  assert.equal(model.getLipSyncScale(), 1)
})
