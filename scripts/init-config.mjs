#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const VALID_GPU = new Set(['auto', 'intel', 'nvidia', 'amd', 'cpu'])
const VALID_FPS = new Set([30, 60])
const VALID_MEMORY = new Set(['low', 'standard'])
const VALID_PIPELINE = new Set(['hybrid', 'staged', 'single'])
const VALID_TTS = new Set(['none', 'irodori', 'gpt-sovits'])

const USAGE = `MySekaiStoryteller-API 交互式配置初始化向导

用法：
  npm run init
  node scripts/init-config.mjs [选项]

选项：
  --non-interactive              跳过交互提示，直接使用参数或默认值生成配置
  --gpu <auto|intel|nvidia|amd|cpu>
                                 硬件编码/GPU 预设（默认：auto）
  --fps <30|60>                  视频帧率（standard 默认 60，low 内存预设默认 30）
  --memory <low|standard>        内存规格预设：low (4-8GB RAM/NAS) | standard（默认：standard）
  --llm-url <url>                OpenAI 兼容 API 基地址（默认：https://api.openai.com/v1）
  --llm-model <model>            模型名（默认：gpt-4.1-mini）
  --llm-key <key>                LLM API 密钥（仅写入 .env 的 MSS_LLM_API_KEY，绝不写入 config.yaml）
  --pipeline <hybrid|staged|single>
                                 AI 剧本生成流水线（默认：staged）
  --tts <none|irodori|gpt-sovits>
                                 语音合成引擎（默认：none）
  --tts-url <url>                TTS 服务地址（irodori 默认 http://127.0.0.1:8088，gpt-sovits 默认 http://127.0.0.1:9880）
  --cloud-only <true|false>      纯云端零本地资源模式（默认：true）
  --api-key <key>                服务 Bearer 鉴权密钥（仅写入 .env 的 MSS_API_KEY）
  --out-config <path>            输出 config.yaml 路径（默认：config.yaml）
  --out-env <path>               输出 .env 路径（默认：.env）
  --force                        允许覆盖已存在的目标文件
  -h, --help                     显示本帮助信息
`

function parseBoolOption(raw, flagName) {
  const normalized = String(raw).trim().toLowerCase()
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false
  throw new Error(`Invalid value for ${flagName}: "${raw}" (expected true or false)`)
}

export function parseCliArgs(argv) {
  const opts = {
    help: false,
    nonInteractive: false,
    force: false,
    gpu: undefined,
    fps: undefined,
    memory: undefined,
    llmUrl: undefined,
    llmModel: undefined,
    llmKey: undefined,
    pipeline: undefined,
    tts: undefined,
    ttsUrl: undefined,
    cloudOnly: undefined,
    apiKey: undefined,
    outConfig: 'config.yaml',
    outEnv: '.env'
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      opts.help = true
      continue
    }
    if (arg === '--non-interactive') {
      opts.nonInteractive = true
      continue
    }
    if (arg === '--force') {
      opts.force = true
      continue
    }

    let flag = arg
    let value
    const eqIdx = arg.indexOf('=')
    if (eqIdx !== -1) {
      flag = arg.slice(0, eqIdx)
      value = arg.slice(eqIdx + 1)
    } else if (arg.startsWith('--')) {
      if (i + 1 >= argv.length) {
        throw new Error(`Missing value for option ${flag}`)
      }
      value = argv[i + 1]
      i += 1
    } else {
      throw new Error(`Unknown positional argument: ${arg}`)
    }

    switch (flag) {
      case '--gpu':
        opts.gpu = value.trim().toLowerCase()
        break
      case '--fps': {
        const parsed = Number.parseInt(value, 10)
        if (!Number.isFinite(parsed)) {
          throw new Error(`Invalid value for --fps: "${value}" (expected 30 or 60)`)
        }
        opts.fps = parsed
        break
      }
      case '--memory':
        opts.memory = value.trim().toLowerCase()
        break
      case '--llm-url':
        opts.llmUrl = value.trim()
        break
      case '--llm-model':
        opts.llmModel = value.trim()
        break
      case '--llm-key':
        opts.llmKey = value.trim()
        break
      case '--pipeline':
        opts.pipeline = value.trim().toLowerCase()
        break
      case '--tts':
        opts.tts = value.trim().toLowerCase()
        break
      case '--tts-url':
        opts.ttsUrl = value.trim()
        break
      case '--cloud-only':
        opts.cloudOnly = parseBoolOption(value, '--cloud-only')
        break
      case '--api-key':
        opts.apiKey = value.trim()
        break
      case '--out-config':
        opts.outConfig = value.trim()
        break
      case '--out-env':
        opts.outEnv = value.trim()
        break
      default:
        throw new Error(`Unknown option: ${flag}`)
    }
  }

  return opts
}

