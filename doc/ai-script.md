# 宿主内置 AI 剧本生成

[返回文档索引](README.md) · [API 参考](api.md) · [云端资源获取](cloud-assets.md)

宿主可以直接接收一句场景描述，完成 **资源目录读取 → 选角 → 台词 → 表演设计 → 校验修复 → 日文 ttsText 翻译**，然后返回剧本 JSON，或继续调用现有导出管线生成视频。客户端不再需要自己构建提示词、维护动作白名单或做舞台校验。

默认使用参照 `ournotes-player` 的四段式流水线：先选 1~2 名角色和一个小事件，再只带入选角色的完整人设写台词，然后低温标注 TTS 情绪段，最后单独设计每句的动作/表情、听者反应、背景和可选 BGM。台词一经生成就逐字进入最终剧本，表演段不能改写它。

这是一条与 AstrBot 插件并行的路径：插件仍可在自己的进程里调用任意 LLM；宿主内置生成适合没有 AstrBot、或希望所有机器人都共享同一套提示词与资源目录的部署。

## 配置

```yaml
llm:
  enabled: true
  baseUrl: https://api.openai.com/v1
  apiKeyEnv: MSS_LLM_API_KEY
  model: gpt-4.1-mini
  temperature: 0.85
  maxTokens: 8192
  timeoutMs: 120000
  retries: 2
  repairRounds: 2
  pipeline: staged
  jsonMode: auto
  translateForTts: true
  targetMinutes: 3
  systemPrompt: ''
  extraBody: {} # 原样并入请求体；例如 {"thinking":{"type":"disabled"}} 关闭推理模型的思考
  personaDirs: []
  personas: []
```

密钥只从环境变量读取，不写进 `config.yaml`：

```bash
export MSS_LLM_API_KEY=sk-...
# 或者指向本机模型服务（Ollama 示例）
export MSS_LLM_BASE_URL=http://127.0.0.1:11434/v1
export MSS_LLM_MODEL=qwen2.5:32b
```

`baseUrl` 是 OpenAI Chat Completions 的服务根地址，宿主会请求 `<baseUrl>/chat/completions`。兼容官方 OpenAI、new-api、one-api、Ollama、vLLM、LM Studio 等。

`extraBody` 会原样并入请求体。对支持 `thinking` 字段的推理模型，可用
`{"thinking":{"type":"disabled"}}` 关闭思考：单场生成从约 2~3 分钟降到 20~30 秒，但动作预算和句长
约束的遵循度会下降；要稳定质量时保持默认（不关闭）。

IrodoriTTS 只接受日文。`translateForTts` 默认开启，生成阶段会把每条 Talk 的空/中文
`ttsText` 补成日文；通过 `/api/v1/export` 直接提交的外部剧本也会在入队前做一次严格预检，
补不齐时返回 400，不会把中文 `content` 送去合成。renderer 的 `TTSService` 还会在发请求前
再校验一次日文，作为最后一道闸。

| 配置              | 说明                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------- |
| `enabled`         | 关闭后两个生成端点返回 422                                                             |
| `pipeline`        | `staged`（默认）四段式；`single` 一次调用写完整剧本；`chat` 模式始终 `single`          |
| `jsonMode`        | `auto` 先带 `response_format=json_object`，服务拒绝时自动去掉；`on` 必须；`off` 不发送 |
| `repairRounds`    | `single` 的 JSON/舞台校验失败重写轮数；`staged` 的台词/表演各最多重写一次              |
| `translateForTts` | 为缺失 `ttsText` 的台词批量翻译日语；失败时保留空字符串                                |
| `targetMinutes`   | 只写进提示词，不截断模型输出                                                           |
| `extraBody`       | 原样并入 Chat Completions 请求体；例如关闭推理模型的思考以降低延迟                     |
| `personaDirs`     | 读取目录下 `*.md` / `*.txt`，文件名或 frontmatter `name` 作为角色名                    |
| `personas`        | 内联人格：`name`、`prompt`、`aliases`、`group`                                         |
| `systemPrompt`    | `single` 覆盖内置系统提示词；`staged` 追加到四段各自的系统提示词                       |

