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

test('TTSService.calculateAudioDuration parses RIFF/WAVE subchunks when LIST/JUNK precedes data', async (t) => {
  const { service } = loadService(t)
  // Build RIFF/WAVE: 12-byte RIFF + 24-byte fmt (16kHz, 1ch, 16-bit) + 16-byte JUNK + 8-byte data header + 3200 bytes PCM (100ms)
  const dataBytes = 3200
  const buf = new ArrayBuffer(12 + 24 + 16 + 8 + dataBytes)
  const view = new DataView(buf)
  const writeTag = (off, str) => {
    for (let i = 0; i < 4; i++) view.setUint8(off + i, str.charCodeAt(i))
  }
  writeTag(0, 'RIFF')
  view.setUint32(4, buf.byteLength - 8, true)
  writeTag(8, 'WAVE')
  writeTag(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeTag(36, 'JUNK')
  view.setUint32(40, 8, true) // Offset 40 is JUNK's chunk size (8), NOT dataSize!
  writeTag(52, 'data')
  view.setUint32(56, dataBytes, true)

  const durationMs = await service.calculateAudioDuration(buf)
  assert.equal(durationMs, 100)
})
