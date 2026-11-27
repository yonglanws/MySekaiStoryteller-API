# 云端资源获取与零本地资源

[返回文档总览](README.md) · [资源与音频配置](resources.md) · [API 参考](api.md)

默认开启 `assets.cloudCatalog: true` 时，MSST 采用**云端优先、按需下载**的模式：**就算 `resources/` 是个空文件夹，也不用写任何 `models.yaml` / `images.yaml` / `bgm.yaml`，服务照样能启动、写剧本并导出完整的 MP4 视频。**

> [!NOTE]
> 所有 PJSK 游戏素材版权归原权利方（SEGA / Colorful Palette / Craft Egg 等）所有。云端拉取和按需缓存仅用于本地非商业渲染与学习测试，本仓库不内置也不直接分发任何素材文件。

## 它是怎么工作的

宿主把“知道有什么素材”和“真正下载媒体文件”拆成了两步：

1. **启动只拉目录（几百 KB，不占硬盘）**：启动时读取内置的中文语义索引（`src/host/assets/*.json`）并合并 Moesekai / exmeaning / Sekai-World 的线上清单，生成一份缓存快照放到 `<assets.cacheDir>/catalog.json`（默认 6 小时自动刷新一次）。写剧本时 AI 只看名字和标签，不用提前把几万个文件下下来。
2. **默认 BGM 自动兜底**：在 `cloudOnly: true`（模板默认）下，或者 `cloudOnly: false` 且本地没有 `resources/audio/bgm/bgm.yaml` 和 `resources/audio/bgm/bg1.mp3` 时，宿主会自动用云端日常曲 **`bgm00003`（`Slapstick!!`）** 当默认 BGM。
3. **导出前按需下载缺失项**：收到 `/api/v1/export` 或 `/api/v1/generate` 请求后，宿主在渲染前扫一遍剧本里真正用到的模型、背景、BGM、音效和 UI 贴图，**只把本地还没有的下载到 `resources/*/cloud/`**。
4. **缓存复用与 `cloudOnly` 模式切换**：下过一次的素材直接留在 `resources/*/cloud/` 里，下次导出秒命中。
   - **默认模板行为（`assets.cloudOnly: true`）**：`config.example.yaml`、`.env.example`、`npm run init` 与 Docker 默认开启 `cloudOnly: true`。此时宿主**彻底忽略本地资源与 YAML 清单**（`models/models.yaml`、`images/` 与 `images.yaml`、`audio/bgm/bgm.yaml` 与非 `cloud/` 音频、`audio/se/` 非 `cloud/` 音效及 `voices/`），`/resources` 静态路由也会拦截非 `cloud/` 资产访问，确保 100% 走云端资产、零本地配置干扰。
   - **本地优先覆盖模式（`assets.cloudOnly: false`）**：在 `config.yaml` 中将 `assets.cloudOnly` 设为 `false`（或设环境变量 `MSS_ASSETS_CLOUD_ONLY=false`；未建 `config.yaml` 且未设该变量时 schema 裸默认即为 `false`）后，宿主会优先使用你放在 `resources/` 中的本地文件与 YAML 清单，其余未在本地覆盖的条目仍从云端自动补齐。

## 云端目录能覆盖多少素材

以下数量对应仓库内置语义索引 `src/host/assets/*.json` 的实测条目数：

| 素材类型           | 覆盖数量                                                      | 剧本里怎么写都可以认                                                                                       | 下载落盘位置                          |
| ------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Live2D 模型**    | **574** 套（26 位主要角色的多套服装 + 配角/特别角色）         | `cloud/<id>/<变体>/<model3.json>`、云端 id（如 `01ichika_school`）、或 `角色名 服装`（如 `星乃一歌 校服`） | `resources/models/cloud/<id>/<变体>/` |
| **背景图**         | **1,402** 张（带 12 个分类、白天/黄昏/夜晚/深夜、室内外标签） | 云端 id（`bg_a000301`）、中文地点名或带时段名字（如 `神山高校 天台·黄昏`、`教室（夜晚）`）                 | `resources/images/cloud/<id>.<ext>`   |
| **BGM 曲目**       | **421** 首（400 首剧情 BGM + 21 首区域 `area_bgm`）           | 曲名（如 `Slapstick!!`）、云端 id（`bgm00003` / `normal_area`）或 `cloud/<id>.mp3`                         | `resources/audio/bgm/cloud/<id>.mp3`  |
| **场景音效（SE）** | **1,991** 条（脚步、门、手机、天气、转场等 19 类）            | 文件名/cue id（如 `se00053_b.mp3`）或语义标签                                                              | `resources/audio/se/cloud/<file>`     |
| **官方 UI / 特效** | **17** 项对话框、转场遮罩、全息纹理与菜单 SE                  | 片段触发时自动下载（下不到也会自动用矢量回退绘制）                                                         | `resources/inapp/jp-7.0.0/`           |

