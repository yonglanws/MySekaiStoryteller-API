# 按 SekaiStoryExporter 对齐的高保真重构计划

> 上下文被压缩后先读这份文件，再读 `scripts/renderer/sekai-exporter-parity.test.mjs` 顶部的
> “PLAN SNAPSHOT”。本计划不是“再做一个播放器”，而是把
> `https://github.com/StarMoe-org/SekaiStoryExporter` 已经核对过的官方演出语义，落到本项目的
> TypeScript/Pixi 渲染管线里。参考 checkout 在仓库外：`/tmp/sekai-story-exporter`。

## 1. 参考实现的关键结论

SekaiStoryExporter（下称 SSE）是 Rust + wgpu 的原生导出器，核心不是某个 UI，而是三层语义：

1. **确定性两阶段管线**：Pass 1 按 60 fps 逐帧模拟 Unity 协程、Live2D 动作混合、物理、眨眼、
   呼吸、口型，产出 `ParamTable`；Pass 2 只读参数表渲染。任意帧可单独渲染，导出可分段并行。
2. **时序唯一来源是帧号**：`sse-core/consts.rs` 记录官方常量，`sse-timeline` 逐帧重放
   `ScenarioPlayer` 的自动播放、布局、动作完成回调。所有时长先换算成 60 fps 帧，
   不做“按毫秒估算”。
3. **行为报告**：导出结束生成 `*.report.txt`，列出近似与未支持项；L0 单测锁住常量、
   帧换算、动作混合与口型曲线。

与剧情浏览器（Moesekai）不同，SSE 真正处理 Live2D、布局、转场、音频和逐帧渲染，因此这次
以 SSE 的常量与状态机为准；Moesekai 只保留“文本/语音阅读器”的参考价值。

## 2. 本项目当前的主要偏差

逐项对照 `crates/sse-core/src/consts.rs`、`crates/sse-timeline/src/lib.rs`、
`crates/sse-bake/src/{lib,character,lipsync}.rs`、`crates/sse-live2d/src/{runtime,motion,blink}.rs`
后确认：

| 项目         | 官方/SSE                                                                           | 本项目当前                                               | 影响                     |
| ------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------ | ---------------------------------------------- | ---------- |
| 打字速度     | `word_interval=0.06s`，每半字 `ceil(0.03×60)=2` 帧，合计 **4 帧/字 = 66.67ms**     | `TALK_DISPLAY_MS_PER_CHAR=80`                            | 每句慢 20%               |
| 语音后停留   | 语音结束 + `0.05s` 延迟，再过 **0.5s** 自动翻页                                    | 固定 `+600ms`                                            | 句间节奏偏慢/不一致      |
| 无语音台词   | 打字结束 + **2.0s**                                                                | 固定 `+600ms`，且有 1800ms 下限                          | 无声段落过快             |
| 动作收尾闸门 | 自动模式要等布局结束、所有身体动作播完，再等 0.5s                                  | 完全不等                                                 | 长动作被下一句硬切       |
| 对话框打开   | `PlayActive(1,0.2)`，打字等 0.2s                                                   | 70ms                                                     | 首次台词提前             |
| 入场淡入     | `FadeOpacity(1, 0.1)`，先 1 帧 alpha=0                                             | `show(200)`                                              | 入场慢一倍               |
| 已在场再入场 | `CharacterMoveToCoroutine(side, 0.2)`，不淡入                                      | 统一 show+move                                           | 语义不符                 |
| 入场完成     | 淡入结束（约 7 帧）即完成，滑入继续                                                | 等 show + 完整 move                                      | 每场多等 0.5~0.75s       |
| 退场         | 原地 `delay 0.15 + fade 0.1`；滑动 `delay=move-0.1 + fade 0.1`                     | 原地 300ms；滑动 `max(400, move)` 同时淡出               | 退场时序不符             |
| 移动速度     | Slow 0.75s / Normal 0.5s / Fast 0.33s                                              | 700/500/300ms                                            | 固定偏差                 |
| 站位         | 普通 `±350/1920`，三人 `±550/1920`，三人缩放 0.9                                   | 0.3/0.7，0.25/0.75                                       | 三人模式偏内             |
| 身体动作混合 | 0.5s 交叉淡化；同类别/链接动作 0.125s                                              | 依赖默认 0.5s，但每次先 `stopAllMotions()`，旧姿势被丢弃 | 动作切换跳变、节奏感不稳 |
| 表情混合     | 0.25s；Force 时 0                                                                  | 默认 0.5s                                                | 表情变慢                 |
| 眨眼         | 均值 3s、±2s、速度 10；动作播放时 Sleep，非循环动作结束 Wake；                     | sin                                                      | 曲线 20 帧               | 固定 4~6.5s，闭眼 200ms/睁眼 250ms，动作中仍眨 | 待机不自然 |
| 呼吸         | 3s 周期、影响 0.5、ParamBreath                                                     | 无                                                       | 待机僵硬                 |
| 口型         | 每帧 RMS → `a×scale`、`a×pow(a+1,1.75)`、阈值 0.06、限幅 0.2~1、按当前值加权的平滑 | 自定义 90ms 平滑包络                                     | 口型与官方不同           |
| 导出可观测性 | `report.txt` + 逐帧参数表                                                          | `.log`/`.log.json` + 动作追踪                            | 缺少帧级计划和近似清单   |

