# 服务器优化与稳定性设计（2026-11-12）

> 记录日期：2026-11-12。本文是实施后补齐的设计文档，用于审计“为什么这样改、取舍是什么、如何验证”。
> 执行方式：用户在当晚要求直接完成优化、测试与部署（明天上线），因此没有单独的审批往返；所有决策均以实测数据为依据。

## 1. 背景与目标

两个渲染宿主部署在 `192.168.31.54`：

- MSST（MySekaiStoryteller API）：`/vol2/1000/MySekaiStoryteller`，端口 9881，systemd `mysekai-api`。
- ournotes-player：`/vol2/1000/ournotes-player`，端口 9882，systemd `ournotes-api`。

目标：

1. 两个项目都按 **2 并发**上线。
2. 降低生成耗时（渲染、编码、TTS 排队）。
3. 保证稳定性：崩溃隔离、取消、超时、队列保护、看门狗。
4. 优化占用：GPU 空闲功耗、显存、磁盘临时文件。
5. 上线前完成暴力稳定性与功能测试，并推送代码。

## 2. 约束

| 项 | 实测 |
| --- | --- |
| CPU | Intel i5-4590，4 核 4 线程 |
| 内存 | 15.9 GB，负载下已用约 10 GB |
| GPU | NVIDIA CMP 40HX，8 GB 显存 |
| 磁盘 | `/` 63 GB（14 GB 可用）、`/vol2` 55 GB（17 GB 可用）、`/vol3` 111 GB（14 GB 可用） |
| 共享服务 | Irodori-TTS `:8088`（单合成槽、单 GPU）、new-api `:5000`、AstrBot `:6185` |
| 聊天 TTS | `astrbot_plugin_Irodori_TTS`，`auto.tts_prob=1.0`（每条回复配音） |

关键约束：Irodori 与两个渲染宿主共用同一张 8 GB 显卡；聊天 TTS 与视频 TTS 共用一个 FIFO 合成槽。

## 3. 实测基线（优化前）

| 场景 | 结果 |
| --- | --- |
| MSST 空闲 | 一个 Chrome GPU 进程连续 9 小时 99% SM；整卡 100%、96 W、75 度，`/health` 仍显示全部 idle |
| ournotes 12 句 / 36 秒纯渲染 | 总 207.5 s，渲染段 195.2 s（约 5.5 fps），成片 4.33 MB（libx264） |
| ournotes 编码 | 每次渲染日志固定出现 `h264_nvenc failed → h264_amf failed → h264_qsv failed`，最终 libx264 |
| Irodori 显存 | 常驻 5.4 GB（LoRA 缓存 8 个，每个 adapter 约 323 MB 磁盘） |
| MSST 24 snippet 导出 | 1290.7 s（21.5 分钟），其中 TTS 约 14 分钟 |
| TTS 排队 | 聊天高峰 5-8 请求/分钟；单句 `elapsed` 100-284 秒，`X-Irodori-Total-To-Decode` 仅 3-8 秒 |
| MSST 桥接 TTS | `/bridge/proxy/tts-fetch` 写死 120 秒超时，与 `tts.timeoutMs=180s` 不一致；高峰每 2 分钟一条 `TimeoutError`，该句被静音跳过 |
| MSST 临时帧 | fast 导出成功后 `/tmp/mss-hf-*` 不删除，每份 50-400 MB；1 小时积压 5 份约 1.4 GB |
| ournotes Chrome 崩溃 | 渲染中杀 Chrome，任务不失败，占队列槽直到 `render.taskTimeoutMs`（1 小时） |

## 4. 方案比较

### 方案 A：只调配置

- 内容：oursnotes 改 `ffmpegPath`、`crf`、`queue.concurrency`；MSST 改 `workers`；Irodori 改缓存。
- 优点：零代码风险，回滚快。
- 缺点：解决不了 MSST 空闲 GPU 100%、桥接 120 秒超时、帧目录泄漏、Chrome 崩溃占槽；2 并发下仍会缺句/卡死。

### 方案 B：配置 + 宿主代码加固（选用）

- 内容：A 的全部配置，加 MSST ticker 生命周期、`maxConcurrentExports` 与 worker 解耦、桥接超时对齐、帧目录即时清理；ournotes 浏览器关闭信号与渲染结果 race。
- 优点：直接命中实测瓶颈；改动集中在少数文件，可单测/可回滚；不改变剧本格式和对外 API。
- 缺点：需要重新构建并部署 MSST 的 `out-host` 与 `webrenderer`；ournotes 需要重启宿主。

### 方案 C：给视频 TTS 做优先级/独立容量

