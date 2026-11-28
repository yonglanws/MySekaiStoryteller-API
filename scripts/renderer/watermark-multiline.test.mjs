/**
 * Multi-line watermark unit tests for UIWatermark & newline normalization.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const rendererSrc = path.join(root, 'src/renderer/src')
const nodeRequire = createRequire(import.meta.url)

function createPixiMock() {
  class ObservablePoint {
    constructor(x = 0, y = 0) {
      this.x = x
      this.y = y
    }
    set(x = 0, y = x) {
      this.x = x
      this.y = y
    }
  }
  class Container {
    constructor() {
      this.children = []
      this.x = 0
      this.y = 0
      this.alpha = 1
      this.visible = true
      this.scale = new ObservablePoint(1, 1)
      this.pivot = new ObservablePoint(0, 0)
      this.position = new ObservablePoint(0, 0)
      this.zIndex = 0
    }
  }
  class TextStyle {
    constructor(opts = {}) {
      Object.assign(this, opts)
    }
  }
  class Text extends Container {
    constructor(text = '', style = new TextStyle()) {
      super()
      this.text = text
      this.style = style
      this.anchor = new ObservablePoint(0, 0)
    }
  }
  return { Container, Text, TextStyle }
}

function loadWatermarkModule() {
  const pixi = createPixiMock()
  const context = vm.createContext({
    console,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    Error
  })
  const modules = new Map()

  function resolveFile(fromDir, spec) {
    const raw = path.resolve(fromDir, spec)
    for (const candidate of [raw, `${raw}.ts`, path.join(raw, 'index.ts')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    }
    return raw
  }

  function load(target) {
    const filename = path.isAbsolute(target) ? target : path.join(rendererSrc, target)
    if (modules.has(filename)) return modules.get(filename)
    const transpiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true
      },
      fileName: filename
    }).outputText
    const exports = {}
    modules.set(filename, exports)
    const require = (spec) => {
      if (spec === 'pixi.js') return pixi
      if (!spec.startsWith('.')) return nodeRequire(spec)
      return load(resolveFile(path.dirname(filename), spec))
    }
    new vm.Script(`(function (exports, require) {\n${transpiled}\n})`, { filename }).runInContext(
      context
    )(exports, require)
    return exports
  }

  return load('components/UIWatermark.ts')
}

test('normalizeWatermarkText decodes real LF/CRLF/CR and literal \\n while preserving double-escaped \\\\n', () => {
  const { normalizeWatermarkText } = loadWatermarkModule()

  assert.equal(normalizeWatermarkText(''), '')
  assert.equal(normalizeWatermarkText('   \r\n  \n  '), '')
  assert.equal(normalizeWatermarkText(null), '')
  assert.equal(normalizeWatermarkText('单行水印'), '单行水印')

  // Real newlines (LF, CRLF, CR)
  assert.equal(normalizeWatermarkText('第一行\n第二行'), '第一行\n第二行')
  assert.equal(normalizeWatermarkText('第一行\r\n第二行\r\n第三行'), '第一行\n第二行\n第三行')
  assert.equal(normalizeWatermarkText('第一行\r第二行'), '第一行\n第二行')

  // Escaped literal \n and \r\n (from .env / single-line config / CLI)
  assert.equal(normalizeWatermarkText('第一行\\n第二行'), '第一行\n第二行')
  assert.equal(normalizeWatermarkText('Line 1\\r\\nLine 2\\nLine 3'), 'Line 1\nLine 2\nLine 3')

  // Mixed real + escaped newlines & trailing YAML block newline
  assert.equal(normalizeWatermarkText('Line 1\r\nLine 2\\nLine 3\n'), 'Line 1\nLine 2\nLine 3')

  // Double-escaped \\n preserves literal \n; unrelated backslashes stay untouched
  assert.equal(normalizeWatermarkText('Literal \\\\n stays'), 'Literal \\n stays')
  assert.equal(normalizeWatermarkText('Backslash \\\\ kept'), 'Backslash \\\\ kept')
})

test('UIWatermark keeps default and single-line rendering visually identical with crisp lineHeight', () => {
  const { default: UIWatermark, WATERMARK_LINE_1, WATERMARK_LINE_2 } = loadWatermarkModule()

  for (const [w, h] of [
    [1280, 720],
    [1920, 1080]
  ]) {
    const wm = new UIWatermark(w, h)
    const expectedFontSize = h / 48
    const expectedLineHeight = Math.round(expectedFontSize * 1.3)

    assert.equal(wm.text, `${WATERMARK_LINE_1}\n${WATERMARK_LINE_2}`)
    assert.equal(wm.anchor.x, 1)
    assert.equal(wm.anchor.y, 0)
    assert.equal(wm.x, w - w / 48)
    assert.equal(wm.y, h / 36)
    assert.equal(wm.style.align, 'right')
    assert.equal(wm.style.fontSize, expectedFontSize)
    assert.equal(wm.style.lineHeight, expectedLineHeight)
    assert.equal(Number.isInteger(wm.style.lineHeight), true)

    // Single custom line replaces both default lines
    wm.setCustomText('B站 @某UP主')
    assert.equal(wm.text, 'B站 @某UP主')
    assert.equal(wm.x, w - w / 48)
    assert.equal(wm.y, h / 36)
    assert.equal(wm.style.align, 'right')
    assert.equal(wm.style.fontSize, expectedFontSize)
    assert.equal(wm.style.lineHeight, expectedLineHeight)

    const bounds = wm.getLayoutBounds()
    assert.equal(bounds.lineCount, 1)
    assert.ok(
      bounds.left >= 0 && bounds.right <= w,
      `horizontal bounds out of canvas: ${JSON.stringify(bounds)}`
    )
    assert.ok(
      bounds.top >= 0 && bounds.bottom <= h,
      `vertical bounds out of canvas: ${JSON.stringify(bounds)}`
    )
  }
})

test('UIWatermark supports 1-line, 2-line, and 4-line watermarks from real and escaped newlines within canvas bounds', () => {
  const { default: UIWatermark, WATERMARK_LINE_1, WATERMARK_LINE_2 } = loadWatermarkModule()

  for (const [w, h] of [
    [1280, 720],
    [1920, 1080]
  ]) {
    const wm = new UIWatermark(w, h)

    // 1-line custom replaces defaults
    wm.setCustomText('第一行')
    assert.deepEqual(wm.text.split('\n'), ['第一行'])
    let bounds = wm.getLayoutBounds()
    assert.equal(bounds.lineCount, 1)
    assert.ok(bounds.left >= 0 && bounds.right <= w)
    assert.ok(bounds.top >= 0 && bounds.bottom <= h)

    // 2-line custom via literal \n replaces defaults
    wm.setCustomText('第一行\\n第二行')
    assert.deepEqual(wm.text.split('\n'), ['第一行', '第二行'])
    bounds = wm.getLayoutBounds()
    assert.equal(bounds.lineCount, 2)
    assert.equal(wm.style.align, 'right')
    assert.equal(wm.style.lineHeight, Math.round((h / 48) * 1.3))
    assert.ok(bounds.left >= 0 && bounds.right <= w)
    assert.ok(bounds.top >= 0 && bounds.bottom <= h)

    // 4-line custom via mixed \r\n and literal \n
    wm.setCustomText('作者：测试君\r\n二创剧情 仅供娱乐\\nBGM: Project SEKAI\n2026-11-28')
    assert.deepEqual(wm.text.split('\n'), [
      '作者：测试君',
      '二创剧情 仅供娱乐',
      'BGM: Project SEKAI',
      '2026-11-28'
    ])
    bounds = wm.getLayoutBounds()
    assert.equal(bounds.lineCount, 4)
    assert.equal(wm.style.align, 'right')
    assert.equal(wm.style.lineHeight, Math.round((h / 48) * 1.3))
    assert.ok(bounds.left >= 0 && bounds.right <= w, `4-line horizontal overflow on ${w}x${h}`)
    assert.ok(bounds.top >= 0 && bounds.bottom <= h, `4-line vertical overflow on ${w}x${h}`)

    // Custom text replaces defaults; echoing only the built-in lines falls back
    wm.setCustomText(`${WATERMARK_LINE_1}\\n自定义A\\n自定义B`)
    assert.deepEqual(wm.text.split('\n'), [WATERMARK_LINE_1, '自定义A', '自定义B'])
    wm.setCustomText(`${WATERMARK_LINE_1}\\n${WATERMARK_LINE_2}`)
    assert.deepEqual(wm.text.split('\n'), [WATERMARK_LINE_1, WATERMARK_LINE_2])

    wm.setCustomText('  \\n  \r\n  ')
    assert.deepEqual(wm.text.split('\n'), [WATERMARK_LINE_1, WATERMARK_LINE_2])
  }
})

test('UIWatermark syncs align with anchor and clamps extreme multi-line/edge placements inside canvas', () => {
  const { default: UIWatermark, resolveWatermarkAlign } = loadWatermarkModule()

  assert.equal(resolveWatermarkAlign(1), 'right')
  assert.equal(resolveWatermarkAlign(0.5), 'center')
  assert.equal(resolveWatermarkAlign(0), 'left')

  const wm = new UIWatermark(1280, 720)

  // Bottom-right anchor near bottom edge must clamp up so 4 lines never clip off bottom
  wm.anchor.set(1, 1)
  wm.x = 1280
  wm.y = 720
  wm.setCustomText('Line 1\nLine 2\nLine 3\nLine 4')
  assert.equal(wm.style.align, 'right')
  let bounds = wm.getLayoutBounds()
  assert.ok(bounds.right <= 1280 && bounds.bottom <= 720)
  assert.ok(bounds.left >= 0 && bounds.top >= 0)

  // Bottom-right anchor placed too close to top edge must clamp down so lines never clip off top
  wm.y = 10
  wm.updateLayout()
  bounds = wm.getLayoutBounds()
  assert.ok(bounds.top >= 720 / 36 - 1e-6, `expected top >= marginY, got ${bounds.top}`)
  assert.ok(bounds.bottom <= 720)

  // Left-aligned anchor
  wm.anchor.set(0, 0)
  wm.x = 0
  wm.y = 0
  wm.updateLayout()
  assert.equal(wm.style.align, 'left')
  bounds = wm.getLayoutBounds()
  assert.ok(bounds.left >= 1280 / 48 - 1e-6)
  assert.ok(bounds.top >= 720 / 36 - 1e-6)

  // Center-aligned anchor
  wm.anchor.set(0.5, 0.5)
  wm.x = 640
  wm.y = 360
  wm.updateLayout()
  assert.equal(wm.style.align, 'center')
  bounds = wm.getLayoutBounds()
  assert.ok(bounds.left >= 0 && bounds.right <= 1280)
  assert.ok(bounds.top >= 0 && bounds.bottom <= 720)

  // Extreme 45-line watermark auto-fits fontSize/lineHeight so it stays strictly inside 1280x720
  wm.anchor.set(1, 0)
  wm.x = 1280 - 1280 / 48
  wm.y = 720 / 36
  const manyLines = Array.from({ length: 45 }, (_, i) => `第 ${i + 1} 行水印内容`).join('\n')
  wm.setCustomText(manyLines)
  bounds = wm.getLayoutBounds()
  assert.equal(bounds.lineCount, 45)
  assert.ok(wm.style.fontSize < 720 / 48, 'extreme line count should shrink fontSize to fit')
  assert.ok(
    bounds.top >= 0 && bounds.bottom <= 720,
    `45-line block clipped: ${JSON.stringify(bounds)}`
  )
  assert.ok(bounds.left >= 0 && bounds.right <= 1280)

  // Resetting to a normal 2-line watermark restores full base fontSize and lineHeight
  wm.setCustomText('恢复正常\\n第二行')
  assert.equal(wm.style.fontSize, 720 / 48)
  assert.equal(wm.style.lineHeight, Math.round((720 / 48) * 1.3))
})
