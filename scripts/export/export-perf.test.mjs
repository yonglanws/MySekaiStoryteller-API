import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import FakeTimers from '@sinonjs/fake-timers'
import { createRendererLoader } from './lib/renderer-loader.mjs'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const root = process.cwd()

const rustExporter = require(path.join(root, 'out-host/host/export/rustExporter.js'))
const ffmpeg = require(path.join(root, 'out-host/shared/ffmpeg.js'))
const { writeExportDiagnostics } = require(path.join(root, 'out-host/host/exportDiagnostics.js'))

function loadConfigFromTempRepo(tempRepo) {
  const compiledConfigPath = path.join(root, 'out-host/host/config.js')
  const code = fs.readFileSync(compiledConfigPath, 'utf8')
  const mod = { exports: {} }
  const fakeDirname = path.join(tempRepo, 'out-host', 'host')
  const fakeFilename = path.join(fakeDirname, 'config.js')
  const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', code)
  fn(mod.exports, require, mod, fakeFilename, fakeDirname)
  return mod.exports
}

function makeSolidRgbaFrame(width, height, r, g, b) {
  const buf = Buffer.allocUnsafe(width * height * 4)
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = r
    buf[i + 1] = g
    buf[i + 2] = b
    buf[i + 3] = 255
  }
  return buf
}

function makeToneWavBuffer(durationSec, sampleRate = 48_000, amplitude = 0.2) {
  const frames = Math.round(durationSec * sampleRate)
  const dataBytes = frames * 4
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVEfmt ', 8, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 4, 28)
  buf.writeUInt16LE(4, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)
  const sample = Math.round(amplitude * 32767)
  for (let i = 0; i < frames * 2; i++) {
    buf.writeInt16LE(sample, 44 + i * 2)
  }
  return buf
}

test('config.ts defaults exportBitrate=5.5Mbps, maxOutputMbps=6.5, useRustExporter=true, exportJobs=1 and supports env overrides', async (t) => {
  const envKeys = [
    'MSS_EXPORT_BITRATE',
    'MSS_MAX_OUTPUT_MBPS',
    'MSS_USE_RUST_EXPORTER',
    'MSS_EXPORT_JOBS'
  ]
  const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]))
  const tempRepo = await mkdtemp(path.join(tmpdir(), 'mss-cfg-perf-'))
  t.after(async () => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    await rm(tempRepo, { recursive: true, force: true })
  })
  fs.writeFileSync(path.join(tempRepo, 'package.json'), '{"name":"test"}\n', 'utf8')
  for (const k of envKeys) delete process.env[k]

  const { loadHostConfig } = loadConfigFromTempRepo(tempRepo)
  const cfg = loadHostConfig()
  assert.equal(cfg.video.exportBitrate, 5_500_000)
  assert.equal(cfg.video.maxOutputMbps, 6.5)
  assert.equal(cfg.video.useRustExporter, true)
  assert.equal(cfg.video.exportJobs, 1)

  process.env.MSS_EXPORT_BITRATE = '2500000'
  process.env.MSS_MAX_OUTPUT_MBPS = '2.5'
  process.env.MSS_USE_RUST_EXPORTER = '0'
  process.env.MSS_EXPORT_JOBS = '4'
  const overridden = loadHostConfig()
  assert.equal(overridden.video.exportBitrate, 2_500_000)
  assert.equal(overridden.video.maxOutputMbps, 2.5)
  assert.equal(overridden.video.useRustExporter, false)
  assert.equal(overridden.video.exportJobs, 4)
})

