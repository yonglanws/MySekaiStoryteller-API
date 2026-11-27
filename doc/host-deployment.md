# 部署指南

[返回 README](../README.md) · [文档总览](README.md) · [导出模式与提速调参](export-modes.md) · [故障排除](troubleshooting.md) · [安全策略](../SECURITY.md)

服务本质上就是一个 Node 进程：它拉起无头 Chrome / Edge 页面当渲染 worker（每页一个独立 WebGL 上下文），对外提供 HTTP API、静态资源、云端素材按需拉取、内置 58 份 PJSK 人设的 AI 编剧、Rust 二进制流式管道（`/bridge/rs-stream`）和 `ffmpeg` / 原生 Rust 混音合流。支持 Windows / Linux / macOS，Linux 服务器不需要装桌面或 Xvfb。

## 环境要求

| 组件         | 说明                                                                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node.js**  | `>= 20`，推荐 22 LTS                                                                                                                                                  |
| **浏览器**   | Chrome / Edge / Chromium（按 `msedge → chrome → chromium` 探测；都没有就运行 `npx playwright install chromium`）                                                      |
| **ffmpeg**   | 依赖里自带 `ffmpeg-static`；也可设 `MSS_FFMPEG_PATH` 用系统版（比如 Linux 想用系统带 `h264_nvenc` / `hevc_nvenc` / `hevc_qsv` / `hevc_vaapi` 的 ffmpeg 时推荐设一下） |
| **GPU 驱动** | 有独显/核显建议装好驱动；纯 CPU 机器也能跑软渲染 + `encoder: libx264`                                                                                                 |
| **外网访问** | 开启 `assets.cloudCatalog: true` 时需能访问 `assets.pjsk.moe`、`storage.exmeaning.com`（可选 `cdn.jsdelivr.net`）；纯内网可关闭 `cloudCatalog` 并提前预拉本地资源     |

