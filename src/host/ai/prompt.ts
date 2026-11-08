import type {
  CatalogBgm,
  CatalogImage,
  CatalogModel,
  ResourceCatalogData
} from '../resources/resourceCatalog'
import { normalizeBgmFile } from '../../common/audio/bgm'
import { GENERIC_PROFILE, personaFor, type PersonaEntry } from './personas'

const MAX_FULL_MOTIONS = 60
const MAX_FULL_FACIALS = 60

const MODEL_MOTION_PREFIX = (name: string): string => {
  const parts = name.split('-')
  return parts.length > 1 ? `${parts.slice(0, -1).join('-')}-` : name
}

const FACIAL_PREFIX = (name: string): string => {
  const index = name.lastIndexOf('_')
  return index > 0 ? name.slice(0, index) : name
}

function summarize(names: string[], prefix: (name: string) => string, limit: number): string {
  if (names.length === 0) return '（目录暂未提供）'
  if (names.length <= limit) return [...names].sort().join('，')
  const groups = new Map<string, string[]>()
  for (const name of names) {
    const key = prefix(name)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(name)
  }
  return [...groups.keys()]
    .sort()
    .map((key) => {
      const items = groups.get(key)!.sort()
      return `${key}*（${items.length}个，如 ${items.slice(0, 2).join('、')}）`
    })
    .join('，')
}

function fillTemplate(template: string, mapping: Record<string, string>): string {
  const keys = Object.keys(mapping).sort((a, b) => b.length - a.length)
  const pattern = new RegExp(
    keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'g'
  )
  return template.replace(pattern, (match) => mapping[match] ?? match)
}

/**
 * 资源目录的提示词视图：把 ResourceCatalog 的原始数据整理成模型/动作/表情/背景/BGM 文本，
 * 并提供校验所需的精确名称与模糊修复。
 */
export class CatalogView {
  readonly models: CatalogModel[]
  readonly images: string[]
  readonly imageDetails: CatalogImage[]
  readonly bgmDetails: CatalogBgm[]

  constructor(data: ResourceCatalogData) {
    this.models = data.models.filter((model) => Boolean(model.path))
    this.images = data.images ?? []
    this.imageDetails = (data.imageDetails ?? []).filter((item) => Boolean(item.file))
    this.bgmDetails = (data.bgmDetails ?? []).filter((item) => Boolean(item.file))
  }

  withModels(models: CatalogModel[]): CatalogView {
    return Object.assign(Object.create(CatalogView.prototype), this, { models }) as CatalogView
  }

  modelById(id: number): CatalogModel | null {
    return this.models.find((model) => model.id === id) ?? null
  }

  defaultModel(): CatalogModel | null {
    return this.models[0] ?? null
  }

  defaultModelPath(): string {
    return this.defaultModel()?.path ?? ''
  }

  shortName(model: CatalogModel): string {
    return model.shortName || model.name || `model${model.id}`
  }

  nameById(id: number): string {
    const model = this.modelById(id)
    return model ? this.shortName(model) : `model${id}`
  }

  validModelPaths(): Set<string> {
    return new Set(this.models.map((model) => model.path))
  }

  imageDetailsList(): CatalogImage[] {
    if (this.imageDetails.length > 0) return this.imageDetails
    return this.images.map((file) => ({ file, name: file, description: '' }))
  }

  bgmDetailsList(): CatalogBgm[] {
    if (this.bgmDetails.length > 0) return this.bgmDetails
    return []
  }

  /**
   * 所有 description 非空的 BGM 登记项。描述可以来自人工填写，也可以来自
   * fetch:media 缓存的官方曲名索引（bgm00003 → Slapstick!! / 剧情 BGM）。
   *
   * 提示词渲染方传 `limit: 40`：云端剧情 BGM 有几百个文件，全量塞进提示词
   * 既贵又会稀释重点；校验用的 canonicalBgm 仍接受全部登记项，不受上限影响。
   */
  bgmPromptChoices(limit = 0): CatalogBgm[] {
    const choices = this.bgmDetailsList().filter((detail) => detail.description.trim().length > 0)
    return limit > 0 ? choices.slice(0, limit) : choices
  }

  /**
   * 把 AI 写的 BGM 名收束到 bgm.yaml 登记的文件名；未登记返回 null。
   * 只接受 bgmDetails，不把磁盘上碰巧存在的音频暴露成候选。
   */
  canonicalBgm(value: unknown): string | null {
    const raw = normalizeBgmFile(value)
    if (!raw) return null
    const details = this.bgmDetailsList()
    if (details.length === 0) return null

    const exact = details.find((detail) => detail.file === raw)
    if (exact) return exact.file

    const lower = raw.toLowerCase()
    const byFile = details.find((detail) => detail.file.toLowerCase() === lower)
    if (byFile) return byFile.file

    const base = lower.split('/').pop() ?? lower
    const byBase = details.find(
      (detail) => (detail.file.toLowerCase().split('/').pop() ?? '') === base
    )
    if (byBase) return byBase.file

    const byName = details.filter(
      (detail) => detail.name.toLowerCase() === lower || detail.file.toLowerCase().includes(lower)
    )
    return byName.length === 1 ? byName[0].file : null
  }

