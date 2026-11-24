# API 参考

[返回 README](../README.md) · [文档总览](README.md) · [故事文件格式](story-format.md) · [部署指南](host-deployment.md)

服务默认监听 `0.0.0.0:9881`（可在 `config.yaml` 的 `server` 节修改）。下面示例统一用 `http://127.0.0.1:9881`，任务 ID、路径和耗时均为示意值。

## 基本约定

- **请求格式**：POST 接口使用 `Content-Type: application/json`，请求体上限 `50mb`。
- **鉴权（可选）**：设置 `server.apiKey` 或环境变量 `MSST_API_KEY` / `MSS_API_KEY` 后，除了 `GET /api/v1/health` 和 `OPTIONS` 预检外，所有 `/api/v1/*` 与 `/apifile/*` 请求都要带请求头：
  ```text
  Authorization: Bearer <你的密钥>
  ```
  内部接口 `/api/v1/tts/lease` 和 `/api/v1/tts/lease/release` 额外允许同机渲染 worker 通过内部桥接令牌调用。不设密钥则关闭鉴权（仅建议本机回环使用）。
- **CORS 策略**：默认开启（可用 `server.cors: false` 关闭）。配置了 `server.corsOrigins` 或 `MSST_CORS_ORIGINS` / `MSS_CORS_ORIGINS`（逗号分隔）时按白名单放行；没配时只放行本机回环地址（`localhost`、`127.0.0.1`、`[::1]`）。
- **路径与脱敏**：`downloadUrl` 是相对服务根的下载路径；`videoPath` / `scriptPath` 是服务端本地磁盘路径。500 报错文本里的输出目录和临时目录路径会自动脱敏成 `[path]`。

## 接口一览

| 方法   | 路径                             | 作用                                                            |
| ------ | -------------------------------- | --------------------------------------------------------------- |
| `POST` | `/api/v1/export`                 | 提交故事 JSON 导出 MP4（支持同步等待或 `wait: false` 异步入队） |
| `GET`  | `/api/v1/export/:taskId/status`  | 查询单个任务状态（保留期 1 小时，最多 200 条）                  |
| `POST` | `/api/v1/export/:taskId/cancel`  | 取消排队或渲染中的任务，并立即清理关联临时目录                  |
| `POST` | `/api/v1/script/generate`        | 内置 AI 生成剧本 JSON（不渲染视频）                             |
| `POST` | `/api/v1/generate`               | 内置 AI 生成剧本并直接提交导出 MP4                              |
| `GET`  | `/api/v1/files`                  | 分页列出输出目录里的 `.mp4`、`.json`、`.log`、`.txt` 文件       |
| `GET`  | `/api/v1/download/:filename`     | 下载输出目录里的指定文件（带防越界校验）                        |
| `GET`  | `/api/v1/resources`              | 获取合并后的模型、动作、表情、背景、BGM 与 SE 目录              |
| `POST` | `/api/v1/cloud/refresh`          | 强制重新拉取并刷新云端目录快照                                  |
| `GET`  | `/api/v1/assets/moesekai/models` | 浏览 Moesekai 远端模型索引（不下载）                            |
| `GET`  | `/api/v1/assets/moesekai/media`  | 浏览远端背景 / BGM 列表（不下载）                               |
| `POST` | `/api/v1/assets/fetch`           | 手动拉取模型、背景或 BGM 到本地 `resources/`                    |
| `GET`  | `/api/v1/health`                 | 健康检查（渲染池、GPU、TTS、LLM、清理统计）                     |
| `GET`  | `/api/v1/status`                 | 查看当前正在跑的、排队中的和最近 10 次导出记录                  |
| `POST` | `/api/v1/cleanup`                | 立即清理过期导出文件和过期临时目录                              |
| `GET`  | `/api/v1/cleanup/stats`          | 查看自动清理策略和累计清理计数                                  |

AI 剧本生成和云端拉取的详细参数看 [宿主内置 AI 剧本生成](ai-script.md) 和 [云端资源获取](cloud-assets.md)。

---

## 提交导出：`POST /api/v1/export`

支持**同步等待（默认 `wait: true`）**和**异步入队（`wait: false`）**两种用法。无论哪种模式，收到请求后都会先做尺寸校验、故事 Schema 校验、云端素材按需下载，以及（启用 IrodoriTTS 时）日语 `ttsText` 预检，全部通过才会放进队列。

请求体只认下面三个字段（分辨率、帧率、编码器、TTS 等全部走宿主 `config.yaml`）：

