# 按 SekaiStoryExporter 对齐的高保真重构计划

> [!NOTE]
> **历史重构记录（已完成并合入当前管线）**：本文件记录 60fps 帧基常量、Talk 自动播放节奏、布局淡化、眨眼/呼吸/口型曲线与逐帧报告的早期对齐计划，相关能力已落地至 `src/common/official/` 与 `src/renderer/`。
> 现行使用与配置请查阅 [故事文件格式](story-format.md) 与 [导出模式](export-modes.md)。

## 2026-11 入场、出场、走位、动作调度与演出效果对齐

本轮按 `sse-core/src/time.rs`、`sse-timeline/src/lib.rs`、`sse-bake/src/{lib,shake}.rs`
继续对齐舞台层。已落地：

- `framesForSeconds` 改为 Unity 的 f32 逐帧累加：0.06→4、0.1→6、0.125→8、0.5→30、
  0.75→46、1.0→61、2.0→121、30.0→1801；0/−1/NaN→0，Infinity 饱和到 u32 上限。
  `quantizeMsToFrame` 不再对已是整帧的毫秒（如 116.667ms）二次换算。
- `talkAuto.ts`：TalkWindow 自动推进按参考移植。无语音 / 语音先于打字结束 → 打字结束
  +121 帧；语音未结束 → 等到 `min(voice_end, typing_end+1800)`，再 Gate 30 帧。
  10 字 + 40s 语音 = 1882、10 字 + 2s = 154、无语音 10 字 = 173、1s 语音 20 字 = 213。
- 打字长度用官方正文的 UTF-16 长度：官方换行计入，本工程排版折行写成
  「零宽空格 + 换行」标记、计数时跳过；UIText 第 4 帧显示第 2 个字。
- `AnimationManager.linear` 新增绝对时间模式（`startMs` + `frames`，progress 只由
  虚拟时钟决定，同帧求值一致、暂停不累积）；`Ease.ts` 支持 DOTween 22 种缓动
  （补 Quint/Circ/Back，删 Expo，未知名字回落 Linear）。
- `storyPlan`：首片段 act = 10 + frames_for(delay)，总帧数 = 最后 finish + 31；
  Appear 新角色 finish = act+7（带 motion 为 act+8，类型分支延后一帧），
  从 from 到 to 的滑入与淡入并发、继续在后台（`moveEnd = at + move_frames`）。
- 角色位移改线性插值；`SIDE_UNDER_Y` = −1359.2；Telop 停留 = frames_for(2)−1；
  Talk 的强制前置栅栏移除，只看 ProgressBehavior。
- 震屏改 DOTween 分段（n = max(2, trunc(16×d))、段内 OutQuad、段末幅度减
  strength/n、最后一段 0、有限抖动父节点 y 从 −8 用 OutQuad 升到 0）；相机
  Move/Zoom 的 from 取上一条 tween 的目标值（Kill(complete)），DollyZoom 用
  `dist × −(zoom−1)`；黑场 FadeIn 无条件从 alpha=1 淡出；Blur spread =
  `3 × min(t/d, 1)`；SideFade 改 64px 内边距黑面板 + 512px 羽化边 + 官方 ±(W/H+512) 偏移；Choice 时序
  1.5s 作答 / 0.1s 按压 / 121 帧结束；PlaceInfo 片段 0 帧（面板后台滑入）。

尚未完成（本轮未改，保持旧行为）：人物层级 DepthType、独立换装时序、
FullScreenText slot 计时与语音、Movie 时序、场景特效延迟/残留/SEKAI 生命周期、
背景 prefab 分支、Talk 内嵌动作的 PlayTime/Text 同步模式。对应路线图条目仍需后续波次。

### 逐帧对比第 1 轮修复（2026-11-23）

- Talk 新增可选 `voiceDurationMs`：官方语音时长优先于 TTS 音频参与打字窗口、
  语音结束、AUTO 停留与动作/布局门控。`event_145_08` 的 49 句按参考
  `voices[].voice.waveforms[].frames / sample_rate` 写入（合计 161748ms）。
- `storyPlan` 把 `TimelineCalculator` 的 1ms 状态片段标记（ChangeLayoutMode、
  ChangeBackgroundImage、AmbientColor、HideTalk）按 0 帧处理，不再让非阻塞片段
  推进 `cursorFrame`；首条 LayoutAppear 的 act 回到参考的 131。
- Talk Gate 预读与 Talk 同帧启动的 `ProgressBehavior=Now` Motion/动作：官方
  `motions_settled` 会等这些延迟动作播完（如 1.75s 后启动的 relief），导出目标
  时长与 plan 的 `settleFrames` 都包含它们。
- `event_145_08` 的 snippets 45/48 从 Wipe 修正为参考 IR `effect_type 32/31`
  对应的 `SideFade Right Out` / `SideFade Right In`。
- 导出收尾补上官方 `end_frame` 的中间 1 帧（playedWaitTime + 1 + BGM fade），
  视频帧数可按 `plan.totalFrames - 10`（60fps）精确对照计划。
- 逐帧验证改用 `video.fps=60`、`fastFps=60`，每个输出帧对应一个故事步。

验证（`event_145_08`，60fps，2026-11-23）：

- plan 总帧 20266 vs 参考 20268（-2 帧）；49 条 Talk act 差中位数 -5
  （范围 -35..+9，修复前 -350 / -1816..+39），Talk 时长差中位数 -1 帧。
- 成片 20256 帧 = plan.totalFrames - 10，ffmpeg 显示 1920x1080 / 60fps /
  337.6s；补测片 835 帧 = 845 - 10。
- 参考 IR 41/44 的 side_fade 已与 MSST 45/48 的 `SideFade` 对齐
  （act 差 +3 / 0 帧），逐句对齐 204/207。
