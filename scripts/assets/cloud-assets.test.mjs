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
      JSON.stringify({ Version: 3, Curves: [{ Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0] }] })
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
            'w-normal07-sad': [{ File: 'motions/w-normal07-sad.motion3.json', FadeInTime: 0.25, FadeOutTime: 0.3 }]
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