## 3. 实施范围

### Phase A：官方时序常量单一来源

- [x] 新增 `src/common/official/timing.ts`：
  - 60 fps 帧基、`framesForSeconds`（Unity `while(elapsed<d)` 等价于 ceil）、
    `framesToMs`、`msToFrames`、`quantizeMsToFrame`。
  - 台词：WORD_INTERVAL、AUTO_NEXT_PAGE_DELAY、AUTO_WAIT_AFTER_VOICE、
    AUTO_VOICE_TIMEOUT、VOICE_END_LATENCY、TALK_WINDOW_OPEN_CLOSE。
  - 布局：MOVE_DURATION_NORMAL/FAST/SLOW、APPEAR_SHOWN_MOVE、HIDE_DELAY_IN_PLACE、
    HIDE_SLIDE_FADE_OFFSET、CHARACTER_FADE、SIDE_X_DEFAULT/THREE。
  - Live2D：BODY*MOTION_FADE、FACIAL_FADE、SAME_CATEGORY_BLEND、EYEBLINK*\_、
    BREATH\_\_、LIP_LEVELS、LIP_POW_K、LIP_TARGET_SCALE。
- [x] 所有新代码只从该模块取常量；旧常量保留导出名作为兼容别名，避免一次性大改。

### Phase B：Talk 自动播放节奏

- [x] `TalkTiming.ts` 用帧计算：
  - 每个半字 2 帧，每字 4 帧；`typingMs = length × 4 × 16.6667`。
  - 有语音：`voiceEnd = voiceMs + 50ms`；`done = max(typing, voiceEnd, motionSettle)`；
    `duration = done + 500ms`。
  - 无语音：`duration = typing + 2000ms`。
  - 删除 `MIN_TALK_DURATION_MS=1800` 与固定 `+600ms`。
  - `motionSettleMs` 可选：Talk 内所有身体动作 cue 的 `at×duration + clipDuration` 最大值。
- [x] 对话框状态跟踪：`calculateTimeline` 维护 `windowOpen`；首句/`HideTalk` 后第一句
      的 200ms 打开动画只推迟打字，不推迟语音；语音足够长时总时长不变。连续 Talk 不重复加；
      `HideTalk` 改为立即隐藏（0/1ms）。
- [x] `UIText` 打字机：首字立即显示，`ceil(progress×len)`，速度 4 帧/字。
- [x] `UILayer.showTextBackground` 改为 200ms；`hideTextBackground` 立即隐藏。
- [x] `VideoExportManager` 在 TTS 导出时为每句 Talk 传入 `motionSettleMs`（从预加载的
      动作剪辑时长计算），用 `applyTalkPatch` 修正时间线。
