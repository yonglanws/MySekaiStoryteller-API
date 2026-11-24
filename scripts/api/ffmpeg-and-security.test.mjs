import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import FakeTimers from '@sinonjs/fake-timers'
import express from 'express'
import { Logger } from 'tslog'
import WebSocket from 'ws'
import { VideoApiServer } from '../../out-host/host/servers/VideoApiServer.js'
import { createBridgeRouter } from '../../out-host/host/bridge/bridgeRoutes.js'
import { WsHub } from '../../out-host/host/bridge/wsHub.js'

const require = createRequire(import.meta.url)

function loadFreshFfmpeg() {
  const resolved = require.resolve('../../out-host/shared/ffmpeg.js')
  delete require.cache[resolved]
  return require(resolved)
}

const bridgeFfmpeg = require('../../out-host/shared/ffmpeg.js')

function makeFakeChild({ code = 0, stderrText = '', onClose } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = new EventEmitter()
  child.stdin.write = (_chunk, cb) => cb?.()
  child.stdin.end = () => {}
  child.stdin.destroy = () => {}
  child.kill = () => {
    queueMicrotask(() => child.emit('close', 1, 'SIGKILL'))
  }
  queueMicrotask(() => {
    if (stderrText) child.stderr.emit('data', Buffer.from(stderrText))
    onClose?.(child)
    child.emit('close', code, null)
  })
  return child
}

function assertBt709Args(args, { scaled = null } = {}) {
  const vfIndex = args.indexOf('-vf')
  assert.ok(vfIndex >= 0, 'every frame path must carry -vf, even at identity size')
  const filter = String(args[vfIndex + 1])
  assert.match(filter, /out_color_matrix=bt709:out_range=tv/)
  assert.match(filter, /setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709/)
  if (scaled === true) assert.match(filter, /scale=\d+:\d+:flags=lanczos:/)
  if (scaled === false) assert.match(filter, /scale=flags=bicubic:/)
  for (const [key, value] of [
    ['-colorspace', 'bt709'],
    ['-color_primaries', 'bt709'],
    ['-color_trc', 'bt709'],
    ['-color_range', 'tv']
  ]) {
    const index = args.indexOf(key)
    assert.ok(index >= 0 && args[index + 1] === value, `missing ${key} ${value}`)
  }
}

function makeOpenChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = new EventEmitter()
  child.stdin.write = (_chunk, cb) => cb?.()
  child.stdin.end = () => {}
  child.stdin.destroy = () => {}
  child.kill = () => {
    queueMicrotask(() => child.emit('close', 0, 'SIGKILL'))
  }
  return child
}

test('detectAvailableGpuEncoder uses a cached 3-frame smoke probe that derives the export filters, tags and pix_fmt', async (t) => {
  const ffmpeg = loadFreshFfmpeg()
  ffmpeg.resetGpuEncoderCache()

  const spawnCalls = []
  t.mock.method(childProcess, 'spawn', (_bin, args) => {
    spawnCalls.push(args)
    const codecIdx = args.indexOf('-c:v')
    const codec = codecIdx >= 0 ? args[codecIdx + 1] : ''
    if (codec === 'hevc_nvenc') {
      return makeFakeChild({ code: 1, stderrText: 'Cannot load nvcuda.dll' })
    }
    if (codec === 'hevc_qsv' || codec === 'h264_qsv') {
      return makeFakeChild({ code: 0 })
    }
    return makeFakeChild({ code: 1 })
  })

  const first = await ffmpeg.detectAvailableGpuEncoder('hevc')
  assert.equal(first, 'intel')
  assert.equal(ffmpeg.getCachedGpuEncoder(), 'intel')
  assert.equal(spawnCalls.length, 2, 'nvidia fails then QSV succeeds')
  for (const args of spawnCalls) {
    assert.ok(!args.includes('-encoders'), 'must not use compile-time -encoders listing')
    assert.equal(args[args.indexOf('-frames:v') + 1], '3', 'probe must really encode 3 frames')
    assertBt709Args(args, { scaled: false })
    const codec = args[args.indexOf('-c:v') + 1]
    const pixFmt = args[args.indexOf('-pix_fmt') + 1]
    assert.equal(
      args[args.indexOf('-vf') + 1],
      ffmpeg.buildVideoFilterChain({
        inputWidth: 256,
        inputHeight: 256,
        outputWidth: 256,
        outputHeight: 256,
        pixFmt
      }),
      `probe filters must come from the export filter builder (${codec})`
    )
  }

  // Second call uses the codec-keyed cache without spawning
  const second = await ffmpeg.detectAvailableGpuEncoder('hevc')
  assert.equal(second, 'intel')
  assert.equal(spawnCalls.length, 2)

  // H.264 probes again with its own codec and is cached separately
  const h264 = await ffmpeg.detectAvailableGpuEncoder('h264')
  assert.equal(h264, 'intel')
  assert.equal(spawnCalls.length, 4)
  assert.equal(spawnCalls.at(-1)[spawnCalls.at(-1).indexOf('-c:v') + 1], 'h264_qsv')
  assert.equal(
    spawnCalls.at(-2)[spawnCalls.at(-2).indexOf('-c:v') + 1],
    'h264_nvenc',
    'codec-specific H.264 probe must run before falling through'
  )
})

test('detectAvailableGpuEncoder falls back to cpu when all GPU smoke probes fail', async (t) => {
  const ffmpeg = loadFreshFfmpeg()
  ffmpeg.resetGpuEncoderCache()

  t.mock.method(childProcess, 'spawn', () => makeFakeChild({ code: 1 }))
  const detected = await ffmpeg.detectAvailableGpuEncoder()
  assert.equal(detected, 'cpu')
  assert.equal(ffmpeg.getCachedGpuEncoder(), 'cpu')
})

