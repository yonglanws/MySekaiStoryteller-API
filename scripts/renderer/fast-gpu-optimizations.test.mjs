/**
 * Workstream A2 regression tests covering:
 * 1. CubismWebGL2Optimizer shared-VBO / VAO / state-elision batching
 * 2. WebCodecsMp4Encoder binary WebSocket chunk streaming + { alpha: 'discard' }
 * 3. BgmPlan / SePlan Rust audio plan cue builders
 * 4. ModelLayer / App static-frame skip guards (never freeze blink/breath/lip-sync)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const rendererRoot = path.join(root, 'src/renderer/src')

function loadRendererModule(relPath, mocks = new Map(), globals = {}) {
  const fullPath = path.join(rendererRoot, relPath)
  const cache = new Map()
  const context = vm.createContext({
    console,
    Uint8Array,
    Float32Array,
    Int16Array,
    Int32Array,
    Uint16Array,
    DataView,
    ArrayBuffer,
    TextEncoder,
    TextDecoder,
    URLSearchParams,
    performance,
    Math,
    setTimeout,
    clearTimeout,
    ...globals
  })

  const loadByAbsPath = (absPath) => {
    const norm = path.normalize(absPath)
    if (cache.has(norm)) return cache.get(norm)
    if (mocks.has(norm)) return mocks.get(norm)
    const src = fs.readFileSync(norm, 'utf8')
    const out = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: norm
    }).outputText
    const mod = { exports: {} }
    cache.set(norm, mod.exports)
    const req = (spec) => {
      if (mocks.has(spec)) return mocks.get(spec)
      if (spec.startsWith('.')) {
        const base = path.resolve(path.dirname(norm), spec)
        for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
          if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
            return loadByAbsPath(cand)
          }
        }
      }
      throw new Error(`Unexpected dependency "${spec}" from ${norm}`)
    }
    new vm.Script(`(function(exports, require, module) {\n${out}\n})`, { filename: norm }).runInContext(
      context
    )(mod.exports, req, mod)
    cache.set(norm, mod.exports)
    return mod.exports
  }

  return loadByAbsPath(fullPath)
}

test('CubismWebGL2Optimizer caches VAOs, uploads shared VBO once per frame, and elides state', () => {
  class FakeInternalModel {
    constructor(renderer) {
      this.renderer = renderer
    }
    updateWebGLContext() {}
  }

  let progCounter = 0
  let bufCounter = 0
  let vaoCounter = 0
  const counts = {
    createBuffer: 0,
    createVertexArray: 0,
    bufferData: 0,
    useProgram: 0,
    drawElements: 0,
    deleteBuffer: 0,
    deleteVertexArray: 0
  }

  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    UNSIGNED_SHORT: 0x1403,
    TRIANGLES: 0x0004,
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    TEXTURE_2D: 0x0de1,
    SCISSOR_TEST: 0x0c11,
    STENCIL_TEST: 0x0b90,
    DEPTH_TEST: 0x0b71,
    CULL_FACE: 0x0b44,
    BLEND: 0x0be2,
    CW: 0x0900,
    CCW: 0x0901,
    ZERO: 0,
    ONE: 1,
    ONE_MINUS_SRC_COLOR: 0x0301,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    DST_COLOR: 0x0306,
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    deleteShader: () => {},
    createProgram: () => ({ id: ++progCounter }),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    deleteProgram: () => {},
    getAttribLocation: (_p, name) => (name === 'a_position' ? 0 : 1),
    getUniformLocation: (_p, name) => name,
    createBuffer: () => {
      counts.createBuffer++
      return { id: ++bufCounter }
    },
    bindBuffer: () => {},
    bufferData: () => {
      counts.bufferData++
    },
    deleteBuffer: () => {
      counts.deleteBuffer++
    },
    createVertexArray: () => {
      counts.createVertexArray++
      return { id: ++vaoCounter }
    },
    bindVertexArray: () => {},
    deleteVertexArray: () => {
      counts.deleteVertexArray++
    },
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    useProgram: (p) => {
      if (p) counts.useProgram++
    },
    activeTexture: () => {},
    bindTexture: () => {},
    uniform1i: () => {},
    uniform4f: () => {},
    uniformMatrix4fv: () => {},
    enable: () => {},
    disable: () => {},
    frontFace: () => {},
    colorMask: () => {},
    blendFuncSeparate: () => {},
    drawElements: () => {
      counts.drawElements++
    }
  }

  let origDoDrawCalls = 0
  class FakeRenderer {
    constructor(model) {
      this.gl = gl
      this._model = model
      this._clippingManager = null
      this._sortedDrawableIndexList = [0, 1]
      this._textures = { 0: { tex: 0 } }
    }
    getModel() {
      return this._model
    }
    isUsingHighPrecisionMask() {
      return false
    }
    isPremultipliedAlpha() {
      return true
    }
    preDraw() {}
    drawModel() {
      this.doDrawModel()
    }
    doDrawModel() {
      origDoDrawCalls++
    }
    drawMesh() {}
    release() {}
    isCulling() {
      return false
    }
    setIsCulling() {}
    getModelColor() {
      return { R: 1, G: 1, B: 1, A: 1 }
    }
    getMvpMatrix() {
      return { getArray: () => new Float32Array(16) }
    }
    getClippingContextBufferForMask() {
      return null
    }
    setClippingContextBufferForMask() {}
    getClippingContextBufferForDraw() {
      return null
    }
    setClippingContextBufferForDraw() {}
  }

  let dirtyVerts = true
  const fakeModel = {
    getDrawableCount: () => 2,
    getDrawableVertexCount: () => 4,
    getDrawableVertexIndexCount: () => 6,
    getDrawableVertexIndices: () => new Uint16Array([0, 1, 2, 0, 2, 3]),
    getDrawableVertexUvs: () => new Float32Array(8),
    getDrawableVertices: () => new Float32Array(8),
    getDrawableDynamicFlagVertexPositionsDidChange: () => dirtyVerts,
    getDrawableRenderOrders: () => [0, 1],
    getDrawableDynamicFlagIsVisible: () => true,
    getDrawableCulling: () => false,
    getDrawableTextureIndex: () => 0,
    getMultiplyColor: () => ({ R: 1, G: 1, B: 1, A: 1 }),
    getScreenColor: () => ({ R: 0, G: 0, B: 0, A: 0 }),
    getDrawableOpacity: () => 1,
    getDrawableBlendMode: () => 0,
    getDrawableInvertedMaskBit: () => false
  }

  const shaderMock = {
    vertexShaderSrcSetupMask: 'v0',
    fragmentShaderSrcsetupMask: 'f0',
    vertexShaderSrc: 'v1',
    fragmentShaderSrcPremultipliedAlpha: 'f1',
    vertexShaderSrcMasked: 'v2',
    fragmentShaderSrcMaskPremultipliedAlpha: 'f2',
    fragmentShaderSrcMaskInvertedPremultipliedAlpha: 'f3'
  }

  const { installCubismWebGL2Optimizer } = loadRendererModule(
    'managers/video-export/CubismWebGL2Optimizer.ts',
    new Map([
      ['pixi-live2d-display-advanced', { Cubism4InternalModel: FakeInternalModel }],
      ['pixi-live2d-display-advanced/cubism4', shaderMock]
    ])
  )

  assert.equal(installCubismWebGL2Optimizer(), true)
  const renderer = new FakeRenderer(fakeModel)
  const internal = new FakeInternalModel(renderer)
  internal.updateWebGLContext(gl, 1)

  // Frame 1 (dirty): creates 3 shared buffers + 1 VAO, uploads pos once
  renderer.drawModel()
  assert.equal(origDoDrawCalls, 0)
  assert.equal(counts.createBuffer, 3)
  assert.equal(counts.createVertexArray, 1)
  assert.equal(counts.drawElements, 2)
  assert.equal(counts.useProgram, 1, '2 same-program drawables share 1 gl.useProgram call')
  const bufUploadsFrame1 = counts.bufferData

  // Frame 2 (unchanged vertices): 0 bufferData calls!
  dirtyVerts = false
  renderer.drawModel()
  assert.equal(counts.bufferData, bufUploadsFrame1)
  assert.equal(counts.drawElements, 4)

  renderer.release()
  assert.equal(counts.deleteBuffer, 3)
  assert.equal(counts.deleteVertexArray, 1)
})

test('WebCodecsMp4Encoder streams chunks over binary WebSocket and encodes VideoFrame with alpha discard', async () => {
  const sentFrames = []
  const ctrlMessages = []
  const ipcCalls = []
  const videoFrameInits = []

  class FakeWs {
    static OPEN = 1
    constructor(url) {
      this.url = url
      this.readyState = 1
      this.listeners = new Map()
      setTimeout(() => this.emit('open', {}), 0)
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set())
      this.listeners.get(type).add(fn)
    }
    removeEventListener(type, fn) {
      this.listeners.get(type)?.delete(fn)
    }
    emit(type, ev) {
      for (const fn of this.listeners.get(type) || []) fn(ev)
    }
    send(data) {
      if (typeof data === 'string') {
        const msg = JSON.parse(data)
        ctrlMessages.push(msg)
        setTimeout(() => {
          this.emit('message', {
            data: JSON.stringify({
              ok: true,
              op: msg.op === 'close' ? 'closed' : 'ack',
              streamId: msg.streamId
            })
          })
        }, 0)
      } else {
        sentFrames.push(new Uint8Array(data))
      }
    }
    close() {
      this.readyState = 3
    }
  }

  class MockVideoFrame {
    constructor(_src, init) {
      videoFrameInits.push(init)
    }
    close() {}
  }

  class MockVideoEncoder {
    static async isConfigSupported(cfg) {
      return { supported: true, config: cfg }
    }
    constructor(init) {
      this._init = init
      this.encodeQueueSize = 0
    }
    addEventListener() {}
    removeEventListener() {}
    configure() {}
    encode() {}
    async flush() {
      this._init.output(
        { type: 'key', byteLength: 4 },
        {
          decoderConfig: {
            codec: 'avc1.640028',
            colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: true }
          }
        }
      )
    }
    close() {}
  }

  const fakeWindow = {
    electron: {
      ipcRenderer: {
        invoke: async (ch) => {
          ipcCalls.push(ch)
          return null
        }
      }
    }
  }

  const { WebCodecsMp4Encoder } = loadRendererModule(
    'managers/video-export/WebCodecsMp4Encoder.ts',
    new Map([
      [
        'mp4-muxer',
        {
          Muxer: class {
            constructor(opts) {
              this.target = opts.target
            }
            addVideoChunk() {
              this.target.onData(new Uint8Array([1, 2, 3, 4]), 128)
            }
            finalize() {}
          },
          StreamTarget: class {
            constructor(opts) {
              this.onData = opts.onData
            }
          }
        }
      ],
      [path.join(rendererRoot, 'managers/video-export/GpuYuv420Converter.ts'), { GpuYuv420Converter: {} }],
      [
        path.join(rendererRoot, 'managers/video-export/ExportLogger.ts'),
        { ExportLogger: class { info() {} warn() {} error() {} } }
      ]
    ]),
    {
      window: fakeWindow,
      location: { protocol: 'http:', host: '127.0.0.1:9881', search: '?token=tok1' },
      WebSocket: FakeWs,
      fetch: async () => ({
        ok: true,
        json: async () => ({ ok: true, backend: 'rust', wsUrl: 'ws://127.0.0.1:50000/bridge/rs-stream?token=tok1' })
      }),
      VideoFrame: MockVideoFrame,
      VideoEncoder: MockVideoEncoder
    }
  )

  const enc = new WebCodecsMp4Encoder({
    width: 1920,
    height: 1080,
    fps: 60,
    bitrate: 5_500_000,
    encoderConfig: { codec: 'avc1.640028', hardwareAcceleration: 'prefer-hardware' },
    useGpuYuvReadback: false
  })
  await enc.initialize('C:\\temp\\test.mp4')
  await enc.encodeFrame({ width: 1920, height: 1080 }, 0, 16667, true)
  await enc.finish()

  assert.equal(videoFrameInits[0]?.alpha, 'discard')
  assert.equal(ipcCalls.includes('electron:write-file-at'), false, 'zero HTTP write-file-at when WS is active')
  assert.equal(ctrlMessages[0]?.op, 'open-file')
  assert.equal(ctrlMessages[1]?.op, 'close')
  assert.equal(sentFrames.length, 1)
  const dv = new DataView(sentFrames[0].buffer)
  assert.equal(dv.getUint32(0, true), 1) // streamId
  assert.equal(dv.getUint8(4), 1) // KIND_WRITE_FILE_AT
  assert.equal(dv.getBigUint64(8, true), 128n)
  assert.deepEqual(Array.from(sentFrames[0].subarray(16)), [1, 2, 3, 4])
})

test('BgmPlan.getRustCues & SePlan.getRustCues emit path cues and UI SE timings cleanly', () => {
  const { BgmPlan } = loadRendererModule(
    'managers/video-export/BgmPlan.ts',
    new Map([
      [path.join(rendererRoot, 'managers/video-export/ExportLogger.ts'), { ExportLogger: class { info() {} warn() {} } }],
      [path.join(rendererRoot, 'utils/ResourceUrl.ts'), { resolveBgmUrl: (p) => `/resources/${p}` }]
    ])
  )
  const { SePlan } = loadRendererModule(
    'managers/video-export/SePlan.ts',
    new Map([
      [path.join(rendererRoot, 'managers/video-export/ExportLogger.ts'), { ExportLogger: class { info() {} warn() {} } }],
      [path.join(rendererRoot, 'utils/ResourceUrl.ts'), { resolveSeUrl: (p) => `/resources/${p}` }],
      [path.join(rendererRoot, 'effects/InappTextures.ts'), { inappUrl: (p) => `/resources/inapp/jp-7.0.0/${p}` }],
      [
        path.join(rendererRoot, 'managers/video-export/AudioMuxer.ts'),
        { resampleChannelLinear: (a) => a }
      ]
    ])
  )

  const snippets = [
    { type: 'ChangeBgm', delay: 0.5, data: { file: 'bgm00001.mp3', fadeMs: 500, volume: 0.8 } },
    { type: 'BgmVolume', delay: 0, data: { volume: 0.4, duration: 300 } },
    { type: 'PlaySe', delay: 0, data: { file: 'se00001.mp3', offsetMs: 120, volume: 0.9, loop: false } },
    { type: 'SekaiOut', delay: 0, data: {} }
  ]
  const starts = [0, 1000, 2000, 3000]
  const bgm = new BgmPlan(snippets).getRustCues(starts)
  assert.equal(bgm.cues.length, 1)
  assert.equal(bgm.cues[0].timeMs, 500)
  assert.equal(bgm.cues[0].relPath, 'audio/bgm/bgm00001.mp3')
  assert.equal(bgm.volumeTweens[0].timeMs, 1000)

  const se = new SePlan(snippets).getRustCues(starts)
  assert.equal(se.length, 2)
  assert.equal(se[0].timeMs, 2120)
  assert.equal(se[0].relPath, 'audio/se/se00001.mp3')
  assert.equal(se[1].timeMs, 3000)
  assert.match(se[1].relPath, /SE_AREA_TRANSITION_SEKAI\.wav$/)
})

test('ModelLayer.hasActiveModelsOrShaders protects visible models from static-frame skip', () => {
  const { default: ModelLayer } = loadRendererModule(
    'layers/ModelLayer.ts',
    new Map([
      ['pixi.js', { Container: class { constructor() { this.children = []; this.sortableChildren = false } } }],
      ['pixi-live2d-display-advanced', { MotionPriority: { NORMAL: 2 } }],
      [path.join(root, 'src/common/types/Story.ts'), { LayoutModes: { Normal: 'Normal', Three: 'Three' } }],
      [path.join(rendererRoot, 'utils/Logger.ts'), { default: () => ({ info() {}, warn() {}, debug() {} }) }],
      [path.join(rendererRoot, 'model/AdvancedModel.ts'), { default: class {} }],
      [path.join(rendererRoot, 'effects/Ease.ts'), { runEasedTween: async () => {} }],
      [path.join(rendererRoot, 'effects/OfficialFilters.ts'), {
        HologramFilter: class {},
        MonitorFilter: class {},
        createColorMatrixFilter: () => ({})
      }],
      [path.join(rendererRoot, 'managers/AnimationManager.ts'), { default: { registerExportStep: () => () => {} } }],
      [path.join(rendererRoot, 'snippets/stageTiming.ts'), { resolveElapsedMs: () => 0 }],
      [path.join(rendererRoot, 'common/official/timing.ts'), {
        LayoutModes: { Normal: 'Normal', Three: 'Three' },
        MODEL_APPEAR_OUT_MS: 200,
        SHAKE_STEP_MS: 50,
        SHAKE_STEPS: 4
      }],
      [path.join(root, 'src/common/official/timing.ts'), {
        LayoutModes: { Normal: 'Normal', Three: 'Three' },
        MODEL_APPEAR_OUT_MS: 200,
        SHAKE_STEP_MS: 50,
        SHAKE_STEPS: 4
      }],
      [path.join(rendererRoot, 'common/official/characterColors.ts'), { AMBIENT_RGB: {} }],
      [path.join(root, 'src/common/official/characterColors.ts'), { AMBIENT_RGB: {} }]
    ])
  )

  const layer = new ModelLayer({ stage: { addChild() {} }, renderer: { screen: { width: 1920, height: 1080 } }, screen: { width: 1920, height: 1080 } })
  assert.equal(layer.hasActiveModelsOrShaders(), false)
  layer.getContainer().children.push({ visible: true, destroyed: false, alpha: 1 })
  assert.equal(layer.hasActiveModelsOrShaders(), true, 'visible model must prevent static-frame skip')
  layer.getContainer().children[0].visible = false
  assert.equal(layer.hasActiveModelsOrShaders(), false)
})

test('WebCodecsMp4Encoder.repeatLastFrame drains pending PBOs and emits CFR frames without GPU readback', async () => {
  const encodedTimestamps = []
  const encodedFirstBytes = []
  let enqueueCount = 0
  let drainCalls = 0
  const frameLen = 1920 * 1080 * 1.5
  const pending = []

  class MockEncoder {
    constructor(cb) {
      this.cb = cb
      this.encodeQueueSize = 0
    }
    configure() {}
    encode(frame) {
      encodedTimestamps.push(frame.timestamp)
      encodedFirstBytes.push(frame.firstByte)
    }
    async flush() {}
    close() {}
  }

  class MockFrame {
    constructor(data, init) {
      this.timestamp = init.timestamp
      this.firstByte = data instanceof Uint8Array ? data[0] : -1
    }
    close() {}
  }

  const fakeConverter = {
    frameByteLength: frameLen,
    enqueueAsync: async () => {
      enqueueCount++
      const buf = new Uint8Array(frameLen)
      buf[0] = enqueueCount
      pending.push(buf)
      if (pending.length >= 3) return pending.shift()
      return null
    },
    drainAllAsync: async () => {
      drainCalls++
      return pending.splice(0)
    },
    dispose: () => {}
  }

  const { WebCodecsMp4Encoder } = loadRendererModule(
    'managers/video-export/WebCodecsMp4Encoder.ts',
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
        path.join(rendererRoot, 'managers/video-export/ExportLogger.ts'),
        { ExportLogger: class { info() {} warn() {} error() {} } }
      ],
      [
        path.join(rendererRoot, 'managers/video-export/GpuYuv420Converter.ts'),
        {
          GpuYuv420Converter: {
            create: () => fakeConverter
          }
        }
      ]
    ]),
    {
      VideoEncoder: MockEncoder,
      VideoFrame: MockFrame,
      window: { electron: { ipcRenderer: { invoke: async () => ({ success: true }) } } }
    }
  )

  const enc = new WebCodecsMp4Encoder({
    width: 1920,
    height: 1080,
    fps: 60,
    bitrate: 5_500_000,
    encoderConfig: {
      codec: 'avc1.640028',
      width: 1920,
      height: 1080,
      bitrate: 5_500_000,
      framerate: 60,
      avc: { format: 'avc' }
    },
    useGpuYuvReadback: true
  })
  await enc.initialize('C:\\temp\\repeat.mp4')
  const fakeCanvas = { width: 1920, height: 1080 }

  // 4 rendered frames: ring holds [3, 4], frames [1, 2] already encoded
  for (let i = 0; i < 4; i++) {
    await enc.encodeFrame(fakeCanvas, i * 16667, 16667, false)
  }
  // Static repeat frames 4 and 5 must drain [3, 4] first, then repeat frame 4 without calling enqueueAsync
  const rep1 = await enc.repeatLastFrame(4 * 16667, 16667, false)
  const rep2 = await enc.repeatLastFrame(5 * 16667, 16667, false)
  assert.equal(rep1, true)
  assert.equal(rep2, true)
  assert.equal(enqueueCount, 4, 'repeatLastFrame does not submit new GPU readbacks')
  assert.equal(drainCalls, 1, 'drains pending PBO ring once before repeating')
  assert.deepEqual(encodedFirstBytes, [1, 2, 3, 4, 4, 4])
  assert.deepEqual(encodedTimestamps, [0, 16667, 33334, 50001, 66668, 83335])
  await enc.finish()

  // Without GpuYuv420Converter (useGpuYuvReadback: false), repeatLastFrame returns false cleanly
  const encNoGpu = new WebCodecsMp4Encoder({
    width: 1920,
    height: 1080,
    fps: 60,
    bitrate: 5_500_000,
    encoderConfig: {
      codec: 'avc1.640028',
      width: 1920,
      height: 1080,
      bitrate: 5_500_000,
      framerate: 60,
      avc: { format: 'avc' }
    },
    useGpuYuvReadback: false
  })
  await encNoGpu.initialize('C:\\temp\\nogpu.mp4')
  assert.equal(await encNoGpu.repeatLastFrame(0, 16667, true), false)
  encNoGpu.dispose()
})

test('GpuYuv420Converter submits frame N DMA and flushes before harvesting oldest PBO slot', async () => {
  const ops = []
  let pboCounter = 0
  const fakeGl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    TEXTURE0: 7,
    TEXTURE_2D: 8,
    TEXTURE_MIN_FILTER: 9,
    TEXTURE_MAG_FILTER: 10,
    TEXTURE_WRAP_S: 11,
    TEXTURE_WRAP_T: 12,
    LINEAR: 13,
    NEAREST: 14,
    CLAMP_TO_EDGE: 15,
    RGBA8: 16,
    RGBA: 17,
    UNSIGNED_BYTE: 18,
    FRAMEBUFFER: 19,
    COLOR_ATTACHMENT0: 20,
    FRAMEBUFFER_COMPLETE: 21,
    PIXEL_PACK_BUFFER: 22,
    STREAM_READ: 23,
    TRIANGLES_STRIP: 24,
    TRIANGLE_STRIP: 24,
    FLOAT: 25,
    UNPACK_FLIP_Y_WEBGL: 26,
    SYNC_GPU_COMMANDS_COMPLETE: 27,
    ALREADY_SIGNALED: 28,
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
    bindVertexArray: () => {},
    deleteVertexArray: () => {},
    createBuffer: () => ({ id: ++pboCounter }),
    bindBuffer: () => {},
    bufferData: () => {},
    deleteBuffer: () => {},
    getAttribLocation: () => 0,
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    createTexture: () => ({}),
    activeTexture: () => {},
    bindTexture: () => {},
    texParameteri: () => {},
    texImage2D: () => {},
    deleteTexture: () => {},
    createFramebuffer: () => ({}),
    bindFramebuffer: () => {},
    framebufferTexture2D: () => {},
    checkFramebufferStatus: () => 21,
    deleteFramebuffer: () => {},
    useProgram: () => {},
    getUniformLocation: () => ({}),
    uniform1i: () => {},
    viewport: () => {},
    pixelStorei: () => {},
    drawArrays: () => {},
    readPixels: (_x, _y, _w, _h, _f, _t, dstOrOffset) => {
      if (typeof dstOrOffset === 'number') ops.push('readPixels_pbo')
    },
    fenceSync: () => {
      ops.push('fenceSync')
      return {}
    },
    flush: () => ops.push('flush'),
    clientWaitSync: () => {
      ops.push('clientWaitSync')
      return 28
    },
    deleteSync: () => {},
    getBufferSubData: (_t, _o, dst) => {
      ops.push('getBufferSubData')
      dst[0] = 42
    }
  }

  const { GpuYuv420Converter } = loadRendererModule('managers/video-export/GpuYuv420Converter.ts', new Map(), {
    OffscreenCanvas: class {
      getContext() {
        return fakeGl
      }
    }
  })

  const conv = GpuYuv420Converter.create(16, 16, 3)
  assert.ok(conv)
  assert.equal(await conv.enqueueAsync({}), null)
  assert.equal(await conv.enqueueAsync({}), null)
  ops.length = 0
  const out = await conv.enqueueAsync({})
  assert.ok(out)
  assert.equal(out[0], 42)
  assert.deepEqual(ops, ['readPixels_pbo', 'fenceSync', 'flush', 'clientWaitSync', 'getBufferSubData'])
  conv.dispose()
})

test('normalizeExportVideoCodec & resolveRemuxCodecPlan treat hevc and h265 identically', () => {
  const { normalizeExportVideoCodec, resolveRemuxCodecPlan } = loadRendererModule(
    'managers/video-export/types.ts'
  )

  assert.equal(normalizeExportVideoCodec('hevc'), 'hevc')
  assert.equal(normalizeExportVideoCodec('h265'), 'hevc')
  assert.equal(normalizeExportVideoCodec('h264'), 'h264')
  assert.equal(normalizeExportVideoCodec(undefined), undefined)

  const hevcFromH264 = resolveRemuxCodecPlan('hevc', {
    encoderCodecKind: 'h264',
    requiresColorConversion: false
  })
  assert.deepEqual({ ...hevcFromH264 }, {
    targetCodec: 'hevc',
    encoderCodec: 'h264',
    finalCodec: 'hevc',
    needsColorConversion: false,
    needsCodecTranscode: true,
    transcode: true
  })

  const h265FromH264 = resolveRemuxCodecPlan('h265', {
    encoderCodecKind: 'h264',
    requiresColorConversion: false
  })
  assert.deepEqual({ ...h265FromH264 }, { ...hevcFromH264 })

  const h264Copy = resolveRemuxCodecPlan('h264', {
    encoderCodecKind: 'h264',
    requiresColorConversion: false
  })
  assert.equal(h264Copy.transcode, false)
  assert.equal(h264Copy.finalCodec, 'h264')

  const hevcNative = resolveRemuxCodecPlan('hevc', {
    encoderCodecKind: 'hevc',
    requiresColorConversion: false
  })
  assert.equal(hevcNative.transcode, false)
  assert.equal(hevcNative.finalCodec, 'hevc')
})
