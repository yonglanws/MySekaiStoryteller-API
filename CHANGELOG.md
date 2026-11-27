# 更新日志 / Changelog

本文件记录 **MySekaiStoryteller-API** 的主要版本变更。

---

## v1.0.0-beta1（架构大改首个公测版）

相较于早期的 `v0.1.0` / `v0.2.0`（纯基础 Playwright 渲染壳、依赖本地 `resources/` 素材包、无原生编码引擎、无内置 AI 编剧与人设），**`v1.0.0-beta1` 是一次从底层渲染引擎、原生导出加速、云端素材体系到 AI 自动编剧与容器化部署的全链路架构重写**。

### 核心架构对比（`v0.2.0` → `v1.0.0-beta1`）

| 维度                   | `v0.2.0`（旧版）                                         | `v1.0.0-beta1`（现行架构）                                                                                                                                                                                                                          |
| ---------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **素材来源**           | 需手工准备本地 `resources/` 模型、背景、BGM 与 YAML 清单 | **零本地素材开箱即用**：内置中文语义索引（574 模型 / 1,402 背景 / 421 BGM / 1,991 SE），按需云端物化，支持 `cloudOnly: true` 隔离与多镜像快速故障切换                                                                                               |
| **视频导出与音频引擎** | 仅浏览器截帧 + Node 调 `ffmpeg` 管道                     | **原生 Rust 导出与混音工作区（`native/mss-export-rs`，N-API 进程内直连）** + **GPU YUV420（3-slot PBO + `texSubImage2D`）** + **WebCodecs 直编 / Rust `/bridge/rs-stream` 二进制 WebSocket 推流** + 硬件编码缓存探测（NVENC / QSV / VAAPI / AMF）   |
| **演出与时序精度**     | 近似帧步进，30fps 与 60fps 动作速率不一致                | **官方 60Hz 虚拟时钟与逐帧计划（`src/common/official/`）**：对齐官方 Talk 自动推进、DOTween 22 种缓动、Live2D 动作/表情混合、自然眨眼呼吸、60Hz RMS 口型包络，30fps/60fps 演出速率严格一致                                                          |
| **AI 编剧与角色人设**  | 无内置 AI 编剧与人设库                                   | **内置 58 份 PJSK 重写角色人设（`personas/pjsk/`）** + **语义 RAG**（Embedding + Rerank + SQ8 缓存 + 本地词法回退）+ **统一三段式上下文隔离 AI 管线**（`staged` / `hybrid` / `agent` / `single`）+ 自动日语配音文案翻译                             |
| **TTS 语音合成**       | 仅基础接入                                               | 支持 **GPT-SoVITS**（含权重互斥租约）与 **IrodoriTTS**（LoRA、多参考音频、音色锁定、情绪标签与日语强校验），并行合成预热 + BGM 人声闪避混音                                                                                                         |
| **部署与运维**         | 仅宿主机手工配置                                         | **多阶段原生 `Dockerfile` + GPU Compose 预设（Intel / NVIDIA）**、纯环境变量零 `config.yaml` 启动、`npm run init` 交互式向导、`.env` 自动加载、低内存预设（`MSS_MEMORY_PROFILE=low`）、优雅停机排空（`503`）、HTTP `Range` 下载与 GitHub Actions CI |
| **代码模块化**         | 集中式大单文件与少量手动测试                             | 模块化目录（`routes/`、`bridge/{Security,Lifecycle}`、`ai/{staged,agent}/`、`video-export/`）、删除全部遗留 Electron 死代码、自动发现全量单测（`scripts/run-tests.mjs`，640+ Node 单测 + 27 Rust 单测）                                             |

### 重点新增与优化

#### 1. 原生 Rust 导出/混音/桥接引擎（`native/mss-export-rs/`）

- 新增 5 个 Rust crate：`mss-core`（60Hz 口型与时序）、`mss-audio`（多轨 BGM/SE/人声混音、人声闪避、重采样）、`mss-encode`（硬件编码探测缓存与管道编码/合流）、`mss-bridge`（内嵌 `/bridge/rs-stream` 二进制 WebSocket 服务）、`mss-napi`（Node.js 进程内 N-API 绑定，不可用时自动回退 CLI / JS `ffmpeg`）。
- Linux 无桌面环境下 `JpegFrameSink` 通过共享 `BinaryWsClient` 直连 Rust `/bridge/rs-stream` 推送 `rawvideo` 单帧与 16 字节零负载静帧重复包，消除旧 HTTP 管道的多重拷贝与往返停顿。
- 修复 `WebCodecsMp4Encoder` 在虚拟时钟下的定时器死锁，优化 `GpuYuv420Converter`（3-slot PBO、`texSubImage2D` 纹理复用与 `waitSync` 退避）。

