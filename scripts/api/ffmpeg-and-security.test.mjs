import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import FakeTimers from '@sinonjs/fake-timers'
import express from 'express'
import { Logger } from 'tslog'
import WebSocket from 'ws'
import { VideoApiServer } from '../../out-host/host/servers/VideoApiServer.js'
import { createBridgeRouter } from '../../out-host/host/bridge/bridgeRoutes.js'
import { WsHub } from '../../out-host/host/bridge/wsHub.js'

const require = createRequire(import.meta.url)

function loadFreshFfmpeg() {
  const resolved = require.resolve('../../out-host/shared/ffmpeg.js')
  delete require.cache[resolved]
  return require(resolved)
}

const bridgeFfmpeg = require('../../out-host/shared/ffmpeg.js')

function makeFakeChild({ code = 0, stderrText = '', onClose } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = new EventEmitter()
  child.stdin.write = (_chunk, cb) => cb?.()
  child.stdin.end = () => {}
  child.stdin.destroy = () => {}
  child.kill = () => {
    queueMicrotask(() => child.emit('close', 1, 'SIGKILL'))
  }
  queueMicrotask(() => {
    if (stderrText) child.stderr.emit('data', Buffer.from(stderrText))
    onClose?.(child)
    child.emit('close', code, null)
  })
  return child
}

test('detectAvailableGpuEncoder uses cached 1-frame smoke probe and falls back from broken NVENC to QSV/CPU', async (t) => {
  const ffmpeg = loadFreshFfmpeg()
  ffmpeg.resetGpuEncoderCache()

  const spawnCalls = []
  t.mock.method(childProcess, 'spawn', (_bin, args) => {
    spawnCalls.push(args)
    const codecIdx = args.indexOf('-c:v')
    const codec = codecIdx >= 0 ? args[codecIdx + 1] : ''
    if (codec === 'h264_nvenc') {
      return makeFakeChild({ code: 1, stderrText: 'Cannot load nvcuda.dll' })
    }
    if (codec === 'h264_amf') {
      return makeFakeChild({ code: 1, stderrText: 'AMF not supported' })
    }
    if (codec === 'h264_qsv') {
      return makeFakeChild({ code: 0 })
    }
    return makeFakeChild({ code: 1 })
  })

  const first = await ffmpeg.detectAvailableGpuEncoder()
  assert.equal(first, 'intel')
  assert.equal(ffmpeg.getCachedGpuEncoder(), 'intel')
  assert.equal(spawnCalls.length, 3)
  for (const args of spawnCalls) {
    assert.ok(!args.includes('-encoders'), 'must not use compile-time -encoders listing')
    assert.equal(args[args.indexOf('-frames:v') + 1], '1')
    assert.equal(args[args.indexOf('-f', args.indexOf('-frames:v')) + 1], 'null')
  }

  // Second call uses cache without spawning
  const second = await ffmpeg.detectAvailableGpuEncoder()
  assert.equal(second, 'intel')
  assert.equal(spawnCalls.length, 3)
})

test('detectAvailableGpuEncoder falls back to cpu when all GPU smoke probes fail', async (t) => {
  const ffmpeg = loadFreshFfmpeg()
  ffmpeg.resetGpuEncoderCache()

  t.mock.method(childProcess, 'spawn', () => makeFakeChild({ code: 1 }))
  const detected = await ffmpeg.detectAvailableGpuEncoder()
  assert.equal(detected, 'cpu')
  assert.equal(ffmpeg.getCachedGpuEncoder(), 'cpu')
})

