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
import { parseAudioCuesLoop } from '../../out-host/host/assets/media.js'
import { live2dMotionSetCandidateNames } from '../../out-host/host/assets/moesekai.js'
import { ResourceCatalog } from '../../out-host/host/resources/resourceCatalog.js'

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
            id: '01ichika_school',
            bundle: 'live2d/model/01ichika_school',
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
            id: 'sub_nenedayo',
            bundle: 'live2d/model/sub_nenedayo',
            motion: 'live2d/motion/02saki_motion_base',
            motions: ['live2d/motion/02saki_motion_base'],
            kind: 'mob'
          }
        ]
      })
      return
    }
    if (url.pathname === '/jp/library/live2d/model/01ichika_normal/_ripper.json') {
      json({ files: [{ path: '01ichika_normal.model3.json' }] })
      return
    }
    if (url.pathname === '/jp/library/live2d/model/01ichika_school/_ripper.json') {
      json({ files: [{ path: '01ichika_school.model3.json' }] })
      return
    }
    if (url.pathname === '/jp/library/live2d/model/02saki_normal/_ripper.json') {
      json({ files: [{ path: '02saki_normal.model3.json' }] })
      return
    }
    if (url.pathname === '/jp/library/live2d/model/sub_nenedayo/_ripper.json') {
      json({ files: [{ path: 'sub_nenedayo.model3.json' }] })
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
      if (prefix === 'sound/area_bgm/') {
        json({
          items: [
            {
              type: 'bundle',
              name: 'normal_area',
              path: 'sound/area_bgm/normal_area',
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
    assert.equal(
      catalog.models.length,
      4,
      'exposes main characters, alternate outfits, and notable sub characters'
    )
    const ichika = catalog.models.find((model) => model.id === '01ichika_normal')
    assert.ok(ichika)
    assert.equal(ichika.name, '星乃一歌')
    assert.equal(ichika.isDefault, true)
    assert.equal(ichika.path, 'cloud/01ichika_normal/01ichika_normal/01ichika_normal.model3.json')
    assert.deepEqual(ichika.motions, ['w-normal-nod01'])
    assert.deepEqual(ichika.facials, ['face_smile_01'])
    assert.equal(ichika.defaultMotion, 'w-normal-nod01')
    assert.equal(ichika.defaultFacial, 'face_smile_01')

    const ichikaSchool = catalog.models.find((model) => model.id === '01ichika_school')
    assert.ok(ichikaSchool)
    assert.equal(ichikaSchool.outfitCategory, '校服')
    assert.equal(ichikaSchool.isDefault, false)

    const neneRobo = catalog.models.find((model) => model.id === 'sub_nenedayo')
    assert.ok(neneRobo)
    assert.equal(neneRobo.name, '宁宁号')
    assert.equal(neneRobo.isSubCharacter, true)

    const named = catalog.backgrounds.find((entry) => entry.id === 'bg_a000301')
    assert.equal(named.name, '神山高校 三年一班')
    assert.equal(named.category, '校园')
    const unknown = catalog.backgrounds.find((entry) => entry.id === 'bg_unknown')
    assert.equal(unknown.name, 'bg_unknown')

    const bgm = catalog.bgm.find((entry) => entry.id === 'bgm00003')
    assert.equal(bgm.name, 'Slapstick!!')
    assert.match(bgm.description, /剧情/)
    const areaBgm = catalog.bgm.find((entry) => entry.id === 'normal_area')
    assert.ok(areaBgm)
    assert.equal(areaBgm.bundlePath, 'sound/area_bgm/normal_area')
    assert.ok(requests.some((request) => request.startsWith('/api/assets/bundles')))
  } finally {
    server.close()
    await once(server, 'close')
  }
})

test('parseAudioCuesLoop, motion set candidate matching, and ResourceCatalog search helpers work cleanly', () => {
  const loop = parseAudioCuesLoop(
    {
      format: 'audio-cues',
      version: 1,
      cues: [
        {
          name: 'bgm00003',
          waveforms: [
            {
              role: 'cue/bgm00003',
              frames: 2090950,
              sample_rate: 44100,
              channels: 2,
              loop: [0, 2090950]
            }
          ]
        }
      ]
    },
    'bgm00003'
  )
  assert.ok(loop)
  assert.equal(loop.source, 'audio-cues')
  assert.equal(loop.loopStartSample, 0)
  assert.equal(loop.loopEndSample, 2090950)
  assert.equal(loop.sampleRate, 44100)

  assert.deepEqual(live2dMotionSetCandidateNames('v2_05minori_fancostume_live01'), [
    'v2_05minori_motion_base',
    '05minori_motion_base'
  ])
  assert.deepEqual(live2dMotionSetCandidateNames('sub_anfather_live'), [
    'sub_anfather_live_motion_base',
    'sub_anfather_motion_base'
  ])

  const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-rc-search-'))
  try {
    const noop = { info: () => undefined, warn: () => undefined, error: () => undefined }
    const rc = new ResourceCatalog(noop, { paths: { resources: resourcesDir } }, () => ({
      format: 'msst.cloud-catalog/1',
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      region: 'jp',
      sources: { indexUrl: '', libraryRoot: '', assetBase: '', soundtrack: '' },
      models: [
        {
          id: '05minori_swim',
          characterId: 5,
          name: '花里实乃理',
          shortName: '实乃理',
          unit: 'MORE MORE JUMP!',
          outfitCategory: '泳装',
          outfitLabel: '泳装',
          isDefault: false,
          bundle: 'live2d/model/05minori_swim',
          motionBundles: ['live2d/motion/05minori_motion_base'],
          path: 'cloud/05minori_swim/05minori_swimsuit/05minori_swimsuit.model3.json',
          motions: ['w-normal-nod01'],
          facials: ['face_smile_01'],
          defaultMotion: 'w-normal-nod01',
          defaultFacial: 'face_smile_01'
        }
      ],
      backgrounds: [
        {
          id: 'bg_white',
          file: 'cloud/bg_white',
          name: '纯白过渡幕布',
          aliases: [],
          description: '特效与纯色·通用·室内',
          category: '特效与纯色',
          timeOfDay: '通用',
          indoor: '室内',
          tags: ['白屏', '纯色']
        }
      ],
      bgm: [
        {
          id: 'bgm00003',
          file: 'cloud/bgm00003.mp3',
          name: 'Slapstick!!',
          description: '元气欢快·快板',
          mood: '元气欢快',
          category: '日常喜剧',
          tags: ['元气欢快']
        }
      ],
      se: [
        {
          id: 'se00204_b_1',
          file: 'cloud/se00204_b_1.mp3',
          name: 'se00204_b_1',
          bundle: 'sound/scenario/se/se',
          category: '日常环境',
          description: '剧情环境与动作音效（se00204_b_1）',
          tags: ['剧情', '日常']
        }
      ]
    }))

    assert.equal(rc.findModel('05minori_swim')?.outfitCategory, '泳装')
    assert.equal(rc.findBackground('纯白过渡幕布')?.id, 'bg_white')
    assert.equal(rc.findBgm('Slapstick!!')?.id, 'bgm00003')
    assert.equal(rc.findSe('se00204_b_1')?.id, 'se00204_b_1')
    const search = rc.searchAssets({ kind: 'all', query: '泳装', limit: 5 })
    assert.equal(search.models?.length, 1)

    // When a cloud model IS cached locally on disk, ResourceCatalog must report the real .model3.json motions
    const cachedModelDir = path.join(resourcesDir, 'models', 'cloud', '05minori_swim', '05minori_swimsuit')
    fs.mkdirSync(path.join(cachedModelDir, 'motions'), { recursive: true })
    fs.writeFileSync(
      path.join(cachedModelDir, 'motions', 'w-cached-only.motion3.json'),
      JSON.stringify({ Version: 3, Curves: [] })
    )
    fs.writeFileSync(
      path.join(cachedModelDir, '05minori_swimsuit.model3.json'),
      JSON.stringify({
        Version: 3,
        FileReferences: {
          Motions: {
            'w-cached-only': [{ File: 'motions/w-cached-only.motion3.json', FadeInTime: 0.5, FadeOutTime: 0.5 }],
            'w-missing-file': [{ File: 'motions/w-missing-file.motion3.json', FadeInTime: 0.5, FadeOutTime: 0.5 }]
          }
        }
      })
    )
    rc.invalidate()
    const cachedEntry = rc.findModel('05minori_swim')
    assert.deepEqual(
      cachedEntry?.motions,
      ['w-cached-only'],
      'ResourceCatalog must reflect real cached model3.json motions and skip missing files'
    )
  } finally {
    fs.rmSync(resourcesDir, { recursive: true, force: true })
  }
})
