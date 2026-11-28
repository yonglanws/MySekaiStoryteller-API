import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import FakeTimers from '@sinonjs/fake-timers'
import { chromium } from 'playwright'
import { Logger } from 'tslog'
import {
  ensureInappUiAssets,
  prewarmCloudAssets,
  resolveStoryCloudAssets
} from '../../out-host/host/assets/cloudAssets.js'
import { StoryWriter } from '../../out-host/host/ai/storyWriter.js'
import { SegmentCoordinator } from '../../out-host/host/export/segmentCoordinator.js'
import { RenderPool } from '../../out-host/host/pool/renderPool.js'
import { VideoApiServer } from '../../out-host/host/servers/VideoApiServer.js'
import { registerAiRoutes } from '../../out-host/host/servers/routes/aiRoutes.js'
import { createRendererLoader } from '../export/lib/renderer-loader.mjs'

const silentLogger = new Logger({ type: 'hidden' })
const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined
}

const SSE_MOTION = {
  format: 'sse-motion',
  version: 1,
  name: 'w-normal-nod01',
  sampleRate: 60,
  startTime: 0,
  stopTime: 1,
  loopTime: false,
  fade: { in: 0.25, out: 0.3 },
  curves: [
    {
      binding: { resolved: { target: 'Parameter', id: 'ParamAngleX' } },
      kind: 'constant',
      value: 0.1
    }
  ]
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
  watermark: false,
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

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

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

function startMockCloudServer(delayMs = 35) {
  let inFlight = 0
  let maxInFlight = 0
  const hitsByPath = new Map()

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const key = url.pathname + url.search
    hitsByPath.set(key, (hitsByPath.get(key) ?? 0) + 1)

    const send = (value, type = 'application/json', applyDelay = false) => {
      const finish = () => {
        res.writeHead(200, { 'content-type': type })
        res.end(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
      }
      if (!applyDelay || delayMs <= 0) {
        finish()
        return
      }
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      setTimeout(() => {
        inFlight -= 1
        finish()
      }, delayMs)
    }

    if (url.pathname === '/api/assets/bundles') {
      const prefix = url.searchParams.get('prefix') || ''
      if (prefix === 'sound/scenario/se/') {
        send({
          items: [
            {
              type: 'bundle',
              name: 'se',
              path: 'sound/scenario/se/se',
              fileCount: 1,
              totalSize: 5
            }
          ]
        })
        return
      }
      send({ items: [] })
      return
    }

    if (url.pathname === '/api/assets/bundle-files') {
      const bundlePath = url.searchParams.get('path') || ''
      if (bundlePath === 'scenario/background/bg_a000301') {
        send({
          items: [
            {
              type: 'asset',
              name: 'bg_a000301.webp',
              path: 'scenario/background/bg_a000301/bg_a000301.webp',
              url: '/files/bg_a000301.webp',
              size: 16
            }
          ]
        })
        return
      }
      if (bundlePath === 'scenario/background/bg_a000302') {
        send({
          items: [
            {
              type: 'asset',
              name: 'bg_a000302.webp',
              path: 'scenario/background/bg_a000302/bg_a000302.webp',
              url: '/files/bg_a000302.webp',
              size: 16
            }
          ]
        })
        return
      }
      if (bundlePath === 'sound/scenario/bgm/bgm00003') {
        send({
          items: [
            {
              type: 'asset',
              name: 'bgm00003.mp3',
              path: 'sound/scenario/bgm/bgm00003/bgm00003.mp3',
              url: '/files/bgm00003.mp3',
              size: 16
            }
          ]
        })
        return
      }
      if (bundlePath === 'sound/scenario/se/se') {
        send({
          items: [
            {
              type: 'asset',
              name: 'se_door.mp3',
              path: 'sound/scenario/se/se/se_door.mp3',
              url: '/files/se_door.mp3',
              size: 16
            }
          ]
        })
        return
      }
      send({ items: [] })
      return
    }

    for (const modelId of ['01ichika_normal', '02saki_normal']) {
      if (url.pathname === `/library/live2d/model/${modelId}/_ripper.json`) {
        send({ files: [{ path: `${modelId}.model3.json` }] })
        return
      }
      if (url.pathname === `/library/live2d/model/${modelId}/${modelId}.model3.json`) {
        send({ FileReferences: {} }, 'application/json', true)
        return
      }
      const base = modelId.replace('_normal', '_motion_base')
      if (url.pathname === `/library/live2d/motion/${base}/_ripper.json`) {
        send({ files: [{ path: 'motion/w-normal-nod01.sse-motion.json' }] })
        return
      }
      if (url.pathname === `/library/live2d/motion/${base}/motion/w-normal-nod01.sse-motion.json`) {
        send(SSE_MOTION, 'application/json', true)
        return
      }
    }

    if (url.pathname.startsWith('/files/')) {
      send(Buffer.from('mock-binary-payload-1234'), 'application/octet-stream', true)
      return
    }

    if (url.pathname.startsWith('/inapp/')) {
      send(Buffer.from(`inapp:${url.pathname}`), 'application/octet-stream', true)
      return
    }

    res.writeHead(404)
    res.end('not found')
  })

  return {
    server,
    hitsByPath,
    getMaxInFlight: () => maxInFlight
  }
}

function makeCloudCatalog(base) {
  return {
    format: 'msst.cloud-catalog/1',
    generatedAt: new Date().toISOString(),
    region: 'jp',
    sources: { indexUrl: `${base}/models/jp/models.json`, libraryRoot: `${base}/library/` },
    models: [
      {
        id: '01ichika_normal',
        characterId: 1,
        name: '星乃一歌',
        shortName: '一歌',
        bundle: 'live2d/model/01ichika_normal',
        motionBundles: ['live2d/motion/01ichika_motion_base'],
        path: 'cloud/01ichika_normal/01ichika_normal/01ichika_normal.model3.json',
        motions: ['w-normal-nod01'],
        facials: [],
        defaultMotion: 'w-normal-nod01',
        defaultFacial: ''
      },
      {
        id: '02saki_normal',
        characterId: 2,
        name: '天马咲希',
        shortName: '咲希',
        bundle: 'live2d/model/02saki_normal',
        motionBundles: ['live2d/motion/02saki_motion_base'],
        path: 'cloud/02saki_normal/02saki_normal/02saki_normal.model3.json',
        motions: ['w-normal-nod01'],
        facials: [],
        defaultMotion: 'w-normal-nod01',
        defaultFacial: ''
      }
    ],
    backgrounds: [
      { id: 'bg_a000301', file: 'cloud/bg_a000301', name: '教室', aliases: [], description: '' },
      { id: 'bg_a000302', file: 'cloud/bg_a000302', name: '走廊', aliases: [], description: '' }
    ],
    bgm: [
      { id: 'bgm00003', file: 'cloud/bgm00003.mp3', name: 'Slapstick!!', description: '剧情 BGM' }
    ]
  }
}