test('QSV paths omit invalid hw_upload filter and runtime GPU failure falls back to CPU + invalidates cache', async (t) => {
  const ffmpeg = loadFreshFfmpeg()
  ffmpeg.resetGpuEncoderCache()

  const dir = await mkdtemp(path.join(tmpdir(), 'msst-ffmpeg-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const inputPath = path.join(dir, 'in.webm')
  const outputPath = path.join(dir, 'out.mp4')
  await writeFile(inputPath, Buffer.alloc(1024))

  const calls = []
  t.mock.method(childProcess, 'spawn', (_bin, args, opts) => {
    calls.push({ args, opts })
    const codecIdx = args.indexOf('-c:v')
    const codec = codecIdx >= 0 ? args[codecIdx + 1] : ''
    // Smoke probe succeeds for nvidia; runtime encode fails for nvidia and succeeds for libx264
    if (args.includes('null') && codec === 'h264_nvenc') {
      return makeFakeChild({ code: 0 })
    }
    if (codec === 'h264_nvenc') {
      return makeFakeChild({ code: 1, stderrText: 'nvenc runtime failure' })
    }
    if (codec === 'h264_qsv') {
      return makeFakeChild({ code: 0 })
    }
    return makeFakeChild({ code: 0 })
  })

  // Test QSV path directly: no hw_upload, no -init_hw_device, identity skips -vf
  await ffmpeg.apiConvertVideoWithCompression(
    inputPath,
    outputPath,
    23,
    30,
    'intel',
    1280,
    720,
    1280,
    720
  )
  const qsvCall = calls.at(-1)
  assert.equal(qsvCall.opts.windowsHide, true)
  assert.ok(!qsvCall.args.includes('-init_hw_device'))
  assert.ok(!qsvCall.args.includes('-vf'))
  assert.ok(!qsvCall.args.some((a) => String(a).includes('hw_upload')))

  // Test runtime fallback from auto->nvidia->libx264 and cache invalidation
  calls.length = 0
  await ffmpeg.apiConvertVideoWithCompression(
    inputPath,
    outputPath,
    23,
    30,
    'auto',
    1280,
    720,
    1280,
    720
  )
  assert.equal(ffmpeg.getCachedGpuEncoder(), null, 'failed GPU encoder cache must be invalidated')
  const usedCodecs = calls.map((c) => c.args[c.args.indexOf('-c:v') + 1])
  assert.ok(usedCodecs.includes('h264_nvenc'))
  assert.ok(usedCodecs.includes('libx264'))
})

test('encodeFramesToVideo omits hw_upload, computes duration from frame count, and falls back to libx264', async (t) => {
  const ffmpeg = loadFreshFfmpeg()
  ffmpeg.resetGpuEncoderCache()

  const dir = await mkdtemp(path.join(tmpdir(), 'msst-frames-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (let i = 0; i < 6; i++) {
    await writeFile(path.join(dir, `frame-${String(i).padStart(6, '0')}.jpg`), 'jpg')
  }
  const outputPath = path.join(dir, 'out.mp4')

  const calls = []
  t.mock.method(childProcess, 'spawn', (_bin, args, opts) => {
    calls.push({ args, opts })
    const codec = args[args.indexOf('-c:v') + 1]
    if (codec === 'h264_qsv') {
      return makeFakeChild({ code: 1, stderrText: 'qsv runtime failure' })
    }
    return makeFakeChild({ code: 0 })
  })

  await ffmpeg.encodeFramesToVideo(30, dir, outputPath, 'intel', 1280, 720, 23, 1280, 720)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].args[calls[0].args.indexOf('-c:v') + 1], 'h264_qsv')
  assert.ok(!calls[0].args.some((a) => String(a).includes('hw_upload')))
  assert.ok(!calls[0].args.includes('-vf'), 'identity dimensions skip scale filter')
  assert.equal(calls[1].args[calls[1].args.indexOf('-c:v') + 1], 'libx264')
  const aq = calls[1].args.indexOf('-x264-params')
  assert.ok(
    aq > 0 && String(calls[1].args[aq + 1]).includes('aq-mode=3'),
    'dark fades need aq-mode=3'
  )
})

test('VideoApiServer hardens /api/v1/download and protects active multi-dot sidecars from cleanup', async (t) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'msst-download-test-'))
  const api = new VideoApiServer(new Logger({ type: 'hidden' }), {
    port: 0,
    host: '127.0.0.1',
    outputDir,
    video: { width: 1280, height: 720, fps: 30 }
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

  await writeFile(path.join(outputDir, 'sample.mp4'), 'mp4-data')
  await writeFile(path.join(outputDir, 'sample.log.json'), '{"ok":true}')
  await writeFile(path.join(outputDir, 'sample.txt'), 'hello')

  const get = (reqPath) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: reqPath, method: 'GET' }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8')
          })
        )
      })
      req.on('error', reject)
      req.end()
    })

  // Traversal & backslash rejections
  for (const bad of ['..%2Fsecret.txt', 'sub%5Cfile.mp4', '%5Cwindows.mp4', 'a%2Fb.mp4']) {
    const res = await get(`/api/v1/download/${bad}`)
    assert.equal(res.status, 400, `expected 400 for ${bad}`)
  }

  // 404 omits path leak
  const missing = await get('/api/v1/download/does-not-exist.mp4')
  assert.equal(missing.status, 404)
  const missingJson = JSON.parse(missing.body)
  assert.equal(missingJson.error, 'File not found')
  assert.equal('path' in missingJson, false)

  // Content-Type derived from extension
  const mp4Res = await get('/api/v1/download/sample.mp4')
  assert.equal(mp4Res.status, 200)
  assert.match(mp4Res.headers['content-type'], /^video\/mp4/)

  const jsonRes = await get('/api/v1/download/sample.log.json')
  assert.equal(jsonRes.status, 200)
  assert.match(jsonRes.headers['content-type'], /^application\/json/)

  const txtRes = await get('/api/v1/download/sample.txt')
  assert.equal(txtRes.status, 200)
  assert.match(txtRes.headers['content-type'], /^text\/plain/)

  // cleanupOldExports preserves active multi-dot sidecars (.log.json)
  const activeId = 'export-active-1'
  const activeSidecar = path.join(outputDir, `${activeId}.log.json`)
  const staleSidecar = path.join(outputDir, 'export-stale-2.log.json')
  await writeFile(activeSidecar, '{}')
  await writeFile(staleSidecar, '{}')
  const ancient = new Date(Date.now() - 48 * 60 * 60 * 1000)
  await utimes(activeSidecar, ancient, ancient)
  await utimes(staleSidecar, ancient, ancient)
  api.activeExports.add(activeId)

  const cleanupRes = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/v1/cleanup', method: 'POST' },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      }
    )
    req.on('error', reject)
    req.end()
  })
  assert.equal(cleanupRes, 200)
  await stat(activeSidecar)
  await assert.rejects(stat(staleSidecar), { code: 'ENOENT' })
})

