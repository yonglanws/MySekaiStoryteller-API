/**
 * 云端按需物化：故事里写背景名（教室）、BGM 曲名与云端模型路径，
 * 导出前由宿主下载到 resources/cloud/ 并把故事改写成渲染端可加载的路径。
 * 这里用假资源站覆盖 背景 / BGM / SE / Live2D 四条链路。
 */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  resolveGlobalBgm,
  resolveStoryCloudAssets
} from '../../out-host/host/assets/cloudAssets.js'
import { fetchBuffer } from '../../out-host/host/assets/http.js'
import {
  canonicalFallbackUrls,
  resetCanonicalSitePreference
} from '../../out-host/host/assets/moesekai.js'

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

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const send = (value, type = 'application/json') => {
      res.writeHead(200, { 'content-type': type })
      res.end(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
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
              size: 5
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
              size: 5
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
              size: 5
            }
          ]
        })
        return
      }
      send({ items: [] })
      return
    }
    if (url.pathname === '/library/live2d/model/01ichika_normal/_ripper.json') {
      send({ files: [{ path: '01ichika_normal.model3.json' }] })
      return
    }
    if (url.pathname === '/library/live2d/model/01ichika_normal/01ichika_normal.model3.json') {
      send({ FileReferences: {} })
      return
    }
    if (url.pathname === '/library/live2d/motion/01ichika_motion_base/_ripper.json') {
      send({ files: [{ path: 'motion/w-normal-nod01.sse-motion.json' }] })
      return
    }
    if (
      url.pathname ===
      '/library/live2d/motion/01ichika_motion_base/motion/w-normal-nod01.sse-motion.json'
    ) {
      send(SSE_MOTION)
      return
    }
    if (url.pathname.startsWith('/files/')) {
      send('xxxxx', 'application/octet-stream')
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  return server
}

test('story cloud refs materialize into resources/cloud and rewrite paths', async () => {
  const server = startServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-cloud-assets-'))
  const settings = {
    source: 'moesekai',
    region: 'jp',
    indexBase: `${base}/models/`,
    libraryBase: `${base}/library/`,
    assetBase: base,
    soundtrackBase: `${base}/master/`,
    cacheDir: path.join(resourcesDir, 'cache'),
    concurrency: 1,
    timeoutMs: 5_000,
    retries: 0,
    cloudCatalog: true,
    cloudCatalogTtlHours: 6
  }
  const catalog = {
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
      }
    ],
    backgrounds: [
      {
        id: 'bg_a000301',
        file: 'cloud/bg_a000301',
        name: '教室',
        aliases: [],
        description: ''
      }
    ],
    bgm: [
      {
        id: 'bgm00003',
        file: 'cloud/bgm00003.mp3',
        name: 'Slapstick!!',
        description: '剧情 BGM'
      }
    ]
  }
  const story = {
    models: [
      { id: 1001, model: 'cloud/01ichika_normal/01ichika_normal/01ichika_normal.model3.json' }
    ],
    images: [{ id: 1, image: '教室' }],
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
  }
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  }
  try {
    const cloudContext = { settings, resourcesDir, catalog, logger }
    const globalBgm = { enabled: true, path: 'Slapstick!!' }
    assert.equal(await resolveGlobalBgm(globalBgm, cloudContext), true)
    assert.equal(globalBgm.path, 'audio/bgm/cloud/bgm00003.mp3')

    const result = await resolveStoryCloudAssets(story, cloudContext)
    assert.equal(result.models, 1)
    assert.equal(result.images, 1)
    assert.equal(result.bgm, 1)
    assert.equal(result.se, 2)
    assert.deepEqual(result.missing, [])

    assert.equal(story.models[0].model, catalog.models[0].path)
    assert.ok(
      fs.existsSync(path.join(resourcesDir, 'models', ...catalog.models[0].path.split('/'))),
      'model3.json materialized'
    )
    assert.ok(
      fs.existsSync(
        path.join(
          resourcesDir,
          'models',
          'cloud',
          '01ichika_normal',
          '01ichika_normal',
          'motions',
          'w-normal-nod01.motion3.json'
        )
      ),
      'converted motion materialized'
    )
    assert.equal(story.images[0].image, 'cloud/bg_a000301.webp')
    assert.ok(fs.existsSync(path.join(resourcesDir, 'images', 'cloud', 'bg_a000301.webp')))
    assert.equal(story.snippets[0].data.file, 'cloud/bgm00003.mp3')
    assert.ok(fs.existsSync(path.join(resourcesDir, 'audio', 'bgm', 'cloud', 'bgm00003.mp3')))
    assert.equal(story.snippets[1].data.file, 'cloud/se_door.mp3')
    assert.equal(story.snippets[2].data.file, 'cloud/se_door.mp3')
    assert.ok(fs.existsSync(path.join(resourcesDir, 'audio', 'se', 'cloud', 'se_door.mp3')))
  } finally {
    server.close()
    await once(server, 'close')
  }
})

