/**
 * PlayCore ProgressBehavior 前置栅栏、Talk Gate、21 种官方新片段路由与收尾封包契约测试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const renderer = path.join(root, 'src/renderer/src')
const nodeRequire = createRequire(import.meta.url)

function createVirtualClock() {
  let nowMs = 0
  let nextId = 1
  const timers = new Map()

  const schedule = (fn, ms, args = []) => {
    const id = nextId++
    timers.set(id, {
      id,
      target: nowMs + Math.max(0, Number(ms) || 0),
      fn,
      args
    })
    return id
  }

  const clear = (id) => {
    timers.delete(id)
  }

  const sleep = (ms) =>
    new Promise((resolve) => {
      schedule(resolve, ms)
    })

  const flushMicrotasks = async () => {
    for (let i = 0; i < 30; i++) {
      await Promise.resolve()
    }
  }

  const drive = async (promise) => {
    let settled = false
    let resolved
    let rejected
    let hasError = false
    promise.then(
      (value) => {
        settled = true
        resolved = value
      },
      (err) => {
        settled = true
        hasError = true
        rejected = err
      }
    )

    while (!settled) {
      await flushMicrotasks()
      if (settled) break
      assert.ok(timers.size > 0, `VirtualClock deadlocked at ${nowMs}ms with no pending timers`)
      let earliestTarget = Infinity
      for (const entry of timers.values()) {
        if (entry.target < earliestTarget) earliestTarget = entry.target
      }
      nowMs = earliestTarget
      const due = Array.from(timers.values())
        .filter((entry) => entry.target <= nowMs)
        .sort((a, b) => a.id - b.id)
      for (const entry of due) {
        timers.delete(entry.id)
        entry.fn(...entry.args)
      }
    }

    if (hasError) throw rejected
    return resolved
  }

  return {
    get now() {
      return nowMs
    },
    setTimeout: (fn, ms, ...args) => schedule(fn, ms, args),
    clearTimeout: (id) => clear(id),
    sleep,
    flushMicrotasks,
    drive
  }
}

function fixture(extraMocks = []) {
  const clock = createVirtualClock()
  class Logger {
    info() {}
    warn() {}
    error() {}
    debug() {}
  }

  const context = vm.createContext({
    console,
    AbortController,
    AbortSignal,
    performance: { now: () => clock.now },
    Date,
    setTimeout: (fn, ms, ...args) => clock.setTimeout(fn, ms, args),
    clearTimeout: (id) => clock.clearTimeout(id),
    window: { electron: { ipcRenderer: { invoke: async () => undefined } } }
  })

  const modules = new Map()
  const compiled = new Map()
  const mocks = new Map([
    ['zod', nodeRequire('zod')],
    ['pixi.js', { Ticker: class {}, Container: class {}, Filter: class {} }],
    [
      'pixi-live2d-display-advanced',
      { Cubism2InternalModel: class {}, Cubism4InternalModel: class {} }
    ],
    [path.join(renderer, 'utils/Logger.ts'), { default: () => new Logger() }],
    [
      path.join(renderer, 'managers/AnimationManager.ts'),
      {
        default: {
          delay: (ms) => clock.sleep(ms),
          linear: async (cb, durationMs) => {
            if (durationMs > 0) await clock.sleep(durationMs)
            cb(1)
          },
          sine: async (cb, durationMs) => {
            if (durationMs > 0) await clock.sleep(durationMs)
            cb(1)
          },
          cosine: async (cb, durationMs) => {
            if (durationMs > 0) await clock.sleep(durationMs)
            cb(1)
          }
        }
      }
    ],
    ...extraMocks
  ])

  function resolveModule(baseFile, target) {
    if (mocks.has(target)) return target
    if (!target.startsWith('.')) return target
    const resolved = path.resolve(path.dirname(baseFile), target)
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved
    for (const ext of ['.ts', '.js']) {
      if (fs.existsSync(resolved + ext)) return resolved + ext
    }
    if (fs.existsSync(path.join(resolved, 'index.ts'))) return path.join(resolved, 'index.ts')
    return resolved
  }

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
      const resolved = resolveModule(filename, name)
      if (mocks.has(resolved)) return mocks.get(resolved)
      if (resolved.startsWith(root)) return load(resolved)
      return nodeRequire(name)
    }
    compiled.get(filename).runInContext(context)(exports, require)
    return exports
  }

  return { clock, load }
}

const round = (v) => Math.round(v * 1000) / 1000

test('StorySchema and snippetSemantics enforce ProgressBehavior and official snippet schemas', () => {
  const { load } = fixture()
  const Story = load(path.join(root, 'src/common/types/Story.ts'))
  const semantics = load(path.join(root, 'src/common/export/snippetSemantics.ts'))

  assert.equal(semantics.resolveProgressBehavior({ progressBehavior: 'Now', wait: true }), 'Now')
  assert.equal(
    semantics.resolveProgressBehavior({ progressBehavior: 'WaitFinished', wait: false }),
    'WaitFinished'
  )
  assert.equal(semantics.resolveProgressBehavior({ wait: true }), 'WaitFinished')
  assert.equal(semantics.resolveProgressBehavior({ wait: false }), 'Now')
  // Talk 不再有隐式前置栅栏：只有显式 WaitFinished 才拦在跑任务。
  assert.equal(semantics.snippetHasPreFence({ type: 'Talk', wait: false }), false)
  assert.equal(
    semantics.snippetHasPreFence({ type: 'Talk', wait: false, progressBehavior: 'WaitFinished' }),
    true
  )

  const parsed = Story.StorySchema.parse({
    models: [],
    images: [],
    snippets: [
      {
        type: 'LayoutAppear',
        progressBehavior: 'Now',
        delay: 0,
        data: {
          modelId: 1,
          from: { side: 'LeftOver', offset: 0 },
          to: { side: 'Under', offset: 0, under: true },
          motion: '',
          facial: '',
          moveSpeed: 'Normal'
        }
      },
      {
        type: 'ChangeBackgroundImage',
        progressBehavior: 'WaitFinished',
        delay: 0,
        data: { imageId: 2, duration: 0.5 }
      },
      {
        type: 'Talk',
        delay: 0,
        data: {
          speaker: '瑞希',
          content: '测试',
          modelId: 1,
          closeWindowOnFinish: true,
          effect: 'Internal'
        }
      },
      { type: 'LayoutDepth', delay: 0, data: { modelId: 1, depth: 'Front' } },
      { type: 'CharacterShake', delay: 0, data: { modelId: 1, axis: 'X' } },
      { type: 'CostumeChange', delay: 0, data: { modelId: 1, costume: 'casual' } },
      { type: 'PlaceInfo', delay: 0, data: { text: '屋顶', duration: 3 } },
      { type: 'FullScreenText', delay: 0, data: { text: '独白', duration: 2, keepBars: true } },
      { type: 'SimpleSelectable', delay: 0, data: { choices: ['A', 'B'], pickedIndex: 1 } },
      { type: 'SepiaIn', delay: 0, data: { duration: 0.1 } },
      { type: 'SepiaOut', delay: 0, data: { duration: 0.1 } },
      { type: 'SekaiIn', delay: 0, data: { duration: 0.5, variant: 'v2' } },
      { type: 'SekaiOut', delay: 0, data: { duration: 0.5, variant: 'v1' } },
      { type: 'SideFade', delay: 0, data: { direction: 'Left', mode: 'In', duration: 0.5 } },
      {
        type: 'AttachCharacterShader',
        delay: 0,
        data: { modelId: 1, shader: 'hologram', level: 1 }
      },
      { type: 'PlayScenarioEffect', delay: 0, data: { effectName: 'rain', duration: 0 } },
      { type: 'StopScenarioEffect', delay: 0, data: { effectName: 'rain', duration: 0.2 } },
      { type: 'BlurIn', delay: 0, data: { duration: 0.3 } },
      { type: 'BlurOut', delay: 0, data: { duration: 0.3 } },
      { type: 'BackgroundBlur', delay: 0, data: { mode: 'In', level: 2, duration: 0.3 } },
      { type: 'DollyZoom', delay: 0, data: { duration: 0.5, zoom: 1.2, ease: 'OutQuad' } },
      { type: 'ShakeWindow', delay: 0, data: { duration: 0.4, intensity: 12 } },
      { type: 'StopShakeWindow', delay: 0, data: {} },
      { type: 'StopShakeScreen', delay: 0, data: {} },
      { type: 'BgmVolume', delay: 0, data: { volume: 0.5, duration: 1 } },
      { type: 'Movie', delay: 0, data: { file: 'opening.mp4', duration: 2 } }
    ]
  })
  assert.equal(parsed.snippets.length, 26)
})

function createManagerHarness(clock) {
  const calls = []
  const ac = new AbortController()
  const model = {
    metadata: { id: 1 },
    internalModel: { on() {}, off() {}, motionManager: { lipSyncIds: [] } },
    actionSignal: ac.signal,
    destroyed: false,
    beginVisibilityChange: () => 1,
    currentVisibilityGeneration: () => 1,
    isVisibilityCurrent: () => true,
    hasMotion: () => true,
    isMotionLooping: () => false,
    getMotionDurationMs: () => 0,
    startMotions: async () => {},
    startEntryMotion: async () => {},
    startBodyIdleLoop: () => {},
    applyCharacterAction: async () => {},
    setPositionRel: () => {},
    move: async (_s, _f, _t, d) => clock.sleep(d),
    show: async (d) => clock.sleep(d),
    hide: async (d) => clock.sleep(d)
  }

  const app = {
    stage_size: { x: 1920, y: 1080 },
    isExporting: false,
    lastSnippetActualDurationMs: 0,
    currentTalkLipSync: null,
    currentTalkStartedAtMs: 0,
    videoExportManager: { signal: ac.signal },
    getModelById: () => model,
    getTextureById: (id) => ({ id }),
    getBgmByName: (name) => name,
    getSeByName: (name) => name,
    getVoiceByName: (name) => name,
    cameraMove: async (...args) => {
      const start = clock.now
      await clock.sleep(args[2] ?? 0)
      calls.push({ fn: 'cameraMove', start, end: clock.now, args })
    },
    cameraZoom: async (...args) => {
      const start = clock.now
      await clock.sleep(args[1] ?? 0)
      calls.push({ fn: 'cameraZoom', start, end: clock.now, args })
    },
    dollyZoom: async (...args) => {
      const start = clock.now
      await clock.sleep(args[1] ?? 0)
      calls.push({ fn: 'dollyZoom', start, end: clock.now, args })
    },
    shakeScreen: async (...args) => {
      const start = clock.now
      await clock.sleep((args[0] ?? 0) * 1000)
      calls.push({ fn: 'shakeScreen', start, end: clock.now, args })
    },
    stopShakeScreen: () => calls.push({ fn: 'stopShakeScreen', at: clock.now }),
    layerModel: {
      layoutMode: 'Normal',
      addModelToLayer: () => {},
      removeModel: () => {},
      isModelVisible: () => true,
      markModelShown: () => false,
      markModelHidden: () => true,
      setLayoutDepth: (...args) => calls.push({ fn: 'setLayoutDepth', at: clock.now, args }),
      shakeCharacter: async (...args) => {
        await clock.sleep(300)
        calls.push({ fn: 'shakeCharacter', at: clock.now, args })
      },
      changeCostume: async (...args) => {
        calls.push({ fn: 'changeCostume', at: clock.now, args })
      },
      setCharacterShader: (...args) =>
        calls.push({ fn: 'setCharacterShader', at: clock.now, args }),
      updateLayoutMode: (mode) =>
        calls.push({ fn: 'updateLayoutMode', at: clock.now, args: [mode] }),
      resetAmbientColor: () => calls.push({ fn: 'resetAmbientColor', at: clock.now }),
      markMotionSettledAt: () => {}
    },
    layerBackground: {
      changeBackground: async (...args) => {
        calls.push({ fn: 'changeBackground', at: clock.now, args })
      },
      setBackgroundBlur: async (...args) => {
        calls.push({ fn: 'setBackgroundBlur', at: clock.now, args })
      }
    },
    layerEnvironment: {
      setFlashback: async (...args) => {
        await clock.sleep(args[1] ?? 100)
        calls.push({ fn: 'setFlashback', at: clock.now, args })
      },
      setSepia: async (...args) => {
        await clock.sleep(args[1] ?? 100)
        calls.push({ fn: 'setSepia', at: clock.now, args })
      }
    },
    layerUI: {
      UITalkShowed: false,
      hideTextBackground: async (...args) =>
        calls.push({ fn: 'hideTextBackground', at: clock.now, args }),
      showPlaceInfo: async (...args) => {
        await clock.sleep(200)
        calls.push({ fn: 'showPlaceInfo', at: clock.now, args })
      },
      closePlaceInfo: () => calls.push({ fn: 'closePlaceInfo', at: clock.now }),
      showFullScreenText: async (opts) => {
        await clock.sleep(opts.durationMs ?? 500)
        calls.push({ fn: 'showFullScreenText', at: clock.now, args: [opts] })
      },
      hideFullScreenText: async () => calls.push({ fn: 'hideFullScreenText', at: clock.now }),
      showChoiceDialog: async (...args) => {
        await clock.sleep(125)
        calls.push({ fn: 'showChoiceDialog', at: clock.now, args })
      },
      shakeWindow: async (...args) => {
        await clock.sleep((args[0] ?? 0) * 1000)
        calls.push({ fn: 'shakeWindow', at: clock.now, args })
      },
      stopShakeWindow: () => calls.push({ fn: 'stopShakeWindow', at: clock.now })
    },
    layerSpecialEffect: {
      playSekaiTransition: async (...args) => {
        await clock.sleep(250 + (args[1] ?? 500))
        calls.push({ fn: 'playSekaiTransition', at: clock.now, args })
      },
      playSideFade: async (...args) => {
        const start = clock.now
        await clock.sleep(args[2] ?? 0)
        calls.push({ fn: 'playSideFade', start, end: clock.now, args })
      },
      playScenarioEffect: async (...args) =>
        calls.push({ fn: 'playScenarioEffect', at: clock.now, args }),
      stopScenarioEffect: async (...args) =>
        calls.push({ fn: 'stopScenarioEffect', at: clock.now, args }),
      setCameraBlur: async (...args) => {
        await clock.sleep(args[1] ?? 300)
        calls.push({ fn: 'setCameraBlur', at: clock.now, args })
      },
      playMovie: async (...args) => {
        await clock.sleep(args[1] ?? 500)
        calls.push({ fn: 'playMovie', at: clock.now, args })
      },
      fadeIn: async () => {},
      fadeOut: async () => {},
      wipe: async () => {}
    }
  }
  return { app, calls }
}

test('SnippetStrategyManager enforces identical PlayCore pre-start fence across interactive & export', async () => {
  for (const mode of ['interactive', 'export']) {
    const { clock, load } = fixture()
    const SnippetStrategyManager = load('managers/SnippetStrategyManager.ts').default
    const { app, calls } = createManagerHarness(clock)
    const manager = new SnippetStrategyManager(app)

    const dispatch = (snippet, idx) =>
      mode === 'export'
        ? manager.handleSnippetForExport(snippet, idx)
        : manager.handleSnippet(snippet, idx)

    await clock.drive(
      (async () => {
        // 0: WaitFinished SideFade(300ms) 与 1: Now CameraMove(500ms) 必须在 0ms 同帧开跑
        await dispatch(
          {
            type: 'SideFade',
            progressBehavior: 'WaitFinished',
            delay: 0,
            data: { direction: 'Left', mode: 'In', duration: 0.3 }
          },
          0
        )
        assert.equal(clock.now, 0, `${mode}: WaitFinished returns immediately after launching`)
        await dispatch(
          {
            type: 'CameraMove',
            progressBehavior: 'Now',
            delay: 0,
            data: { x: 0.2, y: 0, duration: 0.5 }
          },
          1
        )
        assert.equal(clock.now, 0, `${mode}: Now runs at exact same frame`)

        // 2: WaitFinished + delay=0.2s：必须先等 0 与 1（500ms）全完成，再开始 200ms delay -> 700ms 启动 CameraZoom
        await dispatch(
          {
            type: 'CameraZoom',
            progressBehavior: 'WaitFinished',
            delay: 0.2,
            data: { zoom: 1.3, duration: 0.1 }
          },
          2
        )
        assert.equal(clock.now, 500, `${mode}: pre-fence waits for both running tasks (500ms)`)

        // 尾部的 WaitAllFinished 应等待 CameraZoom 在 700 + 100 = 800ms 完成
        await manager.settleBackgroundSnippets()
        assert.equal(clock.now, 800, `${mode}: WaitAllFinished settles tail task`)
      })()
    )

    const fade = calls.find((c) => c.fn === 'playSideFade')
    const move = calls.find((c) => c.fn === 'cameraMove')
    const zoom = calls.find((c) => c.fn === 'cameraZoom')
    assert.deepEqual([fade.start, fade.end], [0, 300])
    assert.deepEqual([move.start, move.end], [0, 500])
    assert.deepEqual([zoom.start, zoom.end], [700, 800])
  }
})

test('All 21 new official snippets are registered and invoke exact Layer/App contracts', async () => {
  const { clock, load } = fixture()
  const SnippetStrategyManager = load('managers/SnippetStrategyManager.ts').default
  const { app, calls } = createManagerHarness(clock)
  const manager = new SnippetStrategyManager(app)

  const newSnippets = [
    { type: 'LayoutDepth', delay: 0, data: { modelId: 1, depth: 'Back' } },
    { type: 'CharacterShake', delay: 0, data: { modelId: 1, axis: 'Y' } },
    { type: 'CostumeChange', delay: 0, data: { modelId: 1, costume: 'mzk_unit' } },
    { type: 'PlaceInfo', delay: 0, data: { text: '宫益坂', duration: 2 } },
    { type: 'FullScreenText', delay: 0, data: { text: '回忆字幕', duration: 0.5, keepBars: true } },
    { type: 'SimpleSelectable', delay: 0, data: { choices: ['去', '不去'], pickedIndex: 0 } },
    { type: 'SepiaIn', delay: 0, data: { duration: 0.1 } },
    { type: 'SepiaOut', delay: 0, data: { duration: 0.1 } },
    { type: 'SekaiIn', delay: 0, data: { duration: 0.5, variant: 'v2' } },
    { type: 'SekaiOut', delay: 0, data: { duration: 0.5, variant: 'v1' } },
    { type: 'SideFade', delay: 0, data: { direction: 'Top', mode: 'Out', duration: 0.4 } },
    { type: 'AttachCharacterShader', delay: 0, data: { modelId: 1, shader: 'hologram', level: 2 } },
    { type: 'PlayScenarioEffect', delay: 0, data: { effectName: 'snow', duration: 0.2 } },
    { type: 'StopScenarioEffect', delay: 0, data: { effectName: 'snow', duration: 0.2 } },
    { type: 'BlurIn', delay: 0, data: { duration: 0.3 } },
    { type: 'BlurOut', delay: 0, data: { duration: 0.3 } },
    { type: 'BackgroundBlur', delay: 0, data: { mode: 'In', level: 3, duration: 0.3 } },
    { type: 'DollyZoom', delay: 0, data: { duration: 0.5, zoom: 1.4, ease: 'OutQuad' } },
    { type: 'ShakeWindow', delay: 0, data: { duration: 0.5, intensity: 10 } },
    { type: 'StopShakeWindow', delay: 0, data: {} },
    { type: 'StopShakeScreen', delay: 0, data: {} },
    { type: 'BgmVolume', delay: 0, data: { volume: 0.4, duration: 0.5 } },
    { type: 'Movie', delay: 0, data: { file: 'mv.mp4', duration: 0.5 } }
  ]

  await clock.drive(
    (async () => {
      for (let i = 0; i < newSnippets.length; i++) {
        await manager.handleSnippetForExport({ ...newSnippets[i], wait: true }, i)
      }
      await manager.settleBackgroundSnippets()
    })()
  )

  const seen = new Set(calls.map((c) => c.fn))
  for (const expectedFn of [
    'setLayoutDepth',
    'shakeCharacter',
    'changeCostume',
    'showPlaceInfo',
    'showFullScreenText',
    'showChoiceDialog',
    'setSepia',
    'playSekaiTransition',
    'playSideFade',
    'setCharacterShader',
    'playScenarioEffect',
    'stopScenarioEffect',
    'setCameraBlur',
    'setBackgroundBlur',
    'dollyZoom',
    'shakeWindow',
    'stopShakeWindow',
    'stopShakeScreen',
    'playMovie'
  ]) {
    assert.ok(seen.has(expectedFn), `Missing Layer/App call for ${expectedFn}`)
  }
  const shakeWinCall = calls.find((c) => c.fn === 'shakeWindow')
  assert.deepEqual(Array.from(shakeWinCall.args), [0.5, 10])
})

test('TalkSnippet runs voice & at=0 motion on act frame, obeys Talk Gate + 2.0s/0.5s tail, and closes window on finish', async () => {
  const { clock, load } = fixture()
  const TalkSnippet = load('snippets/TalkSnippet.ts').default
  const stageTiming = load('snippets/stageTiming.ts')
  const ac = new AbortController()
  const events = []

  const model = {
    metadata: { id: 1 },
    actionSignal: ac.signal,
    destroyed: false,
    internalModel: { on() {}, off() {}, motionManager: { lipSyncIds: [] } },
    isMotionLooping: () => false,
    getMotionDurationMs: () => 0,
    setMouthOpening() {},
    releaseMouth() {},
    getMouthOpenParamIds() {
      return ['ParamMouthOpenY']
    },
    getMouthFormInfo() {
      return null
    },
    setMouthForm() {},
    speak: (_url, opts) => {
      events.push({ ev: 'speakStart', atMs: clock.now })
      clock.setTimeout(() => {
        events.push({ ev: 'speakEnd', atMs: clock.now })
        opts.onFinish?.()
      }, model._voiceMs)
    },
    applyCharacterAction: async (action) => {
      events.push({ ev: 'action', atMs: clock.now, at: action.at, motion: action.motion })
    }
  }

  let windowOpen = false
  const app = {
    isExporting: false,
    lastSnippetActualDurationMs: 0,
    currentTalkLipSync: null,
    currentTalkStartedAtMs: 0,
    ttsManager: { isTTSEnabled: () => false },
    videoExportManager: { signal: ac.signal },
    getModelById: () => model,
    getVoiceByName: (v) => v,
    layerModel: {
      isModelVisible: () => true,
      setLayoutDepth: (id, depth) => events.push({ ev: 'depth', id, depth, atMs: clock.now }),
      markMotionSettledAt: () => {}
    },
    layerUI: {
      get UITalkShowed() {
        return windowOpen
      },
      resetTalkData: () => {},
      setTalkData: () => {},
      showTextBackground: async () => {
        windowOpen = true
        events.push({ ev: 'windowOpenStart', atMs: clock.now })
        await clock.sleep(200)
        events.push({ ev: 'windowOpenEnd', atMs: clock.now })
      },
      startDisplayContent: async () => {
        events.push({ ev: 'typingStart', atMs: clock.now })
        // 20 字 * 4 帧 = 80 帧 = 1333.333ms
        await clock.sleep(1333.333)
        events.push({ ev: 'typingEnd', atMs: clock.now })
      },
      closePlaceInfo: () => events.push({ ev: 'closePlaceInfo', atMs: clock.now }),
      hideTextBackground: async (dur) => {
        windowOpen = false
        events.push({ ev: 'hideWindow', atMs: clock.now, dur })
        if (dur > 0) await clock.sleep(dur)
        events.push({ ev: 'hideWindowDone', atMs: clock.now })
      }
    }
  }

  // Case 1: 语音长于打字（2500ms vs 200+1333.333=1533.333ms），且场上有 2800ms layout 滑行未完
  // Gate = max(1533.333, 2500+50=2550, 2800) = 2800ms -> +0.5s = 3300ms；并勾选 closeWindowOnFinish
  model._voiceMs = 2500
  stageTiming.recordLayoutRunningEnd(app, 2800)
  await clock.drive(
    new TalkSnippet(app, {
      type: 'Talk',
      delay: 0,
      data: {
        speaker: '瑞希',
        content: 'あ'.repeat(20),
        modelId: 1,
        voice: 'vo_01',
        motion: 'nod01',
        facial: 'smile',
        closeWindowOnFinish: true
      }
    }).runSnippet()
  )
  const speakEv = events.find((e) => e.ev === 'speakStart')
  const action0Ev = events.find((e) => e.ev === 'action' && e.at === 0)
  const typingStartEv = events.find((e) => e.ev === 'typingStart')
  const hideEv = events.find((e) => e.ev === 'hideWindow')
  assert.equal(speakEv.atMs, 0, 'voice starts on act frame before 0.2s window open')
  assert.equal(action0Ev.atMs, 0, 'at=0 motion starts on act frame before 0.2s window open')
  assert.equal(typingStartEv.atMs, 200, 'typing starts after 0.2s window open')
  assert.equal(round(clock.now), 3300, 'waits layout end (2800) + 0.5s tail = 3300ms')
  assert.equal(
    round(hideEv.atMs),
    3300,
    'closeWindowOnFinish triggers async hideTextBackground(200) at finish frame'
  )
  assert.equal(hideEv.dur, 200)
  assert.equal(windowOpen, false, 'next Talk sees closed window and will reopen 0.2s')

  // Case 2: 语音早于打字结束（800ms + 50ms = 850ms < 200+1333.333 = 1533.333ms）
  // 官方 2.0s 尾延迟 = 121 帧 = 2016.667ms -> 总长 3550ms
  events.length = 0
  stageTiming.resetStageTiming(app)
  model._voiceMs = 800
  const t2Start = clock.now
  await clock.drive(
    new TalkSnippet(app, {
      type: 'Talk',
      delay: 0,
      data: {
        speaker: '瑞希',
        content: 'あ'.repeat(20),
        modelId: 1,
        voice: 'vo_02',
        motion: '',
        facial: ''
      }
    }).runSnippet()
  )
  assert.equal(
    round(clock.now - t2Start),
    3550,
    'voice finished before typing uses 2.0s post-typing hold'
  )

  // Case 3: 导出无 voicePromise 模式（isExporting = true），也必须等完计划时长（2200ms），不能打字完立刻退出
  events.length = 0
  app.isExporting = true
  app.lastSnippetActualDurationMs = 2200
  const t3Start = clock.now
  await clock.drive(
    new TalkSnippet(app, {
      type: 'Talk',
      delay: 0,
      data: {
        speaker: '瑞希',
        content: 'あ'.repeat(4),
        modelId: 1,
        voice: ''
      }
    }).runSnippet()
  )
  assert.equal(round(clock.now - t3Start), 2200, 'export Talk waits planned targetDurationMs')
})

test('VideoExportManager Talk gate/window helpers & episode envelope constants align', () => {
  const noopClass = class {}
  const { load } = fixture([
    [
      path.join(renderer, 'managers/video-export/index.ts'),
      {
        ExportLogger: class {
          info() {}
          warn() {}
          error() {}
        },
        CheckpointManager: noopClass,
        ProgressTracker: class {
          reset() {}
          update() {}
        },
        ErrorRecoveryManager: class {
          reset() {}
        },
        ExportError: Error,
        ExportErrorCode: {},
        AudioMuxer: noopClass,
        ConcurrentExportPipeline: noopClass,
        SnippetTimestampRecorder: noopClass,
        AsyncFrameCapturer: noopClass,
        buildExportDiagnostics: () => ({}),
        sanitizeDiagnostics: (d) => d,
        exportLogBus: { reset() {} },
        motionTrace: { reset() {} },
        exportTraceContext: { reset() {}, setSnippet() {} }
      }
    ],
    [
      path.join(renderer, 'managers/video-export/VirtualClockController.ts'),
      { VirtualClockController: noopClass }
    ],
    [path.join(renderer, 'managers/video-export/BgmPlan.ts'), { BgmPlan: noopClass }],
    [path.join(renderer, 'managers/video-export/SePlan.ts'), { SePlan: noopClass }],
    [
      path.join(renderer, 'managers/video-export/WebCodecsMp4Encoder.ts'),
      { WebCodecsMp4Encoder: noopClass }
    ],
    [path.join(renderer, 'managers/video-export/JpegFrameSink.ts'), { JpegFrameSink: noopClass }],
    [path.join(renderer, 'managers/video-export/talkPatch.ts'), { applyTalkPatch: () => 0 }],
    [path.join(renderer, 'utils/WebGLContextValidator.ts'), { webGLValidator: {} }],
    [path.join(renderer, 'utils/FrameContentValidator.ts'), { frameValidator: {} }]
  ])

  const exportMod = load('managers/VideoExportManager.ts')
  const timing = load(path.join(root, 'src/common/official/timing.ts'))
  const modelMock = {
    isMotionLooping: (m) => m === 'loop',
    getMotionDurationMs: (m) => (m === 'nod' ? 4000 : m === 'relief' ? 3000 : 0)
  }
  const appMock = {
    getModelById: () => modelMock,
    layerModel: { isModelVisible: () => true, isModelShown: () => true },
    storyManager: { snippets: [] }
  }
  const VideoExportManager = exportMod.default
  const mgr = new VideoExportManager(appMock)

  // Talk gate with motion settle + layoutRunningMs + voice-before-typing rule
  assert.equal(
    round(
      mgr.talkDurationWithMotionGate(
        { content: 'あ'.repeat(20), ttsText: '', modelId: 1, motion: 'nod' },
        2860,
        200,
        0,
        1500,
        0
      )
    ),
    4516.667
  )
  // 参考 `motions_settled` 只看 shown 的角色：已隐藏角色的动作不阻塞 Talk。
  appMock.layerModel.isModelShown = () => false
  assert.equal(
    round(
      mgr.talkDurationWithMotionGate(
        { content: 'あ'.repeat(20), ttsText: '', modelId: 1, motion: 'nod' },
        2860,
        200,
        0,
        1500,
        0
      )
    ),
    3416.667
  )
  appMock.layerModel.isModelShown = () => true
  assert.equal(
    round(
      mgr.talkDurationWithMotionGate(
        { content: 'あ'.repeat(20), ttsText: '', modelId: 1, motion: '' },
        1000,
        0,
        1,
        0,
        0
      )
    ),
    3350
  )

  // 与 Talk 同帧启动的 Now Motion（delay=1.5s）在语音结束后仍在播：
  // 官方 Gate 等它到 frames_for(1.5)+frames_for(3.0)=91+181=272 帧，再停 0.5s
  // = 302 帧；整段 4.5s 换算只有 270 帧，会少 2 帧。
  appMock.storyManager.snippets = [
    { type: 'Talk', wait: true, delay: 0, data: { content: 'あ'.repeat(20), modelId: 1 } },
    {
      type: 'Motion',
      wait: false,
      delay: 1.5,
      data: { modelId: 1, motion: 'relief' }
    }
  ]
  assert.equal(
    round(
      mgr.talkDurationWithMotionGate(
        { content: 'あ'.repeat(20), ttsText: '', modelId: 1, voiceDurationMs: 4000 },
        0,
        0,
        0,
        0,
        0,
        undefined,
        0
      )
    ),
    5033.333
  )
  // 延迟晚于 Talk 自身结束的动作不会把这一句拖长。
  appMock.storyManager.snippets[1].delay = 10
  assert.equal(
    round(
      mgr.talkDurationWithMotionGate(
        { content: 'あ'.repeat(20), ttsText: '', modelId: 1, voiceDurationMs: 4000 },
        0,
        0,
        0,
        0,
        0,
        undefined,
        0
      )
    ),
    4566.667
  )
  // Talk 自身 delay=2s 时，Now 片段 delay=6s 相对 act 是
  // frames_for(6)−frames_for(2)=360−121=239 帧（不是 frames_for(4s)=240）。
  appMock.storyManager.snippets = [
    { type: 'Talk', wait: true, delay: 2, data: { content: 'あ'.repeat(20), modelId: 1 } },
    { type: 'Motion', wait: false, delay: 6, data: { modelId: 1, motion: 'relief' } }
  ]
  assert.equal(
    round(
      mgr.talkDurationWithMotionGate(
        { content: 'あ'.repeat(20), ttsText: '', modelId: 1, voiceDurationMs: 4000 },
        0,
        0,
        0,
        0,
        0,
        undefined,
        2000
      )
    ),
    7500
  )
  appMock.storyManager.snippets = []

  // 无语音（ttsDurationMs=0 且无 voiceDurationMs，例如关掉 TTS 或部分角色语音失败）时，
  // Talk gate 仍须与 bakeStoryPlan 一致等待自身与并发动作收尾，避免运行时与 finalPlan 脱节。
  assert.equal(
    round(
      mgr.talkDurationWithMotionGate(
        { content: 'あ', ttsText: '', modelId: 1, motion: 'nod' },
        0,
        0,
        0,
        0,
        0
      )
    ),
    6033.333
  )
  appMock.storyManager.snippets = [
    { type: 'Talk', wait: true, delay: 0, data: { content: 'あ', modelId: 1 } },
    {
      type: 'Motion',
      wait: false,
      delay: 1.5,
      data: { modelId: 1, motion: 'relief' }
    }
  ]
  assert.equal(
    round(
      mgr.talkDurationWithMotionGate(
        { content: 'あ', ttsText: '', modelId: 1 },
        0,
        0,
        0,
        0,
        0,
        undefined,
        0
      )
    ),
    6550
  )
  appMock.storyManager.snippets = []

  // talkWindowOpenMs reopens after HideTalk or closeWindowOnFinish
  const seq = [
    { type: 'Talk', delay: 0, data: { speaker: 'a', content: '1', closeWindowOnFinish: true } },
    { type: 'Talk', delay: 0, data: { speaker: 'a', content: '2' } },
    { type: 'Talk', delay: 0, data: { speaker: 'a', content: '3' } }
  ]
  assert.equal(mgr.talkWindowOpenMs(seq, 0), 200)
  assert.equal(mgr.talkWindowOpenMs(seq, 1), 200)
  assert.equal(mgr.talkWindowOpenMs(seq, 2), 0)
  assert.equal(timing.OPENING_COVER_FADE_MS, 500)
  assert.equal(timing.PLAYED_WAIT_TIME_MS, 250)
  assert.equal(timing.SCENARIO_EXIT_BGM_FADE_MS, 250)
})
