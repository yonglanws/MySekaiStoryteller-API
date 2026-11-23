# story-format

[返回 README](../README.md) · [文档索引](README.md) · [API 参考](api.md) · [资源与音频配置](resources.md) · [云端资源获取](cloud-assets.md)

故事文件使用 `*.sekai-story.json`，由 `models`、`images`、`snippets` 三部分组成。
完整字段校验与 TypeScript 类型定义以 [src/common/types/Story.ts](../src/common/types/Story.ts) 为准。

本文导航：[完整示例](#完整结构示例) · [顶层资源与云端引用](#顶层资源路径与云端引用) · [通用字段与单位](#通用字段单位与调度顺序) · [支持的全部片段](#支持的全部片段) · [舞台布局与进退场](#舞台位置布局与进退场) · [Talk 与动作事件](#talk台词朗读与听者反应) · [台词时长与口型](#台词时长与口型) · [BGM 切换](#bgm-切换) · [验证与常见错误](#验证与常见错误)

## 完整结构示例

以下为可提交给 `/api/v1/export` 的完整故事结构示例。启用 `assets.cloudCatalog`（默认开启）时，直接填写云端模型路径、中文地点名背景（含时段）和官方 BGM 曲名/id 即可导出，无需预先下载任何本地素材：

```json
{
  "models": [
    {
      "id": 1,
      "model": "cloud/20mizuki_normal/20mizuki_normal_3.0_t04/20mizuki_normal_3.0_t04.model3.json",
      "normal_scale": 2.1,
      "small_scale": 1.8,
      "anchor": 0.5
    }
  ],
  "images": [{ "id": 1, "image": "神山高校 天台·黄昏" }],
  "snippets": [
    {
      "type": "ChangeBgm",
      "wait": false,
      "delay": 0,
      "data": { "file": "bgm00003", "fadeMs": 600 }
    },
    { "type": "ChangeLayoutMode", "wait": false, "delay": 0, "data": { "mode": "Normal" } },
    { "type": "BlackOut", "wait": true, "delay": 0, "data": { "duration": 500, "color": "black" } },
    { "type": "ChangeBackgroundImage", "wait": false, "delay": 0, "data": { "imageId": 1 } },
    { "type": "AmbientColor", "wait": false, "delay": 0, "data": { "mode": "evening" } },
    { "type": "BlackIn", "wait": true, "delay": 0, "data": { "duration": 600, "color": "black" } },
    {
      "type": "LayoutAppear",
      "wait": true,
      "delay": 0,
      "data": {
        "modelId": 1,
        "from": { "side": "Center", "offset": 0 },
        "to": { "side": "Center", "offset": 0 },
        "motion": "w-normal-greeting01",
        "facial": "face_smile_01",
        "facialFirst": true,
        "moveSpeed": "Normal"
      }
    },
    {
      "type": "Talk",
      "wait": true,
      "delay": 0,
      "data": {
        "speaker": "晓山瑞希",
        "content": "放学后的天台风还真舒服啊！",
        "ttsText": "放課後の屋上って、風が気持ちいいね！",
        "emotion": "开心",
        "modelId": 1,
        "closeWindowOnFinish": true
      }
    },
    {
      "type": "LayoutClear",
      "wait": true,
      "delay": 0,
      "data": {
        "modelId": 1,
        "from": { "side": "Center", "offset": 0 },
        "to": { "side": "Center", "offset": 0 },
        "motion": "w-normal-nod01",
        "moveSpeed": "Normal"
      }
    },
    { "type": "BlackOut", "wait": true, "delay": 0, "data": { "duration": 600, "color": "black" } }
  ]
}
```

## 顶层、资源路径与云端引用

顶层 `models`、`images`、`snippets` 均为必填数组。`models` 与 `images` 只做资源声明，片段通过数字 ID 引用。

| 字段                    | 类型 / 默认值                 | 含义                                                            |
| ----------------------- | ----------------------------- | --------------------------------------------------------------- |
| `models[].id`           | 必填 number                   | 故事内模型 ID，唯一整数                                         |
| `models[].model`        | 必填 string                   | 相对 `resources/models/` 的路径，或云端模型路径/id/角色服装标签 |
| `models[].normal_scale` | number，默认 `2.1`            | `Normal` 布局缩放乘数                                           |
| `models[].small_scale`  | number，默认 `1.8`            | `Three` 布局缩放乘数                                            |
| `models[].anchor`       | number，默认 `0.5`            | 模型纵向锚点（`0..1`）                                          |
| `models[].costumes`     | 可选 `Record<string, string>` | 换装映射表（供 `CostumeChange` 使用）                           |
| `images[].id`           | 必填 number                   | 故事内背景 ID                                                   |
| `images[].image`        | 必填 string                   | 相对 `resources/images/` 的文件名、云端 id 或中文地点名         |

### 云端引用自动解析

启用 `assets.cloudCatalog`（默认开启）时，宿主在导出前自动把以下云端引用物化到 `resources/*/cloud/` 并改写为相对路径（**本地已有同名文件永远优先**）：

- **模型**：`cloud/<模型id>/<变体>/<model3.json>`、云端模型 id（如 `01ichika_school`）、或 `角色名 服装`（覆盖 26 位主角色多服装 + 48 位配角，共 511 套模型）。
- **背景**：云端 id（如 `bg_a000301`）、可读中文名与别名（如 `教室`、`司の部屋`）、或带时段消歧的名称（如 `神山高校 天台·黄昏`、`教室（夜晚）`），全量覆盖 1,401 张背景。
- **BGM**：`ChangeBgm.data.file` 支持官方曲名（如 `Slapstick!!`）、云端 id（`bgm00003`、`normal_area`）或 `cloud/<id>.mp3`，覆盖 421 首剧情与区域 BGM。
- **SE**：`PlaySe` / `StopSe` 支持云端 cue id（如 `se00053_b.mp3`、`se_walk_women_001_1.mp3`）或语义标签，覆盖 1,942 条场景音效。

## 通用字段、单位与调度顺序

每个片段包含 `type`、`delay`（默认 `0`，单位**秒**）、可选 `wait`（boolean）与 `progressBehavior`（`'Now' | 'WaitFinished'`），除 `HideTalk`、`StopShake`、`StopShakeScreen`、`StopShakeWindow` 外均带 `data`。

| 字段 / 单位                        | 规则                                                                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delay`                            | 片段开始前等待的**秒**数；无停顿写 `0`                                                                                                                      |
| 遮罩/转场 `data.duration`          | `BlackOut` / `BlackIn` / `SideFade` / `Wipe` / `FlashbackIn` / `SepiaIn` / `SekaiIn` / `ShakeScreen` 等为**毫秒**（为兼容旧数据，黑场 `< 10` 的值按秒解释） |
| `DoParam` / `Motion` 的 `duration` | 单位为**秒**；`Motion` 定时序列上限 120 秒，省略默认 2 秒                                                                                                   |
| `from.offset` / `to.offset`        | 以 **1920 宽度为基准的像素偏移**                                                                                                                            |
| `actions[].at`                     | 所在片段正文时长的 `0..1` 比例                                                                                                                              |
| `wait` / `progressBehavior`        | `wait: true`（或 `progressBehavior: 'WaitFinished'`）等待片段完成；`wait: false`（`Now`）立刻推进下一条。**`Talk` 始终按阻塞串行执行**                      |

## 支持的全部片段

完整校验规则以 [Story.ts](../src/common/types/Story.ts) 为准，按功能分组如下：

### 舞台、背景与角色控制

| `type`                  | 主要 `data` 字段与说明                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `ChangeLayoutMode`      | `mode`: `'Normal' \| 'Three'`                                                                                                             |
| `ChangeBackgroundImage` | `imageId`（number），可选 `duration`（ms）；立即切换背景                                                                                  |
| `AmbientColor`          | `mode`: `'normal' \| 'evening' \| 'night'`；角色环境色滤镜                                                                                |
| `LayoutAppear`          | `modelId`、`from`、`to`、`motion`、`facial`、`moveSpeed`（`Slow`/`Normal`/`Fast`/`Immediate`），可选 `facialFirst=true`、`hologram=false` |
| `LayoutClear`           | `modelId`、`from`、`to`、`moveSpeed`，可选 `motion=""`、`facial=""`                                                                       |
| `Move`                  | `modelId`、`from`、`to`、`moveSpeed`，可选 `motion=""`、`facial=""`、`facialFirst=true`                                                   |
| `LayoutDepth`           | `modelId`、`depth`: `'Front' \| 'Back' \| 'Reset'`                                                                                        |
| `CostumeChange`         | `modelId`、`costume`（模型路径或 `models[].costumes` 键名）                                                                               |
| `CharacterShake`        | `modelId`、`axis`: `'X' \| 'Y'`                                                                                                           |
| `Motion`                | `modelId`，`motion=""`、`facial=""`、`facialFirst=true`，可选 `duration`（秒）与 `actions[]`                                              |
| `DoParam`               | `modelId`、`params[]`（`paramId`、`start`、`end`、`curve`: `'Linear'\|'Sine'\|'Cosine'`、`duration` 秒）                                  |

### 对白、标题与交互

| `type`             | 主要 `data` 字段与说明                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Talk`             | `speaker`、`content`，`modelId=-1`、`voice=""`、`ttsText=""`、`emotion=""`、`motion=""`、`facial=""`、可选 `actions[]`、`closeWindowOnFinish`、`effect`: `'Normal'\|'Internal'\|'Overlap'` |
| `HideTalk`         | 无 `data`；隐藏对话框（不隐藏角色）                                                                                                                                                        |
| `Telop`            | `content`；居中场景字幕（官方 0.333s 淡入 + 2s 停留 + 0.333s 淡出）                                                                                                                        |
| `PlaceInfo`        | `text`，可选 `duration`（ms）；左上角地点信息条                                                                                                                                            |
| `FullScreenText`   | `text`，可选 `voice`、`duration`（ms）、`keepBars`；黑边全屏独白                                                                                                                           |
| `SimpleSelectable` | `choices[]`，可选 `pickedIndex`；选项分支演出                                                                                                                                              |

### 转场、滤镜、运镜与特效

| `type`                                      | 主要 `data` 字段与说明                                                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `BlackOut` / `BlackIn`                      | `duration`（ms）、`color`: `'black' \| 'white'`（默认 `'black'`）                                                     |
| `SideFade`                                  | `direction`: `'Left'\|'Right'\|'Top'\|'Bottom'`（兼容旧 `edge`）、`mode`: `'In'\|'Out'`（兼容小写）、`duration`（ms） |
| `Wipe`                                      | `direction`: `'left'\|'right'`、`mode`: `'in'\|'out'`、`duration`（ms）                                               |
| `SekaiIn` / `SekaiOut`                      | 可选 `duration`（ms）、`variant`: `'v1'\|'v2'`（出入 SEKAI 三角粒子转场）                                             |
| `FlashbackIn` / `FlashbackOut`              | `duration`（ms，默认 100）、`alpha`（默认 0.3）                                                                       |
| `SepiaIn` / `SepiaOut`                      | 可选 `duration`（ms）                                                                                                 |
| `BlurIn` / `BlurOut`                        | `duration`（ms）                                                                                                      |
| `BackgroundBlur`                            | `mode`: `'In'\|'Out'`、可选 `level`、`duration`（兼容旧 `enabled: boolean`）                                          |
| `AttachCharacterShader`                     | `modelId`、`shader`: `'hologram' \| 'monitor' \| 'blur' \| 'none'`，可选 `level`                                      |
| `PlayScenarioEffect` / `StopScenarioEffect` | `effectName`、可选 `duration`（ms）                                                                                   |
| `CameraMove`                                | `x`、`y`（1920×1080 舞台像素偏移）、`duration`（ms）、`ease`                                                          |
| `CameraZoom`                                | `scale`（>0，≤5）、`duration`（ms）、`ease`                                                                           |
| `DollyZoom`                                 | `duration`（ms）、`zoom`（>0，≤10）、`ease`                                                                           |
| `ShakeScreen` / `StopShakeScreen`           | `duration`（ms，最大 30000）、`amplitude`（默认 `0.01`）；`StopShakeScreen` 立即停止                                  |
| `ShakeWindow` / `StopShakeWindow`           | 可选 `duration`（ms）、`intensity`；`StopShakeWindow` 立即停止                                                        |
| `StopShake`                                 | 无 `data`；同时停止屏幕与窗口抖动                                                                                     |
| `Movie`                                     | `file`，可选 `duration`（ms）                                                                                         |

### 音频

| `type`      | 主要 `data` 字段与说明                                                                 |
| ----------- | -------------------------------------------------------------------------------------- |
| `ChangeBgm` | `file`（曲名/id/相对路径）、`stop=false`、`fadeMs=600`（0..10000）、`volume=1`（0..2） |
| `BgmVolume` | `volume`（0..2）、`duration`（ms）                                                     |
| `PlaySe`    | `file`（相对 `audio/se/` 或云端 cue）、`volume=1`（0..4）、`loop=false`、`fadeMs=0`    |
| `StopSe`    | `file`、`fadeMs=0`                                                                     |

## 舞台位置、布局与进退场

`side` 支持 `Left`、`Center`、`Right`（以及画外位置 `LeftOver`、`RightOver`、`Under`）。

| 布局     | Left               | Center | Right              | 缩放字段       |
| -------- | ------------------ | ------ | ------------------ | -------------- |
| `Normal` | 画布宽 × 0.3177083 | × 0.50 | 画布宽 × 0.6822917 | `normal_scale` |
| `Three`  | 画布宽 × 0.2135417 | × 0.50 | 画布宽 × 0.7864583 | `small_scale`  |

实际横坐标为 `画布宽度 × (槽位比例 + offset / 1920)`。

### 官方进退场与 `Normal` 模式交叉淡化

- `moveSpeed` 对应时长：`Slow` 750ms、`Normal` 500ms、`Fast` 333.33ms、`Immediate` 0ms。
- **`LayoutAppear`**：AI 生成剧本默认画外滑入（Left/Right 槽 `from` 写同侧 `LeftOver`/`RightOver` 且 `offset: 0`、`to` 写槽位、`moveSpeed Normal`；Center 槽保持原地淡入），显式原地淡入（`from == to, offset: 0`）保留给飘现/传送类演出（Center 槽滑入方向为待观感确认的后续项）。入场动作在 `alpha=0` 时预先启动，淡入仅约 **116.7ms**（1 帧 alpha=0 + 6 帧 100ms 淡入），动作与位移在后台继续播放不阻塞对白；同一角色已在场再次 `LayoutAppear` 时执行 200ms 移动而不重新淡入。30fps 导出模式下角色淡入平滑到 200ms，与官方 60fps 100ms 渐变逐帧步进等价（每帧 alpha 步进同为 1/6）。注：「预览只等淡入、滑入后台完成」与「官方 FadeOpacity 线性无缓动」两条官方口径转述自早期勘察材料，本仓库未独立核对 sse-web 源码；30fps 与 60fps 逐帧步进等价为算术事实（两侧均 6 帧、每帧 alpha 步进 1/6）。
- **`LayoutClear`**：退场默认原地淡出（0.15s 延迟 + 0.1s 淡出，共 250ms）；走入/走离才显式滑动退场（移动时长并在 `move - 0.1s` 时淡出）。
- **AI 生成模式的 `Normal(<=2)` 轮换**：宿主内置 AI 在生成 3~5 人团体剧本时，全片保持 `Normal` 模式（最多 2 人同台），通过成对的 `LayoutClear`（原地淡出）+ `LayoutAppear`（画外滑入）交叠轮换上场，匹配官方 `pjsk.moe` 演出效果。

## Talk：台词、朗读与听者反应

- `speaker` 用于屏幕显示与 TTS 角色音色匹配；`modelId` 指定绑定口型的 Live2D 模型（`-1` 为旁白，不驱动口型）。
- `content` 为字幕显示文本；`ttsText` 为实际送往 TTS 的文本（缺省时使用 `content`）；`emotion` 仅影响 IrodoriTTS 情绪音色选择。
- `actions[]` 最多 24 项，每项须指定 `at`（`0..1`）、`modelId`（仅对已在场模型生效）及至少一个 `motion` 或 `facial`。动作与表情通道独立更新，省略不需要的字段即可，不要写空串（`bakeStoryPlan` 亦会忽略全空的动作/表情条目）。
- 运行时非循环身体动作与 v2 `face_*` 表情会在播完后保持末帧定格直到下一条 cue 交叉淡化，并自动隔离 `ParamEyeball*` / `ParamEyeBall*` 与通道 1 表情参数，保持自动眨眼（`wakeBlink`）活跃。

## 台词时长与口型

所有导出模式共用官方 60fps 帧基预算（`\n` 折行不计入字数）：

```text
文字显示时长 = visibleLength(content) × 66.7ms（官方 4 帧/字）
朗读结束     = TTS 实际时长 + 50ms
正文结束     = max(文字显示时长, 朗读结束, 动作收尾) + 500ms（有语音）
             = 文字显示时长 + 2000ms（无语音）
```

首次发言或 `HideTalk` / `closeWindowOnFinish` 后的首句会先播放 0.2s 对话框打开动画（只推迟打字，不推迟语音）。导出口型按官方 RMS/pow 曲线由真实音频包络驱动；无有效语音包络时退回官方 `LipLevels` 文本口型。

## BGM 切换

- 当故事中出现带文件的 `ChangeBgm` 时，不再混入全局默认 BGM（`bgm.yaml` / `bgm00003`），改为按时间线播放剧本内的 `ChangeBgm`、交叉淡化及 `stop: true` 静音。
- 启用云端目录时，`data.file` 可直接写曲名（如 `Slapstick!!`）或云端 id（如 `bgm00003`、`normal_area`）。

## 验证与常见错误

| 易错点                                  | 说明                                                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 枚举大小写错误                          | `Normal`/`Three`、`Left`/`Center`/`Right`、`Slow`/`Normal`/`Fast`/`Immediate` 均区分大小写                                  |
| 秒与毫秒混用                            | `delay`、`Motion.duration`、`DoParam.duration` 用**秒**；`BlackOut`/`SideFade`/`SekaiIn`/`Camera*` 的 `duration` 用**毫秒** |
| 未登场先说话或 `Move` 跳位              | 需要可见角色先发 `LayoutAppear`；`Move.from` 需衔接角色当前位置                                                             |
| `LayoutAppear` 缺少 `motion` / `facial` | 两项在 Schema 中必填，无动作时传 `""`                                                                                       |
| 外部剧本未配日文 `ttsText`              | 启用 IrodoriTTS 时，直接提交 `/api/v1/export` 需带日文 `ttsText`（或开启 `llm` 让宿主自动补翻）                             |
