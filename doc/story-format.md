# 故事文件格式（`*.sekai-story.json`）

[返回 README](../README.md) · [文档总览](README.md) · [API 参考](api.md) · [资源与音频配置](resources.md)

提交给 `/api/v1/export` 的故事 JSON 固定由三部分组成：`models`（声明本场用到的角色模型）、`images`（声明背景图）、`snippets`（按时间顺序执行的演出片段）。完整校验规则以 [src/common/types/Story.ts](../src/common/types/Story.ts) 为准。

## 最小完整示例

启用 `assets.cloudCatalog`（默认开启）时，直接填云端模型路径、中文地点名和 BGM id 就能直接导出：

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

## 顶层资源声明

| 字段                                               | 说明                                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `models[].id`                                      | 故事内部引用的唯一整数（注意不要写字符串）                                                                          |
| `models[].model`                                   | 本地相对于 `resources/models/` 的路径，或云端路径 / id / `角色名 服装`                                              |
| `models[].normal_scale` / `small_scale` / `anchor` | `Normal` 布局缩放（默认 `2.1`）、`Three` 布局缩放（默认 `1.8`）、纵向锚点（默认 `0.5`）                             |
| `models[].costumes`                                | 可选，`{ "校服": "..." }` 供 `CostumeChange` 换装                                                                   |
| `images[].id`                                      | 故事内部引用的整数背景 id                                                                                           |
| `images[].image`                                   | 本地相对于 `resources/images/` 的文件名，或云端 id（`bg_a000301`）/ 中文地点名（支持带时段如 `神山高校 天台·黄昏`） |

## 通用字段与最容易写错的单位

每个片段都要有 `type`、`delay`（默认 `0`）、可选 `wait`（boolean）或 `progressBehavior`（`'Now' | 'WaitFinished'`），以及除了 `HideTalk`、`StopShake`、`StopShakeScreen`、`StopShakeWindow` 之外的 `data`。

**千万别把秒和毫秒搞混**：

- **用秒**：片段外层的 `delay`、`Motion.data.duration`、`DoParam.data.params[].duration`。
- **用毫秒**：转场与特效里的 `data.duration`（`BlackOut`、`BlackIn`、`SideFade`、`Wipe`、`SekaiIn`、`FlashbackIn`、`SepiaIn`、`BlurIn`、`ShakeScreen` 等；黑场为了兼容旧数据，`< 10` 会按秒处理）。
- **`actions[].at`**：不是秒，而是当前这句台词正文时长的 `0..1` 比例（比如 `0` 表示句首）。
- **`from.offset` / `to.offset`**：以 **1920 宽**为基准的像素偏移。
- **`wait`**：`true`（或 `WaitFinished`）表示等这个片段转场完再走下一条；`false`（`Now`）表示立刻往下走（注意：**`Talk` 永远会阻塞等到说完**）。

---

## 支持的全部片段速查

### 舞台与角色控制

| `type`                  | 常用 `data` 字段                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `ChangeLayoutMode`      | `mode`: `'Normal' \| 'Three'`（注意首字母大写）                                                                                      |
| `ChangeBackgroundImage` | `imageId`（数字），可选 `duration`（ms）                                                                                             |
| `AmbientColor`          | `mode`: `'normal' \| 'evening' \| 'night'`                                                                                           |
| `LayoutAppear`          | `modelId`、`from`、`to`、`motion`、`facial`、`moveSpeed`（`Slow` / `Normal` / `Fast` / `Immediate`），可选 `facialFirst`、`hologram` |
| `LayoutClear`           | `modelId`、`from`、`to`、`moveSpeed`，可选 `motion`、`facial`                                                                        |
| `Move`                  | `modelId`、`from`、`to`、`moveSpeed`，可选 `motion`、`facial`、`facialFirst`                                                         |
| `LayoutDepth`           | `modelId`、`depth`: `'Front' \| 'Back' \| 'Reset'`                                                                                   |
| `CostumeChange`         | `modelId`、`costume`（模型路径或 `costumes` 键名）                                                                                   |
| `CharacterShake`        | `modelId`、`axis`: `'X' \| 'Y'`                                                                                                      |
| `Motion`                | `modelId`，`motion`、`facial`、`facialFirst`，可选 `duration`（秒）和 `actions[]`                                                    |
| `DoParam`               | `modelId`、`params[]`（`paramId`、`start`、`end`、`curve`: `'Linear'\|'Sine'\|'Cosine'`、`duration` 秒）                             |
| `Wait`                  | `duration`（秒）                                                                                                                     |

### 对白、字幕与分支