test('FrameContentValidator fast-path exits after 1 center readPixels on lit frames and scans fallback tiles on dark-center frames', () => {
  const loader = createRendererLoader()
  const { FrameContentValidator } = loader.load('utils/FrameContentValidator.ts')
  const validator = new FrameContentValidator()

  let readCalls = 0
  const makeCanvas = (pixelAt) => ({
    width: 1920,
    height: 1080,
    getContext: () => ({
      isContextLost: () => false,
      readPixels(x, y, w, h, _fmt, _type, buf) {
        readCalls++
        for (let row = 0; row < h; row++) {
          for (let col = 0; col < w; col++) {
            const [r, g, b, a] = pixelAt(x + col, y + row)
            const idx = (row * w + col) * 4
            buf[idx] = r
            buf[idx + 1] = g
            buf[idx + 2] = b
            buf[idx + 3] = a
          }
        }
      }
    })
  })

  // Center-lit frame: single 32x32 readPixels early exit
  readCalls = 0
  const lit = validator.validateFrame(
    makeCanvas((x, y) => (x > 800 && x < 1100 && y > 400 && y < 700 ? [220, 220, 220, 255] : [0, 0, 0, 255])),
    0
  )
  assert.equal(lit.isBlackScreen, false)
  assert.equal(readCalls, 1, 'lit center tile must early-exit after 1 readPixels call')

  // Dark center, lit bottom-center subtitle area: falls back to scan remaining tiles
  readCalls = 0
  const bottomOnly = validator.validateFrame(
    makeCanvas((x, y) => (x > 800 && x < 1100 && y > 900 ? [240, 240, 240, 255] : [0, 0, 0, 255])),
    1
  )
  assert.equal(bottomOnly.isBlackScreen, false)
  assert.ok(readCalls >= 2 && readCalls <= 3, `expected early exit on 3rd tile, got ${readCalls}`)

  // Completely black frame scans all 9 tiles and flags black screen
  readCalls = 0
  const black = validator.validateFrame(makeCanvas(() => [0, 0, 0, 255]), 2)
  assert.equal(black.isBlackScreen, true)
  assert.equal(readCalls, 9)
})

test('WebCodecsMp4Encoder uses variable bitrateMode, periodic 2s keyframes, and async 3-slot PBO BT.709 I420 by default', async () => {
  const configured = []
  let yuvCreateCalls = 0
  let yuvRingSize = 0
  let videoFrameInputs = []
  const encodeCalls = []
  const pendingPbo = []

  class MockVideoFrame {
    constructor(src, init) {
      videoFrameInputs.push({ src, init })
    }
    close() {}
  }

  class MockVideoEncoder {
    static async isConfigSupported(cfg) {
      return { supported: true, config: { ...cfg } }
    }
    constructor(init) {
      this._init = init
      this.encodeQueueSize = 0
    }
    addEventListener() {}
    removeEventListener() {}
    configure(cfg) {
      configured.push(cfg)
    }
    encode(_frame, opts) {
      encodeCalls.push({ keyFrame: Boolean(opts?.keyFrame) })
    }
    async flush() {
      this._init.output(
        { type: 'key', byteLength: 8 },
        {
          decoderConfig: {
            codec: 'avc1.640028',
            colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }
          }
        }
      )
    }
    close() {}
  }

  const loader = createRendererLoader(
    new Map([
      [
        'mp4-muxer',
        {
          Muxer: class {
            addVideoChunk() {}
            finalize() {}
          },
          StreamTarget: class {}
        }
      ],
      [
        path.join(root, 'src/renderer/src/managers/video-export/GpuYuv420Converter.ts'),
        {
          GpuYuv420Converter: {
            create: (w, h, ring) => {
              yuvCreateCalls++
              yuvRingSize = ring
              const frameByteLength = (w * h * 3) / 2
              return {
                frameByteLength,
                enqueueAsync: async () => {
                  const buf = new Uint8Array(frameByteLength)
                  pendingPbo.push(buf)
                  if (pendingPbo.length > ring) return pendingPbo.shift()
                  return null
                },
                drainAllAsync: async () => pendingPbo.splice(0),
                dispose: () => {}
              }
            }
          }
        }
      ]
    ]),
    {
      VideoEncoder: MockVideoEncoder,
      VideoFrame: MockVideoFrame,
      window: { electron: { ipcRenderer: { invoke: async () => ({ success: true }) } } }
    }
  )

  const { WebCodecsMp4Encoder } = loader.load('managers/video-export/WebCodecsMp4Encoder.ts')
  const probe = await WebCodecsMp4Encoder.probeConfig({
    width: 1920,
    height: 1080,
    fps: 60,
    bitrate: 5_500_000,
    mode: 'auto',
    glRenderer: 'ANGLE (Intel Iris Xe)',
    isLinux: false,
    benchmark: false
  })
  assert.ok(probe)
  assert.equal(probe.config.bitrateMode, 'variable')

  const enc = new WebCodecsMp4Encoder({
    width: 1920,
    height: 1080,
    fps: 60,
    bitrate: 5_500_000,
    encoderConfig: probe.config
  })
  await enc.initialize('temp-pbo.mp4')
  const fakeCanvas = { width: 1920, height: 1080 }
  for (let f = 0; f < 122; f++) {
    await enc.encodeFrame(fakeCanvas, Math.round(f * 16666.67), 16667, false)
  }
  await enc.finish()

  assert.equal(yuvCreateCalls, 1, 'default WebCodecs path creates async PBO GpuYuv420Converter')
  assert.equal(yuvRingSize, 3, 'uses 3-slot PBO ring')
  assert.equal(videoFrameInputs.length, 122, 'drains all queued PBO frames cleanly on finish()')
  assert.equal(encodeCalls[0].keyFrame, true, 'frame 0 always forces keyframe')
  assert.equal(encodeCalls[1].keyFrame, false, 'intermediate frame does not force keyframe')
  assert.equal(encodeCalls[119].keyFrame, false, 'frame 119 does not force keyframe')
  assert.equal(encodeCalls[120].keyFrame, true, 'frame 120 (fps*2) forces periodic keyframe')
  assert.equal(encodeCalls[121].keyFrame, false)
  assert.equal(videoFrameInputs[0].init.format, 'I420')
  assert.equal(videoFrameInputs[0].init.colorSpace.fullRange, false)
  assert.equal(enc.requiresColorConversion, false, 'BT.709/tv I420 skips second-pass transcode')
  assert.equal(configured[0].bitrateMode, 'variable')
})

