import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { Logger } from 'tslog'
import { WebSocket } from 'ws'
import { createRendererLoader } from './lib/renderer-loader.mjs'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const root = process.cwd()

const rustExporter = require(path.join(root, 'out-host/host/export/rustExporter.js'))
const { WsHub } = require(path.join(root, 'out-host/host/bridge/wsHub.js'))
const { SegmentCoordinator } = require(
  path.join(root, 'out-host/host/export/segmentCoordinator.js')
)
const { bakeStoryPlan } = require(path.join(root, 'out-host/common/export/storyPlan.js'))
const { mixBgmCueSamples } = require(path.join(root, 'out-host/common/audio/bgm.js'))
const { mixSeCueSamples } = require(path.join(root, 'out-host/common/audio/se.js'))
const ffmpeg = require(path.join(root, 'out-host/shared/ffmpeg.js'))

function makeStereoWav(sampleRate, durationSec, fn) {
  const frames = Math.round(sampleRate * durationSec)
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
  for (let i = 0; i < frames; i++) {
    const [l, r] = fn(i, frames)
    const il = Math.max(-32768, Math.min(32767, Math.round(l < 0 ? l * 32768 : l * 32767)))
    const ir = Math.max(-32768, Math.min(32767, Math.round(r < 0 ? r * 32768 : r * 32767)))
    buf.writeInt16LE(il, 44 + i * 4)
    buf.writeInt16LE(ir, 44 + i * 4 + 2)
  }
  return buf
}

function readStereoWavSamples(filePath) {
  const buf = fs.readFileSync(filePath)
  let offset = 12
  let sampleRate = 0
  let channels = 0
  let dataStart = 0
  let dataSize = 0
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(offset + 10)
      sampleRate = buf.readUInt32LE(offset + 12)
    } else if (id === 'data') {
      dataStart = offset + 8
      dataSize = size
      break
    }
    offset += 8 + size + (size % 2)
  }
  const frames = Math.floor(dataSize / (channels * 2))
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    left[i] = buf.readInt16LE(dataStart + i * channels * 2) / 32768
    right[i] = channels > 1 ? buf.readInt16LE(dataStart + (i * channels + 1) * 2) / 32768 : left[i]
  }
  return { sampleRate, channels, frames, left, right }
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

test('NAPI addon loads in-process and CLI fallback works when MSS_USE_RUST_NAPI=0', async (t) => {
  const prev = process.env.MSS_USE_RUST_NAPI
  t.after(() => {
    if (prev === undefined) delete process.env.MSS_USE_RUST_NAPI
    else process.env.MSS_USE_RUST_NAPI = prev
    rustExporter.resetRustExporterCache()
  })

  delete process.env.MSS_USE_RUST_NAPI
  rustExporter.resetRustExporterCache()
  const napiInfo = await rustExporter.getRustExporterInfo(true)
  assert.equal(napiInfo.available, true)
  assert.equal(napiInfo.mode, 'napi')
  assert.ok(napiInfo.napiPath?.endsWith('mss-export-napi.node'))

  const napiSegs = await rustExporter.planSegments(0, 1200, 4)
  assert.deepEqual(napiSegs, [
    { start: 0, end: 300 },
    { start: 300, end: 600 },
    { start: 600, end: 900 },
    { start: 900, end: 1200 }
  ])

  process.env.MSS_USE_RUST_NAPI = '0'
  rustExporter.resetRustExporterCache()
  const cliInfo = await rustExporter.getRustExporterInfo(true)
  assert.equal(cliInfo.available, true)
  assert.equal(cliInfo.mode, 'cli')
  const cliSegs = await rustExporter.planSegments(0, 1200, 4)
  assert.deepEqual(cliSegs, napiSegs)
})

