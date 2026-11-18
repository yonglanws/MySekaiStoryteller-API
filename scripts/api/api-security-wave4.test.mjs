import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, mkdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import FakeTimers from '@sinonjs/fake-timers'
import express from 'express'
import { chromium } from 'playwright'
import { Logger } from 'tslog'
import { VideoApiServer } from '../../out-host/host/servers/VideoApiServer.js'
import { createBridgeRouter } from '../../out-host/host/bridge/bridgeRoutes.js'
import { RenderPool } from '../../out-host/host/pool/renderPool.js'

const story = { models: [], images: [], snippets: [] }

function httpRequest({ port, reqPath, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload =
      body === undefined
        ? undefined
        : Buffer.isBuffer(body)
          ? body
          : typeof body === 'string'
            ? body
            : JSON.stringify(body)
    const reqHeaders = { ...headers }
    if (payload !== undefined && !reqHeaders['content-type']) {
      reqHeaders['content-type'] = Buffer.isBuffer(payload)
        ? 'application/octet-stream'
        : 'application/json'
    }
    const req = http.request(
      { host: '127.0.0.1', port, path: reqPath, method, agent: false, headers: reqHeaders },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = JSON.parse(text)
          } catch {
            // non-json body
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json })
        })
      }
    )
    req.on('error', reject)
    req.end(payload)
  })
}

