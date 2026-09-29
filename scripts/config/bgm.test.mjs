import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readBgmManifest } from '../../out-host/host/config.js'

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
  const root = createResources(
    t,
    'enabled: false\npath: audio/bgm/song2.mp3\nvolume: 0.45\n'
  )
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
    volume: 0.2
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
    volume: 0.2
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