test('QSV paths convert to BT.709 at identity size and runtime GPU failure falls back to CPU + invalidates cache', async (t) => {
  const ffmpeg = loadFreshFfmpeg()
  ffmpeg.resetGpuEncoderCache()

  const dir = await mkdtemp(path.join(tmpdir(), 'msst-ffmpeg-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const inputPath = path.join(dir, 'in.webm')
  const outputPath = path.join(dir, 'out.mp4')
  await writeFile(inputPath, Buffer.alloc(1024))

  const calls = []
  t.mock.method(childProcess, 'spawn', (_bin, args, opts) => {
    calls.push({ args, opts })
    const codecIdx = args.indexOf('-c:v')
    const codec = codecIdx >= 0 ? args[codecIdx + 1] : ''
    // Smoke probe succeeds for nvidia; runtime encode fails for nvidia and succeeds for libx265
    if (args.includes('null') && codec === 'hevc_nvenc') {
      return makeFakeChild({ code: 0 })
    }
    if (codec === 'hevc_nvenc') {
      return makeFakeChild({ code: 1, stderrText: 'nvenc runtime failure' })
    }
    return makeFakeChild({ code: 0 })
  })

  // Test QSV path directly: no hw_upload, no -init_hw_device, identity still converts to BT.709
  await ffmpeg.apiConvertVideoWithCompression(
    inputPath,
    outputPath,
    23,
    30,
    'intel',
    1280,
    720,
    1280,
    720,
    8_000_000,
    'h264'
  )
  const qsvCall = calls.at(-1)
  assert.equal(qsvCall.opts.windowsHide, true)
  assert.ok(!qsvCall.args.includes('-init_hw_device'))
  assert.ok(!qsvCall.args.some((a) => String(a).includes('hw_upload')))
  assertBt709Args(qsvCall.args, { scaled: false })
  assert.equal(qsvCall.args[qsvCall.args.indexOf('-pix_fmt') + 1], 'nv12')

  // Test runtime fallback from auto->nvidia->libx265 and cache invalidation
  calls.length = 0
  await ffmpeg.apiConvertVideoWithCompression(
    inputPath,
    outputPath,
    23,
    30,
    'auto',
    1280,
    720,
    1280,
    720
  )
  assert.equal(ffmpeg.getCachedGpuEncoder(), null, 'failed GPU encoder cache must be invalidated')
  const usedCodecs = calls.map((c) => c.args[c.args.indexOf('-c:v') + 1])
  assert.ok(usedCodecs.includes('hevc_nvenc'))
  assert.ok(usedCodecs.includes('libx265'))
  for (const call of calls.filter((c) => !c.args.includes('null'))) {
    assertBt709Args(call.args, { scaled: false })
  }
})

test('encodeFramesToVideo keeps BT.709 at identity size, returns the frame count, and falls back to libx264 with aq-mode intact', async (t) => {
  const ffmpeg = loadFreshFfmpeg()
  ffmpeg.resetGpuEncoderCache()

  const dir = await mkdtemp(path.join(tmpdir(), 'msst-frames-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (let i = 0; i < 6; i++) {
    await writeFile(path.join(dir, `frame-${String(i).padStart(6, '0')}.jpg`), 'jpg')
  }
  const outputPath = path.join(dir, 'out.mp4')

  const calls = []
  t.mock.method(childProcess, 'spawn', (_bin, args, opts) => {
    calls.push({ args, opts })
    const codec = args[args.indexOf('-c:v') + 1]
    if (codec === 'h264_qsv') {
      return makeFakeChild({ code: 1, stderrText: 'qsv runtime failure' })
    }
    return makeFakeChild({ code: 0 })
  })

  const frames = await ffmpeg.encodeFramesToVideo(
    30,
    dir,
    outputPath,
    'intel',
    1280,
    720,
    23,
    1280,
    720,
    'h264'
  )
  assert.equal(frames, 6)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].args[calls[0].args.indexOf('-c:v') + 1], 'h264_qsv')
  assert.ok(!calls[0].args.some((a) => String(a).includes('hw_upload')))
  assertBt709Args(calls[0].args, { scaled: false })
  assert.equal(calls[1].args[calls[1].args.indexOf('-c:v') + 1], 'libx264')
  const x264 = calls[1].args.indexOf('-x264-params')
  assert.ok(x264 > 0, 'x264 params must be present')
  assert.match(String(calls[1].args[x264 + 1]), /aq-mode=3/)
  assert.match(String(calls[1].args[x264 + 1]), /deblock=2,2/)
  assert.match(String(calls[1].args[x264 + 1]), /rc-lookahead=20/)
  assert.equal(calls[1].args[calls[1].args.indexOf('-threads') + 1], '4')
})

test('BT.709 filters and four colour tags appear on all four frame output paths', async (t) => {
  const ffmpeg = loadFreshFfmpeg()
  ffmpeg.resetGpuEncoderCache()

  const dir = await mkdtemp(path.join(tmpdir(), 'msst-bt709-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const inputPath = path.join(dir, 'in.webm')
  const audioPath = path.join(dir, 'audio.wav')
  await writeFile(inputPath, Buffer.alloc(2048))
  await writeFile(audioPath, 'RIFF')
  for (let i = 0; i < 3; i++) {
    await writeFile(path.join(dir, `frame-${String(i).padStart(6, '0')}.jpg`), 'jpg')
  }

  const calls = []
  t.mock.method(childProcess, 'spawn', (_bin, args, opts) => {
    calls.push({ args, opts })
    return makeFakeChild({ code: 0 })
  })

  // 1. transcode (identity -> bicubic conversion; scaled -> Lanczos)
  await ffmpeg.apiConvertVideoWithCompression(
    inputPath,
    path.join(dir, 'convert.mp4'),
    18,
    30,
    'cpu',
    1920,
    1080,
    1920,
    1080,
    8_000_000,
    'h264'
  )
  assertBt709Args(calls.at(-1).args, { scaled: false })

  await ffmpeg.apiConvertVideoWithCompression(
    inputPath,
    path.join(dir, 'convert-scaled.mp4'),
    18,
    30,
    'cpu',
    1920,
    1080,
    1280,
    720,
    8_000_000,
    'h264'
  )
  assertBt709Args(calls.at(-1).args, { scaled: true })

  // 2. merge with audio: -t frames/fps instead of -shortest, AAC 192k
  await ffmpeg.apiMergeVideoAudioWithCompression(
    inputPath,
    audioPath,
    path.join(dir, 'merge.mp4'),
    18,
    '192k',
    30,
    'cpu',
    1920,
    1080,
    1920,
    1080,
    8_000_000,
    'h264',
    300
  )
  const mergeArgs = calls.at(-1).args
  assertBt709Args(mergeArgs, { scaled: false })
  assert.equal(mergeArgs.includes('-shortest'), false, '-shortest must be replaced by -t')
  assert.equal(mergeArgs[mergeArgs.indexOf('-t') + 1], '10.000000')
  assert.equal(mergeArgs[mergeArgs.indexOf('-b:a') + 1], '192k')

  // 3. frame sequence
  await ffmpeg.encodeFramesToVideo(
    30,
    dir,
    path.join(dir, 'frames.mp4'),
    'cpu',
    1920,
    1080,
    18,
    1920,
    1080,
    'h264'
  )
  assertBt709Args(calls.at(-1).args, { scaled: false })

  // 4. image2pipe / rawvideo session
  const session = await ffmpeg.createFramesPipeSession({
    fps: 30,
    width: 1920,
    height: 1080,
    encoder: 'cpu',
    codec: 'h264',
    outputPath: path.join(dir, 'pipe.mp4')
  })
  assertBt709Args(calls.at(-1).args, { scaled: false })
  await session.abort()
})

test('rawvideo yuv420p pipe carries BT.709 tags on the input and only tags the encoded frames', async (t) => {
  const ffmpeg = loadFreshFfmpeg()
  ffmpeg.resetGpuEncoderCache()

  const dir = await mkdtemp(path.join(tmpdir(), 'msst-raw-pipe-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const calls = []
  t.mock.method(childProcess, 'spawn', (_bin, args, opts) => {
    calls.push({ args, opts })
    return makeOpenChild()
  })

  const session = await ffmpeg.createFramesPipeSession({
    fps: 30,
    width: 640,
    height: 360,
    encoder: 'cpu',
    codec: 'h264',
    frameFormat: 'rawvideo',
    outputPath: path.join(dir, 'raw.mp4')
  })
  const args = calls.at(-1).args
  assert.deepEqual(args.slice(args.indexOf('-f'), args.indexOf('-f') + 3), [
    '-f',
    'rawvideo',
    '-pix_fmt'
  ])
  assert.equal(args[args.indexOf('-s') + 1], '640x360')
  const filter = args[args.indexOf('-vf') + 1]
  assert.equal(filter.includes('scale='), false, 'GPU frames must not be scaled again')
  assert.match(filter, /setparams=range=tv:colorspace=bt709/)
  assert.equal(args[args.indexOf('-pix_fmt', args.indexOf('-vf')) + 1], 'yuv420p')
  const inputTagIndex = args.indexOf('-colorspace')
  assert.ok(
    inputTagIndex > 0 && inputTagIndex < args.indexOf('-i'),
    'the piped 4:2:0 frames are declared as BT.709 before the input'
  )

  const frameBytes = (640 * 360 * 3) / 2
  await session.write(Buffer.alloc(frameBytes))
  assert.equal(session.frameCount, 1)
  await assert.rejects(session.write(Buffer.alloc(100)), /not a multiple/)
  await session.abort()
})

test('codec matrix: HEVC default with hvc1 and x264 threads/lookahead without losing aq-mode', () => {
  const ffmpeg = loadFreshFfmpeg()
  const codecNames = {
    hevc: { nvidia: 'hevc_nvenc', amd: 'hevc_amf', intel: 'hevc_qsv', cpu: 'libx265' },
    h264: { nvidia: 'h264_nvenc', amd: 'h264_amf', intel: 'h264_qsv', cpu: 'libx264' }
  }
  for (const codec of ['hevc', 'h264']) {
    for (const backend of ['nvidia', 'amd', 'intel', 'cpu']) {
      const selection = ffmpeg.getGpuEncoderArgs(backend, 18, codec)
      assert.equal(selection.codec, codecNames[codec][backend], `${codec}/${backend}`)
      const argv = ffmpeg.videoEncoderOutputArgs(
        selection,
        ffmpeg.buildVideoFilterChain({
          inputWidth: 1920,
          inputHeight: 1080,
          outputWidth: 1920,
          outputHeight: 1080,
          pixFmt: selection.pixFmt
        })
      )
      assert.equal(argv[0], '-vf')
      assert.equal(argv[argv.indexOf('-pix_fmt') + 1], selection.pixFmt)
      for (const [key, value] of [
        ['-colorspace', 'bt709'],
        ['-color_primaries', 'bt709'],
        ['-color_trc', 'bt709'],
        ['-color_range', 'tv']
      ]) {
        assert.equal(argv[argv.indexOf(key) + 1], value, `${codec}/${backend} ${key}`)
      }
      if (codec === 'hevc') {
        assert.ok(selection.args.includes('hvc1'), `${backend} HEVC must be tagged hvc1`)
      } else {
        assert.equal(selection.args.includes('hvc1'), false)
      }
      if (backend === 'cpu') {
        assert.equal(selection.preset, 'medium')
        if (codec === 'hevc') {
          assert.ok(selection.args.includes('-x265-params'))
          assert.equal(selection.args[selection.args.indexOf('-crf') + 1], '18')
        } else {
          const params = selection.args[selection.args.indexOf('-x264-params') + 1]
          assert.match(params, /aq-mode=3/)
          assert.match(params, /deblock=2,2/)
          assert.match(params, /rc-lookahead=20/)
          assert.equal(selection.args[selection.args.indexOf('-threads') + 1], '4')
        }
      }
    }
  }
})

test('software encoder choice follows codec, while legacy libx264 still forces H.264', async () => {
  const ffmpeg = loadFreshFfmpeg()
  assert.equal((await ffmpeg.resolveVideoEncoderArgs('cpu', 18, 'hevc')).codec, 'libx265')
  assert.equal((await ffmpeg.resolveVideoEncoderArgs('cpu', 18, 'h264')).codec, 'libx264')
  assert.equal((await ffmpeg.resolveVideoEncoderArgs('libx264', 18, 'hevc')).codec, 'libx264')
})

test('mux uses -t frames/fps, AAC 192k by default, and offsets the mix to the first video frame', async (t) => {
  const ffmpeg = loadFreshFfmpeg()
  const dir = await mkdtemp(path.join(tmpdir(), 'msst-mux-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const videoPath = path.join(dir, 'video.mp4')
  const audioPath = path.join(dir, 'audio.wav')
  await writeFile(videoPath, Buffer.alloc(4096))
  await writeFile(audioPath, 'RIFF')

  const calls = []
  t.mock.method(childProcess, 'spawn', (_bin, args, opts) => {
    calls.push({ args, opts })
    return makeFakeChild({ code: 0 })
  })

  await ffmpeg.apiMuxVideoAudioCopy(videoPath, audioPath, path.join(dir, 'out.mp4'), '192k', {
    frameCount: 18_000,
    fps: 30
  })
  const args = calls.at(-1).args
  assert.equal(args.includes('-shortest'), false)
  assert.equal(args[args.indexOf('-t') + 1], '600.000000')
  assert.equal(args[args.indexOf('-b:a') + 1], '192k')
  assert.equal(args.includes('-ss'), false, 'no offset when the video starts at frame 0')

  await ffmpeg.apiMuxVideoAudioCopy(
    videoPath,
    audioPath,
    path.join(dir, 'out-offset.mp4'),
    '192k',
    { frameCount: 18_000, fps: 30, startFrame: 900 }
  )
  const offsetArgs = calls.at(-1).args
  const ssIndex = offsetArgs.indexOf('-ss')
  assert.ok(ssIndex > 0, 'resumed exports must seek the mix')
  assert.equal(offsetArgs[ssIndex + 1], '30.000000')
  assert.ok(ssIndex < offsetArgs.lastIndexOf('-i'), '-ss must apply to the audio input')
})

test('export preflight rejects odd encode sizes and empty frame ranges before model/TTS work', async (t) => {
  const ffmpeg = loadFreshFfmpeg()
  assert.throws(() => ffmpeg.checkEncodeSize(1921, 1081), /even width and height/)
  assert.throws(() => ffmpeg.checkFrameRange(120, 120), /from must be less than to/)
  assert.throws(() => ffmpeg.checkFrameRange(121, 120), /from must be less than to/)
  assert.doesNotThrow(() => ffmpeg.checkEncodeSize(1920, 1080))
  assert.doesNotThrow(() => ffmpeg.checkFrameRange(0, 1))

  const outputDir = await mkdtemp(path.join(tmpdir(), 'msst-preflight-test-'))
  let prepared = 0
  let dispatched = 0
  let spawnCalls = 0
  t.mock.method(childProcess, 'spawn', () => {
    spawnCalls++
    return makeOpenChild()
  })
  const api = new VideoApiServer(new Logger({ type: 'hidden' }), {
    port: 0,
    host: '127.0.0.1',
    outputDir,
    video: {
      width: 1921,
      height: 1081,
      fps: 30,
      crf: 23,
      renderScale: 1,
      codec: 'hevc',
      audioBitrate: '192k',
      encoder: 'auto',
      watermark: false,
      exportMode: 'fast',
      exportBitrate: 12_000_000,
      exportFastEncoder: 'frames',
      fastFps: 30,
      idleChainGapSec: 0,
      ttsMode: 'serial'
    },
    prepareStory: async () => {
      prepared++
    }
  })
  api.setDispatcher({
    dispatch: () => {
      dispatched++
    },
    cancel: () => {}
  })
  await api.start()
  const server = api.getHttpServer()
  const port = server.address().port
  t.after(async () => {
    const closed = once(server, 'close')
    api.stop()
    server.closeAllConnections()
    await closed
    await rm(outputDir, { recursive: true, force: true })
  })

  const startedAt = Date.now()
  const res = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/v1/export', method: 'POST' },
      (response) => {
        const chunks = []
        response.on('data', (c) => chunks.push(c))
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString('utf8')
          })
        )
      }
    )
    req.on('error', reject)
    req.end(JSON.stringify({ story: { models: [], images: [], snippets: [] } }))
  })
  const elapsedMs = Date.now() - startedAt
  assert.equal(res.status, 400)
  assert.match(JSON.parse(res.body).message, /even width and height/)
  assert.ok(elapsedMs < 100, `odd-size request must fail fast (took ${elapsedMs}ms)`)
  assert.equal(prepared, 0, 'story preparation (resource/TTS preflight) must not run')
  assert.equal(dispatched, 0, 'no render task may be queued')
  assert.equal(spawnCalls, 0, 'a rejected request must not spawn ffmpeg')
})

test('VideoApiServer hardens /api/v1/download and protects active multi-dot sidecars from cleanup', async (t) => {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'msst-download-test-'))
  const api = new VideoApiServer(new Logger({ type: 'hidden' }), {
    port: 0,
    host: '127.0.0.1',
    outputDir,
    video: { width: 1280, height: 720, fps: 30 }
  })
  await api.start()
  const server = api.getHttpServer()
  const port = server.address().port
  t.after(async () => {
    const closed = once(server, 'close')
    api.stop()
    server.closeAllConnections()
    await closed
    await rm(outputDir, { recursive: true, force: true })
  })

  await writeFile(path.join(outputDir, 'sample.mp4'), 'mp4-data')
  await writeFile(path.join(outputDir, 'sample.log.json'), '{"ok":true}')
  await writeFile(path.join(outputDir, 'sample.txt'), 'hello')

  const get = (reqPath) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: reqPath, method: 'GET' }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8')
          })
        )
      })
      req.on('error', reject)
      req.end()
    })

  // Traversal & backslash rejections
  for (const bad of ['..%2Fsecret.txt', 'sub%5Cfile.mp4', '%5Cwindows.mp4', 'a%2Fb.mp4']) {
    const res = await get(`/api/v1/download/${bad}`)
    assert.equal(res.status, 400, `expected 400 for ${bad}`)
  }

  // 404 omits path leak
  const missing = await get('/api/v1/download/does-not-exist.mp4')
  assert.equal(missing.status, 404)
  const missingJson = JSON.parse(missing.body)
  assert.equal(missingJson.error, 'File not found')
  assert.equal('path' in missingJson, false)

  // Content-Type derived from extension
  const mp4Res = await get('/api/v1/download/sample.mp4')
  assert.equal(mp4Res.status, 200)
  assert.match(mp4Res.headers['content-type'], /^video\/mp4/)

  const jsonRes = await get('/api/v1/download/sample.log.json')
  assert.equal(jsonRes.status, 200)
  assert.match(jsonRes.headers['content-type'], /^application\/json/)

  const txtRes = await get('/api/v1/download/sample.txt')
  assert.equal(txtRes.status, 200)
  assert.match(txtRes.headers['content-type'], /^text\/plain/)

  // cleanupOldExports preserves active multi-dot sidecars (.log.json)
  const activeId = 'export-active-1'
  const activeSidecar = path.join(outputDir, `${activeId}.log.json`)
  const staleSidecar = path.join(outputDir, 'export-stale-2.log.json')
  await writeFile(activeSidecar, '{}')
  await writeFile(staleSidecar, '{}')
  const ancient = new Date(Date.now() - 48 * 60 * 60 * 1000)
  await utimes(activeSidecar, ancient, ancient)
  await utimes(staleSidecar, ancient, ancient)
  api.activeExports.add(activeId)

  const cleanupRes = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/v1/cleanup', method: 'POST' },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      }
    )
    req.on('error', reject)
    req.end()
  })
  assert.equal(cleanupRes, 200)
  await stat(activeSidecar)
  await assert.rejects(stat(staleSidecar), { code: 'ENOENT' })
})