test('/bridge enforces session token, same-origin, path containment, proxy allowlists, and cleans intermediate MP4', async (t) => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'msst-bridge-sec-'))
  const outputDir = path.join(workDir, 'out')
  const outsideDir = path.join(process.cwd(), 'tmp-bridge-sec-check')
  const bridgeToken = 'test-bridge-secret-token-123456'

  const upstreamRequests = []
  const ttsServer = http.createServer((req, res) => {
    upstreamRequests.push({ server: 'tts', url: req.url, method: req.method })
    res.writeHead(200, { 'content-type': 'audio/wav' })
    res.end('RIFF')
  })
  const llmServer = http.createServer((req, res) => {
    upstreamRequests.push({ server: 'llm', url: req.url, method: req.method })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"choices":[]}')
  })
  await Promise.all([
    new Promise((r) => ttsServer.listen(0, '127.0.0.1', r)),
    new Promise((r) => llmServer.listen(0, '127.0.0.1', r))
  ])
  const ttsPort = ttsServer.address().port
  const llmPort = llmServer.address().port

  const config = {
    paths: { output: outputDir },
    video: { width: 1280, height: 720, fps: 30, crf: 23, encoder: 'cpu', recordTargetSizeMb: 0 },
    render: { workers: 1 },
    tts: { apiBaseUrl: `http://127.0.0.1:${ttsPort}`, timeoutMs: 5000 },
    llm: { enabled: true, baseUrl: `http://127.0.0.1:${llmPort}/v1`, timeoutMs: 5000 }
  }

  const app = express()
  app.use(
    '/bridge',
    createBridgeRouter({
      logger: new Logger({ type: 'hidden' }),
      config,
      bridgeToken
    })
  )
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const hub = new WsHub(
    new Logger({ type: 'hidden' }),
    {
      onWorkerReady: () => {},
      onWorkerMessage: () => {},
      onWorkerDisconnected: () => {}
    },
    bridgeToken
  )
  hub.attach(server)

  t.after(async () => {
    hub.closeAll()
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
    await Promise.all([
      new Promise((r) => ttsServer.close(r)),
      new Promise((r) => llmServer.close(r))
    ])
    await rm(workDir, { recursive: true, force: true })
  })

  const post = (reqPath, body, extraHeaders = {}) =>
    new Promise((resolve, reject) => {
      const payload = Buffer.isBuffer(body) ? body : JSON.stringify(body)
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: reqPath,
          method: 'POST',
          headers: {
            'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
            ...extraHeaders
          }
        },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8')
            })
          )
        }
      )
      req.on('error', reject)
      req.end(payload)
    })

  // 1. Token auth
  const unauth = await post('/bridge/invoke/electron:get-temp-base-dir', [])
  assert.equal(unauth.status, 401)
  assert.equal(unauth.headers['access-control-allow-origin'], undefined)

  const wrongTok = await post('/bridge/invoke/electron:get-temp-base-dir', [], {
    'x-mss-bridge-token': 'wrong-token'
  })
  assert.equal(wrongTok.status, 401)

  // 2. Cross-origin rejection
  const crossOrigin = await post('/bridge/invoke/electron:get-temp-base-dir', [], {
    'x-mss-bridge-token': bridgeToken,
    Origin: 'https://evil.example'
  })
  assert.equal(crossOrigin.status, 403)

  // 3. Valid token succeeds
  const okRes = await post('/bridge/invoke/electron:get-temp-base-dir', [], {
    'x-mss-bridge-token': bridgeToken
  })
  assert.equal(okRes.status, 200)
  const tempBase = JSON.parse(okRes.body).result
  await rm(tempBase, { recursive: true, force: true })

  // 4. WebSocket token auth
  await assert.rejects(
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge/ws?worker=w1`)
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
  )
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge/ws?worker=w1&token=${bridgeToken}`)
    ws.once('open', () => {
      ws.close()
      resolve()
    })
    ws.once('error', reject)
  })

  // 5. Path containment
  const escapeDelete = await post(
    '/bridge/invoke/electron:delete-temp-file',
    [{ filePath: path.join(outsideDir, 'target.txt') }],
    { 'x-mss-bridge-token': bridgeToken }
  )
  assert.equal(escapeDelete.status, 403)

  const escapeTempRoot = await post(
    '/bridge/invoke/electron:delete-temp-file',
    [{ filePath: tmpdir() }],
    { 'x-mss-bridge-token': bridgeToken }
  )
  assert.equal(escapeTempRoot.status, 403)

  const escapeWriteFrame = await post(
    `/bridge/bin/electron:write-frame?args=${encodeURIComponent(JSON.stringify([{ path: path.join(outsideDir, 'evil.jpg') }]))}`,
    Buffer.from('abc'),
    { 'x-mss-bridge-token': bridgeToken }
  )
  assert.equal(escapeWriteFrame.status, 403)

  // 6. Proxy URL allowlisting
  const blockedTts = await post(
    '/bridge/proxy/tts-fetch',
    { url: 'http://169.254.169.254/latest/meta-data/', method: 'GET', headers: {}, body: '' },
    { 'x-mss-bridge-token': bridgeToken }
  )
  assert.equal(blockedTts.status, 403)

  const allowedTts = await post(
    '/bridge/proxy/tts-fetch',
    { url: `http://127.0.0.1:${ttsPort}/tts`, method: 'GET', headers: {}, body: '' },
    { 'x-mss-bridge-token': bridgeToken }
  )
  assert.equal(allowedTts.status, 200)
  assert.equal(allowedTts.body, 'RIFF')

  const blockedLlm = await post(
    '/bridge/proxy/translation-fetch',
    { url: 'http://127.0.0.1:9999/internal', method: 'POST', headers: {}, body: '{}' },
    { 'x-mss-bridge-token': bridgeToken }
  )
  assert.equal(blockedLlm.status, 403)

  const allowedLlm = await post(
    '/bridge/proxy/translation-fetch',
    {
      url: `http://127.0.0.1:${llmPort}/v1/chat/completions`,
      method: 'POST',
      headers: {},
      body: '{}'
    },
    { 'x-mss-bridge-token': bridgeToken }
  )
  assert.equal(allowedLlm.status, 200)
  assert.equal(allowedLlm.body, '{"choices":[]}')
  assert.equal(upstreamRequests.length, 2)

  // 7. Intermediate MP4 cleanup on encode-frames-video failure
  const framesDir = path.join(workDir, 'frames')
  const audioPath = path.join(workDir, 'audio.wav')
  const finalOutputPath = path.join(outputDir, 'final.mp4')
  await fs.promises.mkdir(framesDir, { recursive: true })
  await writeFile(audioPath, 'wav')
  t.mock.method(bridgeFfmpeg, 'encodeFramesToVideo', async (_fps, _dir, outPath) => {
    await writeFile(outPath, 'intermediate-mp4')
  })
  t.mock.method(bridgeFfmpeg, 'apiMuxVideoAudioCopy', async () => {
    throw new Error('mux exploded')
  })
  const framesRes = await post(
    '/bridge/invoke/electron:api-encode-frames-video',
    [
      {
        framesDir,
        audioPath,
        outputPath: finalOutputPath,
        fps: 30,
        audioBitrate: '128k'
      }
    ],
    { 'x-mss-bridge-token': bridgeToken }
  )
  assert.equal(framesRes.status, 200)
  assert.equal(JSON.parse(framesRes.body).result.success, false)
  const remaining = await readdir(outputDir)
  assert.deepEqual(remaining, [], 'intermediate .mss-frames-video-*.mp4 must be cleaned up')
})

