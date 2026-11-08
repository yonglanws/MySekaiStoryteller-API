/**
 * 黑屏保护取样的回归测试。
 *
 * 旧实现只 readPixels 左下角 64x64。官方冷开场常用纯黑背景
 * （bg_a000000），角色在中央、字幕在底部中央，左下角永远是黑的，
 * 于是合法剧本被误判成“模型没渲染”而中止导出。
 *
 * 这个测试用假 WebGL 上下文构造“左下角黑、中央有字/角色”的画面：
 * 只要取样覆盖中央，就必须判为非黑屏。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const renderer = path.join(root, 'src/renderer/src')

function loadValidator() {
  const context = vm.createContext({ console })
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    getSubLogger() {
      return this
    }
  }
  const file = path.join(renderer, 'utils/FrameContentValidator.ts')
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: file
  }).outputText
  const module = { exports: {} }
  const require = (name) => {
    if (name.endsWith('utils/Logger')) return { default: () => logger }
    throw new Error(`Unexpected dependency: ${name}`)
  }
  new vm.Script(`(function (exports, require) {\n${compiled}\n})`, { filename: file }).runInContext(
    context
  )(module.exports, require)
  return module.exports
}

function makeCanvas(pixelAt, width = 192, height = 108) {
  const gl = {
    isContextLost: () => false,
    readPixels(x, y, w, h, _format, _type, buffer) {
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const [r, g, b, a] = pixelAt(x + col, y + row)
          const index = (row * w + col) * 4
          buffer[index] = r
          buffer[index + 1] = g
          buffer[index + 2] = b
          buffer[index + 3] = a
        }
      }
    }
  }
  return { width, height, getContext: () => gl }
}

test('bright content in the centre is not reported as a black screen', () => {
  const { FrameContentValidator } = loadValidator()
  const validator = new FrameContentValidator()
  // 1280x720 的中央区域亮，左下角始终黑——与“纯黑背景 + 居中角色/字幕”一致。
  const canvas = makeCanvas(
    (x, y) => (x > 480 && x < 800 && y > 240 && y < 480 ? [255, 255, 255, 255] : [0, 0, 0, 255]),
    1280,
    720
  )
  const result = validator.validateFrame(canvas, 0)
  assert.equal(result.isBlackScreen, false, `brightness=${result.brightness}`)
})

test('a genuinely black frame is still reported', () => {
  const { FrameContentValidator } = loadValidator()
  const validator = new FrameContentValidator()
  const canvas = makeCanvas(() => [0, 0, 0, 255])
  const result = validator.validateFrame(canvas, 0)
  assert.equal(result.isBlackScreen, true)
  assert.equal(result.error, undefined, 'single black frame is tolerated, not fatal')
})
