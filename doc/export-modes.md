# 导出模式与提速调参

[返回 README](../README.md) · [故事文件格式](story-format.md) · [故障排除](troubleshooting.md)

所有画质、帧率、编码器和配音调度参数都由宿主 `config.yaml` 的 `video` 节（或 `MSS_*` 环境变量）控制，不在故事 JSON 或单次导出请求里传。修改配置后需要重启宿主。

## 渲染与编码管线（只有 `fast`）

现在只有 **`exportMode: fast`** 这一条活跃导出管线（老的实时录制 `record` 模式已彻底删除，保留字段只作兼容提示并自动走 `fast`）。

`fast` 模式的核心是**确定性虚拟时钟**：动画永远按固定 `1/60s`（60Hz）故事步推进，就算服务器某几帧卡顿，成片节奏和音画同步也不会飘。它有两条页内编码路径，按环境自动选：

| 路径                                            | 怎么工作的                                                                                                                                                                         | 什么时候走它 / 优缺点                                                                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **WebCodecs 直编**                              | 浏览器用 WebGL2 GPU 把画布直接转成 BT.709 limited-range `I420`（`GpuYuv420Converter`）喂给 `VideoEncoder` 写 MP4；若源流已符合 BT.709/tv，宿主直接 `-c:v copy` 合入音轨            | 桌面/核显支持硬件 `VideoEncoder`（5 帧测速 `≤ 150ms`）时默认优先；**免掉 JPEG 传图，也不用 ffmpeg 二次重编码视频**                      |
| **GPU `rawvideo` 管道（或 `image2pipe` 回退）** | 优先用 WebGL2 GPU 将画布直转为 `yuv420p` 并通过 PBO 双缓冲异步读回，多帧拼批走 `rawvideo` 管道直喂宿主 `ffmpeg`；不支持 WebGL2 时退回 `image2pipe` MJPEG 管道（再不行才落盘 JPEG） | 无桌面 Linux + NVIDIA 等场景下 WebCodecs 只有慢速软编时自动接管。走 `rawvideo` 跳过了浏览器 JPEG 编码和 ffmpeg JPEG 解码 + CPU 色彩缩放 |

此外，宿主内置了原生 **Rust 导出器（`native/mss-export-rs`，N-API 扩展，配置项 `useRustExporter: true`）** 负责硬件 QSV CRF 压制/合流（`mss-encode`）以及多轨 BGM/SE/TTS 混音（`mss-audio`）与口型包络计算（`mss-core`），不可用时自动回落 JS `ffmpeg` 管线。中间临时封装也省掉了重复的 `+faststart` 重写，并支持多帧批量上传和零拷贝二进制传输。

---

## 配置默认值 vs 示例文件值

> [!IMPORTANT]
> **内置默认值不等于 `config.example.yaml` 里的值！**
> 没建 `config.yaml` 时用的是 `src/host/config.ts` 的内置默认值；复制 `config.example.yaml` 之后用的则是模板里显式写出的值。

| `video` 字段                  | 内置默认值     | `config.example.yaml` 模板值 | 说明                                                                                                             |
| ----------------------------- | -------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `width` / `height`            | `1280` / `720` | `1920` / `1080`              | 必须是正偶数（yuv420p 硬性要求，否则启动或请求报错 400）                                                         |
| `fps`                         | `30`           | `60`                         | 故事时间轴基础帧率                                                                                               |
| `fastFps`                     | `30`           | `60`                         | `fast` 实际编码输出帧率上限，有效值为 `max(1, min(fastFps, fps))`                                                |
| `renderScale`                 | `1.5`          | `1`                          | 渲染倍率（相对 1280 逻辑宽）。`1` = 输出多大画多大；`1.5` 超采样像素量 ×2.25                                     |
| `codec`                       | `hevc`         | `hevc`                       | `hevc`（H.265 + `hvc1` 标签）或 `h264`                                                                           |
| `crf`                         | `18`           | `27`                         | 质量因子（越小越清晰、文件越大），作用于 `ffmpeg` / Rust CRF 重编码路径                                          |
| `exportBitrate`               | `5500000`      | `5500000`                    | WebCodecs 路径的目标视频码率（bps，5.5 Mbps VBR）                                                                |
| `maxOutputMbps`               | `6.5`          | `6.5`                        | 成品平均视频码率软上限（Mbps，0 = 关闭）；超限时自动启用 Rust CRF 快速重编码控制体积                             |
| `useRustExporter`             | `true`         | `true`                       | 启用原生 Rust N-API 导出器与音频/口型加速                                                                        |
| `exportJobs`                  | `1`            | `1`                          | 并行分段渲染数（`1~8`；Intel 核显推荐 `1`）                                                                      |
| `encoder`                     | `auto`         | `auto`                       | 硬件编码探测顺序：`nvidia` → `amd` → `intel` → 回退 CPU (`libx265`/`libx264`)。旧版写 `libx264` 强制用 CPU H.264 |
| `exportFastEncoder`           | `auto`         | `auto`                       | `auto`（推荐） / `webcodecs`（强制）/ `frames`（跳过 WebCodecs 直接走帧管道）                                    |
| `audioBitrate`                | `192k`         | `128k`                       | 有音轨时的 AAC 码率                                                                                              |
| `watermark` / `watermarkText` | `true` / `""`  | `true` / `""`                | 右上角水印开关及自定义补充文字（最多 2 行，`\n` 换行）                                                           |
| `ttsMode`                     | `concurrent`   | `concurrent`                 | `concurrent` = 边渲染边并发合成最多 3 句；`serial` = 全合成完再渲染                                              |
| `idleChainGapSec`             | `0`            | `0`                          | 动作播完后行为：`0` = 保持末帧姿势+呼吸眨眼；`>0` = 按此间隔接同情绪动作                                         |
| `exportMode`                  | `fast`         | `fast`                       | 只支持 `fast`（`record` 与 `recordTargetSizeMb` 均已废弃）                                                       |