- 60fps 全屏 fader 逐故事帧：172 个采样，线性拟合 R²=0.999965，
  最大残差 0.00622（< 0.01）；位置 0.5px 与口型 2e-3 的逐帧像素复测
  需要单独的角色/口型探针，本轮未重跑。

### 逐帧对比第 2 轮修复（2026-11-23）

- Talk 新增可选 `typingText`：打字机按官方日文 body 的 UTF-16 长度计时，
  `content` 只负责显示。`pjsk-scenario` 转译时写入 `typingText: talk.Body`；
  `event_145_08` 49 条 Talk 已按参考正文补齐。首句 typing 由 40 帧回到参考的
  52 帧（plan 151→203，参考 152→204）。
- 新增 `Wait` 片段（毫秒 duration）。`pjsk-scenario` 的 Action 0 收尾 delay
  不再并进最后一条 `BlackOut`，而是生成独立 Wait；`event_145_08` 结尾改为
  25s 淡出（18495→19995）+ 4s Wait（19995→20235），与参考 instr 205/206 对应。
- 快速导出的帧泵目标改由最终 `bakeStoryPlan(...).totalFrames` 决定，不再只取
  `timeline.endTimeMs`（前置栅栏会让 plan 末尾晚于 timeline）；帧泵已越过 plan
  末尾时至少再补收尾黑幕的 31 帧。修复三类最小剧本挂起：空 motion 首次 Appear、
  原地最后 Clear、Appear 前置 1500ms delay。
- `startEntryMotion` 只启动已预加载的兜底动作；`dispatchExportStep` 对单个
  动画异常做 resolve/清理，避免帧泵中断后片段 Promise 永久悬挂。
- 缓动/相机/角色 Move/全屏 fader 都改绝对故事帧求值（`startMs + frames`）；
  SideFade 按参考 64px 面板 + 512px 羽化边重建，`sideFadePositions` 的位移
  改为 ±(W/H+512)（1920×1080 为 2432/1592）。

验证（2026-11-23）：

- 主片 `export-1795422759872-lk8yv1.mp4`：20256 帧 / 337.6s / 60fps，
  plan 20266；对参考 20268 仍少 2 帧。`compare-plan` matched 205，未匹配参考 2；
  49 条 Talk act 差中位 -5（-35..+9），Talk 时长差中位 -1。
  打字长度已对齐，剩余漂移来自 plan 现有的逐片段起止帧约定，尚未归零。
- 结尾 plan：BlackOut 25s（1500 帧）+ Wait 4s（240 帧）；参考 25s + 4s。
- 最小剧本：空 motion 7.2s / 88 帧；原地 Clear 5.3s / 64 帧；
  delay 1500ms 6.8s / 177 帧（修复前分别 169.8s / 96.1s / 9min 后取消）。
- CameraMove：视频内实测起点 6.6333s、0.5s、峰值 50px@270p（=200px@1080），
  相对曲线为 OutQuad；plan 起点 6.55，视频整体因实际执行漂移晚约 5 帧。
- 无 motion 静态走位：206 帧导出；渲染端 `model.x=1006.666`（1280 舞台）
  = 1510@1920（Right+200），y=864@1080；像素模板复测未重跑。
- 3s 静止场景 fader：180 个故事帧，端点 0→1；逐帧 luma 反演对线性模型
  最大残差 0.0177、均值 0.0083，受 sRGB/编码近黑压缩影响，0.01 容差
  仍无法用像素反演证实。仓库自带 `probe-fader.py` 在 296.4–299.7s 的
  `-ss` 关键帧采样给出 2.949s（r2 为 2.927s），但逐帧 `select=n` 实测
  fade 为 180 帧；两者差异来自采样/场景运动，不是淡变时长。
- Shake 8 段/末段归零/父节点 y -8→0 与 Blur `3×min(t/d,1)` 已按参考源码
  对齐；60fps 下 8 段约 3.75 帧/段，像素探针无法分辨，spread 数值不可反演。
- `npm run test:all` 362/362；`node --test scripts/stories/*.test.mjs` 8/8；
  `npm run typecheck` 通过；Prettier 全部改动文件通过；未 commit。

### 逐帧对比第 3 轮修复（2026-11-23）

- 帧泵先空跑 `PLAYCORE_WARMUP_FRAMES`（10）个故事步再开始采集：成片第 0 帧
  对应参考 `first_frame=10`。此前前 10 帧预热被拍进成片、片尾又按
  `plan.totalFrames−10` 截掉，画面整体比参考早 10 帧。帧泵推进步数也加上
  first_frame 偏移（`baseStoryStep = 10 + floor(n×60/fps)`）。
- 每个片段启动前按 `timelineEntry.delayStartTimeMs`（plan 的 act）等待，
  不再“上一片段 resolve 就启动”；49 条 Talk 的运行时起点从比 plan 早
  −467..−17ms 收敛到 ±1ms。
- 绝对帧补间（`AnimationManager.linear` 的 `startMs + frames` 模式）增加
  “帧数对应时长的 setTimeout 竞速”：`in_ticker` 只负责逐帧写值，完成时刻
  精确落在 `act+frames`；500ms 特效不再多等 1 帧（实际 499~500ms，drift 0）。
  绝对起点可晚于当前时刻（Clear 的淡出从 delay 结束开始）。
- 角色 `Move/show/hide` 的毫秒先经 `msToFrameCount`（46 帧 Slow 不再因
  `framesForSeconds(766.667ms)` 二次量化成 47 帧）；`LayoutClear` 的
  淡出按 `act+delay` 绝对起点收尾，`LayoutClear` 766.667ms 实测 766~767ms。
- 全屏 fader/BlackOut 也改用 `msToFrameCount`：25000ms 从 1501 帧回到 1500，
  3000ms 从 181 帧回到 180，避免 25s 片尾淡出把最后一条 Wait 推后 1 帧。
