/**
 * 零本地资源全云端架构端到端测试：
 * 1. loadHostConfig() 在空 resources/ 目录下，默认 bg1.mp3 不存在时自动兜底到 bgm00003；本地文件存在时保留本地路径
 * 2. resolveGlobalBgm() 与 resolveStoryCloudAssets() 在空 resources/ 目录下完成 bgm00003 兜底、area_bgm 物化、多时段背景、多服装与亚角色模型下载
 * 3. ResourceCatalog 突破 80 条 BGM 与同名前缀碰撞上限，全量保留场景/区域 BGM、全部背景与多服装模型
 * 4. CatalogView + StoryWriter + validateAndFixStory + lintOfficialStory 在大规模语义目录下保持提示词紧凑并完成服装/时段背景/情绪 BGM 解析
 */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Logger } from 'tslog'
import { loadHostConfig } from '../../out-host/host/config.js'
import { LlmClient } from '../../out-host/host/ai/llm.js'
import { lintOfficialStory } from '../../out-host/host/ai/officialLinter.js'
import { CatalogView } from '../../out-host/host/ai/prompt.js'
import { StoryWriter } from '../../out-host/host/ai/storyWriter.js'
import { validateAndFixStory } from '../../out-host/host/ai/validate.js'
import {
  findCloudBackground,
  findCloudModel,
  resolveGlobalBgm,
  resolveStoryCloudAssets
} from '../../out-host/host/assets/cloudAssets.js'
import { CloudCatalogService } from '../../out-host/host/assets/cloudCatalog.js'
import { ResourceCatalog } from '../../out-host/host/resources/resourceCatalog.js'

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
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

async function startCloudAssetServer() {
  const downloadedUrls = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const send = (value, type = 'application/json') => {
      res.writeHead(200, { 'content-type': type })
      res.end(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    }

    if (url.pathname === '/api/assets/bundle-files') {
      const bundlePath = url.searchParams.get('path') || ''
      if (bundlePath === 'sound/scenario/bgm/bgm00003') {
        send({
          items: [
            {
              type: 'asset',
              name: 'bgm00003.mp3',
              path: 'sound/scenario/bgm/bgm00003/bgm00003.mp3',
              url: '/files/bgm00003.mp3',
              size: 6
            }
          ]
        })
        return
      }
      if (bundlePath === 'sound/area_bgm/normal_area') {
        send({
          items: [
            {
              type: 'asset',
              name: 'BGM_AREA_2.mp3',
              path: 'sound/area_bgm/normal_area/BGM_AREA_2.mp3',
              url: '/files/BGM_AREA_2.mp3',
              size: 6
            }
          ]
        })
        return
      }
      if (bundlePath === 'scenario/background/bg_a000102') {
        send({
          items: [
            {
              type: 'asset',
              name: 'bg_a000102.webp',
              path: 'scenario/background/bg_a000102/bg_a000102.webp',
              url: '/files/bg_a000102.webp',
              size: 5
            }
          ]
        })
        return
      }
      if (bundlePath === 'live2d/model/01ichika_school') {
        send({
          items: [
            {
              type: 'asset',
              name: '01ichika_school.model3.json',
              path: 'live2d/model/01ichika_school/01ichika_school.model3.json',
              url: '/files/model/01ichika_school.model3.json',
              size: 50
            }
          ]
        })
        return
      }
      if (bundlePath === 'live2d/motion/01ichika_motion_base') {
        send({
          items: [
            {
              type: 'asset',
              name: 'w-normal-nod01.motion3.bytes',
              path: 'live2d/motion/01ichika_motion_base/w-normal-nod01.motion3.bytes',
              url: '/files/motion/w-normal-nod01.json',
              size: 50
            }
          ]
        })
        return
      }
      send({ items: [] })
      return
    }

    if (url.pathname === '/library/live2d/model/01ichika_school/_ripper.json') {
      send({ files: [{ path: '01ichika_school.model3.json' }] })
      return
    }
    if (url.pathname === '/library/live2d/model/01ichika_school/01ichika_school.model3.json') {
      send({ FileReferences: {} })
      return
    }
    if (url.pathname === '/library/live2d/motion/01ichika_motion_base/_ripper.json') {
      send({ files: [{ path: 'motion/w-normal-nod01.sse-motion.json' }] })
      return
    }
    if (url.pathname === '/library/live2d/motion/01ichika_motion_base/motion/w-normal-nod01.sse-motion.json') {
      send(SSE_MOTION)
      return
    }

    if (url.pathname.startsWith('/files/')) {
      downloadedUrls.push(url.pathname)
      if (url.pathname === '/files/model/01ichika_school.model3.json') {
        send({
          Version: 3,
          FileReferences: { Moc: '01ichika_school.moc3', Textures: [] },
          motions: {}
        })
        return
      }
      if (url.pathname === '/files/motion/w-normal-nod01.json') {
        send(SSE_MOTION)
        return
      }
      send(Buffer.from('DUMMY!'), 'application/octet-stream')
      return
    }

    res.writeHead(404)
    res.end('not found')
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, downloadedUrls, baseUrl: `http://127.0.0.1:${server.address().port}` }
}