小细节：

- **同名背景多个时段**：比如“神山高校 天台”有白天、黄昏、夜晚好几张。写 `神山高校 天台·黄昏` 会精准拿到黄昏版，不写时段默认优先拿白天/通用版。
- **同角色多服装不会互相屏蔽**：在 `cloudOnly: false` 下，就算你在本地 `models.yaml` 里配了瑞希的一套本地模型，云端目录里瑞希的其他换装和别的 25 位角色照样都能用。
- **离线容错与冷启动等待**：启动时先秒读旧快照，后台更新；首次冷启动无快照时，`/api/v1/resources`、AI 编剧与导出最多等待 **180 秒** 完成首轮索引拉取；连不上外网时沿用旧快照或回退本地模式。

---

## 配置项

`config.yaml` 的 `assets` 节（全都有默认值，一般不用改）：

```yaml
assets:
  source: moesekai
  region: jp # jp | cn | tw | kr | en（env: MSS_ASSETS_REGION）
  indexBase: https://assets.pjsk.moe/sekai-extra-assets/sekai-live2d/
  libraryBase: https://assets.pjsk.moe/sekai-extra-assets/sekai-story/ripper/
  assetBase: '' # 留空按 region 自动推导 storage.exmeaning.com
  soundtrackBase: https://cdn.jsdelivr.net/gh/Sekai-World/sekai-master-db-diff@master/
  cacheDir: cache/moesekai # 动作包中间缓存和 catalog.json（随时可删）
  concurrency: 4 # 下载并发数，网络慢可降到 1~2
  timeoutMs: 180000
  retries: 3
  cloudCatalog: true # 设为 false 则完全关闭云端，只认本地 YAML
  cloudOnly: true # 默认模板启用（schema 裸默认 false）；true = 严格纯云端，false = 允许本地 resources/ 优先覆盖
  cloudCatalogTtlHours: 6
```

---

## 可选：离线预拉取 CLI

平常不用跑，导出时自己会按需下。如果你要部署在没外网的内网机器，或者想提前把常用角色/背景下载到本地登记进 YAML（需配合 `assets.cloudOnly: false`），可以用这两个命令：

```bash
# 1. 拉模型（支持中文名、简称、罗马字、数字 id；all = 26 位主角色各一套默认服装）
npm run fetch:models -- --characters mizuki,ena
npm run fetch:models -- --characters all
npm run fetch:models -- --models 20mizuki_normal_3.0_t04
npm run fetch:models -- --list --characters mizuki        # 只列出不下载

# 2. 拉背景和 BGM
npm run fetch:media -- --kind backgrounds --limit 20
npm run fetch:media -- --kind bgm --names bgm00003,bgm00006 --include-area
npm run fetch:media -- --kind backgrounds --list --limit 20
```

常用参数：`--region <code>`、`--out <资源目录>`、`--concurrency <n>`、`--force`（强制重下）、`--dry-run`（只看会下什么）、`--list`（只看远端目录）。

### 动作转换与缓存

Moesekai 剧情库里的动作是 Unity 导出的 `sse-motion.json`（三次多项式曲线）。宿主拉取或按需物化模型时，会自动把它无损转换成 Live2D 的 `motion3.json` 写进模型包的 `motions/` 目录，并补全 `model3.json` 索引。中间动作包会缓存在 `cache/moesekai/`，同角色换装复用动作包时不会重复下载。

---

## 相关 HTTP 接口

```bash
# 查看合并后的完整资源目录
curl -sS 'http://127.0.0.1:9881/api/v1/resources'

# 强制刷新云端目录快照
curl -sS -X POST 'http://127.0.0.1:9881/api/v1/cloud/refresh'

# 浏览远端模型 / 背景 / BGM 索引（不下载）
curl -sS 'http://127.0.0.1:9881/api/v1/assets/moesekai/models?region=jp&characters=mizuki'
curl -sS 'http://127.0.0.1:9881/api/v1/assets/moesekai/media?kind=bgm&includeArea=true&limit=20'

# 通过 API 手动触发一次预拉取（同一时间只允许跑一个）
curl -sS -X POST 'http://127.0.0.1:9881/api/v1/assets/fetch' \
  -H 'Content-Type: application/json' \
  -d '{"characters":["mizuki","ena"],"region":"jp"}'
```

## 维护者：更新离线中文语义索引

如果上游新增了官方背景、BGM 或角色，可用 `scripts/assets/` 下的离线脚本重新生成 `src/host/assets/*.json`：

- `scripts/assets/build-background-names.mjs`
- `scripts/assets/build-bgm-semantics.mjs`
- `scripts/assets/build-model-se-semantics.mjs`
