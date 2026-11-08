# 与 Moesekai 剧情浏览器对齐：动作/入场/双人/日语 TTS/导出日志

> 上下文被压缩后先读这份文件，再读 `scripts/renderer/moesekai-parity.test.mjs` 顶部的
> “PLAN SNAPSHOT”。2026-11-08 起，帧级时序/混合/自然动作的后续工作见
> [SekaiStoryExporter 对齐计划](sekai-exporter-parity-plan.md)。目标不是“能出片”，而是让演出语义与官方 scenario 播放一致，并且每次
> 导出都留下可复查的逐句/逐动作日志。

## 1. 参考与官方语义

参考 `https://github.com/StarMoe-org/Moesekai` 的剧情浏览器（本地 checkout：
`D:/Users/桌面/人格设定/_tmp2/moesekai`）与官方 `scenario/*.json`：

- 浏览器按 `Snippets` 顺序推进；`Talk` 的停留时间由语音长度决定，没有语音时按文本长度估算。
- 官方 29,057 条 `TalkData` 中：
  - 23,394 条（80.5%）带 `Motions`；
  - 其中 23,323 条只有 1 个 motion（99.7%）；
  - `MotionChangeFrom` 全部为 1，`TimingSyncValue` 为 0 —— **动作在台词开始时触发**，
    不是在台词进行到某个百分比时触发。
- `LayoutData.Type=2` 是入场（Appear），`Type=3` 是退场（Clear），`Type=1` 是移动，
  `Type=0` 是纯动作；双人同场时官方用不同的 Left/Right 槽位。
- `ProgressBehavior=1` 等待的是**该条 layout/effect 的转场完成**，不是等待角色动作剪辑
  播完（动作剪辑通常 1.0~4.0 秒，远超 400~800ms 的入场转场）。
- 官方 motion3.json 没有 `FadeInTime`/`FadeOutTime`，SSE 的 Live2D runtime 用 `body_motion_fade=0.5s`、`facial_fade=0.25s`；
  动作剪辑长度 1.0~3.97 秒（01ichika 246 个 body motion 实测，均值 2.33 秒）。

## 2. 本次要修的四个问题与根因

### 问题 1：动作切换时而快时而慢

已定位的根因：

1. `composeStory` 把每句动作写在 `at: 0.1`，即“台词时长的 10%”。台词时长随 TTS 音频
   在 1.8~6 秒之间变化，动作真正开始的绝对时间就在 0.18~0.6 秒之间漂移；短句动作还没
   淡入完就被下一句打断，长句又能播完，观感就是忽快忽慢。官方是固定 `at: 0`。
2. `AnimationManager.linear` 在任意帧耗时 >100ms 时把步进强行改成 20ms（30~100ms 改成
   25ms）。导出负载高时，fade/move 会慢 5~10 倍，而 Live2D 动作仍按真实时间播放，
   两者不同步。导出模式必须使用真实帧间隔（仅做上限保护），不能把时间“吃掉”。
3. `LayoutAppearSnippet` 会 `await waitForMotionsFinished()`，等完整入场动作（平均 2.3 秒）
   才继续下一条。这个等待不在时间线预算内，导致每条入场后都出现长度随动作剪辑变化的停顿。

### 问题 2：角色入场一瞬间站桩

1. `LayoutAppearSnippet` 先启动 `model.show(200)` 淡入，再 `await startMotions(...)` 加载并
   启动动作。动作文件首次加载期间，角色已经淡入但还在默认站姿。
2. `StoryManager.preloadModels` 只预加载 `Talk`/`Motion` 里的 motion/facial，没有预加载
   `LayoutAppear`/`LayoutClear`，所以第一次入场的动作必然走一次冷加载。
3. 双人入场时 `composeStory` 只给第一个角色 motion，第二个角色用 `fadeIn:true`；校验器
   又会把 `fadeIn` 的 motion 清空，于是第二个角色必定站桩淡入。
4. 入场动作播完后 `waitForMotionsFinished` 让角色保持末帧，直到第一句台词，视觉上也是站桩。

### 问题 3：IrodoriTTS 只能读日文

1. API 导出时 `App.applyApiExportConfig` 把 renderer 的翻译服务显式设为 `enabled:false`。
2. `ConcurrentExportPipeline` 在 `ttsText` 为空时走 `translateAndSynthesize`；翻译关闭后
   直接把中文 `content` 送给 Irodori。