test('/bridge enforces session token, same-origin, path containment, proxy allowlists, and cleans intermediate MP4', async (t) => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'msst-bridge-sec-'))
  const outputDir = path.join(workDir, 'out')
  const outsideDir = path.join(process.cwd(), 'tmp-bridge-sec-check')
  const bridgeToken = 'test-bridge-secret-token-123456'

  const upstreamRequests = []
  const ttsServer = http.createServer((req, res) => {
    upstreamRequests.push({ server: 'tts', url: req.url, method: req.method })
    res.writeHead(200, { 'content-type': 'audio/wav' })
    res.end('RIFF')
  })
  const llmServer = http.createServer((req, res) => {
    upstreamRequests.push({ server: 'llm', url: req.url, method: req.method })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"choices":[]}')
  })
  await Promise.all([
    new Promise((r) => ttsServer.listen(0, '127.0.0.1', r)),
    new Promise((r) => llmServer.listen(0, '127.0.0.1', r))
  ])
  const ttsPort = ttsServer.address().port
  const llmPort = llmServer.address().port

  const config = {
    paths: { output: outputDir },
    video: { width: 1280, height: 720, fps: 30, crf: 23, encoder: 'cpu', recordTargetSizeMb: 0 },
    render: { workers: 1 },
    tts: { apiBaseUrl: `http://127.0.0.1:${ttsPort}`, timeoutMs: 5000 },
    llm: { enabled: true, baseUrl: `http://127.0.0.1:${llmPort}/v1`, timeoutMs: 5000 }
  }

  const app = express()
  app.use(
    '/bridge',
    createBridgeRouter({
      logger: new Logger({ type: 'hidden' }),
      config,
      bridgeToken
    })
  )
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const hub = new WsHub(
    new Logger({ type: 'hidden' }),
    {
      onWorkerReady: () => {},
      onWorkerMessage: () => {},
      onWorkerDisconnected: () => {}
    },
    bridgeToken
  )
  hub.attach(server)

  t.after(async () => {
    hub.closeAll()
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
    await Promise.all([
      new Promise((r) => ttsServer.close(r)),
      new Promise((r) => llmServer.close(r))
    ])
    await rm(workDir, { recursive: true, force: true })
  })

  const post = (reqPath, body, extraHeaders = {}) =>
    new Promise((resolve, reject) => {
      const payload = Buffer.isBuffer(body) ? body : JSON.stringify(body)
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: reqPath,
          method: 'POST',
          headers: {
            'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
            ...extraHeaders
          }
        },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8')
            })
          )
        }
      )
      req.on('error', reject)
      req.end(payload)
    })

  // 1. Token auth
  const unauth = await post('/bridge/invoke/electron:get-temp-base-dir', [])
  assert.equal(unauth.status, 401)
  assert.equal(unauth.headers['access-control-allow-origin'], undefined)

  const wrongTok = await post('/bridge/invoke/electron:get-temp-base-dir', [], {
    'x-mss-bridge-token': 'wrong-token'
  })
  assert.equal(wrongTok.status, 401)

  // 2. Cross-origin rejection
  const crossOrigin = await post('/bridge/invoke/electron:get-temp-base-dir', [], {
    'x-mss-bridge-token': bridgeToken,
    Origin: 'https://evil.example'
  })
  assert.equal(crossOrigin.status, 403)

  // 3. Valid token succeeds
  const okRes = await post('/bridge/invoke/electron:get-temp-base-dir', [], {
    'x-mss-bridge-token': bridgeToken
  })
  assert.equal(okRes.status, 200)
  const tempBase = JSON.parse(okRes.body).result
  await rm(tempBase, { recursive: true, force: true })

  // 4. WebSocket token auth
  await assert.rejects(
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge/ws?worker=w1`)
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
  )
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge/ws?worker=w1&token=${bridgeToken}`)
    ws.once('open', () => {
      ws.close()
      resolve()
    })
    ws.once('error', reject)
  })

  // 5. Path containment
  const escapeDelete = await post(
    '/bridge/invoke/electron:delete-temp-file',
    [{ filePath: path.join(outsideDir, 'target.txt') }],
    { 'x-mss-bridge-token': bridgeToken }
  )
  assert.equal(escapeDelete.status, 403)

  const escapeTempRoot = await post(
    '/bridge/invoke/electron:delete-temp-file',
    [{ filePath: tmpdir() }],
    { 'x-mss-bridge-token': bridgeToken }
  )
  assert.equal(escapeTempRoot.status, 403)

  const escapeWriteFrame = await post(
    `/bridge/bin/electron:write-frame?args=${encodeURIComponent(JSON.stringify([{ path: path.join(outsideDir, 'evil.jpg') }]))}`,
    Buffer.from('abc'),
    { 'x-mss-bridge-token': bridgeToken }
  )
  assert.equal(escapeWriteFrame.status, 403)

  // 6. Proxy URL allowlisting
  const blockedTts = await post(
    '/bridge/proxy/tts-fetch',
    { url: 'http://169.254.169.254/latest/meta-data/', method: 'GET', headers: {}, body: '' },
    { 'x-mss-bridge-token': bridgeToken }
  )
  assert.equal(blockedTts.status, 403)

  const allowedTts = await post(
    '/bridge/proxy/tts-fetch',
    { url: `http://127.0.0.1:${ttsPort}/tts`, method: 'GET', headers: {}, body: '' },
    { 'x-mss-bridge-token': bridgeToken }
  )
  assert.equal(allowedTts.status, 200)
  assert.equal(allowedTts.body, 'RIFF')

  const blockedLlm = await post(
    '/bridge/proxy/translation-fetch',
    { url: 'http://127.0.0.1:9999/internal', method: 'POST', headers: {}, body: '{}' },
    { 'x-mss-bridge-token': bridgeToken }
  )
  assert.equal(blockedLlm.status, 403)

  const allowedLlm = await post(
    '/bridge/proxy/translation-fetch',
    {
      url: `http://127.0.0.1:${llmPort}/v1/chat/completions`,
      method: 'POST',
      headers: {},
      body: '{}'
    },
    { 'x-mss-bridge-token': bridgeToken }
  )
  assert.equal(allowedLlm.status, 200)
  assert.equal(allowedLlm.body, '{"choices":[]}')
  assert.equal(upstreamRequests.length, 2)

  // 7. Intermediate MP4 cleanup on encode-frames-video failure
  const framesDir = path.join(workDir, 'frames')
  const audioPath = path.join(workDir, 'audio.wav')
  const finalOutputPath = path.join(outputDir, 'final.mp4')
  await fs.promises.mkdir(framesDir, { recursive: true })
  await writeFile(audioPath, 'wav')
  t.mock.method(bridgeFfmpeg, 'encodeFramesToVideo', async (_fps, _dir, outPath) => {
    await writeFile(outPath, 'intermediate-mp4')
  })
  t.mock.method(bridgeFfmpeg, 'apiMuxVideoAudioCopy', async () => {
    throw new Error('mux exploded')
  })
  const framesRes = await post(
    '/bridge/invoke/electron:api-encode-frames-video',
    [
      {
        framesDir,
        audioPath,
        outputPath: finalOutputPath,
        fps: 30,
        audioBitrate: '128k'
      }
    ],
    { 'x-mss-bridge-token': bridgeToken }
  )
  assert.equal(framesRes.status, 200)
  assert.equal(JSON.parse(framesRes.body).result.success, false)
  const remaining = await readdir(outputDir)
  assert.deepEqual(remaining, [], 'intermediate .mss-frames-video-*.mp4 must be cleaned up')
})

