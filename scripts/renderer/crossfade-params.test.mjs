/**
 * 参数级交叉淡化回归。
 *
 * `AdvancedModel.startCharacterChannel` 只负责算 fadeMs；真正让旧 clip 淡出的是
 * `installCrossfade` 对依赖 `ParallelMotionManager._startMotion` 的覆盖。
 * 这里直接调用覆盖后的方法，锁死：
 * - 新 clip setFadeInTime(fade)，旧 entry setFadeOut(fade)；
 * - 不再触发依赖内部的 queueManager.stopAllMotions()；
 * - 身体/表情通道分别用 0.5/0.25；
 * - ignoreParamIds 在 Cubism 4 curves 与 Cubism 2 motions 两种结构上都生效；
 * - startMotion 抛错时回退到原 _startMotion。
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

function loadAdvancedModel() {
  const context = vm.createContext({
    console,
    performance: { now: () => 1000 },
    Date,
    setTimeout,
    clearTimeout,
    AbortController
  })
  class Logger {
    info() {}
    error() {}
    debug() {}
    warn() {}
  }
  class Live2DModel {
    destroy() {}
  }
  class Cubism2InternalModel {}
  class Cubism4InternalModel {}
  class AlphaFilter {
    constructor(alpha) {
      this.alpha = alpha
    }
  }
  class VisualEffectManager {}
  const mocks = new Map([
    [
      'pixi-live2d-display-advanced',
      { Live2DModel, Cubism2InternalModel, Cubism4InternalModel, MotionPriority: { FORCE: 3 } }
    ],
    ['pixi.js', { AlphaFilter }],
    [path.join(renderer, 'utils/Logger.ts'), { default: () => new Logger() }],
    [
      path.join(renderer, 'managers/AnimationManager.ts'),
      {
        default: {
          linear: async () => {},
          delay: async () => {},
          in_ticker: async () => {},
          isExporting: () => true
        }
      }
    ],
    [path.join(renderer, 'managers/VisualEffectManager.ts'), { VisualEffectManager }]
  ])
  const modules = new Map()
  const compiled = new Map()
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
  return load('model/AdvancedModel.ts').default
}

function makeQueue() {
  const entries = [
    {
      setFadeOut(seconds) {
        entries[0].fadeOut = seconds
      }
    },
    {
      setFadeOut(seconds) {
        entries[1].fadeOut = seconds
      }
    }
  ]
  const calls = []
  return {
    entries,
    calls,
    queueManager: {
      _motions: entries,
      startMotion(motion, autoDelete, now) {
        calls.push({ motion, autoDelete, now })
        return 42
      }
    }
  }
}

test('crossfade override sets fade-in/out and skips stopAllMotions', () => {
  const AdvancedModel = loadAdvancedModel()
  const body = makeQueue()
  const manager = {
    queueManager: body.queueManager,
    _startMotion() {
      throw new Error('fallback must not run')
    }
  }
  const model = Object.create(AdvancedModel.prototype)
  model.channelFadeSeconds = [0.5, 0.25]
  model.logger = { warn() {} }
  model.internalModel = { parallelMotionManager: [manager, manager] }

  model.installCrossfade(0)
  let fadeIn = null
  let finished = null
  const motion = {
    setFadeInTime(seconds) {
      fadeIn = seconds
    },
    setFinishedMotionHandler(handler) {
      finished = handler
    },
    _motionData: {
      curves: [{ id: 'ParamEyeLOpen' }, { id: 'ParamMouthOpenY' }, { id: 'ParamAngleX' }]
    }
  }
  const onFinish = () => {}
  const handle = manager._startMotion(motion, onFinish, ['ParamMouthOpenY'])
  assert.equal(handle, 42)
  assert.equal(fadeIn, 0.5)
  assert.deepEqual(body.calls[0].autoDelete, false)
  assert.equal(body.entries[0].fadeOut, 0.5, '旧 entry 必须与新 clip 同步淡出')
  assert.equal(body.entries[1].fadeOut, undefined, '新 entry 不设置 fadeOut')
  assert.equal(finished, onFinish)
  assert.deepEqual(
    motion._motionData.curves.map((curve) => curve.id),
    ['ParamEyeLOpen', 'ParamAngleX']
  )
  assert.equal(motion._motionData.curveCount, 2)
})

test('crossfade override handles Cubism 2 motions arrays and facial 0.25', () => {
  const AdvancedModel = loadAdvancedModel()
  const queue = makeQueue()
  const manager = { queueManager: queue.queueManager, _startMotion() {} }
  const model = Object.create(AdvancedModel.prototype)
  model.channelFadeSeconds = [0.5, 0.25]
  model.logger = { warn() {} }
  model.internalModel = { parallelMotionManager: [manager, manager] }

  model.installCrossfade(1)
  const motion = {
    setFadeInTime() {},
    motions: [{ _$4P: 'PARAM_EYE_L_OPEN' }, { _$4P: 'PARAM_MOUTH_OPEN_Y' }]
  }
  manager._startMotion(motion, undefined, ['PARAM_EYE_L_OPEN'])
  assert.deepEqual(
    motion.motions.map((item) => item._$4P),
    ['PARAM_MOUTH_OPEN_Y']
  )
  assert.equal(queue.entries[0].fadeOut, 0.25)
})

test('crossfade override falls back to the original _startMotion on failure', () => {
  const AdvancedModel = loadAdvancedModel()
  const manager = {
    queueManager: {
      _motions: [],
      startMotion() {
        throw new Error('queue failure')
      }
    },
    fallbackArgs: null,
    _startMotion(motion, onFinish, ignore) {
      manager.fallbackArgs = { motion, onFinish, ignore }
      return 7
    }
  }
  const model = Object.create(AdvancedModel.prototype)
  model.channelFadeSeconds = [0.5, 0.25]
  model.logger = { warn() {} }
  model.internalModel = { parallelMotionManager: [manager, manager] }

  model.installCrossfade(0)
  const motion = { setFadeInTime() {} }
  const onFinish = () => {}
  const handle = manager._startMotion(motion, onFinish, ['x'])
  assert.equal(handle, 7)
  assert.equal(manager.fallbackArgs.motion, motion)
  assert.equal(manager.fallbackArgs.onFinish, onFinish)
  assert.deepEqual(manager.fallbackArgs.ignore, ['x'])
})