- [x] 所有片段时长按 60 fps 帧量化，计划/实际用同一帧基。

### Phase C：Layout 转场

- [x] `StageUtils.move_speed_to_num` 改为 750/500/333.333/0。
- [x] `StageUtils.side_to_position` 改为 `0.5 ± 350/1920`，三人 `0.5 ± 550/1920`；
      offset 仍按 `/1920`。
- [x] `LayoutAppearSnippet`：
  - 先启动入场动作（alpha=0）。
  - 未显示：`show(100ms)`；已在场：`move(200ms)` 不淡入。
  - 移动与淡入/滑入并发，**只等转场**，不等完整 move；`startBodyIdleLoop` 在转场后。
  - `from != to` 时先落到 from，再移动；否则直接落到 to。
- [x] `LayoutClearSnippet`：
  - 先启动退场动作，放到 from。
  - 原地：等待 150ms，再 `hide(100ms)`；总 250ms。
  - 滑动：移动和淡出并发，淡出延迟 `max(0, moveMs-100)`，`hide(100ms)`；总 moveMs。
  - 完成后才移出渲染层。
- [x] `MoveSnippet`：同位置也等待 move 时长（官方 layout 片段按 duration 完成）；
      Immediate 为 0。
- [x] `TimelineCalculator` 的 Appear/Clear/Move 时长改为上述帧值；Appear 固定 116.667ms
      （1 帧 alpha=0 + 6 帧淡入），已在场 200ms 作为可选分支。

### Phase D：Live2D 动作混合与自然动作

- [x] `AdvancedModel` 安装动作队列“交叉淡化”覆盖：
  - 不再在每次 cue 前 `stopAllMotions()`；新 clip 与旧 clip 按混合时间交叉。
  - 身体：同类别或链接动作 125ms，否则 500ms；首个动作 0。
  - 表情：250ms；`facialForce` 时 0。
  - 覆盖 `ParallelMotionManager._startMotion`，跳过它内部的 `queueManager.stopAllMotions()`，
    用 `queueManager.startMotion` 让旧 entry 淡出。
- [x] 类别/链接动作判定按 SSE 正则：`[a-z]-[alnum]+-[alnum]+`，链接 `RULE_to_RULE`。
- [x] 眨眼控制器：
  - 状态机 Sleep/Ready/Closing/Opening；`|sin|`，速度 10；间隔 3±2s；确定性种子。
  - 身体动作开始 `Sleep`；非循环动作结束 `Wake`；`beforeModelUpdate` 写眼参数。
  - 关闭 `internalModel.eyeBlink` 自带眨眼，避免双重驱动。
- [x] 呼吸：`ParamBreath = (sin(degree×DEG2RAD)×0.5+0.5)×0.5`，
      `degree += dt×60×2°/frame`，3s 周期；仅模型可见时推进。
- [x] 口型：
  - `buildLipSyncEnvelope` 改为 60 fps 窗 RMS + 官方 `pow`/阈值/限幅/平滑。
  - 无 TTS 时用 `LIP_LEVELS` 文本口型兜底（半字推进，闭眼/结束归零）。
  - 保留现有 `sampleLipSync` API 和监听器清理语义。

### Phase E：Pass 1 故事帧计划与报告

- [x] 新增 `src/common/export/storyPlan.ts`：
  - 输入 snippets + timeline + tts 时长 + motion settle，输出每句 `startFrame/endFrame`、
    Talk 的 `typingStart/typingEnd/voiceEnd/gateEnd`、动作 cue 帧、布局 fade/move 帧。
  - 作为“我们版本的两阶段管线”的可观测层：Pass 2 仍是 Pixi，但计划与渲染共用同一帧基。
- [x] `ExportDiagnostics` 增加 `plan` 与 `approximations`；`.log.json` 可看到逐帧计划。
- [x] 宿主新增 `<video>.report.txt`：摘要、逐帧计划、近似项、异常；响应增加 `reportPath`。
- [x] `scripts/api/export-diagnostics.test.mjs` 断言 report 文件与路径。

