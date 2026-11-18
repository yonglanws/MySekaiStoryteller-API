# 部署指南

[返回 README](../README.md) · [文档索引](README.md) · [资源与音频配置](resources.md) · [导出模式](export-modes.md) · [故障排除](troubleshooting.md)

渲染宿主是普通 Node 进程：Playwright 管理无头 Chrome / Edge，Node 提供 HTTP API、静态资源托管、云端目录/按需物化、内置 AI 导演与 ffmpeg 编码。
支持 Windows / Linux / macOS，不依赖 Electron；Linux 无头服务器不需要 Xorg / Xvfb 或桌面环境。

本文导航：[依赖](#依赖) · [平台差异](#按平台) · [构建与启动](#构建与启动) · [配置与环境变量](#配置与环境变量) · [常驻运行](#常驻运行) · [配置建议](#配置建议) · [启停检查](#启动与停止检查清单) · [GPU](#webgl-硬件加速) · [安全](#安全提示)

## 架构

```text
Node 宿主
├─ :9881  HTTP API          导出、AI 生成、资源目录、云端刷新、健康检查
├─ :9881  静态托管          / 渲染页面 · /resources/* · /apifile/*
├─ :9881  /bridge/*         渲染端与宿主桥接层（文件写入、TTS/翻译代理、WS）
└─ RenderPool              N 个无头浏览器页面，每页独立 WebGL 上下文
```

`POST /api/v1/export` 与 `POST /api/v1/generate` 提交的故事进入统一队列，并发上限由 `render.maxConcurrentExports`（`0` 时跟随 `render.workers`）控制。

### 取消与故障恢复

- 取消或客户端断连后，仍在缓冲队列中的任务会直接移除，不再开始渲染。
- 正在渲染的任务收到中止通知后有 60 秒宽限期；超时未返回时，宿主在 15 秒巡检周期内重启该 worker 的浏览器并恢复就绪。
- 其余 worker 上的任务互不干扰。

`npm run test:pool` 可在无浏览器与模型资源的环境下验证取消、超时、并发隔离与恢复。

## 依赖

| 组件                     | 要求                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                  | ≥ 20，推荐 22 LTS                                                                                                                                                   |
| Chrome / Edge / Chromium | 默认按 `msedge` → `chrome` → `chromium` 探测；无系统浏览器时先执行 `npx playwright install chromium`                                                                |
| ffmpeg                   | 优先 `MSS_FFMPEG_PATH`，其次依赖包 `ffmpeg-static`，最后系统 `PATH`                                                                                                 |
| GPU 驱动                 | 推荐安装独显或核显驱动；无 GPU 也可软件渲染，编码设为 `libx264`                                                                                                     |
| 网络（零本地云端模式）   | 启用 `assets.cloudCatalog: true` 时需能访问 `assets.pjsk.moe`、`storage.exmeaning.com` 与（可选）`cdn.jsdelivr.net`；内网环境可关闭 `cloudCatalog` 或预拉取本地资源 |

建议直接在宿主机运行 Node 进程，避免 Docker 中无头浏览器 GPU 透传的额外排障成本。

## 按平台

| 平台    | 浏览器与 WebGL                                         | 视频编码                                       |
| ------- | ------------------------------------------------------ | ---------------------------------------------- |
| Windows | 系统 Edge / Chrome 通常可直接使用独显或核显            | 可探测 NVENC / AMF / QSV                       |
| Linux   | Chrome / Chromium；NVIDIA 无 X 环境的 ANGLE 设置见下文 | ffmpeg 需包含并能使用相应硬件编码器            |
| macOS   | Chrome / Edge，使用系统 GPU                            | 当前不探测 VideoToolbox，`auto` 回退 `libx264` |

`video.encoder: auto` 在宿主启动时依次探测 `h264_nvenc`（`nvidia`）→ `h264_amf`（`amd`）→ `h264_qsv`（`intel`），全部失败回退 `libx264`。不要把 `nvenc` 直接填到 `video.encoder`。

## 构建与启动

首次安装见 [README 快速开始](../README.md#快速开始)。默认开启云端目录，**空 `resources/` 目录即可启动**：

```bash
cp config.example.yaml config.yaml   # 可选：不复制则全部使用 src/host/config.ts 内置默认值
export MSS_LLM_API_KEY=sk-...        # 若需使用 /api/v1/script/generate 或 /api/v1/generate
npm run build
npm start
```

`npm run build` 包含 `typecheck`、`vite build`（输出 `out/webrenderer/`）和 `tsc -p tsconfig.node.json`（输出 `out-host/`）；`npm start` 执行 `node out-host/host/main.js`。

## 配置与环境变量

宿主主配置位于根目录 `config.yaml`（由 [config.example.yaml](../config.example.yaml) 复制，不入库）；BGM 还可由 `resources/audio/bgm/bgm.yaml` 独立配置（不存在且无 `bg1.mp3` 时自动回落云端 `bgm00003`）。

优先级：**`MSS_*` 环境变量 > `config.yaml` > `src/host/config.ts` 内置默认值**。

| 环境变量                                                                                        | 对应配置 / 作用                                                   |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `MSS_PORT` / `MSS_HOST`                                                                         | `server.port` / `server.host`                                     |
| `MSS_VIDEO_WIDTH` / `MSS_VIDEO_HEIGHT` / `MSS_VIDEO_FPS` / `MSS_VIDEO_CRF`                      | 输出分辨率、帧率、质量因子                                        |
| `MSS_FFMPEG_ENCODER` / `MSS_FFMPEG_PATH`                                                        | `video.encoder` / 显式 ffmpeg 可执行文件                          |
| `MSS_EXPORT_MODE` / `MSS_EXPORT_BITRATE`                                                        | `video.exportMode`（`record`/`fast`）/ fast WebCodecs 码率        |
| `MSS_EXPORT_FAST_ENCODER` / `MSS_FAST_FPS`                                                      | fast 编码路径（`auto`/`webcodecs`/`frames`）/ fast 帧率上限       |
| `MSS_RECORD_TARGET_SIZE_MB`                                                                     | `video.recordTargetSizeMb`（record 收尾成片体积上限 MiB，0=不限） |
| `MSS_VIDEO_WATERMARK` / `MSS_VIDEO_WATERMARK_TEXT`                                              | 水印开关 / 自定义水印文字                                         |
| `MSS_IDLE_CHAIN_GAP_SEC` / `MSS_TTS_MODE`                                                       | 动作续演间隔秒数 / `serial` 或 `concurrent`                       |
| `MSS_WORKERS` / `MSS_MAX_CONCURRENT_EXPORTS` / `MSS_WORKER_RECYCLE_EXPORTS`                     | worker 数量 / 导出并发上限 / 按导出次数回收周期                   |
| `MSS_BROWSER_CHANNELS` / `MSS_BROWSER_EXECUTABLE` / `MSS_CHROME_ARGS`                           | 浏览器探测顺序（逗号分隔）/ 可执行路径 / 附加参数                 |
| `MSS_LINUX_GPU_ANGLE` / `MSS_MIN_FREE_MEMORY_MB`                                                | Linux ANGLE 开关 / 派发前最小可用内存 MB                          |
| `MSS_OUTPUT_DIR` / `MSS_RESOURCE_DIR` / `MSS_WEB_RENDERER_DIR`                                  | 输出、资源与渲染端目录                                            |
| `MSS_TTS_ENABLED` / `MSS_TTS_PROVIDER` / `MSS_TTS_API_BASE_URL` / `MSS_TTS_TIMEOUT_MS`          | TTS 开关、后端（`gpt-sovits`/`irodori`）、地址与超时              |
| `MSS_IRODORI_MODEL` / `MSS_IRODORI_NUM_STEPS`                                                   | Irodori 模型名与采样步数                                          |
| `MSS_LLM_ENABLED` / `MSS_LLM_BASE_URL` / `MSS_LLM_API_KEY_ENV` / `MSS_LLM_MODEL`                | LLM 开关、地址、密钥变量名、模型名                                |
| `MSS_LLM_TEMPERATURE` / `MSS_LLM_MAX_TOKENS` / `MSS_LLM_TIMEOUT_MS` / `MSS_LLM_RETRIES`         | LLM 温度、token 上限、超时、重试次数                              |
| `MSS_LLM_REPAIR_ROUNDS` / `MSS_LLM_PIPELINE` / `MSS_LLM_JSON_MODE`                              | 修复轮数、流水线（`staged`/`single`）、JSON 模式                  |
| `MSS_LLM_TRANSLATE` / `MSS_LLM_TARGET_MINUTES` / `MSS_LLM_SYSTEM_PROMPT` / `MSS_LLM_EXTRA_BODY` | TTS 日语翻译开关、目标分钟数、系统提示词、额外请求体 JSON         |
| `MSS_ASSETS_REGION` / `MSS_ASSETS_INDEX_BASE` / `MSS_ASSETS_LIBRARY_BASE` / `MSS_ASSETS_BASE`   | 云端区服（`jp`/`cn`/`tw`/`kr`/`en`）与镜像地址                    |
| `MSS_ASSETS_SOUNDTRACK_BASE` / `MSS_ASSETS_CACHE_DIR`                                           | 曲名索引镜像 / 缓存目录                                           |
| `MSS_ASSETS_CONCURRENCY` / `MSS_ASSETS_TIMEOUT_MS` / `MSS_ASSETS_RETRIES`                       | 下载并发、超时、重试                                              |
| `MSS_ASSETS_CLOUD_CATALOG` / `MSS_ASSETS_CLOUD_CATALOG_TTL_HOURS`                               | 云端目录开关（默认 `true`）与刷新周期                             |
| `MSS_LOG_LEVEL`                                                                                 | `silly` / `trace` / `debug` / `info` / `warn` / `error` / `fatal` |

## 启动后自检

```bash
curl http://127.0.0.1:9881/api/v1/health
curl http://127.0.0.1:9881/api/v1/resources
```

检查 `renderPool.readyWorkers`、真实 GPU `webglRenderers` 与 `cloud` 字段（`models` / `backgrounds` / `bgm` / `se`）。

## 常驻运行

建议将工作目录固定在仓库根目录。

### Linux：systemd

仓库提供 [deploy/mysekai-host.service](../deploy/mysekai-host.service)，按实际用户、仓库路径与环境变量调整后安装：

```bash
sudo cp deploy/mysekai-host.service /etc/systemd/system/mysekai-host.service
sudo systemctl daemon-reload
sudo systemctl enable --now mysekai-host.service
systemctl status mysekai-host.service
```

- 不需要 `DISPLAY` 或 Xorg；宿主的优雅关停排空上限为 120 秒，systemd 的 `TimeoutStopSec` 建议设 `150s`。
- 浏览器由哪个用户安装决定服务账号能否找到它，确保 `User` 对仓库、`resources/`、`cache/`、`apifile/` 与浏览器有读写执行权限。

### Windows / macOS

- **Windows**：使用任务计划程序或 NSSM，程序 `node`、参数 `out-host/host/main.js`、起始于 `<仓库根>`。
- **macOS**：使用 `launchd`、`tmux`/`screen` 或前台 `npm start`。

### 升级代码

```bash
git pull
npm ci
npm run build
# 重启服务进程
```

## 配置建议

### 最小试跑配置

如果不使用 TTS，在 `config.yaml` 中仅关闭 TTS 即可零本地资源开箱运行（BGM 会自动使用云端 `bgm00003`）：

```yaml
server:
  host: 127.0.0.1
  port: 9881

video:
  width: 1280
  height: 720
  fps: 30
  renderScale: 1
  exportMode: record

tts:
  enabled: false

llm:
  enabled: true
  baseUrl: https://api.openai.com/v1
  model: gpt-4.1-mini
```

注意：**省略 `video` 节时的内置默认是 1280×720 / 30fps / `renderScale: 1.5` / `crf: 23`，而 `config.example.yaml` 模板写的是 1920×1080 / 60fps / `renderScale: 1` / `crf: 28`**，详见 [导出模式](export-modes.md)。

### 并发、热备与内存

- 每个渲染 worker 占一个独立无头浏览器页面与 WebGL 上下文（约 300~500 MB 内存）。
- 建议将 `render.workers` 设为比 `render.maxConcurrentExports` 多 1（如 `workers: 3`、`maxConcurrentExports: 2`），保留 1 个热备 worker 在其他 worker 回收或崩溃重启时无缝顶替。
- `workerRecycleExports` 默认为 `5`，防止长驻 Live2D 纹理内存累积；`minFreeMemoryMb` 可在低内存服务器上延迟派发防止 OOM。
- `idleChainGapSec` 默认 `0`（动作播完保持末帧姿势+呼吸眨眼），想改成连续摇晃风格可设正数。
- 共享单槽 TTS 推理（如单 GPU Irodori）时保持默认 `ttsMode: serial`，避免 TTS 与 WebGL/编码争抢算力。

## 启动与停止检查清单

1. `npm ci` 与 `npm run build` 完成，存在 `out/webrenderer/` 与 `out-host/`。
2. 等待日志出现 `Host ready`，并检查 `/api/v1/health` 至少有 1 个 ready worker 且 WebGL 非软件渲染。
3. 发送 `SIGINT` / `SIGTERM` 停止服务时，宿主会等待在途导出最多 120 秒再释放浏览器池。

## WebGL 硬件加速

若 `/api/v1/health` 显示 `SwiftShader` 或 `llvmpipe`，在 `config.yaml` 的 `render` 节调整参数（一次只改一项）：

- **Linux + NVIDIA 无 X 环境**：将 `linuxGpuAngle: false` 并设 `extraChromeArgs: "--use-angle=vulkan"`。
- **Linux 有 X11/GLX**：保留 `linuxGpuAngle: true`（自动追加 `--use-angle=gl`）。
- 优先使用系统完整版 Chrome / Edge，避免落到 Playwright 的 `chrome-headless-shell`。

## 安全提示

API 默认监听 `0.0.0.0` 且**没有内置鉴权**，IP 限流不能替代访问控制。请优先部署在可信内网；需要公网访问或对接远程机器人（如 [astrbot_plugin_msst](https://github.com/yonglanws/astrbot_plugin_msst)）时，应前置 nginx / Caddy 反向代理并配置鉴权与超时，同时禁止外部直接访问 `/bridge` 与内部管理端点。
