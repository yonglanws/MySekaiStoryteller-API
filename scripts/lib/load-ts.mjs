import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Lightweight TypeScript module loader for unit tests that import
 * browser/renderer TS modules inside a node:vm sandbox without a bundler.
 */
export function createLoader(context = vm.createContext({ console, Math, Number, Date })) {
  const modules = new Map()
  const compiled = new Map()

  function resolveFile(target) {
    const candidates = target.endsWith('.ts')
      ? [target]
      : [target, `${target}.ts`, path.join(target, 'index.ts')]
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate
      }
    }
    throw new Error(`Cannot resolve TypeScript module: ${target}`)
  }

  function load(target) {
    const filename = resolveFile(target)
    if (modules.has(filename)) return modules.get(filename)

    if (!compiled.has(filename)) {
      const source = fs.readFileSync(filename, 'utf8')
      const { outputText } = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true
        },
        fileName: filename
      })
      compiled.set(
        filename,
        new vm.Script(
          `(function (exports, require, module, __filename, __dirname) {\n${outputText}\n})`,
          {
            filename
          }
        )
      )
    }

    const mod = { exports: {} }
    modules.set(filename, mod.exports)

    const localRequire = (specifier) => {
      if (specifier.startsWith('.')) {
        return load(path.resolve(path.dirname(filename), specifier))
      }
      throw new Error(`Unexpected external import "${specifier}" in ${filename}`)
    }

    compiled.get(filename).runInContext(context)(
      mod.exports,
      localRequire,
      mod,
      filename,
      path.dirname(filename)
    )
    modules.set(filename, mod.exports)
    return mod.exports
  }

  return load
}
