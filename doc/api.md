# API

[返回 README](../README.md) · [文档索引](README.md) · [故事文件格式](story-format.md) · [资源与音频配置](resources.md)

本文对应当前宿主的 HTTP API。本机访问地址示例为 `http://127.0.0.1:9881`；默认监听 `0.0.0.0:9881`，可通过宿主配置修改。
API 支持可选的内置 Bearer 鉴权与 CORS 白名单（见下方通用约定与 [安全提示](host-deployment.md#安全提示)）。下文任务 ID、路径、资源名与统计值均为**示意值**。

本文导航：[端点一览](#通用约定与端点) · [提交导出](#提交导出post-apiv1export) · [在途任务](#在途任务查询与取消) · [文件分页](#文件分页get-apiv1files) · [资源目录](#资源目录get-apiv1resources) · [健康检查](#健康检查get-apiv1health) · [状态码](#常见状态码速查)

## 通用约定与端点

- 请求使用 `Content-Type: application/json`，JSON 请求体上限为 `50mb`。
- 除下载与静态资源外，下面各端点返回 JSON；响应结构随端点不同，不要假定所有响应都带 `success`。
- **可选鉴权（Bearer Token）**：配置 `server.apiKey` 或环境变量 `MSST_API_KEY` / `MSS_API_KEY`（非空）后，除 `GET /api/v1/health` 与 `OPTIONS` 预检外，所有 `/api/v1/*` 与 `/apifile/*` 请求都必须携带 `Authorization: Bearer <token>`（SHA-256 + `timingSafeEqual` 常量时间比对），未授权返回 HTTP `401`。内部 `/api/v1/tts/lease` 与 `/api/v1/tts/lease/release` 额外接受同机渲染 worker 的内部桥接令牌。未配置密钥时鉴权保持关闭，仅建议用于可信本机回环。
- **CORS 策略**：默认启用（可用 `server.cors` 关闭）；允许来源由 `server.corsOrigins` 或环境变量 `MSST_CORS_ORIGINS` / `MSS_CORS_ORIGINS`（逗号分隔）指定。未显式配置来源白名单时，仅放行不带 userinfo 的本机回环来源（`localhost`、`127.0.0.1`、`[::1]` 的 `http`/`https`）。响应附带 `Vary: Origin`，允许 `GET, POST, OPTIONS` 与 `Content-Type, Authorization` 请求头；预检返回 HTTP 204。
- `downloadUrl` 是相对地址，应与服务地址组合；`videoPath` / `scriptPath` 是宿主磁盘路径，不是客户端本地路径（500 报错文本中的宿主本地绝对路径会脱敏为 `<path>`）。

| 方法 | 端点                             | 用途                                                                  |
| ---- | -------------------------------- | --------------------------------------------------------------------- |
| POST | `/api/v1/export`                 | 提交故事，支持同步等待（默认）或异步入队（`wait: false`）             |
| GET  | `/api/v1/export/:taskId/status`  | 查询单个在途或近期已完成任务（支持 `completed`/`failed`/`cancelled`） |
| POST | `/api/v1/export/:taskId/cancel`  | 取消指定在途任务并立即清理关联临时目录                                |
| GET  | `/api/v1/files`                  | 分页列出导出目录中的文件                                              |
| GET  | `/api/v1/download/:filename`     | 下载指定文件（校验解析后真实路径不越界）                              |
| GET  | `/api/v1/resources`              | 获取合并后的模型、动作、表情、背景、BGM 与 SE 目录                    |
| POST | `/api/v1/script/generate`        | 宿主内置 AI 生成剧本（不导出）                                        |
| POST | `/api/v1/generate`               | 宿主内置 AI 生成剧本并直接导出 MP4                                    |
| GET  | `/api/v1/assets/moesekai/models` | 浏览 Moesekai 云端模型索引                                            |
| GET  | `/api/v1/assets/moesekai/media`  | 浏览 Moesekai 背景 / BGM bundle                                       |
| POST | `/api/v1/assets/fetch`           | 从 Moesekai 拉取模型、背景或 BGM 到本地                               |
| POST | `/api/v1/cloud/refresh`          | 强制刷新云端资源目录快照                                              |
| GET  | `/api/v1/health`                 | 查看宿主、渲染池、TTS、LLM 与清理状态                                 |
| GET  | `/api/v1/status`                 | 查看队列与近期导出统计                                                |
| POST | `/api/v1/cleanup`                | 立即执行一次过期导出文件与临时目录清理                                |
| GET  | `/api/v1/cleanup/stats`          | 查看清理策略与累计统计                                                |

AI 剧本生成与云端资源拉取的完整请求体示例见 [宿主内置 AI 剧本生成](ai-script.md) 与 [云端资源获取](cloud-assets.md)。

## 提交导出：`POST /api/v1/export`

支持**同步长连接（默认，`wait: true`）**与**异步入队轮询（`wait: false`）**两种模式。服务端均先完成云端资源按需物化、Irodori 日语 `ttsText` 预检与 Schema 校验，再将任务入队：

- **`wait: true`（默认）**：长连接阻塞直至排队与渲染导出完成后返回 HTTP 200；客户端断连会取消该任务。
- **`wait: false`**：立即返回 **HTTP 202** 与 `taskId` / `statusUrl`，适合经反代、Bot 网关或短超时客户端调用，随后轮询 `GET /api/v1/export/:taskId/status` 获取最终结果（例如 `astrbot_plugin_msst` 默认以 `wait: false` 提交并按 `poll_interval_seconds` 轮询）。

| JSON 字段 | 必填 | 类型与规则                                                                                   |
| --------- | ---- | -------------------------------------------------------------------------------------------- |
| `story`   | 是   | 完整故事对象，包含 `models`、`images`、`snippets` 数组；详见 [故事文件格式](story-format.md) |
| `timeout` | 否   | 整数，单位毫秒，范围 `1`～`2147483647`；默认 `1800000`（30 分钟）                            |
| `wait`    | 否   | 布尔值；默认 `true`（同步等待成片）；传 `false` 时立即返回 HTTP 202 并由调用方轮询 `/status` |

请求只读取上述三个字段。尺寸、帧率、编码、导出模式、TTS 与 BGM 等由宿主配置决定。
启用 `assets.cloudCatalog`（默认）时，剧本中引用的云端背景名/id、BGM 曲名/id、SE 与 `cloud/` 模型会在入队前自动物化到 `resources/*/cloud/`。故事中的预录 `voice` 字段当前不进入 API 导出音轨。

### 同步 / 异步调用示例

同步调用示例（长连接直取结果）：

```bash
node -e 'const fs = require("node:fs"); process.stdout.write(JSON.stringify({story: JSON.parse(fs.readFileSync(process.argv[1], "utf8")), timeout: 600000}))' \
  ./your-story.sekai-story.json |
  curl --max-time 660 -sS -X POST http://127.0.0.1:9881/api/v1/export \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $MSST_API_KEY" \
    --data-binary @-
```

若启用异步入队（`"wait": false`），立即返回 HTTP 202：

```json
{
  "success": true,
  "taskId": "export-1800000000000-demo01",
  "status": "queued",
  "statusUrl": "/api/v1/export/export-1800000000000-demo01/status"
}
```

同步成功时返回 HTTP 200：

```json
{
  "success": true,
  "message": "Video exported successfully",
  "videoPath": "C:\\mss\\apifile\\export-1800000000000-demo01.mp4",
  "fileSize": 5242880,
  "duration": 41.2,
  "frameCount": 900,
  "timings": {
    "pumpMs": 12400,
    "tickMs": 1850,
    "renderMs": 7200,
    "snapshotMs": 2900,
    "ttsWaitMs": 0,
    "encodeMs": 1100,
    "audioMs": 420,
    "invokeMs": 150,
    "frames": 900,
    "avgPumpFps": 72.6
  },
  "logPath": "C:\\mss\\apifile\\export-1800000000000-demo01.log",
  "logJsonPath": "C:\\mss\\apifile\\export-1800000000000-demo01.log.json",
  "reportPath": "C:\\mss\\apifile\\export-1800000000000-demo01.report.txt",
  "downloadUrl": "/api/v1/download/export-1800000000000-demo01.mp4"
}
```

| 响应字段                                 | 含义                                                                                                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `success`、`message`                     | 成功标志与结果说明                                                                                                                                    |
| `videoPath`                              | 生成视频在宿主上的文件路径                                                                                                                            |
| `fileSize`                               | 产物文件字节数                                                                                                                                        |
| `duration`                               | **渲染侧导出耗时（秒），不是视频时长，也不含 API 排队时间**                                                                                           |
| `frameCount`                             | 渲染结果报告的总帧数                                                                                                                                  |
| `timings`                                | `fast` 导出阶段耗时与帧率统计（`pumpMs`、`tickMs`、`renderMs`、`snapshotMs`、`ttsWaitMs`、`encodeMs`、`audioMs`、`invokeMs`、`frames`、`avgPumpFps`） |
| `logPath` / `logJsonPath` / `reportPath` | 与视频同目录的可读诊断日志、结构化 JSON 日志与交付报告路径                                                                                            |
| `downloadUrl`                            | 视频下载相对地址                                                                                                                                      |

### 超时、限流与失败

- `timeout` 从任务提交后计时，**包含排队时间**；`wait: true` 时客户端断连或超时都会取消任务，`wait: false` 时由宿主超时定时器在到期后取消并将状态记为 `failed`。
- `/api/v1/export`、`/api/v1/script/generate` 与 `/api/v1/generate` 共享按客户端 IP 的速率限制（内存表默认上限 `rateLimitMaxEntries: 10000`）：每个 60 秒窗口最多 10 次请求；超限返回 **HTTP 429**，同时设置 **`Retry-After` 响应头**与响应体 `retryAfterSeconds`。
- 启用 Bearer 鉴权且令牌缺失/不匹配返回 **HTTP 401**。
- 故事缺失、Schema 校验失败、非法 `wait`/`timeout` 或导出前 Irodori 日语预检失败返回 HTTP 400（附 `details` 或脱敏错误信息）。
- 导出失败、超时、取消或产物缺失返回 HTTP 500（错误文本经 `redactPaths` 脱敏）；渲染池尚未就绪返回 HTTP 503。

## 在途任务：查询与取消

`taskId` 由服务端生成（形如 `export-时间戳-随机后缀`），可在 `GET /api/v1/status` 的 `activeTaskIds` / `queuedTaskIds` 中查看全局在途 ID。已完成/失败/取消的任务记录会保留 **1 小时（最多 200 条）** 供异步轮询读取，超期后淘汰。

### `GET /api/v1/export/:taskId/status`

排队中示例：

```json
{
  "success": true,
  "taskId": "export-1800000000000-demo01",
  "status": "queued",
  "elapsedSeconds": 12.5,
  "queuePosition": 2
}
```

异步已完成示例（可直接取 `result.downloadUrl` 下载成片）：

```json
{
  "success": true,
  "taskId": "export-1800000000000-demo01",
  "status": "completed",
  "elapsedSeconds": 24.8,
  "result": {
    "success": true,
    "videoPath": "C:\\mss\\apifile\\export-1800000000000-demo01.mp4",
    "fileSize": 5242880,
    "duration": 21.4,
    "frameCount": 900,
    "downloadUrl": "/api/v1/download/export-1800000000000-demo01.mp4"
  }
}
```

- 在途 `status` 为 `processing`、`queued` 或 `pending`；终态记录在保留期内返回 `completed`（附 `result`）、`failed`（附脱敏 `error.message`）或 `cancelled`；未找到或已淘汰返回 `{ "taskId": "...", "status": "unknown" }`。
- `elapsedSeconds` 为自登记以来的等待+处理秒数；`queuePosition` 非排队时为 `null`（终态记录不含该字段）。

### `POST /api/v1/export/:taskId/cancel`

无需请求体。接口会先触发并等待 `dispatcher.cancel(taskId)` 完成清理，再返回 HTTP 200：`{"taskId":"export-1800000000000-demo01","cancelled":true}`。正在渲染的任务会立即中止、`BridgeController` 关闭该任务在途文件句柄与帧管道（`FramesPipeSession`）并删除关联临时目录（`mss-export-*`、`mss-hf-*`、`mss-fpipe-*` 等）同时标记防回写，同步长连接返回 HTTP 500 `Export cancelled by user`，异步任务 `/status` 转为 `cancelled`。

## 文件分页：`GET /api/v1/files`

| 查询参数 | 默认值 | 规则                                  |
| -------- | ------ | ------------------------------------- |
| `page`   | `1`    | 从 1 开始                             |
| `limit`  | `20`   | 限制在 1～100                         |
| `sort`   | `desc` | 仅 `asc` 按修改时间升序，其余均为降序 |

列表筛选输出目录中的 `.mp4` 与 `.json` 文件，返回 `data[]` 与 `pagination`。

## 下载：`GET /api/v1/download/:filename`

路径参数仅传文件名（不含目录、`/`、`\`、`\0` 与 `..`），服务端同时使用 `fs.realpathSync` 校验真实目标严格位于输出目录内（阻断符号链接越界）。HTTP 200 直接返回文件流（附 `Content-Type`、`Content-Length`、`Content-Disposition`；支持 `.mp4`、`.json`、`.log`/`.txt`、`.webm`）；非法文件名返回 400，文件不存在或符号链接越界返回 404。

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

返回 HTTP 200（本端点对探活公开，不要求 Bearer 令牌），`status: "ok"` 仅表示 API 进程可响应；请同时检查 `renderPool.readyWorkers` 与 `webglRenderers`。

当配置了 `server.apiKey` / `MSST_API_KEY` / `MSS_API_KEY` 且请求未携带合法 Bearer 令牌时，接口会自动脱敏：`ttsLease` 仅返回 `active`、`waiters`、`hasWeights`（省略 `currentWeights` 文件名），并省略 `tts.apiBaseUrl`、`llm.baseUrl` 与 `assets.indexBase` / `assets.libraryBase`。

| 顶层字段                                           | 含义                                                                                                                                                                              |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`、`version`                                | 当前固定为 `"ok"`、`"2.0.0"`                                                                                                                                                      |
| `activeExports`、`queuedExports`、`pendingExports` | API 已派发数、排队数、等待结果数                                                                                                                                                  |
| `cleanup`                                          | 过期产物清理策略与统计                                                                                                                                                            |
| `videoConfig`                                      | `width`、`height`、`renderScale`、`fps`、`codec`、`crf`、`audioBitrate`、`watermark`、`watermarkText`、`exportMode`、`fastFps`、`exportFastEncoder`、`idleChainGapSec`、`ttsMode` |
| `renderPool`                                       | `configuredWorkers`、`readyWorkers`、`idleWorkers`、`busyTaskIds`、`bufferedTasks`、`exportsCompleted`、`webglRenderers`                                                          |
| `ttsLease`                                         | GSV 全局权重租约状态（启用 `apiKey` 且未认证时仅含摘要计数与 `hasWeights`）                                                                                                       |
| `tts`                                              | `enabled`、`provider`、`emotionLabels`、`characters`（已配置角色数）；认证后含 `apiBaseUrl`                                                                                       |
| `llm`                                              | `enabled`、`model`、`pipeline`、`apiKeyConfigured`、`activeGenerations`、`maxConcurrent`；认证后含 `baseUrl`                                                                      |
| `assets`                                           | `source`、`region`、`fetching`；认证后含 `indexBase`、`libraryBase`                                                                                                               |
| `host`                                             | `platform`、`node`、`ffmpegEncoder`（配置值）、`ffmpegEncoderDetected`（真实探测结果）                                                                                            |

## 队列概览：`GET /api/v1/status`

返回 `activeExports`、`queuedExports`、`pendingExports`、`maxConcurrent`、`activeTaskIds`、`queuedTaskIds` 与最多 10 条滚动窗口 `recentExports`（注意 `recentExports[].durationMs` 包含排队时间）。

## 清理：`POST /api/v1/cleanup` 与 `GET /api/v1/cleanup/stats`

`POST /api/v1/cleanup` 会立即执行过期导出与过期临时项清扫并返回 `{ success, filesCleaned, tempEntriesCleaned, totalFilesCleaned, retentionHours }`。

定时周期 60 分钟；清理输出目录中修改时间超过 24 小时的 `.mp4`、`.json`、`.log`、`.txt` 文件（跳过活跃任务产物），输出目录与系统临时目录中的过期临时项（前缀 `mss-fpipe-`、`mss-hf-`、`mss-export-`、`mss-api-audio-`、`mss-audio-`、`mss-fast-` 与孤儿 `.mss-frames-video-*.mp4`）默认保留超过 6 小时后清扫；被取消的导出任务还会由宿主在取消时立即清理本次关联临时目录。

## 常见状态码速查

| HTTP 状态 | 典型情况                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------- |
| 200       | 正常响应（含任务 `unknown`、`cancelled: false`）                                                          |
| 202       | `POST /api/v1/export` 传入 `wait: false` 异步入队成功                                                     |
| 204       | CORS `OPTIONS` 预检                                                                                       |
| 400       | 导出故事/参数校验失败（含非法 `wait`/`timeout`）、Irodori 日语预检失败、下载文件名非法                    |
| 401       | 已启用 Bearer `apiKey`，请求缺失或携带错误 `Authorization: Bearer <token>`                                |
| 404       | 下载文件不存在或符号链接越界                                                                              |
| 409       | `cloudCatalog` 已关闭时刷新目录，或并发执行了第二个 `assets/fetch`                                        |
| 422       | AI 剧本生成/校验失败或 `llm.enabled=false`                                                                |
| 429       | `/api/v1/export`、`/api/v1/script/generate`、`/api/v1/generate` IP 限流（附 `Retry-After`）或 AI 并发上限 |
| 500       | 渲染失败、导出超时/取消（同步模式）、产物缺失或文件读写错误                                               |
| 502       | 上游 LLM 或云端资源站请求失败                                                                             |
| 503       | 渲染池尚未绑定，或 TTS 权重租约被中止                                                                     |
| 504       | AI 剧本生成阶段超时                                                                                       |
