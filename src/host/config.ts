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

const TtsEmotionSchema = z.object({
  /** 剧本 Talk.data.emotion 命中的标签；未命中时使用角色默认参考音频 */
  emotion: z.string(),
  refAudioPath: z.string().default(''),
  /** 多参考音频（Irodori 的 ref_wavs）；非空时优先于 refAudioPath */
  refAudioPaths: z.array(z.string()).default([]),
  /** 情绪专用 LoRA adapter；留空沿用角色默认 */
  loraAdapter: z.string().default(''),
  /** 情绪表演描述；留空沿用角色默认 caption */
  caption: z.string().default(''),
  /** 情绪专用语速；不填沿用角色/全局语速 */
  speed: z.number().optional(),
  numSteps: z.number().int().positive().optional()
})

const TtsCharacterSchema = z.object({
  characterName: z.string(),
  refAudioPath: z.string().default(''),
  /** 多参考音频；非空时 Irodori 发送 ref_wavs 并省略 ref_wav */
  refAudioPaths: z.array(z.string()).default([]),
  promptText: z.string().default(''),
  promptLang: z.string().default('ja'),
  gptWeightsPath: z.string().default(''),
  sovitsWeightsPath: z.string().default(''),
  /** Irodori：PEFT LoRA adapter 目录（服务端路径） */
  loraAdapter: z.string().default(''),
  /** Irodori：表演描述 */
  caption: z.string().default(''),
  /** Irodori：角色默认语速 */
  speed: z.number().optional(),
  numSteps: z.number().int().positive().optional(),
  /** Irodori：情绪标签 -> 参考音频/caption/speed */
  emotions: z.array(TtsEmotionSchema).default([])
})

const ServerSchema = z.object({
  port: z.number().default(9881),
  host: z.string().default('0.0.0.0')
})

const VideoSchema = z.object({
  width: z.number().default(1280),
  height: z.number().default(720),
  fps: z.number().default(30),
  crf: z.number().default(23),
  renderScale: z.number().default(1.5),
  audioBitrate: z.string().default('128k'),
  encoder: z.string().default('auto'),
  watermark: z.boolean().default(true),
  /** 自定义水印文字：显示在自带水印下一行；空 = 不追加 */
  watermarkText: z.string().default(''),
  exportMode: z.enum(['record', 'fast']).default('record'),
  exportBitrate: z.number().default(12_000_000),
  exportFastEncoder: z.enum(['auto', 'webcodecs', 'frames']).default('auto'),
  /** fast 模式的编码帧率上限（≤ video.fps）；动画仍按 video.fps 推进 */
  fastFps: z.number().default(30),
  /**
   * record 收尾成片体积上限（MiB）。收尾预估（录制视频 + 音轨）超出上限 2% 时，
   * 按精确码率重编码视频压回上限（分辨率与时间戳不变）；0 = 不限制。
   */
  recordTargetSizeMb: z.number().default(0),
  /**
   * 表演续演间隔（秒，默认 0 = 关闭续演）。角色动作播完后的行为：
   * - 0：保持动作结束时的姿势（不回落站立），之后只有呼吸与眨眼
   * - >0：按该间隔（±25% 抖动）再接一个同情绪族手势，间隔内保持当前姿态
   * 关闭是"动作尽可能少"的默认舞台风格；想要早期"连续表演"效果再调大。
   */
  idleChainGapSec: z.number().default(0),
  /**
   * TTS 与画面渲染的调度方式：
   * - serial（默认）：先串行合成完全部语音，再开始录制/渲染，避免 TTS 推理与
   *   WebGL/编码争抢 CPU/GPU；录制模式推荐
   * - concurrent：边渲染边合成，总耗时更短，但两条流水线会并行争资源
   */
  ttsMode: z.enum(['serial', 'concurrent']).default('serial')
})

const RenderSchema = z.object({
  workers: z.number().default(2),
  workerRecycleExports: z.number().default(5),
  browserChannels: z.array(z.string()).default(['msedge', 'chrome', 'chromium']),
  browserExecutablePath: z.string().default(''),
  extraChromeArgs: z.string().default(''),
  linuxGpuAngle: z.boolean().default(true),
  /** 派发导出任务前要求的最小可用内存（MB）；0 = 关闭护栏 */
  minFreeMemoryMb: z.number().default(0)
})

const PathsSchema = z.object({
  output: z.string().default('apifile'),
  resources: z.string().default('resources'),
  webRenderer: z.string().default('out/webrenderer')
})

