/**
 * PLAN SNAPSHOT — 与 doc/moesekai-parity-plan.md 同步维护。
 *
 * 动作追踪是导出日志的核心：每个 cue 的 request → loaded → started，
 * 以及上一段动作被下一 cue 打断时的 playedMs/clipDurationMs。
 * 这些数据用来证明“动作切换忽快忽慢”不是加载延迟或等待整段剪辑造成的。
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

function fixture() {
  const context = vm.createContext({
    console,
    performance: { now: () => Date.now() },
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
    getSubLogger() {
      return this
    }
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
  class VisualEffectManager {
    createAll() {}
    applyEffect() {}
    disableAll() {}
  }
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
  return { load }
}

function makeBodyManager() {
  const manager = {
    playing: false,
    finished: true,
    state: { setReserved() {} },
    stopCalls: 0,
    stopAllMotions() {
      manager.stopCalls++
    },
    async startMotion() {
      manager.playing = true
      manager.finished = false
      return true
    },
    isFinished() {
      return manager.finished
    }
  }
  return manager
}

test('AdvancedModel records request/loaded/started/interrupted with clip duration', async (t) => {
  const f = fixture()
  const { default: AdvancedModel } = f.load('model/AdvancedModel.ts')
  const { motionTrace } = f.load('managers/video-export/MotionTraceCollector.ts')
  motionTrace.reset()

  const body = makeBodyManager()
  const facial = makeBodyManager()
  const model = Object.create(AdvancedModel.prototype)
  model._metadata = { id: 7 }
  model.destroyed = false
  model.actionController = new AbortController()
  model.channelGeneration = [0, 0]
  model.bodyChainArmed = false
  model.bodyChainGeneration = -1
  model.bodyChainTimer = null
  model.recentBodyMotions = []
  model.bodyIgnoredParamIds = []
  model.currentBodyMotion = null
  model.currentBodyStartedAt = 0
  model.currentBodyClipDurationMs = 0
  model.bodyFinishReported = true
  model.channelFadeSeconds = [0.5, 0.25]
  model.facialForceNext = false
  model.firstBodyCue = true
  model.defaultMotionName = null
  model.blinkState = { status: 'ready', doSleep: false, opening: 1 }
  model.internalModel = {
    parallelMotionManager: [body, facial],
    motionManager: {
      async loadMotion(name) {
        return {
          getDuration: () => 2.6,
          name
        }
      }
    }
  }
  model.logger = { info() {}, warn() {}, error() {}, debug() {} }

  await model.startCharacterChannel(0, 'w-normal-nod01', [], undefined, undefined, true)
  let events = Array.from(motionTrace.snapshot())
  assert.deepEqual(
    events.map((event) => event.event),
    ['request', 'loaded', 'started']
  )
  assert.equal(events[2].name, 'w-normal-nod01')
  assert.equal(events[2].clipDurationMs, 2600)
  assert.equal(events[2].snippetIndex, -1, '没有活动 snippet 时带 -1')
  assert.equal(events[2].fadeMs, 0, '新模型第一段 clip 没有旧姿势可混合')
  assert.equal(body.stopCalls, 0, '动作切换不能先 stopAllMotions')

  // 第一段还在播时来第二 cue：必须记录 interrupted，playedMs 可计算。
  body.playing = true
  body.finished = false
  await model.startCharacterChannel(0, 'w-cute-smile01', [], undefined, undefined, true, 42)
  events = Array.from(motionTrace.snapshot())
  const interrupted = events.find((event) => event.event === 'interrupted')
  assert.ok(interrupted, JSON.stringify(events))
  assert.equal(interrupted.name, 'w-normal-nod01')
  assert.ok(interrupted.playedMs >= 0)
  assert.equal(interrupted.clipDurationMs, 2600)

  const started = events.filter((event) => event.event === 'started')
  assert.deepEqual(
    started.map((event) => event.name),
    ['w-normal-nod01', 'w-cute-smile01']
  )
  assert.equal(started[1].fadeMs, 500, '不同类别动作使用 0.5s 交叉淡化')
  assert.equal(started[1].snippetIndex, 42, '显式 index 覆盖异步上下文，后台 cue 也能正确归因')
  assert.equal(interrupted.snippetIndex, 42)
  assert.equal(body.stopCalls, 0, '整个切换过程都没有清空旧动作')
})