function makeCloudSettings(base, resourcesDir) {
  return {
    source: 'moesekai',
    region: 'jp',
    indexBase: `${base}/models/`,
    libraryBase: `${base}/library/`,
    assetBase: base,
    soundtrackBase: `${base}/master/`,
    cacheDir: path.join(resourcesDir, 'cache'),
    concurrency: 8,
    timeoutMs: 5_000,
    retries: 0,
    cloudCatalog: true,
    cloudCatalogTtlHours: 6,
    cloudOnly: true
  }
}

// ============================================================================
// 1. Cloud Asset Parallelization & Process-Wide Single-Flight Deduplication
// ============================================================================

test('cloudAssets downloads models/BGs/BGM/SE in parallel and deduplicates overlapping exports + prewarm via single-flight locks', async (t) => {
  const mock = startMockCloudServer(40)
  mock.server.listen(0, '127.0.0.1')
  await once(mock.server, 'listening')
  const base = `http://127.0.0.1:${mock.server.address().port}`
  const resourcesDir = await mkdtemp(path.join(os.tmpdir(), 'msst-cloud-parallel-'))

  t.after(async () => {
    mock.server.close()
    await once(mock.server, 'close')
    await rm(resourcesDir, { recursive: true, force: true })
  })

  const ctx = {
    settings: makeCloudSettings(base, resourcesDir),
    resourcesDir,
    catalog: makeCloudCatalog(base),
    logger: noopLogger,
    cloudOnly: true
  }

  const makeStory = () => ({
    models: [
      { id: 1001, model: 'cloud/01ichika_normal/01ichika_normal/01ichika_normal.model3.json' },
      { id: 1002, model: 'cloud/02saki_normal/02saki_normal/02saki_normal.model3.json' }
    ],
    images: [
      { id: 1, image: '教室' },
      { id: 2, image: '走廊' }
    ],
    snippets: [
      {
        type: 'ChangeBgm',
        wait: false,
        delay: 0,
        data: { file: 'Slapstick!!', stop: false, fadeMs: 600, volume: 1 }
      },
      {
        type: 'PlaySe',
        wait: false,
        delay: 0,
        data: { file: 'se_door.mp3', volume: 1, loop: false, fadeMs: 0 }
      },
      {
        type: 'StopSe',
        wait: false,
        delay: 0,
        data: { file: 'se_door.mp3', fadeMs: 100 }
      }
    ]
  })

  const storyA = makeStory()
  const storyB = makeStory()

  // Launch background prewarm and two full story resolutions simultaneously
  const [prewarmRes, resA, resB] = await Promise.all([
    prewarmCloudAssets(
      {
        models: ['01ichika_normal', '02saki_normal'],
        backgrounds: ['教室', '走廊'],
        bgms: ['Slapstick!!'],
        ses: ['se_door.mp3']
      },
      ctx
    ),
    resolveStoryCloudAssets(storyA, ctx),
    resolveStoryCloudAssets(storyB, ctx)
  ])

  assert.ok(
    mock.getMaxInFlight() >= 3,
    `expected parallel cross-asset downloads (>=3 in-flight), got ${mock.getMaxInFlight()}`
  )

  for (const res of [resA, resB]) {
    assert.equal(res.models, 2)
    assert.equal(res.images, 2)
    assert.equal(res.bgm, 1)
    assert.equal(res.se, 2)
    assert.deepEqual(res.missing, [])
  }
  assert.ok(prewarmRes.models + prewarmRes.images + prewarmRes.bgm + prewarmRes.se >= 0)

  // Every remote asset file must be fetched strictly ONCE across all 3 overlapping callers
  for (const urlPath of [
    '/library/live2d/model/01ichika_normal/01ichika_normal.model3.json',
    '/library/live2d/model/02saki_normal/02saki_normal.model3.json',
    '/files/bg_a000301.webp',
    '/files/bg_a000302.webp',
    '/files/bgm00003.mp3',
    '/files/se_door.mp3'
  ]) {
    assert.equal(
      mock.hitsByPath.get(urlPath),
      1,
      `expected single-flight fetch count=1 for ${urlPath}, got ${mock.hitsByPath.get(urlPath)}`
    )
  }

  assert.equal(storyA.images[0].image, 'cloud/bg_a000301.webp')
  assert.equal(storyB.images[1].image, 'cloud/bg_a000302.webp')
})

test('ensureInappUiAssets deduplicates per file without colliding equal-length paths and re-downloads 0-byte corrupt cache', async (t) => {
  const mock = startMockCloudServer(30)
  mock.server.listen(0, '127.0.0.1')
  await once(mock.server, 'listening')
  const base = `http://127.0.0.1:${mock.server.address().port}`
  const resourcesDir = await mkdtemp(path.join(os.tmpdir(), 'msst-inapp-dedup-'))

  t.after(async () => {
    mock.server.close()
    await once(mock.server, 'close')
    await rm(resourcesDir, { recursive: true, force: true })
  })

  const ctx = {
    settings: makeCloudSettings(base, resourcesDir),
    resourcesDir,
    catalog: makeCloudCatalog(base),
    logger: noopLogger,
    cloudOnly: true
  }

  // Two distinct 1-element requests + a combined 2-element request must never collide on paths.length
  const [r1, r2, r3] = await Promise.all([
    ensureInappUiAssets(ctx, {
      inappBase: `${base}/inapp`,
      paths: ['player/loose/Sprite/a.png']
    }),
    ensureInappUiAssets(ctx, {
      inappBase: `${base}/inapp`,
      paths: ['player/loose/Sprite/b.png']
    }),
    ensureInappUiAssets(ctx, {
      inappBase: `${base}/inapp`,
      paths: ['player/loose/Sprite/a.png', 'player/loose/Sprite/b.png']
    })
  ])

  assert.deepEqual(r1.failed, [])
  assert.deepEqual(r2.failed, [])
  assert.deepEqual(r3.failed, [])
  assert.equal(mock.hitsByPath.get('/inapp/player/loose/Sprite/a.png'), 1)
  assert.equal(mock.hitsByPath.get('/inapp/player/loose/Sprite/b.png'), 1)
  assert.ok(
    fs.statSync(path.join(resourcesDir, 'inapp', 'jp-7.0.0', 'player/loose/Sprite/a.png')).size > 0
  )
  assert.ok(
    fs.statSync(path.join(resourcesDir, 'inapp', 'jp-7.0.0', 'player/loose/Sprite/b.png')).size > 0
  )

  // Corrupt 0-byte cached background must be treated as missing and re-downloaded
  const corruptBg = path.join(resourcesDir, 'images', 'cloud', 'bg_a000301.webp')
  fs.mkdirSync(path.dirname(corruptBg), { recursive: true })
  fs.writeFileSync(corruptBg, Buffer.alloc(0))

  const story = {
    models: [],
    images: [{ id: 1, image: '教室' }],
    snippets: []
  }
  const res = await resolveStoryCloudAssets(story, ctx)
  assert.equal(res.images, 1)
  assert.equal(mock.hitsByPath.get('/files/bg_a000301.webp'), 1)
  assert.ok(fs.statSync(corruptBg).size > 0, '0-byte background cache should be repaired')
})