test('loadHostConfig falls back to bgm00003 on empty resourcesDir and respects local bg1.mp3 when present', (t) => {
  const emptyResources = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-empty-cfg-'))
  const localResources = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-local-cfg-'))
  const prevResourceDir = process.env.MSS_RESOURCE_DIR
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
    fs.mkdirSync(path.join(localResources, 'audio', 'bgm'), { recursive: true })
    fs.writeFileSync(path.join(localResources, 'audio', 'bgm', 'bg1.mp3'), Buffer.from('LOCAL'))

    delete process.env.MSS_ASSETS_CLOUD_CATALOG
    process.env.MSS_RESOURCE_DIR = emptyResources
    const cloudFirstConfig = loadHostConfig()
    assert.equal(cloudFirstConfig.assets.cloudCatalog, true)
    assert.equal(cloudFirstConfig.bgm.path, 'bgm00003')

    process.env.MSS_RESOURCE_DIR = localResources
    const localConfig = loadHostConfig()
    assert.equal(localConfig.bgm.path, 'audio/bgm/bg1.mp3')
  } finally {
    if (prevResourceDir === undefined) delete process.env.MSS_RESOURCE_DIR
    else process.env.MSS_RESOURCE_DIR = prevResourceDir
    if (prevCloudCatalog === undefined) delete process.env.MSS_ASSETS_CLOUD_CATALOG
    else process.env.MSS_ASSETS_CLOUD_CATALOG = prevCloudCatalog
    fs.rmSync(emptyResources, { recursive: true, force: true })
    fs.rmSync(localResources, { recursive: true, force: true })
  }
})

