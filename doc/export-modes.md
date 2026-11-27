# 导出模式与提速调参

[返回 README](../README.md) · [故事文件格式](story-format.md) · [故障排除](troubleshooting.md)

所有画质、帧率、编码器和配音调度参数都由宿主 `config.yaml` 的 `video` 节（或 `MSS_*` 环境变量）控制，不在故事 JSON 或单次导出请求里传。修改配置后需要重启宿主。

## 渲染与编码管线（只有 `fast`）

现在只有 **`exportMode: fast`** 这一条活跃导出管线（老的实时录制 `record` 模式和 Electron 时代的离线 `frames` 模式均已彻底清理，保留 `exportMode` 字段仅作兼容提示并自动走 `fast`）。

`fast` 模式的核心是**确定性 60Hz 虚拟时钟**：无论最终输出帧率是 `60fps` 还是 `30fps`，故事时间轴、Live2D 动作混合、眨眼、呼吸与官方口型包络都严格按 `1/60s` 故事步推进（30fps 下精确每 2 个故事步采 1 帧，保持 **30fps Live2D 演出与 60fps 完全一致**），就算服务器某几帧卡顿，成片节奏和音画同步也不会飘。它有两条页内编码路径，按环境自动选：

| 路径                                                                                      | 怎么工作的                                                                                                                                                                                                                                                                                                                                                                                                                        | 什么时候走它 / 优缺点                                                                                                                                   |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WebCodecs 直编**                                                                        | 浏览器用 WebGL2 GPU 把画布直接转成 BT.709 limited-range `I420`（`GpuYuv420Converter`，3-slot PBO 异步读回 + `texSubImage2D` 纹理复用）喂给 `VideoEncoder` 经二进制 WebSocket 写 MP4；若源流已符合 BT.709/tv 且未超 `maxOutputMbps`，宿主直接 `-c:v copy` 合入音轨                                                                                                                                                                 | 桌面/核显支持硬件 `VideoEncoder`（5 帧测速 `≤ 150ms`）时默认优先；**免掉 JPEG 传图，也不用 ffmpeg 二次重编码视频**                                      |
| **Rust `/bridge/rs-stream` 二进制 WS `rawvideo` 管道（含 HTTP / `image2pipe` 自动回退）** | 用 `GpuYuv420Converter`（3-slot PBO + `texSubImage2D`）在 GPU 端直接转为 `yuv420p`，当原生 Rust 桥接可用时，通过 `BinaryWsClient` 直连 Rust **`/bridge/rs-stream`** 二进制 WebSocket（`op: "open-pipe"`）：运动帧以单帧复用缓冲区发送 `KIND_PIPE_FRAME`，静止重复帧仅发 16 字节 `KIND_REPEAT_FRAME` 零负载指令，彻底跳过 HTTP POST 分批拷贝与主线程序列化；若 Rust 桥接不可用自动回退 HTTP `frames-stream-*` / `image2pipe` MJPEG | **Linux 无桌面服务器（如 Intel UHD 630 + Vulkan/QSV 或 NVIDIA NVENC）** 下 WebCodecs 只有慢速软编时自动接管。消除了旧 HTTP 管道的多次内存拷贝与往返停顿 |

此外，宿主内置了原生 **Rust 导出器（`native/mss-export-rs`，N-API 扩展，配置项 `useRustExporter: true`，可由 `MSS_USE_RUST_NAPI` / `MSS_RUST_NAPI_PATH` / `MSS_RUST_EXPORTER_PATH` 精细控制）**：

- **`mss-bridge`**：提供低延迟本地二进制 WebSocket 服务（`/bridge/rs-stream`），直收 `WebCodecs` 分片与 `rawvideo` 帧流。
- **`mss-encode`**：负责硬件编码（QSV / VAAPI / NVENC / AMF）与快速 CRF 压制/合流；硬件编码器探测结果在进程内按 `(ffmpeg, codec, backend, low_power)` 缓存，避免每次导出重复起探测进程；Linux 下支持 `MSS_VAAPI_DEVICE` 指定渲染节点（默认 `/dev/dri/renderD128`）。
- **`mss-audio` / `mss-core`**：负责多轨 BGM/SE/TTS 混音（默认 BGM 音量 `0.35` + 人声闪避）与官方 60Hz 口型包络计算，不可用时自动回落 JS `ffmpeg` 管线。

---

## 配置默认值 vs 示例文件值

