# 导出模式

[返回 README](../README.md) · [故事文件格式](story-format.md) · [故障排除](troubleshooting.md)
本文导航：[唯一管线与子路径](#唯一管线与子路径) · [参数与默认值](#通用参数与默认值) · [回退顺序](#路径选择与回退顺序) · [并发 TTS 与虚拟时钟](#并发-tts-预热与虚拟时钟) · [调参案例](#调参案例) · [耗时统计](#如何读耗时与统计) · [旧配置迁移](#旧配置迁移)

本文针对当前 API 视频导出。参数由宿主的 `config.yaml` 下发，不是故事 JSON 字段，也不是请求级画质选项。
配置在宿主启动时读取，修改后重启；已实现的 `MSS_*` 环境变量覆盖 YAML，YAML 未填写的字段再使用内置默认值。

## 唯一管线与子路径

`exportMode: fast` 现为**默认且唯一活跃的视频渲染管线**。旧版实时录制管线（`record` / `MediaRecorder`、`src/host/record/`、`StreamRecorder`、`StreamMuxer` 与 `electron:record-*` 桥接通道）已移除；`exportMode: "record"` 与 `recordTargetSizeMb` 仅作为向后兼容的废弃别名保留，启动或导出时会打印废弃告警并自动委托到 `fast`。

`fast` 模式下按运行环境选择以下页内编码子路径：

| 子路径                  | 执行方式                                                                                                          | 适用场景与特点                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `fast` + WebCodecs      | 虚拟时钟逐帧推进，页内 `WebCodecsMp4Encoder` 直编 H.264/MP4 定位写盘；源流非 BT.709/tv 时宿主重编码修正色彩后合轨 | 浏览器具备快速硬件 `VideoEncoder`（5 帧测速 `≤ 150ms`）时优先使用，免除大量 JPEG 传输 |
| `fast` + `image2pipe`   | 同样使用虚拟时钟，`JpegFrameSink` 双缓冲抓取并异步编码 JPEG，经管道流式喂给宿主 FFmpeg                            | WebCodecs 不可用或为软件慢编（如无桌面 Linux + NVIDIA）时自动接管，零帧文件落盘       |
| `fast` + 磁盘帧序列兜底 | 仅当 `image2pipe` 流创建不可用时，写入临时 JPEG 批次再由宿主 `encodeFramesToVideo` 合成                           | 兜底路径；增加临时磁盘 I/O 与扫描成本                                                 |

`fast` 管线以确定性虚拟时钟推进动画，渲染速度不会改变成片时长与台词节奏；开启硬件 WebGL 与合适编码路径可显著缩短端到端墙钟耗时。

## 通用参数与默认值

**内置默认值不等于示例文件值。** 下表前一列取自 `src/host/config.ts`，后一列是公开模板明确填写的值。
复制 [config.example.yaml](../config.example.yaml) 后会采用模板值，不能再把它称为“未配置默认”。

| `video` 字段         | 内置默认       | 模板显式值       | 单位、范围或约束                                                                       |
| -------------------- | -------------- | ---------------- | -------------------------------------------------------------------------------------- |
| `width` / `height`   | `1280` / `720` | `1920` / `1080`  | 像素；使用正偶整数，推荐 16:9                                                          |
| `fps`                | `30`           | `60`             | 帧/秒；应为有限正数，推荐 24、30、60 等常用值                                          |
| `crf`                | `18`           | `28`             | 无单位质量因子；作用于 `image2pipe` / 帧序列的宿主 ffmpeg 编码（WebCodecs 不使用此值） |
| `renderScale`        | `1.5`          | `1`              | 渲染倍率；使用正数，`1` 为输出尺寸对应渲染，`<1` 降采样，`>1` 超采样                   |
| `codec`              | `hevc`         | 未填写（取默认） | 枚举 `hevc` / `h264`；HEVC 用 libx265 或同名硬件编码器，MP4 带 `-tag:v hvc1`           |
| `audioBitrate`       | `192k`         | `128k`           | AAC 目标码率字符串，例如 `96k`、`128k`、`192k`；有音轨时生效                           |
| `encoder`            | `auto`         | `auto`           | 宿主 ffmpeg 编码选择：`auto` / `nvidia` / `amd` / `intel` / `libx264`                  |
| `watermark`          | `true`         | `true`           | 布尔值，是否显示水印                                                                   |
| `watermarkText`      | `""`           | `""`             | 自定义水印，最多两行，追加在自带两行下方；`\n` 换行                                    |
| `exportMode`         | `fast`         | `fast`           | 枚举 `fast` / `record`；`fast` 为默认与唯一实现，`record` 已废弃（告警并回落 `fast`）  |
| `exportBitrate`      | `12000000`     | `12000000`       | bps；正数，仅 `fast` 的 WebCodecs 视频编码使用                                         |
| `exportFastEncoder`  | `auto`         | `auto`           | 枚举 `auto` / `webcodecs` / `frames`                                                   |
| `fastFps`            | `30`           | `30`             | 帧/秒；`fast` 有效编码帧率为 `max(1, min(fastFps, fps))`，建议 `1 ≤ fastFps ≤ fps`     |
| `recordTargetSizeMb` | `0`            | `0`              | **[已废弃]** 仅兼容保留；`> 0` 时启动打印告警并忽略，请改用 `exportBitrate` 或 `crf`   |
| `ttsMode`            | `concurrent`   | `concurrent`     | 枚举 `concurrent` / `serial`；`concurrent`（默认）边渲染边并发合成，`serial` 先合成完  |
| `idleChainGapSec`    | `0`            | `0`              | 秒；`0` 关闭动作续演（保持末帧姿态），正数以该间隔（±25% 抖动）接同情绪族手势          |

宿主 schema 对多数数值仅检查类型，不统一检查范围；GPU 纹理、显存、浏览器编码能力决定实际可用上限。
`width` / `height` 必须是正偶数（yuv420p 4:2:0 的硬性要求），非法尺寸会在加载模型与 TTS 之前以 400 拒绝，宿主启动时也会校验。
`codec: hevc` 用 libx265（`-preset medium -crf … -x265-params log-level=error -tag:v hvc1`），硬件后端对应 `hevc_nvenc` / `hevc_qsv` / `hevc_amf`；`codec: h264` 用 libx264（`-threads 4`、`rc-lookahead=20`）或 `h264_*`。`encoder: libx264` 是旧版显式 CPU 选项，始终输出 H.264；`cpu` / `auto` 跟随 `codec`。
`crf` 对 libx264 / libx265 是 CRF，对 NVIDIA 是 CQ，对 AMD 是 QP，对 Intel 是 `global_quality`；同一个数字不代表同等画质或体积。libx264 额外带 `aq-mode=3:deblock=2,2`（暗部自适应量化加偏强去块）与 `rc-lookahead=20` 合并在同一个 `-x264-params` 里，减轻片尾淡出至黑时 yuv420 近黑渐变的块状伪影，不改变 CRF 数值。WebCodecs 直编在成片最后约 0.6 秒把关键帧间隔收到每 4 帧一次，同一目的。
WebCodecs 直编不使用 `crf`，而是以 `exportBitrate` 控制目标码率。浏览器硬件编码器通常把画布按 full-range 编码（`yuvj420p`、`iec61966-2-1` TRC），因此 `WebCodecsMp4Encoder` 会记录解码器实际上报的 `colorSpace`；只要不是 BT.709 limited range，收尾就不再 `-c:v copy`，而是让宿主 ffmpeg 走与其它路径相同的 `scale=out_color_matrix=bt709:out_range=tv` 滤镜链重编码并写入四个色彩标记，确保像素与元数据同时为 tv/bt709。只有上报已合规的编码器才直接 remux。
所有 ffmpeg 出帧路径（恒等尺寸、缩放、帧序列、image2pipe 与 GPU rawvideo）都显式挂 `scale=…:out_color_matrix=bt709:out_range=tv`（无缩放 `flags=bicubic`，有缩放 `flags=lanczos`）、`setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709`，并追加 `-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv` 四个输出标记。恒等尺寸也不省略 `-vf`：这条 scale 滤镜同时负责矩阵转换与有限范围。

阶段 B 六色块探针见 `scripts/export/color-blocks.test.mjs`：构造一个与 WebCodecs 中间流同类的 full-range H.264（`yuvj420p/pc`、BT.709 矩阵），经正式收尾的 BT.709/tv 重编码后解码，在色块中心采样 Y/U/V，并与参考 `crates/sse-render/src/yuv.rs` 的有限范围常量按 `±1` 比较（参考 `crates/sse-export/src/lib.rs` 的 `ffmpeg_encodes_bt709_limited_range` 容差）。MSST 实测红 `[62,102,240]`、绿 `[172,42,26]`、蓝 `[31,240,117]`、白 `[235,128,128]`、黑 `[16,128,128]`、灰 `[126,128,128]`；参考 ignored 集成测试在本机以同一 ffmpeg 执行通过（`1 passed`），软件 H.264 参考像素为红 `[63,102,240]`、绿 `[173,42,26]`、蓝 `[32,240,118]`、白/黑/灰与 MSST 相同，逐项差值 ≤1。CPU H.264 与本机生产配置 `auto`/HEVC（`hevc_qsv`）结果一致。完整参考 `export` 仍因本机缺少 `Live2DCubismCore.dll` 无法产出成片，但六色块测试只经过参考的 YUV 转换与 ffmpeg 收尾，不依赖 Cubism，因此该阶段已有参考像素对照。

常用环境变量映射如下；没有列出的字段不要自行推测 `MSS_*` 名称。

| 字段                               | 环境变量                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `width` / `height` / `fps` / `crf` | `MSS_VIDEO_WIDTH` / `MSS_VIDEO_HEIGHT` / `MSS_VIDEO_FPS` / `MSS_VIDEO_CRF` |
| `codec`                            | `MSS_VIDEO_CODEC`（`hevc` / `h264`）                                       |
| `encoder`                          | `MSS_FFMPEG_ENCODER`，不是 ffmpeg codec 名 `nvenc`                         |
| `exportMode` / `exportBitrate`     | `MSS_EXPORT_MODE` / `MSS_EXPORT_BITRATE`                                   |
| `exportFastEncoder` / `fastFps`    | `MSS_EXPORT_FAST_ENCODER` / `MSS_FAST_FPS`                                 |
| `recordTargetSizeMb`               | `MSS_RECORD_TARGET_SIZE_MB`（已废弃，设置大于 0 时仅打印告警并忽略）       |
| `ttsMode`                          | `MSS_TTS_MODE`（`concurrent` 默认 / `serial`）                             |
| `watermark` / `watermarkText`      | `MSS_VIDEO_WATERMARK` / `MSS_VIDEO_WATERMARK_TEXT`                         |
| `idleChainGapSec`                  | `MSS_IDLE_CHAIN_GAP_SEC`                                                   |

`renderScale`、`audioBitrate` 当前没有对应环境变量读取分支，应修改 YAML。
整数类环境变量用 `parseInt` 解析，`MSS_EXPORT_BITRATE` 必须为正，`MSS_FAST_FPS` 至少为 `1`；不要填带单位的 `12Mbps`。

## 导出日志

每次成功导出都会在视频同目录生成三个文件，响应里同时返回 `logPath`（可读文本）、`logJsonPath`（完整 JSON）与 `reportPath`（报告）：

- `<video>.log`：逐句 `planned/actual/drift`、动作 cue、60 fps 逐帧计划、动作 request/loaded/started/interrupted 与 fade、TTS 日文标记与时长、异常列表、各模块日志。
- `<video>.log.json`：同一份数据的结构化版本，`schemaVersion: 1`，便于脚本统计；`plan` 节给出每句 `startFrame/endFrame`、Talk 的 typing/voice/gate 帧、布局 fade/move 帧。
- `<video>.report.txt`：成片时长、逐帧计划总量、近似/未支持项与异常清单，适合随片交付。

日志与时序约定：

- `bakeStoryPlan` 仅在 `motion` 或 `facial` 非空时生成动作 cue，不再产出空 `{ at: 0, motion: "", facial: "" }` 幽灵 cue，且正确保留 `modelId: 0`。
- 动作播放不足 400ms 就被打断会记录异常（入场动作被第一句台词接管除外）；Wave 4 起，独立静默反应 `Motion` 优先由不紧接下一句说话的在场角色执行，避免 `<400ms` 抢断。
- TTS 关闭时不会报 Irodori 文案/时长异常；`wait: false` 的片段在 `plan` 里 `blocking: false`，时间线时长为 0，导出收尾统一等待其后台动画（Talk 仍按阻塞处理）。
- `BlackOut` / `BlackIn` / `Wipe` / `SideFade` 等显式毫秒时长按原值执行，不会被 500ms 下限拉长。
- 排查“动作忽快忽慢”时优先看 motion trace 的 `load` / `played` / `clip` 三列：`load` 非 0 说明动作没预加载，`played` 远小于 `clip` 说明切换过于频繁。

## 参数在哪条路径生效

| 参数或阶段                        | `fast` / WebCodecs                              | `fast` / `image2pipe` 与帧序列           |
| --------------------------------- | ----------------------------------------------- | ---------------------------------------- |
| `width` / `height`、`renderScale` | 生效（不等输出尺寸时 OffscreenCanvas GPU 缩放） | 生效（宿主 ffmpeg 等比缩放 + pad）       |
| `fps` / `fastFps`                 | 有效编码帧率 `max(1, min(fastFps, fps))`        | 有效编码帧率 `max(1, min(fastFps, fps))` |
| `crf`                             | 不使用                                          | 宿主 ffmpeg 质量编码                     |
| `encoder`                         | 不控制浏览器编码器；合轨仍需 ffmpeg             | 选择宿主 ffmpeg 视频编码器               |
| `exportBitrate`                   | 浏览器编码目标码率                              | 不使用，不能用它调 frames 视频码率       |
| `audioBitrate`                    | 合轨时 AAC 编码                                 | 合轨时 AAC 编码                          |

## 并发 TTS 预热与虚拟时钟

### 并发 TTS 与口型预解码

- **`ttsMode: concurrent`（默认）**：`VideoExportManager` 在启动帧泵之前即开启 `ConcurrentExportPipeline`（默认 `maxConcurrentTts = 3`、`ttsLookahead = 3`、`ttsTimeoutMs = max(30000, tts.timeoutMs)`），与 WebCodecs 硬件探测以及 `BgmPlan` / `SePlan` / 全局 BGM 加载（并发度 4）并行执行。
- **异步口型预热与 PCM 复用**：每条 `Talk` 合成完成时立即触发 `onTtsReady`，并配合 `prewarmReadyLipSync` 提前 3 句通过 `OfflineAudioContext(1, 1, 48000)` 解码音频包络写入 `lipSyncCache`，同时把 48kHz 声道数据缓存在 `pcmCache`；收尾混音时 `AudioMuxer.mixToInt16Interleaved` + `encodeWavFromInt16` 直接复用已解码 PCM，消除重复解码与多余等待。
- **`ttsMode: serial`**：先调用 `waitForTTSPipeline()` 完成全部语音合成与口型预解码后再开启渲染帧泵，适合共享单槽位 GPU TTS（如低显存单卡同时跑 Irodori 与高并发 WebGL）以避免争抢算力。

### 虚拟时钟、固定 1/60 故事步与热池复用

- **固定 1/60 故事步**：正确配置字段是 **`video.fastFps`**（默认 `30`），不是 `exportFastFps`。`VirtualClockController` 安装后会把 `Ticker.shared.autoStart` 置为 `false` 并 `stop()`，导出期间 rAF 不再驱动模型；帧泵每个故事步显式调用一次 `Ticker.shared.update(该步虚拟时刻)`，保证 `elapsedMS` 恒为 `1000/60`、`deltaTime` 恒为 1。30fps 每输出帧 2 步、60fps 1 步、25fps 按 `2,2,3,2,3` 循环（`floor((k+1)×60/fps) − floor(k×60/fps)`，不使用 `ceil`）。
- **帧对齐**：输出帧 n 对应故事时间 `n/fps`（帧 0 在任何故事步之前渲染）；30fps 即故事帧 `2n`。24/25fps 的余量按连续量在相邻两个 1/60 故事步之间插值（Live2D 参数与模型容器的位置/缩放/透明度），阶梯量保持前一帧；30/60fps 余量为 0，不执行任何插值。
- **单一时钟**：`AnimationManager` 不再为导出启动独立的 17ms `setTimeout` 步进；补间与动作等待全部注册到帧泵的故事步（测试替身可用 `testExportStepIntervalMs` 复现旧节奏）。
- **收尾并行与流式音频**：片段全部落定后、帧泵还在追尾帧时就开始混音；WAV 先写 44 字节头，再按块追加 Int16 PCM 到临时文件，不再额外分配整段 Int16 + WAV（30 分钟片峰值额外内存约为全片 16bit 立体声的 2 倍）。
- **热池页面跳检与时钟基线重置**：
  - 常驻 `RenderPool` 页面首次通过 WebGL 与非黑屏校验后记入 `VideoExportManager.warmValidatedApps`，后续复用且 WebGL 上下文健康时直接跳过重复的 `readPixels` / 着色器校验；5 帧 WebCodecs 探测结果也按 `App` 实例缓存在 `webCodecsProbeCache`。
  - 虚拟时钟安装会将页面 `performance.now()` 重置到新起点，导致相邻导出间时钟向后跳变。Wave 4 通过 `resetStageTiming` / `resetClockBaselines` 与 `AdvancedModel.resetAllClockBaselines` 统一重置舞台计时、`lastNaturalUpdateMs`、`currentBodyStartedAt`、眨眼与各通道队列时间戳，并在 `AnimationManager` 与 `TalkSnippet` 中防御时钟回退。
  - 常驻 `RenderPool` 页面首次通过 WebGL 与非黑屏校验后记入 `VideoExportManager.warmValidatedApps`，后续复用且 WebGL 上下文健康时直接跳过重复的 `readPixels` / 着色器校验；5 帧 WebCodecs 探测结果也按 `App` 实例缓存在 `webCodecsProbeCache`。
  - 虚拟时钟安装会将页面 `performance.now()` 重置到新起点，导致相邻导出间时钟向后跳变。Wave 4 通过 `resetStageTiming` / `resetClockBaselines` 与 `AdvancedModel.resetAllClockBaselines` 统一重置舞台计时、`lastNaturalUpdateMs`、`currentBodyStartedAt`、眨眼与各通道队列时间戳，并在 `AnimationManager` 与 `TalkSnippet` 中防御时钟回退。
- **Live2D 动作保持与面部参数隔离**：
  - `AdvancedModel.installHoldLastFrameHook` 保持非循环身体与 v2 `face_*` 表情末帧定格至下一条 cue 交叉淡化，不会在 1–2 秒后过早淡出或回弹默认表情，同时在播完时立即向门控与 trace 报告 `isFinished() === true`。
  - `installMotionLoopHook` 正确传播 `_motionData.loop === true`（非 `oneShotWaitDepth` 等待期间关闭 `loopFadeIn`）。
  - `installBodyParameterIsolation` 统一覆写并隔离 `ParamEyeball*` / `ParamEyeBall*`（含 Cubism2 `PARAM_EYE_BALL_*` / `PARAM_EYEBALL_*`）、眉眼嘴微笑、呼吸及通道 1 活跃表情曲线；只要眼睑参数被隔离，即使播放循环身体动作也继续保持 `wakeBlink` 自动眨眼。

### 渲染倍率与清晰度

场景逻辑坐标固定为 1280×720；后备画布倍率是 `renderScale × width / 1280`。
在 1920×1080 输出下，`renderScale: 0.75` 约先渲染 1440×810，随后放大；`1.5` 约渲染 2880×1620 后缩小。
超采样增加像素数（1.5 倍边长约为 2.25 倍像素），但会提高每帧 WebGL 与读回开销；降低倍率会软化文字和轮廓。建议先以 `1` 确认稳定，再按需求微调。

## 硬件渲染与硬件编码

WebGL 负责画模型，视频编码负责压缩帧，二者是独立路径：有硬件 WebGL 不等于 ffmpeg 或 WebCodecs 已用硬件编码。
查看 worker 的 `WebGL renderer` 日志；`SwiftShader`、`software`、`llvmpipe` 通常提示软件渲染。
ffmpeg 选择值按 `video.codec` 映射：`nvidia → hevc_nvenc/h264_nvenc`、`amd → hevc_amf/h264_amf`、`intel → hevc_qsv/h264_qsv`、`cpu → libx265/libx264`、`libx264 → libx264`（旧版显式 CPU 选项）。
WebCodecs 自行探测浏览器能力，不受 `video.encoder: nvidia` 强制控制；`prefer-hardware` 需同时通过能力探测与 5 帧测速。
健康检查的 `host.ffmpegEncoderDetected` 来自宿主启动时执行的真实冒烟试编码缓存，并非仅凭 `ffmpeg -encoders` 列表判断。
冒烟探测真编 **3 帧** 256×256，参数由与正式导出相同的滤镜/标记/pix_fmt 派生函数生成，结果按 `(binary, codec, 后端, 尺寸)` 缓存；导出请求会与故事预检并行预热该缓存，正式编码直接命中，不会在收尾时再等一次探测。

### 输出文件的原子写与时长截断

- 宿主 ffmpeg 只写 `<name>.partial.mp4`，进程成功退出后才 `rename` 到目标名；失败或取消会删除 partial、临时帧目录与中间 MP4，输出目录里不会留下半截成片。中途杀掉 ffmpeg 时最多只剩可删除的 `.partial` 文件。
- 合流不再使用 `-shortest`：音频按 `-t frames/fps`（六位小数）精确截断，与视频帧数严格一致。`image2pipe` 会话会把实际写入的帧数与编码帧率交给宿主 remux；两者都拿不到时退回 WAV 头里的 data 块时长。音频默认 AAC 192k。
- 断点续传/片段的音频起点按首个视频帧的样本位置对齐（对音频输入加 `-ss frame/fps`），避免片头音画错位与长片累积漂移。

## 路径选择与回退顺序

1. **`exportFastEncoder: frames`**：跳过 WebCodecs，直接使用 `JpegFrameSink`（优先 `image2pipe`，不可用时落回磁盘 JPEG 批处理）。
2. **`exportFastEncoder: auto`（默认）或 `webcodecs`**：调用 `WebCodecsMp4Encoder.probeConfig`：
   - `auto` 模式拒绝 `SwiftShader` / `llvmpipe` / `softpipe` 软件 WebGL、`gpuRenderer === 'cpu'`，以及 Linux（非 Android）+ NVIDIA / 无 GPU 环境；
   - 按 `avc1.640028` → `avc1.4d4028` → `avc1.42e028` → `avc1.42001f` 探测 H.264 配置，`auto` 下严格要求 `hardwareAcceleration === 'prefer-hardware'`（`webcodecs` 模式会回退尝试 `no-preference`）；
   - `auto` 下对候选配置执行 **5 帧合成画布真实编码测速**，超过 **150ms** 视为软件慢编并自动回落 `JpegFrameSink`（`image2pipe`）。
3. **运行时初始化回退**：`auto` 模式下即便探测通过、若 `WebCodecsMp4Encoder.initialize()` 失败仍会无缝回落 `JpegFrameSink`；`webcodecs` 显式模式初始化失败则会直接报错终止。
4. **`JpegFrameSink` 管道与编码回退**：
   - 优先调用 `electron:frames-stream-start` 启动宿主 `FramesPipeSession`（`image2pipe` MJPEG stdin 直通 ffmpeg，无磁盘帧文件）；该通道选用 `video.encoder`（`auto` 按真实冒烟结果选用 NVIDIA/AMD/Intel/CPU），若运行时 GPU 编码失败会自动 `invalidateGpuEncoder()` 并在后续导出避开故障编码器。
   - `FramesPipeSession` 也接受 `frameFormat: rawvideo`：渲染端离屏 WebGL2 全屏 pass 完成缩放与 BT.709 定点转换后，按 yuv420p 原始帧入管道（每帧 `1.5 × W × H` 字节），ffmpeg 只做标记与编码，不再解码 JPEG；当前默认仍是 MJPEG `image2pipe`。
   - 若 `image2pipe` 不可用，惰性调用 `electron:get-temp-dir` 落盘 JPEG 批次并走 `electron:api-encode-frames-video`（`encodeFramesToVideo` 在 GPU 编码报错时按 `codec` 立即重试软件编码 `libx265` / `libx264`）。

## 调参案例

以下两段均是 **`config.yaml` 的 `video` 片段**，不是完整配置文件；选择一段合并进现有 `video`，不要连续粘贴多个同名键。

### 1080p 推荐基线（默认高吞吐）

```yaml
video:
  exportMode: fast
  width: 1920
  height: 1080
  fps: 60
  fastFps: 30
  renderScale: 1
  exportFastEncoder: auto
  exportBitrate: 12000000
  crf: 28
  encoder: auto
  ttsMode: concurrent
```

`fastFps: 30` 与 `renderScale: 1` 可大幅降低画布读回和编码像素压力；需要更低带宽体积时，WebCodecs 路径调低 `exportBitrate`（如 `8000000`），`image2pipe`/frames 路径调高 `crf`（如 `28`）或改为 `23` 提升清晰度。

### 720p 轻量与单卡串行 TTS 模式

```yaml
video:
  exportMode: fast
  width: 1280
  height: 720
  fps: 30
  fastFps: 30
  renderScale: 1
  exportFastEncoder: auto
  crf: 23
  encoder: auto
  ttsMode: serial
```

适合显存紧张、或者与单 GPU 单槽位本地 TTS（如 IrodoriTTS）共卡部署避免推理与 WebGL/编码同时争抢资源的服务器。

## 如何读耗时与统计

API 返回的 `duration` 单位是 **秒**，表示成片视频本身的长度（`frameCount / fps`），不含音频尾音或容器封装；
渲染墙钟耗时不再冒充 `duration`，而是放在 `timings.wallMs`。端到端耗时应由调用方另行计时。
`timings` 大部分是毫秒，但 `frames` 是帧数、`avgPumpFps` 是吞吐率：

| 指标                    | 当前含义                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `pumpMs`                | 各次帧泵迭代的墙钟耗时累计，含 tick、render、抓帧及校验等，不含暂停等待 TTS 时间                    |
| `tickMs` / `renderMs`   | 帧泵内推进虚拟时钟与 PixiJS 绘制的墙钟分项                                                          |
| `snapshotMs`            | 抓帧 / 提交 WebCodecs 编码或 JPEG 队列（可含背压等待）的耗时                                        |
| `ttsWaitMs`             | 片段执行显式等待 TTS 就绪与口型解码的墙钟耗时，非后台全部 TTS 耗时之和                              |
| `encodeMs`              | 页内编码器 flush/finalize 或 JPEG 管道队列排空时间；不含宿主 ffmpeg 进程后处理                      |
| `audioMs`               | 混音与流式 WAV 写盘在帧泵结束后的剩余等待（混音已与追尾帧并行）                                     |
| `invokeMs`              | 宿主收尾调用耗时（WebCodecs / `image2pipe` 为 remux 或 BT.709 重编码；磁盘帧批为 ffmpeg 编码+合轨） |
| `frames` / `avgPumpFps` | 实际帧泵输出帧数，以及 `frames / (pumpMs / 1000)`；不是输出播放 fps                                 |
| `videoDurationMs`       | 成片视频时长 `frames / fps × 1000`，与 API `duration` 一致                                          |
| `wallMs`                | 页内导出墙钟耗时，仅用于性能排查                                                                    |

分项存在包含关系和并发重叠，不能把全部 `timings` 相加当作总耗时。
`frameCount` 由时间轴与帧泵统计得出；需要真实成片时长、平均帧率和文件大小时，请检查最终 MP4 元数据。

### 性能实测（同机、同一 demo 短片）

测量条件：1920x1080@30fps、`fastFps: 30`、4 workers、Intel Iris Xe、WebCodecs H.264、475 帧、同一 `story.json`。
前后各取连续两次稳定值：

| 指标              | 改前（rAF 步进）   | 改后（固定 1/60 步）       | 变化     |
| ----------------- | ------------------ | -------------------------- | -------- |
| 墙钟              | 20.9s              | 17.1s                      | -18%     |
| API `duration`    | 16.58s（旧：墙钟） | 15.83s（475/30，视频时长） | 语义修正 |
| `pumpMs`          | 15020ms            | 11188ms                    | -25.5%   |
| `tickMs`          | 13746ms            | 9557ms                     | -30%     |
| `avgPumpFps`      | 31.6               | 42.5                       | +34.5%   |
| `audioMs`（收尾） | 262ms              | 105ms                      | -60%     |
| 文件大小          | 11.33MB            | 11.23MB                    | 基本不变 |

长片对比前先核对同一日志里的 5 帧 WebCodecs 探测耗时：它只反映当前 GPU 状态，不受剧本内容影响。若探测耗时明显高于上一轮（例如 106ms vs 83ms），`renderMs` / `snapshotMs` 会随 GPU 负载或频率一起上升，不能直接归因于导出代码回退；应在探测耗时接近时再比较 `pumpMs` 与 `avgPumpFps`。实际复测中探测 83.2ms 时，官方 337.6s 片的 `wallMs` 为 368.6s、`renderMs` 38.0s、`snapshotMs` 4.55s，均优于探测 106.1ms 的那次 412.1s / 66.0s / 9.2s。

诊断报告现在包含 `encoder`（如 `webcodecs-h264+ffmpeg`）、`segments`、`convert`（`browser` / `ffmpeg`）与 `color`（`bt709/tv`）；`convert: ffmpeg` 表示收尾经过 BT.709/tv 重编码，`browser` 仅在 WebCodecs 源流本身已合规时出现。`.log.json`、`.log`、`.report.txt` 三个文件异步并行写盘，不再同步阻塞宿主主线程。

## 旧配置迁移

- `video.exportMode: "record"` 与 `video.recordTargetSizeMb`（含 `MSS_RECORD_TARGET_SIZE_MB`）：均已**废弃**。原有 `config.yaml` 若仍保留这两个键可继续启动，但宿主会打印 deprecation warning 并将 `exportMode` 路由到 `fast`、忽略 `recordTargetSizeMb`。请改为配置 `exportMode: fast` 与 `exportBitrate` / `crf`。
- 更早期的 `video.recordBitrate`、`recordStreamCopy`、`recordBitrateOvershoot`、`recordKeyframeIntervalSec`、`recordCaptureFps` 及对应 `MSS_RECORD_*` 环境变量已无读取入口；若旧配置写了 `exportFastFps`，请改为 `fastFps`。
- `video.ttsMode` 默认已从 `serial` 切换为 **`concurrent`**；若共享单卡且遇到 TTS 争抢，请显式写 `ttsMode: serial`（或 `MSS_TTS_MODE=serial`）。

源码依据：`src/host/config.ts`、`src/shared/ffmpeg.ts`、`src/host/exportDiagnostics.ts`、`src/renderer/src/app/App.ts`、`src/renderer/src/managers/{VideoExportManager,AnimationManager}.ts`、`src/renderer/src/managers/video-export/{ConcurrentExportPipeline,WebCodecsMp4Encoder,JpegFrameSink,VirtualClockController,FrameInterpolator,AudioMuxer}.ts`。