// ============================================================================
// 2. AI Routes: Decoupled Concurrency, Bounded FIFO Queue, Early Slot Release
// ============================================================================

test('aiRoutes decouples default maxConcurrent from render.workers=1 and queues overflow FIFO without spurious 429', async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'msst-ai-queue-'))
  const savedEnv = process.env.MSS_LLM_MAX_CONCURRENT
  delete process.env.MSS_LLM_MAX_CONCURRENT

  // Part A: verify default maxConcurrent is 4 when render.workers === 1
  let defaultHandle = null
  const defaultApi = new VideoApiServer(silentLogger, {
    port: 0,
    host: '127.0.0.1',
    outputDir,
    video: { ...baseVideo, encoder: 'software' },
    registerExtraRoutes: (app, srv) => {
      defaultHandle = registerAiRoutes(app, srv, {
        config: {
          paths: { output: outputDir },
          llm: { targetMinutes: 1 },
          render: { workers: 1 }
        },
        llmClient: { enabled: true },
        storyWriter: {
          generate: async () => ({ story: { models: [], images: [], snippets: [] }, meta: {} })
        },
        useCloudCatalog: false,
        cloudCatalog: { get: () => null, waitReady: async () => undefined }
      })
    }
  })
  t.after(() => defaultApi.stop())
  assert.equal(defaultHandle.getMaxConcurrent(), 4)

  // Part B: maxConcurrent=2, maxQueueSize=2 -> 4 succeed in FIFO order, 5th rejected 429
  const startedOrder = []
  const gates = new Map()
  const enteredTwo = deferred()
  const enteredAllFour = deferred()
  let handle = null

  const api = new VideoApiServer(silentLogger, {
    port: 0,
    host: '127.0.0.1',
    outputDir,
    video: { ...baseVideo, encoder: 'software' },
    registerExtraRoutes: (app, srv) => {
      handle = registerAiRoutes(app, srv, {
        config: {
          paths: { output: outputDir },
          llm: { targetMinutes: 1 },
          render: { workers: 1 }
        },
        llmClient: { enabled: true },
        storyWriter: {
          generate: async ({ prompt }) => {
            startedOrder.push(prompt)
            if (startedOrder.length === 2) enteredTwo.resolve()
            if (startedOrder.length === 4) enteredAllFour.resolve()
            const gate = deferred()
            gates.set(prompt, gate)
            await gate.promise
            return {
              story: { models: [], images: [], snippets: [] },
              meta: { prompt }
            }
          }
        },
        useCloudCatalog: false,
        cloudCatalog: { get: () => null, waitReady: async () => undefined },
        maxConcurrent: 2,
        maxQueueSize: 2
      })
    }
  })

  await api.start()
  const server = api.getHttpServer()
  const port = server.address().port
  t.after(async () => {
    if (savedEnv === undefined) delete process.env.MSS_LLM_MAX_CONCURRENT
    else process.env.MSS_LLM_MAX_CONCURRENT = savedEnv
    for (const gate of gates.values()) gate.resolve()
    const closed = once(server, 'close')
    api.stop()
    server.closeAllConnections()
    await closed
    await rm(outputDir, { recursive: true, force: true })
  })

  const post = (prompt) =>
    httpRequest({
      port,
      reqPath: '/api/v1/script/generate',
      method: 'POST',
      body: { prompt }
    })

  // Send r1, r2 to saturate active slots
  const p1 = post('r1')
  const p2 = post('r2')
  await enteredTwo.promise
  assert.equal(handle.getActiveCount(), 2)
  assert.equal(handle.getQueuedCount(), 0)

  // Send r3, r4 into the bounded FIFO wait queue
  const p3 = post('r3')
  const p4 = post('r4')
  const waitUntilQueued = async (target) => {
    for (let i = 0; i < 100 && handle.getQueuedCount() < target; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
  }
  await waitUntilQueued(2)
  assert.equal(handle.getQueuedCount(), 2)

  // 5th request overflows maxQueueSize=2 -> immediate 429 with Retry-After
  const r5 = await post('r5')
  assert.equal(r5.status, 429)
  assert.equal(r5.headers['retry-after'], '10')

  // Release r1 & r2 -> r3 & r4 must drain in FIFO order
  gates.get('r1').resolve()
  gates.get('r2').resolve()
  await enteredAllFour.promise
  assert.deepEqual(startedOrder.slice(2), ['r3', 'r4'])

  gates.get('r3').resolve()
  gates.get('r4').resolve()

  const responses = await Promise.all([p1, p2, p3, p4])
  for (const res of responses) {
    assert.equal(res.status, 200)
    assert.equal(res.json.success, true)
  }
  assert.equal(handle.getActiveCount(), 0)
  assert.equal(handle.getQueuedCount(), 0)
})

