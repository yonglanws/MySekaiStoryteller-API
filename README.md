<!--suppress HtmlDeprecatedAttribute -->

<div align="center" style="text-align: center; margin-top: 10px;">
 <img src="documents/assets/logo.png" style="align-self: center; width: 150px; margin-bottom: 0;" alt="Logo" />
 <h3 style="margin-top: 0; text-align: center;">MySekaiStoryteller-API</h3>
 <p style="text-align: center;">无头纯 API 的 Project SEKAI 风格 Live2D 视频渲染框架</p>
 <div style="display: flex; justify-content: center;">
  <img src="documents/assets/live2d-badge.svg" alt="Live2D Badge" style="margin-top: 0; margin-right: 5px;"/>
  <img src="https://img.shields.io/badge/typescript-20B2AA?logoColor=ffffff&style=for-the-badge&logo=typescript" alt="TypeScript" style="margin-top: 0; margin-right: 5px;" />
  <img src="https://img.shields.io/badge/node-20B2AA?style=for-the-badge&logoColor=white&logo=nodedotjs" alt="Node.js" style="margin-top: 0; margin-right: 5px;" />
  <img src="https://img.shields.io/badge/playwright-20B2AA?style=for-the-badge&logoColor=white&logo=playwright" alt="Playwright" style="margin-top: 0; margin-right: 5px;" />
  <img src="https://img.shields.io/badge/ffmpeg-20B2AA?style=for-the-badge&logoColor=white&logo=ffmpeg" alt="FFmpeg" style="margin-top: 0; margin-right: 5px;" />
  <img src="https://img.shields.io/badge/license-GPL--3.0-20B2AA?style=for-the-badge" alt="GPL 3.0" style="margin-top: 0;" />
 </div>

 <p>
  <a href="#项目简介">项目简介</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#api-接口">API 接口</a> ·
  <a href="#故事文件格式">故事文件格式</a> ·
  <a href="#资源导入指南">资源导入</a> ·
  <a href="#tts--bgm-配置">TTS / BGM</a> ·
  <a href="#部署">部署</a> ·
  <a href="#项目结构">项目结构</a> ·
  <a href="#故障排除">故障排除</a> ·
  <a href="#相关项目">相关项目</a>
 </p>
</div>

