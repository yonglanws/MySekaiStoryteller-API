import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'
import { Logger } from 'tslog'
import { createRendererLoader } from './lib/renderer-loader.mjs'
import { createBridgeRouter } from '../../out-host/host/bridge/bridgeRoutes.js'

const root = process.cwd()
const rendererRoot = path.join(root, 'src/renderer/src')

class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3

  constructor(url, behavior = {}) {
    this.url = url
    this.binaryType = 'blob'
    this.readyState = 0
    this.bufferedAmount = 0
    this._listeners = new Map()
    this._behavior = behavior
    this.sentTexts = []
    this.sentBinaries = []
    this.sentBinaryArrayBuffers = new Set()

    const schedule = behavior.realSetTimeout ?? setTimeout
    schedule(() => {
      if (behavior.failConnect) {
        this.readyState = FakeWebSocket.CLOSED
        this._emit('error', new Event('error'))
        this._emit('close', {})
        return
      }
      this.readyState = FakeWebSocket.OPEN
      this._emit('open', {})
    }, 1)
  }

  addEventListener(type, fn) {
    let set = this._listeners.get(type)
    if (!set) {
      set = new Set()
      this._listeners.set(type, set)
    }
    set.add(fn)
  }

  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn)
  }

  _emit(type, ev) {
    for (const fn of [...(this._listeners.get(type) ?? [])]) {
      fn(ev)
    }
  }

  send(data) {
    if (typeof data === 'string') {
      const parsed = JSON.parse(data)
      this.sentTexts.push(parsed)
      const reply = this._behavior.onControl?.(parsed, this)
      if (reply !== undefined) {
        const schedule = this._behavior.realSetTimeout ?? setTimeout
        schedule(() => {
          if (this.readyState === FakeWebSocket.OPEN) {
            this._emit('message', { data: JSON.stringify(reply) })
          }
        }, 1)
      }
      return
    }
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    this.sentBinaryArrayBuffers.add(bytes.buffer)
    this.sentBinaries.push(bytes.slice())
    this._behavior.onBinary?.(bytes, this)
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this._emit('close', {})
  }
}

test('BinaryWsClient uses module-load nativeSetTimeout so sendControl timeout & waitBufferReady never deadlock under frozen virtual clock', async () => {
  const realSetTimeout = globalThis.setTimeout.bind(globalThis)
  const sockets = []

  class MockWs extends FakeWebSocket {
    constructor(url) {
      super(url, {
        realSetTimeout,
        onControl: (msg) => {
          if (msg.op === 'hang') return undefined // never reply -> must trigger timeout via nativeSetTimeout
          return { ok: true, op: 'ack', streamId: msg.streamId }
        }
      })
      sockets.push(this)
    }
  }

  const loader = createRendererLoader(new Map(), {
    WebSocket: MockWs,
    location: { protocol: 'http:', host: '127.0.0.1:9881', search: '?token=t1' },
    URLSearchParams
  })

  // Load BinaryWsClient BEFORE freezing globalThis.setTimeout (mirrors VirtualClockController.install())
  const { BinaryWsClient } = loader.load('managers/video-export/BinaryWsClient.ts')

  // Freeze context.setTimeout completely (never fires callbacks)
  let frozenCalls = 0
  loader.context.setTimeout = () => {
    frozenCalls++
    return 999999
  }
  loader.context.clearTimeout = () => {}

  const client = await BinaryWsClient.connect('ws://127.0.0.1:19999/bridge/rs-stream')
  const ws = sockets[0]

  // 1. sendControl timeout fires via nativeSetTimeout even with global setTimeout frozen
  const timedOut = await client.sendControl({ op: 'hang', streamId: 1 }, 15)
  assert.equal(timedOut.ok, false)
  assert.match(timedOut.error, /timeout/i)

  // 2. waitBufferReady drains using nativeSetTimeout even with global setTimeout frozen
  ws.bufferedAmount = 40 * 1024 * 1024
  let drainTicks = 0
  realSetTimeout(() => {
    drainTicks++
    ws.bufferedAmount = 8 * 1024 * 1024
  }, 15)

  await client.waitBufferReady({
    highWaterBytes: 32 * 1024 * 1024,
    lowWaterBytes: 16 * 1024 * 1024,
    pollMs: 5
  })
  assert.equal(drainTicks, 1)
  assert.equal(frozenCalls, 0, 'BinaryWsClient must not call patched/frozen global setTimeout')
  client.close()
})

