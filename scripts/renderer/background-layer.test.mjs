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

function createPixiHarness({ loadImpl, fromImpl } = {}) {
  const warnings = []
  const fakeConsole = {
    log() {},
    info() {},
    error(...args) {
      warnings.push(args.join(' '))
    },
    warn(...args) {
      warnings.push(args.join(' '))
    }
  }

  class FakeContainer {
    constructor() {
      this.children = []
      this.filters = null
      this.zIndex = 0
    }
    addChild(...items) {
      this.children.push(...items)
    }
  }

  class FakeBaseTexture {
    constructor(width, height, { valid = true, resource = null } = {}) {
      this.width = width
      this.height = height
      this.valid = valid
      this.destroyed = false
      this.resource = resource
      this._listeners = new Map()
    }
    once(event, fn) {
      if (!this._listeners.has(event)) this._listeners.set(event, [])
      this._listeners.get(event).push(fn)
    }
    emit(event, payload) {
      const list = this._listeners.get(event) ?? []
      this._listeners.delete(event)
      for (const fn of list) fn(payload)
    }
  }

  class FakeTexture {
    constructor(name, width = 2048, height = 1261, opts = {}) {
      this.name = name
      this.valid = opts.valid ?? true
      this.destroyed = opts.destroyed ?? false
      this.orig = { width, height }
      this.width = width
      this.height = height
      this.baseTexture = new FakeBaseTexture(width, height, {
        valid: opts.baseValid ?? this.valid,
        resource: opts.resource ?? { url: name }
      })
    }
  }
  FakeTexture.EMPTY = new FakeTexture('EMPTY', 0, 0, {
    valid: false,
    baseValid: false,
    resource: null
  })
  FakeTexture.from = fromImpl ?? (() => FakeTexture.EMPTY)

  class FakeSprite {
    constructor(texture = FakeTexture.EMPTY) {
      this.texture = texture
      this.visible = true
      this.alpha = 1
      this.scale = { x: 1, y: 1 }
      this.anchor = {
        x: 0,
        y: 0,
        set(x, y = x) {
          this.x = x
          this.y = y
        }
      }
      this.position = {
        x: 0,
        y: 0,
        set(x, y) {
          this.x = x
          this.y = y
        }
      }
      this._width = 0
      this._height = 0
    }
    get width() {
      return this._width
    }
    set width(v) {
      // Simulate real PixiJS Sprite behavior: setting width on 0-width texture collapses scale.x to 0
      const origW = this.texture?.orig?.width ?? 0
      this.scale.x = origW > 0 ? v / origW : 0
      this._width = origW > 0 ? v : 0
    }
    get height() {
      return this._height
    }
    set height(v) {
      const origH = this.texture?.orig?.height ?? 0
      this.scale.y = origH > 0 ? v / origH : 0
      this._height = origH > 0 ? v : 0
    }
  }

  class FakeFilter {
    constructor(dist = 0) {
      this.samplingDistance = dist
    }
    destroy() {}
  }

  const pixiMock = {
    Application: class {},
    Assets: {
      load: loadImpl ?? (async () => FakeTexture.EMPTY)
    },
    Container: FakeContainer,
    Sprite: FakeSprite,
    Texture: FakeTexture
  }

  const filtersMock = {
    UI_GAUSSIAN_BLUR_DEFAULT_DISTANCE: 2.8,
    UIGaussianBlurFilter: FakeFilter
  }

  const linearCalls = []
  const animMock = {
    default: {
      linear: async (cb, durationMs) => {
        linearCalls.push(durationMs)
        cb(0.5)
        cb(1)
      },
      delay: async () => {}
    }
  }

  const BgLayer = loadTsModule(
    path.join(renderer, 'layers/BackgroundLayer.ts'),
    new Map([
      ['pixi.js', pixiMock],
      ['../effects/OfficialFilters', filtersMock],
      ['../managers/AnimationManager', animMock]
    ]),
    { console: fakeConsole }
  ).default

  const fakeApp = { screen: { width: 1280, height: 720 }, stage: new FakeContainer() }
  return { BgLayer, fakeApp, FakeTexture, warnings, linearCalls }
}

