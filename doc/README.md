# 文档总览

[返回项目首页](../README.md)

这里按你当前想做的事把文档分了类。仓库本身不带模型、背景或示例剧本，但默认开启云端资源目录，**空 `resources/` 目录就能直接启动并出片**。

## 按场景选文档

### 我是第一次部署 / 想先跑起来

1. 看 [首页三分钟上手](../README.md#三分钟上手) 把依赖装好、构建并启动。
2. 需要改并发、开 GPU 加速、配环境变量或挂成 systemd / Windows 后台服务，看 [部署指南](host-deployment.md)。
3. 要接 GPT-SoVITS / IrodoriTTS 配音，或想用自己的模型、背景、BGM 替换云端素材，看 [资源与音频配置](resources.md) 和 [云端资源获取](cloud-assets.md)。
4. 看 [API 参考](api.md) 发请求生成或导出视频。

### 我想用 AI 一句话写剧本

配好 `llm` 后，给宿主发一句场景描述就能直接出 `StoryData` JSON 或 MP4。关于提示词、角色人设、语义 RAG、5 阶段导演流程与 Agent 工具调用架构，看 [宿主内置 AI 剧本生成](ai-script.md)。

### 我要写机器人插件或客户端接入

先看 [API 参考](api.md)，重点关注异步提交（`wait: false` + 轮询 `/status`）、Bearer 鉴权、IP 限流（429 `Retry-After`）和取消清理；再看 [故事文件格式](story-format.md) 了解渲染 JSON 结构。

### 我想调整画质、体积或导出速度

- 分辨率、帧率、`renderScale`、WebCodecs 与 `rawvideo`/`image2pipe` 管道、并发 TTS 调优，看 [导出模式与提速调参](export-modes.md)。
- 遇到报错、画质糊、慢、没声音、动作表情不对，看 [故障排除](troubleshooting.md)。

### 我要改代码或跑测试

目录结构、构建、自动化回归测试与 E2E 成片检查，看 [开发与验证](development.md)。

## 文档清单

| 文档 | 内容 |
| --- | --- |
| [API 参考](api.md) | 全部 HTTP 接口、参数、返回值、鉴权、限流与状态码 |
| [宿主内置 AI 剧本生成](ai-script.md) | LLM/RAG 配置、多阶段流水线、Agent 工具调用、表情/动作/台词优化与质量评测 |
| [云端资源获取](cloud-assets.md) | 零本地资源原理、511 模型 / 1,401 背景 / 421 BGM / 1,942 SE 索引、按需下载与 CLI |
| [资源与音频配置](resources.md) | `resources/` 目录结构、本地 YAML 覆盖、GPT-SoVITS / IrodoriTTS 与 BGM 兜底 |
| [故事文件格式](story-format.md) | 完整剧本 JSON 示例、所有片段类型、云端引用与 60fps 舞台/台词规则 |
| [导出模式与提速调参](export-modes.md) | `fast` 管线、真实默认值与模板差异、GPU YUV420 / WebCodecs / 帧管道与耗时指标 |
| [部署指南](host-deployment.md) | 环境依赖、完整环境变量表、常驻配置、WebGL GPU 调试与安全边界 |
| [故障排除](troubleshooting.md) | 常见故障按症状快速定位 |
| [开发与验证](development.md) | 源码结构、npm 脚本、回归测试与成片检查 |

## 历史规划与早期记录（仅供参考）

下面几份文件是开发早期留下的基准调研和重构记录，不少设计已被现在的实现替代或吸收，仅作背景参考，实际行为以上面正式文档和源码为准：

- [ai-script-quality-plan.md](ai-script-quality-plan.md)：早期 4 段式提示词与官方 40 句基线统计
- [moesekai-parity-plan.md](moesekai-parity-plan.md)：动作时序、入场、双人站位与日语 TTS 早期对齐记录
- [sekai-exporter-parity-plan.md](sekai-exporter-parity-plan.md)：60fps 帧基、Talk 自动推进与逐帧对比早期重构记录
- [server-optimization-2026-11-12.md](server-optimization-2026-11-12.md)：2026-11-12 特定服务器的并发压测与运维调优记录

## 配置与格式的最终依据

- [config.example.yaml](../config.example.yaml)：完整配置文件样例及注释
- [src/host/config.ts](../src/host/config.ts)：配置解析、内置默认值与环境变量覆盖
- [src/common/types/Story.ts](../src/common/types/Story.ts)：故事 JSON 的 Zod 校验规则

> [!NOTE]
> 不复制 `config.example.yaml` 时用的是 `src/host/config.ts` 的内置默认值（如 `1280×720`、`30fps`、`crf: 18`）；复制模板后用的则是模板里写死的值（如 `1920×1080`、`60fps`、`crf: 28`）。详见 [导出模式与提速调参](export-modes.md)。
