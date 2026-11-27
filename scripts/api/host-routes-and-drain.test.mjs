import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Logger } from 'tslog'
import { VideoApiServer } from '../../out-host/host/servers/VideoApiServer.js'
import { registerAiRoutes } from '../../out-host/host/servers/routes/aiRoutes.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PKG_VERSION = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version

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
      reqHeaders['content-type'] = 'application/json'
    }
    const req = http.request(
      { host: '127.0.0.1', port, path: reqPath, method, agent: false, headers: reqHeaders },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          const text = buf.toString('utf8')
          let json = null
          try {
            json = JSON.parse(text)
          } catch {
            // non-json body
          }
          resolve({ status: res.statusCode, headers: res.headers, buf, text, json })
        })
      }
    )
    req.on('error', reject)
    req.end(payload)
  })
}

const baseVideo = {
  width: 1280,
  height: 720,
  renderScale: 1,
  fps: 30,
  codec: 'hevc',
  crf: 23,
  audioBitrate: '128k',
  encoder: 'auto',
  watermark: true,
  watermarkText: '',
  exportMode: 'fast',
  exportBitrate: 5_500_000,
  maxOutputMbps: 6.5,
  useRustExporter: true,
  exportJobs: 1,
  fastFps: 30,
  exportFastEncoder: 'auto',
  recordTargetSizeMb: 0,
  idleChainGapSec: 0,
  ttsMode: 'concurrent'
}

test('/api/v1/health strips rustExporter binaryPath/napiPath when unauthenticated and reports package version', async (t) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'msst-health-redact-'))
  const apiKey = 'health-secret-key'
  const api = new VideoApiServer(new Logger({ type: 'hidden' }), {
    port: 0,
    host: '127.0.0.1',
    outputDir,
    video: baseVideo,
    apiKey
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

  const unauth = await httpRequest({ port, reqPath: '/api/v1/health' })
  assert.equal(unauth.status, 200)
  assert.equal(unauth.json.version, PKG_VERSION)
  assert.equal(unauth.json.draining, false)
  assert.equal(typeof unauth.json.rustExporter.available, 'boolean')
  assert.equal(typeof unauth.json.rustExporter.mode, 'string')
  assert.equal('binaryPath' in unauth.json.rustExporter, false)
  assert.equal('napiPath' in unauth.json.rustExporter, false)

  const authed = await httpRequest({
    port,
    reqPath: '/api/v1/health',
    headers: { Authorization: `Bearer ${apiKey}` }
  })
  assert.equal(authed.status, 200)
  assert.equal('binaryPath' in authed.json.rustExporter, true)
  assert.equal('napiPath' in authed.json.rustExporter, true)
})

test('beginDraining() rejects new /export and /generate with 503 and aborts in-flight AI generations', async (t) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'msst-drain-gate-'))
  let aiHandle = null
  let inFlightStarted = null
  const startedPromise = new Promise((resolve) => {
    inFlightStarted = resolve
  })

  const fakeStoryWriter = {
    generate: ({ signal }) =>
      new Promise((_resolve, reject) => {
        inFlightStarted()
        signal.addEventListener(
          'abort',
          () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          },
          { once: true }
        )
      })
  }

  const api = new VideoApiServer(new Logger({ type: 'hidden' }), {
    port: 0,
    host: '127.0.0.1',
    outputDir,
    video: baseVideo,
    registerExtraRoutes: (app, srv) => {
      aiHandle = registerAiRoutes(app, srv, {
        config: {
          paths: { output: outputDir },
          render: { workers: 2 },
          llm: { targetMinutes: 3 }
        },
        llmClient: { enabled: true },
        storyWriter: fakeStoryWriter,
        useCloudCatalog: false,
        cloudCatalog: { get: () => null, waitReady: async () => {} }
      })
    }
  })

  api.setDispatcher({ dispatch: () => {}, cancel: () => {} })
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

  // Start an in-flight AI generation before draining
  const inFlightReq = httpRequest({
    port,
    reqPath: '/api/v1/script/generate',
    method: 'POST',
    body: { prompt: 'A quiet rooftop talk' }
  })
  await startedPromise
  assert.equal(aiHandle.getActiveCount(), 1)

  // Enter draining mode
  api.beginDraining()
  assert.equal(api.isDraining(), true)

  // New /export and /generate and /script/generate must be rejected with 503 + Retry-After
  const exportRes = await httpRequest({
    port,
    reqPath: '/api/v1/export',
    method: 'POST',
    body: { story: { models: [], images: [], snippets: [] } }
  })
  assert.equal(exportRes.status, 503)
  assert.equal(exportRes.headers['retry-after'], '5')
  assert.equal(exportRes.json.success, false)

  const genRes = await httpRequest({
    port,
    reqPath: '/api/v1/generate',
    method: 'POST',
    body: { prompt: 'hi' }
  })
  assert.equal(genRes.status, 503)
  assert.equal(genRes.headers['retry-after'], '5')
  assert.equal(genRes.json.success, false)

  const scriptGenRes = await httpRequest({
    port,
    reqPath: '/api/v1/script/generate',
    method: 'POST',
    body: { prompt: 'hi' }
  })
  assert.equal(scriptGenRes.status, 503)

  // Abort and drain in-flight AI generation cleanly
  await aiHandle.abortAndDrain(5_000)
  const inFlightRes = await inFlightReq
  assert.equal(inFlightRes.status, 503)
  assert.equal(aiHandle.getActiveCount(), 0)
})