3. `StoryWriter.translateTtsText` 只补空字符串，不检查已有 `ttsText` 是否真的是日文；
   外部直接 `POST /api/v1/export` 的剧本完全绕过翻译。

修复原则：**Irodori 路径上绝不把非日文送给 TTS**。宿主在导出前补齐/纠正 `ttsText`；
renderer 再做最后一道日文校验，失败就明确报错，而不是读中文。

### 问题 4：双人动画不应反复切人

`planPresence` 目前按“说话人发言段 + 听者反应”生成 solo/duo 交替；48 句的 phase20 剧本
产生 28 次 `LayoutAppear` + 28 次 `LayoutClear`。双人戏应该开场两人同时在场，整场保持
Left/Right，只有结尾退场。单人道具保持 Center。

## 3. 实施方案

### Phase A：动作时序与入场（对应问题 1、2）

- [x] `composeStory` 的逐句动作改为 `at: 0`；听者反应同样 `at: 0`。
- [x] `AnimationManager.linear`：导出模式用真实 `elapsedMS`，只做 1 秒上限保护；
      预览模式保留温和钳制，但不再用 20ms 硬编码。
- [x] `LayoutAppearSnippet`：先 `await startMotions()`（模型此时 alpha=0），再并发
      `show()` + `move()`；不再等待完整动作剪辑，只等转场结束。
- [x] `LayoutClearSnippet`：动作与淡出/滑出并发，保持现状；补日志。
- [x] `StoryManager.preloadModels` 把 `LayoutAppear`/`LayoutClear` 的 motion/facial
      也加入预加载集合。
- [x] 双人首次入场两个角色都给 motion，不再给第二个角色 `fadeIn:true`。
- [x] `AdvancedModel` 暴露动作追踪：请求/加载完成/开始播放/被下一 cue 打断，记录
      剪辑长度与间隔，写进导出日志。

### Phase B：双人舞台（对应问题 4）

- [x] `planPresence`：cast>=2 返回单个 `duo` 段覆盖全篇；cast==1 返回单个 `solo` 段。
- [x] `composeStory` 开场一次 `LayoutAppear` 两人（Left/Right），结尾 `LayoutClear` 两人；
      整场不再出现中途 Clear/Appear。
- [x] 听者反应在双人段内全部保留（不再受“仅发言段第一句”限制）。
- [x] 更新 `staged-writer.test.mjs`：appears=2、clears=2、所有 Talk action `at=0`、
      两个入场都带 motion。

### Phase C：Irodori 日语 TTS（对应问题 3）

- [x] 新增 `src/host/ai/ttsText.ts`：`isJapaneseText`、`collectTtsTargets`、
      `ensureJapaneseTtsText`（批量 20 条，保留已有日文，重译空/中文）。
- [x] `StoryWriter.translateTtsText` 复用该 helper，不再只补空串。
- [x] `VideoApiServer` 增加 `prepareStory` 钩子；`main.ts` 在 `tts.provider==='irodori'`
      时注入翻译器；无法补齐时返回 400 并列出缺失句号。
- [x] `TTSService.synthesizeSpeech` 对 Irodori 做日文校验：非日文直接失败，
      renderer 不会把中文送去合成。
- [x] 测试：中文/日文/混合判定、批量翻译、已有日文不重译、Irodori 拒绝中文。

### Phase D：极详细导出日志（对应“视频要写极其详细的日志”）

- [x] `ExportLogBus`：所有 `ExportLogger` 实例的日志进入同一个有序缓冲区。
- [x] `MotionTraceCollector`：记录每个 motion cue 的请求/加载/开始/打断时间、剪辑长度。
- [x] `ExportDiagnostics`：合并 story、timeline、实际时间戳、TTS、动作追踪、音频放置、
      日志与导出结果，输出 `schemaVersion`。
- [x] `VideoExportManager` 在 stream/fast/frames 三条路径结束时生成 diagnostics，
      随导出结果返回。
- [x] `VideoApiServer` 把 diagnostics 写到视频同目录：
      `<video>.log.json`（完整数据）与 `<video>.log`（人读摘要），响应带 `logPath`。
- [x] 摘要包含异常：时间线漂移 >250ms、入场无动作、动作在 400ms 内被打断、
      Irodori 句缺日文、TTS 时长与时间线不一致。

### Phase E：测试与文档

