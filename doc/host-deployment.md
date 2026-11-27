# 部署指南

[返回 README](../README.md) · [文档总览](README.md) · [导出模式与提速调参](export-modes.md) · [故障排除](troubleshooting.md)

服务本质上就是一个 Node 进程：它拉起几个无头 Chrome / Edge 页面当渲染 worker（每页一个独立 WebGL 上下文），对外提供 HTTP API、静态文件、云端资源拉取、AI 编剧和 `ffmpeg` 合轨。支持 Windows / Linux / macOS，Linux 服务器不需要装桌面或 Xvfb。

## 环境要求

| 组件         | 说明                                                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node.js**  | `>= 20`，推荐 22 LTS                                                                                                                                              |
| **浏览器**   | Chrome / Edge / Chromium（按 `msedge → chrome → chromium` 探测；都没有就运行 `npx playwright install chromium`）                                                  |
| **ffmpeg**   | 依赖里自带 `ffmpeg-static`；也可设 `MSS_FFMPEG_PATH` 用系统版（比如 Linux 想用系统带 `h264_nvenc` / `hevc_nvenc` 的 ffmpeg 时推荐设一下）                         |
| **GPU 驱动** | 有独显/核显建议装好驱动；纯 CPU 机器也能跑软渲染 + `encoder: libx264`                                                                                             |
| **外网访问** | 开启 `assets.cloudCatalog: true` 时需能访问 `assets.pjsk.moe`、`storage.exmeaning.com`（可选 `cdn.jsdelivr.net`）；纯内网可关闭 `cloudCatalog` 并提前预拉本地资源 |