const IrodoriSchema = z.object({
  model: z.string().default('irodori-tts'),
  /** 渲染端按 WAV 头计算语音时长，当前只支持 wav */
  responseFormat: z.enum(['wav']).default('wav'),
  numSteps: z.number().int().positive().default(40),
  cfgScaleText: z.number().default(3.0),
  cfgScaleCaption: z.number().default(3.0),
  cfgScaleSpeaker: z.number().default(5.0),
  durationScale: z.number().default(1.0),
  chunkingEnabled: z.boolean().default(true),
  chunkMinChars: z.number().int().positive().default(80),
  /** -1 = 每次随机；>=0 时原样发送 */
  seed: z.number().int().default(-1),
  /** 全局默认 LoRA adapter（角色未填时使用） */
  defaultLoraAdapter: z.string().default(''),
  /** 全局默认 caption（角色未填时使用） */
  defaultCaption: z.string().default(''),
  /** 内置 AI 提示词可用的情绪标签；角色 emotions 里的标签也会自动并入 */
  emotionLabels: z.array(z.string()).default([])
})

const TtsSchema = z.object({
  enabled: z.boolean().default(true),
  /** gpt-sovits：/tts + 权重租约；irodori：/v1/audio/speech + 每请求 LoRA/参考音频 */
  provider: z.enum(['gpt-sovits', 'irodori']).default('gpt-sovits'),
  apiBaseUrl: z.string().default('http://127.0.0.1:9880'),
  /** 单次 TTS HTTP 请求超时（毫秒） */
  timeoutMs: z.number().default(120_000),
  defaultRefAudioPath: z.string().default(''),
  defaultPromptText: z.string().default(''),
  promptLang: z.string().default('ja'),
  textLang: z.string().default('ja'),
  speedFactor: z.number().default(1.0),
  gptWeightsPath: z.string().default(''),
  sovitsWeightsPath: z.string().default(''),
  irodori: IrodoriSchema.default(IrodoriSchema.parse({})),
  characters: z.array(TtsCharacterSchema).default([])
})

/**
 * BGM 播放设置：以资源根下的 audio/bgm/bgm.yaml 为准（从 config.yaml 的 bgm 节搬出来独立维护），
 * 该文件不存在时回落到 config.yaml 的 bgm 节，旧配置照常可用。
 */
const BgmSchema = z.object({
  enabled: z.boolean().default(true),
  path: z.string().default('audio/bgm/bg1.mp3'),
  volume: z.number().default(0.2)
})

/**
 * 宿主内置 AI 剧本生成。
 *
 * 密钥只从 `apiKeyEnv` 指定的环境变量读取，不写进 config.yaml；
 * `baseUrl` 兼容任何 OpenAI Chat Completions 服务（官方、new-api、Ollama、vLLM 等）。
 */
const LlmPersonaSchema = z.object({
  name: z.string(),
  prompt: z.string().default(''),
  aliases: z.array(z.string()).default([]),
  group: z.string().default('')
})

const LlmSchema = z.object({
  enabled: z.boolean().default(true),
  baseUrl: z.string().default('https://api.openai.com/v1'),
  apiKeyEnv: z.string().default('MSS_LLM_API_KEY'),
  model: z.string().default('gpt-4.1-mini'),
  temperature: z.number().default(0.85),
  maxTokens: z.number().default(8192),
  timeoutMs: z.number().default(120_000),
  retries: z.number().default(2),
  /** JSON 校验失败后带错误信息让模型重写的轮数 */
  repairRounds: z.number().default(2),
  /**
   * 剧本生成流水线：
   * - staged（默认）：选角 → 只写台词（完整人设）→ 单独设计动作/表情/背景
   * - single：一次调用直接写完整剧本，省调用次数
   * chat 模式始终走 single。
   */
  pipeline: z.enum(['single', 'staged']).default('staged'),
  /** response_format=json_object：auto = 先带后回退，on = 必须，off = 不发送 */
  jsonMode: z.enum(['auto', 'on', 'off']).default('auto'),
  /** 生成后把中文台词翻译成日文 ttsText（TTS 参考音频通常为日语） */
  translateForTts: z.boolean().default(true),
  /** 目标成片时长（分钟），写进提示词，不截断模型输出 */
  targetMinutes: z.number().default(3),
  /** 覆盖内置系统提示词；留空使用内置模板 */
  systemPrompt: z.string().default(''),
  /**
   * 额外请求体字段，原样并入 OpenAI Chat Completions 请求。
   * 例如关闭推理模型的思考：{"thinking":{"type":"disabled"}}；
   * 只对支持这些字段的服务生效，留空不影响兼容性。
   */
  extraBody: z.record(z.string(), z.unknown()).default({}),
  /** 角色人格目录：读取其中的 *.md / *.txt，文件名或 frontmatter name 作为角色名 */
  personaDirs: z.array(z.string()).default([]),
  personas: z.array(LlmPersonaSchema).default([])
})

