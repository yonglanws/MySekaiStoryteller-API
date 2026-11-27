import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadHostConfig, validateConfigHints } from '../../out-host/host/config.js'
import { loadDotEnv, parseDotEnv } from '../../out-host/host/env.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INIT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'init-config.mjs')

const MANAGED_ENV_KEYS = [
  'MSS_CONFIG_PATH',
  'MSS_RESOURCE_DIR',
  'MSS_VIDEO_ENCODER',
  'MSS_FFMPEG_ENCODER',
  'MSS_GPU_PROFILE',
  'MSS_GPU_MODE',
  'MSS_MEMORY_PROFILE',
  'MSS_CHROME_ARGS',
  'MSS_LINUX_GPU_ANGLE',
  'MSS_WORKERS',
  'MSS_MAX_CONCURRENT_EXPORTS',
  'MSS_WORKER_RECYCLE_EXPORTS',
  'MSS_VIDEO_FPS',
  'MSS_FAST_FPS',
  'MSS_VIDEO_RENDER_SCALE',
  'MSS_LLM_PERSONA_DIRS',
  'MSS_LLM_POLISH_DIALOGUE',
  'MSS_LLM_API_KEY',
  'MSS_SERVER_CORS',
  'MSS_API_KEY',
  'MSST_API_KEY',
  'MSS_HOST',
  'MSS_TTS_ENABLED',
  'MSS_TTS_PROVIDER',
  'MSS_ASSETS_CLOUD_ONLY',
  'MSS_ASSETS_CLOUD_CATALOG',
  'MSS_BGM_ENABLED',
  'MSS_BGM_PATH',
  'MSS_BGM_VOLUME'
]

function withIsolatedConfig(t, yamlContent = null) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mss-easy-config-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const prev = new Map(MANAGED_ENV_KEYS.map((k) => [k, process.env[k]]))
  t.after(() => {
    for (const k of MANAGED_ENV_KEYS) {
      const val = prev.get(k)
      if (val === undefined) delete process.env[k]
      else process.env[k] = val
    }
  })

  for (const k of MANAGED_ENV_KEYS) {
    delete process.env[k]
  }

  const configPath = path.join(dir, 'config.yaml')
  if (yamlContent !== null) {
    writeFileSync(configPath, yamlContent, 'utf8')
  }
  process.env.MSS_CONFIG_PATH = configPath
  process.env.MSS_RESOURCE_DIR = path.join(dir, 'resources')
  return { dir, configPath }
}

test('MSS_CONFIG_PATH supports both absolute and repo-relative paths', (t) => {
  const { configPath } = withIsolatedConfig(
    t,
    'server:\n  port: 9991\nvideo:\n  fps: 45\n  fastFps: 45\n'
  )

  const absCfg = loadHostConfig()
  assert.equal(absCfg.server.port, 9991)
  assert.equal(absCfg.video.fps, 45)

  // Repo-relative path to config.example.yaml
  process.env.MSS_CONFIG_PATH = 'config.example.yaml'
  const relCfg = loadHostConfig()
  assert.equal(relCfg.server.port, 9881)
  assert.equal(relCfg.video.crf, 27)
  assert.equal(relCfg.assets.cloudOnly, true)

  // Missing custom path falls back cleanly without crashing
  process.env.MSS_CONFIG_PATH = path.join(path.dirname(configPath), 'does-not-exist.yaml')
  const fallbackCfg = loadHostConfig()
  assert.equal(fallbackCfg.server.port, 9881)
})

test('MSS_VIDEO_ENCODER acts as alias and MSS_FFMPEG_ENCODER takes precedence when both set', (t) => {
  withIsolatedConfig(t, 'video:\n  encoder: auto\n')

  process.env.MSS_VIDEO_ENCODER = 'intel'
  assert.equal(loadHostConfig().video.encoder, 'intel')

  process.env.MSS_FFMPEG_ENCODER = 'nvidia'
  assert.equal(loadHostConfig().video.encoder, 'nvidia')
})