test('BackgroundLayer applies preloaded texture synchronously when durationMs=0 and preserves current background on invalid/failed inputs', async () => {
  const { BgLayer, fakeApp, FakeTexture, warnings } = createPixiHarness({
    loadImpl: async () => {
      throw new Error('404 Not Found')
    },
    fromImpl: () => FakeTexture.EMPTY
  })

  const bg = new BgLayer(fakeApp)
  const [mainSprite] = bg.getContainer().children
  const tex1 = new FakeTexture('bg_a000301', 2048, 1261)

  // Must apply synchronously on the same tick before awaiting the returned promise
  const p = bg.changeBackground(tex1, 0)
  assert.equal(mainSprite.texture, tex1)
  assert.ok(mainSprite.width > 1280, 'background should fill official 2338x1440 scaled stage rect')
  assert.ok(mainSprite.scale.x > 0 && mainSprite.scale.y > 0)
  await p

  // Texture.EMPTY must not overwrite an existing valid background
  bg.setBackground(FakeTexture.EMPTY)
  assert.equal(mainSprite.texture, tex1)
  await bg.changeBackground(FakeTexture.EMPTY, 0)
  assert.equal(mainSprite.texture, tex1)

  // Failed URL load must warn and preserve existing valid background instead of wiping to black
  await bg.changeBackground('/resources/images/cloud/missing.webp', 0)
  assert.equal(mainSprite.texture, tex1)
  assert.ok(
    warnings.some((w) => w.includes('BackgroundLayer') && w.includes('missing.webp')),
    `expected BackgroundLayer warning for failed URL, got: ${warnings.join(' | ')}`
  )

  bg.destroy()
})

test('BackgroundLayer prevents PixiJS 0-scale collapse on unloaded 0x0 texture and re-applies stage rect once loaded', () => {
  const { BgLayer, fakeApp, FakeTexture } = createPixiHarness()
  const bg = new BgLayer(fakeApp)
  const [mainSprite] = bg.getContainer().children

  // Texture still loading from network: valid=false, orig=0x0, resource present
  const pendingTex = new FakeTexture('pending.webp', 0, 0, {
    valid: false,
    baseValid: false,
    resource: { url: 'pending.webp' }
  })

  bg.setBackground(pendingTex)
  assert.equal(mainSprite.texture, pendingTex)
  // Scale must NOT be collapsed to 0 while texture is 0x0
  assert.notEqual(mainSprite.scale.x, 0)
  assert.notEqual(mainSprite.scale.y, 0)

  // Simulate texture finishing load and emitting 'loaded'
  pendingTex.orig.width = 2048
  pendingTex.orig.height = 1261
  pendingTex.width = 2048
  pendingTex.height = 1261
  pendingTex.valid = true
  pendingTex.baseTexture.width = 2048
  pendingTex.baseTexture.height = 1261
  pendingTex.baseTexture.valid = true
  pendingTex.baseTexture.emit('loaded')

  assert.ok(mainSprite.width > 1280)
  assert.ok(mainSprite.height >= 720)
  assert.ok(mainSprite.scale.x > 0 && mainSprite.scale.y > 0)

  bg.destroy()
})

test('ChangeBackgroundImageSnippet recovers from missing imageId via fallback texture and keeps duration>0 non-blocking', async () => {
  const snippetWarnings = []
  const fakeLogger = {
    warn(...args) {
      snippetWarnings.push(args.join(' '))
    },
    info() {},
    debug() {},
    error() {}
  }

  const ChangeBackgroundImageSnippet = loadTsModule(
    path.join(renderer, 'snippets/ChangeBackgroundImageSnippet.ts'),
    new Map([
      ['../utils/Logger', { default: () => fakeLogger }],
      ['../managers/AnimationManager', { default: { delay: async () => {} } }]
    ])
  ).default

  const fallbackTex = { id: 'tex-1' }
  const applied = []
  let resolveCrossfade
  const crossfadePromise = new Promise((resolve) => {
    resolveCrossfade = resolve
  })

  const fakeApp = {
    storyManager: {
      storyData: {
        images: [{ id: 1, image: 'cloud/bg_a000301.webp' }]
      }
    },
    getTextureById(id) {
      if (id === 1) return fallbackTex
      throw new Error(`Texture with id ${id} not found`)
    },
    layerBackground: {
      changeBackground(tex, durationMs) {
        applied.push({ tex, durationMs })
        return durationMs > 0 ? crossfadePromise : Promise.resolve()
      }
    },
    layerModel: {
      resetAmbientColor() {}
    }
  }

  // Case 1: Missing imageId=99 recovers using fallback texture id=1 and stays non-blocking for duration=0.5s
  const snippet = new ChangeBackgroundImageSnippet(fakeApp, {
    type: 'ChangeBackgroundImage',
    wait: false,
    delay: 0,
    data: { imageId: 99, duration: 0.5 }
  })
  await snippet.runSnippet()
  assert.equal(applied.length, 1)
  assert.equal(applied[0].tex, fallbackTex)
  assert.equal(applied[0].durationMs, 500)
  assert.ok(snippetWarnings.some((w) => w.includes('99')))
  resolveCrossfade()

  // Case 2: All textures missing skips safely without throwing
  const emptyApp = {
    storyManager: { storyData: { images: [] } },
    getTextureById() {
      throw new Error('not found')
    },
    layerBackground: {
      changeBackground() {
        throw new Error('should not be called when no texture exists')
      }
    }
  }
  const emptySnippet = new ChangeBackgroundImageSnippet(emptyApp, {
    type: 'ChangeBackgroundImage',
    wait: false,
    delay: 0,
    data: { imageId: 1 }
  })
  await emptySnippet.runSnippet()
})
