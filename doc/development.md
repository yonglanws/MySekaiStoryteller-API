# 开发与验证

[返回 README](../README.md) · [系统架构指南](architecture.md) · [部署指南](host-deployment.md) · [贡献指南](../CONTRIBUTING.md)

## 源码结构

```text
config.example.yaml            配置模板（复制为 config.yaml，正式配置不提交）
.env.example                   环境变量模板（npm start 自动加载根目录 .env）
personas/pjsk/                 内置 58 份 PJSK 角色人设（含 5 个分团虚拟歌手子目录，自动发现）
src/host/                      Node 宿主入口（main.ts、config.ts、.env 加载）
  ├─ servers/                  VideoApiServer.ts + 模块化路由 routes/{assetRoutes,aiRoutes,ttsLeaseRoutes}.ts
  ├─ bridge/                   渲染桥接层：bridgeRoutes.ts、bridgeSecurity.ts、bridgeLifecycle.ts、wsHub.ts
  ├─ pool/                     Playwright 无头渲染池（renderPool.ts）
  ├─ ai/                       内置 AI 编剧（storyWriter.ts、personas.ts、facialSemantics.ts、officialLinter.ts、validate.ts）
  │   ├─ staged/               多阶段编译子模块（types、helpers、cast、dialogue、voiceDirection、staging、direction、composer、directorReview）
  │   └─ agent/                Phase 1 工具探索与表演审计（actingAudit、toolkit、phase1Explore）
  ├─ rag/                      自适应语义 RAG（Embedding + Rerank + SQ8 缓存 + 词法回退）
  ├─ assets/                   云端目录、cloudOnly 隔离、按需下载、Moesekai/exmeaning 拉取与 motion3 转换
  ├─ tools/                    离线拉取 CLI（fetchAssets / fetchMedia）
  └─ export/                   原生 Rust 导出器 N-API / CLI 封装（rustExporter.ts）
native/mss-export-rs/          原生 Rust 工作区（mss-core / mss-audio / mss-encode / mss-bridge / mss-napi）
src/webrender/                 无头浏览器加载的渲染入口页面与 browser-bridge.ts
src/renderer/                  PixiJS + Live2D 渲染引擎与导出管线（WebCodecs / GpuYuv420 / BinaryWsClient / JpegFrameSink / 混音）
src/common/                    宿主与渲染端共用的 Story 类型、60fps 官方时序与逐帧计划
src/shared/                    共享 ffmpeg 封装
resources/                     本地素材或 cloud/ 按需缓存（空目录或 cloudOnly 模式均可直接运行）
scripts/                       自动发现测试、E2E 与基准脚本、离线索引构建与语料评测工具
```

