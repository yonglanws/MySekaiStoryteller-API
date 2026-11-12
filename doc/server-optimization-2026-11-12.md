# 服务器优化与稳定性计划（2026-11-12）

目标：两个渲染宿主（MySekaiStoryteller 9881、ournotes-player 9882）在 `192.168.31.54` 上按 **各 2 并发** 上线，降低生成耗时、限制资源占用，并保证长时间运行不雪崩。

## 1. 现场基线

硬件与系统：

| 项目 | 数值 |
| --- | --- |
| CPU | Intel i5-4590，4 核（无超线程） |
| 内存 | 15.9 GB，实测已用约 9 GB，swap 已用约 3.6 GB |
| GPU | NVIDIA CMP 40HX，8 GB 显存 |
| 磁盘 | `/vol2` 55 GB（剩 18 GB）、`/vol3` 111 GB（剩 15 GB） |
| 共享服务 | Irodori-TTS `:8088`（单 GPU、单合成槽位）、new-api `:5000`、AstrBot `:6185` |

实测问题（优化前）：

1. MSST 空闲 worker 的 Live2D 页面持续以 60 fps 渲染。一个 Chrome GPU 进程连续 9 小时占用 99% SM，5 个 worker 中多个轮流打满 GPU；`/health` 仍显示全部 idle。空闲功耗 96 W、温度 75 度，并和 ournotes 渲染抢 GPU。
2. ournotes 使用 `ffmpeg-static`，该构建**不含** `h264_nvenc`。每次渲染都依次尝试 nvenc/amf/qsv 失败，最终用 `libx264` 软编，日志中固定出现三条 `encoder ... failed`。
3. Irodori 的 LoRA 缓存上限为 8。每份 adapter 约 323 MB，常驻 5.4 GB 显存（8 GB 卡的 67%），ournotes 双并发渲染时显存余量不足。
4. ournotes 队列并发为 1，12 句（36 秒）渲染在 GPU 被空闲 worker 抢占时总耗时 207.5 秒，其中渲染 195.2 秒（约 5.5 fps）。
5. Irodori 是**共享瓶颈**：聊天 TTS 稳定在每分钟 7-9 个请求，单合成槽位 FIFO。视频 TTS 每句要排队 30-70 秒，58 句剧本的导出在 TTS 阶段就超过 8 分钟。
6. MSST 的桥接 TTS 代理写死 120 秒超时，而宿主 `tts.timeoutMs` 是 180 秒。Irodori 排队超过 120 秒时，桥接先返回 TimeoutError，渲染端重试两次后把该句当静音跳过；日志表现为每 2 分钟一条 `[Bridge] TTS proxy fetch failed TimeoutError`。这是高峰时“视频没声音”的直接原因。
7. ournotes 的 `tts.timeoutMs` 同样是 180 秒。实测 4 句台词在混合负载下 line 3 连续超时两次后被跳过，成片缺一句。
8. MSST fast 导出的 JPEG 帧序列（每份 50-400MB）在成功后没有删除，只靠宿主的 6 小时 temp sweep 兜底。实测 1 小时留下 5 份、约 1.4GB；`/` 只有 12GB 可用，连续运行会填满根分区。

## 2. 已实施改动

### 2.1 MSST（MySekaiStoryteller）

- **空闲停止渲染 ticker**：`api:start-export` 时启动主 ticker，导出结果回传后的 `finally` 里停止。空闲 worker 不再持续渲染已加载的 Live2D 场景，GPU 回到 0%（仅 Irodori 聊天 TTS 占用）。见 `src/renderer/src/app/App.ts`。
- **导出并发与 worker 数解耦**：新增 `render.maxConcurrentExports`（0 = 跟随 workers，env `MSS_MAX_CONCURRENT_EXPORTS`）。服务器配置 `workers: 3`、`maxConcurrentExports: 2`：2 个并发导出 + 1 个热备 worker，单个 worker 崩溃或回收时不必等新浏览器启动。
- **页面回收**：`workerRecycleExports: 5 → 3`，降低 Live2D/字体/纹理的内存累积。
- **桥接 TTS 超时与宿主对齐**：`/bridge/proxy/tts-fetch` 的 `AbortSignal.timeout` 从写死 120 秒改为 `max(120s, tts.timeoutMs)`。服务器 `tts.timeoutMs` 设为 600 秒，覆盖 Irodori 最长 300 秒排队 + 合成 + 编码。
- **帧序列即时清理**：fast 导出编码成功后删除 `/tmp/mss-hf-*` 的 JPEG 帧与空父目录；失败时保留给 6 小时 sweep 兜底（便于排查）。实测一次清理约 1.4GB 积压。
- 服务器配置见 `/vol2/1000/MySekaiStoryteller/config.yaml`（不入库）。

