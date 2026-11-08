# 云端资源获取（moesekai / pjsk.moe）

[返回文档索引](README.md) · [资源与音频配置](resources.md) · [API 参考](api.md)

宿主可以从 Moesekai 公开剧情库拉取 Project SEKAI 的 Live2D 模型与动作，也可以从资源站拉取剧情背景和 BGM。
模型拉取完成后不需要手工改模型文件：`models.yaml` 会自动登记，动作会写进模型包的 `motions/`；
背景和 BGM 会分别追加到 `images.yaml` / `bgm.yaml`。

从 2026-11 起，宿主还提供**云端目录**（`assets.cloudCatalog`，默认开启）：背景、BGM 与 Live2D
模型不再要求先下载到本地或写 YAML 登记。宿主从公开资源站生成目录（背景 id → 官方剧情地点名、
BGM id → 官方曲名、模型 id → 角色名/动作/表情），AI 与手写剧本都可以直接写背景名（如 `教室`）、
曲名（如 `Slapstick!!`）或云端 id；导出前按需把真正用到的文件下载到资源根的 `cloud/` 子目录，
之后命中缓存直接复用。目录缓存在 `assets.cacheDir/catalog.json`，默认 6 小时刷新一次，
可用 `POST /api/v1/cloud/refresh` 手动刷新。

资源版权归 Bushiroad / Craft Egg / SEGA 等原权利方所有。下载脚本只用于本地、非商业的渲染与测试；仓库不附带、也不再分发这些资源。部署与分享成片前请自行确认授权范围。

## 云端目录与按需物化

云端目录解决的是“每加一个背景/曲目都要先下载、再手写 YAML”的问题。开启后：

| 资源   | 目录来源                                                                    | 剧本里可以写                                         | 物化位置                                   |
| ------ | --------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------ |
| 背景   | 资源站 `scenario/background/` bundle 列表 + 官方剧情 PlaceInfo/Telop 地点名 | `教室`、`司の部屋`、`bg_a000301`、`cloud/bg_a000301` | `resources/images/cloud/<id>.<ext>`        |
| BGM    | 资源站 `sound/scenario/bgm/` + Sekai-World 官方曲名索引                     | `Slapstick!!`、`bgm00003`、`cloud/bgm00003.mp3`      | `resources/audio/bgm/cloud/<id>.mp3`       |
| SE     | 资源站 `sound/scenario/se/`                                                 | `se_door.mp3` 等 cue 文件                            | `resources/audio/se/cloud/<file>`          |
| Live2D | Moesekai 模型索引 + 动作包 `_ripper.json`                                   | `cloud/<模型 id>/<变体>/<model3.json>`               | `resources/models/cloud/<模型 id>/<变体>/` |

行为约定：

- **本地优先**：故事引用的文件如果已经在资源根下，宿主不会用云端文件替换，也不会重新下载。
- **全局 BGM 也可以云端**：`bgm.path` 写的曲名/id 在本地不存在时，会解析成云端曲目并改写为
  `audio/bgm/cloud/<id>.mp3`；已经是 http(s) URL 或站内绝对路径时保持原样。
- **只物化用到的资源**：导出前扫描 `models`、`images`、`ChangeBgm`、`PlaySe`/`StopSe`；只有缺失的才下载。
- **缓存复用**：物化结果就在资源根，第二次导出同一剧本直接读本地文件；删除 `cloud/` 即可重新拉取。
- **目录刷新失败不影响出片**：启动时先读 `assets.cacheDir/catalog.json`，在线刷新失败沿用旧快照；
  完全没有目录时回落到本地资源，云端引用会保留原值并报出具体路径。
- **模型动作**：云端模型在目录阶段只读取包清单枚举动作/表情；真正下载时会转换 SSE 动作并补
  `model3.json` 的 `FileReferences.Motions` 索引，渲染端不需要额外处理。
- **背景名**：来自官方剧情中背景生效期间的地点标题，同名背景按 id 排序取第一张；没有地点名的背景
  仍可用 id 引用，但不进入 AI 候选列表。地点名索引由
  `scripts/assets/build-background-names.mjs` 生成，仓库内的索引只是离线基线。

配置项（`config.yaml` 的 `assets` 节，全部有默认值）：

```yaml
assets:
  cloudCatalog: true # 关闭后只使用本地资源与 YAML 登记
  cloudCatalogTtlHours: 6 # 目录缓存有效期
```

## 数据来源