  defaultImage(): string {
    return this.imageDetailsList()[0]?.file ?? this.images[0] ?? ''
  }

  validImages(): Set<string> {
    const files = new Set(this.images)
    for (const detail of this.imageDetails) files.add(detail.file)
    return files
  }

  validMotions(modelId: number): Set<string> {
    return new Set(this.modelById(modelId)?.motions ?? [])
  }

  validFacials(modelId: number): Set<string> {
    return new Set(this.modelById(modelId)?.facials ?? [])
  }

  defaultMotion(modelId: number): string {
    const model = this.modelById(modelId)
    return model?.defaultMotion || 'w-normal-default01'
  }

  defaultFacial(modelId: number): string {
    const model = this.modelById(modelId)
    return model?.defaultFacial || 'face_smile_01'
  }

  animationChoices(modelId: number, field: 'motion' | 'facial'): Set<string> {
    return field === 'motion' ? this.validMotions(modelId) : this.validFacials(modelId)
  }

  /**
   * 把 AI 写的动作/表情名尽量修正成目录里的完整名；修不了返回 null。
   * 顺序：精确 → 忽略大小写 → 忽略空白 → 唯一尾号归一 → 唯一前缀。
   */
  canonicalAnimation(modelId: number, field: 'motion' | 'facial', value: unknown): string | null {
    if (typeof value !== 'string') return null
    const raw = value.trim()
    if (!raw) return null
    const names = this.animationChoices(modelId, field)
    if (names.size === 0) return null
    if (names.has(raw)) return raw

    const uniqueHit = (key: (name: string) => string): string | null => {
      const counts = new Map<string, number>()
      for (const name of names) {
        const k = key(name)
        counts.set(k, (counts.get(k) ?? 0) + 1)
      }
      const hit = [...[...names].sort()].find(
        (name) => counts.get(key(name)) === 1 && key(name) === key(raw)
      )
      return hit ?? null
    }

    const lower = uniqueHit((name) => name.toLowerCase())
    if (lower) return lower
    const noSpace = uniqueHit((name) => name.replace(/\s+/g, '').toLowerCase())
    if (noSpace) return noSpace
    // face smile 01 / face-smile-01 → face_smile_01；只接受唯一命中
    const compact = uniqueHit((name) => name.replace(/[\s_-]+/g, '').toLowerCase())
    if (compact) return compact

    const stripNumber = (name: string): string => name.replace(/\d+$/, '').toLowerCase()
    const stem = stripNumber(raw)
    const stemHits = [...names].sort().filter((name) => stripNumber(name) === stem)
    if (stemHits.length === 1) return stemHits[0]

    const prefixHits = [...names]
      .sort()
      .filter((name) => name.toLowerCase().startsWith(raw.toLowerCase()))
    if (prefixHits.length === 1) return prefixHits[0]
    return null
  }

  modelTable(): string {
    return this.models
      .map((model) => `- ${this.shortName(model)} → modelId=${model.id}, model路径=${model.path}`)
      .join('\n')
  }

  idMapping(): string {
    return this.models.map((model) => `${this.shortName(model)}=${model.id}`).join(', ')
  }

  motionList(): string {
    return this.models
      .map(
        (model) =>
          `${this.shortName(model)}(${model.id})：${summarize(model.motions ?? [], MODEL_MOTION_PREFIX, MAX_FULL_MOTIONS)}`
      )
      .join('\n')
  }

  facialList(): string {
    return this.models
      .map(
        (model) =>
          `${this.shortName(model)}(${model.id})：${summarize(model.facials ?? [], FACIAL_PREFIX, MAX_FULL_FACIALS)}`
      )
      .join('\n')
  }

  imageList(): string {
    const details = this.imageDetailsList()
    if (details.length === 0) return '（目录暂未提供背景）'
    return details
      .map((detail) => {
        const name = detail.name || detail.file
        return detail.description
          ? `- ${detail.file}（${name}）：${detail.description}`
          : `- ${detail.file}（${name}）`
      })
      .join('\n')
  }

  bgmList(): string {
    const details = this.bgmPromptChoices(40)
    if (details.length === 0) return '（目录暂未提供带描述或官方曲名的 BGM）'
    return details
      .map((detail) => {
        const name = detail.name || detail.file
        return detail.description
          ? `- ${detail.file}（${name}）：${detail.description}`
          : `- ${detail.file}（${name}）`
      })
      .join('\n')
  }

  characterPool(personas: PersonaEntry[]): string {
    if (this.models.length === 0) return '（资源目录为空，请检查渲染宿主）'
    return this.models
      .map((model) => {
        const persona = personaFor(personas, model)
        return `**${this.shortName(model)}** — modelId:${model.id}, model:${model.path}\n${
          persona?.prompt ?? GENERIC_PROFILE
        }`
      })
      .join('\n\n')
  }
}

