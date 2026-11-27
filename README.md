<div align="center">

# MySekaiStoryteller-API

**无头纯 API 的 Project SEKAI 风格 Live2D 视频渲染服务**

*Headless HTTP API server for Project SEKAI-style Live2D video rendering & AI scriptwriting*

<a href="#它能做什么">它能做什么</a> ·
<a href="#docker-一键部署">Docker 一键部署</a> ·
<a href="#三分钟上手">三分钟上手</a> ·
<a href="#常用接口">常用接口</a> ·
<a href="#文档导航">文档导航</a> ·
<a href="#english-summary">English</a> ·
<a href="#相关项目与协议">相关项目与协议</a>

</div>

> [!IMPORTANT]
> 本项目基于 [Untitled-Story/MySekaiStoryteller](https://github.com/Untitled-Story/MySekaiStoryteller) 二次开发，专注做后台 HTTP API 渲染与 AI 自动编剧。需要桌面端可视化编辑器请前往原项目。
>
> **从 `v0.2.0` 升级？** `v1.0.0-beta1` 对整体架构进行了彻底重构（原生 Rust 引擎 + 二进制 WS 管道、零本地云端素材体系、内置 58 份 PJSK 人设与三段式 AI 编剧、原生 Docker 与配置体系等），请务必先阅读 [CHANGELOG.md](CHANGELOG.md) 与 [系统架构指南](doc/architecture.md)。

## 它能做什么

给它一份 `*.sekai-story.json` 剧本，或者只给一句场景描述，它就能在服务器后台用无头 Chrome / Edge 跑 PixiJS + Live2D，加上配音、背景音乐和特效，直接输出 PJSK 风格的 MP4 视频。

支持 Windows / Linux / macOS，不需要桌面环境或 Electron；配合官方 AstrBot 插件，可以直接在 QQ / Telegram 里用一句话生成并发出视频。

核心特点：

- **零本地素材即可开箱运行**：默认配置模板（`config.example.yaml`、`.env.example`、`npm run init` 与 Docker）默认启用 `assets.cloudCatalog: true` + `assets.cloudOnly: true`，空 `resources/` 目录即可自动拉取云端目录并在导出前按需下载本次用到的模型、背景、BGM 和音效。如需优先使用本地 `resources/` 自定义素材或 YAML 清单，将 `assets.cloudOnly` 设为 `false`（或 `MSS_ASSETS_CLOUD_ONLY=false`）即可切换为本地优先覆盖。
- **全套官方云端素材索引**：内置中文语义索引并对接 Moesekai / Sekai-World，覆盖 **574** 套 Live2D 模型（26 位主要角色的多套服装 + 配角/特别角色）、**1,402** 张带地点/时段标签的背景、**421** 首 BGM 和 **1,991** 条场景音效（SE）。无自定义 BGM 时，默认使用云端日常曲 `bgm00003`（`Slapstick!!`）兜底。
- **内置 58 份 PJSK 角色人设与统一三段式 AI 编剧**：仓库直接内置 `personas/pjsk/`（全部 58 份重写 PJSK 角色人设，本地与 Docker `/app/personas/pjsk` 均开箱自动发现，支持通过 `llm.personaDirs` / `MSS_LLM_PERSONA_DIRS` 叠加覆盖或 `none` 禁用）。配好任意 OpenAI 兼容模型后，一句描述即可自动选角、检索官方语义 RAG、写台词、配表情动作、切镜头、翻成日语配音文案并做导演终审修补，支持 `staged`（默认确定性多阶段）、`hybrid` / `agent`（统一三段式上下文隔离 + Phase 1 只读工具探索 + Phase 3 轻量导演终审闭环）与 `single`（单次极速省流/`chat`）。
- **原生 Rust + 二进制 WebSocket 流式导出**：基于固定 `1/60s`（60Hz）虚拟时钟推进动画并保证 30fps / 60fps Live2D 演出逐帧对齐，优先走 WebCodecs GPU YUV420 直编或通过 Rust `/bridge/rs-stream` 二进制 WebSocket 管道（3-slot PBO + `texSubImage2D` + 零拷贝帧重复）直连原生 Rust 导出器（`native/mss-export-rs`），加速口型包络、多轨混音（默认 BGM 音量 `0.35` + 人声闪避）与硬件编码/合流收尾。
- **可选语音合成与混音**：支持 GPT-SoVITS 和 IrodoriTTS（支持 LoRA、多参考音频、音色锁定与情绪标签），按官方 60Hz RMS 曲线驱动真实音频口型；不开 TTS 也能正常导出纯画面或纯 BGM 视频。
- **生产级队列与运维能力**：支持同步等待或异步轮询（`wait: false`）、随时取消并清理临时文件、优雅停机排空（`503` 拒收新单）、HTTP `Range` 断点下载、Bearer Token 鉴权、CORS 白名单、IP 限流（429）、诊断日志和过期文件自动清理。

## Docker 一键部署

内置多阶段 `Dockerfile`（自带完整版 Playwright Chromium、Rust 原生导出器、58 份内置 PJSK 人设 `/app/personas/pjsk`、`ffmpeg`、中文字体及 Mesa/VAAPI/Vulkan 驱动），支持**纯环境变量零 `config.yaml` 启动**、云端素材按需拉取，并默认开启 `init: true` 与 Linux glibc 低碎片参数（`MALLOC_ARENA_MAX=2`、`MALLOC_MMAP_THRESHOLD_=131072`）：

```bash
git clone https://github.com/yonglanws/MySekaiStoryteller-API.git
cd MySekaiStoryteller-API

# 复制环境变量模板，填入 MSS_LLM_API_KEY（以及可选的 MSS_LLM_BASE_URL / MSS_LLM_MODEL）
cp .env.example .env

# 默认启动（CPU / 自动探测）
docker compose up -d --build

# 国内网络加速构建（Rust 使用 rsproxy.cn，npm 使用 npmmirror）
BUILD_MIRROR=cn docker compose up -d --build

# Intel 核显 / Arc（VAAPI + QSV + Vulkan，透传 /dev/dri）
docker compose -f docker-compose.yml -f docker-compose.intel.yml up -d

# NVIDIA 独显（NVENC + Vulkan，需宿主机安装 NVIDIA Container Toolkit）
docker compose -f docker-compose.yml -f docker-compose.nvidia.yml up -d
```

- **低内存主机 / NAS（4~8 GB RAM）**：在 `.env` 中设置 `MSS_MEMORY_PROFILE=low`（自动应用 `workers=1`、`maxConcurrentExports=1`、`workerRecycleExports=2`、`fps=30`、`fastFps=30`、`renderScale=1.0`；需注释 `.env` 中显式的 `MSS_VIDEO_FPS` / `MSS_FAST_FPS` 以免覆盖）。
- **自定义人设叠加**：默认已打包 `/app/personas/pjsk`；如需扩展或覆盖同名角色，在 `docker-compose.yml` 挂载 `./custom-personas:/app/custom-personas:ro` 并设置 `MSS_LLM_PERSONA_DIRS=/app/personas/pjsk,/app/custom-personas`（切勿直接覆盖挂载 `/app/personas`）。
- **GPU 预设**：可通过 `MSS_GPU_PROFILE`（或 `MSS_GPU_MODE`）在 `auto` / `intel` / `nvidia` / `amd` / `cpu` 间一键切换。完整参数与挂载说明见 [部署指南](doc/host-deployment.md#docker-一键部署)。

## 三分钟上手

宿主机直接运行需要 **Node.js ≥ 20** 和 Chrome / Edge / Chromium（`ffmpeg` 会随 `ffmpeg-static` 自动装好）。

以下命令在仓库根目录执行（Windows 推荐 PowerShell 或 Git Bash）：

```bash
git clone https://github.com/yonglanws/MySekaiStoryteller-API.git
cd MySekaiStoryteller-API
npm ci

# 如果机器上没有安装 Chrome 或 Edge，再补装 Chromium
npx playwright install chromium

# 推荐：运行交互式配置向导，自动生成 config.yaml 与 .env（密钥仅写入 .env 且不回显）
npm run init
```

> 也可以用 `npm run init -- --non-interactive --gpu auto --memory standard --llm-url https://api.openai.com/v1 --llm-model gpt-4.1-mini --llm-key sk-...` 做无人值守初始化，或直接手动 `cp config.example.yaml config.yaml` 并把 `MSS_LLM_API_KEY=sk-...` 写入 `.env`。宿主启动（`npm start`）会**自动加载根目录 `.env`**（已设置的系统环境变量始终优先，也可用 `MSS_ENV_FILE` 指定路径），无需手动 `source .env`。不创建 `config.yaml` 也能以内置默认值启动。

编译并启动服务：

```bash
npm run build
npm start
```

另开一个终端检查状态：

```bash
curl http://127.0.0.1:9881/api/v1/health
curl http://127.0.0.1:9881/api/v1/resources
```

看下 `/api/v1/health` 返回里的 `renderPool.webglRenderers`（应显示真实显卡名，若为 `SwiftShader` 或 `llvmpipe` 说明走成了 CPU 软渲染，请看 [故障排除](doc/troubleshooting.md)）和 `llm.personas`（默认应显示 `58`）。

## 常用接口

默认监听 `http://127.0.0.1:9881`。配好 `llm` 后，零本地素材就能直接一句话生成剧本或导出视频：

```bash
# 只生成剧本 JSON
curl -sS -X POST http://127.0.0.1:9881/api/v1/script/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "放学后的教室里，瑞希和绘名聊起下次 Live"}'

# 生成剧本并直接渲染 MP4
curl -sS -X POST http://127.0.0.1:9881/api/v1/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "深夜的无人 SEKAI，奏和真冬聊起写不出来的歌"}'
```

如果已经有 `*.sekai-story.json`（里面的模型、背景、BGM 可以直接写云端名字或 id），直接提交导出：

```bash
node -e 'const fs = require("node:fs"); process.stdout.write(JSON.stringify({story: JSON.parse(fs.readFileSync(process.argv[1], "utf8")), timeout: 600000}))' \
  ./your-story.sekai-story.json |
  curl -X POST http://127.0.0.1:9881/api/v1/export \
    -H "Content-Type: application/json" --data-binary @-
```

默认会保持连接直到渲染完成，返回 `downloadUrl` 和诊断文件路径；走反代或机器人怕 HTTP 超时，可以传 `"wait": false` 拿 `taskId` 去轮询状态。详细参数见 [API 参考](doc/api.md)。

> [!WARNING]
> 服务默认绑定 `0.0.0.0:9881`，且**未设置 `server.apiKey` / `MSST_API_KEY` 时默认不鉴权**。如果部署到公网或局域网，务必设置 Bearer 密钥、限制 CORS 来源并套反向代理（禁止暴露 `/bridge/*`），详见 [安全策略与加固指南](SECURITY.md) 与 [部署指南](doc/host-deployment.md#安全提示)。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run init` | 交互式配置向导：生成 `config.yaml` 与 `.env`（支持 `--non-interactive`） |
| `npm run build` | 类型检查 + 打包前端渲染页 + 编译 Node 宿主 |
| `npm run build:rust` / `test:rust` | 编译 / 测试原生 Rust 导出与混音扩展（`native/mss-export-rs`） |
| `npm start` | 启动服务（`node out-host/host/main.js`，自动加载 `.env`） |
| `npm run typecheck` | 分别检查宿主和渲染器 TypeScript 类型 |
| `npm run lint` / `npm run format:check` | ESLint 与 Prettier 代码格式检查 |
| `npm test` / `npm run test:all` / `test:stories` | 核心回归 / 自动发现全量单元测试 / 官方基线与 AI 剧本测试 |
| `npm run test:pool` / `test:config` / `test:export` / `test:renderer` / `test:tts` | 按模块跑专项测试 |
| `npm run fetch:models` / `npm run fetch:media` | 可选 CLI：预先把云端模型、背景或 BGM 下载到本地 `resources/` |
| `npm run e2e` | 运行端到端导出验证（需先启动服务；无本地剧本时自动使用内置纯云端示例） |

## 文档导航

| 文档 | 讲什么 |
| --- | --- |
| [文档总览](doc/README.md) | 按你的目的（部署、AI 编剧、写剧本、提速调参、排障）推荐阅读顺序 |
| [系统架构指南](doc/architecture.md) | 系统模块边界、Mermaid 数据流图、三段式 AI 管线、渲染池与 Rust 二进制桥接架构 |
| [API 参考](doc/api.md) | 导出、AI 生成、云端目录查询、进度轮询、取消、Range 下载、优雅停机与自动清理 |
| [宿主内置 AI 剧本生成](doc/ai-script.md) | LLM/RAG 配置、内置 58 份 PJSK 人设、统一三段式流水线与质量评测 |
| [云端资源获取](doc/cloud-assets.md) | 零本地资源原理、574 模型 / 1,402 背景 / 421 BGM / 1,991 SE 索引、`cloudOnly` 模式与 CLI |
| [资源与音频配置](doc/resources.md) | `resources/` 目录结构、`cloudOnly: false` 本地覆盖、GPT-SoVITS / IrodoriTTS 与 BGM |
| [故事文件格式](doc/story-format.md) | 完整剧本 JSON 示例、全部片段类型、舞台坐标与 60fps 官方节奏规则 |
| [导出模式与提速调参](doc/export-modes.md) | `fast` 管线、WebCodecs、Rust `/bridge/rs-stream` 二进制 WS 管道、30fps 对齐与调优 |
| [部署指南](doc/host-deployment.md) | Docker 一键部署、`.env` 自动加载、全量环境变量、GPU 加速、低内存预设与 systemd |
| [故障排除](doc/troubleshooting.md) | 浏览器启动失败、软渲染太慢、云端下载失败、人设/配音与动作表情异常排查 |
| [开发与验证](doc/development.md) | 模块化源码结构、构建与自动发现测试命令、E2E 与成片检查清单 |
| [贡献指南](CONTRIBUTING.md) · [安全策略](SECURITY.md) · [更新日志](CHANGELOG.md) | 开发环境搭建、PR 检查清单、自托管加固与版本迁移说明 |

## English Summary

**MySekaiStoryteller-API** is a headless, API-only Project SEKAI-style Live2D video rendering and AI scriptwriting server built on Node.js (≥ 20), Playwright + PixiJS/Live2D, and a native Rust export/audio engine (`native/mss-export-rs`).

- **Zero-local-asset startup**: Cloud catalog indexes **574** Live2D models, **1,402** backgrounds, **421** BGM tracks, and **1,991** SE cues on demand (`cloudOnly: true` in default templates; set `cloudOnly: false` to enable local `resources/` overrides).
- **Built-in personas & 3-stage AI writer**: Bundles **58** rewritten PJSK character personas in `personas/pjsk/` (auto-discovered locally and in Docker) plus OpenAI-compatible 3-stage script generation (`staged` / `hybrid` / `single`) and semantic RAG.
- **Fast deterministic export**: Virtual 60Hz clock, WebCodecs GPU YUV420 encoding, Rust `/bridge/rs-stream` binary WebSocket rawvideo piping, hardware encoding (NVENC / QSV / VAAPI / AMF), and optional GPT-SoVITS / IrodoriTTS lip-synced audio.
- **Quick start**: `cp .env.example .env` (set `MSS_LLM_API_KEY`) → `docker compose up -d --build`, or locally `npm ci && npm run init && npm run build && npm start`.
- **Key docs**: [Architecture](doc/architecture.md) · [API Reference](doc/api.md) · [Deployment](doc/host-deployment.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Video License (EN)](VIDEO-LICENSE.md)

## 相关项目与协议

- [astrbot_plugin_msst](https://github.com/yonglanws/astrbot_plugin_msst)：官方 AstrBot 插件（独立仓库），对接本服务实现机器人内一句话生成剧本与回传视频。
- 开源协议沿用原作者的 **[GNU GPL v3](LICENSE)**；导出视频的使用受原项目 [VIDEO-LICENSE-CN.md](VIDEO-LICENSE-CN.md) / [VIDEO-LICENSE.md](VIDEO-LICENSE.md) 约束。

## 致谢

[Untitled-Story/MySekaiStoryteller](https://github.com/Untitled-Story/MySekaiStoryteller) ·
[Sekai-World/sekai-viewer](https://github.com/Sekai-World/sekai-viewer) ·
[lezzthanthree/SEKAI-Stories](https://github.com/lezzthanthree/SEKAI-Stories)