> [!NOTE]
> 官方 AstrBot 插件 **`astrbot_plugin_msst`** 托管在独立仓库 [yonglanws/astrbot_plugin_msst](https://github.com/yonglanws/astrbot_plugin_msst)，本仓库的 `.gitignore` 与 ESLint/Prettier 忽略规则已显式忽略同名目录，方便开发者在本地并排调试而不会污染本仓库。

## 构建与类型检查

```bash
npm ci
npm run typecheck    # 同时检查 host 与 web 两套 tsconfig
npm run build        # typecheck + vite build (out/webrenderer/) + tsc (out-host/)
npm run build:rust   # 编译并安装原生 Rust N-API 扩展（native/mss-export-rs）
npm run lint         # ESLint 检查
npm run format:check # Prettier 格式检查（npm run format 可自动格式化）
```

## 自动化测试

无需启动服务或桌面环境即可运行全套回归测试。测试脚本由 `scripts/run-tests.mjs` 自动发现 `scripts/**/*.test.mjs`（默认排除需要外部语料的 `scripts/stories/`，新增测试文件自动纳入，无需手工维护文件名清单）：

```bash
npm run test:all     # 自动发现并运行全部单元测试（api / ai / assets / audio / config / export / rag / renderer / pool）
npm run test:rust    # Rust 工作区单元测试（cargo test）
npm run test:stories # 官方基线、内置人设加载与 AI 剧本回归测试（无外部语料时自动跳过语料用例）
```

按模块单独跑：

| 命令                    | 覆盖范围                                                                 |
| ----------------------- | ------------------------------------------------------------------------ |
| `npm test`              | 核心 API、安全、人设、导出超时、Irodori 校验、云端目录与零本地集成测试   |
| `npm run test:pool`     | 渲染池排队、取消、超时、并发隔离与 worker 恢复                           |
| `npm run test:config`   | `.env` 加载、配置解析、BGM 覆盖、Docker 资产与云端合并                   |
| `npm run test:tts`      | GPT-SoVITS 权重租约测试                                                  |
| `npm run test:export`   | 虚拟时钟导出、并发 TTS 预热、WebCodecs、Rust 桥接与 `GpuYuv420Converter` |
| `npm run test:renderer` | 60fps / 30fps 时序、Talk 口型、布局、表情隔离、动作不打断与导出日志      |
| `npm run test:stories`  | 官方基线、表演保真度、内置人设与 AI 剧本质量回归测试                     |

也可直接调用运行器按子目录筛选：

```bash
node scripts/run-tests.mjs --group api
node scripts/run-tests.mjs --group ai
node scripts/run-tests.mjs --stories
```

## `scripts/` 目录分类说明

- **单元测试（`scripts/{ai,api,assets,audio,config,export,rag,renderer}/*.test.mjs` 与 `scripts/render-pool.test.mjs`）**：由 `scripts/run-tests.mjs` 自动发现执行，纯离线零外部依赖。
- **初始化与构建工具**：`scripts/init-config.mjs`（交互/无人值守配置向导）、`scripts/export/build-rust-exporter.mjs`（Rust N-API 编译与测试封装）。
- **端到端与性能基准**：`scripts/test-export.mjs`（`npm run e2e`，缺本地剧本时自动使用内置纯云端示例）、`scripts/test-parallel.mjs`（多任务真并行验证）、`scripts/bench-export.mjs`（导出耗时分解与 ffprobe 统计）。
- **离线语义索引构建器（`scripts/assets/build-*.mjs`）**：从官方语料重新生成 `src/host/assets/{background-names,bgm-semantics,model-se-semantics}.json`。
- **官方语料与 AI 质量评测（`scripts/stories/`）**：`fetch-official-corpus.mjs`、`official-metrics.mjs`、`official-plan-audit.mjs`、`ai-eval.mjs`、`dialogue-probe.mjs` 及配套回归测试（通过 `MSS_CORPUS_DIR` / `MSS_EVAL_REPORT` 指定仓库外语料，未配置时测试自动跳过）。

## 端到端与性能基准测试

先 `npm run build && npm start` 把服务跑起来，再另开终端跑：

```bash
# 端到端导出检查（未指定 MSS_E2E_STORY 且无本地 demo 时自动生成最小纯云端演示剧本）
npm run e2e

# 指定自定义故事文件
MSS_E2E_STORY=./resources/stories/your-story.sekai-story.json npm run e2e

# 并发导出测试（同时提交 2 个任务）
node scripts/test-parallel.mjs 2

# 导出耗时基准测试（打印 wallMs、phaseTimings 和 ffprobe 媒体信息）
node scripts/bench-export.mjs http://127.0.0.1:9881 ./your-story.sekai-story.json baseline
```

PowerShell 指定环境变量写法：

```powershell
$env:MSS_API_URL = 'http://127.0.0.1:9881'
$env:MSS_E2E_STORY = './resources/stories/your-story.sekai-story.json'
npm.cmd run e2e
```

## 常用媒体核查命令（本地检查成片）

```bash
# 查看音视频流编码、分辨率、帧率和精确时长
ffprobe -v error -show_format -show_streams -of json output.mp4

# 完整解码一遍检查有没有坏帧
ffmpeg -v error -i output.mp4 -f null -

# 检查音轨音量
ffmpeg -i output.mp4 -vn -af volumedetect -f null -
```

## 改动定位速查

| 想改什么                                 | 去哪找                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| HTTP 核心导出/文件/下载/健康检查         | `src/host/servers/VideoApiServer.ts`、`src/host/main.ts`                                                  |
| 资源/AI/TTS 租约扩展路由                 | `src/host/servers/routes/{assetRoutes,aiRoutes,ttsLeaseRoutes}.ts`                                        |
| 桥接路由、安全校验与临时资源生命周期     | `src/host/bridge/{bridgeRoutes,bridgeSecurity,bridgeLifecycle,wsHub}.ts`                                  |
| 渲染池调度、取消与 worker 回收           | `src/host/pool/renderPool.ts`                                                                             |
| 主配置项、`.env` 加载与 `MSS_*` 环境变量 | `src/host/config.ts`、`src/host/env.ts`                                                                   |
| 资源清单合并与云端目录                   | `src/host/resources/resourceCatalog.ts`、`src/host/assets/`                                               |
| AI 提示词、三段式编排、工具与人设        | `src/host/ai/{storyWriter,personas,staged.ts,agentTools.ts}`、`src/host/ai/staged/`、`src/host/ai/agent/` |
| 故事字段与校验规则                       | `src/common/types/Story.ts`                                                                               |
| Live2D 动作/表情混合与隔离               | `src/renderer/src/model/AdvancedModel.ts`、`src/renderer/src/managers/AnimationManager.ts`                |
| 虚拟时钟、TTS 合成与视频导出管线         | `src/renderer/src/managers/VideoExportManager.ts`、`src/renderer/src/managers/video-export/`              |
| 原生 Rust 编码/混音/二进制 WS 桥接       | `native/mss-export-rs/crates/{mss-core,mss-audio,mss-encode,mss-bridge,mss-napi}/`                        |
| ffmpeg 管道与编码参数                    | `src/shared/ffmpeg.ts`、`src/host/export/rustExporter.ts`                                                 |
