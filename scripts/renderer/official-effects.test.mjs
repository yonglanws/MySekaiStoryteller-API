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
  const mappedTypes = new Set([
    'Telop',
    'PlaceInfo',
    'SekaiIn',
    'SekaiOut',
    'StopShakeScreen',
    'StopShakeWindow',
    'SideFade',
    'BlurIn',
    'BlurOut',
    'BackgroundBlur',
    'ShakeWindow'
  ])
  const effects = story.snippets.filter((snippet) => mappedTypes.has(snippet.type))
  assert.deepEqual(
    effects.map((snippet) => snippet.type),
    [
      'ShakeWindow',
      'Telop',
      'PlaceInfo',
      'SekaiIn',
      'SekaiOut',
      'StopShakeScreen',
      'StopShakeWindow',
      'SideFade',
      'SideFade',
      'SideFade',
      'SideFade',
      'SideFade',
      'SideFade',
      'SideFade',
      'SideFade',
      'BlurIn',
      'BlurOut',
      'BackgroundBlur'
    ]
  )
  assert.deepEqual(stats.skippedEffects, {})

  const fades = effects.filter((snippet) => snippet.type === 'SideFade')
  assert.deepEqual(
    fades.map((snippet) => [snippet.data.direction, snippet.data.mode]),
    [
      ['Left', 'In'],
      ['Left', 'Out'],
      ['Right', 'In'],
      ['Right', 'Out'],
      ['Top', 'In'],
      ['Top', 'Out'],
      ['Bottom', 'In'],
      ['Bottom', 'Out']
    ]
  )
  assert.equal(effects.at(-1).data.enabled, true)
  assert.equal(effects.at(-1).data.mode, 'In')
  assert.equal(effects.at(-2).type, 'BlurOut')
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
      start: -2432,
      end: 0
    }
  )
  assert.deepEqual(
    { ...sideFadePositions('left', 'in', 1920, 1080) },
    {
      horizontal: true,
      start: 0,
      end: 2432
    }
  )
  assert.deepEqual(
    { ...sideFadePositions('right', 'out', 1920, 1080) },
    {
      horizontal: true,
      start: 2432,
      end: 0
    }
  )
  assert.deepEqual(
    { ...sideFadePositions('top', 'in', 1920, 1080) },
    {
      horizontal: false,
      start: 0,
      end: -1592
    }
  )
  assert.deepEqual(
    { ...sideFadePositions('bottom', 'out', 1920, 1080) },
    {
      horizontal: false,
      start: -1592,
      end: 0
    }
  )
  assert.deepEqual(
    { ...sideFadePositions('top', 'out', 1920, 1080) },
    {
      horizontal: false,
      start: 1592,
      end: 0
    }
  )
  assert.deepEqual(
    { ...sideFadePositions('bottom', 'in', 1920, 1080) },
    {
      horizontal: false,
      start: 0,
      end: 1592
    }
  )
})