### Phase F：测试与文档

- [x] `scripts/renderer/official-timing.test.mjs`：帧换算、打字 4 帧/字、语音+0.5s、
      无语音+2s、动作闸门、窗口 0.2s。
- [x] `scripts/renderer/layout-transition.test.mjs`：Appear 116.667/200、Clear 250/move、
      Move 750/500/333.333、站位 350/550。
- [x] `scripts/renderer/motion-blend.test.mjs`：交叉淡化、同类别 125ms、表情 250ms、
      不再 stopAll。
- [x] `scripts/renderer/natural-motion.test.mjs`：眨眼 20 帧曲线/间隔、呼吸 3s、口型平滑。
- [x] `scripts/renderer/story-plan.test.mjs`：逐帧计划与 timeline 对齐。
- [x] `scripts/api/export-report.test.mjs`：report 落盘。
- [x] 更新 `doc/ai-script.md`、`doc/export-modes.md`、`doc/story-format.md`、
      `doc/development.md`、`doc/README.md`。
- [x] 真实导出 8 句双人剧本，读 `.log.json`/`.report.txt`，抽帧验证入场与动作混合。

### Phase G：官方语料批量审计与剩余语义

- [x] `scripts/stories/official-plan-audit.mjs`：读取仓库外 328 集日服 scenario，映射成
      snippets 后逐集跑 `calculateTimeline + bakeStoryPlan`，检查 Talk 打字/窗口/gate、
      动作 cue 句首、Appear/Clear/Move 帧、精确特效时长、plan 总帧与逐条 replay。
- [x] `scripts/stories/official-plan-audit.test.mjs`：语料存在时全量跑；328 集、107405 个
      snippets、29057 条 Talk、23473 个动作 cue、0 失败。报告只写仓库外，不进 git。
- [x] 官方 scenario 映射修正：`Side` 0~12、`MoveSpeedType` 1=Fast/2=Slow、
      `CharacterLayoutMode` 3=Three、Action 8 切布局、Action 4/Type 0 用 1ms `ChangeMotion`
      cue（官方不等动作剪辑）。
- [x] `ProgressBehavior=0` 非阻塞调度：timeline 0ms、plan 不推进 cursor、导出后台执行并在
      `WaitAllFinished` 收尾；`Talk` 强制串行以保 TTS/字幕对位。
- [x] 打字机只数可见字符：`sanitizeDisplayText` 插入的 `\n` 不计 4 帧/字。
- [x] 精确时长特效不再被 500ms 下限拉长：官方 0.1s 白场 = 100ms，Wipe 0.4s = 400ms，
      CameraMove/Zoom 0ms 保持 0。
- [x] `scripts/renderer/layout-matrix.test.mjs`：Appear/Clear/Move × 四种速度 × 位移/原地。
- [x] `scripts/renderer/crossfade-params.test.mjs`：直接验证 `_startMotion` 覆盖的
      fadeIn/fadeOut、无 stopAll、ignoreParamIds 与 fallback。
- [x] `scripts/renderer/nonblocking-schedule.test.mjs`：0ms/不推进 cursor/Talk 强制阻塞/
      BackgroundSnippetTasks 等待与错误传播。
- [x] 无 TTS 真实导出：17 段双人短剧，planned 14401ms、actual 14573ms、avg drift 76ms、
      anomalies 0；BlackOut 100ms 实际 101ms、500ms 实际 504ms；视频 14.54s/405 帧。
- [x] 官方语料真实导出：`event_116_06` 的 128 段 / 40 句 / 21 次 Appear / 21 次 Clear /
      6 次 Move / Telop / SideFade，planned 166540ms、actual 167264ms、video 167.29s /
      4645 帧；TTS 关闭，文本走 LipLevels，非阻塞片段并发执行。仅 1 条异常：某句累计
      漂移突然新增 105ms；其余时间线、特效、布局全部对齐。

