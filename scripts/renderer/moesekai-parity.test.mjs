/**
 * PLAN SNAPSHOT — 与 doc/moesekai-parity-plan.md 同步维护。
 *
 * 这个文件是“计划不要被上下文压缩吃掉”的锚点：它不重复行为测试，只检查
 * 计划文档和每个行为测试文件都在，并且计划里的复选框已经全部完成。
 *
 * 四项用户要求与对应测试：
 * 1. 动作切换时而快时而慢 → action-timing / timeline-layout / motion-trace
 * 2. 入场瞬间站桩          → layout-appear / story-preload
 * 3. Irodori 只能读日文    → tts-japanese / tts-irodori-guard
 * 4. 双人不要切人          → staged-writer（planPresence/composeStory）
 * 5. 极详细导出日志        → export-diagnostics / export-log-bus / api/export-diagnostics
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const planPath = path.join(root, 'doc/moesekai-parity-plan.md')
const plan = fs.readFileSync(planPath, 'utf8')

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

test('Moesekai parity plan is present and all phases are checked', () => {
  assert.match(plan, /## 2\. 本次要修的四个问题与根因/)
  assert.match(plan, /### Phase A：动作时序与入场/)
  assert.match(plan, /### Phase B：双人舞台/)
  assert.match(plan, /### Phase C：Irodori 日语 TTS/)
  assert.match(plan, /### Phase D：极详细导出日志/)
  assert.match(plan, /### Phase E：测试与文档/)
  assert.equal(plan.includes('- [ ]'), false, '计划里仍有未完成项；完成后再更新本测试')
})

test('every parity behavior has a checked-in test file', () => {
  for (const relative of requiredTests) {
    assert.ok(fs.existsSync(path.join(root, relative)), `缺少测试：${relative}`)
  }
})
