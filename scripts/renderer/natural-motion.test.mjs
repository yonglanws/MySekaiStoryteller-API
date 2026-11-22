/**
 * PLAN SNAPSHOT — 与 doc/sekai-exporter-parity-plan.md 同步维护。
 *
 * 官方待机自然动作：
 * - 眨眼：新模型 Sleep；动作开始 Sleep，非循环动作结束 Wake；四段线性相位
 *   闭眼 0.1s / 全闭 0.05s / 睁眼 0.15s（Timescale=10），间隔 3s±2s；
 *   第一次唤醒后立即开始，全闭相位保证至少 1 帧完全合眼。
 * - 呼吸：3s 周期、影响 0.5，每帧 2°。
 * - 口型：RMS → pow(a+1,1.75)、阈值 0.06、限幅 0.2~1、按当前值加权的平滑；
 *   再走 AdvCalm Fallback 策略（attack/release/hold、轻声保底、onset、张幅上限）。
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

function loadRendererModule(entry) {
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
  return load(entry)
}

function loadNatural() {
  return loadRendererModule('model/NaturalMotion.ts')
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

test('one blink is 18 frames with a fully closed phase, then schedules 1~5s later', () => {
  const natural = loadNatural()
  const state = natural.createBlinkState(7)
  natural.wakeBlink(state)
  const values = []
  for (let i = 0; i < 100; i++) {
    values.push(natural.stepBlink(state, 1 / 60))
    if (state.status === 'ready') break
  }
  // 0.1s 闭 + 0.05s 合 + 0.15s 睁 = 0.3s = 18 帧（允许 1 帧浮点取整误差）。
  assert.ok(values.length >= 17 && values.length <= 19, `frames ${values.length}`)
  assert.equal(values.at(-1), 1)
  const lowest = Math.min(...values)
  assert.equal(lowest, 0, `lowest ${lowest}`)
  assert.ok(
    values.filter((value) => value === 0).length >= 1,
    'the closed phase must hold the eyes fully shut for at least one frame'
  )
  assert.ok(state.untilTime >= 1 && state.untilTime <= 5, `until ${state.untilTime}`)
})

test('30fps sampling still reaches a fully closed frame', () => {
  const natural = loadNatural()
  const state = natural.createBlinkState(7)
  natural.wakeBlink(state)
  const values = []
  for (let i = 0; i < 100; i++) {
    values.push(natural.stepBlink(state, 1 / 30))
    if (state.status === 'ready') break
  }
  assert.ok(values.length >= 8 && values.length <= 10, `frames ${values.length}`)
  assert.equal(Math.min(...values), 0)
  assert.equal(values.at(-1), 1)
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
  assert.ok(timing.MOUTH_SYNC_FALLBACK_PRESET.openCap > 0.8)
  assert.ok(timing.MOUTH_SYNC_FALLBACK_PRESET.onset > 0.1)
  assert.ok(timing.LIP_RMS_MIN_VALUE < timing.LIP_MIN_VALUE)
})

test('voice envelope applies the calm mouth policy, caps the opening and releases after audio', () => {
  const lip = loadRendererModule('utils/LipSyncEnvelope.ts')
  const sampleRate = 48000
  const frames = Math.round(sampleRate * 0.4)
  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i++)
    samples[i] = Math.sin((i / sampleRate) * 2 * Math.PI * 220) * 0.45
  const envelope = lip.buildLipSyncEnvelope([samples], sampleRate)
  assert.ok(envelope.durationMs > envelope.audioDurationMs, 'release tail extends the envelope')
  assert.equal(lip.sampleLipSync(envelope, 0) < 0.5, true)
  const peak = Math.max(...envelope.values)
  assert.ok(peak > 0.6, `voice must open the mouth: peak ${peak}`)
  assert.ok(peak <= 0.92 + 1e-6, `openCap: peak ${peak}`)
  assert.ok(envelope.values.at(-1) < 0.02, `tail must close: ${envelope.values.at(-1)}`)
})

test('a quiet voice is loudness-normalised so the mouth still opens', () => {
  const lip = loadRendererModule('utils/LipSyncEnvelope.ts')
  const sampleRate = 48000
  const frames = Math.round(sampleRate * 0.4)
  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i++)
    samples[i] = Math.sin((i / sampleRate) * 2 * Math.PI * 220) * 0.08
  const envelope = lip.buildLipSyncEnvelope([samples], sampleRate)
  const peak = Math.max(...envelope.values)
  assert.ok(peak > 0.15, `quiet voice must still reach a visible opening: peak ${peak}`)
  assert.ok(peak <= 0.92 + 1e-6)
})

test('silence keeps the mouth shut and text lip starts with an onset and closes at the end', () => {
  const lip = loadRendererModule('utils/LipSyncEnvelope.ts')
  const envelope = lip.buildLipSyncEnvelope([new Float32Array(4800)], 48000)
  assert.equal(Math.max(...envelope.values), 0)
  const text = lip.textLipSequence(12)
  assert.ok(text.length > 12, 'text lip appends a release tail')
  assert.ok(text[0] >= 0.12 - 1e-6, `onset: ${text[0]}`)
  assert.equal(text.at(-1), 0)
})