test('MSS_LLM_PERSONA_DIRS, MSS_LLM_POLISH_DIALOGUE, and MSS_SERVER_CORS env overrides', (t) => {
  withIsolatedConfig(t, 'llm:\n  polishDialogue: true\n  personaDirs: []\n')

  process.env.MSS_LLM_PERSONA_DIRS = 'personas, custom/roles , '
  process.env.MSS_LLM_POLISH_DIALOGUE = 'false'
  process.env.MSS_SERVER_CORS = 'true'

  const cfg = loadHostConfig()
  assert.deepEqual(cfg.llm.personaDirs, [
    path.resolve(cfg.rootDir, 'personas'),
    path.resolve(cfg.rootDir, 'custom/roles')
  ])
  assert.equal(cfg.llm.polishDialogue, false)
  assert.equal(cfg.server.cors, true)

  process.env.MSS_LLM_POLISH_DIALOGUE = '1'
  process.env.MSS_SERVER_CORS = 'off'
  const cfg2 = loadHostConfig()
  assert.equal(cfg2.llm.polishDialogue, true)
  assert.equal(cfg2.server.cors, false)

  // Blank string does not accidentally toggle boolean CORS on
  process.env.MSS_SERVER_CORS = '   '
  const cfg3 = loadHostConfig()
  assert.equal(cfg3.server.cors, undefined)

  // Explicit env opt-out via "none" clears personaDirs
  process.env.MSS_LLM_PERSONA_DIRS = 'none'
  const cfg4 = loadHostConfig()
  assert.deepEqual(cfg4.llm.personaDirs, [])
})

test('llm.personaDirs defaults to built-in personas/pjsk when omitted and supports explicit opt-out', (t) => {
  withIsolatedConfig(t, null)

  const defaultCfg = loadHostConfig()
  assert.deepEqual(defaultCfg.llm.personaDirs, [path.resolve(defaultCfg.rootDir, 'personas/pjsk')])

  // Empty env var string does not clobber built-in default
  process.env.MSS_LLM_PERSONA_DIRS = '   '
  const blankEnvCfg = loadHostConfig()
  assert.deepEqual(blankEnvCfg.llm.personaDirs, [
    path.resolve(blankEnvCfg.rootDir, 'personas/pjsk')
  ])
})

test('MSS_GPU_PROFILE and MSS_GPU_MODE apply platform-aware presets before explicit overrides', (t) => {
  withIsolatedConfig(t, 'video:\n  encoder: auto\nrender:\n  linuxGpuAngle: true\n')

  // intel on Linux
  process.env.MSS_GPU_PROFILE = 'intel'
  const linuxIntel = loadHostConfig({ platform: 'linux' })
  assert.equal(linuxIntel.video.encoder, 'intel')
  assert.equal(linuxIntel.render.linuxGpuAngle, false)
  assert.equal(
    linuxIntel.render.extraChromeArgs,
    '--use-gl=angle --use-angle=vulkan --enable-features=Vulkan'
  )

  // intel on Windows does not touch Linux-specific Chrome flags
  const winIntel = loadHostConfig({ platform: 'win32' })
  assert.equal(winIntel.video.encoder, 'intel')
  assert.equal(winIntel.render.linuxGpuAngle, true)
  assert.equal(winIntel.render.extraChromeArgs, '')

  // nvidia via MSS_GPU_MODE alias on Linux
  delete process.env.MSS_GPU_PROFILE
  process.env.MSS_GPU_MODE = 'nvidia'
  const linuxNvidia = loadHostConfig({ platform: 'linux' })
  assert.equal(linuxNvidia.video.encoder, 'nvidia')
  assert.equal(linuxNvidia.render.linuxGpuAngle, false)
  assert.equal(linuxNvidia.render.extraChromeArgs, '--use-angle=vulkan')

  // amd and cpu presets
  process.env.MSS_GPU_MODE = 'amd'
  assert.equal(loadHostConfig({ platform: 'linux' }).video.encoder, 'amd')
  process.env.MSS_GPU_MODE = 'cpu'
  assert.equal(loadHostConfig({ platform: 'linux' }).video.encoder, 'libx264')

  // Explicit overrides ALWAYS win over GPU preset
  process.env.MSS_GPU_PROFILE = 'intel'
  process.env.MSS_FFMPEG_ENCODER = 'libx264'
  process.env.MSS_CHROME_ARGS = '--use-gl=swiftshader'
  process.env.MSS_LINUX_GPU_ANGLE = 'true'
  const overridden = loadHostConfig({ platform: 'linux' })
  assert.equal(overridden.video.encoder, 'libx264')
  assert.equal(overridden.render.extraChromeArgs, '--use-gl=swiftshader')
  assert.equal(overridden.render.linuxGpuAngle, true)
})

test('MSS_GPU_PROFILE preserves non-empty render.extraChromeArgs from config.yaml', (t) => {
  withIsolatedConfig(t, 'render:\n  extraChromeArgs: "--custom-gpu-flag"\n')
  process.env.MSS_GPU_PROFILE = 'intel'
  const cfg = loadHostConfig({ platform: 'linux' })
  assert.equal(cfg.video.encoder, 'intel')
  assert.equal(cfg.render.extraChromeArgs, '--custom-gpu-flag')
})

