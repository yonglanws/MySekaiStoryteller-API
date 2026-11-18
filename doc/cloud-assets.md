# 云端资源获取与零本地资源架构

[返回文档索引](README.md) · [资源与音频配置](resources.md) · [API 参考](api.md)

MySekaiStoryteller-API 默认采用**云端优先、零本地资源（Zero-Local-Asset）**架构：启用 `assets.cloudCatalog: true`（默认开启）后，即使 `resources/` 为空目录且未编写任何 `models.yaml` / `images.yaml` / `bgm.yaml`，宿主也能直接启动、运行内置 AI 剧本生成并导出完整 MP4 视频。

> [!NOTE]
> 资源版权归 Bushiroad / Craft Egg / SEGA 等原权利方所有。云端拉取与按需物化功能仅用于本地、非商业的渲染与测试；本仓库不附带也不再分发这些资源。部署与分享成片前请自行确认授权范围。

## 零本地资源与按需物化

云端目录把“清单发现”与“文件下载”分离：

1. **目录阶段（轻量化、不落盘媒体）**：宿主启动时从公开资源站索引与内置离线简体中文语义库合并生成目录（缓存在 `<assets.cacheDir>/catalog.json`，`schemaVersion: 2`，默认 TTL 6 小时），AI 提示词与校验器只需要读取其中的名称、服装分类、时段/室内外标签与情绪描述。
2. **默认 BGM 自动兜底**：当 `resources/audio/bgm/bgm.yaml` 和 `resources/audio/bgm/bg1.mp3` 均不存在于磁盘且开启 `cloudCatalog` 时，`loadHostConfig()` 与 `resolveGlobalBgm()` 自动回落到已验证的云端日常曲 **`bgm00003`**（`Slapstick!!`），避免去远端请求不存在的 `bg1`。
3. **导出前按需物化**：无论是 `/api/v1/export` 还是 `/api/v1/generate`，进入渲染池前都会调用 `resolveStoryCloudAssets()` 扫描剧本用到的 `models`、`images`、`ChangeBgm`、`PlaySe` / `StopSe`、`CostumeChange` 及转场/UI 特效资源，**仅下载缺失的条目**到 `resources/*/cloud/`（以及 `resources/inapp/jp-7.0.0/`），并改写故事内的相对路径，渲染端继续统一通过 `/resources/*` 路由加载。
4. **缓存复用与本地优先**：物化后的文件直接保存在 `resources/` 下，二次导出命中本地缓存不再重复下载；**若本地磁盘已存在同名文件或手动配置了 YAML 清单，本地文件始终优先**，且本地清单不会压制云端目录中的其他角色、服装变体、背景或曲目。

### 全量官方语义覆盖

宿主内置由 `scripts/assets/build-*.mjs` 离线构建的简体中文语义索引（位于 `src/host/assets/*.json`），与远端 Moesekai / exmeaning / Sekai-World 实时清单合并后提供全量覆盖：

| 资源类型       | 离线语义索引                                        | 覆盖规模                                                                                                                       | 支持的剧本引用形式                                                                                     | 物化落盘位置                                        |
| -------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Live2D 模型    | `model-metadata.json` (`msst.model-metadata/1`)     | **511** 套模型（26 位主要角色多服装变体 + **48** 位配角/特别角色）                                                             | `cloud/<模型id>/<变体>/<model3.json>`、模型 id、`角色名 服装`（如 `星乃一歌 校服`）                    | `resources/models/cloud/<id>/<变体>/`               |
| 背景图片       | `background-names.json` (`msst.background-names/1`) | **1,401** 张背景（源自 5,466 集国服官译语料），含 12 个分类、`timeOfDay`、`indoor`、`aliases`、`tags`                          | 云端 id（`bg_a000301`）、文件名、可读地点名、别名及带时段变体（如 `神山高校 天台·黄昏`）               | `resources/images/cloud/<id>.<ext>`                 |
| BGM 曲目       | `bgm-semantics.json` (`msst.bgm-semantics/1`)       | **421** 首曲目（**400** 首 `sound/scenario/bgm/` + **21** 首 `sound/area_bgm/`），含曲风/情绪/节奏/组合标签及 Sekai-World 曲名 | 曲名（如 `Slapstick!!`）、云端 id（`bgm00003` / `normal_area`）、`cloud/<id>.mp3`                      | `resources/audio/bgm/cloud/<id>.mp3`                |
| 场景音效（SE） | `se-semantics.json` (`msst.se-semantics/1`)         | **1,942** 条 SE（19 个场景分类）+ 精选常用 cue                                                                                 | `se00053_b.mp3`、`se_walk_women_001_1.mp3` 或 cue id / 描述标签                                        | `resources/audio/se/cloud/<file>`                   |
| 官方 UI / 特效 | `INAPP_UI_ASSET_PATHS`                              | **17** 项常用对话框、转场遮罩、全息纹理与菜单 SE                                                                               | `Talk` / `PlaceInfo` / `SideFade` / `SekaiIn` / `SekaiOut` / `SimpleSelectable` / 全息 shader 自动触发 | `resources/inapp/jp-7.0.0/`（离线自动回退矢量绘制） |