- 片尾目标固定为 `plan.totalFrames − 10`；`ending envelope` 的 31 帧
  （15+1+15）用 round 而不是 ceil（ceil 会得到 32）；若运行时最后一条片段
  晚 1~2 帧，只缩短收尾 hold/fade，不再延长成片；开场黑幕不再在片段循环后
  阻塞，避免短剧本把 0.5s 黑幕起点塞进片尾。
- WebCodecs 结束前多编码 1 帧用于冲刷编码器，宿主按 `frameCount`
  精确截断；`virtualClock.uninstall()` 提前到编码冲刷之前，避免长片最后
  一个 16MB muxer 分块在假时钟下等不到 tick。
- 验证（2026-11-23，60fps）：
  - 特效补测 `export-1795430897419-ilssea.mp4`：plan 845 → 成片 **835**
    （=845−10），13.9167s；500ms 的 Move/SideFade/Blur/Camera/Shake 全部
    499~500ms、起点 drift 0；LayoutClear 767/766ms（plan 766.667）；
    CameraMove 像素拟合残差 mean 0.099 / max 0.313px（≤0.5 通过）。
  - 原地 Clear 最小剧本 `export-1795431550475-67xaim.mp4`：plan 64 →
    成片 **54**（=64−10），0.9s（修复前 64 帧）。
  - 空 motion 最小剧本 `export-1795431603090-a98i7t.mp4`：plan 94 → **84**；
    修正后的 1.5s delay 剧本 `export-1795431608515-clu15k.mp4`：plan 186 →
    **176**，2.933s（原始 `delay:1500` 是 1500 秒，不是渲染挂起）。
  - 无 motion 走位 `export-1795431556054-yqu3mc.mp4`：plan 283 → **273**
    （=283−10），4.55s；Move 500ms、位移像素 563.5 vs 550，逐帧残差
    mean 14.65 / max 16.28px（待机呼吸混入，未能只测位移）。
  - 主片 `export-1795431627235-n2sls7.mp4`：plan **20267** → 成片
    **20257**（=plan−10），337.617s / 60fps；参考 end_frame 20268（−1 帧）。
    49 条 Talk 的运行时起点 drift 中位 **+2ms**（-1..+99；+99 的唯一异常是
    某次首次 LayoutAppear 实际 216ms vs plan 116.667），按 plan act 与 drift
    折算对参考 act 差中位 **-3.74 帧**（-29.86..+10.00；前两轮 -24）。
  - 3s BlackOut：像素反演起点 297.066s、时长 2.985s（180 帧），对线性
    alpha 模型最大偏差 **0.00805**、均值 0.00162（<0.01 通过）；相对参考
    act 296.95 仍晚约 7 帧（plan act 残差）。
  - SideFade 仍未达到 ≤1px：Out mean 37.517 / max 67.856px；In 的探针
    模型与 512px 羽化面板不一致，实测残差 74.707 / 133.603px，需按参考
    纹理 alpha（`tex_transition_left/top` 的 128..512 裁剪）重做像素模型。
  - `npm run test:all` **363/363** 通过；`npm run typecheck`、Prettier 通过。

### 逐帧对比第 4 轮修复（2026-11-23）

- **PlayCore 逐帧栅栏**：参考 `sse-timeline/src/lib.rs` 的调度器在非零等待任务
  结束帧 `finish` 完成协程，PlayCore 的启动循环下一帧才启动下一条
  WaitFinished 片段。`storyPlan` 的 `durationFrames` 现在表示实际等待帧数，
  非末条的 `endFrame = finish + 1`，最后一条的 cleanup 仍在 `finish` 帧；
  delay 本身也算“跑过”。`TimelineCalculator` 的 planned start 用同一规则
  （`runningFenceEndMs = finish + 1`）。参考 `20268` 帧的离线对照在给定参考
  motion 收尾时 150/150 个 Talk/layout act 与 finish 全部为 0，plan total 20268。
- **Talk 窗口**：`closeWindowOnFinish` 在台词 finish 后 0.2s 才关窗；下一句若
  在这之前开始仍按窗口打开处理。`storyPlan`、`TimelineCalculator` 与导出循环
  `talkWindowOpenMs` 都改为该状态机。`event_145_08` 测试剧本补齐了从参考 IR
  丢失的 16 个 close 标志、Move/LayoutAppear/LayoutClear 的 MoveSpeed 名称
  （参考 `move_duration` 0.33/0.5/0.75 对应 Fast/Normal/Slow）以及
  FlashbackIn/Out 的 0 时长（原剧本写成 100ms）。
- **秒数 → 帧**：新增 `SECONDS_DURATION_SNIPPET_TYPES`；BlackOut/BlackIn/
  SideFade/Blur/Camera/Shake/Flashback/Wait 等剧本以秒给出的 duration 用
  f32 `frames_for`：3.0s=181、2.0s=121、4.0s=241、25.0s=1501。全屏 fader
  运行时也改成 `framesForSeconds(duration/1000)`，不再用 `msToFrameCount`
  （180/120/240/1500）。已量化的角色淡入/Move/Clear 毫秒仍走 `msToFrameCount`。
- **计划启动对齐**：片段启动晚于 timeline 的 delayStart 时，`BaseSnippet`
  只补到 plan act 的剩余 delay（`exportDelayMs`），避免开场初始化/上一片段
  抖动把带 delay 的入场动作整体推后。
- **SideFade**：参考 64px 内边距/512px 羽化是 1920×1080 画布像素；导出
  逻辑画布是 1280×720/resolution 1.5，现按 `1920/screen.width` 换算回逻辑
  单位，修复羽化变成 768 物理像素、位移变成 2432+256 的问题。In 类型的
  前沿羽化换到面板另一侧（RightIn 用 end、LeftIn 用 start、TopIn 用 start、
  BottomIn 用 end）；像素探针的 In 模型补上 `+256`（面板右边 + 512px 羽化
  的 50% 点），此前把 In 前沿错当成面板右边界。