test('JpegFrameSink streams YUV420p frames over Rust /bridge/rs-stream WS with 3-slot PBO, pooled 16+frameBytes packets, and 16B KIND_REPEAT_FRAME', async () => {
  const realSetTimeout = globalThis.setTimeout.bind(globalThis)
  const frameBytes = (16 * 16 * 3) / 2 // 384 bytes
  let requestedRingSize = 0
  let enqueueCount = 0
  const pendingPbo = []
  const sockets = []
  const ipcCalls = []

  const fakeConverter = {
    frameByteLength: frameBytes,
    enqueueAsync: async (_canvas, reuse) => {
      enqueueCount++
      const buf = reuse && reuse.byteLength === frameBytes ? reuse : new Uint8Array(frameBytes)
      buf[0] = enqueueCount
      buf[frameBytes - 1] = enqueueCount + 100
      pendingPbo.push(buf)
      if (pendingPbo.length >= 3) {
        return pendingPbo.shift()
      }
      return null
    },
    drainAllAsync: async (acquire) => {
      const out = []
      while (pendingPbo.length > 0) {
        const src = pendingPbo.shift()
        const dst = acquire ? acquire() : src
        if (dst !== src) dst.set(src)
        out.push(dst)
      }
      return out
    },
    dispose: () => {}
  }

  class MockRustWs extends FakeWebSocket {
    constructor(url) {
      super(url, {
        realSetTimeout,
        onControl: (msg) => {
          if (msg.op === 'open-pipe') {
            return { ok: true, op: 'ack', streamId: msg.streamId }
          }
          if (msg.op === 'close') {
            return {
              ok: true,
              op: 'closed',
              streamId: msg.streamId,
              fileSize: 4096,
              frames: 11,
              dedupedFrames: 5,
              encoder: 'hevc_vaapi'
            }
          }
          return { ok: true, op: 'ack', streamId: msg.streamId }
        }
      })
      sockets.push(this)
    }
  }

  const fakeWindow = {
    electron: {
      ipcRenderer: {
        invoke: async (channel, payload) => {
          ipcCalls.push({ channel, payload })
          if (channel === 'electron:get-temp-base-dir') {
            return '/tmp/mss-export-rust-test'
          }
          throw new Error(`Unexpected IPC channel in Rust WS mode: ${channel}`)
        }
      }
    }
  }

  const loader = createRendererLoader(
    new Map([
      [
        path.join(rendererRoot, 'managers/video-export/ExportLogger.ts'),
        {
          ExportLogger: class {
            info() {}
            warn() {}
            error() {}
          }
        }
      ],
      [
        path.join(rendererRoot, 'managers/video-export/AsyncFrameCapturer.ts'),
        {
          AsyncFrameCapturer: class {
            async initialize() {}
            async dispose() {}
          }
        }
      ],
      [
        path.join(rendererRoot, 'managers/video-export/GpuYuv420Converter.ts'),
        {
          GpuYuv420Converter: {
            create: (_w, _h, ring) => {
              requestedRingSize = ring
              return fakeConverter
            }
          }
        }
      ]
    ]),
    {
      window: fakeWindow,
      WebSocket: MockRustWs,
      location: { protocol: 'http:', host: '127.0.0.1:9881', search: '?token=sec' },
      URLSearchParams,
      fetch: async (url, init) => {
        assert.equal(url, '/bridge/binary-stream-endpoint')
        assert.equal(init.headers['x-mss-bridge-token'], 'sec')
        return {
          ok: true,
          json: async () => ({
            ok: true,
            backend: 'rust',
            wsUrl: 'ws://127.0.0.1:41234/bridge/rs-stream?token=sec',
            token: 'sec',
            videoConfig: { encoder: 'vaapi', codec: 'hevc', crf: 25 }
          })
        }
      }
    }
  )

  const { JpegFrameSink } = loader.load('managers/video-export/JpegFrameSink.ts')
  const sink = new JpegFrameSink({ width: 16, height: 16, quality: 0.92, fps: 30 })
  await sink.initialize({})

  assert.equal(requestedRingSize, 3, 'JpegFrameSink must request 3-slot PBO ring')
  assert.equal(sink.isRawVideoMode, true)
  assert.equal(sink.isPipeMode, true)
  assert.equal(sink.isRustWsPipeMode, true)
  assert.equal(sockets.length, 1)

  const ws = sockets[0]
  assert.equal(ws.sentTexts[0].op, 'open-pipe')
  assert.equal(ws.sentTexts[0].format, 'yuv420p')
  assert.equal(ws.sentTexts[0].encoder, 'vaapi')
  assert.equal(ws.sentTexts[0].codec, 'hevc')
  assert.equal(ws.sentTexts[0].crf, 25)
  assert.equal(ws.sentTexts[0].outputPath, '/tmp/mss-export-rust-test/video.mp4')

  for (let i = 0; i < 5; i++) {
    await sink.captureFrame({})
  }
  assert.equal(await sink.repeatLastFrame(3), true)
  await sink.captureFrame({})
  assert.equal(await sink.repeatLastFrame(2), true)

  const outPath = await sink.finish()
  assert.equal(outPath, '/tmp/mss-export-rust-test/video.mp4')
  assert.equal(sink.frames, 11)
  assert.equal(enqueueCount, 6)
  assert.equal(ws.sentTexts[1].op, 'close')
  assert.equal(
    ipcCalls.some((c) => c.channel.startsWith('electron:frames-stream-')),
    false,
    'Rust WS pipe must bypass HTTP frames-stream-* channels completely'
  )

  // Parse binary packets in order: 5x KIND_PIPE_FRAME(1..5), KIND_REPEAT_FRAME(3), 1x KIND_PIPE_FRAME(6), KIND_REPEAT_FRAME(2)
  const timeline = ws.sentBinaries.map((pkt) => {
    const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength)
    const streamId = dv.getUint32(0, true)
    const kind = dv.getUint8(4)
    const count = Number(dv.getBigUint64(8, true))
    assert.equal(streamId, 1)
    if (kind === 2) {
      assert.equal(pkt.byteLength, 16 + frameBytes)
      return { kind, frame: pkt[16], tail: pkt[16 + frameBytes - 1], count }
    }
    assert.equal(kind, 3)
    assert.equal(pkt.byteLength, 16, 'KIND_REPEAT_FRAME must be 16B header with zero payload')
    return { kind, count }
  })

  assert.deepEqual(timeline, [
    { kind: 2, frame: 1, tail: 101, count: 1 },
    { kind: 2, frame: 2, tail: 102, count: 1 },
    { kind: 2, frame: 3, tail: 103, count: 1 },
    { kind: 2, frame: 4, tail: 104, count: 1 },
    { kind: 2, frame: 5, tail: 105, count: 1 },
    { kind: 3, count: 3 },
    { kind: 2, frame: 6, tail: 106, count: 1 },
    { kind: 3, count: 2 }
  ])
  assert.ok(
    ws.sentBinaryArrayBuffers.size <= 5,
    `expected pooled packet ArrayBuffer reuse (<=5), got ${ws.sentBinaryArrayBuffers.size}`
  )
})

