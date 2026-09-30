import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import FakeTimers from '@sinonjs/fake-timers'
import express from 'express'
import { Logger } from 'tslog'
import { createBridgeRouter } from '../../out-host/host/bridge/bridgeRoutes.js'

const require = createRequire(import.meta.url)
const ffmpeg = require('../../out-host/shared/ffmpeg.js')
const dimensions = { inputWidth: 1920, inputHeight: 1080 }

async function exists(file) {
  return stat(file).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false
      throw error
    }
  )
}

async function waitFor(predicate, message = 'expected lifecycle state') {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await predicate()) return
    await delay(5)
  }
  assert.fail(message)
}

function success(response) {
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(response.body.ok, true, JSON.stringify(response.body))
  return response.body.result
}

function failure(response, pattern) {
  assert.ok(response.status >= 400, JSON.stringify(response))
  assert.equal(response.body.ok, false)
  assert.match(response.body.error, pattern)
}

async function createFixture(t, { workers = 1, idleTimeoutMs, hooks = {} } = {}) {
  const calls = []
  const ids = new Set()
  const gates = []
  const extraDirectories = []
  const config = {
    video: { width: 1280, height: 720, fps: 30, crf: 19, encoder: 'cpu' },
    render: { workers }
  }
  const createEncoding = async (options) => {
    const entry = {
      options,
      id: randomUUID(),
      inputPath: path.join(options.directory, 'capture.bin'),
      outputPath: path.join(options.directory, 'encoded.mp4'),
      chunks: [],
      appendCalls: 0,
      finishCalls: 0,
      cancelCalls: 0,
      cancelled: false
    }
    calls.push(entry)
    await writeFile(entry.inputPath, '')
    await writeFile(entry.outputPath, 'encoded video')
    await hooks.create?.(entry)
    let queue = Promise.resolve()
    return {
      id: entry.id,
      inputPath: entry.inputPath,
      outputPath: entry.outputPath,
      append(bytes) {
        assert.ok(Buffer.isBuffer(bytes))
        entry.appendCalls++
        const pending = queue.then(async () => {
          await hooks.append?.(entry, bytes)
          if (entry.cancelled) throw new Error('Fixture encoding cancelled')
          await appendFile(entry.inputPath, bytes)
          entry.chunks.push(Buffer.from(bytes))
        })
        queue = pending.catch(() => {})
        return pending
      },
      async finish() {
        entry.finishCalls++
        await queue
        await hooks.finish?.(entry)
        // Deliberately allow a late result after cancellation: the registry must guard it too.
        return { videoPath: entry.outputPath, frameCount: 123, durationMs: 4100 }
      },
      async cancel() {
        entry.cancelCalls++
        entry.cancelled = true
        await hooks.cancel?.(entry)
        await queue
        await Promise.all(
          [entry.inputPath, entry.outputPath].map((file) => rm(file, { force: true }))
        )
      }
    }
  }

  const app = express()
  app.use(
    '/bridge',
    createBridgeRouter({
      logger: new Logger({ type: 'hidden' }),
      config,
      recordSessionOptions: {
        createEncoding,
        ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs })
      }
    })
  )
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  // Exercise real Express and HTTP; only the registry's deadlines use a virtual clock.
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })

  function request(channel, payload, bytes) {
    const binary = bytes !== undefined
    const args = JSON.stringify([payload])
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      agent: false,
      path: `/bridge/${binary ? 'bin' : 'invoke'}/${encodeURIComponent(channel)}${binary ? `?args=${encodeURIComponent(args)}` : ''}`,
      headers: { 'content-type': binary ? 'application/octet-stream' : 'application/json' }
    })
    const response = new Promise((resolve, reject) => {
      req.on('error', reject)
      req.on('response', (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('error', reject)
        res.on('end', () => {
          try {
            const body = JSON.parse(text)
            if (channel === 'electron:record-start' && body.ok) ids.add(body.result.id)
            resolve({ status: res.statusCode, body })
          } catch (error) {
            reject(error)
          }
        })
      })
    })
    req.end(binary ? bytes : args)
    return { req, response }
  }
  const invoke = (channel, payload) => request(`electron:${channel}`, payload).response
  const chunk = (id, bytes) => request('electron:record-chunk', { id }, bytes).response
  const gate = () => {
    let resolve
    const promise = new Promise((done) => {
      resolve = done
    })
    const result = { promise, resolve }
    gates.push(result)
    return result
  }

  t.after(async () => {
    for (const barrier of gates) barrier.resolve()
    await Promise.allSettled([...ids].map((id) => invoke('record-cancel', { id })))
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
    await clock.tickAsync((idleTimeoutMs ?? 120_000) + 1)
    clock.uninstall()
    await Promise.all(
      [...calls.map((entry) => entry.options.directory), ...extraDirectories].map((directory) =>
        rm(directory, { recursive: true, force: true })
      )
    )
  })

  async function files() {
    const directory = await mkdtemp(path.join(tmpdir(), 'mss-bridge-test-'))
    extraDirectories.push(directory)
    return directory
  }
  return { calls, config, clock, request, invoke, chunk, gate, files }
}

