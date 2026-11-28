import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { withGlobal } from '@sinonjs/fake-timers'

const nodeRequire = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const rendererRoot = path.join(root, 'src/renderer/src')
const compiled = new Map()
const noop = () => {}

function createFixture(t, extraMocks = new Map()) {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    AbortController,
    performance: { now: () => 0 }
  })
  vm.runInContext('this.Date = Date; this.Promise = Promise', context)
  const clock = withGlobal(context).install({
    now: 0,
    toFake: [
      'Date',
      'performance',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'setImmediate',
      'clearImmediate'
    ]
  })
  t.after(() => clock.uninstall())

  const warnings = []
  class Logger {
    info = noop
    error = noop
    debug = noop
    warn = (...args) => warnings.push(args)
    getSubLogger = () => this
  }
  class Cubism4InternalModel extends EventEmitter {}
  class Cubism2InternalModel extends EventEmitter {}
  class Text {
    constructor(text = '', style = {}) {
      this.text = text
      this.style = style
      this.anchor = { set: noop }
      this.x = 0
      this.y = 0
    }
  }
  class AlphaFilter {
    constructor(alpha = 1) {
      this.alpha = alpha
    }
  }
  class ColorMatrixFilter {
    matrix = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0]
    resolution = 1
    destroy = noop
  }
  class Sprite {
    constructor() {
      this.anchor = { set: noop }
      this.position = { set: noop }
      this.filters = [new AlphaFilter(0)]
      this.visible = false
      this.alpha = 1
      this.zIndex = 0
    }
  }
  class Container {
    children = []
    filters = null
    filterArea = null
    sortableChildren = false
    addChild(...items) {
      this.children.push(...items)
    }
    addChildAt(item, index) {
      this.children.splice(index, 0, item)
    }
    removeChild(item) {
      const idx = this.children.indexOf(item)
      if (idx >= 0) this.children.splice(idx, 1)
    }
    setChildIndex(item, index) {
      this.removeChild(item)
      this.children.splice(index, 0, item)
    }
  }

  class MockTicker {
    static shared = { add: noop, remove: noop, elapsedMS: 16 }
    maxFPS = 60
    elapsedMS = 16
    deltaTime = 1
    lastTime = 0
    _fn = null
    _timer = null
    add(fn) {
      this._fn = fn
    }
    start() {
      this._timer = context.setInterval(() => {
        this.lastTime = clock.now
        this._fn?.(this)
      }, 16)
    }
    stop() {
      if (this._timer !== null) {
        context.clearInterval(this._timer)
        this._timer = null
      }
    }
    destroy() {
      this.stop()
    }
  }

  const mocks = new Map([
    [
      'pixi.js',
      {
        Application: class {},
        Container,
        Graphics: class {},
        Sprite,
        Text,
        AlphaFilter,
        ColorMatrixFilter,
        Filter: class {},
        UPDATE_PRIORITY: { INTERACTION: 0 },
        TextStyle: class {
          constructor(opts) {
            Object.assign(this, opts)
          }
        },
        Texture: {
          from: () => ({ valid: true, baseTexture: { valid: true } }),
          WHITE: { valid: true, baseTexture: { valid: true } },
          EMPTY: {}
        },
        Ticker: MockTicker
      }
    ],
    [
      'pixi-live2d-display-advanced',
      { Cubism4InternalModel, Cubism2InternalModel, Live2DModel: class {} }
    ],
    [path.join(rendererRoot, 'utils/Logger.ts'), { default: () => new Logger() }],
    ...extraMocks.entries()
  ])

  const modules = new Map()
  function resolveFile(target, fromDir = rendererRoot) {
    if (mocks.has(target)) return target
    const base = target.startsWith('.')
      ? path.resolve(fromDir, target)
      : path.isAbsolute(target)
        ? target
        : path.join(rendererRoot, target)
    const candidates = [base, `${base}.ts`, path.join(base, 'index.ts')]
    for (const candidate of candidates) {
      if (mocks.has(candidate)) return candidate
    }
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    }
    return target
  }

  function load(target, fromDir = rendererRoot) {
    const filename = resolveFile(target, fromDir)
    if (mocks.has(filename)) return mocks.get(filename)
    if (modules.has(filename)) return modules.get(filename)
    if (!fs.existsSync(filename)) {
      if (!target.startsWith('.') && !path.isAbsolute(target)) {
        return nodeRequire(target)
      }
      throw new Error(`Unexpected unmocked dependency: ${target} (resolved: ${filename})`)
    }
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
    const require = (dep) => load(dep, path.dirname(filename))
    compiled.get(filename).runInContext(context)(exports, require)
    return exports
  }

  return {
    clock,
    warnings,
    mocks,
    load,
    Container,
    Sprite,
    Cubism4InternalModel,
    Cubism2InternalModel
  }
}

