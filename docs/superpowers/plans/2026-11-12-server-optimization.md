# Server Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 MSST 与 ournotes 在 8 GB 显存、4 核 CPU、共享 Irodori TTS 的服务器上按各 2 并发稳定运行，降低渲染耗时与空闲占用，并用故障注入验证崩溃/超时/清理路径。

**Architecture:** 配置层先解决编码器、并发和 TTS 超时；宿主代码只做四件事：空闲停渲染、导出并发与 worker 解耦、桥接超时跟随配置、崩溃/成功后立即释放资源。服务器层用 LoRA 缓存上限、健康看门狗和临时帧定时清扫兜底。

**Tech Stack:** Node 22 / TypeScript（MSST，tsc + Vite）、Node 22 ESM（ournotes）、Playwright/Chrome headless、FFmpeg 7.1（NVENC）、systemd、Irodori-TTS OpenAI 兼容 API。

**Status:** 全部任务已在 2026-11-12 执行完成；勾选为完成状态，末尾附证据。

---

## File Structure

MSST（`D:/Users/桌面/mzkbot/MySekaiStoryteller`）：

- `src/renderer/src/app/App.ts`：渲染器导出生命周期（ticker 启停）。
- `src/host/config.ts`：`render.maxConcurrentExports` schema 与 env。
- `src/host/main.ts`：把 `maxConcurrentExports` 传给 `VideoApiServer`。
- `src/host/bridge/bridgeRoutes.ts`：TTS 代理超时、帧目录清理。
- `config.example.yaml`：新配置项文档。
- `doc/server-optimization-2026-11-12.md`：服务器实测与决策记录。

ournotes（`D:/Users/桌面/StarMoe/ournotes-player`）：

- `scripts/lib/story-author/chrome.js`：`Browser.onClosed()`。
- `host/render/renderer.js`：页面结果与浏览器关闭 race。
- `docs/host-tuning.md`：NVENC/并发/崩溃恢复记录。

服务器（不入库）：

- `/vol2/1000/MySekaiStoryteller/config.yaml`
- `/vol2/1000/ournotes-player/config.yaml`
- `/etc/systemd/system/irodori-tts.service.d/lora-cache.conf`
- `/usr/local/bin/render-healthcheck.sh` + `render-healthcheck.{service,timer}`
- `/usr/local/bin/mss-temp-clean.sh` + `mss-temp-clean.{service,timer}`
- `/vol3/1000/bot/astrbot/data/config/astrbot_plugin_{msst,ournotes_script}_config.json`

---

### Task 1: 建立可复现的基线与压测脚本

**Files:**
- Create (server `/tmp`): `zops-bench-msst.mjs`、`zops-bench-ournotes.mjs`、`zops-soak-monitor.sh`

- [x] **Step 1: 写 MSST 压测脚本（长超时 http，避免 undici 5 分钟 headers timeout）**

```js
import http from 'node:http';
const [apiBase, storyFile, jobsArg, label] = process.argv.slice(2);
const jobs = Number(jobsArg || 1);
const story = JSON.parse(fs.readFileSync(storyFile, 'utf8'));
const TIMEOUT = Number(process.env.BENCH_TIMEOUT_MS || 3600000);
// POST /api/v1/export, body { story, timeout: TIMEOUT }
```

- [x] **Step 2: 写 ournotes 压测脚本**

```js
const body = { script: script.script || script, tts, title: `${label}-${i}`, timeout: 1800000 };
// POST /api/v1/generate, Authorization: Bearer $OURNOTES_API_KEY
```

- [x] **Step 3: 用 12 句脚本测 ournotes 纯渲染基线**

Run: `node /tmp/zops-bench-ournotes.mjs http://127.0.0.1:9882 /tmp/zops-script12.json 1 0 baseline-static`
Expected（实测）：`wallMs 207531`，`renderMs 195200`，`duration 35.967`，`bytes 4333786`，日志出现 `encoder h264_nvenc failed ... libx264`。