test('bakeStoryPlanRust matches TS bakeStoryPlan 1:1 and identifies blackout/wait/idle static spans', async () => {
  const snippets = [
    { type: 'BlackOut', wait: true, delay: 0, data: { duration: 0.5 } },
    { type: 'Wait', wait: true, delay: 0, data: { duration: 1.0 } },
    { type: 'BlackIn', wait: true, delay: 0, data: { duration: 0.5 } },
    {
      type: 'LayoutAppear',
      wait: true,
      delay: 0,
      data: {
        modelId: 1,
        from: { side: 'Left' },
        to: { side: 'Center' },
        moveSpeed: 'Normal',
        motion: 'idle_01'
      }
    },
    {
      type: 'Talk',
      wait: true,
      delay: 0.25,
      data: {
        speaker: '初音ミク',
        content: 'こんにちは\u200B\n世界',
        modelId: 1,
        closeWindowOnFinish: true,
        actions: [{ at: 0.5, facial: 'smile' }]
      }
    },
    {
      type: 'FullScreenText',
      wait: true,
      delay: 0,
      data: { text: 'Test line' }
    }
  ]

  const tsPlan = bakeStoryPlan(snippets, [], { exportFps: 60, ttsEnabled: false })
  const rsPlan = await rustExporter.bakeStoryPlanRust({
    snippets,
    timeline: [],
    options: { exportFps: 60, ttsEnabled: false }
  })

  assert.ok(rsPlan)
  assert.equal(rsPlan.totalFrames, tsPlan.totalFrames)
  assert.equal(rsPlan.totalMs, tsPlan.totalMs)
  assert.equal(rsPlan.entries.length, tsPlan.entries.length)
  for (let i = 0; i < tsPlan.entries.length; i++) {
    assert.deepEqual(rsPlan.entries[i], tsPlan.entries[i], `entry ${i} mismatch`)
  }

  assert.ok(
    rsPlan.staticSpans.some(
      (s) => s.kind === 'blackout_covered' && s.hardStatic === true && s.endFrame > s.startFrame
    ),
    'expected hardStatic blackout_covered span during Wait between BlackOut and BlackIn'
  )
  assert.ok(
    rsPlan.staticSpans.some((s) => s.kind === 'idle_hold' && s.hardStatic === false),
    'expected idle_hold span during Talk AUTO wait'
  )

  const coord = new SegmentCoordinator(
    { info() {}, warn() {}, error() {}, debug() {} },
    {
      dispatchSubTask: async () => ({ taskId: 'x', success: true }),
      cancelSubTask: async () => {},
      readyWorkerCount: () => 1,
      onTaskComplete: () => {}
    }
  )
  const viaCoord = await coord.planStoryWithStaticSpans({
    snippets,
    timeline: [],
    options: { exportFps: 60, ttsEnabled: false }
  })
  assert.equal(viaCoord.totalFrames, tsPlan.totalFrames)
})