> 现已原生提供多阶段 `Dockerfile` 与 Docker Compose 配置（含 Intel `/dev/dri` 核显/Arc 与 NVIDIA Container Toolkit 硬件加速叠加文件），既可直接宿主机运行，也可用 Docker 一键部署；详见下方 [Docker 一键部署](#docker-一键部署)。

## Docker 一键部署

官方 `Dockerfile` 基于 `mcr.microsoft.com/playwright:v1.63.0-noble`，内置完整版 Chromium、原生 Rust 导出器、**58 份内置 PJSK 角色人设（`/app/personas/pjsk`）**、`ffmpeg`、CJK 字体与 Mesa/Vulkan/Intel VAAPI 驱动，支持**纯环境变量零 `config.yaml` 启动**。

```bash
# 1. 复制环境变量模板，至少填入 MSS_LLM_API_KEY（纯导出已有剧本可留空）
cp .env.example .env

# 2. 默认模式启动（CPU / 自动探测）
docker compose up -d --build

# 国内网络构建镜像（rsproxy.cn + npmmirror 加速）
BUILD_MIRROR=cn docker compose up -d --build

# Intel 核显 / Arc 硬件加速（VAAPI + QSV + Vulkan，透传 /dev/dri）
docker compose -f docker-compose.yml -f docker-compose.intel.yml up -d

# NVIDIA 独显硬件加速（NVENC + Vulkan，需宿主机先装 NVIDIA Container Toolkit）
docker compose -f docker-compose.yml -f docker-compose.nvidia.yml up -d
```

关键说明：

- **零本地素材 & 首次冷启动**：`.env.example` 默认开启 `MSS_ASSETS_CLOUD_CATALOG=true` 和 `MSS_ASSETS_CLOUD_ONLY=true`。首次启动拉取 574 套云端模型索引时，`/api/v1/resources`、剧本生成与导出冷启动等待上限为 **180 秒**，完成后自动缓存到挂载的 `./resources` 与 `./cache`。如需优先使用本地 `resources/` 自定义素材，请设置 `MSS_ASSETS_CLOUD_ONLY=false`。
- **内置人设与自定义叠加**：容器镜像已自带 `/app/personas/pjsk`（58 份 PJSK 角色人设）并默认自动发现，无需额外挂载。若要扩展或覆盖同名角色，请取消 `docker-compose.yml` 中 `./custom-personas:/app/custom-personas:ro` 的注释并设置 `MSS_LLM_PERSONA_DIRS=/app/personas/pjsk,/app/custom-personas`（切勿直接挂载覆盖 `/app/personas`）；若要彻底禁用内置人设，设 `MSS_LLM_PERSONA_DIRS=none`。
- **Intel `/dev/dri` 权限与设备选择**：如宿主机 `video` / `render` 组 GID 与容器内不一致，在宿主机执行 `getent group video render`，将对应数字 GID 填入 `.env` 的 `VIDEO_GID` 与 `RENDER_GID`（`docker-compose.intel.yml` 会自动通过 `group_add` 注入）。若机器有多个渲染节点（非默认 `/dev/dri/renderD128`），可通过 `MSS_VAAPI_DEVICE=/dev/dri/renderD129` 指定。
- **容器稳定性默认项**：`docker-compose.yml` 已内置 `init: true`（回收 Chromium `<defunct>` 僵尸进程）、`shm_size: 2gb`、`stop_grace_period: 150s`，以及 glibc 低碎片参数 `MALLOC_ARENA_MAX=2` 与 `MALLOC_MMAP_THRESHOLD_=131072`。
- **自定义 `config.yaml` 挂载**：默认无需挂载 `config.yaml`；如需自定义高级项（如详细的 IrodoriTTS 多角色 `characters` 映射），先在宿主机创建文件（避免 Docker 自动建出空目录）再取消 `docker-compose.yml` 中 `./config.yaml:/app/config.yaml:ro` 的注释。

## 平台与编码器差异

- **Windows**：直接用系统 Edge / Chrome 一般都能吃到核显或独显 WebGL；ffmpeg `auto` 可探测 NVIDIA (`nvenc`) / AMD (`amf`) / Intel (`qsv`)。
- **Linux**：Chrome / Chromium；在无桌面服务器下，Linux 导出管线会优先走 Rust `/bridge/rs-stream` 二进制 WebSocket `rawvideo` 管道直连原生 Rust 编码器（支持 Intel QSV / VAAPI 与 NVIDIA NVENC），且 Rust 硬件探测结果会自动缓存，不再每次导出重复起进程探测。Intel 核显（如 UHD 630 / Iris Xe）或 NVIDIA 独显无桌面环境详见 [WebGL 硬件加速](#webgl-硬件加速)。
- **macOS**：可用系统 GPU 跑 WebGL；目前 `ffmpeg` 不探测 VideoToolbox，`auto` 会用 CPU 软编。

注意：**`video.encoder` 填的是厂商/模式关键字**：`auto` / `nvidia` / `amd` / `intel` / `cpu` / `libx264`，别直接填 `nvenc` 或 `hevc_nvenc`。

## 安装、构建与最小试跑

### 方式一：交互式配置向导（推荐）

```bash
npm ci
npm run init          # 交互式生成 config.yaml 与 .env（密钥仅写 .env，POSIX 下权限 0600）
npm run build
npm start             # 启动时自动加载仓库根目录的 .env（无需手动 source）
```

> [!NOTE]
> **`.env` 自动加载与优先级**：`npm start`（`src/host/main.ts`）启动时会在读取 `config.yaml` 之前自动加载仓库根目录的 `.env`（支持 `KEY=VALUE`、单/双引号、`export ` 前缀与行内 `#` 注释，也可通过 `MSS_ENV_FILE` 指定自定义 `.env` 文件路径）。**已存在于进程环境（shell / systemd / Docker `environment`）中的变量不会被 `.env` 覆盖**。

`npm run init`（`scripts/init-config.mjs`）会按步骤引导设置 GPU 预设、帧率、内存档位、LLM 接口与模型、编剧管线、TTS、纯云端模式与 API 鉴权密钥；默认不覆盖已有文件（需覆盖时加 `--force`）。自动化部署可使用 `--non-interactive`：

```bash
npm run init -- --non-interactive \
  --gpu intel --fps 30 --memory low \
  --llm-url https://api.openai.com/v1 --llm-model gpt-4.1-mini --llm-key sk-... \
  --pipeline hybrid --tts none --cloud-only true
```

### 方式二：手动复制模板或纯环境变量

```bash
cp config.example.yaml config.yaml   # 可选；不复制就按 src/host/config.ts 内置默认值跑
cp .env.example .env                 # 可选；填入 MSS_LLM_API_KEY 后由 npm start 自动加载
npm ci
npm run build
npm start
```

> 宿主启动时会自动运行 `validateConfigHints`，在日志中以 `WARN` 提示常见配置坑位（如缺少 LLM 密钥、配置的 `personaDirs` 路径不存在、TTS 开启但未配参考音频/LoRA、`fps !== fastFps`、公网监听 `0.0.0.0` 未设 `server.apiKey` 等）。

刚上手不想配 TTS 的话，一份最简 `config.yaml` 只要关闭 TTS 就行（内置 58 份 `personas/pjsk/` 人设自动加载，BGM 自动用云端 `bgm00003`）：

```yaml
server:
  host: 127.0.0.1
  port: 9881

video:
  width: 1280
  height: 720
  fps: 30
  fastFps: 30
  renderScale: 1

tts:
  enabled: false

llm:
  enabled: true
  baseUrl: https://api.openai.com/v1
  model: gpt-4.1-mini
```

> 再次提醒：不建 `config.yaml` 且不设环境变量时，裸 schema 默认是 `1280×720`、`30fps`、`renderScale: 1.5`、`crf: 18`、`codec: hevc`、`bgm.volume: 0.35`、`cloudOnly: false`；使用 `config.example.yaml` / `.env.example` / `npm run init` 模板则是 `1920×1080`、`60fps`、`fastFps: 60`、`renderScale: 1`、`crf: 27`、`cloudOnly: true`。

启动后检查：

```bash
curl http://127.0.0.1:9881/api/v1/health
```

确认 `renderPool.readyWorkers >= 1`、`webglRenderers` 里有真实显卡名字，且 `llm.personas` 显示为 `58`（使用内置人设时）。

---

## 环境变量覆盖表

配置优先级：**Shell / Docker 环境变量 > `.env` 文件（或 `MSS_ENV_FILE`） > 预设档案（`MSS_GPU_PROFILE` / `MSS_GPU_MODE`、`MSS_MEMORY_PROFILE`） > `config.yaml`（可由 `MSS_CONFIG_PATH` 指定） > 内置默认值**。只列出真实生效的变量，没写出来的字段请改 `config.yaml`：

| 环境变量                                                                                                                                      | 对应配置                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `MSS_ENV_FILE`                                                                                                                                | 自定义启动时自动加载的 `.env` 文件路径（相对仓库根或绝对路径，默认 `.env`）                                                        |
| `MSS_CONFIG_PATH`                                                                                                                             | 自定义 `config.yaml` 路径（绝对路径或相对仓库根目录；不存在时告警并回退默认值）                                                    |
| `MSS_GPU_PROFILE` / `MSS_GPU_MODE`                                                                                                            | GPU 预设：`auto`/`intel`/`nvidia`/`amd`/`cpu`（两者同设时 `MSS_GPU_PROFILE` 优先；Linux 下 `intel`/`nvidia` 自动配 Vulkan）        |
| `MSS_MEMORY_PROFILE`                                                                                                                          | 内存预设：`standard` 或 `low`（`low` 设 `workers=1`、`maxConcurrentExports=1`、`workerRecycleExports=2`、`30fps`、`scale=1`）      |
| `MSS_PORT` / `MSS_HOST`                                                                                                                       | `server.port` / `server.host`                                                                                                      |
| `MSST_API_KEY` / `MSS_API_KEY`                                                                                                                | `server.apiKey`（`MSST_*` 优先）                                                                                                   |
| `MSS_SERVER_CORS` / `MSST_CORS_ORIGINS` / `MSS_CORS_ORIGINS`                                                                                  | `server.cors` 开关 / `server.corsOrigins` 白名单（逗号分隔）                                                                       |
| `MSS_VIDEO_WIDTH` / `MSS_VIDEO_HEIGHT` / `MSS_VIDEO_FPS` / `MSS_VIDEO_CRF` / `MSS_VIDEO_RENDER_SCALE`                                         | 输出宽高、帧率、质量因子、渲染倍率                                                                                                 |
| `MSS_VIDEO_CODEC` / `MSS_FFMPEG_ENCODER` / `MSS_VIDEO_ENCODER` / `MSS_FFMPEG_PATH`                                                            | `hevc`/`h264`、硬件厂商选择（`MSS_VIDEO_ENCODER` 为别名，`MSS_FFMPEG_ENCODER` 优先）、ffmpeg 路径                                  |
| `MSS_VAAPI_DEVICE`                                                                                                                            | Linux VAAPI / Intel 渲染设备节点覆盖（默认 `/dev/dri/renderD128`）                                                                 |
| `MSS_EXPORT_MODE` / `MSS_EXPORT_BITRATE` / `MSS_MAX_OUTPUT_MBPS` / `MSS_EXPORT_FAST_ENCODER` / `MSS_FAST_FPS`                                 | 导出模式（`fast`）、码率、软上限、编码路径、编码帧率上限                                                                           |
| `MSS_USE_RUST_EXPORTER` / `MSS_EXPORT_JOBS`                                                                                                   | 原生 Rust 导出开关 / 并行分段渲染数（`1~8`）                                                                                       |
| `MSS_USE_RUST_NAPI` / `MSS_RUST_NAPI_PATH` / `MSS_RUST_EXPORTER_PATH`                                                                         | 显式开关 Rust N-API 进程内桥接（设为 `0`/`false` 强制退回子进程/CLI）、自定义 `.node` 扩展路径、自定义 `mss-export` 可执行文件路径 |
| `MSS_VIDEO_WATERMARK` / `MSS_VIDEO_WATERMARK_TEXT`                                                                                            | 水印开关与自定义文字                                                                                                               |
| `MSS_IDLE_CHAIN_GAP_SEC` / `MSS_TTS_MODE`                                                                                                     | 动作续演间隔 / `concurrent` 或 `serial`                                                                                            |
| `MSS_BGM_ENABLED` / `MSS_BGM_PATH` / `MSS_BGM_VOLUME`                                                                                         | BGM 开关、路径/云端 ID、音量（默认 `0.35`，覆盖 `bgm.yaml`）                                                                       |
| `MSS_WORKERS` / `MSS_MAX_CONCURRENT_EXPORTS` / `MSS_WORKER_RECYCLE_EXPORTS`                                                                   | 常驻 worker 数、导出并发上限、每 N 次回收重建                                                                                      |
| `MSS_BROWSER_CHANNELS` / `MSS_BROWSER_EXECUTABLE` / `MSS_CHROME_ARGS`                                                                         | 浏览器通道（逗号分隔）、路径、启动参数                                                                                             |
| `MSS_LINUX_GPU_ANGLE` / `MSS_MIN_FREE_MEMORY_MB`                                                                                              | Linux `--use-angle=gl` 开关 / 最小可用内存护栏（MB）                                                                               |
| `MSS_OUTPUT_DIR` / `MSS_RESOURCE_DIR` / `MSS_WEB_RENDERER_DIR`                                                                                | 输出、资源、前端产物目录                                                                                                           |
| `MSS_TTS_ENABLED` / `MSS_TTS_PROVIDER` / `MSS_TTS_API_BASE_URL` / `MSS_TTS_TIMEOUT_MS`                                                        | TTS 开关、引擎（`gpt-sovits`/`irodori`）、地址、超时                                                                               |
| `MSS_IRODORI_MODEL` / `MSS_IRODORI_NUM_STEPS` / `MSS_IRODORI_TIMBRE_LOCK_MODE`                                                                | Irodori 模型名、采样步数、音色锁定模式（`normal`/`off`）                                                                           |
| `MSS_IRODORI_CFG_SCALE_CAPTION` / `MSS_IRODORI_SPECIAL_CFG_SCALE_CAPTION`                                                                     | Irodori 普通句 / 特殊高潮句的 `cfg_scale_caption` 引导强度                                                                         |
| `MSS_IRODORI_SPEAKER_KV_SCALE` / `MSS_IRODORI_SPEAKER_KV_MIN_T`                                                                               | Irodori 早期去噪步说话人 K/V 音色锁定缩放系数与最小时间步                                                                          |
| `MSS_LLM_ENABLED` / `MSS_LLM_BASE_URL` / `MSS_LLM_API_KEY_ENV` / `MSS_LLM_MODEL`                                                              | LLM 开关、接口地址、密钥变量名、模型名                                                                                             |
| `MSS_LLM_TEMPERATURE` / `MSS_LLM_MAX_TOKENS` / `MSS_LLM_TIMEOUT_MS` / `MSS_LLM_RETRIES`                                                       | 温度、token 上限、超时、重试次数                                                                                                   |
| `MSS_LLM_REPAIR_ROUNDS` / `MSS_LLM_PIPELINE` / `MSS_LLM_AGENT_MAX_STEPS` / `MSS_LLM_JSON_MODE`                                                | 修复轮数、`staged`/`hybrid`/`agent`/`single`、Phase 1 步数、JSON 模式                                                              |
| `MSS_LLM_TRANSLATE` / `MSS_LLM_POLISH_DIALOGUE` / `MSS_LLM_PERSONA_DIRS`                                                                      | 日文翻译开关 / 对话润色开关 / 角色人设目录（逗号分隔，未设时自动发现 `personas/pjsk`，`none`/`off` 禁用）                          |
| `MSS_LLM_TARGET_MINUTES` / `MSS_LLM_SYSTEM_PROMPT` / `MSS_LLM_EXTRA_BODY`                                                                     | 目标分钟、系统提示词、额外请求体 JSON                                                                                              |
| `MSS_RAG_ENABLED` / `MSS_RAG_BASE_URL` / `MSS_RAG_API_KEY_ENV` / `MSS_RAG_MODEL` / `MSS_RAG_CACHE_DIR`                                        | RAG 开关、Embedding 接口、模型、缓存目录                                                                                           |
| `MSS_RAG_RERANK_ENABLED` / `MSS_RAG_RERANK_MODEL` / `MSS_RAG_RERANK_BASE_URL` / `MSS_RAG_RERANK_API_KEY_ENV` / `MSS_RAG_RERANK_ENDPOINT_PATH` | RAG 重排开关、模型与接口                                                                                                           |
| `MSS_ASSETS_REGION` / `MSS_ASSETS_INDEX_BASE` / `MSS_ASSETS_LIBRARY_BASE` / `MSS_ASSETS_BASE`                                                 | 云端区服（`jp`/`cn`/`tw`/`kr`/`en`）与镜像地址                                                                                     |
| `MSS_ASSETS_SOUNDTRACK_BASE` / `MSS_ASSETS_CACHE_DIR`                                                                                         | 曲名索引镜像 / 缓存目录                                                                                                            |
| `MSS_ASSETS_CONCURRENCY` / `MSS_ASSETS_TIMEOUT_MS` / `MSS_ASSETS_RETRIES`                                                                     | 云端下载并发、超时、重试                                                                                                           |
| `MSS_ASSETS_CLOUD_CATALOG` / `MSS_ASSETS_CLOUD_ONLY` / `MSS_ASSETS_CLOUD_CATALOG_TTL_HOURS`                                                   | 云端目录开关、严格纯云端开关、缓存小时数                                                                                           |
| `MSS_LOG_LEVEL`                                                                                                                               | `silly` / `trace` / `debug` / `info` / `warn` / `error` / `fatal`                                                                  |
| `MALLOC_ARENA_MAX` / `MALLOC_MMAP_THRESHOLD_`                                                                                                 | Linux glibc 内存碎片控制（推荐 `2` 与 `131072`，Docker 与 `deploy/mysekai-host.service` 均已内置）                                 |

> Docker Compose 专用变量：`BUILD_MIRROR`（`global`/`cn`）、`MSS_HOST_PORT`（默认 `9881`）、`VIDEO_GID` / `RENDER_GID`、`LIBVA_DRIVER_NAME`（默认 `iHD`）、`NVIDIA_VISIBLE_DEVICES` / `NVIDIA_DRIVER_CAPABILITIES`，详见 `.env.example`。

---

## 并发、热备与内存建议

- **每个渲染 worker 占用约 300~500 MB 内存**和一份 WebGL 上下文。
- **4~8 GB 低内存主机 / NAS**：直接设置 `MSS_MEMORY_PROFILE=low`（自动应用 `workers=1`、`maxConcurrentExports=1`、`workerRecycleExports=2`、`fps=30`、`fastFps=30`、`renderScale=1.0`），并配合 Linux glibc 参数 `MALLOC_ARENA_MAX=2`、`MALLOC_MMAP_THRESHOLD_=131072` 抑制长驻 RSS 碎片增长（Docker 与 systemd 模板已默认开启）。注意：若 `.env` 里显式写了 `MSS_VIDEO_FPS=60` / `MSS_FAST_FPS=60`，需注释掉才能让 `low` 档位的 `30fps` 生效。
- 推荐把 `render.workers` 设为比 `render.maxConcurrentExports` 多 1（比如 `workers: 3`、`maxConcurrentExports: 2`），留一个热备 worker，这样有人触发回收或意外崩溃时下一个任务不用等浏览器重新冷启动。
- `workerRecycleExports` 默认 `5`（每导出 5 次重建一次页面释放 Live2D 纹理内存）；低内存机器可以配 `minFreeMemoryMb: 1500` 防止 OOM。
- 收到 `SIGINT` / `SIGTERM` 关停时，宿主会立刻进入排空模式（新导出/生成返回 `503`），并最多等 120 秒让在途导出与 AI 生成收尾再退出。

## 常驻运行

- **Linux（systemd）**：直接参考更新后的模板 [deploy/mysekai-host.service](../deploy/mysekai-host.service)，已内置 `EnvironmentFile=-/opt/MySekaiStoryteller-API/.env`、`TimeoutStopSec=150`（大于宿主的 120s 排空上限）、`NODE_ENV=production`、`MALLOC_ARENA_MAX=2`、`MALLOC_MMAP_THRESHOLD_=131072` 及 `MSS_GPU_PROFILE` / `MSS_MEMORY_PROFILE` 配置示例。确保工作目录指向仓库根，且运行用户对仓库、`resources/`、`cache/`、`apifile/`、`/dev/dri`（核显时）和浏览器可执行文件有权限。
- **Windows**：用任务计划程序或 NSSM 跑 `node out-host/host/main.js`，起始目录填仓库根目录（自动读取根目录 `.env`）。
- **更新升级**：`git pull && npm ci && npm run build`，然后重启服务。

## WebGL 硬件加速

如果 `/api/v1/health` 里的 `webglRenderers` 显示 `SwiftShader` 或 `llvmpipe`：

- **快捷预设**：直接设置 `MSS_GPU_PROFILE=intel`（Intel 核显 / UHD 630 / Iris Xe / Arc）或 `MSS_GPU_PROFILE=nvidia`（NVIDIA 独显），宿主在 Linux 下会自动关闭 `linuxGpuAngle`、配置 Vulkan ANGLE 参数并切换对应硬件编码器（不覆盖显式设置的 `MSS_CHROME_ARGS` / `MSS_FFMPEG_ENCODER` / `MSS_VIDEO_ENCODER`）。
- **Intel UHD 630 / Iris Xe / Arc（Linux 无桌面）**：
  - Docker 使用 `docker compose -f docker-compose.yml -f docker-compose.intel.yml up -d`（透传 `/dev/dri`，`LIBVA_DRIVER_NAME=iHD`）。
  - 宿主机直跑安装 `mesa-vulkan-drivers`、`intel-media-va-driver`（或 `intel-media-va-driver-non-free`），确保运行用户在 `video` 与 `render` 组，设置 `MSS_GPU_PROFILE=intel`；多卡环境用 `MSS_VAAPI_DEVICE=/dev/dri/renderD128` 指定节点；配合 `MSS_VIDEO_CODEC=hevc` + `fastFps: 30` 可稳定跑通 Vulkan WebGL + QSV/VAAPI 硬件编码。
- **Docker + NVIDIA**：使用 `docker compose -f docker-compose.yml -f docker-compose.nvidia.yml up -d`（需宿主机先安装 NVIDIA Container Toolkit）。
- **Linux + NVIDIA 无桌面环境（手动）**：把 `render.linuxGpuAngle` 设为 `false`，同时设 `extraChromeArgs: "--use-angle=vulkan"`。
- **Linux 有 X11 桌面**：保持 `linuxGpuAngle: true`（会自动加 `--use-angle=gl`）。
- 尽量用系统完整版 Chrome / Edge，不要退到 Playwright 自带的 `chrome-headless-shell`。

## 安全提示

服务默认监听 `0.0.0.0:9881`，完整加固清单见 [安全策略与加固指南](../SECURITY.md)：

- 如果不只在本机使用，请设置 `server.apiKey`（或 `MSST_API_KEY` / `MSS_API_KEY`）开启 Bearer 鉴权，并把接口放到 nginx / Caddy 反向代理后面提供 HTTPS。
- 不需要开放外部网页跨域时，保持 `server.corsOrigins` 留空（仅放行本机回环）；对外开放则写明具体域名白名单。
- **严禁把 `/bridge/*` 暴露到公网**（反向代理仅转发 `/api/v1/*`；`/bridge/*` 仅供同机渲染 worker 回环通信）。
- `.env` 与 `config.yaml` 在 POSIX 系统上应保持 `0600` 权限，避免泄漏 LLM/API 密钥。