<details>
<summary>查看离线语义分类统计详情</summary>

- **Live2D 服装大类（511 套）**：`活动` (188)、`队服` (102)、`运动服` (40)、`校服` (39)、`特殊` (33)、`常服` (32)、`私服` (24)、`演出服` (20)、`联动` (10)、`礼服` (9)、`泳装` (7)、`打工服` (4)、`和服` (3)。
- **背景分类（1,401 张）**：`剧情插画` (658)、`线上通话` (177)、`特效与纯色` (100)、`住宅与房间` (93)、`演出与排练` (81)、`校园` (74)、`SEKAI世界` (69)、`涩谷街景` (66)、`游乐园与休闲` (55)、`商业与餐饮` (12)、`医院与公共` (12)、`自然与旅行` (4)；每张均附带 `timeOfDay`（`白天`/`黄昏`/`夜晚`/`深夜`/`通用`）与 `indoor`（`室内`/`室外`）。
- **BGM 覆盖（421 首）**：已移除早期 80 首截断与“仅收录在 `soundtracks.json`”过滤，合并 400 首剧情 BGM 与 21 首 `sound/area_bgm/` 区域 BGM，并在支持 HCA/WAV 循环区间的音频上提取 `loopStartMs` / `loopEndMs` 写入伴随元数据。
- **SE 分类（1,942 条）**：`日常环境` (1,383)、`活动专属` (268)、`脚步` (119)、`餐饮器皿` (38)、`天气自然` (36)、`舞台演出` (20)、`手机通知` (19)、`键盘鼠标` (18)、`开关门` (10)、`乐器音乐` (8)、`语音通话` (5)、`世界观转场` (4) 等。

</details>

### 行为约定

- **同名多时段背景消歧**：同一地点常有白天、黄昏、夜晚、深夜多张变体。`findCloudBackground` 与 `CatalogView.canonicalImageEntry` 均支持按 `神山高校 天台·黄昏` / `神山高校 天台（夜晚）` 精确选图，未写时段时优先返回白天/通用变体。
- **多服装与亚角色暴露**：云端目录通过 `selectModels(..., { allOutfits: true, includeSub: true, notableIds })` 暴露 26 位主角色的全部可换服装及知名配角；本地 `models.yaml` 只占对应角色的默认首选位，不会屏蔽同一角色的其余云端服装或未登记角色。
- **目录刷新与离线降级**：宿主启动时先调用 `loadFromCache()` 秒级加载磁盘快照，再最多等待 15 秒在线刷新；请求 `/api/v1/resources` 或 `/api/v1/generate` 时最多等 2 秒首轮快照。若网络不可达，有旧快照时沿用旧快照，完全无快照时自动回落纯本地模式。

## 配置与数据来源

`config.yaml` 的 `assets` 节（所有字段均内置默认值）：

```yaml
assets:
  source: moesekai
  region: jp # jp | cn | tw | kr | en（env: MSS_ASSETS_REGION）
  indexBase: https://assets.pjsk.moe/sekai-extra-assets/sekai-live2d/
  libraryBase: https://assets.pjsk.moe/sekai-extra-assets/sekai-story/ripper/
  assetBase: '' # 留空按 region 推导 https://storage.exmeaning.com/sekai-<region>-assets
  soundtrackBase: https://cdn.jsdelivr.net/gh/Sekai-World/sekai-master-db-diff@master/
  cacheDir: cache/moesekai # 动作包与 catalog.json 缓存目录（env: MSS_ASSETS_CACHE_DIR）
  concurrency: 4
  timeoutMs: 180000
  retries: 3
  cloudCatalog: true # 设 false 时关闭云端目录，仅使用本地资源与 YAML 清单
  cloudCatalogTtlHours: 6 # 目录快照有效期（小时）
```

数据源对应关系：

| 内容                 | 默认地址                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| Live2D 模型索引      | `https://assets.pjsk.moe/sekai-extra-assets/sekai-live2d/<region>/models.json`                                 |
| 模型包 / SSE 动作包  | `https://assets.pjsk.moe/sekai-extra-assets/sekai-story/ripper/<region>/library/...`                           |
| 背景 / BGM / SE 资产 | `https://storage.exmeaning.com/sekai-<region>-assets/...`                                                      |
| 官方 UI / 菜单音效   | `https://assets.pjsk.moe/sekai-extra-assets/inapp/jp-7.0.0/...`                                                |
| BGM 官方曲名索引     | `https://cdn.jsdelivr.net/gh/Sekai-World/sekai-master-db-diff@master/`（自动回退 `raw.githubusercontent.com`） |

## 可选：离线预拉取 CLI

零本地资源架构下**无需**预先执行拉取命令即可正常生成与导出；但若希望把常用模型、背景或 BGM 预先固化到 `resources/` 并登记到本地 YAML（如内网/离线环境），可使用 `package.json` 提供的 CLI：

