import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import FakeTimers from '@sinonjs/fake-timers'
import { Logger } from 'tslog'
import { VideoApiServer } from '../../out-host/host/servers/VideoApiServer.js'

const story = { models: [], images: [], snippets: [] }
const DEFAULT_TIMEOUT = 1_800_000

async function createFixture(t) {
  const outputDir = mkdtempSync(path.join(tmpdir(), 'mss-api-test-'))
  const api = new VideoApiServer(new Logger({ type: 'hidden' }), {
    port: 0,
    host: '127.0.0.1',
    outputDir,
    video: { width: 1280, height: 720, fps: 30 },
    maxConcurrentExports: 1
  })
  const dispatched = []
  const cancelled = []
  api.setDispatcher({
    dispatch: (task) => dispatched.push(task),
    cancel: (taskId) => cancelled.push(taskId)
  })
  await api.start()
  const server = api.getHttpServer()
  const port = server.address().port
  // Only fake export timers; HTTP I/O and the cleanup interval keep running normally.
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  t.after(async () => {
    const closed = server.listening ? once(server, 'close') : Promise.resolve()
    api.stop()
    server.closeAllConnections()
    await closed
    clock.uninstall()
    rmSync(outputDir, { recursive: true, force: true })
  })

  function request(route, body) {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: `/api/v1/${route}`,
      method: body === undefined ? 'GET' : 'POST',
      agent: false,
      headers: body === undefined ? {} : { 'content-type': 'application/json' }
    })
    const response = new Promise((resolve, reject) => {
      req.on('error', reject)
      req.on('response', (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (data += chunk))
        res.on('error', reject)
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }))
      })
    })
    req.end(body === undefined ? undefined : JSON.stringify(body))
    return { req, response }
  }

  async function waitForStatus(predicate) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const { body } = await request('status').response
      if (predicate(body)) return body
    }
    assert.fail('API did not reach the expected queue state')
  }

  return { api, clock, dispatched, cancelled, request, waitForStatus }
}

test('rejects invalid timeout values before dispatching or creating a timer', async (t) => {
  const fixture = await createFixture(t)
  for (const timeout of [0, -1, 1.5, '1000', null, true, {}, 2_147_483_648, 1e100]) {
    const result = await fixture.request('export', { story, timeout }).response
    assert.equal(result.status, 400, `timeout=${JSON.stringify(timeout)}`)
    assert.equal(result.body.success, false)
    assert.match(result.body.message, /timeout/i)
  }
  assert.equal(fixture.dispatched.length, 0)
  assert.equal(fixture.clock.countTimers(), 0)
})

test('missing request body returns a client error', async (t) => {
  const fixture = await createFixture(t)
  const req = http.request({
    host: '127.0.0.1',
    port: fixture.api.getHttpServer().address().port,
    path: '/api/v1/export',
    method: 'POST',
    agent: false
  })
  const response = once(req, 'response')
  req.end()
  const [res] = await response
  res.resume()
  await once(res, 'end')
  assert.equal(res.statusCode, 400)
  assert.equal(fixture.dispatched.length, 0)
})

test('successful export keeps the default timeout and clears its timer', async (t) => {
  const fixture = await createFixture(t)
  const pending = fixture.request('export', { story })
  await fixture.waitForStatus((status) => status.activeExports === 1)
  const [task] = fixture.dispatched
  assert.equal(task.timeoutMs, DEFAULT_TIMEOUT)
  assert.equal(fixture.clock.countTimers(), 1)
  writeFileSync(task.outputPath, 'test video')
  fixture.api.resolveExport(task.taskId, { success: true, videoPath: task.outputPath })
  const result = await pending.response
  assert.equal(result.status, 200)
  assert.equal(result.body.success, true)
  assert.equal(fixture.clock.countTimers(), 0)
})

