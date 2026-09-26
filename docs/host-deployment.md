# MySekaiStoryteller-API 纯 API 渲染宿主 — 部署指南

本项目已从 Electron 桌面应用重构为**无头纯 API 渲染框架**：Live2D 渲染跑在无头
Chrome / Edge（Playwright 驱动）里，Node 宿主提供 HTTP API、静态资源托管与
ffmpeg 编码。Windows / Linux / macOS 都可以部署；Linux 服务器不需要桌面环境、
不需要 Xorg / Xvfb。

硬件加速分两条独立路径（渲染 GPU ≠ 编码 GPU）：

| 路径       | 组件                             | 成功标志                                                     | 失败时                                      |
| ---------- | -------------------------------- | ------------------------------------------------------------ | ------------------------------------------- |
| WebGL 渲染 | 无头 Chrome / Edge               | `GET /api/v1/health` 的 `webglRenderers[].renderer` 含真实 GPU 名 | `SwiftShader` / `llvmpipe`，导出慢 5–10 倍 |
| 视频编码   | ffmpeg                           | 导出日志出现 `using encoder: h264_nvenc` / `h264_amf` / `h264_qsv` | 自动回退 `libx264`                          |

`health` 里的 `host.ffmpegEncoder` 是配置值（`auto` / `nvidia` / `amd` / `intel` /
`libx264`），不是 ffmpeg 实际选中的编码器。

## 架构

```
Node 20 宿主（单进程 + N 个无头浏览器渲染工作进程）
├─ :9881  VideoApiServer   视频导出 API（端点与旧版完全一致）
├─ :9881  静态托管          / 渲染页面 · /resources/* · /apifile/*
├─ :9881  桥接层 /bridge/*  invoke · 二进制写盘 · TTS/翻译代理 · WebSocket
└─ RenderPool             N 个无头 Chrome 页面（每页独立 WebGL 上下文）
```

导出数据流：
`POST /api/v1/export` → 队列（并发上限 = `render.workers`，默认 2）→ 渲染页面按 `video.exportMode` 出片
→ Web Audio 混音 WAV → ffmpeg 合流 MP4 → `downloadUrl` 供下载。

