import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildBgmCues,
  collectBgmChanges,
  mixBgmCueSamples,
  normalizeBgmFile
} from '../../out-host/common/audio/bgm.js'

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
