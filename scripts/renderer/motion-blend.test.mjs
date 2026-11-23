/**
 * PLAN SNAPSHOT — 与 doc/sekai-exporter-parity-plan.md 同步维护。
 *
 * 官方 PlayableAnimator 的动作混合（`ScenarioModel.ChangeMotionCore` 与
 * `Live2DModel.play`）：
 * - 身体分支顺序：force&&first → 0、same_category/链接 → 0.125s、force → 0、
 *   否则新 clip 的 FadeInTime（缺省 0.5s）；没有旧 clip 时权重直接为 1；
 * - 表情：Force → 0，否则 clip FadeInTime（缺省 0.25s）；
 * - 类别是 `[a-z]-[alnum]+-[alnum]+` 的最长前缀，`_f` 等后缀不参与。
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

function loadBlend() {
  const context = vm.createContext({ console })
  const modules = new Map()
  const compiled = new Map()
  function load(target) {
    const filename = path.isAbsolute(target) ? target : path.join(renderer, target)
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
  return load('model/MotionBlend.ts')
}

test('motion categories and link motions follow the official rule', () => {
  const blend = loadBlend()
  assert.equal(blend.motionCategory('w-kanade-tilthead02'), 'w-kanade-tilthead02')
  assert.equal(blend.motionCategory('w-normal-nod05_f'), 'w-normal-nod05')
  assert.equal(blend.motionCategory('face_normal_01'), '')
  assert.equal(blend.isLinkMotion('w-a-b01_to_w-a-c02'), true)
  assert.equal(blend.isLinkMotion('w-a-b01_to_x'), false)
  assert.equal(blend.isLinkMotion('w-kanade-tilthead02'), false)
})

test('body blend is 0.125s for same category/links and 0.5s otherwise', () => {
  const blend = loadBlend()
  // 第一段 clip：没有旧姿势，权重直接 1（混合时间 0）。
  assert.equal(blend.bodyBlendSeconds(null, 'w-normal-nod01'), 0)
  assert.equal(blend.bodyBlendSeconds('w-normal-nod05', 'w-normal-nod05'), 0.125)
  assert.equal(blend.bodyBlendSeconds('w-normal-nod05_f', 'w-normal-nod05'), 0.125)
  assert.equal(blend.bodyBlendSeconds('w-normal-nod01', 'w-cute-smile01'), 0.5)
  assert.equal(blend.bodyBlendSeconds('w-a-b01', 'w-a-b01_to_w-a-c02'), 0.125)
})

test('body blend uses the clip FadeInTime unless the category rule wins', () => {
  const blend = loadBlend()
  // 不同类：clip 的 FadeInTime（0.2）覆盖缺省 0.5。
  assert.equal(blend.bodyBlendSeconds('w-normal-nod01', 'w-cute-smile01', { clipFadeIn: 0.2 }), 0.2)
  // 同类：仍是 0.125，FadeInTime 不生效。
  assert.equal(
    blend.bodyBlendSeconds('w-normal-nod05', 'w-normal-nod05', { clipFadeIn: 0.2 }),
    0.125
  )
  // force + 同类（非首个）：走 0.125 而不是 0。
  assert.equal(
    blend.bodyBlendSeconds('w-normal-nod05', 'w-normal-nod05', { force: true, first: false }),
    0.125
  )
  // force + 不同类：0。
  assert.equal(
    blend.bodyBlendSeconds('w-normal-nod01', 'w-cute-smile01', { force: true, first: false }),
    0
  )
  // force + 首个：0。
  assert.equal(
    blend.bodyBlendSeconds('w-normal-nod01', 'w-cute-smile01', { force: true, first: true }),
    0
  )
})

test('facial blend uses the clip FadeInTime and Force is 0', () => {
  const blend = loadBlend()
  assert.equal(blend.facialBlendSeconds(false), 0.25)
  assert.equal(blend.facialBlendSeconds(true), 0)
  assert.equal(blend.facialBlendSeconds(false, 0.1), 0.1)
  assert.equal(blend.facialBlendSeconds(true, 0.1), 0)
})