test('ConcurrentExportPipeline logs wire-level Irodori emotion, ref_wav, cfg_scale_caption, and specialScene telemetry per line', async () => {
  const loader = createRendererLoader()
  const { exportLogBus } = loader.load('managers/video-export/ExportLogBus.ts')
  exportLogBus.reset()
  const { ConcurrentExportPipeline } = loader.load('managers/video-export/ConcurrentExportPipeline.ts')

  const mockVoice = {
    refAudioPath: '/vol2/1000/Irodori-TTS/models/LoRA/PJSK/晓山瑞希/emotion_refs/main.wav',
    loraAdapter: '/vol2/1000/Irodori-TTS/models/LoRA/PJSK/晓山瑞希/lora_adapter',
    caption: '落ち着いた、穏やかな口調で話している。',
    emotions: [
      {
        emotion: '伤心',
        refAudioPath: '/vol2/1000/Irodori-TTS/models/LoRA/PJSK/晓山瑞希/emotion_refs/sad.wav',
        caption: '悲しげで、今にも泣きそうな声で話している。',
        speed: 0.94
      }
    ]
  }
  const ttsManager = {
    setCurrentTime: () => {},
    getConfig: () => ({
      provider: 'irodori',
      defaultRefAudioPath: '',
      speedFactor: 1.0,
      irodori: {
        model: 'irodori-tts',
        responseFormat: 'wav',
        numSteps: 40,
        cfgScaleText: 3.0,
        cfgScaleCaption: 3.5,
        cfgScaleSpeaker: 5.0,
        durationScale: 1.0,
        chunkingEnabled: true,
        chunkMinChars: 80,
        seed: -1,
        defaultLoraAdapter: '',
        defaultCaption: '',
        speakerKvScale: 1.15,
        speakerKvMinT: 0.9,
        timbreLockMode: 'off',
        specialSceneCfgScaleCaption: 4.2
      }
    }),
    getService: () => ({
      getCharacterVoice: (name) => (name === '瑞希' ? mockVoice : undefined)
    }),
    synthesizeWithText: async () => ({ success: true, duration: 1850 }),
    translateAndSynthesize: async () => ({ success: false, duration: 0 })
  }

  const pipeline = new ConcurrentExportPipeline({
    ttsLookahead: 2,
    ttsTimeoutMs: 5000,
    targetFps: 60,
    nowMs: () => Date.now(),
    waitMs: (ms) => new Promise((r) => setTimeout(r, ms))
  })
  pipeline.startTTSPipeline(
    [
      {
        type: 'Talk',
        delay: 0,
        data: {
          speaker: '瑞希',
          content: '……我已经受够了。',
          ttsText: '😭……もう限界だよ。',
          emotion: '伤心',
          ttsCaption: '涙をこらえながら、震える声で呟く。',
          ttsSpecialScene: true
        }
      }
    ],
    ttsManager
  )
  await pipeline.waitForTTSPipeline()

  const logs = exportLogBus.snapshot().map((e) => e.message)
  const ttsLine = logs.find((msg) => msg.includes('TTS [0] "瑞希": success'))
  assert.ok(ttsLine, `expected per-line TTS log in exportLogBus, got ${JSON.stringify(logs)}`)
  assert.match(ttsLine, /emo=伤心/)
  assert.match(ttsLine, /ref=emotion_refs\/sad\.wav/)
  assert.match(ttsLine, /cfg_cap=4\.2/)
  assert.match(ttsLine, /special=true/)
  assert.match(ttsLine, /caption="涙をこらえながら、震える声で呟く。"/)
})