test('record endpoints stream exact binary chunks using trusted host settings and preserve finished files until cancel', async (t) => {
  const fixture = await createFixture(t)
  const started = success(
    await fixture.invoke('record-start', {
      ...dimensions,
      width: 2,
      height: 2,
      fps: 1,
      crf: 51,
      encoder: 'untrusted',
      directory: '../untrusted'
    })
  )
  assert.deepEqual(Object.keys(started), ['id'])
  assert.match(started.id, /^[a-f0-9-]{36}$/i)
  const entry = fixture.calls[0]
  assert.deepEqual(entry.options, {
    directory: entry.options.directory,
    ...dimensions,
    ...fixture.config.video
  })
  assert.equal(path.dirname(entry.options.directory), tmpdir())
  assert.match(path.basename(entry.options.directory), /^mss-record-/)
  const chunks = [Buffer.from([0, 255, 1, 128]), Buffer.from('second\0chunk')]
  for (const bytes of chunks) assert.equal(success(await fixture.chunk(started.id, bytes)), null)
  assert.deepEqual(
    await readFile(entry.inputPath),
    Buffer.concat(chunks),
    'capture is written before finish'
  )
  assert.deepEqual(entry.chunks, chunks)
  const expected = { videoPath: entry.outputPath, frameCount: 123, durationMs: 4100 }
  assert.deepEqual(success(await fixture.invoke('record-finish', started)), expected)
  assert.equal(await exists(entry.inputPath), true)
  assert.equal(await exists(entry.outputPath), true)
  assert.deepEqual(success(await fixture.invoke('record-finish', started)), expected)
  assert.equal(entry.finishCalls, 1)
  failure(await fixture.chunk(started.id, Buffer.from('late')), /finish|closed/i)
  assert.deepEqual(await readFile(entry.inputPath), Buffer.concat(chunks))
  assert.equal(success(await fixture.invoke('record-cancel', started)), null)
  assert.equal(await exists(entry.options.directory), false)
  assert.equal(success(await fixture.invoke('record-cancel', started)), null)
  assert.equal(entry.cancelCalls, 1)
})

test('invalid dimensions fail before allocating an encoder; boundary pixel dimensions are accepted', async (t) => {
  const fixture = await createFixture(t)
  const invalid = [undefined, null, {}, [], { inputWidth: 640 }]
  for (const key of ['inputWidth', 'inputHeight']) {
    for (const value of [0, -1, 1.5, 16385, NaN, Infinity, '640', true, null, {}]) {
      invalid.push({ ...dimensions, [key]: value })
    }
  }
  for (const payload of invalid)
    failure(await fixture.invoke('record-start', payload), /dimension|inputWidth|inputHeight/i)
  assert.equal(fixture.calls.length, 0)
  for (const payload of [
    { inputWidth: 1, inputHeight: 16384 },
    { inputWidth: 16384, inputHeight: 1 }
  ]) {
    const started = success(await fixture.invoke('record-start', payload))
    await fixture.invoke('record-cancel', started)
  }
})