| 字段      | 必填 | 说明                                                                                         |
| --------- | ---- | -------------------------------------------------------------------------------------------- |
| `story`   | 是   | 完整故事对象，含 `models`、`images`、`snippets` 三个数组，见 [故事文件格式](story-format.md) |
| `timeout` | 否   | 正整数，单位毫秒，范围 `1` ~ `2147483647`，默认 `1800000`（30 分钟）。**包含排队时间**       |
| `wait`    | 否   | 布尔值，默认 `true`。`true` 一直等到出片返回 200；`false` 立刻返回 202 和 `taskId`           |

### 同步调用示例

```bash
node -e 'const fs = require("node:fs"); process.stdout.write(JSON.stringify({story: JSON.parse(fs.readFileSync(process.argv[1], "utf8")), timeout: 600000}))' \
  ./your-story.sekai-story.json |
  curl --max-time 660 -sS -X POST http://127.0.0.1:9881/api/v1/export \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $MSST_API_KEY" \
    --data-binary @-
```

> [!NOTE]
> 同步模式下如果客户端提前断开连接或超过 `timeout`，宿主会自动取消该任务，避免白占 GPU。

成功返回 HTTP 200：

```json
{
  "success": true,
  "message": "Video exported successfully",
  "videoPath": "C:\\mss\\apifile\\export-1800000000000-demo01.mp4",
  "fileSize": 5242880,
  "duration": 21.4,
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
    "avgPumpFps": 72.6,
    "videoDurationMs": 30000
  },
  "logPath": "C:\\mss\\apifile\\export-1800000000000-demo01.log",
  "logJsonPath": "C:\\mss\\apifile\\export-1800000000000-demo01.log.json",
  "reportPath": "C:\\mss\\apifile\\export-1800000000000-demo01.report.txt",
  "downloadUrl": "/api/v1/download/export-1800000000000-demo01.mp4"
}
```

重点字段说明：

- `duration`：**这次渲染导出一共花了多少秒（墙钟耗时，不含排队时间）**，不是视频本身有多长。
- `timings.videoDurationMs`：这才是成片视频本身的毫秒时长（`frameCount / encodeFps * 1000`）。
- `downloadUrl`：拿去拼在服务地址后面下载视频，例如 `http://127.0.0.1:9881/api/v1/download/...`。
- `logPath` / `logJsonPath` / `reportPath`：同目录下自动生成的诊断日志、结构化 JSON 日志和交付报告。

### 异步调用（`wait: false`）

如果你的调用方经过反代、Bot 网关或不能长时间挂着 HTTP 连接，传 `"wait": false` 会立刻返回 HTTP 202：

```json
{
  "success": true,
  "taskId": "export-1800000000000-demo01",
  "status": "queued",
  "statusUrl": "/api/v1/export/export-1800000000000-demo01/status"
}
```

然后定时轮询 `GET /api/v1/export/:taskId/status`。异步模式下超出 `timeout` 后宿主也会自动取消任务，并把状态记为 `failed`。

### 限流规则

`/api/v1/export`、`/api/v1/script/generate`、`/api/v1/generate` 三个接口共用按客户端 IP 的限流：**每 60 秒窗口最多 10 次请求**（内存表上限 10,000 个 IP）。超限返回 HTTP `429`，同时带 `Retry-After` 响应头和响应体字段 `retryAfterSeconds`。

---

## 查询与取消任务

### `GET /api/v1/export/:taskId/status`

可能返回的 `status`：

- 进行中：`queued`（排队中，带 `queuePosition`）、`processing`（正在渲染或收尾落盘）、`pending`（刚登记尚未入队或刚退出的过渡态）
- 已结束（保留 **1 小时**，最多 **200 条**）：`completed`（带完整 `result`，含 `downloadUrl`）、`failed`（带脱敏 `error.message`）、`cancelled`
- 找不到或已过期淘汰：`{ "taskId": "...", "status": "unknown" }`

`elapsedSeconds` 表示从提交登记算起经过的秒数。

### `POST /api/v1/export/:taskId/cancel`

不用传请求体。会立即取消排队或正在渲染的任务，关闭对应的文件句柄和帧管道（`FramesPipeSession`），并删掉本次生成的临时目录，等待清理完成后返回：

```json
{
  "taskId": "export-1800000000000-demo01",
  "cancelled": true
}
```

如果任务已经结束或不存在，返回 `cancelled: false`。

---

## 文件列表与下载

### `GET /api/v1/files`

分页列出输出目录（默认 `apifile/`）中的 `.mp4`、`.json`、`.log`、`.txt` 文件。

- `page`：页码，从 `1` 开始（默认 `1`）
- `limit`：每页条数，`1` ~ `100`（默认 `20`）
- `sort`：`asc` 按修改时间升序，其余全部按降序（默认 `desc`）

### `GET /api/v1/download/:filename`

只传文件名，不要带路径斜杠或 `..`。服务端会做字符检查并用 `fs.realpathSync` 校验真实路径没有通过软链接跳出输出目录。支持 `.mp4`、`.json`、`.log`、`.txt`、`.webm`。