test('bridge encodes to <name>.partial.mp4 and renames only after ffmpeg succeeds', async (t) => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'msst-atomic-export-'))
  const outputDir = path.join(workDir, 'out')
  const framesDir = path.join(workDir, 'frames')
  await fs.promises.mkdir(framesDir, { recursive: true })
  await fs.promises.mkdir(outputDir, { recursive: true })

  const app = express()
  app.use(
    '/bridge',
    createBridgeRouter({
      logger: new Logger({ type: 'hidden' }),
      config: {
        paths: { output: outputDir },
        video: { width: 1280, height: 720, fps: 30, crf: 23, encoder: 'cpu', codec: 'hevc' },
        render: { workers: 1 },
        tts: { apiBaseUrl: 'http://127.0.0.1:9880', timeoutMs: 5000 },
        llm: { enabled: false }
      },
      bridgeToken: 'tok'
    })
  )
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  t.after(async () => {
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
    await rm(workDir, { recursive: true, force: true })
  })

  const post = (body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/bridge/invoke/electron:api-encode-frames-video',
          method: 'POST',
          headers: { 'x-mss-bridge-token': 'tok', 'content-type': 'application/json' }
        },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () =>
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) })
          )
        }
      )
      req.on('error', reject)
      req.end(JSON.stringify([body]))
    })

  const finalPath = path.join(outputDir, 'final.mp4')
  const partialPath = path.join(outputDir, 'final.partial.mp4')
  const encodedPaths = []
  let writeOutput = async (outPath) => {
    await writeFile(outPath, 'encoded-mp4')
    return 3
  }
  t.mock.method(bridgeFfmpeg, 'encodeFramesToVideo', async (_fps, _dir, outPath) => {
    encodedPaths.push(outPath)
    return writeOutput(outPath)
  })

  const ok = await post({
    framesDir,
    outputPath: finalPath,
    fps: 30,
    audioBitrate: '192k'
  })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.result.success, true)
  assert.deepEqual(encodedPaths, [partialPath], 'ffmpeg must write the partial file only')
  assert.equal(await readFile(finalPath, 'utf8'), 'encoded-mp4')
  await assert.rejects(stat(partialPath), { code: 'ENOENT' })
  assert.deepEqual(
    (await readdir(outputDir)).filter((name) => name.includes('.partial')),
    []
  )

  // Failure: the target name never appears and the partial file is removed
  await rm(finalPath, { force: true })
  writeOutput = async (outPath) => {
    await writeFile(outPath, 'half-written')
    throw new Error('ffmpeg exited with code 1')
  }
  const failed = await post({
    framesDir,
    outputPath: finalPath,
    fps: 30,
    audioBitrate: '192k'
  })
  assert.equal(failed.body.result.success, false)
  await assert.rejects(stat(finalPath), { code: 'ENOENT' })
  await assert.rejects(stat(partialPath), { code: 'ENOENT' })
  assert.deepEqual(await readdir(outputDir), [])
})

