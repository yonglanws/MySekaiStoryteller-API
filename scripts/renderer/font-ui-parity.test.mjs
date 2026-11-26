/**
 * Game Chinese Font & UI Rendering Parity tests against SekaiStoryExporter (CN 6.4.0).
 * Verifies bundled Source Han Sans SC Medium/Bold assets, preload/CSS declarations,
 * FontLoader deterministic loading, and exact typography/layout parity across all UI components.
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
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
const publicFontsDir = path.join(root, 'src/renderer/public/fonts')
const nodeRequire = createRequire(import.meta.url)

function readOpenTypeInfo(filePath) {
  const buf = fs.readFileSync(filePath)
  const sfnt = buf.subarray(0, 4).toString('ascii')
  const numTables = buf.readUInt16BE(4)
  let nameOff = 0
  let os2Off = 0
  let maxpOff = 0
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16
    const tag = buf.subarray(off, off + 4).toString('ascii')
    if (tag === 'name') nameOff = buf.readUInt32BE(off + 8)
    if (tag === 'OS/2') os2Off = buf.readUInt32BE(off + 8)
    if (tag === 'maxp') maxpOff = buf.readUInt32BE(off + 8)
  }
  const weight = os2Off ? buf.readUInt16BE(os2Off + 4) : 0
  const numGlyphs = maxpOff ? buf.readUInt16BE(maxpOff + 4) : 0
  const names = {}
  if (nameOff) {
    const count = buf.readUInt16BE(nameOff + 2)
    const strOff = nameOff + buf.readUInt16BE(nameOff + 4)
    for (let i = 0; i < count; i++) {
      const rec = nameOff + 6 + i * 12
      const plat = buf.readUInt16BE(rec)
      const enc = buf.readUInt16BE(rec + 2)
      const lang = buf.readUInt16BE(rec + 4)
      const nid = buf.readUInt16BE(rec + 6)
      const len = buf.readUInt16BE(rec + 8)
      const sOff = strOff + buf.readUInt16BE(rec + 10)
      if ([1, 2, 4, 6].includes(nid) && plat === 3 && enc === 1 && lang === 0x0409) {
        const raw = buf.subarray(sOff, sOff + len)
        let s = ''
        for (let j = 0; j < raw.length; j += 2) s += String.fromCharCode(raw.readUInt16BE(j))
        names[nid] = s
      }
    }
  }
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
  return { size: buf.length, sfnt, weight, numGlyphs, names, sha256 }
}

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
    }
  }
  class Filter {
    constructor(vertexSrc, fragmentSrc, uniforms = {}) {
      this.vertexSrc = vertexSrc
      this.fragmentSrc = fragmentSrc
      this.uniforms = { ...uniforms }
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
      this.valid = true
      this.baseTexture = { valid: true }
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
      isExporting: () => true,
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
      delay: () => Promise.resolve()
    }
  }
}

function createRendererLoader(extraMocks = new Map(), extraGlobals = {}) {
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
    Error,
    URL,
    setTimeout,
    clearTimeout,
    ...extraGlobals
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

test('bundled CN 6.4.0 game Chinese fonts exist with exact Source Han Sans SC Medium/Bold metadata and SHA-256', () => {
  const { load } = createRendererLoader()
  const { GAME_FONT_SPECS } = load('utils/FontLoader.ts')
  assert.equal(GAME_FONT_SPECS.length, 2)

  const expectedMeta = {
    'SourceHanSansSC-Medium.otf': {
      weight: 500,
      postScript: 'SourceHanSansSC-Medium',
      numGlyphs: 65535
    },
    'SourceHanSansSC-Bold.otf': {
      weight: 700,
      postScript: 'SourceHanSansSC-Bold',
      numGlyphs: 65535
    }
  }

  for (const spec of GAME_FONT_SPECS) {
    const filePath = path.join(publicFontsDir, spec.fileName)
    assert.ok(fs.existsSync(filePath), `missing bundled game font: ${filePath}`)
    const info = readOpenTypeInfo(filePath)
    assert.equal(info.sfnt, 'OTTO', `${spec.fileName} must be valid OpenType CFF`)
    assert.equal(info.weight, expectedMeta[spec.fileName].weight)
    assert.equal(info.numGlyphs, expectedMeta[spec.fileName].numGlyphs)
    assert.equal(info.names[6], expectedMeta[spec.fileName].postScript)
    assert.equal(info.sha256, spec.sha256, `${spec.fileName} SHA-256 must match CN 6.4.0 client`)
  }
})

test('index.html, main.css, staticRoutes.ts, and all UI components declare CN game fonts cleanly', () => {
  const indexHtml = fs.readFileSync(path.join(root, 'src/webrender/index.html'), 'utf8')
  assert.match(indexHtml, /rel="preload"[\s\S]*SourceHanSansSC-Medium\.otf[\s\S]*as="font"/)
  assert.match(indexHtml, /rel="preload"[\s\S]*SourceHanSansSC-Bold\.otf[\s\S]*as="font"/)

  const mainCss = fs.readFileSync(path.join(root, 'src/renderer/assets/main.css'), 'utf8')
  assert.match(mainCss, /font-family:\s*'SekaiCN-Medium'/)
  assert.match(mainCss, /font-family:\s*'SekaiCN-Bold'/)
  assert.match(mainCss, /SourceHanSansSC-Medium\.otf/)
  assert.match(mainCss, /SourceHanSansSC-Bold\.otf/)
  assert.match(mainCss, /font-display:\s*block/)
  assert.equal(
    mainCss.includes('MiSans-Medium.ttf'),
    false,
    'main.css must not bundle or reference MiSans-Medium.ttf'
  )

  const staticRoutes = fs.readFileSync(path.join(root, 'src/host/static/staticRoutes.ts'), 'utf8')
  assert.match(staticRoutes, /font\/otf/)
  assert.match(staticRoutes, /immutable/)

  for (const rel of [
    'components/UIText.ts',
    'components/UISpeakerText.ts',
    'components/UITelop.ts',
    'components/UIPlaceInfo.ts',
    'components/UIFullScreenText.ts',
    'components/UIChoiceDialog.ts',
    'components/UIWatermark.ts'
  ]) {
    const src = fs.readFileSync(path.join(rendererSrc, rel), 'utf8')
    assert.equal(
      src.includes('MiSans'),
      false,
      `${rel} must use bundled SekaiCN game fonts instead of MiSans`
    )
  }
})

test('FontLoader formulas match SekaiStoryExporter sse-text and ensureGameFontsLoaded loads deterministically', async () => {
  // 1. Non-DOM Node environment skips cleanly
  const nodeEnv = createRendererLoader()
  const flNode = nodeEnv.load('utils/FontLoader.ts')
  assert.ok(Math.abs(flNode.sseOutlineReachAtlasPx() - 4.2105263) < 1e-5)
  assert.ok(Math.abs(flNode.sseOutlineThickness(44) - 2 * 4.2105263 * (44 / 35)) < 1e-4)
  assert.ok(Math.abs(flNode.sseLineAdvance(44, -80) - 52.8) < 1e-6)
  assert.ok(Math.abs(flNode.sseLineAdvance(56, -32) - 94.08) < 1e-6)
  const skipped = await flNode.ensureGameFontsLoaded()
  assert.equal(skipped.skipped, true)
  assert.deepEqual(Array.from(skipped.loaded), [])

  // 2. Simulated browser DOM with FontFace + document.fonts + Canvas warm-up
  const addedFaces = []
  const loadCalls = []
  const canvasCalls = []
  class MockFontFace {
    constructor(family, source, descriptors) {
      this.family = family
      this.source = source
      this.weight = descriptors?.weight ?? 'normal'
      this.style = descriptors?.style ?? 'normal'
      this.status = 'unloaded'
    }
    async load() {
      this.status = 'loaded'
      return this
    }
  }
  const fontSet = {
    [Symbol.iterator]() {
      return addedFaces[Symbol.iterator]()
    },
    add(face) {
      addedFaces.push(face)
    },
    async load(shorthand, sample) {
      loadCalls.push({ shorthand, sample })
      return addedFaces
    },
    check(shorthand) {
      return addedFaces.some((f) => shorthand.includes(f.family) && f.status === 'loaded')
    },
    ready: Promise.resolve()
  }
  const mockDocument = {
    baseURI: 'http://127.0.0.1:9881/',
    fonts: fontSet,
    createElement(tag) {
      assert.equal(tag, 'canvas')
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          set font(v) {
            canvasCalls.push(v)
          },
          measureText: () => ({ width: 44 }),
          fillText: () => undefined
        })
      }
    }
  }

  const browserEnv = createRendererLoader(new Map(), {
    document: mockDocument,
    FontFace: MockFontFace
  })
  const fl = browserEnv.load('utils/FontLoader.ts')
  const first = await fl.ensureGameFontsLoaded()
  assert.equal(first.skipped, false)
  assert.deepEqual(Array.from(first.loaded), ['SekaiCN-Medium', 'SekaiCN-Bold'])
  assert.equal(addedFaces.length, 2)
  assert.equal(
    addedFaces[0].source,
    'url("http://127.0.0.1:9881/fonts/SourceHanSansSC-Medium.otf") format("opentype")'
  )
  assert.equal(
    addedFaces[1].source,
    'url("http://127.0.0.1:9881/fonts/SourceHanSansSC-Bold.otf") format("opentype")'
  )
  assert.equal(loadCalls.length, 2)
  assert.equal(canvasCalls.length, 2)

  // Memoized second call does not re-create FontFace entries
  const second = await fl.ensureGameFontsLoaded()
  assert.deepEqual(second, first)
  assert.equal(addedFaces.length, 2)

  // Strict failure when document.fonts.check returns false
  fl.resetGameFontLoaderCache()
  fontSet.check = () => false
  await assert.rejects(() => fl.ensureGameFontsLoaded({ strict: true }), /did not report loaded/)
})

test('UIText auto-sizes between [22, 44] and all UI components scale identically at 1280x720 (k=2/3)', () => {
  const anim = createImmediateAnimationManager()
  const inappMock = {
    inappUrl: (rel) => `/resources/inapp/jp-7.0.0/${rel}`,
    loadInappTexture: () => Promise.resolve(null)
  }
  const { load, pixi } = createRendererLoader(
    new Map([
      ['managers/AnimationManager.ts', anim],
      ['effects/InappTextures.ts', inappMock],
      ['assets/ui/ui_text_background.svg', 'ui_text_background.svg'],
      ['assets/ui/ui_text_underline.svg', 'ui_text_underline.svg'],
      ['assets/ui/ui_telop.svg', 'ui_telop.svg']
    ])
  )

  const { default: UIText, computeTalkBodyFontSizeRef } = load('components/UIText.ts')
  const { default: UISpeakerText } = load('components/UISpeakerText.ts')
  const { default: UIPlaceInfo } = load('components/UIPlaceInfo.ts')
  const { default: UIFullScreenText } = load('components/UIFullScreenText.ts')
  const { default: UIChoiceDialog } = load('components/UIChoiceDialog.ts')
  const { default: UILayer } = load('layers/UILayer.ts')
  const { computePixiTextPosition, sseOutlineThickness, sseLineAdvance } =
    load('utils/FontLoader.ts')

  // 1-3 lines stay at 44pt; 4+ lines auto-size down within [22, 44]
  assert.equal(computeTalkBodyFontSizeRef('一二三四五六七八九十'), 44)
  assert.equal(computeTalkBodyFontSizeRef('第一行\n第二行\n第三行'), 44)
  const fourLineSize = computeTalkBodyFontSizeRef('第一行\n第二行\n第三行\n第四行')
  assert.ok(fourLineSize < 44 && fourLineSize >= 22, `expected shrunk size, got ${fourLineSize}`)

  const k = 2 / 3
  const halfStroke44 = (sseOutlineThickness(44) * k) / 2
  const uiText = new UIText(1280, 720)
  assert.ok(Math.abs(uiText.x - (250 * k - halfStroke44)) < 1e-6)
  assert.ok(Math.abs(uiText.y - (858 * k - halfStroke44)) < 1e-6)
  assert.ok(Math.abs(uiText.style.fontSize - 44 * k) < 1e-6)
  assert.ok(Math.abs(uiText.style.lineHeight - 52.8 * k) < 1e-6)
  uiText.data = '第一行\n第二行\n第三行\n第四行'
  assert.ok(Math.abs(uiText.style.fontSize - fourLineSize * k) < 1e-6)
  const halfStrokeShrunk = (sseOutlineThickness(fourLineSize) * k) / 2
  assert.ok(Math.abs(uiText.x - (250 * k - halfStrokeShrunk)) < 1e-6)

  const speaker = new UISpeakerText(1280, 720)
  assert.ok(Math.abs(speaker.x - (230 * k - halfStroke44)) < 1e-6)
  assert.ok(Math.abs(speaker.y - (790 * k - halfStroke44)) < 1e-6)
  assert.equal(speaker.style.fill, '#EBEBF2')
  assert.equal(speaker.style.fontWeight, '700')

  // Verify PIXI v7 baseline compensation with realistic SourceHanSansSC-Bold metrics (ascent≈52, fontSize≈64 at 44px)
  const stroke44 = sseOutlineThickness(44)
  const lineH44 = sseLineAdvance(44, -80)
  const compName = computePixiTextPosition({
    frameX: 230,
    frameY: 790,
    fontSizeRef: 44,
    k: 1,
    strokeThickness: stroke44,
    lineHeight: lineH44,
    fontMetrics: { ascent: 52, fontSize: 64 }
  })
  const drawnNameX = compName.x + stroke44 / 2
  const drawnNameBaselineY = compName.y + stroke44 / 2 + 52 + Math.max(0, (lineH44 - 64) / 2)
  assert.ok(Math.abs(drawnNameX - 230) < 1e-6, `drawnNameX=${drawnNameX}`)
  assert.ok(
    Math.abs(drawnNameBaselineY - (790 + (30.8 * 44) / 35)) < 1e-6,
    `drawnNameBaselineY=${drawnNameBaselineY} must land at exact TMP 828.72`
  )
  assert.ok(compName.y < 790 - 15, `expected ~18.6px upward compensation, got y=${compName.y}`)

  const place = new UIPlaceInfo(1280, 720)
  const placeLabel = place.children[place.children.length - 1]
  assert.ok(Math.abs(placeLabel.style.fontSize - 40 * k) < 1e-6)
  assert.equal(placeLabel.style.strokeThickness, 0)
  assert.ok(Math.abs(placeLabel.x - 40 * k) < 1e-6)
  assert.ok(Math.abs(placeLabel.y - 63 * k) < 1e-6)

  const fst = new UIFullScreenText(1280, 720)
  const fstLabel = fst.children[fst.children.length - 1]
  assert.ok(Math.abs(fstLabel.style.fontSize - 56 * k) < 1e-6)
  assert.ok(Math.abs(fstLabel.style.lineHeight - 94.08 * k) < 1e-6)
  assert.equal(fstLabel.style.dropShadow, true)
  assert.equal(fstLabel.style.dropShadowColor, '#000000')
  assert.equal(fstLabel.style.dropShadowAngle, Math.PI / 2)
  assert.ok(
    Math.abs(fstLabel.style.dropShadowDistance - ((6.0 * 0.6770833) / 35.0) * 56 * k) < 1e-4
  )

  const choice = new UIChoiceDialog(1280, 720)
  const windowRoot = choice.children[0]
  assert.ok(Math.abs(windowRoot.position.x - 640) < 1e-6)
  assert.ok(Math.abs(windowRoot.position.y - (360 + 40 * k)) < 1e-6)

  // UILayer places both speaker and body inside wordsContainer so ShakeWindow shakes both
  const stage = new pixi.Container()
  const layerUI = new UILayer({ stage, screen: { width: 1280, height: 720 } })
  const container = layerUI.getContainer()
  const wordsContainer = container.children[3]
  assert.equal(
    wordsContainer.children.length,
    2,
    'wordsContainer must hold both speaker and body text per SekaiStoryExporter ShakeWindow'
  )
})
