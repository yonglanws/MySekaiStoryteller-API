import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'

const sourcePath = path.join(
  process.cwd(),
  'src/renderer/src/managers/video-export/FrameInterpolator.ts'
)

function loadFrameInterpolator() {
  const source = fs.readFileSync(sourcePath, 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: sourcePath
  }).outputText
  const mod = { exports: {} }
  new Function('exports', 'module', 'require', compiled)(mod.exports, mod, () => ({}))
  return mod.exports.FrameInterpolator
}

function makeModel(params) {
  const values = params.slice()
  return {
    values,
    internalModel: {
      coreModel: {
        getParameterCount: () => values.length,
        getParameterValueByIndex: (i) => values[i],
        setParameterValueByIndex: (i, value) => {
          values[i] = value
        }
      }
    },
    position: {
      x: 0,
      y: 0,
      set(x, y) {
        this.x = x
        this.y = y
      }
    },
    scale: {
      x: 1,
      y: 1,
      set(x, y) {
        this.x = x
        this.y = y
      }
    },
    rotation: 0,
    alpha: 1,
    visible: true,
    filters: [{ alpha: 1 }]
  }
}

test('FrameInterpolator lerps continuous parameters/transforms and restores the base+1 snapshot', () => {
  const FrameInterpolator = loadFrameInterpolator()
  const model = makeModel([0, 10])
  const app = {
    storyManager: { storyData: { models: [{ id: 1 }] } },
    getModelById: () => model
  }
  const interpolator = new FrameInterpolator(app, { warn: () => {} })
  assert.equal(interpolator.active, true)

  const from = interpolator.snapshot()
  model.values[0] = 10
  model.values[1] = 20
  model.position.set(100, 50)
  model.scale.set(2, 2)
  model.alpha = 0.5
  model.filters[0].alpha = 0.25
  const to = interpolator.snapshot()

  interpolator.apply(from, to, 0.4)
  assert.ok(Math.abs(model.values[0] - 4) < 1e-6)
  assert.ok(Math.abs(model.values[1] - 14) < 1e-6)
  assert.ok(Math.abs(model.position.x - 40) < 1e-6)
  assert.ok(Math.abs(model.position.y - 20) < 1e-6)
  assert.ok(Math.abs(model.scale.x - 1.4) < 1e-6)
  assert.ok(Math.abs(model.alpha - 0.8) < 1e-6)
  assert.ok(Math.abs(model.filters[0].alpha - 0.7) < 1e-6)
  assert.equal(model.visible, true, 'stepwise values stay at the base frame')

  interpolator.restore(to)
  assert.deepEqual(model.values, [10, 20])
  assert.equal(model.position.x, 100)
  assert.equal(model.position.y, 50)
  assert.equal(model.scale.x, 2)
  assert.equal(model.alpha, 0.5)
  assert.equal(model.filters[0].alpha, 0.25)
})

test('FrameInterpolator reports unavailable core index access instead of corrupting state', () => {
  const FrameInterpolator = loadFrameInterpolator()
  const model = { position: { x: 0, y: 0 }, alpha: 1, filters: [] }
  const app = {
    storyManager: { storyData: { models: [{ id: 1 }] } },
    getModelById: () => model
  }
  let warned = 0
  const interpolator = new FrameInterpolator(app, { warn: () => warned++ })
  assert.equal(interpolator.active, false)
  interpolator.logUnavailableOnce()
  interpolator.logUnavailableOnce()
  assert.equal(warned, 1)
})