/**
 * 云端资源获取（moesekai / pjsk.moe）。
 *
 * 默认指向公开的 Moesekai 资源站；`indexBase` 是模型索引目录，
 * `libraryBase` 是剧情库目录（模型包、动作包），`assetBase` 是背景等普通资产。
 */
const AssetsSchema = z.object({
  source: z.enum(['moesekai']).default('moesekai'),
  region: z.enum(['jp', 'cn', 'tw', 'kr', 'en']).default('jp'),
  indexBase: z.string().default('https://assets.pjsk.moe/sekai-extra-assets/sekai-live2d/'),
  libraryBase: z.string().default('https://assets.pjsk.moe/sekai-extra-assets/sekai-story/ripper/'),
  /** 留空时按 region 推导 https://storage.exmeaning.com/sekai-<region>-assets */
  assetBase: z.string().default(''),
  /**
   * PJSK 官方曲名索引（musicSoundTracks.json / musicSoundTrackCategories.json）所在目录。
   * fetch:media 用它把 bgm00003 这类文件名补成可读曲名；留空用 Sekai-World jp master DB。
   */
  soundtrackBase: z
    .string()
    .default('https://cdn.jsdelivr.net/gh/Sekai-World/sekai-master-db-diff@master/'),
  /** 动作包等中间文件缓存；可断点续传，重复拉同一角色不再下载 */
  cacheDir: z.string().default('cache/moesekai'),
  concurrency: z.number().default(4),
  timeoutMs: z.number().default(180_000),
  retries: z.number().default(3)
})

/**
 * 读取 bgm.yaml（BGM 的独立配置文件）。
 *
 * 文件缺失返回 null，由调用方回落 config.yaml 的 bgm 节；
 * 文件存在但内容不合法时直接抛错——配置写错要立刻可见，不能静默用错值。
 */
export function readBgmManifest(resourcesDir: string): BgmSettings | null {
  const manifestPath = path.join(resourcesDir, 'audio', 'bgm', 'bgm.yaml')
  if (!fs.existsSync(manifestPath)) return null

  const text = fs.readFileSync(manifestPath, 'utf-8')
  // 空文件（刚建好还没填）按全默认处理，不算配置错误
  const raw = text.trim() === '' ? {} : yaml.load(text)
  if (raw !== null && raw !== undefined && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error(`bgm.yaml must be a key-value mapping: ${manifestPath}`)
  }
  const settings = BgmSchema.parse(raw ?? {})
  settings.volume = Math.min(Math.max(settings.volume, 0), 1)
  return settings
}