test('/api/v1/download/:filename supports HTTP Range (206/416) and full 200 downloads, and async /files lists outputs', async (t) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'msst-range-dl-'))
  const sampleData = '0123456789ABCDEF'
  await writeFile(path.join(outputDir, 'clip.mp4'), sampleData, 'utf8')
  await writeFile(path.join(outputDir, 'clip.json'), '{"ok":true}', 'utf8')

  const api = new VideoApiServer(new Logger({ type: 'hidden' }), {
    port: 0,
    host: '127.0.0.1',
    outputDir,
    video: baseVideo
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

  // Async /api/v1/files listing
  const filesRes = await httpRequest({ port, reqPath: '/api/v1/files' })
  assert.equal(filesRes.status, 200)
  assert.equal(filesRes.json.pagination.total, 2)
  assert.ok(filesRes.json.data.some((f) => f.filename === 'clip.mp4'))

  // Full download (200) includes Accept-Ranges: bytes
  const full = await httpRequest({ port, reqPath: '/api/v1/download/clip.mp4' })
  assert.equal(full.status, 200)
  assert.equal(full.headers['accept-ranges'], 'bytes')
  assert.equal(full.headers['content-length'], String(sampleData.length))
  assert.equal(full.text, sampleData)

  // Explicit byte range: bytes=0-3
  const partial = await httpRequest({
    port,
    reqPath: '/api/v1/download/clip.mp4',
    headers: { Range: 'bytes=0-3' }
  })
  assert.equal(partial.status, 206)
  assert.equal(partial.headers['accept-ranges'], 'bytes')
  assert.equal(partial.headers['content-range'], 'bytes 0-3/16')
  assert.equal(partial.headers['content-length'], '4')
  assert.equal(partial.text, '0123')

  // Open-ended range: bytes=10-
  const openEnd = await httpRequest({
    port,
    reqPath: '/api/v1/download/clip.mp4',
    headers: { Range: 'bytes=10-' }
  })
  assert.equal(openEnd.status, 206)
  assert.equal(openEnd.headers['content-range'], 'bytes 10-15/16')
  assert.equal(openEnd.headers['content-length'], '6')
  assert.equal(openEnd.text, 'ABCDEF')

  // Suffix range: bytes=-4
  const suffix = await httpRequest({
    port,
    reqPath: '/api/v1/download/clip.mp4',
    headers: { Range: 'bytes=-4' }
  })
  assert.equal(suffix.status, 206)
  assert.equal(suffix.headers['content-range'], 'bytes 12-15/16')
  assert.equal(suffix.headers['content-length'], '4')
  assert.equal(suffix.text, 'CDEF')

  // Clamped end range: bytes=12-999
  const clamped = await httpRequest({
    port,
    reqPath: '/api/v1/download/clip.mp4',
    headers: { Range: 'bytes=12-999' }
  })
  assert.equal(clamped.status, 206)
  assert.equal(clamped.headers['content-range'], 'bytes 12-15/16')
  assert.equal(clamped.text, 'CDEF')

  // Unsatisfiable range: bytes=100-200 -> 416
  const oob = await httpRequest({
    port,
    reqPath: '/api/v1/download/clip.mp4',
    headers: { Range: 'bytes=100-200' }
  })
  assert.equal(oob.status, 416)
  assert.equal(oob.headers['content-range'], 'bytes */16')
})
