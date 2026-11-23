/**
 * PLAN SNAPSHOT — 与 doc/sekai-exporter-parity-plan.md「2026-11 口型链路按
 * ournotes 忠实重构」一节同步维护。
 *
 * 锁定重构后的包络性质：
 * 1. 句间 450ms 静音必须闭嘴（hold 只覆盖 60ms 级短间隙，不造成长间隙永不闭合）；
 * 2. 释放尾 450ms 指数收尾（无 120ms 线性收尾）；
 * 3. 响度归一只放大不衰减、增益上限 2.4；
 * 4. sampleLipSync 越界返回 0；
 * 5. 极轻语音 peak 钉在 minSpeech=0.17 保底（观感预期锁档）。
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
  // 句 1 音频 740ms；450ms 间隙落在 ~44.4~71.4 帧。
  const gapStartF = Math.round((first.totalMs + 1) / envelope.frameMs)
  const gapEndF = Math.round((first.totalMs + 450 - 1) / envelope.frameMs)
  const gapMin = Math.min(...values.slice(gapStartF, gapEndF))
  assert.ok(gapMin < 0.05, `long inter-sentence gap must close: gapMin ${gapMin.toFixed(4)}`)
})

test('the release tail is the 450ms exponential release without a linear cutoff', () => {
  const lip = loadRendererModule('utils/LipSyncEnvelope.ts')
  const { samples } = sineSentence({})
  const envelope = lip.buildLipSyncEnvelope([samples], sampleRate)
  const extension = envelope.durationMs - envelope.audioDurationMs
  assert.ok(extension >= 440 && extension <= 460, `release tail is 450ms: ${extension}`)
  // 尾中部仍有残值（指数），末帧 <2% 收敛——不是 120ms 线性硬截断。
  const tailStartF = Math.round(envelope.audioDurationMs / envelope.frameMs)
  const tailMid = envelope.values[tailStartF + 2] ?? 0
  const tailLast = envelope.values.at(-1) ?? 0
  assert.ok(tailMid > 0, `mid tail keeps decaying exponentially: ${tailMid}`)
  assert.ok(tailLast < 0.02, `tail closes: ${tailLast}`)
})

test('loudness gain only amplifies, caps at 2.4 and follows the p95 target in between', () => {
  const lip = loadRendererModule('utils/LipSyncEnvelope.ts')
  const frames = Math.round(sampleRate * 0.4)
  const makeSine = (amp) => {
    const samples = new Float32Array(frames)
    for (let i = 0; i < frames; i++)
      samples[i] = Math.sin((i / sampleRate) * 2 * Math.PI * 220) * amp
    return samples
  }
  // 响亮输入：p95 目标已达标，不衰减（gain=1）。
  const loud = lip.buildLipSyncEnvelope([makeSine(0.9)], sampleRate)
  assert.equal(loud.loudnessGain, 1, 'never attenuates a loud voice')
  // 中等输入：gain 由 p95 目标 0.78 推出，且介于 1 与 2.4 之间。
  const normal = lip.buildLipSyncEnvelope([makeSine(0.45)], sampleRate)
  assert.ok(
    normal.loudnessGain > 1 && normal.loudnessGain < 2.4,
    `p95-driven gain ${normal.loudnessGain}`
  )
  assert.ok(
    Math.abs(normal.loudnessP95 * normal.loudnessGain - 0.78) < 0.02,
    'p95 lands on the target'
  )
  // 极轻输入（高于官方阈值、低于归一目标）：gain 顶到 2.4 上限。
  const quiet = lip.buildLipSyncEnvelope([makeSine(0.08)], sampleRate)
  assert.equal(quiet.loudnessGain, 2.4, 'gain caps at 2.4')
})

test('sampleLipSync returns 0 outside the envelope', () => {
  const lip = loadRendererModule('utils/LipSyncEnvelope.ts')
  const { samples } = sineSentence({})
  const envelope = lip.buildLipSyncEnvelope([samples], sampleRate)
  assert.ok(envelope.durationMs > 0)
  assert.equal(lip.sampleLipSync(envelope, envelope.durationMs), 0, 'at durationMs boundary')
  assert.equal(lip.sampleLipSync(envelope, envelope.durationMs + 1000), 0, 'past the end')
  assert.equal(lip.sampleLipSync(envelope, -1), 0, 'before the start')
  assert.equal(lip.sampleLipSync(envelope, NaN), 0, 'not a number')
})

test('an extremely quiet voice pins the peak at the minSpeech floor (0.17)', () => {
  const lip = loadRendererModule('utils/LipSyncEnvelope.ts')
  const frames = Math.round(sampleRate * 0.4)
  const makeSine = (amp) => {
    const samples = new Float32Array(frames)
    for (let i = 0; i < frames; i++)
      samples[i] = Math.sin((i / sampleRate) * 2 * Math.PI * 220) * amp
    return samples
  }
  // 0.08 振幅（评审实测的极轻档）：gain 顶 2.4 上限，peak 钉在 minSpeech=0.17 保底。
  const envelope = lip.buildLipSyncEnvelope([makeSine(0.08)], sampleRate)
  const peak = Math.max(...envelope.values)
  // 观感预期：gain 已顶 2.4 上限时 peak 恰好钉在 minSpeech=0.17 保底——气声台词
  // 的嘴型是恒定保底开度而非随语音起伏（official AdvCalm fallback 的行为）；
  // 若实片观感不可接受再立独立决策（改 minSpeech 属偏离蓝本）。
  assert.ok(Math.abs(peak - 0.17) < 0.01, `peak pins at minSpeech: peak ${peak}`)
  // 官方阈值行为：低于 LIP_THRESHOLD=0.06 的输入不开嘴（官方曲线裸输出，无下限放宽）。
  const silent = lip.buildLipSyncEnvelope([makeSine(0.05)], sampleRate)
  assert.equal(Math.max(...silent.values), 0, 'below the official threshold stays closed')
})