如果 `tts` 配置了情绪标签（`tts.irodori.emotionLabels` 或任一角色的 `tts.characters[].emotions[].emotion`），
staged 会在台词定稿后单独做一次低温情绪分段，再对分段做强约束（最短 3 句、同说话人抖动贴回、
强情绪配额、至少 1/4 句子回到平静）。不在列表里的标签会被校验器清空；IrodoriTTS 再按标签选择该角色的
情绪参考音频。未配置情绪标签时不会输出该字段。这样不会出现逐句换情绪导致音色忽变。

人格目录示例：

```markdown
---
name: 晓山瑞希
aliases: [瑞希, mizuki]
---

外貌、性格、说话风格、口头禅、禁忌、表情倾向……
```

## 生成剧本

```bash
curl -sS -X POST http://127.0.0.1:9881/api/v1/script/generate \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "放学后的教室里，瑞希和绘名聊起下次 Live",
    "mode": "story",
    "targetMinutes": 3,
    "timeout": 600000
  }'
```

请求字段：

| 字段              | 必填 | 说明                                                           |
| ----------------- | ---- | -------------------------------------------------------------- |
| `prompt`          | 是   | 场景描述或用户消息                                             |
| `mode`            | 否   | `story`（默认，约 3 分钟短戏）或 `chat`（角色对话）            |
| `cast`            | 否   | 限定可选角色：角色名、简称、id 或模型 id 片段                  |
| `targetMinutes`   | 否   | 覆盖 `llm.targetMinutes`                                       |
| `history`         | 否   | `chat` 模式的历史消息：`[{role, content}]`                     |
| `translateForTts` | 否   | 默认 `true`；设为 `false` 跳过日语翻译                         |
| `pipeline`        | 否   | `staged` 或 `single`，覆盖 `llm.pipeline`；`chat` 模式忽略此项 |
| `timeout`         | 否   | 生成阶段超时（毫秒），默认 600000，最大 1800000                |

成功响应：

```json
{
  "success": true,
  "story": { "models": [], "images": [], "snippets": [] },
  "meta": {
    "mode": "story",
    "pipeline": "staged",
    "title": "放学后",
    "model": "gpt-4.1-mini",
    "rounds": 3,
    "warnings": [],
    "usage": { "promptTokens": 0, "completionTokens": 0, "totalTokens": 0 },
    "latencyMs": 0,
    "ttsTranslated": 3,
    "cast": ["晓山瑞希", "东云绘名"],
    "stages": [
      { "stage": "cast", "model": "gpt-4.1-mini", "latencyMs": 0, "usage": {}, "ok": true },
      { "stage": "dialogue", "model": "gpt-4.1-mini", "latencyMs": 0, "usage": {}, "ok": true },
      { "stage": "direction", "model": "gpt-4.1-mini", "latencyMs": 0, "usage": {}, "ok": true }
    ]
  },
  "scriptPath": "apifile/script-1800000000000.json"
}
```

`scriptPath` 是宿主输出目录里的剧本 JSON，便于复现和排查；清理策略与导出文件相同。

导出成功后，视频同目录还会生成 `<video>.log.json`、`<video>.log` 与 `<video>.report.txt`：
前者是完整诊断（逐句 planned/actual/drift、每条 TTS 的日文标记与时长、每个动作的
request/loaded/started/interrupted、60 fps 逐帧计划、全部模块日志），`.log` 是可读摘要与异常，
`.report.txt` 是成片时长、逐帧计划总量、近似项与异常清单。响应里的 `logPath` / `logJsonPath` /
`reportPath` 指向这三个文件。

## 一句话生成视频

```bash
curl -sS -X POST http://127.0.0.1:9881/api/v1/generate \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "深夜的无人 SEKAI，奏和真冬聊起写不出来的歌",
    "mode": "story",
    "scriptTimeout": 600000,
    "exportTimeout": 1800000
  }'
```

它先调用与 `/api/v1/script/generate` 相同的生成流程，再把剧本交给 `POST /api/v1/export` 使用的同一条队列。响应包含导出结果（`videoPath`、`fileSize`、`duration`、`frameCount`、`timings`、`downloadUrl`）以及 `story`、`meta`、`scriptPath`。