### Phase H：官方剩余特效类型

- [x] Telop 改为官方 `ScenarioTelopPlayer` 节奏：0.333s in + 2s AUTO 停留 + 0.333s out
      = 2666.667ms，不再按字数估算。
- [x] 新增 `SideFade` 片段与 `SpecialEffectLayer.sideFade`：EffectType 29~36 的
      Left/Right/Top/Bottom × In/Out，位置曲线与 SSE `SideFadeRt` 一致。
- [x] 新增 `BackgroundBlur`（EffectType 38/39/44）与背景层 BlurFilter。
- [x] 新增 `StopShake`（EffectType 25/26）与 `App.stopShake` 代数取消。
- [x] 转换器补齐 6/8/18/20/21/25/26/29~36/38/39/40/41/44；剩余仅 15/16（场景粒子）、
      19（电影）、22（角色 shader）无等价 Story 类型，审计按类型计数。
- [x] `scripts/renderer/official-effects.test.mjs`：映射、SideFade 几何、精确时长、
      snippet → layer 调用。
- [x] 语料审计复跑：107405 个 snippets，skippedEffects 只剩 15/16/19/22，0 失败。

### Phase I：官方在场状态语义

- [x] 时间线、逐帧计划与运行时共享在场状态：已在场角色再次 `LayoutAppear` 只执行官方
      0.2s（12 帧）`CharacterMoveTo`，不再重复 7 帧淡入；已在场 `LayoutClear` 仍按原地 /
      滑动分支，未在场 `LayoutClear` 立即完成（0ms，无 fade / move 帧）。
- [x] `storyPlan` 的 `LayoutAppear` / `LayoutClear` 用 `fadeStartFrame: null`、
      `fadeEndFrame: null` 表达“没有淡入淡出”，`moveEndFrame` 保持绝对帧。
- [x] `LayoutClearSnippet` 用 `layerModel.isModelVisible(modelId)` 判定；不在场时只
      `removeModel`，不启动退场动作、不移动、不淡出。
- [x] `scripts/renderer/layout-matrix.test.mjs`：矩阵用例补前置 Appear 建立在场状态，
      并新增“重复 Appear 12 帧无 fade”“未在场 Clear 0 帧”断言。
- [x] `scripts/renderer/layout-appear.test.mjs`：新增未在场 `LayoutClear` 只调用
      `removeModel` 的运行时回归。
- [x] 官方语料审计与 `event_116_06` 实导出改用可见性分支后复跑通过。
- [x] 导出预检只在 `tts.enabled=true` 且 provider 为 Irodori 时要求日文 `ttsText`；
      TTS 关闭时不再因缺日文阻断纯画面导出（`needsJapaneseTtsPreflight` + 回归断言）。

## 4. 验收标准

1. `calculateTalkDurationMs('12345', 1000)` 落在 1.5s（5×4 帧 = 333ms；voice end 1050ms；
   +500 = 1550ms，帧量化 1566.7ms）；无语音 5 字 = 333+2000=2333.3ms。
2. 首句 Talk 时长比连续第二句多 200ms（窗口打开），`HideTalk` 后重新多 200ms。
3. LayoutAppear 计划/实际均约 116.7ms；不再等待 0.5~0.75s 的滑入。
4. LayoutClear 原地 250ms；滑动等于 move 时长；淡出延迟符合 `move-100ms`。
5. 动作切换有 0.5s 交叉淡化（同类别 0.125s），不再先清空旧动作；日志记录 fadeMs。
6. 待机可见呼吸与眨眼；动作播放期间不眨眼，动作结束后恢复。
7. 导出日志包含逐帧计划与 `approximations`，视频同目录有 `.report.txt`。
8. `npm test`、`npm run test:renderer`、`npm run test:stories`、`npm run typecheck` 全绿。

## 5. 明确不照搬的部分