> 现已原生提供多阶段 `Dockerfile` 与 Docker Compose 配置（含 Intel `/dev/dri` 核显/Arc 与 NVIDIA Container Toolkit 硬件加速叠加文件），既可直接宿主机运行，也可用 Docker 一键部署；详见下方 [Docker 一键部署](#docker-一键部署)。

## Docker 一键部署

官方 `Dockerfile` 基于 `mcr.microsoft.com/playwright:v1.63.0-noble`，内置完整版 Chromium、原生 Rust 导出器、`ffmpeg`、CJK 字体与 Mesa/Vulkan/Intel VAAPI 驱动，支持**纯环境变量零 `config.yaml` 启动**。

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

- **零本地素材 & 首次冷启动**：`.env.example` 默认开启 `MSS_ASSETS_CLOUD_CATALOG=true` 和 `MSS_ASSETS_CLOUD_ONLY=true`。首次启动拉取 600+ 云端模型索引时，`/api/v1/resources`、剧本生成与导出冷启动等待上限为 **180 秒**，完成后自动缓存到挂载的 `./resources` 与 `./cache`。
- **Intel `/dev/dri` 权限**：如宿主机 `video` / `render` 组 GID 与容器内不一致，在宿主机执行 `getent group video render`，将对应数字 GID 填入 `.env` 的 `VIDEO_GID` 与 `RENDER_GID`（`docker-compose.intel.yml` 会自动通过 `group_add` 注入）。
- **容器稳定性默认项**：`docker-compose.yml` 已内置 `init: true`（回收 Chromium `<defunct>` 僵尸进程）、`shm_size: 2gb`、`stop_grace_period: 150s`，以及 glibc 低碎片参数 `MALLOC_ARENA_MAX=2` 与 `MALLOC_MMAP_THRESHOLD_=131072`。
- **自定义配置与人设挂载**：默认无需挂载 `config.yaml`；如需自定义高级项，先在宿主机创建文件（避免 Docker 自动建出空目录）再取消 `docker-compose.yml` 中 `./config.yaml:/app/config.yaml:ro` 或 `./personas:/app/personas:ro`（配合 `MSS_LLM_PERSONA_DIRS=/app/personas`）的注释。

## 平台与编码器差异

- **Windows**：直接用系统 Edge / Chrome 一般都能吃到核显或独显 WebGL；ffmpeg `auto` 可探测 NVIDIA (`nvenc`) / AMD (`amf`) / Intel (`qsv`)。
- **Linux**：Chrome / Chromium；如果是有 NVIDIA 独显但**没有桌面/X11** 的服务器，记得看下面 [WebGL 硬件加速](#webgl-硬件加速)。
- **macOS**：可用系统 GPU 跑 WebGL；目前 `ffmpeg` 不探测 VideoToolbox，`auto` 会用 CPU 软编。

注意：**`video.encoder` 填的是厂商/模式关键字**：`auto` / `nvidia` / `amd` / `intel` / `cpu` / `libx264`，别直接填 `nvenc` 或 `hevc_nvenc`。

## 安装、构建与最小试跑

### 方式一：交互式配置向导（推荐）

```bash
npm ci
npm run init          # 交互式生成 config.yaml 与 .env（密钥仅写 .env，POSIX 下权限 0600）
npm run build
npm start
```

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
export MSS_LLM_API_KEY=sk-...        # 如果要用 AI 写剧本
npm ci
npm run build
npm start
```

> 宿主启动时会自动运行 `validateConfigHints`，在日志中以 `WARN` 提示常见配置坑位（如缺少 LLM 密钥、TTS 开启但未配参考音频/LoRA、`fps !== fastFps`、公网监听 `0.0.0.0` 未设 `server.apiKey` 等）。

刚上手不想配 TTS 的话，一份最简 `config.yaml` 只要关闭 TTS 就行（BGM 会自动用云端 `bgm00003`）：

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

> 再次提醒：不建 `config.yaml` 时内置默认是 `1280×720`、`30fps`、`renderScale: 1.5`、`crf: 18`、`codec: hevc`、`bgm.volume: 0.35`、`cloudOnly: false`；复制 `config.example.yaml` 则是 `1920×1080`、`60fps`、`fastFps: 60`、`renderScale: 1`、`crf: 27`、`cloudOnly: true`。

启动后检查：

```bash
curl http://127.0.0.1:9881/api/v1/health
```

确认 `renderPool.readyWorkers >= 1`，且 `webglRenderers` 里有真实显卡名字。

---

## 环境变量覆盖表

配置优先级：**精细 `MSST_*` / `MSS_*` 环境变量 > 预设档案（`MSS_GPU_PROFILE` / `MSS_GPU_MODE`、`MSS_MEMORY_PROFILE`） > `config.yaml`（可由 `MSS_CONFIG_PATH` 指定） > 内置默认值**。只列出真实生效的变量，没写出来的字段请改 `config.yaml`：

| 环境变量                                                                                                                                      | 对应配置                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `MSS_CONFIG_PATH`                                                                                                                             | 自定义 `config.yaml` 路径（绝对路径或相对仓库根目录；不存在时告警并回退默认值）                                               |
| `MSS_GPU_PROFILE` / `MSS_GPU_MODE`                                                                                                            | GPU 预设：`auto`/`intel`/`nvidia`/`amd`/`cpu`（两者同设时 `MSS_GPU_PROFILE` 优先；Linux 下 `intel`/`nvidia` 自动配 Vulkan）   |
| `MSS_MEMORY_PROFILE`                                                                                                                          | 内存预设：`standard` 或 `low`（`low` 设 `workers=1`、`maxConcurrentExports=1`、`workerRecycleExports=2`、`30fps`、`scale=1`） |
| `MSS_PORT` / `MSS_HOST`                                                                                                                       | `server.port` / `server.host`                                                                                                 |
| `MSST_API_KEY` / `MSS_API_KEY`                                                                                                                | `server.apiKey`（`MSST_*` 优先）                                                                                              |
| `MSS_SERVER_CORS` / `MSST_CORS_ORIGINS` / `MSS_CORS_ORIGINS`                                                                                  | `server.cors` 开关 / `server.corsOrigins` 白名单（逗号分隔）                                                                  |
| `MSS_VIDEO_WIDTH` / `MSS_VIDEO_HEIGHT` / `MSS_VIDEO_FPS` / `MSS_VIDEO_CRF` / `MSS_VIDEO_RENDER_SCALE`                                         | 输出宽高、帧率、质量因子、渲染倍率                                                                                            |
| `MSS_VIDEO_CODEC` / `MSS_FFMPEG_ENCODER` / `MSS_VIDEO_ENCODER` / `MSS_FFMPEG_PATH`                                                            | `hevc`/`h264`、硬件厂商选择（`MSS_VIDEO_ENCODER` 为别名，`MSS_FFMPEG_ENCODER` 优先）、ffmpeg 路径                             |
| `MSS_EXPORT_MODE` / `MSS_EXPORT_BITRATE` / `MSS_MAX_OUTPUT_MBPS` / `MSS_EXPORT_FAST_ENCODER` / `MSS_FAST_FPS`                                 | 导出模式（`fast`）、码率、软上限、编码路径、编码帧率上限                                                                      |
| `MSS_USE_RUST_EXPORTER` / `MSS_EXPORT_JOBS`                                                                                                   | 原生 Rust 导出开关 / 并行分段渲染数（`1~8`）                                                                                  |
| `MSS_VIDEO_WATERMARK` / `MSS_VIDEO_WATERMARK_TEXT`                                                                                            | 水印开关与自定义文字                                                                                                          |
| `MSS_IDLE_CHAIN_GAP_SEC` / `MSS_TTS_MODE`                                                                                                     | 动作续演间隔 / `concurrent` 或 `serial`                                                                                       |
| `MSS_BGM_ENABLED` / `MSS_BGM_PATH` / `MSS_BGM_VOLUME`                                                                                         | BGM 开关、路径/云端 ID、音量（默认 `0.35`，覆盖 `bgm.yaml`）                                                                  |
| `MSS_WORKERS` / `MSS_MAX_CONCURRENT_EXPORTS` / `MSS_WORKER_RECYCLE_EXPORTS`                                                                   | 常驻 worker 数、导出并发上限、每 N 次回收重建                                                                                 |
| `MSS_BROWSER_CHANNELS` / `MSS_BROWSER_EXECUTABLE` / `MSS_CHROME_ARGS`                                                                         | 浏览器通道（逗号分隔）、路径、启动参数                                                                                        |
| `MSS_LINUX_GPU_ANGLE` / `MSS_MIN_FREE_MEMORY_MB`                                                                                              | Linux `--use-angle=gl` 开关 / 最小可用内存护栏（MB）                                                                          |
| `MSS_OUTPUT_DIR` / `MSS_RESOURCE_DIR` / `MSS_WEB_RENDERER_DIR`                                                                                | 输出、资源、前端产物目录                                                                                                      |
| `MSS_TTS_ENABLED` / `MSS_TTS_PROVIDER` / `MSS_TTS_API_BASE_URL` / `MSS_TTS_TIMEOUT_MS`                                                        | TTS 开关、引擎（`gpt-sovits`/`irodori`）、地址、超时                                                                          |
| `MSS_IRODORI_MODEL` / `MSS_IRODORI_NUM_STEPS` / `MSS_IRODORI_TIMBRE_LOCK_MODE`                                                                | Irodori 模型名、采样步数、音色锁定模式（`normal`/`off`）                                                                      |
| `MSS_LLM_ENABLED` / `MSS_LLM_BASE_URL` / `MSS_LLM_API_KEY_ENV` / `MSS_LLM_MODEL`                                                              | LLM 开关、接口地址、密钥变量名、模型名                                                                                        |
| `MSS_LLM_TEMPERATURE` / `MSS_LLM_MAX_TOKENS` / `MSS_LLM_TIMEOUT_MS` / `MSS_LLM_RETRIES`                                                       | 温度、token 上限、超时、重试次数                                                                                              |
| `MSS_LLM_REPAIR_ROUNDS` / `MSS_LLM_PIPELINE` / `MSS_LLM_AGENT_MAX_STEPS` / `MSS_LLM_JSON_MODE`                                                | 修复轮数、`staged`/`hybrid`/`agent`/`single`、Phase 1 步数、JSON 模式                                                         |
| `MSS_LLM_TRANSLATE` / `MSS_LLM_POLISH_DIALOGUE` / `MSS_LLM_PERSONA_DIRS`                                                                      | 日文翻译开关 / 对话润色开关（`llm.polishDialogue`） / 角色人设目录（逗号分隔，相对仓库根）                                    |
| `MSS_LLM_TARGET_MINUTES` / `MSS_LLM_SYSTEM_PROMPT` / `MSS_LLM_EXTRA_BODY`                                                                     | 目标分钟、系统提示词、额外请求体 JSON                                                                                         |
| `MSS_RAG_ENABLED` / `MSS_RAG_BASE_URL` / `MSS_RAG_API_KEY_ENV` / `MSS_RAG_MODEL` / `MSS_RAG_CACHE_DIR`                                        | RAG 开关、Embedding 接口、模型、缓存目录                                                                                      |
| `MSS_RAG_RERANK_ENABLED` / `MSS_RAG_RERANK_MODEL` / `MSS_RAG_RERANK_BASE_URL` / `MSS_RAG_RERANK_API_KEY_ENV` / `MSS_RAG_RERANK_ENDPOINT_PATH` | RAG 重排开关、模型与接口                                                                                                      |
| `MSS_ASSETS_REGION` / `MSS_ASSETS_INDEX_BASE` / `MSS_ASSETS_LIBRARY_BASE` / `MSS_ASSETS_BASE`                                                 | 云端区服（`jp`/`cn`/`tw`/`kr`/`en`）与镜像地址                                                                                |
| `MSS_ASSETS_SOUNDTRACK_BASE` / `MSS_ASSETS_CACHE_DIR`                                                                                         | 曲名索引镜像 / 缓存目录                                                                                                       |
| `MSS_ASSETS_CONCURRENCY` / `MSS_ASSETS_TIMEOUT_MS` / `MSS_ASSETS_RETRIES`                                                                     | 云端下载并发、超时、重试                                                                                                      |
| `MSS_ASSETS_CLOUD_CATALOG` / `MSS_ASSETS_CLOUD_ONLY` / `MSS_ASSETS_CLOUD_CATALOG_TTL_HOURS`                                                   | 云端目录开关、严格纯云端开关、缓存小时数                                                                                      |
| `MSS_LOG_LEVEL`                                                                                                                               | `silly` / `trace` / `debug` / `info` / `warn` / `error` / `fatal`                                                             |
| `MALLOC_ARENA_MAX` / `MALLOC_MMAP_THRESHOLD_`                                                                                                 | Linux glibc 内存碎片控制（推荐 `2` 与 `131072`，Docker 已内置默认，宿主机 systemd 同样建议配置）                              |

> Docker Compose 专用变量：`BUILD_MIRROR`（`global`/`cn`）、`MSS_HOST_PORT`（默认 `9881`）、`VIDEO_GID` / `RENDER_GID`、`LIBVA_DRIVER_NAME`（默认 `iHD`）、`NVIDIA_VISIBLE_DEVICES` / `NVIDIA_DRIVER_CAPABILITIES`，详见 `.env.example`。

---

## 并发、热备与内存建议

- **每个渲染 worker 占用约 300~500 MB 内存**和一份 WebGL 上下文。
- **4~8 GB 低内存主机 / NAS**：直接设置 `MSS_MEMORY_PROFILE=low`（自动应用 `workers=1`、`maxConcurrentExports=1`、`workerRecycleExports=2`、`fps=30`、`fastFps=30`、`renderScale=1.0`），并配合 Linux glibc 参数 `MALLOC_ARENA_MAX=2`、`MALLOC_MMAP_THRESHOLD_=131072` 抑制长驻 RSS 碎片增长（Docker 已默认开启）。注意：若 `.env` 里显式写了 `MSS_VIDEO_FPS=60` / `MSS_FAST_FPS=60`，需注释掉才能让 `low` 档位的 `30fps` 生效。
- 推荐把 `render.workers` 设为比 `render.maxConcurrentExports` 多 1（比如 `workers: 3`、`maxConcurrentExports: 2`），留一个热备 worker，这样有人触发回收或意外崩溃时下一个任务不用等浏览器重新冷启动。
- `workerRecycleExports` 默认 `5`（每导出 5 次重建一次页面释放 Live2D 纹理内存）；低内存机器可以配 `minFreeMemoryMb: 1500` 防止 OOM。
- 收到 `SIGINT` / `SIGTERM` 关停时，宿主最多等 120 秒让在途导出跑完再退出。

## 常驻运行

- **Linux（systemd）**：直接参考模板 [deploy/mysekai-host.service](../deploy/mysekai-host.service)，工作目录固定在仓库根，`TimeoutStopSec` 建议设为 `150s`（大于宿主的 120s 排空上限）。确保运行用户对仓库、`resources/`、`cache/`、`apifile/` 和浏览器可执行文件有权限。
- **Windows**：用任务计划程序或 NSSM 跑 `node out-host/host/main.js`，起始目录填仓库根目录。
- **更新升级**：`git pull && npm ci && npm run build`，然后重启服务。

## WebGL 硬件加速

如果 `/api/v1/health` 里的 `webglRenderers` 显示 `SwiftShader` 或 `llvmpipe`：

- **快捷预设**：直接设置 `MSS_GPU_PROFILE=intel`（Intel 核显 / Arc）或 `MSS_GPU_PROFILE=nvidia`（NVIDIA 独显），宿主在 Linux 下会自动关闭 `linuxGpuAngle`、配置 Vulkan ANGLE 参数并切换对应硬件编码器（不覆盖显式设置的 `MSS_CHROME_ARGS` / `MSS_FFMPEG_ENCODER` / `MSS_VIDEO_ENCODER`）。
- **Docker Compose**：Intel 平台使用 `docker compose -f docker-compose.yml -f docker-compose.intel.yml up -d`（透传 `/dev/dri`）；NVIDIA 平台使用 `docker compose -f docker-compose.yml -f docker-compose.nvidia.yml up -d`（需先安装 NVIDIA Container Toolkit）。
- **Linux + NVIDIA 无桌面环境（手动）**：把 `render.linuxGpuAngle` 设为 `false`，同时设 `extraChromeArgs: "--use-angle=vulkan"`。
- **Linux 有 X11 桌面**：保持 `linuxGpuAngle: true`（会自动加 `--use-angle=gl`）。
- 尽量用系统完整版 Chrome / Edge，不要退到 Playwright 自带的 `chrome-headless-shell`。

## 安全提示

服务默认监听 `0.0.0.0:9881`：

- 如果不只在本机使用，请设置 `server.apiKey`（或 `MSST_API_KEY`）开启 Bearer 鉴权，并把未认证的接口放到 nginx / Caddy 反向代理后面提供 HTTPS。
- 不需要开放外部网页跨域时，保持 `server.corsOrigins` 留空（仅放行本机回环）；对外开放则写明具体域名白名单。
- 禁止把 `/bridge/*` 暴露到公网（通过反代只转发 `/api/v1/*` 即可）。
