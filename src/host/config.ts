import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { z } from 'zod'

/**
 * 宿主统一配置。
 *
 * 优先级：MSS_* 环境变量 > config.yaml > 内置默认值（schema default）。
 * 配置样例见仓库根的 config.example.yaml。
 */

const TtsCharacterSchema = z.object({
  characterName: z.string(),
  refAudioPath: z.string().default(''),
  promptText: z.string().default(''),
  promptLang: z.string().default('ja'),
  gptWeightsPath: z.string().default(''),
  sovitsWeightsPath: z.string().default('')
})

const ServerSchema = z.object({
  port: z.number().default(9881),
  host: z.string().default('0.0.0.0')
})

const VideoSchema = z.object({
  width: z.number().default(1280),
  height: z.number().default(720),
  fps: z.number().default(30),
  crf: z.number().default(28),
  renderScale: z.number().default(1.5),
  audioBitrate: z.string().default('128k'),
  encoder: z.string().default('auto'),
  watermark: z.boolean().default(true)
})

const RenderSchema = z.object({
  workers: z.number().default(2),
  workerRecycleExports: z.number().default(5),
  browserChannels: z.array(z.string()).default(['msedge', 'chrome', 'chromium']),
  browserExecutablePath: z.string().default(''),
  extraChromeArgs: z.string().default(''),
  linuxGpuAngle: z.boolean().default(true)
})

const PathsSchema = z.object({
  output: z.string().default('apifile'),
  resources: z.string().default('resources'),
  webRenderer: z.string().default('out/webrenderer')
})

const TtsSchema = z.object({
  enabled: z.boolean().default(true),
  apiBaseUrl: z.string().default('http://127.0.0.1:9880'),
  defaultRefAudioPath: z.string().default(''),
  defaultPromptText: z.string().default(''),
  promptLang: z.string().default('ja'),
  textLang: z.string().default('ja'),
  speedFactor: z.number().default(1.0),
  gptWeightsPath: z.string().default(''),
  sovitsWeightsPath: z.string().default(''),
  characters: z.array(TtsCharacterSchema).default([])
})

const BgmSchema = z.object({
  enabled: z.boolean().default(true),
  path: z.string().default('audio/bgm/bg1.mp3'),
  volume: z.number().default(0.2)
})

export type TtsCharacter = z.infer<typeof TtsCharacterSchema>
export type VideoSettings = z.infer<typeof VideoSchema>
export type TtsSettings = z.infer<typeof TtsSchema>
export type BgmSettings = z.infer<typeof BgmSchema>

export interface HostConfig {
  rootDir: string
  server: z.infer<typeof ServerSchema>
  video: VideoSettings
  render: z.infer<typeof RenderSchema>
  /** paths 已解析为绝对路径 */
  paths: {
    output: string
    resources: string
    webRenderer: string
  }
  tts: TtsSettings
  bgm: BgmSettings
  logLevel: string
}

/**
 * 计算仓库根目录：优先从编译产物位置推导（out-host/host → 根目录），
 * 推导失败时回退到 process.cwd()。
 */
function resolveRootDir(): string {
  const derived = path.resolve(__dirname, '..', '..')
  if (fs.existsSync(path.join(derived, 'package.json'))) {
    return derived
  }
  return path.resolve(process.cwd())
}

function readYamlConfig(rootDir: string): Record<string, unknown> {
  const configPath = path.join(rootDir, 'config.yaml')
  if (!fs.existsSync(configPath)) {
    return {}
  }
  try {
    const loaded = yaml.load(fs.readFileSync(configPath, 'utf-8')) as unknown
    return (loaded && typeof loaded === 'object' ? loaded : {}) as Record<string, unknown>
  } catch (err) {
    throw new Error(`Failed to parse config.yaml: ${err instanceof Error ? err.message : err}`)
  }
}

