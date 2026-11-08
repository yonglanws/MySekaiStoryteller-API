import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fetchModels, selectModels } from '../../out-host/host/assets/moesekai.js'

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function makeModel3Json(name) {
  return JSON.stringify({
    Version: 3,
    FileReferences: {
      Moc: `${name}.moc3`,
      Textures: [`${name}.2048/texture_00.png`],
      Physics: `${name}.physics3.json`
    },
    Groups: [
      { Target: 'Parameter', Name: 'EyeBlink', Ids: [] },
      { Target: 'Parameter', Name: 'LipSync', Ids: [] }
    ]
  })
}

function makeMotionSse(name, value) {
  return JSON.stringify({
    format: 'sse-motion',
    version: 1,
    name,
    sampleRate: 60,
    startTime: 0,
    stopTime: 1,
    loopTime: false,
    fade: { in: 0.3, out: 0.4 },
    curves: [
      {
        binding: { resolved: { target: 'Parameter', id: 'ParamAngleX' } },
        kind: 'constant',
        value
      }
    ]
  })
}

function makeFixture(root) {
  const modelBundle = 'live2d/model/01test_normal'
  const motionBundle = 'live2d/motion/01test_motion_base'
  const modelName = '01test_normal_3.0_t04'
  const library = path.join(root, 'sekai-story', 'ripper', 'jp')
  const modelDir = path.join(library, 'library', modelBundle)
  const motionDir = path.join(library, 'library', motionBundle)

  write(
    path.join(root, 'sekai-live2d', 'jp', 'models.json'),
    JSON.stringify({
      format: 1,
      region: 'jp',
      models: [
        {
          id: '01test_normal',
          bundle: modelBundle,
          motion: motionBundle,
          motions: [motionBundle],
          kind: 'character',
          characterId: 1,
          bytes: 100
        },
        {
          id: 'v2_01test_casual',
          bundle: 'live2d/model/v2_01test_casual',
          motion: motionBundle,
          motions: [motionBundle],
          kind: 'character',
          characterId: 1,
          bytes: 100
        }
      ]
    })
  )

  write(
    path.join(modelDir, '_ripper.json'),
    JSON.stringify({
      format: 'ripper-unpack',
      version: 3,
      bundle: modelBundle,
      files: [
        { path: `${modelName}.model3.json` },
        { path: `${modelName}.moc3` },
        { path: `${modelName}.physics3.json` },
        { path: `${modelName}.2048/texture_00.png` }
      ]
    })
  )
  write(path.join(modelDir, `${modelName}.model3.json`), makeModel3Json(modelName))
  write(path.join(modelDir, `${modelName}.moc3`), 'moc3')
  write(path.join(modelDir, `${modelName}.physics3.json`), '{}')
  write(path.join(modelDir, `${modelName}.2048`, 'texture_00.png'), 'png')

  write(
    path.join(motionDir, '_ripper.json'),
    JSON.stringify({
      format: 'ripper-unpack',
      version: 3,
      bundle: motionBundle,
      files: [
        { path: 'buildmotiondata.json' },
        { path: 'facial/face_smile_01.sse-motion.json' },
        { path: 'motion/w-normal-nod01.sse-motion.json' }
      ]
    })
  )
  write(path.join(motionDir, 'buildmotiondata.json'), '{}')
  write(
    path.join(motionDir, 'facial', 'face_smile_01.sse-motion.json'),
    makeMotionSse('face_smile_01', 0.8)
  )
  write(
    path.join(motionDir, 'motion', 'w-normal-nod01.sse-motion.json'),
    makeMotionSse('w-normal-nod01', 0)
  )
}

async function startServer(root) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const file = path.resolve(root, relative)
    if (!file.startsWith(path.resolve(root))) {
      res.statusCode = 403
      res.end('forbidden')
      return
    }
    fs.readFile(file, (error, data) => {
      if (error) {
        res.statusCode = 404
        res.end('not found')
        return
      }
      res.end(data)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.close()
      await once(server, 'close')
    }
  }
}

