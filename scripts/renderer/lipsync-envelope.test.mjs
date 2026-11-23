/**
 * PLAN SNAPSHOT — 与 doc/sekai-exporter-parity-plan.md「口型按 sse-bake lipsync.rs
 * 重写」一节同步维护。
 *
 * 锁定 `Lip::Voice` / `Lip::Text` 的移植性质：
 * 1. RMS 窗口是「结束于当前步时刻的最后一帧样本」（48k/60 = 800 个），
 *    与 1kHz 下 `[k·rate/60 − rate/60, k·rate/60)` 的样本一一对应；
 * 2. 只有官方三档 smooth()，没有 p95 响度归一、没有上限 0.88、没有轻声保底；
 * 3. 样本放完 / 文本收尾后平滑到 <0.001 才脱手（`releaseStep`）；
 * 4. 按步号取值，不插值：30fps 抽样与 60fps 同一故事步逐值相等；
 * 5. 文本口型：一个半字 = 2 个相同 target 的 60Hz 步，slot = {index,total}。
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

const sampleRate = 48000
const STEP_MS = 1000 / 60

function loadTiming() {
  return loadRendererModule(path.join(root, 'src/common/official/timing.ts'))
}

function sineSentence({ bursts = 5, burstMs = 100, gapMs = 60, amp = 0.45, tailSilenceMs = 0 }) {
  const chunks = []
  for (let k = 0; k < bursts; k++) {
    chunks.push({ ms: burstMs, amp })
    if (k < bursts - 1) chunks.push({ ms: gapMs, amp: 0 })
  }
  if (tailSilenceMs > 0) chunks.push({ ms: tailSilenceMs, amp: 0 })
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
  return { samples, totalMs }
}

test('the RMS window is the last frame of samples ending at each step', () => {
  const lip = loadRendererModule('utils/LipSyncEnvelope.ts')
  const timing = loadTiming()
  // 1kHz：stepSamples = floor(1000/60) = 16，end = floor(k×1000/60)。
  const rate = 1000
  const samples = new Float32Array(400)
  // step 2 的窗口是 [17, 33)：样本 17..32 置 0.2，其余为 0。
  for (let i = 17; i < 33; i++) samples[i] = 0.2
  const envelope = lip.buildLipSyncEnvelope([samples], rate)
  const target = timing.lipTargetFromRms(0.2)
  assert.ok(Math.abs(envelope.values[2] - 0.6 * target) < 1e-6, `step 2 ${envelope.values[2]}`)
  // step 1 的窗口 [0, 16) 全 0；step 3 的窗口 [34, 50) 全 0，只剩 smooth 释放。
  assert.equal(envelope.values[1], 0)
  assert.ok(envelope.values[3] < envelope.values[2], `step 3 ${envelope.values[3]}`)
  assert.ok(
    Math.abs(envelope.values[3] - timing.smoothLipValue(0, envelope.values[2])) < 1e-6,
    'step 3 only carries the smooth release'
  )
  // 窗口外的样本不影响取值。
  const shifted = new Float32Array(samples)
  shifted[16] = 1
  shifted[33] = 1
  const other = lip.buildLipSyncEnvelope([shifted], rate)
  assert.equal(other.values[2], envelope.values[2])
  assert.equal(other.values[3], envelope.values[3])
  // 窗口内的样本决定取值。
  const louder = new Float32Array(samples)
  for (let i = 17; i < 33; i++) louder[i] = 0.4
  const louderEnvelope = lip.buildLipSyncEnvelope([louder], rate)
  assert.ok(louderEnvelope.values[2] > envelope.values[2])
})

test('a 450ms silence between sentences closes the mouth', () => {
  const lip = loadRendererModule('utils/LipSyncEnvelope.ts')
  const first = sineSentence({})
  const second = sineSentence({})
  const samples = new Float32Array(
    first.samples.length + Math.round(sampleRate * 0.45) + second.samples.length
  )
  samples.set(first.samples, 0)
  samples.set(second.samples, first.samples.length + Math.round(sampleRate * 0.45))
  const envelope = lip.buildLipSyncEnvelope([samples], sampleRate)
  const values = Array.from(envelope.values)
  const gapStartF = Math.round((first.totalMs + 20) / envelope.frameMs)
  const gapEndF = Math.round((first.totalMs + 430) / envelope.frameMs)
  const gapMin = Math.min(...values.slice(gapStartF, gapEndF))
  assert.ok(gapMin < 0.001, `long inter-sentence gap must close: gapMin ${gapMin.toFixed(6)}`)
})

test('the envelope detaches once the samples end and the mouth has closed', () => {
  const lip = loadRendererModule('utils/LipSyncEnvelope.ts')
  const { samples } = sineSentence({})
  const envelope = lip.buildLipSyncEnvelope([samples], sampleRate)
  const durationFrames = envelope.values.length
  assert.equal(envelope.releaseStep, durationFrames - 1)
  // 脱手帧写 0；前一帧是平滑后的残值。
  assert.equal(envelope.values[envelope.releaseStep], 0)
  assert.ok(envelope.values[envelope.releaseStep - 1] >= 0.0005)
  // 脱手后再采样没有任何值（调用方据此 releaseMouth）。
  assert.equal(lip.sampleLipSync(envelope, envelope.durationMs), 0)
  assert.equal(lip.sampleLipSync(envelope, envelope.durationMs + 1000), 0)
  // 释放长度与 smooth() 一致：1.0 需要 14 步、0.2 需要 8 步。
  const timing = loadTiming()
  const releaseSteps = (from) => {
    let value = from
    let steps = 0
    while (value >= 0.001 && steps < 100) {
      value = timing.smoothLipValue(0, value)
      steps++
    }
    return steps
  }
  assert.equal(releaseSteps(1), 14)
  assert.equal(releaseSteps(0.2), 8)
})

test('loudness p95 normalisation is gone; the target shape is the official curve', () => {
  const lip = loadRendererModule('utils/LipSyncEnvelope.ts')
  const timing = loadTiming()
  const frames = Math.round(sampleRate * 0.4)
  const makeSine = (amp) => {
    const samples = new Float32Array(frames)
    for (let i = 0; i < frames; i++)
      samples[i] = Math.sin((i / sampleRate) * 2 * Math.PI * 220) * amp
    return samples
  }
  const loud = lip.buildLipSyncEnvelope([makeSine(0.9)], sampleRate)
  assert.equal(loud.loudnessGain, undefined, 'no p95 gain in the official path')
  assert.equal(loud.loudnessP95, undefined)
  assert.equal(loud.targetValueScale, 1)
  assert.equal(loud.powK, 1.75)
  // 0.45 振幅：首窗 RMS 由样本直接算，target 由 pow 曲线给出；峰值不再被 0.88 截断。
  const firstWindowRms = (amp) => {
    let energy = 0
    for (let i = 0; i < sampleRate / 60; i++) {
      const value = Math.sin((i / sampleRate) * 2 * Math.PI * 220) * amp
      energy += value * value
    }
    return Math.sqrt(energy / (sampleRate / 60))
  }
  const normal = lip.buildLipSyncEnvelope([makeSine(0.45)], sampleRate)
  assert.ok(Math.abs(normal.values[1] - 0.6 * timing.lipTargetFromRms(firstWindowRms(0.45))) < 1e-3)
  assert.ok(Math.max(...normal.values) > 0.45)
  // 1.25 系数（资源名角色号 1/4/8/12/17/18）：a×(a+1)^2.1875。
  const loudScale = lip.buildLipSyncEnvelope([makeSine(0.2)], sampleRate, {
    targetValueScale: 1.25
  })
  assert.equal(loudScale.targetValueScale, 1.25)
  assert.equal(loudScale.powK, 2.1875)
  assert.ok(
    Math.abs(
      loudScale.values[1] - 0.6 * timing.lipTargetFromRms(firstWindowRms(0.2), 1.25, 2.1875)
    ) < 1e-3
  )
})

test('an extremely quiet voice opens at the official 0.2 floor', () => {
  const lip = loadRendererModule('utils/LipSyncEnvelope.ts')
  const frames = Math.round(sampleRate * 0.4)
  const makeSine = (amp) => {
    const samples = new Float32Array(frames)
    for (let i = 0; i < frames; i++)
      samples[i] = Math.sin((i / sampleRate) * 2 * Math.PI * 220) * amp
    return samples
  }
  const envelope = lip.buildLipSyncEnvelope([makeSine(0.08)], sampleRate)
  const peak = Math.max(...envelope.values)
  // 旧链路钉在 minSpeech=0.17；官方曲线在阈值 0.06 之上、限幅下限 0.2。
  assert.ok(Math.abs(peak - 0.2) < 0.01, `peak ${peak}`)
  // 官方阈值行为：低于 LIP_THRESHOLD=0.06 的输入不开嘴。
  const silent = lip.buildLipSyncEnvelope([makeSine(0.05)], sampleRate)
  assert.equal(Math.max(...silent.values), 0)
})

test('sampling follows the 60Hz step: no interpolation, 30fps equals 60fps', () => {
  const lip = loadRendererModule('utils/LipSyncEnvelope.ts')
  const { samples } = sineSentence({})
  const envelope = lip.buildLipSyncEnvelope([samples], sampleRate)
  for (let step = 0; step < envelope.releaseStep; step++) {
    const at = step * envelope.frameMs
    assert.equal(lip.sampleLipSync(envelope, at), envelope.values[step])
    // 步内任意时刻仍取该步的值（官方每帧只更新一次）。
    assert.equal(lip.sampleLipSync(envelope, at + envelope.frameMs * 0.5), envelope.values[step])
  }
  // 30fps 抽取：视频帧 k 对应故事步 2k，值与 60fps 同一故事步相等。
  for (let k = 0; k * 2 < envelope.releaseStep; k++) {
    const sixty = lip.sampleLipSync(envelope, k * 2 * envelope.frameMs)
    const thirty = lip.sampleLipSync(envelope, k * 2 * envelope.frameMs)
    assert.equal(thirty, sixty)
  }
  assert.equal(lip.sampleLipSync(envelope, -1), 0, 'before the start')
  assert.equal(lip.sampleLipSync(envelope, Number.NaN), 0, 'not a number')
})

test('text lip: one half letter is two identical 60Hz targets', () => {
  const lip = loadRendererModule('utils/LipSyncEnvelope.ts')
  const timing = loadTiming()
  // speaker0 of 2：first = 1 → 0.24, 0.24, 1.0, 1.0, 0.24, 0.24
  const speaker0 = lip.textLipSequence(6, { index: 0, total: 2 })
  const expected = [
    timing.LIP_LEVELS[1],
    timing.LIP_LEVELS[1],
    timing.LIP_LEVELS[3],
    timing.LIP_LEVELS[3],
    timing.LIP_LEVELS[5],
    timing.LIP_LEVELS[5]
  ]
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(speaker0.targets[i] - expected[i]) < 1e-6, `target ${i}`)
  }
  // target 0.24 → smooth 第二步 0.68t（|target−prev| < 0.1 档），不是线性插值。
  assert.ok(Math.abs(speaker0.values[0] - 0.6 * 0.24) < 1e-6)
  assert.ok(Math.abs(speaker0.values[1] - 0.68 * 0.24) < 1e-6)
  // target 0.9（speaker1 of 2 的第一个半字）→ 0.6t 然后 0.7t。
  const speaker1 = lip.textLipSequence(6, { index: 1, total: 2 })
  assert.ok(Math.abs(speaker1.targets[0] - 0.9) < 1e-6)
  assert.ok(Math.abs(speaker1.values[0] - 0.54) < 1e-6)
  assert.ok(Math.abs(speaker1.values[1] - 0.63) < 1e-6)
  // 全员 talk（slot null）：0.12, 0.24, 0.9。
  const everyone = lip.textLipSequence(6, null)
  for (const [i, level] of [0.12, 0.12, 0.24, 0.24, 0.9, 0.9].entries()) {
    assert.ok(Math.abs(everyone.targets[i] - level) < 1e-6, `everyone ${i}`)
  }
})

test('text lip starts closing at typing_end minus one whole char and releases', () => {
  const lip = loadRendererModule('utils/LipSyncEnvelope.ts')
  const sequence = lip.textLipSequence(12, { index: 0, total: 2 })
  // 6 字 = 12 半字 = 24 步；收尾在 24 − 4 = 20。
  assert.ok(sequence.targets[19] > 0)
  assert.equal(sequence.targets[20], 0)
  assert.equal(sequence.targets[21], 0)
  assert.equal(sequence.values[sequence.releaseStep], 0)
  assert.ok(sequence.releaseStep >= 20)
  // 点击提前结束：目标从 endStep 起归零，平滑尾照常。
  const clicked = lip.textLipSequence(12, { index: 0, total: 2 }, { endStep: 6 })
  assert.ok(clicked.targets[5] > 0)
  assert.equal(clicked.targets[6], 0)
  assert.equal(clicked.values[clicked.releaseStep], 0)
  // 0..5 的值与自然收尾时一致（点击只改之后的目标）。
  for (let i = 0; i < 6; i++) assert.equal(clicked.values[i], sequence.values[i])
  assert.ok(clicked.releaseStep < sequence.releaseStep)
})