test('aiRoutes releases AI slot before exportStory runs, triggers background cloud prewarm, and evicts timed-out queued waiters', async (t) => {
  const mock = startMockCloudServer(20)
  mock.server.listen(0, '127.0.0.1')
  await once(mock.server, 'listening')
  const base = `http://127.0.0.1:${mock.server.address().port}`
  const resourcesDir = await mkdtemp(path.join(os.tmpdir(), 'msst-ai-prewarm-res-'))
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'msst-ai-prewarm-out-'))

  const exportEntered = deferred()
  const exportRelease = deferred()
  const slot1Hold = deferred()
  const slot1Entered = deferred()
  const seenPrompts = []
  let handle = null

  const api = new VideoApiServer(silentLogger, {
    port: 0,
    host: '127.0.0.1',
    outputDir,
    video: { ...baseVideo, encoder: 'software' },
    registerExtraRoutes: (app, srv) => {
      handle = registerAiRoutes(app, srv, {
        config: {
          paths: { output: outputDir, resources: resourcesDir },
          llm: { targetMinutes: 1 },
          render: { workers: 1 },
          assets: makeCloudSettings(base, resourcesDir),
          bgm: { enabled: false, path: '' }
        },
        llmClient: { enabled: true },
        storyWriter: {
          generate: async ({ prompt, onAssetsPlanned }) => {
            seenPrompts.push(prompt)
            if (prompt === 'with-export') {
              onAssetsPlanned?.({
                stage: 'cast',
                models: [],
                backgrounds: ['教室'],
                bgms: [],
                ses: [],
                inapp: []
              })
              // Wait briefly so prewarm fetch runs concurrently with generate()
              await new Promise((r) => setTimeout(r, 60))
              return {
                story: { models: [], images: [{ id: 1, image: '教室' }], snippets: [] },
                meta: {}
              }
            }
            if (prompt === 'hold-slot') {
              slot1Entered.resolve()
              await slot1Hold.promise
              return { story: { models: [], images: [], snippets: [] }, meta: {} }
            }
            return { story: { models: [], images: [], snippets: [] }, meta: {} }
          }
        },
        useCloudCatalog: true,
        cloudCatalog: { get: () => makeCloudCatalog(base), waitReady: async () => undefined },
        maxConcurrent: 1,
        maxQueueSize: 2
      })
    }
  })

  api.exportStory = async () => {
    exportEntered.resolve()
    await exportRelease.promise
    return { videoPath: path.join(outputDir, 'out.mp4'), durationSec: 12 }
  }

  await api.start()
  const server = api.getHttpServer()
  const port = server.address().port
  t.after(async () => {
    slot1Hold.resolve()
    exportRelease.resolve()
    const closed = once(server, 'close')
    api.stop()
    server.closeAllConnections()
    await closed
    mock.server.close()
    await once(mock.server, 'close')
    await rm(resourcesDir, { recursive: true, force: true })
    await rm(outputDir, { recursive: true, force: true })
  })

  // 1. POST /api/v1/generate blocks in exportStory(), yet AI slot MUST already be released
  const genReq = httpRequest({
    port,
    reqPath: '/api/v1/generate',
    method: 'POST',
    body: { prompt: 'with-export' }
  })
  await exportEntered.promise
  assert.equal(handle.getActiveCount(), 0, 'AI slot must be released before exportStory starts')

  // Background prewarm triggered by onAssetsPlanned should already have materialized bg_a000301.webp
  const prewarmedBg = path.join(resourcesDir, 'images', 'cloud', 'bg_a000301.webp')
  assert.ok(fs.existsSync(prewarmedBg) && fs.statSync(prewarmedBg).size > 0)

  // Another AI request runs cleanly WHILE exportStory is still blocked!
  const concurrentAi = await httpRequest({
    port,
    reqPath: '/api/v1/script/generate',
    method: 'POST',
    body: { prompt: 'during-export' }
  })
  assert.equal(concurrentAi.status, 200)

  exportRelease.resolve()
  const genRes = await genReq
  assert.equal(genRes.status, 200)
  assert.equal(genRes.json.success, true)

  // 2. Queued waiter that times out is cleanly evicted and never runs storyWriter.generate
  const holdReq = httpRequest({
    port,
    reqPath: '/api/v1/script/generate',
    method: 'POST',
    body: { prompt: 'hold-slot' }
  })
  await slot1Entered.promise

  const timedOutWaiter = await httpRequest({
    port,
    reqPath: '/api/v1/script/generate',
    method: 'POST',
    body: { prompt: 'should-timeout-in-queue', timeout: 40 }
  })
  assert.equal(timedOutWaiter.status, 504)
  assert.equal(handle.getQueuedCount(), 0)

  slot1Hold.resolve()
  assert.equal((await holdReq).status, 200)
  assert.equal(seenPrompts.includes('should-timeout-in-queue'), false)
})

// ============================================================================
// 3. StoryWriter: Early onAssetsPlanned, Decoupled TTS Translation & 12/4 Chunks
// ============================================================================