- **位置/震屏/模糊**：抽出 `interpolatePosition`、`shakeSegmentEnds`、
  `cameraBlurRatio` 纯函数并由 `AdvancedModel`、`App.shakeScreen`、
  `SpecialEffectLayer.setCameraBlur` 使用。`effect-math-parity.test.mjs`
  验证 550px/30 帧的线性步进（每帧误差 <1e-9）、0.5s 震屏 8 段且末段归零、
  Blur `3·min(t/d,1)`/`3−…`。

验证（2026-11-23）：

- 参考 motion 收尾的离线 plan：150 个 Talk/layout 行 act 与 finish 全部 0，
  plan total 20268 = 参考 end_frame；证明起止/栅栏约定本身已对齐。
- 完整主片 `export-1795436845044-bt5l87.mp4`：plan 20271、成片 20261
  （=plan−10）、337.683s、60fps。plan act 中位 **−3**（−9..+3）、finish
  中位 −3，仍未归零；最差 −9 集中在带入场 motion 的段落。日志显示这些
  motion 的 request 在 `video 2000ms`，而参考 LayoutAppear act 是
  `2016.67ms`，运行时 motion 起点仍受开场/TTS 准备影响，plan 的
  motionSettle 随之偏移。此残余已定位为运行时 motion 调度，而非 plan 的
  起止公式。
- 3s/2s/4s/25s 帧数：plan duration 181/121/241/1501，日志实际
  `BlackOut`（含 1s delay）4016ms、`BlackIn`（含3s delay）5016ms、
  25s `BlackOut` 25017ms，均等于 f32 `frames_for` + delay。3s fade
  像素探针 firstOn=297.0667s、alpha 0.1→0.9 为 2.3667s（0.8×3s=2.4s，
  受近黑 sRGB/编码偏差）。plan act 17830 vs 参考 17827（+3 帧），像素
  alpha 阈值 firstOn 折回约 +7 帧；alpha ≤0.01 的逐帧对照仍因起点差
  未复验。
- 带 delay 的最小入场 `export-1795437722564-mg6pfv.mp4`：plan act frame101
  =1516.67ms，motion request 1682.33ms（fake clock，warmup 166.67ms）
  = video 1515.67ms，误差 −1 帧。`exportDelayMs` 只补到 plan act 的剩余
  delay；主片因 TTS 准备重复运行时出现一次取消/挂起（无产物），因此该对齐
  在主片上的效果尚未得到完整成片复验。
- SideFade：修复 1.5× 物理/逻辑换算与 In 羽化侧；重跑
  `export-1795436552881-npupyg.mp4`：Out planAligned mean 32.45 / max
  44.91px，In mean 29.55 / max 43.19px；按时间 t0 最优拟合 Out
  mean 9.18 / max 14.20px、In mean 7.80 / max 15.39px。仍未达到 ≤1px；
  剩余误差来自 512px 羽化 50% 边缘与视频 luma 反演，In 探针模型已补
  `+256`。
- 位置：`effect-math-parity.test.mjs` 验证 550px/30 帧线性，逐帧误差
  <1e-9，静态重复求值无漂移；像素位移仍为 563.54px（preStd 5.59，
  待机呼吸混入），未用像素证明 ≤1px。
- 震屏：0.5s = 8 段、末段归零的纯函数测试通过；成片尾部 dx 0.007 /
  dy −0.074px，8 段在 60fps（3.75帧/段）下仍不可像素分辨。
- Blur：`3·min(t/d,1)`（Out 为 `3−…`）纯函数测试通过；视频只能证明开关
  时点，spread 仍不可反演。
- 回归：`node --test scripts/renderer/*.test.mjs` **193/193**；
  `node --test scripts/export/*.test.mjs scripts/api/ffmpeg-and-security.test.mjs`
  **29/29**；`npm run typecheck` 通过；Prettier 全部改动文件通过。
  `scripts/ai/motion-parity-wave4.test.mjs` 的 Cubism4 循环/眨眼失败在
  HEAD 上同样复现（临时换回 HEAD 的 `AdvancedModel.ts` 验证），与本轮无关。
  未 commit，保留 LF，无仓库内临时文件。

## 2026-11 口型、眨眼、呼吸按 sse-live2d/sse-bake 重写

本节取代下面「2026-11 早期口型链路重构记录」一节。参考实现以公开的
SekaiStoryExporter（`sse-bake/src/lipsync.rs`、`sse-bake/src/lib.rs`、
`sse-live2d/src/blink.rs`、`runtime.rs`、`motion.rs`、`sse-core/src/consts.rs`）为准，
按「能整段移植就整段移植」重写口型两条链与待机自然动作。早期的
`AdvLipSyncPolicy` 预设、p95 响度归一、450ms 指数尾、8Hz 音节正弦、四段线性眨眼
全部删除。

口型（`Lip::Voice` / `Lip::Text`）：

- 语音与文本两条链都按剧情 60Hz（16.667ms）步进，每一步只做一次官方三档 `smooth()`：
  当前值 <0.1 用 0.6/0.4；目标与当前值差 <0.1 用 0.2/0.8；否则 0.25/0.75。
  恒 1.0 输入 60 步后开度 0.99999999；1.0 释放到 <0.001 用 14 步，0.2 用 8 步。
- 语音目标：窗口是「结束于当前步时刻的最后一帧样本」
  （`end = (frame/60)×rate` 取整，`len = rate/60` 取整，48k 下 800 个），窗口内
  混音求 RMS；`a = rms × tvs`，`target = a×(a+1)^(tvs×1.75)`，`target < 0.06`
  记 0，否则限幅 0.2~1。第 0 步窗口为空，第一声在第 1 步 = 0.6×target。
