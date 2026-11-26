import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const nodeRequire = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const renderer = path.join(root, 'src/renderer/src')

function createLoader(extraMocks = new Map()) {
  const tickerListeners = new Set()
  const sharedTicker = {
    maxFPS: 60,
    add(fn) {
      tickerListeners.add(fn)
    },
    remove(fn) {
      tickerListeners.delete(fn)
    },
    emit(delta = 1) {
      for (const fn of [...tickerListeners]) fn(delta)
    }
  }
  const context = vm.createContext({
    console,
    performance,
    setTimeout,
    clearTimeout,
    AbortController,
    AbortSignal,
    URL,
    TextEncoder,
    TextDecoder
  })
  class AlphaFilter {
    constructor(alpha = 0) {
      this.alpha = alpha
    }
  }
  class Filter {
    destroy() {}
  }
  class Container {
    constructor() {
      this.children = []
      this.visible = true
      this.alpha = 1
      this.x = 0
      this.y = 0
      this.scale = {
        x: 1,
        y: 1,
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
      this.filters = null
    }
    addChild(...items) {
      for (const child of items) {
        this.children.push(child)
        child.parent = this
      }
      return items[0]
    }
    removeChild(child) {
      const idx = this.children.indexOf(child)
      if (idx >= 0) this.children.splice(idx, 1)
      if (child.parent === this) child.parent = null
      return child
    }
  }
  class Sprite extends Container {
    constructor() {
      super()
      this.anchor = {
        x: 0,
        y: 0,
        set(x, y = x) {
          this.x = x
          this.y = y
        }
      }
      this.width = 100
      this.height = 100
    }
  }
  class Text extends Container {
    constructor(text = '', style = {}) {
      super()
      this.style = style
      this.text = text
      this.anchor = {
        x: 0,
        y: 0,
        set(x, y = x) {
          this.x = x
          this.y = y
        }
      }
    }
  }
  class TextStyle {
    constructor(opts = {}) {
      Object.assign(this, opts)
    }
  }
  class Graphics extends Container {
    clear() {
      return this
    }
    beginFill() {
      return this
    }
    lineStyle() {
      return this
    }
    drawRect() {
      return this
    }
    drawRoundedRect() {
      return this
    }
    endFill() {
      return this
    }
  }
  class Live2DModel extends Container {
    destroy() {
      this.destroyed = true
    }
  }
  class Cubism2InternalModel {}
  class Cubism4InternalModel {}
  class Logger {
    info() {}
    warn() {}
    error() {}
    debug() {}
    getSubLogger() {
      return this
    }
  }
  const animation = {
    linear: async (cb) => {
      cb(1)
    },
    delay: async () => {},
    isExporting: () => false,
    in_ticker: async () => {},
    exportEncodeFPS: 30
  }
  const mocks = new Map([
    [
      'pixi-live2d-display-advanced',
      { Live2DModel, Cubism2InternalModel, Cubism4InternalModel, MotionPriority: { FORCE: 3 } }
    ],
    [
      'pixi.js',
      {
        AlphaFilter,
        Filter,
        Container,
        Sprite,
        Text,
        TextStyle,
        Graphics,
        Texture: { from: () => ({}) },
        Ticker: { shared: sharedTicker }
      }
    ],
    ['tslog', { Logger }],
    [path.join(renderer, 'utils/Logger.ts'), { default: () => new Logger() }],
    [path.join(renderer, 'managers/AnimationManager.ts'), { default: animation }],
    ...extraMocks
  ])

  const modules = new Map()
  const compiled = new Map()
  function load(target) {
    const filename = path.isAbsolute(target) ? target : path.join(renderer, target)
    if (mocks.has(filename)) return mocks.get(filename)
    if (modules.has(filename)) return modules.get(filename)
    if (!compiled.has(filename)) {
      compiled.set(
        filename,
        new vm.Script(
          `(function (exports, require) {\n${
            ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
              compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
              fileName: filename
            }).outputText
          }\n})`,
          { filename }
        )
      )
    }
    const exports = {}
    modules.set(filename, exports)
    const require = (name) => {
      if (mocks.has(name)) return mocks.get(name)
      if (name.endsWith('.svg')) return 'mock-svg'
      if (!name.startsWith('.')) return nodeRequire(name)
      const base = path.resolve(path.dirname(filename), name)
      for (const candidate of [`${base}.ts`, path.join(base, 'index.ts'), base]) {
        if (mocks.has(candidate)) return mocks.get(candidate)
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return load(candidate)
      }
      throw new Error(`Cannot resolve ${name} from ${filename}`)
    }
    compiled.get(filename).runInContext(context)(exports, require)
    return exports
  }
  return {
    load,
    sharedTicker,
    tickerListeners,
    Cubism4InternalModel,
    Filter,
    AlphaFilter,
    animation
  }
}

test('isMotionLooping and getMotionDurationMs inspect runtime loop state rather than raw Meta.Loop', () => {
  const loader = createLoader()
  const AdvancedModel = loader.load('model/AdvancedModel.ts').default
  const model = Object.create(AdvancedModel.prototype)
  let currentLoop = true
  const motion = {
    _motionData: { loop: true, duration: 2.6 },
    setIsLoop(v) {
      currentLoop = Boolean(v)
    },
    isLoop() {
      return currentLoop
    },
    getDuration() {
      return 2.6
    }
  }
  model.internalModel = {
    motionManager: {
      motionGroups: {
        'w-normal-trouble01': [motion],
        'm-prop-only': [{ _motionData: { loop: true, duration: 1.5 }, _isLoop: false }]
      }
    }
  }

  model.syncMotionLoopFlag(motion)
  assert.equal(model.isMotionLooping('w-normal-trouble01'), false)
  assert.equal(model.getMotionDurationMs('w-normal-trouble01'), 2600)
  assert.equal(model.isMotionLooping('m-prop-only'), false)
  assert.equal(model.getMotionDurationMs('m-prop-only'), 1500)
})

test('channel-1 facial default reset restores omitted params to default while preserving crossfade for shared params', () => {
  const loader = createLoader()
  const AdvancedModel = loader.load('model/AdvancedModel.ts').default
  const paramValues = new Map([
    ['ParamKirakira', 1],
    ['ParamEyeLSmile', 0.8],
    ['ParamCheekAngry', 0],
    ['ParamBrowWrinkleL', 0],
    ['ParamMouthForm2', 0]
  ])
  const defaults = new Map([
    ['ParamKirakira', 0],
    ['ParamEyeLSmile', 0],
    ['ParamCheekAngry', 0],
    ['ParamBrowWrinkleL', 0],
    ['ParamMouthForm2', 0]
  ])
  const paramIds = [...paramValues.keys()]

  const faceA = {
    _motionData: {
      curves: [{ id: 'ParamKirakira' }, { id: 'ParamEyeLSmile' }]
    }
  }
  const faceB = {
    _motionData: {
      curves: [{ id: 'ParamEyeLSmile' }]
    }
  }
  const queueMotions = [
    { isFinished: () => false, _motion: faceA },
    { isFinished: () => false, _motion: faceB }
  ]
  const seenBeforeUpdate = []
  const channel1Manager = {
    queueManager: { _motions: queueMotions },
    update() {
      seenBeforeUpdate.push({
        kirakira: paramValues.get('ParamKirakira'),
        smile: paramValues.get('ParamEyeLSmile')
      })
      return true
    }
  }

  const model = Object.create(AdvancedModel.prototype)
  model.facialManagedParamIds = new Set()
  model.defaultParamValues = new Map()
  model.modelParamIds = new Set(paramIds)
  model.internalModel = {
    coreModel: {
      _parameterIds: paramIds,
      getParameterIndex: (id) => paramIds.indexOf(id),
      getParameterDefaultValue: (idx) => defaults.get(paramIds[idx]) ?? 0,
      getParameterValueById: (id) => paramValues.get(id) ?? 0,
      setParameterValueById: (id, v) => paramValues.set(id, v)
    },
    parallelMotionManager: [{}, channel1Manager]
  }

  model.seedDefaultParameterValues()
  model.installFacialDefaultReset()

  // Update 1 during faceA -> faceB crossfade:
  // ParamKirakira (omitted in faceB) is reset to default 0 before queue update,
  // while ParamEyeLSmile (present in both) keeps 0.8 so crossfade interpolates without dipping.
  channel1Manager.update(model.internalModel.coreModel, 1.0)
  assert.deepEqual(seenBeforeUpdate[0], { kirakira: 0, smile: 0.8 })

  // Extended facial isolation covers PJSK special facial parameters & managed params.
  const isolated = model.facialIsolationParamIds({
    includeEyeOpen: false,
    includeMouthOpen: false,
    includeNonEyeOpenFacial: true
  })
  assert.ok(isolated.includes('ParamKirakira'))
  assert.ok(isolated.includes('ParamCheekAngry'))
  assert.ok(isolated.includes('ParamBrowWrinkleL'))
  assert.ok(isolated.includes('ParamMouthForm2'))

  model.bodyIgnoredParamIds = []
  model.bodyAllowEyeOverride = true
  model.currentFacialName = null
  model.facialManagedParamIds.add('ParamSpecialCustom')
  model.modelParamIds.add('ParamSpecialCustom')
  assert.ok(model.getEffectiveBodyIgnoredParamIds().includes('ParamSpecialCustom'))
})

test('applyCharacterAction applies body motions immediately without 800ms deferral when talkDurationMs is omitted', async () => {
  const loader = createLoader()
  const AdvancedModel = loader.load('model/AdvancedModel.ts').default
  const delayCalls = []
  loader.animation.delay = async (ms) => {
    delayCalls.push(ms)
  }

  const model = Object.create(AdvancedModel.prototype)
  model.destroyed = false
  model.actionController = new AbortController()
  model.channelGeneration = [0, 0]
  model.currentBodyMotion = 'w-normal-nod01'
  model.currentBodyStartedAt = 0
  model.currentBodyClipDurationMs = 2000
  model.internalModel = {
    parallelMotionManager: [
      { playing: true, isFinished: () => false },
      { playing: false, isFinished: () => true }
    ]
  }
  model.isMotionLooping = () => false
  model.eyeParameterIds = () => ['ParamEyeROpen', 'ParamEyeLOpen']
  model.facialIsolationParamIds = () => []
  const started = []
  model.startCharacterChannel = async (ch, name, _ignored, _sig, _can, _chain, _idx, opts) => {
    started.push({ ch, name, opts })
  }

  await model.applyCharacterAction({ motion: 'w-happy-glad01', facial: 'face_smile_01' })
  assert.equal(delayCalls.length, 0)
  assert.equal(
    JSON.stringify(started),
    JSON.stringify([
      { ch: 0, name: 'w-happy-glad01', opts: undefined },
      { ch: 1, name: 'face_smile_01', opts: { facialForce: false } }
    ])
  )

  // With talkDurationMs > 0 (TalkSnippet), early body interrupt deferral still triggers cleanly.
  model.currentBodyStartedAt = performance.now()
  await model.applyCharacterAction({ motion: 'w-happy-glad02' }, undefined, undefined, undefined, {
    talkDurationMs: 2500
  })
  assert.equal(delayCalls.length, 1)
  assert.ok(delayCalls[0] >= 750 && delayCalls[0] <= 800)
})

test('MotionSnippet uses isModelShown during alpha=0 LayoutAppear and MoveSnippet does not drop body motions', async () => {
  const loader = createLoader()
  const MotionSnippet = loader.load('snippets/MotionSnippet.ts').default
  const MoveSnippet = loader.load('snippets/MoveSnippet.ts').default

  const applied = []
  const startMotionCalls = []
  const fakeModel = {
    actionSignal: new AbortController().signal,
    applyCharacterAction: async (action, _sig, canApply) => {
      assert.equal(canApply(), true)
      applied.push(action)
    },
    isMotionLooping: () => false,
    getMotionDurationMs: () => 500,
    startMotions: async (motion, facial, facialFirst, opts) => {
      startMotionCalls.push({ motion, facial, facialFirst, opts })
    },
    setPositionRel: () => {},
    move: async () => {},
    moveRel: async () => {}
  }

  const fakeApp = {
    stage_size: [1920, 1080],
    layerModel: {
      layoutMode: 'Normal',
      isModelVisible: () => false, // alpha still 0 during LayoutAppear fade-in frame 0
      isModelShown: () => true,
      setLayoutDepth: () => {}
    },
    getModelById: () => fakeModel,
    videoExportManager: { signal: new AbortController().signal }
  }

  const motionSnippet = new MotionSnippet(
    fakeApp,
    {
      type: 'Motion',
      delay: 0,
      data: {
        modelId: -1,
        duration: 0.02,
        actions: [{ at: 0, modelId: 1, motion: 'w-normal-nod01', facial: 'face_smile_01' }]
      }
    },
    0
  )
  await motionSnippet.handleSnippet()
  assert.equal(applied.length, 1)
  assert.equal(applied[0].motion, 'w-normal-nod01')

  const moveSnippet = new MoveSnippet(
    fakeApp,
    {
      type: 'Move',
      delay: 0,
      data: {
        modelId: 0,
        from: { side: 'Left', offset: 0, under: false },
        to: { side: 'Center', offset: 0, under: false },
        moveSpeed: 0,
        motion: 'w-happy-glad01',
        facial: 'face_smile_01',
        facialFirst: true
      }
    },
    1
  )
  await moveSnippet.handleSnippet()
  assert.equal(startMotionCalls.length, 1)
  assert.equal(startMotionCalls[0].opts.preserveActiveShortBodyMotion, undefined)
})

test('VisualEffectManager detaches Ticker.shared listener on destroy and syncs filters without duplicates', () => {
  const loader = createLoader(
    new Map([
      [
        path.join(renderer, 'effects/HologramEffect.ts'),
        {
          HologramEffect: class {
            constructor() {
              this.enabled = false
              this.parent = null
              this.parentFilters = [{ tag: 'holo' }]
            }
            update() {}
            clearAllParticles() {}
          }
        }
      ],
      [
        path.join(renderer, 'effects/TriangleParticleEffect.ts'),
        {
          default: class {
            constructor() {
              this.enabled = false
              this.parent = null
              this.parentFilters = []
            }
            update() {}
            clearAllParticles() {}
          }
        }
      ]
    ])
  )
  const { VisualEffectManager } = loader.load('managers/VisualEffectManager.ts')
  const baseFilter = { tag: 'alpha' }
  const model = {
    filters: [baseFilter],
    children: [],
    addChild(c) {
      this.children.push(c)
      c.parent = this
    },
    removeChild(c) {
      c.parent = null
    }
  }
  const vfx = new VisualEffectManager(model)
  assert.equal(loader.tickerListeners.size, 1)
  vfx.createAll()
  vfx.applyEffect('hologram')
  vfx.applyEffect('hologram')
  assert.equal(model.filters.length, 2)
  assert.equal(
    vfx
      .getActiveFilters()
      .map((f) => f.tag)
      .join(','),
    'holo'
  )

  vfx.destroy()
  assert.equal(loader.tickerListeners.size, 0)
  assert.equal(model.filters.map((f) => f.tag).join(','), 'alpha')
})

test('UILayer sets UITalkShowed false immediately on hideTextBackground and lets showTextBackground reopen cleanly', async () => {
  const pendingHides = []
  const fadableMock = () => ({
    default: class {
      constructor() {
        this.text = ''
        this.data = ''
      }
      show() {
        return Promise.resolve()
      }
      hide(ms) {
        if (ms > 0) {
          return new Promise((resolve) => {
            pendingHides.push(resolve)
          })
        }
        return Promise.resolve()
      }
      startDisplayContent() {
        return Promise.resolve()
      }
    }
  })
  const loader = createLoader(
    new Map([
      [path.join(renderer, 'components/UITextBackground.ts'), fadableMock()],
      [path.join(renderer, 'components/UITextUnderline.ts'), fadableMock()],
      [path.join(renderer, 'components/UIText.ts'), fadableMock()],
      [path.join(renderer, 'components/UISpeakerText.ts'), fadableMock()],
      [path.join(renderer, 'components/UITelop.ts'), fadableMock()],
      [path.join(renderer, 'components/UIWatermark.ts'), fadableMock()],
      [path.join(renderer, 'components/UIPlaceInfo.ts'), fadableMock()],
      [path.join(renderer, 'components/UIFullScreenText.ts'), fadableMock()],
      [path.join(renderer, 'components/UIChoiceDialog.ts'), fadableMock()]
    ])
  )
  const UILayer = loader.load('layers/UILayer.ts').default
  const ui = new UILayer({ screen: { width: 1920, height: 1080 }, stage: { addChild() {} } })
  await ui.showTextBackground(200)
  assert.equal(ui.UITalkShowed, true)

  const hiding = ui.hideTextBackground(200)
  assert.equal(
    ui.UITalkShowed,
    false,
    'UITalkShowed must reset immediately when hideTextBackground begins'
  )

  // Overlapping showTextBackground while hideTextBackground is still fading must keep UITalkShowed true
  await ui.showTextBackground(200)
  assert.equal(ui.UITalkShowed, true)
  while (pendingHides.length > 0) pendingHides.shift()()
  await hiding
  assert.equal(
    ui.UITalkShowed,
    true,
    'stale hideTextBackground completion must not clobber active UITalkShowed'
  )

  await ui.hideTextBackground(0)
  assert.equal(ui.UITalkShowed, false)
})

test('GpuYuv420Converter dimension check and VideoExportManager lipScaleForSnippet fallback', () => {
  const loader = createLoader()
  const { GpuYuv420Converter } = loader.load('managers/video-export/GpuYuv420Converter.ts')
  assert.equal(GpuYuv420Converter.isSupportedDimensions(1920, 1080), true)
  assert.equal(GpuYuv420Converter.isSupportedDimensions(1280, 720), true)
  assert.equal(GpuYuv420Converter.isSupportedDimensions(854, 480), false)
  assert.equal(GpuYuv420Converter.create(1920, 1080), null) // no WebGL2 in Node -> clean fallback

  const VideoExportManager = loader.load('managers/VideoExportManager.ts').default
  const mgr = Object.create(VideoExportManager.prototype)
  mgr.app = {
    getModelById: () => {
      throw new Error('Model not mounted yet')
    },
    storyManager: {
      storyData: {
        models: [
          { id: 0, model: 'resources/models/01ichika_normal/01ichika_normal.model3.json' },
          { id: 1, model: 'resources/models/20mizuki_normal/20mizuki_normal.model3.json' }
        ]
      }
    }
  }
  const snippets = [
    { type: 'Talk', data: { modelId: 0 } },
    { type: 'Talk', data: { modelId: 1 } }
  ]
  assert.equal(mgr.lipScaleForSnippet(snippets, 0), 1.25)
  assert.equal(mgr.lipScaleForSnippet(snippets, 1), 1)
})

test('FadableSprite, UIText, UISpeakerText, and AdvancedModel eliminate steady-state AlphaFilter and cancel overlapping fades', async () => {
  const loader = createLoader()
  const { AlphaFilter, Filter } = loader

  // Drive controllable linear steps so hide(200) and show(200) overlap mid-flight
  const activeTweens = []
  loader.animation.linear = (cb, durationMs) => {
    if (durationMs <= 0) {
      cb(1)
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      activeTweens.push({ cb, resolve })
    })
  }

  const UILayer = loader.load('layers/UILayer.ts').default
  const AdvancedModel = loader.load('model/AdvancedModel.ts').default

  const ui = new UILayer({ screen: { width: 1920, height: 1080 }, stage: { addChild() {} } })
  const bg = ui.textBackgroundSprite
  const underline = ui.textUnderlineSprite
  const words = ui.textSprite
  const speaker = ui.textSpeakerSprite

  // 1. Steady-state opaque (alpha >= 0.999): AlphaFilter MUST be detached (filters === null)
  const open1 = ui.showTextBackground(200)
  assert.ok(bg.filters?.[0] instanceof AlphaFilter, 'AlphaFilter attached during fade-in')
  for (const t of activeTweens.splice(0)) {
    t.cb(0.5)
    t.cb(1)
    t.resolve()
  }
  await open1
  assert.equal(bg.visible, true)
  assert.equal(bg.filters, null, 'opaque UITextBackground must clear filters')
  assert.equal(underline.filters, null, 'opaque UITextUnderline must clear filters')
  assert.equal(words.filters, null, 'opaque UIText must clear filters')
  assert.equal(speaker.filters, null, 'opaque UISpeakerText must clear filters')

  // 2. Overlapping hideTextBackground(200) interrupted mid-fade by showTextBackground(200)
  const hideTask = ui.hideTextBackground(200)
  assert.equal(ui.UITalkShowed, false)
  const hideTweens = activeTweens.splice(0)
  // Step hide halfway (alpha = 0.5)
  for (const t of hideTweens) t.cb(0.5)
  assert.ok(bg.filters?.[0] instanceof AlphaFilter)
  assert.ok(Math.abs(bg.filters[0].alpha - 0.5) < 1e-6)

  // Interrupt with next Talk's showTextBackground(200)
  const reopenTask = ui.showTextBackground(200)
  assert.equal(ui.UITalkShowed, true)
  const showTweens = activeTweens.splice(0)

  // Stale hide completes to 100% -> MUST NOT clobber alpha to 0 or set visible=false!
  for (const t of hideTweens) {
    t.cb(1)
    t.resolve()
  }
  await hideTask
  assert.equal(bg.visible, true, 'stale hide must not hide active FadableSprite')
  assert.equal(words.visible, true, 'stale hide must not hide active UIText')
  assert.equal(ui.UITalkShowed, true, 'stale hide must not reset UITalkShowed')

  // Reopen starts smoothly from 0.5 -> 1.0 and detaches AlphaFilter at steady-state
  for (const t of showTweens) t.cb(0)
  assert.ok(Math.abs(bg.filters[0].alpha - 0.5) < 1e-6, 'show must resume from current alpha 0.5')
  for (const t of showTweens) {
    t.cb(1)
    t.resolve()
  }
  await reopenTask
  assert.equal(bg.visible, true)
  assert.equal(bg.filters, null, 'reopened FadableSprite clears AlphaFilter at alpha=1')
  assert.equal(words.filters, null, 'reopened UIText clears AlphaFilter at alpha=1')
  assert.equal(speaker.filters, null, 'reopened UISpeakerText clears AlphaFilter at alpha=1')

  // 3. AdvancedModel removes AlphaFilter at steady-state opaque/hidden while preserving non-alpha filters
  const model = Object.create(AdvancedModel.prototype)
  model.destroyed = false
  model.visible = true
  model.inHologram = false
  model.alphaFilter = new AlphaFilter(0)
  model.modelOpacity = 0
  model.filters = [model.alphaFilter]
  model.characterShaderFilter = new Filter()
  model.ambientColorFilter = null
  model.visualEffectManager = { getActiveFilters: () => [], applyEffect() {}, disableAll() {} }
  model.blinkState = { nextBlinkAt: 0 }
  model.cancelPendingActions = () => {}
  model.isVisibilityCurrent = () => true
  model.syncModelFilters()
  assert.equal(model.filters.length, 2, 'initial alpha=0 with visible=true keeps AlphaFilter + shaderFilter')

  const modelShow = model.show(200, false)
  const modelShowTweens = activeTweens.splice(0)
  for (const t of modelShowTweens) {
    t.cb(0.5)
    assert.equal(model.filters[0], model.alphaFilter, 'AlphaFilter active during fade')
    t.cb(1)
    t.resolve()
  }
  await modelShow
  assert.equal(model.visible, true)
  assert.equal(model.filters.length, 1)
  assert.equal(
    model.filters[0],
    model.characterShaderFilter,
    'opaque AdvancedModel detaches AlphaFilter while preserving characterShaderFilter'
  )

  model.setCharacterShaderFilter(null)
  assert.equal(model.filters, null, 'opaque AdvancedModel with no other filters sets filters=null')

  const modelHide = model.hide(200)
  const modelHideTweens = activeTweens.splice(0)
  for (const t of modelHideTweens) {
    t.cb(0.5)
    assert.equal(model.filters[0], model.alphaFilter, 'AlphaFilter re-attached during hide fade')
    t.cb(1)
    t.resolve()
  }
  await modelHide
  assert.equal(model.visible, false)
  assert.equal(model.filters, null, 'hidden AdvancedModel clears AlphaFilter')

  // 4. TalkSnippet closeWindowOnFinish followed immediately by next Talk keeps window visible & opaque
  const TalkSnippet = loader.load('snippets/TalkSnippet.ts').default
  loader.animation.linear = async (cb, durationMs) => {
    if (durationMs <= 0) {
      cb(1)
      return
    }
    return new Promise((resolve) => {
      activeTweens.push({ cb, resolve })
    })
  }
  const ui2 = new UILayer({ screen: { width: 1920, height: 1080 }, stage: { addChild() {} } })
  const talkApp = {
    isExporting: true,
    lastSnippetActualDurationMs: 100,
    currentTalkLipSync: null,
    currentTalkStartedAtMs: 0,
    ttsManager: { isTTSEnabled: () => false },
    videoExportManager: { signal: new AbortController().signal },
    layerUI: ui2,
    layerModel: {
      bringToFront: () => {},
      isModelShown: () => true,
      isModelVisible: () => true
    },
    getModelById: () => ({
      metadata: { id: 1 },
      destroyed: false,
      actionSignal: new AbortController().signal,
      internalModel: { on() {}, off() {} },
      releaseMouth() {},
      setMouthOpening() {},
      applyCharacterAction: async () => {}
    })
  }
  const flushUntil = async (promise) => {
    let settled = false
    void promise.finally(() => {
      settled = true
    })
    for (let step = 0; step < 50 && !settled; step++) {
      for (const t of activeTweens.splice(0)) {
        t.cb(1)
        t.resolve()
      }
      await new Promise((r) => setImmediate(r))
    }
    await promise
  }
  const t1 = new TalkSnippet(talkApp, {
    type: 'Talk',
    delay: 0,
    data: { speaker: '瑞希', content: 'A', modelId: 1, voice: '', closeWindowOnFinish: true }
  }).runSnippet()
  await flushUntil(t1)
  // Talk 1 fired un-awaited hideTextBackground(200); Talk 2 starts immediately before hide finishes
  assert.equal(ui2.UITalkShowed, false)
  const pendingCloseTweens = activeTweens.splice(0)
  assert.ok(pendingCloseTweens.length > 0, 'hideTextBackground(200) should be in flight')
  for (const t of pendingCloseTweens) t.cb(0.4)

  const t2 = new TalkSnippet(talkApp, {
    type: 'Talk',
    delay: 0,
    data: { speaker: '绘名', content: 'B', modelId: 1, voice: '' }
  }).runSnippet()
  await new Promise((r) => setImmediate(r))
  // Stale close finishes now — must NOT hide Talk 2's window
  for (const t of pendingCloseTweens) {
    t.cb(1)
    t.resolve()
  }
  await flushUntil(t2)
  assert.equal(ui2.UITalkShowed, true)
  assert.equal(ui2.textBackgroundSprite.visible, true)
  assert.equal(ui2.textBackgroundSprite.filters, null)
  assert.equal(ui2.textSprite.visible, true)
  assert.equal(ui2.textSprite.filters, null)
})
