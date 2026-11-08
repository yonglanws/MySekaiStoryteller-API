/**
 * PLAN SNAPSHOT — 与 doc/moesekai-parity-plan.md 同步维护。
 *
 * 问题 1：动作切换时而快时而慢。
 * 官方 TalkData 的 MotionChangeFrom 恒为 1、TimingSyncValue 恒为 0，动作在句首触发；
 * 旧实现写 at:0.1，动作随 TTS 时长在 0.18~0.6s 间漂移。导出模式还会把 >100ms 的
 * 帧压成 20ms，导致 fade/move 慢 5~10 倍。
 *
 * 这个测试锁死：
 * 1. at=0 的 cue 在 snippet 开始瞬间派发；
 * 2. 0.5 的 cue 在 500ms 派发；
 * 3. 导出模式 200ms 的帧按 200ms 推进，不再被压成 20ms。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { withGlobal } from '@sinonjs/fake-timers'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const renderer = path.join(root, 'src/renderer/src')

function fixture(t) {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    performance: { now: () => 0 }
  })
  vm.runInContext('this.Date = Date; this.Promise = Promise', context)
  const clock = withGlobal(context).install({
    now: 0,
    toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
  })
  t.after(() => clock.uninstall())

  class Logger {
    info() {}
    error() {}
    debug() {}
    warn() {}
    getSubLogger() {
      return this
    }
  }
  class Ticker {
    elapsedMS = 16
  }
  const modules = new Map()
  const mocks = new Map([
    ['pixi.js', { Ticker, UPDATE_PRIORITY: { INTERACTION: 0 } }],
    [path.join(renderer, 'utils/Logger.ts'), { default: () => new Logger() }]
  ])
  const compiled = new Map()
  function load(relative) {
    const filename = path.isAbsolute(relative) ? relative : path.join(renderer, relative)
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
      assert.ok(name.startsWith('.'), `Unexpected platform dependency: ${name}`)
      return load(path.resolve(path.dirname(filename), `${name}.ts`))
    }
    compiled.get(filename).runInContext(context)(exports, require)
    return exports
  }
  return { clock, load }
}

test('character actions fire on the cue clock, with at=0 at line start', async (t) => {
  const f = fixture(t)
  const { scheduleCharacterActions } = f.load('utils/CharacterActionScheduler.ts')
  const events = []
  const schedule = scheduleCharacterActions(
    [
      { at: 0, modelId: 1, motion: 'first' },
      { at: 0.5, modelId: 2, facial: 'second' }
    ],
    1000,
    {
      isVisible: () => true,
      apply: (action) => {
        events.push({ action, at: f.clock.now })
      }
    }
  )
  await f.clock.tickAsync(0)
  assert.equal(events.length, 1)
  assert.equal(events[0].action.motion, 'first')
  assert.equal(events[0].at, 0)

  await f.clock.tickAsync(500)
  assert.equal(events.length, 2)
  assert.equal(events[1].action.facial, 'second')
  assert.ok(events[1].at >= 500 && events[1].at < 520, `second cue at ${events[1].at}ms`)

  await f.clock.tickAsync(500)
  await schedule.finished
  assert.equal(f.clock.countTimers(), 0)
})

test('finished waits for every cue start, so short cues are not cancelled mid-load', async (t) => {
  const f = fixture(t)
  const { scheduleCharacterActions } = f.load('utils/CharacterActionScheduler.ts')
  let started = false
  let aborted = false
  const schedule = scheduleCharacterActions([{ at: 0, modelId: 1, motion: 'slow-load' }], 1, {
    isVisible: () => true,
    apply: async (_action, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      aborted = signal.aborted
      started = true
    }
  })
  await f.clock.tickAsync(1)
  await schedule.finished
  assert.equal(started, true, '1ms 片段也要等动作加载完成')
  assert.equal(aborted, false)
  schedule.cancel()
})

test('export frame stepping uses real elapsed time instead of the old 20ms clamp', (t) => {
  const f = fixture(t)
  const animation = f.load('managers/AnimationManager.ts')
  const step = animation.resolveFrameStepMs
  assert.equal(step(200, true), 200, '导出模式 200ms 帧必须按 200ms 推进')
  assert.equal(step(5000, true), 1000, '只保留 1 秒上限，防止断点恢复一次跳完')
  assert.equal(step(200, false), 200, '预览模式 200ms 也被 250ms 上限允许')
  assert.equal(step(5000, false), 250, '预览模式限制在 250ms')
  assert.equal(step(50, false), 50, '非 elegant 预览不改变帧步进')
  assert.equal(step(50, false, true), 25, 'elegant 预览保留 30~100ms 温和钳制')
})
