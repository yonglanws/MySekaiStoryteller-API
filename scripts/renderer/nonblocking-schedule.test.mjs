/**
 * ProgressBehavior=0 的非阻塞调度回归。
 *
 * 官方语义：片段协程启动后调度器立刻继续下一条；delay/动画在后台跑，
 * 收尾 WaitAllFinished 再统一等待。这里锁死三件事：
 * - timeline 给非阻塞片段 0ms，plan 不推进下一句起点，但保留它的 delay；
 * - Talk 强制阻塞（TTS/字幕串行），即使剧本写了 wait:false；
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

test('non-blocking snippets take 0ms and do not advance the next snippet', () => {
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

  assert.equal(result.entries[1].blocking, false)
  assert.equal(result.entries[1].durationMs, 0)
  assert.equal(result.validationSummary.crossValidationPassed, true)
  assert.equal(result.validationSummary.anomaliesDetected.length, 0)

  const talk1Frames = result.entries[0].durationMs / timing.FRAME_MS
  assert.equal(baked.entries[1].delayStartFrame, Math.round(talk1Frames))
  assert.equal(baked.entries[1].startFrame, Math.round(talk1Frames) + timing.framesForSeconds(0.5))
  assert.equal(baked.entries[1].endFrame, baked.entries[1].startFrame)
  assert.equal(baked.entries[1].blocking, false)
  assert.equal(
    baked.entries[2].startFrame,
    Math.round(talk1Frames),
    '下一条从非阻塞片段启动前的 cursor 开始，而不是 delay 之后'
  )
})

test('Talk stays blocking even if the scenario says ProgressBehavior=0', () => {
  const snippets = [talk('あ'.repeat(10), false)]
  const result = timeline.calculateTimeline(snippets, new Map())
  const baked = plan.bakeStoryPlan(snippets, result.entries)
  assert.equal(result.entries[0].blocking, true)
  assert.ok(result.entries[0].durationMs > 0)
  assert.equal(baked.entries[0].blocking, true)
  assert.equal(
    baked.entries[0].durationFrames,
    timing.framesForSeconds(result.entries[0].durationMs / 1000)
  )
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
