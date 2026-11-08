import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { load as loadYaml } from 'js-yaml'
import { fetchMedia, listMedia } from '../../out-host/host/assets/media.js'

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf-8')
}

async function startAssetServer() {
  const requests = []
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    requests.push(url.pathname + url.search)
    if (url.pathname === '/api/assets/bundles') {
      const prefix = url.searchParams.get('prefix') || ''
      let items = []
      if (prefix === 'scenario/background/') {
        items = [
          {
            type: 'bundle',
            name: 'background',
            path: 'scenario/background/background',
            fileCount: 2,
            totalSize: 10
          },
          {
            type: 'bundle',
            name: 'bg_a000001',
            path: 'scenario/background/bg_a000001',
            fileCount: 2,
            totalSize: 1000
          },
          {
            type: 'bundle',
            name: 'bg_a000002',
            path: 'scenario/background/bg_a000002',
            fileCount: 2,
            totalSize: 2000
          }
        ]
      } else if (prefix === 'sound/scenario/bgm/') {
        items = [
          {
            type: 'bundle',
            name: 'bgm00000',
            path: 'sound/scenario/bgm/bgm00000',
            fileCount: 2,
            totalSize: 10
          },
          {
            type: 'bundle',
            name: 'bgm00003',
            path: 'sound/scenario/bgm/bgm00003',
            fileCount: 2,
            totalSize: 3000
          },
          {
            type: 'bundle',
            name: '01_an_02',
            path: 'sound/scenario/bgm/01_an_02',
            fileCount: 2,
            totalSize: 500
          }
        ]
      } else if (prefix === 'sound/area_bgm/') {
        items = [
          {
            type: 'bundle',
            name: 'bgm_area_bigtree',
            path: 'sound/area_bgm/bgm_area_bigtree',
            fileCount: 2,
            totalSize: 800
          }
        ]
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ server: 'jp', prefix, items }))
      return
    }

    if (url.pathname === '/api/assets/bundle-files') {
      const bundlePath = url.searchParams.get('path') || ''
      const name = path.posix.basename(bundlePath)
      const isBackground = bundlePath.startsWith('scenario/background/')
      const files = isBackground
        ? [
            {
              type: 'asset',
              name: `${name}.png`,
              path: `${bundlePath}/${name}.png`,
              url: `/sekai-jp-assets/${bundlePath}/${name}.png`,
              size: 100
            },
            {
              type: 'asset',
              name: `${name}.webp`,
              path: `${bundlePath}/${name}.webp`,
              url: `/sekai-jp-assets/${bundlePath}/${name}.webp`,
              size: 80
            }
          ]
        : [
            {
              type: 'asset',
              name: `${name}.mp3`,
              path: `${bundlePath}/${name}.mp3`,
              url: `/sekai-jp-assets/${bundlePath}/${name}.mp3`,
              size: 70
            },
            {
              type: 'asset',
              name: 'soundbundlebuilddata.json',
              path: `${bundlePath}/soundbundlebuilddata.json`,
              url: `/sekai-jp-assets/${bundlePath}/soundbundlebuilddata.json`,
              size: 5
            }
          ]
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ bundle: { path: bundlePath }, items: files }))
      return
    }

    if (url.pathname.startsWith('/sekai-jp-assets/')) {
      res.setHeader('content-type', 'application/octet-stream')
      res.end(Buffer.from(`payload:${url.pathname}`))
      return
    }

    res.statusCode = 404
    res.end('not found')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.close()
      await once(server, 'close')
    }
  }
}

test('lists backgrounds and BGM bundles, filtering silence and non-bg bundles', async (t) => {
  const mock = await startAssetServer()
  t.after(() => mock.close())

  const result = await listMedia({
    region: 'jp',
    assetBase: mock.baseUrl,
    kinds: ['background', 'bgm'],
    includeAreaBgm: true,
    timeoutMs: 5000,
    retries: 0
  })
  assert.deepEqual(
    result.bundles.map((bundle) => bundle.name),
    ['bg_a000001', 'bg_a000002', '01_an_02', 'bgm_area_bigtree', 'bgm00003']
  )
  assert.equal(
    result.bundles.some((bundle) => bundle.name === 'bgm00000'),
    false
  )
  assert.equal(
    result.bundles.some((bundle) => bundle.name === 'background'),
    false
  )
})

