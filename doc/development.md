# 开发与验证

[返回 README](../README.md) · [部署指南](host-deployment.md) · [故事文件格式](story-format.md)

本文导航：[项目结构](#项目结构) · [回归测试](#自动化回归测试) · [E2E](#端到端与并发验证) · [测试边界](#e2e-参数与边界) · [成片检查](#成片检查清单) · [改动落点](#改动落点)

## 项目结构

```text
config.example.yaml   配置样例（复制为 config.yaml，正式配置不入库）
CHANGELOG.md          版本变更记录
src/host/             Node 宿主：API / 静态托管 / 桥接层 / 渲染池 / ffmpeg 编码
src/webrender/        无头浏览器加载的渲染工作页面
src/renderer/         渲染引擎：PixiJS / Live2D / 导出管线
src/common/           宿主与渲染侧共享的故事类型定义
src/shared/           宿主与渲染侧共享的 ffmpeg 模块
resources/            模型、背景、语音、BGM 与剧本；渲染资源不入库
out/webrenderer/      网页渲染端构建产物
out-host/             宿主编译产物
doc/                  使用与开发文档
docs/                 旧版部署文档的兼容入口
documents/assets/     README 使用的图片
deploy/               systemd 单元
scripts/              测试与工具脚本
```

## 构建与类型检查

在仓库根目录运行：

```bash
npm ci
npm run typecheck
npm run build
```

`build` 已包含类型检查、`build:web` 和 `build:host`；只检查类型时可单独运行 `typecheck`。
启动宿主使用 `npm start`，工作目录同样必须为仓库根目录。

## 自动化回归测试

```bash
npm run test:all
```

无需先启动宿主，也不需要浏览器或模型资源。测试覆盖 API 超时、渲染池取消与恢复、BGM 配置、record 管线，以及口型和对话计时。部分 record 测试直接使用依赖中的 `ffmpeg-static` 生成媒体，该可执行文件必须可用；仅设置 `MSS_FFMPEG_PATH` 不能替代这些用例的直接依赖。

需要缩小验证范围时：

| 命令                    | 验证内容                           |
| ----------------------- | ---------------------------------- |
| `npm test`              | API 导出超时与参数校验             |
| `npm run test:pool`     | 取消、超时、并发隔离和 worker 恢复 |
| `npm run test:config`   | BGM 配置                           |
| `npm run test:record`   | record 录制与编码管线              |
| `npm run test:renderer` | 渲染侧台词计时与口型               |

测试数量会随回归用例变化，以当前运行结果为准。纯逻辑测试不能代替实际视频验收。

## 端到端与并发验证

先构建并启动本机宿主，准备渲染资源和自己的故事文件，再运行（以下为 Bash / Git Bash 写法）：

```bash
MSS_E2E_STORY=./resources/stories/your-story.sekai-story.json npm run e2e
MSS_E2E_STORY=./resources/stories/your-story.sekai-story.json node scripts/test-parallel.mjs 2
```

- 两个脚本都支持 `MSS_E2E_STORY`。不设置时尝试读取 `resources/stories/multi-character-demo.sekai-story.json`，但仓库不附带这个剧本。
- 脚本会按本地资源适配剧本中缺失的模型变体和背景，当前资源扫描固定使用仓库下的 `resources/models` 与 `resources/images`，不跟随自定义资源根。
- `e2e` 会检查导出文件，优先用 ffprobe 分析媒体，不可用时回退 ffmpeg；不要求单独安装 ffprobe。
- `e2e` 会读取宿主返回的本地 `videoPath`，因此适用于同机测试；远程宿主不共享文件系统时不能直接使用这一文件断言。
- 并发脚本中的 `2` 是本次测试的并发任务数，不会修改宿主的 `render.workers` 配置。

实际成片还应检查文字完整性、进退场、配音与口型、音画同步及文件可解码性。无 TTS 与有 TTS 的台词规则见 [台词时长与口型](story-format.md#台词时长与口型)。

## 推荐验证顺序

一次改动不要直接从长片开始。建议依次运行：

1. `npm run typecheck`：确认共享类型与宿主 / 渲染侧均可编译。
2. 与改动相关的单项测试：先缩小失败范围。
3. `npm run test:all`：检查其他管线是否受到影响。
4. `npm run build`：验证实际网页打包和宿主输出。
5. 短剧本 E2E：验证当前机器的浏览器、GPU、资源、TTS 和 ffmpeg。
6. 需要时再做多角色、长片和并发验证。

`test:all` 不等于运行浏览器全链路，E2E 成功也不等于所有画面细节正确。尤其是进退场连续性、台词排版和口型节奏，应检查实际成片。

## E2E 参数与边界

| 参数 / 条件       | 说明                                                          |
| ----------------- | ------------------------------------------------------------- |
| `MSS_API_URL`     | 宿主地址，默认 `http://127.0.0.1:9881`                        |
| `MSS_E2E_STORY`   | 自备故事文件路径，两个测试脚本都支持                          |
| `MSS_FFMPEG_PATH` | E2E 媒体探测时优先使用的 ffmpeg 路径                          |
| 导出超时          | 两个脚本当前都以 420000ms 提交请求，包含排队                  |
| 本地资源目录      | 适配逻辑固定扫描仓库下 `resources/models`、`resources/images` |
| 文件系统          | E2E 读取响应中的本地 `videoPath`，宿主与脚本应能访问同一文件  |

指定其他本机端口的例子：

```bash
MSS_API_URL=http://127.0.0.1:19882 \
MSS_E2E_STORY=./resources/stories/your-story.sekai-story.json \
npm run e2e
```

Windows PowerShell：

```powershell
$env:MSS_API_URL = 'http://127.0.0.1:19882'
$env:MSS_E2E_STORY = './resources/stories/your-story.sekai-story.json'
npm run e2e
```

当前 E2E 断言的是最低 1280×720、有视频流、时长大于零和文件大于 10KB；它不是目标分辨率的严格相等检查。
脚本还要求存在音轨，即使日志提示无 TTS / BGM 时可以没有音轨，缺音轨仍会计为失败。因此验证完全无音轨的导出时，应单独检查视频，不要把该脚本的音轨失败直接归因于渲染故障。

并发脚本主要检查多个请求是否都成功；输出中的串行估计是固定参考值，不能据此证明实际速度提升。要衡量吞吐，请对同一故事先测单任务，再测多任务，并记录硬件、模式、分辨率、帧率和 TTS 条件。

## 成片检查清单

### 视频与画面

- 视频可以从头到尾解码，没有损坏帧或提前截断。
- 输出尺寸、方向、帧率与本次配置一致。
- 文字没有越界、漏字或被过早切走。
- 登场、退场、黑场和背景切换有预期过渡。
- 台词内动作按比例触发，没有切句后残留的动作或口型监听器。

### 音频与时间

- 有 TTS 时，开口、说话、静音与闭嘴对齐；无 TTS 时不模拟说话口型。
- 显式 `delay` 只在片段前执行一次，句尾停留不重复累计。
- BGM 音量合适；关闭 TTS 不应被误认为关闭了全部音频。
- 最后一句语音完整，视频末尾没有明显截断或多余长静音。
- `duration` 响应字段表示导出耗时，不用于判断成片长度；媒体时长应从 MP4 本身读取。

### 可复现记录

记录故事、资源版本、模式、画面参数、硬件 renderer、编码器和导出统计。比较前后版本时固定这些条件，避免将模型差异、TTS 缓存命中或并发负载当作代码效果。

## 常用媒体检查命令

下面的命令假设 ffmpeg / ffprobe 已在 PATH 中；否则替换为实际可执行文件路径。输入视频路径替换为自己的文件。

```bash
# 检查容器、视频流与音轨元数据
ffprobe -v error -show_format -show_streams -of json output.mp4

# 完整解码但不生成视频文件
ffmpeg -v error -i output.mp4 -f null -

# 查看音量，适用于存在音轨的视频
ffmpeg -i output.mp4 -vn -af volumedetect -f null -
```

抽帧检查可以帮助发现文字和画面问题，但少量截图不能证明每帧过渡流畅；动态问题仍需要观看成片或检查连续帧与时间戳。
测试视频、日志和临时脚本放系统临时目录，不要混入提交。

## 改动落点

| 要修改的行为                  | 优先检查                                                           |
| ----------------------------- | ------------------------------------------------------------------ |
| HTTP 请求参数、任务状态、下载 | `src/host/servers/VideoApiServer.ts`                               |
| worker 调度、取消、恢复       | `src/host/pool/renderPool.ts`                                      |
| 主配置与环境变量              | `src/host/config.ts`                                               |
| 资源目录与清单解析            | `src/host/resources/resourceCatalog.ts`                            |
| 故事字段与校验                | `src/common/types/Story.ts`                                        |
| 单片段演出行为                | `src/renderer/src/snippets/`                                       |
| 台词时长                      | `src/renderer/src/utils/TalkTiming.ts` 与时间轴调用处              |
| 视频导出与混音                | `src/renderer/src/managers/VideoExportManager.ts`、`video-export/` |
| record 宿主编码与合流         | `src/host/record/`                                                 |

修改共享故事字段时，同时检查 API 验证、资源解析、片段实现和文档示例。只改 schema 而不改渲染逻辑，可能得到“请求通过但画面不符合预期”的结果。