test('VideoApiServer enforces Bearer auth, sanitizes health/errors, and blocks symlink escapes', async (t) => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'msst-sec-api-'))
  const outputDir = path.join(workDir, 'out')
  const outsideFile = path.join(workDir, 'secret.mp4')
  await mkdir(outputDir, { recursive: true })
  await writeFile(outsideFile, 'top-secret')
  await writeFile(path.join(outputDir, 'sample.mp4'), 'ok-video')

  let symlinkCreated = false
  try {
    await symlink(outsideFile, path.join(outputDir, 'escape.mp4'))
    symlinkCreated = true
  } catch {
    // Windows without Developer Mode may disallow symlinks; skip only symlink assertion if EPERM
  }

  const apiKey = 'wave4-secret-api-key'
  const bridgeToken = 'wave4-bridge-token'
  const api = new VideoApiServer(new Logger({ type: 'hidden' }), {
    port: 0,
    host: '127.0.0.1',
    outputDir,
    video: {
      width: 1920,
      height: 1080,
      renderScale: 1,
      fps: 30,
      crf: 23,
      audioBitrate: '128k',
      watermark: true,
      watermarkText: '',
      exportMode: 'fast',
      fastFps: 30,
      exportFastEncoder: 'auto',
      idleChainGapSec: 0,
      ttsMode: 'concurrent'
    },
    apiKey,
    bridgeToken,
    registerExtraRoutes: (app, server) => {
      app.post('/api/v1/script/generate', (req, res) => {
        if (!server.enforceRateLimit(req, res)) return
        res.json({ success: true, story })
      })
      app.post('/api/v1/generate', (req, res) => {
        if (!server.enforceRateLimit(req, res)) return
        res.json({ success: true, story })
      })
      app.post('/api/v1/tts/lease', (_req, res) => {
        res.json({ success: true, leaseId: 'tts-1', currentWeights: null })
      })
      app.post('/api/v1/tts/lease/release', (_req, res) => {
        res.json({ success: true })
      })
      app.use('/apifile', server.createAuthMiddleware())
      app.use('/apifile', express.static(outputDir, { index: false }))
    }
  })

  api.setExtraHealthProvider((authed) => ({
    ttsLease: authed
      ? { active: false, waiters: 0, currentWeights: { gptWeightsPath: 'C:\\secret\\g.ckpt' } }
      : { active: false, waiters: 0, hasWeights: true }
  }))

  const dispatched = []
  api.setDispatcher({
    dispatch: (task) => dispatched.push(task),
    cancel: () => {}
  })

  await api.start()
  const server = api.getHttpServer()
  const port = server.address().port

  t.after(async () => {
    const closed = once(server, 'close')
    api.stop()
    server.closeAllConnections()
    await closed
    await rm(workDir, { recursive: true, force: true })
  })

  // 1. Public /api/v1/health succeeds without auth, exposes videoConfig fields, leaks NO paths
  const pubHealth = await httpRequest({ port, reqPath: '/api/v1/health' })
  assert.equal(pubHealth.status, 200)
  assert.equal(pubHealth.json.status, 'ok')
  assert.equal(pubHealth.json.videoConfig.exportMode, 'fast')
  assert.equal(pubHealth.json.videoConfig.fastFps, 30)
  assert.equal(pubHealth.json.videoConfig.exportFastEncoder, 'auto')
  assert.equal(pubHealth.json.ttsLease.hasWeights, true)
  assert.equal('currentWeights' in pubHealth.json.ttsLease, false)
  assert.equal(pubHealth.text.includes('secret'), false)
  assert.equal(pubHealth.text.includes(outputDir), false)

  // Authenticated /health gets full details
  const authHealth = await httpRequest({
    port,
    reqPath: '/api/v1/health',
    headers: { Authorization: `Bearer ${apiKey}` }
  })
  assert.equal(authHealth.status, 200)
  assert.equal(authHealth.json.ttsLease.currentWeights.gptWeightsPath, 'C:\\secret\\g.ckpt')

  // 2. Guarded endpoints reject missing / wrong tokens
  const guarded = [
    ['GET', '/api/v1/status'],
    ['POST', '/api/v1/export', { story }],
    ['GET', '/api/v1/export/missing/status'],
    ['POST', '/api/v1/export/missing/cancel', {}],
    ['POST', '/api/v1/script/generate', { prompt: 'hi' }],
    ['POST', '/api/v1/generate', { prompt: 'hi' }],
    ['GET', '/api/v1/files'],
    ['GET', '/api/v1/download/sample.mp4'],
    ['POST', '/api/v1/cleanup', {}],
    ['GET', '/api/v1/cleanup/stats'],
    ['GET', '/apifile/sample.mp4'],
    ['POST', '/api/v1/tts/lease', {}],
    ['POST', '/api/v1/tts/lease/release', { leaseId: 'tts-1' }]
  ]
  for (const [method, reqPath, body] of guarded) {
    const unauth = await httpRequest({ port, reqPath, method, body })
    assert.equal(unauth.status, 401, `expected 401 without auth for ${method} ${reqPath}`)
    const wrong = await httpRequest({
      port,
      reqPath,
      method,
      body,
      headers: { Authorization: 'Bearer wrong-key' }
    })
    assert.equal(wrong.status, 401, `expected 401 for wrong key on ${method} ${reqPath}`)
  }

  // 3. Valid Bearer token grants access across guarded routes + /apifile
  const authHeaders = { Authorization: `Bearer ${apiKey}` }
  assert.equal(
    (await httpRequest({ port, reqPath: '/api/v1/status', headers: authHeaders })).status,
    200
  )
  assert.equal(
    (await httpRequest({ port, reqPath: '/api/v1/files', headers: authHeaders })).status,
    200
  )
  assert.equal(
    (await httpRequest({ port, reqPath: '/api/v1/download/sample.mp4', headers: authHeaders }))
      .status,
    200
  )
  assert.equal(
    (await httpRequest({ port, reqPath: '/apifile/sample.mp4', headers: authHeaders })).status,
    200
  )

  // 4. Worker page same-origin Referer bridgeToken allows /api/v1/tts/lease*
  const leaseRes = await httpRequest({
    port,
    reqPath: '/api/v1/tts/lease',
    method: 'POST',
    body: {},
    headers: { Referer: `http://127.0.0.1:${port}/?worker=w1&token=${bridgeToken}` }
  })
  assert.equal(leaseRes.status, 200)
  assert.equal(leaseRes.json.leaseId, 'tts-1')

  // 5. Symlink escape on /api/v1/download returns 404 with no path leak
  if (symlinkCreated) {
    const esc = await httpRequest({
      port,
      reqPath: '/api/v1/download/escape.mp4',
      headers: authHeaders
    })
    assert.equal(esc.status, 404)
    assert.equal(esc.json.error, 'File not found')
  }

  // 6. Export error redacts outputDir/temp paths from HTTP response
  const pendingExport = httpRequest({
    port,
    reqPath: '/api/v1/export',
    method: 'POST',
    headers: authHeaders,
    body: { story }
  })
  for (let i = 0; i < 50 && dispatched.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
  const missingPath = path.join(outputDir, 'does-not-exist.mp4')
  api.resolveExport(dispatched[0].taskId, { success: true, videoPath: missingPath })
  const exportFail = await pendingExport
  assert.equal(exportFail.status, 500)
  assert.equal(exportFail.text.includes(outputDir), false)
  assert.equal(exportFail.text.includes(missingPath), false)

  // 7. Malformed JSON returns 400
  const badJson = await httpRequest({
    port,
    reqPath: '/api/v1/export',
    method: 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: '{not-valid-json'
  })
  assert.equal(badJson.status, 400)
})

