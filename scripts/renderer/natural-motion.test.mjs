/**
 * PLAN SNAPSHOT — 与 doc/sekai-exporter-parity-plan.md 同步维护。
 *
 * 官方待机自然动作（`sse-live2d/src/blink.rs`、`runtime.rs`、
 * `sse-bake/src/lipsync.rs`）：
 * - 眨眼：|sin| 控制器。新模型 Sleep；身体动作切换 Sleep，只有非循环动作越过结尾
 *   Wake；`untilTime` 初值 0、睡眠期间不递减、唤醒不重置。相位从 -π/2 起每步
 *   += 10/60，`EyeOpening = |sin|`；一眨 19 步 <1、第 20 步 1.0，谷值 0.0707。
 *   动作 UserData 的 `eyeblink,closing,closed,opening` 走 Command 模式。
 * - 呼吸：整数相位初值，每 60Hz 步 +2°，越过 360 只减一次；隐藏时冻结。
 * - 口型：语音 RMS 窗口 + 文本 LipLevels 都按 60Hz 步进，只走官方三档 smooth()
 *   （0.6/0.4、0.2/0.8、0.25/0.75），平滑到 <0.001 脱手。
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

function loadTiming() {
  return loadRendererModule(path.join(root, 'src/common/official/timing.ts'))
}

const DT = 1 / 60
const blinkRadian = (j) => -Math.PI / 2 + j * DT * 10

test('a fresh blink controller sleeps and a wake starts the first blink immediately', () => {
  const natural = loadNatural()
  const state = natural.createBlinkState(7)
  for (let i = 0; i < 600; i++) assert.equal(natural.stepBlink(state, DT), 1)
  assert.equal(state.status, 'sleep')
  assert.equal(state.doSleep, true)
  natural.wakeBlink(state)
  natural.stepBlink(state, DT)
  assert.equal(state.status, 'closing')
  // 第一帧已经推进：|sin(-π/2 + 1/6)|
  assert.ok(Math.abs(state.opening - Math.abs(Math.sin(blinkRadian(1)))) < 1e-12)
})

test('one blink is |sin|: 19 steps below 1 and the 20th forced to 1.0', () => {
  const natural = loadNatural()
  const state = natural.createBlinkState(7)
  natural.wakeBlink(state)
  const values = []
  for (let i = 0; i < 100; i++) {
    values.push(natural.stepBlink(state, DT))
    if (state.status === 'ready') break
  }
  assert.equal(values.length, 20)
  assert.equal(values.at(-1), 1)
  // 第 j=1..19 步 = |sin(-π/2 + j·(1/60)·10)|
  for (let j = 1; j <= 19; j++) {
    assert.ok(
      Math.abs(values[j - 1] - Math.abs(Math.sin(blinkRadian(j)))) < 1e-4,
      `step ${j}: ${values[j - 1]}`
    )
  }
  // |sin| 的步长 1/6 rad 跨过零点：第 9 步 0.0707、第 10 步 0.0957。
  assert.ok(Math.abs(values[8] - 0.0707) < 1e-4, `step 9 ${values[8]}`)
  assert.ok(Math.abs(values[9] - 0.0957) < 1e-4, `step 10 ${values[9]}`)
  const lowest = Math.min(...values.slice(0, 19))
  assert.ok(Math.abs(lowest - 0.0707) < 1e-4, `lowest ${lowest}`)
  const lowAt = values.indexOf(lowest)
  assert.ok(
    values.slice(1, lowAt + 1).every((value, i) => value < values[i]),
    'closing is monotonic'
  )
  assert.ok(
    values.slice(lowAt, 19).every((value, i) => i === 0 || value > values[lowAt + i - 1]),
    'opening is monotonic'
  )
  assert.ok(state.untilTime >= 1 && state.untilTime <= 5, `until ${state.untilTime}`)
})

test('30fps sampling picks every other |sin| step and keeps 0.0707 / 0.0957', () => {
  const natural = loadNatural()
  const sample = (phaseOffset) => {
    const state = natural.createBlinkState(7)
    natural.wakeBlink(state)
    if (phaseOffset) natural.stepBlink(state, DT)
    const values = []
    for (let i = 0; i < 100; i++) {
      values.push(natural.stepBlink(state, 1 / 30))
      if (state.status === 'ready') break
    }
    return values
  }
  // 30fps 抽到的步号奇偶由唤醒帧决定，两种序列都允许；按抽样步号复算期望值。
  const even = sample(false)
  assert.equal(even.length, 10)
  for (let i = 0; i < even.length - 1; i++) {
    const j = (i + 1) * 2
    assert.ok(Math.abs(even[i] - Math.abs(Math.sin(blinkRadian(j)))) < 1e-4, `even j=${j}`)
  }
  assert.ok(Math.abs(Math.min(...even.slice(0, -1)) - 0.0957) < 1e-4)
  const odd = sample(true)
  for (let i = 0; i < odd.length - 1; i++) {
    const j = i * 2 + 3
    assert.ok(Math.abs(odd[i] - Math.abs(Math.sin(blinkRadian(j)))) < 1e-4, `odd j=${j}`)
  }
  assert.ok(Math.abs(Math.min(...odd.slice(0, -1)) - 0.0707) < 1e-4)
})

test('sleep during a blink parks at the end and wake does not clear doSleep', () => {
  const natural = loadNatural()
  const state = natural.createBlinkState(7)
  natural.wakeBlink(state)
  natural.stepBlink(state, DT)
  const during = state.opening
  natural.sleepBlink(state)
  natural.wakeBlink(state)
  assert.equal(state.opening, during)
  assert.equal(state.doSleep, true, 'WakeUp only clears doSleep from Sleep')
  for (let i = 0; i < 40; i++) natural.stepBlink(state, DT)
  assert.equal(state.status, 'sleep')
  assert.equal(state.opening, 1)
})

test('untilTime does not count down while asleep and is not reset by a wake', () => {
  const natural = loadNatural()
  const state = natural.createBlinkState(7)
  natural.wakeBlink(state)
  natural.stepBlink(state, DT)
  while (state.status !== 'ready') natural.stepBlink(state, DT)
  const left = state.untilTime
  assert.ok(left >= 1 && left <= 5, `drawn interval ${left}`)
  natural.sleepBlink(state)
  for (let i = 0; i < 600; i++) natural.stepBlink(state, DT)
  assert.equal(state.untilTime, left)
  assert.equal(state.opening, 1)
  natural.wakeBlink(state)
  let frames = 0
  while (state.status === 'ready') {
    natural.stepBlink(state, DT)
    frames++
  }
  let t = left
  let expected = 0
  while (t >= 0) {
    t -= DT
    expected++
  }
  assert.equal(frames, expected)
})

test('body motion changes sleep the blink and only a non-looping finish wakes it', () => {
  const natural = loadNatural()
  const state = natural.createBlinkState(1)
  natural.wakeBlink(state)
  // 1.0s 非循环身体动作：前 60 步不眨，第 61 步开始。
  natural.bodyMotionChangedBlink(state)
  for (let i = 0; i < 60; i++) assert.equal(natural.stepBlink(state, DT), 1)
  natural.bodyMotionFinishedBlink(state, false)
  assert.ok(natural.stepBlink(state, DT) < 1, 'the blink starts on the frame after the end')
  // 循环 clip 的每圈结束不唤醒。
  const looping = natural.createBlinkState(1)
  natural.wakeBlink(looping)
  natural.bodyMotionChangedBlink(looping)
  natural.bodyMotionFinishedBlink(looping, true)
  for (let i = 0; i < 600; i++) assert.equal(natural.stepBlink(looping, DT), 1)
  // 模型没有这个动作：先按当前 clip 决定唤醒，随后永久 Sleep。
  const missing = natural.createBlinkState(1)
  natural.wakeBlink(missing)
  natural.missingBodyMotionBlink(missing, false)
  for (let i = 0; i < 1200; i++) assert.equal(natural.stepBlink(missing, DT), 1)
  assert.equal(missing.status, 'sleep')
})

test('a motion eyeblink command closes linearly, holds and reopens', () => {
  const natural = loadNatural()
  const state = natural.createBlinkState(7)
  natural.wakeBlink(state)
  natural.stepBlink(state, DT)
  while (state.status !== 'ready') natural.stepBlink(state, DT)
  natural.invokeBlinkUserData(state, 'eyeblink,0.2,0.24,0.24')
  // 事件帧 N 写出旧 eyeValue（一次自动眨眼结束后是 1.0）。
  assert.equal(natural.stepBlink(state, DT), 1)
  const values = []
  for (let i = 0; i < 80; i++) {
    values.push(natural.stepBlink(state, DT))
    if (state.mode === 'auto') break
  }
  // 0.2s = 12 步闭眼（第 12 步落到 0）。
  for (let i = 0; i < 11; i++) {
    assert.ok(Math.abs(values[i] - (1 - (i + 1) * DT * 5)) < 1e-6, `closing ${i}: ${values[i]}`)
  }
  assert.equal(values[11], 0)
  // 0.24s = 14 步保持 0。
  const zeros = values.slice(12, 26)
  assert.ok(
    zeros.every((value) => value === 0),
    `held ${zeros}`
  )
  // 14 步线性睁眼，最后一步 1.0。
  assert.ok(Math.abs(values[26] - 1 / 24) < 1e-6, `opening start ${values[26]}`)
  for (let i = 27; i < 40; i++) assert.ok(values[i] > values[i - 1], `opening ${i}`)
  assert.equal(values[40], 1)
  assert.equal(state.mode, 'auto')
  assert.equal(state.playStatus, 'finish')
})

test('a second eyeblink command is ignored while one plays; short data is ignored', () => {
  const natural = loadNatural()
  const state = natural.createBlinkState(7)
  natural.wakeBlink(state)
  natural.invokeBlinkUserData(state, 'eyeblink,0.2,0.79,0.24')
  natural.stepBlink(state, DT)
  natural.invokeBlinkUserData(state, 'eyeblink,0.01,0.01,0.01')
  assert.equal(state.command.closing, 0.2, 'still the first command')
  natural.invokeBlinkUserData(state, 'eyeblink,0.2,0.24')
  assert.equal(state.command.closing, 0.2)
})

test('breath starts at an integer phase, advances 2 degrees per step and freezes when hidden', () => {
  const natural = loadNatural()
  const timing = loadTiming()
  for (const seed of [0, 1, 5, 42, 999]) {
    const start = natural.createBreathDegree(seed)
    assert.equal(start, Math.trunc(start))
    assert.ok(start >= 0 && start < 360, `start ${start}`)
    const first = natural.advanceBreathDegree(start, DT)
    const expected = (Math.sin((start + 2) * timing.DEG2RAD) * 0.5 + 0.5) * 0.5
    assert.ok(Math.abs(natural.breathParameterValue(first) - expected) < 1e-9)
    // 180 步一个周期：v[k] 与 v[k+180] 逐位相等。
    let degree = start
    const values = []
    for (let i = 0; i < 360; i++) {
      degree = natural.advanceBreathDegree(degree, DT)
      values.push(natural.breathParameterValue(degree))
      assert.ok(degree >= 0 && degree < 360)
    }
    for (let k = 0; k < 180; k++) {
      assert.equal(Object.is(values[k], values[k + 180]), true, `seed ${seed} k ${k}`)
    }
  }
})

test('official lip curve, coefficient reset, smooth() chain and release lengths', () => {
  const timing = loadTiming()
  assert.ok(timing.LIP_LEVELS.length === 38)
  assert.equal(timing.lipTargetFromRms(0), 0)
  // `a × (a+1)^1.75`，阈值 0.06、限幅 0.2~1。
  assert.ok(Math.abs(timing.lipTargetFromRms(0.2) - 0.2752) < 1e-4)
  assert.ok(Math.abs(timing.lipTargetFromRms(0.3) - 0.4748) < 1e-4)
  assert.ok(Math.abs(timing.lipTargetFromRms(0.05) - 0) < 1e-9, 'below 0.06 stays closed')
  // 一次 talk 把系数重设为 (tvs, tvs × 1.75)。
  const coefficients = timing.lipCoefficients(1.25)
  assert.equal(coefficients.targetValueScale, 1.25)
  assert.equal(coefficients.powK, 2.1875)
  assert.ok(Math.abs(timing.lipTargetFromRms(0.2, 1.25, 2.1875) - 0.4073) < 1e-4)
  assert.ok(Math.abs(timing.lipTargetFromRms(0.3, 1.25, 2.1875) - 0.7526) < 1e-4)
  assert.ok(Math.abs(timing.lipTargetFromRms(0.05, 1.25, 2.1875) - 0.2) < 1e-9)
  // smooth()：0.6 → 0.7 → 0.775；1.0 → <0.001 用 14 步、0.2 用 8 步。
  let value = timing.smoothLipValue(1, 0)
  assert.ok(Math.abs(value - 0.6) < 1e-12, `first smooth ${value}`)
  value = timing.smoothLipValue(1, value)
  assert.ok(Math.abs(value - 0.7) < 1e-12, `second smooth ${value}`)
  value = timing.smoothLipValue(1, value)
  assert.ok(Math.abs(value - 0.775) < 1e-12, `third smooth ${value}`)
  const releaseSteps = (from) => {
    let current = from
    let steps = 0
    while (current >= 0.001 && steps < 100) {
      current = timing.smoothLipValue(0, current)
      steps++
    }
    return steps
  }
  assert.equal(releaseSteps(1), 14)
  assert.equal(releaseSteps(0.2), 8)
  // 恒 1.0 输入 60 步后开度 ≥ 0.999999。
  let held = 0
  for (let i = 0; i < 60; i++) held = timing.smoothLipValue(1, held)
  assert.ok(held >= 0.999999, `held ${held}`)
  // 静音 60 步后 ≤ 1e-4。
  let silent = 0
  for (let i = 0; i < 60; i++) silent = timing.smoothLipValue(0, silent)
  assert.ok(silent <= 1e-4, `silent ${silent}`)
  // 旧 fallback preset 已移除。
  assert.equal(timing.MOUTH_SYNC_FALLBACK_PRESET, undefined)
})

test('the voice envelope steps at 60Hz, keeps the first sound step at 0.6x target', () => {
  const lip = loadRendererModule('utils/LipSyncEnvelope.ts')
  const sampleRate = 48000
  const frames = Math.round(sampleRate * 0.4)
  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i++)
    samples[i] = Math.sin((i / sampleRate) * 2 * Math.PI * 220) * 0.45
  const envelope = lip.buildLipSyncEnvelope([samples], sampleRate)
  assert.equal(envelope.frameMs, 1000 / 60)
  assert.equal(envelope.values.length, envelope.releaseStep + 1)
  assert.equal(envelope.targetValueScale, 1)
  assert.equal(envelope.powK, 1.75)
  // 第 0 步窗口为空（end=0），所以第一声在第 1 步：0.6 × target。
  const timing = loadTiming()
  let energy = 0
  for (let i = 0; i < 800; i++) energy += samples[i] * samples[i]
  const expected = 0.6 * timing.lipTargetFromRms(Math.sqrt(energy / 800), 1, 1.75)
  assert.ok(Math.abs(envelope.values[1] - expected) < 1e-6, `first ${envelope.values[1]}`)
  // 峰值按 pow 曲线；旧 openCap 0.88 已删除。
  const peak = Math.max(...envelope.values)
  assert.ok(peak > 0.45 && peak <= 1, `peak ${peak}`)
  // 音频放完后平滑到 <0.001 才脱手，末值即 0。
  assert.equal(envelope.values[envelope.releaseStep], 0)
  assert.ok(envelope.values[envelope.releaseStep - 1] >= 0 && envelope.releaseStep > 0)
})

test('a quiet voice opens at the official 0.2 floor instead of the old minSpeech pin', () => {
  const lip = loadRendererModule('utils/LipSyncEnvelope.ts')
  const sampleRate = 48000
  const frames = Math.round(sampleRate * 0.4)
  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i++)
    samples[i] = Math.sin((i / sampleRate) * 2 * Math.PI * 220) * 0.08
  const envelope = lip.buildLipSyncEnvelope([samples], sampleRate)
  const peak = Math.max(...envelope.values)
  assert.ok(peak > 0.19 && peak <= 0.2, `quiet peak ${peak}`)
  const silent = lip.buildLipSyncEnvelope([new Float32Array(4800)], 48000)
  assert.equal(Math.max(...silent.values), 0)
})

test('syllable gaps still close and reopen with the official smooth()', () => {
  const lip = loadRendererModule('utils/LipSyncEnvelope.ts')
  const sampleRate = 48000
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
  const gapMins = []
  for (let k = 0; k < 4; k++) {
    const startF = Math.round((100 * (k + 1) + 60 * k) / envelope.frameMs)
    const endF = Math.round((100 * (k + 1) + 60 * (k + 1)) / envelope.frameMs)
    gapMins.push(Math.min(...values.slice(startF, endF)))
  }
  const worstTrough = Math.max(...gapMins)
  assert.ok(
    peak - worstTrough >= 0.12,
    `syllable contrast: peak ${peak.toFixed(3)} trough ${worstTrough.toFixed(3)}`
  )
})

test('text lip levels follow the speaker slot and close one whole char early', () => {
  const lip = loadRendererModule('utils/LipSyncEnvelope.ts')
  const timing = loadTiming()
  const expectTargets = (sequence, levels) => {
    for (let i = 0; i < levels.length; i++) {
      assert.ok(
        Math.abs(sequence.targets[i] - levels[i]) < 1e-6,
        `target ${i}: ${sequence.targets[i]} != ${levels[i]}`
      )
    }
  }
  const six = lip.textLipSequence(6, { index: 0, total: 2 })
  expectTargets(six, [
    timing.LIP_LEVELS[1],
    timing.LIP_LEVELS[1],
    timing.LIP_LEVELS[3],
    timing.LIP_LEVELS[3],
    timing.LIP_LEVELS[5],
    timing.LIP_LEVELS[5]
  ])
  const other = lip.textLipSequence(6, { index: 1, total: 2 })
  expectTargets(other, [
    timing.LIP_LEVELS[2],
    timing.LIP_LEVELS[2],
    timing.LIP_LEVELS[4],
    timing.LIP_LEVELS[4],
    timing.LIP_LEVELS[6],
    timing.LIP_LEVELS[6]
  ])
  const everyone = lip.textLipSequence(6, null)
  expectTargets(everyone, [
    timing.LIP_LEVELS[0],
    timing.LIP_LEVELS[0],
    timing.LIP_LEVELS[1],
    timing.LIP_LEVELS[1],
    timing.LIP_LEVELS[2],
    timing.LIP_LEVELS[2]
  ])
  // 6 个字 = 12 个半字：收尾在 typing_end − 一个整字 = 4×(len−1) = 20。
  const sixChars = lip.textLipSequence(12, { index: 0, total: 2 })
  assert.equal(sixChars.targets[19] > 0, true)
  assert.equal(sixChars.targets[20], 0)
})

test('per-model blink/breath seeds are derived from the model id and stable', () => {
  const natural = loadNatural()
  // `naturalMotionSeed` 是 id 的 Knuth 乘法散列：同一 id 每次导出得到同一序列。
  assert.equal(natural.naturalMotionSeed(1), (1 * 2654435761) >>> 0)
  assert.equal(natural.naturalMotionSeed(22), (22 * 2654435761) >>> 0)
  assert.equal(natural.naturalMotionSeed(22), natural.naturalMotionSeed(22))
  assert.notEqual(natural.naturalMotionSeed(22), natural.naturalMotionSeed(23))
  const intervals = (seed) => {
    const state = natural.createBlinkState(seed)
    natural.wakeBlink(state)
    const out = []
    for (let n = 0; n < 3; n++) {
      natural.stepBlink(state, DT)
      while (state.status !== 'ready') natural.stepBlink(state, DT)
      out.push(state.untilTime)
    }
    return out
  }
  // 同一模型 id 的眨眼间隔序列逐位一致；不同 id 不同。
  const a = intervals(natural.naturalMotionSeed(22))
  const b = intervals(natural.naturalMotionSeed(22))
  assert.deepEqual(a, b)
  assert.notDeepEqual(a, intervals(natural.naturalMotionSeed(23)))
  // 呼吸初相位同样由种子派生且落在 [0, 360) 的整数。
  const degree = natural.createBreathDegree(natural.naturalMotionSeed(22))
  assert.equal(degree, natural.createBreathDegree(natural.naturalMotionSeed(22)))
  assert.equal(Number.isInteger(degree), true)
  assert.ok(degree >= 0 && degree < 360)
})
