/**
 * PLAN SNAPSHOT — 与 doc/sekai-exporter-parity-plan.md 同步维护。
 *
 * 官方 scenario 的 BlackOut/BlackIn duration 是秒（0.5），本项目内部特效片段用毫秒。
 * 旧实现把 0.5 直接传给 AnimationManager，黑幕 0.5ms 就结束，成片比时间线短 500ms。
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
const roundForTest = (value) => Math.round(value * 1000) / 1000

function loadEffect() {
  let now = 0
  const delays = []
  const context = vm.createContext({ console, performance: { now: () => now } })
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
      path.join(renderer, 'managers/AnimationManager.ts'),
      {
        default: {
          delay: async (ms) => {
            delays.push(ms)
          },
          linear: async () => {}
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
      return load(path.resolve(path.dirname(filename), `${name}.ts`))
    }
    compiled.get(filename).runInContext(context)(exports, require)
    return exports
  }
  load.delays = delays
  load.setNow = (value) => {
    now = value
  }
  return load
}

function appWith(record) {
  return {
    layerSpecialEffect: {
      async fadeOut(ms) {
        record.push(ms)
      },
      async fadeIn(ms) {
        record.push(ms)
      }
    }
  }
}

test('BlackOut/BlackIn accept official seconds and project milliseconds', async () => {
  const load = loadEffect()
  const BlackOut = load('snippets/BlackOutSnippet.ts').default
  const BlackIn = load('snippets/BlackInSnippet.ts').default
  const record = []

  await new BlackOut(appWith(record), {
    type: 'BlackOut',
    wait: true,
    delay: 0,
    data: { duration: 0.5, color: 'black' }
  }).runSnippet()
  await new BlackOut(appWith(record), {
    type: 'BlackOut',
    wait: true,
    delay: 0,
    data: { duration: 500, color: 'black' }
  }).runSnippet()
  await new BlackOut(appWith(record), {
    type: 'BlackOut',
    wait: true,
    delay: 0,
    data: { duration: 0.1, color: 'black' }
  }).runSnippet()
  await new BlackOut(appWith(record), {
    type: 'BlackOut',
    wait: true,
    delay: 0,
    data: { duration: 100, color: 'black' }
  }).runSnippet()
  await new BlackIn(appWith(record), {
    type: 'BlackIn',
    wait: true,
    delay: 0,
    data: { duration: 0.25, color: 'white' }
  }).runSnippet()
  await new BlackIn(appWith(record), {
    type: 'BlackIn',
    wait: true,
    delay: 0,
    data: { duration: 250, color: 'white' }
  }).runSnippet()

  assert.deepEqual(record, [500, 500, 100, 100, 250, 250])
})

test('exportActWallMs waits to the absolute act instead of replaying the full delay after a fence', async () => {
  const load = loadEffect()
  const BlackOut = load('snippets/BlackOutSnippet.ts').default
  load.setNow(2500)
  const snippet = new BlackOut(appWith([]), {
    type: 'BlackOut',
    wait: true,
    delay: 1,
    data: { duration: 3, color: 'black' }
  })
  // 片段在 actWall 前 2500ms 才拿到执行权；前置栅栏此时已经消耗了 1s，
  // 若仍按 data.delay=1000 等，就会比 plan act 晚 1s。
  snippet.exportActWallMs = 5000
  await snippet.runSnippet()
  assert.equal(load.delays.length, 1)
  assert.equal(roundForTest(load.delays[0]), 2499.999)
})

test('TimelineCalculator preserves duration=0 for instant BlackOut/BlackIn instead of 600ms default', () => {
  const load = loadEffect()
  const { calculateTimeline } = load('utils/TimelineCalculator.ts')
  const result = calculateTimeline([
    { type: 'BlackOut', wait: true, delay: 0, data: { duration: 0, color: 'black' } },
    { type: 'BlackIn', wait: true, delay: 0, data: { duration: 0, color: 'black' } }
  ])
  assert.equal(result.entries[0].durationMs, 0)
  assert.equal(result.entries[1].durationMs, 0)
})
