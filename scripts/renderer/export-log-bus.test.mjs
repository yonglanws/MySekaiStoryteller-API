/**
 * PLAN SNAPSHOT — 与 doc/moesekai-parity-plan.md 同步维护。
 * ExportLogger 的跨模块顺序由 ExportLogBus 保存，导出结束时一次性落盘。
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

function loadBus() {
  const context = vm.createContext({ console, Date })
  const filename = path.join(renderer, 'managers/video-export/ExportLogBus.ts')
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename
  }).outputText
  const exports = {}
  new vm.Script(`(function (exports, require) {\n${compiled}\n})`, { filename }).runInContext(
    context
  )(exports, () => {
    throw new Error('unexpected require')
  })
  return exports
}

test('ExportLogBus keeps cross-module order and resets per export', () => {
  const { ExportLogBus } = loadBus()
  const bus = new ExportLogBus(3)
  bus.record('INFO', 'A', 'one')
  bus.record('WARN', 'B', 'two', { value: 2 })
  bus.record('ERROR', 'C', 'three')
  assert.deepEqual(
    Array.from(bus.snapshot(), (entry) => `${entry.seq}:${entry.module}:${entry.message}`),
    ['0:A:one', '1:B:two', '2:C:three']
  )
  bus.record('INFO', 'D', 'four')
  assert.equal(bus.size(), 3)
  assert.deepEqual(
    Array.from(bus.snapshot(), (entry) => entry.message),
    ['two', 'three', 'four'],
    '环形缓冲保留最新 3 条'
  )
  bus.reset()
  assert.equal(bus.snapshot().length, 0)
  assert.equal(bus.size(), 0)
})
