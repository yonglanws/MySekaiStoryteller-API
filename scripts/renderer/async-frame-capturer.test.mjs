import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const root = process.cwd()
const renderer = path.join(root, 'src/renderer/src')

function loadTsModule(filePath, mocks = new Map(), extraContext = {}) {
  const modules = new Map()
  const compiled = new Map()
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    Uint8Array,
    ArrayBuffer,
    Buffer,
    Promise,
    Map,
    Set,
    Error,
    Math,
    ...extraContext
  })

  function load(target) {
    const filename = path.isAbsolute(target) ? target : path.join(renderer, target)
    for (const [key, value] of mocks.entries()) {
      if (target === key || filename === key) return value
    }
    if (modules.has(filename)) return modules.get(filename)

    const resolved = fs.existsSync(filename)
      ? filename
      : fs.existsSync(`${filename}.ts`)
        ? `${filename}.ts`
        : path.join(filename, 'index.ts')

    if (!compiled.has(resolved)) {
      const source = fs.readFileSync(resolved, 'utf8')
      compiled.set(
        resolved,
        new vm.Script(
          `(function (exports, require, module) {\n${
            ts.transpileModule(source, {
              compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
              fileName: resolved
            }).outputText
          }\n})`,
          { filename: resolved }
        )
      )
    }

    const mod = { exports: {} }
    modules.set(filename, mod.exports)
    const req = (name) => {
      if (mocks.has(name)) return mocks.get(name)
      const next = path.resolve(path.dirname(resolved), name)
      return load(next)
    }
    compiled.get(resolved).runInContext(context)(mod.exports, req, mod)
    return mod.exports
  }

  return load(filePath)
}

test('AsyncFrameCapturer double-buffers onto OffscreenCanvas, bounds in-flight, and preserves strict frame order', async () => {
  const createdCanvases = []
  const drawEvents = []
  const delivered = []

  class FakeOffscreenCanvas {
    constructor(width, height) {
      this.width = width
      this.height = height
      this.lastDrawId = -1
      createdCanvases.push(this)
    }
    getContext() {
      return {
        drawImage: (src) => {
          this.lastDrawId = src.currentFrame
          drawEvents.push(src.currentFrame)
        }
      }
    }
    convertToBlob() {
      const capturedId = this.lastDrawId
      // Deliberately invert completion timing: even frames resolve slower than odd frames
      const delayMs = capturedId % 2 === 0 ? 20 : 2
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            arrayBuffer: async () => new Uint8Array([capturedId]).buffer
          })
        }, delayMs)
      })
    }
  }

  const logger = { info() {}, warn() {}, error() {}, debug() {} }
  const { AsyncFrameCapturer } = loadTsModule(
    path.join(renderer, 'managers/video-export/AsyncFrameCapturer.ts'),
    new Map(),
    { OffscreenCanvas: FakeOffscreenCanvas }
  )

  const capturer = new AsyncFrameCapturer(logger, {
    width: 640,
    height: 360,
    quality: 0.9,
    batchSize: 30,
    framesDir: '/tmp/frames',
    maxQueueSize: 60,
    maxInFlight: 2,
    onFrame: async (index, data) => {
      delivered.push({ index, byte: data[0] })
    }
  })

  const liveCanvas = { currentFrame: 0 }
  for (let i = 0; i < 6; i++) {
    liveCanvas.currentFrame = i
    await capturer.captureFrameAsync(liveCanvas)
    // Immediately mutate live canvas after captureFrameAsync returns (simulates next render)
    liveCanvas.currentFrame = 999
  }
  await capturer.flushAll()
  await capturer.dispose()

  assert.ok(createdCanvases.length <= 3, `pool stayed bounded (${createdCanvases.length})`)
  assert.deepEqual(drawEvents, [0, 1, 2, 3, 4, 5])
  assert.deepEqual(
    delivered,
    [0, 1, 2, 3, 4, 5].map((i) => ({ index: i, byte: i }))
  )
})