test('VirtualClockController skips idle microtask spin while still firing timers on exact story frames', async (t) => {
  const updates = []
  const fakeTicker = {
    started: false,
    autoStart: false,
    lastTime: -1,
    update(now) {
      updates.push(now)
      this.lastTime = now
    },
    start() {},
    stop() {}
  }
  let loader
  loader = createRendererLoader(
    new Map([
      ['pixi.js', { Ticker: { shared: fakeTicker } }],
      [
        '@sinonjs/fake-timers',
        {
          install: (cfg) => FakeTimers.withGlobal(loader.context).install(cfg)
        }
      ]
    ]),
    { performance }
  )
  const { VirtualClockController } = loader.load('managers/video-export/VirtualClockController.ts')
  const vc = new VirtualClockController()
  t.after(() => vc.uninstall())
  vc.install()

  const t0 = vc.now()
  let firedAt = -1
  loader.context.setTimeout(() => {
    firedAt = vc.now() - t0
  }, 50)

  await vc.advanceStorySteps(6, () => false)
  assert.equal(updates.length, 6)
  assert.ok(firedAt >= 49.9 && firedAt <= 51, `expected timer at ~50ms, got ${firedAt}`)
  vc.uninstall()
})

test('exportDiagnostics report includes size, average Mbps, and realtime multiplier', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mss-diag-perf-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const videoPath = path.join(dir, 'sample.mp4')
  const written = writeExportDiagnostics(videoPath, {
    generatedAt: new Date().toISOString(),
    export: {
      mode: 'fast',
      width: 1920,
      height: 1080,
      fps: 60,
      frameCount: 18000,
      durationMs: 300_000,
      outputSize: 45 * 1024 * 1024,
      encoder: 'webcodecs-h264+mss-export-rs',
      convert: 'ffmpeg',
      color: 'bt709/tv',
      timings: { wallMs: 150_000, avgPumpFps: 120 }
    },
    summary: {
      snippets: 10,
      talks: 5,
      layoutAppears: 2,
      layoutClears: 2,
      plannedDurationMs: 300_000,
      actualDurationMs: 300_000,
      avgAbsDriftMs: 0,
      anomalies: 0,
      motionEvents: 0,
      logEntries: 0
    },
    anomalies: [],
    snippets: [],
    motions: [],
    logs: []
  })
  const report = fs.readFileSync(written.reportPath, 'utf8')
  assert.match(report, /size: 45\.00 MB \(avg 1\.26 Mbps\)/)
  assert.match(report, /perf: wall=150\.00s \(2\.00x realtime\) pumpFps=120/)
})