| 内容             | 地址                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------- |
| 模型索引         | `https://assets.pjsk.moe/sekai-extra-assets/sekai-live2d/<区服>/models.json`                 |
| 模型包 / 动作包  | `https://assets.pjsk.moe/sekai-extra-assets/sekai-story/ripper/<区服>/library/live2d/...`    |
| 背景等普通资产   | `https://storage.exmeaning.com/sekai-<区服>-assets/...`                                      |
| 背景 bundle 索引 | `https://storage.exmeaning.com/api/assets/bundles?server=<区服>&prefix=scenario/background/` |
| 剧情 BGM         | `https://storage.exmeaning.com/sekai-<区服>-assets/sound/scenario/bgm/<name>/<name>.mp3`     |

区服为 `jp`、`cn`、`tw`、`kr`、`en`，默认 `jp`。模型索引里每个条目包含模型 id、模型包路径、默认动作包和动作包列表；模型包内是 `model3.json`、`moc3`、纹理和物理文件，动作包内是游戏原始的 `sse-motion.json`。

## 快速使用

```bash
# 拉取一个角色（按中文名/简称/罗马字/数字 id 都可以）
npm run fetch:models -- --characters mizuki

# 一次拉多个角色
npm run fetch:models -- --characters 瑞希,绘名,25

# 26 位角色各拉一套首选服装
npm run fetch:models -- --characters all

# 精确指定模型 id（可写 v2_ / clb / sub 模型）
npm run fetch:models -- --models 20mizuki_normal_3.0_t04

# 只看看会选中哪些模型，不下载
npm run fetch:models -- --dry-run --characters mizuki

# 列出索引里匹配的模型
npm run fetch:models -- --list --characters mizuki

# 背景 / BGM（先列出，再按需下载）
npm run fetch:media -- --kind backgrounds --list --limit 20
npm run fetch:media -- --kind backgrounds --limit 20
npm run fetch:media -- --kind bgm --names bgm00003,bgm00006
npm run fetch:media -- --kind all --dry-run
```

脚本会先构建宿主（`npm run build:host`），再执行 `out-host/host/tools/fetchAssets.js` 或 `fetchMedia.js`。模型参数：

| 参数                  | 说明                                                     |
| --------------------- | -------------------------------------------------------- |
| `--characters <keys>` | 角色列表，逗号分隔；`all` = 26 位角色各一套首选服装      |
| `--models <ids>`      | 精确模型 id，逗号分隔                                    |
| `--region <code>`     | `jp` / `cn` / `tw` / `kr` / `en`，默认取 `assets.region` |
| `--out <dir>`         | 资源根，默认取 `paths.resources`                         |
| `--cache <dir>`       | 动作包缓存目录，默认取 `assets.cacheDir`                 |
| `--concurrency <n>`   | 并行下载数，默认 4；网络不稳时调到 1~2                   |
| `--force`             | 已登记的同名模型也重新下载                               |
| `--dry-run`           | 只打印选择结果                                           |
| `--list`              | 列出索引中匹配的模型                                     |

## 背景与 BGM

`fetch:media` 通过资源站的 bundle API 浏览 `scenario/background/` 与 `sound/scenario/bgm/`，
把背景图下载到 `resources/images/`，把剧情 BGM 下载到 `resources/audio/bgm/`，并追加清单条目。
BGM 下载时会读取 PJSK 官方曲名索引，把 `bgm00003` 这类无语义文件名补成曲名和分类。

| 参数                    | 说明                                                                   |
| ----------------------- | ---------------------------------------------------------------------- |
| `--kind <kind>`         | `backgrounds` / `bgm` / `all`，默认 `all`                              |
| `--region <code>`       | 区服，默认取 `assets.region`                                           |
| `--out <dir>`           | 资源根，默认取 `paths.resources`                                       |
| `--asset-base <url>`    | 资源站根地址，默认 `https://storage.exmeaning.com`                     |
| `--metadata-base <url>` | 曲名索引目录，默认 `assets.soundtrackBase`（jsDelivr 的 jp master DB） |
| `--metadata-only`       | 只更新曲名索引缓存，不下载 BGM                                         |
| `--no-metadata`         | 不读取官方曲名索引，清单条目保持空描述                                 |
| `--refresh-metadata`    | 忽略缓存有效期，强制更新曲名索引                                       |
| `--limit <n>`           | 每种资源最多处理多少个 bundle，默认 `0` = 全部                         |
| `--names <list>`        | 只处理名称精确匹配或包含片段的 bundle，逗号分隔                        |
| `--include-area`        | 同时拉取 `sound/area_bgm/` 区域 BGM                                    |
| `--concurrency <n>`     | 下载并发数，默认 4                                                     |
| `--force`               | 已存在的文件也重新下载；清单不会重复追加                               |
| `--dry-run`             | 只列 bundle 和目标文件，不写盘                                         |
| `--list`                | 只列出资源站上匹配的 bundle                                            |

行为说明：