test('JpegFrameSink uses image2pipe stream when supported and cancels unfinished pipe on dispose', async () => {
  const invoked = []
  class FakeOffscreenCanvas {
    constructor(w, h) {
      this.width = w
      this.height = h
    }
    getContext() {
      return { drawImage: () => {} }
    }
    async convertToBlob() {
      return { arrayBuffer: async () => new Uint8Array([0xff, 0xd8]).buffer }
    }
  }

  const mocks = new Map([
    [
      './ExportLogger',
      { ExportLogger: class { info() {} warn() {} error() {} debug() {} } }
    ]
  ])

  const windowMock = {
    electron: {
      ipcRenderer: {
        invoke: async (channel, payload) => {
          invoked.push({ channel, payload })
          if (channel === 'electron:frames-stream-start') {
            return { id: 'pipe-1', videoPath: '/tmp/mss-fpipe-1/video.mp4' }
          }
          if (channel === 'electron:frames-stream-finish') {
            return { videoPath: '/tmp/mss-fpipe-1/video.mp4' }
          }
          return null
        }
      }
    }
  }

  const { JpegFrameSink } = loadTsModule(
    path.join(renderer, 'managers/video-export/JpegFrameSink.ts'),
    mocks,
    {
      OffscreenCanvas: FakeOffscreenCanvas,
      window: windowMock,
      WebGL2RenderingContext: class {}
    }
  )

  const fakeCanvas = { getContext: () => ({}) }
  const sink = new JpegFrameSink({
    width: 1280,
    height: 720,
    quality: 0.92,
    framesDir: '/tmp/unused',
    fps: 30,
    crf: 23
  })
  await sink.initialize(fakeCanvas)
  assert.equal(sink.isPipeMode, true)
  await sink.captureFrame(fakeCanvas)
  await sink.captureFrame(fakeCanvas)
  const outVideo = await sink.finish()
  assert.equal(outVideo, '/tmp/mss-fpipe-1/video.mp4')
  assert.deepEqual(
    invoked.map((c) => c.channel),
    [
      'electron:frames-stream-start',
      'electron:frames-stream-chunk',
      'electron:frames-stream-chunk',
      'electron:frames-stream-finish'
    ]
  )

  // Unfinished session cancels cleanly on dispose
  invoked.length = 0
  const sink2 = new JpegFrameSink({
    width: 1280,
    height: 720,
    quality: 0.92,
    framesDir: '/tmp/unused'
  })
  await sink2.initialize(fakeCanvas)
  await sink2.dispose()
  assert.ok(invoked.some((c) => c.channel === 'electron:frames-stream-cancel'))
})