test('invalid and unknown session ids cannot append or finish; valid unknown cancel is an idempotent no-op', async (t) => {
  const fixture = await createFixture(t)
  for (const id of [undefined, null, '', '../file', 4, {}, []]) {
    failure(await fixture.chunk(id, Buffer.from('orphan')), /session.*id|id.*session/i)
    failure(await fixture.invoke('record-finish', { id }), /session.*id|id.*session/i)
    failure(await fixture.invoke('record-cancel', { id }), /session.*id|id.*session/i)
  }
  const id = randomUUID()
  failure(await fixture.chunk(id, Buffer.from('orphan')), /unknown.*session|session.*not found/i)
  failure(await fixture.invoke('record-finish', { id }), /unknown.*session|session.*not found/i)
  assert.equal(success(await fixture.invoke('record-cancel', { id })), null)
  assert.equal(fixture.calls.length, 0)
})

test('in-flight creation and finished sessions reserve worker capacity; separate sessions have unique directories', async (t) => {
  let createGate
  const fixture = await createFixture(t, { hooks: { create: () => createGate.promise } })
  createGate = fixture.gate()
  const pending = fixture.request('electron:record-start', dimensions)
  await waitFor(() => fixture.calls.length === 1)
  failure(await fixture.invoke('record-start', dimensions), /limit|capacity|active/i)
  assert.equal(fixture.calls.length, 1)
  createGate.resolve()
  const first = success(await pending.response)
  success(await fixture.invoke('record-finish', first))
  failure(await fixture.invoke('record-start', dimensions), /limit|capacity|active/i)
  success(await fixture.invoke('record-cancel', first))
  const second = success(await fixture.invoke('record-start', dimensions))
  assert.notEqual(first.id, second.id)
  assert.notEqual(fixture.calls[0].options.directory, fixture.calls[1].options.directory)
})

test('creation failures remove the caller-owned directory and release worker capacity', async (t) => {
  let shouldFail = true
  const fixture = await createFixture(t, {
    hooks: {
      create() {
        if (shouldFail) throw new Error('create failed')
      }
    }
  })
  failure(await fixture.invoke('record-start', dimensions), /create failed/)
  assert.equal(await exists(fixture.calls[0].options.directory), false)
  shouldFail = false
  success(await fixture.invoke('record-start', dimensions))
})

test('an aborted HTTP start cancels a late-created encoder and removes its directory without waiting for TTL', async (t) => {
  let createGate
  const fixture = await createFixture(t, { hooks: { create: () => createGate.promise } })
  createGate = fixture.gate()
  const pending = fixture.request('electron:record-start', dimensions)
  const disconnected = assert.rejects(pending.response, /socket hang up/)
  await waitFor(() => fixture.calls.length === 1)
  pending.req.destroy()
  await disconnected
  createGate.resolve()
  await waitFor(
    () => fixture.calls[0].cancelCalls === 1,
    'aborted start must cancel its late result'
  )
  await waitFor(async () => !(await exists(fixture.calls[0].options.directory)))
  success(await fixture.invoke('record-start', dimensions))
})

test('an aborted HTTP start also removes its directory when delayed encoder creation fails', async (t) => {
  let createGate
  const fixture = await createFixture(t, {
    hooks: {
      async create() {
        await createGate.promise
        throw new Error('late creation failure')
      }
    }
  })
  createGate = fixture.gate()
  const pending = fixture.request('electron:record-start', dimensions)
  const disconnected = assert.rejects(pending.response, /socket hang up/)
  await waitFor(() => fixture.calls.length === 1)
  pending.req.destroy()
  await disconnected
  // A round trip ensures the server has observed the abort while creation remains pending.
  failure(await fixture.invoke('record-start', dimensions), /capacity/i)
  createGate.resolve()
  await waitFor(
    async () => !(await exists(fixture.calls[0].options.directory)),
    'failed creation after disconnect must remove the owned directory'
  )
  assert.equal(fixture.calls[0].cancelCalls, 0)
  failure(await fixture.invoke('record-start', dimensions), /late creation failure/)
  assert.equal(fixture.calls.length, 2, 'failed aborted creation must release capacity')
})

