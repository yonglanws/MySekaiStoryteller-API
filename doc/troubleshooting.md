# 故障排除

[返回 README](../README.md) · [部署指南](host-deployment.md) · [导出模式与提速调参](export-modes.md)

排障先做两件事：看宿主终端日志，再访问一次健康检查：

```bash
curl http://127.0.0.1:9881/api/v1/health
```

## 常见现象速查

| 现象                            | 先看哪里                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 连不上 9881 端口                | 进程有没有跑起来、监听的 `host` 是不是 `127.0.0.1` 导致局域网连不上                                             |
| `/health` 返回 200 但导出报 503 | 看 `renderPool.readyWorkers` 是不是 `0`、浏览器有没有拉起来、是不是忘了先 `npm run build`                       |
| 一直排队不动                    | 看 `GET /api/v1/status` 里的 `activeTaskIds`，或者是不是设了 `minFreeMemoryMb` 导致可用内存不够暂缓派发         |
| 任务中途突然被取消              | 检查是不是客户端/反代 HTTP 超时断开了连接（`wait: true` 断连会自动取消），建议改用 `wait: false` 轮询           |
| 导出慢如蜗牛                    | 看 `/health` 里 `webglRenderers` 是不是 `SwiftShader`/`llvmpipe`，以及 `renderScale` 有没有设成 `1.5`           |
| 有画面没配音                    | 看 `tts.enabled`、`tts.apiBaseUrl` 能不能连通、参考音频路径是不是在 **TTS 服务端**磁盘上                        |
| 有配音但嘴不动                  | 看这句 `Talk` 的 `modelId` 是不是 `-1`，或者该句音频下载/WAV 解码失败了                                         |
| 改了配置没反应                  | 看改的是不是 `config.yaml`（别改错成 `config.example.yaml`）、有没有被 `MSS_*` 环境变量覆盖、改完有没有重启宿主 |

---

## 1. 浏览器启动失败（`Failed to launch any browser`）

检查机器上装没装 Chrome / Edge；如果没有，跑一次：

```bash
npx playwright install chromium
```

想强制指定某个浏览器路径，在 `config.yaml` 里填 `render.browserExecutablePath` 或调整 `render.browserChannels`。

## 2. WebGL 走成了软件渲染（`SwiftShader` / `llvmpipe`）

这会直接把 GPU 活全扔给 CPU，导出耗时成倍暴涨。

- Linux 有 NVIDIA 卡但**没有桌面 / Xorg**：把 `render.linuxGpuAngle` 设为 `false`，`render.extraChromeArgs` 设为 `"--use-angle=vulkan"`。
- Linux 有 X11 桌面：保持 `linuxGpuAngle: true`。
- 装完整版 Chrome / Edge，尽量别用阉割的 headless-shell。

另外，`health` 里的 `host.ffmpegEncoder` 是你填的配置值，**`host.ffmpegEncoderDetected`** 才是实际探测出来能用的硬件编码器。

## 3. 导出速度慢 / 内存或显存炸了

- **降倍率**：`config.example.yaml` 默认 `renderScale: 1`，如果你用内置默认值跑会是 `1.5`（像素数 ×2.25），显式设回 `video.renderScale: 1` 立竿见影。
- **降编码帧率**：保持 `video.fastFps: 30`（就算 `fps: 60` 也只编 30 帧，流畅度够用且省一半编码时间）。
- **少开 worker**：每个 worker 吃 300~500 MB 内存和一份 WebGL 显存，小机器把 `render.workers` 设为 `1` 或 `2`。
- **TTS 抢卡**：如果显卡显存很小且本地同时跑 IrodoriTTS，把 `video.ttsMode` 改成 `serial`（先全合成完语音再画图，不跟 WebGL 抢显存）。

## 4. 画质糊或文件太大

- 走 **WebCodecs** 路径时调 `video.exportBitrate`（单位 bps，默认 `12000000`；想文件小改 `8000000`）。
- 走 **`rawvideo` / `image2pipe`（ffmpeg）** 路径时调 `video.crf`（越小越清晰、文件越大；常用 `23` ~ `28`）。
- `renderScale` 设小于 `1` 导致的画面发虚，拉高码率是救不回来的，先改回 `1`。

## 5. 云端素材下载失败或默认 BGM 没声音

- 先看 `/api/v1/resources` 里有没有 `cloud` 字段；没有就检查启动日志里的 `[Cloud]` 报错，网络恢复后调一次 `POST /api/v1/cloud/refresh`。
- 下载老超时的话，把 `assets.concurrency` 调小到 `1` 或 `2`，或把 `assets.timeoutMs` 调大。
- 如果手动建了 `resources/audio/bgm/bgm.yaml`，它会**整体替换**主配置与默认 `bgm00003` 兜底；记得检查里面的 `enabled: true`、`volume > 0` 和路径是否正确，改完重启宿主。

## 6. 端口被占用（`EADDRINUSE`）

查一下谁占了 `9881` 端口，别上来就 `killall node` 或乱杀 Chrome（可能误杀正常任务）：

- Windows PowerShell：`Get-NetTCPConnection -LocalPort 9881 -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess`
- Linux：`ss -ltnp 'sport = :9881'`

## 7. TTS 配音缺句或日文预检报错

- **路径基准别搞反**：`tts.characters[].refAudioPath` 和 `loraAdapter` 填的是 **TTS 服务那台机器上的路径**。
- **Irodori 报 400 缺日文 `ttsText`**：Irodori 引擎只能读日语。请确保 `llm.enabled: true` 让宿主自动翻译，或者自己提交的剧本每句 `Talk` 都带上了日文 `ttsText`。
- **单句静音**：查日志里是不是单句 TTS HTTP 超时了（Irodori 高峰排队久的话，把 `tts.timeoutMs` 适当调大到比如 `300000`）。

## 8. 动作、表情或台词显示不对

- **动作/表情名不能跨角色混用**：去 `/api/v1/resources` 看这个角色真实的 `motions` 和 `facials` 列表。
- **`actions[].at` 是 `0..1` 的比例**：不是秒数，受本句 TTS 时长影响。
- **单位别写错**：`delay` 和 `Motion.duration` 是**秒**，黑场/淡入淡出/运镜的 `duration` 是**毫秒**。
- **动作播完定格是正常设计**：角色动作和 `face_*` 表情播完后默认定格在末帧等下一条动作自然衔接（不是卡死了）；如果想让角色闲着时自己每隔几秒换个小动作，把 `video.idleChainGapSec` 设成正数（比如 `3`）。