test('JpegFrameSink falls back to HTTP frames-stream when backend !== rust or Rust WS open-pipe fails', async () => {
  const realSetTimeout = globalThis.setTimeout.bind(globalThis)
  const frameBytes = (16 * 16 * 3) / 2

  for (const scenario of ['node-backend', 'ws-open-rejected']) {
    const ipcCalls = []
    let converterDisposed = 0
    const fakeConverter = {
      frameByteLength: frameBytes,
      enqueueAsync: async () => new Uint8Array(frameBytes),
      drainAllAsync: async () => [],
      dispose: () => {
        converterDisposed++
      }
    }

    class RejectingWs extends FakeWebSocket {
      constructor(url) {
        super(url, {
          realSetTimeout,
          onControl: (msg) => ({
            ok: false,
            op: 'error',
            streamId: msg.streamId,
            error: 'open failed'
          })
        })
      }
    }

    const fakeWindow = {
      electron: {
        ipcRenderer: {
          invoke: async (channel, payload) => {
            ipcCalls.push({ channel, payload })
            if (channel === 'electron:get-temp-base-dir') return '/tmp/mss-export-fallback'
            if (channel === 'electron:delete-temp-file') return null
            if (channel === 'electron:frames-stream-start') {
              return { id: 'http-pipe-1', videoPath: '/tmp/http-pipe-1.mp4' }
            }
            if (channel === 'electron:frames-stream-chunk') return null
            if (channel === 'electron:frames-stream-finish') {
              return { videoPath: '/tmp/http-pipe-1.mp4' }
            }
            throw new Error(`Unexpected IPC channel: ${channel}`)
          }
        }
      }
    }

    const loader = createRendererLoader(
      new Map([
        [
          path.join(rendererRoot, 'managers/video-export/ExportLogger.ts'),
          {
            ExportLogger: class {
              info() {}
              warn() {}
              error() {}
            }
          }
        ],
        [
          path.join(rendererRoot, 'managers/video-export/AsyncFrameCapturer.ts'),
          {
            AsyncFrameCapturer: class {
              async initialize() {}
              async dispose() {}
            }
          }
        ],
        [
          path.join(rendererRoot, 'managers/video-export/GpuYuv420Converter.ts'),
          { GpuYuv420Converter: { create: () => fakeConverter } }
        ]
      ]),
      {
        window: fakeWindow,
        WebSocket: RejectingWs,
        location: { protocol: 'http:', host: '127.0.0.1:9881', search: '' },
        URLSearchParams,
        fetch: async () => ({
          ok: true,
          json: async () =>
            scenario === 'node-backend'
              ? { ok: true, backend: 'node', wsUrl: '/bridge/ws-bin' }
              : { ok: true, backend: 'rust', wsUrl: 'ws://127.0.0.1:41234/bridge/rs-stream' }
        })
      }
    )

    const { JpegFrameSink } = loader.load('managers/video-export/JpegFrameSink.ts')
    const sink = new JpegFrameSink({ width: 16, height: 16, quality: 0.92, fps: 30, crf: 23 })
    await sink.initialize({})
    assert.equal(sink.isRawVideoMode, true, `${scenario}: should stay rawvideo via HTTP fallback`)
    assert.equal(sink.isRustWsPipeMode, false, `${scenario}: must not be in Rust WS mode`)
    assert.equal(converterDisposed, 0, `${scenario}: must reuse existing converter on fallback`)

    await sink.captureFrame({})
    const out = await sink.finish()
    assert.equal(out, '/tmp/http-pipe-1.mp4')
    assert.ok(ipcCalls.some((c) => c.channel === 'electron:frames-stream-start'))
    if (scenario === 'ws-open-rejected') {
      assert.ok(
        ipcCalls.some(
          (c) =>
            c.channel === 'electron:delete-temp-file' &&
            c.payload?.filePath === '/tmp/mss-export-fallback'
        ),
        'failed Rust WS open-pipe must clean up its unused temp dir'
      )
    }
  }
})

