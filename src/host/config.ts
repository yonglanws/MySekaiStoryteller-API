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
  host: z.string().default('0.0.0.0'),
  /** Bearer 鉴权密钥（env: MSST_API_KEY / MSS_API_KEY）；空字符串表示不要求鉴权 */
  apiKey: z.string().default(''),
  /** 是否开启 CORS；省略时由宿主按默认值处理 */
  cors: z.boolean().optional(),
  /** 允许跨域的 Origin 列表；保持 optional 以便未配置时由 MSST_CORS_ORIGINS/MSS_CORS_ORIGINS 生效 */
  corsOrigins: z.array(z.string()).optional()
})

const VideoSchema = z.object({
  width: z.number().default(1280),
  height: z.number().default(720),
  fps: z.number().default(30),
  crf: z.number().default(18),
  renderScale: z.number().default(1.5),
  /** 视频编码 codec：hevc（默认，libx265 或同名硬件编码器）或 h264 */
  codec: z.enum(['hevc', 'h264']).default('hevc'),
  audioBitrate: z.string().default('192k'),
  encoder: z.string().default('auto'),
  watermark: z.boolean().default(true),
  /** 自定义水印文字：显示在自带水印下一行；空 = 不追加 */
  watermarkText: z.string().default(''),
  /**
   * 导出管线：
   * - `'fast'`（默认）：虚拟时钟逐帧渲染，优先 WebCodecs，失败自动回落 frames 管道
   * - `'record'`：@deprecated 已废弃，加载时打印告警并自动回落为 `'fast'`
   */
  exportMode: z.enum(['fast', 'record']).default('fast'),
  /**
   * fast 模式 WebCodecs 视频目标码率（bps）。
   * 1080p 60fps 下默认 5.5 Mbps VBR 可避免转场淡入淡出与字幕边缘产生 16x16 宏块残影，
   * 且低于 maxOutputMbps 上限无需二次压制。
   */
  exportBitrate: z.number().default(5_500_000),
  /**
   * 成品平均视频码率软上限（Mbps，0 = 关闭体积护栏；默认 6.5 Mbps）。
   * 即使 WebCodecs 以 stream-copy 输出（或旧 config.yaml 仍写着 12 Mbps），
   * 超限时宿主也会用 Rust 导出器快速 CRF 重编码，同时确保 BT.709/tv 与合理体积。
   */
  maxOutputMbps: z.number().min(0).default(6.5),
  /** 优先使用原生 Rust 导出器（native/mss-export-rs），缺失或关闭时自动回退 JS FFmpeg 管线 */
  useRustExporter: z.boolean().default(true),
  /** 并行分段导出上限（参考 SekaiStoryExporter --jobs N；1 = 单段） */
  exportJobs: z.number().int().min(1).max(8).default(1),
  exportFastEncoder: z.enum(['auto', 'webcodecs', 'frames']).default('auto'),
  /** fast 模式的编码帧率上限（≤ video.fps）；动画仍按 video.fps 推进 */
  fastFps: z.number().default(30),
  /**
   * @deprecated record 模式已废弃，保留字段仅作配置向后兼容（请改用 video.exportBitrate）
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
   * - concurrent（默认）：边渲染边并发合成语音，端到端耗时最短
   * - serial：先合成完全部语音再开始渲染，避免与 WebGL/编码争抢 CPU/GPU
   */
  ttsMode: z.enum(['concurrent', 'serial']).default('concurrent')
})

