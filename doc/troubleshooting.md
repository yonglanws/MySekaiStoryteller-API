# 故障排除

[返回 README](../README.md) · [部署指南](host-deployment.md) · [导出模式](export-modes.md)

本文导航：[快速定位](#按现象快速定位) · [浏览器](#浏览器无法启动) · [WebGL](#webgl-落到软件渲染) · [端口占用](#端口占用与残留进程) · [配置](#配置修改没有生效) · [TTS](#tts-配音缺失) · [BGM](#bgm-没有声音或音量不对) · [演出](#动作表情或台词表现不对)

先查看宿主日志，再检查健康接口：

```bash
curl http://127.0.0.1:9881/api/v1/health
```

## 浏览器无法启动

报错 `Failed to launch any browser` 时，检查是否安装系统 Chrome / Edge，或执行：

```bash
npx playwright install chromium
```

宿主默认按 `msedge` → `chrome` → `chromium` 探测。需要指定浏览器时，检查
`render.browserChannels` 或 `render.browserExecutablePath`。

## WebGL 落到软件渲染

若 `renderPool.webglRenderers` 出现 `SwiftShader` / `llvmpipe`，说明 WebGL 未使用真实 GPU，导出可能明显变慢。

- 确认 GPU 驱动和浏览器可用。
- Linux NVIDIA 无桌面、无 X 环境不要使用 `--use-angle=gl`；设置 `linuxGpuAngle: false`，再通过 `extraChromeArgs` 指定 `--use-angle=vulkan`。
- 一次只调整一个参数并重新检查 health，具体平台说明见 [WebGL 硬件加速](host-deployment.md#webgl-硬件加速)。

`host.ffmpegEncoder` 只是配置值，不是实际使用的编码器；编码侧还需要单独检查日志。

## 导出失败、卡住或超时

- 查看宿主日志中的 ffmpeg、渲染页面和资源加载错误，不要仅凭请求超时判断编码器故障。
- 显存或内存不足时下调 `render.workers`。
- `video.encoder` 应为 `auto` / `nvidia` / `amd` / `intel` / `libx264`，不要填 `nvenc`。
  record 会试编码确认硬件可用，失败回退 CPU；fast 导出失败会回退 record，日志会提示。
- 导出请求的 `timeout` **包含排队时间**；客户端或反向代理提前断连也会取消任务，见 [API 参考](api.md#超时限流与失败)。
- 取消后 worker 不立即就绪时，先检查中止与恢复日志。正在执行的页面有取消宽限期，见 [取消与故障恢复](host-deployment.md#取消与故障恢复)。

## fast 比 record 更慢

fast 每帧都需要读取 WebGL 画布，这可能比实时录制开销更大。检查分辨率、帧率和 `video.renderScale`；
如果正在使用 `1.5` 的超采样，可先降到 `1.0` 比较。不要为了追求模式名称而忽略实际耗时，详见 [导出模式](export-modes.md)。

## 画面模糊或文件过大

- record 用 `video.crf` 平衡画质与体积，值越小越清晰、文件越大。
- 检查 `renderScale` 是否低于 `1`：低分辨率渲染后放大造成的模糊不能靠提高码率恢复。
- 旧的 `recordTargetSizeMb`、`recordBitrate` 等设置不再生效，见 [旧配置迁移](export-modes.md#旧配置迁移)。

## 资源没有出现在清单中

核对资源根、文件名和清单中的路径是否一致，以及宿主日志是否提示缺失条目。
模型与背景登记方式见 [资源与音频配置](resources.md)。
BGM 设置修改后需要重启宿主；格式错误会导致启动失败，不会静默跳过。

## 按现象快速定位

| 现象                             | 先看什么                           | 不要直接做什么               |
| -------------------------------- | ---------------------------------- | ---------------------------- |
| 连接被拒绝                       | 进程是否启动、监听端口和地址       | 不要先改视频参数             |
| health 可访问但没有 ready worker | 浏览器启动日志、构建产物、桥接连接 | 不要认为 HTTP 200 代表可渲染 |
| worker ready，但任务一直排队     | 队列、busy worker、可用内存护栏    | 不要只增大 timeout           |
| 请求突然取消                     | 客户端 / 代理超时、连接中断        | 不要只看宿主任务超时值       |
| 角色或背景缺失                   | 剧本路径、清单、实际文件、资源请求 | 不要随意更换编码器           |
| 有画面无配音                     | TTS 开关、角色匹配、服务端参考音频 | 不要用 `voice` 字段代替 TTS  |
| 有配音但嘴不动                   | 本句音频包络是否解码成功           | 不要重新添加文字模拟口型     |
| 配置改了没变化                   | 实际配置文件、环境变量、是否重启   | 不要重复覆盖正式配置         |

## 端口占用与残留进程

出现 `EADDRINUSE` 时，先确认哪个进程占用了监听端口。

Windows：

```powershell
Get-NetTCPConnection -LocalPort 9881 -State Listen |
  Select-Object LocalAddress, LocalPort, OwningProcess
```

Linux：

```bash
ss -ltnp 'sport = :9881'
```

端口上的进程可能是仍在工作的旧宿主，也可能是无关服务。确认命令行、路径和 PID 后，再用它原本的管理方式停止，例如对应的 systemd 服务或前台 Ctrl+C。
不要批量结束所有 `node`、Chrome 或 Edge；其他程序和导出可能也在使用它们。

如果旧宿主已经退出但有旧浏览器反复重连，先确认浏览器进程属于哪次启动，再清理该次测试或服务的进程树。不要把这些旧连接误当成新 worker 已就绪。

## 配置修改没有生效

按以下顺序检查：

1. 修改的是正式 `config.yaml`，不是仅供复制的 `config.example.yaml`。
2. 启动的编译产物属于当前仓库，而不是另一份安装目录。
3. 服务管理器是否注入了同名 `MSS_*` 变量；环境变量优先于主配置。
4. BGM 是否由资源根下的 `audio/bgm/bgm.yaml` 整体替换了主配置中的 `bgm`。
5. 是否已重启宿主。配置不是每次导出重新加载的；模型 / 背景目录的缓存刷新不能替代配置重载。

只查看相关环境变量，注意其中可能含本地路径或自定义水印内容；反馈问题时不要贴完整环境变量列表、密钥或私有配置。
YAML 的布尔值使用 `true` / `false`，数值字段不要误加引号。独立 BGM 文件必须是键值映射，不能写成列表。

## TTS 配音缺失

- `tts.enabled` 是否开启，`tts.apiBaseUrl` 是否指向当前可访问的 GPT-SoVITS 服务。
- `tts.characters[].characterName` 是否与本句 `speaker` 对应；不同全名、简称或空格可能影响匹配。
- 参考音频与权重路径是否存在于 **TTS 服务端**，而不是只存在于渲染宿主。
- `promptText` 是否与参考音频对应，语言设置是否适合朗读文本。
- 查看单句合成错误，不要只检查全局 TTS 健康状态；一段故事可能同时包含成功和失败的句子。

`content` 决定画面文字，`ttsText` 可指定朗读文本。`voice` 虽保留在故事格式中，但当前 API 导出不会据此混入预录语音。
无有效本句音频时不模拟说话口型；音频存在但包络解码失败时也可能没有口型，不能仅凭嘴是否运动判断音轨是否存在。

## BGM 没有声音或音量不对

1. 检查独立 `bgm.yaml` 的 `enabled`、`path`、`volume`，确认修改后已重启。
2. 相对路径从资源根解析，例如 `audio/bgm/bg1.mp3`；不要填渲染宿主的 `C:\\...` 或任意本地磁盘绝对路径。
3. URL 必须能被实际渲染浏览器访问，不能只在调用 API 的电脑上可访问。
4. 查看音频加载和混音日志，再检查视频是否存在音轨。
5. `volume: 0` 会静音；单独关闭 TTS 不会关闭 BGM。

独立文件一旦存在就整体替换主配置的 BGM 设置；遗漏字段使用默认值，而不是继续从主配置继承。详见 [资源与音频配置](resources.md)。

## 动作、表情或台词表现不对

- 动作 / 表情名必须由对应模型提供，不能把另一个角色的名称直接复用。
- `actions[].at` 是当前台词正文时长的比例，不是秒数。TTS 时长变化时，动作的绝对触发时间也会变化。
- `delay` 是片段开始前的秒数，黑场 `duration` 是毫秒；混用单位会产生很长或几乎看不见的过渡。
- `offset` 以 1920 宽度为基准，`-100` 只是短距离偏移，不保证角色从画外开始。
- `wait: false` 不是导出时的通用并发开关。要在台词中演出动作，应使用 `Talk.data.actions`。
- 模型动作结束后保持姿势是默认行为，不一定是动画卡住；续演由 `idleChainGapSec` 控制。

文字溢出时先检查原始 `content` 的换行和长度。不要假定渲染 API 会自动采用 AstrBot 插件侧的排版、拆句或舞台约束。
字段说明和示例见 [故事文件格式](story-format.md)。

## 报告问题时提供什么

建议提供以下最小信息，便于复现而不暴露私有内容：

- 操作系统、Node 版本、代码版本，以及浏览器版本。
- 导出模式、分辨率、帧率、`renderScale`、worker 数和编码器配置。
- health 中的 renderer 与 worker 状态，导出响应中的 `timings`。
- 出错前后的相关日志、错误响应和复现步骤。
- 不含私密信息的最小剧本；说明是全部句子、某个角色还是单句失败。
- 如果是视觉问题，提供成片时间点或对应连续帧，不只描述“变快 / 变慢”。

公开反馈前隐藏内网地址、用户名、本地路径、令牌和参考音频文本等敏感信息。完整资源文件、生产配置和大型测试产物不应直接加入仓库。
