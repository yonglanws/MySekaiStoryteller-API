import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  buildBgmCues,
  collectBgmChanges,
  mixBgmCueSamples,
  normalizeBgmFile
} from '../../out-host/common/audio/bgm.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const rendererRoot = path.join(repoRoot, 'src/renderer/src')

function loadRendererModule(relPath, mocks = new Map()) {
  const fullPath = path.join(rendererRoot, relPath)
  const cache = new Map()
  const context = vm.createContext({
    console,
    Uint8Array,
    Float32Array,
    Int16Array,
    Int32Array,
    DataView,
    ArrayBuffer,
    Math,
    Number,
    Map,
    Set,
    WeakMap,
    Promise,
    AudioContext: class {
      constructor() {
        this.sampleRate = 48000
        this.state = 'running'
      }
      createBuffer(channels, length, sampleRate) {
        const bufs = Array.from({ length: channels }, () => new Float32Array(length))
        return {
          numberOfChannels: channels,
          length,
          sampleRate,
          duration: length / sampleRate,
          getChannelData: (c) => bufs[c]
        }
      }
      async resume() {}
      async close() {}
    }
  })
  const loadByAbsPath = (absPath) => {
    const norm = path.normalize(absPath)
    if (cache.has(norm)) return cache.get(norm)
    if (mocks.has(norm)) return mocks.get(norm)
    const src = fs.readFileSync(norm, 'utf8')
    const out = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: norm
    }).outputText
    const mod = { exports: {} }
    cache.set(norm, mod.exports)
    const req = (spec) => {
      if (mocks.has(spec)) return mocks.get(spec)
      if (spec.startsWith('.')) {
        const base = path.resolve(path.dirname(norm), spec)
        for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
          if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
            return loadByAbsPath(cand)
          }
        }
      }
      throw new Error(`Unexpected dependency "${spec}" from ${norm}`)
    }
    new vm.Script(`(function(exports, require, module) {\n${out}\n})`, {
      filename: norm
    }).runInContext(context)(mod.exports, req, mod)
    cache.set(norm, mod.exports)
    return mod.exports
  }
  return loadByAbsPath(fullPath)
}

const change = (file = '', stop = false, fadeMs = 600, volume = 1, delay = 0) => ({
  type: 'ChangeBgm',
  wait: false,
  delay,
  data: { file, stop, fadeMs, volume }
})

test('normalizeBgmFile accepts resource-relative BGM paths', () => {
  assert.equal(normalizeBgmFile('bgm00003.mp3'), 'bgm00003.mp3')
  assert.equal(normalizeBgmFile('audio/bgm/bgm00003.mp3'), 'bgm00003.mp3')
  assert.equal(normalizeBgmFile('resources/audio/bgm/bgm00003.mp3'), 'bgm00003.mp3')
  assert.equal(normalizeBgmFile('..\\..\\bgm00003.mp3'), 'bgm00003.mp3')
  assert.equal(normalizeBgmFile(''), '')
})

test('collectBgmChanges reads file, stop and fadeMs from snippets', () => {
  const changes = collectBgmChanges([
    change('bgm00003.mp3', false, 800),
    { type: 'Talk', wait: false, delay: 0, data: {} },
    change('', true, 1200)
  ])
  assert.deepEqual(changes, [
    { snippetIndex: 0, file: 'bgm00003.mp3', stop: false, fadeMs: 800, volume: 1, delayMs: 0 },
    { snippetIndex: 2, file: '', stop: true, fadeMs: 1200, volume: 1, delayMs: 0 }
  ])
})

test('collectBgmChanges keeps cue volume and snippet delay', () => {
  const changes = collectBgmChanges([change('bgm00297.mp3', false, 0, 0.6, 0.5)])
  assert.deepEqual(changes, [
    {
      snippetIndex: 0,
      file: 'bgm00297.mp3',
      stop: false,
      fadeMs: 0,
      volume: 0.6,
      delayMs: 500
    }
  ])
})