### 2.2 ournotes-player

- **改用系统 ffmpeg**：`video.ffmpegPath: /usr/bin/ffmpeg`（mediasrv 7.1.3，带 `h264_nvenc`）。NVENC 生效后同样的 36 秒视频，渲染段 195.2 s → 96.8 s。
- **NVENC 质量对齐**：`video.crf: 20 → 28`。NVENC 的 `-cq 20` 对同一片源产出 20.6 MB，明显高于 x264 crf20 的 4.3 MB；crf28 后为 5.9 MB / 1.31 Mbps，和 MSST 成片码率一致。
- **队列并发 1 → 2**：两个 36 秒任务并发时各 163 s 完成（单任务 109 s），吞吐从 1 个/109 s 提升到 2 个/163 s（约 1.34 倍）；显存峰值 5.3 GB，无 OOM。
- **TTS 超时 180 秒 → 600 秒**：Irodori 排队可达 300 秒，180 秒会重试一次后把该句静音跳过。
- 服务器配置见 `/vol2/1000/ournotes-player/config.yaml`（不入库）。

### 2.3 服务器与共享服务

- **Irodori LoRA 缓存 8 → 3**（`/etc/systemd/system/irodori-tts.service.d/lora-cache.conf`）。重启后空闲显存 5.4 GB → 2.2 GB，加载 3 个 adapter 后约 3.4 GB，给双并发渲染留出约 4 GB 余量。代价是第 4 个角色起需要从磁盘重新加载 adapter（prepare 约 0.2 s + 读盘），对 2-3 人剧本无影响。
- **健康看门狗**：`render-healthcheck.timer` 每 2 分钟探测 `:9881/api/v1/health` 与 `:9882/api/v1/health`；连续 3 次失败才重启对应 unit，避免单次慢响应误杀。安装在 `/usr/local/bin/render-healthcheck.sh`、`/etc/systemd/system/render-healthcheck.{service,timer}`。

## 3. 并发与容量结论

- MSST：`maxConcurrentExports=2`、`workers=3`。两个导出同时运行时 GPU 显存约 5.1 GB（含 Irodori），CPU 4 核接近饱和，但无 OOM、无 worker 争抢。
- ournotes：`queue.concurrency=2`。两个渲染同时运行时显存峰值 5.3 GB，CPU 同样接近饱和；第三个请求进入队列（`maxSize: 20`）。
- 两个宿主**同时**各跑 2 个任务时，4 核 CPU 与单 GPU 会同时饱和，单个任务耗时约为独占时的 2-3 倍。这是 8 GB 显卡 + 4 核 CPU 的硬件上限，不是配置问题。上线后按“各 2 并发、其余排队”运行即可，不建议再提高并发。
- Irodori 是跨项目共享瓶颈。实测合成吞吐约 5-7 个请求/分钟；在 2 个 MSST 导出 + 1 个 ournotes 渲染同时排队时，单句 TTS 的 `elapsed` 达到 170-284 秒（其中大部分是排队）。聊天 TTS 插件的 `auto.tts_prob` 为 1.0（每条回复都配音），是队列的主要来源。
- 结论：**两个宿主同时各跑 2 个任务时，导出会成功但非常慢（16 句的 MSST 导出实测 9.6-21.5 分钟）**。如果要把视频耗时压到 5 分钟级，需要降低聊天 TTS 的发声比例（例如 `tts_prob` 0.3-0.5）或给视频请求单独分配 TTS 容量；仅靠宿主侧并发参数无法解决。
- **不要在 Irodori 饱和时启用 MSST 的 `ttsMode: concurrent`**：该模式的 TTS lookahead 超时为 15 秒，队列等待会触发缺句/静音回退。