test('MSS_MEMORY_PROFILE=low applies NAS/4-8GB preset and yields to explicit overrides', (t) => {
  withIsolatedConfig(
    t,
    'video:\n  fps: 60\n  fastFps: 60\n  renderScale: 1.5\nrender:\n  workers: 2\n  maxConcurrentExports: 0\n  workerRecycleExports: 5\n'
  )

  process.env.MSS_MEMORY_PROFILE = 'standard'
  const std = loadHostConfig()
  assert.equal(std.render.workers, 2)
  assert.equal(std.video.fps, 60)

  process.env.MSS_MEMORY_PROFILE = 'low'
  const low = loadHostConfig()
  assert.equal(low.render.workers, 1)
  assert.equal(low.render.maxConcurrentExports, 1)
  assert.equal(low.render.workerRecycleExports, 2)
  assert.equal(low.video.fps, 30)
  assert.equal(low.video.fastFps, 30)
  assert.equal(low.video.renderScale, 1.0)

  // Explicit env overrides win over MSS_MEMORY_PROFILE=low
  process.env.MSS_WORKERS = '3'
  process.env.MSS_VIDEO_FPS = '60'
  process.env.MSS_FAST_FPS = '60'
  process.env.MSS_VIDEO_RENDER_SCALE = '1.25'
  const custom = loadHostConfig()
  assert.equal(custom.render.workers, 3)
  assert.equal(custom.video.fps, 60)
  assert.equal(custom.video.fastFps, 60)
  assert.equal(custom.video.renderScale, 1.25)
})

test('validateConfigHints catches common beginner misconfigurations and stays silent when clean', (t) => {
  withIsolatedConfig(
    t,
    [
      'server:',
      '  host: 0.0.0.0',
      '  apiKey: ""',
      'video:',
      '  fps: 60',
      '  fastFps: 30',
      'tts:',
      '  enabled: true',
      '  provider: gpt-sovits',
      '  defaultRefAudioPath: ""',
      '  characters: []',
      'llm:',
      '  enabled: true',
      '  apiKeyEnv: MSS_LLM_API_KEY',
      'assets:',
      '  cloudOnly: true'
    ].join('\n')
  )

  const misconfigured = loadHostConfig()
  const hints = validateConfigHints(misconfigured, {})
  assert.ok(
    hints.some((h) => h.includes('MSS_LLM_API_KEY')),
    `expected missing LLM key hint, got: ${hints.join(' | ')}`
  )
  assert.ok(
    hints.some((h) => h.includes('GPT-SoVITS')),
    `expected GPT-SoVITS voice hint, got: ${hints.join(' | ')}`
  )
  assert.ok(
    hints.some((h) => h.includes('video.fps') && h.includes('video.fastFps')),
    `expected fps/fastFps hint, got: ${hints.join(' | ')}`
  )
  assert.ok(
    hints.some((h) => h.includes('0.0.0.0') && h.includes('apiKey')),
    `expected 0.0.0.0 security hint, got: ${hints.join(' | ')}`
  )

  // Clean configuration produces zero hints (including with built-in personas/pjsk)
  const clean = structuredClone(misconfigured)
  clean.server.apiKey = 'super-secret-token'
  clean.video.fastFps = 60
  clean.tts.enabled = false
  const cleanHints = validateConfigHints(clean, { MSS_LLM_API_KEY: 'sk-test-123' })
  assert.deepEqual(cleanHints, [])

  // Non-existent personaDirs entry produces a clear hint
  const badPersona = structuredClone(clean)
  badPersona.llm.personaDirs = [path.join(clean.rootDir, 'does-not-exist-personas')]
  const badPersonaHints = validateConfigHints(badPersona, { MSS_LLM_API_KEY: 'sk-test-123' })
  assert.ok(
    badPersonaHints.some((h) => h.includes('personaDirs') && h.includes('personas/pjsk')),
    `expected missing personaDirs hint, got: ${badPersonaHints.join(' | ')}`
  )
})

