import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const {
  loadSoundtrackIndex,
  parseSoundtrackIndex,
  readSoundtrackIndex,
  soundtrackKey,
  soundtrackLabel,
  writeSoundtrackIndex
} = await import('../../out-host/host/assets/soundtracks.js').catch(() => {
  throw new Error('先用 npm run build:host 编译，再跑此测试')
})

const categories = [
  { id: 13, name: 'シナリオ' },
  { id: 6, name: 'ワンダショ' },
  { id: 1, name: 'ユニット総合' }
]

const tracks = [
  {
    title: 'Slapstick!!',
    musicSoundTrackCategoryId: 13,
    assetbundleFileName: 'bgm00003'
  },
  {
    title: '微笑みの陽だまり',
    musicSoundTrackCategoryId: 13,
    assetbundleFileName: 'bgm00006'
  },
  {
    title: 'With Gratitude',
    musicSoundTrackCategoryId: 1,
    assetbundleFileName: 'bgm_area00001'
  },
  {
    title: 'Crystal Blessing',
    musicSoundTrackCategoryId: 1,
    assetbundleFileName: 'bgm_area00001'
  },
  {
    title: '不明分类',
    musicSoundTrackCategoryId: 99,
    assetbundleFileName: 'bgm09999'
  },
  { title: '', musicSoundTrackCategoryId: 13, assetbundleFileName: 'bgm_empty' },
  { title: '无文件', musicSoundTrackCategoryId: 13 }
]

test('soundtrackKey strips directories and extensions', () => {
  assert.equal(soundtrackKey('bgm00003'), 'bgm00003')
  assert.equal(soundtrackKey('bgm00003.mp3'), 'bgm00003')
  assert.equal(soundtrackKey('audio/bgm/bgm00003.mp3'), 'bgm00003')
  assert.equal(soundtrackKey('..\\..\\bgm00003.MP3'), 'bgm00003')
})

test('parse maps ids to official titles and Chinese categories', () => {
  const index = parseSoundtrackIndex(tracks, categories, 'test', '2026-01-01T00:00:00.000Z')
  assert.equal(index.tracks.size, 4)

  const slapstick = index.tracks.get('bgm00003')
  assert.deepEqual(slapstick, {
    file: 'bgm00003',
    titles: ['Slapstick!!'],
    categories: ['剧情']
  })

  const unknown = index.tracks.get('bgm09999')
  assert.deepEqual(unknown.categories, [])

  const area = index.tracks.get('bgm_area00001')
  assert.deepEqual(area.titles, ['With Gratitude', 'Crystal Blessing'])
})

test('label uses the title as name and category as description', () => {
  const index = parseSoundtrackIndex(tracks, categories)
  assert.deepEqual(soundtrackLabel(index.tracks.get('bgm00003')), {
    name: 'Slapstick!!',
    description: '剧情 BGM'
  })
  assert.deepEqual(soundtrackLabel(index.tracks.get('bgm09999')), {
    name: '不明分类',
    description: '游戏 BGM'
  })

  const area = soundtrackLabel(index.tracks.get('bgm_area00001'))
  assert.equal(area.name, 'With Gratitude / Crystal Blessing')
  assert.equal(area.description, '组合综合 BGM')
})

test('label folds more than three titles into a short name', () => {
  const info = {
    file: 'bgm_area00001',
    titles: ['A', 'B', 'C', 'D', 'E'],
    categories: ['组合综合']
  }
  assert.equal(soundtrackLabel(info).name, 'A / B / C 等 5 首')
})

test('cache round-trips only the text the prompt needs', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'mss-soundtracks-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cacheFile = path.join(root, 'soundtracks.json')

  const fetchedAt = new Date().toISOString()
  const index = parseSoundtrackIndex(tracks, categories, 'test', fetchedAt)
  writeSoundtrackIndex(cacheFile, index)

  const text = readFileSync(cacheFile, 'utf-8')
  assert.ok(text.includes('Slapstick!!'))
  assert.ok(!text.includes('pronunciation'))

  const cached = readSoundtrackIndex(cacheFile)
  assert.equal(cached.source, 'test')
  assert.equal(cached.fetchedAt, fetchedAt)
  assert.deepEqual(cached.tracks.get('bgm00003'), index.tracks.get('bgm00003'))
  assert.deepEqual(cached.tracks.get('bgm_area00001'), index.tracks.get('bgm_area00001'))

  // 未过期时 load 直接读缓存，不访问网络。
  const loaded = await loadSoundtrackIndex({ cacheFile, baseUrl: 'http://127.0.0.1:1/' })
  assert.equal(loaded.tracks.size, 4)
})

test('a broken cache is ignored instead of breaking the catalog', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'mss-soundtracks-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cacheFile = path.join(root, 'soundtracks.json')
  writeFileSync(cacheFile, '{not json', 'utf8')
  assert.equal(readSoundtrackIndex(cacheFile), null)
})