test('CORS enforces localhost default and configurable allowlist with Vary: Origin', async (t) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'msst-cors-default-'))
  const apiDefault = new VideoApiServer(new Logger({ type: 'hidden' }), {
    port: 0,
    host: '127.0.0.1',
    outputDir,
    video: { width: 1280, height: 720, fps: 30 }
  })
  await apiDefault.start()
  const serverDefault = apiDefault.getHttpServer()
  const portDefault = serverDefault.address().port

  const apiAllowlist = new VideoApiServer(new Logger({ type: 'hidden' }), {
    port: 0,
    host: '127.0.0.1',
    outputDir,
    video: { width: 1280, height: 720, fps: 30 },
    corsOrigins: ['https://studio.example.com']
  })
  await apiAllowlist.start()
  const serverAllow = apiAllowlist.getHttpServer()
  const portAllow = serverAllow.address().port

  t.after(async () => {
    for (const [api, srv] of [
      [apiDefault, serverDefault],
      [apiAllowlist, serverAllow]
    ]) {
      const closed = once(srv, 'close')
      api.stop()
      srv.closeAllConnections()
      await closed
    }
    await rm(outputDir, { recursive: true, force: true })
  })

  // Localhost allowed by default + Authorization in Allow-Headers + Vary: Origin
  const localPreflight = await httpRequest({
    port: portDefault,
    reqPath: '/api/v1/export',
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5173' }
  })
  assert.equal(localPreflight.status, 204)
  assert.equal(localPreflight.headers['access-control-allow-origin'], 'http://localhost:5173')
  assert.match(localPreflight.headers['access-control-allow-headers'], /Authorization/i)
  assert.equal(localPreflight.headers['vary'], 'Origin')

  const loopbackGet = await httpRequest({
    port: portDefault,
    reqPath: '/api/v1/health',
    headers: { Origin: 'http://127.0.0.1:3000' }
  })
  assert.equal(loopbackGet.headers['access-control-allow-origin'], 'http://127.0.0.1:3000')

  // Non-localhost & lookalike origins rejected (no Allow-Origin header)
  for (const evilOrigin of ['https://evil.example', 'http://localhost.evil.com', 'null']) {
    const res = await httpRequest({
      port: portDefault,
      reqPath: '/api/v1/health',
      headers: { Origin: evilOrigin }
    })
    assert.equal(res.headers['access-control-allow-origin'], undefined, evilOrigin)
    assert.equal(res.headers['vary'], 'Origin')
  }

  // Explicit allowlist allows configured origin and rejects localhost
  const allowed = await httpRequest({
    port: portAllow,
    reqPath: '/api/v1/health',
    headers: { Origin: 'https://studio.example.com' }
  })
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://studio.example.com')

  const notInAllowlist = await httpRequest({
    port: portAllow,
    reqPath: '/api/v1/health',
    headers: { Origin: 'http://localhost:5173' }
  })
  assert.equal(notInAllowlist.headers['access-control-allow-origin'], undefined)
})

test('Rate limiting guards export, script/generate, and generate and caps rateLimitMap', async (t) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'msst-ratelimit-'))
  const api = new VideoApiServer(new Logger({ type: 'hidden' }), {
    port: 0,
    host: '127.0.0.1',
    outputDir,
    video: { width: 1280, height: 720, fps: 30 },
    rateLimitMaxEntries: 4,
    registerExtraRoutes: (app, server) => {
      app.post('/api/v1/script/generate', (req, res) => {
        if (!server.enforceRateLimit(req, res)) return
        res.json({ success: true })
      })
      app.post('/api/v1/generate', (req, res) => {
        if (!server.enforceRateLimit(req, res)) return
        res.json({ success: true })
      })
    }
  })
  await api.start()
  const server = api.getHttpServer()
  const port = server.address().port

  t.after(async () => {
    const closed = once(server, 'close')
    api.stop()
    server.closeAllConnections()
    await closed
    await rm(outputDir, { recursive: true, force: true })
  })

  // 10 requests succeed across expensive POST routes (invalid story -> 400 without dispatching, still counts), 11th -> 429
  for (let i = 0; i < 10; i++) {
    const route =
      i % 3 === 0 ? '/api/v1/script/generate' : i % 3 === 1 ? '/api/v1/generate' : '/api/v1/export'
    const res = await httpRequest({ port, reqPath: route, method: 'POST', body: {} })
    assert.notEqual(res.status, 429, `request #${i + 1} to ${route} must not be rate limited`)
  }
  for (const route of ['/api/v1/export', '/api/v1/script/generate', '/api/v1/generate']) {
    const limited = await httpRequest({ port, reqPath: route, method: 'POST', body: {} })
    assert.equal(limited.status, 429, `11th+ request to ${route} must return 429`)
  }

  // Cap check: inserting 20 distinct IPs must keep rateLimitMap.size <= 4
  for (let i = 0; i < 20; i++) {
    assert.equal(api.checkRateLimit(`203.0.113.${i}`), true)
  }
  assert.ok(api.rateLimitMap.size <= 4, `expected <= 4 entries, got ${api.rateLimitMap.size}`)
})

