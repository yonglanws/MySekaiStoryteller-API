/**
 * PLAN SNAPSHOT — 与 doc/moesekai-parity-plan.md 同步维护。
 *
 * 问题 2：角色入场一瞬间站桩。
 * 旧 LayoutAppearSnippet 先 show(200) 淡入，再 await startMotions(冷加载)，
 * 加载期间角色已经可见但仍是默认站姿；动作启动后又 await waitForMotionsFinished
 * 等完整剪辑（平均 2.3s），远超 800ms 的入场预算。
 *
 * 这个测试锁死：
 * 1. startMotions 必须在 show/move 之前完成（模型 alpha=0 时启动动作）；
 * 2. 入场只等转场，不再 waitForMotionsFinished；
 * 3. 没有 motion/facial 时走 startEntryMotion 兜底，不能站桩。
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
  const context = vm.createContext({ console, AbortController })
  class Logger {
    info() {}
    error() {}
    debug() {}
    warn() {}
    getSubLogger() {
      return this
    }
  }
  const mocks = new Map([
    [path.join(renderer, 'utils/Logger.ts'), { default: () => new Logger() }],
    [
      path.join(root, 'src/common/types/Story.ts'),
      {
        MoveSpeed: { Slow: 'Slow', Normal: 'Normal', Fast: 'Fast', Immediate: 'Immediate' },
        Sides: { Center: 'Center', Left: 'Left', Right: 'Right' },
        LayoutModes: { Normal: 'Normal', Three: 'Three' }
      }
    ],
    [
      path.join(renderer, 'managers/AnimationManager.ts'),
      {
        default: {
          delay: async () => {},
          linear: async (_animation, _ms) => {},
          exportSpeedMultiplier: 1
        }
      }
    ],
    [
      path.join(renderer, 'utils/StageUtils.ts'),
      {
        default: {
          side_to_position(side) {
            return { x: side === 'Left' ? 0.3 : side === 'Right' ? 0.7 : 0.5, y: 0.5 }
          },
          move_speed_to_num() {
            return 500
          }
        }
      }
    ]
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
      const resolved = path.resolve(path.dirname(filename), `${name}.ts`)
      if (mocks.has(resolved)) return mocks.get(resolved)
      return load(resolved)
    }
    compiled.get(filename).runInContext(context)(exports, require)
    return exports
  }
  return { load }
}

function makeModel(calls, gate) {
  return {
    internalModel: {
      parallelMotionManager: [
        { stopAllMotions: () => calls.push('stopAll') },
        { stopAllMotions: () => calls.push('stopAllFacial') }
      ]
    },
    setPositionRel() {
      calls.push('setPositionRel')
    },
    hasMotion(name) {
      return Boolean(name) && name !== 'missing-motion'
    },
    async startMotions(motion, facial) {
      calls.push(`startMotions:begin:${motion || ''}:${facial || ''}`)
      if (gate) await gate
      calls.push('startMotions:done')
    },
    async startEntryMotion(applyDefaultFacial = true) {
      calls.push(applyDefaultFacial ? 'entryFacial:default' : 'entryFacial:keep')
      calls.push('startEntryMotion:begin')
      if (gate) await gate
      calls.push('startEntryMotion:done')
    },
    async show() {
      calls.push('show')
    },
    async hide() {
      calls.push('hide')
    },
    async move() {
      calls.push('move')
    },
    startBodyIdleLoop() {
      calls.push('startBodyIdleLoop')
    },
    async waitForMotionsFinished() {
      calls.push('waitForMotionsFinished')
    }
  }
}

function makeApp(model, calls = [], visible = false) {
  return {
    stage_size: [1920, 1080],
    getModelById: () => model,
    layerModel: {
      layoutMode: 'Normal',
      isModelVisible: () => visible,
      addModelToLayer: () => {},
      removeModel: () => calls.push('removeModel')
    }
  }
}

function appearData(overrides = {}) {
  return {
    type: 'LayoutAppear',
    wait: true,
    delay: 0,
    data: {
      modelId: 1,
      from: { side: 'Left', offset: 0 },
      to: { side: 'Left', offset: 0 },
      motion: 'w-normal-nod01',
      facial: 'face_normal_01',
      facialFirst: true,
      moveSpeed: 'Normal',
      hologram: false,
      ...overrides
    }
  }
}

test('LayoutAppear starts the entry motion before the model becomes visible', async () => {
  const f = fixture()
  const calls = []
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const model = makeModel(calls, gate)
  const LayoutAppearSnippet = f.load('snippets/LayoutAppearSnippet.ts').default
  const run = new LayoutAppearSnippet(makeApp(model), appearData()).runSnippet()

  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(
    calls.some((call) => call.startsWith('startMotions:begin')),
    calls.join(',')
  )
  assert.ok(!calls.includes('show'), `show must wait for motion: ${calls.join(',')}`)

  release()
  await run
  assert.ok(
    calls.indexOf('startMotions:done') < calls.indexOf('show'),
    `motion must finish starting before show: ${calls.join(',')}`
  )
  assert.equal(calls.includes('waitForMotionsFinished'), false, '入场只等转场，不等整段动作')
  assert.equal(calls[calls.length - 1], 'startBodyIdleLoop')
})

test('LayoutAppear falls back to startEntryMotion when the script has no motion', async () => {
  const f = fixture()
  const calls = []
  const model = makeModel(calls, null)
  const LayoutAppearSnippet = f.load('snippets/LayoutAppearSnippet.ts').default
  await new LayoutAppearSnippet(makeApp(model), appearData({ motion: '', facial: '' })).runSnippet()
  assert.ok(calls.includes('startEntryMotion:done'), calls.join(','))
  assert.ok(
    calls.indexOf('startEntryMotion:done') < calls.indexOf('show'),
    `entry motion before show: ${calls.join(',')}`
  )
})

test('LayoutAppear replaces an invalid script motion with the model fallback', async () => {
  const f = fixture()
  const calls = []
  const model = makeModel(calls, null)
  const LayoutAppearSnippet = f.load('snippets/LayoutAppearSnippet.ts').default
  await new LayoutAppearSnippet(
    makeApp(model),
    appearData({ motion: 'missing-motion', facial: '' })
  ).runSnippet()
  assert.ok(calls.includes('startEntryMotion:done'), calls.join(','))
  assert.ok(calls.includes('entryFacial:default'), calls.join(','))
  assert.ok(!calls.some((call) => call.includes('missing-motion')), calls.join(','))
})

test('LayoutAppear keeps a valid facial when only the body motion is invalid', async () => {
  const f = fixture()
  const calls = []
  const model = makeModel(calls, null)
  const LayoutAppearSnippet = f.load('snippets/LayoutAppearSnippet.ts').default
  await new LayoutAppearSnippet(
    makeApp(model),
    appearData({ motion: 'missing-motion', facial: 'face_smile_01' })
  ).runSnippet()
  assert.ok(calls.includes('startEntryMotion:done'), calls.join(','))
  assert.ok(calls.includes('entryFacial:keep'), calls.join(','))
  assert.ok(
    calls.some((call) => call.includes('face_smile_01')),
    '合法表情应先由 startMotions 应用'
  )
})

test('LayoutAppear moves only after the entry motion has started', async () => {
  const f = fixture()
  const calls = []
  const model = makeModel(calls, null)
  const LayoutAppearSnippet = f.load('snippets/LayoutAppearSnippet.ts').default
  await new LayoutAppearSnippet(
    makeApp(model),
    appearData({
      from: { side: 'Left', offset: 0 },
      to: { side: 'Center', offset: 0 }
    })
  ).runSnippet()
  assert.ok(calls.indexOf('startMotions:done') < calls.indexOf('show'))
  assert.ok(calls.indexOf('startMotions:done') < calls.indexOf('move'))
})

test('LayoutClear starts the exit motion before fading and never waits the full clip', async () => {
  const f = fixture()
  const calls = []
  const model = makeModel(calls, null)
  const LayoutClearSnippet = f.load('snippets/LayoutClearSnippet.ts').default
  await new LayoutClearSnippet(makeApp(model, calls, true), {
    type: 'LayoutClear',
    wait: true,
    delay: 0,
    data: {
      modelId: 1,
      from: { side: 'Left', offset: 0 },
      to: { side: 'Left', offset: 0 },
      motion: 'w-normal-nod01',
      facial: 'face_normal_01',
      fadeOut: true,
      moveSpeed: 'Slow'
    }
  }).runSnippet()
  assert.ok(calls.indexOf('startMotions:done') < calls.indexOf('hide'))
  assert.equal(calls.includes('waitForMotionsFinished'), false)
  assert.equal(calls[calls.length - 1], 'removeModel')
})

test('LayoutClear of a hidden character finishes immediately', async () => {
  const f = fixture()
  const calls = []
  const model = makeModel(calls, null)
  const LayoutClearSnippet = f.load('snippets/LayoutClearSnippet.ts').default
  await new LayoutClearSnippet(makeApp(model, calls, false), {
    type: 'LayoutClear',
    wait: true,
    delay: 0,
    data: {
      modelId: 1,
      from: { side: 'Left', offset: 0 },
      to: { side: 'Right', offset: 0 },
      moveSpeed: 'Slow'
    }
  }).runSnippet()
  assert.deepEqual(calls, ['removeModel'])
})

test('Move starts its motion with the slide and continues without waiting the clip', async () => {
  const f = fixture()
  const calls = []
  const model = makeModel(calls, null)
  const MoveSnippet = f.load('snippets/MoveSnippet.ts').default
  await new MoveSnippet(makeApp(model), {
    type: 'Move',
    wait: true,
    delay: 0,
    data: {
      modelId: 1,
      from: { side: 'Left', offset: 0 },
      to: { side: 'Center', offset: 0 },
      motion: 'w-normal-nod01',
      facial: 'face_normal_01',
      moveSpeed: 'Normal'
    }
  }).runSnippet()
  assert.ok(calls.indexOf('startMotions:done') < calls.indexOf('move'))
  assert.equal(calls.includes('waitForMotionsFinished'), false)
})