test('native mss-export-rs handles version, segment planning, pipe-encode, mix-wav, concat-segments, and bitrate-capped remux', async (t) => {
  rustExporter.resetRustExporterCache()
  const info = await rustExporter.getRustExporterInfo(true)
  assert.equal(info.available, true, 'mss-export-rs release binary must be built and discoverable')
  assert.ok(info.version)

  const segments = await rustExporter.planRustSegments(0, 1800, 4)
  assert.deepEqual(segments, [
    { start: 0, end: 450 },
    { start: 450, end: 900 },
    { start: 900, end: 1350 },
    { start: 1350, end: 1800 }
  ])

  const dir = await mkdtemp(path.join(tmpdir(), 'mss-rust-e2e-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  // 1) Native Rust pipe-encode with rawvideo yuv420p (BT.709/tv)
  const seg0 = path.join(dir, 'seg0.mp4')
  const seg1 = path.join(dir, 'seg1.mp4')
  const w = 128
  const h = 128
  const yuvFrame = Buffer.alloc((w * h * 3) / 2)
  yuvFrame.fill(63, 0, w * h) // BT.709 red luma
  yuvFrame.fill(102, w * h, w * h + (w * h) / 4)
  yuvFrame.fill(240, w * h + (w * h) / 4)

  for (const outSeg of [seg0, seg1]) {
    const pipe = rustExporter.RustFramesPipeSession.create({
      fps: 30,
      width: w,
      height: h,
      crf: 23,
      encoder: 'cpu',
      codec: 'h264',
      frameFormat: 'rawvideo',
      outputPath: outSeg
    })
    for (let f = 0; f < 30; f++) {
      await pipe.write(yuvFrame)
    }
    await pipe.finish()
    assert.equal(pipe.frameCount, 30)
    assert.ok((await stat(outSeg)).size > 500)
  }

  // 2) Native Rust multi-threaded WAV mixer
  const toneA = path.join(dir, 'toneA.wav')
  const mixedWav = path.join(dir, 'mixed.wav')
  fs.writeFileSync(toneA, makeToneWavBuffer(1.0))
  const mixRes = await rustExporter.runRustMixWav({
    durationMs: 2000,
    outputPath: mixedWav,
    tracks: [
      { path: toneA, startMs: 0, volume: 0.5 },
      { path: toneA, startMs: 1000, volume: 0.5 }
    ]
  })
  assert.equal(mixRes.ok, true)
  assert.equal(mixRes.frames, 96_000)

  // 3) Native Rust lossless segment concat + audio mux
  const joinedPath = path.join(dir, 'joined.mp4')
  const concatRes = await rustExporter.runRustConcatSegments({
    outputPath: joinedPath,
    fps: 30,
    codec: 'h264',
    audioPath: mixedWav,
    audioBitrate: '128k',
    segments: [
      { videoPath: seg0, frameCount: 30 },
      { videoPath: seg1, frameCount: 30 }
    ]
  })
  assert.equal(concatRes.ok, true)
  assert.equal(concatRes.segments, 2)
  assert.ok(concatRes.fileSize > 1000)

  // Verify BT.709/tv tags on output stream
  const probe = await execFileAsync(ffmpeg.ffmpegPath(), ['-hide_banner', '-i', joinedPath]).catch(
    (e) => e
  )
  assert.match(String(probe.stderr ?? ''), /yuv420p\(tv, bt709/)

  // 4) Native Rust remux with maxOutputMbps bitrate guardrail triggers automatic CRF compression
  const bloatedPath = path.join(dir, 'bloated.mp4')
  const rawRgba = path.join(dir, 'solid.rgba')
  const rgbaBuf = makeSolidRgbaFrame(w, h, 0, 255, 0)
  // Write 90 frames (3s @ 30fps) lossless so input bitrate is artificially high
  fs.writeFileSync(rawRgba, Buffer.concat(Array.from({ length: 90 }, () => rgbaBuf)))
  await execFileAsync(ffmpeg.ffmpegPath(), [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-s',
    `${w}x${h}`,
    '-r',
    '30',
    '-i',
    rawRgba,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-qp',
    '0',
    '-pix_fmt',
    'yuv420p',
    bloatedPath
  ])
  const compressedPath = path.join(dir, 'compressed.mp4')
  const remuxRes = await rustExporter.runRustRemux({
    videoPath: bloatedPath,
    outputPath: compressedPath,
    audioBitrate: '128k',
    frameCount: 90,
    fps: 30,
    transcode: false,
    codec: 'h264',
    encoder: 'cpu',
    crf: 24,
    width: w,
    height: h,
    maxOutputMbps: 0.01 // force guardrail to trigger
  })
  assert.equal(remuxRes.ok, true)
  assert.equal(remuxRes.transcoded, true, 'bitrate guardrail must trigger CRF compression')
  assert.equal(remuxRes.encoder, 'libx264')

  // 5) Bitstream-preserving copy + BT.709 VUI tagging when stream already meets maxOutputMbps
  const copyTaggedPath = path.join(dir, 'copy-tagged.mp4')
  const copyRes = await rustExporter.runRustRemux({
    videoPath: compressedPath,
    audioPath: toneA,
    outputPath: copyTaggedPath,
    audioBitrate: '128k',
    frameCount: 90,
    fps: 30,
    transcode: false,
    codec: 'h264',
    inputCodec: 'h264',
    encoder: 'cpu',
    crf: 24,
    width: w,
    height: h,
    maxOutputMbps: 10.0
  })
  assert.equal(copyRes.ok, true)
  assert.equal(copyRes.transcoded, false, 'compliant stream must use zero-reencode copy')
  assert.equal(copyRes.encoder, 'copy+bt709')
  const copyProbe = await execFileAsync(ffmpeg.ffmpegPath(), ['-hide_banner', '-i', copyTaggedPath]).catch(
    (e) => e
  )
  assert.match(String(copyProbe.stderr ?? ''), /yuv420p\(tv, bt709/)
})

test('SegmentCoordinator orchestrates single-pass prepare, Rust plan-segments, parallel segments, and concat-mix', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mss-seg-coord-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { SegmentCoordinator } = require(path.join(root, 'out-host/host/export/segmentCoordinator.js'))
  const { Logger } = require('tslog')

  // Create two tiny valid MP4 segment files + 1 WAV using Rust pipe-encode & mix-wav
  const w = 128
  const h = 128
  const yuv = Buffer.alloc((w * h * 3) / 2, 128)
  const makeSeg = async (filePath, frames) => {
    const pipe = rustExporter.RustFramesPipeSession.create({
      fps: 60,
      width: w,
      height: h,
      crf: 23,
      encoder: 'cpu',
      codec: 'h264',
      frameFormat: 'rawvideo',
      outputPath: filePath
    })
    for (let i = 0; i < frames; i++) await pipe.write(yuv)
    await pipe.finish()
  }
  const mixWav = path.join(dir, 'mix.wav')
  fs.writeFileSync(path.join(dir, 'tone.wav'), makeToneWavBuffer(1.0))
  await rustExporter.runRustMixWav({
    durationMs: 10_000,
    outputPath: mixWav,
    tracks: [{ path: path.join(dir, 'tone.wav'), startMs: 0, volume: 0.5 }]
  })

  const dispatched = []
  let finalResult = null
  let doneResolve
  const donePromise = new Promise((r) => {
    doneResolve = r
  })

  const coordinator = new SegmentCoordinator(new Logger({ type: 'hidden' }), {
    readyWorkerCount: () => 2,
    onTaskComplete: (_taskId, res) => {
      finalResult = res
      doneResolve()
    },
    cancelSubTask: async () => {},
    dispatchSubTask: async (subTask) => {
      dispatched.push(subTask)
      if (subTask.videoConfig.segmentPrepareOnly) {
        return {
          taskId: subTask.taskId,
          success: true,
          prepared: {
            totalFrames: 600,
            encodeFps: 60,
            audioFilePath: mixWav,
            ttsWavs: {},
            timings: { ttsSetupMs: 120, audioMs: 40 }
          }
        }
      }
      const seg = subTask.videoConfig.segmentRange
      await makeSeg(seg.outputPath, seg.endFrame - seg.startFrame)
      return {
        taskId: subTask.taskId,
        success: true,
        videoPath: seg.outputPath,
        frameCount: seg.endFrame - seg.startFrame,
        segmentCodec: 'h264',
        segmentConvert: 'browser',
        timings: { renderMs: 500, pumpMs: 520, tickMs: 10, snapshotMs: 10, encodeMs: 5 }
      }
    }
  })

  const snippets = Array.from({ length: 12 }, (_, idx) => ({
    type: 'Talk',
    delay: 1.0,
    data: { speaker: 'miku', content: `line ${idx} hello world`, modelId: 1 }
  }))
  const outputPath = path.join(dir, 'final-ep.mp4')
  const task = {
    taskId: 'job-1',
    story: { models: [], images: [], snippets },
    outputPath,
    addedAt: Date.now(),
    timeoutMs: 120_000,
    videoConfig: {
      width: w,
      height: h,
      fps: 60,
      fastFps: 60,
      codec: 'h264',
      audioBitrate: '128k',
      exportJobs: 2
    }
  }
  assert.equal(coordinator.shouldUseParallelSegments(task), true)
  coordinator.start(task)
  await donePromise

  assert.equal(finalResult.success, true, finalResult.error)
  assert.equal(finalResult.frameCount, 600)
  assert.ok(fs.existsSync(outputPath))
  assert.ok(finalResult.outputSize > 1000)
  assert.equal(dispatched.filter((d) => d.videoConfig.segmentPrepareOnly).length, 1)
  assert.equal(dispatched.filter((d) => d.videoConfig.segmentRange).length, 2)
})