test('Async export wait=false supports status polling and cancellation', async (t) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'msst-async-export-'))
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

  t.after(async () => {
    const closed = once(server, 'close')
    api.stop()
    server.closeAllConnections()
    await closed
    await rm(outputDir, { recursive: true, force: true })
  })

  // 1. Async export completes via polling
  const sub1 = await httpRequest({
    port,
    reqPath: '/api/v1/export',
    method: 'POST',
    body: { story, wait: false, timeout: 10_000 }
  })
  assert.equal(sub1.status, 202)
  assert.ok(sub1.json.taskId)
  assert.equal(sub1.json.status, 'queued')

  const activeStatus = await httpRequest({
    port,
    reqPath: `/api/v1/export/${sub1.json.taskId}/status`
  })
  assert.equal(activeStatus.status, 200)
  assert.equal(activeStatus.json.status, 'processing')

  await writeFile(dispatched[0].outputPath, 'async-video')
  api.resolveExport(dispatched[0].taskId, {
    success: true,
    videoPath: dispatched[0].outputPath,
    duration: 4.2,
    frameCount: 126
  })
  await new Promise((r) => setTimeout(r, 20))

  const doneStatus = await httpRequest({
    port,
    reqPath: `/api/v1/export/${sub1.json.taskId}/status`
  })
  assert.equal(doneStatus.status, 200)
  assert.equal(doneStatus.json.status, 'completed')
  assert.equal(doneStatus.json.result.downloadUrl, `/api/v1/download/${dispatched[0].taskId}.mp4`)
  assert.equal(doneStatus.json.result.fileSize, 11)

  // 2. Async export cancellation updates status immediately
  const sub2 = await httpRequest({
    port,
    reqPath: '/api/v1/export',
    method: 'POST',
    body: { story, wait: false, timeout: 10_000 }
  })
  assert.equal(sub2.status, 202)
  const cancelRes = await httpRequest({
    port,
    reqPath: `/api/v1/export/${sub2.json.taskId}/cancel`,
    method: 'POST',
    body: {}
  })
  assert.equal(cancelRes.status, 200)
  assert.equal(cancelRes.json.cancelled, true)
  assert.ok(cancelled.includes(sub2.json.taskId))

  const cancelledStatus = await httpRequest({
    port,
    reqPath: `/api/v1/export/${sub2.json.taskId}/status`
  })
  assert.equal(cancelledStatus.json.status, 'cancelled')
})

test('Startup temp sweep cleans stale mss-fpipe-*, mss-hf-*, and .mss-frames-video-*.mp4', async (t) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'msst-sweep-out-'))
  const staleFpipe = path.join(tmpdir(), `mss-fpipe-wave4-stale-${Date.now()}`)
  const staleHf = path.join(tmpdir(), `mss-hf-wave4-stale-${Date.now()}`)
  const freshFpipe = path.join(tmpdir(), `mss-fpipe-wave4-fresh-${Date.now()}`)
  const staleTmpMp4 = path.join(tmpdir(), `.mss-frames-video-wave4-stale-${Date.now()}.mp4`)
  const staleOutMp4 = path.join(outputDir, `.mss-frames-video-wave4-out-${Date.now()}.mp4`)

  await mkdir(path.join(staleFpipe), { recursive: true })
  await writeFile(path.join(staleFpipe, 'video.mp4'), 'stale')
  await mkdir(path.join(staleHf, 'frames'), { recursive: true })
  await writeFile(path.join(staleHf, 'frames', 'frame-000001.jpg'), 'jpg')
  await mkdir(freshFpipe, { recursive: true })
  await writeFile(staleTmpMp4, 'tmp-mp4')
  await writeFile(staleOutMp4, 'out-mp4')

  const ancient = new Date(Date.now() - 8 * 60 * 60 * 1000)
  await utimes(staleFpipe, ancient, ancient)
  await utimes(staleHf, ancient, ancient)
  await utimes(staleTmpMp4, ancient, ancient)
  await utimes(staleOutMp4, ancient, ancient)

  const api = new VideoApiServer(new Logger({ type: 'hidden' }), {
    port: 0,
    host: '127.0.0.1',
    outputDir,
    video: { width: 1280, height: 720, fps: 30 }
  })

  t.after(async () => {
    const srv = api.getHttpServer()
    if (srv?.listening) {
      const closed = once(srv, 'close')
      api.stop()
      srv.closeAllConnections()
      await closed
    } else {
      api.stop()
    }
    await rm(outputDir, { recursive: true, force: true })
    await rm(staleFpipe, { recursive: true, force: true })
    await rm(staleHf, { recursive: true, force: true })
    await rm(freshFpipe, { recursive: true, force: true })
    await rm(staleTmpMp4, { force: true })
  })

  await api.start()

  await assert.rejects(stat(staleFpipe), { code: 'ENOENT' })
  await assert.rejects(stat(staleHf), { code: 'ENOENT' })
  await assert.rejects(stat(staleTmpMp4), { code: 'ENOENT' })
  await assert.rejects(stat(staleOutMp4), { code: 'ENOENT' })
  await stat(freshFpipe)
})