| `type`             | 常用 `data` 字段                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Talk`             | `speaker`、`content`，可选 `modelId`（`-1` 为旁白不张嘴）、`ttsText`（日语配音文案）、`emotion`（Irodori 情绪标签）、`motion`、`facial`、`actions[]`、`closeWindowOnFinish`、`effect`: `'Normal'\|'Internal'\|'Overlap'` |
| `HideTalk`         | 无 `data`，隐藏对话框（角色还在场上）                                                                                                                                                                                    |
| `Telop`            | `content`，居中章节/场景字幕（约 0.33s 淡入 + 2s 停留 + 0.33s 淡出）                                                                                                                                                     |
| `PlaceInfo`        | `text`，可选 `duration`（ms），左上角地点提示条                                                                                                                                                                          |
| `FullScreenText`   | `text`，可选 `voice`、`duration`（ms）、`keepBars`，黑边全屏独白                                                                                                                                                         |
| `SimpleSelectable` | `choices[]`，可选 `pickedIndex`，选项分支演出                                                                                                                                                                            |

### 转场、滤镜与镜头特效

| `type`                                          | 常用 `data` 字段                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `BlackOut` / `BlackIn`                          | `duration`（ms）、`color`: `'black' \| 'white'`                                          |
| `SideFade`                                      | `direction`: `'Left'\|'Right'\|'Top'\|'Bottom'`、`mode`: `'In'\|'Out'`、`duration`（ms） |
| `Wipe`                                          | `direction`: `'left'\|'right'`、`mode`: `'in'\|'out'`、`duration`（ms）                  |
| `SekaiIn` / `SekaiOut`                          | `duration`（ms）、`variant`: `'v1'\|'v2'`                                                |
| `FlashbackIn` / `FlashbackOut`                  | `duration`（ms）、`alpha`（默认 `0.3`）                                                  |
| `SepiaIn` / `SepiaOut` / `BlurIn` / `BlurOut`   | `duration`（ms）                                                                         |
| `BackgroundBlur`                                | `mode`: `'In'\|'Out'`、可选 `level`、`duration`                                          |
| `AttachCharacterShader`                         | `modelId`、`shader`: `'hologram' \| 'monitor' \| 'blur' \| 'none'`、可选 `level`         |
| `PlayScenarioEffect` / `StopScenarioEffect`     | `effectName`、可选 `duration`（ms）                                                      |
| `CameraMove` / `CameraZoom` / `DollyZoom`       | `x`/`y`/`scale`/`zoom`、`duration`（ms）、`ease`                                         |
| `ShakeScreen` / `StopShakeScreen`               | `duration`（ms，最大 30000）、`amplitude`                                                |
| `ShakeWindow` / `StopShakeWindow` / `StopShake` | 窗口抖动与停止                                                                           |
| `Movie`                                         | `file`、可选 `duration`（ms）                                                            |

### 音频

| `type`              | 常用 `data` 字段                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `ChangeBgm`         | `file`（曲名 / 云端 id / 相对路径）、`stop`（true 静音）、`fadeMs`（0~10000）、`volume`（0~2） |
| `BgmVolume`         | `volume`（0~2）、`duration`（ms）                                                              |
| `PlaySe` / `StopSe` | `file`（相对 `audio/se/` 或云端 cue）、`volume`（0~4）、`loop`、`fadeMs`                       |

---

## 舞台位置与进退场规律

可用槽位有 `Left`、`Center`、`Right`（画外起止点为 `LeftOver`、`RightOver`、`Under`）：

- `Normal` 模式（常规 1~2 人用）：`Left = 0.3177 × 宽`、`Center = 0.50 × 宽`、`Right = 0.6823 × 宽`。
- `Three` 模式（3 人同台用）：`Left = 0.2135 × 宽`、`Center = 0.50 × 宽`、`Right = 0.7865 × 宽`。

`moveSpeed` 对应移动时长：`Slow = 750ms`、`Normal = 500ms`、`Fast = 333.33ms`、`Immediate = 0ms`。

- `LayoutAppear` 的淡入只要约 **116.7ms**，入场动作与画外滑入在后台同步播完，不会卡住后面的对白；如果角色已经在场上再发一次 `LayoutAppear`，会平滑移位（200ms）而不重新闪现。
- 角色动作和 `face_*` 表情在播完后会定格在最后一帧，直到下一条动作/表情平滑淡化接管，并自动保留眨眼和眼球呼吸。

## 台词时长与口型怎么算

导出器完全按 60fps 帧基计算每句停留时间：

- 文字打字时间 = 可见字数 × `66.7ms`（4 帧/字）
- 有配音时：正文等到 `max(打字结束, TTS 实际音频 + 50ms, 阻塞动作收尾)`，再停 `500ms` 换句。
- 没配音时：打字完再停 `2000ms` 换句。
- 口型由真实音频 RMS 包络驱动；没有本句语音时不会乱张嘴，而是走无声文本步进。
