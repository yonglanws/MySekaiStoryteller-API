# 导出模式

[返回 README](../README.md) · [故事文件格式](story-format.md) · [故障排除](troubleshooting.md)
本文导航：[参数与默认值](#通用参数与默认值) · [回退顺序](#路径选择与回退顺序) · [调参案例](#调参案例) · [耗时统计](#如何读耗时与统计) · [旧配置迁移](#旧配置迁移)
本文针对当前 API 视频导出。参数由宿主的 `config.yaml` 下发，不是故事 JSON 字段，也不是请求级画质选项。
配置在宿主启动时读取，修改后重启；已实现的 `MSS_*` 环境变量覆盖 YAML，YAML 未填写的字段再使用内置默认值。

## 两种模式怎么选

| 模式               | 执行路径                                                        | 适用场景与代价                                                   |
| ------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| `record`（默认）   | 浏览器 MediaRecorder 实时采集，宿主同步编码 H.264，最后合入音轨 | 先用它建立稳定基线；采集需经历故事播放时间，编码与采集重叠       |
| `fast` + WebCodecs | 虚拟时钟逐帧推进，浏览器页内编码 H.264/MP4，宿主复制视频流合轨  | 浏览器编码路径合适时可减少等待；逐帧读回、缩放和编码仍有成本     |
| `fast` + frames    | 同样使用虚拟时钟，但先输出 JPEG 帧，再交 ffmpeg 编码            | 适合浏览器直编不适用而宿主编码较好的环境；增加临时磁盘与传输负担 |

`fast` 不是加速播放，也不承诺比实时录制更快；高分辨率、超采样、软件渲染或 TTS 等待都可能使它更慢。
比较时使用同一剧本、相同资源和输出条件，并记录最终实际使用的路径，而不是只看配置中的模式名。

## 通用参数与默认值

**内置默认值不等于示例文件值。** 下表前一列取自 `src/host/config.ts`，后一列是公开模板明确填写的值。
复制 [config.example.yaml](../config.example.yaml) 后会采用模板值，不能再把它称为“未配置默认”。

| `video` 字段        | 内置默认       | 模板显式值      | 单位、范围或约束                                                           |
| ------------------- | -------------- | --------------- | -------------------------------------------------------------------------- |
| `width` / `height`  | `1280` / `720` | `1920` / `1080` | 像素；使用正偶整数，推荐 16:9；record 的 H.264 编码会检查正整数和偶数      |
| `fps`               | `30`           | `60`            | 帧/秒；应为有限正数，推荐 24、30、60 等常用值；record 会检查正数           |
| `crf`               | `23`           | `28`            | 无单位质量因子；record 检查 `0`～`51`，其他编码器实际支持范围可能不同      |
| `renderScale`       | `1.5`          | `1`             | 渲染倍率；使用正数，`1` 为输出尺寸对应渲染，`<1` 降采样，`>1` 超采样       |
| `audioBitrate`      | `128k`         | `128k`          | AAC 目标码率字符串，例如 `96k`、`128k`、`192k`；有音轨时生效               |
| `encoder`           | `auto`         | `auto`          | 宿主 ffmpeg 编码选择：`auto` / `nvidia` / `amd` / `intel` / `libx264`      |
| `watermark`         | `true`         | `true`          | 布尔值，是否显示水印                                                       |
| `watermarkText`     | `""`           | `""`            | 自定义水印，最多两行，追加在自带两行下方；`\n` 换行                        |
| `exportMode`        | `record`       | `record`        | 枚举 `record` / `fast`                                                     |
| `exportBitrate`     | `12000000`     | `12000000`      | bps；正数，仅 fast 的 WebCodecs 视频编码使用                               |
| `exportFastEncoder` | `auto`         | `auto`          | 枚举 `auto` / `webcodecs` / `frames`，仅 fast 使用                         |
| `fastFps`           | `30`           | `30`            | 帧/秒；fast 有效值为 `max(1, min(fastFps, fps))`，建议 `1 ≤ fastFps ≤ fps` |
| `idleChainGapSec`   | `0`            | `0`             | 秒；`0` 关闭动作续演，正数以该间隔（±25% 抖动）接同情绪族手势              |

宿主 schema 对多数数值仅检查类型，不统一检查范围；“启动成功”不代表浏览器或编码器一定接受。
不要依赖负数、零尺寸或超大分辨率触发自动修正；GPU 纹理、显存、浏览器编码能力决定实际可用上限。
`crf` 对 libx264 是 CRF，对 NVIDIA 是 CQ，对 AMD 是 QP，对 Intel 是 `global_quality`；同一个数字不代表同等画质或体积。
质量因子通常越小越清晰、体积越大，但不能用它指定固定大小；WebCodecs 直编不使用这个质量因子。

常用环境变量映射如下；没有列出的字段不要自行推测 `MSS_*` 名称。

| 字段                               | 环境变量                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `width` / `height` / `fps` / `crf` | `MSS_VIDEO_WIDTH` / `MSS_VIDEO_HEIGHT` / `MSS_VIDEO_FPS` / `MSS_VIDEO_CRF` |
| `encoder`                          | `MSS_FFMPEG_ENCODER`，不是 ffmpeg codec 名 `nvenc`                         |
| `exportMode` / `exportBitrate`     | `MSS_EXPORT_MODE` / `MSS_EXPORT_BITRATE`                                   |
| `exportFastEncoder` / `fastFps`    | `MSS_EXPORT_FAST_ENCODER` / `MSS_FAST_FPS`                                 |
| `watermark` / `watermarkText`      | `MSS_VIDEO_WATERMARK` / `MSS_VIDEO_WATERMARK_TEXT`                         |
| `idleChainGapSec`                  | `MSS_IDLE_CHAIN_GAP_SEC`                                                   |

`renderScale`、`audioBitrate` 当前没有对应环境变量读取分支，应修改 YAML。
整数类环境变量用 `parseInt` 解析，`MSS_EXPORT_BITRATE` 必须为正，`MSS_FAST_FPS` 至少为 `1`；不要填带单位的 `12Mbps`。

## 参数在哪条路径生效

| 参数或阶段                        | record                 | fast / WebCodecs                    | fast / frames                      |
| --------------------------------- | ---------------------- | ----------------------------------- | ---------------------------------- |
| `width` / `height`、`renderScale` | 生效                   | 生效                                | 生效                               |
| `fps`                             | 采集目标及渲染频率上限 | 与 `fastFps` 一起决定有效帧率       | 与 `fastFps` 一起决定有效帧率      |
| `fastFps`                         | 不使用                 | 使用                                | 使用                               |
| `crf`                             | 宿主质量编码           | 不使用                              | 宿主质量编码                       |
| `encoder`                         | 选择宿主视频编码器     | 不控制浏览器编码器；合轨仍需 ffmpeg | 选择宿主视频编码器                 |
| `exportBitrate`                   | 不使用                 | 浏览器编码目标码率                  | 不使用，不能用它调 frames 视频码率 |
| `audioBitrate`                    | 合轨时 AAC 编码        | 合轨时 AAC 编码                     | 合轨时 AAC 编码                    |

### record：实时录制

采集格式优先 H.264 High profile MP4，再尝试其他 MP4/H.264、WebM H.264、VP8、VP9 等可用格式。
中间采集码率由画布像素数与帧率计算，限制在 `8,000,000`～`40,000,000` bps，关键帧间隔请求为 1000 毫秒；
这些是内部采集参数，不是最终视频码率，也不是用户可配置的体积上限。
浏览器边采集边把数据送给宿主编码，结束后排空编码任务，再以视频流复制方式合入 TTS/BGM 音轨。
最终编码保留采集时间戳，不强制补成精确恒定帧率；`fps: 60` 不保证负载过高时每秒实际得到 60 帧。
TTS 等待、背压和硬件负载可能拉长采集与收尾，不能仅以剧本估算时长承诺任务完成时间。

### fast：虚拟时钟与帧率

正确配置字段是 **`video.fastFps`**，不是 `exportFastFps`；未知字段会被 schema 去掉，写错可能没有报错但不生效。
例如 `fps: 60`、`fastFps: 30` 时，两条 fast 路径按 30 fps 编码，帧泵每次推进约 `1000 / 30` 毫秒虚拟时间。
当前实现还把 `AnimationManager.exportTargetFPS` 和 `Ticker.shared.maxFPS` 设为这个有效帧率，
因此不能把模板中的“动画仍按 video.fps 推进”理解为始终保留独立 60 fps 动画更新。
降低上限是减少时间采样和画面更新，不是让台词按倍速播放；过低时动作会不连贯，离散步进也可能影响片段边界。
fast 等待 TTS 时暂停帧泵，等待耗时不会直接作为同等长度空白写入时间轴；两种模式仍共用台词/音轨落点规则。

### 渲染倍率与清晰度

场景逻辑坐标固定为 1280×720；后备画布倍率是 `renderScale × width / 1280`。
在 1920×1080 输出下，`renderScale: 0.75` 约先渲染 1440×810，随后放大；`1.5` 约渲染 2880×1620 后缩小。
超采样增加像素数（1.5 倍边长约为 2.25 倍像素），不代表耗时也固定增加 2.25 倍。
降低倍率会软化文字和轮廓，提高码率不能恢复未渲染的细节。先试 `1`，确认有余量再增加。
建议保持 16:9；非 16:9 输出在不同缩放路径下处理不同，不能承诺三条路径具有相同留边或构图。

## 硬件渲染与硬件编码

WebGL 负责画模型，视频编码负责压缩帧，二者是独立路径：有硬件 WebGL 不等于 ffmpeg 或 WebCodecs 已用硬件编码。
查看 worker 的 `WebGL renderer` 日志；`SwiftShader`、`software`、`llvmpipe` 通常提示软件渲染。
ffmpeg 选择值对应 `nvidia → h264_nvenc`、`amd → h264_amf`、`intel → h264_qsv`、`libx264 → CPU`。
WebCodecs 自行探测浏览器能力，不受 `video.encoder: nvidia` 强制控制；`prefer-hardware` 是偏好，不是硬件使用证明。
健康检查的 `ffmpegEncoderDetected` 来自 `ffmpeg -encoders` 列表探测，不能替代 record 实际试编码或本次任务日志。
平台配置见 [部署指南](host-deployment.md#按平台)，不要只凭“机器有显卡”判断加速生效。

## 路径选择与回退顺序

1. `record` 的 `encoder: auto` 依次真实试编码 NVIDIA、AMD、Intel，全部不可用才用 CPU。
   显式指定硬件时只试该硬件，失败用 CPU；`libx264` 直接用 CPU。实际硬件流编码失败时保留采集数据，收尾用 CPU 重编码一次。
2. fast 的 `exportFastEncoder: frames` 直接走 JPEG；`auto` / `webcodecs` 先探测 WebCodecs H.264。
   探测按 High → Main → Baseline，每级先 `prefer-hardware` 再 `no-preference`；全部不可用则走 frames。
3. `auto` 在探测到 Linux（非 Android）且 WebGL renderer 为 NVIDIA/GeForce/Quadro 时选择 frames；
   `webcodecs` 跳过这条平台启发式，但仍会在能力探测不可用时使用 frames，并非“强制成功”。
4. frames 由共享 ffmpeg 逻辑选择编码器；`auto` 按 NVIDIA → AMD → Intel 的编码器列表探测，不做 record 那套实际试编码。
   当前 frames 编码函数没有独立的“编码失败立刻改 libx264”重试，不能套用 record 的硬件回退描述。
5. fast 真正运行失败（包括已选择 WebCodecs 后初始化/编码失败、frames 编码失败）时，除主动取消外整体回退 record。
   这是重跑实时路径，不是接着未完成帧继续；不会在所有运行失败后都先重试 frames，也不保证资源或环境故障得到解决。

## 调参案例

以下三段均是 **`config.yaml` 的 `video` 片段**，不是完整配置文件；选择一段合并进现有 `video`，不要连续粘贴多个同名键。
未列出的字段保留你的现有配置；这些数值只是比较起点，不保证固定体积、速度或画质等级。

### 低负担基线：先排除过高分辨率与超采样

```yaml
video:
  exportMode: record
  width: 1280
  height: 720
  fps: 30
  renderScale: 1
  crf: 26
  encoder: auto
```

先确认输出正常；文字模糊先检查倍率与分辨率，块状压缩明显再试把 `crf` 从 26 降到 23。
record 仍需实时播放；降低参数主要降低负载和积压，不是把播放时间缩短一半。

### 1080p 清晰度比较：固定渲染条件再比较编码质量

```yaml
video:
  exportMode: record
  width: 1920
  height: 1080
  fps: 30
  renderScale: 1
  crf: 20
  audioBitrate: 192k
  encoder: auto
```

若边缘锯齿仍明显，可单独试 `renderScale: 1.25`；若动作流畅度优先，另测 `fps: 60`。
不要同时改帧率、倍率和编码器，否则难以判断耗时或画质变化来自哪一项。

### fast 路径对比：区分目标码率与质量因子

```yaml
video:
  exportMode: fast
  width: 1920
  height: 1080
  fps: 60
  fastFps: 30
  renderScale: 1
  exportFastEncoder: webcodecs
  exportBitrate: 12000000
  crf: 23
  encoder: auto
```

先确认日志实际选择 WebCodecs，再比较 `exportBitrate: 8000000` 与 `12000000`；码率是目标，不是文件大小硬上限。
若改为 `exportFastEncoder: frames`，应比较 `crf: 23` 与 `28`，再调整 `encoder`，而不是继续改 `exportBitrate`。
两条 fast 路径都可把 `fastFps` 降到 24 来观察吞吐与动作平滑度；降低到不可接受的帧率并不是有效优化。
同时关注临时盘空间和 worker 并发：多 worker 提升的是并行吞吐，争用 CPU/GPU/TTS 时也可能拖慢单个任务。

## 如何读耗时与统计

API 返回的 `duration` 单位是 **秒**，表示渲染页处理此次导出的墙钟耗时，包含页内初始化、资源加载和导出，
不是成片播放时长，也不含宿主排队和客户端网络传输的全部时间。端到端耗时应由调用方另行计时。
`timings` 大部分是毫秒，但 `frames` 是帧数、`avgPumpFps` 是吞吐率；字段取决于最终执行路径。

| 指标                                      | 当前含义                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------- |
| record `recordMs`                         | 从启动采集到停止并排空采集写入的墙钟耗时；包含采集期等待，不等于完整导出耗时        |
| record `mergeMs`                          | 停采后的音频混合、临时写盘、等待剩余编码完成与最终合轨；不只是 ffmpeg mux           |
| record `videoDurationMs`                  | 从编码中间 MP4 的 `mvhd` 读到的播放时长；不是顶层 `duration`，也不替代最终文件检查  |
| fast `pumpMs`                             | 各次帧泵迭代的墙钟耗时累计，含 tick、render、抓帧及校验等，不含循环暂停的全部等待   |
| fast `tickMs` / `renderMs` / `snapshotMs` | 帧泵内推进虚拟时钟、绘制、抓帧/提交编码的分项；`snapshotMs` 可含编码背压            |
| fast `ttsWaitMs`                          | 片段执行显式等待 TTS 就绪的耗时，不是后台所有 TTS 请求耗时之和                      |
| fast `encodeMs`                           | 页内编码器 flush/finalize，或 JPEG 队列排空时间；不是 frames 的宿主 ffmpeg 编码耗时 |
| fast `audioMs`                            | 离线混音、WAV 转换与临时音频写盘耗时                                                |
| fast `invokeMs`                           | 宿主收尾调用；WebCodecs 是 remux，frames 含 ffmpeg 视频编码及可选合轨               |
| fast `frames` / `avgPumpFps`              | 实际帧泵次数，以及 `frames / (pumpMs / 1000)`；不是输出播放 fps                     |

分项存在包含关系和并发重叠，不能把全部 `timings` 相加当作总耗时。
record 的顶层 `frameCount` 来自编码结果；fast 顶层值由时间轴估算，与 `timings.frames` 不一定相等。
需要真实成片时长、平均帧率和文件大小时，检查最终 MP4 元数据；不要用 `duration` 或 `frameCount / fps` 代替。

## 旧配置迁移

旧 `video.recordBitrate`、`recordStreamCopy`、`recordTargetSizeMb`、`recordBitrateOvershoot`、
`recordKeyframeIntervalSec`、`recordCaptureFps` 及相应 `MSS_RECORD_*` 环境变量已无当前配置读取入口。
旧字段一般不会阻止启动，但也不会生效；删除后用 `fps`、`width/height`、`renderScale`、`crf`、`encoder` 调整 record。
没有对应的“固定体积上限”替代项；`exportBitrate` 不能拿来替代 record 旧码率配置，frames 也不使用它。
若旧配置写了 `exportFastFps`，改为 `fastFps`。迁移后核对有效参数与回退日志，再按同一剧本比较结果。

源码依据：`src/host/config.ts`、`src/host/record/recordEncoder.ts`、`src/shared/ffmpeg.ts`、
`src/renderer/src/app/App.ts` 与 `src/renderer/src/managers/VideoExportManager.ts`；示例解析只能验证结构，不能证明硬件可用。
