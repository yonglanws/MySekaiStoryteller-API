/**
 * Official parity unit tests for SSE filters, DOTween easing, Telop drift fix & 21-sample curves,
 * PlaceInfo / FullScreenText / ChoiceDialog chrome, and StageUtils coordinates.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const rendererSrc = path.join(root, 'src/renderer/src')
const nodeRequire = createRequire(import.meta.url)

function createPixiMock() {
  class ObservablePoint {
    constructor(x = 0, y = 0) {
      this.x = x
      this.y = y
    }
    set(x = 0, y = x) {
      this.x = x
      this.y = y
    }
  }
  class Container {
    constructor() {
      this.children = []
      this.x = 0
      this.y = 0
      this.alpha = 1
      this.visible = true
      this.scale = new ObservablePoint(1, 1)
      this.pivot = new ObservablePoint(0, 0)
      this.position = new ObservablePoint(0, 0)
      this.filters = null
      this.parent = null
      this.mask = null
      this.sortableChildren = false
      this.zIndex = 0
    }
    addChild(...items) {
      for (const item of items) {
        item.parent = this
        this.children.push(item)
      }
      return items[0]
    }
    removeChild(item) {
      const idx = this.children.indexOf(item)
      if (idx >= 0) this.children.splice(idx, 1)
      if (item) item.parent = null
      return item
    }
    removeChildren() {
      const removed = this.children.splice(0)
      for (const child of removed) child.parent = null
      return removed
    }
    destroy() {}
  }
  class Graphics extends Container {
    constructor() {
      super()
      this.draws = []
    }
    clear() {
      this.draws.push({ op: 'clear' })
      return this
    }
    beginFill(color, alpha = 1) {
      this.draws.push({ op: 'beginFill', color, alpha })
      return this
    }
    lineStyle(...args) {
      this.draws.push({ op: 'lineStyle', args })
      return this
    }
    drawRect(...args) {
      this.draws.push({ op: 'drawRect', args })
      return this
    }
    drawRoundedRect(...args) {
      this.draws.push({ op: 'drawRoundedRect', args })
      return this
    }
    drawEllipse(...args) {
      this.draws.push({ op: 'drawEllipse', args })
      return this
    }
    endFill() {
      return this
    }
  }
  class Sprite extends Container {
    constructor(texture = Texture.EMPTY) {
      super()
      this.texture = texture
      this.anchor = new ObservablePoint(0, 0)
      this.width = texture?.width ?? 100
      this.height = texture?.height ?? 100
      this.tint = 0xffffff
    }
  }
  class TextStyle {
    constructor(opts = {}) {
      Object.assign(this, opts)
    }
  }
  class Text extends Container {
    constructor(text = '', style = new TextStyle()) {
      super()
      this.text = text
      this.style = style
      this.anchor = new ObservablePoint(0, 0)
      this.tint = 0xffffff
      this.width = String(text).length * 20
      this.height = 48
    }
  }
  class Filter {
    constructor(vertexSrc, fragmentSrc, uniforms = {}) {
      this.vertexSrc = vertexSrc
      this.fragmentSrc = fragmentSrc
      this.uniforms = { ...uniforms }
      this.enabled = true
      this.padding = 0
      this.resolution = 1
    }
  }
  class AlphaFilter {
    constructor(alpha = 1) {
      this.alpha = alpha
      this.resolution = 1
    }
  }
  class Texture {
    constructor(w = 16, h = 16) {
      this.width = w
      this.height = h
      this.baseTexture = { wrapMode: 0 }
    }
    static from() {
      return new Texture(64, 64)
    }
  }
  Texture.EMPTY = new Texture(0, 0)
  Texture.WHITE = new Texture(16, 16)

  return {
    Container,
    Graphics,
    Sprite,
    Text,
    TextStyle,
    Filter,
    AlphaFilter,
    Texture,
    WRAP_MODES: { REPEAT: 10497, CLAMP: 33071 }
  }
}

function createImmediateAnimationManager() {
  return {
    __esModule: true,
    default: {
      isExporting() {
        return true
      },
      linear(onUpdate, durationMs) {
        if (durationMs <= 0) {
          onUpdate(1)
          return Promise.resolve()
        }
        onUpdate(0)
        onUpdate(0.5)
        onUpdate(1)
        return Promise.resolve()
      },
      delay() {
        return Promise.resolve()
      }
    }
  }
}

function createRendererLoader(extraMocks = new Map()) {
  const pixi = createPixiMock()
  const context = vm.createContext({
    console,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Float32Array,
    Map,
    Set,
    Promise,
    Error
  })
  const modules = new Map()
  const compiled = new Map()

  function resolveFile(fromDir, spec) {
    const raw = path.resolve(fromDir, spec)
    for (const candidate of [raw, `${raw}.ts`, path.join(raw, 'index.ts')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    }
    return raw
  }

  function load(target) {
    const filename = path.isAbsolute(target) ? target : path.join(rendererSrc, target)
    if (modules.has(filename)) return modules.get(filename)
    if (!compiled.has(filename)) {
      compiled.set(
        filename,
        new vm.Script(
          `(function (exports, require) {\n${
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
      if (spec === 'pixi.js') return pixi
      if (extraMocks.has(spec)) return extraMocks.get(spec)
      if (!spec.startsWith('.')) return nodeRequire(spec)
      const resolved = resolveFile(path.dirname(filename), spec)
      const normalized = resolved.replace(/\\/g, '/')
      for (const [mockKey, mockVal] of extraMocks.entries()) {
        if (normalized.endsWith(mockKey.replace(/\\/g, '/'))) return mockVal
      }
      return load(resolved)
    }
    compiled.get(filename).runInContext(context)(exports, require)
    return exports
  }

  return { load, pixi }
}

test('OfficialFilters match SSE WGSL constants and use deterministic virtual clock', () => {
  const { load } = createRendererLoader()
  const filters = load('effects/OfficialFilters.ts')

  const flashback = new filters.FlashbackFilter(1)
  assert.deepEqual(Array.from(filters.FLASHBACK_MONOCHROME), [0.5, 0.5, 0.5])
  assert.deepEqual(Array.from(filters.FLASHBACK_TONE_COLOR), [0.5, 0.5, 0.5])
  assert.equal(flashback.uniforms.uInfluence, 0.5)
  flashback.intensity = 0.4
  assert.ok(Math.abs(flashback.uniforms.uInfluence - 0.2) < 1e-6)
  assert.ok(flashback.vertexSrc.includes('vMaxCoord'))

  const sepia = new filters.SepiaFilter(1)
  assert.equal(filters.SEPIA_INFLUENCE, 0.75)
  assert.deepEqual(Array.from(filters.SEPIA_TONE_COLOR), [1.07, 0.74, 0.43])
  assert.equal(sepia.uniforms.uInfluence, 0.75)

  const holoA = new filters.Live2DHologramShaderFilter({ seed: 12345 })
  const holoB = new filters.Live2DHologramShaderFilter({ seed: 12345 })
  for (let i = 0; i < 12; i++) {
    holoA.step(1 / 60)
    holoB.step(1 / 60)
  }
  assert.equal(holoA.uniforms.uScroll, holoB.uniforms.uScroll)
  assert.equal(holoA.uniforms.uLine, holoB.uniforms.uLine)
  assert.equal(holoA.uniforms.uSubAlpha, holoB.uniforms.uSubAlpha)

  const camBlur = new filters.CameraBlurFilter(0.5)
  assert.equal(camBlur.spread, 0.5)
  assert.ok(camBlur.fragmentSrc.includes('vMaxCoord'))

  const bgBlur = new filters.UIGaussianBlurFilter(2)
  assert.equal(bgBlur.samplingDistance, 2)

  const dolly = new filters.DollyZoomFilter()
  dolly.samplingDistance = 0.4
  dolly.distortion = 0.25
  assert.equal(dolly.uniforms.uSamplingDistance, 0.4)
  assert.equal(dolly.uniforms.uDistortion, 0.25)

  // Verify no real-time wall-clock rAF or performance.now calls inside deterministic effect modules.
  for (const rel of ['effects/HologramEffect.ts', 'effects/TriangleParticleEffect.ts', 'effects/OfficialFilters.ts']) {
    const js = ts.transpileModule(fs.readFileSync(path.join(rendererSrc, rel), 'utf8'), {
      compilerOptions: { removeComments: true, target: ts.ScriptTarget.ES2022 }
    }).outputText
    assert.equal(/\brequestAnimationFrame\b/.test(js), false, `${rel} must not use requestAnimationFrame`)
    assert.equal(/\bperformance\.now\b/.test(js), false, `${rel} must not use performance.now`)
  }
})

test('Ease evaluates exact DOTween OutQuad and OutQuart curves', async () => {
  const anim = createImmediateAnimationManager()
  const { load } = createRendererLoader(new Map([['managers/AnimationManager.ts', anim]]))
  const ease = load('effects/Ease.ts')

  assert.equal(ease.evaluateEase('OutQuad', 0), 0)
  assert.equal(ease.evaluateEase('OutQuad', 0.5), 0.75)
  assert.equal(ease.evaluateEase('OutQuad', 1), 1)
  assert.equal(ease.evaluateEase('OutQuart', 0.5), 1 - Math.pow(0.5, 4))

  const samples = []
  await ease.runEasedTween(200, 'OutQuad', (v) => samples.push(v))
  assert.deepEqual(samples.slice(0, 3), [0, 0.75, 1])
  assert.equal(samples.at(-1), 1)

  // <= 0ms completes immediately in one step without invoking AnimationManager
  const fast = []
  await ease.runEasedTween(0, 'OutQuad', (v) => fast.push(v))
  assert.deepEqual(fast, [1])
})

test('UITelop resets x cleanly across repeated shows and matches 21-sample official curves', async () => {
  const anim = createImmediateAnimationManager()
  const { load, pixi } = createRendererLoader(new Map([['managers/AnimationManager.ts', anim]]))
  const { default: UITelop, TELOP_SHOW_BASE_SCALE_X, TELOP_HIDE_ALPHA, sampleTelopCurve } = load(
    'components/UITelop.ts'
  )

  assert.equal(TELOP_SHOW_BASE_SCALE_X.length, 21)
  assert.equal(TELOP_HIDE_ALPHA.length, 21)
  assert.equal(sampleTelopCurve(TELOP_SHOW_BASE_SCALE_X, 0), 0)
  assert.equal(sampleTelopCurve(TELOP_SHOW_BASE_SCALE_X, 1), 1)

  const telop = new UITelop(pixi.Texture.EMPTY, 1920, 1080)
  assert.equal(telop.x, 0)
  await telop.show('First Telop')
  assert.equal(telop.x, 0, 'first telop must not leave permanent x offset')
  await telop.show('Second Telop')
  assert.equal(telop.x, 0, 'repeated telop must not accumulate +10px drift')
  await telop.show('Third Telop')
  assert.equal(telop.x, 0, 'third telop must still end at x === 0')
})

test('UIText uses official 1368.3px width and #FFFFFF fill without thick dark stroke', () => {
  const anim = createImmediateAnimationManager()
  const { load } = createRendererLoader(new Map([['managers/AnimationManager.ts', anim]]))
  const { default: UIText } = load('components/UIText.ts')

  const uiText = new UIText(1920, 1080)
  assert.equal(uiText.style.fill, '#FFFFFF')
  assert.equal(uiText.style.strokeThickness, 0)
  assert.equal(uiText.style.wordWrapWidth, 1368.3)
  assert.equal(uiText.x, 250)
  assert.equal(uiText.y, 858)
})

test('UIPlaceInfo, UIFullScreenText, and UIChoiceDialog manage official state transitions', async () => {
  const anim = createImmediateAnimationManager()
  const inappMock = {
    inappUrl: (rel) => `/resources/inapp/jp-7.0.0/${rel}`,
    loadInappTexture: () => Promise.resolve(null),
    preloadCommonInappTextures: () => Promise.resolve()
  }
  const { load } = createRendererLoader(
    new Map([
      ['managers/AnimationManager.ts', anim],
      ['effects/InappTextures.ts', inappMock]
    ])
  )

  const { default: UIPlaceInfo } = load('components/UIPlaceInfo.ts')
  const place = new UIPlaceInfo(1920, 1080)
  await place.show('Miyamasuzaka Girls Academy', 200)
  assert.equal(place.visible, true)
  assert.equal(place.x, 0)
  await place.close()
  assert.equal(place.visible, false)

  const { default: UIFullScreenText } = load('components/UIFullScreenText.ts')
  const fst = new UIFullScreenText(1920, 1080)
  await fst.show({ text: 'Monologue line 1', durationMs: 500, keepBars: true })
  assert.equal(fst.visible, true, 'keepBars=true leaves overlay visible between consecutive lines')
  await fst.show({ text: 'Monologue line 2', durationMs: 500, keepBars: false })
  await fst.hide()
  assert.equal(fst.visible, false)

  const { default: UIChoiceDialog } = load('components/UIChoiceDialog.ts')
  const choices = new UIChoiceDialog(1920, 1080)
  await choices.show(['Option A', 'Option B'], 1)
  assert.equal(choices.visible, false, 'choice dialog hides cleanly after choice resolves')
})

test('StageUtils resolves Normal, Three, LeftOver/RightOver and Under positions', () => {
  const { load } = createRendererLoader()
  const { default: StageUtils } = load('utils/StageUtils.ts')

  assert.equal(StageUtils.modeScale('Normal'), 1)
  assert.equal(StageUtils.modeScale('Three'), 0.9)

  const leftNormal = StageUtils.side_to_position('Left', 'Normal', 0)
  assert.ok(Math.abs(leftNormal.x - (0.5 - 350 / 1920)) < 1e-6)
  assert.equal(leftNormal.y, 0.5)

  const leftThree = StageUtils.side_to_position('Left', 'Three', 0)
  assert.ok(Math.abs(leftThree.x - (0.5 - 550 / 1920)) < 1e-6)

  const leftOver = StageUtils.side_to_position('LeftOver', 'Normal', 0)
  assert.ok(Math.abs(leftOver.x - (0.5 - 1779.2 / 1920)) < 1e-6)

  const rightOver = StageUtils.side_to_position('RightOver', 'Normal', 0)
  assert.ok(Math.abs(rightOver.x - (0.5 + 1779.2 / 1920)) < 1e-6)

  const leftUnder = StageUtils.side_to_position('Left', 'Normal', 20, true)
  assert.ok(Math.abs(leftUnder.x - (0.5 - 330 / 1920)) < 1e-6)
  assert.ok(leftUnder.y > 1.0, 'Under flag shifts vertical anchor below frame')
})

test('HologramEffect stays lazy until enabled and UIWatermark clears the MENU button', () => {
  const { load, pixi } = createRendererLoader(
    new Map([['effects/InappTextures.ts', { loadInappTexture: async () => null }]])
  )
  const { HologramEffect } = load('effects/HologramEffect.ts')
  const alphaFilter = new pixi.AlphaFilter(1)
  const model = { filters: [alphaFilter] }
  const effect = new HologramEffect(model, 1920, 1080)

  assert.equal(model.filters.length, 1, 'constructing HologramEffect must not apply hologram shader to non-hologram models')
  assert.equal(model.filters[0], alphaFilter)
  assert.equal(effect.parentFilters.length, 1, 'parentFilters exposes hologram shader only when applied by VisualEffectManager')
  const beforeScroll = effect.parentFilters[0].uniforms.uScroll
  effect.update(60)
  assert.equal(effect.parentFilters[0].uniforms.uScroll, beforeScroll, 'disabled HologramEffect ignores ticker steps')
  effect.enabled = true
  effect.update(60)
  assert.notEqual(effect.parentFilters[0].uniforms.uScroll, beforeScroll, 'enabled HologramEffect steps shader')

  const { default: UIWatermark } = load('components/UIWatermark.ts')
  const watermark = new UIWatermark(1920, 1080)
  assert.equal(watermark.anchor.x, 1)
  assert.ok(watermark.x <= 1808 - 20, `watermark right edge ${watermark.x} must stay left of [1808, 16, 96, 96] MENU button`)
})