test('SpecialEffectLayer fadeOut/setEndingEnvelope never flash alpha=0 when already covered, and reset clears filter alpha', async (t) => {
  const f = createFixture(t)
  f.mocks.set('../../assets/ui/ui_se_black.svg', 'ui_se_black.svg')
  f.mocks.set('../components/SEBlack', { default: f.Sprite })
  f.mocks.set('../effects/Ease', { runEasedTween: async () => {} })
  f.mocks.set('../effects/InappTextures', {
    inappUrl: (p) => p,
    loadInappTexture: async () => null
  })
  f.mocks.set('../effects/OfficialFilters', {
    CameraBlurFilter: class {
      spread = 0
    }
  })
  f.mocks.set('../effects/TriangleParticleEffect', {
    ScenarioEffectOverlay: class {},
    SekaiTransitionParticles: class {}
  })

  const AnimationManager = f.load('managers/AnimationManager.ts').default
  AnimationManager.setExportMode(true, 1, 30)
  const SpecialEffectLayer = f.load('layers/SpecialEffectLayer.ts').default
  const layer = new SpecialEffectLayer({
    stage: new f.Container(),
    screen: { width: 1920, height: 1080 }
  })

  // BlackOut fades smoothly from 0 -> 1 (export step is 33ms so pass 250ms to finish 200ms fade)
  const outSamples = []
  const outTask = layer.fadeOut(200, 'black')
  for (let i = 0; i < 4; i++) {
    await f.clock.tickAsync(50)
    outSamples.push(layer.seBlackSprite.filters[0].alpha)
  }
  await f.clock.tickAsync(50)
  await outTask
  assert.ok(outSamples.every((a, i) => i === 0 || a >= outSamples[i - 1]))
  assert.equal(layer.seBlackSprite.filters[0].alpha, 1)

  // Calling setEndingEnvelope after BlackOut must NEVER reset curtain alpha to 0!
  const endSamples = []
  const endTask = layer.setEndingEnvelope(100, 200)
  for (let i = 0; i < 6; i++) {
    await f.clock.tickAsync(50)
    endSamples.push(layer.seBlackSprite.filters[0].alpha)
  }
  await f.clock.tickAsync(50)
  await endTask
  assert.ok(
    endSamples.every((a) => a === 1),
    `Expected black curtain to stay alpha=1 across setEndingEnvelope, got ${JSON.stringify(endSamples)}`
  )

  // Cross-fading to white while black is opaque keeps white on top (zIndex=4) until white finishes
  const whiteTask = layer.fadeOut(100, 'white')
  assert.equal(layer.seWhiteSprite.zIndex, 4)
  assert.equal(layer.seBlackSprite.zIndex, 3)
  await f.clock.tickAsync(120)
  await whiteTask
  assert.equal(layer.seWhiteSprite.filters[0].alpha, 1)
  assert.equal(layer.seBlackSprite.visible, false)
  assert.equal(layer.seBlackSprite.filters[0].alpha, 0)

  // reset() clears filter alpha back to 0 without leaving stale filter alpha = 1
  layer.reset()
  assert.equal(layer.seWhiteSprite.visible, false)
  assert.equal(layer.seWhiteSprite.filters[0].alpha, 0)
  assert.equal(layer.seBlackSprite.visible, false)
  assert.equal(layer.seBlackSprite.filters[0].alpha, 0)
})

