/**
 * Worker reuse texture lifecycle tests:
 * Verifies sequential exports in one worker never hit stale/destroyed Texture caches
 * (`baseTexture = null` / `Cannot read properties of null (reading 'valid')`).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const rendererSrc = path.join(root, 'src/renderer/src')

function makePixiStub() {
  class BaseTexture {
    constructor(source) {
      this.source = source
      this.valid = true
      this.width = 64
      this.height = 64
      this.wrapMode = 0
    }
    destroy() {
      this.valid = false
    }
  }

  const globalCache = new Map()

  class Texture {
    constructor(baseTexture) {
      this.baseTexture = baseTexture
      this.valid = Boolean(baseTexture?.valid)
    }
    destroy(destroyBase = false) {
      this.valid = false
      if (destroyBase && this.baseTexture) {
        this.baseTexture.destroy()
      }
      this.baseTexture = null
    }
    static from(id) {
      if (!globalCache.has(id)) {
        globalCache.set(id, new Texture(new BaseTexture(id)))
      }
      return globalCache.get(id)
    }
  }
  Texture.WHITE = new Texture(new BaseTexture('WHITE'))
  Texture.EMPTY = new Texture(new BaseTexture('EMPTY'))

  return { BaseTexture, Texture, globalCache }
}

function loadInappWithEnv(pixiStub) {
  let imageCreatedCount = 0
  class FakeImage {
    constructor() {
      this.crossOrigin = ''
      this._src = ''
      this.onload = null
      this.onerror = null
    }
    set src(val) {
      this._src = val
      imageCreatedCount += 1
      queueMicrotask(() => this.onload?.())
    }
    get src() {
      return this._src
    }
  }

  const context = vm.createContext({
    console,
    Map,
    Set,
    Promise,
    Error,
    Image: FakeImage,
    fetch: async () => ({ ok: true })
  })

  const filename = path.join(rendererSrc, 'effects/InappTextures.ts')
  const transpiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename
  }).outputText

  const exports = {}
  const require = (spec) => {
    if (spec === 'pixi.js') return pixiStub
    throw new Error(`Unexpected dep: ${spec}`)
  }
  new vm.Script(`(function (exports, require) {\n${transpiled}\n})`, { filename }).runInContext(
    context
  )(exports, require)

  return { mod: exports, getImageCreatedCount: () => imageCreatedCount }
}

test('resetInappTextureCache evicts textures cleanly and auto-reloads invalidated textures', async () => {
  const pixi = makePixiStub()
  const { mod, getImageCreatedCount } = loadInappWithEnv(pixi)

  const tex1 = await mod.loadInappTexture('player/loose/Sprite/bg_story_adv.png')
  assert.ok(tex1 && mod.isTextureUsable(tex1))
  assert.equal(getImageCreatedCount(), 1)
  assert.equal(mod.getCachedInappTexture('player/loose/Sprite/bg_story_adv.png'), tex1)

  // Calling again while valid reuses the cache
  const tex1Cached = await mod.loadInappTexture('player/loose/Sprite/bg_story_adv.png')
  assert.equal(tex1Cached, tex1)
  assert.equal(getImageCreatedCount(), 1)

  // Sequential export teardown via resetInappTextureCache
  mod.resetInappTextureCache()
  assert.equal(tex1.valid, false)
  assert.equal(tex1.baseTexture, null)
  assert.equal(mod.getCachedInappTexture('player/loose/Sprite/bg_story_adv.png'), null)

  // Export #2 must reload cleanly rather than returning destroyed tex1
  const tex2 = await mod.loadInappTexture('player/loose/Sprite/bg_story_adv.png')
  assert.ok(tex2 && mod.isTextureUsable(tex2))
  assert.notEqual(tex2, tex1)
  assert.equal(getImageCreatedCount(), 2)

  // Even if Pixi externally destroys a texture, getCachedInappTexture / loadInappTexture auto-evicts
  tex2.destroy(true)
  assert.equal(mod.getCachedInappTexture('player/loose/Sprite/bg_story_adv.png'), null)
  const tex3 = await mod.loadInappTexture('player/loose/Sprite/bg_story_adv.png')
  assert.ok(tex3 && mod.isTextureUsable(tex3))
  assert.notEqual(tex3, tex2)
  assert.equal(getImageCreatedCount(), 3)
})

test('App.ts preserves shared/global base textures across sequential Pixi Application resets', () => {
  const appSource = fs.readFileSync(path.join(rendererSrc, 'app/App.ts'), 'utf8')
  assert.match(appSource, /resetInappTextureCache\(\)/)
  assert.match(appSource, /texture:\s*false/)
  assert.match(appSource, /baseTexture:\s*false/)

  // Verify preserving shared textures in sequential destroy cycles keeps Texture.WHITE & SVG textures valid
  const pixi = makePixiStub()
  const svgTex = pixi.Texture.from('ui_se_black.svg')
  const { mod } = loadInappWithEnv(pixi)

  // Lifecycle 1 -> reset before Lifecycle 2
  mod.resetInappTextureCache()
  assert.equal(pixi.Texture.WHITE.valid, true)
  assert.equal(pixi.Texture.WHITE.baseTexture.valid, true)
  assert.equal(svgTex.valid, true)
  assert.equal(svgTex.baseTexture.valid, true)
})
