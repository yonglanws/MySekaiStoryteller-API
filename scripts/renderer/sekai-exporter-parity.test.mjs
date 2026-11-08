/**
 * PLAN SNAPSHOT — 与 doc/sekai-exporter-parity-plan.md 同步维护。
 *
 * 这个文件是“计划不要被上下文压缩吃掉”的锚点：它不重复行为测试，只检查
 * 计划文档和每个行为测试文件都在，并且计划里的复选框已经全部完成。
 *
 * 参考：https://github.com/StarMoe-org/SekaiStoryExporter
 * 1. 官方 60fps 帧基              → official-timing
 * 2. Talk 自动播放节奏            → official-timing / dialogue-timing
 * 3. Layout 转场                  → layout-appear / timeline-layout / official-timing
 * 4. Live2D 交叉淡化              → motion-blend / motion-trace
 * 5. 眨眼/呼吸/口型               → natural-motion / dialogue-timing
 * 6. Pass 1 逐帧计划与报告        → story-plan / export-diagnostics / api/export-diagnostics
 * 7. 黑幕秒/毫秒单位             → blackout-timing
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const planPath = path.join(root, 'doc/sekai-exporter-parity-plan.md')
const plan = fs.readFileSync(planPath, 'utf8')

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

test('SekaiStoryExporter parity plan is present and all phases are checked', () => {
  assert.match(plan, /## 2\. 本项目当前的主要偏差/)
  assert.match(plan, /### Phase A：官方时序常量单一来源/)
  assert.match(plan, /### Phase B：Talk 自动播放节奏/)
  assert.match(plan, /### Phase C：Layout 转场/)
  assert.match(plan, /### Phase D：Live2D 动作混合与自然动作/)
  assert.match(plan, /### Phase E：Pass 1 故事帧计划与报告/)
  assert.match(plan, /### Phase F：测试与文档/)
  assert.equal(plan.includes('- [ ]'), false, '计划里仍有未完成项；完成后再更新本测试')
})

test('every SekaiStoryExporter behavior has a checked-in test file', () => {
  for (const relative of requiredTests) {
    assert.ok(fs.existsSync(path.join(root, relative)), `缺少测试：${relative}`)
  }
})
