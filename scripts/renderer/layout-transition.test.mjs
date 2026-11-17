/**
 * 官方舞台入场/退场/位移/背景切换/动作触发测试。
 *
 * 锁定波次 1 重构的布局与协程完成语义：
 * 1. LayoutAppear 首次出现只等 7 帧（1 帧 alpha=0 + 0.1s 淡入），滑入异步后台完成；已在场走 0.2s CharacterMoveTo。
 * 2. LayoutClear 未显示立刻结束；原地 0.15s delay + 0.1s fade = 250ms；滑动 max(0, move - 0.1s) 后淡出；可被新 Appear 代数作废。
 * 3. Move 支持 Slow/Normal/Fast/Immediate、置顶角色深度 Front，并登记 layout/motion 结束时刻。
 * 4. ChangeBackgroundImage 0 帧触发异步 changeBackground 并重置 AmbientColor。
 * 5. Motion 标量片段 0 帧触发 startMotions（无 requestAnimationFrame/applyAndWait）并记录非循环动作收尾。
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
    for (let i = 0; i < 25; i++) {
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
    drive
  }
}

function fixture() {
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
    setTimeout: (fn, ms, ...args) => clock.setTimeout(fn, ms, ...args),
    clearTimeout: (id) => clock.clearTimeout(id),
    requestAnimationFrame: () => {
      throw new Error('Unexpected requestAnimationFrame usage')
    }
  })

  const modules = new Map()
  const compiled = new Map()
  const mocks = new Map([
    ['zod', nodeRequire('zod')],
    ['pixi.js', { Ticker: class {}, Container: class {}, Filter: class {} }],
    ['pixi-live2d-display-advanced', { Cubism2InternalModel: class {}, Cubism4InternalModel: class {} }],
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
    ]
  ])

  function resolveModule(baseFile, target) {
    if (mocks.has(target)) return target
    if (!target.startsWith('.')) return target
    const resolved = path.resolve(path.dirname(baseFile), target)
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved
    for (const ext of ['.ts', '.js']) {
      if (fs.existsSync(resolved + ext)) return resolved + ext
    }
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

function createStageHarness(clock) {
  const shown = new Set()
  const removed = []
  const depthCalls = []
  const motionSettledCalls = []
  const models = new Map()
  const ac = new AbortController()

  function getOrCreateModel(id, options = {}) {
    if (models.has(id)) return models.get(id)
    let visibilityGen = 0
    const calls = {
      positions: [],
      moves: [],
      shows: [],
      hides: [],
      opacities: [],
      motions: [],
      entryMotions: 0,
      idleLoops: 0,
      applyAndWaitCalled: false
    }
    const model = {
      metadata: { id },
      internalModel: {},
      actionSignal: ac.signal,
      calls,
      beginVisibilityChange: () => ++visibilityGen,
      currentVisibilityGeneration: () => visibilityGen,
      isVisibilityCurrent: (token) => token === visibilityGen,
      hasMotion: () => true,
      isMotionLooping: (name) => Boolean(options.loopingMotions?.has(name)),
      getMotionDurationMs: (name) => options.motionDurations?.get(name) ?? 0,
      startMotions: async (motion, facial, facialFirst, opts) => {
        calls.motions.push({ atMs: clock.now, motion, facial, facialFirst, opts })
      },
      startEntryMotion: async () => {
        calls.entryMotions++
      },
      startBodyIdleLoop: () => {
        calls.idleLoops++
      },
      applyAndWait: () => {
        calls.applyAndWaitCalled = true
        throw new Error('MotionSnippet must not call applyAndWait')
      },
      setOpacity: (alpha) => calls.opacities.push({ atMs: clock.now, alpha }),
      setPositionRel: (stageSize, pos) => calls.positions.push({ atMs: clock.now, stageSize, pos }),
      move: async (_stageSize, from, to, durationMs) => {
        const startAt = clock.now
        if (durationMs > 0) await clock.sleep(durationMs)
        calls.moves.push({ startAt, endAt: clock.now, from, to, durationMs })
      },
      show: async (fadeMs, hologram, token) => {
        const startAt = clock.now
        if (fadeMs > 0) await clock.sleep(fadeMs)
        calls.shows.push({ startAt, endAt: clock.now, fadeMs, hologram, token })
      },
      hide: async (fadeMs, token) => {
        const startAt = clock.now
        if (fadeMs > 0) await clock.sleep(fadeMs)
        calls.hides.push({ startAt, endAt: clock.now, fadeMs, token })
      }
    }
    models.set(id, model)
    return model
  }

  let ambientResetCount = 0
  const backgroundCalls = []
  const app = {
    stage_size: { x: 1920, y: 1080 },
    videoExportManager: { signal: ac.signal },
    getModelById: (id) => getOrCreateModel(id),
    getTextureById: (id) => ({ id }),
    layerModel: {
      layoutMode: 'Normal',
      addModelToLayer: () => {},
      removeModel: (m) => {
        shown.delete(m.metadata.id)
        removed.push({ id: m.metadata.id, atMs: clock.now })
      },
      isModelVisible: (id) => shown.has(id),
      isModelShown: (id) => shown.has(id),
      markModelShown: (id) => {
        const wasShown = shown.has(id)
        shown.add(id)
        return wasShown
      },
      markModelHidden: (id) => {
        const wasShown = shown.has(id)
        shown.delete(id)
        return wasShown
      },
      setLayoutDepth: (id, depth) => depthCalls.push({ id, depth, atMs: clock.now }),
      markMotionSettledAt: (id, endMs) => motionSettledCalls.push({ id, endMs }),
      resetAmbientColor: () => {
        ambientResetCount++
      }
    },
    layerBackground: {
      changeBackground: async (img, durationMs) => {
        const startAt = clock.now
        await clock.sleep(1500)
        backgroundCalls.push({ img, durationMs, startAt, finishedAt: clock.now })
      }
    }
  }

  return {
    app,
    shown,
    removed,
    depthCalls,
    motionSettledCalls,
    backgroundCalls,
    get ambientResetCount() {
      return ambientResetCount
    }
  }
}

const round = (v) => Math.round(v * 1000) / 1000

test('LayoutAppear finishes after 7 frames while async slide continues, and re-appear waits 0.2s move', async () => {
  const { clock, load } = fixture()
  const LayoutAppearSnippet = load('snippets/LayoutAppearSnippet.ts').default
  const StageUtils = load('utils/StageUtils.ts').default
  const stageTiming = load('snippets/stageTiming.ts')
  const { app } = createStageHarness(clock)

  // 1) 首次出现：LeftOver -> Center (Normal=500ms)
  const firstAppear = new LayoutAppearSnippet(app, {
    type: 'LayoutAppear',
    delay: 0,
    data: {
      modelId: 1,
      from: { side: 'LeftOver', offset: 0 },
      to: { side: 'Center', offset: 0 },
      motion: '',
      facial: '',
      facialFirst: true,
      moveSpeed: 'Normal',
      hologram: false
    }
  })

  await clock.drive(firstAppear.runSnippet())
  // 片段在 1 帧(16.667ms) + 0.1s(100ms) = 7 帧(116.667ms) 返回，不阻塞完整 500ms 滑动
  assert.equal(round(clock.now), 116.667)
  assert.equal(app.getModelById(1).calls.shows.length, 1)
  assert.equal(round(app.getModelById(1).calls.shows[0].startAt), 16.667)
  assert.equal(round(app.getModelById(1).calls.shows[0].endAt), 116.667)
  assert.equal(app.getModelById(1).calls.moves.length, 0, 'slide is still running in background')
  assert.equal(stageTiming.getLayoutRunningEndMs(app), 500)

  // 让后台 500ms 滑动自然走完
  await clock.drive(clock.sleep(400))
  assert.equal(app.getModelById(1).calls.moves.length, 1)
  assert.equal(app.getModelById(1).calls.moves[0].endAt, 500)
  assert.equal(round(app.getModelById(1).calls.moves[0].from.x), -0.427)

  // 2) 已在场再次 Appear：不淡入，走 200ms 移动
  const tBeforeSecond = clock.now
  const secondAppear = new LayoutAppearSnippet(app, {
    type: 'LayoutAppear',
    delay: 0,
    data: {
      modelId: 1,
      from: { side: 'Center', offset: 0 },
      to: { side: 'RightOver', offset: 0 },
      motion: '',
      facial: '',
      facialFirst: true,
      moveSpeed: 'Slow',
      hologram: false
    }
  })
  await clock.drive(secondAppear.runSnippet())
  assert.equal(clock.now - tBeforeSecond, 200)
  assert.equal(app.getModelById(1).calls.shows.length, 1, 'already shown does not call show() again')
  assert.equal(app.getModelById(1).calls.opacities.at(-1).alpha, 1)
  assert.equal(round(app.getModelById(1).calls.moves.at(-1).to.x), 1.427)

  // 3) Under 定位向下移出画外
  const underPos = StageUtils.side_to_position('Under', 'Normal', 0)
  assert.ok(underPos.y > 1.5, `Expected Under y > 1.5, got ${underPos.y}`)
})

test('LayoutClear matches hidden/in-place/slide fade offsets and visibility preemption', async () => {
  const { clock, load } = fixture()
  const LayoutAppearSnippet = load('snippets/LayoutAppearSnippet.ts').default
  const LayoutClearSnippet = load('snippets/LayoutClearSnippet.ts').default
  const { app, removed } = createStageHarness(clock)

  // 1) 未在场模型：0 帧完成并移除
  const clearHidden = new LayoutClearSnippet(app, {
    type: 'LayoutClear',
    delay: 0,
    data: {
      modelId: 9,
      from: { side: 'Center', offset: 0 },
      to: { side: 'Center', offset: 0 },
      moveSpeed: 'Normal',
      motion: '',
      facial: ''
    }
  })
  await clock.drive(clearHidden.runSnippet())
  assert.equal(clock.now, 0)
  assert.equal(removed.length, 1)

  // 2) 原地 Clear：0.15s delay + 0.1s fade = 250ms
  const appear2 = new LayoutAppearSnippet(app, {
    type: 'LayoutAppear',
    delay: 0,
    data: {
      modelId: 2,
      from: { side: 'Center', offset: 0 },
      to: { side: 'Center', offset: 0 },
      motion: '',
      facial: '',
      facialFirst: true,
      moveSpeed: 'Normal',
      hologram: false
    }
  })
  await clock.drive(appear2.runSnippet())
  const tStartInPlace = clock.now
  const clearInPlace = new LayoutClearSnippet(app, {
    type: 'LayoutClear',
    delay: 0,
    data: {
      modelId: 2,
      from: { side: 'Center', offset: 0 },
      to: { side: 'Center', offset: 0 },
      moveSpeed: 'Slow',
      motion: '',
      facial: ''
    }
  })
  await clock.drive(clearInPlace.runSnippet())
  assert.equal(round(clock.now - tStartInPlace), 250)
  assert.equal(round(app.getModelById(2).calls.hides[0].startAt - tStartInPlace), 150)
  assert.equal(round(app.getModelById(2).calls.hides[0].fadeMs), 100)
  assert.equal(removed.at(-1).id, 2)

  // 3) 滑动 Clear (Slow = 750ms)：等 650ms 后淡出 100ms，合计 750ms
  const appear3 = new LayoutAppearSnippet(app, {
    type: 'LayoutAppear',
    delay: 0,
    data: {
      modelId: 3,
      from: { side: 'Left', offset: 0 },
      to: { side: 'Left', offset: 0 },
      motion: '',
      facial: '',
      facialFirst: true,
      moveSpeed: 'Normal',
      hologram: false
    }
  })
  await clock.drive(appear3.runSnippet())
  const tStartSlide = clock.now
  const clearSlide = new LayoutClearSnippet(app, {
    type: 'LayoutClear',
    delay: 0,
    data: {
      modelId: 3,
      from: { side: 'Left', offset: 0 },
      to: { side: 'Right', offset: 0 },
      moveSpeed: 'Slow',
      motion: '',
      facial: ''
    }
  })
  await clock.drive(clearSlide.runSnippet())
  assert.equal(round(clock.now - tStartSlide), 750)
  assert.equal(round(app.getModelById(3).calls.hides[0].startAt - tStartSlide), 650)

  // 4) 滑动退场途中被新 Appear 抢占：旧 Clear 不得删掉新 Appear 的模型
  const appearPreemptA = new LayoutAppearSnippet(app, {
    type: 'LayoutAppear',
    delay: 0,
    data: {
      modelId: 4,
      from: { side: 'Left', offset: 0 },
      to: { side: 'Left', offset: 0 },
      motion: '',
      facial: '',
      facialFirst: true,
      moveSpeed: 'Normal',
      hologram: false
    }
  })
  await clock.drive(appearPreemptA.runSnippet())
  const oldClearTask = new LayoutClearSnippet(app, {
    type: 'LayoutClear',
    delay: 0,
    data: {
      modelId: 4,
      from: { side: 'Left', offset: 0 },
      to: { side: 'Right', offset: 0 },
      moveSpeed: 'Slow',
      motion: '',
      facial: ''
    }
  }).runSnippet()
  await clock.drive(clock.sleep(100))
  const newAppear = new LayoutAppearSnippet(app, {
    type: 'LayoutAppear',
    delay: 0,
    data: {
      modelId: 4,
      from: { side: 'Right', offset: 0 },
      to: { side: 'Right', offset: 0 },
      motion: '',
      facial: '',
      facialFirst: true,
      moveSpeed: 'Normal',
      hologram: false
    }
  })
  await clock.drive(newAppear.runSnippet())
  await clock.drive(oldClearTask)
  assert.equal(app.layerModel.isModelVisible(4), true)
  assert.ok(!removed.some((r) => r.id === 4), 'stale LayoutClear must not remove re-appeared model')
})

test('Move sets depth Front and finishes per speed; ChangeBackground & Motion finish in 0 frames', async () => {
  const { clock, load } = fixture()
  const MoveSnippet = load('snippets/MoveSnippet.ts').default
  const ChangeBackgroundImageSnippet = load('snippets/ChangeBackgroundImageSnippet.ts').default
  const MotionSnippet = load('snippets/MotionSnippet.ts').default
  const stageTiming = load('snippets/stageTiming.ts')
  const harness = createStageHarness(clock)
  const model1 = harness.app.getModelById(1)
  model1.isMotionLooping = (name) => name === 'loop-idle'
  model1.getMotionDurationMs = (name) => (name === 'nod-once' ? 1200 : 800)

  // Move (Fast = 333.333ms)
  const move = new MoveSnippet(harness.app, {
    type: 'Move',
    delay: 0,
    data: {
      modelId: 1,
      from: { side: 'Left', offset: 0 },
      to: { side: 'Right', offset: 0 },
      moveSpeed: 'Fast',
      motion: '',
      facial: '',
      facialFirst: true
    }
  })
  await clock.drive(move.runSnippet())
  assert.equal(round(clock.now), 333.333)
  assert.deepEqual(harness.depthCalls[0], { id: 1, depth: 'Front', atMs: 0 })
  assert.equal(round(stageTiming.getLayoutRunningEndMs(harness.app)), 333.333)

  // ChangeBackgroundImage (0 帧完成，异步 1500ms 背景交叉淡入，重置环境色)
  const tBg = clock.now
  const bg = new ChangeBackgroundImageSnippet(harness.app, {
    type: 'ChangeBackgroundImage',
    delay: 0,
    data: { imageId: 7, duration: 0.5 }
  })
  await clock.drive(bg.runSnippet())
  assert.equal(clock.now, tBg, 'ChangeBackgroundImage completes in 0 frames')
  assert.equal(harness.ambientResetCount, 1)
  assert.equal(harness.backgroundCalls.length, 0, 'changeBackground still running asynchronously')

  // Motion 标量（nod-once -> 记 settle；loop-idle -> 不记 settle；均 0 帧且无 rAF/applyAndWait）
  const tMotion = clock.now
  const scalarNod = new MotionSnippet(harness.app, {
    type: 'Motion',
    delay: 0,
    data: { modelId: 1, motion: 'nod-once', facial: 'face_smile', facialFirst: true }
  })
  await clock.drive(scalarNod.runSnippet())
  assert.equal(clock.now, tMotion, 'scalar Motion completes in 0 frames')
  assert.equal(model1.calls.applyAndWaitCalled, false)
  assert.equal(harness.motionSettledCalls.length, 1)
  assert.equal(round(harness.motionSettledCalls[0].endMs), round(tMotion + 1200))

  const scalarLoop = new MotionSnippet(harness.app, {
    type: 'Motion',
    delay: 0,
    data: { modelId: 1, motion: 'loop-idle', facial: '', facialFirst: true }
  })
  await clock.drive(scalarLoop.runSnippet())
  assert.equal(clock.now, tMotion)
  assert.equal(harness.motionSettledCalls.length, 1, 'looping motion does not block Talk gate')

  // 等 ChangeBackground 后台动画跑完验证传入 duration=500ms
  await clock.drive(clock.sleep(1600))
  assert.equal(harness.backgroundCalls.length, 1)
  assert.equal(harness.backgroundCalls[0].durationMs, 500)
})