const STORY_SYSTEM_PROMPT =
  '你是视觉小说导演。只输出合法 JSON（仅含 models、images、snippets，可选 bgm），不要 markdown 或解释。写成约 3 分钟的短戏，禁止超长剧情；对话多少按角色人设自行把握。表演克制：一句台词一个自然小动作，不要连续比划。'

const CHAT_SYSTEM_PROMPT =
  '你是视觉小说角色扮演导演。只输出合法 JSON（仅含 models、images、snippets，可选 bgm），不要 markdown 或解释。对话多少按角色人设自行把握。表演克制：一句台词一个自然小动作，不要连续比划。'

/** 用当前目录里真实存在的模型/动作/背景生成一段可执行的示例。 */
export function buildActingExample(view: CatalogView): string {
  const models = view.models.slice(0, 2)
  if (models.length === 0) return '{}'
  const ids = models.map((model) => model.id)

  const stageMotion = (modelId: number): string => {
    const model = view.modelById(modelId)
    const names = model?.motions ?? []
    return (
      names.find(
        (name) => !name.toLowerCase().includes('default') && !name.toLowerCase().includes('stand')
      ) ?? view.defaultMotion(modelId)
    )
  }

  const paired = (modelId: number, at: number, index = 0): Record<string, unknown> => {
    const model = view.modelById(modelId)
    const names = [
      ...new Set(
        (model?.motions ?? []).filter(
          (name) => !name.toLowerCase().includes('default') && !name.toLowerCase().includes('stand')
        )
      )
    ]
    const motion = names[index] ?? names[0] ?? view.defaultMotion(modelId)
    const facials = model?.facials ?? []
    return {
      at,
      modelId,
      motion,
      facial: facials[0] ?? view.defaultFacial(modelId)
    }
  }

  const talk = (
    modelId: number,
    content: string,
    ttsText: string,
    actions: Array<Record<string, unknown>>,
    delay = 0
  ): Record<string, unknown> => ({
    type: 'Talk',
    wait: false,
    delay,
    data: {
      speaker: view.shortName(view.modelById(modelId) ?? models[0]),
      content,
      ttsText,
      modelId,
      actions
    }
  })

  const snippets: Array<Record<string, unknown>> = [
    { type: 'ChangeLayoutMode', wait: false, delay: 0, data: { mode: 'Normal' } }
  ]

  if (ids.length === 1) {
    const id = ids[0]
    snippets.push({
      type: 'LayoutAppear',
      wait: true,
      delay: 0,
      data: {
        modelId: id,
        from: { side: 'Right', offset: 100 },
        to: { side: 'Center', offset: 0 },
        motion: stageMotion(id),
        facial: view.defaultFacial(id),
        facialFirst: true,
        moveSpeed: 'Normal'
      }
    })
    snippets.push(
      talk(id, '今天也想和你多聊一会儿。', '今日も、もう少し話したいな。', [paired(id, 0.1, 1)])
    )
    snippets.push({
      type: 'LayoutClear',
      wait: true,
      delay: 0.1,
      data: {
        modelId: id,
        from: { side: 'Center', offset: 0 },
        to: { side: 'Center', offset: 100 },
        motion: stageMotion(id),
        facial: view.defaultFacial(id),
        moveSpeed: 'Normal'
      }
    })
  } else {
    const [first, second] = ids
    for (const [modelId, side, offset] of [
      [first, 'Left', -100],
      [second, 'Right', 100]
    ] as const) {
      snippets.push({
        type: 'LayoutAppear',
        wait: true,
        delay: 0,
        data: {
          modelId,
          from: { side, offset },
          to: { side, offset: 0 },
          motion: stageMotion(modelId),
          facial: view.defaultFacial(modelId),
          facialFirst: true,
          moveSpeed: 'Normal'
        }
      })
    }
    snippets.push(
      talk(first, '今天也想和你多聊一会儿。', '今日も、もう少し話したいな。', [
        paired(first, 0.1, 1)
      ])
    )
    snippets.push(
      talk(
        second,
        '嗯，今天也请多指教。',
        'うん、今日もよろしくね。',
        [paired(second, 0.1, 1)],
        0.1
      )
    )
    for (const [index, modelId] of ids.entries()) {
      const side = index === 0 ? 'Left' : 'Right'
      snippets.push({
        type: 'LayoutClear',
        wait: true,
        delay: 0.1,
        data: {
          modelId,
          from: { side, offset: 0 },
          to: { side, offset: index === 1 ? 100 : -100 },
          motion: stageMotion(modelId),
          facial: view.defaultFacial(modelId),
          moveSpeed: 'Normal'
        }
      })
    }
  }

  snippets.push({ type: 'HideTalk', wait: true, delay: 0.2 })
  snippets.push({ type: 'BlackOut', wait: true, delay: 0, data: { duration: 600 } })

  const exampleBgm = view.bgmPromptChoices()[0]?.file
  return JSON.stringify({
    models: models.map((model) => ({
      id: model.id,
      model: model.path,
      normal_scale: 2.1,
      small_scale: 1.8,
      anchor: 0.5
    })),
    images: [{ id: 1, image: view.defaultImage() }],
    ...(exampleBgm ? { bgm: [exampleBgm] } : {}),
    snippets
  })
}