- `record`（默认）：MediaRecorder 墙钟录 WebM（分块回传写盘）→ ffmpeg 二次转码/合流
- `fast`：虚拟时钟逐帧渲染 + 页内 WebCodecs 直编 H.264 → ffmpeg `-c:v copy` 仅 remux；失败自动回退 `record`
AstrBot 插件（[astrbot_plugin_msst](https://github.com/yonglanws/astrbot_plugin_msst)，
独立仓库）**零改动兼容**。

### 取消与故障恢复

任务取消或客户端断连后，尚在渲染池缓冲区的任务会立即移除，不再启动渲染。
正在渲染的任务先收到中止通知；页面若在 60 秒宽限期内仍未返回结果，
宿主会在下一次巡检时重启该 worker 的浏览器（巡检间隔 15 秒，另需浏览器启动时间）。
其他 worker 上的导出继续运行，恢复就绪的 worker 会立即接手后续任务。

任务超时从提交时计算，包含排队时间；已经过期的任务不会再进入渲染。
可运行 `npm run test:pool` 验证取消、超时、并发隔离和故障恢复，无需浏览器或模型资源。

## 依赖

| 组件                     | 说明                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js ≥ 20             | 推荐 22 LTS                                                                                                                                       |
| Chrome / Edge / Chromium | 渲染工作进程。自动按 `render.browserChannels` 顺序探测（默认 msedge → chrome → chromium）；无系统浏览器时先执行 `npx playwright install chromium` |
| ffmpeg                   | 编码器。优先 `MSS_FFMPEG_PATH`，其次 npm 包 `ffmpeg-static`（安装时自动下载），最后 PATH                                                          |
| GPU 驱动（可选）         | 有独显 / 核显时安装对应驱动即可。Linux NVIDIA 只需 `nvidia-smi` 可用，**不需要 Xorg / Xvfb / 桌面**                                               |

无独立 GPU 也能跑：WebGL 走核显或软件渲染，编码设 `video.encoder: libx264`。

不要用 Docker 跑渲染宿主——无头 Chrome 的 GPU 透传收益差，排障更麻烦。

## 按平台

| 平台    | 浏览器                                        | WebGL                                                        | 编码（`video.encoder`，默认 `auto`）                         |
| ------- | --------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| Windows | 系统 Edge（默认探测顺序第一项）               | 独显 / 核显通常开箱即用                                      | NVIDIA→`h264_nvenc`，AMD→`h264_amf`，Intel→`h264_qsv`        |
| Linux   | 系统 Chrome / Chromium；没有再 `playwright install` | 无桌面也可以。NVIDIA **无 X** 时不要用 `--use-angle=gl`（会去开默认 X，失败掉 SwiftShader），改为 `linuxGpuAngle: false` 且 `extraChromeArgs: "--use-angle=vulkan"` | 同上；ffmpeg 需带对应硬件编码器（`ffmpeg-static` 未必带 NVENC/AMF/QSV，生产建议系统 ffmpeg） |
| macOS   | 系统 Chrome / Edge                            | 走 Apple GPU / AMD 即可                                      | 当前不探测 VideoToolbox，`auto` 会落到 `libx264`             |

`auto` 的探测顺序是 NVIDIA → AMD → Intel，全部失败回退 CPU。取值与配置字段对应：

| `video.encoder` | ffmpeg 编码器 |
| --------------- | ------------- |
| `auto`          | 按上表探测    |
| `nvidia`        | `h264_nvenc`  |
| `amd`           | `h264_amf`    |
| `intel`         | `h264_qsv`    |
| `libx264` / `cpu` | `libx264`   |

配置里写 `nvenc` **不会**被识别成 NVIDIA 编码器。

## 构建与启动

```bash
git clone <repo> && cd MySekaiStoryteller-API
npm ci
npx playwright install chromium   # 没有系统 Edge/Chrome 时需要
cp config.example.yaml config.yaml
# 编辑 config.yaml：至少看 server / video / render 节
npm run build                     # typecheck + vite(webrenderer) + tsc(host)
npm start                         # node out-host/host/main.js，工作目录必须是仓库根
```

Windows 没有 `cp` 时用资源管理器复制，或 `copy config.example.yaml config.yaml`。

### 资源准备

仓库**不附带**渲染资源，需自行把 Live2D 模型、背景图、BGM、示例剧本放入资源根
（默认 `resources/`，可用 `MSS_RESOURCE_DIR` 指向他处）。
目录结构与登记方式见 [resources/README.md](../resources/README.md)。

## 配置（config.yaml）

所有配置集中在仓库根的 `config.yaml`（从 `config.example.yaml` 复制，每个字段都有中文注释）。
**`config.yaml` 不入库**，升级代码不会覆盖你的配置。

| 节       | 内容                                                                                         |
| -------- | -------------------------------------------------------------------------------------------- |
| `server` | 端口、监听地址                                                                               |
| `video`  | 分辨率、帧率、CRF、渲染超采样、音频码率、**编码器**（auto / nvidia / amd / intel / libx264）、**导出管线**（`exportMode`: record / fast） |
| `render` | worker 数、页面回收周期、浏览器探测顺序、附加 Chrome 参数、Linux ANGLE 开关                  |
| `paths`  | 输出目录（apifile）、资源根（resources）、webrenderer 产物目录                               |
| `tts`    | GPT-SoVITS 地址、启停、全局/角色参考音频与权重                                               |
| `bgm`    | 启停、BGM 路径（相对资源根，如 `audio/bgm/bg1.mp3`）、音量                                   |

环境变量可覆盖同名配置（适合 systemd / 任务计划 / launchd 注入），见下表。

### 环境变量

| 变量                                                                                          | 覆盖的配置                    | 说明                                    |
| --------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------- |
| `MSS_PORT` / `MSS_HOST`                                                                       | `server.port` / `server.host` | 监听                                    |
| `MSS_VIDEO_WIDTH` / `MSS_VIDEO_HEIGHT` / `MSS_VIDEO_FPS` / `MSS_VIDEO_CRF`                    | `video.*`                     | 输出参数                                |
| `MSS_FFMPEG_ENCODER`                                                                          | `video.encoder`               | auto / nvidia / amd / intel / libx264   |
| `MSS_EXPORT_MODE` / `MSS_EXPORT_BITRATE`                                                      | `video.exportMode` / `video.exportBitrate` | record / fast；fast 模式码率（bps） |
| `MSS_WORKERS` / `MSS_WORKER_RECYCLE_EXPORTS`                                                  | `render.*`                    | 渲染池                                  |
| `MSS_BROWSER_CHANNELS` / `MSS_BROWSER_EXECUTABLE` / `MSS_CHROME_ARGS` / `MSS_LINUX_GPU_ANGLE` | `render.*`                    | 浏览器                                  |
| `MSS_OUTPUT_DIR` / `MSS_RESOURCE_DIR` / `MSS_WEB_RENDERER_DIR`                                | `paths.*`                     | 路径                                    |
| `MSS_FFMPEG_PATH`                                                                             | （独立）                      | 显式指定 ffmpeg 可执行文件              |
| `MSS_LOG_LEVEL`                                                                               | `logLevel`                    | silly/trace/debug/info/warn/error/fatal |

启动后自检：

```bash
curl http://127.0.0.1:9881/api/v1/health
```

关注返回中的 `renderPool` 字段：

```json
{
  "renderPool": {
    "readyWorkers": 2,
    "webglRenderers": [
      { "workerId": "w1", "renderer": "ANGLE (NVIDIA, Vulkan 1.4.312 (NVIDIA ...), NVIDIA)" },
      { "workerId": "w2", "renderer": "ANGLE (NVIDIA, Vulkan 1.4.312 (NVIDIA ...), NVIDIA)" }
    ]
  }
}
```

**`renderer` 必须是真实 GPU**（NVIDIA / AMD / Intel / Apple）。若出现 `SwiftShader` /
`llvmpipe` 字样说明 WebGL 落到了软件渲染——此时调整浏览器启动参数（见下方
「WebGL 硬件加速」）。

## 端到端测试

```bash
npm run e2e                        # 示例故事导出 + ffprobe 断言
node scripts/test-parallel.mjs 2   # 双任务并发导出验证
```

E2E 默认使用 `resources/stories/multi-character-demo.sekai-story.json`（随资源包提供，
见上方「资源准备」），并会把故事中缺失的模型变体自动替换为本机实际存在的资源。

## 常驻运行

工作目录必须是仓库根（配置、资源、`out-host/` 都相对仓库根解析）。

### Linux：systemd

`deploy/mysekai-host.service`：

```ini
[Unit]
Description=MySekaiStoryteller-API Pure-API Render Host
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/opt/MySekaiStoryteller-API
Environment=MSS_FFMPEG_ENCODER=auto
Environment=MSS_WORKERS=2
ExecStart=/usr/bin/node out-host/host/main.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

注意与旧版 Electron 部署的差异：**不再需要** ExecStartPre 启动 Xorg、不再需要
`DISPLAY` / `__GLX_VENDOR_LIBRARY_NAME` 等环境变量。NVIDIA 无头机器请在
`config.yaml` 里关 `linuxGpuAngle` 并加 `--use-angle=vulkan`（见下节），不要依赖
默认的 `--use-angle=gl`。

### Windows

用任务计划程序（开机启动、登录与否均可）或 [NSSM](https://nssm.cc/) 跑：

```text
程序: node
参数: out-host/host/main.js
起始于: <仓库根>
```

也可用 `npm start`。停宿主后 9881 端口偶发残留僵尸 node：`netstat -ano | findstr 9881`
找到 PID 后 `taskkill /PID <pid> /F`。

### macOS

launchd plist、tmux / screen，或前台 `npm start` 均可。编码目前走 CPU。

### 升级代码

```bash
git pull
# 仅当 package-lock.json 有变时需要
npm ci
npm run build
# 然后重启对应的 systemd / NSSM / launchd / 前台进程
```

`config.yaml` 与 `resources/` 不入库。升级后 `diff config.yaml config.example.yaml`
看有没有新增字段要补。

## WebGL 硬件加速

若 health 显示 SwiftShader / llvmpipe，按环境改 `render.extraChromeArgs`
（或 `MSS_CHROME_ARGS`），一次只改一项：

```text
--use-angle=vulkan        # Linux + NVIDIA 无桌面 / 无 X（推荐先试）
--use-angle=gl            # Linux 有可用的 X11/GLX 时（linuxGpuAngle: true 会自动追加）
--use-angle=swiftshader   # 仅用于确认软件渲染症状
```

Linux 上 `linuxGpuAngle: true`（默认）会自动追加 `--use-angle=gl`。这在无 X 的
NVIDIA 机器上会失败并掉进 SwiftShader，此时应设 `linuxGpuAngle: false` 再显式写
`--use-angle=vulkan`。Windows / macOS 不受该开关影响。

确认走的是系统 Chrome / Edge，而不是 Playwright 的 `chrome-headless-shell`
（后者更容易落到软件渲染）。可用 `render.browserExecutablePath` 或调整
`render.browserChannels`。

### 编码侧验证

```bash
# 1. 当前 ffmpeg 编了哪些硬件编码器
ffmpeg -hide_banner -encoders | grep -E 'nvenc|amf|qsv|libx264'

# 2. health 的 WebGL renderer 是真实 GPU
curl -s http://127.0.0.1:9881/api/v1/health

# 3. 导出期间 GPU 在跑（按厂商选一条）
nvidia-smi dmon -s um          # NVIDIA：sm/mem 应随导出波动
# AMD: radeontop / 任务管理器 GPU 引擎
# Intel: intel_gpu_top / 任务管理器 GPU 引擎
```

日志中应出现 `using encoder: h264_nvenc`（或 `h264_amf` / `h264_qsv`）。
若只有 `libx264`，检查系统 ffmpeg 是否带对应编码器；`ffmpeg-static` 经常没有 NVENC。

## 安全提示

API 监听 `0.0.0.0` 且无鉴权（仅 10 次/分钟 IP 限流）。内网使用即可；公网暴露请前置
反向代理（nginx/caddy）加鉴权，并关闭 `/bridge`、`/apifile` 的外部访问。