test('worker failure clears the timeout and allows the next export to start', async (t) => {
  const fixture = await createFixture(t)
  const first = fixture.request('export', { story })
  await fixture.waitForStatus((status) => status.activeExports === 1)
  const second = fixture.request('export', { story })
  await fixture.waitForStatus((status) => status.queuedExports === 1)
  fixture.api.rejectExport(fixture.dispatched[0].taskId, new Error('Worker crashed'))
  const result = await first.response
  assert.equal(result.status, 500)
  assert.equal(result.body.message, 'Worker crashed')
  assert.equal(fixture.dispatched.length, 2)
  assert.equal(fixture.clock.countTimers(), 1)
  fixture.api.rejectExport(fixture.dispatched[1].taskId, new Error('Worker crashed'))
  await second.response
  assert.equal(fixture.clock.countTimers(), 0)
})

test('queued and active cancellation both clear their timeout timers', async (t) => {
  const fixture = await createFixture(t)
  const first = fixture.request('export', { story })
  await fixture.waitForStatus((status) => status.activeExports === 1)
  const second = fixture.request('export', { story })
  const status = await fixture.waitForStatus((status) => status.queuedExports === 1)
  for (const [taskId, pending, timersLeft] of [
    [status.queuedTaskIds[0], second, 1],
    [status.activeTaskIds[0], first, 0]
  ]) {
    const result = await fixture.request(`export/${taskId}/cancel`, {}).response
    assert.equal(result.body.cancelled, true)
    assert.match((await pending.response).body.message, /cancelled/)
    assert.equal(fixture.clock.countTimers(), timersLeft)
  }
  assert.equal(fixture.dispatched.length, 1)
  assert.equal(fixture.api.hasActiveExports(), false)
})

test('client disconnect cancels the export and clears its timer', async (t) => {
  const fixture = await createFixture(t)
  const pending = fixture.request('export', { story })
  const disconnected = assert.rejects(pending.response, /socket hang up/)
  await fixture.waitForStatus((status) => status.activeExports === 1)
  pending.req.destroy()
  await disconnected
  await fixture.waitForStatus((status) => status.pendingExports === 0)
  assert.deepEqual(fixture.cancelled, [fixture.dispatched[0].taskId])
  assert.equal(fixture.clock.countTimers(), 0)
})

test('custom timeout expires at its deadline and cancels the export', async (t) => {
  const fixture = await createFixture(t)
  const pending = fixture.request('export', { story, timeout: 1000 })
  await fixture.waitForStatus((status) => status.activeExports === 1)
  assert.equal(fixture.dispatched[0].timeoutMs, 1000)
  await fixture.clock.tickAsync(999)
  assert.equal(fixture.api.hasActiveExports(), true)
  await fixture.clock.tickAsync(1)
  const result = await pending.response
  assert.equal(result.status, 500)
  assert.match(result.body.message, /timed out after 1 seconds/)
  assert.deepEqual(fixture.cancelled, [fixture.dispatched[0].taskId])
  assert.equal(fixture.api.hasActiveExports(), false)
  assert.equal(fixture.clock.countTimers(), 0)
})

test('maximum supported timeout does not overflow into immediate cancellation', async (t) => {
  const fixture = await createFixture(t)
  const pending = fixture.request('export', { story, timeout: 2_147_483_647 })
  await fixture.waitForStatus((status) => status.activeExports === 1)
  assert.equal(fixture.dispatched[0].timeoutMs, 2_147_483_647)
  await fixture.clock.tickAsync(1)
  assert.equal(fixture.api.hasActiveExports(), true)
  fixture.api.rejectExport(fixture.dispatched[0].taskId, new Error('Worker crashed'))
  await pending.response
  assert.equal(fixture.clock.countTimers(), 0)
})

test('shutdown rejects pending requests and clears their timers', async (t) => {
  const fixture = await createFixture(t)
  const pending = fixture.request('export', { story })
  await fixture.waitForStatus((status) => status.activeExports === 1)
  fixture.api.stop()
  assert.match((await pending.response).body.message, /shutting down/)
  assert.equal(fixture.clock.countTimers(), 0)
})
