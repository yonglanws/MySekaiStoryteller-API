/**
 * 严格纯云端模式（assets.cloudOnly=true）隔离测试：
 * 1. loadHostConfig() 在 cloudOnly=true 时忽略本地 bgm.yaml 与 bg1.mp3，自动兜底 bgm00003 并开启 cloudCatalog
 * 2. ResourceCatalog 在存在完整旧本地资源（models.yaml / images / bgm / se / voices）时，
 *    cloudOnly=true 完全不读取本地条目，全量仅来自 cloud/，不让 models.yaml 遮蔽云端默认模型
 * 3. resolveGlobalBgm() 与 resolveStoryCloudAssets() 在 cloudOnly=true 时，
 *    不命中任何非 cloud/ 的旧本地文件，而是把旧本地路径（如 21mizuki_normal/...、bg_a000301.webp、bg1.mp3、se00053_b.mp3）
 *    归一化并物化到 resources 下的 cloud/ 子目录
 */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { Logger } from 'tslog'
import { loadHostConfig, normalizeCloudOnlyBgmPath } from '../../out-host/host/config.js'
import { ResourceCatalog, resolveRegisteredSeFile } from '../../out-host/host/resources/resourceCatalog.js'
import { createStaticRouter } from '../../out-host/host/static/staticRoutes.js'
import { createOptionalAudioPathResolver } from '../../out-host/host/bridge/bridgeRoutes.js'
import {
  findCloudModel,
  resolveGlobalBgm,
  resolveStoryCloudAssets
} from '../../out-host/host/assets/cloudAssets.js'

const logger = new Logger({ type: 'hidden' })

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