- 口型系数：一次 talk 把说话人重设为 `(tvs, tvs×1.75)`。MSST 剧本没有 per-talk
  `TargetValueScale`，包络按模型初值构建：资源名角色号属于 1/4/8/12/17/18 时
  1.25（`01ichika_normal`），否则 1.0（`v2_20mizuki_culture`）。rms=0.2 时
  tvs1 → 0.2752、tvs1.25 → 0.4073；rms=0.3 → 0.4748 / 0.7526；
  rms=0.05 且 tvs1.25 落在 0.2 下限。
- 文本目标：`LipLevels[(k·step + first) % 38]`，`step = 说话人数`、
  `first = slot + 1`（全员 talk 时 step=1、first=0）；`k = (frame − typing_start) / 2`
  取整，所以一个半字 = 2 个相同 target 的 60Hz 步。`typing_end − 一个整字`
  （4 帧）处开始归零；点击提前结束时从点击帧归零。
- 脱手：样本放完（或文本已收尾）且平滑值 <0.001 的那一步官方写 0 后把 `Lip`
  换成 `None`；之后不再写 `ParamMouthOpenY`。`LipSyncEnvelope.releaseStep`
  记录该步，`AdvancedModel.releaseMouth()` 清掉待写值，Talk 结束时也调用它。
- 写入范围：只有本次 talk 的 speaker 挂 `beforeModelUpdate` 监听；同台听者不写 0，
  嘴由他们自己的动作/表情决定。`TalkSnippet` 直接按 60Hz 步号取包络值，不再对
  半字做线性插值，也不在包络上叠 8Hz、±35% 的正弦。

眨眼（`Live2DEyeBlinkController`）：

- `|sin|` 控制器：Ready 状态 `untilTime -= dt`，<0 时相位从 `-π/2` 起，
  每步 `+= 10×dt`，`EyeOpening = |sin(radian)|`；`|sin|` 回到上升沿
  （本帧值 < 上帧值）时结束并重抽 `3 + Random.Range(-2, 2)`。一眨 19 步 <1、
  第 20 步强制 1.0；60Hz 谷值 0.0707，30fps 抽取按步号奇偶得 0.0707 或 0.0957。
- `untilTime` 睡眠期间不递减，`WakeUp` 不重置；睡梦中唤醒不改变当前这眨，
  只在结束时停住。新模型 `Sleep`；任何身体动作切换都 `Sleep`，只有非循环
  身体 clip 越过结尾才 `WakeUp`；请求模型没有的身体动作同样 `Sleep` 且不再唤醒。
- 眼参数无条件乘 `EyeOpening`（`CubismEyeBlinkController` 的 Multiply），
  不再按 `base > 0.25` 跳过、也不因眼睛本来闭着冻结 `untilTime`。
- 动作 `UserData` 的 `OnLive2DInvokeUserData`（例如 `eyeblink,0.2,0.24,0.24`）
  由 `convertSseMotion` 写进 motion3 `UserData`，`AdvancedModel` 在
  `MotionQueueManager` 的事件回调里转给眨眼控制器：闭 eye→0（closing）、
  保持 0（closed）、eye→1（opening）；序列播放中忽略新命令，少于 4 段不触发。

呼吸（`Live2DModel.LateUpdate`）：

- `breathDegree` 初值是 `Random.Range(0, 360)` 的整数；每个 60Hz 步 +2°，
  越过 360 只减一次 360（不取模到负）；`ParamBreath = (sin(degree×DEG2RAD)×0.5+0.5)×0.5`，
  180 步一个周期，隐藏（非 active）时冻结。

动作混合（`ScenarioModel.ChangeMotionCore` / `Live2DModel.play`）：

- 身体分支顺序：`force && first` → 0；同类别或链接动作 → 0.125s；
  `force` → 0；否则新 clip 的 `FadeInTime`（model3
  `FileReferences.Motions[name][0].FadeInTime`，缺省 0.5s）。
- 表情：Force → 0；否则 clip 的 `FadeInTime`（缺省 `live2d.facial_fade = 0.25s`）。
- 已知未移植：官方在淡出期间把「旧 clip 覆盖、进入 clip 不覆盖」的参数滑向默认值；
  pixi 的队列只按权重混合各自的曲线，没有这个归位层。本轮只对齐混合时长。

已知未移植（口型）：点击提前结束时截断 PCM 后继续平滑（`Lip::cut_voice`）。
导出没有点击；交互播放点击后整个 snippet 结束并 `releaseMouth()`。

## 2026-11 早期口型链路重构记录

> 已被上一节取代；本节仅保留为历史记录。

本节记录 2026-11 对语音口型链路（`src/common/official/timing.ts` + `src/renderer/src/utils/LipSyncEnvelope.ts`）的早期试验：曾尝试用 `AdvLipSyncPolicy` 配合裸 `Live2DVoice` RMS 曲线并去掉额外低通平滑，后续已在上一节中统一替换为 `sse-bake` 的 60Hz `Lip::Voice` / `Lip::Text` 官方三档 `smooth()` 实现。

> 配合契约测试 `scripts/renderer/sekai-exporter-parity.test.mjs` 维护。本计划旨在把
> `https://github.com/StarMoe-org/SekaiStoryExporter` 核对过的官方演出语义，落到本项目的
> TypeScript/Pixi 渲染管线里。

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

