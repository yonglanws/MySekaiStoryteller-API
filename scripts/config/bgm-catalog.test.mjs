import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Logger } from 'tslog'

// 宿主 catalog 读取 audio/bgm/bgm.yaml 的清单侧（不核对 enabled/path/volume 的 schema）。
// 已有 config 测试（bgm.test.mjs）覆盖那几个字段；这里专注 catalog 暴露的 bgmDetails。
const { ResourceCatalog } = await import('../../out-host/host/resources/resourceCatalog.js').catch(
  () => {
    throw new Error('先用 npm run build:host 编译，再跑此测试')
  }
)

function createResources(t, bgmYaml, files = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'mss-bgm-catalog-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'audio', 'bgm')
  mkdirSync(dir, { recursive: true })
  for (const name of files) writeFileSync(path.join(dir, name), 'x')
  // catalog build 会先读 models.yaml；这里只造一个不存在的路径占位
  const modelsDir = path.join(root, 'models')
  mkdirSync(modelsDir, { recursive: true })
  writeFileSync(path.join(modelsDir, 'models.yaml'), 'models: []\n', 'utf8')
  if (bgmYaml !== undefined) writeFileSync(path.join(dir, 'bgm.yaml'), bgmYaml, 'utf8')
  return root
}

function newCatalog(root) {
  const logger = new Logger({ type: 'hidden' })
  const config = { paths: { resources: root } }
  return new ResourceCatalog(logger, config)
}

const manifest = `enabled: true
path: audio/bgm/bg1.mp3
volume: 0.2

bgm:
  - file: bg1.mp3
    name: 默认轻音乐
    description: 轻缓的居家背景音乐
  - file: bg2.ogg
    name: 感伤钢琴曲
  - file: missing.mp3
    name: 磁盘不存在
`

test('bgm list keeps only entries whose file exists on disk', async (t) => {
  const root = createResources(t, manifest, ['bg1.mp3', 'bg2.ogg'])
  const data = newCatalog(root).build()
  assert.deepEqual(data.bgmDetails, [
    { file: 'bg1.mp3', name: '默认轻音乐', description: '轻缓的居家背景音乐' },
    { file: 'bg2.ogg', name: '感伤钢琴曲', description: '' }
  ])
})

test('bgm.yaml without a manifest list leaves bgmDetails empty', async (t) => {
  const root = createResources(t, 'enabled: true\npath: audio/bgm/bg1.mp3\nvolume: 0.2\n', [
    'bg1.mp3'
  ])
  const data = newCatalog(root).build()
  assert.deepEqual(data.bgmDetails, [])
})

test('missing bgm.yaml falls back with empty bgmDetails', async (t) => {
  const root = createResources(t, undefined, ['bg1.mp3'])
  const data = newCatalog(root).build()
  assert.deepEqual(data.bgmDetails, [])
})
