# API

[返回 README](../README.md) · [文档索引](README.md) · [故事文件格式](story-format.md) · [资源与音频配置](resources.md)

本文对应当前宿主的 HTTP API。本机访问地址示例为 `http://127.0.0.1:9881`；默认监听 `0.0.0.0:9881`，可通过宿主配置修改。
API 没有内置鉴权，部署边界见 [安全提示](host-deployment.md#安全提示)。下文任务 ID、路径、资源名与统计值均为**示意值**。

本文导航：[端点一览](#通用约定与端点) · [提交导出](#提交导出post-apiv1export) · [在途任务](#在途任务查询与取消) · [文件分页](#文件分页get-apiv1files) · [资源目录](#资源目录get-apiv1resources) · [健康检查](#健康检查get-apiv1health) · [状态码](#常见状态码速查)

## 通用约定与端点

- 请求使用 `Content-Type: application/json`，JSON 请求体上限为 `50mb`。
- 除下载与静态资源外，下面各端点返回 JSON；响应结构随端点不同，不要假定所有响应都带 `success`。
- `downloadUrl` 是相对地址，应与服务地址组合；`videoPath` / `scriptPath` 是宿主磁盘路径，不是客户端本地路径。
- CORS 允许任意来源、`GET/POST/OPTIONS` 与 `Content-Type` 请求头；预检返回 HTTP 204。

| 方法 | 端点                             | 用途                                               |
| ---- | -------------------------------- | -------------------------------------------------- |
| POST | `/api/v1/export`                 | 提交故事，同步等待导出结果                         |
| GET  | `/api/v1/export/:taskId/status`  | 查询单个在途任务                                   |
| POST | `/api/v1/export/:taskId/cancel`  | 取消指定在途任务                                   |
| GET  | `/api/v1/files`                  | 分页列出导出目录中的文件                           |
| GET  | `/api/v1/download/:filename`     | 下载指定文件                                       |
| GET  | `/api/v1/resources`              | 获取合并后的模型、动作、表情、背景、BGM 与 SE 目录 |
| POST | `/api/v1/script/generate`        | 宿主内置 AI 生成剧本（不导出）                     |
| POST | `/api/v1/generate`               | 宿主内置 AI 生成剧本并直接导出 MP4                 |
| GET  | `/api/v1/assets/moesekai/models` | 浏览 Moesekai 云端模型索引                         |
| GET  | `/api/v1/assets/moesekai/media`  | 浏览 Moesekai 背景 / BGM bundle                    |
| POST | `/api/v1/assets/fetch`           | 从 Moesekai 拉取模型、背景或 BGM 到本地            |
| POST | `/api/v1/cloud/refresh`          | 强制刷新云端资源目录快照                           |
| GET  | `/api/v1/health`                 | 查看宿主、渲染池、TTS、LLM 与清理状态              |
| GET  | `/api/v1/status`                 | 查看队列与近期导出统计                             |
| POST | `/api/v1/cleanup`                | 立即执行一次过期导出文件清理                       |
| GET  | `/api/v1/cleanup/stats`          | 查看清理策略与累计统计                             |

AI 剧本生成与云端资源拉取的完整请求体示例见 [宿主内置 AI 剧本生成](ai-script.md) 与 [云端资源获取](cloud-assets.md)。

## 提交导出：`POST /api/v1/export`

这是**长连接同步请求**：服务端完成预处理（含云端资源按需物化与 Irodori 日语 `ttsText` 预检）、校验、排队和导出后，才返回成功或失败结果；不会以 HTTP 202 提前返回 `taskId`。

| JSON 字段 | 必填 | 类型与规则                                                                                   |
| --------- | ---- | -------------------------------------------------------------------------------------------- |
| `story`   | 是   | 完整故事对象，包含 `models`、`images`、`snippets` 数组；详见 [故事文件格式](story-format.md) |
| `timeout` | 否   | 整数，单位毫秒，范围 `1`～`2147483647`；默认 `1800000`（30 分钟）                            |

请求只读取上述两个字段。尺寸、帧率、编码、导出模式、TTS 与 BGM 等由宿主配置决定。
启用 `assets.cloudCatalog`（默认）时，剧本中引用的云端背景名/id、BGM 曲名/id、SE 与 `cloud/` 模型会在入队前自动物化到 `resources/*/cloud/`。故事中的预录 `voice` 字段当前不进入 API 导出音轨。

### 同步调用示例

```bash
node -e 'const fs = require("node:fs"); process.stdout.write(JSON.stringify({story: JSON.parse(fs.readFileSync(process.argv[1], "utf8")), timeout: 600000}))' \
  ./your-story.sekai-story.json |
  curl --max-time 660 -sS -X POST http://127.0.0.1:9881/api/v1/export \
    -H "Content-Type: application/json" --data-binary @-
```

成功时返回 HTTP 200：

```json
{
  "success": true,
  "message": "Video exported successfully",
  "videoPath": "C:\\mss\\apifile\\export-1800000000000-demo01.mp4",
  "fileSize": 5242880,
  "duration": 41.2,
  "frameCount": 900,
  "timings": { "recordMs": 35000, "mergeMs": 4500, "videoDurationMs": 30000 },
  "logPath": "C:\\mss\\apifile\\export-1800000000000-demo01.log",
  "logJsonPath": "C:\\mss\\apifile\\export-1800000000000-demo01.log.json",
  "reportPath": "C:\\mss\\apifile\\export-1800000000000-demo01.report.txt",
  "downloadUrl": "/api/v1/download/export-1800000000000-demo01.mp4"
}
```

| 响应字段                                 | 含义                                                        |
| ---------------------------------------- | ----------------------------------------------------------- |
| `success`、`message`                     | 成功标志与结果说明                                          |
| `videoPath`                              | 生成视频在宿主上的文件路径                                  |
| `fileSize`                               | 产物文件字节数                                              |
| `duration`                               | **渲染侧导出耗时（秒），不是视频时长，也不含 API 排队时间** |
| `frameCount`                             | 渲染结果报告的总帧数                                        |
| `timings`                                | 所用导出模式的统计对象                                      |
| `logPath` / `logJsonPath` / `reportPath` | 与视频同目录的可读诊断日志、结构化 JSON 日志与交付报告路径  |
| `downloadUrl`                            | 视频下载相对地址                                            |

### 超时、限流与失败

- `timeout` 从任务提交后计时，**包含排队时间**；客户端断连或超时都会取消任务。
- `/api/v1/export` 按客户端 IP 限流：每个 60 秒窗口最多 10 次请求；超限返回 HTTP 429（`retryAfterSeconds: 60`）。
- 故事缺失、Schema 校验失败、非法 `timeout` 或导出前 Irodori 日语预检失败返回 HTTP 400（附 `details`）。
- 导出失败、超时、取消或产物缺失返回 HTTP 500；渲染池尚未就绪返回 HTTP 503。

## 在途任务：查询与取消

`taskId` 由服务端生成（形如 `export-时间戳-随机后缀`），可在 `GET /api/v1/status` 的 `activeTaskIds` / `queuedTaskIds` 中查看全局在途 ID。

### `GET /api/v1/export/:taskId/status`

```json
{
  "taskId": "export-1800000000000-demo01",
  "status": "queued",
  "elapsedSeconds": 12.5,
  "queuePosition": 2
}
```

- `status` 为 `processing`、`queued`、`pending` 或 `unknown`（已结束或不存在）。
- `elapsedSeconds` 为自登记以来的等待+处理秒数；`queuePosition` 非排队时为 `null`。

### `POST /api/v1/export/:taskId/cancel`

无需请求体；返回 HTTP 200：`{"taskId":"export-1800000000000-demo01","cancelled":true}`。正在渲染的任务会中止，等待导出结果的请求返回 HTTP 500 `Export cancelled by user`。

## 文件分页：`GET /api/v1/files`

| 查询参数 | 默认值 | 规则                                  |
| -------- | ------ | ------------------------------------- |
| `page`   | `1`    | 从 1 开始                             |
| `limit`  | `20`   | 限制在 1～100                         |
| `sort`   | `desc` | 仅 `asc` 按修改时间升序，其余均为降序 |

列表筛选输出目录中的 `.mp4` 与 `.json` 文件，返回 `data[]` 与 `pagination`。

## 下载：`GET /api/v1/download/:filename`

路径参数仅传文件名（不含目录与 `..`）。HTTP 200 直接返回文件流（`Content-Type: video/mp4`、`Content-Length`、`Content-Disposition`）；非法文件名返回 400，文件不存在返回 404。

## 资源目录：`GET /api/v1/resources`

无请求体，最多等待 2 秒让首轮云端刷新完成；返回合并后的完整资源目录（30 秒按需内存缓存）：

```json
{
  "success": true,
  "models": [
    {
      "id": 1020,
      "name": "晓山瑞希",
      "shortName": "瑞希",
      "path": "cloud/20mizuki_normal/20mizuki_normal_3.0_t04/20mizuki_normal_3.0_t04.model3.json",
      "motions": ["w-normal-nod01"],
      "facials": ["face_smile_01"],
      "defaultMotion": "w-normal-nod01",
      "defaultFacial": "face_smile_01",
      "source": "cloud",
      "cloudId": "20mizuki_normal",
      "characterId": 20,
      "unit": "25时，Nightcord de.",
      "outfitCategory": "常服",
      "outfitLabel": "日常常服",
      "isDefault": true
    }
  ],
  "images": ["cloud/bg_a000301"],
  "imageDetails": [
    {
      "file": "cloud/bg_a000301",
      "name": "神山高校 天台",
      "description": "校园·白天·室外",
      "id": "bg_a000301",
      "aliases": ["神山高校 屋上"],
      "category": "校园",
      "timeOfDay": "白天",
      "indoor": "室外",
      "tags": ["神山高校", "天台"],
      "source": "cloud"
    }
  ],
  "voices": [],
  "bgm": ["cloud/bgm00003.mp3"],
  "bgmDetails": [
    {
      "file": "cloud/bgm00003.mp3",
      "name": "Slapstick!!",
      "description": "轻快俏皮的日常闹剧曲（剧情 BGM）",
      "id": "bgm00003",
      "mood": "元气欢快",
      "tempo": "中快",
      "category": "剧情 BGM",
      "tags": ["日常", "欢快"],
      "source": "cloud"
    }
  ],
  "seDetails": [
    {
      "file": "cloud/se00053_b.mp3",
      "id": "se00053_b",
      "name": "se00053_b",
      "category": "心跳惊觉",
      "description": "心绪波动 / 回忆白光切入声",
      "tags": ["flashback", "transition"]
    }
  ],
  "cloud": {
    "generatedAt": "2026-11-18T00:00:00.000Z",
    "models": 511,
    "backgrounds": 1401,
    "bgm": 421,
    "se": 1942
  }
}
```

- **本地优先且不压制云端**：本地 `models.yaml` 只占对应角色的默认位，不会抑制同一角色的其余服装变体或其他角色；本地已下载的背景/BGM 不新增 `cloud/` 副本，会自动贴上官方名称与语义标签。
- `models[].id`：云端默认服装从 `1000 + characterId` 分配，其余服装变体与配角从 `2000` 起确定性分配。

## 云端目录刷新：`POST /api/v1/cloud/refresh`

无请求体。强制重新拉取 Moesekai 模型索引、exmeaning 背景与 BGM/SE 列表、Sekai-World 曲名索引，写入 `<assets.cacheDir>/catalog.json` 并返回：

```json
{
  "success": true,
  "generatedAt": "2026-11-18T00:00:00.000Z",
  "models": 511,
  "backgrounds": 1401,
  "bgm": 421,
  "se": 1942
}
```

`assets.cloudCatalog` 关闭时返回 409；刷新失败且无任何可用快照时返回 502。

## 健康检查：`GET /api/v1/health`

返回 HTTP 200，`status: "ok"` 仅表示 API 进程可响应；请同时检查 `renderPool.readyWorkers` 与 `webglRenderers`。

| 顶层字段                                           | 含义                                                                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `status`、`version`                                | 当前固定为 `"ok"`、`"2.0.0"`                                                                                                        |
| `activeExports`、`queuedExports`、`pendingExports` | API 已派发数、排队数、等待结果数                                                                                                    |
| `cleanup`                                          | 过期产物清理策略与统计                                                                                                              |
| `videoConfig`                                      | `width`、`height`、`renderScale`、`fps`、`codec`、`crf`、`audioBitrate`、`watermark`、`watermarkText`、`idleChainGapSec`、`ttsMode` |
| `renderPool`                                       | `configuredWorkers`、`readyWorkers`、`idleWorkers`、`busyTaskIds`、`bufferedTasks`、`exportsCompleted`、`webglRenderers`            |
| `ttsLease`                                         | GSV 全局权重租约状态                                                                                                                |
| `tts`                                              | `enabled`、`provider`、`apiBaseUrl`、`emotionLabels`、`characters`（已配置角色数）                                                  |
| `llm`                                              | `enabled`、`model`、`baseUrl`、`pipeline`、`apiKeyConfigured`、`activeGenerations`、`maxConcurrent`                                 |
| `assets`                                           | `source`、`region`、`indexBase`、`libraryBase`、`fetching`                                                                          |
| `host`                                             | `platform`、`node`、`ffmpegEncoder`（配置值）、`ffmpegEncoderDetected`（真实探测结果）                                              |

## 队列概览：`GET /api/v1/status`

返回 `activeExports`、`queuedExports`、`pendingExports`、`maxConcurrent`、`activeTaskIds`、`queuedTaskIds` 与最多 10 条滚动窗口 `recentExports`（注意 `recentExports[].durationMs` 包含排队时间）。

## 清理：`POST /api/v1/cleanup` 与 `GET /api/v1/cleanup/stats`

定时周期 60 分钟；清理输出目录中修改时间超过 24 小时的 `.mp4`、`.json`、`.log`、`.txt` 文件（跳过活跃任务产物），系统临时目录的 `mss-*` 过期文件每 6 小时清扫一次。

## 常见状态码速查

| HTTP 状态 | 典型情况                                                           |
| --------- | ------------------------------------------------------------------ |
| 200       | 正常响应（含任务 `unknown`、`cancelled: false`）                   |
| 204       | CORS `OPTIONS` 预检                                                |
| 400       | 导出故事/参数校验失败、Irodori 日语预检失败、下载文件名非法        |
| 404       | 下载文件不存在                                                     |
| 409       | `cloudCatalog` 已关闭时刷新目录，或并发执行了第二个 `assets/fetch` |
| 422       | AI 剧本生成/校验失败或 `llm.enabled=false`                         |
| 429       | `/api/v1/export` IP 限流或 AI 并发生成数达到上限                   |
| 500       | 渲染失败、导出超时/取消、产物缺失或文件读写错误                    |
| 502       | 上游 LLM 或云端资源站请求失败                                      |
| 503       | 渲染池尚未绑定，或 TTS 权重租约被中止                              |
| 504       | AI 剧本生成阶段超时                                                |
