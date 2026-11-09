# 文档索引

[返回项目首页](../README.md)

首页提供项目介绍与快速开始，本目录按使用任务展开。示例中的文件名、角色、模型和地址需要替换为自己的实际值；仓库不附带渲染资源或示例剧本。

## 从哪里开始

### 首次部署

1. 按 [项目首页的快速开始](../README.md#快速开始) 安装依赖、复制配置并构建。
2. 用 [资源与音频配置](resources.md) 核对目录、清单和可选 TTS / BGM；没有现成模型、背景或 BGM 时用 [云端资源获取](cloud-assets.md) 从 Moesekai 拉取。
3. 按 [部署指南](host-deployment.md) 检查 worker 与 GPU，就绪后再提交短剧本。
4. 用 [API 参考](api.md) 发起导出和下载视频。

### 让宿主编剧

配置 `llm` 后，宿主可以直接从一句场景描述生成剧本或完整视频，客户端不需要自己写提示词和维护动作白名单。见 [宿主内置 AI 剧本生成](ai-script.md)。

### 接入机器人或其他客户端

先读 [API 参考](api.md)，特别是同步等待、排队超时与客户端断连取消。
再读 [故事文件格式](story-format.md)，不要把宿主 AI 生成或 AstrBot 插件投递层的限制误认为 API 的通用行为。
使用 AstrBot 时，插件自身的指令和配置以 [插件仓库](https://github.com/yonglanws/astrbot_plugin_msst) 为准。

### 编写演出或调整画质

- 编写台词、动作、进退场：[故事文件格式](story-format.md)。
- 配置角色声音和背景音乐：[资源与音频配置](resources.md)。
- 调整录制模式、分辨率、帧率、画质与体积：[导出模式](export-modes.md)。
- 比较修改效果：[开发与验证](development.md)，固定故事与硬件条件再做对比。

### 遇到问题或准备改代码

先按 [故障排除](troubleshooting.md) 的现象检查，再用 [开发与验证](development.md) 定位源码和测试入口。
涉及浏览器、GPU、内存、常驻服务的配置，回到 [部署指南](host-deployment.md)。

## 文档一览

| 文档                            | 主要回答的问题                                         |
| ------------------------------- | ------------------------------------------------------ |
| [API 参考](api.md)              | 请求怎么发、返回什么、任务如何等待与取消、文件怎么下载 |
| [故事文件格式](story-format.md) | 剧本怎样声明资源、各片段怎么写、动作和台词如何计时     |
| [资源与音频配置](resources.md)  | 模型和背景如何登记、角色声音如何匹配、BGM 如何加载     |
| [云端资源获取](cloud-assets.md) | 从 Moesekai 拉模型/背景/BGM、sse-motion 转 motion3、断点续传 |
| [宿主内置 AI 剧本生成](ai-script.md) | LLM 配置、staged/single 流水线、并行情绪/表演/翻译、剧本/视频端点与人格配置 |
| [AI 剧本质量计划](ai-script-quality-plan.md) | 官方剧情实测基线、量化指标、评测命令与迭代进度 |
| [Moesekai 演出对齐计划](moesekai-parity-plan.md) | 动作时序、入场、双人同场、Irodori 日文 TTS、导出日志 |
| [SekaiStoryExporter 对齐计划](sekai-exporter-parity-plan.md) | 官方 60fps 时序、Talk 自动播放、布局/动作淡化、眨眼呼吸口型、逐帧计划与报告 |
| [导出模式](export-modes.md)     | 参数影响哪条管线、默认值是什么、怎样平衡清晰度与耗时   |
| [部署指南](host-deployment.md)  | 服务如何安装、配置、常驻、启停与检查 GPU               |
| [故障排除](troubleshooting.md)  | 端口、浏览器、资源、音频、任务与画面问题如何定位       |
| [开发与验证](development.md)    | 修改哪里、运行哪些测试、测试通过能证明什么             |

## 配置与格式的依据

- [config.example.yaml](../config.example.yaml)：完整配置模板及注释。
- [src/host/config.ts](../src/host/config.ts)：主配置解析、内置默认值和环境变量覆盖。
- [src/common/types/Story.ts](../src/common/types/Story.ts)：故事字段校验与类型定义。

复制模板得到的显式值不一定等于字段省略后的内置默认值，详见导出参数表。文档中的性能建议也不代表任意硬件上的速度保证。