test('downloads a model, converts sse motions and registers it in models.yaml', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'mss-fetch-test-'))
  const outDir = mkdtempSync(path.join(tmpdir(), 'mss-fetch-out-'))
  const cacheDir = mkdtempSync(path.join(tmpdir(), 'mss-fetch-cache-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
    rmSync(cacheDir, { recursive: true, force: true })
  })

  makeFixture(root)
  const server = await startServer(root)
  t.after(() => server.close())

  // 预置一份带注释的 models.yaml，验证追加不会重写已有内容
  write(
    path.join(outDir, 'models', 'models.yaml'),
    '# 我的手写注释\nmodels:\n  - id: 7\n    name: "已有角色"\n    path: "existing/model.model3.json"\n'
  )

  const settings = {
    source: 'moesekai',
    region: 'jp',
    indexBase: `${server.base}/sekai-live2d/`,
    libraryBase: `${server.base}/sekai-story/ripper/`,
    assetBase: '',
    cacheDir,
    concurrency: 2,
    timeoutMs: 5000,
    retries: 1
  }

  const result = await fetchModels(settings, {
    outDir,
    models: ['01test_normal']
  })

  assert.equal(result.errors.length, 0)
  assert.equal(result.models.length, 1)
  const model = result.models[0]
  assert.equal(model.id, '01test_normal')
  assert.equal(model.name, '星乃一歌')
  assert.equal(model.shortName, '一歌')
  assert.equal(model.motions, 1)
  assert.equal(model.facials, 1)
  assert.equal(model.path, '01test_normal/01test_normal_3.0_t04/01test_normal_3.0_t04.model3.json')

  const modelDir = path.join(outDir, 'models', '01test_normal', '01test_normal_3.0_t04')
  const motion3 = JSON.parse(
    fs.readFileSync(path.join(modelDir, 'motions', 'w-normal-nod01.motion3.json'), 'utf-8')
  )
  assert.deepEqual(motion3.Curves[0], {
    Target: 'Parameter',
    Id: 'ParamAngleX',
    Segments: [0, 0, 2, 1, 0]
  })
  const facial3 = JSON.parse(
    fs.readFileSync(path.join(modelDir, 'motions', 'face_smile_01.motion3.json'), 'utf-8')
  )
  assert.deepEqual(facial3.Curves[0].Segments, [0, 0.8, 2, 1, 0.8])

  const model3 = JSON.parse(
    fs.readFileSync(path.join(modelDir, '01test_normal_3.0_t04.model3.json'), 'utf-8')
  )
  assert.deepEqual(Object.keys(model3.FileReferences.Motions).sort(), [
    'face_smile_01',
    'w-normal-nod01'
  ])
  assert.equal(
    model3.FileReferences.Motions['w-normal-nod01'][0].File,
    'motions/w-normal-nod01.motion3.json'
  )
  assert.equal(model3.FileReferences.Motions['w-normal-nod01'][0].FadeInTime, 0.3)

  const manifest = fs.readFileSync(path.join(outDir, 'models', 'models.yaml'), 'utf-8')
  assert.match(manifest, /# 我的手写注释/)
  assert.match(manifest, /id: 7/)
  assert.match(manifest, /id: 8/)
  assert.match(manifest, /星乃一歌/)
  assert.match(
    manifest,
    /01test_normal\/01test_normal_3\.0_t04\/01test_normal_3\.0_t04\.model3\.json/
  )
})

test('prefers the v1 normal costume for a character', () => {
  const index = {
    format: 1,
    models: [
      {
        id: 'v2_01test_casual',
        bundle: 'live2d/model/v2_01test_casual',
        motion: null,
        kind: 'character',
        characterId: 1
      },
      {
        id: '01test_school',
        bundle: 'live2d/model/01test_school',
        motion: null,
        kind: 'character',
        characterId: 1
      },
      {
        id: '01test_normal',
        bundle: 'live2d/model/01test_normal',
        motion: null,
        kind: 'character',
        characterId: 1
      }
    ]
  }
  const selected = selectModels(index, { characters: ['ichika'] })
  assert.equal(selected.length, 1)
  assert.equal(selected[0].id, '01test_normal')
})

test('dry run selects without writing anything', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'mss-fetch-test-'))
  const outDir = mkdtempSync(path.join(tmpdir(), 'mss-fetch-out-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  })
  makeFixture(root)
  const server = await startServer(root)
  t.after(() => server.close())

  const result = await fetchModels(
    {
      source: 'moesekai',
      region: 'jp',
      indexBase: `${server.base}/sekai-live2d/`,
      libraryBase: `${server.base}/sekai-story/ripper/`,
      assetBase: '',
      cacheDir: path.join(root, 'cache'),
      concurrency: 2,
      timeoutMs: 5000,
      retries: 1
    },
    { outDir, characters: ['ichika'], dryRun: true }
  )
  assert.deepEqual(result.selected, [{ id: '01test_normal', name: '星乃一歌' }])
  assert.equal(result.models.length, 0)
  assert.equal(fs.existsSync(path.join(outDir, 'models')), false)
})
