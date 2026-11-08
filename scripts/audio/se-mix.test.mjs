import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildSeCues,
  collectSeChanges,
  mixSeCueSamples,
  normalizeSeFile
} from '../../out-host/common/audio/se.js'

const play = (file, volume = 1, loop = false, fadeMs = 0, delay = 0) => ({
  type: 'PlaySe',
  wait: false,
  delay,
  data: { file, volume, loop, fadeMs }
})

const stop = (file, fadeMs = 0, delay = 0) => ({
  type: 'StopSe',
  wait: false,
  delay,
  data: { file, fadeMs }
})

test('normalizeSeFile accepts resource-relative SE paths', () => {
  assert.equal(normalizeSeFile('se00053_b.mp3'), 'se00053_b.mp3')
  assert.equal(normalizeSeFile('audio/se/se00053_b.mp3'), 'se00053_b.mp3')
  assert.equal(normalizeSeFile('resources/audio/se/se00053_b.mp3'), 'se00053_b.mp3')
  assert.equal(normalizeSeFile(''), '')
})

test('collectSeChanges reads play/stop, volume, loop and delay', () => {
  const changes = collectSeChanges([
    play('audio/se/se_run_women_002_2.mp3', 0.1, true, 0, 2),
    stop('se_run_women_002_2.mp3', 300, 1)
  ])
  assert.deepEqual(changes, [
    {
      snippetIndex: 0,
      file: 'se_run_women_002_2.mp3',
      stop: false,
      volume: 0.1,
      loop: true,
      fadeMs: 0,
      delayMs: 2000
    },
    {
      snippetIndex: 1,
      file: 'se_run_women_002_2.mp3',
      stop: true,
      volume: 0,
      loop: false,
      fadeMs: 300,
      delayMs: 1000
    }
  ])
})

test('buildSeCues adds snippet delay unless actual times already include it', () => {
  const changes = collectSeChanges([play('x.mp3', 1, false, 0, 0.5)])
  const buffers = new Map([
    ['x.mp3', { channel0: new Float32Array([1]), channel1: new Float32Array([1]) }]
  ])
  assert.equal(buildSeCues(changes, [1000], buffers)[0].timeMs, 1500)
  assert.equal(buildSeCues(changes, [1000], buffers, true)[0].timeMs, 1000)
})

test('mixSeCueSamples plays one-shot SE at its time', () => {
  const left = new Float32Array(20)
  const right = new Float32Array(20)
  const stats = mixSeCueSamples(
    [
      {
        timeMs: 5,
        file: 'x.mp3',
        stop: false,
        volume: 1,
        loop: false,
        fadeMs: 0,
        channel0: new Float32Array([1, 1, 1]),
        channel1: new Float32Array([1, 1, 1])
      }
    ],
    left,
    right,
    1000,
    0.5
  )
  assert.equal(stats.oneShots, 1)
  assert.equal(left[4], 0)
  assert.equal(left[5], 0.5)
  assert.equal(left[7], 0.5)
  assert.equal(left[8], 0)
  assert.equal(right[5], 0.5)
})

test('mixSeCueSamples ramps loop volume and fades out on StopSe', () => {
  const sampleRate = 1000
  const left = new Float32Array(3000)
  const right = new Float32Array(3000)
  const stats = mixSeCueSamples(
    [
      {
        timeMs: 0,
        file: 'run.mp3',
        stop: false,
        volume: 0.2,
        loop: true,
        fadeMs: 0,
        channel0: new Float32Array([1]),
        channel1: new Float32Array([1])
      },
      {
        timeMs: 1000,
        file: 'run.mp3',
        stop: false,
        volume: 1,
        loop: true,
        fadeMs: 500,
        channel0: new Float32Array([1]),
        channel1: new Float32Array([1])
      },
      {
        timeMs: 2000,
        file: 'run.mp3',
        stop: true,
        volume: 0,
        loop: false,
        fadeMs: 500,
        channel0: null,
        channel1: null
      }
    ],
    left,
    right,
    sampleRate,
    0.5
  )
  assert.equal(stats.loops, 1)
  assert.ok(Math.abs(left[500] - 0.1) < 1e-6, `quiet loop: ${left[500]}`)
  assert.ok(Math.abs(left[1000] - 0.1) < 1e-6, `ramp start: ${left[1000]}`)
  assert.ok(Math.abs(left[1250] - 0.3) < 1e-6, `ramp midpoint: ${left[1250]}`)
  assert.ok(Math.abs(left[1750] - 0.25) < 1e-6, `stop fade midpoint: ${left[1750]}`)
  assert.equal(left[2000], 0)
})