test('remux reuses the image2pipe frame count and fps to truncate the mix exactly', async (t) => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'msst-pipe-remux-'))
  const outputDir = path.join(workDir, 'out')
  const audioPath = path.join(workDir, 'audio.wav')
  await fs.promises.mkdir(outputDir, { recursive: true })
  await writeFile(audioPath, 'RIFF')

  const pipeSessions = []
  const app = express()
  app.use(
    '/bridge',
    createBridgeRouter({
      logger: new Logger({ type: 'hidden' }),
      config: {
        paths: { output: outputDir },
        video: { width: 1280, height: 720, fps: 30, crf: 18, encoder: 'cpu', codec: 'hevc' },
        render: { workers: 1 },
        tts: { apiBaseUrl: 'http://127.0.0.1:9880', timeoutMs: 5000 },
        llm: { enabled: false }
      },
      bridgeToken: 'tok',
      createFramesPipe: async (options) => {
        const session = {
          outputPath: options.outputPath,
          frameCount: 90,
          async write() {},
          async finish() {
            await writeFile(options.outputPath, 'encoded-video')
            return options.outputPath
          },
          async abort() {}
        }
        pipeSessions.push(session)
        return session
      }
    })
  )
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  t.after(async () => {
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
    await rm(workDir, { recursive: true, force: true })
  })

  const invoke = (channel, body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: `/bridge/invoke/${channel}`,
          method: 'POST',
          headers: { 'x-mss-bridge-token': 'tok', 'content-type': 'application/json' }
        },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () =>
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) })
          )
        }
      )
      req.on('error', reject)
      req.end(JSON.stringify(body))
    })

  const started = await invoke('electron:frames-stream-start', [{ fps: 30 }])
  assert.equal(started.status, 200)
  const finished = await invoke('electron:frames-stream-finish', [{ id: started.body.result.id }])
  assert.equal(finished.status, 200)
  const videoPath = finished.body.result.videoPath

  let muxOptions = null
  t.mock.method(
    bridgeFfmpeg,
    'apiMuxVideoAudioCopy',
    async (_v, _a, outPath, _bitrate, options) => {
      muxOptions = options
      await writeFile(outPath, 'remuxed-video')
    }
  )

  const outputPath = path.join(outputDir, 'final.mp4')
  const remuxed = await invoke('electron:api-remux-video-from-files', [
    { videoPath, audioPath, outputPath, audioBitrate: '192k' }
  ])
  assert.equal(remuxed.status, 200)
  assert.equal(remuxed.body.result.success, true)
  assert.deepEqual(muxOptions, { frameCount: 90, fps: 30, startFrame: undefined })
  assert.equal(await readFile(outputPath, 'utf8'), 'remuxed-video')
  assert.deepEqual(
    (await readdir(outputDir)).filter((name) => name.includes('.partial')),
    []
  )
  assert.equal(pipeSessions.length, 1)

  // 帧数变化后重导到同一路径：上一版成片必须被新成片原子替换，`-t` 用新的帧数。
  const originalMuxVideoAudio = bridgeFfmpeg.apiMuxVideoAudioCopy
  bridgeFfmpeg.apiMuxVideoAudioCopy = async (_v, _a, outPath, _bitrate, options) => {
    muxOptions = options
    await writeFile(outPath, `remuxed-${options.frameCount}`)
  }
  t.after(() => {
    bridgeFfmpeg.apiMuxVideoAudioCopy = originalMuxVideoAudio
  })
  // 上一次 remux 的 finally 已删掉页内视频/音频临时文件（含 mss-fpipe-* 目录）；
  // 重建一份代表新一版导出的页内视频与音频。
  await fs.promises.mkdir(path.dirname(videoPath), { recursive: true })
  await writeFile(videoPath, 'encoded-video')
  await writeFile(audioPath, 'RIFF')
  const shorter = await invoke('electron:api-remux-video-from-files', [
    { videoPath, audioPath, outputPath, audioBitrate: '192k', frameCount: 45, fps: 30 }
  ])
  assert.equal(shorter.status, 200)
  assert.equal(shorter.body.result.success, true, JSON.stringify(shorter.body))
  assert.deepEqual(muxOptions, { frameCount: 45, fps: 30, startFrame: undefined })
  assert.equal(
    await readFile(outputPath, 'utf8'),
    'remuxed-45',
    'a shorter re-export replaces the previous file at the same path'
  )
  assert.deepEqual(
    (await readdir(outputDir)).filter((name) => name.includes('.partial')),
    []
  )
  assert.equal(pipeSessions.length, 1)
  // WebCodecs 的 full-range 流必须走 BT.709/tv 重编码，而不是 copy
  await writeFile(audioPath, 'RIFF')
  let mergeArgs = null
  const originalMergeVideoAudio = bridgeFfmpeg.apiMergeVideoAudioWithCompression
  bridgeFfmpeg.apiMergeVideoAudioWithCompression = async (...args) => {
    mergeArgs = args
    await writeFile(args[2], 'transcoded-video')
  }
  t.after(() => {
    bridgeFfmpeg.apiMergeVideoAudioWithCompression = originalMergeVideoAudio
  })
  const transcodedPath = path.join(outputDir, 'transcoded.mp4')
  const transcoded = await invoke('electron:api-remux-video-from-files', [
    {
      videoPath,
      audioPath,
      outputPath: transcodedPath,
      audioBitrate: '192k',
      frameCount: 90,
      fps: 30,
      transcode: true,
      inputWidth: 1920,
      inputHeight: 1080,
      crf: 18
    }
  ])
  assert.equal(transcoded.status, 200)
  assert.equal(transcoded.body.result.success, true, JSON.stringify(transcoded.body))
  assert.ok(mergeArgs, 'transcode=true must call apiMergeVideoAudioWithCompression')
  assert.equal(mergeArgs[3], 18, 'CRF is forwarded')
  assert.equal(mergeArgs[5], 30, 'fps is forwarded')
  assert.equal(mergeArgs[6], 'cpu', 'encoder comes from host config')
  assert.equal(mergeArgs[7], 1280, 'output width comes from host config')
  assert.equal(mergeArgs[8], 720, 'output height comes from host config')
  assert.equal(mergeArgs[9], 1920, 'input width is forwarded for the scale filter')
  assert.equal(mergeArgs[10], 1080, 'input height is forwarded for the scale filter')
  assert.equal(mergeArgs[12], 'hevc', 'codec comes from host config')
  assert.equal(mergeArgs[13], 90, 'frameCount truncates the final container')
  assert.equal(await readFile(transcodedPath, 'utf8'), 'transcoded-video')
})