> [!IMPORTANT]
> **内置默认值不等于 `config.example.yaml` / `.env.example` 里的值！**
> 没建 `config.yaml` 且没设环境变量时用的是 `src/host/config.ts` 的裸 schema 默认值；使用模板（`config.example.yaml`、`.env.example`、`npm run init` 或 Docker）时用的则是模板里显式写出的值。

| `video` 字段                  | 裸 Schema 默认值 | `config.example.yaml` 模板值 | 说明                                                                                                             |
| ----------------------------- | ---------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `width` / `height`            | `1280` / `720`   | `1920` / `1080`              | 必须是正偶数（yuv420p 硬性要求，否则启动或请求报错 400）                                                         |
| `fps`                         | `30`             | `60`                         | 故事时间轴基础帧率（`MSS_MEMORY_PROFILE=low` 时自动降为 `30`）                                                   |
| `fastFps`                     | `30`             | `60`                         | `fast` 实际编码输出帧率上限，有效值为 `max(1, min(fastFps, fps))`                                                |
| `renderScale`                 | `1.5`            | `1`                          | 渲染倍率（相对 1280 逻辑宽）。`1` = 输出多大画多大；`1.5` 超采样像素量 ×2.25                                     |
| `codec`                       | `hevc`           | `hevc`                       | `hevc`（H.265 + `hvc1` 标签）或 `h264`                                                                           |
| `crf`                         | `18`             | `27`                         | 质量因子（越小越清晰、文件越大），作用于 `ffmpeg` / Rust CRF 重编码路径                                          |
| `exportBitrate`               | `5500000`        | `5500000`                    | WebCodecs 路径的目标视频码率（bps，5.5 Mbps VBR）                                                                |
| `maxOutputMbps`               | `6.5`            | `6.5`                        | 成品平均视频码率软上限（Mbps，0 = 关闭）；超限时自动启用 Rust CRF 快速重编码控制体积                             |
| `useRustExporter`             | `true`           | `true`                       | 启用原生 Rust N-API 导出器、`/bridge/rs-stream` 与音频/口型加速                                                  |
| `exportJobs`                  | `1`              | `1`                          | 并行分段渲染数（`1~8`；Intel 核显推荐 `1`）                                                                      |
| `encoder`                     | `auto`           | `auto`                       | 硬件编码探测顺序：`nvidia` → `amd` → `intel` → 回退 CPU (`libx265`/`libx264`)。旧版写 `libx264` 强制用 CPU H.264 |
| `exportFastEncoder`           | `auto`           | `auto`                       | `auto`（推荐） / `webcodecs`（强制）/ `frames`（跳过 WebCodecs 直接走 GPU `rawvideo` 管道）                      |
| `audioBitrate`                | `192k`           | `128k`                       | 有音轨时的 AAC 码率                                                                                              |
| `watermark` / `watermarkText` | `true` / `""`    | `true` / `""`                | 右上角水印开关及自定义补充文字（最多 2 行，`\n` 换行）                                                           |
| `ttsMode`                     | `concurrent`     | `concurrent`                 | `concurrent` = 边渲染边并发合成最多 3 句；`serial` = 全合成完再渲染                                              |
| `idleChainGapSec`             | `0`              | `0`                          | 动作播完后行为：`0` = 保持末帧姿势+呼吸眨眼；`>0` = 按此间隔接同情绪动作                                         |
| `exportMode`                  | `fast`           | `fast`                       | 只支持 `fast`（`record` 与 `recordTargetSizeMb` 均已废弃）                                                       |

关于 `crf` 和色彩：

- 对 `libx264`/`libx265` 叫 CRF，对 NVIDIA 是 CQ，对 AMD 是 QP，对 Intel 是 `global_quality`，不同硬件同等数字体积和观感不完全一样。
- 所有导出路径都会统一转成并标记为 **BT.709 limited range（`tv`）**，防止浏览器直出偏色或灰蒙蒙。

---

## 怎么调更快？（常用配置抄作业）

### 场景 1：1080p 30fps 流畅兼顾体积（推荐常规 Linux / Intel UHD 630 / Iris Xe）

借助 30fps Live2D 逐帧对齐与 Rust `/bridge/rs-stream` 二进制 WS 管道，1080p 30fps 导出比 60fps 少一半抓帧与编码开销，同时保持 60Hz Live2D 动作、口型和眨眼完整精度：