- 背景优先取 `.webp`，没有时回退 `.png` / `.jpg`；文件名沿用 bundle 内的文件名。
- `bgm00000` 是游戏里的静音占位，`bgm` 是通用 bundle，两者默认跳过。
- 已存在同名文件默认跳过，重复运行只补缺失项；清单按 `file` 去重，保留已有注释和描述。
- 新追加的背景条目 `description` 为空。AI 选背景依赖描述，下载后建议在
  `resources/images/images.yaml` 里补一句画面说明。
- BGM 条目会先用官方曲名索引补上 `name` 和分类描述；索引没收录的曲目仍为 `description` 空，
  建议在 `resources/audio/bgm/bgm.yaml` 里手工补一句曲风说明，否则不会进入 AI 候选列表。
- 只写文件与清单，不自动修改全局默认 BGM；要换默认曲目，改 `bgm.yaml` 的 `path`。

## BGM 曲名与 AI 候选

ournotes-player 让 AI 选 BGM 时，依赖剧情 cue 的可读名字（例如
`sound_bgm_adv_nows_the_time` → `Nows The Time`）。Moesekai 的剧情 BGM 文件名是
`bgm00003` 这类 id，本身没有语义；宿主用 Sekai-World 的
[`musicSoundTracks.json`](https://github.com/Sekai-World/sekai-master-db-diff) 补上官方曲名和分类：

```text
bgm00003.mp3 → Slapstick!! / 剧情 BGM
bgm00006.mp3 → 微笑みの陽だまり / 剧情 BGM
bgm_area00001.mp3 → With Gratitude / Crystal Blessing 等 4 首 / 组合综合 BGM
```

- 下载时读取 `musicSoundTracks.json` 与 `musicSoundTrackCategories.json`，把精简结果缓存到
  `resources/audio/bgm/soundtracks.json`；缓存 7 天有效，失败时沿用旧缓存。
- 默认走 jsDelivr；jsDelivr 不通时回退 `raw.githubusercontent.com`，也可用
  `assets.soundtrackBase` 或 `MSS_ASSETS_SOUNDTRACK_BASE` 指向镜像。
- 资源目录读取 `bgm.yaml` 时，`name` 为空、等于文件名或 `description` 为空，会用缓存补全；
  人工填写的内容优先，不会被覆盖。
- 索引覆盖约 200 个资源名（其中剧情 BGM 约 120 个），不是所有 `sound/scenario/bgm/` 文件都有曲名；
  未收录的条目保持原样，仍可手工补描述。
- 提示词最多列 40 首带描述的 BGM；校验器仍接受全部登记曲目。这个上限避免把几百个云端文件一次性塞给模型。

## 首选服装

`--characters` 会为每个角色挑一套服装，顺序是：

1. 非联动、v1 模型优先，其次 v2
2. 服装词顺序：`normal` → `casual` → `school` → `unit` → `sports` → `pajamas` → `parttime` → `lesson` → `swim` → `jc` → `culture` → `yukata` → 其他

已经登记过同名角色的模型会跳过；要换服装，用 `--models` 精确指定，或先删除 `models.yaml` 里对应条目的模型目录。

## 动作转换

游戏资产里没有 `motion3.json`。Moesekai 剧情库保留的是 Unity `AnimationClip` 导出的 `sse-motion.json`：每条曲线是若干段三次多项式，系数顺序为 `[d, c, b, a]`，求值为

```text
value(dt) = a + b*dt + c*dt^2 + d*dt^3
```

宿主把每段三次多项式精确转成 Cubism motion3 的 Bezier 段，端点与游戏数据一致；没有把曲线拉直，也没有按帧采样。常量段写成 stepped，线性段写成 linear。转换后：

- `facial/face_*.sse-motion.json` → `motions/face_*.motion3.json`（表情）
- `motion/w-*.sse-motion.json` → `motions/w-*.motion3.json`（动作）
- 模型包的 `model3.json` 增加 `FileReferences.Motions` 索引，渲染端按名字直接播放

动作源文件只放在缓存目录，不会写进资源目录，也不会被静态托管。

## 目录与清单

下载一个模型后的布局：

```text
resources/models/
└─ 20mizuki_normal/
   └─ 20mizuki_normal_3.0_t04/
      ├─ 20mizuki_normal_3.0_t04.model3.json   # 已补 Motions 索引
      ├─ 20mizuki_normal_3.0_t04.moc3
      ├─ 20mizuki_normal_3.0_t04.physics3.json
      ├─ 20mizuki_normal_3.0_t04.2048/texture_00.png
      └─ motions/*.motion3.json
```

`models.yaml` 会自动追加：

```yaml
- id: 21
  name: '晓山瑞希'
  shortName: '瑞希'
  path: '20mizuki_normal/20mizuki_normal_3.0_t04/20mizuki_normal_3.0_t04.model3.json'
```

已有的注释、条目和 id 不会被重写；新 id 从现有最大 id + 1 开始。角色名来自内置的 26 位角色表，联动/配角模型使用模型 id。

## HTTP API

```bash
# 查看索引中匹配的模型
curl -sS 'http://127.0.0.1:9881/api/v1/assets/moesekai/models?region=jp&characters=mizuki'

# 触发模型拉取（同步等待；同一时刻只允许一个）
curl -sS -X POST http://127.0.0.1:9881/api/v1/assets/fetch \
  -H 'Content-Type: application/json' \
  -d '{"characters":["mizuki","ena"],"region":"jp"}'

# 浏览背景 / BGM bundle
curl -sS 'http://127.0.0.1:9881/api/v1/assets/moesekai/media?kind=backgrounds&region=jp&limit=20'

# 拉取背景；kind=bgm 或 all，names/limit/includeArea 与 CLI 同名
curl -sS -X POST http://127.0.0.1:9881/api/v1/assets/fetch \
  -H 'Content-Type: application/json' \
  -d '{"kind":"backgrounds","region":"jp","limit":20}'

# 云端目录：查看合并后的资源目录（含 cloud 条目与 cloud 元信息）
curl -sS 'http://127.0.0.1:9881/api/v1/resources'

# 强制刷新云端目录（模型/背景/BGM 名称索引）
curl -sS -X POST http://127.0.0.1:9881/api/v1/cloud/refresh
```

模型接口返回体包含 `selected`、`models`、`skipped`、`added` 与 `errors`；
媒体接口返回 `backgrounds`、`bgm`、`skipped`、`errors`、`addedImages` 与 `addedBgm`。
两者都同步等待，拉取过程中 `GET /api/v1/health` 的 `assets.fetching` 为 `true`。
省略 `kind` 且只传 `characters` / `models` 时保持旧的模型拉取行为。

## 缓存与断点续传

动作包按 bundle 缓存在 `assets.cacheDir`（默认 `cache/moesekai`）。每个文件下载完成后才原子落盘；网络中断后重跑只补缺失文件，已经下载的文件不会重复请求。同一个角色不同服装共用同一个动作包，也只会下载一次。

`cache/` 已加入 `.gitignore`。缓存可以随时删除；删除后下次拉取会重新下载。

## 常见问题

**索引 404 或超时**：先确认区服是否有发布索引，再检查网络能否访问 `assets.pjsk.moe`。把 `assets.retries` 调到 5、`assets.concurrency` 调到 1~2 通常能通过不稳定的网络。

**下载到一半失败**：直接重跑同一条命令。模型包已存在的文件会跳过，动作包从缓存继续。

**模型没有动作**：查看日志里该模型的“跳过无法转换的动作”。目前支持 `constant` 与 `streamed` 两种曲线；未知曲线类型只会让单条动作失败，不影响整个模型。

**渲染时动作名不对**：以 `GET /api/v1/resources` 返回的 `motions` / `facials` 为准；模型包的 `model3.json` 已经写入完整索引，不需要手工补。

**AI 还是选不到云端 BGM**：先看 `GET /api/v1/resources` 的 `cloud` 字段是否存在，再确认
`bgmDetails` 里有 `source: "cloud"` 且 `description` 非空的条目。目录过期时用
`POST /api/v1/cloud/refresh` 强制刷新；`bgm00000` 是静音占位，默认不进入候选；官方曲名索引没收录的
曲目需要本地 `bgm.yaml` 手写描述，或者等曲名索引更新。

## 实现状态（2026-11-09）

- 云端目录：`src/host/assets/cloudCatalog.ts`，26 位角色模型、1372 个背景 bundle、395 个 BGM bundle；
  背景地点名索引 146 条，来自 328 集官方剧情。
- 按需物化：`src/host/assets/cloudAssets.ts`，背景/BGM/SE/模型统一落到 `resources/*/cloud/`，
  导出前改写故事路径。
- 目录合并：`src/host/resources/resourceCatalog.ts`，本地 YAML 可缺省，云端条目带 `source`/`id`。
- 名称选择：`src/host/ai/prompt.ts` 的 `canonicalImage` / `canonicalBgm` 接受云端 id、文件名与可读名；
  AI 提示词列出 `- 名字（id）`。
- 真实导出验收：空资源目录 + 云端模型 `01ichika_normal` + 背景名 `司の部屋` + 曲名 `Slapstick!!`，
  产出 1920x1080 H.264/AAC 视频；第二次导出命中 `cloud/` 缓存，无重复下载。
- 回归：`npm run test:all` 297 项、`npm run test:stories` 6 项、`npm run typecheck` 全部通过。