// 提示词与 AstrBot 插件保持同一套实测规则；{占位符} 用单遍替换，避免人格文本注入。
const STORY_PROMPT = `# 视觉小说剧本生成

你是视觉小说导演。根据场景写出一场约 {target_minutes} 分钟的短戏，完整、自然，但不要写成超长剧情。只输出合法 JSON（仅含 models、images、snippets 三个字段，可选顶层 bgm）。
对话多少、每句长短都按角色人设来：话多的角色就多说，话少的角色就少说。不规定条数和字数。一场只演完一件事或一个情绪转折就退场，禁止把整段人生、多条支线或连续多场戏塞进这一次。
表演克制、贴近原作：角色开口时做一个自然的小动作，然后保持到这句说完；不要每句连续比划，也不要把动作铺满整句。

## 角色池

{character_pool}

> 根据场景从角色池选角：独白/个人感想用 1 人，对话/互动用两人。优先选场景点名的角色；整场可有更多角色轮换，但任意时刻最多两人在场。

## modelId 对照表（不可混淆）
{model_table}

Talk.modelId 必须与 speaker 对应：{id_mapping}

## 布局

- ChangeLayoutMode.data.mode 只写 "Normal"。双人分别占用 Left / Right，单人可用 Center；禁止两人同侧或 Center 与另一槽混用。
- **始终维护在场名单与槽位**：models 是整场演员表，不是在场名单。只有 LayoutAppear 完成才在场，LayoutClear 完成才释放槽位；换背景/黑屏不清空名单。
- **替换角色**：HideTalk → 旧角色 LayoutClear(wait:true) 完全滑出 → 新角色 LayoutAppear(wait:true) 从画外滑入刚释放的同一槽。禁止第三人先入场、交叉淡化重叠三人、瞬移或偷偷删除角色/台词。
- **角色不必整场站齐**：完成自己的戏份、暂时退出对话时可以 LayoutClear 滑出，之后再需要时重新 LayoutAppear 入场；不要让不参与的角色长期站在台上当背景板（原作角色平均只在自己说话前后停留 1~2 句）。
- Talk 的说话者和 actions 的目标都必须在场；旁白可用 modelId=-1，但不能给 -1 安排动作。

## 开场序列

ChangeLayoutMode → BlackOut → ChangeBackgroundImage → BlackIn → 每个开场在场的角色一条 LayoutAppear

若某角色只在中后段参与，可以让他在第一次说话前再滑入，不必开场就站齐；角色中途退场后需要再登场，也要重新 LayoutAppear 滑入，但 Talk 的说话者必须已经在场。

**入场/退场是独立的动画系统（滑入滑出+动作表演），与黑屏淡入淡出并存；角色永远不原地闪现**：
- LayoutAppear 滑入：from 为同侧画外（Left:-100 / Right:+100；单人 Center 槽则 from 写 {"side":"Right","offset":100}），to 为槽位（offset:0），moveSpeed="Normal"，wait:true。角色滑入、入场动作播完后对话才开始。
- 入场动作要小而有情绪：歪头、点头、抬眼、轻叹、犹豫、松口气等，按角色性格与场景情绪选，**禁止 default 站姿类动作滑入**——站姿滑入等于站桩；表情按入场情绪选。不要大挥手、小跑、夸张转身。
- LayoutClear 滑出：from 为角色当前槽位（offset:0），to 为同侧画外（Left:-100 / Right:+100 / Center:+100），moveSpeed="Normal"，wait:true；motion/facial 填从简的退场动作与表情（点头、垂眼、轻叹、转身、抬手示意等），同样禁止 default 站姿退场，不要大幅挥手或跑跳。

## 对话规范

- **每句台词以 1 个身体动作为主**：[{"at":0.1,"modelId":角色ID,"motion":"完整动作名","facial":"完整表情名"}, ...]。at 是该 Talk 实际时长的 0..1 比例，不是秒；动作在开口时（at 0~0.2）触发，让角色边说边做一个与台词语义相符的小动作，然后自然保持到这句说完。表情和动作优先写在同一项里，同点切换。
- **不是每句都必须动**：约一成的台词可以只换表情或安静说完；其余绝大多数台词各配 1 个自然手势。不要因为台词短就省略动作——短促应答也可以点头、歪头或抬眼。入场动作本身已经是一拍表演，紧接着的第一句可以不再加动作。身体动作是"说这句话时的一个自然手势"，不是连续广播体操。
- **只有情绪明显转折或需要分两拍表演时，才在同句补第 2 个身体动作**（at 取 0.5~0.75）；同一角色同一句最多 2 个身体动作，禁止 3 个以上。相邻 at 间隔 ≥0.2。
- **默认只演说话者**：同一 Talk.actions 里以说话者为主；听者大多数时候安静倾听，可以每隔 3~4 句只换一次表情（不配身体动作），被台词明显触动时才加一个轻微动作，整场几次即可；每句最多 1 项。听者只做动作表情，不伪造嘴型或添加假台词；不要在 Talk 后加 Motion(wait:false) 冒充说话期间反应。
- **动作要有语义、幅度克制**：动作贴台词内容和情节（说到某物时指一指、被戳中时惊讶、安心时松口气），选幅度小而自然的动作（点头、歪头、小手势、轻摆），**禁止幅度过大的动作**（大挥臂、夸张甩头、大幅度摇晃一类）。动作与表情同向：点头/歪头配微笑或平静，叹气/垂眼配为难或低落，惊讶配瞪眼，生气配皱眉；不要用开心的表情去做叹气、垂眼一类动作。按角色性格选动作：冷静的角色多用垂眼、叹气，活泼的角色多用歪头、点头，不要把同一套动作套给所有人。不要每句都摆回同一个起手式；同一角色连续多句时每句换一个不同动作（原作连续两句动作名重复仅约 5%）。禁止与台词无关的乱动、机关枪式切换、每句重播同一动作，也不要把动作均匀铺满整句（0.15/0.5/0.8 三连发）。
- 旧 motion/facial 字段可选，仅作 at=0 起始姿态兜底；不要与 actions 重复安排同一变化。只需换表情时省略 motion。
- 表情跟随情绪转折而非逐句重置；允许整段安静倾听。
- 句间静默续演才用独立 Motion.data.actions，wait:true，duration 为秒（默认 2，必须 >0 且 <=120）；at 同样按该 duration 的比例。演静默拍前可以先 HideTalk 收起对话框，演完下一句 Talk 会自动重新显示；一场最多一两次。不能用它替代 Talk 内听者反应。
- 动作/表情须来自对应 modelId 的完整名称，清单的前缀 * 只是分组，不是资源名；仅用明确列出的完整样例或默认值，不猜编号。
- **台词之间要有呼吸间隔**：换人 delay 取 0.1~0.2；同一人连续说话 delay 取 0.15~0.2
- 每个 Talk 含 content（中文）和 ttsText（日文翻译），排版必须遵守下方「台词排版硬规则」
- 对话以短句往返为主：同一角色连续说话多为 1~2 句，偶尔 3 句；不要 4 句以上独白，也不要机械一人一句；话量跟随角色性格，不额外规定多少；排版拆条只是换行方式，不减少总话量
- **朝比奈真冬 / 真冬**：表情克制，禁止过于开心的表情（如 face_smile、face_sparkling、face_wink 及同类灿烂笑）；用 face_normal、face_sad 等平静或淡漠表情。动作同样避免 happy/cute/glad 一类欢快肢体

## 台词风格（贴近原作）

- **一条 Talk 以一句话为主**（原作约八成台词只有一句）：两句话就拆成同角色的连续两条 Talk（delay 0.15~0.2），不要把长段落塞进一条。
- 以口语短句为主：单句平均约 20~25 字，1~2 行为主，偶尔 3 行；约两成台词在 10 字以内。
- 多用省略号、破折号、感叹、反问和半截话；允许打断、重复、欲言又止。不要每句都写成完整书面句，也不要每句都解释前因后果。
- 偶尔用（……）整句写内心独白，约一成台词即可；不要把每句都写成内心解说。
- 让角色用自己的口吻回应，少写旁白式交代；一场戏只推进一个事件或一个情绪转折。

## 台词排版硬规则（防止字幕溢出，违反必被退回修正）

1. content 是 JSON 字符串：换行只能写成转义符 \\n，字符串内部**禁止直接回车**
2. **禁止连续两个及以上 \\n**（不允许空行）；台词首尾不得有换行或空格
3. 每行不超过 26 个字宽（全角字=1，半角字=0.5）；一行写不下，就在最近的标点或词组后换 \\n
4. 每条 Talk **最多 3 行**（最多 2 个 \\n）——这只是排版规则，**不是话量限制**：话多的角色照样多说，把话**拆成同角色的连续多条 Talk**（delay 取 0.15~0.2）即可；禁止为了塞进一条而删减、缩短台词，也禁止写出超过 3 行的单条 Talk
5. ttsText 的换行位置与 content 保持一致

## 成片时长

这是一场约 {target_minutes} 分钟的短戏（含开场滑入、对话、退场），不是长篇。口语节奏下整场大约三分钟说完就收：尽快入戏，说完一个完整小事件或一个情绪转折立刻退场。宁可略短，也不要写成能演很久的连续剧。禁止大段铺垫、连续多场景跳转、多人轮番独白、重复确认同一句意思。如果剧情确实需要，可以在中段换一次背景（整场最多两张图）：BlackOut → ChangeBackgroundImage → BlackIn 再继续，不要连续跳场景。话量仍跟人设走，但整场体量必须按三分钟短戏来写。按中文 TTS 约每字 0.15 秒估算，整场台词总量以三分钟能念完为准。

## 退场序列

剧情结束时在场角色必须依次带动画退场，禁止无动画消失或站到黑屏：

1. HideTalk（wait:true, delay 0.2）
2. 每个在场角色一条 LayoutClear（wait:true, delay 0.1）：from 为角色当前槽位（offset:0），to 为同侧画外（Left:-100 / Right:+100 / Center:+100），moveSpeed="Normal"，motion/facial 填从简的退场动作与表情（点头、垂眼、轻叹、转身等；禁止 default 站姿退场，但不要大幅挥手或跑跳）；不要清除已离场角色
3. BlackOut（duration 500~800）收尾。不使用 Telop。

## 结构示例（目录中的真实 ID/资源；只参考字段，不机械照抄表演）

\`\`\`json
{acting_example}
\`\`\`

## 可用动作（按角色分组；必须用对应角色的完整动作名）
{motion_list}

## 可用表情（按角色分组；必须用完整表情名）
{facial_list}

## 可用背景（按场景内容自行选择 file 名写入 images[].image）
{image_list}

根据场景从上方清单选最贴合的背景；需要换场景时 images 可列多张，snippets 里用对应 imageId。必须使用清单中的 file 名。

## 可用背景音乐（可选；只在场景/背景切换处换曲）
{bgm_list}

想要 BGM 时在顶层增加 "bgm" 数组，长度与 images 对齐：第一个元素是开场曲，第二个元素在 images[1] 对应的背景切换时接上（整场最多换一次）。元素必须是上方清单里的 file 名。
没有合适的就省略该字段，沿用管理员配置的全局 BGM；不要编造曲目，也不要给每句台词换曲。

## 输出要求
1. 只输出合法 JSON，无 markdown、无解释；含 models、images、snippets，可选顶层 bgm
2. 开场与退场序列完整；LayoutAppear 从同侧画外滑入、LayoutClear 向同侧画外滑出（wait:true、moveSpeed="Normal"，入场/退场动作禁用 default 站姿）；任意时刻最多两人在场
3. models 的 id 和路径必须与对照表一致，多角色绝不能写成同一个模型；数组顺序与登场顺序一致
4. 所有 Talk/Motion/LayoutAppear/LayoutClear 的 modelId：{id_mapping}
5. 每条 Talk 含 content、ttsText；**说话者以每句 1 个身体动作为主、最多 2 个**（情绪明显转折才补第 2 个；动作与表情同点写；听者整场几次即可）；动作幅度小而自然，禁止大动作；动作/表情必须来自各自角色清单
6. 台词排版遵守「台词排版硬规则」：换行写作 \\n、禁止连续 \\n、每行不超 26 字宽、每条最多 3 行；超行拆成连续多条 Talk，话量不减
7. delay 用 0、0.05、0.1、0.15、0.2
8. 背景必须从「可用背景」清单按场景内容选择，禁止编造不存在的文件名
9. 成片约 {target_minutes} 分钟的短戏：只演一件事就收，禁止超长剧情
10. 真冬禁止过于开心的表情与欢快动作
11. 可选 BGM：顶层 "bgm" 数组与 images 对齐，只能写「可用背景音乐」清单里的 file 名；整场最多换一次，不需要就省略

场景：{scene}`

