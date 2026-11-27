import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const DOCKER_ASSET_FILES = [
  'Dockerfile',
  '.dockerignore',
  'docker-compose.yml',
  'docker-compose.intel.yml',
  'docker-compose.nvidia.yml',
  'docker/entrypoint.sh',
  '.env.example'
]

/**
 * Env vars owned by Docker compose/entrypoint or the public easy-config preset layer
 * in addition to those directly referenced in src/host/config.ts and runtime modules.
 */
const ALLOWED_EXTRA_MSS_ENV_VARS = new Set([
  'MSS_HOST_PORT',
  'MSS_GPU_MODE',
  'MSS_GPU_PROFILE',
  'MSS_MEMORY_PROFILE',
  'MSS_LLM_API_KEY',
  'MSS_LLM_PERSONA_DIRS',
  'MSS_LLM_POLISH_DIALOGUE',
  'MSS_SERVER_CORS',
  'MSS_VIDEO_ENCODER',
  'MSS_CONFIG_PATH'
])

function readRepoFile(relPath) {
  return fs.readFileSync(path.join(rootDir, relPath), 'utf8')
}

function collectKnownHostEnvVars() {
  const known = new Set(ALLOWED_EXTRA_MSS_ENV_VARS)
  const sources = [
    'src/host/config.ts',
    'src/host/env.ts',
    'src/host/main.ts',
    'src/shared/ffmpeg.ts',
    'src/host/export/rustExporter.ts',
    'src/host/servers/VideoApiServer.ts'
  ]
  const envPattern = /\b(MSST?_[A-Z0-9_]+)\b/g
  for (const rel of sources) {
    const text = readRepoFile(rel)
    for (const match of text.matchAll(envPattern)) {
      known.add(match[1])
    }
  }
  return known
}

function parseEnvExampleKeys(text) {
  const active = new Map()
  const all = new Set()
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue
    const commentedMatch = trimmed.match(/^#\s*([A-Z][A-Z0-9_]*)=/)
    if (commentedMatch) {
      all.add(commentedMatch[1])
      continue
    }
    if (trimmed.startsWith('#')) continue
    const activeMatch = trimmed.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
    if (activeMatch) {
      active.set(activeMatch[1], activeMatch[2])
      all.add(activeMatch[1])
    }
  }
  return { active, all }
}

test('all Docker packaging assets exist', () => {
  for (const relPath of DOCKER_ASSET_FILES) {
    const absPath = path.join(rootDir, relPath)
    assert.ok(fs.existsSync(absPath), `Missing expected Docker asset: ${relPath}`)
  }
})