test('bridgeRoutes cleans FramesPipeSession on error, abort, worker recycle, idle timeout, and shutdown, and removes record routes', async (t) => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'msst-fpipe-bridge-'))
  const outputDir = path.join(workDir, 'out')
  const createdSessions = []
  let nextMode = 'normal'

  const fakeCreatePipe = async (options) => {
    const sess = {
      outputPath: options.outputPath,
      aborted: 0,
      finished: 0,
      writes: 0,
      dir: path.dirname(options.outputPath),
      async write() {
        sess.writes++
        if (nextMode === 'write-fail') {
          throw new Error('ffmpeg stdin broken')
        }
      },
      async finish() {
        sess.finished++
        if (nextMode === 'finish-fail') {
          throw new Error('ffmpeg finish error')
        }
        await writeFile(options.outputPath, 'encoded-mp4')
        return options.outputPath
      },
      async abort() {
        sess.aborted++
      }
    }
    createdSessions.push(sess)
    return sess
  }

  let controller = null
  const app = express()
  app.use(
    '/bridge',
    createBridgeRouter({
      logger: new Logger({ type: 'hidden' }),
      config: {
        paths: { output: outputDir },
        video: { width: 1280, height: 720, fps: 30, crf: 23, encoder: 'cpu' },
        render: { workers: 2 },
        tts: { apiBaseUrl: 'http://127.0.0.1:9880', timeoutMs: 5000 },
        llm: { enabled: false }
      },
      bridgeToken: 'tok',
      framesPipeIdleMs: 80,
      createFramesPipe: fakeCreatePipe,
      onController: (ctrl) => {
        controller = ctrl
      }
    })
  )

  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port

  t.after(async () => {
    await controller?.disposeAll()
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
    await rm(workDir, { recursive: true, force: true })
  })

  const invoke = (channel, args, extraHeaders = {}) =>
    httpRequest({
      port,
      reqPath: `/bridge/invoke/${channel}`,
      method: 'POST',
      headers: { 'x-mss-bridge-token': 'tok', ...extraHeaders },
      body: args
    })

  // 1. Removed record channels reject
  for (const removed of [
    'electron:record-start',
    'electron:record-finish',
    'electron:record-mux',
    'electron:record-cancel'
  ]) {
    const res = await invoke(removed, [{}])
    assert.equal(res.status, 500)
    assert.match(res.json.error, /Unsupported bridge invoke channel/)
  }

  // 2. Finish error aborts ffmpeg and cleans dir
  nextMode = 'finish-fail'
  const s1 = await invoke('electron:frames-stream-start', [{ fps: 30 }], {
    Referer: `http://127.0.0.1:${port}/?worker=w1&token=tok`
  })
  assert.equal(s1.status, 200)
  const finErr = await invoke('electron:frames-stream-finish', [{ id: s1.json.result.id }])
  assert.equal(finErr.status, 500)
  assert.equal(createdSessions[0].aborted, 1)
  assert.equal(controller.activePipeSessionCount(), 0)
  await assert.rejects(stat(createdSessions[0].dir), { code: 'ENOENT' })

  // 3. Chunk write error aborts ffmpeg and cleans dir
  nextMode = 'write-fail'
  const s2 = await invoke('electron:frames-stream-start', [{ fps: 30 }], {
    Referer: `http://127.0.0.1:${port}/?worker=w1&token=tok`
  })
  assert.equal(s2.status, 200)
  const chunkArgs = encodeURIComponent(JSON.stringify([{ id: s2.json.result.id }]))
  const chunkErr = await httpRequest({
    port,
    reqPath: `/bridge/bin/electron:frames-stream-chunk?args=${chunkArgs}`,
    method: 'POST',
    headers: { 'x-mss-bridge-token': 'tok' },
    body: Buffer.from('jpeg-bytes')
  })
  assert.equal(chunkErr.status, 500)
  assert.equal(createdSessions[1].aborted, 1)
  assert.equal(controller.activePipeSessionCount(), 0)
  await assert.rejects(stat(createdSessions[1].dir), { code: 'ENOENT' })

  // 3b. Aborted HTTP request during frames-stream-start closes late-spawned session & dir
  nextMode = 'slow-start'
  const slowSessions = []
  let resolveSlowStart = null
  const slowApp = express()
  let slowCtrl = null
  slowApp.use(
    '/bridge',
    createBridgeRouter({
      logger: new Logger({ type: 'hidden' }),
      config: {
        paths: { output: outputDir },
        video: { width: 1280, height: 720, fps: 30, crf: 23, encoder: 'cpu' },
        render: { workers: 1 },
        tts: { apiBaseUrl: 'http://127.0.0.1:9880', timeoutMs: 5000 },
        llm: { enabled: false }
      },
      bridgeToken: 'tok',
      createFramesPipe: async (options) => {
        await new Promise((resolve) => {
          resolveSlowStart = resolve
        })
        const sess = await fakeCreatePipe(options)
        slowSessions.push(sess)
        return sess
      },
      onController: (ctrl) => {
        slowCtrl = ctrl
      }
    })
  )
  const slowSrv = slowApp.listen(0, '127.0.0.1')
  await once(slowSrv, 'listening')
  const slowPort = slowSrv.address().port
  const abortReq = http.request({
    host: '127.0.0.1',
    port: slowPort,
    path: '/bridge/invoke/electron:frames-stream-start',
    method: 'POST',
    headers: { 'x-mss-bridge-token': 'tok', 'content-type': 'application/json' }
  })
  abortReq.on('error', () => {})
  abortReq.end(JSON.stringify([{ fps: 30 }]))
  for (let i = 0; i < 50 && !resolveSlowStart; i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
  abortReq.destroy()
  await new Promise((r) => setTimeout(r, 20))
  resolveSlowStart()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(slowSessions.length, 1)
  assert.equal(slowSessions[0].aborted, 1)
  assert.equal(slowCtrl.activePipeSessionCount(), 0)
  await assert.rejects(stat(slowSessions[0].dir), { code: 'ENOENT' })
  await slowCtrl.disposeAll()
  const slowClosed = once(slowSrv, 'close')
  slowSrv.close()
  slowSrv.closeAllConnections()
  await slowClosed

  // 4. Worker recycling cleans ONLY that worker's active session
  nextMode = 'normal'
  const recycleBase = createdSessions.length
  const sW1 = await invoke('electron:frames-stream-start', [{ fps: 30 }], {
    Referer: `http://127.0.0.1:${port}/?worker=w1&token=tok`
  })
  const sW2 = await invoke('electron:frames-stream-start', [{ fps: 30 }], {
    Referer: `http://127.0.0.1:${port}/?worker=w2&token=tok`
  })
  assert.equal(sW1.status, 200)
  assert.equal(sW2.status, 200)
  assert.equal(controller.activePipeSessionCount(), 2)

  await controller.cleanupWorker('w1')
  assert.equal(createdSessions[recycleBase].aborted, 1)
  assert.equal(createdSessions[recycleBase + 1].aborted, 0)
  assert.equal(controller.activePipeSessionCount(), 1)
  await assert.rejects(stat(createdSessions[recycleBase].dir), { code: 'ENOENT' })

  // 5. Idle timeout aborts remaining orphaned session and cleans dir
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(createdSessions[recycleBase + 1].aborted, 1)
  assert.equal(controller.activePipeSessionCount(), 0)
  await assert.rejects(stat(createdSessions[recycleBase + 1].dir), { code: 'ENOENT' })

  // 6. disposeAll cleans remaining sessions
  const sW1Again = await invoke('electron:frames-stream-start', [{ fps: 30 }], {
    Referer: `http://127.0.0.1:${port}/?worker=w1&token=tok`
  })
  assert.equal(sW1Again.status, 200)
  assert.equal(controller.activePipeSessionCount(), 1)
  await controller.disposeAll()
  assert.equal(createdSessions[recycleBase + 2].aborted, 1)
  assert.equal(controller.activePipeSessionCount(), 0)
})