- 内容：改 Irodori 调度器，视频请求优先于聊天；或再起一个 TTS 实例。
- 优点：能从根上缩短视频等待。
- 缺点：需要改第三方服务调度器；会造成聊天 TTS 饥饿；8 GB 显存下第二个实例与渲染争显存，风险高。**本次不采用**，作为后续可选项记录。

**结论：采用方案 B。** 方案 C 的容量问题在“风险”一节明确记录，并给出用户可调的聊天 `tts_prob` / 剧本长度两个杠杆。

## 5. 设计

### 5.1 MSST：worker 生命周期

```
api:start-export ──> ticker.start() ──> runApiExport() ──> api:export-result ──> ticker.stop()
```

- 页面主 ticker 只在导出期间运行。导出结果回传后的 `finally` 停止，空闲 worker 不再按 60 fps 渲染已加载的 Live2D 场景。
- 快导出内部会自己停/启 ticker；导出入口统一 `start()`，避免上一单 `finally` 的 `stop()` 影响下一单。
- worker 崩溃/断连沿用池的现有恢复：标记任务失败、重启浏览器、重新就绪。

### 5.2 MSST：并发与热备

`render.workers` 与 `render.maxConcurrentExports` 解耦：

- `workers: 3`：3 个常驻浏览器。
- `maxConcurrentExports: 2`：同时最多 2 个导出，第 3 个在 API 队列等待。
- 第 3 个 worker 是热备：某个 worker 崩溃或按 `workerRecycleExports` 回收时，新浏览器启动期间仍有空闲 worker 接单。

默认值 `maxConcurrentExports: 0` 表示跟随 `workers`，保持旧行为；env `MSS_MAX_CONCURRENT_EXPORTS` 可覆盖。

### 5.3 MSST：TTS 代理超时

`/bridge/proxy/tts-fetch` 的超时从常量 120 秒改为 `max(120s, config.tts.timeoutMs)`。服务器 `tts.timeoutMs: 600000`。

理由：Irodori 在聊天高峰的排队可达 300 秒（服务端 `synthesis_wait_timeout=300`），加上合成与编码，120 秒必然先于宿主超时；桥接先返回空响应会让渲染端把该句当失败/静音。

### 5.4 MSST：帧目录清理

fast 导出走 JPEG 帧序列 + ffmpeg NVENC。桥接在 `electron:api-encode-frames-video` 成功写出成片后：

1. 删除 `framesDir`（递归）。
2. 若父目录是 `mss-hf-*` 且为空，删除父目录。
3. 失败时保留，交给宿主的 6 小时 temp sweep 与服务器 15 分钟兜底定时器。

### 5.5 ournotes：编码与并发

- `video.ffmpegPath: /usr/bin/ffmpeg`（mediasrv 7.1.3，带 NVENC）。`ffmpeg-static` 的构建不含 `h264_nvenc`。
- `video.crf: 28`：NVENC 的 `-cq` 与 x264 的 `-crf` 共用该值。cq20 会让 36 秒成片从 5.9 MB 涨到 20.6 MB。
- `queue.concurrency: 2`：两个渲染并行；站点写入已有 `_withSiteWrite` 互斥和原子写，advId 从磁盘扫描分配。

### 5.6 ournotes：浏览器崩溃快速失败

```
Browser.launch() ──> closedSignal
render():  Promise.race([job.result, browser.onClosed() -> throw])
```

- `Browser` 在进程退出或 DevTools WebSocket 关闭时 resolve `closedSignal`。
- 渲染等待结果时与 `closedSignal` race：Chrome 被杀后任务在秒级失败，而不是等 `render.taskTimeoutMs`（服务器改为 30 分钟）。
- `finally` 仍负责关浏览器、关 page server、删 frame 目录。

### 5.7 服务器：显存与共享 TTS

- Irodori `IRODORI_LORA_CACHE_SIZE=8 → 3`：空闲显存 5.4 GB → 2.2 GB，加载 3 个 adapter 后约 3.4 GB。
- 代价：聊天在多角色之间切换时 adapter 换入换出变多（实测 30 分钟 138 次）。这是为双并发渲染留显存的必要取舍。
- 2+2 压测显存峰值 6.29 GB，未 OOM。

### 5.8 服务器：看门狗与临时文件

- `render-healthcheck.timer`：每 2 分钟探两个 `/health`，连续 3 次失败才 `systemctl restart` 对应 unit。
- `mss-temp-clean.timer`：每 15 分钟删除 30 分钟未写入的 `/tmp/mss-hf-*`。它覆盖“运行中的旧构建”和硬崩溃；新构建成功后即时清理。

## 6. 错误处理与降级

