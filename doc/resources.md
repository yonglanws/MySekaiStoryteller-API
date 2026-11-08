# 资源与音频配置

[返回 README](../README.md) · [故事文件格式](story-format.md) · [部署指南](host-deployment.md) · [云端资源获取](cloud-assets.md)

本文导航：[资源目录](#资源目录) · [模型与背景登记](#模型与背景登记) · [TTS 配音](#tts-配音) · [IrodoriTTS](#irodoritts) · [情绪标签](#情绪标签) · [BGM](#bgm)

本文说明资源登记、路径和音频配置。仓库不附带模型、背景、语音、BGM 或示例剧本；没有现成模型、背景或 BGM 时可用 [云端资源获取](cloud-assets.md) 从 Moesekai 拉取。下列文件名、角色名和服务端路径均为占位示例，必须替换为你已有资源的真实值。

启用云端目录（`assets.cloudCatalog`，默认开启）后，`models.yaml` / `images.yaml` / `bgm.yaml`
都是**可选覆盖**：不写也能从云端目录获得 26 位角色模型、官方剧情地点名背景与官方曲名 BGM；
本地文件仍然优先。按需下载的资源落在 `resources/{models,images,audio}/cloud/`。

## 资源目录

```text
resources/                        默认资源根
├─ models/models.yaml             模型登记表（可选；云端目录可完全替代）
├─ models/<角色>/<变体>/           model3.json、纹理、motions/ 等模型包内容
├─ models/cloud/                  云端按需下载的模型（可删）
├─ images/images.yaml             背景描述表（可选）；图片放 images/ 直属目录
├─ images/cloud/                  云端按需下载的背景（可删）
├─ voices/                        预录语音；当前 API 视频导出不混入 voice
├─ audio/bgm/bgm.yaml              独立 BGM 设置（可选）
├─ audio/bgm/soundtracks.json      fetch:media / 云端目录生成的官方曲名缓存（可删）
├─ audio/bgm/                     BGM 音频文件
├─ audio/bgm/cloud/               云端按需下载的 BGM（可删）
├─ audio/se/cloud/                云端按需下载的 SE（可删）
└─ stories/                       *.sekai-story.json 故事文件
```

### 路径以哪里为基准

| 配置或字段                               | 基准与正确形式                                                       |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `paths.resources`                        | 相对宿主识别的仓库根，默认 `resources`；也支持宿主磁盘绝对路径       |
| `MSS_RESOURCE_DIR`                       | 覆盖 `paths.resources`，再按同样规则解析                             |
| `models.yaml` 的 `path`                  | 相对实际资源根的 `models/`，如 `example/normal/example.model3.json`  |
| `images.yaml` 的 `file`                  | 相对实际资源根的 `images/`，如 `room_day.jpg`                        |
| 故事 `images[].image` 的云端写法         | 云端 id `bg_a000301` 或官方地点名 `教室`；导出前落到 `images/cloud/` |
| 故事 `models[].model` 的云端写法         | `cloud/<模型 id>/<变体>/<model3.json>`；导出前落到 `models/cloud/`   |
| 故事 `models[].model` / `images[].image` | 分别相对 `models/` / `images/`，不是把完整磁盘路径写进故事           |
| `bgm.path`                               | 浏览器 URL 或资源根相对路径，具体限制见 BGM 节                       |
| TTS 参考音频、权重路径                   | GPT-SoVITS 服务所在机器的文件路径，不以资源根为基准                  |

宿主先从编译产物位置推导仓库根，失败时才回退到进程工作目录。改资源根后，继续使用的本地清单也要放到新根对应位置；云端物化同样写进新根。
静态 URL 始终是 `/resources/…`，不会因为磁盘目录改名而改变。路径建议用 `/`，大小写与真实文件一致。
资源根会被静态托管，不要把密钥、私密配置或不希望公开的文件放进去；不入 Git 不等于不会通过 HTTP 暴露。

公开模板与正式文件对应如下，`.example.yaml` 本身不会自动成为正式配置。

| 公开模板                                                       | 实际资源根内的正式文件 |
| -------------------------------------------------------------- | ---------------------- |
| [models.example.yaml](../resources/models/models.example.yaml) | `models/models.yaml`   |
| [images.example.yaml](../resources/images/images.example.yaml) | `images/images.yaml`   |
| [bgm.example.yaml](../resources/audio/bgm/bgm.example.yaml)    | `audio/bgm/bgm.yaml`   |

## 模型与背景登记

### 模型清单

以下是 **完整 `models/models.yaml` 示例**，不是 `config.yaml` 片段，也不是故事 JSON。

```yaml
models:
  - id: 1
    name: 示例角色
    shortName: 小示
    path: example/normal/example.model3.json
  - id: 2
    name: 另一位角色
    shortName: 小另
    path: another/normal/another.model3.json
```

- `id` 是数值，应全表唯一，供故事 `modelId` 使用；当前目录构建仅检查有限数值，不替你排除重复 ID。
- `name` 是角色全名；`shortName` 可省略，目录输出会回退到 `name`，也用于 TTS 短名别名展开。
- `path` 指向实际模型入口文件，不是模型目录；不要再加 `resources/models/` 前缀。
- 模型包的纹理、动作等引用关系仍由模型文件决定；只登记入口不等于检查完整模型包。
- 动作与表情从 `FileReferences.Motions` 的键枚举：`face_` 开头归为表情，其余归为动作。
  目录构建还会把同级 `motions/` 下缺失索引的 `*.motion3.json` 补入并尝试回写模型文件。
  只读目录可能造成“目录里有动作、模型入口未更新”，应提前维护完整索引，不依赖运行时回写。
- 默认动作优先 `w-normal-default01`、`w-normal-greeting01`、`w-normal-nod01`；默认表情优先 `face_smile_01`。
  均不存在时取排序后的首项，空列表则为空字符串；不要把某个模型的动作名硬套到其他模型。

### 背景清单

以下是 **完整 `images/images.yaml` 示例**。

```yaml
images:
  - file: room_day.jpg
    name: 房间·白天
    description: 日光照入的室内场景，适合日常交谈
  - file: room_night.png
    name: 房间·夜晚
    description: 灯光柔和的室内场景，适合安静的独白
```

`file` 必须与磁盘文件名一致；`name` 省略时用文件名，`description` 省略时为空字符串。
目录扫描只枚举直属文件，不递归子目录：图片支持 `.jpg/.jpeg/.png/.webp`，
`voices/` 与 `audio/bgm/` 音频支持 `.mp3/.wav/.ogg/.flac`（扩展名不区分大小写）。
未登记但存在的图片仍出现在 `images` 列表并可被引用，只是没有选图描述；登记了但不存在的图片会被跳过。

云端目录会额外提供约一百个带官方地点名的背景（如 `教室`、`司の部屋`、`神山高校 屋上`）。
`GET /api/v1/resources` 的 `imageDetails` 里 `source: "cloud"` 的条目就是它们；剧本与 AI
既可以写 `file`，也可以写 `id` 或 `name`。同名背景（多个「屋上」）按 id 排序取第一张，
需要精确控制时写 id。没有地点名的云端背景仍可用 `bg_xxx` 引用，只是不进入选图清单。
本地已有 `bg_a000301.webp` 这类文件但没写 `images.yaml` 时，宿主会把官方地点名贴到本地条目上，
不会重复下载 `cloud/` 副本；BGM 同理（`bgm00003.mp3` 自动带官方曲名）。

### 目录刷新与排查

`GET /api/v1/resources` 返回 `models`、`images`、`imageDetails`、`voices`、`bgm`；它是目录，不是资源完整性证明。
宿主缓存为 **30 秒按需缓存**：到期后下一次访问才重建，不是后台每 30 秒扫描，也不保证插件在 30 秒内刷新。
模型文件读取失败时，该模型仍可能保留，但动作/表情为空；模型清单缺失或整次构建失败时沿用旧成功缓存，
没有旧缓存才返回空目录。背景清单解析失败通常只失去描述表；具体原因查看 `[Catalog]` 日志。
改清单通常只需等待下次重建；改资源根、TTS 或 BGM 配置则需重启宿主。插件另有自己的缓存策略。
云端目录另有独立快照：`cloud.generatedAt` 是目录生成时间，启动时先读磁盘缓存、再在线上限 15 秒，
过期后后台刷新；`POST /api/v1/cloud/refresh` 可立即重建。

## TTS 配音

宿主从 `config.yaml` 的 `tts` 节向每次导出下发配置。`provider: gpt-sovits` 使用 GPT-SoVITS `api_v2` 风格的 `/tts`；
`provider: irodori` 使用 Irodori-TTS-Server 的 OpenAI 兼容 `/v1/audio/speech`。
下面是可单独保存为 **最小 `config.yaml` 的完整配置示例**，未列出的顶层设置使用宿主默认值；
若已有主配置，只合并其中的 `tts` 节，不要覆盖整个文件，也不要重复定义两个 `tts` 键。

```yaml
tts:
  enabled: true
  apiBaseUrl: http://127.0.0.1:9880
  defaultRefAudioPath: /srv/tts/reference/example.wav
  defaultPromptText: こんにちは。
  promptLang: ja
  textLang: ja
  speedFactor: 1.0
  characters: []
```

`apiBaseUrl` 填服务根地址：GSV 不要重复追加 `/tts`，Irodori 不要追加 `/v1`。
`127.0.0.1` 指渲染宿主/浏览器所在环境，不是调用 API 的客户端。
`defaultRefAudioPath` 原样发给 TTS 服务，不会上传本机文件或自动映射容器卷；远程 TTS 必须能读取该服务端路径。
`defaultPromptText` 应与参考音频中实际说的话对应；`promptLang` 是参考提示语言，`textLang` 是待合成文本语言。
语言标识及支持范围由 TTS 服务决定；宿主默认二者为 `ja`，不会自动识别语言。`speedFactor` 默认 `1.0`，建议使用正数，
宿主没有定义可靠的数值上下限，实际支持范围取决于服务；不要用 `0` 关闭配音，应设 `enabled: false`。

### 角色专属字段与匹配

以下是 **主配置片段**，用于替换已有 `tts.characters`，省略的全局 TTS 字段继续由主配置提供。

```yaml
tts:
  characters:
    - characterName: 示例角色
      refAudioPath: /srv/tts/reference/example.wav
      promptText: こんにちは。
      promptLang: ja
      gptWeightsPath: ''
      sovitsWeightsPath: ''
```

| `characters[]` 字段 | 类型、默认值与含义                                                  |
| ------------------- | ------------------------------------------------------------------- |
| `characterName`     | 必填字符串，匹配 `Talk.data.speaker`；建议写模型登记表的完整 `name` |
| `refAudioPath`      | 字符串，默认 `""`；实际注册角色声音要求名称和此路径都非空           |
| `promptText`        | 字符串，默认 `""`；空值使用全局 `defaultPromptText`                 |
| `promptLang`        | 字符串，schema 默认 `ja`；省略时并非继承全局语言，应显式写正确语言  |
| `gptWeightsPath`    | 字符串，默认 `""`；非空覆盖全局同名字段，否则使用全局值             |
| `sovitsWeightsPath` | 字符串，默认 `""`；非空覆盖全局同名字段，否则使用全局值             |

角色条目没有独立 `textLang` 或 `speedFactor` 字段；它们是全局设置，不要把服务请求的蛇形字段名直接写进 YAML。
全局两个权重路径默认也为空。宿主会在合成前通过服务端的 `/set_gpt_weights`、`/set_sovits_weights` 切换权重，
再把 TTS 请求全局串行化；多个导出并发时不会互相覆盖权重。服务端需要支持这两个接口并能读取对应路径。
仅填写角色权重而把 `refAudioPath` 留空，会导致该角色条目不注册，不能借此只覆盖全局权重。

匹配顺序为：宿主先为与模型 `name` **完全相等**的配置补充未占用的 `shortName` 别名；
渲染端先精确匹配 `speaker`，未命中再按登记顺序查找“任一名称包含另一名称”的首个条目。
仍未命中才用全局参考音频、提示文本和权重。不会依据 `modelId` 选声音，也不自动去空格或转换大小写。
避免空名称、重名和相互包含的模糊简称；显式配置短名可覆盖自动别名，重复名称后注册的条目会覆盖前者。

### IrodoriTTS

把 `tts.provider` 设为 `irodori` 后，宿主改走 Irodori-TTS-Server 的 OpenAI 兼容接口
`POST <apiBaseUrl>/v1/audio/speech`。参考音频、LoRA adapter 和 caption 都放在请求体的 `irodori` 对象里，
由服务端按请求加载，不需要 GSV 的 `/set_*_weights`，也不会申请权重租约。

```yaml
tts:
  provider: irodori
  apiBaseUrl: http://127.0.0.1:8088
  timeoutMs: 120000
  speedFactor: 1.0
  irodori:
    model: irodori-tts
    responseFormat: wav
    numSteps: 40
    cfgScaleText: 3.0
    cfgScaleCaption: 3.0
    cfgScaleSpeaker: 5.0
    durationScale: 1.0
    chunkingEnabled: true
    chunkMinChars: 80
    seed: -1
    defaultLoraAdapter: ''
    defaultCaption: ''
    emotionLabels: [平静, 开心, 生气, 伤心, 害羞, 惊讶]
  characters:
    - characterName: 示例角色
      refAudioPath: /srv/irodori/example/emotion_refs/main.wav
      loraAdapter: /srv/irodori/example/lora_adapter
      caption: 落ち着いた、穏やかな口調で話している。
      speed: 1.0
      numSteps: 40
      emotions:
        - emotion: 平静
          refAudioPath: /srv/irodori/example/emotion_refs/calm.wav
        - emotion: 开心
          refAudioPath: /srv/irodori/example/emotion_refs/happy.wav
          caption: 嬉しそうに話している。
          speed: 1.1
```

| `tts.irodori` 字段                                     | 默认值          | 说明                                                     |
| ------------------------------------------------------ | --------------- | -------------------------------------------------------- |
| `model`                                                | `irodori-tts`   | 请求体 `model`                                           |
| `responseFormat`                                       | `wav`           | 请求体 `response_format`；渲染端按 WAV 解析时长          |
| `numSteps`                                             | `40`            | 采样步数；角色/情绪可覆盖                                |
| `cfgScaleText` / `cfgScaleCaption` / `cfgScaleSpeaker` | `3` / `3` / `5` | 指导强度                                                 |
| `durationScale`                                        | `1.0`           | 时长缩放                                                 |
| `chunkingEnabled` / `chunkMinChars`                    | `true` / `80`   | 长文本分块                                               |
| `seed`                                                 | `-1`            | `-1` 表示随机；`>=0` 时原样发送                          |
| `defaultLoraAdapter` / `defaultCaption`                | `""`            | 角色未填时的全局回退                                     |
| `emotionLabels`                                        | `[]`            | 供内置 AI 生成情绪标签；角色 `emotions` 的标签会自动并入 |

`characters[]` 在 GSV 字段之外新增：

| 字段            | 说明                                                               |
| --------------- | ------------------------------------------------------------------ |
| `refAudioPath`  | 单条参考音频；Irodori 发送为 `irodori.ref_wav`                     |
| `refAudioPaths` | 多条参考音频；非空时发送 `irodori.ref_wavs` 并省略 `ref_wav`       |
| `loraAdapter`   | PEFT LoRA adapter 目录，服务端路径                                 |
| `caption`       | 表演描述；为空时回退 `promptText`，再回退 `irodori.defaultCaption` |
| `speed`         | 角色默认语速；不填使用全局 `speedFactor`                           |
| `numSteps`      | 角色默认采样步数；不填使用 `irodori.numSteps`                      |
| `emotions[]`    | 情绪标签到参考音频/caption/speed/LoRA 的覆盖表                     |

`speed` 优先级为 `emotions[].speed` → `characters[].speed` → 全局 `speedFactor`。
`refAudioPaths`、`loraAdapter`、`caption` 等空字符串不会覆盖上层值；这与 Irodori 插件的情绪条目语义一致。
Irodori v4.1 是日语模型，`ttsText` 应写日语；内置 AI 的 `translateForTts` 可以在生成阶段补齐。
启用 Irodori 时，导出前还会严格预检并补齐缺失的日文 `ttsText`；把 `tts.enabled` 设为 `false`
后不合成语音，也不再用日语约束阻断纯画面导出。
GSV 的 `promptLang` / `textLang` / `gptWeightsPath` / `sovitsWeightsPath` 在 Irodori 下不参与请求。

### 情绪标签

故事里的 `Talk.data.emotion` 是可选的配音情绪，与画面上的 `facial` 无关：

```json
{
  "type": "Talk",
  "wait": true,
  "delay": 0,
  "data": {
    "speaker": "示例角色",
    "content": "今天也一起练吧。",
    "ttsText": "今日も一緒に練習しよう。",
    "emotion": "开心",
    "modelId": 1
  }
}
```

渲染端按 `emotion` 精确查找该角色 `emotions[]`；命中时用条目里非空的 `refAudioPath` / `refAudioPaths` /
`loraAdapter` / `caption` / `speed` 覆盖角色默认值，未命中或该角色没有情绪条目时使用默认参考音频，不会中断合成。
情绪标签区分大小写和空格，建议在 `config.yaml`、AI 提示词和剧本里使用同一套写法（默认六标签：
`平静`、`开心`、`生气`、`伤心`、`害羞`、`惊讶`）。

内置 AI 生成时，宿主把 `irodori.emotionLabels` 与所有角色 `emotions[].emotion` 合并后写进提示词；
模型输出不在列表里的标签会被校验器清空，回退到角色默认音色。手写故事可以省略 `emotion`，也可以直接写标签。
当前 API 导出不额外调用 LLM 判断情绪；情绪标签来自剧本本身或内置 AI 生成。

### `ttsText` 与画面台词

下面是 **故事 JSON 的单个 `snippets[]` 元素**，不是完整故事，也不是 YAML 配置。

```json
{
  "type": "Talk",
  "wait": true,
  "delay": 0,
  "data": {
    "speaker": "示例角色",
    "content": "你好。",
    "ttsText": "こんにちは。",
    "modelId": 1
  }
}
```

画面显示 `content`，非空 `ttsText` 用于合成；缺失或空字符串则朗读 `content`，不是“本句静音”。
当前 API 导出关闭自动翻译，因此中日双语需显式提供朗读文本，并使全局 `textLang` 与之匹配。
TTS 不可用或单句合成失败时可以继续无配音导出；无本句音频时不再用文字模拟口型，身体/表情仍正常运行。
台词计时和 `ttsText` 对无音频时长估算的影响见 [台词时长与口型](story-format.md#台词时长与口型)。

### 预录语音字段

故事仍保留 `Talk.data.voice`，其文件名相对 `voices/`。但是当前 API 的 record 和 fast 视频导出都使用 TTS 音轨，
不会因为填写 `voice` 就把预录音频混入 MP4；它也不是 TTS 的参考音频字段，不能作为关闭 TTS 后的导出替代方案。

## BGM

以下是 **完整 `audio/bgm/bgm.yaml` 示例**，放在实际资源根下；没有外层 `bgm:` 键。

```yaml
enabled: true
path: audio/bgm/bg1.mp3
volume: 0.2
```

1. 独立文件存在时，解析结果 **完整替换** 主配置 `bgm` 节，不是逐字段合并。
   省略项分别回默认 `enabled: true`、`path: audio/bgm/bg1.mp3`、`volume: 0.2`；空文件也使用这组默认值。
2. 只有独立文件不存在时，才使用主配置 `bgm` 节；主配置也未填的字段才取上述默认值。
   例如独立文件仅写 `enabled: false`，不会保留主配置中的路径和音量；主配置自身的类型错误仍可能先导致启动失败。
3. 音量使用数值 `0`～`1`；独立文件读取器会截断越界值，但主配置回退分支不做同样截断，应自行写合法范围。
   YAML 语法、字段类型或非键值表结构错误会导致启动失败；修改后要 **重启宿主**，30 秒目录缓存不负责刷新 BGM 设置。
4. `path: audio/bgm/bg1.mp3` 解析为 `/resources/audio/bgm/bg1.mp3`；历史 `resources/`、`resources/builtin/` 前缀兼容去除。
   `/resources/audio/bgm/bg1.mp3` 是站内 URL；`/srv/music.mp3` 也会被当作站内 URL，不会读取 Linux 磁盘文件。
   Windows 盘符路径、`file://` URL 不属于支持的磁盘寻址方式；不要照搬模板注释中的“绝对路径”理解为本地文件。
5. HTTP(S) URL 原样交给渲染页 `fetch`，必须允许浏览器访问、跨域读取并能解码音频；当前加载器不附加自定义认证头。
   URL 可访问不等于允许 CORS，宿主能下载也不代表浏览器能读取。加载或解码失败会记日志并缺失 BGM，不保证导出失败。
6. BGM 按混音长度循环；`tts.enabled: false` 不会关闭 BGM。要完全无声，分别关闭 TTS 与 BGM。
7. 剧本里的 `ChangeBgm` 可以按场景切歌：故事出现带文件的 `ChangeBgm` 后，`path` 的全局默认曲目不再混入，只加载被引用的 `resources/audio/bgm/<file>`，并按时间线循环、交叉淡化和停止。
   没有 `ChangeBgm` 时行为与旧版本完全一致。`enabled: false` 会关闭全部 BGM，包括剧本切歌。
8. `bgm:` 数组是 AI 的唯一候选列表：宿主只把登记过且带 `description` 的 `file` / `name` / `description` 写进提示词（最多 40 首），并拒绝 AI 编造的曲目。
   手工剧本在 `/api/v1/export` 里仍可直接引用磁盘上的文件；渲染端只要求文件存在且能解码，不强制登记。
9. `fetch:media` 下载 BGM 时会同时读取 PJSK 官方曲名索引（`musicSoundTracks`），把 `bgm00003` 这类文件名补成 `Slapstick!!` / `剧情 BGM` 再写进 `bgm:` 数组；已有条目若 `name` 为空、等于文件名，或 `description` 为空，资源目录也会用 `audio/bgm/soundtracks.json` 缓存补全。
   人工写过的 `name` / `description` 优先，不会被覆盖；官方索引没有收录的冷门曲目仍建议手工补一句描述，否则不会进入 AI 候选。
   曲名缓存可随时删除；运行 `npm run fetch:media -- --kind bgm --metadata-only` 只更新缓存、不下载音频。

核对示例时先检查 YAML 层级、字段类型、清单引用和路径基准；解析通过并不验证文件存在、模型可渲染或 TTS 能合成。
源码依据：宿主 `config.ts`、`resources/resourceCatalog.ts`、`pool/renderPool.ts`；渲染端 `app/App.ts`、`services/TTSService.ts`、`utils/ResourceUrl.ts` 与 `managers/video-export/AudioMuxer.ts`。
