/**
 * 资源目录合并：本地 models.yaml/images.yaml/bgm.yaml 全部缺省时，
 * 目录仍能从云端快照生成；背景按官方地点名选择，BGM 按曲名选择。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ResourceCatalog } from '../../out-host/host/resources/resourceCatalog.js'
import { CatalogView } from '../../out-host/host/ai/prompt.js'

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}

const cloudCatalog = {
  format: 'msst.cloud-catalog/1',
  generatedAt: new Date().toISOString(),
  region: 'jp',
  sources: {
    indexUrl: 'https://example.test/models.json',
    libraryRoot: 'https://example.test/library/',
    assetBase: 'https://example.test',
    soundtrack: ''
  },
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
      facials: ['face_smile_01'],
      defaultMotion: 'w-normal-nod01',
      defaultFacial: 'face_smile_01'
    }
  ],
  backgrounds: [
    {
      id: 'bg_a000301',
      file: 'cloud/bg_a000301',
      name: '教室',
      aliases: ['神山高校 ３年Ａ組'],
      description: '同类场景：神山高校 ３年Ａ組'
    },
    {
      id: 'bg_unknown',
      file: 'cloud/bg_unknown',
      name: 'bg_unknown',
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
    },
    {
      id: '01_an_02',
      file: 'cloud/01_an_02.mp3',
      name: '01_an_02',
      description: ''
    }
  ]
}

test('catalog builds from cloud only and resolves names for images and bgm', () => {
  const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-cloud-merge-'))
  const config = { paths: { resources: resourcesDir } }
  const catalog = new ResourceCatalog(logger, config, () => cloudCatalog)
  const data = catalog.get()

  assert.equal(data.models.length, 1)
  assert.equal(data.models[0].id, 1001)
  assert.equal(data.models[0].source, 'cloud')
  assert.equal(data.models[0].cloudId, '01ichika_normal')
  assert.equal(data.models[0].path, cloudCatalog.models[0].path)

  assert.equal(data.imageDetails.length, 2, 'all cloud backgrounds remain addressable')
  assert.equal(data.imageDetails[0].name, '教室')
  assert.equal(data.images[0], 'cloud/bg_a000301')
  assert.equal(data.images[1], 'cloud/bg_unknown')

  assert.equal(data.bgmDetails.length, 2, 'all cloud bgm remain addressable without soundtracks-only drop')
  assert.equal(data.bgmDetails[0].name, 'Slapstick!!')
  assert.ok(data.cloud)

  const view = new CatalogView(data)
  assert.equal(view.canonicalImage('教室'), 'cloud/bg_a000301')
  assert.equal(view.canonicalImage('bg_a000301'), 'cloud/bg_a000301')
  assert.equal(view.canonicalImage('bg_unknown'), 'cloud/bg_unknown')
  assert.equal(view.canonicalImage('神山高校 ３年Ａ組'), 'cloud/bg_a000301')
  assert.equal(view.canonicalImage('不存在的背景'), null)
  assert.equal(view.canonicalBgm('Slapstick!!'), 'cloud/bgm00003.mp3')
  assert.equal(view.canonicalBgm('bgm00003'), 'cloud/bgm00003.mp3')
  assert.equal(view.canonicalBgm('01_an_02'), 'cloud/01_an_02.mp3')
  assert.equal(view.canonicalBgm('cloud/bgm00003.mp3'), 'cloud/bgm00003.mp3')
  assert.equal(view.imagePromptChoices().length, 1, 'prompt choices still filter unnamed entries')
})

test('local models do not suppress alternate cloud outfits or missing characters', () => {
  const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-cloud-local-'))
  fs.mkdirSync(path.join(resourcesDir, 'models'), { recursive: true })
  fs.writeFileSync(
    path.join(resourcesDir, 'models', 'models.yaml'),
    [
      'models:',
      '  - id: 1',
      "    name: '星乃一歌'",
      "    shortName: '一歌'",
      "    path: '01ichika_local/01ichika.model3.json'",
      ''
    ].join('\n')
  )
  const multiCloudCatalog = {
    ...cloudCatalog,
    models: [
      { ...cloudCatalog.models[0], isDefault: true },
      {
        ...cloudCatalog.models[0],
        id: '01ichika_school',
        outfitCategory: '校服',
        outfitLabel: '校服',
        isDefault: false,
        path: 'cloud/01ichika_school/01ichika_school/01ichika_school.model3.json'
      },
      {
        id: '21miku_normal',
        characterId: 21,
        name: '初音未来',
        shortName: '初音',
        bundle: 'live2d/model/21miku_normal',
        motionBundles: ['live2d/motion/21miku_motion_base'],
        path: 'cloud/21miku_normal/21miku_normal/21miku_normal.model3.json',
        motions: ['w-normal-nod01'],
        facials: ['face_smile_01'],
        defaultMotion: 'w-normal-nod01',
        defaultFacial: 'face_smile_01',
        isDefault: true
      }
    ]
  }
  const catalog = new ResourceCatalog(
    logger,
    { paths: { resources: resourcesDir } },
    () => multiCloudCatalog
  )
  const data = catalog.get()
  assert.equal(data.models[0].source, 'local')
  assert.equal(data.models[0].path, '01ichika_local/01ichika.model3.json')
  assert.ok(
    data.models.some((m) => m.cloudId === '01ichika_school'),
    'alternate cloud outfit is not suppressed by local models.yaml'
  )
  assert.ok(
    data.models.some((m) => m.cloudId === '21miku_normal'),
    'missing virtual singer is not suppressed by local models.yaml'
  )
  assert.ok(
    !data.models.some((m) => m.cloudId === '01ichika_normal'),
    'local entry still wins default slot for same character'
  )
})

test('cloud names attach to matching local background and bgm files without dropping cloud variants', () => {
  const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-cloud-attach-'))
  fs.mkdirSync(path.join(resourcesDir, 'images'), { recursive: true })
  fs.mkdirSync(path.join(resourcesDir, 'audio', 'bgm'), { recursive: true })
  fs.writeFileSync(path.join(resourcesDir, 'images', 'bg_a000301.webp'), '')
  fs.writeFileSync(path.join(resourcesDir, 'audio', 'bgm', 'bgm00003.mp3'), '')

  const catalog = new ResourceCatalog(
    logger,
    { paths: { resources: resourcesDir } },
    () => cloudCatalog
  )
  const data = catalog.get()
  assert.equal(data.images[0], 'bg_a000301.webp')
  assert.ok(!data.images.includes('cloud/bg_a000301'), 'no cloud/ duplicate for matching local stem')
  assert.ok(data.images.includes('cloud/bg_unknown'), 'other cloud backgrounds stay available')
  assert.equal(data.imageDetails[0].name, '教室')
  assert.equal(data.imageDetails[0].id, 'bg_a000301')

  assert.equal(data.bgm[0], 'bgm00003.mp3')
  assert.ok(!data.bgm.includes('cloud/bgm00003.mp3'), 'no cloud/ duplicate for matching local stem')
  assert.ok(data.bgm.includes('cloud/01_an_02.mp3'), 'other cloud bgm stay available')
  assert.equal(data.bgmDetails[0].name, 'Slapstick!!')
  assert.equal(data.bgmDetails[0].id, 'bgm00003')

  const view = new CatalogView(data)
  assert.equal(view.canonicalImage('教室'), 'bg_a000301.webp')
  assert.equal(view.canonicalBgm('Slapstick!!'), 'bgm00003.mp3')
})