test('bridge rejects an empty or reversed frame range before spawning ffmpeg', async (t) => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'msst-range-preflight-'))
  const outputDir = path.join(workDir, 'out')
  await fs.promises.mkdir(outputDir, { recursive: true })
  let pipeStarts = 0
  const app = express()
  app.use(
    '/bridge',
    createBridgeRouter({
      logger: new Logger({ type: 'hidden' }),
      config: {
        paths: { output: outputDir },
        video: { width: 1280, height: 720, fps: 30, crf: 23, encoder: 'cpu', codec: 'hevc' },
        render: { workers: 1 },
        tts: { apiBaseUrl: 'http://127.0.0.1:9880', timeoutMs: 5000 },
        llm: { enabled: false }
      },
      bridgeToken: 'tok',
      createFramesPipe: async () => {
        pipeStarts++
        throw new Error('must not be called')
      }
    })
  )
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  t.after(async () => {
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
    await rm(workDir, { recursive: true, force: true })
  })

  const post = (body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/bridge/invoke/electron:frames-stream-start',
          method: 'POST',
          headers: { 'x-mss-bridge-token': 'tok', 'content-type': 'application/json' }
        },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () =>
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) })
          )
        }
      )
      req.on('error', reject)
      req.end(JSON.stringify([body]))
    })

  const empty = await post({ fps: 30, fromFrame: 120, toFrame: 120 })
  assert.equal(empty.status, 400)
  assert.match(empty.body.error, /from must be less than to/)
  const reversed = await post({ fps: 30, fromFrame: 121, toFrame: 120 })
  assert.equal(reversed.status, 400)
  assert.match(reversed.body.error, /from must be less than to/)
  const odd = await post({ fps: 30, width: 1921, height: 1081 })
  assert.equal(odd.status, 400)
  assert.match(odd.body.error, /even width and height/)
  assert.equal(pipeStarts, 0, 'rejected requests must not spawn ffmpeg')
})