test('electron:write-file-at caches FileHandle across chunks and closes on explicit flush or idle timeout', async (t) => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'msst-fh-cache-'))
  const targetFile = path.join(workDir, 'chunked.mp4')
  await writeFile(targetFile, Buffer.alloc(16, 0))

  const realOpen = fs.promises.open
  let openCount = 0
  let closeCount = 0
  t.mock.method(fs.promises, 'open', async (filePath, flags) => {
    const handle = await realOpen(filePath, flags)
    if (path.resolve(String(filePath)) === path.resolve(targetFile)) {
      openCount++
      const realClose = handle.close.bind(handle)
      handle.close = async () => {
        closeCount++
        return realClose()
      }
    }
    return handle
  })

  const app = express()
  app.use(
    '/bridge',
    createBridgeRouter({
      logger: new Logger({ type: 'hidden' }),
      config: {
        video: { width: 1280, height: 720, fps: 30, crf: 23, encoder: 'cpu' },
        render: { workers: 1 }
      },
      fileHandleIdleMs: 500
    })
  )
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const realSetTimeout = globalThis.setTimeout
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })

  t.after(async () => {
    clock.uninstall()
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
    await rm(workDir, { recursive: true, force: true })
  })

  const writeAt = (position, bytes) =>
    new Promise((resolve, reject) => {
      const args = encodeURIComponent(JSON.stringify([{ filePath: targetFile, position }]))
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: `/bridge/bin/electron:write-file-at?args=${args}`,
          headers: { 'content-type': 'application/octet-stream' }
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode))
        }
      )
      req.on('error', reject)
      req.end(bytes)
    })

  const invokeClose = () =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/bridge/invoke/electron:close-file-handle',
          headers: { 'content-type': 'application/json' }
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode))
        }
      )
      req.on('error', reject)
      req.end(JSON.stringify([{ filePath: targetFile }]))
    })

  assert.equal(await writeAt(0, Buffer.from('AAAA')), 200)
  assert.equal(await writeAt(8, Buffer.from('BBBB')), 200)
  assert.equal(await writeAt(4, Buffer.from('CCCC')), 200)
  assert.equal(openCount, 1, 'multiple chunks must reuse one open FileHandle')
  assert.equal(closeCount, 0)

  assert.equal(await invokeClose(), 200)
  assert.equal(closeCount, 1, 'explicit close-file-handle must flush and close')

  const data = await readFile(targetFile, 'utf8')
  assert.equal(data.slice(0, 12), 'AAAACCCCBBBB')

  // Idle timeout auto-closes handle after inactivity
  assert.equal(await writeAt(12, Buffer.from('DDDD')), 200)
  assert.equal(openCount, 2)
  assert.equal(closeCount, 1)
  await clock.tickAsync(500)
  for (let i = 0; i < 400 && closeCount < 2; i++) {
    await new Promise((r) => realSetTimeout(r, 5))
  }
  assert.equal(closeCount, 2, 'idle timeout must close cached FileHandle')
})