> [!IMPORTANT]
> 本项目基于 [Untitled-Story/MySekaiStoryteller](https://github.com/Untitled-Story/MySekaiStoryteller) **二次开发**，
> 将其从 **Electron 桌面应用**重构为**无头纯 API 渲染框架**。
> 如需桌面阅读器，请访问原项目。感谢原作者 [GuangChen2333](https://github.com/GuangChen2333) 与
> [Untitled-Story](https://github.com/Untitled-Story) 组织。

## 项目简介

接收 `*.sekai-story.json` 故事剧本，用 Live2D（Project SEKAI 风格）渲染并导出为 MP4 视频，
通过 HTTP API 对外提供服务。典型用法：部署在本机或任意一台能跑无头 Chrome 的机器上，
配合官方 [AstrBot 插件](https://github.com/yonglanws/astrbot_plugin_msst) 实现
QQ/Telegram 机器人的 AI 剧本生成与视频自动发送。

| 特性     | 说明                                                                       |
| -------- | -------------------------------------------------------------------------- |
| 渲染引擎 | PixiJS + Live2D 跑在无头 Chrome 里（Playwright 渲染池，每页独立 WebGL 上下文） |
| 视频编码 | ffmpeg 自动探测 NVENC / AMF / QSV 硬件编码，失败自动回退 CPU                 |
| 音频     | 内置 BGM + GPT-SoVITS 语音合成（无 TTS 时自动跳过配音，导出不受影响）        |
| 队列管理 | 任务排队、并发导出、IP 限流、过期文件自动清理                                |
| 统一配置 | 单个 `config.yaml`，全字段中文注释，`MSS_*` 环境变量可覆盖                   |

## 快速开始

```bash
git clone https://github.com/yonglanws/MySekaiStoryteller-API.git
cd MySekaiStoryteller-API

# 1. 安装依赖（ffmpeg 无需手动装，npm 包 ffmpeg-static 会自动带上）
npm ci

# 2. 无系统浏览器时再装 Playwright 自带的 Chromium
#    Windows 一般自带 Edge，macOS/Linux 有 Chrome/Edge 也可跳过
npx playwright install chromium

# 3. 生成配置文件（每项都有中文注释，按需修改）
cp config.example.yaml config.yaml

# 4. 准备渲染资源（仓库不附带，见下文「资源准备」）

# 5. 构建（类型检查 + webrenderer + 宿主）
npm run build

# 6. 启动
npm start
```

**启动验证**

```bash
curl http://127.0.0.1:9881/api/v1/health
# renderPool.webglRenderers 应显示真实 GPU（如 NVIDIA / Intel），而非 SwiftShader
```

**全链路验证**（需先完成资源准备）

```bash
npm run e2e                        # 示例故事导出 + 产物断言（编码/分辨率/时长/音轨）
node scripts/test-parallel.mjs 2   # 并发导出验证
```

### 资源准备

**本仓库不附带渲染资源**：仓库只保留目录结构，资源需自行放入（详见
[resources/README.md](resources/README.md)）：

```
resources/
├─ models/       Live2D 模型包（<角色>/<变体>/，含 model3.json；根下 models.yaml 为登记表）
├─ images/       背景图 / 卡面
├─ voices/       故事语音（.wav，故事 JSON 按文件名引用）
├─ audio/bgm/    BGM
└─ stories/      *.sekai-story.json 剧本
```

资源根不强制叫 `resources/`：可在 `config.yaml` 的 `paths.resources` 或环境变量
`MSS_RESOURCE_DIR` 指向任意目录。

## API 接口

渲染宿主启动后提供 HTTP API（默认 `http://0.0.0.0:9881`）：

| 端点                             | 方法 | 说明                 |
| -------------------------------- | ---- | -------------------- |
| `/api/v1/export`                 | POST | 提交故事导出视频     |
| `/api/v1/export/:taskId/status`  | GET  | 查询任务状态         |
| `/api/v1/export/:taskId/cancel`  | POST | 取消任务             |
| `/api/v1/download/:filename`     | GET  | 下载导出的视频       |
| `/api/v1/files`                  | GET  | 分页列出导出文件     |
| `/api/v1/cleanup`                | POST | 触发过期文件清理     |
| `/api/v1/health`                 | GET  | 健康检查（含渲染池/GPU 状态） |
| `/api/v1/status`                 | GET  | 队列状态             |

提交导出只需把完整故事 JSON 作为请求体：

```bash
curl -X POST http://127.0.0.1:9881/api/v1/export \
  -H "Content-Type: application/json" \
  -d @resources/stories/multi-character-demo.sekai-story.json
```

宿主会自动把请求留档一份到 `apifile/`，便于排查。

## 故事文件格式

故事通过 `*.sekai-story.json` 文件定义，包含 `models`、`images` 和 `snippets` 三个字段：

```json
{
  "models": [
    {"id": 1, "model": "20mizuki/20mizuki_normal/20mizuki_normal.model3.json"}
  ],
  "images": [
    {"id": 1, "image": "bg_e000401.jpg"}
  ],
  "snippets": [
    {"type": "ChangeLayoutMode", "wait": false, "delay": 0, "data": {"mode": 0}},
    {"type": "BlackOut", "wait": true, "delay": 0, "data": {"duration": 500}},
    {"type": "ChangeBackgroundImage", "wait": true, "delay": 0, "data": {"image": {"id": 1}}},
    {"type": "BlackIn", "wait": true, "delay": 0, "data": {"duration": 800}},
    {"type": "LayoutAppear", "wait": true, "delay": 0, "data": {"modelId": 1, "from": {"side": "Right"}}},
    {"type": "Talk", "wait": true, "delay": 0, "data": {"speaker": "晓山瑞希", "content": "你好！"}}
  ]
}
```

- 故事内的 `model` / `image` 路径相对于**资源根** `resources/`（即 `resources/models/...`、
  `resources/images/...`），宿主通过 `/resources/*` 提供访问
- 指令片段（`snippets`）的完整类型定义见 `src/common/types/Story.ts`，
  也可参考随资源包提供的示例剧本

## 资源导入指南

### 新增 Live2D 角色（模型）

1. 把模型包整个拷到 `resources/models/<角色>/<变体>/`，目录内需含 `model3.json`
   （动作 `motions/*.motion3.json` 是模型包的一部分，由 model3.json 的
   `FileReferences.Motions` 索引——**动作文件跟着模型走，不需要单独登记**）
2. 在 `resources/models/models.yaml` 登记一行（`id` 全表唯一、`name` 角色全名、
   `shortName` 简称、`path` 以磁盘实际文件名为准）
3. 完成。宿主 30 秒内自动识别，提示词中的角色对照表、动作/表情清单、校验白名单
   **全部自动更新，无需改任何代码**；AstrBot 插件 5 分钟内自动感知（可发 `/mssadmin resources` 确认）

### 背景图 / 语音 / BGM

| 资源   | 存放位置               | 如何生效                                                    |
| ------ | ---------------------- | ----------------------------------------------------------- |
| 背景图 | `resources/images/`    | 自动进入目录，插件提示词与校验即时可用                      |
| 故事语音 | `resources/voices/`  | 故事 JSON 的 `voice` 字段按文件名引用                       |
| BGM    | `resources/audio/bgm/` | 在宿主 `config.yaml` 的 `bgm.path` 指定（如 `audio/bgm/bg1.mp3`） |

## TTS / BGM 配置

全部在 `config.yaml` 中完成（见 `config.example.yaml` 的 `tts:` / `bgm:` 节）：

1. 启动 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)（默认端口 `9880`），
   把地址填入 `tts.apiBaseUrl`
2. 在 `tts.characters` 下为每个角色配置参考音频（`refAudioPath` 为 **GPT-SoVITS 服务端**可访问的路径）
   与提示文本
3. BGM 放在 `resources/audio/bgm/` 下，`bgm.path` 填相对资源根的路径（如 `audio/bgm/bg1.mp3`）
4. `tts.enabled: false` 可整体关闭配音；无 TTS 时导出仍会成功，只是没有角色配音

## 部署

宿主是普通 Node 进程，**Windows / Linux / macOS 都可以跑**，不依赖 Electron，也不强制要桌面环境。
字段说明、环境变量与 Linux systemd 单元见 **[docs/host-deployment.md](docs/host-deployment.md)**。

Live2D 渲染和 MP4 编码是两条独立的 GPU 路径，可以分别成功或失败：

| 路径       | 谁在干活                         | 成功标志                                                     | 失败时                                      |
| ---------- | -------------------------------- | ------------------------------------------------------------ | ------------------------------------------- |
| WebGL 渲染 | 无头 Chrome / Edge（Playwright） | `GET /api/v1/health` 的 `webglRenderers[].renderer` 含真实 GPU 名 | `SwiftShader` / `llvmpipe`，导出慢 5–10 倍 |
| 视频编码   | ffmpeg                           | 导出日志出现 `using encoder: h264_nvenc` / `h264_amf` / `h264_qsv` | 自动回退 `libx264`（CPU）                   |

`health` 里的 `ffmpegEncoder` 是**配置值**（`auto` / `nvidia` / `amd` / `intel` / `libx264`），不是 ffmpeg 实际选中的编码器。

### 按平台

| 平台    | 浏览器                                         | WebGL                                                        | 编码（`video.encoder`，默认 `auto`）            |
| ------- | ---------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------- |
| Windows | 系统 Edge（默认探测 `msedge` → `chrome`）      | 独显 / 核显通常开箱即用                                      | NVIDIA→`h264_nvenc`，AMD→`h264_amf`，Intel→`h264_qsv` |
| Linux   | 系统 Chrome / Chromium；没有再 `playwright install` | 无桌面也可以。NVIDIA **无 X** 时不要用 `--use-angle=gl`（会去开 X，失败掉 SwiftShader），改为 `linuxGpuAngle: false` 且 `extraChromeArgs: "--use-angle=vulkan"` | 同上；ffmpeg 需带对应硬件编码器                 |
| macOS   | 系统 Chrome / Edge                             | 走 Apple GPU / AMD 即可                                      | 当前不探测 VideoToolbox，`auto` 会落到 `libx264` |

无独立 GPU 时：渲染走核显即可，编码显式设 `video.encoder: libx264`。

### 常驻运行

```bash
npm run build
npm start          # node out-host/host/main.js，工作目录必须是仓库根
```

Linux 可用 `deploy/mysekai-host.service` 交给 systemd（改 `User` / `WorkingDirectory` 后 `daemon-reload`）。
Windows 用任务计划程序或 [NSSM](https://nssm.cc/) 跑同一条命令；macOS 用 launchd / tmux 即可。
不要用 Docker 跑渲染宿主（无头 Chrome 的 GPU 透传收益差，还多一层排障）。

升级代码：`git pull` → 依赖变了再 `npm ci` → `npm run build` → 重启进程。`config.yaml` 与 `resources/` 不入库，不会被覆盖。

## 项目结构

```
config.example.yaml   统一配置样例（复制为 config.yaml 使用，config.yaml 不入库）
src/host/             Node 宿主：API 服务 / 静态托管 / 桥接层 / 渲染池 / ffmpeg 编码
src/webrender/        渲染工作进程页面（无头浏览器加载，构建产物在 out/webrenderer/）
src/renderer/         渲染引擎（PixiJS + Live2D + 导出管线）
src/common/           宿主与渲染侧共享的故事类型定义（Story.ts）
src/shared/           宿主与渲染侧共享的 ffmpeg 模块
resources/            资源根：models/ images/ voices/ audio/bgm/ stories/（不入库，见 resources/README.md）
out-host/             宿主编译产物（npm run build:host 生成）
docs/                 部署文档；deploy/ systemd 单元；scripts/ 测试与工具脚本
```

## 故障排除

**Q: 启动报 "Failed to launch any browser"**

系统没有 Edge/Chrome 且未下载 playwright 浏览器。执行 `npx playwright install chromium`
或安装系统 Chrome/Edge。

**Q: health 里 WebGL renderer 显示 SwiftShader / llvmpipe**

WebGL 落到了软件渲染，导出会慢 5–10 倍，并可能音画不同步。按平台改 `render.extraChromeArgs`
（或 `MSS_CHROME_ARGS`），详见 [docs/host-deployment.md](docs/host-deployment.md)：

- Linux + NVIDIA、无桌面 / 无 X：`linuxGpuAngle: false`，`extraChromeArgs: "--use-angle=vulkan"`
- Linux 有可用的 X11 / GLX：可试 `--use-angle=gl`（这也是 `linuxGpuAngle: true` 的默认追加项）
- Windows / macOS：一般不用额外参数；确认走的是系统 Edge/Chrome，而不是 Playwright 的 headless-shell

**Q: 视频导出失败或卡住**

- 查看宿主日志中的 ffmpeg / 渲染错误
- 尝试降低 `render.workers`（显存/内存不足时）
- 确认 `video.encoder` 对应的硬件在当前机器可用（失败会自动回退 CPU）。
  取值是 `auto` / `nvidia` / `amd` / `intel` / `libx264`，不是 ffmpeg 的 `nvenc` 字符串

## 相关项目

- [astrbot_plugin_msst](https://github.com/yonglanws/astrbot_plugin_msst) ——
  官方 AstrBot 插件：AI 剧本生成、队列调度与机器人视频回传，通过 HTTP API 与本宿主交互

## 许可证

本项目基于 [Untitled-Story/MySekaiStoryteller](https://github.com/Untitled-Story/MySekaiStoryteller)
二次开发，沿用 **[GNU GPL v3](LICENSE)** 许可证开源；导出视频的使用另受原项目中的
[VIDEO-LICENSE-CN.md](VIDEO-LICENSE-CN.md) 约束。

## 致谢

- [Untitled-Story/MySekaiStoryteller](https://github.com/Untitled-Story/MySekaiStoryteller)
- [Sekai-World/sekai-viewer](https://github.com/Sekai-World/sekai-viewer)
- [lezzthanthree/SEKAI-Stories](https://github.com/lezzthanthree/SEKAI-Stories)
