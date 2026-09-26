import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import FakeTimers from '@sinonjs/fake-timers'
import { chromium } from 'playwright'
import { Logger } from 'tslog'
import { RenderPool } from '../out-host/host/pool/renderPool.js'

async function createPool(t, options = {}) {
  const clock = FakeTimers.install({
    now: 1_000_000,
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
  })
  const sent = []
  const results = []
  const browsers = []
  const config = {
    server: { port: 9881 },
    render: {
      workers: options.workers ?? 1,
      workerRecycleExports: 0,
      browserChannels: [],
      extraChromeArgs: '',
      minFreeMemoryMb: 0
    },
    tts: { characters: [] },
    bgm: { enabled: false }
  }
  const pool = new RenderPool(new Logger({ type: 'hidden' }), config, {
    send(workerId, message) {
      sent.push({ workerId, ...message })
      return options.send?.(message) ?? true
    },
    closeAll: () => undefined
  })
  pool.onExportResult = (taskId, result) => {
    results.push({ taskId, ...result })
    options.onResult?.(taskId, result, pool)
  }
  t.mock.method(chromium, 'launch', async () => {
    const browser = new EventEmitter()
    browser.connected = true
    browser.pages = []
    browser.isConnected = () => browser.connected
    browser.newPage = async () => {
      const page = {
        closed: false,
        goto: async (url) => {
          page.workerId = new URL(url).searchParams.get('worker')
          pool.handleWorkerReady(page.workerId)
        },
        evaluate: async () => 'Test GPU',
        close: async () => {
          if (page.closed) return
          page.closed = true
          pool.handleWorkerDisconnected(page.workerId)
        }
      }
      browser.pages.push(page)
      return page
    }
    browser.close = async () => {
      if (!browser.connected) return
      browser.connected = false
      for (const page of browser.pages) await page.close()
      browser.emit('disconnected')
    }
    browsers.push(browser)
    return browser
  })
  t.after(async () => {
    await pool.stop()
    clock.uninstall()
  })
  await pool.start()

  function task(taskId, timeoutMs = 1_800_000, addedAt = Date.now()) {
    return {
      taskId,
      addedAt,
      timeoutMs,
      story: { models: [], images: [], snippets: [] },
      outputPath: `${taskId}.mp4`,
      videoConfig: {}
    }
  }
  function complete(taskId) {
    pool.handleWorkerMessage('w1', {
      type: 'api:export-result',
      args: [{ taskId, success: true }]
    })
  }
  const starts = () => sent.filter((message) => message.type === 'api:start-export')
  const aborts = () => sent.filter((message) => message.type === 'api:abort-export')
  return { pool, clock, config, browsers, results, sent, starts, aborts, task, complete }
}

test('cancelled buffered work never consumes a worker', async (t) => {
  const f = await createPool(t)
  f.pool.dispatch(f.task('running'))
  f.pool.dispatch(f.task('cancelled'))
  f.pool.dispatch(f.task('next'))
  assert.equal(f.pool.stats().bufferedTasks, 2)
  f.pool.cancel('cancelled')
  assert.equal(f.pool.stats().bufferedTasks, 1)
  f.complete('running')
  assert.deepEqual(
    f.starts().map((message) => message.args[0].taskId),
    ['running', 'next']
  )
  assert.equal(f.aborts().length, 0)
})

test('unresponsive cancellation recycles within one grace period and immediately starts queued work', async (t) => {
  const f = await createPool(t)
  f.pool.dispatch(f.task('hung'))
  f.pool.cancel('hung')
  f.pool.dispatch(f.task('next'))
  assert.equal(f.aborts().length, 1)
  await f.clock.tickAsync(45_000)
  assert.equal(f.browsers.length, 1)
  assert.equal(f.starts().length, 1)
  // Duplicate cancellation must not postpone forced recovery.
  f.pool.cancel('hung')
  await f.clock.tickAsync(15_000)
  assert.equal(f.browsers[0].connected, false)
  assert.equal(f.browsers.length, 2)
  assert.deepEqual(f.pool.stats().busyTaskIds, ['next'])
  assert.equal(f.starts().length, 2)
  assert.equal(f.results.filter((result) => result.taskId === 'hung').length, 1)
})

test('graceful cancellation releases capacity without restarting the browser', async (t) => {
  const f = await createPool(t)
  f.pool.dispatch(f.task('cancelled'))
  f.pool.cancel('cancelled')
  f.pool.dispatch(f.task('next'))
  f.complete('cancelled')
  await f.clock.tickAsync(75_000)
  assert.equal(f.browsers.length, 1)
  assert.deepEqual(f.pool.stats().busyTaskIds, ['next'])
})

