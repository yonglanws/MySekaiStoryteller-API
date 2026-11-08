/**
 * PLAN SNAPSHOT — 与 doc/moesekai-parity-plan.md 同步维护。
 *
 * 问题 3 的最后一道闸：即使宿主预检漏了，renderer 的 IrodoriTTS 也不能把中文
 * 送去合成。TTSService.synthesizeSpeech 在发请求前检查日文，非日文直接失败。
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
const common = path.join(root, 'src/common')

function loadService(t) {
  let fetchCalls = 0
  let builderCalls = 0
  const context = vm.createContext({
    console,
    fetch: async () => {
      fetchCalls++
      throw new Error('fetch must not be called for non-Japanese Irodori text')
    },
    AbortController,
    TextDecoder,
    URL,
    performance: { now: () => 0 },
    Date,
    setTimeout,
    clearTimeout
  })
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
      path.join(common, 'tts/irodori.ts'),
      {
        buildIrodoriSpeechRequest: () => {
          builderCalls++
          throw new Error('Irodori request builder reached')
        },
        resolveIrodoriVoice: () => ({ refAudioPath: 'ref.wav' })
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
  const { TTSService } = load('services/TTSService.ts')
  t.after(() => {})
  return {
    service: new TTSService({
      enabled: true,
      provider: 'irodori',
      apiBaseUrl: 'http://127.0.0.1:1',
      defaultRefAudioPath: 'ref.wav',
      irodori: { defaultLoraAdapter: '', defaultCaption: '' }
    }),
    fetchCalls: () => fetchCalls,
    builderCalls: () => builderCalls
  }
}

test('IrodoriTTS refuses Chinese before any network request', async (t) => {
  const { service, fetchCalls } = loadService(t)
  const result = await service.synthesizeSpeech('你好，今天也一起练习吧', '瑞希')
  assert.equal(result.success, false)
  assert.match(result.error, /Japanese/)
  assert.equal(fetchCalls(), 0)
})

test('IrodoriTTS accepts Japanese and reaches the request builder', async (t) => {
  const { service, builderCalls } = loadService(t)
  await assert.rejects(
    service.synthesizeSpeech('こんにちは、今日も練習しよう', '瑞希'),
    /Irodori request builder reached/
  )
  assert.equal(builderCalls(), 1, '日文必须走到 Irodori 请求构造器')
})