test('StoryWriter emits onAssetsPlanned at cast/staging before direction finishes, starts TTS translation before staging completes, and chunks 12x4 in parallel', async () => {
  const events = []
  const plannedHints = []
  const stagingGate = deferred()
  const directionGate = deferred()

  let translateInFlight = 0
  let maxTranslateInFlight = 0
  const translateBatchSizes = []

  const catalog = {
    get: () => ({
      models: [
        {
          id: 1,
          name: '晓山瑞希',
          shortName: '瑞希',
          path: 'cloud/20mizuki_normal/20mizuki_normal/20mizuki_normal.model3.json',
          motions: ['w-normal-default01', 'w-normal-nod01'],
          facials: ['face_smile_01', 'face_normal_01'],
          defaultMotion: 'w-normal-default01',
          defaultFacial: 'face_smile_01'
        },
        {
          id: 2,
          name: '东云绘名',
          shortName: '绘名',
          path: 'cloud/21ena_normal/21ena_normal/21ena_normal.model3.json',
          motions: ['e-normal-default01'],
          facials: ['face_normal_01'],
          defaultMotion: 'e-normal-default01',
          defaultFacial: 'face_normal_01'
        }
      ],
      images: ['bg_room.jpg', 'bg_night.jpg'],
      imageDetails: [
        { file: 'bg_room.jpg', name: '教室', description: '放学后的教室' },
        { file: 'bg_night.jpg', name: '夜晚教室', description: '夜晚的教室' }
      ],
      voices: [],
      bgm: ['bgm00003.mp3', 'bgm00006.mp3'],
      bgmDetails: [
        { file: 'bgm00003.mp3', name: '日常', description: '日常' },
        { file: 'bgm00006.mp3', name: '夜晚', description: '安静的夜晚' }
      ]
    })
  }

  // 30 lines (~20 chars each so meanChars >= 16.5 and total >= 570 -> neither expand nor condense triggers)
  // With chunkSize=12, concurrency=4, splits into 3 concurrent chunks (12, 12, 6)
  const thirtyLines = Array.from({ length: 30 }, (_, i) => ({
    id: `l${i + 1}`,
    speaker: i % 2 === 0 ? '瑞希' : '绘名',
    content:
      i % 2 === 0
        ? `放学后的教室很安静，我们今天第${i + 1}段也认真练习吧！`
        : `嗯，第${i + 1}段的节奏我已经记牢了，这就开始吧。`
  }))

  const stageOf = (system) => {
    if (system.includes('第一轮')) return 'cast'
    if (system.includes('第二轮')) return 'dialogue'
    if (system.includes('情绪标注员')) return 'emotion'
    if (system.includes('舞台监督') || system.includes('directStaging')) return 'staging'
    if (
      system.includes('精细演技导演') ||
      system.includes('directActing') ||
      system.includes('第三轮')
    ) {
      return 'direction'
    }
    if (system.includes('中日翻译')) return 'translate'
    return 'unknown'
  }

  const fakeLlm = {
    enabled: true,
    async chatJson(messages) {
      const res = await this.chat(messages)
      return { data: JSON.parse(res.content), usage: res.usage }
    },
    async chat(messages) {
      const sys = messages[0]?.content ?? ''
      const user = messages[1]?.content ?? ''
      const wrap = (obj) => ({ content: JSON.stringify(obj), usage: null })
      const stage = stageOf(sys)

      if (stage === 'cast') {
        events.push('cast:done')
        return wrap({
          title: '放学后的练习',
          logline: '瑞希与绘名讨论练习计划',
          event: '放学后在教室排练',
          background: 'bg_room.jpg',
          cast: [
            { modelId: 1, name: '瑞希', role: '发起' },
            { modelId: 2, name: '绘名', role: '回应' }
          ],
          outline: ['起', '承', '转', '合']
        })
      }

      if (stage === 'dialogue') {
        events.push('dialogue:done')
        return wrap({
          title: '放学后的练习',
          lines: thirtyLines
        })
      }

      if (stage === 'translate') {
        translateInFlight += 1
        maxTranslateInFlight = Math.max(maxTranslateInFlight, translateInFlight)
        // Parse the JSON array payload sent to the translator
        const jsonMatch = user.match(/\[[\s\S]*\]/)
        const batch = jsonMatch ? JSON.parse(jsonMatch[0]) : []
        translateBatchSizes.push(batch.length)
        events.push(`translate:start:${batch.length}`)
        // Release stagingGate AFTER translate has started -> proves translate does NOT wait on staging!
        stagingGate.resolve()
        await new Promise((r) => setTimeout(r, 35))
        translateInFlight -= 1
        return wrap(batch.map(() => '今日も一緒に練習しよう。'))
      }

      if (stage === 'emotion') {
        events.push('emotion:done')
        return wrap({
          lines: thirtyLines.map((l, idx) => ({
            id: l.id,
            emotion: idx < 15 ? 'happy' : 'neutral'
          }))
        })
      }

      if (stage === 'staging') {
        events.push('staging:start')
        await stagingGate.promise
        events.push('staging:done')
        return wrap({
          scenes: [
            {
              id: 's1',
              fromLineId: 'l1',
              background: 'bg_night.jpg',
              ambient: 'none',
              activeCast: ['瑞希', '绘名'],
              bgm: 'bgm00006.mp3',
              transitionIn: 'sideFade'
            }
          ],
          events: [{ afterLineId: 'l5', type: 'se', file: 'se_door.mp3' }]
        })
      }

      if (stage === 'direction') {
        events.push('direction:start')
        // Wait briefly so staging's onAssetsPlanned has definitely fired before direction finishes
        await new Promise((r) => setTimeout(r, 20))
        directionGate.resolve()
        events.push('direction:done')
        return wrap({
          background: 'bg_room.jpg',
          bgm: 'bgm00003.mp3',
          bgmStop: true,
          lines: thirtyLines.map((l) => ({
            id: l.id,
            motion: l.speaker === '瑞希' ? 'w-normal-nod01' : 'e-normal-default01',
            facial: 'face_normal_01'
          }))
        })
      }

      throw new Error(`unexpected stage prompt: ${sys.slice(0, 80)}`)
    }
  }

  const writer = new StoryWriter(
    fakeLlm,
    {
      enabled: true,
      pipeline: 'staged',
      polishDialogue: false,
      translateForTts: true,
      targetMinutes: 1,
      temperature: 0.7,
      maxTokens: 4096,
      repairRounds: 0,
      personaDirs: [],
      personas: [
        { name: '晓山瑞希', prompt: '瑞希性格轻快。', aliases: ['mizuki'], group: '25时' },
        { name: '东云绘名', prompt: '绘名嘴硬心软。', aliases: ['ena'], group: '25时' }
      ]
    },
    catalog,
    silentLogger,
    ['happy', 'neutral'],
    null
  )

  const result = await writer.generate({
    prompt: '瑞希和绘名放学后聊天',
    pipeline: 'staged',
    targetMinutes: 2,
    directorReview: false,
    translateForTts: true,
    onAssetsPlanned: (hint) => {
      events.push(`prewarm:${hint.stage}`)
      plannedHints.push(hint)
    }
  })

  assert.ok(result.story.snippets.length > 0)

  // 1. translateDialogue started BEFORE staging completed
  const firstTranslateIdx = events.findIndex((e) => e.startsWith('translate:start:'))
  const stagingDoneIdx = events.indexOf('staging:done')
  assert.ok(firstTranslateIdx >= 0 && stagingDoneIdx >= 0)
  assert.ok(
    firstTranslateIdx < stagingDoneIdx,
    `expected translate to start before staging completes, events=${JSON.stringify(events)}`
  )

  // 2. 30 lines split into chunkSize=12 batches (12, 12, 6) running in parallel (>= 2 in-flight)
  assert.deepEqual(
    [...translateBatchSizes].sort((a, b) => b - a),
    [12, 12, 6]
  )
  assert.ok(
    maxTranslateInFlight >= 2,
    `expected parallel TTS translation chunks (>=2), got ${maxTranslateInFlight}`
  )

  // 3. onAssetsPlanned emitted at cast AND staging BEFORE direction finished
  const stages = plannedHints.map((h) => h.stage)
  assert.ok(stages.includes('cast'), `expected cast prewarm hint, got ${JSON.stringify(stages)}`)
  assert.ok(
    stages.includes('staging'),
    `expected staging prewarm hint, got ${JSON.stringify(stages)}`
  )
  const prewarmCastIdx = events.indexOf('prewarm:cast')
  const prewarmStagingIdx = events.indexOf('prewarm:staging')
  const directionDoneIdx = events.indexOf('direction:done')
  assert.ok(prewarmCastIdx < directionDoneIdx)
  assert.ok(prewarmStagingIdx < directionDoneIdx)

  const castHint = plannedHints.find((h) => h.stage === 'cast')
  assert.equal(castHint.models.length, 2)
  const stagingHint = plannedHints.find((h) => h.stage === 'staging')
  assert.ok(stagingHint.backgrounds.includes('bg_night.jpg'))
  assert.ok(stagingHint.bgms.includes('bgm00006.mp3'))
})

// ============================================================================
// 4. RenderPool Parallel Startup, Wear Balancing, Prep No-Recycle & SegmentCoordinator
// ============================================================================