function validateFinalOptions(cfg) {
  if (!VALID_GPU.has(cfg.gpu)) {
    throw new Error(`Invalid --gpu "${cfg.gpu}" (expected one of: auto, intel, nvidia, amd, cpu)`)
  }
  if (!VALID_FPS.has(cfg.fps)) {
    throw new Error(`Invalid --fps "${cfg.fps}" (expected 30 or 60)`)
  }
  if (!VALID_MEMORY.has(cfg.memory)) {
    throw new Error(`Invalid --memory "${cfg.memory}" (expected low or standard)`)
  }
  if (!VALID_PIPELINE.has(cfg.pipeline)) {
    throw new Error(`Invalid --pipeline "${cfg.pipeline}" (expected hybrid, staged, or single)`)
  }
  if (!VALID_TTS.has(cfg.tts)) {
    throw new Error(`Invalid --tts "${cfg.tts}" (expected none, irodori, or gpt-sovits)`)
  }
  if (!cfg.llmUrl) {
    throw new Error('LLM base URL (--llm-url) cannot be empty')
  }
  if (!cfg.llmModel) {
    throw new Error('LLM model (--llm-model) cannot be empty')
  }
}

function yamlString(val) {
  const str = String(val)
  if (
    /^[A-Za-z0-9_./:-]+$/.test(str) &&
    !['true', 'false', 'null', 'yes', 'no'].includes(str.toLowerCase())
  ) {
    return str
  }
  return JSON.stringify(str)
}

