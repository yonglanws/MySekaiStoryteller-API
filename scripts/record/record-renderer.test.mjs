import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

function fixture() {
  const calls = []
  const ticker = { maxFPS: 120 }
  const animation = {
    setExportMode() {
      return undefined
    }
  }
  class Logger {
    info() {
      return undefined
    }
    warn() {
      return undefined
    }
    error() {
      return undefined
    }
  }
  class Empty {}
  const source = fs.readFileSync(
    path.resolve('src/renderer/src/managers/VideoExportManager.ts'),
    'utf8'
  )
  const exports = {}
  const dependencies = {
    './AnimationManager': { default: animation },
    'pixi.js': { Ticker: { shared: ticker } },
    './video-export': {
      ExportLogger: Logger,
      CheckpointManager: Empty,
      ErrorRecoveryManager: Empty,
      ProgressTracker: Empty
    },
    '../utils/WebGLContextValidator': {
      webGLValidator: {
        validateCanvas: async () => ({ success: true }),
        validateModelRendering: async () => ({ success: true })
      }
    }
  }
  const context = {
    exports,
    require: (name) => dependencies[name] ?? {},
    console,
    performance,
    setTimeout: (callback) => {
      callback()
      return 0
    },
    window: {
      electron: {
        ipcRenderer: {
          invoke: async (channel, data) => {
            calls.push({ channel, data })
            return { success: true, fileSize: 123 }
          }
        }
      }
    }
  }
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    context
  )
  const app = {
    pixiApplication: { view: { width: 1920, height: 1080 }, ticker: { maxFPS: 0 } },
    storyManager: { snippets: [] }
  }
  const manager = new exports.default(app)
  return { manager, app, calls, ticker, animation }
}

test('record caps both Pixi tickers instead of rendering unused frames', async () => {
  const f = fixture()
  await f.manager.prepareStreamRecording(
    { fps: 30, apiMode: true, exportMode: 'stream' },
    null,
    null,
    () => {}
  )
  assert.equal(f.ticker.maxFPS, 30)
  assert.equal(f.app.pixiApplication.ticker.maxFPS, 30)
  assert.equal(f.animation.exportTargetFPS, 30)
})

test('record-only ticker changes do not change fast preparation', async () => {
  const f = fixture()
  await f.manager.prepareStreamRecording(
    { fps: 60, fastFps: 24, apiMode: true, exportMode: 'fast' },
    null,
    null,
    () => {}
  )
  assert.equal(f.ticker.maxFPS, 24)
  assert.equal(f.app.pixiApplication.ticker.maxFPS, 0)
})

test('record finalization copies already encoded video and returns real frame metadata', async () => {
  const f = fixture()
  const result = await f.manager.saveApiVideoFromDisk(
    { apiOutputPath: '/test.mp4', apiAudioBitrate: '128k' },
    Promise.resolve({ videoPath: '/encoded.mp4', frameCount: 41, durationMs: 2000 }),
    false,
    null,
    false,
    {},
    2000,
    null,
    () => {},
    new Map(),
    {},
    { audioPath: null, invoked: false },
    'record-session'
  )
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].channel, 'electron:record-mux')
  assert.equal(f.calls[0].data.id, 'record-session')
  assert.equal('videoPath' in f.calls[0].data, false)
  assert.equal('sizeCap' in f.calls[0].data, false)
  assert.equal(result.frameCount, 41)
  assert.equal(result.durationMs, 2000)
  assert.equal(result.fileSize, 123)
})

test('failed background encoder cannot be silently muxed as success', async () => {
  const f = fixture()
  await assert.rejects(
    f.manager.saveApiVideoFromDisk(
      { apiOutputPath: '/test.mp4' },
      Promise.reject(new Error('encoder failure')),
      false,
      null,
      false,
      {},
      2000,
      null,
      () => {},
      new Map(),
      {},
      { audioPath: null, invoked: false }
    ),
    /encoder failure/
  )
  assert.equal(f.calls.length, 0)
})