test('GpuYuv420Converter reuses srcTexture via texSubImage2D for matching dimensions and backs off waitSync after 2 fastYield spins', async () => {
  const realSetTimeout = globalThis.setTimeout.bind(globalThis)
  const texImageCalls = []
  const texSubImageCalls = []
  const waitSyncTimeoutDelays = []
  let clientWaitCalls = 0
  let fastYieldCalls = 0

  const fakeGl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    TEXTURE0: 8,
    TEXTURE_2D: 9,
    TEXTURE_MIN_FILTER: 10,
    TEXTURE_MAG_FILTER: 11,
    TEXTURE_WRAP_S: 12,
    TEXTURE_WRAP_T: 13,
    LINEAR: 14,
    NEAREST: 15,
    CLAMP_TO_EDGE: 16,
    RGBA8: 17,
    RGBA: 18,
    UNSIGNED_BYTE: 19,
    FRAMEBUFFER: 20,
    COLOR_ATTACHMENT0: 21,
    FRAMEBUFFER_COMPLETE: 22,
    PIXEL_PACK_BUFFER: 23,
    STREAM_READ: 24,
    UNPACK_FLIP_Y_WEBGL: 25,
    TRIANGLE_STRIP: 26,
    SYNC_GPU_COMMANDS_COMPLETE: 27,
    ALREADY_SIGNALED: 28,
    CONDITION_SATISFIED: 29,
    TIMEOUT_EXPIRED: 30,
    WAIT_FAILED: 31,

    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    deleteShader: () => {},
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    deleteProgram: () => {},
    createVertexArray: () => ({}),
    deleteVertexArray: () => {},
    createBuffer: () => ({}),
    deleteBuffer: () => {},
    createTexture: () => ({ id: Math.random() }),
    deleteTexture: () => {},
    createFramebuffer: () => ({}),
    deleteFramebuffer: () => {},
    bindVertexArray: () => {},
    bindBuffer: () => {},
    bufferData: () => {},
    getAttribLocation: () => 0,
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    activeTexture: () => {},
    bindTexture: () => {},
    texParameteri: () => {},
    texImage2D: (...args) => {
      texImageCalls.push(args)
    },
    texSubImage2D: (...args) => {
      texSubImageCalls.push(args)
    },
    bindFramebuffer: () => {},
    framebufferTexture2D: () => {},
    checkFramebufferStatus: () => 22,
    useProgram: () => {},
    getUniformLocation: () => ({}),
    uniform1i: () => {},
    viewport: () => {},
    pixelStorei: () => {},
    drawArrays: () => {},
    readPixels: () => {},
    fenceSync: () => ({ sync: true }),
    deleteSync: () => {},
    flush: () => {},
    clientWaitSync: () => {
      clientWaitCalls++
      // Stay unsignaled for 4 polls so first 2 use fastYield and polls 3-4 use nativeSetTimeout(1)
      return clientWaitCalls >= 5 ? fakeGl.CONDITION_SATISFIED : fakeGl.TIMEOUT_EXPIRED
    },
    getBufferSubData: (_target, _srcOffset, dst) => {
      dst.fill(42)
    }
  }

  class FakeMessageChannel {
    constructor() {
      this.port1 = { onmessage: null }
      this.port2 = {
        postMessage: () => {
          fastYieldCalls++
          queueMicrotask(() => this.port1.onmessage?.({ data: null }))
        }
      }
    }
  }

  const spySetTimeout = (fn, delay) => {
    waitSyncTimeoutDelays.push(delay)
    return realSetTimeout(fn, delay)
  }

  const loader = createRendererLoader(new Map(), {
    OffscreenCanvas: class {
      getContext(type) {
        return type === 'webgl2' ? fakeGl : null
      }
    },
    MessageChannel: FakeMessageChannel,
    setTimeout: spySetTimeout
  })

  const { GpuYuv420Converter } = loader.load('managers/video-export/GpuYuv420Converter.ts')
  // Freeze global setTimeout after module load to verify nativeSetTimeout safety too
  loader.context.setTimeout = () => {
    throw new Error('GpuYuv420Converter must use module-load nativeSetTimeout')
  }

  const conv = GpuYuv420Converter.create(16, 16, 1)
  assert.ok(conv)
  // Initial creation allocates fboTexture with 1 texImage2D call
  assert.equal(texImageCalls.length, 1)
  assert.equal(texSubImageCalls.length, 0)

  // Frame 1 at 16x16 -> allocates srcTexture via texImage2D
  const f1 = await conv.enqueueAsync({ width: 16, height: 16 })
  assert.ok(f1)
  assert.equal(texImageCalls.length, 2)
  assert.equal(texSubImageCalls.length, 0)
  assert.equal(fastYieldCalls, 2, 'first 2 waitSync polls should use fastYield')
  assert.deepEqual(
    waitSyncTimeoutDelays,
    [1, 1],
    'subsequent waitSync polls should back off to nativeSetTimeout(1)'
  )

  // Frame 2 & 3 at same 16x16 -> reuse via texSubImage2D
  clientWaitCalls = 10
  await conv.enqueueAsync({ width: 16, height: 16 })
  await conv.enqueueAsync({ width: 16, height: 16 })
  assert.equal(texImageCalls.length, 2, 'same-size frames must not reallocate srcTexture')
  assert.equal(texSubImageCalls.length, 2)

  // Frame 4 resized to 32x16 -> reallocates via texImage2D, then Frame 5 reuses via texSubImage2D
  await conv.enqueueAsync({ width: 32, height: 16 })
  assert.equal(texImageCalls.length, 3, 'resized source must reallocate via texImage2D')
  assert.equal(texSubImageCalls.length, 2)

  await conv.enqueueAsync({ width: 32, height: 16 })
  assert.equal(texImageCalls.length, 3)
  assert.equal(texSubImageCalls.length, 3)

  conv.dispose()
})

