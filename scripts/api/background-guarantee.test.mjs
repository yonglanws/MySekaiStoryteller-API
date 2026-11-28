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
import { CatalogView, isSolidOrCurtainBackground } from '../../out-host/host/ai/prompt.js'
import { normalizeBackground } from '../../out-host/host/ai/staged/helpers.js'
import { fallbackCastPlan, normalizeCastPlan } from '../../out-host/host/ai/staged/cast.js'
import { fallbackStaging, normalizeStaging } from '../../out-host/host/ai/staged/staging.js'
import { composeStory } from '../../out-host/host/ai/staged/composer.js'
import { validateAndFixStory } from '../../out-host/host/ai/validate.js'
import {
  downloadMediaFile,
  hasValidImageMagic,
  isHtmlOrErrorPayload,
  isUsableCachedMediaFile
} from '../../out-host/host/assets/media.js'
import { createStaticRouter } from '../../out-host/host/static/staticRoutes.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
const logger = new Logger({ type: 'hidden' })

function buildRealCloudOnlyCatalogView() {
  const bgNamesPath = path.join(REPO_ROOT, 'src/host/assets/background-names.json')
  const bgDoc = JSON.parse(fs.readFileSync(bgNamesPath, 'utf8'))
  const bgMeta = bgDoc.backgrounds ?? bgDoc
  // Mirror cloudCatalog.ts: localeCompare sorts bg_a000000 ahead of bg00002 so bg_a000000 lands at index [0]
  const sortedIds = Object.keys(bgMeta)
    .filter((id) => !id.startsWith('_'))
    .sort((a, b) => a.localeCompare(b))

  const imageDetails = sortedIds.map((id) => {
    const info = bgMeta[id]
    return {
      file: `cloud/${id}`,
      id,
      name: info.name,
      description: info.name,
      source: 'cloud',
      category: info.category,
      timeOfDay: info.timeOfDay,
      indoor: info.indoor,
      tags: info.tags ?? [],
      aliases: info.aliases ?? []
    }
  })

  const models = [
    {
      id: 101,
      name: '白石杏',
      shortName: '杏',
      path: 'cloud/v2_10an_school01/v2_10an_school01.model3.json',
      cloudId: 'v2_10an_school01',
      characterId: 10,
      unit: 'Vivid BAD SQUAD',
      isDefault: true,
      motions: ['w-normal-nod01', 'w-normal-trouble01', 'w-normal-sad01', 'w-normal-glad01'],
      facials: ['face_normal_01', 'face_smile_01', 'face_trouble_01', 'face_surprise_01'],
      defaultMotion: 'w-normal-nod01',
      defaultFacial: 'face_normal_01'
    },
    {
      id: 102,
      name: '东云彰人',
      shortName: '彰人',
      path: 'cloud/v2_11akito_school01/v2_11akito_school01.model3.json',
      cloudId: 'v2_11akito_school01',
      characterId: 11,
      unit: 'Vivid BAD SQUAD',
      isDefault: true,
      motions: ['w-normal-nod01', 'w-normal-trouble01', 'w-normal-sad01', 'w-normal-angry01'],
      facials: ['face_normal_01', 'face_smile_01', 'face_trouble_01', 'face_angry_01'],
      defaultMotion: 'w-normal-nod01',
      defaultFacial: 'face_normal_01'
    }
  ]

  const bgmDetails = [
    {
      file: 'cloud/bgm00003.mp3',
      id: 'bgm00003',
      name: '日常轻快',
      mood: '轻松日常',
      category: '日常',
      description: '校园轻松日常配乐',
      source: 'cloud'
    }
  ]

  return new CatalogView({
    models,
    images: imageDetails.map((d) => d.file),
    imageDetails,
    bgm: bgmDetails.map((b) => b.file),
    bgmDetails,
    se: [],
    seDetails: []
  })
}