test('mixAudioPlan & computeLipSync achieve 1:1 parity with AudioMuxer, bgm.ts, se.ts, LipSyncEnvelope.ts, and symphonia MP3', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mss-rs-audio-parity-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const loader = createRendererLoader()
  const muxerMod = loader.load('managers/video-export/AudioMuxer.ts')
  const lipMod = loader.load('utils/LipSyncEnvelope.ts')

  const sr = 48_000
  const bgmWav = path.join(dir, 'bgm.wav')
  const seWav = path.join(dir, 'se.wav')
  const voiceWav = path.join(dir, 'voice.wav')
  const voiceMp3 = path.join(dir, 'voice.mp3')
  const outWav = path.join(dir, 'rust-mix.wav')
  const outAac = path.join(dir, 'rust-mix.m4a')

  fs.writeFileSync(
    bgmWav,
    makeStereoWav(sr, 2.0, () => [0.4, 0.4])
  )
  fs.writeFileSync(
    seWav,
    makeStereoWav(sr, 0.5, () => [0.3, 0.3])
  )
  fs.writeFileSync(
    voiceWav,
    makeStereoWav(sr, 0.8, (i) => {
      const v = Math.sin(i * 0.04) * 0.45
      return [v, v]
    })
  )

  // Transcode voice.wav -> voice.mp3 to verify symphonia MP3 decoding
  await execFileAsync(ffmpeg.ffmpegPath(), [
    '-y',
    '-loglevel',
    'error',
    '-i',
    voiceWav,
    '-c:a',
    'libmp3lame',
    '-b:a',
    '128k',
    voiceMp3
  ])

  // 1) LipSync parity: Rust computeLipSync vs TS buildLipSyncEnvelope
  const voiceDecoded = readStereoWavSamples(voiceWav)
  const tsLip = lipMod.buildLipSyncEnvelope([voiceDecoded.left, voiceDecoded.right], sr, {
    targetValueScale: 1.25
  })
  const rsLipFromFile = await rustExporter.computeLipSync({
    path: voiceWav,
    targetValueScale: 1.25
  })
  const rsLipFromPcm = await rustExporter.computeLipSync({
    pcm: voiceDecoded.left,
    sampleRate: sr,
    channels: 1,
    targetValueScale: 1.25
  })
  assert.equal(rsLipFromFile.releaseStep, tsLip.releaseStep)
  assert.equal(rsLipFromFile.values.length, tsLip.values.length)
  assert.equal(rsLipFromPcm.releaseStep, tsLip.releaseStep)
  for (let i = 0; i < tsLip.values.length; i++) {
    assert.ok(
      Math.abs(rsLipFromFile.values[i] - tsLip.values[i]) < 1e-4,
      `lipSync[${i}] rust=${rsLipFromFile.values[i]} ts=${tsLip.values[i]}`
    )
  }

  // 2) Full mix parity: Voice + SE loop+StopSe + BGM + SquareReverse(0.5) ducking + BgmVolume tween
  const durationMs = 3000
  const totalSamples = Math.ceil((durationMs / 1000) * sr)
  const bgmSamples = readStereoWavSamples(bgmWav)
  const seSamples = readStereoWavSamples(seWav)

  const jsLeft = new Float32Array(totalSamples)
  const jsRight = new Float32Array(totalSamples)
  // Voice [500ms..1300ms)
  const vStart = Math.floor(0.5 * sr)
  const vEnd = Math.min(totalSamples, vStart + voiceDecoded.frames)
  for (let i = vStart; i < vEnd; i++) {
    jsLeft[i] += voiceDecoded.left[i - vStart] * muxerMod.ACF_GAIN_VOICE
    jsRight[i] += voiceDecoded.right[i - vStart] * muxerMod.ACF_GAIN_VOICE
  }
  // SE loop at 1500ms..2300ms with StopSe 300ms fade
  mixSeCueSamples(
    [
      {
        timeMs: 1500,
        file: 'se.wav',
        stop: false,
        volume: 0.5,
        loop: true,
        fadeMs: 0,
        channel0: seSamples.left,
        channel1: seSamples.right
      },
      {
        timeMs: 2300,
        file: 'se.wav',
        stop: true,
        volume: 0,
        loop: false,
        fadeMs: 300,
        channel0: null,
        channel1: null
      }
    ],
    jsLeft,
    jsRight,
    sr,
    muxerMod.ACF_GAIN_SE
  )

  const duckGains = muxerMod.computeBgmDuckGainBuffer(totalSamples, sr, [
    { startSample: vStart, endSample: vEnd, kind: 'voice' },
    { startSample: Math.round(1.5 * sr), endSample: Math.round(2.3 * sr), kind: 'se' }
  ])
  const tweenGains = muxerMod.computeBgmVolumeTweenBuffer(
    totalSamples,
    sr,
    [{ timeMs: 1000, volume: 0.5, durationMs: 1000 }],
    1
  )
  const bgmL = new Float32Array(totalSamples)
  const bgmR = new Float32Array(totalSamples)
  mixBgmCueSamples(
    [
      {
        timeMs: 0,
        fadeMs: 0,
        stop: false,
        channel0: bgmSamples.left,
        channel1: bgmSamples.right,
        volume: 1
      }
    ],
    bgmL,
    bgmR,
    sr,
    0.8 * muxerMod.ACF_GAIN_BGM
  )
  for (let i = 0; i < totalSamples; i++) {
    const mod = duckGains[i] * tweenGains[i]
    jsLeft[i] += bgmL[i] * mod
    jsRight[i] += bgmR[i] * mod
  }

  const rsMix = await rustExporter.mixAudioPlan({
    durationMs,
    outputPath: outWav,
    bgm: {
      enabled: true,
      volume: 0.8,
      globalPath: bgmWav,
      volumeTweens: [{ timeMs: 1000, volume: 0.5, durationMs: 1000 }]
    },
    se: {
      cues: [
        {
          timeMs: 1500,
          file: 'se.wav',
          path: seWav,
          stop: false,
          volume: 0.5,
          loop: true,
          fadeMs: 0
        },
        { timeMs: 2300, file: 'se.wav', stop: true, volume: 0, loop: false, fadeMs: 300 }
      ]
    },
    voices: [
      {
        path: voiceWav,
        startMs: 500,
        snippetIndex: 0,
        computeLipSync: true,
        targetValueScale: 1.25
      }
    ]
  })

  assert.equal(rsMix.ok, true)
  assert.equal(rsMix.frames, totalSamples)
  assert.equal(rsMix.lipSyncs?.length, 1)
  assert.equal(rsMix.lipSyncs[0].releaseStep, tsLip.releaseStep)

  const rsDecoded = readStereoWavSamples(outWav)
  let maxDiff = 0
  for (let i = 0; i < totalSamples; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(rsDecoded.left[i] - jsLeft[i]))
  }
  assert.ok(maxDiff < 1e-3, `Rust vs JS mix max sample diff=${maxDiff} exceeds 16-bit tolerance`)

  // 3) Symphonia MP3 decode + direct AAC output
  const mp3Mix = await rustExporter.mixAudioPlan({
    durationMs: 1200,
    outputPath: outAac,
    outputFormat: 'aac',
    audioBitrate: '128k',
    voices: [{ path: voiceMp3, startMs: 100, computeLipSync: true }]
  })
  assert.equal(mp3Mix.ok, true)
  assert.ok((await stat(outAac)).size > 1000)
  assert.ok((mp3Mix.lipSyncs?.[0]?.values.length ?? 0) > 20)
})