const RenderSchema = z.object({
  workers: z.number().default(2),
  /**
   * 同时进行的导出上限（0 = 跟随 workers）。可以保留比并发上限更多的常驻
   * worker 作为热备：某个 worker 崩溃或按次数回收时，不必等新浏览器启动才接单。
   */
  maxConcurrentExports: z.number().default(0),
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
  cfgScaleCaption: z.number().default(3.5),
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
  /** 早期去噪步说话人 K/V 缩放（>1.0 锁住角色底色，留出后续步给 caption/emoji 表达情绪） */
  speakerKvScale: z.number().positive().default(1.15),
  /** speakerKvScale 生效的最小时间步（默认 0.9，仅作用于早期音色形成阶段） */
  speakerKvMinT: z.number().min(0).max(1).default(0.9),
  /** 可选：限制 speakerKvScale 作用的最多层数 */
  speakerKvMaxLayers: z.number().int().positive().optional(),
  /** 音色锁策略：off=依赖 LoRA+speakerKvScale 锁身份并按 emotion 切换参考音频；normal=普通句锁基础参考音频，仅 ttsSpecialScene 解锁 */
  timbreLockMode: z.enum(['normal', 'off']).default('off'),
  /** 特殊场景（ttsSpecialScene=true）时的 cfg_scale_caption 引导强度 */
  specialSceneCfgScaleCaption: z.number().positive().default(4.2),
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

export const DEFAULT_LOCAL_BGM_PATH = 'audio/bgm/bg1.mp3'
export const DEFAULT_CLOUD_BGM_ID = 'bgm00003'
export const DEFAULT_BGM_VOLUME = 0.35

/**
 * cloudOnly=true 时归一化全局 BGM 路径：
 * - 显式 http(s):// URL 与已带 cloud/ 前缀的路径保持原样
 * - 识别到的云端曲目 ID（如 bgm00006、01_an_02）提取为 ID
 * - 其余任意非 cloud/ 本地路径（bg1.mp3、audio/bgm/custom.mp3、绝对本地路径等）统一回落为 bgm00003
 */
export function normalizeCloudOnlyBgmPath(rawPath: string): string {
  const raw = rawPath.trim()
  if (!raw) return DEFAULT_CLOUD_BGM_ID
  if (/^https?:\/\//i.test(raw)) return raw

  const slashNorm = raw
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^resources\//i, '')
    .replace(/^audio\/bgm\//i, '')
  if (slashNorm.toLowerCase().startsWith('cloud/')) {
    return raw
  }

  const lower = slashNorm.toLowerCase()
  if (lower === 'bg1.mp3' || lower === 'bg1') {
    return DEFAULT_CLOUD_BGM_ID
  }

  const base = path.posix.basename(slashNorm)
  const stem = base.replace(/\.[^.]+$/, '')
  if (/^(?:bgm\d+(?:_\d+)?|\d{2}_[a-z]+_\d+|normal_area.*)$/i.test(stem)) {
    return stem
  }

  if (
    !/^(?:[a-z]:[\\/]|\/)/i.test(raw) &&
    !raw.includes('/') &&
    !raw.includes('\\') &&
    !/\.(mp3|wav|ogg|flac|aac|m4a)$/i.test(raw)
  ) {
    return raw
  }

  return DEFAULT_CLOUD_BGM_ID
}

/**
 * BGM 播放设置：以资源根下的 audio/bgm/bgm.yaml 为准（从 config.yaml 的 bgm 节搬出来独立维护），
 * 该文件不存在时回落到 config.yaml 的 bgm 节，旧配置照常可用；cloudOnly=true 时忽略 bgm.yaml，
 * 直接使用 config.yaml 的 bgm 节或默认值。
 */
const BgmSchema = z.object({
  enabled: z.boolean().default(true),
  path: z.string().default(DEFAULT_LOCAL_BGM_PATH),
  volume: z.number().default(DEFAULT_BGM_VOLUME)
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

const RagAdaptiveSchema = z.object({
  /** 绝对相似度下限；低于此值直接返回 0 条，避免注入噪声 */
  minScore: z.number().min(0).max(1).default(0.42),
  /** 高置信阈值；命中高置信条目时动态放大字符预算 */
  highScore: z.number().min(0).max(1).default(0.62),
  /** 相对跌幅截断：丢弃低于 topScore * relativeDropRatio 的候选 */
  relativeDropRatio: z.number().min(0).max(1).default(0.78),
  /** 拐点断崖截断：相邻分差 >= elbowDropDelta 且低于 highScore 时停止 */
  elbowDropDelta: z.number().min(0).max(1).default(0.065),
  minChunks: z.number().int().min(0).default(0),
  maxChunks: z.number().int().min(1).default(12),
  softCharBudget: z.number().int().min(200).default(1800),
  maxCharBudget: z.number().int().min(400).default(4800),
  /** 同一 storyId 最多保留的合并场景数 */
  maxPerStory: z.number().int().min(1).default(2),
  /** 同 scenarioId 相邻行间距 <= mergeAdjacentGap 时合并为连续场景 */
  mergeAdjacentGap: z.number().int().min(0).default(4),
  /** 是否对高分命中块自动向同 scenarioId 前后扩展 ±1 相邻块 */
  expandAdjacentContext: z.boolean().default(true)
})

const RagRerankSchema = z.object({
  enabled: z.boolean().default(true),
  model: z.string().default('qwen3-reranker-8b'),
  /** 留空依次继承 llm.rag.baseUrl -> llm.baseUrl */
  baseUrl: z.string().default(''),
  /** 留空依次继承 llm.rag.apiKeyEnv -> llm.apiKeyEnv */
  apiKeyEnv: z.string().default(''),
  /** 拼接到 baseUrl 后的重排路径（默认 /rerank） */
  endpointPath: z.string().default('/rerank'),
  /** 进入二阶段 Cross-Encoder 重排的 RRF 候选池上限 */
  candidatePool: z.number().int().min(1).max(128).default(32),
  /** 向重排 API 请求返回的 top_n（默认与 candidatePool 一致） */
  topN: z.number().int().min(1).max(128).default(32),
  timeoutMs: z.number().int().positive().default(30_000),
  /** 留空自动使用 PJSK 领域默认重排指令 */
  instruction: z.string().default('')
})

const RagSchema = z.object({
  enabled: z.boolean().default(true),
  /** 留空时自动继承 llm.baseUrl */
  baseUrl: z.string().default(''),
  /** 留空时自动继承 llm.apiKeyEnv */
  apiKeyEnv: z.string().default(''),
  /** OpenAI 兼容 /embeddings 模型名（默认 qwen3-embedding-8b） */
  model: z.string().default('qwen3-embedding-8b'),
  /** 0 = 由服务端决定维度，仅 >0 时在请求体中发送 dimensions */
  dimensions: z.number().int().min(0).default(0),
  /** 查询前缀指令；留空时 Qwen3-Embedding 自动使用 PJSK 领域指令，非空则显式覆盖 */
  queryInstruct: z.string().default(''),
  timeoutMs: z.number().int().positive().default(30_000),
  batchSize: z.number().int().min(1).max(128).default(32),
  /** 磁盘向量与增量 chunkHash 缓存目录（相对仓库根） */
  cacheDir: z.string().default('cache/rag'),
  /** Embedding API 不可用或关闭时自动回落 BM25+CJK-bigram 词法检索 */
  fallbackLexical: z.boolean().default(true),
  /** sekai-story-search 数据集根 URL（留空禁用远程语料） */
  sekaiStorySearchUrl: z
    .string()
    .default('https://assets.pjsk.moe/sekai-extra-assets/sekai-story-search'),
  /** sekai-story-search 服务器语种 */
  server: z.enum(['cn', 'jp', 'tw', 'kr', 'en']).default('cn'),
  /** 本地 PJSK 官方剧情目录（默认扫描 cache/semantic-build） */
  localDirs: z.array(z.string()).default(['cache/semantic-build']),
  /** 是否把完整角色人设 Markdown 分节纳入世界观/设定检索 */
  includePersonas: z.boolean().default(true),
  rerank: RagRerankSchema.default(RagRerankSchema.parse({})),
  adaptive: RagAdaptiveSchema.default(RagAdaptiveSchema.parse({}))
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
   * - staged（默认）：选角 → 只写台词（完整人设）→ 并行声演/舞台 + 演技设计
   * - hybrid / agent：统一三段式上下文隔离 + 工具驱动流水线（Phase 1 只读工具探索锁定规划 → Phase 2 丢弃工具历史纯台词+人设Critic → Phase 3 并行编译 + 轻量导演终审）
   * - single：一次调用直接写完整剧本，省调用次数
   * chat 模式始终走 single。
   */
  pipeline: z.enum(['single', 'staged', 'agent', 'hybrid']).default('staged'),
  /** Agentic 模式下允许的最大工具调用/迭代步数 */
  agentMaxSteps: z.number().int().min(2).max(40).default(16),
  /** response_format=json_object：auto = 先带后回退，on = 必须，off = 不发送 */
  jsonMode: z.enum(['auto', 'on', 'off']).default('auto'),
  /** 生成后把中文台词翻译成日文 ttsText（TTS 参考音频通常为日语） */
  translateForTts: z.boolean().default(true),
  /** 是否启用反套路台词质检与条件润色 */
  polishDialogue: z.boolean().default(true),
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
  personas: z.array(LlmPersonaSchema).default([]),
  /** 自适应语义 RAG（qwen3-embedding-8b + qwen3-reranker-8b 重排 + SQ8 磁盘缓存 + 词法回退） */
  rag: RagSchema.default(RagSchema.parse({}))
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
  retries: z.number().default(3),
  /**
   * 云端资源目录：背景/BGM/Live2D 模型不要求本地预下载或 YAML 登记，
   * 由宿主从公开资源站生成目录并按需物化。默认开启。
   */
  cloudCatalog: z.boolean().default(true),
  /**
   * 严格纯云端模式：开启后完全忽略本地旧资源（models/models.yaml、
   * images/、audio/bgm/bgm.yaml 与非 cloud/ 音频、audio/se/ 非 cloud/ 音效、voices/），
   * 所有目录枚举与导出物化均只使用云端目录与 cloud/ 缓存子目录。
   */
  cloudOnly: z.boolean().default(false),
  /** 云端目录缓存有效期（小时）；过期后后台刷新，失败沿用旧快照 */
  cloudCatalogTtlHours: z.number().default(6)
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
export type RagAdaptiveSettings = z.infer<typeof RagAdaptiveSchema>
export type RagRerankSettings = z.infer<typeof RagRerankSchema>
export type RagSettings = z.infer<typeof RagSchema>
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

function applyBgmEnvOverrides(bgm: BgmSettings): void {
  const env = process.env
  if (env.MSS_BGM_ENABLED !== undefined) {
    bgm.enabled = !['0', 'false', 'no', 'off'].includes(env.MSS_BGM_ENABLED.toLowerCase())
  }
  if (env.MSS_BGM_PATH && env.MSS_BGM_PATH.trim()) {
    bgm.path = env.MSS_BGM_PATH.trim()
  }
  if (env.MSS_BGM_VOLUME !== undefined) {
    const v = parseFloat(env.MSS_BGM_VOLUME)
    if (Number.isFinite(v)) {
      bgm.volume = Math.min(Math.max(v, 0), 1)
    }
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
  const apiKeyEnv = env.MSST_API_KEY ?? env.MSS_API_KEY
  if (apiKeyEnv !== undefined) config.server.apiKey = apiKeyEnv

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
  if (env.MSS_VIDEO_RENDER_SCALE) {
    const v = parseFloat(env.MSS_VIDEO_RENDER_SCALE)
    if (Number.isFinite(v) && v >= 0.5 && v <= 4) config.video.renderScale = v
  }
  if (env.MSS_VIDEO_CODEC) {
    const v = env.MSS_VIDEO_CODEC.toLowerCase()
    if (v === 'hevc' || v === 'h264') config.video.codec = v
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
  if (env.MSS_MAX_OUTPUT_MBPS) {
    const v = parseFloat(env.MSS_MAX_OUTPUT_MBPS)
    if (Number.isFinite(v) && v >= 0) config.video.maxOutputMbps = v
  }
  if (env.MSS_USE_RUST_EXPORTER !== undefined) {
    config.video.useRustExporter = !['0', 'false', 'no', 'off'].includes(
      env.MSS_USE_RUST_EXPORTER.toLowerCase()
    )
  }
  if (env.MSS_EXPORT_JOBS) {
    const v = parseInt(env.MSS_EXPORT_JOBS, 10)
    if (Number.isFinite(v) && v >= 1 && v <= 8) config.video.exportJobs = v
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
  if (env.MSS_IRODORI_TIMBRE_LOCK_MODE) {
    const mode = env.MSS_IRODORI_TIMBRE_LOCK_MODE.toLowerCase()
    if (mode === 'normal' || mode === 'off') config.tts.irodori.timbreLockMode = mode
  }
  if (env.MSS_IRODORI_CFG_SCALE_CAPTION) {
    const v = parseFloat(env.MSS_IRODORI_CFG_SCALE_CAPTION)
    if (Number.isFinite(v) && v >= 0) config.tts.irodori.cfgScaleCaption = v
  }
  if (env.MSS_IRODORI_SPECIAL_CFG_SCALE_CAPTION) {
    const v = parseFloat(env.MSS_IRODORI_SPECIAL_CFG_SCALE_CAPTION)
    if (Number.isFinite(v) && v > 0) config.tts.irodori.specialSceneCfgScaleCaption = v
  }
  if (env.MSS_IRODORI_SPEAKER_KV_SCALE) {
    const v = parseFloat(env.MSS_IRODORI_SPEAKER_KV_SCALE)
    if (Number.isFinite(v) && v > 0) config.tts.irodori.speakerKvScale = v
  }
  if (env.MSS_IRODORI_SPEAKER_KV_MIN_T) {
    const v = parseFloat(env.MSS_IRODORI_SPEAKER_KV_MIN_T)
    if (Number.isFinite(v) && v >= 0 && v <= 1) config.tts.irodori.speakerKvMinT = v
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
  if (env.MSS_MAX_CONCURRENT_EXPORTS) {
    const v = parseInt(env.MSS_MAX_CONCURRENT_EXPORTS, 10)
    if (Number.isFinite(v)) config.render.maxConcurrentExports = Math.max(0, v)
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
    if (v === 'single' || v === 'staged' || v === 'agent' || v === 'hybrid') {
      config.llm.pipeline = v
    }
  }
  if (env.MSS_LLM_AGENT_MAX_STEPS) {
    const v = parseInt(env.MSS_LLM_AGENT_MAX_STEPS, 10)
    if (Number.isFinite(v) && v >= 2 && v <= 40) config.llm.agentMaxSteps = v
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
  if (env.MSS_RAG_ENABLED !== undefined) {
    config.llm.rag.enabled = !['0', 'false', 'no', 'off'].includes(
      env.MSS_RAG_ENABLED.toLowerCase()
    )
  }
  if (env.MSS_RAG_BASE_URL) config.llm.rag.baseUrl = env.MSS_RAG_BASE_URL
  if (env.MSS_RAG_API_KEY_ENV) config.llm.rag.apiKeyEnv = env.MSS_RAG_API_KEY_ENV
  if (env.MSS_RAG_MODEL) config.llm.rag.model = env.MSS_RAG_MODEL
  if (env.MSS_RAG_CACHE_DIR) config.llm.rag.cacheDir = env.MSS_RAG_CACHE_DIR
  if (env.MSS_RAG_RERANK_ENABLED !== undefined) {
    config.llm.rag.rerank.enabled = !['0', 'false', 'no', 'off'].includes(
      env.MSS_RAG_RERANK_ENABLED.toLowerCase()
    )
  }
  if (env.MSS_RAG_RERANK_MODEL) config.llm.rag.rerank.model = env.MSS_RAG_RERANK_MODEL
  if (env.MSS_RAG_RERANK_BASE_URL) config.llm.rag.rerank.baseUrl = env.MSS_RAG_RERANK_BASE_URL
  if (env.MSS_RAG_RERANK_API_KEY_ENV) {
    config.llm.rag.rerank.apiKeyEnv = env.MSS_RAG_RERANK_API_KEY_ENV
  }
  if (env.MSS_RAG_RERANK_ENDPOINT_PATH) {
    config.llm.rag.rerank.endpointPath = env.MSS_RAG_RERANK_ENDPOINT_PATH
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
  if (env.MSS_ASSETS_CLOUD_CATALOG !== undefined) {
    config.assets.cloudCatalog = !['0', 'false', 'no', 'off'].includes(
      env.MSS_ASSETS_CLOUD_CATALOG.toLowerCase()
    )
  }
  if (env.MSS_ASSETS_CLOUD_ONLY !== undefined) {
    config.assets.cloudOnly = !['0', 'false', 'no', 'off'].includes(
      env.MSS_ASSETS_CLOUD_ONLY.toLowerCase()
    )
  }
  if (env.MSS_ASSETS_CLOUD_CATALOG_TTL_HOURS) {
    const v = parseInt(env.MSS_ASSETS_CLOUD_CATALOG_TTL_HOURS, 10)
    if (Number.isFinite(v) && v > 0) config.assets.cloudCatalogTtlHours = v
  }

  // bgm
  applyBgmEnvOverrides(config.bgm)

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

  // 4:2:0 编码要求宽高为偶数；在启动时就拒绝而不是等导出半程失败
  const { width: encodeWidth, height: encodeHeight } = config.video
  if (
    !Number.isInteger(encodeWidth) ||
    !Number.isInteger(encodeHeight) ||
    encodeWidth <= 0 ||
    encodeHeight <= 0 ||
    encodeWidth % 2 !== 0 ||
    encodeHeight % 2 !== 0
  ) {
    throw new Error(
      `Invalid encode size: ${encodeWidth}x${encodeHeight}; yuv420p requires even width and height.`
    )
  }
  if (!Number.isFinite(config.video.fps) || config.video.fps <= 0) {
    throw new Error(`Invalid video.fps in config: ${config.video.fps} (must be > 0)`)
  }

  if (config.video.exportMode === 'record') {
    console.warn(
      '[config] video.exportMode="record" is deprecated and will be removed in a future release; falling back to "fast".'
    )
    config.video.exportMode = 'fast'
  }
  if (config.video.recordTargetSizeMb > 0) {
    console.warn(
      '[config] video.recordTargetSizeMb is deprecated and ignored (record mode has been removed); configure video.exportBitrate instead.'
    )
  }

  const paths = {
    output: path.resolve(rootDir, pathsRaw.output),
    resources: path.resolve(rootDir, pathsRaw.resources),
    webRenderer: path.resolve(rootDir, pathsRaw.webRenderer)
  }

  // 角色人格目录、资源基地址等相对路径以仓库根为基准
  config.llm.personaDirs = config.llm.personaDirs.map((p) => path.resolve(rootDir, p))
  config.llm.baseUrl = config.llm.baseUrl.replace(/\/+$/, '')
  config.llm.rag.baseUrl = config.llm.rag.baseUrl.replace(/\/+$/, '')
  config.llm.rag.rerank.baseUrl = config.llm.rag.rerank.baseUrl.replace(/\/+$/, '')
  config.llm.rag.sekaiStorySearchUrl = config.llm.rag.sekaiStorySearchUrl.replace(/\/+$/, '')
  config.llm.rag.cacheDir = path.resolve(rootDir, config.llm.rag.cacheDir)
  config.llm.rag.localDirs = config.llm.rag.localDirs.map((p) => path.resolve(rootDir, p))
  config.assets.cacheDir = path.resolve(rootDir, config.assets.cacheDir)
  if (config.assets.assetBase) {
    config.assets.assetBase = config.assets.assetBase.replace(/\/+$/, '')
  }

  // 严格纯云端模式下忽略本地 audio/bgm/bgm.yaml 与本地 bg1.mp3；
  // 非纯云端模式保持以资源根下的 bgm.yaml 为准（文件不存在时沿用 config.yaml 的 bgm 节）。
  // 环境变量 MSS_BGM_* 始终具有最高优先级（覆盖 bgm.yaml 与 config.yaml）。
  const bgmFromManifest = config.assets.cloudOnly ? null : readBgmManifest(paths.resources)
  if (bgmFromManifest) {
    config.bgm = bgmFromManifest
  }
  applyBgmEnvOverrides(config.bgm)
  config.bgm.volume = Math.min(Math.max(config.bgm.volume, 0), 1)

  // 云端优先兜底：
  // 1) cloudOnly=true 时始终把非 cloud/ 的本地 bgm.path（如 audio/bgm/bg1.mp3、custom.mp3 等）
  //    归一化为云端 ID 或回落 bgm00003，同时保留显式 https:// URL 与 cloud/ 路径；
  // 2) 非 cloudOnly 时，当 bgm.yaml 不存在、默认 audio/bgm/bg1.mp3 也不在磁盘上且启用 cloudCatalog 时回落。
  if (config.assets.cloudOnly) {
    config.assets.cloudCatalog = true
    config.bgm.path = normalizeCloudOnlyBgmPath(config.bgm.path)
  } else if (
    !bgmFromManifest &&
    config.bgm.path === DEFAULT_LOCAL_BGM_PATH &&
    !fs.existsSync(path.join(paths.resources, 'audio', 'bgm', 'bg1.mp3')) &&
    config.assets.cloudCatalog
  ) {
    config.bgm.path = DEFAULT_CLOUD_BGM_ID
  }

  return {
    ...config,
    rootDir,
    paths
  }
}
