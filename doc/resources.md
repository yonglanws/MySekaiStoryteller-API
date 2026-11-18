# 资源与音频配置

[返回 README](../README.md) · [文档索引](README.md) · [云端资源获取](cloud-assets.md) · [故事文件格式](story-format.md) · [部署指南](host-deployment.md)

本文导航：[资源目录](#资源目录) · [可选本地清单与覆盖规则](#可选本地清单与覆盖规则) · [TTS 配音](#tts-配音) · [IrodoriTTS](#irodoritts) · [情绪标签](#情绪标签) · [BGM](#bgm)

> [!TIP]
> **零本地资源即可开箱运行**：默认开启 `assets.cloudCatalog: true` 时，`resources/` 目录可以完全为空，无需手动编写 `models.yaml`、`images.yaml` 或 `bgm.yaml`。以下 YAML 清单仅在你需要**添加自定义资源**或**覆盖云端默认项**时使用；本地文件存在时始终优先。

## 资源目录

```text
resources/                        默认资源根（可用 paths.resources / MSS_RESOURCE_DIR 修改）
├─ models/
│  ├─ models.yaml                 可选：自定义本地模型登记表
│  ├─ <角色>/<变体>/               可选：本地模型包（model3.json、moc3、纹理、motions/）
│  └─ cloud/                      云端按需物化的模型（可删，自动重建）
├─ images/
│  ├─ images.yaml                 可选：本地背景描述表
│  ├─ <bg>.png|jpg|webp           可选：本地背景直属文件
│  └─ cloud/                      云端按需物化的背景（可删，自动重建）
├─ audio/
│  ├─ bgm/
│  │  ├─ bgm.yaml                 可选：独立 BGM 设置与曲目描述表
│  │  ├─ soundtracks.json         官方曲名索引缓存（可删）
│  │  ├─ <bgm>.mp3|wav|ogg|flac   可选：本地 BGM 直属文件
│  │  └─ cloud/                   云端按需物化的 BGM（可删，自动重建）
│  └─ se/
│     └─ cloud/                   云端按需物化的场景音效 SE（可删，自动重建）
├─ inapp/jp-7.0.0/                自动按需拉取的官方 UI 贴图与通用菜单音效
├─ voices/                        预录语音目录（当前 API 导出使用 TTS 音轨，不混入 voice）
└─ stories/                       可选：*.sekai-story.json 故事文件
```

### 路径基准

| 配置或字段                             | 基准与正确形式                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `paths.resources` / `MSS_RESOURCE_DIR` | 相对宿主识别的仓库根，默认 `resources`；支持绝对路径                                         |
| `models.yaml` 的 `path`                | 相对 `resources/models/`，如 `example/normal/example.model3.json`                            |
| `images.yaml` 的 `file`                | 相对 `resources/images/`，如 `room_day.jpg`                                                  |
| 故事 `models[].model`                  | 相对 `models/` 的本地路径，或 `cloud/<模型id>/<变体>/<model3.json>`、云端 id、`角色名 服装`  |
| 故事 `images[].image`                  | 相对 `images/` 的本地路径、云端 id（`bg_a000301`）或中文地点名（如 `神山高校 天台·黄昏`）    |
| `bgm.path`                             | 相对资源根路径（`audio/bgm/bg1.mp3`）、云端曲名/id（`bgm00003`）、或允许 CORS 的 http(s) URL |
| TTS 参考音频、权重、LoRA 路径          | **TTS 服务端所在机器**的文件路径，不以渲染宿主 `resources/` 为基准                           |

静态路由统一挂载在 `/resources/*`，不要把密钥、私有配置或不希望公开的文件放进资源根。三份模板文件可按需复制使用：

| 公开模板                                                       | 实际资源根内的正式文件 |
| -------------------------------------------------------------- | ---------------------- |
| [models.example.yaml](../resources/models/models.example.yaml) | `models/models.yaml`   |
| [images.example.yaml](../resources/images/images.example.yaml) | `images/images.yaml`   |
| [bgm.example.yaml](../resources/audio/bgm/bgm.example.yaml)    | `audio/bgm/bgm.yaml`   |

## 可选本地清单与覆盖规则

启用 `assets.cloudCatalog`（默认开启）时，宿主会将本地清单与云端目录（511 模型 / 1,401 背景 / 421 BGM / 1,942 SE）合并：

- **模型覆盖（`models/models.yaml`）**：
  - 当 `models.yaml` 不存在时，宿主完全使用云端模型目录（26 位主角色默认服装 `id = 1000 + characterId`，其余服装变体与配角自 `2000` 起确定性分配）。
  - 当 `models.yaml` 存在时，本地条目以 `source: "local"` 优先占据该角色的默认首选位，**不会压制同一角色的其他云端换装变体，也不会压制未在本地登记的其他角色或配角**。
  - 若本地路径根目录刚好对应某个云端模型 id（如 `01ichika_normal/...`），仅对该服装 id 本身去重。
  - 动作与表情从 `FileReferences.Motions` 枚举（`face_` 前缀归为表情，其余归为动作）；若模型目录 `motions/` 存在未索引的 `*.motion3.json`，目录构建时会自动补齐并尝试回写 `model3.json`。

```yaml
# 可选完整 models/models.yaml 示例
models:
  - id: 1
    name: 示例角色
    shortName: 小示
    path: example/normal/example.model3.json
```

- **背景覆盖（`images/images.yaml`）**：
  - 扫描 `images/` 直属图片（`.jpg/.jpeg/.png/.webp`），不递归子目录。
  - 若本地存在与云端 id 同名的文件（如 `fetch:media` 拉取的 `bg_a000301.webp`），宿主不会再生成 `cloud/` 副本，而是直接把官方中文地点名、别名、分类、时段和室内外标签贴到本地条目上。
  - 其余未下载到本地的云端背景全量保留在合并目录中，按需导出时再下载到 `images/cloud/`。

```yaml
# 可选完整 images/images.yaml 示例
images:
  - file: room_day.jpg
    name: 房间·白天
    description: 日光照入的室内场景，适合日常交谈
```

### 目录缓存与刷新

- `GET /api/v1/resources` 使用 **30 秒按需内存缓存**（包含 `models`、`images`、`imageDetails`、`voices`、`bgm`、`bgmDetails`、`seDetails` 与 `cloud` 元信息）。
- 云端目录快照独立缓存在 `<assets.cacheDir>/catalog.json`（默认 6 小时有效，后台定时刷新），支持调用 `POST /api/v1/cloud/refresh` 强制立即刷新。
- 改本地 `models.yaml` / `images.yaml` 等待下次 30 秒缓存重建即可生效；改 `config.yaml`、`bgm.yaml` 或 `tts` 配置需要**重启宿主**。

## TTS 配音

宿主从 `config.yaml` 的 `tts` 节读取配置：`provider: gpt-sovits` 调用 GPT-SoVITS `/tts`（并通过 `/api/v1/tts/lease` 串行切换全局权重租约）；`provider: irodori` 调用 Irodori-TTS-Server 的 OpenAI 兼容 `/v1/audio/speech`。

```yaml
# 最小 GPT-SoVITS 配置片段
tts:
  enabled: true
  provider: gpt-sovits
  apiBaseUrl: http://127.0.0.1:9880
  defaultRefAudioPath: /srv/tts/reference/example.wav
  defaultPromptText: こんにちは。
  promptLang: ja
  textLang: ja
  speedFactor: 1.0
  characters:
    - characterName: 晓山瑞希
      refAudioPath: /srv/tts/reference/mizuki.wav
      promptText: こんにちは。
      promptLang: ja
      gptWeightsPath: ''
      sovitsWeightsPath: ''
```

说明：

- `apiBaseUrl` 填服务根地址：GPT-SoVITS 不追加 `/tts`，Irodori 不追加 `/v1`。
- `refAudioPath` / `gptWeightsPath` / `sovitsWeightsPath` / `loraAdapter` 均原样发往 TTS 服务端，**必须存在于 TTS 服务端磁盘**。
- 角色匹配规则：宿主先为与模型 `name` 完全相等的角色自动补充未占用的 `shortName` 别名；渲染端按精确 `speaker` 匹配，未命中时再按“名称互含”匹配，仍未命中则使用全局默认值。
- 关闭配音请设 `tts.enabled: false`，不要把 `speedFactor` 设为 `0`。

## IrodoriTTS

将 `tts.provider` 设为 `irodori` 时，宿主按请求将 `ref_wav` / `ref_wavs`、PEFT `lora_adapter`、`caption`、采样步数与语速发往 `POST <apiBaseUrl>/v1/audio/speech`，无需全局权重租约：

```yaml
tts:
  enabled: true
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
    - characterName: 晓山瑞希
      refAudioPath: /srv/irodori/mizuki/calm.wav
      loraAdapter: /srv/irodori/mizuki/lora_adapter
      caption: 明るく軽い口調で話している。
      speed: 1.0
      numSteps: 40
      emotions:
        - emotion: 平静
          refAudioPath: /srv/irodori/mizuki/calm.wav
        - emotion: 开心
          refAudioPath: /srv/irodori/mizuki/happy.wav
          caption: 嬉しそうに話している。
          speed: 1.1
```

> [!IMPORTANT]
> Irodori v4.1 仅支持日文语音合成。启用 Irodori 时，内置 AI 默认开启 `translateForTts` 自动补全 `ttsText`；直接调用 `/api/v1/export` 时，宿主也会在导出前预检并补齐缺失的日文 `ttsText`（若 `llm` 未开启且缺日文 `ttsText` 将返回 400）。渲染端 `TTSService` 还会做最后一道日文校验。将 `tts.enabled` 设为 `false` 时不执行日语预检。

## 情绪标签

`Talk.data.emotion` 仅用于 IrodoriTTS 挑选对应情绪的参考音频/caption/语速，与画面 Live2D `facial` 表情相互独立：

- 优先级：`emotions[].speed` → `characters[].speed` → 全局 `speedFactor`；空字符串不会覆盖上层配置。
- 内置 AI 生成时，宿主合并 `tts.irodori.emotionLabels` 与各角色 `emotions[].emotion`，在独立低温 `emotion` 阶段按 5~10 句段落稳定性标注并做后处理（最短连续段、同说话人抖动贴回、强情绪配额与平静回落），确保不会逐句跳音色。

## BGM

### 零本地默认兜底与 `bgm.yaml`

1. **云端默认兜底**：当 `resources/audio/bgm/bgm.yaml` 与 `resources/audio/bgm/bg1.mp3` 均不存在于磁盘且开启 `assets.cloudCatalog` 时，`loadHostConfig()` 自动把默认 `bgm.path` 设为 **`bgm00003`**（经典日常曲 `Slapstick!!`），首次导出前由 `resolveGlobalBgm()` 自动下载至 `resources/audio/bgm/cloud/bgm00003.mp3`。
2. **独立覆盖文件（`audio/bgm/bgm.yaml`）**：该文件存在时，**整体替换** `config.yaml` 中的 `bgm` 节（缺省字段取 `enabled: true`、`path: audio/bgm/bg1.mp3`、`volume: 0.2`）。`path` 支持相对路径、云端曲名/id（如 `Slapstick!!` 或 `bgm00003`）或支持 CORS 的 http(s) URL。

```yaml
# 可选完整 resources/audio/bgm/bgm.yaml 示例
enabled: true
path: bgm00003
volume: 0.2
# 若需向本地目录补充自定义曲目供 AI 选择，可追加 bgm 数组：
# bgm:
#   - file: custom_theme.mp3
#     name: 自定义主题曲
#     description: 温柔抒情的钢琴日常曲
```

3. **本地文件合并与循环边界**：若本地 `audio/bgm/` 已下载有 `bgm00003.mp3` 等官方文件，目录构建会保留本地路径并自动为其贴上云端语义与 Sekai-World 曲名；云端 `bgm` 全量目录（400 剧情 BGM + 21 `area_bgm`）同时保留给 AI 与 `ChangeBgm` 使用，无 80 首截断。
4. **场景切歌优先**：当剧本中出现带文件的 `ChangeBgm` 片段时，混音器只加载剧本引用的 `ChangeBgm` 曲目（不再叠放全局默认 `bgm.path`），并支持多曲交叉淡化、`silence` / `stop: true` 静音留白以及从音频元数据提取的无缝循环边界（`loopStartMs` / `loopEndMs`）。将 `enabled: false` 则会关闭包括 `ChangeBgm` 在内的全部 BGM。

### 预录语音字段（`voices/`）

故事 Schema 仍保留 `Talk.data.voice`（相对 `voices/`），但当前 API 导出的 `record` 与 `fast` 管线均使用 TTS 音轨，不会因填写 `voice` 而混入预录音频。无本句 TTS 音频时退回文本步进或静音处理，详见 [台词时长与口型](story-format.md#台词时长与口型)。