- [x] `scripts/renderer/action-timing.test.mjs`：动作在 at=0 立即触发；导出模式长帧不减速。
- [x] `scripts/renderer/layout-appear.test.mjs`：startMotions 先于 show/move；不等待整段剪辑。
- [x] 双人断言并入 `scripts/api/staged-writer.test.mjs`：双人单段、两人入场都有动作。
- [x] `scripts/renderer/story-preload.test.mjs`：入场/退场/台词/Motion 的动作全部预加载。
- [x] `scripts/renderer/motion-trace.test.mjs`：request/loaded/started/interrupted 与剪辑长度。
- [x] `scripts/renderer/timeline-layout.test.mjs`：入退场/状态片段时长与真实执行对齐。
- [x] `scripts/api/tts-japanese.test.mjs` + `scripts/renderer/tts-irodori-guard.test.mjs`：
      日文判定、批量翻译、Irodori 拒绝中文。
- [x] `scripts/renderer/export-diagnostics.test.mjs`、`export-log-bus.test.mjs`、
      `scripts/api/export-diagnostics.test.mjs`：日志总线、诊断构建、摘要、宿主写文件。
- [x] `scripts/renderer/moesekai-parity.test.mjs`：计划文档与全部行为测试文件的契约。
- [x] `scripts/stories/official-motion-parity.test.mjs`：官方 80.5% 动作在句首、
      单 motion 占 99.7%、0.5 秒默认淡化与 1~4 秒剪辑。
- [x] 实际导出 8 句双人短剧本，读取 `<video>.log.json` 验证每句/每个动作都有记录。
- [x] 更新 `doc/ai-script.md`、`doc/export-modes.md`、`doc/story-format.md`。

## 4. 验收标准

1. 所有 Talk/Motion 动作 cue 的 `at` 为 0；导出日志里同一动作的
   `startedAt - cueAt` 在 100ms 内（缓存命中）。
2. `LayoutAppear` 日志顺序：`motionStartedAt <= showStartedAt`，且入场只用
   400~800ms，不再出现 1.5~4 秒的 blocking wait。
3. 双人剧本：`LayoutAppear` 恰好 2 条、`LayoutClear` 恰好 2 条；两人都有入场 motion。
4. Irodori 导出：所有 Talk 的 `ttsText` 通过日文判定；构造中文 `ttsText` 时
   `TTSService` 抛错且不发送请求。
5. 每次导出生成 `.log.json` 与 `.log`；日志里能看到每句的
   planned/actual/drift、TTS 时长、动作请求/开始/打断、音频放置。
6. `npm test`、`npm run test:renderer`、`npm run test:stories` 全绿。

## 5. 关键文件

- `src/host/ai/staged.ts`：`planPresence`、`composeStory`、动作 `at`。
- `src/host/ai/ttsText.ts`（新）：日文判定与批量翻译。
- `src/host/servers/VideoApiServer.ts`：导出前 `prepareStory` 与日志落盘。
- `src/host/main.ts`：注入 Irodori 翻译器。
- `src/renderer/src/managers/AnimationManager.ts`：帧步进。
- `src/renderer/src/managers/StoryManager.ts`：动作预加载。
- `src/renderer/src/snippets/LayoutAppearSnippet.ts` / `LayoutClearSnippet.ts`。
- `src/renderer/src/model/AdvancedModel.ts`：动作追踪。
- `src/renderer/src/managers/VideoExportManager.ts`：诊断生成。
- `src/renderer/src/managers/video-export/ExportLogBus.ts`（新）。
- `src/renderer/src/managers/video-export/MotionTraceCollector.ts`（新）。
- `src/renderer/src/managers/video-export/ExportDiagnostics.ts`（新）。

## 6. 状态

- 2026-11-08：Phase A~E 全部实现并通过测试。
- 实导出验证（8 句双人、1920x1080/30fps、stream）：
  - 19 个 snippets、planned 36622ms、actual 36536ms、avgAbsDrift 58ms；
  - `LayoutAppear` 恰好 2 次、`LayoutClear` 恰好 2 次，两人开场同时在场；
  - 8 句 TTS 全部 `japanese=true`，总时长 27720ms；
  - motion trace 63 个事件 / 18 次 body 开始播放 / 1 次打断；
  - 日志：`apifile/export-1794086708245-qi8b8z.log` 与 `.log.json`，anomalies 为空。
- 入场帧抽检：1.3s 时瑞希半透明滑入且手臂已在动作；2.0s 两人同框且都在动作。
- 回归：`npm test` 83 项、`npm run test:renderer` 72 项、`npm run test:stories` 4 项全过；
  `npm run typecheck` 通过。
