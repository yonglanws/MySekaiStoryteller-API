/**
 * Audio parity tests:
 * - WAV `smpl` chunk + CriWare `.hca` (`fmt` + `loop`) metadata extraction + `.loop.json` sidecar
 * - ProjectSekai.acf category gains (`0.75/0.80/0.90`, mono pan `1/sqrt(2)`)
 * - Voice -> BGM (`0.65x`, 0.5s SquareReverse(0.5)) & SE -> BGM (`0.80x`, 0.5s Linear) ducking + min overlap
 * - BgmVolume tween & HCA loop point indexing + BgmPlan / SePlan cue generation
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const nodeRequire = createRequire(import.meta.url)

function loadTsModule(targetRel, extraMocks = new Map()) {
  const modules = new Map()
  const compiled = new Map()
  const context = vm.createContext({
    console,
    Buffer,
    process,
    URL,
    fetch,
    AbortController,
    setTimeout,
    clearTimeout,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Float32Array,
    Int32Array,
    Map,
    Set,
    Promise,
    Error,
    TextDecoder,
    TextEncoder
  })

  function resolveFile(fromDir, spec) {
    const raw = path.resolve(fromDir, spec)
    for (const candidate of [raw, `${raw}.ts`, path.join(raw, 'index.ts')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    }
    return raw
  }

  function load(filePath) {
    const filename = path.isAbsolute(filePath) ? filePath : path.join(root, filePath)
    if (modules.has(filename)) return modules.get(filename)
    if (filename.endsWith('.json')) {
      const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'))
      modules.set(filename, parsed)
      return parsed
    }
    if (!compiled.has(filename)) {
      compiled.set(
        filename,
        new vm.Script(
          `(function (exports, require, __dirname, __filename) {\n${
            ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
              compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                esModuleInterop: true
              },
              fileName: filename
            }).outputText
          }\n})`,
          { filename }
        )
      )
    }
    const exports = {}
    modules.set(filename, exports)
    const require = (spec) => {
      if (extraMocks.has(spec)) return extraMocks.get(spec)
      if (!spec.startsWith('.')) return nodeRequire(spec)
      const resolved = resolveFile(path.dirname(filename), spec)
      const normalized = resolved.replace(/\\/g, '/')
      for (const [k, v] of extraMocks.entries()) {
        if (normalized.endsWith(k.replace(/\\/g, '/'))) return v
      }
      return load(resolved)
    }
    compiled.get(filename).runInContext(context)(exports, require, path.dirname(filename), filename)
    return exports
  }

  return load(targetRel)
}

function buildSyntheticWavWithSmpl({
  sampleRate,
  channels,
  bitsPerSample,
  totalSamples,
  loopStart,
  loopEnd
}) {
  const blockAlign = channels * (bitsPerSample / 8)
  const dataBytes = totalSamples * blockAlign
  const fmtChunk = Buffer.alloc(24)
  fmtChunk.write('fmt ', 0, 'ascii')
  fmtChunk.writeUInt32LE(16, 4)
  fmtChunk.writeUInt16LE(1, 8)
  fmtChunk.writeUInt16LE(channels, 10)
  fmtChunk.writeUInt32LE(sampleRate, 12)
  fmtChunk.writeUInt32LE(sampleRate * blockAlign, 16)
  fmtChunk.writeUInt16LE(blockAlign, 20)
  fmtChunk.writeUInt16LE(bitsPerSample, 22)

  const dataChunk = Buffer.alloc(8 + dataBytes)
  dataChunk.write('data', 0, 'ascii')
  dataChunk.writeUInt32LE(dataBytes, 4)

  const smplBody = Buffer.alloc(60)
  smplBody.writeUInt32LE(1, 28) // loopCount
  smplBody.writeUInt32LE(loopStart, 44)
  smplBody.writeUInt32LE(loopEnd, 48)
  const smplHeader = Buffer.alloc(8)
  smplHeader.write('smpl', 0, 'ascii')
  smplHeader.writeUInt32LE(smplBody.length, 4)

  const payload = Buffer.concat([fmtChunk, dataChunk, smplHeader, smplBody])
  const riff = Buffer.alloc(12)
  riff.write('RIFF', 0, 'ascii')
  riff.writeUInt32LE(4 + payload.length, 4)
  riff.write('WAVE', 8, 'ascii')
  return Buffer.concat([riff, payload])
}

function buildSyntheticHca({
  sampleRate,
  blockCount,
  encoderDelay,
  encoderPadding,
  loopStartBlock,
  loopEndBlock,
  bit7Mask = false
}) {
  const mask = (tag) => Buffer.from([...tag].map((ch) => ch.charCodeAt(0) | (bit7Mask ? 0x80 : 0)))

  const fmt = Buffer.alloc(16)
  mask('fmt\0').copy(fmt, 0)
  fmt[4] = 2 // channels
  fmt[5] = (sampleRate >> 16) & 0xff
  fmt[6] = (sampleRate >> 8) & 0xff
  fmt[7] = sampleRate & 0xff
  fmt.writeUInt32BE(blockCount, 8)
  fmt.writeUInt16BE(encoderDelay, 12)
  fmt.writeUInt16BE(encoderPadding, 14)

  const loop = Buffer.alloc(16)
  mask('loop').copy(loop, 0)
  loop.writeUInt32BE(loopStartBlock, 4)
  loop.writeUInt32BE(loopEndBlock, 8)
  loop.writeUInt16BE(0, 12)
  loop.writeUInt16BE(0, 14)

  const headerSize = 8 + fmt.length + loop.length
  const head = Buffer.alloc(8)
  mask('HCA\0').copy(head, 0)
  head.writeUInt16BE(0x0200, 4)
  head.writeUInt16BE(headerSize, 6)

  return Buffer.concat([head, fmt, loop])
}

test('parseWavSmplLoop and parseHcaLoop extract sample-accurate loop intervals and sidecars', () => {
  const media = loadTsModule('src/host/assets/media.ts')

  const wav = buildSyntheticWavWithSmpl({
    sampleRate: 48000,
    channels: 2,
    bitsPerSample: 16,
    totalSamples: 240000,
    loopStart: 48000,
    loopEnd: 192000
  })
  const wavLoop = media.parseWavSmplLoop(wav)
  assert.ok(wavLoop)
  assert.equal(wavLoop.source, 'wav-smpl')
  assert.equal(wavLoop.loopStartSample, 48000)
  assert.equal(wavLoop.loopEndSample, 192000)
  assert.equal(wavLoop.loopStartMs, 1000)
  assert.equal(wavLoop.loopEndMs, 4000)

  const hca = buildSyntheticHca({
    sampleRate: 48000,
    blockCount: 200,
    encoderDelay: 128,
    encoderPadding: 64,
    loopStartBlock: 10,
    loopEndBlock: 150,
    bit7Mask: true
  })
  const hcaLoop = media.parseHcaLoop(hca)
  assert.ok(hcaLoop)
  assert.equal(hcaLoop.source, 'hca')
  assert.equal(hcaLoop.loopStartSample, 10 * 1024 - 128)
  assert.equal(hcaLoop.loopEndSample, 151 * 1024 - 128)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-loop-'))
  try {
    const audioPath = path.join(dir, 'bgm00001.wav')
    fs.writeFileSync(audioPath, wav)
    media.writeAudioLoopSidecar(audioPath, hcaLoop)
    const sidecar = media.readAudioLoopSidecar(audioPath)
    assert.deepEqual(sidecar, hcaLoop)
    assert.deepEqual(media.extractAudioLoopMetadata(audioPath), hcaLoop)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('AudioMuxer enforces ACF gains, REACT Voice/SE ducking curves, BgmVolume tween, and HCA loop wrapping', () => {
  const muxer = loadTsModule('src/renderer/src/managers/video-export/AudioMuxer.ts')

  assert.equal(muxer.ACF_GAIN_BGM, 0.75)
  assert.equal(muxer.ACF_GAIN_SE, 0.8)
  assert.equal(muxer.ACF_GAIN_VOICE, 0.9)
  assert.ok(Math.abs(muxer.MONO_PAN_GAIN - Math.SQRT1_2) < 1e-12)

  // SquareReverse(0.5): 1 - (1 - x)^1.5
  assert.equal(muxer.evaluateDuckReleaseCurve('voice', 0), 0)
  assert.ok(
    Math.abs(muxer.evaluateDuckReleaseCurve('voice', 0.5) - (1 - Math.pow(0.5, 1.5))) < 1e-6
  )
  assert.equal(muxer.evaluateDuckReleaseCurve('voice', 1), 1)
  assert.equal(muxer.evaluateDuckReleaseCurve('se', 0.5), 0.5)

  const sr = 1000
  const duck = muxer.computeBgmDuckGainBuffer(6000, sr, [
    { startSample: 1000, endSample: 2000, kind: 'voice' },
    { startSample: 1500, endSample: 2100, kind: 'se' },
    { startSample: 4000, endSample: 4500, kind: 'se' }
  ])
  assert.equal(duck[500], 1)
  assert.ok(Math.abs(duck[1200] - 0.65) < 1e-6, 'Voice ducks to 0.65')
  assert.ok(Math.abs(duck[1700] - 0.65) < 1e-6, 'Overlapping Voice+SE uses min(0.65, 0.80) = 0.65')
  assert.ok(duck[2250] > 0.65 && duck[2250] < 1, '0.5s SquareReverse release in progress')
  assert.equal(duck[3000], 1, 'Fully released after 0.5s')
  assert.ok(Math.abs(duck[4200] - 0.8) < 1e-6, 'SE ducks to 0.80')
  assert.ok(Math.abs(duck[4750] - 0.9) < 1e-6, 'SE linear release midpoint (0.8 + 0.2*0.5 = 0.9)')
  assert.equal(duck[5500], 1)

  const tween = muxer.computeBgmVolumeTweenBuffer(
    3000,
    sr,
    [{ timeMs: 1000, volume: 0.4, durationMs: 1000 }],
    1
  )
  assert.equal(tween[500], 1)
  assert.ok(Math.abs(tween[1500] - 0.7) < 1e-6)
  assert.ok(Math.abs(tween[2500] - 0.4) < 1e-6)

  // Loop wrapping: intro plays linearly to loopEnd, then wraps inside [loopStart, loopEnd)
  assert.equal(muxer.resolveLoopSampleIndex(15, 200, 50, 150), 15)
  assert.equal(muxer.resolveLoopSampleIndex(150, 200, 50, 150), 50)
  assert.equal(muxer.resolveLoopSampleIndex(265, 200, 50, 150), 65)
})

test('BgmPlan and SePlan collect BgmVolume tweens and SekaiOut / SimpleSelectable UI SE', () => {
  const exportLoggerMock = {
    ExportLogger: class {
      info() {}
      warn() {}
      error() {}
      debug() {}
    }
  }
  const mocks = new Map([
    ['ExportLogger.ts', exportLoggerMock],
    [
      'InappTextures.ts',
      {
        inappUrl: (rel) => `/resources/inapp/jp-7.0.0/${rel}`,
        loadInappTexture: () => Promise.resolve(null),
        preloadCommonInappTextures: () => Promise.resolve()
      }
    ],
    [
      'ResourceUrl.ts',
      {
        resolveBgmUrl: (f) => `/resources/audio/bgm/${f}`,
        resolveSeUrl: (f) => `/resources/audio/se/${f}`
      }
    ]
  ])

  const { BgmPlan, collectBgmVolumeSpecs, buildBgmVolumeTweens } = loadTsModule(
    'src/renderer/src/managers/video-export/BgmPlan.ts',
    mocks
  )
  const { SePlan } = loadTsModule('src/renderer/src/managers/video-export/SePlan.ts', mocks)

  const snippets = [
    {
      type: 'ChangeBgm',
      wait: false,
      delay: 0,
      data: { file: 'bgm00001.mp3', stop: false, fadeMs: 0, volume: 1 }
    },
    { type: 'BgmVolume', wait: false, delay: 0.5, data: { volume: 0.3, duration: 1000 } },
    {
      type: 'PlaySe',
      wait: false,
      delay: 0.25,
      data: { file: 'se_step.mp3', volume: 0.9, loop: false, fadeMs: 0 }
    },
    { type: 'SekaiOut', wait: true, delay: 0, data: { duration: 1200, variant: 'v2' } },
    { type: 'SimpleSelectable', wait: true, delay: 0, data: { choices: ['Yes', 'No'] } }
  ]

  const specs = collectBgmVolumeSpecs(snippets)
  assert.equal(specs.length, 1)
  const tweens = buildBgmVolumeTweens(specs, [0, 1000, 2000, 3000, 4000], false)
  assert.deepEqual(
    Array.from(tweens, (t) => ({ timeMs: t.timeMs, volume: t.volume, durationMs: t.durationMs })),
    [{ timeMs: 1500, volume: 0.3, durationMs: 1000 }]
  )

  const bgmPlan = new BgmPlan(snippets)
  assert.equal(bgmPlan.hasChanges, true)

  const sePlan = new SePlan(snippets)
  assert.equal(sePlan.hasChanges, true)
  assert.equal(sePlan.fileCount, 1)

  const delayedSnippets = [
    { type: 'SekaiOut', wait: true, delay: 0.2, data: { duration: 1200, variant: 'v2' } },
    { type: 'SimpleSelectable', wait: true, delay: 0.5, data: { choices: ['Yes', 'No'] } }
  ]
  const delayedSePlan = new SePlan(delayedSnippets)
  for (const rel of [
    'audio/MenuCommon/SE_AREA_TRANSITION_SEKAI.wav',
    'audio/MenuCommon/SE_UI_CHOICES_OPEN.wav',
    'audio/MenuCommon_Built_in/SE_DECIDE1.wav',
    'audio/MenuCommon/SE_UI_CHOICES_DECIDE.wav'
  ]) {
    delayedSePlan.uiBuffers.set(`/resources/inapp/jp-7.0.0/${rel}`, {
      channel0: new Float32Array([0.1]),
      channel1: new Float32Array([0.1])
    })
  }
  const rawCues = delayedSePlan.build([1000, 3000], false)
  assert.deepEqual(
    Array.from(rawCues, (c) => c.timeMs),
    [1200, 3500, 5000, 5000]
  )
  const preDelayedCues = delayedSePlan.build([1200, 3500], true)
  assert.deepEqual(
    Array.from(preDelayedCues, (c) => c.timeMs),
    [1200, 3500, 5000, 5000]
  )
})

test('SE semantic inference, cloud catalog SE defaults, and inapp offline fallback behave cleanly', async () => {
  const media = loadTsModule('src/host/assets/media.ts')
  const { CloudCatalogService } = loadTsModule('src/host/assets/cloudCatalog.ts')
  const { INAPP_UI_ASSET_PATHS, ensureInappUiAssets, findCloudSe, resolveInappAssetPath } =
    loadTsModule('src/host/assets/cloudAssets.ts')

  const walkInfo = media.inferSeSemanticInfo(
    'se_walk_women_001_1',
    'sound/scenario/se/se_pack00001'
  )
  assert.equal(walkInfo.category, 'footsteps')
  assert.ok(walkInfo.tags.includes('女性'))
  assert.ok(INAPP_UI_ASSET_PATHS.includes('player/loose/Sprite/bg_story_adv.png'))
  assert.ok(INAPP_UI_ASSET_PATHS.includes('audio/MenuCommon/SE_AREA_TRANSITION_SEKAI.wav'))

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msst-inapp-'))
  try {
    const legacyPath = path.join(dir, 'catalog.json')
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        format: 'msst.cloud-catalog/1',
        schemaVersion: 2,
        region: 'jp',
        generatedAt: new Date().toISOString(),
        models: [],
        backgrounds: [],
        bgm: []
      })
    )
    const noopLogger = { info() {}, warn() {}, error() {}, debug() {} }
    const service = new CloudCatalogService(
      noopLogger,
      { cacheDir: dir, timeoutMs: 200, retries: 0 },
      { cacheFile: legacyPath }
    )
    const loaded = service.loadFromCache()
    assert.ok(loaded && Array.isArray(loaded.se) && loaded.se.length === 0)

    const hit = findCloudSe(
      {
        format: 'msst.cloud-catalog/1',
        region: 'jp',
        models: [],
        backgrounds: [],
        bgm: [],
        se: [
          {
            id: 'se_door_open',
            file: 'se_door_open.mp3',
            bundle: 'sound/scenario/se/se_pack00001',
            category: 'door',
            description: '门开关音效',
            tags: ['door']
          }
        ]
      },
      '门开关'
    )
    assert.equal(hit?.id, 'se_door_open')

    // Pre-seed one cached asset, point inappBase to dead loopback for offline fallback test
    const cachedRel = 'player/loose/Sprite/bg_story_adv.png'
    const cachedFile = resolveInappAssetPath(dir, cachedRel)
    fs.mkdirSync(path.dirname(cachedFile), { recursive: true })
    fs.writeFileSync(cachedFile, Buffer.from([1, 2, 3, 4]))

    const res = await ensureInappUiAssets(
      {
        resourcesDir: dir,
        settings: { timeoutMs: 200, retries: 0 },
        logger: noopLogger
      },
      {
        inappBase: 'http://127.0.0.1:1/unreachable',
        paths: [cachedRel, 'player/loose/Texture2D/holo.png']
      }
    )
    assert.equal(res.cached, 1)
    assert.equal(res.offlineFallback, true)
    assert.deepEqual(Array.from(res.failed), ['player/loose/Texture2D/holo.png'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