- [x] **Step 4: 测 MSST 24 snippet 基线**

Run: `node /tmp/zops-bench-msst.mjs http://127.0.0.1:9881 /tmp/zops-msst24.json 1 baseline`
Expected（实测）：首次单任务 1290.7 s；TTS 段约 14 分钟。

- [x] **Step 5: 启动 30 分钟 soak 采样**

Run: `nohup /tmp/zops-soak-monitor.sh &`
Expected：每 30 s 一行 `msst=a/q ournotes=r/w gpu=... mains=3 msst_rss=...`。

---

### Task 2: ournotes 改用 NVENC 并校准码率

**Files:**
- Modify: `/vol2/1000/ournotes-player/config.yaml`

- [x] **Step 1: 确认 ffmpeg-static 不含 nvenc**

Run: `/vol2/1000/ournotes-player/node_modules/ffmpeg-static/ffmpeg -encoders | grep nvenc`
Expected：无输出（只有 libx264/v4l2m2m）。

- [x] **Step 2: 确认系统 ffmpeg 带 nvenc**

Run: `/usr/bin/ffmpeg -f lavfi -i color=c=black:s=320x240:d=1 -c:v h264_nvenc -f null -`
Expected：退出码 0，无 `Unknown encoder`。

- [x] **Step 3: 写入配置**

```yaml
video:
  ffmpegPath: /usr/bin/ffmpeg
  crf: 28
```

- [x] **Step 4: 重启并验证**

Run: `sudo systemctl restart ournotes-api && curl -s http://127.0.0.1:9882/api/v1/health | python3 -m json.tool | grep ffmpeg`
Expected：`"/usr/trim/lib/mediasrv/ffmpeg"`；下一次渲染日志为 `encoded ... with h264_nvenc`。

- [x] **Step 5: 复测 36 秒视频**

Run: `node /tmp/zops-bench-ournotes.mjs ... 1 0 after-idle-nvenc`
Expected（实测）：`wallMs 108596`，`renderMs 97100`，crf28 成片 `5865088` 字节（1.31 Mbps）。

---

### Task 3: ournotes 队列 2 并发 + TTS 超时

**Files:**
- Modify: `/vol2/1000/ournotes-player/config.yaml`

- [x] **Step 1: 改配置**

```yaml
tts:
  timeoutMs: 600000   # Irodori 高峰排队可达 300 秒
queue:
  concurrency: 2
render:
  taskTimeoutMs: 1800000
```

- [x] **Step 2: 重启并核对**

Run: `sudo systemctl restart ournotes-api; curl -s http://127.0.0.1:9882/api/v1/health`
Expected：`"concurrency": 2`。

- [x] **Step 3: 2 并发纯渲染**

Run: `node /tmp/zops-bench-ournotes.mjs http://127.0.0.1:9882 /tmp/zops-script12.json 2 0 concurrent2`
Expected（实测）：两个任务各约 163 s，`renderMs` 约 143 s；显存峰值 5.3 GB，无 OOM。

---

### Task 4: MSST 空闲停止渲染 ticker

**Files:**
- Modify: `src/renderer/src/app/App.ts:377-430`

- [x] **Step 1: 在 `api:start-export` 入口启动 ticker**

```ts
this.apiExportInProgress = true;
try {
  this.pixiApplication.ticker.start();
} catch {
  /* pixi may not be ready yet; export path starts its own ticker */
}
```

- [x] **Step 2: 在结果回传后的 `finally` 停止 ticker**

```ts
} finally {
  this.apiExportInProgress = false;
  this.pendingAbortTaskId = null;
  try {
    this.pixiApplication.ticker.stop();
  } catch {
    /* renderer may already be destroyed */
  }
}
```

- [x] **Step 3: 构建与类型检查**

Run: `npm run typecheck:web && npm run build:web`
Expected：0 error；`out/webrenderer/assets/App-*.js` 更新。

