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
 </div>

 <p>
  <a href="#项目简介">项目简介</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#api-接口">API 接口</a> ·
  <a href="#故事文件格式">故事文件格式</a> ·
  <a href="#资源导入指南">资源导入</a> ·
  <a href="#tts--bgm-配置">TTS / BGM</a> ·
  <a href="#导出模式">导出模式</a> ·
  <a href="#部署">部署</a> ·
  <a href="#项目结构">项目结构</a> ·
  <a href="#故障排除">故障排除</a> ·
  <a href="#相关项目">相关项目</a>
 </p>
</div>

> [!IMPORTANT]
> 本项目基于 [Untitled-Story/MySekaiStoryteller](https://github.com/Untitled-Story/MySekaiStoryteller) **二次开发**，
> 将其从 **Electron 桌面应用**重构为**无头纯 API 渲染框架**。
> 如需桌面编辑器，请访问原项目。感谢原作者 [GuangChen2333](https://github.com/GuangChen2333) 与
> [Untitled-Story](https://github.com/Untitled-Story) 组织。

**示例成片**:[点此观看](https://share.fnnas.net/s/7cefbd92baf04955b3) (由DeepSeek V4.1 Flash生成)

## 项目简介

接收 `*.sekai-story.json` 故事剧本，用 Live2D（Project SEKAI 风格）渲染并导出为 MP4 视频，
通过 HTTP API 对外提供服务。渲染宿主不依赖 Electron 与桌面环境，可部署在本机、局域网服务器或
任意能跑无头 Chrome 的机器上；配合官方 [AstrBot 插件](https://github.com/yonglanws/astrbot_plugin_msst)
即可实现 QQ/Telegram 机器人的 AI 剧本生成与视频自动发送。

| 特性     | 说明                                                                       |
| -------- | -------------------------------------------------------------------------- |
| 渲染引擎 | PixiJS + Live2D 跑在无头 Chrome/Edge 里（Playwright 渲染池，每页独立 WebGL 上下文） |
| 表演系统 | 角色滑入/滑出登场退场、台词内时序动作与表情、听者反应、按语音音量包络驱动的口型 |
| 导出管线 | `record`（默认，MediaRecorder 墙钟录制）或 `fast`（虚拟时钟逐帧渲染）          |
| 视频编码 | ffmpeg 自动探测 NVENC / AMF / QSV 硬件编码，失败自动回退 CPU                 |
| 音频     | BGM 混入 + GPT-SoVITS 语音合成（无 TTS 时自动跳过配音，导出不受影响）        |
| 队列管理 | 任务排队、可配置并发导出、IP 限流、过期文件自动清理                          |
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

启动后确认渲染池拿到真实 GPU（而非 SwiftShader），并在资源就绪后验证整条导出链路：

```bash
curl http://127.0.0.1:9881/api/v1/health   # renderPool.webglRenderers 应显示真实 GPU 名
npm run test:all                           # 纯逻辑回归 29 项，无需宿主/浏览器/模型资源
npm run e2e                                # 真实导出 + 产物断言（需先完成资源准备；
                                           # 用 MSS_E2E_STORY=xx.sekai-story.json 指定剧本）
node scripts/test-parallel.mjs 2           # 并发导出验证
```

### 资源准备

**本仓库不附带渲染资源**：只保留目录结构，资源需自行放入（详见
[resources/README.md](resources/README.md)）：

```
resources/
├─ models/       Live2D 模型包（<角色>/<变体>/，含 model3.json；models.yaml 为登记表）
├─ images/       背景图 / 卡面（images.yaml 为画面描述表，供 AI 选图）
├─ voices/       故事语音（.wav，故事 JSON 按文件名引用）
├─ audio/bgm/    BGM（bgm.yaml 为 BGM 设置：开关/路径/音量）
└─ stories/      *.sekai-story.json 剧本
```

三份清单/设置文件（`models.yaml` / `images.yaml` / `bgm.yaml`）各附一份 `*.example.yaml`
示例随仓库分发：复制为去掉 `.example` 的正式文件名后编辑即可；正式文件与渲染资源不入库。

资源根不强制叫 `resources/`：可在 `config.yaml` 的 `paths.resources` 或环境变量
`MSS_RESOURCE_DIR` 指向任意目录（示例文件也要一起带过去）。

## API 接口

渲染宿主启动后提供 HTTP API（默认 `http://0.0.0.0:9881`）：

| 端点                             | 方法 | 说明                 |
| -------------------------------- | ---- | -------------------- |
| `/api/v1/export`                 | POST | 提交故事导出视频     |
| `/api/v1/export/:taskId/status`  | GET  | 查询任务状态         |
| `/api/v1/export/:taskId/cancel`  | POST | 取消任务             |
| `/api/v1/download/:filename`     | GET  | 下载导出的视频       |
| `/api/v1/files`                  | GET  | 分页列出导出文件     |
| `/api/v1/resources`              | GET  | 资源目录（模型/动作/表情/背景清单，供 AI 侧构建提示词与校验白名单） |
| `/api/v1/cleanup`                | POST | 触发过期文件清理     |
| `/api/v1/cleanup/stats`          | GET  | 清理统计             |
| `/api/v1/health`                 | GET  | 健康检查（含渲染池/GPU 状态） |
| `/api/v1/status`                 | GET  | 队列状态             |

提交导出时把完整故事 JSON 放在请求体的 `story` 字段里；`timeout`（毫秒，`1` 至
`2147483647` 的整数，默认 30 分钟且**包含排队时间**）可选，非法值返回 400：

```bash
node -e 'process.stdout.write(JSON.stringify({story: require(process.argv[1]), timeout: 600000}))' \
  resources/stories/demo.sekai-story.json |
  curl -X POST http://127.0.0.1:9881/api/v1/export \
    -H "Content-Type: application/json" --data-binary @-
```

请求会等待导出结果，客户端断连或超时会取消任务；宿主会把请求留档一份到 `apifile/`，便于排查。

## 故事文件格式

故事通过 `*.sekai-story.json` 定义，含 `models`、`images`、`snippets` 三个字段：

```json
{
  "models": [
    {"id": 1, "model": "20mizuki/20mizuki_normal/20mizuki_normal.model3.json",
     "normal_scale": 2.1, "small_scale": 1.8, "anchor": 0.5}
  ],
  "images": [
    {"id": 1, "image": "bg_c000101.jpg"}
  ],
  "snippets": [
    {"type": "ChangeLayoutMode", "wait": false, "delay": 0, "data": {"mode": "Normal"}},
    {"type": "BlackOut", "wait": true, "delay": 0, "data": {"duration": 500}},
    {"type": "ChangeBackgroundImage", "wait": true, "delay": 0, "data": {"imageId": 1}},
    {"type": "BlackIn", "wait": true, "delay": 0, "data": {"duration": 800}},
    {"type": "LayoutAppear", "wait": true, "delay": 0,
     "data": {"modelId": 1, "from": {"side": "Left", "offset": -100}, "to": {"side": "Left", "offset": 0},
              "motion": "w-normal-greeting01", "facial": "face_smile_01", "facialFirst": true,
              "moveSpeed": "Normal"}},
    {"type": "Talk", "wait": false, "delay": 0,
     "data": {"speaker": "晓山瑞希", "content": "你好！", "ttsText": "こんにちは！",
              "modelId": 1, "voice": ""}},
    {"type": "HideTalk", "wait": true, "delay": 0.2},
    {"type": "LayoutClear", "wait": true, "delay": 0.1,
     "data": {"modelId": 1, "from": {"side": "Left", "offset": 0}, "to": {"side": "Left", "offset": -100},
              "motion": "w-normal-nod01", "moveSpeed": "Normal"}},
    {"type": "BlackOut", "wait": true, "delay": 0, "data": {"duration": 600}}
  ]
}
```

- `model` / `image` 路径相对于**资源根** `resources/`，宿主通过 `/resources/*` 提供访问
- 片段类型的完整定义见 [src/common/types/Story.ts](src/common/types/Story.ts)；
  `snippets` 覆盖背景/黑场、登场退场、台词、静默动作、参数动画等

### 演出要点

**登场与退场**：`LayoutAppear` / `LayoutClear` 的 `from` 与 `to` 不同时做滑动（`moveSpeed`：
Slow 700ms / Normal 500ms / Fast 300ms / Immediate 瞬移），全程同步播放 `motion` + `facial`，
入场动作播完前剧情不继续；两者相同时原地淡入/淡出。`offset` 是相对槽位的水平像素偏移，
给同侧槽位写 `-100` / `+100` 即可从画外短距离滑入滑出。

**台词内的动作与听者反应**：`Talk.data.actions` 在台词内调度动作/表情，`at` 是台词时长的比例
（0 到 1）而非秒数；`modelId` 可以是说话者，也可以是在场听者。动作与表情独立更新，省略的通道
保持原状，同时事件最多 24 个（AstrBot 插件侧另有更严格的数量与间隔校验）：

```json
{"type": "Talk", "wait": true, "delay": 0, "data": {
  "speaker": "晓山瑞希", "modelId": 1, "content": "先别着急，听我慢慢说。",
  "actions": [{"at": 0, "modelId": 1, "motion": "w-normal-default01"},
              {"at": 0.4, "modelId": 2, "facial": "face_smile_01"},
              {"at": 0.7, "modelId": 1, "facial": "face_smile_01"}]}}
```

动作名/表情名以该角色的资源目录为准。旧的 `Talk.data.motion` / `facial` 仍作用于台词开头，
新事件只覆盖指定通道；无声连续表演用独立 `Motion.data.actions`（`duration` 秒，默认 2，最大 120）。
口型优先从台词音频提取音量包络，静音或语音结束后闭嘴，无音频时按文字与标点产生确定性节奏。
两人同屏、换角顺序等舞台规则属于 AstrBot 插件的生成规则，渲染 API 不强制。

## 资源导入指南

| 资源    | 存放位置                        | 怎么生效                                                     |
| ------- | ------------------------------- | ------------------------------------------------------------ |
| 模型    | `resources/models/<角色>/<变体>/` | 目录内需含 `model3.json`（动作 `motions/*.motion3.json` 跟着模型走），再到 `models.yaml` 登记一行：`id` 全表唯一、`name` 角色全名、`shortName` 简称、`path` 以磁盘实际文件名为准 |
| 背景图  | `resources/images/`             | 放图后在 `images.yaml` 登记 `file`（与磁盘文件名一致）/ `name` / `description`，描述供 AI 按剧情选图 |
| 故事语音 | `resources/voices/`            | 故事 JSON 的 `voice` 字段按文件名引用                        |
| 配音（TTS） | GPT-SoVITS 服务             | 见下节 `tts.characters` 参考音频配置                         |

清单文件缺失或条目在磁盘上不存在时，宿主会在日志里告警并跳过（`bgm.yaml` 内容写错会直接
启动失败，便于立刻发现）；新增资源后宿主 30 秒内自动识别，提示词中的对照表、动作/表情清单、
校验白名单全部自动更新，AstrBot 插件 5 分钟内自动感知（可发 `/mssadmin resources` 确认）。

## TTS / BGM 配置

### TTS

在 `config.yaml` 中完成（见 `config.example.yaml` 的 `tts:` 节）：

1. 启动 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)（默认端口 `9880`），
   把地址填入 `tts.apiBaseUrl`
2. 在 `tts.characters` 下为每个角色配置参考音频（`refAudioPath` 为 **GPT-SoVITS 服务端**可访问的路径）
   与提示文本
3. `tts.enabled: false` 可整体关闭配音；无 TTS 时导出仍会成功，只是没有角色配音

### BGM

BGM 设置单独放在资源根下的 `resources/audio/bgm/bgm.yaml`（改完重启宿主生效）：

```yaml
enabled: true              # 导出时是否混入 BGM
path: audio/bgm/bg1.mp3    # 相对资源根（resources/）的路径，也可用绝对路径或 http(s) URL
volume: 0.2                # 音量 0.0 - 1.0
```

该文件不存在时，宿主回落到 `config.yaml` 的 `bgm` 节（同样三个字段），旧配置照常可用。

## 导出模式

`config.yaml` 的 `video.exportMode`（环境变量 `MSS_EXPORT_MODE`）在两条管线间切换，默认 `record`。

| 模式     | 怎么出片 | 耗时怎么涨 |
| -------- | -------- | ---------- |
| `record` | MediaRecorder 实时采集，宿主同步编码为 H.264，收尾只合入音轨 | 至少等于视频时长，编码与录制重叠 |
| `fast`   | 虚拟时钟按时间轴逐帧推进动画，页内 WebCodecs 直编或帧序列交 ffmpeg 硬编 | 跟「帧数 x 每帧 GPU 读回」成正比，不再跟视频时长 1:1 |

- `record` 统一使用 `video.width`、`video.height`、`video.fps`、`video.crf` 和 `video.encoder`；
  浏览器采集与宿主 H.264 编码并行，结束后只把 TTS/BGM 音轨合入 MP4。浏览器会优先选择
  H.264 High profile，若环境不支持则回退到可用的采集格式；编码器不可用时由宿主回退 CPU。
- `record` 的画质/体积用 `crf` 调整（越小越清晰、体积越大），`fps` 同时限制采集与渲染频率。
  输出始终遵循 `width` / `height`，`renderScale < 1` 仍会先低分辨率渲染再放大，追求清晰度建议设为 `1`。
  旧的 `recordBitrate`、`recordStreamCopy`、`recordTargetSizeMb`、`recordBitrateOvershoot`、
  `recordKeyframeIntervalSec`、`recordCaptureFps` 及对应 `MSS_RECORD_*` 环境变量已移除，升级后可删除；
  旧字段不会阻止启动，但不再生效，也不再承诺固定文件体积上限。
- `fast` 的时间轴、TTS 落点与 `record` 同一套（台词时长按 TTS 波形 + 尾垫，音频离线混进 WAV 再 mux）；
  `video.exportFastEncoder`（`auto` / `webcodecs` / `frames`）决定页内直编还是帧序列硬编，
  `video.exportBitrate` 控制码率。WebCodecs 探测失败或 fast 整条失败时自动回退 `record`

## 部署

宿主是普通 Node 进程，**Windows / Linux / macOS 都能跑**，不依赖 Electron，也不强制要桌面环境。
平台差异、`config.yaml` 全字段说明、环境变量、systemd / Windows / macOS 常驻方式、GPU 排障与
升级流程都见 **[docs/host-deployment.md](docs/host-deployment.md)**。

```bash
npm run build
npm start          # node out-host/host/main.js，工作目录必须是仓库根
```

升级：`git pull` → 依赖有变再 `npm ci` → `npm run build` → 重启进程；
`config.yaml` 与 `resources/` 不入库，不会被覆盖。不要用 Docker 跑渲染宿主
（无头 Chrome 的 GPU 透传收益差，还多一层排障）。

## 项目结构

```
config.example.yaml   统一配置样例（复制为 config.yaml 使用，config.yaml 不入库）
CHANGELOG.md          版本变更记录
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

- **启动报 "Failed to launch any browser"**：系统没有 Edge/Chrome 且未下载 playwright 浏览器。
  执行 `npx playwright install chromium` 或安装系统 Chrome/Edge
- **health 显示 SwiftShader / llvmpipe**：WebGL 落到了软件渲染（导出慢 5–10 倍、可能音画不同步）。
  按平台调整 `render.extraChromeArgs`，见 [docs/host-deployment.md](docs/host-deployment.md) 的 WebGL 章节
- **导出失败或卡住**：查宿主日志里的 ffmpeg / 渲染错误；显存或内存不足时下调 `render.workers`；
  确认 `video.encoder` 取值（`auto` / `nvidia` / `amd` / `intel` / `libx264`，不是 ffmpeg 的 `nvenc`
  字符串）对应硬件可用——record 会试编码确认硬件可用；编码失败回退 CPU，并在日志提示。fast 失败仍回退 record
- **开了 fast 反而更慢**：fast 每帧都要把 WebGL 画布读回给编码器，核显上这可能比「等墙钟录完」更贵。
  短片继续用 `record`，长片或独显再开 `fast`；也可把 `renderScale` 从 `1.5` 降到 `1.0` 减轻读回

## 相关项目

- [astrbot_plugin_msst](https://github.com/yonglanws/astrbot_plugin_msst) ——
  官方 AstrBot 插件：AI 剧本生成、队列调度与机器人视频回传，通过 HTTP API 与本宿主交互

## 许可证

本项目基于 [Untitled-Story/MySekaiStoryteller](https://github.com/Untitled-Story/MySekaiStoryteller)
二次开发，沿用 **[GNU GPL v3](LICENSE)** 许可证开源；导出视频的使用另受原项目中的
[VIDEO-LICENSE-CN.md](VIDEO-LICENSE-CN.md) 约束。

## 致谢

[Untitled-Story/MySekaiStoryteller](https://github.com/Untitled-Story/MySekaiStoryteller) ·
[Sekai-World/sekai-viewer](https://github.com/Sekai-World/sekai-viewer) ·
[lezzthanthree/SEKAI-Stories](https://github.com/lezzthanthree/SEKAI-Stories)