test('docker/entrypoint.sh uses strict LF endings and covers browser, GPU presets, and safe logging', () => {
  const raw = fs.readFileSync(path.join(rootDir, 'docker/entrypoint.sh'))
  assert.equal(raw.includes(0x0d), false, 'docker/entrypoint.sh must use LF (no CR bytes)')

  const text = raw.toString('utf8')
  assert.match(text, /^#!\/usr\/bin\/env bash\n/, 'entrypoint.sh must start with bash shebang')
  assert.match(text, /set -euo pipefail/, 'entrypoint.sh must enable strict mode')
  assert.match(
    text,
    /chrome-linux\/chrome/,
    'entrypoint.sh must probe Playwright full Chromium (chrome-linux/chrome)'
  )
  assert.match(
    text,
    /chrome-linux64\/chrome/,
    'entrypoint.sh must probe newer Playwright full Chromium (chrome-linux64/chrome)'
  )
  assert.match(
    text,
    /export MSS_BROWSER_EXECUTABLE=/,
    'entrypoint.sh must export discovered MSS_BROWSER_EXECUTABLE'
  )

  // GPU presets
  assert.match(text, /--use-gl=angle --use-angle=vulkan --enable-features=Vulkan/)
  assert.match(text, /export MSS_LINUX_GPU_ANGLE="false"/)
  assert.match(text, /export MSS_FFMPEG_ENCODER="intel"/)
  assert.match(text, /export MSS_CHROME_ARGS="--use-angle=vulkan"/)
  assert.match(text, /export MSS_FFMPEG_ENCODER="nvidia"/)
  assert.match(text, /export MSS_FFMPEG_ENCODER="libx264"/)

  // PID 1 signal forwarding
  assert.match(text, /\bexec "\$@"/, 'entrypoint.sh must exec "$@" for signal forwarding')

  // Never print raw API key values in startup summary or echo/printf lines
  const heredocMatch = text.match(/cat <<EOF\n([\s\S]*?)\nEOF/)
  assert.ok(heredocMatch, 'entrypoint.sh must print a startup summary heredoc')
  assert.doesNotMatch(
    heredocMatch[1],
    /\$\{?(?:MSS_LLM_API_KEY|MSS_API_KEY|MSST_API_KEY|!llm_key_env_name)\b/,
    'startup summary must never interpolate raw API key values'
  )
  for (const line of text.split('\n')) {
    if (/^\s*(?:echo|printf)\b/.test(line)) {
      assert.doesNotMatch(
        line,
        /\$\{?(?:MSS_LLM_API_KEY|MSS_API_KEY|MSST_API_KEY|!llm_key_env_name)\b/,
        `log line must never interpolate raw API key values: ${line}`
      )
    }
  }
})

test('Dockerfile is multi-stage, aligned with package-lock Playwright version, and includes GPU/FFmpeg/healthcheck', () => {
  const dockerfile = readRepoFile('Dockerfile')
  const lockfile = JSON.parse(readRepoFile('package-lock.json'))
  const lockedPlaywright = lockfile.packages?.['node_modules/playwright']?.version
  assert.ok(lockedPlaywright, 'package-lock.json must resolve playwright version')

  assert.match(
    dockerfile,
    new RegExp(`mcr\\.microsoft\\.com/playwright:v${lockedPlaywright.replace(/\./g, '\\.')}-noble`),
    `Dockerfile default Playwright base image must match lockfile version ${lockedPlaywright}`
  )
  assert.match(dockerfile, /ARG BUILD_MIRROR=global/)
  assert.match(dockerfile, /rsproxy\.cn/)
  assert.match(dockerfile, /registry\.npmmirror\.com/)
  assert.match(dockerfile, /FROM\s+\$\{PLAYWRIGHT_IMAGE\}\s+AS\s+builder/)
  assert.match(dockerfile, /FROM\s+\$\{PLAYWRIGHT_IMAGE\}\s+AS\s+runtime/)
  assert.match(dockerfile, /npm run build/)
  assert.match(dockerfile, /npm run build:rust/)
  assert.match(dockerfile, /npm prune --omit=dev/)

  const requiredRuntimePackages = [
    'libgl1-mesa-dri',
    'libegl1',
    'libgles2',
    'libgbm1',
    'mesa-vulkan-drivers',
    'libdrm-intel1',
    'intel-media-va-driver-non-free',
    'libmfx-gen1.2',
    'libvpl2',
    'vainfo',
    'ffmpeg',
    'fonts-noto-cjk',
    'curl',
    'ca-certificates'
  ]
  for (const pkg of requiredRuntimePackages) {
    assert.ok(dockerfile.includes(pkg), `Dockerfile runtime stage must install package: ${pkg}`)
  }

  for (const artifact of [
    '/app/out',
    '/app/out-host',
    '/app/node_modules',
    '/app/scripts/init-config.mjs',
    'mss-export-napi.node',
    'mss-export-rs'
  ]) {
    assert.ok(dockerfile.includes(artifact), `Dockerfile runtime stage must copy: ${artifact}`)
  }
  assert.doesNotMatch(
    dockerfile,
    /^COPY\s+--from=builder\s+\/app\/scripts\s+\.\/scripts$/m,
    'Dockerfile runtime stage must not copy the entire scripts/ test directory'
  )
  assert.match(
    dockerfile,
    /^COPY\s+personas\s+\.\/personas$/m,
    'Dockerfile runtime stage must copy built-in personas into /app/personas'
  )

  assert.match(dockerfile, /MSS_FFMPEG_PATH=\/usr\/bin\/ffmpeg/)
  assert.match(dockerfile, /MALLOC_ARENA_MAX=2/)
  assert.match(dockerfile, /MALLOC_MMAP_THRESHOLD_=131072/)
  assert.match(dockerfile, /EXPOSE\s+9881/)
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*http:\/\/127\.0\.0\.1:9881\/api\/v1\/health/)
})

test('.dockerignore excludes VCS, build caches, runtime outputs, and secrets', () => {
  const dockerignore = readRepoFile('.dockerignore')
  for (const entry of [
    '.git',
    'node_modules',
    'out',
    'out-host',
    'native/mss-export-rs/target',
    'apifile',
    'cache',
    'config.yaml',
    '.env'
  ]) {
    assert.match(
      dockerignore,
      new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
      `.dockerignore must exclude ${entry}`
    )
  }
  assert.doesNotMatch(
    dockerignore,
    /^personas\/?$/m,
    '.dockerignore must not exclude built-in personas/ directory'
  )
  assert.match(
    dockerignore,
    /^!personas\/\*\*\/\*\.md$/m,
    '.dockerignore must explicitly include personas/**/*.md despite root *.md rule'
  )
})

test('docker-compose files are valid YAML with matching service name and required settings', () => {
  const base = yaml.load(readRepoFile('docker-compose.yml'))
  const intel = yaml.load(readRepoFile('docker-compose.intel.yml'))
  const nvidia = yaml.load(readRepoFile('docker-compose.nvidia.yml'))

  assert.equal(typeof base, 'object')
  assert.equal(typeof intel, 'object')
  assert.equal(typeof nvidia, 'object')

  const baseService = base?.services?.['mysekai-storyteller']
  const intelService = intel?.services?.['mysekai-storyteller']
  const nvidiaService = nvidia?.services?.['mysekai-storyteller']

  assert.ok(baseService, 'docker-compose.yml must define services.mysekai-storyteller')
  assert.ok(intelService, 'docker-compose.intel.yml must extend services.mysekai-storyteller')
  assert.ok(nvidiaService, 'docker-compose.nvidia.yml must extend services.mysekai-storyteller')

  // Base compose invariants
  assert.equal(
    baseService.init,
    true,
    'docker-compose.yml must set init: true to reap Chromium zombies'
  )
  assert.equal(baseService.shm_size, '2gb')
  assert.equal(baseService.restart, 'unless-stopped')
  assert.match(
    String(baseService.environment?.MALLOC_ARENA_MAX ?? ''),
    /2/,
    'docker-compose.yml must configure MALLOC_ARENA_MAX=2'
  )
  assert.match(
    String(baseService.environment?.MALLOC_MMAP_THRESHOLD_ ?? ''),
    /131072/,
    'docker-compose.yml must configure MALLOC_MMAP_THRESHOLD_=131072'
  )
  assert.ok(
    Array.isArray(baseService.ports) && baseService.ports.some((p) => String(p).endsWith(':9881')),
    'docker-compose.yml must expose container port 9881'
  )
  assert.ok(
    Array.isArray(baseService.env_file) &&
      baseService.env_file.some((e) => e === '.env' || e?.path === '.env'),
    'docker-compose.yml must reference .env in env_file'
  )
  for (const vol of [
    './apifile:/app/apifile',
    './resources:/app/resources',
    './cache:/app/cache'
  ]) {
    assert.ok(
      Array.isArray(baseService.volumes) && baseService.volumes.includes(vol),
      `docker-compose.yml must mount volume ${vol}`
    )
  }

  // Intel overlay invariants
  assert.ok(
    Array.isArray(intelService.devices) && intelService.devices.includes('/dev/dri:/dev/dri'),
    'docker-compose.intel.yml must pass /dev/dri:/dev/dri'
  )
  assert.ok(
    Array.isArray(intelService.group_add) &&
      intelService.group_add.some((g) => String(g).includes('video')) &&
      intelService.group_add.some((g) => String(g).includes('render')),
    'docker-compose.intel.yml must configure video and render group_add'
  )
  assert.equal(intelService.ipc, 'host')
  assert.equal(intelService.environment?.MSS_GPU_MODE, 'intel')

  // NVIDIA overlay invariants
  assert.equal(nvidiaService.environment?.MSS_GPU_MODE, 'nvidia')
  assert.match(String(nvidiaService.environment?.NVIDIA_VISIBLE_DEVICES ?? ''), /all/)
  assert.match(String(nvidiaService.environment?.NVIDIA_DRIVER_CAPABILITIES ?? ''), /all/)
  const nvidiaDevices = nvidiaService.deploy?.resources?.reservations?.devices
  assert.ok(Array.isArray(nvidiaDevices) && nvidiaDevices.length >= 1)
  assert.equal(nvidiaDevices[0].driver, 'nvidia')
  assert.ok(
    Array.isArray(nvidiaDevices[0].capabilities) && nvidiaDevices[0].capabilities.includes('gpu'),
    'docker-compose.nvidia.yml must reserve nvidia gpu capability'
  )
})

test('.env.example has sensible public defaults and consistent env var names with src/host/config.ts', () => {
  const envText = readRepoFile('.env.example')
  const { active, all } = parseEnvExampleKeys(envText)
  const knownHostEnvVars = collectKnownHostEnvVars()

  // Verify every MSS_* / MSST_* variable in .env.example matches known host/docker contract
  for (const key of all) {
    if (key.startsWith('MSS_') || key.startsWith('MSST_')) {
      assert.ok(
        knownHostEnvVars.has(key),
        `.env.example contains unknown/misspelled variable: ${key}`
      )
    }
  }

  // Verify key public defaults
  assert.equal(active.get('BUILD_MIRROR'), 'global')
  assert.equal(active.get('MSS_GPU_MODE'), 'auto')
  assert.equal(active.get('MSS_BGM_VOLUME'), '0.35')
  assert.equal(active.get('MSS_ASSETS_CLOUD_ONLY'), 'true')
  assert.equal(active.get('MSS_ASSETS_CLOUD_CATALOG'), 'true')
  assert.equal(active.get('MSS_LLM_API_KEY'), '', 'MSS_LLM_API_KEY must be empty in .env.example')
  assert.equal(active.get('MSS_MEMORY_PROFILE'), 'standard')
  assert.equal(active.get('MSS_TTS_ENABLED'), 'false')
})

test('Docker assets contain zero private IPs, secrets, or personal paths', () => {
  const forbiddenPatterns = [
    { name: 'RFC1918 192.168.x.x IP', regex: /\b192\.168\.\d{1,3}\.\d{1,3}\b/ },
    { name: 'RFC1918 10.x.x.x IP', regex: /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/ },
    {
      name: 'RFC1918 172.16-31.x.x IP',
      regex: /\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/
    },
    { name: 'real sk- API key', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
    { name: 'Windows drive path', regex: /[A-Za-z]:\\Users\\/i },
    { name: 'personal Chinese desktop path', regex: /桌面/ }
  ]

  for (const relPath of DOCKER_ASSET_FILES) {
    const content = readRepoFile(relPath)
    for (const { name, regex } of forbiddenPatterns) {
      assert.doesNotMatch(content, regex, `${relPath} must not contain ${name}`)
    }
  }
})

function findBashBinary() {
  const candidates = ['bash']
  if (process.platform === 'win32') {
    const whereGit = spawnSync('where.exe', ['git'], { encoding: 'utf8' })
    if (!whereGit.error && whereGit.status === 0) {
      for (const line of whereGit.stdout.split(/\r?\n/)) {
        const gitPath = line.trim()
        if (!gitPath) continue
        const gitRoot = path.dirname(path.dirname(gitPath))
        candidates.push(
          path.join(gitRoot, 'bin', 'bash.exe'),
          path.join(gitRoot, 'usr', 'bin', 'bash.exe')
        )
      }
    }
    candidates.push(
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe'
    )
  }
  for (const candidate of candidates) {
    const res = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
    if (!res.error && res.status === 0) return candidate
  }
  return null
}

test('docker/entrypoint.sh passes bash syntax check and runtime preset behavior when bash is available', (t) => {
  const bashBin = findBashBinary()
  if (!bashBin) {
    t.skip('bash is not available in this environment')
    return
  }

  const entrypointPath = path.join(rootDir, 'docker/entrypoint.sh')
  const syntax = spawnSync(bashBin, ['-n', entrypointPath], { encoding: 'utf8' })
  assert.equal(
    syntax.status,
    0,
    `bash -n failed on docker/entrypoint.sh:\n${syntax.stderr || syntax.stdout}`
  )

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mss-docker-entry-'))
  t.after(() => fs.rmSync(tmpBase, { recursive: true, force: true }))

  const fakeChromeDir = path.join(tmpBase, 'ms-playwright', 'chromium-1200', 'chrome-linux64')
  const fakeHeadlessDir = path.join(
    tmpBase,
    'ms-playwright',
    'chromium_headless_shell-1200',
    'chrome-linux64'
  )
  fs.mkdirSync(fakeChromeDir, { recursive: true })
  fs.mkdirSync(fakeHeadlessDir, { recursive: true })
  const fakeChrome = path.join(fakeChromeDir, 'chrome')
  const fakeHeadless = path.join(fakeHeadlessDir, 'headless_shell')
  fs.writeFileSync(fakeChrome, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
  fs.writeFileSync(fakeHeadless, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })

  const secretToken = 'SUPER_SECRET_TEST_KEY_987654321'
  const bashDir = path.dirname(bashBin)
  const gitUsrBin = path.resolve(bashDir, '..', 'usr', 'bin')
  const testPath =
    process.platform === 'win32'
      ? [gitUsrBin, bashDir, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter)
      : (process.env.PATH ?? '')
  const posixPath = (p) => p.replace(/\\/g, '/')
  const runCase = (gpuMode, extraEnv = {}) =>
    spawnSync(
      bashBin,
      [
        entrypointPath,
        bashBin,
        '-c',
        'printf "RESULT|%s|%s|%s|%s\\n" "${MSS_BROWSER_EXECUTABLE:-}" "${MSS_CHROME_ARGS:-}" "${MSS_LINUX_GPU_ANGLE:-}" "${MSS_FFMPEG_ENCODER:-}"'
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: testPath,
          PLAYWRIGHT_BROWSERS_PATH: posixPath(path.join(tmpBase, 'ms-playwright')),
          MSS_CONFIG_PATH: posixPath(path.join(tmpBase, 'nonexistent-config.yaml')),
          MSS_OUTPUT_DIR: posixPath(path.join(tmpBase, 'apifile')),
          MSS_RESOURCE_DIR: posixPath(path.join(tmpBase, 'resources')),
          MSS_GPU_MODE: gpuMode,
          MSS_LLM_API_KEY: secretToken,
          MSS_API_KEY: secretToken,
          ...extraEnv
        }
      }
    )

  for (const [mode, expectedArgs, expectedAngle, expectedEncoder] of [
    ['intel', '--use-gl=angle --use-angle=vulkan --enable-features=Vulkan', 'false', 'intel'],
    ['nvidia', '--use-angle=vulkan', 'false', 'nvidia'],
    ['cpu', '', '', 'libx264']
  ]) {
    const res = runCase(mode)
    assert.equal(res.status, 0, `entrypoint failed for mode=${mode}: ${res.stderr}`)
    assert.ok(
      !res.stdout.includes(secretToken) && !res.stderr.includes(secretToken),
      `entrypoint leaked secret token in mode=${mode}`
    )
    const resultLine = res.stdout.split(/\r?\n/).find((line) => line.startsWith('RESULT|'))
    assert.ok(resultLine, `Missing RESULT line for mode=${mode}:\n${res.stdout}`)
    const [, browserExec, chromeArgs, linuxAngle, ffmpegEncoder] = resultLine.split('|')
    assert.match(browserExec.replace(/\\/g, '/'), /chromium-1200\/chrome-linux64\/chrome$/)
    assert.equal(chromeArgs, expectedArgs)
    assert.equal(linuxAngle, expectedAngle)
    assert.equal(ffmpegEncoder, expectedEncoder)
  }

  // Explicit overrides must win over MSS_GPU_MODE presets
  const overrideRes = runCase('intel', {
    MSS_FFMPEG_ENCODER: 'libx264',
    MSS_CHROME_ARGS: '--custom-flag',
    MSS_LINUX_GPU_ANGLE: 'true'
  })
  assert.equal(overrideRes.status, 0, overrideRes.stderr)
  const overrideLine = overrideRes.stdout.split(/\r?\n/).find((line) => line.startsWith('RESULT|'))
  assert.ok(overrideLine)
  const [, , overrideArgs, overrideAngle, overrideEncoder] = overrideLine.split('|')
  assert.equal(overrideArgs, '--custom-flag')
  assert.equal(overrideAngle, 'true')
  assert.equal(overrideEncoder, 'libx264')

  // MSS_GPU_PROFILE takes precedence over MSS_GPU_MODE (matching src/host/config.ts)
  // and explicit MSS_VIDEO_ENCODER is not clobbered by preset MSS_FFMPEG_ENCODER
  const profileRes = runCase('intel', {
    MSS_GPU_PROFILE: 'nvidia',
    MSS_VIDEO_ENCODER: 'libx264'
  })
  assert.equal(profileRes.status, 0, profileRes.stderr)
  const profileLine = profileRes.stdout.split(/\r?\n/).find((line) => line.startsWith('RESULT|'))
  assert.ok(profileLine)
  const [, , profileArgs, profileAngle, profileEncoder] = profileLine.split('|')
  assert.equal(profileArgs, '--use-angle=vulkan')
  assert.equal(profileAngle, 'false')
  assert.equal(profileEncoder, '')
})