test('RenderPool launches workers in parallel batches, balances worker wear, and skips workerRecycleExports on segmentPrepareOnly', async (t) => {
  const clock = FakeTimers.install({
    now: 2_000_000,
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
  })
  const sent = []
  const browsers = []
  let launchInFlight = 0
  let maxLaunchInFlight = 0

  const config = {
    server: { port: 9881 },
    render: {
      workers: 2,
      workerRecycleExports: 1,
      browserChannels: [],
      extraChromeArgs: '',
      minFreeMemoryMb: 0
    },
    tts: { characters: [] },
    bgm: { enabled: false }
  }

  const pool = new RenderPool(silentLogger, config, {
    send(workerId, message) {
      sent.push({ workerId, ...message })
      return true
    },
    closeAll: () => undefined
  })

  t.mock.method(chromium, 'launch', async () => {
    launchInFlight += 1
    maxLaunchInFlight = Math.max(maxLaunchInFlight, launchInFlight)
    await Promise.resolve()
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
    launchInFlight -= 1
    return browser
  })

  t.after(async () => {
    await pool.stop()
    clock.uninstall()
  })

  await pool.start()
  assert.equal(maxLaunchInFlight, 2, '2 workers must launch in parallel batch')
  assert.equal(browsers[0].pages[0].workerId, 'w1')
  assert.equal(browsers[1].pages[0].workerId, 'w2')

  // 1. segmentPrepareOnly task must NOT count toward workerRecycleExports or close browser
  pool.dispatch({
    taskId: 'job1__prep',
    addedAt: Date.now(),
    timeoutMs: 600_000,
    story: { models: [], images: [], snippets: [] },
    outputPath: 'job1.mp4',
    videoConfig: { segmentPrepareOnly: true }
  })
  const prepMsg = sent.find((m) => m.type === 'api:start-export')
  assert.equal(prepMsg.workerId, 'w1')
  pool.handleWorkerMessage('w1', {
    type: 'api:export-result',
    args: [{ taskId: 'job1__prep', success: true }]
  })
  assert.equal(browsers[0].connected, true, 'segmentPrepareOnly must NOT trigger worker recycle')

  // 2. Disable recycling and verify least-used worker balancing (w1 completes 1 -> next picks w2)
  config.render.workerRecycleExports = 0
  pool.dispatch({
    taskId: 'full-1',
    addedAt: Date.now(),
    timeoutMs: 600_000,
    story: { models: [], images: [], snippets: [] },
    outputPath: 'full-1.mp4',
    videoConfig: {}
  })
  pool.handleWorkerMessage('w1', {
    type: 'api:export-result',
    args: [{ taskId: 'full-1', success: true }]
  })

  pool.dispatch({
    taskId: 'full-2',
    addedAt: Date.now(),
    timeoutMs: 600_000,
    story: { models: [], images: [], snippets: [] },
    outputPath: 'full-2.mp4',
    videoConfig: {}
  })
  const full2Start = sent.find(
    (m) => m.type === 'api:start-export' && m.args[0].taskId === 'full-2'
  )
  assert.equal(full2Start.workerId, 'w2', 'least-used worker w2 should be chosen over w1')
})

test('SegmentCoordinator + VideoApiServer: demand-aware segmentation bypasses split under concurrent users and cancels sibling segments on error', async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'msst-seg-demand-'))
  t.after(async () => {
    await rm(outputDir, { recursive: true, force: true })
  })

  const longStory = {
    models: [],
    images: [],
    snippets: Array.from({ length: 20 }, (_, i) => ({
      type: 'Talk',
      wait: true,
      delay: 2,
      data: { speaker: '瑞希', content: `测试长剧情对话第${i + 1}句内容足够长以触发并行分段` }
    }))
  }

  // Part A: VideoApiServer stamps queuedPeers so 2 concurrent exports on 2 workers run directly 1-each
  const dispatched = []
  let idleWorkers = 2
  const coordinator = new SegmentCoordinator(silentLogger, {
    dispatchSubTask: async () => ({ taskId: 'noop', success: true }),
    cancelSubTask: async () => undefined,
    readyWorkerCount: () => 2,
    idleWorkerCount: () => idleWorkers,
    canUseParallelSegments: () => true,
    onTaskComplete: () => undefined
  })

  const api = new VideoApiServer(silentLogger, {
    port: 0,
    host: '127.0.0.1',
    outputDir,
    maxConcurrentExports: 2,
    video: { ...baseVideo, encoder: 'software', exportJobs: 2, useRustExporter: true }
  })
  t.after(() => api.stop())

  const twoDispatched = deferred()
  api.setDispatcher({
    dispatch(task) {
      dispatched.push({
        taskId: task.taskId,
        outputPath: task.outputPath,
        queuedPeers: task.queuedPeers,
        wouldSegment: coordinator.shouldUseParallelSegments(task)
      })
      if (dispatched.length === 1 && task.queuedPeers === undefined) {
        fs.writeFileSync(task.outputPath, Buffer.from('solo-mp4'))
        api.resolveExport(task.taskId, {
          success: true,
          videoPath: task.outputPath
        })
      }
      if (dispatched.length === 3) {
        twoDispatched.resolve()
      }
    },
    cancel: () => undefined
  })

  // Solo export -> queuedPeers undefined, idleWorkers=2 -> splits into parallel segments!
  await api.exportStory(longStory, 60_000)
  assert.equal(dispatched[0].queuedPeers, undefined)
  assert.equal(dispatched[0].wouldSegment, true)

  // Two concurrent exports -> task 2 arrives while task 1 is active (queuedPeers=1 -> bypasses segmentation);
  // and a 3rd queued behind them causes the next drained task to also see queuedPeers >= 1!
  const threeDispatched = deferred()
  api.setDispatcher({
    dispatch(task) {
      dispatched.push({
        taskId: task.taskId,
        outputPath: task.outputPath,
        queuedPeers: task.queuedPeers,
        wouldSegment: coordinator.shouldUseParallelSegments(task)
      })
      if (dispatched.length === 3) {
        twoDispatched.resolve()
      }
      if (dispatched.length === 4) {
        threeDispatched.resolve()
      }
    },
    cancel: () => undefined
  })

  const pA = api.exportStory(longStory, 60_000)
  const pB = api.exportStory(longStory, 60_000)
  const pC = api.exportStory(longStory, 60_000)
  await twoDispatched.promise

  // task 2 (dispatched[2]) runs alongside active task 1 -> queuedPeers === 1 -> bypasses segmentation
  assert.equal(dispatched[2].queuedPeers, 1)
  assert.equal(dispatched[2].wouldSegment, false)

  // Complete task 1 -> drains queued task 3 while task 2 is still active -> queuedPeers === 1
  fs.writeFileSync(dispatched[1].outputPath, Buffer.from('a-mp4'))
  api.resolveExport(dispatched[1].taskId, {
    success: true,
    videoPath: dispatched[1].outputPath
  })
  await threeDispatched.promise
  assert.equal(dispatched[3].queuedPeers, 1)
  assert.equal(dispatched[3].wouldSegment, false)

  fs.writeFileSync(dispatched[2].outputPath, Buffer.from('b-mp4'))
  fs.writeFileSync(dispatched[3].outputPath, Buffer.from('c-mp4'))
  api.resolveExport(dispatched[2].taskId, {
    success: true,
    videoPath: dispatched[2].outputPath
  })
  api.resolveExport(dispatched[3].taskId, {
    success: true,
    videoPath: dispatched[3].outputPath
  })
  await Promise.all([pA, pB, pC])

  // Low-memory guard disables parallel segments cleanly
  const memGuarded = new SegmentCoordinator(silentLogger, {
    dispatchSubTask: async () => ({ taskId: 'noop', success: true }),
    cancelSubTask: async () => undefined,
    readyWorkerCount: () => 2,
    idleWorkerCount: () => 2,
    canUseParallelSegments: () => false,
    onTaskComplete: () => undefined
  })
  assert.equal(
    memGuarded.shouldUseParallelSegments({
      taskId: 'solo-low-mem',
      addedAt: Date.now(),
      timeoutMs: 60_000,
      story: longStory,
      outputPath: path.join(outputDir, 'm.mp4'),
      videoConfig: { ...baseVideo, exportJobs: 2, useRustExporter: true }
    }),
    false
  )

  // Part B: fatal error on segment 0 cancels still-running sibling segment 1 before cleanup
  const cancelledSubTasks = []
  const seg1Running = deferred()
  const seg1Cancelled = deferred()
  const parentDone = deferred()

  const errCoordinator = new SegmentCoordinator(silentLogger, {
    async dispatchSubTask(subTask) {
      if (subTask.videoConfig.segmentPrepareOnly) {
        return {
          taskId: subTask.taskId,
          success: true,
          prepared: {
            totalFrames: 1200,
            encodeFps: 30,
            audioFilePath: path.join(subTask.videoConfig.segmentSharedDir, 'audio.wav'),
            ttsWavs: []
          }
        }
      }
      if (subTask.videoConfig.segmentRange.index === 0) {
        return { taskId: subTask.taskId, success: false, error: 'seg0 boom' }
      }
      seg1Running.resolve()
      await seg1Cancelled.promise
      return { taskId: subTask.taskId, success: false, error: 'cancelled' }
    },
    async cancelSubTask(subTaskId) {
      cancelledSubTasks.push(subTaskId)
      seg1Cancelled.resolve()
    },
    readyWorkerCount: () => 2,
    idleWorkerCount: () => 2,
    canUseParallelSegments: () => true,
    onTaskComplete(taskId, result) {
      parentDone.resolve({ taskId, result })
    }
  })

  errCoordinator.start({
    taskId: 'seg-err-job',
    addedAt: Date.now(),
    timeoutMs: 60_000,
    story: longStory,
    outputPath: path.join(outputDir, 'err.mp4'),
    videoConfig: { ...baseVideo, exportJobs: 2, useRustExporter: true }
  })

  await seg1Running.promise
  const finished = await parentDone.promise
  assert.equal(finished.result.success, false)
  assert.match(finished.result.error, /seg0 boom/)
  assert.ok(
    cancelledSubTasks.some((id) => id.includes('__seg1_')),
    `expected sibling seg1 to be cancelled, got ${JSON.stringify(cancelledSubTasks)}`
  )
})