---

## 资源目录与云端刷新

### `GET /api/v1/resources`

返回本地和云端合并后的完整可用素材目录（内存缓存 30 秒；冷启动无快照时最多等 60 秒首轮拉取，有快照最多等 2 秒刷新）：

- `models`：含角色 id、`name`、`shortName`、`path`、`motions`、`facials`、`defaultMotion`、`defaultFacial`、`source`（`local` / `cloud`）以及服装分类、组合标签等。
- `images` / `imageDetails`：背景列表及中文地点名、别名、`timeOfDay`、室内外标签。
- `bgm` / `bgmDetails`：BGM 列表及曲名、情绪、节奏描述。
- `seDetails`：云端 SE 音效列表及场景分类标签。
- `cloud`：云端目录统计（`generatedAt`、`models`、`backgrounds`、`bgm`、`se`）。

注意：**本地 `models.yaml` 只占对应角色的默认首选位，不会屏蔽该角色的其他云端服装或别的角色**；本地已下载的背景和 BGM 也会自动贴上官方中文名和标签。

### `POST /api/v1/cloud/refresh`

无请求体，强制立刻重新拉取远端索引并更新 `<assets.cacheDir>/catalog.json`。如果 `assets.cloudCatalog` 被关闭则返回 HTTP `409`。

---

## 健康检查与队列状态

### `GET /api/v1/health`

该接口不要求 Bearer 鉴权（方便监控探活）。注意 `status: "ok"` 只代表 HTTP 服务活着，还要重点看 `renderPool.readyWorkers` 和 `renderPool.webglRenderers`。

当服务开启了 `apiKey` 且调用方没带合法 Bearer 令牌时，接口会自动隐藏敏感配置：`tts.apiBaseUrl`、`llm.baseUrl`、`assets.indexBase`、`assets.libraryBase` 不会返回，`ttsLease` 只返回计数与 `hasWeights`。

主要字段：`activeExports`、`queuedExports`、`pendingExports`、`cleanup`、`videoConfig`（含真实的 `codec`：`hevc` 或 `h264`）、`renderPool`、`ttsLease`、`tts`、`llm`、`assets`、`host`（含启动时实测出来的 `ffmpegEncoderDetected`）。

### `GET /api/v1/status`

返回当前队列快照：`activeExports`、`queuedExports`、`pendingExports`、`maxConcurrent`、`activeTaskIds`、`queuedTaskIds` 以及最多 10 条 `recentExports`（里面的 `durationMs` 包含排队时间）。

---

## 自动清理

- **定时清理**：每 60 分钟自动跑一次。
  - 输出目录（`apifile/`）里修改时间超过 **24 小时** 的 `.mp4`、`.json`、`.log`、`.txt` 会被删除（正在导出的任务产物会跳过）。
  - 系统临时目录与输出目录里超过 **6 小时** 的残留临时项（`mss-fpipe-*`、`mss-hf-*`、`mss-export-*`、`mss-api-audio-*`、`mss-audio-*`、`mss-fast-*` 和 `.mss-frames-video-*.mp4`）会被清掉。
- **手动触发**：`POST /api/v1/cleanup` 立即跑一遍清理；`GET /api/v1/cleanup/stats` 查看策略和累计清理数。

---

## 常见状态码

| 状态码 | 常见原因                                                                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `200`  | 正常成功（查不到任务时返回 `status: "unknown"` 也是 200）                                                                    |
| `202`  | `POST /api/v1/export` 传了 `wait: false`，异步入队成功                                                                       |
| `204`  | CORS `OPTIONS` 预检                                                                                                          |
| `400`  | 故事格式错、尺寸不是偶数、`timeout` / `exportTimeout` 非正整数、`wait` 非布尔值、缺失日文 `ttsText` 预检失败、下载文件名非法 |
| `401`  | 开启了 `apiKey` 但未提供或提供了错误的 Bearer 密钥                                                                           |
| `404`  | 下载文件不存在或软链接越界                                                                                                   |
| `409`  | `cloudCatalog: false` 时调用 `/cloud/refresh`，或重复并发调用 `/assets/fetch`                                                |
| `422`  | AI 剧本生成/校验失败，或 `llm.enabled` 为 `false`                                                                            |
| `429`  | 触发 IP 限流（10 次/60 秒，看 `Retry-After`）或 AI 并发生成数达上限                                                          |
| `500`  | 导出失败、同步等待超时/被取消、生成成功但导出阶段报错                                                                        |
| `502`  | 上游 LLM 或云端资源站请求失败                                                                                                |
| `503`  | 渲染池还没就绪，或 TTS 权重租约被中止                                                                                        |
| `504`  | AI 剧本生成阶段超时                                                                                                          |
