# API

[返回 README](../README.md) · [故事文件格式](story-format.md) · [资源与音频配置](resources.md)

本文对应当前宿主的 HTTP API。本机访问地址示例为 `http://127.0.0.1:9881`；默认监听 `0.0.0.0:9881`，可通过宿主配置修改。
API 没有内置鉴权，部署边界见 [安全提示](host-deployment.md#安全提示)。下文任务 ID、路径、资源名与统计值均为**示意值**，不是仓库自带素材或实际运行结果。

本文导航：[端点一览](#通用约定与端点) · [提交导出](#提交导出post-apiv1export) · [在途任务](#在途任务查询与取消) · [文件分页](#文件分页get-apiv1files) · [资源目录](#资源目录get-apiv1resources) · [健康检查](#健康检查get-apiv1health) · [状态码](#常见状态码速查)

## 通用约定与端点

- 导出请求使用 `Content-Type: application/json`，JSON 请求体上限为 `50mb`。
- 除下载外，下面各端点返回 JSON；响应结构不统一，不能假定所有响应都带 `success`。
- `downloadUrl` 是相对地址，应与服务地址组合；`videoPath` 是宿主文件路径，不是客户端本地路径。
- CORS 允许任意来源、`GET/POST/OPTIONS` 和 `Content-Type` 请求头；预检返回 HTTP 204。这不等同于访问控制。

| 方法 | 端点                            | 用途                                 |
| ---- | ------------------------------- | ------------------------------------ |
| POST | `/api/v1/export`                | 提交故事，同步等待导出结果           |
| GET  | `/api/v1/export/:taskId/status` | 查询单个在途任务                     |
| POST | `/api/v1/export/:taskId/cancel` | 取消指定在途任务                     |
| GET  | `/api/v1/files`                 | 分页列出导出目录中的文件             |
| GET  | `/api/v1/download/:filename`    | 下载指定文件                         |
| GET  | `/api/v1/resources`             | 获取模型、动作、表情、背景及音频目录 |
| GET  | `/api/v1/health`                | 查看宿主、渲染池与清理状态           |
| GET  | `/api/v1/status`                | 查看队列与近期导出统计               |
| POST | `/api/v1/cleanup`               | 立即执行一次过期导出文件清理         |
| GET  | `/api/v1/cleanup/stats`         | 查看清理策略与累计统计               |

## 提交导出：`POST /api/v1/export`

这是**长连接同步请求**：服务端完成校验、排队和导出后，才返回成功或失败结果；不会以 HTTP 202 提前返回 `taskId`。

| JSON 字段 | 必填 | 类型与规则                                                                                   |
| --------- | ---- | -------------------------------------------------------------------------------------------- |
| `story`   | 是   | 完整故事对象，包含 `models`、`images`、`snippets` 数组；详见 [故事文件格式](story-format.md) |
| `timeout` | 否   | 整数，单位毫秒，范围 `1`～`2147483647`；默认 `1800000`（30 分钟）                            |

请求只读取上述两个字段。输出文件名由服务端生成；尺寸、帧率、编码、导出模式、TTS 与 BGM 等使用宿主配置，不支持在此请求中覆盖。
格式校验通过不代表资源可用：实际渲染要求宿主能加载故事引用的模型和背景；启用的 TTS/BGM 还需相应服务或音频文件可用。故事中的预录 `voice` 当前不进入 API 导出音轨，详见 [预录语音字段](resources.md#预录语音字段)。

### 同步调用示例

以下命令用于 Bash / Git Bash。先将路径替换为**已有且资源匹配的故事文件**；不能把裸故事对象直接提交为请求体。
客户端超时设为 660 秒，略大于请求中的 600000 毫秒；反向代理的超时也应覆盖排队与渲染时间。

```bash
node -e 'const fs = require("node:fs"); process.stdout.write(JSON.stringify({story: JSON.parse(fs.readFileSync(process.argv[1], "utf8")), timeout: 600000}))' \
  ./your-story.sekai-story.json |
  curl --max-time 660 -sS -X POST http://127.0.0.1:9881/api/v1/export \
    -H "Content-Type: application/json" --data-binary @-
```

成功时返回 HTTP 200，例如：

```json
{
  "success": true,
  "message": "Video exported successfully",
  "videoPath": "C:\\mss\\apifile\\export-1800000000000-demo01.mp4",
  "fileSize": 5242880,
  "duration": 41.2,
  "frameCount": 900,
  "timings": { "recordMs": 35000, "mergeMs": 4500, "videoDurationMs": 30000 },
  "downloadUrl": "/api/v1/download/export-1800000000000-demo01.mp4"
}
```

| 响应字段             | 含义                                                          |
| -------------------- | ------------------------------------------------------------- |
| `success`、`message` | 成功标志与结果说明                                            |
| `videoPath`          | 已生成视频在宿主上的路径；格式随宿主操作系统变化              |
| `fileSize`           | 服务端检查产物得到的文件字节数                                |
| `duration`           | **渲染侧导出耗时，单位秒，不是视频时长，也不含 API 排队时间** |
| `frameCount`         | 渲染结果报告的帧数                                            |
| `timings`            | 所用导出模式的统计对象，具体字段见下文                        |
| `downloadUrl`        | 视频下载相对地址                                              |

`duration`、`frameCount`、`timings` 随渲染结果透传，调用方应允许统计字段缺省。`timings` 不是所有数值都代表耗时：

- `record` 模式：`recordMs` 为录制阶段耗时，`mergeMs` 为合并阶段耗时，均为毫秒；`videoDurationMs` 才是该模式报告的视频时长（毫秒）。
- `fast` 模式：`pumpMs`、`tickMs`、`renderMs`、`snapshotMs`、`ttsWaitMs`、`encodeMs`、`audioMs`、`invokeMs` 是毫秒统计，分别覆盖帧循环、时间推进、渲染、采样、等待 TTS、编码、音频处理和宿主调用。
- `fast` 的 `frames` 是帧循环计数，`avgPumpFps` 是平均帧循环速率（帧/秒）；不要把这些统计直接相加当成总耗时。

### 超时、限流与失败

- `timeout` 从任务提交后计时，**包含排队时间**；它不是“开始渲染之后再等这么久”。
- 响应完成前客户端断开，或任务超时，宿主会发起取消，不是继续后台等待下载的异步任务。
- 仅导出端点按服务端识别的客户端 IP 限流：每个 60 秒窗口最多 10 次请求；校验失败的请求也会消耗额度。
- 触发限流返回 HTTP 429，形如 `{"success":false,"message":"Too many requests. Please try again later.","retryAfterSeconds":60}`；`retryAfterSeconds` 单位为秒，当前固定报告 60。
- 故事缺失、格式错误或非法 `timeout` 返回 HTTP 400；故事格式错误额外带字符串 `details`，内容是校验错误信息。
- 导出失败、超时、取消、结果文件缺失通常返回 HTTP 500；未设置任务分发器返回 HTTP 503，不代表所有 worker 忙时就会拒绝请求。

超时错误示例（HTTP 500；此处以 600 秒为例）：

```json
{ "success": false, "message": "Export timed out after 600 seconds" }
```

## 在途任务：查询与取消

`taskId` 由服务端生成，形如 `export-时间戳-随机后缀`。提交接口既不预先返回它，成功响应也没有独立的 `taskId` 字段。
已知 ID 时可调用下面接口；也能在 `GET /api/v1/status` 的 `activeTaskIds`、`queuedTaskIds` 中观察全局在途 ID。
该列表不是“本次提交对应 ID”的回执，并发客户端不能靠猜测或取列表首项可靠关联自己的请求。

### `GET /api/v1/export/:taskId/status`

唯一参数是路径中的 `taskId`，无请求体；正常返回 HTTP 200。例如：

```json
{
  "taskId": "export-1800000000000-demo01",
  "status": "queued",
  "elapsedSeconds": 12.5,
  "queuePosition": 2
}
```

- `status` 为 `processing`（API 已派发）、`queued`（仍在 API 队列）或 `pending`（已登记但不在前两者中）。
- `elapsedSeconds` 为自登记以来的秒数，包含等待；不是进度百分比，也不是剩余时间。
- `queuePosition` 为 API 等待队列中从 1 开始的位置；非 `queued` 时为 `null`。
- `processing` 不保证此刻已经在渲染：任务仍可能暂存在渲染池内部缓冲队列中。
- 不存在或已结束的任务返回 `{"taskId":"…","status":"unknown"}`，仍为 HTTP 200，不含上述计时/排位字段。

记录在请求结束后删除，不提供持久化的 `completed` / `failed` 查询；应保存原始导出请求的结果。

### `POST /api/v1/export/:taskId/cancel`

只传路径参数 `taskId`，**无需 JSON 请求体，也没有 `force`、`reason` 等取消选项**。以下两条命令独立使用：

```bash
TASK_ID='export-1800000000000-demo01' # 替换为已知的在途 ID
curl -sS "http://127.0.0.1:9881/api/v1/export/$TASK_ID/status"
curl -sS -X POST "http://127.0.0.1:9881/api/v1/export/$TASK_ID/cancel"
```

返回 HTTP 200：`{"taskId":"export-1800000000000-demo01","cancelled":true}`。
未找到可取消任务时 `cancelled` 为 `false`；重复取消可能出现这种结果。
`true` 表示宿主已处理取消，**不保证 worker 当场空闲或磁盘产物全部删除**；原先等待的导出请求会以 HTTP 500 返回 `Export cancelled by user`。
底层中止与回收机制见 [取消与故障恢复](host-deployment.md#取消与故障恢复)。

## 文件分页：`GET /api/v1/files`

| 查询参数 | 默认值 | 规则                                                                   |
| -------- | ------ | ---------------------------------------------------------------------- |
| `page`   | `1`    | 从 1 开始；按 `parseInt` 解析，结果至少为 1，无法解析或为 0 时取默认值 |
| `limit`  | `20`   | 每页数量；按 `parseInt` 解析后限制在 1～100，无法解析或为 0 时取默认值 |
| `sort`   | `desc` | 按文件修改时间排序；只有精确的 `asc` 表示旧到新，其余值均为新到旧      |

```bash
curl -sS 'http://127.0.0.1:9881/api/v1/files?page=1&limit=20&sort=desc'
```

HTTP 200 响应示例：

```json
{
  "success": true,
  "data": [
    {
      "filename": "export-1800000000000-demo01.mp4",
      "size": 5242880,
      "sizeHuman": "5.0 MB",
      "createdAt": "2027-01-15T08:00:00.000Z",
      "modifiedAt": "2027-01-15T08:00:41.000Z",
      "downloadUrl": "/api/v1/download/export-1800000000000-demo01.mp4"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

`size` 为字节，`sizeHuman` 按 1024 换算显示；时间为 ISO 8601 UTC 字符串。
`pagination` 报告实际采用的页码/页大小与文件总数/总页数；超出范围的页返回空 `data`，目录为空时 `totalPages` 为 0。
列表筛选输出目录中的 `.mp4`、`.json`，不是成功任务历史，也没有保证排除正在写入的文件。读取目录失败返回 HTTP 500。

## 下载：`GET /api/v1/download/:filename`

路径参数为文件名，不是完整 `videoPath`。优先使用成功导出或文件列表提供的 `downloadUrl`：

```bash
curl -fS 'http://127.0.0.1:9881/api/v1/download/export-1800000000000-demo01.mp4' \
  --output ./result.mp4
```

- HTTP 200 直接返回文件流，设置 `Content-Type: video/mp4`、字节数 `Content-Length`、附件 `Content-Disposition` 和 `Cache-Control: no-cache`。
- 当前下载路由固定使用 MP4 MIME 类型，即使文件列表中包含 `.json` 也不会自动推断类型；未实现 `Range` 分段下载。
- 空文件名或含 `..`、`/` 的文件名会被路由校验拒绝（HTTP 400，`{"error":"Invalid filename"}`）。
- 文件不存在返回 HTTP 404，`{"error":"File not found","path":"宿主文件路径"}`；过期文件被清理后也会如此。
- 文件流读取失败且响应头尚未发出时返回 HTTP 500、`{"error":"Failed to read file"}`；已开始传输时则中断连接。

## 资源目录：`GET /api/v1/resources`

无参数、无请求体；HTTP 200 返回 `success` 与目录字段，可用于生成故事时校验候选资源名称。下面是虚构资源的结构示意，不可直接当成可用素材：

```json
{
  "success": true,
  "models": [
    {
      "id": 101,
      "name": "示意角色",
      "shortName": "示意",
      "path": "demo/demo.model3.json",
      "motions": ["w-normal-default01"],
      "facials": ["face_smile_01"],
      "defaultMotion": "w-normal-default01",
      "defaultFacial": "face_smile_01"
    }
  ],
  "images": ["demo-room.png"],
  "imageDetails": [
    { "file": "demo-room.png", "name": "示意房间", "description": "仅演示字段结构" }
  ],
  "voices": ["demo-line.wav"],
  "bgm": ["demo-bgm.mp3"]
}
```

- `models[].path` 相对资源根的 `models/`；`id` 是目录中的数字标识，`shortName` 未单独登记时回退为 `name`。
- `motions`、`facials` 是动作索引键名，不是文件 URL；`face_` 前缀归入表情。默认动作/表情从可用项中选择，列表为空时默认值为空字符串。
- `images` 为资源根 `images/` 下的文件名；`imageDetails` 是其中已登记描述的子集，未登记时为空数组。
- `voices`、`bgm` 分别来自资源根 `voices/`、`audio/bgm/`；只列直接子文件，不递归目录。图像扩展名支持 `.jpg/.jpeg/.png/.webp`，音频支持 `.mp3/.wav/.ogg/.flac`。
- 目录使用 30 秒内存缓存；构建失败沿用旧缓存，无旧缓存时返回各目录空数组，外层仍为 `success: true`。空目录不等同于服务不可达。
- 查询目录时可能补齐并回写模型缺失的动作索引，因此它不应被当作完全无磁盘副作用的探针。

## 健康检查：`GET /api/v1/health`

无参数，HTTP 200；`status: "ok"` 表示该路由可响应，**不保证全部 worker 就绪、素材完整或后续导出成功**。

| 顶层字段                                           | 结构与含义                                                                                                                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status`、`version`                                | 当前分别为 `"ok"`、`"2.0.0"`；`version` 是接口中固定的值                                                                                                                                         |
| `activeExports`、`queuedExports`、`pendingExports` | API 已派发数、API 等待队列数、等待导出结果的请求数；均为数量                                                                                                                                     |
| `cleanup`                                          | 与 `/cleanup/stats` 相同的对象                                                                                                                                                                   |
| `videoConfig`                                      | `width/height`（像素）、`renderScale`（倍率）、`fps`（帧/秒）、`codec`（当前 `h264`）、`crf`（编码质量参数）、`audioBitrate`（如 `128k`）、`watermark`、`watermarkText`、`idleChainGapSec`（秒） |
| `renderPool`                                       | 渲染池观测对象，字段见下文                                                                                                                                                                       |
| `host`                                             | `platform`（平台）、`node`（Node 版本）、`ffmpegEncoder`（配置值）、`ffmpegEncoderDetected`（探测缓存：`nvidia/amd/intel/cpu` 或 `null`）                                                        |

`renderPool` 包含 `configuredWorkers`、`readyWorkers`、`idleWorkers`（数量），`busyTaskIds`（占用 worker 的任务 ID 数组）、`bufferedTasks`（内部缓冲任务数）、`exportsCompleted`（worker 已释放的任务计数，不是成功数），以及 `webglRenderers` 数组。
每个 WebGL 条目形如 `{"workerId":"w1","renderer":"示意 GPU renderer"}`；尚无结果时 `renderer` 可以为 `null`。
API 队列与池内部缓冲是不同层级；取消后池内 worker 也可能短暂仍显示忙。
WebGL renderer 与 ffmpeg 编码探测是两回事；有硬件 WebGL 或探测到编码器，不等于每次编码都确实走了硬件。

## 队列概览：`GET /api/v1/status`

无参数，HTTP 200；不触发导出。示例：

```json
{
  "activeExports": 1,
  "queuedExports": 0,
  "pendingExports": 1,
  "maxConcurrent": 2,
  "activeTaskIds": ["export-1800000000000-demo01"],
  "queuedTaskIds": [],
  "recentExports": [
    {
      "taskId": "export-1799999900000-demo02",
      "durationMs": 51200,
      "success": true,
      "finishedAt": 1799999951200
    }
  ]
}
```

计数定义与 `/health` 一致，`maxConcurrent` 为 API 并发上限，正常宿主接线使用配置的 worker 数。
`queuedTaskIds` 按 API 等待队列顺序排列。`recentExports` 最多保留最近 10 条结果回调记录，最新在前，不是完整或持久化任务历史；直接取消/超时不保证出现在其中。
其中 `durationMs` 为自 API 登记以来的毫秒数，**包含排队**，不要与导出响应的 `duration` 混用；`finishedAt` 为 Unix 毫秒时间戳，`success` 为回调报告的结果标志。

## 清理：`POST /api/v1/cleanup` 与 `GET /api/v1/cleanup/stats`

两者均不接受业务参数，无需请求体。手动清理只按现有策略清理过期产物，不支持传入任意路径、保留期或“删除全部”选项。

```bash
curl -sS http://127.0.0.1:9881/api/v1/cleanup/stats
curl -sS -X POST http://127.0.0.1:9881/api/v1/cleanup
```

- `POST /cleanup` 返回 HTTP 200：`{"success":true,"filesCleaned":2,"totalFilesCleaned":5,"retentionHours":24}`。`filesCleaned` 是本次删除文件数，`totalFilesCleaned` 是本进程累计数。
- `GET /cleanup/stats` 返回 HTTP 200：`{"intervalMinutes":60,"retentionHours":24,"lastCleanupTimestamp":1800000000000,"totalFilesCleaned":5}`。时间戳为 Unix 毫秒，尚未清理时为 `null`。
- 定时周期为 60 分钟；输出目录中 `.mp4/.json` 文件按**修改时间**判断，超过 24 小时才删除，跳过 API 当前活跃任务的同名产物。
- 手动接口只触发输出目录清理；系统临时目录的过期导出文件由定时流程另行清扫，不计入上述导出文件累计数。
- 单项删除失败仅记日志，`success: true` 不保证所有符合条件的文件都已删除。清理计数及最近任务统计在进程重启后重置。

## 常见状态码速查

| HTTP 状态 | 当前实现中的典型情况                                                 |
| --------- | -------------------------------------------------------------------- |
| 200       | 正常 JSON/下载；也包括任务 `unknown`、`cancelled: false`、空文件列表 |
| 204       | CORS `OPTIONS` 预检                                                  |
| 400       | 导出故事或 `timeout` 校验失败；下载文件名校验失败                    |
| 404       | 下载文件不存在                                                       |
| 429       | 导出端点达到按 IP 的请求频率限制                                     |
| 500       | 渲染失败、导出超时/取消、产物缺失、文件列表/读取失败等               |
| 503       | 导出接口尚未设置任务分发器                                           |

一般导出/列表错误为 `{"success":false,"message":"…"}`；下载错误用 `error` 字段。不要仅按某一固定错误文本或假定所有失败都是同一种 JSON 来判断请求结果。