test('resolveCharacterFadeMs and LayoutAppearSnippet sync 30fps export slide completion while preserving non-export 7-frame return', async (t) => {
  const f = createFixture(t)
  const timing = f.load(path.join(root, 'src/common/official/timing.ts'))
  assert.equal(timing.resolveCharacterFadeMs(false, 60), 100)
  assert.equal(timing.resolveCharacterFadeMs(false, 30), 100)
  assert.equal(timing.resolveCharacterFadeMs(true, 60), 100)
  assert.equal(timing.resolveCharacterFadeMs(true, 30), 100)

  f.mocks.set('pixi-live2d-display-advanced', {
    Cubism4InternalModel: f.Cubism4InternalModel,
    Cubism2InternalModel: f.Cubism2InternalModel,
    Live2DModel: class {}
  })
  f.mocks.set('../types/Stage', {})

  const AnimationManager = f.load('managers/AnimationManager.ts').default
  const LayoutAppearSnippet = f.load('snippets/LayoutAppearSnippet.ts').default
  const LayoutClearSnippet = f.load('snippets/LayoutClearSnippet.ts').default

  const makeMockModel = () => {
    const events = []
    const model = {
      metadata: { id: 2 },
      destroyed: false,
      visible: false,
      internalModel: {},
      events,
      beginVisibilityChange: () => 1,
      isVisibilityCurrent: () => true,
      setOpacity: noop,
      setPositionRel: (stageSize, side) => events.push({ kind: 'pos', side, at: f.clock.now }),
      hasMotion: () => true,
      startEntryMotion: noop,
      startMotions: async () => events.push({ kind: 'motion', at: f.clock.now }),
      isMotionLooping: () => false,
      getMotionDurationMs: () => 0,
      move: async (_stageSize, from, to, ms) => {
        events.push({ kind: 'moveStart', from, to, ms, at: f.clock.now })
        await AnimationManager.delay(ms)
        events.push({ kind: 'moveEnd', from, to, ms, at: f.clock.now })
      },
      show: async (ms) => {
        events.push({ kind: 'showStart', ms, at: f.clock.now })
        await AnimationManager.delay(ms)
        model.visible = true
        events.push({ kind: 'showEnd', ms, at: f.clock.now })
      },
      hide: async (ms) => {
        events.push({ kind: 'hideStart', ms, at: f.clock.now })
        await AnimationManager.delay(ms)
        model.visible = false
        events.push({ kind: 'hideEnd', ms, at: f.clock.now })
      },
      startBodyIdleLoop: noop
    }
    return model
  }

  const createApp = (model) => {
    let shown = false
    return {
      stage_size: [1920, 1080],
      getModelById: () => model,
      layerModel: {
        layoutMode: 'Normal',
        getModelById: () => model,
        addModelToLayer: noop,
        isModelShown: () => shown,
        markModelShown: () => {
          const prev = shown
          shown = true
          return prev
        },
        markModelHidden: () => {
          const prev = shown
          shown = false
          return prev
        },
        setLayoutDepth: noop,
        bringToFront: noop,
        removeModel: noop
      }
    }
  }

  // Case 1: 30fps export uses the official 100ms fade and does not wait for the 500ms slide
  AnimationManager.setExportMode(true)
  AnimationManager.exportEncodeFPS = 30
  const exportModel = makeMockModel()
  const exportApp = createApp(exportModel)
  const appearExport = new LayoutAppearSnippet(exportApp, {
    type: 'LayoutAppear',
    delay: 0,
    wait: true,
    data: {
      modelId: 2,
      type: 'appear',
      from: { side: 'LeftOffScreen', offset: 0 },
      to: { side: 'Left', offset: 0 },
      moveSpeed: 'Normal',
      depth: 'Normal'
    }
  })
  const appearPromise = appearExport.runSnippet()
  let exportFinishedAt = -1
  await Promise.all([
    appearPromise.then(() => {
      exportFinishedAt = f.clock.now
    }),
    f.clock.tickAsync(1000)
  ])
  const showStart = exportModel.events.find((e) => e.kind === 'showStart')
  const moveEnd = exportModel.events.find((e) => e.kind === 'moveEnd')
  assert.equal(showStart.ms, 100, '30fps export keeps the 100ms character fade-in')
  assert.ok(
    exportFinishedAt < moveEnd.at,
    'export LayoutAppear returns after the fade while the slide continues'
  )

  const clearExport = new LayoutClearSnippet(exportApp, {
    type: 'LayoutClear',
    delay: 0,
    wait: true,
    data: {
      modelId: 2,
      type: 'clear',
      from: { side: 'Left', offset: 0 },
      to: { side: 'LeftOffScreen', offset: 0 },
      moveSpeed: 'Normal'
    }
  })
  const clearPromise = clearExport.runSnippet()
  await f.clock.tickAsync(1000)
  await clearPromise
  const hideStart = exportModel.events.find((e) => e.kind === 'hideStart')
  assert.equal(hideStart.ms, 100, '30fps export keeps the 100ms character fade-out')

  // Case 2: Non-export preserves fast 100ms fade and returns after hold+100ms without awaiting 500ms slide
  AnimationManager.setExportMode(false)
  const liveModel = makeMockModel()
  const liveApp = createApp(liveModel)
  const appearLive = new LayoutAppearSnippet(liveApp, {
    type: 'LayoutAppear',
    delay: 0,
    wait: true,
    data: {
      modelId: 2,
      type: 'appear',
      from: { side: 'LeftOffScreen', offset: 0 },
      to: { side: 'Left', offset: 0 },
      moveSpeed: 'Normal',
      depth: 'Normal'
    }
  })
  const liveStartedAt = f.clock.now
  let finishedAt = -1
  const livePromise = appearLive.runSnippet().then(() => {
    finishedAt = f.clock.now
  })
  await f.clock.tickAsync(200)
  await livePromise
  const elapsedLive = finishedAt - liveStartedAt
  assert.ok(
    elapsedLive < 250,
    `Expected non-export LayoutAppear to finish after ~117ms, got ${elapsedLive}`
  )
  assert.equal(liveModel.events.find((e) => e.kind === 'showStart').ms, 100)
  await f.clock.tickAsync(400)
})