test('OfficialFilters callers destroy filters and detach tickers cleanly on layer teardown', () => {
  const destroyedFilters = []
  const tickerRemoved = []

  class FakeFilter {
    constructor() {
      this.destroyed = false
    }
    destroy() {
      this.destroyed = true
      destroyedFilters.push(this)
    }
  }
  class FakeContainer {
    constructor() {
      this.children = []
      this.filters = null
      this.pivot = { set() {} }
      this.position = { set() {} }
      this.scale = { set() {} }
    }
    addChild(...items) {
      this.children.push(...items)
    }
    removeChild(item) {
      this.children = this.children.filter((c) => c !== item)
    }
  }
  class FakeSprite extends FakeContainer {
    constructor(tex) {
      super()
      this.texture = tex
      this.anchor = { set() {} }
    }
  }
  class FakeColorMatrixFilter extends FakeFilter {
    constructor() {
      super()
      this.matrix = []
    }
  }
  const fakeTexture = { valid: true, baseTexture: { valid: true }, width: 100, height: 100 }
  const pixiMock = {
    Application: class {},
    Container: FakeContainer,
    Sprite: FakeSprite,
    Texture: { EMPTY: fakeTexture, WHITE: fakeTexture, from: () => fakeTexture },
    ColorMatrixFilter: FakeColorMatrixFilter,
    Ticker: {
      shared: {
        add() {},
        remove(fn) {
          tickerRemoved.push(fn)
        }
      }
    }
  }
  const filtersMock = {
    UI_GAUSSIAN_BLUR_DEFAULT_DISTANCE: 2.8,
    UIGaussianBlurFilter: class extends FakeFilter {},
    FlashbackFilter: class extends FakeFilter {
      constructor() {
        super()
        this.intensity = 0
      }
    },
    SepiaFilter: class extends FakeFilter {
      constructor() {
        super()
        this.intensity = 0
      }
    },
    Live2DBlurFilter: class extends FakeFilter {},
    Live2DHologramShaderFilter: class extends FakeFilter {
      step() {}
      setHoloTexture() {}
    },
    CameraBlurFilter: class extends FakeFilter {
      constructor() {
        super()
        this.spread = 0
      }
    }
  }

  const fakeApp = { screen: { width: 1280, height: 720 }, stage: new FakeContainer() }

  const BgLayer = loadTsModule(
    path.join(renderer, 'layers/BackgroundLayer.ts'),
    new Map([
      ['pixi.js', pixiMock],
      ['../effects/OfficialFilters', filtersMock],
      ['../managers/AnimationManager', { default: { linear: async () => {} } }]
    ])
  ).default
  const bg = new BgLayer(fakeApp)
  bg.destroy()

  const EnvLayer = loadTsModule(
    path.join(renderer, 'layers/EnvironmentLayer.ts'),
    new Map([
      ['pixi.js', pixiMock],
      ['../effects/OfficialFilters', filtersMock],
      ['../managers/AnimationManager', { default: { linear: async () => {} } }]
    ])
  ).default
  const env = new EnvLayer(fakeApp)
  env.destroy()

  const FxLayer = loadTsModule(
    path.join(renderer, 'layers/SpecialEffectLayer.ts'),
    new Map([
      ['pixi.js', pixiMock],
      ['../../assets/ui/ui_se_black.svg', 'black.svg'],
      ['../components/SEBlack', { default: FakeSprite }],
      ['../managers/AnimationManager', { default: { delay: async () => {}, linear: async () => {} } }],
      ['../effects/Ease', { runEasedTween: async () => {} }],
      ['../effects/InappTextures', { inappUrl: (p) => p, loadInappTexture: async () => null }],
      ['../effects/OfficialFilters', filtersMock],
      ['../effects/TriangleParticleEffect', { ScenarioEffectOverlay: FakeContainer, SekaiTransitionParticles: FakeContainer }],
      [path.join(root, 'src/common/official/timing'), { SEKAI_IN_FADE_DELAY_MS: 250, SEKAI_OUT_FADE_DELAY_MS: 500 }]
    ])
  ).default
  const fx = new FxLayer(fakeApp)
  fx.destroy()

  const MLayer = loadTsModule(
    path.join(renderer, 'layers/ModelLayer.ts'),
    new Map([
      ['pixi.js', pixiMock],
      ['pixi-live2d-display-advanced', { Cubism2InternalModel: class {} }],
      [path.join(root, 'src/common/types/Story'), { LayoutModes: { Normal: 'Normal', Three: 'Three' } }],
      [path.join(root, 'src/common/official/timing'), { MODEL_COLOR_EVENING: [1, 1, 1], MODEL_COLOR_NIGHT: [1, 1, 1] }],
      ['../effects/Ease', { evaluateEase: (x) => x }],
      ['../effects/InappTextures', { loadInappTexture: async () => null }],
      ['../effects/OfficialFilters', filtersMock],
      ['../managers/AnimationManager', { default: { linear: async () => {} } }],
      ['../model/AdvancedModel', { default: class {} }],
      ['../utils/StageUtils', { default: { modeScale: () => 1 } }],
      ['../utils/ResourceUrl', { resourceUrl: (p) => p }]
    ])
  ).default
  const ml = new MLayer(fakeApp)
  ml.setAmbientColor('night')
  ml.destroy()

  // UIGaussianBlurFilter (1) + FlashbackFilter (1) + SepiaFilter (1) + CameraBlurFilter (1) + ColorMatrixFilter (1)
  assert.equal(destroyedFilters.length, 5)
  assert.ok(destroyedFilters.every((f) => f.destroyed))
})