- 不把 Rust/wgpu/Cubism Native 依赖搬进本项目；Pass 2 仍是 Pixi + `pixi-live2d-display-advanced`。
- 不实现 `--jobs N` 多进程分段：当前导出是单浏览器实时录制，分段需要多页面/多进程编排，
  与本次演出语义对齐无关；在 report 中标注为近似项。
- 不实现 3D MV、完整 UGUI 图集、S3 资产库；这些属于 SSE 的资产/平台层。
- 官方 15/16（场景粒子 Play/Stop）、19（电影）、22（角色 shader）在 Story 格式里没有
  等价类型，转换器跳过并按类型计数。8/18 用 Telop，20/21/40/41 用 Wipe 近似，
  6 用 ShakeScreen，38/39/44 用 BackgroundBlur，25/26 用 StopShake，29~36 用 SideFade。
- 不改变现有双人同场、日语 TTS 预翻译、动作 at=0 等已完成的行为。

## 6. 关键文件

- `src/common/official/timing.ts`（新）：官方常量与帧换算。
- `src/common/official/sideFade.ts`（新）：EffectType 29~36 的滑入/滑出位置。
- `src/common/export/storyPlan.ts`（新）：逐帧故事计划。
- `src/renderer/src/utils/TalkTiming.ts`：自动播放节奏。
- `src/renderer/src/utils/TimelineCalculator.ts`：帧量化、布局/窗口/特效时长。
- `src/renderer/src/utils/StageUtils.ts`：站位与移动速度。
- `src/renderer/src/snippets/{LayoutAppear,LayoutClear,Move,Talk}Snippet.ts`。
- `src/renderer/src/snippets/{SideFade,BackgroundBlur,StopShake}Snippet.ts`（新）。
- `src/renderer/src/model/AdvancedModel.ts`：交叉淡化、眨眼、呼吸、口型。
- `src/renderer/src/utils/{NaturalMotion,LipSyncEnvelope}.ts`。
- `src/renderer/src/managers/{TTSManager,VideoExportManager}.ts`。
- `src/renderer/src/managers/video-export/ExportDiagnostics.ts`。
- `src/common/types/ExportDiagnostics.ts`、`src/host/exportDiagnostics.ts`。
- `scripts/renderer/sekai-exporter-parity.test.mjs`：本计划的契约测试。

## 7. 状态

- 2026-11-08：完成 SSE 源码拆解与差异清单，开始 Phase A。

- 2026-11-08：Phase A~F 全部实现并通过测试。
  - 实导出（8 句双人、1920x1080/30fps、stream、Irodori 日语 TTS）：
    planned 24535ms、actual 24586ms、avgAbsDrift 44ms、max drift 78ms、anomalies 0；
    frame plan 1474 帧 / 24567ms，成片 24.55s / 717 帧；
    2 次 LayoutAppear、2 次 LayoutClear、22 次动作开始、3 次打断；
    BlackOut 实际 506ms（修复 0.5 秒被当成 0.5ms 的问题）。
  - 首次入场加 GPU 预画后，LayoutAppear 实际 137ms/120ms（计划 116.667ms）；
    预画只画 alpha=0.01 一帧，不进入成片。
  - 日志：`apifile/export-1794128378288-xtc4eq.log` / `.log.json` / `.report.txt`。
  - 回归：`npm run test:renderer` 89 项、`npm test` 83 项、`npm run test:stories` 4 项、
    `npm run typecheck` 通过。

- 2026-11-08：Phase G 完成。
  - 官方 328 集语料审计：106001 个 snippets、29057 条 Talk、36868 个动作 cue、
    20611 次 Appear、20690 次 Clear、4481 次 Move、27425 个非阻塞片段，0 失败。
  - 无 TTS 实导出（17 段、双人、1920x1080/30fps、stream）：
    planned 14401ms、actual 14573ms、avgAbsDrift 76ms、anomalies 0；
    frame plan 865 帧；成片 14.54s / 405 帧；BlackOut 100ms 实际 101ms、
    500ms 实际 504ms；非阻塞 Appear 实际 0ms 且不推迟下一句；后台 Motion cue
    的动作追踪按片段号正确归因。
  - 日志：`apifile/export-1794132552869-nhxc4c.*`（短剧）。