test('hasSpeakableSpeechText, TalkTiming, TalkSnippet, and TTSManager skip punctuation-only Talk cleanly', async (t) => {
  const f = createFixture(t)
  const speech = f.load(path.join(root, 'src/common/tts/speechText.ts'))
  const timing = f.load(path.join(root, 'src/common/official/timing.ts'))
  const talkTiming = f.load('utils/TalkTiming.ts')
  const timelineCalc = f.load('utils/TimelineCalculator.ts')
  const storyPlan = f.load(path.join(root, 'src/common/export/storyPlan.ts'))

  assert.equal(speech.hasSpeakableSpeechText('…………'), false)
  assert.equal(speech.hasSpeakableSpeechText('！？……  '), false)
  assert.equal(speech.hasSpeakableSpeechText('…はい'), true)
  assert.equal(speech.hasSpeakableSpeechText('123'), true)

  const expectedBasePunctMs = timing.framesToMs(
    4 * timing.WORD_INTERVAL_FRAMES + timing.AUTO_NEXT_PAGE_DELAY_FRAMES
  )
  const expectedExportPunctMs = timing.framesToMs(
    4 * timing.WORD_INTERVAL_FRAMES + timing.SILENT_PUNCTUATION_HOLD_FRAMES
  )

  // Default TalkTiming preserves official 2000ms floor; explicit silentHoldMs overrides for punctuation beat
  assert.equal(talkTiming.calculateTalkDurationMs('…………'), expectedBasePunctMs)
  assert.equal(
    talkTiming.calculateTalkDurationMs('…………', 0, '', {
      silentHoldMs: timing.SILENT_PUNCTUATION_HOLD_MS
    }),
    expectedExportPunctMs
  )

  const punctTalk = {
    type: 'Talk',
    delay: 0,
    wait: true,
    data: { speaker: '绘名', content: '…………', modelId: 1, voice: '', ttsText: '' }
  }
  // Default bakeStoryPlan / calculateTimeline preserves exact 60fps official baseline (includes 200ms = 12f window open)
  const expectedBaseWithOpenMs = timing.framesToMs(
    12 + 4 * timing.WORD_INTERVAL_FRAMES + timing.AUTO_NEXT_PAGE_DELAY_FRAMES
  )
  const expectedExportWithOpenMs = timing.framesToMs(
    12 + 4 * timing.WORD_INTERVAL_FRAMES + timing.SILENT_PUNCTUATION_HOLD_FRAMES
  )
  const baselineTimeline = timelineCalc.calculateTimelineWithoutTTS([punctTalk])
  assert.equal(baselineTimeline.entries[0].durationMs, expectedBaseWithOpenMs)
  const exportTimeline = timelineCalc.calculateTimelineWithoutTTS([punctTalk], {
    exportFps: 30,
    ttsEnabled: true
  })
  assert.equal(exportTimeline.entries[0].durationMs, expectedExportWithOpenMs)

  const basePlan = storyPlan.bakeStoryPlan([punctTalk], baselineTimeline.entries)
  const exportPlan = storyPlan.bakeStoryPlan([punctTalk], exportTimeline.entries, {
    exportFps: 30,
    ttsEnabled: true
  })
  // 计划从 PlayCore 的 10 帧暖场开始，末尾再补 playedWaitTime + 1 + BGM 淡出 31 帧。
  const planTotalMs = (snippetFrames) =>
    timing.framesToMs(timing.PLAYCORE_WARMUP_FRAMES + timing.storyEndFrame(snippetFrames))
  assert.equal(
    Math.round(basePlan.totalFrames * timing.FRAME_MS * 1000) / 1000,
    planTotalMs(12 + 4 * timing.WORD_INTERVAL_FRAMES + timing.AUTO_NEXT_PAGE_DELAY_FRAMES)
  )
  assert.equal(
    Math.round(exportPlan.totalFrames * timing.FRAME_MS * 1000) / 1000,
    planTotalMs(12 + 4 * timing.WORD_INTERVAL_FRAMES + timing.SILENT_PUNCTUATION_HOLD_FRAMES)
  )

  // TTSManager skips synthesis/translation and warns 0 times for punctuation-only lines
  let synthCalled = 0
  f.mocks.set('../services/TranslationService', {
    TranslationService: class {
      isEnabled() {
        return true
      }
      async translate() {
        assert.fail('Should never call TranslationService.translate on punctuation-only dialogue')
      }
    }
  })
  f.mocks.set('../services/TTSService', {
    DEFAULT_TTS_CONFIG: { enabled: true, engine: 'irodori', concurrency: 3 },
    TTSService: class {
      updateConfig = noop
      async synthesizeSpeech() {
        synthCalled++
        return { success: true, audioBuffer: new ArrayBuffer(16), duration: 1000 }
      }
    }
  })
  const { TTSManager } = f.load('managers/TTSManager.ts')
  const ttsManager = new TTSManager()
  ttsManager.initialize({ enabled: true, engine: 'irodori' })
  const skippedRes = await ttsManager.translateAndSynthesize('…………', '绘名', 0)
  assert.equal(skippedRes.success, false)
  assert.equal(skippedRes.duration, 0)
  assert.equal(synthCalled, 0)
  assert.equal(f.warnings.length, 0)

  // TalkSnippet skips mouth-flap lip-sync for punctuation-only lines when no voice envelope exists
  const AnimationManager = f.load('managers/AnimationManager.ts').default
  AnimationManager.setExportMode(true)
  AnimationManager.exportEncodeFPS = 30
  const UIText = f.load('components/UIText.ts').default
  const uiText = new UIText(1920, 1080)
  const mouthWrites = []
  const abort = new AbortController()
  const internalModel = new f.Cubism4InternalModel()
  internalModel.motionManager = { lipSyncIds: ['ParamMouthOpenY'], stopAllMotions: noop }
  internalModel.coreModel = {
    setParameterValueById: (id, value) => mouthWrites.push({ id, value }),
    setParamFloat: (id, value) => mouthWrites.push({ id, value })
  }
  const speakerModel = {
    metadata: { id: 1 },
    visible: true,
    destroyed: false,
    internalModel,
    actionSignal: abort.signal,
    released: false,
    setMouthOpening(value) {
      mouthWrites.push({ id: 'ParamMouthOpenY', value })
    },
    releaseMouth() {
      this.released = true
    },
    getMouthOpenParamIds() {
      return ['ParamMouthOpenY']
    },
    getMouthFormInfo() {
      return null
    },
    setMouthForm() {},
    applyCharacterAction: async () => {}
  }
  const talkApp = {
    isExporting: true,
    currentTalkLipSync: null,
    currentTalkStartedAtMs: 0,
    lastSnippetActualDurationMs: 0,
    videoExportManager: { signal: abort.signal },
    ttsManager: { isTTSEnabled: () => true },
    getModelById: () => speakerModel,
    layerModel: { isModelVisible: () => true },
    layerUI: {
      UITalkShowed: true,
      resetTalkData: noop,
      setTalkData: (_speaker, content) => {
        uiText.data = content
      },
      showTextBackground: async () => {},
      startDisplayContent: () => uiText.startDisplayContent()
    }
  }
  const TalkSnippet = f.load('snippets/TalkSnippet.ts').default
  const snippet = new TalkSnippet(talkApp, punctTalk)
  const run = snippet.runSnippet()
  await f.clock.tickAsync(150)
  internalModel.emit('beforeModelUpdate')
  await f.clock.tickAsync(2400)
  await run
  assert.ok(
    mouthWrites.every((w) => w.value === 0),
    `Punctuation-only talk must suppress non-zero mouth-flap writes, got ${JSON.stringify(mouthWrites)}`
  )
})