async function startMockCloudServer() {
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
            { type: 'bundle', name: 'se', path: 'sound/scenario/se/se', fileCount: 1, totalSize: 5 }
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
              url: '/files/cloud_bg_a000301.webp',
              size: 9
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
              url: '/files/cloud_bgm00003.mp3',
              size: 9
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
              name: 'se00053_b.mp3',
              path: 'sound/scenario/se/se/se00053_b.mp3',
              url: '/files/cloud_se00053_b.mp3',
              size: 9
            }
          ]
        })
        return
      }
      send({ items: [] })
      return
    }

    for (const modelId of ['20mizuki_normal', '20mizuki_school', '09kohane_normal']) {
      if (url.pathname === `/library/live2d/model/${modelId}/_ripper.json`) {
        send({ files: [{ path: `${modelId}.model3.json` }] })
        return
      }
      if (url.pathname === `/library/live2d/model/${modelId}/${modelId}.model3.json`) {
        send({ FileReferences: { Moc: `${modelId}.moc3`, Textures: [] } })
        return
      }
    }

    for (const motionSet of ['20mizuki_motion_base', '09kohane_motion_base']) {
      if (url.pathname === `/library/live2d/motion/${motionSet}/_ripper.json`) {
        send({ files: [{ path: 'motion/w-normal-nod01.sse-motion.json' }] })
        return
      }
      if (url.pathname === `/library/live2d/motion/${motionSet}/motion/w-normal-nod01.sse-motion.json`) {
        send(SSE_MOTION)
        return
      }
    }

    if (url.pathname.startsWith('/files/cloud_')) {
      send(Buffer.from('CLOUDDATA'), 'application/octet-stream')
      return
    }

    res.writeHead(404)
    res.end('not found')
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` }
}

function seedLegacyLocalResources(resourcesDir) {
  fs.mkdirSync(path.join(resourcesDir, 'models', '20mizuki_normal', '20mizuki_normal_3.0_t04'), {
    recursive: true
  })
  fs.mkdirSync(path.join(resourcesDir, 'models', '21mizuki_normal'), { recursive: true })
  fs.mkdirSync(path.join(resourcesDir, 'models', '20mizuki_school'), { recursive: true })
  fs.mkdirSync(path.join(resourcesDir, 'models', '09kohane', '09kohane_normal'), { recursive: true })
  fs.writeFileSync(
    path.join(resourcesDir, 'models', 'models.yaml'),
    [
      'models:',
      '  - id: 1',
      "    name: '晓山瑞希'",
      "    shortName: '瑞希'",
      "    path: '20mizuki_normal/20mizuki_normal_3.0_t04/20mizuki_normal.model3.json'",
      '  - id: 99',
      "    name: '本地专属模型'",
      "    shortName: '本地'",
      "    path: 'local_only/local.model3.json'",
      ''
    ].join('\n'),
    'utf8'
  )
  fs.writeFileSync(
    path.join(
      resourcesDir,
      'models',
      '20mizuki_normal',
      '20mizuki_normal_3.0_t04',
      '20mizuki_normal.model3.json'
    ),
    JSON.stringify({ Version: 3, FileReferences: { Motions: {} } })
  )
  fs.writeFileSync(
    path.join(resourcesDir, 'models', '21mizuki_normal', '21mizuki_normal.model3.json'),
    JSON.stringify({ Version: 3, FileReferences: { Motions: {} } })
  )
  fs.writeFileSync(
    path.join(resourcesDir, 'models', '20mizuki_school', '20mizuki_school.model3.json'),
    JSON.stringify({ Version: 3, FileReferences: { Motions: {} } })
  )
  fs.writeFileSync(
    path.join(resourcesDir, 'models', '09kohane', '09kohane_normal', '09kohane_normal.model3.json'),
    JSON.stringify({ Version: 3, FileReferences: { Motions: {} } })
  )

  fs.mkdirSync(path.join(resourcesDir, 'images'), { recursive: true })
  fs.writeFileSync(path.join(resourcesDir, 'images', 'bg_a000301.webp'), 'LEGACY_BG')
  fs.writeFileSync(path.join(resourcesDir, 'images', 'bg_legacy_only.png'), 'LEGACY_ONLY')
  fs.writeFileSync(
    path.join(resourcesDir, 'images', 'images.yaml'),
    [
      'images:',
      '  - file: bg_legacy_only.png',
      '    name: 本地旧背景',
      '    description: 旧本地背景',
      ''
    ].join('\n'),
    'utf8'
  )

  fs.mkdirSync(path.join(resourcesDir, 'audio', 'bgm'), { recursive: true })
  fs.writeFileSync(path.join(resourcesDir, 'audio', 'bgm', 'bg1.mp3'), 'LEGACY_BG1')
  fs.writeFileSync(path.join(resourcesDir, 'audio', 'bgm', 'bgm00003.mp3'), 'LEGACY_BGM3')
  fs.writeFileSync(
    path.join(resourcesDir, 'audio', 'bgm', 'bgm.yaml'),
    [
      'enabled: true',
      'path: audio/bgm/bg1.mp3',
      'volume: 0.2',
      'bgm:',
      '  - file: bg1.mp3',
      '    name: 本地旧默认曲',
      '    description: 旧本地曲目',
      ''
    ].join('\n'),
    'utf8'
  )

  fs.mkdirSync(path.join(resourcesDir, 'audio', 'se'), { recursive: true })
  fs.writeFileSync(path.join(resourcesDir, 'audio', 'se', 'se00053_b.mp3'), 'LEGACY_SE')
  fs.writeFileSync(path.join(resourcesDir, 'audio', 'se', 'se_legacy_only.mp3'), 'LEGACY_ONLY_SE')

  fs.mkdirSync(path.join(resourcesDir, 'voices'), { recursive: true })
  fs.writeFileSync(path.join(resourcesDir, 'voices', 'legacy_voice.wav'), 'LEGACY_VOICE')
}

test('loadHostConfig honors MSS_ASSETS_CLOUD_ONLY and ignores legacy bgm.yaml / bg1.mp3', (t) => {
  const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-cfg-cloud-only-'))
  const prevResourceDir = process.env.MSS_RESOURCE_DIR
  const prevCloudOnly = process.env.MSS_ASSETS_CLOUD_ONLY
  const prevCloudCatalog = process.env.MSS_ASSETS_CLOUD_CATALOG
  const repoConfigPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'config.yaml'
  )
  const origExistsSync = fs.existsSync
  t.mock.method(fs, 'existsSync', (target) => {
    if (path.resolve(String(target)) === repoConfigPath) return false
    return origExistsSync.call(fs, target)
  })

  try {
    seedLegacyLocalResources(resourcesDir)
    process.env.MSS_RESOURCE_DIR = resourcesDir
    process.env.MSS_ASSETS_CLOUD_ONLY = 'true'
    process.env.MSS_ASSETS_CLOUD_CATALOG = 'false'

    const cfg = loadHostConfig()
    assert.equal(cfg.assets.cloudOnly, true)
    assert.equal(cfg.assets.cloudCatalog, true, 'cloudOnly implies cloudCatalog=true')
    assert.equal(cfg.bgm.path, 'bgm00003', 'cloudOnly ignores local bgm.yaml and bg1.mp3')
  } finally {
    if (prevResourceDir === undefined) delete process.env.MSS_RESOURCE_DIR
    else process.env.MSS_RESOURCE_DIR = prevResourceDir
    if (prevCloudOnly === undefined) delete process.env.MSS_ASSETS_CLOUD_ONLY
    else process.env.MSS_ASSETS_CLOUD_ONLY = prevCloudOnly
    if (prevCloudCatalog === undefined) delete process.env.MSS_ASSETS_CLOUD_CATALOG
    else process.env.MSS_ASSETS_CLOUD_CATALOG = prevCloudCatalog
    fs.rmSync(resourcesDir, { recursive: true, force: true })
  }
})

test('ResourceCatalog with cloudOnly=true ignores all legacy local manifests and files', (t) => {
  const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-rc-cloud-only-'))
  t.after(() => fs.rmSync(resourcesDir, { recursive: true, force: true }))
  seedLegacyLocalResources(resourcesDir)

  const cloudSnapshot = {
    format: 'msst.cloud-catalog/1',
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    region: 'cn',
    sources: { indexUrl: '', libraryRoot: '', assetBase: '', soundtrack: '' },
    models: [
      {
        id: '20mizuki_normal',
        characterId: 20,
        name: '晓山瑞希',
        shortName: '瑞希',
        isDefault: true,
        bundle: 'live2d/model/20mizuki_normal',
        motionBundles: ['live2d/motion/20mizuki_motion_base'],
        path: 'cloud/20mizuki_normal/20mizuki_normal/20mizuki_normal.model3.json',
        motions: ['w-normal-nod01'],
        facials: ['face_smile_01'],
        defaultMotion: 'w-normal-nod01',
        defaultFacial: 'face_smile_01'
      }
    ],
    backgrounds: [
      {
        id: 'bg_a000301',
        file: 'cloud/bg_a000301',
        name: '神山高校 三年一班',
        aliases: [],
        description: '校园'
      }
    ],
    bgm: [
      {
        id: 'bgm00003',
        file: 'cloud/bgm00003.mp3',
        name: 'Slapstick!!',
        description: '剧情 BGM'
      }
    ],
    se: [
      {
        id: 'se00053_b',
        file: 'cloud/se00053_b.mp3',
        name: 'se00053_b',
        bundle: 'sound/scenario/se/se',
        category: 'reaction',
        description: '震惊音效',
        tags: ['shock']
      }
    ]
  }

  const rc = new ResourceCatalog(
    logger,
    { paths: { resources: resourcesDir }, assets: { cloudOnly: true } },
    () => cloudSnapshot
  )
  const data = rc.get()

  assert.equal(data.models.length, 1)
  assert.equal(data.models[0].source, 'cloud')
  assert.equal(data.models[0].cloudId, '20mizuki_normal')
  assert.ok(data.models[0].path.startsWith('cloud/'))
  assert.ok(!data.models.some((m) => m.name === '本地专属模型'))

  assert.deepEqual(data.images, ['cloud/bg_a000301'])
  assert.equal(data.imageDetails.length, 1)
  assert.equal(data.imageDetails[0].source, 'cloud')
  assert.ok(!data.imageDetails.some((img) => img.file === 'bg_legacy_only.png'))

  assert.deepEqual(data.bgm, ['cloud/bgm00003.mp3'])
  assert.equal(data.bgmDetails.length, 1)
  assert.equal(data.bgmDetails[0].source, 'cloud')
  assert.ok(!data.bgmDetails.some((b) => b.file === 'bg1.mp3'))

  assert.equal(data.seDetails?.length, 1)
  assert.equal(data.seDetails?.[0].file, 'cloud/se00053_b.mp3')
  assert.ok(!data.seDetails?.some((s) => s.file === 'se_legacy_only.mp3'))

  assert.deepEqual(data.voices, [])

  // Even if cloud is temporarily unavailable, cloudOnly=true never leaks legacy local assets
  const emptyCloudRc = new ResourceCatalog(
    logger,
    { paths: { resources: resourcesDir }, assets: { cloudOnly: true } },
    () => null
  )
  const emptyData = emptyCloudRc.get()
  assert.deepEqual(emptyData.models, [])
  assert.deepEqual(emptyData.images, [])
  assert.deepEqual(emptyData.imageDetails, [])
  assert.deepEqual(emptyData.bgm, [])
  assert.deepEqual(emptyData.bgmDetails, [])
  assert.equal(emptyData.seDetails, undefined)
  assert.deepEqual(emptyData.voices, [])
})

test('resolveGlobalBgm & resolveStoryCloudAssets with cloudOnly=true ignore legacy files and materialize to cloud/', async () => {
  const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-assets-cloud-only-'))
  const { server, baseUrl } = await startMockCloudServer()
  seedLegacyLocalResources(resourcesDir)

  const settings = {
    source: 'moesekai',
    region: 'cn',
    indexBase: `${baseUrl}/models/`,
    libraryBase: `${baseUrl}/library/`,
    assetBase: baseUrl,
    soundtrackBase: `${baseUrl}/master/`,
    cacheDir: path.join(resourcesDir, '.cache'),
    concurrency: 2,
    timeoutMs: 5_000,
    retries: 0,
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
      indexUrl: `${baseUrl}/models/cn/models.json`,
      libraryRoot: `${baseUrl}/library/`,
      assetBase: baseUrl,
      soundtrack: ''
    },
    models: [
      {
        id: '20mizuki_normal',
        characterId: 20,
        name: '晓山瑞希',
        shortName: '瑞希',
        isDefault: true,
        bundle: 'live2d/model/20mizuki_normal',
        motionBundles: ['live2d/motion/20mizuki_motion_base'],
        path: 'cloud/20mizuki_normal/20mizuki_normal/20mizuki_normal.model3.json',
        motions: ['w-normal-nod01'],
        facials: [],
        defaultMotion: 'w-normal-nod01',
        defaultFacial: ''
      },
      {
        id: '20mizuki_school',
        characterId: 20,
        name: '晓山瑞希',
        shortName: '瑞希',
        isDefault: false,
        bundle: 'live2d/model/20mizuki_school',
        motionBundles: ['live2d/motion/20mizuki_motion_base'],
        path: 'cloud/20mizuki_school/20mizuki_school/20mizuki_school.model3.json',
        motions: ['w-normal-nod01'],
        facials: [],
        defaultMotion: 'w-normal-nod01',
        defaultFacial: ''
      },
      {
        id: '09kohane_normal',
        characterId: 9,
        name: '小豆泽心羽',
        shortName: '心羽',
        isDefault: true,
        bundle: 'live2d/model/09kohane_normal',
        motionBundles: ['live2d/motion/09kohane_motion_base'],
        path: 'cloud/09kohane_normal/09kohane_normal/09kohane_normal.model3.json',
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
        name: '神山高校 三年一班',
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
    ],
    se: [
      {
        id: 'se00053_b',
        file: 'cloud/se00053_b.mp3',
        name: 'se00053_b',
        bundle: 'sound/scenario/se/se',
        category: 'reaction',
        description: '',
        tags: []
      }
    ]
  }

  try {
    assert.equal(findCloudModel(catalog, '21mizuki_normal/21mizuki_normal.model3.json')?.id, '20mizuki_normal')
    assert.equal(findCloudModel(catalog, '09kohane/09kohane_normal/09kohane_normal.model3.json')?.id, '09kohane_normal')

    const ctx = { settings, resourcesDir, catalog, logger, cloudOnly: true }
    const globalBgm = { enabled: true, path: 'audio/bgm/bg1.mp3' }
    assert.equal(await resolveGlobalBgm(globalBgm, ctx), true)
    assert.equal(globalBgm.path, 'audio/bgm/cloud/bgm00003.mp3')
    assert.equal(
      fs.readFileSync(path.join(resourcesDir, 'audio', 'bgm', 'cloud', 'bgm00003.mp3'), 'utf8'),
      'CLOUDDATA'
    )

    const story = {
      models: [
        { id: 1, model: '21mizuki_normal/21mizuki_normal.model3.json', costumes: {} },
        { id: 2, model: '09kohane/09kohane_normal/09kohane_normal.model3.json' }
      ],
      images: [{ id: 1, image: 'bg_a000301.webp' }],
      snippets: [
        {
          type: 'ChangeBgm',
          wait: false,
          delay: 0,
          data: { file: 'bg1.mp3', stop: false, fadeMs: 500, volume: 1 }
        },
        {
          type: 'PlaySe',
          wait: false,
          delay: 0,
          data: { file: 'audio/se/se00053_b.mp3', volume: 1, loop: false, fadeMs: 0 }
        },
        {
          type: 'CostumeChange',
          wait: true,
          delay: 0,
          data: { modelId: 1, costume: '20mizuki_school/20mizuki_school.model3.json' }
        }
      ]
    }

    const res = await resolveStoryCloudAssets(story, ctx)
    assert.equal(res.models, 3)
    assert.equal(res.images, 1)
    assert.equal(res.bgm, 1)
    assert.equal(res.se, 1)
    assert.deepEqual(res.missing, [])

    assert.equal(story.models[0].model, 'cloud/20mizuki_normal/20mizuki_normal/20mizuki_normal.model3.json')
    assert.equal(story.models[1].model, 'cloud/09kohane_normal/09kohane_normal/09kohane_normal.model3.json')
    assert.equal(
      story.models[0].costumes['20mizuki_school/20mizuki_school.model3.json'],
      'cloud/20mizuki_school/20mizuki_school/20mizuki_school.model3.json'
    )
    assert.equal(story.images[0].image, 'cloud/bg_a000301.webp')
    assert.equal(
      fs.readFileSync(path.join(resourcesDir, 'images', 'cloud', 'bg_a000301.webp'), 'utf8'),
      'CLOUDDATA'
    )
    assert.equal(story.snippets[0].data.file, 'cloud/bgm00003.mp3')
    assert.equal(story.snippets[1].data.file, 'cloud/se00053_b.mp3')
    assert.equal(
      fs.readFileSync(path.join(resourcesDir, 'audio', 'se', 'cloud', 'se00053_b.mp3'), 'utf8'),
      'CLOUDDATA'
    )

    // Second pass with already-materialized cloud/ paths must reuse cache cleanly
    const second = await resolveStoryCloudAssets(story, ctx)
    assert.equal(second.images, 0)
    assert.equal(second.bgm, 0)
    assert.equal(second.se, 0)
    assert.deepEqual(second.missing, [])
  } finally {
    server.close()
    await once(server, 'close')
    fs.rmSync(resourcesDir, { recursive: true, force: true })
  }
})

test('cloudOnly=true gates /resources static serving, bridge optional audio paths, offline cached global BGM, config BGM normalization, and SE fallback', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-cloud-gates-'))
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }))

  const resourcesDir = path.join(tmpRoot, 'resources')
  const webRendererDir = path.join(tmpRoot, 'webrenderer')
  const outputDir = path.join(tmpRoot, 'output')
  fs.mkdirSync(webRendererDir, { recursive: true })
  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(path.join(webRendererDir, 'index.html'), '<html>ok</html>')

  seedLegacyLocalResources(resourcesDir)
  // Seed allowed cloud/ and inapp/ cached files alongside legacy local files
  fs.mkdirSync(path.join(resourcesDir, 'models', 'cloud', '20mizuki_normal'), { recursive: true })
  fs.writeFileSync(
    path.join(resourcesDir, 'models', 'cloud', '20mizuki_normal', 'model.model3.json'),
    '{}'
  )
  fs.mkdirSync(path.join(resourcesDir, 'images', 'cloud'), { recursive: true })
  fs.writeFileSync(path.join(resourcesDir, 'images', 'cloud', 'bg_a000301.webp'), 'CLOUD_BG')
  fs.mkdirSync(path.join(resourcesDir, 'audio', 'bgm', 'cloud'), { recursive: true })
  fs.writeFileSync(path.join(resourcesDir, 'audio', 'bgm', 'cloud', 'bgm00003.mp3'), 'CLOUD_BGM')
  fs.mkdirSync(path.join(resourcesDir, 'audio', 'se', 'cloud'), { recursive: true })
  fs.writeFileSync(path.join(resourcesDir, 'audio', 'se', 'cloud', 'se00053_b.mp3'), 'CLOUD_SE')
  fs.mkdirSync(path.join(resourcesDir, 'inapp', 'jp-7.0.0'), { recursive: true })
  fs.writeFileSync(path.join(resourcesDir, 'inapp', 'jp-7.0.0', 'ui.png'), 'INAPP_UI')

  // 1. Static router cloudOnly gate
  const app = express()
  app.use(
    createStaticRouter({
      paths: { resources: resourcesDir, webRenderer: webRendererDir, output: outputDir },
      assets: { cloudOnly: true }
    })
  )
  const srv = app.listen(0, '127.0.0.1')
  await once(srv, 'listening')
  t.after(() => srv.close())
  const base = `http://127.0.0.1:${srv.address().port}`

  const blockedPaths = [
    '/resources/models/models.yaml',
    '/resources/models/21mizuki_normal/21mizuki_normal.model3.json',
    '/resources/images/images.yaml',
    '/resources/images/bg_legacy_only.png',
    '/resources/audio/bgm/bgm.yaml',
    '/resources/audio/bgm/bg1.mp3',
    '/resources/audio/se/se00053_b.mp3',
    '/resources/voices/legacy_voice.wav'
  ]
  for (const p of blockedPaths) {
    const res = await fetch(`${base}${p}`)
    assert.ok(res.status === 403 || res.status === 404, `${p} must be blocked, got ${res.status}`)
  }

  const allowedPaths = [
    '/resources/inapp/jp-7.0.0/ui.png',
    '/resources/models/cloud/20mizuki_normal/model.model3.json',
    '/resources/images/cloud/bg_a000301.webp',
    '/resources/audio/bgm/cloud/bgm00003.mp3',
    '/resources/audio/se/cloud/se00053_b.mp3'
  ]
  for (const p of allowedPaths) {
    const res = await fetch(`${base}${p}`)
    assert.equal(res.status, 200, `${p} must be allowed in cloudOnly mode`)
  }

  // 2. Bridge optional audio resolver gate
  const resolveAudio = createOptionalAudioPathResolver({
    paths: { resources: resourcesDir, output: outputDir, webRenderer: webRendererDir },
    bgm: { enabled: true, path: 'audio/bgm/bg1.mp3', volume: 0.35 },
    assets: { cloudOnly: true }
  })
  assert.equal(resolveAudio('audio/bgm/bg1.mp3'), undefined)
  assert.equal(resolveAudio('/resources/audio/bgm/bgm00003.mp3'), undefined)
  assert.equal(resolveAudio('audio/se/se00053_b.mp3'), undefined)
  assert.ok(resolveAudio('audio/bgm/cloud/bgm00003.mp3')?.endsWith('bgm00003.mp3'))
  assert.ok(resolveAudio('audio/se/cloud/se00053_b.mp3')?.endsWith('se00053_b.mp3'))

  // 3. Config bgm.path normalization under cloudOnly
  assert.equal(normalizeCloudOnlyBgmPath('audio/bgm/custom.mp3'), 'bgm00003')
  assert.equal(normalizeCloudOnlyBgmPath('custom.mp3'), 'bgm00003')
  assert.equal(normalizeCloudOnlyBgmPath('C:\\music\\local.mp3'), 'bgm00003')
  assert.equal(normalizeCloudOnlyBgmPath('audio/bgm/bgm00297.mp3'), 'bgm00297')
  assert.equal(normalizeCloudOnlyBgmPath('https://cdn.example.com/a.mp3'), 'https://cdn.example.com/a.mp3')
  assert.equal(normalizeCloudOnlyBgmPath('cloud/bgm00003.mp3'), 'cloud/bgm00003.mp3')
  assert.equal(normalizeCloudOnlyBgmPath('audio/bgm/cloud/bgm00003.mp3'), 'audio/bgm/cloud/bgm00003.mp3')

  // 4. Offline resolveGlobalBgm checks cached audio/bgm/cloud/<stem>.* before !ctx.catalog
  const offlineGlobal = { enabled: true, path: 'bgm00003' }
  const offlineChanged = await resolveGlobalBgm(offlineGlobal, {
    settings: { cloudOnly: true },
    resourcesDir,
    catalog: null,
    logger,
    cloudOnly: true
  })
  assert.equal(offlineChanged, true)
  assert.equal(offlineGlobal.path, 'audio/bgm/cloud/bgm00003.mp3')

  // 5. ResourceCatalog cloudOnly flag & SE fallback prefixing when cloud.se is empty
  const emptySeCloudRc = new ResourceCatalog(
    logger,
    { paths: { resources: resourcesDir }, assets: { cloudOnly: true } },
    () => ({
      format: 'msst.cloud-catalog/1',
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      region: 'cn',
      sources: { indexUrl: '', libraryRoot: '', assetBase: '', soundtrack: '' },
      models: [],
      backgrounds: [],
      bgm: [],
      se: []
    })
  )
  const rcData = emptySeCloudRc.get()
  assert.equal(rcData.cloudOnly, true)
  assert.ok((rcData.seDetails?.length ?? 0) > 0)
  assert.ok(rcData.seDetails.every((s) => s.file.startsWith('cloud/')))

  assert.deepEqual(resolveRegisteredSeFile({ seDetails: [], cloudOnly: true }, 'se00053_b.mp3'), {
    file: 'cloud/se00053_b.mp3',
    remapped: false
  })
  assert.equal(resolveRegisteredSeFile({ seDetails: [], cloudOnly: true }, 'se_legacy_only.mp3'), null)
})
