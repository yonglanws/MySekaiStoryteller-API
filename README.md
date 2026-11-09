<div align="center">

# MySekaiStoryteller-API

**无头纯 API 的 Project SEKAI 风格 Live2D 视频渲染框架**

当前版本 2.0.0

<a href="#项目简介">项目简介</a> ·
<a href="#快速开始">快速开始</a> ·
<a href="#api-接口">API 接口</a> ·
<a href="#文档导航">文档导航</a> ·
<a href="#相关内容">相关内容</a>

</div>

> 这个项目疑似过于史山了...

> [!IMPORTANT]
> 本项目基于 [Untitled-Story/MySekaiStoryteller](https://github.com/Untitled-Story/MySekaiStoryteller) **二次开发**，
> 如需桌面编辑器，请访问原项目。
> 感谢原作者 [GuangChen2333](https://github.com/GuangChen2333) 与 [Untitled-Story](https://github.com/Untitled-Story) 组织。

[示例成片 (2026-9-20)](https://share.fnnas.net/s/7cefbd92baf04955b3)（由 DeepSeek V4.1 Flash & [AstrBot 插件](https://github.com/yonglanws/astrbot_plugin_msst) 一句话生成）

## 项目简介

接收 `*.sekai-story.json` 剧本，通过 HTTP API 渲染并导出 Project SEKAI 风格的 Live2D MP4 视频。

不依赖 Electron 或桌面环境，支持 Windows / Linux / macOS；配合官方 AstrBot 插件，可自动生成剧本并向 QQ / Telegram 发送视频。

- **无头渲染**：PixiJS + Live2D，运行于 Playwright 管理的 Chrome / Edge 渲染池，`render.workers` 控制并发导出数。
- **两种导出模式**：默认 `record` 实时录制，也支持 `fast` 虚拟时钟逐帧渲染；硬件编码失败自动回退 CPU。
- **可选音频**：GPT-SoVITS / IrodoriTTS 配音与 BGM 混音；Irodori 支持 LoRA、参考音频、caption 与情绪标签，支持模拟说话口型；没有 TTS 也可导出。
- **任务管理**：排队、并发导出、取消、IP 限流和过期文件清理。
- **云端资源**：从 Moesekai（pjsk.moe）拉取 Live2D 模型与动作、剧情背景和 BGM；`sse-motion` 无损转 `motion3`，自动登记 `models.yaml` / `images.yaml` / `bgm.yaml`，BGM 用官方曲名索引补全，AI 可按曲名和分类选曲。
- **宿主内置 AI**：配置任意 OpenAI 兼容 LLM，一句场景描述完成四段式生成——选角 → 台词 → 情绪/表演/日文 `ttsText` 翻译（三段并行）→ 合成与舞台校验，再交给同一条导出队列。

## 快速开始

由于无法做到开箱即用，且文档内容较多，部署及配置较为麻烦，本项目推荐使用 Agent 进行部署及资源配置。

需要 **Node.js ≥ 20** 和 Chrome / Edge / Chromium。ffmpeg 由 `ffmpeg-static` 随依赖安装。
以下命令在仓库根目录执行（Windows 可使用 Git Bash）：

```bash
git clone https://github.com/yonglanws/MySekaiStoryteller-API.git
cd MySekaiStoryteller-API
npm ci
# 仅在没有系统 Chrome / Edge 时执行
npx playwright install chromium
cp config.example.yaml config.yaml
```

编辑 `config.yaml`，并按 [资源与音频配置](doc/resources.md) 放置模型、背景等资源及清单。
**仓库不附带渲染资源或示例剧本**；资源根默认为 `resources/`，可通过 `paths.resources` 或 `MSS_RESOURCE_DIR` 修改。

没有现成模型、背景或 BGM 时，可以直接从 Moesekai 拉取（详见 [云端资源获取](doc/cloud-assets.md)）：

```bash
npm run fetch:models -- --characters mizuki,ena
# 背景 / BGM 可选，按需拉取
npm run fetch:media -- --kind backgrounds --limit 20
npm run fetch:media -- --kind bgm --names bgm00003,bgm00006
```

要在宿主里用 AI 写剧本，设置 LLM 密钥并启用 `llm`（详见 [宿主内置 AI 剧本生成](doc/ai-script.md)）：

```bash
export MSS_LLM_API_KEY=sk-...
# config.yaml: llm.enabled=true, llm.baseUrl/model 按服务填写
```

```bash
npm run build
npm start
```

另开终端检查服务：

```bash
curl http://127.0.0.1:9881/api/v1/health
```

`renderPool.webglRenderers` 应显示真实 GPU 名称；若出现 `SwiftShader` / `llvmpipe`，见 [故障排除](doc/troubleshooting.md)。

常驻运行、平台差异与环境变量见 [部署指南](doc/host-deployment.md)。

## API 接口

默认地址为 `http://127.0.0.1:9881`。准备好符合 [故事文件格式](doc/story-format.md) 的剧本后提交导出；
下面的文件名仅为示例，请替换为自己的剧本路径：

```bash
node -e 'const fs = require("node:fs"); process.stdout.write(JSON.stringify({story: JSON.parse(fs.readFileSync(process.argv[1], "utf8")), timeout: 600000}))' \
  ./resources/stories/demo.sekai-story.json |
  curl -X POST http://127.0.0.1:9881/api/v1/export \
    -H "Content-Type: application/json" --data-binary @-
```

请求会等待导出结果，成功后返回 `downloadUrl`。`timeout` 包含排队时间，客户端断连或超时会取消任务。

启用 `llm` 后还可以一句话生成剧本或完整视频：

```bash
# 只生成剧本
curl -sS -X POST http://127.0.0.1:9881/api/v1/script/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "放学后的教室里，瑞希和绘名聊起下次 Live"}'

# 生成并直接导出视频
curl -sS -X POST http://127.0.0.1:9881/api/v1/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "深夜的无人 SEKAI，奏和真冬聊起写不出来的歌"}'
```

完整端点、参数与任务行为见 [API 参考](doc/api.md)。

> [!WARNING]
> API 默认监听 `0.0.0.0` 且无鉴权。不要直接暴露到公网；安全部署要求见 [部署指南](doc/host-deployment.md#安全提示)。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [API 参考](doc/api.md) | 导出、生成、资源拉取、状态查询、取消、下载与清理接口 |
| [故事文件格式](doc/story-format.md) | 完整 JSON 示例、登场退场、台词动作与时长规则 |
| [资源与音频配置](doc/resources.md) | 资源目录、模型与背景清单、TTS、BGM |
| [云端资源获取](doc/cloud-assets.md) | Moesekai 模型/动作/背景/BGM 下载、sse-motion 转 motion3、缓存续传 |
| [宿主内置 AI 剧本生成](doc/ai-script.md) | LLM 配置、staged/single 流水线、剧本/视频端点、校验修复、人格与人设 |
| [导出模式](doc/export-modes.md) | record / fast、画质与体积、旧配置迁移 |
| [部署指南](doc/host-deployment.md) | 平台依赖、配置与环境变量、常驻运行、GPU 与安全 |
| [故障排除](doc/troubleshooting.md) | 浏览器启动、软件渲染、导出失败与性能问题 |
| [开发与验证](doc/development.md) | 项目结构、构建、回归测试与端到端验证 |

## 相关内容

- [astrbot_plugin_msst](https://github.com/yonglanws/astrbot_plugin_msst) —— 官方 AstrBot 插件：对接宿主 AI 剧本生成与视频导出，负责指令、进度与机器人视频回传。

## 许可证

本项目基于 [Untitled-Story/MySekaiStoryteller](https://github.com/Untitled-Story/MySekaiStoryteller) 二次开发，沿用 **[GNU GPL v3](LICENSE)** 许可证开源；导出视频的使用另受原项目中的 [VIDEO-LICENSE-CN.md](VIDEO-LICENSE-CN.md) 约束。

## 致谢

[Untitled-Story/MySekaiStoryteller](https://github.com/Untitled-Story/MySekaiStoryteller) ·
[Sekai-World/sekai-viewer](https://github.com/Sekai-World/sekai-viewer) ·
[lezzthanthree/SEKAI-Stories](https://github.com/lezzthanthree/SEKAI-Stories)