test('cloudOnly catalog with bg_a000000 at index [0] never selects pure black curtain as defaultImage or prompt choice', () => {
  const view = buildRealCloudOnlyCatalogView()

  // Confirm the exact production bug precondition: alphabetical cloud sort puts bg_a000000 at [0]
  assert.equal(view.imageDetailsList()[0].id, 'bg_a000000')
  assert.equal(isSolidOrCurtainBackground(view.imageDetailsList()[0]), true)

  // defaultImage() MUST skip bg_a000000 and all 特效与纯色 entries and return daytime scenic bg
  const def = view.defaultImage()
  assert.notEqual(def, 'cloud/bg_a000000')
  const defEntry = view.canonicalImageEntry(def)
  assert.ok(defEntry, 'defaultImage must exist in catalog')
  assert.equal(isSolidOrCurtainBackground(defEntry), false)
  assert.equal(def, 'cloud/bg_a000301')

  // imagePromptChoices() for exam scene must exclude all solid curtains and surface Kamiyama classroom
  const choices = view.imagePromptChoices(80, '白石杏和东云彰人在神山高校数学考试考场')
  assert.equal(
    choices.some((c) => isSolidOrCurtainBackground(c)),
    false,
    'normal scene prompt choices must never include solid/curtain backgrounds'
  )
  assert.ok(
    choices.slice(0, 10).some((c) => c.id === 'bg_a000301'),
    'daytime Kamiyama classroom bg_a000301 should rank near the top for exam prompt'
  )
})

test('exam and classroom queries resolve to daytime Kamiyama classroom while preserving explicit night and rejecting unknown names', () => {
  const view = buildRealCloudOnlyCatalogView()

  for (const query of [
    '考场',
    '考试教室',
    '神山高校教室',
    '神山高校 教室（白天）',
    '神山高校 教室'
  ]) {
    const resolved = view.canonicalImage(query)
    assert.equal(
      resolved,
      'cloud/bg_a000301',
      `expected "${query}" to resolve to daytime Kamiyama classroom cloud/bg_a000301, got ${resolved}`
    )
  }

  // Explicit night classroom query still selects night classroom bg_a000304
  assert.equal(view.canonicalImage('神山高校 教室（夜晚）'), 'cloud/bg_a000304')

  // Unknown nonsense background name must still return null (strict compatibility guarantee)
  assert.equal(view.canonicalImage('不存在的背景'), null)
})

test('staged pipeline (normalizeBackground, cast, staging, composer) rejects bg_a000000 for exam scenes and permits explicit dark-void context', () => {
  const view = buildRealCloudOnlyCatalogView()

  // Normal exam context rejects bg_a000000 and picks daytime Kamiyama classroom
  assert.equal(
    normalizeBackground(view, 'cloud/bg_a000000', '数学考试 考场 白石杏 东云彰人'),
    'cloud/bg_a000301'
  )
  // Explicit dark-void context still allows bg_a000000 when deliberately requested
  assert.equal(
    normalizeBackground(view, 'cloud/bg_a000000', '纯黑背景 虚无空间独白'),
    'cloud/bg_a000000'
  )

  // fallbackCastPlan never falls back to bg_a000000
  const fbPlan = fallbackCastPlan(view, {
    scene: '白石杏和东云彰人在教室数学考试中苦战试卷'
  })
  assert.equal(fbPlan.background, 'cloud/bg_a000301')
  assert.equal(fbPlan.scenes[0].background, 'cloud/bg_a000301')

  // normalizeCastPlan + normalizeStaging + composeStory repair poisoned bg_a000000
  const plan = normalizeCastPlan(
    {
      title: '考场求生',
      event: '神山高校数学考试中杏和彰人硬着头皮写卷子',
      cast: [
        { name: '杏', modelId: 101 },
        { name: '彰人', modelId: 102 }
      ],
      background: 'cloud/bg_a000000',
      scenes: [
        {
          id: 's1',
          summary: '数学考试中',
          background: 'cloud/bg_a000000',
          placeInfo: '神山高校',
          telop: '数学考试中',
          activeCast: ['杏', '彰人']
        }
      ]
    },
    view,
    { scene: '神山高校数学考试' }
  )
  assert.equal(plan.background, 'cloud/bg_a000301')
  assert.equal(plan.scenes[0].background, 'cloud/bg_a000301')

  const dialogue = {
    lines: [
      { id: 'l1', speaker: '杏', content: '这道函数题到底怎么解啊……', emotion: '害怕' },
      { id: 'l2', speaker: '彰人', content: '别看我，我自己也还在算。', emotion: '平静' }
    ]
  }
  const staging = normalizeStaging(
    {
      scenes: [
        {
          id: 's1',
          fromLineId: 'l1',
          background: 'bg_a000000',
          placeInfo: '神山高校',
          telop: '数学考试中',
          ambient: 'normal',
          transitionIn: 'black',
          activeCast: ['杏', '彰人']
        }
      ],
      events: []
    },
    view,
    plan,
    dialogue
  )
  assert.equal(staging.scenes[0].background, 'cloud/bg_a000301')

  const fbStaging = fallbackStaging(view, { ...plan, background: 'cloud/bg_a000000' }, dialogue)
  assert.equal(fbStaging.scenes[0].background, 'cloud/bg_a000301')

  const composed = composeStory(
    view,
    plan,
    dialogue,
    { background: 'cloud/bg_a000000', lines: [] },
    staging
  )
  assert.ok(Array.isArray(composed.images) && composed.images.length >= 1)
  assert.equal(composed.images[0].image, 'cloud/bg_a000301')
  assert.equal(
    composed.images.some((img) => isSolidOrCurtainBackground(img.image)),
    false
  )
})

