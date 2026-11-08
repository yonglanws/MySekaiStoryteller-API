/**
 * 云端目录：背景/BGM/Live2D 全部从资源站与 master data 生成，不需要本地登记。
 * 这里用一个假资源站验证：
 * - 模型索引 → 26 位角色筛选 → 动作/表情从 _ripper.json 枚举；
 * - 背景 bundle → 官方地点名（background-names.json）与 id 回退；
 * - BGM bundle → 官方曲名索引。
 */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { buildCloudCatalog } from '../../out-host/host/assets/cloudCatalog.js'

function startServer() {
  const requests = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    requests.push(url.pathname + url.search)
    const json = (value) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (url.pathname === '/models/jp/models.json') {
      json({
        format: 1,
        region: 'jp',
        library: null,
        models: [
          {
            id: '01ichika_normal',
            bundle: 'live2d/model/01ichika_normal',
            motion: 'live2d/motion/01ichika_motion_base',
            motions: ['live2d/motion/01ichika_motion_base'],
            kind: 'character',
            characterId: 1
          },
          {
            id: '02saki_normal',
            bundle: 'live2d/model/02saki_normal',
            motion: 'live2d/motion/02saki_motion_base',
            motions: ['live2d/motion/02saki_motion_base'],
            kind: 'character',
            characterId: 2
          },
          {
            id: 'sub_character',
            bundle: 'live2d/model/sub_character',
            kind: 'sub'
          }
        ]
      })
      return
    }
    if (url.pathname === '/jp/library/live2d/model/01ichika_normal/_ripper.json') {
      json({ files: [{ path: '01ichika_normal.model3.json' }] })
      return
    }
    if (url.pathname === '/jp/library/live2d/model/02saki_normal/_ripper.json') {
      json({ files: [{ path: '02saki_normal.model3.json' }] })
      return
    }
    if (url.pathname === '/jp/library/live2d/motion/01ichika_motion_base/_ripper.json') {
      json({
        files: [
          { path: 'motion/w-normal-nod01.sse-motion.json' },
          { path: 'facial/face_smile_01.sse-motion.json' },
          { path: 'buildmotiondata.json' }
        ]
      })
      return
    }
    if (url.pathname === '/jp/library/live2d/motion/02saki_motion_base/_ripper.json') {
      json({ files: [{ path: 'motion/w-normal-default01.sse-motion.json' }] })
      return
    }
    if (url.pathname === '/api/assets/bundles') {
      const prefix = url.searchParams.get('prefix') || ''
      if (prefix === 'scenario/background/') {
        json({
          items: [
            {
              type: 'bundle',
              name: 'bg_a000301',
              path: 'scenario/background/bg_a000301',
              fileCount: 2,
              totalSize: 10
            },
            {
              type: 'bundle',
              name: 'bg_unknown',
              path: 'scenario/background/bg_unknown',
              fileCount: 1,
              totalSize: 10
            }
          ]
        })
        return
      }
      if (prefix === 'sound/scenario/bgm/') {
        json({
          items: [
            {
              type: 'bundle',
              name: 'bgm00003',
              path: 'sound/scenario/bgm/bgm00003',
              fileCount: 2,
              totalSize: 10
            }
          ]
        })
        return
      }
      json({ items: [] })
      return
    }
    if (url.pathname === '/master/musicSoundTracks.json') {
      json([
        {
          title: 'Slapstick!!',
          musicSoundTrackCategoryId: 13,
          assetbundleFileName: 'bgm00003'
        }
      ])
      return
    }
    if (url.pathname === '/master/musicSoundTrackCategories.json') {
      json([{ id: 13, name: '剧情' }])
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  return { server, requests }
}

test('cloud catalog lists models, named backgrounds and bgm from remote indexes', async () => {
  const { server, requests } = startServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-cloud-catalog-'))
  const settings = {
    source: 'moesekai',
    region: 'jp',
    indexBase: `${base}/models/`,
    libraryBase: `${base}/`,
    assetBase: base,
    soundtrackBase: `${base}/master/`,
    cacheDir,
    concurrency: 2,
    timeoutMs: 5_000,
    retries: 0,
    cloudCatalog: true,
    cloudCatalogTtlHours: 6
  }
  try {
    const catalog = await buildCloudCatalog(settings, { timeoutMs: 5_000, retries: 0 })
    assert.equal(catalog.format, 'msst.cloud-catalog/1')
    assert.equal(catalog.models.length, 2, 'only main characters are catalogued')
    const ichika = catalog.models.find((model) => model.id === '01ichika_normal')
    assert.ok(ichika)
    assert.equal(ichika.name, '星乃一歌')
    assert.equal(ichika.path, 'cloud/01ichika_normal/01ichika_normal/01ichika_normal.model3.json')
    assert.deepEqual(ichika.motions, ['w-normal-nod01'])
    assert.deepEqual(ichika.facials, ['face_smile_01'])
    assert.equal(ichika.defaultMotion, 'w-normal-nod01')
    assert.equal(ichika.defaultFacial, 'face_smile_01')

    const named = catalog.backgrounds.find((entry) => entry.id === 'bg_a000301')
    assert.equal(named.name, '神山高校 ３年Ａ組')
    const unknown = catalog.backgrounds.find((entry) => entry.id === 'bg_unknown')
    assert.equal(unknown.name, 'bg_unknown')

    const bgm = catalog.bgm.find((entry) => entry.id === 'bgm00003')
    assert.equal(bgm.name, 'Slapstick!!')
    assert.match(bgm.description, /剧情/)
    assert.ok(requests.some((request) => request.startsWith('/api/assets/bundles')))
  } finally {
    server.close()
    await once(server, 'close')
  }
})