function envValue(val) {
  const clean = String(val).replace(/\r?\n/g, '')
  if (clean === '') return ''
  if (/[\s#"'`$\\]/.test(clean)) {
    return JSON.stringify(clean)
  }
  return clean
}

function mapGpuToEncoder(gpu) {
  if (gpu === 'cpu') return 'libx264'
  return gpu
}

export function buildConfigYaml(cfg) {
  const encoder = mapGpuToEncoder(cfg.gpu)
  const isLowMem = cfg.memory === 'low'
  const workers = isLowMem ? 1 : 2
  const maxConcurrentExports = isLowMem ? 1 : 0
  const workerRecycleExports = isLowMem ? 2 : 5
  const minFreeMemoryMb = isLowMem ? 1024 : 0
  const ttsEnabled = cfg.tts !== 'none'
  const ttsProvider = cfg.tts === 'irodori' ? 'irodori' : 'gpt-sovits'
  const ttsApiBaseUrl =
    cfg.ttsUrl || (ttsProvider === 'irodori' ? 'http://127.0.0.1:8088' : 'http://127.0.0.1:9880')

  return [
    '# Generated by scripts/init-config.mjs (MySekaiStoryteller-API)',
    '# 密钥请保存在同目录 .env 中（MSS_LLM_API_KEY / MSS_API_KEY），勿提交至 Git',
    '',
    'server:',
    '  port: 9881',
    '  host: 0.0.0.0',
    '  apiKey: ""',
    '',
    'video:',
    '  width: 1920',
    '  height: 1080',
    `  fps: ${cfg.fps}`,
    `  fastFps: ${cfg.fps}`,
    '  crf: 27',
    '  renderScale: 1',
    '  codec: hevc',
    '  audioBitrate: 128k',
    `  encoder: ${yamlString(encoder)}`,
    '  watermark: true',
    '  watermarkText: ""',
    '  exportMode: fast',
    '  exportBitrate: 5500000',
    '  maxOutputMbps: 6.5',
    '  useRustExporter: true',
    '  exportJobs: 1',
    '  exportFastEncoder: auto',
    '  ttsMode: concurrent',
    '',
    'render:',
    `  workers: ${workers}`,
    `  maxConcurrentExports: ${maxConcurrentExports}`,
    `  workerRecycleExports: ${workerRecycleExports}`,
    '  linuxGpuAngle: true',
    '  extraChromeArgs: ""',
    `  minFreeMemoryMb: ${minFreeMemoryMb}`,
    '',
    'paths:',
    '  output: apifile',
    '  resources: resources',
    '  webRenderer: out/webrenderer',
    '',
    'tts:',
    `  enabled: ${ttsEnabled}`,
    `  provider: ${yamlString(ttsProvider)}`,
    `  apiBaseUrl: ${yamlString(ttsApiBaseUrl)}`,
    '  timeoutMs: 120000',
    '  characters: []',
    '',
    'bgm:',
    '  enabled: true',
    '  path: bgm00003',
    '  volume: 0.35',
    '',
    'llm:',
    '  enabled: true',
    `  baseUrl: ${yamlString(cfg.llmUrl)}`,
    '  apiKeyEnv: MSS_LLM_API_KEY',
    `  model: ${yamlString(cfg.llmModel)}`,
    `  pipeline: ${yamlString(cfg.pipeline)}`,
    `  translateForTts: ${ttsEnabled}`,
    '  polishDialogue: true',
    '  # 默认自动加载仓库内置 58 份 PJSK 角色人格；追加自定义目录可叠加覆盖，设为 [] 可禁用',
    '  personaDirs: [personas/pjsk]',
    '  personas: []',
    '',
    'assets:',
    '  source: moesekai',
    '  region: jp',
    '  cloudCatalog: true',
    `  cloudOnly: ${cfg.cloudOnly}`,
    '  cloudCatalogTtlHours: 6',
    '',
    'logLevel: info',
    ''
  ].join('\n')
}

export function buildDotEnv(cfg) {
  const ttsEnabled = cfg.tts !== 'none'
  const ttsProvider = cfg.tts === 'irodori' ? 'irodori' : 'gpt-sovits'
  const ttsApiBaseUrl =
    cfg.ttsUrl || (ttsProvider === 'irodori' ? 'http://127.0.0.1:8088' : 'http://127.0.0.1:9880')

  const lines = [
    '# Generated by scripts/init-config.mjs (MySekaiStoryteller-API)',
    '# Keep this file private (mode 0600 on POSIX); never commit .env to Git.',
    '',
    '# --- AI Script Generation (OpenAI-compatible) ---',
    `MSS_LLM_API_KEY=${envValue(cfg.llmKey)}`,
    `MSS_LLM_BASE_URL=${envValue(cfg.llmUrl)}`,
    `MSS_LLM_MODEL=${envValue(cfg.llmModel)}`,
    `MSS_LLM_PIPELINE=${envValue(cfg.pipeline)}`,
    '',
    '# --- Hardware & Memory Profiles ---',
    cfg.gpu === 'auto' ? '# MSS_GPU_PROFILE=intel' : `MSS_GPU_PROFILE=${envValue(cfg.gpu)}`,
    cfg.gpu === 'auto' ? '# MSS_GPU_MODE=intel' : `MSS_GPU_MODE=${envValue(cfg.gpu)}`,
    `MSS_MEMORY_PROFILE=${envValue(cfg.memory)}`,
    `MSS_VIDEO_FPS=${cfg.fps}`,
    `MSS_FAST_FPS=${cfg.fps}`,
    '',
    '# --- TTS ---',
    `MSS_TTS_ENABLED=${ttsEnabled}`
  ]

  if (ttsEnabled) {
    lines.push(`MSS_TTS_PROVIDER=${envValue(ttsProvider)}`)
    lines.push(`MSS_TTS_API_BASE_URL=${envValue(ttsApiBaseUrl)}`)
  } else {
    lines.push('# MSS_TTS_PROVIDER=gpt-sovits')
    lines.push('# MSS_TTS_API_BASE_URL=http://127.0.0.1:9880')
  }

  lines.push(
    '',
    '# --- Cloud Assets & BGM ---',
    `MSS_ASSETS_CLOUD_ONLY=${cfg.cloudOnly}`,
    'MSS_BGM_VOLUME=0.35',
    '',
    '# --- Server Auth (recommended when exposed publicly) ---',
    cfg.apiKey ? `MSS_API_KEY=${envValue(cfg.apiKey)}` : '# MSS_API_KEY=',
    ''
  )

  return lines.join('\n')
}

async function promptInteractive(initial) {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    stdout.write('\n=== MySekaiStoryteller-API 5 分钟配置向导 ===\n')
    stdout.write('直接按回车可使用方括号内的默认值。\n\n')

    const ask = async (label, defaultValue, validator) => {
      while (true) {
        const suffix = defaultValue !== '' ? ` [${defaultValue}]` : ''
        const answer = (await rl.question(`${label}${suffix}: `)).trim()
        const finalVal = answer || String(defaultValue)
        if (!validator) return finalVal
        const err = validator(finalVal)
        if (!err) return finalVal
        stdout.write(`  输入无效：${err}\n`)
      }
    }

    const llmUrl = await ask(
      '1/9 OpenAI 兼容 API 基地址 (llm.baseUrl)',
      initial.llmUrl ?? 'https://api.openai.com/v1',
      (v) => (/^https?:\/\//i.test(v) ? null : '请输入以 http:// 或 https:// 开头的地址')
    )
    const llmModel = await ask(
      '2/9 LLM 模型名 (llm.model)',
      initial.llmModel ?? 'gpt-4.1-mini',
      (v) => (v.length > 0 ? null : '模型名不能为空')
    )
    const llmKey = await ask(
      '3/9 LLM API 密钥 (写入 .env 的 MSS_LLM_API_KEY，留空稍后填写)',
      initial.llmKey ?? ''
    )
    const pipeline = (
      await ask('4/9 剧本流水线 (hybrid | staged | single)', initial.pipeline ?? 'staged', (v) =>
        VALID_PIPELINE.has(v.toLowerCase()) ? null : '仅支持 hybrid / staged / single'
      )
    ).toLowerCase()

    const gpu = (
      await ask(
        '5/9 GPU/硬件编码预设 (auto | intel | nvidia | amd | cpu)',
        initial.gpu ?? 'auto',
        (v) => (VALID_GPU.has(v.toLowerCase()) ? null : '仅支持 auto / intel / nvidia / amd / cpu')
      )
    ).toLowerCase()

    const memory = (
      await ask(
        '6/9 内存规格预设 (standard | low，4–8GB 内存/NAS 选 low)',
        initial.memory ?? 'standard',
        (v) => (VALID_MEMORY.has(v.toLowerCase()) ? null : '仅支持 standard / low')
      )
    ).toLowerCase()

    const defaultFps = initial.fps ?? (memory === 'low' ? 30 : 60)
    const fps = Number.parseInt(
      await ask('7/9 导出帧率 (30 | 60)', String(defaultFps), (v) =>
        VALID_FPS.has(Number.parseInt(v, 10)) ? null : '仅支持 30 或 60'
      ),
      10
    )

    const tts = (
      await ask(
        '8/9 语音合成 TTS 引擎 (none | irodori | gpt-sovits)',
        initial.tts ?? 'none',
        (v) => (VALID_TTS.has(v.toLowerCase()) ? null : '仅支持 none / irodori / gpt-sovits')
      )
    ).toLowerCase()

    let ttsUrl = initial.ttsUrl ?? ''
    if (tts !== 'none') {
      const defaultTtsUrl =
        ttsUrl || (tts === 'irodori' ? 'http://127.0.0.1:8088' : 'http://127.0.0.1:9880')
      ttsUrl = await ask('    TTS 服务地址 (tts.apiBaseUrl)', defaultTtsUrl, (v) =>
        /^https?:\/\//i.test(v) ? null : '请输入以 http:// 或 https:// 开头的地址'
      )
    }

    const cloudOnlyRaw = await ask(
      '9/9 纯云端零本地资源模式 cloudOnly (true | false)',
      String(initial.cloudOnly ?? true),
      (v) =>
        ['true', 'false', '1', '0', 'yes', 'no', 'y', 'n'].includes(v.toLowerCase())
          ? null
          : '请输入 true 或 false'
    )
    const cloudOnly = parseBoolOption(cloudOnlyRaw, 'cloudOnly')

    const apiKey = await ask(
      '可选：服务 Bearer 鉴权密钥 (写入 .env 的 MSS_API_KEY，留空不鉴权)',
      initial.apiKey ?? ''
    )

    return {
      ...initial,
      llmUrl,
      llmModel,
      llmKey,
      pipeline,
      gpu,
      memory,
      fps,
      tts,
      ttsUrl,
      cloudOnly,
      apiKey
    }
  } finally {
    rl.close()
  }
}

export async function runInitConfig(argv, cwd = process.cwd()) {
  const parsed = parseCliArgs(argv)
  if (parsed.help) {
    stdout.write(USAGE)
    return { status: 'help' }
  }

  let finalCfg
  if (parsed.nonInteractive) {
    const memory = parsed.memory ?? 'standard'
    const tts = parsed.tts ?? 'none'
    finalCfg = {
      gpu: parsed.gpu ?? 'auto',
      memory,
      fps: parsed.fps ?? (memory === 'low' ? 30 : 60),
      llmUrl: parsed.llmUrl ?? 'https://api.openai.com/v1',
      llmModel: parsed.llmModel ?? 'gpt-4.1-mini',
      llmKey: parsed.llmKey ?? '',
      pipeline: parsed.pipeline ?? 'staged',
      tts,
      ttsUrl:
        parsed.ttsUrl ?? (tts === 'irodori' ? 'http://127.0.0.1:8088' : 'http://127.0.0.1:9880'),
      cloudOnly: parsed.cloudOnly ?? true,
      apiKey: parsed.apiKey ?? '',
      outConfig: parsed.outConfig,
      outEnv: parsed.outEnv,
      force: parsed.force
    }
  } else {
    finalCfg = await promptInteractive(parsed)
  }

  validateFinalOptions(finalCfg)

  const outConfigPath = path.resolve(cwd, finalCfg.outConfig)
  const outEnvPath = path.resolve(cwd, finalCfg.outEnv)

  const existing = []
  if (fs.existsSync(outConfigPath)) existing.push(outConfigPath)
  if (fs.existsSync(outEnvPath)) existing.push(outEnvPath)
  if (existing.length > 0 && !finalCfg.force) {
    throw new Error(
      `Target file(s) already exist:\n  - ${existing.join('\n  - ')}\nPass --force to overwrite.`
    )
  }

  fs.mkdirSync(path.dirname(outConfigPath), { recursive: true })
  fs.mkdirSync(path.dirname(outEnvPath), { recursive: true })

  const yamlContent = buildConfigYaml(finalCfg)
  const envContent = buildDotEnv(finalCfg)

  fs.writeFileSync(outConfigPath, yamlContent, 'utf8')
  fs.writeFileSync(outEnvPath, envContent, 'utf8')
  if (process.platform !== 'win32') {
    fs.chmodSync(outEnvPath, 0o600)
  }

  stdout.write('\n配置生成完成 / Configuration generated:\n')
  stdout.write(`  config.yaml : ${outConfigPath}\n`)
  stdout.write(
    `  .env        : ${outEnvPath}${process.platform !== 'win32' ? ' (chmod 600)' : ''}\n`
  )
  stdout.write(
    `  profile     : gpu=${finalCfg.gpu}, memory=${finalCfg.memory}, fps=${finalCfg.fps}, pipeline=${finalCfg.pipeline}, tts=${finalCfg.tts}, cloudOnly=${finalCfg.cloudOnly}\n`
  )
  stdout.write(
    `  secrets     : MSS_LLM_API_KEY=${finalCfg.llmKey ? '[set]' : '[empty]'}, MSS_API_KEY=${finalCfg.apiKey ? '[set]' : '[empty]'}\n`
  )
  if (!finalCfg.llmKey) {
    stdout.write('\n提示：请在 .env 中填入 MSS_LLM_API_KEY 后再调用 AI 剧本生成接口。\n')
  }

  return { status: 'ok', outConfigPath, outEnvPath }
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isEntrypoint) {
  runInitConfig(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`[init-config] Error: ${err instanceof Error ? err.message : err}\n`)
    process.exitCode = 1
  })
}