test('validateAndFixStory repairs exact production exam script with bg_a000000, missing/late ChangeBackgroundImage, dangling imageId, and unclosed curtains', () => {
  const view = buildRealCloudOnlyCatalogView()

  // 1) Exact production exam script pattern: images[0] poisoned with cloud/bg_a000000
  const examScript = {
    models: [
      { id: 101, model: 'cloud/v2_10an_school01/v2_10an_school01.model3.json' },
      { id: 102, model: 'cloud/v2_11akito_school01/v2_11akito_school01.model3.json' }
    ],
    images: [{ id: 1, image: 'cloud/bg_a000000' }],
    snippets: [
      { type: 'ChangeLayoutMode', wait: false, delay: 0, data: { mode: 'Normal' } },
      { type: 'BlackOut', wait: true, delay: 0, data: { duration: 0, color: 'black' } },
      { type: 'ChangeBackgroundImage', wait: true, delay: 0, data: { imageId: 1 } },
      { type: 'BlackIn', wait: true, delay: 0, data: { duration: 600, color: 'black' } },
      { type: 'Telop', wait: true, delay: 0, data: { content: '数学考试中' } },
      { type: 'PlaceInfo', wait: false, delay: 0, data: { text: '神山高校' } },
      {
        type: 'LayoutAppear',
        wait: true,
        delay: 0,
        data: { modelId: 101, from: { side: 'Left', offset: 0 }, to: { side: 'Left', offset: 0 } }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: {
          modelId: 101,
          speaker: '杏',
          content: '完了完了，数学试卷最后一道大题完全不会写……'
        }
      },
      { type: 'BlackOut', wait: true, delay: 0, data: { duration: 600, color: 'black' } }
    ]
  }

  const fixedExam = validateAndFixStory(examScript, view, logger)
  assert.equal(fixedExam.story.images[0].image, 'cloud/bg_a000301')
  assert.ok(
    fixedExam.warnings.some((w) => w.includes('bg_a000000') && w.includes('bg_a000301')),
    `expected warning about replacing bg_a000000, got: ${fixedExam.warnings.join('; ')}`
  )

  // 2) Unclosed BlackOut before Talk + dangling ChangeBackgroundImage imageId + late ChangeBackgroundImage
  const brokenStory = {
    models: [{ id: 101, model: 'cloud/v2_10an_school01/v2_10an_school01.model3.json' }],
    images: [{ id: 1, image: '考场' }],
    snippets: [
      { type: 'ChangeLayoutMode', wait: false, delay: 0, data: { mode: 'Normal' } },
      { type: 'BlackOut', wait: true, delay: 0, data: { duration: 300, color: 'black' } },
      // Notice: no ChangeBackgroundImage before Talk AND no BlackIn before Talk!
      {
        type: 'LayoutAppear',
        wait: true,
        delay: 0,
        data: {
          modelId: 101,
          from: { side: 'Center', offset: 0 },
          to: { side: 'Center', offset: 0 }
        }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: { modelId: 101, speaker: '杏', content: '终于开始考试了！' }
      },
      // Late ChangeBackgroundImage with dangling imageId=99
      { type: 'ChangeBackgroundImage', wait: true, delay: 0, data: { imageId: 99 } },
      // Unclosed SideFade Out before next Talk
      {
        type: 'SideFade',
        wait: true,
        delay: 0,
        data: { direction: 'Left', mode: 'Out', duration: 400 }
      },
      {
        type: 'Talk',
        wait: true,
        delay: 0,
        data: { modelId: 101, speaker: '杏', content: '下一场是英语考试。' }
      },
      // Closing BlackOut after final Talk must remain untouched
      { type: 'BlackOut', wait: true, delay: 0, data: { duration: 600, color: 'black' } }
    ]
  }

  const fixedBroken = validateAndFixStory(brokenStory, view, logger)
  assert.equal(fixedBroken.story.images[0].image, 'cloud/bg_a000301')

  const snips = fixedBroken.story.snippets
  const firstBgIdx = snips.findIndex((s) => s.type === 'ChangeBackgroundImage')
  const firstTalkIdx = snips.findIndex((s) => s.type === 'Talk')
  assert.ok(
    firstBgIdx >= 0 && firstBgIdx < firstTalkIdx,
    'opening ChangeBackgroundImage must precede first Talk'
  )

  // Every ChangeBackgroundImage imageId must be registered in story.images
  const validIds = new Set(fixedBroken.story.images.map((i) => i.id))
  for (const s of snips) {
    if (s.type === 'ChangeBackgroundImage') {
      assert.ok(validIds.has(s.data.imageId), `dangling imageId ${s.data.imageId} was not repaired`)
    }
  }

  // First Talk must have BlackIn inserted before it; second Talk must have SideFade In inserted before it
  const talkIndices = snips
    .map((s, idx) => (s.type === 'Talk' ? idx : -1))
    .filter((idx) => idx >= 0)
  assert.equal(talkIndices.length, 2)
  assert.ok(
    snips.slice(0, talkIndices[0]).some((s) => s.type === 'BlackIn'),
    'unclosed BlackOut before first Talk must be repaired with BlackIn'
  )
  assert.ok(
    snips
      .slice(talkIndices[0], talkIndices[1])
      .some((s) => s.type === 'SideFade' && s.data.mode === 'In'),
    'unclosed SideFade Out before second Talk must be repaired with SideFade In'
  )
  assert.equal(snips[snips.length - 1].type, 'BlackOut', 'closing BlackOut must be preserved')
})