test('zero-local resolveGlobalBgm & resolveStoryCloudAssets handle bg1 fallback, area_bgm, multi-time bg, and outfits', async () => {
  const emptyResources = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-zero-res-'))
  const localResources = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-local-bgm-'))
  const { server, downloadedUrls, baseUrl } = await startCloudAssetServer()

  const catalog = {
    format: 'msst.cloud-catalog/1',
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    region: 'jp',
    sources: {
      indexUrl: `${baseUrl}/models.json`,
      libraryRoot: `${baseUrl}/library/`,
      assetBase: baseUrl,
      soundtrack: ''
    },
    models: [
      {
        id: '01ichika_normal',
        characterId: 1,
        name: '星乃一歌',
        shortName: '一歌',
        outfitCategory: '队服',
        outfitLabel: '星乃一歌 队服',
        isDefault: true,
        bundle: 'live2d/model/01ichika_normal',
        motionBundles: ['live2d/motion/01ichika_motion_base'],
        path: 'cloud/01ichika_normal/01ichika_normal/01ichika_normal.model3.json',
        motions: ['w-normal-nod01'],
        facials: [],
        defaultMotion: 'w-normal-nod01',
        defaultFacial: ''
      },
      {
        id: '01ichika_school',
        characterId: 1,
        name: '星乃一歌',
        shortName: '一歌',
        outfitCategory: '校服',
        outfitLabel: '星乃一歌 校服',
        isDefault: false,
        bundle: 'live2d/model/01ichika_school',
        motionBundles: ['live2d/motion/01ichika_motion_base'],
        path: 'cloud/01ichika_school/01ichika_school/01ichika_school.model3.json',
        motions: ['w-normal-nod01'],
        facials: [],
        defaultMotion: 'w-normal-nod01',
        defaultFacial: ''
      }
    ],
    backgrounds: [
      {
        id: 'bg_a000101',
        file: 'cloud/bg_a000101',
        name: '神山高校 天台（白天）',
        aliases: ['神山高校 天台'],
        category: '学校',
        timeOfDay: '白天',
        indoor: '室外',
        tags: ['校园', '天台', '白天'],
        description: '学校 · 室外 · 白天 · 别名: 神山高校 天台'
      },
      {
        id: 'bg_a000102',
        file: 'cloud/bg_a000102',
        name: '神山高校 天台（黄昏）',
        aliases: ['神山高校 天台'],
        category: '学校',
        timeOfDay: '黄昏',
        indoor: '室外',
        tags: ['校园', '天台', '黄昏'],
        description: '学校 · 室外 · 黄昏 · 别名: 神山高校 天台'
      }
    ],
    bgm: [
      {
        id: 'bgm00003',
        file: 'cloud/bgm00003.mp3',
        name: '日常轻快',
        bundlePath: 'sound/scenario/bgm/bgm00003',
        sourceKind: 'scenario',
        mood: '日常·轻快',
        description: '剧情 BGM · 日常·轻快'
      },
      {
        id: 'normal_area',
        file: 'cloud/normal_area.mp3',
        name: '神山高校 区域日常',
        bundlePath: 'sound/area_bgm/normal_area',
        sourceKind: 'area',
        mood: '校园·舒缓',
        description: '区域 BGM · 校园·舒缓'
      }
    ],
    se: []
  }

  const settings = {
    region: 'jp',
    indexBase: '',
    libraryBase: '',
    assetBase: baseUrl,
    soundtrackBase: '',
    cacheDir: path.join(emptyResources, '.cache'),
    concurrency: 2,
    timeoutMs: 5000,
    retries: 0,
    cloudCatalog: true,
    cloudCatalogTtlHours: 24
  }

  try {
    // 1. 空目录 + legacy audio/bgm/bg1.mp3 -> 自动落到 bgm00003，不触发查 bg1
    const legacyBgm = { enabled: true, path: 'audio/bgm/bg1.mp3' }
    assert.equal(await resolveGlobalBgm(legacyBgm, { settings, resourcesDir: emptyResources, catalog, logger }), true)
    assert.equal(legacyBgm.path, 'audio/bgm/cloud/bgm00003.mp3')
    assert.ok(fs.existsSync(path.join(emptyResources, 'audio', 'bgm', 'cloud', 'bgm00003.mp3')))

    // 2. 本地确实存在 audio/bgm/bg1.mp3 -> 优先本地文件
    fs.mkdirSync(path.join(localResources, 'audio', 'bgm'), { recursive: true })
    fs.writeFileSync(path.join(localResources, 'audio', 'bgm', 'bg1.mp3'), Buffer.from('LOCAL'))
    const localBgm = { enabled: true, path: 'audio/bgm/bg1.mp3' }
    assert.equal(await resolveGlobalBgm(localBgm, { settings, resourcesDir: localResources, catalog, logger }), false)
    assert.equal(localBgm.path, 'audio/bgm/bg1.mp3')

    // 3. 多时段背景按时段精确匹配
    assert.equal(findCloudBackground(catalog, '神山高校 天台（黄昏）')?.id, 'bg_a000102')
    assert.equal(findCloudBackground(catalog, '神山高校 天台·黄昏')?.id, 'bg_a000102')
    assert.equal(findCloudBackground(catalog, '神山高校 天台·白天')?.id, 'bg_a000101')

    // 4. 服装名查找
    assert.equal(findCloudModel(catalog, '星乃一歌 校服')?.id, '01ichika_school')

    // 5. 故事资源按需物化：01ichika_school、bg_a000102、area_bgm (normal_area -> cloud/normal_area.mp3)
    const story = {
      models: [{ id: 1, model: '星乃一歌 校服' }],
      images: [{ id: 1, image: '神山高校 天台（黄昏）' }],
      snippets: [
        {
          type: 'ChangeBgm',
          wait: false,
          delay: 0,
          data: { file: '神山高校 区域日常', stop: false, fadeMs: 500, volume: 1 }
        }
      ]
    }
    const result = await resolveStoryCloudAssets(story, {
      settings,
      resourcesDir: emptyResources,
      catalog,
      logger
    })
    assert.equal(result.models, 1)
    assert.equal(result.images, 1)
    assert.equal(result.bgm, 1)
    assert.equal(story.models[0].model, 'cloud/01ichika_school/01ichika_school/01ichika_school.model3.json')
    assert.equal(story.images[0].image, 'cloud/bg_a000102.webp')
    assert.equal(story.snippets[0].data.file, 'cloud/normal_area.mp3')
    assert.ok(fs.existsSync(path.join(emptyResources, 'audio', 'bgm', 'cloud', 'normal_area.mp3')))
    assert.ok(fs.existsSync(path.join(emptyResources, 'images', 'cloud', 'bg_a000102.webp')))
    assert.ok(downloadedUrls.includes('/files/BGM_AREA_2.mp3'))
  } finally {
    server.close()
    fs.rmSync(emptyResources, { recursive: true, force: true })
    fs.rmSync(localResources, { recursive: true, force: true })
  }
})

