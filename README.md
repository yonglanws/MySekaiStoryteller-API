<div align="center">

# MySekaiStoryteller-API

**无头纯 API 的 Project SEKAI 风格 Live2D 视频渲染框架**

<a href="#项目简介">项目简介</a> ·
<a href="#快速开始">快速开始</a> ·
<a href="#api-接口">API 接口</a> ·
<a href="#文档导航">文档导航</a> ·
<a href="#相关内容">相关内容</a>

</div>

> [!IMPORTANT]
> 本项目基于 [Untitled-Story/MySekaiStoryteller](https://github.com/Untitled-Story/MySekaiStoryteller) **二次开发**，
> 如需桌面编辑器，请访问原项目。
> 感谢原作者 [GuangChen2333](https://github.com/GuangChen2333) 与 [Untitled-Story](https://github.com/Untitled-Story) 组织。

## 项目简介

接收 `*.sekai-story.json` 剧本或一句场景描述，通过 HTTP API 渲染并导出 Project SEKAI 风格的 Live2D MP4 视频。

不依赖 Electron 或桌面环境，支持 Windows / Linux / macOS；配合官方 AstrBot 插件，可自动生成剧本并向 QQ / Telegram 发送视频。

- **云端优先、零本地资源开箱即用**：默认开启 `assets.cloudCatalog`，无需预先下载模型、背景、BGM、SE 或手写 YAML 清单（空 `resources/` 目录即可启动、生成与导出）。全局默认 BGM 在本地缺失 `bgm.yaml` 与 `resources/audio/bgm/bg1.mp3` 时自动回落至云端日常曲 `bgm00003`；若在 `resources/` 下显式放置本地文件或 YAML 清单，本地资源依然优先。
- **全量官方语义云端目录**：接入 Moesekai / exmeaning / Sekai-World / 官方剧情语料，覆盖 **511** 套 Live2D 模型（26 位主要角色多服装变体 + 48 位配角/特别角色）、**1,401** 张含中文地点/时段/室内外标签的背景、**421** 首剧情与区域 BGM（400 首剧情 BGM + 21 首 `area_bgm`）以及 **1,942** 条场景音效（SE），导出前按需物化至 `resources/*/cloud/`。
- **五阶段宿主内置 AI 导演**：配置任意 OpenAI 兼容 LLM 后，由一句场景描述自动完成「选角与分幕 (`cast`) → 逐字对白 (`dialogue`) → 三路并行（TTS 情绪分段 `emotion` / 舞台调度与运镜音效 `directStaging` / 日文 `ttsText` 批量翻译）→ 精细演技与两拍微表演 (`direction`) → 官方时间线合成与七项硬指标校验 (`composeStory` + `OfficialLinter`)」。
- **无头渲染与 `fast` 导出管线**：PixiJS + Live2D 运行于 Playwright 管理的 Chrome / Edge 渲染池（`render.workers` 控制常驻渲染页数）；唯一活跃渲染管线为 `fast` 虚拟时钟逐帧渲染（默认并发 TTS `ttsMode: concurrent`、5 帧 WebCodecs 硬件测速 + `image2pipe` / 帧序列回退，硬件编码失败自动回退 CPU `libx264`）。
- **可选配音与混音**：支持 GPT-SoVITS 与 IrodoriTTS（LoRA、参考音频、caption 与情绪标签）以及按公式对齐官方的 RMS 口型驱动；无 TTS 也可导出纯画面或纯 BGM 视频。
- **任务管理**：同步或异步（`wait: false` + 状态轮询）导出队列、并发上限控制、取消、Bearer 鉴权与 CORS 白名单、IP 限流（HTTP 429）、诊断日志（`.log` / `.log.json` / `.report.txt`）与过期文件/临时目录自动清理。

## 快速开始

需要 **Node.js ≥ 20** 和 Chrome / Edge / Chromium（`ffmpeg` 由 `ffmpeg-static` 随依赖安装）。
以下命令在仓库根目录执行（Windows 可使用 Git Bash 或 PowerShell）：

```bash
git clone https://github.com/yonglanws/MySekaiStoryteller-API.git
cd MySekaiStoryteller-API
npm ci
# 仅在没有系统 Chrome / Edge 时执行
npx playwright install chromium
cp config.example.yaml config.yaml
```

> [!TIP]
> **零本地资源即可运行**：默认开启 `assets.cloudCatalog: true`，即使 `resources/` 为空目录，宿主也会自动拉取云端目录、在导出前按需下载模型/背景/BGM/SE，并在无 `bgm.yaml` / `bg1.mp3` 时自动使用云端日常曲 `bgm00003` 作为全局 BGM。
> 如需使用自己的模型、背景或曲目，按 [资源与音频配置](doc/resources.md) 放入 `resources/` 即可覆盖云端同名项；如需离线预拉取资源，见 [云端资源获取](doc/cloud-assets.md)。

要在宿主里启用 AI 一句话写剧本 / 生成视频，设置 LLM 密钥并配置 `config.yaml` 中的 `llm`（详见 [宿主内置 AI 剧本生成](doc/ai-script.md)）：

```bash
export MSS_LLM_API_KEY=sk-...
# config.yaml 中设置 llm.baseUrl 与 llm.model（默认 pipeline: staged）
```

构建并启动宿主：

```bash
npm run build
npm start
```

另开终端检查服务状态与云端目录：

```bash
curl http://127.0.0.1:9881/api/v1/health
curl http://127.0.0.1:9881/api/v1/resources
```

`renderPool.webglRenderers` 应显示真实 GPU 名称；若出现 `SwiftShader` / `llvmpipe`，见 [故障排除](doc/troubleshooting.md)。
常驻运行、平台差异与环境变量见 [部署指南](doc/host-deployment.md)。

## API 接口

默认监听 `http://127.0.0.1:9881`。启用 `llm` 后，零本地资源即可一句话生成剧本或完整 MP4 视频：

```bash
# 仅生成剧本（返回 StoryData、阶段耗时 meta 与 scriptPath）
curl -sS -X POST http://127.0.0.1:9881/api/v1/script/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "放学后的教室里，瑞希和绘名聊起下次 Live"}'

# 生成剧本并直接导出 MP4 视频
curl -sS -X POST http://127.0.0.1:9881/api/v1/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "深夜的无人 SEKAI，奏和真冬聊起写不出来的歌"}'
```

也可以直接提交符合 [故事文件格式](doc/story-format.md) 的 `*.sekai-story.json`（支持写本地路径，也支持直接写云端背景名/id、曲名/id 或 `cloud/` 模型路径）：

```bash
node -e 'const fs = require("node:fs"); process.stdout.write(JSON.stringify({story: JSON.parse(fs.readFileSync(process.argv[1], "utf8")), timeout: 600000}))' \
  ./your-story.sekai-story.json |
  curl -X POST http://127.0.0.1:9881/api/v1/export \
    -H "Content-Type: application/json" --data-binary @-
```

默认同步等待导出完成，成功后返回 `downloadUrl`、`logPath`、`logJsonPath` 与 `reportPath`；也可传 `"wait": false` 获取 `taskId` 并轮询 `GET /api/v1/export/:taskId/status`。`timeout` 包含排队时间，客户端断连或超时会取消任务。完整端点与参数见 [API 参考](doc/api.md)。

> [!WARNING]
> API 默认监听 `0.0.0.0`，未设置 `MSST_API_KEY`（或 `MSS_API_KEY`）时默认无鉴权。对外部署请开启 Bearer 鉴权并配置 `MSST_CORS_ORIGINS` 白名单与反向代理边界，详见 [部署指南](doc/host-deployment.md#安全提示)。

## 常用脚本

来自 [package.json](package.json) 的常用命令：

| 命令 | 用途 |
| --- | --- |
| `npm run build` | 类型检查（`typecheck`）+ 前端渲染器构建（`build:web`）+ 宿主编译（`build:host`） |
| `npm start` | 启动宿主（`node out-host/host/main.js`） |
| `npm run typecheck` | 分别检查宿主与渲染器 TypeScript 类型 |
| `npm run lint` / `npm run format:check` | ESLint 与 Prettier 格式检查 |
| `npm test` / `npm run test:all` | 运行核心回归测试 / 全量回归测试（含零本地全云端测试） |
| `npm run test:pool` / `test:config` / `test:export` / `test:renderer` / `test:tts` | 按模块运行专项测试 |
| `npm run fetch:models` / `npm run fetch:media` | 可选 CLI：离线拉取 Moesekai 模型或背景/BGM 到本地 `resources/` |
| `npm run e2e` | 运行端到端导出验证脚本（需先启动宿主） |

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [文档总览](doc/README.md) | 按首次部署、AI 编剧、接入机器人、排查与开发划分的阅读路径 |
| [API 参考](doc/api.md) | 导出、AI 生成、云端目录与资源拉取、状态查询、取消、下载与清理接口 |
| [云端资源获取](doc/cloud-assets.md) | 零本地资源云端架构、511 模型 / 1,401 背景 / 421 BGM / 1,942 SE 语义目录、按需物化与离线拉取 CLI |
| [宿主内置 AI 剧本生成](doc/ai-script.md) | LLM 配置、5 阶段流水线、Normal 模式双人轮换、OfficialLinter 校验与人设配置 |
| [故事文件格式](doc/story-format.md) | 完整 JSON 示例、全部片段定义、云端资源引用、60fps 官方时序与舞台坐标 |
| [资源与音频配置](doc/resources.md) | `resources/` 目录、可选本地 YAML 覆盖、GPT-SoVITS / IrodoriTTS、情绪标签与 BGM |
| [导出模式](doc/export-modes.md) | `fast` 虚拟时钟管线、参数默认值、WebCodecs / `image2pipe` 回退与耗时统计 |
| [部署指南](doc/host-deployment.md) | 平台依赖、环境变量、systemd / Windows 常驻、GPU 加速与安全边界 |
| [故障排除](doc/troubleshooting.md) | 浏览器启动、软件渲染、云端资源物化、音频与演出问题排查 |
| [开发与验证](doc/development.md) | 目录结构、构建、自动化测试与端到端成片验证 |

## 相关内容

- [astrbot_plugin_msst](https://github.com/yonglanws/astrbot_plugin_msst) —— 官方 AstrBot 插件：对接宿主 AI 剧本生成与视频导出，负责指令交互、进度反馈与机器人视频回传。

## 许可证

本项目基于 [Untitled-Story/MySekaiStoryteller](https://github.com/Untitled-Story/MySekaiStoryteller) 二次开发，沿用 **[GNU GPL v3](LICENSE)** 许可证开源；导出视频的使用另受原项目中的 [VIDEO-LICENSE-CN.md](VIDEO-LICENSE-CN.md) 约束。

## 致谢

[Untitled-Story/MySekaiStoryteller](https://github.com/Untitled-Story/MySekaiStoryteller) ·
[Sekai-World/sekai-viewer](https://github.com/Sekai-World/sekai-viewer) ·
[lezzthanthree/SEKAI-Stories](https://github.com/lezzthanthree/SEKAI-Stories)