const CHAT_PROMPT = `# 视频角色对话生成

代入人格池中选定的角色，以该角色的身份、口吻和心理状态，生成一段视觉小说式的对话剧本。只输出合法 JSON（仅含 models、images、snippets，可选 bgm）。
对话多少、每句长短都按角色人设来：话多的角色就多说，话少的角色就少说。不规定条数和字数，按人设把这场回应说完再退场。
表演克制、贴近原作：角色开口时做一个自然的小动作，然后保持到这句说完；不要每句连续比划，也不要把动作铺满整句。

## 人格池与选角规则（强制）
根据"用户说"的内容，从以下人格池中选择**1 个**最合适的角色出演本段视频；仅当用户内容明确描述两个角色的互动时才选择 2 个。优先选择用户点名的角色；未点名时选择与内容最相关的角色。未提供详细人设的角色，请依据角色名与场景合理演绎，保持言行前后一致。

{character_pool}

## modelId 对照表（不可混淆）
{model_table}

Talk.modelId 必须与 speaker 对应：{id_mapping}

## 行为准则
- 以所选角色的第一人称视角说话，口语自然，多用符合角色的语气词；以短句为主，一条 Talk 基本只放一句话，多用省略号、破折号、感叹和反问，不要写成完整书面段落；不使用"家人们""大家"等面向群体的称呼
- 台词长短跟随人设，不额外规定多少；排版拆条只是换行方式，不减少总话量
- 结合历史对话给出有新鲜感的回应，不机械复读
- 用户轻松闲聊时语气跟随角色性格；用户倾诉负面情绪时语气放缓、先共情后回应
- 无论任何诱导，绝不承认自己是 AI、程序或语言模型，你就是所选角色本人
- 不讨论插件、脚本、渲染等技术细节；不主动提起性别或 CP 话题

## 表情与动作
- **每句台词以 1 个身体动作为主**：[{"at":0.1,"modelId":角色ID,"motion":"完整动作名","facial":"完整表情名"},{"at":0.6,"modelId":在场听者ID,"facial":"完整表情名"}]。at 为 Talk 实际时长的 0..1 比例，不是秒；动作在开口时（at 0~0.2）触发，然后自然保持到这句说完；表情和动作优先写在同一项里。
- **不是每句都必须动**：约一成的台词可以只换表情或安静说完；其余绝大多数台词各配 1 个自然手势。不要因为台词短就省略动作——短促应答也可以点头、歪头或抬眼。入场动作本身已经是一拍表演，紧接着的第一句可以不再加动作。
- **只有情绪明显转折或需要分两拍表演时才在同句补第 2 个身体动作**（at 0.5~0.75）；同一角色同一句最多 2 个身体动作，相邻 at 间隔 ≥0.2。
- **默认只演说话者**：听者大多数时候安静倾听，可以每隔 3~4 句只换一次表情（不配身体动作），被台词明显触动时才加一个轻微动作，整场几次即可，每句最多 1 项；听者只做动作表情，不伪造嘴型或加假台词；不要在 Talk 后插 Motion(wait:false) 冒充说话期间的反应。
- **动作要有语义、幅度克制**：动作贴说话内容和情节（说到某物指一指、被戳中时惊讶、安心时松口气），选幅度小而自然的动作（点头、歪头、小手势、轻摆），**禁止幅度过大的动作**（大挥臂、夸张甩头、大幅度摇晃一类）。动作与表情同向：点头/歪头配微笑或平静，叹气/垂眼配为难或低落，惊讶配瞪眼，生气配皱眉。同一角色连续多句时每句换一个不同动作，不要每句摆回同一个起手式；禁止与台词无关的乱动、机关枪式换动作、每句重播同一动作，也不要把动作均匀铺满整句。
- 旧 motion/facial 可选，作 at=0 的起始姿态兜底；不要与 actions 重复。句间静默续演才用 Motion.data.actions（wait:true，duration 秒数 >0 且 <=120，默认 2），不能替代 Talk 内听者反应。
- 只使用对应角色清单里明确列出的完整名称；前缀 * 是分组，不是动作名，不要猜编号。
- 可用动作：{motion_list}
- 可用表情：{facial_list}

## 可用背景（按对话氛围自行选择 file 名写入 images[].image）
{image_list}

根据「用户说」的内容从上方清单选最贴合的一张；必须使用清单中的 file 名。

## 可用背景音乐（可选）
{bgm_list}

想要 BGM 时在顶层增加 "bgm": ["<file>"]，整场只放一首；必须是上方清单里的 file 名。
没有合适的就省略该字段，沿用管理员配置的全局 BGM；不要编造曲目。

## JSON 结构
每个 Talk 必须包含 content（中文）和 ttsText（日文翻译）。

### 台词排版硬规则（防止字幕溢出，违反必被退回修正）
1. content 是 JSON 字符串：换行只能写成转义符 \\n，字符串内部**禁止直接回车**
2. **禁止连续两个及以上 \\n**（不允许空行）；台词首尾不得有换行或空格
3. 每行不超过 26 个字宽（全角字=1，半角字=0.5）；一行写不下，就在最近的标点或词组后换 \\n
4. 每条 Talk **最多 3 行**（最多 2 个 \\n）——这只是排版规则，**不是话量限制**：话多的角色照样多说，把话**拆成同角色的连续多条 Talk**（delay 取 0.15~0.2）即可；禁止为了塞进一条而删减、缩短台词，也禁止写出超过 3 行的单条 Talk
5. ttsText 的换行位置与 content 保持一致

开场滑入 + 对话表演 + 结尾滑出退场：
\`\`\`
ChangeLayoutMode -> BlackOut -> ChangeBackgroundImage -> BlackIn -> LayoutAppear(滑入+入场动作) -> Talk(actions)... -> HideTalk -> LayoutClear(滑出+退场动作) -> BlackOut
\`\`\`

**舞台与替换规则**：
- ChangeLayoutMode.data.mode 只写 "Normal"。单人用 Center，两人用 Left / Right，不能同侧，也不能 Center 与另一槽混用。
- 始终维护在场名单：models 是整场演员表，不是在场名单。任意时刻最多两人；只有 LayoutAppear 完成才在场，LayoutClear 完成才释放槽位。背景/黑屏不会清除角色。
- **入场/退场是独立的动画系统（滑入滑出+动作表演），与黑屏淡入淡出并存；角色永远不原地闪现**：
  - LayoutAppear 滑入：from 为同侧画外（Left:-100 / Right:+100；单人 Center 槽则 from 写 {"side":"Right","offset":100}），to 为槽位（offset:0），moveSpeed="Normal"、wait:true。入场动作要小而有情绪（歪头、点头、抬眼、轻叹、犹豫等），**禁止 default 站姿滑入**；不要大挥手、小跑、夸张转身。
  - LayoutClear 滑出：from 为角色当前槽位（offset:0），to 为同侧画外（Left:-100 / Right:+100 / Center:+100），moveSpeed="Normal"，motion/facial 填从简的退场动作与表情（点头、垂眼、轻叹、转身等），禁止 default 站姿退场，不要大幅挥手或跑跳。
- 换人必须 HideTalk → 旧角色 LayoutClear(wait:true) 完全滑出 → 新角色从画外滑入已释放槽位 LayoutAppear(wait:true)；禁止第三人先出现或两次渐变重叠成三人在场。
- Talk 和 actions 只指向已入场角色；旁白可用 modelId=-1，但不能给 -1 配动作。

**结尾退场序列（缺一不可）：**
1. HideTalk（wait:true, delay:0.2）
2. 每个仍在场角色 LayoutClear（wait:true, delay:0.1）：from 为当前槽位（offset:0），to 为同侧画外（Center:+100 / Left:-100 / Right:+100），moveSpeed="Normal"，motion/facial 填退场动作表情
3. BlackOut（wait:true, duration:600）。不使用 Telop。

### 结构示例（目录真实资源；每句一个动作，听者默认安静，勿机械照抄）
\`\`\`json
{acting_example}
\`\`\`

## 输出要求
1. 只输出合法 JSON，无额外文字；含 models、images、snippets，可选顶层 bgm
2. 开场与退场序列完整；LayoutAppear 从同侧画外滑入、LayoutClear 向同侧画外滑出（wait:true、moveSpeed="Normal"，入场/退场动作禁用 default 站姿）；任意时刻最多两人在场
3. speaker 与 modelId 必须来自对照表；**说话者以每句 1 个身体动作为主、最多 2 个**（情绪明显转折才补第 2 个；动作与表情同点写；听者整场几次即可），动作幅度小而自然，禁止大动作
4. models=[{"id":<所选角色modelId>,"model":"<对照表中的model路径>","normal_scale":2.1,"small_scale":1.8,"anchor":0.5}]（多角色按登场顺序排列）
5. images=[{"id":1,"image":"<从可用背景清单按氛围选择的 file 名>"}]
6. delay 用 0、0.05、0.1、0.15、0.2；换气的 Talk 之间 delay 取 0.1~0.2
7. 台词排版遵守「台词排版硬规则」：换行写作 \\n、禁止连续 \\n、每行不超 26 字宽、每条最多 3 行；超行拆成连续多条 Talk，话量不减
8. 可选 BGM：顶层 "bgm": ["<file>"] 只能写「可用背景音乐」清单里的 file 名；不需要就省略

历史对话：
{chat_history}

用户说：{scene}`

