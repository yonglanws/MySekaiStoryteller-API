import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const legacy = {
  recordBitrate: 8000000,
  recordStreamCopy: 'on',
  recordTargetSizeMb: 30,
  recordBitrateOvershoot: 1.4,
  recordKeyframeIntervalSec: 10,
  recordCaptureFps: 15
}
function load(video = {}, env = {}) {
  const exports = {}
  const source = fs.readFileSync(path.resolve('src/host/config.ts'), 'utf8')
  const fakeFs = {
    existsSync: (p) => p.endsWith('package.json') || p.endsWith('config.yaml'),
    readFileSync: () => JSON.stringify({ video })
  }
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true
      }
    }).outputText,
    {
      exports,
      __dirname: path.resolve('out-host/host'),
      require: (name) => (name === 'node:fs' ? fakeFs : require(name)),
      process: { env, cwd: () => process.cwd() },
      console
    }
  )
  return exports.loadHostConfig().video
}

test('record uses common output settings and removes six obsolete knobs', () => {
  const video = load({ fps: 60, crf: 23, encoder: 'libx264', ...legacy })
  for (const key of Object.keys(legacy)) assert.equal(key in video, false, key)
  assert.equal(video.fps, 60)
  assert.equal(video.crf, 23)
  assert.equal(video.encoder, 'libx264')
})

test('obsolete environment variables cannot silently restore removed behavior', () => {
  const video = load(
    {},
    {
      MSS_RECORD_BITRATE: '100000',
      MSS_RECORD_STREAM_COPY: 'on',
      MSS_RECORD_TARGET_SIZE_MB: '1',
      MSS_RECORD_BITRATE_OVERSHOOT: '2',
      MSS_RECORD_KEYFRAME_INTERVAL_SEC: '10',
      MSS_RECORD_CAPTURE_FPS: '1'
    }
  )
  for (const key of Object.keys(legacy)) assert.equal(key in video, false, key)
})

test('fast configuration remains unchanged', () => {
  const video = load({
    exportMode: 'fast',
    fastFps: 24,
    exportBitrate: 6000000,
    exportFastEncoder: 'frames'
  })
  assert.equal(video.exportMode, 'fast')
  assert.equal(video.fastFps, 24)
  assert.equal(video.exportBitrate, 6000000)
  assert.equal(video.exportFastEncoder, 'frames')
})