生成成功但导出失败时返回 500，并在响应里带回 `story` 和 `meta`，客户端可以拿剧本重新提交 `/api/v1/export`，不必重新消耗 LLM。

## 生成流程

1. **资源目录**：读取 `resources/` 的模型、动作、表情、背景、BGM 清单（30 秒缓存），并合并云端目录（背景地点名、官方曲名、26 位角色模型）；本地条目优先。BGM 会合并 `fetch:media` 缓存的官方曲名与分类。`cast` 会把可选角色缩小到匹配项。云端目录默认开启，本地 YAML 可以完全不写。
2. **staged（默认）**：四次 LLM 调用（选角 → 台词 → 情绪 → 表演），按官方剧情实测校准
   （约 3 分钟、40 句上下、平均 17~20 字、约两成台词没有动作、双人整场同场）。
   - **选角**：从可选角色里选 1~2 人，给每人一个本场功能，写一个小事件和 4~6 条大纲；只带人设摘要。
   - **台词**：只带入选角色的完整人设，用 `turns` 输出——一个角色一次发言 = 一个 turn，turn 里 1~6 条
     `lines`。这一稿之后逐字保留，情绪段和表演段都不能改写；最后只把一部分句号收尾改成省略号
     （只改标点，不动文字），把停顿密度拉近官方。宿主会把模型多写的同角色相邻短句并回
     一条（`condenseDialogue`，只合并不改字），把平均句长拉回官方水平。每条台词的动作 cue
     固定在句首（官方 `MotionChangeFrom=1`、`TimingSyncValue=0`），不会随 TTS 时长漂移。
   - **情绪**：台词定稿后单独用低温（0.2）标注，模型按 5~10 句一段输出 `segments`，只允许配置的
     6 个 TTS 标签。宿主再做强约束：段内不切、短段合并、同说话人抖动贴回、强情绪配额、至少 1/4
     句子回到平静底色。这样音色不会在相邻句之间反复横跳。
   - **表演**：带逐字台词与情绪标签、入选角色的完整动作/表情清单、背景清单和 BGM 清单，为每句选
     说话者动作/表情、约 1/5 的听者反应、一张主背景（可选第二张）、环境色和一首 BGM（情绪明显
     转折时可再指定第二首和换曲句）。宿主把说话者动作压到约 80%（至少 20% 静止句），听者反应
     压到约 20%。
   - **合成**：双人戏整场两人同场（Left/Right），单人戏整场 Center；`planPresence` 只产出一个
     覆盖全篇的段。开场用一次 `LayoutAppear` 让两人同时入场，两个角色都带入场动作；结尾一次
     `LayoutClear` 原地淡出。入场动作在模型 alpha=0 时就开始加载/播放，再开始淡入和滑入，
     并且只等 0.1s 淡入（官方 FadeOpacity 为 1 帧 alpha=0 + 6 帧淡入，片段约 116.7ms），
     滑入继续在后台播放，所以不会出现“淡入后站桩”或每条入场停顿 2~3 秒。
     第二张背景/环境色写进 `images`/`AmbientColor`；BGM 在开场写 `ChangeBgm`，指定了 `bgm2`
     时在对应句前再换一次。
   - **官方节奏**：台词 4 帧/字（66.7ms），有语音时等 `语音结束 + 0.05s` 后再停 0.5s，
     无语音时打字结束停 2.0s；语音后还要等身体动作收尾。首次/`HideTalk` 后打开对话框的
     0.2s 只推迟打字，不推迟语音。动作切换使用 0.5s 交叉淡化（同类别/链接动作 0.125s，
     表情 0.25s），不再先清空旧动作。待机有 3s 呼吸与 3±2s 眨眼，口型按官方 RMS/pow 曲线。
   - **降级**：选角失败按目录顺序取前两名；情绪标注失败整场用默认标签；表演为空时重写一次，仍失败
     则只保留台词与 presence 走位，不阻断出片。