test('binary chunk responses respect encoder backpressure and finish drains accepted chunks in order', async (t) => {
  let appendGate
  const fixture = await createFixture(t, { hooks: { append: () => appendGate.promise } })
  appendGate = fixture.gate()
  const started = success(await fixture.invoke('record-start', dimensions))
  let appendSettled = false
  const first = fixture.chunk(started.id, Buffer.from('first')).finally(() => {
    appendSettled = true
  })
  await waitFor(() => fixture.calls[0].appendCalls === 1)
  const second = fixture.chunk(started.id, Buffer.from('second'))
  await waitFor(() => fixture.calls[0].appendCalls === 2)
  assert.equal(appendSettled, false)
  const finishing = fixture.invoke('record-finish', started)
  await waitFor(() => fixture.calls[0].finishCalls === 1)
  failure(await fixture.chunk(started.id, Buffer.from('too late')), /finish|closed/i)
  appendGate.resolve()
  assert.equal(success(await first), null)
  assert.equal(success(await second), null)
  success(await finishing)
  assert.equal(await readFile(fixture.calls[0].inputPath, 'utf8'), 'firstsecond')
})

test('cancel racing finish is idempotent, awaits actual cleanup, and prevents late success', async (t) => {
  let finishGate
  let cancelGate
  const fixture = await createFixture(t, {
    hooks: {
      finish: () => finishGate.promise,
      cancel: () => cancelGate.promise
    }
  })
  finishGate = fixture.gate()
  cancelGate = fixture.gate()
  const started = success(await fixture.invoke('record-start', dimensions))
  const finishing = fixture.invoke('record-finish', started)
  await waitFor(() => fixture.calls[0].finishCalls === 1)
  let cancelled = false
  const first = fixture.invoke('record-cancel', started).finally(() => {
    cancelled = true
  })
  const second = fixture.invoke('record-cancel', started)
  await waitFor(() => fixture.calls[0].cancelCalls === 1)
  assert.equal(cancelled, false)
  failure(await fixture.chunk(started.id, Buffer.from('late')), /cancel|closed/i)
  failure(await fixture.invoke('record-start', dimensions), /limit|capacity|active/i)
  cancelGate.resolve()
  assert.equal(success(await first), null)
  assert.equal(success(await second), null)
  assert.equal(fixture.calls[0].cancelCalls, 1)
  finishGate.resolve()
  failure(await finishing, /cancel/i)
  assert.equal(await exists(fixture.calls[0].options.directory), false)
  failure(await fixture.invoke('record-finish', started), /unknown.*session|session.*not found/i)
  success(await fixture.invoke('record-start', dimensions))
})

test('page loss expires a session after a sliding 120-second idle deadline', async (t) => {
  const fixture = await createFixture(t)
  const started = success(await fixture.invoke('record-start', dimensions))
  await fixture.clock.tickAsync(119_999)
  assert.equal(fixture.calls[0].cancelCalls, 0)
  assert.equal(success(await fixture.chunk(started.id, Buffer.from('keep alive'))), null)
  await fixture.clock.tickAsync(119_999)
  assert.equal(fixture.calls[0].cancelCalls, 0)
  await fixture.clock.tickAsync(1)
  await waitFor(async () => !(await exists(fixture.calls[0].options.directory)))
  assert.equal(fixture.calls[0].cancelCalls, 1)
  failure(
    await fixture.chunk(started.id, Buffer.from('late')),
    /unknown.*session|session.*not found/i
  )
  assert.equal(success(await fixture.invoke('record-cancel', started)), null)
  success(await fixture.invoke('record-start', dimensions))
})

