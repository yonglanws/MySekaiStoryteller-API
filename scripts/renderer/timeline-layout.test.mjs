/**
 * PLAN SNAPSHOT — 与 doc/moesekai-parity-plan.md 同步维护。
 *
 * 时间线必须和片段真实执行时间对齐，否则导出日志里 planned/actual 会累积数秒漂移，
 * 也会让 TTS/动作的“计划节奏”和画面不一致。
 *
 * 锁死：
 * - LayoutAppear 原地淡入 200ms，带移动时 max(200, moveSpeed)；
 * - LayoutClear 原地淡出 300ms，带移动时 max(400, moveSpeed)；
 * - ChangeLayoutMode / ChangeBackgroundImage 只改状态，1ms；
 * - HideTalk 300ms；这些片段不受 500ms 最低时长钳制。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const renderer = path.join(root, 'src/renderer/src')

function loadTimeline() {
  const context = vm.createContext({ console })
  const modules = new Map()
  const compiled = new Map()
  function load(relative) {
    const filename = path.isAbsolute(relative) ? relative : path.join(renderer, relative)
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
      assert.ok(name.startsWith('.'), `Unexpected platform dependency: ${name}`)
      return load(path.resolve(path.dirname(filename), `${name}.ts`))
    }
    compiled.get(filename).runInContext(context)(exports, require)
    return exports
  }
  return load('utils/TimelineCalculator.ts')
}

const snippet = (type, data, delay = 0) => ({ type, wait: true, delay, data })

test('timeline durations match the real LayoutAppear/LayoutClear transitions', () => {
  const { calculateTimeline } = loadTimeline()
  const snippets = [
    snippet('LayoutAppear', {
      modelId: 1,
      from: { side: 'Left', offset: 0 },
      to: { side: 'Left', offset: 0 },
      moveSpeed: 'Slow'
    }),
    snippet('LayoutAppear', {
      modelId: 2,
      from: { side: 'Left', offset: 0 },
      to: { side: 'Center', offset: 0 },
      moveSpeed: 'Slow'
    }),
    snippet('LayoutClear', {
      modelId: 1,
      from: { side: 'Left', offset: 0 },
      to: { side: 'Left', offset: 0 },
      fadeOut: true,
      moveSpeed: 'Slow'
    }),
    snippet('LayoutClear', {
      modelId: 2,
      from: { side: 'Center', offset: 0 },
      to: { side: 'Right', offset: 0 },
      moveSpeed: 'Slow'
    })
  ]
  assert.deepEqual(
    Array.from(calculateTimeline(snippets).entries, (entry) => entry.durationMs),
    [116.667, 116.667, 250, 750]
  )
})

test('state-only cues are not padded to 500ms', () => {
  const { calculateTimeline, estimateSnippetDuration } = loadTimeline()
  const snippets = [
    snippet('ChangeLayoutMode', { mode: 'Normal' }),
    snippet('ChangeBackgroundImage', { imageId: 1 }),
    snippet('HideTalk', {}),
    snippet('AmbientColor', { mode: 'night' })
  ]
  assert.deepEqual(
    Array.from(calculateTimeline(snippets).entries, (entry) => entry.durationMs),
    [1, 1, 1, 1]
  )
  assert.deepEqual(
    snippets.map((item) => estimateSnippetDuration(item)),
    [1, 1, 1, 1]
  )
})
