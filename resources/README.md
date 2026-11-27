# resources — 渲染资源根

本项目采用**云端优先、零本地资源**架构。仓库本身不附带模型、背景图、语音、BGM 或示例剧本；开启 `assets.cloudCatalog: true` 时，**空 `resources/` 目录即可直接启动宿主、AI 生成剧本并导出 MP4**。

```text
resources/
├─ models/
│  ├─ models.example.yaml   可选本地模型清单模板
│  ├─ models.yaml           可选本地模型登记（cloudOnly: false 时覆盖优先，不抑制其他云端角色/服装）
│  └─ cloud/                导出时按需物化的云端 Live2D 模型（可删，自动重建）
├─ images/
│  ├─ images.example.yaml   可选本地背景描述模板
│  ├─ images.yaml           可选本地背景描述（cloudOnly: false 时生效，不抑制云端背景目录）
│  └─ cloud/                导出时按需物化的云端背景图（可删，自动重建）
├─ audio/
│  ├─ bgm/
│  │  ├─ bgm.example.yaml   可选本地 BGM 设置与曲目清单模板
│  │  ├─ bgm.yaml           可选独立 BGM 设置（cloudOnly: false 时生效；缺失时自动回落云端 bgm00003）
│  │  ├─ soundtracks.json   官方曲名索引缓存（可删）
│  │  └─ cloud/             导出时按需物化的云端 BGM（可删，自动重建）
│  └─ se/
│     └─ cloud/             导出时按需物化的云端 SE 音效（可删，自动重建）
├─ inapp/jp-7.0.0/          按需拉取的官方 UI 贴图与通用交互音效（离线自动回退矢量绘制）
├─ voices/                  预录语音目录（当前 API 导出使用 TTS 音轨，不混入 voice）
└─ stories/                 可选存放 *.sekai-story.json 剧本
```

## 默认行为（`cloudOnly: true`）与本地优先覆盖（`cloudOnly: false`）

- **资源根位置**：默认 `<repo>/resources`，可通过 `config.yaml` 的 `paths.resources` 或环境变量 `MSS_RESOURCE_DIR` 修改。
- **默认模板行为（`cloudOnly: true`）**：`config.example.yaml`、`.env.example`、`npm run init` 与 Docker 部署**默认启用 `assets.cloudOnly: true`**（纯云端隔离模式）。在该模式下，宿主仅从云端目录解析并按需缓存到 `resources/*/cloud/`，会**忽略**本地 `models.yaml`、`images.yaml`、`bgm.yaml` 以及非 `cloud/` 目录下的本地素材，从而保证零本地准备即可开箱运行、不受旧本地缓存干扰。
- **开启本地优先覆盖（`cloudOnly: false`）**：如果你希望放入自定义模型/背景/BGM，或使用 `models.yaml` / `images.yaml` / `bgm.yaml` 覆盖云端默认项，请将 `config.yaml` 中的 `assets.cloudOnly` 设为 `false`（或设置环境变量 `MSS_ASSETS_CLOUD_ONLY=false`；不创建 `config.yaml` 且不设该变量时，schema 裸默认即为 `false`）。开启本地覆盖后，本地文件优先生效，且本地清单只覆盖对应条目，不会屏蔽云端目录里的其他角色服装变体、背景或 BGM。
- **零本地默认 BGM 兜底**：在 `cloudOnly: true` 下，或 `cloudOnly: false` 且本地不存在 `bgm.yaml` / `audio/bgm/bg1.mp3` 时，全局默认 BGM 自动回落到云端日常曲 `bgm00003`（`Slapstick!!`），在首次导出前按需物化到 `resources/audio/bgm/cloud/bgm00003.mp3`。
- **可选模板**：三份 `*.example.yaml` 仅供需要手动登记自定义素材时参考，复制为正式文件名后编辑；正式渲染资源与清单不入库。
- **手动预拉取（可选）**：如需在无公网或内网环境提前缓存资源，可使用 `npm run fetch:models` 与 `npm run fetch:media`（详见 [云端资源获取](../doc/cloud-assets.md)）。

更多目录规则、TTS 与 BGM 配置见 [资源与音频配置](../doc/resources.md)。