test('finish suspends recording TTL, then gives retained outputs a new leak-cleanup deadline', async (t) => {
  let finishGate
  const fixture = await createFixture(t, {
    idleTimeoutMs: 1000,
    hooks: { finish: () => finishGate.promise }
  })
  finishGate = fixture.gate()
  const started = success(await fixture.invoke('record-start', dimensions))
  await fixture.clock.tickAsync(999)
  const finishing = fixture.invoke('record-finish', started)
  await waitFor(() => fixture.calls[0].finishCalls === 1)
  await fixture.clock.tickAsync(60_000)
  assert.equal(fixture.calls[0].cancelCalls, 0, 'encoder owns the bounded finish timeout')
  finishGate.resolve()
  success(await finishing)
  await fixture.clock.tickAsync(999)
  assert.equal(await exists(fixture.calls[0].outputPath), true)
  await fixture.clock.tickAsync(1)
  await waitFor(async () => !(await exists(fixture.calls[0].options.directory)))
  assert.equal(fixture.calls[0].cancelCalls, 1)
})

for (const operation of ['append', 'finish']) {
  test(`${operation} failure tears down the encoder and releases the slot`, async (t) => {
    const fixture = await createFixture(t, {
      hooks: {
        [operation]() {
          throw new Error(`${operation} failed`)
        }
      }
    })
    const started = success(await fixture.invoke('record-start', dimensions))
    const response =
      operation === 'append'
        ? await fixture.chunk(started.id, Buffer.from('data'))
        : await fixture.invoke('record-finish', started)
    failure(response, new RegExp(`${operation} failed`))
    assert.equal(fixture.calls[0].cancelCalls, 1)
    assert.equal(await exists(fixture.calls[0].options.directory), false)
    success(await fixture.invoke('record-start', dimensions))
  })

  test(`disconnecting an in-flight ${operation} cancels the session without waiting for TTL`, async (t) => {
    let operationGate
    const fixture = await createFixture(t, {
      hooks: {
        [operation]: () => operationGate.promise,
        cancel: () => operationGate.resolve()
      }
    })
    operationGate = fixture.gate()
    const started = success(await fixture.invoke('record-start', dimensions))
    const pending = fixture.request(
      `electron:record-${operation === 'append' ? 'chunk' : 'finish'}`,
      started,
      operation === 'append' ? Buffer.from('data') : undefined
    )
    const disconnected = assert.rejects(pending.response, /socket hang up/)
    await waitFor(() => fixture.calls[0][`${operation}Calls`] === 1)
    pending.req.destroy()
    await disconnected
    await waitFor(() => fixture.calls[0].cancelCalls === 1)
    await waitFor(async () => !(await exists(fixture.calls[0].options.directory)))
  })
}

test('cleanup errors still remove the owned directory and release worker capacity', async (t) => {
  const fixture = await createFixture(t, {
    hooks: {
      cancel() {
        throw new Error('cancel failed')
      }
    }
  })
  const started = success(await fixture.invoke('record-start', dimensions))
  failure(await fixture.invoke('record-cancel', started), /cancel failed/)
  assert.equal(await exists(fixture.calls[0].options.directory), false)
  assert.equal(success(await fixture.invoke('record-cancel', started)), null)
  success(await fixture.invoke('record-start', dimensions))
})

test('failed temporary directory removal cannot permanently occupy worker capacity', async (t) => {
  const fixture = await createFixture(t)
  const started = success(await fixture.invoke('record-start', dimensions))
  const target = fixture.calls[0].options.directory
  const fsPromises = require('node:fs/promises')
  const original = fsPromises.rm
  t.mock.method(fsPromises, 'rm', async (file, options) => {
    if (file === target) throw Object.assign(new Error('directory busy'), { code: 'EBUSY' })
    return original(file, options)
  })
  failure(await fixture.invoke('record-cancel', started), /directory busy/)
  success(await fixture.invoke('record-start', dimensions))
  fsPromises.rm.mock.restore()
  await rm(target, { recursive: true, force: true })
})

