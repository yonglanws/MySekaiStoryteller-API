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
  pipeline: staged # staged（默认） | hybrid | agent | single
  agentMaxSteps: 16
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
  - `hybrid` / `agent`（二者内部已合并为同一套**统一三段式上下文隔离 + 工具驱动管线**，`agent` 和 `agentic: true` 均作为向后兼容别名路由到此路径）：Phase 1 允许 1~4 轮只读工具自主核实重写人设、官方跨话剧情与云端素材并锁定 `StagedCastPlan` + `researchBrief`；Phase 2 **彻底丢弃 Phase 1 工具对话历史**，仅注入精炼规划与高占比重写人设写台词并做 `dialogueLinter` + 人设 Critic 自检；Phase 3 走确定性编译并由单一轻量导演终审做局部 `operations` 修补。详见下文 [统一三段式管线架构](#统一三段式上下文隔离与工具驱动架构hybrid--agent)。
  - `staged`（内置默认）：与上述共享 Phase 2/3 核心编译骨干，跳过 Phase 1 工具循环，直接用 `buildCastPrompt` + 预取 RAG 选角定纲。
  - `single`：快速选角后让模型一次把整份剧本写完（`mode: chat` 固定走 `single`），适合极速省流场景。
- **`agentMaxSteps`**：统一管线 Phase 1 允许的最大工具探索/迭代步数（`2~40`，默认 `16`）。
- **`jsonMode`**：`auto` 会先试着带 `response_format: { type: "json_object" }`，如果接口报错不支持就自动去掉重发。
- **`extraBody`**：原样塞进请求体。带深度思考开关的模型想加速可以写 `{"thinking":{"type":"disabled"}}`；如果开着高思考（如 Gemini `-high` 或带 `reasoning_effort`），记得把 `maxTokens` 调到 `16384`~`32768` 以上，不然思考 token 把额度吃光会导致 JSON 截断。
- **`polishDialogue`**：开启后会对生成的台词做 `dialogueLinter` 反套路与 OOC 质检，触发人设 Critic / 润色并在 Phase 3 启用长篇 `director-review` 导演终审。
- **`personaDirs` / `personas`**：放自定义/重写角色人设。`personaDirs` 会**递归扫描**各级子目录中的 `*.md` / `*.txt`（例如 5 个分团子目录下的不同世界线虚拟歌手与角色变体），解析可选 YAML frontmatter（`name`、`aliases`、`group`、`unit`）与所属分团；系统会自动剥离 AI 聊天机器人交互协议噪声（如打字聊天感、括号心理描写、禁止换行等提示词规范），并按阶段提纯注入：**Phase 2 台词阶段注入高达 `11,000` 字 `dialoguePersonaPrompt` 与 `extractPairwiseAddressBook` 两两官称呼表，表演阶段注入 `actingPersonaPrompt`**，避免角色被模型预训练先验同化。

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

### 1. 统一三段式上下文隔离与工具驱动架构（`hybrid` / `agent`）

`StoryWriter` 已将原 `hybrid` 与 `agent` 合并为唯一一套**三段式上下文隔离 + 工具驱动流水线**（`staged` 沿用 Phase 2/3 核心编译骨干），同时消除早期 Agent 手写百条原始 JSON 与双重终审的冗余成本：

```text
Phase 1: runPhase1Exploration（仅 hybrid / agent / agentic: true 启用）
   ├── 精简只读工具（1~4 轮）：lookup_character · search_official_corpus（含 mode:"expand"）· search_assets
   ├── 输出并锁定结构化 StagedCastPlan + researchBrief（按分团消歧虚拟歌手与服装变体）
   └── 若网关不支持原生 tools：自动切换 ReAct JSON 协议，或优雅降级 staged-fallback（buildCastPrompt + RAG）
   │
   ▼  【严格上下文隔离：彻底丢弃 Phase 1 工具调用对话历史】
Phase 2: 纯净上下文写词 + 人设自检
   ├── dialogue：仅注入 researchBrief + dialoguePersonaPrompt（11,000 字上限）+ pairwiseAddress + 三分区 RAG
   ├── 后处理：不足字数自动扩写、过碎短句合并、标点柔化、剥离口头括号动作
   └── dialogueLinter + dialogue-polish / dialogue-persona-critic：修复 OOC、官称偏离（如 绘名名）、AI 腔
   │
   ▼
Phase 3: 确定性工作流编译 + 单一轻量导演终审闭环
   ├── 并行 stage：VoiceDirection（情绪/语速） + Staging（切镜/环境/BGM/SE） + translateDialogue（日文 ttsText）
   ├── Direction：注入 actingPersonaPrompt，按真实 motion3 曲线与单拍错峰规则配表情动作
   ├── composeStory → alignStoryTtsEmotionsAndCaptions → validateAndFixStory
   └── director-review：合并 auditStoryActingAndFidelity 与局部推荐（onlyIssues），以局部 operations 外科修补收口
```

### 2. 针对常见“AI 味”痛点的专项优化

- **表情不再乱配或笑场（`facialSemantics.ts`）**：校验与提示词会直接检查模型实际的 `.motion3.json` 曲线，区分“真开心笑”“苦笑/勉强笑”“闭眼微笑”和“阴沉/冷脸/空洞”表情；严肃、道歉、压抑或克制角色的台词会被拦住，不再误配或被兜底回填成笑脸。
- **不再强行凑 2~3 幕**：日常连续对话默认 1 个场景到底，只有地点、时间或回忆真的跳转时才加转场和换背景，不搞机械“三幕指标”。
- **允许 2 人剧里的单人特写（Cutaway）**：双人对话不再死板要求两人从头站到尾；遇到内心独白或单独反应时，角色可以切到单人 `Center`（通过退场/移动切换），独白完再切回双人 `Left`/`Right` 对话，并自动先关闭对话框再切位。
- **双人不再“一个人全程木头人”**：修复了之前监听者动作被过度砍掉、以及 `Move` 动作被丢弃的问题；同时通过 `validateActions` 错开调度——避免两人同一拍（`at: 0`）同时抢动作，实在冲突的听者反应会自动拆成台词后的独立 `Motion` 片段，补齐几乎没动过的另一位角色。
- **说出口的话里绝不带 `(微笑)` / `（挠头）`**：提示词、质检器（`dialogueLinter.ts`）、自动修复和日语翻译都统一清理口头台词里的括号动作描写，同时**保留**整句的 `（……心里话）` 内心独白。
- **TTS 情绪与语速更稳**：情绪标注会按段平滑，抑制同一角色相邻句之间剧烈跳情绪和 `ttsSpeed` 大幅跳变（相邻跳变限制在 `<= 0.08`），平静句也不会乱开高强度 `ttsSpecialScene`。

### 3. 向后兼容说明（`src/host/ai/agentTools.ts`）

- 外部继续传入 `pipeline: "agent"`、`pipeline: "hybrid"` 或 `agentic: true` 时，`StoryWriter` 内部统一路由到上述三段式融合管线（`meta.pipeline` 保留调用方传入的别名；`meta.agentMode` 标注实际执行的 `native` / `react-json` / `staged-fallback`，`meta.toolCalls` 与 `meta.agentSteps` 记录 Phase 1 工具调用详情）。
- `agentTools.ts` 的 `search_assets`、`lookup_character`、`search_official_corpus` 也与统一管线共用一套 `CatalogView`、分团虚拟歌手消歧和 RAG 检索内核。

---

## HTTP 接口用法

### 仅生成剧本：`POST /api/v1/script/generate`

```bash
curl -sS -X POST http://127.0.0.1:9881/api/v1/script/generate \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "放学后的天台，瑞希和绘名聊起下次 Live",
    "mode": "story",
    "pipeline": "hybrid",
    "targetMinutes": 3,
    "timeout": 600000
  }'
```

| 字段              | 必填 | 说明                                                                                       |
| ----------------- | ---- | ------------------------------------------------------------------------------------------ |
| `prompt`          | 是   | 场景描述或聊天消息                                                                         |
| `mode`            | 否   | `story`（默认，短剧）或 `chat`（角色对话）                                                 |
| `cast`            | 否   | 强制指定可选角色（支持名字、简称、数字 id 或云端模型片段）                                 |
| `targetMinutes`   | 否   | 覆盖配置里的 `targetMinutes`                                                               |
| `history`         | 否   | `chat` 模式用的历史消息 `[{role, content}]`                                                |
| `translateForTts` | 否   | 默认 `true`；传 `false` 可跳过日语翻译                                                     |
| `pipeline`        | 否   | `staged` / `hybrid` / `agent`（均走统一管线，`hybrid`/`agent` 开 Phase 1）或 `single`      |
| `agentic`         | 否   | 布尔值；传入 `true` 等价启用工具驱动 `hybrid`/`agent` 模式                                 |
| `maxToolTurns`    | 否   | 整数 `2~40`（兼容 `agentMaxSteps`）；覆盖 Phase 1 最大工具轮次                             |
| `directorReview`  | 否   | 布尔值；显式开关 Phase 3 导演终审（缺省时仅 `polishDialogue: true` 且台词 `>= 12` 句开启） |
| `timeout`         | 否   | 生成超时毫秒数，默认 `600000`，上限 `1800000`                                              |

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