test('RustFramesPipeSession supports rayon RGBA->BT.709, dedup, repeatLastFrame, and QSV low_power=1 remux', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mss-rs-pipe-dedup-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const w = 128
  const h = 128
  const redRgba = makeSolidRgbaFrame(w, h, 255, 0, 0)
  const blueRgba = makeSolidRgbaFrame(w, h, 0, 0, 255)
  const outMp4 = path.join(dir, 'rgba-dedup.mp4')

  const pipe = rustExporter.RustFramesPipeSession.create({
    fps: 60,
    width: w,
    height: h,
    crf: 27,
    encoder: 'auto',
    codec: 'hevc',
    inputFormat: 'rgba',
    dedup: true,
    lowPower: true,
    outputPath: outMp4
  })
  // Write 1 red frame + 4 duplicates + repeatLastFrame(10) + 1 blue frame + 14 repeats = 30 frames
  await pipe.write(redRgba)
  await pipe.write(redRgba, undefined, { repeatCount: 4 })
  await pipe.repeatLastFrame(10)
  await pipe.write(blueRgba)
  await pipe.repeatLastFrame(14)
  await pipe.finish()

  assert.equal(pipe.frameCount, 30)
  assert.ok((await stat(outMp4)).size > 400)

  const probe = await execFileAsync(ffmpeg.ffmpegPath(), ['-hide_banner', '-i', outMp4]).catch(
    (e) => e
  )
  assert.match(String(probe.stderr ?? ''), /hevc.*bt709/s)

  // Verify QSV low_power remux transcode on 1080p black fade clip
  const encoders = await rustExporter.probeEncoders('hevc')
  assert.ok(Array.isArray(encoders))
  const hasQsv = encoders.some((e) => e.encoder === 'hevc_qsv')
  if (hasQsv) {
    assert.equal(encoders.find((e) => e.encoder === 'hevc_qsv')?.lowPower, true)
    const srcFade = path.join(dir, 'src-fade.mp4')
    const outQsv = path.join(dir, 'out-qsv.mp4')
    await execFileAsync(ffmpeg.ffmpegPath(), [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=gray:s=256x256:r=60:d=1',
      '-vf',
      'fade=t=out:st=0.2:d=0.6,format=yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-qp',
      '0',
      srcFade
    ])
    const remuxRes = await rustExporter.runRemux({
      videoPath: srcFade,
      outputPath: outQsv,
      audioBitrate: '128k',
      frameCount: 60,
      fps: 60,
      transcode: true,
      codec: 'hevc',
      encoder: 'intel',
      quality: 27,
      lowPower: true,
      width: 256,
      height: 256
    })
    assert.equal(remuxRes.ok, true)
    assert.equal(remuxRes.encoder, 'hevc_qsv_lp')
    assert.ok(remuxRes.fileSize > 500)
  }
})