// ============================================================================
// 5. Renderer Pipeline: ConcurrentExportPipeline, JpegFrameSink & GpuYuv420Converter
// ============================================================================

test('ConcurrentExportPipeline supports multiple concurrent waitForTTSReady waiters and provider-aware concurrency caps', async () => {
  const loader = createRendererLoader()
  const { ConcurrentExportPipeline } = loader.load(
    'managers/video-export/ConcurrentExportPipeline.ts'
  )

  const snippets = Array.from({ length: 6 }, (_, i) => ({
    type: 'Talk',
    wait: true,
    delay: 0,
    data: { speaker: '瑞希', content: `台词${i + 1}`, ttsText: `台词${i + 1}` }
  }))

  const runWithProvider = async (provider, maxConcurrentTts) => {
    let inFlight = 0
    let maxInFlight = 0
    const firstGate = deferred()
    const firstStarted = deferred()
    const ttsManager = {
      getConfig: () => ({
        provider,
        speedFactor: 1,
        defaultRefAudioPath: '',
        irodori: {
          defaultLoraAdapter: '',
          defaultCaption: '',
          timbreLockMode: 'normal',
          numSteps: 20,
          cfgScaleText: 3,
          cfgScaleSpeaker: 5,
          cfgScaleCaption: 2
        }
      }),
      setCurrentTime: () => undefined,
      synthesizeWithText: async (_text, _speaker, index) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        if (index === 0) {
          firstStarted.resolve()
          await firstGate.promise
        } else {
          await new Promise((r) => setTimeout(r, 25))
        }
        inFlight -= 1
        return { success: true, duration: 1.5 }
      }
    }

    const pipeline = new ConcurrentExportPipeline({
      maxConcurrentTts,
      ttsTimeoutMs: 5000
    })
    pipeline.startTTSPipeline(snippets, ttsManager)
    await firstStarted.promise

    // Attach TWO concurrent waiters on snippet 0; both must resolve (no resolver overwrite)
    const w1 = pipeline.waitForTTSReady(0)
    const w2 = pipeline.waitForTTSReady(0)
    firstGate.resolve()
    const [r1, r2] = await Promise.all([w1, w2])
    assert.equal(r1.success, true)
    assert.equal(r2.success, true)

    await Promise.all(snippets.map((_, idx) => pipeline.waitForTTSReady(idx)))
    return maxInFlight
  }

  const gptSovitsMax = await runWithProvider('gpt-sovits', 4)
  assert.ok(
    gptSovitsMax <= 2,
    `gpt-sovits concurrency should be capped at <=2, got ${gptSovitsMax}`
  )

  const irodoriMax = await runWithProvider('irodori', 4)
  assert.equal(irodoriMax, 4, `irodori should use full maxConcurrentTts=4, got ${irodoriMax}`)
})

