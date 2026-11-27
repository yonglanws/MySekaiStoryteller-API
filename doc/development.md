# 开发与验证

[返回 README](../README.md) · [部署指南](host-deployment.md) · [故事文件格式](story-format.md)

## 源码结构

```text
config.example.yaml   配置模板（复制为 config.yaml，正式配置不提交）
src/host/             Node 宿主：HTTP API、静态资源、桥接路由、渲染池
src/host/ai/          内置 AI 编剧（unified hybrid/agent 三段式上下文隔离、staged/single、表情语义、Linter）
src/host/rag/         自适应语义 RAG（Embedding + Rerank + SQ8 缓存 + 词法回退）
src/host/assets/      云端目录、cloudOnly 隔离、按需下载、Moesekai/exmeaning 拉取与 motion3 转换
src/host/tools/       离线拉取 CLI（fetchAssets / fetchMedia）
src/host/export/      原生 Rust 导出器 N-API 封装（rustExporter.ts）
native/mss-export-rs/ 原生 Rust 工作区（mss-core / mss-audio / mss-encode / mss-napi）
src/webrender/        无头浏览器加载的渲染入口页面
src/renderer/         PixiJS + Live2D 渲染引擎与导出管线（WebCodecs / GpuYuv420 / 帧管道 / 混音）
src/common/           宿主与渲染端共用的 Story 类型、60fps 官方时序与音频工具
src/shared/           共享 ffmpeg 封装
resources/            本地素材或 cloud/ 按需缓存（空目录或 cloudOnly 模式均可直接运行）
scripts/              单元测试、性能基准（bench-export.mjs）、AI 评测与离线索引脚本
```

## 构建与类型检查

```bash
npm ci
npm run typecheck    # 同时检查 host 与 web 两套 tsconfig
npm run build        # typecheck + vite build (out/webrenderer/) + tsc (out-host/)
npm run build:rust   # 编译并安装原生 Rust N-API 扩展（native/mss-export-rs）
npm run lint         # ESLint 检查
npm run format:check # Prettier 格式检查
```

## 自动化测试

无需启动服务或桌面环境即可运行全套回归测试：

```bash
npm run test:all
npm run test:rust    # Rust 工作区单元测试
npm run test:stories # 官方基线、人格加载与 AI 剧本回归测试
```

按模块单独跑：

| 命令                    | 覆盖范围                                                                |
| ----------------------- | ----------------------------------------------------------------------- |
| `npm test`              | 核心 API、导出超时、ffmpeg 安全、Irodori 校验、云端目录与零本地集成测试 |
| `npm run test:pool`     | 渲染池排队、取消、超时、并发隔离与 worker 恢复                          |
| `npm run test:config`   | 配置解析、BGM 覆盖与云端合并                                            |
| `npm run test:tts`      | GPT-SoVITS 权重租约测试                                                 |
| `npm run test:export`   | 虚拟时钟导出、并发 TTS 预热、WebCodecs 探测与回退                       |
| `npm run test:renderer` | 60fps 时序、Talk 口型、布局、表情隔离、动作不打断与导出日志             |
| `npm run test:stories`  | 官方基线与 AI 剧本质量回归测试（在语料存在时执行）                      |

## 端到端与性能基准测试

先 `npm run build && npm start` 把服务跑起来，再另开终端跑：

```bash
# 端到端导出检查（支持自备故事文件）
MSS_E2E_STORY=./resources/stories/your-story.sekai-story.json npm run e2e

# 并发导出测试（比如同时提交 2 个）
MSS_E2E_STORY=./resources/stories/your-story.sekai-story.json node scripts/test-parallel.mjs 2

# 导出耗时基准测试（打印 wallMs、phaseTimings 和 ffprobe 媒体信息）
node scripts/bench-export.mjs http://127.0.0.1:9881 ./your-story.sekai-story.json baseline
```

PowerShell 指定环境变量写法：

```powershell
$env:MSS_API_URL = 'http://127.0.0.1:9881'
$env:MSS_E2E_STORY = './resources/stories/your-story.sekai-story.json'
npm run e2e
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

| 想改什么                           | 去哪找                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| HTTP 接口、状态查询、下载与清理    | `src/host/servers/VideoApiServer.ts`、`src/host/main.ts`                                     |
| 渲染池调度、取消与 worker 回收     | `src/host/pool/renderPool.ts`                                                                |
| 主配置项与 `MSS_*` 环境变量        | `src/host/config.ts`                                                                         |
| 资源清单合并与云端目录             | `src/host/resources/resourceCatalog.ts`、`src/host/assets/`                                  |
| AI 提示词、Agent 工具调用与 Linter | `src/host/ai/`                                                                               |
| 故事字段与校验规则                 | `src/common/types/Story.ts`                                                                  |
| Live2D 动作/表情混合与隔离         | `src/renderer/src/model/AdvancedModel.ts`、`src/renderer/src/managers/AnimationManager.ts`   |
| 虚拟时钟、TTS 合成与视频导出管线   | `src/renderer/src/managers/VideoExportManager.ts`、`src/renderer/src/managers/video-export/` |
| ffmpeg 管道与编码参数              | `src/shared/ffmpeg.ts`、`src/host/bridge/bridgeRoutes.ts`                                    |