test('ResourceCatalog + StoryWriter + AI harness operate cleanly over large zero-local semantic catalog', async () => {
  const emptyResources = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-ai-zero-'))

  // 构造 160 条背景（含多时段与未命名）+ 125 条 BGM（含 area_bgm 与无 soundtrack 条目）+ 多服装模型 + SE
  const backgrounds = [
    {
      id: 'bg_a000101',
      file: 'cloud/bg_a000101',
      name: '神山高校 天台（白天）',
      aliases: ['神山高校 天台'],
      category: '学校',
      timeOfDay: '白天',
      indoor: '室外',
      tags: ['校园', '天台', '白天'],
      description: '学校 · 室外 · 白天'
    },
    {
      id: 'bg_a000102',
      file: 'cloud/bg_a000102',
      name: '神山高校 天台（黄昏）',
      aliases: ['神山高校 天台'],
      category: '学校',
      timeOfDay: '黄昏',
      indoor: '室外',
      tags: ['校园', '天台', '黄昏'],
      description: '学校 · 室外 · 黄昏'
    },
    {
      id: 'bg_raw_only',
      file: 'cloud/bg_raw_only',
      name: 'bg_raw_only',
      aliases: [],
      category: '其他',
      timeOfDay: '通用',
      indoor: '通用',
      tags: [],
      description: ''
    },
    ...Array.from({ length: 157 }, (_, i) => ({
      id: `bg_gen_${String(i + 1).padStart(3, '0')}`,
      file: `cloud/bg_gen_${String(i + 1).padStart(3, '0')}`,
      name: `街道角落 ${i + 1}`,
      aliases: [],
      category: i % 2 === 0 ? '街道' : '室内',
      timeOfDay: i % 3 === 0 ? '白天' : i % 3 === 1 ? '黄昏' : '夜晚',
      indoor: i % 2 === 0 ? '室外' : '室内',
      tags: ['生活'],
      description: '日常场景'
    }))
  ]

  const bgm = [
    {
      id: 'bgm00003',
      file: 'cloud/bgm00003.mp3',
      name: '日常轻快',
      bundlePath: 'sound/scenario/bgm/bgm00003',
      sourceKind: 'scenario',
      mood: '日常·轻快',
      tempo: '中速',
      category: '剧情日常',
      scenes: ['校园', '日常对话'],
      description: '剧情 BGM · 日常·轻快 · 适合校园对话'
    },
    {
      id: 'normal_area',
      file: 'cloud/normal_area.mp3',
      name: '神山高校 区域日常',
      bundlePath: 'sound/area_bgm/normal_area',
      sourceKind: 'area',
      mood: '校园·舒缓',
      tempo: '中慢',
      category: '现实区域',
      scenes: ['校园', '漫步'],
      description: '区域 BGM · 校园·舒缓'
    },
    ...Array.from({ length: 123 }, (_, i) => ({
      id: `bgm_${String(i + 100).padStart(4, '0')}`,
      file: `cloud/bgm_${String(i + 100).padStart(4, '0')}.mp3`,
      name: `测试曲目 ${i + 1}`,
      bundlePath: `sound/scenario/bgm/bgm_${String(i + 100).padStart(4, '0')}`,
      sourceKind: 'scenario',
      mood: i % 4 === 0 ? '搞笑·欢快' : i % 4 === 1 ? '温馨·感人' : '日常·轻松',
      tempo: '中速',
      category: '剧情日常',
      scenes: ['对话'],
      description: '剧情 BGM'
    }))
  ]

  const cloudSnapshot = {
    format: 'msst.cloud-catalog/1',
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    region: 'jp',
    sources: { indexUrl: '', libraryRoot: '', assetBase: '', soundtrack: '' },
    models: [
      {
        id: '01ichika_normal',
        characterId: 1,
        name: '星乃一歌',
        shortName: '一歌',
        outfitCategory: '队服',
        outfitLabel: '星乃一歌 队服',
        isDefault: true,
        bundle: 'live2d/model/01ichika_normal',
        motionBundles: ['live2d/motion/01ichika_motion_base'],
        path: 'cloud/01ichika_normal/01ichika_normal/01ichika_normal.model3.json',
        motions: ['w-normal-nod01', 'w-normal-glad01'],
        facials: ['face_smile_01', 'face_normal_01'],
        defaultMotion: 'w-normal-nod01',
        defaultFacial: 'face_normal_01'
      },
      {
        id: '01ichika_school',
        characterId: 1,
        name: '星乃一歌',
        shortName: '一歌',
        outfitCategory: '校服',
        outfitLabel: '星乃一歌 校服',
        isDefault: false,
        bundle: 'live2d/model/01ichika_school',
        motionBundles: ['live2d/motion/01ichika_motion_base'],
        path: 'cloud/01ichika_school/01ichika_school/01ichika_school.model3.json',
        motions: ['w-normal-nod01', 'w-normal-glad01'],
        facials: ['face_smile_01', 'face_normal_01'],
        defaultMotion: 'w-normal-nod01',
        defaultFacial: 'face_normal_01'
      },
      {
        id: '02saki_normal',
        characterId: 2,
        name: '天马咲希',
        shortName: '咲希',
        outfitCategory: '队服',
        outfitLabel: '天马咲希 队服',
        isDefault: true,
        bundle: 'live2d/model/02saki_normal',
        motionBundles: ['live2d/motion/02saki_motion_base'],
        path: 'cloud/02saki_normal/02saki_normal/02saki_normal.model3.json',
        motions: ['w-normal-nod01', 'w-normal-glad01'],
        facials: ['face_smile_01', 'face_normal_01'],
        defaultMotion: 'w-normal-nod01',
        defaultFacial: 'face_normal_01'
      }
    ],
    backgrounds,
    bgm,
    se: [
      { id: 'se00001', file: 'se00001.mp3', name: '开门声（木门/室内）', category: '门窗', tags: ['开门'], description: '门窗音效' },
      { id: 'se00002', file: 'se00002.mp3', name: '学校下课铃声', category: '校园', tags: ['下课铃'], description: '校园钟声' }
    ]
  }

  const fakeLlmServer = http.createServer(async (req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const system = body.messages?.find((m) => m.role === 'system')?.content ?? ''
    const user = body.messages?.find((m) => m.role === 'user')?.content ?? ''

    let reply
    if (system.includes('角色选择器')) {
      reply = { cast: ['星乃一歌', '天马咲希'] }
    } else {
      // 验证 prompt 没有把全部 160 条背景和 125 条 BGM 塞进去，同时命中黄昏天台与校服
      assert.ok(user.includes('神山高校 天台（黄昏）'), 'expected query-matched sunset rooftop in prompt')
      assert.ok(user.includes('校服'), 'expected outfit options in prompt')
      assert.ok(user.length < 25000, `prompt should stay compact, got ${user.length}`)
      reply = {
        models: [
          {
            id: 1,
            model: 'cloud/01ichika_school/01ichika_school/01ichika_school.model3.json',
            normal_scale: 2.1,
            small_scale: 1.8,
            anchor: 0.5
          },
          {
            id: 2,
            model: 'cloud/02saki_normal/02saki_normal/02saki_normal.model3.json',
            normal_scale: 2.1,
            small_scale: 1.8,
            anchor: 0.5
          }
        ],
        images: [{ id: 1, image: '神山高校 天台（黄昏）' }],
        snippets: [
          { type: 'ChangeLayoutMode', wait: false, delay: 0, data: { mode: 'Normal' } },
          { type: 'BlackOut', wait: true, delay: 0, data: { duration: 600 } },
          { type: 'ChangeBackgroundImage', wait: false, delay: 0, data: { imageId: 1 } },
          {
            type: 'ChangeBgm',
            wait: false,
            delay: 0,
            data: { file: '神山高校 区域日常', stop: false, fadeMs: 500, volume: 1 }
          },
          { type: 'BlackIn', wait: true, delay: 0, data: { duration: 800 } },
          {
            type: 'PlaySe',
            wait: false,
            delay: 0,
            data: { file: 'se00001.mp3', volume: 1, loop: false, fadeMs: 0 }
          },
          {
            type: 'LayoutAppear',
            wait: true,
            delay: 0,
            data: {
              modelId: 1,
              from: { side: 'Left', offset: 0 },
              to: { side: 'Left', offset: 0 },
              motion: 'w-normal-nod01',
              facial: 'face_smile_01',
              facialFirst: true,
              moveSpeed: 'Normal'
            }
          },
          {
            type: 'LayoutAppear',
            wait: true,
            delay: 0,
            data: {
              modelId: 2,
              from: { side: 'Right', offset: 0 },
              to: { side: 'Right', offset: 0 },
              motion: 'w-normal-glad01',
              facial: 'face_smile_01',
              facialFirst: true,
              moveSpeed: 'Normal'
            }
          },
          {
            type: 'Talk',
            wait: true,
            delay: 0,
            data: { speaker: '一歌', content: '黄昏的天台风好舒服啊。', modelId: 1 }
          },
          {
            type: 'Talk',
            wait: true,
            delay: 0,
            data: { speaker: '咲希', content: '嗯！放学后穿校服在这里聊天最棒了！', modelId: 2, closeWindowOnFinish: true }
          },
          { type: 'BlackOut', wait: true, delay: 0, data: { duration: 600 } }
        ]
      }
    }

    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        model: 'mock',
        choices: [{ message: { content: JSON.stringify(reply) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      })
    )
  })
  fakeLlmServer.listen(0, '127.0.0.1')
  await once(fakeLlmServer, 'listening')

  const baseUrl = `http://127.0.0.1:${fakeLlmServer.address().port}/v1`
  const prevKey = process.env.MSS_TEST_ZERO_CLOUD_KEY
  process.env.MSS_TEST_ZERO_CLOUD_KEY = 'test-key'

  try {
    const testLogger = new Logger({ minLevel: 6 })
    const catalog = new ResourceCatalog(testLogger, { paths: { resources: emptyResources } }, () => cloudSnapshot)
    const data = catalog.get()

    // 无本地 yaml 时全量暴露：无 80 条上限，无背景碰撞丢弃
    assert.equal(data.models.length, 3)
    assert.equal(data.images.length, 160)
    assert.equal(data.bgm.length, 125)
    assert.equal(data.seDetails?.length, 2)
    assert.ok(data.images.includes('cloud/bg_raw_only'))
    assert.ok(data.bgm.includes('cloud/normal_area.mp3'))

    const view = new CatalogView(data)
    assert.equal(view.primaryModels().length, 2)
    assert.equal(view.outfitsFor('星乃一歌').length, 2)
    assert.equal(view.resolveOutfitVariant('星乃一歌', '校服')?.cloudId, '01ichika_school')
    assert.equal(view.canonicalImageEntry('神山高校 天台（黄昏）')?.file, 'cloud/bg_a000102')

    const queryImgs = view.imagePromptChoices(20, '黄昏 放学 天台')
    assert.ok(queryImgs.length <= 20)
    assert.ok(queryImgs.some((img) => img.file === 'cloud/bg_a000102'))
    assert.ok(!queryImgs.some((img) => img.file === 'cloud/bg_raw_only'))

    const queryBgms = view.bgmPromptChoices(20, '搞笑 欢快')
    assert.ok(queryBgms.length <= 20)
    assert.ok(queryBgms.some((entry) => entry.mood?.includes('搞笑')))

    const settings = {
      enabled: true,
      baseUrl,
      apiKeyEnv: 'MSS_TEST_ZERO_CLOUD_KEY',
      model: 'mock',
      temperature: 0.7,
      maxTokens: 4096,
      timeoutMs: 10000,
      retries: 0,
      repairRounds: 1,
      pipeline: 'single',
      jsonMode: 'off',
      translateForTts: false,
      targetMinutes: 3,
      systemPrompt: '',
      ttsTranslateChunkSize: 20,
      personaDirs: [],
      personas: []
    }
    const writer = new StoryWriter(new LlmClient(settings, new Logger({ minLevel: 6 })), settings, catalog, new Logger({ minLevel: 6 }))
    const generated = await writer.generate({
      prompt: '放学后穿着校服和咲希在黄昏的天台聊天',
      mode: 'story',
      pipeline: 'single'
    })

    assert.equal(generated.story.models[0].model, 'cloud/01ichika_school/01ichika_school/01ichika_school.model3.json')
    assert.equal(generated.story.images[0].image, 'cloud/bg_a000102')
    const changeBgm = generated.story.snippets.find((s) => s.type === 'ChangeBgm')
    assert.equal(changeBgm?.data.file, 'cloud/normal_area.mp3')

    const validated = validateAndFixStory(generated.story, view)
    assert.equal(validated.lint.passed, true, `lint issues: ${validated.lint.issues.join('; ')}`)
    const lint = lintOfficialStory(validated.story, view)
    assert.equal(lint.passed, true, `lint issues: ${lint.issues.join('; ')}`)
  } finally {
    fakeLlmServer.close()
    if (prevKey === undefined) delete process.env.MSS_TEST_ZERO_CLOUD_KEY
    else process.env.MSS_TEST_ZERO_CLOUD_KEY = prevKey
    fs.rmSync(emptyResources, { recursive: true, force: true })
  }
})