| 项目         | 官方/SSE                                                                                                                                                                | 本项目当前                                                                                                    | 影响                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 打字速度     | `word_interval=0.06s`，每半字 `ceil(0.03×60)=2` 帧，合计 **4 帧/字 = 66.67ms**                                                                                          | `TALK_DISPLAY_MS_PER_CHAR=80`                                                                                 | 每句慢 20%                                 |
| 语音后停留   | 语音结束 + `0.05s` 延迟，再过 **0.5s** 自动翻页                                                                                                                         | 固定 `+600ms`                                                                                                 | 句间节奏偏慢/不一致                        |
| 无语音台词   | 打字结束 + **2.0s**                                                                                                                                                     | 固定 `+600ms`，且有 1800ms 下限                                                                               | 无声段落过快                               |
| 动作收尾闸门 | 自动模式要等布局结束、所有身体动作播完，再等 0.5s                                                                                                                       | 完全不等                                                                                                      | 长动作被下一句硬切                         |
| 对话框打开   | `PlayActive(1,0.2)`，打字等 0.2s                                                                                                                                        | 70ms                                                                                                          | 首次台词提前                               |
| 入场淡入     | `FadeOpacity(1, 0.1)`，先 1 帧 alpha=0                                                                                                                                  | `show(200)`                                                                                                   | 入场慢一倍                                 |
| 已在场再入场 | `CharacterMoveToCoroutine(side, 0.2)`，不淡入                                                                                                                           | 统一 show+move                                                                                                | 语义不符                                   |
| 入场完成     | 淡入结束（约 7 帧）即完成，滑入继续                                                                                                                                     | 等 show + 完整 move                                                                                           | 每场多等 0.5~0.75s                         |
| 退场         | 原地 `delay 0.15 + fade 0.1`；滑动 `delay=move-0.1 + fade 0.1`                                                                                                          | 原地 300ms；滑动 `max(400, move)` 同时淡出                                                                    | 退场时序不符                               |
| 移动速度     | Slow 0.75s / Normal 0.5s / Fast 0.33s                                                                                                                                   | 700/500/300ms                                                                                                 | 固定偏差                                   |
| 站位         | 普通 `±350/1920`，三人 `±550/1920`，三人缩放 0.9                                                                                                                        | 0.3/0.7，0.25/0.75                                                                                            | 三人模式偏内                               |
| 身体动作混合 | 0.5s 交叉淡化；同类别/链接动作 0.125s                                                                                                                                   | 依赖默认 0.5s，但每次先 `stopAllMotions()`，旧姿势被丢弃                                                      | 动作切换跳变、节奏感不稳                   |
| 表情混合     | clip `FadeInTime`（缺省 0.25s）；Force 时 0                                                                                                                             | 按 clip `FadeInTime`，缺省 0.25s；Force 0                                                                     | 已对齐                                     |
| 眨眼         | 均值 3s、±2s、速度 10 的 \|sin\| 控制器（19 步 <1、第 20 步 1.0）；动作期间 Sleep，非循环动作结束 Wake；眼参数无条件乘 EyeOpening；动作 UserData 的 eyeblink 走命令序列 | 2026-11 起按 `sse-live2d/src/blink.rs` 移植（见「2026-11 口型、眨眼、呼吸」节）                               | 已对齐                                     |
| 呼吸         | 3s 周期、影响 0.5、ParamBreath；整数相位初值、每步 +2°、非 active 冻结                                                                                                  | 已按 `Live2DModel.LateUpdate` 移植                                                                            | 已对齐                                     |
| 口型         | 60Hz 每帧 RMS → `a×tvs`、`a×pow(a+1,tvs×1.75)`、阈值 0.06、限幅 0.2~1、三档 smooth()；文本 LipLevels 按半字推进；<0.001 脱手                                            | 2026-11 起两条链都按 60Hz 步进、只走 smooth()，删除 p95 归一/450ms 尾/8Hz 正弦/半字插值；speaker 独占口型监听 | 已对齐（见「2026-11 口型、眨眼、呼吸」节） |
| 导出可观测性 | `report.txt` + 逐帧参数表                                                                                                                                               | `.log`/`.log.json` + 动作追踪                                                                                 | 缺少帧级计划和近似清单                     |

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
- [x] 角色位移统一走 DOTween `OutQuad`（`evaluateEase`，与 `sse-core/src/ease.rs` 同款）：
      入场/退场/Move 的滑入滑出不再是线性匀速。
      （2026-11 波次已按 `sse-bake` 的 `move_view` 改回线性；本条为历史记录。）
- [x] `show`/`hide` 从当前 AlphaFilter 值补间到目标值：退场中途重新 Appear、
      或连续 Hide 时不会闪一帧全透明/全不透明。
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
- [x] 眨眼控制器（2026-11 改为 `sse-live2d/src/blink.rs` 的 |sin| 控制器）：
  - Ready 状态 `untilTime -= dt`，<0 后相位从 `-π/2` 起每步 `+= 10×dt`，
    `EyeOpening = |sin|`；回到上升沿时重抽 `3 + Random.Range(-2, 2)`。
  - 一眨 19 步 <1、第 20 步强制 1.0；60Hz 谷值 0.0707，30fps 抽取 0.0707/0.0957。
  - 身体动作切换 `Sleep`；只有非循环 body clip 越过结尾 `Wake`；缺失动作永久 Sleep。
  - 眼参数无条件乘 `EyeOpening`；动作 UserData 的 `eyeblink,...` 走 Command 序列。
  - 关闭 `internalModel.eyeBlink` 自带眨眼，避免双重驱动。
- [x] 呼吸：整数相位初值，每个 60Hz 步 +2°、越过 360 只减一次，
      `ParamBreath = (sin(degree×DEG2RAD)×0.5+0.5)×0.5`，180 步周期；非 active 冻结。