test('bridgeRoutes /binary-stream-endpoint returns videoConfig and rejects removed api-export-video-from-files channel', async (t) => {
  const workDir = fs.mkdtempSync(path.join(tmpdir(), 'mss-bridge-video-cfg-'))
  let controller = null
  const app = express()
  app.use(
    '/bridge',
    createBridgeRouter({
      logger: new Logger({ type: 'hidden' }),
      config: {
        paths: { resources: workDir, output: workDir },
        video: {
          width: 1920,
          height: 1080,
          fps: 30,
          crf: 24,
          codec: 'hevc',
          encoder: 'vaapi',
          useRustExporter: false
        },
        tts: { apiBaseUrl: 'http://127.0.0.1:9880', timeoutMs: 10000 },
        llm: { enabled: false },
        bgm: {},
        assets: {}
      },
      bridgeToken: 'tok-cfg',
      onController: (ctrl) => {
        controller = ctrl
      }
    })
  )

  const server = http.createServer(app)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}/bridge`
  t.after(async () => {
    await controller?.disposeAll()
    server.close()
    await once(server, 'close')
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  const epRes = await fetch(`${base}/binary-stream-endpoint`, {
    headers: { 'x-mss-bridge-token': 'tok-cfg' }
  }).then((r) => r.json())
  assert.equal(epRes.ok, true)
  assert.equal(epRes.backend, 'node')
  assert.deepEqual(epRes.videoConfig, {
    encoder: 'vaapi',
    codec: 'hevc',
    crf: 24
  })

  // Removed dead channel electron:api-export-video-from-files must be rejected
  const deadRes = await fetch(
    `${base}/invoke/${encodeURIComponent('electron:api-export-video-from-files')}`,
    {
      method: 'POST',
      headers: { 'x-mss-bridge-token': 'tok-cfg', 'content-type': 'application/json' },
      body: JSON.stringify([{}])
    }
  )
  assert.equal(deadRes.status, 500)
  const deadBody = await deadRes.json()
  assert.equal(deadBody.ok, false)
  assert.match(deadBody.error, /Unsupported bridge invoke channel/i)
})
