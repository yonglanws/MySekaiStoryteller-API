/**
 * SekaiStoryExporter 60fps 官方时序与演出对齐测试清单校验：
 * 确认官方帧基、Talk 自动推进、Layout 转场、Live2D 混合、自然动作、
 * 逐帧故事计划与黑幕时序对应的行为测试文件均保持在库。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const requiredTests = [
  'scripts/renderer/official-timing.test.mjs',
  'scripts/renderer/motion-blend.test.mjs',
  'scripts/renderer/natural-motion.test.mjs',
  'scripts/renderer/story-plan.test.mjs',
  'scripts/renderer/blackout-timing.test.mjs',
  'scripts/renderer/layout-appear.test.mjs',
  'scripts/renderer/timeline-layout.test.mjs',
  'scripts/renderer/motion-trace.test.mjs',
  'scripts/renderer/export-diagnostics.test.mjs',
  'scripts/api/export-diagnostics.test.mjs',
  'scripts/renderer/layout-matrix.test.mjs',
  'scripts/renderer/crossfade-params.test.mjs',
  'scripts/renderer/nonblocking-schedule.test.mjs',
  'scripts/renderer/official-effects.test.mjs',
  'scripts/stories/official-plan-audit.test.mjs'
]

test('every SekaiStoryExporter parity behavior has a checked-in test file', () => {
  for (const relative of requiredTests) {
    assert.ok(fs.existsSync(path.join(root, relative)), `缺少测试：${relative}`)
  }
})