test('CloudCatalogService.waitReady waits for cold refresh when snapshot is null, honors stale timeout once cached, and invalidates empty ResourceCatalog cache', async () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-cold-wait-'))
  const cacheFile = path.join(emptyDir, 'catalog.json')
  const testLogger = new Logger({ minLevel: 6 })
  const settings = {
    region: 'jp',
    indexBase: '',
    libraryBase: '',
    assetBase: '',
    soundtrackBase: '',
    cacheDir: emptyDir,
    concurrency: 2,
    timeoutMs: 5000,
    retries: 0,
    cloudCatalog: true,
    cloudCatalogTtlHours: 24
  }

  try {
    const service = new CloudCatalogService(testLogger, settings, { cacheFile, ttlMs: 1 })
    const resourceCatalog = new ResourceCatalog(testLogger, { paths: { resources: emptyDir } }, () => service.get())

    // 先读一次空的 ResourceCatalog，确认它不会锁死 30 秒空缓存
    assert.equal(resourceCatalog.get().models.length, 0)

    const sampleSnapshot = (generatedAt) => ({
      format: 'msst.cloud-catalog/1',
      schemaVersion: 2,
      generatedAt,
      region: 'jp',
      sources: { indexUrl: '', libraryRoot: '', assetBase: '', soundtrack: '' },
      models: [
        {
          id: '01ichika_normal',
          characterId: 1,
          name: '星乃一歌',
          shortName: '一歌',
          outfitCategory: '队服',
          outfitLabel: '星乃一歌 队服',
          isDefault: true,
          bundle: 'live2d/model/01ichika_normal',
          motionBundles: [],
          path: 'cloud/01ichika_normal/01ichika_normal/01ichika_normal.model3.json',
          motions: ['w-normal-nod01'],
          facials: [],
          defaultMotion: 'w-normal-nod01',
          defaultFacial: ''
        }
      ],
      backgrounds: [],
      bgm: [],
      se: []
    })

    let refreshCount = 0
    let inflight = null
    service.refresh = async () => {
      if (inflight) return inflight
      refreshCount += 1
      const round = refreshCount
      inflight = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 60))
        const snap = sampleSnapshot(new Date(Date.now() - (round === 1 ? 1000 : 0)).toISOString())
        service.snapshot = snap
        return snap
      })().finally(() => {
        inflight = null
      })
      return inflight
    }

    // 1. 冷启动时 snapshot 为 null：即使 staleTimeoutMs 很短(10ms)，也应走 coldTimeoutMs(2000ms) 等完首轮刷新
    const coldResult = await service.waitReady({ coldTimeoutMs: 2_000, staleTimeoutMs: 10 })
    assert.ok(coldResult, 'cold waitReady must wait for initial catalog instead of timing out at staleTimeoutMs')
    assert.equal(coldResult.models.length, 1)
    assert.equal(resourceCatalog.get().models.length, 1)

    // 2. 已有旧快照（仅过期）：waitReady 使用 staleTimeoutMs(10ms) 快速返回旧快照，不阻塞 60ms 的后台刷新
    const start = Date.now()
    const staleResult = await service.waitReady({ coldTimeoutMs: 2_000, staleTimeoutMs: 10 })
    const elapsed = Date.now() - start
    assert.ok(staleResult)
    assert.ok(elapsed < 50, `expected fast return using cached snapshot, got ${elapsed}ms`)

    // 等后台第二轮刷新结束，防止定时器泄漏
    await inflight

    // 3. AbortSignal 支持提前中止等待
    service.snapshot = null
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 15)
    const abortedStart = Date.now()
    const abortedResult = await service.waitReady({ coldTimeoutMs: 2_000, signal: controller.signal })
    const abortedElapsed = Date.now() - abortedStart
    assert.equal(abortedResult, null)
    assert.ok(abortedElapsed < 50, `expected early abort exit, got ${abortedElapsed}ms`)
    await inflight
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true })
  }
})