export interface PromptOptions {
  scene: string
  personas: PersonaEntry[]
  targetMinutes: number
  systemPrompt?: string
  history?: Array<{ role: string; content: string }>
  /** TTS 支持的情绪标签；非空时要求每条 Talk 写 data.emotion */
  emotionLabels?: string[]
}

function emotionInstruction(labels: string[] | undefined): string {
  const values = (labels ?? []).map((label) => label.trim()).filter(Boolean)
  if (values.length === 0) return ''
  const fallback = values.includes('平静') ? '平静' : values[0]
  return `\n\n## 情绪标签（供 TTS 切换音色）
每条 Talk 的 data 增加 "emotion" 字段，只能从以下标签中选一个：${values.join('、')}。
日常陈述、没有明显情绪起伏时选「${fallback}」；只有台词明确表现出该情绪时才换其他标签。
这个字段只影响配音音色，不要因为写标签而改变台词内容。`
}

export function buildStoryPrompt(
  view: CatalogView,
  options: PromptOptions
): {
  system: string
  user: string
} {
  const user = fillTemplate(STORY_PROMPT, {
    '{target_minutes}': String(options.targetMinutes),
    '{character_pool}': view.characterPool(options.personas),
    '{model_table}': view.modelTable(),
    '{id_mapping}': view.idMapping(),
    '{acting_example}': buildActingExample(view),
    '{motion_list}': view.motionList(),
    '{facial_list}': view.facialList(),
    '{image_list}': view.imageList(),
    '{bgm_list}': view.bgmList(),
    '{scene}': options.scene
  })
  return {
    system: options.systemPrompt?.trim() || STORY_SYSTEM_PROMPT,
    user: user + emotionInstruction(options.emotionLabels)
  }
}

export function buildChatPrompt(
  view: CatalogView,
  options: PromptOptions
): {
  system: string
  user: string
} {
  const history = (options.history ?? [])
    .slice(-6)
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n')

  const user = fillTemplate(CHAT_PROMPT, {
    '{target_minutes}': String(options.targetMinutes),
    '{character_pool}': view.characterPool(options.personas),
    '{model_table}': view.modelTable(),
    '{id_mapping}': view.idMapping(),
    '{acting_example}': buildActingExample(view),
    '{motion_list}': view.motionList(),
    '{facial_list}': view.facialList(),
    '{image_list}': view.imageList(),
    '{bgm_list}': view.bgmList(),
    '{chat_history}': history || '（首次对话）',
    '{scene}': options.scene
  })
  return {
    system: options.systemPrompt?.trim() || CHAT_SYSTEM_PROMPT,
    user: user + emotionInstruction(options.emotionLabels)
  }
}