test('init-config.mjs --non-interactive generates valid config.yaml & .env and guards overwrite', (t) => {
  const { dir } = withIsolatedConfig(t, null)
  const outConfig = path.join(dir, 'generated', 'config.yaml')
  const outEnv = path.join(dir, 'generated', '.env')

  const stdoutText = execFileSync(
    process.execPath,
    [
      INIT_SCRIPT,
      '--non-interactive',
      '--gpu',
      'intel',
      '--fps',
      '30',
      '--memory',
      'low',
      '--llm-url',
      'https://api.example.com/v1',
      '--llm-model',
      'deepseek-chat',
      '--llm-key',
      'sk-secret-do-not-leak',
      '--pipeline',
      'hybrid',
      '--tts',
      'irodori',
      '--tts-url',
      'http://127.0.0.1:8088',
      '--cloud-only',
      'true',
      '--api-key',
      'my-bearer-token',
      '--out-config',
      outConfig,
      '--out-env',
      outEnv
    ],
    { encoding: 'utf8' }
  )

  // Secrets must never appear in stdout summary or config.yaml
  assert.ok(!stdoutText.includes('sk-secret-do-not-leak'))
  assert.ok(!stdoutText.includes('my-bearer-token'))

  const yamlText = readFileSync(outConfig, 'utf8')
  const envText = readFileSync(outEnv, 'utf8')
  assert.ok(!yamlText.includes('sk-secret-do-not-leak'))
  assert.ok(!yamlText.includes('my-bearer-token'))
  assert.ok(envText.includes('MSS_LLM_API_KEY=sk-secret-do-not-leak'))
  assert.ok(envText.includes('MSS_API_KEY=my-bearer-token'))
  assert.ok(envText.includes('MSS_GPU_PROFILE=intel'))
  assert.ok(envText.includes('MSS_GPU_MODE=intel'))
  assert.ok(envText.includes('MSS_MEMORY_PROFILE=low'))
  assert.ok(!envText.includes('\r\n'), '.env should use LF line endings for Docker compatibility')

  if (process.platform !== 'win32') {
    const mode = fs.statSync(outEnv).mode & 0o777
    assert.equal(mode, 0o600)
  }

  // Round-trip: loadHostConfig parses generated config.yaml cleanly
  process.env.MSS_CONFIG_PATH = outConfig
  const loaded = loadHostConfig()
  assert.equal(loaded.video.encoder, 'intel')
  assert.equal(loaded.video.fps, 30)
  assert.equal(loaded.video.fastFps, 30)
  assert.equal(loaded.video.crf, 27)
  assert.equal(loaded.video.exportBitrate, 5_500_000)
  assert.equal(loaded.video.maxOutputMbps, 6.5)
  assert.equal(loaded.video.useRustExporter, true)
  assert.equal(loaded.render.workers, 1)
  assert.equal(loaded.render.maxConcurrentExports, 1)
  assert.equal(loaded.render.workerRecycleExports, 2)
  assert.equal(loaded.llm.baseUrl, 'https://api.example.com/v1')
  assert.equal(loaded.llm.model, 'deepseek-chat')
  assert.equal(loaded.llm.pipeline, 'hybrid')
  assert.deepEqual(loaded.llm.personaDirs, [path.resolve(loaded.rootDir, 'personas/pjsk')])
  assert.equal(loaded.tts.enabled, true)
  assert.equal(loaded.tts.provider, 'irodori')
  assert.equal(loaded.tts.apiBaseUrl, 'http://127.0.0.1:8088')
  assert.equal(loaded.assets.cloudOnly, true)
  assert.equal(loaded.bgm.volume, 0.35)

  // Overwrite protection: fails without --force
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          INIT_SCRIPT,
          '--non-interactive',
          '--gpu',
          'cpu',
          '--out-config',
          outConfig,
          '--out-env',
          outEnv
        ],
        { stdio: 'pipe' }
      ),
    /already exist|--force/i
  )

  // Overwrite succeeds with --force
  execFileSync(
    process.execPath,
    [
      INIT_SCRIPT,
      '--non-interactive',
      '--gpu',
      'cpu',
      '--tts',
      'none',
      '--out-config',
      outConfig,
      '--out-env',
      outEnv,
      '--force'
    ],
    { stdio: 'pipe' }
  )
  const reloaded = loadHostConfig()
  assert.equal(reloaded.video.encoder, 'libx264')
  assert.equal(reloaded.tts.enabled, false)
})

