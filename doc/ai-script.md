# 宿主内置 AI 剧本生成

[返回文档总览](README.md) · [API 参考](api.md) · [云端资源获取](cloud-assets.md)

配好 `llm` 后，你只需要发一句场景描述（比如“放学后的天台，瑞希和绘名聊起下次 Live”），宿主就能自动完成选角、写台词、配表情动作、切镜头、翻译日语配音文本并按官方规则质检修复，最后输出标准剧本 JSON 或直接导出 MP4。

## 基础配置

在 `config.yaml` 里配置 `llm`（密钥**只从环境变量读取**，不要写进文件）：

```bash
export MSS_LLM_API_KEY=sk-...
# 本地跑 Ollama 的话：
export MSS_LLM_BASE_URL=http://127.0.0.1:11434/v1
export MSS_LLM_MODEL=qwen2.5:32b
```

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
  pipeline: staged # staged（默认） | single
  jsonMode: auto # auto | on | off
  translateForTts: true
  polishDialogue: true
  targetMinutes: 3
  systemPrompt: ''
  extraBody: {} # 比如 {"thinking":{"type":"disabled"}}
  personaDirs: []
  personas: []
```

关键项解释（说人话版）：

- **`baseUrl`**：填根地址就行（兼容 OpenAI、new-api、one-api、Ollama、vLLM），宿主会自动拼 `/chat/completions`，别自己再写一遍。
- **`pipeline`**：
  - `staged`（默认）：拆成多个小步骤做，选角 → 写台词 → 三路并行（情绪/舞台/翻译）→ 配动作表情 → 合成校验。台词和演出分开写，最稳、质量最好。
  - `single`：先快速选人，再让模型一次把整份剧本吐出来（`mode: chat` 时固定走 `single`）。适合想省请求次数时用。
  - 另：`StoryWriter`（`src/host/ai/storyWriter.ts`）内部还提供了 **`agent` 工具调用模式**（`pipeline: 'agent'` 或 `agentic: true`），详见下文 [Agent 工具调用架构](#agent-工具调用架构)。
- **`jsonMode`**：`auto` 会先试着带 `response_format: { type: "json_object" }`，如果接口报错不支持就自动去掉重发。
- **`extraBody`**：原样塞进请求体。带深度思考开关的模型想加速可以写 `{"thinking":{"type":"disabled"}}`；如果开着高思考（如 Gemini `-high`），记得把 `maxTokens` 调到 `32768` 以上，不然思考 token 把额度吃光会导致 JSON 截断。
- **`polishDialogue`**：开启后会对生成的台词做反套路质检，发现模板腔或舞台腔时自动做局部润色。
- **`personaDirs` / `personas`**：放自定义角色人设。`personaDirs` 会读取里面的 `*.md` / `*.txt`，优先看文件头的 YAML frontmatter（`name`、`aliases`、`group`），没有就用文件名。长人设会自动提取“核心机制 / 语言与风格 / 角色档案 / 核心禁忌”这几段（每人最多 5,000 字），不会被废话稀释语气。

人设文件长这样：

```markdown
---
name: 晓山瑞希
aliases: [瑞希, mizuki]
---

说话轻快活泼，喜欢开玩笑……
```

## 语义 RAG（官方剧情参考检索）

`config.yaml` 的 `llm.rag` 默认开启，用来在写台词前检索官方 PJSK 剧情片段和角色设定，让模型参考官方口吻和相处方式（严格限制在 PJSK 领域，不会抄袭具体剧情）。

- **两阶段检索**：一阶段用 `qwen3-embedding-8b` + 混合词法检索召回，配增量 SQ8 磁盘缓存（`cacheDir: cache/rag`）；二阶段用 `qwen3-reranker-8b`（`rerank.endpointPath: /rerank`）做 Cross-Encoder 重排，并按分数曲线自适应截断与前后扩块。
- **自动降级**：如果只配了聊天模型、没配 Embedding 或 Rerank 接口，开启 `fallbackLexical: true`（默认）时会自动降级为本地零网络消耗的 BM25 + CJK 二元组词法检索，不会阻塞生成。

---

## 当前 AI 导演是怎么把剧本写自然的

### 1. 五阶段流水线（`staged`，默认）

```text
Stage 1: cast        → 选人（1~5 人）、匹配服装、挑贴题背景与 BGM，按剧情需要分 1~3 幕
   │
Stage 2: dialogue    → 只写逐字台词（带入选角色核心人设与官方参考），定稿后字面锁定；
   │                   不足目标字数自动补写、过碎短句合并、标点柔化，剥离口头括号动作
   │
   ├── Stage 2.5a: emotion           → 低温 0.2 按段落打 TTS 情绪标签 + 平滑防抖
   ├── Stage 2.5b: staging           → 安排转场、环境色、音效、运镜、单人内心特写、双人轮换
   └── Stage 2.5c: translateDialogue → 并发批量把台词翻成日语 ttsText（每批 20 句，最多 3 并发）
   │
   ▼
Stage 3: direction   → 给每句配 Live2D 动作和表情（单拍句首、均衡双人动作、听者反应）
   │
   ▼
Stage 4/5: composeStory + validateAndFixStory + OfficialLinter
                     → 拼装完整 StoryData，纠偏资源名，按 7 项官方硬指标兜底修复
