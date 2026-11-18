# 文档索引

[返回项目首页](../README.md)

首页提供项目介绍与快速开始，本目录按使用场景展开详细说明。示例中的端口、任务 ID、本地路径等均为示意值；仓库不附带渲染资源或示例剧本，但默认**零本地资源即可开箱即用**。

## 从哪里开始

### 首次部署与开箱试跑

1. 按 [项目首页的快速开始](../README.md#快速开始) 安装依赖、构建并启动宿主（空 `resources/` 目录即可直接运行）。
2. 如需调整并发、GPU 加速、环境变量或配置 systemd / Windows 常驻服务，见 [部署指南](host-deployment.md)。
3. 如需接入 TTS 配音或用本地素材覆盖云端默认项，见 [资源与音频配置](resources.md) 与 [云端资源获取](cloud-assets.md)。
4. 用 [API 参考](api.md) 发起 AI 一句话生成或提交剧本导出。

### 让宿主内置 AI 编剧

配置 `llm` 后，宿主可直接接收一句场景描述，通过 **5 阶段导演流水线** 完成选角分幕、逐字对白、并行情绪/舞台走位/日文翻译、精细演技与官方不变量校验，然后返回剧本 JSON 或直接导出视频。见 [宿主内置 AI 剧本生成](ai-script.md)。

### 接入机器人或其他客户端

先读 [API 参考](api.md)，了解同步/异步导出（`wait: false` 轮询）、Bearer 鉴权、限流、客户端断连取消与诊断产物路径；再读 [故事文件格式](story-format.md)，区分“渲染 Schema 通用契约”与“宿主 AI 导演规则”。
使用 AstrBot 时，插件端指令、异步导出轮询、限流与机器人投递以 [astrbot_plugin_msst](https://github.com/yonglanws/astrbot_plugin_msst) 为准。

### 编写演出或调整画质

- 编写或生成标准剧本：[故事文件格式](story-format.md)。
- 配置角色声音、情绪标签、可选本地清单与 BGM：[资源与音频配置](resources.md)。
- 调整 `fast` 导出管线、编码路径、分辨率、帧率、画质与并发 TTS 参数：[导出模式](export-modes.md)。
- 排障与性能定位：[故障排除](troubleshooting.md)。

### 参与开发与验证

项目源码落点、构建、自动化回归测试（含零本地全云端测试）与 E2E 成片检查，见 [开发与验证](development.md)。

## 文档一览

### 当前架构与使用文档

| 文档 | 主要回答的问题 |
| --- | --- |
| [API 参考](api.md) | 导出、AI 生成、云端目录查询/刷新、任务查询与取消、文件下载与清理接口 |
| [云端资源获取](cloud-assets.md) | 零本地资源云端目录（511 模型 / 1,401 背景 / 421 BGM / 1,942 SE）、按需物化与离线拉取 CLI |
| [宿主内置 AI 剧本生成](ai-script.md) | LLM 配置、5 阶段流水线、语义选角/选图/选曲、2 人 Normal 轮换、OfficialLinter 与人设 |
| [故事文件格式](story-format.md) | 剧本 JSON 结构、全部 38 种片段定义、云端名称/id 引用、60fps 官方时序与舞台坐标 |
| [资源与音频配置](resources.md) | `resources/` 目录、可选本地 YAML 覆盖、`bgm00003` 云端兜底、GPT-SoVITS / IrodoriTTS 与 BGM |
| [导出模式](export-modes.md) | `fast` 虚拟时钟管线、参数默认值、WebCodecs / `image2pipe` 回退顺序、并发 TTS 与耗时统计 |
| [部署指南](host-deployment.md) | 平台依赖、配置与 `MSS_*` 环境变量、常驻服务、WebGL GPU 与安全边界 |
| [故障排除](troubleshooting.md) | 浏览器启动、软件渲染、云端拉取、音频、配置与画面问题排查 |
| [开发与验证](development.md) | 目录结构、构建命令、`npm test` / `test:all` / `e2e` 与成片检查清单 |

### 历史设计与演进记录

以下文档记录了项目早期的对齐基准、压测与阶段规划，部分方案已被当前的云端优先目录与 5 阶段 AI 流水线演进替代，仅作历史参考：

| 文档 | 历史背景 |
| --- | --- |
| [AI 剧本质量计划](ai-script-quality-plan.md) | 2026-11-07~08 早期 4 段式提示词与官方 40 句基线量化记录（现已演进为 5 阶段 + `OfficialLinter`） |
| [Moesekai 演出对齐计划](moesekai-parity-plan.md) | 动作时序、入场站桩、双人同场与 Irodori 日语校验的早期对齐记录 |
| [SekaiStoryExporter 对齐计划](sekai-exporter-parity-plan.md) | 60fps 帧基常量、Talk 自动播放、布局淡化与逐帧报告的早期重构记录 |
| [服务器优化与稳定性计划](server-optimization-2026-11-12.md) | 2026-11-12 特定生产环境压测、并发解耦与看门狗实施记录 |

## 配置与格式的依据

- [config.example.yaml](../config.example.yaml)：完整配置模板及注释。
- [src/host/config.ts](../src/host/config.ts)：主配置解析、内置默认值、环境变量覆盖与云端 BGM 兜底逻辑。
- [src/common/types/Story.ts](../src/common/types/Story.ts)：故事字段校验与完整片段 Schema。

复制 `config.example.yaml` 得到的显式值（如 1080p / 60fps）不一定等于字段省略后的内置默认值（如 720p / 30fps），详见 [导出模式](export-modes.md)。