- [x] 口型（2026-11 重写，详见头部「2026-11 口型、眨眼、呼吸按 sse-live2d/sse-bake 重写」节）：
  - `buildLipSyncEnvelope`：60Hz 窗 RMS（结束于当前步的最后一帧样本）+ 官方
    `a×(a+1)^(tvs×1.75)`、阈值 0.06、限幅 0.2~1，再逐步走三档 `smooth()`。
  - 口型系数按 talk 重设为 `(tvs, tvs×1.75)`；包络按模型初值
    （角色号 1/4/8/12/17/18 → 1.25，其余 1.0）构建。取消 p95 响度归一。
  - 样本放完/文本收尾且平滑值 <0.001 后脱手（`releaseStep` + `releaseMouth()`）；
    Talk 结束时也脱手。
  - 文本口型：一个半字 = 2 个相同 target 的 60Hz 步，`slot = {index,total}`，
    `typing_end − 一个整字`起归零；删除 TalkSnippet 的半字线性插值。
  - 只有本次 talk 的 speaker 挂监听；同台听者不写 0。删除 8Hz 音节正弦。
  - 口型链路不写 `ParamMouthForm`：form 由表情/动作拥有。
  - 保留 `sampleLipSync`（按步号取值、不插值）与监听器清理语义。

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
- [x] `scripts/renderer/motion-blend.test.mjs`：交叉淡化、同类别 125ms、
      clip FadeInTime、force+同类 0.125s、表情 FadeInTime/Force 0。
- [x] `scripts/renderer/natural-motion.test.mjs`：|sin| 眨眼 19+1 步/0.0707/30fps 奇偶、
      Sleep/Wake 与 untilTime、动作切换 Sleep/非循环结束 Wake/缺失动作永久 Sleep、
      eyeblink 命令序列、呼吸整数相位与 180 步周期、三档 smooth() 与 14/8 步释放、
      语音 0.6×target、静音与轻声下限、文本 slot/LipLevels。
- [x] `scripts/renderer/lipsync-envelope.test.mjs`：RMS 窗口边界、句间静音、
      <0.001 脱手、p95 归一已删除、按步号取值（30fps 与 60fps 同值）、
      文本半字两步与 typing_end−一个整字。
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
- [x] `LayoutClearSnippet` 用 `layerModel.markModelHidden(modelId)` 读取并更新官方 shown
      状态；不在场时只 `removeModel`，不启动退场动作、不移动、不淡出。
      非阻塞退场期间的新 `LayoutAppear` 用可见性代数作废旧协程（Phase J）。
- [x] `scripts/renderer/layout-matrix.test.mjs`：矩阵用例补前置 Appear 建立在场状态，
      并新增“重复 Appear 12 帧无 fade”“未在场 Clear 0 帧”断言。
- [x] `scripts/renderer/layout-appear.test.mjs`：新增未在场 `LayoutClear` 只调用
      `removeModel` 的运行时回归。
- [x] 官方语料审计与 `event_116_06` 实导出改用可见性分支后复跑通过。
- [x] 导出预检只在 `tts.enabled=true` 且 provider 为 Irodori 时要求日文 `ttsText`；
      TTS 关闭时不再因缺日文阻断纯画面导出（`needsJapaneseTtsPreflight` + 回归断言）。

### Phase J：多剧本还原度实导出验收

- [x] 官方语料抽 4 集特征互补剧本（TTS 关闭、仓库内替代模型/背景）：
      `event_147_05`（68 句 / SideFade / 布局模式切换 / 无 15·16·19·22）、
      `event_191_04`（73 句 / 14 模型 / 96 次 Appear+Clear / CameraMove·Zoom）、
      `event_160_07`（114 句 / 23 种特效 / 28 次 SideFade / 9999s 震屏）、
      `event_79_05`（122 句 / 21 次黑场 / 19 次背景切换 / 三人在场）。
- [x] 转换器为没有动作的 Talk 说话者（观众、旁白）补 `story.models`，并在写出前
      自检所有被引用的 `modelId` 都已声明；导出不再报 `Model with id N not found`。
- [x] 官方 EffectType 5/6 的 9999 秒（“抖到 StopShake”）钳到 `ShakeScreen` 的 30s
      上限，后续 25/26 仍按脚本立即停止；`event_160_07` 从 400 校验失败恢复为 200。
- [x] 可见性改为官方 shown 状态 + 可见性代数：非阻塞 Clear 在后台淡出时，新 Appear
      按 7 帧淡入处理，旧退场协程不再写 alpha / 清理动作 / `removeModel`。
      `event_147_05` 的三个 250ms Clear 从 0ms 恢复为 253ms，Appear 从 218ms 回到 127ms；
      原先 81~83s 台词期间消失的角色恢复可见（抽帧确认）。
      依据：SSE `crates/sse-timeline` 的 Hide 分支在协程开始时就把 shown 置 false，
      随后的 Appear 对非 shown 视图走 `FadeOpacity(1, 0.1)`，确认退场应按异步协程处理。
- [x] 黑屏保护改为画面 3x3 网格取样，并跳过准备片段、脚本黑/白场与覆盖转场；
      `event_191_04` 不再因“纯黑背景 + 居中角色”被误杀（首轮 500 -> 复跑 200）。
- [x] 长片累计漂移不再逐句记异常，只报突然新增 >100ms 的跳变；
      `event_79_05` 的 204 条逐句漂移噪音降到 3 条真实事件。
- [x] 四集最终实导出（最终构建，1920x1080 h264）：
      `event_147_05` 318 段 / 68 句 / 9 模型：planned 316320ms、actual 317665ms、
      avgAbsDrift 745ms、anomalies 0、成片 317.74s；
      `event_191_04` 397 段 / 73 句 / 14 模型：planned 359612ms、actual 361097ms、
      avgAbsDrift 802ms、anomalies 0、成片 361.49s；
      `event_160_07` 423 段 / 114 句 / 8 模型：planned 493888ms、actual 495375ms、
      avgAbsDrift 839ms、anomalies 0、成片 495.46s；
      `event_79_05` 440 段 / 122 句 / 4 模型：planned 569546ms、actual 571842ms、
      avgAbsDrift 926ms、anomalies 3（两次 +107/+153ms 跳变、一次 223ms 动作被后续
      cue 接管）、成片 571.94s。
      四集均无未执行片段、无 plan/log 逐条不对齐；动作 skip 均来自替代模型缺官方
      动作名或同表情已激活，没有未知加载失败。