| 故障 | 行为 |
| --- | --- |
| MSST worker 浏览器崩溃 | 该任务失败（`Render worker wX crashed during export`），其他 worker/任务不受影响；浏览器自动重启 |
| MSST 空闲页面 | ticker 停止，GPU 0% |
| MSST 导出超时 | API 返回 504，取消任务并释放 worker；插件侧按 `export_timeout` 提示 |
| MSST 客户端断连 | `res.on('close')` 取消导出，避免孤儿渲染 |
| ournotes Chrome 崩溃 | 任务秒级失败，队列释放；下一任务正常 |
| ournotes 取消 | 排队中/运行中取消都计数并释放 Chrome |
| TTS 排队超时 | 宿主 `tts.timeoutMs=600s` 覆盖服务端 300s 等待；不再 180s 提前掐断 |
| 磁盘临时帧 | 成功后即时删；失败/崩溃由 6 小时 sweep + 15 分钟定时器兜底 |
| 进程假死 | 看门狗连续 3 次健康失败后重启 |

## 7. 测试与验收

### 7.1 自动化

- MSST：`npm test`（105）、`npm run test:pool`（13）、改动文件 ESLint。
- ournotes：`npm test`（525 + 1 skip）、`npm run test:host`（178 + 3 skip）、`npm run lint`。
- 插件：`pytest`（23 + 3 subtests）。

### 7.2 功能

- ffprobe：编码/分辨率/帧率/音轨。
- 抽帧：画面、字幕、水印。
- volumedetect：音频存在且电平正常（mean 约 -22 dB，max 约 -6～-7 dB）。

### 7.3 并发与故障注入

- ournotes 单任务、2 并发；MSST 单任务、2 并发；2+2 混合。
- `kill -9` ournotes Chrome；`kill -9` MSST 空闲/忙碌 worker。
- 排队中/运行中取消；3600s 超时取消；30 分钟 soak。

### 7.4 验收标准

1. 2+2 混合提交 4/4 成功，显存 < 8 GB，无 OOM。
2. 空闲 GPU Chrome SM 为 0%，整卡功耗显著下降。
3. ournotes 36 秒视频渲染 ≤ 120 s（本机实测 108.6 s）。
4. Chrome 崩溃 10 秒内任务失败并释放队列。
5. MSST worker 崩溃只影响该任务，其他任务继续。
6. 所有测试套件通过，改动文件 lint 干净。

## 8. 风险与回滚

| 风险 | 说明 | 缓解 / 回滚 |
| --- | --- | --- |
| 共享 TTS 饱和 | 聊天 `tts_prob=1.0` + 47-59 句剧本会超过 60 分钟，实测两次 3600s 超时 | 插件超时已提到 7200s；建议 `tts_prob` 0.4-0.5 或 `max_lines` 24-30 / `targetMinutes 2`；宿主参数无法根治 |
| Irodori 缓存 3 导致换入换出 | 多角色聊天时 adapter 重载增加 | 若显存允许可调回 5-8；2+2 下保持 3 |
| 4 核 CPU 上限 | 2 个 MSST fast 导出时 `avgPumpFps` 3.7-4.5（单任务约 6.4） | 保持 2 并发；不要盲目加 worker |
| 新构建未重启 | 运行进程仍是旧代码 | 部署后 `systemctl restart`；本次已在 21:46 重启并验证帧清理 |
| 看门狗误杀 | 健康检查短暂超时 | 连续 3 次失败才重启，2 分钟间隔 |

### 回滚

- MSST：`git revert 169b0a3..684bec0`（或逐个 revert `cfcf432`/`1c61f38`），重启 `mysekai-api`。
- ournotes：`git revert 437a2ba`，重启 `ournotes-api`。
- 配置：`/tmp/*-config-*.yaml` 与 `/tmp/*-plugin-config-*.json` 保留了部署前备份。
- Irodori：把 `/etc/systemd/system/irodori-tts.service.d/lora-cache.conf` 改回 8，`systemctl daemon-reload && systemctl restart irodori-tts`。

## 9. 实施顺序与证据

1. 基线测量（bench 脚本：`/tmp/zops-bench-*.mjs`）。
2. ournotes NVENC/crf/并发配置 → 重启 → 单任务与 2 并发测量。
3. MSST ticker 修复 → 构建/部署 → 空闲 GPU 采样。
4. MSST `maxConcurrentExports` → 部署 → `/api/v1/status` 显示 `maxConcurrent=2`。
5. 桥接超时 + 帧清理 → 部署 → 功能调用验证帧目录删除。
6. ournotes `onClosed()` race → 部署 → kill Chrome 验证 5 秒失败。
7. Irodori 缓存 3 + 看门狗 + 临时清扫 → 重启/启用 → 显存与定时器验证。
8. 2+2 压测 + 故障注入 + soak → 记录结果。
9. 提交/推送：MSST `684bec0`、ournotes `437a2ba`。

完整实测记录见 `doc/server-optimization-2026-11-12.md` 与 `docs/host-tuning.md`（ournotes 仓库）。
