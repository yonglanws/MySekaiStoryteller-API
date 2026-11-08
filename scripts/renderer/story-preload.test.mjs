/**
 * PLAN SNAPSHOT — 与 doc/moesekai-parity-plan.md 同步维护。
 *
 * 问题 2 的第二个根因：StoryManager.preloadModels 只扫描 Talk/Motion，
 * 没有预加载 LayoutAppear/LayoutClear 的动作。第一次入场必然冷加载，
 * 淡入已经开始了动作还没开始，形成站桩。
 *
 * 这个测试锁死：入场、退场、台词、Motion 里出现的所有 motion/facial 都要预加载。
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

test('preloadModels warms entrance, exit, talk and motion clips', async () => {
  const loaded = []
  class FakeModel {
    internalModel = {
      motionManager: {
        loadMotion: async (name) => {
          loaded.push(name)
          return { name }
        }
      }
    }
    static async from() {
      return new FakeModel()
    }
    initialize() {}
  }
  class Cubism2InternalModel {}
  class Texture {
    static async fromURL() {
      return {}
    }
  }
  const context = vm.createContext({ console })
  const mocks = new Map([
    [path.join(renderer, 'model/AdvancedModel.ts'), { default: FakeModel }],
    [path.join(renderer, 'utils/ResourceUrl.ts'), { resourceUrl: (value) => value }],
    ['pixi-live2d-display-advanced', { Cubism2InternalModel }],
    ['pixi.js', { Texture, Resource: class {}, Ticker: { shared: {} } }]
  ])
  const modules = new Map()
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

  const StoryManager = load('managers/StoryManager.ts').default
  const manager = new StoryManager({
    models: [{ id: 1, model: 'a.model3.json' }],
    images: [],
    snippets: [
      { type: 'LayoutAppear', data: { modelId: 1, motion: 'entry-motion', facial: 'entry-face' } },
      { type: 'LayoutClear', data: { modelId: 1, motion: 'exit-motion' } },
      { type: 'Talk', data: { modelId: 1, motion: 'talk-motion', facial: 'talk-face' } },
      {
        type: 'Motion',
        data: {
          modelId: 1,
          motion: 'motion-snippet',
          facial: 'motion-face',
          actions: [{ at: 0.5, modelId: 1, motion: 'action-motion', facial: 'action-face' }]
        }
      }
    ]
  })
  await manager.preloadModels()
  assert.deepEqual(
    new Set(loaded),
    new Set([
      'entry-motion',
      'entry-face',
      'exit-motion',
      'talk-motion',
      'talk-face',
      'motion-snippet',
      'motion-face',
      'action-motion',
      'action-face'
    ])
  )
})