test('electron:write-file-at caches FileHandle across chunks and closes on explicit flush or idle timeout', async (t) => {
  const workDir = await mkdtemp(path.join(tmpdir(), 'msst-fh-cache-'))
  const targetFile = path.join(workDir, 'chunked.mp4')
  await writeFile(targetFile, Buffer.alloc(16, 0))

  const realOpen = fs.promises.open
  let openCount = 0
  let closeCount = 0
  t.mock.method(fs.promises, 'open', async (filePath, flags) => {
    const handle = await realOpen(filePath, flags)
    if (path.resolve(String(filePath)) === path.resolve(targetFile)) {
      openCount++
      const realClose = handle.close.bind(handle)
      handle.close = async () => {
        closeCount++
        return realClose()
      }
    }
    return handle
  })

  const app = express()
  app.use(
    '/bridge',
    createBridgeRouter({
      logger: new Logger({ type: 'hidden' }),
      config: {
        video: { width: 1280, height: 720, fps: 30, crf: 23, encoder: 'cpu' },
        render: { workers: 1 }
      },
      fileHandleIdleMs: 500
    })
  )
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const realSetTimeout = globalThis.setTimeout
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })

  t.after(async () => {
    clock.uninstall()
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
    await rm(workDir, { recursive: true, force: true })
  })

  const writeAt = (position, bytes) =>
    new Promise((resolve, reject) => {
      const args = encodeURIComponent(JSON.stringify([{ filePath: targetFile, position }]))
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: `/bridge/bin/electron:write-file-at?args=${args}`,
          headers: { 'content-type': 'application/octet-stream' }
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode))
        }
      )
      req.on('error', reject)
      req.end(bytes)
    })

  const invokeClose = () =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/bridge/invoke/electron:close-file-handle',
          headers: { 'content-type': 'application/json' }
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode))
        }
      )
      req.on('error', reject)
      req.end(JSON.stringify([{ filePath: targetFile }]))
    })

  assert.equal(await writeAt(0, Buffer.from('AAAA')), 200)
  assert.equal(await writeAt(8, Buffer.from('BBBB')), 200)
  assert.equal(await writeAt(4, Buffer.from('CCCC')), 200)
  assert.equal(openCount, 1, 'multiple chunks must reuse one open FileHandle')
  assert.equal(closeCount, 0)

  assert.equal(await invokeClose(), 200)
  assert.equal(closeCount, 1, 'explicit close-file-handle must flush and close')

  const data = await readFile(targetFile, 'utf8')
  assert.equal(data.slice(0, 12), 'AAAACCCCBBBB')

  // Idle timeout auto-closes handle after inactivity
  assert.equal(await writeAt(12, Buffer.from('DDDD')), 200)
  assert.equal(openCount, 2)
  assert.equal(closeCount, 1)
  await clock.tickAsync(500)
  for (let i = 0; i < 400 && closeCount < 2; i++) {
    await new Promise((r) => realSetTimeout(r, 5))
  }
  assert.equal(closeCount, 2, 'idle timeout must close cached FileHandle')
})