test('ensureModel repairs cached v2 model3.json missing base motionBundle and merges all motions', async () => {
  const makeMotion = (name) => ({
    format: 'sse-motion',
    version: 1,
    name,
    sampleRate: 60,
    startTime: 0,
    stopTime: 1,
    loopTime: false,
    fade: { in: 0.25, out: 0.3 },
    curves: [
      {
        binding: { resolved: { target: 'Parameter', id: 'ParamAngleX' } },
        kind: 'constant',
        value: 0.2
      }
    ]
  })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const send = (value, type = 'application/json') => {
      res.writeHead(200, { 'content-type': type })
      res.end(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    }
    if (url.pathname === '/library/live2d/model/v2_20mizuki_school01/_ripper.json') {
      send({ files: [{ path: '20mizuki_uniform2_4_t11.model3.json' }] })
      return
    }
    if (
      url.pathname ===
      '/library/live2d/model/v2_20mizuki_school01/20mizuki_uniform2_4_t11.model3.json'
    ) {
      send({ FileReferences: { Moc: '20mizuki_uniform2_4_t11.moc3', Textures: [] } })
      return
    }
    if (url.pathname === '/library/live2d/motion/v2_20mizuki_motion_base/_ripper.json') {
      send({ files: [{ path: 'motion/w-normal07-sad.sse-motion.json' }] })
      return
    }
    if (
      url.pathname ===
      '/library/live2d/motion/v2_20mizuki_motion_base/motion/w-normal07-sad.sse-motion.json'
    ) {
      send(makeMotion('w-normal07-sad'))
      return
    }
    if (url.pathname === '/library/live2d/motion/20mizuki_motion_base/_ripper.json') {
      send({ files: [{ path: 'motion/w-normal-sad01.sse-motion.json' }] })
      return
    }
    if (
      url.pathname ===
      '/library/live2d/motion/20mizuki_motion_base/motion/w-normal-sad01.sse-motion.json'
    ) {
      send(makeMotion('w-normal-sad01'))
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-cloud-repair-'))
  try {
    const modelDir = path.join(
      resourcesDir,
      'models',
      'cloud',
      'v2_20mizuki_school01',
      '20mizuki_uniform2_4_t11'
    )
    fs.mkdirSync(path.join(modelDir, 'motions'), { recursive: true })
    fs.writeFileSync(path.join(modelDir, '20mizuki_uniform2_4_t11.moc3'), 'moc')
    fs.writeFileSync(
      path.join(modelDir, 'motions', 'w-normal07-sad.motion3.json'),
      JSON.stringify({
        Version: 3,
        Curves: [{ Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0] }]
      })
    )
    // Simulate an incomplete cached model3.json (only v2_20mizuki_motion_base, missing w-normal-sad01)
    const modelJsonPath = path.join(modelDir, '20mizuki_uniform2_4_t11.model3.json')
    fs.writeFileSync(
      modelJsonPath,
      JSON.stringify({
        Version: 3,
        FileReferences: {
          Moc: '20mizuki_uniform2_4_t11.moc3',
          Textures: [],
          Motions: {
            'w-normal07-sad': [
              { File: 'motions/w-normal07-sad.motion3.json', FadeInTime: 0.25, FadeOutTime: 0.3 }
            ]
          }
        }
      })
    )

    const settings = {
      source: 'moesekai',
      region: 'jp',
      indexBase: `${base}/models/`,
      libraryBase: `${base}/library/`,
      assetBase: base,
      soundtrackBase: `${base}/master/`,
      cacheDir: path.join(resourcesDir, 'cache'),
      concurrency: 1,
      timeoutMs: 5_000,
      retries: 0,
      cloudCatalog: true,
      cloudCatalogTtlHours: 6
    }
    const catalog = {
      format: 'msst.cloud-catalog/1',
      generatedAt: new Date().toISOString(),
      region: 'jp',
      sources: { indexUrl: `${base}/models/jp/models.json`, libraryRoot: `${base}/library/` },
      models: [
        {
          id: 'v2_20mizuki_school01',
          characterId: 20,
          name: '晓山瑞希',
          shortName: '瑞希',
          bundle: 'live2d/model/v2_20mizuki_school01',
          motionBundles: [
            'live2d/motion/v2_20mizuki_motion_base',
            'live2d/motion/20mizuki_motion_base'
          ],
          path: 'cloud/v2_20mizuki_school01/20mizuki_uniform2_4_t11/20mizuki_uniform2_4_t11.model3.json',
          motions: ['w-normal-sad01', 'w-normal07-sad'],
          facials: [],
          defaultMotion: 'w-normal07-sad',
          defaultFacial: ''
        }
      ],
      backgrounds: [],
      bgm: []
    }
    const story = {
      models: [{ id: 1, model: catalog.models[0].path }],
      images: [],
      snippets: []
    }
    const logger = { info: () => undefined, warn: () => undefined, error: () => undefined }
    const ctx = { settings, resourcesDir, catalog, logger }

    const first = await resolveStoryCloudAssets(story, ctx)
    assert.equal(first.models, 1, 'incomplete cached cloud model must be repaired')
    const repaired = JSON.parse(fs.readFileSync(modelJsonPath, 'utf-8'))
    assert.ok(repaired.FileReferences.Motions['w-normal07-sad'])
    assert.ok(
      repaired.FileReferences.Motions['w-normal-sad01'],
      'missing motion from base bundle must be merged into model3.json'
    )
    assert.ok(fs.existsSync(path.join(modelDir, 'motions', 'w-normal-sad01.motion3.json')))

    // Second run with complete model must be a fast no-op
    const second = await resolveStoryCloudAssets(story, ctx)
    assert.equal(second.models, 0, 'complete cached cloud model must not re-download')
  } finally {
    server.close()
    await once(server, 'close')
    fs.rmSync(resourcesDir, { recursive: true, force: true })
  }
})

test('fetchBuffer retries mid-body socket termination, stalled streams, and truncated bodies', async () => {
  const payload = Buffer.alloc(64 * 1024, 0x41)
  let dropAttempts = 0
  let stallAttempts = 0
  let truncAttempts = 0

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/drop-mid-body') {
      dropAttempts++
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(payload.length)
      })
      if (dropAttempts === 1) {
        res.write(payload.subarray(0, 4096))
        setTimeout(() => res.socket?.destroy(), 15)
        return
      }
      res.end(payload)
      return
    }
    if (url.pathname === '/stall-body') {
      stallAttempts++
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      if (stallAttempts === 1) {
        res.flushHeaders()
        // Intentionally never write body or end — stall timeout must abort & retry
        return
      }
      res.end(payload)
      return
    }
    if (url.pathname === '/truncated-body') {
      truncAttempts++
      if (truncAttempts === 1) {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(payload.length)
        })
        res.end(payload.subarray(0, 1024))
        return
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(payload.length)
      })
      res.end(payload)
      return
    }
    res.writeHead(404)
    res.end('not found')
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`

  try {
    const dropped = await fetchBuffer(`${base}/drop-mid-body`, {
      timeoutMs: 3_000,
      stallTimeoutMs: 500,
      retries: 2,
      retryDelayMs: 10
    })
    assert.equal(dropAttempts, 2, 'must retry after mid-body socket reset')
    assert.equal(dropped.length, payload.length)

    const stalled = await fetchBuffer(`${base}/stall-body`, {
      timeoutMs: 3_000,
      stallTimeoutMs: 120,
      retries: 2,
      retryDelayMs: 10
    })
    assert.equal(stallAttempts, 2, 'must abort stalled body read and retry')
    assert.equal(stalled.length, payload.length)

    const truncated = await fetchBuffer(`${base}/truncated-body`, {
      timeoutMs: 3_000,
      stallTimeoutMs: 500,
      retries: 2,
      retryDelayMs: 10
    })
    assert.equal(truncAttempts, 2, 'must detect truncated Content-Length body and retry')
    assert.equal(truncated.length, payload.length)
  } finally {
    server.closeAllConnections?.()
    server.close()
    await once(server, 'close')
  }
})

test('canonicalFallbackUrls builds mirror failover and unversioned fallback for pjsk.moe assets', () => {
  resetCanonicalSitePreference()
  const primary =
    'https://storage.pjsk.moe/cn@6.4.0-24-d031cd79a729/live2d/model/v2_19ena_culture/live2d/model/v2/main/19_ena/v2_19ena_culture/buildmodeldata/texture/0.png'
  const urls = canonicalFallbackUrls(primary)
  assert.equal(urls[0], primary)
  assert.equal(
    urls[1],
    'https://storage.exmeaning.com/cn@6.4.0-24-d031cd79a729/live2d/model/v2_19ena_culture/live2d/model/v2/main/19_ena/v2_19ena_culture/buildmodeldata/texture/0.png'
  )
  assert.equal(
    urls[2],
    'https://storage.exmeaning.com/cn/live2d/model/v2_19ena_culture/live2d/model/v2/main/19_ena/v2_19ena_culture/buildmodeldata/texture/0.png'
  )
  assert.deepEqual(canonicalFallbackUrls('http://127.0.0.1:9999/library/file.png'), [
    'http://127.0.0.1:9999/library/file.png'
  ])
})

test('v2_19ena_culture recovers from mid-body texture disconnect, repairs 0-byte corrupt cache, and falls back to same-character model when unrecoverable', async () => {
  const textureBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    Buffer.alloc(16 * 1024, 0x7f)
  ])
  const mocBytes = Buffer.from('MOC3_VALID_BINARY_PAYLOAD')
  const physicsBytes = Buffer.from(JSON.stringify({ Version: 3, Meta: {} }))
  let mode = 'drop-once'
  let textureAttempts = 0

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const send = (value, type = 'application/json') => {
      const buf = Buffer.isBuffer(value)
        ? value
        : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
      res.writeHead(200, { 'content-type': type, 'content-length': String(buf.length) })
      res.end(buf)
    }

    if (url.pathname === '/library/live2d/model/v2_19ena_culture/_ripper.json') {
      if (mode === 'always-fail') {
        res.writeHead(500)
        res.end('upstream error')
        return
      }
      send({
        files: [
          { path: 'v2_19ena_culture_t04.model3.json' },
          { path: 'v2_19ena_culture_t04.moc3' },
          { path: 'v2_19ena_culture_t04.physics3.json' },
          { path: 'v2_19ena_culture_t04.2048/texture_00.png' }
        ]
      })
      return
    }
    if (
      url.pathname === '/library/live2d/model/v2_19ena_culture/v2_19ena_culture_t04.model3.json'
    ) {
      send({
        Version: 3,
        FileReferences: {
          Moc: 'v2_19ena_culture_t04.moc3',
          Physics: 'v2_19ena_culture_t04.physics3.json',
          Textures: ['v2_19ena_culture_t04.2048/texture_00.png']
        }
      })
      return
    }
    if (url.pathname === '/library/live2d/model/v2_19ena_culture/v2_19ena_culture_t04.moc3') {
      send(mocBytes, 'application/octet-stream')
      return
    }
    if (
      url.pathname === '/library/live2d/model/v2_19ena_culture/v2_19ena_culture_t04.physics3.json'
    ) {
      send(physicsBytes)
      return
    }
    if (
      url.pathname ===
      '/library/live2d/model/v2_19ena_culture/v2_19ena_culture_t04.2048/texture_00.png'
    ) {
      textureAttempts++
      if (mode === 'drop-once' && textureAttempts === 1) {
        // Reproduce live production failure: headers sent, partial body, then socket destroyed (TypeError: terminated)
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': String(textureBytes.length)
        })
        res.write(textureBytes.subarray(0, 1024))
        setTimeout(() => res.socket?.destroy(), 15)
        return
      }
      send(textureBytes, 'image/png')
      return
    }
    if (url.pathname === '/library/live2d/motion/v2_19ena_motion_base/_ripper.json') {
      send({ files: [{ path: 'motion/w-normal-nod01.sse-motion.json' }] })
      return
    }
    if (
      url.pathname ===
      '/library/live2d/motion/v2_19ena_motion_base/motion/w-normal-nod01.sse-motion.json'
    ) {
      send(SSE_MOTION)
      return
    }
    res.writeHead(404)
    res.end('not found')
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-ena-culture-'))

  const settings = {
    source: 'moesekai',
    region: 'cn',
    indexBase: `${base}/models/`,
    libraryBase: `${base}/library/`,
    assetBase: base,
    soundtrackBase: `${base}/master/`,
    cacheDir: path.join(resourcesDir, 'cache'),
    concurrency: 2,
    timeoutMs: 5_000,
    retries: 2,
    cloudCatalog: true,
    cloudOnly: true,
    cloudCatalogTtlHours: 6
  }

  const catalog = {
    format: 'msst.cloud-catalog/1',
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    region: 'cn',
    sources: {
      indexUrl: `${base}/models/cn/models.json`,
      libraryRoot: `${base}/library/`,
      assetBase: base,
      soundtrack: ''
    },
    models: [
      {
        id: 'v2_19ena_culture',
        characterId: 19,
        name: '东云绘名',
        shortName: '绘名',
        isDefault: false,
        bundle: 'live2d/model/v2_19ena_culture',
        motionBundles: ['live2d/motion/v2_19ena_motion_base'],
        path: 'cloud/v2_19ena_culture/v2_19ena_culture_t04/v2_19ena_culture_t04.model3.json',
        motions: ['w-normal-nod01'],
        facials: [],
        defaultMotion: 'w-normal-nod01',
        defaultFacial: ''
      },
      {
        id: 'v2_19ena_school01',
        characterId: 19,
        name: '东云绘名',
        shortName: '绘名',
        isDefault: false,
        bundle: 'live2d/model/v2_19ena_school01',
        motionBundles: ['live2d/motion/v2_19ena_motion_base'],
        path: 'cloud/v2_19ena_school01/v2_19ena_school_t07/v2_19ena_school_t07.model3.json',
        motions: ['w-normal-nod01'],
        facials: [],
        defaultMotion: 'w-normal-nod01',
        defaultFacial: ''
      }
    ],
    backgrounds: [],
    bgm: []
  }

  const logger = { info: () => undefined, warn: () => undefined, error: () => undefined }
  const ctx = { settings, resourcesDir, catalog, logger, cloudOnly: true }

  try {
    // Case 1: Partial cache on disk (moc3 + physics3.json, missing texture & model3.json)
    // plus mid-body socket termination on first texture attempt -> retries and succeeds cleanly.
    const cultureDir = path.join(
      resourcesDir,
      'models',
      'cloud',
      'v2_19ena_culture',
      'v2_19ena_culture_t04'
    )
    fs.mkdirSync(cultureDir, { recursive: true })
    fs.writeFileSync(path.join(cultureDir, 'v2_19ena_culture_t04.moc3'), mocBytes)
    fs.writeFileSync(path.join(cultureDir, 'v2_19ena_culture_t04.physics3.json'), physicsBytes)

    const story1 = {
      models: [
        {
          id: 2285,
          model: 'cloud/v2_19ena_culture/v2_19ena_culture_t04/v2_19ena_culture_t04.model3.json'
        }
      ],
      images: [],
      snippets: []
    }
    const res1 = await resolveStoryCloudAssets(story1, ctx)
    assert.equal(res1.models, 1)
    assert.deepEqual(res1.missing, [])
    assert.equal(textureAttempts, 2, 'texture download must recover after first mid-body drop')
    assert.ok(fs.existsSync(path.join(cultureDir, 'v2_19ena_culture_t04.model3.json')))
    assert.equal(
      fs.statSync(path.join(cultureDir, 'v2_19ena_culture_t04.2048', 'texture_00.png')).size,
      textureBytes.length
    )

    // Case 2: Corrupt 0-byte cached texture must be detected and repaired instead of passing broken cache
    mode = 'ok'
    fs.writeFileSync(
      path.join(cultureDir, 'v2_19ena_culture_t04.2048', 'texture_00.png'),
      Buffer.alloc(0)
    )
    const res2 = await resolveStoryCloudAssets(story1, ctx)
    assert.equal(res2.models, 1)
    assert.deepEqual(res2.missing, [])
    assert.equal(
      fs.statSync(path.join(cultureDir, 'v2_19ena_culture_t04.2048', 'texture_00.png')).size,
      textureBytes.length
    )

    // Case 3: Unrecoverable failure on v2_19ena_culture falls back to cached same-character model v2_19ena_school01
    fs.rmSync(cultureDir, { recursive: true, force: true })
    const schoolDir = path.join(
      resourcesDir,
      'models',
      'cloud',
      'v2_19ena_school01',
      'v2_19ena_school_t07'
    )
    fs.mkdirSync(path.join(schoolDir, 'motions'), { recursive: true })
    fs.mkdirSync(path.join(schoolDir, 'v2_19ena_school_t07.2048'), { recursive: true })
    fs.writeFileSync(path.join(schoolDir, 'v2_19ena_school_t07.moc3'), mocBytes)
    fs.writeFileSync(
      path.join(schoolDir, 'v2_19ena_school_t07.2048', 'texture_00.png'),
      textureBytes
    )
    fs.writeFileSync(
      path.join(schoolDir, 'motions', 'w-normal-nod01.motion3.json'),
      JSON.stringify({ Version: 3, Curves: [] })
    )
    fs.writeFileSync(
      path.join(schoolDir, '.motion-bundles.json'),
      JSON.stringify({ version: 1, bundles: ['live2d/motion/v2_19ena_motion_base'] })
    )
    fs.writeFileSync(
      path.join(schoolDir, 'v2_19ena_school_t07.model3.json'),
      JSON.stringify({
        Version: 3,
        FileReferences: {
          Moc: 'v2_19ena_school_t07.moc3',
          Textures: ['v2_19ena_school_t07.2048/texture_00.png'],
          Motions: {
            'w-normal-nod01': [
              { File: 'motions/w-normal-nod01.motion3.json', FadeInTime: 0.25, FadeOutTime: 0.3 }
            ]
          }
        }
      })
    )

    mode = 'always-fail'
    const story3 = {
      models: [
        {
          id: 2285,
          model: 'cloud/v2_19ena_culture/v2_19ena_culture_t04/v2_19ena_culture_t04.model3.json'
        },
        {
          id: 9999,
          model: 'cloud/nonexistent_unknown_model/x/x.model3.json'
        }
      ],
      images: [],
      snippets: []
    }
    const res3 = await resolveStoryCloudAssets(story3, {
      ...ctx,
      settings: { ...settings, retries: 0 }
    })
    assert.equal(
      story3.models[0].model,
      'cloud/v2_19ena_school01/v2_19ena_school_t07/v2_19ena_school_t07.model3.json',
      'failed cloud costume must fall back to cached same-character model'
    )
    assert.deepEqual(
      res3.missing,
      ['model:cloud/nonexistent_unknown_model/x/x.model3.json'],
      'genuinely unknown model must still report missing'
    )
  } finally {
    server.closeAllConnections?.()
    server.close()
    await once(server, 'close')
    fs.rmSync(resourcesDir, { recursive: true, force: true })
  }
})