3. **single**：一次调用直接写完整剧本；`chat` 模式始终使用这条路径。模型可在顶层写 `bgm` 数组（与 `images` 对齐），宿主把它编译成开场/换场处的 `ChangeBgm`；没有合适曲目时省略，继续使用全局 BGM。
4. **LLM 调用**：OpenAI 兼容接口，`response_format=json_object` 可按配置回退；网络错误、429、5xx 自动重试。
5. **校验修复**：
   - `modelId` 必须来自目录；id 与路径不一致时按路径重映射
   - `speaker` 与 `modelId` 对齐
   - 背景必须在清单里：可以写文件名、云端 id（`bg_a000301`）或官方地点名（`教室`）
   - BGM 必须在 `bgm.yaml` 或云端目录的曲目清单里；非法曲目和空文件会被丢弃，整场没有可用 `ChangeBgm` 时沿用全局默认
   - BGM 候选按 `description` 过滤，最多列 40 首；`fetch:media` 用 PJSK 官方曲名索引补的“曲名 + 分类”也算描述
   - `ChangeBgm.stop: true` 停止当前 BGM；同时给 `file` 时按停止处理
   - 动作/表情名按完整名 → 忽略大小写/分隔符 → 唯一尾号 → 唯一前缀修正，修不了丢弃该处表演
   - 单句说话者最多 5 处变化、听者最多 1 处、同角色相邻变化间隔 ≥0.2
   - 不在场说话、重复入场、双人同侧、第三人入场会抛错并进入修复轮
   - 超过 3 行的 Talk 拆成同角色连续多条，台词一字不丢
   - 完全缺失 `ChangeLayoutMode`、`ChangeBackgroundImage` 或结尾 `BlackOut` 时自动补一条，避免白底/硬切结束
6. **ttsText 翻译**：缺失的 `ttsText` 按每批 20 条翻译成日语；数量不匹配或请求失败时保留空字符串，由宿主退回朗读 `content`。
7. **返回或导出**：校验通过后返回 `StoryData`，或直接提交渲染队列。

## 质量评测

仓库带三套可复现的评测/回归脚本（语料和报告放在仓库外）：

```bash
# 1. 下载官方活动剧情（JP 结构 + CN 文本）
node scripts/stories/fetch-official-corpus.mjs --out D:/msst-lab/corpus

# 2. 官方基线：句长、连续说话、动作密度、情绪切换、上下场次数
node scripts/stories/official-metrics.mjs \
  --corpus D:/msst-lab/corpus --out D:/msst-lab/official-baseline.json

# 3. AI 评测：8 个固定场景，落盘剧本和聚合指标
MSS_LLM_API_KEY=... MSS_LLM_BASE_URL=... \
  node scripts/stories/ai-eval.mjs --runs 1 --out D:/msst-lab/runs/latest

# 回归测试（语料/报告存在时执行，不存在时跳过）
npm run test:stories
```

`npm run test:stories` 会断言：官方 40 句双人窗口的句长/动作/舞台分布没有漂移，以及 AI 报告里
句长、>26 字比例、动作密度、无动作比例、情绪切换、同场人数、单人镜头和上下场次数落在目标区间。
指标定义与官方实测值见 [AI 剧本质量计划](ai-script-quality-plan.md)。

## 错误与排查

| 状态码 | 含义                                | 处理                                              |
| ------ | ----------------------------------- | ------------------------------------------------- |
| 422    | 生成/校验失败，`details` 是每轮错误 | 看 `details` 最后一条；常见是不在场说话或双人同侧 |
| 429    | 并发生成达到上限                    | 等当前生成结束；上限取 `min(4, render.workers)`   |
| 502    | LLM 网络/HTTP 错误                  | 检查 `baseUrl`、密钥、模型名和 `jsonMode`         |
| 504    | 生成阶段超时                        | 调大 `timeout` / `llm.timeoutMs`，或换更快的模型  |
| 500    | 剧本成功但导出失败                  | 用响应里的 `story` 重新提交 `/api/v1/export`      |

`GET /api/v1/health` 的 `llm` 节会报告 `enabled`、`model`、`baseUrl`、`pipeline`、`apiKeyConfigured`、当前生成数和并发上限；`apiKeyConfigured=false` 时先设置 `MSS_LLM_API_KEY`。

模型名写错、动作名编造、JSON 截断是本地小模型最常见的问题。`single` 可以把 `repairRounds` 调到 3~4；`staged` 的台词/表演各只重写一次，仍失败时优先换更大的模型，而不是继续加轮数。
