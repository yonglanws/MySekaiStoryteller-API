/**
 * ProgressBehavior=0 的非阻塞调度回归。
 *
 * 官方语义：片段协程启动后调度器立刻继续下一条；delay/动画在后台跑，
 * 收尾 WaitAllFinished 再统一等待。这里锁死三件事：
 * - timeline 给非阻塞片段 0ms，plan 不推进下一句起点，但保留它的 delay；
 * - Talk 与其它片段一样只看 ProgressBehavior：Now 不再有隐式前置栅栏；
 * - BackgroundSnippetTasks 能等待完成、传播错误、reset 后不再阻塞。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { loadAuditRuntime } from '../stories/official-plan-audit.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function loadBackgroundTasks() {
  const filename = path.join(root, 'src/renderer/src/utils/BackgroundSnippetTasks.ts')
  const context = vm.createContext({ console })
  const exports = {}
  const script = new vm.Script(
    `(function (exports, require) {\n${
      ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        fileName: filename
      }).outputText
    }\n})`,
    { filename }
  )
  script.runInContext(context)(exports, (name) => {
    throw new Error(`Unexpected dependency: ${name}`)
  })
  return exports.BackgroundSnippetTasks
}

const runtime = loadAuditRuntime()
const { timeline, plan, timing } = runtime

const talk = (content, wait = true) => ({
  type: 'Talk',
  wait,
  delay: 0,
  data: { speaker: 'A', content, ttsText: '', voice: '', modelId: 1 }
})

test('Now snippets overlap at caller cursor while WaitFinished fences prior tasks before delay', () => {
  const snippets = [
    talk('あ'.repeat(10)),
    {
      type: 'LayoutAppear',
      wait: false,
      delay: 0.5,
      data: {
        modelId: 2,
        from: { side: 'Left', offset: 0 },
        to: { side: 'Right', offset: 0 },
        motion: '',
        facial: '',
        moveSpeed: 'Slow'
      }
    },
    talk('い'.repeat(10))
  ]
  const result = timeline.calculateTimeline(snippets, new Map())
  const baked = plan.bakeStoryPlan(snippets, result.entries)

  // PlayCore 从第 10 帧开始：snippet 0 (WaitFinished) 启动后立即推进到 snippet 1 (Now)，
  // snippet 1 自身仍有 7f (116.667ms) 淡入；snippet 2 (WaitFinished) 前置等待前两条都完成。
  assert.equal(result.entries[1].blocking, false)
  assert.equal(result.entries[1].durationMs, 116.667)
  assert.equal(result.validationSummary.crossValidationPassed, true)
  assert.equal(result.validationSummary.anomaliesDetected.length, 0)

  const talk1EndFrame =
    timing.PLAYCORE_WARMUP_FRAMES + Math.round(result.entries[0].durationMs / timing.FRAME_MS)
  assert.equal(baked.entries[1].delayStartFrame, timing.PLAYCORE_WARMUP_FRAMES)
  assert.equal(
    baked.entries[1].startFrame,
    timing.PLAYCORE_WARMUP_FRAMES + timing.framesForSeconds(0.5)
  )
  assert.equal(
    baked.entries[1].endFrame,
    timing.PLAYCORE_WARMUP_FRAMES + timing.framesForSeconds(0.5) + 8
  )
  assert.equal(baked.entries[1].blocking, false)
  assert.equal(
    baked.entries[2].startFrame,
    talk1EndFrame + 1,
    '下一个 WaitFinished 片段等前面所有在跑任务完成后，下一帧才启动'
  )

  // 当 Now 片段自身耗时更长（如 1.0s SideFade）时，后续 WaitFinished 必须等到它完成。
  const fenced = timeline.calculateTimeline(
    [
      {
        type: 'SideFade',
        progressBehavior: 'Now',
        delay: 0.2,
        data: { direction: 'Left', mode: 'In', duration: 1 }
      },
      talk('う'.repeat(2))
    ],
    new Map()
  )
  assert.equal(fenced.entries[0].delayStartTimeMs, 0)
  assert.equal(fenced.entries[0].startTimeMs, 200)
  // 1.0s 按 f32 frames_for = 61 帧；下一帧栅栏后 Talk 才启动。
  assert.equal(fenced.entries[0].endTimeMs, 1216.667)
  assert.equal(Math.round(fenced.entries[1].startTimeMs * 1000) / 1000, 1233.334)
})

test('Talk follows an explicit ProgressBehavior=Now instead of forcing a pre-fence', () => {
  const snippets = [talk('あ'.repeat(10), false)]
  const result = timeline.calculateTimeline(snippets, new Map())
  const baked = plan.bakeStoryPlan(snippets, result.entries)
  assert.equal(result.entries[0].blocking, false)
  assert.ok(result.entries[0].durationMs > 0)
  assert.equal(baked.entries[0].blocking, false)
  assert.equal(baked.entries[0].durationFrames, timing.msToFrameCount(result.entries[0].durationMs))
})

test('BackgroundSnippetTasks waits, propagates failures and resets', async () => {
  const BackgroundSnippetTasks = loadBackgroundTasks()
  const tasks = new BackgroundSnippetTasks()
  let release
  const pending = new Promise((resolve) => {
    release = resolve
  })
  tasks.track(pending)
  assert.equal(tasks.size, 1)

  let settled = false
  const settlePromise = tasks.settle().then(() => {
    settled = true
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(settled, false)
  release()
  await settlePromise
  assert.equal(settled, true)
  assert.equal(tasks.size, 0)

  tasks.track(Promise.reject(new Error('background failed')))
  await assert.rejects(tasks.settle(), /background failed/)
  assert.equal(tasks.size, 0)

  tasks.track(new Promise(() => {}))
  tasks.reset()
  assert.equal(tasks.size, 0)
  await tasks.settle()
})
