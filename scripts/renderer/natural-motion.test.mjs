/**
 * PLAN SNAPSHOT — 与 doc/sekai-exporter-parity-plan.md 同步维护。
 *
 * 官方待机自然动作：
 * - 眨眼：新模型 Sleep；动作开始 Sleep，非循环动作结束 Wake；四段线性相位
 *   闭眼 0.1s / 全闭 0.05s / 睁眼 0.15s（Timescale=10），间隔 3s±2s；
 *   第一次唤醒后立即开始，全闭相位保证至少 1 帧完全合眼。
 * - 呼吸：3s 周期、影响 0.5，每帧 2°。
 * - 口型：官方 RMS 曲线裸输出（pow(a+1,1.75)、阈值 0.06、上限 1，无下限放宽、
 *   无 smoothLipValue 低通）+ 每句 p95 响度归一（只放大不衰减、增益 ≤2.4），
 *   直入 AdvLipSyncPolicy fallback 原值（attack/release/hold、轻声保底 minSpeech
 *   0.17、onset 0.13、张幅上限 0.88），音频后 450ms 指数释放尾。
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
  // ournotes 官方 fallback 原值（lipsync.js:28-30）逐位锁定。
  // 模块经 vm 加载，对象原型跨 realm，deepStrictEqual 会因原型不同误报；逐字段比较。
  const expectedPreset = {
    attack: 0.032,
    release: 0.1,
    hold: 0.06,
    hfs: 0.022,
    speakingThr: 0.026,
    silenceFloor: 0.015,
    speechFloor: 0.11,
    minSpeech: 0.17,
    onset: 0.13,
    openScale: 1.03,
    comp: 0.07,
    openCap: 0.88,
    formOpenSupp: 0,
    formScale: 1,
    baseToDefault: 0
  }
  for (const [key, value] of Object.entries(expectedPreset)) {
    assert.equal(timing.MOUTH_SYNC_FALLBACK_PRESET[key], value, `preset.${key}`)
  }
  assert.deepEqual(
    Object.keys(timing.MOUTH_SYNC_FALLBACK_PRESET).sort(),
    Object.keys(expectedPreset).sort(),
    'preset 字段集合与官方 fallback 表一致'
  )
  assert.equal(timing.LIP_RMS_MIN_VALUE, undefined, 'RMS 下限放宽已删除（minValue 传 0）')
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
  assert.ok(
    envelope.durationMs - envelope.audioDurationMs >= 440,
    'release tail is the 450ms exponential release'
  )
  assert.equal(lip.sampleLipSync(envelope, 0) < 0.5, true)
  const peak = Math.max(...envelope.values)
  assert.ok(peak > 0.6, `voice must open the mouth: peak ${peak}`)
  assert.ok(peak <= 0.88 + 1e-6, `openCap: peak ${peak}`)
  assert.ok(envelope.values.at(-1) < 0.02, `tail must close: ${envelope.values.at(-1)}`)
})

test('syllable rhythm survives the envelope: gaps reopen and the first syllable rises within 5 frames', () => {
  const lip = loadRendererModule('utils/LipSyncEnvelope.ts')
  const sampleRate = 48000
  // 5 个音节：100ms 有声 + 60ms 句内间隙（无 smoothLipValue 低通后节奏不再发黏）。
  const chunks = []
  for (let k = 0; k < 5; k++) {
    chunks.push({ ms: 100, amp: 0.45 })
    if (k < 4) chunks.push({ ms: 60, amp: 0 })
  }
  const totalMs = chunks.reduce((sum, c) => sum + c.ms, 0)
  const samples = new Float32Array(Math.round((sampleRate * totalMs) / 1000))
  let at = 0
  for (const c of chunks) {
    const n = Math.round((sampleRate * c.ms) / 1000)
    for (let i = 0; i < n; i++) {
      samples[at + i] = c.amp ? Math.sin(((at + i) / sampleRate) * 2 * Math.PI * 220) * c.amp : 0
    }
    at += n
  }
  const envelope = lip.buildLipSyncEnvelope([samples], sampleRate)
  const values = Array.from(
    envelope.values.slice(0, Math.round(envelope.audioDurationMs / envelope.frameMs))
  )
  const peak = Math.max(...values)
  // 每个句内间隙的最小开度（最坏的谷）；对比度必须与旧链路的 0.05-0.12 拉开。
  const gapMins = []
  for (let k = 0; k < 4; k++) {
    const startF = Math.round((100 * (k + 1) + 60 * k) / envelope.frameMs)
    const endF = Math.round((100 * (k + 1) + 60 * (k + 1)) / envelope.frameMs)
    gapMins.push(Math.min(...values.slice(startF, endF)))
  }
  const worstTrough = Math.max(...gapMins)
  assert.ok(
    peak - worstTrough >= 0.12,
    `syllable contrast must survive: peak ${peak.toFixed(3)} trough ${worstTrough.toFixed(3)}`
  )
  // 首音节 10-90% 上升不超过 5 帧（无低通拖尾，无单帧 pop）。
  const idx0 = values.findIndex((x) => x > 0.02)
  assert.ok(idx0 >= 0)
  const target = 0.9 * peak
  let rise = 0
  for (let i = idx0; i < values.length; i++) {
    if (values[i] >= target) {
      rise = i - idx0
      break
    }
  }
  assert.ok(rise <= 5, `first syllable must rise within 5 frames: ${rise}`)
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
  assert.ok(peak <= 0.88 + 1e-6)
  // 轻语音观感预期：gain 已顶 2.4 上限时，peak 恰好钉在 minSpeech=0.17 保底——
  // 气声台词的嘴型是恒定保底开度而非随语音起伏（official AdvCalm fallback 的
  // 行为，ournotes 同值同行为；见 doc/sekai-exporter-parity-plan.md 2026-11 节）。
  assert.ok(peak <= 0.18, `quiet voice pins at the minSpeech floor: peak ${peak}`)
})

test('silence keeps the mouth shut and text lip starts with an onset and closes at the end', () => {
  const lip = loadRendererModule('utils/LipSyncEnvelope.ts')
  const envelope = lip.buildLipSyncEnvelope([new Float32Array(4800)], 48000)
  assert.equal(Math.max(...envelope.values), 0)
  const text = lip.textLipSequence(12)
  assert.ok(text.length > 12, 'text lip appends a release tail')
  assert.ok(text[0] >= 0.13 - 1e-6, `onset: ${text[0]}`)
  // 450ms 指数尾按 33.3ms 半字步长收尾，末帧残值 <2%（无 120ms 线性收尾）。
  assert.ok(text.at(-1) < 0.02, `text tail must close: ${text.at(-1)}`)
})
