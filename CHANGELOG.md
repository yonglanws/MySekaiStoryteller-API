# 更新日志

本文件记录 **MySekaiStoryteller-API（渲染宿主）** 的版本变更；AstrBot 插件是独立仓库，
变更见 [astrbot_plugin_msst](https://github.com/yonglanws/astrbot_plugin_msst)。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [0.1.0] - 2026-09-30

首个发布版本：把上游 Electron 桌面应用重构为无头纯 API 渲染宿主。

### Added

- HTTP API 宿主（单端口 9881）：提交/查询/取消导出、下载产物、分页列出文件、
  资源目录、健康检查、队列状态、过期文件清理
- 渲染池：Playwright 多 worker，每个无头页面独立 WebGL 上下文；任务排队、内存护栏与
  看门狗强制回收，worker 回收后就绪即接管后续任务
- 两条导出管线：`record`（MediaRecorder 墙钟录制，默认）与 `fast`（虚拟时钟逐帧渲染），
  失败自动回退
- `record` 流拷贝路径：浏览器支持时直录 h264/mp4，宿主 `-c:v copy` 流拷贝合流；
  支持按目标体积反推码率（`recordTargetSizeMb`）、过头系数、关键帧间隔与采集帧率调节
- 表演系统：滑入滑出登场退场、台词内时序动作与听者反应（`Talk.data.actions`）、
  按语音音量包络驱动的口型
- 音频：BGM 混入与 GPT-SoVITS 语音合成；无 TTS 时自动跳过配音，导出不受影响
- 资源目录：`models.yaml` / `images.yaml` 清单驱动角色与背景，`/api/v1/resources`
  供 AI 侧构建提示词与校验白名单；三份清单各附 `*.example.yaml` 示例随仓库分发
- 配置：单个 `config.yaml`（全字段中文注释）+ `MSS_*` 环境变量覆盖；
  BGM 设置独立到 `resources/audio/bgm/bgm.yaml`
- 测试：`npm test` / `test:pool` / `test:config`（`npm run test:all` 共 29 项），
  无需宿主、浏览器或模型资源即可运行
- 部署文档 [doc/host-deployment.md](doc/host-deployment.md)：平台差异、环境变量、
  systemd / Windows / macOS 常驻方式与 GPU 排障

### Fixed

- 导出失败、取消、客户端断连或宿主关停后，超时计时器不再空挂到原定 deadline
- 单 worker 部署下，取消的任务不再长时间占死 worker 阻塞后续请求
- 客户端取消现在会真正中止在途导出，并清理 per-export 临时目录
- Windows 上 ffmpeg-static 可执行位判定、按配置分辨率直出（不再上采样 720p）等问题

### 说明

- 渲染资源（Live2D 模型、背景图、语音、BGM、剧本）不随仓库分发，获取与放置见
  [resources/README.md](resources/README.md)
- 本项目基于 [Untitled-Story/MySekaiStoryteller](https://github.com/Untitled-Story/MySekaiStoryteller)
  二次开发，沿用 GNU GPL v3 许可