- [x] 成片语义抽帧：入场角色可见、双人左右站位、Telop 文本、SideFade 遮挡、
      EffectType 1~4 黑/白场末帧亮度 0/255、台词字幕与剧本一致。
- [x] 回归：`pjsk-scenario.test.mjs`（Talk-only 模型声明）、`layout-visibility.test.mjs`
      （Clear/Appear 竞态）、`frame-validator.test.mjs`（中央内容不再判黑）、
      `story-plan` 非阻塞 Clear 用例、`export-diagnostics` 累计漂移用例。

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

- 2026-11-23：口型两条链改为 60Hz 步进 + 官方三档 smooth()（删除 AdvLipSyncPolicy /
  p95 归一 / 8Hz 正弦 / 半字插值），脱手改 `releaseStep` + `releaseMouth()`；
  眨眼改 |sin| 控制器并补动作 UserData eyeblink 命令序列；呼吸整数相位与 180 步周期；
  表情/身体混合改用 clip `FadeInTime` 与 `force && first → same_category → force → fade`
  的分支顺序。对应测试：`natural-motion`、`lipsync-envelope`、`character-animation`、
  `dialogue-timing`、`motion-blend`、`render-timing-wave5`、`assets/motion3`。
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

- 2026-11-08：Phase J 完成（4 集官方语料还原度实导出与修复）。
  - 首轮暴露 3 个真实问题：`event_191_04` 因黑屏保护只读左下角而被纯黑背景误杀；
    `event_160_07` 因官方 9999 秒震屏超过 `ShakeScreen` 上限被 400 拒绝；
    `event_147_05` 的非阻塞 Clear 与紧随的 Appear 竞争，导致 81~83s 台词期间角色消失、
    后续 Clear 变成 0ms。修复后三集均导出成功。
  - 最终四集（TTS 关闭、替代模型/背景，1920x1080 h264）：
    `event_147_05` 318 段：planned 316320ms / actual 317665ms / avgAbsDrift 745ms / 0 异常；
    `event_191_04` 397 段：planned 359612ms / actual 361097ms / avgAbsDrift 802ms / 0 异常；
    `event_160_07` 423 段：planned 493888ms / actual 495375ms / avgAbsDrift 839ms / 0 异常；
    `event_79_05` 440 段：planned 569546ms / actual 571842ms / avgAbsDrift 926ms / 3 异常
    （两次 107/153ms 跳变、一次 223ms 动作被后续 cue 接管）。
  - 成片自检：入场/双人左右站位、Telop、SideFade、台词字幕正常；
    黑场末帧亮度 0、白场末帧亮度 255，与 EffectType 1~4 一致。
  - 日志：`apifile/export-1794151256753-cwz7te.*`、`export-1794151578104-fnat19.*`、
    `export-1794151942629-cqe3bv.*`、`export-1794152466943-voauz7.*`。
  - 首轮失败与修复对照：`export-1794149760101-mrsbgp.*`（Talk-only 模型未声明，
    `Model with id 1 not found`）、`export-1794150464053-trsu3r.*`（黑屏假阳性）、
    `export-1794150551037-ys19yk.*`（修复前的 `event_79_05`，204 条漂移噪音）。

### 帧语义与导出时钟（第 5 轮，2026-11-24）

- 成片帧 n = 故事帧 n（`sse-export/src/lib.rs:513-545` 的 `Clock::base`；参考
  `sse export` 默认 `--from 0`，PlayCore 前 10 个故事帧也在成片里）。上一轮
  「成片 = `plan.totalFrames − 10`」会把整段画面相对参考提前 10 帧，已移除；
  60fps 成片帧数 = `plan.totalFrames`。
- 帧泵不再在成片帧 0 之前空跑 10 个故事步。TimelineCalculator 的 0 点仍在故事帧 10
  （`timelineStartMs`），`waitForPlannedStartMs` / `delayOverrideMs` 按 timeline 坐标
  计算；`SnippetTimestampRecorder` 记双原点：音频 placement/总时长用成片帧 0，
  诊断漂移仍用 timeline 0（`getTimelineStartWallMs`）。
- 诊断新增 `export.videoFps` 与 `frameMap`（`floor(n×60/videoFps)` 公式、story/video
  帧数、PlayCore 预热帧、timeline 0 所在故事帧），文本日志打印 `frame map:` 行。
- 非整除帧率按 `floor((k+1)×60/fps) − floor(k×60/fps)` 推进（25fps 2,2,3,2,3；
  24fps 2,3,2,3），成片帧数 `ceil(storyFrames×fps/60)`；helper 在
  `src/common/official/timing.ts`（`storyFrameForVideoFrame` 等）。
- 帧泵拍完 end_frame 前 1 帧后继续推进模拟到 end_frame（不再渲染/采集），
  让片尾封包在 end_frame 时刻的定时器落地；否则假时钟下帧泵先停会把
  `setEndingEnvelope` 永久挂起（本轮真实导出曾因此卡住）。
- 验证（2026-11-24，60fps）：`scenario-min-empty` 95 帧 / 1.583s = plan 95；
  `scenario-effects` 858 帧 / 14.3s = plan 858，16 条 snippet 的 drift 均 ≤2ms、
  anomalies 0；`npm run test:all` 370/370。逐帧 alpha/像素对照未重跑。