test('buildBgmCues drops the global track once the story picks a BGM', () => {
  const changes = collectBgmChanges([
    change('bgm00003.mp3', false, 600),
    change('bgm00006.mp3', false, 600),
    change('', true, 800)
  ])
  const buffers = new Map([
    ['bgm00003.mp3', { id: 'a' }],
    ['bgm00006.mp3', { id: 'b' }]
  ])
  const global = { id: 'global' }
  const cues = buildBgmCues(changes, [0, 500, 1000, 2000], buffers, global)
  assert.deepEqual(
    cues.map((cue) => ({ timeMs: cue.timeMs, stop: cue.stop, file: cue.buffer?.id ?? '' })),
    [
      { timeMs: 0, stop: false, file: 'a' },
      { timeMs: 500, stop: false, file: 'b' },
      { timeMs: 1000, stop: true, file: '' }
    ]
  )
})

test('buildBgmCues keeps the global track for stop-only stories', () => {
  const changes = collectBgmChanges([change('', true, 500)])
  const cues = buildBgmCues(changes, [4000], new Map(), { id: 'global' })
  assert.deepEqual(
    cues.map((cue) => ({ timeMs: cue.timeMs, stop: cue.stop, file: cue.buffer?.id ?? '' })),
    [
      { timeMs: 0, stop: false, file: 'global' },
      { timeMs: 4000, stop: true, file: '' }
    ]
  )
})

test('buildBgmCues applies snippet delay and cue volume', () => {
  const cues = buildBgmCues(
    collectBgmChanges([change('bgm00297.mp3', false, 0, 0.6, 0.5)]),
    [1000],
    new Map([['bgm00297.mp3', { id: 'x' }]]),
    null
  )
  assert.equal(cues.length, 1)
  assert.equal(cues[0].timeMs, 1500)
  assert.equal(cues[0].volume, 0.6)
})

test('mixBgmCueSamples loops, crossfades and stops on the timeline', () => {
  const sampleRate = 1000
  const totalSamples = 3000
  const left = new Float32Array(totalSamples)
  const right = new Float32Array(totalSamples)
  const channel = (value) => new Float32Array([value])

  const stats = mixBgmCueSamples(
    [
      { timeMs: 0, fadeMs: 0, stop: false, channel0: channel(0.5), channel1: channel(0.5) },
      { timeMs: 1000, fadeMs: 500, stop: false, channel0: channel(0.25), channel1: channel(0.25) },
      { timeMs: 2000, fadeMs: 500, stop: true, channel0: null, channel1: null }
    ],
    left,
    right,
    sampleRate,
    0.2
  )

  assert.equal(stats.cueCount, 3)
  assert.equal(stats.segments, 2)
  assert.ok(Math.abs(left[500] - 0.1) < 1e-6, `before switch: ${left[500]}`)
  // 1000~1500ms 交叉淡化：旧曲 0.5→0，新曲 0→0.25
  assert.ok(Math.abs(left[1250] - 0.075) < 1e-6, `crossfade midpoint: ${left[1250]}`)
  assert.ok(Math.abs(left[1750] - 0.05) < 1e-6, `new track only: ${left[1750]}`)
  // 2000~2500ms 停止淡出
  assert.ok(Math.abs(left[2250] - 0.025) < 1e-6, `stop fade midpoint: ${left[2250]}`)
  assert.equal(left[2600], 0)
  for (let index = 0; index < totalSamples; index++) {
    assert.equal(left[index], right[index])
  }
})