test('watchdog cannot dispatch a new task to the page it is about to destroy', async (t) => {
  let followup
  const f = await createPool(t, {
    onResult(taskId, _result, pool) {
      if (taskId === 'hung') pool.dispatch(followup)
    }
  })
  followup = f.task('next')
  f.pool.dispatch(f.task('hung', 15_000))
  await f.clock.tickAsync(75_000)
  assert.equal(f.results.length, 1)
  assert.equal(f.results[0].taskId, 'hung')
  assert.equal(f.browsers[0].connected, false)
  assert.equal(f.starts().length, 2)
  assert.deepEqual(f.pool.stats().busyTaskIds, ['next'])
})

test('queue time counts toward the watchdog deadline', async (t) => {
  const f = await createPool(t)
  f.pool.dispatch(f.task('aged', 60_000, Date.now() - 45_000))
  await f.clock.tickAsync(15_000)
  assert.equal(f.aborts().length, 1)
  await f.clock.tickAsync(60_000)
  assert.equal(f.results.length, 1)
  assert.equal(f.results[0].success, false)
})

test('expired buffered work is skipped when a worker becomes available', async (t) => {
  const f = await createPool(t)
  f.pool.dispatch(f.task('running'))
  f.pool.dispatch(f.task('expired', 1000))
  f.pool.dispatch(f.task('next'))
  await f.clock.tickAsync(2000)
  f.complete('running')
  assert.deepEqual(
    f.starts().map((message) => message.args[0].taskId),
    ['running', 'next']
  )
  assert.equal(f.results.find((result) => result.taskId === 'expired')?.success, false)
})

test('cancel also removes work deferred by the memory guard', async (t) => {
  const f = await createPool(t)
  f.config.render.minFreeMemoryMb = Number.MAX_SAFE_INTEGER
  f.pool.dispatch(f.task('cancelled'))
  f.pool.cancel('cancelled')
  f.config.render.minFreeMemoryMb = 0
  await f.clock.tickAsync(15_000)
  assert.equal(f.pool.stats().bufferedTasks, 0)
  assert.equal(f.starts().length, 0)
})

test('page recovery drains buffered work without waiting for the 15-second watchdog', async (t) => {
  const f = await createPool(t)
  f.pool.handleWorkerDisconnected('w1')
  f.pool.dispatch(f.task('next'))
  await f.clock.tickAsync(0)
  assert.equal(f.starts().length, 1)
  assert.deepEqual(f.pool.stats().busyTaskIds, ['next'])
})

test('stopping discards buffered work and does not relaunch workers', async (t) => {
  const f = await createPool(t)
  f.pool.dispatch(f.task('running'))
  f.pool.dispatch(f.task('next'))
  await f.pool.stop()
  await f.clock.tickAsync(120_000)
  assert.equal(f.pool.stats().bufferedTasks, 0)
  assert.equal(f.browsers.length, 1)
  assert.equal(f.starts().length, 1)
})

test('cancellation recovery leaves other workers and their exports running', async (t) => {
  const f = await createPool(t, { workers: 2 })
  f.pool.dispatch(f.task('hung'))
  f.pool.dispatch(f.task('healthy'))
  f.pool.dispatch(f.task('next'))
  f.pool.cancel('hung')
  await f.clock.tickAsync(60_000)
  assert.equal(f.browsers.length, 3)
  assert.equal(f.browsers[1].connected, true)
  assert.deepEqual(f.pool.stats().busyTaskIds, ['next', 'healthy'])
  assert.equal(f.results.length, 1)
  assert.equal(f.results[0].taskId, 'hung')
})

test('failed abort delivery still triggers bounded recovery', async (t) => {
  const f = await createPool(t, {
    send: (message) => message.type !== 'api:abort-export'
  })
  f.pool.dispatch(f.task('hung'))
  f.pool.cancel('hung')
  f.pool.dispatch(f.task('next'))
  await f.clock.tickAsync(60_000)
  assert.equal(f.browsers[0].connected, false)
  assert.deepEqual(f.pool.stats().busyTaskIds, ['next'])
})

test('late result from a cancelled export cannot release its replacement task', async (t) => {
  const f = await createPool(t)
  f.pool.dispatch(f.task('hung'))
  f.pool.cancel('hung')
  f.pool.dispatch(f.task('next'))
  await f.clock.tickAsync(60_000)
  f.complete('hung')
  assert.deepEqual(f.pool.stats().busyTaskIds, ['next'])
  assert.equal(f.results.length, 1)
})

test('scheduled recycling replaces the browser once and immediately resumes buffered work', async (t) => {
  const f = await createPool(t)
  f.config.render.workerRecycleExports = 1
  f.pool.dispatch(f.task('first'))
  f.pool.dispatch(f.task('next'))
  f.complete('first')
  await f.clock.tickAsync(0)
  assert.equal(f.browsers.length, 2)
  assert.equal(f.browsers[0].connected, false)
  assert.deepEqual(f.pool.stats().busyTaskIds, ['next'])
})
