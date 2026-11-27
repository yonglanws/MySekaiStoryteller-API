# 文档总览

[返回项目首页](../README.md)

这里按你当前想做的事把文档分了类。仓库本身不带模型、背景或示例剧本，但默认开启云端资源目录并内置 **58 份 PJSK 角色人设**（`personas/pjsk/`），**空 `resources/` 目录就能直接启动并出片**。

## 按场景选文档

### 我是第一次部署 / 想先跑起来

1. 看 [首页三分钟上手](../README.md#三分钟上手) 或 [Docker 一键部署](../README.md#docker-一键部署) 快速启动。
2. 需要改并发、开 GPU 加速、配环境变量、加载 `.env` 或挂成 systemd / Windows 后台服务，看 [部署指南](host-deployment.md)。
3. 要接 GPT-SoVITS / IrodoriTTS 配音，或想切到 `cloudOnly: false` 用自己的模型、背景、BGM 替换云端素材，看 [资源与音频配置](resources.md) 和 [云端资源获取](cloud-assets.md)。
4. 看 [API 参考](api.md) 发请求生成或导出视频。

### 我想用 AI 一句话写剧本

配好 `llm` 后，给宿主发一句场景描述就能直接出 `StoryData` JSON 或 MP4。关于内置 `personas/pjsk/` 58 份角色人设自动加载、自定义叠加覆盖、语义 RAG、`staged` / 统一 `hybrid`（`agent`）三段式上下文隔离流水线，看 [宿主内置 AI 剧本生成](ai-script.md)。

### 我要写机器人插件或客户端接入

先看 [API 参考](api.md)，重点关注异步提交（`wait: false` + 轮询 `/status`）、Bearer 鉴权、IP 限流（429 `Retry-After`）、HTTP `Range` 下载、优雅停机 `503` 与取消清理；再看 [故事文件格式](story-format.md) 了解渲染 JSON 结构。

### 我想调整画质、体积或导出速度

- 分辨率、帧率、`renderScale`、WebCodecs 与 Rust `/bridge/rs-stream` 二进制 WebSocket 管道、30fps Live2D 对齐、并发 TTS 调优，看 [导出模式与提速调参](export-modes.md)。
- 遇到报错、画质糊、慢、没声音、动作表情不对，看 [故障排除](troubleshooting.md)。

### 我要理解架构、改代码或提 PR

- 模块边界、数据流图与渲染/桥接原理，看 [系统架构指南](architecture.md)。
- 目录结构、构建、自动发现回归测试与 E2E 成片检查，看 [开发与验证](development.md) 与 [贡献指南](../CONTRIBUTING.md)。
- 安全边界与自托管加固，看 [安全策略](../SECURITY.md)。

## 文档清单

| 文档 | 内容 |
| --- | --- |
| [系统架构指南](architecture.md) | 整体架构 Mermaid 图、HTTP API、AI 三段式管线、渲染池、二进制桥接与 Rust 导出器 |
| [API 参考](api.md) | 全部 HTTP 接口、参数、返回值、鉴权、限流、Range 下载、优雅停机与状态码 |
| [宿主内置 AI 剧本生成](ai-script.md) | LLM/RAG 配置、内置 58 份 `personas/pjsk/` 人设、统一三段式流水线与质量评测 |
| [云端资源获取](cloud-assets.md) | 零本地资源原理、574 模型 / 1,402 背景 / 421 BGM / 1,991 SE 索引、`cloudOnly` 与 CLI |
| [资源与音频配置](resources.md) | `resources/` 目录结构、`cloudOnly: false` 本地覆盖、GPT-SoVITS / IrodoriTTS 与 BGM |
| [故事文件格式](story-format.md) | 完整剧本 JSON 示例、所有片段类型、云端引用与 60fps 舞台/台词规则 |
| [导出模式与提速调参](export-modes.md) | `fast` 管线、原生 Rust 导出器、`/bridge/rs-stream` 二进制 WS 管道、30fps 对齐与调优 |
| [部署指南](host-deployment.md) | Docker 一键部署、`.env` 自动加载、完整环境变量表、GPU 加速、低内存预设与 systemd |
| [故障排除](troubleshooting.md) | 常见故障按症状快速定位 |
| [开发与验证](development.md) | 模块化源码结构、npm 与 Rust 构建/测试命令、自动发现回归测试与成片检查 |
| [贡献指南](../CONTRIBUTING.md) | 开发工作流、代码风格与 PR 提交规范 |
| [安全策略](../SECURITY.md) | 漏洞反馈与自托管安全加固检查清单 |
| [更新日志](../CHANGELOG.md) | 版本演进记录与 `v1.0.0-beta1` 架构大改说明 |

## 配置与格式的最终依据

- [config.example.yaml](../config.example.yaml)：完整配置文件样例及注释
- [.env.example](../.env.example)：完整环境变量模板（Docker 与宿主机通用）
- [src/host/config.ts](../src/host/config.ts)：配置解析、内置默认值与环境变量覆盖
- [src/common/types/Story.ts](../src/common/types/Story.ts)：故事 JSON 的 Zod 校验规则

> [!NOTE]
> 不复制 `config.example.yaml` 且不设环境变量时用的是 `src/host/config.ts` 的裸 schema 默认值（如 `1280×720`、`30fps`、`crf: 18`、`cloudOnly: false`）；使用默认模板（`config.example.yaml`、`.env.example`、`npm run init` 或 Docker）时则默认开启 `cloudOnly: true`（纯云端零本地资源）。详见 [导出模式与提速调参](export-modes.md) 与 [云端资源获取](cloud-assets.md)。
