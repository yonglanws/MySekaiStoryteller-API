import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import ts from 'typescript'

const source = fs.readFileSync(
  path.resolve('src/renderer/src/managers/video-export/StreamRecorder.ts'),
  'utf8'
)

function fixture(t, { unsupported = [], failFirstStart = false } = {}) {
  let recorder
  let tracksStopped = 0
  const attempts = []
  const timers = new Set()
  class MediaRecorder {
    static isTypeSupported(type) {
      return !unsupported.includes(type)
    }
    constructor(stream, options) {
      this.state = 'inactive'
      this.mimeType = options.mimeType
      this.options = options
      recorder = Object.assign(this, {})
      attempts.push(options.mimeType)
    }
    start() {
      if (failFirstStart && attempts.length === 1) throw new Error('Unsupported profile')
      this.state = 'recording'
    }
    stop() {
      this.state = 'inactive'
      this.ondataavailable?.({ data: new Blob(['final']) })
      this.onstop?.()
    }
  }
  const context = {
    exports: {},
    require: () => ({
      ExportLogger: class {
        info() {
          return undefined
        }
        warn() {
          return undefined
        }
        error() {
          return undefined
        }
      }
    }),
    MediaRecorder,
    Blob,
    Uint8Array,
    ArrayBuffer,
    Error,
    performance,
    setTimeout: (fn, delay) => {
      const id = setTimeout(() => {
        timers.delete(id)
        fn()
      }, delay)
      timers.add(id)
      return id
    },
    clearTimeout: (id) => {
      timers.delete(id)
      clearTimeout(id)
    }
  }
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    context
  )
  const canvas = {
    width: 1920,
    height: 1080,
    captureStream: () => ({
      getVideoTracks: () => [],
      getTracks: () => [{ stop: () => tracksStopped++ }]
    })
  }
  const instance = new context.exports.StreamRecorder({
    fps: 30,
    width: 1920,
    height: 1080,
    bitrate: 12_000_000,
    preferMp4: true
  })
  t.after(() => {
    instance.dispose()
    for (const timer of timers) clearTimeout(timer)
  })
  return {
    instance,
    canvas,
    attempts,
    get recorder() {
      return recorder
    },
    get tracksStopped() {
      return tracksStopped
    }
  }
}

test('record prefers efficient H.264 High over Baseline', (t) => {
  const f = fixture(t)
  f.instance.startRecording(f.canvas)
  assert.equal(f.recorder.mimeType, 'video/mp4;codecs=avc1.640028')
})

test('record retries a codec that advertises support but fails to start', (t) => {
  const f = fixture(t, { failFirstStart: true })
  assert.doesNotThrow(() => f.instance.startRecording(f.canvas))
  assert.ok(f.attempts.length > 1)
})

test('host sink receives all chunks in order, including the final chunk, without a fixed stop delay', async (t) => {
  const f = fixture(t)
  const chunks = []
  let release
  let started
  const firstStarted = new Promise((resolve) => {
    started = resolve
  })
  const gate = new Promise((resolve) => {
    release = resolve
  })
  await f.instance.startRecordingToSink(f.canvas, async (data) => {
    if (chunks.length === 0) {
      started()
      await gate
    }
    chunks.push(Buffer.from(data).toString())
  })
  f.recorder.ondataavailable({ data: new Blob(['first']) })
  await firstStarted
  f.recorder.ondataavailable({ data: new Blob(['second']) })
  const before = performance.now()
  const stop = f.instance.stopRecordingToSink()
  assert.deepEqual(chunks, [])
  release()
  await stop
  assert.deepEqual(chunks, ['first', 'second', 'final'])
  assert.ok(performance.now() - before < 400, 'stop must await final data, not sleep 500 ms')
  assert.equal(f.tracksStopped, 1)
})

test('sink errors fail export rather than returning partial video as success', async (t) => {
  const f = fixture(t)
  await f.instance.startRecordingToSink(f.canvas, async () => {
    throw new Error('write failed')
  })
  f.recorder.ondataavailable({ data: new Blob(['first']) })
  await assert.rejects(f.instance.stopRecordingToSink(), /write failed/)
})

test('slow host cannot accumulate an unbounded recording queue', async (t) => {
  const f = fixture(t)
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  await f.instance.startRecordingToSink(f.canvas, async () => gate)
  f.recorder.ondataavailable({
    data: { size: 65 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(1) }
  })
  release()
  await assert.rejects(f.instance.stopRecordingToSink(), /backlog/i)
})

test('dispose stops capture and prevents final chunks from being sent to a cancelled sink', async (t) => {
  const f = fixture(t)
  const chunks = []
  await f.instance.startRecordingToSink(f.canvas, async (data) => {
    chunks.push(data)
  })
  await f.instance.dispose()
  assert.deepEqual(chunks, [])
  assert.equal(f.tracksStopped, 1)
})