test('BgmPlan.build and getRustCues honor startTimesIncludeDelay without double-adding delayMs', () => {
  const { BgmPlan } = loadRendererModule(
    'managers/video-export/BgmPlan.ts',
    new Map([
      [
        path.join(rendererRoot, 'managers/video-export/ExportLogger.ts'),
        {
          ExportLogger: class {
            info() {}
            warn() {}
            error() {}
          }
        }
      ]
    ])
  )
  const snippets = [
    {
      type: 'ChangeBgm',
      wait: false,
      delay: 0.5,
      data: { file: 'bgm00003.mp3', stop: false, fadeMs: 400, volume: 0.8 }
    },
    { type: 'BgmVolume', wait: false, delay: 0.25, data: { volume: 0.5, duration: 300 } }
  ]
  const plan = new BgmPlan(snippets)
  plan.buffers.set('bgm00003.mp3', { duration: 10 })

  // startTimesIncludeDelay = false -> adds snippet delayMs
  const noDelayCues = plan.build([1000, 2000], null, false)
  assert.equal(noDelayCues[0].timeMs, 1500)
  assert.equal(noDelayCues.volumeTweens[0].timeMs, 2250)
  const rustNoDelay = plan.getRustCues([1000, 2000], false)
  assert.equal(rustNoDelay.cues[0].timeMs, 1500)
  assert.equal(rustNoDelay.volumeTweens[0].timeMs, 2250)

  // startTimesIncludeDelay = true -> does NOT double-add delayMs
  const incDelayCues = plan.build([1500, 2250], null, true)
  assert.equal(incDelayCues[0].timeMs, 1500)
  assert.equal(incDelayCues.volumeTweens[0].timeMs, 2250)
  const rustIncDelay = plan.getRustCues([1500, 2250], true)
  assert.equal(rustIncDelay.cues[0].timeMs, 1500)
  assert.equal(rustIncDelay.volumeTweens[0].timeMs, 2250)
})

test('AudioMuxer clamps voice track endTime and floors loop-region BGM cue start samples', async () => {
  const { AudioMuxer, ACF_GAIN_VOICE } = loadRendererModule(
    'managers/video-export/AudioMuxer.ts',
    new Map([
      [
        path.join(rendererRoot, 'managers/video-export/ExportLogger.ts'),
        {
          ExportLogger: class {
            info() {}
            warn() {}
            error() {}
          }
        }
      ]
    ])
  )

  const muxer = new AudioMuxer()
  const sr = 48_000
  const voiceSamples = new Float32Array(sr) // 1s voice
  voiceSamples.fill(0.5)
  muxer.audioTracks.push({
    audioBuffer: new ArrayBuffer(8),
    pcmData: { channel0: voiceSamples, channel1: new Float32Array(voiceSamples), sampleRate: sr },
    startTime: 100,
    endTime: 300, // clamped to 200ms duration instead of full 1s
    characterName: '一歌',
    text: 'hello'
  })

  const left = new Float32Array(sr)
  const right = new Float32Array(sr)
  const spans = await muxer.mixTTSTracks(left, right, sr, sr)
  assert.equal(spans.length, 1)
  assert.equal(spans[0].startSample, Math.floor(0.1 * sr))
  assert.equal(spans[0].endSample, Math.round(0.3 * sr))
  assert.ok(Math.abs(left[Math.floor(0.2 * sr)] - 0.5 * ACF_GAIN_VOICE) < 1e-6)
  assert.equal(left[Math.round(0.3 * sr) + 10], 0, 'voice PCM beyond track.endTime must be clamped')

  // Verify mixAudioTracks end-to-end returns clamped output AudioBuffer
  const mixedBuf = await muxer.mixAudioTracks(1000)
  const mixedCh0 = mixedBuf.getChannelData(0)
  assert.ok(Math.abs(mixedCh0[Math.floor(0.2 * sr)] - 0.5 * ACF_GAIN_VOICE) < 1e-6)
  assert.equal(mixedCh0[Math.round(0.3 * sr) + 10], 0)

  // Verify hasLoopRegions branch uses Math.floor for cue start sample (e.g. 10.9ms * 1000Hz = 10.9 -> floor 10)
  const bgmSamples = new Float32Array(100).fill(1.0)
  muxer.setBGMConfig({ enabled: true, path: 'bgm00003.mp3', volume: 1.0 })
  muxer.setBgmCues([
    {
      timeMs: 10.9,
      fadeMs: 0,
      stop: false,
      volume: 1,
      loopStartMs: 0,
      loopEndMs: 50,
      buffer: {
        numberOfChannels: 1,
        sampleRate: 1000,
        getChannelData: () => bgmSamples
      }
    }
  ])
  const bgmLeft = new Float32Array(100)
  const bgmRight = new Float32Array(100)
  muxer.mixStoryBGM(
    bgmLeft,
    bgmRight,
    100,
    1000,
    new Float32Array(100).fill(1),
    new Float32Array(100).fill(1)
  )
  assert.equal(bgmLeft[9], 0)
  assert.ok(bgmLeft[10] > 0, 'Math.floor(10.9) = 10 must receive BGM sample')
})
