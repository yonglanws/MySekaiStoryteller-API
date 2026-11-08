/**
 * 官方剩余特效类型回归。
 *
 * SSE `sse-scenario` 对 SpecialEffect 的映射：
 * - 8 → Telop；18 → PlaceInfo（用 Telop 近似）
 * - 20/21/40/41 → SekaiTransition（Wipe 近似）
 * - 25/26 → StopShakeScreen/Window
 * - 29~36 → ScenarioSideFadePlayer（Left/Right/Top/Bottom × In/Out）
 * - 38/39 → BlurIn/BlurOut（背景模糊近似）
 * - 44 → BackgroundBlur
 * - 6 → ShakeWindow（ShakeScreen 近似）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { loadAuditRuntime, mapOfficialEpisode } from '../stories/official-plan-audit.mjs'
import { sideFadeOf } from '../stories/pjsk-scenario.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const renderer = path.join(root, 'src/renderer/src')
const runtime = loadAuditRuntime()
const { timeline, timing } = runtime

function loadSnippets() {
  const context = vm.createContext({ console, setTimeout, clearTimeout, AbortController })
  class Logger {
    info() {}
    error() {}
    debug() {}
    warn() {}
    getSubLogger() {
      return this
    }
  }
  const mocks = new Map([
    [path.join(renderer, 'utils/Logger.ts'), { default: () => new Logger() }],
    [
      path.join(renderer, 'managers/AnimationManager.ts'),
      {
        default: {
          delay: async () => {},
          linear: async () => {},
          in_ticker: async () => {},
          isExporting: () => false
        }
      }
    ]
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
  return load
}

function effectScenario(types) {
  const effects = types.map((type, index) => ({
    EffectType: type,
    Duration: 0.5,
    StringVal: type === 8 ? `TELOP-${index}` : type === 18 ? `PLACE-${index}` : 'true',
    StringValSub: '',
    IntVal: 0
  }))
  return {
    FirstBackground: 'bg_test',
    FirstBgm: 'bgm00000',
    FirstCharacterLayoutMode: 0,
    TalkData: [],
    LayoutData: [],
    SpecialEffectData: effects,
    SoundData: [],
    Snippets: effects.map((_, index) => ({
      Index: index,
      Action: 6,
      ProgressBehavior: 1,
      ReferenceIndex: index,
      Delay: 0
    }))
  }
}

test('official effect types map to the Story snippets', () => {
  const types = [6, 8, 18, 20, 21, 25, 26, 29, 30, 31, 32, 33, 34, 35, 36, 38, 39, 44]
  const { story, stats } = mapOfficialEpisode(effectScenario(types))
  const effects = story.snippets.filter((snippet) =>
    ['Telop', 'Wipe', 'StopShake', 'SideFade', 'BackgroundBlur', 'ShakeScreen'].includes(
      snippet.type
    )
  )
  assert.deepEqual(
    effects.map((snippet) => snippet.type),
    [
      'ShakeScreen',
      'Telop',
      'Telop',
      'Wipe',
      'Wipe',
      'StopShake',
      'StopShake',
      'SideFade',
      'SideFade',
      'SideFade',
      'SideFade',
      'SideFade',
      'SideFade',
      'SideFade',
      'SideFade',
      'BackgroundBlur',
      'BackgroundBlur',
      'BackgroundBlur'
    ]
  )
  assert.deepEqual(stats.skippedEffects, {})

  const fades = effects.filter((snippet) => snippet.type === 'SideFade')
  assert.deepEqual(
    fades.map((snippet) => [snippet.data.edge, snippet.data.mode]),
    [
      ['left', 'in'],
      ['left', 'out'],
      ['right', 'in'],
      ['right', 'out'],
      ['top', 'in'],
      ['top', 'out'],
      ['bottom', 'in'],
      ['bottom', 'out']
    ]
  )
  assert.equal(effects.at(-1).data.enabled, true)
  assert.equal(effects.at(-2).data.enabled, false)
})

test('SideFade mapping follows SSE 29~36 exactly', () => {
  assert.deepEqual(sideFadeOf(29), { edge: 'left', mode: 'in' })
  assert.deepEqual(sideFadeOf(30), { edge: 'left', mode: 'out' })
  assert.deepEqual(sideFadeOf(31), { edge: 'right', mode: 'in' })
  assert.deepEqual(sideFadeOf(32), { edge: 'right', mode: 'out' })
  assert.deepEqual(sideFadeOf(33), { edge: 'top', mode: 'in' })
  assert.deepEqual(sideFadeOf(34), { edge: 'top', mode: 'out' })
  assert.deepEqual(sideFadeOf(35), { edge: 'bottom', mode: 'in' })
  assert.deepEqual(sideFadeOf(36), { edge: 'bottom', mode: 'out' })
})

test('SideFade positions cover from the edge and reveal toward the opposite side', () => {
  const { sideFadePositions } = runtime.sideFade
  assert.deepEqual(
    { ...sideFadePositions('left', 'out', 1920, 1080) },
    {
      horizontal: true,
      start: -1920,
      end: 0
    }
  )
  assert.deepEqual(
    { ...sideFadePositions('left', 'in', 1920, 1080) },
    {
      horizontal: true,
      start: 0,
      end: 1920
    }
  )
  assert.deepEqual(
    { ...sideFadePositions('right', 'out', 1920, 1080) },
    {
      horizontal: true,
      start: 1920,
      end: 0
    }
  )
  assert.deepEqual(
    { ...sideFadePositions('top', 'in', 1920, 1080) },
    {
      horizontal: false,
      start: 0,
      end: -1080
    }
  )
  assert.deepEqual(
    { ...sideFadePositions('bottom', 'out', 1920, 1080) },
    {
      horizontal: false,
      start: 1080,
      end: 0
    }
  )
})

test('new effect snippets take their exact official duration', () => {
  const snippets = [
    { type: 'Telop', wait: true, delay: 0, data: { content: 'x' } },
    {
      type: 'SideFade',
      wait: true,
      delay: 0,
      data: { edge: 'left', mode: 'out', duration: 750 }
    },
    { type: 'BackgroundBlur', wait: true, delay: 0, data: { enabled: true } },
    { type: 'StopShake', wait: true, delay: 0, data: {} }
  ]
  const result = timeline.calculateTimeline(snippets, new Map())
  assert.deepEqual(
    Array.from(result.entries, (entry) => entry.durationMs),
    [2666.667, 750, 1, 1]
  )
  assert.equal(timing.TELOP_ANIM_CLIP_MS, 333.333)
  assert.equal(timing.TELOP_AUTO_HOLD_MS, 2000)
  assert.equal(timing.TELOP_TOTAL_MS, 2666.667)
})

test('new snippets call the corresponding layer APIs', async () => {
  const load = loadSnippets()
  const calls = []
  const app = {
    layerSpecialEffect: {
      async sideFade(edge, mode, duration) {
        calls.push(['sideFade', edge, mode, duration])
      }
    },
    layerBackground: {
      setBlur(enabled) {
        calls.push(['setBlur', enabled])
      }
    },
    stopShake() {
      calls.push(['stopShake'])
    }
  }
  const SideFadeSnippet = load('snippets/SideFadeSnippet.ts').default
  const BackgroundBlurSnippet = load('snippets/BackgroundBlurSnippet.ts').default
  const StopShakeSnippet = load('snippets/StopShakeSnippet.ts').default

  await new SideFadeSnippet(app, {
    type: 'SideFade',
    wait: true,
    delay: 0,
    data: { edge: 'bottom', mode: 'in', duration: 500 }
  }).runSnippet()
  await new BackgroundBlurSnippet(app, {
    type: 'BackgroundBlur',
    wait: true,
    delay: 0,
    data: { enabled: true }
  }).runSnippet()
  await new StopShakeSnippet(app, { type: 'StopShake', wait: true, delay: 0 }).runSnippet()

  assert.deepEqual(calls, [['sideFade', 'bottom', 'in', 500], ['setBlur', true], ['stopShake']])
})