```

### 2. 针对常见“AI 味”痛点的专项优化

- **表情不再乱配或笑场（`facialSemantics.ts`）**：校验与提示词会直接检查模型实际的 `.motion3.json` 曲线，区分“真开心笑”“苦笑/勉强笑”“闭眼微笑”和“阴沉/冷脸/空洞”表情；严肃、道歉、压抑或克制角色的台词会被拦住，不再误配或被兜底回填成笑脸。
- **不再强行凑 2~3 幕**：日常连续对话默认 1 个场景到底，只有地点、时间或回忆真的跳转时才加转场和换背景，不搞机械“三幕指标”。
- **允许 2 人剧里的单人特写（Cutaway）**：双人对话不再死板要求两人从头站到尾；遇到内心独白或单独反应时，角色可以切到单人 `Center`（通过退场/移动切换），独白完再切回双人 `Left`/`Right` 对话，并自动先关闭对话框再切位。
- **双人不再“一个人全程木头人”**：修复了之前监听者动作被过度砍掉、以及 `Move` 动作被丢弃的问题；同时通过 `validateActions` 错开调度——避免两人同一拍（`at: 0`）同时抢动作，实在冲突的听者反应会自动拆成台词后的独立 `Motion` 片段，补齐几乎没动过的另一位角色。
- **说出口的话里绝不带 `(微笑)` / `（挠头）`**：提示词、质检器（`dialogueLinter.ts`）、自动修复和日语翻译都统一清理口头台词里的括号动作描写，同时**保留**整句的 `（……心里话）` 内心独白。
- **TTS 情绪与语速更稳**：情绪标注会按段平滑，抑制同一角色相邻句之间剧烈跳情绪和 `ttsSpeed` 大幅跳变（相邻跳变限制在 `<= 0.08`），平静句也不会乱开高强度 `ttsSpecialScene`。

### 3. Agent 工具调用架构（`src/host/ai/agentTools.ts`）

除了固定流水线，`StoryWriter` 现在还内置了一套 **Agent 式多轮工具调用循环**（通过 `StoryWriter.generate({ pipeline: 'agent' })` 或 `agentic: true` 触发），让模型在写剧本过程中主动查资料、先写先检再改：

- **6 个内置工具**：
  1. `lookup_character`：查角色资料、简称、模型 id 与服装列表
  2. `inspect_character_expressions`：查指定角色真实可用的动作与带语义标注的表情列表
  3. `search_assets`：按关键词或时段搜索背景、BGM 和 SE 音效
  4. `search_official_corpus`：检索官方 PJSK 对白和演出样本
  5. `validate_dialogue_draft`：检查台词草稿有没有括号动作漏网或明显毛病
  6. `validate_story_draft`：在提交最终剧本前跑完整 `validateAndFixStory` + `OfficialLinter` 检查并拿到具体修改意见
- **三层自动回退**（兼容各种大模型和代理）：
  1. 优先走 OpenAI 原生 `tools` / `tool_calls` 函数调用；
  2. 如果接口不支持 `tools`（返回 400/404/422/501 等），**自动切换到 ReAct JSON 文本协议**（`{"tool_call": ...}` / `{"final": ...}`）继续工具调用；
  3. 如果到达轮数上限还没收尾，自动回落到 `staged` 流水线兜底，保证不空手而归。

---

## HTTP 接口用法

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

| 字段              | 必填 | 说明                                                       |
| ----------------- | ---- | ---------------------------------------------------------- |
| `prompt`          | 是   | 场景描述或聊天消息                                         |
| `mode`            | 否   | `story`（默认，短剧）或 `chat`（角色对话）                 |
| `cast`            | 否   | 强制指定可选角色（支持名字、简称、数字 id 或云端模型片段） |
| `targetMinutes`   | 否   | 覆盖配置里的 `targetMinutes`                               |
| `history`         | 否   | `chat` 模式用的历史消息 `[{role, content}]`                |
| `translateForTts` | 否   | 默认 `true`；传 `false` 可跳过日语翻译                     |
| `pipeline`        | 否   | `staged` 或 `single`（`chat` 模式固定走 `single`）         |
| `timeout`         | 否   | 生成超时毫秒数，默认 `600000`，上限 `1800000`              |

### 一句话生成并导出视频：`POST /api/v1/generate`

请求字段同上，额外支持 `scriptTimeout`（默认 `600000`）和 `exportTimeout`（正整数，默认 `1800000`）。

返回里除了视频字段（`videoPath`、`downloadUrl`、`timings`、`duration` 等），还会带上生成的 `story`、`meta` 和落盘的 `scriptPath`。万一剧本生成好了但渲染环节报错（HTTP 500），响应体里依然会保留 `story` 和 `meta`，拿着这份 `story` 直接调 `/api/v1/export` 重试就行，不用再花一遍 LLM token。

---

## 怎么看耗时与评测脚本

- `meta.stages[]`：记录每个阶段用的模型、耗时、token 和是否成功。
- `meta.latencyMs` 是各次 LLM 调用耗时累加（并行阶段会大于实际等待时间）；**`meta.durationMs` 才是实际总等待毫秒数**。

开发调优用的官方语料与 AI 评测脚本在 `scripts/stories/`：

```bash
# 拉取官方活动语料并计算基线（建议放仓库外）
node scripts/stories/fetch-official-corpus.mjs --out D:/msst-lab/corpus
node scripts/stories/official-metrics.mjs --corpus D:/msst-lab/corpus --out D:/msst-lab/official-baseline.json

# 跑批量 AI 生成评测
MSS_LLM_API_KEY=... MSS_LLM_BASE_URL=... \
  node scripts/stories/ai-eval.mjs --runs 1 --out D:/msst-lab/runs/latest

# 跑回归测试
npm run test:stories
```