test('ResourceCatalog ignores empty or comment-only bgm.yaml and images.yaml without crashing', () => {
  const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-empty-yaml-'))
  try {
    fs.mkdirSync(path.join(resourcesDir, 'audio', 'bgm'), { recursive: true })
    fs.mkdirSync(path.join(resourcesDir, 'images'), { recursive: true })
    fs.writeFileSync(path.join(resourcesDir, 'audio', 'bgm', 'bgm.yaml'), '# comment only\n', 'utf8')
    fs.writeFileSync(path.join(resourcesDir, 'images', 'images.yaml'), '\n', 'utf8')
    fs.writeFileSync(path.join(resourcesDir, 'images', 'bg_local.png'), Buffer.from('PNG'))

    const catalog = new ResourceCatalog(
      new Logger({ minLevel: 6 }),
      { paths: { resources: resourcesDir } },
      () => null
    )
    const data = catalog.get()
    assert.deepEqual(data.images, ['bg_local.png'])
    assert.deepEqual(data.bgm, [])
  } finally {
    fs.rmSync(resourcesDir, { recursive: true, force: true })
  }
})

test('concurrent resolveStoryCloudAssets with different resourcesDirs downloads models into both directories', async () => {
  const resDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-model-lock-a-'))
  const resDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-model-lock-b-'))
  const { server, baseUrl } = await startCloudAssetServer()

  const catalog = {
    format: 'msst.cloud-catalog/1',
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    region: 'jp',
    sources: {
      indexUrl: `${baseUrl}/models.json`,
      libraryRoot: `${baseUrl}/library/`,
      assetBase: baseUrl,
      soundtrack: ''
    },
    models: [
      {
        id: '01ichika_school',
        characterId: 1,
        name: '星乃一歌',
        shortName: '一歌',
        outfitCategory: '校服',
        outfitLabel: '星乃一歌 校服',
        isDefault: false,
        bundle: 'live2d/model/01ichika_school',
        motionBundles: ['live2d/motion/01ichika_motion_base'],
        path: 'cloud/01ichika_school/01ichika_school/01ichika_school.model3.json',
        motions: ['w-normal-nod01'],
        facials: [],
        defaultMotion: 'w-normal-nod01',
        defaultFacial: ''
      }
    ],
    backgrounds: [],
    bgm: [],
    se: []
  }

  const makeSettings = (dir) => ({
    region: 'jp',
    indexBase: '',
    libraryBase: '',
    assetBase: baseUrl,
    soundtrackBase: '',
    cacheDir: path.join(dir, '.cache'),
    concurrency: 2,
    timeoutMs: 5000,
    retries: 0,
    cloudCatalog: true,
    cloudCatalogTtlHours: 24
  })

  try {
    const storyA = { models: [{ id: 1, model: '星乃一歌 校服' }], images: [], snippets: [] }
    const storyB = { models: [{ id: 1, model: '星乃一歌 校服' }], images: [], snippets: [] }
    const [resA, resB] = await Promise.all([
      resolveStoryCloudAssets(storyA, {
        settings: makeSettings(resDirA),
        resourcesDir: resDirA,
        catalog,
        logger
      }),
      resolveStoryCloudAssets(storyB, {
        settings: makeSettings(resDirB),
        resourcesDir: resDirB,
        catalog,
        logger
      })
    ])
    assert.equal(resA.models, 1)
    assert.equal(resB.models, 1)
    assert.ok(
      fs.existsSync(
        path.join(resDirA, 'models', 'cloud', '01ichika_school', '01ichika_school', '01ichika_school.model3.json')
      )
    )
    assert.ok(
      fs.existsSync(
        path.join(resDirB, 'models', 'cloud', '01ichika_school', '01ichika_school', '01ichika_school.model3.json')
      )
    )
  } finally {
    server.close()
    fs.rmSync(resDirA, { recursive: true, force: true })
    fs.rmSync(resDirB, { recursive: true, force: true })
  }
})