test('JpegFrameSink recycles pooled rustPacketPool buffers during PBO warm-up and GpuYuv420Converter uses bilinear chroma shader with uniform1i only', async () => {
  const realSetTimeout = globalThis.setTimeout.bind(globalThis)
  const rendererRoot = path.join(process.cwd(), 'src/renderer/src')

  class FakeRustWs {
    static OPEN = 1
    static CLOSED = 3
    constructor() {
      this.readyState = 0
      this.bufferedAmount = 0
      this._listeners = new Map()
      this.sentBuffers = new Set()
      realSetTimeout(() => {
        this.readyState = FakeRustWs.OPEN
        this._emit('open', {})
      }, 1)
    }
    addEventListener(type, fn) {
      let set = this._listeners.get(type)
      if (!set) {
        set = new Set()
        this._listeners.set(type, set)
      }
      set.add(fn)
    }
    removeEventListener(type, fn) {
      this._listeners.get(type)?.delete(fn)
    }
    _emit(type, ev) {
      for (const fn of [...(this._listeners.get(type) ?? [])]) fn(ev)
    }
    send(data) {
      if (typeof data === 'string') {
        const msg = JSON.parse(data)
        realSetTimeout(() => {
          this._emit('message', {
            data: JSON.stringify({
              ok: true,
              op: 'ack',
              streamId: msg.streamId,
              encoder: 'hevc_qsv'
            })
          })
        }, 1)
        return
      }
      const view = data instanceof Uint8Array ? data : new Uint8Array(data)
      this.sentBuffers.add(view.buffer)
    }
    close() {
      this.readyState = FakeRustWs.CLOSED
    }
  }

  // Part A: JpegFrameSink buffer pool recycling across PBO warm-up (enqueueAsync returning null)
  const wsInstances = []
  const seenReuseBuffers = new Set()
  let enqueueCalls = 0
  const frameBytes = 16 * 16 * 1.5
  const fakeConverter = {
    frameByteLength: frameBytes,
    get willYieldOnNextEnqueue() {
      // Simulate 3-slot PBO warm-up: first 2 frames won't yield output yet
      return enqueueCalls >= 2
    },
    async enqueueAsync(_canvas, reuse) {
      enqueueCalls += 1
      if (reuse) seenReuseBuffers.add(reuse.buffer)
      if (enqueueCalls <= 2) {
        assert.equal(reuse, undefined, 'warm-up enqueue must skip acquiring a pooled packet buffer')
        return null
      }
      return reuse ?? new Uint8Array(frameBytes)
    },
    async drainAllAsync() {
      return []
    },
    dispose() {}
  }

  const sinkLoader = createRendererLoader(
    new Map([
      [
        path.join(rendererRoot, 'managers/video-export/ExportLogger.ts'),
        {
          ExportLogger: class {
            info() {}
            warn() {}
            error() {}
          }
        }
      ],
      [
        path.join(rendererRoot, 'managers/video-export/AsyncFrameCapturer.ts'),
        {
          AsyncFrameCapturer: class {
            async initialize() {}
            async dispose() {}
          }
        }
      ],
      [
        path.join(rendererRoot, 'managers/video-export/GpuYuv420Converter.ts'),
        { GpuYuv420Converter: { create: () => fakeConverter } }
      ]
    ]),
    {
      window: {
        electron: {
          ipcRenderer: {
            invoke: async (channel) => {
              if (channel === 'electron:get-temp-base-dir') return '/tmp/mss-pbo-pool'
              return undefined
            }
          }
        }
      },
      WebSocket: class extends FakeRustWs {
        constructor(url) {
          super(url)
          wsInstances.push(this)
        }
      },
      location: { protocol: 'http:', host: '127.0.0.1:9881', search: '' },
      URLSearchParams,
      fetch: async () => ({
        ok: true,
        json: async () => ({
          ok: true,
          backend: 'rust',
          wsUrl: 'ws://127.0.0.1:41234/bridge/rs-stream',
          videoConfig: { codec: 'hevc', encoder: 'intel', crf: 27 }
        })
      })
    }
  )

  const { JpegFrameSink } = sinkLoader.load('managers/video-export/JpegFrameSink.ts')
  const sink = new JpegFrameSink({ width: 16, height: 16, quality: 0.92, fps: 30, crf: 27 })
  await sink.initialize({})
  assert.equal(sink.isRustWsPipeMode, true)

  for (let i = 0; i < 6; i++) {
    await sink.captureFrame({})
  }
  await sink.finish()

  // Warm-up frames (calls 1 & 2) must return their unused packet buffer back to rustPacketPool,
  // so only 1 ArrayBuffer is ever allocated across all 6 frames!
  assert.equal(
    seenReuseBuffers.size,
    1,
    `expected pooled packet buffer reuse (1 allocation across 6 frames), got ${seenReuseBuffers.size}`
  )
  assert.equal(wsInstances[0].sentBuffers.size, 1)

  // Part B: GpuYuv420Converter optimized bilinear chroma shader & uniform1i-only mock compatibility
  const shaderSources = []
  const fakeGl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    TEXTURE0: 8,
    TEXTURE_2D: 9,
    TEXTURE_MIN_FILTER: 10,
    TEXTURE_MAG_FILTER: 11,
    TEXTURE_WRAP_S: 12,
    TEXTURE_WRAP_T: 13,
    LINEAR: 14,
    NEAREST: 15,
    CLAMP_TO_EDGE: 16,
    RGBA8: 17,
    RGBA: 18,
    UNSIGNED_BYTE: 19,
    FRAMEBUFFER: 20,
    COLOR_ATTACHMENT0: 21,
    FRAMEBUFFER_COMPLETE: 22,
    PIXEL_PACK_BUFFER: 23,
    STREAM_READ: 24,
    UNPACK_FLIP_Y_WEBGL: 25,
    TRIANGLE_STRIP: 26,
    SYNC_GPU_COMMANDS_COMPLETE: 27,
    ALREADY_SIGNALED: 28,
    CONDITION_SATISFIED: 29,
    TIMEOUT_EXPIRED: 30,
    WAIT_FAILED: 31,
    createShader: () => ({}),
    shaderSource: (_shader, src) => shaderSources.push(src),
    compileShader: () => {},
    getShaderParameter: () => true,
    deleteShader: () => {},
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    deleteProgram: () => {},
    createVertexArray: () => ({}),
    deleteVertexArray: () => {},
    createBuffer: () => ({}),
    deleteBuffer: () => {},
    createTexture: () => ({}),
    deleteTexture: () => {},
    createFramebuffer: () => ({}),
    deleteFramebuffer: () => {},
    bindVertexArray: () => {},
    bindBuffer: () => {},
    bufferData: () => {},
    getAttribLocation: () => 0,
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    activeTexture: () => {},
    bindTexture: () => {},
    texParameteri: () => {},
    texImage2D: () => {},
    texSubImage2D: () => {},
    bindFramebuffer: () => {},
    framebufferTexture2D: () => {},
    checkFramebufferStatus: () => 22,
    useProgram: () => {},
    getUniformLocation: () => ({}),
    uniform1i: () => {},
    viewport: () => {},
    pixelStorei: () => {},
    drawArrays: () => {},
    readPixels: () => {},
    fenceSync: () => ({}),
    deleteSync: () => {},
    flush: () => {},
    clientWaitSync: () => 28,
    getBufferSubData: (_target, _offset, dst) => dst.fill(128)
  }

  const convLoader = createRendererLoader(new Map(), {
    OffscreenCanvas: class {
      getContext(type) {
        return type === 'webgl2' ? fakeGl : null
      }
    }
  })
  const { GpuYuv420Converter } = convLoader.load('managers/video-export/GpuYuv420Converter.ts')
  const conv = GpuYuv420Converter.create(16, 16, 3)
  assert.ok(conv)
  assert.equal(conv.willYieldOnNextEnqueue, false, '3-slot PBO warm-up frame 1 must not yield')
  assert.equal(await conv.enqueueAsync({ width: 16, height: 16 }), null)
  assert.equal(conv.willYieldOnNextEnqueue, false, '3-slot PBO warm-up frame 2 must not yield')
  assert.equal(await conv.enqueueAsync({ width: 16, height: 16 }), null)
  assert.equal(conv.willYieldOnNextEnqueue, true, '3-slot PBO frame 3 must yield')
  const f3 = await conv.enqueueAsync({ width: 16, height: 16 })
  assert.ok(f3 instanceof Uint8Array)
  const fragSrc = shaderSources.find((src) => src.includes('fragColor')) ?? ''
  assert.ok(fragSrc.includes('invSize'), 'fragment shader should hoist invSize reciprocal')
  assert.equal(
    (fragSrc.match(/texture\(uTex,/g) ?? []).length <= 8,
    true,
    'bilinear 2x2 chroma sampling should reduce chroma texture fetches by 75%'
  )
  conv.dispose()
})
