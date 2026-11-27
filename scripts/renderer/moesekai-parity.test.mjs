/**
 * Moesekai 演出对齐回归测试清单校验：
 * 确认动作时序、入场站桩、双人舞台、Irodori 日语预检与导出诊断日志
 * 对应的行为测试文件均保持在库且被测试套件覆盖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const requiredTests = [
  'scripts/renderer/action-timing.test.mjs',
  'scripts/renderer/timeline-layout.test.mjs',
  'scripts/renderer/layout-appear.test.mjs',
  'scripts/renderer/story-preload.test.mjs',
  'scripts/renderer/motion-trace.test.mjs',
  'scripts/renderer/tts-irodori-guard.test.mjs',
  'scripts/renderer/export-diagnostics.test.mjs',
  'scripts/renderer/export-log-bus.test.mjs',
  'scripts/api/tts-japanese.test.mjs',
  'scripts/api/export-diagnostics.test.mjs',
  'scripts/api/staged-writer.test.mjs',
  'scripts/stories/official-motion-parity.test.mjs'
]

test('every Moesekai parity behavior has a checked-in test file', () => {
  for (const relative of requiredTests) {
    assert.ok(fs.existsSync(path.join(root, relative)), `缺少测试：${relative}`)
  }
})
