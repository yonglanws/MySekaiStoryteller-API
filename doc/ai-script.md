# 宿主内置 AI 剧本生成

[返回文档索引](README.md) · [API 参考](api.md) · [云端资源获取](cloud-assets.md)

宿主支持直接接收一句场景描述，在全云端（或混合本地）资源目录下完成 **资源目录读取 → 五阶段导演流水线 → 校验与官方不变量修正**，输出标准 `StoryData` JSON 或直接提交渲染队列导出 MP4。

AstrBot 插件直接调用宿主的 `POST /api/v1/script/generate`、`POST /api/v1/generate` 与 `POST /api/v1/export`，不需要在插件进程内重复维护提示词或资源白名单（见 [astrbot_plugin_msst](https://github.com/yonglanws/astrbot_plugin_msst)）。

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
  extraBody: {} # 原样并入请求体，例如 {"thinking":{"type":"disabled"}}
  personaDirs: []
  personas: []
```

密钥只从环境变量读取，不写进 `config.yaml`：

```bash
export MSS_LLM_API_KEY=sk-...
# 如指向本地 Ollama：
export MSS_LLM_BASE_URL=http://127.0.0.1:11434/v1
export MSS_LLM_MODEL=qwen2.5:32b
```

| 配置              | 说明                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`         | 关闭后 `/api/v1/script/generate` 与 `/api/v1/generate` 返回 HTTP 422                                                                                                                        |
| `baseUrl`         | OpenAI Chat Completions 根地址，宿主请求 `<baseUrl>/chat/completions`（兼容 OpenAI、new-api、one-api、Ollama、vLLM 等）                                                                     |
| `pipeline`        | `staged`（默认）：5 阶段导演流水线；`single`：先快速选角再一次生成完整剧本；`chat` 模式始终走 `single`                                                                                      |
| `jsonMode`        | `auto` 先带 `response_format=json_object` 并在服务端拒绝时自动退回；`on` 强制携带；`off` 不发送                                                                                             |
| `repairRounds`    | `single` 校验失败时的重写轮数；`staged` 在台词/表演/情绪分段阶段分别按需最多重写/补写                                                                                                       |
| `translateForTts` | 为缺失或非日文的 `ttsText` 批量翻译日语（每批 20 条，最多 3 批并发；纯标点台词跳过）                                                                                                        |
| `targetMinutes`   | 目标成片分钟数（写入提示词并换算台词数与字数下限）                                                                                                                                          |
| `extraBody`       | 原样并入请求体。对带思考开关的推理模型可设为 `{"thinking":{"type":"disabled"}}` 降延迟；使用 Gemini `-high` 等高思考模型时，建议把 `maxTokens` 调至 `32768` 以上以免 JSON 被思考 token 截断 |
| `personaDirs`     | 读取目录下 `*.md` / `*.txt`，以文件名或 frontmatter `name` 匹配角色（长人设自动提取核心机制/语言与风格/角色档案/核心禁忌，每人截断在 5,000 字符内）                                         |
| `personas`        | 内联人设列表：`name`、`prompt`、`aliases`、`group`                                                                                                                                          |
| `systemPrompt`    | `single` 覆盖内置系统提示词；`staged` 追加到各阶段系统提示词末尾                                                                                                                            |

人设文件示例：

```markdown
---
name: 晓山瑞希
aliases: [瑞希, mizuki]
---

外貌、性格、说话风格、口头禅、禁忌、表情倾向……
```

## 五阶段 AI 导演流水线（`staged` 默认）

当前 `src/host/ai/staged.ts` 与 `storyWriter.ts` 实现为 **5 阶段** 流水线（含第 2.5 阶段三路并行）：

```text
Stage 1: cast（选角与 2~3 幕节奏表）
   │
Stage 2: dialogue（逐字对白定稿 + 长度补写/短句合并/标点柔化）
   │
   ├─── Stage 2.5a: emotion（低温 0.2 分段标注 TTS 情绪）
   ├─── Stage 2.5b: staging（directStaging：分幕转场、Normal <=2 轮换、运镜、SE）
   └─── Stage 2.5c: translateDialogue（并行批量翻译日文 ttsText）
   │
   ▼ （等待 emotion + staging 回填后）
Stage 3: direction（directActing：逐句动作/表情、约 20% 2拍微表演、听者反应）
   │
   ▼ （汇合 translateDialogue）
Stage 4/5: composeStory + validateAndFixStory + OfficialLinter（编译官方时间线并校验七项硬指标）
```

### 各阶段职责

1. **Stage 1 — `cast`（选角与分幕节奏表，`planEpisode`）**
   - 从 26 位主角色（含多服装类别标签，如 `[服装: 校服=..., 私服=...]`）及可选 48 位配角中，按场景挑选 **2~5 名**角色（双人对话选 2 人；团体/活动向选 3~5 人；仅明确独白选 1 人），并按场景关键词自动匹配对应服装变体。
   - 使用语义打分与分类分桶（`imagePromptChoices` / `bgmPromptChoices`），从 1,401 张背景（按地点/时段/室内外打分，默认排除纯色幕布与剧情插画）与 421 首 BGM（覆盖全部情绪族）中精选最贴题的候选放入提示词。
   - 规划 **2~3 幕（`scenes`）**：明确每幕 `background`、`ambient`（`normal`/`evening`/`night`）、`telop` / `placeInfo`、`transitionIn`（`black`/`sideFade`/`flashback`/`sekaiIn`/`sekaiOut`/`white`）、`activeCast`（1~2 人）、`bgm`（含 `silence` 留白）及 `scenarioEffect`。

2. **Stage 2 — `dialogue`（逐字台词定稿，`writeDialogue`）**
   - 仅携带本场入选角色的核心人设段落与官方团体 few-shot 台词样本（`corpusExamples.ts`），用 `turns` 结构输出 1~6 句连续对白。
   - 台词定稿后**逐字锁定**，后续舞台/演技阶段不可改写台词正文；若句数或字数低于目标（`targetMinutes * 10` 句 / `targetMinutes * 250` 字）自动触发 `dialogue-expand` 补写；若平均句长过短则通过 `condenseDialogue` 合并同角色相邻短句；`softenPunctuation` 柔化部分句末标点以贴近官方停顿分布。

3. **Stage 2.5 — 三路并行（`emotion` + `staging` + `translateDialogue`）**
   - **`emotion`**：仅在配置了 TTS 情绪标签时启动，低温（`0.2`）按 5~10 句段落输出 `segments`，随后由 `stabilizeEmotions` 强制最短连续段、同说话人抖动贴回、强情绪配额与平静回落。
   - **`staging`（`directStaging`）**：根据完整台词与分幕计划编排具体幕次转场（`fromLineId`）、`AmbientColor`、`Telop` / `PlaceInfo`、`PlaySe`（来自 1,942 条 SE 语义库与精选 cue）、`Move`（`stepCloser` / `stepBack` / `shiftSlot`）、`CameraZoom` / `CameraMove` / `ShakeWindow` / `ShakeScreen`、`hologram` 全息 shader、静默反应与 `bgmCut`。
     - **2 人场景**：强制全程双人同台（`Left` / `Right`），不中途退场切换。
     - **3~5 人团体场景**：始终保持 **`Normal` 模式（同时最多 2 人同台）**，通过 `stageGroup` 在幕次或对话轮换节点以 `LayoutClear` + `LayoutAppear` **原地交叠淡出/淡入**切换在场角色，匹配 PJSK `pjsk.moe` 官方演出表现。
   - **`translateDialogue`**：台词定稿后立即异步启动，每批 20 条、最多 3 批并发将缺失或非日文的 `ttsText` 翻译为日语。

4. **Stage 3 — `direction`（精细演技导演，`directActing`）**
   - 携带已回填的情绪标签与分幕舞台上下文，以及按语义簇裁剪的动作/表情完整名称（防止模型编造不存在的编号）。
   - 为约 60% 句子设计句首动作与表情，为约 20% 较长或带语气转折的句子增加 `at2`（0.45~0.75）两拍微表演（`motion2`/`facial2`），为约 15%~20% 句子分配同台听者反应（`listener`），并避开刚入场 0.4s 内的重复身体动作。

5. **Stage 4/5 — `composeStory` + `validateAndFixStory` + `OfficialLinter`**
   - 将选角、台词、情绪、舞台调度与演技导演合并为完整 `StoryData` 时间线。
   - `validateAndFixStory` 负责路径与模型 id 对齐、云端背景/BGM/服装/SE 名收束（校验器全量覆盖 511 模型、1,401 背景、421 BGM 与 1,942 SE）、动作/表情名称自动纠偏、`sanitizeDisplayText`（30 字宽优先在标点后折行）与超 3 行 `Talk` 拆分。
   - `enforceOfficialStoryInvariants`（`OfficialLinter`）核查并自动修复 **7 项官方演出硬不变量**：
     1. `Talk.delay == 0` 占比 ≥ 85%（清除机械 `0.1/0.15s` 小停顿，保留 `≥0.5s` 刻意留白）。
     2. 零 `±100px` Slow 滑入/滑出（统一转为 `from == to, offset: 0` 原地淡入/淡出）。
     3. `LayoutAppear` 带入场动作后 `< 0.4s` 内不重复触发同角色 body motion（避免双重抽搐）。
     4. 转场（`BlackOut` / `SideFade Out` / `SekaiOut` / `Telop`）与静默动作前自动设置 `closeWindowOnFinish`。
     5. `FlashbackIn/Out`、`SepiaIn/Out`、`SideFade Out/In`、`SekaiOut/In`、`ShakeScreen/Stop`、Shader、Camera 必须成对闭合。
     6. 全部动作与表情必须真实存在于实时 `CatalogView` 目录中。
     7. `Normal` 模式同台人数 ≤ 2 且槽位（`Left`/`Right`/`Center`）无冲突。

### `single` 与 `chat` 模式

当设置 `pipeline: single` 或 `mode: chat` 时，宿主会先执行轻量级 `resolveFastCast`（优先级：场景点名 → 沿用对话历史角色 → 一次低温快速选角调用，将候选角色缩到 `story <= 4`、`chat <= 2` 人），再单次调用 LLM 生成完整剧本并经过同样的 `validateAndFixStory` + `OfficialLinter` + `translateForTts` 流程。

## 接口调用示例

### 仅生成剧本：`POST /api/v1/script/generate`

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

| 请求字段          | 必填 | 说明                                                   |
| ----------------- | ---- | ------------------------------------------------------ |
| `prompt`          | 是   | 场景描述或用户消息                                     |
| `mode`            | 否   | `story`（默认，约 3 分钟短剧）或 `chat`（角色对话）    |
| `cast`            | 否   | 限定可选角色：角色名、简称、数字 id 或云端模型 id 片段 |
| `targetMinutes`   | 否   | 覆盖 `llm.targetMinutes`                               |
| `history`         | 否   | `chat` 模式历史消息 `[{role, content}]`                |
| `translateForTts` | 否   | 默认 `true`；设为 `false` 跳过日语翻译                 |
| `pipeline`        | 否   | `staged` 或 `single`；`chat` 模式固定使用 `single`     |
| `timeout`         | 否   | 生成超时（毫秒），默认 `600000`，上限 `1800000`        |

### 一句话生成并导出视频：`POST /api/v1/generate`

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

响应同时返回导出结果（`videoPath`、`fileSize`、`duration`、`frameCount`、`timings`、`logPath`、`logJsonPath`、`reportPath`、`downloadUrl`）以及 `story`、`meta`、`scriptPath`。
若剧本生成成功但视频导出失败，接口返回 HTTP 500 并在响应体保留 `story` 和 `meta`，调用方可直接持 `story` 重试 `/api/v1/export`，无需重复消耗 LLM。

### 观测与耗时

- 响应 `meta.stages[]` 记录每次调用的 `stage`（如 `cast`、`dialogue`、`emotion`、`staging`、`direction`）、`model`、`latencyMs`、`usage` 与 `ok`。
- `meta.latencyMs` 为各次 LLM 调用耗时之和（Stage 2.5 并行时会大于实际墙钟）；`meta.durationMs` 才是实际端到端生成墙钟耗时。

## 质量评测与回归

仓库在 `scripts/stories/` 下提供官方语料基线与 AI 评测脚本（语料与报告存放于仓库外）：

```bash
# 1. 拉取官方活动剧情（JP 结构 + CN 文本）
node scripts/stories/fetch-official-corpus.mjs --out D:/msst-lab/corpus

# 2. 统计官方基线分布
node scripts/stories/official-metrics.mjs \
  --corpus D:/msst-lab/corpus --out D:/msst-lab/official-baseline.json

# 3. 批量运行 AI 评测场景
MSS_LLM_API_KEY=... MSS_LLM_BASE_URL=... \
  node scripts/stories/ai-eval.mjs --runs 1 --out D:/msst-lab/runs/latest

# 4. 回归门禁（语料/报告存在时执行，不存在时自动跳过）
npm run test:stories
```

## 错误与排查

| 状态码 | 含义                                  | 处理                                                      |
| ------ | ------------------------------------- | --------------------------------------------------------- |
| 422    | 生成/校验失败，或 `llm.enabled=false` | 查看 `details`；若提示 `cast` 无法匹配，检查角色名/id     |
| 429    | 并发生成达到上限                      | 上限为 `max(1, min(4, render.workers))`，等待当前生成完成 |
| 502    | LLM 网络或 HTTP 错误                  | 检查 `baseUrl`、`MSS_LLM_API_KEY`、模型名与 `jsonMode`    |
| 504    | 生成阶段超时                          | 调大 `timeout` / `scriptTimeout` 或 `llm.timeoutMs`       |
| 500    | 剧本生成成功但导出失败                | 使用响应中的 `story` 重新提交 `/api/v1/export`            |

通过 `GET /api/v1/health` 的 `llm` 字段可检查 `enabled`、`model`、`baseUrl`、`pipeline`、`apiKeyConfigured`、`activeGenerations` 与 `maxConcurrent`。