- [x] **Step 4: 部署并验证空闲 GPU**

Run: `tar xzf webrenderer.tgz -C out && sudo systemctl restart mysekai-api`
Expected（实测）：导出结束后 `nvidia-smi pmon` 中 Chrome SM 为 `-`；整卡从 100%/96 W 降到 0%/16 W。

---

### Task 5: MSST 导出并发与 worker 数解耦

**Files:**
- Modify: `src/host/config.ts:90-99、397-407`
- Modify: `src/host/main.ts:134`
- Modify: `config.example.yaml:66-72`

- [x] **Step 1: schema 增加 `maxConcurrentExports`**

```ts
const RenderSchema = z.object({
  workers: z.number().default(2),
  maxConcurrentExports: z.number().default(0),
  workerRecycleExports: z.number().default(5),
  // ...
});
```

- [x] **Step 2: env 覆盖**

```ts
if (env.MSS_MAX_CONCURRENT_EXPORTS) {
  const v = parseInt(env.MSS_MAX_CONCURRENT_EXPORTS, 10);
  if (Number.isFinite(v)) config.render.maxConcurrentExports = Math.max(0, v);
}
```

- [x] **Step 3: 传给 VideoApiServer**

```ts
maxConcurrentExports: config.render.maxConcurrentExports || config.render.workers,
```

- [x] **Step 4: 构建/单测**

Run: `npm run typecheck:host && npm run build:host && npm test`
Expected：105 pass。

- [x] **Step 5: 服务器配置 3 worker / 2 并发**

```yaml
render:
  workers: 3
  maxConcurrentExports: 2
  workerRecycleExports: 3
```

- [x] **Step 6: 重启并核对**

Run: `sudo systemctl restart mysekai-api; curl -s http://127.0.0.1:9881/api/v1/status`
Expected：`"maxConcurrent": 2`，`readyWorkers: 3`。

---

### Task 6: MSST 桥接 TTS 超时对齐

**Files:**
- Modify: `src/host/bridge/bridgeRoutes.ts:37、541-542`

- [x] **Step 1: 改超时**

```ts
signal: AbortSignal.timeout(Math.max(120000, config.tts.timeoutMs))
```

- [x] **Step 2: 服务器 `tts.timeoutMs: 600000`，重启**

Run: `sudo systemctl restart mysekai-api`
Expected：高峰 TTS 不再每 2 分钟出现 `[Bridge] TTS proxy fetch failed TimeoutError`。

- [x] **Step 3: 观察同负载下的代理失败计数**

Run: `journalctl -u mysekai-api --since '20:05' | grep -c 'TTS proxy fetch failed'`
Expected（实测）：`0`（修复前 10 分钟 5 次）。

---

### Task 7: MSST 帧目录即时清理 + 定时兜底

**Files:**
- Modify: `src/host/bridge/bridgeRoutes.ts:330-402`
- Create (server): `/usr/local/bin/mss-temp-clean.sh` + timer

- [x] **Step 1: 编码成功后删帧目录**

```ts
let encoded = false;
// ...
encoded = true;
return { success: true, outputPath: payload.outputPath, fileSize: outputSize };
// finally:
if (encoded) {
  await fs.promises.rm(payload.framesDir, { recursive: true, force: true });
  const parent = path.dirname(payload.framesDir);
  if (path.basename(parent).startsWith('mss-hf-')) await fs.promises.rmdir(parent);
}
```

- [x] **Step 2: 用桥接 invoke 直接验证**

Run: `node /tmp/zops-test-frame-cleanup.mjs`（生成 6 张真实 JPEG，调用 `electron:api-encode-frames-video`）
Expected（实测）：`{"status":200,...,"framesDirExists":false,"outputExists":true}`。

- [x] **Step 3: 安装 15 分钟兜底清扫**

```bash
find /tmp -maxdepth 1 -type d -name 'mss-hf-*' -mmin +30 -exec rm -rf {} +
```