test('RenderPool prevents browser/page leaks on stop-during-launch, goto failure, and page crash', async (t) => {
  const clock = FakeTimers.install({
    now: 1_000_000,
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
  })

  const browsers = []
  const cleanedWorkers = []
  const results = []
  let failNextGoto = false
  let holdNextLaunch = false
  let pendingLaunchResolve = null

  t.mock.method(chromium, 'launch', async () => {
    if (holdNextLaunch) {
      holdNextLaunch = false
      await new Promise((resolve) => {
        pendingLaunchResolve = resolve
      })
    }
    const browser = new EventEmitter()
    browser.connected = true
    browser.pages = []
    browser.newPage = async () => {
      const page = new EventEmitter()
      page.closed = false
      page.goto = async (url) => {
        if (failNextGoto) {
          failNextGoto = false
          throw new Error('navigation timeout')
        }
        page.workerId = new URL(url).searchParams.get('worker')
        pool.handleWorkerReady(page.workerId)
      }
      page.evaluate = async () => 'Test GPU'
      page.close = async () => {
        if (page.closed) return
        page.closed = true
        page.emit('close')
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

  const config = {
    server: { port: 9881 },
    render: {
      workers: 1,
      workerRecycleExports: 0,
      browserChannels: [],
      extraChromeArgs: '',
      minFreeMemoryMb: 0
    },
    tts: { characters: [] },
    bgm: { enabled: false }
  }

  const pool = new RenderPool(
    new Logger({ type: 'hidden' }),
    config,
    { send: () => true, closeAll: () => {} },
    undefined,
    'tok',
    (workerId) => cleanedWorkers.push(workerId)
  )
  pool.onExportResult = (taskId, result) => results.push({ taskId, ...result })

  t.after(async () => {
    await pool.stop()
    clock.uninstall()
  })

  // 1. Page crash fails busy task, calls onWorkerCleanup, and recovers cleanly
  await pool.start()
  assert.equal(browsers.length, 1)
  pool.dispatch({
    taskId: 'crash-task',
    addedAt: Date.now(),
    timeoutMs: 60_000,
    story,
    outputPath: 'crash.mp4',
    videoConfig: {}
  })
  browsers[0].pages[0].emit('crash')
  await clock.tickAsync(0)
  assert.equal(results.length, 1)
  assert.equal(results[0].success, false)
  assert.ok(cleanedWorkers.includes('w1'))
  assert.equal(browsers[0].connected, false)
  assert.equal(browsers.length, 2)

  // 2. Failed openWorkerPage closes its browser before scheduling relaunch
  failNextGoto = true
  browsers[1].emit('disconnected')
  await clock.tickAsync(0)
  assert.equal(browsers.length, 3)
  assert.equal(browsers[2].connected, false, 'failed goto must close its launched browser')

  await pool.stop()

  // 3. stop() while chromium.launch is in-flight closes the late-resolving browser
  const pool2 = new RenderPool(new Logger({ type: 'hidden' }), config, {
    send: () => true,
    closeAll: () => {}
  })
  holdNextLaunch = true
  const startPromise = pool2.start()
  await clock.tickAsync(0)
  await pool2.stop()
  pendingLaunchResolve?.()
  await startPromise
  assert.equal(browsers.length, 4)
  assert.equal(browsers[3].connected, false, 'browser resolved after stop() must be closed')
})

async function reserveLoopbackPort() {
  const probe = net.createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const addr = probe.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  await new Promise((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())))
  return port
}

test('Eager server.createAuthMiddleware() in registerExtraRoutes and host main.js bootstrap avoid TDZ and guard /apifile', async (t) => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'msst-bootstrap-smoke-'))
  const unitOutputDir = path.join(workDir, 'unit-output')
  const hostRoot = path.join(workDir, 'host-root')
  const hostOutputDir = path.join(hostRoot, 'output')
  const hostResourcesDir = path.join(hostRoot, 'resources')
  const hostWebDir = path.join(hostRoot, 'webrenderer')
  await Promise.all([
    mkdir(unitOutputDir, { recursive: true }),
    mkdir(hostOutputDir, { recursive: true }),
    mkdir(hostResourcesDir, { recursive: true }),
    mkdir(hostWebDir, { recursive: true })
  ])
  await Promise.all([
    writeFile(path.join(unitOutputDir, 'smoke.mp4'), 'unit-mp4'),
    writeFile(path.join(hostOutputDir, 'smoke.mp4'), 'live-mp4'),
    writeFile(path.join(hostWebDir, 'index.html'), '<!doctype html><html><body>ok</body></html>')
  ])

  let child = null
  let childExited = false
  t.after(async () => {
    if (child && !childExited) {
      child.kill()
      await Promise.race([
        once(child, 'exit').catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 2000))
      ])
    }
    await rm(workDir, { recursive: true, force: true })
  })

  // 1. Direct constructor TDZ regression: calling server.createAuthMiddleware() synchronously
  //    without a lazy wrapper succeeds cleanly when assigned to a fresh `const`.
  const eagerKey = 'eager-tdz-secret'
  const eagerApi = new VideoApiServer(new Logger({ type: 'hidden' }), {
    port: 0,
    host: '127.0.0.1',
    outputDir: unitOutputDir,
    video: { width: 1280, height: 720, fps: 30 },
    apiKey: eagerKey,
    registerExtraRoutes: (app, server) => {
      assert.ok(server, 'registerExtraRoutes must receive the VideoApiServer instance')
      const authMiddleware = server.createAuthMiddleware()
      app.use('/apifile', authMiddleware)
      app.use('/apifile', express.static(unitOutputDir, { index: false }))
    }
  })
  await eagerApi.start()
  const eagerServer = eagerApi.getHttpServer()
  const eagerPort = eagerServer.address().port
  try {
    const unauth = await httpRequest({ port: eagerPort, reqPath: '/apifile/smoke.mp4' })
    assert.equal(unauth.status, 401)
    const authed = await httpRequest({
      port: eagerPort,
      reqPath: '/apifile/smoke.mp4',
      headers: { Authorization: `Bearer ${eagerKey}` }
    })
    assert.equal(authed.status, 200)
    assert.equal(authed.text, 'unit-mp4')
  } finally {
    const closed = once(eagerServer, 'close')
    eagerApi.stop()
    eagerServer.closeAllConnections()
    await closed
  }

  // 2. Live host main.js bootstrap smoke test verifying registerExtraRoutes + /apifile Bearer auth
  const livePort = await reserveLoopbackPort()
  const liveKey = 'bootstrap-smoke-secret'
  const mainEntry = path.resolve(process.cwd(), 'out-host', 'host', 'main.js')
  let logs = ''
  child = spawn(process.execPath, [mainEntry], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MSS_HOST: '127.0.0.1',
      MSS_PORT: String(livePort),
      MSS_OUTPUT_DIR: hostOutputDir,
      MSS_RESOURCE_DIR: hostResourcesDir,
      MSS_WEB_RENDERER_DIR: hostWebDir,
      MSS_ASSETS_CLOUD_CATALOG: 'false',
      MSS_TTS_ENABLED: 'false',
      MSS_WORKERS: '1',
      MSS_BROWSER_CHANNELS: '',
      MSS_BROWSER_EXECUTABLE: path.join(workDir, 'missing-browser.exe'),
      MSST_API_KEY: liveKey
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout?.on('data', (chunk) => {
    logs += chunk.toString()
  })
  child.stderr?.on('data', (chunk) => {
    logs += chunk.toString()
  })
  child.once('exit', () => {
    childExited = true
  })

  let healthy = null
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && !childExited) {
    try {
      const res = await httpRequest({ port: livePort, reqPath: '/api/v1/health' })
      if (res.status === 200) {
        healthy = res
        break
      }
    } catch {
      // still starting up
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  assert.equal(
    childExited,
    false,
    `out-host/host/main.js exited prematurely during startup:\n${logs}`
  )
  assert.ok(healthy, `main.js failed to become healthy on port ${livePort}:\n${logs}`)
  assert.equal(healthy.json.status, 'ok')

  const unauthApifile = await httpRequest({ port: livePort, reqPath: '/apifile/smoke.mp4' })
  assert.equal(unauthApifile.status, 401)
  const unauthStatus = await httpRequest({ port: livePort, reqPath: '/api/v1/status' })
  assert.equal(unauthStatus.status, 401)

  const authedApifile = await httpRequest({
    port: livePort,
    reqPath: '/apifile/smoke.mp4',
    headers: { Authorization: `Bearer ${liveKey}` }
  })
  assert.equal(authedApifile.status, 200)
  assert.equal(authedApifile.text, 'live-mp4')

  const authedStatus = await httpRequest({
    port: livePort,
    reqPath: '/api/v1/status',
    headers: { Authorization: `Bearer ${liveKey}` }
  })
  assert.equal(authedStatus.status, 200)
})
