/**
 * ProgressBehavior=0 退场与后续入场的可见性语义。
 *
 * 官方 HideCharacter 在协程开始时就把它标记为“不在场”，随后后台淡出
 * 0.25s。若这期间同一角色又 LayoutAppear，官方按新入场处理（7 帧淡入），
 * 且旧退场协程不能把新角色淡没或移出渲染层。
 *
 * 旧实现用 alpha 判断“是否在场”，且退场协程会无条件 removeModel，
 * 导致 Appear 后角色仍被移出，后面的 Clear 变成 0ms。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const renderer = path.join(root, 'src/renderer/src')

function fixture(calls) {
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
  const gate = { release: null, released: false }
  gate.promise = new Promise((resolve) => {
    gate.release = () => {
      gate.released = true
      resolve()
    }
  })
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
          // 只让 Clear 的 150ms 延迟挂起，Appear 的 1 帧 hold 直接放行。
          async delay(ms) {
            calls.push(`delay:${ms}`)
            if (ms >= 100 && !gate.released) await gate.promise
          },
          async linear() {},
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
  return { load, gate }
}

function makeModel(calls) {
  let generation = 0
  return {
    alpha: 1,
    internalModel: { parallelMotionManager: [{}, {}] },
    beginVisibilityChange() {
      generation += 1
      return generation
    },
    currentVisibilityGeneration() {
      return generation
    },
    isVisibilityCurrent(token) {
      return token === generation
    },
    setOpacity(value) {
      this.alpha = value
      calls.push(`setOpacity:${value}`)
    },
    setPositionRel() {
      calls.push('setPositionRel')
    },
    hasMotion(name) {
      return Boolean(name)
    },
    async startMotions() {
      calls.push('startMotions')
    },
    async startEntryMotion() {
      calls.push('startEntryMotion')
    },
    async show(time, _hologram, token) {
      calls.push(`show:${time}:${token}`)
      if (token !== undefined && !this.isVisibilityCurrent(token)) return
      this.alpha = 1
    },
    async hide(time, token) {
      calls.push(`hide:${time}:${token}`)
      if (token !== undefined && !this.isVisibilityCurrent(token)) return
      this.alpha = 0
    },
    async move() {
      calls.push('move')
    },
    startBodyIdleLoop() {}
  }
}

function makeApp(model, shown, calls) {
  return {
    stage_size: [1920, 1080],
    getModelById: () => model,
    layerModel: {
      layoutMode: 'Normal',
      markModelShown(modelId) {
        const was = shown.has(modelId)
        shown.add(modelId)
        return was
      },
      markModelHidden(modelId) {
        const was = shown.has(modelId)
        shown.delete(modelId)
        return was
      },
      isModelVisible: (modelId) => shown.has(modelId),
      addModelToLayer: () => calls.push('addModelToLayer'),
      removeModel: () => {
        shown.delete(1)
        calls.push('removeModel')
      }
    }
  }
}

const appearData = {
  type: 'LayoutAppear',
  wait: true,
  delay: 0,
  data: {
    modelId: 1,
    from: { side: 'Center', offset: 0 },
    to: { side: 'Center', offset: 0 },
    motion: '',
    facial: '',
    moveSpeed: 'Normal',
    hologram: false
  }
}

const clearData = {
  type: 'LayoutClear',
  wait: true,
  delay: 0,
  data: {
    modelId: 1,
    from: { side: 'Center', offset: 0 },
    to: { side: 'Center', offset: 0 },
    moveSpeed: 'Normal'
  }
}

test('an appear during a background clear fades in and survives the stale clear', async () => {
  const calls = []
  const f = fixture(calls)
  const model = makeModel(calls)
  const shown = new Set([1])
  const app = makeApp(model, shown, calls)
  const LayoutAppearSnippet = f.load('snippets/LayoutAppearSnippet.ts').default
  const LayoutClearSnippet = f.load('snippets/LayoutClearSnippet.ts').default

  const clearing = new LayoutClearSnippet(app, clearData).runSnippet()
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(
    calls.some((call) => call === 'delay:150'),
    `clear should be waiting in its 0.15s delay: ${calls.join(',')}`
  )

  const appearing = new LayoutAppearSnippet(app, appearData).runSnippet()
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(
    calls.some((call) => call.startsWith('show:')),
    `appear must fade in while the clear is still pending: ${calls.join(',')}`
  )

  f.gate.release()
  await Promise.all([clearing, appearing])
  assert.equal(
    calls.some((call) => call.startsWith('hide:')),
    false,
    calls.join(',')
  )
  assert.equal(calls.includes('removeModel'), false, calls.join(','))
  assert.equal(shown.has(1), true, 'character must stay on stage after the stale clear')

  // 新 Appear 之后，下一次 Clear 必须按在场 0.25s 退场。
  await new LayoutClearSnippet(app, clearData).runSnippet()
  assert.ok(
    calls.some((call) => call.startsWith('hide:')),
    calls.join(',')
  )
  assert.equal(calls.includes('removeModel'), true, calls.join(','))
  assert.equal(shown.has(1), false)
})

test('a clear of a character that is already hidden finishes immediately', async () => {
  const calls = []
  const f = fixture(calls)
  const model = makeModel(calls)
  const shown = new Set()
  const app = makeApp(model, shown, calls)
  const LayoutClearSnippet = f.load('snippets/LayoutClearSnippet.ts').default
  await new LayoutClearSnippet(app, clearData).runSnippet()
  assert.equal(calls.includes('removeModel'), true, calls.join(','))
  assert.equal(
    calls.some((call) => call.startsWith('hide:')),
    false,
    calls.join(',')
  )
})