test('SideFade hard-edge panel matches the 29~36 from/to table within 1px', () => {
  const { sideFadePlan, sideFadePanelRect, sideFadeEffectType } = runtime.sideFade
  // [effectType, edge, mode, from 方向乘数, to 方向乘数, hide]
  const table = [
    [29, 'left', 'in', [0, 0], [1, 0], true],
    [30, 'left', 'out', [-1, 0], [0, 0], false],
    [31, 'right', 'in', [0, 0], [-1, 0], true],
    [32, 'right', 'out', [1, 0], [0, 0], false],
    [33, 'top', 'in', [0, 0], [0, -1], true],
    [34, 'top', 'out', [0, 1], [0, 0], false],
    [35, 'bottom', 'in', [0, 0], [0, 1], true],
    [36, 'bottom', 'out', [0, -1], [0, 0], false]
  ]
  const ox = 1920 + 512
  const oy = 1080 + 512
  for (const [effectType, edge, mode, fromDir, toDir, hide] of table) {
    const plan = sideFadePlan(edge, mode, 1920, 1080)
    assert.equal(plan.effectType, effectType, `${edge} ${mode} effect type`)
    assert.equal(sideFadeEffectType(edge, mode), effectType)
    assert.equal(plan.hide, hide, `${edge} ${mode} hide`)
    // 硬边：面板就是 contentSize+64，不再额外铺 512px 羽化条。
    assert.equal(plan.pad, 32)
    assert.equal(plan.panel.width, 1984)
    assert.equal(plan.panel.height, 1144)
    assert.deepEqual({ ...plan.from }, { x: fromDir[0] * ox, y: fromDir[1] * oy })
    assert.deepEqual({ ...plan.to }, { x: toDir[0] * ox, y: toDir[1] * oy })

    let maxResidual = 0
    for (let step = 0; step <= 20; step++) {
      const eased = step / 20
      const rect = sideFadePanelRect(plan, eased)
      // 独立按 `sse-render/src/lib.rs:1288-1310` 重算 root rect：
      // x0 = -32 + p.x, y0 = -32 - p.y, rw = cw+64, rh = ch+64。
      const anchorX = fromDir[0] * ox + (toDir[0] - fromDir[0]) * ox * eased
      const anchorY = fromDir[1] * oy + (toDir[1] - fromDir[1]) * oy * eased
      const refX = -32 + anchorX
      const refY = -32 - anchorY
      const refW = 1920 + 64
      const refH = 1080 + 64
      assert.ok(Math.abs(rect.x - refX) <= 1, `${edge} ${mode} e=${eased} x`)
      assert.ok(Math.abs(rect.y - refY) <= 1, `${edge} ${mode} e=${eased} y`)
      assert.ok(Math.abs(rect.width - refW) <= 1, `${edge} ${mode} e=${eased} w`)
      assert.ok(Math.abs(rect.height - refH) <= 1, `${edge} ${mode} e=${eased} h`)
      let refLeading
      if (edge === 'left') refLeading = mode === 'out' ? refX + refW : refX
      else if (edge === 'right') refLeading = mode === 'out' ? refX : refX + refW
      else if (edge === 'top') refLeading = mode === 'out' ? refY + refH : refY
      else refLeading = mode === 'out' ? refY : refY + refH
      maxResidual = Math.max(maxResidual, Math.abs(rect.leading - refLeading))
      assert.ok(
        Math.abs(rect.leading - refLeading) <= 1,
        `${edge} ${mode} e=${eased} leading ${rect.leading} vs ${refLeading}`
      )
    }
    assert.ok(maxResidual <= 1, `${edge} ${mode} max residual ${maxResidual}px`)
  }
})

test('SideFade panel converts 512/32 reference pixels to the 1280x720 export canvas', () => {
  const { sideFadePlan, sideFadePanelRect } = runtime.sideFade
  const scale = 1280 / 1920
  const plan = sideFadePlan('left', 'out', 1280, 720, scale)
  // 逻辑 1280×720、resolution=1.5 → 物理 1920×1080；32/512 按同一比例换算。
  assert.ok(Math.abs(plan.pad * 1.5 - 32) < 1e-9)
  assert.ok(Math.abs(plan.panel.width * 1.5 - 1984) < 1e-9)
  assert.ok(Math.abs(plan.panel.height * 1.5 - 1144) < 1e-9)
  assert.ok(Math.abs(plan.from.x * 1.5 - -2432) < 1e-9)
  const start = sideFadePanelRect(plan, 0)
  assert.ok(Math.abs(start.x * 1.5 - -2464) < 1e-9)
  const vertical = sideFadePlan('top', 'out', 1280, 720, scale)
  assert.ok(Math.abs(vertical.from.y * 1.5 - 1592) < 1e-9)
  assert.ok(Math.abs(vertical.panel.height * 1.5 - 1144) < 1e-9)
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
    [2666.667, 766.667, 1, 0]
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