test('Rust binary WebSocket bridge streams files and video pipe frames with token auth and path containment', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mss-rs-ws-bridge-'))
  t.after(async () => {
    rustExporter.stopRustBridgeServer()
    await rm(dir, { recursive: true, force: true })
  })

  assert.throws(() => {
    rustExporter.startRustBridgeServer({
      allowedOutputDirs: [dir],
      port: 9881
    })
  }, /9881/)

  const info = rustExporter.startRustBridgeServer({
    allowedOutputDirs: [dir],
    bridgeToken: 'test-token-123'
  })
  assert.equal(info.running, true)
  assert.notEqual(info.port, 9881)
  assert.ok(info.wsUrl.includes('test-token-123'))

  // Unauthorized WS rejected
  await assert.rejects(
    new Promise((resolve, reject) => {
      const badWs = new WebSocket(`ws://127.0.0.1:${info.port}/bridge/rs-stream?token=wrong`)
      badWs.once('open', () => resolve('opened'))
      badWs.once('error', reject)
    })
  )

  const ws = new WebSocket(info.wsUrl)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  const sendControl = (obj) =>
    new Promise((resolve, reject) => {
      const onMsg = (data) => {
        ws.off('message', onMsg)
        resolve(JSON.parse(data.toString()))
      }
      ws.on('message', onMsg)
      ws.send(JSON.stringify(obj), (err) => {
        if (err) reject(err)
      })
    })

  // Path outside allowed dirs must fail
  const escapeRes = await sendControl({
    op: 'open-file',
    streamId: 99,
    path: 'C:\\Windows\\System32\\drivers\\etc\\hosts',
    truncate: false
  })
  assert.equal(escapeRes.ok, false)

  // Binary WRITE_FILE_AT streaming
  const binOut = path.join(dir, 'muxed.bin')
  const openRes = await sendControl({
    op: 'open-file',
    streamId: 1,
    path: binOut,
    truncate: true
  })
  assert.equal(openRes.ok, true)

  const makeBinFrame = (streamId, kind, flags, offsetOrCount, payload) => {
    const hdr = Buffer.alloc(16)
    hdr.writeUInt32LE(streamId, 0)
    hdr.writeUInt8(kind, 4)
    hdr.writeUInt8(flags, 5)
    hdr.writeBigUInt64LE(BigInt(offsetOrCount), 8)
    return payload ? Buffer.concat([hdr, payload]) : hdr
  }

  ws.send(makeBinFrame(1, 1, 0, 0, Buffer.from('ABCD')))
  ws.send(makeBinFrame(1, 1, 0, 4, Buffer.from('EFGH')))
  const closeFileRes = await sendControl({ op: 'close', streamId: 1 })
  assert.equal(closeFileRes.ok, true)
  assert.equal(closeFileRes.fileSize, 8)
  assert.equal(fs.readFileSync(binOut, 'utf8'), 'ABCDEFGH')

  // Binary PIPE_FRAME (kind=2) + REPEAT_FRAME (kind=3)
  const pipeOut = path.join(dir, 'ws-pipe.mp4')
  const openPipeRes = await sendControl({
    op: 'open-pipe',
    streamId: 2,
    outputPath: pipeOut,
    width: 128,
    height: 128,
    fps: 30,
    format: 'rgba',
    codec: 'h264',
    encoder: 'cpu',
    crf: 23,
    dedup: true
  })
  assert.equal(openPipeRes.ok, true)
  ws.send(makeBinFrame(2, 2, 2, 1, makeSolidRgbaFrame(128, 128, 0, 255, 0)))
  ws.send(makeBinFrame(2, 3, 0, 14, null))
  const closePipeRes = await sendControl({ op: 'close', streamId: 2 })
  assert.equal(closePipeRes.ok, true)
  assert.equal(closePipeRes.frames, 15)
  assert.equal(closePipeRes.dedupedFrames, 14)
  assert.ok((await stat(pipeOut)).size > 400)

  ws.close()
})

