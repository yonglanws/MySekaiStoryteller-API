/**
 * PLAN SNAPSHOT — 与 doc/sekai-exporter-parity-plan.md 同步维护。
 *
 * 官方待机自然动作：
 * - 眨眼：新模型 Sleep；动作开始 Sleep，非循环动作结束 Wake；|sin| 曲线 20 帧，
 *   间隔 3s±2s；第一次唤醒后立即开始。
 * - 呼吸：3s 周期、影响 0.5，每帧 2°。
 * - 口型：RMS → pow(a+1,1.75)、阈值 0.06、限幅 0.2~1、按当前值加权的平滑。
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

function loadNatural() {
  const context = vm.createContext({ console })
  const modules = new Map()
  const compiled = new Map()
  function load(target) {
    const filename = path.isAbsolute(target) ? target : path.join(renderer, target)
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
      assert.ok(name.startsWith('.'), `Unexpected platform dependency: ${name}`)
      return load(path.resolve(path.dirname(filename), `${name}.ts`))
    }
    compiled.get(filename).runInContext(context)(exports, require)
    return exports
  }
  return load('model/NaturalMotion.ts')
}

test('a fresh blink controller sleeps and a wake starts the first blink immediately', () => {
  const natural = loadNatural()
  const state = natural.createBlinkState(7)
  for (let i = 0; i < 600; i++) assert.equal(natural.stepBlink(state, 1 / 60), 1)
  assert.equal(state.status, 'sleep')
  natural.wakeBlink(state)
  natural.stepBlink(state, 1 / 60)
  assert.equal(state.status, 'closing')
  assert.ok(state.opening < 1)
})

test('one blink is 20 frames, returns to 1.0 and schedules 1~5s later', () => {
  const natural = loadNatural()
  const state = natural.createBlinkState(7)
  natural.wakeBlink(state)
  const values = []
  for (let i = 0; i < 100; i++) {
    values.push(natural.stepBlink(state, 1 / 60))
    if (state.status === 'ready') break
  }
  assert.equal(values.length, 20)
  assert.equal(values.at(-1), 1)
  const lowest = Math.min(...values)
  assert.ok(lowest > 0.05 && lowest < 0.1, `lowest ${lowest}`)
  assert.ok(state.untilTime >= 1 && state.untilTime <= 5, `until ${state.untilTime}`)
})

test('sleep during a blink finishes the blink and parks the controller', () => {
  const natural = loadNatural()
  const state = natural.createBlinkState(7)
  natural.wakeBlink(state)
  natural.stepBlink(state, 1 / 60)
  natural.stepBlink(state, 1 / 60)
  natural.sleepBlink(state)
  for (let i = 0; i < 100 && state.status !== 'sleep'; i++) natural.stepBlink(state, 1 / 60)
  assert.equal(state.status, 'sleep')
  assert.equal(state.opening, 1)
})

test('breath has a 3s cycle and 0.5 influence', () => {
  const natural = loadNatural()
  const timing = (() => {
    const context = vm.createContext({ console })
    const modules = new Map()
    const compiled = new Map()
    function load(target) {
      const filename = path.isAbsolute(target) ? target : path.join(renderer, target)
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
        assert.ok(name.startsWith('.'), `Unexpected platform dependency: ${name}`)
        return load(path.resolve(path.dirname(filename), `${name}.ts`))
      }
      compiled.get(filename).runInContext(context)(exports, require)
      return exports
    }
    return load(path.join(root, 'src/common/official/timing.ts'))
  })()
  let degree = 0
  for (let i = 0; i < 180; i++) degree = natural.advanceBreathDegree(degree, 1 / 60)
  assert.ok(Math.abs(degree - 360) < 1e-6, `degree ${degree}`)
  assert.ok(Math.abs(timing.BREATH_INFLUENCE - 0.5) < 1e-9)
  assert.ok(Math.abs(natural.breathParameterValue(90) - 0.5) < 1e-5)
  assert.ok(Math.abs(natural.breathParameterValue(270) - 0) < 1e-5)
})

test('official lip curve thresholds, clamps and smoothing', () => {
  const natural = loadNatural()
  const timing = (() => {
    const context = vm.createContext({ console })
    const modules = new Map()
    const compiled = new Map()
    function load(target) {
      const filename = path.isAbsolute(target) ? target : path.join(renderer, target)
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
        assert.ok(name.startsWith('.'), `Unexpected platform dependency: ${name}`)
        return load(path.resolve(path.dirname(filename), `${name}.ts`))
      }
      compiled.get(filename).runInContext(context)(exports, require)
      return exports
    }
    return load(path.join(root, 'src/common/official/timing.ts'))
  })()
  assert.ok(timing.LIP_LEVELS.length > 30)
  assert.equal(timing.lipTargetFromRms(0), 0)
  assert.ok(Math.abs(timing.lipTargetFromRms(0.2) - 0.275) < 0.01)
  assert.equal(timing.lipTargetFromRms(10), 1)
  assert.equal(timing.smoothLipValue(1, 0), 0.6)
  assert.equal(timing.smoothLipValue(0.5, 0.5), 0.5)
})
