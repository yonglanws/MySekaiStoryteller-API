import assert from 'node:assert/strict'
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadHostConfig, readBgmManifest } from '../../out-host/host/config.js'

/** 造一个临时资源根，可选写入 audio/bgm/bgm.yaml */
function createResources(t, contents) {
  const root = mkdtempSync(path.join(tmpdir(), 'mss-bgm-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  if (contents !== undefined) {
    const dir = path.join(root, 'audio', 'bgm')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'bgm.yaml'), contents, 'utf8')
  }
  return root
}

test('bgm.yaml provides enabled / path / volume', (t) => {
  const root = createResources(t, 'enabled: false\npath: audio/bgm/song2.mp3\nvolume: 0.45\n')
  assert.deepEqual(readBgmManifest(root), {
    enabled: false,
    path: 'audio/bgm/song2.mp3',
    volume: 0.45
  })
})

test('missing bgm.yaml falls back to config.yaml (null)', (t) => {
  assert.equal(readBgmManifest(createResources(t, undefined)), null)
})

test('omitted fields keep the documented defaults', (t) => {
  assert.deepEqual(readBgmManifest(createResources(t, 'path: audio/bgm/bg9.mp3\n')), {
    enabled: true,
    path: 'audio/bgm/bg9.mp3',
    volume: 0.35
  })
})

test('absolute paths and URLs pass through unchanged', (t) => {
  const url = createResources(t, 'path: http://example.com/bgm.mp3\n')
  assert.equal(readBgmManifest(url).path, 'http://example.com/bgm.mp3')

  const absolute = createResources(t, 'path: /srv/audio/bgm.mp3\n')
  assert.equal(readBgmManifest(absolute).path, '/srv/audio/bgm.mp3')
})

test('volume is clamped to 0 - 1', (t) => {
  assert.equal(readBgmManifest(createResources(t, 'volume: 3\n')).volume, 1)
  assert.equal(readBgmManifest(createResources(t, 'volume: -2\n')).volume, 0)
})

test('an empty file keeps every default', (t) => {
  assert.deepEqual(readBgmManifest(createResources(t, '')), {
    enabled: true,
    path: 'audio/bgm/bg1.mp3',
    volume: 0.35
  })
})

test('malformed bgm.yaml fails loudly instead of silently using wrong values', (t) => {
  assert.throws(
    () => readBgmManifest(createResources(t, 'volume: [1, 2]\n')),
    /bgm\.yaml|volume|Invalid|Expected/i
  )
  assert.throws(
    () => readBgmManifest(createResources(t, '- just\n- a\n- list\n')),
    /key-value mapping/i
  )
})

function withMockedHostConfig(t, configYamlContent) {
  const repoConfigPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'config.yaml'
  )
  const origExistsSync = fs.existsSync
  const origReadFileSync = fs.readFileSync
  t.mock.method(fs, 'existsSync', (target) => {
    if (path.resolve(String(target)) === repoConfigPath) return configYamlContent !== null
    return origExistsSync.call(fs, target)
  })
  t.mock.method(fs, 'readFileSync', (target, ...rest) => {
    if (path.resolve(String(target)) === repoConfigPath && configYamlContent !== null) {
      return configYamlContent
    }
    return origReadFileSync.call(fs, target, ...rest)
  })

  const keys = [
    'MSS_RESOURCE_DIR',
    'MSS_ASSETS_CLOUD_ONLY',
    'MSS_ASSETS_CLOUD_CATALOG',
    'MSS_BGM_ENABLED',
    'MSS_BGM_PATH',
    'MSS_BGM_VOLUME'
  ]
  const prev = new Map(keys.map((k) => [k, process.env[k]]))
  t.after(() => {
    for (const k of keys) {
      const val = prev.get(k)
      if (val === undefined) delete process.env[k]
      else process.env[k] = val
    }
  })
}

test('loadHostConfig defaults bgm.volume to 0.35 in both default and cloudOnly modes', (t) => {
  withMockedHostConfig(t, null)
  const root = createResources(t, undefined)
  process.env.MSS_RESOURCE_DIR = root

  process.env.MSS_ASSETS_CLOUD_ONLY = 'false'
  const defaultCfg = loadHostConfig()
  assert.equal(defaultCfg.bgm.enabled, true)
  assert.equal(defaultCfg.bgm.volume, 0.35)
  assert.equal(defaultCfg.bgm.path, 'bgm00003')

  process.env.MSS_ASSETS_CLOUD_ONLY = 'true'
  const cloudCfg = loadHostConfig()
  assert.equal(cloudCfg.bgm.enabled, true)
  assert.equal(cloudCfg.bgm.volume, 0.35)
  assert.equal(cloudCfg.bgm.path, 'bgm00003')
})

test('loadHostConfig cloudOnly ignores bgm.yaml and reads config.yaml bgm section', (t) => {
  withMockedHostConfig(
    t,
    'assets:\n  cloudOnly: true\nbgm:\n  enabled: true\n  path: bgm00016\n  volume: 0.42\n'
  )
  const root = createResources(t, 'enabled: false\npath: audio/bgm/bg1.mp3\nvolume: 0.15\n')
  process.env.MSS_RESOURCE_DIR = root

  const cfg = loadHostConfig()
  assert.equal(cfg.assets.cloudOnly, true)
  assert.equal(cfg.bgm.enabled, true)
  assert.equal(cfg.bgm.path, 'bgm00016')
  assert.equal(cfg.bgm.volume, 0.42)
})

test('MSS_BGM_* env overrides config.yaml and bgm.yaml with volume clamping', (t) => {
  withMockedHostConfig(t, 'assets:\n  cloudOnly: false\n')
  const root = createResources(t, 'enabled: true\npath: audio/bgm/bg1.mp3\nvolume: 0.25\n')
  process.env.MSS_RESOURCE_DIR = root
  process.env.MSS_BGM_ENABLED = 'false'
  process.env.MSS_BGM_PATH = 'bgm00018'
  process.env.MSS_BGM_VOLUME = '1.5'

  const cfg = loadHostConfig()
  assert.equal(cfg.bgm.enabled, false)
  assert.equal(cfg.bgm.path, 'bgm00018')
  assert.equal(cfg.bgm.volume, 1)

  process.env.MSS_BGM_ENABLED = 'true'
  process.env.MSS_BGM_VOLUME = '0.38'
  const cfg2 = loadHostConfig()
  assert.equal(cfg2.bgm.enabled, true)
  assert.equal(cfg2.bgm.volume, 0.38)
})