function applyEnvOverrides(config: Omit<HostConfig, 'rootDir' | 'paths'>): void {
  const env = process.env

  // server
  if (env.MSS_PORT) {
    const port = parseInt(env.MSS_PORT, 10)
    if (Number.isFinite(port)) config.server.port = port
  }
  if (env.MSS_HOST) config.server.host = env.MSS_HOST

  // video
  if (env.MSS_FFMPEG_ENCODER) config.video.encoder = env.MSS_FFMPEG_ENCODER.toLowerCase()
  if (env.MSS_VIDEO_WIDTH) {
    const v = parseInt(env.MSS_VIDEO_WIDTH, 10)
    if (Number.isFinite(v)) config.video.width = v
  }
  if (env.MSS_VIDEO_HEIGHT) {
    const v = parseInt(env.MSS_VIDEO_HEIGHT, 10)
    if (Number.isFinite(v)) config.video.height = v
  }
  if (env.MSS_VIDEO_FPS) {
    const v = parseInt(env.MSS_VIDEO_FPS, 10)
    if (Number.isFinite(v)) config.video.fps = v
  }
  if (env.MSS_VIDEO_CRF) {
    const v = parseInt(env.MSS_VIDEO_CRF, 10)
    if (Number.isFinite(v)) config.video.crf = v
  }
  if (env.MSS_VIDEO_WATERMARK !== undefined) {
    config.video.watermark = !['0', 'false', 'no', 'off'].includes(
      env.MSS_VIDEO_WATERMARK.toLowerCase()
    )
  }

  // render
  if (env.MSS_WORKERS) {
    const v = parseInt(env.MSS_WORKERS, 10)
    if (Number.isFinite(v)) config.render.workers = Math.max(1, v)
  }
  if (env.MSS_WORKER_RECYCLE_EXPORTS) {
    const v = parseInt(env.MSS_WORKER_RECYCLE_EXPORTS, 10)
    if (Number.isFinite(v)) config.render.workerRecycleExports = Math.max(0, v)
  }
  if (env.MSS_BROWSER_CHANNELS) {
    config.render.browserChannels = env.MSS_BROWSER_CHANNELS.split(',')
      .map((c) => c.trim())
      .filter(Boolean)
  }
  if (env.MSS_BROWSER_EXECUTABLE) config.render.browserExecutablePath = env.MSS_BROWSER_EXECUTABLE
  if (env.MSS_CHROME_ARGS) config.render.extraChromeArgs = env.MSS_CHROME_ARGS
  if (env.MSS_LINUX_GPU_ANGLE !== undefined) {
    config.render.linuxGpuAngle = !['0', 'false', 'no', 'off'].includes(
      env.MSS_LINUX_GPU_ANGLE.toLowerCase()
    )
  }

  // log
  if (env.MSS_LOG_LEVEL) config.logLevel = env.MSS_LOG_LEVEL
}

export function loadHostConfig(): HostConfig {
  const rootDir = resolveRootDir()
  const raw = readYamlConfig(rootDir)

  const pathsRaw = PathsSchema.parse(raw.paths ?? {})
  // 路径的 env 覆盖在解析为绝对路径前应用
  if (process.env.MSS_OUTPUT_DIR) pathsRaw.output = process.env.MSS_OUTPUT_DIR
  if (process.env.MSS_RESOURCE_DIR) pathsRaw.resources = process.env.MSS_RESOURCE_DIR
  if (process.env.MSS_WEB_RENDERER_DIR) pathsRaw.webRenderer = process.env.MSS_WEB_RENDERER_DIR

  const config: Omit<HostConfig, 'rootDir' | 'paths'> = {
    server: ServerSchema.parse(raw.server ?? {}),
    video: VideoSchema.parse(raw.video ?? {}),
    render: RenderSchema.parse(raw.render ?? {}),
    tts: TtsSchema.parse(raw.tts ?? {}),
    bgm: BgmSchema.parse(raw.bgm ?? {}),
    logLevel: z
      .string()
      .default('info')
      .parse(raw.logLevel ?? 'info')
  }

  applyEnvOverrides(config)

  return {
    ...config,
    rootDir,
    paths: {
      output: path.resolve(rootDir, pathsRaw.output),
      resources: path.resolve(rootDir, pathsRaw.resources),
      webRenderer: path.resolve(rootDir, pathsRaw.webRenderer)
    }
  }
}
