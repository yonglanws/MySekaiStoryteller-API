<!--suppress HtmlDeprecatedAttribute -->
<p>
<div align="center">
 <img src="documents/assets/logo.png" width="500" style="border-radius: 40px;" alt="MySekaiStoryteller-API Logo" />
<p>
 <p>无头纯 API 的 Project SEKAI 风格 Live2D 视频渲染框架</p>
 <p>
  <a href="#项目简介">项目简介</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#api-接口">API 接口</a> ·
  <a href="#文档导航">文档导航</a> ·
  <a href="#相关内容">相关内容</a>
 </p>
</div>

> [!IMPORTANT]
> 本项目基于 [Untitled-Story/MySekaiStoryteller](https://github.com/Untitled-Story/MySekaiStoryteller) **二次开发**，
> 如需桌面编辑器，请访问原项目。
> 感谢原作者 [GuangChen2333](https://github.com/GuangChen2333) 与 [Untitled-Story](https://github.com/Untitled-Story) 组织。

[示例成片 (2026-9-20)](https://share.fnnas.net/s/7cefbd92baf04955b3)（由 DeepSeek V4.1 Flash & [AstrBot 插件](https://github.com/yonglanws/astrbot_plugin_msst) 一句话生成）

## 项目简介

接收 `*.sekai-story.json` 剧本，通过 HTTP API 渲染并导出 Project SEKAI 风格的 Live2D MP4 视频。

不依赖 Electron 或桌面环境，支持 Windows / Linux / macOS；配合官方 AstrBot 插件，可自动生成剧本并向 QQ / Telegram 发送视频。

- **无头渲染**：PixiJS + Live2D，运行于 Playwright 管理的 Chrome / Edge 渲染池。
- **两种导出模式**：默认 `record` 实时录制，也支持 `fast` 虚拟时钟逐帧渲染；硬件编码失败自动回退 CPU。
- **可选音频**：GPT-SoVITS TTS 配音与 BGM 混音，支持模拟说话口型；没有 TTS 也可导出
- **任务管理**：排队、并发导出、取消、IP 限流和过期文件清理。

## 快速开始

由于无法做到开箱即用，且文档内容较多，部署及配置较为麻烦，本项目推荐使用Agent进行部署及资源配置

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

```bash
npm run build
npm start
```

另开终端检查服务：

```bash
curl http://127.0.0.1:9881/api/v1/health
```

`renderPool.webglRenderers` 应显示真实 GPU 名称；若出现 `SwiftShader` / `llvmpipe`，见 [故障排除](doc/troubleshooting.md)

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

完整端点、参数与任务行为见 [API 参考](doc/api.md)。

> [!WARNING]
> API 默认监听 `0.0.0.0` 且无鉴权。不要直接暴露到公网；安全部署要求见 [部署指南](doc/host-deployment.md#安全提示)。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [API 参考](doc/api.md) | 导出、状态查询、取消、下载、资源目录与清理接口 |
| [故事文件格式](doc/story-format.md) | 完整 JSON 示例、登场退场、台词动作与时长规则 |
| [资源与音频配置](doc/resources.md) | 资源目录、模型与背景清单、TTS、BGM |
| [导出模式](doc/export-modes.md) | record / fast、画质与体积、旧配置迁移 |
| [部署指南](doc/host-deployment.md) | 平台依赖、配置与环境变量、常驻运行、GPU 与安全 |
| [故障排除](doc/troubleshooting.md) | 浏览器启动、软件渲染、导出失败与性能问题 |
| [开发与验证](doc/development.md) | 项目结构、构建、回归测试与端到端验证 |

## 相关内容

- [astrbot_plugin_msst](https://github.com/yonglanws/astrbot_plugin_msst) —— 官方 AstrBot 插件：AI 剧本生成、队列调度与机器人视频回传，通过 HTTP API 与本宿主交互。
- [更新日志](CHANGELOG.md) —— 版本变更记录。

## 许可证

本项目基于 [Untitled-Story/MySekaiStoryteller](https://github.com/Untitled-Story/MySekaiStoryteller) 二次开发，沿用 **[GNU GPL v3](LICENSE)** 许可证开源；导出视频的使用另受原项目中的 [VIDEO-LICENSE-CN.md](VIDEO-LICENSE-CN.md) 约束。

## 致谢

[Untitled-Story/MySekaiStoryteller](https://github.com/Untitled-Story/MySekaiStoryteller) ·
[Sekai-World/sekai-viewer](https://github.com/Sekai-World/sekai-viewer) ·
[lezzthanthree/SEKAI-Stories](https://github.com/lezzthanthree/SEKAI-Stories)