Run: `systemctl enable --now mss-temp-clean.timer`
Expected：`systemctl list-timers` 显示 15 分钟周期。

- [x] **Step 4: 部署后短导出验证**

Run: `node /tmp/zops-bench-msst.mjs ... /tmp/zops-msst10.json 1 verify-cleanup`
Expected（实测）：`wallMs 158756`，结束后 `ls -d /tmp/mss-hf-* | wc -l` 为 `0`。

---

### Task 8: ournotes 浏览器崩溃快速失败

**Files:**
- Modify: `scripts/lib/story-author/chrome.js:54-62、74、125-128`
- Modify: `host/render/renderer.js:73-82`

- [x] **Step 1: Browser 增加关闭信号**

```js
constructor() {
  this.closedSignal = new Promise((resolve) => { this._resolveClosed = resolve; });
}
onClosed() { return this.closedSignal; }
// launch: b.exited.then(() => b._resolveClosed?.());
// ws close: this._resolveClosed?.();
```

- [x] **Step 2: 渲染结果与关闭信号 race**

```js
report = await withTimeout(
  Promise.race([
    job.result,
    browser.onClosed().then(() => {
      throw new Error("the browser closed before the render page reported a result");
    }),
  ]),
  cfg.render.taskTimeoutMs, signal, "the render page");
```

- [x] **Step 3: 部署并做 kill 测试**

Run: `kill -9 <chrome-main>; curl .../api/v1/tasks/<id>`
Expected（实测）：5 秒内 `status: failed`，`error: the browser closed before the render page reported a result`；`queue.running=0`。

- [x] **Step 4: 验证恢复**

Run: `node /tmp/zops-bench-ournotes.mjs ... /tmp/zops-script2.json 1 0 recovery-after-kill`
Expected（实测）：`ok:true`，`wallMs 53987`。

---

### Task 9: 服务器显存、看门狗与插件超时

**Files:**
- Modify: `/etc/systemd/system/irodori-tts.service.d/lora-cache.conf`
- Create: `render-healthcheck.{sh,service,timer}`
- Modify: AstrBot 插件配置（不入库）

- [x] **Step 1: LoRA 缓存 8 → 3**

```ini
Environment=IRODORI_LORA_CACHE_SIZE=3
```

Run: `sudo systemctl daemon-reload && sudo systemctl restart irodori-tts`
Expected（实测）：空闲显存 5.4 GB → 2.2 GB。

- [x] **Step 2: 安装健康看门狗（连续 3 次失败才重启）**

```bash
check mysekai-api http://127.0.0.1:9881/api/v1/health msst
check ournotes-api http://127.0.0.1:9882/api/v1/health ournotes
```

Run: `systemctl enable --now render-healthcheck.timer`
Expected：`active`；`/var/lib/render-healthcheck` 无失败计数。

- [x] **Step 3: 插件超时与并发**

```json
{ "export_timeout": 7200, "max_concurrent_requests": 2 }
```

Run: `sudo docker restart astrbot; docker logs --since 2m astrbot | grep 插件就绪`
Expected：`MySekaiStoryteller 插件就绪`、`ournotes 插件就绪`。

- [x] **Step 4: 用假 URL 验证看门狗计数逻辑**

Run: 复制脚本、`STATE_DIR=/tmp/hc-test`、check 指向 `http://127.0.0.1:9/nope`
Expected（实测）：`1 → 2 → 0（触发 restart 后重置）→ 1`。

---

### Task 10: 部署、2+2 压测与故障注入

**Files:** 无新增；使用 Task 1 的脚本。

- [x] **Step 1: 部署最终 out-host + webrenderer，重启两个宿主**

Expected：MSST `readyWorkers=3`、`maxConcurrent=2`；ournotes `queue.concurrency=2`、`ffmpeg` 为系统路径。

- [x] **Step 2: 2+2 混合压测**