test('record-mux refuses to overwrite an existing final output', async (t) => {
  const fixture = await createFixture(t)
  const outputPath = path.join(await fixture.files(), 'existing.mp4')
  await writeFile(outputPath, 'previous export')
  const started = success(await fixture.invoke('record-start', dimensions))
  success(await fixture.invoke('record-finish', started))
  failure(
    await fixture.invoke('record-mux', { ...started, outputPath, audioBitrate: '128k' }),
    /exist/i
  )
  assert.equal(await readFile(outputPath, 'utf8'), 'previous export')
})

test('record-mux uses only the finished session video and retains completed output after cancel', async (t) => {
  const fixture = await createFixture(t)
  const directory = await fixture.files()
  const outputPath = path.join(directory, 'final.mp4')
  const started = success(await fixture.invoke('record-start', dimensions))
  failure(
    await fixture.invoke('record-mux', { ...started, outputPath, audioBitrate: '128k' }),
    /finish/i
  )
  success(await fixture.invoke('record-finish', started))
  const muxModule = require('../../out-host/host/record/recordMux.js')
  const calls = []
  t.mock.method(muxModule, 'muxRecordVideo', async (options) => {
    calls.push(options)
    await writeFile(options.outputPath, await readFile(options.videoPath))
    return { success: true, outputPath: options.outputPath, fileSize: 13 }
  })
  const result = success(
    await fixture.invoke('record-mux', {
      ...started,
      videoPath: 'untrusted.mp4',
      outputPath,
      audioBitrate: '160k'
    })
  )
  assert.deepEqual(result, { success: true, outputPath, fileSize: 13 })
  assert.equal(calls[0].videoPath, fixture.calls[0].outputPath)
  assert.equal(calls[0].audioBitrate, '160k')
  failure(await fixture.invoke('record-start', dimensions), /capacity/i)
  success(await fixture.invoke('record-cancel', started))
  assert.equal(await readFile(outputPath, 'utf8'), 'encoded video')
  assert.equal(await exists(fixture.calls[0].options.directory), false)
})

for (const disconnect of [false, true]) {
  test(`record-mux ${disconnect ? 'disconnect' : 'cancel'} waits for mux teardown before removing sources and partial output`, async (t) => {
    const fixture = await createFixture(t)
    const outputPath = path.join(await fixture.files(), 'partial.mp4')
    const started = success(await fixture.invoke('record-start', dimensions))
    success(await fixture.invoke('record-finish', started))
    const muxModule = require('../../out-host/host/record/recordMux.js')
    const teardown = fixture.gate()
    let muxStarted = false
    let aborted = false
    t.mock.method(muxModule, 'muxRecordVideo', async (options) => {
      await writeFile(options.outputPath, 'partial')
      muxStarted = true
      options.signal.addEventListener(
        'abort',
        () => {
          aborted = true
        },
        { once: true }
      )
      await teardown.promise
      if (options.signal.aborted) throw new Error('Mux cancelled')
      return { success: true, outputPath, fileSize: 7 }
    })
    const pending = fixture.request('electron:record-mux', {
      ...started,
      outputPath,
      audioBitrate: '128k'
    })
    const disconnected = disconnect ? assert.rejects(pending.response, /socket hang up/) : undefined
    await waitFor(() => muxStarted)
    await fixture.clock.tickAsync(120_001)
    assert.equal(
      fixture.calls[0].cancelCalls,
      0,
      'active mux must not use the recording idle timeout'
    )
    let cancelled = false
    let cancelling
    if (disconnect) {
      pending.req.destroy()
      await disconnected
    } else {
      cancelling = fixture.invoke('record-cancel', started).finally(() => {
        cancelled = true
      })
    }
    await waitFor(() => aborted)
    assert.equal(cancelled, false)
    assert.equal(fixture.calls[0].cancelCalls, 0, 'input must remain open until mux process closes')
    assert.equal(await exists(fixture.calls[0].outputPath), true)
    failure(await fixture.invoke('record-start', dimensions), /capacity/i)
    teardown.resolve()
    if (cancelling) success(await cancelling)
    if (!disconnect) failure(await pending.response, /cancel/i)
    await waitFor(async () => !(await exists(fixture.calls[0].options.directory)))
    assert.equal(await exists(outputPath), false)
    assert.equal(fixture.calls[0].cancelCalls, 1)
    success(await fixture.invoke('record-start', dimensions))
  })
}

