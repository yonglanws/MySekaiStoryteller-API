# 资源与音频配置

[返回文档总览](README.md) · [云端资源获取](cloud-assets.md) · [故事文件格式](story-format.md) · [部署指南](host-deployment.md)

> [!TIP]
> 默认开启 `assets.cloudCatalog: true` 时，`resources/` 可以完全留空，不用自己建 `models.yaml`、`images.yaml` 或 `bgm.yaml`。下面只讲两件事：**怎么放本地素材覆盖云端**，以及**怎么配 TTS 配音和 BGM**。

## `resources/` 目录长什么样

```text
resources/                        默认资源根（可通过 paths.resources / MSS_RESOURCE_DIR 修改）
├─ models/
│  ├─ models.yaml                 可选：本地模型登记表
│  ├─ <角色>/<变体>/               可选：本地模型包（model3.json、moc3、纹理、motions/）
│  └─ cloud/                      云端按需下载的模型缓存（可删，导出时自动重建）
├─ images/
│  ├─ images.yaml                 可选：本地背景描述表
│  ├─ <bg>.png|jpg|webp           可选：本地背景文件（只扫直属文件）
│  └─ cloud/                      云端按需下载的背景缓存
├─ audio/
│  ├─ bgm/
│  │  ├─ bgm.yaml                 可选：独立 BGM 设置（存在时会整体替换 config.yaml 的 bgm）
│  │  ├─ soundtracks.json         官方曲名索引缓存
│  │  ├─ <bgm>.mp3|wav|ogg|flac   可选：本地 BGM 文件
│  │  └─ cloud/                   云端按需下载的 BGM 缓存
│  └─ se/
│     └─ cloud/                   云端按需下载的场景音效 SE 缓存
├─ inapp/jp-7.0.0/                官方对话框/特效贴图与菜单 SE 缓存
├─ voices/                        预录语音目录（API fast 模式当前不混入此字段）
└─ stories/                       可选：存放 *.sekai-story.json
```

路径基准一眼看懂：

- `models.yaml` 里的 `path` 相对于 `resources/models/`；`images.yaml` 里的 `file` 相对于 `resources/images/`。
- `bgm.yaml` 里的 `path` 相对于 `resources/`（比如 `audio/bgm/bg1.mp3`），也可以直接写云端曲名/id（如 `bgm00003`、`Slapstick!!`）或允许跨域的 `http(s)://` URL。
- **最重要的一条**：`tts` 里的 `refAudioPath`、`gptWeightsPath`、`sovitsWeightsPath`、`loraAdapter` 都是原样发给 TTS 服务端的，**必须是 TTS 服务端所在机器上的磁盘路径**，不是渲染宿主的 `resources/`。

需要手动写本地清单时，可直接复制这三份模板：
[models.example.yaml](../resources/models/models.example.yaml) · [images.example.yaml](../resources/images/images.example.yaml) · [bgm.example.yaml](../resources/audio/bgm/bgm.example.yaml)

## 本地素材覆盖规则

- **模型（`models/models.yaml`）**：本地配了哪个角色，就以 `source: "local"` 占住该角色的默认位置，但**不会屏蔽这个角色的其他云端换装，也不会屏蔽其他角色**。模型 `motions/` 下如果有未登记进 `model3.json` 的 `.motion3.json`，目录构建时会自动补齐。
- **背景（`images/images.yaml`）**：只扫描 `images/` 第一层的图片。如果本地已经下载了云端同名图片（比如 `bg_a000301.webp`），宿主不再建 `cloud/` 副本，直接把官方中文名和地点标签贴上去。
- **生效时间**：改本地 `models.yaml` / `images.yaml` 等最多 30 秒内存缓存过期即可生效；改 `config.yaml`、`bgm.yaml` 或 `tts` 配置**必须重启宿主**。

---

## TTS 配音配置

在 `config.yaml` 的 `tts` 节配置。支持两种引擎：`gpt-sovits` 和 `irodori`。不打算开配音就把 `tts.enabled` 设为 `false`（**千万别把 `speedFactor` 设成 `0`**）。