test('config.example.yaml parses cleanly, preserves key defaults, and has zero private IPs or local paths', (t) => {
  withIsolatedConfig(t, null)
  const examplePath = path.join(REPO_ROOT, 'config.example.yaml')
  const rawText = readFileSync(examplePath, 'utf8')

  assert.ok(
    rawText.includes('5 分钟极速配置区'),
    'config.example.yaml should include 5-minute quick start'
  )
  assert.ok(!/\b192\.168\.\d+\.\d+\b/.test(rawText), 'must not contain 192.168.x.x private IP')
  assert.ok(!/\b10\.\d+\.\d+\.\d+\b/.test(rawText), 'must not contain 10.x.x.x private IP')
  assert.ok(
    !/\b172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+\b/.test(rawText),
    'must not contain 172.16-31.x.x private IP'
  )
  assert.ok(!/[A-Za-z]:\\/.test(rawText), 'must not contain Windows local drive paths')
  assert.ok(
    !/(?:\/Users\/|\/home\/[^/\s]+\/Desktop|[\\/]桌面[\\/]|\\Desktop\\|mzkbot)/i.test(rawText),
    'must not contain personal desktop paths'
  )

  process.env.MSS_CONFIG_PATH = examplePath
  const cfg = loadHostConfig()
  assert.equal(cfg.bgm.volume, 0.35)
  assert.equal(cfg.assets.cloudOnly, true)
  assert.equal(cfg.video.crf, 27)
  assert.equal(cfg.video.exportBitrate, 5_500_000)
  assert.equal(cfg.video.maxOutputMbps, 6.5)
  assert.equal(cfg.video.useRustExporter, true)
  assert.ok(['staged', 'hybrid'].includes(cfg.llm.pipeline))
  assert.deepEqual(cfg.llm.personaDirs, [path.resolve(cfg.rootDir, 'personas/pjsk')])
})

test('parseDotEnv handles quotes, inline comments, export prefix, and CRLF/LF', () => {
  const raw = [
    '\uFEFF# Leading comment',
    '  ',
    'PLAIN=hello',
    'SPACED = world  # trailing inline comment',
    'export EXPORTED_KEY=from-export # comment',
    'DOUBLE_QUOTED="value with # hash and \\"quotes\\" and \\nnewline" # trailing',
    "SINGLE_QUOTED='literal # hash and \\n not escaped' # trailing",
    'EMPTY=',
    'URL=https://api.example.com/v1'
  ].join('\r\n')

  const parsed = parseDotEnv(raw)
  assert.equal(parsed.PLAIN, 'hello')
  assert.equal(parsed.SPACED, 'world')
  assert.equal(parsed.EXPORTED_KEY, 'from-export')
  assert.equal(parsed.DOUBLE_QUOTED, 'value with # hash and "quotes" and \nnewline')
  assert.equal(parsed.SINGLE_QUOTED, 'literal # hash and \\n not escaped')
  assert.equal(parsed.EMPTY, '')
  assert.equal(parsed.URL, 'https://api.example.com/v1')
})

test('loadDotEnv loads .env into env without overwriting existing values and supports MSS_ENV_FILE', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mss-dotenv-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  writeFileSync(
    path.join(dir, '.env'),
    [
      'MSS_LLM_API_KEY=sk-from-dotenv',
      'MSS_API_KEY="dotenv-api-key"',
      'export MSS_LLM_MODEL=gpt-4.1-mini # default model',
      "MSS_HOST='127.0.0.1'"
    ].join('\n'),
    'utf8'
  )

  const targetEnv = {
    MSS_LLM_API_KEY: 'sk-from-shell',
    MSS_HOST: ''
  }

  const res = loadDotEnv(dir, { env: targetEnv })
  assert.equal(res.loaded, true)
  assert.equal(res.path, path.join(dir, '.env'))
  // Existing process.env entries (even empty string) MUST win over .env
  assert.equal(targetEnv.MSS_LLM_API_KEY, 'sk-from-shell')
  assert.equal(targetEnv.MSS_HOST, '')
  // Unset keys are populated from .env
  assert.equal(targetEnv.MSS_API_KEY, 'dotenv-api-key')
  assert.equal(targetEnv.MSS_LLM_MODEL, 'gpt-4.1-mini')
  assert.deepEqual(res.loadedKeys.sort(), ['MSS_API_KEY', 'MSS_LLM_MODEL'])

  // MSS_ENV_FILE override (relative to rootDir)
  writeFileSync(
    path.join(dir, 'custom.env'),
    'MSS_PORT=9900\nMSS_LLM_MODEL=override-model\n',
    'utf8'
  )
  const customEnv = { MSS_ENV_FILE: 'custom.env' }
  const customRes = loadDotEnv(dir, { env: customEnv })
  assert.equal(customRes.loaded, true)
  assert.equal(customRes.path, path.join(dir, 'custom.env'))
  assert.equal(customEnv.MSS_PORT, '9900')
  assert.equal(customEnv.MSS_LLM_MODEL, 'override-model')

  // Missing .env file is a silent no-op
  const missingRes = loadDotEnv(dir, { env: {}, envFile: 'does-not-exist.env' })
  assert.equal(missingRes.loaded, false)
  assert.deepEqual(missingRes.loadedKeys, [])
})