test('downloads media, registers it and preserves existing manifest comments', async (t) => {
  const mock = await startAssetServer()
  t.after(() => mock.close())
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-media-'))
  const soundtrackIndex = {
    source: 'test',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    tracks: new Map([
      ['01_an_02', { file: '01_an_02', titles: ['安静日常'], categories: ['剧情'] }]
    ])
  }

  const imagesFile = path.join(outDir, 'images', 'images.yaml')
  write(
    imagesFile,
    '# images comment\nimages:\n  - file: old.jpg\n    name: 旧背景\n    description: 保留我\n'
  )
  const bgmFile = path.join(outDir, 'audio', 'bgm', 'bgm.yaml')
  write(
    bgmFile,
    'enabled: true\npath: audio/bgm/bg1.mp3\nvolume: 0.2\n\nbgm:\n  - file: bg1.mp3\n    name: 旧曲\n    description: 保留我\n'
  )

  const result = await fetchMedia({
    outDir,
    region: 'jp',
    assetBase: mock.baseUrl,
    kinds: ['background', 'bgm'],
    limit: 1,
    timeoutMs: 5000,
    retries: 0,
    soundtrackIndex
  })

  assert.equal(result.errors.length, 0)
  assert.deepEqual(
    result.backgrounds.map((item) => item.name),
    ['bg_a000001']
  )
  assert.deepEqual(
    result.bgm.map((item) => item.name),
    ['01_an_02']
  )
  assert.equal(result.backgrounds[0].file, 'images/bg_a000001.webp')
  assert.equal(result.bgm[0].file, 'audio/bgm/01_an_02.mp3')
  assert.ok(fs.existsSync(path.join(outDir, 'images', 'bg_a000001.webp')))
  assert.ok(fs.existsSync(path.join(outDir, 'audio', 'bgm', '01_an_02.mp3')))
  assert.equal(result.addedImages.length, 1)
  assert.equal(result.addedBgm.length, 1)
  assert.equal(result.addedBgm[0].name, '安静日常')
  assert.equal(result.addedBgm[0].description, '剧情 BGM')

  const imagesText = fs.readFileSync(imagesFile, 'utf-8')
  assert.ok(imagesText.includes('# images comment'))
  assert.ok(imagesText.includes('description: 保留我'))
  assert.ok(imagesText.includes('bg_a000001.webp'))
  const images = loadYaml(imagesText)
  assert.equal(images.images.length, 2)
  assert.equal(images.images[1].description, '')

  const bgmText = fs.readFileSync(bgmFile, 'utf-8')
  assert.ok(bgmText.includes('description: 保留我'))
  const bgm = loadYaml(bgmText)
  assert.equal(bgm.enabled, true)
  assert.equal(bgm.path, 'audio/bgm/bg1.mp3')
  assert.equal(bgm.bgm.length, 2)
  assert.equal(bgm.bgm[1].file, '01_an_02.mp3')
  assert.equal(bgm.bgm[1].name, '安静日常')
  assert.equal(bgm.bgm[1].description, '剧情 BGM')

  // 第二次运行：文件已存在则跳过，清单不重复追加
  const again = await fetchMedia({
    outDir,
    region: 'jp',
    assetBase: mock.baseUrl,
    kinds: ['background', 'bgm'],
    limit: 1,
    timeoutMs: 5000,
    retries: 0,
    soundtrackIndex
  })
  assert.ok(again.backgrounds.every((item) => item.skipped))
  assert.ok(again.bgm.every((item) => item.skipped))
  assert.equal(again.addedImages.length, 0)
  assert.equal(again.addedBgm.length, 0)
  assert.equal(loadYaml(fs.readFileSync(imagesFile, 'utf-8')).images.length, 2)
  assert.equal(loadYaml(fs.readFileSync(bgmFile, 'utf-8')).bgm.length, 2)

  fs.rmSync(outDir, { recursive: true, force: true })
})