test('AdvancedModel preserves <50% body motion on MoveSnippet/deferral and respects autoBlink & closed eyes', async (t) => {
  const f = createFixture(t)
  const AnimationManager = f.load('managers/AnimationManager.ts').default
  AnimationManager.setExportMode(true, 1, 30)
  const AdvancedModel = f.load('model/AdvancedModel.ts').default

  // Build lightweight instance via prototype to exercise getEarlyBodyInterruptRemainingMs & applyCharacterAction & NaturalMotion
  const model = Object.create(AdvancedModel.prototype)
  model.destroyed = false
  model.visible = true
  model.actionController = new AbortController()
  model.channelGeneration = { 0: 1, 1: 1 }
  model.currentBodyMotion = 'nod_short'
  model.currentBodyClipDurationMs = 1000
  model.currentBodyStartedAt = 100 // 100ms in, minPlay = 500ms, remaining = 400ms
  model.autoBlink = false
  model.internalModel = {
    parallelMotionManager: [
      { playing: true, isFinished: () => false, stopAllMotions: noop },
      { playing: false, isFinished: () => true, stopAllMotions: noop }
    ]
  }
  model.eyeParameterIds = () => ['ParamEyeLOpen', 'ParamEyeROpen']
  model.facialIsolationParamIds = () => []
  const startedCalls = []
  model.startCharacterChannel = async (ch, name) => {
    startedCalls.push({ ch, name, at: f.clock.now })
  }
  model.startMotion = async () => true
  model.motionClipDurationMs = () => 1000

  await f.clock.tickAsync(200) // now = 200, startedAt = 100 -> played 100ms < 500ms -> remaining 400ms
  assert.equal(model.getEarlyBodyInterruptRemainingMs(), 400)

  // MoveSnippet's preserveActiveShortBodyMotion skips overriding body motion while <50% played
  await model.startMotions('idle_pose', undefined, true, { preserveActiveShortBodyMotion: true })
  assert.equal(
    startedCalls.length,
    0,
    'MoveSnippet preserveActiveShortBodyMotion must keep <50% active body motion'
  )

  // applyCharacterAction applies facial immediately (t=200) and defers body motion (t=600)
  const actionPromise = model.applyCharacterAction(
    { motion: 'next_motion', facial: 'smile_face' },
    undefined,
    undefined,
    3,
    { talkDurationMs: 2500 }
  )
  await f.clock.tickAsync(50)
  assert.deepEqual(startedCalls, [{ ch: 1, name: 'smile_face', at: 200 }])
  await f.clock.tickAsync(400)
  await actionPromise
  assert.equal(startedCalls.length, 2)
  assert.equal(startedCalls[1].name, 'next_motion')
  assert.equal(startedCalls[1].at, 600)
})

