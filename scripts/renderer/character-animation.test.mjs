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
  return { AdvancedModel: load('model/AdvancedModel.ts').default, load, frames }
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

test('move lands exactly on the destination in both axes', async () => {
  const loader = loadAdvancedModel()
  const { model } = makeModel(loader)
  // 参考宽 1000：Left = 200px，Right = 800px。
  await model.move([1000, 1000], { x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }, 500)
  assert.equal(model.position.x, 800)
  assert.equal(model.position.y, 800)
})

test('move x samples the OutQuad curve at each frame', async () => {
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
  // 期望：p=0 → 200；0.25 → 462.5；0.5 → 650；0.75 → 762.5；1 → 800。
  for (const [i, expected] of [200, 462.5, 650, 762.5, 800].entries()) {
    assert.ok(
      Math.abs((xs[i] ?? Number.NaN) - expected) < 1e-6,
      `sample ${i}: expected ${expected}, got ${xs[i]} (${xs.join(',')})`
    )
  }
  assert.ok(xs[2] > 500, 'OutQuad is past the linear midpoint at 50% time')
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