#### 2. 零本地云端素材体系与高可用下载

- 内置 574 套 Live2D 模型、1,402 张带时段/室内外标签背景、421 首 BGM、1,991 条场景音效（SE）与 17 项官方 UI 贴图的语义索引，支持默认 `bgm00003` 兜底与 Unity `sse-motion.json` 无损转换。
- 新增 20 秒响应头 TTFB 超时 + 20 秒流式卡死超时 + `Content-Length` 截断校验，并在 `moesekai` 与 `media` 之间共享镜像健康偏好（`storage.pjsk.moe` ↔ `storage.exmeaning.com` 快速故障切换），支持损坏/残缺缓存自动修复与同角色安全回退。

#### 3. 内置 58 份 PJSK 人设与统一三段式 AI 编剧

- 仓库原生内置 `personas/pjsk/`（20 主角 + 30 份分团虚拟歌手 + 变体与配角），本地和 Docker `/app/personas/pjsk` 自动发现，支持通过 `llm.personaDirs` / `MSS_LLM_PERSONA_DIRS` 叠加覆盖或 `none` 禁用。
- 统一 `hybrid` 与 `agent` 为「三段式上下文隔离 + 工具驱动」管线：Phase 1 只读工具调研与定纲 → Phase 2 纯净上下文写词 + 人设自检润色 → Phase 3 并行声演/舞台/日语翻译 + 确定性编译 + 轻量导演终审修补（保留 `staged` 与 `single` 兼容）。
- 新增自适应语义 RAG（Embedding + Cross-Encoder Rerank + SQ8 磁盘缓存 + 本地 BM25 词法回退）与基于真实 `.motion3.json` 曲线的表情动作语义校验。

#### 4. 生产级 API、安全、Docker 与易用配置

- 新增交互式配置向导 `npm run init`（支持 `--non-interactive`）、宿主启动自动加载 `.env`（`src/host/env.ts`）、配置自检提示、`MSS_GPU_PROFILE`（`auto`/`intel`/`nvidia`/`amd`/`cpu`）与 `MSS_MEMORY_PROFILE=low`（适合 4~8 GB 内存主机/NAS）。
- 新增多阶段原生 `Dockerfile`、`docker-compose.yml`、`docker-compose.intel.yml`、`docker-compose.nvidia.yml` 与 `.env.example`，开箱自带 Chromium、Rust N-API、58 份人设、中文字体与 Mesa/VAAPI/Vulkan 驱动。
- 强化生产运维：`/api/v1/health` 未鉴权时自动脱敏本地路径、`SIGINT`/`SIGTERM` 优雅排空并以 `503` 拒收新请求、异步文件列表与 `/api/v1/download/:filename` 支持 HTTP `Range`（`206`/`416`）、自动发现测试运行器与 GitHub Actions CI。

### 从 `v0.2.0` 升级注意事项

- **配置文件迁移**：`config.example.yaml` 与 `.env.example` 新增了 `llm`、`rag`、`assets.cloudCatalog`/`cloudOnly`、`tts.irodori`、`bgm.volume`（默认 `0.35`）与 `render` 内存/GPU 参数；建议备份旧配置后运行 `npm run init` 或对照新模板迁移。
- **云端模式默认行为**：新配置模板与 Docker 默认开启 `assets.cloudOnly: true`（忽略本地 `resources/` 旧资产）。若需沿用本地自备素材，请显式设置 `assets.cloudOnly: false`（或 `MSS_ASSETS_CLOUD_ONLY=false`）。
- **API 与鉴权**：新增 `/api/v1/script/generate`、`/api/v1/generate`、`/api/v1/cloud/refresh`、`/api/v1/assets/*` 与 `/api/v1/tts/lease*`；公网或局域网暴露时请务必配置 `MSS_API_KEY` 与 CORS 白名单（详见 [SECURITY.md](SECURITY.md)）。
- **Node.js 与 Rust**：运行要求 **Node.js ≥ 20**；原生 Rust 引擎为可选加速（Docker 镜像自动内置；宿主机无 Rust 工具链时自动优雅回退至 `ffmpeg-static`）。

---

## v0.2.0 & v0.1.0

早期初始版本：基于 Playwright + PixiJS/Live2D 的基础无头 HTTP 渲染原型与 `ffmpeg` 导出封装。