Run:
```bash
node /tmp/zops-bench-msst.mjs http://127.0.0.1:9881 /tmp/zops-msst10.json 2 stress-msst-2
node /tmp/zops-bench-ournotes.mjs http://127.0.0.1:9882 /tmp/zops-script2.json 2 0 stress-ournotes-2
```
Expected（实测）：4/4 成功；MSST 各 133.5 s（14 秒成片，3.7-3.8 fps），ournotes 各 71.6 s（9 秒成片）；显存峰值 6.29 GB；结束后 `/tmp/mss-hf-*` 为 0。

- [x] **Step 3: 故障注入**

- `kill -9` MSST 空闲 worker → 1.5 s 内重启并就绪。
- `kill -9` MSST 正在导出的 worker → 仅该任务失败，另一个继续；w1 1.2 s 就绪。
- `kill -9` ournotes Chrome → 5 s 内任务失败，下一单 54 s 成功。

- [x] **Step 4: 成片功能校验**

Run:
```bash
ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_name,width,height,sample_rate,channels -of json <mp4>
ffmpeg -i <mp4> -af volumedetect -f null -
```
Expected（实测）：MSST 1440x810/30fps/AAC 双声道/7.9 MB；ournotes 1300x600/30fps/AAC；mean 约 -22 dB，max 约 -6～-7 dB。

- [x] **Step 5: 30 分钟 soak**

Expected（实测）：MSST RSS 116-141 MB 稳定；无孤儿 Chrome；无临时目录增长。

---

### Task 11: 文档、提交与推送

**Files:**
- Create: `doc/server-optimization-2026-11-12.md`
- Create: `docs/superpowers/specs/2026-11-12-server-optimization-design.md`
- Create: `docs/superpowers/plans/2026-11-12-server-optimization.md`
- Create (ournotes): `docs/host-tuning.md`

- [x] **Step 1: 跑完整测试与 lint**

Run: `npm test && npm run test:pool`（MSST）、`npm test && npm run test:host && npm run lint`（ournotes）、`pytest`（插件）
Expected（实测）：MSST 105+13；ournotes 525+178（1/3 skip）；插件 23+3；lint 0。

- [x] **Step 2: 提交**

```bash
# MSST
git add src/host src/renderer/src/app/App.ts config.example.yaml doc docs
git commit -m "perf(host): 空闲停渲染、导出并发与 worker 解耦、TTS 代理超时对齐"
git commit -m "fix(bridge): fast 导出成功后删除 JPEG 帧序列"
# ournotes
git add host/render/renderer.js scripts/lib/story-author/chrome.js docs/host-tuning.md
git commit -m "fix(render): 浏览器崩溃立即失败，避免占槽一小时"
```

- [x] **Step 3: 推送并核对远端 head**

Run: `git push origin main; git ls-remote origin refs/heads/main`
Expected（实测）：MSST `684bec0`、ournotes `437a2ba`。

---

## Self-Review

- **Spec coverage：** 5.1→Task 4，5.2→Task 5，5.3→Task 6，5.4→Task 7，5.5→Tasks 2/3，5.6→Task 8，5.7→Task 9，5.8→Tasks 7/9，测试→Task 10，文档/推送→Task 11。
- **Placeholder scan：** 无 TBD/TODO；每个代码改动都有实际片段和命令。
- **Type consistency：** `maxConcurrentExports` 在 schema、env、main 接线、示例配置中同名；`Browser.onClosed()` 与 `renderer.js` 调用一致；`tts.timeoutMs` 在桥接与配置中同名。

## 已知未闭合项（不是本计划的代码缺口）

- 共享 Irodori TTS 的容量由聊天 `tts_prob=1.0` 决定；3 分钟、47-59 句的剧本在高峰仍可能超过 1 小时。插件超时已放宽到 7200 s，建议按 `doc/server-optimization-2026-11-12.md` 的风险节调整聊天发声比例或剧本长度。