- 2026-11-08：Phase H 完成。
  - 官方 328 集语料审计复跑：107405 个 snippets、27556 个非阻塞片段；
    skippedEffects 仅剩 15/16（场景粒子）、19（电影）、22（角色 shader），0 失败。
  - 官方语料实导出（`event_116_06`，128 段 / 40 句 / 1920x1080/30fps/stream）：
    planned 166540ms、actual 167264ms、avgAbsDrift 387ms、video 167.29s / 4645 帧；
    21 次 Appear、21 次 Clear、6 次 Move、2 次 Telop、2 次 SideFade；
    仅 1 条异常：某句漂移突然新增 105ms。画面使用仓库内替代模型/背景，仅用于时序验收。
  - 特效短剧实导出：19 段，planned 11037ms、actual 11177ms、avgAbsDrift 86ms、
    anomalies 0；SideFade 500ms 实际 531/508ms、Telop 2667ms 实际 2684ms、
    BackgroundBlur 与 StopShake 均生效；视频 11.15s / 309 帧。
  - 日志：`apifile/export-1794136419296-gdu34u.*`（官方语料）、
    `apifile/export-1794135763893-5t8ixr.*`（特效短剧）、
    `apifile/export-1794132552869-nhxc4c.*`（无 TTS 短剧）。
  - 回归：`npm run test:renderer` 108 项、`npm run test:all` 282 项、
    `npm run test:stories` 5 项、`npm run typecheck` 通过。

- 2026-11-08：Phase I 完成（在场状态语义）。
  - 官方 328 集语料审计复跑：107405 个 snippets、27556 个非阻塞片段、0 失败。
  - 官方语料实导出（`event_116_06`，128 段 / 40 句 / 1920x1080/30fps/stream）：
    planned 166540ms、actual 166966ms、avgAbsDrift 184ms、video 167.025s / 4665 帧 /
    21.87MB；21 次 Appear、21 次 Clear、6 次 Move、2 次 Telop、2 次 SideFade；
    1 条异常：某句漂移 300ms（较上一句新增 103ms，属累计抖动而非布局错误）。
    计划中已包含 0ms 的未在场 `LayoutClear`，未见需要 12 帧分支的重复 Appear。
  - 成片自检：ffmpeg 读取 1920x1080 / 27.93fps 平均帧率、音频 mean -31.4dB；
    83.2s 白场来自 EffectType 4，139.1~141.2s 黑场来自 SideFade、166.7s 为收尾黑场，
    抽帧确认 Telop「誰もいないセカイ」「湖」与角色入场正常。
  - 日志：`apifile/export-1794138332212-b1eykx.*`（官方语料，Phase I 版本）。
  - 回归：`npm run test:renderer` 110 项、`npm run test:all` 285 项、
    `npm run test:stories` 5 项、`npm run typecheck` 通过、Prettier 通过。

- 2026-11-08：日语预检开关的双向端到端复核（最终构建 `npm run build` 之后）。
  - 关闭 TTS（`MSS_TTS_ENABLED=0`，provider 仍为 `irodori`），3 句中文台词、`ttsText` 全空：
    导出返回 200，planned 9333ms、actual 9396ms、avgAbsDrift 36ms、anomalies 0；
    成片 9.35s / 253 帧 / 1920x1080，`ttsLines=3` 但 `ttsTotalMs=0`；
    抽帧确认中文字幕与角色入场正常，宿主日志没有任何翻译/预检记录。
    完整日志：`apifile/export-1794149038918-pyajs9.*`。
  - 同一故事把 `tts.enabled` 打开（`MSS_LLM_ENABLED=0`）：导出返回 400，
    报 `IrodoriTTS 需要日文 ttsText，但以下 Talk 仍未翻译：snippets[3], snippets[4], snippets[5]`。
    说明预检门槛只是跟随 `tts.enabled`，Irodori 开启时仍会拦截缺日文的剧本。