test('WsHub /bridge/ws-bin guards duplicate streamId, surfaces async write errors, and closes handle on mid-await disconnect', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mss-wshub-safety-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const hub = new WsHub(new Logger({ type: 'hidden' }), {
    onWorkerReady: () => {},
    onWorkerMessage: () => {},
    onWorkerDisconnected: () => {}
  })
  const server = http.createServer()
  hub.attach(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    hub.closeAll()
    server.close()
  })
  const port = server.address().port

  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge/ws-bin`)
  await once(ws, 'open')

  const sendControl = (obj) =>
    new Promise((resolve, reject) => {
      const onMsg = (data) => {
        ws.off('message', onMsg)
        resolve(JSON.parse(data.toString()))
      }
      ws.on('message', onMsg)
      ws.send(JSON.stringify(obj), (err) => {
        if (err) reject(err)
      })
    })

  const outFile = path.join(tmpdir(), `mss-wshub-${Date.now()}.bin`)
  t.after(() => rm(outFile, { force: true }).catch(() => {}))

  const ack1 = await sendControl({ op: 'open-file', streamId: 7, path: outFile, truncate: true })
  assert.equal(ack1.ok, true)

  // Duplicate streamId must fail cleanly instead of overwriting and leaking first FileHandle
  const dup = await sendControl({ op: 'open-file', streamId: 7, path: outFile, truncate: true })
  assert.equal(dup.ok, false)
  assert.match(dup.error, /Duplicate streamId/)

  const closed = await sendControl({ op: 'close', streamId: 7 })
  assert.equal(closed.ok, true)

  // Async write failure must push immediate op: 'async-error'
  const origOpen = fs.promises.open
  let midAwaitCloseCalled = false
  t.mock.method(fs.promises, 'open', async (target, flags) => {
    const targetStr = String(target)
    if (targetStr.includes('mss-wshub-async-err-')) {
      return {
        write: async () => { throw new Error('disk full EIO') },
        close: async () => {}
      }
    }
    if (targetStr.includes('mss-wshub-mid-await-close-')) {
      await new Promise((r) => setTimeout(r, 30))
      return {
        write: async () => ({ bytesWritten: 0 }),
        close: async () => { midAwaitCloseCalled = true }
      }
    }
    return origOpen.call(fs.promises, target, flags)
  })

  const errFile = path.join(tmpdir(), `mss-wshub-async-err-${Date.now()}.bin`)
  const errAck = await sendControl({ op: 'open-file', streamId: 8, path: errFile, truncate: true })
  assert.equal(errAck.ok, true)

  const asyncErrPromise = new Promise((resolve) => {
    const onMsg = (data) => {
      const parsed = JSON.parse(data.toString())
      if (parsed.op === 'async-error') {
        ws.off('message', onMsg)
        resolve(parsed)
      }
    }
    ws.on('message', onMsg)
  })
  const hdr = Buffer.alloc(16)
  hdr.writeUInt32LE(8, 0)
  hdr.writeUInt8(1, 4)
  hdr.writeBigUInt64LE(0n, 8)
  ws.send(Buffer.concat([hdr, Buffer.from('PAYLOAD')]))
  const asyncErrMsg = await asyncErrPromise
  assert.equal(asyncErrMsg.ok, false)
  assert.equal(asyncErrMsg.streamId, 8)
  assert.match(asyncErrMsg.error, /disk full EIO/)
  ws.close()

  // Mid-await WS close during open-file must close the opened FileHandle without leaking
  const ws2 = new WebSocket(`ws://127.0.0.1:${port}/bridge/ws-bin`)
  await once(ws2, 'open')
  const midFile = path.join(tmpdir(), `mss-wshub-mid-await-close-${Date.now()}.bin`)
  ws2.send(JSON.stringify({ op: 'open-file', streamId: 9, path: midFile, truncate: true }))
  await new Promise((r) => setTimeout(r, 5))
  ws2.close()
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(midAwaitCloseCalled, true, 'mid-await WS close must close opened FileHandle')
})
