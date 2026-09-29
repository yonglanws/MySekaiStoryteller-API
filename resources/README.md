# resources — 渲染资源根

本仓库**不附带**渲染资源（Live2D 模型、背景图、语音、BGM、示例剧本），以控制仓库体积并遵循素材版权要求。请自行将资源放入对应目录：

```
resources/
├─ models/       Live2D 模型包（<角色>/<变体>/，含 model3.json；models.yaml 为登记表）
├─ images/       背景图 / 卡面（images.yaml 为画面描述表）
├─ voices/       故事语音（.wav，故事 JSON 按文件名引用）
├─ audio/bgm/    BGM（bgm.yaml 为 BGM 设置：开关/路径/音量）
└─ stories/      *.sekai-story.json 剧本
```

三个清单/设置文件各附一份 `*.example.yaml` 示例（随仓库分发）：把示例复制为去掉 `.example` 的正式文件名（`models.yaml` / `images.yaml` / `bgm.yaml`）后编辑即可，正式文件不入库。

资源根不强制叫 `resources/`：可在 `config.yaml` 的 `paths.resources` 或环境变量 `MSS_RESOURCE_DIR` 指向任意目录（示例文件也要一起带过去）。新增模型后在 `resources/models/models.yaml` 登记一行；新增背景后在 `resources/images/images.yaml` 写画面描述，宿主会自动识别，详见主 README 的「资源导入指南」。

## BGM 设置（audio/bgm/bgm.yaml）

```yaml
enabled: true              # 导出时是否混入 BGM
path: audio/bgm/bg1.mp3    # 相对资源根的路径，也可用绝对路径或 http(s) URL
volume: 0.2                # 音量 0.0 - 1.0
```

改完重启宿主生效。本文件不存在时，宿主回落到 `config.yaml` 的 `bgm` 节。