test('AdvancedModel multiplies every eye param by EyeOpening and respects autoBlink=false', async (t) => {
  const f = createFixture(t)
  const { createBlinkState } = f.load('model/NaturalMotion.ts')
  const AdvancedModel = f.load('model/AdvancedModel.ts').default

  const listeners = new Map()
  const paramValues = new Map([
    ['ParamEyeLOpen', 0.2],
    ['ParamEyeROpen', 0.9],
    ['ParamBreath', 0]
  ])
  const model = Object.create(AdvancedModel.prototype)
  model.destroyed = false
  model.visible = true
  model.filters = [{ alpha: 1 }]
  model.autoBlink = true
  model.blinkState = createBlinkState()
  model.breathDegree = 0
  model.naturalMotionInstalled = false
  model.eyeParameterIds = () => ['ParamEyeLOpen', 'ParamEyeROpen']
  model.internalModel = {
    on: (ev, fn) => listeners.set(ev, fn),
    coreModel: {
      getParameterIndex: (id) => (paramValues.has(id) ? 0 : -1),
      getParameterValueById: (id) => paramValues.get(id),
      setParameterValueById: (id, v) => paramValues.set(id, v)
    }
  }

  model.installNaturalMotion()
  const beforeUpdate = listeners.get('beforeModelUpdate')
  assert.equal(typeof beforeUpdate, 'function')

  // `CubismEyeBlinkController` 是 Multiply：闭眼表情的 0.1 同样乘 opening。
  // Sleep 状态不推进 opening，便于固定本帧的乘数。
  model.blinkState.status = 'sleep'
  model.blinkState.mode = 'auto'
  model.blinkState.opening = 0.5
  model.blinkState.command = null
  await f.clock.tickAsync(50)
  beforeUpdate()
  assert.ok(
    Math.abs(paramValues.get('ParamEyeLOpen') - 0.1) < 1e-9,
    `closed eye 0.2 × 0.5 = 0.1, got ${paramValues.get('ParamEyeLOpen')}`
  )
  assert.ok(Math.abs(paramValues.get('ParamEyeROpen') - 0.45) < 1e-9)

  // 闭眼表情不冻结 untilTime：Ready 状态的间隔照常递减，眨眼照常发生。
  paramValues.set('ParamEyeLOpen', 0.1)
  paramValues.set('ParamEyeROpen', 0.1)
  model.blinkState.status = 'ready'
  model.blinkState.mode = 'auto'
  model.blinkState.untilTime = 0.5
  await f.clock.tickAsync(1000 / 60)
  beforeUpdate()
  assert.ok(
    model.blinkState.untilTime < 0.5,
    `untilTime must tick down: ${model.blinkState.untilTime}`
  )
  let sawClosedFrame = false
  for (let i = 0; i < 300; i++) {
    await f.clock.tickAsync(1000 / 60)
    beforeUpdate()
    if (paramValues.get('ParamEyeLOpen') < 0.1) sawClosedFrame = true
  }
  assert.equal(sawClosedFrame, true, 'the blink runs even with a closed-eye facial')

  // 非 active 模型冻结呼吸：隐藏 300 步 ParamBreath 逐位不变。
  const frozenBreath = paramValues.get('ParamBreath')
  const frozenDegree = model.breathDegree
  model.visible = false
  for (let i = 0; i < 300; i++) {
    await f.clock.tickAsync(1000 / 60)
    beforeUpdate()
  }
  assert.equal(paramValues.get('ParamBreath'), frozenBreath)
  assert.equal(model.breathDegree, frozenDegree)
  model.visible = true

  // When autoBlink is false (e.g. closeEyes / pause), eyes must NOT be modified at all
  paramValues.set('ParamEyeLOpen', 0.8)
  paramValues.set('ParamEyeROpen', 0.8)
  model.autoBlink = false
  await f.clock.tickAsync(50)
  beforeUpdate()
  assert.equal(paramValues.get('ParamEyeLOpen'), 0.8)
  assert.equal(paramValues.get('ParamEyeROpen'), 0.8)
})

