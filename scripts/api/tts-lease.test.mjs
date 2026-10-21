import test from 'node:test'
import assert from 'node:assert/strict'
import { TtsLeaseManager } from '../../out-host/host/tts/TtsLeaseManager.js'

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {}
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function manager(options = {}) {
  return new TtsLeaseManager(silentLogger, {
    leaseTtlMs: 5000,
    idleResetMs: 100000,
    acquireTimeoutMs: 5000,
    ...options
  })
}

test('租约按 FIFO 发放，释放时回报权重', async () => {
  const m = manager()
  try {
    const first = await m.acquire()
    assert.equal(first.currentWeights, null)

    let secondGranted = false
    const secondPromise = m.acquire().then((grant) => {
      secondGranted = true
      return grant
    })

    await delay(30)
    assert.equal(secondGranted, false, '第二个租约必须排队')

    const weights = { gptWeightsPath: 'g.ckpt', sovitsWeightsPath: 's.pth' }
    m.release(first.leaseId, weights)

    const second = await secondPromise
    assert.deepEqual(second.currentWeights, weights)
    m.release(second.leaseId)
  } finally {
    m.dispose()
  }
})

test('空闲超过 idleResetMs 后强制重切权重', async () => {
  const m = manager({ idleResetMs: 40 })
  try {
    const first = await m.acquire()
    m.release(first.leaseId, { gptWeightsPath: 'g.ckpt', sovitsWeightsPath: 's.pth' })

    await delay(70)
    const second = await m.acquire()
    assert.equal(second.currentWeights, null)
    m.release(second.leaseId)
  } finally {
    m.dispose()
  }
})

test('租约超时自动释放并作废权重缓存', async () => {
  const m = manager({ leaseTtlMs: 40 })
  try {
    const first = await m.acquire()
    assert.equal(first.currentWeights, null)

    await delay(80)
    const second = await m.acquire()
    assert.notEqual(second.leaseId, first.leaseId)
    assert.equal(second.currentWeights, null, '超时后不能信任旧权重')
    m.release(second.leaseId)
  } finally {
    m.dispose()
  }
})

test('等待中的请求可以被 AbortSignal 取消', async () => {
  const m = manager()
  try {
    const first = await m.acquire()
    const controller = new AbortController()
    const waiting = m.acquire(controller.signal)

    controller.abort()
    await assert.rejects(waiting, /aborted/)

    m.release(first.leaseId, { gptWeightsPath: 'g', sovitsWeightsPath: 's' })
    const next = await m.acquire()
    assert.equal(next.currentWeights.gptWeightsPath, 'g')
    m.release(next.leaseId)
  } finally {
    m.dispose()
  }
})

test('释放未知租约不会影响当前租约', async () => {
  const m = manager()
  try {
    const first = await m.acquire()
    m.release('stale-lease-id', { gptWeightsPath: 'bad', sovitsWeightsPath: 'bad' })

    const stats = m.stats()
    assert.equal(stats.active, true)

    m.release(first.leaseId, { gptWeightsPath: 'g', sovitsWeightsPath: 's' })
    const second = await m.acquire()
    assert.equal(second.currentWeights.gptWeightsPath, 'g')
    m.release(second.leaseId)
  } finally {
    m.dispose()
  }
})