```bash
# 拉取指定角色（支持中文名/简称/罗马字/数字 id，all = 26 位主角色首选服装）
npm run fetch:models -- --characters mizuki,ena
npm run fetch:models -- --characters all
npm run fetch:models -- --models 20mizuki_normal_3.0_t04
npm run fetch:models -- --dry-run --characters mizuki
npm run fetch:models -- --list --characters mizuki

# 浏览或拉取背景与 BGM（--include-area 可同时拉取 area_bgm）
npm run fetch:media -- --kind backgrounds --list --limit 20
npm run fetch:media -- --kind backgrounds --limit 20
npm run fetch:media -- --kind bgm --names bgm00003,bgm00006 --include-area
npm run fetch:media -- --kind bgm --metadata-only
```

### `fetch:models` 常用参数

| 参数                   | 说明                                                         |
| ---------------------- | ------------------------------------------------------------ |
| `--characters <keys>`  | 角色列表，逗号分隔；`all` = 26 位角色各一套首选服装          |
| `--models <ids>`       | 精确模型 id，逗号分隔（可拉特定服装、`v2_`、联动或配角模型） |
| `--region <code>`      | `jp` / `cn` / `tw` / `kr` / `en`，默认取 `assets.region`     |
| `--out <dir>`          | 资源根，默认取 `paths.resources`                             |
| `--cache <dir>`        | 动作包缓存目录，默认取 `assets.cacheDir`                     |
| `--concurrency <n>`    | 并行下载数，默认 4；网络不稳时可调至 1~2                     |
| `--force`              | 已登记的同名模型也重新下载                                   |
| `--dry-run` / `--list` | 仅预览选中结果 / 列出索引匹配项，不下载                      |

### `fetch:media` 常用参数

| 参数                                     | 说明                                        |
| ---------------------------------------- | ------------------------------------------- |
| `--kind <kind>`                          | `backgrounds` / `bgm` / `all`，默认 `all`   |
| `--region <code>`                        | 区服，默认取 `assets.region`                |
| `--out <dir>`                            | 资源根，默认取 `paths.resources`            |
| `--asset-base <url>`                     | 覆盖资源站根地址                            |
| `--metadata-base <url>`                  | 覆盖曲名索引目录                            |
| `--metadata-only` / `--refresh-metadata` | 只更新曲名索引缓存 / 强制忽略 7 天缓存重拉  |
| `--no-metadata`                          | 不读取官方曲名索引                          |
| `--limit <n>`                            | 每种资源最多处理多少个 bundle（`0` = 全部） |
| `--names <list>`                         | 按名称精确匹配或子串过滤 bundle，逗号分隔   |
| `--include-area`                         | 同时拉取 `sound/area_bgm/` 区域 BGM         |
| `--force` / `--dry-run` / `--list`       | 强制重下 / 仅预览 / 仅列出远端 bundle       |

## 动作无损转换与缓存

Moesekai 剧情库保留的是 Unity `AnimationClip` 导出的 `sse-motion.json`，其曲线由三次多项式分段 `[d, c, b, a]` 描述：

```text
value(dt) = a + b*dt + c*dt^2 + d*dt^3
```

宿主在拉取或按需物化模型时，会将 `constant` / `streamed` 曲线无损转换为 Cubism `motion3.json` 的 stepped / linear / Bezier 段，并将 `facial/face_*.sse-motion.json` 与 `motion/w-*.sse-motion.json` 写入模型包的 `motions/`，同时自动补齐 `model3.json` 的 `FileReferences.Motions` 索引。

动作包中间文件按 bundle 缓存在 `assets.cacheDir`（默认 `cache/moesekai`），单文件原子落盘支持断点续传，同一角色的不同服装变体共享动作包时只下载一次。`cache/` 目录可随时安全清理。

## HTTP API 端点

```bash
# 查看合并后的完整资源目录（含本地覆盖与 cloud 元信息）
curl -sS 'http://127.0.0.1:9881/api/v1/resources'

# 强制刷新云端目录快照并写入 <cacheDir>/catalog.json
curl -sS -X POST 'http://127.0.0.1:9881/api/v1/cloud/refresh'

# 浏览远端模型或媒体 bundle 索引（不下载）
curl -sS 'http://127.0.0.1:9881/api/v1/assets/moesekai/models?region=jp&characters=mizuki'
curl -sS 'http://127.0.0.1:9881/api/v1/assets/moesekai/media?kind=bgm&includeArea=true&limit=20'

# 手动触发拉取并写入本地 resources/ 与对应 YAML（同期只允许一个任务）
curl -sS -X POST 'http://127.0.0.1:9881/api/v1/assets/fetch' \
  -H 'Content-Type: application/json' \
  -d '{"characters":["mizuki","ena"],"region":"jp"}'
```

## 离线语义索引构建脚本（开发维护）

若上游语料更新，开发者可用以下离线脚本重新生成 `src/host/assets/*.json`：

- `scripts/assets/build-background-names.mjs` → `src/host/assets/background-names.json`
- `scripts/assets/build-bgm-semantics.mjs` → `src/host/assets/bgm-semantics.json`
- `scripts/assets/build-model-se-semantics.mjs` → `src/host/assets/model-metadata.json` & `src/host/assets/se-semantics.json`
