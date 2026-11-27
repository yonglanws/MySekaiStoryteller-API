<div align="center">

# MySekaiStoryteller-API

**无头纯 API 的 Project SEKAI 风格 Live2D 视频渲染服务**

<a href="#它能做什么">它能做什么</a> ·
<a href="#docker-一键部署">Docker 一键部署</a> ·
<a href="#三分钟上手">三分钟上手</a> ·
<a href="#常用接口">常用接口</a> ·
<a href="#文档导航">文档导航</a> ·
<a href="#相关项目与协议">相关项目与协议</a>

</div>

> [!IMPORTANT]
> 本项目基于 [Untitled-Story/MySekaiStoryteller](https://github.com/Untitled-Story/MySekaiStoryteller) 二次开发，专注做后台 HTTP API 渲染与 AI 自动编剧。需要桌面端可视化编辑器请前往原项目。

## 它能做什么

给它一份 `*.sekai-story.json` 剧本，或者只给一句场景描述，它就能在服务器后台用无头 Chrome / Edge 跑 PixiJS + Live2D，加上配音、背景音乐和特效，直接输出 PJSK 风格的 MP4 视频。

支持 Windows / Linux / macOS，不需要桌面环境或 Electron；配合官方 AstrBot 插件，可以直接在 QQ / Telegram 里用一句话生成并发出视频。

核心特点：

- **空目录也能直接跑**：默认开启 `assets.cloudCatalog`。就算 `resources/` 是空的、你也没写任何 YAML 清单，启动后会自动拉取云端索引，并在导出前只下载本次用到的模型、背景、BGM 和音效。你自己在 `resources/` 里放的本地文件仍然最优先。
- **全套官方云端素材索引**：内置简化后的中文语义索引并对接 Moesekai / Sekai-World，覆盖 **511** 套 Live2D 模型（26 位主要角色的多套服装 + 48 位配角）、**1,401** 张带地点/时段标签的背景、**421** 首 BGM 和 **1,942** 条场景音效（SE）。本地没配默认 BGM 时，会自动用云端日常曲 `bgm00003`（`Slapstick!!`）兜底。
- **内置 AI 编剧（统一三段式管线 + 工具驱动）**：配好任意 OpenAI 兼容模型后，一句描述就能自动选角、加载完整人格设定与官方 RAG 语料、写台词、配表情动作、切镜头、翻成日语配音文案并做导演终审修补。支持 `staged`（默认确定性多阶段）、`hybrid` / `agent`（统一三段式上下文隔离 + Phase 1 只读工具探索 + Phase 3 轻量导演终审闭环）与 `single`（单次极速省流/`chat`）。
- **原生 Rust + 虚拟时钟快速导出**：基于固定 `1/60s` 虚拟时钟推进画面（不受电脑卡顿影响成片节奏），优先走 WebCodecs GPU YUV420 直编或 WebGL2 `rawvideo` / `image2pipe` 管道，并内置原生 Rust 导出器（`native/mss-export-rs`）加速口型包络、音轨混音（默认 BGM 音量 `0.35` + 人声闪避）与硬件 CRF/remux 收尾。
- **可选语音合成与混音**：支持 GPT-SoVITS 和 IrodoriTTS（支持 LoRA、多参考音频和情绪标签），按官方 RMS 曲线驱动真实音频口型；不开 TTS 也能正常导出纯画面或纯 BGM 视频。
- **队列与运维能力**：支持同步等待或异步轮询（`wait: false`）、随时取消并清理临时文件、Bearer Token 鉴权、CORS 白名单、IP 限流（429）、诊断日志和过期文件自动清理。

## Docker 一键部署

内置多阶段 `Dockerfile`（自带完整版 Playwright Chromium、Rust 原生导出器、ffmpeg、中文字体及 Mesa/VAAPI 驱动），支持**纯环境变量零 `config.yaml` 启动**、云端素材按需拉取，并默认开启 `init: true` 与 Linux glibc 低碎片参数（`MALLOC_ARENA_MAX=2`、`MALLOC_MMAP_THRESHOLD_=131072`）：

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

> 也可以用 `npm run init -- --non-interactive --gpu auto --memory standard --llm-url https://api.openai.com/v1 --llm-model gpt-4.1-mini --llm-key sk-...` 做无人值守初始化，或直接手动 `cp config.example.yaml config.yaml` 并设置 `export MSS_LLM_API_KEY=sk-...`（PowerShell 用 `$env:MSS_LLM_API_KEY = "sk-..."`）。不创建 `config.yaml` 也能以内置默认值启动，宿主启动时会自动输出配置体检提示。

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

看下 `/api/v1/health` 返回里的 `renderPool.webglRenderers`：显示真实显卡名就对了；如果看到 `SwiftShader` 或 `llvmpipe`，说明走成了 CPU 软渲染，导出会慢很多，请看 [故障排除](doc/troubleshooting.md)。

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
> 服务默认绑定 `0.0.0.0:9881`，且**未设置 `server.apiKey` / `MSST_API_KEY` 时默认不鉴权**。如果部署到公网或局域网，务必设置 Bearer 密钥、限制 CORS 来源并套反向代理，详见 [部署指南](doc/host-deployment.md#安全提示)。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run init` | 交互式配置向导：生成 `config.yaml` 与 `.env`（支持 `--non-interactive`） |
| `npm run build` | 类型检查 + 打包前端渲染页 + 编译 Node 宿主 |
| `npm run build:rust` / `test:rust` | 编译 / 测试原生 Rust 导出与混音扩展（`native/mss-export-rs`） |
| `npm start` | 启动服务（`node out-host/host/main.js`） |
| `npm run typecheck` | 分别检查宿主和渲染器 TypeScript 类型 |
| `npm run lint` / `npm run format:check` | ESLint 与 Prettier 代码格式检查 |
| `npm test` / `npm run test:all` / `test:stories` | 核心回归 / 全量单元测试 / 官方基线与 AI 剧本测试 |
| `npm run test:pool` / `test:config` / `test:export` / `test:renderer` / `test:tts` | 按模块跑专项测试 |
| `npm run fetch:models` / `npm run fetch:media` | 可选 CLI：预先把云端模型、背景或 BGM 下载到本地 `resources/` |
| `npm run e2e` | 运行端到端导出验证（需先启动服务） |

## 文档导航

| 文档 | 讲什么 |
| --- | --- |
| [文档总览](doc/README.md) | 按你的目的（部署、AI 编剧、写剧本、提速调参、排障）推荐阅读顺序 |
| [API 参考](doc/api.md) | 导出、AI 生成、云端目录查询、进度轮询、取消、下载与自动清理接口 |
| [宿主内置 AI 剧本生成](doc/ai-script.md) | LLM/RAG 配置、多阶段导演流程、Agent 工具调用架构、人设与质检规则 |
| [云端资源获取](doc/cloud-assets.md) | 零本地资源原理、云端语义目录覆盖范围、按需下载与离线预拉取命令 |
| [资源与音频配置](doc/resources.md) | `resources/` 目录结构、本地 YAML 覆盖规则、GPT-SoVITS / IrodoriTTS 与 BGM |
| [故事文件格式](doc/story-format.md) | 完整剧本 JSON 示例、全部片段类型、舞台坐标与 60fps 官方节奏规则 |
| [导出模式与提速调参](doc/export-modes.md) | `fast` 导出流程、配置默认值、GPU YUV420/WebCodecs/`rawvideo` 提速与耗时指标 |
| [部署指南](doc/host-deployment.md) | Docker 一键部署、交互式向导、全量环境变量、GPU 加速、低内存预设与安全建议 |
| [故障排除](doc/troubleshooting.md) | 浏览器启动失败、软渲染太慢、云端下载失败、没声音、动作表情异常排查 |
| [开发与验证](doc/development.md) | 源码结构、构建与测试命令、E2E 与成片检查清单 |

## 相关项目与协议

- [astrbot_plugin_msst](https://github.com/yonglanws/astrbot_plugin_msst)：官方 AstrBot 插件，对接本服务实现机器人内一句话生成剧本与回传视频。
- 开源协议沿用原作者的 **[GNU GPL v3](LICENSE)**；导出视频的使用受原项目 [VIDEO-LICENSE-CN.md](VIDEO-LICENSE-CN.md) 约束。

## 致谢

[Untitled-Story/MySekaiStoryteller](https://github.com/Untitled-Story/MySekaiStoryteller) ·
[Sekai-World/sekai-viewer](https://github.com/Sekai-World/sekai-viewer) ·
[lezzthanthree/SEKAI-Stories](https://github.com/lezzthanthree/SEKAI-Stories)