### 1. GPT-SoVITS

宿主调用 `<apiBaseUrl>/tts`（`apiBaseUrl` 填根地址，不要自带 `/tts`），多路并发导出时会自动通过内部 `/api/v1/tts/lease` 串行拿权重租约，避免多个导出互相把服务端全局权重切乱。

```yaml
tts:
  enabled: true
  provider: gpt-sovits
  apiBaseUrl: http://127.0.0.1:9880
  timeoutMs: 120000
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

### 2. IrodoriTTS（推荐配合多情绪与 LoRA）

将 `tts.provider` 设为 `irodori`，`apiBaseUrl` 指向 Irodori 服务根地址（不要自带 `/v1`），宿主请求 `POST <apiBaseUrl>/v1/audio/speech`，按每次请求携带 `ref_wav` / `ref_wavs`、PEFT `lora_adapter`、`caption`、步数和语速：

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
    speakerKvScale: 1.15 # 早期去噪步锁住角色音色底色
    speakerKvMinT: 0.9
    timbreLockMode: normal # normal = 普通句锁基础参考音频，仅特殊高潮句解锁；off = 按 emotion 切换
    specialSceneCfgScaleCaption: 3.6
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
> **Irodori 只接受日文文本！**
>
> - 用宿主内置 AI 写剧本时会自动开启 `translateForTts`，把台词翻成日语填入 `ttsText`。
> - 如果你自己直接调 `/api/v1/export` 提交外部剧本，启用 Irodori 时如果缺日文 `ttsText`，只要 `llm.enabled` 开着，宿主会在入队前自动帮你补翻；如果 `llm` 没开又缺日文 `ttsText`，导出会被 HTTP 400 拒绝。

### 角色匹配与情绪标签

- **说话人匹配**：先按模型名精确匹配 `characterName`（并自动补充未占用的 `shortName` 别名），没撞上再模糊互相包含匹配，还找不到就回退全局默认。
- **`Talk.data.emotion` 仅管声音，不管 Live2D 表情**（Live2D 表情看 `facial`）。语速优先级：`emotions[].speed` → `characters[].speed` → 全局 `speedFactor`。
- **`timbreLockMode: normal`**：为防止角色情绪一变音色就漂成另一个人，普通句子默认锁定基础参考音频，只有 AI 标为 `ttsSpecialScene`（哭喊、耳语、爆发等）的高潮句才放开切情绪参考音频和强化 `specialSceneCfgScaleCaption`；想每次都严格按 `emotion` 换参考音频可设为 `off`。

---

## BGM 背景音乐

1. **云端默认兜底**：在 `cloudOnly: true`（`config.example.yaml` 默认开启）或本地无 `bgm.yaml` / `bg1.mp3` 且启用云端目录时，默认 BGM 自动指向 **`bgm00003`（`Slapstick!!`）**，全局默认音量 **`0.35`**（已叠加 `0.75x` 增益与人声期间 `0.65x` 自动闪避）。
2. **自定义全局 BGM**：
   - 支持直接通过 `config.yaml` 的 `bgm` 节或环境变量 `MSS_BGM_ENABLED` / `MSS_BGM_PATH` / `MSS_BGM_VOLUME` 覆盖（`MSS_BGM_*` 始终优先级最高）。
   - 若关闭 `cloudOnly` 并新建 `resources/audio/bgm/bgm.yaml`，该文件会**整体替换** `config.yaml` 的 `bgm` 节（缺省字段使用 `enabled: true`、`volume: 0.35`）；开启 `cloudOnly: true` 时会忽略本地 `bgm.yaml` 与非 `cloud/` 音频：
     ```yaml
     enabled: true
     path: bgm00003
     volume: 0.35
     ```
3. **剧本内切歌优先**：只要剧本里出现带文件的 `ChangeBgm` 片段，混音器就会改播剧本里写的曲目（支持交叉淡化、`stop: true` 静音留白和无缝循环点），不再叠放全局默认 BGM。把 `bgm.enabled` 设为 `false` 则会把全局和剧本内所有 BGM 一起关掉。
