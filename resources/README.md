# resources — 渲染资源根

本仓库不附带模型、背景图、语音、BGM 或示例剧本。详细登记与配置方式见 [资源与音频配置](../doc/resources.md)。

```text
resources/
├─ models/       Live2D 模型与 models.yaml
├─ images/       背景图 / 卡面与 images.yaml
├─ voices/       预录语音（API 导出限制见资源文档）
├─ audio/bgm/    BGM 与 bgm.yaml
└─ stories/      *.sekai-story.json 剧本
```

资源根可通过 `config.yaml` 的 `paths.resources` 或 `MSS_RESOURCE_DIR` 指定。
三份 `*.example.yaml` 随仓库提供，复制为对应的 `models.yaml`、`images.yaml`、`bgm.yaml` 后编辑。
正式清单与渲染资源不入库；BGM 设置修改后需要重启宿主。
