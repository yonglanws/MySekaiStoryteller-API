# 部署指南

[返回 README](../README.md) · [资源与音频配置](resources.md) · [导出模式](export-modes.md) · [故障排除](troubleshooting.md)

渲染宿主是普通 Node 进程：Playwright 管理无头 Chrome / Edge，Node 提供 HTTP API、静态资源托管与 ffmpeg 编码。
支持 Windows / Linux / macOS，不依赖 Electron；Linux 无头服务器不需要 Xorg / Xvfb 或桌面环境。

本文导航：[依赖](#依赖) · [平台差异](#按平台) · [配置](#配置与环境变量) · [常驻运行](#常驻运行) · [配置建议](#配置建议) · [启停检查](#启动与停止检查清单) · [GPU](#webgl-硬件加速) · [安全](#安全提示)

## 架构

```text
Node 宿主
├─ :9881  HTTP API          故事导出、队列、资源清单、健康检查
├─ :9881  静态托管          / 渲染页面 · /resources/* · /apifile/*
├─ :9881  /bridge/*         渲染端与宿主的桥接层
└─ RenderPool              N 个无头浏览器页面，每页独立 WebGL 上下文
```

`POST /api/v1/export` 提交故事后进入队列，并发上限由 `render.workers` 控制，默认 2。
渲染页面按 `video.exportMode` 出片，音轨混音后由 ffmpeg 合入 MP4，接口返回 `downloadUrl`。
管线细节见 [导出模式](export-modes.md)，接口语义见 [API 参考](api.md)。

### 取消与故障恢复

- 取消或客户端断连后，尚在渲染池缓冲区的任务会移除，不再开始渲染。
- 正在渲染的任务先收到中止通知；页面若在 60 秒宽限期内仍未返回结果，宿主会在下一次巡检时重启该 worker 的浏览器。
  巡检间隔为 15 秒，恢复还需要浏览器启动时间。
- 其他 worker 上的任务继续运行，恢复就绪的 worker 会接手后续任务。
- 超时从提交时计算，**包含排队时间**；已经过期的任务不会再进入渲染。

`npm run test:pool` 可验证取消、超时、并发隔离与恢复，无需浏览器或模型资源。

## 依赖

| 组件                     | 要求                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| Node.js                  | ≥ 20，推荐 22 LTS                                                                                    |
| Chrome / Edge / Chromium | 默认按 `msedge` → `chrome` → `chromium` 探测；无系统浏览器时先执行 `npx playwright install chromium` |
| ffmpeg                   | 优先 `MSS_FFMPEG_PATH`，其次依赖包 `ffmpeg-static`，最后 PATH                                        |
| GPU 驱动                 | 推荐安装独显或核显对应驱动；无 GPU 也可软件渲染，编码设为 `libx264`                                  |

建议直接部署宿主进程，不使用 Docker，避免增加无头浏览器 GPU 透传的排障成本。

## 按平台

| 平台    | 浏览器与 WebGL                                         | 视频编码                                       |
| ------- | ------------------------------------------------------ | ---------------------------------------------- |
| Windows | 系统 Edge 通常可直接使用独显或核显                     | 可探测 NVENC / AMF / QSV                       |
| Linux   | Chrome / Chromium；NVIDIA 无 X 环境的 ANGLE 设置见下文 | ffmpeg 需包含并能使用相应硬件编码器            |
| macOS   | Chrome / Edge，使用系统 GPU                            | 当前不探测 VideoToolbox，`auto` 回退 `libx264` |

`video.encoder: auto` 依次探测 NVIDIA → AMD → Intel，全部失败回退 CPU。

| 配置值            | ffmpeg 编码器 |
| ----------------- | ------------- |
| `nvidia`          | `h264_nvenc`  |
| `amd`             | `h264_amf`    |
| `intel`           | `h264_qsv`    |
| `libx264` / `cpu` | `libx264`     |

不要把 `nvenc` 直接填到 `video.encoder`。ffmpeg 带有某个编码器不代表驱动或设备一定可用，record 会实际试编码。

## 构建与启动

首次安装见 [README 快速开始](../README.md#快速开始)。配置和资源就绪后，在仓库根目录执行：

```bash
npm run build
npm start
```

`build` 包括类型检查和前后端构建；`start` 执行 `node out-host/host/main.js`。
Windows 没有 `cp` 时，可用资源管理器复制配置，或在 CMD 中执行 `copy config.example.yaml config.yaml`。

资源目录和清单见 [资源与音频配置](resources.md)。仓库不附带模型、背景、BGM 或示例剧本。

## 配置与环境变量

宿主设置位于根目录的 `config.yaml`，由 [config.example.yaml](../config.example.yaml) 复制并编辑。
正式配置不入库；BGM 可由资源根中的 `audio/bgm/bgm.yaml` 单独配置。

| 配置节   | 内容                                                            |
| -------- | --------------------------------------------------------------- |
| `server` | 端口、监听地址                                                  |
| `video`  | 分辨率、帧率、CRF、渲染超采样、音频码率、编码器、导出模式       |
| `render` | worker 数、回收周期、浏览器探测顺序、启动参数、Linux ANGLE 开关 |
| `paths`  | 输出目录、资源根、网页渲染端产物目录                            |
| `tts`    | GPT-SoVITS 地址、开关、全局与角色参考音频和权重                 |
| `bgm`    | BGM 开关、路径、音量；独立 BGM 文件不存在时的回退配置           |

record 的旧专用参数已移除，迁移说明见 [旧配置迁移](export-modes.md#旧配置迁移)。TTS 与 BGM 的配置方式见 [资源与音频配置](resources.md)。

常用环境变量可覆盖配置，适合 systemd、任务计划或 launchd 注入：

| 环境变量                                                                   | 对应配置或作用                                                    |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `MSS_PORT` / `MSS_HOST`                                                    | `server.port` / `server.host`                                     |
| `MSS_VIDEO_WIDTH` / `MSS_VIDEO_HEIGHT` / `MSS_VIDEO_FPS` / `MSS_VIDEO_CRF` | 通用视频输出参数                                                  |
| `MSS_FFMPEG_ENCODER`                                                       | `video.encoder`                                                   |
| `MSS_EXPORT_MODE` / `MSS_EXPORT_BITRATE`                                   | `video.exportMode` / fast WebCodecs 码率                          |
| `MSS_EXPORT_FAST_ENCODER` / `MSS_FAST_FPS`                                 | fast 编码路径 / 有效帧率上限                                      |
| `MSS_VIDEO_WATERMARK` / `MSS_VIDEO_WATERMARK_TEXT`                         | 内置水印开关 / 自定义文字                                         |
| `MSS_IDLE_CHAIN_GAP_SEC`                                                   | 动作结束后的续演间隔秒数                                          |
| `MSS_MIN_FREE_MEMORY_MB`                                                   | `render.minFreeMemoryMb` 内存护栏                                 |
| `MSS_WORKERS` / `MSS_WORKER_RECYCLE_EXPORTS`                               | 渲染池 worker 数与回收周期                                        |
| `MSS_BROWSER_CHANNELS` / `MSS_BROWSER_EXECUTABLE`                          | 浏览器探测顺序与可执行文件                                        |
| `MSS_CHROME_ARGS` / `MSS_LINUX_GPU_ANGLE`                                  | 浏览器附加参数与 Linux ANGLE 开关                                 |
| `MSS_OUTPUT_DIR` / `MSS_RESOURCE_DIR` / `MSS_WEB_RENDERER_DIR`             | 输出、资源与渲染端路径                                            |
| `MSS_FFMPEG_PATH`                                                          | 显式指定 ffmpeg 可执行文件                                        |
| `MSS_LOG_LEVEL`                                                            | `silly` / `trace` / `debug` / `info` / `warn` / `error` / `fatal` |

## 启动后自检

```bash
curl http://127.0.0.1:9881/api/v1/health
```

关注 `renderPool.readyWorkers` 和 `renderPool.webglRenderers[].renderer`。
使用硬件渲染时应看到 NVIDIA / AMD / Intel / Apple 等真实 GPU 名，而不是 `SwiftShader` / `llvmpipe`。
实际导出、媒体检查和并发验证见 [开发与验证](development.md#端到端与并发验证)。

## 常驻运行

建议将工作目录固定为仓库根。宿主优先从 `out-host/host/` 编译产物位置推导根目录，找不到对应 `package.json` 时才回退当前工作目录；测试工具仍依赖当前工作目录，因此不要只复制一个宿主入口文件运行。

### Linux：systemd

仓库提供 [deploy/mysekai-host.service](../deploy/mysekai-host.service)，按实际账号和安装目录调整：

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

不需要 `ExecStartPre` 启动 Xorg，也不需要 `DISPLAY` 或 `__GLX_VENDOR_LIBRARY_NAME`。
NVIDIA 无头机器需要检查下文的 ANGLE 配置。

首次安装服务时，先编辑仓库中的模板，把 `YOUR_USER`、`YOUR_GROUP`、`WorkingDirectory` 和 Node 路径换成实际值；确认服务账号可读取模型和浏览器、可写输出目录。然后执行：

```bash
sudo cp deploy/mysekai-host.service /etc/systemd/system/mysekai-host.service
sudo systemctl daemon-reload
sudo systemctl enable --now mysekai-host.service
systemctl status mysekai-host.service
```

这些命令会安装并启动常驻服务；已有同名单元时先保留原配置，不要直接覆盖。浏览器由哪个用户安装，会影响服务账号能否使用它，交互终端中安装成功不代表 systemd 账号一定可用。
宿主排空等待最多 120 秒，若希望系统服务完整等待，可在单元中配置更长的 `TimeoutStopSec`（例如 `150s`），避免管理器提前强制终止。

### Windows

使用任务计划程序或 [NSSM](https://nssm.cc/)：

```text
程序: node
参数: out-host/host/main.js
起始于: <仓库根>
```

也可前台运行 `npm start`。若提示端口占用，先用 `netstat -ano | findstr 9881` 查明 PID 及对应程序，
确认是需要停止的旧宿主后再结束该进程，不要批量终止 node 或浏览器进程。

### macOS

可使用 launchd、tmux / screen，或前台 `npm start`。当前视频编码使用 CPU。

### 升级代码

先确认工作区没有需要保护的本地修改，再执行：

```bash
git pull
# 依赖发生变化时执行
npm ci
npm run build
# 然后重启对应的 systemd / NSSM / launchd / 前台进程
```

正式 `config.yaml` 和渲染资源不入库。升级后对照 `config.example.yaml` 检查新增字段。

## 配置建议

### 最小本地配置

只在本机试跑时，通常只需要修改资源路径和浏览器 / 视频输出参数：

```yaml
server:
  host: 127.0.0.1
  port: 9881

paths:
  resources: resources
  output: apifile

video:
  width: 1280
  height: 720
  fps: 30
  renderScale: 1
  exportMode: record
```

这是可独立使用的主配置示例，但运行导出仍需要资源。省略的配置使用 schema 默认值，并不会自动关闭 TTS 或 BGM；若尚未配置音频，可在主配置加入 `tts.enabled: false`，并在独立 `bgm.yaml` 中设置 `enabled: false`。

`config.yaml` 位于宿主推导出的仓库根目录，`paths` 相对这个根目录解析为绝对路径。模板的显式值不一定等于内置默认值：例如模板是 1920×1080、60fps，而省略 `video` 后是 1280×720、30fps。完整对照见 [导出模式](export-modes.md)。

### 并发、内存与 worker 回收

每个 worker 都持有一个独立浏览器页面和 WebGL 上下文，内存会随模型数量、画布尺寸和渲染倍率增加。调整时按以下顺序排查：

1. 先用 `render.workers: 1` 确认单任务能稳定导出。
2. 查看 health 中 `configuredWorkers`、`readyWorkers` 和 `idleWorkers`，不要把请求并发数直接当作实际可用 worker 数。
3. 稳定后逐步增加 `workers`，为系统和 ffmpeg 保留内存，不要只按 CPU 核数设置。
4. `workerRecycleExports` 默认为 5；长时间运行或 Live2D 资源较多时保留回收，设为 `0` 会关闭按导出次数回收。
5. `minFreeMemoryMb` 大于 0 时，派发前会检查可用内存；护栏只延迟派发，不会释放已经被浏览器占用的内存。

### 水印与画面设置

`video.watermark` 控制内置水印，`video.watermarkText` 可追加最多两行自定义文字。输出尺寸由 `width` / `height` 决定，`renderScale` 只影响内部渲染分辨率，不会改变输出尺寸。

- 追求清晰度时，优先保证 `renderScale: 1` 或更高，再通过 `crf` 调整体积。
- 低于 `1` 会先用更低分辨率绘制后放大，无法用编码码率恢复细节。
- `renderScale: 1.5` 的像素处理量约为 `1` 的 2.25 倍，显存和画布读回成本也会上升。
- `fastFps` 限制 fast 的有效帧率，并影响渲染侧动画采样；不要把它理解为完全不影响动画推进的独立编码开关。具体取值与管线差异见 [导出模式](export-modes.md)。

### 环境变量的使用方式

环境变量覆盖在读取 `config.yaml` 后应用。列表型的 `MSS_BROWSER_CHANNELS` 使用逗号分隔：

```bash
MSS_HOST=127.0.0.1 MSS_PORT=9881 MSS_WORKERS=1 npm start
```

Windows PowerShell：

```powershell
$env:MSS_HOST = '127.0.0.1'
$env:MSS_WORKERS = '1'
npm start
```

路径类变量会在解析配置时转换为绝对路径。`MSS_CHROME_ARGS` 是原样传给浏览器的空格分隔参数；若参数包含复杂引号，优先写入 `config.yaml`，避免 shell 转义差异。

## 启动与停止检查清单

首次启动：

1. `npm ci`、`npm run build` 均在仓库根目录完成。
2. 确认 `config.yaml`、资源根和 `out/webrenderer` 存在。
3. 启动 `npm start`，等待日志出现 `Host ready`。
4. 调用 `/api/v1/health`，确认至少一个 worker ready，并查看 renderer。
5. 先提交短剧本，再运行完整故事；不要在未确认 WebGL 的情况下直接压测并发。

停止或重启：

- 优先发送 `SIGINT` / `SIGTERM`，宿主会尝试等待在途导出排空，最多约 120 秒。维护前先停止客户端继续提交新任务；不要把这一等待机制当作负载均衡器的自动摘流。
- 排空超时后，剩余导出会被丢弃，再停止浏览器池和 HTTP 服务。
- Windows 前台运行可使用 Ctrl+C；任务计划或 NSSM 重启时要确认旧进程已经释放 9881 端口。
- 只在确认 PID 属于本宿主时结束进程，不要按名称批量终止所有 Node 或浏览器进程。

## 日志位置与问题定位

前台启动时日志直接输出到终端；systemd 日志可用：

```bash
journalctl -u mysekai-host -f
journalctl -u mysekai-host --since "10 minutes ago"
```

建议按这个顺序定位：

1. `Host ready` 是否出现；没有时先看配置解析、ffmpeg 探测和浏览器启动错误。
2. health 是否有 ready worker；没有时看 Playwright 启动与 WebGL probe 日志。
3. 导出是否进入队列；看任务超时、内存护栏和 worker busy 状态。
4. 页面是否返回错误；再看资源 URL、TTS 请求和 ffmpeg 编码 / mux 日志。
5. 只在确认宿主自身问题后调整参数，不要用提高 timeout 掩盖资源缺失或软件渲染。

## WebGL 硬件加速

渲染 GPU 与编码 GPU 是两条独立路径：health 中的 WebGL renderer 证明浏览器渲染方式；
ffmpeg 日志才反映编码器选择。`host.ffmpegEncoder` 是配置值，不是实际探测结果。

若 health 显示 `SwiftShader` / `llvmpipe`，按环境调整 `render.extraChromeArgs` 或 `MSS_CHROME_ARGS`，一次只改一项：

```text
--use-angle=vulkan        # Linux + NVIDIA 无桌面 / 无 X，可优先尝试
--use-angle=gl            # Linux 有可用的 X11/GLX 时
--use-angle=swiftshader   # 仅用于诊断软件渲染
```

Linux 的 `linuxGpuAngle: true` 默认追加 `--use-angle=gl`，无 X 的 NVIDIA 环境可能因此落到软件渲染。
此时改为 `linuxGpuAngle: false` 并显式指定 `--use-angle=vulkan`。Windows / macOS 不受该开关影响。

确认使用的是系统 Chrome / Edge，而不是 Playwright 的 `chrome-headless-shell`；后者可能更容易落到软件渲染。
可调整 `render.browserChannels` 或指定 `render.browserExecutablePath`。

### 编码侧验证

对宿主实际使用的 ffmpeg 执行编码器检查（以下假设它已在 PATH 中）：

```bash
ffmpeg -hide_banner -encoders | grep -E 'nvenc|amf|qsv|libx264'
```

导出日志应显示实际选择的 `h264_nvenc`、`h264_amf`、`h264_qsv` 或 `libx264`。
硬件编码不可用时检查 ffmpeg 构建、驱动与设备能力；必要时用 `MSS_FFMPEG_PATH` 指定其他 ffmpeg。
导出期间可通过 `nvidia-smi dmon -s um`、`radeontop`、`intel_gpu_top` 或 Windows 任务管理器确认 GPU 负载。

## 安全提示

API 默认监听 `0.0.0.0` 且无鉴权，IP 限流不能替代访问控制。优先限制在可信内网使用。
需要公网访问时，应前置 nginx / Caddy 等反向代理并加鉴权，禁止外部直接访问 `/bridge`、`/apifile`，
同时限制资源与下载接口的访问范围。