test('ModelLayer cancels stale ambient color tweens via ambientGen and UIWatermark deduplicates built-in line while preserving multiline custom text', async (t) => {
  const f = createFixture(t)
  f.mocks.set('pixi-live2d-display-advanced', {
    Cubism4InternalModel: f.Cubism4InternalModel,
    Cubism2InternalModel: f.Cubism2InternalModel
  })
  f.mocks.set('../effects/OfficialFilters', {
    Live2DHologramShaderFilter: class {
      step = noop
      destroy = noop
    },
    CameraBlurFilter: class {
      spread = 0
      destroy = noop
    }
  })
  f.mocks.set('../effects/InappTextures', { loadInappTexture: async () => null })
  f.mocks.set('../config/resource', { resourceUrl: (p) => p })
  f.mocks.set('../model/AdvancedModel', { default: class {} })

  const ModelLayer = f.load('layers/ModelLayer.ts').default
  const layer = new ModelLayer({
    stage: new f.Container(),
    screen: { width: 1920, height: 1080 },
    renderer: { resolution: 1 }
  })
  const staleTask = layer.tweenAmbientColor('evening', 500)
  await f.clock.tickAsync(200)
  const finalTask = layer.tweenAmbientColor('night', 200)
  await f.clock.tickAsync(400)
  await Promise.all([staleTask, finalTask])
  assert.ok(
    layer.layerContainer.filterArea,
    'ModelLayer must configure filterArea for ambient filter'
  )
  // Night blue tint [0.83, 0.86, 0.91] must win cleanly without evening overwriting it
  const m = layer.layerContainer.filters[0].matrix
  assert.ok(
    m[0] < 0.86 && m[6] < 0.89 && m[12] > m[0] && Math.abs(m[12] - 0.91) < 0.02,
    `Expected night ambient matrix, got [${m[0]}, ${m[6]}, ${m[12]}]`
  )

  const UIWatermark = f.load('components/UIWatermark.ts').default
  const wm = new UIWatermark(1920, 1080)
  wm.setCustomText('本视频由 MySekaiStoryteller-API 生成\nLine A\nLine B\nLine C')
  const lines = wm.text.split('\n')
  assert.deepEqual(lines, ['Line A', 'Line B', 'Line C'])
})

test('stageTiming.getMotionSettledEndMs excludes cleared/hidden characters when isModelShown is provided', async (t) => {
  const f = createFixture(t)
  const stageTiming = f.load('snippets/stageTiming.ts')
  const app = {
    layerModel: {
      isModelShown: (id) => id === 1,
      markMotionSettledAt: () => {}
    }
  }
  stageTiming.recordMotionSettledAt(app, 1, 1500)
  stageTiming.recordMotionSettledAt(app, 2, 4000)
  assert.equal(stageTiming.getMotionSettledEndMs(app, 100), 1500)
})