test('fast remux keeps copy/mux routing, result shape, and existing keepInputs cleanup semantics', async (t) => {
  const fixture = await createFixture(t)
  const directory = await fixture.files()
  const calls = []
  t.mock.method(ffmpeg, 'apiCopyVideo', async (...args) => {
    calls.push(['copy', ...args])
    await writeFile(args[1], await readFile(args[0]))
  })
  t.mock.method(ffmpeg, 'apiMuxVideoAudioCopy', async (...args) => {
    calls.push(['mux', ...args])
    await writeFile(args[2], Buffer.concat([await readFile(args[0]), await readFile(args[1])]))
  })
  for (const audio of [false, true]) {
    for (const keepInputs of [false, true]) {
      const payload = {
        videoPath: path.join(directory, 'video.mp4'),
        ...(audio ? { audioPath: path.join(directory, 'audio.wav') } : {}),
        outputPath: path.join(directory, 'output.mp4'),
        audioBitrate: '160k',
        keepInputs
      }
      await writeFile(payload.videoPath, 'video')
      if (audio) await writeFile(payload.audioPath, 'audio')
      const result = success(await fixture.invoke('api-remux-video-from-files', payload))
      assert.deepEqual(result, {
        success: true,
        outputPath: payload.outputPath,
        fileSize: audio ? 10 : 5,
        sizeCapped: false
      })
      assert.deepEqual(
        calls.at(-1),
        audio
          ? ['mux', payload.videoPath, payload.audioPath, payload.outputPath, '160k']
          : ['copy', payload.videoPath, payload.outputPath]
      )
      assert.equal(await exists(payload.videoPath), keepInputs)
      if (audio) assert.equal(await exists(payload.audioPath), keepInputs)
    }
  }
  assert.equal(fixture.calls.length, 0, 'fast remux must not allocate record sessions')
})

test('obsolete record sizeCap payload can never change remux into a second video encode', async (t) => {
  const fixture = await createFixture(t)
  const directory = await fixture.files()
  let copied = 0
  t.mock.method(ffmpeg, 'apiCopyVideo', async (input, output) => {
    copied++
    await writeFile(output, await readFile(input))
  })
  if (typeof ffmpeg.apiEncodeVideoAudioToBitrate === 'function') {
    t.mock.method(ffmpeg, 'apiEncodeVideoAudioToBitrate', async () => {
      throw new Error('unexpected second encode')
    })
  }
  const payload = {
    videoPath: path.join(directory, 'video.mp4'),
    outputPath: path.join(directory, 'output.mp4'),
    audioBitrate: '128k',
    keepInputs: true,
    sizeCap: { maxBytes: 100_000, durationSec: 1 }
  }
  await writeFile(payload.videoPath, Buffer.alloc(200_000))
  const result = success(await fixture.invoke('api-remux-video-from-files', payload))
  assert.deepEqual(result, {
    success: true,
    outputPath: payload.outputPath,
    fileSize: 200_000,
    sizeCapped: false
  })
  assert.equal(copied, 1)
  assert.equal(await exists(payload.videoPath), true)
})

test('remux errors still return a successful bridge envelope with a failed result and honor keepInputs', async (t) => {
  const fixture = await createFixture(t)
  const directory = await fixture.files()
  t.mock.method(ffmpeg, 'apiCopyVideo', async () => {
    throw new Error('mux failed')
  })
  for (const keepInputs of [false, true]) {
    const payload = {
      videoPath: path.join(directory, 'video.mp4'),
      outputPath: path.join(directory, 'out.mp4'),
      keepInputs
    }
    await writeFile(payload.videoPath, 'video')
    assert.deepEqual(success(await fixture.invoke('api-remux-video-from-files', payload)), {
      success: false,
      error: 'mux failed'
    })
    assert.equal(await exists(payload.videoPath), keepInputs)
  }
})