关于 `crf` 和色彩：

- 对 `libx264`/`libx265` 叫 CRF，对 NVIDIA 是 CQ，对 AMD 是 QP，对 Intel 是 `global_quality`，不同硬件同等数字体积和观感不完全一样。
- 所有导出路径都会统一转成并标记为 **BT.709 limited range（`tv`）**，防止浏览器直出偏色或灰蒙蒙。

---

## 怎么调更快？（常用配置抄作业）

### 场景 1：1080p 流畅兼顾体积（推荐常规服务器）

```yaml
video:
  width: 1920
  height: 1080
  fps: 60
  fastFps: 30 # 动画按 60fps 算，编码 30fps，抓帧和编码耗时直接减半
  renderScale: 1 # 别开 1.5，1080p 下 1.5 要渲染 2880x1620，很吃显存
  codec: hevc
  crf: 27
  exportBitrate: 5500000
  maxOutputMbps: 6.5
  useRustExporter: true
  exportFastEncoder: auto
  encoder: auto
  ttsMode: concurrent
```

### 场景 2：720p 轻量 / 单显卡同时跑本地 IrodoriTTS

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

1. **确认用的是真 GPU**：去 `/api/v1/health` 看 `renderPool.webglRenderers` 不是 `SwiftShader`/`llvmpipe`，`host.ffmpegEncoderDetected` 不是软件回退。
2. **把 `renderScale` 从内置 `1.5` 改回 `1`**：像素数量少一半多，肉眼在 1080p 下几乎没差别，速度快一截。
3. **保持 `fastFps: 30`**：30fps 导出比 60fps 少一半编码帧，口型和立绘动画依然丝滑。
4. **并发 TTS（默认 `concurrent`）**：不用等几十句配音全生成完才开始画第一帧，且会提前 3 句预解码音频和口型包络。只有单张小显存卡同时跑本地 TTS 时才建议改回 `serial`。

---

## 怎么看返回里的耗时和日志

每次导出成功会在同目录生成 `.log`（文本日志）、`.log.json`（结构化数据）和 `.report.txt`（汇总报告）。

先分清两个最容易混淆的字段：

- API 顶层的 **`duration`**（单位**秒**）：**渲染导出过程一共花了多久**（不含排队时间）。
- `timings.videoDurationMs`（单位**毫秒**）：**成片视频本身的播放长度**。

`timings` 里各项的含义（**注意它们之间有并行和包含关系，不能直接相加**）：

| 字段                    | 含义                                                                      |
| ----------------------- | ------------------------------------------------------------------------- |
| `pumpMs`                | 帧泵跑所有帧的耗时（含时钟推进、渲染、抓帧），不含暂停等 TTS 的时间       |
| `tickMs` / `renderMs`   | 虚拟时钟更新 / PixiJS 渲染绘制的分项耗时                                  |
| `snapshotMs`            | 抓帧 / GPU YUV 转换 / 送进 WebCodecs 或帧管道队列的耗时                   |
| `ttsWaitMs`             | 渲染卡住等待某句 TTS 合成或口型解码的时间（如果后台提前合成好了就是 `0`） |
| `encodeMs`              | 页内编码器收尾 flush 或帧管道排空的时间                                   |
| `audioMs`               | 混音和流式写 WAV 在帧泵结束后的剩余等待                                   |
| `invokeMs`              | 宿主 `ffmpeg` 最终封装/重编码成片的时间                                   |
| `frames` / `avgPumpFps` | 总帧数与渲染泵吞吐帧率（不是播放帧率）                                    |
| `wallMs`                | 渲染端本次导出的总墙钟毫秒数                                              |

如果想排查“动作为什么忽然卡顿或被抢断”，看 `.log` 里的 motion trace：`load` 列不为 0 说明动作没提前预加载；`played` 远小于 `clip` 说明动作播一半就被下一句切掉了。