test('media.ts self-heals 0-byte and HTML-corrupt cached background files and rejects HTML error downloads', async () => {
  const validWebp = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x1a, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'ascii'),
    Buffer.from('VP8L0123456789abcdef', 'ascii')
  ])
  const htmlError = Buffer.from('<!DOCTYPE html><html><body>502 Bad Gateway</body></html>', 'utf8')

  assert.equal(hasValidImageMagic(validWebp), true)
  assert.equal(hasValidImageMagic(htmlError), false)
  assert.equal(isHtmlOrErrorPayload(htmlError), true)
  assert.equal(isHtmlOrErrorPayload(validWebp), false)

  let serveHtml = false
  let downloadCount = 0
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/api/assets/bundle-files') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          items: [
            {
              type: 'asset',
              name: 'bg_a000301.webp',
              path: 'scenario/background/bg_a000301/bg_a000301.webp',
              url: '/files/bg_a000301.webp',
              size: validWebp.byteLength
            }
          ]
        })
      )
      return
    }
    if (url.pathname === '/files/bg_a000301.webp') {
      downloadCount += 1
      res.writeHead(200, { 'content-type': serveHtml ? 'text/html' : 'image/webp' })
      res.end(serveHtml ? htmlError : validWebp)
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  const baseUrl = `http://127.0.0.1:${port}`

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mss-bg-media-'))
  try {
    const cachedFile = path.join(tmpDir, 'images', 'cloud', 'bg_a000301.webp')
    fs.mkdirSync(path.dirname(cachedFile), { recursive: true })

    // Case 1: 0-byte cached file must be treated as unusable and re-downloaded
    fs.writeFileSync(cachedFile, Buffer.alloc(0))
    assert.equal(isUsableCachedMediaFile(cachedFile, 'background'), false)
    const r1 = await downloadMediaFile({
      kind: 'background',
      name: 'bg_a000301',
      outDir: tmpDir,
      region: 'jp',
      assetBase: baseUrl,
      subdir: 'cloud',
      retries: 1
    })
    assert.ok(r1)
    assert.equal(r1.skipped, false)
    assert.equal(downloadCount, 1)
    assert.deepEqual(fs.readFileSync(cachedFile), validWebp)
    assert.equal(isUsableCachedMediaFile(cachedFile, 'background', true), true)

    // Case 2: HTML error page cached on disk must be treated as unusable and self-healed
    fs.writeFileSync(cachedFile, htmlError)
    assert.equal(isUsableCachedMediaFile(cachedFile, 'background'), false)
    const r2 = await downloadMediaFile({
      kind: 'background',
      name: 'bg_a000301',
      outDir: tmpDir,
      region: 'jp',
      assetBase: baseUrl,
      subdir: 'cloud',
      retries: 1
    })
    assert.ok(r2)
    assert.equal(r2.skipped, false)
    assert.equal(downloadCount, 2)
    assert.deepEqual(fs.readFileSync(cachedFile), validWebp)

    // Case 3: Healthy cache is skipped without redundant network fetch
    const r3 = await downloadMediaFile({
      kind: 'background',
      name: 'bg_a000301',
      outDir: tmpDir,
      region: 'jp',
      assetBase: baseUrl,
      subdir: 'cloud',
      retries: 1
    })
    assert.ok(r3)
    assert.equal(r3.skipped, true)
    assert.equal(downloadCount, 2)

    // Case 4: Upstream returning HTML error page must fail rather than poisoning disk
    serveHtml = true
    fs.unlinkSync(cachedFile)
    await assert.rejects(
      () =>
        downloadMediaFile({
          kind: 'background',
          name: 'bg_a000301',
          outDir: tmpDir,
          region: 'jp',
          assetBase: baseUrl,
          subdir: 'cloud',
          retries: 1
        }),
      /HTML\/error payload/i
    )
    assert.equal(fs.existsSync(cachedFile), false)
  } finally {
    server.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('staticRoutes resolves extensionless /resources/images/cloud/* to non-empty .webp while preserving cloudOnly 403 isolation', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mss-static-bg-'))
  const webDir = path.join(tmpDir, 'web')
  const resDir = path.join(tmpDir, 'resources')
  const outDir = path.join(tmpDir, 'out')
  fs.mkdirSync(webDir, { recursive: true })
  fs.mkdirSync(path.join(resDir, 'images', 'cloud'), { recursive: true })
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(webDir, 'index.html'), '<html></html>')

  const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02])
  // 0-byte .webp decoy alongside valid .png: resolver must skip 0-byte .webp and serve .png
  fs.writeFileSync(path.join(resDir, 'images', 'cloud', 'bg_a000301.webp'), Buffer.alloc(0))
  fs.writeFileSync(path.join(resDir, 'images', 'cloud', 'bg_a000301.png'), validPng)
  fs.writeFileSync(path.join(resDir, 'images', 'local_bg.webp'), validPng)

  const app = express()
  app.use(
    createStaticRouter({
      paths: {
        webRenderer: webDir,
        resources: resDir,
        output: outDir
      },
      assets: { cloudOnly: true }
    })
  )

  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()

  try {
    const okRes = await fetch(`http://127.0.0.1:${port}/resources/images/cloud/bg_a000301`)
    assert.equal(okRes.status, 200)
    const body = Buffer.from(await okRes.arrayBuffer())
    assert.deepEqual(body, validPng)

    // Non-cloud local image remains 403 in cloudOnly mode
    const blockedLocal = await fetch(`http://127.0.0.1:${port}/resources/images/local_bg`)
    assert.equal(blockedLocal.status, 403)

    // Path traversal attempt remains 403
    const blockedTraversal = await fetch(
      `http://127.0.0.1:${port}/resources/images/cloud/..%2Flocal_bg`
    )
    assert.equal(blockedTraversal.status, 403)
  } finally {
    server.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