## 4. 稳定性保障

- 两个 unit 都是 `Restart=always`；ournotes 的 `StartLimitIntervalSec=0`。
- 看门狗覆盖“进程还活着但 HTTP 不响应”的场景。
- ournotes：客户端断连会 abort 剧本生成并取消渲染任务；排队中/运行中取消都会计数并释放 Chrome。
- MSST：客户端断连会取消导出（`res.on('close')`）；worker 崩溃/断连会重启浏览器并把任务标记失败；回收与重派发由池统一管理。
- 超时：MSST 默认导出超时 30 分钟、插件 `export_timeout` 应不低于 3600 秒；ournotes 任务超时 2 小时、插件 `export_timeout` 建议 3600 秒。

## 5. 测试计划

1. 单元/集成：MSST `npm test`、`npm run test:pool`；ournotes `npm test`、`npm run test:host`；两仓库 `npm run lint`。
2. 功能：真实导出后用 `ffprobe` 校验编码/分辨率/帧率/音轨；抽帧检查画面、字幕、水印；插件端到端各跑一次。
3. 并发：各 2 并发；两个宿主同时 2+2；队列打满返回 429。
4. 故障注入：渲染中杀 Chrome、取消排队/运行中任务、重启宿主、TTS 服务重启、看门狗误杀防护。
5. 长跑：30-60 分钟持续提交，观察 RSS/显存/句柄是否单调增长、是否残留 Chrome。

测试结果：

- 单元/集成：MSST 105 + 13 通过；ournotes 525 + 178 通过（1/3 skip）；ournotes 插件 23 + 3 通过；两仓库改动文件 lint 干净。
- ournotes 纯渲染（12 句 / 36 秒 / 1079 帧）：207.5 s → 108.6 s；2 并发时各 163 s，吞吐约 1.34 倍。
- ournotes 带 TTS（2 句 / 11.4 秒）：107.9 s 完成，2/2 句有声，音频 mean -22.7 dB / max -6.9 dB。
- MSST 24 snippet（16 句 / 79 秒）导出：成功，602 s（与另一个导出并发；`avgPumpFps 4.5`，`snapshotMs 410 s`），成片 1440x810 / 30fps / AAC 双声道 / 7.9 MB；音频 mean -22.4 dB / max -6.1 dB。
- TTS 超时：修复前 10 分钟内 5 次 `[Bridge] TTS proxy fetch failed TimeoutError`；修复后同样负载下 0 次。
- ournotes 故障注入：渲染中 `kill -9` Chrome 主进程，任务在 5 秒内失败（`the browser closed before the render page reported a result`），队列立即释放；随后新任务 54 s 成功。
- MSST 故障注入：杀掉空闲 worker w3，1.5 s 内重启并就绪；杀掉正在导出的 w1，仅该任务失败，另一个导出继续，w1 1.2 s 后就绪。
- 空闲占用：MSST 三个空闲 worker 的 Chrome GPU SM 占用为 0%；Irodori 空闲显存 5.4 GB → 2.2 GB（加载 3 个 adapter 后约 3.4 GB）。

结论：稳定性目标（崩溃隔离、取消、超时、看门狗、显存余量）达到；吞吐受 4 核 CPU 与共享 Irodori 限制，2 并发的实际意义是排队而非翻倍，79 秒视频在 2 并发 + 聊天 TTS 下约 10 分钟。

## 6. 上线检查清单

- [ ] `systemctl is-active mysekai-api ournotes-api render-healthcheck.timer`
- [ ] `/api/v1/health` 均 200，MSST `readyWorkers=3`、`maxConcurrent=2`；ournotes `concurrency=2`
- [ ] MSST 空闲时 `nvidia-smi pmon` 中 Chrome SM 为 `-`（0%），GPU 仅被 Irodori 占用
- [ ] ournotes 成片码率约 1.3 Mbps（crf28 + NVENC），无 `encoder ... failed` 日志
- [ ] 取消任务后 60 秒内 worker 释放、无孤儿 Chrome
- [ ] AstrBot 插件 `export_timeout >= 3600`，`max_concurrent_requests=2`