```yaml
video:
  width: 1920
  height: 1080
  fps: 30
  fastFps: 30
  renderScale: 1 # 别开 1.5，1080p 下 1.5 要渲染 2880x1620，很吃显存
  codec: hevc
  crf: 27
  exportBitrate: 5500000
  maxOutputMbps: 6.5
  useRustExporter: true
  exportFastEncoder: auto
  encoder: intel # 或 auto（配合 MSS_GPU_PROFILE=intel）
  ttsMode: concurrent
```

Intel UHD 630 等 Linux 无桌面核显环境建议配合以下环境变量：

```bash
MSS_GPU_PROFILE=intel
MSS_VAAPI_DEVICE=/dev/dri/renderD128   # 仅多渲染节点时按需调整
MALLOC_ARENA_MAX=2
MALLOC_MMAP_THRESHOLD_=131072
```

### 场景 2：4~8 GB 低内存主机 / NAS（一键低内存预设）

在 `.env` 或环境变量中开启低内存档位即可（记得注释 `.env` 中显式的 `MSS_VIDEO_FPS` / `MSS_FAST_FPS`）：

```bash
MSS_MEMORY_PROFILE=low
# 等价于自动应用：
# workers=1, maxConcurrentExports=1, workerRecycleExports=2,
# fps=30, fastFps=30, renderScale=1.0
```

### 场景 3：720p 轻量 / 单显卡同时跑本地 IrodoriTTS

```yaml
video:
  width: 1280
  height: 720
  fps: 30
  fastFps: 30
  renderScale: 1
  crf: 23
  exportFastEncoder: auto
  encoder: auto
  ttsMode: serial # 避免渲染 WebGL/硬件编码 和 本地 TTS 抢同一张显卡算力
```

### 几个最立竿见影的提速点

1. **确认用的是真 GPU + 原生 Rust 扩展**：去 `/api/v1/health` 看 `renderPool.webglRenderers` 不是 `SwiftShader`/`llvmpipe`，`host.ffmpegEncoderDetected` 不是软件回退，且 `rustExporter.available` 为 `true`。
2. **把 `renderScale` 保持在 `1`**：相比裸默认值 `1.5`，像素数量少一半多，肉眼在 1080p 下几乎没差别，速度快一截。
3. **优先用 `30fps`（`fps: 30`、`fastFps: 30`）**：30fps 导出比 60fps 少一半编码帧，Live2D 动作、口型和眨眼仍按 60Hz 虚拟步进精准对齐。
4. **并发 TTS（默认 `concurrent`）**：不用等几十句配音全生成完才开始画第一帧，且会提前 3 句预解码音频和口型包络。只有单张小显存卡同时跑本地 TTS 时才建议改回 `serial`。

---

## 怎么看返回里的耗时和日志

每次导出成功会在同目录生成 `.log`（文本日志）、`.log.json`（结构化数据）和 `.report.txt`（汇总报告）。

先分清两个最容易混淆的字段：

- API 顶层的 **`duration`**（单位**秒**）：**渲染导出过程一共花了多久**（不含排队时间）。
- `timings.videoDurationMs`（单位**毫秒**）：**成片视频本身的播放长度**。

`timings` 里各项的含义（**注意它们之间有并行和包含关系，不能直接相加**）：

| 字段                    | 含义                                                                        |
| ----------------------- | --------------------------------------------------------------------------- |
| `pumpMs`                | 帧泵跑所有帧的耗时（含时钟推进、渲染、抓帧），不含暂停等 TTS 的时间         |
| `tickMs` / `renderMs`   | 虚拟时钟更新 / PixiJS 渲染绘制的分项耗时                                    |
| `snapshotMs`            | 抓帧 / GPU YUV 转换 / 送进 WebCodecs 或 Rust `/bridge/rs-stream` 管道的耗时 |
| `ttsWaitMs`             | 渲染卡住等待某句 TTS 合成或口型解码的时间（如果后台提前合成好了就是 `0`）   |
| `encodeMs`              | 页内编码器收尾 flush 或帧管道排空的时间                                     |
| `audioMs`               | 混音和流式写 WAV 在帧泵结束后的剩余等待                                     |
| `invokeMs`              | 宿主 Rust 导出器 / `ffmpeg` 最终封装或重编码成片的时间                      |
| `frames` / `avgPumpFps` | 总帧数与渲染泵吞吐帧率（不是播放帧率）                                      |
| `wallMs`                | 渲染端本次导出的总墙钟毫秒数                                                |

如果想排查“动作为什么忽然卡顿或被抢断”，看 `.log` 里的 motion trace：`load` 列不为 0 说明动作没提前预加载；`played` 远小于 `clip` 说明动作播一半就被下一句切掉了。