export type TtsCharacter = z.infer<typeof TtsCharacterSchema>
export type VideoSettings = z.infer<typeof VideoSchema>
export type TtsSettings = z.infer<typeof TtsSchema>
export type BgmSettings = z.infer<typeof BgmSchema>
export type LlmPersona = z.infer<typeof LlmPersonaSchema>
export type LlmSettings = z.infer<typeof LlmSchema>
export type AssetsSettings = z.infer<typeof AssetsSchema>

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
  llm: LlmSettings
  assets: AssetsSettings
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
  if (env.MSS_VIDEO_WATERMARK_TEXT !== undefined) {
    config.video.watermarkText = env.MSS_VIDEO_WATERMARK_TEXT
  }
  if (env.MSS_EXPORT_MODE) {
    const mode = env.MSS_EXPORT_MODE.toLowerCase()
    if (mode === 'record' || mode === 'fast') config.video.exportMode = mode
  }
  if (env.MSS_EXPORT_BITRATE) {
    const v = parseInt(env.MSS_EXPORT_BITRATE, 10)
    if (Number.isFinite(v) && v > 0) config.video.exportBitrate = v
  }
  if (env.MSS_EXPORT_FAST_ENCODER) {
    const v = env.MSS_EXPORT_FAST_ENCODER.toLowerCase()
    if (v === 'auto' || v === 'webcodecs' || v === 'frames') config.video.exportFastEncoder = v
  }
  if (env.MSS_FAST_FPS) {
    const v = parseInt(env.MSS_FAST_FPS, 10)
    if (Number.isFinite(v) && v >= 1) config.video.fastFps = v
  }
  if (env.MSS_IDLE_CHAIN_GAP_SEC) {
    const v = parseFloat(env.MSS_IDLE_CHAIN_GAP_SEC)
    if (Number.isFinite(v) && v >= 0) config.video.idleChainGapSec = v
  }
  if (env.MSS_TTS_MODE) {
    const mode = env.MSS_TTS_MODE.toLowerCase()
    if (mode === 'serial' || mode === 'concurrent') config.video.ttsMode = mode
  }

  // tts
  if (env.MSS_TTS_ENABLED !== undefined) {
    config.tts.enabled = !['0', 'false', 'no', 'off'].includes(env.MSS_TTS_ENABLED.toLowerCase())
  }
  if (env.MSS_TTS_PROVIDER) {
    const provider = env.MSS_TTS_PROVIDER.toLowerCase()
    if (provider === 'gpt-sovits' || provider === 'irodori') config.tts.provider = provider
  }
  if (env.MSS_TTS_API_BASE_URL) config.tts.apiBaseUrl = env.MSS_TTS_API_BASE_URL
  if (env.MSS_TTS_TIMEOUT_MS) {
    const v = parseInt(env.MSS_TTS_TIMEOUT_MS, 10)
    if (Number.isFinite(v) && v > 0) config.tts.timeoutMs = v
  }
  if (env.MSS_IRODORI_MODEL) config.tts.irodori.model = env.MSS_IRODORI_MODEL
  if (env.MSS_IRODORI_NUM_STEPS) {
    const v = parseInt(env.MSS_IRODORI_NUM_STEPS, 10)
    if (Number.isFinite(v) && v > 0) config.tts.irodori.numSteps = v
  }
  if (env.MSS_RECORD_TARGET_SIZE_MB) {
    const v = parseInt(env.MSS_RECORD_TARGET_SIZE_MB, 10)
    if (Number.isFinite(v) && v >= 0) config.video.recordTargetSizeMb = v
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
  if (env.MSS_MIN_FREE_MEMORY_MB) {
    const v = parseInt(env.MSS_MIN_FREE_MEMORY_MB, 10)
    if (Number.isFinite(v) && v >= 0) config.render.minFreeMemoryMb = v
  }

  // llm
  if (env.MSS_LLM_ENABLED !== undefined) {
    config.llm.enabled = !['0', 'false', 'no', 'off'].includes(env.MSS_LLM_ENABLED.toLowerCase())
  }
  if (env.MSS_LLM_BASE_URL) config.llm.baseUrl = env.MSS_LLM_BASE_URL
  if (env.MSS_LLM_API_KEY_ENV) config.llm.apiKeyEnv = env.MSS_LLM_API_KEY_ENV
  if (env.MSS_LLM_MODEL) config.llm.model = env.MSS_LLM_MODEL
  if (env.MSS_LLM_TEMPERATURE) {
    const v = parseFloat(env.MSS_LLM_TEMPERATURE)
    if (Number.isFinite(v)) config.llm.temperature = v
  }
  if (env.MSS_LLM_MAX_TOKENS) {
    const v = parseInt(env.MSS_LLM_MAX_TOKENS, 10)
    if (Number.isFinite(v) && v > 0) config.llm.maxTokens = v
  }
  if (env.MSS_LLM_TIMEOUT_MS) {
    const v = parseInt(env.MSS_LLM_TIMEOUT_MS, 10)
    if (Number.isFinite(v) && v > 0) config.llm.timeoutMs = v
  }
  if (env.MSS_LLM_RETRIES) {
    const v = parseInt(env.MSS_LLM_RETRIES, 10)
    if (Number.isFinite(v) && v >= 0) config.llm.retries = v
  }
  if (env.MSS_LLM_REPAIR_ROUNDS) {
    const v = parseInt(env.MSS_LLM_REPAIR_ROUNDS, 10)
    if (Number.isFinite(v) && v >= 0) config.llm.repairRounds = v
  }
  if (env.MSS_LLM_PIPELINE) {
    const v = env.MSS_LLM_PIPELINE.toLowerCase()
    if (v === 'single' || v === 'staged') config.llm.pipeline = v
  }
  if (env.MSS_LLM_JSON_MODE) {
    const v = env.MSS_LLM_JSON_MODE.toLowerCase()
    if (v === 'auto' || v === 'on' || v === 'off') config.llm.jsonMode = v
  }
  if (env.MSS_LLM_TRANSLATE !== undefined) {
    config.llm.translateForTts = !['0', 'false', 'no', 'off'].includes(
      env.MSS_LLM_TRANSLATE.toLowerCase()
    )
  }
  if (env.MSS_LLM_TARGET_MINUTES) {
    const v = parseFloat(env.MSS_LLM_TARGET_MINUTES)
    if (Number.isFinite(v) && v > 0) config.llm.targetMinutes = v
  }
  if (env.MSS_LLM_SYSTEM_PROMPT) config.llm.systemPrompt = env.MSS_LLM_SYSTEM_PROMPT
  if (env.MSS_LLM_EXTRA_BODY) {
    try {
      const parsed = JSON.parse(env.MSS_LLM_EXTRA_BODY) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config.llm.extraBody = parsed as Record<string, unknown>
      }
    } catch {
      // 非法 JSON 忽略，保持配置里的值
    }
  }

  // assets
  if (env.MSS_ASSETS_REGION) {
    const v = env.MSS_ASSETS_REGION.toLowerCase()
    if (v === 'jp' || v === 'cn' || v === 'tw' || v === 'kr' || v === 'en') {
      config.assets.region = v as AssetsSettings['region']
    }
  }
  if (env.MSS_ASSETS_INDEX_BASE) config.assets.indexBase = env.MSS_ASSETS_INDEX_BASE
  if (env.MSS_ASSETS_LIBRARY_BASE) config.assets.libraryBase = env.MSS_ASSETS_LIBRARY_BASE
  if (env.MSS_ASSETS_BASE) config.assets.assetBase = env.MSS_ASSETS_BASE
  if (env.MSS_ASSETS_SOUNDTRACK_BASE) {
    config.assets.soundtrackBase = env.MSS_ASSETS_SOUNDTRACK_BASE
  }
  if (env.MSS_ASSETS_CACHE_DIR) config.assets.cacheDir = env.MSS_ASSETS_CACHE_DIR
  if (env.MSS_ASSETS_CONCURRENCY) {
    const v = parseInt(env.MSS_ASSETS_CONCURRENCY, 10)
    if (Number.isFinite(v) && v >= 1 && v <= 32) config.assets.concurrency = v
  }
  if (env.MSS_ASSETS_TIMEOUT_MS) {
    const v = parseInt(env.MSS_ASSETS_TIMEOUT_MS, 10)
    if (Number.isFinite(v) && v > 0) config.assets.timeoutMs = v
  }
  if (env.MSS_ASSETS_RETRIES) {
    const v = parseInt(env.MSS_ASSETS_RETRIES, 10)
    if (Number.isFinite(v) && v >= 0) config.assets.retries = v
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
    llm: LlmSchema.parse(raw.llm ?? {}),
    assets: AssetsSchema.parse(raw.assets ?? {}),
    logLevel: z
      .string()
      .default('info')
      .parse(raw.logLevel ?? 'info')
  }

  applyEnvOverrides(config)

  const paths = {
    output: path.resolve(rootDir, pathsRaw.output),
    resources: path.resolve(rootDir, pathsRaw.resources),
    webRenderer: path.resolve(rootDir, pathsRaw.webRenderer)
  }

  // 角色人格目录、资源基地址等相对路径以仓库根为基准
  config.llm.personaDirs = config.llm.personaDirs.map((p) => path.resolve(rootDir, p))
  config.llm.baseUrl = config.llm.baseUrl.replace(/\/+$/, '')
  config.assets.cacheDir = path.resolve(rootDir, config.assets.cacheDir)
  if (config.assets.assetBase) {
    config.assets.assetBase = config.assets.assetBase.replace(/\/+$/, '')
  }

  // BGM 设置以资源根下的 bgm.yaml 为准（从 config.yaml 的 bgm 节搬出来独立维护），
  // 文件不存在时沿用 config.yaml 的 bgm 节，行为与旧版一致。
  const bgmFromManifest = readBgmManifest(paths.resources)
  if (bgmFromManifest) {
    config.bgm = bgmFromManifest
  }

  return {
    ...config,
    rootDir,
    paths
  }
}
