/**
 * 渲染端导出测试的 TypeScript 加载器：把 `src/renderer/src` 下的模块现场转译成
 * CommonJS 并在隔离 vm 上下文里运行，mocks 按「请求字面量 / 绝对路径」命中。
 *
 * 从 `render-export-wave5.test.mjs` 抽出来，供帧泵/帧数用例复用；行为与原来一致。
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)

export function createRendererLoader(mocks = new Map(), extraGlobals = {}) {
  const root = process.cwd()
  const rendererRoot = path.join(root, 'src/renderer/src')
  const modules = new Map()
  const compiled = new Map()
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    requestAnimationFrame: (cb) => setTimeout(() => cb(performance.now()), 16),
    cancelAnimationFrame: (id) => clearTimeout(id),
    AbortController,
    performance,
    navigator: { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    Uint8Array,
    Int16Array,
    Float32Array,
    ArrayBuffer,
    DataView,
    Buffer,
    Promise,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Error,
    Math,
    ...extraGlobals
  })
  vm.runInContext('this.Date = Date; this.Promise = Promise', context)

  function load(target, fromDir = rendererRoot) {
    for (const [key, value] of mocks.entries()) {
      if (target === key) return value
    }

    const baseCandidate = target.startsWith('.')
      ? path.resolve(fromDir, target)
      : path.isAbsolute(target)
        ? target
        : path.join(rendererRoot, target)

    for (const [key, value] of mocks.entries()) {
      if (key === baseCandidate || key === `${baseCandidate}.ts`) return value
    }

    const candidates = [baseCandidate, `${baseCandidate}.ts`, path.join(baseCandidate, 'index.ts')]
    const resolved = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile())
    if (!resolved) {
      return require(target)
    }
    if (modules.has(resolved)) return modules.get(resolved)

    if (!compiled.has(resolved)) {
      const source = fs.readFileSync(resolved, 'utf8')
      const transpiled = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true
        },
        fileName: resolved
      }).outputText
      compiled.set(
        resolved,
        new vm.Script(
          `(function (exports, require, module, __filename, __dirname) {\n${transpiled}\n})`,
          { filename: resolved }
        )
      )
    }

    const mod = { exports: {} }
    modules.set(resolved, mod.exports)
    const localRequire = (dep) => load(dep, path.dirname(resolved))
    compiled.get(resolved).runInContext(context)(
      mod.exports,
      localRequire,
      mod,
      resolved,
      path.dirname(resolved)
    )
    modules.set(resolved, mod.exports)
    return mod.exports
  }

  return { load, context, mocks }
}
