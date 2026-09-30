# story-format

[返回 README](../README.md) · [API 参考](api.md) · [资源与音频配置](resources.md)

故事文件格式：使用 `*.sekai-story.json`，由 `models`、`images`、`snippets` 三部分组成。
完整字段与片段定义见 [src/common/types/Story.ts](../src/common/types/Story.ts)。

本文导航：[完整示例](#完整结构示例) · [资源字段](#顶层资源路径与默认值) · [单位与顺序](#通用字段单位与导出顺序) · [全部片段](#支持的全部片段) · [舞台](#舞台位置布局与缩放) · [台词](#talk台词朗读与听者反应) · [口型与时长](#台词时长与口型) · [常见错误](#验证与常见错误)

## 完整结构示例

以下模型、背景、动作与表情名称仅用于说明格式，使用时应替换为已登记且真实存在的资源。

```json
{
  "models": [
    {
      "id": 1,
      "model": "20mizuki/20mizuki_normal/20mizuki_normal.model3.json",
      "normal_scale": 2.1,
      "small_scale": 1.8,
      "anchor": 0.5
    }
  ],
  "images": [{ "id": 1, "image": "bg_c000101.jpg" }],
  "snippets": [
    { "type": "ChangeLayoutMode", "wait": false, "delay": 0, "data": { "mode": "Normal" } },
    { "type": "BlackOut", "wait": true, "delay": 0, "data": { "duration": 500 } },
    { "type": "ChangeBackgroundImage", "wait": true, "delay": 0, "data": { "imageId": 1 } },
    { "type": "BlackIn", "wait": true, "delay": 0, "data": { "duration": 800 } },
    {
      "type": "LayoutAppear",
      "wait": true,
      "delay": 0,
      "data": {
        "modelId": 1,
        "from": { "side": "Left", "offset": -100 },
        "to": { "side": "Left", "offset": 0 },
        "motion": "w-normal-greeting01",
        "facial": "face_smile_01",
        "facialFirst": true,
        "moveSpeed": "Normal"
      }
    },
    {
      "type": "Talk",
      "wait": false,
      "delay": 0,
      "data": {
        "speaker": "晓山瑞希",
        "content": "你好！",
        "ttsText": "こんにちは！",
        "modelId": 1,
        "voice": ""
      }
    },
    { "type": "HideTalk", "wait": true, "delay": 0.2 },
    {
      "type": "LayoutClear",
      "wait": true,
      "delay": 0.1,
      "data": {
        "modelId": 1,
        "from": { "side": "Left", "offset": 0 },
        "to": { "side": "Left", "offset": -100 },
        "motion": "w-normal-nod01",
        "moveSpeed": "Normal"
      }
    },
    { "type": "BlackOut", "wait": true, "delay": 0, "data": { "duration": 600 } }
  ]
}
```

## 顶层、资源路径与默认值

顶层 `models`、`images`、`snippets` 都是必填数组；不使用时仍需写 `[]`，不会自动补齐。
`models` / `images` 声明资源，**不会使角色自动登场或背景自动显示**；片段通过对应 ID 引用。
本文除完整结构示例外，JSON 块均标明为“单片段”或“片段数组”，应放进完整故事的 `snippets`，不能直接当作故事提交。
所有模型路径、图片名、动作名、表情名和参数 ID 都是格式示意，不保证本地存在；请替换成实际可用值。

| 字段                    | 类型 / 默认值      | 含义                                                   |
| ----------------------- | ------------------ | ------------------------------------------------------ |
| `models[].id`           | 必填 number        | 故事内模型 ID；建议使用唯一整数，与 `modelId` 一致     |
| `models[].model`        | 必填 string        | 相对资源根 `models/` 的模型入口文件路径                |
| `models[].normal_scale` | number，默认 `2.1` | `Normal` 布局的模型缩放乘数，不是像素高度              |
| `models[].small_scale`  | number，默认 `1.8` | `Three` 布局的模型缩放乘数                             |
| `models[].anchor`       | number，默认 `0.5` | 模型纵向锚点；横向锚点固定 `0.5`，通常在 `0..1` 内调节 |
| `images[].id`           | 必填 number        | 故事内图片 ID；建议在图片数组内唯一                    |
| `images[].image`        | 必填 string        | 相对资源根 `images/` 的图片路径，无默认值              |

- 模型路径 `20mizuki/20mizuki_normal/20mizuki_normal.model3.json` 会请求 `/resources/models/20mizuki/20mizuki_normal/20mizuki_normal.model3.json`。
- 图片路径 `bg_c000101.jpg` 会请求 `/resources/images/bg_c000101.jpg`；两者均相对宿主资源根，不相对剧本文件目录。
- 宿主将资源根挂载到 `/resources/`。路径使用 `/`；不要填 Windows 绝对路径、完整 URL，或重复写 `models/`、`images/`、`resources/` 前缀。
- 模型引用的纹理、动作等配套文件也必须可访问。`motion` / `facial` 填模型支持的动作组名称，不填任意磁盘文件路径。
- 默认值只在字段缺失时补入，`null` 不表示“使用默认值”。Schema 不检查 ID 唯一性、资源存在性或模型是否支持动作。

## 通用字段、单位与导出顺序

每个片段必须有 `type`、`wait`、`delay`；除 `HideTalk` 外都必须有对应的 `data` 对象。

| 字段 / 单位                 | 规则                                                    |
| --------------------------- | ------------------------------------------------------- |
| `type`                      | 区分大小写，仅支持下表列出的 12 种片段                  |
| `wait`                      | 必填 boolean，不能写字符串 `"true"` 或 `"false"`        |
| `delay`                     | 必填 number，单位**秒**，片段开始前等待；无停顿时写 `0` |
| 黑场 `data.duration`        | 必填 number，单位**毫秒**，例如 `500` 表示半秒          |
| `DoParam.params[].duration` | 必填 number，单位**秒**，例如 `0.5` 表示半秒            |
| `Motion.data.duration`      | 仅定时动作序列使用，单位**秒**，省略按 `2` 秒执行       |
| `from.offset` / `to.offset` | 以 **1920 宽度为基准的像素单位**，不是百分比            |
| `actions[].at`              | 所在片段正文时长的 `0..1` 比例，不是秒数或百分数        |

API 的 record / fast 导出均按数组顺序 `await` 每个片段的执行，**`wait: false` 不是通用并发开关**。
例如 `Talk`、`Move`、`LayoutAppear`、黑场仍等待各自实现结束；`DoParam` 内部则在 `wait: false` 时启动参数动画后返回。
旧的非导出调度会读取 `wait` 决定是否等待，不能据此推断 API 导出行为。想在一句台词中同时演出，应使用 `Talk.actions`。
`delay` 在正文之前执行一次，不是上一段的尾停留；写在 `HideTalk` 上表示“先保留当前对话框，再隐藏”。
建议延迟和动画时长使用非负有限数，比例 / 秒 / 毫秒不要混用；除定时 `Motion` 外，Schema 并未给所有时长加正数约束。

## 支持的全部片段

以下均描述 `data` 字段；标“必填”的项没有 Schema 默认值。位置对象的 `side` 必填，`offset` 默认 `0`。

| `type`                  | `data` 字段、默认值与用途                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ChangeLayoutMode`      | `mode` 必填：`Normal` / `Three`；设置后续位置换算和登场缩放模式                                                         |
| `ChangeBackgroundImage` | `imageId` 必填 number；立即换成 `images` 中的图片，本身不做淡入淡出                                                     |
| `LayoutAppear`          | `modelId`、`from`、`to`、`motion`、`facial`、`moveSpeed` 必填；无动作可给空字符串；`facialFirst=true`、`hologram=false` |
| `LayoutClear`           | `modelId`、`from`、`to`、`moveSpeed` 必填；`motion=""`、`facial=""`；完成退场后移出模型层                               |
| `Move`                  | `modelId`、`from`、`to`、`moveSpeed` 必填；只移动，不负责登场或退场                                                     |
| `Motion`                | `modelId` 必填；`motion=""`、`facial=""`、`facialFirst=true`；可选 `actions`、`duration`，详见下文                      |
| `Talk`                  | `speaker`、`content` 必填 string；`modelId=-1`；`voice`、`ttsText`、`motion`、`facial` 默认 `""`；`actions` 可选        |
| `HideTalk`              | **没有 `data`**；隐藏对话框，不隐藏角色                                                                                 |
| `Telop`                 | `content` 必填 string；显示居中场景字幕；不支持自定义 `duration`                                                        |
| `BlackOut`              | `duration` 必填，毫秒；黑色遮罩淡入，画面变黑                                                                           |
| `BlackIn`               | `duration` 必填，毫秒；黑色遮罩淡出，露出场景                                                                           |
| `DoParam`               | `modelId`、`params` 必填；每项必填 `paramId`、`start`、`end`、`curve`、`duration`，详见下文                             |

## 舞台位置、布局与缩放

`side` 只接受 `Left`、`Center`、`Right`。默认布局为 `Normal`，槽位对应的横坐标如下。

| 布局     | Left            | Center | Right  | 缩放字段       |
| -------- | --------------- | ------ | ------ | -------------- |
| `Normal` | 画布宽度 × 0.30 | × 0.50 | × 0.70 | `normal_scale` |
| `Three`  | 画布宽度 × 0.25 | × 0.50 | × 0.75 | `small_scale`  |

实际横坐标为 `画布宽度 × (槽位比例 + offset / 1920)`；正偏移向右，负偏移向左。
例如 960 宽画布上的 `offset: 100` 只移动 50 像素；`-100` / `+100` 不保证模型已经在画外。
纵向槽位目前固定，模型定位时锚点落在画布高度的约 `0.8` 处；JSON 没有独立的 `x` / `y` 字段。
模型加入舞台时，最终 scale 为 `画布高度 / 模型原始高度 × 当前布局的缩放乘数`，可结合 `anchor` 调整取景。
`ChangeLayoutMode` 只改变模式，**不会立即移动或重新缩放已在场角色**；需要时先退场、切布局，再按新布局登场。
布局名称不限制角色数量；“两人同屏”等约束属于上层生成规则，渲染 API 不强制。

### 登场、退场与移动

`LayoutAppear` / `LayoutClear` 的 `from` 与 `to` 不同时滑动，相同时原地淡入 / 淡出。
`moveSpeed` 只有 `Slow`（700ms）、`Normal`（500ms）、`Fast`（300ms）、`Immediate`（0ms / 瞬移）。
这些是移动本身的时长，不等于整个片段时长：登场包含约 200ms 淡入，并等待指定入场动作 / 表情完成。
退场移动时淡出至少 400ms；原地退场约 300ms，退场动作与淡出 / 移动并行，不等动作完整播完再移除角色。
`hologram: true` 开启登场的全息及粒子效果。`facialFirst` 不是先后顺序开关，身体与表情并行启动；当前主要用于让身体动作避开眼部参数。
`Move` 的 `from` 是你提供的起点，不是自动读取当前位置；应与上一片段终点一致，否则可能跳位。

单片段示例：已登场的模型 1 从左槽位移动到中央，不换动作、不自动隐藏。

```json
{
  "type": "Move",
  "wait": true,
  "delay": 0,
  "data": {
    "modelId": 1,
    "from": { "side": "Left", "offset": 0 },
    "to": { "side": "Center", "offset": 0 },
    "moveSpeed": "Normal"
  }
}
```

## Talk：台词、朗读与听者反应

- `speaker` 是显示名称，也是 TTS 侧使用的角色名称；`modelId` 才决定关联哪个模型，二者不会自动互相推导。
- `content` 是屏幕显示文本；`ttsText` 非空时指定朗读文本，不改变字幕；为空时使用 `content` 合成。当前 API 导出关闭自动翻译，中日双语需显式填写 `ttsText` 并匹配 TTS 的 `textLang`。
- `modelId: -1` 表示不关联说话模型，可用于旁白；不会驱动角色口型，但不等于禁止 TTS，是否有声音仍取决于 TTS 配置。
- `voice` 是保留的预录语音字段。当前 API 导出不会因填写此字段就播放或混入预录音频；见 [预录语音字段](resources.md#预录语音字段)。
- 台词不会自动让模型登场；需要可见的说话者或听者时，先使用 `LayoutAppear`。
- 旧的 `Talk.data.motion` / `facial` 相当于句首动作，先于显式 `actions` 中同为 `at: 0` 的事件加入调度。

### actions 的完整约束

| 字段      | 规则                                                                        |
| --------- | --------------------------------------------------------------------------- |
| `at`      | 必填有限 number，`0 ≤ at ≤ 1`；触发时间为 `正文时长 × at`，不含前置 `delay` |
| `modelId` | 必填有限整数；可以是说话者，也可以是已经登场的听者                          |
| `motion`  | 可选非空 string，首尾空白会去掉；对应身体动作通道                           |
| `facial`  | 可选非空 string，首尾空白会去掉；对应表情通道                               |

每个事件至少含 `motion` 或 `facial`，不能只写时间和 ID；每个 `actions` 数组最多 24 项，可为空数组。
动作和表情独立更新：只写 `facial` 不清空身体动作，只写 `motion` 不重置听者表情；不需要的字段应省略，不写空字符串。
事件按 `at` 排序，相同时间按数组顺序派发；同一模型同一通道的后续事件可能覆盖前一个，不宜叠写冲突事件。
不可见模型的事件会跳过，不会令其登场，也不会在稍后登场时补播；缺失资源可能导致动作无效或加载失败。
调度等待的是正文结束，不是每个动作剪辑完整播放；`at: 1` 只保证安排末尾启动，不会额外预留播放整段动作的时间。
片段结束 / 取消会清理后续调度，已显示的姿态不会因此统一复位。需要看清反应时，应把事件安排得更早。

单片段示例：模型 1、2 已声明并登场，模型 2 作为听者在正文 40% 处改变表情。

```json
{
  "type": "Talk",
  "wait": true,
  "delay": 0,
  "data": {
    "speaker": "晓山瑞希",
    "modelId": 1,
    "content": "先别着急，听我慢慢说。",
    "actions": [
      { "at": 0, "modelId": 1, "motion": "w-normal-default01" },
      { "at": 0.4, "modelId": 2, "facial": "face_smile_01" },
      { "at": 0.7, "modelId": 1, "facial": "face_smile_01" }
    ]
  }
}
```

### 台词时长与口型

record 和 fast 共用以下正文预算；`length` 按 JavaScript 字符串长度（UTF-16 单元）计算，与逐字显示一致。

```text
文字显示时长 = content.length × 80ms
朗读时长 = 有效 TTS 的实际时长；否则用 (ttsText || content).length × 143ms
正文时长 = max(1800ms, max(文字显示时长, 朗读时长) + 600ms)
```

前置 `delay` 单独执行一次，不计入正文预算或重复追加；文字显示、动作调度与语音并行，600ms 句尾停留只计算一次。
例如 20 个 UTF-16 单元的正文、无额外 `ttsText` 时，无声预算为 3460ms；配 2860ms 语音也是 3460ms，配 4000ms 语音为 4600ms。
规则一致不代表文字估算与任意声线、语速的真实音频逐毫秒一致；首次对话框淡入、帧步进等也会影响实际观测时间。
导出口型只在本句存在有效音频包络、关联模型有效且可见时驱动，按真实音频能量采样，不按文字字数强制开合。
TTS 关闭、合成失败或包络不可用时，不用文本生成模拟说话口型；自然表情张嘴和身体动作不受此限制。
听者的 `actions` 不会把说话者的语音口型转移给听者；正文结束时会停止本句的口型驱动。

## Motion：独立动作与无声序列

不写 `actions` 时为旧式动作片段：播放 `motion` / `facial`、等待完成并处理最后一帧；`duration` 不用于裁剪动作。
提供 `actions`（包括 `[]`）时为定时序列：`duration` 必须为有限正数且不超过 120 秒，省略时运行 2 秒。
可同时写旧式 `motion` / `facial`，作为 `data.modelId` 的 `at: 0` 事件；此模式不使用 `facialFirst` 来安排播放先后。
事件字段及可见性规则与 `Talk.actions` 一致；`data.modelId` 仍必填且应引用有效模型，不能仅靠事件中的 ID 替代。
序列不负责显隐。建议始终先登场，再播放动作；`actions: []` 且不设句首动作时可保留画面等待指定秒数。

单片段示例：模型 1 已在场，用 3 秒无声表演安排动作与表情。

```json
{
  "type": "Motion",
  "wait": true,
  "delay": 0,
  "data": {
    "modelId": 1,
    "duration": 3,
    "actions": [
      { "at": 0, "modelId": 1, "motion": "w-normal-nod01" },
      { "at": 0.6, "modelId": 1, "facial": "face_smile_01" }
    ]
  }
}
```

## DoParam：直接控制模型参数

`params` 中每项的 `paramId` 是模型真实参数 ID；`start`、`end` 为该参数的原始数值，不统一是角度、像素或 `0..1`。
`curve` 只接受 `Linear`（线性）、`Sine`（正弦缓出）、`Cosine`（余弦缓入缓出）；`duration` 单位是秒。
同一片段所有参数动画同时启动；`wait: true` 等待它们全部结束，`false` 允许这些参数动画在后续片段执行期间继续。
Schema 不检查参数是否存在或数值是否在模型范围内；动作、表情、物理和口型更新也可能覆盖同一参数，避免同时争用。

单片段示例：假设模型 1 支持 `ParamAngleX`，在 0.5 秒内把参数从 0 改为 10。

```json
{
  "type": "DoParam",
  "wait": true,
  "delay": 0,
  "data": {
    "modelId": 1,
    "params": [
      { "paramId": "ParamAngleX", "start": 0, "end": 10, "curve": "Cosine", "duration": 0.5 }
    ]
  }
}
```

## 背景、黑场与 Telop 转场

`BlackOut` 是“变黑”，`BlackIn` 是“从黑场露出画面”；不要根据英文名称反向理解。
黑场只控制遮罩，不清除角色、背景或台词；换场需要换角时仍应显式退场。背景切换本身为立即替换，可放在黑场内避免硬切。
`Telop` 是居中场景字幕，不是 `Talk`：当前固定淡入 200ms、停留 2000ms、淡出 200ms，不生成 TTS，也没有可配置的停留字段。
它不会自动隐藏对话框；黑场遮罩位于字幕上方，想显示场景字幕应先 `BlackIn`。

下面是**片段数组**，不是完整故事；依次插入 `snippets`。图片 1 必须已在 `images` 声明且文件存在。

```json
[
  { "type": "HideTalk", "wait": true, "delay": 0.2 },
  { "type": "BlackOut", "wait": true, "delay": 0, "data": { "duration": 500 } },
  { "type": "ChangeBackgroundImage", "wait": true, "delay": 0.2, "data": { "imageId": 1 } },
  { "type": "BlackIn", "wait": true, "delay": 0, "data": { "duration": 500 } },
  { "type": "Telop", "wait": true, "delay": 0, "data": { "content": "翌日，放学后的教室" } }
]
```

## 验证与常见错误

以 [StorySchema](../src/common/types/Story.ts) 为格式准绳；API 格式校验失败返回 HTTP 400，消息为 `Invalid story data format.`，`details` 中包含字段路径。
完整示例可直接交给 `StorySchema.parse`；单片段先装入 `snippets: [片段]`，片段数组直接用作 `snippets`，再与 `models`、`images` 组成故事对象。
仅验证结构时两个资源数组可以为空；真正导出前必须补齐被引用资源并安排登场。**Schema 通过不等于可完成渲染。**

| 现象 / 易错项                                               | 检查方法                                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| 缺少 `wait`、`delay`、顶层数组或必要 `data`                 | 三个通用字段没有默认值；`HideTalk` 除外，其余片段需 `data`                 |
| `Left` 写成 `left`，速度写 `Medium`                         | 枚举区分大小写；布局、方向、速度和曲线只能使用本文列出的值                 |
| 数字写成字符串、用 `null` 请求默认值                        | ID、时长、偏移必须是 number；有默认值的字段应省略而非设为 `null`           |
| 登场省略 `motion` / `facial`                                | `LayoutAppear` 两项必填，可写 `""`；不要套用 `Motion` 的默认规则           |
| 事件 `at: 40`、只含 `at` 和 ID、动作名为空                  | `at` 应写 `0.4`；至少一个非空动作 / 表情；事件 ID 要求整数，最多 24 项     |
| `Motion.duration` 为 0、负数或大于 120                      | 该字段只接受有限正数且最多 120；不写 `actions` 时也不会按它延长动作        |
| 加入 `Wait`、`Pause`、`Transition` 或 `PlayAudio` 片段      | 当前 Schema 不支持；停顿用前置 `delay` 或有有效模型的空动作序列            |
| 自定义字段似乎被忽略                                        | Zod 对象默认去除未知字段；通过校验不代表拼错的字段或自加 `duration` 会生效 |
| `Model with id … not found` / `Texture with id … not found` | 引用未声明；重复 ID 不会报 Schema 错误，但查找只取第一个，应避免           |
| 资源加载失败、动作未生效、听者没反应                        | 检查路径前缀、资源实际存在性、动作组名和登场状态；不可见动作事件会跳过     |
| 500 秒长停顿、黑屏不恢复或人物跳位                          | 分别检查秒 / 毫秒混用、是否缺 `BlackIn`、`Move.from` 是否接上上一位置      |

AstrBot 插件可能对人物数量、登退场顺序及动作事件施加更严格校验；不要把插件生成约束当成渲染 Schema 的全部规则。
