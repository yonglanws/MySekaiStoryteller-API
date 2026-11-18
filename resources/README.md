# resources — 渲染资源根

本项目采用**云端优先、零本地资源**架构。仓库本身不附带模型、背景图、语音、BGM 或示例剧本；但默认开启 `assets.cloudCatalog: true` 时，**空 `resources/` 目录即可直接启动宿主、AI 生成剧本并导出 MP4**。

```text
resources/
├─ models/
│  ├─ models.example.yaml   可选本地模型清单模板
│  ├─ models.yaml           可选本地模型登记（覆盖优先，不抑制其他云端角色/服装）
│  └─ cloud/                导出时按需物化的云端 Live2D 模型（可删，自动重建）
├─ images/
│  ├─ images.example.yaml   可选本地背景描述模板
│  ├─ images.yaml           可选本地背景描述（不抑制云端背景目录）
│  └─ cloud/                导出时按需物化的云端背景图（可删，自动重建）
├─ audio/
│  ├─ bgm/
│  │  ├─ bgm.example.yaml   可选本地 BGM 设置与曲目清单模板
│  │  ├─ bgm.yaml           可选独立 BGM 设置（缺失时自动回落云端 bgm00003）
│  │  ├─ soundtracks.json   官方曲名索引缓存（可删）
│  │  └─ cloud/             导出时按需物化的云端 BGM（可删，自动重建）
│  └─ se/
│     └─ cloud/             导出时按需物化的云端 SE 音效（可删，自动重建）
├─ inapp/jp-7.0.0/          按需拉取的官方 UI 贴图与通用交互音效（离线自动回退矢量绘制）
├─ voices/                  预录语音目录（当前 API 导出使用 TTS 音轨，不混入 voice）
└─ stories/                 可选存放 *.sekai-story.json 剧本
```

## 默认行为与本地覆盖

- **资源根位置**：默认 `<repo>/resources`，可通过 `config.yaml` 的 `paths.resources` 或环境变量 `MSS_RESOURCE_DIR` 修改。
- **零本地启动**：当 `bgm.yaml` 与 `resources/audio/bgm/bg1.mp3` 都不存在且 `assets.cloudCatalog: true` 时，全局默认 BGM 自动回落到云端日常曲 `bgm00003`，在首次导出前按需物化到 `resources/audio/bgm/cloud/bgm00003.mp3`。
- **本地优先覆盖**：若你在本地放置了同名资源文件（如 `audio/bgm/bg1.mp3`）或编写了 `models.yaml` / `images.yaml` / `bgm.yaml`，宿主会优先使用本地文件；且本地清单只覆盖对应条目，不会屏蔽云端目录里的其他角色服装变体、背景或 BGM。
- **可选模板**：三份 `*.example.yaml` 仅供需要手动登记自定义素材时参考，复制为正式文件名后编辑；正式渲染资源与清单不入库。
- **手动预拉取（可选）**：如需在无公网或内网环境提前缓存资源，可使用 `npm run fetch:models` 与 `npm run fetch:media`（详见 [云端资源获取](../doc/cloud-assets.md)）。

更多目录规则、TTS 与 BGM 配置见 [资源与音频配置](../doc/resources.md)。
